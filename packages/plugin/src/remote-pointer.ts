import * as Y from 'yjs';
import { StateEffect, type Extension } from '@codemirror/state';
import { EditorView, ViewPlugin, layer, type LayerMarker, type PluginValue } from '@codemirror/view';
import type { Awareness } from 'y-protocols/awareness';
import { readPresence, toBase64, fromBase64, type Pointer, type RelPos } from '@nectenda/shared';
import type { TimerHandle } from './timers';
import { log } from './logger';

/**
 * Collaborators' mouse pointers, drawn in the note.
 *
 * ## Anchored to the text, never to the screen
 *
 * Two vaults rarely share pane width, font size, zoom, wrapping or folds, so a
 * pointer sent as `{x, y}` lands on the wrong word — usually on a different
 * line. The sender resolves the mouse to the nearest character with
 * `posAtCoords` and sends that character as a `Y.RelativePosition`, which is
 * how y-codemirror already ships the caret and which survives edits made
 * before it. The receiver resolves the character back with `coordsAtPos` in
 * its own layout. The only pixel-ish thing carried is `dx`, how far past that
 * character the mouse sat, in character widths, so that pointing into the
 * margin does not snap onto the last letter of the line.
 *
 * ## Sealed with no extra work
 *
 * The pointer is a field of the awareness state, and `presence-seal.ts` seals
 * the whole state, padded to one 512-byte bucket. The server sees that
 * presence changed, not that it was the pointer (security-model.md).
 *
 * ## Presentation only
 *
 * Nothing here writes to the `Y.Text`, the editor's document or the disk. A
 * bug in this file can draw a pointer in the wrong place; it cannot touch a
 * user's writing. CodeMirror catches an exception thrown from a view plugin or
 * a layer and carries on editing.
 */

/**
 * The client-side send window. The server already coalesces presence to one
 * relay per document per 50 ms (SAFE-B4), and `pointermove` fires at 60–120 Hz,
 * so sending faster than this would only be thrown away one hop later — after
 * being sealed, which is not free.
 */
export const POINTER_WINDOW_MS = 50;

/** `dx` is rounded to this many character widths, so a jittering hand is not a stream of sends. */
const DX_STEP = 0.5;
/** And clamped, so a pointer at the far edge of a very wide pane is not sent as a number nobody can draw. */
const DX_MAX = 200;

/** What the sender writes and the receiver reads: the text surface of `Pointer`. */
export type TextPointer = Extract<Pointer, { surface: 'text' }>;

/** Anchor a pointer to the character at `index`. */
export function anchorAt(ytext: Y.Text, index: number): RelPos {
  const rel = Y.createRelativePositionFromTypeIndex(ytext, index);
  return toBase64(Y.encodeRelativePosition(rel));
}

/**
 * Where an anchor sits in this document now, or null when it cannot be placed.
 *
 * Null — never a throw — for anything malformed, and for an anchor that
 * resolves into a different type. The state it came in is someone else's, and
 * one peer's bad pointer must not stop us drawing everyone else's (WIRE-093).
 */
export function resolveAnchor(ytext: Y.Text, at: RelPos): number | null {
  try {
    const doc = ytext.doc;
    if (!doc) return null;
    const rel = Y.decodeRelativePosition(fromBase64(at));
    const abs = Y.createAbsolutePositionFromRelativePosition(rel, doc);
    if (!abs || abs.type !== ytext) return null;
    return abs.index;
  } catch {
    return null;
  }
}

/**
 * Whether a pointer of this type is pointing when it moves (WIRE-092). A finger
 * has no hover: a touch "move" is a tap or a scroll, and sending it would show a
 * pointer the person never meant to point with. A mouse or a pen hovers.
 */
export function pointsByHovering(pointerType: string): boolean {
  return pointerType !== 'touch';
}

/**
 * Where the arrow's tip goes, in character widths from the anchor.
 *
 * On the text, the tip points at the middle of the character the mouse is
 * over (second appearance review). `posAtCoords` returns the nearest position
 * *between* characters, so a mouse on the right half of a letter anchors after
 * it with a negative offset; `floor` picks out that letter either way. Off the
 * text — into the margin, past the end of a line — the offset is kept as sent,
 * so the pointer does not snap back onto the last letter.
 */
export function tipOffset(dx: number): number {
  return Math.abs(dx) < 1 ? Math.floor(dx) + 0.5 : dx;
}

/** Round and clamp an offset in character widths; zero means "on the character". */
export function quantiseDx(dx: number): number {
  if (!Number.isFinite(dx)) return 0;
  const q = Math.round(dx / DX_STEP) * DX_STEP;
  return Math.max(-DX_MAX, Math.min(DX_MAX, q)) || 0;
}

