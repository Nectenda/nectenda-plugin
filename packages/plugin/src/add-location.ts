/**
 * Where a shared folder lands when it is added to this vault without asking.
 *
 * It used to land at the folder's own name, whatever was already there. When
 * a vault already had a folder of that name, adding the shared one adopted it:
 * the notes that happened to be in it were uploaded to every member of the
 * shared folder. Nothing was lost — differing copies of the same path went to
 * `.nectenda-backups/` — but notes that were never meant to be shared were
 * shared, and there is no taking that back.
 *
 * So the automatic choice only ever uses a folder that is missing or empty,
 * and otherwise picks a free name beside it. Adopting a folder with notes in
 * it is still possible, by choosing it, and that path asks first.
 */

export type PathState = 'missing' | 'empty' | 'occupied';

export function defaultAddLocation(name: string, stateOf: (path: string) => PathState): string {
  const base = name.trim() || 'Shared folder';
  const usable = (p: string) => stateOf(p) !== 'occupied';
  if (usable(base)) return base;
  if (usable(`${base} (shared)`)) return `${base} (shared)`;
  for (let n = 2; ; n++) {
    const p = `${base} (shared ${n})`;
    if (usable(p)) return p;
  }
}

/** What a vault path holds, from Obsidian's own view of it. A file at the path counts as occupied. */
export function pathState(entry: { children?: unknown[] } | null | undefined): PathState {
  if (!entry) return 'missing';
  if (Array.isArray(entry.children) && entry.children.length === 0) return 'empty';
  return 'occupied';
}
