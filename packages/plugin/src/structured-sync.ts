import { IndexeddbPersistence } from 'y-indexeddb';
import * as Y from 'yjs';
import { loadSeqCheckpoint, saveSeqCheckpoint } from './seq-checkpoint';
import { idbStoreName } from './idb-name';
import { backupLocalFile, writeConflictCopy } from './local-backup';
import { codecForFormat, codecForPath, type StructuredCodec } from './structured-formats';
import { CANVAS_PRESENCE_PAD_BYTES, PRESENCE_PAD_BYTES } from './presence-seal';
import type { DocIndex } from './doc-index';
import type { SyncProvider } from './provider-router';
import type { Awareness } from 'y-protocols/awareness';
import type { TimerHandle } from './timers';
import type { VaultAdapter } from './vault-adapter';
import { log } from './logger';

const WRITE_DEBOUNCE = 500;
const WRITE_RETRY_DELAY = 400;
const MAX_WRITE_RETRIES = 5;
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
function madeOnTopOf(doc: Y.Doc, later: Y.Item, earlier: Y.Item): boolean {
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
  /**
   * Per client id of ours, the clock up to which our entries are known to be on
   * the server. See `noteAcknowledged` and `lostUnseen`.
   */
  acknowledged: Map<number, number>;
  /** Refuse to fill the document from disk; see `connectFile`. */
  mayFill: boolean;
  /** A conflict copy being written; disk writes wait for it. */
  keeping: Promise<void>;
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
 * The canvas one is canvas-view-guard.ts; a live binding to the view would be
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
    const idbProvider = new IndexeddbPersistence(idbStoreName(this.deps.vaultKey(), docName), ydoc);
    const state: StructuredDocState = {
      docName,
      sharedFolderId,
      relativePath,
      localPath: `${folderLocalPath}/${relativePath}`,
      ydoc,
      codec,
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
          // A canvas state is larger, and a card caret larger again: sealed in
          // one bucket that holds both, so length does not say who is typing
          // in a card (presence-seal.ts, WIRE-095).
          { presencePadBytes: state.codec.format === 'canvas' ? CANVAS_PRESENCE_PAD_BYTES : PRESENCE_PAD_BYTES },
        );
      } catch (err) {
        log.warn('Could not subscribe this structured file; it is not connected', {
          path: state.localPath, error: String(err),
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
        this.checkHandOff(state);
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
    if (tr.origin === REMOTE_ORIGIN) {
      let lost = 0;
      Y.iterateDeletedStructs(tr, tr.deleteSet, (struct) => {
        if (!(struct instanceof Y.Item)) return;
        if (!state.ourClients.has(struct.id.client)) return;
        if (lostUnseen(state, struct)) lost++;
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
    state.lastSyncedText = disk;
    log.debug('Filled a structured document from its file', { path: state.localPath });
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
      // Our own write coming back, or nothing new. Compared by content rather
      // than by a one-shot flag: a flag armed for a write that produced no
      // event swallows the next real edit.
      if (disk === state.lastSyncedText || disk === state.writingText) return;

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
        state.lastSyncedText = disk;
        return;
      }

      if (this.readIn(state, disk, parsed.value)) {
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
  private readIn(state: StructuredDocState, disk: string, value: unknown): boolean {
    const current = state.codec.read(state.ydoc);
    if (state.codec.equal(value, current)) {
      state.lastSyncedText = disk;
      this.deps.surface?.ingested(state.localPath, disk);
      return true;
    }
    const viewBase = this.deps.surface?.baseFor(state.localPath) ?? null;
    const baseText = viewBase ?? state.lastSyncedText;
    const base = baseText === null ? null : this.parseOrNull(state, baseText);
    if (base === null) return false;
    if (viewBase !== null) {
      log.info('Reading in a save from a view that missed the last write, against what it held', {
        path: state.localPath,
      });
    }
    state.ydoc.transact(() => state.codec.apply(state.ydoc, value, base), LOCAL_ORIGIN);
    state.lastSyncedText = disk;
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
    const views = [...state.boundViews];
    if (views.some((v) => v.holds(parsed.value)) || state.codec.equal(parsed.value, state.codec.read(state.ydoc))) {
      state.lastSyncedText = disk;
      return;
    }
    log.warn('An open view saved a change its live binding had not carried; reading it in', {
      path: state.localPath,
    });
    const base = views[0].baseFor(parsed.value);
    state.ydoc.transact(() => state.codec.apply(state.ydoc, parsed.value, base), LOCAL_ORIGIN);
    state.lastSyncedText = disk;
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

    try {
      // An open view may hold an edit it has not saved. Replacing the file
      // under it would discard that edit when it reloads, so it saves first,
      // and the read below takes its save in (SAFE-A19). A view that cannot
      // save is not written under.
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

      let disk = await this.vault.read(state.localPath);
      let parsed = disk.trim() === '' ? null : state.codec.parse(disk);

      // Changed on disk since we last agreed and not read in yet — typically
      // the save just asked for. Read it in now, against its base, rather than
      // keep it aside and write over it: that is what its modify event would
      // do moments later, and the write below then carries both. The first
      // write of a connect is not this case: SAFE-A2 keeps that file aside.
      if (parsed?.ok && state.firstWriteChecked && disk !== state.lastSyncedText) {
        if (this.readIn(state, disk, parsed.value)) {
          disk = state.lastSyncedText ?? disk;
          parsed = state.codec.parse(disk);
        }
      }
      const value = state.codec.read(state.ydoc);

      // Already says the same thing, whatever its bytes (SAFE-A15). Rewriting
      // it would churn the user's formatting and, with a serialiser that is
      // not quite stable, never stop.
      if (parsed?.ok && state.codec.equal(parsed.value, value)) {
        state.lastSyncedText = disk;
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
        } else if (firstWrite && disk !== state.lastSyncedText) {
          // SAFE-A2: the first write of a connect meeting a file that differs
          // from the document. Either side may be the newer one — an edit
          // made while Obsidian was closed looks exactly like a file the
          // last session never finished writing — so the file is kept aside.
          await backupLocalFile(this.vault, state.localPath, disk);
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

      const text = state.codec.serialise(state.codec.read(state.ydoc));
      log.debug('Writing a structured document to disk', { path: state.localPath, bytes: text.length });
      state.writingText = text;
      try {
        await this.vault.write(state.localPath, text);
      } finally {
        state.writingText = null;
      }
      state.lastSyncedText = text;
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
  acquireDoc(docName: string): { ydoc: Y.Doc; awareness: Awareness | null } | null {
    const state = this.docs.get(docName);
    if (!state) return null;
    state.acquired++;
    return { ydoc: state.ydoc, awareness: this.provider.getAwareness(docName) };
  }

  /** Give the document back. A view still bound through it is unbound first. */
  releaseDoc(docName: string, view?: BoundView): void {
    if (view) this.unbindView(docName, view);
    const state = this.docs.get(docName);
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
  bindView(docName: string, view: BoundView, shown: unknown): BindResult {
    const state = this.docs.get(docName);
    if (!state) return 'unknown';
    if (this.checkHandOff(state)) return 'refused';
    if (!this.isStamped(state) || !state.hasSyncedOnce) return 'not-ready';
    if (!state.codec.equal(shown, state.codec.read(state.ydoc))) {
      const base = state.lastSyncedText === null ? null : this.parseOrNull(state, state.lastSyncedText);
      if (base === null) return 'not-ready';
      if (!state.codec.equal(shown, base)) {
        state.ydoc.transact(() => state.codec.apply(state.ydoc, shown, base), LOCAL_ORIGIN);
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
}
