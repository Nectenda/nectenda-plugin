import type { FileEntry } from '@nectenda/shared';
import type { App, EventRef } from 'obsidian';
import type { FolderMapping } from './folder-mapping';
import type { FileSync } from './file-sync';
import type { ContentSync } from './content-sync';
import type { VaultAdapter } from './vault-adapter';
import { mappingRootedAt, resolveMapping } from './folder-mapping';
import { kindOf } from './blob-policy';
import type { BlobSync } from './blob-sync';
import type { StructuredSync } from './structured-sync';
import { log } from './logger';

/**
 * Was `isMarkdown`. Every handler below used to refuse anything that was not
 * `.md`, which is why an attachment dropped into a shared folder simply did not
 * exist as far as sync was concerned.
 *
 * The gate is now three-way: text keeps the Y.Text path it always had,
 * attachments go to BlobSync, and dot-paths are refused outright.
 */
const isText = (path: string): boolean => kindOf(path) === 'text';
const isBlob = (path: string): boolean => kindOf(path) === 'blob';

const LOCAL_ORIGIN = 'local';

/**
 * What the vault watcher needs from the plugin around it.
 *
 * Three things, and two of them are Obsidian rather than Nectenda. `app` is
 * the vault and workspace it listens to; `registerEvent` is the plugin's event
 * lifetime, and is here rather than being replaced by a plain `on` because
 * that lifetime is the thing that matters — a listener not registered through
 * it outlives the plugin being disabled and fires against a torn-down watcher.
 */
export interface VaultWatcherDeps {
  app: App;
  /** Tie a listener to the plugin's lifetime, so unload really unloads it. */
  registerEvent(ref: EventRef): void;
  /** The shared folders mapped into this vault. Read live; mappings change. */
  mappings(): FolderMapping[];
  /**
   * A mapped folder was renamed in the vault. The watcher recognises it and
   * hands it on; deciding what that means to the rest of the plugin is not
   * its business.
   */
  onMappedFolderRename(oldPath: string, newPath: string, moved?: FolderMapping): Promise<void>;
}

export class VaultWatcher {
  private deps: VaultWatcherDeps;
  private vault: VaultAdapter;
  private fileSync: FileSync;
  private contentSync: ContentSync | null;
  private blobSync: BlobSync | null;
  private structuredSync: StructuredSync | null;
  private started = false;
  /**
   * Local creates seen before their folder's listing document existed, by
   * folder id, keyed on the full vault path.
   *
   * A Set so a file created, deleted and created again inside the window
   * replays once, and so the replay is idempotent if the listing somehow
   * announces twice.
   */
  private pendingCreates: Map<string, Set<string>> = new Map();
  /**
   * The mapped folder Obsidian is in the middle of renaming.
   *
   * Set when the folder's own event arrives and cleared when the plugin has
   * finished with it, which is after the per-file events it drags along. It
   * exists only so those can be recognised and ignored.
   */
  private renameInFlight: { from: string; to: string } | null = null;

  constructor(
    deps: VaultWatcherDeps,
    fileSync: FileSync,
    contentSync: ContentSync | null,
    vault: VaultAdapter,
    blobSync: BlobSync | null = null,
    structuredSync: StructuredSync | null = null,
  ) {
    this.deps = deps;
    this.vault = vault;
    this.fileSync = fileSync;
    this.contentSync = contentSync;
    this.blobSync = blobSync;
    this.structuredSync = structuredSync;

    // Subscribed in the constructor rather than in start(), because the gap
    // this closes opens before start() is called.
    this.fileSync.onFolderReady((sharedFolderId) => this.replayPendingCreates(sharedFolderId));
  }

  /**
   * Re-run the creates that arrived before this folder had a listing.
   *
   * Only files still present are replayed. A file created and then deleted
   * inside the window is gone by intention, and adding it to the listing now
   * would announce a file that does not exist to every other vault.
   */
  private replayPendingCreates(sharedFolderId: string): void {
    const pending = this.pendingCreates.get(sharedFolderId);
    if (!pending || pending.size === 0) return;
    this.pendingCreates.delete(sharedFolderId);

    for (const path of pending) {
      if (!this.vault.exists(path)) {
        log.debug('Deferred create skipped — the file is gone', { path });
        continue;
      }
      log.debug('Replaying a create that arrived before the listing', { path });
      this.handleCreate(path);
    }
  }

