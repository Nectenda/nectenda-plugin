import { apiBaseUrl } from '@nectenda/shared';
import { validateSignInResult, type SignInResult, type Membership, type PendingInvite } from './auth-flow';
import { serverFetch, requestId } from './client-version.js';

/**
 * The identity service and the hosted half of a sync server, as the plugin
 * calls them. Thin by design: every method is one request, the shapes are the
 * ones the services publish, and errors carry the service's own code so the UI
 * can say something specific rather than "request failed".
 */
export class IdentityError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    /** The server's id for the request that failed, when it gave one. */
    readonly requestId?: string,
  ) {
    super(message);
  }
}

async function readJson<T>(res: Response, fallback: string): Promise<T> {
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (!res.ok) {
    const b = (body ?? {}) as { error?: string; code?: string; requestId?: string };
    // The id comes back in the body and in `X-Request-Id`; either will do, and
    // a proxy that strips unknown headers leaves the body.
    const rid = b.requestId ?? requestId(res) ?? undefined;
    const message = b.error ?? fallback;
    // Only a server fault earns a reference in the text a person reads. "Too
    // many attempts" needs no case number; "Internal server error" is useless
    // without one, because it is the only thing that joins their mail to the
    // stack that caused it.
    const shown = res.status >= 500 && rid ? `${message} (reference ${rid})` : message;
    throw new IdentityError(shown, res.status, b.code, rid);
  }
  return body as T;
}

export interface DeviceFields {
  deviceId?: string;
  deviceLabel?: string;
  devicePlatform?: string;
  /** The vault asking, listed under the device on a sync server's roster. */
  installId?: string;
  installLabel?: string;
}

/** Where a device stands on an organisation's roster, as the sync server reports it with each session. */
export interface DeviceReport {
  enrolled: boolean;
  /** Why not, when not: the roster is full, the device sent no id, or a refresh found it absent. */
  reason?: 'DEVICE_LIMIT' | 'DEVICE_ID_REQUIRED' | 'NOT_ENROLLED';
  used: number;
  max: number;
}

/** One organisation's subscription, as the billing summary reports it. */
/** One buyable plan, as the identity service reports it. */
export interface PlanOffer {
  planId: string;
  term: 'month' | 'year';
  /** Minor units — cents for USD. Formatted at the point of display, never stored. */
  amount: number;
  currency: string;
  /** True when seats are bought and become the cap; false when the plan is one flat subscription. */
  perSeat: boolean;
  maxSeats: number;
}

export interface BillingOrganisation {
  accountId: string;
  name: string;
  role: string;
  planId: string;
  seats: number | null;
  term: 'month' | 'year' | null;
  renewsAt: number | null;
  /** Set while a payment has failed and the window is still open. */
  graceUntil: number | null;
  /** Set when a cancellation is scheduled: when the plan actually ends. */
  endingAt: number | null;
  /** Only the owner of a paying organisation is offered the portal. */
  canManage: boolean;
}

export interface MeResponse {
  user: { id: string; email: string; displayName: string; emailVerifiedAt: number | null; createdAt: number };
  memberships: Membership[];
  invites: PendingInvite[];
  passkeys: Array<{ credentialId: string; label: string | null; createdAt: number; lastUsedAt: number | null }>;
  sessions: Array<{ id: string; deviceId: string | null; label: string | null; sealedLabel?: string | null; platform: string | null; createdAt: number; lastUsedAt: number; revokedAt: number | null }>;
  keyMaterial: SignInResult['keyMaterial'];
  providers: string[];
  /** A fresh identity token, minted with the answer so a shard exchange can follow at once. */
  identityToken: string;
  /**
   * Where this server wants crash reports sent, if anywhere.
   *
   * Optional, and null on a self-hosted deployment. The plugin has no
   * built-in endpoint, so a server that names none gets no reports — that is
   * the mechanism, not a policy.
   */
  errorReporting?: { dsn: string | null };
}

export interface KeyEnrolment {
  kdfParams: { algorithm: string; iterations: number; salt: string };
  publicKey: string;
  wrappedPrivateKey: string;
  recoveryBlob: string;
  recoveryParams: { algorithm: string; iterations: number; salt: string };
  recoveryAuthHash: string;
}