const keyOf = (p: TextPointer | null): string => (p ? `${p.at}|${p.dx ?? 0}` : '');

export interface PointerSenderDeps {
  /** Write the pointer into the local awareness state. */
  publish(pointer: TextPointer | null): void;
  /** The pointer currently in the local state — compared against, so a resend is never a no-op on the wire. */
  current(): TextPointer | null;
  /** The "Share my mouse pointer" setting, read live. */
  enabled(): boolean;
  setTimeout(cb: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
}

/**
 * Throttles pointer moves into awareness writes (WIRE-091, WIRE-092).
 *
 * The first move of a quiet window goes at once, so a pointer that starts
 * moving is seen to move without a delay. Moves inside the window are held and
 * only the latest is sent when it closes — the same shape as the server's
 * coalescing, so the two never disagree about what "latest" was.
 *
 * Unchanged positions are never sent. The comparison is against what the local
 * state actually holds rather than a private copy, so a pointer cleared by
 * someone else (the setting's own handler, an unbind) is not mistaken for one
 * still showing.
 */
export class PointerSender {
  private timer: TimerHandle | null = null;
  /** The latest move held for the end of the window; undefined when none is held. */
  private held: TextPointer | undefined;

  constructor(private readonly deps: PointerSenderDeps) {}

  move(pointer: TextPointer): void {
    if (!this.deps.enabled()) {
      // Sharing was turned off while a pointer was out: withdraw it rather than
      // leave the last position showing on everyone else's screen.
      this.leave();
      return;
    }
    if (this.timer !== null) {
      this.held = pointer;
      return;
    }
    this.send(pointer);
  }

  /** The mouse left the editor, or sharing stopped: clear at once, and drop anything held. */
  leave(): void {
    this.cancel();
    if (this.deps.current() !== null) this.deps.publish(null);
  }

  /** The editor is going away. Its state is being nulled by the unbind, so publish nothing. */
  destroy(): void {
    this.cancel();
  }

  private send(pointer: TextPointer): void {
    if (keyOf(pointer) === keyOf(this.deps.current())) return;
    this.deps.publish(pointer);
    this.timer = this.deps.setTimeout(() => this.closeWindow(), POINTER_WINDOW_MS);
  }

  private closeWindow(): void {
    this.timer = null;
    const held = this.held;
    this.held = undefined;
    if (held === undefined || !this.deps.enabled()) return;
    this.send(held);
  }

