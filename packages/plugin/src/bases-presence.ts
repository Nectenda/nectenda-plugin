import type { Awareness } from 'y-protocols/awareness';
import { PRESENCE_VERSION } from '@nectenda/shared';
import { presenceReporter } from './editor-bridge';
import { basesCodec } from './bases-codec';
import type { BasesValue } from './bases-model';
import type { Person } from './presence';
import type { StructuredSync } from './structured-sync';
import { log } from './logger';
import { checkBasesShape, entryAtElement, layoutOf, layoutView, tableActive, wireProperty } from './bases-internals';
import { FocusMarks, basesFocusMarks, relativeTo } from './bases-focus-draw';

/**
 * Who has a base open, and which of its views they are on (WIRE-096).
 *
 * The unit is the named view, whatever its layout: table, cards, list, map,
 * Obsidian 1.14's kanban, or a layout a plugin registers. Each is reported the
 * same way and drawn the same way — a circle in the view header, its title
 * naming the view — so a layout this build has never heard of still shows who
 * is there.
 *
 * Finer than the view, `focus` says which entry someone is on, and in a table
 * which property: the table's active cell, or the card or list item under the
 * pointer, since neither of those layouts has a selection and a click opens
 * the note. It is drawn on the same entry in everyone else's layout, if that
 * layout draws it. Finding either needs the Bases view's internals
 * (bases-internals.ts), checked before use; a base that fails the check keeps
 * everything above and says so once. Kanban, map and a plugin's layouts send
 * and draw no focus.
 *
 * The view itself is public API: the leaf's own state names the selected view
 * (`viewName`), and the view's `data` is the file it shows, which names that
 * view's layout. Nothing binds the view to the document — disk stays the only
 * writer, guarded by text-view-guard.ts — so presence holds the document only
 * to reach its awareness.
 */

/** How often open bases are checked for a change of view; see main.ts. */
export const BASES_PRESENCE_TICK_MS = 2000;

/** What this needs of an open bases view. */
export interface BasesViewLike {
  file: { path: string } | null;
  /** The text the view holds: the file as it last loaded or saved it. */
  data: string | null;
  /** The view the leaf has selected, from its state; null for the default (the first). */
  viewName(): string | null;
  /** The leaf's view itself, whose internals say which entry is focused (bases-internals.ts). */
  leaf?(): unknown;
}

/** The public surface of Obsidian's bases view this reads: a TextFileView's file, data and state. */
export interface ObsidianBasesView {
  file: { path: string } | null;
  data: string;
  getState(): Record<string, unknown>;
}

const wrappers = new WeakMap<object, BasesViewLike & { view: ObsidianBasesView }>();

/**
 * An Obsidian bases view, as this sees it. The selected view's name is in the
 * leaf's own state. One wrapper per view, so the same view compares equal
 * however often it is asked for.
 */
export function basesViewLike<V extends ObsidianBasesView>(view: V): BasesViewLike & { view: V } {
  const known = wrappers.get(view);
  if (known) return known as BasesViewLike & { view: V };
  const made = {
    view,
    get file() { return view.file; },
    get data() { return view.data; },
    viewName: () => {
      const name = view.getState().viewName;
      return typeof name === 'string' && name !== '' ? name : null;
    },
    leaf: () => view,
  };
  wrappers.set(view, made);
  return made;
}

export interface BasesPresenceDeps {
  structured: Pick<StructuredSync, 'acquireDoc' | 'releaseDoc' | 'docNameFor'>;
  /** Every open bases view. */
  views(): BasesViewLike[];
  /** The active view, if it is a bases view. */
  active(): BasesViewLike | null;
  username(): string;
  userColor(name: string): { seat: number; color: string; light: string };
  /** Who is here, for the header of the active base. Only called while one is active. */
  report(people: Person[]): void;
  /**
   * The local root of the shared folder a path is in, or null. A focus names
   * only an entry under the base's own root, relative to it (WIRE-096): a base
   * can list notes from anywhere in the vault, and naming one outside the
   * folder would tell collaborators it exists.
   */
  folderRoot?(path: string): string | null;
  /** A notice, shown once per session when the Bases internals are not as read. */
  notify?(message: string): void;
}

