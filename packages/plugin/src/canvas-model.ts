import * as Y from 'yjs';
import { mergeTextEdit } from './text-merge';
import {
  applyOrder, applyWholeValues, bury as buryIn, byOrderKey, canonical, clearTombstones as clearIn, normaliseJson,
  recordKey, same, SEP, tombstonesByRecord,
} from './structured-records';

export { canonical, normaliseJson };

/**
 * A canvas as a Y.Doc, independent of how it reaches the screen.
 *
 * Today the only way in and out is the file (canvas-codec.ts). A live binding
 * to an open canvas view would come in through the same three functions —
 * `applyCanvas` for the view's edits, `readCanvas` and `observeCanvas` for
 * what to show — so both paths obey the same rules, and neither touches JSON
 * text.
 *
 * **Shape.** Flat roots, never a map per record. A `Y.Map` two vaults each
 * create under the same key does not merge — one replaces the other whole
 * (checked against yjs 13.6.32) — and a deleted map takes every concurrent
 * edit inside it with it. Flat entries have neither problem:
 *
 * - `nodeFields`, `edgeFields`: `id \0 field` → JSON value. Last writer wins
 *   per field, so one person's move and another's recolour of the same card
 *   both stand. (Relay stores whole nodes, and loses one of the two.)
 * - `texts`: id → Y.Text, a text card's `text`, merged character by character.
 *   Created once, by the vault that creates the card, under an id only it made.
 * - `order`: id → fractional key (fractional-key.ts). Z-order is the node
 *   array's order in the file; a key per node means a reorder touches only the
 *   node that moved.
 * - `extra`: top-level keys other than `nodes` and `edges`, which other tools
 *   (Advanced Canvas's `metadata`) add and must get back.
 * - `tombstones`: see SAFE-A18, below.
 *
 * **Deletion is a tombstone, never a delete (SAFE-A18).** Removing a record's
 * entries would discard any edit to it that the deleting vault had not seen —
 * including one that had already reached the server, where nothing in the
 * update says the deleter missed it. So deleting records a snapshot of the
 * record *as the deleter saw it*, and the record reads as deleted only while
 * it still matches a snapshot. Any change the deleter had not seen — a move,
 * a recolour, a word typed into the card — makes it differ, and brings it
 * back. So does a live edge pointing at it. Edges removed together with a node
 * come back with it. A node someone deleted can reappear; that is clutter, and
 * the alternative is someone's writing gone without a trace.
 *
 * Tombstones are never collected. A vault offline for a month still has its
 * late edit decided against the tombstone, which is exactly the case this is
 * for; collecting them is how Excalidraw's elements come back from the dead.
 */

export const ROOT_NODE_FIELDS = 'nodeFields';
export const ROOT_EDGE_FIELDS = 'edgeFields';
export const ROOT_TEXTS = 'texts';
export const ROOT_ORDER = 'order';
export const ROOT_EXTRA = 'extra';
export const ROOT_TOMBSTONES = 'tombstones';

/**
 * Marks a node field as the model's own, not the file's. `\u0001textGone`
 * holds the text a card had when an edit took its text away (see applyText).
 */
const INTERNAL = '\u0001';
const TEXT_GONE = `${INTERNAL}textGone`;

export type CanvasRecord = { id: string } & Record<string, unknown>;

export interface CanvasValue {
  nodes: CanvasRecord[];
  edges: CanvasRecord[];
  /** Every other top-level key, verbatim. */
  extra: Record<string, unknown>;
}

type Kind = 'n' | 'e';

// ── Values ────────────────────────────────────────────────────────────────


function normaliseRecord(rec: Record<string, unknown>): CanvasRecord {
  return normaliseJson(rec) as CanvasRecord;
}

/** A canvas value with every record normalised; top-level keys other than nodes/edges into `extra`. */
export function normaliseCanvas(value: CanvasValue): CanvasValue {
  const extra: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value.extra)) {
    const n = normaliseJson(v);
    if (n !== undefined) extra[k] = n;
  }
  return {
    nodes: value.nodes.map(normaliseRecord),
    edges: value.edges.map(normaliseRecord),
    extra,
  };
}

// ── Reading ───────────────────────────────────────────────────────────────