  private cancel(): void {
    if (this.timer !== null) this.deps.clearTimeout(this.timer);
    this.timer = null;
    this.held = undefined;
  }
}

export interface PointerToDraw {
  clientId: number;
  /** The anchor as sent, so a marker can tell "moved" from "the text around it moved". */
  at: RelPos;
  index: number;
  dx: number;
  name: string;
  color: string;
}

/**
 * The remote pointers that belong in this note, in a stable order (WIRE-093).
 *
 * Never our own client's: y-protocols keeps our state in the same map, and a
 * pointer drawn under your own mouse is noise. Only text pointers that resolve
 * into this `Y.Text` — anything else is a surface we do not draw, or a state
 * from a document we are not looking at.
 */
export function pointersToDraw(
  states: ReadonlyMap<number, unknown>,
  ownClientId: number,
  ytext: Y.Text,
): PointerToDraw[] {
  const out: PointerToDraw[] = [];
  for (const [clientId, raw] of states) {
    if (clientId === ownClientId) continue;
    const state = readPresence(raw);
    const pointer = state?.pointer;
    if (!state?.user || pointer?.surface !== 'text') continue;
    const index = resolveAnchor(ytext, pointer.at);
    if (index === null) continue;
    out.push({
      clientId,
      at: pointer.at,
      index,
      dx: pointer.dx ?? 0,
      name: state.user.name,
      color: state.user.color,
    });
  }
  return out.sort((a, b) => a.clientId - b.clientId);
}

/** A remote text cursor, placed for an edge indicator. */
export interface CaretToDraw {
  clientId: number;
  index: number;
  name: string;
  color: string;
}

/**
 * Other people's text cursors that resolve into this note (WIRE-093 applies
 * to these as it does to pointers).
 *
 * y-codemirror writes `cursor` as `{ anchor, head }`, each a relative position
 * in its JSON form, and sets it to null while that person's window is not
 * focused. The head is where the caret is drawn, so it is what is placed.
 */
export function caretsToDraw(
  states: ReadonlyMap<number, unknown>,
  ownClientId: number,
  ytext: Y.Text,
): CaretToDraw[] {
  const doc = ytext.doc;
  if (!doc) return [];
  const out: CaretToDraw[] = [];
  for (const [clientId, raw] of states) {
    if (clientId === ownClientId) continue;
    const caret = caretIn(raw, doc);
    if (!caret || caret.type !== ytext) continue;
    out.push({ clientId, index: caret.head, name: caret.name, color: caret.color });
  }
  return out.sort((a, b) => a.clientId - b.clientId);
}

/** A collaborator's selected text in one `Y.Text`: `from` before `to`, never empty. */
export interface SelectionToDraw {
  clientId: number;
  from: number;
  to: number;
  /** Their colour at the alpha a note's selection is tinted with (`colorLight`). */
  tint: string;
}

/**
 * Other people's selections that lie in `ytext` — the other half of the
 * `cursor` a caret is drawn from. A note gets these from y-codemirror; a
 * canvas card draws its own (card-caret.ts, canvas-presence.ts). A bare
 * caret is not a selection, and is not in this list.
 */
export function selectionsToDraw(
  states: ReadonlyMap<number, unknown>,
  ownClientId: number,
  ytext: Y.Text,
): SelectionToDraw[] {
  const doc = ytext.doc;
  if (!doc) return [];
  const out: SelectionToDraw[] = [];
  for (const [clientId, raw] of states) {
    if (clientId === ownClientId) continue;
    const caret = caretIn(raw, doc);
    if (!caret || caret.type !== ytext || caret.anchor === caret.head) continue;
    out.push({
      clientId,
      from: Math.min(caret.anchor, caret.head),
      to: Math.max(caret.anchor, caret.head),
      tint: caret.colorLight,
    });
  }
  return out.sort((a, b) => a.clientId - b.clientId);
}

/**
 * Where "go to" a collaborator lands in a note: their caret, since in text
 * that is where they are working; their mouse pointer when they have no caret
 * here (their window is not focused, and y-codemirror withdraws the caret
 * then); null when they have neither in this note. The kind says whether it
 * is an editing position — only a caret is worth putting ours at.
 */
export function goToInNote(
  states: ReadonlyMap<number, unknown>,
  ownClientId: number,
  ytext: Y.Text,
  name: string,
): { index: number; kind: 'caret' | 'pointer' } | null {
  const caret = caretsToDraw(states, ownClientId, ytext).find((c) => c.name === name);
  if (caret) return { index: caret.index, kind: 'caret' };
  const pointer = pointersToDraw(states, ownClientId, ytext).find((p) => p.name === name);
  return pointer ? { index: pointer.index, kind: 'pointer' } : null;
}

/**
 * Where one person's caret is in `doc`: the type it lies in, its head (where
 * the caret is drawn) and its anchor (the other end of what they have
 * selected), with who they are. Null for no caret, no user, or a head that does
 * not resolve here. The type is what says which note — or which canvas card —
 * the caret is in. An anchor that does not resolve into that same type is
 * taken as the head: a caret with no selection, never an error.
 */
export function caretIn(
  raw: unknown,
  doc: Y.Doc,
): { type: Y.AbstractType<unknown>; head: number; anchor: number; name: string; color: string; colorLight: string } | null {
  const state = readPresence(raw);
  const cursor = state?.cursor as { head?: unknown; anchor?: unknown } | null | undefined;
  if (!state?.user || cursor?.head == null) return null;
  const at = (rel: unknown): Y.AbsolutePosition | null => {
    try {
      return Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(rel), doc);
    } catch {
      return null;
    }
  };
  const head = at(cursor.head);
  if (!head) return null;
  const anchor = cursor.anchor == null ? null : at(cursor.anchor);
  return {
    type: head.type,
    head: head.index,
    anchor: anchor?.type === head.type ? anchor.index : head.index,
    name: state.user.name,
    color: state.user.color,
    colorLight: state.user.colorLight,
  };
}

/**
 * What the layer draws of pointers: nothing at all while "Show collaborators'
 * mouse pointers" is off. A local noise switch — it never reaches
 * `PointerSender`, so hiding theirs does not stop sending yours. Carets are not
 * behind it: the caret itself is always drawn, so its edge indicator is too.
 */
export function visiblePointers(
  options: Pick<RemotePointerOptions, 'showPointers'>,
  states: ReadonlyMap<number, unknown>,
  ownClientId: number,
  ytext: Y.Text,
): PointerToDraw[] {
  return options.showPointers() ? pointersToDraw(states, ownClientId, ytext) : [];
}

/** Which side of the view a marker is pinned to, or null when its text is in view. */
export type Edge = 'top' | 'bottom' | 'left' | 'right';

export interface Rect { left: number; top: number; right: number; bottom: number }

/** How far inside the view a pinned indicator's tracked coordinate is kept. */
const EDGE_PAD = 8;

