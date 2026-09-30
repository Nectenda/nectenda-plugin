import { Notice } from 'obsidian';
import { IndexeddbPersistence } from 'y-indexeddb';
import { loadSeqCheckpoint, saveSeqCheckpoint } from './seq-checkpoint';
import * as Y from 'yjs';
import { META_DOC_SUFFIX } from '@nectenda/shared';
import type { FileEntry, BlobEntry, StructuredEntry } from '@nectenda/shared';
import { BLOBS_MAP_KEY, LISTING_MAP_KEY, LISTING_VERSION, STRUCTURED_MAP_KEY } from '@nectenda/shared';
import { kindOf, type FileKind } from './blob-policy';
import { joinWithin } from './vault-path';
import type { BlobSync } from './blob-sync';
import type { DocIndex } from './doc-index';
import type { SyncProvider } from './provider-router';
import type { VaultAdapter } from './vault-adapter';
import type { ContentSync } from './content-sync';
import type { StructuredSync } from './structured-sync';
import { codecForFormat, codecForPath, STRUCTURED_FORMATS, type StructuredCodec } from './structured-formats';
import { writeConflictCopy } from './local-backup';
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
  /**
   * Structured files, under a third root, by the same argument as `bmap`: a
   * client that predates the kind never reads it and cannot act on it.
   */
  smap: Y.Map<StructuredEntry>;
  idbProvider: IndexeddbPersistence;
}

/**
 * What listing sync needs from the plugin around it.
 *
 * The same three as `ContentSyncDeps` — key possession, the path/document-id
 * index, and this vault's key for naming IndexedDB stores — plus attachments.
 *
 * `blobSync` is a function returning null rather than a value, and that is not
 * tidiness: it is genuinely absent for part of startup, because the meta
 * document is connected before attachment sync exists. Reading it once at
 * construction would capture the null and quietly never upload anything.
 */
export interface FileSyncDeps {
  /** Whether this device holds the folder's keys. Without them, no document id. */
  hasKeys(sharedFolderId: string): boolean;
  /** Path to document id and back. */
  docIndex: DocIndex;
  /** Which vault this is, for naming its IndexedDB stores. */
  vaultKey(): string;
  /** Attachment sync, once it exists. Null before then, and callers check. */
  blobSync(): BlobSync | null;
  /**
   * Structured formats by extension. Production omits it and gets
   * `STRUCTURED_FORMATS`; tests pass their own codec.
   */
  structuredFormats?: Readonly<Record<string, StructuredCodec>>;
}

export class FileSync {
  private deps: FileSyncDeps;
  private vault: VaultAdapter;
  private provider: SyncProvider;
  private contentSync: ContentSync | null = null;
  private structuredSync: StructuredSync | null = null;
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
  /**
   * Folders whose listing could not be placed on a connection, by local path,
   * held so `retryUnplaced` can try again when one appears.
   */
  private unplaced: Map<string, string> = new Map();
  private folderReadyListeners: ((sharedFolderId: string) => void)[] = [];

  constructor(deps: FileSyncDeps, provider: SyncProvider, vault: VaultAdapter) {
    this.deps = deps;
    this.vault = vault;
    this.provider = provider;
  }

  setContentSync(contentSync: ContentSync): void {
    this.contentSync = contentSync;
  }

  setStructuredSync(structuredSync: StructuredSync): void {
    this.structuredSync = structuredSync;
  }

  private get formats(): Readonly<Record<string, StructuredCodec>> {
    return this.deps.structuredFormats ?? STRUCTURED_FORMATS;
  }

