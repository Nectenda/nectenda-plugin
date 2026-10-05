import { addIcon, ItemView, Menu, setIcon, type App } from 'obsidian';
import type { FileStatusView } from './file-status-indicator';

/** The connection states the plugin reports, as `updateStatus` receives them. */
export type ConnectionStatus =
  | 'connected' | 'disconnected' | 'offline' | 'restarting' | 'device-limit'
  | 'suspended' | 'moving' | 'signed-out' | 'update-required' | 'idle';

/**
 * What the connection state means to a person, in words.
 *
 * The same sentences the status bar carried. Each says what is wrong rather
 * than "offline" where it is not a network fault, because "offline" sends
 * people to check a network that is fine.
 */
export const CONNECTION_LABELS: Record<ConnectionStatus, string> = {
  connected: 'Connected',
  idle: 'Signed in — not syncing an organisation on this device',
  disconnected: 'Disconnected',
  'signed-out': 'Session ended — checking…',
  'device-limit': 'Device limit reached',
  suspended: 'Account suspended',
  moving: 'Organisation moving servers…',
  offline: 'Offline (reconnecting…)',
  restarting: 'Server updating — back in a moment…',
  'update-required': 'Update the plugin to keep syncing',
};

/**
 * One colour family per meaning. Never the only signal: the label carries the
 * same thing in words, and the badge is a number.
 */
export type HeaderTone = 'ok' | 'busy' | 'offline' | 'problem' | 'idle';

export interface HeaderInput {
  connection: ConnectionStatus;
  /** This note's status, or null when it is outside every shared folder. */
  note: FileStatusView | null;
  /** People other than this device with the note open. */
  others: number;
  invites: number;
  /** Folders already shared with this person, ready to add here. Absent counts as none. */
  readyFolders?: number;
  /** "3 folders syncing in this vault", for the tooltip. Absent leaves the line out. */
  foldersLine?: string | null;
}

export interface HeaderState {
  tone: HeaderTone;
  /** For the tooltip and `aria-label`: the whole status, in words. */
  label: string;
  /** The number at the bottom right: other people in the note. Null for none. */
  badge: string | null;
  /**
   * The dot at the top right: something is waiting for this person —
   * an invitation, or a folder shared with them. Independent of the badge,
   * so a number always means people and the dot always means "for you".
   */
  waiting: boolean;
}

/** States that need the person to do something, not just wait. */
export const PROBLEM_CONNECTIONS = new Set<ConnectionStatus>(['device-limit', 'suspended', 'update-required', 'signed-out']);
const PROBLEMS = PROBLEM_CONNECTIONS;
const AWAY = new Set<ConnectionStatus>(['disconnected', 'offline', 'restarting', 'moving']);

export function headerState(input: HeaderInput): HeaderState {
  const { connection, note, others, invites } = input;

  let tone: HeaderTone;
  if (PROBLEMS.has(connection)) tone = 'problem';
  else if (AWAY.has(connection)) tone = 'offline';
  else if (connection === 'idle') tone = 'idle';
  else if (!note || note.status === 'confirmed') tone = 'ok';
  else if (note.status === 'error') tone = 'problem';
  // Untracked reads as offline, not busy: nothing is moving and nothing will
  // until the note connects, and the accent said otherwise.
  else if (note.status === 'offline' || note.status === 'untracked') tone = 'offline';
  else tone = 'busy';

  const lines = [`Nectenda: ${CONNECTION_LABELS[connection]}`];
  lines.push(note ? note.label : 'This note is not in a shared folder');
  if (others === 1) lines.push('1 other person has this note open');
  else if (others > 1) lines.push(`${others} other people have this note open`);
  if (invites > 0) lines.push(`${invites} invitation${invites === 1 ? '' : 's'} waiting`);
  const ready = input.readyFolders ?? 0;
  if (ready > 0) lines.push(`${ready} folder${ready === 1 ? '' : 's'} shared with you, ready to add`);
  if (input.foldersLine) lines.push(input.foldersLine);

  // Others only, and nothing at all when it is just you: a number should
  // always mean somebody else is here.
  const badge = others > 0 ? (others > 9 ? '9+' : String(others)) : null;
  return { tone, label: lines.join('\n'), badge, waiting: invites + ready > 0 };
}

/**
 * People in the note other than this device, for the badge.
 *
 * By name, as the presence circles count, and against the name this device
 * *broadcasts* — not the one in settings. A display name saved mid-session
 * is not broadcast until the next connection, so comparing with settings
 * counted this device's own entry, still under the old name, as somebody
 * else: rename yourself and the badge said 2 with one other person there.
 */
export function countOthers(people: ReadonlyArray<{ name: string }>, broadcastName: string): number {
  return people.filter((p) => p.name !== broadcastName).length;
}

