import * as Y from 'yjs';
import { Annotation, Transaction, type ChangeSpec, type EditorState, type Extension } from '@codemirror/state';
import { ViewPlugin, layer, type EditorView, type PluginValue, type ViewUpdate } from '@codemirror/view';
import type { CanvasLiveBinding } from './canvas-live';
import {
  CardCaret, cardCaretMarkers, cardCaretTheme, cardSelectionMarkers, refreshCardCarets,
  type CardCaretMarker, type CardSelectionMarker,
} from './card-caret';
import { mergeTextEdit } from './text-merge';
import { log } from './logger';

/**
 * The editor inside a canvas card, bound live to the card's Y.Text, so two
 * people typing in one card see each other's characters as they type.
 *
 * Relay does the same, and what went wrong for it and others shapes this:
 *
 * - **The Y.Text is the truth; the editor is brought to it.** An editor's text
 *   is never inserted into the Y.Text on binding — two editors doing that
 *   double the card (y-codemirror.next #23). Card editors are made and thrown
 *   away with each edit, so this runs on every bind (y-codemirror.next #36).
 * - **A remote change is not an edit.** It is dispatched with `cardSync`, and
 *   with `addToHistory: false` so the card's own undo steps back only this
 *   user's typing (Relay 419d63e5); every transaction in an update is checked
 *   for it, not only the first.
 * - **Nothing through `setText`.** Obsidian's setText writes into the open
 *   editor as a plain transaction, which a binding reads as typing and types
 *   again (Relay 262604f0); canvas-live.ts assigns the node's text instead.
 * - **Not during composition.** A remote dispatch mid-IME breaks the input;
 *   remote changes wait for it to end, then the editor is brought to the text.
 * - Our own small plugin rather than yCollab, which keeps an UndoManager per
 *   call that is never released (y-codemirror.next #43) — and card editors
 *   come and go constantly. So carets are ours too (card-caret.ts, WIRE-095).
 */

/** Marks a change that came from the Y.Text: it must not go back into it. */
export const cardSync = Annotation.define<boolean>();

/**
 * The smallest single replacement taking `from` to `to`: common prefix and
 * suffix kept. For one person's edit it is exactly that edit.
 */
export function minimalChange(from: string, to: string): ChangeSpec | null {
  if (from === to) return null;
  let start = 0;
  const max = Math.min(from.length, to.length);
  while (start < max && from.charCodeAt(start) === to.charCodeAt(start)) start++;
  let endFrom = from.length;
  let endTo = to.length;
  while (endFrom > start && endTo > start && from.charCodeAt(endFrom - 1) === to.charCodeAt(endTo - 1)) {
    endFrom--;
    endTo--;
  }
  return { from: start, to: endFrom, insert: to.slice(start, endTo) };
}

/** A Y.Text change as editor changes, positions in the document before it. */
export function changesFromDelta(delta: Y.YTextEvent['delta']): ChangeSpec[] {
  const changes: ChangeSpec[] = [];
  let pos = 0;
  for (const d of delta) {
    if (d.insert != null) {
      changes.push({ from: pos, to: pos, insert: d.insert as string });
    } else if (d.delete != null) {
      changes.push({ from: pos, to: pos + d.delete, insert: '' });
      pos += d.delete;
    } else if (d.retain != null) {
      pos += d.retain;
    }
  }
  return changes;
}

/** The transaction spec for a change that came from the Y.Text. */
export function remoteSpec(changes: ChangeSpec | ChangeSpec[]): { changes: ChangeSpec | ChangeSpec[]; annotations: Annotation<unknown>[] } {
  return {
    changes,
    annotations: [cardSync.of(true), Transaction.addToHistory.of(false), Transaction.remote.of(true)],
  };
}

/**
 * Carry an editor update's own changes into the Y.Text, under `origin`.
 * Changes that came from the Y.Text (`cardSync`) are skipped — they are there
 * already — and each transaction's positions are read against the document
 * as it stood before it, which the Y.Text matches at that point.
 */
export function applyLocal(ytext: Y.Text, transactions: readonly Transaction[], origin: unknown): void {
  const own = transactions.filter((tr) => tr.docChanged && !tr.annotation(cardSync));
  if (own.length === 0) return;
  const ydoc = ytext.doc;
  const run = (): void => {
    for (const tr of own) {
      let adj = 0;
      tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
        // Line breaks as `\n`: CodeMirror counts `\r\n` as one character and
        // Yjs as two, and positions drift apart from there (y-codemirror #35).
        const text = inserted.sliceString(0, inserted.length, '\n');
        if (toA > fromA) ytext.delete(fromA + adj, toA - fromA);
        if (text.length > 0) ytext.insert(fromA + adj, text);
        adj += text.length - (toA - fromA);
      });
    }
  };
  if (ydoc) ydoc.transact(run, origin);
  else run();
}