  /**
   * What a path in a folder is, for the watcher.
   *
   * The listing decides before the name does. A path already listed as
   * structured stays structured even when this build has no codec for it — a
   * newer member shared it in a format this one cannot read — because reading
   * it by its name instead would upload it as an attachment and fork it.
   */
  classify(sharedFolderId: string, relativePath: string): FileKind {
    const conn = this.connections.get(sharedFolderId);
    // Listed as text wins over listed as structured, as `placeStructured`
    // decides: two roots claiming a path must not put two writers on it, and
    // the watcher must reach the same verdict or it reconnects what was refused.
    if (conn?.ymap.has(relativePath) && kindOf(relativePath, this.formats) !== 'ignore') return 'text';
    if (conn?.smap.has(relativePath)) return 'structured';
    return kindOf(relativePath, this.formats);
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
    if (!this.deps.hasKeys(sharedFolderId)) {
      log.warn('Folder has no encryption keys — not connecting it', { sharedFolderId });
      new Notice('Nectenda: no encryption key for a shared folder. Ask an owner to re-share it.');
      return;
    }

    // The listing's own id is derived like any other document, rather than
    // leaving `__meta__` in clear as a marker telling the server which blob is
    // the folder index.
    const docName = await this.deps.docIndex.ref(sharedFolderId, META_DOC_SUFFIX);
    const ydoc = new Y.Doc();
    const ymap = ydoc.getMap<FileEntry>('files');
    const bmap = ydoc.getMap<BlobEntry>(BLOBS_MAP_KEY);
    const smap = ydoc.getMap<StructuredEntry>(STRUCTURED_MAP_KEY);

    const idbProvider = new IndexeddbPersistence(idbStoreName(this.deps.vaultKey(), docName), ydoc);

    const startProvider = () => {
      // Subscribe meta doc via multiplexed provider. `startProvider` runs after
      // IndexedDB has loaded, which is what makes the checkpoint's state-vector
      // check meaningful.
      //
      // A subscribe that throws (the folder has no route to a server yet) used
      // to escape as an unhandled rejection: no listing, no observer, and no
      // line anywhere saying so. Then it was logged, and still never retried,
      // so a folder added the moment before its organisation's connection
      // opened stayed empty for the rest of the session. Now the half-built
      // listing is torn down and the folder waits for `retryUnplaced`, which
      // the router's `routes-changed` calls when a connection appears.
      try {
        this.provider.subscribe(docName, ydoc, {
          load: () => loadSeqCheckpoint(idbProvider, ydoc),
          save: (seq) => saveSeqCheckpoint(idbProvider, ydoc, seq),
        });
      } catch (err) {
        log.warn('Could not subscribe the folder listing', { sharedFolderId, error: String(err) });
        void idbProvider.destroy().catch((e: unknown) => {
          log.warn('IndexedDB teardown failed', { error: String(e) });
        });
        ydoc.destroy();
        this.unplaced.set(sharedFolderId, localPath);
        return;
      }

      const conn: MetaConnection = { sharedFolderId, localPath, ydoc, ymap, bmap, smap, idbProvider };
      this.connections.set(sharedFolderId, conn);
      log.debug('Folder listing subscribed', { sharedFolderId, listed: ymap.size });

      // Every change to the listing, and where it came from. The document's
      // name is redacted in this log, so without this a listing update and a
      // note's update look the same, and "the guest never received the
      // owner's new file" could not be told from "received and not acted on".
      //
      ydoc.on('update', (_update: Uint8Array, origin: unknown) => {
        log.debug(origin === LOCAL_ORIGIN ? 'Folder listing changed here' : 'Folder listing update received', {
          sharedFolderId,
          listed: ymap.size,
        });
      });

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

      smap.observe((event, transaction) => {
        if (transaction.origin === LOCAL_ORIGIN) return;
        this.handleRemoteStructuredChanges(conn, event);
      });

      // Initial sync once provider is connected
      const onSync = () => {
        this.provider.off(`synced:${docName}`, onSync);
        void this.initialSync(conn).catch((err: unknown) => {
          log.warn('Initial folder sync failed', { sharedFolderId: conn.sharedFolderId, error: String(err) });
        });
      };

      if (this.provider.isSynced(docName)) {
        void this.initialSync(conn).catch((err: unknown) => {
          log.warn('Initial folder sync failed', { sharedFolderId: conn.sharedFolderId, error: String(err) });
        });
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

  /**
   * Folder listings that could not be placed on a connection, tried again
   * now that one may have appeared. Through `connectFolder`, so the key check
   * applies exactly as on a first connect.
   */
  retryUnplaced(): void {
    if (this.unplaced.size === 0) return;
    const pending = [...this.unplaced];
    this.unplaced.clear();
    log.info('Retrying folder listings that had no connection', { count: pending.length });
    for (const [sharedFolderId, localPath] of pending) this.connectFolder(sharedFolderId, localPath);
  }

  disconnectFolder(sharedFolderId: string): void {
    // A folder that is let go of is not retried later: an unmapped folder
    // coming back when some unrelated connection opened would be a folder
    // syncing that nobody asked for.
    this.unplaced.delete(sharedFolderId);
    const conn = this.connections.get(sharedFolderId);
    if (!conn) return;

    const docName =
      this.deps.docIndex.refSync(sharedFolderId, META_DOC_SUFFIX) ??
      `${sharedFolderId}/${META_DOC_SUFFIX}`;
    this.provider.unsubscribe(docName);
    void conn.idbProvider.destroy().catch((err: unknown) => {
      log.warn('IndexedDB teardown failed', { error: String(err) });
    });
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
    log.debug('Folder listing changed remotely', {
      sharedFolderId: conn.sharedFolderId,
      added: added.length,
      deleted: deleted.length,
    });

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
        this.contentSync?.moveFile(conn.sharedFolderId, conn.localPath, oldRelPath, newRelPath);
        return;
      }
    }

    // Newly listed paths have to be derivable before they can be connected.
    if (added.length > 0) {
      // Caught: a throw in applyAdditions used to be an unhandled rejection,
      // so a listed file that never appeared left nothing behind.
      void this.deps.docIndex
        .warm(conn.sharedFolderId, added)
        .then(() => this.applyAdditions(conn, added))
        .catch((err: unknown) => {
          log.warn('Could not act on newly listed files', {
            sharedFolderId: conn.sharedFolderId,
            count: added.length,
            error: String(err),
          });
        });
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

      // A path that has become structured. Only a client that predates that
      // still writes its attachment entry, and what it writes cannot merge into
      // the structured document — so it is kept beside the file, never written
      // over it and never dropped (SAFE-A17). Its deletion is not honoured
      // either: the structured listing is the authority for this path now, and
      // keeping a file somebody deleted costs a file.
      if (conn.smap.has(key)) {
        if (change.action === 'delete') {
          log.info('An older client removed the attachment entry of a structured file; keeping the file', {
            relativePath: key,
          });
        } else if (entry) {
          this.keepAttachmentVersion(conn, key, entry);
        }
        continue;
      }

      if (change.action === 'delete') {
        // Structured by name: the structured listing decides whether this file
        // goes, even once its own entry has already gone. A vault that deletes
        // a file it adopted removes both entries, and they arrive here together
        // — the provider merges back-to-back updates — so the structured entry
        // is already absent by now. The attachment engine would compare the
        // file with bytes it last synced before adoption, find every edit
        // since, and keep the lot as a conflict copy of a deleted file.
        if (this.structuredSync && kindOf(key, this.formats) === 'structured') {
          log.debug('Attachment entry of a structured file removed; the structured listing decides', {
            relativePath: key,
          });
          continue;
        }
        this.sequence(conn.sharedFolderId, key, () =>
          this.deps.blobSync()?.removeLocal(conn.sharedFolderId, key) ?? Promise.resolve(),
        );
        continue;
      }
      if (!entry) continue;

      // Structured by name, listed only as an attachment: an older client made
      // it. Adopt it into the structured listing, keeping the attachment entry.
      if (this.structuredSync && kindOf(key, this.formats) === 'structured') {
        this.migrateAttachment(conn, key, entry);
        continue;
      }

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
        this.deps.blobSync()?.download(conn.sharedFolderId, key, entry).then(() => undefined)
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

  /** Whether the folder lists this path as structured. */
  isStructuredListed(sharedFolderId: string, relativePath: string): boolean {
    return this.connections.get(sharedFolderId)?.smap.has(relativePath) ?? false;
  }

  getStructuredEntry(sharedFolderId: string, relativePath: string): StructuredEntry | undefined {
    return this.connections.get(sharedFolderId)?.smap.get(relativePath);
  }

  /** List a structured file. False when the listing is not open yet. */
  setStructuredEntry(sharedFolderId: string, relativePath: string, entry: StructuredEntry): boolean {
    const conn = this.connections.get(sharedFolderId);
    if (!conn) return false;
    conn.ydoc.transact(() => conn.smap.set(relativePath, entry), LOCAL_ORIGIN);
    return true;
  }

  removeStructuredEntry(sharedFolderId: string, relativePath: string): boolean {
    const conn = this.connections.get(sharedFolderId);
    if (!conn?.smap.has(relativePath)) return false;
    conn.ydoc.transact(() => conn.smap.delete(relativePath), LOCAL_ORIGIN);
    return true;
  }

  /** Move a structured entry, in one transaction so peers see a rename. */
  renameStructuredEntry(sharedFolderId: string, from: string, to: string): boolean {
    const conn = this.connections.get(sharedFolderId);
    const entry = conn?.smap.get(from);
    if (!conn || !entry) return false;
    conn.ydoc.transact(() => {
      conn.smap.delete(from);
      conn.smap.set(to, entry);
    }, LOCAL_ORIGIN);
    return true;
  }

  /** The entry for a local structured file, from what is on disk. */
  structuredEntryFor(localFilePath: string, relativePath: string, blobHash?: string): StructuredEntry | null {
    const codec = codecForPath(relativePath, this.formats);
    if (!codec) return null;
    const stat = this.vault.stat(localFilePath) ?? { size: 0, mtime: Date.now() };
    return blobHash ? { ...stat, format: codec.format, blobHash } : { ...stat, format: codec.format };
  }

  /**
   * Structured files appearing, vanishing or renamed in the listing — the text
   * path's handling, for the third root.
   */
  private handleRemoteStructuredChanges(conn: MetaConnection, event: Y.YMapEvent<StructuredEntry>): void {
    const structuredSync = this.structuredSync;
    if (!structuredSync) return;
    const added: string[] = [];
    const deleted: string[] = [];
    for (const [key, change] of event.changes.keys) {
      if (change.action === 'add') added.push(key);
      else if (change.action === 'delete') deleted.push(key);
      // 'update' is a changed entry for the same path — a newer stat, or a
      // recorded attachment hash. Nothing on disk follows from it.
    }

    if (deleted.length === 1 && added.length === 1) {
      const from = deleted[0];
      const to = added[0];
      const fromLocal = joinWithin(conn.localPath, from);
      const toLocal = joinWithin(conn.localPath, to);
      if (!fromLocal || !toLocal) {
        log.warn('Refused a rename whose name leaves the folder', { folder: conn.sharedFolderId });
        return;
      }
      if (this.vault.isFile(fromLocal)) {
        this.vault.rename(fromLocal, toLocal).catch((err: unknown) => {
          log.error(`Failed to rename ${fromLocal} → ${toLocal}:`, err);
        });
        // `fill: false`: the vault that renamed it fills the new document.
        // This copy may be the staler one, and two fills collide.
        structuredSync.moveFile(conn.sharedFolderId, conn.localPath, from, to, conn.smap.get(to)?.format, {
          fill: false,
        });
        return;
      }
    }

    if (added.length > 0) {
      void this.deps.docIndex
        .warm(conn.sharedFolderId, added)
        .then(() => {
          for (const key of added) this.placeStructured(conn, key);
        })
        .catch((err: unknown) => {
          log.warn('Could not act on newly listed structured files', {
            sharedFolderId: conn.sharedFolderId, count: added.length, error: String(err),
          });
        });
    }

    for (const key of deleted) {
      this.sequence(conn.sharedFolderId, key, () =>
        this.completeRemoteDeletion(conn.sharedFolderId, conn.localPath, key),
      );
    }
  }

  /** Make a listed structured file exist here and follow it. */
  private placeStructured(conn: MetaConnection, key: string): void {
    const structuredSync = this.structuredSync;
    if (!structuredSync) return;
    // Two roots claiming one path would put two writers on one file. The text
    // listing is the older and wins; this one is refused, out loud.
    if (conn.ymap.has(key)) {
      log.error('Path listed as both text and structured; ignoring the structured entry', {
        relativePath: key,
      });
      return;
    }
    const localFilePath = joinWithin(conn.localPath, key);
    if (!localFilePath) {
      log.warn('Refused a shared file whose name leaves the folder', { folder: conn.sharedFolderId });
      return;
    }
    const format = conn.smap.get(key)?.format;
    // A format this build cannot read: say so, and create nothing. An empty
    // placeholder would look like the file, emptied (SAFE-A16).
    if (format !== undefined && !codecForFormat(format, this.formats)) {
      structuredSync.connectFile(conn.sharedFolderId, conn.localPath, key, format);
      return;
    }
    if (!this.vault.exists(localFilePath)) {
      this.sequence(conn.sharedFolderId, key, () =>
        this.createLocalFile(conn.sharedFolderId, key, localFilePath, () =>
          structuredSync.connectFile(conn.sharedFolderId, conn.localPath, key, format),
        ),
      );
    } else {
      structuredSync.connectFile(conn.sharedFolderId, conn.localPath, key, format);
    }
  }

  /**
   * Adopt an attachment as a structured file (step one of a format's
   * migration). The attachment entry stays: a client that predates the kind
   * still reads it, and removing it would read to that client as a deletion
   * and trash the file there (SAFE-A17). It goes when the file is deleted or
   * renamed (VaultWatcher's `forgetAttachmentEntry`), or this would adopt it
   * back on the next connect. The file is downloaded first when
   * this vault does not have it, so the structured document is filled from the
   * attachment's content rather than from nothing.
   */
  private migrateAttachment(conn: MetaConnection, key: string, entry: BlobEntry): void {
    if (conn.smap.has(key) || conn.ymap.has(key)) return;
    const localFilePath = joinWithin(conn.localPath, key);
    if (!localFilePath) return;
    this.sequence(conn.sharedFolderId, key, async () => {
      // Only a file this vault did not have is known to hold the attachment's
      // bytes afterwards, so only then is its version recorded as carried
      // across. A file already here may differ, and is compared by
      // `keepAttachmentVersion` instead of being assumed equal.
      let carried: string | undefined;
      if (!this.vault.exists(localFilePath)) {
        // Marked as the listing's own create, so the watcher follows the file
        // rather than listing it itself — without the hash only this knows.
        const marker = `${conn.sharedFolderId}\u0000${key}`;
        this.remoteCreates.add(marker);
        try {
          const wrote = await this.deps.blobSync()?.download(conn.sharedFolderId, key, entry);
          if (wrote) carried = entry.hash;
        } finally {
          window.setTimeout(() => this.remoteCreates.delete(marker), 0);
        }
      }
      if (!this.vault.isFile(localFilePath)) return;
      const already = conn.smap.get(key);
      if (already) {
        // Listed meanwhile, by another vault. Record what was carried, which
        // that vault could not know about this copy.
        if (carried && !already.blobHash) {
          conn.ydoc.transact(() => conn.smap.set(key, { ...already, blobHash: carried }), LOCAL_ORIGIN);
        }
        return;
      }
      const listed = this.structuredEntryFor(localFilePath, key, carried);
      if (!listed) return;
      conn.ydoc.transact(() => conn.smap.set(key, listed), LOCAL_ORIGIN);
      log.info('Adopted an attachment as a structured file', { relativePath: key, format: listed.format });
      await this.deps.docIndex.warm(conn.sharedFolderId, [key]);
      this.structuredSync?.connectFile(conn.sharedFolderId, conn.localPath, key, listed.format);
      if (!carried) this.keepAttachmentVersion(conn, key, entry);
    });
  }

  /**
   * An attachment version of a structured file that has not been kept yet:
   * written by a client that predates the kind, after the file became
   * structured. Downloaded beside the file as a conflict copy, once — the hash
   * is recorded on the structured entry so a restart does not copy it again.
   */
  private keepAttachmentVersion(conn: MetaConnection, key: string, entry: BlobEntry): void {
    const listed = conn.smap.get(key);
    if (!listed || listed.blobHash === entry.hash) return;
    this.sequence(conn.sharedFolderId, key, async () => {
      const blobSync = this.deps.blobSync();
      if (!blobSync) return;
      const current = conn.smap.get(key);
      if (!current || current.blobHash === entry.hash) return;
      const outcome = await blobSync.keepAsConflictCopy(conn.sharedFolderId, key, entry);
      // Recorded for `same` as well: the file already holds exactly these
      // bytes, which is as kept as it gets. A failure leaves the hash
      // unrecorded, so the next start tries again rather than forgetting it.
      if (outcome !== 'failed') {
        conn.ydoc.transact(() => conn.smap.set(key, { ...current, blobHash: entry.hash }), LOCAL_ORIGIN);
      }
      if (outcome === 'kept') {
        log.warn('An older client changed a structured file; kept its version as a conflict copy', {
          relativePath: key,
        });
      }
    });
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
    this.structuredSync?.disconnectFile(sharedFolderId, relativePath);
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
    const docName = this.deps.docIndex.refSync(sharedFolderId, relativePath);
    if (!docName) return;
    // Whichever engine holds the document knows whether the file has work the
    // network has not seen. A path is one kind, so at most one of them does.
    const engine = this.contentSync?.hasDoc(docName)
      ? this.contentSync
      : this.structuredSync?.hasDoc(docName) ? this.structuredSync : null;
    if (!engine) return;
    const unsynced = await engine.unsyncedLocalContent(docName);
    if (unsynced === null) return; // Disk matched the synced document; nothing at risk.

    const copyPath = await writeConflictCopy(this.vault, localFilePath, unsynced);
    if (!copyPath) return;
    log.warn('Remote deletion would have discarded local edits — saved a conflict copy', {
      original: localFilePath,
      copy: copyPath,
    });
    new Notice(`Nectenda: "${relativePath}" was deleted elsewhere. Your changes were saved as a conflict copy.`);
  }

  /** Whether this path is being created on the folder listing's instruction. */
  isRemoteCreate(sharedFolderId: string, relativePath: string): boolean {
    return this.remoteCreates.has(`${sharedFolderId}\u0000${relativePath}`);
  }

  private createLocalFileWithContent(
    sharedFolderId: string,
    folderLocalPath: string,
    relativePath: string,
    localFilePath: string,
  ): Promise<void> {
    return this.createLocalFile(sharedFolderId, relativePath, localFilePath, () =>
      this.contentSync?.connectFile(sharedFolderId, folderLocalPath, relativePath),
    );
  }

  /**
   * Create an empty placeholder for a listed file, then hand it to the engine
   * that will fill it. Shared by text and structured files; `connect` is the
   * only part that differs.
   */
  private async createLocalFile(
    sharedFolderId: string,
    relativePath: string,
    localFilePath: string,
    connect: () => void,
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

      connect();
    } catch (err) {
      log.error(`Failed to create ${localFilePath}:`, err);
    } finally {
      // Cleared on the next tick, not immediately: Obsidian delivers the vault
      // 'create' event after the create resolves, so clearing here would let
      // the very event this exists to suppress through.
      window.setTimeout(() => this.remoteCreates.delete(marker), 0);
    }
  }

  private async initialSync(conn: MetaConnection): Promise<void> {
    log.debug('Folder listing synced — reconciling with disk', {
      sharedFolderId: conn.sharedFolderId,
      listed: conn.ymap.size,
      folderExists: this.vault.isFolder(conn.localPath),
    });
    if (!this.vault.isFolder(conn.localPath)) return;

    // The listing is how paths become known for documents this vault has never
    // opened, so its keys are derived before anything acts on them.
    await this.deps.docIndex.warm(conn.sharedFolderId, Array.from(conn.ymap.keys()));

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
        void this.createLocalFileWithContent(conn.sharedFolderId, conn.localPath, relPath, localFilePath)
          .catch((err: unknown) => {
            log.warn('Could not create a file the listing named', { error: String(err) });
          });
      }
    }

    await this.initialStructuredSync(conn);
    await this.initialBlobSync(conn);
  }

