import type * as Y from 'yjs';
import type { ChangeSet } from '@codemirror/state';

/** The one changed region between two strings: `[start, start+deleted)` in `a` became `inserted`. */
export interface Hunk {
  start: number;
  deleted: number;
  inserted: string;
}

/** Common prefix and suffix, and what lies between them. */
export function hunkBetween(a: string, b: string): Hunk | null {
  let prefix = 0;
  const min = Math.min(a.length, b.length);
  while (prefix < min && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (suffix < min - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix++;
  const deleted = a.length - prefix - suffix;
  const inserted = b.slice(prefix, b.length - suffix);
  if (deleted === 0 && inserted.length === 0) return null;
  return { start: prefix, deleted, inserted };
}

/**
 * Apply a minimal diff to a Y.Text to preserve CRDT character identities.
 * Instead of delete-all + insert-all (which creates tombstones that destroy
 * concurrent changes), this finds the common prefix/suffix and only modifies
 * the changed region.
 */
export function applyMinimalDiff(ydoc: Y.Doc, ytext: Y.Text, oldStr: string, newStr: string): void {
  const hunk = hunkBetween(oldStr, newStr);
  if (!hunk) return;
  ydoc.transact(() => {
    if (hunk.deleted > 0) ytext.delete(hunk.start, hunk.deleted);
    if (hunk.inserted.length > 0) ytext.insert(hunk.start, hunk.inserted);
  });
}

/**
 * Bring an edit made from `base` to `next` into a Y.Text that may have moved
 * on from `base` since — a remote change the file had not received yet.
 *
 * Diffing `next` against the Y.Text would read that remote change's absence
 * from the file as the user reverting it. So the local change is taken as one
 * hunk against `base`, the remote change as one hunk against `base`, and the
 * local hunk is moved to where it belongs in the current text:
 *
 * - apart from the remote hunk: shifted past it if after it;
 * - overlapping it: both insertions survive, and the base characters the local
 *   edit deleted are deleted where they still exist. Nothing either side typed
 *   is dropped; a character both sides deleted stays deleted.
 *
 * The remote change is summarised as a single hunk, so two remote edits far
 * apart are treated as one region between them. That can place a local
 * insertion at the region's edge rather than exactly where it was typed —
 * never lose it.
 */
export function mergeTextEdit(ydoc: Y.Doc, ytext: Y.Text, base: string, next: string): void {
  const current = ytext.toString();
  if (current === base) {
    applyMinimalDiff(ydoc, ytext, base, next);
    return;
  }
  const local = hunkBetween(base, next);
  if (!local) return;
  const remote = hunkBetween(base, current);
  if (!remote) {
    applyMinimalDiff(ydoc, ytext, base, next);
    return;
  }
  // A `next` that already holds the remote change was built on the current
  // text, not on `base` — a view that did load the change after all, or a save
  // read in twice. Then the small edit is the one from the current text, and
  // replaying `base → next` would type the remote change in a second time.
  // Built on `base` instead, the edit from the current text has to undo the
  // remote change as well, and is the larger of the two.
  const fromCurrent = hunkBetween(current, next);
  const size = (h: Hunk | null): number => (h ? h.deleted + h.inserted.length : 0);
  if (size(fromCurrent) < size(local)) {
    applyMinimalDiff(ydoc, ytext, current, next);
    return;
  }
  const shift = remote.inserted.length - remote.deleted;
  const localEnd = local.start + local.deleted;
  const remoteEnd = remote.start + remote.deleted;

  ydoc.transact(() => {
    if (localEnd <= remote.start) {
      // Wholly before the remote change.
      if (local.deleted > 0) ytext.delete(local.start, local.deleted);
      if (local.inserted) ytext.insert(local.start, local.inserted);
      return;
    }
    if (local.start >= remoteEnd) {
      // Wholly after it.
      if (local.deleted > 0) ytext.delete(local.start + shift, local.deleted);
      if (local.inserted) ytext.insert(local.start + shift, local.inserted);
      return;
    }
    // Overlapping. Highest positions first, so earlier ones stay valid.
    const afterFrom = Math.max(local.start, remoteEnd);
    if (localEnd > afterFrom) ytext.delete(afterFrom + shift, localEnd - afterFrom);
    const beforeTo = Math.min(localEnd, remote.start);
    if (local.start < remote.start) {
      if (beforeTo > local.start) ytext.delete(local.start, beforeTo - local.start);
      if (local.inserted) ytext.insert(local.start, local.inserted);
    } else if (local.inserted) {
      ytext.insert(remote.start + remote.inserted.length, local.inserted);
    }
  });
}

/**
 * Replay into a document what the user did to its editor while the editor was
 * being bound (NEC-159, SAFE-B5).
 *
 * `changes` is exactly what the user typed and deleted, recorded by
 * `PendingEdits` from the editor's own transactions, as one change set from
 * `base` — the editor's text when the bind began. The content is not inferred:
 * four versions that inferred it from the editor, the file and the document
 * each lost a keystroke somewhere, because at the level of characters "typed"
 * and "shown but not yet reloaded" can be the same string.
 *
 * Only the positions are mapped, from `base` to the document, through a
 * character diff between the two — the document may have moved on with a
 * collaborator's change. Where repeated characters make that mapping
 * ambiguous, text lands at one of several places that read the same: never
 * lost, never doubled.
 *
 * A deletion removes a document character only where the diff matches the
 * deleted one to it. A character the document no longer has — a collaborator
 * deleted it too — is skipped, so a stale position can never cut their text.
 *
 * `placed` is false when `base` and the document differ by more than a diff
 * will be run over; nothing is applied, and the caller keeps the editor's text
 * in a backup instead.
 */
export function replayEdits(
  ydoc: Y.Doc,
  ytext: Y.Text,
  base: string,
  changes: ChangeSet,
): { inserted: number; deleted: number; skipped: number; placed: boolean } {
  const result = { inserted: 0, deleted: 0, skipped: 0, placed: true };
  if (changes.empty) return result;
  const align = editScript(base, ytext.toString());
  if (!align) return { ...result, placed: false };

  // Where each character of `base` is in the document, or where it would sit
  // if the document has since deleted it: after the document's own insertion
  // at that gap, so typing at the same spot as a collaborator goes after theirs.
  const docAt = new Array<number>(base.length + 1);
  for (let i = 0, p = 0; i <= base.length; i++) {
    p += align.inserted.get(i)?.length ?? 0;
    docAt[i] = p;
    if (i < base.length && !align.deleted.has(i)) p++;
  }

  const ops: { from: number; to: number; text: string }[] = [];
  changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    ops.push({ from: fromA, to: toA, text: inserted.toString() });
  });

  // Last first, so each one's positions are untouched by those after it.
  ydoc.transact(() => {
    for (let o = ops.length - 1; o >= 0; o--) {
      const { from, to, text } = ops[o];
      for (let i = to - 1; i >= from; i--) {
        if (align.deleted.has(i)) {
          result.skipped++;
          continue;
        }
        ytext.delete(docAt[i], 1);
        result.deleted++;
      }
      if (text) {
        ytext.insert(docAt[from], text);
        result.inserted += text.length;
      }
    }
  });
  return result;
}

