import { Notice, Plugin, PluginSettingTab, App, Setting, FuzzySuggestModal, TFolder, Modal, MarkdownView, SettingPage, apiVersion, type SettingDefinitionItem, type SettingGroupItem } from 'obsidian';
import type { Extension } from '@codemirror/state';
import { DEFAULT_PORT, apiBaseUrl } from '@nectenda/shared';
import type { UserRole, UserInfo, InviteTokenInfo, SharedFolderInfo, KeyMaterial, KdfParams } from '@nectenda/shared';
import { hashCredential } from '@nectenda/shared';
import { ProviderRouter, type ShardConnection } from './provider-router';
import { IdentityClient, IdentityError, ShardClient, type SentInvite, type ShardSession } from './identity-client';
import { recoverSignedOutConnection } from './signed-out';
import { SingleFlight } from './single-flight';
import { partitionFolders, mappingBelongsTo, mayUnshare, foldersSyncedFor, unclaimedMappings } from './folder-sections';
import { memberLabel, pickerCandidates, type PickerCandidate, type RosterUser } from './folder-members';
import { sessionIdFromToken } from './jwt-claims';
import { newPkce, pollForResult, type PendingInvite, type SignInResult } from './auth-flow';
import { establishMemberships, membershipId, type StoredIdentity, type StoredMembership, syncsHere, deviceOf } from './cloud-session';
import { ObsidianVaultAdapter } from './obsidian-vault';
import { PROVIDER_LABELS, PROVIDER_ORDER, providerMark, providerStartUrl, type ProviderName } from './provider-marks';
import { nectendaMark, nectendaWordmark } from './brand-marks';
import * as session from './session';
import { fromBase64, identityPairs, importIdentityFromPkcs8, publicKeyFingerprint, toBase64 } from '@nectenda/shared';
import { DocIndex } from './doc-index';
import { IDENTITY_KEY_PREFIX, createDeviceStore, createSecretStore, SECRET_IDS, type SecretStore } from './secret-store';
import { describeDevice, describeInstall, getOrCreateInstallId, openVaultLabel, platformName, sealVaultLabel, type DeviceDescription } from './device';
import { ErrorReports, isOurs } from './error-report';
import { shouldWarnAboutStorage } from './blob-policy';
import {
  FolderCryptoRegistry,
  createFolderKeys,
  deserialiseFolderKeys,
  openFolderName,
  sealFolderName,
  serialiseFolderKeys,
  unwrapFolderKeys,
  wrapKeysFor,
  type FolderKeyRecord,
  type StoredFolderKeys,
} from './folder-crypto';
import type { SessionKeys, SessionResult } from './session';
import { MultiplexedProvider } from './multiplexed-provider';
import { ContentSync } from './content-sync';
import { EditorBridge } from './editor-bridge';
import type { FolderMapping } from './editor-bridge';
import { basenameOf, mappingCovering } from './folder-mapping';
import { FolderIndicator } from './folder-indicator';
import { FileSync } from './file-sync';
import { BlobSync } from './blob-sync';
import { DeviceStateStore, type StateFile } from './device-state';
import {
  findStrandedAttachments, destinationFor, attachmentsLandOutsideSharedFolders,
  ATTACHMENTS_BESIDE_NOTE, type StrandedAttachment,
} from './attachment-location';
import { getOrCreateDeviceId } from './device';
import { DEFAULT_MAX_BLOB_BYTES } from '@nectenda/shared';
import { VaultWatcher } from './vault-watcher';
import { log, setLogSink } from './logger';
import { initials, type Person } from './presence';
import { serverFetch } from './client-version.js';

/** What `GET /api/account` answers with. */
interface AccountResponse {
  account: { id: string; name: string; planId: string; status: 'active' | 'suspended' };
  limits: {
    quotaBytes: number; maxUsers: number; maxDevicesPerUser: number;
    maxBlobBytes: number; planId: string; status: string;
    /** Sent all along; the plugin simply never declared it. */
    attachmentsEnabled?: boolean;
  };
  usage: { blobBytes: number; textBytes: number; blobCount: number; updatedAt: number };
  seatsUsed: number;
  /**
   * What the account view should say, authored by the server.
   *
   * Deliberately not composed here: the plugin ships through the community
   * store with its review latency, so operational copy baked into it is slow
   * to correct, and the server can change these words in a deploy.
   */
  messages?: Array<{ kind: string; text: string }>;
  /** The roster: everyone holding a seat in this organisation. */
  users?: Array<{ id: string; username: string; displayName?: string; email: string; accountRole?: 'owner' | 'admin' | 'member' }>;
  /** The member's devices on this organisation's roster, with the vaults each syncs from. */
  devices?: Array<{
    deviceId: string; label: string | null; platform: string | null; connected?: boolean; thisDevice?: boolean;
    installs?: Array<{ installId: string; label: string | null; sealedLabel?: string | null }>;
  }>;
  deviceSlots?: { used: number; max: number; thisDeviceEnrolled: boolean };
}

/** Bytes for people, not for machines. */
function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = n / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/**
 * How long ago something happened, for people rather than for a log.
 *
 * Relative where the rest of the pane uses absolute dates, and deliberately so:
 * these rows exist to answer "which of these two folders is dead", and
 * "no changes in 4 months" answers it where `14/09/2026` leaves the reader to
 * do the arithmetic.
 */
export function describeAge(at: number | null | undefined, now = Date.now()): string | null {
  if (!at) return null;
  const seconds = Math.max(0, Math.round(now / 1000 - at));
  const scale: Array<[number, Intl.RelativeTimeFormatUnit]> = [
    [60, 'second'], [3600, 'minute'], [86400, 'hour'],
    [86400 * 7, 'day'], [86400 * 30, 'week'], [86400 * 365, 'month'], [Infinity, 'year'],
  ];
  const divisor: Record<string, number> = {
    second: 1, minute: 60, hour: 3600, day: 86400, week: 86400 * 7, month: 86400 * 30, year: 86400 * 365,
  };
  const unit = scale.find(([limit]) => seconds < limit)?.[1] ?? 'year';
  const value = Math.round(seconds / divisor[unit]);
  return new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }).format(-value, unit);
}

/**
 * Names that more than one listed folder opens to.
 *
 * Two folders can carry the same name — sharing "test" again after unmapping an
 * earlier "test" leaves both, since unmapping is not unsharing — and then
 * nothing on the row tells them apart. The short id is appended only to the
 * rows that clash, so the ordinary case stays clean.
 */
export function ambiguousNames(folders: Array<{ name: string }>): Set<string> {
  const seen = new Map<string, number>();
  for (const f of folders) seen.set(f.name, (seen.get(f.name) ?? 0) + 1);
  return new Set([...seen].filter(([, n]) => n > 1).map(([name]) => name));
}

/** The Nectenda Cloud identity service. Overridable only for a staging service. */
/**
 * A line of explanation, in a row of its own.
 *
 * Obsidian draws a settings row as a rounded panel with 16px of padding, and
 * gives a heading the same inset, so a paragraph written straight onto the
 * pane starts 16px to the left of every heading and every row beside it, and
 * sits on no panel at all. A Setting carrying only a description is that same
 * panel, which is what keeps this text lined up under any theme rather than
 * under a measurement copied from one.
 */
/**
 * One box holding several rows, divided by rules rather than by gaps.
 *
 * Obsidian gives each settings row its own rounded panel and a gap beneath
 * it, which is right for unrelated controls and wrong for a list: five
 * devices read as five separate things rather than one list of five.
 *
 * This is the application's own markup for that, not a box of our own. Since
 * 1.11 Obsidian styles `.setting-group > .setting-items`, painting the card,
 * squaring and un-gapping the rows inside it, rounding the first and last,
 * and drawing the divider as a pseudo-element inset from both edges by the
 * container's own padding. A border cannot do that last part — a border spans
 * the whole padding box by definition, so it always reaches the edges, which
 * is how a hand-rolled version gives itself away. Relay emits the same markup
 * for the same reason. The manifest asks for 1.13, so there is nothing to
 * guard against here.
 *
 * Returns the inner element: rows go in there, not in the wrapper.
 */
function rowGroup(parent: HTMLElement): HTMLElement {
  return parent.createDiv('setting-group nectenda-rows').createDiv('setting-items');
}

/**
 * Whether to make this person an organisation of their own, unasked.
 *
 * Only when they have nowhere to put anything. An invitation waiting is a
 * better first organisation than one of their own, and a seat already held
 * means they are signing in again rather than arriving. The public key is a
 * precondition rather than a preference: taking a seat uploads it, and the
 * passphrase step is what generates it, so this can only be true afterwards.
 */
/**
 * Records about folders this vault no longer maps.
 *
 * `oversizedAttachments` and `pendingBlobUploads` are keyed `<folderId> <path>`
 * and were only ever appended to. Unmapping a folder left its entries behind,
 * so "Attachments that will not sync" went on naming a file in a folder that
 * is no longer shared, with a Try again button that had nowhere to send it.
 *
 * Forgetting them loses nothing. The file is in the vault, where it always
 * was; the record existed only to explain a refusal that no longer applies,
 * and it comes back by itself if the folder is shared again and the upload is
 * refused again.
 */
/**
 * What the Storage row should say, and whether a bar belongs under it.
 *
 * The quota governs attachments and only attachments: the server compares
 * `blob_bytes` against it and nothing else, and text sync is never blocked by
 * it on any plan. Counting text here overstated what is measured against the
 * limit — and on a plan with no attachments it invented a figure entirely, so
 * an organisation holding nothing read "0 B of 1.0 GB", a number that is
 * neither true nor reachable.
 *
 * That figure is not nonsense in the database, which is the trap: `free` seeds
 * a quota because 0 already means unlimited, and it survives as the reference
 * the text-growth flag is measured against. It simply must not be shown as an
 * allowance, because there is none.
 */
export function storageSummary(
  limits: { quotaBytes: number; attachmentsEnabled?: boolean },
  usage: { blobBytes: number },
): { text: string; bar: boolean; used: number } {
  if (limits.attachmentsEnabled === false) {
    return {
      text: 'Attachments are not included in this plan, so there is no storage to use. Notes sync as normal.',
      bar: false,
      used: usage.blobBytes,
    };
  }
  if (limits.quotaBytes === 0) {
    return { text: `${formatBytes(usage.blobBytes)} used — no limit on this plan`, bar: false, used: usage.blobBytes };
  }
  const pct = Math.round((usage.blobBytes / limits.quotaBytes) * 100);
  return {
    text: `${formatBytes(usage.blobBytes)} of ${formatBytes(limits.quotaBytes)} (${pct}%)`,
    bar: true,
    used: usage.blobBytes,
  };
}

export function forgetUnmappedRecords(keys: string[], mappedFolderIds: ReadonlySet<string>): string[] {
  return keys.filter((key) => {
    const gap = key.indexOf(' ');
    // A key with no folder in it cannot be attributed, so it cannot be shown
    // usefully either. Dropping it is the same judgement as the rest.
    if (gap < 0) return false;
    return mappedFolderIds.has(key.slice(0, gap));
  });
}

/**
 * What about a set of memberships would make a connection change.
 *
 * The identity of the seat, where it lives, and whether it is active — and
 * not the session token. The shard mints a fresh token on every session call,
 * same claims and a new issue time, so the string differs every refresh;
 * including it made every refresh look like a change, and every change tore
 * down every socket and announced a lost connection. A fresh token is stored
 * and handed to the live connection for its next reconnect. It is not a
 * reason to reconnect now.
 */
export function membershipShape(list: Array<{ id: string; endpoint: string; accountStatus: string; device?: { enrolled: boolean } }>): string {
  // Whether this device is on the roster is part of the shape: a device that
  // was just added or removed there needs its socket opened or closed.
  return JSON.stringify(list.map((m) => [m.id, m.endpoint, m.accountStatus, m.device?.enrolled ?? null]));
}

/**
 * What an organisation's entry says beside its name, before the page is
 * opened: the one fact that explains "why is this not syncing", or the
 * roster count when nothing is wrong.
 */
export function organisationSummary(m: { accountStatus: string; device?: { enrolled: boolean; used: number; max: number } }, foldersSynced = 0): string {
  if (m.accountStatus !== 'active') return m.accountStatus;
  const folders = foldersSynced > 0 ? `${foldersSynced} ${foldersSynced === 1 ? 'folder' : 'folders'} synced` : '';
  const devices = !m.device ? '' : !m.device.enrolled ? 'not added on this device' : m.device.max > 0 ? `${m.device.used} of ${m.device.max} devices` : 'devices unlimited';
  return [folders, devices].filter(Boolean).join(' · ');
}

/** The entry's status mark: something on the page needs the person's attention. */
export function organisationWarning(m: { accountStatus: string; device?: { enrolled: boolean } }): 'warning' | null {
  return m.accountStatus !== 'active' || (m.device !== undefined && !m.device.enrolled) ? 'warning' : null;
}

/**
 * What a change to the memberships has to rebuild the pane for.
 *
 * The list of organisation pages, their names and what their entries say
 * come from the definitions, and only `update()` re-reads those — at the
 * price of a full rebuild (an open disclosure closes, a half-typed field is
 * lost). So the pane rebuilds when this key moves and refreshes in place
 * otherwise; a rotated token, which every refresh brings, is not in it.
 */
/**
 * Obsidian addresses a page by its name among siblings, so two organisations
 * called the same thing need telling apart; the second is numbered.
 */
export function pageName(m: StoredMembership, index: number, all: StoredMembership[]): string {
  const before = all.slice(0, index).filter((x) => x.accountName === m.accountName).length;
  return before === 0 ? m.accountName : `${m.accountName} (${before + 1})`;
}

/** What the shared-folders section needs to know of a server. */
export type FolderServer = { base: string; token: string; membershipId: string | null; localUserId?: string | null; localUsername?: string | null };

export function pagesKey(
  list: Array<{ id: string; accountName: string; accountStatus: string; role: string; device?: { enrolled: boolean; used: number; max: number } }>,
  mappings: Array<{ membershipId?: string }> = [],
): string {
  return JSON.stringify(list.map((m) => [
    m.id, m.accountName, m.accountStatus, m.role, m.device?.enrolled ?? null, m.device?.used ?? null, m.device?.max ?? null,
    // The entry counts the folders synced here, so a map or unmap redraws it.
    foldersSyncedFor(m.id, mappings, list.length),
  ]));
}

export type SentInviteStatus = 'pending' | 'accepted' | 'declined' | 'revoked' | 'expired';

/**
 * What became of an invitation, from four timestamps.
 *
 * The service records each end state and computes nothing, so the reading is
 * made here, in the order that matters: a person who accepted is a member
 * whatever else was stamped on the row afterwards; a revoked one is finished
 * whether or not it was declined first; an expired one simply ran out.
 */
export function sentInviteStatus(
  i: { acceptedAt: number | null; declinedAt: number | null; revokedAt: number | null; expiresAt: number },
  now = Date.now() / 1000,
): SentInviteStatus {
  if (i.acceptedAt) return 'accepted';
  if (i.revokedAt) return 'revoked';
  if (i.declinedAt) return 'declined';
  if (i.expiresAt <= now) return 'expired';
  return 'pending';
}

/** The row's second line: what was sent, and what has happened to it since. */
export function sentInviteDescription(i: SentInvite, status: SentInviteStatus): string {
  const day = (t: number) => new Date(t * 1000).toLocaleDateString();
  const base = `As ${i.role}, sent ${day(i.createdAt)}`;
  // A bounce is the thing an owner most needs to know and could not see: the
  // service records it and the plugin still said "Invitation sent".
  if (i.mailError) return `${base}. The email could not be delivered: ${i.mailError}`;
  switch (status) {
    case 'pending': return `${base}. Waiting for a reply; expires ${day(i.expiresAt)}.`;
    case 'declined': return `${base}. Declined ${day(i.declinedAt!)}.`;
    case 'expired': return `${base}. Expired ${day(i.expiresAt)} without a reply.`;
    default: return `${base}.`;
  }
}

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

/**
 * One counter per section, so a slow answer to an old request cannot land
 * on top of a fresh one. Status edges come in bursts and the poll can overlap
 * an event; without this the pane would sometimes show the older of two
 * responses and call it current.
 */
/** How long the pane waits to fold a burst of changes into one refresh. */
const REFRESH_COALESCE_MS = 250;
/** How often the open pane asks the servers what other devices have done. */
const PANE_POLL_MS = 30_000;

/**
 * One account section's containers, each rebuilt only when its slice of the
 * response differs from what it last drew. The members roster in particular
 * must not be rebuilt by a socket edge: nothing about it changed, and a
 * button somebody is about to press would be a detached node.
 */
interface AccountSlots {
  server: ReturnType<NectendaPlugin['servers']>[number];
  section: HTMLElement;
  facts: HTMLElement;
  members: HTMLElement;
  attachments: HTMLElement;
  devices: HTMLElement;
  last: Partial<Record<'facts' | 'members' | 'attachments' | 'devices', string>>;
}

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

export function shouldCreateFirstOrganisation(settings: {
  keyMaterial?: { publicKey?: string | null } | null;
  memberships: unknown[];
  pendingInvites?: unknown[] | null;
}): boolean {
  return (
    !!settings.keyMaterial?.publicKey &&
    settings.memberships.length === 0 &&
    (settings.pendingInvites ?? []).length === 0
  );
}

function noteRow(parent: HTMLElement, text: string | DocumentFragment, cls?: string): Setting {
  const row = new Setting(parent).setDesc(text);
  if (cls) row.descEl.addClass(cls);
  return row;
}

const DEFAULT_IDENTITY_URL = 'https://accounts.nectenda.com';

interface NectendaSettings {
  /**
   * Which kind of server this vault talks to.
   *
   * `self-hosted` is a server you run: one URL, a username and a password, and
   * both authentication and encryption derive from that password. `cloud` is
   * Nectenda Cloud: identity is proved at the identity service (an emailed
   * code, a passkey or a provider), organisations may live on several sync
   * servers, and the passphrase is used for encryption only and never sent.
   */
  mode: 'self-hosted' | 'cloud';
  identityUrl: string;
  /** Who is signed in to Nectenda Cloud. Null in self-hosted mode or when signed out. */
  identity: StoredIdentity | null;
  /** Short-lived; kept in the keychain when there is one. */
  identityAccessToken: string;
  /** The device's long-lived session with the identity service. Keychain when possible. */
  refreshToken: string;
  /** Every organisation this identity belongs to, with a session on each sync server. */
  memberships: StoredMembership[];
  /** Invitations addressed to this identity's email, shown in settings and the status bar. */
  pendingInvites: PendingInvite[];
  /**
   * When the recovery key was confirmed saved. The modal that shows it cannot
   * be dismissed any other way, because the key is shown once and a
   * forgotten passphrase without it is unrecoverable data loss.
   */
  recoveryKeyAcknowledgedAt: number | null;
  /**
   * The vault name this install last sealed and published, so it is republished
   * only when it actually changes.
   *
   * Needed because every seal draws a fresh ephemeral key, so the ciphertext
   * differs on every call even for an identical name — without this the row
   * would be rewritten on every launch and look like activity that never
   * happened. Plaintext and local: it is this vault's own name, which the vault
   * already knows, and it is never sent.
   */
  publishedVaultLabel: string;
  serverUrl: string;
  username: string;
  token: string;
  userRole: UserRole;
  folderMappings: FolderMapping[];
  /**
   * Deliberately always empty.
   *
   * The master key used to be cached here so a restart could skip the KDF. It
   * also unwraps the identity key with no password, so anyone who read this
   * file — including whatever cloud service syncs the vault — gained every
   * folder ever shared with the account, not merely the notes already on disk.
   * The field remains only so an existing value can be cleared. See
   * docs/key-storage.md.
   */
  masterKey: string;
  /**
   * The wrapped identity keypair and recovery material, as the server holds
   * them. On Nectenda Cloud it also carries the KDF parameters, because the
   * identity service is where the passphrase's parameters live.
   */
  keyMaterial: (KeyMaterial & { kdfParams?: KdfParams | null }) | null;
  /**
   * Percentage of the storage quota at which to start warning.
   *
   * A bar that only turns red at the limit tells the user when it is already
   * too late to plan, so where the warning starts is theirs to choose.
   */
  quotaWarnPercent: number;
  /**
   * Attachments whose upload has not got through, as "folderId relativePath".
   *
   * Persisted from the outset. The in-memory version of this queue is a mistake
   * this codebase has already made once with `pendingDeletes`: an operation
   * deferred while offline is lost on restart, and for a delete that leaves a
   * permanent orphan nothing will ever collect.
   */
  pendingBlobUploads: string[];
  /** Attachment purges not yet accepted, as "folderId blobId". */
  pendingBlobDeletes: string[];
  /**
   * Largest attachment this account accepts, cached from the server.
   *
   * Cached so an upload can be refused before the file is read and encrypted,
   * rather than after. Zero means "not known yet", and the built-in default is
   * used until the server says otherwise; -1 means the server said there is no
   * limit, which used to be cached as zero and so read as "not known" for ever.
   */
  maxBlobBytes: number;
  /**
   * Attachments the server will never accept, as "folderId relativePath".
   *
   * Kept apart from `pendingBlobUploads`, which is for things that might work
   * later. A file bigger than the account's maximum is not one of them, and
   * queueing it re-encrypts it on every reconnect for ever.
   */
  oversizedAttachments: string[];
  /**
   * Mirror the plugin log to a file in the vault, for reporting a problem.
   *
   * Off by default and deliberately not something to leave on: the file grows
   * without bound, and its lines carry vault-relative paths — precisely what
   * Phase 7 exists to keep off the server. It earns its place because copied
   * console output proved unreliable when diagnosing sync problems: truncated,
   * objects collapsed, or from a stale session. A full ordered trace settled in
   * one run what four rounds of pasted output could not.
   */
  diagnosticLog: boolean;
  /**
   * Send crash reports to the server you are signed in to.
   *
   * On by default, and it still sends nothing until
   * `errorReportsAcknowledgedAt` is set: the default is the answer, but the
   * person is told first. What goes is the exception, its scrubbed message,
   * stack frames as numbers in our own unminified bundle, the plugin and
   * Obsidian versions, the platform, and the install id the server already
   * holds — see `error-report.ts`, which builds the payload from an allowlist.
   *
   * Reporting is impossible without a DSN, and only a hosted identity service
   * hands one out, so a self-hosted vault reports nothing whatever this says.
   */
  errorReports: boolean;
  /**
   * When the person was shown what crash reporting sends. Null until then.
   *
   * Same shape as `recoveryKeyAcknowledgedAt`: a timestamp rather than a
   * boolean, so that a later change to what is sent can ask again by
   * comparing against a date.
   */
  errorReportsAcknowledgedAt: number | null;
  /**
   * The crash-report endpoint the identity service last named, or ''.
   *
   * Cached so that a crash during a start with no network can still be
   * reported. Cleared at sign-out beside the token and the folder keys,
   * because it belongs to the server that issued it.
   */
  errorReportDsn: string;
  /**
   * Unwrapped folder keys, cached per folder id.
   *
   * Load-bearing rather than an optimisation: without it a start with no
   * network has no keys, cannot read any shared folder, and the vault silently
   * stops syncing. Kept in the keychain where there is one — which is every
   * supported build — and in this file otherwise, where the notes they protect
   * sit in the same vault anyway. Cleared on logout.
   */
  folderKeys: Record<string, StoredFolderKeys>;
  /**
   * The fallback secret store, used only where no keychain is available.
   *
   * Empty when secrets live in the keychain — which is the point, since this
   * file travels with the vault.
   */
  secrets: Record<string, string>;
}

const DEFAULT_SETTINGS: NectendaSettings = {
  mode: 'self-hosted',
  identityUrl: DEFAULT_IDENTITY_URL,
  identity: null,
  identityAccessToken: '',
  refreshToken: '',
  memberships: [],
  pendingInvites: [],
  recoveryKeyAcknowledgedAt: null,
  publishedVaultLabel: '',
  serverUrl: `ws://localhost:${DEFAULT_PORT}`,
  username: '',
  token: '',
  userRole: 'editor',
  folderMappings: [],
  masterKey: '',
  keyMaterial: null,
  quotaWarnPercent: 80,
  pendingBlobUploads: [],
  pendingBlobDeletes: [],
  maxBlobBytes: 0,
  oversizedAttachments: [],
  diagnosticLog: false,
  errorReports: true,
  errorReportsAcknowledgedAt: null,
  errorReportDsn: '',
  folderKeys: {},
  secrets: {},
};

const MIN_PASSWORD_LENGTH = 8;

/**
 * How often to tell the server what this vault still references.
 *
 * Well inside the server's collection grace period, so several missed rounds in
 * a row still cost nothing. Erring short is free; erring long risks a file.
 */
const ATTEST_INTERVAL_MS = 6 * 60 * 60 * 1000;

/**
 * Shown exactly once, after registration or first key enrolment.
 *
 * There is no second chance to display this: the server holds only the master
 * key wrapped under it and cannot reproduce it. Without it, a forgotten
 * password means unrecoverable data loss.
 */
/**
 * What crash reporting sends, shown once before anything is sent.
 *
 * The setting defaults to on, and `ErrorReports.capture` still refuses until
 * this has been acknowledged. That combination is the whole point: the default
 * is the answer most people want, and nobody discovers after the fact that
 * their editor has been talking to us. Escape and a click outside are allowed
 * here — unlike the recovery key, nothing is lost by closing it, and the
 * acknowledgement is recorded either way, because being shown the notice is
 * the thing that matters.
 *
 * Both buttons are the same size on purpose. A dialogue whose "no" is a
 * greyed-out link is not a choice, and this product's whole claim is that we
 * do not need to be trusted.
 */
