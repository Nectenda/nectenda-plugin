import {
  sealBlobStream, openBlob, generateBlobKey, newBlobId,
  hashChunkStream, exportRawKey, importContentKey, encrypt, decrypt,
  toBase64, fromBase64, BLOB_CHUNK_SIZE, type BlobEntry,
} from '@nectenda/shared';
import type NectendaPlugin from './main';
import type { VaultAdapter } from './vault-adapter';
import { chooseCodec } from './blob-policy';
import { LEARNING_FLOOR_BYTES } from './device-state';
import { log } from './logger';
import { serverFetch } from './client-version.js';

/** A `window.setTimeout`/`setInterval` handle: a number.
 *
 * Spelled out rather than `ReturnType<typeof window.setTimeout>`, which looks
 * tidier and is wrong here. `@types/node` is a devDependency, so the global is
 * overloaded, and `ReturnType<>` resolves the *last* overload — Node's
 * `Timeout` — while the call itself resolves the DOM one and returns a number.
 * The two disagree and nothing says so until an assignment fails.
 */
type TimerHandle = number;

/**
 * Attachments on disk, kept in step with the `blobs` map in the meta document.
 *
 * A second ContentSync in shape, and it has to mirror its guarantees rather
 * than reinvent them. The ones that were earned by losing content:
 *
 * - **A failed download is "not heard from yet", never "empty".** It leaves the
 *   file on disk exactly as it is. It never truncates, never writes zero bytes,
 *   never trashes.
 * - **Nothing is overwritten without a copy.** Before replacing or trashing a
 *   local file whose bytes differ from what was last synced, the local version
 *   is written beside it as a conflict copy. Binaries do not merge, so
 *   last-writer-wins is the only option and the loser has to survive somewhere.
 * - **A write we caused must not look like a user edit.** Writing a file fires
 *   `modify`, and without suppressing that, every download would re-upload
 *   itself under a fresh id, forever.
 *
 * One place it deliberately differs from ContentSync: **the file is created
 * only once its bytes are in hand.** `createLocalFileWithContent` creates an
 * empty placeholder first to win a race with content arriving on another
 * channel; there is no such race here, because nothing else delivers an
 * attachment. An empty placeholder would be a visibly broken image, and a
 * download failure would turn it into data loss. Do not "fix" this into
 * alignment with the text path.
 */

interface FolderState {
  sharedFolderId: string;
  localPath: string;
  /** Paths whose next `modify` event is ours and must be ignored. */
  ignoreNextModify: Set<string>;
  /** Hash of what we last put on disk or read off it, per relative path. */
  lastSyncedHash: Map<string, string>;
  /** Cancels every transfer in flight when the folder goes away. */
  abort: AbortController;
  debounce: Map<string, TimerHandle>;
}

/** Local modifications settle before an upload. Image editors write repeatedly. */
const MODIFY_DEBOUNCE_MS = 2000;

export class BlobSync {
  private plugin: NectendaPlugin;
  private vault: VaultAdapter;
  private folders = new Map<string, FolderState>();

  constructor(plugin: NectendaPlugin, vault: VaultAdapter) {
    this.plugin = plugin;
    this.vault = vault;
  }

  connectFolder(sharedFolderId: string, localPath: string): void {
    if (this.folders.has(sharedFolderId)) return;
    this.folders.set(sharedFolderId, {
      sharedFolderId,
      localPath,
      ignoreNextModify: new Set(),
      lastSyncedHash: new Map(),
      abort: new AbortController(),
      debounce: new Map(),
    });
  }

  disconnectFolder(sharedFolderId: string): void {
    const state = this.folders.get(sharedFolderId);
    if (!state) return;
    // Everything in flight is cancelled before the state it would write into
    // disappears. A download resolving into an unmapped folder is the named
    // recurring hazard in this codebase, not a hypothetical one.
    state.abort.abort();
    for (const timer of state.debounce.values()) window.clearTimeout(timer);
    this.folders.delete(sharedFolderId);
  }

  stop(): void {
    for (const id of [...this.folders.keys()]) this.disconnectFolder(id);
  }