/**
 * Bring a save made from `base` to `next` into a Y.Text that may have moved on
 * since — `mergeTextEdit`, edit by edit instead of as one hunk.
 *
 * Needed for a view that rewrites the whole file on every save, as the Kanban
 * plugin does: its save of one card can also drop the file's last newline, so
 * the save as one hunk spans almost the whole file, and a collaborator's card
 * that landed inside that span was put after the board's settings block — seen
 * in the e2e (NEC-25). Taken edit by edit, each lands where it was made.
 *
 * The merge is by whole lines, then applied to the Y.Text character by
 * character. Each line the save added or removed against `base` is placed in
 * the current text through a line diff of `base` against it: a line goes
 * after a collaborator's added at the same spot, a line they already removed
 * is not removed again, and nothing either side wrote is dropped. A changed
 * line is a removal and an addition, so a line both sides changed is kept in
 * both versions. By lines, not characters, because characters coincide: a
 * character merge built a new card partly from the `- [ ] ` of a card the
 * collaborator had deleted, and their deletion left the new card broken
 * (found by the fuzz test). The text that results is reached from the current
 * text by a character diff, so what neither side touched keeps its identity.
 *
 * A `next` built on the current text rather than on `base` — a view that did
 * load the change after all — would add the collaborator's lines a second
 * time if replayed from `base`. It is taken to be built on the current text
 * only if it holds every current line, in order (`holdsTheirLines`); then it
 * is the result as it stands. Any other save is replayed, and at worst adds
 * their lines twice — a copy to delete, never a loss.
 *
 * Identical lines cannot be told apart, so as in any three-way merge the same
 * change made on both sides counts once: both removing a copy of one line
 * removes one copy, and both adding the same line where a save holds all of
 * theirs leaves it once. Every line anyone wrote is still there.
 *
 * False, with nothing applied, when a diff is too large to run or the texts
 * have too many distinct lines; the caller falls back to `mergeTextEdit`.
 */
