import type * as Y from 'yjs';
import type { Awareness } from 'y-protocols/awareness';
import { canvasCodec } from './canvas-codec';
import {
  applyCanvas, canonical, normaliseCanvas, normaliseJson, observeCanvas, readCanvas, ROOT_TEXTS,
  type CanvasRecord, type CanvasValue,
} from './canvas-model';
import {
  checkCanvasShape, OBSIDIAN_CANVAS_READ_AGAINST,
  type CanvasData, type CanvasLike, type CanvasNodeLike, type CanvasViewInternal,
} from './canvas-internals';
import type { BindResult, BoundView, StructuredSync } from './structured-sync';
import { log } from './logger';

/**
 * A canvas open in a view, bound live to its document (SAFE-A20).
 *
 * Over disk (canvas-view-guard.ts), an open canvas sees another vault's change
 * only when Obsidian reloads the file — a couple of seconds late, re-rendering
 * the card being typed in, and pushing an undo step that reverts the peer's
 * change. Bound, the view is the file's only writer and the document talks to
 * it directly:
 *
 * - **Out.** Every way an edit leaves the view — `canvas.requestSave`,
 *   `canvas.applyHistory` (undo and redo, which skip `requestSave`), and
 *   `view.setViewData(_, false)` (a change Obsidian loaded from disk) — is
 *   wrapped, and what the view holds is diffed against `held`, what it held
 *   last time, into the document. Never against the document: that may hold
 *   remote changes the view has not drawn, and their absence would read as
 *   the user reverting them.
 * - **In.** A remote change is drawn by record and by field, never by
 *   re-importing the board — so a card being typed in is not re-rendered and a
 *   node being dragged does not jump.
 *
 * What went wrong elsewhere, and is ruled out here, with the test that holds
 * each (canvas-live.test.ts):
 *
 * - A card whose editor is open is never given text through `setText`, which
 *   the editor binding would read as typing and insert again (Relay 262604f0).
 *   Its `text` is assigned directly; the editor itself is kept in step by
 *   canvas-card-binding.ts.
 * - Drawing a remote change never writes to the document. A "repair" written
 *   back on each remote apply is how Excalidraw's own edits came to beat real
 *   ones (Excalidraw #11933). Rounding settles in the view.
 * - While the user drags or resizes, a remote change's position and size wait
 *   for the gesture to end — other fields do not — and are then read afresh
 *   from the document, not replayed.
 * - Undo steps back only this user's edits: a remote change is written into
 *   every snapshot of Obsidian's history, field by field, and a node a peer
 *   deleted leaves them all, so undo can neither revert a peer nor revive what
 *   they deleted (tldraw #10024).
 * - A view is bound only while it shows this file — Obsidian reuses views
 *   across files, and a copied canvas shares ids (Relay 61441033) — and never
 *   from an empty or unconfirmed document (Relay 4261d1b9).
 * - Remote changes are drawn from a microtask, never an animation frame, which
 *   a hidden pane never gets (tldraw #10679).
 *
 * Any internal missing, or any hook throwing, unbinds the view and leaves it
 * on the disk path — with a notice, never silently.
 */

const GEOMETRY = ['x', 'y', 'width', 'height'] as const;
/** The origin of an outside change to a live card's text, merged in on reload. */
const EXTERNAL = { name: 'canvas-live-external' };
/** How many recent `held` values a save is recognised against. See BoundView.holds. */
const HELD_HISTORY = 32;
const WRAPPED = Symbol('nectenda-canvas-live');

type Wrapped<F> = F & { [WRAPPED]?: CanvasLiveBinding };

/** The live binding for each bound canvas, for the card editor binding to find. */
const bindings = new WeakMap<CanvasLike, CanvasLiveBinding>();
/** Bound views by document: one file open in two panes is two bindings. */
const byDoc = new Map<string, Set<CanvasLiveBinding>>();

export function bindingForCanvas(canvas: unknown): CanvasLiveBinding | null {
  if (typeof canvas !== 'object' || canvas === null) return null;
  return bindings.get(canvas as CanvasLike) ?? null;
}

export interface CanvasLiveDeps {
  structured: Pick<StructuredSync, 'acquireDoc' | 'releaseDoc' | 'bindView' | 'unbindView' | 'docNameFor' | 'agreedText'>;
  /** The file as it is on disk, or null when there is none. */
  readFile(path: string): Promise<string | null>;
  /** A binding gave up and left its canvas on the disk path. */
  fellBack(path: string, reason: string): void;
  /** Obsidian's version, logged when it is not the one the internals were read against. */
  obsidianVersion?: string;
}

export type AttachResult = BindResult | 'not-owned' | 'broken';

/** What a remote change asks of the view. */
interface DrawPlan {
  upsertNodes: CanvasRecord[];
  upsertEdges: CanvasRecord[];
  removeNodes: string[];
  removeEdges: string[];
  /** Per record id, the fields that changed: value, or undefined for removed. */
  nodeFields: Map<string, Record<string, unknown>>;
  edgeFields: Map<string, Record<string, unknown>>;
  addedNodes: Map<string, CanvasRecord>;
  addedEdges: Map<string, CanvasRecord>;
  extra: Record<string, unknown>;
  extraChanged: boolean;
  reorder: boolean;
}

