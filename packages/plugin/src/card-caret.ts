import * as Y from 'yjs';
import { EditorSelection, StateEffect } from '@codemirror/state';
import { EditorView, RectangleMarker, type LayerMarker } from '@codemirror/view';
import type { Awareness } from 'y-protocols/awareness';
import { caretsToDraw, selectionsToDraw, type CaretToDraw, type SelectionToDraw } from './remote-pointer';
import { log } from './logger';

/**
 * Other people's carets inside a canvas card, and this person's own caret sent
 * for them (WIRE-095).
 *
 * A note gets both from y-codemirror. A card editor is bound by our own plugin
 * (canvas-card-binding.ts), so it does this itself, in the same shape: the
 * canvas document's awareness `cursor`, as `{ anchor, head }` relative
 * positions in their JSON form. The canvas state never carried `cursor` before
 * — the board is not a text editor — and a relative position names the
 * `Y.Text` it belongs to, which is one card's. So "which card" needs no field
 * of its own, and a caret in one card can never be drawn in another, or in a
 * note (WIRE-093).
 *
 * What Relay learned drawing card carets, and is done here:
 *
 * - **Withdrawn when the card editor closes**, not only when the canvas does,
 *   or it lingers on the last card someone typed in.
 * - **Awareness is written outside the editor's update.** Writing it inside
 *   runs every awareness listener there, and any of them that dispatches —
 *   another editor's redraw, this one's — throws inside CodeMirror's update.
 *   So writes and redraws are queued to a microtask.
 *
 * Presentation only: nothing here writes to a `Y.Text`, an editor's document
 * or the disk.
 */

/** A caret as y-codemirror writes it: two relative positions, in JSON form. */
export interface CaretJSON {
  anchor: unknown;
  head: unknown;
}

/** The caret for a selection from `anchor` to `head` in `ytext`. */
export function caretOf(ytext: Y.Text, anchor: number, head: number): CaretJSON {
  return {
    anchor: Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(ytext, anchor)),
    head: Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(ytext, head)),
  };
}

/** Redraws a card editor's caret layer after someone else's caret changed. */
export const refreshCardCarets = StateEffect.define<null>();

/**
 * One card editor's share of the canvas awareness: sends its caret while it
 * has focus, and hears when anyone else's changes.
 *
 * Several card editors can be open on one canvas, all writing the same
 * `cursor`. Only the focused one holds it, so a card editor clears the field
 * only while it still holds what this one wrote — a blur arriving after the
 * next card took focus must not clear the new card's caret.
 */
