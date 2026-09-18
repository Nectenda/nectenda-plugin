import { Notice } from 'obsidian';
import { IndexeddbPersistence } from 'y-indexeddb';
import { loadSeqCheckpoint, saveSeqCheckpoint } from './seq-checkpoint';
import * as Y from 'yjs';
import { META_DOC_SUFFIX } from '@nectenda/shared';
import type { FileEntry, BlobEntry } from '@nectenda/shared';
import { BLOBS_MAP_KEY, LISTING_MAP_KEY, LISTING_VERSION } from '@nectenda/shared';
import { kindOf } from './blob-policy';
import { joinWithin } from './vault-path';
import type NectendaPlugin from './main';
import type { SyncProvider } from './provider-router';
import type { VaultAdapter } from './vault-adapter';
import type { ContentSync } from './content-sync';
import { idbStoreName } from './idb-name';
import { log } from './logger';

const LOCAL_ORIGIN = 'local';

interface MetaConnection {
  sharedFolderId: string;
  localPath: string;
  ydoc: Y.Doc;
  ymap: Y.Map<FileEntry>;
  /**
   * Attachments, under a second root key in the same document.
   *
   * This is the entire compatibility mechanism. An older client calls
   * `getMap('files')` and never calls `getMap('blobs')`, so Yjs replicates
   * these entries into its document, it stores and re-transmits them intact,
   * and its observer never sees them. It cannot act on an entry it does not
   * read, which is the only protection that works on a client already shipped.
   */
  bmap: Y.Map<BlobEntry>;
  idbProvider: IndexeddbPersistence;
}

export class FileSync {
  private plugin: NectendaPlugin;
  private vault: VaultAdapter;
  private provider: SyncProvider;
  private contentSync: ContentSync | null = null;
  /** Serialises create/delete per path. See sequence(). */
  private pathChain: Map<string, Promise<void>> = new Map();
  /**
   * Paths this client is creating because the folder listing asked it to.
   *
   * VaultWatcher cannot otherwise tell such a file from one the user just made,
   * and treats it as a new local file — writing it back into the listing. That
   * is how a deleted note came back: the listing said "added" then "removed",
   * the file was created and correctly trashed, and the creation's own vault
   * event re-added it two milliseconds later. The entry is already in the
   * listing when we create the file, so there is nothing to announce.
   */
  private remoteCreates: Set<string> = new Set();
  private connections: Map<string, MetaConnection> = new Map();
  private folderReadyListeners: ((sharedFolderId: string) => void)[] = [];

  constructor(plugin: NectendaPlugin, provider: SyncProvider, vault: VaultAdapter) {
    this.plugin = plugin;
    this.vault = vault;
    this.provider = provider;
  }

  setContentSync(contentSync: ContentSync): void {
    this.contentSync = contentSync;
  }

  /**
   * Called when a folder's listing document is open and writable.
   *
   * Not a general event bus — one caller, VaultWatcher, and one purpose: a
   * local file created before this point has nowhere to be recorded, and
   * nothing later re-scans for it. The listing is deliberately *not* rebuilt
   * from disk on connect, because a file present locally but absent from the
   * listing is ambiguous: it may be new, or it may be one another vault
   * deleted while this one was away, and re-adding those resurrects deletions.
   * Replaying creates this session actually observed is unambiguous.
   */
  onFolderReady(listener: (sharedFolderId: string) => void): void {
    this.folderReadyListeners.push(listener);
  }

  connectFolder(sharedFolderId: string, localPath: string): void {
    if (this.connections.has(sharedFolderId)) return;
    void this.doConnectFolder(sharedFolderId, localPath);
  }