const same = (a: unknown, b: unknown): boolean => canonical(a) === canonical(b);

/** What a canvas view shows, as a canvas value. */
export function valueOfCanvas(canvas: CanvasLike): CanvasValue {
  const data = canvas.getData();
  const extra: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) if (k !== 'nodes' && k !== 'edges') extra[k] = v;
  return normaliseCanvas({
    nodes: (data.nodes ?? []) as CanvasRecord[],
    edges: (data.edges ?? []) as CanvasRecord[],
    extra,
  });
}

const isEmpty = (v: CanvasValue): boolean => v.nodes.length === 0 && v.edges.length === 0;

export class CanvasLiveBinding implements BoundView {
  private docName: string | null = null;
  private ydoc: Y.Doc | null = null;
  awareness: Awareness | null = null;
  private held: CanvasValue = { nodes: [], edges: [], extra: {} };
  private recent: CanvasValue[] = [];
  /** Outside writes merged in on reload: their file is an echo when StructuredSync reads it. */
  private outside: CanvasValue[] = [];
  private bound = false;
  private applying = false;
  private applyPending = false;
  private gesture = false;
  /** A remote change was drawn during a gesture and not saved yet. */
  private saveOwed = false;
  private unobserve: (() => void) | null = null;
  private restore: (() => void)[] = [];
  /** Cards whose editor canvas-card-binding.ts has bound to their Y.Text. */
  readonly liveCards = new Set<string>();
  /**
   * Those card editors' root elements. Each card editor ends up in an iframe
   * of its own, whose mouse events never reach the canvas, so presence
   * listens there too (canvas-presence.ts). The element is kept rather than
   * its document: Obsidian builds the editor in the canvas's document and
   * moves it into the frame once the frame loads, after the editor has bound.
   */
  private cardEditors = new Set<{ ownerDocument: Document }>();
  private listeners = new Set<() => void>();

  constructor(
    readonly view: CanvasViewInternal,
    readonly path: string,
    private deps: CanvasLiveDeps,
  ) {}

  get canvas(): CanvasLike {
    return this.view.canvas;
  }

  isBound(): boolean {
    return this.bound;
  }

  /** The documents the card editors bound here are in now, other than the canvas's own. */
  cardFrames(): Document[] {
    const own = this.canvas.wrapperEl.ownerDocument;
    const docs = new Set<Document>();
    for (const el of this.cardEditors) if (el.ownerDocument !== own) docs.add(el.ownerDocument);
    return [...docs];
  }

  /**
   * A card editor, by its root element, bound (true) or let go (false). Told
   * to listeners on a microtask: this is called from inside CodeMirror's
   * update and destroy, where a listener that dispatches would throw.
   */
  cardEditor(el: { ownerDocument: Document }, bound: boolean): void {
    if (bound === this.cardEditors.has(el)) return;
    if (bound) this.cardEditors.add(el);
    else this.cardEditors.delete(el);
    queueMicrotask(() => this.emit());
  }

  /** Called whenever something of interest happened, for presence to redraw. */
  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /**
   * Take the view over, if it shows this file and the document is ready.
   * Anything short of `bound` leaves the file on the disk path, and the
   * manager tries again later.
   */
  async attach(): Promise<AttachResult> {
    const missing = checkCanvasShape(this.view);
    if (missing) {
      this.deps.fellBack(this.path, `Obsidian's canvas no longer has ${missing}`);
      return 'broken';
    }
    if (this.view.file?.path !== this.path) return 'not-owned';
    const docName = this.deps.structured.docNameFor(this.path);
    if (!docName) return 'unknown';

    // An edit waiting for the view's 2 s save is written out first, so the
    // file and the view agree before either is compared.
    if (this.view.dirty) await this.view.save();
    if (this.view.file?.path !== this.path) return 'not-owned';

    const held = this.deps.structured.acquireDoc(docName);
    if (!held) return 'unknown';
    const diskText = await this.deps.readFile(this.path);
    // What the view shows is read after the await, never before: an edit made
    // while the file was being read would otherwise be neither in `shown` nor
    // in `held`, and the first remote change drawn would overwrite it.
    const shown = valueOfCanvas(this.canvas);
    const disk = diskText === null || diskText.trim() === '' ? null : canvasCodec.parse(diskText);
    const diskValue = disk?.ok ? disk.value : null;
    const docValue = readCanvas(held.ydoc);
    // The view shows this file when it equals the file or the document. An
    // empty view over a file with content is a load still in progress, never
    // a canvas someone emptied; a view of another file fails both.
    const owned = this.view.file?.path === this.path
      && !(isEmpty(shown) && diskValue !== null && !isEmpty(diskValue as CanvasValue))
      && ((diskValue !== null && canvasCodec.equal(shown, diskValue)) || canvasCodec.equal(shown, docValue));
    if (!owned) {
      this.deps.structured.releaseDoc(docName);
      return 'not-owned';
    }
    const result = this.deps.structured.bindView(docName, this, shown);
    if (result !== 'bound') {
      this.deps.structured.releaseDoc(docName);
      return result;
    }
    this.docName = docName;
    this.ydoc = held.ydoc;
    this.awareness = held.awareness;
    this.setHeld(shown);
    this.bound = true;
    bindings.set(this.canvas, this);
    let siblings = byDoc.get(docName);
    if (!siblings) byDoc.set(docName, (siblings = new Set()));
    siblings.add(this);
    if (this.deps.obsidianVersion && this.deps.obsidianVersion !== OBSIDIAN_CANVAS_READ_AGAINST) {
      log.info('A live canvas is running on an Obsidian its internals were not read against', {
        running: this.deps.obsidianVersion, readAgainst: OBSIDIAN_CANVAS_READ_AGAINST,
      });
    }
    try {
      this.install();
      // The document may hold remote changes the file has not received yet.
      this.applyRemoteNow();
    } catch (err) {
      this.fail(err);
      return 'broken';
    }
    log.debug('Bound an open canvas live', { path: this.path });
    return 'bound';
  }