export class CardCaret {
  /** What this card editor last wrote; the local state holds exactly this object while it is ours. */
  private written: CaretJSON | null = null;
  /** The caret wanted, and its key; null and '' while the card editor has no focus. */
  private wanted: CaretJSON | null = null;
  private wantedKey = '';
  private writeQueued = false;
  private redrawQueued = false;
  private stopped = false;
  private readonly onChange = ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }): void => {
    if ([...added, ...updated, ...removed].some((id) => id !== this.awareness.clientID)) this.queueRedraw();
  };

  constructor(
    readonly ytext: Y.Text,
    private readonly awareness: Awareness,
    /** Dispatch the redraw. Called from a microtask, never inside an update. */
    private readonly redraw: () => void,
  ) {
    awareness.on('change', this.onChange);
  }

  /**
   * The card editor's selection now. Sent while it has focus; withdrawn when it
   * does not. Unchanged, it is not written again.
   */
  sync(focused: boolean, anchor: number, head: number): void {
    if (this.stopped) return;
    const caret = focused ? caretOf(this.ytext, anchor, head) : null;
    const key = caret ? JSON.stringify(caret) : '';
    if (key === this.wantedKey) return;
    this.wanted = caret;
    this.wantedKey = key;
    this.queueWrite();
  }

  /** The other people's carets that belong in this card (WIRE-093). */
  carets(): CaretToDraw[] {
    if (this.stopped) return [];
    return caretsToDraw(this.awareness.getStates(), this.awareness.clientID, this.ytext);
  }

  /** What the other people have selected in this card: the rest of the `cursor` a caret is drawn from. */
  selections(): SelectionToDraw[] {
    if (this.stopped) return [];
    return selectionsToDraw(this.awareness.getStates(), this.awareness.clientID, this.ytext);
  }

  /**
   * The card editor closed or let go of its text: stop listening, and withdraw
   * the caret if it is still ours. Deferred like every write, because this is
   * called from inside CodeMirror's update and destroy.
   */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.awareness.off('change', this.onChange);
    const written = this.written;
    this.written = null;
    queueMicrotask(() => this.withdraw(written));
  }

  private queueWrite(): void {
    if (this.writeQueued) return;
    this.writeQueued = true;
    queueMicrotask(() => {
      this.writeQueued = false;
      if (this.stopped) return;
      try {
        if (this.wanted) {
          this.awareness.setLocalStateField('cursor', this.wanted);
          this.written = this.wanted;
        } else {
          this.withdraw(this.written);
          this.written = null;
        }
      } catch (err) {
        log.debug('Could not send the caret in a canvas card', { error: String(err) });
      }
    });
  }

  /** Clear `cursor` if it still holds `mine` — and nothing another card editor wrote since. */
  private withdraw(mine: CaretJSON | null): void {
    if (!mine) return;
    const state = this.awareness.getLocalState() as { cursor?: unknown } | null;
    if (state?.cursor !== mine) return;
    try {
      this.awareness.setLocalStateField('cursor', null);
    } catch (err) {
      log.debug('Could not withdraw the caret in a canvas card', { error: String(err) });
    }
  }

  private queueRedraw(): void {
    if (this.redrawQueued || this.stopped) return;
    this.redrawQueued = true;
    queueMicrotask(() => {
      this.redrawQueued = false;
      if (this.stopped) return;
      try {
        this.redraw();
      } catch (err) {
        log.debug('Could not redraw carets in a canvas card', { error: String(err) });
      }
    });
  }
}

/** One other person's caret in a card, placed in the layer's coordinates. */
export class CardCaretMarker implements LayerMarker {
  constructor(
    readonly clientId: number,
    readonly left: number,
    readonly top: number,
    readonly height: number,
    readonly name: string,
    readonly color: string,
  ) {}

  eq(other: CardCaretMarker): boolean {
    return other.clientId === this.clientId && other.left === this.left && other.top === this.top
      && other.height === this.height && other.name === this.name && other.color === this.color;
  }

  draw(): HTMLElement {
    // Obsidian's global `createDiv`, as in remote-pointer.ts: a layer marker
    // draws a detached element, so there is no parent to call it on.
    const el = createDiv({ cls: 'nectenda-card-caret' });
    this.place(el);
    const label = el.createDiv({ cls: 'nectenda-card-caret-name', text: this.name });
    label.style.backgroundColor = this.color;
    return el;
  }

  update(el: HTMLElement, prev: CardCaretMarker): boolean {
    if (prev.clientId !== this.clientId || prev.name !== this.name || prev.color !== this.color) return false;
    this.place(el);
    return true;
  }

  private place(el: HTMLElement): void {
    el.style.left = `${this.left}px`;
    el.style.top = `${this.top}px`;
    el.style.height = `${this.height}px`;
    el.style.borderLeftColor = this.color;
  }
}

/** The markers for `carets` in `view`: in view only, and never past the end of what the editor holds. */
export function cardCaretMarkers(view: EditorView, carets: readonly CaretToDraw[]): CardCaretMarker[] {
  if (carets.length === 0) return [];
  const rect = view.scrollDOM.getBoundingClientRect();
  const baseLeft = rect.left - view.scrollDOM.scrollLeft * view.scaleX;
  const baseTop = rect.top - view.scrollDOM.scrollTop * view.scaleY;
  const out: CardCaretMarker[] = [];
  for (const c of carets) {
    // A remote insert can reach the Y.Text a moment before the editor shows
    // it; a position past the end is simply not drawn this frame.
    if (c.index > view.state.doc.length) continue;
    const at = view.coordsAtPos(c.index, 1) ?? view.coordsAtPos(c.index, -1);
    if (!at) continue;
    out.push(new CardCaretMarker(
      c.clientId,
      (at.left - baseLeft) / view.scaleX,
      (at.top - baseTop) / view.scaleY,
      (at.bottom - at.top) / view.scaleY,
      c.name,
      c.color,
    ));
  }
  return out;
}