  isConnected(sharedFolderId: string): boolean {
    return this.folders.has(sharedFolderId);
  }

  /** Whether a `modify` event was caused by our own write. */
  shouldIgnoreModify(sharedFolderId: string, relativePath: string): boolean {
    const state = this.folders.get(sharedFolderId);
    if (!state?.ignoreNextModify.has(relativePath)) return false;
    state.ignoreNextModify.delete(relativePath);
    return true;
  }

  // -------------------------------------------------------------------------
  // Upload
  // -------------------------------------------------------------------------

  /** Queue an upload once local edits settle. */
  scheduleUpload(sharedFolderId: string, relativePath: string): void {
    const state = this.folders.get(sharedFolderId);
    if (!state) return;
    const existing = state.debounce.get(relativePath);
    if (existing) window.clearTimeout(existing);
    state.debounce.set(
      relativePath,
      window.setTimeout(() => {
        state.debounce.delete(relativePath);
        void this.upload(sharedFolderId, relativePath);
      }, MODIFY_DEBOUNCE_MS),
    );
  }

  /**
   * Encrypt and upload one attachment, then list it.
   *
   * Strictly sequenced, and the order is the correctness argument: the listing
   * entry is written **only after the upload has succeeded**. A failure
   * anywhere leaves no entry at all, so the file simply has not synced yet,
   * rather than every other member seeing an entry whose bytes do not exist.
   */
  async upload(sharedFolderId: string, relativePath: string): Promise<boolean> {
    const state = this.folders.get(sharedFolderId);
    if (!state) return false;

    const fullPath = `${state.localPath}/${relativePath}`;
    if (!this.vault.isFile(fullPath)) return false;

    const keys = this.plugin.folderCrypto.get(sharedFolderId);
    if (!keys) {
      log.debug('No keys for folder; deferring attachment upload', { sharedFolderId });
      return false;
    }

    try {
      const stat = this.vault.stat(fullPath);
      if (!stat) return false;

      // Refused before a byte is read, not after the whole thing is encrypted.
      //
      // Without this the client reads and seals the entire file, builds the
      // ciphertext, sends it, and only then learns the server was never going
      // to accept it. On a 750MB attachment that is seconds of pointless work
      // and a 750MB Blob; on a phone it is enough to end the app. The server
      // still enforces the limit — this only stops us wasting the trip.
      const limit = this.plugin.maxBlobBytes();
      if (stat.size > limit) {
        this.refusePermanently(sharedFolderId, relativePath, stat.size, limit);
        return false;
      }

      // Pass one: hash it, streaming, to decide whether anything changed.
      //
      // Two passes over the file rather than one, deliberately. Holding it once
      // to do both would be exactly the cost this is avoiding, and re-reading
      // from disk is cheap next to encrypting.
      const listed = this.entry(sharedFolderId, relativePath);
      const chunkSize = listed?.chunkSize ?? BLOB_CHUNK_SIZE;
      const { hash } = await hashChunkStream(this.vault.readBinaryChunks(fullPath), chunkSize);

      // Nothing to do if the bytes already match what is listed. Image editors
      // rewrite files that have not changed, and re-uploading would mint a new
      // id and charge the account again for identical content.
      if (listed && listed.hash === hash) {
        state.lastSyncedHash.set(relativePath, hash);
        return false;
      }

      const blobId = newBlobId();
      const blobKey = await generateBlobKey();
      const codec = await this.pickCodec(relativePath, fullPath);

      const contentKey = keys.contentKeys.get(keys.currentKeyId);
      if (!contentKey) return false;
      const wrappedKey = toBase64(await encrypt(contentKey, await exportRawKey(blobKey)));

      // Pass two: seal and collect. Parts go into a Blob as they are produced
      // and the arrays are dropped, so the ciphertext lives in the engine's
      // blob store — which spills to disk — rather than in the JS heap.
      let body = new Blob([]);
      let pending: Uint8Array[] = [];
      const sealed = await sealBlobStream(
        blobKey, blobId, this.vault.readBinaryChunks(fullPath),
        { size: stat.size, codec, chunkSize: BLOB_CHUNK_SIZE },
        (part) => {
          pending.push(part);
          if (pending.length >= 4) {
            body = new Blob([body, ...(pending as BlobPart[])]);
            pending = [];
          }
        },
      );
      if (pending.length > 0) body = new Blob([body, ...(pending as BlobPart[])]);

      const outcome = await this.put(sharedFolderId, blobId, body, state.abort.signal);
      if (outcome === 'too-large') {
        // Permanent: no amount of retrying makes the file smaller. Queueing it
        // would mean re-encrypting it on every reconnect, for ever.
        this.refusePermanently(sharedFolderId, relativePath, sealed.size, 0);
        return false;
      }
      if (outcome !== 'ok') {
        this.rememberPending(sharedFolderId, relativePath);
        return false;
      }
      if (!this.folders.has(sharedFolderId)) return false; // unmapped while uploading

      const entry: BlobEntry = {
        blobId,
        size: sealed.size,
        mtime: this.vault.stat(fullPath)?.mtime ?? Date.now(),
        keyId: keys.currentKeyId,
        wrappedKey,
        hash: sealed.hash,
        codec: sealed.codec,
        chunkSize: sealed.chunkSize,
        uploadedBy: this.plugin.settings.username,
      };

      // A **new** blobId every time, never an overwrite of the old one: a peer
      // part-way through downloading the previous version must not have the
      // bytes change underneath it.
      this.plugin.fileSync?.setBlobEntry(sharedFolderId, relativePath, entry);
      state.lastSyncedHash.set(relativePath, hash);
      this.forgetPending(sharedFolderId, relativePath);
      log.info('Uploaded attachment', { relativePath, bytes: sealed.size, codec: sealed.codec });
      return true;
    } catch (err) {
      log.error('Attachment upload failed', { relativePath, error: String(err) });
      this.rememberPending(sharedFolderId, relativePath);
      return false;
    }
  }