  /** Let go: the view goes back to saving a file StructuredSync writes too. */
  detach(): void {
    if (!this.bound) return;
    this.bound = false;
    this.unobserve?.();
    this.unobserve = null;
    for (const r of this.restore.splice(0).reverse()) {
      try {
        r();
      } catch (err) {
        log.warn('Could not undo a live canvas hook', { path: this.path, error: String(err) });
      }
    }
    if (bindings.get(this.canvas) === this) bindings.delete(this.canvas);
    if (this.docName) {
      byDoc.get(this.docName)?.delete(this);
      this.deps.structured.releaseDoc(this.docName, this);
    }
    this.liveCards.clear();
    this.emit();
  }

  /** A card's text as the view has committed it — behind its open editor by up to 2 s. */
  nodeText(id: string): string | undefined {
    const text = this.canvas.nodes.get(id)?.text;
    return typeof text === 'string' ? text : undefined;
  }

  /** The card's Y.Text, for its editor binding. */
  cardText(id: string): Y.Text | null {
    return (this.ydoc?.getMap<Y.Text>(ROOT_TEXTS).get(id)) ?? null;
  }

  /** The document, for presence and the card binding. */
  doc(): Y.Doc | null {
    return this.ydoc;
  }

  isGesture(): boolean {
    return this.gesture;
  }

  /** A record as the view last committed it — for presence to tell a node mid-drag from one at rest. */
  heldNode(id: string): CanvasRecord | null {
    return this.held.nodes.find((n) => n.id === id) ?? null;
  }

  /** The document this binding is bound through. */
  boundDocName(): string | null {
    return this.docName;
  }

  /** The user typed in a card: activity, as far as presence is concerned. */
  touched(): void {
    this.emit();
  }

  // ── BoundView ────────────────────────────────────────────────────────────

  holds(value: unknown): boolean {
    return this.recent.some((v) => canvasCodec.equal(v, value)) || this.outside.some((v) => canvasCodec.equal(v, value));
  }

  baseFor(value: unknown): unknown {
    // The recent value it differs least from is the one it was built on.
    const v = value as CanvasValue;
    let best = this.held;
    let bestScore = Infinity;
    for (const r of this.recent) {
      const score = difference(r, v);
      if (score < bestScore) {
        best = r;
        bestScore = score;
      }
    }
    return best;
  }

  shownText(): string | null {
    if (!this.bound) return null;
    return canvasCodec.serialise(valueOfCanvas(this.canvas));
  }

  // ── Hooks ────────────────────────────────────────────────────────────────

