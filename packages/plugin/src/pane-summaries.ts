import type { StoredMembership } from './cloud-session';
import { foldersSyncedFor } from './folder-sections';
import type { SentInvite, PlanOffer } from './identity-client';

/**
 * The pure functions behind what the settings pane says.
 *
 * Lifted out of `main.ts` unchanged. Every one of these already had a test
 * importing it from a 7,000-line module: nothing here touches the plugin, the
 * vault or the network — state in, words or a small decision out — which is
 * what made them the easy part of that file to test and the hard part to find.
 */

/** Bytes for people, not for machines. */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = n / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/**
 * How long ago something happened, for people rather than for a log.
 *
 * Relative where the rest of the pane uses absolute dates, and deliberately so:
 * these rows exist to answer "which of these two folders is dead", and
 * "no changes in 4 months" answers it where `14/09/2026` leaves the reader to
 * do the arithmetic.
 */
export function describeAge(at: number | null | undefined, now = Date.now()): string | null {
  if (!at) return null;
  const seconds = Math.max(0, Math.round(now / 1000 - at));
  const scale: Array<[number, Intl.RelativeTimeFormatUnit]> = [
    [60, 'second'], [3600, 'minute'], [86400, 'hour'],
    [86400 * 7, 'day'], [86400 * 30, 'week'], [86400 * 365, 'month'], [Infinity, 'year'],
  ];
  const divisor: Record<string, number> = {
    second: 1, minute: 60, hour: 3600, day: 86400, week: 86400 * 7, month: 86400 * 30, year: 86400 * 365,
  };
  const unit = scale.find(([limit]) => seconds < limit)?.[1] ?? 'year';
  const value = Math.round(seconds / divisor[unit]);
  return new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }).format(-value, unit);
}

/**
 * Names that more than one listed folder opens to.
 *
 * Two folders can carry the same name — sharing "test" again after unmapping an
 * earlier "test" leaves both, since unmapping is not unsharing — and then
 * nothing on the row tells them apart. The short id is appended only to the
 * rows that clash, so the ordinary case stays clean.
 */
export function ambiguousNames(folders: Array<{ name: string }>): Set<string> {
  const seen = new Map<string, number>();
  for (const f of folders) seen.set(f.name, (seen.get(f.name) ?? 0) + 1);
  return new Set([...seen].filter(([, n]) => n > 1).map(([name]) => name));
}

/**
 * What the Storage row should say, and whether a bar belongs under it.
 *
 * The quota governs attachments and only attachments: the server compares
 * `blob_bytes` against it and nothing else, and text sync is never blocked by
 * it on any plan. Counting text here overstated what is measured against the
 * limit — and on a plan with no attachments it invented a figure entirely, so
 * an organisation holding nothing read "0 B of 1.0 GB", a number that is
 * neither true nor reachable.
 *
 * That figure is not nonsense in the database, which is the trap: `free` seeds
 * a quota because 0 already means unlimited, and it survives as the reference
 * the text-growth flag is measured against. It simply must not be shown as an
 * allowance, because there is none.
 */
export function storageSummary(
  limits: { quotaBytes: number; attachmentsEnabled?: boolean },
  usage: { blobBytes: number },
): { text: string; bar: boolean; used: number } {
  if (limits.attachmentsEnabled === false) {
    return {
      text: 'Attachments are not included in this plan, so there is no storage to use. Notes sync as normal.',
      bar: false,
      used: usage.blobBytes,
    };
  }
  if (limits.quotaBytes === 0) {
    return { text: `${formatBytes(usage.blobBytes)} used — no limit on this plan`, bar: false, used: usage.blobBytes };
  }
  const pct = Math.round((usage.blobBytes / limits.quotaBytes) * 100);
  return {
    text: `${formatBytes(usage.blobBytes)} of ${formatBytes(limits.quotaBytes)} (${pct}%)`,
    bar: true,
    used: usage.blobBytes,
  };
}