/**
 * Where to draw something whose text is at `target`, given the visible part of
 * the note: at the text itself when it is in view, and otherwise pinned to the
 * edge it lies beyond, still following the other coordinate.
 *
 * A character below and to the left of the view gives an indicator on the
 * bottom edge, left of centre, above where that character would be; point at
 * something further right and it slides right along the bottom. Above and below
 * win over left and right: a note scrolls vertically far more often than it
 * scrolls sideways, so that is the direction worth saying.
 *
 * All coordinates are client (viewport) pixels.
 */
export function placePointer(
  target: { x: number; y: number; h: number },
  visible: Rect,
): { x: number; y: number; edge: Edge | null } {
  const clampX = (x: number) =>
    Math.max(visible.left + EDGE_PAD, Math.min(visible.right - EDGE_PAD, x));
  const clampY = (y: number) =>
    Math.max(visible.top + EDGE_PAD, Math.min(visible.bottom - EDGE_PAD, y));
  if (target.y + target.h <= visible.top) return { x: clampX(target.x), y: visible.top, edge: 'top' };
  if (target.y >= visible.bottom) return { x: clampX(target.x), y: visible.bottom, edge: 'bottom' };
  if (target.x < visible.left) return { x: visible.left, y: clampY(target.y), edge: 'left' };
  if (target.x > visible.right) return { x: visible.right, y: clampY(target.y), edge: 'right' };
  return { x: target.x, y: target.y, edge: null };
}

/**
 * The people whose pointer and caret are pinned to the same edge. Each is
 * drawn as one indicator, at the pointer, carrying both marks: two pills for
 * one person on one edge overlapped (first appearance review).
 */
export function sharedEdges(
  pointers: readonly { clientId: number; edge: Edge | null }[],
  carets: readonly { clientId: number; edge: Edge | null }[],
): Set<number> {
  const pointerEdge = new Map(pointers.filter((p) => p.edge !== null).map((p) => [p.clientId, p.edge]));
  return new Set(carets.filter((c) => c.edge !== null && pointerEdge.get(c.clientId) === c.edge).map((c) => c.clientId));
}

/**
 * Where a character is on screen, in client pixels — exactly when CodeMirror has
 * rendered it, and estimated when it has not.
 *
 * CodeMirror renders only the viewport plus a margin, so for text far above or
 * below, `coordsAtPos` has nothing to measure. Its height map does cover every
 * line, so the line's top is known; the horizontal position is estimated from
 * the column in character widths, wrapped at the content width when lines wrap.
 * "Where that text would be" is exactly what an edge indicator needs, and a few
 * pixels of error on a proportional font does not change which side it is on.
 */
function estimateCoords(view: EditorView, pos: number, dx: number): { x: number; y: number; h: number } {
  const cw = view.defaultCharacterWidth;
  const exact = view.coordsAtPos(pos, 1);
  const tip = tipOffset(dx);
  if (exact) return { x: exact.left + tip * cw, y: exact.top, h: exact.bottom - exact.top };
  const block = view.lineBlockAt(pos);
  const line = view.state.doc.lineAt(pos);
  const content = view.contentDOM.getBoundingClientRect();
  const lh = view.defaultLineHeight;
  let col = pos - line.from;
  let row = 0;
  if (view.lineWrapping) {
    const perRow = Math.max(1, Math.floor(content.width / cw));
    const rows = Math.max(1, Math.round(block.height / lh));
    row = Math.min(rows - 1, Math.floor(col / perRow));
    col %= perRow;
  }
  return { x: content.left + (col + tip) * cw, y: view.documentTop + block.top + row * lh, h: lh };
}

/** Tells the layer to re-read presence. */
const refreshPointers = StateEffect.define<null>();

/** How long a pointer that has stopped moving stays before it fades. Mirrored by the CSS animation delay. */
export const POINTER_FADE_MS = 3000;

/**
 * When each person's pointer last really moved — to a different anchor.
 *
 * The fade is timed from here rather than from when an element was drawn.
 * CodeMirror matches a layer's markers to its DOM nodes by position in the
 * list, so when someone else's marker appears or goes, every marker after it
 * is drawn afresh; a fade timed from the element restarted, and a pointer that
 * stopped a minute ago came back for three seconds (found in review).
 */
export class MoveClock {
  private readonly seen = new Map<number, { key: string; at: number }>();

  /** When `clientId`'s pointer last moved, given that it now sits at `key`. */
  movedAt(clientId: number, key: string, now: number): number {
    const last = this.seen.get(clientId);
    if (last?.key === key) return last.at;
    this.seen.set(clientId, { key, at: now });
    return now;
  }

  /** Drop people no longer pointing, so a later return counts as a move. */
  keepOnly(present: ReadonlySet<number>): void {
    for (const id of this.seen.keys()) if (!present.has(id)) this.seen.delete(id);
  }
}

