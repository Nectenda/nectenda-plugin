import { IndexeddbPersistence } from 'y-indexeddb';
import * as Y from 'yjs';
import { loadSeqCheckpoint, saveSeqCheckpoint } from './seq-checkpoint';
import { guardRunaway } from './runaway-guard';
import { idbStoreName } from './idb-name';
import { backupLocalFile, writeConflictCopy } from './local-backup';
import { codecForFormat, codecForPath, type SettleOutcome, type StructuredCodec } from './structured-formats';
import { deriveSeedClientId } from './seed-update';
import { PRESENCE_PAD_BYTES } from './presence-seal';
import type { DocIndex } from './doc-index';
import type { SyncProvider } from './provider-router';
import type { Awareness } from 'y-protocols/awareness';
import type { TimerHandle } from './timers';
import type { VaultAdapter } from './vault-adapter';
import { log } from './logger';

const WRITE_DEBOUNCE = 500;
const WRITE_RETRY_DELAY = 400;
const MAX_WRITE_RETRIES = 5;
/** How long a connect waits for `ready` (what is remembered across a restart) before going on without it. */
const READY_WAIT_MS = 10_000;
/** Origin of every transaction this class makes from disk. */
const LOCAL_ORIGIN = 'structured-local';
/** The origin MultiplexedProvider applies server updates under. */
const REMOTE_ORIGIN = 'remote';
/** Root map StructuredSync owns in every structured document. See `stampMeta`. */
export const META_ROOT = 'meta';
/** IndexedDB key for the client ids this vault has written the document under. */
const CLIENTS_KEY = 'nectenda-structured-clients';

/** See `StructuredSync.connectFile`. */
export interface ConnectOptions {
  fill?: boolean;
}

/** IndexedDB key for how far this vault's work is known to have reached the server. */
const ACKED_KEY = 'nectenda-structured-acked';
/**
 * The origin of a codec's settle transaction (SAFE-A27). Its own changes are
 * not settled again: they are the settling.
 */
const SETTLE_ORIGIN = 'structured-settle';
/** This file's record of what disk and document last agreed on (SAFE-A30). */
const AGREED_KEY = 'nectenda-structured-agreed';
/** Text sync's record of what disk and document last agreed on (content-sync.ts, SAFE-A30). */
const TEXT_AGREED_KEY = 'nectenda-agreed-text';
/** The text versions an older client wrote after a file left text sync, already kept (SAFE-A28). */
const TEXT_KEPT_KEY = 'nectenda-text-kept';
/**
 * The same, in the document: one entry per text version some vault has kept,
 * so the others do not keep it again. Only ever true; read by no codec.
 */
const TEXT_KEPT_ROOT = 'textKept';

/** A short name for a text, for TEXT_KEPT_ROOT: its length and two FNV-1a hashes. */
function textMark(text: string): string {
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b ^ c, 0x811c9dc5) >>> 0;
  }
  return `${text.length}:${a.toString(36)}:${b.toString(36)}`;
}

/** Whether a shared type, or anything it sits inside, has been deleted. */
function insideDeleted(type: Y.AbstractType<unknown>): boolean {
  for (let item = type._item; item; item = (item.parent as Y.AbstractType<unknown>)._item) {
    if (item.deleted) return true;
  }
  return false;
}

/**
 * Whether `later` was written by someone who had `earlier`: `earlier` is on its
 * chain of origins — the entry each write was made on top of.
 *
 * The origin travels with the entry itself, so this answers the same way
 * however the entry arrived: live, or inside a reconnect's merged delta, or a
 * snapshot. A delete set cannot: a merged delta carries the sender's whole
 * set, including entries its own merge discarded unseen.
 */
export function madeOnTopOf(doc: Y.Doc, later: Y.Item, earlier: Y.Item): boolean {
  let cur: Y.Item | null = later;
  for (let hops = 0; cur?.origin && hops < 10_000; hops++) {
    const o: Y.ID = cur.origin;
    if (o.client === earlier.id.client && o.clock >= earlier.id.clock && o.clock < earlier.id.clock + earlier.length) {
      return true;
    }
    const next = Y.getItem(doc.store, o);
    cur = next instanceof Y.Item ? next : null;
  }
  return false;
}

/**
 * Whether an entry this vault wrote, just deleted by a remote update, was lost
 * without the other side having seen it (SAFE-A14).
 *
 * Three ways an entry of ours can go:
 *
 * - **Overwritten**, as a map value. Lost if what replaced it was not made on
 *   top of it — a concurrent write to the same key, which Yjs settles by client
 *   id and reports to nobody. Exact.
 * - **Deleted as the key's current value, or as text.** Only someone holding
 *   the entry can delete it, so that was seen. Not a loss.
 * - **Removed with a map or list it sat inside.** Whoever deleted the container
 *   may not have had this entry, and nothing in the update says whether they
 *   did. An entry not known to have reached the server certainly was not seen,
 *   and counts as lost. One that had reached it may or may not have been — the
 *   deleter may not have received it yet, typically for being offline — and is
 *   not counted: that case stays open.
 */
function lostUnseen(state: StructuredDocState, item: Y.Item): boolean {
  const parent = item.parent as Y.AbstractType<unknown>;
  if (insideDeleted(parent)) {
    return item.id.clock >= (state.acknowledged.get(item.id.client) ?? 0);
  }
  if (item.parentSub === null) return false;
  const successor = item.right;
  if (!successor) return false;
  return !madeOnTopOf(state.ydoc, successor, item);
}

/**
 * The key, if `item` was an overwritten entry of a root map that its codec
 * calls presentation-only (SAFE-A22), or null. Only a plain overwrite
 * qualifies: an entry inside a deleted container held whatever it held.
 */
function presentationOnly(state: StructuredDocState, item: Y.Item): string | null {
  const codec = state.codec;
  if (!codec.presentationOnly || item.parentSub === null) return null;
  const parent = item.parent as Y.AbstractType<unknown>;
  if (insideDeleted(parent)) return null;
  for (const [name, type] of state.ydoc.share) {
    if (type === parent) return codec.presentationOnly(name, item.parentSub) ? item.parentSub : null;
  }
  return null;
}

/**
 * One structured file's sync state.
 *
 * Exported for the data-safety tests, like ContentSync's `FileDocState`.
 */
export interface StructuredDocState {
  docName: string;
  sharedFolderId: string;
  relativePath: string;
  localPath: string;
  ydoc: Y.Doc;
  codec: StructuredCodec;
  idbProvider: IndexeddbPersistence;
  writeTimer: TimerHandle | null;
  writeRetries: number;
  /**
   * Disk text last known to match the document — written by us, or read by us
   * and found equal. It is both the echo guard (a file still holding exactly
   * this is not a new edit) and the base an edit is diffed against, so that a
   * change made on disk cannot revert remote changes the file had not yet
   * received. `null`: never confirmed, treated as "possibly unsynced".
   */
  lastSyncedText: string | null;
  /** Whether the server has confirmed this document at least once. */
  hasSyncedOnce: boolean;
  /** The first disk write of each connect backs up anything it replaces. */
  firstWriteChecked: boolean;
  /**
   * Every client id this vault has written this document under, across
   * sessions. A new Y.Doc gets a new random id each launch, so without the
   * history an edit made offline yesterday would not be recognised as ours
   * when a concurrent write erases it today.
   */
  ourClients: Set<number>;
  /** Which of those have been written to the stored history. */
  recordedClients: Set<number>;
  /** A settle is queued for after the current transaction (SAFE-A27). */
  settleQueued?: boolean;
  /**
   * The text disk and document last agreed on, as an earlier session recorded
   * it (SAFE-A30): what tells a file left behind from a file edited while this
   * vault was not syncing it. Null when nothing was recorded.
   */
  agreedAtConnect?: string | null;
  /**
   * `lastSyncedText` is an earlier session's record, not a text this session
   * wrote or read: a view's save on close can have overtaken it, so nothing
   * in it is known to be what a save was built on (see `verifyBase`).
   */
  baseFromRecord?: boolean;
  /**
   * Per client id of ours, the clock up to which our entries are known to be on
   * the server. See `noteAcknowledged` and `lostUnseen`.
   */
  acknowledged: Map<number, number>;
  /** Refuse to fill the document from disk; see `connectFile`. */
  mayFill: boolean;
  /** A conflict copy being written; disk writes wait for it. */
  keeping: Promise<void>;
  /** The last save kept aside as another file's content (see `keepForeign`). */
  foreignKept?: string;
  /** The last save kept for what it held of a closed view's (`keepPassedOver`). */
  passedOverKept?: string;
  /** Why this client refuses to touch the file, or null. See `handOffReason`. */
  handedOff: string | null;
  /** So an unreadable file is announced once, not on every save. */
  unparseableAnnounced: boolean;
  onTransaction: ((tr: Y.Transaction) => void) | null;
  /** Views bound to the document, each writing the file itself; see `bindView`. */
  boundViews: Set<BoundView>;
  /** How many callers hold the document through `acquireDoc`. */
  acquired: number;
  /**
   * Text being written right now. Its modify event can be read before the
   * write's continuation records it in `lastSyncedText`; read in then, a card
   * edit in it would be merged into text that already holds it, twice.
   */
  writingText: string | null;
  /** A `writeToDisk` is running; see there. */
  writeInFlight: boolean;
}

/**
 * Whatever shows a structured file to the user besides the file itself — an
 * open view that holds its own copy and saves it on its own schedule.
 *
 * Writing a file under such a view is where over-disk sync loses work if it
 * loses any: the view can discard an edit it has not saved yet when it reloads
 * our write, or miss our write entirely and later save its stale copy back,
 * which would read as the user reverting the remote change (SAFE-A19). The
 * surface is how StructuredSync asks the view, without knowing what it is.
 * The canvas one is text-view-guard.ts; a live binding to the view would be
 * another.
 */
export interface StructuredSurface {
  /** Make any open view of the file save what it holds, before the file is replaced. */
  beforeWrite(localPath: string): Promise<void>;
  /**
   * The file now says `text`: check that open views load it. `readBack` reads
   * the file as it is now, for a surface that has to bring a view up to date.
   */
  afterWrite(localPath: string, text: string, readBack?: () => Promise<string>): void;
  /**
   * The text an open view last loaded, when it has not loaded the latest
   * write — the base its next save must be diffed against. Null otherwise.
   */
  baseFor(localPath: string): string | null;
  /** A save from the file's views was read in: they hold `text`. */
  ingested(localPath: string, text: string): void;
}

/**
 * A view bound live to a document (canvas-live.ts): it carries its own edits
 * into the document as they happen, shows remote changes as they arrive, and
 * saves the file itself. StructuredSync then writes nothing under it, and asks
 * it the three things only it knows.
 */
