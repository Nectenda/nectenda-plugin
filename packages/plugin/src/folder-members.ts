/**
 * Who a shared folder's owner can add, and how each person is named.
 *
 * The members list used to show the shard's username — for a hosted user two
 * ids joined by a dot — and adding someone meant typing an address that had
 * to match exactly. Members are named by display name and email now, and a
 * new one is picked from the organisation's roster.
 */

export interface RosterUser {
  id: string;
  username: string;
  displayName?: string;
  email: string;
  /** Whether a folder key can be wrapped for them yet; absent on an older shard. */
  hasKeys?: boolean;
}

export interface PickerCandidate {
  id: string;
  label: string;
  /** False when the person has not enrolled encryption keys: shown, but not addable. */
  addable: boolean;
}

/** What to call someone: their display name, else their address, else the username. */
export function memberLabel(m: { username: string; displayName?: string; email?: string }): string {
  return m.displayName || m.email || m.username;
}

/**
 * The roster minus those already in the folder and the person choosing;
 * someone without keys stays visible, marked, so their absence from the
 * picker is not a mystery.
 */
export function pickerCandidates(
  users: RosterUser[],
  members: Array<{ userId: string }>,
  selfUserId: string | null,
): PickerCandidate[] {
  const taken = new Set(members.map((m) => m.userId));
  return users
    .filter((u) => u.id !== selfUserId && !taken.has(u.id))
    .map((u) => {
      const name = u.displayName || u.username;
      const addable = u.hasKeys !== false;
      return {
        id: u.id,
        label: `${name} — ${u.email}${addable ? '' : ' (no encryption keys yet)'}`,
        addable,
      };
    })
    .sort((a, b) => a.label.localeCompare(b.label));
}
