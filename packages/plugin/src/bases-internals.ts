/**
 * The parts of Obsidian's Bases view that are not public API, as focus
 * presence (WIRE-096) uses them: which entry someone is on, and which element
 * draws an entry, in the table, cards and list layouts.
 *
 * The public API describes a `BasesView` only to the plugin that registers it.
 * Nothing public reaches the built-in layouts behind a `bases` leaf, so
 * everything here was read from Obsidian's own `app.js`, at the version below,
 * and will change without notice. It is managed as canvas-internals.ts is:
 *
 * 1. **Checked before use.** `checkBasesShape` looks at every member read here,
 *    and a base that fails keeps view-level presence only — with a notice, so
 *    the fallback is never silent.
 * 2. **Read only.** Nothing here writes to Obsidian's objects or calls a method
 *    on them. `getRowForEntry`, the list's own lookup, creates a row when it
 *    has none, so it is deliberately not used.
 * 3. **Tested against the real thing.** The e2e contract spec checks each
 *    member against the Obsidian the suite runs.
 *
 * Minified names and offsets (bytes into `app.js`) so the next reader can find
 * the code again: the leaf's `controller.view` is the layout
 * (`getActiveBasesViewOfType`, byte 2506828); `Z5` the table (3113100) with
 * `activeCell` and `rows`; `o8` a table row and `a8` a cell (3147666); `A5` a
 * card (3093198) in the cards view's `items`; `z5` a list group (3100584) with
 * `rows`, and `q5` a list row (3101700).
 */

/** The Obsidian the members below were read against. */
export const OBSIDIAN_BASES_INTERNALS_READ_AGAINST = '1.13.7';

/** The layouts whose entries can be found and drawn. Any other draws nothing finer than the view. */
export type FocusLayout = 'table' | 'cards' | 'list';

/** An entry as a layout holds it: the public `BasesEntry`, of which only the file is read. */
interface EntryLike { file: { path: string } }

/** A shown entry and the element that draws it, with the table's cells. */
export interface PlacedEntry {
  path: string;
  el: HTMLElement;
  /** A table row's cells, by property id (`note.status`, `file.name`, `formula.x`). */
  cells?: { prop: string; el: HTMLElement }[];
}

/**
 * Every member read here, by layout — what the shape check checks, and what the
 * e2e contract spec checks against the real thing.
 */
export const BASES_CONTRACT = {
  leaf: ['controller', 'controller.view'],
  layout: ['type', 'containerEl', 'data.groupedData'],
  table: ['activeCell', 'rows', 'row.entry', 'row.el', 'row.cells', 'cell.prop', 'cell.el'],
  cards: ['items', 'item.entry', 'item.el'],
  list: ['groups', 'group.rows', 'row.entry', 'row.el'],
} as const;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const isEl = (v: unknown): v is HTMLElement =>
  isObj(v) && typeof (v as { appendChild?: unknown }).appendChild === 'function';
const isEntry = (v: unknown): v is EntryLike =>
  isObj(v) && isObj(v.file) && typeof (v.file as { path?: unknown }).path === 'string';

const KNOWN: readonly string[] = ['table', 'cards', 'list'];

/** The layout a bases leaf is showing, or null when it has none this can read. */
export function layoutView(leafView: unknown): Record<string, unknown> | null {
  if (!isObj(leafView) || !isObj(leafView.controller)) return null;
  const view = leafView.controller.view;
  return isObj(view) ? view : null;
}

/** Which drawable layout this is, or null for one this does not know (kanban, map, a plugin's). */
export function layoutOf(view: Record<string, unknown>): FocusLayout | null {
  return typeof view.type === 'string' && KNOWN.includes(view.type) ? (view.type as FocusLayout) : null;
}

/**
 * The first member this relies on that the leaf's layout lacks or has in
 * another shape, named for the notice and the log — or null when every one is
 * there, or when the layout is one this does not draw (nothing of it is read).
 * Rows, cards and cells are checked from a sample, since an empty base has none.
 */
export function checkBasesShape(leafView: unknown): string | null {
  if (!isObj(leafView) || !isObj(leafView.controller)) return 'controller';
  const view = leafView.controller.view;
  if (!isObj(view)) return 'controller.view';
  if (typeof view.type !== 'string') return 'view.type';
  const layout = layoutOf(view);
  if (!layout) return null;
  if (!isEl(view.containerEl)) return `${layout}.containerEl`;
  if (!isObj(view.data) || !Array.isArray(view.data.groupedData)) return `${layout}.data.groupedData`;
  const group = (view.data.groupedData as unknown[])[0];
  if (group !== undefined && !(isObj(group) && Array.isArray(group.entries))) return `${layout}.data.groupedData.entries`;
  if (layout === 'table') {
    if (view.activeCell !== null && view.activeCell !== undefined) {
      const c = view.activeCell;
      if (!isObj(c) || typeof c.groupIdx !== 'number' || typeof c.row !== 'number' || typeof c.column !== 'number') return 'table.activeCell';
    }
    if (!Array.isArray(view.rows)) return 'table.rows';
    return checkRow(view.rows[0], 'table', true);
  }
  if (layout === 'cards') {
    if (!Array.isArray(view.items)) return 'cards.items';
    return checkRow(view.items[0], 'cards', false);
  }
  if (!Array.isArray(view.groups)) return 'list.groups';
  const g: unknown = (view.groups as unknown[])[0];
  if (g === undefined) return null;
  if (!isObj(g) || !Array.isArray(g.rows)) return 'list.group.rows';
  return checkRow(g.rows[0], 'list', false);
}