export interface BoundView {
  /**
   * Whether the view held `value` at some recent point — a save of it is then
   * one the binding already carried in, an echo. A view saves about two
   * seconds after an edit, and the binding may have moved on since, so this
   * is a recent history, not only the latest.
   */
  holds(value: unknown): boolean;
  /**
   * A save the binding did not carry in: an edit no hook saw. The base to diff
   * it against — what the view held when it was made, never the document,
   * which may hold remote changes the view had not shown.
   */
  baseFor(value: unknown): unknown;
  /** What the view shows now, serialised as the file would be. */
  shownText(): string | null;
  /**
   * Read a save of the view in, the binding deciding how — in place of
   * `holds` and `baseFor`. For a binding that compares by version rather
   * than keeping a history of what its view held (excalidraw-live.ts): it is
   * then the one writer of the file's content while bound.
   */
  readInSave?: (value: unknown) => { passedOver: string[]; keep?: boolean } | void;
  /**
   * The document is being torn down — the file deleted remotely, its folder
   * gone, sync stopped. Let go: a binding left holding a destroyed document
   * stays "bound", so nothing ever binds the view again.
   */
  letGo?: () => void;
}

/** How `bindView` went. Anything but `bound` leaves the file on the disk path. */
export type BindResult = 'bound' | 'not-ready' | 'unknown' | 'refused';

/**
 * What structured sync needs from the plugin around it. The same three as
 * ContentSync, plus the formats it may read and a way to tell the user.
 */
export interface StructuredSyncDeps {
  hasKeys(sharedFolderId: string): boolean;
  docIndex: DocIndex;
  vaultKey(): string;
  /** Codecs by extension. Production passes `STRUCTURED_FORMATS`. */
  formats: Readonly<Record<string, StructuredCodec>>;
  /**
   * Say something to the user. Every rule below that keeps a version aside, or
   * refuses to act, says so: a copy nobody knows about is only a little better
   * than no copy.
   */
  notify(message: string): void;
  /** Open views of structured files, if there are any to consult. See StructuredSurface. */
  surface?: StructuredSurface;
  /**
   * Whether someone is mid-edit in an open view of the file that is not bound
   * — typing in a drawing's text, holding the pointer down in it. The write
   * waits, the change held in the document, until the edit ends (SAFE-A26):
   * what is mid-edit is in no file yet, and the view's reload would lose it.
   */
  editInProgress?(localPath: string): boolean;
  /**
   * What an open view of the file knows that its save does not say. For a
   * drawing: the elements it deleted, which Excalidraw for Obsidian leaves out
   * of the file instead of writing them deleted. Taken from the view that
   * holds them — never inferred from what a save lacks, since a view that
   * never loaded an element lacks it too. `current` is the document now.
   */
  withViewDeletes?(localPath: string, saved: unknown, current: unknown, settled?: boolean): unknown;
  /**
   * Resolves once what the deps above remember across a restart has been
   * read back. Awaited before any file connects: the first write of a connect
   * reads the file in, and a drawing's delete it did not know of yet was put
   * back (NEC-211).
   */
  ready?(): Promise<void>;
  /**
   * The base a save may be read in against, without what no open view of the
   * file was seen to show. A version in the base is removed as superseded by
   * the save's newer one, which is true only if the save was built on it; a
   * view whose scene missed our write built on what it held before (NEC-212).
   * `fromRecord`: the base is an earlier session's record, not this session's.
   */
  verifyBase?(localPath: string, saved: unknown, base: unknown, fromRecord: boolean): unknown;
  /**
   * The base for a view's save when the open views of the file are known to
   * have loaded what `written`, our last write, brought that `prior` — what
   * they held before it — lacked: the parts of `written` they were seen to
   * show, and `prior` for the rest. Null when that cannot be seen. The
   * surface's base for a view's save assumes they did not load it; a
   * drawing's view, which says nothing of its scene in its `data`, can be
   * seen this way instead (NEC-226, NEC-231).
   */
  loadedBase?(localPath: string, written: unknown, prior: unknown): unknown;
  /**
   * The base for a save, with the parts a view of the file held as it closed
   * taken as unchanged where the save holds them and the base does not: what
   * a closing view saved on its way out, built on what it showed before a
   * remote change (NEC-235). Names the parts it passed over, and `keep` when
   * the save is to be kept in .nectenda-backups: once per closed view, and
   * not for a save that only lacks links.
   */
  restBase?(localPath: string, saved: unknown, base: unknown): { base: unknown; passedOver: string[]; keep?: boolean };
  /**
   * Make every open view of the file whose scene holds something `current` —
   * the document — does not save, whatever the view says of its unsaved work.
   * Before every write, ahead of the surface's own ask (NEC-228).
   */
  saveViewsAhead?(localPath: string, current: unknown): Promise<void>;
  /**
   * What open views of the file were seen to hold that the document, `ydoc`,
   * never had and no save carried — kept past the view, which may have
   * switched file, closed or been rebuilt since: `current` with it put in, and
   * the base to read that against. Null when there is none. Read in before
   * every write (NEC-236).
   */
  withRecordedAhead?(localPath: string, current: unknown, ydoc: Y.Doc): { value: unknown; base: unknown } | null;
  /** Whether there is anything for `withRecordedAhead`; only looks. */
  holdsRecordedAhead?(localPath: string, current: unknown, ydoc: Y.Doc): boolean;
}

/**
 * Sync for files merged key by key: one Y.Doc per file, bound to its codec,
 * written back to disk on change.
 *
 * The lifecycle is ContentSync's — the same document naming, IndexedDB cache,
 * checkpointed subscribe and first-sync ordering — and so are the safety rules,
 * restated for a document that is not text. What is new is the part Yjs does
 * not give a structured document: **a key two vaults write at once keeps one
 * value and discards the other without a trace**, and a map deleted while
 * someone edits inside it takes their edit with it. Text never loses an
 * insertion to a concurrent edit; maps do. `onTransaction` notices when the
 * value discarded was this vault's and keeps a copy of it (SAFE-A14).
 *
 * Over disk. An open view is consulted through `StructuredSurface` before its
 * file is written, and a view that writes the file itself can take the
 * document over with `acquireDoc` and `bindView`.
 */
export class StructuredSync {
  private deps: StructuredSyncDeps;
  private provider: SyncProvider;
  private vault: VaultAdapter;
  private docs: Map<string, StructuredDocState> = new Map();
  private connecting: Set<string> = new Set();
  /** Set by `stop`. */
  private stopped = false;
  private unplaced: Map<string, {
    sharedFolderId: string; folderLocalPath: string; relativePath: string; format?: string; fill: boolean;
  }> = new Map();
  private folderDocs: Map<string, Set<string>> = new Map();
  /** Paths whose format this build cannot read, announced once each. */
  private unreadableFormats: Set<string> = new Set();

  constructor(deps: StructuredSyncDeps, provider: SyncProvider, vault: VaultAdapter) {
    this.deps = deps;
    this.provider = provider;
    this.vault = vault;
  }

  /**
   * Start syncing one file.
   *
   * `format` is what the folder listing recorded, when it has an entry. It
   * wins over the extension: a file a newer client listed as a format this one
   * lacks must be left alone, not read as whatever its name suggests (SAFE-A16).
   *
   * `fill: false` for a file this vault did not originate under this path — a
   * rename that arrived from another vault. The vault that made the rename
   * fills the new document from its file; this one must not fill it too from
   * its own copy, or two independent fills collide key by key (and this copy
   * may be the staler one). Until that fill arrives the document is unfilled,
   * and an unfilled document is never written over a file (SAFE-A3).
   */
  connectFile(
    sharedFolderId: string,
    folderLocalPath: string,
    relativePath: string,
    format?: string,
    options: ConnectOptions = {},
  ): void {
    const codec = format
      ? codecForFormat(format, this.deps.formats)
      : codecForPath(relativePath, this.deps.formats);
    if (!codec) {
      this.announceUnreadable(relativePath, format ?? '(unknown)');
      return;
    }

    const gate = `${sharedFolderId}\n${relativePath}`;
    if (this.connecting.has(gate)) return;
    const known = this.deps.docIndex.refSync(sharedFolderId, relativePath);
    if (known && this.docs.has(known)) return;

    this.connecting.add(gate);
    void this.doConnectFile(sharedFolderId, folderLocalPath, relativePath, codec, gate, options).catch((err: unknown) => {
      this.connecting.delete(gate);
      log.warn('Could not connect a structured file', { relativePath, error: String(err) });
    });
  }

  private announceUnreadable(relativePath: string, format: string): void {
    log.warn('A structured file uses a format this version cannot read; leaving it alone', {
      relativePath, format,
    });
    if (this.unreadableFormats.has(relativePath)) return;
    this.unreadableFormats.add(relativePath);
    this.deps.notify(
      `Nectenda: "${relativePath}" was shared in a format this version cannot read. ` +
      'It is left untouched here — update Nectenda to sync it.',
    );
  }