  private install(): void {
    const canvas = this.canvas;
    const view = this.view;
    this.wrap(canvas, 'requestSave', (orig, binding) => function (this: CanvasLike, ...args: unknown[]) {
      const r = orig.apply(this, args);
      binding.safely(() => binding.capture());
      return r;
    });
    this.wrap(canvas, 'applyHistory', (orig, binding) => function (this: CanvasLike, ...args: unknown[]) {
      const r = orig.apply(this, args);
      binding.safely(() => binding.capture());
      return r;
    });
    this.wrap(view, 'setViewData', (orig, binding) => function (this: CanvasViewInternal, ...args: unknown[]) {
      const clear = args[1] === true;
      if (!clear && this.file?.path === binding.path && typeof args[0] === 'string') {
        // The file changed on disk while bound, and Obsidian is reloading it
        // (`TextFileView.onModify`). It is never loaded as it stands: the
        // file lags the view — the view saves 2 s after an edit, and remote
        // changes drawn since are not in it yet — so the view's state would
        // go back to the file's older one, and the difference would read as
        // this user reverting every change the file had not caught up with.
        // Through setText, it would also overwrite a card being typed in.
        //
        // - A save one of this document's bound views made (another pane of
        //   the same canvas) holds nothing the document lacks: ignored.
        // - Anything else is an outside write, handled like a remote change:
        //   diffed against the file it was made on, applied to the document,
        //   and drawn into the view by field.
        //
        // Now, synchronously: a flag left for later can outlive the load it
        // was for (Relay 98834ef9).
        const text = args[0];
        let handled = false;
        binding.safely(() => {
          binding.reloaded(text);
          handled = true;
        });
        // A binding that failed has let go: Obsidian loads the file as usual.
        if (handled) return undefined;
      }
      const r = orig.apply(this, args);
      if (clear || this.file?.path !== binding.path) {
        // A file (re)loaded into the view: another file, or this one from
        // scratch. Either way what it shows is not what the binding held; let
        // go, and the manager binds afresh once the view proves what it shows.
        binding.detach();
      }
      return r;
    });

    // The canvas may be in a popout window: listen on its own.
    const doc = canvas.wrapperEl.ownerDocument;
    const win = doc.defaultView ?? window;
    const down = (): void => {
      this.gesture = true;
    };
    const up = (): void => {
      if (!this.gesture) return;
      this.gesture = false;
      // After Obsidian's own pointerup handler, which commits the gesture
      // through requestSave; then what the gesture held back is read afresh.
      win.setTimeout(() => this.safely(() => this.gestureEnded()), 0);
    };
    const hidden = (): void => {
      if (doc.visibilityState === 'hidden') up();
    };
    canvas.wrapperEl.addEventListener('pointerdown', down, true);
    win.addEventListener('pointerup', up, true);
    win.addEventListener('pointercancel', up, true);
    win.addEventListener('blur', up);
    doc.addEventListener('visibilitychange', hidden);
    this.restore.push(() => {
      canvas.wrapperEl.removeEventListener('pointerdown', down, true);
      win.removeEventListener('pointerup', up, true);
      win.removeEventListener('pointercancel', up, true);
      win.removeEventListener('blur', up);
      doc.removeEventListener('visibilitychange', hidden);
    });

    const ydoc = this.ydoc as Y.Doc;
    this.unobserve = observeCanvas(ydoc, (_change, tr) => {
      if (tr.origin === this) return;
      this.schedule();
    });
  }

  /**
   * Replace `obj[key]` with a wrapper, once. A wrapper already there from this
   * binding is left alone rather than stacked; on detach the original goes
   * back only if ours is still the outermost, so a wrapper someone added
   * later is not torn off.
   */
  private wrap<T extends object, K extends keyof T & string>(
    obj: T,
    key: K,
    make: (orig: (...args: unknown[]) => unknown, binding: CanvasLiveBinding) => (...args: unknown[]) => unknown,
  ): void {
    const orig = obj[key] as unknown as Wrapped<(...args: unknown[]) => unknown>;
    if (orig[WRAPPED] === this) return;
    const wrapper = make(orig, this) as Wrapped<(...args: unknown[]) => unknown>;
    wrapper[WRAPPED] = this;
    (obj as Record<string, unknown>)[key] = wrapper;
    this.restore.push(() => {
      if ((obj as Record<string, unknown>)[key] === wrapper) (obj as Record<string, unknown>)[key] = orig;
    });
  }

  /** Run a hook's work; a throw unbinds the view rather than escaping into Obsidian. */
  safely(fn: () => void): void {
    if (!this.bound) return;
    try {
      fn();
    } catch (err) {
      this.fail(err);
    }
  }

  private fail(err: unknown): void {
    log.error('A live canvas hook failed; the canvas goes back to syncing over disk', {
      path: this.path, error: String(err),
    });
    this.detach();
    this.deps.fellBack(this.path, String(err));
  }

  /**
   * Obsidian is reloading the file into this view (see the `setViewData`
   * wrapper): it is merged in, never loaded over the view.
   *
   * A save one of this document's bound views made — another pane of the same
   * canvas — holds nothing the document lacks, and is ignored. (So is an
   * outside write that happens to restore a state a view held recently: the
   * view keeps more, not less, and saves it.)
   *
   * Anything else was written by something outside Obsidian, on top of the
   * file as it was — the text disk and document last agreed on, not what the
   * view holds now. It is diffed against that, applied to the document like a
   * remote change, and drawn into the view by field. A card being typed in
   * gets it through its Y.Text, never through `setText`.
   */
  reloaded(text: string): void {
    if (!this.ydoc || !this.docName) return;
    const parsed = canvasCodec.parse(text);
    if (!parsed.ok) {
      // Not loaded; StructuredSync reads the same file and keeps it aside (SAFE-A13).
      log.warn('An open canvas was changed on disk into something that is not a canvas; not loading it', {
        path: this.path, error: parsed.error,
      });
      return;
    }
    for (const b of byDoc.get(this.docName) ?? []) if (b.holds(parsed.value)) return;
    const agreed = this.deps.structured.agreedText(this.docName);
    const agreedValue = agreed === null ? null : canvasCodec.parse(agreed);
    const base = agreedValue?.ok ? agreedValue.value : this.held;
    log.info('An open canvas was changed outside Obsidian; merging the change in', { path: this.path });
    // Its save, read by StructuredSync in a moment, is then an echo.
    const value = parsed.value as CanvasValue;
    this.outside.push(value);
    if (this.outside.length > 8) this.outside.shift();
    const ydoc = this.ydoc;
    ydoc.transact(() => applyCanvas(ydoc, value, base as CanvasValue), EXTERNAL);
    this.applyRemoteNow();
  }

