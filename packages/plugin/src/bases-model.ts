import type * as Y from 'yjs';
import {
  applyOrder, applyWholeValues, bury, buried, byOrderKey, clearTombstones, normaliseJson, recordKey, same, SEP,
  tombstonesByRecord,
} from './structured-records';

/**
 * An Obsidian base (`.base`) as a Y.Doc, independent of its YAML text.
 *
 * A base is a query — filters, formulas, property display names, summaries —
 * and a list of named views over it, each with its own layout, filters,
 * grouping, columns and sort. Everything is shared: two people looking at the
 * same view of a board see the same board. The one exception is a table's
 * column widths (`columnSize`, pixels), which are each vault's own (SAFE-A21):
 * a phone and a wide monitor would otherwise take turns resizing each other.
 *
 * **Shape.** Flat roots, never a map per record (see canvas-model.ts for why):
 *
 * - `top`: top-level keys other than formulas, summaries, properties and
 *   views — `filters`, `newItemFolder`, `newItemTemplate`, and anything this
 *   build does not know — each a whole value.
 * - `formulaFields`, `summaryFields`: `name \0 text` → the formula's text.
 * - `propFields`: `property id \0 field` → value (`displayName`, and anything
 *   else a property carries).
 * - `viewFields`: `view name \0 field` → value, for every view key except its
 *   `name` (the key), `order`, `sort` and `columnSize`. `order` and `sort` are
 *   held here as `true` while the list exists, so an empty list is kept apart
 *   from no list — Obsidian writes them differently.
 * - `lists`, `listOrder`: a view's `order` (columns) and `sort` as ordered
 *   sets, `view \0 order|sort \0 item` → the item, and → a fractional key. Two
 *   people adding, removing or moving different columns all keep their change.
 * - `viewOrder`: view name → fractional key. The first view opens by default.
 * - `widths`: view name → `columnSize`, as the document was first filled.
 *   Only a vault with no widths of its own for a view ever writes these
 *   (SAFE-A21).
 * - `tombstones`: deletion, as for canvas (SAFE-A18). Views, properties,
 *   formulas and summaries are all records someone wrote, so a delete records
 *   a snapshot and an edit the deleter had not seen brings the record back.
 *
 * **Views are keyed by name.** Obsidian gives them no other identity, and keeps
 * names unique. A rename is therefore a delete and a create: a concurrent edit
 * to the old name brings it back beside the renamed one — clutter, with
 * nothing lost.
 */

export const ROOT_TOP = 'top';
export const ROOT_FORMULAS = 'formulaFields';
export const ROOT_SUMMARIES = 'summaryFields';
export const ROOT_PROPS = 'propFields';
export const ROOT_VIEWS = 'viewFields';
export const ROOT_VIEW_ORDER = 'viewOrder';
export const ROOT_LISTS = 'lists';
export const ROOT_LIST_ORDER = 'listOrder';
export const ROOT_WIDTHS = 'widths';
export const ROOT_TOMBSTONES = 'tombstones';

/**
 * Marks a key in `top` as the model's own: top-level `summaries` exists (it may
 * be empty). Two vaults setting it at once is no conflict: it is presentation
 * to SAFE-A22.
 */
export const SUMMARIES_PRESENT = '\u0001summaries';
/** The one field of a formula or summary record. */
const TEXT = 'text';

export interface SortEntry {
  property: string;
  direction: 'ASC' | 'DESC';
}

export interface BasesView {
  type: string;
  name: string;
  /**
   * Every other key of the view Obsidian keeps, in its normal form — `filters`,
   * `groupBy`, `limit`, `summaries`, layout options, unknown keys — except
   * `order`, `sort` and `columnSize`.
   */
  fields: Record<string, unknown>;
  order?: string[];
  sort?: SortEntry[];
  /** This vault's column widths, or the document's first ones (SAFE-A21). */
  columnSize?: unknown;
}

export interface BasesValue {
  /** `filters`, `newItemFolder`, `newItemTemplate`, and unknown top-level keys. */
  top: Record<string, unknown>;
  formulas: Record<string, string>;
  /** Top-level summaries, or null when the file has none. */
  summaries: Record<string, string> | null;
  properties: Record<string, Record<string, unknown>>;
  views: BasesView[];
}

type Rec = Record<string, unknown>;
type ListField = 'order' | 'sort';
const LIST_FIELDS: ListField[] = ['order', 'sort'];

