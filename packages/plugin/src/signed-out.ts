/**
 * What to do when a sync server says this session is no longer accepted.
 *
 * The server closes with a distinct code when the identity session behind a
 * socket has been signed out — or when the token predates session ids and
 * has to be re-minted. The code alone does not say which, and it must not
 * decide a sign-out on its own: signing in again from this very install
 * retires its previous session, and the server closes the old sockets while
 * the new sign-in is still being applied. Acting on the code there would
 * sign out the person who just signed in.
 *
 * So the rule is: ask the identity service first. Still signed in there means
 * the shard session was merely stale — re-mint and reconnect. Refused there
 * means the session really is over — try a refresh, and only when that too
 * is refused, sign out. Unreachable means try again later. Between every
 * await, check that nothing else has moved the session on; if it has, this
 * decision belongs to whoever moved it.
 */
export type IdentityProbe = 'alive' | 'refused' | 'unreachable';

export interface SignedOutRecovery {
  /** Is the identity service still willing to talk to this session? */
  probe(): Promise<IdentityProbe>;
  /** Trade the refresh token for a new session; false when it is refused. May throw on the network. */
  refresh(): Promise<boolean>;
  /** Fetch fresh sync-server tokens for the live session. */
  remint(): Promise<void>;
  /** Reconnect the one connection that was refused. */
  reconnect(): void;
  signOut(): Promise<void>;
  /** Ask again after a while; the identity service could not be reached. */
  retryLater(): void;
  /** False once a sign-in or sign-out has happened since this began. */
  stillCurrent(): boolean;
}

export type SignedOutOutcome = 'reconnected' | 'signed-out' | 'retry' | 'superseded';

export async function recoverSignedOutConnection(deps: SignedOutRecovery): Promise<SignedOutOutcome> {
  if (!deps.stillCurrent()) return 'superseded';
  const probe = await deps.probe();
  if (!deps.stillCurrent()) return 'superseded';
  if (probe === 'unreachable') {
    deps.retryLater();
    return 'retry';
  }
  if (probe === 'alive') {
    await deps.remint();
    if (!deps.stillCurrent()) return 'superseded';
    deps.reconnect();
    return 'reconnected';
  }
  let refreshed: boolean;
  try {
    refreshed = await deps.refresh();
  } catch {
    deps.retryLater();
    return 'retry';
  }
  if (!deps.stillCurrent()) return 'superseded';
  if (refreshed) {
    // The refresh applied a whole new sign-in, which rebuilt every connection.
    return 'reconnected';
  }
  await deps.signOut();
  return 'signed-out';
}
