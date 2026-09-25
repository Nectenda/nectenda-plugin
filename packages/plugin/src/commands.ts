import type { FolderMapping } from './folder-mapping';
import { mappingCovering, mappingRootedAt } from './folder-mapping';
import type { StoredMembership } from './cloud-session';

/**
 * What the command palette, the ribbon and the file-explorer menu offer, and
 * when.
 *
 * Decisions only, with no Obsidian runtime import, so the rules can be tested
 * without a vault. `main.ts` does the registering and carries each command
 * out through the same code the settings pane uses: a command is another way
 * to reach an action, never a second copy of it.
 *
 * There is no sign-out command, on purpose. Signing out removes every folder
 * mapping, and a palette entry is reached by fuzzy matching — too easy to hit
 * for something with that reach. It stays a button in settings.
 */

export const COMMAND_IDS = [
  'open-settings',
  'share-folder',
  'show-folder-members',
  'copy-share-link',
  'enter-passphrase',
  'toggle-diagnostic-log',
] as const;
export type CommandId = (typeof COMMAND_IDS)[number];

export const COMMAND_NAMES: Record<CommandId, string> = {
  'open-settings': 'Open settings',
  'share-folder': 'Share a folder…',
  'show-folder-members': 'Show members of a shared folder…',
  'copy-share-link': "Copy an organisation's share link",
  'enter-passphrase': 'Enter passphrase',
  'toggle-diagnostic-log': 'Toggle diagnostic log',
};

export interface CommandState {
  signedIn: boolean;
  mode: 'cloud' | 'self-hosted';
  /** Signed in, but the identity key is not open on this device (`isLocked`). */
  locked: boolean;
  /**
   * An encryption public key is enrolled. Sharing seals the new folder's keys
   * to it; without one the pane's share creates a folder nobody can decrypt,
   * so the command is not offered until the passphrase is set.
   */
  hasKeys: boolean;
  mappings: FolderMapping[];
  memberships: Array<Pick<StoredMembership, 'id' | 'role'>>;
}

/** Organisations whose share link this account may reveal. */
export function shareLinkMemberships<M extends Pick<StoredMembership, 'role'>>(memberships: M[]): M[] {
  return memberships.filter((m) => m.role === 'owner' || m.role === 'admin');
}

/** Mapped folders whose members this vault may manage. */
export function ownedMappings(mappings: FolderMapping[]): FolderMapping[] {
  return mappings.filter((m) => m.role === 'owner');
}

/** May a new folder be shared at all: signed in, keys enrolled, somewhere to share it. */
function mayShare(s: CommandState): boolean {
  return s.signedIn && s.hasKeys && (s.mode === 'self-hosted' || s.memberships.length > 0);
}

/** Whether the palette should offer a command right now (its `checkCallback`). */
export function commandAvailable(id: CommandId, s: CommandState): boolean {
  switch (id) {
    case 'open-settings':
    case 'toggle-diagnostic-log':
      return true;
    case 'share-folder':
      return mayShare(s);
    case 'show-folder-members':
      return s.signedIn && ownedMappings(s.mappings).length > 0;
    case 'copy-share-link':
      return s.signedIn && s.mode === 'cloud' && shareLinkMemberships(s.memberships).length > 0;
    case 'enter-passphrase':
      return s.locked;
  }
}

export type FolderMenuItem = 'share' | 'members';

/**
 * What each item reads as in the menu. Every one leads with "Nectenda: ", so
 * among other plugins' items they read as one set, and it is plain whose they
 * are — the way Relay labels its own.
 */
export const FOLDER_MENU_TITLES: Record<FolderMenuItem, string> = {
  share: 'Nectenda: Share folder…',
  members: 'Nectenda: Show members…',
};

/**
 * What a right-click on a vault folder offers.
 *
 * Share only where the pane's own share would not refuse: a folder that is
 * shared already, or sits inside or around one, is covered by a mapping, and
 * offering the item only to answer "already shared" would be a trap.
 * Members only on the root of a folder this vault owns, which is where the
 * pane's Members button is.
 */
export function folderMenuItems(path: string, s: CommandState): FolderMenuItem[] {
  if (!path || path === '/') return [];
  const items: FolderMenuItem[] = [];
  if (mayShare(s) && !mappingCovering(path, s.mappings)) items.push('share');
  const rooted = mappingRootedAt(path, s.mappings);
  if (s.signedIn && rooted?.role === 'owner') items.push('members');
  return items;
}

/**
 * The owned folder a note belongs to, so "show members" can skip the picker
 * when the answer is obvious from what is open.
 */
export function ownedMappingFor(filePath: string | null, mappings: FolderMapping[]): FolderMapping | null {
  if (!filePath) return null;
  return ownedMappings(mappings).find((m) => filePath.startsWith(m.localPath + '/')) ?? null;
}

export type ShareLink = { enabled: true; link: string } | { enabled: false };

/**
 * An organisation's share link, as `obsidian://nectenda?key=…&endpoint=…`.
 *
 * Shared by the pane's "Share link" button and the command, so the two cannot
 * drift into copying different links. `fetch` is the pane's `apiFetch`, which
 * handles a refused session; a non-OK answer throws.
 */
export async function shareLinkFor(
  membership: Pick<StoredMembership, 'endpoint'>,
  server: { base: string; token: string },
  fetch: (url: string, init?: RequestInit) => Promise<Response>,
): Promise<ShareLink> {
  const res = await fetch(`${server.base}/account/share-key`, { headers: { Authorization: `Bearer ${server.token}` } });
  if (!res.ok) throw new Error('The server did not reveal the share key');
  const { shareKey, enabled } = (await res.json()) as { shareKey: string; enabled: boolean };
  if (!enabled) return { enabled: false };
  return {
    enabled: true,
    link: `obsidian://nectenda?key=${encodeURIComponent(shareKey)}&endpoint=${encodeURIComponent(membership.endpoint)}`,
  };
}