  private async doConnectFolder(sharedFolderId: string, localPath: string): Promise<void> {
    if (this.connections.has(sharedFolderId)) return;

    // Refuse the whole folder when its keys are missing, rather than connecting
    // part of it.
    //
    // Without keys the listing cannot be decrypted, so no remote deletion can be
    // observed — and a half-connected folder that cannot see deletions is one
    // that will happily trash local files on a listing it misread. Nothing local
    // may be touched for a folder this client cannot read.
    if (!this.plugin.folderCrypto.hasKeys(sharedFolderId)) {
      log.warn('Folder has no encryption keys — not connecting it', { sharedFolderId });
      new Notice('Nectenda: no encryption key for a shared folder. Ask an owner to re-share it.');
      return;
    }

    // The listing's own id is derived like any other document, rather than
    // leaving `__meta__` in clear as a marker telling the server which blob is
    // the folder index.
    const docName = await this.plugin.docIndex.ref(sharedFolderId, META_DOC_SUFFIX);
    const ydoc = new Y.Doc();
    const ymap = ydoc.getMap<FileEntry>('files');
    const bmap = ydoc.getMap<BlobEntry>(BLOBS_MAP_KEY);

    const idbProvider = new IndexeddbPersistence(idbStoreName(this.plugin.vaultKey, docName), ydoc);

    const startProvider = () => {
      // Subscribe meta doc via multiplexed provider. `startProvider` runs after
      // IndexedDB has loaded, which is what makes the checkpoint's state-vector
      // check meaningful.
      this.provider.subscribe(docName, ydoc, {
        load: () => loadSeqCheckpoint(idbProvider, ydoc),
        save: (seq) => saveSeqCheckpoint(idbProvider, ydoc, seq),
      });

      const conn: MetaConnection = { sharedFolderId, localPath, ydoc, ymap, bmap, idbProvider };
      this.connections.set(sharedFolderId, conn);

      // Announce it. Everything above this line is asynchronous — the document
      // id is derived, then IndexedDB has to load — and until it completes
      // there is no listing to record a file in. A note created inside that
      // window used to be dropped and never revisited. VaultWatcher holds those
      // creates and replays them here. See its `pendingCreates`.
      for (const listener of this.folderReadyListeners) listener(sharedFolderId);

      // Record the listing format. Useless against clients already deployed,
      // which read no such key; useful so that a client meeting a *later*
      // version refuses to act on entry kinds it does not understand rather
      // than guessing at them.
      const listing = ydoc.getMap<number>(LISTING_MAP_KEY);
      if ((listing.get('version') ?? 0) < LISTING_VERSION) {
        ydoc.transact(() => listing.set('version', LISTING_VERSION), LOCAL_ORIGIN);
      }

      // Observe remote changes to Y.Map
      ymap.observe((event, transaction) => {
        if (transaction.origin === LOCAL_ORIGIN) return;
        this.handleRemoteChanges(conn, event);
      });

      bmap.observe((event, transaction) => {
        if (transaction.origin === LOCAL_ORIGIN) return;
        void this.handleRemoteBlobChanges(conn, event);
      });

      // Initial sync once provider is connected
      const onSync = () => {
        this.provider.off(`synced:${docName}`, onSync);
        this.initialSync(conn);
      };

      if (this.provider.isSynced(docName)) {
        this.initialSync(conn);
      } else {
        this.provider.on(`synced:${docName}`, onSync);
      }
    };

    if (idbProvider.synced) {
      startProvider();
    } else {
      idbProvider.once('synced', startProvider);
    }
  }

  disconnectFolder(sharedFolderId: string): void {
    const conn = this.connections.get(sharedFolderId);
    if (!conn) return;

    const docName =
      this.plugin.docIndex.refSync(sharedFolderId, META_DOC_SUFFIX) ??
      `${sharedFolderId}/${META_DOC_SUFFIX}`;
    this.provider.unsubscribe(docName);
    conn.idbProvider.destroy();
    conn.ydoc.destroy();
    this.connections.delete(sharedFolderId);
  }

  disconnectAll(): void {
    for (const folderId of Array.from(this.connections.keys())) {
      this.disconnectFolder(folderId);
    }
  }

