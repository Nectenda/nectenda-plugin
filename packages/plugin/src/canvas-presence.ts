import type { Awareness } from 'y-protocols/awareness';
import {
  PRESENCE_VERSION, readPresence,
  type Gesture, type GestureRect, type Pointer, type PresenceV1, type Selection, type Viewport,
} from '@nectenda/shared';
import type * as Y from 'yjs';
import type { CanvasLike } from './canvas-internals';
import type { CanvasLiveBinding } from './canvas-live';
import {
  POINTER_WINDOW_MS, buildPointerMarker, caretIn, placePointer, setPointerEdge, type Edge,
} from './remote-pointer';
import { alignRendered, renderedCaret, renderedSpan, type Alignment } from './rendered-align';
import { log } from './logger';

/**
 * Who else is on a live canvas, and what they are doing: their pointers, what
 * they have selected, and a drag, resize or connection they have not dropped
 * yet (WIRE-090 to WIRE-094). Sealed like all presence (CRYPTO-110), so the
 * server learns only that someone has the board open.
 *
 * What others got wrong, and is avoided here:
 *
 * - **World coordinates only**, never screen ones — two people never share a
 *   zoom or a pane size (Ably's cursor experiment) — and re-sent after the
 *   sender's own pan or zoom, since the world point under a still mouse moved
 *   (tldraw #2487).
 * - **Ghosts in our own overlay, never on the real node.** Relay writes a
 *   peer's drag onto the node's own element, which a local drag of the same
 *   node then fights; and the model is read from those nodes. A ghost is
 *   dropped the moment its peer leaves or its node is gone (tldraw #10124),
 *   and outlives the gesture only until the committed position arrives.
 * - **Nothing sent while nobody else is here**, nothing unchanged sent twice,
 *   at most once per 50 ms (WIRE-091), and never from touch (WIRE-092).
 * - **A peer's pointer mid-drag is anchored to the dragged node** (Relay's
 *   smoothing notes), so cursor and ghost cannot drift apart on screen.
 * - One entry per person, however many tabs (tldraw #7756) — which the header
 *   report already does (editor-bridge.ts presenceReporter).
 */

/** How long a ghost waits, after its gesture ends, for the committed move to arrive. */
export const GHOST_LINGER_MS = 1500;
/** A pointer that has not moved for this long fades. */
export const CANVAS_POINTER_FADE_MS = 3000;
/** How often selection, viewport and gestures are sampled. */
const SAMPLE_MS = 100;
/**
 * After the mouse leaves a card editor's frame, how long a move elsewhere on
 * the canvas has to arrive before the pointer is taken as gone from the window.
 */
const FRAME_LEAVE_MS = 150;
/** How soon to look again for a card whose rendering is behind its text. */
const CARET_RETRY_MS = 250;
/** Past this jump, in screen pixels, a smoothed pointer snaps instead of gliding. */
const SNAP_PX = 600;

type CanvasPointer = Extract<Pointer, { surface: 'canvas' }>;

/** What this user's presence says about the canvas, before sealing. */
export interface CanvasFields {
  pointer: CanvasPointer | null;
  viewport: Viewport | null;
  selection: Selection | null;
  gesture: Gesture | null;
}

const EMPTY: CanvasFields = { pointer: null, viewport: null, selection: null, gesture: null };

/** The canvas presence sessions sharing each Awareness: one per open pane of a canvas. */
const sessions = new WeakMap<Awareness, Set<CanvasPresence>>();

const r1 = (n: number): number => Math.round(n);

/**
 * A gesture in progress: the nodes whose live rectangle differs from what the
 * view last committed. Only while the pointer is down, so a remote change
 * drawn into the view is never mistaken for one.
 */
export function sampleGesture(canvas: CanvasLike, binding: Pick<CanvasLiveBinding, 'isGesture' | 'heldNode'>): Gesture | null {
  const connecting = sampleConnection(canvas);
  if (connecting) return connecting;
  if (!binding.isGesture()) return null;
  const nodes: GestureRect[] = [];
  let resized = false;
  for (const [id, n] of canvas.nodes) {
    const held = binding.heldNode(id);
    if (!held) continue;
    if (held.x === n.x && held.y === n.y && held.width === n.width && held.height === n.height) continue;
    if (held.width !== n.width || held.height !== n.height) resized = true;
    nodes.push({ id, x: r1(n.x), y: r1(n.y), w: r1(n.width), h: r1(n.height) });
  }
  if (nodes.length === 0) return null;
  return { surface: 'canvas', kind: resized ? 'resize' : 'move', nodes: nodes.slice(0, 50) };
}

/**
 * An edge being drawn: Obsidian marks `canvasEl` with `is-connecting` and adds
 * a temporary edge whose loose end is a stand-in node that is not in the
 * canvas (1.13.7, `onConnectionPointerdown`). Best-effort: presence only.
 */
