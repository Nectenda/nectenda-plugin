import { keymap, type EditorView } from '@codemirror/view';
import { yCollab, yUndoManagerKeymap } from 'y-codemirror.next';
import type * as Y from 'yjs';
import type { Awareness } from 'y-protocols/awareness';
import type { EditorWiring } from './editor-wiring';
import type { CanvasWithNodesLike, NoteChildLike } from './canvas-note-cards';
import { log } from './logger';

/**
 * A note being edited in a canvas card, bound live to the note's document
 * (NEC-251, SAFE-A32).
 *
 * Obsidian gives a file card for a `.md` an embedded note view, and that view
 * an editor while the card is being edited. Unbound, typing there reached
 * other vaults only through the card's save, seconds later, and with no
 * cursors either way. Bound, it is the note's editor like any other: the same
 * `yCollab` on the note's `Y.Text`, the same awareness, so a collaborator with
 * the note open sees this user's caret in it, and this user sees theirs.
 *
 * What it takes from what went wrong for others (Relay 0.7.0–0.8.11):
 *
 * - **The editor is found through its card**, by matching the card's
 *   `child.editor.cm`: an embedded editor cannot say which note it is.
 * - **Only while it exists, and only that one.** A card has an editor only
 *   while being edited, and Obsidian edits one card at a time, so one slot
 *   (its own `EditorWiring`, beside the pane's) holds it. A card that loses its
 *   editor, or is re-rendered with a new one, is let go and the new one bound.
 * - **Never by writing into the editor.** Binding waits until the card shows
 *   exactly the document's text; a card holding typing is asked to save it
 *   first (canvas-note-cards.ts), and binding waits for the document to have
 *   it. No `setValue`, so nothing typed is overwritten and nothing doubled.
 * - **Never a card showing part of a note** (a `subpath`): its editor holds one
 *   section, and binding it to the whole note's text would write the whole
 *   note into that section (Relay #128, #130). Such cards stay on the guarded
 *   disk path.
 *
 * Unbound for any reason, the card is still guarded as a view of the note
 * (SAFE-A32), so nothing here can lose what it fails to bind.
 */

/** The ContentSync calls a binding makes. */
export interface NoteDocs {
  acquireDoc(docName: string): { ydoc: Y.Doc; ytext: Y.Text; awareness: Awareness | null } | null;
  setEditorBound(docName: string, bound: boolean, owner?: unknown): void;
  /** Adopt into the document what the file has that it lacks, as before any editor binds. */
  reconcileFromDisk?(docName: string): Promise<void>;
}

export interface CanvasNoteBindingDeps {
  /** The canvases of every open canvas view. */
  canvases(): Iterable<CanvasWithNodesLike | null | undefined>;
  /** The document of a note in a shared folder, or null. */
  docNameFor(localPath: string): string | null;
  docs: NoteDocs;
  /** The card slot: an `EditorWiring` of its own, registered once. */
  wiring: EditorWiring;
  /** Announce this user on `awareness`, as the pane's binding does, if it has no state yet. */
  announce(awareness: Awareness): void;
  /** Ask a card holding typing to save it (the guard's adapter). */
  saveCard(child: NoteChildLike): Promise<void>;
}

interface CardChild extends NoteChildLike {
  subpath?: unknown;
  dirty?: unknown;
  editor?: { getValue?(): string; cm?: EditorView } | null;
}

/** The card being edited, and its editor, if it is a whole note. */
interface Candidate {
  child: CardChild;
  cm: EditorView;
  path: string;
}

function editorOf(child: CardChild): EditorView | null {
  const cm = child.editor?.cm;
  if (!cm || typeof cm !== 'object') return null;
  const dom = (cm as { dom?: { isConnected?: boolean } }).dom;
  if ((cm as unknown as { destroyed?: boolean }).destroyed || dom?.isConnected === false) return null;
  return cm;
}

export class CanvasNoteBindings {
  private bound: {
    cm: EditorView;
    docName: string;
    child: CardChild;
    ytext: Y.Text;
    awareness: Awareness;
  } | null = null;
  /** Why the card being edited is not bound: each reason said once per editor. */
  private refusals = new WeakMap<EditorView, Set<string>>();
  /** Editors whose note was reconciled from disk before binding (as EditorBridge does). */
  private reconciled = new WeakSet<EditorView>();
  private saving = false;

  constructor(private deps: CanvasNoteBindingDeps) {
    deps.wiring.onLost = () => {
      log.info('A note card lost its live binding; it will be bound again');
      this.release();
      this.refresh();
    };
  }

  /** Whether a card is bound, and to which editor. For diagnostics and tests. */
  boundEditor(): EditorView | null {
    return this.bound?.cm ?? null;
  }

