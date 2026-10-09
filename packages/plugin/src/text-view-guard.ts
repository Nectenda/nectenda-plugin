import type { StructuredSurface } from './structured-sync';
import type { TimerHandle } from './timers';
import { log } from './logger';

/**
 * What the guard needs of an open view of a structured file — a canvas, a
 * base. All of it is public API on Obsidian's TextFileView — `data`, `file`,
 * `save()`, `setViewData()` — and nothing of either view's own internals.
 */
export interface TextViewLike {
  data: string | null;
  file: { path: string } | null;
  save(clear?: boolean): Promise<void>;
  setViewData(data: string, clear: boolean): void;
  /** The view's own element, for `EditProbe`: whether an edit is in progress inside it. */
  containerEl?: ElementLike | null;
}

/** The two things `EditProbe` asks of a DOM element. */
export interface ElementLike {
  contains(other: unknown): boolean;
  closest?(selector: string): unknown;
}

/** The document `EditProbe` watches: its focus, and its pointer and focus events. */
export interface DocumentLike {
  readonly activeElement: unknown;
  addEventListener(type: string, listener: (e: { target: unknown; buttons?: number }) => void, capture?: boolean): void;
  removeEventListener(type: string, listener: (e: { target: unknown; buttons?: number }) => void, capture?: boolean): void;
}

/** How long after a write an open view must have loaded it. See `afterWrite`. */
export const LOAD_CHECK_MS = 1000;
/** How soon after a write the views are first looked at for having loaded it. */
const QUICK_CHECK_MS = 150;
/** How long a repair's save may take to be read in before its base is dropped. */
const REPAIR_GRACE_MS = 3000;
/**
 * How often a held write is looked at again, in case the edit ended without an
 * event saying so: an editor removed from the page does not always send
 * `focusout`, and a pointer released outside the window sends no `pointerup`.
 */
export const HOLD_RECHECK_MS = 1000;

/**
 * Where typing goes. A checkbox, radio or button takes focus when clicked and
 * keeps it, so they are left out: a ticked card would otherwise hold every
 * remote change until the person happened to click elsewhere.
 */
const EDITABLE = [
  'textarea', 'select', '[contenteditable=""]', '[contenteditable="true"]', '.cm-editor',
  'input:not([type="checkbox"]):not([type="radio"]):not([type="button"]):not([type="submit"]):not([type="reset"])',
].join(', ');

/**
 * Whether someone is in the middle of an edit inside a view (SAFE-A26): typing
 * into one of its fields or editors, or holding the pointer down in it — a
 * drag, or a click not yet released.
 *
 * Read from the DOM only, so it needs nothing of any plugin's internals and
 * holds for any view. It exists because a view that renders a file the way the
 * Kanban plugin does throws away what is on screen when the file reloads: a
 * card's text being typed lives only in its editor until it is committed, and
 * a card being dragged is mid-gesture. Obsidian's reload cannot ask either to
 * save first — there is nothing saved yet to ask for — so the write that would
 * cause the reload waits instead.
 */
export class EditProbe {
  /** Where the pointer went down, until it comes up. */
  private pressed: unknown = null;
  private listeners = new Set<() => void>();
  private stopListening: () => void;

  constructor(private doc: DocumentLike) {
    const down = (e: { target: unknown }): void => { this.pressed = e.target; };
    const up = (): void => {
      if (this.pressed === null) return;
      this.pressed = null;
      this.mayHaveEnded();
    };
    // A press whose release was never seen — let go outside the window, or
    // the window left mid-press — ends with the next sign that no button is
    // held: the pointer moving with none down, or a key typed (found in review).
    const moved = (e: { target: unknown; buttons?: number }): void => {
      if (e.buttons === 0) up();
    };
    // After the focus has moved, not as it leaves: `focusout` fires before
    // `activeElement` names where it went.
    const blurred = (): void => { window.setTimeout(() => this.mayHaveEnded(), 0); };
    const on: [string, (e: { target: unknown; buttons?: number }) => void][] = [
      ['pointerdown', down], ['pointerup', up], ['pointercancel', up], ['dragend', up], ['drop', up],
      ['pointermove', moved], ['keydown', up], ['focusout', blurred],
    ];
    // Capturing, so a view that stops an event's propagation cannot hide it.
    for (const [type, fn] of on) doc.addEventListener(type, fn, true);
    this.stopListening = () => { for (const [type, fn] of on) doc.removeEventListener(type, fn, true); };
  }

