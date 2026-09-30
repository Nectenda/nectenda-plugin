import { IndexeddbPersistence } from 'y-indexeddb';
import { loadSeqCheckpoint, saveSeqCheckpoint } from './seq-checkpoint';
import * as Y from 'yjs';
import { applyMinimalDiff } from './text-merge';
import type { Awareness } from 'y-protocols/awareness';
import type { DocIndex } from './doc-index';
import type { FolderMapping } from './folder-mapping';
import type { TimerHandle } from './timers';
import type { VaultAdapter } from './vault-adapter';
import type { SyncProvider } from './provider-router';
import { idbStoreName } from './idb-name';
import { log } from './logger';
import { seedDocument } from './seed-update';
import { backupLocalFile } from './local-backup';

const WRITE_DEBOUNCE = 500;
/** Backoff step when the local file does not exist yet; multiplied by attempt. */
const WRITE_RETRY_DELAY = 400;
const MAX_WRITE_RETRIES = 5;
const BATCH_SIZE = 5;
const BATCH_DELAY = 200;

/**
 * One document's sync state.
 *
 * Exported for the data-safety tests, which drive the private write paths with
 * a state they build themselves. They were building it by hand through
 * `as unknown as`, so the compiler never checked it and two of them had already
 * drifted — see file-doc-state.test.ts, which now owns the only construction.
 * A type costs nothing at runtime; the alternative was four hand-written
 * literals silently disagreeing about the flags that decide whether a file is
 * overwritten.
 */
export interface FileDocState {
  docName: string;
  sharedFolderId: string;
  relativePath: string;
  localPath: string;
  ydoc: Y.Doc;
  ytext: Y.Text;
  idbProvider: IndexeddbPersistence;
  editorActive: boolean;
  writeTimer: TimerHandle | null;
  /** Consecutive attempts that found no local file yet. See writeToDisk. */
  writeRetries: number;
  /**
   * Disk content last known to match the synced document.
   *
   * Anything on disk that differs from this is local work the rest of the
   * network has not necessarily seen, which is what makes a remote deletion
   * dangerous. `null` means we have never confirmed a match — treated as
   * "possibly unsynced", because over-preserving is the safe direction.
   */
  lastSyncedContent: string | null;
  /**
   * Whether IndexedDB already held this document when we connected.
   *
   * Distinguishes a file we have synced before from one being seen for the
   * first time. Only the latter can produce a genuine first-sync conflict; a
   * returning file with stale disk content is ordinary collaboration, not a
   * clash, and backing it up would bury the vault in copies.
   */
  idbHadData: boolean;
  /** First-sync conflict is checked once per connect, not on every write. */
  firstSyncChecked: boolean;
  /**
   * Whether the server has confirmed this document at least once.
   *
   * Before that, an empty document means "not known yet", not "empty". The
   * difference matters: writing an empty document over a file that has content
   * destroys it, and reconciliation runs on connect, before any catch-up.
   */
  hasSyncedOnce: boolean;
  ignoreNextModify: boolean;
  observer: ((event: Y.YTextEvent, transaction: Y.Transaction) => void) | null;
}

/**
 * What content sync needs from the plugin around it.
 *
 * Four things. The parameter used to be typed as the plugin itself — a class
 * of a hundred and twenty members — which said nothing about which four, and
 * meant every test had to fake the lot. Three of the data-safety suites did it
 * by casting an empty object to it and telling the compiler to look away.
 * Any reach this class grew into the plugin would have
 * surfaced as a TypeError inside a test written to defend against losing
 * somebody's writing, rather than as a compile error before it ran.
 */
export interface ContentSyncDeps {
  /**
   * Whether this device holds the folder's keys. Without them its documents
   * cannot be addressed at all, because the id is derived from the name key.
   */
  hasKeys(sharedFolderId: string): boolean;
  /**
   * Path to document id and back. A document name is an HMAC and cannot be
   * taken apart, so this is the only route from one to the other.
   */
  docIndex: DocIndex;
  /**
   * Which vault this is, for naming its IndexedDB stores. A function because
   * the plugin computes it from Obsidian's app id on each read.
   */
  vaultKey(): string;
  /** The shared folders mapped into this vault. Read live; mappings change. */
  mappings(): FolderMapping[];
  /**
   * Told a note's size on disk whenever it is connected or modified, so one too
   * large to sync is named before anyone relies on it (SAFE-A12). Advisory: it
   * cannot stop or delay the connect.
   */
  checkNoteSize?(sharedFolderId: string, relativePath: string, bytes: number): void;
  /** A note renamed within its folder, so a size record follows it. */
  noteMoved?(sharedFolderId: string, fromPath: string, toPath: string): void;
  /** A note deleted or moved out, so a size record goes with it. */
  noteGone?(sharedFolderId: string, relativePath: string): void;
}

/** One document as `ContentSync.trackedDocs` reports it. */
export interface TrackedDoc {
  docName: string;
  sharedFolderId: string;
  relativePath: string;
  localPath: string;
  /** False when the subscribe was refused for want of a connection. */
  placed: boolean;
  editorActive: boolean;
  hasSyncedOnce: boolean;
  firstSyncChecked: boolean;
  idbHadData: boolean;
  diskWritePending: boolean;
}