/** Which card an editor belongs to, if its canvas is bound live. */
export type CardResolver = (state: EditorState) => { binding: CanvasLiveBinding; id: string } | null;

/** Exported for its test, which drives it with a stand-in for the view. */
export class CardPlugin implements PluginValue {
  private binding: CanvasLiveBinding | null = null;
  private id: string | null = null;
  private ytext: Y.Text | null = null;
  /**
   * The editor is behind the Y.Text: remote changes are waiting (a
   * composition, a dispatch that could not run). Its positions then do not
   * match the Y.Text's, so typing is merged as an edit, never applied at them.
   */
  private pending = false;
  private destroyed = false;
  private offBinding: (() => void) | null = null;
  /** This card's carets: ours sent, everyone else's drawn. Only while bound, and only with presence. */
  private caret: CardCaret | null = null;
  private readonly observer = (event: Y.YTextEvent, tr: Y.Transaction): void => this.onRemote(event, tr);

  constructor(private view: EditorView, private resolve: CardResolver) {
    this.attach();
  }

  /**
   * Bind to the card's Y.Text, whenever that becomes possible: when the editor
   * opens, or later — the canvas bound after the editor opened, or bound again
   * after a fallback.
   *
   * The Y.Text is the truth, but an editor opened before its canvas was live
   * may hold typing its card has not committed yet (Obsidian commits a card
   * about 2 s after the first keystroke). So what the editor holds beyond the
   * card's committed text is merged in as an edit, and only then is the editor
   * brought to the Y.Text. For an editor that just opened the two are equal,
   * and this is simply "bring the editor to the text".
   */
  private attach(): void {
    if (this.ytext || this.destroyed) return;
    const found = this.resolve(this.view.state);
    if (!found || !found.binding.isBound()) return;
    const ytext = found.binding.cardText(found.id);
    if (!ytext) return; // the card is not in the document yet; tried again on the next update
    this.binding = found.binding;
    this.id = found.id;
    this.ytext = ytext;
    const committed = found.binding.nodeText(found.id);
    const shown = this.view.state.doc.toString();
    if (typeof committed === 'string' && committed !== shown && ytext.doc) {
      const ydoc = ytext.doc;
      ydoc.transact(() => mergeTextEdit(ydoc, ytext, committed, shown.replace(/\r\n/g, '\n')), this);
    }
    found.binding.liveCards.add(found.id);
    found.binding.cardEditor(this.view.dom, true);
    ytext.observe(this.observer);
    if (found.binding.awareness) {
      this.caret = new CardCaret(ytext, found.binding.awareness, () => this.redrawCarets());
      this.syncCaret();
      // Peers already typing in this card are drawn now, not on their next move.
      queueMicrotask(() => this.redrawCarets());
    }
    this.offBinding = found.binding.onChange(() => {
      if (!found.binding.isBound() || found.binding.cardText(found.id) !== ytext) this.release();
    });
    // Brought to the Y.Text, never the other way round — and not from inside
    // the update that made this plugin.
    this.pending = true;
    queueMicrotask(() => this.flush());
  }

  /**
   * Let go of a Y.Text whose canvas is no longer live, or whose document was
   * replaced. From here the card's typing reaches the file the way Obsidian
   * saves it, over disk; a stale Y.Text written to after its canvas fell back
   * would be a second writer (and after a reconnect, a destroyed one).
   */
  private release(): void {
    this.offBinding?.();
    this.offBinding = null;
    if (this.caret) {
      this.caret.stop();
      this.caret = null;
      // Take down the carets already drawn: nothing will ask the layer again
      // once the listener is gone, and they would stay frozen in the card.
      queueMicrotask(() => this.redrawCarets());
    }
    this.ytext?.unobserve(this.observer);
    if (this.binding && this.id) {
      this.binding.liveCards.delete(this.id);
      this.binding.cardEditor(this.view.dom, false);
    }
    this.ytext = null;
    this.binding = null;
    this.id = null;
    this.pending = false;
  }

  update(u: ViewUpdate): void {
    if (this.ytext && this.binding && (!this.binding.isBound() || this.binding.cardText(this.id as string) !== this.ytext)) {
      this.release();
    }
    if (!this.ytext) {
      // Attaching merges everything the editor holds, this update included.
      this.attach();
      return;
    }
    if (u.docChanged) {
      try {
        if (this.pending) this.mergeLocal(u.transactions);
        else applyLocal(this.ytext, u.transactions, this);
        this.binding?.touched();
      } catch (err) {
        log.warn('Could not carry typing in a canvas card to the document', { error: String(err) });
      }
    }
    if (this.pending && !this.view.composing) queueMicrotask(() => this.flush());
    if (u.selectionSet || u.focusChanged || u.docChanged) this.syncCaret();
  }