function checkRow(row: unknown, layout: FocusLayout, cells: boolean): string | null {
  if (row === undefined) return null;
  if (!isObj(row)) return `${layout}.row`;
  if (!isEntry(row.entry)) return `${layout}.row.entry`;
  if (!isEl(row.el)) return `${layout}.row.el`;
  if (!cells) return null;
  if (!Array.isArray(row.cells)) return 'table.row.cells';
  const cell: unknown = (row.cells as unknown[])[0];
  if (cell === undefined) return null;
  if (!isObj(cell) || typeof cell.prop !== 'string') return 'table.cell.prop';
  if (!isEl(cell.el)) return 'table.cell.el';
  return null;
}

/** Every entry the layout is drawing right now, with its element. Off-screen rows are not drawn, so not here. */
export function placedEntries(view: Record<string, unknown>): PlacedEntry[] {
  const layout = layoutOf(view);
  const rows: unknown[] =
    layout === 'table' ? (view.rows as unknown[])
    : layout === 'cards' ? (view.items as unknown[])
    : layout === 'list' ? (view.groups as { rows: unknown[] }[]).flatMap((g) => g.rows)
    : [];
  const out: PlacedEntry[] = [];
  for (const r of rows) {
    if (!isObj(r) || !isEntry(r.entry) || !isEl(r.el) || !r.el.isConnected) continue;
    const placed: PlacedEntry = { path: r.entry.file.path, el: r.el };
    if (layout === 'table' && Array.isArray(r.cells)) {
      placed.cells = (r.cells as unknown[]).flatMap((c) =>
        isObj(c) && typeof c.prop === 'string' && isEl(c.el) ? [{ prop: c.prop, el: c.el }] : []);
    }
    out.push(placed);
  }
  return out;
}

/** The entry, and the property id, the table's active cell is on. */
export function tableActive(view: Record<string, unknown>): { path: string; prop: string | null } | null {
  if (layoutOf(view) !== 'table') return null;
  const c = view.activeCell;
  if (!isObj(c)) return null;
  const groups = (view.data as { groupedData: { entries: unknown[] }[] }).groupedData;
  const entry = groups[c.groupIdx as number]?.entries?.[c.row as number];
  if (!isEntry(entry)) return null;
  // The column is an index into a row's cells. The active row is on screen, so
  // it is drawn; if not, the entry alone is still right.
  const path = entry.file.path;
  const row = (view.rows as unknown[]).find((r) => isObj(r) && isEntry(r.entry) && r.entry.file.path === path) as { cells?: unknown[] } | undefined;
  const cell = row?.cells?.[c.column as number];
  return { path: entry.file.path, prop: isObj(cell) && typeof cell.prop === 'string' ? cell.prop : null };
}

/** The entry drawn by the card or list item an element is inside, for the pointer. */
export function entryAtElement(view: Record<string, unknown>, target: Element | null): string | null {
  const layout = layoutOf(view);
  if (layout !== 'cards' && layout !== 'list' || !target) return null;
  const item = target.closest(layout === 'cards' ? '.bases-cards-item' : '.bases-list-item');
  if (!item) return null;
  return placedEntries(view).find((p) => p.el === item)?.path ?? null;
}

/**
 * A property id as the wire names it: the frontmatter key of a note property,
 * else none. By Obsidian's own rule (`qX`, byte 2308874): `file.` and
 * `formula.` are not note properties; `note.x` is `x`; and an id with no such
 * prefix — `status` as a base file usually spells it, or `my.key` — is a note
 * property named in full.
 */
export function wireProperty(prop: string | null): string | undefined {
  if (prop === null || prop === '') return undefined;
  const dot = prop.indexOf('.');
  const kind = dot === -1 ? null : prop.slice(0, dot);
  if (kind === 'file' || kind === 'formula') return undefined;
  const key = kind === 'note' ? prop.slice(dot + 1) : prop;
  return key === '' ? undefined : key;
}

/**
 * The element that should show a focus: the table cell of its property when
 * that column is shown, a card's line for it, else the entry's row, card or
 * list item. Null when the entry is not drawn.
 */
export function focusElement(view: Record<string, unknown>, path: string, property?: string): HTMLElement | null {
  const placed = placedEntries(view).find((p) => p.path === path);
  if (!placed) return null;
  if (property === undefined) return placed.el;
  const cell = placed.cells?.find((c) => wireProperty(c.prop) === property);
  if (cell) return cell.el;
  if (layoutOf(view) === 'cards') {
    for (const line of Array.from(placed.el.querySelectorAll<HTMLElement>('.bases-cards-property'))) {
      if (wireProperty(line.dataset.property ?? null) === property) return line;
    }
  }
  return placed.el;
}