  // -------------------------------------------------------------------------
  // Download
  // -------------------------------------------------------------------------

  /**
   * Fetch, verify and write one attachment.
   *
   * Every failure path leaves the file on disk untouched. A download that did
   * not arrive says nothing about what the user has locally, and treating it as
   * "the file is empty" is precisely how content gets destroyed.
   */
  async download(sharedFolderId: string, relativePath: string, entry: BlobEntry): Promise<boolean> {
    const state = this.folders.get(sharedFolderId);
    if (!state) return false;

    const fullPath = `${state.localPath}/${relativePath}`;
    const keys = this.plugin.folderCrypto.get(sharedFolderId);
    if (!keys) return false;

    // A decision this device already made — either it crashed opening this, or
    // the user said no. Either way, not again until they ask for it.
    const device = this.plugin.deviceState;
    if (device?.isSkipped(sharedFolderId, relativePath)) return false;

    // Already holding exactly these bytes — checked without reading the file
    // into memory.
    if ((await this.hashLocal(fullPath, entry.chunkSize)) === entry.hash) {
      state.lastSyncedHash.set(relativePath, entry.hash);
      return false;
    }

    // Above what this device believes it can handle, ask before trying. Below
    // it, just try — a dialog on every ordinary image would be worse than
    // useless, and the budget starts at the account maximum so nothing is asked
    // about until something has actually gone wrong here.
    if (device && entry.size > device.budgetBytes) {
      const proceed = await this.plugin.confirmLargeDownload(relativePath, entry.size);
      if (!proceed) {
        await device.decline(sharedFolderId, relativePath, entry.size);
        return false;
      }
      // Nothing to clear on consent: this branch is only reached when the file
      // is *not* already skipped, so there is no refusal on record. The ceiling
      // rises only if the download actually completes, further down.
    }

    // Written to disk before a byte is fetched, and deliberately awaited: if
    // this device dies opening the file, the record of having tried is what
    // teaches it not to try again. See device-state.ts.
    const large = device !== null && entry.size >= LEARNING_FLOOR_BYTES;
    if (large) await device!.beginAttempt(sharedFolderId, relativePath, entry.size);

    let plaintext: Uint8Array;
    try {
      const ciphertext = await this.get(sharedFolderId, entry.blobId, state.abort.signal);
      if (!ciphertext) {
        if (large) await device!.endAttempt();
        return false;
      }

      const raw = keys.contentKeys.get(entry.keyId);
      if (!raw) {
        log.warn('No key generation for attachment; leaving the local file alone', {
          relativePath, keyId: entry.keyId,
        });
        return false;
      }
      const blobKey = await importContentKey(await decrypt(raw, fromBase64(entry.wrappedKey)));
      plaintext = await openBlob(blobKey, entry.blobId, ciphertext, {
        hash: entry.hash, size: entry.size,
      });
    } catch (err) {
      // Discard and warn. Never write, never truncate, never trash.
      //
      // The message distinguishes tampering from a platform gap, because they
      // call for different things from the user and saying "failed
      // verification" for a missing browser API sends them looking for
      // corruption that is not there.
      log.error('Could not open attachment; keeping the local file untouched', {
        relativePath, error: String(err),
      });
      // We are still running, so this was not a kill. Clearing it stops the
      // next launch mistaking an ordinary failure for a crash.
      if (large) await device!.endAttempt();
      return false;
    }

    if (large) {
      await device!.endAttempt();
      // Survived it, so the ceiling can come up. Consent alone must not do this
      // — agreeing to a file that then kills the app is not evidence the device
      // can manage it, and the crash record would be undone by the raise.
      await device!.recordSuccess(entry.size);
    }

    if (!this.folders.has(sharedFolderId)) return false; // unmapped mid-download

    await this.writeLocal(state, relativePath, fullPath, plaintext, entry.hash, entry.chunkSize);
    return true;
  }

