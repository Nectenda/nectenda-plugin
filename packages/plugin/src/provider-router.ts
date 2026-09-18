import type * as Y from 'yjs';
import type * as awarenessProtocol from 'y-protocols/awareness';
import type { ProviderStatus, SeqStore } from './multiplexed-provider';
import { log } from './logger';

type EventCallback = (...args: unknown[]) => void;

/**
 * Events the router raises itself rather than forwarding from a connection.
 * `status` is the aggregate; `signed-out` names the one connection whose
 * session the server refused, because the aggregate cannot say which.
 */
/**
 * Events the router raises itself rather than forwarding from a provider.
 *
 * `routes-changed` says that the set of placeable documents may have grown: a
 * connection arrived, or the folder table was rewritten. Anything holding a
 * document it could not place should try again.
 */
const ROUTER_EVENTS = new Set(['status', 'signed-out', 'routes-changed']);

/**
 * What the sync engine needs from a provider.
 *
 * `MultiplexedProvider` satisfies this for one server. `ProviderRouter`
 * satisfies it for several, so ContentSync, FileSync and the editor bridge
 * never learn that a vault can be spread across sync servers — a document's
 * name carries its folder id, and the folder decides which server it lives on.
 */
export interface SyncProvider {
  connect(): void;
  disconnect(): void;
  destroy(): void;
  subscribe(docName: string, ydoc: Y.Doc, seqStore?: SeqStore): awarenessProtocol.Awareness;
  unsubscribe(docName: string): void;
  deleteDoc(docName: string): void;
  getAwareness(docName: string): awarenessProtocol.Awareness | null;
  contributedUnsyncedWork(docName: string): boolean;
  isConnected(): boolean;
  isSynced(docName: string): boolean;
  on(event: string, cb: EventCallback): void;
  off(event: string, cb: EventCallback): void;
  /** A fresh token for the next connect. Optional: the router itself has none. */
  setToken?(token: string): void;
}

/** One sync server the vault talks to, with the session it uses there. */
export interface ShardConnection {
  /** The membership this connection serves, or `self-hosted`. */
  id: string;
  /** WebSocket URL. The HTTP API base is derived from it. */
  endpoint: string;
  token: string;
  accountId: string | null;
  provider: SyncProvider;
}

/** The folder id is everything before the first slash of a document name. */
export function folderOfDoc(docName: string): string | null {
  const slash = docName.indexOf('/');
  return slash > 0 ? docName.slice(0, slash) : null;
}

/**
 * Several servers behind one provider.
 *
 * Routing is by folder: `setFolderRoutes` maps a shared folder to the
 * connection whose organisation owns it. A vault with a single connection needs
 * no routes at all — every document goes to it — which is exactly the
 * self-hosted case and why that path changes nothing.
 *
 * Status is aggregated for the status bar: the worst of the connections wins,
 * because "connected" must mean every mapped folder is syncing, not that one
 * of them is. A document-scoped event (`synced:<doc>`) is only ever emitted by
 * the connection that owns the document, so listeners are attached to every
 * connection and the names keep them apart.
 */
export class ProviderRouter implements SyncProvider {
  private connections = new Map<string, ShardConnection>();
  private folderRoutes = new Map<string, string>();
  private listeners = new Map<string, Set<EventCallback>>();
  private statuses = new Map<string, ProviderStatus>();
  private aggregate: ProviderStatus = 'disconnected';
  private statusHandlers = new Map<string, EventCallback>();
  private started = false;

  /** Connections in the order they were added. */
  list(): ShardConnection[] {
    return [...this.connections.values()];
  }

  get(id: string): ShardConnection | undefined {
    return this.connections.get(id);
  }

  /**
   * Add a server. Listeners already registered are attached to it, and if the
   * router has been started the new connection is connected at once — a
   * membership accepted mid-session should start syncing without a restart.
   */
  add(conn: ShardConnection): void {
    if (this.connections.has(conn.id)) throw new Error(`Connection ${conn.id} already exists`);
    this.connections.set(conn.id, conn);
    this.statuses.set(conn.id, 'disconnected');
    for (const [event, cbs] of this.listeners) {
      if (ROUTER_EVENTS.has(event)) continue;
      for (const cb of cbs) conn.provider.on(event, cb);
    }
    const onStatus: EventCallback = (status) => {
      this.statuses.set(conn.id, status as ProviderStatus);
      this.recompute();
      if (status === 'signed-out') for (const cb of this.listeners.get('signed-out') ?? []) cb(conn.id);
    };
    this.statusHandlers.set(conn.id, onStatus);
    conn.provider.on('status', onStatus);
    if (this.started) conn.provider.connect();
    // A folder routed here may have been refused while this was missing. The
    // shard restarting for a deploy is enough to produce that: `refreshSync`
    // rewrites the routes while the socket is still being rebuilt, every
    // subscribe for the folder throws, and nothing looked again.
    this.routesChanged();
  }

  /**
   * A fresh token for one connection, without touching its socket.
   *
   * Tokens rotate on every refresh of the memberships, so this is the common
   * case and the one that must be cheap and silent. The socket keeps the
   * session it was opened with; the new token is what its next reconnect uses.
   */
  updateToken(id: string, token: string): void {
    const conn = this.connections.get(id);
    if (!conn || conn.token === token) return;
    conn.token = token;
    conn.provider.setToken?.(token);
  }