function fieldsRoot(ydoc: Y.Doc, kind: Kind): Y.Map<unknown> {
  return ydoc.getMap<unknown>(kind === 'n' ? ROOT_NODE_FIELDS : ROOT_EDGE_FIELDS);
}

/** Every record of one kind held in the document, deleted or not, with its fields. */
function rawRecords(ydoc: Y.Doc, kind: Kind): Map<string, CanvasRecord> {
  const out = new Map<string, CanvasRecord>();
  fieldsRoot(ydoc, kind).forEach((value, key) => {
    const at = key.indexOf(SEP);
    if (at <= 0) return;
    const id = key.slice(0, at);
    const field = key.slice(at + 1);
    let rec = out.get(id);
    if (!rec) {
      rec = { id };
      out.set(id, rec);
    }
    if (field !== 'id') rec[field] = value;
  });
  if (kind === 'n') {
    const texts = ydoc.getMap<Y.Text>(ROOT_TEXTS);
    texts.forEach((ytext, id) => {
      const rec = out.get(id);
      if (!rec || !(ytext instanceof Y.Text)) return;
      const text = ytext.toString();
      // Taken away by an edit, and nobody typed in it since: hidden. Typing
      // the remover had not seen makes it differ, and brings it back.
      if (rec[TEXT_GONE] === text) return;
      rec.text = text;
    });
    for (const rec of out.values()) delete rec[TEXT_GONE];
  }
  return out;
}

/** How the document orders nodes: by key, then id, so equal keys still agree everywhere. */
function byOrder(ydoc: Y.Doc): (a: CanvasRecord, b: CanvasRecord) => number {
  const cmp = byOrderKey(ydoc.getMap<unknown>(ROOT_ORDER));
  return (a, b) => cmp(a.id, b.id);
}

/** The canvas the document holds now. */
export function readCanvas(ydoc: Y.Doc): CanvasValue {
  const nodes = rawRecords(ydoc, 'n');
  const edges = rawRecords(ydoc, 'e');
  const tombs = tombstonesByRecord(ydoc.getMap<unknown>(ROOT_TOMBSTONES));

  // A record matching a snapshot is deleted — for an edge, subject to the
  // node it went with.
  const deadNodes = new Set<string>();
  for (const [id, rec] of nodes) {
    const list = tombs.get(recordKey('n', id));
    if (list?.some((t) => same(t.snapshot, rec))) deadNodes.add(id);
  }
  /** Edge id → the nodes it was deleted with, or null for deleted outright; absent when live. */
  const edgeDeath = new Map<string, Set<string> | null>();
  for (const [id, rec] of edges) {
    const matching = (tombs.get(recordKey('e', id)) ?? []).filter((t) => same(t.snapshot, rec));
    if (matching.length === 0) continue;
    if (matching.some((t) => !t.with)) edgeDeath.set(id, null);
    else edgeDeath.set(id, new Set(matching.map((t) => t.with as string)));
  }
  const edgeLive = (id: string): boolean => {
    if (!edgeDeath.has(id)) return true;
    const withNodes = edgeDeath.get(id);
    return withNodes !== null && withNodes !== undefined && [...withNodes].some((n) => !deadNodes.has(n));
  };
  // A live edge keeps both its ends; an edge that comes back with one node
  // brings its other end too. Monotone — nodes only come back — so it settles.
  let changed = true;
  while (changed) {
    changed = false;
    for (const [id, rec] of edges) {
      if (!edgeLive(id)) continue;
      for (const end of [rec.fromNode, rec.toNode]) {
        if (typeof end === 'string' && deadNodes.delete(end)) changed = true;
      }
    }
  }

  const liveNodes = [...nodes.values()].filter((n) => !deadNodes.has(n.id)).sort(byOrder(ydoc));
  const liveEdges = [...edges.values()].filter((e) => edgeLive(e.id)).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const extra: Record<string, unknown> = {};
  const extraRoot = ydoc.getMap<unknown>(ROOT_EXTRA);
  for (const k of [...extraRoot.keys()].sort()) extra[k] = extraRoot.get(k);
  return { nodes: liveNodes, edges: liveEdges, extra };
}

