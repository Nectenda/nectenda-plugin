import { Platform, type App } from 'obsidian';
import { importPublicKey, unwrapSecret, wrapSecret, type WrappedFolderKey } from '@nectenda/shared';
import { SECRET_IDS, type SecretStore } from './secret-store';
import { log } from './logger';

/**
 * Two ids, for two different questions.
 *
 * **The device** is this machine — one Obsidian installation — and it is the
 * unit an organisation counts against its plan: a device holds one of your
 * slots there from the moment it is added until it is removed, whether or
 * not it is open. Three vaults on one laptop are one device. The id lives in
 * the window's `localStorage`, which is shared by every vault of the
 * installation on desktop and by every vault of the app on mobile — verified
 * on both by writing it in one vault and reading the identical value back in
 * another — so every vault on the machine reads the same value. This is
 * `window.localStorage` and not `app.saveLocalStorage`, which namespaces by
 * vault id and would give a different value per vault. It is a random UUID:
 * nothing about the hardware goes into it, because deriving one from the
 * machine would mean fingerprinting — unreliable, and a privacy regression
 * in a plugin whose whole claim is that the server knows nothing.
 *
 * **The install** is this vault's copy of the plugin, and it is what the
 * identity service calls a session. That id is kept in the secret store
 * beside the token, so it travels exactly as far as the token does and no
 * further — but how far that is depends on the platform, and the difference
 * is not cosmetic.
 *
 * On desktop the secret store is vault-scoped (measured: two vaults of one
 * installation cannot read each other's secrets), so signing in here signs in
 * this vault and not the other one on the same laptop. On Android the store is
 * shared by every vault of the app (measured: a second vault enumerated the
 * first's entries), so the install id — and the token beside it — are common
 * to all of them. A second vault there starts out holding the first one's
 * session and folder keys rather than a clean slate.
 *
 * Neither is a secret in the way a key is. Both are random and carry no
 * information about the person or the machine.
 */
const DEVICE_ID_KEY = 'nectenda-device-id';

export function getOrCreateDeviceId(secrets: SecretStore): string {
  // The installation-wide store first. If it is unavailable — some embedders
  // and private modes throw on access — or refuses to keep the value, fall
  // back to the vault-scoped id: that vault then counts as its own device,
  // which is honest, and the same for it on every launch.
  try {
    const existing = window.localStorage.getItem(DEVICE_ID_KEY);
    if (existing) return existing;
    const id = crypto.randomUUID();
    window.localStorage.setItem(DEVICE_ID_KEY, id);
    if (window.localStorage.getItem(DEVICE_ID_KEY) === id) return id;
  } catch (err) {
    log.warn('Installation-wide storage is unavailable; this vault counts as its own device', { error: String(err) });
  }
  return getOrCreateInstallId(secrets);
}

/** This vault's copy of the plugin: what a sign-in belongs to. */
export function getOrCreateInstallId(secrets: SecretStore): string {
  const existing = secrets.get(SECRET_IDS.deviceId);
  if (existing) return existing;

  const id = crypto.randomUUID();
  try {
    secrets.set(SECRET_IDS.deviceId, id);
  } catch (err) {
    // An id that cannot be stored is worse than none: a new one each launch
    // would look like a fresh device every time and take a slot each time.
    // Send nothing instead — the server refuses to count a client with no id
    // on a limited plan, and says so.
    log.warn('Could not persist install id; connecting without one', { error: String(err) });
    return '';
  }
  return id;
}

/** How this machine names itself on an organisation's roster, until the person renames it. */
export function defaultDeviceLabel(): string {
  if (Platform.isIosApp) return 'Phone (iOS)';
  if (Platform.isAndroidApp) return 'Phone (Android)';
  if (Platform.isMacOS) return 'Desktop (macOS)';
  if (Platform.isWin) return 'Desktop (Windows)';
  if (Platform.isLinux) return 'Desktop (Linux)';
  return Platform.isMobileApp ? 'Mobile' : 'Desktop';
}

export function platformName(): string {
  return Platform.isMobileApp ? 'mobile' : Platform.isMacOS ? 'macos' : Platform.isWin ? 'windows' : 'desktop';
}

