import type { FolderMapping } from './folder-mapping';

/**
 * Which of the vault's mappings an organisation's page may call its own.
 *
 * A page lists one server's folders, and the mappings drawn beside them must
 * be that server's too: a folder mapped from another organisation is not an
 * orphan here, it is simply somebody else's. A mapping made before folders
 * remembered their organisation carries no membership id; it belongs to the
 * page whose listing holds its folder, and on a self-hosted server — where
 * there is exactly one — to the only page there is.
 */
export function mappingBelongsTo(
  m: FolderMapping,
  server: { membershipId: string | null },
  listedIds: Set<string>,
): boolean {
  if (server.membershipId === null) return true;
  if (m.membershipId) return m.membershipId === server.membershipId;
  return listedIds.has(m.sharedFolderId);
}

export interface FolderPartition<F extends { id: string }> {
  /** Mapped and listed, but this device holds no key: looks connected, syncs nothing. */
  keyless: FolderMapping[];
  /** Mapped here, but the server no longer lists the folder. */
  orphans: FolderMapping[];
  mapped: F[];
  unmapped: F[];
}

/** The four groups the page draws, from one server's listing and the vault's mappings. */
export function partitionFolders<F extends { id: string }>(input: {
  folders: F[];
  mappings: FolderMapping[];
  server: { membershipId: string | null };
  hasKeys: (folderId: string) => boolean;
}): FolderPartition<F> {
  const listedIds = new Set(input.folders.map((f) => f.id));
  const mine = input.mappings.filter((m) => mappingBelongsTo(m, input.server, listedIds));
  const mappedIds = new Set(mine.map((m) => m.sharedFolderId));
  return {
    keyless: mine.filter((m) => listedIds.has(m.sharedFolderId) && !input.hasKeys(m.sharedFolderId)),
    orphans: mine.filter((m) => !listedIds.has(m.sharedFolderId)),
    mapped: input.folders.filter((f) => mappedIds.has(f.id)),
    unmapped: input.folders.filter((f) => !mappedIds.has(f.id)),
  };
}

/**
 * How many folders an organisation syncs in this vault, for its entry on the
 * home pane. With one organisation, a mapping that never learned its
 * organisation is counted as its own, as `serverFor` treats it.
 */
export function foldersSyncedFor(membershipId: string, mappings: Array<{ membershipId?: string }>, membershipCount: number): number {
  return mappings.filter((m) => m.membershipId === membershipId || (!m.membershipId && membershipCount === 1)).length;
}

/**
 * Mappings no organisation's page can claim: made before mappings named their
 * organisation, in a vault that now belongs to several. They still route
 * files, so they are listed on the home pane to be unmapped, never dropped.
 */
export function unclaimedMappings<M extends { membershipId?: string }>(mappings: M[], membershipCount: number): M[] {
  return membershipCount > 1 ? mappings.filter((m) => !m.membershipId) : [];
}

/**
 * Whether this person may unshare the folder — which the server decides, so
 * this has to agree with it or the button lies in one direction or the other.
 *
 * An owner may. So may the folder's creator, even where a later role change
 * has taken their ownership away: the server has always allowed the creator,
 * and on 14 September a folder was found whose only owner had been demoted to
 * editor by an ordinary add, leaving its creator unable to end a folder
 * nobody else could administer either.
 */
export function mayUnshare(
  folder: { role?: string; createdBy?: string; createdByUsername?: string },
  viewer: { localUserId?: string | null; localUsername?: string | null },
): boolean {
  if (folder.role === 'owner') return true;
  if (viewer.localUserId && folder.createdBy === viewer.localUserId) return true;
  // Self-hosted: the vault knows the name it logged in with, not its row id.
  if (viewer.localUsername && folder.createdByUsername === viewer.localUsername) return true;
  return false;
}
