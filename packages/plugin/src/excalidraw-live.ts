import type * as Y from 'yjs';
import { guardRunaway, RunawayLoop } from './runaway-guard';
import type { Awareness } from 'y-protocols/awareness';
import type { BindResult, BoundView, StructuredSync } from './structured-sync';
import { excalidrawCodec } from './excalidraw-codec';
import {
  ROOT_APP_STATE, applyExcalidraw, isAnotherDrawing, observeExcalidraw, readExcalidraw, revisionsById, type ExcalidrawValue,
} from './excalidraw-model';
import { stripInternal, winnerOf } from './excalidraw-merge';
import { EXCALIDRAW_READ_AGAINST, type SceneElement } from './excalidraw-format';
import { canonical } from './structured-records';
import { log } from './logger';

/**
 * A drawing open in the Excalidraw plugin's view, bound live to its document
 * (NEC-41, SAFE-A29) — what canvas-live.ts is for a canvas.
 *
 * Over disk, a stroke reaches the other vault when the view saves it — on its
 * own schedule — and then only when the plugin there reloads the file. Bound,
 * each change goes into the document as it is made, through the view's own
 * API, and each remote change is drawn into the open view the moment it
 * arrives, through the same API, without reloading anything.
 *
 * **What is relied on.** `view.excalidrawAPI` — the view's live Excalidraw
 * instance, public on the plugin's view — for `getSceneElementsIncludingDeleted`,
 * `getAppState`, `onChange` and `updateScene`; and the plugin's bundled
 * Excalidraw library, `window.ExcalidrawLib`, for `CaptureUpdateAction.NEVER`
 * and, when it is there, `reconcileElements`. All of it is checked before
 * binding (`checkExcalidrawShape`), against Excalidraw for Obsidian
 * `EXCALIDRAW_READ_AGAINST`, and by the e2e contract test against the release
 * the suite pins. A missing piece, or any hook that throws, lets go: the file
 * goes back to the disk path, with a notice.
 *
 * **Who writes the file.** While bound, only the view. StructuredSync writes
 * nothing under it (SAFE-A19), so the plugin's own reload-and-merge never sees
 * a write of ours; a remote change drawn into the view makes it unsaved, and
 * the plugin saves it with everything else. A save comes back to StructuredSync,
 * which hands it to the binding (`readInSave`): its elements by version against
 * the document, so an echo writes nothing and anything a hook missed is carried
 * in; its other parts against the document's own.
 *
 * **What is never undone by undo.** A remote change is drawn with
 * `captureUpdate: NEVER`, so it never enters this user's undo history —
 * Excalidraw's own collaboration does the same — and undo cannot revert a
 * collaborator.
 *
 * **What waits.** An element someone is typing in, resizing, drawing or
 * dragging here is not redrawn under them: `reconcileElements` keeps the local
 * one while it is being edited, and so does the fallback below. The remote
 * version stays in the document and is drawn once the edit ends (SAFE-A26).
 */

/** How long a burst of local changes is gathered before it is written in. */
const CAPTURE_MS = 100;
/** How long after drawing a remote change the view is asked to save. */
const SAVE_AFTER_DRAW_MS = 2000;
const ORIGIN = { name: 'excalidraw-live' };
/**
 * Roots a remote change may touch and stay live: the elements (drawn), the
 * shared settings (drawn too), and the document's own bookkeeping — its stamp,
 * and the record of older clients' versions kept (structured-sync.ts) — and
 * `files`, which nothing reads any more (excalidraw-model.ts).
 * Anything else — the note above the drawing, embedded files — lets go.
 */
const DRAWABLE_ROOTS = new Set([ROOT_APP_STATE, 'meta', 'textKept', 'files']);

export interface ExcalidrawApiLike {
  getSceneElementsIncludingDeleted(): readonly SceneElement[];
  getAppState(): Record<string, unknown>;
  onChange(cb: (elements: readonly SceneElement[], appState: Record<string, unknown>, files: Record<string, unknown>) => void): () => void;
  updateScene(scene: { elements?: readonly SceneElement[]; appState?: Record<string, unknown>; captureUpdate?: unknown; collaborators?: Map<string, unknown> }): void;
  /**
   * The images Excalidraw has loaded, by file id. Read only to see whether an
   * image drawn in has its picture loaded — never synced, never compared: they
   * are the image's bytes (see shownValue).
   */
  getFiles?(): Record<string, unknown>;
  addFiles?(files: unknown[]): void;
}

export interface ExcalidrawViewLike {
  file: { path: string } | null;
  excalidrawAPI: ExcalidrawApiLike | null;
  save(suppressReload?: boolean, force?: boolean): Promise<void>;
  isDirty?(): boolean;
  /** The plugin's own record of an edit in progress (`semaphores.isEditingText`). */
  semaphores?: { isEditingText?: boolean } | null;
  getViewType?(): string;
}

export interface ExcalidrawLib {
  CaptureUpdateAction?: { NEVER?: unknown };
  reconcileElements?: (local: readonly SceneElement[], remote: readonly SceneElement[], appState: Record<string, unknown>) => SceneElement[];
}

export interface ExcalidrawLiveDeps {
  structured: Pick<StructuredSync, 'acquireDoc' | 'releaseDoc' | 'bindView' | 'unbindView' | 'docNameFor' | 'agreedText' | 'writePending'>;
  readFile(path: string): Promise<string | null>;
  /** The plugin's bundled Excalidraw library, or null. */
  lib(): ExcalidrawLib | null;
  /** A binding gave up and left its drawing on the disk path. */
  fellBack(path: string, reason: string): void;
  /** The Excalidraw plugin's version, logged when it is not the one read against. */
  pluginVersion?: string;
  /** What open drawings deleted (DeleteWitness), for deletes the scene has since dropped. */
  witness?: DeleteWitness;
}