export class ContentSync {
  private deps: ContentSyncDeps;
  private provider: SyncProvider;
  private vault: VaultAdapter;
  private fileDocs: Map<string, FileDocState> = new Map();
  /** Paths with a connect in flight, keyed before the first await. */
  private connecting: Set<string> = new Set(); // key: docName
  /**
   * Files whose subscribe was refused because the router had nowhere to put
   * them, held so `retryUnplaced` can try again when a connection appears.
   */
  private unplaced: Map<string, { sharedFolderId: string; folderLocalPath: string; relativePath: string }> = new Map();
  private folderFiles: Map<string, Set<string>> = new Map(); // folderId → set of docNames
  /**
   * Folders whose contents have been scanned and connected.
   *
   * Deliberately separate from `folderFiles`, which is populated by any
   * connectFile — including the on-demand one from acquireDoc when the editor
   * opens a file. Guarding the scan on `folderFiles` meant that a file opened
   * before the scan ran (the restored tab at startup, which binds before
   * onLayoutReady) marked the folder as done and background sync never started
   * for anything else in it.
   */
  private scannedFolders: Set<string> = new Set();

  /**
   * Told when a document is attached, detached, placed, or bound to an editor,
   * so the status icons can redraw. Only a signal: listeners read the state
   * back through `trackedDocs`, never from an argument that could be stale.
   */
  onStateChange: (() => void) | null = null;

  constructor(deps: ContentSyncDeps, provider: SyncProvider, vault: VaultAdapter) {
    this.deps = deps;
    this.provider = provider;
    this.vault = vault;
  }

  private changed(): void {
    try {
      this.onStateChange?.();
    } catch (err) {
      // A redraw that throws must not take a connect or a teardown with it.
      log.warn('A sync-state listener threw', { error: String(err) });
    }
  }

  /**
   * What this engine believes about every document it holds, for the status
   * icons and the inspector. Copies, so nothing a reader keeps can move.
   *
   * Unplaced files are included with `placed: false`: they are in a shared
   * folder and are not syncing, which is exactly what an icon should say.
   */
  trackedDocs(): TrackedDoc[] {
    const out: TrackedDoc[] = [];
    for (const s of this.fileDocs.values()) {
      out.push({
        docName: s.docName,
        sharedFolderId: s.sharedFolderId,
        relativePath: s.relativePath,
        localPath: s.localPath,
        placed: true,
        editorActive: s.editorActive,
        hasSyncedOnce: s.hasSyncedOnce,
        firstSyncChecked: s.firstSyncChecked,
        idbHadData: s.idbHadData,
        diskWritePending: s.writeTimer !== null,
      });
    }
    for (const [docName, u] of this.unplaced) {
      out.push({
        docName,
        sharedFolderId: u.sharedFolderId,
        relativePath: u.relativePath,
        localPath: `${u.folderLocalPath}/${u.relativePath}`,
        placed: false,
        editorActive: false,
        hasSyncedOnce: false,
        firstSyncChecked: false,
        idbHadData: false,
        diskWritePending: false,
      });
    }
    return out;
  }

  /**
   * Whether the file on disk says what the document says, read from disk now.
   *
   * For the inspector, which must check its claims against something that can
   * observe the thing rather than against cached state. Null when there is no
   * such document or the file cannot be read. Read-only: it never writes.
   */
  async diskMatchesDocument(docName: string): Promise<boolean | null> {
    const state = this.fileDocs.get(docName);
    if (!state) return null;
    try {
      const disk = await this.vault.read(state.localPath);
      return disk === state.ytext.toString();
    } catch {
      return null;
    }
  }

  connectFolder(sharedFolderId: string, localPath: string): void {
    if (this.scannedFolders.has(sharedFolderId)) return;
    void this.doConnectFolder(sharedFolderId, localPath);
  }

  private async doConnectFolder(sharedFolderId: string, localPath: string): Promise<void> {
    if (this.scannedFolders.has(sharedFolderId)) return;

    // Without keys the folder's documents cannot be addressed at all. Refuse
    // it whole rather than connecting part of it — see FileSync.connectFolder
    // for why a half-connected folder is dangerous rather than merely useless.
    if (!this.deps.hasKeys(sharedFolderId)) {
      log.warn('Folder has no encryption keys — background sync not started', {
        sharedFolderId,
      });
      return;
    }

    // Scan local folder for .md files and connect them
    if (!this.vault.isFolder(localPath)) {
      // Marking the folder connected before this point would leave it
      // permanently registered with no files, so a later retry would be a
      // no-op and background sync would never start.
      log.warn('Shared folder not found in vault — background sync not started', {
        localPath,
      });
      return;
    }

    this.scannedFolders.add(sharedFolderId);
    if (!this.folderFiles.has(sharedFolderId)) this.folderFiles.set(sharedFolderId, new Set());

    const files = this.vault
      .listMarkdown(localPath)
      .map((path) => ({ relPath: path.slice(localPath.length + 1) }));

    // Derive every local path's document id up front, so the lookups below —
    // and in EditorBridge, which cannot await — are synchronous.
    await this.deps.docIndex.warm(sharedFolderId, files.map((f) => f.relPath));

    log.info('Background sync starting', { localPath, files: files.length });

    // Connect in batches to avoid overwhelming the server
    this.connectFilesBatched(sharedFolderId, localPath, files, 0);
  }

