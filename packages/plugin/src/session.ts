import {
  apiBaseUrl,
  newKdfParams,
  deriveMasterKey,
  deriveAuthHash,
  deriveEncKey,
  generateIdentityKeyPair,
  exportIdentity,
  importIdentity,
  generateRecoveryKey,
  normaliseRecoveryKey,
  wrapMasterKeyWithRecovery,
  unwrapMasterKeyWithRecovery,
} from '@nectenda/shared';
import type {
  AuthResponse,
  KdfParams,
  KdfParamsResponse,
  KeyMaterial,
  UserInfo,
} from '@nectenda/shared';
import { log } from './logger';
import type { IdentityClient, DeviceFields as IdentityDeviceFields } from './identity-client';
import type { SignInResult } from './auth-flow';
import { serverFetch } from './client-version.js';

/**
 * Everything derived from the user's password for this session.
 *
 * `identity` is the ECDH keypair that unwraps folder keys, unwrapped in memory
 * for the session. `masterKey` is **not** persisted anywhere — it once was, and
 * that is exactly what `docs/key-storage.md` records removing, because it
 * unwraps the identity key with no password and so reaches every folder ever
 * shared with the account rather than only the notes already on disk.
 *
 * Nothing after the unlock reads `masterKey`; every consumer wants `identity`.
 * It is optional for exactly that reason: a session restored from the device
 * store has an identity and no master key, and that is a complete session
 * rather than a degraded one. Faking an empty array to satisfy the type would
 * hide the fact.
 *
 * The keypair is no longer memory-only. Where the OS provides a credential
 * store it is held for the device, so the passphrase is asked once per machine
 * rather than once per vault — see docs/key-storage.md.
 */
export interface SessionKeys {
  masterKey?: Uint8Array;
  identity: CryptoKeyPair;
}

export interface SessionResult {
  token: string;
  user: UserInfo;
  keys: SessionKeys;
  /** Persisted so a later restore can unwrap the identity without the password. */
  keyMaterial: KeyMaterial;
  /** Set only on registration or first enrolment — show it once, then discard. */
  recoveryKey?: string;
}

class AuthError extends Error {}

async function readError(res: Response, fallback: string): Promise<string> {
  try {
    return ((await res.json()) as { error?: string }).error ?? fallback;
  } catch {
    return fallback;
  }
}

async function fetchKdfParams(base: string, username: string): Promise<KdfParams> {
  const res = await serverFetch(`${base}/auth/kdf-params?username=${encodeURIComponent(username)}`);
  if (!res.ok) throw new AuthError(await readError(res, 'Could not fetch login parameters'));
  return ((await res.json()) as KdfParamsResponse).kdfParams;
}

/**
 * Proof-of-possession for a recovery key, in the same shape as `authHash` is for
 * a password.
 *
 * Derived from the recovery key **alone**, deliberately: it lets the server
 * verify a caller *before* disclosing the encrypted blob. Deriving it from the
 * master key the blob contains would invert that — the blob would have to be
 * handed out first, and an encrypted key blob served to anyone who names a
 * username is an offline attack corpus covering every account on the server.
 */
export async function deriveRecoveryAuthHash(recoveryKey: string, params: KdfParams): Promise<string> {
  const normalised = normaliseRecoveryKey(recoveryKey);
  return deriveAuthHash(await deriveMasterKey(normalised, params), normalised);
}

async function fetchRecoveryParams(base: string, username: string): Promise<KdfParams> {
  const res = await serverFetch(`${base}/auth/recovery-params?username=${encodeURIComponent(username)}`);
  if (!res.ok) throw new AuthError(await readError(res, 'Could not fetch recovery parameters'));
  return ((await res.json()) as { recoveryParams: KdfParams }).recoveryParams;
}

/**
 * Build the key material a new account needs: an identity keypair wrapped under
 * the password-derived key, plus the master key wrapped under a fresh recovery
 * key so a forgotten password is survivable.
 */
export async function buildKeyMaterial(masterKey: Uint8Array): Promise<{
  material: {
    publicKey: string;
    wrappedPrivateKey: string;
    recoveryBlob: string;
    recoveryParams: KdfParams;
    recoveryAuthHash: string;
  };
  identity: CryptoKeyPair;
  recoveryKey: string;
}> {
  const encKey = await deriveEncKey(masterKey);
  const keyPair = await generateIdentityKeyPair();
  const exported = await exportIdentity(keyPair, encKey);

  const recoveryKey = generateRecoveryKey();
  const recovery = await wrapMasterKeyWithRecovery(masterKey, recoveryKey);

  return {
    material: {
      publicKey: exported.publicKey,
      wrappedPrivateKey: exported.wrappedPrivateKey,
      recoveryBlob: recovery.blob,
      recoveryParams: recovery.params,
      recoveryAuthHash: await deriveRecoveryAuthHash(recoveryKey, recovery.params),
    },
    // Re-import so the caller holds a keypair that round-tripped through the
    // same wrap the server stored — if that path is broken, fail now at
    // registration rather than silently at first decrypt.
    identity: await importIdentity(exported, encKey),
    recoveryKey,
  };
}

