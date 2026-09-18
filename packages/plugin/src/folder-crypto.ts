import {
  MAX_FOLDER_NAME_LENGTH,
  fromBase64,
  generateFolderContentKey,
  generateNameKeyMaterial,
  exportRawKey,
  importContentKey,
  importNameKey,
  importPublicKey,
  toBase64,
  unwrapSecret,
  wrapSecret,
  type WrappedFolderKey,
} from '@nectenda/shared';
import { decrypt, encrypt } from '@nectenda/shared';
import type { DocCipher } from './multiplexed-provider';
import { log } from './logger';

/**
 * The keys for one shared folder, unwrapped and ready to use.
 *
 * Content keys are held by generation, not just the current one: rotating a key
 * does not re-encrypt the log, so updates written under an older generation stay
 * readable only while their key is still here.
 *
 * The name key is separate and never rotated. Rotating it would change every
 * document id in the log at once, which is a migration, not a key change.
 */
export interface FolderKeys {
  folderId: string;
  nameKey: CryptoKey;
  /** Raw material, because an HMAC key cannot be exported once imported. */
  nameKeyRaw: Uint8Array;
  contentKeys: Map<string, CryptoKey>;
  currentKeyId: string;
}

/** The shape cached in data.json, and the only thing written to disk. */
export interface StoredFolderKeys {
  nameKey: string;
  currentKeyId: string;
  contentKeys: Record<string, string>;
}

/** One wrapped key as the server stores and returns it. */
export interface FolderKeyRecord {
  folderId: string;
  userId: string;
  kind: 'content' | 'name';
  keyId: string;
  epk: string;
  blob: string;
}

/** Generate the keys for a brand new folder. */
export async function createFolderKeys(folderId: string): Promise<FolderKeys> {
  const contentKey = await generateFolderContentKey();
  const nameKeyRaw = await generateNameKeyMaterial();
  return {
    folderId,
    nameKey: await importNameKey(nameKeyRaw),
    nameKeyRaw,
    contentKeys: new Map([['v1', contentKey]]),
    currentKeyId: 'v1',
  };
}

/**
 * Seal a folder's display name under its current content key.
 *
 * A folder called "Redundancy consultation — legal" told the server as much as
 * the notes inside it would have. Document *paths* have been HMACs since
 * Phase 7; the folder's own label was the one thing left in the clear, and it
 * was the most descriptive thing there.
 *
 * Sealed under the content key rather than the name key because an HMAC key
 * cannot encrypt, and keyed by generation so a rotation does not orphan it.
 */
export async function sealFolderName(
  keys: FolderKeys,
  name: string,
): Promise<{ name: string; nameKeyId: string }> {
  // Checked here because this is the last place the plaintext exists. The
  // server receives ciphertext and cannot apply either rule to it.
  if (!name || name.length > MAX_FOLDER_NAME_LENGTH || /[/\\]/.test(name)) {
    throw new Error(`Folder name must be 1-${MAX_FOLDER_NAME_LENGTH} characters with no path separators`);
  }
  const key = keys.contentKeys.get(keys.currentKeyId);
  if (!key) throw new Error(`No content key for generation ${keys.currentKeyId}`);
  const sealed = await encrypt(key, new TextEncoder().encode(name));
  return { name: toBase64(sealed), nameKeyId: keys.currentKeyId };
}

/**
 * Read a folder's display name back, or null when it cannot be read.
 *
 * Null rather than a throw or a placeholder string: the caller has to decide
 * what to show, and a folder whose keys this device does not hold is a normal
 * state — it is what every folder looks like before an invitation is accepted.
 */
export async function openFolderName(
  keys: FolderKeys | null | undefined,
  folder: { name: string; nameKeyId: string },
): Promise<string | null> {
  if (!keys) return null;
  const key = keys.contentKeys.get(folder.nameKeyId);
  if (!key) return null;
  try {
    return new TextDecoder().decode(await decrypt(key, fromBase64(folder.name)));
  } catch (err) {
    log.warn('Could not open a folder name', { nameKeyId: folder.nameKeyId, error: String(err) });
    return null;
  }
}

/** Seal a folder's keys to one member, ready to POST. */
export async function wrapKeysFor(
  keys: FolderKeys,
  recipientUserId: string,
  recipientPublicKeyB64: string,
): Promise<Omit<FolderKeyRecord, 'folderId'>[]> {
  const publicKey = await importPublicKey(recipientPublicKeyB64);
  const out: Omit<FolderKeyRecord, 'folderId'>[] = [];

  const name: WrappedFolderKey = await wrapSecret(keys.nameKeyRaw, publicKey);
  out.push({ userId: recipientUserId, kind: 'name', keyId: 'v1', ...name });

  for (const [keyId, key] of keys.contentKeys) {
    const wrapped = await wrapSecret(await exportRawKey(key), publicKey);
    out.push({ userId: recipientUserId, kind: 'content', keyId, ...wrapped });
  }
  return out;
}