export function mergeEdits(ydoc: Y.Doc, ytext: Y.Text, base: string, next: string): boolean {
  const current = ytext.toString();
  if (current === base) {
    applyMinimalDiff(ydoc, ytext, base, next);
    return true;
  }
  const lines = new LineCodes();
  const b = lines.encode(base);
  const c = lines.encode(current);
  const n = lines.encode(next);
  if (b === null || c === null || n === null) return false;
  const align = editScript(b, c);
  const local = align ? editScript(b, n) : null;
  if (!align || !local) return false;

  let target: string;
  if (holdsTheirLines(align, c, n)) {
    target = next;
  } else {
    // Where each line of `base` is in the current text, as in replayEdits.
    const docAt = new Array<number>(b.length + 1);
    for (let i = 0, p = 0; i <= b.length; i++) {
      p += align.inserted.get(i)?.length ?? 0;
      docAt[i] = p;
      if (i < b.length && !align.deleted.has(i)) p++;
    }
    const out = current.split('\n');
    // Identical lines cannot be told apart, so a line we removed that the
    // collaborator also removed a copy of is taken to be the same removal: at
    // worst an identical card is left to remove again, never one too many
    // taken (found by the fuzz test).
    const theyRemoved = new Map<string, number>();
    for (const i of align.deleted) theyRemoved.set(b[i], (theyRemoved.get(b[i]) ?? 0) + 1);
    const points = [...new Set<number>([...local.inserted.keys(), ...local.deleted])].sort((x, y) => y - x);
    for (const i of points) {
      if (local.deleted.has(i) && align.deleted.has(i)) theyRemoved.set(b[i], (theyRemoved.get(b[i]) ?? 1) - 1);
      else if (local.deleted.has(i) && (theyRemoved.get(b[i]) ?? 0) > 0) theyRemoved.set(b[i], theyRemoved.get(b[i])! - 1);
      else if (local.deleted.has(i)) out.splice(docAt[i], 1);
      const added = local.inserted.get(i);
      if (added) out.splice(docAt[i], 0, ...lines.decode(added));
    }
    target = out.join('\n');
  }
  if (target === current) return true;
  const ops = editScript(current, target);
  if (ops) applyScript(ydoc, ytext, ops, (i) => i, () => false);
  else applyMinimalDiff(ydoc, ytext, current, target);
  return true;
}

/** Whole lines as single UTF-16 units from the private use area, so Myers can diff them. */
class LineCodes {
  private ids = new Map<string, string>();
  private lines: string[] = [];

  /** Null past 6400 distinct lines, which is as many as the area holds. */
  encode(text: string): string | null {
    let out = '';
    for (const line of text.split('\n')) {
      let id = this.ids.get(line);
      if (id === undefined) {
        if (this.lines.length >= 6400) return null;
        id = String.fromCharCode(0xe000 + this.lines.length);
        this.ids.set(line, id);
        this.lines.push(line);
      }
      out += id;
    }
    return out;
  }

  decode(codes: string): string[] {
    return Array.from(codes, (ch) => this.lines[ch.charCodeAt(0) - 0xe000]);
  }
}