  /**
   * Put the bytes on disk, preserving whatever was there if it differs.
   *
   * The conflict rule is broader than "copy before deleting", because binaries
   * have a loss path text does not: two people replace the same image offline,
   * `Y.Map` picks one, and the loser's bytes are overwritten on their own disk
   * with no CRDT merge to recover them.
   */
  private async writeLocal(
    state: FolderState,
    relativePath: string,
    fullPath: string,
    plaintext: Uint8Array,
    hash: string,
    chunkSize: number,
  ): Promise<void> {
    if (this.vault.isFile(fullPath)) {
      const currentHash = await this.hashLocal(fullPath, chunkSize);
      const lastSynced = state.lastSyncedHash.get(relativePath);
      if (currentHash !== null && currentHash !== hash && currentHash !== lastSynced) {
        // Only now is the local copy read in full, and only because it is about
        // to be written somewhere else. Comparing never needs it.
        const current = await this.vault.readBinary(fullPath).catch(() => null);
        if (current) await this.writeConflictCopy(state, relativePath, current);
      }
      state.ignoreNextModify.add(relativePath);
      await this.vault.writeBinary(fullPath, plaintext);
    } else {
      const dir = fullPath.slice(0, fullPath.lastIndexOf('/'));
      if (dir) await this.vault.createFolder(dir);
      state.ignoreNextModify.add(relativePath);
      await this.vault.createBinary(fullPath, plaintext);
    }
    state.lastSyncedHash.set(relativePath, hash);
  }

  /** Local bytes about to be replaced or removed, kept beside the file. */
  private async writeConflictCopy(
    state: FolderState,
    relativePath: string,
    bytes: Uint8Array,
  ): Promise<void> {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dot = relativePath.lastIndexOf('.');
    const base = dot > 0 ? relativePath.slice(0, dot) : relativePath;
    const ext = dot > 0 ? relativePath.slice(dot) : '';
    const target = `${state.localPath}/${base} (conflicted copy ${stamp})${ext}`;
    try {
      await this.vault.createBinary(target, bytes);
      log.warn('Kept a conflicting local attachment', { path: target });
    } catch (err) {
      log.error('Could not write conflict copy', { path: target, error: String(err) });
    }
  }

