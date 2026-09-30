/**
 * What one row of a folder's people list says, and which controls it carries.
 *
 * Kept apart from the modal so the rule can be tested without Obsidian. The
 * rule that matters is who sees what: every member sees every fingerprint and
 * may mark one compared, because comparing keys is the defence against a
 * server that substitutes its own (`docs/security-model.md`) and it takes both
 * people to compare. Only an owner gets the controls that change membership —
 * the server refuses them from anyone else, and a control that can only fail
 * is worse than none.
 */

import { memberLabel, type FolderMember } from './folder-members';
import type { KnownKey } from './known-keys';
import type { WaitingState } from './key-grants';

export interface MemberRowContext {
  /** The member's key fingerprint, or null when they have not enrolled. */
  fingerprint: string | null;
  /** This row is the person looking at it. */
  self: boolean;
  /** What this vault remembers of the member's key. */
  known: KnownKey | undefined;
  /** Why the member is still without a key, as the last automatic pass saw it. */
  waiting: WaitingState | undefined;
  /** The viewer owns the folder, and so may change who is in it. */
  canManage: boolean;
}

export interface MemberRow {
  name: string;
  desc: string;
  /** The key differs from the one this vault remembers. */
  warning: boolean;
  /** Offer "Mark as compared". */
  compare: boolean;
  /** Offer the role dropdown. */
  role: boolean;
  /** Offer Remove. */
  remove: boolean;
}

/** "compared 3 Oct", or why not, for the line under a member's name. */
export function comparedLine(known: KnownKey | undefined, fingerprint: string): string {
  if (!known) return 'not compared yet';
  if (known.fingerprint !== fingerprint) return `KEY CHANGED — was ${known.fingerprint}`;
  return known.comparedAt ? `compared ${new Date(known.comparedAt).toLocaleDateString()}` : 'not compared yet';
}

export function waitingLine(state: WaitingState | undefined): string | null {
  switch (state?.kind) {
    case 'no-key-on-this-device': return 'waiting for their key: a device that holds this folder\'s key shares it when it is next open';
    case 'no-public-key': return 'waiting for them to set up encryption';
    case 'key-changed': return 'not shared: their key changed — compare it with them, then mark it compared';
    case 'failed': return 'sharing the key failed; it is retried automatically';
    default: return null;
  }
}

export function memberRow(member: FolderMember, c: MemberRowContext): MemberRow {
  const { fingerprint, self, known } = c;
  const name = self ? `${memberLabel(member)} (you)` : memberLabel(member);
  const address = member.displayName && member.email ? `${member.email} — ` : '';
  const waiting = waitingLine(c.waiting);
  // Your own key has nothing to be compared against here; it is shown
  // below as the one collaborators compare theirs with.
  const keyLine = !fingerprint
    ? 'has not set up encryption yet'
    : self ? `key ${fingerprint}` : `key ${fingerprint} (${comparedLine(known, fingerprint)})`;
  return {
    name,
    desc: `${address}${member.role} — ${keyLine}${waiting ? ` — ${waiting}` : ''}`,
    // Only a key that differs from the one remembered is a warning. One not
    // compared yet is the normal state of every new collaborator, and
    // colouring it would teach people to ignore the colour.
    warning: !self && !!fingerprint && !!known && known.fingerprint !== fingerprint,
    compare: !self && !!fingerprint && !(known?.fingerprint === fingerprint && known.comparedAt),
    role: c.canManage,
    // Not on your own row: leaving a folder is "Stop syncing here", and
    // removing yourself as its owner would lock you out of managing it.
    remove: c.canManage && !self,
  };
}
