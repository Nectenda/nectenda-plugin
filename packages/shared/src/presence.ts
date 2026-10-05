/**
 * Presence format v1: what a participant's awareness state says, once opened.
 *
 * The state travels sealed (see the plugin's presence-seal.ts), so the server
 * has no opinion about any of this. It is a contract between clients only —
 * including clients that do not exist yet, which is why it lives here rather
 * than in the plugin.
 *
 * ## Tagged by surface
 *
 * Text, canvas and Excalidraw each need a pointer, a viewport and (for the
 * last two) a selection, and each means something different by them. Rather
 * than a field per surface, every one of those is a union tagged by `surface`,
 * so a note, a canvas and a drawing share one state shape.
 *
 * ## Positions are in the document's space, never the screen's
 *
 * Two people never see a document at the same zoom, width or wrap. A text
 * position is a `Y.RelativePosition` (base64), which also survives concurrent
 * edits; a canvas position is world coordinates, the units nodes already use in
 * the `.canvas` JSON; an Excalidraw position is scene coordinates. A viewport
 * is a world rectangle rather than zoom plus pan, so each follower fits it to
 * its own pane.
 *
 * ## Reading is lenient, on purpose
 *
 * An unknown `surface`, an unknown field and a higher `v` are ignored rather
 * than refused, and a malformed field reads as null. A client that cannot draw
 * a canvas pointer should just not draw it — failing the whole state would
 * hide the caret it *can* draw, from a peer who is merely newer.
 */

export const PRESENCE_VERSION = 1;

/** A `Y.RelativePosition`, encoded and then base64'd. */
export type RelPos = string;

export interface PresenceUser {
  name: string;
  seat: number;
  color: string;
  colorLight: string;
}

export type Pointer =
  | { surface: 'text'; at: RelPos; dx?: number }
  | { surface: 'canvas'; x: number; y: number; node?: string; nx?: number; ny?: number }
  | { surface: 'excalidraw'; x: number; y: number; tool: 'pointer' | 'laser'; down: boolean };

export type Viewport =
  | { surface: 'text'; top: RelPos }
  | { surface: 'canvas' | 'excalidraw'; x: number; y: number; w: number; h: number };

export type Selection = { surface: 'canvas' | 'excalidraw'; ids: string[] };

/**
 * A gesture in progress on a canvas, drawn by peers as a ghost before it is
 * committed (WIRE-094). A drag or resize carries the nodes' live rectangles;
 * a connection being drawn carries its start and where its loose end is.
 * Nothing here is in the document: the gesture's end commits it there, once.
 */
export type GestureRect = { id: string; x: number; y: number; w: number; h: number };
export type Gesture =
  | { surface: 'canvas'; kind: 'move' | 'resize'; nodes: GestureRect[] }
  | { surface: 'canvas'; kind: 'connect'; from: string; side?: string; x: number; y: number };

/**
 * Which view of a file a person is on, where a file has several (WIRE-096).
 *
 * One shape for every layout of a base — table, cards, list, map, Obsidian
 * 1.14's kanban, a view a plugin registers — because in every layout the view
 * is named, and an entry is one file. Only the drawing differs per layout, and
 * a client that cannot draw a layout still shows the person.
 *
 * `focus` is the entry the person is on, and the property within it: a
 * table's active cell, or the card or list item under the pointer. Its `path`
 * names only a file inside the same shared folder, relative to it: a base can
 * list notes from outside the folder, and naming one to collaborators would
 * leak it.
 */
export type ViewPresence = {
  surface: 'bases';
  name: string;
  type: string;
  focus?: { path: string; property?: string };
} | PropertiesPresence | NoteViewPresence;