/** One entry in the icon's menu, as data so the choice of entries is testable. */
export type HeaderMenuItem =
  | { kind: 'label'; title: string }
  | { kind: 'toggle'; id: 'share-pointer' | 'show-pointers'; title: string; checked: boolean }
  | { kind: 'action'; id: 'inspect' | 'settings' | 'shared-with-you' | 'folder-settings' | 'invite'; title: string }
  | { kind: 'person'; name: string; title: string }
  | { kind: 'separator' };

/** What the menu needs beyond the state: the same for all three places the icon appears. */
export interface MenuContext {
  pointers: { share: boolean; show: boolean };
  /** The note is in a folder this vault syncs; `owner` when this account owns that folder. */
  folder: { owner: boolean } | null;
  /** Other people in the note, by name. */
  people: string[];
  /** Invitations plus folders shared with you and ready to add. */
  waiting: number;
}

/**
 * The icon's menu. One list for the note header, the ribbon and the status
 * bar, so whichever a person keeps, it does the same things.
 */
export function headerMenu(state: HeaderState, ctx: MenuContext): HeaderMenuItem[] {
  const items: HeaderMenuItem[] = [];
  for (const line of state.label.split('\n')) items.push({ kind: 'label', title: line });
  if (ctx.people.length) {
    items.push({ kind: 'separator' });
    for (const name of ctx.people) items.push({ kind: 'person', name, title: `Go to ${name}` });
  }
  if (ctx.waiting > 0) {
    items.push({ kind: 'separator' });
    items.push({ kind: 'action', id: 'shared-with-you', title: `Shared with you: ${ctx.waiting} waiting…` });
  }
  if (ctx.folder) {
    items.push({ kind: 'separator' });
    items.push({ kind: 'action', id: 'folder-settings', title: 'Folder settings…' });
    if (ctx.folder.owner) items.push({ kind: 'action', id: 'invite', title: 'Invite to folder…' });
    items.push({ kind: 'action', id: 'inspect', title: 'Inspect sync state' });
  }
  items.push({ kind: 'separator' });
  items.push({ kind: 'toggle', id: 'share-pointer', title: 'Share my mouse pointer', checked: ctx.pointers.share });
  items.push({ kind: 'toggle', id: 'show-pointers', title: "Show collaborators' mouse pointers", checked: ctx.pointers.show });
  items.push({ kind: 'separator' });
  items.push({ kind: 'action', id: 'settings', title: 'Open Nectenda settings' });
  return items;
}

/** Where the status icon is shown. At least one is always on; see `mayHide`. */
export interface StatusPlaces {
  header: boolean;
  ribbon: boolean;
  statusBar: boolean;
}

/**
 * Whether a place may be switched off: not when it is the last one showing.
 * `available` says which places this platform has — a phone has no status
 * bar, so one switched on in a synced settings file does not count there.
 */
export function mayHide(places: StatusPlaces, which: keyof StatusPlaces, available: StatusPlaces = { header: true, ribbon: true, statusBar: true }): boolean {
  const shown = (Object.keys(places) as Array<keyof StatusPlaces>).filter((k) => places[k] && available[k]);
  return !(shown.length === 1 && shown[0] === which);
}

export const HEADER_ICON = 'nectenda-mark';

/**
 * The mark, in one colour so the tone can carry state through `currentColor`.
 * Registered with Obsidian's icon set, which draws on a 100-unit grid; the
 * mark's own grid is 64. Same geometry as `nectendaMark`, whose break in the
 * green cane is what lets it work without knowing the background colour.
 */
export function registerHeaderIcon(): void {
  addIcon(
    HEADER_ICON,
    '<g transform="scale(1.5625)" fill="none" stroke="currentColor" stroke-width="8" stroke-linecap="butt" stroke-linejoin="round">'
      + '<path d="M4 44 H20 L25.64 38.36"/><path d="M38.36 25.64 L44 20 H60"/><path d="M4 20 H20 L44 44 H60"/>'
      + '</g>',
  );
}

export interface HeaderStatusDeps {
  app: App;
  connection(): ConnectionStatus;
  /** A fresh status lookup for this redraw. */
  statusIndex(): (path: string) => FileStatusView | null;
  /** Others in the active note, by name; the only note presence is known for. */
  peopleInActiveNote(): string[];
  invites(): number;
  readyFolders(): number;
  foldersLine(): string | null;
  /** The shared folder a note is in, or null; `owner` when this account owns it. */
  folderFor(path: string): { owner: boolean } | null;
  places(): StatusPlaces;
  pointers(): { share: boolean; show: boolean };
  setSharePointer(on: boolean): Promise<void>;
  setShowPointers(on: boolean): Promise<void>;
  inspect(path: string): Promise<void>;
  goToPerson(name: string): void;
  openFolderSettings(path: string): void;
  inviteToFolder(path: string): void;
  openSharedWithYou(): void;
  openSettings(): void;
  addRibbon(onClick: (evt: MouseEvent) => void): HTMLElement;
  addStatusBar(): HTMLElement;
}

