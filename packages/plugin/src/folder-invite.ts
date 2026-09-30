import type { FolderKeys, FolderKeyRecord } from './folder-crypto';
import type { FolderMember, FolderRole, RosterUser } from './folder-members';
import type { KeyCheck } from './known-keys';

/**
 * Inviting someone to one shared folder, from the folder.
 *
 * There used to be two separate steps, in two places: invite an address to the
 * organisation, wait for them to join, then open the folder's members dialog
 * and add them. The second step was the one people missed. Now there is one
 * action, and this decides what it has to do:
 *
 * - **Already in the organisation**: add them to the folder and wrap its key
 *   to them now, as the members dialog always did.
 * - **Somebody new**: record an invitation to the folder on the sync server,
 *   then send the organisation invitation. When they join, the server makes
 *   them a member, and an owner's device wraps the key (`key-grants.ts`).
 * - **Somebody new, but the inviter cannot invite to the organisation**: say
 *   who can, rather than failing somewhere later.
 * - **A self-hosted server**: only people with an account there can be added;
 *   the server cannot verify an address, so it takes no invitations.
 */

export type InviteRoute =
  | { kind: 'existing'; userId: string; label: string }
  | { kind: 'new' }
  | { kind: 'not-admin' }
  | { kind: 'self-hosted' }
  | { kind: 'already-member'; label: string };

export function routeInvite(
  email: string,
  ctx: { roster: RosterUser[]; members: Array<{ userId: string }>; hosted: boolean; orgRole: string | null },
): InviteRoute {
  const want = email.trim().toLowerCase();
  const found = ctx.roster.find((u) => u.email.toLowerCase() === want);
  if (found) {
    const label = found.displayName || found.email;
    if (ctx.members.some((m) => m.userId === found.id)) return { kind: 'already-member', label };
    return { kind: 'existing', userId: found.id, label };
  }
  if (!ctx.hosted) return { kind: 'self-hosted' };
  if (ctx.orgRole !== 'owner' && ctx.orgRole !== 'admin') return { kind: 'not-admin' };
  return { kind: 'new' };
}

export interface FolderServer {
  base: string;
  token: string;
}

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

/** Decides whether a key may be used for someone; `known-keys.ts` behind a settings store. */
export interface KeyTrust {
  check(email: string, publicKey: string): Promise<{ status: KeyCheck; fingerprint: string; knownFingerprint?: string }>;
  remember(email: string, fingerprint: string): Promise<void>;
}

export type Outcome = { ok: true; message: string } | { ok: false; message: string };

const headers = (server: FolderServer): Record<string, string> => ({
  Authorization: `Bearer ${server.token}`,
  'Content-Type': 'application/json',
});

async function errorOf(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  return body.error ?? fallback;
}

/**
 * Wrap a folder's keys to one member, if their key may be trusted.
 *
 * The member must already be one; the server refuses wraps for a stranger. A
 * key that differs from the one this vault used for the same person before is
 * refused, and saying so is the whole point: the two ways that happens are a
 * new account under the same address, or a server substituting its own key.
 */
export async function shareKeyWith(
  d: { server: FolderServer; folderId: string; keys: FolderKeys | null; trust: KeyTrust; fetch: Fetch; wrap(keys: FolderKeys, userId: string, publicKey: string): Promise<Omit<FolderKeyRecord, 'folderId'>[]> },
  member: { userId: string; who: string },
): Promise<Outcome> {
  if (!d.keys) return { ok: false, message: `${member.who} was added, but this device has no key for the folder to share. It will be shared from a device that has one.` };
  const res = await d.fetch(`${d.server.base}/folders/${d.folderId}/members`, { headers: headers(d.server) });
  if (!res.ok) return { ok: false, message: `${member.who} was added, but the folder key could not be shared.` };
  const { members } = (await res.json()) as { members: FolderMember[] };
  const recipient = members.find((m) => m.userId === member.userId);
  if (!recipient?.publicKey) return { ok: false, message: `${member.who} has not set up encryption yet — the key will be shared once they have.` };
  const email = recipient.email ?? recipient.username;
  const trust = await d.trust.check(email, recipient.publicKey);
  if (trust.status === 'changed') {
    return {
      ok: false,
      message:
        `${member.who}'s encryption key has changed since you last shared with them (was ${trust.knownFingerprint}, now ${trust.fingerprint}). ` +
        'No key was shared. Compare fingerprints with them outside Nectenda, then mark it as compared in the members list.',
    };
  }
  const wrapped = await d.wrap(d.keys, member.userId, recipient.publicKey);
  const put = await d.fetch(`${d.server.base}/folders/${d.folderId}/keys`, { method: 'POST', headers: headers(d.server), body: JSON.stringify({ keys: wrapped }) });
  if (!put.ok && put.status !== 409) return { ok: false, message: `${member.who} was added, but the folder key could not be shared.` };
  if (trust.status === 'new') await d.trust.remember(email, trust.fingerprint);
  return { ok: true, message: `Shared with ${member.who}. Their key: ${trust.fingerprint}.` };
}

/** Add someone already in the organisation, then share the key with them. */
export async function addExistingMember(
  d: Parameters<typeof shareKeyWith>[0],
  member: { userId: string; who: string; role: FolderRole },
): Promise<Outcome> {
  const res = await d.fetch(`${d.server.base}/folders/${d.folderId}/members`, {
    method: 'POST',
    headers: headers(d.server),
    body: JSON.stringify({ userId: member.userId, role: member.role }),
  });
  if (!res.ok) return { ok: false, message: await errorOf(res, 'Could not change membership') };
  return shareKeyWith(d, member);
}

/**
 * Invite a new address: the folder invitation first, then the organisation's.
 *
 * In that order because the folder invitation is the one that cannot be sent
 * later — once they have joined, the organisation invitation is used up and
 * there is nothing left to hang the folder on. If the organisation invitation
 * then fails, the folder invitation is withdrawn, so nothing is left behind
 * that looks sent and was not.
 *
 * `already` is answered when the server knows them after all (a roster read
 * before they joined): the caller adds them as an existing member instead.
 */
export async function inviteNewAddress(
  d: { server: FolderServer; folderId: string; fetch: Fetch; inviteToOrganisation(email: string): Promise<void> },
  invite: { email: string; role: FolderRole },
): Promise<Outcome | { ok: false; already: true }> {
  const res = await d.fetch(`${d.server.base}/folders/${d.folderId}/invitations`, {
    method: 'POST',
    headers: headers(d.server),
    body: JSON.stringify({ email: invite.email, role: invite.role }),
  });
  if (res.status === 409) {
    const body = (await res.clone().json().catch(() => ({}))) as { code?: string };
    if (body.code === 'ALREADY_IN_ORGANISATION') return { ok: false, already: true };
  }
  if (res.status === 404) return { ok: false, message: 'This sync server does not take folder invitations yet. Invite them to the organisation first, then add them here.' };
  if (!res.ok) return { ok: false, message: await errorOf(res, 'Could not invite them to the folder') };
  const { invitation } = (await res.json()) as { invitation: { id: string } };
  try {
    await d.inviteToOrganisation(invite.email);
  } catch (err) {
    await d.fetch(`${d.server.base}/folders/${d.folderId}/invitations/${invitation.id}`, { method: 'DELETE', headers: headers(d.server) }).catch(() => undefined);
    return { ok: false, message: err instanceof Error ? err.message : 'Could not send the invitation' };
  }
  return { ok: true, message: `Invitation sent to ${invite.email}. They get the folder as soon as they join; your vault shares its key the next time it is open.` };
}