class ErrorReportConsentModal extends Modal {
  constructor(
    app: App,
    private readonly onDecided: (send: boolean) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl('h2', { text: 'Crash reports' });
    contentEl.createEl('p', {
      text:
        'When Nectenda hits a bug, it can send us a crash report so we can fix it. ' +
        'This is on unless you turn it off, and nothing has been sent yet.',
    });

    contentEl.createEl('p', { text: 'A report contains:' });
    const sends = contentEl.createEl('ul');
    for (const line of [
      'The error and its message, with note names, file paths and anything that looks like a key or a token removed.',
      'Where in our own code it happened — line numbers in the published plugin file, which is not minified, so no separate debug file is ever uploaded.',
      'Your plugin and Obsidian versions, and whether you are on desktop or mobile.',
      'The identifier this vault already sends with every request.',
    ]) sends.createEl('li', { text: line });

    contentEl.createEl('p', { text: 'A report never contains:' });
    const never = contentEl.createEl('ul');
    for (const line of [
      'Anything you have written, or the name of any note, folder or attachment.',
      "Your vault's name.",
      'Your passphrase, your keys, or any token.',
    ]) never.createEl('li', { text: line });

    contentEl.createEl('p', {
      text:
        'Reports go to an error tracker we run ourselves, not a third party, and are deleted after 90 days. ' +
        'This only applies when you are signed in to Nectenda Cloud: against your own server there is nowhere to send them, and none are.',
    });
    const more = contentEl.createEl('p', { text: 'Full detail: ' });
    more.createEl('a', { text: 'nectenda.com/privacy', href: 'https://nectenda.com/privacy' });

    const buttons = contentEl.createDiv({ cls: 'modal-button-container' });
    buttons.createEl('button', { text: 'Send crash reports', cls: 'mod-cta' }).onclick = () => {
      this.onDecided(true);
      super.close();
    };
    buttons.createEl('button', { text: "Don't send" }).onclick = () => {
      this.onDecided(false);
      super.close();
    };
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

class RecoveryKeyModal extends Modal {
  private recoveryKey: string;
  private acknowledged = false;
  private onAcknowledged: (() => void) | undefined;

  constructor(app: App, recoveryKey: string, onAcknowledged?: () => void) {
    super(app);
    this.recoveryKey = recoveryKey;
    this.onAcknowledged = onAcknowledged;
  }

  /**
   * Escape, a click outside, and the close button all land here. None of them
   * closes this modal: there is no second showing of the key, so the only way
   * out is to say it has been saved.
   */
  close(): void {
    if (!this.acknowledged) {
      new Notice('Save the recovery key first, then confirm below.');
      return;
    }
    super.close();
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl('h2', { text: 'Save your recovery key' });
    contentEl.createEl('p', {
      text:
        'This is the only way back into your notes if you forget your password. ' +
        'It is shown once and cannot be retrieved later — not even by a server admin. ' +
        'Store it in a password manager now.',
    });

    const code = contentEl.createEl('pre', { cls: 'nectenda-recovery-key' });
    code.setText(this.recoveryKey);

    const buttons = contentEl.createDiv('modal-button-container');
    const copy = buttons.createEl('button', { text: 'Copy to clipboard' });
    copy.addEventListener('click', () => {
      void navigator.clipboard.writeText(this.recoveryKey);
      new Notice('Recovery key copied');
    });
    const done = buttons.createEl('button', { text: "I've saved it", cls: 'mod-cta' });
    done.addEventListener('click', () => {
      this.acknowledged = true;
      this.onAcknowledged?.();
      this.close();
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

// Modal for picking a vault folder
type FolderRole = 'owner' | 'editor';

interface FolderMember {
  userId: string;
  username: string;
  /** Sent by shards from 15 September 2026; the username stands in before that. */
  displayName?: string;
  email?: string;
  role: FolderRole;
  publicKey: string | null;
}

/** Someone from the organisation's roster to add to a folder. */
class FolderMemberPickerModal extends FuzzySuggestModal<PickerCandidate> {
  constructor(app: App, private readonly candidates: PickerCandidate[], private readonly onChoose: (c: PickerCandidate) => void) {
    super(app);
    this.setPlaceholder(candidates.length ? 'Choose someone in this organisation…' : 'Everyone in this organisation is already a member');
  }
  getItems(): PickerCandidate[] { return this.candidates; }
  getItemText(item: PickerCandidate): string { return item.label; }
  onChooseItem(item: PickerCandidate): void {
    if (!item.addable) {
      new Notice('They have not enrolled encryption keys yet, so no folder key can be wrapped for them. Ask them to set a passphrase first.');
      return;
    }
    this.onChoose(item);
  }
}

/**
 * Who can reach a shared folder, and what they may do.
 *
 * Membership is editing rights: every member may read and write. Owners can
 * additionally change who else is a member.
 *
 * There is deliberately no read-only role. Obsidian gives a plugin no way to
 * veto a file operation, so while the editor can be locked and the server can
 * refuse writes, nothing prevents a read-only member deleting or creating files
 * from the file explorer — and a role that implies a guarantee it cannot keep
 * is worse than no role at all.
 *
 * Adding someone here grants them access on the server. Under end-to-end
 * encryption that is only half of it — they also need the folder key wrapped
 * for them, which the server cannot do because it does not have it; this
 * modal wraps it (`grantKey`) the moment the server says who they are. A
 * member added before that step existed sees the folder but cannot read it.
 */
class FolderMembersModal extends Modal {
  private plugin: NectendaPlugin;
  private folderId: string;
  private folderName: string;

  constructor(app: App, plugin: NectendaPlugin, folderId: string, folderName: string) {
    super(app);
    this.plugin = plugin;
    this.folderId = folderId;
    this.folderName = folderName;
  }

  onOpen(): void {
    this.titleEl.setText(`Members of ${this.folderName}`);
    void this.render();
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.plugin.serverFor(this.folderId).token}`,
      'Content-Type': 'application/json',
    };
  }

  private async render(): Promise<void> {
    const { contentEl } = this;
    contentEl.empty();

    const { base } = this.plugin.serverFor(this.folderId);
    let members: FolderMember[] = [];
    try {
      const res = await serverFetch(`${base}/folders/${this.folderId}/members`, { headers: this.headers() });
      if (!res.ok) {
        contentEl.createEl('p', { text: 'Could not load members.' });
        return;
      }
      ({ members } = (await res.json()) as { members: FolderMember[] });
    } catch {
      contentEl.createEl('p', { text: 'Could not reach the server.' });
      return;
    }

    for (const member of members) {
      // The fingerprint is the only defence against a server that substitutes
      // its own public key for a collaborator's. Without comparing these out of
      // band — in person, over a call — the guarantee holds against an operator
      // who only reads, not one who actively interferes.
      const fingerprint = member.publicKey
        ? await publicKeyFingerprint(member.publicKey)
        : null;
      // A person, not the shard's username — which for a hosted user is two
      // ids joined by a dot. The address goes on the second line when the
      // first is a display name; the fingerprint stays, as the check it is.
      const who = memberLabel(member);
      const address = member.displayName && member.email ? `${member.email} — ` : '';
      const setting = new Setting(contentEl)
        .setName(who)
        .setDesc(
          fingerprint
            ? `${address}${member.role} — key ${fingerprint}`
            : `${address}${member.role} — no encryption keys yet, cannot be given folder access`,
        );

      setting.addDropdown((drop) => {
        drop
          .addOption('owner', 'Owner')
          .addOption('editor', 'Editor')
          .setValue(member.role)
          .onChange(async (role) => {
            await this.post(member.userId, who, role as FolderRole);
            await this.render();
          });
      });

      setting.addButton((btn) =>
        btn
          .setButtonText('Remove')
          .setWarning()
          .onClick(async () => {
            const res = await serverFetch(`${base}/folders/${this.folderId}/members/${member.userId}`, {
              method: 'DELETE',
              headers: this.headers(),
            });
            if (!res.ok) {
              const body = (await res.json().catch(() => ({}))) as { error?: string };
              new Notice(body.error ?? 'Could not remove that member');
              return;
            }
            new Notice(`Removed ${who}`);
            await this.render();
          }),
      );
    }

    const mine = this.plugin.settings.keyMaterial?.publicKey;
    if (mine) {
      const note = contentEl.createEl('p', { cls: 'setting-item-description' });
      note.setText(
        `Your key: ${await publicKeyFingerprint(mine)} — compare these with collaborators ` +
          'through some channel other than this server. A server that swapped a key for its ' +
          'own could read everything, and the fingerprint is what would give it away.',
      );
    }

    contentEl.createEl('h4', { text: 'Add someone' });
    let role: FolderRole = 'editor';
    // Picked from the organisation's roster, not typed: the person must
    // already hold a seat here — folders never cross organisations — and an
    // address typed by hand had to match exactly or the add failed.
    new Setting(contentEl)
      .setName('Add a member')
      .setDesc('Someone who already belongs to this organisation.')
      .addDropdown((drop) =>
        drop
          .addOption('editor', 'Editor')
          .addOption('owner', 'Owner')
          .setValue('editor')
          .onChange((v) => (role = v as FolderRole)),
      )
      .addButton((btn) =>
        btn
          .setButtonText('Choose…')
          .setCta()
          .onClick(async () => {
            let users: RosterUser[];
            try {
              const res = await serverFetch(`${base}/account`, { headers: this.headers() });
              if (!res.ok) throw new Error(`account: ${res.status}`);
              ({ users = [] } = (await res.json()) as { users?: RosterUser[] });
            } catch (err) {
              new Notice('Could not load the organisation\'s members.');
              log.warn('Could not list the roster for a folder picker', { error: String(err) });
              return;
            }
            // The owner is a member already, so the roster minus the members
            // leaves them out without needing to know their own id here.
            new FolderMemberPickerModal(this.app, pickerCandidates(users, members, null), async (c) => {
              await this.post(c.id, c.label.split(' — ')[0], role);
              await this.render();
            }).open();
          }),
      );
  }

  private async post(userId: string, who: string, role: FolderRole): Promise<void> {
    const { base } = this.plugin.serverFor(this.folderId);
    const res = await serverFetch(`${base}/folders/${this.folderId}/members`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ userId, role }),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      new Notice(body.error ?? 'Could not change membership');
      return;
    }

    const { member } = (await res.json().catch(() => ({}))) as { member?: { userId: string } };
    // Only claim success if the key actually reached them. grantKey reports its
    // own failures, and a cheerful "is now editor" printed afterwards is the
    // last thing the user reads — which buries the one message that matters,
    // in the state that already looks exactly like a sync failure.
    const shared = member ? await this.grantKey(member.userId, who) : false;
    if (shared) new Notice(`${who} is now ${role}`);
  }

  /**
   * Seal this folder's keys to a new member.
   *
   * Access and readability are separate things here, and the server can only
   * grant the first: it has no folder key to give away. Without this the member
   * sees the folder and receives ciphertext they cannot decrypt, which looks
   * exactly like a sync failure.
   *
   * ECIES needs only the recipient's public key, so this works without the
   * folder's original owner being online — but it does need *this* client to
   * hold the folder key, which is why it reports plainly when it does not.
   */
  private async grantKey(userId: string, username: string): Promise<boolean> {
    const keys = this.plugin.folderCrypto.get(this.folderId);
    if (!keys) {
      new Notice(`${username} was added, but this device has no key for the folder to share.`);
      return false;
    }

    const { base } = this.plugin.serverFor(this.folderId);
    try {
      const res = await serverFetch(`${base}/folders/${this.folderId}/members`, {
        headers: this.headers(),
      });
      const { members } = (await res.json()) as { members: FolderMember[] };
      const recipient = members.find((m) => m.userId === userId);
      if (!recipient?.publicKey) {
        new Notice(`${username} has not enrolled encryption keys yet — no key was shared.`);
        return false;
      }

      const wrapped = await wrapKeysFor(keys, userId, recipient.publicKey);
      const put = await serverFetch(`${base}/folders/${this.folderId}/keys`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ keys: wrapped }),
      });
      if (!put.ok && put.status !== 409) {
        new Notice(`${username} was added, but the folder key could not be shared.`);
        return false;
      }
      return true;
    } catch (err) {
      new Notice(`${username} was added, but the folder key could not be shared.`);
      log.error('Could not grant a folder key', { userId, error: String(err) });
      return false;
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/**
 * Recover a forgotten password with the recovery key.
 *
 * Collects everything in one modal because the flow is atomic from the user's
 * point of view: recovering the master key without setting a new password
 * leaves them able to read nothing and log in nowhere, since `authHash` is
 * salted with the password itself and the old one is gone with it.
 */
class RecoveryModal extends Modal {
  private onSubmit: (result: { recoveryKey: string; password: string } | null) => void;
  private settled = false;

  constructor(
    app: App,
    onSubmit: (result: { recoveryKey: string; password: string } | null) => void,
  ) {
    super(app);
    this.onSubmit = onSubmit;
  }

  onOpen(): void {
    this.titleEl.setText('Recover with your recovery key');
    this.contentEl.createEl('p', {
      text:
        'Enter the recovery key you saved when you registered, and choose a new ' +
        'password. Your notes and every folder shared with you are unaffected.',
    });
    this.contentEl.createEl('p', {
      cls: 'setting-item-description',
      text:
        'Without the recovery key there is nothing to do here — the server cannot ' +
        'reset a password it has never seen. Case and dashes do not matter.',
    });

    let recoveryKey = '';
    let password = '';
    let confirm = '';

    const submit = (): void => {
      if (!recoveryKey.trim()) {
        new Notice('Enter your recovery key');
        return;
      }
      if (password.length < MIN_PASSWORD_LENGTH) {
        new Notice(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
        return;
      }
      if (password !== confirm) {
        new Notice('The two passwords do not match');
        return;
      }
      this.settle({ recoveryKey: recoveryKey.trim(), password });
      this.close();
    };

    new Setting(this.contentEl).setName('Recovery key').addText((text) => {
      text.setPlaceholder('XXXX-XXXX-XXXX-XXXX-XXXX').onChange((v) => (recoveryKey = v));
      window.setTimeout(() => text.inputEl.focus(), 0);
    });

    new Setting(this.contentEl).setName('New password').addText((text) => {
      text.inputEl.type = 'password';
      text.onChange((v) => (password = v));
    });

    new Setting(this.contentEl).setName('Confirm new password').addText((text) => {
      text.inputEl.type = 'password';
      text.onChange((v) => (confirm = v));
      text.inputEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') submit();
      });
    });

    new Setting(this.contentEl).addButton((btn) =>
      btn.setButtonText('Recover').setCta().onClick(submit),
    );
  }

  private settle(value: { recoveryKey: string; password: string } | null): void {
    if (this.settled) return;
    this.settled = true;
    this.onSubmit(value);
  }

  onClose(): void {
    this.settle(null);
    this.contentEl.empty();
  }
}

/** What one passphrase attempt came to. `fatal` means do not offer another. */
export type VerifyOutcome = { ok: true } | { ok: false; message: string; fatal?: boolean };

/**
 * How long to refuse the next attempt, after `failures` wrong ones.
 *
 * **This is a speed bump, not a security control, and must not be promoted into
 * one.** Anyone who can open this dialog can also read `data.json`, which holds
 * the salt, the iteration count *and* the wrapped private key — everything
 * needed to grind offline on a GPU without ever opening Obsidian. A counter
 * here stops none of that. What it does stop is somebody trying a handful of
 * guesses at a machine left unattended.
 *
 * So: no lockout, ever. A lockout would block nothing an attacker cannot route
 * around, while risking shutting the real owner out of their own folders — the
 * trade this codebase never takes. The first two attempts are free, because
 * typos are normal. See docs/key-storage.md.
 */
export function retryDelayMs(failures: number): number {
  if (failures <= 2) return 0;
  return Math.min(8_000, 1_000 * 2 ** (failures - 3));
}

/**
 * Asks for the passphrase so the identity key can be unwrapped, and keeps
 * asking until it opens.
 *
 * The check happens *here*, through `verify`, rather than after the dialog has
 * closed. It used to run in the caller, so a wrong passphrase could only
 * produce a toast against a dialog that was already gone, and the caller's only
 * recourse at sign-in was to treat one typo as a failed sign-in and tear the
 * session down. A wrong attempt is now answered in place.
 *
 * The master key is not stored, so nothing on disk can open a folder-key
 * envelope this device has not already cached. Folders already mapped never
 * reach this — they sync from their cached folder keys.
 *
 * Three callers, and the last two are easy to miss: confirming the passphrase
 * at sign-in, joining a folder (`loadFolderKeys`), and **Show names**, which
 * needs the identity key to read the sealed names of folders shared since the
 * last unlock. The last fires to render a list rather than to join anything.
 */
export class PasswordPromptModal extends Modal {
  private settled = false;
  private failures = 0;
  private busy = false;
  private password = '';
  private error: HTMLElement | null = null;
  private setDisabled: ((v: boolean) => void) | null = null;
  private clearInput: (() => void) | null = null;
  private countdown: ReturnType<typeof setInterval> | null = null;
  /** Wall-clock deadline for the pause. Enter bypasses a disabled button. */
  private blockedUntil = 0;

  constructor(
    app: App,
    private opts: {
      reason: string;
      verify: (password: string) => Promise<VerifyOutcome>;
      onDone: (unlocked: boolean) => void;
    },
  ) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText('Passphrase required');
    this.contentEl.createEl('p', { text: this.opts.reason });
    this.contentEl.createEl('p', {
      cls: 'setting-item-description',
      text:
        'Your passphrase is not stored and never leaves this device. It is needed here to ' +
        'unwrap your encryption key, and takes a moment to process.',
    });

    new Setting(this.contentEl).setName('Passphrase').addText((text) => {
      text.inputEl.type = 'password';
      text.onChange((v) => (this.password = v));
      text.inputEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') void this.attempt();
      });
      this.clearInput = () => {
        this.password = '';
        text.setValue('');
        text.inputEl.focus();
      };
      window.setTimeout(() => text.inputEl.focus(), 0);
    });

    // `mod-warning` is Obsidian's own, so this needs no rule in styles.css and
    // stays outside the nectenda-* contract styles-contract.test.ts enforces.
    this.error = this.contentEl.createEl('p', { cls: 'mod-warning' });
    this.error.hide();

    new Setting(this.contentEl)
      .addButton((btn) =>
        // Cancelling is a real choice and needs a button. There was none: the
        // only way out was Esc, which the caller could not tell from a wrong
        // passphrase, and which used to cost the whole session.
        btn.setButtonText('Cancel').onClick(() => this.close()),
      )
      .addButton((btn) => {
        btn.setButtonText('Unlock').setCta().onClick(() => void this.attempt());
        this.setDisabled = (v) => btn.setDisabled(v);
      });
  }

  private show(message: string): void {
    if (!this.error) return;
    this.error.setText(message);
    this.error.show();
  }

  private async attempt(): Promise<void> {
    // Guarded rather than trusted: Enter and the button both land here, and a
    // second press while the KDF is running would start a parallel derivation
    // against a dialog that may already have settled.
    if (this.busy || this.settled) return;
    // Checked here rather than only on the button: the field takes Enter too,
    // and disabling the button alone would let the keyboard walk past the pause.
    if (Date.now() < this.blockedUntil) return;
    if (!this.password) {
      this.show('Enter your passphrase.');
      return;
    }
    this.busy = true;
    this.setDisabled?.(true);
    this.show('Checking…');
    let outcome: VerifyOutcome;
    try {
      outcome = await this.opts.verify(this.password);
    } catch (err) {
      // verify is not meant to throw; if it does, say so rather than leaving
      // the dialog stuck on "Checking…".
      log.error('The passphrase check threw', { error: String(err) });
      outcome = { ok: false, message: 'Something went wrong checking that passphrase.' };
    }
    // The dialog may have been closed while the KDF ran. Everything below this
    // point either touches a detached element or re-settles a finished prompt.
    if (this.settled) return;
    this.busy = false;

    if (outcome.ok) {
      this.settle(true);
      this.close();
      return;
    }
    if (outcome.fatal) {
      // Not a typo — the caller has said something more specific and asked the
      // user not to try again until they know why. Offering another attempt
      // here would contradict it.
      this.settle(false);
      this.close();
      return;
    }

    this.failures += 1;
    this.clearInput?.();
    const wait = retryDelayMs(this.failures);
    this.blockedUntil = Date.now() + wait;
    if (wait === 0) {
      this.show(outcome.message);
      this.setDisabled?.(false);
      return;
    }
    let left = Math.ceil(wait / 1000);
    const tick = (): void => this.show(`${outcome.message} Try again in ${left}s.`);
    tick();
    this.countdown = setInterval(() => {
      left -= 1;
      if (left > 0) {
        tick();
        return;
      }
      this.stopCountdown();
      if (this.settled) return;
      this.show(outcome.message);
      this.setDisabled?.(false);
    }, 1_000);
  }

  private stopCountdown(): void {
    if (this.countdown === null) return;
    clearInterval(this.countdown);
    this.countdown = null;
  }

  private settle(unlocked: boolean): void {
    if (this.settled) return;
    this.settled = true;
    this.opts.onDone(unlocked);
  }

  onClose(): void {
    // Closing without unlocking has to resolve the caller, or a cancelled
    // prompt would leave whatever awaited it hanging for the session. Esc, the
    // background and Cancel all arrive here; the latch means a successful
    // unlock that closed the dialog itself is not overwritten.
    this.stopCountdown();
    this.settle(false);
    this.contentEl.empty();
  }
}

/**
 * Choose the encryption passphrase on the first device.
 *
 * Said plainly before it is chosen, not after: this passphrase cannot be reset
 * by anyone, and the recovery key that follows is the only way back.
 */
class SetPassphraseModal extends Modal {
  private onSubmit: (password: string | null) => void;
  private settled = false;

  constructor(app: App, onSubmit: (password: string | null) => void) {
    super(app);
    this.onSubmit = onSubmit;
  }

  onOpen(): void {
    this.titleEl.setText('Choose an encryption passphrase');
    this.contentEl.createEl('p', {
      text:
        'This passphrase protects every note you sync. It never leaves this device and nobody at ' +
        'Nectenda can reset it. You will be given a recovery key next — keep it somewhere safe.',
    });
    let first = '';
    let second = '';
    const submit = (): void => {
      if (first.length < MIN_PASSWORD_LENGTH) {
        new Notice(`Use at least ${MIN_PASSWORD_LENGTH} characters`);
        return;
      }
      if (first !== second) {
        new Notice('The two entries do not match');
        return;
      }
      this.settle(first);
      this.close();
    };
    new Setting(this.contentEl).setName('Passphrase').addText((text) => {
      text.inputEl.type = 'password';
      text.onChange((v) => (first = v));
      window.setTimeout(() => text.inputEl.focus(), 0);
    });
    new Setting(this.contentEl).setName('Again').addText((text) => {
      text.inputEl.type = 'password';
      text.onChange((v) => (second = v));
      text.inputEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') submit();
      });
    });
    new Setting(this.contentEl).addButton((btn) => btn.setButtonText('Set passphrase').setCta().onClick(submit));
  }

  private settle(value: string | null): void {
    if (this.settled) return;
    this.settled = true;
    this.onSubmit(value);
  }

  onClose(): void {
    this.settle(null);
    this.contentEl.empty();
  }
}

/** Invite someone to an organisation by email. The email is a notification; the invitation also shows in their settings. */
class InviteByEmailModal extends Modal {
  constructor(
    app: App,
    private readonly membership: StoredMembership,
    private readonly onSubmit: (email: string, role: 'member' | 'admin') => Promise<void>,
  ) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText(`Invite to ${this.membership.accountName}`);
    let email = '';
    let role: 'member' | 'admin' = 'member';
    new Setting(this.contentEl).setName('Email address').addText((text) => {
      text.setPlaceholder('name@example.com').onChange((v) => (email = v.trim()));
      window.setTimeout(() => text.inputEl.focus(), 0);
    });
    const roles = new Setting(this.contentEl).setName('Role');
    roles.addDropdown((drop) => {
      drop.addOption('member', 'Member');
      // Only an owner may make an admin; the service refuses otherwise.
      if (this.membership.role === 'owner') drop.addOption('admin', 'Admin');
      drop.setValue('member').onChange((v) => (role = v as 'member' | 'admin'));
    });
    new Setting(this.contentEl).addButton((btn) =>
      btn.setButtonText('Send invitation').setCta().onClick(async () => {
        if (!email.includes('@')) {
          new Notice('Enter an email address');
          return;
        }
        await this.onSubmit(email, role);
        this.close();
      }),
    );
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/** Naming an organisation you are about to create. */
class NameOrganisationModal extends Modal {
  constructor(
    app: App,
    private readonly suggestion: string,
    private readonly onSubmit: (name: string) => Promise<void>,
  ) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText('Create an organisation');
    let name = this.suggestion;
    this.contentEl.createEl('p', {
      cls: 'setting-item-description',
      text: 'An organisation holds shared folders and the people you share them with. '
        + 'It starts on the free plan: three people, text sync, no attachments.',
    });
    new Setting(this.contentEl).setName('Name').addText((text) => {
      text.setValue(this.suggestion).onChange((v) => (name = v.trim()));
      window.setTimeout(() => { text.inputEl.focus(); text.inputEl.select(); }, 0);
    });
    new Setting(this.contentEl).addButton((btn) =>
      btn.setButtonText('Create').setCta().onClick(async () => {
        if (!name) {
          new Notice('Give the organisation a name');
          return;
        }
        this.close();
        await this.onSubmit(name);
      }),
    );
  }

  onClose(): void {
    this.contentEl.empty();
  }
}


class FolderPickerModal extends FuzzySuggestModal<TFolder> {
  private folders: TFolder[];
  private onChoose: (folder: TFolder) => void;

  constructor(app: App, onChoose: (folder: TFolder) => void) {
    super(app);
    this.folders = this.getAllFolders();
    this.onChoose = onChoose;
    this.setPlaceholder('Pick a folder...');
  }

  private getAllFolders(): TFolder[] {
    const folders: TFolder[] = [];
    const root = this.app.vault.getRoot();
    const walk = (folder: TFolder) => {
      // Skip hidden folders
      if (folder.path.startsWith('.')) return;
      if (folder.path) folders.push(folder);
      for (const child of folder.children) {
        if (child instanceof TFolder) walk(child);
      }
    };
    walk(root);
    return folders.sort((a, b) => a.path.localeCompare(b.path));
  }

  getItems(): TFolder[] {
    return this.folders;
  }

  getItemText(item: TFolder): string {
    return item.path;
  }

  onChooseItem(item: TFolder): void {
    this.onChoose(item);
  }
}

export default class NectendaPlugin extends Plugin {
  settings: NectendaSettings = DEFAULT_SETTINGS;
  /**
   * Identifies this vault among the vaults sharing Obsidian's IndexedDB.
   *
   * `appId` is Obsidian's own per-vault id; the vault name is a fallback for
   * builds that do not expose it. See idb-name.ts for why this matters.
   */
  get vaultKey(): string {
    const app = this.app as unknown as { appId?: string };
    return app.appId ?? this.app.vault.getName();
  }
  /**
   * The unwrapped identity keypair for this session.
   *
   * Also held for the device where the OS provides a credential store, so the
   * passphrase is asked once per machine rather than once per vault — see
   * `deviceSecrets` and docs/key-storage.md. Not in memory only any more.
   */
  sessionKeys: SessionKeys | null = null;
  /** Every shared folder's keys, keyed by folder id. */
  folderCrypto = new FolderCryptoRegistry();
  /** Path-to-opaque-id translation for every shared folder. */
  docIndex = new DocIndex(this.folderCrypto);
  /** Where the token and folder keys are kept. Chosen at runtime. */
  secrets!: SecretStore;
  /**
   * Shared by every vault of this installation, and holding exactly one thing:
   * the identity key. Everything else stays in `secrets`, which is vault-scoped
   * on desktop, so signing one vault in does not sign in another.
   */
  deviceSecrets!: SecretStore;

  /**
   * This vault's name, sealed to the account, cached for the session.
   *
   * Held rather than computed per call because `describeDevice` is synchronous
   * and called from ten places on the connect path, while sealing is async.
   * Null until there is key material to seal to; a handshake that carries null
   * leaves the stored label alone rather than blanking it.
   */
  private sealedVaultLabel: string | null = null;
  /**
   * Bytes the server holds per folder, from the `/usage` answer it already
   * fetches. Only folders this account is billed for, and only as fresh as the
   * last refresh — a row omits the size rather than guessing at one.
   */
  private folderBytes = new Map<string, number>();

  /** What a shard is told about this machine and the vault asking. */
  deviceFields(): DeviceDescription {
    return describeDevice(this.app, this.secrets, this.sealedVaultLabel);
  }
  /**
   * One provider for the sync engine, however many servers sit behind it.
   *
   * On a self-hosted server the router holds one connection and every
   * document goes to it. On Nectenda Cloud it holds one per organisation and
   * routes by the folder id at the front of every document name.
   */
  provider: ProviderRouter | null = null;
  contentSync: ContentSync | null = null;
  editorBridge: EditorBridge | null = null;
  folderIndicator: FolderIndicator | null = null;
  fileSync: FileSync | null = null;
  blobSync: BlobSync | null = null;
  /** What this device has learned it cannot open. Survives a crash. */
  deviceState: DeviceStateStore | null = null;
  /** Crash reporting; see `installErrorReports`. Null only before `onload` has run. */
  errorReports: ErrorReports | null = null;
  vaultWatcher: VaultWatcher | null = null;
  statusBarItem: HTMLElement | null = null;
  // Registered ONCE in onload — EditorBridge mutates this array
  private collabExts: Extension[] = [];

  /**
   * Measure what sealing a large attachment costs, from inside the app.
   *
   * Exposed only when NECTENDA_PROBE is set, which the e2e harness does and a
   * user never does. It exists because the streaming upload's whole
   * justification is a memory claim, and a memory claim never measured inside
   * the real runtime is an assumption.
   */
  private installProbe(): void {
    const env = (globalThis as unknown as { process?: { env?: Record<string, string> } }).process?.env;
    if (!env?.NECTENDA_PROBE) return;
    (globalThis as unknown as Record<string, unknown>).nectendaProbe = async (
      path: string,
      size: number,
    ) => {
      const { sealBlobStream, generateBlobKey, newBlobId } = await import('@nectenda/shared');
      const vault = new ObsidianVaultAdapter(this.app.vault);
      const mem = (): { external: number; rss: number } | undefined =>
        (globalThis as unknown as {
          process?: { memoryUsage?(): { external: number; rss: number } };
        }).process?.memoryUsage?.();
      const mb = (n?: number): number | null => (n === undefined ? null : Math.round(n / 1048576));

      const before = mem();
      let peakExternal = before?.external ?? 0;
      let bytes = 0;
      const key = await generateBlobKey();
      const meta = await sealBlobStream(
        key, newBlobId(), vault.readBinaryChunks(path), { size },
        (part) => {
          bytes += part.length;
          const m = mem();
          if (m && m.external > peakExternal) peakExternal = m.external;
        },
      );
      const after = mem();
      return {
        fileMb: Math.round(size / 1048576),
        sealedMb: Math.round(bytes / 1048576),
        chunks: meta.totalChunks,
        beforeExternalMb: mb(before?.external),
        peakExternalMb: mb(peakExternal),
        afterExternalMb: mb(after?.external),
        afterRssMb: mb(after?.rss),
      };
    };
  }

  async onload() {
    this.installProbe();
    await this.loadSettings();

    // Chosen before anything reads a secret. On 1.11.4+ this is the keychain —
    // on desktop only when the OS really provides encryption, on mobile always,
    // because the check is hardcoded true there (see secret-store.ts).
    // Otherwise it is the same data.json as before, which is honest rather than
    // good.
    this.secrets = createSecretStore(this.app, {
      read: () => this.settings.secrets ?? {},
      write: (values) => {
        this.settings.secrets = values;
        void this.saveSettings();
      },
    });
    await this.migrateSecrets();
    this.deviceSecrets = createDeviceStore(this.secrets);

    // After the secret store, because the install id comes from it, and before
    // anything that could throw on a first run.
    this.installErrorReports();

    // Records left by folders this vault used to map. They only ever
    // accumulated, so a vault that has unmapped anything is carrying some.
    this.pruneAttachmentRecords();

    await this.openDeviceState();

    this.applyDiagnosticLogSetting();

    // Kept: the pane is rendered from definitions that depend on whether
    // this vault is signed in, and Obsidian reads them when the tab is added
    // and when told to. A sign-in or sign-out tells it (`refreshSettingsPane`).
    this.settingTab = new NectendaSettingTab(this.app, this);
    this.addSettingTab(this.settingTab);
    this.registerSkippedAttachmentMarkers();

    // obsidian://nectenda?invite=<id> from an invitation email, or
    // obsidian://nectenda?key=nk_… from a share link. Navigation only: no
    // token ever travels through a deep link, and a sign-in never completes
    // through one — that is what the browser poll is for.
    this.registerObsidianProtocolHandler('nectenda', (params) => {
      void this.handleDeepLink(params as Record<string, string>);
    });

    this.statusBarItem = this.addStatusBarItem();
    this.updateStatusBar('disconnected');

    // Register extension array exactly once
    this.registerEditorExtension(this.collabExts);

    if (this.isSignedIn()) {
      // The identity keypair comes back from the device store where the OS
      // provides one, so a folder shared since the last unlock opens without a
      // prompt. A miss is normal and must not stop the start: folders already
      // mapped sync from their cached folder keys and need no identity at all.
      // The master key is still never stored. See docs/key-storage.md.
      const held = await this.restoreIdentity();
      if (held) this.sessionKeys = { identity: held };

      if (this.settings.masterKey) {
        this.settings.masterKey = '';
        await this.saveSettings();
        log.info('Cleared a cached master key — it is no longer kept on disk');
      }

      await this.restoreFolderKeys();
      // Before the connect, not beside it: the handshake carries this vault's
      // sealed name and reads it synchronously.
      await this.cacheVaultLabel();
      this.startSync();

      // Cloud: the stored sessions start syncing at once; the identity service
      // is asked afterwards, in the background, whether anything changed — a
      // new invitation, a moved organisation, a renamed one. If it is down,
      // nothing here waits for it. That is the point of direct connections.
      if (this.settings.mode === 'cloud') void this.refreshMemberships().catch(() => undefined);
      // Likewise in the background, and likewise not waited on: it only decides
      // whether this vault's row in somebody's own device list reads as its
      // real name or as the anonymous fallback. A rename of the vault lands
      // here on the next start.
      void this.publishVaultLabel().catch(() => undefined);
    }
  }

  // -------------------------------------------------------------------------
  // Which server, for which folder
  // -------------------------------------------------------------------------

  /** Signed in to either kind of server. */
  isSignedIn(): boolean {
    return this.settings.mode === 'cloud' ? !!this.settings.identity : !!this.settings.token;
  }

  /**
   * Signed in and enrolled, but the identity key is not open on this device.
   *
   * The last clause is the one worth explaining. Where there is no credential
   * store — a Linux box with no keyring — this state is *normal* at every
   * start: nothing was kept, so nothing was restored, and the passphrase is
   * asked when a folder needs it. Treating that as "locked" would strip the
   * settings pane down on every launch for a device working exactly as
   * designed. So it only counts as locked where the key could have been held
   * and was not.
   */
  isLocked(): boolean {
    return (
      this.settings.mode === 'cloud'
      && !!this.settings.identity
      && !!this.settings.keyMaterial?.publicKey
      && !this.sessionKeys?.identity
      && (this.deviceSecrets?.kind ?? 'none') !== 'none'
    );
  }

  /** One server the vault talks to, as the HTTP helpers need it. */
  serverFor(folderId: string): { base: string; token: string; endpoint: string; membershipId: string | null } {
    if (this.settings.mode !== 'cloud') {
      return { base: apiBaseUrl(this.settings.serverUrl), token: this.settings.token, endpoint: this.settings.serverUrl, membershipId: null };
    }
    const mapping = this.settings.folderMappings.find((m) => m.sharedFolderId === folderId);
    const m =
      (mapping?.membershipId ? this.settings.memberships.find((x) => x.id === mapping.membershipId) : undefined) ??
      // An unmapped folder can only belong to the one organisation there is.
      (this.settings.memberships.length === 1 ? this.settings.memberships[0] : undefined);
    if (!m) throw new Error(`No sync server is known for folder ${folderId}`);
    return { base: apiBaseUrl(m.endpoint), token: m.token, endpoint: m.endpoint, membershipId: m.id };
  }

  /** The server a membership names, for calls made before any folder is mapped. */
  serverForMembership(id: string | null): { base: string; token: string; endpoint: string; membershipId: string | null } {
    if (this.settings.mode !== 'cloud' || !id) return this.serverFor('');
    const m = this.settings.memberships.find((x) => x.id === id);
    if (!m) throw new Error('That organisation is no longer available');
    return { base: apiBaseUrl(m.endpoint), token: m.token, endpoint: m.endpoint, membershipId: m.id };
  }

  /** Every server, labelled for the settings tab. Self-hosted has exactly one. */
  servers(): Array<{ membershipId: string | null; label: string; base: string; token: string; endpoint: string; role: string | null; status: string; localUserId: string | null; localUsername: string | null }> {
    if (this.settings.mode !== 'cloud') {
      return [{ membershipId: null, label: this.settings.serverUrl, base: apiBaseUrl(this.settings.serverUrl), token: this.settings.token, endpoint: this.settings.serverUrl, role: null, status: 'active', localUserId: null, localUsername: this.settings.username }];
    }
    return this.settings.memberships.map((m) => ({
      membershipId: m.id, label: m.accountName, base: apiBaseUrl(m.endpoint), token: m.token, endpoint: m.endpoint, role: m.role, status: m.accountStatus, localUserId: m.localUserId, localUsername: null,
    }));
  }

  /** Folder id → connection id, from the mappings. Self-hosted needs none. */
  private folderRoutes(): Record<string, string> {
    if (this.settings.mode !== 'cloud') return {};
    const routes: Record<string, string> = {};
    for (const m of this.settings.folderMappings) if (m.membershipId) routes[m.sharedFolderId] = m.membershipId;
    return routes;
  }

  /** The connections the settings describe, each with its own socket. */
  private buildConnections(): ShardConnection[] {
    if (this.settings.mode !== 'cloud') {
      return [{ id: 'self-hosted', endpoint: this.settings.serverUrl, token: this.settings.token, accountId: null, provider: new MultiplexedProvider(this.settings.serverUrl, this.settings.token, this.folderCrypto) }];
    }
    return this.settings.memberships
      .filter(syncsHere)
      .map((m) => ({ id: m.id, endpoint: m.endpoint, token: m.token, accountId: m.accountId, provider: new MultiplexedProvider(m.endpoint, m.token, this.folderCrypto) }));
  }

  /** The largest attachment the account accepts; Infinity when the server said none. */
  maxBlobBytes(): number {
    const cached = this.settings.maxBlobBytes;
    if (cached === -1) return Number.POSITIVE_INFINITY;
    return cached > 0 ? cached : DEFAULT_MAX_BLOB_BYTES;
  }

  // -------------------------------------------------------------------------
  // Nectenda Cloud
  // -------------------------------------------------------------------------

  identityClient(): IdentityClient {
    return new IdentityClient(this.settings.identityUrl || DEFAULT_IDENTITY_URL);
  }

  /**
   * A completed sign-in, from the browser poll, a typed code, or recovery.
   *
   * Stores the identity and its tokens, exchanges the identity token for a
   * session on every sync server the person belongs to, then starts syncing.
   * The passphrase step is separate and comes after: nothing here needs a key.
   */
  /**
   * Bumped by every sign-in and sign-out. A decision that spans an await —
   * such as asking the identity service whether a refused session is really
   * over — captures it first and gives up if it has moved, because whoever
   * moved it owns the outcome now.
   */
  sessionGeneration = 0;
  private signingIn = false;

  async applyCloudSignIn(result: SignInResult, via: 'sign-in' | 'refresh' = 'sign-in'): Promise<void> {
    this.sessionGeneration += 1;
    this.signingIn = true;
    try {
      await this.applySignIn(result, via);
    } finally {
      this.signingIn = false;
    }
  }

  private async applySignIn(result: SignInResult, via: 'sign-in' | 'refresh'): Promise<void> {
    // The diagnostic log used to be silent here, and a sign-out could only
    // be dated by the sockets it dropped.
    log.info('Signed in to Nectenda Cloud', { userId: result.user.id, sid: sessionIdFromToken(result.accessToken), memberships: result.memberships.length, via });
    this.settings.mode = 'cloud';
    this.settings.identity = {
      userId: result.user.id, email: result.user.email, displayName: result.user.displayName, identityUrl: this.settings.identityUrl || DEFAULT_IDENTITY_URL,
    };
    this.settings.identityAccessToken = result.accessToken;
    this.settings.refreshToken = result.refreshToken;
    this.settings.pendingInvites = result.invites ?? [];
    this.settings.keyMaterial = {
      publicKey: result.keyMaterial.publicKey,
      wrappedPrivateKey: result.keyMaterial.wrappedPrivateKey,
      recoveryBlob: result.keyMaterial.recoveryBlob,
      recoveryParams: (result.keyMaterial.recoveryParams as KdfParams | null) ?? null,
      kdfParams: (result.keyMaterial.kdfParams as KdfParams | null) ?? null,
    };
    // A sign-in adds this device to every organisation's roster that has
    // room. One that is full refuses it, keeps the seat, and is named here:
    // the person can free a slot there and add this device from the account.
    const { memberships, unreachable } = await establishMemberships(
      result.identityToken, result.memberships, this.settings.memberships, this.deviceFields(), undefined, { enrol: true },
    );
    this.settings.memberships = memberships;
    await this.saveSettings();
    if (unreachable.length) new Notice(`Nectenda: ${unreachable.length} server(s) could not be reached; they will be retried.`);
    this.reportRefusedDevice(memberships);
    this.stopSync();
    this.startSync();
    this.refreshSettingsPane();
  }

  settingTab: NectendaSettingTab | null = null;

  /**
   * Re-read the settings pane's definitions: the signed-in state changed, so
   * the sections it is made of changed. Cheap when the pane is closed — the
   * result is stored for the next open — and a rebuild when it is showing,
   * which is the same wipe a redraw always was.
   */
  refreshSettingsPane(): void {
    // `update()` arrived with Obsidian 1.13's definitions API. An older
    // Obsidian never reads the definitions and draws nothing from them, so
    // there is nothing to rebuild — and nothing to throw over.
    (this.settingTab as { update?: () => void } | null)?.update?.();
  }

  /**
   * Rotate the device session and re-establish every shard session.
   *
   * False when the refresh token is dead — revoked from another device, or
   * its reuse was detected — in which case the caller signs out. A network
   * failure is not that: it throws, and the caller keeps what it has.
   */
  /**
   * One refresh at a time. Refresh tokens rotate, and presenting one that
   * has already been rotated out is what a stolen token looks like, so the
   * identity service ends the whole session on it. Three settings loaders
   * refused in the same moment used to present the same token three times
   * and sign the vault out of its own accord (14 September 2026).
   */
  private readonly refreshGate = new SingleFlight<boolean>();

  /**
   * True when the session is usable again; false when the identity service
   * refused it. Throws on the network.
   *
   * `refusedAccessToken` is the token the caller was refused with. If it is
   * no longer the stored one, a refresh already landed between the refusal
   * and this call, and there is nothing to do.
   */
  async refreshCloudSession(opts: { caller: string; refusedAccessToken?: string } = { caller: 'unknown' }): Promise<boolean> {
    if (opts.refusedAccessToken !== undefined && opts.refusedAccessToken !== this.settings.identityAccessToken) {
      log.info('Cloud session already refreshed', { caller: opts.caller });
      return true;
    }
    if (this.refreshGate.pending) log.info('Joined the in-flight Cloud session refresh', { caller: opts.caller });
    return this.refreshGate.run(() => this.doRefreshCloudSession(opts.caller));
  }

  private async doRefreshCloudSession(caller: string): Promise<boolean> {
    if (!this.settings.refreshToken) return false;
    try {
      const result = await this.identityClient().refresh(this.settings.refreshToken, describeInstall(this.app, this.secrets));
      await this.applyCloudSignIn(result, 'refresh');
      log.info('Cloud session refreshed', { caller, sid: sessionIdFromToken(result.accessToken) });
      return true;
    } catch (err) {
      if (err instanceof IdentityError && err.status === 401) {
        log.warn('Cloud session refresh refused', { caller, status: err.status, code: err.code ?? null });
        return false;
      }
      log.warn('Cloud session refresh failed', { caller, error: String(err) });
      throw err;
    }
  }

  /**
   * The identity service refused the access token: refresh, or sign out.
   *
   * For the settings pane's loaders, which used to swallow a 401 and show
   * nothing — leaving a signed-out install looking signed in until the next
   * restart. True when the session is usable again; false when it is over and
   * this install has been signed out. Throws on the network, like the refresh.
   */
  async recoverIdentitySession(caller = 'pane', refusedAccessToken?: string): Promise<boolean> {
    if (this.settings.mode !== 'cloud' || !this.settings.identity) return false;
    if (await this.refreshCloudSession({ caller, refusedAccessToken })) return true;
    await this.signOutCloud('Your Nectenda Cloud session has ended. Sign in again.', { skipLogout: true });
    return false;
  }

  /**
   * A sync server closed a connection because its session is no longer
   * accepted. The decision itself lives in signed-out.ts; this supplies it
   * with the plugin's parts, and the generation guard.
   */
  private async handleSignedOutConnection(id: string): Promise<void> {
    if (this.signingIn) return;
    const gen = this.sessionGeneration;
    const outcome = await recoverSignedOutConnection({
      probe: async () => {
        try {
          await this.identityClient().me(this.settings.identityAccessToken);
          return 'alive';
        } catch (err) {
          return err instanceof IdentityError && err.status === 401 ? 'refused' : 'unreachable';
        }
      },
      refresh: () => this.refreshCloudSession({ caller: 'signed-out connection' }),
      remint: () => this.refreshMemberships(),
      reconnect: () => this.provider?.get(id)?.provider.connect(),
      signOut: () => this.signOutCloud('This device was signed out from another device. Sign in again to continue syncing.', { skipLogout: true }),
      retryLater: () => {
        setTimeout(() => void this.handleSignedOutConnection(id), 30_000);
      },
      stillCurrent: () => gen === this.sessionGeneration && !this.signingIn,
    });
    log.info('Refused session handled', { connection: id, outcome });
  }

  /**
   * Folders whose server copy is gone, so `refreshSync` stops reconnecting
   * them. Cleared when the mapping goes, which is the person's own decision.
   */
  readonly goneFolders = new Set<string>();

  /**
   * A folder was unshared on the server. Stop syncing it; touch nothing on
   * disk.
   *
   * The notes are the one thing here that cannot be reconstructed, and they
   * are not the server's to withdraw: the member keeps every file and every
   * key. Unbinding is safe because the only path that deletes a local file is
   * the listing's delete observer, and that is being detached, not fired.
   */
  handleFolderGone(folderId: string): void {
    const mapping = this.settings.folderMappings.find((m) => m.sharedFolderId === folderId);
    // Already unmapped, or never ours: a late frame on a socket we still hold.
    if (!mapping) return;
    if (this.goneFolders.has(folderId)) return;
    this.goneFolders.add(folderId);
    log.info('A shared folder was unshared on the server', { folderId, localPath: mapping.localPath });
    this.fileSync?.disconnectFolder(folderId);
    this.contentSync?.disconnectFolder(folderId);
    this.blobSync?.disconnectFolder(folderId);
    this.editorBridge?.reconnectActiveFile();
    this.folderIndicator?.refresh();
    new Notice(
      `"${mapping.sharedFolderName}" was unshared by its owner. Your notes stay in this vault; Nectenda has stopped syncing them.`,
      12000,
    );
    // The pane redraws and lists it under "No longer shared", where unmapping
    // is the last step.
    this.notifyChange('structure');
  }

  /** Ask the identity service what changed: memberships, invitations, names. */
  async refreshMemberships(): Promise<void> {
    if (this.settings.mode !== 'cloud' || !this.settings.identity) return;
    const client = this.identityClient();
    let me;
    const token = this.settings.identityAccessToken;
    try {
      me = await client.me(token);
    } catch (err) {
      if (!(err instanceof IdentityError && err.status === 401)) throw err;
      if (!(await this.refreshCloudSession({ caller: 'memberships', refusedAccessToken: token }))) {
        await this.signOutCloud('Your Nectenda Cloud session has ended. Sign in again.', { skipLogout: true });
      }
      return;
    }
    this.settings.identity = { ...this.settings.identity, email: me.user.email, displayName: me.user.displayName };
    // Where this server wants crash reports. Cached so that a later start
    // with no network can still report, and cleared at sign-out beside the
    // keys, because it belongs to the server that named it. A server that
    // names none — every self-hosted one — leaves this empty and nothing is
    // ever sent.
    this.settings.errorReportDsn = me.errorReporting?.dsn ?? '';
    this.maybeAskAboutErrorReports();
    this.settings.pendingInvites = me.invites ?? [];
    this.settings.keyMaterial = {
      publicKey: me.keyMaterial.publicKey, wrappedPrivateKey: me.keyMaterial.wrappedPrivateKey, recoveryBlob: me.keyMaterial.recoveryBlob,
      recoveryParams: (me.keyMaterial.recoveryParams as KdfParams | null) ?? null, kdfParams: (me.keyMaterial.kdfParams as KdfParams | null) ?? null,
    };
    // The token is deliberately not in this fingerprint. The shard mints a
    // fresh one on every session call — same claims, new issue time — so the
    // string differs on every refresh, and comparing it made every press of
    // Refresh tear down and rebuild every socket, announcing a lost
    // connection each time. The fresh token is still stored: it is what the
    // next reconnect will use. It is just not a reason to reconnect now.
    const shape = membershipShape;
    const before = shape(this.settings.memberships);
    // A refresh asks where this device stands; it does not add it — a slot
    // freed for one device must not go to whichever other refreshes next.
    // Until every membership carries a roster report the device has never
    // been offered: an install from before rosters, or a seat that appeared
    // through the directory while this vault was closed. Those enrol once.
    const enrol = this.settings.memberships.some((m) => !m.device);
    // A seat taken moments ago by share link or invitation is not in the
    // identity service's mirror until its next pull of that shard, up to a
    // minute later. It is asked about all the same, from what this vault
    // knows of it: the sync server is the authority on the seat and on this
    // device's standing there, and only it can say the seat is gone. Keeping
    // it unasked until the mirror caught up left a device that had just been
    // removed from the roster knocking on a closed door for a minute.
    const listed = new Set(me.memberships.map((x) => membershipId(x.shardId, x.accountId)));
    const unlisted = this.settings.memberships
      .filter((m) => !listed.has(m.id) && m.token && m.accountStatus !== 'moved')
      .map((m) => ({
        accountId: m.accountId, accountName: m.accountName, accountStatus: m.accountStatus, role: m.role, userId: m.localUserId ?? '',
        shardId: m.shardId, endpoint: m.endpoint, region: m.region, displayName: this.settings.identity?.displayName ?? '',
      }));
    const { memberships } = await establishMemberships(me.identityToken, [...me.memberships, ...unlisted], this.settings.memberships, this.deviceFields(), undefined, { enrol });
    this.settings.memberships = memberships;
    await this.saveSettings();
    const after = shape(memberships);
    // Fresh tokens reach the live connections in place, whatever else changed.
    for (const m of memberships) this.provider?.updateToken(m.id, m.token);
    // A changed endpoint (an organisation moved) or a new token restarts only
    // what changed; the rest keeps its socket and its unsent work.
    if (before !== after) this.reconcileConnections();
    // Read the provider's own word for it rather than collapsing everything
    // that is not yet connected into "disconnected": straight after a reconcile
    // it is connecting, and saying otherwise for that moment was a lie.
    const status = this.provider?.status();
    if (status === 'connected') this.updateStatusBar('connected');
    else if (status === 'connecting') this.updateStatusBar('offline');
    else if (status === 'idle') this.updateStatusBar('idle');
    else this.updateStatusBar('disconnected');
    if (enrol) this.reportRefusedDevice(memberships);
    this.notifyChange('memberships');
  }

  /** Bring the live connections into line with the stored memberships. */
  private reconcileConnections(): void {
    if (!this.provider) return;
    const wanted = new Map(this.buildConnections().map((c) => [c.id, c]));
    for (const live of this.provider.list()) {
      const want = wanted.get(live.id);
      if (!want || want.endpoint !== live.endpoint) {
        // Gone, or moved to another server: the socket has to go.
        this.provider.remove(live.id);
        if (want) this.provider.add(want);
      } else if (want.token !== live.token) {
        // Same server, fresh token: hand it over for the next reconnect and
        // leave the socket alone. This used to be a teardown, which is why
        // every refresh looked like a dropped connection.
        this.provider.updateToken(live.id, want.token);
      }
      wanted.delete(live.id);
    }
    for (const c of wanted.values()) this.provider.add(c);
    this.provider.setFolderRoutes(this.folderRoutes());
    this.refreshSync();
  }

  /**
   * Accept an invitation from inside Obsidian.
   *
   * The identity service signs the invitation for the shard; the shard checks
   * it offline, takes a seat, and answers with a session. The public key goes
   * up with the join so members can wrap folder keys for this person, which is
   * why a passphrase must have been set first.
   */
  /**
   * This account's public key, for the paths that take a seat somewhere.
   *
   * Only the public half. Joining or creating an organisation uploads it so
   * other members can wrap folder keys to you; none of those paths touches the
   * private key, so none of them needs the identity unlocked. An earlier
   * version demanded one, on the reasoning that the old guard misled somebody
   * enrolled but locked — which was wrong, because the guard only fires when
   * nothing is enrolled at all. It cost ten e2e failures.
   *
   * Returns the key rather than a boolean so the callers that need it are
   * narrowed by the same check that guards them.
   */
  private requireEnrolledPublicKey(action: string): string {
    const publicKey = this.settings.keyMaterial?.publicKey;
    if (!publicKey) throw new Error(`Set your encryption passphrase before ${action}`);
    return publicKey;
  }

  async acceptInvite(inviteId: string): Promise<StoredMembership> {
    if (!this.settings.identity) throw new Error('Sign in to Nectenda Cloud first');
    const ownPublicKey = this.requireEnrolledPublicKey('joining an organisation');
    const client = this.identityClient();
    const grant = await client.acceptInvite(this.settings.identityAccessToken, inviteId);
    const { session } = await new ShardClient(grant.endpoint).join({
      identityToken: grant.identityToken, inviteToken: grant.inviteToken, publicKey: ownPublicKey, displayName: this.settings.identity.displayName,
      ...this.deviceFields(),
    });
    await client.inviteJoined(this.settings.identityAccessToken, inviteId).catch(() => undefined);
    const m: StoredMembership = {
      id: membershipId(grant.shardId, grant.accountId), accountId: grant.accountId, accountName: session.accountName ?? grant.accountId, accountStatus: session.accountStatus,
      role: session.accountRole, shardId: grant.shardId, endpoint: grant.endpoint, region: grant.region, localUserId: session.user.id,
      ...(await this.sessionWithDevice(grant.endpoint, grant.identityToken, grant.accountId, session)),
    };
    this.reportRefusedDevice([m]);
    this.settings.memberships = [...this.settings.memberships.filter((x) => x.id !== m.id), m];
    this.settings.pendingInvites = this.settings.pendingInvites.filter((i) => i.id !== inviteId);
    await this.saveSettings();
    this.reconcileConnections();
    this.notifyChange('memberships');
    return m;
  }

  /**
   * Join with a share link: `nk_…`, optionally with the server it belongs to.
   * Without one, the identity service says which server holds the key — by
   * hash, so the key itself never leaves this device until the join.
   */
  /**
   * An organisation of this person's own.
   *
   * The third way to hold a seat, and the only one that needs nobody else.
   * Both of the others — an invitation addressed to you, a share key someone
   * sent — require a person who already owns an organisation, so a customer
   * who signed in first had no way in at all.
   *
   * The identity service says which sync server should hold it; that server
   * creates it and makes the caller its owner, on the free plan. Recording the
   * membership locally rather than waiting for the directory to notice is the
   * same thing `joinByShareKey` does, and for the same reason: the seat exists
   * the moment the shard says so, and the manifest pull is minutes behind.
   */
  /**
   * The session a joined organisation should actually run on.
   *
   * A join hands back a session minted from the identity token the plugin
   * fetched from `/api/me`, and that token names no device — so the socket it
   * opens is unnamed on the server, and this vault's own row under "Your
   * devices" cannot show as connected until some later reconnect. The
   * session route takes the device fields, records the device with its
   * label, and returns a token that carries its id, exactly as a sign-in
   * does. One extra request, once, at the moment the seat is taken.
   *
   * Falls back to the join's own token if the server cannot be asked again:
   * a seat with an unnamed socket beats no seat.
   */
  private async sessionWithDevice(endpoint: string, identityToken: string, accountId: string, fallback: ShardSession): Promise<{ token: string; device?: StoredMembership['device'] }> {
    try {
      const sessions = await new ShardClient(endpoint).session(identityToken, this.deviceFields(), { enrol: true });
      const mine = sessions.find((s) => s.accountId === accountId);
      if (mine) return { token: mine.token, ...(mine.device ? { device: deviceOf(mine.device) } : {}) };
    } catch (err) {
      log.warn('Could not take a device-bearing session after joining; using the join token', { error: String(err) });
    }
    return { token: fallback.token, ...(fallback.device ? { device: deviceOf(fallback.device) } : {}) };
  }

  /**
   * Said once per sign-in, naming the organisations that refused this device.
   * The seat is real and the notes stay local; what is missing is a slot.
   */
  private reportRefusedDevice(memberships: StoredMembership[]): void {
    const refused = memberships.filter((m) => m.device && !m.device.enrolled);
    if (!refused.length) return;
    const names = refused.map((m) => `${m.accountName} (all ${m.device!.max} of your device slots are in use)`).join(', ');
    new Notice(`Nectenda: this device could not be added to ${names}. Remove a device there, or add this one, from Settings → Nectenda.`, 15000);
  }

  async createOrganisation(name: string): Promise<StoredMembership> {
    if (!this.settings.identity) throw new Error('Sign in to Nectenda Cloud first');
    const ownPublicKey = this.requireEnrolledPublicKey('creating an organisation');
    const client = this.identityClient();
    const where = await client.placement(this.settings.identityAccessToken);
    const me = await client.me(this.settings.identityAccessToken);
    const { session } = await new ShardClient(where.endpoint).join({
      identityToken: me.identityToken,
      newAccountName: name,
      publicKey: ownPublicKey,
      displayName: this.settings.identity.displayName,
      ...this.deviceFields(),
    });
    const m: StoredMembership = {
      id: membershipId(where.shardId, session.accountId),
      accountId: session.accountId,
      accountName: session.accountName ?? name,
      accountStatus: session.accountStatus,
      role: session.accountRole,
      shardId: where.shardId,
      endpoint: where.endpoint,
      region: where.region,
      localUserId: session.user.id,
      ...(await this.sessionWithDevice(where.endpoint, me.identityToken, session.accountId, session)),
    };
    this.settings.memberships = [...this.settings.memberships.filter((x) => x.id !== m.id), m];
    await this.saveSettings();
    this.reconcileConnections();
    // The settings pane lists organisations as pages, read only when told
    // the list changed: without this a join made from the pane itself never
    // appears until the pane is rebuilt for another reason.
    this.notifyChange('memberships');
    return m;
  }

  async joinByShareKey(shareKey: string, endpoint?: string): Promise<StoredMembership> {
    if (!this.settings.identity) throw new Error('Sign in to Nectenda Cloud first');
    const ownPublicKey = this.requireEnrolledPublicKey('joining an organisation');
    const client = this.identityClient();
    let target = endpoint;
    let shardId = '';
    if (!target) {
      const found = await client.lookupShareKey(await hashCredential(shareKey));
      target = found.endpoint;
      shardId = found.shardId;
    }
    const me = await client.me(this.settings.identityAccessToken);
    const { session } = await new ShardClient(target).join({
      identityToken: me.identityToken, shareKey, publicKey: ownPublicKey, displayName: this.settings.identity.displayName,
      ...this.deviceFields(),
    });
    if (!shardId) shardId = session.shardId ?? me.memberships.find((x) => x.endpoint === target)?.shardId ?? new URL(target.replace(/^ws/, 'http')).hostname.split('.')[0];
    const m: StoredMembership = {
      id: membershipId(shardId, session.accountId), accountId: session.accountId, accountName: session.accountName ?? session.accountId, accountStatus: session.accountStatus,
      role: session.accountRole, shardId, endpoint: target, region: '', localUserId: session.user.id,
      ...(await this.sessionWithDevice(target, me.identityToken, session.accountId, session)),
    };
    this.reportRefusedDevice([m]);
    this.settings.memberships = [...this.settings.memberships.filter((x) => x.id !== m.id), m];
    await this.saveSettings();
    this.reconcileConnections();
    // The settings pane lists organisations as pages, read only when told
    // the list changed: without this a join made from the pane itself never
    // appears until the pane is rebuilt for another reason.
    this.notifyChange('memberships');
    return m;
  }

  /**
   * Sign this install out.
   *
   * `skipLogout` is for the forced sign-outs: the identity service has
   * already refused the session, so telling it again is a round trip against
   * a dead token, and it fires at exactly the moment the service may be the
   * thing that is failing.
   */
  async signOutCloud(reason?: string, opts: { skipLogout?: boolean } = {}): Promise<void> {
    log.info('Signed out of Nectenda Cloud', {
      reason: reason ?? null, forced: !!opts.skipLogout, mappings: this.settings.folderMappings.length, cachedKeys: Object.keys(this.settings.folderKeys ?? {}).length,
    });
    this.sessionGeneration += 1;
    this.stopSync();
    // Tell the identity service before forgetting how to. Signing out used to
    // be entirely local, which left this install's session live for ninety
    // days: still listed under Signed-in devices in every other vault, and
    // still a working refresh token that nobody held. Best-effort, because the
    // forced sign-outs fire when the session is already dead and an offline
    // sign-out must still complete here.
    if (this.settings.refreshToken && !opts.skipLogout) {
      await this.identityClient().logout(this.settings.refreshToken).catch((err) => {
        log.warn('Could not retire the session on the identity service', { error: String(err) });
      });
    }
    this.settings.identity = null;
    this.settings.identityAccessToken = '';
    this.settings.refreshToken = '';
    this.settings.memberships = [];
    this.settings.pendingInvites = [];
    // A sign-out the person asked for takes the folder mappings with it. One
    // forced by a refused session keeps them: they hold no secret, and the
    // next sign-in then finds its folders waiting under Locked, to be opened
    // with the passphrase, rather than asking for every one to be mapped
    // again. Which folders were discarded is in the log line above.
    if (!opts.skipLogout) this.settings.folderMappings = [];
    // Before keyMaterial goes, because the id is derived from its public key —
    // clearing it first would make this a silent no-op and leave the key behind.
    // Unconditional: a forced sign-out says nothing about the passphrase, but a
    // device-wide private key for an account this device is no longer signed
    // into is exactly what should not be left.
    await this.forgetIdentity();
    this.forgetVaultLabel();
    this.settings.keyMaterial = null;
    for (const folderId of Object.keys(this.settings.folderKeys ?? {})) this.folderCrypto.remove(folderId);
    this.settings.folderKeys = {};
    // The crash-report endpoint belongs to the server that named it.
    this.settings.errorReportDsn = '';
    this.sessionKeys = null;
    await this.saveSettings();
    this.refreshSettingsPane();
    if (reason) new Notice(reason);
  }

  /** `obsidian://nectenda?invite=…` or `…?key=nk_…[&endpoint=wss://…]`. */
  async handleDeepLink(params: Record<string, string>): Promise<void> {
    const open = (): void => {
      const setting = (this.app as unknown as { setting?: { open(): void; openTabById(id: string): void } }).setting;
      setting?.open();
      setting?.openTabById(this.manifest.id);
    };
    if (params.invite) {
      if (!this.isSignedIn() || this.settings.mode !== 'cloud') {
        new Notice('Sign in to Nectenda Cloud to accept this invitation. It is waiting under Invitations.');
        open();
        return;
      }
      try {
        await this.refreshMemberships();
        const m = await this.acceptInvite(params.invite);
        new Notice(`You have joined ${m.accountName}.`);
      } catch (err) {
        new Notice(`Could not accept the invitation: ${err instanceof Error ? err.message : String(err)}`);
      }
      open();
      return;
    }
    if (params.key) {
      if (!this.isSignedIn() || this.settings.mode !== 'cloud') {
        new Notice('Sign in to Nectenda Cloud first, then open this link again.');
        open();
        return;
      }
      try {
        const m = await this.joinByShareKey(params.key, params.endpoint);
        new Notice(`You have joined ${m.accountName}.`);
      } catch (err) {
        new Notice(`Could not join: ${err instanceof Error ? err.message : String(err)}`);
      }
      open();
      return;
    }
    open();
  }

  /**
   * Rebuild the folder key registry from the cache.
   *
   * Runs before startSync so that a folder's keys are present the moment it
   * connects. A folder whose keys are missing must not be treated as empty —
   * see connectFolder.
   */
  async restoreFolderKeys(): Promise<void> {
    for (const [folderId, stored] of Object.entries(this.settings.folderKeys ?? {})) {
      try {
        this.folderCrypto.add(await deserialiseFolderKeys(folderId, stored));
      } catch (err) {
        log.error('Could not restore folder keys from the cache', {
          folderId,
          error: String(err),
        });
      }
    }
  }

  /**
   * Move secrets out of the plugin's settings and into the keychain.
   *
   * Runs on every start and is idempotent. Anything already in the keychain is
   * left alone; anything still in data.json is copied across and removed from
   * the file. A user who upgrades Obsidian past 1.11.4 gets this automatically
   * on the next launch, without being asked.
   */
  private async migrateSecrets(): Promise<void> {
    if (this.secrets.kind !== 'keychain') return;

    // What is already in the keychain wins; anything still in the file is
    // carried across by the save below and then trimmed out of it.
    const strandedInFile =
      !!this.settings.token || !!this.settings.refreshToken || Object.keys(this.settings.folderKeys ?? {}).length > 0;
    this.hydrateSecrets();
    if (strandedInFile) {
      await this.saveSettings();
      log.info('Moved secrets out of the vault file and into the OS keychain');
    }
  }

  /** Cache a folder's keys so a start with no network still has them. */
  /**
   * The id this account's key is held under.
   *
   * Null when there is no account yet, which is the honest answer before
   * enrolment rather than a reason to guess.
   */
  private async identityKeyId(): Promise<string | null> {
    const publicKey = this.settings.keyMaterial?.publicKey;
    if (!publicKey) return null;
    return `${IDENTITY_KEY_PREFIX}-${await publicKeyFingerprint(publicKey)}`;
  }

  /**
   * Hold the identity key for this device, so the passphrase is asked once.
   *
   * The public key travels with it and is checked on the way back: the store is
   * shared by every vault of the installation, and a stale or mismatched entry
   * must read as a miss rather than as a key to try.
   *
   * Never goes near `this.settings`, so `saveSettings` cannot serialise it into
   * data.json — a file a vault sync carries off the device. That is structural
   * rather than a guard someone has to remember.
   */
  async rememberIdentity(identity: CryptoKeyPair): Promise<void> {
    const id = await this.identityKeyId();
    if (!id || this.deviceSecrets.kind === 'none') return;
    try {
      const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', identity.privateKey));
      this.deviceSecrets.set(id, JSON.stringify({
        publicKey: this.settings.keyMaterial?.publicKey,
        pkcs8: toBase64(pkcs8),
      }));
    } catch (err) {
      // Not being able to hold it costs a prompt, which is what happened before.
      log.warn('Could not hold the identity key for this device', { error: String(err) });
    }
  }

  /** Read it back, or null. A mismatch deletes the entry rather than trusting it. */
  async restoreIdentity(): Promise<CryptoKeyPair | null> {
    const id = await this.identityKeyId();
    if (!id || this.deviceSecrets.kind === 'none') return null;
    const raw = this.deviceSecrets.get(id);
    if (!raw) return null;
    try {
      const held = JSON.parse(raw) as { publicKey?: string; pkcs8?: string };
      // Both halves must be present and the public key must match. Comparing
      // two undefineds would pass, which is the sort of match that is really a
      // miss — `identityKeyId` already rules it out, but not visibly here.
      const mine = this.settings.keyMaterial?.publicKey;
      if (!held.pkcs8 || !held.publicKey || !mine || held.publicKey !== mine) {
        this.deviceSecrets.delete(id);
        log.info('Discarded a held identity key that does not match this account');
        return null;
      }
      const identity = await importIdentityFromPkcs8(fromBase64(held.pkcs8), held.publicKey);
      // The label matching is not the same as the key working. Both halves are
      // imported independently, so without this a corrupt or substituted pkcs8
      // beside a correct public key would be handed out and fail every folder
      // unwrap later, where the evidence is swallowed and the folder just reads
      // as locked.
      if (!(await identityPairs(identity))) {
        this.deviceSecrets.delete(id);
        log.warn('Held identity key does not pair with its public key; asking for the passphrase');
        return null;
      }
      return identity;
    } catch (err) {
      this.deviceSecrets.delete(id);
      log.warn('Could not read the held identity key; asking for the passphrase', { error: String(err) });
      return null;
    }
  }

  /**
   * A mapped folder's own root was renamed in this vault.
   *
   * Two things follow, and the order matters.
   *
   * **The mapping has to follow the folder.** Renaming a mapped root used to
   * match nothing: `resolveMapping` answers null for a root, so the event fell
   * through every branch and `localPath` kept pointing at a path that no longer
   * existed. Everything beneath the new name then resolved to nothing and
   * stopped syncing, silently, while the settings row still showed the old
   * location. This is the person's own action on their own vault, so the
   * mapping follows it; nothing here is driven by anything a server said.
   *
   * **Then the connections have to be rebuilt.** `ContentSync` was handed the
   * old `localPath` when each file was connected, so without this an update
   * arriving from a peer would be written beneath a directory that no longer
   * exists — recreating it, and splitting the folder in two on disk.
   * `refreshSync` disconnects everything and reconnects from the mappings as
   * they now are.
   *
   * Publishing the new name is last and is the owner's alone. A shared folder
   * has one name for everyone, so if every member published from their own
   * local rename they would overwrite each other and the name would flip to
   * whoever last tidied their vault. Everyone else keeps their own folder name
   * locally and changes nothing for anybody else.
   */
  async handleMappedFolderRename(
    oldPath: string,
    newPath: string,
    moved?: FolderMapping,
  ): Promise<void> {
    // Already moved by the watcher, synchronously, before Obsidian delivered
    // the per-file events that follow a folder rename. Looked up here only when
    // something other than the watcher calls this.
    const mapping = moved ?? this.settings.folderMappings.find((m) => m.localPath === newPath || m.localPath === oldPath);
    if (!mapping) return;
    mapping.localPath = newPath;
    try {
      await this.saveSettings();
      // The connections were built with the old path and would write beneath a
      // directory that no longer exists.
      this.refreshSync();
      log.info('A mapped folder was renamed in this vault', {
        folderId: mapping.sharedFolderId, from: oldPath, to: newPath, role: mapping.role ?? null,
      });
      if (mapping.role === 'owner') {
        await this.publishFolderName(mapping.sharedFolderId, basenameOf(newPath));
      }
    } finally {
      // Only now: until this clears, the watcher is still ignoring the file
      // events this rename dragged along, and clearing it early would let the
      // stragglers be read as files arriving from nowhere.
      this.vaultWatcher?.renameSettled();
    }
  }

  /**
   * Re-seal a folder's name under its current keys and tell its server.
   *
   * The name is sealed with the folder's own content key, exactly as
   * `shareFolder` sealed it at creation, so the server sees one opaque string
   * replaced by another and can read neither. Failure is logged and dropped:
   * the folder still syncs, and the only cost is that other vaults keep showing
   * the previous name until this is retried.
   */
  async publishFolderName(folderId: string, name: string): Promise<void> {
    const keys = this.folderCrypto.get(folderId);
    if (!keys) return;
    try {
      const sealed = await sealFolderName(keys, name);
      const server = this.serverFor(folderId);
      const res = await serverFetch(`${server.base}/folders/${encodeURIComponent(folderId)}`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${server.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(sealed),
      });
      if (!res.ok) {
        log.warn('The server refused a folder rename', { folderId, status: res.status });
        return;
      }
      // Kept in step locally too, so the rows that read the stored copy — a
      // locked folder, an orphan, the unshare notice — do not show the old one.
      const mapping = this.settings.folderMappings.find((m) => m.sharedFolderId === folderId);
      if (mapping && mapping.sharedFolderName !== name) {
        mapping.sharedFolderName = name;
        await this.saveSettings();
      }
    } catch (err) {
      log.warn('Could not publish a folder rename', { folderId, error: String(err) });
    }
  }

  /**
   * Seal this vault's name for the shard handshake. Local, and no network.
   *
   * Split from publishing so it can be **awaited before anything connects**.
   * `deviceFields` is synchronous and reads this cache, so firing the seal
   * alongside the connect rather than before it is a race the handshake loses:
   * it sends no sealed name, the server's COALESCE keeps the previous one, and
   * a renamed vault stays under its old name on the organisation roster until
   * the restart after next. Waiting costs a couple of milliseconds.
   */
  /**
   * Drop this vault's sealed name at sign-out.
   *
   * Both halves belong to the account being left, and both outlived it.
   *
   * The cache is what `deviceFields` hands to a shard handshake, so leaving it
   * meant the *next* account's roster row received a name sealed to the
   * previous account's key — a blob it can never open, and one warning per pane
   * poll for as long as the session lasted. `publishedVaultLabel` is what stops
   * a republish of an unchanged name, so leaving that meant the next account,
   * signing in from this same vault, matched on the name and never published at
   * all. Same rule as `forgetIdentity`: cleared before the key material they
   * were sealed to.
   */
  /**
   * Bytes the server holds for this folder, or null when it cannot say.
   *
   * Null for a folder this account is not billed for, and until the first
   * `/usage` refresh has landed. The row omits the size in both cases rather
   * than showing a zero, which would read as "empty" for a folder that may be
   * anything but.
   */
  folderSize(folderId: string): number | null {
    return this.folderBytes.get(folderId) ?? null;
  }

  forgetVaultLabel(): void {
    this.sealedVaultLabel = null;
    this.settings.publishedVaultLabel = '';
  }

  async cacheVaultLabel(): Promise<void> {
    const publicKey = this.settings.keyMaterial?.publicKey;
    const name = this.app.vault.getName();
    if (this.settings.mode !== 'cloud' || !publicKey || !name) return;
    try {
      this.sealedVaultLabel = await sealVaultLabel(name, publicKey);
    } catch (err) {
      // A handshake carrying no sealed name leaves the stored one alone, which
      // is the same position as a vault that has never published. Nothing else
      // depends on this.
      log.warn('Could not seal this vault’s name', { error: String(err) });
    }
  }

  /**
   * Tell the identity service what this vault is called, sealed to the account.
   *
   * What the server stores stays anonymous — `installLabel` sends the platform
   * and four characters of the install id and nothing the user wrote. This puts
   * the real name *wrapped to the account's own identity public key* beside it,
   * so the person's other vaults can name the row and the service cannot.
   *
   * Needs only the public half, which is present from enrolment onwards, so it
   * works while the device is still locked; reading the other rows is what
   * needs the private half.
   *
   * Skipped when the name has not changed, because each wrap draws a fresh
   * ephemeral key and republishing an identical name still rewrites the row.
   */
  async publishVaultLabel(): Promise<void> {
    const { identityAccessToken, keyMaterial, publishedVaultLabel } = this.settings;
    const publicKey = keyMaterial?.publicKey;
    const name = this.app.vault.getName();
    if (this.settings.mode !== 'cloud' || !identityAccessToken || !publicKey || !name) return;
    // Re-cached here as well as at start, for the sign-in path: key material
    // arrives after `cacheVaultLabel` has already run and found nothing to seal.
    await this.cacheVaultLabel();
    if (name === publishedVaultLabel) return;
    const sessionId = sessionIdFromToken(identityAccessToken);
    if (!sessionId) return;
    const sealed = this.sealedVaultLabel;
    if (!sealed) return;
    try {
      await this.identityClient().labelSession(identityAccessToken, sessionId, sealed);
      this.settings.publishedVaultLabel = name;
      await this.saveSettings();
    } catch (err) {
      // Cosmetic, so it must never interrupt a sign-in or a start. The row
      // keeps its generic label and the next attempt tries again.
      log.warn('Could not publish this vault’s sealed name', { error: String(err) });
    }
  }

  /**
   * Drop the held identity key at sign-out, forced ones included.
   *
   * A refused session says nothing about the passphrase, but leaving a
   * device-wide private key behind for an account this device is no longer
   * signed into is exactly the thing worth avoiding. Keyed by account, so
   * signing out of one never touches another's.
   */
  async forgetIdentity(): Promise<void> {
    const id = await this.identityKeyId();
    if (id) this.deviceSecrets.delete(id);
  }

  async rememberFolderKeys(keys: Awaited<ReturnType<typeof createFolderKeys>>): Promise<void> {
    this.folderCrypto.add(keys);
    this.settings.folderKeys = {
      ...this.settings.folderKeys,
      [keys.folderId]: await serialiseFolderKeys(keys),
    };
    await this.saveSettings();
  }

  /**
   * Load what this device has learned, and act on anything left unfinished.
   *
   * A surviving breadcrumb means the app went away during a transfer without
   * running `onunload` — which is what being killed looks like. The attachment
   * is skipped and the ceiling comes down, and the user is told once so it is
   * not a silent refusal.
   */
  private async openDeviceState(): Promise<void> {
    const adapter = this.app.vault.adapter;
    const io: StateFile = {
      read: (p) => adapter.read(p),
      write: (p, data) => adapter.write(p, data),
      rename: (from, to) => adapter.rename(from, to),
      exists: (p) => adapter.exists(p),
      remove: (p) => adapter.remove(p),
    };
    const deviceId = getOrCreateDeviceId(this.secrets) || 'unnamed-device';
    this.deviceState = await DeviceStateStore.open(
      io,
      `${this.manifest.dir}/device-state.json`,
      deviceId,
      DEFAULT_MAX_BLOB_BYTES,
    );

    const unfinished = this.deviceState.unfinishedAttempt;
    if (!unfinished) return;
    const learned = await this.deviceState.learnFromCrash(unfinished);
    if (learned) {
      new Notice(
        `Nectenda: "${unfinished.relativePath}" appears too large for this device, so it `
          + 'has been skipped. Everything else keeps syncing, and you can retry it from '
          + 'settings.',
        12000,
      );
    }
  }

  /**
   * Ask before opening something bigger than this device has managed before.
   *
   * Deliberately blunt about the risk. The honest answer is that we cannot know
   * whether it will work — Obsidian exposes no memory API to a plugin — and
   * pretending otherwise would be worse than saying so.
   */
  confirmLargeDownload(relativePath: string, bytes: number): Promise<boolean> {
    return new Promise((resolve) => {
      new LargeAttachmentModal(this.app, relativePath, bytes, resolve).open();
    });
  }

  /**
   * Put a retry control where the missing attachment would have been.
   *
   * A skipped attachment leaves an embed pointing at a file that is not there,
   * which Obsidian renders as an unremarkable broken link. Without this the
   * only evidence would be a line in settings the user has no reason to visit,
   * and the file would look simply lost.
   */
  private registerSkippedAttachmentMarkers(): void {
    this.registerMarkdownPostProcessor((el, ctx) => {
      const state = this.deviceState;
      if (!state) return;
      const mapping = this.settings.folderMappings.find(
        (m) => ctx.sourcePath.startsWith(`${m.localPath}/`),
      );
      if (!mapping) return;

      for (const embed of Array.from(el.querySelectorAll('.internal-embed'))) {
        const src = embed.getAttribute('src');
        if (!src) continue;
        // Resolve the embed the way Obsidian does, so a link written with a
        // short name still matches the file it points at.
        const target = this.app.metadataCache.getFirstLinkpathDest(src, ctx.sourcePath);
        if (target) continue; // it is here; nothing to offer

        const relative = src.startsWith(`${mapping.localPath}/`)
          ? src.slice(mapping.localPath.length + 1)
          : src;
        if (!state.isSkipped(mapping.sharedFolderId, relative)) continue;

        const notice = embed.createDiv({ cls: 'nectenda-surface nectenda-skipped-attachment' });
        notice.style.border = '1px solid var(--background-modifier-border)';
        notice.style.borderRadius = '6px';
        notice.style.padding = '0.75em';
        notice.createDiv({
          text: `${relative} was not downloaded to this device.`,
          cls: 'setting-item-description',
        });
        const button = notice.createEl('button', { text: 'Download on this device' });
        button.onclick = () => {
          button.disabled = true;
          button.setText('Downloading...');
          void this.retryAttachment(mapping.sharedFolderId, relative);
        };
      }
    });
  }

  /**
   * Attachments a shared note points at but that live outside every shared
   * folder, so nothing will ever sync them.
   *
   * Reads the resolved link graph Obsidian already maintains rather than
   * parsing notes, so it costs nothing and is always current.
   */
  strandedAttachments(): StrandedAttachment[] {
    return findStrandedAttachments(
      this.app.metadataCache.resolvedLinks,
      this.settings.folderMappings,
    );
  }

  /**
   * Move a stranded attachment into the shared folder, beside its note.
   *
   * `fileManager.renameFile` rather than `vault.rename`: it rewrites every link
   * pointing at the file, so moving it does not break the embed we are trying
   * to fix.
   */
  async adoptStrandedAttachment(stranded: StrandedAttachment): Promise<boolean> {
    const file = this.app.vault.getAbstractFileByPath(stranded.attachmentPath);
    if (!file) {
      new Notice('Nectenda: that file is no longer there.');
      return false;
    }
    const target = destinationFor(stranded);
    if (this.app.vault.getAbstractFileByPath(target)) {
      new Notice(`Nectenda: "${target}" already exists — move it by hand.`);
      return false;
    }
    try {
      await this.app.fileManager.renameFile(file, target);
      new Notice(`Nectenda: moved into the shared folder, and it will sync now.`);
      return true;
    } catch (err) {
      log.error('Could not move a stranded attachment', {
        from: stranded.attachmentPath, to: target, error: String(err),
      });
      new Notice('Nectenda: could not move that file. See the console for why.');
      return false;
    }
  }

  /**
   * Obsidian's own setting for where dropped attachments go.
   *
   * `getConfig`/`setConfig` are real but undocumented, so both are
   * feature-detected. Writing `.obsidian/app.json` directly is not an
   * alternative: Obsidian holds config in memory and would overwrite it, and
   * editing an app's configuration behind its back is not something a plugin
   * should do.
   */
  private vaultConfig(): {
    get(key: string): unknown;
    set(key: string, value: unknown): void;
  } | null {
    const vault = this.app.vault as unknown as {
      getConfig?(key: string): unknown;
      setConfig?(key: string, value: unknown): void;
    };
    if (typeof vault.getConfig !== 'function' || typeof vault.setConfig !== 'function') return null;
    return { get: (k) => vault.getConfig!(k), set: (k, v) => vault.setConfig!(k, v) };
  }

  attachmentSettingWillStrandFiles(): boolean {
    const config = this.vaultConfig();
    if (!config) return false; // cannot read it, so cannot advise on it
    return attachmentsLandOutsideSharedFolders(
      config.get('attachmentFolderPath') as string | undefined,
      this.settings.folderMappings,
    );
  }

  /** Point Obsidian at the note's own folder, so new attachments land shared. */
  setAttachmentsBesideNote(): boolean {
    const config = this.vaultConfig();
    if (!config) return false;
    config.set('attachmentFolderPath', ATTACHMENTS_BESIDE_NOTE);
    return true;
  }

  /**
   * Everything a mapped folder stores, largest first, with real names.
   *
   * Only works for folders this vault has mapped, and that is not a limitation
   * to hide: the server holds ciphertext under opaque ids and genuinely cannot
   * tell anyone which file is which. Only a client with the folder keys can put
   * a name to a blob, which is the whole point of the design.
   */
  storedAttachments(sharedFolderId: string): Array<{ relativePath: string; bytes: number }> {
    return (this.fileSync?.listBlobs(sharedFolderId) ?? [])
      .map(([relativePath, entry]) => ({ relativePath, bytes: entry.size }))
      .sort((a, b) => b.bytes - a.bytes);
  }

  /**
   * Delete an attachment everywhere: locally, from the listing, and on the
   * server.
   *
   * Goes through the vault rather than the listing directly, so it takes the
   * same path a user deleting the file would — the watcher removes the entry
   * and reclaims the bytes, and there is only one implementation of that.
   */
  async deleteAttachment(sharedFolderId: string, relativePath: string): Promise<boolean> {
    const mapping = this.settings.folderMappings.find((m) => m.sharedFolderId === sharedFolderId);
    if (!mapping) return false;
    const full = `${mapping.localPath}/${relativePath}`;
    try {
      const file = this.app.vault.getAbstractFileByPath(full);
      if (file) {
        // To the vault trash, not gone: the user is freeing server space, and
        // may not have meant to destroy their only copy.
        await this.app.vault.trash(file, false);
        return true;
      }
      // Not here, but still listed — remove the entry and reclaim regardless.
      const entry = this.fileSync?.removeBlobEntry(sharedFolderId, relativePath);
      if (entry) await this.blobSync?.deleteRemote(sharedFolderId, entry.blobId);
      return true;
    } catch (err) {
      log.error('Could not delete an attachment', { relativePath, error: String(err) });
      return false;
    }
  }

  /** Try a skipped attachment again, from settings or from the note itself. */
  async retryAttachment(folderId: string, relativePath: string): Promise<void> {
    await this.deviceState?.retry(folderId, relativePath);
    const entry = this.fileSync?.getBlobEntry(folderId, relativePath);
    if (!entry) {
      new Notice('Nectenda: that attachment is no longer shared.');
      return;
    }
    new Notice(`Nectenda: downloading "${relativePath}"...`);
    const ok = await this.blobSync?.download(folderId, relativePath, entry);
    if (!ok) new Notice(`Nectenda: "${relativePath}" could not be downloaded.`);
  }

  /**
   * Re-attest every connected folder periodically.
   *
   * On connect alone is not enough for a vault left open for weeks: the
   * server's marks would age out and it would start setting aside attachments
   * this client is still using. Six hours is far inside the collection grace
   * period, so a few missed rounds cost nothing.
   */
  private startAttestation(): void {
    if (this.attestTimer) return;
    this.attestTimer = window.setInterval(() => {
      for (const mapping of this.settings.folderMappings) {
        void this.blobSync?.attestFolder(mapping.sharedFolderId);
      }
    }, ATTEST_INTERVAL_MS);
    this.registerInterval(this.attestTimer);
  }

  private attestTimer: number | null = null;

  /**
   * Send a deliberate report carrying a sentinel, and forbidden strings beside it.
   *
   * The client half of `POST /api/admin/test-error`, and the only way to
   * exercise what cannot be exercised from a terminal: the envelope format
   * GlitchTip actually accepts, and CORS from Obsidian's own origin
   * (`app://obsidian.md`, `capacitor://localhost` on mobile). `curl` bypasses
   * CORS entirely, so a check that passes there proves nothing about the
   * renderer — the same mistake as calling a manual test valid on the strength
   * of `pgrep`.
   *
   * The forbidden strings go in as `dropped`, which `buildEvent` never reads.
   * `deploy/verify-scrubber.sh --client` then dumps the whole GlitchTip
   * database and asserts the sentinel arrived and none of them did.
   */
  async sendTestErrorReport(): Promise<void> {
    if (!this.settings.errorReportDsn) {
      new Notice('No crash-report endpoint: this server names none.');
      return;
    }
    const sentinel = `nectenda-plugin-test-${Math.random().toString(16).slice(2, 10)}`;
    const err = new Error(`Nectenda plugin test event ${sentinel} opening Notes/should-never-appear.md`);
    let sent = false;
    // A fresh reporter, so the session cap and the hold-off on the real one
    // cannot swallow a check somebody is running deliberately.
    const probe = new ErrorReports({
      dsn: () => this.settings.errorReportDsn || null,
      enabled: () => true,
      acknowledged: () => true,
      meta: () => ({
        installId: getOrCreateInstallId(this.secrets),
        platform: platformName(),
        obsidian: apiVersion,
      }),
      onSent: () => {
        sent = true;
      },
    });
    probe.capture(err, {
      plantedPath: 'Notes/should-never-appear.md',
      plantedTitle: 'Q3 layoffs',
      plantedEmail: 'sentinel-person@example.com',
      vault: this.app.vault.getName(),
    });
    // The send is fire-and-forget by design, so this waits rather than being
    // told. Long enough for a round trip, short enough not to look stuck.
    await new Promise((r) => setTimeout(r, 2000));
    probe.stop();
    await navigator.clipboard?.writeText(sentinel).catch(() => undefined);
    new Notice(
      sent
        ? `Sent. Sentinel ${sentinel} — copied to your clipboard.`
        : `Sentinel ${sentinel} — copied, but the tracker did not answer. Check the console.`,
      10000,
    );
    log.info('Test crash report attempted', { sentinel, accepted: sent });
  }

  /**
   * Show the crash-report notice once, and record that it was shown.
   *
   * Only where there is something to decide: a server that names no DSN — any
   * self-hosted one — cannot send reports whatever the person answers, and
   * asking them would be theatre. Guarded on the timestamp, so it appears at
   * the first cloud sign-in and never again.
   */
  private maybeAskAboutErrorReports(): void {
    if (this.settings.errorReportsAcknowledgedAt !== null) return;
    if (!this.settings.errorReportDsn) return;
    new ErrorReportConsentModal(this.app, (send) => {
      this.settings.errorReports = send;
      this.settings.errorReportsAcknowledgedAt = Math.floor(Date.now() / 1000);
      void this.saveSettings();
      this.refreshSettingsPane();
    }).open();
  }

  /**
   * Crash reporting, built once per load.
   *
   * Constructed even when there is no DSN and even when the setting is off:
   * the gates live inside `capture`, read through closures, so a sign-in that
   * arrives later starts reporting without anything being rebuilt, and a
   * sign-out stops it the same way. It holds no reference to the vault, the
   * providers or any document — only these closures over primitives — so an
   * in-flight POST during teardown cannot reach anything.
   */
  private installErrorReports(): void {
    this.errorReports = new ErrorReports({
      dsn: () => this.settings.errorReportDsn || null,
      enabled: () => this.settings.errorReports,
      acknowledged: () => this.settings.errorReportsAcknowledgedAt !== null,
      meta: () => ({
        installId: getOrCreateInstallId(this.secrets),
        platform: platformName(),
        obsidian: apiVersion,
      }),
    });

    // `window.onerror` fires for Obsidian itself and for every other
    // installed plugin. `isOurs` is what keeps somebody else's error — which
    // may carry their user's note content — from being shipped to us.
    // Registered through Obsidian so it is removed when the plugin unloads.
    this.registerDomEvent(window, 'error', (e: ErrorEvent) => {
      if (isOurs(e.error)) this.errorReports?.capture(e.error);
    });
    this.registerDomEvent(window, 'unhandledrejection', (e: PromiseRejectionEvent) => {
      if (isOurs(e.reason)) this.errorReports?.capture(e.reason);
    });
  }

  onunload() {
    // First, before anything is dismantled. A report callback firing into
    // state that `stopSync` is taking apart is the shape of at least four
    // bugs in this plugin's history, and this one would be firing from the
    // failure path of the thing that just went wrong.
    this.errorReports?.stop();
    // A clean shutdown is not a crash, so nothing may be left looking like one.
    void this.deviceState?.endAttempt();
    this.stopSync();
  }

  startSync(): void {
    if (this.provider) return;

    // One socket per sync server, one provider for the engine. The registry is
    // the cipher: it holds every folder's keys and looks them up by the folder
    // id in a document name, so it is shared by every connection.
    this.provider = new ProviderRouter();
    for (const c of this.buildConnections()) this.provider.add(c);
    this.provider.setFolderRoutes(this.folderRoutes());
    this.provider.on('status', (status: unknown) => {
      if (status === 'connected') {
        this.updateStatusBar('connected');
        this.deviceLimitNotified = false;
        this.disconnectNotified = false;
        this.updateRequiredNotified = false;
        this.storageFullNotified = false;
        this.quotaWarnNotified = false;
        // Learn the account's limit first, so the flush below can drop anything
        // that can never be accepted instead of re-encrypting it.
        void this.refreshAccountLimits().then(() => this.blobSync?.flushPending());
        this.startAttestation();
      } else if (status === 'device-limit') {
        this.updateStatusBar('device-limit');
        // Once per episode, not once per retry. A refused device retries
        // slowly; asking the servers where it stands lets the membership
        // record the refusal and close this connection rather than knock.
        if (!this.deviceLimitNotified) {
          this.deviceLimitNotified = true;
          new Notice(
            'Nectenda: this device is not on the roster of one of your organisations, so it is not syncing it. ' +
              'Your notes are saved locally. Remove a device there, or add this one, from Settings → Nectenda.',
            12000,
          );
          void this.refreshMemberships().catch(() => undefined);
        }
      } else if (status === 'update-required') {
        // This build is older than the server will talk to. Said once per
        // episode, like the siblings above: the provider retries slowly, and
        // one notice per retry would be a nag about something the person
        // cannot fix in the next thirty seconds.
        this.updateStatusBar('update-required');
        if (!this.updateRequiredNotified) {
          this.updateRequiredNotified = true;
          new Notice(
            'Nectenda: update the Nectenda plugin to keep syncing. Your notes are saved locally ' +
              'and nothing is lost; syncing resumes on its own once the update is installed.',
            12000,
          );
        }
      } else if (status === 'suspended') {
        this.updateStatusBar('suspended');
        this.reportAccountSuspended();
      } else if (status === 'moving') {
        // Short-lived: the organisation is being carried to another server.
        // Editing continues locally and the identity service names the new
        // server within a minute; nothing to say beyond the status bar.
        this.updateStatusBar('moving');
        void this.refreshMemberships().catch(() => undefined);
      } else if (status === 'restarting') {
        // A deploy. Seconds long, retried quickly, and no notice: the
        // status bar says so, and a notice would announce an outage that is
        // not one. If the window closes without a connection the provider
        // reports 'disconnected' and the branch below speaks.
        this.updateStatusBar('restarting');
      } else if (status === 'disconnected') {
        this.updateStatusBar('offline');
        // Once per episode. A flapping link would otherwise stack a notice per
        // drop, and the sibling notices above already work this way.
        if (!this.disconnectNotified) {
          this.disconnectNotified = true;
          new Notice('Nectenda: Lost connection to server. Reconnecting...');
        }
      } else if (status === 'signed-out') {
        // Transient: the handler below is asking the identity service what
        // this means, and ends in a reconnect or a sign-out.
        this.updateStatusBar('signed-out');
      } else if (status === 'idle') {
        this.updateStatusBar('idle');
      }
    });
    this.provider.on('signed-out', (id: unknown) => void this.handleSignedOutConnection(String(id)));
    this.provider.on('folder-gone', (id: unknown) => this.handleFolderGone(String(id)));
    this.provider.connect();

    // Content sync for background file syncing
    const vaultAdapter = new ObsidianVaultAdapter(this.app.vault);
    this.contentSync = new ContentSync(this, this.provider, vaultAdapter);
    // A file whose subscribe was refused for want of a connection is retried
    // when one appears, rather than waiting for something to touch it again.
    // Without this it stayed unconnected — looking healthy, syncing nothing —
    // until the person happened to reopen the note.
    this.provider.on('routes-changed', () => this.contentSync?.retryUnplaced());

    // File operations sync (meta docs)
    this.fileSync = new FileSync(this, this.provider, vaultAdapter);
    this.fileSync.setContentSync(this.contentSync);

    // Attachments
    this.blobSync = new BlobSync(this, vaultAdapter);

    // Vault watcher for local file changes
    this.vaultWatcher = new VaultWatcher(
      this, this.fileSync, this.contentSync, vaultAdapter, this.blobSync,
    );
    this.vaultWatcher.start();

    // Editor bridge for live collaborative editing
    // What collaborators see above this person's cursor: the display name on
    // Nectenda Cloud, the username on a self-hosted server.
    const presenceName = this.settings.mode === 'cloud' ? this.settings.identity?.displayName || this.settings.identity?.email || 'someone' : this.settings.username;
    this.editorBridge = new EditorBridge(this, this.contentSync, this.provider, presenceName, this.collabExts);
    this.editorBridge.setPresenceCallback((people) => {
      this.updatePresence(people);
    });
    this.editorBridge.start();

    // Connect meta docs and content sync for all mapped folders.
    //
    // Deferred until the workspace is ready: at onload the vault is not yet
    // indexed, so the folder lookup returns nothing and no file gets connected
    // — background sync silently does nothing until the user opens a file and
    // ContentSync connects it on demand. VaultWatcher already waits for the
    // same reason. onLayoutReady fires immediately when the layout is already
    // built, so this is also correct when called after login.
    this.app.workspace.onLayoutReady(() => {
      for (const mapping of this.settings.folderMappings) {
        this.fileSync?.connectFolder(mapping.sharedFolderId, mapping.localPath);
        this.contentSync?.connectFolder(mapping.sharedFolderId, mapping.localPath);
        this.blobSync?.connectFolder(mapping.sharedFolderId, mapping.localPath);
      }
    });

    this.folderIndicator = new FolderIndicator(this);
    this.folderIndicator.start();
    this.updateStatusBar(this.provider.list().length ? 'connected' : 'idle');
  }

  /**
   * Start or stop mirroring the log to a file, following the setting.
   *
   * Writes are chained rather than fired in parallel so lines cannot interleave
   * or arrive out of order — a trace whose ordering cannot be trusted is worse
   * than none, since ordering is usually the thing being diagnosed.
   */
  applyDiagnosticLogSetting(): void {
    if (!this.settings.diagnosticLog) {
      setLogSink(null);
      return;
    }

    const path = `${this.manifest.dir}/diag.log`;
    const adapter = this.app.vault.adapter;
    // Rolled rather than unbounded. This file used to grow for as long as the
    // setting was on, in the user's own vault, and the setting text had to
    // warn people not to leave it enabled. A cap means it can just be left on.
    const MAX_BYTES = 5 * 1024 * 1024;
    const CHECK_EVERY = 500;
    let sinceCheck = 0;
    // Write failures were swallowed twice here, which made a log that had
    // silently stopped writing indistinguishable from a quiet session — the
    // exact failure this file exists to diagnose. Said once, to the console,
    // because the file is the thing that is broken.
    let complained = false;
    const failed = (err: unknown): void => {
      if (complained) return;
      complained = true;
      // `console`, not `log`: the sink `log` writes to is the thing that has
      // just failed, so routing this through it would be swallowed by the
      // same fault it is reporting.
      // eslint-disable-next-line no-console
      console.error('[Nectenda] Diagnostic log could not be written', err);
    };

    let queue: Promise<void> = adapter
      .write(path, `=== session start ${new Date().toISOString()} ===\n`)
      .catch(failed);
    setLogSink((line) => {
      queue = queue
        .then(async () => {
          if (++sinceCheck >= CHECK_EVERY) {
            sinceCheck = 0;
            const stat = await adapter.stat(path);
            if (stat && stat.size > MAX_BYTES) {
              // Truncate rather than rotate: a second file in the plugin
              // folder is another thing to explain and another thing to
              // forget to delete. The recent end is the useful end.
              await adapter.write(path, `=== truncated at ${new Date().toISOString()} ===\n`);
            }
          }
          await adapter.append(path, line + '\n');
        })
        .catch(failed);
    });
    log.info('Diagnostic log enabled', { path, maxBytes: MAX_BYTES });
  }

  stopSync(): void {
    this.vaultWatcher?.stop();
    this.vaultWatcher = null;
    this.contentSync?.disconnectAll();
    this.contentSync = null;
    // Before the provider goes, so every in-flight transfer is aborted while
    // the state it would write into still exists. void-fired teardown racing
    // async work has caused at least four bugs in this codebase.
    this.blobSync?.stop();
    this.blobSync = null;
    this.fileSync?.disconnectAll();
    this.fileSync = null;
    this.folderIndicator?.stop();
    this.folderIndicator = null;
    this.editorBridge?.stop();
    this.editorBridge = null;
    this.provider?.destroy();
    this.provider = null;
    this.updateStatusBar('disconnected');
  }

  /** Called when folder mappings change — no need to restart sync */
  /**
   * Drop attachment records for folders this vault no longer maps.
   *
   * Called from `refreshSync`, which is what every mapping change already ends
   * with, so there is one place to get this right rather than seven. Saving is
   * fired rather than awaited because nothing reads these between the two, and
   * a stale record surviving until the next save is harmless — it is already
   * out of the view by then.
   */
  pruneAttachmentRecords(): void {
    const mapped = new Set(this.settings.folderMappings.map((m) => m.sharedFolderId));
    const oversized = forgetUnmappedRecords(this.settings.oversizedAttachments ?? [], mapped);
    const pending = forgetUnmappedRecords(this.settings.pendingBlobUploads ?? [], mapped);
    if (oversized.length === (this.settings.oversizedAttachments ?? []).length
      && pending.length === (this.settings.pendingBlobUploads ?? []).length) return;
    this.settings.oversizedAttachments = oversized;
    this.settings.pendingBlobUploads = pending;
    void this.saveSettings();
  }

  /**
   * Whoever wants to know when the plugin's state changes.
   *
   * The settings pane is the customer. It used to be a snapshot — rendered
   * once, on a gesture, from fetches that raced the socket handshake and
   * lost — and nothing told it when the world moved on. The listeners live
   * here rather than on the router because `startSync` builds a new router
   * and destroying the old one clears its listeners: a pane subscribed to
   * the router would have gone deaf on the very sign-in that caused the bug.
   */
  private changes = new ChangeFanout();

  onChange(listener: (reason: ChangeReason) => void): () => void {
    return this.changes.on(listener);
  }

  private notifyChange(reason: ChangeReason): void {
    this.changes.notify(reason);
    // The pane's organisation entries come from its stored definitions,
    // which only a re-read refreshes — and the pane subscribes to changes
    // only while it is showing. A seat taken while it was closed has to be
    // there when it opens.
    if (reason === 'memberships') this.settingTab?.pagesChanged();
  }

  refreshSync(): void {
    this.pruneAttachmentRecords();
    // A folder the server no longer has is not reconnected: the sockets would
    // be refused in silence and the status bar would claim it still syncs.
    // Unmapping it is what clears this, which is the person's own decision.
    const mapped = new Set(this.settings.folderMappings.map((m) => m.sharedFolderId));
    for (const id of [...this.goneFolders]) if (!mapped.has(id)) this.goneFolders.delete(id);
    const live = this.settings.folderMappings.filter((m) => !this.goneFolders.has(m.sharedFolderId));
    this.provider?.setFolderRoutes(this.folderRoutes());
    this.editorBridge?.reconnectActiveFile();
    this.folderIndicator?.refresh();

    // Reconnect meta docs and content sync for new/removed mappings
    if (this.fileSync) {
      this.fileSync.disconnectAll();
      for (const mapping of live) {
        this.fileSync.connectFolder(mapping.sharedFolderId, mapping.localPath);
      }
    }
    if (this.contentSync) {
      this.contentSync.disconnectAll();
      for (const mapping of live) {
        this.contentSync.connectFolder(mapping.sharedFolderId, mapping.localPath);
        this.blobSync?.connectFolder(mapping.sharedFolderId, mapping.localPath);
      }
    }
    this.notifyChange('structure');
  }

  updateStatusBar(status: 'connected' | 'disconnected' | 'offline' | 'restarting' | 'device-limit' | 'suspended' | 'moving' | 'signed-out' | 'update-required' | 'idle'): void {
    if (!this.statusBarItem) return;
    const labels: Record<string, string> = {
      connected: 'Nectenda: Connected',
      idle: 'Nectenda: Signed in — not syncing an organisation on this device',
      disconnected: 'Nectenda: Disconnected',
      'signed-out': 'Nectenda: Session ended — checking…',
      // Says what is wrong rather than "offline", which would send the user
      // looking for a network fault that does not exist.
      'device-limit': 'Nectenda: Device limit reached',
      suspended: 'Nectenda: Account suspended',
      moving: 'Nectenda: Organisation moving servers…',
      offline: 'Nectenda: Offline (reconnecting...)',
      restarting: 'Nectenda: Server updating — back in a moment…',
      'update-required': 'Nectenda: Update the plugin to keep syncing',
    };
    const invites = this.settings.pendingInvites?.length ?? 0;
    this.statusBarItem.setText(labels[status]);
    this.statusBarItem.setAttribute('aria-label', invites ? `${labels[status]} — ${invites} invitation(s) waiting` : labels[status]);
    this.notifyChange('connection');
  }

  private updateRequiredNotified = false;
  private suspendedNotified = false;
  /** Said once per session: the account view explains it, and retries are slow. */
  reportAccountSuspended(): void {
    if (this.suspendedNotified) return;
    this.suspendedNotified = true;
    new Notice(
      'Nectenda: this organisation is suspended. Your notes are safe and stay on this device; ' +
        'syncing resumes when it is reinstated. See Settings → Nectenda for details.',
      12000,
    );
  }

  private attachmentsNotIncludedNotified = false;
  /** The plan has no attachments. Text keeps syncing; said once, not per file. */
  reportAttachmentsNotIncluded(): void {
    if (this.attachmentsNotIncludedNotified) return;
    this.attachmentsNotIncludedNotified = true;
    new Notice(
      'Nectenda: attachments are not included in this organisation\'s plan, so images and files ' +
        'stay on this device. Notes keep syncing.',
      12000,
    );
  }

  /** Guards the device-limit Notice so a slow retry loop cannot spam it. */
  private deviceLimitNotified = false;
  private disconnectNotified = false;

  /**
   * An attachment was refused because the account is full.
   *
   * Said once per session, not once per upload: this retries, and a Notice on
   * every attempt is noise the user cannot act on any faster. The second
   * sentence is not decoration — the whole design turns on text continuing to
   * sync, and a user who thinks everything has stopped will start doing
   * damaging things to recover it.
   */
  /**
   * An attachment is larger than the account allows.
   *
   * Said out loud, because the alternative is what actually happened during
   * testing: a 750MB file was attached, nothing was reported, and it simply
   * never appeared on the other side. Silence reads as a broken sync.
   */
  reportAttachmentTooLarge(relativePath: string, bytes: number, limit: number): void {
    const cap = limit > 0 ? limit : this.maxBlobBytes();
    log.warn('Attachment refused: larger than this account allows', {
      relativePath, bytes, limit: cap,
    });
    new Notice(
      `Nectenda: "${relativePath}" is ${formatBytes(bytes)}, larger than the `
        + `${formatBytes(cap)} limit for this account, so it will not sync. `
        + 'Everything else keeps syncing.',
      12000,
    );
  }

  /** Ask the server what this account allows, so uploads can be refused early. */
  private async refreshAccountLimits(): Promise<void> {
    if (!this.isSignedIn()) return;
    // Every server this vault syncs with. The cached attachment cap is the
    // smallest of them, so a file refused early here would have been refused
    // by at least one server; the others are still told when it is uploaded.
    let smallestCap: number | null = null;
    for (const server of this.servers()) {
      try {
        const res = await serverFetch(`${server.base}/usage`, { headers: { Authorization: `Bearer ${server.token}` } });
        if (!res.ok) continue;
        const { limits, usage, folders } = (await res.json()) as {
          limits?: { maxBlobBytes?: number; quotaBytes?: number };
          usage?: { blobBytes?: number; textBytes?: number };
          folders?: Array<{ id: string; bytes?: number }>;
        };
        // Already in the answer, and previously thrown away. It is what lets a
        // folder row say how big it is without a second request. Only folders
        // this account is billed for appear — the boundary `/usage` draws on
        // purpose — so a folder shared *to* this vault has no size to show.
        for (const f of folders ?? []) {
          if (typeof f.bytes === 'number') this.folderBytes.set(f.id, f.bytes);
        }
        if (typeof limits?.quotaBytes === 'number') {
          const used = (usage?.blobBytes ?? 0) + (usage?.textBytes ?? 0);
          // Cleared here rather than on reconnect: space may have been freed by
          // somebody else, and this is the moment we learn of it.
          if (limits.quotaBytes === 0 || used < limits.quotaBytes) {
            this.storageFull = false;
            this.folderIndicator?.refresh();
          }
          this.noteStorageUsage(used, limits.quotaBytes);
        }
        if (typeof limits?.maxBlobBytes === 'number') {
          const cap = limits.maxBlobBytes === 0 ? Number.POSITIVE_INFINITY : limits.maxBlobBytes;
          smallestCap = smallestCap === null ? cap : Math.min(smallestCap, cap);
        }
      } catch {
        // An unknown limit falls back to the built-in default, and the server
        // enforces it regardless. Not worth reporting.
      }
    }
    if (smallestCap !== null) {
      // -1 records "no limit", which zero cannot: zero already means unknown.
      const stored = smallestCap === Number.POSITIVE_INFINITY ? -1 : smallestCap;
      if (stored !== this.settings.maxBlobBytes) {
        this.settings.maxBlobBytes = stored;
        await this.saveSettings();
      }
    }
  }

  /**
   * Warn as storage fills, once, at a threshold the user chooses.
   *
   * A bar that only turns red at the limit tells somebody when it is already
   * too late to plan. Said once per session rather than per upload: this is
   * checked after every attachment, and a Notice each time is noise nobody can
   * act on any faster.
   */
  private noteStorageUsage(usedBytes: number, limitBytes: number): void {
    if (!shouldWarnAboutStorage(usedBytes, limitBytes, this.settings.quotaWarnPercent)) return;
    if (this.quotaWarnNotified) return;
    const percent = (usedBytes / limitBytes) * 100;
    this.quotaWarnNotified = true;
    new Notice(
      `Nectenda: storage is ${Math.round(percent)}% full `
        + `(${formatBytes(usedBytes)} of ${formatBytes(limitBytes)}). `
        + 'Manage it in the Nectenda settings.',
      10000,
    );
  }

  private quotaWarnNotified = false;
  private storageFull = false;

  /**
   * Whether uploads are currently being refused for lack of space.
   *
   * Surfaced distinctly from being offline, because they call for different
   * things: one is fixed by deleting something, the other by waiting.
   */
  isStorageFull(): boolean {
    return this.storageFull;
  }

  reportStorageFull(blobId: string): void {
    log.warn('Attachment upload refused: storage full', { blobId });
    this.storageFull = true;
    this.folderIndicator?.refresh();
    if (this.storageFullNotified) return;
    this.storageFullNotified = true;
    new Notice(
      'Nectenda: storage full, so an attachment was not uploaded. '
        + 'Your notes are still syncing.',
      10000,
    );
  }

  private storageFullNotified = false;

  /**
   * Who else is in this note.
   *
   * Rendered twice, deliberately. The circles are the fast read; the status bar
   * keeps words because the design system's rule is that presence must never be
   * identified by colour alone — and a reader who cannot separate teal from
   * indigo, or who has the note header hidden, still gets the count.
   */
  updatePresence(people: Person[]): void {
    this.renderPresenceStack(people);
    this.updatePresenceCount(people.length);
  }

  /**
   * Circles beside the note title, one per collaborator.
   *
   * Redrawn wholesale on every awareness change rather than diffed: the list is
   * at most a handful of people and changes only when somebody joins or leaves,
   * so the simpler code is the right trade.
   *
   * Colour comes from the person's broadcast value, which is the same one
   * y-codemirror inlines on their caret. Deriving it here instead would risk
   * the circle and the caret disagreeing, which is the one thing this feature
   * must not do.
   */
  private renderPresenceStack(people: Person[]): void {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    const header = view?.containerEl.querySelector('.view-header');
    // Clear every stack, not just this view's: a leaf that lost focus keeps its
    // header, and a stale set of circles there claims people are somewhere they
    // are not.
    this.app.workspace.containerEl
      .querySelectorAll('.nectenda-presence')
      .forEach((stale) => stale.remove());
    if (!header || people.length === 0) return;

    const stack = header.createDiv({ cls: 'nectenda-presence' });
    const shown = people.slice(0, 5);
    for (const person of shown) {
      const dot = stack.createSpan({ cls: 'nectenda-presence-dot', text: initials(person.name) });
      dot.style.backgroundColor = person.color;
      // The name is the true identifier; the colour is only the fast read.
      dot.setAttr('aria-label', person.name);
      dot.setAttr('title', person.name);
    }
    if (people.length > shown.length) {
      stack.createSpan({
        cls: 'nectenda-presence-dot nectenda-presence-more',
        text: `+${people.length - shown.length}`,
      });
    }
  }

  updatePresenceCount(count: number): void {
    if (!this.statusBarItem) return;
    if (count <= 0) {
      // Nobody else in this document is not the same as no connection, and
      // saying "Disconnected" here sent us looking for a network fault that did
      // not exist.
      this.statusBarItem.setText('Nectenda: Connected');
    } else if (count === 1) {
      this.statusBarItem.setText('Nectenda: Online (just you)');
    } else {
      this.statusBarItem.setText(`Nectenda: ${count} online`);
    }
  }

  /** Called when a 401 response indicates the JWT has expired */
  async handleSessionExpired(): Promise<void> {
    if (this.settings.mode === 'cloud') {
      // A shard session lasts seven days; the device session lasts ninety and
      // renews on use. Expiry is routine here, not a reason to sign out.
      log.info('A sync-server session expired — refreshing from the identity service');
      try {
        if (await this.refreshCloudSession({ caller: 'sync-server session' })) return;
      } catch {
        // Logged by the refresh itself; a service that cannot be reached is
        // not a reason to sign out.
        return;
      }
      await this.signOutCloud('Your Nectenda Cloud session has ended. Sign in again.', { skipLogout: true });
      return;
    }
    log.warn('Session expired — logging out');
    this.stopSync();
    this.settings.token = '';
    this.settings.username = '';
    this.settings.userRole = 'editor';
    this.settings.folderMappings = [];
    await this.saveSettings();
    this.refreshSettingsPane();
    new Notice('Session expired. Please log in again.');
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  /**
   * Persist settings, keeping secrets out of the file where a keychain exists.
   *
   * `settings` stays whole in memory so the twenty-odd places that read
   * `settings.token` need no changes; only what reaches disk is trimmed. The
   * secrets are written to the keychain here, in the same call, so the two
   * cannot drift apart.
   */
  async saveSettings() {
    if (this.secrets?.kind !== 'keychain') {
      await this.saveData(this.settings);
      return;
    }

    if (this.settings.token) this.secrets.set(SECRET_IDS.token, this.settings.token);
    else this.secrets.delete(SECRET_IDS.token);
    if (this.settings.refreshToken) this.secrets.set(SECRET_IDS.refreshToken, this.settings.refreshToken);
    else this.secrets.delete(SECRET_IDS.refreshToken);
    if (this.settings.identityAccessToken) this.secrets.set(SECRET_IDS.identityAccessToken, this.settings.identityAccessToken);
    else this.secrets.delete(SECRET_IDS.identityAccessToken);
    const shardTokens = Object.fromEntries(this.settings.memberships.filter((m) => m.token).map((m) => [m.id, m.token]));
    if (Object.keys(shardTokens).length > 0) this.secrets.set(SECRET_IDS.shardTokens, JSON.stringify(shardTokens));
    else this.secrets.delete(SECRET_IDS.shardTokens);

    const folderKeys = this.settings.folderKeys ?? {};
    if (Object.keys(folderKeys).length > 0) {
      this.secrets.set(SECRET_IDS.folderKeys, JSON.stringify(folderKeys));
    } else {
      this.secrets.delete(SECRET_IDS.folderKeys);
    }

    await this.saveData({
      ...this.settings,
      token: '',
      refreshToken: '',
      identityAccessToken: '',
      memberships: this.settings.memberships.map((m) => ({ ...m, token: '' })),
      folderKeys: {},
    });
  }

  /** Read secrets back into the in-memory settings after they were loaded. */
  private hydrateSecrets(): void {
    if (this.secrets.kind !== 'keychain') return;

    const token = this.secrets.get(SECRET_IDS.token);
    if (token) this.settings.token = token;
    const refresh = this.secrets.get(SECRET_IDS.refreshToken);
    if (refresh) this.settings.refreshToken = refresh;
    const access = this.secrets.get(SECRET_IDS.identityAccessToken);
    if (access) this.settings.identityAccessToken = access;
    const shardTokens = this.secrets.get(SECRET_IDS.shardTokens);
    if (shardTokens) {
      try {
        const map = JSON.parse(shardTokens) as Record<string, string>;
        this.settings.memberships = (this.settings.memberships ?? []).map((m) => ({ ...m, token: map[m.id] ?? m.token }));
      } catch (err) {
        log.error('Could not read sync-server sessions from the keychain', { error: String(err) });
      }
    }

    const folderKeys = this.secrets.get(SECRET_IDS.folderKeys);
    if (folderKeys) {
      try {
        this.settings.folderKeys = JSON.parse(folderKeys) as Record<string, StoredFolderKeys>;
      } catch (err) {
        log.error('Could not read folder keys from the keychain', { error: String(err) });
      }
    }
  }
}

export class NectendaSettingTab extends PluginSettingTab {
  plugin: NectendaPlugin;

  constructor(app: App, plugin: NectendaPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  /** Fetch wrapper that handles session expiry (401) automatically */
  private async apiFetch(input: string, init?: RequestInit): Promise<Response> {
    const res = await serverFetch(input, init);
    if (res.status === 401 && this.plugin.isSignedIn()) {
      await this.plugin.handleSessionExpired();
      this.display();
    }
    return res;
  }

  /**
   * Keeping the pane true while it is open.
   *
   * It used to be a snapshot: rendered once, on a gesture, from fetches that
   * raced the socket handshake and lost, so a vault that had just signed in
   * saw itself listed as not connected until the settings were closed and
   * reopened. Now the plugin says when its state changes, the pane refreshes
   * only the sections that change can have touched, and a slow poll catches
   * what other devices did. Nothing here ever calls `display()` on its own:
   * a full re-render wipes typed-but-unsaved text, collapses the disclosure,
   * loses scroll and focus, and re-enters underneath an open modal. Sections
   * own containers and rebuild those, and only when their data differs.
   */
  private visible = false;
  private unsubscribe: (() => void) | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingSections = new Set<PaneSection>();
  private generations = new SectionGenerations();
  private slots: Partial<Record<Exclude<PaneSection, 'account' | 'organisations' | 'sharedFolders'>, HTMLElement>> = {};
  /** One shared-folders section per server on screen, keyed by its API base. */
  folderSlots = new Map<string, { el: HTMLElement; server: FolderServer }>();
  private accountSlots = new Map<string, AccountSlots>();
  /** What the organisation pages were last built from; a change rebuilds the pane. */
  private lastPagesKey = '';
  /** The organisation page on screen, if one is. Tests reach it here. */
  openPage: { containerEl: HTMLElement; membershipId: string } | null = null;

  /**
   * The pane is rendered from definitions (Obsidian 1.13), not drawn by this
   * method: once `getSettingDefinitions()` answers, Obsidian never calls
   * `display()`. Every action in here that used to redraw by calling it
   * still does — through `update()`, which re-reads the definitions and
   * rebuilds. That is the same wipe a redraw always was; what changed is
   * that most refreshes no longer need it (see `refreshSection`).
   */
  display(): void {
    // Obsidian 1.13 renders the definitions and never calls this; an older
    // Obsidian calls it and has no `update()` to draw them with.
    (this as { update?: () => void }).update?.();
  }

  /**
   * The pane's sections, as the settings framework wants them.
   *
   * Each existing section keeps its own renderer and is hosted in a `render`
   * row whose element is emptied and flattened first — a settings row is a
   * padded flex box, and a card or a group drawn straight into one sits off
   * its column. The brand row carries the lifecycle: rendering it subscribes
   * this tab to the plugin's changes, and its cleanup — run before the row is
   * torn down, on every rebuild and on close — releases them. Organisations
   * are native pages, one each, opened from an entry that says the one thing
   * worth knowing before opening it.
   */
  getSettingDefinitions(): SettingDefinitionItem[] {
    const { settings } = this.plugin;
    const signedIn = this.plugin.isSignedIn();
    // A section at the top level draws its own heading and boxes, so the box
    // Obsidian wraps round loose rows is taken off it (`plain`); one inside a
    // group shares that group's box with the rows beside it.
    const host = (name: string, draw: (el: HTMLElement) => void | (() => void), plain = true): SettingGroupItem => ({
      name,
      searchable: false,
      render: (setting) => {
        const el = setting.settingEl;
        el.empty();
        el.addClass('nectenda-host');
        if (plain) el.addClass('nectenda-plain');
        return draw(el) ?? undefined;
      },
    });
    const brand = host('Nectenda', (el) => {
      this.bind();
      this.brandHeader(el, signedIn);
      return () => this.release();
    });
    if (!signedIn) {
      // One host for both: the lockup sits on the card's column, and the
      // column is centred in whatever block holds them — so the same block.
      return [
        host('Sign in', (el) => {
          this.bind();
          this.brandHeader(el, false);
          this.displayLoggedOut(el);
          return () => this.release();
        }),
      ];
    }
    if (settings.mode !== 'cloud') return [brand, host('Server', (el) => this.displayLoggedIn(el))];

    // The page class needs the enclosing tab and its private sections, which
    // only a class defined inside this method can reach.
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const tab = this;
    class OrganisationPage extends SettingPage {
      membershipId: string;
      private base: string | null = null;
      constructor(membershipId: string, title: string) {
        super();
        this.membershipId = membershipId;
        this.title = title;
      }
      display(): void {
        const c = this.containerEl;
        c.empty();
        // Opening a page tears the tab's rows down, and their cleanup released
        // the tab's subscriptions. The page takes them over: its account
        // section wants every connection edge and poll the tab did, and the
        // answers to its fetches are dropped unless the tab counts as showing.
        tab.openPage = this;
        tab.bind();
        const m = tab.plugin.settings.memberships.find((x) => x.id === this.membershipId);
        if (!m) {
          noteRow(c, 'This organisation is no longer listed for you.');
          return;
        }
        const server = tab.plugin.servers().find((x) => x.membershipId === m.id);
        if (!server) return;
        this.base = server.base;
        tab.displayOrganisationActions(c, m);
        tab.displaySharedFolders(c, server);
        tab.displayAccount(c, server);
      }
      hide(): void {
        // Back or close: hand the lifecycle back. Going back re-renders the
        // tab's rows after this, and the brand row binds again.
        if (this.base) {
          tab.accountSlots.delete(this.base);
          tab.folderSlots.delete(this.base);
        }
        if (tab.openPage === this) tab.openPage = null;
        tab.release();
      }
    }
    this.lastPagesKey = pagesKey(settings.memberships, settings.folderMappings);
    return [
      brand,
      { type: 'group', heading: 'Account', items: [host('Account', (el) => this.displayIdentityRows(el), false)] },
      {
        type: 'group',
        heading: 'Organisations',
        items: [
          ...settings.memberships.map((m, i, all): SettingGroupItem => ({
            type: 'page',
            name: pageName(m, i, all),
            desc: `${m.role}${m.region ? ` · ${m.region.toUpperCase()}` : ''} · ${m.shardId}`,
            displayValue: () => organisationSummary(m, foldersSyncedFor(m.id, this.plugin.settings.folderMappings, this.plugin.settings.memberships.length)),
            status: () => organisationWarning(m),
            page: () => new OrganisationPage(m.id, pageName(m, i, all)),
          })),
          host('Create or join an organisation', (el) => this.displayOrganisationControls(el), false),
        ],
      },
      host('Invitations', (el) => this.displayInvitations(el)),
      // Shared folders live on each organisation's page. A mapping made
      // before mappings named their organisation, in a vault that now has
      // several, belongs to no page; it stays here to be unmapped.
      ...(unclaimedMappings(settings.folderMappings, settings.memberships.length).length > 0
        ? [host('Folders needing attention', (el) => this.displayUnclaimedMappings(el))]
        : []),
      host('Encryption', (el) => this.displayEncryption(el)),
      host('Signed-in vaults', (el) => this.displayCloudDevices(el)),
      host('Troubleshooting', (el) => this.displayTroubleshooting(el)),
    ];
  }

  /** Subscribe to the plugin's changes and start the slow poll: the pane is on screen. */
  private bind(): void {
    this.visible = true;
    this.unsubscribe?.();
    this.unsubscribe = this.plugin.onChange((reason) => this.scheduleRefresh(reason));
    this.startPoll();
  }

  /** The pane is being torn down, for a rebuild or for good. */
  private release(): void {
    this.visible = false;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.stopPoll();
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.pendingSections.clear();
    this.slots = {};
    this.accountSlots.clear();
    this.folderSlots.clear();
    this.envelopeChecked.clear();
  }

  hide(): void {
    this.release();
  }

  private alive(): boolean {
    // A page on screen keeps the tab's own container detached; the sections
    // on the page still want their refreshes.
    return this.visible && (this.containerEl.isConnected || this.openPage !== null);
  }

  /**
   * The memberships changed, whether or not the pane is showing. A rebuild
   * only when the pages themselves changed; a rotated token is not a reason.
   */
  pagesChanged(): void {
    if (this.plugin.settings.mode !== 'cloud' || !this.plugin.isSignedIn()) return;
    if (pagesKey(this.plugin.settings.memberships, this.plugin.settings.folderMappings) !== this.lastPagesKey) this.update();
  }

  private startPoll(): void {
    this.stopPoll();
    this.pollTimer = setInterval(() => this.scheduleRefresh('poll'), PANE_POLL_MS);
  }

  private stopPoll(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  /**
   * Coalesced: a reconnect emits several edges in quick succession, and a
   * membership refresh fires three reasons in a row. One pass a moment later
   * refreshes the union.
   */
  private scheduleRefresh(reason: ChangeReason | 'poll'): void {
    // A poll, or a change to the folders, is a fresh chance that a key has
    // been wrapped for us; a burst of connection edges is not.
    if (reason === 'poll' || reason === 'structure') this.envelopeChecked.clear();
    for (const section of sectionsFor(reason)) this.pendingSections.add(section);
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      const sections = [...this.pendingSections];
      this.pendingSections.clear();
      if (!this.alive()) return;
      for (const section of sections) this.refreshSection(section);
    }, REFRESH_COALESCE_MS);
  }

  private refreshSection(section: PaneSection): void {
    switch (section) {
      case 'account':
        for (const slots of this.accountSlots.values()) void this.loadAccount(slots);
        break;
      case 'cloudDevices':
        if (this.slots.cloudDevices) void this.loadCloudDevices(this.slots.cloudDevices);
        break;
      case 'sentInvites':
        if (this.slots.sentInvites) void this.loadSentInvitations(this.slots.sentInvites);
        break;
      case 'sharedFolders':
        for (const slot of this.folderSlots.values()) void this.loadSharedFolders(slot.el, slot.server);
        break;
      case 'invitations':
        if (this.slots.invitations) this.renderInvitations(this.slots.invitations);
        break;
      case 'organisations':
        this.pagesChanged();
        break;
    }
  }

  /**
   * The mark and the wordmark, where a plain text "Nectenda" used to be.
   * Obsidian already prints the plugin's name in its own tab title, so the
   * text heading was saying it twice and carrying nothing of the product.
   */
  private brandHeader(containerEl: HTMLElement, fullWidth: boolean): void {
    // An h2 rather than a div: it is the pane's own heading, and Obsidian
    // insets a heading by the same amount it insets a settings row, so the
    // lockup lines up with "Invitations" and the rest without this file
    // having to know what that amount is.
    const brand = containerEl.createEl('h2', { cls: 'nectenda-surface nectenda-brand' });
    // Above the sign-in screen it joins that screen's narrow centred column,
    // flush with the card's left edge. Above the signed-in sections it keeps
    // the pane's full width, because the Setting rows under it do.
    if (!fullWidth) brand.addClass('is-column');
    brand.appendChild(nectendaMark(24));
    brand.appendChild(nectendaWordmark(18));
  }

  private displayLoggedOut(containerEl: HTMLElement): void {
    if (this.plugin.settings.mode === 'cloud') {
      this.displayCloudSignIn(containerEl);
      return;
    }
    this.displaySelfHostedSignIn(containerEl);
  }

  /**
   * The shell both sign-in screens sit in: a column of a readable width
   * rather than controls stretched across the settings pane, a heading, and
   * a sentence naming the vault this is about.
   *
   * Built as elements rather than `Setting` rows because a Setting is a
   * label-on-the-left, control-on-the-right list item, and this is a page.
   * The signed-in sections stay Setting rows, where that shape is right.
   */
  private signInShell(containerEl: HTMLElement, heading: string, sub: string): HTMLElement {
    const root = containerEl.createDiv('nectenda-surface nectenda-signin');
    const card = root.createDiv('nectenda-card');
    const head = card.createDiv('nectenda-stack-6');
    head.createEl('h2', { cls: 'nectenda-heading', text: heading });
    head.createEl('p', { cls: 'nectenda-sub', text: sub });
    return card;
  }

  /** A row at the foot of a sign-in screen: plain words, not a control. */
  private modeSwitch(card: HTMLElement, to: 'cloud' | 'self-hosted', label: string): void {
    const foot = card.createDiv('nectenda-foot');
    const link = foot.createEl('button', { cls: 'nectenda-bare', text: label });
    link.type = 'button';
    link.onclick = async () => {
      this.plugin.settings.mode = to;
      await this.plugin.saveSettings();
      this.display();
    };
  }

  /**
   * Nectenda Cloud: prove who you are, then set a passphrase nobody else ever
   * sees. The browser does the first part — it is where passkeys and the
   * provider buttons live — and the code can be typed here instead by anyone
   * without a browser to hand. The passphrase never goes anywhere.
   */
  private displayCloudSignIn(containerEl: HTMLElement): void {
    let email = '';
    let code = '';
    let codeSent = false;
    const client = this.plugin.identityClient();
    const device = describeInstall(this.app, this.plugin.secrets);

    const card = this.signInShell(
      containerEl,
      'Connect this vault',
      `Sign in to sync ${this.app.vault.getName()}. Your notes stay on your disk, and your `
        + 'encryption passphrase is set afterwards and never leaves this device.',
    );

    // The one filled control on the screen, and the only thing carrying the
    // cut. Everything below is a bordered row: that contrast is the whole
    // method hierarchy, passkey first and the rest available without argument.
    const passkeyGroup = card.createDiv('nectenda-stack-10');
    const passkey = passkeyGroup.createEl('button', { cls: 'nectenda-primary nectenda-cut' });
    passkey.type = 'button';
    passkey.createSpan({ text: 'Use a passkey' });
    passkey.onclick = () => void this.signInViaBrowser(email);
    passkeyGroup.createEl('p', {
      cls: 'nectenda-caption',
      text: 'Touch ID, Face ID, Windows Hello or a security key.',
    });

    // Always open. A method behind a control people have to find is a method
    // most of them will not use.
    const group = card.createDiv('nectenda-group');
    group.createSpan({ cls: 'nectenda-label', text: 'Other ways in' });

    const field = group.createDiv('nectenda-field');
    field.createEl('label', { text: 'Email', attr: { for: 'nectenda-email' } });
    const row = field.createDiv('nectenda-field-row');
    const emailInput = row.createEl('input', { attr: { id: 'nectenda-email', type: 'email', placeholder: 'name@example.com' } });
    emailInput.oninput = () => { email = emailInput.value.trim(); };
    const sendBtn = row.createEl('button', { cls: 'nectenda-secondary', text: 'Send code' });
    sendBtn.type = 'button';

    // Appears once a code is on its way, and not before: an empty code box on
    // a screen nobody has asked for a code from is a question with no answer.
    const codeField = card.createDiv('nectenda-field nectenda-code-field');
    codeField.hide();
    codeField.createEl('label', { text: 'Code from your email', attr: { for: 'nectenda-code' } });
    const codeRow = codeField.createDiv('nectenda-field-row');
    const codeInput = codeRow.createEl('input', {
      cls: 'nectenda-code-input',
      attr: { id: 'nectenda-code', inputmode: 'numeric', maxlength: '6', placeholder: '123456', autocomplete: 'one-time-code' },
    });
    codeInput.oninput = () => { code = codeInput.value.trim(); };
    const verifyBtn = codeRow.createEl('button', { cls: 'nectenda-primary nectenda-cut', text: 'Sign in' });
    verifyBtn.type = 'button';
    verifyBtn.onclick = async () => {
      if (!email || code.length !== 6) {
        new Notice('Enter your email address and the six-digit code');
        return;
      }
      const working = new Notice('Signing in…', 0);
      try {
        const result = await client.verifyCode(email, code, device);
        await this.plugin.applyCloudSignIn(result);
        working.hide();
        await this.afterCloudSignIn(result.created);
      } catch (err) {
        working.hide();
        new Notice(`Sign-in failed: ${err instanceof Error ? err.message : 'Could not connect'}`);
      }
    };

    sendBtn.onclick = async () => {
      if (!email) {
        new Notice('Enter your email address first');
        return;
      }
      try {
        await client.sendCode(email);
        codeSent = true;
        sendBtn.setText('Send again');
        codeField.show();
        codeInput.focus();
        new Notice(`A code is on its way to ${email}. It lasts ten minutes.`);
      } catch (err) {
        new Notice(err instanceof Error ? err.message : 'The code could not be sent');
      }
      void codeSent;
    };

    // One row per provider the identity service actually offers. Asked for
    // once per render; if it cannot be reached every provider is offered and
    // the service refuses the ones it lacks with a message that says so,
    // rather than the screen quietly offering none.
    const providers = card.createDiv('nectenda-providers');
    const renderProviders = (names: ProviderName[]) => {
      for (const name of PROVIDER_ORDER.filter((n) => names.includes(n))) {
        const btn = providers.createEl('button', { cls: 'nectenda-provider' });
        btn.type = 'button';
        btn.appendChild(providerMark(name));
        btn.createSpan({ text: `Continue with ${PROVIDER_LABELS[name]}` });
        btn.onclick = () => void this.signInViaBrowser(email, name);
      }
    };
    void client
      .providers()
      .then((names) => renderProviders(names.filter((n): n is ProviderName => PROVIDER_ORDER.includes(n as ProviderName))))
      .catch(() => renderProviders(PROVIDER_ORDER));

    const foot = card.createDiv('nectenda-foot');
    const forgot = foot.createEl('button', { cls: 'nectenda-bare', text: 'Forgot passphrase?' });
    forgot.type = 'button';
    forgot.onclick = () => {
      if (!email) {
        new Notice('Enter your email address first');
        return;
      }
      new RecoveryModal(this.app, (result) => {
        if (result) void this.doCloudRecover(email, result.recoveryKey, result.password);
      }).open();
    };

    this.modeSwitch(card, 'self-hosted', 'Use a server you run yourself');

    // The address of the identity service itself. Its own description says to
    // leave it alone unless told otherwise, which is an argument for it not
    // being the third thing on the screen.
    const advanced = containerEl.createEl('details', { cls: 'nectenda-surface nectenda-advanced' });
    advanced.createEl('summary', { text: 'Advanced' });
    new Setting(advanced)
      .setName('Identity service')
      .setDesc('Leave as is unless you were told otherwise.')
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_IDENTITY_URL)
          .setValue(this.plugin.settings.identityUrl === DEFAULT_IDENTITY_URL ? '' : this.plugin.settings.identityUrl)
          .onChange(async (value) => {
            this.plugin.settings.identityUrl = value.trim().replace(/\/$/, '') || DEFAULT_IDENTITY_URL;
            await this.plugin.saveSettings();
          }),
      );
  }

  /**
   * Open the system browser and wait for it. With a provider, the browser
   * lands on that provider's consent page directly; without one, on the
   * service's own page, which is where passkeys live.
   */
  private async signInViaBrowser(email: string, provider?: ProviderName): Promise<void> {
    const client = this.plugin.identityClient();
    const device = describeInstall(this.app, this.plugin.secrets);
    let flow: { nonce: string; url: string };
    let pkce: Awaited<ReturnType<typeof newPkce>>;
    try {
      pkce = await newPkce();
      flow = await client.startFlow({ codeChallenge: pkce.challenge, email: email || undefined, ...device });
    } catch (err) {
      new Notice(`Could not start the sign-in: ${err instanceof Error ? err.message : 'Could not connect'}`);
      return;
    }
    window.open(provider ? providerStartUrl(client.baseUrl, provider, flow.nonce) : flow.url);
    const cancel = new AbortController();
    const waiting = new Notice('Finish signing in in your browser, then come back here. Click to cancel.', 0);
    waiting.noticeEl.addEventListener('click', () => cancel.abort());
    const outcome = await pollForResult({ baseUrl: client.baseUrl, nonce: flow.nonce, verifier: pkce.verifier, signal: cancel.signal });
    waiting.hide();
    if (outcome.status === 'cancelled') return;
    if (outcome.status === 'expired') {
      new Notice('That sign-in expired. Start again.');
      return;
    }
    const working = new Notice('Connecting to your organisations…', 0);
    try {
      await this.plugin.applyCloudSignIn(outcome.result);
      working.hide();
      await this.afterCloudSignIn(false);
    } catch (err) {
      working.hide();
      new Notice(`Sign-in failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * After identity is proved: the passphrase.
   *
   * First device ever: choose one, which generates the keypair and shows the
   * recovery key. Any other device: confirm the existing one now, so the
   * folders are open by the time they are looked at.
   *
   * It used to ask lazily, "exactly as on a self-hosted server" — which was
   * wrong about self-hosted too, where the login password *is* the passphrase
   * and `applySession` leaves the identity unlocked at login.
   *
   * **Nothing here signs anybody out.** It briefly did: a wrong or dismissed
   * passphrase failed the whole sign-in, which meant one typo cost a
   * `signOutCloud` — a round trip retiring the session on the identity service,
   * the refresh token, the device-held key and *every folder mapping*. That is
   * not a proportionate answer to a mistyped character. A wrong passphrase is
   * now retried in the prompt, and giving up leaves the device signed in and
   * visibly locked, which `displayEncryption` renders and offers a way out of.
   */
  private async afterCloudSignIn(created: boolean): Promise<void> {
    const { identity, keyMaterial } = this.plugin.settings;
    if (!identity) return;
    if (!keyMaterial?.publicKey) {
      new Notice(created ? `Welcome, ${identity.email}. Next: choose an encryption passphrase.` : `Signed in as ${identity.email}. Next: choose an encryption passphrase.`);
      await this.setCloudPassphrase();
    } else if (this.plugin.deviceSecrets?.kind === 'none') {
      // Nowhere to keep the key, so there is nothing to confirm *for*. Asking
      // here would buy one thing only — moving this session's single prompt
      // earlier — while every later start asks lazily regardless, because
      // `rememberIdentity` writes nothing and `restoreIdentity` finds nothing.
      // A device with no credential store is asked when a folder needs it.
      new Notice(`Signed in as ${identity.email}`);
    } else {
      // Confirm the passphrase now rather than when a folder first needs it.
      // Several paths reach a signed-in-but-locked state with no prompt at all
      // — refreshMemberships rewrites key material at every start — and the
      // symptom is folders reading as "Locked" with nothing saying why.
      const unlocked = await this.ensureIdentity(
        `Confirm your passphrase to finish signing in as ${identity.email}.`,
      );
      if (!unlocked) {
        // Signed in, locked, and said so by the pane rather than by a toast
        // that scrolls away. `ensureIdentity` has already explained why.
        this.display();
        return;
      }
      new Notice(`Signed in as ${identity.email}`);
    }

    // Name this vault's row for the account's other vaults, now that there is
    // key material to seal it to. Not awaited and not able to fail the sign-in:
    // it only decides whether a row reads "Mind Palace" or the anonymous
    // fallback.
    void this.plugin.publishVaultLabel().catch(() => undefined);

    // Somewhere to put things, for someone nobody has invited. Placed after the
    // passphrase step, never before, because taking a seat uploads the public
    // key that step generates.
    if (shouldCreateFirstOrganisation(this.plugin.settings)) {
      await this.createOrganisation(this.suggestedOrganisationName());
      return;
    }
    this.display();
  }

  /**
   * Create one, and say so. Shared by the button and by the first sign-in.
   *
   * Failure is reported rather than swallowed: the whole point of this path is
   * that somebody with no invitation has a way in, so a silent failure would
   * put them back in the dead end they started in.
   */
  private async createOrganisation(name: string): Promise<boolean> {
    const working = new Notice(`Creating ${name}…`, 0);
    try {
      const m = await this.plugin.createOrganisation(name);
      working.hide();
      new Notice(`${m.accountName} is ready. Share a folder to start syncing.`);
      this.display();
      return true;
    } catch (err) {
      working.hide();
      new Notice(`Could not create the organisation: ${err instanceof Error ? err.message : String(err)}`);
      this.display();
      return false;
    }
  }

  /** The name to offer: theirs, since one person's organisation is usually just them. */
  private suggestedOrganisationName(): string {
    const identity = this.plugin.settings.identity;
    return identity?.displayName?.trim() || identity?.email?.split('@')[0] || this.app.vault.getName();
  }

  /** Choose the passphrase on the first device. Returns false if declined. */
  private async setCloudPassphrase(): Promise<boolean> {
    const password = await new Promise<string | null>((resolve) => {
      new SetPassphraseModal(this.app, resolve).open();
    });
    if (!password) {
      new Notice('No passphrase set. You can set one under Settings → Nectenda before joining a folder.');
      return false;
    }
    const working = new Notice('Generating your encryption keys…', 0);
    try {
      const { keys, keyMaterial, recoveryKey } = await session.cloudSetPassphrase(this.plugin.identityClient(), this.plugin.settings.identityAccessToken, password);
      this.plugin.settings.keyMaterial = keyMaterial;
      this.plugin.sessionKeys = keys;
      await this.plugin.rememberIdentity(keys.identity);
      await this.plugin.saveSettings();
      working.hide();
      new RecoveryKeyModal(this.app, recoveryKey, () => {
        this.plugin.settings.recoveryKeyAcknowledgedAt = Math.floor(Date.now() / 1000);
        void this.plugin.saveSettings();
      }).open();
      return true;
    } catch (err) {
      working.hide();
      new Notice(`Could not set the passphrase: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  private async doCloudRecover(email: string, recoveryKey: string, newPassword: string): Promise<void> {
    const notice = new Notice('Recovering your account…', 0);
    try {
      const { result, keys, keyMaterial, recoveryKey: fresh } = await session.cloudRecover(
        this.plugin.identityClient(), email, recoveryKey, newPassword, describeInstall(this.app, this.plugin.secrets),
      );
      await this.plugin.applyCloudSignIn(result);
      this.plugin.settings.keyMaterial = keyMaterial;
      this.plugin.sessionKeys = keys;
      await this.plugin.rememberIdentity(keys.identity);
      await this.plugin.saveSettings();
      notice.hide();
      new RecoveryKeyModal(this.app, fresh, () => {
        this.plugin.settings.recoveryKeyAcknowledgedAt = Math.floor(Date.now() / 1000);
        void this.plugin.saveSettings();
      }).open();
      this.display();
    } catch (err) {
      notice.hide();
      new Notice(`Recovery failed: ${err instanceof Error ? err.message : 'Could not connect'}`);
    }
  }

  /**
   * A server you run yourself: the reduced set, because a self-hosted server
   * has no passkeys and no identity providers. Username and password, and the
   * two extra fields registration needs.
   */
  private displaySelfHostedSignIn(containerEl: HTMLElement): void {
    let usernameVal = '';
    let passwordVal = '';
    let emailVal = '';
    let inviteTokenVal = '';

    const card = this.signInShell(
      containerEl,
      'Connect this vault',
      `Sign in to sync ${this.app.vault.getName()} through your own server. Your notes stay on `
        + 'your disk, and your password never leaves this device — the server sees only a hash.',
    );

    const text = (parent: HTMLElement, label: string, attrs: Record<string, string>, onInput: (v: string) => void, desc?: string) => {
      const field = parent.createDiv('nectenda-field');
      field.createEl('label', { text: label });
      const input = field.createEl('input', { attr: attrs });
      input.oninput = () => onInput(input.value.trim());
      if (desc) field.createEl('p', { cls: 'nectenda-caption', text: desc });
      return input;
    };

    const server = text(
      card,
      'Server address',
      { type: 'text', placeholder: `ws://localhost:${DEFAULT_PORT}`, value: this.plugin.settings.serverUrl },
      () => undefined,
      'The WebSocket address of your Nectenda server.',
    );
    server.oninput = async () => {
      this.plugin.settings.serverUrl = server.value.trim();
      await this.plugin.saveSettings();
    };

    text(card, 'Username', { type: 'text', placeholder: 'Username' }, (v) => { usernameVal = v; });
    // Said here rather than only in the recovery-key modal that follows
    // registration: by then the choice has already been made.
    text(
      card,
      'Password',
      { type: 'password', placeholder: 'Password' },
      (v) => { passwordVal = v; },
      'Cannot be reset by anyone. Registering issues a recovery key — save it.',
    );

    const login = card.createEl('button', { cls: 'nectenda-primary nectenda-cut', text: 'Sign in' });
    login.type = 'button';
    login.onclick = () => void this.doLogin(usernameVal, passwordVal);

    // Registration needs two more things, and neither is any use to someone
    // signing in to an account they already have.
    const register = card.createEl('details', { cls: 'nectenda-group nectenda-register' });
    register.createEl('summary', { text: 'Create an account on this server' });
    text(register, 'Email', { type: 'email', placeholder: 'name@example.com' }, (v) => { emailVal = v; });
    text(
      register,
      'Invite token',
      { type: 'text', placeholder: 'Invite token' },
      (v) => { inviteTokenVal = v; },
      'Ask whoever runs the server for one.',
    );
    const registerBtn = register.createEl('button', { cls: 'nectenda-secondary nectenda-wide', text: 'Register' });
    registerBtn.type = 'button';
    registerBtn.onclick = () => void this.doRegister(usernameVal, emailVal, passwordVal, inviteTokenVal);

    const foot = card.createDiv('nectenda-foot');
    const forgot = foot.createEl('button', { cls: 'nectenda-bare', text: 'Forgot password?' });
    forgot.type = 'button';
    forgot.onclick = () => {
      if (!usernameVal) {
        new Notice('Enter your username first');
        return;
      }
      new RecoveryModal(this.app, (result) => {
        if (result) void this.doRecover(usernameVal, result.recoveryKey, result.password);
      }).open();
    };

    this.modeSwitch(card, 'cloud', 'Use Nectenda Cloud instead');
  }

  /** The self-hosted signed-in pane, in one piece. Cloud is composed from definitions instead. */
  private displayLoggedIn(containerEl: HTMLElement): void {
    const { settings } = this.plugin;

    new Setting(containerEl)
      .setName('Server')
      .setDesc(settings.serverUrl);

    new Setting(containerEl)
      .setName('Logged in as')
      .setDesc(`${settings.username} (${settings.userRole})`)
      .addButton((btn) =>
        btn.setButtonText('Logout').setWarning().onClick(async () => {
          await this.doLogout();
        })
      );

    // Shared Folders section
    this.displaySharedFolders(containerEl, this.plugin.servers()[0]);

    this.displayEncryption(containerEl);
    this.displayAccount(containerEl);

    this.displayTroubleshooting(containerEl);

    if (settings.userRole === 'admin') {
      this.displayAdminPanel(containerEl);
    }
  }

  /** Who is signed in, their display name, and the passphrase if it is not set yet. */
  private displayIdentityRows(containerEl: HTMLElement): void {
    const { settings } = this.plugin;
    const identity = settings.identity!;

    new Setting(containerEl)
      .setName('Signed in as')
      .setDesc(identity.email)
      .addButton((btn) =>
        btn.setButtonText('Sign out').setWarning().onClick(async () => {
          await this.plugin.signOutCloud('Signed out');
          this.display();
        }),
      );

    let displayName = identity.displayName;
    new Setting(containerEl)
      .setName('Display name')
      .setDesc('What collaborators see above your cursor. Not unique, spaces allowed.')
      .addText((text) => text.setValue(displayName).onChange((v) => (displayName = v)))
      .addButton((btn) =>
        btn.setButtonText('Save').onClick(async () => {
          const name = displayName.trim();
          if (!name) return;
          try {
            await this.plugin.identityClient().setDisplayName(settings.identityAccessToken, name);
            settings.identity = { ...identity, displayName: name };
            await this.plugin.saveSettings();
            new Notice('Display name saved. It shows on the next connection.');
          } catch (err) {
            new Notice(err instanceof Error ? err.message : 'Could not save the display name');
          }
        }),
      );

    if (!settings.keyMaterial?.publicKey) {
      new Setting(containerEl)
        .setName('Encryption passphrase')
        .setDesc('Not set yet. It protects every note you sync and never leaves this device.')
        .addButton((btn) =>
          btn.setButtonText('Set passphrase').setCta().onClick(async () => {
            if (await this.setCloudPassphrase()) this.display();
          }),
        );
    }

  }

  /** Invitations addressed to this identity, accepted here without any email. */
  private displayInvitations(containerEl: HTMLElement): void {
    const header = new Setting(containerEl).setName('Invitations').setHeading();
    header.addButton((btn) =>
      btn.setButtonText('Refresh').onClick(async () => {
        try {
          await this.plugin.refreshMemberships();
        } catch (err) {
          new Notice(err instanceof Error ? err.message : 'Could not reach the identity service');
        }
        this.display();
      }),
    );
    const slot = containerEl.createDiv();
    this.slots.invitations = slot;
    this.renderInvitations(slot);
    this.displaySentInvitations(containerEl);
  }

  /** The rows only: drawn from settings, which a background refresh rewrites. */
  private renderInvitations(slot: HTMLElement): void {
    slot.empty();
    const invites = this.plugin.settings.pendingInvites ?? [];
    if (invites.length === 0) noteRow(slot, 'No invitations waiting.');
    const invitesGroup = invites.length ? rowGroup(slot) : null;
    for (const invite of invites) {
      new Setting(invitesGroup!)
        .setName(invite.accountName)
        .setDesc(`Invited by ${invite.invitedBy} as ${invite.role}. Expires ${new Date(invite.expiresAt * 1000).toLocaleDateString()}.`)
        .addButton((btn) =>
          btn.setButtonText('Accept').setCta().onClick(async () => {
            if (!this.plugin.settings.keyMaterial?.publicKey && !(await this.setCloudPassphrase())) return;
            const working = new Notice(`Joining ${invite.accountName}…`, 0);
            try {
              const m = await this.plugin.acceptInvite(invite.id);
              working.hide();
              new Notice(`You have joined ${m.accountName}.`);
            } catch (err) {
              working.hide();
              new Notice(`Could not accept: ${err instanceof Error ? err.message : String(err)}`);
            }
            this.display();
          }),
        )
        .addButton((btn) =>
          btn.setButtonText('Decline').onClick(async () => {
            try {
              const token = this.plugin.settings.identityAccessToken;
              await this.plugin.identityClient().declineInvite(token, invite.id);
              this.plugin.settings.pendingInvites = this.plugin.settings.pendingInvites.filter((i) => i.id !== invite.id);
              await this.plugin.saveSettings();
            } catch (err) {
              if (err instanceof IdentityError && err.status === 401) {
                void this.plugin.recoverIdentitySession('decline invitation', this.plugin.settings.identityAccessToken).catch(() => undefined);
                return;
              }
              new Notice(err instanceof Error ? err.message : 'Could not decline');
            }
            this.display();
          }),
        );
    }
  }

  /**
   * The invitations sent from organisations this person owns or administers.
   *
   * Looked for here, in the same section as the ones addressed to them, and
   * not found: the Invite button fired and forgot. The service had recorded
   * every one all along — pending, declined, revoked, expired, and whether
   * the email even went — so this is the view of a record that already
   * existed.
   *
   * Scoped to the organisation, not the sender: an owner sees what their
   * admins sent, which matches who may revoke. Accepted ones are hidden — that
   * person is in the Members list, which is where they would be removed — and
   * revoked ones, being finished. The rest can still be acted on, and a
   * declined one can be revoked so it stops sitting there.
   */
  private displaySentInvitations(containerEl: HTMLElement): void {
    // No nectenda class: it carries no styling of its own and its rows are
    // ordinary Setting rows. Filled in once every organisation has answered.
    const holder = containerEl.createDiv();
    this.slots.sentInvites = holder;
    void this.loadSentInvitations(holder);
  }

  private async loadSentInvitations(holder: HTMLElement): Promise<void> {
    const generation = this.generations.next('sentInvites');
    // Read at load time, not at display time, so a membership refresh that
    // made this person an owner somewhere new is reflected without a gesture.
    const managed = this.plugin.settings.memberships.filter((m) => m.role === 'owner' || m.role === 'admin');
    const client = this.plugin.identityClient();
    const token = this.plugin.settings.identityAccessToken;
    const answered: Array<{ m: StoredMembership; rows: Array<{ invite: SentInvite; status: SentInviteStatus }> }> = [];
    for (const m of managed) {
      let list: SentInvite[];
      try {
        list = (await client.listAccountInvites(token, m.accountId)).invites;
      } catch (err) {
        if (err instanceof IdentityError && err.status === 401) {
          void this.plugin.recoverIdentitySession('sent invitations', token).catch(() => undefined);
          return;
        }
        // An organisation that cannot be asked is left out rather than
        // rendered as "none sent", which would be a claim.
        continue;
      }
      const rows = list
        .map((invite) => ({ invite, status: sentInviteStatus(invite) }))
        .filter(({ status }) => status !== 'accepted' && status !== 'revoked');
      if (rows.length) answered.push({ m, rows });
    }
    if (!this.alive() || !this.generations.isCurrent('sentInvites', generation)) return;
    // Emptied only now, after every answer is in, so a refresh never blanks
    // the list while it waits.
    holder.empty();
    for (const { m, rows } of answered) {
      holder.createEl('h4', { text: `Sent from ${m.accountName}` });
      const group = rowGroup(holder);
      for (const { invite, status } of rows) {
        const row = new Setting(group).setName(invite.email).setDesc(sentInviteDescription(invite, status));
        if (invite.mailError) row.descEl.addClass('mod-warning');
        row.addButton((btn) =>
          btn.setButtonText('Revoke').setWarning().onClick(async () => {
            try {
              await client.revokeInvite(token, m.accountId, invite.id);
              new Notice(`The invitation to ${invite.email} is revoked.`);
            } catch (err) {
              new Notice(err instanceof Error ? err.message : 'Could not revoke');
            }
            this.display();
          }),
        );
      }
    }
  }

  /** Every organisation this identity belongs to, and what an owner or admin can do there. */
  /** An owner's or admin's controls for the organisation, at the top of its page. */
  private displayOrganisationActions(containerEl: HTMLElement, m: StoredMembership): void {
    if (m.role !== 'owner' && m.role !== 'admin') return;
    new Setting(containerEl)
      .setName('Bring people in')
      .setDesc('An invitation goes to one address; the share link lets anyone holding it take a seat.')
      .addButton((btn) =>
        btn.setButtonText('Invite…').onClick(() => {
          new InviteByEmailModal(this.app, m, async (email, role) => {
            try {
              await this.plugin.identityClient().createInvite(this.plugin.settings.identityAccessToken, { accountId: m.accountId, email, role });
              new Notice(`Invitation sent to ${email}. It also appears in their Nectenda settings once they sign in.`);
              this.scheduleRefresh('memberships');
            } catch (err) {
              new Notice(err instanceof Error ? err.message : 'Could not send the invitation');
            }
          }).open();
        }),
      )
      .addButton((btn) =>
        btn.setButtonText('Share link').onClick(async () => {
          try {
            const server = this.plugin.serverForMembership(m.id);
            const res = await this.apiFetch(`${server.base}/account/share-key`, { headers: { Authorization: `Bearer ${server.token}` } });
            if (!res.ok) throw new Error('The server did not reveal the share key');
            const { shareKey, enabled } = (await res.json()) as { shareKey: string; enabled: boolean };
            if (!enabled) {
              new Notice('The share link is turned off for this organisation.');
              return;
            }
            const link = `obsidian://nectenda?key=${encodeURIComponent(shareKey)}&endpoint=${encodeURIComponent(m.endpoint)}`;
            await navigator.clipboard.writeText(link);
            new Notice('Share link copied. Anyone with it can take a seat, so send it only to people you mean to.');
          } catch (err) {
            new Notice(err instanceof Error ? err.message : 'Could not fetch the share link');
          }
        }),
      );
  }

  private displayOrganisationControls(containerEl: HTMLElement): void {
    // Always offered, not only when the list is empty: one person may want to
    // keep work and personal apart, and each organisation is billed on its own.
    new Setting(containerEl)
      .setName('Create an organisation')
      .setDesc('Somewhere of your own to share folders from. Starts on the free plan.')
      .addButton((btn) =>
        btn.setButtonText('Create…').onClick(() => {
          if (!this.plugin.settings.keyMaterial?.publicKey) {
            new Notice('Set your encryption passphrase first.');
            void this.setCloudPassphrase();
            return;
          }
          new NameOrganisationModal(this.app, this.suggestedOrganisationName(), async (name) => {
            await this.createOrganisation(name);
          }).open();
        }),
      );

    new Setting(containerEl)
      .setName('Join with a share link')
      .setDesc('Paste a link or key someone sent you.')
      .addText((text) => text.setPlaceholder('obsidian://nectenda?key=nk_… or nk_…').onChange((v) => (this.pendingShareLink = v.trim())))
      .addButton((btn) =>
        btn.setButtonText('Join').onClick(async () => {
          const raw = this.pendingShareLink;
          if (!raw) return;
          let key = raw;
          let endpoint: string | undefined;
          try {
            if (raw.startsWith('obsidian://')) {
              const u = new URL(raw);
              key = u.searchParams.get('key') ?? '';
              endpoint = u.searchParams.get('endpoint') ?? undefined;
            }
            if (!this.plugin.settings.keyMaterial?.publicKey && !(await this.setCloudPassphrase())) return;
            const joined = await this.plugin.joinByShareKey(key, endpoint);
            new Notice(`You have joined ${joined.accountName}.`);
          } catch (err) {
            new Notice(`Could not join: ${err instanceof Error ? err.message : String(err)}`);
          }
          this.display();
        }),
      );
  }
  private pendingShareLink = '';

  /** The devices signed in to this identity, from the identity service. */
  private displayCloudDevices(containerEl: HTMLElement): void {
    // The container is made before anything is awaited, so the section lands
    // here and not wherever the pane had got to by the time the answer came.
    const slot = containerEl.createDiv();
    this.slots.cloudDevices = slot;
    void this.loadCloudDevices(slot);
  }

  private async loadCloudDevices(containerEl: HTMLElement): Promise<void> {
    const generation = this.generations.next('cloudDevices');
    let me;
    const token = this.plugin.settings.identityAccessToken;
    try {
      me = await this.plugin.identityClient().me(token);
    } catch (err) {
      // A refused token is not "nothing to show": it is a session that ended
      // elsewhere, and the pane is the one place an idle install finds out.
      if (err instanceof IdentityError && err.status === 401) void this.plugin.recoverIdentitySession('signed-in vaults', token).catch(() => undefined);
      return;
    }
    if (!this.alive() || !this.generations.isCurrent('cloudDevices', generation)) return;
    containerEl.empty();
    const live = me.sessions.filter((s) => !s.revokedAt);
    if (live.length === 0) return;
    // Vaults, not devices: a sign-in belongs to a vault, and one machine with
    // two vaults is two rows here and one device on an organisation's roster.
    new Setting(containerEl).setName('Signed-in vaults').setHeading();
    // This vault's row is the one for its own session, which the access
    // token names; the install id is the fallback for a token that does not.
    const ownSid = sessionIdFromToken(token);
    const ownDevice = getOrCreateInstallId(this.plugin.secrets);
    // Real names where they can be read. Each row carries the vault's own name
    // sealed to this account's key, so opening it needs the identity unlocked;
    // a locked device — or a row sealed by a different account, or one that has
    // not published yet — falls back to the anonymous label the server holds.
    const identity = this.plugin.sessionKeys?.identity;
    const names = new Map<string, string>();
    if (identity) {
      for (const s of live) {
        const opened = await openVaultLabel(s.sealedLabel, identity.privateKey);
        if (opened) names.set(s.id, opened);
      }
      if (!this.alive() || !this.generations.isCurrent('cloudDevices', generation)) return;
    }
    const group = rowGroup(containerEl);
    for (const s of live) {
      const mine = ownSid ? s.id === ownSid : s.deviceId === ownDevice;
      // This vault knows its own name without opening anything.
      const named = (mine ? this.plugin.app.vault.getName() : null) ?? names.get(s.id);
      const row = new Setting(group)
        .setName(`${named || s.label || s.deviceId?.slice(0, 8) || 'A vault'}${mine ? ' (this vault)' : ''}`)
        .setDesc(`${s.platform ?? 'unknown'} — last used ${new Date(s.lastUsedAt * 1000).toLocaleDateString()}`);
      if (!mine) {
        row.addButton((btn) =>
          btn.setButtonText('Sign out').setWarning().onClick(async () => {
            log.info("Ending another vault's session", { sessionId: s.id, label: s.label ?? null });
            try {
              await this.plugin.identityClient().revokeSession(this.plugin.settings.identityAccessToken, s.id);
              new Notice('That vault will have to sign in again.');
            } catch (err) {
              new Notice(err instanceof Error ? err.message : 'Could not revoke');
            }
            this.display();
          }),
        );
      }
    }
    if (me.passkeys.length > 0) {
      new Setting(containerEl).setName('Passkeys').setHeading();
      const passkeyGroup = rowGroup(containerEl);
      for (const pk of me.passkeys) {
        new Setting(passkeyGroup)
          .setName(pk.label || 'Passkey')
          .setDesc(`Created ${new Date(pk.createdAt * 1000).toLocaleDateString()}${pk.lastUsedAt ? `, last used ${new Date(pk.lastUsedAt * 1000).toLocaleDateString()}` : ''}`)
          .addButton((btn) =>
            btn.setButtonText('Remove').setWarning().onClick(async () => {
              try {
                await this.plugin.identityClient().deletePasskey(this.plugin.settings.identityAccessToken, pk.credentialId);
              } catch (err) {
                new Notice(err instanceof Error ? err.message : 'Could not remove');
              }
              this.display();
            }),
          );
      }
    }
  }

  /**
   * Storage, seats and devices for the account.
   *
   * Rendered from one call, and silently absent if the server is older or
   * unreachable — a settings tab that refuses to draw because a status endpoint
   * is missing is worse than one that shows a little less.
   */
  private displayAccount(containerEl: HTMLElement, server = this.plugin.servers()[0]): void {
    if (!this.plugin.isSignedIn() || !server) return;
    const section = containerEl.createDiv('nectenda-surface nectenda-account');
    // Hidden until the first answer arrives: an "Account" heading over
    // nothing would be a claim about a server that has not been reached.
    section.hide();
    section.createEl('h3', { text: this.plugin.settings.mode === 'cloud' ? `Account: ${server.label}` : 'Account' });
    const slots: AccountSlots = {
      server,
      section,
      facts: section.createDiv(),
      members: section.createDiv(),
      attachments: section.createDiv(),
      devices: section.createDiv(),
      last: {},
    };
    this.accountSlots.set(server.base, slots);
    void this.loadAccount(slots);
  }

  /**
   * The real name of each vault on the roster, by install id.
   *
   * Every install carries its name sealed to the account's identity key, so
   * this needs the identity unlocked; a locked device gets an empty map and the
   * rows fall back to the anonymous label the server holds. An entry sealed by
   * a different account — two vaults on one machine, two accounts — simply does
   * not open, which is the same fallback rather than an error.
   */
  private async openVaultNames(
    devices: Array<{ installs?: Array<{ installId: string; sealedLabel?: string | null }> }>,
  ): Promise<Map<string, string>> {
    const names = new Map<string, string>();
    const identity = this.plugin.sessionKeys?.identity;
    if (!identity) return names;
    for (const d of devices) {
      for (const i of d.installs ?? []) {
        const opened = await openVaultLabel(i.sealedLabel, identity.privateKey);
        if (opened) names.set(i.installId, opened);
      }
    }
    return names;
  }

  /** One fetch; each slice redrawn only if it differs from what was drawn last. */
  private async loadAccount(slots: AccountSlots): Promise<void> {
    const { server } = slots;
    const generation = this.generations.next(`account:${server.base}`);
    let data: AccountResponse;
    try {
      const res = await this.apiFetch(`${server.base}/account`, {
        headers: { Authorization: `Bearer ${server.token}` },
      });
      if (!res.ok) return;
      data = (await res.json()) as AccountResponse;
    } catch {
      return;
    }
    if (!this.alive() || !this.generations.isCurrent(`account:${server.base}`, generation)) return;
    slots.section.show();

    const { usage, limits } = data;
    const redraw = (slice: keyof AccountSlots['last'], fingerprint: unknown, render: (into: HTMLElement) => void) => {
      const key = JSON.stringify(fingerprint);
      if (slots.last[slice] === key) return;
      slots.last[slice] = key;
      slots[slice].empty();
      render(slots[slice]);
    };

    redraw('facts', [usage, limits, data.messages, data.account.status, data.account.planId, data.seatsUsed, this.plugin.settings.quotaWarnPercent], (into) => {
      const summary = storageSummary(limits, usage);
      const used = summary.used;
      const storage = new Setting(into).setName('Storage').setDesc(summary.text);
      if (summary.bar) {
        // Inside the row it belongs to, under the figure it draws. On the pane
        // it would sit 16px to the left of that figure and outside its panel.
        const bar = storage.descEl.createDiv('nectenda-surface nectenda-usage-bar');
        const fill = bar.createDiv('nectenda-usage-fill');
        const pct = Math.min(100, (used / limits.quotaBytes) * 100);
        // The one thing here that cannot be a class: the width is the datum.
        fill.style.width = `${pct}%`;
        // A bar that goes red only at the limit tells the user when it is too
        // late to plan. The warning threshold is theirs to set.
        if (pct >= 100) fill.addClass('is-full');
        else if (pct >= this.plugin.settings.quotaWarnPercent) fill.addClass('is-warning');
      }

      // The server's own copy, shown ahead of the rows it explains. Suspension
      // has its own line below; the others — attachments not included,
      // storage full, an operator notice — were once being sent and dropped.
      for (const message of data.messages ?? []) {
        if (message.kind === 'suspended') continue;
        noteRow(into, message.text, message.kind === 'over-quota' ? 'mod-warning' : undefined);
      }
      if (data.account.status === 'suspended') {
        noteRow(
          into,
          'This account is suspended. Your notes are safe and nothing has been deleted, '
            + 'but new connections and uploads are refused. Contact the server administrator.',
        );
      }

      // Only offered for folders this vault has mapped. The server cannot name a
      // file it cannot read, so an unmapped folder can only ever be reported as a
      // total — see the modal for how that is said.
      new Setting(into)
        .setName('Manage storage')
        .setDesc('See what is taking up space and delete what you no longer need.')
        .addButton((b) =>
          b.setButtonText('Manage').onClick(() => {
            new ManageStorageModal(this.app, this.plugin, () => this.display()).open();
          }),
        );

      if (data.account.planId) {
        new Setting(into)
          .setName('Plan')
          .setDesc(
            limits.maxUsers === 0
              ? `${data.account.planId} — ${data.seatsUsed} user(s), no seat limit`
              : `${data.account.planId} — ${data.seatsUsed} of ${limits.maxUsers} users`,
          );
      }
    });

    redraw('members', [data.users, server.role, server.localUserId], (into) => {
      this.displayMembers(into, server, data.users ?? []);
    });

    redraw('attachments', [
      this.plugin.settings.pendingBlobUploads,
      this.plugin.settings.oversizedAttachments,
      this.plugin.strandedAttachments(),
      this.plugin.attachmentSettingWillStrandFiles(),
      this.plugin.deviceState?.skippedEntries() ?? [],
    ], (into) => {
      this.displayWaitingForSpace(into);
      this.displayStrandedAttachments(into);
      this.displaySkippedAttachments(into);
    });

    const devices = data.devices ?? [];
    const deviceSlots = data.deviceSlots;
    // Opened before the redraw, because `redraw` renders synchronously and the
    // unwrap is async. Part of the fingerprint too, so that the rows are drawn
    // again once the names resolve — otherwise the first paint after an unlock
    // would keep the anonymous labels until something else changed.
    const vaultNames = await this.openVaultNames(devices);
    redraw('devices', [devices, deviceSlots, [...vaultNames]], (into) => {
      if (devices.length === 0 && !deviceSlots) return;
      into.createEl('h4', { text: 'Devices' });
      // A device holds a slot from the moment it is added until it is removed,
      // open or not: the number to say is how many are on the roster, not
      // how many are connected this minute.
      if (deviceSlots && deviceSlots.max > 0) {
        noteRow(into, `Using ${deviceSlots.used} of ${deviceSlots.max} device slots. A device is one computer or phone; the vaults it syncs from are listed under it. Removing a device frees its slot at once.`);
      } else if (deviceSlots) {
        noteRow(into, 'This plan does not limit devices. The vaults each device syncs from are listed under it.');
      }
      const group = rowGroup(into);
      if (deviceSlots && deviceSlots.max > 0 && !deviceSlots.thisDeviceEnrolled) {
        new Setting(group)
          .setName('This device is not added here')
          .setDesc('It holds none of your deviceSlots in this organisation, so it is not syncing it. Adding it takes a slot.')
          .addButton((btn) =>
            btn.setButtonText('Add this device').setCta().onClick(async () => {
              const res = await this.apiFetch(`${server.base}/account/devices`, {
                method: 'POST',
                headers: { Authorization: `Bearer ${server.token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify(this.plugin.deviceFields()),
              });
              if (!res.ok) {
                const body = (await res.json().catch(() => ({}))) as { error?: string };
                new Notice(body.error ?? 'Could not add this device');
                return;
              }
              new Notice('Added. This device now syncs this organisation.');
              // The membership records the new standing and the socket opens
              // on the shape change; the pane follows.
              await this.plugin.refreshMemberships().catch(() => undefined);
              this.display();
            }),
          );
      }
      for (const d of devices) {
        const vaults = (d.installs ?? [])
          .map((i) => vaultNames.get(i.installId) ?? i.label)
          .filter((l): l is string => !!l);
        const setting = new Setting(group)
          .setName(`${d.label || d.deviceId.slice(0, 8)}${d.thisDevice ? ' (this device)' : ''}`)
          .setDesc(
            `${d.platform ?? 'unknown'}${vaults.length ? ` · ${vaults.join(', ')}` : ''} — ${d.connected ? 'connected now' : 'not connected'}`,
          );
        // Removal is the control, and it frees the slot at once; the device
        // itself keeps its notes and stops syncing this organisation. Not a
        // "Disconnect": a closed socket the device reopened a second later was
        // a button that lied.
        setting.addButton((btn) =>
          btn.setButtonText('Remove').setWarning().onClick(async () => {
            if (d.thisDevice && !window.confirm('Remove this device from the organisation? Its notes stay here; syncing this organisation stops until it is added again.')) return;
            const res = await this.apiFetch(`${server.base}/account/devices/${encodeURIComponent(d.deviceId)}`, {
              method: 'DELETE',
              headers: { Authorization: `Bearer ${server.token}` },
            });
            if (!res.ok) {
              new Notice('Could not remove that device');
              return;
            }
            new Notice(d.thisDevice ? 'Removed. This device no longer syncs this organisation.' : 'Removed. That device no longer syncs this organisation; its slot is free.');
            await this.plugin.refreshMemberships().catch(() => undefined);
            this.display();
          }),
        );
      }
    });
  }

  /**
   * Everyone holding a seat in the organisation, with what an owner or admin
   * may do about it.
   *
   * The server decides who may act: an admin may remove members, only an owner
   * may change roles or remove another owner, and the last owner can be
   * neither removed nor demoted (`LAST_OWNER`). The controls are shown and the
   * refusal is repeated verbatim rather than the client second-guessing rules
   * it cannot enforce. Nobody is offered a button to remove themselves.
   */
  private displayMembers(
    section: HTMLElement,
    server: ReturnType<NectendaPlugin['servers']>[number],
    users: NonNullable<AccountResponse['users']>,
  ): void {
    if (users.length === 0) return;
    // Self-hosted: the row is the authority and the server refuses what it
    // must; Cloud: the membership already says which role this person holds.
    const canManage = server.role === null || server.role === 'owner' || server.role === 'admin';
    const isOwner = server.role === null || server.role === 'owner';
    section.createEl('h4', { text: 'Members' });
    const roleLabel: Record<string, string> = { owner: 'owner', admin: 'admin', member: 'member' };
    const refresh = (): void => this.display();
    const explain = async (res: Response, fallback: string): Promise<void> => {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      new Notice(body.error ?? fallback);
    };
    const membersGroup = rowGroup(section);
    for (const u of users) {
      const self = u.id === server.localUserId || (server.localUsername !== null && u.username === server.localUsername);
      const row = new Setting(membersGroup)
        .setName(`${u.displayName || u.username}${self ? ' (you)' : ''}`)
        .setDesc(`${u.email}${u.accountRole ? ` — ${roleLabel[u.accountRole] ?? u.accountRole}` : ''}`);
      if (!canManage) continue;
      if (isOwner && !self) {
        row.addDropdown((drop) =>
          drop
            .addOption('member', 'Member')
            .addOption('admin', 'Admin')
            .addOption('owner', 'Owner')
            .setValue(u.accountRole ?? 'member')
            .onChange(async (value) => {
              const res = await this.apiFetch(`${server.base}/account/users/${encodeURIComponent(u.id)}`, {
                method: 'PATCH',
                headers: { Authorization: `Bearer ${server.token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ accountRole: value }),
              });
              if (!res.ok) await explain(res, 'Could not change the role');
              else new Notice(`${u.displayName || u.username} is now ${roleLabel[value] ?? value}`);
              refresh();
            }),
        );
      }
      if (!self) {
        row.addButton((btn) =>
          btn.setButtonText('Remove').setWarning().onClick(async () => {
            const res = await this.apiFetch(`${server.base}/account/users/${encodeURIComponent(u.id)}`, {
              method: 'DELETE',
              headers: { Authorization: `Bearer ${server.token}` },
            });
            if (!res.ok) await explain(res, 'Could not remove that member');
            else new Notice(`${u.displayName || u.username} was removed. Their notes stay on their device; they no longer sync here.`);
            refresh();
          }),
        );
      }
    }
  }

  /**
   * Attachments that could not be uploaded because the account is full.
   *
   * Distinct from both other lists: nothing is wrong with these files and no
   * decision was made about them. They are queued, and they upload themselves
   * the moment space exists — which is worth saying, because otherwise a
   * blocked upload looks like a broken one.
   */
  private displayWaitingForSpace(containerEl: HTMLElement): void {
    const pending = this.plugin.settings.pendingBlobUploads ?? [];
    if (pending.length === 0) return;

    containerEl.createEl('h4', { text: `Waiting for space (${pending.length})` });
    const waiting = document.createDocumentFragment();
    waiting.appendText('These will upload on their own once there is room. Your notes are syncing '
      + 'normally in the meantime.');
    for (const key of pending) {
      const gap = key.indexOf(' ');
      if (gap < 0) continue;
      // The queue key is `<folder> <path>`; the path is the half worth showing.
      waiting.createDiv({ text: key.slice(gap + 1) });
    }
    noteRow(containerEl, waiting);
  }

  /**
   * Attachments a shared note points at that are not in a shared folder.
   *
   * Distinct from the skipped list below: nothing went wrong here and no
   * decision was made — the files are simply somewhere that does not sync,
   * usually because Obsidian's default puts them in the vault root.
   */
  private displayStrandedAttachments(containerEl: HTMLElement): void {
    const stranded = this.plugin.strandedAttachments();
    const misconfigured = this.plugin.attachmentSettingWillStrandFiles();
    const oversizedCount = (this.plugin.settings.oversizedAttachments ?? []).length;
    if (stranded.length === 0 && !misconfigured && oversizedCount === 0) return;

    containerEl.createEl('h4', { text: 'Attachments that will not sync' });

    if (misconfigured) {
      new Setting(containerEl)
        .setName('New attachments are saved outside your shared folders')
        .setDesc(
          'Obsidian saves dropped files to the vault root by default, which is not shared. '
            + 'Anything you attach to a shared note will look broken to everyone else.',
        )
        .addButton((b) =>
          b.setButtonText('Save attachments beside the note').setCta().onClick(() => {
            if (this.plugin.setAttachmentsBesideNote()) {
              new Notice('Nectenda: new attachments will now be saved next to their note.');
            } else {
              new Notice('Nectenda: could not change it — set it in Files and links.');
            }
            this.display();
          }),
        );
    }

    // Too large for the account, as opposed to merely in the wrong place.
    // Nothing the user does to the folder layout will fix these.
    // Both lists are files with a problem, so they share one box. The row
    // above is a setting to change, not a file, and stays outside it.
    const problems = rowGroup(containerEl);
    const oversized = this.plugin.settings.oversizedAttachments ?? [];
    for (const key of oversized) {
      const gap = key.indexOf(' ');
      if (gap < 0) continue;
      const folderId = key.slice(0, gap);
      const relative = key.slice(gap + 1);
      const cap = this.plugin.maxBlobBytes();
      new Setting(problems)
        .setName(relative)
        .setDesc(
          `Larger than the ${formatBytes(cap)} limit for this account, so it is not `
            + 'uploaded. Shrink it, split it, or ask the server administrator to raise '
            + 'the limit.',
        )
        .addButton((b) =>
          b.setButtonText('Try again').onClick(async () => {
            // The limit may have been raised, or the file replaced with a
            // smaller one. Retrying re-checks rather than assuming.
            this.plugin.settings.oversizedAttachments = oversized.filter((k) => k !== key);
            await this.plugin.saveSettings();
            await this.plugin.blobSync?.upload(folderId, relative);
            this.display();
          }),
        );
    }

    for (const item of stranded) {
      new Setting(problems)
        .setName(item.attachmentPath)
        .setDesc(
          `Used by "${item.notePath}" but stored outside "${item.sharedFolderPath}", `
            + 'so it is not uploaded and other people see a broken link.',
        )
        .addButton((b) =>
          b.setButtonText(`Move into ${item.sharedFolderPath}`).onClick(async () => {
            await this.plugin.adoptStrandedAttachment(item);
            this.display();
          }),
        );
    }
  }

  /**
   * Attachments this device is not downloading, and why.
   *
   * Separates the two reasons on purpose: a file the user declined is a choice,
   * and a file that crashed the app is a finding. Presenting them identically
   * would make the app look as though it had simply lost things.
   */
  private displaySkippedAttachments(containerEl: HTMLElement): void {
    const state = this.plugin.deviceState;
    const skipped = state?.skippedEntries() ?? [];
    if (skipped.length === 0) return;

    containerEl.createEl('h4', { text: 'Not downloaded on this device' });
    noteRow(
      containerEl,
      'These are stored on the server and available on your other devices. '
        + `This device currently opens attachments up to ${formatBytes(state!.budgetBytes)}.`,
    );

    const skippedGroup = rowGroup(containerEl);
    for (const [key, record] of skipped) {
      const slash = key.indexOf('/');
      const folderId = key.slice(0, slash);
      const relative = key.slice(slash + 1);
      new Setting(skippedGroup)
        .setName(relative)
        .setDesc(
          record.declined
            ? `${formatBytes(record.bytes)} — you chose to skip this on this device.`
            : `${formatBytes(record.bytes)} — Obsidian closed while opening this `
              + `${record.failures === 1 ? 'once' : `${record.failures} times`}.`,
        )
        .addButton((b) =>
          b.setButtonText('Try again').onClick(async () => {
            await this.plugin.retryAttachment(folderId, relative);
            this.display();
          }),
        );
    }
  }

  /**
   * One organisation's shared folders, on its page: what it lists, what this
   * vault syncs from it, and the folder it could share next. A vault folder
   * belongs to one organisation, so sharing here never touches another's.
   */
  private displaySharedFolders(containerEl: HTMLElement, server: FolderServer): void {
    containerEl.createEl('h3', { text: 'Shared folders' });

    const foldersContainer = createDiv('nectenda-surface nectenda-folders');
    new Setting(containerEl)
      .setName('Share a folder')
      .setDesc(
        this.plugin.settings.mode === 'cloud'
          ? 'Choose a vault folder to share with this organisation.'
          : 'Choose a vault folder to share with all users on this server.',
      )
      .addButton((btn) =>
        btn.setButtonText('Share Folder').setCta().onClick(() => {
          new FolderPickerModal(this.app, async (folder) => {
            await this.shareFolder(folder.path, folder.name, server, foldersContainer);
          }).open();
        })
      );
    // The list draws under the share row.
    containerEl.appendChild(foldersContainer);

    this.folderSlots.set(server.base, { el: foldersContainer, server });
    void this.loadSharedFolders(foldersContainer, server);
  }

  /** Mappings no organisation's page can claim, listed on the home pane to be unmapped. */
  private displayUnclaimedMappings(containerEl: HTMLElement): void {
    containerEl.createEl('h3', { text: 'Folders needing attention' });
    noteRow(containerEl, 'These folders were mapped before mappings recorded their organisation, and this vault now belongs to several. They still sync; unmap one to stop that, then share or map it again from the organisation\'s page.');
    const group = rowGroup(containerEl);
    for (const m of unclaimedMappings(this.plugin.settings.folderMappings, this.plugin.settings.memberships.length)) {
      new Setting(group)
        .setName(m.sharedFolderName)
        .setDesc(`Local: ${m.localPath}`)
        .addButton((btn) =>
          btn.setButtonText('Unmap').setWarning().onClick(async () => {
            this.plugin.settings.folderMappings = this.plugin.settings.folderMappings.filter((x) => x.sharedFolderId !== m.sharedFolderId);
            await this.plugin.saveSettings();
            this.plugin.refreshSync();
            this.update();
          }),
        );
    }
  }

  private async loadSharedFolders(container: HTMLElement, server: FolderServer): Promise<void> {
    const generation = this.generations.next(`sharedFolders:${server.base}`);
    try {
      type ListedFolder = SharedFolderInfo & { role?: FolderRole; membershipId: string | null };
      const res = await this.apiFetch(`${server.base}/folders`, {
        headers: { Authorization: `Bearer ${server.token}`, 'Content-Type': 'application/json' },
      });
      if (!res.ok) throw new Error(`folders: ${res.status}`);
      const listed = (await res.json()) as { folders: (SharedFolderInfo & { role?: FolderRole })[] };
      const folders: ListedFolder[] = listed.folders.map((f) => ({ ...f, membershipId: server.membershipId }));
      if (!this.alive() || !this.generations.isCurrent(`sharedFolders:${server.base}`, generation)) return;
      // Keys the owner has wrapped for us since the last look, so the names
      // below open on the first draw rather than after a map.
      await this.openEnvelopes(folders, server);
      if (!this.alive() || !this.generations.isCurrent(`sharedFolders:${server.base}`, generation)) return;
      // Emptied only now, with the answer in hand, so a poll that is still
      // waiting never blanks the list.
      container.empty();

      // Names arrive sealed. Open them in place, so every display below reads a
      // name rather than base64. A folder this device holds no key for cannot be
      // named at all — which is not an error, it is what an unaccepted invitation
      // looks like — so it gets a placeholder and the existing unlock affordance.
      let renamed = false;
      for (const folder of folders) {
        const opened = await openFolderName(this.plugin.folderCrypto.get(folder.id), folder);
        folder.name = opened ?? `Locked folder (${folder.id.slice(0, 8)})`;
        // The owner may have renamed it since this vault mapped it. Keep the
        // stored copy in step, because the rows that cannot open the name
        // themselves read it: a locked folder, an orphan whose folder has left
        // the listing, and the "no longer shared" notice.
        //
        // `sharedFolderName` **only**. Nothing a server said may reach
        // `localPath`: this vault's folder is where its owner put it, and a
        // rename elsewhere must never move a directory or a file here.
        const mapping = opened
          ? this.plugin.settings.folderMappings.find((m) => m.sharedFolderId === folder.id)
          : undefined;
        if (opened && mapping && mapping.sharedFolderName !== opened) {
          mapping.sharedFolderName = opened;
          renamed = true;
        }
      }
      if (renamed) await this.plugin.saveSettings();

      // Two folders can open to the same name. Disambiguate only those, and
      // only after every name is open, so the comparison is between what people
      // actually read rather than between ciphertexts.
      const ambiguous = ambiguousNames(folders);
      const label = (f: ListedFolder): string =>
        ambiguous.has(f.name) ? `${f.name} (${f.id.slice(0, 8)})` : f.name;
      /** What this folder is, past its name: who shares it, how busy, how big. */
      const describe = (f: ListedFolder): string[] => {
        const bytes = this.plugin.folderSize(f.id);
        const age = describeAge(f.lastActivityAt);
        return [
          `Shared by ${f.createdByDisplayName || f.createdByUsername || 'unknown'}`,
          typeof f.members === 'number' ? `${f.members} member${f.members === 1 ? '' : 's'}` : null,
          f.lastActivityAt ? `active ${age}` : 'no changes yet',
          typeof bytes === 'number' ? formatBytes(bytes) : null,
        ].filter((part): part is string => !!part);
      };

      // Names still sealed with the passphrase not in memory: one row, one
      // prompt for all of them, rather than a placeholder per folder that
      // nothing on the page can explain.
      const hidden = folders.filter((f) => !this.plugin.folderCrypto.hasKeys(f.id));
      if (hidden.length > 0 && !this.plugin.sessionKeys?.identity) {
        new Setting(container)
          .setName('Some folder names are hidden')
          .setDesc(`${hidden.length} shared ${hidden.length === 1 ? 'folder' : 'folders'} can be named once your passphrase is entered.`)
          .addButton((btn) =>
            btn.setButtonText('Show names').setCta().onClick(async () => {
              const identity = await this.ensureIdentity('Reading the names of your shared folders.');
              if (!identity) return;
              for (const f of hidden) await this.fetchFolderKeys(f.id, identity, server);
              await this.loadSharedFolders(container, server);
            }),
          );
      }

      const mappings = this.plugin.settings.folderMappings || [];

      // An empty listing used to return here, which hid the very mappings
      // that most need showing: unshare the last folder and its mapping
      // became invisible — still routing files, with nothing on screen to
      // unmap. Only say "none yet" when this vault holds none either.
      if (folders.length === 0 && !mappings.some((m) => mappingBelongsTo(m, server, new Set()))) {
        noteRow(container, 'No shared folders yet. Share a folder to get started.');
        return;
      }

      // Refresh the stored role from the server. It decides whether the editor
      // accepts input, so a mapping made before a demotion would otherwise keep
      // offering to edit a folder this account can no longer write to.
      let roleChanged = false;
      for (const folder of folders) {
        const mapping = mappings.find((m) => m.sharedFolderId === folder.id);
        if (mapping && folder.role && mapping.role !== folder.role) {
          mapping.role = folder.role;
          roleChanged = true;
        }
      }
      if (roleChanged) {
        await this.plugin.saveSettings();
        this.plugin.refreshSync();

        // Now that something is shared, Obsidian's default becomes a trap:
        // attachments dropped into these notes go to the vault root and never
        // sync. Offered here rather than left in settings, because this is the
        // moment it starts to matter and the moment the user is thinking about
        // it.
        if (this.plugin.attachmentSettingWillStrandFiles()) {
          new AttachmentLocationModal(this.app, () => {
            if (this.plugin.setAttachmentsBesideNote()) {
              new Notice('Nectenda: attachments will now be saved next to their note.');
            }
            this.display();
          }).open();
        }
      }

      // Only this organisation's mappings are read against its listing: a
      // folder mapped from another organisation is not an orphan here.
      //
      // Orphans — mappings whose folder is no longer on the server — have to
      // be listed, because the rest of this view is built from what the
      // server returns; unlisted, one is invisible and cannot be removed,
      // while still shadowing a live mapping for the same path. Keyless —
      // mapped and listed, but with no key on this device — are called out
      // separately, because the fix is different: unlock, not unmap.
      const { keyless, orphans, mapped, unmapped } = partitionFolders({
        folders, mappings, server, hasKeys: (id) => this.plugin.folderCrypto.hasKeys(id),
      });
      if (keyless.length > 0) {
        container.createEl('h4', { text: 'Locked' });
        const lockedGroup = rowGroup(container);
        for (const locked of keyless) {
          const folder = folders.find((f) => f.id === locked.sharedFolderId)!;
          new Setting(lockedGroup)
            .setName(locked.sharedFolderName)
            .setDesc(
              `${locked.localPath} — this device has no key for this folder, so nothing syncs. ` +
                'Unlock it with your password, or unmap it.',
            )
            .addButton((btn) =>
              btn
                .setButtonText('Unlock')
                .setCta()
                .onClick(async () => {
                  if (await this.loadFolderKeys(folder.id, folder.name)) {
                    this.plugin.refreshSync();
                    new Notice(`Unlocked "${folder.name}"`);
                  }
                  await this.loadSharedFolders(container, server);
                }),
            )
            .addButton((btn) =>
              btn.setButtonText('Unmap').setWarning().onClick(async () => {
                this.plugin.settings.folderMappings = this.plugin.settings.folderMappings.filter(
                  (m) => m.sharedFolderId !== locked.sharedFolderId,
                );
                await this.plugin.saveSettings();
                this.plugin.refreshSync();
                await this.loadSharedFolders(container, server);
              }),
            );
        }
      }

      if (orphans.length > 0) {
        container.createEl('h4', { text: 'No longer shared' });
        const orphanGroup = rowGroup(container);
        for (const orphan of orphans) {
          new Setting(orphanGroup)
            .setName(orphan.sharedFolderName)
            .setDesc(
              `${orphan.localPath} — this folder is no longer on the server: its owner unshared it, ` +
                'or it was deleted. Your notes are untouched; unmapping only stops Nectenda looking for it.',
            )
            .addButton((btn) =>
              btn
                .setButtonText('Unmap')
                .setWarning()
                .onClick(async () => {
                  this.plugin.settings.folderMappings = this.plugin.settings.folderMappings.filter(
                    (m) => m.sharedFolderId !== orphan.sharedFolderId,
                  );
                  delete this.plugin.settings.folderKeys[orphan.sharedFolderId];
                  await this.plugin.saveSettings();
                  this.plugin.refreshSync();
                  await this.loadSharedFolders(container, server);
                }),
            );
        }
      }

      if (mapped.length > 0) {
        container.createEl('h4', { text: 'Synced Folders' });
        const mappedGroup = rowGroup(container);
        for (const folder of mapped) {
          const mapping = mappings.find((m) => m.sharedFolderId === folder.id)!;
          const roleLabel = folder.role === 'owner' ? ' \u2014 owner' : '';
          const setting = new Setting(mappedGroup)
            .setName(label(folder))
            .setDesc(`Local: ${mapping.localPath} \u2014 ${describe(folder).join(' \u00b7 ')}${roleLabel}`);
          if (folder.role === 'owner') {
            setting.addButton((btn) =>
              btn.setButtonText('Members').onClick(() => {
                new FolderMembersModal(this.app, this.plugin, folder.id, folder.name).open();
              }),
            );
          }
          if (mayUnshare(folder, server)) {
            setting.addButton((btn) =>
              btn.setButtonText('Unshare…').setWarning().onClick(() => {
                void this.unshareFolder(folder, server, container);
              }),
            );
          }
          setting
            .addButton((btn) =>
              btn.setButtonText('Unmap').onClick(async () => {
                this.plugin.settings.folderMappings = this.plugin.settings.folderMappings.filter((m) => m.sharedFolderId !== folder.id);
                await this.plugin.saveSettings();
                this.plugin.refreshSync();
                await this.loadSharedFolders(container, server);
              })
            );
        }
      }

      if (unmapped.length > 0) {
        container.createEl('h4', { text: 'Available Folders' });
        const unmappedGroup = rowGroup(container);
        for (const folder of unmapped) {
          const row = new Setting(unmappedGroup)
            .setName(label(folder))
            .setDesc(describe(folder).join(' \u00b7 '))
            .addButton((btn) =>
              btn.setButtonText('Quick Map').setCta().onClick(async () => {
                await this.quickMapFolder(folder, container);
              })
            )
            .addButton((btn) =>
              btn.setButtonText('Choose Folder').onClick(() => {
                new FolderPickerModal(this.app, async (localFolder) => {
                  await this.mapFolder(folder, localFolder.path, container);
                }).open();
              })
            );
          if (mayUnshare(folder, server)) {
            row.addButton((btn) =>
              btn.setButtonText('Unshare…').setWarning().onClick(() => {
                void this.unshareFolder(folder, server, container);
              }),
            );
          }
        }
      }
    } catch {
      if (!this.alive() || !this.generations.isCurrent(`sharedFolders:${server.base}`, generation)) return;
      container.empty();
      noteRow(container, 'Failed to load shared folders', 'mod-warning');
    }
  }

  private async shareFolder(path: string, name: string, server: FolderServer, container: HTMLElement): Promise<void> {
    // A vault folder belongs to one organisation. Sharing a path that is
    // mapped already — here or anywhere else — used to replace the earlier
    // mapping without a word; it is refused, naming what is in the way.
    const covering = mappingCovering(path, this.plugin.settings.folderMappings);
    if (covering) {
      new Notice(this.alreadySharedMessage(path, covering));
      return;
    }
    const membershipId = server.membershipId;
    try {
      const { base } = server;

      // Keys first, because the folder's name is sealed under them and the
      // server must never see it in the clear — not even for the moment
      // between creating the folder and encrypting its name afterwards. The id
      // is bookkeeping only and none of the key material depends on it, so it
      // is filled in once the server assigns one.
      const keys = await createFolderKeys('');
      const sealed = await sealFolderName(keys, name);

      const res = await this.apiFetch(`${base}/folders`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${server.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(sealed),
      });

      if (!res.ok) {
        const err = await res.json() as { error: string };
        new Notice(`Failed: ${err.error}`);
        return;
      }

      const { folder } = await res.json() as { folder: SharedFolderInfo };
      keys.folderId = folder.id;

      // Publish the keys sealed to our own identity. Without this the folder
      // exists but nothing can be encrypted for it, and the failure would only
      // show up later as an unreadable folder.
      try {
        await this.publishKeys(folder.id, await wrapKeysFor(keys, '', await this.ownPublicKey()), server);
        await this.plugin.rememberFolderKeys(keys);
      } catch (err) {
        new Notice('Folder created, but its encryption keys could not be published.');
        log.error('Could not publish folder keys', { folderId: folder.id, error: String(err) });
      }

      this.plugin.settings.folderMappings = [
        ...this.plugin.settings.folderMappings,
        {
          sharedFolderId: folder.id,
          // The local name, not the server's copy — that one is sealed now, and
          // storing it here would put base64 in the settings UI.
          sharedFolderName: name,
          localPath: path,
          // You created it, so the server has made you its owner.
          role: 'owner',
          ...(membershipId ? { membershipId } : {}),
        },
      ];
      await this.plugin.saveSettings();
      this.plugin.refreshSync();

      new Notice(`Folder "${name}" shared and mapped`);
      // Redraw the list in place: a rebuild of the pane would close the page.
      await this.loadSharedFolders(container, server);
    } catch (err) {
      log.error('Failed to share folder:', err);
      new Notice('Failed to share folder');
    }
  }

  /**
   * Unshare a folder: delete the server's copy, keep every vault's files.
   *
   * The owner could remove every other member and still be left with the
   * folder listed for ever. What goes is the server's copy — the history and
   * the attachments with it, for everyone. What stays is the notes: this
   * vault's and every member's, as ordinary files on their own disks.
   */
  private async unshareFolder(folder: { id: string; name: string }, server: FolderServer, container: HTMLElement): Promise<void> {
    // How many other people this affects, when the server will say. Not worth
    // refusing the unshare over: the confirm reads without the sentence.
    let others: number | null = null;
    try {
      const res = await this.apiFetch(`${server.base}/folders/${folder.id}/members`, {
        headers: { Authorization: `Bearer ${server.token}` },
      });
      if (res.ok) {
        const { members } = (await res.json()) as { members: Array<{ userId: string }> };
        others = Math.max(0, members.length - 1);
      }
    } catch {
      others = null;
    }
    if (!(await this.confirmUnshare(folder.name, others))) return;

    const res = await this.apiFetch(`${server.base}/folders/${folder.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${server.token}` },
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      new Notice(body.error ?? 'Could not unshare that folder');
      return;
    }
    // Local only after the server agreed. The notes themselves are untouched:
    // the mapping and the cached keys are bookkeeping about a folder that no
    // longer exists.
    this.plugin.settings.folderMappings = this.plugin.settings.folderMappings.filter((m) => m.sharedFolderId !== folder.id);
    this.plugin.folderCrypto.remove(folder.id);
    delete this.plugin.settings.folderKeys[folder.id];
    await this.plugin.saveSettings();
    this.plugin.refreshSync();
    new Notice(`Unshared "${folder.name}". Your notes stay in this vault.`);
    await this.loadSharedFolders(container, server);
  }

  /** Its own method so a test can answer it without driving a modal. */
  private confirmUnshare(name: string, others: number | null): Promise<boolean> {
    return new Promise((resolve) => new UnshareFolderModal(this.app, name, others, resolve).open());
  }

  /** Why a share or a map was refused: the mapping in the way, and where it belongs. */
  private alreadySharedMessage(path: string, covering: FolderMapping): string {
    const org = this.plugin.settings.mode === 'cloud'
      ? this.plugin.settings.memberships.find((x) => x.id === covering.membershipId)?.accountName ?? 'another organisation'
      : 'this server';
    const where = covering.localPath === path ? `"${path}"` : `"${path}" is inside "${covering.localPath}", which`;
    return `${where} is already shared in ${org} as "${covering.sharedFolderName}". Unmap it there first.`;
  }

  private async quickMapFolder(folder: SharedFolderInfo & { role?: FolderRole; membershipId?: string | null }, container: HTMLElement): Promise<void> {
    // Keys first, because the folder's name is sealed and `folder.name` is only
    // a placeholder — "Locked folder (a1b2c3d4)" — until they are held. Naming
    // a real directory from that placeholder is exactly what happened: the
    // first quick map created a folder called "Locked folder (…)" on disk, and
    // it only looked right afterwards because the keys were cached by then.
    if (!(await this.loadFolderKeys(folder.id, folder.name, folder.membershipId ?? null))) {
      new Notice(
        'That folder was not mapped: its encryption key could not be unlocked. ' +
          'Try again and enter your password, or ask an owner to share it with you.',
      );
      return;
    }

    const localPath = await openFolderName(this.plugin.folderCrypto.get(folder.id), folder)
      ?? folder.name;
    try {
      const vault = this.plugin.app.vault;
      const existing = vault.getAbstractFileByPath(localPath);
      if (!existing) {
        await vault.createFolder(localPath);
      }
    } catch {
      // Folder may already exist
    }

    await this.mapFolder(folder, localPath, container);
  }

  /** This account's identity public key, for sealing a folder key to itself. */
  private async ownPublicKey(): Promise<string> {
    const publicKey = this.plugin.settings.keyMaterial?.publicKey;
    if (!publicKey) throw new Error('This account has no encryption keys enrolled');
    return publicKey;
  }

  private async publishKeys(
    folderId: string,
    keys: Omit<FolderKeyRecord, 'folderId'>[],
    server: { base: string; token: string } = this.plugin.serverFor(folderId),
  ): Promise<void> {
    const res = await this.apiFetch(`${server.base}/folders/${folderId}/keys`, {
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
   * The identity keypair, asking for the password if this session has none.
   *
   * Held for the rest of the session once unlocked, and — where the OS gives
   * somewhere to hold it — for the device, so this is asked once per machine
   * rather than once per vault. It used to say "never written down"; that
   * stopped being true. See docs/key-storage.md.
   */
  private async ensureIdentity(reason: string): Promise<CryptoKeyPair | null> {
    const existing = this.plugin.sessionKeys?.identity;
    if (existing) return existing;

    // Held for this device, where the OS provides somewhere to hold it. Asked
    // here as well as at startup so that signing in partway through a session
    // gets the same answer, rather than the cache depending on onload timing.
    const held = await this.plugin.restoreIdentity();
    if (held) {
      this.plugin.sessionKeys = { identity: held };
      return held;
    }

    const { username, keyMaterial, serverUrl, mode } = this.plugin.settings;
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
        if (await this.setCloudPassphrase()) return this.plugin.sessionKeys?.identity ?? null;
        return null;
      }
      new Notice('This account has no encryption keys enrolled. Log in again to enrol them.');
      return null;
    }

    if (!unlockable) {
      // Half-enrolled. Never offer to set a passphrase here: that would replace
      // the keypair the account's folder keys are wrapped to.
      new Notice('This account\u2019s encryption keys are incomplete. Sign in again, or recover with your recovery key.');
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
        new Notice('Could not reach your server to unlock. Check the connection and try again.');
        log.warn('Could not fetch the KDF parameters for an unlock', { error: String(err) });
        return null;
      }
    }

    const unlocked = await this.promptForPassphrase(reason, (password) =>
      this.verifyPassphrase(password, keyMaterial, selfHostedParams),
    );
    if (!unlocked) {
      // Said rather than silent: a dismissed prompt used to leave no trace at
      // all, and the folders it would have opened just render as locked.
      new Notice('Passphrase not entered. Your shared folders stay locked until it is.');
      return null;
    }
    return this.plugin.sessionKeys?.identity ?? null;
  }

  /**
   * One attempt at the passphrase, as an outcome rather than an exception.
   *
   * Split from the prompt so it can be tested without a modal, and so the two
   * failures stay distinguishable: a wrong passphrase is a typo and is offered
   * another go; halves that do not belong together are not, and say so.
   *
   * On success the keys land in `sessionKeys`, which holds them for the rest of
   * the Obsidian session even where nothing can be written to a credential
   * store, and `rememberIdentity` keeps them for the device where it can.
   */
  private async verifyPassphrase(
    password: string,
    keyMaterial: KeyMaterial & { kdfParams?: KdfParams | null },
    selfHostedParams: KdfParams | null,
  ): Promise<VerifyOutcome> {
    // Taken as an argument, not re-read from settings. The caller checked both
    // halves are present, and `refreshMemberships` rewrites `keyMaterial` from
    // the server on a timer of its own — re-reading here would let it change
    // between the check and the attempt.
    const { mode } = this.plugin.settings;
    try {
      const keys = mode === 'cloud'
        ? await session.cloudUnlock(password, { ...keyMaterial, kdfParams: keyMaterial.kdfParams ?? null })
        : await session.unlockWith(selfHostedParams!, password, keyMaterial);
      if (!(await identityPairs(keys.identity))) {
        // The passphrase was right — AES-GCM proved that by opening the blob.
        // The halves not belonging together means the material is corrupt or
        // was substituted, which must not read as a typo and must not invite
        // another attempt.
        log.error('Unwrapped identity does not pair with the stored public key');
        new Notice('Your encryption keys did not verify. Do not enter your passphrase again until you know why.');
        return { ok: false, fatal: true, message: 'Your encryption keys did not verify.' };
      }
      this.plugin.sessionKeys = keys;
      await this.plugin.rememberIdentity(keys.identity);
      return { ok: true };
    } catch (err) {
      log.warn('Identity unlock failed', { error: String(err) });
      return { ok: false, message: 'That passphrase did not open your key.' };
    }
  }

  /** Open the prompt and resolve once it is unlocked, cancelled or dismissed. */
  private async promptForPassphrase(
    reason: string,
    verify: (password: string) => Promise<VerifyOutcome>,
  ): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      new PasswordPromptModal(this.app, { reason, verify, onDone: resolve }).open();
    });
  }

  /** Fetch this folder's wrapped keys and unwrap them. False when unusable. */
  private async loadFolderKeys(folderId: string, folderName = 'this folder', membershipId: string | null = null): Promise<boolean> {
    // Already held: no fetch, and — more to the point — no password prompt.
    // ensureIdentity below will ask for one, and asking again for keys this
    // device has already unwrapped is a prompt the user cannot make sense of.
    if (this.plugin.folderCrypto.get(folderId)) return true;

    const identity = await this.ensureIdentity(
      `Unlocking the encryption key for “${folderName}”.`,
    );
    if (!identity) return false;
    const server = membershipId ? this.plugin.serverForMembership(membershipId) : this.plugin.serverFor(folderId);
    return this.fetchFolderKeys(folderId, identity, server);
  }

  /**
   * Fetch this folder's wrapped keys and unwrap them with an identity already
   * in hand. Never prompts, so the pane's own rendering can call it. False
   * when the server holds nothing this identity can open — a folder shared
   * before a key was wrapped for us — or on any failure.
   */
  private async fetchFolderKeys(folderId: string, identity: CryptoKeyPair, server: { base: string; token: string }): Promise<boolean> {
    try {
      const res = await this.apiFetch(`${server.base}/folders/${folderId}/keys`, {
        headers: { Authorization: `Bearer ${server.token}` },
      });
      if (!res.ok) return false;
      const { keys } = (await res.json()) as { keys: FolderKeyRecord[] };
      const unwrapped = await unwrapFolderKeys(folderId, keys, identity.privateKey);
      if (!unwrapped) return false;
      await this.plugin.rememberFolderKeys(unwrapped);
      return true;
    } catch (err) {
      log.error('Could not load folder keys', { folderId, error: String(err) });
      return false;
    }
  }

  /**
   * Folders this device holds no key for, asked about once per poll while the
   * pane is open — and only when the passphrase is already in memory, so a
   * render never raises a prompt. Keys were fetched only on map or unlock
   * before, so a folder shared with this person stayed "Locked folder (…)"
   * however long they looked at it.
   */
  private envelopeChecked = new Set<string>();

  private async openEnvelopes(folders: Array<{ id: string }>, server: FolderServer): Promise<void> {
    const identity = this.plugin.sessionKeys?.identity;
    if (!identity) return;
    for (const f of folders) {
      if (this.plugin.folderCrypto.hasKeys(f.id) || this.envelopeChecked.has(f.id)) continue;
      if (!(await this.fetchFolderKeys(f.id, identity, server))) this.envelopeChecked.add(f.id);
    }
  }

  private async mapFolder(
    folder: SharedFolderInfo & { role?: FolderRole; membershipId?: string | null },
    localPath: string,
    container: HTMLElement,
  ): Promise<void> {
    // Fetch and unwrap this folder's keys before mapping it, and do not map it
    // at all if that fails.
    //
    // A mapping without keys is worse than no mapping: the folder appears in
    // the synced list, so it looks connected, while every document in it
    // refuses to connect and nothing syncs either way. Cancelling the password
    // prompt produced exactly that — a folder that looked mapped and silently
    // did nothing.
    const gotKeys = await this.loadFolderKeys(folder.id, folder.name, folder.membershipId ?? null);
    if (!gotKeys) {
      new Notice(
        `"${folder.name}" was not mapped: its encryption key could not be unlocked. ` +
          'Try again and enter your password, or ask an owner to share the folder with you.',
      );
      return;
    }

    // Now that the keys are here, the sealed name can be read. `folder.name`
    // may still be the "Locked folder (…)" placeholder it was given when the
    // list was rendered without keys, and storing that would put it in the
    // settings UI for good.
    const trueName = await openFolderName(this.plugin.folderCrypto.get(folder.id), folder)
      ?? folder.name;

    // Another folder already covers this path: refuse rather than replace.
    // Mapping the same folder again to the same path is a re-map, and fine.
    const covering = mappingCovering(localPath, this.plugin.settings.folderMappings);
    if (covering && covering.sharedFolderId !== folder.id) {
      new Notice(this.alreadySharedMessage(localPath, covering));
      return;
    }
    this.plugin.settings.folderMappings = this.plugin.settings.folderMappings.filter(
      (m) => m.sharedFolderId !== folder.id,
    );
    this.plugin.settings.folderMappings.push({
      sharedFolderId: folder.id,
      sharedFolderName: trueName,
      localPath,
      // Recorded at map time and refreshed on every folder list, so a demotion
      // reaches the editor without needing a re-map.
      role: folder.role,
      ...(folder.membershipId ? { membershipId: folder.membershipId } : {}),
    });
    await this.plugin.saveSettings();
    this.plugin.refreshSync();

    new Notice(`Mapped "${trueName}" to ${localPath}`);
    await this.loadSharedFolders(container, this.folderServerFor(folder));
  }

  /** The server a listed folder came from: its organisation's, or the only one. */
  private folderServerFor(folder: { membershipId?: string | null }): FolderServer {
    return folder.membershipId ? this.plugin.serverForMembership(folder.membershipId) : this.plugin.servers()[0];
  }

  private displayEncryption(containerEl: HTMLElement): void {
    const publicKey = this.plugin.settings.keyMaterial?.publicKey;
    if (!publicKey) return;

    containerEl.createEl('h3', { text: 'Encryption' });
    const setting = new Setting(containerEl)
      .setName('Your key fingerprint')
      .setDesc('Loading…');
    void publicKeyFingerprint(publicKey).then((fingerprint) => {
      setting.setDesc(
        `${fingerprint} — collaborators see this next to your name. Comparing it with them ` +
          'through some other channel is what rules out a server that swapped your key for ' +
          'its own; without that check, the guarantee only covers an operator who reads and ' +
          'does not interfere.',
      );
    });

    // Locked, said once at the top rather than left to be inferred from folders
    // that will not open. The per-folder Unlock buttons and "Show names" still
    // work; what they cannot do is explain the state or offer a way out of it
    // when the passphrase is gone for good.
    //
    // The prompt is raised from this click and never from the draw: a render
    // that asks for a passphrase is the bug folder-names.test.ts guards.
    if (this.plugin.isLocked()) {
      new Setting(containerEl)
        .setName('Your folders are locked')
        .setDesc(
          'Your passphrase has not been entered on this device yet, so the names and contents ' +
            'of folders shared with you cannot be read. Enter it to unlock them, or recover ' +
            'with your recovery key if it is gone for good.',
        )
        .addButton((btn) =>
          btn.setButtonText('Enter passphrase').setCta().onClick(async () => {
            const identity = this.plugin.settings.identity;
            await this.ensureIdentity(
              identity ? `Unlock the folders shared with ${identity.email}.` : 'Unlock your shared folders.',
            );
            this.display();
          }),
        )
        .addButton((btn) =>
          // The way out for somebody who has genuinely lost it. It used to be
          // reachable only by signing out first, which is what made failing the
          // sign-in look survivable.
          btn.setButtonText('Forgot passphrase?').onClick(() => {
            const email = this.plugin.settings.identity?.email;
            if (!email) return;
            new RecoveryModal(this.app, (result) => {
              if (result) void this.doCloudRecover(email, result.recoveryKey, result.password);
            }).open();
          }),
        );
      return;
    }
    // Stated because nothing else will state it. The OS offers no way to see
    // that this plugin is holding a key, so if it is not said here it is not
    // said anywhere. No toggle: signing out is how you remove it.
    const held = this.plugin.deviceSecrets?.kind !== 'none';
    new Setting(containerEl)
      .setName('Your passphrase')
      .setDesc(
        held
          ? 'Asked for once on this device. Your key is kept in the operating system\u2019s ' +
            'credential store — not in your vault, so syncing the vault does not carry it — ' +
            'and it opens every folder shared with your account, not just this vault\u2019s. ' +
            'Signing out removes it.'
          : 'Asked for whenever a folder shared with you since the last unlock is opened. ' +
            'This device has no credential store the plugin can use, so the key is not kept ' +
            'between sessions rather than being written somewhere unprotected.',
      );
  }

  private displayTroubleshooting(containerEl: HTMLElement): void {
    containerEl.createEl('h3', { text: 'Troubleshooting' });

    new Setting(containerEl)
      .setName('Diagnostic log')
      .setDesc(
        'Write a detailed log to the plugin folder, for reporting a sync problem. ' +
          'It records which files sync and which fail, including their paths, so keep it off ' +
          'unless you are chasing something. Capped at 5 MB and never sent anywhere on its own.',
      )
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.diagnosticLog).onChange(async (value) => {
          this.plugin.settings.diagnosticLog = value;
          await this.plugin.saveSettings();
          this.plugin.applyDiagnosticLogSetting();
          new Notice(value ? 'Diagnostic log enabled' : 'Diagnostic log disabled');
        }),
      );

    // Only where there is somewhere to send them. Against a self-hosted
    // server the identity service names no endpoint, so a toggle would
    // promise a choice that changes nothing.
    if (this.plugin.settings.errorReportDsn) {
      new Setting(containerEl)
        .setName('Send crash reports')
        .setDesc(
          'When the plugin hits a bug, send us the error and where in our code it happened. ' +
            'Never your notes, their names, your file paths, your vault name or your keys. ' +
            'Kept for 90 days on infrastructure we run ourselves.',
        )
        .addToggle((toggle) =>
          toggle.setValue(this.plugin.settings.errorReports).onChange(async (value) => {
            this.plugin.settings.errorReports = value;
            // Turning it off or on here is itself an answer, so the notice
            // never appears afterwards asking the same question again.
            this.plugin.settings.errorReportsAcknowledgedAt ??= Math.floor(Date.now() / 1000);
            await this.plugin.saveSettings();
            new Notice(value ? 'Crash reports on' : 'Crash reports off');
          }),
        )
        .addExtraButton((btn) =>
          btn
            .setIcon('bug')
            .setTooltip('Send a test report')
            .onClick(() => void this.plugin.sendTestErrorReport()),
        );
    } else if (this.plugin.settings.mode === 'self-hosted') {
      new Setting(containerEl)
        .setName('Crash reports')
        .setDesc('Off, and there is nowhere to send them: your own server names no error tracker.');
    }
  }

  private displayAdminPanel(containerEl: HTMLElement): void {
    containerEl.createEl('h3', { text: 'Admin' });

    new Setting(containerEl)
      .setName('Invite tokens')
      .setDesc('Generate a token to invite a new user')
      .addButton((btn) =>
        btn.setButtonText('Generate Invite').setCta().onClick(async () => {
          await this.generateInvite();
        })
      );

    const adminContent = containerEl.createDiv('nectenda-surface nectenda-admin-content');
    this.loadAdminData(adminContent);
  }

  private async loadAdminData(container: HTMLElement): Promise<void> {
    container.empty();

    try {
      const base = apiBaseUrl(this.plugin.settings.serverUrl);
      const headers = {
        'Authorization': `Bearer ${this.plugin.settings.token}`,
        'Content-Type': 'application/json',
      };

      const [invitesRes, usersRes] = await Promise.all([
        this.apiFetch(`${base}/admin/invites`, { headers }),
        this.apiFetch(`${base}/admin/users`, { headers }),
      ]);

      if (invitesRes.ok) {
        const { invites } = await invitesRes.json() as { invites: InviteTokenInfo[] };
        const unused = invites.filter((i) => !i.usedBy);
        if (unused.length > 0) {
          container.createEl('h4', { text: 'Active Invite Tokens' });
          const tokenGroup = rowGroup(container);
          for (const invite of unused) {
            new Setting(tokenGroup)
              .setName(invite.token)
              .setDesc(`Created ${new Date(invite.createdAt * 1000).toLocaleDateString()}`)
              .addButton((btn) =>
                btn.setButtonText('Copy').onClick(() => {
                  navigator.clipboard.writeText(invite.token);
                  new Notice('Invite token copied to clipboard');
                })
              );
          }
        }
      }

      if (usersRes.ok) {
        const { users } = await usersRes.json() as { users: UserInfo[] };
        container.createEl('h4', { text: 'Users' });
        const userGroup = rowGroup(container);
        for (const user of users) {
          const setting = new Setting(userGroup)
            .setName(`${user.username} (${user.role})`)
            .setDesc(user.email);

          if (user.role !== 'admin') {
            setting.addButton((btn) =>
              btn.setButtonText('Remove').setWarning().onClick(async () => {
                await this.removeUser(user.id, container);
              })
            );
          }
        }
      }
    } catch {
      noteRow(container, 'Failed to load admin data', 'mod-warning');
    }
  }

  private async doLogin(username: string, password: string): Promise<void> {
    if (!username || !password) {
      new Notice('Username and password required');
      return;
    }

    // Key derivation is deliberately slow (0.3-3s), so say so rather than
    // appearing to hang.
    const notice = new Notice('Deriving encryption keys...', 0);
    try {
      await this.applySession(
        await session.login(
          this.plugin.settings.serverUrl,
          username,
          password,
          this.plugin.deviceFields(),
        ),
      );
      notice.hide();
    } catch (err) {
      notice.hide();
      new Notice(`Login failed: ${err instanceof Error ? err.message : 'Could not connect'}`);
    }
  }

  /** Persist a new session and start syncing. */
  private async applySession(result: SessionResult): Promise<void> {
    this.plugin.settings.token = result.token;
    this.plugin.settings.username = result.user.username;
    this.plugin.settings.userRole = result.user.role;
    this.plugin.settings.keyMaterial = result.keyMaterial;
    await this.plugin.saveSettings();

    this.plugin.sessionKeys = result.keys;
    await this.plugin.rememberIdentity(result.keys.identity);
    this.plugin.startSync();

    if (result.recoveryKey) {
      new RecoveryKeyModal(this.app, result.recoveryKey).open();
    } else {
      new Notice(`Logged in as ${result.user.username}`);
    }
    this.display();
  }

  private async doRegister(
    username: string,
    email: string,
    password: string,
    inviteToken: string,
  ): Promise<void> {
    if (!username || !email || !password || !inviteToken) {
      new Notice('All fields required for registration');
      return;
    }

    // The server never sees the password, so it cannot enforce a length —
    // this check is the only one there is.
    if (password.length < MIN_PASSWORD_LENGTH) {
      new Notice(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
      return;
    }

    const notice = new Notice('Generating encryption keys...', 0);
    try {
      await this.applySession(
        await session.register(
          this.plugin.settings.serverUrl,
          username,
          email,
          password,
          inviteToken,
          this.plugin.deviceFields(),
        ),
      );
      notice.hide();
    } catch (err) {
      notice.hide();
      new Notice(`Registration failed: ${err instanceof Error ? err.message : 'Could not connect'}`);
    }
  }

  /**
   * Recover with the recovery key and set a new password.
   *
   * Slower than a login and says so: it derives a key from the recovery key,
   * unwraps the master key, then derives a second key from the new password.
   */
  private async doRecover(
    username: string,
    recoveryKey: string,
    newPassword: string,
  ): Promise<void> {
    const notice = new Notice('Recovering your account...', 0);
    try {
      await this.applySession(
        await session.recoverAndReset(
          this.plugin.settings.serverUrl,
          username,
          recoveryKey,
          newPassword,
          this.plugin.deviceFields(),
        ),
      );
      notice.hide();
      new Notice('Password changed. Save the new recovery key — the old one no longer works.');
    } catch (err) {
      notice.hide();
      new Notice(`Recovery failed: ${err instanceof Error ? err.message : 'Could not connect'}`);
    }
  }

  private async doLogout(): Promise<void> {
    this.plugin.stopSync();
    this.plugin.settings.token = '';
    this.plugin.settings.username = '';
    this.plugin.settings.userRole = 'editor';
    this.plugin.settings.folderMappings = [];
    this.plugin.settings.masterKey = '';
    // Before keyMaterial goes: the id is derived from its public key.
    await this.plugin.forgetIdentity();
    // Account-scoped, like the key material below. Self-hosted never publishes
    // one, but the same vault can be signed into a hosted account afterwards.
    this.plugin.forgetVaultLabel();
    this.plugin.settings.keyMaterial = null;
    // Drop the in-memory registry before clearing the cache, or there is
    // nothing left to iterate and the keys stay live for the session.
    for (const folderId of Object.keys(this.plugin.settings.folderKeys ?? {})) {
      this.plugin.folderCrypto.remove(folderId);
    }
    this.plugin.settings.folderKeys = {};
    this.plugin.settings.errorReportDsn = '';
    this.plugin.sessionKeys = null;
    await this.plugin.saveSettings();
    this.plugin.refreshSettingsPane();

    new Notice('Logged out');
    this.display();
  }

  private async generateInvite(): Promise<void> {
    try {
      const base = apiBaseUrl(this.plugin.settings.serverUrl);
      const res = await this.apiFetch(`${base}/admin/invites`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.plugin.settings.token}`,
          'Content-Type': 'application/json',
        },
      });

      if (!res.ok) {
        const err = await res.json() as { error: string };
        new Notice(`Failed: ${err.error}`);
        return;
      }

      const data = await res.json() as { token: string };
      await navigator.clipboard.writeText(data.token);
      new Notice('Invite token generated and copied to clipboard');
      this.display();
    } catch {
      new Notice('Failed to generate invite token');
    }
  }

  private async removeUser(userId: string, container: HTMLElement): Promise<void> {
    try {
      const base = apiBaseUrl(this.plugin.settings.serverUrl);
      const res = await this.apiFetch(`${base}/admin/users/${userId}`, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${this.plugin.settings.token}`,
        },
      });

      if (!res.ok) {
        const err = await res.json() as { error: string };
        new Notice(`Failed: ${err.error}`);
        return;
      }

      new Notice('User removed');
      await this.loadAdminData(container);
    } catch {
      new Notice('Failed to remove user');
    }
  }
}

/**
 * Asked before opening an attachment larger than this device has handled.
 *
 * The wording matters more than the buttons. A user who is told "this might not
 * work" and then watches the app vanish has been dealt with honestly; one who is
 * told nothing concludes the app is broken. And the cost of saying no is stated,
 * because "skip" sounds permanent and is not.
 */
/**
 * "This cannot be undone" is the whole of it, so the modal says what goes and
 * what stays before it says it.
 */
class UnshareFolderModal extends Modal {
  private answered = false;

