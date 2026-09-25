import { addIcon, MarkdownView, Menu, type App } from 'obsidian';
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
}

export interface HeaderState {
  tone: HeaderTone;
  /** For the tooltip and `aria-label`: the whole status, in words. */
  label: string;
  /** Text for the corner badge, or null for none. */
  badge: string | null;
}

const PROBLEMS = new Set<ConnectionStatus>(['device-limit', 'suspended', 'update-required', 'signed-out']);
const AWAY = new Set<ConnectionStatus>(['disconnected', 'offline', 'restarting', 'moving']);

export function headerState(input: HeaderInput): HeaderState {
  const { connection, note, others, invites } = input;

  let tone: HeaderTone;
  if (PROBLEMS.has(connection)) tone = 'problem';
  else if (AWAY.has(connection)) tone = 'offline';
  else if (connection === 'idle') tone = 'idle';
  else if (!note || note.status === 'confirmed') tone = 'ok';
  else if (note.status === 'error') tone = 'problem';
  else if (note.status === 'offline') tone = 'offline';
  else tone = 'busy';

  const lines = [`Nectenda: ${CONNECTION_LABELS[connection]}`];
  lines.push(note ? note.label : 'This note is not in a shared folder');
  if (others === 1) lines.push('1 other person has this note open');
  else if (others > 1) lines.push(`${others} other people have this note open`);
  if (invites > 0) lines.push(`${invites} invitation${invites === 1 ? '' : 's'} waiting`);

  // Others only, and nothing at all when it is just you: a number should
  // always mean somebody else is here.
  const badge = others > 0 ? (others > 9 ? '9+' : String(others)) : null;
  return { tone, label: lines.join('\n'), badge };
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
  | { kind: 'action'; id: 'inspect' | 'settings'; title: string }
  | { kind: 'separator' };

export function headerMenu(state: HeaderState, pointers: { share: boolean; show: boolean }, inSharedFolder: boolean): HeaderMenuItem[] {
  const items: HeaderMenuItem[] = [];
  for (const line of state.label.split('\n')) items.push({ kind: 'label', title: line });
  items.push({ kind: 'separator' });
  items.push({ kind: 'toggle', id: 'share-pointer', title: 'Share my mouse pointer', checked: pointers.share });
  items.push({ kind: 'toggle', id: 'show-pointers', title: "Show collaborators' mouse pointers", checked: pointers.show });
  items.push({ kind: 'separator' });
  if (inSharedFolder) items.push({ kind: 'action', id: 'inspect', title: 'Inspect sync state' });
  items.push({ kind: 'action', id: 'settings', title: 'Open Nectenda settings' });
  return items;
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
  /** Others in the active note; the only note presence is known for. */
  othersInActiveNote(): number;
  invites(): number;
  pointers(): { share: boolean; show: boolean };
  setSharePointer(on: boolean): Promise<void>;
  setShowPointers(on: boolean): Promise<void>;
  inspect(path: string): Promise<void>;
  openSettings(): void;
}

const TONE_CLASSES: Record<HeaderTone, string> = {
  ok: 'nectenda-header-ok',
  busy: 'nectenda-header-busy',
  offline: 'nectenda-header-offline',
  problem: 'nectenda-header-problem',
  idle: 'nectenda-header-idle',
};

/**
 * The Nectenda icon at the top right of every open note.
 *
 * It replaced the status-bar text, which mobile never had: Obsidian on a phone
 * has no status bar, so a person there had no way to see whether anything was
 * syncing. One action per Markdown view, kept in a WeakMap so a closed view
 * takes its entry with it.
 */
export class HeaderStatus {
  private actions = new WeakMap<MarkdownView, HTMLElement>();
  private views = new Set<MarkdownView>();

  constructor(private deps: HeaderStatusDeps) {}

  refresh(): void {
    const statusOf = this.deps.statusIndex();
    const active = this.deps.app.workspace.getActiveViewOfType(MarkdownView);
    const live = new Set<MarkdownView>();
    for (const leaf of this.deps.app.workspace.getLeavesOfType('markdown')) {
      const view = leaf.view;
      if (!(view instanceof MarkdownView)) continue;
      live.add(view);
      const path = view.file?.path ?? null;
      const note = path ? statusOf(path) : null;
      const state = headerState({
        connection: this.deps.connection(),
        note,
        others: view === active ? this.deps.othersInActiveNote() : 0,
        invites: this.deps.invites(),
      });
      this.render(view, state);
    }
    // Views closed since the last redraw: nothing to remove, the element went
    // with them, but they must not be held.
    for (const v of this.views) if (!live.has(v)) this.views.delete(v);
  }

  stop(): void {
    for (const view of this.views) this.actions.get(view)?.remove();
    this.views.clear();
    this.actions = new WeakMap();
  }

  /**
   * Writes only what differs, like the explorer marks. The header sits under
   * wherever the mouse happens to rest, and a page that changes under a still
   * mouse gets a synthetic mouse move from Chromium — which the pointer
   * sharing reads as the person pointing. A redraw that rewrote identical
   * attributes on every keystroke's status change was churn with a cost.
   */
  private render(view: MarkdownView, state: HeaderState): void {
    let el = this.actions.get(view);
    if (!el || !el.isConnected) {
      el = view.addAction(HEADER_ICON, 'Nectenda', (evt) => this.openMenu(evt, view));
      el.addClass('nectenda-header-status');
      this.actions.set(view, el);
      this.views.add(view);
    }
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
  }

  private openMenu(evt: MouseEvent, view: MarkdownView): void {
    const path = view.file?.path ?? null;
    const note = path ? this.deps.statusIndex()(path) : null;
    const state = headerState({
      connection: this.deps.connection(),
      note,
      others: view === this.deps.app.workspace.getActiveViewOfType(MarkdownView) ? this.deps.othersInActiveNote() : 0,
      invites: this.deps.invites(),
    });
    const menu = new Menu();
    for (const item of headerMenu(state, this.deps.pointers(), note !== null)) {
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
      } else {
        menu.addItem((i) => i.setTitle(item.title).setIcon(item.id === 'inspect' ? 'activity' : 'settings').onClick(() => {
          if (item.id === 'inspect' && path) void this.deps.inspect(path);
          else if (item.id === 'settings') this.deps.openSettings();
        }));
      }
    }
    menu.showAtMouseEvent(evt);
  }
}
