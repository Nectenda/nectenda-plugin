import type { KdfParams } from './crypto.js';

// Protocol constants
export const DEFAULT_PORT = 1234;
export const WS_PATH = '/';
export const API_PREFIX = '/api';

/**
 * Wire protocol.
 *
 * Phase 7 replaced Yjs state-vector sync with an append-only log: the server
 * cannot read update payloads, so it cannot compute what a client is missing.
 * Clients say how far they have got and the server replies with everything
 * after that. Numbers 0-8 are inherited from the Hocuspocus-compatible
 * protocol Phase 6 used; 9 upward are ours.
 */
export const MessageType = {
  /** S->C presence relay. Ephemeral, never logged. */
  Awareness: 1,
  /** S->C auth result. */
  Auth: 2,
  /** C->S request the current presence map. */
  QueryAwareness: 3,
  /** C->S stop following a document. */
  Close: 7,
  /** S->C caught up; carries the highest sequence the server holds. */
  SyncStatus: 8,
  /** C->S follow a document from a given sequence. */
  Subscribe: 9,
  /** S->C compacted state, sent when the client is behind the snapshot. */
  Snapshot: 10,
  /** S->C batch of updates during catch-up. */
  Updates: 11,
  /** C->S submit one update; the server assigns its sequence. */
  Push: 12,
  /** S->C fan-out of another client's update. */
  Update: 13,
  /** C->S replace the log up to a sequence with a compacted snapshot. */
  PutSnapshot: 14,
  /**
   * S->C the sequence assigned to your push.
   *
   * Safe to advance `lastSeq` on: the server assigns sequences and writes each
   * socket in order, so any lower-numbered update from a peer was already
   * queued to this socket before the ack. An author would otherwise never learn
   * its own sequences, leaving a sole editor stuck at zero and unable to
   * compact.
   */
  Ack: 15,
  /**
   * C->S discard a document entirely.
   *
   * Sent by the client that performed a deletion, once the file is gone from
   * the folder listing. Without it a deleted file's updates and snapshot stay
   * on the server for ever: nothing else ever removes them, and no client will
   * ask for them again. Under encryption those become ciphertext nobody holds a
   * key path to, accumulating without bound.
   */
  DeleteDoc: 16,
  /**
   * S->C please send a snapshot for this document.
   *
   * The server cannot merge Yjs updates, so it cannot compact anything itself —
   * but it is the only party that knows how long a log actually is. It asks a
   * client that has just caught up, and therefore holds full state, to send the
   * `PutSnapshot` it could always have sent unprompted.
   *
   * This grants the client no new authority: the monotonic watermark in
   * `putSnapshot` still refuses to move backwards. It replaces an election the
   * clients could not run correctly — with nobody online, nothing compacted at
   * all, and no amount of client-side cleverness fixes that.
   */
  CompactRequest: 17,
  /**
   * S->C this folder was deleted on the server; stop syncing it.
   *
   * The name field carries the **bare folder id**, never a document name, and
   * there is no payload. That is deliberate: a plugin that predates this type
   * looks the name up among its subscriptions, finds none — a folder id has no
   * `/` and can never be a document name — and returns before its switch, so
   * an older client can only ignore the frame, never mis-parse it.
   *
   * Local files are untouched by it. The member keeps every note and every
   * key; what ends is the syncing.
   */
  FolderGone: 18,
} as const;

export type MessageTypeValue = (typeof MessageType)[keyof typeof MessageType];

/** Cap on updates per catch-up frame, to avoid one enormous WebSocket message. */
export const MAX_UPDATES_PER_BATCH = 200;

/**
 * Compact once a document's log passes this many updates. Without compaction a
 * new client replays every keystroke ever typed in the document.
 */
export const COMPACT_AFTER_UPDATES = 500;

/**
 * How often the server will ask any one document to be compacted.
 *
 * Every subscriber to a long log would otherwise be asked at once, and each
 * would encrypt and upload a whole document to satisfy a request the first
 * answer already handled.
 */
export const COMPACT_REQUEST_INTERVAL_MS = 60_000;

/**
 * Caps on what one client may put into the log in a single message.
 *
 * There was no limit at all: `ws` defaults to a 100MiB frame, so any
 * authenticated member could push a 99MiB payload into `doc_updates` and have
 * the server fan it out to every subscriber. Storage accounting over an
 * unbounded input is not accounting, and the fan-out makes it a denial of
 * service against everyone else in the folder.
 *
 * A Yjs update for a text edit is tens of bytes; 4MiB is a very large paste and
 * still four orders of magnitude of headroom. A snapshot is a whole document,
 * so it gets more.
 */