  // ── Out: the view's edits into the document ─────────────────────────────

  /**
   * The view committed something: carry what differs from `held` into the
   * document. Remote changes waiting to be drawn are drawn first, so `held`
   * is current and the diff is exactly the user's edit.
   */
  capture(): void {
    if (!this.bound || this.applying || !this.ydoc) return;
    if (this.applyPending) this.applyRemoteNow();
    const value = valueOfCanvas(this.canvas);
    // A card bound live has its text carried in by its editor binding as it
    // is typed; what the node says is that text arriving late. Taken from
    // `held` on both sides, so it is never applied a second time. And a node
    // whose text fell behind — an editor committing while remote typing was
    // queued behind an IME composition — is put right, so the view never
    // saves the older text: read in from the file, it would undo the typing.
    if (this.liveCards.size > 0) {
      const heldText = new Map(this.held.nodes.map((n) => [n.id, n.text]));
      let corrected = false;
      for (const n of value.nodes) {
        if (!this.liveCards.has(n.id) || !heldText.has(n.id)) continue;
        const t = heldText.get(n.id);
        if (typeof t === 'string' && n.text !== t) {
          const live = this.canvas.nodes.get(n.id);
          if (live) {
            live.text = t;
            corrected = true;
          }
        }
        if (t === undefined) delete n.text;
        else n.text = t;
      }
      if (corrected) this.canvas.data = this.canvas.getData();
    }
    if (canvasCodec.equal(value, this.held)) return;
    const ydoc = this.ydoc;
    const base = this.held;
    ydoc.transact(() => applyCanvas(ydoc, value, base), this);
    this.setHeld(value);
    this.emit();
  }

  // ── In: remote changes into the view ─────────────────────────────────────

  private schedule(): void {
    if (this.applyPending) return;
    this.applyPending = true;
    queueMicrotask(() => {
      if (this.applyPending) this.safely(() => this.applyRemoteNow());
    });
  }

  /** Draw what the document holds and the view does not. Writes nothing to the document. */
  applyRemoteNow(): void {
    this.applyPending = false;
    if (!this.bound || !this.ydoc) return;
    const canvas = this.canvas;
    const next = readCanvas(this.ydoc);
    const plan = planDraw(this.held, next, this.gesture ? liveGeometry(canvas) : null);
    if (!plan) return;

    this.applying = true;
    try {
      // A local edit's history push may still be waiting on its 250 ms
      // debounce; pushed now, it is in the stack when the stack is rebased.
      canvas.requestPushHistory?.run?.();

      // Only the fields that changed, laid over what the view has now — not
      // the document's whole record, which would overwrite any change the
      // view holds and has not committed yet (a colour picked a moment ago).
      const nodes = plan.upsertNodes.map((rec) => overlay(canvas.nodes.get(rec.id)?.getData(), rec, plan.nodeFields.get(rec.id)));
      const edges = plan.upsertEdges.map((rec) => overlay(canvas.edges.get(rec.id)?.getData(), rec, plan.edgeFields.get(rec.id)));
      for (const rec of nodes) {
        const node = canvas.nodes.get(rec.id);
        // Never setText into a card whose editor is open (Relay 262604f0):
        // with the text already there, importData's setText finds nothing to do.
        if (node?.isEditing && typeof rec.text === 'string' && node.text !== rec.text) node.text = rec.text;
      }
      if (nodes.length || edges.length) canvas.importData({ nodes, edges }, false);
      for (const id of plan.removeEdges) {
        const edge = canvas.edges.get(id);
        if (edge) canvas.removeEdge(edge);
      }
      for (const id of plan.removeNodes) {
        const node = canvas.nodes.get(id);
        if (node) canvas.removeNode(node);
      }
      if (plan.extraChanged) {
        for (const [k, v] of Object.entries(plan.extra)) {
          if (v === undefined) delete canvas.data[k];
          else canvas.data[k] = v;
        }
      }
      if (plan.reorder) restack(canvas, next.nodes);
      rebaseHistory(canvas, plan);

      this.setHeld(patchHeld(this.held, plan, canvas));
      // Saved as the user would save it, minus the history step: the file
      // follows the view, and the view is the file's only writer. Not in the
      // middle of a gesture, though: `canvas.data` would take the dragged
      // nodes where they are now, and a save of that — nobody's edit — would
      // reach the file. The gesture's end saves instead.
      if (this.gesture) this.saveOwed = true;
      else canvas.requestSave(false);
    } finally {
      this.applying = false;
    }
    this.emit();
  }

