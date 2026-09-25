import type { KeyMaterial, KdfParams } from '@nectenda/shared';
import { identityPairs } from '@nectenda/shared';
import { log } from './logger';
import * as session from './session';
import type { SessionKeys } from './session';

/**
 * One attempt at the passphrase, as an outcome rather than an exception.
 *
 * The two failures have to stay distinguishable: a wrong passphrase is a typo
 * and is offered another go, and `fatal` says this one is not.
 */
export type VerifyOutcome = { ok: true } | { ok: false; message: string; fatal?: boolean };

/** The account fields an unlock needs, read at the moment it is needed. */
export interface IdentityAccount {
  mode: 'self-hosted' | 'cloud';
  username: string;
  serverUrl: string;
  keyMaterial: (KeyMaterial & { kdfParams?: KdfParams | null }) | null | undefined;
}

/**
 * What getting hold of the identity keypair needs from the plugin and from
 * the pane around it.
 *
 * Three of these are the places this can stop and talk to somebody — `ask`,
 * `enrol` and `notify` — and they are dependencies rather than calls so that
 * the rules below can be tested without a modal. The other four are where the
 * keypair may already be: this Obsidian session, or the OS credential store.
 */
export interface IdentityDeps {
  /**
   * Read late, never captured. `refreshMemberships` rewrites `keyMaterial`
   * from the server on a timer of its own, so a copy taken at construction
   * would go stale between a check and the attempt that relies on it.
   */
  account(): IdentityAccount;
  /** The keypair if this Obsidian session already has it. Never asks. */
  held(): CryptoKeyPair | null;
  /** Hold the unlocked keys for the rest of the session. */
  cache(keys: SessionKeys): void;
  /** The keypair if the OS credential store holds it for this device. */
  restoreFromDevice(): Promise<CryptoKeyPair | null>;
  /** Keep it for the device, where there is somewhere to keep it. */
  rememberOnDevice(identity: CryptoKeyPair): Promise<void>;
  /** Open the passphrase prompt; resolves when unlocked, cancelled or dismissed. */
  ask(reason: string, verify: (password: string) => Promise<VerifyOutcome>): Promise<boolean>;
  /** Set a passphrase on a cloud account that has none. This *is* the enrolment. */
  enrol(): Promise<boolean>;
  notify(message: string): void;
}

/**
 * Getting hold of the identity keypair, and the rules about not replacing it.
 *
 * The keypair is the root of everything readable: every folder key is wrapped
 * to it. So the dangerous operation here is not failing to unlock — that is
 * recoverable and visible — but *enrolling*, which mints a new keypair and
 * leaves every existing folder key wrapped to one nobody holds any more.
 * `ensure` therefore treats "no key material" and "half of it" as different
 * states, and only the first is allowed anywhere near enrolment.
 *
 * `identity-session-trace.test.ts` asserts the sequence of calls this makes
 * rather than only what it returns, because a version that unlocked and then
 * cached nothing looks identical from the outside.
 */
export class IdentitySession {
  constructor(private deps: IdentityDeps) {}