  private async doConnectFile(
    sharedFolderId: string,
    folderLocalPath: string,
    relativePath: string,
    codec: StructuredCodec,
    gate: string,
    options: ConnectOptions,
  ): Promise<void> {
    if (this.deps.ready) {
      // Not for ever: IndexedDB that never answers would hold every
      // structured file unconnected, which is worse than what the record
      // prevents (a delete come back, visibly).
      let timer: number | null = null;
      try {
        const late = await Promise.race([
          this.deps.ready().then(() => false),
          new Promise<boolean>((resolve) => {
            timer = window.setTimeout(() => resolve(true), READY_WAIT_MS);
          }),
        ]);
        if (late) log.warn('What structured files remember across a restart was not read in time; connecting without it', { relativePath, waitedMs: READY_WAIT_MS });
      } catch (err) {
        log.warn('What structured files remember across a restart could not be read; connecting without it', { relativePath, error: String(err) });
      } finally {
        if (timer !== null) window.clearTimeout(timer);
      }
    }
    if (this.stopped) {
      this.connecting.delete(gate);
      return;
    }
    let docName: string;
    try {
      docName = await this.deps.docIndex.ref(sharedFolderId, relativePath);
    } catch (err) {
      this.connecting.delete(gate);
      log.warn('Cannot connect a structured file in a folder with no keys', {
        relativePath, error: String(err),
      });
      return;
    }
    if (this.docs.has(docName)) {
      this.connecting.delete(gate);
      return;
    }

    const ydoc = new Y.Doc();
    // The roots onTransaction tells apart, defined before anything is loaded.
    // A root first met in an update is a placeholder in `share` until it is
    // asked for by type, and the asking replaces it: a transaction that
    // created it would then name an object `share` no longer holds, and a
    // check against `share.get` would miss it.
    ydoc.getMap(META_ROOT);
    if (codec.fromText) ydoc.getText('content');
    const idbProvider = new IndexeddbPersistence(idbStoreName(this.deps.vaultKey(), docName), ydoc);
    const state: StructuredDocState = {
      docName,
      sharedFolderId,
      relativePath,
      localPath: `${folderLocalPath}/${relativePath}`,
      ydoc,
      // This file's codec reads and writes the folder's paths as this vault
      // names them, the document holding them relative to the folder (SAFE-A33).
      codec: codec.forRoot?.(folderLocalPath) ?? codec,
      idbProvider,
      writeTimer: null,
      writeRetries: 0,
      lastSyncedText: null,
      hasSyncedOnce: false,
      firstWriteChecked: false,
      ourClients: new Set([ydoc.clientID]),
      recordedClients: new Set(),
      acknowledged: new Map(),
      mayFill: options.fill ?? true,
      keeping: Promise.resolve(),
      handedOff: null,
      unparseableAnnounced: false,
      onTransaction: null,
      boundViews: new Set(),
      acquired: 0,
      writingText: null,
      writeInFlight: false,
    };
    this.docs.set(docName, state);
    this.connecting.delete(gate);
    let tracked = this.folderDocs.get(sharedFolderId);
    if (!tracked) {
      tracked = new Set();
      this.folderDocs.set(sharedFolderId, tracked);
    }
    tracked.add(docName);

    const startSync = async (): Promise<void> => {
      // Before subscribing, so no remote update can land before this vault
      // knows which of the document's entries are its own.
      await this.loadOurClients(state);
      if (this.docs.get(docName) !== state) return; // disconnected meanwhile

      const onTransaction = (tr: Y.Transaction): void => this.onTransaction(state, tr);
      state.onTransaction = onTransaction;
      ydoc.on('afterTransaction', onTransaction);

      try {
        this.provider.subscribe(
          docName,
          ydoc,
          {
            load: () => loadSeqCheckpoint(idbProvider, ydoc),
            save: (seq) => saveSeqCheckpoint(idbProvider, ydoc, seq),
          },
          {
            beforeRemoteUpdate: () => this.noteAcknowledged(state),
          },
          // A format whose presence is larger (a canvas pointer and card
          // caret) names its own bucket, so length does not say what someone
          // is doing (presence-seal.ts, CRYPTO-113, WIRE-095).
          { presencePadBytes: state.codec.presencePadBytes ?? PRESENCE_PAD_BYTES },
        );
      } catch (err) {
        log.warn('Could not subscribe this structured file; it is not connected', {
          path: state.localPath, error: String(err),
          // Where, too: a stack overflow here said only its own name.
          stack: err instanceof Error ? (err.stack ?? '').split('\n').slice(1, 16).map((l) => l.trim()).join(' | ') : undefined,
        });
        this.abandonUnsubscribed(state, folderLocalPath);
        return;
      }

      this.checkHandOff(state);
      this.scheduleDiskWrite(state);

      // Fill, then confirm, then write — one handler, in this order, for the
      // reason ContentSync's first sync gives: split across listeners, the
      // write could win the race and treat a document not yet filled as the
      // truth.
      const runFirstSync = async (): Promise<void> => {
        this.provider.off(`synced:${docName}`, onFirstSync);
        await this.seedIfEmpty(state);
        state.hasSyncedOnce = true;
        if (!this.checkHandOff(state)) this.upgradeSchema(state);
        this.scheduleDiskWrite(state);
      };
      const onFirstSync = (): void => {
        void runFirstSync().catch((err: unknown) => {
          log.warn('First sync of a structured file failed', { docName, error: String(err) });
        });
      };
      if (this.provider.isSynced(docName)) onFirstSync();
      else this.provider.on(`synced:${docName}`, onFirstSync);
    };

    const start = (): void => {
      void startSync().catch((err: unknown) => {
        log.warn('Could not start a structured file', { docName, error: String(err) });
      });
    };
    if (idbProvider.synced) start();
    else idbProvider.once('synced', start);
  }

  private async loadOurClients(state: StructuredDocState): Promise<void> {
    try {
      const agreed = (await state.idbProvider.get(AGREED_KEY)) as unknown;
      state.agreedAtConnect = typeof agreed === 'string' ? agreed : null;
    } catch {
      state.agreedAtConnect = null; // reads as "never recorded", which keeps more
    }
    try {
      const raw = (await state.idbProvider.get(CLIENTS_KEY)) as string | undefined | null;
      if (raw) {
        const ids = JSON.parse(raw) as unknown;
        if (Array.isArray(ids)) {
          for (const id of ids) {
            if (typeof id !== 'number') continue;
            state.ourClients.add(id);
            state.recordedClients.add(id);
          }
        }
      }
      log.debug('Client ids this vault wrote a file under', { path: state.localPath, now: state.ydoc.clientID, known: [...state.ourClients] });
      // Anything malformed reads as "nothing acknowledged", which only ever
      // keeps more.
      const acked = (await state.idbProvider.get(ACKED_KEY)) as string | undefined | null;
      if (acked) {
        const pairs = JSON.parse(acked) as unknown;
        if (Array.isArray(pairs)) {
          for (const p of pairs) {
            if (Array.isArray(p) && typeof p[0] === 'number' && typeof p[1] === 'number') {
              state.acknowledged.set(p[0], p[1]);
            }
          }
        }
      }
    } catch (err) {
      // Losing the history means an old offline edit might be overwritten
      // without a copy. Loud, because that is the case this exists for.
      log.warn('Could not read which edits to this file were made here', {
        path: state.localPath, error: String(err),
      });
    }
  }

  /**
   * Remember the id this vault is writing under.
   *
   * Read from the document on every local change rather than once at connect:
   * Yjs replaces a document's client id itself when it sees the id in use by
   * someone else, and entries written under the replacement are just as much
   * this vault's.
   */
  private recordOurClient(state: StructuredDocState): void {
    const id = state.ydoc.clientID;
    if (state.recordedClients.has(id)) return;
    state.ourClients.add(id);
    state.recordedClients.add(id);
    const ids = JSON.stringify([...state.ourClients]);
    log.debug('Recording a client id this vault writes a file under', { path: state.localPath, id });
    void Promise.resolve(state.idbProvider.set(CLIENTS_KEY, ids)).catch((err: unknown) => {
      state.recordedClients.delete(id);
      log.warn('Could not record that this vault edited a file', {
        path: state.localPath, error: String(err),
      });
    });
  }

  /**
   * Every change to the document, wherever it came from.
   *
   * For a remote update, the question is whether it discarded anything this
   * vault wrote **without having seen it** — the other side's value for the
   * same key won, or a map holding it was deleted by someone who had not seen
   * the edit inside it. Yjs resolves both silently, so this is the only place
   * either can be caught. `lostUnseen` decides, entry by entry.
   *
   * It does not use the update's delete set, which is the obvious signal and a
   * wrong one: on reconnect the provider sends a merged delta, and a merged
   * delta carries the sender's entire delete set — including this vault's
   * entry, which the sender's own merge discarded without anyone seeing it.
   */
  private onTransaction(state: StructuredDocState, tr: Y.Transaction): void {
    // Whatever changed the document — a remote update, a disk read-in, a bound
    // view — may have left two versions of one record to settle (SAFE-A27).
    if (tr.origin !== SETTLE_ORIGIN && tr.changed.size > 0) this.queueSettle(state);
    // An older client's edit of the text, after the takeover. Not a change that
    // also stamped the document: that is a fill, or a snapshot of the whole
    // log arriving at once, and an older client never writes the stamp.
    if (tr.origin === REMOTE_ORIGIN && state.codec.fromText && this.isStamped(state)) {
      const changed = [...tr.changed.keys()];
      if (changed.includes(state.ydoc.share.get('content') as never)
        && !changed.includes(state.ydoc.share.get(META_ROOT) as never)) {
        this.keepTextVersion(state);
      }
    }
    if (tr.origin === REMOTE_ORIGIN) {
      let lost = 0;
      Y.iterateDeletedStructs(tr, tr.deleteSet, (struct) => {
        if (!(struct instanceof Y.Item)) return;
        if (!state.ourClients.has(struct.id.client)) return;
        if (!lostUnseen(state, struct)) return;
        const quiet = presentationOnly(state, struct);
        if (quiet) {
          // A sort, a size: one value wins and no copy is made (SAFE-A22).
          // Logged, so the value that lost can still be found.
          const lostValue: unknown = struct.content.getContent()[0];
          log.info('A concurrent change replaced a view setting made here', {
            path: state.localPath, key: quiet, lost: lostValue,
          });
          return;
        }
        lost++;
      });
      if (lost > 0) this.keepLostLocalVersion(state, lost);
      this.checkHandOff(state);
      this.scheduleDiskWrite(state);
      return;
    }
    // Any change made here counts as ours, whatever its origin: disk today, a
    // view bound to the document tomorrow. Updates applied from elsewhere —
    // the server, IndexedDB — are not local transactions.
    if (tr.local && tr.changed.size > 0) this.recordOurClient(state);
  }

  /**
   * Note, from the provider's own account, how much of this vault's work has
   * certainly reached the server. Called just before each remote update lands.
   *
   * Only ever raised when nothing of ours is outstanding, so it is never ahead
   * of the truth; when it lags — no remote update since the last push was
   * acknowledged — an entry is treated as unacknowledged, and kept if lost.
   * That is the direction to be wrong in.
   */
  private noteAcknowledged(state: StructuredDocState): void {
    const s = this.provider.docSyncState?.(state.docName);
    if (!s) return;
    // Not during a catch-up, nor before its reconcile delta is counted: a
    // cold start holds work restored from IndexedDB that no flag reports as
    // unsent until the reconcile has computed it. Only a synced document with
    // nothing queued, sending or unacknowledged has certainly delivered it all.
    if (!s.synced || s.reconciling) return;
    if (s.pending > 0 || s.flushing || s.hasUnsentWork || s.awaitingAck > 0 || s.owesReconcile) return;
    let changed = false;
    for (const [client, clock] of Y.decodeStateVector(Y.encodeStateVector(state.ydoc))) {
      if (!state.ourClients.has(client) || (state.acknowledged.get(client) ?? 0) >= clock) continue;
      state.acknowledged.set(client, clock);
      changed = true;
    }
    if (!changed) return;
    const record = JSON.stringify([...state.acknowledged]);
    void Promise.resolve(state.idbProvider.set(ACKED_KEY, record)).catch((err: unknown) => {
      log.debug('Could not record acknowledged work', { path: state.localPath, error: String(err) });
    });
  }

