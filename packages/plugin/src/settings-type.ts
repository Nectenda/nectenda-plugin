import type { StoredIdentity, StoredMembership } from './cloud-session';
import type { FolderMapping } from './folder-mapping';
import type { PendingInvite } from './auth-flow';
import type { StoredFolderKeys } from './folder-crypto';
import type { KeyMaterial, KdfParams, UserRole } from '@nectenda/shared';
import type { KnownKeys } from './known-keys';
import type { PendingRelease } from './start-over';

/**
 * What the plugin persists, and what it starts with.
 *
 * Lifted out of `main.ts` unchanged. It sat between the pure helpers and the
 * modals in a 7,252-line file, so the one thing every other module needs to
 * agree about was the hardest thing in the package to find.
 *
 * Read `saveSettings` in main.ts before adding a field. Secrets are blanked on
 * write wherever a credential store exists, and re-read on load, so a field
 * holding one has to be listed in both places or it silently lands in
 * `data.json` — a file that vault sync carries off the device.
 */

export const DEFAULT_IDENTITY_URL = 'https://accounts.nectenda.com';

export interface NectendaSettings {
  /**
   * Which kind of server this vault talks to.
   *
   * `self-hosted` is a server you run: one URL, a username and a password, and
   * both authentication and encryption derive from that password. `cloud` is
   * Nectenda Cloud: identity is proved at the identity service (an emailed
   * code, a passkey or a provider), organisations may live on several sync
   * servers, and the passphrase is used for encryption only and never sent.
   *
   * **The default is `cloud`, and that is a decision rather than an accident.**
   * It was `self-hosted` until 18 September 2026 — not chosen, just left alone
   * when cloud was added beside it, back when self-hosted was the only thing
   * there was. The consequence only became visible once the plugin shipped: a
   * fresh install opened on a form asking for the address of a server the
   * reader does not have and cannot currently buy. Whichever this is, it
   * decides which sign-in screen a vault with no settings sees, so treat it as
   * the first thing a new user is told about the product.
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
  /** Invitations addressed to this identity's email, shown in settings and the header icon. */
  pendingInvites: PendingInvite[];
  /**
   * A request to start this account over, as the identity service last
   * reported it. Shown on every signed-in device so any of them can cancel it
   * (start-over.ts); cleared at sign-out with the rest of the account.
   */
  pendingRelease: PendingRelease | null;
  /** Which request the notice was last raised for, so it is raised once per request. */
  announcedReleaseAt?: number;
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
   * The field remains only so an existing value can be cleared.
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
   * Notes already warned about for being too large to sync (SAFE-A12), keyed
   * `<folderId> <path>`. Kept so the warning is given once rather than on every
   * launch, and forgotten when the note is next seen under the limit.
   */
  oversizedNotes: string[];
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
   * Let collaborators see where this person's mouse is in a shared note.
   *
   * A privacy setting, and on by default because pointing at something is most
   * of what a shared note is for on a call. The position travels sealed, like
   * the caret, so the server cannot read it; what the switch withholds is the
   * position from the other people in the note.
   */
  sharePointer: boolean;
  /**
   * Draw collaborators' mouse pointers in this vault.
   *
   * Independent of `sharePointer`: hiding everyone else's pointers is about
   * noise on this screen, and says nothing about whether yours is sent.
   */
  showPointers: boolean;
  /**
   * Live sync for drawings of the Excalidraw plugin (NEC-41): an open drawing
   * bound to its document, so changes show in the other vault as they are
   * made, with collaborators' pointers and selections drawn on it.
   *
   * Off, a drawing is merged when it is saved, by the same element merge, with
   * every safeguard (SAFE-A27, SAFE-A19, SAFE-A26): only the binding and the
   * drawing of collaborators stop. It is the way back if the binding misbehaves
   * with an Excalidraw release it was not read against.
   */
  liveExcalidraw: boolean;
  /**
   * Live sync for boards of the Kanban plugin (NEC-25, NEC-200): a board saved
   * moments after each change rather than on Obsidian's two-second pace, and
   * collaborators' card and list focus drawn on it.
   *
   * Off, a board merges as text when it is saved, keeps its guards (SAFE-A19,
   * SAFE-A26) and still shows who is on it in the header.
   */
  liveKanban: boolean;
  /**
   * Mark each note in a shared folder with its sync status in the file
   * explorer, and each shared entry of a shared base with the same mark
   * (bases-shared-marks.ts). On by default: "is this note syncing?" had no
   * answer without it.
   */
  fileStatusIcons: boolean;
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
  /**
   * Collaborators' key fingerprints this vault has shared a folder with, by
   * address. A different key for the same person is refused rather than used;
   * see `known-keys.ts`. Not secret — fingerprints of public keys — and kept
   * across sign-outs, because forgetting them would quietly re-trust whatever
   * key the server offers next.
   */
  knownKeys: KnownKeys;
  /**
   * Shared folders already offered to this vault, or already listed when the
   * offer first ran, so each newly shared folder is offered once. Null until
   * the first complete look; see `awaiting-folders.ts`.
   */
  offeredFolders: string[] | null;
  /** The "Get started" list was closed. It also goes by itself once the essentials are done. */
  getStartedDismissed: boolean;
  /**
   * Where the Nectenda status icon is shown. The same icon and menu in each;
   * at least one is always on. The status bar is ignored on a phone, which
   * has none.
   */
  statusIn: { header: boolean; ribbon: boolean; statusBar: boolean };
  /** Settings were opened once on a first run, so it is not done again. */
  welcomed: boolean;
}

export const DEFAULT_SETTINGS: NectendaSettings = {
  mode: 'cloud',
  identityUrl: DEFAULT_IDENTITY_URL,
  identity: null,
  identityAccessToken: '',
  refreshToken: '',
  memberships: [],
  pendingInvites: [],
  pendingRelease: null,
  recoveryKeyAcknowledgedAt: null,
  publishedVaultLabel: '',
  // Empty, not a localhost address. A cloud vault never sets this, so a
  // default here is written into every cloud install's data.json and reads as
  // configuration nobody chose. Empty also lets the self-hosted pane tell
  // "never touched" from "deliberately set", which is what the pre-`mode`
  // migration in loadSettings needed and could not get from this field.
  // The pane still shows ws://localhost:1234 — as a placeholder.
  serverUrl: '',
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
  oversizedNotes: [],
  diagnosticLog: false,
  sharePointer: true,
  showPointers: true,
  liveExcalidraw: true,
  liveKanban: true,
  fileStatusIcons: true,
  errorReports: true,
  errorReportsAcknowledgedAt: null,
  errorReportDsn: '',
  folderKeys: {},
  secrets: {},
  knownKeys: {},
  offeredFolders: null,
  getStartedDismissed: false,
  statusIn: { header: true, ribbon: true, statusBar: false },
  welcomed: false,
};