  /**
   * The attachment was removed elsewhere.
   *
   * The local copy is trashed, but only after a conflict copy if it differs
   * from what we last synced. An unsaved local change must not vanish because
   * somebody else deleted the file.
   */
  async removeLocal(sharedFolderId: string, relativePath: string): Promise<void> {
    const state = this.folders.get(sharedFolderId);
    if (!state) return;
    const fullPath = `${state.localPath}/${relativePath}`;
    if (!this.vault.isFile(fullPath)) return;

    const hash = await this.hashLocal(fullPath, BLOB_CHUNK_SIZE);
    if (hash !== null && hash !== state.lastSyncedHash.get(relativePath)) {
      const current = await this.vault.readBinary(fullPath).catch(() => null);
      if (current) await this.writeConflictCopy(state, relativePath, current);
    }
    await this.vault.trash(fullPath);
    state.lastSyncedHash.delete(relativePath);
  }

  // -------------------------------------------------------------------------
  // Transport
  // -------------------------------------------------------------------------

  /**
   * The folder's own server. On Nectenda Cloud a vault may map folders from
   * organisations on different servers, so the base URL and the token are the
   * folder's, never the plugin's one setting.
   */
  private endpoint(sharedFolderId: string, blobId?: string): string {
    const { base } = this.plugin.serverFor(sharedFolderId);
    return `${base}/folders/${sharedFolderId}/blobs${blobId ? `/${blobId}` : ''}`;
  }

  private auth(sharedFolderId: string): string {
    return `Bearer ${this.plugin.serverFor(sharedFolderId).token}`;
  }

  /**
   * Hash a local file the same way its entry was hashed.
   *
   * The chunk size has to match the entry's, because the hash is defined over
   * chunk boundaries — comparing with a different one would report every file
   * as changed and re-upload the whole folder.
   */
  private async hashLocal(fullPath: string, chunkSize: number): Promise<string | null> {
    if (!this.vault.isFile(fullPath)) return null;
    try {
      const { hash } = await hashChunkStream(this.vault.readBinaryChunks(fullPath), chunkSize);
      return hash;
    } catch {
      return null;
    }
  }

  /**
   * Whether to compress, decided from a sample rather than the whole file.
   *
   * Reads only the first piece the transport hands over, which is all the probe
   * needs and avoids pulling the file into memory purely to decide.
   */
  private async pickCodec(relativePath: string, fullPath: string) {
    for await (const piece of this.vault.readBinaryChunks(fullPath)) {
      return chooseCodec(relativePath, piece);
    }
    return chooseCodec(relativePath, new Uint8Array(0));
  }

  /**
   * Record an attachment the server will never accept.
   *
   * Deliberately not the pending queue. That queue is for things which might
   * work later — a dropped connection, a full account that gets cleared — and
   * a file larger than the account's maximum is not one of them. Putting it
   * there would re-read and re-encrypt it on every single reconnect.
   */
  private refusePermanently(
    sharedFolderId: string,
    relativePath: string,
    bytes: number,
    limit: number,
  ): void {
    this.forgetPending(sharedFolderId, relativePath);
    const key = `${sharedFolderId} ${relativePath}`;
    const known = this.plugin.settings.oversizedAttachments ?? [];
    if (!known.includes(key)) {
      this.plugin.settings.oversizedAttachments = [...known, key];
      void this.plugin.saveSettings();
    }
    this.plugin.reportAttachmentTooLarge(relativePath, bytes, limit);
  }

  private async put(
    sharedFolderId: string,
    blobId: string,
    body: Blob,
    signal: AbortSignal,
  ): Promise<'ok' | 'too-large' | 'retry'> {
    // A Blob, not a ReadableStream. Request streaming needs `duplex: 'half'`
    // and is Chromium-only; WKWebView, which is every iPad and iPhone, has
    // none. Both engines back a large Blob with a disk-spilling store, so this
    // streams out without holding the ciphertext in the JS heap, everywhere.
    const res = await serverFetch(this.endpoint(sharedFolderId, blobId), {
      method: 'PUT',
      headers: {
        Authorization: this.auth(sharedFolderId),
        'Content-Type': 'application/octet-stream',
      },
      body,
      signal,
    });
    if (res.ok) return 'ok';

    if (res.status === 413) {
      // The one refusal that never becomes acceptable.
      return 'too-large';
    }
    if (res.status === 403) {
      // Two permanent answers share the status: the plan has no attachments,
      // or the organisation is suspended. Both are said once, and neither is
      // worth retrying until something outside this vault changes.
      let code = '';
      try {
        code = ((await res.json()) as { code?: string }).code ?? '';
      } catch {
        code = '';
      }
      if (code === 'ATTACHMENTS_NOT_INCLUDED') {
        this.plugin.reportAttachmentsNotIncluded();
        return 'too-large';
      }
      if (code === 'ACCOUNT_SUSPENDED') {
        this.plugin.reportAccountSuspended();
        return 'retry';
      }
    }
    if (res.status === 507) {
      // Storage full is temporary: clearing space makes this work.
      this.plugin.reportStorageFull(blobId);
    } else {
      log.warn('Attachment upload rejected', { blobId, status: res.status });
    }
    return 'retry';
  }

