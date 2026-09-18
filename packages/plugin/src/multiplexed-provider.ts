import * as Y from 'yjs';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import { MessageType, COMPACT_AFTER_UPDATES, WS_CLOSE_DEVICE_LIMIT, WS_CLOSE_ACCOUNT_SUSPENDED, WS_CLOSE_ACCOUNT_MOVING, WS_CLOSE_SIGNED_OUT, WS_CLOSE_UPDATE_PLUGIN } from '@nectenda/shared';
import { PLUGIN_VERSION } from './client-version.js';
import { log } from './logger';

/**
 * `device-limit`, `suspended` and `moving` are deliberately separate from
 * `disconnected`. Nothing is wrong with the network or the credentials, so
 * presenting any of them as a connection fault sends the user off debugging
 * the wrong thing. `moving` is the shortest-lived: the organisation is being
 * carried to another server and will resolve there within a minute or two.
 */
export type ProviderStatus = 'connecting' | 'connected' | 'disconnected' | 'restarting' | 'device-limit' | 'suspended' | 'moving' | 'signed-out' | 'update-required' | 'idle';

/** A Yjs update that carries nothing is two bytes. */
const EMPTY_UPDATE_LENGTH = 2;

/** How long to wait after the sequence moves before writing it down. */
const SEQ_SAVE_DEBOUNCE_MS = 3000;

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
  seqSaveTimer: ReturnType<typeof setTimeout> | null;
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
  encryptPayload(docName: string, plaintext: Uint8Array): Promise<{ payload: Uint8Array; keyId: string }>;
  decryptPayload(docName: string, payload: Uint8Array, keyId: string): Promise<Uint8Array>;
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
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
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
      clearTimeout(this.reconnectTimer);
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

      if (!this.isConnected()) {
        // Offline edit. Yjs keeps it in the document (and y-indexeddb on disk);
        // reconciling it with the server is deferred to the next reconnect.
        sub.hadUnsyncedWork = true;
        log.debug('Buffered an edit made while offline', { docName });
        return;
      }
      this.scheduleFlush(docName, sub);
    };

    // When local awareness changes, send to server
    const awarenessHandler = (
      changes: { added: number[]; updated: number[]; removed: number[] },
      origin: unknown,
    ) => {
      if (origin === 'remote') return;
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

      const changedClients = changes.added.concat(changes.updated).concat(changes.removed);
      const encoder = encoding.createEncoder();
      encoding.writeVarString(encoder, docName);
      encoding.writeVarUint(encoder, MessageType.Awareness);
      encoding.writeVarUint8Array(
        encoder,
        awarenessProtocol.encodeAwarenessUpdate(awareness, changedClients),
      );
      this.ws.send(encoding.toUint8Array(encoder));
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
      recvChain: Promise.resolve(),
      decryptGapSeq: null,
      updateHandler,
      awarenessHandler,
    };
    this.docs.set(docName, sub);

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
        }
        return;
      }

      Y.applyUpdate(sub.ydoc, plaintext, 'remote');
      if (isSnapshot || !sub.synced) sub.catchUp.push(plaintext);
      if (sub.decryptGapSeq === null) {
        sub.lastSeq = Math.max(sub.lastSeq, seq);
        this.scheduleSeqSave(sub);
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
    try {
      while (sub.pending.length > 0) {
        const batch = sub.pending;
        sub.pending = [];
        // Merging only here is what keeps a lone typist at zero added latency:
        // with one update there is nothing to merge, and a backlog only forms
        // behind an encrypt that is already running.
        const merged = batch.length === 1 ? batch[0] : Y.mergeUpdates(batch);

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

        const encoder = encoding.createEncoder();
        encoding.writeVarString(encoder, docName);
        encoding.writeVarUint(encoder, MessageType.Push);
        encoding.writeVarUint8Array(encoder, payload);
        encoding.writeVarString(encoder, keyId);
        this.ws!.send(encoding.toUint8Array(encoder));
      }
      sub.hasUnsentWork = sub.pending.length > 0;
    } catch (err) {
      log.error('Failed to send an update', { docName, error: String(err) });
    } finally {
      sub.flushing = false;
    }
  }

  isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  isSynced(docName: string): boolean {
    return this.docs.get(docName)?.synced ?? false;
  }

  // Event emitter
  on(event: string, cb: EventCallback): void {
    if (!this.events.has(event)) this.events.set(event, new Set());
    this.events.get(event)!.add(cb);
  }

  off(event: string, cb: EventCallback): void {
    this.events.get(event)?.delete(cb);
  }

  private emit(event: string, ...args: unknown[]): void {
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
        for (const sub of this.docs.values()) {
          sub.synced = false;

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
    if (!sub) return;

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
        awarenessProtocol.applyAwarenessUpdate(sub.awareness, update, 'remote');
        break;
      }

      case MessageType.Ack: {
        // The sequence the server assigned to one of our own updates. Our
        // Y.Doc already contains it, so this only advances the catch-up floor
        // and the compaction counter.
        //
        // On the receive chain like everything else, or it could advance
        // lastSeq past updates still waiting to decrypt.
        const seq = decoding.readVarUint(decoder);
        sub.recvChain = sub.recvChain.then(() => {
          if (sub.decryptGapSeq === null) {
            sub.lastSeq = Math.max(sub.lastSeq, seq);
            this.scheduleSeqSave(sub);
          }
          sub.updatesSinceSnapshot++;
          this.maybeCompact(docName, sub);
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
   * Write the checkpoint, debounced.
   *
   * Not on every update: the sequence moves with every keystroke a peer makes,
   * and each write is an IndexedDB transaction. Being late costs a replay of
   * the tail on the next launch, which is the behaviour this whole mechanism
   * improves on rather than something it can break.
   */
  private scheduleSeqSave(sub: DocSubscription): void {
    if (!sub.seqStore || sub.seqSaveTimer) return;
    sub.seqSaveTimer = setTimeout(() => {
      sub.seqSaveTimer = null;
      // Skipped while a decrypt gap is open: `lastSeq` deliberately stops
      // advancing there, and recording it would freeze this device at the hole
      // for good.
      if (sub.decryptGapSeq !== null) return;
      void sub.seqStore?.save(sub.lastSeq);
    }, SEQ_SAVE_DEBOUNCE_MS);
  }

  private completeSync(docName: string, sub: DocSubscription, highest: number): void {
    {
        if (sub.decryptGapSeq === null) {
          sub.lastSeq = Math.max(sub.lastSeq, highest);
          this.scheduleSeqSave(sub);
        }
        sub.synced = true;
        // Only when we have work the server may not have seen: offline edits,
        // or a cold start whose IndexedDB cache could be ahead of the log.
        // Why a document did or did not reconcile on connect. Under
        // encryption this is the only visibility into that decision: the
        // server's copy cannot be read back to work out what went missing.
        log.debug('Reconciliation decision', {
          docName, hasUnsentWork: sub.hasUnsentWork, lastSeq: sub.lastSeq,
          catchUpFrames: sub.catchUp.length,
        });
        if (sub.hasUnsentWork || sub.lastSeq === 0) {
          sub.chain = sub.chain.then(() => this.pushLocalDelta(docName, sub));
        } else {
          sub.catchUp = [];
        }
        this.emit(`synced:${docName}`);

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
    const from = sub.hasUnsentWork ? 0 : sub.lastSeq;

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
    if (!this.isConnected()) return;

    // Anything queued is already in sub.ydoc — it arrived through Yjs's own
    // update callback — so the delta below is a superset of it. Dropping the
    // queue here is discarding duplicates, not work, and doing it inside the
    // chain guarantees no flush is mid-encrypt at this moment.
    sub.pending = [];

    const serverStateVector = sub.catchUp.length
      ? Y.encodeStateVectorFromUpdate(Y.mergeUpdates(sub.catchUp))
      : Y.encodeStateVector(new Y.Doc());
    sub.catchUp = [];

    sub.hasUnsentWork = false;

    const delta = Y.encodeStateAsUpdate(sub.ydoc, serverStateVector);
    if (delta.length > EMPTY_UPDATE_LENGTH) sub.hadUnsyncedWork = true;
    log.debug('Computed the delta the server is missing', {
      docName, deltaBytes: delta.length, willPush: delta.length > EMPTY_UPDATE_LENGTH,
    });
    if (delta.length <= EMPTY_UPDATE_LENGTH) return;

    void (async () => {
      const { payload, keyId } = await this.cipher.encryptPayload(docName, delta);
      if (!this.isConnected()) {
        // Put it back: the reconnect will compute it again from a fresh
        // catch-up, but leaving hasUnsentWork set is what makes that happen.
        sub.hasUnsentWork = true;
        sub.hadUnsyncedWork = true;
        return;
      }
      const encoder = encoding.createEncoder();
      encoding.writeVarString(encoder, docName);
      encoding.writeVarUint(encoder, MessageType.Push);
      encoding.writeVarUint8Array(encoder, payload);
      encoding.writeVarString(encoder, keyId);
      this.ws!.send(encoding.toUint8Array(encoder));
      log.info('Sent offline changes on reconnect', { docName, bytes: delta.length });
    })();
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
      this.reconnectTimer = setTimeout(() => {
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
    this.reconnectTimer = setTimeout(() => {
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