/** The id of a list item: a column's property id, or the property a sort entry sorts by. */
function itemId(field: ListField, item: unknown): string {
  return field === 'order' ? (item as string) : (item as SortEntry).property;
}

const listKey = (view: string, field: ListField, id: string): string => `${view}${SEP}${field}${SEP}${id}`;

// ── Reading ───────────────────────────────────────────────────────────────

/** Every record in a fields root, deleted or not: id → fields. */
function rawRecords(root: Y.Map<unknown>): Map<string, Rec> {
  const out = new Map<string, Rec>();
  root.forEach((value, key) => {
    const at = key.indexOf(SEP);
    if (at <= 0) return;
    const id = key.slice(0, at);
    let rec = out.get(id);
    if (!rec) {
      rec = {};
      out.set(id, rec);
    }
    rec[key.slice(at + 1)] = value;
  });
  return out;
}

function readList(ydoc: Y.Doc, view: string, field: ListField): unknown[] {
  const lists = ydoc.getMap<unknown>(ROOT_LISTS);
  const prefix = `${view}${SEP}${field}${SEP}`;
  const keys = [...lists.keys()].filter((k) => k.startsWith(prefix));
  keys.sort(byOrderKey(ydoc.getMap<unknown>(ROOT_LIST_ORDER)));
  return keys.map((k) => lists.get(k));
}

/**
 * A view's content as a tombstone sees it: everything but its name and widths.
 *
 * A list shows while its flag is set, or while it still holds items: one vault
 * removing a view's sort while another adds to it must not hide the addition
 * in both (SAFE-A18, found in review). Removing a list in an edit deletes the
 * items its editor saw, so only unseen ones keep it.
 */
function viewContent(fields: Rec, lists: Partial<Record<ListField, unknown[]>>): Rec {
  const out: Rec = { ...fields };
  for (const f of LIST_FIELDS) {
    const items = lists[f] ?? [];
    if (out[f] === true || items.length > 0) out[f] = items;
    else delete out[f];
  }
  return out;
}

function liveRecords(ydoc: Y.Doc, rootName: string, kind: string, contentOf: (id: string, fields: Rec) => Rec = (_, f) => f): Map<string, Rec> {
  const tombs = tombstonesByRecord(ydoc.getMap<unknown>(ROOT_TOMBSTONES));
  const out = new Map<string, Rec>();
  for (const [id, fields] of rawRecords(ydoc.getMap<unknown>(rootName))) {
    const content = contentOf(id, fields);
    if (buried(tombs.get(recordKey(kind, id)), content)) continue;
    out.set(id, content);
  }
  return out;
}

const byKey = <T>(m: Map<string, T>): [string, T][] => [...m].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

/** The base the document holds now. */
export function readBases(ydoc: Y.Doc): BasesValue {
  const topRoot = ydoc.getMap<unknown>(ROOT_TOP);
  const top: Rec = {};
  for (const k of [...topRoot.keys()].sort()) if (k !== SUMMARIES_PRESENT) top[k] = topRoot.get(k);

  const formulas: Record<string, string> = {};
  for (const [name, rec] of byKey(liveRecords(ydoc, ROOT_FORMULAS, 'f'))) {
    if (typeof rec[TEXT] === 'string') formulas[name] = rec[TEXT];
  }
  // The block shows while its marker is set, or while any summary in it is
  // live: one vault removing the block while another edits a summary in it
  // keeps the edit (SAFE-A18, found in review). Removing the block buries every
  // summary its editor saw, so only an unseen change keeps it.
  const summaryRecords: Record<string, string> = {};
  for (const [name, rec] of byKey(liveRecords(ydoc, ROOT_SUMMARIES, 's'))) {
    if (typeof rec[TEXT] === 'string') summaryRecords[name] = rec[TEXT];
  }
  const summaries = topRoot.get(SUMMARIES_PRESENT) === true || Object.keys(summaryRecords).length > 0
    ? summaryRecords
    : null;
  const properties: Record<string, Rec> = {};
  for (const [id, rec] of byKey(liveRecords(ydoc, ROOT_PROPS, 'p'))) properties[id] = rec;

  const views = liveRecords(ydoc, ROOT_VIEWS, 'v', (name, fields) => viewContent(fields, {
    order: readList(ydoc, name, 'order'),
    sort: readList(ydoc, name, 'sort'),
  }));
  const widths = ydoc.getMap<unknown>(ROOT_WIDTHS);
  const names = [...views.keys()].sort(byOrderKey(ydoc.getMap<unknown>(ROOT_VIEW_ORDER)));
  return {
    top,
    formulas,
    summaries,
    properties,
    views: names.map((name) => toView(name, views.get(name) as Rec, widths.get(name))),
  };
}