/** What is missing for a live binding, or null. */
export function checkExcalidrawShape(view: ExcalidrawViewLike, lib: ExcalidrawLib | null): string | null {
  const api = view.excalidrawAPI;
  if (!api) return 'its drawing API (view.excalidrawAPI)';
  for (const m of ['getSceneElementsIncludingDeleted', 'getAppState', 'onChange', 'updateScene'] as const) {
    if (typeof api[m] !== 'function') return `excalidrawAPI.${m}`;
  }
  if (typeof view.save !== 'function') return 'view.save';
  if (!lib?.CaptureUpdateAction || lib.CaptureUpdateAction.NEVER === undefined) return 'ExcalidrawLib.CaptureUpdateAction.NEVER';
  return null;
}

const key = (e: SceneElement): string => `${e.version}\u0000${e.versionNonce}`;

export class ExcalidrawLiveBinding implements BoundView {
  private docName: string | null = null;
  private ydoc: Y.Doc | null = null;
  awareness: Awareness | null = null;
  /**
   * What the view stands on besides its elements: the note above, the
   * settings, the embedded files, this vault's layout — for writing the view
   * out as a file. Not a memory of elements: those are compared with the
   * document each time, by version, and nothing else (see capture).
   */
  private around: ExcalidrawValue | null = null;
  /**
   * Per element, the document's version the view was last known to hold —
   * at attach, as drawn, as carried in — by version and nonce. The only base
   * a newer version in the view can truthfully claim: a version records what
   * it was made on, and the version it names is then removed as superseded,
   * outright. Guessed as the document's current winner, an edit the view
   * never showed — held back while someone typed, say — was named, and
   * removed with no copy kept (found in review, and reproduced). Not a
   * record of what the view shows (that is read from the view each time,
   * by version); only of what the document had that the view had too.
   */
  private seen = new Map<string, { version: number; versionNonce: number }>();
  private bound = false;
  private unobserve: (() => void) | null = null;
  private unChange: (() => void) | null = null;
  private captureTimer: number | null = null;
  /** Remote changes not yet drawn, because an element was being edited. */
  private deferred = false;
  private drawing = false;

  constructor(readonly view: ExcalidrawViewLike, readonly path: string, private deps: ExcalidrawLiveDeps) {}

  isBound(): boolean {
    return this.bound;
  }

  private detachListeners = new Set<() => void>();

  /** Called once, when the binding lets go — for presence to stop with it. */
  onDetach(cb: () => void): () => void {
    this.detachListeners.add(cb);
    return () => this.detachListeners.delete(cb);
  }

  boundDocName(): string | null {
    return this.docName;
  }

  doc(): Y.Doc | null {
    return this.ydoc;
  }

  api(): ExcalidrawApiLike | null {
    return this.view.excalidrawAPI;
  }