/**
 * Unwrap what the server holds for us.
 *
 * Returns null when the folder has no usable keys — a folder someone shared
 * before wrapping a key for us, or one whose wraps were made against a
 * different identity. The caller must treat that as "cannot read this folder"
 * and leave local files alone; it must never be mistaken for an empty folder.
 */
export async function unwrapFolderKeys(
  folderId: string,
  records: FolderKeyRecord[],
  identityPrivateKey: CryptoKey,
): Promise<FolderKeys | null> {
  let nameKeyRaw: Uint8Array | null = null;
  const contentKeys = new Map<string, CryptoKey>();
  let newest = '';

  for (const record of records) {
    try {
      const raw = await unwrapSecret({ epk: record.epk, blob: record.blob }, identityPrivateKey);
      if (record.kind === 'name') {
        nameKeyRaw = raw;
      } else {
        contentKeys.set(record.keyId, await importContentKey(raw));
        // Lexicographic on purpose: generations are v1, v2, … and the newest
        // is the one to encrypt under.
        if (record.keyId > newest) newest = record.keyId;
      }
    } catch (err) {
      // One bad wrap must not discard the rest: an older generation we can no
      // longer unwrap still leaves newer content readable.
      log.warn('Could not unwrap a folder key', {
        folderId,
        kind: record.kind,
        keyId: record.keyId,
        error: String(err),
      });
    }
  }

  if (!nameKeyRaw || contentKeys.size === 0) return null;
  return {
    folderId,
    nameKey: await importNameKey(nameKeyRaw),
    nameKeyRaw,
    contentKeys,
    currentKeyId: newest,
  };
}

export function serialiseFolderKeys(keys: FolderKeys): Promise<StoredFolderKeys> {
  return (async () => {
    const contentKeys: Record<string, string> = {};
    for (const [keyId, key] of keys.contentKeys) {
      contentKeys[keyId] = toBase64(await exportRawKey(key));
    }
    return {
      nameKey: toBase64(keys.nameKeyRaw),
      currentKeyId: keys.currentKeyId,
      contentKeys,
    };
  })();
}

export async function deserialiseFolderKeys(
  folderId: string,
  stored: StoredFolderKeys,
): Promise<FolderKeys> {
  const contentKeys = new Map<string, CryptoKey>();
  for (const [keyId, raw] of Object.entries(stored.contentKeys)) {
    contentKeys.set(keyId, await importContentKey(fromBase64(raw)));
  }
  const nameKeyRaw = fromBase64(stored.nameKey);
  return {
    folderId,
    nameKey: await importNameKey(nameKeyRaw),
    nameKeyRaw,
    contentKeys,
    currentKeyId: stored.currentKeyId,
  };
}

/**
 * Every folder's keys, looked up by the folder id embedded in a document name.
 *
 * Document names are `{folderId}/{...}` and the folder id stays in clear so the
 * server can authorise and partition; this reads it the same way the server
 * does.
 */
export class FolderCryptoRegistry implements DocCipher {
  private byFolder = new Map<string, FolderKeys>();

  add(keys: FolderKeys): void {
    this.byFolder.set(keys.folderId, keys);
  }

  remove(folderId: string): void {
    this.byFolder.delete(folderId);
  }

  get(folderId: string): FolderKeys | null {
    return this.byFolder.get(folderId) ?? null;
  }

  forDoc(docName: string): FolderKeys | null {
    const slash = docName.indexOf('/');
    if (slash <= 0) return null;
    return this.get(docName.slice(0, slash));
  }

  hasKeys(folderId: string): boolean {
    return this.byFolder.has(folderId);
  }

  /**
   * Seal a payload under the folder's current content key.
   *
   * Throws when the folder has no keys rather than sending plaintext. Silently
   * falling back would put readable notes on a server the whole design exists
   * to keep them from, and would do it invisibly.
   */
  async encryptPayload(
    docName: string,
    plaintext: Uint8Array,
  ): Promise<{ payload: Uint8Array; keyId: string }> {
    const keys = this.forDoc(docName);
    if (!keys) throw new Error(`No encryption key for ${docName}`);
    const key = keys.contentKeys.get(keys.currentKeyId);
    if (!key) throw new Error(`No current content key for ${docName}`);
    return { payload: await encrypt(key, plaintext), keyId: keys.currentKeyId };
  }

  /**
   * Open a payload under the generation it was written with.
   *
   * An empty keyId is a payload from before encryption existed. Those are
   * refused rather than passed through: the no-migration decision means such
   * documents are re-shared, and quietly accepting plaintext would leave no
   * signal that a folder had never been encrypted at all.
   */
  async decryptPayload(docName: string, payload: Uint8Array, keyId: string): Promise<Uint8Array> {
    const keys = this.forDoc(docName);
    if (!keys) throw new Error(`No decryption key for ${docName}`);
    if (!keyId) throw new Error(`Update for ${docName} predates encryption`);
    const key = keys.contentKeys.get(keyId);
    if (!key) throw new Error(`No key generation ${keyId} for ${docName}`);
    return decrypt(key, payload);
  }
}