  /**
   * Disk and document were just seen to agree on `text`: note it, for the echo
   * guard and the next diff, and for the next session (SAFE-A30). Only ever
   * text the disk held while the document held all of it — never a fill from
   * another source the file may be behind.
   */
  private agree(state: StructuredDocState, text: string): void {
    state.lastSyncedText = text;
    state.baseFromRecord = false;
    void Promise.resolve(state.idbProvider.set(AGREED_KEY, text)).catch((err: unknown) => {
      log.warn('Could not record what a structured file agreed on with its document', {
        path: state.localPath, error: String(err),
      });
    });
  }

  /**
   * Settle, once the transaction that called for it is over: a transaction
   * cannot be opened from inside another's observers.
   */
  private queueSettle(state: StructuredDocState): void {
    if (!state.codec.settle || state.settleQueued) return;
    state.settleQueued = true;
    queueMicrotask(() => {
      state.settleQueued = false;
      if (this.docs.get(state.docName) !== state) return;
      this.settle(state);
    });
  }

  /**
   * Let the codec settle what concurrent edits left behind (SAFE-A27): for
   * Excalidraw, two versions of one element, one of them this vault's that
   * lost. Only this vault's own entries are its to decide — `isOurs` — so each
   * losing version is kept, or converged, by its author alone. A take-over
   * fill's version has no author among the vaults, and the codec decides it in
   * whichever vault meets it (SAFE-A27, SAFE-A28).
   */
  private settle(state: StructuredDocState): void {
    // Inside Yjs's own transaction cleanup: a throw there would break it, so
    // a runaway settle stops here, logged, instead.
    try {
      guardRunaway('settling concurrent edits', { path: state.localPath });
    } catch {
      return;
    }
    const codec = state.codec;
    if (!codec.settle || state.handedOff || !this.isStamped(state)) return;
    let outcome: SettleOutcome | null = null;
    try {
      state.ydoc.transact(() => {
        outcome = codec.settle!(state.ydoc, (root, key) => {
          const item = (state.ydoc.getMap(root) as unknown as { _map: Map<string, Y.Item> })._map.get(key);
          return item !== undefined && !item.deleted && state.ourClients.has(item.id.client);
        });
      }, SETTLE_ORIGIN);
    } catch (err) {
      log.error('Could not settle concurrent edits', { path: state.localPath, error: String(err) });
      return;
    }
    const done = outcome as SettleOutcome | null;
    if (!done) return;
    for (const c of done.converged ?? []) {
      // Nothing anyone wrote was lost, but the value that lost is logged so it
      // can still be found (SAFE-A22).
      log.info('A concurrent change won over an edit made here; nothing written was lost', {
        path: state.localPath, id: c.id, why: c.why, lost: c.lost,
      });
    }
    const all = done.kept ?? [];
    if (all.length === 0) return;
    // A fill's version was nobody's here: the drawing as text sync had it,
    // before it was taken over. Not "your version", which it may never have been.
    const kept = all.filter((k) => k.fill !== true);
    const filled = all.filter((k) => k.fill === true);
    const shapes = (n: number): string => (n === 1 ? 'one shape was' : `${n} shapes were`);
    if (kept.length > 0) {
      log.warn('A concurrent change won over edits made here; kept them in the drawing', {
        path: state.localPath, kept,
      });
      this.deps.notify(
        `Nectenda: "${state.relativePath}" was changed in two places at once. ` +
        `Your version of ${shapes(kept.length)} kept beside the original, labelled "Kept by Nectenda".`,
      );
    }
    if (filled.length > 0) {
      log.warn('A change won over the version a drawing had before it was taken over from text; kept it in the drawing', {
        path: state.localPath, kept: filled,
      });
      this.deps.notify(
        `Nectenda: "${state.relativePath}" was changed in two places at once. ` +
        `The version from before live sync of ${shapes(filled.length)} kept beside the original, labelled "Kept by Nectenda".`,
      );
    }
  }

  /**
   * A client that predates the format edited the file as text, after this
   * vault took it over from text (SAFE-A28). That edit cannot merge into the
   * structured document; its text is kept as a conflict copy beside the file,
   * once per version — remembered in the document's store, so a restart does
   * not copy it again, and in the document itself, so another vault does not
   * either. (Two vaults keeping the same version within the same moment still
   * both do: a second copy, never a missing one.)
   */
  private keepTextVersion(state: StructuredDocState): void {
    const text = state.ydoc.getText('content').toString();
    if (text.trim() === '') return;
    state.keeping = state.keeping.then(async () => {
      const kept = (await state.idbProvider.get(TEXT_KEPT_KEY)) as unknown;
      if (kept === text) return;
      const keptIn = state.ydoc.getMap<boolean>(TEXT_KEPT_ROOT);
      const mark = textMark(text);
      if (keptIn.get(mark) === true) {
        await state.idbProvider.set(TEXT_KEPT_KEY, text);
        return;
      }
      const copy = await writeConflictCopy(this.vault, state.localPath, text);
      if (!copy) return;
      state.ydoc.transact(() => keptIn.set(mark, true), LOCAL_ORIGIN);
      await state.idbProvider.set(TEXT_KEPT_KEY, text);
      log.warn('An older client changed a file this version syncs as structured; kept its version as a conflict copy', {
        path: state.localPath, copy,
      });
      this.deps.notify(
        `Nectenda: "${state.relativePath}" was changed by a member on an older version of Nectenda. ` +
        'Their version was kept as a conflict copy beside it.',
      );
    }).catch((err: unknown) => {
      log.error('Could not keep a text version an older client wrote', { path: state.localPath, error: String(err) });
    });
  }

  /**
   * Keep this vault's version beside the file, because a remote change just
   * discarded part of it (SAFE-A14).
   *
   * The version on disk is the one to keep: every local change to a structured
   * file arrives from disk, so the file still holds what was just lost. The
   * next disk write waits for this, or it would replace the file first.
   *
   * Not while a view is bound: its edits reach the document as they are made,
   * and the file lags it by the view's save delay, so the file may not hold
   * what was lost — the view does. Taken now, synchronously, before the remote
   * change that discarded it is drawn into the view.
   */
  private keepLostLocalVersion(state: StructuredDocState, entries: number): void {
    const shown = this.shownText(state);
    state.keeping = state.keeping.then(async () => {
      let disk = shown;
      if (disk === null) {
        if (!this.vault.isFile(state.localPath)) return;
        disk = await this.vault.read(state.localPath);
      }
      if (disk.trim() === '') return;
      const copy = await writeConflictCopy(this.vault, state.localPath, disk);
      log.warn('A concurrent change overwrote edits made here — kept them as a conflict copy', {
        path: state.localPath, entries, copy,
      });
      if (copy) {
        this.deps.notify(
          `Nectenda: "${state.relativePath}" was changed in two places at once. ` +
          'Your version was kept as a conflict copy beside it.',
        );
      }
    }).catch((err: unknown) => {
      log.error('Could not keep a version a concurrent change overwrote', {
        path: state.localPath, error: String(err),
      });
    });
  }

  /**
   * Why this client must not touch the file, or null (SAFE-A16).
   *
   * The `meta` root says which format wrote the document and at which schema
   * version. A document from a newer client may hold fields this codec would
   * read as absent and then write back without — so it is left alone, rather
   * than half-understood.
   */
  private handOffReason(state: StructuredDocState): string | null {
    const meta = state.ydoc.getMap<unknown>(META_ROOT);
    const format = meta.get('format');
    const version = meta.get('version');
    if (format === undefined) return null; // not filled yet; nothing to disagree with
    if (format !== state.codec.format) return `written as "${String(format)}"`;
    if (typeof version !== 'number' || version > state.codec.version) {
      return `written by a newer version (schema ${String(version)})`;
    }
    return null;
  }

  private checkHandOff(state: StructuredDocState): boolean {
    if (state.handedOff) return true;
    const reason = this.handOffReason(state);
    if (!reason) return false;
    state.handedOff = reason;
    log.warn('Structured file handed off — this version will not read or write it', {
      path: state.localPath, reason,
    });
    this.deps.notify(
      `Nectenda: "${state.relativePath}" was ${reason}. ` +
      'It is left untouched here — update Nectenda to sync it.',
    );
    return true;
  }

  /**
   * Bring a document an older client stamped up to this codec's schema, once
   * the server has been heard from, and restamp it — in one transaction, so no
   * client ever sees the new stamp over the old shape. From then on an older
   * client hands the file off (SAFE-A16), visibly, rather than reading the new
   * shape as the old one. A canvas at schema 1 holds this vault's own paths for
   * files in the folder; its upgrade makes them relative to the folder
   * (canvas-paths.ts, SAFE-A33).
   */
  private upgradeSchema(state: StructuredDocState): void {
    if (!this.isStamped(state) || !state.codec.upgrade) return;
    const meta = state.ydoc.getMap<unknown>(META_ROOT);
    const from = meta.get('version');
    if (typeof from !== 'number' || from > state.codec.version) return;
    // Run at this version too, not only below it: the first vault to upgrade
    // can only rewrite what it can recognise — for a canvas, paths under its
    // own root — so each vault puts right its own share of what older clients
    // wrote, whoever restamped first (found in review). An upgrade must
    // therefore be a no-op on a document already in its shape.
    const upgrade = state.codec.upgrade.bind(state.codec);
    state.ydoc.transact(() => {
      upgrade(state.ydoc, from);
      if (from < state.codec.version) meta.set('version', state.codec.version);
    }, LOCAL_ORIGIN);
    if (from < state.codec.version) {
      log.info('Upgraded a structured document to this version\'s schema', {
        path: state.localPath, from, to: state.codec.version,
      });
    }
  }

  /** Whether the document has ever been filled — by anyone. */
  private isStamped(state: StructuredDocState): boolean {
    return state.ydoc.getMap(META_ROOT).get('format') !== undefined;
  }

  /**
   * Record the format beside the content, in the same transaction.
   *
   * Also what tells "uploaded, and empty" from "nobody has uploaded this yet":
   * the second must never be written over a file, and without a marker the two
   * are the same empty document.
   */
  private stampMeta(state: StructuredDocState): void {
    const meta = state.ydoc.getMap<unknown>(META_ROOT);
    if (meta.get('format') === state.codec.format && meta.get('version') === state.codec.version) return;
    meta.set('format', state.codec.format);
    meta.set('version', state.codec.version);
  }