/** The entry this device is on in a base, as sent. */
type Focus = { path: string; property?: string };

interface Held {
  docName: string;
  awareness: Awareness;
  onChange: () => void;
  /** The view and focus this device last sent, so an unchanged one is not re-sent (WIRE-091). */
  sent: string | null;
}

/** The view a base is showing: the selected one by name, else the first, with its layout. */
export function shownView(view: BasesViewLike): { name: string; type: string } | null {
  if (typeof view.data !== 'string' || view.data === '') return null;
  const parsed = basesCodec.parse(view.data);
  if (!parsed.ok) return null;
  const views = (parsed.value as BasesValue).views;
  const wanted = view.viewName();
  const found = (wanted !== null ? views.find((v) => v.name === wanted) : undefined) ?? views[0];
  return found ? { name: found.name, type: found.type } : null;
}

/**
 * Where to listen for a base's focus events: the leaf's own container, which
 * is there before the layout has loaded and outlives a change of view, else
 * the layout's scroll element.
 */
function hostOf(view: BasesViewLike | null, layout: Record<string, unknown> | null): HTMLElement | null {
  const leafEl = (view?.leaf?.() as { containerEl?: unknown } | null | undefined)?.containerEl;
  if (typeof leafEl === 'object' && leafEl !== null && typeof (leafEl as { addEventListener?: unknown }).addEventListener === 'function') return leafEl as HTMLElement;
  const container = layout?.containerEl as HTMLElement | undefined;
  return container ? container.parentElement ?? container : null;
}

export class BasesPresence {
  /** By local path: one document, one awareness, however many panes show it. */
  private held = new Map<string, Held>();
  /** Set for the session once the internals are found not as read: view-level presence only. */
  private broken = false;
  /** The card or list item under this device's pointer, in the layout it was found in. */
  private hover: { layout: object; path: string } | null = null;
  /** The listeners on the active base's layout, which say when its focus may have moved. */
  private listening: { host: object; stop: () => void } | null = null;
  private marks = new FocusMarks();
  private soon: number | null = null;
  private frame: number | null = null;

  constructor(private deps: BasesPresenceDeps) {}

  /**
   * Bring presence in line with what is open: hold every open base, say which
   * view this device is on in each, and let go of bases no longer open. Called
   * on layout and active-leaf changes; cheap and idempotent.
   */
  refresh(): void {
    const open = new Map<string, BasesViewLike[]>();
    for (const v of this.deps.views()) {
      if (!v.file) continue;
      const list = open.get(v.file.path) ?? [];
      list.push(v);
      open.set(v.file.path, list);
    }
    for (const [path, held] of [...this.held]) {
      if (!open.has(path)) this.release(path, held);
    }
    const active = this.deps.active();
    const activeLayout = active ? this.usableLayout(active) : null;
    for (const [path, views] of open) {
      const held = this.held.get(path) ?? this.hold(path);
      if (!held) continue;
      // Several panes of one base share one state: the active pane's view if
      // one of them is active, else the first.
      const shown = shownView(views.find((v) => v === active) ?? views[0]);
      // Only the active base has a focus: someone is on one entry at a time.
      const focus = shown && activeLayout && active?.file?.path === path ? this.focusIn(activeLayout, path) : null;
      this.publish(held, shown, focus);
    }
    const activePath = active?.file?.path;
    const activeHeld = activePath ? this.held.get(activePath) : undefined;
    if (activeHeld) this.reportNow(activeHeld);
    this.listen(active, activeLayout);
    this.draw();
  }

  /** Redraw everyone's focus in the active base: after a scroll, or a change of who is where. */
  draw(): void {
    const active = this.deps.active();
    const path = active?.file?.path;
    const held = path ? this.held.get(path) : undefined;
    const layout = active && held ? this.usableLayout(active) : null;
    const root = path ? this.deps.folderRoot?.(path) ?? null : null;
    if (!layout || !held || root === null) {
      this.marks.clear();
      return;
    }
    this.marks.draw(basesFocusMarks(layout, held.awareness.getStates(), held.awareness.clientID, root));
  }

