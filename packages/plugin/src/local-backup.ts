import type { VaultAdapter } from './vault-adapter';
import { log } from './logger';

/** Dot-prefixed so Obsidian hides it from the file explorer by default. */
export const BACKUP_FOLDER = '.nectenda-backups';

/**
 * Copy local content aside before sync overwrites it.
 *
 * Timestamped so repeated conflicts cannot collide, and kept inside the vault
 * so Obsidian can open it. The folder is dot-prefixed, which keeps it out of
 * the file explorer by default without hiding it from search or the file
 * system.
 *
 * Shared by text and structured sync, so that the one guarantee that matters
 * here — a backup never replaces a backup — is written and tested once.
 * Failures are logged, not thrown: the caller is about to write, and a backup
 * that could not be made must be loud in the log without also stopping sync.
 */
export async function backupLocalFile(
  vault: VaultAdapter,
  localPath: string,
  content: string,
  reason = 'First sync found different content on both sides — backed up the local copy',
): Promise<void> {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  // A backup that overwrites a backup is a lost version, which is the exact
  // thing this function exists to prevent. `toISOString` is millisecond
  // granular, so two backups of one path inside the same millisecond produced
  // the same path and the second silently replaced the first — and that is
  // not hypothetical: it happens on every run of the test for it, which is why
  // "checks once per connection" could not fail. Suffix rather than a finer
  // clock: the guarantee wanted here is "never overwrite", and asking the
  // vault is the only thing that actually promises it.
  let backupPath = `${BACKUP_FOLDER}/${stamp}/${localPath}`;
  for (let n = 2; vault.exists(backupPath); n++) {
    const dot = localPath.lastIndexOf('.');
    const slash = localPath.lastIndexOf('/');
    const [stem, ext] = dot > slash ? [localPath.slice(0, dot), localPath.slice(dot)] : [localPath, ''];
    backupPath = `${BACKUP_FOLDER}/${stamp}/${stem} (${n})${ext}`;
  }

  try {
    const dir = backupPath.slice(0, backupPath.lastIndexOf('/'));
    await vault.createFolder(dir);
    await vault.write(backupPath, content);
    log.warn(reason, { path: localPath, backup: backupPath });
  } catch (err) {
    log.error('Failed to back up local content before first sync', {
      path: localPath,
      error: String(err),
    });
  }
}

/**
 * Write local content as a sibling conflict copy, returning its path or null.
 *
 * Named after Dropbox's convention because the situation is the same and the
 * name is already familiar. Deliberately a sibling file rather than a trashed
 * or backed-up one: the user has to be able to see that their work survived,
 * and both `.trash` and `.nectenda-backups` are easy to miss.
 */
/** Extensions of more than one part, kept whole when a copy is named. */
const COMPOUND_EXTENSIONS = ['.excalidraw.md'];

export async function writeConflictCopy(
  vault: VaultAdapter,
  localPath: string,
  content: string,
): Promise<string | null> {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const slash = localPath.lastIndexOf('/');
  // A compound extension stays whole, so a drawing's copy is still a drawing:
  // `Drawing (conflicted copy …).excalidraw.md`, which the Excalidraw plugin
  // opens, rather than `Drawing.excalidraw (conflicted copy …).md` (NEC-41).
  const compound = COMPOUND_EXTENSIONS.find((e) => localPath.toLowerCase().endsWith(e) && localPath.length - e.length > slash + 1);
  const dot = compound ? localPath.length - compound.length : localPath.lastIndexOf('.');
  const base = dot > slash ? localPath.slice(0, dot) : localPath;
  const ext = dot > slash ? localPath.slice(dot) : '';
  // Same never-overwrite rule as the backups: two copies of one file in the
  // same millisecond must both survive.
  let copyPath = `${base} (conflicted copy ${stamp})${ext}`;
  for (let n = 2; vault.exists(copyPath); n++) {
    copyPath = `${base} (conflicted copy ${stamp} ${n})${ext}`;
  }
  try {
    await vault.create(copyPath, content);
    return copyPath;
  } catch (err) {
    log.error('Failed to save conflict copy', { path: copyPath, error: String(err) });
    return null;
  }
}
