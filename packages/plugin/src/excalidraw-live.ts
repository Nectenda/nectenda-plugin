import type * as Y from 'yjs';
import { guardRunaway, RunawayLoop } from './runaway-guard';
import type { Awareness } from 'y-protocols/awareness';
import type { BindResult, BoundView, StructuredSync } from './structured-sync';
import { excalidrawCodec } from './excalidraw-codec';
import {
  ROOT_APP_STATE, SHARED_APP_STATE, SHARED_SCENE_KEYS, applyExcalidraw, isAnotherDrawing, observeExcalidraw, readExcalidraw, revisionsById, unverified, versionsKnown, type ExcalidrawValue,
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
 * in; its other parts against the document's own, but for what a tab of the
 * drawing showed as it closed (`DeleteWitness.restBase`).
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
  /**
   * The file text the view last loaded or saved (Obsidian's TextFileView).
   * Not updated when the plugin reloads only its scene (NEC-226), so it says
   * nothing of elements; read for the rest of a drawing (DeleteWitness).
   */
  data?: string;
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

/** Numbers each binding, so the log can tell one tab's binding from the next. */
let bindingCount = 0;

export class ExcalidrawLiveBinding implements BoundView {
  /**
   * Which binding this is, and when it bound. A save names no view, so one
   * that lands after its tab closed and another bound is read in by the new
   * binding (NEC-225): logged with these, such a save shows as one read in
   * moments after binding.
   */
  private readonly id = ++bindingCount;
  private boundAt = 0;
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
   * seen showing before binding, at attach, as drawn, as carried in — by
   * version and nonce. The only base
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
  private unGesture: (() => void) | null = null;
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
      this.deps.structured.releaseDoc(docName, undefined, held.ydoc);
      this.refused('not-ready', { scene: 'another drawing' });
      return 'not-ready';
    }
    // What the view holds before its save, for the bases below: the save may
    // be read into the document while the view moves past it (NEC-239).
    const before = new Map<string, string[]>();
    for (const e of this.view.excalidrawAPI?.getSceneElementsIncludingDeleted() ?? []) {
      before.set(e.id, [`${e.version}:${e.versionNonce}`]);
    }
    // An edit waiting for the view's save is written out first, so file and
    // view agree before either is compared.
    if (this.view.isDirty?.()) {
      log.debug('Saving an open drawing before binding it', { path: this.path });
      await this.view.save(true, false);
    }
    if (this.view.file?.path !== this.path) {
      this.deps.structured.releaseDoc(docName, undefined, held.ydoc);
      return 'not-owned';
    }
    const diskText = await this.deps.readFile(this.path);
    const parsed = diskText ? excalidrawCodec.parse(diskText) : null;
    if (!parsed?.ok) {
      this.deps.structured.releaseDoc(docName, undefined, held.ydoc);
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
      this.deps.structured.releaseDoc(docName, undefined, held.ydoc);
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
      this.deps.structured.releaseDoc(docName, undefined, held.ydoc);
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
      this.deps.structured.releaseDoc(docName, undefined, held.ydoc);
      this.refused('not-ready', { waiting: 'the file to be written with a change the view cannot draw' });
      return 'not-ready';
    }
    // Handed over as the document's own value, so binding writes nothing:
    // the first capture carries in what the view adds, against the document.
    // With the document acquired above: if a reconnect replaced it while the
    // save and the read were awaited, this is refused, and the next attach
    // binds to the new one.
    const result = this.deps.structured.bindView(docName, this, docValue, held.ydoc);
    if (result !== 'bound') {
      this.deps.structured.releaseDoc(docName, undefined, held.ydoc);
      this.refused(result, {});
      return result;
    }
    this.docName = docName;
    this.ydoc = held.ydoc;
    this.awareness = held.awareness;
    this.around = { ...disk, elements: [] };
    this.seen.clear();
    {
      // What the view holds, where the document has it. Where it does not,
      // the latest version the view held before it that the document still
      // has, by the order the witness saw the view show them — or, with no
      // such record, what the view held before its save above. An edit made
      // during that save leaves the view a version past what the save wrote,
      // and the save may be read in before this: recorded as made on
      // nothing, the view's own saved version beneath it was kept as a copy
      // (NEC-239). By order, never by highest number: the version named is
      // removed outright as superseded, and a view can show two rivals of
      // one number in turn, or reload an older file; named by number, the
      // version it did not edit on was removed with no copy (found in review).
      const revs = revisionsById(held.ydoc);
      const history = this.deps.witness?.historyOf(this.view, this.path);
      for (const e of this.view.excalidrawAPI?.getSceneElementsIncludingDeleted() ?? []) {
        const list = revs.get(e.id);
        if (!list) continue;
        if (list.some((r) => r.rev.version === e.version && r.rev.versionNonce === e.versionNonce)) {
          this.see(e);
          continue;
        }
        const pairs = history?.get(e.id) ?? before.get(e.id) ?? [];
        for (let i = pairs.length - 1; i >= 0; i--) {
          const [version, nonce] = pairs[i].split(':').map(Number);
          const r = list.find((x) => x.rev.version === version && x.rev.versionNonce === nonce);
          if (r) {
            this.see(r.rev);
            break;
          }
        }
      }
    }
    this.bound = true;
    this.boundAt = Date.now();
    if (this.deps.pluginVersion && this.deps.pluginVersion !== EXCALIDRAW_READ_AGAINST) {
      log.info('A live drawing is running on an Excalidraw plugin its internals were not read against', {
        running: this.deps.pluginVersion, readAgainst: EXCALIDRAW_READ_AGAINST,
      });
    }
    try {
      const api = this.view.excalidrawAPI!;
      this.unChange = api.onChange(() => this.safely(() => this.scheduleCapture()));
      this.watchGestureEnds();
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
    log.debug('Bound an open drawing live', { path: this.path, binding: this.id });
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
    this.unGesture?.();
    this.unGesture = null;
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
   *
   * Except that a save names no view: a tab of this drawing that closed as
   * this one opened can land its save here, and its other parts are what it
   * showed, not edits. Where they are what a closed view held and the
   * document holds otherwise, they are read in as unchanged, and the binding
   * lets go (`DeleteWitness.restBase`, NEC-235).
   */
  readInSave(value: unknown): { passedOver: string[]; keep: boolean } {
    if (!this.ydoc || !this.bound) return { passedOver: [], keep: false };
    const saved = value as ExcalidrawValue;
    const doc = readExcalidraw(this.ydoc);
    const { changed, bases, older } = this.newerThanDocument(this.withRecordedDeletes(saved.elements));
    // A save names no view: a tab of this drawing that closed as this one
    // opened can land its save here, built on a note, settings or links it
    // showed before a remote change to them. Those parts are not its edits,
    // and are not read in as such (NEC-235).
    const rest = this.deps.witness?.restBase(this.path, saved, { ...doc, elements: bases }) ?? { base: { ...doc, elements: bases }, passedOver: [], keep: false };
    this.ydoc.transact(() => {
      applyExcalidraw(this.ydoc!, { ...saved, elements: changed }, rest.base as ExcalidrawValue);
    }, ORIGIN);
    for (const e of changed) this.see(e);
    this.around = { ...saved, elements: [] };
    // Every save read in says so, with what it passed over: an element older
    // than the document's is taken for a view not caught up yet, and dropped.
    // From another tab's save it could be an edit, and nothing else would
    // show it went (NEC-225).
    log.debug('Read a bound drawing\'s save in', {
      path: this.path, binding: this.id, boundMs: Date.now() - this.boundAt,
      carried: changed.length, olderThanDocument: older.length, older: older.slice(0, 5),
    });
    if (changed.length > 0) {
      log.info('An open drawing saved elements its live binding had not carried in; read them in', {
        path: this.path, count: changed.length,
      });
    }
    if (rest.passedOver.length > 0) {
      // The view loaded that save's file too, as Excalidraw reloads a file
      // that changes under it, so it now shows what was passed over, and its
      // next save would write it again. Let go: the file is written with the
      // document's values, the plugin loads them, and the view binds again —
      // the way any change the view cannot draw reaches it.
      this.letGoFor(`a save held what a closed view of it showed (${rest.passedOver.slice(0, 5).join(' ')})`);
    }
    return { passedOver: rest.passedOver, keep: rest.keep };
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

  private newerThanDocument(elements: readonly SceneElement[]): { changed: SceneElement[]; bases: SceneElement[]; older: string[] } {
    const revs = this.ydoc ? revisionsById(this.ydoc) : new Map<string, Array<{ rev: SceneElement }>>();
    const changed: SceneElement[] = [];
    const bases: SceneElement[] = [];
    /** Passed over as behind the document, as `id@theirs<@document's`, for the log. */
    const older: string[] = [];
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
      } else if (e.version < w.version) {
        older.push(`${e.id}@${e.version}<@${w.version}`);
      }
    }
    return { changed, bases, older };
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

  /**
   * Capture at once when a gesture ends — the pointer released or cancelled,
   * the window left — rather than at the end of the throttle: a quit in those
   * 100 ms lost what the gesture made (NEC-211; Canvas does the same,
   * canvas-live.ts). After Excalidraw's own handler of the event, which is
   * what finishes the gesture — an element finalised, an eraser's deletes —
   * so a task later, not in the capture phase (found in review). Only when a
   * capture is waiting then, so a click that changed nothing reads nothing.
   */
  private watchGestureEnds(): void {
    const win = (this.view as { containerEl?: { ownerDocument?: { defaultView?: unknown } } }).containerEl?.ownerDocument?.defaultView ?? window;
    const target = win as Partial<Pick<Window, 'addEventListener' | 'removeEventListener'>>;
    if (typeof target.addEventListener !== 'function' || typeof target.removeEventListener !== 'function') return;
    const now = (): void => {
      window.setTimeout(() => {
        if (this.captureTimer === null || !this.bound) return;
        window.clearTimeout(this.captureTimer);
        this.captureTimer = null;
        this.safely(() => this.capture());
      }, 0);
    };
    target.addEventListener('pointerup', now, true);
    target.addEventListener('pointercancel', now, true);
    target.addEventListener('blur', now);
    this.unGesture = () => {
      target.removeEventListener!('pointerup', now, true);
      target.removeEventListener!('pointercancel', now, true);
      target.removeEventListener!('blur', now);
    };
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
    // An image new here: its file is named under "## Embedded Files" only by
    // the view's save, which the plugin makes about once a minute. Until then
    // every other vault has the element without its file, and lets go to
    // reload for it; and the file on disk lags the drawing. Saved soon after.
    const newImage = changed.some((e) => e.type === 'image' && e.isDeleted !== true && !this.seen.has(e.id));
    this.ydoc.transact(() => {
      applyExcalidraw(this.ydoc!, { ...around, elements: changed }, { ...around, elements: bases });
    }, ORIGIN);
    for (const e of changed) this.see(e);
    if (newImage) this.scheduleSave();
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
   * Ask the view to save a little after a remote change is drawn, or after an
   * image added here is carried in (see carryIn). The plugin
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
        log.warn('A live drawing could not be saved after a change', { path: this.path, error: String(err) });
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

  /** BoundView: the document is being torn down under this binding. */
  letGo(): void {
    if (this.bound) this.letGoFor('its document is being torn down');
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
 * How long what a closed view of a drawing held is kept, for its save on
 * closing (`DeleteWitness.restBase`). Excalidraw writes that save about 200 ms
 * after it starts; this is room for a slow disk and a busy machine, and short
 * enough that a later edit is unlikely to set a part back to exactly that.
 */
const CLOSED_HELD_MS = 30_000;

/** How many shown versions of one element `DeleteWitness` keeps, per view. */
const SHOWN_PER_ELEMENT = 16;

/**
 * Append `pair` to `id`'s history unless it is already the latest: the order
 * a view showed versions in, bounded by dropping the oldest, which is the
 * least likely to be what an edit was made on. Losing one costs a kept copy.
 */
function addInOrder(history: Map<string, string[]>, id: string, pair: string): void {
  const pairs = history.get(id);
  if (!pairs) history.set(id, [pair]);
  else if (pairs[pairs.length - 1] !== pair) {
    pairs.push(pair);
    if (pairs.length > SHOWN_PER_ELEMENT) pairs.shift();
  }
}

function addShown(shown: Map<string, string[]>, id: string, pair: string): void {
  const pairs = shown.get(id);
  if (!pairs) shown.set(id, [pair]);
  else if (!pairs.includes(pair)) {
    pairs.push(pair);
    // Bounded: versions only rise, so the lowest is the least likely to be a
    // save's base. Losing one costs a kept copy, not an edit.
    if (pairs.length > SHOWN_PER_ELEMENT) {
      pairs.sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
      pairs.shift();
    }
  }
}

/**
 * The highest version of an element a view's scene was seen to hold
 * (`DeleteWitness.recordedAhead`): the element; the version it was made on,
 * the one recorded before it, if any (`on`); some other elements of that scene
 * (`peers`), deleted ones included, by which an element the document lacks is
 * told from another drawing's; and whether the document has had it (`done`).
 * Kept once done, so that the next edit knows what it was made on.
 */
interface Drawn {
  element: SceneElement;
  on: string | null;
  peers: string[];
  done: boolean;
  /** Read back from the stored record (`take`): a delete made before the restart, on `on`. */
  restored?: boolean;
}

/** Where `DeleteWitness` keeps its record of deletes across a restart: one text, read once and written whole. */
export interface DeleteRecordStore {
  load(): Promise<string | null>;
  save(text: string): Promise<void>;
}

/** A scene, by each element's id and version: what tells a scene that has changed from one that has not. */
function sceneMark(scene: readonly SceneElement[]): string {
  return scene.map((e) => `${e.id}@${e.version}`).join(',');
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
 *
 * It also records which version of each element a view has shown, for the
 * base a save is read in against (`verifiedBase`). The disk path's base is a
 * guess — our last write, or the last session's record — and a version in it
 * is removed as superseded by the save's newer one. A view whose scene never
 * redrew our write builds on what it held before, so the remote version in
 * that base was superseded by nobody, and removing it lost it with no copy
 * (NEC-212).
 *
 * And it records the highest version of each element any view's scene was
 * seen to hold, past the view (`recordedAhead`). Excalidraw clears a view's
 * unsaved flag when a save ends, not at the scene it saved, so an edit made
 * during a save is marked clean, and a tab switched or closed then saves
 * nothing (NEC-236, hardness seed 225003, traced in 2.27.3 and 2.28.1); a
 * scene rebuilt from the file throws its edits away the same way (seed
 * 235001). What the scene held is read into the document before the
 * drawing's next write, and a view leaving the drawing asks for that write
 * (`onLeft`), so none of it waits on Excalidraw saving.
 *
 * The record of deletes is kept on this device too (`DeleteRecordStore`), and
 * read back before any drawing connects (`restore`). In memory only, a delete
 * made with sync stopped, or in the second before its save was read in, came
 * back if Obsidian quit first (NEC-211). Still by path: with sync stopped
 * there is no document to name it by, so a rename moves it (`renamed`).
 */
export class DeleteWitness {
  private seen = new Map<string, Map<string, SceneElement>>();
  /**
   * Per path, the ids whose delete came from the stored record, not from a
   * view this session. An element absent from a document that has not yet had
   * its first sync is "not heard from yet", not gone, and such a record is not
   * dropped for it (`withViewDeletes`).
   */
  private restoredIds = new Map<string, Set<string>>();
  private restoring: Promise<void> | null = null;
  /** Whether the stored record has been read: until it has, nothing is written over it. */
  private loaded = false;
  /** The record has changed since it was last written. */
  private dirty = false;
  private flushQueued = false;
  private writing: Promise<void> = Promise.resolve();
  private disposed = false;
  /**
   * Per view, per path, per element id: the `version:versionNonce` pairs that
   * view has shown. Per view, not per path: with two views of one drawing
   * open, one that drew a version says nothing of the other, which may not
   * have, and either may be the one that saved. Weakly held, so a closed view
   * is not kept alive by it, and kept while the view lives though it is let go
   * and watched again: with sync stopped no drawing is listed, and a view that
   * came back with an empty record would vouch for nothing it had shown
   * before, leaving copies of what it had.
   */
  private shownByView = new WeakMap<ExcalidrawViewLike, Map<string, Map<string, string[]>>>();
  /** Per path, the same for every view of it this session, closed ones included. */
  private shownByPath = new Map<string, Map<string, string[]>>();
  /**
   * Per view, per path, per element id: the `version:versionNonce` pairs the
   * view showed, in the order it showed them, each once in a row. What a
   * binding names as the base of a version the view holds past the document
   * is the latest of these the document has (NEC-239): by order, not by
   * number. A view can show two rivals of one number in turn, or reload a
   * file older than a version it showed, and its edit is made on the one it
   * held last; named by highest number, the other was removed as superseded
   * with no copy (found in review, and reproduced). Not `shownByView`, which
   * is a set, and reordered when it is trimmed.
   */
  private historyByView = new WeakMap<ExcalidrawViewLike, Map<string, Map<string, string[]>>>();
  /** Per path, the element versions `saveViewsAhead` has already forced a save for. */
  private forced = new Map<string, Set<string>>();
  /** Per view watched, the path it shows and the file text it last held, for `closedHeld`. */
  private heldByView = new Map<ExcalidrawViewLike, { path: string; text: string }>();
  /**
   * Per path, the file text each view of it held as it closed or turned to
   * another file, and when: what its save on closing was built on (`restBase`).
   */
  private closedHeld = new Map<string, Array<{ text: string; at: number; value?: ExcalidrawValue | null; dropped?: Set<string>; kept?: boolean }>>();
  /** Per path, per element id: the highest version any view's scene of it was seen to hold. See `Drawn`. */
  private drawn = new Map<string, Map<string, Drawn>>();
  /** The path each watched view showed when last seen. */
  private showing = new Map<ExcalidrawViewLike, string>();
  /**
   * A view that has just turned to another file, with the scene it showed as
   * it turned: until that scene changes it is the old file's, under the new
   * path, and nothing in it is recorded for the new one. Recorded, a copy of a
   * drawing — which shares its ids — had the other's versions read into it
   * (found in review).
   */
  private turned = new WeakMap<ExcalidrawViewLike, string>();
  /** Told the path a view stopped showing — switched to another file, closed, or rebuilt. */
  onLeft: ((path: string) => void) | null = null;
  private watching = new Map<ExcalidrawViewLike, { api: ExcalidrawApiLike; off: () => void }>();
  private retry: number | null = null;
  /** Looks taken in a row for a drawing still loading; see `watch`. */
  private retries = 0;

  constructor(private views: () => readonly ExcalidrawViewLike[], private store: DeleteRecordStore | null = null) {}

  /**
   * Read the stored record of deletes back, once; resolves when it has been.
   * Awaited before any drawing connects: a connect's first write reads the
   * file in, and a delete it did not know of was put back (NEC-211). A record
   * that cannot be read is no record — today's behaviour, the shape back and
   * visible — and says so in the log.
   */
  restore(): Promise<void> {
    this.restoring ??= (async () => {
      let text: string | null = null;
      try {
        text = this.store ? await this.store.load() : null;
      } catch (err) {
        log.warn('Could not read the stored record of what drawings deleted; deletes made before the restart that never synced may come back', { error: String(err) });
      }
      if (text !== null && !this.disposed) this.take(text);
      this.loaded = true;
      if (this.dirty) this.changed();
    })();
    return this.restoring;
  }

  /** Take in a stored record: a delete only where this session has not seen the element at a version as high. */
  private take(text: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      log.warn('The stored record of what drawings deleted does not parse; ignoring it');
      return;
    }
    const paths = (parsed as { v?: unknown; paths?: unknown } | null)?.v === 1 ? (parsed as { paths?: unknown }).paths : null;
    if (paths === null || typeof paths !== 'object') {
      log.warn('The stored record of what drawings deleted is not one this version reads; ignoring it');
      return;
    }
    let count = 0;
    for (const [path, list] of Object.entries(paths as Record<string, unknown>)) {
      if (!Array.isArray(list)) continue;
      for (const rec of list as Array<{ element?: unknown; on?: unknown }>) {
        const e = rec?.element as SceneElement | undefined;
        if (!e || typeof e.id !== 'string' || typeof e.version !== 'number' || e.isDeleted !== true) continue;
        let seen = this.seen.get(path);
        if (seen?.get(e.id) && seen.get(e.id)!.version >= e.version) continue;
        let drawn = this.drawn.get(path);
        if (drawn?.get(e.id) && drawn.get(e.id)!.element.version >= e.version) continue;
        if (!seen) this.seen.set(path, (seen = new Map<string, SceneElement>()));
        seen.set(e.id, e);
        let restored = this.restoredIds.get(path);
        if (!restored) this.restoredIds.set(path, (restored = new Set<string>()));
        restored.add(e.id);
        // And as a version the document may lack, so the next write reads it
        // in whether or not a save leaves it out — one made before the delete
        // still holds the shape (`recordedAhead`).
        if (!drawn) this.drawn.set(path, (drawn = new Map<string, Drawn>()));
        drawn.set(e.id, { element: e, on: typeof rec.on === 'string' ? rec.on : null, peers: [], done: false, restored: true });
        count++;
      }
    }
    if (count > 0) log.info('Read back what drawings deleted before the restart that has not synced yet', { count, paths: Object.keys(paths).length });
  }

  /** The record of deletes changed: write it, soon, once the stored one has been read. */
  private changed(): void {
    if (!this.store || this.disposed) return;
    this.dirty = true;
    if (!this.loaded || this.flushQueued) return;
    this.flushQueued = true;
    // A microtask, not a timer: a crash between a delete and its write is the
    // one way left to lose it, so the window is kept as small as can be.
    queueMicrotask(() => {
      this.flushQueued = false;
      this.flush();
    });
  }

  private flush(): void {
    if (!this.store || !this.dirty) return;
    this.dirty = false;
    const paths: Record<string, Array<{ element: SceneElement; on: string | null }>> = {};
    for (const [path, seen] of this.seen) {
      if (seen.size === 0) continue;
      paths[path] = [...seen.values()].map((element) => {
        const d = this.drawn.get(path)?.get(element.id);
        return { element, on: d && d.element.version === element.version ? d.on : null };
      });
    }
    const text = JSON.stringify({ v: 1, paths });
    const store = this.store;
    this.writing = this.writing.then(() => store.save(text)).catch((err: unknown) => {
      log.warn('Could not store the record of what drawings deleted; a delete not yet synced may come back after a restart', { error: String(err) });
    });
  }

  /** Writes of the record still in flight; for a test, and for unload. */
  settled(): Promise<void> {
    return this.writing;
  }

  /**
   * A file or folder moved from `oldPath` to `newPath`: its record moves with
   * it. Sync on or off, since a delete waits for sync in exactly the case
   * that matters. Left behind, the shape came back under its new name.
   */
  renamed(oldPath: string, newPath: string): void {
    const moved = (p: string): string | null => (p === oldPath ? newPath : p.startsWith(`${oldPath}/`) ? newPath + p.slice(oldPath.length) : null);
    // Merged into what is already there, by version, not over it: a view
    // that showed the new path first may have recorded a delete under it
    // before this ran (found in review).
    const higher = <T>(version: (x: T) => number) => (into: Map<string, T>, from: Map<string, T>): void => {
      for (const [id, x] of from) {
        const there = into.get(id);
        if (!there || version(x) > version(there)) into.set(id, x);
      }
    };
    const mergeSeen = higher<SceneElement>((e) => e.version);
    const mergeDrawn = higher<Drawn>((d) => d.element.version);
    let any = false;
    for (const [p, v] of [...this.seen]) {
      const to = moved(p);
      if (to === null) continue;
      this.seen.delete(p);
      const there = this.seen.get(to);
      if (there) mergeSeen(there, v);
      else this.seen.set(to, v);
      any = true;
    }
    for (const [p, v] of [...this.restoredIds]) {
      const to = moved(p);
      if (to === null) continue;
      this.restoredIds.delete(p);
      this.restoredIds.set(to, new Set([...(this.restoredIds.get(to) ?? []), ...v]));
    }
    for (const [p, v] of [...this.drawn]) {
      const to = moved(p);
      if (to === null) continue;
      this.drawn.delete(p);
      const there = this.drawn.get(to);
      if (there) mergeDrawn(there, v);
      else this.drawn.set(to, v);
    }
    if (any) {
      log.debug('Moved what a drawing deleted with it', { from: oldPath, to: newPath });
      this.changed();
    }
  }

  /**
   * A file or folder at `path` was deleted: what was recorded for it goes,
   * here and in storage, rather than being kept for a drawing that is gone.
   * A drawing made again at the path is a new one, whose shapes these deletes
   * never applied to.
   */
  deleted(path: string): void {
    const under = (p: string): boolean => p === path || p.startsWith(`${path}/`);
    let any = false;
    for (const p of [...this.seen.keys()]) {
      if (!under(p)) continue;
      this.seen.delete(p);
      any = true;
    }
    for (const p of [...this.restoredIds.keys()]) if (under(p)) this.restoredIds.delete(p);
    for (const p of [...this.drawn.keys()]) if (under(p)) this.drawn.delete(p);
    if (any) this.changed();
  }

  /** Watch every open drawing, and stop watching the closed. */
  watch(): void {
    const open = new Set(this.views());
    for (const [view, held] of this.heldByView) {
      if (open.has(view)) continue;
      this.heldByView.delete(view);
      this.closed(held);
    }
    for (const [view, w] of this.watching) {
      if (open.has(view) && view.excalidrawAPI === w.api) {
        this.showingNow(view);
        continue;
      }
      try {
        w.off();
      } catch {
        // The view is going; nothing to unhook from.
      }
      this.watching.delete(view);
      // Closed, or its scene rebuilt: what it held is gone from it.
      const was = this.showing.get(view);
      this.showing.delete(view);
      if (was !== undefined) this.left(was);
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
        if (view.file?.path) this.showing.set(view, view.file.path);
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

  /** Note the path a watched view shows, and say so if it has moved on from another. */
  private showingNow(view: ExcalidrawViewLike): void {
    const path = view.file?.path;
    const was = this.showing.get(view);
    if (path) this.showing.set(view, path);
    else this.showing.delete(view);
    if (was !== undefined && was !== path) {
      this.turned.set(view, sceneMark(view.excalidrawAPI?.getSceneElementsIncludingDeleted() ?? []));
      this.left(was);
    }
  }

  private left(path: string): void {
    try {
      this.onLeft?.(path);
    } catch (err) {
      log.warn('Could not ask for a write of a drawing a view left', { path, error: String(err) });
    }
  }

  private note(view: ExcalidrawViewLike): void {
    // Called from Excalidraw's own change emitter: a throw would break it.
    try {
      guardRunaway('noting what a drawing deleted', { path: view.file?.path });
    } catch {
      return;
    }
    if (this.watching.has(view)) this.showingNow(view);
    const path = view.file?.path;
    if (path) this.hold(view, path);
    const scene = view.excalidrawAPI?.getSceneElementsIncludingDeleted();
    if (!path || !scene) return;
    let drawn = this.drawn.get(path);
    if (!drawn) this.drawn.set(path, (drawn = new Map<string, Drawn>()));
    // The old file's scene, still shown under the new path: not this drawing's.
    const turned = this.turned.get(view);
    const mark = turned === undefined ? null : sceneMark(scene);
    const record = turned === undefined || mark !== turned;
    if (turned !== undefined && record) this.turned.delete(view);
    const sample = scene.slice(0, 9).map((e) => e.id);
    let seen = this.seen.get(path);
    let paths = this.shownByView.get(view);
    if (!paths) this.shownByView.set(view, (paths = new Map<string, Map<string, string[]>>()));
    let shown = paths.get(path);
    if (!shown) paths.set(path, (shown = new Map<string, string[]>()));
    let anyView = this.shownByPath.get(path);
    if (!anyView) this.shownByPath.set(path, (anyView = new Map<string, string[]>()));
    let histories = this.historyByView.get(view);
    if (!histories) this.historyByView.set(view, (histories = new Map<string, Map<string, string[]>>()));
    let history = histories.get(path);
    if (!history) histories.set(path, (history = new Map<string, string[]>()));
    for (const e of scene) {
      addShown(shown, e.id, `${e.version}:${e.versionNonce}`);
      addShown(anyView, e.id, `${e.version}:${e.versionNonce}`);
      // A delete read back from before a restart, while the view shows the
      // shape live at a version as high: the file still held it — Obsidian
      // quit before Excalidraw saved — and the user has edited it since, on
      // the version before the delete, so at the same number. That edit is
      // newer than the delete and stands; as a rival of the same version the
      // delete won about half the time, by nonce (found in review).
      if (record && e.isDeleted !== true && this.restoredIds.get(path)?.has(e.id) === true) {
        const restored = seen?.get(e.id);
        if (restored && e.version >= restored.version && `${e.version}:${e.versionNonce}` !== `${restored.version}:${restored.versionNonce}`) {
          log.info('A delete read back from before a restart gave way to an edit of the shape since', { path, id: `${e.id}@${e.version}` });
          this.drop(path, e.id);
          // Made on what the delete was made on: the version the file held.
          const gone = drawn.get(e.id);
          if (gone?.element.isDeleted === true) {
            drawn.set(e.id, { element: stripInternal({ ...e }), on: gone.on, peers: sample.filter((id) => id !== e.id).slice(0, 8), done: false });
          }
        }
      }
      // Not while a turned tab still shows the old file's scene: those are
      // the other drawing's versions, which a copy of it shares by id.
      if (record) addInOrder(history, e.id, `${e.version}:${e.versionNonce}`);
      // Cloned only when the version rises: this runs on every scene change.
      const was = drawn.get(e.id);
      if (record && (!was || e.version > was.element.version)) {
        drawn.set(e.id, {
          element: stripInternal({ ...e }),
          on: was ? `${was.element.version}:${was.element.versionNonce}` : null,
          peers: sample.filter((id) => id !== e.id).slice(0, 8),
          done: false,
        });
      }
      const had = seen?.get(e.id);
      if (e.isDeleted === true) {
        if (had && had.version >= e.version) continue;
        if (!seen) this.seen.set(path, (seen = new Map<string, SceneElement>()));
        seen.set(e.id, stripInternal({ ...e }));
        this.restoredIds.get(path)?.delete(e.id);
        this.changed();
        log.debug('Saw a drawing delete an element', { path, id: `${e.id}@${e.version}` });
      } else if (had && e.version > had.version) {
        // Undone, or edited again elsewhere and drawn here: no longer deleted.
        this.drop(path, e.id);
      }
    }
  }

  /** Record the file text `view` holds for `path`; a view that turned to another file closed the old one. */
  private hold(view: ExcalidrawViewLike, path: string): void {
    const held = this.heldByView.get(view);
    if (held && held.path !== path) {
      this.heldByView.delete(view);
      this.closed(held);
    }
    const text = view.data;
    if (typeof text === 'string' && text !== '') this.heldByView.set(view, { path, text });
  }

  private closed(held: { path: string; text: string }): void {
    const now = Date.now();
    const list = (this.closedHeld.get(held.path) ?? []).filter((c) => now - c.at <= CLOSED_HELD_MS && c.text !== held.text);
    list.push({ text: held.text, at: now });
    this.closedHeld.set(held.path, list);
  }

  /**
   * The base a save of `path` is read in against, with each part but the
   * elements — the note above the drawing, each shared setting, each embedded
   * link, the scene's shared keys — taken from the save itself where the save holds
   * what a view of the drawing closed in the last `CLOSED_HELD_MS` held and
   * the base holds something else. Such a part is not an edit: it is what
   * that view was showing when it closed, saved on its way out, after a
   * remote change to that part had been written to the file it no longer
   * showed. Diffed against the base, it reverted the remote change in every
   * vault, with no copy, bound or not, and the reopened view loaded the
   * revert from the file too (NEC-235). Elements need none of this: they are
   * judged by version (`verifiedBase`).
   *
   * Only closed views count. An open view that missed a write is the guard's
   * to repair, and one that loaded it holds the write's values. And a part
   * this vault has since changed by a save read in is that view's no longer:
   * set back to what the view held — an undo — it is an edit (found in
   * review). Returns the
   * parts it passed over, for the log and the backup the caller keeps.
   */
  restBase(path: string, saved: unknown, base: unknown): { base: unknown; passedOver: string[]; keep: boolean } {
    const save = saved as ExcalidrawValue;
    const was = base as ExcalidrawValue | null;
    if (!was || !Array.isArray(save?.elements) || !Array.isArray(was.elements)) return { base, passedOver: [], keep: false };
    this.watch();
    const now = Date.now();
    const list = (this.closedHeld.get(path) ?? []).filter((c) => now - c.at <= CLOSED_HELD_MS);
    if (list.length === 0) {
      this.closedHeld.delete(path);
      return { base, passedOver: [], keep: false };
    }
    this.closedHeld.set(path, list);
    for (const c of list) {
      if (c.value !== undefined) continue;
      const parsed = excalidrawCodec.parse(c.text);
      c.value = parsed.ok ? (parsed.value as ExcalidrawValue) : null;
    }
    const same = (a: unknown, b: unknown): boolean => canonical(a ?? null) === canonical(b ?? null);
    // Only what the document shares: a file holds every app-state key — the
    // theme, the scroll, the zoom — and the document only the shared ones, so
    // the rest differ from any base, always, and are never read in anyway.
    const slots: Array<{ name: string; part: 'head' | 'appState' | 'embedded' | 'scene'; key?: string }> = [{ name: 'head', part: 'head' }];
    for (const key of SHARED_APP_STATE) slots.push({ name: `appState.${key}`, part: 'appState', key });
    for (const key of new Set([...Object.keys(save.embedded ?? {}), ...Object.keys(was.embedded ?? {})])) slots.push({ name: `embedded.${key}`, part: 'embedded', key });
    for (const key of SHARED_SCENE_KEYS) slots.push({ name: `scene.${key}`, part: 'scene', key });
    const get = (v: ExcalidrawValue, slot: (typeof slots)[number]): unknown =>
      slot.key === undefined ? v.head : (v[slot.part as 'appState'] as Record<string, unknown> | undefined)?.[slot.key];
    const out = { head: was.head, appState: { ...was.appState }, embedded: { ...was.embedded }, scene: { ...was.scene } };
    const passedOver: string[] = [];
    /** The closed views whose record a part was passed over for, and whether any part was more than a link the save lacks. */
    const matched = new Set<(typeof list)[number]>();
    let more = false;
    for (const slot of slots) {
      const theirs = get(save, slot);
      if (same(theirs, get(was, slot))) continue;
      const matches = list.filter((c) => c.value && !c.dropped?.has(slot.name) && same(get(c.value, slot), theirs));
      if (matches.length === 0) {
        // A change of this vault's own, read in: whatever a closed view held
        // there is behind it now. Set back later — an undo — it is an edit
        // too, not that view's, so its record of this part goes.
        for (const c of list) (c.dropped ??= new Set()).add(slot.name);
        continue;
      }
      if (slot.key === undefined) out.head = theirs as string;
      else {
        const into = out[slot.part as 'appState'];
        if (theirs === undefined) delete into[slot.key];
        else into[slot.key] = theirs;
      }
      passedOver.push(slot.name);
      for (const c of matches) matched.add(c);
      if (slot.part !== 'embedded' || theirs !== undefined) more = true;
    }
    if (passedOver.length === 0) return { base, passedOver, keep: false };
    // A backup once per closed view, and none for a save that only lacks
    // links: a tab switched away and back closes the drawing every time, and
    // kept a copy of every save it made after (the hardness run: some 80 in
    // 25 minutes). A link a save lacks was never removed by anyone; the image
    // it names is an element, judged by version. The user chose this (NEC-235).
    const keep = more && [...matched].some((c) => !c.kept);
    if (keep) for (const c of matched) c.kept = true;
    log.warn('A drawing\'s save held what a view of it showed as it closed, where the document has since changed; read those parts in as unchanged', {
      path, parts: passedOver.slice(0, 10), count: passedOver.length,
    });
    return { base: { ...was, ...out }, passedOver, keep };
  }

  /**
   * Per element id, the `version:versionNonce` pairs `view` showed for
   * `path`, oldest first, in the order it showed them (see `historyByView`).
   * Read-only; undefined when it showed none.
   */
  historyOf(view: ExcalidrawViewLike, path: string): ReadonlyMap<string, readonly string[]> | undefined {
    return this.historyByView.get(view)?.get(path);
  }

  /** Drop the record of a delete the document has reached. */
  forget(path: string, id: string): void {
    this.drop(path, id);
  }

  /** Drop a delete from the record, here and in storage. */
  private drop(path: string, id: string): void {
    this.restoredIds.get(path)?.delete(id);
    if (this.seen.get(path)?.delete(id) === true) this.changed();
  }

  /** What was seen deleted in `path` that `present` (by id) does not hold. */
  deletedBesides(path: string, present: ReadonlySet<string>): SceneElement[] {
    const seen = this.seen.get(path);
    return seen ? [...seen.values()].filter((e) => !present.has(e.id)) : [];
  }

  /**
   * A save of `path`, with the deletes its open drawing made that it left out.
   * `settled`: whether the document has had its first sync. Until it has, an
   * element it lacks may be one it has not heard of yet, and a delete read
   * back from storage is kept rather than dropped for it.
   */
  withViewDeletes(path: string, saved: unknown, current: unknown, settled = true): unknown {
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
      if (standing === undefined && !settled && this.restoredIds.get(path)?.has(id) === true) continue;
      if (standing === undefined || standing >= e.version) this.drop(path, id);
      else if (!inSave.has(id)) added.push(e);
    }
    log.debug('Asked what open drawings deleted', { path, recorded: seen.size, added: added.length });
    if (added.length === 0) return saved;
    log.info('Read in deletes an open drawing made that its save left out', { path, ids: added.slice(0, 5).map((e) => e.id), count: added.length });
    return { ...save, elements: [...save.elements, ...added] };
  }

  /**
   * What views of `path` were seen to hold that `current`, the document, has
   * never had — open views or gone ones, by the document's own revisions
   * (`versionsKnown` of `ydoc`, its document) — split by how it goes in:
   *
   * - `ahead`: a version above the document's standing one. Made on the
   *   standing one (`on`), it supersedes it; made on anything else, the
   *   standing one was never seen by whoever made it, and stands beside it.
   * - `rivals`: a version at or below the standing one, which reached no
   *   document: an edit made while another vault's edit of the same shape
   *   arrived first. Read in with no base, as a rival, so settle decides, and
   *   keeps the loser as SAFE-A27 does for any concurrent edit. Dropped
   *   instead, it was lost with no copy (found in review).
   *
   * A version the document has had is done with: delivered, or decided. An
   * element the document lacks goes in only if it is not deleted and its scene
   * shared an element with the document (a scene of one shape cannot say, and
   * goes in). An image whose file the document lacks waits for a save that
   * carries the file.
   */
  recordedAhead(path: string, current: unknown, ydoc?: Y.Doc): { ahead: Drawn[]; rivals: Drawn[] } {
    const known = ydoc ? versionsKnown(ydoc) : new Map<string, Set<string>>();
    const out = { ahead: [] as Drawn[], rivals: [] as Drawn[] };
    const now = current as ExcalidrawValue;
    if (!Array.isArray(now?.elements)) return out;
    // What the views show now too, in case a change has not been reported yet.
    this.watch();
    for (const view of this.views()) if (view.file?.path === path) this.note(view);
    const drawn = this.drawn.get(path);
    if (!drawn) return out;
    const standing = new Map(now.elements.map((e) => [e.id, e]));
    for (const [id, d] of drawn) {
      if (d.done) continue;
      const { element } = d;
      const pair = `${element.version}:${element.versionNonce}`;
      const doc = standing.get(id);
      if ((doc && `${doc.version}:${doc.versionNonce}` === pair) || known.get(id)?.has(pair) === true) {
        d.done = true;
        // A delete the document has had: delivered, so its record goes too.
        // Kept, one that synced before a quit came back on every launch after.
        if (element.isDeleted === true && this.seen.get(path)?.get(id)?.version === element.version) this.drop(path, id);
        continue;
      }
      if (doc === undefined) {
        if (element.isDeleted === true || (standing.size > 0 && d.peers.length > 0 && !d.peers.some((p) => standing.has(p)))) {
          d.done = true;
          continue;
        }
        const fileId = (element as { fileId?: unknown }).fileId;
        if (element.type === 'image' && typeof fileId === 'string' && !(fileId in (now.files ?? {})) && !(fileId in (now.embedded ?? {}))) continue;
        out.ahead.push(d);
      } else if (element.version > doc.version) {
        out.ahead.push(d);
      } else {
        out.rivals.push(d);
      }
    }
    return out;
  }

  /** Whether views of `path` held anything its document never had (`recordedAhead`); only looks. */
  holdsRecordedAhead(path: string, current: unknown, ydoc?: Y.Doc): boolean {
    const { ahead, rivals } = this.recordedAhead(path, current, ydoc);
    return ahead.length > 0 || rivals.length > 0;
  }

  /**
   * What to read into the document for what views of `path` held that it
   * never had (`recordedAhead`): `current` with it put in, and the base to
   * read it against — the document itself, not a save, whose base can already
   * hold the edit and hide it (NEC-238). Null when there is nothing. Each
   * version is handed out once: read in, the document has it.
   */
  withRecordedAhead(path: string, current: unknown, ydoc?: Y.Doc): { value: unknown; base: unknown } | null {
    const { ahead, rivals } = this.recordedAhead(path, current, ydoc);
    if (ahead.length === 0 && rivals.length === 0) return null;
    const now = current as ExcalidrawValue;
    const put = new Map([...ahead, ...rivals].map((d) => [d.element.id, d.element]));
    const madeOn = new Map(ahead.map((d) => [d.element.id, d.on]));
    const rivalIds = new Set(rivals.map((d) => d.element.id));
    const elements = now.elements.map((e) => put.get(e.id) ?? e);
    const have = new Set(now.elements.map((e) => e.id));
    for (const [id, e] of put) if (!have.has(id)) elements.push(e);
    const base = now.elements
      .filter((e) => !rivalIds.has(e.id))
      .map((e) => (madeOn.has(e.id) && madeOn.get(e.id) !== `${e.version}:${e.versionNonce}` ? unverified(e) : e));
    for (const d of [...ahead, ...rivals]) d.done = true;
    // A delete read in is in the document now: its record is done with.
    for (const d of [...ahead, ...rivals]) {
      if (d.element.isDeleted === true && this.seen.get(path)?.get(d.element.id)?.version === d.element.version) this.drop(path, d.element.id);
    }
    log.debug('Open drawings held versions their document never had, which no save carried', {
      path, ahead: ahead.slice(0, 5).map((d) => `${d.element.id}@${d.element.version} on ${d.on ?? 'none'}`), rivals: rivals.slice(0, 5).map((d) => `${d.element.id}@${d.element.version}`),
    });
    return { value: { ...now, elements }, base: { ...now, elements: base } };
  }

  /**
   * The base a save of `path` may be read in against: `base` without the
   * elements no view was seen to show, where the save supersedes them.
   *
   * `applyExcalidraw` removes a base version the save is newer than, as
   * superseded by someone who saw it. That holds only if the save was built on
   * it. A version an open view was seen to show, it may have been; one it
   * never showed, it was not — the view built on what it held before, and the
   * version is a remote edit it never saw. Marked `unverified` in the base,
   * it is neither removed nor named as what the save's version was made on,
   * both stand, and settle keeps the loser by its author: at worst a copy,
   * never a loss. Its content stays, for judging what the save changed.
   *
   * Which view saved is not known, so a version counts as shown only when
   * every view of the file open now showed it — two views of one drawing, one
   * of which missed the write, are each a possible author — or, with none
   * open, when any view of it did.
   *
   * Trusted as it is when no view of the file has been seen this session and
   * the base is this session's own agreed text: the file is what we wrote, and
   * whatever edited it read that. Not when it is the last session's record
   * (`fromRecord`), which a view's save on close can have overtaken.
   *
   * A base element the save is older than, or has not moved past, is kept:
   * stale-save refusal and the unchanged check need it.
   */
  verifiedBase(path: string, saved: unknown, base: unknown, fromRecord: boolean): unknown {
    const save = saved as ExcalidrawValue;
    const was = base as ExcalidrawValue;
    if (!Array.isArray(save?.elements) || !Array.isArray(was?.elements)) return base;
    this.watch();
    for (const view of this.views()) if (view.file?.path === path) this.note(view);
    const anyView = this.shownByPath.get(path);
    if (!anyView && !fromRecord) return base;
    // Shown by every view of the file open now, since any of them may have
    // made the save; with none open, by any view that was.
    const open = this.views().filter((v) => v.file?.path === path).map((v) => this.shownByView.get(v)?.get(path));
    const wasShown = (id: string, pair: string): boolean => {
      if (open.length > 0) return open.every((r) => r?.get(id)?.includes(pair) === true);
      return anyView?.get(id)?.includes(pair) === true;
    };
    // A delete read back from before a restart says which version it was
    // made on, and so which version a save holding that delete was built on:
    // no view this session showed it, since the view that made it is gone.
    // Taken as unverified, the shape the user deleted came back beside the
    // delete as a kept copy (NEC-211, found by its e2e case: Excalidraw
    // 2.28.1 wrote the delete into the file rather than leaving it out).
    const restored = this.drawn.get(path);
    const madeOn = (id: string, pair: string, saved: SceneElement): boolean => {
      const d = restored?.get(id);
      return d?.restored === true && d.on === pair && d.element.version === saved.version && d.element.versionNonce === saved.versionNonce;
    };
    const inSave = new Map(save.elements.map((e) => [e.id, e]));
    const dropped: string[] = [];
    const elements = was.elements.map((e) => {
      const saved = inSave.get(e.id);
      const version = saved?.version;
      if (saved === undefined || version === undefined || version <= e.version) return e;
      if (wasShown(e.id, `${e.version}:${e.versionNonce}`)) return e;
      if (madeOn(e.id, `${e.version}:${e.versionNonce}`, saved)) return e;
      dropped.push(`${e.id}@${e.version}:${e.versionNonce} shown ${open.length > 0 ? open.map((r) => (r?.get(e.id) ?? []).join(',')).join(' | ') : 'by no open view'}`);
      return unverified(e);
    });
    if (dropped.length === 0) return base;
    log.info('Read a save in against base versions no open view was seen to show, as built on none of them; settle keeps them if they lose', {
      path, fromRecord, count: dropped.length, first: dropped.slice(0, 5),
    });
    return { ...was, elements };
  }

  /**
   * Save every open view of `path` whose scene is ahead of `current`, the
   * document: an element at a higher version than the document's standing
   * one, or one the document lacks, deleted or not. Forced, since the view's
   * own flag is what failed: a drawing edited while a save was in flight
   * cleared it, said it had nothing to save, and the write that followed took
   * the edit from under it (NEC-228, hardness seed 212003). Its save is then
   * read in like any other.
   */
  async saveViewsAhead(path: string, current: unknown): Promise<void> {
    const now = current as ExcalidrawValue;
    if (!Array.isArray(now?.elements)) return;
    const standing = new Map(now.elements.map((e) => [e.id, e]));
    for (const view of this.views()) {
      if (view.file?.path !== path) continue;
      const scene = view.excalidrawAPI?.getSceneElementsIncludingDeleted() ?? [];
      // Another drawing's scene under this path — a tab reused for this file,
      // before its scene loads — shares no element with the document. Forced,
      // its save would carry the old drawing in; and `isAnotherDrawing` says
      // no when every shape here is deleted, so ask the ids directly (found in
      // review). A document with no element yet cannot tell, and is saved.
      if (standing.size > 0 && scene.length > 0 && !scene.some((e) => standing.has(e.id))) continue;
      // Higher than the document's, and not forced before. Not a rival of the
      // same number: that is usually a loser the view has not reloaded, and
      // forced, it was put back as a new write on every write after — a copy,
      // a copy of the copy, and a view that never showed the winner (the e2e
      // soak, 11 runs in 20, PR #266). And once per version, so that a view
      // that never reloads cannot be saved for ever.
      const forced = this.forced.get(path) ?? new Set<string>();
      const ahead = scene.filter((e) => {
        if (forced.has(`${e.id}@${e.version}:${e.versionNonce}`)) return false;
        const doc = standing.get(e.id);
        if (doc === undefined) return e.isDeleted !== true;
        return e.version > doc.version;
      });
      if (ahead.length === 0) continue;
      for (const e of ahead) forced.add(`${e.id}@${e.version}:${e.versionNonce}`);
      this.forced.set(path, forced);
      log.info('An open drawing holds versions its document lacks; saving it before the write, whatever it says of unsaved work', {
        path, count: ahead.length, first: ahead.slice(0, 5).map((e) => `${e.id}@${e.version}`), dirty: view.isDirty?.(),
      });
      await view.save(true, true);
    }
  }

  /**
   * The base a view's save of `path` is read in against, when every open view
   * of it showed what our write `written` brought that `prior` — what the
   * views held before it — lacked: the write's elements, and `prior` for the
   * rest. Null when it cannot tell, and the guard's base, `prior`, stands.
   *
   * `TextViewGuard` asks a view's `data` instead, which a drawing's view does
   * not update when it reloads its scene, so for a few seconds after every
   * write it took a view that had reloaded for one that had not, and its save
   * was read in against the text before the write: the remote version the
   * write brought was then superseded by nobody, and its author kept a copy of
   * an edit the user had seen and drawn over (NEC-226, found by NEC-212's e2e
   * case).
   *
   * Only elements can be seen in a scene, so only they are taken from the
   * write. If the writes since `prior` also changed the note above the
   * drawing, its settings, its files or the scene, nothing here says the view
   * loaded those, and reading its save against the write's would revert
   * them, for every vault, with no copy kept: two writes inside the guard's
   * window, the first drawn and the second missed, did exactly that (found in
   * review). Against `prior`'s, the save changed nothing there, and the write
   * stands. This used to refuse outright instead, and so refused nearly every
   * write between two Excalidraw releases: the newer one fills in grid
   * settings the older one's file lacks, and the copy that cost was kept of
   * an edit drawn over in plain sight (NEC-231).
   */
  loadedBase(path: string, written: unknown, prior: unknown): unknown {
    const now = written as ExcalidrawValue;
    const before = prior as ExcalidrawValue;
    if (!Array.isArray(now?.elements) || !Array.isArray(before?.elements)) return null;
    // Each "no" says why in the log: which of these decided it is what tells
    // a view that missed the write from one this check misjudged (NEC-231).
    const no = (why: string, more: Record<string, unknown> = {}): null => {
      log.debug('Could not tell that the open drawing showed the last write', { path, why, ...more });
      return null;
    };
    const had = new Set(before.elements.map((e) => `${e.id}@${e.version}:${e.versionNonce}`));
    // Live ones only: a view drops a deleted element from its scene as it loads.
    const brought = now.elements.filter((e) => e.isDeleted !== true && !had.has(`${e.id}@${e.version}:${e.versionNonce}`));
    if (brought.length === 0) return no('the writes brought no element version');
    this.watch();
    const views = this.views().filter((v) => v.file?.path === path);
    if (views.length === 0) return no('no view of it is open');
    for (const view of views) this.note(view);
    const unseen: string[] = [];
    for (const v of views) {
      const shown = this.shownByView.get(v)?.get(path);
      for (const e of brought) {
        if (shown?.get(e.id)?.includes(`${e.version}:${e.versionNonce}`) !== true) {
          unseen.push(`${e.id}@${e.version}:${e.versionNonce} shown ${(shown?.get(e.id) ?? []).join(',') || 'none'}`);
        }
      }
    }
    if (unseen.length > 0) return no('a view was not seen to show a version the writes brought', { views: views.length, first: unseen.slice(0, 5) });
    if (!excalidrawCodec.equal({ ...now, elements: [] }, { ...before, elements: [] })) {
      log.debug('The writes the open drawing showed changed more than elements; those are read against what it held', {
        path, differ: differing(now, before),
      });
    }
    return { ...before, elements: now.elements };
  }

  dispose(): void {
    // What changed since the last write is written before the record is let
    // go, not cleared with it: an unload is how a quit reaches here.
    if (this.loaded && this.dirty) this.flush();
    this.disposed = true;
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
    this.restoredIds.clear();
    this.shownByView = new WeakMap();
    this.historyByView = new WeakMap();
    this.shownByPath.clear();
    this.forced.clear();
    this.heldByView.clear();
    this.closedHeld.clear();
    this.drawn.clear();
    this.showing.clear();
  }
}

/**
 * Where two drawings differ outside their elements, down to a key inside each
 * part, `appState` above all, whose keys are as much a release's defaults as
 * anyone's edit: for the log.
 */
function differing(now: ExcalidrawValue, before: ExcalidrawValue): string[] {
  const keys = (a: unknown, b: unknown, at: string): string[] => {
    if (canonical(a) === canonical(b)) return [];
    const objs = a !== null && b !== null && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b);
    if (!objs || at.includes('.')) return [`${at}: ${b === undefined ? 'absent' : canonical(b)} before, ${a === undefined ? 'absent' : canonical(a)} written`];
    const x = a as Record<string, unknown>;
    const y = b as Record<string, unknown>;
    return Object.keys({ ...x, ...y }).flatMap((k) => keys(x[k], y[k], `${at}.${k}`));
  };
  const x = now as unknown as Record<string, unknown>;
  const y = before as unknown as Record<string, unknown>;
  return Object.keys({ ...x, ...y }).filter((k) => k !== 'elements').flatMap((k) => keys(x[k], y[k], k));
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

/** How long an open drawing waits to be bound before the log says it still is. */
const STILL_WAITING_MS = 5000;

/** Binds every open drawing it can, and lets go of the rest. */
export class ExcalidrawLiveManager {
  private bindings = new Map<ExcalidrawViewLike, ExcalidrawLiveBinding>();
  private brokenViews = new WeakMap<ExcalidrawViewLike, string>();
  private pending = new Set<ExcalidrawViewLike>();
  /** Views tried and not bound yet: since when, how often, and the last reason logged. */
  private waiting = new WeakMap<ExcalidrawViewLike, { path: string; since: number; attempts: number; last: string; told?: boolean }>();
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
  withViewDeletes(path: string, saved: unknown, current: unknown, settled = true): unknown {
    return this.witness.withViewDeletes(path, saved, current, settled);
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
    // Keyed by view, and a view is reused when its tab opens another drawing:
    // a wait for another path is a new wait, or the new drawing would inherit
    // the old one's time and its "still not bound" line.
    const prior = this.waiting.get(view);
    const wait = prior?.path === path ? prior : { path, since: Date.now(), attempts: 0, last: '' };
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
        // The line above is once per reason, so a view refused for the same
        // reason for good — one whose Excalidraw never finished loading, say —
        // went silent after its first attempt, and its log read as though the
        // manager had stopped trying (NEC-244). Once per wait, say it is still
        // waiting.
        const waited = Date.now() - wait.since;
        if (!wait.told && waited >= STILL_WAITING_MS) {
          wait.told = true;
          log.info('An open drawing is still not bound live', {
            path, ms: waited, attempts: wait.attempts, lastRefusal: wait.last,
          });
        }
      }
      if (result === 'bound') {
        // The wait ends here either way: bound, or let go because sync was
        // turned off or the manager went meanwhile.
        this.waiting.delete(view);
        if (this.disposed || this.bindings.has(view) || !this.deps.enabled()) {
          binding.detach();
          return;
        }
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