  /** Draw what the gesture held back, and save what was drawn during it. */
  private gestureEnded(): void {
    this.applyRemoteNow();
    if (!this.saveOwed || this.gesture || !this.bound) return;
    this.saveOwed = false;
    this.applying = true;
    try {
      this.canvas.requestSave(false);
    } finally {
      this.applying = false;
    }
  }

  private setHeld(value: CanvasValue): void {
    this.held = value;
    this.recent.push(value);
    if (this.recent.length > HELD_HISTORY) this.recent.shift();
  }

  private emit(): void {
    for (const cb of this.listeners) {
      try {
        cb();
      } catch (err) {
        log.warn('A live canvas listener failed', { error: String(err) });
      }
    }
  }
}

/** How many records two canvas values disagree on. */
function difference(a: CanvasValue, b: CanvasValue): number {
  let n = 0;
  for (const kind of ['nodes', 'edges'] as const) {
    const byId = new Map(a[kind].map((r) => [r.id, r]));
    const ids = new Set([...byId.keys(), ...b[kind].map((r) => r.id)]);
    const other = new Map(b[kind].map((r) => [r.id, r]));
    for (const id of ids) if (!same(byId.get(id), other.get(id))) n++;
  }
  return n;
}

/** Position and size of every node as the view has it right now, mid-gesture. */
function liveGeometry(canvas: CanvasLike): Map<string, Record<string, number>> {
  const out = new Map<string, Record<string, number>>();
  for (const [id, n] of canvas.nodes) out.set(id, { x: n.x, y: n.y, width: n.width, height: n.height });
  return out;
}

/**
 * What changed between what the view holds and what the document holds, by
 * record and by field. With `holdGeometry` (a gesture in progress), position
 * and size are held back for every node the view has: any of them may be
 * moving — a group drags its members — and a remote value drawn now would be
 * overwritten by the next pointer move anyway, or jump the node under the
 * pointer. Everything else is drawn now.
 */
export function planDraw(
  held: CanvasValue,
  next: CanvasValue,
  holdGeometry: Map<string, Record<string, number>> | null,
): DrawPlan | null {
  const plan: DrawPlan = {
    upsertNodes: [], upsertEdges: [], removeNodes: [], removeEdges: [],
    nodeFields: new Map(), edgeFields: new Map(), addedNodes: new Map(), addedEdges: new Map(),
    extra: {}, extraChanged: false, reorder: false,
  };
  const diffKind = (kind: 'nodes' | 'edges'): void => {
    const before = new Map(held[kind].map((r) => [r.id, r]));
    const after = new Map(next[kind].map((r) => [r.id, r]));
    const upsert = kind === 'nodes' ? plan.upsertNodes : plan.upsertEdges;
    const fieldsOut = kind === 'nodes' ? plan.nodeFields : plan.edgeFields;
    const added = kind === 'nodes' ? plan.addedNodes : plan.addedEdges;
    for (const [id, rec] of after) {
      const was = before.get(id);
      if (!was) {
        upsert.push(rec);
        added.set(id, rec);
        continue;
      }
      const live = kind === 'nodes' ? holdGeometry?.get(id) : undefined;
      const changed: Record<string, unknown> = {};
      for (const f of new Set([...Object.keys(was), ...Object.keys(rec)])) {
        if (live && (GEOMETRY as readonly string[]).includes(f)) continue;
        if (!same(was[f], rec[f])) changed[f] = rec[f];
      }
      if (Object.keys(changed).length === 0) continue;
      fieldsOut.set(id, changed);
      upsert.push(rec);
    }
    const removed = kind === 'nodes' ? plan.removeNodes : plan.removeEdges;
    for (const id of before.keys()) {
      if (after.has(id)) continue;
      // A node a peer removed while this user holds a gesture stays until it
      // ends: pulled from under the pointer, the gesture's work on it would be
      // gone. At the end it is read afresh — gone if the gesture left it as
      // it was, back (SAFE-A18) if the gesture moved it.
      if (kind === 'nodes' && holdGeometry?.has(id)) continue;
      removed.push(id);
    }
  };
  diffKind('nodes');
  diffKind('edges');
  for (const k of new Set([...Object.keys(held.extra), ...Object.keys(next.extra)])) {
    if (!same(held.extra[k], next.extra[k])) {
      plan.extra[k] = next.extra[k];
      plan.extraChanged = true;
    }
  }
  const heldOrder = held.nodes.map((n) => n.id).filter((id) => next.nodes.some((m) => m.id === id));
  const nextOrder = next.nodes.map((n) => n.id).filter((id) => held.nodes.some((m) => m.id === id));
  plan.reorder = plan.addedNodes.size > 0 || !same(heldOrder, nextOrder);
  const empty = !plan.upsertNodes.length && !plan.upsertEdges.length && !plan.removeNodes.length
    && !plan.removeEdges.length && !plan.extraChanged && !plan.reorder;
  return empty ? null : plan;
}

