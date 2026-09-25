import { MAX_PUSH_BYTES } from '@nectenda/shared';
import type { PersistedKeys } from './blob-sync';
import type { TimerHandle } from './timers';
import { forgetUnmappedRecords } from './pane-summaries';

/**
 * Headroom between a file's size on disk and the push it becomes.
 *
 * A note's first push is the whole file as one Yjs insert, sealed. Pushes are
 * not compressed, so the payload is the file's UTF-8 bytes plus the update's
 * framing and the cipher's nonce and tag — a few dozen bytes. 4 KiB is far
 * more than that on purpose: a file just under the limit that is warned about
 * costs a notice, and one just over it that is not is the silence this exists
 * to end (SAFE-A12).
 */
export const OVERSIZE_ALLOWANCE_BYTES = 4 * 1024;

/** A note at least this large is named as one that will not sync. */
export const OVERSIZE_WARN_BYTES = MAX_PUSH_BYTES - OVERSIZE_ALLOWANCE_BYTES;

/**
 * Quiet time before one notice names every note found.
 *
 * Every connected note's size is checked, small ones included, and each check
 * restarts this while a warning is waiting. A folder scan connects about 25
 * notes a second for as long as the folder takes, so the notice comes once the
 * scan goes quiet — one notice for the folder rather than one for every second
 * of the scan. A fixed window from the first large note would have split a
 * 200-note folder into several.
 */
export const OVERSIZE_NOTICE_WINDOW_MS = 1000;

/**
 * The longest a waiting warning is held, however busy the checks are. Typing
 * in a note checks it on every save, and must not put the notice off for ever.
 */
export const OVERSIZE_NOTICE_MAX_WAIT_MS = 30_000;

export interface OversizedNote {
  sharedFolderId: string;
  relativePath: string;
  bytes: number;
}

export interface OversizedNotesDeps {
  /** Notes already warned about, keyed `<folderId> <path>`. Survives a restart. */
  store: PersistedKeys;
  save(): Promise<void>;
  /** Tell the person. Called once per window, with every note found in it. */
  notify(notes: OversizedNote[]): void;
}

const keyOf = (sharedFolderId: string, relativePath: string): string =>
  `${sharedFolderId} ${relativePath}`;

/**
 * Notes too large to sync, named before anyone relies on them syncing.
 *
 * SAFE-A11 already holds such a note's push back and puts an error on its
 * icon — but only once a push has been tried, and only on a note someone
 * happens to look at. This says so when the file arrives, once, and keeps a
 * record the settings tab lists while the note stays too large.
 *
 * It only ever reads a size. Nothing here can stop a file connecting or change
 * a byte of it, which is why a wrong answer costs a notice and nothing more.
 */
export class OversizedNotes {
  private deps: OversizedNotesDeps;
  private queued: Map<string, OversizedNote> = new Map();
  private timer: TimerHandle | null = null;
  /** When the oldest waiting warning was queued, for the cap. */
  private firstQueuedAt = 0;

  constructor(deps: OversizedNotesDeps) {
    this.deps = deps;
  }

  /**
   * A note renamed or moved within its folder carries its record along, so the
   * same note is not announced a second time under its new name, and the old
   * name is not left holding a record that would silence a different note
   * created there later.
   */
  move(sharedFolderId: string, fromPath: string, toPath: string): void {
    const from = keyOf(sharedFolderId, fromPath);
    const to = keyOf(sharedFolderId, toPath);
    const waiting = this.queued.get(from);
    if (waiting) {
      this.queued.delete(from);
      this.queued.set(to, { ...waiting, relativePath: toPath });
    }
    const recorded = this.deps.store.get();
    if (!recorded.includes(from)) return;
    this.deps.store.set([...recorded.filter((k) => k !== from && k !== to), to]);
    void this.deps.save();
  }

  /** A note deleted or moved out of its folder: nothing left to warn about. */
  forget(sharedFolderId: string, relativePath: string): void {
    const key = keyOf(sharedFolderId, relativePath);
    this.queued.delete(key);
    const recorded = this.deps.store.get();
    if (!recorded.includes(key)) return;
    this.deps.store.set(recorded.filter((k) => k !== key));
    void this.deps.save();
  }

  /**
   * Drop the records of folders no longer mapped. Returns whether anything
   * changed. It does not save: the caller saves once for all its lists.
   */
  forgetUnmapped(mappedFolderIds: ReadonlySet<string>): boolean {
    // Waiting warnings first: they are not in the record yet, so the early
    // return below would skip them.
    for (const [key, note] of this.queued) {
      if (!mappedFolderIds.has(note.sharedFolderId)) this.queued.delete(key);
    }
    const recorded = this.deps.store.get();
    const kept = forgetUnmappedRecords(recorded, mappedFolderIds);
    if (kept.length === recorded.length) return false;
    this.deps.store.set(kept);
    return true;
  }