  /**
   * Take the view over, if it shows this file and the document is ready.
   * Anything short of `bound` leaves the file on the disk path.
   */
  async attach(): Promise<BindResult | 'not-owned' | 'broken'> {
    const lib = this.deps.lib();
    const missing = checkExcalidrawShape(this.view, lib);
    if (missing) {
      // A drawing still loading has no API yet: not broken, not yet.
      if (!this.view.excalidrawAPI) {
        this.refused('not-ready', { api: 'none yet' });
        return 'not-ready';
      }
      this.deps.fellBack(this.path, `Excalidraw no longer has ${missing}`);
      return 'broken';
    }
    if (this.view.file?.path !== this.path) return 'not-owned';
    const docName = this.deps.structured.docNameFor(this.path);
    if (!docName) return 'unknown';

    const held = this.deps.structured.acquireDoc(docName);
    if (!held) return 'unknown';
    // A tab reused for another drawing takes the new path before its scene
    // loads (see isAnotherDrawing). Neither bound nor saved then: saved, it
    // would write the old drawing into this one's file.
    if (isAnotherDrawing(this.view.excalidrawAPI?.getSceneElementsIncludingDeleted() ?? [], held.ydoc)) {
      this.deps.structured.releaseDoc(docName);
      this.refused('not-ready', { scene: 'another drawing' });
      return 'not-ready';
    }
    // An edit waiting for the view's save is written out first, so file and
    // view agree before either is compared.
    if (this.view.isDirty?.()) {
      log.debug('Saving an open drawing before binding it', { path: this.path });
      await this.view.save(true, false);
    }
    if (this.view.file?.path !== this.path) {
      this.deps.structured.releaseDoc(docName);
      return 'not-owned';
    }
    const diskText = await this.deps.readFile(this.path);
    const parsed = diskText ? excalidrawCodec.parse(diskText) : null;
    if (!parsed?.ok) {
      this.deps.structured.releaseDoc(docName);
      this.refused('not-ready', { disk: parsed ? parsed.error : 'no file' });
      return 'not-ready';
    }
    const disk = parsed.value as ExcalidrawValue;
    const docValue = readExcalidraw(held.ydoc);
    // Bound by version, not by equality. The view need not equal its file or
    // the document: the binding reconciles it element by element, as
    // Excalidraw's own collaboration does on joining. What the view has that
    // the document does not — a newer version, a new element — is carried in;
    // what the document has that is newer is drawn; a version older than the
    // document's is refused, never applied (SAFE-A27); an element missing
    // from the view is never removed for it. Requiring equality failed again
    // and again on what the view holds for its own reasons — defaults filled
    // in on load, tombstones dropped, an element type an older release does
    // not know — leaving drawings unbound.
    if (this.view.file?.path !== this.path) {
      this.deps.structured.releaseDoc(docName);
      return 'not-owned';
    }
    // What equality also guarded against: a view showing another drawing.
    // The path does not cover it. A tab reused for another file takes the new
    // path before its scene loads, and a binding made in that moment carried
    // the old drawing's every shape into the new one's document, for every
    // vault (found by the hardness run, round 41). Checked before the save
    // above too; and here, after it, the scene must hold no live element this
    // drawing's file and document both lack — the scene may have changed
    // while the save and the read were awaited.
    const known = new Set<string>([...disk.elements.map((e) => e.id), ...revisionsById(held.ydoc).keys()]);
    const strangers = (this.view.excalidrawAPI?.getSceneElementsIncludingDeleted() ?? [])
      .filter((e) => e.isDeleted !== true && !known.has(e.id));
    if (strangers.length > 0) {
      this.deps.structured.releaseDoc(docName);
      this.refused('not-ready', { strangers: strangers.length, first: strangers.slice(0, 3).map((e) => e.id) });
      return 'not-ready';
    }
    // The file still lacks a change the view cannot draw (the note above, an
    // image's link, a setting) and its write is on the way: a let-go is
    // waiting for that write, and binding now would cancel it, so the change
    // would reach the file only once the drawing closed. Wait for it. Only
    // while it is pending: something that never lands must not keep the
    // drawing unbound for good.
    const rest = (v: ExcalidrawValue): ExcalidrawValue => ({ ...v, elements: [] });
    if (!excalidrawCodec.equal(rest(disk), rest(docValue)) && this.deps.structured.writePending(docName)) {
      this.deps.structured.releaseDoc(docName);
      this.refused('not-ready', { waiting: 'the file to be written with a change the view cannot draw' });
      return 'not-ready';
    }
    // Handed over as the document's own value, so binding writes nothing:
    // the first capture carries in what the view adds, against the document.
    const result = this.deps.structured.bindView(docName, this, docValue);
    if (result !== 'bound') {
      this.deps.structured.releaseDoc(docName);
      this.refused(result, {});
      return result;
    }
    this.docName = docName;
    this.ydoc = held.ydoc;
    this.awareness = held.awareness;
    this.around = { ...disk, elements: [] };
    this.seen.clear();
    {
      const revs = revisionsById(held.ydoc);
      for (const e of this.view.excalidrawAPI?.getSceneElementsIncludingDeleted() ?? []) {
        if (revs.get(e.id)?.some((r) => r.rev.version === e.version && r.rev.versionNonce === e.versionNonce)) this.see(e);
      }
    }
    this.bound = true;
    if (this.deps.pluginVersion && this.deps.pluginVersion !== EXCALIDRAW_READ_AGAINST) {
      log.info('A live drawing is running on an Excalidraw plugin its internals were not read against', {
        running: this.deps.pluginVersion, readAgainst: EXCALIDRAW_READ_AGAINST,
      });
    }
    try {
      const api = this.view.excalidrawAPI!;
      this.unChange = api.onChange(() => this.safely(() => this.scheduleCapture()));
      this.unobserve = observeExcalidraw(held.ydoc, (change, tr) => {
        if (tr.origin === ORIGIN) return;
        // Settings, the note above the drawing, embedded files: not drawable
        // through the API. Let go, so the file is written and the plugin
        // merges it in; the manager binds again once it has. Even when the
        // same change moved elements too — an image added is both an element
        // and its file — or the view's next save, built from what it holds,
        // would write the file without the rest and record that as agreed.
        const outside = [...change.names].filter((n) => !DRAWABLE_ROOTS.has(n));
        if (outside.length > 0) {
          this.safely(() => this.letGoFor(`a change outside the drawing (${change.roots.join(' ')})`));
          return;
        }
        if (change.names.has(ROOT_APP_STATE)) this.safely(() => this.drawSettings());
        if (change.ids.size > 0) this.safely(() => this.draw());
      });
      // The document may hold what the view has not got; the view may hold
      // what the document has not.
      this.draw();
      this.scheduleCapture();
    } catch (err) {
      this.fail(err);
      return 'broken';
    }
    log.debug('Bound an open drawing live', { path: this.path });
    return 'bound';
  }

  /** Let go: the view goes back to a file StructuredSync writes too. */
  detach(): void {
    if (!this.bound) return;
    this.bound = false;
    if (this.captureTimer !== null) window.clearTimeout(this.captureTimer);
    this.captureTimer = null;
    if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
    this.saveTimer = null;
    try {
      // What the view holds that has not been carried in yet is carried now,
      // unless it now shows another file: then nothing it holds is ours.
      if (this.view.file?.path === this.path) this.capture();
    } catch (err) {
      log.warn('Could not carry a drawing\'s last edits in on letting go', { path: this.path, error: String(err) });
    }
    this.unobserve?.();
    this.unobserve = null;
    try {
      this.unChange?.();
    } catch {
      // The view is going; nothing to unhook from.
    }
    this.unChange = null;
    for (const cb of [...this.detachListeners]) {
      try {
        cb();
      } catch (err) {
        log.warn('A drawing\'s detach listener failed', { path: this.path, error: String(err) });
      }
    }
    this.detachListeners.clear();
    if (this.docName) this.deps.structured.releaseDoc(this.docName, this);
  }

  // ── BoundView ────────────────────────────────────────────────────────────

  // `readInSave` takes a save's part instead: these are for a binding that
  // keeps a history of what its view held, which this one does not.
  holds(): boolean {
    return false;
  }

  baseFor(): unknown {
    return null;
  }

  /**
   * A save of the view, which this binding alone reads in while bound: its
   * elements by the same rule as capture, against the document, never against
   * a guess at what the view held when it saved; its other parts (the note,
   * embedded files, settings) against the document's own. While bound only
   * this view changes those — any remote change to them lets the binding go
   * — so the save's are this view's edits. One writer for the drawing.
   */
  readInSave(value: unknown): void {
    if (!this.ydoc || !this.bound) return;
    const saved = value as ExcalidrawValue;
    const doc = readExcalidraw(this.ydoc);
    const { changed, bases } = this.newerThanDocument(this.withRecordedDeletes(saved.elements));
    this.ydoc.transact(() => {
      applyExcalidraw(this.ydoc!, { ...saved, elements: changed }, { ...doc, elements: bases });
    }, ORIGIN);
    for (const e of changed) this.see(e);
    this.around = { ...saved, elements: [] };
    if (changed.length > 0) {
      log.info('An open drawing saved elements its live binding had not carried in; read them in', {
        path: this.path, count: changed.length,
      });
    }
  }