  private connectFilesBatched(
    sharedFolderId: string,
    localPath: string,
    files: { relPath: string }[],
    offset: number,
  ): void {
    const batch = files.slice(offset, offset + BATCH_SIZE);
    for (const { relPath } of batch) {
      this.connectFile(sharedFolderId, localPath, relPath);
    }

    if (offset + BATCH_SIZE < files.length) {
      window.setTimeout(() => {
        this.connectFilesBatched(sharedFolderId, localPath, files, offset + BATCH_SIZE);
      }, BATCH_DELAY);
    }
  }

  connectFile(sharedFolderId: string, localPath: string, relativePath: string): void {
    // Here rather than in each caller: sharing, joining, launch, create, a
    // move into the folder and a rename within it all arrive through this one
    // method. Before the gate below, which returns early for a note already
    // connected. A renamed note's record has been moved ahead of this
    // (`moveFile`), so it is not announced twice.
    this.checkNoteSize(sharedFolderId, `${localPath}/${relativePath}`, relativePath);

    // Gate on the path, synchronously, before anything can await.
    //
    // The old guard was `fileDocs.has(docName)`, which was only correct while
    // everything above it was synchronous. Deriving the document id is async,
    // so two concurrent calls for the same path would both pass it and the file
    // would get two Y.Docs and two IndexedDB stores, both seeding into the same
    // server document.
    const gate = `${sharedFolderId}\n${relativePath}`;
    if (this.connecting.has(gate)) return;
    const known = this.deps.docIndex.refSync(sharedFolderId, relativePath);
    if (known && this.fileDocs.has(known)) return;

    this.connecting.add(gate);
    void this.doConnectFile(sharedFolderId, localPath, relativePath, gate);
  }

  /**
   * Report a note's size, if anyone is listening. A `stat` rather than a read,
   * so a 16 MiB file is not loaded twice to learn how long it is. Contained:
   * a throw from here must not take a connect or a modify down with it.
   */
  private checkNoteSize(sharedFolderId: string, fullPath: string, relativePath: string): void {
    if (!this.deps.checkNoteSize) return;
    try {
      const stat = this.vault.stat(fullPath);
      if (stat) this.deps.checkNoteSize(sharedFolderId, relativePath, stat.size);
    } catch (err) {
      log.warn('Could not check a note\'s size', { path: fullPath, error: String(err) });
    }
  }