export const MAX_PUSH_BYTES = 4 * 1024 * 1024;
export const MAX_SNAPSHOT_BYTES = 16 * 1024 * 1024;

/**
 * Hard frame limit for the socket itself, below `ws`'s 100MiB default.
 *
 * Above the largest legitimate message plus protocol overhead, so it never
 * rejects something the handlers would have accepted — the handlers give a
 * reason, and a frame killed at the transport does not.
 */
export const MAX_WS_FRAME_BYTES = MAX_SNAPSHOT_BYTES + 1024 * 1024;

/**
 * Limits on a folder's display name.
 *
 * Enforced by the client, because it is the only party that can see the name —
 * the server receives it sealed and cannot check a length or a path separator
 * against ciphertext. The server bounds the sealed form instead.
 */
export const MAX_FOLDER_NAME_LENGTH = 100;

// Yjs document naming
export const META_DOC_SUFFIX = '__meta__';
export const metaDocName = (roomId: string): string => `${roomId}/${META_DOC_SUFFIX}`;
export const fileDocName = (roomId: string, relativePath: string): string =>
  `${roomId}/${relativePath}`;

// URL helpers
export const apiBaseUrl = (wsUrl: string): string =>
  wsUrl.replace(/^ws(s?):\/\//, 'http$1://').replace(/\/$/, '') + API_PREFIX;

// Roles (room-level, for Phase 3+)
export const ROLES = ['owner', 'editor', 'viewer'] as const;
export type Role = (typeof ROLES)[number];

// User roles (server-level)
export type UserRole = 'admin' | 'editor';

// JWT
export const JWT_EXPIRY = '7d';

// Room member info (replicated in Yjs awareness/meta doc)
export interface MemberInfo {
  userId: string;
  displayName: string;
  role: Role;
  color: string;
}

// File operation types (appended to meta doc Y.Array)
export type FileOpType = 'create' | 'rename' | 'delete';

export interface FileOp {
  type: FileOpType;
  path: string;
  newPath?: string; // only for rename
  timestamp: number;
  userId: string;
}

// File listing entry (stored in meta doc Y.Map)
export interface FileEntry {
  size: number;
  mtime: number;
  /**
   * Absent means text, which is retroactively true: only `.md` has ever been
   * listed. That is the whole migration for existing listings — no rewrite, no
   * backfill, no dual read.
   */
  kind?: 'text';
}

/**
 * An attachment in the folder listing.
 *
 * Lives under a **second root key** in the meta document, `Y.Map('blobs')`,
 * never in `Y.Map('files')`. That is not tidiness, it is the compatibility
 * mechanism between **plugin versions** — a member of a shared folder who has
 * not updated Nectenda, on whatever version of Obsidian. An older client calls
 * `getMap('files')` and never calls
 * `getMap('blobs')`, so it replicates these entries faithfully and cannot act
 * on them. A discriminator field would not do — the client that must be
 * protected is precisely the one that does not check.
 *
 * What it would do otherwise is worse than ignoring them. `applyAdditions`
 * hands an existing local file to ContentSync, whose `seedIfEmpty` reads it as
 * UTF-8 — a lossy decode of PNG bytes — and inserts the result into the shared
 * `Y.Text`, poisoning the document for every member.
 */
export interface BlobEntry {
  /**
   * 32 hex characters, random, and deliberately **not** content-addressed.
   *
   * Deriving the id from the plaintext would hand anyone who can guess a file a
   * confirmation-of-file attack against a server that otherwise learns nothing.
   * Per-folder keys make cross-folder dedup impossible in any case, and shared
   * ids would need refcounting the server cannot do over references it cannot
   * read. One entry, one blobId, always — duplicate files cost duplicate bytes.
   */
  blobId: string;
  /** Plaintext bytes. */
  size: number;
  mtime: number;
  /** Which folder content-key generation wrapped `wrappedKey`. */
  keyId: string;
  /** base64: the blob's own key, sealed under the folder content key. */
  wrappedKey: string;
  /** base64 SHA-256 of the plaintext. Drives change detection and verification. */
  hash: string;
  codec: 'none' | 'gzip';
  /** Plaintext bytes per chunk, as sealed. */
  chunkSize: number;
  uploadedBy: string;
}

/** Root key for the attachment listing, and the version marker beside it. */
export const BLOBS_MAP_KEY = 'blobs';
export const LISTING_MAP_KEY = 'listing';
export const LISTING_VERSION = 2;

// Auth payloads
export interface JwtPayload {
  userId: string;
  username: string;
  role: UserRole;
  /**
   * The account the user belonged to when the token was minted.
   *
   * Carried so every request and every socket can resolve limits without a
   * second lookup. It is a cache, not authority: a token outlives a change of
   * account, so anything that *enforces* on the account re-reads it.
   */
  accountId?: string;
  /**
   * Which install of the plugin this is. Absent for tokens minted before
   * devices existed, and for any client that does not send one — such a client
   * is counted as a single unnamed device rather than refused.
   */
  deviceId?: string;
  /**
   * The identity session this shard session was minted from. Absent on a
   * self-hosted server, which has no identity service. A hosted server refuses
   * a token for an identity-derived user that lacks it: such a token was
   * minted before sessions could be ended from another device, and the only
   * way to bring it under that rule is to have it re-minted.
   */
  sid?: string;
  exp?: number;
}

/**
 * The server never receives a password. The client derives a master key from
 * it locally and sends `authHash`, a second independent derivation that reveals
 * nothing about the encryption key. See docs/security-model.md.
 */
/**
 * Device fields are optional throughout. A client that sends none is counted
 * as one unnamed device rather than refused — an older plugin must keep
 * working, and the failure mode of guessing wrong here is locking someone out
 * of their own notes.
 */
export interface DeviceIdentity {
  deviceId?: string;
  deviceLabel?: string;
  devicePlatform?: string;
}

export interface LoginRequest extends DeviceIdentity {
  username: string;
  authHash: string;
}

export interface RegisterRequest extends DeviceIdentity {
  username: string;
  email: string;
  /** Exactly one of `inviteToken` and `shareKey`. */
  inviteToken?: string;
  /** An account's rotatable join key; joins as a member. */
  shareKey?: string;
  /** Shown above cursors and in rosters. Free text; defaults to the username. */
  displayName?: string;
  authHash: string;
  /** How to derive the master key. The client picks these; the server stores them verbatim. */
  kdfParams: KdfParams;
  /** base64 SPKI — public, readable by anyone. */
  publicKey: string;
  /** base64 AES-GCM blob, opaque to the server. */
  wrappedPrivateKey: string;
  /** Master key wrapped under the recovery key, so a forgotten password is survivable. */
  recoveryBlob: string;
  recoveryParams: KdfParams;
  /** Proof-of-possession for the recovery key — see `EnrollKeysRequest`. */
  recoveryAuthHash: string;
}

/**
 * A user's key material as the server holds it. Every field is null until the
 * user enrols keys from a client — the seeded admin starts in that state,
 * because generating an identity keypair server-side would defeat the point.
 */
export interface KeyMaterial {
  publicKey: string | null;
  wrappedPrivateKey: string | null;
  recoveryBlob: string | null;
  recoveryParams: KdfParams | null;
}

export interface EnrollKeysRequest {
  publicKey: string;
  wrappedPrivateKey: string;
  recoveryBlob: string;
  recoveryParams: KdfParams;
  /**
   * Proof-of-possession for the recovery key, in the same shape as `authHash`
   * is for the password: `deriveAuthHash(deriveMasterKey(recoveryKey,
   * recoveryParams), recoveryKey)`, bcrypt'd by the server before storage.
   *
   * It derives from the recovery key **alone**, never from the master key it
   * unwraps, so the server can verify a caller before disclosing anything.
   * Deriving it from the unwrapped master key would force the blob to be handed
   * out first, and an encrypted key blob served to anyone who asks is an offline
   * attack corpus.
   */
  recoveryAuthHash: string;
}

/** Everything needed to replace a user's password-derived credentials. */
export interface ReplaceCredentialsRequest {
  kdfParams: KdfParams;
  authHash: string;
  /** The same identity keypair, re-wrapped under the new master key. */
  wrappedPrivateKey: string;
  recoveryBlob: string;
  recoveryParams: KdfParams;
  recoveryAuthHash: string;
}

/** Body of `POST /api/auth/recover`. */
export interface RecoverRequest {
  username: string;
  recoveryAuthHash: string;
}

export interface AuthResponse {
  token: string;
  user: UserInfo;
  keyMaterial: KeyMaterial;
}

/**
 * Returned before login so the client knows how to derive its master key.
 *
 * Unknown usernames get deterministic decoy parameters rather than an error,
 * so this endpoint cannot be used to enumerate accounts.
 */
export interface KdfParamsResponse {
  kdfParams: KdfParams;
}

// Admin API types
export interface UserInfo {
  id: string;
  username: string;
  /** Free text, not unique; what collaborators see above a cursor. */
  displayName: string;
  email: string;
  /** Authority over the server. */
  role: UserRole;
  /** Authority within the account. Separate from `role` on purpose. */
  accountRole?: AccountRole;
  accountId?: string;
  createdAt: number;
  /**
   * Whether a folder key can be wrapped for them yet: true once they have
   * enrolled encryption keys. Presence only; the key is not carried here.
   */
  hasKeys?: boolean;
}

export type AccountRole = 'owner' | 'admin' | 'member';

/**
 * `active` is the only state that accepts writes. `suspended` is the
 * operator's lever and is reversible; `migrating` and `moved` are the two
 * halves of an account being carried to another server, during which writes
 * are refused so nothing can land where it will not be read again.
 */
export type AccountStatus = 'active' | 'suspended' | 'migrating' | 'moved';

export interface AccountInfo {
  id: string;
  name: string;
  planId: string;
  status: AccountStatus;
  createdAt: number;
  /** Operator-set text shown to the account's members. */
  notice: string | null;
  shareKeyEnabled: boolean;
}

/**
 * The limits in force for an account. `0` means unlimited, everywhere.
 */
export interface AccountLimits {
  /** Flat plus per-seat storage, already summed. */
  quotaBytes: number;
  quotaPerUserBytes: number;
  maxUsers: number;
  maxDevicesPerUser: number;
  maxBlobBytes: number;
  /** False on plans that sell no attachment storage. Text sync is never affected. */
  attachmentsEnabled: boolean;
  planId: string;
  status: AccountStatus;
}

/**
 * A device on an organisation's roster: a machine that holds one of the
 * member's device slots, from the moment it was added until it is removed.
 * The vaults it syncs from are listed under it and cost nothing.
 */
export interface DeviceInfo {
  deviceId: string;
  label: string | null;
  platform: string | null;
  enrolledAt: number;
  lastSeen: number;
  /**
   * The vaults syncing from this machine. `label` is generic — the platform and
   * four characters of the install id — and `sealedLabel` is the vault's real
   * name wrapped to the account's identity key, which only that account's
   * vaults can open. Null when the install has not published one.
   */
  installs: Array<{ installId: string; label: string | null; sealedLabel?: string | null; lastSeen: number }>;
  /** Whether this device holds a live connection right now. */
  connected?: boolean;
  /** Whether this is the device asking. */
  thisDevice?: boolean;
}

/** How many of a member's device slots in an organisation are taken; 0 for `max` is unlimited. */
export interface DeviceSlots {
  used: number;
  max: number;
  /** Whether the device asking is on the roster — false is why it is not syncing here. */
  thisDeviceEnrolled: boolean;
}

export interface InviteTokenInfo {
  token: string;
  createdBy: string;
  createdAt: number;
  usedBy: string | null;
  usedAt: number | null;
  /** null means redeeming it creates a new account. */
  accountId?: string | null;
  /** Unix seconds. null on tokens minted before invites expired at all. */
  expiresAt?: number | null;
  /** The role the redeemer takes in the account. `owner` is how a pre-created paid account gets one. */
  accountRole?: AccountRole;
  /** The address it was sent to, if any. Informational on a self-hosted server. */
  email?: string | null;
}

/** Something the account view should tell the user, computed server-side. */
export interface AccountMessage {
  kind: 'suspended' | 'migrating' | 'over-quota' | 'attachments-not-included' | 'notice' | 'device-not-enrolled';
  text: string;
}

/**
 * Close code for a connection refused because the user already has as many
 * devices connected as their plan allows.
 *
 * In the 4000-4999 application range. It is distinct from a generic auth
 * failure because the plugin must not present it as one: nothing is wrong with
 * the credentials, and telling someone to re-log in would be useless advice.
 */
export const WS_CLOSE_DEVICE_LIMIT = 4003;

/**
 * The account is suspended. Also in the application range, and for the same
 * reason as 4003: the credentials are fine and the plugin must say what is
 * actually wrong rather than "disconnected". Nothing has been deleted.
 */
export const WS_CLOSE_ACCOUNT_SUSPENDED = 4004;

/**
 * The account is being moved to another server, or has been. Retry with
 * backoff; local edits keep accumulating and nothing is lost. The plugin
 * re-resolves where the account lives when it sees this.
 */
export const WS_CLOSE_ACCOUNT_MOVING = 4006;

/**
 * The session this socket presented is no longer accepted by the server —
 * signed out from another device, or minted before the server required a
 * session id. Do not retry with the same token: ask the identity service
 * whether this device is still signed in, and reconnect with what it answers.
 * Distinct from 1000 because a plain close is exactly what a client should
 * retry, and from a handshake 401 because that reads as a dead server.
 */
export const WS_CLOSE_SIGNED_OUT = 4005;

/**
 * This plugin is older than the server is willing to talk to.
 *
 * Refused after the upgrade, like 4003 and 4004, because the credentials are
 * fine and there is exactly one useful thing to say: update the plugin. The
 * notes are safe on disk and keep being edited; only syncing stops. Retried
 * slowly rather than not at all, because the person may be updating right now.
 *
 * The floor this compares against is deliberately `0` by default, so a
 * self-hosted server refuses nobody, and is only ever raised to a version
 * that has been available long enough for updates to have reached people.
 */
export const WS_CLOSE_UPDATE_PLUGIN = 4007;

/**
 * Order two plugin versions, `-1`, `0` or `1`, as a person reads them:
 * 1.10.0 is newer than 1.9.14.
 *
 * Numeric per dotted part, so a string comparison cannot decide that "1.9" is
 * newer than "1.10". Missing parts are zero, so "1.2" and "1.2.0" are equal.
 * Anything unparseable in a part counts as 0, which makes a pre-release
 * suffix ("1.2.0-beta.1") compare equal to its release rather than throwing;
 * the version floor is a blunt instrument and does not need to be cleverer.
 *
 * An absent version is "0", which is what every plugin built before the
 * version was sent reports, and is below any floor above zero.
 */
export function comparePluginVersions(a: string, b: string): -1 | 0 | 1 {
  const parts = (v: string): number[] =>
    // Cut a pre-release or build suffix off first. Splitting on '.' alone
    // turns "1.2.0-beta.1" into four parts and makes it compare *newer* than
    // "1.2.0", which is backwards.
    String(v ?? '').split(/[-+]/)[0].split('.').map((p) => {
      const n = parseInt(p, 10);
      return Number.isFinite(n) ? n : 0;
    });
  const left = parts(a);
  const right = parts(b);
  const len = Math.max(left.length, right.length);
  for (let i = 0; i < len; i++) {
    const l = left[i] ?? 0;
    const r = right[i] ?? 0;
    if (l < r) return -1;
    if (l > r) return 1;
  }
  return 0;
}

// Shared folder types
export interface SharedFolderInfo {
  id: string;
  /**
   * The folder's display name, **sealed**.
   *
   * A folder called "Redundancy consultation" told the server as much as the
   * notes inside it would have. It is sealed under the folder's content key
   * like anything else, so the server stores a name it cannot read.
   */
  name: string;
  /** Which content-key generation sealed `name`. */
  nameKeyId: string;
  createdBy: string;
  createdByUsername?: string;
  /** The creator as a person would name them: display name, else username. */
  createdByDisplayName?: string;
  createdAt: number;
  /**
   * How many people are in the folder, and when anything was last written to
   * it — the two facts that tell two identically named folders apart and say
   * which of them is dead.
   *
   * Optional because an older server sends neither, in which case the client
   * leaves those parts of the row out rather than claiming a folder is empty.
   * `lastActivityAt` is null when nothing has ever been written.
   */
  members?: number;
  lastActivityAt?: number | null;
}

export interface CreateFolderRequest {
  /** Sealed. Length and path rules apply to the plaintext, client-side. */
  name: string;
  nameKeyId: string;
}

// Phase 7 end-to-end encryption primitives (not yet wired into the sync path)
export * from './crypto.js';
export * from './blob-cipher.js';
export * from './deflate.js';

/**
 * SHA-256, lowercase hex, of a credential the directory must be able to look
 * up without holding: share keys and invite tokens are hashed on the shard
 * before they leave it and hashed by the plugin before it asks, so the
 * directory's database is worth nothing to anyone who reads it.
 */
export async function hashCredential(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** What a shard tells the identity service about itself, every minute. */
export interface DirectoryManifest {
  version: 1;
  shardId: string;
  region: string | null;
  generatedAt: number;
  /** Accounts on this shard that are not `moved`. */
  accounts: Array<{ id: string; name: string; status: AccountStatus; planId: string }>;
  /** One per user row on this shard. `identityId` is null for self-hosted-style users. */
  memberships: Array<{
    userId: string;
    identityId: string | null;
    accountId: string;
    role: AccountRole;
    username: string;
    email: string;
    displayName: string;
  }>;
  /** sha256 hex of each enabled share key. */
  shareKeys: Array<{ hash: string; accountId: string }>;
  /** sha256 hex of each unredeemed, unexpired invite. */
  invites: Array<{ hash: string; accountId: string | null; role: AccountRole; email: string | null }>;
  capacity: { accounts: number; users: number; connections: number; sqliteBytes: number; diskFreeBytes: number | null };
}
export { scrubString, scrubSecrets } from './scrub.js';
