/**
 * The vault operations the sync layer needs.
 *
 * ContentSync, FileSync and VaultWatcher previously reached straight into
 * `plugin.app.vault`, which made them impossible to test outside Obsidian. Every
 * bug found during offline testing lived in exactly that interaction — which
 * file exists when, who owns a write, what order things happen in at startup —
 * and none of it was reachable by protocol-level tests against the server.
 *
 * The surface is deliberately narrow: paths in, strings out, no Obsidian types.
 * `FakeVault` implements the same interface in memory, so the sync layer can be
 * driven under vitest with no Obsidian at all.
 */
export interface VaultAdapter {
  /** Vault-relative path of every Markdown file under `folderPath`, recursively. */
  listMarkdown(folderPath: string): string[];
  /**
   * Every file under `folderPath`, whatever its extension.
   *
   * `listMarkdown` stays alongside this rather than being replaced: ContentSync
   * still wants text only, and 199 tests are written against it. Two callers
   * with genuinely different needs are not duplication.
   */
  listFiles(folderPath: string): string[];
  exists(path: string): boolean;
  isFile(path: string): boolean;
  isFolder(path: string): boolean;
  read(path: string): Promise<string>;
  /** Create the file, or overwrite it if it already exists. */
  write(path: string, content: string): Promise<void>;
  create(path: string, content: string): Promise<void>;
  createFolder(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  /** Move to the vault's own .trash, never the system trash — see FileSync. */
  trash(path: string): Promise<void>;
  /** File size and mtime, for the meta document's listing. */
  stat(path: string): { size: number; mtime: number } | null;

  // Binary surface, for attachments. Kept separate from the text methods
  // because the failure modes differ: reading a PNG as a string is a lossy
  // UTF-8 decode that silently corrupts it, and that is exactly the bug an
  // older client hits when it meets an attachment it was never meant to see.
  readBinary(path: string): Promise<Uint8Array>;
  /**
   * The same bytes, delivered in pieces, without ever holding all of them.
   *
   * Measured against a 300MB file in real Obsidian: `readBinary` cost 608MB of
   * external memory and 770MB RSS, while streaming plateaued at 136MB. On a
   * phone, where the whole web process may get a few hundred MB, that is the
   * difference between working and being killed.
   *
   * Piece sizes are the transport's choice, not the caller's — Obsidian's
   * resource handler delivers 2MiB whatever is asked for — so a caller that
   * needs specific boundaries must re-cut them.
   */
  readBinaryChunks(path: string): AsyncIterable<Uint8Array>;
  writeBinary(path: string, data: Uint8Array): Promise<void>;
  createBinary(path: string, data: Uint8Array): Promise<void>;
}

/**
 * In-memory vault for tests.
 *
 * Models the behaviours the sync layer actually depends on, including the ones
 * that caused real bugs: a file must exist before it can be written, folders are
 * implied by paths, and trashing moves rather than destroys so a test can assert
 * the content survived.
 */
/**
 * In-memory, and only ever reachable from a test.
 *
 * Its errors interpolate the path into the message, which the real
 * `ObsidianVault` deliberately does not — see `VaultPathError` there. That is
 * fine precisely because this class never ships: nothing it throws can reach
 * a crash report. Do not "fix" the messages below to match; the asymmetry is
 * the point, and a test that reads the path out of the message is easier than
 * one that does not.
 */
export class FakeVault implements VaultAdapter {
  private files = new Map<string, string>();
  /**
   * Binary files, kept apart from text ones on purpose.
   *
   * A single map storing everything as a string would hide the very bug this
   * separation exists to catch — a binary read back through a text path and
   * quietly mangled.
   */
  private binaries = new Map<string, Uint8Array>();
  private folders = new Set<string>();
  private mtimes = new Map<string, number>();
  /** Everything ever trashed, by original path, so tests can assert recovery. */
  readonly trashed = new Map<string, string>();
  private clock = 1_000;

  constructor(seed: Record<string, string> = {}) {
    for (const [path, content] of Object.entries(seed)) this.seedFile(path, content);
  }

  private seedFile(path: string, content: string): void {
    this.files.set(path, content);
    this.mtimes.set(path, this.clock++);
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i++) this.folders.add(parts.slice(0, i).join('/'));
  }

  listMarkdown(folderPath: string): string[] {
    const prefix = folderPath === '' ? '' : `${folderPath}/`;
    return [...this.files.keys()].filter((p) => p.startsWith(prefix) && p.endsWith('.md')).sort();
  }

