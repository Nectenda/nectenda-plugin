import * as Y from 'yjs';
import { ROOT_NODE_FIELDS, type CanvasRecord, type CanvasValue } from './canvas-model';
import { SEP } from './structured-records';

/**
 * Paths inside a canvas, as each vault names them (NEC-251, SAFE-A33).
 *
 * A file card stores a vault path, not a link: `"file": "Shared/Notes/idea.md"`.
 * Obsidian resolves it exactly, never by name. But one shared folder sits at a
 * different place in each vault — `Shared` here, `Shared (shared)` for a member
 * who already had a `Shared` (add-location.ts), anywhere at all for one who
 * chose — so a path written by one vault named nothing in another, and the card
 * said "could not be found" (and offered to create the note, outside the
 * shared folder).
 *
 * So the document never holds this vault's path for a file in the folder. On
 * the way in, `share` turns `<root>/rest` into `./rest`; on the way out,
 * `localise` turns it back into this vault's `<root>/rest`. `./` cannot begin a
 * vault path, so a path that was never rewritten is never mistaken for one
 * that was. A path outside the shared folder is left exactly as written: it
 * names a file the other vaults do not have, and rewriting it would only
 * disguise that.
 *
 * The fields that hold a path: every node's `file` (a file card), and a
 * group's `background` (an image behind it).
 */

/** The prefix of a path relative to the shared folder, as the document holds it. */
export const IN_FOLDER = './';

/** Node fields whose value is a vault path. */
const PATH_FIELDS: ReadonlySet<string> = new Set(['file', 'background']);

function shareOne(p: string, root: string): string {
  return p.startsWith(`${root}/`) ? IN_FOLDER + p.slice(root.length + 1) : p;
}

function localiseOne(p: string, root: string): string {
  return p.startsWith(IN_FOLDER) ? `${root}/${p.slice(IN_FOLDER.length)}` : p;
}

function mapNode(n: CanvasRecord, f: (p: string) => string): CanvasRecord {
  let out: CanvasRecord | null = null;
  for (const k of PATH_FIELDS) {
    const v = n[k];
    if (typeof v !== 'string') continue;
    const next = f(v);
    if (next === v) continue;
    out ??= { ...n };
    out[k] = next;
  }
  return out ?? n;
}

function mapValue(v: CanvasValue, f: (p: string) => string): CanvasValue {
  let changed = false;
  const nodes = v.nodes.map((n) => {
    const m = mapNode(n, f);
    if (m !== n) changed = true;
    return m;
  });
  return changed ? { ...v, nodes } : v;
}

/** Strip a trailing slash, so `Shared/` and `Shared` name the same root. */
function rootOf(root: string): string {
  return root.replace(/\/+$/, '');
}

/** This vault's canvas, as the document holds it: paths in the folder made relative to it. */
export function shareCanvasPaths(v: CanvasValue, root: string): CanvasValue {
  const r = rootOf(root);
  return r === '' ? v : mapValue(v, (p) => shareOne(p, r));
}

/** The document's canvas, as this vault names it: relative paths put under this vault's root. */
export function localiseCanvasPaths(v: CanvasValue, root: string): CanvasValue {
  const r = rootOf(root);
  return r === '' ? v : mapValue(v, (p) => localiseOne(p, r));
}

/**
 * Rewrite, inside the document, the paths an older client stored as this
 * vault's own (schema 1). Only a path under this vault's root is touched — the
 * one this vault can tell is in the folder — and only into the value it
 * already means here, so the card shows what it showed before. Returns how
 * many fields it rewrote. Called inside a transaction the caller owns.
 */
export function shareDocPaths(ydoc: Y.Doc, root: string): number {
  const r = rootOf(root);
  if (r === '') return 0;
  const fields = ydoc.getMap<unknown>(ROOT_NODE_FIELDS);
  let n = 0;
  for (const [key, value] of [...fields.entries()]) {
    const field = key.slice(key.indexOf(SEP) + 1);
    if (!PATH_FIELDS.has(field) || typeof value !== 'string') continue;
    const next = shareOne(value, r);
    if (next === value) continue;
    fields.set(key, next);
    n++;
  }
  return n;
}
