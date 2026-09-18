/**
 * Turning a shared folder's file name into a vault path, safely.
 *
 * A name in a folder's listing is not this vault's. It is whatever another
 * member called a file, carried here by the CRDT, and until this existed the
 * sync layer turned it into a path by concatenation and handed the result
 * straight to the vault:
 *
 *     const localFilePath = `${conn.localPath}/${key}`;
 *
 * Nothing asked whether the result was still inside the folder the user chose
 * to share. `path-containment.test.ts` recorded what that allowed: a name of
 * `../../.obsidian/plugins/nectenda/main.js` reached `vault.create` unaltered,
 * as did a `createFolder` for the directory holding this plugin's own code.
 *
 * **Obsidian's `normalizePath` does not do this job.** It cleans up slashes,
 * strips leading and trailing ones and runs the string through
 * `String.prototype.normalize` — it does not resolve `..`, so a path can come
 * out of it tidy and still point somewhere else entirely. It is applied at the
 * Obsidian boundary in `obsidian-vault.ts` because the guidelines ask for it
 * and it is right for the separator and unicode handling; containment is a
 * separate question and is answered here.
 *
 * Deliberately free of any `obsidian` import, like the rest of the sync layer,
 * so it can be driven under vitest.
 */

/**
 * `folderLocalPath` joined with `relativePath`, or null if that escapes.
 *
 * Null is a refusal, not an error: the caller skips the entry and says so. The
 * alternative — clamping the path back inside the folder — would write a file
 * somebody else named to a place nobody chose, which is a worse answer than
 * declining to act on it.
 */
export function joinWithin(folderLocalPath: string, relativePath: string): string | null {
  // Backslashes first: a name written on Windows, or chosen to exploit the
  // difference, must not reach the segment check still spelled `..\..`.
  const cleaned = relativePath.replace(/\\/g, '/');

  // An absolute path is never relative to anything, whatever its segments say.
  if (cleaned.startsWith('/')) return null;

  const segments: string[] = [];
  for (const segment of cleaned.split('/')) {
    // Empty segments come from `a//b` and from a trailing slash; `.` is a
    // no-op. Neither is hostile, and both are dropped rather than refused.
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      // Refuse rather than pop. Popping would silently accept `a/../b`, and a
      // listing entry has no business describing a path that walks upward at
      // all — every legitimate one names a file beneath the folder.
      return null;
    }
    segments.push(segment);
  }

  if (segments.length === 0) return null;
  return `${folderLocalPath}/${segments.join('/')}`;
}

/**
 * Whether `path` is inside `folderLocalPath`.
 *
 * For paths already built, where the question is containment rather than
 * construction. The trailing slash matters: without it `Shared2/x` counts as
 * inside `Shared`.
 */
export function isWithin(folderLocalPath: string, path: string): boolean {
  return path.startsWith(`${folderLocalPath}/`) && !path.split('/').includes('..');
}
