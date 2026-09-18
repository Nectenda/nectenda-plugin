import { log } from './logger';

/**
 * Somewhere to keep a secret that is not the vault.
 *
 * Two stores, for two different questions. `createSecretStore` is vault-scoped
 * on desktop and holds the tokens, the folder keys and the install id, so
 * signing one vault in does not sign in another. `createDeviceStore` is shared
 * by every vault of the installation and holds exactly one thing, the identity
 * key, so the passphrase is asked once per machine.
 *
 * Obsidian gained `app.secretStorage` in 1.11.4, backed by the OS keychain
 * through Electron's safeStorage. `minAppVersion` is above that, so in practice
 * every install Obsidian will let the plugin run on has the API — but it is
 * still chosen at runtime rather than assumed, because the floor is a
 * pre-release decision that may yet be widened and because the API can be
 * present without being usable.
 *
 * What it buys, and what it does not. It removes secrets from a file that a
 * vault sync carries off the device — the realistic exposure, since Obsidian
 * vaults are commonly synced with Dropbox or iCloud. It does **not** isolate
 * them from other plugins: secret ids are global, and a probe of Obsidian
 * 1.13.7 confirmed one plugin can read and enumerate another's. That is by
 * design and no storage choice available to us changes it. See
 * docs/key-storage.md.
 */
export interface SecretStore {
  /** How secrets are being kept, for the settings UI to state plainly. */
  readonly kind: 'keychain' | 'vault-file' | 'device' | 'none';
  get(id: string): string | null;
  set(id: string, value: string): void;
  delete(id: string): void;
}

/** Ids are global across plugins, so ours carry a prefix. */
export const SECRET_IDS = {
  token: 'nectenda-token',
  folderKeys: 'nectenda-folder-keys',
  deviceId: 'nectenda-device-id',
  /** Nectenda Cloud: the long-lived device session and the short-lived access token. */
  refreshToken: 'nectenda-refresh-token',
  identityAccessToken: 'nectenda-identity-access-token',
  /** Nectenda Cloud: one sync-server session per membership, as JSON `{ [membershipId]: token }`. */
  shardTokens: 'nectenda-shard-tokens',
} as const;

/**
 * Prefix for the device-wide identity key, completed with the account's public
 * key fingerprint.
 *
 * Keyed by account rather than fixed, because this store is shared by every
 * vault of the installation and two vaults can be signed into two different
 * accounts — `keyMaterial` lives in per-vault settings. Under one fixed name
 * the second vault would read the first account's private key, fail every
 * unwrap, and the two would overwrite each other. The fingerprint is stable
 * across a passphrase change and a recovery, both of which deliberately keep
 * the keypair, so the cache survives exactly when it should.
 */
export const IDENTITY_KEY_PREFIX = 'nectenda-identity';

interface ObsidianSecretStorage {
  setSecret(id: string, secret: string): void;
  getSecret(id: string): string | null;
  listSecrets(): string[];
  deleteSecret?(id: string): void;
  isEncryptionAvailable?(): boolean;
}

class KeychainStore implements SecretStore {
  readonly kind = 'keychain' as const;
  constructor(private storage: ObsidianSecretStorage) {}

  get(id: string): string | null {
    try {
      return this.storage.getSecret(id);
    } catch (err) {
      log.error('Could not read from the keychain', { id, error: String(err) });
      return null;
    }
  }

  set(id: string, value: string): void {
    this.storage.setSecret(id, value);
  }

  delete(id: string): void {
    // deleteSecret is present in 1.13 but not in the published typings for
    // every version that has setSecret, so it is treated as optional. Writing
    // an empty string is the fallback; get() then yields '' rather than null,
    // which callers already treat as absent.
    if (typeof this.storage.deleteSecret === 'function') this.storage.deleteSecret(id);
    else this.storage.setSecret(id, '');
  }
}

/**
 * The fallback: secrets stay in the plugin's data.json.
 *
 * This is where everything lived before. `minAppVersion` currently rules out
 * the builds that would need it, so it is a guard against a widened floor and
 * against a keychain that is present but unusable, not a path anyone is on
 * today. It is honest rather than good — the file sits in the vault and syncs
 * with it, which is the exposure the keychain exists to close.
 */
class VaultFileStore implements SecretStore {
  readonly kind = 'vault-file' as const;
  constructor(
    private read: () => Record<string, string>,
    private write: (values: Record<string, string>) => void,
  ) {}

  get(id: string): string | null {
    return this.read()[id] ?? null;
  }

  set(id: string, value: string): void {
    this.write({ ...this.read(), [id]: value });
  }

  delete(id: string): void {
    const values = { ...this.read() };
    delete values[id];
    this.write(values);
  }
}

/**
 * Pick a store for this Obsidian.
 *
 * Both conditions matter on desktop: the API can exist while encryption is
 * unavailable, and storing secrets in an unencrypted keychain would be no
 * better than the file while looking better.
 *
 * On mobile the second condition is vacuous and must not be read as a test.
 * `isEncryptionAvailable()` is implemented as
 * `!(adapter instanceof DesktopAdapter) || adapter.isEncryptionAvailable()`,
 * and the mobile adapter is a different class, so it short-circuits to true
 * without checking anything. A phone therefore always takes the keychain
 * branch. Measured, along with what that store actually does there, in
 * docs/key-storage.md.
 */