  private async doConnectFile(
    sharedFolderId: string,
    localPath: string,
    relativePath: string,
    gate: string,
  ): Promise<void> {
    let docName: string;
    try {
      docName = await this.deps.docIndex.ref(sharedFolderId, relativePath);
    } catch (err) {
      // No key for the folder: its documents cannot even be addressed. Leaving
      // the file alone is the only safe answer — see connectFolder.
      this.connecting.delete(gate);
      log.warn('Cannot connect a file in a folder with no keys', {
        relativePath,
        error: String(err),
      });
      return;
    }
    if (this.fileDocs.has(docName)) {
      this.connecting.delete(gate);
      return;
    }

    const fullLocalPath = `${localPath}/${relativePath}`;
    const ydoc = new Y.Doc();
    const ytext = ydoc.getText('content');

    // Load IDB cache first
    const idbProvider = new IndexeddbPersistence(idbStoreName(this.deps.vaultKey(), docName), ydoc);

    const state: FileDocState = {
      docName,
      sharedFolderId,
      relativePath,
      localPath: fullLocalPath,
      ydoc,
      ytext,
      idbProvider,
      editorActive: false,
      writeTimer: null,
      writeRetries: 0,
      lastSyncedContent: null,
      idbHadData: false,
      firstSyncChecked: false,
      hasSyncedOnce: false,
      ignoreNextModify: false,
      observer: null,
    };

    this.fileDocs.set(docName, state);
    this.connecting.delete(gate);
    this.changed();
    // May be absent when acquireDoc connects a file on demand before
    // connectFolder has run; without this the doc would escape disconnectFolder.
    let tracked = this.folderFiles.get(sharedFolderId);
    if (!tracked) {
      tracked = new Set();
      this.folderFiles.set(sharedFolderId, tracked);
    }
    tracked.add(docName);

    const startSync = () => {
      // Captured here and nowhere else: IndexedDB has finished loading, and the
      // provider has not yet delivered anything from the server. Content in the
      // document at this instant can only have come from a previous session.
      state.idbHadData = ytext.length > 0;

      // Subscribe to server via multiplexed provider.
      //
      // Safe to pass the checkpoint here and only here: IndexedDB has finished
      // loading, so the state vector it validates against describes the real
      // restored document rather than an empty one.
      //
      // This **throws** when the router cannot place the document — a folder
      // routed to a connection that is being rebuilt answers null. It used to
      // throw out of a `void`-fired caller, past everything below, leaving the
      // state in `fileDocs`: a document nothing had subscribed, that
      // `acquireDoc` then handed out forever as though it were connected, with
      // no update observer and no `subscribed:` event. An editor bound to it
      // showed no collaborators and sent none, while the file on disk kept
      // moving through the folder listing — which is exactly how it was found.
      //
      // So: fail the whole connect, leaving nothing behind to hand out. The
      // next `acquireDoc` then really does try again.
      try {
        this.provider.subscribe(docName, ydoc, {
          load: () => loadSeqCheckpoint(idbProvider, ydoc),
          save: (seq) => saveSeqCheckpoint(idbProvider, ydoc, seq),
        });
      } catch (err) {
        log.warn('Could not subscribe this document; it is not connected', {
          path: fullLocalPath, docName, error: String(err),
        });
        this.abandonUnsubscribed(state, sharedFolderId, localPath);
        return;
      }

      // Only now has it joined the connection. Logged after the subscribe, not
      // before: the line used to claim this while the very next statement was
      // throwing, which made the log read as a healthy connect.
      log.debug('Document bound', { path: fullLocalPath, docName, idbBytes: ytext.length, alreadySynced: this.provider.isSynced(docName) });


      // Observe Y.Text changes for background disk writes
      const observer = () => {
        if (state.editorActive) return; // Editor handles writes
        this.scheduleDiskWrite(state);
      };
      state.observer = observer;
      ytext.observe(observer);

      // Reconcile disk against the document once, now.
      //
      // The observer only fires on *changes*. A document can arrive already
      // complete — restored from IndexedDB before this runs, or delivered by a
      // catch-up that lands before the observer attaches — and then nothing
      // ever schedules a write. The content sits in memory while the file on
      // disk stays empty or stale, which is exactly what a file created in
      // another vault looked like: present, named correctly, and 0 bytes.
      //
      // writeToDisk is a no-op when the content already matches, so doing this
      // on every connect costs one read per file.
      if (!state.editorActive) this.scheduleDiskWrite(state);

      // And again once the server's catch-up has been applied, since that is
      // usually where the content actually arrives.
      //
      // The order inside this handler is the whole point, and it is why these
      // three steps are one handler rather than two listeners on one event.
      //
      // Seeding reads the file, so it is asynchronous. `hasSyncedOnce` is what
      // disarms the guard in writeToDisk that refuses to blank a file from an
      // empty document. Setting that flag and scheduling the write in one
      // listener, while the seed that fills the document ran in another, left
      // the outcome to whichever continuation happened to win: when the write
      // won, a note written seconds earlier was overwritten with nothing — in
      // the vault that had just created it, with no conflict copy and no
      // warning, because as far as writeToDisk could tell the server had
      // confirmed an empty document.
      //
      // So: fill the document from disk, and only then call it confirmed. A
      // document is "confirmed empty" only once we have looked at the file and
      // found nothing there.
      // Split so the listener itself is synchronous. `on` and `off` match by
      // function identity, so the thing registered has to be the same object
      // that is later removed — wrapping at either call site would hand them
      // two different wrappers and the listener would never come off.
      // Two things are deliberate here. The listener registered with `on` must
      // be the same object later passed to `off`, which match by identity, so
      // the sync wrapper is what both see and the async work sits behind it.
      // And the `off` stays *inside* the async body: an async function turns a
      // synchronous throw into a rejected promise where a plain one lets it
      // escape to whoever called the listener, and this used to be one async
      // function throughout. Keeping the boundary where it was keeps that.
      const runFirstSync = async (): Promise<void> => {
        this.provider.off(`synced:${docName}`, onFirstSync);
        await this.seedIfEmpty(state);
        state.hasSyncedOnce = true;
        this.changed();
        if (!state.editorActive) this.scheduleDiskWrite(state);
      };
      const onFirstSync = (): void => {
        void runFirstSync().catch((err: unknown) => {
          log.warn('First sync failed to seed', { docName, error: String(err) });
        });
      };

      if (this.provider.isSynced(docName)) {
        onFirstSync();
      } else {
        this.provider.on(`synced:${docName}`, onFirstSync);
      }
    };

    if (idbProvider.synced) {
      startSync();
    } else {
      idbProvider.once('synced', startSync);
    }
  }

  /** See `local-backup.ts`. A method so the call sites below stay as they were. */
  private backupLocalFile(localPath: string, content: string, reason?: string): Promise<void> {
    return backupLocalFile(this.vault, localPath, content, reason);
  }

  /**
   * Told whenever a file's content has been taken into its document, so the
   * record of unbound editors' edits can drop what that content already holds
   * (NEC-159, `PendingEdits.adopted`). Otherwise an edit saved by Obsidian,
   * taken in here, and replayed by the next bind would be typed twice.
   */
  private adoptedText: (path: string, text: string) => void = () => undefined;

  setOnAdopted(listener: (path: string, text: string) => void): void {
    this.adoptedText = listener;
  }