  listFiles(folderPath: string): string[] {
    const prefix = folderPath === '' ? '' : `${folderPath}/`;
    return [...this.files.keys(), ...this.binaries.keys()]
      .filter((p) => p.startsWith(prefix))
      .sort();
  }

  async *readBinaryChunks(path: string): AsyncGenerator<Uint8Array> {
    const bytes = await this.readBinary(path);
    // Deliberately an awkward size, and deliberately not the caller's chunk
    // size: a fake that hands back neat boundaries would never exercise the
    // re-chunking that the real transport forces.
    const piece = 700;
    for (let at = 0; at < bytes.length; at += piece) {
      yield bytes.subarray(at, Math.min(at + piece, bytes.length));
    }
  }

  async readBinary(path: string): Promise<Uint8Array> {
    const bytes = this.binaries.get(path);
    if (bytes) return bytes;
    // A text file read as binary is a legitimate thing to do — the classifier
    // decides what is what, and it decides by extension.
    const text = this.files.get(path);
    if (text !== undefined) return new TextEncoder().encode(text);
    throw new Error(`No such file: ${path}`);
  }

  async writeBinary(path: string, data: Uint8Array): Promise<void> {
    if (!this.binaries.has(path) && !this.files.has(path)) {
      throw new Error(`Cannot write to a file that does not exist: ${path}`);
    }
    this.files.delete(path);
    this.binaries.set(path, data);
    this.mtimes.set(path, this.clock++);
  }

  async createBinary(path: string, data: Uint8Array): Promise<void> {
    if (this.binaries.has(path) || this.files.has(path)) {
      throw new Error(`File already exists: ${path}`);
    }
    this.binaries.set(path, data);
    this.mtimes.set(path, this.clock++);
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i++) this.folders.add(parts.slice(0, i).join('/'));
  }

  exists(path: string): boolean {
    // Binaries count. Obsidian makes no distinction here, and a fake that did
    // would report an attachment as absent and hide every code path that acts
    // on one.
    return this.files.has(path) || this.binaries.has(path) || this.folders.has(path);
  }

  isFile(path: string): boolean {
    return this.files.has(path) || this.binaries.has(path);
  }

  isFolder(path: string): boolean {
    return this.folders.has(path);
  }

  async read(path: string): Promise<string> {
    const content = this.files.get(path);
    if (content === undefined) throw new Error(`Not a file: ${path}`);
    return content;
  }

  async write(path: string, content: string): Promise<void> {
    this.seedFile(path, content);
  }

  async create(path: string, content: string): Promise<void> {
    if (this.files.has(path)) throw new Error(`Already exists: ${path}`);
    this.seedFile(path, content);
  }

  async createFolder(path: string): Promise<void> {
    // Mirrors the real adapter: intermediate folders come into existence too.
    const parts = path.split('/');
    for (let i = 1; i <= parts.length; i++) this.folders.add(parts.slice(0, i).join('/'));
  }

  async rename(from: string, to: string): Promise<void> {
    const content = this.files.get(from);
    if (content === undefined) throw new Error(`Cannot rename, not found: ${from}`);
    this.files.delete(from);
    this.mtimes.delete(from);
    this.seedFile(to, content);
  }

  async trash(path: string): Promise<void> {
    const content = this.files.get(path);
    if (content === undefined) return;
    this.trashed.set(path, content);
    this.files.delete(path);
    this.mtimes.delete(path);
  }

  stat(path: string): { size: number; mtime: number } | null {
    const bytes = this.binaries.get(path);
    if (bytes !== undefined) return { size: bytes.length, mtime: this.mtimes.get(path) ?? 0 };
    const content = this.files.get(path);
    if (content === undefined) return null;
    // Bytes, not JS string length. ObsidianVaultAdapter reports real file size,
    // so returning `content.length` made the fake disagree with the real thing
    // for any non-ASCII note. Harmless while `size` was advisory; a test that
    // passes against a fake which measures differently is worthless once quota
    // accounting depends on it.
    return { size: new TextEncoder().encode(content).length, mtime: this.mtimes.get(path) ?? 0 };
  }

  /** Test helper: current contents, for asserting on the whole vault at once. */
  snapshot(): Record<string, string> {
    return Object.fromEntries([...this.files.entries()].sort());
  }
}