  /**
   * Bind the note card being edited, let go of one that is not. Called on
   * layout and leaf changes, and on a short interval while a canvas is open,
   * because Obsidian creates a card's editor when editing starts and says
   * nothing about it.
   */
  refresh(): void {
    const candidates = this.candidates();
    const current = this.bound;
    if (current && !this.stillLive(current, candidates)) {
      log.info('A note card\'s live binding no longer holds its note\'s document; letting go', {
        path: current.child.file?.path,
      });
      this.release();
    }
    if (this.bound) {
      // A pane letting go of the note clears this user's presence on it; the
      // card still holds it, so say so again.
      if (this.bound.awareness.getLocalState() === null) this.deps.announce(this.bound.awareness);
      return;
    }
    // The one with focus, when there are several; any, otherwise.
    const pick = candidates.find((c) => c.cm.hasFocus) ?? candidates[0];
    if (!pick) return;
    this.tryBind(pick);
  }

  /**
   * Whether the bound card is still bound to the live document of the note it
   * shows. Its editor gone, the card now showing another file, or the note's
   * document replaced — a sync refresh, a rename — and the binding is to
   * something nobody else holds: the card's typing would reach no one, and the
   * document would be handed back only when its editor went (found in review).
   */
  private stillLive(b: NonNullable<CanvasNoteBindings['bound']>, candidates: Candidate[]): boolean {
    const c = candidates.find((x) => x.cm === b.cm);
    if (!c || c.child !== b.child) return false;
    if (this.deps.docNameFor(c.path) !== b.docName) return false;
    const held = this.deps.docs.acquireDoc(b.docName);
    return held !== null && held.ytext === b.ytext;
  }

  private candidates(): Candidate[] {
    const out: Candidate[] = [];
    for (const canvas of this.deps.canvases()) {
      const nodes = canvas?.nodes;
      if (!nodes || typeof nodes.values !== 'function') continue;
      for (const node of nodes.values()) {
        const child = node?.child as CardChild | undefined;
        const path = child?.file?.path;
        if (!child || typeof path !== 'string' || !path.toLowerCase().endsWith('.md')) continue;
        const cm = editorOf(child);
        if (!cm) continue;
        out.push({ child, cm, path });
      }
    }
    return out;
  }

  private refuse(cm: EditorView, reason: string, path: string): void {
    let said = this.refusals.get(cm);
    if (!said) this.refusals.set(cm, (said = new Set()));
    if (said.has(reason)) return;
    said.add(reason);
    log.info('A note card being edited is not bound live', { path, reason });
  }

  private tryBind(c: Candidate): void {
    if (typeof c.child.subpath === 'string' && c.child.subpath !== '') {
      this.refuse(c.cm, 'it shows one section of the note', c.path);
      return;
    }
    const docName = this.deps.docNameFor(c.path);
    if (!docName) {
      this.refuse(c.cm, 'the note is not in a shared folder', c.path);
      return;
    }
    const held = this.deps.docs.acquireDoc(docName);
    if (!held) {
      this.refuse(c.cm, 'the note is not connected yet', c.path);
      return;
    }
    if (!held.awareness) {
      this.refuse(c.cm, 'the note is not subscribed yet', c.path);
      return;
    }
    // What the file has that the document lacks, adopted first, as before any
    // editor binds: bound, ContentSync stops reading the file in (found in review).
    if (this.deps.docs.reconcileFromDisk && !this.reconciled.has(c.cm)) {
      this.reconciled.add(c.cm);
      void this.deps.docs.reconcileFromDisk(docName)
        .catch((err: unknown) => log.warn('Could not reconcile a note from disk before binding its card', { path: c.path, error: String(err) }))
        .finally(() => this.refresh());
      return;
    }
    const shown = c.cm.state.doc.toString();
    if (shown !== held.ytext.toString()) {
      if (c.child.dirty === true && !this.saving) {
        // Its typing first, through its own save, so the document has it;
        // binding is tried again on the next refresh.
        this.saving = true;
        this.refuse(c.cm, 'it holds typing not saved yet; saving it first', c.path);
        void this.deps.saveCard(c.child)
          .catch((err: unknown) => log.warn('Could not save a note card before binding it', { path: c.path, error: String(err) }))
          .finally(() => { this.saving = false; });
        return;
      }
      this.refuse(c.cm, 'it does not show the note\'s text yet', c.path);
      return;
    }
    this.deps.announce(held.awareness);
    const exts = [yCollab(held.ytext, held.awareness), keymap.of(yUndoManagerKeymap)];
    if (!this.deps.wiring.bind(c.cm, exts)) {
      this.refuse(c.cm, 'the editor would not take the binding', c.path);
      return;
    }
    // Only now does the editor hold the document; until here ContentSync kept
    // reconciling it from disk, which is what keeps a refused card safe.
    this.deps.docs.setEditorBound(docName, true, this);
    this.bound = { cm: c.cm, docName, child: c.child, ytext: held.ytext, awareness: held.awareness };
    log.info('Bound a note card live', { path: c.path });
  }

  /** Let go of the bound card, if any: the document goes back to ContentSync, unless a pane still holds it. */
  release(): void {
    const b = this.bound;
    if (!b) return;
    this.bound = null;
    this.deps.wiring.unbind();
    // Its caret withdrawn; the person stays present while a pane holds the note.
    if (b.awareness.getLocalState() !== null) b.awareness.setLocalStateField('cursor', null);
    this.deps.docs.setEditorBound(b.docName, false, this);
  }

  dispose(): void {
    this.release();
    this.deps.wiring.onLost = null;
  }
}
