/**
 * One call in flight at a time; everyone who asks meanwhile shares it.
 *
 * Built for the session refresh. Refresh tokens rotate, and presenting one
 * that has already been rotated out is what a stolen token looks like, so the
 * identity service ends the whole session on it. Two refreshes started in the
 * same moment — three settings loaders all refused at once when the access
 * token expired — presented the same token and signed the vault out of its own
 * accord. Sharing the pending promise means one token is ever presented once.
 */
export class SingleFlight<T> {
  private inflight: Promise<T> | null = null;

  /** True while a call is pending: a joiner can say so in its log line. */
  get pending(): boolean {
    return this.inflight !== null;
  }

  /**
   * Run `fn`, or join the run already under way. A rejection reaches every
   * joiner; a call made after the run settles starts a fresh one.
   */
  run(fn: () => Promise<T>): Promise<T> {
    if (this.inflight) return this.inflight;
    const p = fn().finally(() => {
      if (this.inflight === p) this.inflight = null;
    });
    this.inflight = p;
    return p;
  }
}

/**
 * What a session refresh does beyond rotating the tokens. A full one also
 * re-establishes every organisation's session and restarts sync; a token-only
 * one stores the new tokens and nothing else.
 */
export type RefreshKind = 'full' | 'token';

/**
 * The session refresh's gate: still one refresh token presented at a time,
 * but a caller that needs a full refresh never takes a token-only one for it.
 *
 * Joining is safe one way only. Anyone may join a full refresh, since it
 * rotates the tokens too. A caller wanting a full refresh that finds a
 * token-only one under way waits for it and then runs its own: the token-only
 * one re-established nothing, and a caller told it had would skip the work it
 * came for. It runs after, not beside, because the two would present the same
 * refresh token and end the session.
 */
export class RefreshGate {
  private inflight: { kind: RefreshKind; p: Promise<boolean> } | null = null;

  get pending(): boolean {
    return this.inflight !== null;
  }

  async run(kind: RefreshKind, fn: () => Promise<boolean>): Promise<boolean> {
    while (this.inflight) {
      const current = this.inflight;
      if (kind === 'token' || current.kind === 'full') return current.p;
      await current.p.catch(() => undefined);
    }
    const p = fn().finally(() => {
      if (this.inflight?.p === p) this.inflight = null;
    });
    this.inflight = { kind, p };
    return p;
  }
}
