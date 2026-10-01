import type * as Y from 'yjs';
import { keysBetween } from './fractional-key';

/**
 * Pieces every structured codec's model needs, whatever its format: values as
 * JSON carries them, comparison by meaning, deletion by tombstone, and order
 * by fractional key. Canvas (canvas-model.ts) and Bases (bases-model.ts) both
 * build on these, so the rules that keep a record someone else edited — and
 * that keep a file from rewriting itself forever — are written, and tested,
 * once.
 */

/** Separates the parts of a flat key: `id \0 field`, `kind \0 id \0 client`. */
export const SEP = '\u0000';

// ── Values ────────────────────────────────────────────────────────────────

/**
 * A value as JSON would carry it: `undefined` fields dropped, NaN and Infinity
 * as null. Everything entering a document, and everything compared, goes
 * through this — a value that does not equal its own round trip rewrites the
 * file forever (Relay 78cbc93b, 9da7ee10).
 */
export function normaliseJson(value: unknown): unknown {
  if (value === undefined) return undefined;
  const text = JSON.stringify(value);
  return text === undefined ? undefined : (JSON.parse(text) as unknown);
}

/** JSON with object keys sorted, for comparing meaning rather than layout. */
export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`).join(',')}}`;
}

/** Whether two values mean the same. */
export const same = (a: unknown, b: unknown): boolean => canonical(a) === canonical(b);

// ── Tombstones (SAFE-A18) ─────────────────────────────────────────────────

/**
 * A record deleted by one vault, as that vault saw it.
 *
 * Deleting a record by removing its entries would discard any edit to it the
 * deleting vault had not seen — including one that had already reached the
 * server, where nothing in the update says the deleter missed it. So a delete
 * records a snapshot instead, and the record reads as deleted only while it
 * still equals a snapshot. Any change the deleter had not seen makes it
 * differ, and brings it back. Tombstones are never collected: a vault offline
 * for a month still has its late edit decided against the tombstone, which is
 * exactly the case this is for.
 */
export interface Tombstone {
  snapshot: Record<string, unknown>;
  /** For a record removed together with another (an edge with its node): that one. */
  with?: string;
}

/** The key a record's tombstones are grouped under: `kind \0 id`. */
export const recordKey = (kind: string, id: string): string => `${kind}${SEP}${id}`;

/** Every tombstone in `root`, grouped by `recordKey`. */
export function tombstonesByRecord(root: Y.Map<unknown>): Map<string, Tombstone[]> {
  const out = new Map<string, Tombstone[]>();
  root.forEach((value, key) => {
    const parts = key.split(SEP);
    if (parts.length !== 3) return;
    const t = value as Tombstone | null;
    if (!t || typeof t !== 'object' || typeof t.snapshot !== 'object') return;
    const rk = `${parts[0]}${SEP}${parts[1]}`;
    let list = out.get(rk);
    if (!list) {
      list = [];
      out.set(rk, list);
    }
    list.push(t);
  });
  return out;
}

/** Whether `content` equals one of `list`'s snapshots: the record is deleted. */
export function buried(list: Tombstone[] | undefined, content: unknown): boolean {
  return list?.some((t) => same(t.snapshot, content)) ?? false;
}

/** A record wanted again (made anew, or brought back by undo): its tombstones are answered. */
export function clearTombstones(root: Y.Map<unknown>, kind: string, id: string): void {
  const prefix = `${kind}${SEP}${id}${SEP}`;
  for (const k of [...root.keys()]) if (k.startsWith(prefix)) root.delete(k);
}

/**
 * Delete a record by tombstone. `snapshot` is the record as the deleter saw it
 * — its editor's base, never the document, so a remote edit that reached the
 * document but not the editor revives it rather than being recorded as seen.
 *
 * Keyed by this vault's client id: two vaults deleting one record at once write
 * different keys, so neither overwrites the other (which SAFE-A14 would rightly
 * report as a lost write).
 */
