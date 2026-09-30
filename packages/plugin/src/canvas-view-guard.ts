import type { StructuredSurface } from './structured-sync';
import type { TimerHandle } from './timers';
import { log } from './logger';

/**
 * What the guard needs of an open canvas view. All of it is public API on
 * Obsidian's TextFileView — `data`, `file`, `save()`, `setViewData()` — and
 * nothing of the canvas's own internals.
 */
export interface CanvasViewLike {
  data: string | null;
  file: { path: string } | null;
  save(clear?: boolean): Promise<void>;
  setViewData(data: string, clear: boolean): void;
}

/** How long after a write an open view must have loaded it. See `afterWrite`. */
export const LOAD_CHECK_MS = 1000;
/** How long a repair's save may take to be read in before its base is dropped. */
const REPAIR_GRACE_MS = 3000;

/**
 * Makes writing a canvas file safe while the canvas is open (SAFE-A19).
 *
 * Obsidian 1.13.7 reloads an open canvas when its file changes on disk, with
 * no merge (`TextFileView.onModify`; the three-way merge only runs for plain
 * text). Two things follow, both read from its source:
 *
 * 1. **An edit the view has not saved yet is discarded by the reload.** It
 *    saves about 2 s after the first change of a burst. So before every write
 *    the view is asked to save; StructuredSync then reads that save in and
 *    writes a file that holds both. `save()` writes nothing when nothing
 *    changed, so asking costs nothing.
 * 2. **A write that lands while the view is mid-save is never loaded** (it
 *    skips the reload while `saving`), and its next save writes its stale
 *    copy back. Diffed against our write, that save would read as the user
 *    reverting the remote change it never showed — and send the revert to
 *    everyone. So `LOAD_CHECK_MS` after each write the guard checks the view
 *    holds what was written. One that does not is repaired on the spot: it is
 *    asked to save what it holds, which is read in against what it held before
 *    the write (`baseFor`), and it is then made to load the file.
 *
 * The repair is deliberately short-lived. A base kept for "the next save" would
 * outlive the view that earned it — closed, or reused for another file — and
 * a later, unrelated edit diffed against it would replay every remote change
 * since as a local one. So the base exists only for the repair's own save, and
 * only while a view of the file is open.
 *
 * A view is trusted only while it shows this file: Obsidian reuses views
 * across files, and until the new file loads the view still holds the old
 * one's canvas (a copy of a canvas even shares its ids). And a view with no
 * data is a load in progress, never a canvas someone emptied.
 */
export class CanvasViewGuard implements StructuredSurface {
  /** What each path's views held just before our last write. */
  private held = new Map<string, string>();
  /** Paths being repaired: the text their views held, for the repair's save. */
  private repairing = new Map<string, string>();
  /** What we last wrote to each path whose load check is still pending. */
  private written = new Map<string, string>();
  private timers = new Map<string, TimerHandle>();

  constructor(private views: () => CanvasViewLike[]) {}

  private viewsOf(localPath: string): CanvasViewLike[] {
    return this.views().filter((v) => v.file?.path === localPath && typeof v.data === 'string' && v.data !== '');
  }

  async beforeWrite(localPath: string): Promise<void> {
    const views = this.viewsOf(localPath);
    for (const v of views) await v.save();
    const after = this.viewsOf(localPath)[0]?.data;
    if (typeof after === 'string') this.held.set(localPath, after);
    else this.held.delete(localPath);
  }

  afterWrite(localPath: string, text: string, readBack?: () => Promise<string>): void {
    const prior = this.held.get(localPath);
    const pending = this.timers.get(localPath);
    if (pending) window.clearTimeout(pending);
    this.timers.delete(localPath);
    this.written.delete(localPath);
    if (prior === undefined || this.viewsOf(localPath).length === 0) return;
    this.written.set(localPath, text);
    this.timers.set(localPath, window.setTimeout(() => {
      this.timers.delete(localPath);
      this.written.delete(localPath);
      const missed = this.viewsOf(localPath).filter((v) => v.data !== text);
      if (missed.length === 0) return;
      void this.repair(localPath, prior, missed, readBack).catch((err: unknown) => {
        log.warn('Could not bring an open canvas up to date', { path: localPath, error: String(err) });
      });
    }, LOAD_CHECK_MS));
  }

  /**
   * A view did not load our write. Whatever it saves now was built on what it
   * held before, so that is the base it is read in against; then it is made to
   * show the file. Its `data` is either that old text or a save of its own made
   * on top of it — either way, not built on our write.
   */
  private async repair(
    localPath: string,
    prior: string,
    views: CanvasViewLike[],
    readBack?: () => Promise<string>,
  ): Promise<void> {
    log.warn('An open canvas did not load a remote change; reading its copy in against what it held', {
      path: localPath,
    });
    this.repairing.set(localPath, prior);
    window.setTimeout(() => {
      if (this.repairing.get(localPath) === prior) this.repairing.delete(localPath);
    }, REPAIR_GRACE_MS);
    for (const v of views) await v.save();
    if (!readBack) return;
    // If the save wrote nothing, nothing will reload the view: load it here.
    // If it wrote, its read-in schedules a write, which reloads the view in
    // the ordinary way; loading now as well does no harm.
    const disk = await readBack();
    for (const v of this.viewsOf(localPath)) {
      if (v.data === disk) continue;
      v.data = disk;
      v.setViewData(disk, false);
    }
  }

  /**
   * The base for a save from this path's views, when it cannot be our last
   * write: during a repair, and before the load check has run if no view has
   * loaded the write yet — a view mid-save when the write landed can finish
   * that save, with an edit in it, before the check. Null whenever no view of
   * the file is open, so nothing outlives the view that earned it.
   */
  baseFor(localPath: string): string | null {
    const views = this.viewsOf(localPath);
    if (views.length === 0) {
      this.repairing.delete(localPath);
      return null;
    }
    const base = this.repairing.get(localPath);
    if (base !== undefined) return base;
    const written = this.written.get(localPath);
    const prior = this.held.get(localPath);
    if (written !== undefined && prior !== undefined && !views.some((v) => v.data === written)) return prior;
    return null;
  }

  ingested(localPath: string, text: string): void {
    // That save is in the document now. The views hold it, so a later save
    // before the check is built on it, not on what they held before.
    this.repairing.delete(localPath);
    if (this.written.has(localPath)) this.held.set(localPath, text);
  }

  dispose(): void {
    for (const t of this.timers.values()) window.clearTimeout(t);
    this.timers.clear();
    this.held.clear();
    this.repairing.clear();
  }
}
