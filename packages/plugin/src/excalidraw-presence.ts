import type { Awareness } from 'y-protocols/awareness';
import { PRESENCE_VERSION, readPresence, type Pointer, type Selection, type Viewport } from '@nectenda/shared';
import type { ExcalidrawLiveBinding } from './excalidraw-live';
import { POINTER_WINDOW_MS } from './remote-pointer';
import { log } from './logger';

/**
 * Presence on a drawing bound live (NEC-41, WIRE-099): who else is on it, where
 * their pointer is, and what they have selected — drawn by Excalidraw itself.
 *
 * Excalidraw has a collaborator display built for exactly this — the one its
 * own live collaboration uses: `updateScene({ collaborators })` draws each
 * person's pointer with their name, and outlines what they have selected, in
 * their colour. So nothing is drawn here; peers' states are turned into
 * Excalidraw collaborators and handed over.
 *
 * Positions travel in scene coordinates (`surface: 'excalidraw'`, reserved in
 * the presence format since NEC-93), never in screen ones: no two people see a
 * drawing at the same zoom or scroll. Sealed like every presence state
 * (CRYPTO-110), in the canvas bucket (excalidraw-codec.ts).
 *
 * The pointer is read from the view's own DOM events, converted with the
 * scene's scroll and zoom: the plugin keeps Excalidraw's `onPointerUpdate` for
 * itself, and a component prop cannot be subscribed to from outside.
 */

/** At most this many selected ids are sent; a larger selection is still a selection. */
const MAX_SELECTION = 200;

export interface ExcalidrawPresenceDeps {
  username(): string;
  userColor(name: string): { seat: number; color: string; light: string };
  sharePointer(): boolean;
  showPointers(): boolean;
}

interface Fields {
  pointer: Pointer | null;
  viewport: Viewport | null;
  selection: Selection | null;
}

const EMPTY: Fields = { pointer: null, viewport: null, selection: null };
const r1 = (n: number): number => Math.round(n * 10) / 10;

/** One awareness per document: two panes of one drawing share it. */
const sessions = new WeakMap<Awareness, Set<ExcalidrawPresence>>();

/** The scene point under a client point, by Excalidraw's own formula (`viewportCoordsToSceneCoords`). */
export function toScene(
  client: { clientX: number; clientY: number },
  appState: Record<string, unknown>,
): { x: number; y: number } | null {
  const zoom = (appState.zoom as { value?: unknown } | undefined)?.value;
  const { scrollX, scrollY, offsetLeft, offsetTop } = appState;
  if (typeof zoom !== 'number' || zoom <= 0) return null;
  if (typeof scrollX !== 'number' || typeof scrollY !== 'number') return null;
  const left = typeof offsetLeft === 'number' ? offsetLeft : 0;
  const top = typeof offsetTop === 'number' ? offsetTop : 0;
  return { x: (client.clientX - left) / zoom - scrollX, y: (client.clientY - top) / zoom - scrollY };
}

/** What the view shows of the scene, as a scene rectangle. */
export function sceneViewport(appState: Record<string, unknown>): Viewport | null {
  const zoom = (appState.zoom as { value?: unknown } | undefined)?.value;
  const { scrollX, scrollY, width, height } = appState;
  if (typeof zoom !== 'number' || zoom <= 0) return null;
  if (typeof scrollX !== 'number' || typeof scrollY !== 'number' || typeof width !== 'number' || typeof height !== 'number') return null;
  return { surface: 'excalidraw', x: r1(-scrollX), y: r1(-scrollY), w: r1(width / zoom), h: r1(height / zoom) };
}

/** The selection, as ids. */
export function sceneSelection(appState: Record<string, unknown>): Selection | null {
  const sel = appState.selectedElementIds as Record<string, unknown> | undefined;
  const ids = Object.entries(sel ?? {}).filter(([, on]) => on === true).map(([id]) => id).sort().slice(0, MAX_SELECTION);
  return ids.length > 0 ? { surface: 'excalidraw', ids } : null;
}

/** An Excalidraw collaborator, as `updateScene({ collaborators })` takes it. */
export interface Collaborator {
  id: string;
  socketId: string;
  username: string;
  color: { background: string; stroke: string };
  pointer?: { x: number; y: number; tool: 'pointer' | 'laser' };
  button?: 'up' | 'down';
  selectedElementIds?: Record<string, true>;
}

/**
 * Everyone else on this drawing, as Excalidraw collaborators: never this
 * client (WIRE-093), and only what was said about a drawing — a peer on the
 * same document in another surface has nothing to draw here.
 */