  /** Remove a server, destroying its provider. Routes to it are dropped. */
  remove(id: string): void {
    const conn = this.connections.get(id);
    if (!conn) return;
    // Deregister first. Destroying a live provider makes it report itself
    // disconnected, synchronously, and with this connection still counted
    // the aggregate would flip and announce a lost connection — for a removal
    // that was asked for. A deliberate teardown is not a fault.
    const onStatus = this.statusHandlers.get(id);
    if (onStatus) conn.provider.off('status', onStatus);
    this.statusHandlers.delete(id);
    this.statuses.delete(id);
    this.connections.delete(id);
    conn.provider.destroy();
    for (const [folder, target] of this.folderRoutes) if (target === id) this.folderRoutes.delete(folder);
    this.recompute();
  }

  /** Which connection each shared folder lives on. Unlisted folders fall back to the sole connection. */
  setFolderRoutes(routes: Record<string, string>): void {
    this.folderRoutes = new Map(Object.entries(routes));
    this.routesChanged();
  }

  /** Tell anyone holding an unplaceable document that placing it may now work. */
  private routesChanged(): void {
    for (const cb of this.listeners.get('routes-changed') ?? []) cb(undefined);
  }

  /** The connection a document belongs to, or null when it cannot be placed. */
  route(docName: string): ShardConnection | null {
    const folder = folderOfDoc(docName);
    const target = folder ? this.folderRoutes.get(folder) : undefined;
    if (target) {
      const conn = this.connections.get(target);
      if (conn) return conn;
      log.warn('Document routed to a connection that no longer exists', { docName, target });
      return null;
    }
    // No route: the vault talks to one server, so that is where it goes. With
    // several servers an unrouted folder is a bug, not a guess to make.
    if (this.connections.size === 1) return this.connections.values().next().value ?? null;
    if (this.connections.size > 1) log.warn('Document has no route and several connections exist', { docName });
    return null;
  }

  /** The connection for a folder, for HTTP calls that need its endpoint and token. */
  forFolder(folderId: string): ShardConnection | null {
    return this.route(`${folderId}/x`);
  }

  private recompute(): void {
    const all = [...this.statuses.values()];
    let next: ProviderStatus;
    // Worst first. A fault the user can act on (suspended, device limit) is
    // reported ahead of one they cannot (a plain disconnect), and a move —
    // which resolves on its own — ahead of "connecting", which says nothing.
    // No connections is not a fault: a signed-in vault whose device is on no
    // organisation's roster yet has nothing to connect, and "Disconnected"
    // would send the person looking for a network problem.
    if (all.length === 0) next = 'idle';
    // A refused session first: it retries nothing on its own, so it is the one
    // state here that stays wrong until somebody acts on it.
    else if (all.includes('signed-out')) next = 'signed-out';
    else if (all.includes('suspended')) next = 'suspended';
    else if (all.includes('device-limit')) next = 'device-limit';
    else if (all.includes('disconnected')) next = 'disconnected';
    else if (all.includes('moving')) next = 'moving';
    else if (all.includes('restarting')) next = 'restarting';
    else if (all.includes('connecting')) next = 'connecting';
    else next = 'connected';
    if (next === this.aggregate) return;
    this.aggregate = next;
    for (const cb of this.listeners.get('status') ?? []) cb(next);
  }

  connect(): void {
    this.started = true;
    for (const c of this.connections.values()) c.provider.connect();
  }

  disconnect(): void {
    this.started = false;
    for (const c of this.connections.values()) c.provider.disconnect();
  }

  destroy(): void {
    this.started = false;
    for (const c of this.connections.values()) c.provider.destroy();
    this.connections.clear();
    this.statuses.clear();
    this.statusHandlers.clear();
    this.listeners.clear();
    this.aggregate = 'disconnected';
  }

  subscribe(docName: string, ydoc: Y.Doc, seqStore?: SeqStore): awarenessProtocol.Awareness {
    const conn = this.route(docName);
    if (!conn) throw new Error(`No sync server for ${docName}`);
    return conn.provider.subscribe(docName, ydoc, seqStore);
  }

  unsubscribe(docName: string): void {
    // Every connection, not the routed one: a route may have changed since the
    // subscription was made, and an unsubscribe that misses leaves a document
    // following a server the vault no longer maps.
    for (const c of this.connections.values()) c.provider.unsubscribe(docName);
  }

  deleteDoc(docName: string): void {
    this.route(docName)?.provider.deleteDoc(docName);
  }

  getAwareness(docName: string): awarenessProtocol.Awareness | null {
    return this.route(docName)?.provider.getAwareness(docName) ?? null;
  }

  contributedUnsyncedWork(docName: string): boolean {
    return this.route(docName)?.provider.contributedUnsyncedWork(docName) ?? false;
  }

  /** True only when every connection is up. */
  isConnected(): boolean {
    return this.connections.size > 0 && [...this.connections.values()].every((c) => c.provider.isConnected());
  }

  isSynced(docName: string): boolean {
    return this.route(docName)?.provider.isSynced(docName) ?? false;
  }

  on(event: string, cb: EventCallback): void {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(cb);
    if (ROUTER_EVENTS.has(event)) return;
    for (const c of this.connections.values()) c.provider.on(event, cb);
  }

  off(event: string, cb: EventCallback): void {
    this.listeners.get(event)?.delete(cb);
    if (ROUTER_EVENTS.has(event)) return;
    for (const c of this.connections.values()) c.provider.off(event, cb);
  }

  /** For the status bar and tests. */
  status(): ProviderStatus {
    return this.aggregate;
  }
}