export async function unlockIdentity(
  masterKey: Uint8Array,
  keyMaterial: KeyMaterial,
): Promise<CryptoKeyPair> {
  if (!keyMaterial.publicKey || !keyMaterial.wrappedPrivateKey) {
    throw new AuthError('Account has no encryption keys enrolled');
  }
  const encKey = await deriveEncKey(masterKey);
  return importIdentity(
    { publicKey: keyMaterial.publicKey, wrappedPrivateKey: keyMaterial.wrappedPrivateKey },
    encKey,
  );
}

/**
 * Enrol keys for an account that has none — currently only the seeded admin,
 * whose keypair is deliberately not generated on the server.
 */
async function enrollKeys(
  base: string,
  token: string,
  masterKey: Uint8Array,
): Promise<{ identity: CryptoKeyPair; recoveryKey: string; keyMaterial: KeyMaterial }> {
  const built = await buildKeyMaterial(masterKey);
  const res = await serverFetch(`${base}/auth/enroll-keys`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(built.material),
  });
  if (!res.ok) throw new AuthError(await readError(res, 'Could not enrol encryption keys'));
  log.info('Enrolled encryption keys for this account');
  return { identity: built.identity, recoveryKey: built.recoveryKey, keyMaterial: built.material };
}

/**
 * Optional because a client that cannot mint a device id must still be able to
 * sign in — the server counts it as one unnamed device rather than refusing.
 */
export interface DeviceFields {
  deviceId?: string;
  deviceLabel?: string;
  devicePlatform?: string;
}

export async function login(
  serverUrl: string,
  username: string,
  password: string,
  device?: DeviceFields,
): Promise<SessionResult> {
  const base = apiBaseUrl(serverUrl);

  // Two round trips: the client cannot derive anything until it knows the
  // account's KDF parameters. Unknown usernames get decoys, so this reveals
  // nothing about whether the account exists.
  const kdfParams = await fetchKdfParams(base, username);
  const masterKey = await deriveMasterKey(password, kdfParams);
  const authHash = await deriveAuthHash(masterKey, password);

  const res = await serverFetch(`${base}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, authHash, ...device }),
  });
  if (!res.ok) throw new AuthError(await readError(res, 'Invalid credentials'));

  const data = (await res.json()) as AuthResponse;

  if (!data.keyMaterial.publicKey) {
    const enrolled = await enrollKeys(base, data.token, masterKey);
    return {
      token: data.token,
      user: data.user,
      keys: { masterKey, identity: enrolled.identity },
      keyMaterial: enrolled.keyMaterial,
      recoveryKey: enrolled.recoveryKey,
    };
  }

  return {
    token: data.token,
    user: data.user,
    keys: { masterKey, identity: await unlockIdentity(masterKey, data.keyMaterial) },
    keyMaterial: data.keyMaterial,
  };
}

export async function register(
  serverUrl: string,
  username: string,
  email: string,
  password: string,
  inviteToken: string,
  device?: DeviceFields,
): Promise<SessionResult> {
  const base = apiBaseUrl(serverUrl);

  // The client chooses its own KDF parameters at registration; the server only
  // checks they are not weak enough to be worth refusing.
  const kdfParams = newKdfParams();
  const masterKey = await deriveMasterKey(password, kdfParams);
  const authHash = await deriveAuthHash(masterKey, password);
  const built = await buildKeyMaterial(masterKey);

  const res = await serverFetch(`${base}/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, email, inviteToken, authHash, kdfParams, ...built.material, ...device }),
  });
  if (!res.ok) throw new AuthError(await readError(res, 'Registration failed'));

  const data = (await res.json()) as AuthResponse;
  return {
    token: data.token,
    user: data.user,
    keys: { masterKey, identity: built.identity },
    keyMaterial: { ...built.material, recoveryParams: built.material.recoveryParams },
    recoveryKey: built.recoveryKey,
  };
}

/**
 * The KDF parameters a self-hosted unlock needs, fetched once.
 *
 * Split out from the derivation deliberately. The prompt retries in place, and
 * folding this into every attempt would put one request per keystroke-guess
 * against `kdfParamsLimiter` (60 per 15 minutes per IP) — so somebody mistyping
 * their passphrase a few times too many would start getting 429s on a call that
 * verifies nothing. The server returns the same salt and iteration count
 * whatever is typed; it never sees the passphrase, so there is nothing here to
 * re-ask.
 *
 * The hosted service needs no equivalent: its parameters travel in
 * `CloudKeyMaterial.kdfParams` and are already on disk.
 */
