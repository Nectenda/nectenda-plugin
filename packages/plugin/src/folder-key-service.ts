import { log } from './logger';
import { unwrapFolderKeys, type FolderKeyRecord } from './folder-crypto';
import type { createFolderKeys } from './folder-crypto';

/** Where a folder's keys are fetched from, and with what credential. */
export interface KeyServer {
  base: string;
  token: string;
}

/**
 * What the service needs from the plugin and from the pane around it.
 *
 * Deliberately narrow. This used to live inside `NectendaSettingTab`, a class
 * of seventy-odd methods that touches forty-odd members of the plugin, so the
 * code deciding whether somebody can read their own notes sat in the same
 * scope as the code laying out a settings row. The list below is the whole of
 * what key handling actually needs, which is the point of writing it down.
 *
 * `prompt` and `held` are separate on purpose, and the difference is the most
 * important thing in this file. `prompt` may stop and ask for a passphrase;
 * `held` answers only from memory and never asks. Anything reached from a
 * render must use `held`, or opening the settings pane raises a password
 * prompt nobody asked for.
 */
export interface FolderKeyDeps {
  /** HTTP, already carrying the pane's 401 handling. */
  fetch(url: string, init?: RequestInit): Promise<Response>;
  /** The identity keypair, asking for the passphrase if this session has none. */
  prompt(reason: string): Promise<CryptoKeyPair | null>;
  /** The identity keypair only if it is already unlocked. Never asks. */
  held(): CryptoKeyPair | null;
  /** Whether this device already holds usable keys for a folder. */
  hasKeys(folderId: string): boolean;
  /** Cache keys that have been opened. */
  remember(keys: Awaited<ReturnType<typeof createFolderKeys>>): Promise<void>;
  serverFor(folderId: string): KeyServer;
  serverForMembership(membershipId: string): KeyServer;
  /** This account's enrolled public key, for wrapping to oneself. */
  ownPublicKey(): string;
}

/**
 * Getting a folder's keys, and the rules about when not to.
 *
 * Every failure here is silent by design: a folder whose keys will not open
 * shows as "Locked", which looks exactly like nobody having shared a key with
 * you. `folder-key-trace.test.ts` asserts the sequence of calls rather than
 * the result, for that reason.
 */
export class FolderKeyService {
  /**
   * Folders already asked about and refused, so one render does not re-ask.
   *
   * It is deliberately *not* permanent. A key can be wrapped for this identity
   * at any moment by somebody else, so remembering a refusal forever would
   * leave a folder showing "Locked" until the pane was closed and reopened —
   * which is the bug this whole path exists to fix. `recheck()` says when the
   * answer might have changed; the caller decides what counts.
   */
  private refused = new Set<string>();

  constructor(private deps: FolderKeyDeps) {}

  /**
   * Forget every refusal: the next `openEnvelopes` asks about all of them
   * again. Called when something happened that could have produced a key —
   * a poll, or a change to the folder list — but not on a mere reconnect.
   */
  recheck(): void {
    this.refused.clear();
  }

  ownPublicKey(): string {
    return this.deps.ownPublicKey();
  }

  /**
   * Publish wrapped keys for a folder. Throws, because every caller is a
   * deliberate action by a person who needs to be told it did not work.
   */
  async publish(
    folderId: string,
    keys: Omit<FolderKeyRecord, 'folderId'>[],
    server: KeyServer = this.deps.serverFor(folderId),
  ): Promise<void> {
    const res = await this.deps.fetch(`${server.base}/folders/${folderId}/keys`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${server.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ keys }),
    });
    if (!res.ok) throw new Error(`Server refused the folder keys (${res.status})`);
  }

  /**
   * Get a folder's keys, asking for the passphrase if necessary.
   *
   * The early return is not about saving a request. The next thing this would
   * do is prompt, and asking again for a key this device has already unwrapped
   * is a prompt nobody can make sense of.
   */
  async load(
    folderId: string,
    folderName = 'this folder',
    membershipId: string | null = null,
  ): Promise<boolean> {
    if (this.deps.hasKeys(folderId)) return true;

    const identity = await this.deps.prompt(
      `Unlocking the encryption key for “${folderName}”.`,
    );
    if (!identity) return false;
    const server = membershipId
      ? this.deps.serverForMembership(membershipId)
      : this.deps.serverFor(folderId);
    return this.fetch(folderId, identity, server);
  }

  /**
   * Fetch and unwrap with an identity already in hand. Never prompts, so the
   * pane's own rendering can call it. False when the server holds nothing this
   * identity can open — a folder shared before a key was wrapped for us — or
   * on any failure.
   */
  async fetch(folderId: string, identity: CryptoKeyPair, server: KeyServer): Promise<boolean> {
    try {
      const res = await this.deps.fetch(`${server.base}/folders/${folderId}/keys`, {
        headers: { Authorization: `Bearer ${server.token}` },
      });
      if (!res.ok) return false;
      const { keys } = (await res.json()) as { keys: FolderKeyRecord[] };
      const unwrapped = await unwrapFolderKeys(folderId, keys, identity.privateKey);
      if (!unwrapped) return false;
      await this.deps.remember(unwrapped);
      return true;
    } catch (err) {
      log.error('Could not load folder keys', { folderId, error: String(err) });
      return false;
    }
  }

  /**
   * Folders this device holds no key for, asked about once while the pane is
   * open — and only when the passphrase is already in memory, so a render
   * never raises a prompt.
   *
   * Keys were fetched only on map or unlock before, so a folder shared with
   * this person stayed "Locked folder (…)" however long they looked at it. The
   * refusal set is the other half of that fix: without it, a render that runs
   * several times between polls becomes a fetch per render for a folder that
   * will never open.
   */
  async openEnvelopes(folders: Array<{ id: string }>, server: KeyServer): Promise<void> {
    const identity = this.deps.held();
    if (!identity) return;
    for (const f of folders) {
      if (this.deps.hasKeys(f.id) || this.refused.has(f.id)) continue;
      if (!(await this.fetch(f.id, identity, server))) this.refused.add(f.id);
    }
  }
}
