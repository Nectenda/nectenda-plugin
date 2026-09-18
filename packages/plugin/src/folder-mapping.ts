export interface FolderMapping {
  sharedFolderId: string;
  sharedFolderName: string;
  localPath: string;
  /**
   * What this account may do in the folder, as the server last reported it.
   *
   * Every member may edit; `owner` adds only the ability to change membership.
   * Shown in settings, and not otherwise acted on by the client — the server is
   * the boundary.
   */
  role?: 'owner' | 'editor';
  /**
   * The organisation this folder belongs to, on Nectenda Cloud: the
   * membership id (`shardId:accountId`), which names the sync server as well.
   * Absent on a self-hosted server, where there is exactly one.
   */
  membershipId?: string;
}

/**
 * The last segment of a vault path.
 *
 * A folder's shared name is its own name, not where it sits: `shareFolder`
 * seals `folder.name` rather than `folder.path`, so a rename of a nested
 * mapping has to publish the same shape or the name would gain a directory
 * prefix that `sealFolderName` rejects for containing a separator.
 */
export function basenameOf(path: string): string {
  return path.split('/').filter(Boolean).at(-1) ?? path;
}

/**
 * The mapping whose root *is* this path, if any.
 *
 * `resolveMapping` deliberately answers null for a mapping's own root — it
 * resolves files, and the root is not one. That left renaming a mapped folder
 * matching nothing at all: the rename was ignored, `localPath` kept pointing at
 * a path that no longer existed, and every file beneath the new name silently
 * stopped syncing while the settings row still showed the old location.
 *
 * Separate from `resolveMapping` rather than folded into it, because every
 * caller of that one wants a file and would have to start excluding roots.
 */
export function mappingRootedAt(
  path: string,
  mappings: FolderMapping[],
): FolderMapping | null {
  return mappings.find((m) => m.localPath === path) ?? null;
}

/**
 * Which shared folder a vault path belongs to, and where within it.
 *
 * Pure path arithmetic, kept apart from the editor so the sync layer can use it
 * without importing Obsidian. It previously lived in editor-bridge, which meant
 * ContentSync and VaultWatcher pulled the whole editor — and Obsidian — in with
 * it, and could not be loaded in tests.
 */
export function resolveMapping(
  filePath: string,
  mappings: FolderMapping[],
): { sharedFolderId: string; relativePath: string } | null {
  for (const mapping of mappings) {
    if (filePath === mapping.localPath || filePath.startsWith(mapping.localPath + '/')) {
      const relativePath = filePath.slice(mapping.localPath.length + 1);
      if (relativePath.length > 0) {
        return { sharedFolderId: mapping.sharedFolderId, relativePath };
      }
    }
  }
  return null;
}

/**
 * The mapping already covering a vault path, if any: the same path, a
 * parent of it, or a child inside it — on a `/` boundary, so `Shared2` is
 * not covered by `Shared`.
 *
 * A folder belongs to one organisation. A second share of a mapped path used
 * to replace the first mapping silently, and a share nested inside a mapped
 * folder would route the same files twice through `resolveMapping`'s first
 * match; both are refused instead, naming what is in the way.
 */
export function mappingCovering(path: string, mappings: FolderMapping[]): FolderMapping | null {
  for (const m of mappings) {
    if (path === m.localPath) return m;
    if (path.startsWith(m.localPath + '/')) return m;
    if (m.localPath.startsWith(path + '/')) return m;
  }
  return null;
}