function toView(name: string, content: Rec, columnSize: unknown): BasesView {
  const { type, order, sort, ...fields } = content;
  const view: BasesView = { type: typeof type === 'string' ? type : '', name, fields };
  if (Array.isArray(order)) view.order = order as string[];
  if (Array.isArray(sort)) view.sort = sort as SortEntry[];
  if (columnSize !== undefined) view.columnSize = columnSize;
  return view;
}

// ── Writing ───────────────────────────────────────────────────────────────

/** A view as its record in `viewFields`: type, fields, and the list flags. */
function viewRecord(v: BasesView): Rec {
  const rec: Rec = { type: v.type, ...v.fields };
  if (v.order) rec.order = true;
  if (v.sort) rec.sort = true;
  return rec;
}

function setFields(root: Y.Map<unknown>, id: string, rec: Rec, before: Rec | null, exact: boolean): void {
  const fields = new Set([...Object.keys(rec), ...Object.keys(before ?? {})]);
  if (exact) {
    // A record new to this editor, over one the document holds only buried:
    // a name reused after a delete. The buried one's fields must not show
    // through the new record, so anything it lacks goes.
    for (const k of root.keys()) {
      const at = k.indexOf(SEP);
      if (k.slice(0, at) === id) fields.add(k.slice(at + 1));
    }
  }
  for (const f of fields) {
    const key = `${id}${SEP}${f}`;
    const next = rec[f];
    if (before !== null) {
      // Only what the editor changed since the base.
      if (same(before[f], next)) continue;
      if (next === undefined) root.delete(key);
      else root.set(key, next);
    } else if (next === undefined) {
      // No base: absence says nothing about whether anyone removed it — unless
      // the record is new and what is there belonged to a deleted one.
      if (exact && root.has(key)) root.delete(key);
    } else if (!root.has(key) || !same(root.get(key), next)) {
      root.set(key, next);
    }
  }
}

/**
 * Bring a set of records into a fields root, as a keyed diff from `base`.
 *
 * - In the base: only fields that changed since.
 * - New to the editor: its tombstones are answered (it is wanted again). If
 *   the document shows it already — another vault made one of the same name —
 *   the two are merged field by field; if not, it is written exactly.
 * - In the base and gone: buried, with the base as its snapshot (SAFE-A18).
 */
function applyRecords(
  ydoc: Y.Doc,
  rootName: string,
  kind: string,
  value: Map<string, Rec>,
  base: Map<string, Rec> | null,
  showing: Map<string, Rec>,
  snapshotOf: (id: string, rec: Rec) => Rec = (_, r) => r,
): Set<string> {
  const root = ydoc.getMap<unknown>(rootName);
  const tombs = ydoc.getMap<unknown>(ROOT_TOMBSTONES);
  const exactIds = new Set<string>();
  for (const [id, rec] of value) {
    const b = base?.get(id);
    if (b) {
      setFields(root, id, rec, b, false);
      continue;
    }
    clearTombstones(tombs, kind, id);
    const exact = !showing.has(id);
    if (exact) exactIds.add(id);
    setFields(root, id, rec, null, exact);
  }
  if (base) {
    for (const [id, b] of base) {
      if (value.has(id)) continue;
      const hasAny = [...root.keys()].some((k) => k.startsWith(`${id}${SEP}`));
      if (hasAny) bury(tombs, ydoc.clientID, kind, id, snapshotOf(id, b));
    }
  }
  return exactIds;
}

function textRecords(m: Record<string, string> | null | undefined): Map<string, Rec> {
  return new Map(Object.entries(m ?? {}).map(([k, v]) => [k, { [TEXT]: v }]));
}

function topWithMarker(v: BasesValue): Rec {
  const out: Rec = { ...v.top };
  if (v.summaries !== null) out[SUMMARIES_PRESENT] = true;
  return out;
}

/** A view's lists, keyed for diffing. */
function listItems(v: BasesView | undefined, field: ListField): Map<string, unknown> {
  const list = (v?.[field] ?? []) as unknown[];
  return new Map(list.map((item) => [itemId(field, item), item]));
}