export function forgetUnmappedRecords(keys: string[], mappedFolderIds: ReadonlySet<string>): string[] {
  return keys.filter((key) => {
    const gap = key.indexOf(' ');
    // A key with no folder in it cannot be attributed, so it cannot be shown
    // usefully either. Dropping it is the same judgement as the rest.
    if (gap < 0) return false;
    return mappedFolderIds.has(key.slice(0, gap));
  });
}

/**
 * What about a set of memberships would make a connection change.
 *
 * The identity of the seat, where it lives, and whether it is active — and
 * not the session token. The shard mints a fresh token on every session call,
 * same claims and a new issue time, so the string differs every refresh;
 * including it made every refresh look like a change, and every change tore
 * down every socket and announced a lost connection. A fresh token is stored
 * and handed to the live connection for its next reconnect. It is not a
 * reason to reconnect now.
 */
export function membershipShape(list: Array<{ id: string; endpoint: string; accountStatus: string; device?: { enrolled: boolean } }>): string {
  // Whether this device is on the roster is part of the shape: a device that
  // was just added or removed there needs its socket opened or closed.
  return JSON.stringify(list.map((m) => [m.id, m.endpoint, m.accountStatus, m.device?.enrolled ?? null]));
}

/**
 * What an organisation's entry says beside its name, before the page is
 * opened: the one fact that explains "why is this not syncing", or the
 * roster count when nothing is wrong.
 */
export function organisationSummary(m: { accountStatus: string; device?: { enrolled: boolean; used: number; max: number } }, foldersSynced = 0): string {
  if (m.accountStatus !== 'active') return m.accountStatus;
  const folders = foldersSynced > 0 ? `${foldersSynced} ${foldersSynced === 1 ? 'folder' : 'folders'} synced` : '';
  const devices = !m.device ? '' : !m.device.enrolled ? 'not added on this device' : m.device.max > 0 ? `${m.device.used} of ${m.device.max} devices` : 'devices unlimited';
  return [folders, devices].filter(Boolean).join(' · ');
}

/** The entry's status mark: something on the page needs the person's attention. */
export function organisationWarning(m: { accountStatus: string; device?: { enrolled: boolean } }): 'warning' | null {
  return m.accountStatus !== 'active' || (m.device !== undefined && !m.device.enrolled) ? 'warning' : null;
}

/**
 * Obsidian addresses a page by its name among siblings, so two organisations
 * called the same thing need telling apart; the second is numbered.
 */
export function pageName(m: StoredMembership, index: number, all: StoredMembership[]): string {
  const before = all.slice(0, index).filter((x) => x.accountName === m.accountName).length;
  return before === 0 ? m.accountName : `${m.accountName} (${before + 1})`;
}

/** What the shared-folders section needs to know of a server. */
export type FolderServer = { base: string; token: string; membershipId: string | null; localUserId?: string | null; localUsername?: string | null };

export function pagesKey(
  list: Array<{ id: string; accountName: string; accountStatus: string; role: string; device?: { enrolled: boolean; used: number; max: number } }>,
  mappings: Array<{ membershipId?: string }> = [],
): string {
  return JSON.stringify(list.map((m) => [
    m.id, m.accountName, m.accountStatus, m.role, m.device?.enrolled ?? null, m.device?.used ?? null, m.device?.max ?? null,
    // The entry counts the folders synced here, so a map or unmap redraws it.
    foldersSyncedFor(m.id, mappings, list.length),
  ]));
}

export type SentInviteStatus = 'pending' | 'accepted' | 'declined' | 'revoked' | 'expired';

/**
 * What became of an invitation, from four timestamps.
 *
 * The service records each end state and computes nothing, so the reading is
 * made here, in the order that matters: a person who accepted is a member
 * whatever else was stamped on the row afterwards; a revoked one is finished
 * whether or not it was declined first; an expired one simply ran out.
 */
export function sentInviteStatus(
  i: { acceptedAt: number | null; declinedAt: number | null; revokedAt: number | null; expiresAt: number },
  now = Date.now() / 1000,
): SentInviteStatus {
  if (i.acceptedAt) return 'accepted';
  if (i.revokedAt) return 'revoked';
  if (i.declinedAt) return 'declined';
  if (i.expiresAt <= now) return 'expired';
  return 'pending';
}

