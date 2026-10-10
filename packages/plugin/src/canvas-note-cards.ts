import type { ElementLike, TextViewLike } from './text-view-guard';

/**
 * A canvas card that shows a note, as the guard sees a view of that note
 * (NEC-251, SAFE-A32).
 *
 * Obsidian draws a file card for a `.md` with an embedded note view — the
 * node's `child` — that keeps its own copy of the note, typed into, and saved
 * about 2 s after the first change like any note view. Nothing counted it as a
 * view: a peer's change written in that window was undone by the card's save,
 * which read in as this user deleting it (reproduced against a real Obsidian
 * before this was written). So each such child is
 * offered to the guard (text-view-guard.ts) beside the other note views: our
 * write waits while it is typed in, it is asked to save first, and its save is
 * read in against what it last held.
 *
 * What the child is, read from Obsidian 1.13.7's own code:
 *
 * - `data` is the whole file, even for a card showing one section of it.
 * - `save(text, flush)` takes the card's own text — all of a whole-note card,
 *   one section of a section card — rebuilds the file as `before + heading +
 *   text + after`, and writes it only when `flush` is true. Called with no
 *   arguments, it throws.
 * - `onFileChanged` reloads the card only when it is not `dirty`. So a write
 *   that lands while the card holds typing is not loaded, and the card's next
 *   save rebuilds the file from its stale copy over it: the loss above. Asking
 *   the card to save first, as the guard does, is what closes that.
 * - `loadContents(text)` loads the whole file's text, cutting a section card's
 *   section out of it again. It has no `setViewData`; a repair uses this.
 */

/** What this module reads of an embedded note view. Obsidian internals. */
export interface NoteChildLike {
  file?: { path: string; extension?: string } | null;
  /** The whole file's text, as the card last loaded or saved it. */
  data?: unknown;
  /** The card's own text: the whole note, or the section it shows. */
  text?: unknown;
  lastSavedData?: unknown;
  save?(text: string, flush?: boolean): Promise<void>;
  loadContents?(text: string): void;
  containerEl?: ElementLike | null;
  editor?: { getValue?(): string } | null;
}

/** What this module reads of an open canvas. Obsidian internals. */
export interface CanvasWithNodesLike {
  nodes?: Map<string, { child?: unknown }> | null;
}

const adapters = new WeakMap<object, TextViewLike>();

function adapterFor(child: NoteChildLike): TextViewLike {
  const known = adapters.get(child);
  if (known) return known;
  const view: TextViewLike = {
    get data(): string | null {
      return typeof child.data === 'string' ? child.data : null;
    },
    set data(text: string | null) {
      if (typeof text === 'string') child.data = text;
    },
    get file(): { path: string } | null {
      return child.file ?? null;
    },
    async save(): Promise<void> {
      // What the card holds now: its editor's, if it is being edited.
      const own = child.editor?.getValue?.() ?? child.text;
      if (typeof own !== 'string') return;
      await child.save?.(own, true);
    },
    setViewData(text: string): void {
      // As loading the file does: what it holds, and what it last saved, is
      // the file now; the card's own text is cut from it again.
      child.data = text;
      child.lastSavedData = text;
      child.loadContents?.(text);
    },
    get containerEl(): ElementLike | null {
      return child.containerEl ?? null;
    },
  };
  adapters.set(child, view);
  return view;
}

function isNoteChild(child: unknown): child is NoteChildLike {
  if (child === null || typeof child !== 'object') return false;
  const c = child as NoteChildLike;
  const path = c.file?.path;
  return typeof path === 'string' && path.toLowerCase().endsWith('.md') && typeof c.save === 'function'
    && typeof c.data === 'string';
}

/**
 * Every note shown in a card of these canvases, as a view of that note. A card
 * showing part of a note (a `subpath`) is a view of the whole note's file too:
 * it saves the whole file, splicing its section in.
 */
export function canvasNoteCards(canvases: Iterable<CanvasWithNodesLike | null | undefined>): TextViewLike[] {
  const out: TextViewLike[] = [];
  for (const canvas of canvases) {
    const nodes = canvas?.nodes;
    if (!nodes || typeof nodes.values !== 'function') continue;
    for (const node of nodes.values()) {
      if (isNoteChild(node?.child)) out.push(adapterFor(node.child));
    }
  }
  return out;
}
