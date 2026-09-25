import { log } from './logger';
import { TFile, TFolder, normalizePath, type Vault } from 'obsidian';
import type { VaultAdapter } from './vault-adapter';

/**
 * The real vault, kept apart from the interface and the fake on purpose.
 *
 * The `obsidian` package ships types with no runtime, so anything importing it
 * cannot be loaded under vitest. Isolating that import here means the sync layer
 * and `FakeVault` stay testable without Obsidian or a module alias.
 */
/**
 * A vault operation that failed, with the path kept out of the message.
 *
 * `throw new Error(\`Not a file: ${path}\`)` reaches a stack trace, and a
 * stack trace is what a crash report is made of — so a call site that never
 * handled a path could still ship one. The scrubber catches a path with a
 * known extension; it cannot catch an extensionless folder name, and no
 * regular expression can, because "Q3 layoffs" is indistinguishable from
 * prose.
 *
 * So the path travels as a field. The diagnostic log still prints it, because
 * that file is local and exists to say which note failed; the report gets the
 * message alone.
 */
export class VaultPathError extends Error {
  constructor(
    message: string,
    readonly path: string,
  ) {
    super(message);
    this.name = 'VaultPathError';
  }
}

export class ObsidianVaultAdapter implements VaultAdapter {
  private vault: Vault;

  constructor(vault: Vault) {
    this.vault = vault;
  }

  /**
   * Every path entering the real vault, tidied the way Obsidian expects.
   *
   * `normalizePath` settles separators, leading and trailing slashes and
   * unicode form — the things that make two spellings of the same path fail to
   * match. Applied here, at the one boundary, rather than at each of the
   * fifteen call sites above it.
   *
   * It is **not** a containment check and must not be mistaken for one: it does
   * not resolve `..`, so a path can come out of it tidy and still point outside
   * the folder it claimed to be in. That question is answered before a path
   * gets this far, in `vault-path.ts`.
   */
  private n(path: string): string {
    return normalizePath(path);
  }

  listMarkdown(folderPath: string): string[] {
    const folder = this.vault.getAbstractFileByPath(this.n(folderPath));
    if (!(folder instanceof TFolder)) return [];

    const out: string[] = [];
    const walk = (f: TFolder): void => {
      for (const child of f.children) {
        if (child instanceof TFile && child.extension === 'md') out.push(child.path);
        else if (child instanceof TFolder) walk(child);
      }
    };
    walk(folder);
    return out;
  }

  exists(path: string): boolean {
    return this.vault.getAbstractFileByPath(this.n(path)) !== null;
  }

  isFile(path: string): boolean {
    return this.vault.getAbstractFileByPath(this.n(path)) instanceof TFile;
  }

  isFolder(path: string): boolean {
    return this.vault.getAbstractFileByPath(this.n(path)) instanceof TFolder;
  }

  async read(path: string): Promise<string> {
    const file = this.vault.getAbstractFileByPath(this.n(path));
    if (!(file instanceof TFile)) throw new VaultPathError('Not a file', path);
    return this.vault.read(file);
  }

  /**
   * Replace a file's contents.
   *
   * `process` rather than `modify`, which is what this used before. The two
   * differ in exactly the way that matters here: `process` reads and writes
   * under one lock, so a concurrent writer — another plugin, or another of our
   * own paths — cannot land between our read and our write and lose an edit.
   * `modify` has no such guarantee, and this is the call every incoming remote
   * change goes through. The content we write is computed upstream, so the
   * callback ignores what it is handed; the atomicity is the point, not the
   * merge.
   */
  async write(path: string, content: string): Promise<void> {
    const file = this.vault.getAbstractFileByPath(this.n(path));
    if (file instanceof TFile) {
      await this.vault.process(file, () => content);
      return;
    }
    await this.create(path, content);
  }

  async create(path: string, content: string): Promise<void> {
    await this.vault.create(this.n(path), content);
  }

  /**
   * Creates intermediate folders too. Obsidian's createFolder does not, and the
   * backup path is several levels deep, so a single call would fail on the
   * first missing parent.
   */
  async createFolder(path: string): Promise<void> {
    const parts = path.split('/');
    for (let i = 1; i <= parts.length; i++) {
      const partial = parts.slice(0, i).join('/');
      if (partial === '' || this.exists(partial)) continue;
      try {
        await this.vault.createFolder(partial);
      } catch {
        // Raced with another creator, or it already exists — either is fine.
      }
    }
  }

