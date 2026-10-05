import { log } from './logger';

/**
 * Saves another plugin's view of a shared note soon after it changes, rather
 * than when Obsidian gets round to it.
 *
 * A board of the Kanban plugin reaches the document only through its file:
 * nothing binds the view to it, and disk stays the one writer (SAFE-A19). The
 * view asks to be saved through `TextFileView.requestSave`, which Obsidian
 * debounces by two seconds, so a card moved in one vault took about two and a
 * half seconds to appear in the other — found testing in two vaults, where
 * presence on the same board moved at once and made the lag plain.
 *
 * `requestSave` is a property Obsidian sets on each view, so it is wrapped on
 * the instance: Obsidian's own debounce still runs, and a `save()` follows a
 * short pause after the last request. Nothing of the plugin is touched. The
 * view has already put what it wants saved in `data` when it asks, so the
 * early save writes what the late one would have; the late one then finds
 * nothing changed. Should the early one fail, the late one is still coming —
 * no worse than before.
 *
 * Only for view types named here, and for now that is Kanban, the one
 * measured. Every other view of a note keeps Obsidian's pace. Excalidraw's
 * drawings are not among them: they sync as structured files, and an open
 * drawing is bound live (excalidraw-live.ts), which carries each change in as
 * it is made — saving it early would add nothing.
 */

/** How long after the last request a view is saved. Short: a drag or a burst of ticks is one save. */
export const QUICK_SAVE_MS = 200;

/** What this needs of a TextFileView. */
export interface SavableView {
  file: { path: string } | null;
  getViewType(): string;
  requestSave: () => void;
  save(clear?: boolean): Promise<void>;
}

interface Wrapped {
  original: () => void;
  wrapper: () => void;
  timer: number | null;
}

export class QuickSave {
  private wrapped = new Map<SavableView, Wrapped>();

  /**
   * @param views every view to consider: another plugin's view of a note.
   * @param shared whether a note is in a shared folder, so worth saving early.
   * @param types the view types saved early; any other is left alone. A
   *   function when a setting decides it — "Live sync for Kanban boards" —
   *   read on every refresh, so turning it off lets go of open boards.
   */
  constructor(
    private views: () => SavableView[],
    private shared: (path: string) => boolean,
    private types: ReadonlySet<string> | (() => ReadonlySet<string>),
  ) {}

  /** Wrap the views of shared notes, and let go of any that no longer are. Cheap and idempotent. */
  refresh(): void {
    const types = typeof this.types === 'function' ? this.types() : this.types;
    const now = new Set(this.views().filter((v) => v.file !== null && types.has(v.getViewType()) && this.shared(v.file.path)));
    for (const view of [...this.wrapped.keys()]) {
      if (!now.has(view)) this.unwrap(view);
    }
    for (const view of now) {
      if (!this.wrapped.has(view)) this.wrap(view);
    }
  }

  private wrap(view: SavableView): void {
    const original = view.requestSave;
    const entry: Wrapped = { original, wrapper: () => undefined, timer: null };
    entry.wrapper = () => {
      original.call(view);
      if (entry.timer !== null) window.clearTimeout(entry.timer);
      entry.timer = window.setTimeout(() => {
        entry.timer = null;
        view.save().catch((err: unknown) => {
          log.warn('An early save of a note view failed; Obsidian saves it shortly anyway', { error: String(err) });
        });
      }, QUICK_SAVE_MS);
    };
    view.requestSave = entry.wrapper;
    this.wrapped.set(view, entry);
    log.debug('Note view saves early', { path: view.file?.path });
  }

  private unwrap(view: SavableView): void {
    const entry = this.wrapped.get(view);
    if (!entry) return;
    this.wrapped.delete(view);
    if (entry.timer !== null) window.clearTimeout(entry.timer);
    // Only ours to put back if nothing has wrapped it since; if something
    // has, ours stays in its chain and still calls Obsidian's.
    if (view.requestSave === entry.wrapper) view.requestSave = entry.original;
  }

  dispose(): void {
    for (const view of [...this.wrapped.keys()]) this.unwrap(view);
  }
}