export async function fetchUnlockParams(serverUrl: string, username: string): Promise<KdfParams> {
  return fetchKdfParams(apiBaseUrl(serverUrl), username);
}

/**
 * Re-derive the identity keypair from the password, given parameters already in
 * hand.
 *
 * The master key is deliberately not stored, so this is the only way back to
 * the identity key within a session that did not begin with a login. It costs a
 * full KDF — 600k PBKDF2-SHA256 iterations, measured at ~40ms on an M-series
 * Mac and slower on weaker hardware — which is why folders already mapped keep
 * working from their cached folder keys and never reach it.
 *
 * That cost is *not* a brute-force control. `data.json` carries the salt, the
 * iteration count and the wrapped key, so an attacker who has the file grinds
 * offline at whatever rate their hardware allows and never opens the prompt.
 * See docs/key-storage.md.
 *
 * See the same document for why storing the master key was worse: it unwraps
 * the identity key with no password, and so yields every folder ever shared
 * with the account, including ones this vault has never opened.
 */
export async function unlockWith(
  kdfParams: KdfParams,
  password: string,
  keyMaterial: KeyMaterial,
): Promise<SessionKeys> {
  const masterKey = await deriveMasterKey(password, kdfParams);
  return { masterKey, identity: await unlockIdentity(masterKey, keyMaterial) };
}

/**
 * Recover a forgotten password with the recovery key, and set a new one.
 *
 * The whole flow, because half of it is not useful: recovering the master key
 * alone cannot log anybody in. `authHash` is salted with the password itself
 * (`deriveAuthHash`), so the old one can never be re-derived, and the master key
 * is *derived from* the password — a new password therefore means a new master
 * key, a re-wrapped private key and a fresh recovery blob.
 *
 * The identity **keypair is reused, not regenerated**. Folder keys are ECIES
 * wrapped to its public key, so regenerating it here would silently cost the
 * user every folder ever shared with them. That is the property this function
 * exists to preserve.
 */
