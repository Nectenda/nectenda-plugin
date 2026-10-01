import { CST, Lexer } from 'yaml';
import { parseObsidianYaml, stringifyObsidianYaml } from './obsidian-yaml';
import type { StructuredCodec } from './structured-formats';
import { BASES_PRESENCE_PAD_BYTES } from './presence-seal';
import { applyBases, readBases, SUMMARIES_PRESENT, type BasesValue, type BasesView } from './bases-model';
import { canonical, normaliseJson, SEP } from './structured-records';

/**
 * `.base` files (Obsidian Bases) as a structured format: the text boundary
 * around bases-model.ts.
 *
 * Everything here mirrors Obsidian's own reading and writing of the file, read
 * from 1.13.7's `app.js`: `cQ.parse` and `getSerializable` for the file,
 * `dQ` and `lQ.serialize` for a view, `iQ` for a property, `uQ` for a filter,
 * `pQ`/`hQ` for property ids, and `yL`/`bL` for the YAML. Obsidian rewrites a
 * base into its own normal form whenever its view saves; reading every file
 * into that same form means its normalising save is never mistaken for an
 * edit (SAFE-A15), and writing that form means an open base that reloads our
 * write and saves again does not reformat it.
 *
 * Where this deliberately differs from Obsidian:
 *
 * - Keys Obsidian keeps in insertion order (formulas, properties, unknown
 *   keys, a view's options) are written sorted: the document does not keep
 *   their order, and none of them carries meaning by position.
 * - A view's `order` and `sort` keep the first of any repeated entry: the
 *   document holds them as sets keyed by property.
 * - A file with no views is left with none. Obsidian adds a default view on
 *   load, named in the user's language, and writes it on its next save; that
 *   save arrives here as an ordinary edit.
 * - A few shapes Obsidian loads but cannot be keyed without guessing are
 *   refused (SAFE-A13): duplicate view names, names holding control
 *   characters, lists where objects belong, and a file with no content.
 */

/** The Obsidian version this codec was read against. See canvas-codec.ts. */
export const OBSIDIAN_BASES_READ_AGAINST = '1.13.7';

/** Keys of the file Obsidian reads itself; everything else it keeps verbatim. */
const KNOWN_TOP = new Set(['views', 'filters', 'display', 'properties', 'formulas', 'newItemFolder', 'newItemTemplate']);
/** Keys of a view Obsidian reads itself, in the order it writes them. */
const VIEW_LEAD = ['type', 'name', 'filters', 'groupBy', 'order', 'sort', 'limit', 'summaries'];
/** View keys `lQ.serialize` never writes: its own fields shadow them. */
const VIEW_DROPPED = new Set(['query', 'data']);

/**
 * View keys that are presentation only (SAFE-A22): two people setting one at
 * once converge on one value without a conflict copy. Layout options of the
 * table (`rowHeight`), cards (`cardSize`, `image*`) and list (`markers`,
 * `indentProperties`, `separator`) views, the sort, the row limit, and which
 * columns show in what order. Filters, grouping, summaries, the layout itself
 * and every key this build does not know are not.
 */
const PRESENTATION_FIELDS = new Set([
  'order', 'sort', 'limit',
  'rowHeight', 'cardSize', 'image', 'imageFit', 'imageAspectRatio',
  'markers', 'indentProperties', 'separator',
]);
/** Whole roots that are presentation only: column and sort lists, view order, first widths. */
const PRESENTATION_ROOTS = new Set(['lists', 'listOrder', 'viewOrder', 'widths']);

class Refused extends Error {}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** A name or id the document keys by: refused if it would split in the wrong place. */
function keyable(id: string, what: string): string {
  // An empty name has no record of its own in the document (`id \0 field`
  // needs an id): refused rather than dropped (found in review).
  if (id === '') throw new Refused(`${what} has an empty name`);
  if (id.includes('\u0000') || id.includes('\u0001')) throw new Refused(`${what} "${id}" holds a control character`);
  return id;
}

/** `pQ`: a property id as Obsidian holds it — `note.`, `file.` or `formula.` prefixed. */
function fullId(id: string): string {
  if (id.startsWith('note.') || id.startsWith('formula.') || id.startsWith('file.')) return id;
  return id === 'file' ? 'file.file' : `note.${id}`;
}

