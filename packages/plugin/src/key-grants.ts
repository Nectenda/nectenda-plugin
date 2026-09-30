import type { AwaitingKeyInfo } from '@nectenda/shared';
import type { FolderKeys, FolderKeyRecord } from './folder-crypto';
import { checkKey, rememberKey, type KnownKeys } from './known-keys';
import { SingleFlight } from './single-flight';

/**
 * Finish sharing a folder without anyone having to press a button.
 *
 * Somebody invited to a folder becomes a member when they join, but the server
 * cannot give them the folder key: it has none. An owner's device has to wrap
 * the key to their public key, and until this existed that happened only when
 * an owner opened the members dialog and added them by hand — the step people
 * missed, leaving a collaborator with a folder that looked broken.
 *
 * So an owner's device asks the server which members of its folders are still
 * waiting for a key, and wraps for them. It is deliberately narrow:
 *
 * - **Owners only.** The server lets any member publish wraps for another, and
 *   this does not use that: whether a key goes to someone is an owner's call,
 *   the same as the members dialog. The server lists only folders the caller
 *   owns.
 * - **Keys already open on this device.** It never asks for the passphrase. A
 *   device that does not hold a folder's key skips it; another owner device,
 *   or this one after unlocking, finishes the job.
 * - **The same key check as adding by hand, and stricter than it was.** A
 *   collaborator whose key differs from the one this vault used for them
 *   before gets nothing, and a lasting warning instead (`known-keys.ts`).
 *
 * The decision it automates is exactly the one the members dialog made: wrap
 * to the key the server returned. What it adds is the refusal of a changed key.
 */

export interface GrantServer {
  base: string;
  token: string;
}

export interface KeyGrantDeps {
  servers(): GrantServer[];
  folderKeys(folderId: string): FolderKeys | null;
  folderName(folderId: string): string;
  knownKeys(): KnownKeys;
  saveKnownKeys(next: KnownKeys): Promise<void>;
  fingerprint(publicKey: string): Promise<string>;
  wrap(keys: FolderKeys, userId: string, publicKey: string): Promise<Omit<FolderKeyRecord, 'folderId'>[]>;
  fetch(url: string, init?: RequestInit): Promise<Response>;
  /** Tell the person, once per event. */
  shared(e: { folderId: string; folderName: string; who: string; fingerprint: string; firstSighting: boolean }): void;
  refused(e: { folderId: string; folderName: string; who: string; email: string; fingerprint: string; knownFingerprint: string }): void;
  now(): number;
}

/** Where one waiting member stands, as this device last saw it. */
export type WaitingState =
  | { kind: 'shared' }
  | { kind: 'no-public-key' }
  | { kind: 'no-key-on-this-device' }
  | { kind: 'key-changed'; fingerprint: string; knownFingerprint: string }
  | { kind: 'failed'; error: string };

export interface GrantReport {
  /** Invitations sent from folders this vault owns that nobody has claimed yet. */
  pendingInvitations: number;
  /** Members still without a key after this pass, including refusals. */
  stillWaiting: number;
  states: Map<string, WaitingState>;
}

/** `${folderId} ${userId}`, the key of a waiting member in a report. */
export const waitingKey = (folderId: string, userId: string): string => `${folderId} ${userId}`;

export class KeyGrantService {
  private flight = new SingleFlight<GrantReport>();
  private last: GrantReport = { pendingInvitations: 0, stillWaiting: 0, states: new Map() };
  /** Refusals already reported, so a warning is lasting but not repeated every minute. */
  private warned = new Set<string>();

  constructor(private deps: KeyGrantDeps) {}

  /** What the last pass found; the settings pane reads it to explain a member row. */
  get report(): GrantReport {
    return this.last;
  }

  /** One pass over every server. Concurrent callers share it. */
  run(): Promise<GrantReport> {
    return this.flight.run(() => this.pass());
  }

  private async pass(): Promise<GrantReport> {
    const states = new Map<string, WaitingState>();
    let pendingInvitations = 0;
    let stillWaiting = 0;
    let known = this.deps.knownKeys();
    const learned = (): boolean => known !== this.deps.knownKeys();

    for (const server of this.deps.servers()) {
      let body: { members: AwaitingKeyInfo[]; pendingInvitations: number };
      try {
        const res = await this.deps.fetch(`${server.base}/folders/awaiting-keys`, { headers: { Authorization: `Bearer ${server.token}` } });
        // A server from before folder invitations answers 404 here; there is
        // nothing to do there, and the members dialog still works as it did.
        if (!res.ok) continue;
        body = (await res.json()) as typeof body;
      } catch {
        continue;
      }
      pendingInvitations += body.pendingInvitations ?? 0;

      for (const m of body.members ?? []) {
        const id = waitingKey(m.folderId, m.userId);
        const who = m.displayName || m.email;
        if (!m.publicKey) {
          states.set(id, { kind: 'no-public-key' });
          stillWaiting++;
          continue;
        }
        const keys = this.deps.folderKeys(m.folderId);
        if (!keys) {
          states.set(id, { kind: 'no-key-on-this-device' });
          stillWaiting++;
          continue;
        }
        const fingerprint = await this.deps.fingerprint(m.publicKey);
        const check = checkKey(known, m.email, fingerprint);
        if (check === 'changed') {
          const knownFingerprint = known[m.email.trim().toLowerCase()].fingerprint;
          states.set(id, { kind: 'key-changed', fingerprint, knownFingerprint });
          stillWaiting++;
          const warnKey = `${m.email.toLowerCase()} ${fingerprint}`;
          if (!this.warned.has(warnKey)) {
            this.warned.add(warnKey);
            this.deps.refused({ folderId: m.folderId, folderName: this.deps.folderName(m.folderId), who, email: m.email, fingerprint, knownFingerprint });
          }
          continue;
        }
        try {
          // Only the generations they lack: the server refuses a batch that
          // repeats a wrap the recipient already holds.
          const missing = new Set(m.missing.map((k) => `${k.kind}:${k.keyId}`));
          const wraps = (await this.deps.wrap(keys, m.userId, m.publicKey)).filter((w) => missing.has(`${w.kind}:${w.keyId}`));
          if (wraps.length) {
            const res = await this.deps.fetch(`${server.base}/folders/${m.folderId}/keys`, {
              method: 'POST',
              headers: { Authorization: `Bearer ${server.token}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({ keys: wraps }),
            });
            // 409 is another owner device getting there first, which is done.
            if (!res.ok && res.status !== 409) throw new Error(`keys: ${res.status}`);
          }
          if (check === 'new') known = rememberKey(known, m.email, fingerprint, this.deps.now());
          states.set(id, { kind: 'shared' });
          this.deps.shared({ folderId: m.folderId, folderName: this.deps.folderName(m.folderId), who, fingerprint, firstSighting: check === 'new' });
        } catch (err) {
          states.set(id, { kind: 'failed', error: String(err) });
          stillWaiting++;
        }
      }
    }
    if (learned()) await this.deps.saveKnownKeys(known);
    this.last = { pendingInvitations, stillWaiting, states };
    return this.last;
  }
}

/**
 * How long until the next pass. Often while somebody is on their way in —
 * an invitation out, or a member waiting — so their folder arrives within a
 * minute of joining; rarely otherwise, since the passes that matter are also
 * triggered by sign-in, reconnection and the settings pane.
 */
export function nextGrantDelayMs(report: GrantReport): number {
  return report.pendingInvitations > 0 || report.stillWaiting > 0 ? 60_000 : 15 * 60_000;
}