  /**
   * Fetch ciphertext, from the bucket directly when the server offers it.
   *
   * The request asks for a presigned URL. A server whose attachments live in
   * object storage answers with JSON carrying one, and the bytes are then
   * fetched from the bucket **with no headers at all**: no bearer token, so
   * nothing of ours reaches the provider, and no custom header, so there is no
   * CORS preflight for the bucket to fail. A self-hosted server on the
   * filesystem ignores the header and streams the bytes itself, and a bucket
   * fetch that fails for any reason falls back to that same stream — the
   * provider is untrusted by construction and the envelope is verified after
   * decryption either way.
   */
  private async get(
    sharedFolderId: string,
    blobId: string,
    signal: AbortSignal,
  ): Promise<Uint8Array | null> {
    const endpoint = this.endpoint(sharedFolderId, blobId);
    const res = await serverFetch(endpoint, {
      headers: { Authorization: this.auth(sharedFolderId), 'X-Nectenda-Blob-Url': '1' },
      signal,
    });
    if (!res.ok) {
      log.warn('Attachment download failed', { blobId, status: res.status });
      return null;
    }
    if ((res.headers.get('content-type') ?? '').includes('application/json')) {
      const { url } = (await res.json()) as { url?: string };
      if (typeof url === 'string' && /^https?:\/\//.test(url)) {
        try {
          const direct = await fetch(url, { signal });
          if (direct.ok) return new Uint8Array(await direct.arrayBuffer());
          log.warn('Presigned download failed; falling back to the server', { blobId, status: direct.status });
        } catch (err) {
          if (signal.aborted) throw err;
          log.warn('Presigned download failed; falling back to the server', { blobId, error: String(err) });
        }
      }
      const streamed = await serverFetch(endpoint, {
        headers: { Authorization: this.auth(sharedFolderId) },
        signal,
      });
      if (!streamed.ok) {
        log.warn('Attachment download failed', { blobId, status: streamed.status });
        return null;
      }
      return new Uint8Array(await streamed.arrayBuffer());
    }
    return new Uint8Array(await res.arrayBuffer());
  }

  /** Tell the server the bytes are no longer referenced. */
  async deleteRemote(sharedFolderId: string, blobId: string): Promise<void> {
    try {
      await serverFetch(this.endpoint(sharedFolderId, blobId), {
        method: 'DELETE',
        headers: { Authorization: this.auth(sharedFolderId) },
      });
      this.forgetPendingDelete(sharedFolderId, blobId);
    } catch {
      // Persisted, because the in-memory version of this queue is a mistake
      // this codebase has already made once: an offline delete plus a restart
      // loses the purge for ever and mints a permanent orphan.
      this.rememberPendingDelete(sharedFolderId, blobId);
    }
  }

  // -------------------------------------------------------------------------
  // Persisted queues
  // -------------------------------------------------------------------------

  private entry(sharedFolderId: string, relativePath: string): BlobEntry | undefined {
    return this.plugin.fileSync?.getBlobEntry(sharedFolderId, relativePath);
  }

  private rememberPending(sharedFolderId: string, relativePath: string): void {
    const key = `${sharedFolderId} ${relativePath}`;
    const pending = this.plugin.settings.pendingBlobUploads ?? [];
    if (!pending.includes(key)) {
      this.plugin.settings.pendingBlobUploads = [...pending, key];
      void this.plugin.saveSettings();
    }
  }