/** `hQ`: a property id as Obsidian writes it — `note.x` shortened to `x`, unless that would be ambiguous. */
function shortId(id: string): string {
  if (id.length > 5 && id.startsWith('note.')) {
    const rest = id.substring(5);
    return ['file', 'formula', 'note'].includes(rest.split('.')[0]) ? id : rest;
  }
  return id === 'file.file' ? 'file' : id;
}

/** A property id as written in a view: through Obsidian's read and write. */
function writtenId(id: unknown, where: string): string {
  if (typeof id !== 'string') throw new Refused(`${where} holds a property that is not text`);
  return keyable(shortId(fullId(id)), 'a property');
}

/** `uQ`: a filter is a formula string, or exactly one of and/or/not over a list of filters. */
function checkFilter(f: unknown, where: string): void {
  if (typeof f === 'string') return;
  if (!isObject(f)) throw new Refused(`${where} is not a filter`);
  const keys = Object.keys(f);
  if (keys.length !== 1 || !['and', 'or', 'not'].includes(keys[0])) throw new Refused(`${where} must have exactly one of and, or, not`);
  const list = f[keys[0]];
  if (!Array.isArray(list)) throw new Refused(`${where}: "${keys[0]}" is not a list`);
  for (const item of list) checkFilter(item, where);
}

function strings(raw: unknown, what: string): Record<string, string> {
  if (!isObject(raw)) throw new Refused(`${what} is not a map`);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v !== 'string') throw new Refused(`${what}: "${k}" is not text`);
    out[keyable(k, what)] = v;
  }
  return out;
}

/** `dQ`, then `lQ.serialize`: one view in Obsidian's normal form. */
function toView(raw: unknown, index: number): BasesView {
  if (!isObject(raw)) throw new Refused(`view ${index} is not a map`);
  const name = raw.name;
  if (!name || typeof name !== 'string') throw new Refused(`view ${index} has no name`);
  const type = raw.type;
  if (!type || typeof type !== 'string') throw new Refused(`view "${name}" has no type`);
  const view: BasesView = { type, name: keyable(name, 'a view name'), fields: {} };
  for (const [key, v] of Object.entries(raw)) {
    switch (key) {
      case 'type':
      case 'name':
        break;
      case 'filters':
        checkFilter(v, `the filters of view "${name}"`);
        view.fields.filters = v;
        break;
      case 'groupBy': {
        if (!isObject(v) || !Object.hasOwn(v, 'property') || !Object.hasOwn(v, 'direction')) {
          throw new Refused(`the groupBy of view "${name}" is not a property and direction`);
        }
        // An unusable grouping is dropped by Obsidian, not refused.
        if (v.property && typeof v.property === 'string' && (v.direction === 'ASC' || v.direction === 'DESC')) {
          view.fields.groupBy = { property: writtenId(v.property, 'a groupBy'), direction: v.direction };
        }
        break;
      }
      case 'summaries': {
        const s = strings(v, `the summaries of view "${name}"`);
        const out: Record<string, string> = {};
        for (const [k, text] of Object.entries(s)) out[writtenId(k, 'a view summary')] = text;
        view.fields.summaries = out;
        break;
      }
      case 'order': {
        if (!Array.isArray(v)) throw new Refused(`the order of view "${name}" is not a list`);
        const seen = new Set<string>();
        view.order = [];
        for (const id of v) {
          const w = writtenId(id, `the order of view "${name}"`);
          if (seen.has(w)) continue;
          seen.add(w);
          view.order.push(w);
        }
        break;
      }
      case 'sort': {
        // Obsidian drops a sort that is not a list, and entries it cannot use.
        if (!Array.isArray(v)) break;
        const seen = new Set<string>();
        view.sort = [];
        for (const entry of v) {
          if (entry === null || entry === undefined) throw new Refused(`the sort of view "${name}" has an empty entry`);
          const e = entry as Record<string, unknown>;
          const property = e.column ? e.column : e.property;
          const direction = e.direction;
          if (!property || typeof property !== 'string' || (direction !== 'ASC' && direction !== 'DESC')) continue;
          const id = writtenId(property, `the sort of view "${name}"`);
          if (seen.has(id)) continue;
          seen.add(id);
          view.sort.push({ property: id, direction });
        }
        break;
      }
      case 'limit':
        if (typeof v === 'number' && v > 0) view.fields.limit = v;
        break;
      case 'columnSize':
        view.columnSize = v;
        break;
      default:
        if (!VIEW_DROPPED.has(key)) view.fields[keyable(key, 'a view key')] = v;
    }
  }
  return view;
}