/**
 * Whether `n` holds every line of the current text `c`, in order, while the
 * collaborator did add lines: the save only adds to what they made, so it is
 * taken to be built on it.
 *
 * Strict on purpose. Asking only whether the lines *they* added survive was
 * fooled twice: two diffs picked different copies of an identical line, and a
 * card they duplicated beside itself was dropped (found in the second review);
 * and a card both sides added independently, at different places, was taken
 * for one (found by the fuzz test). Identical lines cannot be told apart by
 * content, so any save that removes a line goes the other way — replayed,
 * where the worst case is their lines appearing twice.
 */
function holdsTheirLines(
  align: { inserted: Map<number, string>; deleted: Set<number> },
  c: string,
  n: string,
): boolean {
  if (align.inserted.size === 0) return false;
  const toNext = editScript(c, n);
  return toNext !== null && toNext.deleted.size === 0;
}

/**
 * Apply an edit script over `from`, each position mapped into the Y.Text by
 * `at`. Highest first, so each step's positions are untouched by the ones
 * after it. A deletion of a character `gone` says is no longer there is skipped.
 */
function applyScript(
  ydoc: Y.Doc,
  ytext: Y.Text,
  script: { inserted: Map<number, string>; deleted: Set<number> },
  at: (i: number) => number,
  gone: (i: number) => boolean,
): void {
  const points = [...new Set<number>([...script.inserted.keys(), ...script.deleted])].sort((a, b) => b - a);
  ydoc.transact(() => {
    for (const i of points) {
      if (script.deleted.has(i) && !gone(i)) ytext.delete(at(i), 1);
      const text = script.inserted.get(i);
      if (text) ytext.insert(at(i), text);
    }
  });
}

/**
 * Beyond this many edits a character diff is not attempted: its cost grows with
 * the square. The editor as the bind began and the document differ this much
 * only after a large remote change, and then the typing goes to a backup.
 */
const MAX_EDITS = 2000;

/**
 * A minimal edit from `a` to `b`: the text inserted at each gap of `a` (keyed
 * by the index of the character it goes before, `a.length` for the end), and
 * which characters of `a` it deletes. Null when the two differ by more than
 * `MAX_EDITS`. Myers' algorithm, over what lies between the common prefix and
 * suffix.
 */
function editScript(
  a: string,
  b: string,
): { inserted: Map<number, string>; deleted: Set<number> } | null {
  let pre = 0;
  const min = Math.min(a.length, b.length);
  while (pre < min && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < min - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const n = a.length - pre - suf;
  const m = b.length - pre - suf;
  const A = (i: number): string => a[pre + i];
  const B = (j: number): string => b[pre + j];

  const offset = MAX_EDITS + 1;
  const v = new Int32Array(2 * MAX_EDITS + 3);
  const trace: Int32Array[] = [];
  let found = -1;
  for (let d = 0; d <= MAX_EDITS && found < 0; d++) {
    trace.push(v.slice(offset - d - 1, offset + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])
        ? v[offset + k + 1]
        : v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && A(x) === B(y)) { x++; y++; }
      v[offset + k] = x;
      if (x >= n && y >= m) { found = d; break; }
    }
  }
  if (found < 0) return null;

  // Walk back from the end, collecting each step's insertion or deletion.
  // Backwards, so each inserted character goes in front of its gap's text.
  const inserted = new Map<number, string>();
  const deleted = new Set<number>();
  let x = n;
  let y = m;
  for (let d = found; d > 0; d--) {
    const saved = trace[d];
    const get = (k: number): number => saved[k + d + 1];
    const k = x - y;
    const down = k === -d || (k !== d && get(k - 1) < get(k + 1));
    const prevK = down ? k + 1 : k - 1;
    const prevX = get(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) { x--; y--; }
    if (down) {
      const gap = pre + prevX;
      inserted.set(gap, B(prevY) + (inserted.get(gap) ?? ''));
    } else {
      deleted.add(pre + prevX);
    }
    x = prevX;
    y = prevY;
  }
  return { inserted, deleted };
}
