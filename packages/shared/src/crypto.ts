/**
 * The cryptographic primitives behind end-to-end encryption.
 *
 * What each one protects, and what it does not, is set out in
 * docs/security-model.md — written to be checked against this file.
 *
 * Everything uses WebCrypto (`crypto.subtle`), which is available both in
 * Obsidian's renderer and in Node 22, so this module runs unchanged on both
 * sides. No third-party crypto dependency, deliberately.
 *
 * Key hierarchy:
 *
 *   password ──PBKDF2──▶ masterKey ──┬──▶ authHash   → server (password-equivalent)
 *                                    └──▶ encKey     → never leaves the device
 *                                            │ wraps
 *                                            ▼
 *                                     identityKeyPair (ECDH P-256)
 *                                            │ unwraps
 *                                            ▼
 *                                     folderContentKey (AES-GCM, rotatable)
 *                                     folderNameKey    (HMAC, never rotated)
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** OWASP 2023 guidance for PBKDF2-HMAC-SHA256. */
export const PBKDF2_ITERATIONS = 600_000;

/** AES-GCM standard IV length. Never vary this — GCM is broken by IV reuse. */
const IV_LENGTH = 12;

const SALT_LENGTH = 16;

/**
 * HKDF domain-separation labels. Two keys derived from the same master secret
 * must never be interchangeable, so every derivation gets a distinct label.
 */
const INFO = {
  encKey: 'nectenda:v1:enc-key',
  folderKeyWrap: 'nectenda:v1:folder-key-wrap',
} as const;

// ---------------------------------------------------------------------------
// Encoding helpers
// ---------------------------------------------------------------------------

const enc = new TextEncoder();

export function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

export function fromBase64(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * `crypto.getRandomValues` refuses any request over 65,536 bytes — a spec
 * limit, not an implementation quirk — so fill in chunks.
 */
export function randomBytes(length: number): Uint8Array {
  const out = new Uint8Array(length);
  const MAX = 65_536;
  for (let offset = 0; offset < length; offset += MAX) {
    crypto.getRandomValues(out.subarray(offset, Math.min(offset + MAX, length)));
  }
  return out;
}

/**
 * Constant-time comparison. Use for anything attacker-controlled that is
 * compared against a secret — a plain `===` on strings leaks length and
 * position through timing.
 */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

// ---------------------------------------------------------------------------
// KDF parameters
// ---------------------------------------------------------------------------

/**
 * Stored per user so the KDF can be upgraded (to Argon2id) without invalidating
 * existing accounts. The server keeps this and hands it out before login.
 */
export interface KdfParams {
  algorithm: 'PBKDF2-SHA256';
  iterations: number;
  /** base64 */
  salt: string;
}

export function newKdfParams(iterations = PBKDF2_ITERATIONS): KdfParams {
  return {
    algorithm: 'PBKDF2-SHA256',
    iterations,
    salt: toBase64(randomBytes(SALT_LENGTH)),
  };
}

// ---------------------------------------------------------------------------
// Master key derivation
// ---------------------------------------------------------------------------

/**
 * Derive the master key from the user's password. This is the expensive step;
 * everything else is cheap derivation from its output.
 *
 * The master key itself is never sent anywhere and never stored.
 */
export async function deriveMasterKey(password: string, params: KdfParams): Promise<Uint8Array> {
  if (params.algorithm !== 'PBKDF2-SHA256') {
    throw new Error(`Unsupported KDF algorithm: ${params.algorithm}`);
  }
  const base = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, [
    'deriveBits',
  ]);
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: fromBase64(params.salt) as BufferSource,
      iterations: params.iterations,
      hash: 'SHA-256',
    },
    base,
    256,
  );
  return new Uint8Array(bits);
}

/**
 * The value sent to the server in place of a password.
 *
 * A second, independent derivation from the master key, so the server learns
 * nothing it could use to derive `encKey`. The server must still hash this
 * before storing it — it is password-equivalent for authentication purposes,
 * and a database leak would otherwise let an attacker log in as anyone.
 */
export async function deriveAuthHash(masterKey: Uint8Array, password: string): Promise<string> {
  const base = await crypto.subtle.importKey('raw', masterKey as BufferSource, 'PBKDF2', false, [
    'deriveBits',
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: enc.encode(password) as BufferSource, iterations: 1, hash: 'SHA-256' },
    base,
    256,
  );
  return toBase64(new Uint8Array(bits));
}

/**
 * The key that wraps the identity private key. Stays on the device, always.
 */