// ── Writing ───────────────────────────────────────────────────────────────

function setFields(
  ydoc: Y.Doc,
  kind: Kind,
  rec: CanvasRecord,
  before: Record<string, unknown> | null,
): void {
  const root = fieldsRoot(ydoc, kind);
  const texts = ydoc.getMap<Y.Text>(ROOT_TEXTS);
  // `id` is stored as a field too, so a record with nothing else still exists.
  const fields = new Set([...Object.keys(rec), ...Object.keys(before ?? {})]);
  for (const f of fields) {
    const next = rec[f];
    const key = `${rec.id}${SEP}${f}`;
    if (kind === 'n' && f === 'text') {
      const was = before?.text;
      applyText(ydoc, texts, rec.id, before === null ? null : typeof was === 'string' ? was : '', next);
      continue;
    }
    if (before !== null) {
      // Only what the editor changed since the base.
      if (same(before[f], next)) continue;
      if (next === undefined) root.delete(key);
      else root.set(key, next);
    } else {
      // No base: make the document say what the record says. A field it holds
      // and the record lacks is left alone — with no base, absence here says
      // nothing about whether anyone removed it.
      if (next === undefined) continue;
      if (root.has(key) && same(root.get(key), next)) continue;
      root.set(key, next);
    }
  }
}

/**
 * A card's text. With a base, the edit from base to next is merged into
 * whatever the Y.Text holds now; without one (a card new to this file), the
 * Y.Text is made to say `next`.
 */
function applyText(ydoc: Y.Doc, texts: Y.Map<Y.Text>, id: string, base: string | null, next: unknown): void {
  const ytext = texts.get(id);
  const gone = `${id}${SEP}${TEXT_GONE}`;
  const fields = ydoc.getMap<unknown>(ROOT_NODE_FIELDS);
  if (typeof next !== 'string') {
    // The card stopped holding text — its type changed, or its text was
    // removed. The Y.Text is never deleted: that would take any typing in it
    // that this vault had not seen (SAFE-A18). It is hidden instead, behind a
    // snapshot of what the editor saw, and comes back if it differs.
    if (base !== null && ytext instanceof Y.Text) fields.set(gone, base);
    return;
  }
  if (fields.has(gone)) {
    // Text again, over text that was hidden: the hidden snapshot is what the
    // editor last saw there, so it is the base — replaced cleanly if nobody
    // typed in it since, merged if someone did.
    const hidden = fields.get(gone);
    fields.delete(gone);
    if (ytext instanceof Y.Text && typeof hidden === 'string') {
      mergeTextEdit(ydoc, ytext, hidden, next);
      return;
    }
  }
  if (!(ytext instanceof Y.Text)) {
    const t = new Y.Text();
    t.insert(0, next);
    texts.set(id, t);
    return;
  }
  if (base === null) {
    // No base: bring it to `next` from what it says now. Only reached for a
    // record the file never held before, so there is no remote change of the
    // file's to protect.
    mergeTextEdit(ydoc, ytext, ytext.toString(), next);
    return;
  }
  if (base !== next) mergeTextEdit(ydoc, ytext, base, next);
}

function clearTombstones(ydoc: Y.Doc, kind: Kind, id: string): void {
  clearIn(ydoc.getMap<unknown>(ROOT_TOMBSTONES), kind, id);
}

function bury(ydoc: Y.Doc, kind: Kind, snapshot: CanvasRecord, withNode?: string): void {
  const hasAny = [...fieldsRoot(ydoc, kind).keys()].some((k) => k.startsWith(`${snapshot.id}${SEP}`));
  if (!hasAny) return; // nothing in the document to delete
  buryIn(ydoc.getMap<unknown>(ROOT_TOMBSTONES), ydoc.clientID, kind, snapshot.id, snapshot, withNode);
}

/**
 * Bring an edit into the document, as a minimal keyed diff from `base`.
 *
 * `base` is the canvas as the editor last saw it (for a file, the text disk and
 * document last agreed on), or null for the first fill of an empty document.
 * Only what differs between `base` and `value` is written: the document may
 * hold remote changes the editor has not shown yet, and diffing against the
 * document would read their absence as the user reverting them.
 *
 * Call inside a transaction; the caller owns the origin.
 */