  start(): void {
    if (this.started) return;
    this.started = true;

    // Register inside onLayoutReady to avoid vault-load events
    this.deps.app.workspace.onLayoutReady(() => {
      this.deps.registerEvent(
        this.deps.app.vault.on('create', (file) => this.handleCreate(file.path))
      );
      this.deps.registerEvent(
        this.deps.app.vault.on('delete', (file) => this.handleDelete(file.path))
      );
      this.deps.registerEvent(
        this.deps.app.vault.on('rename', (file, oldPath) => this.handleRename(file.path, oldPath))
      );
      this.deps.registerEvent(
        this.deps.app.vault.on('modify', (file) => this.handleModify(file.path))
      );
    });
  }

  stop(): void {
    this.started = false;
    // Event refs are cleaned up by plugin.registerEvent on unload
  }

  /**
   * Handlers take paths rather than Obsidian files so they can be driven
   * directly in tests. Obsidian still delivers the events; only the logic below
   * is decoupled.
   */
  /**
   * Every early return here drops a newly created file out of sync silently,
   * and the file on disk looks perfectly correct afterwards — the failure mode
   * this codebase treats as the worst one. They were also unlogged, which cost
   * three CI runs: the plugin's diagnostic log showed a clean startup and then
   * sixty seconds of nothing while a note sat in the vault unsynced, and the
   * silence could not distinguish "the event never arrived" from any of the
   * four refusals below.
   *
   * DEBUG rather than WARN: two of these are ordinary (a dot-file, a note
   * outside any shared folder) and would be noise at a level anyone reads by
   * default.
   */
  handleCreate(path: string): void {
    if (!this.started) {
      log.debug('Create ignored — watcher not started', { path });
      return;
    }
    if (this.isStructured(path)) {
      this.handleStructuredCreate(path);
      return;
    }
    if (isBlob(path)) {
      this.handleBlobCreate(path);
      return;
    }
    if (!isText(path)) {
      log.debug('Create ignored — neither text nor attachment', { path });
      return;
    }

    const resolved = this.resolveFile(path);
    if (!resolved) {
      log.debug('Create ignored — path is in no mapped folder', {
        path,
        mappings: this.deps.mappings().map((m) => m.localPath),
      });
      return;
    }

    const { sharedFolderId, relativePath } = resolved;
    const ydoc = this.fileSync.getYDoc(sharedFolderId);
    const ymap = this.fileSync.getYMap(sharedFolderId);
    if (!ydoc || !ymap) {
      // The folder resolved but its listing document is not open yet: the id is
      // derived asynchronously and IndexedDB then has to load. Hold the create
      // and replay it when FileSync says the listing is ready.
      //
      // It used to be dropped here, and nothing revisited it — the folder scan
      // that would have found the file had already run and marked the folder
      // scanned. The note stayed on disk, looking correct, and reached no other
      // vault. CI found it because the runner is slow enough to widen a window
      // that is a few milliseconds on a laptop; a large vault or a cold disk
      // would do the same to a user.
      let pending = this.pendingCreates.get(sharedFolderId);
      if (!pending) {
        pending = new Set();
        this.pendingCreates.set(sharedFolderId, pending);
      }
      pending.add(path);
      log.debug('Create deferred — folder has no listing document yet', {
        path,
        sharedFolderId,
        hasYDoc: !!ydoc,
        hasYMap: !!ymap,
      });
      return;
    }

    log.debug('Create accepted', { path, sharedFolderId, relativePath });

    // A file FileSync is creating on the folder listing's instruction is not a
    // new local file, and writing it back into the listing resurrects notes
    // that were deleted while this vault was away. It is already listed, or it
    // would not be being created.
    if (this.fileSync.isRemoteCreate(sharedFolderId, relativePath)) {
      this.contentSync?.connectFile(
        sharedFolderId,
        this.deps.mappings().find((m) => m.sharedFolderId === sharedFolderId)
          ?.localPath ?? '',
        relativePath,
      );
      return;
    }

    ydoc.transact(() => {
      const entry: FileEntry = this.vault.stat(path) ?? { size: 0, mtime: Date.now() };
      ymap.set(relativePath, entry);
    }, LOCAL_ORIGIN);

    // Connect the new file for background sync
    if (this.contentSync) {
      const mapping = this.deps.mappings().find(m => m.sharedFolderId === sharedFolderId);
      if (mapping) {
        this.contentSync.connectFile(sharedFolderId, mapping.localPath, relativePath);
      }
    }
  }

