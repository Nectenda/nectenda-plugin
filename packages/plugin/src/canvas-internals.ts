/**
 * The parts of Obsidian's canvas that are not public API, as the live binding
 * (canvas-live.ts) and canvas presence use them.
 *
 * Everything here was read from Obsidian's own `app.js`, at the version below,
 * because there is no other description of it. It will change without notice.
 * That is the standing cost of a live canvas, accepted knowingly, and managed
 * three ways:
 *
 * 1. **Checked before use.** `checkCanvasShape` looks at every member the
 *    binding touches before it binds, and a canvas that fails is left on the
 *    disk path (canvas-view-guard.ts), which uses public API only — with a
 *    notice, so the fallback is never silent.
 * 2. **Caught in use.** A hook that throws unbinds its view, the same way.
 * 3. **Tested against the real thing.** The e2e contract spec checks each
 *    member against the Obsidian the suite runs, so an update that moves one
 *    turns the update's pull request red rather than a user's canvas.
 *
 * Minified names and offsets (bytes into `app.js`) are recorded so the next
 * reader can find the code again: `I7` is the canvas, `V7` a node, `_7` a text
 * node, `o9` an edge, `g9` the canvas view, `CZ` TextFileView.
 */

/** The Obsidian the members below were read against. */
export const OBSIDIAN_CANVAS_READ_AGAINST = '1.13.7';

export type CanvasData = { nodes: Record<string, unknown>[]; edges: Record<string, unknown>[] } & Record<string, unknown>;

/** A node (`V7`, byte 3284384). */
export interface CanvasNodeLike {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** A text card's text (`_7`, byte 3307753). Behind the open editor by up to 2 s. */
  text?: string;
  /** A card whose embedded editor is open. Its text must not be set through `setText`. */
  isEditing: boolean;
  zIndex: number;
  nodeEl: HTMLElement;
  canvas: CanvasLike;
  getData(): Record<string, unknown>;
  setData(data: Record<string, unknown>): void;
  /** Brings it to the front: `zIndex = canvas.getZIndex()`. Groups instead sort by size. */
  updateZIndex?(): void;
  /**
   * A text card's embed (`K7`, byte 3309803), made on first render and absent
   * while the card is culled. Its `previewEl` (`i1`, byte 2586065) holds the
   * card as rendered, in Obsidian's own document; only the editor goes into
   * an iframe (`t1`, byte 2582403). Read for presence only, so optional.
   */
  child?: { previewEl?: HTMLElement };
}

/** An edge (`o9`, byte 3320937). */
export interface CanvasEdgeLike {
  id: string;
  getData(): Record<string, unknown>;
}

/** Undo history (`k7`, byte 3224453): whole-canvas snapshots, `current` the one shown. */
export interface CanvasHistoryLike {
  data: CanvasData[];
  current: number;
}

/** The canvas (`I7`, byte 3226075), `view.canvas`. */
export interface CanvasLike {
  nodes: Map<string, CanvasNodeLike>;
  edges: Map<string, CanvasEdgeLike>;
  selection: Set<unknown>;
  /** What the view saves (`getViewData` serialises it). Rebuilt only by `requestSave`, `setData`, `applyHistory`. */
  data: CanvasData;
  history: CanvasHistoryLike;
  /** `Ml(pushHistory, 250, true)`: a debounced push of the snapshot `requestSave` was given. */
  requestPushHistory?: { run?: () => void };
  /** The live nodes and edges, nodes sorted by zIndex (byte 3234454). */
  getData(): CanvasData;
  /** Update nodes by id, create the missing; `clear` also removes what `data` lacks. Pushes no history, saves nothing. */
  importData(data: { nodes: unknown[]; edges: unknown[] }, clear?: boolean): unknown;
  /** `data = getData()`, push history unless `false`, `view.requestSave()` (byte 3237307). */
  requestSave(pushHistory?: boolean): void;
  /** Undo and redo land here: `importData(snapshot, true)`, `data = snapshot`, `view.requestSave()` — not `requestSave`. */
  applyHistory(data: CanvasData): void;
  removeNode(node: CanvasNodeLike): void;
  removeEdge(edge: CanvasEdgeLike): void;
  /** The canvas point at the centre of the wrapper, and the zoom as a scale. */
  x: number;
  y: number;
  scale: number;
  /** Never transformed; receives the pointer. */
  wrapperEl: HTMLElement;
  /** The transformed layer the nodes live in. */
  canvasEl: HTMLElement;
  posFromEvt(evt: MouseEvent): { x: number; y: number };
  getViewportBBox(): { minX: number; minY: number; maxX: number; maxY: number };
  markViewportChanged(): void;
  /**
   * Centre the view on a world point, keeping the zoom (byte 3238621):
   * `x = tx = e, y = ty = t, markViewportChanged()`. For "go to" from the
   * presence circles only, so optional and checked where it is called.
   */
  panTo?(x: number, y: number): void;
}