export async function deriveEncKey(masterKey: Uint8Array): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', masterKey as BufferSource, 'HKDF', false, [
    'deriveKey',
  ]);
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(0) as BufferSource,
      info: enc.encode(INFO.encKey) as BufferSource,
    },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

// ---------------------------------------------------------------------------
// Symmetric encryption (document updates, key wrapping)
// ---------------------------------------------------------------------------

/**
 * IV is prepended rather than carried separately, so a ciphertext is one blob
 * the server can store without understanding its shape.
 *
 * Overhead is 28 bytes: 12-byte IV + 16-byte GCM tag.
 */
export async function encrypt(key: CryptoKey, plaintext: Uint8Array): Promise<Uint8Array> {
  const iv = randomBytes(IV_LENGTH);
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv as BufferSource },
    key,
    plaintext as BufferSource,
  );
  const out = new Uint8Array(IV_LENGTH + ct.byteLength);
  out.set(iv, 0);
  out.set(new Uint8Array(ct), IV_LENGTH);
  return out;
}

export async function decrypt(key: CryptoKey, blob: Uint8Array): Promise<Uint8Array> {
  if (blob.length < IV_LENGTH + 16) {
    throw new Error('Ciphertext too short to be valid');
  }
  const iv = blob.subarray(0, IV_LENGTH);
  const ct = blob.subarray(IV_LENGTH);
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: iv as BufferSource },
    key,
    ct as BufferSource,
  );
  return new Uint8Array(pt);
}

export async function generateFolderContentKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, [
    'encrypt',
    'decrypt',
  ]);
}

export async function exportRawKey(key: CryptoKey): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.exportKey('raw', key));
}

export async function importContentKey(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', raw as BufferSource, { name: 'AES-GCM' }, true, [
    'encrypt',
    'decrypt',
  ]);
}

// ---------------------------------------------------------------------------
// Identity keypair (ECDH P-256)
// ---------------------------------------------------------------------------

export interface ExportedIdentity {
  /** base64 SPKI */
  publicKey: string;
  /** base64 of the AES-GCM blob wrapping the PKCS8 private key */
  wrappedPrivateKey: string;
}

export async function generateIdentityKeyPair(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
}

/**
 * Wrap an identity keypair for storage on the server. Only the private half is
 * encrypted; the public half is meant to be readable by everyone.
 */
export async function exportIdentity(
  keyPair: CryptoKeyPair,
  encKey: CryptoKey,
): Promise<ExportedIdentity> {
  const spki = new Uint8Array(await crypto.subtle.exportKey('spki', keyPair.publicKey));
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', keyPair.privateKey));
  return {
    publicKey: toBase64(spki),
    wrappedPrivateKey: toBase64(await encrypt(encKey, pkcs8)),
  };
}

export async function importIdentity(
  exported: ExportedIdentity,
  encKey: CryptoKey,
): Promise<CryptoKeyPair> {
  const pkcs8 = await decrypt(encKey, fromBase64(exported.wrappedPrivateKey));
  return importIdentityFromPkcs8(pkcs8, exported.publicKey);
}

/**
 * Rebuild the keypair from an already-unwrapped private key.
 *
 * Split out of `importIdentity` for the device cache, which holds the PKCS8
 * directly rather than a blob sealed under `encKey` — so there is nothing to
 * decrypt and no master key in reach. The public half is not derivable from an
 * ECDH private key through WebCrypto, so it is carried alongside and passed in.
 */
export async function importIdentityFromPkcs8(
  pkcs8: Uint8Array,
  publicKeySpki: string,
): Promise<CryptoKeyPair> {
  const publicKey = await importPublicKey(publicKeySpki);
  const privateKey = await crypto.subtle.importKey(
    'pkcs8',
    pkcs8 as BufferSource,
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveBits'],
  );
  return { publicKey, privateKey };
}

/**
 * Does this private key actually belong to this public key?
 *
 * Unwrapping the stored blob proves the *passphrase* — a wrong one derives a
 * wrong `encKey` and AES-GCM fails its tag. It proves nothing about the two
 * halves belonging together, because they are imported independently: the
 * public half cannot be derived from an ECDH private key through WebCrypto, so
 * it is carried alongside and taken on trust.
 *
 * This closes that. ECDH is symmetric and the salt and info are bound
 * identically on both sides, so a wrap to the public key opens with the private
 * key only if the pair is real; a mismatch derives a different AES key and
 * fails the tag rather than returning garbage.
 *
 * Worth the round trip because the alternative is finding out at the first
 * folder open, where `unwrapFolderKeys` logs and continues and the folder shows
 * as "Locked" — indistinguishable from nobody having shared a key. Measured at
 * well under a millisecond, beside a PBKDF2 that takes roughly forty.
 */