export function applyCanvas(ydoc: Y.Doc, input: CanvasValue, baseInput: CanvasValue | null): void {
  const value = normaliseCanvas(input);
  const base = baseInput ? normaliseCanvas(baseInput) : null;

  applyRecords(ydoc, 'n', value.nodes, base?.nodes ?? null, new Set());
  const deletedNodes = new Set<string>();
  if (base) {
    const kept = new Set(value.nodes.map((n) => n.id));
    for (const n of base.nodes) if (!kept.has(n.id)) deletedNodes.add(n.id);
  }
  applyRecords(ydoc, 'e', value.edges, base?.edges ?? null, deletedNodes);
  applyOrder(ydoc.getMap<unknown>(ROOT_ORDER), value.nodes.map((n) => n.id), base ? base.nodes.map((n) => n.id) : null);
  applyWholeValues(ydoc.getMap<unknown>(ROOT_EXTRA), value.extra, base?.extra ?? null);
}

function applyRecords(
  ydoc: Y.Doc,
  kind: Kind,
  records: CanvasRecord[],
  baseRecords: CanvasRecord[] | null,
  deletedNodes: Set<string>,
): void {
  const baseById = new Map((baseRecords ?? []).map((r) => [r.id, r]));
  for (const rec of records) {
    const b = baseById.get(rec.id);
    if (b) {
      setFields(ydoc, kind, rec, b);
      continue;
    }
    // New to this editor: made here, or brought back (undo). Any tombstone is
    // answered by the record being wanted again.
    clearTombstones(ydoc, kind, rec.id);
    setFields(ydoc, kind, rec, null);
  }
  if (!baseRecords) return;
  const kept = new Set(records.map((r) => r.id));
  for (const b of baseRecords) {
    if (kept.has(b.id)) continue;
    let withNode: string | undefined;
    if (kind === 'e') {
      if (typeof b.fromNode === 'string' && deletedNodes.has(b.fromNode)) withNode = b.fromNode;
      else if (typeof b.toNode === 'string' && deletedNodes.has(b.toNode)) withNode = b.toNode;
    }
    bury(ydoc, kind, b, withNode);
  }
}

// ── Observing ─────────────────────────────────────────────────────────────

export interface CanvasChange {
  nodes: Set<string>;
  edges: Set<string>;
  /** Top-level keys other than nodes/edges changed. */
  extra: boolean;
  /** A tombstone changed: any record's visibility may have, re-read to know. */
  tombstones: boolean;
}

/**
 * Report which records a transaction touched, by id, so a view can patch
 * single nodes instead of re-importing the board. Returns the unsubscribe.
 */
export function observeCanvas(ydoc: Y.Doc, cb: (change: CanvasChange, tr: Y.Transaction) => void): () => void {
  const handler = (tr: Y.Transaction): void => {
    const change: CanvasChange = { nodes: new Set(), edges: new Set(), extra: false, tombstones: false };
    for (const [type, keys] of tr.changed) {
      if (type === ydoc.share.get(ROOT_NODE_FIELDS) || type === ydoc.share.get(ROOT_EDGE_FIELDS)) {
        const into = type === ydoc.share.get(ROOT_NODE_FIELDS) ? change.nodes : change.edges;
        for (const k of keys) if (k) into.add(k.slice(0, k.indexOf(SEP)));
      } else if (type === ydoc.share.get(ROOT_TEXTS) || type === ydoc.share.get(ROOT_ORDER)) {
        for (const k of keys) if (k) change.nodes.add(k);
      } else if (type === ydoc.share.get(ROOT_EXTRA)) {
        change.extra = true;
      } else if (type === ydoc.share.get(ROOT_TOMBSTONES)) {
        change.tombstones = true;
      } else if (type instanceof Y.Text) {
        // Typing inside a card: the Y.Text's parent key is the node id.
        const key = type._item?.parentSub;
        if (key) change.nodes.add(key);
      }
    }
    if (change.nodes.size || change.edges.size || change.extra || change.tombstones) cb(change, tr);
  };
  ydoc.on('afterTransaction', handler);
  return () => ydoc.off('afterTransaction', handler);
}