  /**
   * Keep an editor's text aside when a bind could not replay what was typed
   * into it exactly (NEC-159, SAFE-B5): the editor was reloaded under the
   * typing, or the document had moved too far to place it. The bind is about
   * to set the editor from the document, so the text goes to
   * `.nectenda-backups/`, never lost.
   */
  backupEditorText(docName: string, content: string): Promise<void> {
    const state = this.fileDocs.get(docName);
    if (!state) {
      // The bind acquired this document a moment ago, so this should not
      // happen — and if it does, the text must not vanish without a word.
      log.error('Could not back up the editor: its document is no longer open', {
        docName, bytes: content.length,
      });
      return Promise.resolve();
    }
    return this.backupLocalFile(
      state.localPath,
      content,
      'The editor held text that could not be merged exactly while it bound — backed up the editor',
    );
  }

  /**
   * Local content that the network may not have seen, or null if there is none.
   *
   * Used before honouring a remote deletion. A deletion racing a concurrent edit
   * resolves in favour of the deletion — the operations do not commute, so no
   * CRDT merge exists — and without this the edit is destroyed silently.
   */
  async unsyncedLocalContent(docName: string): Promise<string | null> {
    const state = this.fileDocs.get(docName);
    if (!state) return null;
    if (!this.vault.isFile(state.localPath)) return null;

    try {
      const diskContent = await this.vault.read(state.localPath);

      // While yCollab is bound, the document holds the newest text, not the
      // file. Obsidian writes the buffer on its own debounce, so the disk copy
      // can be seconds behind what has just been typed — and a deletion
      // arriving inside that window would otherwise be preserved as a version
      // missing the very work the copy exists to save.
      const docContent = state.ytext.toString();
      const localContent =
        state.editorActive && docContent.length > 0 ? docContent : diskContent;

      if (localContent.length === 0) return null;

      // Work this client contributed counts even after it was pushed. A
      // deletion arriving moments later still discards it — into a document
      // nobody will read again — so a successful sync is not the same as being
      // safe. Manual testing caught exactly this ordering: the edit reached the
      // server 39ms before the deletion arrived, disk and document agreed, and
      // the copy was skipped.
      if (this.provider.contributedUnsyncedWork(docName)) return localContent;

      // null means we never confirmed disk and document agreed, so we cannot
      // rule out local work — preserve it.
      if (state.lastSyncedContent === null) return localContent;
      return localContent === state.lastSyncedContent ? null : localContent;
    } catch {
      return null;
    }
  }

  /**
   * Stop following a document and ask the server to discard it.
   *
   * For a deletion made in this vault. The order matters and is kept in one
   * place deliberately: the purge is sent while the connection is still known
   * to the provider, and only then is the local subscription torn down.
   */
  deleteRemote(sharedFolderId: string, relativePath: string): void {
    this.noteSizeHook(() => this.deps.noteGone?.(sharedFolderId, relativePath));
    const docName = this.deps.docIndex.refSync(sharedFolderId, relativePath);
    if (!docName) return;
    this.provider.deleteDoc(docName);
    this.disconnectDoc(docName);
  }

  /**
   * A note that has left its folder: deleted, here or by a peer, or moved out.
   * A rename within the folder is `moveFile`, which must not come through here
   * first, or the note's size record would be dropped and the note announced
   * again under its new name.
   */
  disconnectFile(sharedFolderId: string, relativePath: string): void {
    this.noteSizeHook(() => this.deps.noteGone?.(sharedFolderId, relativePath));
    const docName = this.deps.docIndex.refSync(sharedFolderId, relativePath);
    if (!docName) return;
    this.disconnectDoc(docName);
  }

  /** A note renamed or moved within its folder, locally or by a peer. */
  moveFile(sharedFolderId: string, folderLocalPath: string, fromPath: string, toPath: string): void {
    // First: the disconnect below forgets whatever is still under the old name.
    this.noteSizeHook(() => this.deps.noteMoved?.(sharedFolderId, fromPath, toPath));
    this.disconnectFile(sharedFolderId, fromPath);
    this.connectFile(sharedFolderId, folderLocalPath, toPath);
  }

  /** Contained, like `checkNoteSize`: bookkeeping must not break a delete or a move. */
  private noteSizeHook(run: () => void): void {
    try {
      run();
    } catch (err) {
      log.warn('Could not update the large-note record', { error: String(err) });
    }
  }

  /**
   * Undo a connect that could not subscribe, so nothing is left to hand out.
   *
   * Deliberately not `disconnectDoc`: that one unsubscribes and unobserves, and
   * neither ever happened here. What exists is a state in the maps, an
   * IndexedDB provider and a Y.Doc, and the whole point is that the maps must
   * not keep a document the server has never heard of. `acquireDoc` treats
   * presence in `fileDocs` as "connected", so leaving it is what made a dead
   * document look like a live one.
   *
   * The folder is remembered so the retry below knows what to reconnect when
   * routing comes back.
   */
  private abandonUnsubscribed(state: FileDocState, sharedFolderId: string, folderLocalPath: string): void {
    this.fileDocs.delete(state.docName);
    this.folderFiles.get(sharedFolderId)?.delete(state.docName);
    if (state.writeTimer) window.clearTimeout(state.writeTimer);
    if (state.observer) state.ytext.unobserve(state.observer);
    void state.idbProvider.destroy().catch((err: unknown) => {
      log.warn('IndexedDB teardown failed', { error: String(err) });
    });
    state.ydoc.destroy();
    // The folder's own path, not the file's: `connectFile` takes the folder and
    // the path within it, and deriving one back out of the other would break on
    // the first relative path containing a slash.
    this.unplaced.set(state.docName, { sharedFolderId, folderLocalPath, relativePath: state.relativePath });
    this.changed();
  }