  handleDelete(path: string): void {
    if (!this.started) return;

    if (this.isStructured(path)) {
      const resolved = this.resolveFile(path);
      if (!resolved) return;
      this.forgetStructured(resolved.sharedFolderId, resolved.relativePath);
      return;
    }

    if (isBlob(path)) {
      const resolved = this.resolveFile(path);
      if (!resolved || !this.blobSync) return;
      const entry = this.fileSync.removeBlobEntry(resolved.sharedFolderId, resolved.relativePath);
      // The bytes are only reclaimable by the client that noticed the deletion;
      // the server cannot read the listing and so cannot work out that nothing
      // references them any more.
      if (entry) void this.blobSync.deleteRemote(resolved.sharedFolderId, entry.blobId);
      return;
    }

    if (!isText(path)) return;

    const resolved = this.resolveFile(path);
    if (!resolved) return;

    const { sharedFolderId, relativePath } = resolved;
    const ydoc = this.fileSync.getYDoc(sharedFolderId);
    const ymap = this.fileSync.getYMap(sharedFolderId);
    if (!ydoc || !ymap) return;

    ydoc.transact(() => {
      ymap.delete(relativePath);
    }, LOCAL_ORIGIN);

    // Discard the document on the server as well. Nothing else ever removes
    // it, so a deleted file's updates would otherwise sit there for ever.
    this.contentSync?.deleteRemote(sharedFolderId, relativePath);
  }

  handleRename(path: string, oldPath: string): void {
    if (!this.started) return;

    // A mapped folder's own root, renamed. Checked before the text/blob split
    // because a directory is neither — `kindOf` calls anything without `.md` a
    // blob, so this used to fall into `handleBlobRename`, match none of its
    // branches, and do nothing at all.
    const root = mappingRootedAt(oldPath, this.deps.mappings());
    if (root) {
      // Moved **here and now**, not inside the async call below. Obsidian
      // follows a folder rename with one event per file inside it, delivered
      // before any promise started here can resolve — measured: the folder at
      // T, its eight files at T+2ms, and an awaited handler not reaching the
      // mapping until T+7ms. Those file events would still see the old
      // `localPath`, so each one resolved under the old root and matched none
      // under the new: the "moved out of a shared folder" branch, which
      // **deletes the file from the folder's listing**. Renaming a folder
      // announced every note in it as deleted to every other vault.
      root.localPath = path;
      this.renameInFlight = { from: oldPath, to: path };
      void this.deps.onMappedFolderRename(oldPath, path, root);
      return;
    }

    // A file carried along by the rename above. Its path within the folder has
    // not changed, so there is nothing to announce — and treating it as a new
    // arrival would re-add what is already listed and re-upload every
    // attachment in the folder.
    if (this.movedWithItsFolder(path, oldPath)) return;

    if (this.isStructured(oldPath) || this.isStructured(path)) {
      this.handleStructuredRename(path, oldPath);
      return;
    }

    if (isBlob(path)) {
      this.handleBlobRename(path, oldPath);
      return;
    }
    if (!isText(path)) return;

    const oldResolved = this.resolveFile(oldPath);
    const newResolved = this.resolveFile(path);

    // Handle rename within same shared folder
    if (oldResolved && newResolved && oldResolved.sharedFolderId === newResolved.sharedFolderId) {
      const ydoc = this.fileSync.getYDoc(oldResolved.sharedFolderId);
      const ymap = this.fileSync.getYMap(oldResolved.sharedFolderId);
      if (!ydoc || !ymap) return;

      ydoc.transact(() => {
        ymap.delete(oldResolved.relativePath);
        const entry: FileEntry = this.vault.stat(path) ?? { size: 0, mtime: Date.now() };
        ymap.set(newResolved.relativePath, entry);
      }, LOCAL_ORIGIN);

      // Disconnect old, connect new for background sync
      if (this.contentSync) {
        const mapping = this.deps.mappings().find(m => m.sharedFolderId === newResolved.sharedFolderId);
        if (mapping) {
          this.contentSync.moveFile(newResolved.sharedFolderId, mapping.localPath, oldResolved.relativePath, newResolved.relativePath);
        } else {
          this.contentSync.disconnectFile(oldResolved.sharedFolderId, oldResolved.relativePath);
        }
      }
      return;
    }

    // File moved OUT of a shared folder
    if (oldResolved && !newResolved) {
      const ydoc = this.fileSync.getYDoc(oldResolved.sharedFolderId);
      const ymap = this.fileSync.getYMap(oldResolved.sharedFolderId);
      if (ydoc && ymap) {
        ydoc.transact(() => {
          ymap.delete(oldResolved.relativePath);
        }, LOCAL_ORIGIN);
      }
      if (this.contentSync) {
        this.contentSync.disconnectFile(oldResolved.sharedFolderId, oldResolved.relativePath);
      }
    }

    // File moved INTO a shared folder
    if (!oldResolved && newResolved) {
      const ydoc = this.fileSync.getYDoc(newResolved.sharedFolderId);
      const ymap = this.fileSync.getYMap(newResolved.sharedFolderId);
      if (ydoc && ymap) {
        ydoc.transact(() => {
          const entry: FileEntry = this.vault.stat(path) ?? { size: 0, mtime: Date.now() };
          ymap.set(newResolved.relativePath, entry);
        }, LOCAL_ORIGIN);
      }
      if (this.contentSync) {
        const mapping = this.deps.mappings().find(m => m.sharedFolderId === newResolved.sharedFolderId);
        if (mapping) {
          this.contentSync.connectFile(newResolved.sharedFolderId, mapping.localPath, newResolved.relativePath);
        }
      }
    }
  }