  /**
   * Fill an empty document from the file, once the server has confirmed there
   * is nothing there.
   *
   * Only then, and only into an empty document. Two vaults filling the same
   * document independently is the one thing a structured document cannot
   * absorb: their maps collide key by key and one side's subtree replaces the
   * other's whole. Waiting for the server narrows that to vaults connecting
   * within the same moment, and `onTransaction` keeps a copy in that case.
   * Offline, the file stays the only copy until the server can be asked.
   */
  private async seedIfEmpty(state: StructuredDocState): Promise<void> {
    if (this.isStamped(state)) return;
    if (!state.mayFill) return;
    if (state.codec.fromText) {
      await this.seedFromText(state);
      return;
    }
    if (!this.vault.isFile(state.localPath)) return;
    const disk = await this.vault.read(state.localPath);
    if (disk.trim() === '') return;
    const parsed = state.codec.parse(disk);
    if (!parsed.ok) {
      this.announceUnparseable(state, parsed.error);
      return;
    }
    if (this.isStamped(state)) return; // filled by the server while reading
    state.ydoc.transact(() => {
      this.stampMeta(state);
      state.codec.apply(state.ydoc, parsed.value, null);
    }, LOCAL_ORIGIN);
    this.agree(state, disk);
    log.debug('Filled a structured document from its file', { path: state.localPath });
  }

  /**
   * Fill a document for a format that took its files over from text
   * (SAFE-A28).
   *
   * The document is the one text sync followed — same name, same store — so it
   * already holds the note as text, merged across every vault that synced it.
   * That text is the fill, not this vault's file, which may be behind it. Every
   * vault taking the file over fills from the same merged text, under an
   * identity derived from it (seed-update.ts): two vaults doing it at once
   * write one fill, not two.
   *
   * The file is then compared with what text sync last agreed with it
   * (SAFE-A30): a file changed since is an edit, read in against that text; a
   * file equal to it is only behind, and the next write brings it up to date.
   * With nothing to tell the two apart, the first write keeps the file aside
   * before replacing it (SAFE-A2).
   *
   * A file never synced as text — a drawing new to the folder — has no text;
   * it fills from the file, under the same derived identity.
   *
   * The text is read before, and the fill applied after, awaits on the file
   * and a hash. An older client's edit landing in between is neither in the
   * fill, which parsed the text before it, nor kept by `onTransaction`, which
   * keeps only an edit to a stamped document: it was in neither the drawing
   * nor a copy. So a fill whose text has moved keeps the newer text as a copy,
   * as it would an older client's edit a moment later. Not filling again from
   * the newer text instead: two vaults would then fill from different texts,
   * under different identities, and the note above the drawing would be
   * filled twice (SAFE-A28).
   */
  private async seedFromText(state: StructuredDocState): Promise<void> {
    const merged = state.ydoc.getText('content').toString();
    const disk = this.vault.isFile(state.localPath) ? await this.vault.read(state.localPath) : '';
    const source = merged.trim() !== '' ? merged : disk;
    if (source.trim() === '') return;
    const parsed = state.codec.parse(source);
    if (!parsed.ok) {
      this.announceUnparseable(state, parsed.error);
      return;
    }
    const seedDoc = new Y.Doc();
    seedDoc.clientID = await deriveSeedClientId(state.docName, `${state.codec.format}\u0000${source}`);
    seedDoc.transact(() => {
      const meta = seedDoc.getMap<unknown>(META_ROOT);
      meta.set('format', state.codec.format);
      meta.set('version', state.codec.version);
      state.codec.apply(seedDoc, parsed.value, null);
    });
    const update = Y.encodeStateAsUpdate(seedDoc);
    seedDoc.destroy();
    if (this.isStamped(state)) return; // filled by the server while preparing
    const moved = state.ydoc.getText('content').toString() !== merged;
    // No origin: local work, pushed — not the derived identity's to own, so a
    // later overwrite of it is not taken for an edit of this vault's lost.
    Y.applyUpdate(state.ydoc, update);
    // Stamped now, so anything later reaches onTransaction; what moved before
    // is kept here, read in the same synchronous step as the stamp.
    if (moved) {
      log.info('An older client changed the text while it was being filled from; keeping the newer text', {
        path: state.localPath,
      });
      this.keepTextVersion(state);
    }
    // The base for this file's next read-in is what the file and the document
    // last agreed on — never the merged text, which this file may never have
    // held. A file behind the merged text, read in against it, reads as the
    // user reverting every change it is behind by, and wins (SAFE-A27's
    // versions do not protect it: the read-in writes them as new edits). So:
    // the file when it is what filled the document, and otherwise nothing
    // until the record below says what it is. With nothing, the first write
    // keeps the file aside (SAFE-A2) and a view waits to bind.
    // Recorded, not only held: the first write after a fill normally records
    // it, but a view that binds the file at once and never saves means no
    // write ever does, and after a restart the file was kept aside as if it
    // might be newer (NEC-241, found in the NEC-211 e2e run).
    if (source === disk) this.agree(state, disk);
    else state.lastSyncedText = null;
    state.baseFromRecord = false;
    log.debug('Filled a structured document from text', {
      path: state.localPath, from: source === merged ? 'merged text' : 'file',
    });
    if (source === merged && disk !== '' && disk !== merged) {
      const agreed = (await state.idbProvider.get(TEXT_AGREED_KEY)) as unknown;
      if (typeof agreed === 'string' && agreed !== disk) {
        const base = this.parseOrNull(state, agreed);
        const edit = state.codec.parse(disk);
        if (base !== null && edit.ok) {
          log.info('A file taken over from text was edited since it last agreed with its text; reading the edit in', {
            path: state.localPath,
          });
          const verified = this.verifyBase(state, edit.value, base, true);
          state.ydoc.transact(() => state.codec.apply(state.ydoc, edit.value, verified), LOCAL_ORIGIN);
          this.agree(state, disk);
        }
      } else if (typeof agreed === 'string') {
        // Only behind: the file is what was agreed, and the document is newer.
        // That agreement is the file's base, and the next write replaces it.
        state.lastSyncedText = agreed;
        state.baseFromRecord = true;
        state.firstWriteChecked = true;
      }
    }
  }

  private announceUnparseable(state: StructuredDocState, error: string): void {
    log.warn('A structured file could not be read; the document is left as it was', {
      path: state.localPath, error,
    });
    if (state.unparseableAnnounced) return;
    state.unparseableAnnounced = true;
    this.deps.notify(
      `Nectenda: "${state.relativePath}" could not be read, so changes to it are not being shared. ` +
      'If another change arrives first, this version is kept in .nectenda-backups.',
    );
  }

  /** Called by VaultWatcher when a structured file changes on disk. */
  async onLocalModify(sharedFolderId: string, relativePath: string): Promise<void> {
    const docName = this.deps.docIndex.refSync(sharedFolderId, relativePath);
    if (!docName) return;
    const state = this.docs.get(docName);
    if (!state) return;
    if (this.checkHandOff(state)) return;

    try {
      const disk = await this.vault.read(state.localPath);
      // Every change said, whatever is made of it: a save taken silently left
      // nothing in the log, so a lost edit could not tell "the save never
      // came" from "it came and was taken for nothing new" (NEC-225).
      log.debug('A structured file changed on disk', {
        path: state.localPath, bytes: disk.length, boundViews: state.boundViews.size,
      });
      // Our own write coming back, or nothing new. Compared by content rather
      // than by a one-shot flag: a flag armed for a write that produced no
      // event swallows the next real edit.
      if (disk === state.lastSyncedText || disk === state.writingText) {
        log.debug('A structured file changed to what was last written or agreed; nothing to read in', {
          path: state.localPath, as: disk === state.writingText ? 'writing' : 'agreed',
        });
        return;
      }

      if (state.boundViews.size > 0) {
        this.readInBoundSave(state, disk);
        return;
      }

      // An empty file is never an edit to a structured document (SAFE-A4). It
      // is what FileSync's placeholder looks like before content arrives, and
      // for these formats it is not a valid file anyway.
      if (disk.trim() === '') {
        log.debug('Ignoring an empty structured file', { path: state.localPath });
        return;
      }

      const parsed = state.codec.parse(disk);
      if (!parsed.ok) {
        // Half-saved, hand-edited into invalid syntax, or not this format at
        // all. The document stays as it was (SAFE-A13); the file is kept aside
        // before anything is written over it.
        this.announceUnparseable(state, parsed.error);
        return;
      }
      state.unparseableAnnounced = false;

      if (!this.isStamped(state)) {
        // Before the server has confirmed the document, the file is the only
        // copy and waits for the first sync to fill it.
        if (!state.hasSyncedOnce || !state.mayFill) return;
        state.ydoc.transact(() => {
          this.stampMeta(state);
          state.codec.apply(state.ydoc, parsed.value, null);
        }, LOCAL_ORIGIN);
        this.agree(state, disk);
        return;
      }

      if (this.readIn(state, disk, parsed.value)) {
        // Said, because a save that was never read in and one read in with
        // nothing to show for it looked the same in the log (NEC-216).
        log.debug('Read a save of a structured file in', { path: state.localPath, bytes: disk.length });
        // The document may now differ from the file — remote changes the file
        // had not received yet survive the diff against the base — so bring
        // the file up to date.
        this.scheduleDiskWrite(state);
        return;
      }

      // No base means disk and document have not been seen to agree since this
      // connect: the file may be stale rather than edited, and diffing it
      // against the document would read every remote change it has not yet
      // received as the user reverting it — then send that reversion to
      // everyone. Nothing is applied. The next write keeps this file in
      // .nectenda-backups before replacing it — a disk that differs from the
      // last agreed text is always kept, and with no agreed text it always
      // differs — which is where an edit made in that window survives.
      log.warn('A structured file changed before it was reconciled with its document; keeping it aside', {
        path: state.localPath,
      });
      this.scheduleDiskWrite(state);
    } catch (err) {
      log.error('Failed to read a structured file for sync', { path: state.localPath, error: String(err) });
    }
  }

  /**
   * Whether two changes to `base` touch different things: applied in either
   * order, through the codec as a read-in would apply them, they read the
   * same. Worked out in scratch documents, so it knows nothing of any codec's
   * keys and changes nothing.
   */
  private commutes(state: StructuredDocState, base: unknown, a: unknown, b: unknown): boolean {
    const run = (first: unknown, second: unknown): unknown => {
      const scratch = new Y.Doc();
      try {
        state.codec.apply(scratch, base, null);
        state.codec.apply(scratch, first, base);
        state.codec.apply(scratch, second, base);
        return state.codec.read(scratch);
      } finally {
        scratch.destroy();
      }
    };
    return state.codec.equal(run(a, b), run(b, a));
  }

