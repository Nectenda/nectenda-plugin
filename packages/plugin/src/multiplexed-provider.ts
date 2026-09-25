import * as Y from 'yjs';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import { MessageType, COMPACT_AFTER_UPDATES, MAX_PUSH_BYTES, WS_CLOSE_DEVICE_LIMIT, WS_CLOSE_ACCOUNT_SUSPENDED, WS_CLOSE_ACCOUNT_MOVING, WS_CLOSE_SIGNED_OUT, WS_CLOSE_UPDATE_PLUGIN } from '@nectenda/shared';
import { PLUGIN_VERSION } from './client-version.js';
import { log } from './logger';
import { sealPresence, openPresence, decodeEntries, encodeEntries, type PresenceEntry } from './presence-seal';

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
 * `device-limit`, `suspended` and `moving` are deliberately separate from
 * `disconnected`. Nothing is wrong with the network or the credentials, so
 * presenting any of them as a connection fault sends the user off debugging
 * the wrong thing. `moving` is the shortest-lived: the organisation is being
 * carried to another server and will resolve there within a minute or two.
 */
export type ProviderStatus = 'connecting' | 'connected' | 'disconnected' | 'restarting' | 'device-limit' | 'suspended' | 'moving' | 'signed-out' | 'update-required' | 'idle';

/**
 * One document's progress to the server, as the provider sees it.
 *
 * `awaitingAck` is the field that matters most: a push handed to the socket is
 * not a push the server recorded. See `MultiplexedProvider.unacked`.
 */
export interface DocSyncState {
  connected: boolean;
  synced: boolean;
  pending: number;
  flushing: boolean;
  hasUnsentWork: boolean;
  reconciling: boolean;
  owesReconcile: boolean;
  awaitingAck: number;
  lastSeq: number;
  snapshotSeq: number;
  decryptGapSeq: number | null;
  /** Bytes of a change held back for being over `MAX_PUSH_BYTES`, or null. */
  oversizedPush: number | null;
}

/**
 * Every event a provider raises, spelled out.
 *
 * This was `on(event: string, ...)` with a runtime `Set` standing in for the
 * vocabulary, which is a discriminated union's job done by a data structure
 * nothing can check. A typo subscribed to something nothing would ever raise:
 * no compile error, no test failure, no log line — the handler simply never
 * ran, and whatever it was there for quietly did not happen.
 *
 * The last two are per-document and so cannot be enumerated, but the template
 * literals still reject a misspelt prefix. `doc-state` is the exception, one
 * event carrying the document name as its argument: it fires on every
 * keystroke, and its listeners want every document rather than one.
 */
export type ProviderEvent =
  | 'status'
  | 'signed-out'
  | 'routes-changed'
  | 'folder-gone'
  | 'decrypt-failed'
  | 'doc-state'
  | `synced:${string}`
  | `subscribed:${string}`;


/** A Yjs update that carries nothing is two bytes. */
const EMPTY_UPDATE_LENGTH = 2;

/** How long to wait after the sequence moves before writing it down. */
const SEQ_SAVE_DEBOUNCE_MS = 3000;

/** First retry of a reconnect delta that could not be sent; doubles from here. */
const DELTA_RETRY_BASE_MS = 2000;
const DELTA_RETRY_MAX_MS = 60_000;

/**
 * How long a note holding an oversized change waits after an edit before it
 * tries again. Each attempt encrypts the whole delta, so not per keystroke.
 */
const OVERSIZE_RETRY_DEBOUNCE_MS = 10_000;

/**
 * Somewhere to remember how far this device has read.
 *
 * An interface rather than the IndexedDB provider itself so the provider stays
 * testable without a browser, and so the storage decision — including the
 * state-vector check that makes it safe — lives in one place next to the
 * reasoning for it. See seq-checkpoint.ts.
 */
export interface SeqStore {
  load(): Promise<number>;
  save(seq: number): Promise<void>;
}