  shownText(): string | null {
    if (!this.bound || !this.around || !this.view.excalidrawAPI) return null;
    return excalidrawCodec.serialise(this.shownValue(this.around));
  }

  // ── Both ways ────────────────────────────────────────────────────────────

  /**
   * What the view shows, as a drawing: its elements, and the rest from
   * `around`. Never the API's files: those are the images the plugin loaded
   * from the vault, as binary data, for drawing — the file keeps an image as
   * a link under "## Embedded Files" and the attachment syncs as itself.
   * Taken from the API, every image went into the shared document as a copy
   * of its bytes, and an open drawing with an image never equalled its file
   * again, so it was never bound again (found in the user's vaults).
   */
  private shownValue(around: ExcalidrawValue): ExcalidrawValue {
    const api = this.view.excalidrawAPI!;
    const elements = api.getSceneElementsIncludingDeleted().map((e) => ({ ...e }));
    return { ...around, elements };
  }

  /** The document's standing version of each element. */
  private winners(): Map<string, SceneElement> {
    const out = new Map<string, SceneElement>();
    if (!this.ydoc) return out;
    for (const [id, list] of revisionsById(this.ydoc)) out.set(id, stripInternal(winnerOf(list.map((r) => r.rev))));
    return out;
  }

  /**
   * Of `elements`, those the document does not have at this version, with the
   * document's version each was made on: new elements (no base), newer
   * versions, and rivals of the same number with another nonce (for settle).
   * An older one is left out; drawing brings the view up to it. Version
   * alone, by Excalidraw's own rule: no record of what the view held is kept,
   * so none can drift from it.
   */
  private see(e: SceneElement): void {
    this.seen.set(e.id, { version: e.version, versionNonce: e.versionNonce });
  }

  /**
   * What a newer version of `id` in the view was made on: the version the
   * view last held, while the document still has it. Otherwise nothing — the
   * cost of which is at most a kept copy of what it may have replaced (its
   * author settles it), never a removal.
   */
  private baseOf(id: string, list: ReadonlyArray<{ rev: SceneElement }>): SceneElement | null {
    const s = this.seen.get(id);
    if (!s) return null;
    const r = list.find((x) => x.rev.version === s.version && x.rev.versionNonce === s.versionNonce);
    return r ? stripInternal(r.rev) : null;
  }

  private newerThanDocument(elements: readonly SceneElement[]): { changed: SceneElement[]; bases: SceneElement[] } {
    const revs = this.ydoc ? revisionsById(this.ydoc) : new Map<string, Array<{ rev: SceneElement }>>();
    const changed: SceneElement[] = [];
    const bases: SceneElement[] = [];
    for (const e of elements) {
      const list = revs.get(e.id);
      const w = list ? stripInternal(winnerOf(list.map((r) => r.rev))) : undefined;
      if (!list || !w) {
        if (e.isDeleted !== true) changed.push({ ...e });
        continue;
      }
      if (e.version > w.version) {
        changed.push({ ...e });
        const base = this.baseOf(e.id, list);
        if (base) bases.push(base);
      } else if (e.version === w.version && e.versionNonce !== w.versionNonce) {
        // A rival: made on what the winner was made on, not on the winner. So
        // no base. Recorded as built on the winner, a rival that went on to win
        // marked the other as superseded, and settle removed it with no copy
        // kept — a lost edit, found by the hardness run (seed 2, round 4).
        changed.push({ ...e });
      }
    }
    return { changed, bases };
  }

  /**
   * `elements`, with the deletes recorded for this drawing that they no longer
   * hold. A delete is in the scene only until the scene is rebuilt — adding
   * an element through ExcalidrawAutomate rebuilds it from the live ones — and
   * in no save at all; a rebuild inside the capture's 100 ms lost it (found by
   * the hardness run). Versions decide the rest, as for any element.
   */
  private withRecordedDeletes(elements: readonly SceneElement[]): readonly SceneElement[] {
    const witness = this.deps.witness;
    const extra = witness?.deletedBesides(this.path, new Set(elements.map((e) => e.id))) ?? [];
    if (extra.length === 0 || !this.ydoc) return elements;
    // Only a delete newer than every version the document has. One the
    // document has reached — delivered, or lost to an edit and converged by
    // settle — has said what it had to say, and is forgotten. Offered again,
    // a lost one was written back, settle converged it again, and each
    // transaction queued the other, as microtasks that never yielded: the
    // renderer froze (the hardness run, seed 4, found with a debugger).
    const revs = revisionsById(this.ydoc);
    const newer: SceneElement[] = [];
    for (const e of extra) {
      const list = revs.get(e.id);
      if (list && e.version > winnerOf(list.map((r) => r.rev)).version) newer.push(e);
      else witness?.forget(this.path, e.id);
    }
    return newer.length === 0 ? elements : [...elements, ...newer];
  }

  private scheduleCapture(): void {
    if (this.drawing || this.captureTimer !== null) return;
    this.captureTimer = window.setTimeout(() => {
      this.captureTimer = null;
      this.safely(() => this.capture());
    }, CAPTURE_MS);
  }

  /** Carry what the view has that the document has not into it, then draw what it lacks. */
  private capture(): void {
    if (!this.carryIn() && !this.deferred) return;
    // What this vault wrote may already have lost to a version that arrived
    // first; and an edit that ended may have held remote changes back.
    this.draw();
  }