/**
 * Someone on a note that another plugin's view shows — a board of the Kanban
 * plugin, say (WIRE-098). `type` is that view's type, so a receiver can name
 * it; the person counts as on the note whatever view the receiver has it in.
 *
 * `focus` is the card they are on, on a Kanban board: its lane and its
 * position in the lane, both counted from zero in the order the board draws
 * them, and `key`, a short hash of the card's text. With no `item` it is the
 * list itself, and `key` hashes the list's title. The board has no ids of its
 * own, so a receiver finds the card or list by `key` first — positions move
 * as cards are added — and by position only when none has that text.
 */
export type NoteViewPresence = {
  surface: 'note-view';
  type: string;
  focus?: { lane: number; item?: number; key: string };
};

/**
 * The property someone has focused in a note's Properties panel (WIRE-097).
 *
 * The panel's inputs are not CodeMirror, so the caret says nothing while
 * someone types a property; this does. `focus` has the shape a base's has, so
 * a panel row, a Bases cell and a card all say "who is on this property" the
 * same way. `path` is the note itself, relative to the shared folder, and a
 * receiver draws it only on that note.
 */
export type PropertiesPresence = {
  surface: 'properties';
  focus: { path: string; property: string };
};

/**
 * The state as written. `cursor` is y-codemirror's and keeps its shape and
 * name, because y-codemirror reads it by that name; this type only says it is
 * there. Text surfaces keep using it rather than `selection`. On a canvas it is
 * the caret inside the card being typed in, in the same shape: its relative
 * positions name that card's `Y.Text` (WIRE-095).
 */