const TONE_CLASSES: Record<HeaderTone, string> = {
  ok: 'nectenda-header-ok',
  busy: 'nectenda-header-busy',
  offline: 'nectenda-header-offline',
  problem: 'nectenda-header-problem',
  idle: 'nectenda-header-idle',
};

/**
 * Draw the status onto one icon: tone, label, the people number and the
 * waiting dot. The one function every place goes through, which is what keeps
 * the note header, the ribbon and the status bar the same by construction.
 *
 * Writes only what differs. The header sits under wherever the mouse happens
 * to rest, and a page that changes under a still mouse gets a synthetic mouse
 * move from Chromium — which the pointer sharing reads as the person pointing.
 */
export function renderIcon(el: HTMLElement, state: HeaderState): void {
  for (const [tone, cls] of Object.entries(TONE_CLASSES)) {
    if (el.hasClass(cls) !== (tone === state.tone)) el.toggleClass(cls, tone === state.tone);
  }
  if (el.getAttribute('aria-label') !== state.label) el.setAttribute('aria-label', state.label);
  let badge = el.querySelector<HTMLElement>('.nectenda-header-badge');
  if (state.badge) {
    if (!badge) badge = el.createSpan({ cls: 'nectenda-header-badge' });
    if (badge.textContent !== state.badge) badge.setText(state.badge);
  } else {
    badge?.remove();
  }
  const dot = el.querySelector('.nectenda-status-waiting');
  if (state.waiting && !dot) el.createSpan({ cls: 'nectenda-status-waiting' });
  else if (!state.waiting) dot?.remove();
}

/**
 * The views whose header carries the icon: a note, a canvas, a base, a
 * drawing. All are files Nectenda syncs, each in a view of its own, and the
 * setting says "in each note's header" for all of them; it used to be notes
 * only (NEC-210). By view type, since the Excalidraw plugin's view class is
 * not ours.
 */
export const HEADER_VIEW_TYPES: readonly string[] = ['markdown', 'canvas', 'bases', 'excalidraw'];

/** What the header icon needs of a view. */
export interface HeaderView {
  file?: { path: string } | null;
  addAction(icon: string, title: string, callback: (evt: MouseEvent) => unknown): HTMLElement;
  getViewType(): string;
}

/**
 * Whether `view` is one whose header carries the icon. A tab not yet shown
 * since Obsidian started holds a deferred view with no file and no header to
 * add to; it gets its icon once it loads.
 */
export function isHeaderView(view: unknown): view is HeaderView {
  const v = view as Partial<HeaderView> | null | undefined;
  return !!v && typeof v.addAction === 'function' && typeof v.getViewType === 'function'
    && HEADER_VIEW_TYPES.includes(v.getViewType()) && typeof v.file?.path === 'string';
}

/**
 * The Nectenda status, in up to three places: each note's header, the ribbon
 * and the status bar. Which are shown is the person's choice; all of them are
 * the same icon, coloured the same, labelled the same, and open the same menu.
 *
 * The header icon describes its own note. The ribbon and the status bar
 * describe the active note, or only the connection when no note is open —
 * which is why they exist at all: a header needs a note.
 *
 * The header is there on every platform; a phone has no status bar, and keeps
 * its ribbon in a menu.
 */
export class HeaderStatus {
  private actions = new WeakMap<HeaderView, HTMLElement>();
  private views = new Set<HeaderView>();
  private ribbon: HTMLElement | null = null;
  private statusBar: HTMLElement | null = null;

  constructor(private deps: HeaderStatusDeps) {}

  /** Create or remove each place to match the settings, then draw. */
  apply(): void {
    const places = this.deps.places();
    if (!places.header) this.stopHeaders();
    if (places.ribbon && !this.ribbon) {
      this.ribbon = this.deps.addRibbon((evt) => this.openMenu(evt, this.activePath()));
      this.ribbon.addClass('nectenda-status-icon');
    } else if (!places.ribbon && this.ribbon) {
      this.ribbon.remove();
      this.ribbon = null;
    }
    if (places.statusBar && !this.statusBar) {
      const el = this.deps.addStatusBar();
      el.addClass('nectenda-status-icon', 'nectenda-status-bar', 'mod-clickable');
      setIcon(el, HEADER_ICON);
      el.addEventListener('click', (evt) => this.openMenu(evt, this.activePath()));
      this.statusBar = el;
    } else if (!places.statusBar && this.statusBar) {
      this.statusBar.remove();
      this.statusBar = null;
    }
    this.refresh();
  }