/**
 * Excalidraw's hue for a collaborator id: `getClientColor` and
 * `hashToInteger` in Excalidraw's packages/excalidraw/clients.ts, copied
 * exactly. Excalidraw draws a collaborator's pointer and selection in this
 * colour, at fixed saturation and lightness, and does not use the `color` it
 * is handed, so the only way to choose the colour is to choose the id.
 */
export function excalidrawHue(id: string): number {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash << 5) - hash + id.charCodeAt(i);
  return (Math.abs(hash) % 37) * 10;
}

/** The hue of a `#rrggbb` (or `#rrggbbaa`) colour, in degrees, or null. */
export function hueOf(colour: string): number | null {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(colour);
  if (!m) return null;
  const [r, g, b] = [m[1], m[2], m[3]].map((h) => parseInt(h, 16) / 255);
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  if (d === 0) return 0;
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (h * 60 + 360) % 360;
}

const chosenIds = new Map<string, string>();

/**
 * An id for collaborator `base` that Excalidraw draws in the hue nearest
 * `colour`: Nectenda's colour for that person, the same as in notes and
 * canvases, as near as Excalidraw's 37 hues allow (within 5°). Derived from
 * `base` and searched in order, so every vault picks the same one.
 */
export function idForColour(base: string, colour: string): string {
  const key = `${base}\u0000${colour}`;
  const known = chosenIds.get(key);
  if (known !== undefined) return known;
  const target = hueOf(colour);
  let best = base;
  if (target !== null) {
    const off = (id: string): number => {
      const d = Math.abs(excalidrawHue(id) - target);
      return Math.min(d, 360 - d);
    };
    let bestOff = off(base);
    for (let n = 0; n < 500 && bestOff > 5; n++) {
      const id = `${base}~${n}`;
      const o = off(id);
      if (o < bestOff) {
        best = id;
        bestOff = o;
      }
    }
  }
  chosenIds.set(key, best);
  return best;
}

export function collaboratorsFrom(states: Map<number, unknown>, self: number, showPointers: boolean): Map<string, Collaborator> {
  const out = new Map<string, Collaborator>();
  for (const [clientId, raw] of states) {
    if (clientId === self) continue;
    const p = readPresence(raw);
    if (!p?.user) continue;
    const c: Collaborator = {
      // Chosen for its colour (idForColour); `socketId` is what Excalidraw
      // keys collaborators by.
      id: idForColour(String(clientId), p.user.color),
      socketId: String(clientId),
      username: p.user.name,
      color: { background: p.user.colorLight, stroke: p.user.color },
    };
    if (showPointers && p.pointer?.surface === 'excalidraw') {
      c.pointer = { x: p.pointer.x, y: p.pointer.y, tool: p.pointer.tool };
      c.button = p.pointer.down ? 'down' : 'up';
    }
    if (p.selection?.surface === 'excalidraw') {
      c.selectedElementIds = Object.fromEntries(p.selection.ids.map((id) => [id, true as const]));
    }
    out.set(c.socketId, c);
  }
  return out;
}

/** Presence for one bound drawing: sends ours, hands theirs to Excalidraw. */
export class ExcalidrawPresence {
  private awareness: Awareness;
  private sent: Fields = EMPTY;
  private forceSend = false;
  private client: { clientX: number; clientY: number } | null = null;
  private down = false;
  private flushTimer: number | null = null;
  private restore: (() => void)[] = [];
  private stopped = false;
  private lastDrawn = '';

  constructor(private binding: ExcalidrawLiveBinding, private root: HTMLElement, private deps: ExcalidrawPresenceDeps) {
    this.awareness = binding.awareness as Awareness;
  }

  private baseState(): Record<string, unknown> {
    const name = this.deps.username();
    const c = this.deps.userColor(name);
    return {
      v: PRESENCE_VERSION,
      user: { name, seat: c.seat, color: c.color, colorLight: c.light },
      pointer: null, viewport: null, selection: null, gesture: null,
    };
  }