  /**
   * Carry what the view has that the document has not into it, by version.
   * Whether anything was. Before every draw too (see draw): a draw replaces
   * what it reconciles, and a version only the view held went with it.
   */
  private carryIn(): boolean {
    guardRunaway('a live drawing carrying its view in', { path: this.path });
    const api = this.view.excalidrawAPI;
    if (!this.ydoc || !this.around || !api) return false;
    if (this.switchedAway()) return false;
    const { changed, bases } = this.newerThanDocument(this.withRecordedDeletes(api.getSceneElementsIncludingDeleted()));
    if (changed.length === 0) return false;
    const around = this.around;
    this.ydoc.transact(() => {
      applyExcalidraw(this.ydoc!, { ...around, elements: changed }, { ...around, elements: bases });
    }, ORIGIN);
    for (const e of changed) this.see(e);
    const deletes = changed.filter((e) => e.isDeleted === true);
    if (deletes.length > 0) log.debug('Carried deletes in from a live drawing', { path: this.path, ids: deletes.slice(0, 5).map((e) => `${e.id}@${e.version}`) });
    return true;
  }

  /** Draw what the document holds that the view does not. */
  private draw(): void {
    guardRunaway('a live drawing drawing the document', { path: this.path });
    const api = this.view.excalidrawAPI;
    if (!this.ydoc || !this.around || !api) return;
    if (this.switchedAway()) return;
    // First carry in what only the view holds: an edit inside the capture's
    // 100 ms, or one made before binding. Drawn over by a rival with the lower
    // nonce, it was replaced in the view before anything carried it in, and
    // no copy was ever kept (the hardness run, seed 2, round 4 — the conflict
    // edit a vault brought back from offline, drawn over as it bound).
    // Carried in, it is a version like any other, and settle keeps it.
    this.carryIn();
    const lib = this.deps.lib();
    // Against what the view shows now, not what it was held to show: a view
    // behind the document (one bound by version) is drawn up to date, and an
    // element it has that is newer is kept by reconcile below and carried in.
    const viewKeys = new Map(api.getSceneElementsIncludingDeleted().map((e) => [e.id, key(e)]));
    const remote: SceneElement[] = [];
    for (const [id, list] of revisionsById(this.ydoc)) {
      const w = stripInternal(winnerOf(list.map((r) => r.rev)));
      if (viewKeys.get(id) === key(w)) continue;
      // A deleted element the view does not hold needs no drawing.
      if (w.isDeleted === true && !viewKeys.has(id)) continue;
      remote.push(w);
    }
    if (remote.length === 0) {
      this.deferred = false;
      return;
    }
    const appState = api.getAppState();
    const local = api.getSceneElementsIncludingDeleted();
    let next: SceneElement[];
    if (lib?.reconcileElements) {
      // Excalidraw's own reconcile: the same rule as ours (SAFE-A27), and it
      // keeps an element being edited here as it is.
      next = lib.reconcileElements(local, remote.map((e) => ({ ...e })), appState);
    } else {
      const editing = editingIds(appState);
      const byId = new Map(local.map((e) => [e.id, e]));
      for (const r of remote) if (!editing.has(r.id)) byId.set(r.id, r);
      next = [...byId.values()];
    }
    const nextById = new Map(next.map((e) => [e.id, e]));
    const drawn = remote.filter((r) => key(nextById.get(r.id) ?? r) === key(r));
    for (const e of drawn) this.see(e);
    this.deferred = drawn.length < remote.length;
    if (drawn.length === 0) {
      // Kept back because the view's own version is newer — an edit here not
      // yet carried in — rather than because of an edit in progress: carry it.
      if (this.deferred) this.scheduleCapture();
      return;
    }
    this.drawing = true;
    try {
      api.updateScene({ elements: next, captureUpdate: lib?.CaptureUpdateAction?.NEVER });
    } finally {
      this.drawing = false;
    }
    // Excalidraw may change an element itself while drawing (a container's
    // text laid out again, an arrow re-routed), with capture off. Such a
    // change is newer than the document, so the next capture carries it in
    // like any edit here; once a view ran a version ahead of every copy for
    // want of that (an intermittent e2e failure, three runs in four).
    this.scheduleCapture();
    if (this.deferred) {
      // Which elements, and what in the app state says they are being edited:
      // a hold that never ends leaves this view behind its file for good.
      log.debug('Held a remote change to an element being edited here', {
        path: this.path,
        held: remote.filter((r) => !drawn.includes(r)).map((r) => r.id),
        editing: editingState(appState),
      });
    }
    // An image drawn in whose picture the view has not loaded — one restored
    // after a delete lost, or added where its file arrived separately — shows
    // empty until the plugin loads the file, which only a reload does. Let go,
    // so the plugin reloads it; the binding returns once it has. (Seen in the
    // user's vaults: an image back in the drawing, missing from the view
    // until it was closed and opened again.)
    const loaded = api.getFiles?.();
    if (loaded) {
      const unloaded = drawn.filter((e) => e.type === 'image' && e.isDeleted !== true
        && typeof e.fileId === 'string' && !(e.fileId in loaded));
      if (unloaded.length > 0) {
        this.letGoFor(`an image drawn in that the view has not loaded (${unloaded.map((e) => e.id).join(' ')})`);
        return;
      }
    }
    this.scheduleSave();
  }

  /**
   * Draw the shared settings — background, grid — as the document holds them.
   * Through `updateScene` like an element, never into undo, and into what the
   * view stands on, so its next save carries the same settings.
   */
  private drawSettings(): void {
    const api = this.view.excalidrawAPI;
    if (!this.ydoc || !this.around || !api) return;
    if (this.switchedAway()) return;
    const shared = readExcalidraw(this.ydoc).appState;
    const shown = api.getAppState();
    const changed = Object.entries(shared).filter(([k, v]) => canonical(shown[k]) !== canonical(v));
    if (changed.length === 0) return;
    this.drawing = true;
    try {
      api.updateScene({ appState: Object.fromEntries(changed), captureUpdate: this.deps.lib()?.CaptureUpdateAction?.NEVER });
    } finally {
      this.drawing = false;
    }
    this.around = { ...this.around, appState: { ...this.around.appState, ...shared } };
    this.scheduleSave();
  }