/**
 * The CSS animation delay that puts a fade at the right point for a pointer
 * that moved at `movedAt`. Negative once the hold has passed, which a CSS
 * animation reads as "already this far in" — past its end, with
 * `animation-fill-mode: forwards`, it is simply faded.
 */
export function fadeDelayMs(movedAt: number, now: number): number {
  return POINTER_FADE_MS - (now - movedAt);
}

/**
 * The pointers and carets the layer draws in `view`, with `clock` pruned to
 * the pointers among them.
 *
 * The pruning has to happen here, before the layer's "nothing to draw" early
 * return: when the only pointer in a note is withdrawn (WIRE-092) the layer
 * draws nothing, and a clock left holding that pointer handed its old move time
 * back when the person pointed at the same character again — so the pointer
 * arrived already faded (NEC-112).
 *
 * A pane that is not bound to this note leaves the clock alone. The extension
 * is installed in the bound editor only (SAFE-D5), so this is a second line of
 * defence: the clock is the bound pane's, and pruning it from another pane
 * would restart the fade of a pointer that stopped long ago.
 */
export function pointersToMark(
  bound: boolean,
  options: Pick<RemotePointerOptions, 'showPointers'>,
  states: ReadonlyMap<number, unknown>,
  ownClientId: number,
  ytext: Y.Text,
  clock: MoveClock,
): { pointers: PointerToDraw[]; carets: CaretToDraw[] } {
  if (!bound) return { pointers: [], carets: [] };
  const alone = states.size < 2;
  const pointers = alone ? [] : visiblePointers(options, states, ownClientId, ytext);
  const carets = alone ? [] : caretsToDraw(states, ownClientId, ytext);
  clock.keepOnly(new Set(pointers.map((p) => p.clientId)));
  return { pointers, carets };
}

type MarkerKind = 'pointer' | 'caret';

export const EDGE_CLASSES: Record<Edge, string> = {
  top: 'nectenda-pointer-edge-top',
  bottom: 'nectenda-pointer-edge-bottom',
  left: 'nectenda-pointer-edge-left',
  right: 'nectenda-pointer-edge-right',
};

class PointerMarker implements LayerMarker {
  constructor(
    readonly kind: MarkerKind,
    readonly clientId: number,
    readonly anchor: string,
    readonly left: number,
    readonly top: number,
    readonly edge: Edge | null,
    readonly name: string,
    readonly color: string,
    /** A pointer indicator that also stands for this person's caret on the same edge. */
    readonly withCaret: boolean,
    /** How far below the tip the pointed-at line ends; the name is drawn below that. */
    readonly drop: number,
    /** When this person's pointer last moved (`MoveClock`); the fade is timed from it. */
    readonly movedAt: number,
  ) {}

  eq(other: LayerMarker): boolean {
    return (
      other instanceof PointerMarker &&
      other.kind === this.kind &&
      other.clientId === this.clientId &&
      other.anchor === this.anchor &&
      other.left === this.left &&
      other.top === this.top &&
      other.edge === this.edge &&
      other.name === this.name &&
      other.color === this.color &&
      other.withCaret === this.withCaret &&
      other.drop === this.drop &&
      other.movedAt === this.movedAt
    );
  }

  draw(): HTMLElement {
    const el = buildPointerMarker(this.clientId, this.name, this.color);
    if (this.kind === 'caret') el.classList.add('nectenda-pointer-caret');
    el.dataset.nectendaKind = this.kind;
    this.place(el);
    this.timeFade(el);
    return el;
  }

  /**
   * Keep one element per person and kind, so a pointer glides between
   * positions (a CSS transition) and slides onto an edge and back, rather than
   * blinking out and in. The fade is re-timed only when it could have changed:
   * a real move, or a pill that stopped (or started) standing for a caret.
   */
  update(dom: HTMLElement, oldMarker: LayerMarker): boolean {
    if (
      !(oldMarker instanceof PointerMarker) ||
      oldMarker.clientId !== this.clientId ||
      oldMarker.kind !== this.kind
    ) {
      return false;
    }
    if (oldMarker.color !== this.color) dom.style.setProperty('--nectenda-pointer-colour', this.color);
    if (oldMarker.name !== this.name) {
      const label = dom.querySelector('.nectenda-pointer-name');
      if (label) label.textContent = this.name;
    }
    this.place(dom);
    if (oldMarker.movedAt !== this.movedAt || oldMarker.withCaret !== this.withCaret) this.timeFade(dom);
    return true;
  }