export async function recoverAndReset(
  serverUrl: string,
  username: string,
  recoveryKey: string,
  newPassword: string,
  device?: DeviceFields,
): Promise<SessionResult> {
  const base = apiBaseUrl(serverUrl);

  // Prove first. The server hands back nothing — not the blob, not the wrapped
  // private key — until this is accepted.
  const recoveryParams = await fetchRecoveryParams(base, username);
  const recoveryAuthHash = await deriveRecoveryAuthHash(recoveryKey, recoveryParams);

  const res = await serverFetch(`${base}/auth/recover`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, recoveryAuthHash }),
  });
  if (!res.ok) throw new AuthError(await readError(res, 'Recovery key not accepted'));
  const data = (await res.json()) as AuthResponse;

  if (!data.keyMaterial.recoveryBlob || !data.keyMaterial.recoveryParams) {
    throw new AuthError('This account has no recovery key on file');
  }

  // A wrong key that somehow passed the verifier still fails here, because the
  // blob is AEAD-sealed under it.
  const oldMasterKey = await unwrapMasterKeyWithRecovery(
    data.keyMaterial.recoveryBlob,
    recoveryKey,
    data.keyMaterial.recoveryParams,
  );
  const identity = await unlockIdentity(oldMasterKey, data.keyMaterial);

  // Everything password-derived is replaced; the keypair above is not.
  const kdfParams = newKdfParams();
  const masterKey = await deriveMasterKey(newPassword, kdfParams);
  const authHash = await deriveAuthHash(masterKey, newPassword);
  const encKey = await deriveEncKey(masterKey);
  const exported = await exportIdentity(identity, encKey);

  const nextRecoveryKey = generateRecoveryKey();
  const recovery = await wrapMasterKeyWithRecovery(masterKey, nextRecoveryKey);

  const put = await serverFetch(`${base}/auth/credentials`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${data.token}` },
    body: JSON.stringify({
      kdfParams,
      authHash,
      wrappedPrivateKey: exported.wrappedPrivateKey,
      recoveryBlob: recovery.blob,
      recoveryParams: recovery.params,
      recoveryAuthHash: await deriveRecoveryAuthHash(nextRecoveryKey, recovery.params),
    }),
  });
  if (!put.ok) throw new AuthError(await readError(put, 'Could not set the new password'));

  log.info('Recovered account and replaced credentials', { username });

  // Log in properly so the session, device record and token match the new
  // credentials rather than the recovery-issued ones.
  return login(serverUrl, username, newPassword, device);
}




// ---------------------------------------------------------------------------
// Nectenda Cloud
//
// On the hosted service the passphrase is local-only, always. It derives the
// master key that wraps the identity keypair and nothing else: no
// authentication hash is ever derived from it, and nothing derived from it is
// sent anywhere. Identity is proved separately, at accounts.nectenda.com. The
// key material itself lives there rather than on a sync server because one
// person may belong to organisations on several servers and has one keypair.
// ---------------------------------------------------------------------------

/** What the identity service stores about a person's keys. */
export interface CloudKeyMaterial extends KeyMaterial {
  kdfParams: KdfParams | null;
}

/**
 * First device: choose the passphrase, generate the keypair, enrol the wrapped
 * material. The recovery key is shown once by the caller and never stored.
 */
export async function cloudSetPassphrase(
  client: IdentityClient,
  accessToken: string,
  password: string,
): Promise<{ keys: SessionKeys; keyMaterial: CloudKeyMaterial; recoveryKey: string }> {
  const kdfParams = newKdfParams();
  const masterKey = await deriveMasterKey(password, kdfParams);
  const built = await buildKeyMaterial(masterKey);
  await client.enrolKeys(accessToken, { kdfParams, ...built.material });
  log.info('Enrolled encryption keys on the identity service');
  return {
    keys: { masterKey, identity: built.identity },
    keyMaterial: { ...built.material, kdfParams },
    recoveryKey: built.recoveryKey,
  };
}

/**
 * Any later device: the passphrase unwraps the keypair the identity holds.
 *
 * Entirely local. The parameters are already in `keyMaterial`, so a wrong
 * passphrase is answered by AES-GCM failing its tag here rather than by any
 * server — nothing derived from it is ever sent, which is why retrying costs no
 * round trip and why no server-side limiter sees an attempt.
 */
export async function cloudUnlock(password: string, keyMaterial: CloudKeyMaterial): Promise<SessionKeys> {
  if (!keyMaterial.kdfParams) throw new AuthError('This account has no encryption keys enrolled yet');
  return unlockWith(keyMaterial.kdfParams, password, keyMaterial);
}

/**
 * Change the passphrase on the hosted service: the keypair is kept, re-wrapped
 * under the new master key, with a fresh recovery blob. Same shape as
 * `recoverAndReset`, for the same reason — regenerating the keypair would cost
 * every folder ever shared with the person.
 */
export async function cloudRewrap(
  client: IdentityClient,
  accessToken: string,
  identity: CryptoKeyPair,
  newPassword: string,
): Promise<{ keys: SessionKeys; keyMaterial: CloudKeyMaterial; recoveryKey: string }> {
  const kdfParams = newKdfParams();
  const masterKey = await deriveMasterKey(newPassword, kdfParams);
  const encKey = await deriveEncKey(masterKey);
  const exported = await exportIdentity(identity, encKey);
  const recoveryKey = generateRecoveryKey();
  const recovery = await wrapMasterKeyWithRecovery(masterKey, recoveryKey);
  const material = {
    kdfParams,
    wrappedPrivateKey: exported.wrappedPrivateKey,
    recoveryBlob: recovery.blob,
    recoveryParams: recovery.params,
    recoveryAuthHash: await deriveRecoveryAuthHash(recoveryKey, recovery.params),
  };
  await client.replaceKeys(accessToken, material);
  return {
    keys: { masterKey, identity },
    keyMaterial: { ...material, publicKey: exported.publicKey },
    recoveryKey,
  };
}

/**
 * Recover a hosted account with the recovery key and set a new passphrase.
 *
 * Proof first, exactly as on a self-hosted server: the identity service hands
 * back nothing until the derived proof is accepted. The sign-in result it then
 * returns is a full session, so recovery also signs the device in.
 */
export async function cloudRecover(
  client: IdentityClient,
  email: string,
  recoveryKey: string,
  newPassword: string,
  device: IdentityDeviceFields,
): Promise<{ result: SignInResult; keys: SessionKeys; keyMaterial: CloudKeyMaterial; recoveryKey: string }> {
  const { recoveryParams } = await client.recoverParams(email);
  const proof = await deriveRecoveryAuthHash(recoveryKey, recoveryParams as KdfParams);
  const result = await client.recover(email, proof, device);
  const km = result.keyMaterial;
  if (!km.recoveryBlob || !km.recoveryParams || !km.publicKey || !km.wrappedPrivateKey) {
    throw new AuthError('This account has no recovery material');
  }
  const oldMaster = await unwrapMasterKeyWithRecovery(km.recoveryBlob, normaliseRecoveryKey(recoveryKey), km.recoveryParams as KdfParams);
  const identity = await unlockIdentity(oldMaster, km as KeyMaterial);
  const rewrapped = await cloudRewrap(client, result.accessToken, identity, newPassword);
  return { result, ...rewrapped };
}