interface DocSubscription {
  ydoc: Y.Doc;
  awareness: awarenessProtocol.Awareness;
  synced: boolean;
  /**
   * Highest sequence applied from the server's log. Replaces the state vector:
   * the server can no longer read payloads, so it cannot work out what we are
   * missing and we have to tell it.
   *
   * Held in memory only. A cold start asks from 0 and receives the snapshot
   * plus its tail, which is what a client with a possibly-stale IndexedDB cache
   * needs anyway. Yjs updates are idempotent, so re-applying costs time, not
   * correctness.
   *
   * Advanced both by updates received from peers and by the server's ack of our
   * own pushes. The ack matters: without it a sole editor never learns any
   * sequence at all, stays at zero, and can never produce a compaction
   * watermark that discards anything.
   */
  lastSeq: number;
  /**
   * Updates seen since the last snapshot *by this instance*.
   *
   * Kept as a fallback for a server too old to report the snapshot sequence.
   * It is not a measure of the log: it resets on every restart, so a document
   * edited a little at a time across many sessions never reaches the threshold
   * however long its log actually grows. `snapshotSeq` is the real measure.
   */
  updatesSinceSnapshot: number;
  /**
   * Persists how far this device has read, if the caller supplied a store.
   *
   * Optional throughout: a subscription without one behaves exactly as every
   * subscription did before, asking from 0 on each launch.
   */
  seqStore: SeqStore | null;
  /** Resolves once any persisted sequence has been restored. */
  seqReady: Promise<void>;
  seqSaveTimer: TimerHandle | null;
  /**
   * Sequence the server's current snapshot covers, 0 if it has none.
   *
   * Reported by the server on catch-up, so `lastSeq - snapshotSeq` is the exact
   * length of the uncompacted tail rather than an approximation of it.
   */
  snapshotSeq: number;
  /**
   * Payloads received during catch-up, merged once it completes to work out
   * what the server is missing from us. See `pushLocalDelta`.
   */
  catchUp: Uint8Array[];
  /**
   * Set when a local update could not be sent because the socket was closed.
   * Drives a full catch-up on reconnect so the delta can be computed against
   * everything the server holds rather than only what it sent this session.
   */
  hasUnsentWork: boolean;
  /**
   * Whether this client has *ever* had work the server had not seen.
   *
   * Sticky, and never cleared. hasUnsentWork answers "is there something to
   * push right now" and is correctly false the moment a push succeeds — but a
   * remote deletion arriving just after that push still discards work this
   * client contributed, into a document no one will read again. Deciding
   * whether to preserve a copy needs the history, not the instant.
   */
  hadUnsyncedWork: boolean;
  /**
   * Local updates not yet handed to the socket.
   *
   * Encryption is async while Yjs's update callback is not, so updates are
   * queued here and drained by a flush that awaits the cipher. Merged on flush
   * rather than on arrival: a lone typist finds one update here and pays no
   * merge, while a backlog behind an in-flight encrypt coalesces into one
   * message.
   */
  pending: Uint8Array[];
  /** Serialises every write for this document: updates, deltas, snapshots, purges. */
  chain: Promise<void>;
  /** True while a flush is queued or running. */
  flushing: boolean;
  /**
   * The catch-up is done and the delta push behind it is queued but has not
   * run yet. Without this, the moment between `synced` and the delta being
   * counted would read as nothing outstanding.
   */
  reconciling: boolean;
  /**
   * The server may lack work this client can no longer point to: a push that
   * went unacknowledged when its socket closed, or a reconnect delta that
   * could not be sent. Makes the next Subscribe ask from 0 and push the delta
   * against everything the server holds.
   *
   * Separate from `hasUnsentWork` because that one describes `pending`, and a
   * flush that drains `pending` rightly clears it. This work is not in
   * `pending` — it is only in the document — so an edit sent before the
   * catch-up finished would clear the reconcile along with it, and the
   * dropped push would never go again. Only `pushLocalDelta` clears this.
   */
  owesReconcile: boolean;
  /**
   * The state vector the last reconcile diffed against: everything the server
   * was known to hold then. It can only have gained since, so a delta against
   * it is a superset of what the server lacks — larger than needed, never
   * short. Null until a reconcile has run on this subscription.
   */
  serverSV: Uint8Array | null;
  /**
   * The sequence the last Subscribe asked from. A catch-up from 0 is a cold
   * start — no trusted read position — and always reconciles: a document
   * restored from IndexedDB can hold work the server never recorded, and after
   * a restart nothing in memory says so. See `completeSync`.
   */
  catchUpFrom: number;
  /** A retry of a delta that could not be sent, waiting on its timer. */
  deltaRetryTimer: TimerHandle | null;
  /**
   * Size of a change this client will not send because it is over
   * `MAX_PUSH_BYTES` (SAFE-A11), or null. The work stays in the document;
   * `owesReconcile` stays set until a delta that fits goes out.
   */
  oversizedPush: number | null;
  /**
   * Bumped each time a change is held back. A delta clears the hold only if
   * none was placed after it was computed: its encrypt runs off the chain, so
   * a flush can hold back a newer, larger change meanwhile — one this delta
   * does not contain.
   */
  oversizeHolds: number;
  /**
   * Serialises decrypt-and-apply in the order the socket delivered.
   *
   * Separate from `chain` because sends and receives do not order against each
   * other, and joining them would make a large snapshot decrypt block an
   * outgoing keystroke.
   */
  recvChain: Promise<void>;
  /**
   * First sequence that could not be decrypted, if any.
   *
   * `lastSeq` must not advance past it: the next Subscribe asks from `lastSeq`,
   * so stepping over a gap means never asking for it again — silent, permanent
   * loss of someone else's work. Compaction is suppressed while this is set,
   * because a snapshot taken with a known hole would make the server delete the
   * very updates that would fill it.
   */
  decryptGapSeq: number | null;
  /**
   * Serialise presence sealing and opening, one chain each way.
   *
   * The cipher is async and the awareness callback is not, so without these a
   * slow seal could let a later state leave first, and a slow open could apply
   * after a removal that arrived behind it. y-protocols' clock check rejects a
   * stale state either way, so this is order kept rather than order repaired.
   * Separate from `chain` and `recvChain` so a large content encrypt or a
   * snapshot decrypt never holds up a caret.
   */
  presenceSendChain: Promise<void>;
  presenceRecvChain: Promise<void>;
  updateHandler: (update: Uint8Array, origin: unknown) => void;
  awarenessHandler: (changes: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => void;
}

/**
 * How payloads are protected on the wire.
 *
 * The provider knows nothing about keys or folders — it asks this to seal and
 * open, and reports `keyId` so a later generation can still read what an older
 * one wrote.
 */
export interface DocCipher {
  /**
   * `aad` is authenticated additional data. Content updates pass none; sealed
   * presence passes its binding (presence-seal.ts), which is also what keeps a
   * presence ciphertext from ever opening as a content update, or the reverse.
   */
  encryptPayload(docName: string, plaintext: Uint8Array, aad?: Uint8Array): Promise<{ payload: Uint8Array; keyId: string }>;
  decryptPayload(docName: string, payload: Uint8Array, keyId: string, aad?: Uint8Array): Promise<Uint8Array>;
}

/**
 * Leaves payloads alone, but still asynchronously.
 *
 * The asynchrony is the point: a synchronous stand-in would hide every
 * ordering bug the real cipher can cause.
 */
export const passthroughCipher: DocCipher = {
  async encryptPayload(_docName, plaintext) {
    return { payload: plaintext, keyId: '' };
  },
  async decryptPayload(_docName, payload) {
    return payload;
  },
};

type EventCallback = (...args: unknown[]) => void;

export class MultiplexedProvider {
  private url: string;
  private token: string;
  private ws: WebSocket | null = null;
  private docs: Map<string, DocSubscription> = new Map();
  private status: ProviderStatus = 'disconnected';
  private reconnectTimer: TimerHandle | null = null;
  private reconnectDelay = 1000;
  private maxReconnectDelay = 30000;
  private shouldConnect = false;
  /**
   * The server said it was going away on purpose (close 1001, sent by a
   * deploy). For a minute after that, retry quickly and quietly: the process
   * is back within seconds, and the doubling backoff would otherwise land the
   * reconnect at its 31-second attempt and show a "lost connection" notice
   * for what is neither lost nor a fault.
   */
  private restartingUntil = 0;
  private restartAttempts = 0;
  static readonly RESTART_WINDOW_MS = 60_000;
  /**
   * Purges that could not be sent because the socket was down.
   *
   * A file deleted offline would otherwise leave its document on the server for
   * ever: the deletion reaches other vaults through the folder listing, so
   * nothing ever asks again, and the purge that would have cleaned it up was
   * dropped on the floor.
   */
  private pendingDeletes: Set<string> = new Set();
  private events: Map<string, Set<EventCallback>> = new Map();

  private cipher: DocCipher;

  /**
   * Bumped whenever the socket closes. A presence open that began on an older
   * connection must not apply after the close retracted every peer: it would
   * put back a caret for someone this client can no longer vouch for, and its
   * clock can be newer than the retraction's, so the clock check does not stop
   * it.
   */
  private connectionEpoch = 0;

  /**
   * Pushes committed to but not yet acknowledged, per document.
   *
   * `hasUnsentWork` goes false the moment a frame is handed to the socket,
   * which says nothing about whether the server recorded it: it drops a push
   * without an Ack when it refuses the folder, the payload is oversized, or
   * the writer fails. Only the Ack says the update is in the log, so only a
   * count of zero lets anything tell the user a document is synchronised
   * (SAFE-E3). The reconnect delta is counted from before its encrypt, so it
   * is never briefly invisible.
   *
   * Keyed by document rather than held on the subscription, because the
   * server acknowledges a document's pushes, not a subscription's: an Ack for
   * a push made just before an unsubscribe arrives after the resubscribe, and
   * on a per-subscription count it would pay off the new one's push early.
   *
   * Cleared on close: no Ack can arrive on a dead socket. See the close
   * handler for what an outstanding count means then.
   */
  private unacked = new Map<string, number>();

  /**
   * Documents that owed the server a reconcile while unsubscribed: a push
   * went unacknowledged and the socket closed after the unsubscribe. Handed
   * to the next subscription, which is where `owesReconcile` lives.
   *
   * In memory only, and a restart loses it. That is safe because the read
   * position is never stored while a push is outstanding (SAFE-A10): the next
   * launch finds no checkpoint that matches its document, asks from 0, and a
   * catch-up from 0 always reconciles.
   */
  private owedReconcile = new Set<string>();

  private countPush(docName: string): void {
    this.unacked.set(docName, (this.unacked.get(docName) ?? 0) + 1);
  }

  /** One Push per Ack (ws-server.ts), so the count cannot run ahead. */
  private settleAck(docName: string): void {
    const left = (this.unacked.get(docName) ?? 0) - 1;
    if (left > 0) {
      this.unacked.set(docName, left);
      return;
    }
    this.unacked.delete(docName);
    // Settled, perhaps for the first time since the read position last moved:
    // a save skipped while this push was outstanding gets its turn now.
    const sub = this.docs.get(docName);
    if (sub?.synced) this.scheduleSeqSave(docName, sub);
  }

  /**
   * Whether this document may hold work the server has not confirmed:
   * queued, being encrypted, unsent, awaiting an Ack, or owed a reconcile.
   * While it does, the read position must not be stored (SAFE-A10).
   *
   * A catch-up still arriving counts too. Content restored from IndexedDB is
   * in none of the queues, and whether the server lacks any of it is decided
   * only once the catch-up ends — so a save armed by the first catch-up frame
   * would record it as accounted for before the reconcile had even begun.
   * `completeSync` arms the save again, in the same block that sets
   * `reconciling`.
   */
  private owesServer(docName: string, sub: DocSubscription): boolean {
    return !sub.synced
      || sub.pending.length > 0
      || sub.flushing
      || sub.hasUnsentWork
      || sub.reconciling
      || sub.owesReconcile
      || (this.unacked.get(docName) ?? 0) > 0;
  }