  getYMap(sharedFolderId: string): Y.Map<FileEntry> | null {
    return this.connections.get(sharedFolderId)?.ymap ?? null;
  }

  getYDoc(sharedFolderId: string): Y.Doc | null {
    return this.connections.get(sharedFolderId)?.ydoc ?? null;
  }

  private handleRemoteChanges(conn: MetaConnection, event: Y.YMapEvent<FileEntry>): void {
    const added: string[] = [];
    const deleted: string[] = [];

    for (const [key, change] of event.changes.keys) {
      if (change.action === 'add') {
        added.push(key);
      } else if (change.action === 'delete') {
        deleted.push(key);
      }
    }

    // Detect rename: one delete + one add in the same transaction
    if (deleted.length === 1 && added.length === 1) {
      const oldRelPath = deleted[0];
      const newRelPath = added[0];
      const oldLocalPath = joinWithin(conn.localPath, oldRelPath);
      const newLocalPath = joinWithin(conn.localPath, newRelPath);
      // Either end escaping makes this not a rename we can honour. Falling
      // through rather than returning leaves it to be handled as the separate
      // delete and add it also is, each of which refuses on its own terms.
      if (!oldLocalPath || !newLocalPath) {
        log.warn('Refused a rename whose name leaves the folder', { folder: conn.sharedFolderId });
        return;
      }

      const oldExists = this.vault.isFile(oldLocalPath);
      if (oldExists) {
        this.vault.rename(oldLocalPath, newLocalPath).catch((err: unknown) => {
          log.error(`Failed to rename ${oldLocalPath} → ${newLocalPath}:`, err);
        });

        // Reconnect background sync under new name
        if (this.contentSync) {
          this.contentSync.disconnectFile(conn.sharedFolderId, oldRelPath);
          this.contentSync.connectFile(conn.sharedFolderId, conn.localPath, newRelPath);
        }
        return;
      }
    }

    // Newly listed paths have to be derivable before they can be connected.
    if (added.length > 0) {
      void this.plugin.docIndex
        .warm(conn.sharedFolderId, added)
        .then(() => this.applyAdditions(conn, added));
    }

    // Handle remaining deletions
    for (const key of deleted) {
      log.debug('Meta dropped a file', { key });
      this.sequence(conn.sharedFolderId, key, () =>
        this.completeRemoteDeletion(conn.sharedFolderId, conn.localPath, key),
      );
    }
  }

  /**
   * Attachments appearing, changing or vanishing in the listing.
   *
   * Sequenced per path like the text path, so two events for one file cannot
   * interleave a download with a delete.
   */
  private async handleRemoteBlobChanges(
    conn: MetaConnection,
    event: Y.YMapEvent<BlobEntry>,
  ): Promise<void> {
    for (const [key, change] of event.changes.keys) {
      const entry = conn.bmap.get(key);
      if (change.action === 'delete') {
        this.sequence(conn.sharedFolderId, key, () =>
          this.plugin.blobSync?.removeLocal(conn.sharedFolderId, key) ?? Promise.resolve(),
        );
        continue;
      }
      if (!entry) continue;

      // Refuse a path claimed by both maps rather than racing two writers at
      // one file. The classifier partitions the namespace by extension, so this
      // should be unreachable; unreachable checks have earned their place here.
      if (conn.ymap.has(key)) {
        log.error('Path listed as both text and attachment; ignoring the attachment', {
          relativePath: key,
        });
        continue;
      }

      this.sequence(conn.sharedFolderId, key, () =>
        this.plugin.blobSync?.download(conn.sharedFolderId, key, entry).then(() => undefined)
          ?? Promise.resolve(),
      );
    }
  }

  /** Read one attachment entry, for BlobSync's change detection. */
  getBlobEntry(sharedFolderId: string, relativePath: string): BlobEntry | undefined {
    return this.connections.get(sharedFolderId)?.bmap.get(relativePath);
  }