/** The canvas view (`g9`, byte 3343531), a TextFileView. */
export interface CanvasViewInternal {
  file: { path: string } | null;
  canvas: CanvasLike;
  data: string;
  /** An edit is waiting for the 2 s save. */
  dirty?: boolean;
  save(clear?: boolean): Promise<void>;
  setViewData(data: string, clear: boolean): void;
  getViewData(): string;
}

const isFn = (o: unknown, k: string): boolean =>
  typeof o === 'object' && o !== null && typeof (o as Record<string, unknown>)[k] === 'function';
const isNum = (o: unknown, k: string): boolean =>
  typeof o === 'object' && o !== null && typeof (o as Record<string, unknown>)[k] === 'number';
const isEl = (v: unknown): boolean =>
  typeof v === 'object' && v !== null && typeof (v as { appendChild?: unknown }).appendChild === 'function';

/**
 * Every member the binding and presence rely on, by kind — what the shape check
 * checks here, and what the e2e contract spec checks against the real thing.
 */
export const CANVAS_CONTRACT = {
  viewMethods: ['setViewData', 'save'],
  canvasMethods: [
    'getData', 'importData', 'requestSave', 'applyHistory', 'removeNode', 'removeEdge',
    'posFromEvt', 'getViewportBBox', 'markViewportChanged',
  ],
  canvasNumbers: ['x', 'y', 'scale'],
  canvasElements: ['wrapperEl', 'canvasEl'],
  nodeMethods: ['getData', 'setData', 'updateZIndex'],
} as const;

const CANVAS_METHODS = CANVAS_CONTRACT.canvasMethods;
const NODE_METHODS = ['getData', 'setData'] as const;

/**
 * The first member the binding relies on that this view lacks or has in
 * another shape, named for the notice and the log — or null when every one is
 * there. Nodes are checked from a sample, since a new canvas has none.
 */
export function checkCanvasShape(view: unknown): string | null {
  if (!isFn(view, 'setViewData')) return 'view.setViewData';
  if (!isFn(view, 'save')) return 'view.save';
  const canvas = (view as { canvas?: unknown }).canvas;
  if (typeof canvas !== 'object' || canvas === null) return 'view.canvas';
  for (const m of CANVAS_METHODS) if (!isFn(canvas, m)) return `canvas.${m}`;
  const c = canvas as Record<string, unknown>;
  if (!(c.nodes instanceof Map)) return 'canvas.nodes';
  if (!(c.edges instanceof Map)) return 'canvas.edges';
  if (!(c.selection instanceof Set)) return 'canvas.selection';
  const history = c.history as Record<string, unknown> | undefined;
  if (!history || !Array.isArray(history.data) || typeof history.current !== 'number') return 'canvas.history';
  for (const k of ['x', 'y', 'scale']) if (!isNum(c, k)) return `canvas.${k}`;
  if (!isEl(c.wrapperEl)) return 'canvas.wrapperEl';
  if (!isEl(c.canvasEl)) return 'canvas.canvasEl';
  const node = (c.nodes as Map<string, unknown>).values().next().value;
  if (node !== undefined) {
    for (const m of NODE_METHODS) if (!isFn(node, m)) return `node.${m}`;
    const n = node as Record<string, unknown>;
    if (typeof n.isEditing !== 'boolean') return 'node.isEditing';
    if (!isEl(n.nodeEl)) return 'node.nodeEl';
    if (n.canvas !== canvas) return 'node.canvas';
  }
  return null;
}