  constructor(app: App, private readonly folderName: string, private readonly others: number | null, private readonly decide: (proceed: boolean) => void) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl('h3', { text: `Unshare "${this.folderName}"?` });
    contentEl.createEl('p', {
      text: 'This removes the folder from the server: its copy of every note, the edit history, and every attachment — for everyone.',
    });
    if (this.others !== null && this.others > 0) {
      contentEl.createEl('p', {
        text: `${this.others} other ${this.others === 1 ? 'person' : 'people'} will stop receiving changes.`,
      });
    }
    contentEl.createEl('p', {
      text: 'Nothing on disk changes. The notes in this vault stay where they are, and everyone keeps theirs as ordinary files. '
        + 'This cannot be undone: sharing the folder again makes a new one, with a new history.',
      cls: 'setting-item-description',
    });

    new Setting(contentEl)
      .addButton((b) => b.setButtonText('Keep sharing').onClick(() => this.answer(false)))
      .addButton((b) => b.setButtonText('Unshare').setWarning().onClick(() => this.answer(true)));
  }

  private answer(proceed: boolean): void {
    this.answered = true;
    this.decide(proceed);
    this.close();
  }

  onClose(): void {
    this.contentEl.empty();
    // Dismissing is not consent to something that cannot be undone.
    if (!this.answered) this.decide(false);
  }
}