  start(): void {
    if (!this.binding.awareness) return;
    let sharing = sessions.get(this.awareness);
    if (!sharing) sessions.set(this.awareness, (sharing = new Set()));
    sharing.add(this);
    const existing = this.awareness.getLocalState() as { user?: unknown } | null;
    if (!existing?.user) this.awareness.setLocalState(this.baseState());

    const move = (evt: PointerEvent): void => {
      // Touch never sends a pointer (WIRE-092): a finger is not a cursor.
      if (evt.pointerType === 'touch') return;
      this.client = { clientX: evt.clientX, clientY: evt.clientY };
      this.down = (evt.buttons & 1) === 1;
      this.schedule();
    };
    const press = (evt: PointerEvent): void => {
      if (evt.pointerType === 'touch') return;
      this.down = evt.type === 'pointerdown';
      this.schedule();
    };
    const leave = (): void => {
      this.client = null;
      this.send();
    };
    this.root.addEventListener('pointermove', move, true);
    this.root.addEventListener('pointerdown', press, true);
    this.root.addEventListener('pointerup', press, true);
    this.root.addEventListener('pointerleave', leave);
    this.restore.push(() => {
      this.root.removeEventListener('pointermove', move, true);
      this.root.removeEventListener('pointerdown', press, true);
      this.root.removeEventListener('pointerup', press, true);
      this.root.removeEventListener('pointerleave', leave);
    });

    const onChange = (): void => this.draw();
    this.awareness.on('change', onChange);
    this.restore.push(() => this.awareness.off('change', onChange));
    // A pan, a zoom or a new selection with a still mouse: sampled, as the
    // canvas does, since Excalidraw announces none of them to outsiders.
    const sample = window.setInterval(() => this.schedule(), 100);
    this.restore.push(() => window.clearInterval(sample));
    this.draw();
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const r of this.restore.splice(0).reverse()) {
      try {
        r();
      } catch (err) {
        log.warn('Could not undo a drawing presence hook', { error: String(err) });
      }
    }
    if (this.flushTimer !== null) window.clearTimeout(this.flushTimer);
    try {
      this.binding.api()?.updateScene({ collaborators: new Map() });
    } catch {
      // The view is going.
    }
    const sharing = sessions.get(this.awareness);
    sharing?.delete(this);
    try {
      if (sharing && sharing.size > 0) {
        const state = this.awareness.getLocalState();
        if (state) this.awareness.setLocalState({ ...state, ...EMPTY });
        for (const other of sharing) other.resend();
        return;
      }
      sessions.delete(this.awareness);
      // Leaving retracts at once (WIRE-092).
      this.awareness.setLocalState(null);
    } catch (err) {
      log.warn('Could not retract drawing presence', { error: String(err) });
    }
  }

  private resend(): void {
    this.forceSend = true;
    this.schedule();
  }

  private schedule(): void {
    if (this.flushTimer !== null || this.stopped) return;
    this.flushTimer = window.setTimeout(() => {
      this.flushTimer = null;
      this.send();
    }, POINTER_WINDOW_MS);
  }

  private othersHere(): boolean {
    const self = this.awareness.clientID;
    for (const [id, s] of this.awareness.getStates()) if (id !== self && s) return true;
    return false;
  }

  private send(): void {
    if (this.stopped) return;
    let fields: Fields = EMPTY;
    const api = this.binding.api();
    if (api && this.deps.sharePointer() && this.othersHere()) {
      const appState = api.getAppState();
      const at = this.client ? toScene(this.client, appState) : null;
      const tool = (appState.activeTool as { type?: unknown } | undefined)?.type === 'laser' ? 'laser' : 'pointer';
      fields = {
        pointer: at ? { surface: 'excalidraw', x: r1(at.x), y: r1(at.y), tool, down: this.down } : null,
        viewport: sceneViewport(appState),
        selection: sceneSelection(appState),
      };
    }
    // Unchanged is never resent (WIRE-091).
    if (!this.forceSend && JSON.stringify(fields) === JSON.stringify(this.sent)) return;
    this.forceSend = false;
    this.sent = fields;
    const state = this.awareness.getLocalState() ?? this.baseState();
    this.awareness.setLocalState({ ...state, ...fields });
  }

  /** Hand everyone else to Excalidraw to draw. */
  private draw(): void {
    if (this.stopped) return;
    const api = this.binding.api();
    if (!api) return;
    const collaborators = collaboratorsFrom(this.awareness.getStates(), this.awareness.clientID, this.deps.showPointers());
    const key = JSON.stringify([...collaborators.values()]);
    if (key === this.lastDrawn) return;
    this.lastDrawn = key;
    try {
      api.updateScene({ collaborators });
    } catch (err) {
      log.warn('Could not draw collaborators on a drawing', { error: String(err) });
    }
  }

  /** Everyone else on the drawing, for the header. */
  people(): Array<{ name: string; color: string }> {
    return [...collaboratorsFrom(this.awareness.getStates(), this.awareness.clientID, false).values()]
      .map((c) => ({ name: c.username, color: c.color.stroke }));
  }
}