  async rename(from: string, to: string): Promise<void> {
    const file = this.vault.getAbstractFileByPath(from);
    if (!file) throw new VaultPathError('Cannot rename: not found', from);
    await this.vault.rename(file, to);
  }

  async trash(path: string): Promise<void> {
    const file = this.vault.getAbstractFileByPath(this.n(path));
    if (!file) return;
    // `false` is the vault's own .trash. The system trash was tried and proved
    // useless: a file removed that way was not recoverable from it at all.
    //
    // Which is also why the review's suggestion of `FileManager.trashFile()` is
    // declined here: it follows the user's preference, and one of the available
    // preferences is the system trash that was already shown not to work, while
    // another is permanent deletion. This path runs for deletions arriving from
    // other vaults, so it has to be the one that keeps the bytes.
    await this.vault.trash(file, false);
  }

  /**
   * Every file under `folderPath`, whatever its extension.
   *
   * Walks the vault index like `listMarkdown`, which means dot-directories are
   * excluded for free — `.obsidian`, `.trash` and `.nectenda-backups` are not
   * in the index. Do not be tempted to swap this for `adapter.list()`: that
   * does see them, and would start syncing the plugin's own configuration.
   */
  listFiles(folderPath: string): string[] {
    const folder = this.vault.getAbstractFileByPath(this.n(folderPath));
    if (!(folder instanceof TFolder)) return [];

    const out: string[] = [];
    const walk = (f: TFolder): void => {
      for (const child of f.children) {
        if (child instanceof TFile) out.push(child.path);
        else if (child instanceof TFolder) walk(child);
      }
    };
    walk(folder);
    return out;
  }

  async readBinary(path: string): Promise<Uint8Array> {
    const file = this.vault.getAbstractFileByPath(this.n(path));
    if (!(file instanceof TFile)) throw new VaultPathError('No such file', path);
    return new Uint8Array(await this.vault.readBinary(file));
  }

  /**
   * Stream a file's bytes without materialising it.
   *
   * `getResourcePath` hands back a URL the platform serves natively, and
   * fetching it yields a real ReadableStream — measured on desktop and on
   * Android, where the response carries no Content-Length, so sizes must come
   * from `stat()`.
   *
   * Falls back to a single whole-file read if anything about that is missing.
   * The fallback is not merely defensive: only desktop has been measured, and
   * CapacitorAdapter serves these URLs through a different handler that has
   * never been tested. Better to use more memory than to fail to read a file.
   */
  async *readBinaryChunks(path: string): AsyncGenerator<Uint8Array> {
    try {
      const res = await fetch(this.vault.adapter.getResourcePath(path));
      if (res.ok && res.body) {
        const reader = res.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) yield value;
        }
        return;
      }
      log.warn('Resource stream unavailable; falling back to a whole-file read', {
        path, status: res.status,
      });
    } catch (err) {
      log.warn('Resource stream failed; falling back to a whole-file read', {
        path, error: String(err),
      });
    }
    yield await this.readBinary(path);
  }

  async writeBinary(path: string, data: Uint8Array): Promise<void> {
    const file = this.vault.getAbstractFileByPath(this.n(path));
    if (!(file instanceof TFile)) throw new VaultPathError('No such file', path);
    // `data.buffer` would hand over the whole backing store when the view is a
    // subarray, which silently writes more than was asked for.
    await this.vault.modifyBinary(file, toArrayBuffer(data));
  }

  async createBinary(path: string, data: Uint8Array): Promise<void> {
    await this.vault.createBinary(this.n(path), toArrayBuffer(data));
  }

  stat(path: string): { size: number; mtime: number } | null {
    const file = this.vault.getAbstractFileByPath(this.n(path));
    if (!(file instanceof TFile)) return null;
    return { size: file.stat.size, mtime: file.stat.mtime };
  }
}

/** Copy out exactly the bytes a view covers, never its whole backing buffer. */
function toArrayBuffer(data: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(data.byteLength);
  new Uint8Array(out).set(data);
  return out;
}