  /** Background sync: when a shared file is modified on disk, update the Y.Doc */
  handleModify(path: string): void {
    if (!this.started) return;

    if (this.isStructured(path)) {
      const resolved = this.resolveFile(path);
      if (!resolved || !this.structuredSync) return;
      void this.structuredSync.onLocalModify(resolved.sharedFolderId, resolved.relativePath)
        .catch((err: unknown) => {
          log.warn('Local modification did not reach the structured document', { error: String(err) });
        });
      return;
    }

    if (isBlob(path)) {
      const resolved = this.resolveFile(path);
      if (!resolved || !this.blobSync) return;
      // Our own write, echoed back. Without this every download would re-upload
      // itself under a fresh id, for ever.
      if (this.blobSync.shouldIgnoreModify(resolved.sharedFolderId, resolved.relativePath)) return;
      this.blobSync.scheduleUpload(resolved.sharedFolderId, resolved.relativePath);
      return;
    }

    if (!isText(path)) return;
    if (!this.contentSync) return;

    const resolved = this.resolveFile(path);
    if (!resolved) return;

    void this.contentSync.onLocalModify(resolved.sharedFolderId, resolved.relativePath)
      .catch((err: unknown) => {
        log.warn('Local modification did not reach the document', { error: String(err) });
      });
  }

  /**
   * An attachment renamed or moved.
   *
   * Within one folder the entry **moves, keeping its blobId**. Obsidian renames
   * on almost every link edit, so re-minting would re-encrypt and re-send the
   * whole file because somebody corrected a filename.
   */
  private handleBlobRename(path: string, oldPath: string): void {
    const oldResolved = this.resolveFile(oldPath);
    const newResolved = this.resolveFile(path);

    if (oldResolved && newResolved && oldResolved.sharedFolderId === newResolved.sharedFolderId) {
      if (!this.fileSync.renameBlobEntry(
        oldResolved.sharedFolderId, oldResolved.relativePath, newResolved.relativePath,
      )) {
        // Not listed yet — it was created and renamed before the upload
        // finished. Treat it as new rather than losing it.
        this.blobSync?.scheduleUpload(newResolved.sharedFolderId, newResolved.relativePath);
      }
      return;
    }

    // Moved out of a shared folder: it stops being shared, and the bytes are
    // reclaimed because nothing references them any more.
    if (oldResolved && !newResolved) {
      const entry = this.fileSync.removeBlobEntry(
        oldResolved.sharedFolderId, oldResolved.relativePath,
      );
      if (entry) void this.blobSync?.deleteRemote(oldResolved.sharedFolderId, entry.blobId);
      return;
    }

    // Moved in: upload it like any other new attachment.
    if (!oldResolved && newResolved) {
      this.blobSync?.scheduleUpload(newResolved.sharedFolderId, newResolved.relativePath);
    }
  }

