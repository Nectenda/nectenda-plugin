/**
 * Starting over, for someone who has lost both their passphrase and their
 * recovery key.
 *
 * Signing in to Nectenda needs only the email address; the passphrase only
 * unlocks keys. So the person can still prove the address is theirs, and can
 * ask for it to be given a new, empty account. The server waits seven days
 * before it does, and tells every signed-in device so any of them can cancel:
 * the real owner almost always still has one, and someone holding only the
 * mailbox does not.
 *
 * Kept free of Obsidian so the wording and the decisions can be tested.
 */

export interface PendingRelease {
  requestedAt: number;
  dueAt: number;
  via: 'self' | 'support' | 'restore';
}

/** What the person must be told before they can ask, one sentence each. */
export const START_OVER_CONSEQUENCES: readonly string[] = [
  'Nothing encrypted under your current keys can be recovered: not your notes in shared folders, not by us.',
  'This address gets a new, empty account with new encryption keys. Notes already on this device stay where they are.',
  'Organisations you are the only owner of stay behind with the old account. Your seat in any other organisation is removed, and its owners keep your folders.',
  // Said here because nothing else stops the charge: the new account cannot
  // see those organisations, so it cannot open their billing either.
  'A paid subscription on an organisation you own alone keeps billing. Cancel it first in Manage subscription, or ask support afterwards to move it to a new organisation you create.',
  'Collaborators will be asked to compare your new key before they share with you again.',
  'It takes effect in 7 days. Until then, any device still signed in to this account can cancel it.',
];

/** The button is live only once the address is typed out: a click alone is not consent to this. */
export function startOverReady(typed: string, email: string): boolean {
  return typed.trim().length > 0 && typed.trim().toLowerCase() === email.trim().toLowerCase();
}

/** A date a person reads, in their own locale. */
export function dueDate(p: PendingRelease): string {
  return new Date(p.dueAt * 1000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/** The settings row and the notice say the same thing. */
export function pendingReleaseText(p: PendingRelease): { title: string; detail: string } {
  const who = p.via === 'self' ? 'You, or someone with access to your email,' : 'Nectenda support';
  return {
    title: `This account will start over on ${dueDate(p)}`,
    detail:
      `${who} asked to reset this account. When it happens every device is signed out and this address gets a ` +
      'new, empty account. If you did not ask for this, cancel it now, then change your email password.',
  };
}

/**
 * Whether to raise the notice for this request. Once per request per vault:
 * the settings row carries it after that, and a notice on every refresh would
 * teach people to dismiss it unread.
 */
export function shouldAnnounce(p: PendingRelease | null | undefined, announcedRequestedAt: number | undefined): p is PendingRelease {
  return !!p && p.requestedAt !== announcedRequestedAt;
}

/**
 * How an open vault keeps asking. Without this a vault learns of a request only
 * at load or on a Refresh press, and one left open for days would never show
 * the notice or Cancel reset — yet an open vault is exactly the device the real
 * owner still has.
 *
 * Only `/api/me` is asked, never the full membership refresh, which makes a
 * session call to every organisation's server.
 *
 * 55 minutes, not 60: with a tick every five, the longest wait is then the
 * hour CRYPTO-098 promises.
 */
export const RELEASE_CHECK_INTERVAL_MS = 55 * 60 * 1000;
/** Coming back to the window is when someone is about to read the notice; the gap stops alt-tab from becoming a request each time. */
export const RELEASE_CHECK_FOCUS_GAP_MS = 5 * 60 * 1000;
/**
 * The timer ticks often and asks rarely. Counting an hour from the last ask of
 * any kind, rather than firing on a bare hourly interval, means a full refresh
 * pushes the next check back instead of doubling it, and a laptop that slept
 * through its hour asks within minutes of waking.
 */
export const RELEASE_CHECK_TICK_MS = 5 * 60 * 1000;

export type ReleaseCheckTrigger = 'tick' | 'focus';

export function releaseCheckDue(trigger: ReleaseCheckTrigger, now: number, lastCheckedAt: number, inFlight: boolean): boolean {
  if (inFlight) return false;
  const gap = trigger === 'focus' ? RELEASE_CHECK_FOCUS_GAP_MS : RELEASE_CHECK_INTERVAL_MS;
  return now - lastCheckedAt >= gap;
}

/**
 * Whether a check may rotate the session's tokens when the access token has
 * expired. Only the timer's: each rotation is a moment where a reply lost to
 * the network leaves the vault holding a refresh token the server has retired,
 * and presenting that one again ends the session. Focus comes up to every five
 * minutes, often just as a laptop wakes and its network returns, so it asks
 * with the token it has and leaves an expired one to the timer.
 */
export function releaseCheckMayRotate(trigger: ReleaseCheckTrigger): boolean {
  return trigger === 'tick';
}

export type ReleaseCheckOutcome = { ok: true; pendingRelease?: PendingRelease | null } | { ok: false };

/**
 * What to hold after a check. An answer replaces what was held, including with
 * nothing when another device cancelled. A failed check is no answer at all, so
 * it keeps what was there: a request must not vanish from this device because
 * the network did.
 */
export function pendingAfterCheck(prev: PendingRelease | null, outcome: ReleaseCheckOutcome): PendingRelease | null {
  return outcome.ok ? outcome.pendingRelease ?? null : prev;
}