export interface PresenceV1 {
  v: number;
  user: PresenceUser | null;
  cursor: unknown;
  pointer: Pointer | null;
  viewport: Viewport | null;
  selection: Selection | null;
  /** Optional on the wire: absent reads as null, and a client older than it ignores it. */
  gesture: Gesture | null;
  /** Optional on the wire, as `gesture` is. */
  view: ViewPresence | null;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isStr = (v: unknown): v is string => typeof v === 'string';
const optNum = (v: unknown): boolean => v === undefined || isNum(v);
const isIndex = (v: unknown): v is number => isNum(v) && Number.isInteger(v) && v >= 0;

function readUser(v: unknown): PresenceUser | null {
  if (!isObject(v)) return null;
  const { name, seat, color, colorLight } = v;
  if (!isStr(name) || !isNum(seat) || !isStr(color) || !isStr(colorLight)) return null;
  return { name, seat, color, colorLight };
}

function readPointer(v: unknown): Pointer | null {
  if (!isObject(v)) return null;
  switch (v.surface) {
    case 'text':
      if (!isStr(v.at) || !optNum(v.dx)) return null;
      return { surface: 'text', at: v.at, ...(v.dx !== undefined ? { dx: v.dx as number } : {}) };
    case 'canvas': {
      if (!isNum(v.x) || !isNum(v.y)) return null;
      if (v.node !== undefined && !isStr(v.node)) return null;
      if (!optNum(v.nx) || !optNum(v.ny)) return null;
      const out: Pointer = { surface: 'canvas', x: v.x, y: v.y };
      if (isStr(v.node)) out.node = v.node;
      if (v.nx !== undefined) out.nx = v.nx as number;
      if (v.ny !== undefined) out.ny = v.ny as number;
      return out;
    }
    case 'excalidraw':
      if (!isNum(v.x) || !isNum(v.y)) return null;
      if (v.tool !== 'pointer' && v.tool !== 'laser') return null;
      if (typeof v.down !== 'boolean') return null;
      return { surface: 'excalidraw', x: v.x, y: v.y, tool: v.tool, down: v.down };
    default:
      return null;
  }
}

function readViewport(v: unknown): Viewport | null {
  if (!isObject(v)) return null;
  switch (v.surface) {
    case 'text':
      return isStr(v.top) ? { surface: 'text', top: v.top } : null;
    case 'canvas':
    case 'excalidraw':
      if (!isNum(v.x) || !isNum(v.y) || !isNum(v.w) || !isNum(v.h)) return null;
      return { surface: v.surface, x: v.x, y: v.y, w: v.w, h: v.h };
    default:
      return null;
  }
}

function readSelection(v: unknown): Selection | null {
  if (!isObject(v)) return null;
  if (v.surface !== 'canvas' && v.surface !== 'excalidraw') return null;
  if (!Array.isArray(v.ids) || !v.ids.every(isStr)) return null;
  return { surface: v.surface, ids: [...v.ids] };
}

function readRect(v: unknown): GestureRect | null {
  if (!isObject(v)) return null;
  const { id, x, y, w, h } = v;
  if (!isStr(id) || !isNum(x) || !isNum(y) || !isNum(w) || !isNum(h)) return null;
  return { id, x, y, w, h };
}

function readGesture(v: unknown): Gesture | null {
  if (!isObject(v) || v.surface !== 'canvas') return null;
  if (v.kind === 'move' || v.kind === 'resize') {
    if (!Array.isArray(v.nodes)) return null;
    const nodes = v.nodes.map(readRect);
    if (nodes.some((n) => n === null)) return null;
    return { surface: 'canvas', kind: v.kind, nodes: nodes as GestureRect[] };
  }
  if (v.kind === 'connect') {
    if (!isStr(v.from) || !isNum(v.x) || !isNum(v.y)) return null;
    if (v.side !== undefined && !isStr(v.side)) return null;
    return { surface: 'canvas', kind: 'connect', from: v.from, x: v.x, y: v.y, ...(isStr(v.side) ? { side: v.side } : {}) };
  }
  return null;
}

/** A path that stays inside the shared folder: relative, and never climbing out. */
const isInsidePath = (p: unknown): p is string =>
  isStr(p) && p !== '' && !p.startsWith('/') && !p.split('/').includes('..');

function readView(v: unknown): ViewPresence | null {
  if (!isObject(v)) return null;
  if (v.surface === 'properties') {
    // Nothing else to show without the focus, so an unreadable one is no view.
    if (!isObject(v.focus) || !isInsidePath(v.focus.path) || !isStr(v.focus.property) || v.focus.property === '') return null;
    return { surface: 'properties', focus: { path: v.focus.path, property: v.focus.property } };
  }
  if (v.surface === 'note-view') {
    if (!isStr(v.type) || v.type === '') return null;
    const note: NoteViewPresence = { surface: 'note-view', type: v.type };
    // A focus this client cannot read is dropped on its own; the person still shows.
    const f = v.focus;
    if (isObject(f) && isIndex(f.lane) && (f.item === undefined || isIndex(f.item)) && isStr(f.key) && f.key !== '' && f.key.length <= 16) {
      note.focus = f.item === undefined ? { lane: f.lane, key: f.key } : { lane: f.lane, item: f.item, key: f.key };
    }
    return note;
  }
  if (v.surface !== 'bases') return null;
  if (!isStr(v.name) || !isStr(v.type)) return null;
  const out: ViewPresence = { surface: 'bases', name: v.name, type: v.type };
  // A focus this client cannot read is dropped on its own; the person still shows.
  if (isObject(v.focus) && isInsidePath(v.focus.path)) {
    out.focus = { path: v.focus.path };
    if (isStr(v.focus.property)) out.focus.property = v.focus.property;
  }
  return out;
}

/**
 * Read an opened presence state into the fields this version understands.
 *
 * Never throws, and returns null only for something that is not a state at all
 * (not an object). Everything else comes back with what could be read and null
 * for what could not.
 */
export function readPresence(state: unknown): PresenceV1 | null {
  if (!isObject(state)) return null;
  return {
    v: isNum(state.v) ? state.v : PRESENCE_VERSION,
    user: readUser(state.user),
    cursor: state.cursor ?? null,
    pointer: readPointer(state.pointer),
    viewport: readViewport(state.viewport),
    selection: readSelection(state.selection),
    gesture: readGesture(state.gesture),
    view: readView(state.view),
  };
}