  /** List an attachment. Called only after its bytes are safely on the server. */
  setBlobEntry(sharedFolderId: string, relativePath: string, entry: BlobEntry): void {
    const conn = this.connections.get(sharedFolderId);
    if (!conn) return;
    conn.ydoc.transact(() => conn.bmap.set(relativePath, entry), LOCAL_ORIGIN);
  }

  /** Remove an attachment from the listing, returning what it pointed at. */
  removeBlobEntry(sharedFolderId: string, relativePath: string): BlobEntry | undefined {
    const conn = this.connections.get(sharedFolderId);
    if (!conn) return undefined;
    const entry = conn.bmap.get(relativePath);
    if (entry) conn.ydoc.transact(() => conn.bmap.delete(relativePath), LOCAL_ORIGIN);
    return entry;
  }

  /**
   * Move an attachment's entry, keeping the same blobId.
   *
   * A rename must not re-upload. Obsidian renames on almost every link edit, so
   * minting a fresh id here would re-encrypt and re-send the whole file — up to
   * 100MB — because somebody corrected a filename.
   */
  renameBlobEntry(sharedFolderId: string, from: string, to: string): boolean {
    const conn = this.connections.get(sharedFolderId);
    const entry = conn?.bmap.get(from);
    if (!conn || !entry) return false;
    conn.ydoc.transact(() => {
      conn.bmap.delete(from);
      conn.bmap.set(to, entry);
    }, LOCAL_ORIGIN);
    return true;
  }

  /** Every attachment a folder lists, for the initial sweep. */
  listBlobs(sharedFolderId: string): Array<[string, BlobEntry]> {
    const conn = this.connections.get(sharedFolderId);
    if (!conn) return [];
    return [...conn.bmap.entries()];
  }

  private applyAdditions(conn: MetaConnection, added: string[]): void {
    for (const key of added) {
      const localFilePath = joinWithin(conn.localPath, key);
      // A name from the listing belongs to whoever created the file, not to
      // this vault. Refused rather than clamped, and said out loud: a file
      // that does not appear because another member named it hostilely is
      // exactly the kind of absence this project refuses to let pass quietly.
      if (!localFilePath) {
        log.warn('Refused a shared file whose name leaves the folder', { folder: conn.sharedFolderId });
        continue;
      }
      log.debug('Meta listed a file', { key, existsLocally: this.vault.exists(localFilePath) });
      if (!this.vault.exists(localFilePath)) {
        this.sequence(conn.sharedFolderId, key, () =>
          this.createLocalFileWithContent(conn.sharedFolderId, conn.localPath, key, localFilePath),
        );
      } else if (this.contentSync) {
        // File exists locally, ensure background sync is connected
        this.contentSync.connectFile(conn.sharedFolderId, conn.localPath, key);
      }
    }

  }

  /**
   * Run operations for one path strictly one after another.
   *
   * Creation and deletion race otherwise, and the race resurrects deleted
   * files. A client catching up replays the whole history at once: a file added
   * and later deleted arrives as an add immediately followed by a delete, both
   * in the same tick. `createLocalFileWithContent` is async and was fired
   * without waiting, so the deletion ran while the file did not yet exist,
   * found nothing to trash, and the creation then landed — leaving a file on
   * disk that the folder listing does not contain.
   *
   * Seen in the field: a vault joining a folder gained thirteen notes that had
   * been added and deleted an hour earlier, none of them in the listing. It is
   * also the most plausible account of the numbered duplicates
   * ("... 2.md", "... 3.md") that appeared during Phase 6.5 testing, since an
   * orphan like this is re-added to the folder by the next vault to scan it.
   */
  private sequence(sharedFolderId: string, relativePath: string, task: () => Promise<void>): void {
    const key = `${sharedFolderId}\u0000${relativePath}`;
    const previous = this.pathChain.get(key) ?? Promise.resolve();
    const next = previous.then(task).catch((err: unknown) => {
      log.error('Folder operation failed', { relativePath, error: String(err) });
    });
    this.pathChain.set(key, next);
    // Drop the entry once it is the tail, so the map does not grow for the
    // lifetime of the session.
    void next.then(() => {
      if (this.pathChain.get(key) === next) this.pathChain.delete(key);
    });
  }