  /**
   * Look at one note's size.
   *
   * Over the threshold and never warned about: queue a warning and record it,
   * so no later launch repeats it. Under it: forget any record, so that
   * growing past the limit again is news again.
   */
  check(sharedFolderId: string, relativePath: string, bytes: number): void {
    const key = keyOf(sharedFolderId, relativePath);
    const recorded = this.deps.store.get();
    if (bytes < OVERSIZE_WARN_BYTES) {
      // Trimmed inside the window: nothing left to warn about.
      this.queued.delete(key);
      if (recorded.includes(key)) {
        this.deps.store.set(recorded.filter((k) => k !== key));
        void this.deps.save();
      }
    } else if (!recorded.includes(key) && !this.queued.has(key)) {
      if (this.queued.size === 0) this.firstQueuedAt = Date.now();
      this.queued.set(key, { sharedFolderId, relativePath, bytes });
    }
    // Any check, of any note, while a warning waits: the scan is still going.
    if (this.queued.size > 0) this.reschedule();
  }

  private reschedule(): void {
    if (this.timer !== null) window.clearTimeout(this.timer);
    const left = this.firstQueuedAt + OVERSIZE_NOTICE_MAX_WAIT_MS - Date.now();
    this.timer = window.setTimeout(() => this.flush(), Math.max(0, Math.min(OVERSIZE_NOTICE_WINDOW_MS, left)));
  }

  /**
   * Recorded notes that still exist and are still too large.
   *
   * The record is written when the warning is, and a note can then be deleted,
   * moved out, or trimmed while nothing is watching. So the list is checked
   * against the disk rather than trusted, and whatever no longer holds is
   * dropped from it.
   */
  listStillOversized(
    sizeOf: (sharedFolderId: string, relativePath: string) => number | null,
  ): OversizedNote[] {
    const recorded = this.deps.store.get();
    const still: OversizedNote[] = [];
    const keep: string[] = [];
    for (const key of recorded) {
      const gap = key.indexOf(' ');
      if (gap < 0) continue;
      const sharedFolderId = key.slice(0, gap);
      const relativePath = key.slice(gap + 1);
      const bytes = sizeOf(sharedFolderId, relativePath);
      if (bytes === null || bytes < OVERSIZE_WARN_BYTES) continue;
      keep.push(key);
      still.push({ sharedFolderId, relativePath, bytes });
    }
    if (keep.length !== recorded.length) {
      this.deps.store.set(keep);
      void this.deps.save();
    }
    return still;
  }

  /** Stop a pending notice, for unload. What was queued is not recorded. */
  dispose(): void {
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = null;
    this.queued.clear();
  }

  private flush(): void {
    this.timer = null;
    const notes = [...this.queued.values()];
    this.queued.clear();
    if (notes.length === 0) return;
    // Recorded as they are shown, not as they are found: a note queued and
    // then lost to an unload has not been warned about, so the next launch
    // should warn.
    const recorded = this.deps.store.get();
    this.deps.store.set([...recorded, ...notes.map((n) => keyOf(n.sharedFolderId, n.relativePath))]);
    void this.deps.save();
    this.deps.notify(notes);
  }
}

/** How many notes one notice names before it says "and N more". */
export const OVERSIZE_NOTICE_NAMES = 5;

/** The notice's words, kept here so a test can read them without Obsidian. */
export function describeOversizedNotes(notes: OversizedNote[], formatSize: (bytes: number) => string): string {
  const limit = formatSize(MAX_PUSH_BYTES);
  if (notes.length === 1) {
    const [n] = notes;
    return `Nectenda: "${n.relativePath}" is ${formatSize(n.bytes)}, over the ${limit} limit for a note, `
      + 'so it will not sync. It stays on this device. Split it or remove the large part, '
      + 'and it syncs by itself.';
  }
  const named = notes.slice(0, OVERSIZE_NOTICE_NAMES).map((n) => `"${n.relativePath}" (${formatSize(n.bytes)})`);
  const more = notes.length - named.length;
  return `Nectenda: ${notes.length} notes are over the ${limit} limit for a note, so they will not sync: `
    + named.join(', ')
    + (more > 0 ? `, and ${more} more` : '')
    + '. They stay on this device. Split them or remove the large parts, and they sync by themselves.';
}
