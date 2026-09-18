import type { Membership, PendingInvite, SignInResult } from './auth-flow';
import { ShardClient, IdentityError, type DeviceFields, type ShardSession } from './identity-client';
import { log } from './logger';
import { serverFetch } from './client-version.js';

/**
 * What the plugin keeps about a Nectenda Cloud sign-in, and how it turns an
 * identity into sessions on the sync servers.
 *
 * Nothing here is a secret the identity service does not already hold, except
 * the tokens, which the caller keeps in the secret store. The passphrase and
 * anything derived from it never pass through this module.
 */

/** The signed-in person. Tokens are held separately, in the secret store. */
export interface StoredIdentity {
  userId: string;
  email: string;
  displayName: string;
  /** Where this identity was issued; a self-hoster never has one. */
  identityUrl: string;
}

/**
 * One seat, with the session this device holds on its sync server.
 *
 * `id` is `shardId:accountId`, which is what a folder mapping records: the
 * pair names the organisation and where it lives, and survives the local user
 * row changing during a move.
 */
export interface StoredMembership {
  id: string;
  accountId: string;
  accountName: string;
  accountStatus: Membership['accountStatus'];
  role: Membership['role'];
  shardId: string;
  endpoint: string;
  region: string;
  /** This person's user id on that server; presence and rosters use it. */
  localUserId: string | null;
  /** The shard's own session token. Kept in the secret store, hydrated here. */
  token: string;
  /**
   * Whether this device is on the organisation's roster, and how full it is.
   * Absent until a server that keeps rosters has answered. Not enrolled means
   * the seat is real but this device is not syncing it: no socket is opened
   * until someone frees a slot and adds it.
   */
  device?: { enrolled: boolean; used: number; max: number; reason?: string };
}

/** The roster report as stored: the reason only when there is one, so the shape compares cleanly. */
export function deviceOf(report: NonNullable<ShardSession['device']>): NonNullable<StoredMembership['device']> {
  return { enrolled: report.enrolled, used: report.used, max: report.max, ...(report.reason ? { reason: report.reason } : {}) };
}

/**
 * Does this membership open a socket? A seat the organisation has refused
 * this device for takes no slot and no socket: the folder stays mapped and
 * the notes stay local until someone frees a slot and adds the device. A
 * membership with no report yet is from before rosters, or from a server
 * that keeps none, and connects as it always did.
 */
export function syncsHere(m: Pick<StoredMembership, 'accountStatus' | 'token' | 'device'>): boolean {
  return m.accountStatus !== 'moved' && !!m.token && m.device?.enrolled !== false;
}

export function membershipId(shardId: string, accountId: string): string {
  return `${shardId}:${accountId}`;
}

/**
 * Exchange an identity token for a session on every sync server the person
 * belongs to.
 *
 * One request per server, not per membership: a server answers with a session
 * for each organisation the identity holds there. A server that cannot be
 * reached keeps the token it had, if any, so an outage on one shard does not
 * sign the person out of the others — the whole point of direct connections.
 */
export async function establishMemberships(
  identityToken: string,
  memberships: Membership[],
  previous: StoredMembership[],
  device: DeviceFields,
  // Wrapped, not passed bare: see `globalFetch` in identity-client.ts.
  fetchFn: typeof fetch = (input, init) => serverFetch(input, init),
  opts: { enrol?: boolean } = {},
): Promise<{ memberships: StoredMembership[]; unreachable: string[] }> {
  const byEndpoint = new Map<string, Membership[]>();
  for (const m of memberships) {
    if (m.accountStatus === 'moved') continue;
    if (!byEndpoint.has(m.endpoint)) byEndpoint.set(m.endpoint, []);
    byEndpoint.get(m.endpoint)!.push(m);
  }
  const out: StoredMembership[] = [];
  const unreachable: string[] = [];
  for (const [endpoint, members] of byEndpoint) {
    let sessions: ShardSession[] = [];
    let reached = true;
    try {
      sessions = await new ShardClient(endpoint, fetchFn).session(identityToken, device, opts);
    } catch (err) {
      // NOT_A_MEMBER is a real answer, not an outage: the mirror knows about
      // a seat the server has since removed. Anything else is unreachable.
      if (err instanceof IdentityError && err.code === 'NOT_A_MEMBER') sessions = [];
      else {
        reached = false;
        unreachable.push(endpoint);
        log.warn('Could not reach a sync server for a session', { endpoint, error: String(err) });
      }
    }
    for (const m of members) {
      const id = membershipId(m.shardId, m.accountId);
      const session = sessions.find((s) => s.accountId === m.accountId);
      const old = previous.find((p) => p.id === id);
      if (session) {
        out.push({
          id, accountId: m.accountId, accountName: m.accountName, accountStatus: session.accountStatus ?? m.accountStatus, role: session.accountRole ?? m.role,
          shardId: m.shardId, endpoint, region: m.region, localUserId: session.user.id, token: session.token,
          // Kept either way: "reached, and this device is not on the roster"
          // is a membership with a fact attached, not a seat that is gone.
          ...(session.device ? { device: deviceOf(session.device) } : {}),
        });
      } else if (!reached && old) {
        // Keep syncing on the token we have; it is what the server issued and
        // it is still valid until it says otherwise.
        out.push({ ...old, accountName: m.accountName, accountStatus: m.accountStatus, role: m.role });
      }
      // Reached and no session: the seat is gone here. Dropped, and the
      // folder mappings that pointed at it are left for the UI to explain.
    }
  }
  return { memberships: out, unreachable };
}

/** The membership list a sign-in result or `/api/me` carries, as the plugin stores it. */
export function invitesFrom(result: Pick<SignInResult, 'invites'>): PendingInvite[] {
  return Array.isArray(result.invites) ? result.invites : [];
}