  /**
   * The active base's layout, if focus can be read from it. The first time the
   * internals are found not as read, this falls back for the session — warns,
   * says so once, and leaves only view-level presence.
   */
  private usableLayout(view: BasesViewLike): Record<string, unknown> | null {
    if (this.broken || !view.leaf || !this.deps.folderRoot) return null;
    const leaf = view.leaf();
    const layout = layoutView(leaf);
    // A base still loading has a controller and no layout yet, or a layout
    // whose query has not answered (`data` unset). Neither is a broken
    // contract — taking it for one turned focus off for the session on every
    // open (found by the e2e) — and the contract spec defends both members.
    if (!layout && (leaf as { controller?: unknown } | null)?.controller) return null;
    if (layout && layoutOf(layout) && (layout.data === undefined || layout.data === null)) return null;
    const missing = checkBasesShape(leaf);
    if (missing) {
      this.fellBack(missing);
      return null;
    }
    return layout && layoutOf(layout) ? layout : null;
  }

  private fellBack(missing: string): void {
    this.broken = true;
    log.warn("Bases focus presence is off: Obsidian's bases view is not as it was read", { missing });
    this.deps.notify?.('Nectenda: showing which entry collaborators are on in a base is unavailable with this version of Obsidian. Who has a base open still shows. Details are in the diagnostic log.');
    this.listen(null, null);
    this.marks.clear();
  }

  /** The entry this device is on in a base's layout, folder-relative, or null. */
  private focusIn(layout: Record<string, unknown>, basePath: string): Focus | null {
    const root = this.deps.folderRoot?.(basePath) ?? null;
    if (root === null) return null;
    let path: string | null = null;
    let prop: string | null = null;
    if (layoutOf(layout) === 'table') {
      const at = tableActive(layout);
      path = at?.path ?? null;
      prop = at?.prop ?? null;
    } else if (this.hover?.layout === layout) {
      path = this.hover.path;
    }
    if (path === null) return null;
    const rel = relativeTo(root, path);
    if (rel === null) return null;
    const property = wireProperty(prop);
    return property === undefined ? { path: rel } : { path: rel, property };
  }

  /**
   * Listen on the active base's leaf for what moves its focus: the table's
   * active cell follows clicks, keys and focus; a card or list item follows
   * the pointer. A scroll recycles rows, so it redraws.
   *
   * On the leaf, not the layout: picking another view builds a new layout,
   * and listeners on the old one missed the pointer until the next refresh
   * noticed (found by the e2e). The layout is looked up when each event comes.
   */
  private listen(view: BasesViewLike | null, layout: Record<string, unknown> | null): void {
    // Not gated on the layout: one still loading has none, and waiting for
    // the next refresh to listen missed the pointer meanwhile (found by the e2e).
    const host = view && !this.broken ? hostOf(view, layout) : null;
    if ((this.listening?.host ?? null) === host) return;
    this.listening?.stop();
    this.listening = null;
    this.hover = null;
    if (!view || !host) return;
    const current = (): Record<string, unknown> | null => (this.deps.active() === view ? this.usableLayout(view) : null);
    const later = (): void => this.later();
    const changed = (): void => {
      if (layoutOf(current() ?? {}) === 'table') later();
    };
    const over = (e: Event): void => {
      const now = current();
      const path = now ? entryAtElement(now, e.target as Element | null) : null;
      if (now === this.hover?.layout && path === this.hover.path) return;
      if (path === null && this.hover === null) return;
      this.hover = path === null || !now ? null : { layout: now, path };
      later();
    };
    const leave = (): void => {
      if (this.hover === null) return;
      this.hover = null;
      later();
    };
    // Next frame, not now: this runs before the layout's own scroll handler,
    // which is what recycles its rows, and a mark drawn first would stay on
    // a row now showing another note (found in review).
    const scrolled = (): void => {
      if (this.frame !== null) return;
      this.frame = window.requestAnimationFrame(() => {
        this.frame = null;
        this.draw();
      });
    };
    const on: [string, (e: Event) => void, boolean][] = [
      ['pointerup', changed, false], ['keyup', changed, false], ['focusin', changed, false],
      ['pointerover', over, false], ['pointerleave', leave, false],
      ['scroll', scrolled, true],
    ];
    for (const [type, fn, capture] of on) host.addEventListener(type, fn, capture);
    this.listening = {
      host,
      stop: () => { for (const [type, fn, capture] of on) host.removeEventListener(type, fn, capture); },
    };
  }