  /**
   * Bring an edit made on disk into the document, diffed against its base.
   * False when there is no base to diff against — see onLocalModify.
   *
   * The base is normally the text disk and document last agreed on. When an
   * open view missed our last write (SAFE-A19), its save is built on what it
   * held before, and that is the base: diffed against our write instead, the
   * save would read as the user reverting the remote change it never showed.
   *
   * Synchronous from the caller's read to `lastSyncedText`, so two callers that
   * read the same text cannot both apply it.
   */
  private readIn(state: StructuredDocState, disk: string, saved: unknown): boolean {
    const current = state.codec.read(state.ydoc);
    const value = this.withViewDeletes(state, saved, current);
    // Handled, not read in: the caller's write then puts this file's own
    // content back, after the backup (it waits on `keeping`). Judged with
    // what the view deleted: a drawing cleared and drawn afresh saves only
    // new shapes, and without its deletes it read as another drawing's, so
    // the user's redraw went to the backup (found in review).
    if (this.isForeign(state, value)) {
      this.keepForeign(state, disk);
      return true;
    }
    if (state.codec.equal(value, current)) {
      this.agree(state, disk);
      this.deps.surface?.ingested(state.localPath, disk);
      return true;
    }
    let viewBase = this.deps.surface?.baseFor(state.localPath) ?? null;
    const loaded = viewBase !== null && state.lastSyncedText !== null ? this.loadedBase(state, state.lastSyncedText, viewBase) : null;
    if (loaded !== null) {
      log.info('An open view did load the last write, by what it showed; reading its save in against what of that write it showed', {
        path: state.localPath,
      });
      viewBase = null;
    }
    const baseText = viewBase ?? state.lastSyncedText;
    const parsedBase = loaded ?? (baseText === null ? null : this.parseOrNull(state, baseText));
    if (parsedBase === null) return false;
    const verified = this.verifyBase(state, value, parsedBase, viewBase === null && state.baseFromRecord === true);
    if (viewBase !== null) {
      log.info('Reading in a save from a view that missed the last write, against what it held', {
        path: state.localPath,
      });
    }
    const { base, passedOver, keep } = this.restBase(state, value, verified);
    state.ydoc.transact(() => state.codec.apply(state.ydoc, value, base), LOCAL_ORIGIN);
    if (passedOver.length > 0) this.keepPassedOver(state, disk, passedOver, keep === true);
    this.agree(state, disk);
    this.deps.surface?.ingested(state.localPath, disk);
    return true;
  }

  /**
   * A bound view saved the file. Normally an echo: the binding carried each
   * edit in as it was made, so the save holds nothing the document lacks.
   *
   * But "normally" is a claim about which of Obsidian's internals every edit
   * passes through, and a save that nothing carried in, taken as an echo,
   * would be an edit gone without a trace. So it is checked (SAFE-A19): a save
   * none of the views held is read in, against what the view held when it was
   * made, and logged, because it means a hook missed something.
   */
  private readInBoundSave(state: StructuredDocState, disk: string): void {
    const parsed = disk.trim() === '' ? null : state.codec.parse(disk);
    if (!parsed?.ok) {
      // Not something a canvas view writes. Left alone, and not taken as the
      // agreed text either, so the next write keeps it aside.
      if (parsed) this.announceUnparseable(state, parsed.error);
      return;
    }
    if (this.isForeign(state, this.withViewDeletes(state, parsed.value, state.codec.read(state.ydoc)))) {
      // Another tab, reused for this file, saved what it showed before. The
      // bound view's own next save puts this file's content back.
      this.keepForeign(state, disk);
      return;
    }
    const views = [...state.boundViews];
    if (state.codec.equal(parsed.value, state.codec.read(state.ydoc))) {
      log.debug('A bound view saved what its document holds; taken as agreed', { path: state.localPath });
      this.agree(state, disk);
      return;
    }
    const reader = views.find((v) => v.readInSave);
    if (reader?.readInSave) {
      const read = reader.readInSave(parsed.value);
      if (read && read.passedOver.length > 0) this.keepPassedOver(state, disk, read.passedOver, read.keep === true);
      this.agree(state, disk);
      return;
    }
    if (views.some((v) => v.holds(parsed.value))) {
      log.debug('A bound view saved what one of its views held; taken as agreed', { path: state.localPath });
      this.agree(state, disk);
      return;
    }
    log.warn('An open view saved a change its live binding had not carried; reading it in', {
      path: state.localPath,
    });
    const base = views[0].baseFor(parsed.value);
    state.ydoc.transact(() => state.codec.apply(state.ydoc, parsed.value, base), LOCAL_ORIGIN);
    this.agree(state, disk);
  }

  private isForeign(state: StructuredDocState, value: unknown): boolean {
    try {
      return state.codec.foreign?.(value, state.ydoc) === true;
    } catch (err) {
      log.warn('Could not tell whether a save is another file\'s', { path: state.localPath, error: String(err) });
      return false;
    }
  }

  /**
   * A save that is another file's content under this path: Obsidian reuses a
   * view for another file, and the view takes the new path before it loads
   * the new file, so a save in that moment writes the old file's content
   * here. Read in, it carried one drawing's every shape into another, for
   * every vault (the hardness run, twice). It is not read in, nor taken as
   * agreed; it is kept in .nectenda-backups — it could be someone's work —
   * once per content, with a notice, and the file is written back.
   */
  private keepForeign(state: StructuredDocState, disk: string): void {
    log.warn('A save held another file\'s content, as a tab reused for another file saves before it loads; kept it in .nectenda-backups and did not read it in', {
      path: state.localPath,
    });
    if (state.foreignKept === disk) return;
    state.foreignKept = disk;
    state.keeping = state.keeping.then(async () => {
      await backupLocalFile(this.vault, state.localPath, disk, 'A save held another file\'s content — backed it up and did not sync it');
      this.deps.notify(
        `Nectenda: "${state.relativePath}" was saved holding another file's content, as a tab switched files. ` +
        'That was not synced; the copy is in .nectenda-backups.',
      );
    }).catch((err: unknown) => {
      log.error('Could not keep a save that held another file\'s content', { path: state.localPath, error: String(err) });
    });
  }

  /** The base for a save, without what a closed view of it showed (see the dep). */
  private restBase(state: StructuredDocState, saved: unknown, base: unknown): { base: unknown; passedOver: string[]; keep?: boolean } {
    try {
      return this.deps.restBase?.(state.localPath, saved, base) ?? { base, passedOver: [] };
    } catch (err) {
      log.warn('Could not read what a closed view of a file showed; reading its save in as it is', { path: state.localPath, error: String(err) });
      return { base, passedOver: [] };
    }
  }

  /**
   * A save read in with parts passed over as what a closed view showed
   * (`restBase`). Those parts are taken as no edit, which is right for a
   * closing tab's save and wrong only if someone set a part back to exactly
   * that value. So the save is kept in .nectenda-backups when `keep` says so —
   * once per closed view, never for a save that only lacks links — and once
   * per content: whatever it held is still there to see. No notice: in the
   * ordinary case nothing anyone wrote was lost.
   */
  private keepPassedOver(state: StructuredDocState, disk: string, parts: string[], keep: boolean): void {
    log.info('Passed over parts of a save as what a closed view showed', {
      path: state.localPath, parts: parts.slice(0, 10), count: parts.length, kept: keep,
    });
    if (!keep || state.passedOverKept === disk) return;
    state.passedOverKept = disk;
    state.keeping = state.keeping.then(async () => {
      await backupLocalFile(this.vault, state.localPath, disk, 'A save held what a closed view showed before a remote change — those parts were not read in');
    }).catch((err: unknown) => {
      log.error('Could not keep a save whose parts were passed over', { path: state.localPath, error: String(err) });
    });
  }

  /** A save, with what its open view deleted and the save left out (see the dep). */
  private withViewDeletes(state: StructuredDocState, saved: unknown, current: unknown): unknown {
    try {
      return this.deps.withViewDeletes?.(state.localPath, saved, current, state.hasSyncedOnce) ?? saved;
    } catch (err) {
      log.warn('Could not read what an open view deleted; reading its save in as it is', { path: state.localPath, error: String(err) });
      return saved;
    }
  }

  /** Whether the open views loaded our last write (see the dep). */
  private loadedBase(state: StructuredDocState, writtenText: string, priorText: string): unknown {
    if (!this.deps.loadedBase) return null;
    const written = this.parseOrNull(state, writtenText);
    const prior = this.parseOrNull(state, priorText);
    if (written === null || prior === null) return null;
    try {
      return this.deps.loadedBase(state.localPath, written, prior) ?? null;
    } catch (err) {
      log.warn('Could not tell whether open views loaded the last write; reading the save in against what they held', {
        path: state.localPath, error: String(err),
      });
      return null;
    }
  }

  /**
   * Read in what open views of the file were seen to hold that the document
   * never had (see the dep), against the base the dep gives: the document,
   * with each version a recorded one was not made on marked as not seen, so it
   * stands beside it and settle keeps the loser rather than this removing it.
   */
  private readInRecorded(state: StructuredDocState): boolean {
    if (!this.deps.withRecordedAhead) return false;
    const current = state.codec.read(state.ydoc);
    let got: { value: unknown; base: unknown } | null;
    try {
      got = this.deps.withRecordedAhead(state.localPath, current, state.ydoc) ?? null;
    } catch (err) {
      log.warn('Could not read what open views held that their document never had; writing without it', {
        path: state.localPath, error: String(err),
      });
      return false;
    }
    if (got === null) return false;
    log.info('Reading in what an open view held that the document never had, which no save carried, before writing', { path: state.localPath });
    state.ydoc.transact(() => state.codec.apply(state.ydoc, got.value, got.base), LOCAL_ORIGIN);
    return true;
  }

  /**
   * A view of `localPath` stopped showing it — switched to another file,
   * closed, or rebuilt. If it held something above the document that no save
   * carried, write the file now rather than at the next change: the record
   * is in memory only.
   */
  writeIfViewsAhead(localPath: string): void {
    if (!this.deps.holdsRecordedAhead) return;
    for (const state of this.docs.values()) {
      if (state.localPath !== localPath) continue;
      let ahead = false;
      try {
        ahead = this.deps.holdsRecordedAhead(localPath, state.codec.read(state.ydoc), state.ydoc);
      } catch (err) {
        log.warn('Could not tell whether a view that left a drawing held unsaved work; writing it to be safe', { path: localPath, error: String(err) });
        ahead = true;
      }
      if (ahead) this.scheduleDiskWrite(state);
    }
  }

  /** A read-in's base, without what no open view was seen to show (see the dep). */
  private verifyBase(state: StructuredDocState, saved: unknown, base: unknown, fromRecord: boolean): unknown {
    try {
      return this.deps.verifyBase?.(state.localPath, saved, base, fromRecord) ?? base;
    } catch (err) {
      log.warn('Could not check a read-in\'s base against what open views showed; reading it in against the base as it is', {
        path: state.localPath, error: String(err),
      });
      return base;
    }
  }

  /** What a bound view shows, if one is bound. */
  private shownText(state: StructuredDocState): string | null {
    for (const v of state.boundViews) {
      try {
        const text = v.shownText();
        if (text !== null) return text;
      } catch (err) {
        log.warn('A bound view could not say what it shows', { path: state.localPath, error: String(err) });
      }
    }
    return null;
  }

