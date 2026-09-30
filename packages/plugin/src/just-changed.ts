/**
 * A brief pulse on a file-explorer row when a note in a shared folder changes
 * on disk while nobody here is editing it — in practice, a collaborator's edit
 * arriving. It answers "is anything happening?" at a glance, which the steady
 * status marks do not: they say where things stand, not that they moved.
 *
 * Driven by Obsidian's own `modify` event rather than anything in the sync
 * engine, so it cannot affect what is written: it only reads which path
 * changed. The note open in the active editor is left out, because its changes
 * are the person's own typing, and a row pulsing under every keystroke is noise.
 *
 * Batched to one pass per frame: a folder receiving many changes at once
 * (a first sync) marks each row once rather than thrashing the explorer.
 * Desktop only, and off under reduced motion (in the stylesheet).
 */

export const JUST_CHANGED_CLASS = 'nectenda-just-changed';

export interface JustChangedDeps {
  /** Whether a vault path is inside a folder this vault syncs. */
  isShared(path: string): boolean;
  /** The note open in the active editor, whose changes are local typing. */
  activePath(): string | null;
  /** The explorer rows for a path; none when the explorer is closed or collapsed. */
  rowsFor(path: string): Element[];
  frame(cb: () => void): void;
}

export class JustChanged {
  private pending = new Set<string>();
  private scheduled = false;

  constructor(private deps: JustChangedDeps) {}

  /** A file was modified on disk. */
  changed(path: string): void {
    if (!this.deps.isShared(path) || path === this.deps.activePath()) return;
    this.pending.add(path);
    if (this.scheduled) return;
    this.scheduled = true;
    this.deps.frame(() => this.flush());
  }

  private flush(): void {
    this.scheduled = false;
    const paths = [...this.pending];
    this.pending.clear();
    for (const path of paths) {
      for (const row of this.deps.rowsFor(path)) {
        // Removed and re-added across a reflow so a second change restarts
        // the pulse instead of being swallowed by the one still running.
        row.classList.remove(JUST_CHANGED_CLASS);
        void (row as HTMLElement).offsetWidth;
        row.classList.add(JUST_CHANGED_CLASS);
        row.addEventListener('animationend', () => row.classList.remove(JUST_CHANGED_CLASS), { once: true });
      }
    }
  }
}