  /**
   * Whether a path is a structured file: listed as one, or named as one.
   *
   * Asked before the text/attachment split, and of the listing first, so a
   * file shared as structured by a newer member is never re-read here by its
   * extension and uploaded as an attachment beside itself.
   */
  private isStructured(path: string): boolean {
    const resolved = this.resolveFile(path);
    // Outside every shared folder nothing is synced, whatever its kind.
    if (!resolved) return false;
    return this.fileSync.classify(resolved.sharedFolderId, resolved.relativePath) === 'structured';
  }

  /** A new structured file, or one arriving from the listing. */
  private handleStructuredCreate(path: string): void {
    const resolved = this.resolveFile(path);
    if (!resolved) return;
    const { sharedFolderId, relativePath } = resolved;
    const mapping = this.deps.mappings().find((m) => m.sharedFolderId === sharedFolderId);
    if (!mapping || !this.structuredSync) return;

    // Before the listing is open there is nowhere to record it; held and
    // replayed exactly as a note is (SAFE-A7).
    if (!this.fileSync.getYDoc(sharedFolderId)) {
      let pending = this.pendingCreates.get(sharedFolderId);
      if (!pending) {
        pending = new Set();
        this.pendingCreates.set(sharedFolderId, pending);
      }
      pending.add(path);
      log.debug('Structured create deferred — folder has no listing document yet', { path, sharedFolderId });
      return;
    }

    // Created on the listing's instruction, or already listed: follow it,
    // announce nothing.
    const listed = this.fileSync.getStructuredEntry(sharedFolderId, relativePath);
    if (listed || this.fileSync.isRemoteCreate(sharedFolderId, relativePath)) {
      this.structuredSync.connectFile(sharedFolderId, mapping.localPath, relativePath, listed?.format);
      return;
    }

    const entry = this.fileSync.structuredEntryFor(path, relativePath);
    if (!entry) return;
    this.fileSync.setStructuredEntry(sharedFolderId, relativePath, entry);
    this.structuredSync.connectFile(sharedFolderId, mapping.localPath, relativePath, entry.format);
  }

  /**
   * A structured file renamed or moved, or a file renamed into or out of a
   * structured format.
   *
   * Within one folder and still structured, the entry moves in one
   * transaction, which peers see as a rename. Anything else changes what kind
   * of file this is, and is honestly a removal of the old path and an arrival
   * of the new one — each then handled by the kind it now has.
   */
  private handleStructuredRename(path: string, oldPath: string): void {
    const oldResolved = this.resolveFile(oldPath);
    const newResolved = this.resolveFile(path);
    const oldStructured = oldResolved !== null && this.fileSync.isStructuredListed(
      oldResolved.sharedFolderId, oldResolved.relativePath,
    );

    // The echo of a rename the listing asked for: the entry has already moved,
    // so the old path is unlisted and the new one listed. FileSync has moved
    // the document too. Treating it as a deletion here would purge the old
    // document from the server — something the vault that made the rename
    // deliberately does not do.
    if (
      !oldStructured && oldResolved && newResolved &&
      oldResolved.sharedFolderId === newResolved.sharedFolderId &&
      this.fileSync.isStructuredListed(newResolved.sharedFolderId, newResolved.relativePath)
    ) {
      return;
    }

    if (
      oldResolved && newResolved && oldStructured &&
      oldResolved.sharedFolderId === newResolved.sharedFolderId &&
      // By name: the new path is not listed yet, and this is the question of
      // whether it is still a structured file at all.
      this.fileSync.classify(newResolved.sharedFolderId, newResolved.relativePath) === 'structured'
    ) {
      const { sharedFolderId } = newResolved;
      const kept = this.fileSync.getStructuredEntry(sharedFolderId, oldResolved.relativePath)?.blobHash;
      if (this.fileSync.renameStructuredEntry(sharedFolderId, oldResolved.relativePath, newResolved.relativePath)) {
        this.forgetAttachmentEntry(sharedFolderId, oldResolved.relativePath, kept);
        const mapping = this.deps.mappings().find((m) => m.sharedFolderId === sharedFolderId);
        const format = this.fileSync.getStructuredEntry(sharedFolderId, newResolved.relativePath)?.format;
        if (mapping) {
          this.structuredSync?.moveFile(
            sharedFolderId, mapping.localPath, oldResolved.relativePath, newResolved.relativePath, format,
          );
        }
        return;
      }
    }

    if (oldStructured && oldResolved) {
      this.forgetStructured(oldResolved.sharedFolderId, oldResolved.relativePath);
    } else if (oldResolved) {
      // It was text or an attachment; its own path forgets it.
      this.handleDelete(oldPath);
    }
    if (newResolved) this.handleCreate(path);
  }