  /**
   * Start the fade at the point `movedAt` puts it, whether this element is new
   * or reused. Clearing the animation, flushing styles and putting it back is
   * the only way to replay a CSS animation on the same element; the negative
   * delay then puts it at the right phase rather than at the start.
   *
   * Written through `setCssStyles` rather than `el.style` because the community
   * directory's `no-static-styles-assignment` rule reads the two literal
   * assignments as styling in JavaScript, and an Error there fails a release —
   * it failed 0.2.0. The runtime behaviour is identical: `setCssStyles` is a
   * thin wrapper over `el.style`. The animation itself lives in `styles.css`
   * and always did.
   *
   * A class toggle would satisfy the rule more obviously and cannot be used
   * here: the delay has to be set in the same frame as the restart, and the
   * reflow between the two writes is what makes the browser notice the change
   * at all. Removing either line silently stops the fade replaying on a reused
   * pointer, which looks like a pointer that never fades.
   */
  private timeFade(el: HTMLElement): void {
    if (this.kind !== 'pointer') return;
    el.setCssStyles({ animation: 'none' });
    void el.offsetWidth;
    el.setCssStyles({ animation: '' });
    el.style.animationDelay = `${fadeDelayMs(this.movedAt, performance.now())}ms`;
  }

  private place(el: HTMLElement): void {
    el.style.left = `${this.left}px`;
    el.style.top = `${this.top}px`;
    el.style.setProperty('--nectenda-pointer-drop', `${this.drop}px`);
    setPointerEdge(el, this.edge);
    // A merged indicator never fades: the caret it also stands for is still
    // there after the pointer comes to rest.
    if (this.withCaret) el.classList.add('nectenda-pointer-with-caret');
    else el.classList.remove('nectenda-pointer-with-caret');
  }
}

/**
 * A collaborator's pointer as it looks everywhere: an arrow whose tip is the
 * element's origin, a chevron shown instead while pinned to an edge, and the
 * name. Detached, so a CodeMirror layer marker can return it; the canvas
 * overlay appends it (canvas-presence.ts). One builder, so a note and a canvas
 * cannot drift apart in how a person's pointer looks.
 */
export function buildPointerMarker(clientId: number, name: string, color: string): HTMLElement {
  // `createDiv`/`createSpan` rather than `document.createElement`, which the
  // directory's `prefer-create-el` rule reports. The globals are used rather
  // than the element methods because a CodeMirror `LayerMarker` has to return
  // a detached element — there is no parent yet to call `.createDiv()` on.
  const el = createDiv();
  el.classList.add('nectenda-pointer');
  el.setAttribute('aria-hidden', 'true');
  el.dataset.nectendaClient = String(clientId);
  el.style.setProperty('--nectenda-pointer-colour', color);
  el.appendChild(svgPath('nectenda-pointer-arrow', '0 0 12 16', 'M1 1 L1 13.5 L4.2 10.6 L6.6 15 L8.6 14 L6.3 9.7 L10.8 9.7 Z'));
  // Points up; the edge classes rotate it towards what it stands for.
  el.appendChild(svgPath('nectenda-pointer-chevron', '0 0 16 10', 'M1.5 9 L8 1.5 L14.5 9 Z'));
  const label = el.createSpan({ cls: 'nectenda-pointer-name' });
  label.textContent = name;
  return el;
}

/** Pin a pointer marker to `edge`, or unpin it: the classes the stylesheet turns into a chevron. */
export function setPointerEdge(el: HTMLElement, edge: Edge | null): void {
  for (const [side, cls] of Object.entries(EDGE_CLASSES)) {
    if (side === edge) el.classList.add(cls);
    else el.classList.remove(cls);
  }
  if (edge) el.classList.add('nectenda-pointer-edge');
  else el.classList.remove('nectenda-pointer-edge');
}

function svgPath(cls: string, viewBox: string, d: string): SVGSVGElement {
  // `createSvg`, not `createElementNS`: Obsidian's helper is typed over
  // SVGElementTagNameMap, so it returns SVGSVGElement here and SVGPathElement
  // below without a cast, and it is what the directory's `prefer-create-el`
  // rule asks for.
  const svg = createSvg('svg', { cls, attr: { viewBox } });
  svg.createSvg('path', { attr: { d } });
  return svg;
}

/**
 * The layer's origin, as CodeMirror's own `RectangleMarker` computes it: a
 * layer is positioned inside the scroller, so viewport coordinates are shifted
 * by the scroller's box and its scroll offset.
 */
function layerBase(view: EditorView): { left: number; top: number } {
  const rect = view.scrollDOM.getBoundingClientRect();
  return {
    left: rect.left - view.scrollDOM.scrollLeft * view.scaleX,
    top: rect.top - view.scrollDOM.scrollTop * view.scaleY,
  };
}