  private parseOrNull(state: StructuredDocState, text: string): unknown {
    const parsed = state.codec.parse(text);
    return parsed.ok ? parsed.value : null;
  }

  private scheduleDiskWrite(state: StructuredDocState): void {
    if (state.writeTimer) window.clearTimeout(state.writeTimer);
    state.writeTimer = window.setTimeout(() => {
      state.writeTimer = null;
      void this.writeToDisk(state).catch((err: unknown) => {
        log.warn('Deferred structured write failed', { error: String(err) });
      });
    }, WRITE_DEBOUNCE);
  }

  /** Try the write again shortly; false once the retries are spent. */
  private retryWrite(state: StructuredDocState): boolean {
    if (state.writeRetries >= MAX_WRITE_RETRIES) return false;
    state.writeRetries++;
    if (state.writeTimer) window.clearTimeout(state.writeTimer);
    state.writeTimer = window.setTimeout(() => {
      state.writeTimer = null;
      void this.writeToDisk(state);
    }, WRITE_RETRY_DELAY * state.writeRetries);
    return true;
  }

  /**
   * Bring the file up to date with the document.
   *
   * Each refusal below is one of the rules, and each backup is a version that
   * would otherwise have been replaced with no way back.
   */
  private async writeToDisk(state: StructuredDocState): Promise<void> {
    // One write at a time. Each awaits — the view's save, backups, the write
    // itself — and a second one running meanwhile would read the first's
    // bytes before the first records them, and take them for an edit made on
    // disk: a card edit in them would then be merged in twice.
    if (state.writeInFlight) {
      this.scheduleDiskWrite(state);
      return;
    }
    state.writeInFlight = true;
    try {
      await this.writeToDiskOnce(state);
    } finally {
      state.writeInFlight = false;
    }
  }

  private async writeToDiskOnce(state: StructuredDocState): Promise<void> {
    await state.keeping;
    if (this.docs.get(state.docName) !== state) return;

    if (!this.vault.isFile(state.localPath)) {
      // FileSync creates the file from the listing; the content can win that
      // race. Retried rather than dropped, since nothing else would reschedule.
      if (!this.retryWrite(state)) {
        log.warn('Gave up writing a structured file — it never appeared in the vault', {
          path: state.localPath,
        });
      }
      return;
    }
    state.writeRetries = 0;

    if (this.checkHandOff(state)) return; // SAFE-A16

    // Unfilled means nobody has uploaded it — not that it is empty (SAFE-A3).
    if (!this.isStamped(state)) {
      log.debug('Not writing a structured document nobody has filled yet', { path: state.localPath });
      return;
    }

    // A bound view owns the file while it is open; see bindView.
    if (state.boundViews.size > 0) return;

    // Someone is mid-edit in an open view: the change waits in the document,
    // which loses nothing, and is written once the edit ends (SAFE-A26).
    if (this.deps.editInProgress?.(state.localPath)) {
      log.info('Holding a remote change while an edit is in progress in an open view', { path: state.localPath });
      this.scheduleDiskWrite(state);
      return;
    }

    try {
      // An open view may hold an edit it has not saved. Replacing the file
      // under it would discard that edit when it reloads, so it saves first,
      // and the read below takes its save in (SAFE-A19). A view that cannot
      // save is not written under.
      // A view's own record of unsaved work is not to be trusted with that: a
      // drawing whose edit landed while a save was in flight says it has
      // nothing to save, and the write took the edit from under it (NEC-228,
      // hardness seed 212003). So one whose scene is ahead of the document is
      // made to save, whatever it says.
      if (this.deps.saveViewsAhead) {
        try {
          await this.deps.saveViewsAhead(state.localPath, state.codec.read(state.ydoc));
        } catch (err) {
          log.warn('An open view ahead of its document could not save before a structured write; retrying', {
            path: state.localPath, error: String(err),
          });
          this.retryWrite(state);
          return;
        }
        if (this.docs.get(state.docName) !== state || state.boundViews.size > 0) return;
      }
      if (this.deps.surface) {
        try {
          await this.deps.surface.beforeWrite(state.localPath);
        } catch (err) {
          log.warn('An open view could not save before a structured write; retrying', {
            path: state.localPath, error: String(err),
          });
          this.retryWrite(state);
          return;
        }
        if (this.docs.get(state.docName) !== state || state.boundViews.size > 0) return;
      }

      const disk = await this.vault.read(state.localPath);
      const parsed = disk.trim() === '' ? null : state.codec.parse(disk);

      // The first write of a connect, with what disk and document agreed on
      // last session known (SAFE-A30): a file equal to it is only behind, and
      // is written over without a copy; a file that differs is an edit made
      // while this vault was not syncing it, read in against it — merged key
      // by key, so remote changes that arrived meanwhile stay as well. Without
      // the record, SAFE-A2 below keeps the file aside instead.
      const agreed = state.agreedAtConnect ?? null;
      if (!state.firstWriteChecked && state.lastSyncedText === null && agreed !== null && parsed?.ok) {
        state.lastSyncedText = agreed;
        state.baseFromRecord = true;
        const base = disk === agreed ? null : this.parseOrNull(state, agreed);
        let clash = false;
        if (base !== null && !state.codec.equal(state.codec.read(state.ydoc), base)) {
          // Both moved. The record is written after the file, not with it — a
          // quit between the two, or a view's save on close after unload,
          // leaves it behind the file — and a merge against a record that old
          // reads the file's catch-up as edits, reverting what arrived since,
          // on every vault and with no copy anywhere: the work it reverts was
          // delivered, so SAFE-A14 does not keep it. So the file is kept aside
          // first, as a note's is, and merged only where the two changed
          // different things (SAFE-A30).
          await backupLocalFile(
            this.vault, state.localPath, disk,
            'A structured file changed while it was not being synced, and so did its document — backed up the local copy before merging',
          );
          if ((await this.vault.read(state.localPath)) !== disk) {
            state.lastSyncedText = null;
            state.baseFromRecord = false;
            this.scheduleDiskWrite(state);
            return;
          }
          const current = state.codec.read(state.ydoc);
          clash = !this.commutes(state, base, current, this.withViewDeletes(state, parsed.value, current));
        }
        if (disk === agreed) {
          state.firstWriteChecked = true;
        } else if (clash && state.codec.mergeOnClash && base !== null
          && this.readIn(state, disk, state.codec.mergeOnClash(parsed.value, base))) {
          // A clash, in a format with a part that merges safely even so — a
          // drawing's elements, by version, a lost edit kept beside the
          // original. That part is merged; the rest stays as the document has
          // it, and the file as it was is in the backup just taken. Keeping
          // the whole file aside instead left a drawing's offline work in
          // .nectenda-backups when one element of it had also changed
          // elsewhere (found by the hardness run).
          state.firstWriteChecked = true;
          // Unless the read-in kept it aside as another file's content
          // (keepForeign), which says so itself: then nothing was merged.
          if (state.foreignKept !== disk) {
            log.warn('A structured file and its document both changed while it was not synced; merged what merges safely and kept the file in .nectenda-backups', {
              path: state.localPath,
            });
            this.deps.notify(
              `Nectenda: "${state.relativePath}" was changed here while sync was stopped, and also elsewhere. ` +
              'The changes were merged, and this copy as it was is in .nectenda-backups.',
            );
          }
        } else if (clash) {
          // The file and the document changed the same thing, and a record
          // that may lag cannot say which came later. The document stands;
          // the file's version is in the backup just taken, so the file is
          // accounted for and the write below may replace it.
          state.lastSyncedText = disk;
          state.baseFromRecord = false;
          state.firstWriteChecked = true;
          log.warn('A structured file and its document both changed the same thing while it was not synced; kept the file in .nectenda-backups and left the document as it is', {
            path: state.localPath,
          });
          this.deps.notify(
            `Nectenda: "${state.relativePath}" was changed here while sync was stopped, in a part that was also changed elsewhere. ` +
            'This copy was kept in .nectenda-backups.',
          );
        } else if (this.readIn(state, disk, parsed.value)) {
          state.firstWriteChecked = true;
          log.info('A structured file changed while it was not being synced; merged the change in', {
            path: state.localPath,
          });
        } else {
          state.lastSyncedText = null;
          state.baseFromRecord = false;
        }
      }

      // Changed on disk since we last agreed and not read in yet — typically
      // the save just asked for. Read it in now, against its base, rather than
      // keep it aside and write over it: that is what its modify event would
      // do moments later, and the write below then carries both. The first
      // write of a connect is not this case: SAFE-A2 keeps that file aside.
      if (parsed?.ok && state.firstWriteChecked && disk !== state.lastSyncedText) {
        // Read in (and agreed, so disk is the agreed text already), or kept
        // aside as another file's: either way the write below goes ahead.
        this.readIn(state, disk, parsed.value);
      }
      // What a view held that no save carried — its flag cleared by a save in
      // flight, then switched away, closed or rebuilt (NEC-236) — goes in
      // before the file is replaced. Not once the first write of a connect
      // has kept the file aside: then it waits for the next write.
      if (state.firstWriteChecked) this.readInRecorded(state);
      const value = state.codec.read(state.ydoc);

      // Already says the same thing, whatever its bytes (SAFE-A15). Rewriting
      // it would churn the user's formatting and, with a serialiser that is
      // not quite stable, never stop.
      if (parsed?.ok && state.codec.equal(parsed.value, value)) {
        this.agree(state, disk);
        // Disk and document agree: from here a difference is an edit made
        // since, with this as its base — not the unknown file SAFE-A2 is for.
        state.firstWriteChecked = true;
        return;
      }

      if (parsed !== null) {
        // The file has content the write is about to replace. Each branch
        // below keeps it; the re-read after them decides whether to go on.
        const firstWrite = !state.firstWriteChecked;
        state.firstWriteChecked = true;
        if (!parsed.ok) {
          await backupLocalFile(
            this.vault, state.localPath, disk,
            'A structured file could not be read when a change arrived — backed up the local copy',
          );
        } else if (disk === state.foreignKept) {
          // Another file's content, kept already (keepForeign): the write
          // waits on `keeping`, so the copy is in .nectenda-backups by now.
          await state.keeping;
        } else if (firstWrite && disk !== state.lastSyncedText) {
          // SAFE-A2: the first write of a connect meeting a file that differs
          // from the document. Either side may be the newer one — an edit
          // made while Obsidian was closed looks exactly like a file the
          // last session never finished writing — so the file is kept aside.
          await backupLocalFile(this.vault, state.localPath, disk);
        } else if (state.codec.dropsOnRewrite?.(disk)) {
          // The file holds something the document cannot carry — YAML
          // comments, say — and the write would drop it. Kept first: the user
          // wrote it, and nothing else would (SAFE-A13).
          await backupLocalFile(
            this.vault, state.localPath, disk,
            'A structured file held content a remote change cannot keep — backed up the local copy',
          );
        } else if (disk !== state.lastSyncedText) {
          // Changed on disk since we last looked, and not yet read in: the
          // modify event has not arrived, or it did and could not be applied
          // for want of a base. Kept rather than raced. A null baseline counts
          // as different: "never agreed" is not "nothing to keep".
          await backupLocalFile(
            this.vault, state.localPath, disk,
            'A structured file changed on disk as a remote change arrived — backed up the local copy',
          );
        }
        // A backup is an await, and the user can save in it. What was kept is
        // the version read above; a newer one must be read in, not written
        // over, so start again from the top.
        if ((await this.vault.read(state.localPath)) !== disk) {
          this.scheduleDiskWrite(state);
          return;
        }
      }

      // This vault's own keys (SAFE-A21) come back from disk, not from the
      // document: read again, since a backup above may have let a save in.
      const docValue = state.codec.read(state.ydoc);
      let outValue = docValue;
      if (state.codec.withLocal) {
        const now = parsed?.ok ? parsed.value : null;
        outValue = state.codec.withLocal(docValue, now);
      }
      const text = state.codec.serialise(outValue);
      log.debug('Writing a structured document to disk', { path: state.localPath, bytes: text.length });
      state.writingText = text;
      try {
        await this.vault.write(state.localPath, text);
      } finally {
        state.writingText = null;
      }
      this.agree(state, text);
      // Including a write over an empty placeholder, which the branches above
      // never see: the file now says what the document says.
      state.firstWriteChecked = true;
      this.deps.surface?.afterWrite(state.localPath, text, () => this.vault.read(state.localPath));
    } catch (err) {
      log.error('Failed to write a structured document to disk', { path: state.localPath, error: String(err) });
    }
  }