  /**
   * The identity keypair, asking for the password if this session has none.
   *
   * Held for the rest of the session once unlocked, and — where the OS gives
   * somewhere to hold it — for the device, so this is asked once per machine
   * rather than once per vault. It used to say "never written down"; that
   * stopped being true.
   */
  async ensure(reason: string): Promise<CryptoKeyPair | null> {
    const existing = this.deps.held();
    if (existing) return existing;

    // Held for this device, where the OS provides somewhere to hold it. Asked
    // here as well as at startup so that signing in partway through a session
    // gets the same answer, rather than the cache depending on onload timing.
    const held = await this.deps.restoreFromDevice();
    if (held) {
      this.deps.cache({ identity: held });
      return held;
    }

    const { username, keyMaterial, serverUrl, mode } = this.deps.account();
    const enrolled = !!keyMaterial?.publicKey;
    const unlockable = enrolled && !!keyMaterial?.wrappedPrivateKey;

    // Three states, not two. This used to branch on `wrappedPrivateKey` alone —
    // the only guard in the file that did, against fourteen testing
    // `publicKey` — so key material with a public key and no wrapped key fell
    // into enrolment and generated a *new* keypair, orphaning every folder key
    // ever wrapped to the old one. Silent, permanent, and one missing field
    // away. `unlockIdentity` already requires both halves; this now agrees.
    if (!enrolled && !keyMaterial?.wrappedPrivateKey) {
      if (mode === 'cloud') {
        // No keys at all: this is the first device. Setting the passphrase is
        // the enrolment, and it leaves the keypair unlocked in memory.
        if (await this.deps.enrol()) return this.deps.held();
        return null;
      }
      this.deps.notify('This account has no encryption keys enrolled. Log in again to enrol them.');
      return null;
    }

    if (!unlockable) {
      // Half-enrolled. Never offer to set a passphrase here: that would replace
      // the keypair the account's folder keys are wrapped to.
      this.deps.notify('This account’s encryption keys are incomplete. Sign in again, or recover with your recovery key.');
      log.error('Key material is half-enrolled; refusing to re-enrol over it', {
        hasPublicKey: enrolled, hasWrappedPrivateKey: !!keyMaterial?.wrappedPrivateKey,
      });
      return null;
    }

    // Self-hosted needs its KDF parameters from the server, and they are
    // fetched once here rather than inside each attempt. The prompt retries in
    // place, so folding this into the attempt would spend one request per guess
    // against `kdfParamsLimiter` (60 per 15 minutes per IP) and start answering
    // a mistyping user with 429s. The call verifies nothing — the same salt and
    // iteration count come back whatever is typed. The hosted service needs no
    // equivalent: its parameters are already in `keyMaterial`.
    let selfHostedParams: KdfParams | null = null;
    if (mode !== 'cloud') {
      try {
        selfHostedParams = await session.fetchUnlockParams(serverUrl, username);
      } catch (err) {
        this.deps.notify('Could not reach your server to unlock. Check the connection and try again.');
        log.warn('Could not fetch the KDF parameters for an unlock', { error: String(err) });
        return null;
      }
    }

    const unlocked = await this.deps.ask(reason, (password) =>
      this.verify(password, keyMaterial, selfHostedParams),
    );
    if (!unlocked) {
      // Said rather than silent: a dismissed prompt used to leave no trace at
      // all, and the folders it would have opened just render as locked.
      this.deps.notify('Passphrase not entered. Your shared folders stay locked until it is.');
      return null;
    }
    return this.deps.held();
  }

  /**
   * One attempt at the passphrase, as an outcome rather than an exception.
   *
   * Separate from the prompt so it can be tested without a modal, and so the
   * two failures stay distinguishable: a wrong passphrase is a typo and is
   * offered another go; halves that do not belong together are not, and say so.
   *
   * On success the keys are held for the rest of the Obsidian session even
   * where nothing can be written to a credential store, and `rememberOnDevice`
   * keeps them for the device where it can.
   */
  async verify(
    password: string,
    keyMaterial: KeyMaterial & { kdfParams?: KdfParams | null },
    selfHostedParams: KdfParams | null,
  ): Promise<VerifyOutcome> {
    // Taken as an argument, not re-read from the account. The caller checked
    // both halves are present, and `refreshMemberships` rewrites `keyMaterial`
    // from the server on a timer of its own — re-reading here would let it
    // change between the check and the attempt.
    const { mode } = this.deps.account();
    try {
      const keys = mode === 'cloud'
        ? await session.cloudUnlock(password, { ...keyMaterial, kdfParams: keyMaterial.kdfParams ?? null })
        : await session.unlockWith(selfHostedParams!, password, keyMaterial);
      if (!(await identityPairs(keys.identity))) {
        // The passphrase was right — AES-GCM proved that by opening the blob.
        // The halves not belonging together means the material is corrupt or
        // was substituted, which must not read as a typo and must not invite
        // another attempt. Nothing is cached: keys that do not pair would go on
        // to wrap folder keys nobody can unwrap.
        log.error('Unwrapped identity does not pair with the stored public key');
        this.deps.notify('Your encryption keys did not verify. Do not enter your passphrase again until you know why.');
        return { ok: false, fatal: true, message: 'Your encryption keys did not verify.' };
      }
      this.deps.cache(keys);
      await this.deps.rememberOnDevice(keys.identity);
      return { ok: true };
    } catch (err) {
      log.warn('Identity unlock failed', { error: String(err) });
      return { ok: false, message: 'That passphrase did not open your key.' };
    }
  }
}
