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