/** One rectangle of another person's selection in a card, tinted with their `colorLight`. */
export class CardSelectionMarker implements LayerMarker {
  constructor(
    readonly clientId: number,
    readonly left: number,
    readonly top: number,
    readonly width: number,
    readonly height: number,
    readonly tint: string,
  ) {}

  eq(other: CardSelectionMarker): boolean {
    return other.clientId === this.clientId && other.left === this.left && other.top === this.top
      && other.width === this.width && other.height === this.height && other.tint === this.tint;
  }

  draw(): HTMLElement {
    const el = createDiv({ cls: 'nectenda-card-selection' });
    this.place(el);
    return el;
  }

  update(el: HTMLElement, prev: CardSelectionMarker): boolean {
    if (prev.clientId !== this.clientId) return false;
    this.place(el);
    return true;
  }

  private place(el: HTMLElement): void {
    el.style.left = `${this.left}px`;
    el.style.top = `${this.top}px`;
    el.style.width = `${this.width}px`;
    el.style.height = `${this.height}px`;
    el.style.backgroundColor = this.tint;
  }
}

/**
 * The rectangles for `selections` in `view`, as CodeMirror lays out its own
 * selection — wrapped lines and all — each re-issued in its person's tint,
 * which CodeMirror's own marker cannot carry. Clamped to what the editor
 * holds, as a caret is.
 */
export function cardSelectionMarkers(view: EditorView, selections: readonly SelectionToDraw[]): CardSelectionMarker[] {
  const out: CardSelectionMarker[] = [];
  const len = view.state.doc.length;
  for (const s of selections) {
    const from = Math.min(s.from, len);
    const to = Math.min(s.to, len);
    if (from >= to) continue;
    for (const r of RectangleMarker.forRange(view, 'nectenda-card-selection', EditorSelection.range(from, to))) {
      if (r.width === null || r.width <= 0) continue;
      out.push(new CardSelectionMarker(s.clientId, r.left, r.top, r.width, r.height, s.tint));
    }
  }
  return out;
}

/**
 * How a card caret looks: a 2px bar in the person's colour, set inline, with
 * their name above it, made to match a note's y-codemirror caret. It never
 * blinks — a blinking caret in someone else's colour reads as your own.
 *
 * A theme rather than styles.css, because the card editor lives in an iframe:
 * the plugin's stylesheet is loaded into Obsidian's document and never reaches
 * it, and a selector through `.canvas-node` cannot match across the frame
 * either. The caret was drawn with no width at all until the e2e measured it.
 * CodeMirror mounts a theme into the editor's own document, whichever that is
 * — which is how y-codemirror styles a note's carets.
 */
export const cardCaretTheme = EditorView.baseTheme({
  '.nectenda-card-caret-layer': {
    pointerEvents: 'none',
    zIndex: '103',
  },
  // Under the text, as a note's selection is, so the words stay readable
  // over the tint; the tint's own alpha is what makes it light.
  '.nectenda-card-selection-layer': {
    pointerEvents: 'none',
  },
  '.nectenda-card-selection': {
    position: 'absolute',
    pointerEvents: 'none',
  },
  '.nectenda-card-caret': {
    position: 'absolute',
    width: '0',
    marginLeft: '-1px',
    borderLeft: '2px solid var(--text-accent, #1A6580)',
    pointerEvents: 'none',
  },
  '.nectenda-card-caret-name': {
    position: 'absolute',
    left: '-2px',
    bottom: '100%',
    padding: '0 4px',
    fontFamily: 'var(--font-interface, inherit)',
    fontSize: '10px',
    fontWeight: '600',
    lineHeight: '1.4',
    borderRadius: '2px 2px 2px 0',
    whiteSpace: 'nowrap',
  },
  '&light .nectenda-card-caret-name': { color: '#ffffff' },
  '&dark .nectenda-card-caret-name': { color: '#14201b' },
});
