import { placedEntries } from './bases-internals';
import { relativeTo } from './bases-focus-draw';
import type { EntryStatus } from './file-status-indicator';

/**
 * Which entries of a shared base are shared too, marked with the file
 * explorer's sync dot.
 *
 * A base's query runs against each vault's own index, so a shared base also
 * lists notes that never leave this vault, and two cards both titled
 * "Untitled" can be one shared note and one that is not. Focus presence
 * (WIRE-096) is only ever sent for an entry under the base's own shared
 * folder, so without a mark a collaborator's outline that never appears looks
 * like a fault. The dot is drawn on exactly those entries: a dotted entry is
 * one whose presence can show.
 *
 * The same rule as the focus, deliberately — not "in any shared folder". A
 * note in another shared folder may be one this base's collaborators do not
 * have, and a dot there would promise presence that cannot come.
 *
 * Drawn as `FocusMarks` draws: a class on Obsidian's own row, card or list
 * item, and the dot a pseudo-element in styles.css. Never a child element —
 * the table rebuilds a row's children as it scrolls, and would strip one. The
 * elements are recycled as a layout scrolls, so each draw takes off whatever
 * it marked last time and no longer should: a dot left on a recycled row
 * would call an unshared note shared.
 *
 * Computed here, sent nowhere.
 */

const STATUS_CLASS: Record<EntryStatus, string> = {
  confirmed: 'nectenda-shared-confirmed',
  sending: 'nectenda-shared-sending',
  offline: 'nectenda-shared-offline',
  untracked: 'nectenda-shared-untracked',
  error: 'nectenda-shared-error',
  attachment: 'nectenda-shared-attachment',
};

export interface SharedMark {
  el: HTMLElement;
  status: EntryStatus;
}

/** The marks for one base's layout: every shown entry under `root` that has a status. */
export function sharedEntryMarks(
  layout: Record<string, unknown>,
  root: string,
  statusOf: (path: string) => EntryStatus | null,
): SharedMark[] {
  const marks: SharedMark[] = [];
  for (const placed of placedEntries(layout)) {
    if (relativeTo(root, placed.path) === null) continue;
    const status = statusOf(placed.path);
    if (status) marks.push({ el: placed.el, status });
  }
  return marks;
}

export class SharedMarks {
  private drawn = new Map<HTMLElement, EntryStatus>();

  draw(marks: SharedMark[]): void {
    const next = new Map<HTMLElement, EntryStatus>();
    for (const m of marks) if (!next.has(m.el)) next.set(m.el, m.status);
    for (const [el, status] of this.drawn) {
      const now = next.get(el);
      if (now === status) continue;
      el.classList.remove(STATUS_CLASS[status]);
      if (now === undefined) el.classList.remove('nectenda-shared-entry');
    }
    // Added every time, not only when new: a layout that rewrites an
    // element's classes would otherwise lose the dot until the status moved.
    for (const [el, status] of next) {
      el.classList.add('nectenda-shared-entry');
      el.classList.add(STATUS_CLASS[status]);
    }
    this.drawn = next;
  }

  clear(): void {
    this.draw([]);
  }

  /** What is drawn now, for tests. */
  get size(): number {
    return this.drawn.size;
  }
}