  private async completeRemoteDeletion(
    sharedFolderId: string,
    folderLocalPath: string,
    relativePath: string,
  ): Promise<void> {
    const localFilePath = joinWithin(folderLocalPath, relativePath);
    // A delete naming a path outside the folder is refused like any other. It
    // is the one direction where refusing costs nothing: the file it describes
    // is not ours to remove.
    if (!localFilePath) {
      log.warn('Refused a deletion whose name leaves the folder', { folder: sharedFolderId });
      return;
    }

    if (this.vault.isFile(localFilePath)) {
      await this.preserveThenTrash(sharedFolderId, relativePath, localFilePath);
    }

    this.contentSync?.disconnectFile(sharedFolderId, relativePath);
  }

  private async preserveThenTrash(
    sharedFolderId: string,
    relativePath: string,
    localFilePath: string,
  ): Promise<void> {
    // The copy must be written before the file is trashed; the check that
    // decides whether to write one reads the file from disk.
    await this.saveConflictCopy(sharedFolderId, relativePath, localFilePath);

    if (!this.vault.isFile(localFilePath)) return;

    try {
      // `false` is the vault's own .trash, not the system trash. This deletion
      // arrived from another machine and the user here never chose it, so the
      // copy must stay somewhere they can reach. The system trash proved
      // useless: a file removed that way was not recoverable from it at all.
      await this.vault.trash(localFilePath);
      log.info('Remote deletion — moved local copy to .trash', { path: localFilePath });
    } catch (err) {
      log.error(`Failed to trash ${localFilePath}:`, err);
    }
  }

  /**
   * Save local content as a conflict copy when a remote deletion would discard it.
   *
   * Named after Dropbox's convention because the situation is the same and the
   * name is already familiar. Deliberately a sibling file rather than a trashed
   * one: the user has to be able to see that their work survived, and .trash is
   * both easy to miss and pruned automatically.
   */
  private async saveConflictCopy(
    sharedFolderId: string,
    relativePath: string,
    localFilePath: string,
  ): Promise<void> {
    if (!this.contentSync) return;

    const docName = this.plugin.docIndex.refSync(sharedFolderId, relativePath);
    if (!docName) return;
    const unsynced = await this.contentSync.unsyncedLocalContent(docName);
    if (unsynced === null) return; // Disk matched the synced document; nothing at risk.

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dot = localFilePath.lastIndexOf('.');
    const base = dot === -1 ? localFilePath : localFilePath.slice(0, dot);
    const ext = dot === -1 ? '' : localFilePath.slice(dot);
    const copyPath = `${base} (conflicted copy ${stamp})${ext}`;

    try {
      await this.vault.create(copyPath, unsynced);
      log.warn('Remote deletion would have discarded local edits — saved a conflict copy', {
        original: localFilePath,
        copy: copyPath,
      });
      new Notice(`Nectenda: "${relativePath}" was deleted elsewhere. Your changes were saved as a conflict copy.`);
    } catch (err) {
      log.error('Failed to save conflict copy', { path: copyPath, error: String(err) });
    }
  }

  /** Whether this path is being created on the folder listing's instruction. */
  isRemoteCreate(sharedFolderId: string, relativePath: string): boolean {
    return this.remoteCreates.has(`${sharedFolderId}\u0000${relativePath}`);
  }