  /** Refresh once, after the event that asked has been handled by Obsidian too. */
  private later(): void {
    if (this.soon !== null) return;
    this.soon = window.setTimeout(() => {
      this.soon = null;
      this.refresh();
    }, 0);
  }

  /** The view a person is on in the active base, for "go to", or null. */
  viewOf(name: string): string | null {
    const path = this.deps.active()?.file?.path;
    const held = path ? this.held.get(path) : undefined;
    if (!held) return null;
    for (const [clientId, state] of held.awareness.getStates()) {
      if (clientId === held.awareness.clientID) continue;
      const s = state as { user?: { name?: unknown }; view?: { surface?: unknown; name?: unknown } } | null;
      if (s?.user?.name === name && s.view?.surface === 'bases' && typeof s.view.name === 'string') return s.view.name;
    }
    return null;
  }

  dispose(): void {
    if (this.soon !== null) window.clearTimeout(this.soon);
    if (this.frame !== null) window.cancelAnimationFrame(this.frame);
    this.frame = null;
    this.soon = null;
    this.listen(null, null);
    this.marks.clear();
    for (const [path, held] of [...this.held]) this.release(path, held);
  }

  private hold(path: string): Held | null {
    const docName = this.deps.structured.docNameFor(path);
    if (!docName) return null;
    const got = this.deps.structured.acquireDoc(docName);
    if (!got) return null;
    if (!got.awareness) {
      this.deps.structured.releaseDoc(docName);
      return null;
    }
    const awareness = got.awareness;
    const report = (people: Person[]): void => {
      if (this.deps.active()?.file?.path === path) this.deps.report(people);
    };
    const reporter = presenceReporter(awareness, docName, report);
    const onChange = (): void => {
      reporter();
      if (this.deps.active()?.file?.path === path) this.draw();
    };
    awareness.on('change', onChange);
    const held: Held = { docName, awareness, onChange, sent: null };
    this.held.set(path, held);
    // The provider destroys a document's awareness when it disconnects the
    // file (a folder gone, a remote deletion) even while the base stays open.
    // Let go of it, so the next refresh holds whatever reconnects there,
    // rather than speaking into a dead one (found in review).
    awareness.on('destroy', () => {
      if (this.held.get(path) !== held) return;
      this.held.delete(path);
      awareness.off('change', onChange);
      this.deps.structured.releaseDoc(docName);
    });
    return held;
  }

  private publish(held: Held, shown: { name: string; type: string } | null, focus: Focus | null): void {
    const key = shown ? JSON.stringify([shown.name, shown.type, focus?.path ?? null, focus?.property ?? null]) : '';
    if (held.sent === key) return;
    held.sent = key;
    log.debug('Bases presence sent', { docName: held.docName, view: shown?.name ?? null, focus: focus !== null, property: focus?.property !== undefined });
    const name = this.deps.username();
    const c = this.deps.userColor(name);
    held.awareness.setLocalState({
      v: PRESENCE_VERSION,
      user: { name, seat: c.seat, color: c.color, colorLight: c.light },
      cursor: null, pointer: null, viewport: null, selection: null, gesture: null,
      view: shown ? { surface: 'bases', name: shown.name, type: shown.type, ...(focus ? { focus } : {}) } : null,
    });
  }

  private reportNow(held: Held): void {
    // A fresh reporter always reports: the header was just cleared by
    // whatever view was active before.
    presenceReporter(held.awareness, held.docName, (people) => this.deps.report(people))();
  }

  private release(path: string, held: Held): void {
    this.held.delete(path);
    held.awareness.off('change', held.onChange);
    // Gone at once, not after the 30 s awareness timeout (WIRE-092).
    try {
      held.awareness.setLocalState(null);
    } catch (err) {
      log.debug('Could not clear presence for a base', { path, error: String(err) });
    }
    this.deps.structured.releaseDoc(held.docName);
  }
}
