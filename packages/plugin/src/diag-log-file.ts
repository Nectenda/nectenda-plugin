/**
 * The diagnostic log's file: one for this session, and the one before it.
 *
 * A session used to start by writing a fresh file over the last, so a reload
 * of the plugin — whatever caused it — wiped the record of what had happened
 * just before it, which is usually the thing being diagnosed. Seen while
 * testing live Excalidraw drawings: a merge decision at one time, a reload of
 * both vaults twenty minutes later, and no trace left of why the merge had
 * decided as it did. Now the last file is kept, as `diag.prev.log`, and only
 * one: a log someone can leave on must not grow without bound.
 */

/** What of the vault adapter the log file needs. */
export interface LogFileAdapter {
  exists(path: string): Promise<boolean>;
  remove(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  write(path: string, data: string): Promise<void>;
}

/** The previous session's log, beside `path` (`…/diag.log` → `…/diag.prev.log`). */
export function previousLogPath(path: string): string {
  return path.replace(/\.log$/, '') + '.prev.log';
}

/**
 * Start a new file at `path` with `header`, keeping what was there as the
 * previous one, which replaces any older previous one.
 */
export async function rollLogFile(adapter: LogFileAdapter, path: string, header: string): Promise<void> {
  const prev = previousLogPath(path);
  if (await adapter.exists(path)) {
    if (await adapter.exists(prev)) await adapter.remove(prev);
    await adapter.rename(path, prev);
  }
  await adapter.write(path, header);
}