export function bury(
  root: Y.Map<unknown>,
  clientID: number,
  kind: string,
  id: string,
  snapshot: Record<string, unknown>,
  withRecord?: string,
): void {
  const t: Tombstone = withRecord ? { snapshot, with: withRecord } : { snapshot };
  root.set(`${kind}${SEP}${id}${SEP}${clientID}`, t);
}

// ── Order ─────────────────────────────────────────────────────────────────

/**
 * Bring an order into `order` (id → fractional key). Only ids whose position
 * really changed get a new key: those outside the longest run that kept its
 * relative order from `baseIds`, and ids new to it. Moving one item re-keys one
 * item, not the list, so a concurrent move elsewhere survives.
 *
 * Readers sort by `(key, id)`: equal keys are expected — two vaults appending
 * at once — and tie-broken, never an error.
 */
export function applyOrder(order: Y.Map<unknown>, ids: string[], baseIds: string[] | null): void {
  const basePos = new Map((baseIds ?? []).map((id, i) => [id, i]));
  const kept = longestIncreasing(ids.filter((id) => basePos.has(id) && typeof order.get(id) === 'string'), basePos);

  let i = 0;
  let lo = '';
  while (i < ids.length) {
    const id = ids[i];
    if (kept.has(id)) {
      const k = order.get(id) as string;
      if (k > lo) lo = k;
      i++;
      continue;
    }
    // A run of ids needing keys, placed after `lo` and before the next kept
    // id's key that is above it.
    let j = i;
    while (j < ids.length && !kept.has(ids[j])) j++;
    let hi: string | null = null;
    for (let x = j; x < ids.length; x++) {
      const k = order.get(ids[x]);
      if (kept.has(ids[x]) && typeof k === 'string' && k > lo) {
        hi = k;
        break;
      }
    }
    const keys = keysBetween(lo, hi, j - i);
    for (let x = i; x < j; x++) order.set(ids[x], keys[x - i]);
    lo = keys[keys.length - 1] ?? lo;
    i = j;
  }
}

/** A comparator ordering ids by their key in `order`, then by id. */
export function byOrderKey(order: Y.Map<unknown>): (a: string, b: string) => number {
  const keyOf = (id: string): string => {
    const k = order.get(id);
    return typeof k === 'string' ? k : '';
  };
  return (a, b) => {
    const ka = keyOf(a);
    const kb = keyOf(b);
    if (ka !== kb) return ka < kb ? -1 : 1;
    return a < b ? -1 : a > b ? 1 : 0;
  };
}

/** The ids, in `ids` order, forming the longest run increasing in `pos`. */
function longestIncreasing(ids: string[], pos: Map<string, number>): Set<string> {
  const tails: number[] = [];
  const tailIdx: number[] = [];
  const prev: number[] = new Array<number>(ids.length).fill(-1);
  for (let i = 0; i < ids.length; i++) {
    const p = pos.get(ids[i]) as number;
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (tails[mid] < p) lo = mid + 1;
      else hi = mid;
    }
    tails[lo] = p;
    tailIdx[lo] = i;
    prev[i] = lo > 0 ? tailIdx[lo - 1] : -1;
  }
  const out = new Set<string>();
  let k = tails.length ? tailIdx[tails.length - 1] : -1;
  while (k >= 0) {
    out.add(ids[k]);
    k = prev[k];
  }
  return out;
}

// ── Whole values per key ─────────────────────────────────────────────────

/**
 * Bring a set of whole values (key → JSON value) into `root`, changing only
 * keys that differ between `base` and `value`. Without a base, set what
 * `value` says and leave other keys alone: absence then says nothing about
 * whether anyone removed them.
 */
export function applyWholeValues(
  root: Y.Map<unknown>,
  value: Record<string, unknown>,
  base: Record<string, unknown> | null,
): void {
  const keys = new Set([...Object.keys(value), ...Object.keys(base ?? {})]);
  for (const k of keys) {
    const next = value[k];
    const was = base ? base[k] : root.get(k);
    if (same(was, next) && (base !== null || root.has(k) === (next !== undefined))) continue;
    if (next === undefined) {
      if (base !== null) root.delete(k);
    } else {
      root.set(k, next);
    }
  }
}