  /**
   * Files that could not be placed on a connection, to be retried when one
   * appears.
   *
   * Routing is set from `refreshSync`, which can name a connection still being
   * rebuilt after a reconnect; until it exists every subscribe for that folder
   * throws. Without this the files stayed unconnected until something happened
   * to touch them again — in practice, until the person clicked away from the
   * note and back.
   */
  retryUnplaced(): void {
    if (this.unplaced.size === 0) return;
    const pending = [...this.unplaced.values()];
    this.unplaced.clear();
    log.info('Retrying documents that had no connection', { count: pending.length });
    for (const f of pending) {
      // Through connectFile, so the gate and the existing-document checks apply
      // exactly as they do on a first connect.
      this.connectFile(f.sharedFolderId, f.folderLocalPath, f.relativePath);
    }
  }

  private disconnectDoc(docName: string): void {
    const state = this.fileDocs.get(docName);
    if (!state) return;

    if (state.writeTimer) window.clearTimeout(state.writeTimer);
    if (state.observer) state.ytext.unobserve(state.observer);
    this.provider.unsubscribe(docName);
    void state.idbProvider.destroy().catch((err: unknown) => {
      log.warn('IndexedDB teardown failed', { error: String(err) });
    });
    state.ydoc.destroy();

    this.fileDocs.delete(docName);
    this.folderFiles.get(state.sharedFolderId)?.delete(docName);
    this.changed();
  }

  disconnectFolder(sharedFolderId: string): void {
    const docNames = this.folderFiles.get(sharedFolderId);
    if (!docNames) return;

    for (const docName of Array.from(docNames)) {
      this.disconnectDoc(docName);
    }
    this.folderFiles.delete(sharedFolderId);
    this.scannedFolders.delete(sharedFolderId);
  }

  disconnectAll(): void {
    for (const folderId of Array.from(this.folderFiles.keys())) {
      this.disconnectFolder(folderId);
    }
  }

  /** EditorBridge calls this when opening a file — takes over the Y.Doc.
   *  If the file hasn't been connected yet (batch startup race), connects it on-demand. */
  acquireDoc(docName: string): { ydoc: Y.Doc; ytext: Y.Text; awareness: Awareness } | null {
    let state = this.fileDocs.get(docName);

    if (!state) {
      // A document name is an HMAC and cannot be taken apart, so the path comes
      // from the index that derived it rather than from the name itself. A miss
      // means this client has never addressed the document, and connecting it
      // blind would attach the wrong file.
      const resolved = this.deps.docIndex.pathOf(docName);
      if (!resolved) return null;

      const mapping = this.deps.mappings().find(
        (m) => m.sharedFolderId === resolved.folderId,
      );
      if (!mapping) return null;

      this.connectFile(resolved.folderId, mapping.localPath, resolved.relativePath);
      state = this.fileDocs.get(docName);
      if (!state) return null;
    }

    // Awareness may be null here: provider.subscribe runs only after IndexedDB
    // has finished loading, so a file opened immediately at startup reaches this
    // point before the subscription exists. Return the doc anyway.
    //
    // EditorBridge handles the gap by waiting for `subscribed:<docName>`. It
    // used to wait for `synced` instead, which was wrong offline — that event
    // needs a server — and is why an editor opened during an outage never bound
    // and its edits were lost.
    const awareness = this.provider.getAwareness(docName);

    return { ydoc: state.ydoc, ytext: state.ytext, awareness: awareness! };
  }


  /** EditorBridge calls this when closing a file — ContentSync resumes background sync */
  releaseDoc(docName: string): void {
    this.setEditorBound(docName, false);
  }

  /**
   * Declare whether yCollab is bound to this document.
   *
   * While bound, CodeMirror owns the content and ContentSync must not write to
   * disk underneath it or re-apply disk changes. While unbound — including a
   * file open in a tab that has not synced yet — ContentSync stays responsible,
   * so offline edits still reach the CRDT.
   */
  setEditorBound(docName: string, bound: boolean): void {
    const state = this.fileDocs.get(docName);
    if (!state) return;
    state.editorActive = bound;
    this.changed();
    if (bound && state.writeTimer) {
      window.clearTimeout(state.writeTimer);
      state.writeTimer = null;
    }
    if (!bound) this.scheduleDiskWrite(state);
  }

