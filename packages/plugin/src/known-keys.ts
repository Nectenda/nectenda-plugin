/**
 * The collaborators' keys this vault has shared a folder with, remembered.
 *
 * Wrapping a folder key to a collaborator uses the public key the server hands
 * back, and a server that interferes could hand back its own. The defence has
 * always been comparing fingerprints out of band, which only helps if somebody
 * does it. This adds the part that needs nobody: once a key has been used for
 * a person, a *different* key for that same person is refused rather than
 * used. A person keeps one keypair for as long as they keep their account —
 * nothing in Nectenda replaces it — so a change is either a new account under
 * the same address or a server lying, and both deserve a person's attention
 * before a folder key goes anywhere.
 *
 * What it cannot do is judge the first sighting. The first key seen for
 * someone is trusted because it is first (as SSH does); comparing it with
 * them is still what rules out a substitution from the start, and
 * `comparedAt` records that somebody did.
 *
 * Keyed by address, lowercased: one person has one key across every
 * organisation, while their id differs per organisation and per server.
 */

export interface KnownKey {
  fingerprint: string;
  firstSeenAt: number;
  /** When this vault's user said they compared it with the person. Null until then. */
  comparedAt: number | null;
}

export type KnownKeys = Record<string, KnownKey>;

export type KeyCheck = 'new' | 'same' | 'changed';

const keyFor = (email: string): string => email.trim().toLowerCase();

export function checkKey(known: KnownKeys, email: string, fingerprint: string): KeyCheck {
  const k = known[keyFor(email)];
  if (!k) return 'new';
  return k.fingerprint === fingerprint ? 'same' : 'changed';
}

/** Remember a first sighting. Never overwrites: a changed key is not learned by using it. */
export function rememberKey(known: KnownKeys, email: string, fingerprint: string, now: number): KnownKeys {
  const id = keyFor(email);
  if (known[id]) return known;
  return { ...known, [id]: { fingerprint, firstSeenAt: now, comparedAt: null } };
}

/**
 * The person confirmed this fingerprint out of band. Also the one way to
 * accept a changed key: they compared the *new* one, so it replaces the old.
 */
export function markCompared(known: KnownKeys, email: string, fingerprint: string, now: number): KnownKeys {
  return { ...known, [keyFor(email)]: { fingerprint, firstSeenAt: known[keyFor(email)]?.firstSeenAt ?? now, comparedAt: now } };
}

export function knownKey(known: KnownKeys, email: string): KnownKey | undefined {
  return known[keyFor(email)];
}