  private saveTimer: number | null = null;

  /**
   * Ask the view to save a little after a remote change is drawn. The plugin
   * autosaves an open drawing only once a minute on desktop, and while bound
   * nothing else writes the file (SAFE-A19): without this, the file — what
   * git, a backup or another app sees — would lag the drawing by up to that.
   * Nothing is at risk meanwhile: the change is in the document and its store.
   */
  private scheduleSave(): void {
    if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = null;
      if (!this.bound || this.view.file?.path !== this.path) return;
      void this.view.save(true, false).catch((err: unknown) => {
        log.warn('A live drawing could not be saved after a remote change', { path: this.path, error: String(err) });
      });
    }, SAVE_AFTER_DRAW_MS);
  }

  /** Why the last attach did not bind, with what told it, for the manager's log. */
  refusal: { why: string; detail: Record<string, unknown> } | null = null;

  private refused(why: string, detail: Record<string, unknown>): void {
    this.refusal = { why, detail };
  }

  /**
   * Whether the view has moved on to another file. Obsidian reuses a view
   * when another drawing opens in the same tab, and the plugin keeps its
   * Excalidraw instance, so every hook and timer here would go on reading and
   * drawing another drawing's scene: capturing its elements into this
   * drawing's document, for every vault, or drawing this drawing's into it.
   * Seen to do both, in a review before release, before anything checked.
   * Lets go — without capturing — once it has.
   */
  private switchedAway(): boolean {
    if (this.view.file?.path === this.path) return false;
    if (this.bound) this.letGoFor('the view now shows another file');
    return true;
  }

  private letGoFor(why: string): void {
    log.info('Letting a live drawing go so a change it cannot draw is written to its file', { path: this.path, why });
    this.detach();
  }

  private safely(fn: () => void): void {
    try {
      fn();
    } catch (err) {
      // A loop the guard stopped is not the plugin's shape changing: let go,
      // logged already with its stack, and bind again later. Taken as a
      // failure it marked the view broken for good and told the user their
      // Excalidraw version was unsupported (found in review).
      if (err instanceof RunawayLoop) this.letGoFor('a runaway loop was stopped');
      else this.fail(err);
    }
  }

  private fail(err: unknown): void {
    log.warn('A live drawing hook failed; letting go', { path: this.path, error: String(err) });
    this.detach();
    this.deps.fellBack(this.path, String(err));
  }
}

/** Elements someone is editing here, by Excalidraw's own app state. */
/** What in the app state marks an edit in progress, for the log. */
function editingState(appState: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of ['editingTextElement', 'resizingElement', 'newElement', 'editingLinearElement', 'selectedElementsAreBeingDragged']) {
    const v = appState[k] as { id?: unknown; elementId?: unknown } | boolean | null | undefined;
    if (v === null || v === undefined || v === false) continue;
    out[k] = typeof v === 'object' ? (v.id ?? v.elementId ?? true) : v;
  }
  return out;
}

function editingIds(appState: Record<string, unknown>): Set<string> {
  const out = new Set<string>();
  for (const k of ['editingTextElement', 'resizingElement', 'newElement', 'editingLinearElement']) {
    const v = appState[k] as { id?: unknown; elementId?: unknown } | null | undefined;
    if (v && typeof v.id === 'string') out.add(v.id);
    if (v && typeof v.elementId === 'string') out.add(v.elementId);
  }
  if (appState.selectedElementsAreBeingDragged === true) {
    const sel = appState.selectedElementIds as Record<string, boolean> | undefined;
    for (const [id, on] of Object.entries(sel ?? {})) if (on) out.add(id);
  }
  return out;
}

/**
 * What open drawings deleted, recorded as Excalidraw deletes it, for the saves
 * that leave it out.
 *
 * Excalidraw for Obsidian writes a deleted element by leaving it out of the
 * file. Read as unchanged, a delete made while the drawing was not live
 * (offline, live sync off) never synced and the shape came back. Read from
 * absence instead, a view that never loaded a shape — our write landing as it
 * saved — deleted it in every vault. Asked of the open view at read-in, the
 * evidence was often gone: Excalidraw drops deleted elements from its scene on
 * a reload, and so does ExcalidrawAutomate when it adds an element, which the
 * plugin's own image insert does. All three found by the hardness run on
 * 4 October 2026. So a delete is recorded the moment the scene shows it,
 * through the view's own `onChange`, bound or not, with Excalidraw's own
 * version and nonce, and kept until the document has it.
 *
 * Added to a save only when the save does not have the element — one it has,
 * deleted or live, says for itself — and only when the document has it live:
 * one made and deleted here never existed anywhere else. An undo raises the
 * version and shows the element again, which drops the record. Versions do the
 * rest: a delete older than an edit made elsewhere is refused or loses to it.
 *
 * Keyed by the path the view shows when its scene changes. A tab reused for
 * another drawing could, for a moment, show the old scene under the new path;
 * its deleted elements then count only if the new drawing has the same ids
 * live, which only a copied drawing would.
 */
export class DeleteWitness {
  private seen = new Map<string, Map<string, SceneElement>>();
  private watching = new Map<ExcalidrawViewLike, { api: ExcalidrawApiLike; off: () => void }>();
  private retry: number | null = null;
  /** Looks taken in a row for a drawing still loading; see `watch`. */
  private retries = 0;

  constructor(private views: () => readonly ExcalidrawViewLike[]) {}