  /** Called by VaultWatcher when a shared file is modified on disk */
  /**
   * Adopt changes the file has that we did not write, before the editor binds.
   *
   * Binding declares the document the source of truth — installCollab ends with
   * `editor.setValue(ytext.toString())` — so anything on disk the document does
   * not know about is discarded at that moment, and `editorActive` then stops
   * the usual disk-to-document path from ever noticing. Offline that is real
   * loss: a file changed by another program during an outage was silently
   * reverted when the note was opened.
   *
   * Deliberately narrow. It adopts the file only when the file differs from
   * what ContentSync last wrote there, which is the signal that something else
   * changed it. When they agree, the document is the newer side — it may hold
   * remote edits not yet flushed to disk — and adopting the file would revert
   * them. When nothing has been confirmed yet (`lastSyncedContent === null`) it
   * does nothing, leaving that case to the first-sync backup net.
   */
  async reconcileFromDisk(docName: string): Promise<void> {
    const state = this.fileDocs.get(docName);
    if (!state) return;
    if (!this.vault.isFile(state.localPath)) return;

    try {
      const disk = await this.vault.read(state.localPath);
      const current = state.ytext.toString();
      if (disk === current) return;

      const adopt = (): void => {
        log.debug('Adopting a file change the document did not have', {
          path: state.localPath,
          diskBytes: disk.length,
          docBytes: current.length,
        });
        applyMinimalDiff(state.ydoc, state.ytext, current, disk);
        state.lastSyncedContent = disk;
        this.adoptedText(state.localPath, disk);
      };

      // With a known baseline the answer is exact. If the file still matches
      // what we last wrote, the document is the newer of the two — it may hold
      // remote edits not yet flushed — and adopting the file would revert them.
      // Otherwise something else changed the file, and it is ours to take.
      if (state.lastSyncedContent !== null) {
        if (disk === state.lastSyncedContent) return;
        adopt();
        return;
      }

      // No baseline yet. This is not rare: the comparison that establishes one
      // runs on a debounce, and binding can win that race — measured at 59ms in
      // a run where the file held 36 characters and the document held 9, and
      // the file's version was then overwritten and lost.
      //
      // Guessing is not acceptable here, so decide by what can be lost rather
      // than by who is probably newer.
      if (disk.length === 0) return;

      // An empty document filled from a file is a seed, whichever function it
      // happens to be standing in, so it takes the same derived identity. This
      // is the path an offline bind reaches — `seedIfEmpty` waits for a `synced`
      // that cannot arrive, so without this the guaranteed-duplication case is
      // untouched.
      if (current.length === 0) {
        const outcome = await seedDocument(state.ydoc, state.docName, disk);
        // Only claim the two agree if the content actually landed. On
        // `already-present` the identity is known but the text is not here —
        // another vault seeded this and the content was since deleted, and that
        // deletion wins. Recording a baseline then would tell the write path the
        // file is safe to blank.
        if (outcome !== 'already-present') {
          state.lastSyncedContent = disk;
          this.adoptedText(state.localPath, disk);
        }
        return;
      }

      // Everything the document holds is still present in the file, so taking
      // the file cannot discard anything.
      if (disk.includes(current)) {
        adopt();
        return;
      }

      // Each side holds something the other does not, and with no baseline
      // there is no way to tell which came first. The document wins on screen —
      // that is what binding does — but the file's version is kept where the
      // user can find it first. A stray backup costs a file; picking wrong
      // costs their writing.
      log.warn('File and document diverged with no known baseline — backing up the file', {
        path: state.localPath,
        diskBytes: disk.length,
        docBytes: current.length,
      });
      await this.backupLocalFile(state.localPath, disk);
    } catch (err) {
      log.error('Failed to reconcile disk before binding', {
        path: state.localPath,
        error: String(err),
      });
    }
  }

  async onLocalModify(sharedFolderId: string, relativePath: string): Promise<void> {
    const docName = this.deps.docIndex.refSync(sharedFolderId, relativePath);
    if (!docName) return;
    const state = this.fileDocs.get(docName);
    if (!state) return;

    // Before either early return below: an edit made in the editor is exactly
    // how a note grows past the limit, and a trim is how it comes back under.
    this.checkNoteSize(sharedFolderId, state.localPath, relativePath);

    // If we wrote this change ourselves, skip
    if (state.ignoreNextModify) {
      state.ignoreNextModify = false;
      return;
    }

    // If editor is active, yCollab handles sync
    if (state.editorActive) return;

    try {
      const content = await this.vault.read(state.localPath);
      const current = state.ytext.toString();
      if (content !== current) {
        // An empty file does not empty the document until this vault has seen
        // the two agree at least once.
        //
        // FileSync creates a placeholder the moment the folder listing names a
        // note, and Obsidian's modify event for that empty file can arrive
        // *after* the content does. One millisecond after, in the run that
        // found this: the document received all 42 characters from the server
        // and this handler deleted them again, read the empty placeholder as
        // an edit, and pushed the deletion — so the vault that wrote the note
        // applied it and blanked its own copy too. A note was destroyed in
        // both vaults by the arrival of the note.
        //
        // `lastSyncedContent === null` is precisely "we have never reconciled
        // this file against this document", which is the placeholder case.
        // Once the file has held the document's content, emptying it is a real
        // edit by a real person and is honoured.
        if (content === '' && current !== '' && state.lastSyncedContent === null) {
          log.debug('Ignoring an empty file that has never held this document', {
            path: state.localPath, docChars: current.length,
          });
          return;
        }
        // Use minimal diff to preserve CRDT character identities.
        // A destructive delete-all + insert-all would create tombstones
        // that destroy concurrent changes from other clients.
        applyMinimalDiff(state.ydoc, state.ytext, current, content);
        this.adoptedText(state.localPath, content);
      }
    } catch (err) {
      log.error('Failed to read file for sync', { path: state.localPath, error: String(err) });
    }
  }