class LargeAttachmentModal extends Modal {
  private relativePath: string;
  private bytes: number;
  private decide: (proceed: boolean) => void;
  private answered = false;

  constructor(app: App, relativePath: string, bytes: number, decide: (proceed: boolean) => void) {
    super(app);
    this.relativePath = relativePath;
    this.bytes = bytes;
    this.decide = decide;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl('h3', { text: 'Large attachment' });
    contentEl.createEl('p', {
      text: `"${this.relativePath}" is ${formatBytes(this.bytes)}, which is larger than this `
        + 'device has opened before.',
    });
    contentEl.createEl('p', {
      text: 'Opening it may make Obsidian close and reopen on this device. If that happens, '
        + 'nothing is lost — the file stays on the server and this device will skip it next '
        + 'time, with a button to try again.',
      cls: 'setting-item-description',
    });

    new Setting(contentEl)
      .addButton((b) => b.setButtonText('Skip on this device').onClick(() => this.answer(false)))
      .addButton((b) => b.setButtonText('Download anyway').setCta().onClick(() => this.answer(true)));
  }

  private answer(proceed: boolean): void {
    this.answered = true;
    this.decide(proceed);
    this.close();
  }

  onClose(): void {
    this.contentEl.empty();
    // Dismissing without choosing is not consent to attempt something that
    // might kill the app.
    if (!this.answered) this.decide(false);
  }
}