  private async createLocalFileWithContent(
    sharedFolderId: string,
    folderLocalPath: string,
    relativePath: string,
    localFilePath: string,
  ): Promise<void> {
    const marker = `${sharedFolderId}\u0000${relativePath}`;
    this.remoteCreates.add(marker);

    try {
      // Ensure parent folders exist
      const dirPath = localFilePath.slice(0, localFilePath.lastIndexOf('/'));
      if (dirPath) {
        await this.vault.createFolder(dirPath);
      }

      // Create the placeholder BEFORE connecting.
      //
      // ContentSync writes content to disk as soon as it arrives, and its write
      // needs the file to exist in the vault index. Connecting first and
      // creating the file on a timer afterwards inverted that: content
      // routinely won the race, the write found no file, and the note was left
      // empty on disk. Creating first removes the race rather than timing
      // around it.
      if (!this.vault.exists(localFilePath)) {
        await this.vault.create(localFilePath, '');
      }

      this.contentSync?.connectFile(sharedFolderId, folderLocalPath, relativePath);
    } catch (err) {
      log.error(`Failed to create ${localFilePath}:`, err);
    } finally {
      // Cleared on the next tick, not immediately: Obsidian delivers the vault
      // 'create' event after the create resolves, so clearing here would let
      // the very event this exists to suppress through.
      setTimeout(() => this.remoteCreates.delete(marker), 0);
    }
  }

  private async initialSync(conn: MetaConnection): Promise<void> {
    if (!this.vault.isFolder(conn.localPath)) return;

    // The listing is how paths become known for documents this vault has never
    // opened, so its keys are derived before anything acts on them.
    await this.plugin.docIndex.warm(conn.sharedFolderId, Array.from(conn.ymap.keys()));

    const localFiles = new Map<string, { size: number; mtime: number }>();
    for (const path of this.vault.listMarkdown(conn.localPath)) {
      const stat = this.vault.stat(path);
      if (stat) localFiles.set(path.slice(conn.localPath.length + 1), stat);
    }

    // Push local files to Y.Map
    conn.ydoc.transact(() => {
      for (const [relPath, stat] of localFiles) {
        if (!conn.ymap.has(relPath)) conn.ymap.set(relPath, stat);
      }
    }, LOCAL_ORIGIN);

    // Create local files that exist in Y.Map but not locally
    for (const [relPath] of conn.ymap.entries()) {
      const localFilePath = joinWithin(conn.localPath, relPath);
      if (!localFilePath) {
        log.warn('Refused a shared file whose name leaves the folder', { folder: conn.sharedFolderId });
        continue;
      }
      if (!this.vault.exists(localFilePath)) {
        this.createLocalFileWithContent(conn.sharedFolderId, conn.localPath, relPath, localFilePath);
      }
    }

    await this.initialBlobSync(conn);
  }

  /**
   * Reconcile attachments once, on connect.
   *
   * Both directions, and deliberately not symmetrical with the text sweep
   * above. Uploads are queued through the debounce rather than fired at once,
   * because a folder full of images would otherwise start encrypting all of
   * them the moment it is mapped.
   */
  private async initialBlobSync(conn: MetaConnection): Promise<void> {
    const blobSync = this.plugin.blobSync;
    if (!blobSync) return;

    const listed = new Set(conn.bmap.keys());

    // Local attachments the listing has never heard of.
    for (const path of this.vault.listFiles(conn.localPath)) {
      const relPath = path.slice(conn.localPath.length + 1);
      if (kindOf(relPath) !== 'blob') continue;
      if (listed.has(relPath)) continue;
      blobSync.scheduleUpload(conn.sharedFolderId, relPath);
    }

    // Listed attachments this vault does not have, or has a different version
    // of. `download` decides: it returns early when the bytes already match,
    // and it never overwrites a differing local file without a conflict copy.
    for (const [relPath, entry] of conn.bmap.entries()) {
      if (conn.ymap.has(relPath)) continue; // refused elsewhere as ambiguous
      this.sequence(conn.sharedFolderId, relPath, () =>
        blobSync.download(conn.sharedFolderId, relPath, entry).then(() => undefined),
      );
    }
  }
}