  /** Check if a doc is managed by ContentSync */
  hasDoc(docName: string): boolean {
    return this.fileDocs.has(docName);
  }

  /** Check if editor is active for a doc */
  isEditorActive(docName: string): boolean {
    return this.fileDocs.get(docName)?.editorActive ?? false;
  }

  private scheduleDiskWrite(state: FileDocState): void {
    if (state.writeTimer) window.clearTimeout(state.writeTimer);
    state.writeTimer = window.setTimeout(() => {
      state.writeTimer = null;
      void this.writeToDisk(state).catch((err: unknown) => {
        log.warn('Deferred disk write failed', { error: String(err) });
      });
    }, WRITE_DEBOUNCE);
  }

  private async writeToDisk(state: FileDocState): Promise<void> {
    if (!this.vault.isFile(state.localPath)) {
      // A file arriving from another vault reaches us twice: FileSync creates
      // it locally from the meta doc, and ContentSync receives its content.
      // Content usually wins the race, and the file is not in the vault index
      // yet.
      //
      // Retrying is essential rather than tidy. Nothing else would reschedule
      // this write — the observer only fires when ytext changes again — so
      // dropping it leaves an empty file on disk until something happens to
      // touch that document again.
      if (state.writeRetries < MAX_WRITE_RETRIES) {
        state.writeRetries++;
        if (state.writeTimer) window.clearTimeout(state.writeTimer);
        state.writeTimer = window.setTimeout(() => {
          state.writeTimer = null;
          void this.writeToDisk(state);
        }, WRITE_RETRY_DELAY * state.writeRetries);
      } else {
        log.warn('Gave up writing synced content — file never appeared in the vault', {
          path: state.localPath,
        });
      }
      return;
    }
    state.writeRetries = 0;

    try {
      const content = state.ytext.toString();
      const diskContent = await this.vault.read(state.localPath);

      // Never blank a file on the strength of a document we have not heard
      // about yet. Reconciliation runs on connect, before any catch-up, so an
      // empty document at that point means "unknown", not "empty" — and
      // offline it may stay that way indefinitely. Once the server has
      // confirmed the document, an empty one is a real deletion of content and
      // is written through.
      if (content === '' && diskContent !== '' && !state.hasSyncedOnce) {
        log.debug('Skipping write of an unconfirmed empty document', { path: state.localPath });
        return;
      }

      if (content === diskContent) {
        // Disk already agrees with the document, so there is nothing local at
        // risk if this file is later deleted elsewhere. Said at debug because
        // "both empty" is also what a document that never received its
        // content looks like, and this was the one silent step on that path.
        log.debug('Synced content already on disk', { path: state.localPath, bytes: content.length, hasSyncedOnce: state.hasSyncedOnce });
        state.lastSyncedContent = content;
        return;
      }

      // A first-ever sync where both sides hold different, non-empty content is
      // a genuine conflict: two independent versions of the same note, and the
      // server's is about to replace what is on disk. Phase 4 backed the local
      // copy up before overwriting; Phase 6's rewrite dropped that, so the
      // overwrite has been silent ever since.
      if (!state.firstSyncChecked) {
        state.firstSyncChecked = true;
        if (
          !state.idbHadData &&
          diskContent.length > 0 &&
          content.length > 0 &&
          diskContent !== content
        ) {
          await this.backupLocalFile(state.localPath, diskContent);
        }
      }

      // Blanking a file is the one write that syncing again cannot undo, so
      // it never happens silently. The guard above refuses it outright while
      // the document is unconfirmed; past that point an empty document is
      // taken as a real deletion and honoured — but the local copy is put
      // aside first. "The server says this document is empty" has already
      // once meant "this vault failed to upload it", and the cost is
      // asymmetric: a spurious backup costs a file, a missed one costs
      // someone's writing.
      if (content === '' && diskContent !== '') {
        await this.backupLocalFile(
          state.localPath, diskContent,
          'A synced deletion emptied this file — kept the local copy',
        );
      }

      log.debug('Writing synced content to disk', {
        path: state.localPath, diskBytes: diskContent.length, docBytes: content.length,
      });
      state.ignoreNextModify = true;
      await this.vault.write(state.localPath, content);
      state.lastSyncedContent = content;
    } catch (err) {
      log.error('Failed to write synced content to disk', { path: state.localPath, error: String(err) });
    }
  }

  private async seedIfEmpty(state: FileDocState): Promise<void> {
    if (state.ytext.length > 0) return; // Already has content

    if (!this.vault.isFile(state.localPath)) return;

    try {
      const content = await this.vault.read(state.localPath);
      if (content.length > 0 && state.ytext.length === 0) {
        // Under an identity derived from the content, so that another vault
        // doing exactly this at exactly this moment authors the same operation
        // rather than a second copy of the same words.
        const outcome = await seedDocument(state.ydoc, state.docName, content);
        if (outcome !== 'already-present') this.adoptedText(state.localPath, content);
      }
    } catch (err) {
      log.error('Failed to seed content', { path: state.localPath, error: String(err) });
    }
  }
}
