/**
 * The plugin's half of a hosted sign-in.
 *
 * The identity service completes the sign-in in the system browser; this
 * module owns what happens in Obsidian around it: proving to the service that
 * the poller is the same party that started the flow (PKCE), waiting for the
 * result without hammering the service, and refusing a result that does not
 * have the shape a sign-in must have.
 *
 * Pure on purpose. Nothing here touches Obsidian or settings, so the whole of
 * it runs in a unit test with a fake `fetch`.
 */

import { serverFetch } from './client-version.js';

export interface Pkce {
  /** Kept on this device, sent only with the poll. */
  verifier: string;
  /** base64url(SHA-256(verifier)); the only thing the browser ever sees. */
  challenge: string;
}

function base64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * A fresh verifier and its challenge.
 *
 * The verifier binds the poll to the plugin that opened the browser. Without
 * it, anyone who saw the nonce — it is in the URL the browser opened — could
 * collect the tokens by polling first.
 */
export async function newPkce(): Promise<Pkce> {
  const raw = new Uint8Array(32);
  crypto.getRandomValues(raw);
  const verifier = base64url(raw);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return { verifier, challenge: base64url(new Uint8Array(digest)) };
}

/** What the identity service hands back when a sign-in completes. */
export interface SignInResult {
  accessToken: string;
  identityToken: string;
  refreshToken: string;
  method?: string;
  user: { id: string; email: string; displayName: string };
  memberships: Membership[];
  invites: PendingInvite[];
  keyMaterial: {
    publicKey: string | null;
    wrappedPrivateKey: string | null;
    recoveryBlob: string | null;
    recoveryParams: unknown;
    kdfParams: KdfParamsLike | null;
  };
  passkeys?: unknown[];
  sessions?: unknown[];
  providers?: string[];
}

export interface KdfParamsLike {
  algorithm: string;
  iterations: number;
  salt: string;
}

/** One seat: an organisation and the sync server it lives on. */
export interface Membership {
  accountId: string;
  accountName: string;
  accountStatus: 'active' | 'suspended' | 'migrating' | 'moved';
  role: 'owner' | 'admin' | 'member';
  userId: string;
  shardId: string;
  endpoint: string;
  region: string;
  displayName: string;
}

export interface PendingInvite {
  id: string;
  accountId: string;
  accountName: string;
  role: 'admin' | 'member';
  invitedBy: string;
  expiresAt: number;
}

/**
 * Accept only a result that can actually be used.
 *
 * A malformed result would otherwise be persisted and fail later, somewhere
 * far from the sign-in, as "Not signed in" with no explanation. Refusing here
 * keeps the failure next to its cause.
 */
export function validateSignInResult(value: unknown): SignInResult {
  const v = value as Record<string, unknown>;
  if (!v || typeof v !== 'object') throw new Error('The sign-in result was not an object');
  for (const k of ['accessToken', 'identityToken', 'refreshToken']) {
    if (typeof v[k] !== 'string' || !(v[k] as string)) throw new Error(`The sign-in result has no ${k}`);
  }
  const user = v.user as Record<string, unknown> | undefined;
  if (!user || typeof user.id !== 'string' || typeof user.email !== 'string') {
    throw new Error('The sign-in result names no user');
  }
  if (!Array.isArray(v.memberships)) throw new Error('The sign-in result lists no memberships');
  for (const m of v.memberships as Array<Record<string, unknown>>) {
    if (typeof m.accountId !== 'string' || typeof m.endpoint !== 'string' || typeof m.shardId !== 'string') {
      throw new Error('A membership in the sign-in result is malformed');
    }
  }
  return v as unknown as SignInResult;
}

export type PollOutcome =
  | { status: 'done'; result: SignInResult }
  | { status: 'expired' }
  | { status: 'cancelled' };

export interface PollOptions {
  /** The identity service's API base, e.g. `https://accounts.nectenda.com`. */
  baseUrl: string;
  nonce: string;
  verifier: string;
  /** Injectable for tests. */
  fetchFn?: typeof fetch;
  /** First interval; grows by 1.5× to the cap after repeated silence. */
  intervalMs?: number;
  maxIntervalMs?: number;
  /** Give up after this long; the flow itself expires server-side too. */
  timeoutMs?: number;
  signal?: AbortSignal;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Wait for the browser to finish.
 *
 * Polling rather than a deep link, because `obsidian://` handlers are
 * unreliable on iOS and a deep link would have to carry the tokens through the
 * OS. The service answers `pending` until the person finishes, `done` exactly
 * once, and `410` when the flow has expired or was already collected — the
 * last of which is also what a wrong verifier gets, deliberately.
 */
export async function pollForResult(opts: PollOptions): Promise<PollOutcome> {
  // Wrapped so a browser never sees a foreign `this`; see identity-client.ts.
  const fetchFn: typeof fetch = opts.fetchFn ?? ((input, init) => serverFetch(input, init));
  const sleep = opts.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  const started = Date.now();
  const timeout = opts.timeoutMs ?? 5 * 60_000;
  let interval = opts.intervalMs ?? 1000;
  const cap = opts.maxIntervalMs ?? 5000;
  const url = `${opts.baseUrl}/auth/poll?nonce=${encodeURIComponent(opts.nonce)}&verifier=${encodeURIComponent(opts.verifier)}`;

  while (Date.now() - started < timeout) {
    if (opts.signal?.aborted) return { status: 'cancelled' };
    let res: Response;
    try {
      res = await fetchFn(url, { signal: opts.signal });
    } catch (err) {
      if (opts.signal?.aborted) return { status: 'cancelled' };
      // A blip; keep going. Network errors during a sign-in are the norm on a
      // laptop that just switched to the browser over a flaky connection.
      void err;
      await sleep(interval);
      interval = Math.min(cap, Math.round(interval * 1.5));
      continue;
    }
    if (res.status === 410) return { status: 'expired' };
    if (res.ok) {
      const body = (await res.json()) as { status?: string };
      if (body.status === 'done') return { status: 'done', result: validateSignInResult(body) };
    }
    await sleep(interval);
    interval = Math.min(cap, Math.round(interval * 1.5));
  }
  return { status: 'expired' };
}