  /** Other people's selections in this card, for the selection layer; none while unbound. */
  selectionMarkers(): CardSelectionMarker[] {
    const selections = this.caret?.selections() ?? [];
    return selections.length === 0 ? [] : cardSelectionMarkers(this.view, selections);
  }

  /** Other people's carets in this card, for the caret layer; none while unbound. */
  caretMarkers(): CardCaretMarker[] {
    const carets = this.caret?.carets() ?? [];
    return carets.length === 0 ? [] : cardCaretMarkers(this.view, carets);
  }

  /** Ask the caret layer to measure again. Never from inside an update: callers queue it. */
  private redrawCarets(): void {
    if (this.destroyed) return;
    try {
      this.view.dispatch({ effects: refreshCardCarets.of(null) });
    } catch (err) {
      log.debug('Could not redraw carets in a canvas card', { error: String(err) });
    }
  }

  /** Send this editor's caret while it has focus, and withdraw it when it does not. */
  private syncCaret(): void {
    if (!this.caret) return;
    const { anchor, head } = this.view.state.selection.main;
    // Past the Y.Text's end while the editor is behind it; clamped, since a
    // caret is only ever a hint of where someone is.
    const len = this.caret.ytext.length;
    this.caret.sync(this.view.hasFocus === true, Math.min(anchor, len), Math.min(head, len));
  }

  /**
   * Typing while the editor is behind the Y.Text. Each transaction's before
   * and after are merged as a text edit into what the Y.Text holds now, which
   * already has the remote changes the editor has not shown — so neither is
   * lost, and nothing lands at a position that means something else there.
   */
  private mergeLocal(transactions: readonly Transaction[]): void {
    const ytext = this.ytext;
    const ydoc = ytext?.doc;
    if (!ytext || !ydoc) return;
    const own = transactions.filter((tr) => tr.docChanged && !tr.annotation(cardSync));
    if (own.length === 0) return;
    ydoc.transact(() => {
      for (const tr of own) {
        mergeTextEdit(ydoc, ytext, tr.startState.doc.sliceString(0, tr.startState.doc.length, '\n'),
          tr.state.doc.sliceString(0, tr.state.doc.length, '\n'));
      }
    }, this);
  }

  private onRemote(event: Y.YTextEvent, tr: Y.Transaction): void {
    if (tr.origin === this || this.destroyed) return;
    if (this.pending || this.view.composing) {
      this.pending = true;
      return;
    }
    try {
      this.view.dispatch(remoteSpec(changesFromDelta(event.delta)));
    } catch {
      // Inside another update, or the delta no longer fits: bring the editor
      // to the text once the update is done.
      this.pending = true;
      queueMicrotask(() => this.flush());
    }
  }

  /** Bring the editor to what the Y.Text says, unless the user is composing. */
  private flush(): void {
    if (this.destroyed || !this.ytext || !this.pending || this.view.composing) return;
    this.pending = false;
    const change = minimalChange(this.view.state.doc.toString(), this.ytext.toString());
    if (!change) return;
    try {
      this.view.dispatch(remoteSpec(change));
    } catch (err) {
      this.pending = true;
      log.debug('Deferred bringing a canvas card up to date', { error: String(err) });
    }
  }

  destroy(): void {
    this.destroyed = true;
    this.release();
  }
}

/** The editor extension: installed for every editor, active only in cards of live canvases. */
export function canvasCardBinding(resolve: CardResolver): Extension {
  const plugin = ViewPlugin.define((view) => new CardPlugin(view, resolve));
  const redraw = (u: ViewUpdate): boolean => u.docChanged || u.viewportChanged || u.geometryChanged
    || u.transactions.some((tr) => tr.effects.some((e) => e.is(refreshCardCarets)));
  const carets = layer({
    above: true,
    class: 'nectenda-card-caret-layer',
    update: redraw,
    markers: (view) => view.plugin(plugin)?.caretMarkers() ?? [],
  });
  // Below the text, as a note's selection is. Redrawn whenever the carets are:
  // a selection is the same `cursor`, so it changes when they do.
  const selections = layer({
    above: false,
    class: 'nectenda-card-selection-layer',
    update: redraw,
    markers: (view) => view.plugin(plugin)?.selectionMarkers() ?? [],
  });
  return [plugin, selections, carets, cardCaretTheme];
}