  private forgetPending(sharedFolderId: string, relativePath: string): void {
    const key = `${sharedFolderId} ${relativePath}`;
    const pending = this.plugin.settings.pendingBlobUploads ?? [];
    if (pending.includes(key)) {
      this.plugin.settings.pendingBlobUploads = pending.filter((k) => k !== key);
      void this.plugin.saveSettings();
    }
  }

  private rememberPendingDelete(sharedFolderId: string, blobId: string): void {
    const key = `${sharedFolderId} ${blobId}`;
    const pending = this.plugin.settings.pendingBlobDeletes ?? [];
    if (!pending.includes(key)) {
      this.plugin.settings.pendingBlobDeletes = [...pending, key];
      void this.plugin.saveSettings();
    }
  }

  private forgetPendingDelete(sharedFolderId: string, blobId: string): void {
    const key = `${sharedFolderId} ${blobId}`;
    const pending = this.plugin.settings.pendingBlobDeletes ?? [];
    if (pending.includes(key)) {
      this.plugin.settings.pendingBlobDeletes = pending.filter((k) => k !== key);
      void this.plugin.saveSettings();
    }
  }

  /**
   * Tell the server every blob this folder's listing still references.
   *
   * The server cannot read the listing, so without this it has no way to tell a
   * live attachment from an abandoned one, and its only safe choice would be to
   * keep everything for ever.
   *
   * Sends the **complete** set rather than a delta, deliberately: a delta that
   * went missing would leave the server believing something is unreferenced
   * when it is not, and that ends in a deleted file.
   *
   * Ids the server reports as missing are re-uploaded, which repairs the
   * opposite failure — a listing entry whose bytes the server no longer has.
   */
  async attestFolder(sharedFolderId: string): Promise<void> {
    const state = this.folders.get(sharedFolderId);
    if (!state) return;
    const listed = this.plugin.fileSync?.listBlobs(sharedFolderId) ?? [];

    try {
      const res = await serverFetch(`${this.endpoint(sharedFolderId)}/attest`, {
        method: 'POST',
        headers: {
          Authorization: this.auth(sharedFolderId),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ blobIds: listed.map(([, entry]) => entry.blobId) }),
        signal: state.abort.signal,
      });
      if (!res.ok) return;

      const { missing } = (await res.json()) as { missing?: string[] };
      if (!missing?.length) return;

      // The server is holding a listing entry with no bytes behind it. We have
      // the file, so put it back rather than leaving everyone else with a
      // broken attachment.
      log.warn('Server is missing attachments this folder lists; re-uploading', {
        count: missing.length,
      });
      const lost = new Set(missing);
      for (const [relativePath, entry] of listed) {
        if (lost.has(entry.blobId)) await this.upload(sharedFolderId, relativePath);
      }
    } catch {
      // Attesting is housekeeping. Failing to do it keeps bytes alive, which is
      // the safe direction, so it is never worth surfacing.
    }
  }

  /** Retry whatever did not get through last time. Called on reconnect. */
  async flushPending(): Promise<void> {
    for (const key of [...(this.plugin.settings.pendingBlobUploads ?? [])]) {
      const gap = key.indexOf(' ');
      if (gap < 0) continue;
      const folderId = key.slice(0, gap);
      const relativePath = key.slice(gap + 1);
      if (!this.folders.has(folderId)) continue;
      // No size check here: `upload` refuses an oversized file before reading a
      // byte of it, and moves it out of this queue itself. Repeating that here
      // would be duplication that no test could tell apart — and a queue left
      // by an older build heals on the first flush for the same reason.
      await this.upload(folderId, relativePath);
    }
    for (const key of [...(this.plugin.settings.pendingBlobDeletes ?? [])]) {
      const gap = key.indexOf(' ');
      if (gap < 0) continue;
      await this.deleteRemote(key.slice(0, gap), key.slice(gap + 1));
    }

    for (const folderId of this.folders.keys()) await this.attestFolder(folderId);
  }
}