/**
 * Offered when a folder is shared while Obsidian is set to drop attachments
 * somewhere that will not sync.
 *
 * Phrased as what will happen rather than what is misconfigured. The setting is
 * Obsidian's default and perfectly reasonable until the moment a folder is
 * shared, so there is nothing for the user to feel they got wrong.
 */
class AttachmentLocationModal extends Modal {
  private accept: () => void;

  constructor(app: App, accept: () => void) {
    super(app);
    this.accept = accept;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl('h3', { text: 'Where should attachments be saved?' });
    contentEl.createEl('p', {
      text: 'Obsidian currently saves files you drop into a note to the vault root, which '
        + 'is not inside a shared folder. Attachments added to shared notes would not be '
        + 'uploaded, and everyone else would see a broken link.',
    });
    contentEl.createEl('p', {
      text: 'Saving them next to the note keeps them inside the shared folder, so they sync '
        + 'with it. This changes an Obsidian setting and affects every vault folder, not '
        + 'only shared ones.',
      cls: 'setting-item-description',
    });

    new Setting(contentEl)
      .addButton((b) => b.setButtonText('Leave it as it is').onClick(() => this.close()))
      .addButton((b) =>
        b.setButtonText('Save beside the note').setCta().onClick(() => {
          this.accept();
          this.close();
        }),
      );
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/**
 * What is taking up space, and a way to remove it.
 *
 * Lists only folders this vault has mapped, and says why. The owner of a folder
 * pays for it, but the server stores ciphertext under opaque ids and cannot
 * name a single file in it — so a folder the owner has not mapped can be
 * reported as a total and nothing more. That is not a gap to apologise for; it
 * is the guarantee working, and the honest thing is to say so rather than
 * present an empty list.
 */
class ManageStorageModal extends Modal {
  private plugin: NectendaPlugin;
  private onChange: () => void;

  constructor(app: App, plugin: NectendaPlugin, onChange: () => void) {
    super(app);
    this.plugin = plugin;
    this.onChange = onChange;
  }

  onOpen(): void {
    this.render();
  }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h3', { text: 'Manage storage' });

    const mappings = this.plugin.settings.folderMappings;
    if (mappings.length === 0) {
      contentEl.createEl('p', { text: 'No shared folders are mapped in this vault.' });
      return;
    }

    let anything = false;
    for (const mapping of mappings) {
      const items = this.plugin.storedAttachments(mapping.sharedFolderId);
      if (items.length === 0) continue;
      anything = true;

      const total = items.reduce((n, i) => n + i.bytes, 0);
      contentEl.createEl('h4', {
        text: `${mapping.localPath} — ${formatBytes(total)} in ${items.length} file(s)`,
      });

      // Largest first: the only ordering that helps somebody trying to free
      // space in as few decisions as possible.
      for (const item of items) {
        new Setting(contentEl)
          .setName(item.relativePath)
          .setDesc(formatBytes(item.bytes))
          .addButton((b) =>
            b.setButtonText('Delete').setWarning().onClick(async () => {
              const ok = await this.plugin.deleteAttachment(
                mapping.sharedFolderId, item.relativePath,
              );
              if (ok) {
                new Notice(
                  `Nectenda: "${item.relativePath}" moved to the vault trash and removed `
                    + 'from the server.',
                );
                this.onChange();
                this.render();
              }
            }),
          );
      }
    }

    if (!anything) {
      contentEl.createEl('p', { text: 'No attachments are stored in your mapped folders.' });
    }

    contentEl.createEl('p', {
      text: 'Only folders mapped in this vault can be listed. The server stores your '
        + 'attachments encrypted under names it cannot read, so it cannot tell you what is '
        + 'in a folder you have not mapped here — map it to manage it, or delete the whole '
        + 'folder from the folder list.',
      cls: 'setting-item-description',
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