/** The row's second line: what was sent, and what has happened to it since. */
export function sentInviteDescription(i: SentInvite, status: SentInviteStatus): string {
  const day = (t: number) => new Date(t * 1000).toLocaleDateString();
  const base = `As ${i.role}, sent ${day(i.createdAt)}`;
  // A bounce is the thing an owner most needs to know and could not see: the
  // service records it and the plugin still said "Invitation sent".
  if (i.mailError) return `${base}. The email could not be delivered: ${i.mailError}`;
  switch (status) {
    case 'pending': return `${base}. Waiting for a reply; expires ${day(i.expiresAt)}.`;
    case 'declined': return `${base}. Declined ${day(i.declinedAt!)}.`;
    case 'expired': return `${base}. Expired ${day(i.expiresAt)} without a reply.`;
    default: return `${base}.`;
  }
}

export function shouldCreateFirstOrganisation(settings: {
  keyMaterial?: { publicKey?: string | null } | null;
  memberships: unknown[];
  pendingInvites?: unknown[] | null;
}): boolean {
  return (
    !!settings.keyMaterial?.publicKey &&
    settings.memberships.length === 0 &&
    (settings.pendingInvites ?? []).length === 0
  );
}

/**
 * How long to refuse the next attempt, after `failures` wrong ones.
 *
 * **This is a speed bump, not a security control, and must not be promoted into
 * one.** Anyone who can open this dialog can also read `data.json`, which holds
 * the salt, the iteration count *and* the wrapped private key — everything
 * needed to grind offline on a GPU without ever opening Obsidian. A counter
 * here stops none of that. What it does stop is somebody trying a handful of
 * guesses at a machine left unattended.
 *
 * So: no lockout, ever. A lockout would block nothing an attacker cannot route
 * around, while risking shutting the real owner out of their own folders — the
 * trade this codebase never takes. The first two attempts are free, because
 * typos are normal.
 */
export function retryDelayMs(failures: number): number {
  if (failures <= 2) return 0;
  return Math.min(8_000, 1_000 * 2 ** (failures - 3));
}

/** Per-month cost, for ordering plans by price whatever their term. */
export function monthly(p: PlanOffer): number {
  return p.term === 'year' ? p.amount / 12 : p.amount;
}

/**
 * What gets sent to checkout for a chosen plan and seat count.
 *
 * Exported because it is the rule that cost a real customer seats, and a rule
 * that only exists inside a modal's click handler cannot be tested. **A flat
 * plan is one subscription**: whatever the seat field says, what goes to the
 * provider is 1, because the provider reports that back as `units` and `units`
 * became the account's seat cap. Sending 4 there would cap a six-seat plan at
 * four; sending 1 for a per-seat plan would charge for one seat and cap at one.
 *
 * The count is also clamped to the plan's own ceiling. The server enforces the
 * same limit and would refuse, but being refused at the payment page is too
 * late to be useful.
 */
export function planChoice(offer: PlanOffer, requestedSeats: number): { planId: string; term: 'month' | 'year'; seats: number } {
  if (!offer.perSeat) return { planId: offer.planId, term: offer.term, seats: 1 };
  const seats = Number.isInteger(requestedSeats) && requestedSeats >= 1
    ? Math.min(requestedSeats, offer.maxSeats)
    : 1;
  return { planId: offer.planId, term: offer.term, seats };
}

/**
 * Minor units to something a person reads.
 *
 * The server sends cents because that is what the provider charges in;
 * dividing happens once, here, at the point of display. A price stored or
 * passed around as a decimal is a price that has been rounded somewhere.
 */
export function formatMoney(minorUnits: number, currency: string): string {
  const figure = (minorUnits / 100).toFixed(2);
  return currency === 'USD' ? `$${figure}` : `${figure} ${currency}`;
}

/** Plan ids are lowercase and hyphenated; these are the names the site uses. */
export function planLabel(planId: string): string {
  return { personal: 'Personal', team: 'Team', 'small-business': 'Small Business' }[planId] ?? planId;
}