/**
 * `fetch` stored on an object and called as a method gets that object as
 * `this`, and the browser refuses it with "Illegal invocation". Node's fetch
 * does not, so unit tests with the default never see it; the e2e run in real
 * Obsidian did. The wrapper keeps `this` the global.
 */
const globalFetch: typeof fetch = (input, init) => serverFetch(input, init);

export class IdentityClient {
  constructor(
    readonly baseUrl: string,
    private readonly fetchFn: typeof fetch = globalFetch,
  ) {}

  private async json<T>(path: string, init: { method?: string; body?: unknown; token?: string } = {}, fallback = 'Request failed'): Promise<T> {
    const res = await this.fetchFn(`${this.baseUrl}${path}`, {
      method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
      headers: {
        ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(init.token ? { Authorization: `Bearer ${init.token}` } : {}),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    return readJson<T>(res, fallback);
  }

  /** Which provider buttons the service offers; what the sign-in tab draws. */
  async providers(): Promise<string[]> {
    const out = await this.json<{ providers?: unknown }>('/auth/providers', {}, 'Could not read the sign-in options');
    return Array.isArray(out.providers) ? out.providers.filter((p): p is string => typeof p === 'string') : [];
  }

  /** Begin a browser sign-in. The plugin opens `url`; the poll collects the result. */
  startFlow(input: { codeChallenge: string; email?: string } & DeviceFields): Promise<{ nonce: string; url: string; expiresAt: number }> {
    return this.json('/auth/flow', { body: input }, 'Could not start the sign-in');
  }

  /** Email a six-digit code. With a nonce it also attaches the address to a browser flow. */
  sendCode(email: string, nonce?: string): Promise<{ sent: true; expiresInSeconds: number }> {
    return this.json('/auth/email/send', { body: { email, nonce } }, 'The code could not be sent');
  }

  /** The code typed into the plugin itself: a complete sign-in with no browser. */
  async verifyCode(email: string, code: string, device: DeviceFields): Promise<SignInResult & { created: boolean }> {
    const out = await this.json<Record<string, unknown>>('/auth/email/verify', { body: { email, code, ...device } }, 'That code was not accepted');
    return { ...validateSignInResult(out), created: out.created === true };
  }

  /** Rotate the device session. The old refresh token is dead after this. */
  async refresh(refreshToken: string, device: DeviceFields): Promise<SignInResult> {
    const out = await this.json<unknown>('/auth/refresh', { body: { refreshToken, ...device } }, 'The session could not be refreshed');
    return validateSignInResult(out);
  }

  me(accessToken: string): Promise<MeResponse> {
    return this.json('/api/me', { token: accessToken }, 'Could not load your account');
  }

  setDisplayName(accessToken: string, displayName: string): Promise<{ displayName: string }> {
    return this.json('/api/me', { method: 'PATCH', body: { displayName }, token: accessToken }, 'Could not change the display name');
  }

  enrolKeys(accessToken: string, keys: KeyEnrolment): Promise<{ ok: true }> {
    return this.json('/api/me/keys', { method: 'POST', body: keys, token: accessToken }, 'Could not enrol encryption keys');
  }

  replaceKeys(accessToken: string, keys: Omit<KeyEnrolment, 'publicKey'>): Promise<{ ok: true }> {
    return this.json('/api/me/keys', { method: 'PUT', body: keys, token: accessToken }, 'Could not replace encryption keys');
  }

  /** A signed invitation for the shard, plus where to present it. */
  acceptInvite(accessToken: string, inviteId: string): Promise<{ inviteToken: string; identityToken: string; accountId: string; shardId: string; endpoint: string; region: string }> {
    return this.json(`/api/me/invites/${inviteId}/accept`, { method: 'POST', body: {}, token: accessToken }, 'That invitation could not be accepted');
  }

  declineInvite(accessToken: string, inviteId: string): Promise<{ ok: true }> {
    return this.json(`/api/me/invites/${inviteId}/decline`, { method: 'POST', body: {}, token: accessToken }, 'That invitation could not be declined');
  }

  /**
   * Start a checkout, and get the URL to open in the system browser.
   *
   * Buying happens here rather than on a web page because an account cannot be
   * created for somebody remotely — the keys that encrypt a vault are derived
   * on this device from a passphrase that never reaches the server. The last
   * step is always the customer's, so the first one may as well be too.
   *
   * Owner-only, enforced by the service: the person billed is the person who
   * can commit the card.
   */
  checkout(
    accessToken: string,
    req: { accountId: string; planId: string; term: 'month' | 'year'; seats: number },
  ): Promise<{ orderId: string; url: string }> {
    return this.json('/api/billing/checkout', { method: 'POST', body: req, token: accessToken }, 'Checkout could not be started');
  }

  /**
   * A link into the payment provider's own billing portal — card, invoices,
   * cancellation.
   *
   * Minted on demand rather than stored, because these are short-lived by
   * design and a stale one would read as a bug. Reaching it from inside the
   * plugin is also what makes cancelling possible without leaving the product,
   * which our merchant of record requires of us.
   */
  billingPortal(accessToken: string, accountId: string): Promise<{ url: string }> {
    return this.json(`/api/billing/portal/${encodeURIComponent(accountId)}`, { method: 'POST', body: {}, token: accessToken }, 'The billing portal could not be opened');
  }

  /**
   * What this server sells, priced by whoever will charge for it.
   *
   * Asked every time the picker opens rather than remembered here. The
   * figures already exist in the plans table, on the pricing page and in the
   * provider's products, and a fourth copy inside a released plugin would be
   * the one nobody could correct without shipping a new release.
   */
  billingPlans(accessToken: string): Promise<{ provider: string | null; plans: PlanOffer[] }> {
    return this.json('/api/billing/plans', { token: accessToken }, 'Could not load the available plans');
  }

  /** What each organisation is on, for how many seats, until when. Reads our own rows, so it answers when the provider is down. */
  billingSummary(accessToken: string): Promise<{ provider: string | null; organisations: BillingOrganisation[] }> {
    return this.json('/api/billing/summary', { token: accessToken }, 'Could not load your subscriptions');
  }

  /** Tell the identity service the shard confirmed the join, so the invitation stops showing. */
  inviteJoined(accessToken: string, inviteId: string): Promise<{ ok: true }> {
    return this.json(`/api/me/invites/${inviteId}/joined`, { method: 'POST', body: {}, token: accessToken }, 'Could not confirm the invitation');
  }

  /**
   * An invitation as the organisation sees it. The service records every end
   * state as a timestamp and computes no status; `sentInviteStatus` does.
   */
  listAccountInvites(accessToken: string, accountId: string): Promise<{ invites: SentInvite[] }> {
    return this.json(`/api/invites?accountId=${encodeURIComponent(accountId)}`, { token: accessToken }, 'Could not list the invitations sent');
  }

  revokeInvite(accessToken: string, accountId: string, inviteId: string): Promise<{ ok: true }> {
    return this.json(`/api/invites/${inviteId}?accountId=${encodeURIComponent(accountId)}`, { method: 'DELETE', token: accessToken }, 'Could not revoke that invitation');
  }

  createInvite(accessToken: string, input: { accountId: string; email: string; role: 'member' | 'admin' }): Promise<{ invite: SentInvite }> {
    return this.json('/api/invites', { method: 'POST', body: input, token: accessToken }, 'Could not send the invitation');
  }

  /** Sign out: retire this install's own session, by the token that is it. */
  logout(refreshToken: string): Promise<{ ok: true }> {
    return this.json('/auth/logout', { body: { refreshToken } }, 'Could not sign out on the server');
  }

  revokeSession(accessToken: string, sessionId: string): Promise<{ ok: true }> {
    return this.json(`/api/me/sessions/${sessionId}`, { method: 'DELETE', token: accessToken }, 'Could not revoke that device');
  }

  /**
   * Tell the service what this vault is called, sealed.
   *
   * The name is wrapped to the account's own identity key before it gets here,
   * so what travels is a blob the service cannot read. It exists because the
   * generic label a vault sends for itself is deliberately anonymous, which
   * left somebody's own list of vaults showing the same row twice.
   */
  labelSession(accessToken: string, sessionId: string, sealedLabel: string): Promise<{ ok: true }> {
    return this.json(
      `/api/me/sessions/${encodeURIComponent(sessionId)}`,
      { method: 'PATCH', token: accessToken, body: { sealedLabel } },
      'Could not name this vault',
    );
  }

  deletePasskey(accessToken: string, credentialId: string): Promise<{ ok: true }> {
    return this.json(`/api/me/passkeys/${encodeURIComponent(credentialId)}`, { method: 'DELETE', token: accessToken }, 'Could not remove that passkey');
  }

  /** Which server holds a share key, by its SHA-256. Unknown hashes get a real server too, so nothing is enumerable. */
  /**
   * Which sync server should hold an organisation this person is about to
   * create. The identity service only answers; the shard does the creating.
   */
  placement(accessToken: string): Promise<{ shardId: string; endpoint: string; region: string }> {
    return this.json('/api/placement', { token: accessToken }, 'No server has room for a new organisation right now');
  }

  lookupShareKey(shareKeyHash: string): Promise<{ endpoint: string; shardId: string }> {
    return this.json(`/api/directory/lookup?shareKeyHash=${encodeURIComponent(shareKeyHash)}`, {}, 'Could not find that share key\'s server');
  }

  recoverParams(email: string): Promise<{ recoveryParams: { algorithm: string; iterations: number; salt: string } }> {
    return this.json(`/api/recover/params?email=${encodeURIComponent(email)}`, {}, 'Could not fetch recovery parameters');
  }

  async recover(email: string, recoveryAuthHash: string, device: DeviceFields): Promise<SignInResult> {
    const out = await this.json<unknown>('/api/recover', { body: { email, recoveryAuthHash, ...device } }, 'Recovery key not accepted');
    return validateSignInResult(out);
  }
}

/** One shard session, as `POST /api/auth/session` and `/join` answer. */
/** One invitation, from the side that sent it. Every end state is a timestamp. */
export interface SentInvite {
  id: string;
  accountId: string;
  accountName: string;
  email: string;
  role: 'member' | 'admin' | 'owner';
  invitedByName: string;
  createdAt: number;
  expiresAt: number;
  acceptedAt: number | null;
  declinedAt: number | null;
  revokedAt: number | null;
  mailSentAt: number | null;
  mailError: string | null;
}

export interface ShardSession {
  /** The shard's own id, so a join by share key can name its membership before the identity service knows of it. */
  shardId: string | null;
  accountId: string;
  accountRole: 'owner' | 'admin' | 'member';
  accountName: string | null;
  accountStatus: 'active' | 'suspended' | 'migrating' | 'moved';
  token: string;
  /** Absent from a server that predates rosters, or when no device id was sent. */
  device?: DeviceReport;
  user: { id: string; username: string; displayName: string; email: string; role: 'admin' | 'editor'; accountId: string; accountRole: string; createdAt: number };
}

/**
 * The hosted routes on a sync server. `endpoint` is the WebSocket URL the
 * membership names; the HTTP base is derived from it exactly as everywhere else.
 */
export class ShardClient {
  constructor(
    readonly endpoint: string,
    private readonly fetchFn: typeof fetch = globalFetch,
  ) {}

  private get base(): string {
    return apiBaseUrl(this.endpoint);
  }

  /**
   * Every session this identity holds on the shard: one per organisation.
   * `enrol` asks each organisation to put this device on its roster — a
   * sign-in does, a background refresh only asks where the device stands, so
   * a slot freed for one device is not taken by whichever refreshes next.
   */
  async session(identityToken: string, device: DeviceFields, opts: { enrol?: boolean } = {}): Promise<ShardSession[]> {
    const res = await this.fetchFn(`${this.base}/auth/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identityToken, ...device, enrol: opts.enrol ?? true }),
    });
    return (await readJson<{ sessions: ShardSession[] }>(res, 'The server did not accept the sign-in')).sessions;
  }

  async join(input: { identityToken: string; inviteToken?: string; shareKey?: string; newAccountName?: string; publicKey?: string; displayName?: string } & DeviceFields): Promise<{ joined: boolean; session: ShardSession }> {
    const res = await this.fetchFn(`${this.base}/auth/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    return readJson(res, 'Could not join');
  }
}