  /**
   * Reconcile structured files once, on connect: list local ones the listing
   * lacks, adopt attachments whose format is now structured, place what the
   * listing names, and keep any attachment version an older client wrote.
   *
   * Before the attachment sweep, deliberately: a path adopted here must be in
   * the structured listing by the time that sweep asks, or it would be
   * uploaded as an attachment again.
   */
  private async initialStructuredSync(conn: MetaConnection): Promise<void> {
    const structuredSync = this.structuredSync;
    if (!structuredSync) return;

    // Local structured files the listing has never heard of — new ones, and
    // attachments this build now reads as structured. Their attachment entry,
    // if any, is left exactly where it is (SAFE-A17). Its hash is deliberately
    // not recorded here: the file on disk may differ from it, and recording it
    // would mark that version kept without anyone having compared the bytes.
    // The sweep at the end compares, and records it once it has.
    const enrolled: Array<[string, StructuredEntry]> = [];
    for (const path of this.vault.listFiles(conn.localPath)) {
      const relPath = path.slice(conn.localPath.length + 1);
      if (kindOf(relPath, this.formats) !== 'structured') continue;
      if (conn.smap.has(relPath)) continue;
      if (conn.ymap.has(relPath)) {
        log.error('Path listed as text but named as structured; leaving it as text', { relativePath: relPath });
        continue;
      }
      const entry = this.structuredEntryFor(path, relPath);
      if (entry) enrolled.push([relPath, entry]);
    }
    if (enrolled.length > 0) {
      conn.ydoc.transact(() => {
        for (const [relPath, entry] of enrolled) conn.smap.set(relPath, entry);
      }, LOCAL_ORIGIN);
    }

    // Attachments of a structured format that this vault does not have at all:
    // download, then adopt.
    for (const [relPath, entry] of conn.bmap.entries()) {
      if (conn.smap.has(relPath) || conn.ymap.has(relPath)) continue;
      if (kindOf(relPath, this.formats) !== 'structured') continue;
      this.migrateAttachment(conn, relPath, entry);
    }

    await this.deps.docIndex.warm(conn.sharedFolderId, Array.from(conn.smap.keys()));
    for (const relPath of conn.smap.keys()) this.placeStructured(conn, relPath);

    for (const [relPath, entry] of conn.bmap.entries()) {
      if (conn.smap.has(relPath)) this.keepAttachmentVersion(conn, relPath, entry);
    }
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
    const blobSync = this.deps.blobSync();
    if (!blobSync) return;

    const listed = new Set(conn.bmap.keys());

    // Local attachments the listing has never heard of.
    for (const path of this.vault.listFiles(conn.localPath)) {
      const relPath = path.slice(conn.localPath.length + 1);
      if (kindOf(relPath, this.formats) !== 'blob') continue;
      if (conn.smap.has(relPath)) continue; // structured in the listing, whatever its name
      if (listed.has(relPath)) continue;
      blobSync.scheduleUpload(conn.sharedFolderId, relPath);
    }

    // Listed attachments this vault does not have, or has a different version
    // of. `download` decides: it returns early when the bytes already match,
    // and it never overwrites a differing local file without a conflict copy.
    for (const [relPath, entry] of conn.bmap.entries()) {
      if (conn.ymap.has(relPath)) continue; // refused elsewhere as ambiguous
      // Structured now: handled above, as a migration or a kept version, and
      // never written over the file.
      if (conn.smap.has(relPath) || kindOf(relPath, this.formats) === 'structured') continue;
      this.sequence(conn.sharedFolderId, relPath, () =>
        blobSync.download(conn.sharedFolderId, relPath, entry).then(() => undefined),
      );
    }
  }
}
