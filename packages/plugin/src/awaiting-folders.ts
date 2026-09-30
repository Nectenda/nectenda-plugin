import type { SharedFolderInfo } from '@nectenda/shared';
import { SingleFlight } from './single-flight';

/**
 * Folders shared with this person that this vault has not added yet.
 *
 * Before this, a folder somebody shared with you appeared as one more row
 * under the organisation's "Available Folders", in a settings page you had to
 * think to open. Now the vault notices a newly shared folder and offers it
 * once, as soon as its key has arrived: "Ann shared a folder with you. Add it
 * to this vault?"
 *
 * "Once its key has arrived" matters. Membership comes first and the key
 * after it, from an owner's device, so a folder can be listed for a while with
 * nothing to open it with. Offering it then would end in an error; it is
 * reported as waiting instead, and offered when the key lands.
 *
 * A vault that was already signed in when this arrived starts with no record
 * (`seen()` is null), and its first pass only records what is listed, without
 * offering it: those folders were visible before, and a vault that chose not
 * to add them should not be asked now. A sign-in starts the record empty, so
 * a new member is offered everything shared with them, including the folder
 * they were invited to.
 */

export interface AwaitingServer {
  base: string;
  token: string;
  membershipId: string | null;
}

export interface OfferedFolder {
  folder: SharedFolderInfo & { role?: 'owner' | 'editor' };
  membershipId: string | null;
}

export interface AwaitingFoldersDeps {
  servers(): AwaitingServer[];
  /** Shared-folder ids this vault already syncs. */
  mapped(): Set<string>;
  /** Ids already offered or already listed at the first pass; null before the first pass. */
  seen(): string[] | null;
  saveSeen(ids: string[]): Promise<void>;
  fetch(url: string, init?: RequestInit): Promise<Response>;
  offer(folders: OfferedFolder[]): void;
}

export interface AwaitingReport {
  /** Listed, not added here, and openable: the key has arrived. */
  ready: OfferedFolder[];
  /** Listed, not added here, and no key for this person yet. */
  waiting: OfferedFolder[];
}

export class AwaitingFolders {
  private flight = new SingleFlight<AwaitingReport>();
  private last: AwaitingReport = { ready: [], waiting: [] };

  constructor(private deps: AwaitingFoldersDeps) {}

  get report(): AwaitingReport {
    return this.last;
  }

  run(): Promise<AwaitingReport> {
    return this.flight.run(() => this.pass());
  }

  private async pass(): Promise<AwaitingReport> {
    const mapped = this.deps.mapped();
    const ready: OfferedFolder[] = [];
    const waiting: OfferedFolder[] = [];
    let complete = true;
    for (const server of this.deps.servers()) {
      const auth = { headers: { Authorization: `Bearer ${server.token}` } };
      let folders: Array<SharedFolderInfo & { role?: 'owner' | 'editor' }>;
      try {
        const res = await this.deps.fetch(`${server.base}/folders`, auth);
        if (!res.ok) { complete = false; continue; }
        ({ folders } = (await res.json()) as { folders: typeof folders });
      } catch {
        complete = false;
        continue;
      }
      for (const folder of folders) {
        if (mapped.has(folder.id)) continue;
        let hasKey = false;
        try {
          const res = await this.deps.fetch(`${server.base}/folders/${folder.id}/keys`, auth);
          if (!res.ok) continue;
          const { keys } = (await res.json()) as { keys: unknown[] };
          hasKey = keys.length > 0;
        } catch {
          complete = false;
          continue;
        }
        (hasKey ? ready : waiting).push({ folder, membershipId: server.membershipId });
      }
    }
    this.last = { ready, waiting };

    const seen = this.deps.seen();
    if (seen === null) {
      // A first pass that could not see every server would record too little
      // and then offer the rest as new, so it waits for a complete one.
      if (complete) await this.deps.saveSeen([...ready, ...waiting].map((f) => f.folder.id));
      return this.last;
    }
    const known = new Set(seen);
    const fresh = ready.filter((f) => !known.has(f.folder.id));
    if (fresh.length) {
      // Recorded before offering, so a crash between the two cannot offer the
      // same folder twice; a missed offer still leaves the folder listed in
      // settings, where it can be added.
      await this.deps.saveSeen([...seen, ...fresh.map((f) => f.folder.id)]);
      this.deps.offer(fresh);
    }
    return this.last;
  }
}