function sampleConnection(canvas: CanvasLike): Gesture | null {
  const el = canvas.canvasEl as unknown as { classList?: { contains(c: string): boolean } };
  if (!el.classList?.contains('is-connecting')) return null;
  for (const edge of canvas.edges.values()) {
    const e = edge as unknown as { from?: { node?: { id?: string; x?: number; y?: number }; side?: string }; to?: { node?: { id?: string; x?: number; y?: number } } };
    const from = e.from?.node;
    const to = e.to?.node;
    if (!from || !to || typeof from.id !== 'string') continue;
    const fromReal = canvas.nodes.get(from.id) === from;
    const toReal = typeof to.id === 'string' && canvas.nodes.get(to.id) === to;
    if (fromReal && !toReal && typeof to.x === 'number' && typeof to.y === 'number') {
      return { surface: 'canvas', kind: 'connect', from: from.id, side: e.from?.side, x: r1(to.x), y: r1(to.y) };
    }
  }
  return null;
}

export function sampleSelection(canvas: CanvasLike): Selection | null {
  const ids: string[] = [];
  for (const item of canvas.selection) {
    const id = (item as { id?: unknown }).id;
    if (typeof id === 'string') ids.push(id);
  }
  if (ids.length === 0) return null;
  return { surface: 'canvas', ids: ids.sort().slice(0, 200) };
}

export function sampleViewport(canvas: CanvasLike): Viewport {
  const b = canvas.getViewportBBox();
  return { surface: 'canvas', x: r1(b.minX), y: r1(b.minY), w: r1(b.maxX - b.minX), h: r1(b.maxY - b.minY) };
}

/**
 * The pointer, anchored to the dragged node while a gesture moves it: the
 * offset travels with the node's rectangle in the same state, so a receiver
 * draws cursor and ghost from one sample.
 */
export function anchorPointer(pointer: CanvasPointer | null, gesture: Gesture | null): CanvasPointer | null {
  if (!pointer || !gesture || gesture.kind === 'connect') return pointer;
  const under = gesture.nodes.find((n) => pointer.x >= n.x && pointer.x <= n.x + n.w && pointer.y >= n.y && pointer.y <= n.y + n.h)
    ?? gesture.nodes[0];
  return { surface: 'canvas', x: pointer.x, y: pointer.y, node: under.id, nx: r1(pointer.x - under.x), ny: r1(pointer.y - under.y) };
}

// ── Drawing ─────────────────────────────────────────────────────────────

export interface PeerToDraw {
  clientId: number;
  name: string;
  color: string;
  /** World position of the pointer, or null when they have none on this canvas. */
  pointer: { x: number; y: number } | null;
  selection: string[];
  ghosts: GestureRect[];
  connect: { from: string; x: number; y: number } | null;
  /** The world rectangle they are looking at, or null. */
  viewport: { x: number; y: number; w: number; h: number } | null;
}

/**
 * What to draw for each peer: never ourselves (WIRE-093), nothing for a node
 * that is gone, and an unreadable state skipped rather than stopping the rest
 * (CRYPTO-112).
 */
export function peersToDraw(
  states: Map<number, unknown>,
  self: number,
  nodeIds: ReadonlySet<string>,
): PeerToDraw[] {
  const out: PeerToDraw[] = [];
  for (const [clientId, raw] of states) {
    if (clientId === self) continue;
    const p: PresenceV1 | null = readPresence(raw);
    if (!p?.user) continue;
    const gesture = p.gesture?.surface === 'canvas' ? p.gesture : null;
    const ghosts = gesture && gesture.kind !== 'connect' ? gesture.nodes.filter((n) => nodeIds.has(n.id)) : [];
    let pointer: { x: number; y: number } | null = null;
    if (p.pointer?.surface === 'canvas') {
      const ptr = p.pointer;
      const anchor = ptr.node ? ghosts.find((g) => g.id === ptr.node) : undefined;
      pointer = anchor && ptr.nx !== undefined && ptr.ny !== undefined
        ? { x: anchor.x + ptr.nx, y: anchor.y + ptr.ny }
        : { x: ptr.x, y: ptr.y };
    }
    out.push({
      clientId,
      name: p.user.name,
      color: p.user.color,
      pointer,
      selection: p.selection?.surface === 'canvas' ? p.selection.ids.filter((id) => nodeIds.has(id)) : [],
      ghosts,
      connect: gesture?.kind === 'connect' && nodeIds.has(gesture.from) ? { from: gesture.from, x: gesture.x, y: gesture.y } : null,
      viewport: p.viewport?.surface === 'canvas' ? { x: p.viewport.x, y: p.viewport.y, w: p.viewport.w, h: p.viewport.h } : null,
    });
  }
  return out;
}

/** World to the wrapper's own pixels: `x` and `y` are the world point at its centre. */
export function toScreen(canvas: CanvasLike, width: number, height: number, x: number, y: number): { x: number; y: number } {
  return { x: width / 2 + (x - canvas.x) * canvas.scale, y: height / 2 + (y - canvas.y) * canvas.scale };
}

/**
 * Where to draw a pointer at world `x`, `y` in a wrapper `width` by `height`:
 * there when it is in view, and otherwise pinned to the edge it lies beyond,
 * as a note does (remote-pointer.ts `placePointer`) — so a collaborator who
 * has wandered off-screen is still findable rather than clipped away.
 */
export function placeCanvasPointer(
  canvas: CanvasLike,
  width: number,
  height: number,
  x: number,
  y: number,
): { x: number; y: number; edge: Edge | null } {
  const at = toScreen(canvas, width, height, x, y);
  return placePointer({ x: at.x, y: at.y, h: 0 }, { left: 0, top: 0, right: width, bottom: height });
}