export async function identityPairs(keyPair: CryptoKeyPair): Promise<boolean> {
  const probe = randomBytes(16);
  try {
    const back = await unwrapSecret(await wrapSecret(probe, keyPair.publicKey), keyPair.privateKey);
    // The catch below is what actually rejects a mismatch: AES-GCM is
    // authenticated, so a wrong key fails its tag rather than returning
    // different bytes, and this comparison cannot fire today. It stays as the
    // backstop if the wrap format ever changes to something unauthenticated —
    // at which point silently returning true would be the dangerous answer.
    return timingSafeEqual(probe, back);
  } catch {
    return false;
  }
}

export async function importPublicKey(base64Spki: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'spki',
    fromBase64(base64Spki) as BufferSource,
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    [],
  );
}

/**
 * Short fingerprint of a public key, for out-of-band verification between
 * collaborators.
 *
 * Without someone actually comparing these, the guarantee is only against a
 * passive server operator: an active one could substitute its own public key
 * for a collaborator's and read everything. This is the same mechanism as
 * Signal's safety numbers, and carries the same caveat — it only works if
 * somebody checks. See "The attack this does not stop by itself" in
 * docs/security-model.md.
 */
export async function publicKeyFingerprint(base64Spki: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', fromBase64(base64Spki) as BufferSource);
  const hex = toHex(new Uint8Array(digest).subarray(0, 10));
  return (hex.match(/.{4}/g) ?? []).join('-');
}

// ---------------------------------------------------------------------------
// Folder key wrapping (ECIES over P-256)
// ---------------------------------------------------------------------------

export interface WrappedFolderKey {
  /** base64 SPKI of the ephemeral public key used for this wrap */
  epk: string;
  /** base64 of the AES-GCM blob */
  blob: string;
}

async function eciesWrappingKey(
  privateKey: CryptoKey,
  publicKey: CryptoKey,
  epkSpki: Uint8Array,
  usage: 'encrypt' | 'decrypt',
): Promise<CryptoKey> {
  const shared = await crypto.subtle.deriveBits(
    { name: 'ECDH', public: publicKey },
    privateKey,
    256,
  );
  const base = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      // Binding the ephemeral public key in as the salt stops a wrap being
      // replayed against a different recipient.
      salt: epkSpki as BufferSource,
      info: enc.encode(INFO.folderKeyWrap) as BufferSource,
    },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    [usage],
  );
}

/**
 * Wrap a folder key for one member.
 *
 * Uses a fresh ephemeral keypair per wrap, so the granter's own identity key is
 * not needed to unwrap. That means any member with grant rights can add another
 * member without the original owner being online.
 */
/**
 * Seal arbitrary bytes to a member's public key.
 *
 * Bytes rather than a CryptoKey because not every folder secret can be
 * exported: the name key is imported non-extractable for HMAC, so its raw
 * material has to be carried and wrapped directly.
 */
export async function wrapSecret(
  raw: Uint8Array,
  recipientPublicKey: CryptoKey,
): Promise<WrappedFolderKey> {
  const ephemeral = await generateIdentityKeyPair();
  const epkSpki = new Uint8Array(await crypto.subtle.exportKey('spki', ephemeral.publicKey));
  const wrappingKey = await eciesWrappingKey(
    ephemeral.privateKey,
    recipientPublicKey,
    epkSpki,
    'encrypt',
  );
  return { epk: toBase64(epkSpki), blob: toBase64(await encrypt(wrappingKey, raw)) };
}

export async function unwrapSecret(
  wrapped: WrappedFolderKey,
  recipientPrivateKey: CryptoKey,
): Promise<Uint8Array> {
  const epkSpki = fromBase64(wrapped.epk);
  const ephemeralPublic = await importPublicKey(wrapped.epk);
  const wrappingKey = await eciesWrappingKey(
    recipientPrivateKey,
    ephemeralPublic,
    epkSpki,
    'decrypt',
  );
  return decrypt(wrappingKey, fromBase64(wrapped.blob));
}

export async function wrapFolderKey(
  folderKey: CryptoKey,
  recipientPublicKey: CryptoKey,
): Promise<WrappedFolderKey> {
  return wrapSecret(await exportRawKey(folderKey), recipientPublicKey);
}