function applyLists(ydoc: Y.Doc, v: BasesView, b: BasesView | undefined, exact: boolean): void {
  const lists = ydoc.getMap<unknown>(ROOT_LISTS);
  const listOrder = ydoc.getMap<unknown>(ROOT_LIST_ORDER);
  for (const field of LIST_FIELDS) {
    const next = listItems(v, field);
    const keyOf = (id: string): string => listKey(v.name, field, id);
    if (b) {
      const was = listItems(b, field);
      for (const [id, item] of next) if (!same(was.get(id), item)) lists.set(keyOf(id), item);
      for (const id of was.keys()) if (!next.has(id)) lists.delete(keyOf(id));
      applyOrder(listOrder, [...next.keys()].map(keyOf), [...was.keys()].map(keyOf));
      continue;
    }
    if (exact) {
      // Items a deleted view of the same name left behind are not this view's.
      const prefix = `${v.name}${SEP}${field}${SEP}`;
      for (const k of [...lists.keys()]) {
        if (k.startsWith(prefix) && !next.has(k.slice(prefix.length))) lists.delete(k);
      }
    }
    for (const [id, item] of next) {
      if (!lists.has(keyOf(id)) || !same(lists.get(keyOf(id)), item)) lists.set(keyOf(id), item);
    }
    applyOrder(listOrder, [...next.keys()].map(keyOf), null);
  }
}

/**
 * Bring an edit into the document, as a minimal keyed diff from `base`.
 *
 * `base` is the base as its editor last saw it (for a file, the text disk and
 * document last agreed on), or null for the first fill. Only what differs
 * between `base` and `value` is written; the document may hold remote changes
 * the editor has not shown yet. A view's `columnSize` never enters the
 * document from an edit — it is each vault's own — only from a fill, or with a
 * view new to the document (SAFE-A21).
 *
 * Call inside a transaction; the caller owns the origin.
 */
export function applyBases(ydoc: Y.Doc, input: BasesValue, baseInput: BasesValue | null): void {
  const value = normaliseJson(input) as BasesValue;
  const base = baseInput ? (normaliseJson(baseInput) as BasesValue) : null;
  const showing = readBases(ydoc);

  applyWholeValues(ydoc.getMap<unknown>(ROOT_TOP), topWithMarker(value), base ? topWithMarker(base) : null);

  applyRecords(
    ydoc, ROOT_FORMULAS, 'f', textRecords(value.formulas), base ? textRecords(base.formulas) : null,
    textRecords(showing.formulas),
  );
  applyRecords(
    ydoc, ROOT_SUMMARIES, 's', textRecords(value.summaries), base ? textRecords(base.summaries) : null,
    textRecords(showing.summaries),
  );
  applyRecords(
    ydoc, ROOT_PROPS, 'p', new Map(Object.entries(value.properties)),
    base ? new Map(Object.entries(base.properties)) : null, new Map(Object.entries(showing.properties)),
  );

  const viewsOf = (v: BasesValue): Map<string, BasesView> => new Map(v.views.map((view) => [view.name, view]));
  const nextViews = viewsOf(value);
  const baseViews = base ? viewsOf(base) : null;
  const exact = applyRecords(
    ydoc, ROOT_VIEWS, 'v',
    new Map([...nextViews].map(([n, v]) => [n, viewRecord(v)])),
    baseViews ? new Map([...baseViews].map(([n, v]) => [n, viewRecord(v)])) : null,
    new Map(showing.views.map((v) => [v.name, viewRecord(v)])),
    (name) => {
      const b = baseViews?.get(name) as BasesView;
      return viewContent(viewRecord(b), { order: b.order, sort: b.sort });
    },
  );
  for (const [name, v] of nextViews) applyLists(ydoc, v, baseViews?.get(name), exact.has(name));

  // Widths travel only as a first value: with a fill, or with a view the
  // document has not had. After that each vault keeps its own (SAFE-A21).
  const widths = ydoc.getMap<unknown>(ROOT_WIDTHS);
  for (const [name, v] of nextViews) {
    if (v.columnSize === undefined || baseViews?.has(name) || widths.has(name)) continue;
    widths.set(name, v.columnSize);
  }

  applyOrder(
    ydoc.getMap<unknown>(ROOT_VIEW_ORDER), value.views.map((v) => v.name), base ? base.views.map((v) => v.name) : null,
  );
}