  /** Watch every open drawing, and stop watching the closed. */
  watch(): void {
    const open = new Set(this.views());
    for (const [view, w] of this.watching) {
      if (open.has(view) && view.excalidrawAPI === w.api) continue;
      try {
        w.off();
      } catch {
        // The view is going; nothing to unhook from.
      }
      this.watching.delete(view);
    }
    let loading = false;
    for (const view of open) {
      const api = view.excalidrawAPI;
      if (!api) loading = true;
      if (!api || this.watching.has(view)) continue;
      this.note(view);
      try {
        const off = api.onChange(() => this.note(view));
        this.watching.set(view, { api, off });
      } catch (err) {
        log.warn('Could not watch an open drawing for deletes', { path: view.file?.path, error: String(err) });
      }
    }
    // A drawing still loading has no API to watch yet, and nothing announces
    // when it gets one: a drawing reopened and a shape deleted in it at once
    // went unseen, and its delete never synced (the hardness run, seed 2,
    // round 48). So look again shortly, for as long as one is loading.
    // Ten seconds of that at most: a drawing that never loads is not worth
    // polling for ever, and the next layout change looks again.
    if (!loading) this.retries = 0;
    if (loading && this.retry === null && this.retries < 100) {
      this.retries++;
      this.retry = window.setTimeout(() => {
        this.retry = null;
        this.watch();
      }, 100);
    }
  }

  private note(view: ExcalidrawViewLike): void {
    // Called from Excalidraw's own change emitter: a throw would break it.
    try {
      guardRunaway('noting what a drawing deleted', { path: view.file?.path });
    } catch {
      return;
    }
    const path = view.file?.path;
    const scene = view.excalidrawAPI?.getSceneElementsIncludingDeleted();
    if (!path || !scene) return;
    let seen = this.seen.get(path);
    for (const e of scene) {
      const had = seen?.get(e.id);
      if (e.isDeleted === true) {
        if (had && had.version >= e.version) continue;
        if (!seen) this.seen.set(path, (seen = new Map<string, SceneElement>()));
        seen.set(e.id, stripInternal({ ...e }));
        log.debug('Saw a drawing delete an element', { path, id: `${e.id}@${e.version}` });
      } else if (had && e.version > had.version) {
        // Undone, or edited again elsewhere and drawn here: no longer deleted.
        seen?.delete(e.id);
      }
    }
  }

  /** Drop the record of a delete the document has reached. */
  forget(path: string, id: string): void {
    this.seen.get(path)?.delete(id);
  }

  /** What was seen deleted in `path` that `present` (by id) does not hold. */
  deletedBesides(path: string, present: ReadonlySet<string>): SceneElement[] {
    const seen = this.seen.get(path);
    return seen ? [...seen.values()].filter((e) => !present.has(e.id)) : [];
  }

  /** A save of `path`, with the deletes its open drawing made that it left out. */
  withViewDeletes(path: string, saved: unknown, current: unknown): unknown {
    const save = saved as ExcalidrawValue;
    const now = current as ExcalidrawValue;
    if (!Array.isArray(save?.elements) || !Array.isArray(now?.elements)) return saved;
    // What the views show now too, in case a change has not been reported yet.
    this.watch();
    for (const view of this.views()) if (view.file?.path === path) this.note(view);
    // A save of another drawing — a reused tab — is all elements this one
    // never had: say how many, whatever else happens.
    const everIn = new Set(now.elements.map((e) => e.id));
    const unknown = save.elements.filter((e) => e.isDeleted !== true && !everIn.has(e.id)).length;
    if (unknown > 0) log.debug('Reading in a drawing\'s save with elements its document never had', { path, unknown, live: save.elements.filter((e) => e.isDeleted !== true).length });
    const seen = this.seen.get(path);
    if (!seen || seen.size === 0) return saved;
    const inSave = new Set(save.elements.map((e) => e.id));
    const liveNow = new Map(now.elements.filter((e) => e.isDeleted !== true).map((e) => [e.id, e.version]));
    const added: SceneElement[] = [];
    for (const [id, e] of seen) {
      // Delivered, never anywhere else, or reached by a version as new — an
      // edit it lost to (see the binding's withRecordedDeletes): nothing more
      // to say.
      const standing = liveNow.get(id);
      if (standing === undefined || standing >= e.version) seen.delete(id);
      else if (!inSave.has(id)) added.push(e);
    }
    log.debug('Asked what open drawings deleted', { path, recorded: seen.size, added: added.length });
    if (added.length === 0) return saved;
    log.info('Read in deletes an open drawing made that its save left out', { path, ids: added.slice(0, 5).map((e) => e.id), count: added.length });
    return { ...save, elements: [...save.elements, ...added] };
  }

  dispose(): void {
    if (this.retry !== null) window.clearTimeout(this.retry);
    this.retry = null;
    for (const w of this.watching.values()) {
      try {
        w.off();
      } catch {
        // Going anyway.
      }
    }
    this.watching.clear();
    this.seen.clear();
  }
}

/**
 * The open drawings in shared folders, of the views Obsidian lists. A tab not
 * yet shown since Obsidian started holds a deferred view with no `file` at
 * all — undefined, not null — and reading its path threw: on a restart that
 * aborted the start of sync partway, and the vault sat unsynced (found in the
 * user's vault, 5 October 2026). Such a view is skipped until it loads.
 */
export function sharedDrawingViews(views: readonly unknown[], isShared: (path: string) => boolean): ExcalidrawViewLike[] {
  return views.filter((view): view is ExcalidrawViewLike => {
    const file = (view as { file?: { path?: unknown } | null } | null)?.file;
    return typeof file?.path === 'string' && isShared(file.path);
  });
}

export interface ExcalidrawLiveManagerDeps extends ExcalidrawLiveDeps {
  views(): ExcalidrawViewLike[];
  /** The user's "Live sync for Excalidraw drawings" setting. */
  enabled(): boolean;
  notify(message: string): void;
  /**
   * The record of what open drawings deleted. Owned by the caller, since it
   * must outlive this manager: the manager is rebuilt on every start of sync,
   * and a witness that went with it forgot every delete made while sync was
   * off — the very ones it exists for (found by the hardness run).
   */
  witness?: DeleteWitness;
}