  /** Whether an edit is in progress inside `el`. */
  editingIn(el: ElementLike | null | undefined): boolean {
    if (!el) return false;
    const active = this.doc.activeElement;
    if (active && el.contains(active) && isEditable(active)) return true;
    return this.pressed !== null && el.contains(this.pressed);
  }

  /** Called whenever an edit may have ended: the guard then looks again. */
  onMayHaveEnded(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private mayHaveEnded(): void {
    for (const l of [...this.listeners]) l();
  }

  dispose(): void {
    this.stopListening();
    this.listeners.clear();
    this.pressed = null;
  }
}

function isEditable(el: unknown): boolean {
  const found = (el as ElementLike | null)?.closest?.(EDITABLE);
  return found !== undefined && found !== null;
}

/**
 * Makes writing a file safe while a view of it is open (SAFE-A19): a canvas,
 * a base, or another plugin's view of a note — a board of the Kanban plugin.
 * One instance guards structured files, another notes; the note one also has
 * an `EditProbe`, so a write can wait for an edit in progress (SAFE-A26).
 *
 * Obsidian 1.13.7 reloads an open canvas, and an open base, when its file
 * changes on disk, with no merge (`TextFileView.onModify`; the three-way merge
 * only runs for plain text, in its own markdown view — any other view of a
 * note is reloaded the same way). Both save about 2 s after the first change of a
 * burst, and both skip the reload while `saving`. Two things follow, both read
 * from its source:
 *
 * 1. **An edit the view has not saved yet is discarded by the reload.** So
 *    before every write
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
 * one's content (a copy of a canvas even shares its ids). And a view with no
 * data is a load in progress, never a file someone emptied.
 */
export class TextViewGuard implements StructuredSurface {
  /**
   * What each path's views held just before our last write: text read in,
   * never a save not read in yet, which is the base that save is read against.
   */
  private held = new Map<string, string>();
  /** Paths being repaired: the text their views held, for the repair's save. */
  private repairing = new Map<string, string>();
  /** What we last wrote to each path whose load check is still pending. */
  private written = new Map<string, string>();
  private timers = new Map<string, TimerHandle>();
  /** Paths whose write is being held for an edit in progress (SAFE-A26). */
  private holding = new Set<string>();
  private endedListeners = new Set<(localPath: string) => void>();
  private recheck: TimerHandle | null = null;
  private stopProbe: (() => void) | null = null;

  /**
   * `probe`, when given, lets a writer ask whether an edit is in progress in
   * an open view (`editInProgress`) and be told when it ends. Without one,
   * nothing is ever held — canvas and bases, whose views keep no edit outside
   * their `data`, are guarded without it.
   */
  constructor(private views: () => TextViewLike[], private probe?: EditProbe) {
    this.stopProbe = probe?.onMayHaveEnded(() => this.checkHeld()) ?? null;
  }

  /**
   * Whether a write of `localPath` should wait: someone is typing or dragging
   * in an open view of it. A path found held is watched until the edit ends,
   * and then every `onEditEnded` listener hears of it once.
   */
  editInProgress(localPath: string): boolean {
    if (!this.probe) return false;
    const editing = this.viewsOf(localPath).some((v) => this.probe!.editingIn(v.containerEl));
    if (editing) {
      this.holding.add(localPath);
      this.recheck ??= window.setInterval(() => this.checkHeld(), HOLD_RECHECK_MS);
    }
    return editing;
  }

  /** Whether any view of `localPath` is open and has loaded it. */
  hasViews(localPath: string): boolean {
    return this.viewsOf(localPath).length > 0;
  }

  /** Told the path of each held write once its edit has ended, so it can be written. */
  onEditEnded(listener: (localPath: string) => void): () => void {
    this.endedListeners.add(listener);
    return () => this.endedListeners.delete(listener);
  }

  private checkHeld(): void {
    for (const path of [...this.holding]) {
      const views = this.viewsOf(path);
      if (views.some((v) => this.probe?.editingIn(v.containerEl))) continue;
      this.holding.delete(path);
      for (const l of [...this.endedListeners]) l(path);
    }
    if (this.holding.size === 0 && this.recheck !== null) {
      window.clearInterval(this.recheck);
      this.recheck = null;
    }
  }