/** A collaborator's caret inside a card on this canvas (NEC-162's `cursor`). */
export interface CardCaretOnCanvas {
  clientId: number;
  cardId: string;
  /** The head: where the caret is. */
  index: number;
  /** The other end of their selection; equal to `index` when nothing is selected. */
  anchor: number;
  name: string;
  color: string;
  /** Their selection tint (`colorLight`). */
  tint: string;
}

/**
 * Whose caret is in which card. A caret's relative position names the card's
 * own `Y.Text`, so the card is found by that text — never guessed from a
 * selection. Never ourselves (WIRE-093); a caret that resolves to no card here
 * is not drawn.
 */
export function cardCaretsOnCanvas(
  states: ReadonlyMap<number, unknown>,
  self: number,
  doc: Y.Doc,
  cardOfText: ReadonlyMap<unknown, string>,
): CardCaretOnCanvas[] {
  const out: CardCaretOnCanvas[] = [];
  for (const [clientId, raw] of states) {
    if (clientId === self) continue;
    const caret = caretIn(raw, doc);
    const cardId = caret ? cardOfText.get(caret.type) : undefined;
    if (!caret || cardId === undefined) continue;
    out.push({
      clientId, cardId, index: caret.head, anchor: caret.anchor,
      name: caret.name, color: caret.color, tint: caret.colorLight,
    });
  }
  return out.sort((a, b) => a.clientId - b.clientId);
}

/**
 * The carets to draw on the board, from this screen's side: only in cards not
 * open for editing here, since an open card editor draws its own exact caret
 * (card-caret.ts) and a second one on top would be one caret drawn twice. Each
 * says whether a bar may be tried yet — 'wait' while the card as rendered is
 * behind its text (its `text` is what the view has committed; the rendering
 * follows it), because the caret then names text not on screen, and a bar
 * placed against the old rendering would jump when the new one lands.
 */
export function viewedCardCarets(
  carets: readonly CardCaretOnCanvas[],
  liveCards: ReadonlySet<string>,
  nodes: ReadonlyMap<string, { text?: string }>,
  textOf: (cardId: string) => string | null,
): Array<CardCaretOnCanvas & { bar: 'wait' | 'try' }> {
  const out: Array<CardCaretOnCanvas & { bar: 'wait' | 'try' }> = [];
  for (const c of carets) {
    if (liveCards.has(c.cardId)) continue;
    const node = nodes.get(c.cardId);
    if (!node) continue;
    out.push({ ...c, bar: node.text === textOf(c.cardId) ? 'try' : 'wait' });
  }
  return out;
}

type WorldRect = { x: number; y: number; width: number; height: number };

/**
 * Where "go to" a collaborator on a canvas lands, as a world point: their
 * pointer, since on a board that is where their attention is; then the card
 * their caret is in; then what they have selected; then the middle of what
 * they are looking at. Null when they give none of these here.
 *
 * Each level is tried for every client of that name before the next, so a
 * person with two panes open is found by their pointer in either.
 */