/** `cQ.parse`, then `getSerializable`: a whole file in Obsidian's normal form. */
function toValue(raw: unknown): BasesValue {
  if (!isObject(raw)) throw new Refused(raw === null || raw === undefined ? 'the file has no content' : 'the file is not a map');

  const viewsRaw = raw.views === undefined ? [] : raw.views;
  if (!Array.isArray(viewsRaw)) throw new Refused('"views" is not a list');
  const views = viewsRaw.map((v, i) => toView(v, i + 1));
  const names = new Set<string>();
  for (const v of views) {
    // Views are keyed by name. Obsidian keeps names unique; two sharing one
    // cannot be keyed without dropping one, so the file is kept aside.
    if (names.has(v.name)) throw new Refused(`two views are named "${v.name}"`);
    names.add(v.name);
  }

  const top: Record<string, unknown> = {};
  if (raw.filters) {
    checkFilter(raw.filters, 'the filters');
    top.filters = raw.filters;
  }

  const properties: Record<string, Record<string, unknown>> = {};
  if (raw.properties) {
    if (!isObject(raw.properties)) throw new Refused('"properties" is not a map');
    for (const [id, p] of Object.entries(raw.properties)) {
      if (p === null || p === undefined) continue;
      if (!isObject(p)) throw new Refused(`property "${id}" is not a map`);
      const rec: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(p)) {
        // A displayName that is not text, or is empty, is dropped by
        // Obsidian on its next save, not kept.
        if (k === 'displayName' && (typeof v !== 'string' || v === '')) continue;
        rec[k] = v;
      }
      properties[keyable(id, 'a property')] = rec;
    }
  }
  if (raw.display) {
    // The legacy form: display names move onto properties, keyed by the full
    // id — beside, not into, a property the file keys by its short id.
    for (const [id, name] of Object.entries(strings(raw.display, '"display"'))) {
      const key = keyable(fullId(id), 'a property');
      const rec = properties[key] ?? (properties[key] = {});
      if (!rec.displayName) rec.displayName = name;
    }
  }
  for (const [id, rec] of Object.entries(properties)) if (Object.keys(rec).length === 0) delete properties[id];

  const formulas = raw.formulas ? strings(raw.formulas, '"formulas"') : {};

  // Obsidian keeps a top-level `summaries` among the keys it does not know,
  // validating it only when it is set.
  let summaries: Record<string, string> | null = null;
  if (raw.summaries) summaries = strings(raw.summaries, '"summaries"');

  for (const key of ['newItemFolder', 'newItemTemplate']) {
    const v = raw[key];
    if (!v) continue;
    if (typeof v !== 'string') throw new Refused(`"${key}" is not text`);
    top[key] = v;
  }
  for (const [k, v] of Object.entries(raw)) {
    if (KNOWN_TOP.has(k)) continue;
    if (k === 'summaries' && summaries !== null) continue;
    top[keyable(k, 'a key')] = v;
  }

  return normaliseJson({ top, formulas, summaries, properties, views }) as BasesValue;
}

const sortedKeys = (o: Record<string, unknown>): string[] => Object.keys(o).sort();

/** `lQ.serialize`: a view in Obsidian's key order, options after. */
function writeView(v: BasesView): Record<string, unknown> {
  const all: Record<string, unknown> = { ...v.fields, type: v.type, name: v.name };
  if (v.order) all.order = v.order;
  if (v.sort) all.sort = v.sort;
  if (v.columnSize !== undefined) all.columnSize = v.columnSize;
  const out: Record<string, unknown> = {};
  for (const k of VIEW_LEAD) if (all[k] !== undefined) out[k] = all[k];
  for (const k of sortedKeys(all)) if (!VIEW_LEAD.includes(k)) out[k] = all[k];
  return out;
}

/** `iQ.serialize`: what a property carries, its display name last. */
function writeProperty(p: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of sortedKeys(p)) if (k !== 'displayName') out[k] = p[k];
  if (p.displayName) out.displayName = p.displayName;
  return out;
}

