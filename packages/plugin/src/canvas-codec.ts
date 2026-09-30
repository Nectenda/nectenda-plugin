import type { StructuredCodec } from './structured-formats';
import {
  applyCanvas, canonical, normaliseCanvas, readCanvas, type CanvasRecord, type CanvasValue,
} from './canvas-model';

/**
 * `.canvas` files (JSON Canvas) as a structured format: the text boundary
 * around canvas-model.ts.
 *
 * Everything here is about the file. The merge — per-field entries, card text
 * as Y.Text, fractional z-order, deletion by tombstone — is in the model, so
 * that a binding to an open canvas view can share it without going through
 * JSON.
 */

/**
 * The Obsidian version the formatter below, and the behaviour the canvas path
 * relies on, were read against. An end-to-end contract spec checks each
 * assumption against the Obsidian the test suite runs, so a version bump that
 * changes one goes red rather than drifting silently. Update this when they
 * are re-read.
 */
export const OBSIDIAN_READ_AGAINST = '1.13.7';

/**
 * Obsidian's own JSON formatter for canvas files, ported.
 *
 * Read from Obsidian 1.13.7's `app.js` (the functions minified as `$d` and
 * `Zd`). It is not `JSON.stringify(v, null, '\t')`:
 *
 * - an array whose items are all primitives, and an object whose values are
 *   all primitives, go on one compact line — so a node is one line;
 * - otherwise one item per line, indented by a tab (hard-coded; the indent
 *   argument is ignored), with `"key":value` and no space;
 * - `null` counts as an object for the "all primitives" test, so an object
 *   holding a null is spread over lines;
 * - keys whose value is undefined are left out; no trailing newline.
 *
 * Writing the file the way Obsidian writes it means an open canvas that
 * reloads our write and later saves does not reformat it. SAFE-A15 compares by
 * meaning, so a mismatch here costs one reformatting, never a loop — but it is
 * churn in the user's file, and in their git history if they keep one.
 */
export function formatObsidianJson(value: unknown): string {
  return lines(value).join('\n');
}

const isPrimitive = (v: unknown): boolean => typeof v !== 'object';

function lines(e: unknown): string[] {
  if (e === undefined) return ['null'];
  if (isPrimitive(e) || !e || Object.prototype.toString.call(e) === '[object Date]') return [JSON.stringify(e)];
  if (Array.isArray(e)) {
    if (e.every(isPrimitive)) return [JSON.stringify(e)];
    const out = ['['];
    for (let r = 0; r < e.length; r++) {
      const h = lines(e[r]);
      for (let a = 0; a < h.length; a++) {
        let s = '\t' + h[a];
        if (a === h.length - 1 && r !== e.length - 1) s += ',';
        out.push(s);
      }
    }
    out.push(']');
    return out;
  }
  const obj = e as Record<string, unknown>;
  let flat = true;
  for (const k in obj) {
    if (Object.prototype.hasOwnProperty.call(obj, k) && !isPrimitive(obj[k])) {
      flat = false;
      break;
    }
  }
  if (flat) return [JSON.stringify(obj)];
  const out = ['{'];
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined);
  for (let r = 0; r < keys.length; r++) {
    const h = lines(obj[keys[r]]);
    h[0] = JSON.stringify(keys[r]) + ':' + h[0];
    for (let a = 0; a < h.length; a++) {
      let s = '\t' + h[a];
      if (a === h.length - 1 && r !== keys.length - 1) s += ',';
      out.push(s);
    }
  }
  out.push('}');
  return out;
}

/**
 * Key order, as Obsidian settles on it once it has loaded and saved a node:
 * its "unknown data" (every key but position, size and colour, in file order)
 * first, then `x, y, width, height, color`, then what a group adds. The
 * document keeps no key order, so unknown keys go alphabetically between.
 */
const NODE_LEAD = ['id', 'type', 'text', 'file', 'subpath', 'url', 'backgroundStyle'];
const NODE_TAIL = ['x', 'y', 'width', 'height', 'color', 'label', 'background'];
const EDGE_LEAD = ['id'];
const EDGE_TAIL = ['fromNode', 'fromSide', 'toNode', 'toSide', 'fromEnd', 'toEnd', 'color', 'label'];

function ordered(rec: CanvasRecord, lead: string[], tail: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of lead) if (rec[k] !== undefined) out[k] = rec[k];
  const known = new Set([...lead, ...tail]);
  for (const k of Object.keys(rec).filter((k) => !known.has(k)).sort()) out[k] = rec[k];
  for (const k of tail) if (rec[k] !== undefined) out[k] = rec[k];
  return out;
}

/** Why a parsed file is not a canvas this codec can key without guessing, or null. */
function problem(raw: unknown): string | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return 'not a JSON object';
  const obj = raw as Record<string, unknown>;
  for (const kind of ['nodes', 'edges'] as const) {
    const list = obj[kind];
    if (list === undefined) continue;
    if (!Array.isArray(list)) return `"${kind}" is not a list`;
    const seen = new Set<string>();
    for (const item of list) {
      if (typeof item !== 'object' || item === null || Array.isArray(item)) return `an entry in "${kind}" is not an object`;
      const id = (item as Record<string, unknown>).id;
      // Records are keyed by id. One without an id, or two sharing one, cannot
      // be keyed without dropping or inventing something — Obsidian itself
      // collapses duplicates on its next save — so the file is refused and
      // kept aside (SAFE-A13) rather than guessed at.
      if (typeof id !== 'string' || id === '') return `an entry in "${kind}" has no id`;
      // The document keys fields as `id \0 field`; an id holding a NUL (or the
      // \u0001 that marks internal fields) would be split in the wrong place.
      if (id.includes('\u0000') || id.includes('\u0001')) return `an entry in "${kind}" has an id with a control character`;
      if (seen.has(id)) return `two entries in "${kind}" share the id "${id}"`;
      seen.add(id);
    }
  }
  return null;
}

function toValue(raw: Record<string, unknown>): CanvasValue {
  const extra: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) if (k !== 'nodes' && k !== 'edges') extra[k] = v;
  return normaliseCanvas({
    nodes: (raw.nodes as CanvasRecord[] | undefined) ?? [],
    edges: (raw.edges as CanvasRecord[] | undefined) ?? [],
    extra,
  });
}

/** Meaning, not layout: node order counts (it is z-order); edge order and key order do not. */
function meaning(v: CanvasValue): string {
  const edges = [...v.edges].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return canonical({ nodes: v.nodes, edges, extra: v.extra });
}

export const canvasCodec: StructuredCodec = {
  format: 'canvas',
  version: 1,

  parse(text) {
    let raw: unknown;
    try {
      raw = JSON.parse(text) as unknown;
    } catch (err) {
      return { ok: false, error: String(err) };
    }
    const why = problem(raw);
    if (why) return { ok: false, error: why };
    return { ok: true, value: toValue(raw as Record<string, unknown>) };
  },

  apply(ydoc, value, base) {
    applyCanvas(ydoc, value as CanvasValue, base as CanvasValue | null);
  },

  read(ydoc) {
    return readCanvas(ydoc);
  },

  serialise(value) {
    const v = value as CanvasValue;
    const out: Record<string, unknown> = {
      nodes: v.nodes.map((n) => ordered(n, NODE_LEAD, NODE_TAIL)),
      edges: v.edges.map((e) => ordered(e, EDGE_LEAD, EDGE_TAIL)),
    };
    for (const k of Object.keys(v.extra).sort()) out[k] = v.extra[k];
    return formatObsidianJson(out);
  },

  equal(a, b) {
    return meaning(a as CanvasValue) === meaning(b as CanvasValue);
  },
};