/**
 * Electron's safeStorage, reached the way Obsidian reaches it.
 *
 * Not imported — read off a host-provided global, so the plugin still pulls in
 * no Node or Electron module and `isDesktopOnly` stays false. Absent on mobile,
 * which is why the choice below is a capability check rather than a platform one.
 */
interface SafeStorage {
  isEncryptionAvailable(): boolean;
  encryptString(plain: string): { toString(encoding: string): string };
  decryptString(cipher: Uint8Array): string;
  /** Linux only. Absent elsewhere, which is not a failure. */
  getSelectedStorageBackend?(): string;
}

function safeStorage(): SafeStorage | null {
  const s = (globalThis as { electron?: { remote?: { safeStorage?: SafeStorage } } })
    .electron?.remote?.safeStorage;
  return s && typeof s.encryptString === 'function' ? s : null;
}

/** Caches nothing, so the passphrase prompt stays. */
class NoStore implements SecretStore {
  readonly kind = 'none' as const;
  get(): string | null { return null; }
  set(): void { /* deliberately nothing */ }
  delete(): void { /* deliberately nothing */ }
}

/**
 * A slot every vault of this installation shares.
 *
 * Obsidian's own secrets are `safeStorage` ciphertext written through
 * `app.saveLocalStorage`, which prefixes the key with the vault id — that
 * prefix is the whole of the per-vault property, not the encryption. Writing
 * the same ciphertext to raw `window.localStorage`, which is shared across
 * vaults, gives a slot that is device-wide and still OS-encrypted. Measured on
 * macOS and Windows: a string encrypted in one vault decrypts in another of the
 * same installation.
 *
 * `decryptString` takes a plain `Uint8Array`, so no Buffer and no Node built-in.
 */
class DeviceStore implements SecretStore {
  readonly kind = 'device' as const;
  constructor(private safe: SafeStorage) {}

  get(id: string): string | null {
    try {
      const cipher = globalThis.localStorage.getItem(id);
      if (!cipher) return null;
      return this.safe.decryptString(Uint8Array.from(atob(cipher), (c) => c.charCodeAt(0)));
    } catch (err) {
      // A blob this machine can no longer open — a different OS user, a reset
      // keychain — is a miss, not a crash. The caller prompts.
      log.warn('Could not read the device-wide secret', { id, error: String(err) });
      return null;
    }
  }

  set(id: string, value: string): void {
    globalThis.localStorage.setItem(id, this.safe.encryptString(value).toString('base64'));
  }

  delete(id: string): void {
    // Swallowed deliberately. This runs inside sign-out, and a storage that
    // refuses must not be able to abort signing out — the rest of that path
    // clears the tokens and folder keys, which matters more than this entry.
    try {
      globalThis.localStorage.removeItem(id);
    } catch (err) {
      log.warn('Could not drop the device-wide secret', { id, error: String(err) });
    }
  }
}

/**
 * Where a secret may be kept for the whole installation rather than one vault.
 *
 * Only the identity key goes here. Tokens and folder keys stay vault-scoped, so
 * signing one vault in still does not sign in another.
 *
 * Desktop uses safeStorage directly. Mobile needs nothing special: its
 * `app.secretStorage` is already shared by every vault of the app — measured on
 * Android — so the ordinary store is device-wide there.
 *
 * Everything else caches nothing. That is deliberate and is the one place this
 * must not fall back to `data.json`: an unwrapped identity private key in a file
 * a vault sync carries off the device is precisely the escalation
 * docs/key-storage.md exists to prevent. A Linux box with no keyring lands here.
 */
export function createDeviceStore(vaultScoped: SecretStore): SecretStore {
  const safe = safeStorage();
  if (safe) {
    let available = false;
    try { available = safe.isEncryptionAvailable() === true; } catch { available = false; }
    // Linux-only, and absent elsewhere. `basic_text` means Chromium's hardcoded
    // fallback key rather than the OS keyring — protected-looking and not
    // protected. Availability already reports false in that state on a
    // keyring-less box, but `setUsePlainTextEncryption` can flip it to true on a
    // global any plugin can reach, so the backend is checked rather than trusted.
    const backend = (() => {
      try { return safe.getSelectedStorageBackend?.() ?? null; } catch { return null; }
    })();
    if (available && backend !== 'basic_text') {
      log.info('Holding the identity key for this device', { backend: backend ?? 'n/a' });
      return new DeviceStore(safe);
    }
    log.warn('safeStorage is present but unusable; the passphrase will be asked for', {
      available, backend: backend ?? 'n/a',
    });
    return new NoStore();
  }

  // Mobile: the ordinary store is already installation-wide.
  if (vaultScoped.kind === 'keychain') return vaultScoped;
  return new NoStore();
}

export function createSecretStore(
  app: unknown,
  fallback: {
    read: () => Record<string, string>;
    write: (values: Record<string, string>) => void;
  },
): SecretStore {
  const storage = (app as { secretStorage?: ObsidianSecretStorage } | undefined)?.secretStorage;

  if (storage && typeof storage.setSecret === 'function') {
    const encrypted =
      typeof storage.isEncryptionAvailable === 'function' ? storage.isEncryptionAvailable() : false;
    if (encrypted) {
      log.info('Keeping secrets in the OS keychain');
      return new KeychainStore(storage);
    }
    log.warn('Obsidian offers secret storage but encryption is unavailable — using the vault file');
  }

  return new VaultFileStore(fallback.read, fallback.write);
}