const sortedRecord = <T>(o: Record<string, T>): Record<string, T> => {
  const out: Record<string, T> = {};
  for (const k of sortedKeys(o)) out[k] = o[k];
  return out;
};

/** `getSerializable`: unknown keys first, then Obsidian's own, in its order. */
function writeValue(v: BasesValue): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const unknown: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v.top)) {
    if (k !== 'filters' && k !== 'newItemFolder' && k !== 'newItemTemplate') unknown[k] = val;
  }
  if (v.summaries !== null) unknown.summaries = sortedRecord(v.summaries);
  for (const k of sortedKeys(unknown)) out[k] = unknown[k];
  if (v.top.filters !== undefined) out.filters = v.top.filters;
  if (Object.keys(v.formulas).length > 0) out.formulas = sortedRecord(v.formulas);
  const props: Record<string, unknown> = {};
  for (const k of sortedKeys(v.properties)) {
    const p = writeProperty(v.properties[k]);
    if (Object.keys(p).length > 0) props[k] = p;
  }
  if (Object.keys(props).length > 0) out.properties = props;
  out.views = v.views.map(writeView);
  if (v.top.newItemFolder) out.newItemFolder = v.top.newItemFolder;
  if (v.top.newItemTemplate) out.newItemTemplate = v.top.newItemTemplate;
  return out;
}

/** Meaning, without the widths that are each vault's own; key order never counts, view and list order do. */
function meaning(v: BasesValue): string {
  return canonical({ ...v, views: v.views.map(({ columnSize: _, ...rest }) => rest) });
}

/** Whether YAML text holds a comment, which no rewrite can keep. */
export function hasYamlComment(text: string): boolean {
  for (const token of new Lexer().lex(text)) if (CST.tokenType(token) === 'comment') return true;
  return false;
}

export const basesCodec: StructuredCodec = {
  format: 'bases',
  version: 1,
  viewType: 'bases',
  // A focus names an entry by its path, whose length is the user's to choose:
  // in the note-sized bucket a long one would cross into the next, and the
  // length would say whether someone is on an entry (presence-seal.ts, WIRE-096).
  presencePadBytes: BASES_PRESENCE_PAD_BYTES,

  parse(text) {
    let raw: unknown;
    try {
      // Obsidian reads with the same library and defaults (`yL`): duplicate
      // keys and a second document are errors there too.
      raw = parseObsidianYaml(text);
    } catch (err) {
      return { ok: false, error: String(err) };
    }
    try {
      return { ok: true, value: toValue(raw) };
    } catch (err) {
      if (err instanceof Refused) return { ok: false, error: err.message };
      return { ok: false, error: String(err) };
    }
  },

  apply(ydoc, value, base) {
    applyBases(ydoc, value as BasesValue, base as BasesValue | null);
  },

  read(ydoc) {
    return readBases(ydoc);
  },

  serialise(value) {
    const out = writeValue(value as BasesValue);
    return Object.keys(out).length > 0 ? stringifyObsidianYaml(out) : '';
  },

  equal(a, b) {
    return meaning(a as BasesValue) === meaning(b as BasesValue);
  },

  withLocal(docValue, diskValue) {
    // A view's column widths are this vault's (SAFE-A21): kept from disk
    // wherever disk has some for a view of the same name.
    const doc = docValue as BasesValue;
    const disk = diskValue as BasesValue | null;
    if (!disk) return doc;
    const local = new Map(disk.views.map((v) => [v.name, v.columnSize]));
    return {
      ...doc,
      views: doc.views.map((v) => {
        const mine = local.get(v.name);
        return mine === undefined ? v : { ...v, columnSize: mine };
      }),
    };
  },

  presentationOnly(root, key) {
    if (PRESENTATION_ROOTS.has(root)) return true;
    // The model's own marker that a summaries block exists: two vaults adding
    // their first summary both set it, and nothing anyone wrote is in it.
    if (root === 'top') return key === SUMMARIES_PRESENT;
    if (root !== 'viewFields') return false;
    return PRESENTATION_FIELDS.has(key.slice(key.indexOf(SEP) + 1));
  },

  dropsOnRewrite(text) {
    return hasYamlComment(text);
  },
};