/**
 * Stack the view's nodes in the document's order. Obsidian orders nodes by
 * `zIndex`, and `updateZIndex` brings one to the front; so from the first node
 * out of place, each is brought to the front in turn. Groups sort by their
 * size, whatever their key, and are left to it.
 */
function restack(canvas: CanvasLike, order: CanvasRecord[]): void {
  const wanted = order
    .filter((r) => r.type !== 'group')
    .map((r) => canvas.nodes.get(r.id))
    .filter((n): n is CanvasNodeLike => n !== undefined);
  const current = [...wanted].sort((a, b) => a.zIndex - b.zIndex);
  let i = 0;
  while (i < wanted.length && wanted[i] === current[i]) i++;
  for (; i < wanted.length; i++) wanted[i].updateZIndex?.();
}

/** Apply one record's field changes to a plain record from a snapshot. */
function patchRecord(rec: Record<string, unknown>, fields: Record<string, unknown>): Record<string, unknown> {
  const out = { ...rec };
  for (const [f, v] of Object.entries(fields)) {
    if (v === undefined) delete out[f];
    else out[f] = v;
  }
  return out;
}

function patchList(
  list: Record<string, unknown>[],
  fields: Map<string, Record<string, unknown>>,
  added: Map<string, CanvasRecord>,
  removed: string[],
): Record<string, unknown>[] {
  const gone = new Set(removed);
  const present = new Set<string>();
  const out: Record<string, unknown>[] = [];
  for (const rec of list) {
    const id = rec.id as string;
    if (gone.has(id)) continue;
    present.add(id);
    const f = fields.get(id);
    out.push(f ? patchRecord(rec, f) : rec);
  }
  for (const [id, rec] of added) if (!present.has(id)) out.push({ ...rec });
  return out;
}

/**
 * Write a remote change into every snapshot of Obsidian's undo history, so
 * undo and redo move only between this user's own states. Field by field: a
 * peer recolouring a node this user moved leaves the move undoable, and the
 * colour where the peer put it. A node the peer removed leaves every snapshot,
 * so no undo brings it back.
 */
function rebaseHistory(canvas: CanvasLike, plan: DrawPlan): void {
  const history = canvas.history;
  for (let i = 0; i < history.data.length; i++) {
    const snap = history.data[i];
    const patched: CanvasData = {
      ...snap,
      nodes: patchList(snap.nodes ?? [], plan.nodeFields, plan.addedNodes, plan.removeNodes),
      edges: patchList(snap.edges ?? [], plan.edgeFields, plan.addedEdges, plan.removeEdges),
    };
    if (plan.extraChanged) {
      for (const [k, v] of Object.entries(plan.extra)) {
        if (v === undefined) delete patched[k];
        else patched[k] = v;
      }
    }
    history.data[i] = patched;
  }
}

/**
 * A record to hand `importData` for a remote change: the fields that changed,
 * laid over what the view shows now. A record new to the view goes whole.
 */
function overlay(
  live: Record<string, unknown> | undefined,
  rec: CanvasRecord,
  fields: Record<string, unknown> | undefined,
): CanvasRecord {
  if (!live || !fields) return rec;
  const out = { ...(normaliseJson(live) as Record<string, unknown>) };
  for (const [f, v] of Object.entries(fields)) {
    if (v === undefined) delete out[f];
    else out[f] = v;
  }
  return out as CanvasRecord;
}

/** Only `fields` of `held`, replaced by what the view now has for them. */
function heldAfterDraw(held: CanvasRecord, fields: Record<string, unknown>, live: Record<string, unknown> | undefined): CanvasRecord {
  const now = live ? (normaliseJson(live) as Record<string, unknown>) : fields;
  const out: CanvasRecord = { ...held };
  for (const f of Object.keys(fields)) {
    if (f in now && now[f] !== undefined) out[f] = now[f];
    else delete out[f];
  }
  return out;
}

/**
 * `held` after drawing a plan. For each drawn record, only the fields that
 * were drawn change, and they take the view's own value — so its rounding is
 * what is held, and never read as an edit. Everything else stays as it was:
 * a fresh read of the view would take an edit the view has made and not
 * committed as held, and it would never be carried out. A held-back gesture's
 * position and size are not among the drawn fields, so they stay too.
 */