/** Binds every open drawing it can, and lets go of the rest. */
export class ExcalidrawLiveManager {
  private bindings = new Map<ExcalidrawViewLike, ExcalidrawLiveBinding>();
  private brokenViews = new WeakMap<ExcalidrawViewLike, string>();
  private pending = new Set<ExcalidrawViewLike>();
  /** Views tried and not bound yet: since when, how often, and the last reason logged. */
  private waiting = new WeakMap<ExcalidrawViewLike, { since: number; attempts: number; last: string }>();
  private retry: number | null = null;
  private notified = false;
  private disposed = false;
  private listeners = new Set<(b: ExcalidrawLiveBinding) => void>();

  constructor(private deps: ExcalidrawLiveManagerDeps) {}

  onBound(cb: (b: ExcalidrawLiveBinding) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /** What open drawings deleted, live or not (DeleteWitness). */
  private get witness(): DeleteWitness {
    this.ownWitness ??= this.deps.witness ?? new DeleteWitness(() => this.deps.views());
    return this.ownWitness;
  }
  private ownWitness: DeleteWitness | null = null;

  /** For StructuredSync's read-in of a save: see DeleteWitness. */
  withViewDeletes(path: string, saved: unknown, current: unknown): unknown {
    return this.witness.withViewDeletes(path, saved, current);
  }

  bindingFor(view: unknown): ExcalidrawLiveBinding | null {
    return this.bindings.get(view as ExcalidrawViewLike) ?? null;
  }

  /** Every binding, for presence. */
  all(): ExcalidrawLiveBinding[] {
    return [...this.bindings.values()];
  }

  /** Look at every open drawing: bind the new, let go of the gone. */
  refresh(): void {
    if (this.disposed) return;
    // Every open drawing, live sync on or off: a delete is in no file.
    this.witness.watch();
    const enabled = this.deps.enabled();
    const open = new Set(enabled ? this.deps.views() : []);
    let waiting = false;
    for (const [view, b] of this.bindings) {
      if (!open.has(view) || view.file?.path !== b.path || !b.isBound()) {
        b.detach();
        this.bindings.delete(view);
      }
    }
    for (const view of open) {
      const path = view.file?.path;
      if (!path || this.bindings.has(view)) continue;
      if (this.brokenViews.get(view) === path) continue;
      waiting = true;
      if (!this.deps.structured.docNameFor(path)) continue;
      void this.tryBind(view, path);
    }
    if (waiting) this.scheduleRetry();
  }

  private async tryBind(view: ExcalidrawViewLike, path: string): Promise<void> {
    if (this.pending.has(view)) return;
    this.pending.add(view);
    const binding = new ExcalidrawLiveBinding(view, path, {
      ...this.deps,
      witness: this.witness,
      fellBack: (p, reason) => {
        this.brokenViews.set(view, p);
        this.fellBack(p, reason);
      },
    });
    const wait = this.waiting.get(view) ?? { since: Date.now(), attempts: 0, last: '' };
    this.waiting.set(view, wait);
    wait.attempts++;
    try {
      const result = await binding.attach();
      if (result !== 'bound') {
        // Once per reason: the manager asks again every second and a half. A
        // view never bound has no live edits and no presence, and nothing
        // else would say so.
        const why = binding.refusal ?? { why: String(result), detail: {} };
        const line = `${why.why} ${JSON.stringify(why.detail)}`;
        if (line !== wait.last) {
          wait.last = line;
          log.debug('An open drawing is not bound live yet', { path, why: why.why, ...why.detail });
        }
      }
      if (result === 'bound') {
        if (this.disposed || this.bindings.has(view) || !this.deps.enabled()) {
          binding.detach();
          return;
        }
        this.waiting.delete(view);
        if (wait.attempts > 1) {
          log.info('Bound an open drawing live after waiting', {
            path, ms: Date.now() - wait.since, attempts: wait.attempts, lastRefusal: wait.last,
          });
        }
        this.bindings.set(view, binding);
        // A binding that lets go by itself — for a change it cannot draw — is
        // forgotten and tried again, or the drawing would stay on the disk
        // path until the user happened to switch panes. One that failed is in
        // `brokenViews`, and is not.
        binding.onDetach(() => {
          if (this.disposed || this.bindings.get(view) !== binding) return;
          this.bindings.delete(view);
          this.scheduleRetry();
        });
        for (const cb of this.listeners) cb(binding);
      }
    } catch (err) {
      log.warn('Could not bind an open drawing live', { path, error: String(err) });
    } finally {
      this.pending.delete(view);
    }
  }

  private fellBack(path: string, reason: string): void {
    log.warn('A drawing is syncing over disk instead of live', { path, reason });
    this.deps.fellBack(path, reason);
    if (this.notified) return;
    this.notified = true;
    this.deps.notify(
      'Nectenda: live editing of Excalidraw drawings is unavailable with this version of the Excalidraw plugin. ' +
      'Drawings still sync when they are saved. Details are in the diagnostic log.',
    );
  }

  private scheduleRetry(): void {
    if (this.retry !== null || this.disposed) return;
    this.retry = window.setTimeout(() => {
      this.retry = null;
      this.refresh();
    }, 1500);
  }

  /** Let every drawing go, keeping the manager: their documents are about to be rebuilt. */
  reset(): void {
    for (const b of this.bindings.values()) b.detach();
    this.bindings.clear();
  }

  dispose(): void {
    this.disposed = true;
    // Only one it made itself: the caller's must outlive it.
    if (!this.deps.witness) this.ownWitness?.dispose();
    if (this.retry !== null) window.clearTimeout(this.retry);
    for (const b of this.bindings.values()) b.detach();
    this.bindings.clear();
  }
}