  constructor(url: string, token: string, cipher: DocCipher = passthroughCipher) {
    this.url = url;
    this.token = token;
    this.cipher = cipher;
  }

  /**
   * A fresh session token, used from the next connect onwards.
   *
   * The live socket is left alone: it was authenticated at its handshake and
   * the server does not re-check it, so a new token is not a reason to drop
   * it. Without this, a refreshed token could only take effect by tearing the
   * socket down — which is exactly what used to happen on every refresh.
   */
  setToken(token: string): void {
    this.token = token;
  }

  connect(): void {
    this.shouldConnect = true;
    this.doConnect();
  }

  disconnect(): void {
    this.shouldConnect = false;
    if (this.reconnectTimer) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.setStatus('disconnected');
  }

  destroy(): void {
    this.disconnect();
    for (const [, sub] of this.docs) {
      sub.ydoc.off('update', sub.updateHandler);
      sub.awareness.off('update', sub.awarenessHandler);
      this.clearDeltaRetry(sub);
      this.clearSeqSave(sub);
    }
    this.docs.clear();
    this.events.clear();
  }

  subscribe(docName: string, ydoc: Y.Doc, seqStore?: SeqStore): awarenessProtocol.Awareness {
    const existing = this.docs.get(docName);
    if (existing) {
      // Silently ignoring the new Y.Doc would leave the caller holding a
      // document that never receives updates, which is very hard to spot.
      if (existing.ydoc !== ydoc) {
        log.warn('Document already subscribed with a different Y.Doc — ignoring the new one', {
          docName,
        });
      }
      return existing.awareness;
    }

    const awareness = new awarenessProtocol.Awareness(ydoc);

    // The Awareness constructor seeds a local state of {}, and its renewal timer
    // rebroadcasts that every ~15s. With background sync subscribing every file
    // in a folder, each one would advertise a nameless participant to every
    // peer — no cursor to draw, but counted as present.
    //
    // Presence belongs to open editors, not to background subscriptions, so
    // start silent. EditorBridge calls setLocalState when it binds.
    awareness.setLocalState(null);

    // When local ydoc changes, send update to server
    const updateHandler = (update: Uint8Array, origin: unknown) => {
      if (origin === 'remote') return; // Don't echo remote updates back
      const sub = this.docs.get(docName)!;

      // Queued synchronously, before any await, so an update cannot be lost
      // between Yjs handing it over and the cipher finishing with it.
      sub.pending.push(update);
      sub.hasUnsentWork = true;
      this.emitDocState(docName);

      if (!this.isConnected()) {
        // Offline edit. Yjs keeps it in the document (and y-indexeddb on disk);
        // reconciling it with the server is deferred to the next reconnect.
        sub.hadUnsyncedWork = true;
        log.debug('Buffered an edit made while offline', { docName });
        return;
      }
      this.scheduleFlush(docName, sub);
      // A change held back for its size may fit now — the note was trimmed or
      // split — so try again once the typing stops (SAFE-A11).
      if (sub.oversizedPush !== null) this.scheduleDeltaRetry(docName, sub, OVERSIZE_RETRY_DEBOUNCE_MS, 0, true);
    };

    // When local awareness changes, seal it and send it to the server.
    //
    // What goes out is captured synchronously, here: the state *and* its clock,
    // read now rather than after the seal. A later change bumps the clock, and
    // sealing the new state under the old clock would bind it to the wrong
    // moment (see presenceAad).
    const awarenessHandler = (
      changes: { added: number[]; updated: number[]; removed: number[] },
      origin: unknown,
    ) => {
      if (origin === 'remote') return;
      if (!this.isConnected()) return;
      const sub = this.docs.get(docName);
      if (!sub) return;

      const captured: Array<{ clientID: number; clock: number; state: unknown }> = [];
      for (const clientID of changes.added.concat(changes.updated).concat(changes.removed)) {
        const meta = awareness.meta.get(clientID);
        if (!meta) continue;
        captured.push({ clientID, clock: meta.clock, state: awareness.getStates().get(clientID) ?? null });
      }
      if (captured.length === 0) return;

      sub.presenceSendChain = sub.presenceSendChain
        .then(async () => {
          const entries: PresenceEntry[] = [];
          for (const { clientID, clock, state } of captured) {
            if (state === null) {
              entries.push({ clientID, clock, json: 'null' });
              continue;
            }
            try {
              entries.push({ clientID, clock, json: await sealPresence(this.cipher, docName, clientID, clock, state) });
            } catch (err) {
              // Never sent plain instead. A folder without a key has no
              // presence, which is visible; a readable state is not.
              log.warn('Could not seal presence; not sent', { docName, error: String(err) });
            }
          }
          // Unsubscribed meanwhile: a frame now would re-register this socket
          // with a document it has just told the server it closed.
          if (entries.length === 0 || this.docs.get(docName) !== sub || !this.isConnected()) return;
          const encoder = encoding.createEncoder();
          encoding.writeVarString(encoder, docName);
          encoding.writeVarUint(encoder, MessageType.Awareness);
          encoding.writeVarUint8Array(encoder, encodeEntries(entries));
          this.ws!.send(encoding.toUint8Array(encoder));
        })
        .catch((err) => log.warn('Presence send failed', { docName, error: String(err) }));
    };

    ydoc.on('update', updateHandler);
    awareness.on('update', awarenessHandler);

    // A second subscription of the same name replaces the first in `docs`,
    // and everything the server sends from then on lands in the newer
    // document while the older one — the one an engine may still be writing
    // from — never hears another update. Nothing here forbids it; it should
    // never happen, so it is worth a line when it does.
    if (this.docs.has(docName)) log.warn('Subscribed to a document that is already subscribed', { docName });

    const sub: DocSubscription = {
      ydoc,
      awareness,
      synced: false,
      lastSeq: 0,
      seqStore: seqStore ?? null,
      seqReady: Promise.resolve(),
      seqSaveTimer: null,
      updatesSinceSnapshot: 0,
      snapshotSeq: 0,
      catchUp: [],
      hasUnsentWork: false,
      hadUnsyncedWork: false,
      pending: [],
      chain: Promise.resolve(),
      flushing: false,
      reconciling: false,
      owesReconcile: false,
      serverSV: null,
      catchUpFrom: 0,
      deltaRetryTimer: null,
      oversizedPush: null,
      oversizeHolds: 0,
      recvChain: Promise.resolve(),
      decryptGapSeq: null,
      presenceSendChain: Promise.resolve(),
      presenceRecvChain: Promise.resolve(),
      updateHandler,
      awarenessHandler,
    };
    this.docs.set(docName, sub);
    if (this.owedReconcile.delete(docName)) {
      sub.owesReconcile = true;
      sub.hadUnsyncedWork = true;
    }

    // Restore before the first Subscribe goes out, so a resumable document does
    // not ask for the whole log anyway. `sendSubscribe` waits on this; it
    // resolves immediately when there is no store.
    if (seqStore) {
      sub.seqReady = seqStore
        .load()
        .then((seq) => {
          // A floor, never a ceiling: `max` means a sequence learned from the
          // server in the meantime always wins over a stale stored one.
          if (seq > 0) sub.lastSeq = Math.max(sub.lastSeq, seq);
        })
        .catch(() => undefined);
    }

    // Announce that the document now has a subscription, and therefore an
    // Awareness instance. EditorBridge needs this: it cannot bind an editor
    // before the subscription exists, and offline there is no `synced` event to
    // fall back on, so without this signal a file opened before IndexedDB
    // finishes loading would never bind at all.
    this.emit(`subscribed:${docName}`);

    // If already connected, initiate sync for this doc
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.sendSubscribe(docName, sub);
    }

    return awareness;
  }

