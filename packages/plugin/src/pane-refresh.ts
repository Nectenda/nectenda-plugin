import { log } from './logger';

/**
 * When the settings pane redraws, and how much of it.
 *
 * Lifted out of `main.ts` unchanged. The pane used to be a snapshot rendered
 * once on a gesture, from fetches that raced the socket handshake and lost, and
 * nothing told it when the world had moved on. This is the model that replaced
 * it: a reason for the change, the sections that reason touches, and a
 * generation per section so a slow fetch cannot overwrite a newer answer.
 */

/** Why the plugin's state changed, as far as anything watching it cares. */
export type ChangeReason = 'connection' | 'structure' | 'memberships';

/** The fetched parts of the settings pane, each owning a container it can rebuild alone. */
export type PaneSection = 'account' | 'cloudDevices' | 'sentInvites' | 'sharedFolders' | 'invitations' | 'organisations';

/**
 * Which parts of the pane a change can have made stale.
 *
 * A connection edge changes what the account says — which devices are live,
 * what has uploaded since. A structural change (a folder mapped or unmapped,
 * memberships reconciled) changes the folder list and, through seats and
 * roles, the account. A membership refresh rewrites the settings the
 * invitation and organisation rows are drawn from. The poll asks for
 * everything that comes from a server, because it exists to catch what other
 * devices did.
 */
export function sectionsFor(reason: ChangeReason | 'poll'): PaneSection[] {
  switch (reason) {
    case 'connection': return ['account'];
    case 'structure': return ['sharedFolders', 'account', 'organisations'];
    case 'memberships': return ['invitations', 'organisations', 'sentInvites', 'cloudDevices'];
    case 'poll': return ['account', 'cloudDevices', 'sentInvites', 'sharedFolders'];
  }
}

/** How long the pane waits to fold a burst of changes into one refresh. */
export const REFRESH_COALESCE_MS = 250;

/** How often the open pane asks the servers what other devices have done. */
export const PANE_POLL_MS = 30_000;

/**
 * Who is listening for a change, and telling them.
 *
 * Copied before iterating so a listener that unsubscribes itself mid-notify
 * does not skip its neighbour, and each call is fenced so one listener's
 * fault does not silence the rest.
 */
export class ChangeFanout {
  private listeners = new Set<(reason: ChangeReason) => void>();
  on(listener: (reason: ChangeReason) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  notify(reason: ChangeReason): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(reason);
      } catch (err) {
        log.warn('A change listener threw', { reason, error: String(err) });
      }
    }
  }
}

export class SectionGenerations {
  private latest = new Map<string, number>();
  next(section: string): number {
    const n = (this.latest.get(section) ?? 0) + 1;
    this.latest.set(section, n);
    return n;
  }
  isCurrent(section: string, generation: number): boolean {
    return this.latest.get(section) === generation;
  }
}