  /** The active note, canvas or drawing, if one is. */
  private activeView(): HeaderView | null {
    const view = this.deps.app.workspace.getActiveViewOfType(ItemView);
    return isHeaderView(view) ? view : null;
  }

  private activePath(): string | null {
    return this.activeView()?.file?.path ?? null;
  }

  private stateFor(path: string | null, others: string[], statusOf = this.deps.statusIndex()): HeaderState {
    return headerState({
      connection: this.deps.connection(),
      note: path ? statusOf(path) : null,
      others: others.length,
      invites: this.deps.invites(),
      readyFolders: this.deps.readyFolders(),
      foldersLine: this.deps.foldersLine(),
    });
  }

  refresh(): void {
    const statusOf = this.deps.statusIndex();
    const active = this.activeView();
    const people = this.deps.peopleInActiveNote();
    if (this.deps.places().header) {
      const live = new Set<HeaderView>();
      for (const type of HEADER_VIEW_TYPES) for (const leaf of this.deps.app.workspace.getLeavesOfType(type)) {
        const view: unknown = leaf.view;
        if (!isHeaderView(view)) continue;
        live.add(view);
        const path = view.file?.path ?? null;
        this.renderHeader(view, this.stateFor(path, view === active ? people : [], statusOf));
      }
      // Views closed since the last redraw: the element went with them, but
      // they must not be held.
      for (const v of this.views) if (!live.has(v)) this.views.delete(v);
    }
    if (this.ribbon || this.statusBar) {
      const state = this.stateFor(active?.file?.path ?? null, people, statusOf);
      if (this.ribbon) renderIcon(this.ribbon, state);
      if (this.statusBar) renderIcon(this.statusBar, state);
    }
  }

  private stopHeaders(): void {
    for (const view of this.views) this.actions.get(view)?.remove();
    this.views.clear();
    this.actions = new WeakMap();
  }

  stop(): void {
    this.stopHeaders();
    this.ribbon?.remove();
    this.ribbon = null;
    this.statusBar?.remove();
    this.statusBar = null;
  }

  private renderHeader(view: HeaderView, state: HeaderState): void {
    let el = this.actions.get(view);
    if (!el || !el.isConnected) {
      el = view.addAction(HEADER_ICON, 'Nectenda', (evt) => this.openMenu(evt, view.file?.path ?? null, view));
      el.addClass('nectenda-header-status', 'nectenda-status-icon');
      this.actions.set(view, el);
      this.views.add(view);
    }
    renderIcon(el, state);
  }

  /** The one menu, for any of the three places. `view` is set for a header icon, which speaks for its own note. */
  private openMenu(evt: MouseEvent, path: string | null, view?: HeaderView): void {
    const active = this.activeView();
    const people = !view || view === active ? this.deps.peopleInActiveNote() : [];
    const state = this.stateFor(path, people);
    const folder = path ? this.deps.folderFor(path) : null;
    const menu = new Menu();
    const items = headerMenu(state, {
      pointers: this.deps.pointers(),
      folder,
      people,
      waiting: this.deps.invites() + this.deps.readyFolders(),
    });
    for (const item of items) {
      if (item.kind === 'separator') {
        menu.addSeparator();
      } else if (item.kind === 'label') {
        menu.addItem((i) => i.setTitle(item.title).setIsLabel(true));
      } else if (item.kind === 'toggle') {
        menu.addItem((i) => i.setTitle(item.title).setChecked(item.checked).onClick(() => {
          void (item.id === 'share-pointer'
            ? this.deps.setSharePointer(!item.checked)
            : this.deps.setShowPointers(!item.checked));
        }));
      } else if (item.kind === 'person') {
        menu.addItem((i) => i.setTitle(item.title).setIcon('user').onClick(() => this.deps.goToPerson(item.name)));
      } else {
        const icons: Record<typeof item.id, string> = {
          inspect: 'activity', settings: 'settings', 'shared-with-you': 'inbox', 'folder-settings': 'folder-cog', invite: 'user-plus',
        };
        menu.addItem((i) => i.setTitle(item.title).setIcon(icons[item.id]).onClick(() => {
          if (item.id === 'inspect' && path) void this.deps.inspect(path);
          else if (item.id === 'folder-settings' && path) this.deps.openFolderSettings(path);
          else if (item.id === 'invite' && path) this.deps.inviteToFolder(path);
          else if (item.id === 'shared-with-you') this.deps.openSharedWithYou();
          else if (item.id === 'settings') this.deps.openSettings();
        }));
      }
    }
    menu.showAtMouseEvent(evt);
  }
}