function patchHeld(held: CanvasValue, plan: DrawPlan, canvas: CanvasLike): CanvasValue {
  const nodeOf = (id: string): Record<string, unknown> | undefined => canvas.nodes.get(id)?.getData();
  const removedNodes = new Set(plan.removeNodes);
  const nodes: CanvasRecord[] = [];
  for (const n of held.nodes) {
    if (removedNodes.has(n.id)) continue;
    const fields = plan.nodeFields.get(n.id);
    nodes.push(fields ? heldAfterDraw(n, fields, nodeOf(n.id)) : n);
  }
  for (const [id, rec] of plan.addedNodes) {
    const live = nodeOf(id);
    nodes.push(live ? (normaliseJson(live) as CanvasRecord) : rec);
  }
  // The order the view now has them in, which is what its next save will say.
  const viewOrder = new Map(canvas.getData().nodes.map((n, i) => [n.id as string, i]));
  nodes.sort((a, b) => (viewOrder.get(a.id) ?? Infinity) - (viewOrder.get(b.id) ?? Infinity));

  const removedEdges = new Set(plan.removeEdges);
  const edges: CanvasRecord[] = [];
  for (const e of held.edges) {
    if (removedEdges.has(e.id)) continue;
    const fields = plan.edgeFields.get(e.id);
    edges.push(fields ? heldAfterDraw(e, fields, canvas.edges.get(e.id)?.getData()) : e);
  }
  for (const [, rec] of plan.addedEdges) edges.push(rec);

  const extra = { ...held.extra };
  if (plan.extraChanged) {
    for (const [k, v] of Object.entries(plan.extra)) {
      if (v === undefined) delete extra[k];
      else extra[k] = v;
    }
  }
  return normaliseCanvas({ nodes, edges, extra });
}

// ── The manager ───────────────────────────────────────────────────────────

export interface CanvasLiveManagerDeps extends CanvasLiveDeps {
  /** Every open canvas view. */
  views(): CanvasViewInternal[];
  /** Tell the user, once per session, that a canvas fell back. */
  notify(message: string): void;
}

const RETRY_MS = 1500;

/**
 * Binds every open canvas of a shared file, not only the active one, and
 * keeps trying the ones not ready yet: a canvas open before the plugin loaded
 * never sees a load event (Relay 61441033), and a document may still be
 * syncing when its canvas opens.
 */
export class CanvasLiveManager {
  private bindings = new Map<CanvasViewInternal, CanvasLiveBinding>();
  /** Views that fell back; not tried again while they show the same file. */
  private brokenViews = new WeakMap<CanvasViewInternal, string>();
  private retry: number | null = null;
  private notified = false;
  private disposed = false;
  private listeners = new Set<(b: CanvasLiveBinding) => void>();

  constructor(private deps: CanvasLiveManagerDeps) {}

  /** Called for every new live binding, for presence. */
  onBound(cb: (b: CanvasLiveBinding) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  bindingFor(view: unknown): CanvasLiveBinding | null {
    return this.bindings.get(view as CanvasViewInternal) ?? null;
  }

  /** Look at every open canvas: bind the new, let go of the gone. */
  refresh(): void {
    if (this.disposed) return;
    const open = new Set(this.deps.views());
    let waiting = false;
    for (const [view, b] of this.bindings) {
      if (!open.has(view) || view.file?.path !== b.path || !b.isBound()) {
        b.detach();
        this.bindings.delete(view);
      }
    }
    for (const view of open) {
      const path = view.file?.path;
      if (!path || !path.endsWith('.canvas') || this.bindings.has(view)) continue;
      if (this.brokenViews.get(view) === path) continue;
      // Still waiting whether or not its document is known yet: a canvas open
      // when the plugin starts has no document until its folder connects, and
      // no workspace event says when that happens.
      waiting = true;
      if (!this.deps.structured.docNameFor(path)) continue;
      void this.tryBind(view, path);
    }
    if (waiting) this.scheduleRetry();
  }

  private pending = new Set<CanvasViewInternal>();

  private async tryBind(view: CanvasViewInternal, path: string): Promise<void> {
    if (this.pending.has(view)) return;
    this.pending.add(view);
    const binding = new CanvasLiveBinding(view, path, {
      ...this.deps,
      fellBack: (p, reason) => {
        this.brokenViews.set(view, p);
        this.fellBack(p, reason);
      },
    });
    try {
      const result = await binding.attach();
      if (result === 'bound') {
        if (this.disposed || this.bindings.has(view)) {
          binding.detach();
          return;
        }
        this.bindings.set(view, binding);
        for (const cb of this.listeners) cb(binding);
      }
    } catch (err) {
      log.warn('Could not bind an open canvas live', { path, error: String(err) });
    } finally {
      this.pending.delete(view);
    }
  }

  private fellBack(path: string, reason: string): void {
    log.warn('A canvas is syncing over disk instead of live', { path, reason });
    this.deps.fellBack(path, reason);
    if (this.notified) return;
    this.notified = true;
    this.deps.notify(
      'Nectenda: live canvas editing is unavailable with this version of Obsidian. ' +
      'Canvases still sync, a couple of seconds behind. Details are in the diagnostic log.',
    );
  }

  private scheduleRetry(): void {
    if (this.retry !== null || this.disposed) return;
    this.retry = window.setTimeout(() => {
      this.retry = null;
      this.refresh();
    }, RETRY_MS);
  }

  /**
   * Let go of every binding, before the documents they hold are torn down;
   * the next refresh binds again to whatever is connected then.
   */
  reset(): void {
    for (const b of this.bindings.values()) b.detach();
    this.bindings.clear();
  }

  dispose(): void {
    this.disposed = true;
    if (this.retry !== null) window.clearTimeout(this.retry);
    this.reset();
  }
}