export function canvasGoToTarget(
  peers: readonly PeerToDraw[],
  name: string,
  nodes: ReadonlyMap<string, WorldRect>,
  carets: readonly Pick<CardCaretOnCanvas, 'clientId' | 'cardId'>[],
): { x: number; y: number } | null {
  const theirs = peers.filter((p) => p.name === name);
  const centre = (r: WorldRect) => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
  for (const p of theirs) if (p.pointer) return { x: p.pointer.x, y: p.pointer.y };
  for (const p of theirs) {
    const card = carets.find((c) => c.clientId === p.clientId);
    const node = card ? nodes.get(card.cardId) : undefined;
    if (node) return centre(node);
  }
  for (const p of theirs) {
    const rects = p.selection.map((id) => nodes.get(id)).filter((n): n is WorldRect => n !== undefined);
    if (rects.length === 0) continue;
    const minX = Math.min(...rects.map((r) => r.x));
    const minY = Math.min(...rects.map((r) => r.y));
    const maxX = Math.max(...rects.map((r) => r.x + r.width));
    const maxY = Math.max(...rects.map((r) => r.y + r.height));
    return { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
  }
  for (const p of theirs) if (p.viewport) return { x: p.viewport.x + p.viewport.w / 2, y: p.viewport.y + p.viewport.h / 2 };
  return null;
}

/** A frame element as `frameToClient` needs it: its client rect, and its content box in its own pixels. */
export interface FrameBox {
  left: number;
  top: number;
  width: number;
  clientWidth: number;
  clientLeft: number;
  clientTop: number;
}

/**
 * A mouse position inside a card editor's iframe, in the canvas's client
 * pixels. The frame sits inside the zoomed board, so its content is scaled:
 * one of its pixels is `width / clientWidth` of the parent's (the canvas
 * zooms uniformly). Without the scale, a pointer inside a card lands off by
 * the zoom everywhere but at 100%.
 */
export function frameToClient(at: { clientX: number; clientY: number }, frame: FrameBox): { clientX: number; clientY: number } {
  const s = frame.clientWidth > 0 ? frame.width / frame.clientWidth : 1;
  return {
    clientX: frame.left + (frame.clientLeft + at.clientX) * s,
    clientY: frame.top + (frame.clientTop + at.clientY) * s,
  };
}

/** One step of a pointer gliding toward where it was last reported. */
export function glide(from: { x: number; y: number }, to: { x: number; y: number }, dtMs: number): { x: number; y: number } {
  if (Math.hypot(to.x - from.x, to.y - from.y) > SNAP_PX) return to;
  const k = 1 - Math.exp(-Math.max(0, dtMs) / 60);
  return { x: from.x + (to.x - from.x) * k, y: from.y + (to.y - from.y) * k };
}

export interface CanvasPresenceDeps {
  username(): string;
  userColor(name: string): { seat: number; color: string; light: string };
  sharePointer(): boolean;
  showPointers(): boolean;
}

/** Presence for one live canvas: sends ours, draws theirs. */
export class CanvasPresence {
  private awareness: Awareness;
  private canvas: CanvasLike;
  private sent: CanvasFields = EMPTY;
  /** Send on the next flush even if nothing changed: another pane cleared what this one said. */
  private forceSend = false;
  private pointer: CanvasPointer | null = null;
  private lastClient: { clientX: number; clientY: number } | null = null;
  private flushTimer: number | null = null;
  private sampleTimer: number | null = null;
  private frame: number | null = null;
  private lastFrame = 0;
  private restore: (() => void)[] = [];
  private overlay: HTMLElement | null = null;
  private drawn = new Map<number, { el: HTMLElement; at: { x: number; y: number } | null; movedAt: number }>();
  private ghostEls: HTMLElement[] = [];
  private selectedEls = new Set<HTMLElement>();
  /** Cards outlined because someone is typing in them, and the name tags and bars drawn for that. */
  private typingEls = new Set<HTMLElement>();
  private caretEls: HTMLElement[] = [];
  /** Per card, the last alignment of its source to its rendering: redone only when either changes. */
  private aligned = new Map<string, { key: string; alignment: Alignment }>();
  private retryTimer: number | null = null;
  /** Listeners in card editors' frames, by frame document (`syncFrames`). */
  private frameHooks = new Map<Document, () => void>();
  /**
   * Moves heard anywhere — the canvas or a card editor — counted. A count
   * rather than a time: the move onto the canvas can arrive in the same
   * millisecond as the leave from the frame, and must still count as after it.
   */
  private moves = 0;
  private lastSeen = new Map<number, number>();
  private lingering = new Map<number, { rects: GestureRect[]; until: number }>();
  private stopped = false;

  constructor(private binding: CanvasLiveBinding, private deps: CanvasPresenceDeps) {
    this.awareness = binding.awareness as Awareness;
    this.canvas = binding.canvas;
  }

  /** A state saying who this user is, and nothing about the canvas yet. */
  private baseState(): Record<string, unknown> {
    const name = this.deps.username();
    const c = this.deps.userColor(name);
    return {
      v: PRESENCE_VERSION,
      user: { name, seat: c.seat, color: c.color, colorLight: c.light },
      pointer: null, viewport: null, selection: null, gesture: null,
    };
  }

  start(): void {
    if (!this.binding.awareness) return;
    // One Awareness per document: two panes of the same canvas share it, and
    // whichever the user is in sends. So the pane closing does not take the
    // user's presence with it while another is open (see stop).
    let sharing = sessions.get(this.awareness);
    if (!sharing) sessions.set(this.awareness, (sharing = new Set()));
    sharing.add(this);
    // setLocalState, not a field: a structured subscription starts at null.
    // A state already saying who this is came from another pane: kept.
    const existing = this.awareness.getLocalState() as { user?: unknown } | null;
    if (!existing?.user) this.awareness.setLocalState(this.baseState());
    const wrapper = this.canvas.wrapperEl;
    const win = wrapper.ownerDocument.defaultView ?? window;
    const move = (evt: PointerEvent): void => {
      // Touch never sends a pointer (WIRE-092): a finger is not a cursor.
      if (evt.pointerType === 'touch') return;
      this.pointerAt({ clientX: evt.clientX, clientY: evt.clientY });
    };
    const leave = (): void => this.pointerGone();
    wrapper.addEventListener('pointermove', move);
    wrapper.addEventListener('pointerleave', leave);
    this.restore.push(() => {
      wrapper.removeEventListener('pointermove', move);
      wrapper.removeEventListener('pointerleave', leave);
    });

    // A pan or zoom moves the world under a still mouse: re-read it.
    const canvas = this.canvas;
    // Called through a bound copy, because the directory's scan reports an
    // unbound read of a method as a Warning. What is put back on stop is the
    // property as it was, not that copy: restoring the very function lets
    // wrappers stacked on one canvas unwind in order, each guard below still
    // finding its own wrapper on top.
    const orig = canvas.markViewportChanged.bind(canvas);
    const before = Object.getOwnPropertyDescriptor(canvas, 'markViewportChanged');
    const wrapped = (): void => {
      orig();
      this.onViewport();
    };
    canvas.markViewportChanged = wrapped;
    // Put back only if ours is still on top, so a later wrapper is not torn off.
    this.restore.push(() => {
      if (canvas.markViewportChanged !== wrapped) return;
      if (before) Object.defineProperty(canvas, 'markViewportChanged', before);
      else Reflect.deleteProperty(canvas, 'markViewportChanged'); // the prototype's shows through again
    });

    const onChange = (): void => {
      for (const id of this.awareness.getStates().keys()) this.lastSeen.set(id, Date.now());
      this.requestDraw();
    };
    this.awareness.on('change', onChange);
    this.restore.push(() => this.awareness.off('change', onChange));
    this.restore.push(this.binding.onChange(() => {
      this.syncFrames();
      this.schedule();
      this.requestDraw();
    }));
    this.syncFrames();
    this.restore.push(() => {
      for (const off of this.frameHooks.values()) off();
      this.frameHooks.clear();
    });

    this.sampleTimer = win.setInterval(() => {
      // Also where a card editor is noticed moving into its frame: Obsidian
      // moves it there once the frame loads, and nothing announces that.
      this.syncFrames();
      this.schedule();
    }, SAMPLE_MS);
    this.restore.push(() => {
      if (this.sampleTimer !== null) win.clearInterval(this.sampleTimer);
    });
    this.requestDraw();
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const r of this.restore.splice(0).reverse()) {
      try {
        r();
      } catch (err) {
        log.warn('Could not undo a canvas presence hook', { error: String(err) });
      }
    }
    if (this.flushTimer !== null) window.clearTimeout(this.flushTimer);
    if (this.retryTimer !== null) window.clearTimeout(this.retryTimer);
    this.clearDrawing();
    this.overlay?.remove();
    this.overlay = null;
    const sharing = sessions.get(this.awareness);
    sharing?.delete(this);
    try {
      if (sharing && sharing.size > 0) {
        // Another pane of this canvas is still open: the user is still here.
        // Only what this pane said goes, and the others say theirs again.
        const state = this.awareness.getLocalState();
        if (state) this.awareness.setLocalState({ ...state, ...EMPTY });
        for (const other of sharing) other.resend();
        return;
      }
      sessions.delete(this.awareness);
      // Leaving retracts at once, rather than waiting to time out (WIRE-092).
      this.awareness.setLocalState(null);
    } catch (err) {
      log.warn('Could not retract canvas presence', { error: String(err) });
    }
  }

  /** The mouse is at this client point of the canvas's own document. */
  private pointerAt(client: { clientX: number; clientY: number }): void {
    this.moves++;
    this.lastClient = client;
    const at = this.canvas.posFromEvt(client as MouseEvent);
    this.pointer = { surface: 'canvas', x: r1(at.x), y: r1(at.y) };
    this.schedule();
  }

  /** The mouse left the canvas: said at once, rather than left to time out (WIRE-092). */
  private pointerGone(): void {
    this.lastClient = null;
    this.pointer = null;
    this.send();
  }

  /**
   * Listen in every card editor's frame the binding knows of, and stop
   * listening in any it has let go. A card being edited has its editor in an
   * iframe of its own (Obsidian's embed, `useIframe`), and a mouse over it
   * sends its events to that frame's document — never to the canvas below,
   * which would otherwise hold the pointer where the mouse went into the card.
   */
  private syncFrames(): void {
    if (this.stopped) return;
    const wanted = new Set(this.binding.cardFrames());
    for (const [doc, off] of this.frameHooks) {
      if (wanted.has(doc)) continue;
      off();
      this.frameHooks.delete(doc);
    }
    for (const doc of wanted) {
      if (this.frameHooks.has(doc)) continue;
      const frame = doc.defaultView?.frameElement as HTMLElement | null | undefined;
      if (!frame) continue;
      const move = (evt: PointerEvent): void => {
        if (evt.pointerType === 'touch') return;
        const r = frame.getBoundingClientRect();
        this.pointerAt(frameToClient(evt, {
          left: r.left, top: r.top, width: r.width,
          clientWidth: frame.clientWidth, clientLeft: frame.clientLeft, clientTop: frame.clientTop,
        }));
      };
      // Out of the frame: onto the canvas, where its own moves take over, or
      // out of the window, where nothing else will hear it go. Both arrive
      // with no related target, since the element entered is in another
      // document or none, so it is told apart by whether a move follows.
      const out = (evt: PointerEvent): void => {
        if (evt.relatedTarget !== null || evt.pointerType === 'touch') return;
        const movesAtLeave = this.moves;
        window.setTimeout(() => {
          if (!this.stopped && this.moves === movesAtLeave) this.pointerGone();
        }, FRAME_LEAVE_MS);
      };
      doc.addEventListener('pointermove', move);
      doc.addEventListener('pointerout', out);
      this.frameHooks.set(doc, () => {
        doc.removeEventListener('pointermove', move);
        doc.removeEventListener('pointerout', out);
      });
    }
  }

  /** Send this pane's fields again, whatever was last sent. */
  private resend(): void {
    this.forceSend = true;
    this.schedule();
  }

  private onViewport(): void {
    // In the canvas's client pixels whichever document the move came from, so
    // a pan re-reads the world point under a mouse resting in a card editor too.
    if (this.lastClient) {
      const at = this.canvas.posFromEvt(this.lastClient as MouseEvent);
      this.pointer = { surface: 'canvas', x: r1(at.x), y: r1(at.y) };
    }
    this.schedule();
    this.requestDraw();
  }

  private schedule(): void {
    if (this.flushTimer !== null || this.stopped) return;
    this.flushTimer = window.setTimeout(() => {
      this.flushTimer = null;
      this.send();
    }, POINTER_WINDOW_MS);
  }

  /** Whether anyone else has this canvas open: nothing is sent to an empty room. */
  private othersHere(): boolean {
    const self = this.awareness.clientID;
    for (const [id, s] of this.awareness.getStates()) if (id !== self && s) return true;
    return false;
  }

  private send(): void {
    if (this.stopped) return;
    const share = this.deps.sharePointer();
    let fields: CanvasFields = EMPTY;
    if (share && this.othersHere()) {
      const gesture = sampleGesture(this.canvas, this.binding);
      fields = {
        pointer: anchorPointer(this.pointer, gesture),
        viewport: sampleViewport(this.canvas),
        selection: sampleSelection(this.canvas),
        gesture,
      };
    }
    // Unchanged is never resent (WIRE-091).
    if (!this.forceSend && JSON.stringify(fields) === JSON.stringify(this.sent)) return;
    this.forceSend = false;
    this.sent = fields;
    // Rebuilt if something set it to null under us, rather than going silent.
    const state = this.awareness.getLocalState() ?? this.baseState();
    this.awareness.setLocalState({ ...state, ...fields });
  }

  // ── Drawing ───────────────────────────────────────────────────────────

  private requestDraw(): void {
    if (this.frame !== null || this.stopped) return;
    const win = this.canvas.wrapperEl.ownerDocument.defaultView ?? window;
    const raf = win.requestAnimationFrame?.bind(win);
    if (!raf) return;
    this.frame = raf((t: number) => {
      this.frame = null;
      this.draw(t);
    });
  }

  private ensureOverlay(): HTMLElement {
    if (this.overlay) return this.overlay;
    const el = this.canvas.wrapperEl.createDiv({ cls: 'nectenda-canvas-presence' });
    this.overlay = el;
    return el;
  }

  private clearDrawing(): void {
    for (const { el } of this.drawn.values()) el.remove();
    this.drawn.clear();
    for (const g of this.ghostEls) g.remove();
    this.ghostEls = [];
    for (const el of this.selectedEls) {
      el.classList.remove('nectenda-peer-selected');
      el.style.removeProperty('--nectenda-peer-color');
    }
    this.selectedEls.clear();
    for (const el of this.caretEls) el.remove();
    this.caretEls = [];
    for (const el of this.typingEls) {
      el.classList.remove('nectenda-peer-typing');
      el.style.removeProperty('--nectenda-typing-color');
    }
    this.typingEls.clear();
  }

  /**
   * Take the view to a collaborator (the presence circles): see
   * `canvasGoToTarget` for where. The zoom is kept — theirs is not ours to
   * adopt. False when there is nowhere to go, or no way to pan.
   */
  goTo(name: string): boolean {
    const peers = peersToDraw(this.awareness.getStates(), this.awareness.clientID, new Set(this.canvas.nodes.keys()));
    const doc = this.binding.doc();
    const target = canvasGoToTarget(peers, name, this.canvas.nodes, doc ? this.cardCarets(doc) : []);
    if (!target || typeof this.canvas.panTo !== 'function') return false;
    this.canvas.panTo(target.x, target.y);
    return true;
  }

  private cardCarets(doc: Y.Doc): CardCaretOnCanvas[] {
    const cardOfText = new Map<unknown, string>();
    for (const id of this.canvas.nodes.keys()) {
      const text = this.binding.cardText(id);
      if (text) cardOfText.set(text, id);
    }
    return cardCaretsOnCanvas(this.awareness.getStates(), this.awareness.clientID, doc, cardOfText);
  }

  private draw(time: number): void {
    if (this.stopped) return;
    const dt = this.lastFrame ? time - this.lastFrame : 16;
    this.lastFrame = time;
    if (!this.deps.showPointers()) {
      this.clearDrawing();
      return;
    }
    const overlay = this.ensureOverlay();
    const w = this.canvas.wrapperEl.clientWidth;
    const h = this.canvas.wrapperEl.clientHeight;
    const peers = peersToDraw(this.awareness.getStates(), this.awareness.clientID, new Set(this.canvas.nodes.keys()));
    const now = Date.now();
    let moving = false;

    // Pointers.
    const seen = new Set<number>();
    for (const peer of peers) {
      if (!peer.pointer) continue;
      seen.add(peer.clientId);
      let d = this.drawn.get(peer.clientId);
      if (!d) {
        // The note's pointer, not a canvas one of its own (remote-pointer.ts).
        const el = buildPointerMarker(peer.clientId, peer.name, peer.color);
        el.classList.add('nectenda-pointer-canvas');
        overlay.appendChild(el);
        d = { el, at: null, movedAt: now };
        this.drawn.set(peer.clientId, d);
      }
      const placed = placeCanvasPointer(this.canvas, w, h, peer.pointer.x, peer.pointer.y);
      const target = { x: placed.x, y: placed.y };
      const at = d.at ? glide(d.at, target, dt) : target;
      if (!d.at || Math.hypot(target.x - d.at.x, target.y - d.at.y) > 0.5) d.movedAt = now;
      if (Math.hypot(target.x - at.x, target.y - at.y) > 0.5) moving = true;
      d.at = at;
      d.el.style.setProperty('--nectenda-pointer-colour', peer.color);
      const label = d.el.querySelector('.nectenda-pointer-name');
      if (label && label.textContent !== peer.name) label.textContent = peer.name;
      // Placed by left and top, as in a note: the edge classes position the
      // pinned marker with a transform of their own.
      d.el.style.left = `${at.x}px`;
      d.el.style.top = `${at.y}px`;
      setPointerEdge(d.el, placed.edge);
      const idle = now - Math.max(d.movedAt, this.lastSeen.get(peer.clientId) ?? 0) > CANVAS_POINTER_FADE_MS;
      d.el.classList.toggle('is-idle', idle);
    }
    for (const [id, d] of this.drawn) {
      if (!seen.has(id)) {
        d.el.remove();
        this.drawn.delete(id);
      }
    }

    // Ghosts: a gesture that ended lingers until the node's committed
    // rectangle matches it, or GHOST_LINGER_MS pass; a peer who left takes
    // theirs with them.
    for (const g of this.ghostEls) g.remove();
    this.ghostEls = [];
    const present = new Set(peers.map((p) => p.clientId));
    for (const peer of peers) {
      if (peer.ghosts.length) this.lingering.set(peer.clientId, { rects: peer.ghosts, until: now + GHOST_LINGER_MS });
    }
    for (const [id, l] of this.lingering) {
      const live = peers.find((p) => p.clientId === id);
      const landed = l.rects.every((r) => {
        const n = this.canvas.nodes.get(r.id);
        return !n || (n.x === r.x && n.y === r.y && n.width === r.w && n.height === r.h);
      });
      if (!present.has(id) || (!live?.ghosts.length && (landed || now > l.until))) {
        this.lingering.delete(id);
        continue;
      }
      for (const r of l.rects) {
        if (!this.canvas.nodes.has(r.id)) continue;
        const tl = toScreen(this.canvas, w, h, r.x, r.y);
        const el = overlay.createDiv({ cls: 'nectenda-canvas-ghost' });
        el.style.setProperty('--nectenda-peer-color', live?.color ?? 'var(--text-muted)');
        el.style.transform = `translate(${tl.x}px, ${tl.y}px)`;
        el.style.width = `${r.w * this.canvas.scale}px`;
        el.style.height = `${r.h * this.canvas.scale}px`;
        this.ghostEls.push(el);
      }
      moving = true;
    }
    for (const peer of peers) {
      if (!peer.connect) continue;
      const from = this.canvas.nodes.get(peer.connect.from);
      if (!from) continue;
      const a = toScreen(this.canvas, w, h, from.x + from.width / 2, from.y + from.height / 2);
      const b = toScreen(this.canvas, w, h, peer.connect.x, peer.connect.y);
      const el = overlay.createDiv({ cls: 'nectenda-canvas-connection' });
      el.style.setProperty('--nectenda-peer-color', peer.color);
      el.style.width = `${Math.hypot(b.x - a.x, b.y - a.y)}px`;
      el.style.transform = `translate(${a.x}px, ${a.y}px) rotate(${Math.atan2(b.y - a.y, b.x - a.x)}rad)`;
      this.ghostEls.push(el);
    }

    // Selections: outlined in the peer's colour.
    const selected = new Map<HTMLElement, string>();
    for (const peer of peers) {
      for (const id of peer.selection) {
        const n = this.canvas.nodes.get(id);
        if (n && !selected.has(n.nodeEl)) selected.set(n.nodeEl, peer.color);
      }
    }
    for (const el of this.selectedEls) {
      if (selected.has(el)) continue;
      el.classList.remove('nectenda-peer-selected');
      el.style.removeProperty('--nectenda-peer-color');
      this.selectedEls.delete(el);
    }
    for (const [el, color] of selected) {
      el.classList.add('nectenda-peer-selected');
      el.style.setProperty('--nectenda-peer-color', color);
      this.selectedEls.add(el);
    }

    if (this.drawCardCarets(overlay, w, h)) this.retrySoon();
    if (moving) this.requestDraw();
  }

  /**
   * Carets in cards this person is only looking at. A card open in an editor
   * here gets the exact caret inside that editor instead (card-caret.ts), so it
   * is skipped: each caret is drawn once.
   *
   * The card is always outlined, with the typist's name on its corner. A bar
   * is added only where it can be trusted (`caretBar`). True when a bar is
   * waiting for the card to catch up, so the caller looks again shortly.
   */
  private drawCardCarets(overlay: HTMLElement, w: number, h: number): boolean {
    for (const el of this.caretEls) el.remove();
    this.caretEls = [];
    const typing = new Map<HTMLElement, string>();
    const doc = this.binding.doc();
    const carets = doc
      ? viewedCardCarets(this.cardCarets(doc), this.binding.liveCards, this.canvas.nodes, (id) => this.binding.cardText(id)?.toString() ?? null)
      : [];
    const tagsOn = new Map<string, number>();
    let waiting = false;
    for (const c of carets) {
      const node = this.canvas.nodes.get(c.cardId);
      if (!node) continue;
      if (!typing.has(node.nodeEl)) typing.set(node.nodeEl, c.color);
      // Stacked upward when two people type in one card.
      const nth = tagsOn.get(c.cardId) ?? 0;
      tagsOn.set(c.cardId, nth + 1);
      const corner = toScreen(this.canvas, w, h, node.x, node.y);
      const tag = overlay.createDiv({ cls: 'nectenda-canvas-typing-name', text: c.name });
      tag.style.setProperty('--nectenda-typing-color', c.color);
      tag.style.transform = `translate(${corner.x}px, ${corner.y - nth * 20}px)`;
      this.caretEls.push(tag);
      if (c.bar === 'wait') {
        waiting = true;
        continue;
      }
      this.caretEls.push(...this.caretMarks(c, overlay));
    }
    for (const el of this.typingEls) {
      if (typing.has(el)) continue;
      el.classList.remove('nectenda-peer-typing');
      el.style.removeProperty('--nectenda-typing-color');
      this.typingEls.delete(el);
    }
    for (const [el, color] of typing) {
      el.classList.add('nectenda-peer-typing');
      el.style.setProperty('--nectenda-typing-color', color);
      this.typingEls.add(el);
    }
    for (const id of this.aligned.keys()) if (!tagsOn.has(id)) this.aligned.delete(id);
    return waiting;
  }

  /**
   * A bar where the caret is in the card as rendered, and a tint over what is
   * selected, for a card whose rendering has caught up (`viewedCardCarets`).
   * Nothing where it cannot be trusted: the card not rendered (culled, zoomed
   * out to a placeholder), or the caret or a selection's end somewhere the
   * rendering does not follow its source (rendered-align.ts).
   */
  private caretMarks(c: CardCaretOnCanvas, overlay: HTMLElement): HTMLElement[] {
    const node = this.canvas.nodes.get(c.cardId);
    const ytext = this.binding.cardText(c.cardId);
    if (!node || !ytext) return [];
    const source = ytext.toString();
    const preview = node.child?.previewEl;
    if (!preview?.isConnected) return [];
    const texts = textNodesOf(preview);
    const rendered = texts.map((t) => t.data).join('');
    if (rendered.trim() === '') return [];
    const key = `${source}\u0000${rendered}`;
    let cached = this.aligned.get(c.cardId);
    if (cached?.key !== key) {
      cached = { key, alignment: alignRendered(source, rendered) };
      this.aligned.set(c.cardId, cached);
    }
    const origin = overlay.getBoundingClientRect();
    const marks: HTMLElement[] = [];
    // The selection first, so the bar at its end is drawn over it.
    const span = c.anchor === c.index ? null : renderedSpan(source, cached.alignment, c.anchor, c.index);
    for (const r of span ? spanRects(preview, texts, span.start, span.end) : []) {
      const el = overlay.createDiv({ cls: 'nectenda-canvas-card-selection' });
      el.style.setProperty('--nectenda-selection-tint', c.tint);
      el.style.left = `${r.left - origin.left}px`;
      el.style.top = `${r.top - origin.top}px`;
      el.style.width = `${r.width}px`;
      el.style.height = `${r.height}px`;
      marks.push(el);
    }
    const at = renderedCaret(source, cached.alignment, c.index);
    const rect = at ? charRect(preview, texts, at.rendered) : null;
    if (at && rect) {
      const bar = overlay.createDiv({ cls: 'nectenda-canvas-card-caret' });
      bar.style.setProperty('--nectenda-typing-color', c.color);
      bar.style.left = `${(at.side === 'before' ? rect.left : rect.right) - origin.left}px`;
      bar.style.top = `${rect.top - origin.top}px`;
      bar.style.height = `${rect.height}px`;
      marks.push(bar);
    }
    return marks;
  }

  /** Look again shortly, for a card whose rendering has not caught up with its text. */
  private retrySoon(): void {
    if (this.retryTimer !== null || this.stopped) return;
    this.retryTimer = window.setTimeout(() => {
      this.retryTimer = null;
      this.requestDraw();
    }, CARET_RETRY_MS);
  }
}