/**
 * A label for this install that is not the user's content.
 *
 * `security-model.md` and `privacy.md` both say a device carries "an optional
 * label you choose", and both were wrong: every install sent
 * `app.vault.getName()`, and a vault name is frequently the user's own
 * material — a client name, a project, a diagnosis. The rule this file exists
 * to keep is that nothing vault-derived leaves the device, and a name is
 * vault-derived.
 *
 * The generic label alone is not enough, because the roster's purpose is
 * letting somebody pick the right row to sign out and two vaults on one
 * laptop would be the same row twice. The suffix is the first four hex
 * characters of the install id — per *vault*, not per machine, which is why
 * two vaults on one laptop differ — and it already leaves the device, so it
 * distinguishes the rows while disclosing nothing new.
 *
 * It is still opaque, which is what `sealVaultLabel` below addresses: the real
 * name travels sealed to the account's own key, and this stays as the fallback
 * for a row that cannot be opened.
 */
export function installLabel(installId: string): string {
  const suffix = installId.slice(0, 4);
  return suffix ? `${defaultDeviceLabel()} · ${suffix}` : defaultDeviceLabel();
}

/** What a sync server hears: the machine, and the vault it is being asked from. */
export interface DeviceDescription {
  deviceId: string;
  deviceLabel: string;
  devicePlatform: string;
  installId: string;
  installLabel: string;
  /**
   * This vault's real name, wrapped to the account's identity key. Optional
   * because sealing is async and this stays synchronous — the caller passes a
   * cached one, and a handshake without it leaves whatever the server already
   * holds alone rather than blanking it.
   */
  sealedInstallLabel?: string | null;
}

export function describeDevice(
  _app: App,
  secrets: SecretStore,
  sealedInstallLabel: string | null = null,
): DeviceDescription {
  const installId = getOrCreateInstallId(secrets);
  return {
    deviceId: getOrCreateDeviceId(secrets),
    deviceLabel: defaultDeviceLabel(),
    devicePlatform: platformName(),
    installId,
    installLabel: installLabel(installId),
    sealedInstallLabel,
  };
}

/**
 * What the identity service hears: the install, under the field names it has
 * always used. Its "device" is the thing a sign-in belongs to, which is this
 * vault. It used to send the vault's name for this, so that a person could
 * pick the right row to sign out; `installLabel` above does that job without
 * sending anything the user wrote.
 */
export interface InstallDescription {
  deviceId: string;
  deviceLabel: string;
  devicePlatform: string;
}

export function describeInstall(_app: App, secrets: SecretStore): InstallDescription {
  const installId = getOrCreateInstallId(secrets);
  return { deviceId: installId, deviceLabel: installLabel(installId), devicePlatform: platformName() };
}

/**
 * The vault's real name, sealed so that only this account can read it.
 *
 * `installLabel` above deliberately sends nothing the user wrote, which is the
 * right default and is what the server stores. The cost was that somebody
 * looking at their own list of signed-in vaults saw `Desktop (macOS) · a5f9`
 * twice and could not tell which row was which before signing one out.
 *
 * This closes that without giving the name up. The name is ECIES-wrapped to the
 * account's own identity public key — the same `wrapSecret` that seals folder
 * keys — so every vault signed into the account opens it, while the server holds
 * a blob it has no key for. The generic label stays beside it as the fallback.
 *
 * Sealing needs only the **public** half, which is in `keyMaterial` from
 * enrolment onwards. So a vault can publish its own name even while locked;
 * only reading the *other* rows needs the private half.
 */
export async function sealVaultLabel(name: string, publicKeySpki: string): Promise<string> {
  const wrapped = await wrapSecret(new TextEncoder().encode(name), await importPublicKey(publicKeySpki));
  return JSON.stringify(wrapped);
}

/**
 * Open one, or null.
 *
 * Null rather than throwing, and null rather than the ciphertext: every caller
 * is drawing a row and wants the generic label when this cannot be read. A blob
 * sealed to a different account — two vaults on one machine signed into two
 * accounts — is a miss, not an error.
 */
export async function openVaultLabel(
  sealed: string | null | undefined,
  privateKey: CryptoKey,
): Promise<string | null> {
  if (!sealed) return null;
  try {
    // No shape check before the unwrap: a blob missing either half throws in
    // unwrapSecret and lands in the catch below with the same answer, so a
    // guard here would be a branch nothing can reach.
    const wrapped = JSON.parse(sealed) as WrappedFolderKey;
    return new TextDecoder().decode(await unwrapSecret(wrapped, privateKey));
  } catch (err) {
    // DEBUG, not WARN. A blob this key cannot open is the ordinary case, not a
    // fault: two vaults on one machine can be signed into different accounts,
    // and each then sees rows sealed to the other. The pane re-reads every row
    // on every poll, so warning here wrote an unbounded stream of warnings into
    // a log people are asked to send us — one every thirty seconds, for a
    // fallback working exactly as designed.
    log.debug('A sealed vault label did not open with this key', { error: String(err) });
    return null;
  }
}