  /**
   * Ask the server to discard a document permanently.
   *
   * Sent only by the client that performed the deletion. Other vaults learn of
   * it through the folder listing and simply stop following the document; if
   * they also asked for a purge it would be redundant rather than wrong, since
   * the operation is idempotent.
   */
  deleteDoc(docName: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.pendingDeletes.add(docName);
      log.debug('Queued document purge until reconnect', { docName });
      return;
    }

    // On the chain with everything else: a purge that overtakes a queued
    // update would be followed by that update, and the server would recreate
    // the document from it moments after being told to discard it.
    const sub = this.docs.get(docName);
    const send = (): void => {
      if (!this.isConnected()) return;
      const encoder = encoding.createEncoder();
      encoding.writeVarString(encoder, docName);
      encoding.writeVarUint(encoder, MessageType.DeleteDoc);
      this.ws!.send(encoding.toUint8Array(encoder));
      log.debug('Asked the server to discard document', { docName });
    };
    if (sub) sub.chain = sub.chain.then(send);
    else send();
  }

  unsubscribe(docName: string): void {
    const sub = this.docs.get(docName);
    if (!sub) return;

    sub.ydoc.off('update', sub.updateHandler);
    sub.awareness.off('update', sub.awarenessHandler);
    sub.awareness.destroy();
    this.clearDeltaRetry(sub);
    this.clearSeqSave(sub);

    // Tell server we're unsubscribing
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      const encoder = encoding.createEncoder();
      encoding.writeVarString(encoder, docName);
      encoding.writeVarUint(encoder, MessageType.Close);
      this.ws.send(encoding.toUint8Array(encoder));
    }

    this.docs.delete(docName);
  }

  getAwareness(docName: string): awarenessProtocol.Awareness | null {
    return this.docs.get(docName)?.awareness ?? null;
  }

  /**
   * Whether this client ever held work the server had not seen for a document.
   *
   * Used when a remote deletion arrives, to decide whether local content is
   * worth preserving. See `hadUnsyncedWork`.
   */
  contributedUnsyncedWork(docName: string): boolean {
    const sub = this.docs.get(docName);
    if (!sub) return false;
    // Queued or mid-encrypt work counts too. A deletion arriving inside that
    // window would otherwise decide nothing was at risk, and the copy that
    // exists to save the user's typing would be skipped.
    return sub.hadUnsyncedWork || sub.pending.length > 0 || sub.flushing;
  }

  /**
   * Whether the socket is currently open.
   *
   * EditorBridge needs this to tell "the document will sync in a moment" from
   * "nothing is coming". The first is worth waiting for; the second is not, and
   * waiting through it is how offline edits were lost.
   */
  /**
   * Ask for the pending updates to be sent, if nothing is already doing it.
   *
   * A flush already in flight will drain whatever was just pushed, so a second
   * one would only duplicate work.
   */
  /**
   * Decrypt and apply one payload, in the order the socket delivered it.
   *
   * The envelope is decoded synchronously by the caller — that is cheap, and
   * its order is the socket's order — and only the decrypt-and-apply is queued.
   *
   * `lastSeq` advances only after a successful apply. Stepping over a payload
   * we could not decrypt would mean never asking for it again, because the next
   * Subscribe asks from `lastSeq`: silent, permanent loss of someone else's
   * work. Later updates are still applied, since Yjs is commutative and more
   * state is strictly better than less.
   */
  private receive(
    docName: string,
    sub: DocSubscription,
    seq: number,
    payload: Uint8Array,
    keyId: string,
    isSnapshot: boolean,
    countsTowardCompaction = false,
  ): void {
    sub.recvChain = sub.recvChain.then(async () => {
      let plaintext: Uint8Array;
      try {
        plaintext = await this.cipher.decryptPayload(docName, payload, keyId);
      } catch (err) {
        if (sub.decryptGapSeq === null) {
          sub.decryptGapSeq = seq;
          log.warn('Could not decrypt an update — it will be requested again', {
            docName,
            seq,
            keyId,
            error: String(err),
          });
          this.emit('decrypt-failed', docName);
          this.emitDocState(docName);
        }
        return;
      }

      Y.applyUpdate(sub.ydoc, plaintext, 'remote');
      if (isSnapshot || !sub.synced) sub.catchUp.push(plaintext);
      if (sub.decryptGapSeq === null) {
        sub.lastSeq = Math.max(sub.lastSeq, seq);
        this.scheduleSeqSave(docName, sub);
      }
      if (isSnapshot) {
        sub.updatesSinceSnapshot = 0;
        sub.snapshotSeq = Math.max(sub.snapshotSeq, seq);
      }
      if (countsTowardCompaction) {
        sub.updatesSinceSnapshot++;
        this.maybeCompact(docName, sub);
      }
    });
  }

  private scheduleFlush(docName: string, sub: DocSubscription): void {
    if (sub.flushing) return;
    sub.flushing = true;
    sub.chain = sub.chain.then(() => this.flushUpdates(docName, sub));
  }

  private async flushUpdates(docName: string, sub: DocSubscription): Promise<void> {
    // Held outside the loop so the catch can put it back. It left `pending`
    // before the encrypt, and an encrypt that throws — a folder whose key is
    // missing — used to take it with it: logged, never sent, and the next
    // successful flush cleared `hasUnsentWork` as though it had been.
    let merged: Uint8Array | null = null;
    try {
      while (sub.pending.length > 0) {
        const batch = sub.pending;
        sub.pending = [];
        // Merging only here is what keeps a lone typist at zero added latency:
        // with one update there is nothing to merge, and a backlog only forms
        // behind an encrypt that is already running.
        merged = batch.length === 1 ? batch[0] : Y.mergeUpdates(batch);

        if (!this.isConnected()) {
          sub.pending.unshift(merged);
          sub.hadUnsyncedWork = true;
          return;
        }

        const { payload, keyId } = await this.cipher.encryptPayload(docName, merged);

        // Checked again: the socket can close while the cipher runs, and a
        // send into a dead socket would drop the update silently.
        if (!this.isConnected()) {
          sub.pending.unshift(merged);
          sub.hadUnsyncedWork = true;
          return;
        }

        if (payload.length > MAX_PUSH_BYTES) {
          // Not put back: it is in the document, and the reconcile this owes
          // sends a delta that contains it. Back in `pending` it would be
          // merged into, and encrypted with, every later keystroke.
          this.holdOversized(docName, sub, payload.length);
          merged = null;
          continue;
        }

        const encoder = encoding.createEncoder();
        encoding.writeVarString(encoder, docName);
        encoding.writeVarUint(encoder, MessageType.Push);
        encoding.writeVarUint8Array(encoder, payload);
        encoding.writeVarString(encoder, keyId);
        this.ws!.send(encoding.toUint8Array(encoder));
        this.countPush(docName);
        merged = null;
      }
      sub.hasUnsentWork = sub.pending.length > 0;
    } catch (err) {
      log.error('Failed to send an update', { docName, error: String(err) });
      if (merged) sub.pending.unshift(merged);
      sub.hasUnsentWork = true;
      sub.hadUnsyncedWork = true;
    } finally {
      sub.flushing = false;
      this.emitDocState(docName);
    }
  }

  isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  isSynced(docName: string): boolean {
    return this.docs.get(docName)?.synced ?? false;
  }

  /**
   * What this connection knows about one document's progress to the server,
   * for the status icons and the inspector. Null when it is not subscribed.
   *
   * A copy, not a view: callers only read it, and nothing they hold on to
   * should be able to move under them.
   */
  docSyncState(docName: string): DocSyncState | null {
    const sub = this.docs.get(docName);
    if (!sub) return null;
    return {
      connected: this.isConnected(),
      synced: sub.synced,
      pending: sub.pending.length,
      flushing: sub.flushing,
      hasUnsentWork: sub.hasUnsentWork,
      reconciling: sub.reconciling,
      owesReconcile: sub.owesReconcile,
      awaitingAck: this.unacked.get(docName) ?? 0,
      lastSeq: sub.lastSeq,
      snapshotSeq: sub.snapshotSeq,
      decryptGapSeq: sub.decryptGapSeq,
      oversizedPush: sub.oversizedPush,
    };
  }

  /**
   * Raised from inside the Yjs update handler, before the flush is scheduled,
   * so a listener that throws must not be able to stop the flush.
   */
  private emitDocState(docName: string): void {
    try {
      this.emit('doc-state', docName);
    } catch (err) {
      log.warn('A doc-state listener threw', { docName, error: String(err) });
    }
  }

  // Event emitter
  on(event: ProviderEvent, cb: EventCallback): void {
    if (!this.events.has(event)) this.events.set(event, new Set());
    this.events.get(event)!.add(cb);
  }

  off(event: ProviderEvent, cb: EventCallback): void {
    this.events.get(event)?.delete(cb);
  }

  private emit(event: ProviderEvent, ...args: unknown[]): void {
    const cbs = this.events.get(event);
    if (cbs) {
      for (const cb of cbs) cb(...args);
    }
  }

  private doConnect(): void {
    if (!this.shouldConnect) return;
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return;

    this.setStatus('connecting');

    // Build WebSocket URL with token
    // A WebSocket handshake takes no custom headers, so the build says who
    // it is on the query string instead. A server that does not read it
    // ignores it, which is what every server older than this does.
    const wsUrl = `${this.url}?token=${encodeURIComponent(this.token)}&v=${encodeURIComponent(PLUGIN_VERSION)}`;

    try {
      this.ws = new WebSocket(wsUrl);
      this.ws.binaryType = 'arraybuffer';

      this.ws.onopen = () => {
        log.info('Connected to server');
        this.reconnectDelay = 1000; // Reset backoff
        this.restartingUntil = 0;
        this.restartAttempts = 0;
        this.setStatus('connected');

        // Flush purges deferred while offline, before re-subscribing — a
        // document deleted offline should not be resurrected by a catch-up.
        const deferred = Array.from(this.pendingDeletes);
        this.pendingDeletes.clear();
        for (const docName of deferred) this.deleteDoc(docName);

        // Re-sync all subscribed docs
        for (const [docName, sub] of this.docs) {
          sub.synced = false;
          this.sendSubscribe(docName, sub);
        }
      };

      this.ws.onmessage = (event: MessageEvent) => {
        const data = new Uint8Array(event.data as ArrayBuffer);
        this.handleMessage(data);
      };

      this.ws.onclose = (event: CloseEvent) => {
        this.ws = null;
        this.connectionEpoch++;
        for (const [docName, sub] of this.docs) {
          sub.synced = false;
          // No Ack can arrive on a dead socket, so whether those pushes landed
          // is unknown — and the server drops some without a word. Unknown is
          // treated as unsent: `owesReconcile` makes the next Subscribe ask
          // from 0 and push the delta against everything the server holds.
          // Without it a document with a read position caught up from there,
          // pushed nothing, and a dropped edit was never sent again.
          if ((this.unacked.get(docName) ?? 0) > 0) {
            sub.owesReconcile = true;
            sub.hadUnsyncedWork = true;
          }
          sub.reconciling = false;
          // The next catch-up recomputes the delta; a retry on this socket
          // would find it gone anyway.
          this.clearDeltaRetry(sub);

          // Forget who else was here, because we can no longer know.
          //
          // Awareness is a claim about the present, and the socket is the only
          // thing that keeps it true. While disconnected no departure can reach
          // us, so every peer entry is a guess that ages into a lie — and the
          // carets stay on screen, named and confident, for anyone who left
          // during the outage. y-websocket's own provider retracts on close for
          // this reason.
          //
          // Only peers. The local state is what this client re-announces on
          // reconnect, via y-protocols' renewal timer, and clearing it would
          // make us vanish from our own document. The peers come back in the
          // QueryAwareness reply once the connection is re-established, which
          // is the same route that populates them on a fresh start.
          //
          // Nothing is sent: `this.ws` is already null above, and the awareness
          // handler returns early without an open socket. The retraction is
          // local, which is the point — the server has its own view and will
          // correct ours when we come back.
          const peers = [...sub.awareness.getStates().keys()].filter(
            (clientId) => clientId !== sub.ydoc.clientID,
          );
          if (peers.length > 0) {
            awarenessProtocol.removeAwarenessStates(sub.awareness, peers, 'connection-lost');
          }
        }
        // Pushes still outstanding for documents nobody holds right now — closed
        // between the push and this close. Remembered, or the resubscribe asks
        // from its checkpoint and never sends them again.
        for (const [docName, n] of this.unacked) {
          if (n > 0 && !this.docs.has(docName)) this.owedReconcile.add(docName);
        }
        this.unacked.clear();
        if (!this.shouldConnect) return;

        if (event.code === WS_CLOSE_SIGNED_OUT) {
          // The server will not take this token again: the session behind it
          // was signed out, or the token predates session ids. Retrying with
          // it is pointless, so stop — and say so, because what happens next
          // (ask the identity service, re-mint or sign out) is a decision
          // this connection cannot make alone. `connect()` re-arms it.
          this.shouldConnect = false;
          this.setStatus('signed-out');
          log.warn('Refused: this session is no longer accepted by the server');
          return;
        }

        if (event.code === WS_CLOSE_DEVICE_LIMIT) {
          // Keep retrying, but slowly. A slot frees when another device goes
          // away, and the user should not have to restart Obsidian to notice —
          // but retrying on the usual 1s backoff would be a tight loop against
          // a server that has already said no.
          this.reconnectDelay = this.maxReconnectDelay;
          this.setStatus('device-limit');
          log.warn('Refused: device limit reached for this account');
          this.scheduleReconnect();
          return;
        }

        if (event.code === WS_CLOSE_ACCOUNT_SUSPENDED || event.code === WS_CLOSE_ACCOUNT_MOVING) {
          // The server said no for a reason that is not the network. Retry
          // slowly so a reinstated or relocated account reconnects on its own,
          // but say what is happening rather than "reconnecting".
          this.reconnectDelay = this.maxReconnectDelay;
          this.setStatus(event.code === WS_CLOSE_ACCOUNT_SUSPENDED ? 'suspended' : 'moving');
          log.warn(event.code === WS_CLOSE_ACCOUNT_SUSPENDED ? 'Refused: account suspended' : 'Refused: account is moving');
          this.scheduleReconnect();
          return;
        }

        if (event.code === WS_CLOSE_UPDATE_PLUGIN) {
          // Too old for this server. Retry slowly rather than not at all: the
          // person may be updating right now, and a plugin that gives up needs
          // Obsidian restarted to notice it has been fixed. Nothing is lost
          // meanwhile — every edit is still written to disk and kept locally,
          // and syncing resumes by itself once the update lands.
          this.reconnectDelay = this.maxReconnectDelay;
          this.setStatus('update-required');
          log.warn('Refused: this plugin is too old for the server', { version: PLUGIN_VERSION });
          this.scheduleReconnect();
          return;
        }

        if (event.code === 1001) {
          // "Going away": the server is restarting, and says so. Open the
          // fast-retry window if it is not open already; a drop inside the
          // window with another code (1006 while the new process is not yet
          // listening) stays in it, because the window decides, not the code.
          if (!this.restartingUntil) this.restartingUntil = Date.now() + MultiplexedProvider.RESTART_WINDOW_MS;
        }
        if (Date.now() < this.restartingUntil) {
          this.setStatus('restarting');
          this.scheduleReconnect();
          return;
        }

        this.setStatus('disconnected');
        this.scheduleReconnect();
      };

      this.ws.onerror = () => {
        // onclose will fire after this
      };
    } catch {
      this.scheduleReconnect();
    }
  }

  private handleMessage(data: Uint8Array): void {
    const decoder = decoding.createDecoder(data);
    const docName = decoding.readVarString(decoder);
    const messageType = decoding.readVarUint(decoder);

    // Named by its folder, not by a document, so it has no subscription to
    // find: read it before the lookup below, which would drop it.
    if (messageType === MessageType.FolderGone) {
      this.emit('folder-gone', docName);
      return;
    }

    const sub = this.docs.get(docName);
    if (!sub && messageType === MessageType.Ack) {
      // An Ack for a push made before an unsubscribe. Nothing to advance, but
      // it still pays off its push, or a later resubscribe inherits a count
      // that no Ack will ever bring back to zero.
      this.settleAck(docName);
      return;
    }
    if (!sub) {
      // Rare, and invisible until now: a frame for a document this client is
      // not subscribed to. Logged so a missing update can be told from one
      // that arrived for a document nobody was holding.
      log.debug('Dropped a frame for a document not subscribed here', { docName, messageType });
      return;
    }

    switch (messageType) {
      case MessageType.Snapshot: {
        const seq = decoding.readVarUint(decoder);
        const payload = decoding.readVarUint8Array(decoder);
        const keyId = decoding.readVarString(decoder);
        this.receive(docName, sub, seq, payload, keyId, true);
        break;
      }

      case MessageType.Updates: {
        const count = decoding.readVarUint(decoder);
        for (let i = 0; i < count; i++) {
          const seq = decoding.readVarUint(decoder);
          const payload = decoding.readVarUint8Array(decoder);
          const keyId = decoding.readVarString(decoder);
          this.receive(docName, sub, seq, payload, keyId, false);
          sub.updatesSinceSnapshot++;
        }
        break;
      }

      case MessageType.Update: {
        const seq = decoding.readVarUint(decoder);
        const payload = decoding.readVarUint8Array(decoder);
        const keyId = decoding.readVarString(decoder);
        this.receive(docName, sub, seq, payload, keyId, false, true);
        sub.updatesSinceSnapshot++;
        this.maybeCompact(docName, sub);
        break;
      }

      case MessageType.Awareness: {
        const update = decoding.readVarUint8Array(decoder);
        this.receivePresence(docName, sub, update);
        break;
      }

      case MessageType.Ack: {
        // The sequence the server assigned to one of our own updates. Our
        // Y.Doc already contains it, so this only advances the catch-up floor
        // and the compaction counter.
        //
        // On the receive chain like everything else, or it could advance
        // lastSeq past updates still waiting to decrypt.
        //
        // And only once this connection's catch-up has arrived. An Ack says
        // which sequence our update got, not that we hold everything below
        // it: that follows only for a socket that was already receiving the
        // document. A push can go out before the Subscribe does — the
        // Subscribe waits for the stored checkpoint to load, the push does
        // not — and the server registers the socket on the push. Every peer
        // update appended before that was never sent to us. Taking the Ack as
        // the floor then made the Subscribe ask from above them, and they
        // were never asked for again: a guest joining a folder never saw a
        // file the owner created a moment earlier (NEC-87). Before `synced`,
        // the SyncStatus that ends the catch-up sets the floor instead.
        const seq = decoding.readVarUint(decoder);
        const ackEpoch = this.connectionEpoch;
        sub.recvChain = sub.recvChain.then(() => {
          if (sub.synced && sub.decryptGapSeq === null) {
            sub.lastSeq = Math.max(sub.lastSeq, seq);
            this.scheduleSeqSave(docName, sub);
          }
          // Counted whether or not the catch-up has arrived: the floor above
          // needs it, but "the server recorded our push" is true either way.
          // Only for the socket it arrived on, though: queued behind a slow
          // decrypt it can run after a close and a reconnect, when the count
          // it would pay off belongs to a push on the new socket.
          if (ackEpoch === this.connectionEpoch) this.settleAck(docName);
          sub.updatesSinceSnapshot++;
          this.maybeCompact(docName, sub);
          this.emitDocState(docName);
        });
        break;
      }

      case MessageType.CompactRequest: {
        // Queued behind the receive chain like everything else, so it cannot
        // run between a catch-up frame being decrypted and applied and thereby
        // snapshot a document that is briefly missing its middle.
        sub.recvChain = sub.recvChain.then(() => {
          this.handleCompactRequest(docName, sub);
        });
        break;
      }

      case MessageType.SyncStatus: {
        const highest = decoding.readVarUint(decoder);
        // Appended after the field an older server sends, so it has to be
        // guarded rather than assumed: reading a varuint that is not there
        // throws, and would take the whole catch-up down with it.
        const snapshotSeq = decoding.hasContent(decoder) ? decoding.readVarUint(decoder) : 0;
        sub.snapshotSeq = Math.max(sub.snapshotSeq, snapshotSeq);
        // Queued behind the catch-up, not run beside it.
        //
        // This fires `synced:`, which starts ContentSync's seedIfEmpty. Run it
        // before the catch-up has finished decrypting and seedIfEmpty sees an
        // empty document, concludes the note is empty, and inserts the disk
        // content — duplicating every note in the folder once the real content
        // lands behind it.
        sub.recvChain = sub.recvChain.then(() => {
          this.completeSync(docName, sub, highest);
        });
        break;
      }

      case MessageType.Close: {
        // Server is closing this doc subscription
        break;
      }
    }
  }

  /**
   * Open a presence frame and apply what opens.
   *
   * Each entry is opened on its own and a refused one is dropped, not the
   * frame: a QueryAwareness reply carries everybody at once, and one peer on a
   * key generation this device lacks should not hide everyone else. What does
   * open is re-encoded under its original client id and clock and applied as
   * y-protocols always applied it, so every rule about staleness and removal
   * still holds.
   */
  private receivePresence(docName: string, sub: DocSubscription, update: Uint8Array): void {
    let entries: PresenceEntry[];
    try {
      entries = decodeEntries(update);
    } catch (err) {
      log.debug('Dropped a malformed presence frame', { docName, error: String(err) });
      return;
    }
    const epoch = this.connectionEpoch;
    sub.presenceRecvChain = sub.presenceRecvChain
      .then(async () => {
        const kept: PresenceEntry[] = [];
        let refused = 0;
        let reason = '';
        for (const entry of entries) {
          try {
            const state = await openPresence(this.cipher, docName, entry.clientID, entry.clock, entry.json);
            kept.push({ ...entry, json: JSON.stringify(state) });
          } catch (err) {
            refused++;
            reason ||= String(err);
          }
        }
        // Logged, because a refused state is a caret that silently fails to
        // draw, and the only way to tell that from a peer who is not there.
        if (refused > 0) log.debug('Refused presence states', { docName, refused, kept: kept.length, reason });
        if (this.docs.get(docName) !== sub || epoch !== this.connectionEpoch || kept.length === 0) return;
        awarenessProtocol.applyAwarenessUpdate(sub.awareness, encodeEntries(kept), 'remote');
      })
      .catch((err) => log.warn('Presence receive failed', { docName, error: String(err) }));
  }

  /**
   * Write the checkpoint, debounced.
   *
   * Not on every update: the sequence moves with every keystroke a peer makes,
   * and each write is an IndexedDB transaction. Being late costs a replay of
   * the tail on the next launch, which is the behaviour this whole mechanism
   * improves on rather than something it can break.
   */
  private scheduleSeqSave(docName: string, sub: DocSubscription): void {
    if (!sub.seqStore || sub.seqSaveTimer) return;
    sub.seqSaveTimer = window.setTimeout(() => {
      sub.seqSaveTimer = null;
      // No longer this provider's document. Once it is gone, nothing here can
      // say what it owes: the close that would have marked an outstanding push
      // as owed finds no subscription to mark.
      if (this.docs.get(docName) !== sub) return;
      // Skipped while a decrypt gap is open: `lastSeq` deliberately stops
      // advancing there, and recording it would freeze this device at the hole
      // for good.
      if (sub.decryptGapSeq !== null) return;
      // Skipped while anything is unconfirmed (SAFE-A10). The checkpoint
      // stores the document's state vector beside the sequence, and that
      // vector would include the unconfirmed edit — so the next launch would
      // find it matching, trust it, resume past the reconcile, and the edit
      // would never be sent again. Not writing leaves the previous checkpoint,
      // whose vector predates the edit and so is refused on load. The save
      // comes round again when the last Ack settles (`settleAck`).
      //
      // Checked in the same synchronous block as the save captures its
      // vector, so nothing can become owed in between.
      if (this.owesServer(docName, sub)) return;
      void sub.seqStore?.save(sub.lastSeq);
    }, SEQ_SAVE_DEBOUNCE_MS);
  }

  private completeSync(docName: string, sub: DocSubscription, highest: number): void {
    {
        if (sub.decryptGapSeq === null) {
          sub.lastSeq = Math.max(sub.lastSeq, highest);
          this.scheduleSeqSave(docName, sub);
        }
        sub.synced = true;
        // Only when we have work the server may not have seen: offline edits,
        // or a cold start whose IndexedDB cache could be ahead of the log.
        // Why a document did or did not reconcile on connect. Under
        // encryption this is the only visibility into that decision: the
        // server's copy cannot be read back to work out what went missing.
        log.debug('Reconciliation decision', {
          docName, hasUnsentWork: sub.hasUnsentWork, owesReconcile: sub.owesReconcile,
          catchUpFrom: sub.catchUpFrom, lastSeq: sub.lastSeq, catchUpFrames: sub.catchUp.length,
        });
        // A catch-up from 0 always reconciles. Testing `lastSeq === 0` here
        // meant "the server's log is empty", not "cold start": the catch-up has
        // already raised `lastSeq` by now, so a restart with no trusted
        // checkpoint — which is exactly when memory has forgotten what went
        // unsent — caught up, pushed nothing and read as synced (NEC-105).
        if (sub.hasUnsentWork || sub.owesReconcile || sub.catchUpFrom === 0) {
          sub.reconciling = true;
          sub.chain = sub.chain.then(() => this.pushLocalDelta(docName, sub));
        } else {
          sub.catchUp = [];
        }
        this.emit(`synced:${docName}`);
        this.emitDocState(docName);

        // Query awareness after sync is complete
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
          const encoder = encoding.createEncoder();
          encoding.writeVarString(encoder, docName);
          encoding.writeVarUint(encoder, MessageType.QueryAwareness);
          this.ws.send(encoding.toUint8Array(encoder));
        }
    }
  }

  private sendSubscribe(docName: string, sub: DocSubscription): void {
    // Deferred behind the checkpoint read, or the first subscribe of a session
    // races it and asks from 0 — which is safe but throws away the entire point
    // of having stored anything.
    void sub.seqReady.then(() => this.doSendSubscribe(docName, sub));
  }

  private doSendSubscribe(docName: string, sub: DocSubscription): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    // With offline work pending we ask for the whole log, not just the tail.
    // pushLocalDelta diffs against what catch-up delivered, so a partial
    // catch-up would make the server look emptier than it is and we would
    // re-upload the entire document.
    const from = sub.hasUnsentWork || sub.owesReconcile ? 0 : sub.lastSeq;
    sub.catchUpFrom = from;

    const encoder = encoding.createEncoder();
    encoding.writeVarString(encoder, docName);
    encoding.writeVarUint(encoder, MessageType.Subscribe);
    encoding.writeVarUint(encoder, from);
    this.ws.send(encoding.toUint8Array(encoder));
  }

  /**
   * After catching up, send the server anything it does not have from us.
   *
   * Edits made while disconnected are otherwise lost. The local update handler
   * drops updates when the socket is closed, and unlike the state-vector
   * exchange this protocol replaced, nothing on reconnect asks the client for
   * its missing work — the server cannot compute what it is missing, because
   * under encryption it cannot read the log it holds.
   *
   * So the client works it out instead: merge everything catch-up delivered,
   * take its state vector, and diff our document against it. That yields
   * exactly the updates the server lacks. A client already in sync produces a
   * 2-byte no-op update, which is skipped, so a reconnect with nothing pending
   * costs one merge and no traffic.
   */
  private pushLocalDelta(docName: string, sub: DocSubscription): void {
    // Settled below in every branch that returns, and by the close handler in
    // the one where the socket has gone.
    sub.reconciling = false;
    if (!this.isConnected()) return;

    const serverStateVector = sub.catchUp.length
      ? Y.encodeStateVectorFromUpdate(Y.mergeUpdates(sub.catchUp))
      : Y.encodeStateVector(new Y.Doc());
    sub.catchUp = [];
    sub.serverSV = serverStateVector;
    this.sendDelta(docName, sub, serverStateVector, 0);
  }

  /**
   * Send the document's delta against `serverSV`, the state the server was
   * last known to hold.
   *
   * Run on `sub.chain`, by the reconcile and by its retries. A retry reuses the
   * same vector rather than catching up again: the server can only have gained
   * since, so the delta is a superset of what it lacks, and it includes every
   * edit made in the meantime.
   */
  private sendDelta(docName: string, sub: DocSubscription, serverSV: Uint8Array, attempt: number): void {
    // Unsubscribed, or the socket went: the reconnect's own catch-up takes it
    // from here, and `owesReconcile` is still set if anything was owed.
    if (!this.isConnected() || this.docs.get(docName) !== sub) return;

    // Anything queued is already in sub.ydoc — it arrived through Yjs's own
    // update callback — so the delta below is a superset of it. Dropping the
    // queue here is discarding duplicates, not work, and doing it inside the
    // chain guarantees no flush is mid-encrypt at this moment.
    sub.pending = [];

    sub.hasUnsentWork = false;
    sub.owesReconcile = false;

    const delta = Y.encodeStateAsUpdate(sub.ydoc, serverSV);
    const holds = sub.oversizeHolds;
    if (delta.length > EMPTY_UPDATE_LENGTH) sub.hadUnsyncedWork = true;
    log.debug('Computed the delta the server is missing', {
      docName, deltaBytes: delta.length, willPush: delta.length > EMPTY_UPDATE_LENGTH, attempt,
    });
    if (delta.length <= EMPTY_UPDATE_LENGTH) {
      // Nothing the server lacks — including whatever was once too large, if
      // the document no longer holds it.
      sub.oversizedPush = null;
      this.emitDocState(docName);
      if (sub.synced) this.scheduleSeqSave(docName, sub);
      return;
    }

    // Counted now, before the encrypt, so there is no moment in which the
    // delta is neither pending nor awaiting its Ack.
    this.countPush(docName);
    this.emitDocState(docName);
    const epoch = this.connectionEpoch;
    const takeBack = (): void => {
      // Its count is taken back on the socket it was made on — it never went,
      // so no Ack will — or the note would read "sending" for as long as that
      // socket lives. `owesReconcile` is what brings it round again, and no
      // flush can clear it.
      if (epoch === this.connectionEpoch) this.settleAck(docName);
      sub.owesReconcile = true;
      sub.hadUnsyncedWork = true;
    };
    void (async () => {
      const { payload, keyId } = await this.cipher.encryptPayload(docName, delta);
      if (!this.isConnected()) {
        takeBack();
        this.emitDocState(docName);
        return;
      }
      if (payload.length > MAX_PUSH_BYTES) {
        // Never sent: the server would drop it without an Ack, or, over the
        // frame limit, close the socket — and the reconcile that close forces
        // would send it again, about once a second (SAFE-A11).
        takeBack();
        this.holdOversized(docName, sub, payload.length);
        return;
      }
      // A different socket from the one this delta was counted on: its close
      // zeroed the count. The delta is still a superset of what that server
      // lacked, so it is sent — but counted again, on this socket, or it would
      // go out invisible and its Ack would pay off somebody else's push.
      if (epoch !== this.connectionEpoch) this.countPush(docName);
      const encoder = encoding.createEncoder();
      encoding.writeVarString(encoder, docName);
      encoding.writeVarUint(encoder, MessageType.Push);
      encoding.writeVarUint8Array(encoder, payload);
      encoding.writeVarString(encoder, keyId);
      this.ws!.send(encoding.toUint8Array(encoder));
      if (sub.oversizeHolds === holds) sub.oversizedPush = null;
      this.emitDocState(docName);
      log.info('Sent offline changes on reconnect', { docName, bytes: delta.length });
    })().catch((err: unknown) => {
      // Logged loudly once: a key still missing on the tenth try is the same
      // fault, and the note already says it is not synced.
      if (attempt === 0) log.error('Could not send the reconnect delta', { docName, error: String(err) });
      else log.debug('Retry of the reconnect delta failed', { docName, attempt, error: String(err) });
      takeBack();
      this.emitDocState(docName);
      // Retried on this socket. Waiting for the next reconnect left a note on
      // "sending" for as long as the connection held, and let later edits
      // reach peers without the ones they build on.
      const delay = Math.min(DELTA_RETRY_BASE_MS * 2 ** attempt, DELTA_RETRY_MAX_MS);
      this.scheduleDeltaRetry(docName, sub, delay, attempt + 1, false);
    });
  }

  /**
   * Hold back a change too large to push (SAFE-A11).
   *
   * The work stays where it is — the document, IndexedDB, the file on disk —
   * and `owesReconcile` keeps the note from reading as synced. Nothing retries
   * on a timer, because the same document gives the same size. It is tried
   * again on the next edit, reconnect or launch, so trimming or splitting the
   * note is all it takes to recover.
   */
  private holdOversized(docName: string, sub: DocSubscription, bytes: number): void {
    sub.oversizedPush = bytes;
    sub.oversizeHolds++;
    sub.owesReconcile = true;
    sub.hadUnsyncedWork = true;
    log.warn('A change is too large to send; kept on this device', {
      docName, bytes, limit: MAX_PUSH_BYTES,
    });
    this.emitDocState(docName);
  }

  /**
   * Queue another `sendDelta` after `delay`. With `restart`, an armed timer is
   * pushed back (a debounce); without it, an armed timer stands.
   */
  private scheduleDeltaRetry(
    docName: string, sub: DocSubscription, delay: number, attempt: number, restart: boolean,
  ): void {
    if (sub.deltaRetryTimer !== null) {
      if (!restart) return;
      window.clearTimeout(sub.deltaRetryTimer);
    }
    const epoch = this.connectionEpoch;
    sub.deltaRetryTimer = window.setTimeout(() => {
      sub.deltaRetryTimer = null;
      // Only on the socket it was armed for, for the subscription it was armed
      // for, and only while something is still owed.
      if (epoch !== this.connectionEpoch || this.docs.get(docName) !== sub || !sub.owesReconcile) return;
      const serverSV = sub.serverSV ?? Y.encodeStateVector(new Y.Doc());
      sub.chain = sub.chain.then(() => this.sendDelta(docName, sub, serverSV, attempt));
    }, delay);
  }

  private clearSeqSave(sub: DocSubscription): void {
    if (sub.seqSaveTimer === null) return;
    window.clearTimeout(sub.seqSaveTimer);
    sub.seqSaveTimer = null;
  }

  private clearDeltaRetry(sub: DocSubscription): void {
    if (sub.deltaRetryTimer === null) return;
    window.clearTimeout(sub.deltaRetryTimer);
    sub.deltaRetryTimer = null;
  }

  /**
   * Upload a compacted snapshot once the log grows past the threshold.
   *
   * Elected by lowest clientID among the peers we can see, so that several
   * clients watching the same document do not all upload one. The server keeps
   * the newest and rejects the rest, so a duplicate is wasteful rather than
   * harmful.
   */
  private maybeCompact(docName: string, sub: DocSubscription): void {
    // Not while catching up. `handleCompactRequest` has always refused in that
    // state — "asked before catch-up finished; the next one will do" — and this
    // path reaches the same `sendSnapshot` without ever having checked. It is
    // called from `receive` for every catch-up frame, so a client replaying a
    // backlog could offer a snapshot of a document it had not finished
    // assembling, and the server would then delete the updates that complete it.
    //
    // This became reachable when the provider started retracting peer awareness
    // on close. The election below reads the awareness map, so a client that has
    // just reconnected sees no peers, elects itself, and compacts mid-replay —
    // where before, the stale entries it had not yet cleared usually elected
    // somebody else. The election was always the wrong place to be deciding
    // this; clearing the map is what made it show.
    if (!sub.synced) return;

    // The real length of the uncompacted tail where the server reports it, and
    // this instance's own tally only as a fallback for an older server.
    const tail = sub.snapshotSeq > 0 ? sub.lastSeq - sub.snapshotSeq : sub.updatesSinceSnapshot;
    if (tail < COMPACT_AFTER_UPDATES) return;

    const peers = Array.from(sub.awareness.getStates().keys());
    const lowest = peers.length ? Math.min(...peers) : sub.ydoc.clientID;
    if (sub.ydoc.clientID !== lowest) return;

    this.sendSnapshot(docName, sub);
  }

  /**
   * Compact because the server asked.
   *
   * This is the path that actually works. The election below it cannot fix the
   * case that matters — a document nobody has open compacts never, because
   * there is no client to elect — and the server is the only party that knows
   * how long the log really is.
   */
  private handleCompactRequest(docName: string, sub: DocSubscription): void {
    if (!sub.synced) return; // asked before catch-up finished; the next one will do
    this.sendSnapshot(docName, sub);
  }

  /**
   * Encrypt the whole document and offer it as a snapshot.
   *
   * Shared by the server-driven path and the local threshold, because the
   * dangerous part is identical in both and must not be written twice.
   */
  private sendSnapshot(docName: string, sub: DocSubscription): void {
    // A snapshot taken with a known hole would make the server delete the very
    // updates that would fill it.
    if (sub.decryptGapSeq !== null) return;
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    sub.updatesSinceSnapshot = 0;

    // Captured together, in one synchronous block, and never re-read after the
    // await below.
    //
    // The server deletes every update at or below the sequence a snapshot
    // claims. If `lastSeq` advanced while the encrypt ran, the snapshot would
    // claim to cover updates it does not contain and the server would delete
    // the difference — the only place in this design where a client can make
    // the server destroy data. Understating the sequence is always safe: the
    // watermark is a floor, and the server keeps the higher of two snapshots.
    const seq = sub.lastSeq;
    const state = Y.encodeStateAsUpdate(sub.ydoc);

    sub.chain = sub.chain.then(async () => {
      const { payload, keyId } = await this.cipher.encryptPayload(docName, state);
      if (!this.isConnected()) return; // dropping a snapshot costs storage, never content
      const encoder = encoding.createEncoder();
      encoding.writeVarString(encoder, docName);
      encoding.writeVarUint(encoder, MessageType.PutSnapshot);
      encoding.writeVarUint(encoder, seq);
      encoding.writeVarUint8Array(encoder, payload);
      encoding.writeVarString(encoder, keyId);
      this.ws!.send(encoding.toUint8Array(encoder));
      // Assume it lands. If the server rejects it as stale the next SyncStatus
      // corrects this downward-safe guess; without it we would ask again on
      // every single update until the next catch-up.
      sub.snapshotSeq = Math.max(sub.snapshotSeq, seq);
      log.debug('Uploaded snapshot', { docName, seq });
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    if (Date.now() < this.restartingUntil) {
      // Inside the restart window: one second, then every two, no doubling.
      const delay = this.restartAttempts++ === 0 ? 1000 : 2000;
      log.info('Reconnecting after a server restart in', { delay: `${delay}ms` });
      this.reconnectTimer = window.setTimeout(() => {
        this.reconnectTimer = null;
        this.doConnect();
      }, delay);
      return;
    }
    if (this.restartingUntil) {
      // The window closed without a connection: this is an outage after all.
      this.restartingUntil = 0;
      this.restartAttempts = 0;
      if (this.status === 'restarting') this.setStatus('disconnected');
    }
    log.info('Reconnecting in', { delay: `${this.reconnectDelay}ms` });
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.doConnect();
    }, this.reconnectDelay);
    // Exponential backoff
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay);
  }

  private setStatus(status: ProviderStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.emit('status', status);
  }
}