  /**
   * Local content the network may not have seen, or null.
   *
   * Asked before a remote deletion trashes the file (SAFE-A1). Same rules as
   * ContentSync: work this vault contributed counts even once pushed, and a
   * file never confirmed against the document counts as unsynced.
   */
  async unsyncedLocalContent(docName: string): Promise<string | null> {
    const state = this.docs.get(docName);
    if (!state) return null;
    if (!this.vault.isFile(state.localPath)) return null;
    try {
      const disk = await this.vault.read(state.localPath);
      if (disk.trim() === '') return null;
      if (this.provider.contributedUnsyncedWork(docName)) return disk;
      if (state.lastSyncedText === null) return disk;
      return disk === state.lastSyncedText ? null : disk;
    } catch {
      return null;
    }
  }

  /**
   * Hand the live document to something that shows it — a view binding.
   * Null when the file is not connected. Pair with `releaseDoc`.
   */
  acquireDoc(docName: string): { ydoc: Y.Doc; awareness: Awareness | null; codec?: StructuredCodec } | null {
    const state = this.docs.get(docName);
    if (!state) return null;
    state.acquired++;
    // The file's own codec, so a view reads and writes the folder's paths as
    // this vault names them, as the disk path does (SAFE-A33).
    return { ydoc: state.ydoc, awareness: this.provider.getAwareness(docName), codec: state.codec };
  }

  /**
   * Give the document back. A view still bound through it is unbound first.
   * With `ydoc`, only if it is still the document held under that name: one
   * torn down and reconnected since was never acquired from the new state.
   * (Nothing decides on the count today; it is kept honest for whatever will.)
   */
  releaseDoc(docName: string, view?: BoundView, ydoc?: Y.Doc): void {
    if (view) this.unbindView(docName, view);
    const state = this.docs.get(docName);
    if (ydoc && state?.ydoc !== ydoc) return;
    if (state && state.acquired > 0) state.acquired--;
  }

  /** The document a connected structured file is synced through, or null. */
  docNameFor(localPath: string): string | null {
    for (const state of this.docs.values()) if (state.localPath === localPath) return state.docName;
    return null;
  }

  /**
   * Bind a view to the document, as ContentSync's `setEditorBound` does for an
   * editor: from here the view is the only writer of the file (SAFE-A19), and
   * its binding carries edits both ways.
   *
   * `shown` is what the view holds now, and the caller has checked it shows
   * this file — it equals the file on disk, or the document. It may hold more
   * than the document: an edit the view saved whose modify event has not been
   * read yet. That is read in here, against the text disk and document last
   * agreed on, exactly as `readIn` would have moments later. Without that base
   * nothing can tell the view's edits from remote changes it has not shown,
   * so the file stays on the disk path until the disk path has reconciled it.
   *
   * Refused, too, before the document has been filled and confirmed: an
   * unfilled document is not an empty canvas (SAFE-A3), and a binding that
   * drew it would blank the view (Relay 4261d1b9).
   */
  /** Whether a write of this document to its file is scheduled or running. */
  writePending(docName: string): boolean {
    const state = this.docs.get(docName);
    return !!state && (state.writeTimer !== null || state.writeInFlight === true);
  }

  bindView(docName: string, view: BoundView, shown: unknown, ydoc?: Y.Doc): BindResult {
    const state = this.docs.get(docName);
    if (!state) return 'unknown';
    // The caller acquired `ydoc` and has awaited since. Torn down and
    // reconnected meanwhile, the name now holds another document: bound to it,
    // the view became its file's only writer (SAFE-A19) while carrying its
    // edits into the destroyed one, where no other vault would ever see them.
    if (ydoc && state.ydoc !== ydoc) return 'not-ready';
    if (this.checkHandOff(state)) return 'refused';
    if (!this.isStamped(state) || !state.hasSyncedOnce) return 'not-ready';
    if (!state.codec.equal(shown, state.codec.read(state.ydoc))) {
      const base = state.lastSyncedText === null ? null : this.parseOrNull(state, state.lastSyncedText);
      if (base === null) return 'not-ready';
      if (!state.codec.equal(shown, base)) {
        // The view may have missed our last write, as a save can (readIn).
        const verified = this.verifyBase(state, shown, base, state.baseFromRecord === true);
        state.ydoc.transact(() => state.codec.apply(state.ydoc, shown, verified), LOCAL_ORIGIN);
      }
    }
    state.boundViews.add(view);
    if (state.writeTimer) {
      window.clearTimeout(state.writeTimer);
      state.writeTimer = null;
    }
    return 'bound';
  }

  /**
   * The text disk and document last agreed on — for a bound view, the file as
   * its last save left it. The base an outside write to the file was made on.
   */
  agreedText(docName: string): string | null {
    return this.docs.get(docName)?.lastSyncedText ?? null;
  }

  /** The view let go. Once no view is bound, the file is brought up to date. */
  unbindView(docName: string, view: BoundView): void {
    const state = this.docs.get(docName);
    if (!state || !state.boundViews.delete(view)) return;
    if (state.boundViews.size === 0) this.scheduleDiskWrite(state);
  }

  hasDoc(docName: string): boolean {
    return this.docs.has(docName);
  }

  /** Deleted in this vault: ask the server to discard the document too. */
  deleteRemote(sharedFolderId: string, relativePath: string): void {
    const docName = this.deps.docIndex.refSync(sharedFolderId, relativePath);
    if (!docName) return;
    this.provider.deleteDoc(docName);
    this.disconnectDoc(docName);
  }

  disconnectFile(sharedFolderId: string, relativePath: string): void {
    const docName = this.deps.docIndex.refSync(sharedFolderId, relativePath);
    if (!docName) return;
    this.disconnectDoc(docName);
  }

  /**
   * Renamed or moved within the folder. A new path is a new document, as for
   * text, so the new one fills from the file on its first sync.
   */
  moveFile(
    sharedFolderId: string,
    folderLocalPath: string,
    fromPath: string,
    toPath: string,
    format?: string,
    options: ConnectOptions = {},
  ): void {
    this.disconnectFile(sharedFolderId, fromPath);
    this.connectFile(sharedFolderId, folderLocalPath, toPath, format, options);
  }

  /** See ContentSync.abandonUnsubscribed. */
  private abandonUnsubscribed(state: StructuredDocState, folderLocalPath: string): void {
    this.teardown(state);
    this.unplaced.set(state.docName, {
      sharedFolderId: state.sharedFolderId,
      folderLocalPath,
      relativePath: state.relativePath,
      format: state.codec.format,
      fill: state.mayFill,
    });
  }

  /** Retry files whose subscribe found no connection. See ContentSync.retryUnplaced. */
  retryUnplaced(): void {
    if (this.unplaced.size === 0) return;
    const pending = [...this.unplaced.values()];
    this.unplaced.clear();
    for (const f of pending) {
      this.connectFile(f.sharedFolderId, f.folderLocalPath, f.relativePath, f.format, { fill: f.fill });
    }
  }

  private teardown(state: StructuredDocState): void {
    // Views bound to it let go first: a binding left holding the destroyed
    // document stays "bound", and nothing binds the view again. Done before
    // the write timer is cleared below, so the write the last unbind
    // schedules is cleared with it. Whatever a view carries in on letting go
    // goes into this document, which is going; the view keeps it and saves it
    // to disk as before.
    for (const view of [...state.boundViews]) {
      try {
        view.letGo?.();
      } catch (err) {
        log.warn('A bound view failed to let go of a document being torn down', { docName: state.docName, error: String(err) });
      }
    }
    if (state.writeTimer) window.clearTimeout(state.writeTimer);
    state.writeTimer = null;
    if (state.onTransaction) state.ydoc.off('afterTransaction', state.onTransaction);
    void Promise.resolve(state.idbProvider.destroy()).catch((err: unknown) => {
      log.warn('IndexedDB teardown failed', { error: String(err) });
    });
    state.ydoc.destroy();
    this.docs.delete(state.docName);
    this.folderDocs.get(state.sharedFolderId)?.delete(state.docName);
  }

  private disconnectDoc(docName: string): void {
    const state = this.docs.get(docName);
    if (!state) return;
    this.provider.unsubscribe(docName);
    this.teardown(state);
  }

  disconnectFolder(sharedFolderId: string): void {
    const docNames = this.folderDocs.get(sharedFolderId);
    if (docNames) for (const docName of Array.from(docNames)) this.disconnectDoc(docName);
    this.folderDocs.delete(sharedFolderId);
    for (const [docName, u] of this.unplaced) {
      if (u.sharedFolderId === sharedFolderId) this.unplaced.delete(docName);
    }
  }

  disconnectAll(): void {
    for (const folderId of Array.from(this.folderDocs.keys())) this.disconnectFolder(folderId);
    this.unplaced.clear();
  }

  /**
   * Disconnect everything for good: sync is stopping and this instance goes
   * with it. A connect still waiting (`ready`) then stops there, rather than
   * opening a document under an instance nothing will disconnect again.
   */
  stop(): void {
    this.stopped = true;
    this.disconnectAll();
  }
}