  /** A new attachment in a shared folder. */
  private handleBlobCreate(path: string): void {
    const resolved = this.resolveFile(path);
    if (!resolved || !this.blobSync) return;
    const { sharedFolderId, relativePath } = resolved;
    // A file BlobSync is writing on the listing's instruction is not new local
    // content, and uploading it back would mint a second id for bytes that are
    // already stored.
    if (this.blobSync.shouldIgnoreModify(sharedFolderId, relativePath)) return;
    this.blobSync.scheduleUpload(sharedFolderId, relativePath);
  }

  /**
   * Did this file simply come along with the folder that was just renamed?
   *
   * True only when the path within the folder is byte-identical on both sides:
   * the file did not move, its folder did. A file genuinely moved during the
   * same burst has a different suffix and is handled normally.
   */
  private movedWithItsFolder(path: string, oldPath: string): boolean {
    const r = this.renameInFlight;
    if (!r) return false;
    if (!oldPath.startsWith(`${r.from}/`)) return false;
    return path === `${r.to}/${oldPath.slice(r.from.length + 1)}`;
  }

  /** The folder rename is finished; later events are ordinary again. */
  renameSettled(): void {
    this.renameInFlight = null;
  }

  /** A structured file gone from this path: unlist it, and whatever it was adopted from. */
  private forgetStructured(sharedFolderId: string, relativePath: string): void {
    const kept = this.fileSync.getStructuredEntry(sharedFolderId, relativePath)?.blobHash;
    this.fileSync.removeStructuredEntry(sharedFolderId, relativePath);
    this.forgetAttachmentEntry(sharedFolderId, relativePath, kept);
    this.structuredSync?.deleteRemote(sharedFolderId, relativePath);
  }

  /**
   * Remove the attachment entry a structured file was adopted from, once the
   * file has left that path.
   *
   * Adoption leaves the entry in place so an older client keeps the file
   * (SAFE-A17). Once the file is deleted or renamed here, that entry is all
   * that is left of it, and the next connect adopts it again — downloading the
   * old attachment bytes back to the path the user just emptied. So it goes,
   * and an older client sees the deletion it would have seen anyway.
   *
   * Only a version already kept: its hash is the one the structured entry
   * records as carried across or kept beside the file. An older client's
   * version nobody has kept yet stays listed, and coming back on the next
   * connect is how it stays visible.
   */
  private forgetAttachmentEntry(sharedFolderId: string, relativePath: string, kept: string | undefined): void {
    const entry = this.fileSync.getBlobEntry(sharedFolderId, relativePath);
    if (!entry) return;
    if (entry.hash !== kept) {
      log.info('Leaving an attachment version nobody has kept listed', { relativePath });
      return;
    }
    this.fileSync.removeBlobEntry(sharedFolderId, relativePath);
    // As for an attachment: only the client that noticed can reclaim the bytes.
    if (this.blobSync) void this.blobSync.deleteRemote(sharedFolderId, entry.blobId);
  }

  private resolveFile(filePath: string): { sharedFolderId: string; relativePath: string } | null {
    const mappings = this.deps.mappings();
    return resolveMapping(filePath, mappings);
  }
}