  private viewsOf(localPath: string): TextViewLike[] {
    return this.views().filter((v) => v.file?.path === localPath && typeof v.data === 'string' && v.data !== '');
  }

  async beforeWrite(localPath: string): Promise<void> {
    const views = this.viewsOf(localPath);
    // Said even when there are none: a write that found no open view with the
    // file loaded used to leave no line at all, so the log could not show it
    // (NEC-216).
    log.debug('Asking open views to save before a write', { path: localPath, views: views.length });
    // Every view holds the last write: it loaded it after the quick check and
    // before this one. What they held is that write, as the quick check would
    // have said; kept as the base it was before, a save of theirs built on it
    // read its changes as edits, and reverted whatever this write brings
    // (found in review).
    const pending = this.written.get(localPath);
    if (pending !== undefined && views.length > 0 && views.every((v) => v.data === pending)) {
      this.written.delete(localPath);
      this.held.set(localPath, pending);
      const timer = this.timers.get(localPath);
      if (timer) window.clearTimeout(timer);
      this.timers.delete(localPath);
    }
    for (const v of views) await v.save();
    // While an earlier write's check is pending, what the views held is the
    // base a save of theirs is read in against — and what they hold now may be
    // a save not read in yet, this one or one forced before it. Taken as the
    // base, that save diffed to nothing against itself, and a shape it added
    // never reached the document (NEC-238, hardness seed 235003; canvas lost a
    // node move the same way). It is moved on by `ingested`, once read in.
    if (this.written.has(localPath)) return;
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
    this.scheduleCheck(localPath, text, prior, readBack);
    // Obsidian reloads a view within moments of the write. Seen to have done
    // so, a save it makes next is built on the write, and is merged against
    // that — not against what it held before, which replayed the collaborator's
    // change a second time for any save made inside the check's second (found
    // in the second review). A view mid-save misses the reload, and is left to
    // the check as before.
    window.setTimeout(() => {
      if (this.written.get(localPath) !== text) return;
      const views = this.viewsOf(localPath);
      if (views.length === 0 || views.some((v) => v.data !== text)) return;
      this.written.delete(localPath);
      this.held.set(localPath, text);
      const timer = this.timers.get(localPath);
      if (timer) window.clearTimeout(timer);
      this.timers.delete(localPath);
    }, QUICK_CHECK_MS);
  }

  /**
   * `LOAD_CHECK_MS` from now, check the views of `localPath` loaded `text`, and
   * repair any that did not. Not while an edit is in progress in one (SAFE-A26):
   * the repair reloads the view, which is the very thing the hold keeps away
   * from an edit (found in review). The check waits instead, keeping what the
   * views held, so a save made meanwhile is still merged against that.
   */
  private scheduleCheck(localPath: string, text: string, prior: string, readBack?: () => Promise<string>): void {
    this.timers.set(localPath, window.setTimeout(() => {
      this.timers.delete(localPath);
      if (this.probe && this.viewsOf(localPath).some((v) => this.probe!.editingIn(v.containerEl))) {
        log.debug('Waiting for an edit to end before checking an open view loaded a write', { path: localPath });
        this.scheduleCheck(localPath, text, prior, readBack);
        return;
      }
      this.written.delete(localPath);
      const missed = this.viewsOf(localPath).filter((v) => v.data !== text);
      if (missed.length === 0) return;
      // What the views hold now: a save read in while the check waited moved
      // it on from what they held at the write (found in the second review).
      const base = this.held.get(localPath) ?? prior;
      void this.repair(localPath, base, missed, readBack).catch((err: unknown) => {
        log.warn('Could not bring an open view up to date', { path: localPath, error: String(err) });
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
    views: TextViewLike[],
    readBack?: () => Promise<string>,
  ): Promise<void> {
    log.warn('An open view did not load a remote change; reading its copy in against what it held', {
      path: localPath,
    });
    this.repairing.set(localPath, prior);
    log.debug('Asking open views to save, for a repair', { path: localPath, views: views.length });
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
    if (this.recheck !== null) window.clearInterval(this.recheck);
    this.recheck = null;
    this.stopProbe?.();
    this.stopProbe = null;
    this.holding.clear();
    this.endedListeners.clear();
  }
}