/** Every text node under `root`, in document order: what the rendered text is read from. */
function textNodesOf(root: HTMLElement): Text[] {
  const doc = root.ownerDocument;
  const walker = doc.createTreeWalker(root, 4 /* NodeFilter.SHOW_TEXT */);
  const out: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) out.push(n as Text);
  return out;
}

/** Where the rendered text's `index` falls: a text node and the offset in it. `index` may be the very end. */
function boundaryAt(texts: readonly Text[], index: number): { node: Text; offset: number } | null {
  let start = 0;
  for (const t of texts) {
    if (index <= start + t.data.length) return { node: t, offset: index - start };
    start += t.data.length;
  }
  return null;
}

/** The client rectangles of the rendered text from `start` to `end`, one per line box it crosses. */
function spanRects(root: HTMLElement, texts: readonly Text[], start: number, end: number): DOMRect[] {
  const from = boundaryAt(texts, start);
  const to = boundaryAt(texts, end);
  if (!from || !to) return [];
  const range = root.ownerDocument.createRange();
  range.setStart(from.node, from.offset);
  range.setEnd(to.node, to.offset);
  return Array.from(range.getClientRects()).filter((r) => r.width > 0 && r.height > 0);
}

/** The client rectangle of the character at `index` in the concatenation of `texts`. */
function charRect(root: HTMLElement, texts: readonly Text[], index: number): DOMRect | null {
  let start = 0;
  for (const t of texts) {
    if (index < start + t.data.length) {
      const range = root.ownerDocument.createRange();
      range.setStart(t, index - start);
      range.setEnd(t, index - start + 1);
      const rects = range.getClientRects();
      const r = rects.length > 0 ? rects[0] : null;
      return r && r.height > 0 ? r : null;
    }
    start += t.data.length;
  }
  return null;
}