export interface RemotePointerOptions {
  /** "Share my mouse pointer" — a privacy setting. Read live. */
  sharePointer(): boolean;
  /** "Show collaborators' mouse pointers" — a local noise setting. Read live. */
  showPointers(): boolean;
  /**
   * Whether `view` is the editor this note is bound to. The extension is
   * installed in that editor only (SAFE-D5); this is kept as a second line,
   * because it once reached every pane in the workspace, and a pane showing a
   * different note must neither draw this note's pointers at its own positions
   * nor send a pointer anchored in text it is not showing.
   */
  isBound(view: EditorView): boolean;
}

export interface RemotePointers {
  extension: Extension;
  /** Redraw every editor carrying this extension, after `showPointers` changes. */
  refresh(): void;
}

/**
 * Send this editor's pointer, and draw everyone else's pointers and the edge
 * indicators for their off-screen pointers and carets, for one note.
 *
 * Built per bind, with that note's `Y.Text` and awareness, beside `yCollab`.
 */
export function remotePointers(
  ytext: Y.Text,
  awareness: Awareness,
  options: RemotePointerOptions,
): RemotePointers {
  const views = new Set<EditorView>();
  const clock = new MoveClock();
  const refreshAll = () => {
    for (const view of views) view.dispatch({ effects: refreshPointers.of(null) });
  };

  const tracker = ViewPlugin.fromClass(
    class implements PluginValue {
      private readonly sender: PointerSender;
      private readonly onMove: (e: PointerEvent) => void;
      private readonly onLeave: () => void;
      private readonly onScroll: () => void;
      private readonly onAwareness: (changes: { added: number[]; updated: number[]; removed: number[] }) => void;
      private frame: number | null = null;
      private warnedUnbound = false;

      constructor(private readonly view: EditorView) {
        views.add(view);
        this.sender = new PointerSender({
          // setLocalStateField is a no-op on a null state, which is what an
          // unbound or background-synced document holds, so a send that races
          // an unbind cannot bring a departed user back.
          publish: (pointer) => awareness.setLocalStateField('pointer', pointer),
          current: () => {
            const p = readPresence(awareness.getLocalState())?.pointer ?? null;
            return p?.surface === 'text' ? p : null;
          },
          enabled: () => options.sharePointer(),
          setTimeout: (cb, ms) => window.setTimeout(cb, ms),
          clearTimeout: (h) => window.clearTimeout(h),
        });

        this.onMove = (e) => {
          if (!pointsByHovering(e.pointerType)) return;
          if (!options.isBound(view)) {
            // Once per editor. Unreachable while the extension is installed in
            // the bound editor only (SAFE-D5); if it is ever reached again,
            // moving over another note's pane must still send nothing.
            if (!this.warnedUnbound) {
              this.warnedUnbound = true;
              log.debug('Pointer over an editor this note is not bound to; not sending it');
            }
            return;
          }
          let pos = view.posAtCoords({ x: e.clientX, y: e.clientY }, false);
          // Past the end of a soft-wrapped row, the nearest position is also
          // the start of the next row, and measuring from there sent a large
          // offset that drew the pointer on the next row, far right (found in
          // review). Anchor to the row's last character instead, so the
          // offset is measured on the row the mouse is on.
          const before = pos > 0 ? view.coordsAtPos(pos, -1) : null;
          const after = view.coordsAtPos(pos, 1);
          if (before && after && before.top !== after.top && e.clientY < before.bottom) pos -= 1;
          const at = view.coordsAtPos(pos, 1);
          const dx = at ? quantiseDx((e.clientX - at.left) / view.defaultCharacterWidth) : 0;
          const pointer: TextPointer = { surface: 'text', at: anchorAt(ytext, pos) };
          if (dx !== 0) pointer.dx = dx;
          this.sender.move(pointer);
        };
        this.onLeave = () => {
          log.debug('Pointer left the editor; withdrawing it', { bound: options.isBound(view) });
          this.sender.leave();
        };
        // The scroller, not the content: the margins either side of a readable
        // line length are where people point from, and they are outside
        // `contentDOM`.
        view.scrollDOM.addEventListener('pointermove', this.onMove);
        view.scrollDOM.addEventListener('pointerleave', this.onLeave);

        // An edge indicator is pinned to the view, and the layer scrolls with
        // the text, so it has to be re-placed as this person scrolls. A scroll
        // that moves no further than the rendered margin is not a CodeMirror
        // viewport change, so the layer would not otherwise hear of it. Once a
        // frame, and only while anyone else is here.
        this.onScroll = () => {
          if (this.frame !== null || awareness.getStates().size < 2) return;
          this.frame = window.requestAnimationFrame(() => {
            this.frame = null;
            view.dispatch({ effects: refreshPointers.of(null) });
          });
        };
        view.scrollDOM.addEventListener('scroll', this.onScroll, { passive: true });

        // Only other people's changes redraw. Our own state changes inside
        // CodeMirror's update cycle (y-codemirror writes the caret from its
        // plugin's update), and dispatching from there throws. Nothing of ours
        // is drawn anyway.
        this.onAwareness = ({ added, updated, removed }) => {
          const others = [...added, ...updated, ...removed].some((id) => id !== awareness.clientID);
          if (others) view.dispatch({ effects: refreshPointers.of(null) });
        };
        awareness.on('change', this.onAwareness);
      }

      destroy(): void {
        views.delete(this.view);
        this.view.scrollDOM.removeEventListener('pointermove', this.onMove);
        this.view.scrollDOM.removeEventListener('pointerleave', this.onLeave);
        this.view.scrollDOM.removeEventListener('scroll', this.onScroll);
        if (this.frame !== null) window.cancelAnimationFrame(this.frame);
        awareness.off('change', this.onAwareness);
        this.sender.destroy();
      }
    },
  );

  const drawn = layer({
    above: true,
    class: 'nectenda-pointer-layer',
    update: (update) =>
      update.docChanged ||
      update.viewportChanged ||
      update.geometryChanged ||
      update.transactions.some((tr) => tr.effects.some((e) => e.is(refreshPointers))),
    markers: (view) => {
      const { pointers, carets } = pointersToMark(options.isBound(view), options, awareness.getStates(), awareness.clientID, ytext, clock);
      if (pointers.length === 0 && carets.length === 0) return [];

      const base = layerBase(view);
      const s = view.scrollDOM.getBoundingClientRect();
      const visible: Rect = { left: s.left, top: s.top, right: s.left + view.scrollDOM.clientWidth, bottom: s.top + view.scrollDOM.clientHeight };
      // Obsidian's status bar floats over the bottom of the editor rather than
      // sitting beneath it, so an indicator pinned to the scroller's bottom was
      // drawn under it — found in the first review screenshots. Lift the edge
      // above the bar wherever the two overlap.
      const bar = view.dom.ownerDocument.querySelector('.status-bar')?.getBoundingClientRect();
      if (bar && bar.height > 0 && bar.top < visible.bottom && bar.bottom > visible.top && bar.left < visible.right && bar.right > visible.left) {
        visible.bottom = bar.top;
      }
      const docLength = view.state.doc.length;
      const toLayer = (x: number, y: number) => ({
        left: (x - base.left) / view.scaleX,
        top: (y - base.top) / view.scaleY,
      });
      const markers: PointerMarker[] = [];

      type Placed = { clientId: number; x: number; y: number; edge: Edge | null };
      const pointerPlaces: (Placed & { drop: number; p: PointerToDraw })[] = [];
      for (const p of pointers) {
        // The Y.Text and the editor hold the same characters (y-codemirror's
        // contract), but a remote insert can reach one a moment before the
        // other. A position past the end is simply not drawn this frame.
        if (p.index > docLength) continue;
        const est = estimateCoords(view, p.index, p.dx);
        const placed = placePointer(est, visible);
        // In view, the tip points at the middle of the character, and the
        // name hangs below the line just to its right, so the pill never covers
        // the line being pointed at (second appearance review). `drop` is how
        // far below the tip the line ends.
        const inView = placed.edge === null;
        const y = inView ? est.y + est.h / 2 : placed.y;
        pointerPlaces.push({ clientId: p.clientId, x: placed.x, y, edge: placed.edge, drop: inView ? est.h / 2 : 0, p });
      }
      const caretPlaces: (Placed & { c: CaretToDraw })[] = [];
      for (const c of carets) {
        if (c.index > docLength) continue;
        const placed = placePointer(estimateCoords(view, c.index, 0), visible);
        // In view, y-codemirror draws the caret; only an off-screen one needs us.
        if (placed.edge === null) continue;
        caretPlaces.push({ clientId: c.clientId, x: placed.x, y: placed.y, edge: placed.edge, c });
      }
      const merged = sharedEdges(pointerPlaces, caretPlaces);
      const now = performance.now();
      clock.keepOnly(new Set(pointerPlaces.map((pl) => pl.clientId)));
      for (const { p, x, y, edge, drop } of pointerPlaces) {
        const at = toLayer(x, y);
        const key = `${p.at}|${p.dx}`;
        markers.push(new PointerMarker('pointer', p.clientId, key, at.left, at.top, edge, p.name, p.color, merged.has(p.clientId), drop / view.scaleY, clock.movedAt(p.clientId, key, now)));
      }
      for (const { c, x, y, edge } of caretPlaces) {
        if (merged.has(c.clientId)) continue;
        const at = toLayer(x, y);
        markers.push(new PointerMarker('caret', c.clientId, '', at.left, at.top, edge, c.name, c.color, false, 0, 0));
      }
      return markers;
    },
  });

  return { extension: [tracker, drawn], refresh: refreshAll };
}