export async function unwrapFolderKey(
  wrapped: WrappedFolderKey,
  recipientPrivateKey: CryptoKey,
): Promise<CryptoKey> {
  return importContentKey(await unwrapSecret(wrapped, recipientPrivateKey));
}

// ---------------------------------------------------------------------------
// Document ids
// ---------------------------------------------------------------------------

/**
 * The folder's name key. Derived separately from content keys and never
 * rotated, so rotating a content key does not rewrite every document id in the
 * server's log.
 */
export async function importNameKey(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    raw as BufferSource,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
}

export async function generateNameKeyMaterial(): Promise<Uint8Array> {
  return randomBytes(32);
}

/**
 * Opaque, stable document id derived from a vault-relative path.
 *
 * Replaces `fileDocName()`, which produced `{folderId}/{relativePath}` and so
 * handed the server the entire folder structure. Deterministic, so every client
 * derives the same id independently with no coordination and no bootstrap round
 * trip, and irreversible without the name key.
 */
export const DOC_ID_BYTES = 16;

export async function deriveDocId(
  nameKey: CryptoKey,
  relativePath: string,
  bytes: number = DOC_ID_BYTES,
): Promise<string> {
  // No `as BufferSource` here, unlike the calls that pass `fromBase64(...)`:
  // TextEncoder.encode returns Uint8Array<ArrayBuffer>, which subtle.sign
  // accepts as-is, while fromBase64 yields Uint8Array<ArrayBufferLike>, which
  // genuinely is not assignable. The casts elsewhere in this file are not the
  // same cast and should stay.
  const mac = await crypto.subtle.sign('HMAC', nameKey, enc.encode(relativePath));
  // Truncated to 16 bytes by default. A full 32-byte id makes every document
  // name about 101 bytes, on every push and every fan-out — nearly four times
  // the 28-byte AES-GCM overhead this design works to avoid. A collision within
  // one folder is around 2^-64, and would merge two documents rather than leak
  // anything.
  return toHex(new Uint8Array(mac).slice(0, bytes));
}

// ---------------------------------------------------------------------------
// Recovery key
// ---------------------------------------------------------------------------

/** Crockford base32 — no I, L, O or U, so it cannot be misread or misheard. */
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * A high-entropy code shown once at registration, which independently wraps the
 * master key.
 *
 * Without this, a forgotten password is unrecoverable data loss that no admin
 * can fix — that is the direct consequence of the server holding no readable
 * copy of anything.
 *
 * **20 bytes in, 100 bits out, not 160.** Each byte is reduced to one base32
 * character, so 3 of its 8 bits are discarded. That is deliberate — 20 readable
 * characters is what a person will actually write down, and 100 bits is far
 * past brute force — but the arithmetic is not what `randomBytes(20)` suggests,
 * so do not "fix" the length without redoing it. The modulo is unbiased because
 * 256 is a multiple of 32.
 */
export function generateRecoveryKey(): string {
  const bytes = randomBytes(20);
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += CROCKFORD[bytes[i] % 32];
    if (i % 4 === 3 && i !== bytes.length - 1) out += '-';
  }
  return out;
}

export function normaliseRecoveryKey(input: string): string {
  return input
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/I|L/g, '1')
    .replace(/O/g, '0')
    .replace(/U/g, 'V');
}

/**
 * Wrap the master key under the recovery key, so it can be restored on a device
 * that has never seen the password.
 */
export async function wrapMasterKeyWithRecovery(
  masterKey: Uint8Array,
  recoveryKey: string,
): Promise<{ blob: string; params: KdfParams }> {
  const params = newKdfParams();
  const derived = await deriveMasterKey(normaliseRecoveryKey(recoveryKey), params);
  const key = await crypto.subtle.importKey('raw', derived as BufferSource, { name: 'AES-GCM' }, false, [
    'encrypt',
  ]);
  return { blob: toBase64(await encrypt(key, masterKey)), params };
}

export async function unwrapMasterKeyWithRecovery(
  blob: string,
  recoveryKey: string,
  params: KdfParams,
): Promise<Uint8Array> {
  const derived = await deriveMasterKey(normaliseRecoveryKey(recoveryKey), params);
  const key = await crypto.subtle.importKey('raw', derived as BufferSource, { name: 'AES-GCM' }, false, [
    'decrypt',
  ]);
  return decrypt(key, fromBase64(blob));
}
