import { Notice, Platform, Plugin, PluginSettingTab, App, Setting, MarkdownView, SettingPage, TextFileView, TFile, TFolder, apiVersion, editorInfoField, type SettingDefinitionItem, type SettingGroupItem } from 'obsidian';
import { DEFAULT_PORT, MAX_PUSH_BYTES, apiBaseUrl } from '@nectenda/shared';
import type { UserInfo, InviteTokenInfo, SharedFolderInfo, KeyMaterial, KdfParams } from '@nectenda/shared';
import { hashCredential } from '@nectenda/shared';
import { ProviderRouter, type ShardConnection } from './provider-router';
import { IdentityClient, IdentityError, ShardClient, type MeResponse, type SentInvite, type ShardSession } from './identity-client';
import { recoverSignedOutConnection } from './signed-out';
import { RefreshGate, type RefreshKind } from './single-flight';
import { partitionFolders, mappingBelongsTo, mayUnshare, foldersSyncedFor, unclaimedMappings } from './folder-sections';
import type { FolderRole } from './folder-members';
import { sessionIdFromToken } from './jwt-claims';
import { FolderKeyService } from './folder-key-service';
import {
  AttachmentLocationModal,
  ChoicePickerModal,
  FolderMembersModal,
  ManageStorageModal,
  ErrorReportConsentModal,
  FolderPickerModal,
  InviteByEmailModal,
  InviteToFolderModal,
  FolderSettingsModal,
  TextPromptModal,
  ConfirmModal,
  LargeAttachmentModal,
  NameOrganisationModal,
  PasswordPromptModal,
  PlanPickerModal,
  RecoveryKeyModal,
  RecoveryModal,
  StartOverModal,
  RemoveDeviceModal,
  SetPassphraseModal,
  UnshareFolderModal,
  MIN_PASSWORD_LENGTH,
} from './modals';
import type { TimerHandle } from './timers';
import { IdentitySession, type VerifyOutcome } from './identity-session';
import {
  RELEASE_CHECK_TICK_MS, type ReleaseCheckOutcome, type ReleaseCheckTrigger,
  dueDate, pendingAfterCheck, pendingReleaseText, releaseCheckDue, releaseCheckMayRotate, shouldAnnounce,
} from './start-over';
import { DEFAULT_SETTINGS, DEFAULT_IDENTITY_URL, type NectendaSettings } from './settings-type';
import { type ChangeReason, type PaneSection, sectionsFor, REFRESH_COALESCE_MS, PANE_POLL_MS, ChangeFanout, SectionGenerations } from './pane-refresh';
import { foldersSyncingLine, migrateStatusPlaces, formatBytes, describeAge, ambiguousNames, storageSummary, forgetUnmappedRecords, membershipShape, organisationSummary, organisationWarning, pageName, type FolderServer, pagesKey, type SentInviteStatus, sentInviteStatus, sentInviteDescription, shouldCreateFirstOrganisation } from './pane-summaries';
import { newPkce, pollForResult, type SignInResult } from './auth-flow';
import { establishMemberships, enrolNewSeats, membershipId, type StoredMembership, syncsHere, deviceOf, shownConnection, afterRefresh } from './cloud-session';
import { ObsidianVaultAdapter } from './obsidian-vault';
import { PROVIDER_LABELS, PROVIDER_ORDER, providerMark, providerStartUrl, type ProviderName } from './provider-marks';
import { nectendaMark, nectendaWordmark } from './brand-marks';
import * as session from './session';
import { fromBase64, identityPairs, importIdentityFromPkcs8, publicKeyFingerprint, toBase64 } from '@nectenda/shared';
import { DocIndex } from './doc-index';
import { IDENTITY_KEY_PREFIX, createDeviceStore, createSecretStore, SECRET_IDS, type SecretStore } from './secret-store';
import { describeDevice, describeInstall, getOrCreateInstallId, openVaultLabel, platformName, sealVaultLabel, type DeviceDescription } from './device';
import { ErrorReports, isOurs } from './error-report';
import { rollLogFile } from './diag-log-file';
import { kindOf, shouldWarnAboutStorage } from './blob-policy';
import { joinWithin } from './vault-path';
import {
  FolderCryptoRegistry,
  createFolderKeys,
  deserialiseFolderKeys,
  openFolderName,
  sealFolderName,
  serialiseFolderKeys,
  wrapKeysFor,
  type FolderKeyRecord,
  type StoredFolderKeys,
} from './folder-crypto';
import type { SessionKeys, SessionResult } from './session';
import { MultiplexedProvider } from './multiplexed-provider';
import { ContentSync } from './content-sync';
import { StructuredSync } from './structured-sync';
import { STRUCTURED_FORMATS } from './structured-formats';
import { TextViewGuard, EditProbe } from './text-view-guard';
import { TextViewPresence, type NoteViewLike } from './text-view-presence';
import { QuickSave } from './note-view-save';
import { KANBAN_VIEW_TYPE } from './kanban-presence';
import { CanvasLiveManager, bindingForCanvas, type CanvasLiveBinding } from './canvas-live';
import { BASES_PRESENCE_TICK_MS, BasesPresence, basesViewLike, type BasesViewLike } from './bases-presence';
import { PropertyFocus } from './property-focus';
import type { CanvasViewInternal } from './canvas-internals';
import { canvasCardBinding } from './canvas-card-binding';
import { PendingEdits } from './pending-edits';
import { EditorWiring } from './editor-wiring';
import { CanvasPresence } from './canvas-presence';
import { DeleteWitness, ExcalidrawLiveManager, sharedDrawingViews, type ExcalidrawLib, type ExcalidrawLiveBinding, type ExcalidrawViewLike } from './excalidraw-live';
import { ExcalidrawPresence } from './excalidraw-presence';
import { setKeptBy } from './excalidraw-codec';
import { OversizedNotes, describeOversizedNotes, type OversizedNote } from './oversized-notes';
import { mib } from './sync-status';
import { EditorBridge, presenceReporter, userColor } from './editor-bridge';
import type { FolderMapping } from './editor-bridge';
import { basenameOf, mappingCovering } from './folder-mapping';
import { FolderIndicator } from './folder-indicator';
import { FileStatusIndicator, buildEntryStatus, buildStatusIndex } from './file-status-indicator';
import { CONNECTION_LABELS, HEADER_ICON, HeaderStatus, PROBLEM_CONNECTIONS, countOthers, mayHide, registerHeaderIcon, type ConnectionStatus, type StatusPlaces } from './header-status';
import { INSPECTOR_VIEW, createInspectorView, isInspector, type InspectorDeps } from './sync-inspector';
import { KeyGrantService, nextGrantDelayMs, waitingKey } from './key-grants';
import { JustChanged } from './just-changed';
import { AwaitingFolders, type OfferedFolder } from './awaiting-folders';
import { addExistingMember, inviteNewAddress, routeInvite, type KeyTrust } from './folder-invite';
import { checkKey, knownKey, markCompared, rememberKey } from './known-keys';
import { defaultAddLocation, pathState } from './add-location';
import type { RosterUser, FolderMember } from './folder-members';
import { LABELS } from './labels';
import { COMMAND_IDS, COMMAND_NAMES, FOLDER_MENU_TITLES, commandAvailable, folderMenuItems, mappingFor, ownedMappingFor, ownedMappings, replaceShareLink, setShareLinkEnabled, shareLinkActions, shareLinkFor, shareLinkMemberships, type CommandId, type CommandState } from './commands';
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
import { log, setLogSink, setVerboseLogging } from './logger';
import { initials, presenceTitle, type Person } from './presence';
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
 * What a change to the memberships has to rebuild the pane for.
 *
 * The list of organisation pages, their names and what their entries say
 * come from the definitions, and only `update()` re-reads those — at the
 * price of a full rebuild (an open disclosure closes, a half-typed field is
 * lost). So the pane rebuilds when this key moves and refreshes in place
 * otherwise; a rotated token, which every refresh brings, is not in it.
 */


/**
 * One counter per section, so a slow answer to an old request cannot land
 * on top of a fresh one. Status edges come in bursts and the poll can overlap
 * an event; without this the pane would sometimes show the older of two
 * responses and call it current.
 */

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
 * A section heading, as Obsidian draws its own: a heading row, not a bare
 * h3/h4. The pane had both, and the difference showed as uneven spacing and
 * weights between sections that were meant to be peers.
 */
function heading(parent: HTMLElement, text: string): Setting {
  return new Setting(parent).setName(text).setHeading();
}

function noteRow(parent: HTMLElement, text: string | DocumentFragment, cls?: string): Setting {
  const row = new Setting(parent).setDesc(text);
  if (cls) row.descEl.addClass(cls);
  return row;
}

export { DEFAULT_SETTINGS, type NectendaSettings };


/**
 * How often to tell the server what this vault still references.
 *
 * Well inside the server's collection grace period, so several missed rounds in
 * a row still cost nothing. Erring short is free; erring long risks a file.
 */
const ATTEST_INTERVAL_MS = 6 * 60 * 60 * 1000;


// Modal for picking a vault folder


// What one passphrase attempt came to. Defined beside the code that produces
// it; re-exported because the prompt modal below and its tests take it from
// here.
export type { VerifyOutcome } from './identity-session';


/** The view types saved early while "Live sync for Kanban boards" is on, and while it is off. */
const KANBAN_ONLY: ReadonlySet<string> = new Set([KANBAN_VIEW_TYPE]);
const NONE: ReadonlySet<string> = new Set();

/**
 * Another plugin's view of a note — a board of the Kanban plugin, say: a
 * TextFileView of a `.md` that is not Obsidian's own editor. Guarded on write
 * (SAFE-A19, SAFE-A26) and given presence (WIRE-098) whatever its type.
 */
function isOtherNoteView(view: unknown): view is TextFileView {
  return view instanceof TextFileView && !(view instanceof MarkdownView) && view.file?.extension === 'md'
    // A Markdown-named structured file — an Excalidraw drawing — is not a note
    // here: it has its own guard, binding and presence (NEC-41, SAFE-A28).
    && kindOf(view.file.path) !== 'structured';
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
   * `deviceSecrets`. Not in memory only any more.
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
  structuredSync: StructuredSync | null = null;
  private textViewGuard: TextViewGuard | null = null;
  /** The guard for notes open in another plugin's view; see `startSync`. */
  private noteViewGuard: TextViewGuard | null = null;
  private editProbe: EditProbe | null = null;
  /** Open canvases bound live to their documents (canvas-live.ts). */
  private canvasLive: CanvasLiveManager | null = null;
  /** Header reports for live canvases, by view, for the active one to repaint. */
  private canvasReporters = new Map<unknown, () => void>();
  /** Open Excalidraw drawings bound live to their documents (excalidraw-live.ts, NEC-41). */
  excalidrawLive: ExcalidrawLiveManager | null = null;
  /**
   * What open drawings deleted, for the saves that leave it out. For the
   * plugin's lifetime, not a sync session's: a delete made while sync was off
   * is read in when it starts again.
   */
  private readonly deleteWitness = new DeleteWitness(() => this.openSharedDrawings());

  /** Open drawings in shared folders, skipping tabs not yet loaded (see sharedDrawingViews). */
  private openSharedDrawings(): ExcalidrawViewLike[] {
    return sharedDrawingViews(
      this.app.workspace.getLeavesOfType('excalidraw').map((leaf) => leaf.view),
      (path) => this.folderRootOf(path) !== null,
    );
  }
  /** Who has each open base open, and on which view (bases-presence.ts, WIRE-096). */
  private basesPresence: BasesPresence | null = null;
  /** Presence in another plugin's view of a note; see `startSync`. */
  private textViewPresence: TextViewPresence | null = null;
  /** Saves another plugin's view of a shared note soon after it changes (note-view-save.ts). */
  private quickSave: QuickSave | null = null;
  private propertyFocus: PropertyFocus | null = null;
  /** Each live canvas view's presence, for "go to" from the presence circles. */
  private canvasPresences = new Map<unknown, CanvasPresence>();
  editorBridge: EditorBridge | null = null;
  folderIndicator: FolderIndicator | null = null;
  fileSync: FileSync | null = null;
  blobSync: BlobSync | null = null;
  /**
   * Notes too large to sync (SAFE-A12). Built once for the plugin's lifetime
   * rather than with each start of sync, because the record it keeps outlives
   * a restart of sync and the settings tab reads it.
   */
  readonly oversizedNotes = new OversizedNotes({
    store: {
      get: () => this.settings.oversizedNotes ?? [],
      set: (keys) => { this.settings.oversizedNotes = keys; },
    },
    save: () => this.saveSettings(),
    notify: (notes) => this.reportOversizedNotes(notes),
  });
  /** What this device has learned it cannot open. Survives a crash. */
  deviceState: DeviceStateStore | null = null;
  /** Crash reporting; see `installErrorReports`. Null only before `onload` has run. */
  errorReports: ErrorReports | null = null;
  vaultWatcher: VaultWatcher | null = null;
  /** Connection state, as the header icon shows it. */
  connectionStatus: ConnectionStatus = 'disconnected';
  /** People other than this device in the active note. */
  presenceOthers = 0;
  /** Their names, for the status menu's "Go to …". */
  presentPeople: string[] = [];
  headerStatus: HeaderStatus | null = null;
  /** Wraps folder keys for members waiting on one; runs on owner devices only (see key-grants.ts). */
  keyGrants: KeyGrantService | null = null;
  /** Notices folders newly shared with this person and offers them once. */
  awaitingFolders: AwaitingFolders | null = null;
  private collaborationTimer: number | null = null;
  /**
   * Offers still on screen, by folder. An offer is kept until dismissed, so a
   * folder added some other way — the pane, another offer — would leave its
   * notice asking for something already done.
   */
  private offerNotices = new Map<string, Notice>();
  /** The first-run notice, closed once the person has signed in. */
  welcomeNotice: Notice | null = null;
  fileStatus: FileStatusIndicator | null = null;
  private statusUiTimer: TimerHandle | null = null;
  /** The most recent note to have focus, for the inspector. */
  private lastNotePath: string | null = null;
  /** Where EditorBridge installs a note's binding, one editor at a time (SAFE-D5). Registered once. */
  private editorWiring = new EditorWiring();
  /** Edits made while an editor binds (NEC-159). Registered once, on its own. */
  private pendingEdits = new PendingEdits(
    (state) => (state.field(editorInfoField, false) as unknown as { file?: { path?: string } } | undefined)?.file?.path ?? null,
  );

  /**
   * Measure what sealing a large attachment costs, from inside the app.
   *
   * Exposed only when NECTENDA_PROBE is set, which the e2e harness does and a
   * user never does. It exists because the streaming upload's whole
   * justification is a memory claim, and a memory claim never measured inside
   * the real runtime is an assumption.
   */
  private installProbe(): void {
    // `window`, not `globalThis`. They are the same object in the renderer, and
    // window is what the consumer already uses: the streaming e2e reaches this
    // as `w.nectendaProbe` from inside `browser.execute`. Obsidian's guidelines
    // ask for window so a popout gets its own; here it also just names the
    // thing the caller holds.
    const env = (window as unknown as { process?: { env?: Record<string, string> } }).process?.env;
    if (!env?.NECTENDA_PROBE) return;
    (window as unknown as Record<string, unknown>).nectendaProbe = async (
      path: string,
      size: number,
    ) => {
      const { sealBlobStream, generateBlobKey, newBlobId } = await import('@nectenda/shared');
      const vault = new ObsidianVaultAdapter(this.app.vault);
      const mem = (): { external: number; rss: number } | undefined =>
        (window as unknown as {
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
    // Before anything draws the mark: the ribbon, the note header, the status bar.
    registerHeaderIcon();
    this.settingTab = new NectendaSettingTab(this.app, this);
    this.addSettingTab(this.settingTab);
    this.registerSkippedAttachmentMarkers();
    this.registerCommands();
    this.createCollaborationServices();
    this.startJustChanged();
    this.welcomeOnce();

    // obsidian://nectenda?invite=<id> from an invitation email, or
    // obsidian://nectenda?key=nk_… from a share link. Navigation only: no
    // token ever travels through a deep link, and a sign-in never completes
    // through one — that is what the browser poll is for.
    this.registerObsidianProtocolHandler('nectenda', (params) => {
      void this.handleDeepLink(params);
    });

    // The status icon, in whichever of three places the person keeps it: each
    // note's header, the ribbon, the status bar. The same icon and the same
    // menu in all three; see header-status.ts. The mark is registered with
    // Obsidian's icons above, before the ribbon asks for it.
    this.headerStatus = new HeaderStatus({
      app: this.app,
      connection: () => this.shownConnection(),
      statusIndex: () => this.statusIndex(),
      peopleInActiveNote: () => this.presentPeople,
      invites: () => this.settings.pendingInvites?.length ?? 0,
      readyFolders: () => this.awaitingFolders?.report.ready.length ?? 0,
      foldersLine: () => (this.isSignedIn() ? foldersSyncingLine(this.settings.folderMappings.length, this.lockedFolderCount()) : null),
      folderFor: (path) => {
        const m = this.settings.folderMappings.find((x) => path.startsWith(x.localPath + '/'));
        return m ? { owner: m.role === 'owner' } : null;
      },
      places: () => this.statusPlaces(),
      pointers: () => ({ share: this.settings.sharePointer, show: this.settings.showPointers }),
      setSharePointer: (on) => this.setSharePointer(on),
      setShowPointers: (on) => this.setShowPointers(on),
      inspect: (path) => this.openInspector(path),
      goToPerson: (name) => this.goToPerson(name),
      openFolderSettings: (path) => {
        const m = this.settings.folderMappings.find((x) => path.startsWith(x.localPath + '/'));
        if (m) this.openFolderSettings(m);
      },
      inviteToFolder: (path) => {
        const m = this.settings.folderMappings.find((x) => path.startsWith(x.localPath + '/'));
        if (m) this.inviteToFolder(m);
      },
      openSharedWithYou: () => this.openSettingsTab(),
      openSettings: () => this.openSettingsTab(),
      addRibbon: (onClick) => this.addRibbonIcon(HEADER_ICON, 'Nectenda', onClick),
      addStatusBar: () => this.addStatusBarItem(),
    });
    this.headerStatus.apply();
    this.registerEvent(this.app.workspace.on('layout-change', () => {
      this.refreshStatusUi();
      this.canvasLive?.refresh();
      this.excalidrawLive?.refresh();
      this.basesPresence?.refresh();
      this.textViewPresence?.later();
      this.quickSave?.refresh();
      this.propertyFocus?.later();
      // Sync on or off: a delete made while it is off is what this is for.
      this.deleteWitness.watch();
    }));
    this.registerEvent(this.app.workspace.on('active-leaf-change', (leaf) => {
      // Remembered because the inspector takes focus when it opens, and from
      // then on the active view is the inspector, not the note it is about.
      if (leaf?.view instanceof MarkdownView && leaf.view.file) this.lastNotePath = leaf.view.file.path;
      this.refreshStatusUi();
      this.canvasLive?.refresh();
      this.excalidrawLive?.refresh();
      if (leaf?.view) this.canvasReporters.get(leaf.view)?.();
      this.basesPresence?.refresh();
      this.textViewPresence?.later();
      this.quickSave?.refresh();
      // Later, not now: the editor bridge binds the new note on this same
      // event, and the focus goes out on the note it binds.
      this.propertyFocus?.later();
    }));
    this.registerEvent(this.app.workspace.on('file-open', () => {
      this.refreshStatusUi();
      this.canvasLive?.refresh();
      this.excalidrawLive?.refresh();
      this.basesPresence?.refresh();
      this.textViewPresence?.later();
      this.quickSave?.refresh();
      this.propertyFocus?.later();
      // Sync on or off: a delete made while it is off is what this is for.
      this.deleteWitness.watch();
    }));
    // Which property of the Properties panel has focus (WIRE-097): its inputs
    // are not the editor, so only the document's focus events say.
    this.registerDomEvent(document, 'focusin', () => this.propertyFocus?.later());
    this.registerDomEvent(document, 'focusout', () => this.propertyFocus?.later());
    // A property changed rebuilds the panel's rows, and with them the marks.
    this.registerEvent(this.app.metadataCache.on('changed', () => this.propertyFocus?.later()));
    // Picking another view inside a base changes only the leaf's state, which
    // no workspace event is documented to report: checked on a short tick
    // instead. Only a change is sent (WIRE-091), so an idle tick costs a parse
    // of each open base and nothing on the wire.
    this.registerInterval(window.setInterval(() => {
      this.basesPresence?.refresh();
      this.textViewPresence?.later();
      this.quickSave?.refresh();
      // A backstop for a panel rebuilt with no event this sees, and for a
      // focus dropped when the bridge replaced the note's state on binding.
      this.propertyFocus?.sync();
    }, BASES_PRESENCE_TICK_MS));
    this.registerView(INSPECTOR_VIEW, (leaf) => createInspectorView(
      leaf,
      this.inspectorDeps(),
      () => this.app.workspace.getActiveViewOfType(MarkdownView)?.file?.path ?? this.lastNotePath,
    ));
    this.addCommand({
      id: 'inspect-note-sync-state',
      name: 'Inspect sync state of this note',
      checkCallback: (checking) => {
        const path = this.app.workspace.getActiveViewOfType(MarkdownView)?.file?.path;
        if (!path) return false;
        if (!checking) void this.openInspector(path);
        return true;
      },
    });
    this.addCommand({
      id: 'open-sync-inspector',
      name: 'Open sync-state inspector',
      callback: () => void this.openInspector(null),
    });
    this.updateStatus('disconnected');

    // Keep asking whether this account is set to start over, for as long as the
    // vault is open (start-over.ts). Registered whatever the sign-in state:
    // the check itself returns at once unless this is a signed-in cloud vault.
    this.registerInterval(window.setInterval(() => void this.checkPendingRelease('tick'), RELEASE_CHECK_TICK_MS));
    this.registerDomEvent(window, 'focus', () => void this.checkPendingRelease('focus'));

    // Registered exactly once, empty; EditorBridge fills it in the one editor
    // it binds, and every other editor keeps it empty (SAFE-D5).
    this.registerEditorExtension(this.editorWiring.extension);
    // What the user types while an editor is being bound, so the bind can
    // replay it rather than erase it (NEC-159). On its own: the wiring holds
    // only the bound editor's binding, and this must watch every editor.
    this.registerEditorExtension(this.pendingEdits.extension);
    // The editor inside a canvas card, bound to the card's text while its
    // canvas is live. Installed for every editor and inert outside those:
    // registered on its own, not in the wiring above, which holds only the
    // bound note's editor.
    this.registerEditorExtension(canvasCardBinding((state) => {
      const info = state.field(editorInfoField, false) as unknown as { node?: { id?: unknown; canvas?: unknown } } | undefined;
      const node = info?.node;
      if (!node || typeof node.id !== 'string') return null;
      const binding = bindingForCanvas(node.canvas);
      return binding?.isBound() ? { binding, id: node.id } : null;
    }));

    if (this.isSignedIn()) {
      // The identity keypair comes back from the device store where the OS
      // provides one, so a folder shared since the last unlock opens without a
      // prompt. A miss is normal and must not stop the start: folders already
      // mapped sync from their cached folder keys and need no identity at all.
      // The master key is still never stored.
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
      // Self-hosted has no membership refresh to hang this on, so it starts here;
      // on the cloud the refresh above triggers it again once sessions are fresh.
      this.scheduleCollaborationChecks(0);
    }
  }

  // -------------------------------------------------------------------------
  // Commands, the ribbon and the folder menu
  // -------------------------------------------------------------------------

  /** What the rules in commands.ts decide from, read fresh on every check. */
  private commandState(): CommandState {
    return {
      signedIn: this.isSignedIn(),
      mode: this.settings.mode,
      locked: this.isLocked(),
      hasKeys: !!this.settings.keyMaterial?.publicKey,
      mappings: this.settings.folderMappings,
      memberships: this.settings.memberships,
      offered: this.awaitingFolders?.report.ready.length ?? 0,
      unlocked: !!this.sessionKeys?.identity,
    };
  }

  /**
   * Every entry point here runs an action the settings pane already has,
   * through the pane's own code, so a command cannot behave differently from
   * the button it stands in for.
   */
  private registerCommands(): void {

    for (const id of COMMAND_IDS) {
      this.addCommand({
        id,
        name: COMMAND_NAMES[id],
        // checkCallback rather than callback: the palette then hides a command
        // that cannot work right now instead of offering it and failing.
        checkCallback: (checking) => {
          if (!commandAvailable(id, this.commandState())) return false;
          if (!checking) void this.runCommand(id);
          return true;
        },
      });
    }

    this.registerEvent(
      this.app.workspace.on('file-menu', (menu, file) => {
        if (file instanceof TFile) {
          // A note in a shared folder: its folder's settings, and for an
          // owner, inviting someone — the two things a person looking at a
          // shared note most often came to do.
          const m = this.settings.folderMappings.find((x) => file.path.startsWith(x.localPath + '/'));
          if (!m || !this.isSignedIn()) return;
          menu.addItem((mi) => mi.setTitle(FOLDER_MENU_TITLES.settings).setIcon('settings').onClick(() => this.openFolderSettings(m)));
          if (m.role === 'owner') {
            menu.addItem((mi) => mi.setTitle(FOLDER_MENU_TITLES.invite).setIcon('user-plus').onClick(() => this.inviteToFolder(m)));
          }
          return;
        }
        if (!(file instanceof TFolder)) return;
        for (const item of folderMenuItems(file.path, this.commandState())) {
          if (item === 'share') {
            menu.addItem((mi) => mi.setTitle(FOLDER_MENU_TITLES.share).setIcon('folder-sync').onClick(() => {
              void this.guarded('share the folder', () => this.shareFromCommand(file));
            }));
          } else {
            const mapping = this.settings.folderMappings.find((m) => m.localPath === file.path);
            if (!mapping) continue;
            if (item === 'invite') {
              menu.addItem((mi) => mi.setTitle(FOLDER_MENU_TITLES.invite).setIcon('user-plus').onClick(() => this.inviteToFolder(mapping)));
            } else if (item === 'settings') {
              menu.addItem((mi) => mi.setTitle(FOLDER_MENU_TITLES.settings).setIcon('settings').onClick(() => this.openFolderSettings(mapping)));
            } else {
              menu.addItem((mi) => mi.setTitle(FOLDER_MENU_TITLES.members).setIcon('users').onClick(() => this.showMembers(mapping)));
            }
          }
        }
      }),
    );
  }

  /** Obsidian's settings, open on this plugin's tab. `app.setting` is not in the typings. */
  openSettings(): void {
    const setting = (this.app as unknown as { setting: { open(): void; openTabById(id: string): void } }).setting;
    setting.open();
    setting.openTabById(this.manifest.id);
  }

  /** A command's work, with any failure said in a notice rather than lost to the console. */
  private async guarded(what: string, run: () => Promise<void> | void): Promise<void> {
    try {
      await run();
    } catch (err) {
      log.warn(`Could not ${what}`, { error: String(err) });
      new Notice(err instanceof Error ? err.message : `Could not ${what}`);
    }
  }

  private runCommand(id: CommandId): Promise<void> {
    switch (id) {
      case 'open-settings':
        return this.guarded('open settings', () => this.openSettings());
      case 'toggle-diagnostic-log':
        return this.guarded('change the diagnostic log', () => this.setDiagnosticLog(!this.settings.diagnosticLog));
      case 'share-folder':
        return this.guarded('share the folder', () => this.shareFromCommand(null));
      case 'show-folder-members':
        return this.guarded('show the members', () => this.showMembersFromCommand());
      case 'invite-to-folder':
        return this.guarded('invite to the folder', () => this.inviteFromCommand());
      case 'folder-settings':
        return this.guarded('open the folder\'s settings', () => this.folderSettingsFromCommand());
      case 'add-shared-folder':
        return this.guarded('add the folder', () => this.addSharedFromCommand());
      case 'join-with-link':
        return this.guarded('join', () => {
          new TextPromptModal(this.app, {
            title: 'Join with a link',
            placeholder: 'obsidian://nectenda?key=nk_… or nk_…',
            cta: 'Join',
            submit: async (v) => { await this.settingTab?.joinWithLink(v); this.refreshSettingsPane(); },
          }).open();
        });
      case 'forget-passphrase':
        return this.guarded('forget the passphrase', () => this.forgetPassphraseHere());
      case 'copy-share-link':
        return this.guarded('copy the share link', () => this.copyShareLinkFromCommand());
      case 'enter-passphrase':
        return this.guarded('unlock', () => this.enterPassphrase());
    }
  }

  /** One of several, asked only when there really are several. */
  private pick<T>(items: T[], text: (item: T) => string, placeholder: string, then: (item: T) => Promise<void> | void): void {
    if (items.length === 0) return;
    if (items.length === 1) {
      void this.guarded('continue', () => then(items[0]));
      return;
    }
    new ChoicePickerModal(this.app, items, text, placeholder, (item) => {
      void this.guarded('continue', () => then(item));
    }).open();
  }

  /**
   * Share a vault folder: the given one from the folder menu, or one picked
   * from the palette. On the cloud the organisation is chosen first, because
   * a vault folder belongs to exactly one.
   */
  async shareFromCommand(folder: TFolder | null): Promise<void> {
    const tab = this.settingTab;
    if (!tab) return;
    const share = (server: FolderServer): void => {
      const go = (f: TFolder): void => {
        void this.guarded('share the folder', () => tab.shareFolder(f.path, f.name, server));
      };
      if (folder) go(folder);
      else new FolderPickerModal(this.app, go).open();
    };
    if (this.settings.mode !== 'cloud') {
      const server = this.servers()[0];
      if (server) share(server);
      return;
    }
    this.pick(this.settings.memberships, (m) => m.accountName, 'Share into which organisation?', (m) => share(this.serverForMembership(m.id)));
  }

  /** The people dialog: managed by an owner, read-only with "Mark as compared" for an editor. */
  private showMembers(mapping: FolderMapping): void {
    const folderId = mapping.sharedFolderId;
    new FolderMembersModal(this.app, this.membersDeps(mapping), folderId, mapping.sharedFolderName).open();
  }

  /** What the people dialog needs, for one mapped folder. Shared with the settings pane's button. */
  membersDeps(mapping: FolderMapping): ConstructorParameters<typeof FolderMembersModal>[1] {
    const folderId = mapping.sharedFolderId;
    return {
      server: () => this.serverFor(folderId),
      ownPublicKey: () => this.settings.keyMaterial?.publicKey ?? null,
      folderKeys: () => this.folderCrypto.get(folderId),
      trust: this.keyTrust(),
      known: (email) => knownKey(this.settings.knownKeys ?? {}, email),
      markCompared: async (email, fingerprint) => {
        this.settings.knownKeys = markCompared(this.settings.knownKeys ?? {}, email, fingerprint, Date.now());
        await this.saveSettings();
        // A key that was refused because it changed may now be shared.
        this.scheduleCollaborationChecks(0);
      },
      waiting: (userId) => this.keyGrants?.report.states.get(waitingKey(folderId, userId)),
      invite: () => this.inviteToFolder(mapping),
      canManage: mapping.role === 'owner',
    };
  }

  /** The remembered-keys rule, over this vault's settings. */
  private keyTrust(): KeyTrust {
    return {
      check: async (email, publicKey) => {
        const fingerprint = await publicKeyFingerprint(publicKey);
        const known = this.settings.knownKeys ?? {};
        return { status: checkKey(known, email, fingerprint), fingerprint, knownFingerprint: knownKey(known, email)?.fingerprint };
      },
      remember: async (email, fingerprint) => {
        this.settings.knownKeys = rememberKey(this.settings.knownKeys ?? {}, email, fingerprint, Date.now());
        await this.saveSettings();
      },
    };
  }

  /**
   * Invite someone to a folder this vault owns: one action, whoever they are.
   * `folder-invite.ts` has the rules; this gathers what they need and says
   * how it went.
   */
  inviteToFolder(mapping: FolderMapping): void {
    new InviteToFolderModal(this.app, mapping.sharedFolderName, async (email, role) => {
      try {
        return await this.sendFolderInvite(mapping, email, role);
      } catch (err) {
        new Notice(err instanceof Error ? err.message : 'Could not send the invitation');
        return false;
      }
    }).open();
  }

  private async sendFolderInvite(mapping: FolderMapping, email: string, role: FolderRole): Promise<boolean> {
    const folderId = mapping.sharedFolderId;
    const server = this.serverFor(folderId);
    const auth = { headers: { Authorization: `Bearer ${server.token}` } };
    const [rosterRes, membersRes] = await Promise.all([
      serverFetch(`${server.base}/account`, auth),
      serverFetch(`${server.base}/folders/${folderId}/members`, auth),
    ]);
    const roster = rosterRes.ok ? ((await rosterRes.json()) as { users?: RosterUser[] }).users ?? [] : [];
    const members = membersRes.ok ? ((await membersRes.json()) as { members: FolderMember[] }).members : [];
    const membership = this.settings.mode === 'cloud'
      ? this.settings.memberships.find((m) => m.id === (mapping.membershipId ?? server.membershipId))
      : undefined;
    const route = routeInvite(email, { roster, members, hosted: this.settings.mode === 'cloud', orgRole: membership?.role ?? null });
    const share = { server, folderId, keys: this.folderCrypto.get(folderId), trust: this.keyTrust(), fetch: serverFetch, wrap: wrapKeysFor };
    const addExisting = async (userId: string, who: string): Promise<boolean> => {
      const outcome = await addExistingMember(share, { userId, who, role });
      new Notice(outcome.ok ? `${who} can now open "${mapping.sharedFolderName}". ${outcome.message}` : outcome.message, outcome.ok ? 8000 : 12000);
      this.scheduleCollaborationChecks(0);
      return true;
    };
    switch (route.kind) {
      case 'already-member':
        new Notice(`${route.label} is already in "${mapping.sharedFolderName}".`);
        return true;
      case 'existing':
        return addExisting(route.userId, route.label);
      case 'self-hosted':
        new Notice('Only people with an account on this server can be added. Ask whoever runs it for an invite token for them, then add them here.', 12000);
        return false;
      case 'not-admin':
        new Notice(`Only an owner or admin of ${membership?.accountName ?? 'the organisation'} can invite someone new. Ask one of them, or add someone already in it.`, 12000);
        return false;
      case 'new': {
        if (!membership) throw new Error('That folder belongs to no organisation this vault knows');
        const outcome = await inviteNewAddress(
          {
            server, folderId, fetch: serverFetch,
            inviteToOrganisation: async (address) => {
              await this.identityClient().createInvite(this.settings.identityAccessToken, { accountId: membership.accountId, email: address, role: 'member' });
            },
          },
          { email, role },
        );
        if ('already' in outcome) return addExisting(email, email).then(() => true);
        new Notice(outcome.message, outcome.ok ? 10000 : 12000);
        if (outcome.ok) {
          this.notifyChange('memberships');
          this.scheduleCollaborationChecks(0);
        }
        return outcome.ok;
      }
    }
  }

  /**
   * A folder's settings as a dialog. The pane's folder pages cannot be opened
   * from code — Obsidian's settings API has no call for it — so the palette,
   * the folder menu and the note menu open the same page drawn in a modal.
   */
  openFolderSettings(mapping: FolderMapping): void {
    const tab = this.settingTab;
    if (!tab) return;
    new FolderSettingsModal(this.app, mapping.sharedFolderName, (el) => tab.displayFolderPage(el, mapping)).open();
  }

  /** The folder of the open note, or one picked from those this vault syncs. */
  private folderSettingsFromCommand(): void {
    const path = this.app.workspace.getActiveFile()?.path ?? null;
    const here = path ? this.settings.folderMappings.find((m) => path.startsWith(m.localPath + '/')) : undefined;
    if (here) {
      this.openFolderSettings(here);
      return;
    }
    this.pick(this.settings.folderMappings, (m) => m.localPath, 'Settings for which shared folder?', (m) => this.openFolderSettings(m));
  }

  /** A folder already shared with this person, not yet in this vault. */
  private addSharedFromCommand(): void {
    const ready = this.awaitingFolders?.report.ready ?? [];
    this.pick(
      ready,
      (f) => `A folder from ${f.folder.createdByDisplayName ?? f.folder.createdByUsername ?? 'someone'}`,
      'Add which shared folder?',
      (f) => this.settingTab?.addSharedFolder(f.folder, f.membershipId),
    );
  }

  /**
   * Take the identity key off this device: out of memory and out of the
   * device's credential store. Folders already open keep syncing on the keys
   * they hold — that is what lets them sync with no network at start — so this
   * is not a lock on what is already here, and the notice says so. What it
   * stops is anything new being opened until the passphrase is entered again.
   */
  private async forgetPassphraseHere(): Promise<void> {
    await this.forgetIdentity();
    this.sessionKeys = null;
    new Notice(
      'Nectenda: your passphrase is forgotten on this device. Folders already open here keep syncing; '
        + 'opening another, or a new invitation, will ask for it again.',
      10000,
    );
    this.refreshSettingsPane();
  }

  /** The command: the folder of the open note when this vault owns it, otherwise asked. */
  private inviteFromCommand(): void {
    const here = ownedMappingFor(this.app.workspace.getActiveFile()?.path ?? null, this.settings.folderMappings);
    if (here) {
      this.inviteToFolder(here);
      return;
    }
    this.pick(ownedMappings(this.settings.folderMappings), (m) => m.localPath, 'Invite to which shared folder?', (m) => this.inviteToFolder(m));
  }

  // -------------------------------------------------------------------------
  // Finishing a share, and noticing one: key-grants.ts and awaiting-folders.ts
  // -------------------------------------------------------------------------

  /** The explorer pulse for notes changed in the background; desktop only. See just-changed.ts. */
  private startJustChanged(): void {
    if (Platform.isMobile) return;
    const pulse = new JustChanged({
      isShared: (path) => this.settings.folderMappings.some((m) => path.startsWith(m.localPath + '/')),
      activePath: () => this.app.workspace.getActiveViewOfType(MarkdownView)?.file?.path ?? null,
      rowsFor: (path) => Array.from(document.querySelectorAll(`.nav-file-title[data-path="${CSS.escape(path)}"]`)),
      frame: (cb) => window.requestAnimationFrame(cb),
    });
    this.registerEvent(this.app.vault.on('modify', (file) => pulse.changed(file.path)));
  }

  /**
   * The first time the plugin loads in a vault that is not signed in, say
   * where to start. A notice with a button rather than opening settings
   * unasked: a window appearing by itself reads as a bug, and on a phone it
   * would take the whole screen. Once only, whatever the person does with it.
   */
  private welcomeOnce(): void {
    if (this.settings.welcomed || this.isSignedIn()) return;
    this.settings.welcomed = true;
    void this.saveSettings();
    this.app.workspace.onLayoutReady(() => {
      const frag = createFragment();
      frag.appendText('Nectenda is installed. Sign in to share a folder and edit it together, end-to-end encrypted.');
      const btn = frag.createEl('button', { text: 'Open Nectenda settings', cls: 'mod-cta nectenda-notice-action' });
      const notice = new Notice(frag, 15000);
      this.welcomeNotice = notice;
      btn.addEventListener('click', () => {
        notice.hide();
        this.openSettings();
      });
    });
  }

  private createCollaborationServices(): void {
    const servers = () => (this.isSignedIn() ? this.servers().filter((x) => x.token && x.status !== 'moved') : []);
    this.keyGrants = new KeyGrantService({
      servers,
      folderKeys: (id) => this.folderCrypto.get(id),
      folderName: (id) => this.settings.folderMappings.find((m) => m.sharedFolderId === id)?.sharedFolderName ?? 'a shared folder',
      knownKeys: () => this.settings.knownKeys ?? {},
      saveKnownKeys: async (next) => {
        this.settings.knownKeys = next;
        await this.saveSettings();
      },
      fingerprint: (pk) => publicKeyFingerprint(pk),
      wrap: wrapKeysFor,
      fetch: serverFetch,
      shared: (e) => {
        new Notice(
          e.firstSighting
            ? `Nectenda: shared "${e.folderName}" with ${e.who}. Their key is ${e.fingerprint} — compare it with them outside Nectenda when you can.`
            : `Nectenda: shared "${e.folderName}" with ${e.who}.`,
          10000,
        );
        this.notifyChange('memberships');
      },
      refused: (e) => {
        // Kept on screen until dismissed: this is the one case where the
        // automatic path stops and a person has to decide.
        new Notice(
          `Nectenda: ${e.who}'s encryption key has changed since you last shared with them, so "${e.folderName}" was not shared. ` +
            `Was ${e.knownFingerprint}, now ${e.fingerprint}. Compare it with them outside Nectenda, then use "Mark as compared" in the folder's people list.`,
          0,
        );
        log.warn('A collaborator key changed; no folder key was shared', { folderId: e.folderId });
      },
      now: () => Date.now(),
    });
    this.awaitingFolders = new AwaitingFolders({
      servers,
      mapped: () => new Set(this.settings.folderMappings.map((m) => m.sharedFolderId)),
      seen: () => this.settings.offeredFolders ?? null,
      saveSeen: async (ids) => {
        this.settings.offeredFolders = ids;
        await this.saveSettings();
      },
      fetch: serverFetch,
      offer: (folders) => this.offerSharedFolders(folders),
    });
  }

  /**
   * Run both passes soon, then again on the schedule their results ask for.
   * One timer: a request for "now" replaces a later one rather than adding to it.
   */
  scheduleCollaborationChecks(delayMs: number): void {
    if (this.collaborationTimer) window.clearTimeout(this.collaborationTimer);
    this.collaborationTimer = window.setTimeout(() => {
      this.collaborationTimer = null;
      void this.runCollaborationChecks();
    }, delayMs);
  }

  private async runCollaborationChecks(): Promise<void> {
    let delay = 15 * 60_000;
    try {
      if (this.isSignedIn() && this.keyGrants && this.awaitingFolders) {
        const grants = await this.keyGrants.run();
        await this.awaitingFolders.run();
        delay = nextGrantDelayMs(grants);
        if (this.awaitingFolders.report.waiting.length) delay = Math.min(delay, 60_000);
      }
    } catch (err) {
      log.warn('Collaboration checks failed; retrying later', { error: String(err) });
    } finally {
      if (this.isSignedIn()) this.scheduleCollaborationChecks(delay);
    }
  }

  /** A notice with a button: the one prompt for a folder somebody shared. */
  private offerSharedFolders(folders: OfferedFolder[]): void {
    const frag = createFragment();
    if (folders.length === 1) {
      const [only] = folders;
      const who = only.folder.createdByDisplayName ?? only.folder.createdByUsername ?? 'Someone';
      frag.appendText(`${who} shared a folder with you.`);
      const btn = frag.createEl('button', { text: 'Add to this vault', cls: 'mod-cta nectenda-notice-action' });
      const notice = new Notice(frag, 0);
      this.offerNotices.set(only.folder.id, notice);
      btn.addEventListener('click', () => {
        notice.hide();
        void this.guarded('add the folder', () => this.settingTab?.addSharedFolder(only.folder, only.membershipId));
      });
      return;
    }
    frag.appendText(`${folders.length} folders were shared with you.`);
    const btn = frag.createEl('button', { text: 'Show them', cls: 'mod-cta nectenda-notice-action' });
    const notice = new Notice(frag, 0);
    btn.addEventListener('click', () => {
      notice.hide();
      this.openSettings();
    });
  }

  /** The shared folder of the open note, owned or not; otherwise asked. */
  private showMembersFromCommand(): void {
    const here = mappingFor(this.app.workspace.getActiveFile()?.path ?? null, this.settings.folderMappings);
    if (here) {
      this.showMembers(here);
      return;
    }
    this.pick(this.settings.folderMappings, (m) => m.localPath, 'People in which shared folder?', (m) => this.showMembers(m));
  }

  private copyShareLinkFromCommand(): void {
    const tab = this.settingTab;
    if (!tab) return;
    this.pick(shareLinkMemberships(this.settings.memberships), (m) => m.accountName, "Which organisation's share link?", (m) => tab.copyShareLink(m));
  }

  /** The pane's "Enter passphrase", from the palette. */
  private async enterPassphrase(): Promise<void> {
    const tab = this.settingTab;
    if (!tab) return;
    const identity = this.settings.identity;
    await tab.ensureIdentity(identity ? `Unlock the folders shared with ${identity.email}.` : 'Unlock your shared folders.');
    this.refreshSettingsPane();
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
    this.tokenOnlySinceFull = false;
    this.settings.pendingInvites = result.invites ?? [];
    // See applySession in the settings tab: a sign-in offers what is shared
    // from now on; only an upgraded, already-signed-in vault starts from null.
    if (via === 'sign-in') this.settings.offeredFolders ??= [];
    this.welcomeNotice?.hide();
    this.welcomeNotice = null;
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
  private readonly refreshGate = new RefreshGate();

  /**
   * True from a token-only rotation until the next full refresh or sign-in:
   * the stored tokens are fresh, but nothing was re-established with them.
   */
  private tokenOnlySinceFull = false;

  /**
   * True when the session is usable again; false when the identity service
   * refused it. Throws on the network.
   *
   * `refusedAccessToken` is the token the caller was refused with. If it is
   * no longer the stored one, a refresh already landed between the refusal
   * and this call, and there is nothing to do — unless that refresh only
   * rotated the tokens and this caller came for a full one.
   *
   * `kind: 'token'` rotates the tokens and stores them, nothing more: for the
   * pending-reset check, which needs a live access token and must not restart
   * sync to get one (NEC-148). Everything else wants the full refresh.
   */
  async refreshCloudSession(
    opts: { caller: string; refusedAccessToken?: string; kind?: RefreshKind } = { caller: 'unknown' },
  ): Promise<boolean> {
    const kind = opts.kind ?? 'full';
    const superseded = opts.refusedAccessToken !== undefined && opts.refusedAccessToken !== this.settings.identityAccessToken;
    if (superseded && (kind === 'token' || !this.tokenOnlySinceFull)) {
      log.info('Cloud session already refreshed', { caller: opts.caller });
      return true;
    }
    if (this.refreshGate.pending) log.info('Joined the in-flight Cloud session refresh', { caller: opts.caller, kind });
    return this.refreshGate.run(kind, () => (kind === 'token' ? this.doRotateCloudTokens(opts.caller) : this.doRefreshCloudSession(opts.caller)));
  }

  /**
   * Rotate the session's tokens and store them. Nothing else: no membership
   * work, no sync restart, which is what makes it cheap enough to run from a
   * timer. Same answers as the full refresh — false when refused, a throw on
   * the network.
   */
  private async doRotateCloudTokens(caller: string): Promise<boolean> {
    if (!this.settings.refreshToken) return false;
    const gen = this.sessionGeneration;
    try {
      const result = await this.identityClient().refresh(this.settings.refreshToken, describeInstall(this.app, this.secrets));
      // Signed out, or out and back in, while the request was out: the
      // sign-out retired this session, so these tokens are dead. Storing them
      // would put a signed-out vault back into a signed-in shape, or overwrite
      // the new session's tokens and have it signed out at its next refresh.
      if (gen !== this.sessionGeneration || !this.settings.identity) return false;
      this.settings.identityAccessToken = result.accessToken;
      this.settings.refreshToken = result.refreshToken;
      this.tokenOnlySinceFull = true;
      await this.saveSettings();
      log.info('Cloud session tokens rotated', { caller, sid: sessionIdFromToken(result.accessToken) });
      return true;
    } catch (err) {
      if (err instanceof IdentityError && err.status === 401) {
        log.warn('Cloud session token rotation refused', { caller, status: err.status, code: err.code ?? null });
        return false;
      }
      log.warn('Cloud session token rotation failed', { caller, error: String(err) });
      throw err;
    }
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
        window.setTimeout(() => void this.handleSignedOutConnection(id), 30_000);
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
    this.structuredSync?.disconnectFolder(folderId);
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

  /**
   * Say once, loudly, that this account is set to start over. A notice that
   * stays until dismissed, because the likeliest reader who did not ask for
   * it is the owner of a mailbox someone else has got into, and this device
   * is how they stop it (start-over.ts).
   */
  private announcePendingRelease(): void {
    const p = this.settings.pendingRelease;
    if (!shouldAnnounce(p, this.settings.announcedReleaseAt)) return;
    const { title, detail } = pendingReleaseText(p);
    new Notice(`Nectenda: ${title}. ${detail} "Cancel reset" is in Nectenda's settings.`, 0);
    this.settings.announcedReleaseAt = p.requestedAt;
    void this.saveSettings();
  }

  /** When `/api/me` last answered, from either this check or a full refresh. */
  private releaseCheckedAt = 0;
  private releaseCheckInFlight = false;
  /** Bumped by every other writer of `pendingRelease`, so a check that raced one of them drops its answer. */
  private releaseWrites = 0;

  /**
   * Ask only whether this account is set to start over, so that a vault left
   * open for days still raises the notice and shows Cancel reset. Only
   * `/api/me`: the full refresh also makes a session call to every
   * organisation's server, which is too much to do hourly for one field.
   *
   * It never signs the vault out. A refused token is refreshed for next time;
   * deciding that the session has ended belongs to the full refresh, which
   * runs on its own occasions.
   */
  async checkPendingRelease(trigger: ReleaseCheckTrigger): Promise<void> {
    if (this.settings.mode !== 'cloud' || !this.settings.identity) return;
    if (!releaseCheckDue(trigger, Date.now(), this.releaseCheckedAt, this.releaseCheckInFlight)) return;
    this.releaseCheckInFlight = true;
    // Stamped on the attempt, not on success: a vault offline, or refused,
    // would otherwise ask on every focus and every tick until it got through.
    this.releaseCheckedAt = Date.now();
    const writesBefore = this.releaseWrites;
    try {
      let outcome: ReleaseCheckOutcome;
      try {
        outcome = { ok: true, pendingRelease: (await this.meForReleaseCheck(releaseCheckMayRotate(trigger))).pendingRelease };
      } catch (err) {
        log.info('Could not check for a pending reset', { trigger, error: String(err) });
        outcome = { ok: false };
      }
      // Anything that wrote the field while this was out knows better: a
      // Cancel pressed here, a full refresh, a sign-out. An answer given
      // before a cancel would otherwise put the row back.
      if (this.releaseWrites !== writesBefore) return;
      if (this.settings.mode !== 'cloud' || !this.settings.identity) return;
      const before = this.settings.pendingRelease ?? null;
      const after = pendingAfterCheck(before, outcome);
      if (JSON.stringify(after) !== JSON.stringify(before)) {
        this.settings.pendingRelease = after;
        await this.saveSettings();
        // The row sits in the home pane's Account group, which no poll
        // redraws: an open pane would otherwise keep showing, or keep
        // lacking, Cancel reset until it was closed and reopened.
        this.refreshSettingsPane();
      }
      this.announcePendingRelease();
    } finally {
      this.releaseCheckInFlight = false;
    }
  }

  /**
   * `/api/me`, and on a refused token — when `mayRotate` — one token-only
   * rotation and a second ask. The access token lives ten minutes, so most
   * checks meet an expired one; the full refresh would answer that by
   * restarting sync (NEC-148). Throws when there is no answer, and never
   * signs out: a session that has really ended is the full refresh's to find.
   */
  private async meForReleaseCheck(mayRotate: boolean): Promise<MeResponse> {
    const token = this.settings.identityAccessToken;
    try {
      return await this.identityClient().me(token);
    } catch (err) {
      if (!(err instanceof IdentityError && err.status === 401) || !mayRotate) throw err;
      if (!(await this.refreshCloudSession({ caller: 'release-check', refusedAccessToken: token, kind: 'token' }))) throw err;
      return this.identityClient().me(this.settings.identityAccessToken);
    }
  }

  /** Ask for this account to start over. The server waits before it does anything. */
  async requestStartOver(): Promise<void> {
    const email = this.settings.identity?.email;
    if (!email) return;
    const { pendingRelease } = await this.identityClient().requestRelease(this.settings.identityAccessToken, email);
    this.settings.pendingRelease = pendingRelease;
    this.releaseWrites++;
    // This device asked; it does not need the alarm meant for the others.
    this.settings.announcedReleaseAt = pendingRelease.requestedAt;
    await this.saveSettings();
    new Notice(`Nectenda: this account will start over on ${dueDate(pendingRelease)}. You can cancel it until then in Nectenda's settings.`, 0);
  }

  async cancelStartOver(): Promise<void> {
    await this.identityClient().cancelRelease(this.settings.identityAccessToken);
    this.settings.pendingRelease = null;
    this.releaseWrites++;
    await this.saveSettings();
    new Notice('Nectenda: the reset was cancelled. Nothing has changed.');
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
    // This answered the pending-reset question too, so the lighter check waits its full gap from here.
    this.releaseCheckedAt = Date.now();
    this.settings.identity = { ...this.settings.identity, email: me.user.email, displayName: me.user.displayName };
    // Where this server wants crash reports. Cached so that a later start
    // with no network can still report, and cleared at sign-out beside the
    // keys, because it belongs to the server that named it. A server that
    // names none — every self-hosted one — leaves this empty and nothing is
    // ever sent.
    this.settings.errorReportDsn = me.errorReporting?.dsn ?? '';
    this.maybeAskAboutErrorReports();
    this.settings.pendingInvites = me.invites ?? [];
    this.settings.pendingRelease = me.pendingRelease ?? null;
    this.releaseWrites++;
    this.announcePendingRelease();
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
    const established = await establishMemberships(me.identityToken, [...me.memberships, ...unlisted], this.settings.memberships, this.deviceFields(), undefined, { enrol });
    // A seat that appeared since the last refresh has never been offered to
    // this device, so it is offered now; see enrolNewSeats for why the rule
    // above does not cover it.
    const { memberships, refused } = await enrolNewSeats(established.memberships, this.settings.memberships, this.deviceFields());
    this.reportRefusedDevice(refused);
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
    this.updateStatus(afterRefresh(this.provider?.status()));
    if (enrol) this.reportRefusedDevice(memberships);
    this.notifyChange('memberships');
    // A seat taken or an invitation claimed shows up here first, so this is
    // when somebody new is most likely to be waiting for a key.
    this.scheduleCollaborationChecks(0);
  }

  /** Bring the live connections into line with the stored memberships. */
  private reconcileConnections(): void {
    // A membership refused or re-admitted changes what the icons show even
    // when no socket changes (shownConnection).
    this.refreshStatusUi();
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

    // Ask the identity service to pull this shard now.
    //
    // It learns about organisations only from its own once-a-minute manifest
    // pull, so until that lands it does not know this one exists and refuses a
    // checkout for it as unknown. Somebody who creates an organisation and
    // immediately presses *Change plan* is inside that window by construction.
    //
    // Deliberately not awaited and deliberately swallowed, exactly as the
    // invite path does it: the creation has already succeeded on the shard, the
    // pull loop gets there regardless, and failing a creation over a hint would
    // be the wrong trade entirely.
    void this.identityClient()
      .organisationCreated(this.settings.identityAccessToken, where.shardId)
      .catch(() => undefined);

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
    this.settings.pendingRelease = null;
    this.releaseWrites++;
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
    // Which folders were already offered is about this account's listing; the
    // next account starts with a fresh first look rather than a flood of offers.
    this.settings.offeredFolders = null;
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
    // obsidian://nectenda?open=folder&path=<vault path>: a folder's settings,
    // for a guide or an email to link straight to. Navigation only, like the rest.
    if (params.open === 'folder') {
      const m = this.settings.folderMappings.find((x) => x.localPath === params.path);
      if (m) {
        this.openFolderSettings(m);
        return;
      }
      new Notice(params.path ? `"${params.path}" is not a shared folder in this vault.` : 'That link names no folder.');
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

        // Beside the embed, not inside it: Obsidian loads the embed after
        // post-processors run and replaces its contents with its own "could
        // not be found", which took this with it the moment it was drawn.
        const notice = createDiv({ cls: 'nectenda-surface nectenda-skipped-attachment' });
        embed.after(notice);
        notice.createDiv({
          text: `${relative} was not downloaded to this device.`,
          cls: 'setting-item-description',
        });
        const button = notice.createEl('button', { text: 'Download on this device' });
        button.onclick = () => {
          button.disabled = true;
          button.setText('Downloading...');
          // Beside the embed, nothing redraws this once the file arrives: it
          // goes itself when the download works, and offers again when not.
          void this.retryAttachment(mapping.sharedFolderId, relative).then((ok) => {
            if (ok) {
              notice.remove();
            } else {
              button.disabled = false;
              button.setText('Download on this device');
            }
          });
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
    // The name came from the folder's listing, so it came from whoever created
    // the attachment. Refused rather than trusted — see vault-path.ts.
    const full = joinWithin(mapping.localPath, relativePath);
    if (!full) return false;
    try {
      const file = this.app.vault.getAbstractFileByPath(full);
      if (file) {
        // To the vault trash, not gone: the user is freeing server space, and
        // may not have meant to destroy their only copy.
        //
        // Obsidian's review asks for `FileManager.trashFile()` here, to respect
        // the user's deletion preference. Declined, deliberately. That
        // preference describes what should happen when *they* delete something;
        // this is sync removing a file on their behalf, and for anyone whose
        // setting is "Permanently delete" honouring it would turn a remote
        // action into the destruction of their only copy. The vault's own
        // .trash is the answer that cannot lose anything.
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
  async retryAttachment(folderId: string, relativePath: string): Promise<boolean> {
    await this.deviceState?.retry(folderId, relativePath);
    const entry = this.fileSync?.getBlobEntry(folderId, relativePath);
    if (!entry) {
      new Notice('Nectenda: that attachment is no longer shared.');
      return false;
    }
    new Notice(`Nectenda: downloading "${relativePath}"...`);
    const ok = await this.blobSync?.download(folderId, relativePath, entry);
    if (!ok) new Notice(`Nectenda: "${relativePath}" could not be downloaded.`);
    return !!ok;
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
    await new Promise((r) => window.setTimeout(r, 2000));
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
    this.deleteWitness.dispose();
    this.oversizedNotes.dispose();
    if (this.statusUiTimer) window.clearTimeout(this.statusUiTimer);
    this.statusUiTimer = null;
    this.headerStatus?.stop();
    this.headerStatus = null;
    if (this.collaborationTimer) window.clearTimeout(this.collaborationTimer);
    this.collaborationTimer = null;
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
        this.updateStatus('connected');
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
        this.updateStatus('device-limit');
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
        this.updateStatus('update-required');
        if (!this.updateRequiredNotified) {
          this.updateRequiredNotified = true;
          new Notice(
            'Nectenda: update the Nectenda plugin to keep syncing. Your notes are saved locally ' +
              'and nothing is lost; syncing resumes on its own once the update is installed.',
            12000,
          );
        }
      } else if (status === 'suspended') {
        this.updateStatus('suspended');
        this.reportAccountSuspended();
      } else if (status === 'moving') {
        // Short-lived: the organisation is being carried to another server.
        // Editing continues locally and the identity service names the new
        // server within a minute; nothing to say beyond the header icon.
        this.updateStatus('moving');
        void this.refreshMemberships().catch(() => undefined);
      } else if (status === 'restarting') {
        // A deploy. Seconds long, retried quickly, and no notice: the
        // header icon says so, and a notice would announce an outage that is
        // not one. If the window closes without a connection the provider
        // reports 'disconnected' and the branch below speaks.
        this.updateStatus('restarting');
      } else if (status === 'disconnected') {
        this.updateStatus('offline');
        // Once per episode. A flapping link would otherwise stack a notice per
        // drop, and the sibling notices above already work this way.
        if (!this.disconnectNotified) {
          this.disconnectNotified = true;
          new Notice('Nectenda: Lost connection to server. Reconnecting...');
        }
      } else if (status === 'signed-out') {
        // Transient: the handler below is asking the identity service what
        // this means, and ends in a reconnect or a sign-out.
        this.updateStatus('signed-out');
      } else if (status === 'idle') {
        this.updateStatus('idle');
      }
    });
    this.provider.on('signed-out', (id: unknown) => void this.handleSignedOutConnection(String(id)));
    this.provider.on('folder-gone', (id: unknown) => this.handleFolderGone(String(id)));
    this.provider.connect();

    // A note open in another plugin's view — a board of the Kanban plugin, or
    // any TextFileView of a `.md` that is not Obsidian's editor. Obsidian
    // reloads it on our write with no merge, so it is asked to save first and
    // checked for having loaded (SAFE-A19), and a write waits while someone
    // types or drags in it (SAFE-A26). text-view-guard.ts. Found by walking
    // the leaves rather than by view type, so a plugin this build has never
    // heard of is guarded too.
    this.noteViewGuard?.dispose();
    this.editProbe?.dispose();
    this.editProbe = new EditProbe(document);
    this.noteViewGuard = new TextViewGuard(() => this.otherNoteViews(), this.editProbe);

    // Content sync for background file syncing
    const vaultAdapter = new ObsidianVaultAdapter(this.app.vault);
    this.contentSync = new ContentSync({
      surface: this.noteViewGuard,
      hasKeys: (id) => this.folderCrypto.hasKeys(id),
      docIndex: this.docIndex,
      vaultKey: () => this.vaultKey,
      mappings: () => this.settings.folderMappings,
      checkNoteSize: (folderId, path, bytes) => this.oversizedNotes.check(folderId, path, bytes),
      noteMoved: (folderId, from, to) => this.oversizedNotes.move(folderId, from, to),
      noteGone: (folderId, path) => this.oversizedNotes.forget(folderId, path),
      notify: (message) => new Notice(message, 10000),
    }, this.provider, vaultAdapter);
    const contentSync = this.contentSync;
    this.noteViewGuard.onEditEnded((path) => contentSync.editEnded(path));
    // A change in such a view reaches the document only once the view saves,
    // which Obsidian puts off by two seconds; a Kanban board is saved sooner.
    this.quickSave?.dispose();
    this.quickSave = new QuickSave(() => this.otherNoteViews(), (path) => this.folderRootOf(path) !== null, () => (this.settings.liveKanban ? KANBAN_ONLY : NONE));
    this.quickSave.refresh();
    // Who is on a note in another plugin's view, and on a Kanban board which
    // card (WIRE-098). text-view-presence.ts.
    this.textViewPresence?.dispose();
    this.textViewPresence = new TextViewPresence({
      active: () => {
        const view = this.app.workspace.getActiveViewOfType(TextFileView);
        return isOtherNoteView(view) ? view as unknown as NoteViewLike : null;
      },
      awarenessFor: (path) => contentSync.awarenessFor(path),
      username: () => this.presenceName(),
      userColor,
      report: (people) => this.updatePresence(people),
      activeElement: () => document.activeElement,
      kanbanFocus: () => this.settings.liveKanban,
    });
    // A file whose subscribe was refused for want of a connection is retried
    // when one appears, rather than waiting for something to touch it again.
    // Without this it stayed unconnected — looking healthy, syncing nothing —
    // until the person happened to reopen the note.
    this.provider.on('routes-changed', () => {
      this.fileSync?.retryUnplaced();
      this.contentSync?.retryUnplaced();
      this.structuredSync?.retryUnplaced();
    });

    // Files merged key by key: `.canvas` and `.base` (structured-formats.ts).
    // An open view of one is asked to save before its file is replaced, and
    // checked for having loaded the write (text-view-guard.ts, SAFE-A19).
    // Every view type a registered format names is watched; a view that is not
    // a TextFileView is not one the guard can flush, and the contract spec
    // fails if Obsidian stops making these views TextFileViews.
    const guardedViewTypes = [...new Set(Object.values(STRUCTURED_FORMATS)
      .map((codec) => codec.viewType)
      .filter((t): t is string => typeof t === 'string'))];
    this.textViewGuard?.dispose();
    this.textViewGuard = new TextViewGuard(() => guardedViewTypes
      .flatMap((type) => this.app.workspace.getLeavesOfType(type))
      .map((leaf) => leaf.view)
      .filter((view): view is TextFileView => view instanceof TextFileView));
    this.structuredSync = new StructuredSync({
      hasKeys: (id) => this.folderCrypto.hasKeys(id),
      docIndex: this.docIndex,
      vaultKey: () => this.vaultKey,
      formats: STRUCTURED_FORMATS,
      notify: (message) => new Notice(message, 10000),
      surface: this.textViewGuard,
      // An Excalidraw drawing that is not bound — live sync for drawings off,
      // or a binding that fell back — is merged over disk, and the write waits
      // while someone is typing or drawing in it (SAFE-A26).
      editInProgress: (path) => {
        const probe = this.editProbe;
        if (!probe) return false;
        return this.app.workspace.getLeavesOfType('excalidraw').some((leaf) => {
          const view = leaf.view as unknown as { file?: { path: string } | null; containerEl?: HTMLElement; semaphores?: { isEditingText?: boolean } };
          if (view.file?.path !== path) return false;
          return view.semaphores?.isEditingText === true || (view.containerEl ? probe.editingIn(view.containerEl) : false);
        });
      },
      // Live or not, a drawing's deletes are in no file: see DeleteWitness.
      withViewDeletes: (path, saved, current) => this.deleteWitness.withViewDeletes(path, saved, current),
    }, this.provider, vaultAdapter);

    // An open canvas of a shared file is bound live (canvas-live.ts): the
    // view writes the file, and changes travel both ways as they happen. The
    // guard above is its fallback whenever a binding cannot hold.
    this.canvasLive?.dispose();
    const structured = this.structuredSync;
    this.canvasLive = new CanvasLiveManager({
      structured,
      readFile: async (path) => {
        const file = this.app.vault.getAbstractFileByPath(path);
        return file instanceof TFile ? await this.app.vault.read(file) : null;
      },
      fellBack: () => undefined,
      notify: (message) => new Notice(message, 10000),
      views: () => this.app.workspace.getLeavesOfType('canvas')
        .map((leaf) => leaf.view)
        .filter((view) => view instanceof TextFileView) as unknown as CanvasViewInternal[],
      obsidianVersion: apiVersion,
    });
    this.canvasLive.onBound((binding) => this.startCanvasPresence(binding));
    // Canvases already open: no workspace event will say so. It keeps trying
    // until each one's document has connected.
    this.canvasLive.refresh();

    // An open Excalidraw drawing is bound the same way, through the Excalidraw
    // plugin's own API (excalidraw-live.ts, NEC-41) — unless the user turned
    // live sync for drawings off, when it is merged on save instead.
    setKeptBy(this.presenceName());
    this.excalidrawLive?.dispose();
    this.excalidrawLive = new ExcalidrawLiveManager({
      structured,
      readFile: async (path) => {
        const file = this.app.vault.getAbstractFileByPath(path);
        return file instanceof TFile ? await this.app.vault.read(file) : null;
      },
      lib: () => ((window as unknown as { ExcalidrawLib?: ExcalidrawLib }).ExcalidrawLib ?? null),
      fellBack: () => undefined,
      notify: (message) => new Notice(message, 10000),
      enabled: () => this.settings.liveExcalidraw,
      witness: this.deleteWitness,
      views: () => this.openSharedDrawings(),
      pluginVersion: (this.app as unknown as { plugins?: { manifests?: Record<string, { version?: string }> } })
        .plugins?.manifests?.['obsidian-excalidraw-plugin']?.version,
    });
    this.excalidrawLive.onBound((binding) => this.startExcalidrawPresence(binding));
    this.excalidrawLive.refresh();

    this.basesPresence?.dispose();
    const basesViews = (): (BasesViewLike & { view: TextFileView })[] => this.app.workspace.getLeavesOfType('bases')
      .map((leaf) => leaf.view)
      .filter((view): view is TextFileView => view instanceof TextFileView)
      .map((view) => basesViewLike(view));
    this.basesPresence = new BasesPresence({
      structured,
      views: basesViews,
      active: () => {
        const view = this.app.workspace.getActiveViewOfType(TextFileView);
        return view && view.getViewType() === 'bases' ? basesViews().find((v) => v.view === view) ?? null : null;
      },
      username: () => this.presenceName(),
      userColor,
      report: (people) => this.updatePresence(people),
      folderRoot: (path) => this.folderRootOf(path),
      notify: (m) => new Notice(m, 10000),
      // The explorer's setting: one switch for every sync-status mark.
      entryStatus: () => this.settings.fileStatusIcons ? buildEntryStatus({
        mappings: () => this.settings.folderMappings,
        trackedDocs: () => this.contentSync?.trackedDocs() ?? [],
        docSyncState: (docName) => this.provider?.docSyncState(docName) ?? null,
        structuredDocName: (path) => this.structuredSync?.docNameFor(path) ?? null,
      }) : null,
    });
    this.basesPresence.refresh();

    // File operations sync (meta docs)
    this.fileSync = new FileSync({
      hasKeys: (id) => this.folderCrypto.hasKeys(id),
      docIndex: this.docIndex,
      vaultKey: () => this.vaultKey,
      // Late, not captured: blobSync is assigned further down this method.
      blobSync: () => this.blobSync ?? null,
    }, this.provider, vaultAdapter);
    this.fileSync.setContentSync(this.contentSync);
    this.fileSync.setStructuredSync(this.structuredSync);

    // Attachments
    this.blobSync = new BlobSync({
      folderKeys: (id) => this.folderCrypto.get(id),
      server: (id) => this.serverFor(id),
      maxBlobBytes: () => this.maxBlobBytes(),
      username: () => this.settings.username,
      deviceState: () => this.deviceState,
      // The listing owns the blobs map; attachment sync only reads and writes
      // entries in it. Late, because fileSync is assigned just above and its
      // meta document connects later still.
      listing: () => this.fileSync ?? null,
      // The three lists that outlive a restart. Read through, rather than
      // captured: `settings` is replaced wholesale when it is reloaded.
      oversized: {
        get: () => this.settings.oversizedAttachments ?? [],
        set: (keys) => { this.settings.oversizedAttachments = keys; },
      },
      pendingUploads: {
        get: () => this.settings.pendingBlobUploads ?? [],
        set: (keys) => { this.settings.pendingBlobUploads = keys; },
      },
      pendingDeletes: {
        get: () => this.settings.pendingBlobDeletes ?? [],
        set: (keys) => { this.settings.pendingBlobDeletes = keys; },
      },
      save: () => this.saveSettings(),
      notify: {
        confirmLargeDownload: (path, bytes) => this.confirmLargeDownload(path, bytes),
        attachmentTooLarge: (path, bytes, limit) => this.reportAttachmentTooLarge(path, bytes, limit),
        attachmentsNotIncluded: () => this.reportAttachmentsNotIncluded(),
        accountSuspended: () => this.reportAccountSuspended(),
        storageFull: (blobId) => this.reportStorageFull(blobId),
        keptOlderClientVersion: (path) => {
          new Notice(
            `Nectenda: "${path}" was changed by someone on an older version of Nectenda. `
              + 'Their version was kept as a conflict copy beside it.',
            10000,
          );
        },
      },
    }, vaultAdapter);

    // Vault watcher for local file changes
    this.vaultWatcher = new VaultWatcher({
      app: this.app,
      registerEvent: (ref) => this.registerEvent(ref),
      mappings: () => this.settings.folderMappings,
      onMappedFolderRename: (oldPath, newPath, moved) =>
        this.handleMappedFolderRename(oldPath, newPath, moved),
    }, this.fileSync, this.contentSync, vaultAdapter, this.blobSync, this.structuredSync);
    this.vaultWatcher.start();

    // Editor bridge for live collaborative editing
    // What collaborators see above this person's cursor: the display name on
    // Nectenda Cloud, the username on a self-hosted server.
    const presenceName = this.presenceName();
    this.editorBridge = new EditorBridge({
      app: this.app,
      registerEvent: (ref) => this.registerEvent(ref),
      docIndex: this.docIndex,
      mappings: () => this.settings.folderMappings,
      sharePointer: () => this.settings.sharePointer,
      showPointers: () => this.settings.showPointers,
      pendingEdits: this.pendingEdits,
    }, this.contentSync, this.provider, presenceName, this.editorWiring);
    this.contentSync.setOnAdopted((path, text) => this.pendingEdits.adopted(path, text));
    this.editorBridge.setPresenceCallback((people) => {
      this.updatePresence(people);
    });
    this.editorBridge.start();

    this.propertyFocus?.dispose();
    const bridge = this.editorBridge;
    this.propertyFocus = new PropertyFocus({
      bound: () => bridge.boundPresence(),
      panes: (path) => this.app.workspace.getLeavesOfType('markdown')
        .flatMap((leaf) => leaf.view instanceof MarkdownView && leaf.view.file?.path === path ? [leaf.view.containerEl] : []),
      folderRoot: (path) => this.folderRootOf(path),
      activeElement: () => document.activeElement,
    });
    this.propertyFocus.sync();

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

    this.folderIndicator = new FolderIndicator({
      mappings: () => this.settings.folderMappings,
      isStorageFull: () => this.isStorageFull(),
    });
    this.folderIndicator.start();

    // Per-file status. The provider reports on every keystroke and the engine
    // on every attach; both only ask for a redraw, which is coalesced.
    this.fileStatus = new FileStatusIndicator({
      mappings: () => this.settings.folderMappings,
      trackedDocs: () => this.contentSync?.trackedDocs() ?? [],
      docSyncState: (docName) => this.provider?.docSyncState(docName) ?? null,
      enabled: () => this.settings.fileStatusIcons,
      structuredDocName: (path) => this.structuredSync?.docNameFor(path) ?? null,
    });
    this.fileStatus.start();
    if (this.contentSync) this.contentSync.onStateChange = () => this.refreshStatusUi();
    this.provider.on('doc-state', () => this.refreshStatusUi());

    this.updateStatus(this.provider.list().length ? 'connected' : 'idle');
  }

  /** Turn the diagnostic log on or off: the settings toggle and the palette command. */
  async setDiagnosticLog(on: boolean): Promise<void> {
    this.settings.diagnosticLog = on;
    await this.saveSettings();
    this.applyDiagnosticLogSetting();
    new Notice(on ? 'Diagnostic log enabled' : 'Diagnostic log disabled');
  }

  /**
   * Start or stop mirroring the log to a file, following the setting.
   *
   * Writes are chained rather than fired in parallel so lines cannot interleave
   * or arrive out of order — a trace whose ordering cannot be trusted is worse
   * than none, since ordering is usually the thing being diagnosed.
   */
  applyDiagnosticLogSetting(): void {
    // The same switch governs the console. Obsidian asks that a plugin's
    // console output be errors only by default, and somebody turning
    // diagnostics on is asking to see the rest.
    setVerboseLogging(this.settings.diagnosticLog);

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
      // `log.error` writes to the console before it touches the sink, so this
      // is reported even though the sink is the thing that just failed. It
      // does also re-enter the sink, but `complained` above is already set by
      // then, so the second pass returns immediately rather than looping.
      log.error('Diagnostic log could not be written', err);
    };

    // The last session's file is kept as diag.prev.log, not written over: a
    // reload otherwise wipes the record of what came just before it.
    let queue: Promise<void> = rollLogFile(adapter, path, `=== session start ${new Date().toISOString()} ===\n`)
      .catch(failed);
    setLogSink((line) => {
      queue = queue
        .then(async () => {
          if (++sinceCheck >= CHECK_EVERY) {
            sinceCheck = 0;
            const stat = await adapter.stat(path);
            if (stat && stat.size > MAX_BYTES) {
              // Rolled into diag.prev.log like a new session, rather than
              // truncated: the end just written is the useful end, and
              // truncating threw it away with the rest.
              await rollLogFile(adapter, path, `=== continued at ${new Date().toISOString()} ===\n`);
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
    // Before the engine is dismantled: its teardown reports each detach, and a
    // redraw fired from inside it would read state half taken apart.
    if (this.contentSync) this.contentSync.onStateChange = null;
    this.fileStatus?.stop();
    this.fileStatus = null;
    this.contentSync?.disconnectAll();
    this.contentSync = null;
    // Live canvases let go first: they hold documents about to be destroyed.
    this.canvasLive?.dispose();
    this.canvasLive = null;
    this.excalidrawLive?.dispose();
    this.excalidrawLive = null;
    this.basesPresence?.dispose();
    this.basesPresence = null;
    this.textViewPresence?.dispose();
    this.textViewPresence = null;
    this.quickSave?.dispose();
    this.quickSave = null;
    this.structuredSync?.disconnectAll();
    this.structuredSync = null;
    this.textViewGuard?.dispose();
    this.textViewGuard = null;
    this.noteViewGuard?.dispose();
    this.noteViewGuard = null;
    this.editProbe?.dispose();
    this.editProbe = null;
    // Before the provider goes, so every in-flight transfer is aborted while
    // the state it would write into still exists. void-fired teardown racing
    // async work has caused at least four bugs in this codebase.
    this.blobSync?.stop();
    this.blobSync = null;
    this.fileSync?.disconnectAll();
    this.fileSync = null;
    this.folderIndicator?.stop();
    this.folderIndicator = null;
    this.propertyFocus?.dispose();
    this.propertyFocus = null;
    this.editorBridge?.stop();
    this.editorBridge = null;
    this.provider?.destroy();
    this.provider = null;
    this.updateStatus('disconnected');
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
    const notesChanged = this.oversizedNotes.forgetUnmapped(mapped);
    if (oversized.length === (this.settings.oversizedAttachments ?? []).length
      && pending.length === (this.settings.pendingBlobUploads ?? []).length
      && !notesChanged) return;
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
    for (const [folderId, notice] of this.offerNotices) {
      if (this.settings.folderMappings.some((m) => m.sharedFolderId === folderId)) {
        notice.hide();
        this.offerNotices.delete(folderId);
      }
    }
    // Every change to the folder mappings comes through here, and the pane's
    // "This vault" entries are definitions Obsidian re-reads only when told. A
    // folder added from the notice or the folder menu, with settings closed,
    // was missing from the list when they next opened.
    this.settingTab?.pagesChanged();
    this.pruneAttachmentRecords();
    // A folder the server no longer has is not reconnected: the sockets would
    // be refused in silence and the header icon would claim it still syncs.
    // Unmapping it is what clears this, which is the person's own decision.
    const mapped = new Set(this.settings.folderMappings.map((m) => m.sharedFolderId));
    for (const id of [...this.goneFolders]) if (!mapped.has(id)) this.goneFolders.delete(id);
    const live = this.settings.folderMappings.filter((m) => !this.goneFolders.has(m.sharedFolderId));
    this.provider?.setFolderRoutes(this.folderRoutes());
    this.editorBridge?.reconnectActiveFile();
    this.folderIndicator?.refresh();

    // Reconnect meta docs and content sync for new/removed mappings.
    // Structured files are placed by FileSync's reconcile when each listing
    // opens, so they are only torn down here, before it runs.
    this.canvasLive?.reset();
    this.excalidrawLive?.reset();
    this.structuredSync?.disconnectAll();
    if (this.fileSync) {
      this.fileSync.disconnectAll();
      for (const mapping of live) {
        this.fileSync.connectFolder(mapping.sharedFolderId, mapping.localPath);
      }
    }
    // Open canvases and drawings bind again once their documents reconnect.
    this.canvasLive?.refresh();
    this.excalidrawLive?.refresh();
    if (this.contentSync) {
      this.contentSync.disconnectAll();
      for (const mapping of live) {
        this.contentSync.connectFolder(mapping.sharedFolderId, mapping.localPath);
        this.blobSync?.connectFolder(mapping.sharedFolderId, mapping.localPath);
      }
    }
    this.notifyChange('structure');
  }

  /**
   * The connection state the icons and the pane show: `connectionStatus`,
   * unless a folder here belongs to an organisation that refused this device,
   * whose connection is dropped and so is in no aggregate (cloud-session.ts).
   */
  shownConnection(): ConnectionStatus {
    return shownConnection(this.connectionStatus, this.settings.memberships, this.settings.folderMappings);
  }

  updateStatus(status: ConnectionStatus): void {
    this.connectionStatus = status;
    this.refreshStatusUi();
    this.notifyChange('connection');
  }

  /** The shared-entry dots in open bases, after the setting that gates them changed. */
  redrawBasesShared(): void {
    this.basesPresence?.redrawShared();
  }

  /** A status lookup for one redraw, from the engine and provider as they stand. */
  private statusIndex(): ReturnType<typeof buildStatusIndex> {
    return buildStatusIndex({
      mappings: () => this.settings.folderMappings,
      trackedDocs: () => this.contentSync?.trackedDocs() ?? [],
      docSyncState: (docName) => this.provider?.docSyncState(docName) ?? null,
      structuredDocName: (path) => this.structuredSync?.docNameFor(path) ?? null,
    });
  }

  /**
   * Redraw the header icons, the explorer marks and any open inspector, once
   * per burst. Coalesced because the provider reports on every keystroke.
   */
  refreshStatusUi(): void {
    if (this.statusUiTimer) return;
    this.statusUiTimer = window.setTimeout(() => {
      this.statusUiTimer = null;
      this.headerStatus?.refresh();
      this.fileStatus?.refresh();
      this.basesPresence?.redrawShared();
      for (const leaf of this.app.workspace.getLeavesOfType(INSPECTOR_VIEW)) {
        if (isInspector(leaf.view)) leaf.view.refresh();
      }
    }, 250);
  }

  /** Where the status icon shows, as this platform can show it: a phone has no status bar. */
  statusPlaces(): { header: boolean; ribbon: boolean; statusBar: boolean } {
    const p = this.settings.statusIn ?? DEFAULT_SETTINGS.statusIn;
    return { header: p.header, ribbon: p.ribbon, statusBar: p.statusBar && !Platform.isMobile };
  }

  /** Folders this vault syncs whose key is not open here. */
  lockedFolderCount(): number {
    return this.settings.folderMappings.filter((m) => !this.folderCrypto.hasKeys(m.sharedFolderId)).length;
  }

  private inspectorDeps(): InspectorDeps {
    return {
      trackedDocs: () => this.contentSync?.trackedDocs() ?? [],
      docSyncState: (docName) => this.provider?.docSyncState(docName) ?? null,
      diskMatchesDocument: (docName) => this.contentSync?.diskMatchesDocument(docName) ?? Promise.resolve(null),
      inSharedFolder: (path) => this.settings.folderMappings.some((m) => path.startsWith(`${m.localPath}/`)),
    };
  }

  /** Show the inspector in the right sidebar, pointed at a note or the active one. */
  async openInspector(path: string | null): Promise<void> {
    let leaf = this.app.workspace.getLeavesOfType(INSPECTOR_VIEW)[0];
    if (!leaf) {
      const right = this.app.workspace.getRightLeaf(false);
      if (!right) return;
      await right.setViewState({ type: INSPECTOR_VIEW, active: true });
      leaf = right;
    }
    await this.app.workspace.revealLeaf(leaf);
    if (isInspector(leaf.view)) leaf.view.show(path);
  }

  openSettingsTab(): void {
    const setting = (this.app as unknown as { setting?: { open(): void; openTabById(id: string): void } }).setting;
    setting?.open();
    setting?.openTabById(this.manifest.id);
  }

  /**
   * The pointer switches, shared by the settings pane and the header menu so
   * the two cannot drift: turning sharing off has to withdraw the last
   * position sent, or it stays on everyone else's screen with no next move to
   * replace it.
   */
  async setSharePointer(on: boolean): Promise<void> {
    this.settings.sharePointer = on;
    await this.saveSettings();
    if (!on) this.editorBridge?.clearPointer();
  }

  async setShowPointers(on: boolean): Promise<void> {
    this.settings.showPointers = on;
    await this.saveSettings();
    this.editorBridge?.refreshPointers();
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
   * Notes too large to sync, named when they arrive (SAFE-A12).
   *
   * MiB to one decimal rather than `formatBytes`, which rounds past 10 and would
   * print a note just over the limit as the same "16 MB" as the limit itself.
   */
  reportOversizedNotes(notes: OversizedNote[]): void {
    log.warn('Notes too large to sync', {
      notes: notes.map((n) => ({ relativePath: n.relativePath, bytes: n.bytes })),
    });
    new Notice(describeOversizedNotes(notes, mib), 15000);
  }

  /** Size on disk of a note in a mapped folder, or null when it is not there. */
  noteSize(sharedFolderId: string, relativePath: string): number | null {
    const mapping = this.settings.folderMappings.find((m) => m.sharedFolderId === sharedFolderId);
    if (!mapping) return null;
    const file = this.app.vault.getAbstractFileByPath(`${mapping.localPath}/${relativePath}`);
    return file instanceof TFile ? file.stat.size : null;
  }

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
   * Rendered twice, deliberately. The circles are the fast read; the header
   * icon keeps a number and words because the design system's rule is that
   * presence must never be identified by colour alone — a reader who cannot
   * separate teal from indigo still gets the count from the badge, and the
   * names from the icon's label and menu. This used to be status-bar text,
   * which also covered a hidden note header; it moved because mobile has no
   * status bar at all, which left nobody there with a count.
   */
  /**
   * Presence for a canvas just bound live: pointers, selections and gestures
   * (canvas-presence.ts), and who is here in the header while it is the
   * active view — as for a note. All of it ends when the binding does.
   */
  private startCanvasPresence(binding: CanvasLiveBinding): void {
    const awareness = binding.awareness;
    const docName = binding.boundDocName();
    if (!awareness || !docName) return;
    const presence = new CanvasPresence(binding, {
      username: () => this.presenceName(),
      userColor,
      sharePointer: () => this.settings.sharePointer,
      showPointers: () => this.settings.showPointers,
    });
    presence.start();
    this.canvasPresences.set(binding.view, presence);
    const isActive = (): boolean => this.app.workspace.getActiveViewOfType(TextFileView) === (binding.view as unknown);
    const report = (people: Person[]): void => {
      if (isActive()) this.updatePresence(people);
    };
    const reporter = presenceReporter(awareness, docName, report);
    awareness.on('change', reporter);
    // On becoming the active view: a fresh reporter, which always reports,
    // on the next tick — after the note binding has cleared the header for
    // the note it left.
    this.canvasReporters.set(binding.view, () => {
      window.setTimeout(() => presenceReporter(awareness, docName, report)(), 0);
    });
    if (isActive()) reporter();
    const off = binding.onChange(() => {
      if (binding.isBound()) return;
      off();
      awareness.off('change', reporter);
      this.canvasReporters.delete(binding.view);
      if (this.canvasPresences.get(binding.view) === presence) this.canvasPresences.delete(binding.view);
      presence.stop();
    });
  }

  /**
   * Presence for a drawing just bound live (excalidraw-presence.ts, WIRE-099):
   * collaborators' pointers and selections drawn by Excalidraw itself, and who
   * is here in the header while it is the active view. Ends with the binding.
   */
  private startExcalidrawPresence(binding: ExcalidrawLiveBinding): void {
    const awareness = binding.awareness;
    const docName = binding.boundDocName();
    const root = (binding.view as unknown as { contentEl?: HTMLElement }).contentEl;
    if (!awareness || !docName || !root) return;
    const presence = new ExcalidrawPresence(binding, root, {
      username: () => this.presenceName(),
      userColor,
      sharePointer: () => this.settings.sharePointer,
      showPointers: () => this.settings.showPointers,
    });
    presence.start();
    const isActive = (): boolean => this.app.workspace.getActiveViewOfType(TextFileView) === (binding.view as unknown);
    const report = (people: Person[]): void => {
      if (isActive()) this.updatePresence(people);
    };
    const reporter = presenceReporter(awareness, docName, report);
    awareness.on('change', reporter);
    this.canvasReporters.set(binding.view, () => {
      window.setTimeout(() => presenceReporter(awareness, docName, report)(), 0);
    });
    if (isActive()) reporter();
    binding.onDetach(() => {
      awareness.off('change', reporter);
      this.canvasReporters.delete(binding.view);
      presence.stop();
      // The header said who is here live; this drawing no longer is, so it says
      // nothing until it is bound again. Left, its circles would go on claiming
      // a live session that has dropped to syncing on save.
      if (isActive()) this.updatePresence([]);
    });
  }

  /** "Live sync for Excalidraw drawings": bound drawings let go at once when it is turned off. */
  async setLiveExcalidraw(on: boolean): Promise<void> {
    this.settings.liveExcalidraw = on;
    await this.saveSettings();
    this.excalidrawLive?.refresh();
  }

  /** "Live sync for Kanban boards": open boards stop saving early and drawing focus at once. */
  async setLiveKanban(on: boolean): Promise<void> {
    this.settings.liveKanban = on;
    await this.saveSettings();
    this.quickSave?.refresh();
    this.textViewPresence?.later();
  }

  updatePresence(people: Person[]): void {
    this.renderPresenceStack(people);
    this.updatePresenceCount(people);
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
    // A note, or a live canvas: both report the people in them (canvas people
    // come from startCanvasPresence, only while that canvas is active).
    const view = this.app.workspace.getActiveViewOfType(MarkdownView)
      ?? this.app.workspace.getActiveViewOfType(TextFileView);
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
      dot.setAttr('aria-label', `Go to ${person.name}`);
      dot.setAttr('title', presenceTitle(person));
      dot.addClass('mod-clickable');
      dot.addEventListener('click', () => this.goToPerson(person.name));
    }
    if (people.length > shown.length) {
      stack.createSpan({
        cls: 'nectenda-presence-dot nectenda-presence-more',
        text: `+${people.length - shown.length}`,
      });
    }
  }

  /**
   * Take the view to a collaborator. In a note: their caret, where ours is put
   * too; else their mouse pointer, scrolled to without moving ours, since a
   * pointer is not an editing position. On a live canvas: their pointer
   * first, then the card they are typing in (CanvasPresence.goTo).
   */
  private goToPerson(name: string): void {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    const other = view ? null : this.app.workspace.getActiveViewOfType(TextFileView);
    if (other?.getViewType() === 'bases') {
      // In a base: their view, through the leaf's public state.
      const where = this.basesPresence?.viewOf(name) ?? null;
      if (where === null) {
        new Notice(`${name} is not on a view of this base right now.`);
        return;
      }
      void other.setState({ ...other.getState(), viewName: where }, { history: false })
        .then(() => this.basesPresence?.refresh())
        .catch((err: unknown) => log.warn('Could not switch a base to a collaborator\'s view', { error: String(err) }));
      return;
    }
    if (isOtherNoteView(other)) {
      // Another plugin's view of the note — a Kanban board: the card they are on.
      if (!this.textViewPresence?.goTo(name)) new Notice(`${name} is not on a card here right now.`);
      return;
    }
    if (!view) {
      const canvas = other;
      const presence = canvas ? this.canvasPresences.get(canvas) : undefined;
      if (!presence?.goTo(name)) new Notice(`${name} is not pointing or typing on this canvas right now.`);
      return;
    }
    const target = this.editorBridge?.goToOffsetOf(name) ?? null;
    if (!target) {
      new Notice(`${name} has no cursor or pointer in this note right now.`);
      return;
    }
    const pos = view.editor.offsetToPos(target.index);
    if (target.kind === 'caret') {
      view.editor.setCursor(pos);
      view.editor.scrollIntoView({ from: pos, to: pos }, true);
      view.editor.focus();
    } else {
      view.editor.scrollIntoView({ from: pos, to: pos }, true);
    }
  }

  /**
   * Every open view of a note that is not Obsidian's own editor: any
   * TextFileView whose file is a `.md`. Canvas and bases are other files, and
   * have their own guard.
   */
  private otherNoteViews(): TextFileView[] {
    const views: TextFileView[] = [];
    this.app.workspace.iterateAllLeaves((leaf) => {
      if (isOtherNoteView(leaf.view)) views.push(leaf.view);
    });
    return views;
  }

  /**
   * The local root of the shared folder a file is inside, or null. A focus is
   * sent relative to it, and only for a file under it (WIRE-096, WIRE-097).
   */
  private folderRootOf(path: string): string | null {
    const m = this.settings.folderMappings.find((mapping) => path.startsWith(mapping.localPath + '/'));
    return m ? m.localPath : null;
  }

  /** The name this device shows to others in a note. */
  private presenceName(): string {
    return this.settings.mode === 'cloud' ? this.settings.identity?.displayName || this.settings.identity?.email || 'someone' : this.settings.username;
  }

  /**
   * Others in the active note, for the badge on the header icon. Counted by
   * name, the way the circles are, and without this device's own name: the
   * local entry is absent while no editor is bound, so subtracting one would
   * undercount exactly then.
   */
  updatePresenceCount(people: Person[]): void {
    const me = this.editorBridge?.broadcastName() ?? this.presenceName();
    const others = countOthers(people, me);
    const names = people.map((p) => p.name).filter((n) => n !== me);
    if (others === this.presenceOthers && names.join('\n') === this.presentPeople.join('\n')) return;
    this.presenceOthers = others;
    this.presentPeople = names;
    this.refreshStatusUi();
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
    const stored = await this.loadData() as Partial<NectendaSettings> | null;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, stored);
    // A vault configured before `mode` existed has no such key, and was
    // self-hosted by definition — cloud did not exist yet. Without this it
    // would inherit the new `cloud` default, and `isSignedIn()` reads
    // `identity` in cloud mode, so a vault holding a perfectly good
    // self-hosted token would announce itself signed out.
    //
    // Keyed on the stored token rather than on serverUrl: serverUrl carried a
    // default for most of its life, so an old file cannot tell "set" from
    // "never touched" through it. The token never had one.
    if (stored && !('mode' in stored) && stored.token) this.settings.mode = 'self-hosted';
    this.settings.statusIn = migrateStatusPlaces(stored);
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

  /**
   * Folder keys, and the rules about when not to ask for them.
   *
   * Every dependency is an arrow calling through `this`, so they bind at call
   * time: `apiFetch` needs `this.update()`, and a test that replaces one of
   * these on the instance still replaces what the service reaches.
   *
   * `prompt` and `held` are the same keypair by two routes, and the difference
   * is the point — `held` never asks, so anything reached from a render cannot
   * raise a password prompt.
   */
  private keys = new FolderKeyService({
    fetch: (url, init) => this.apiFetch(url, init),
    prompt: (reason) => this.ensureIdentity(reason),
    held: () => this.plugin.sessionKeys?.identity ?? null,
    // Two call sites asked this two ways — `get(id) !== null` and
    // `hasKeys(id)`. Both read the same map, so the service asks once.
    hasKeys: (id) => this.plugin.folderCrypto.hasKeys(id),
    remember: (k) => this.plugin.rememberFolderKeys(k),
    serverFor: (id) => this.plugin.serverFor(id),
    serverForMembership: (id) => this.plugin.serverForMembership(id),
    ownPublicKey: () => {
      const publicKey = this.plugin.settings.keyMaterial?.publicKey;
      if (!publicKey) throw new Error('This account has no encryption keys enrolled');
      return publicKey;
    },
  });

  /**
   * The identity keypair, and the rules about not replacing it.
   *
   * Arrows through `this` for the same reason as `keys` above: `ask` and
   * `enrol` open modals that need `this.app`, and `account` must be read late
   * because `refreshMemberships` rewrites `keyMaterial` on a timer.
   */
  private identity = new IdentitySession({
    account: () => this.plugin.settings,
    held: () => this.plugin.sessionKeys?.identity ?? null,
    cache: (keys) => { this.plugin.sessionKeys = keys; },
    restoreFromDevice: () => this.plugin.restoreIdentity(),
    rememberOnDevice: (identity) => this.plugin.rememberIdentity(identity),
    ask: (reason, verify) => this.promptForPassphrase(reason, verify),
    enrol: () => this.setCloudPassphrase(),
    notify: (message) => { new Notice(message); },
  });

  /** Fetch wrapper that handles session expiry (401) automatically */
  async apiFetch(input: string, init?: RequestInit): Promise<Response> {
    const res = await serverFetch(input, init);
    if (res.status === 401 && this.plugin.isSignedIn()) {
      await this.plugin.handleSessionExpired();
      this.update();
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
  private pollTimer: TimerHandle | null = null;
  private flushTimer: TimerHandle | null = null;
  private pendingSections = new Set<PaneSection>();
  private generations = new SectionGenerations();
  private slots: Partial<Record<Exclude<PaneSection, 'account' | 'organisations' | 'sharedFolders'>, HTMLElement>> = {};
  /** One shared-folders section per server on screen, keyed by its API base. */
  folderSlots = new Map<string, { el: HTMLElement; server: FolderServer }>();
  private accountSlots = new Map<string, AccountSlots>();
  /** What the organisation pages were last built from; a change rebuilds the pane. */
  private lastPagesKey = '';
  /** The organisation page on screen, if one is. Tests reach it here. */
  openPage: { containerEl: HTMLElement; membershipId?: string } | null = null;

  /*
   * There is deliberately no `display()` here.
   *
   * The pane is rendered from definitions: once `getSettingDefinitions()`
   * answers, Obsidian never calls `display()`, and everything in here that
   * redraws does so through `update()`, which re-reads the definitions and
   * rebuilds. A shim forwarding `display()` to `update()` used to sit at this
   * spot, kept for "an older Obsidian that has no update()" — but `update()`
   * arrived in 1.13.0 and `manifest.json` asks for 1.13.7, so no app that can
   * install this plugin has ever lacked it. `SettingTab.display()` is declared
   * non-abstract and deprecated, so leaving it out is the supported shape.
   */

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
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- the class below is defined inside this method precisely so it can close over the tab; there is no other way to reach its private sections
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
        tab.displaySharedFolders(c, server);
        tab.displayOrganisationActions(c, m);
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
    /**
     * A page that is not an organisation's: a folder in this vault, Security,
     * Editing, Advanced. Same lifecycle as the organisation page — it takes
     * the tab's subscriptions over while it is on screen and hands them back
     * when it goes — so its sections refresh like the home pane's do.
     */
    class PanePage extends SettingPage {
      constructor(title: string, private readonly draw: (c: HTMLElement) => void) {
        super();
        this.title = title;
      }
      display(): void {
        const c = this.containerEl;
        c.empty();
        tab.openPage = this;
        tab.bind();
        this.draw(c);
      }
      hide(): void {
        if (tab.openPage === this) tab.openPage = null;
        tab.release();
      }
    }
    this.lastPagesKey = pagesKey(settings.memberships, settings.folderMappings);
    const orgName = (id: string | undefined): string | null =>
      settings.memberships.find((m) => m.id === id)?.accountName ?? null;
    return [
      brand,
      { type: 'group', heading: LABELS.account, items: [host('Account', (el) => { this.displayPendingRelease(el); this.displayStatusLine(el); this.displayIdentityRows(el); }, false)] },
      // Above the checklist: an invitation waiting is the one thing on the
      // pane a new person has to act on, and the checklist points up at it.
      host(LABELS.sharedWithYou, (el) => this.displaySharedWithYou(el)),
      ...(this.getStartedSteps().show ? [host(LABELS.getStarted, (el) => this.displayGetStarted(el))] : []),
      {
        type: 'group',
        heading: LABELS.thisVault,
        items: [
          // One page per folder this vault syncs: what the folder is, who is in
          // it, and the two ways to stop — here only, or for everyone.
          ...settings.folderMappings.map((m): SettingGroupItem => ({
            type: 'page',
            name: m.sharedFolderName,
            desc: [m.localPath !== m.sharedFolderName ? m.localPath : null, m.role === 'owner' ? 'owner' : 'editor', orgName(m.membershipId)].filter(Boolean).join(' · '),
            displayValue: () => this.folderSummary(m),
            status: () => (this.plugin.folderCrypto.hasKeys(m.sharedFolderId) ? null : 'warning'),
            page: () => new PanePage(m.sharedFolderName, (c) => this.displayFolderPage(c, m)),
          })),
          host('This vault', (el) => this.displayVaultActions(el), false),
        ],
      },
      // A mapping made before mappings named their organisation, in a vault
      // that now has several, belongs to no page; it stays here to be removed.
      ...(unclaimedMappings(settings.folderMappings, settings.memberships.length).length > 0
        ? [host('Folders needing attention', (el) => this.displayUnclaimedMappings(el))]
        : []),
      {
        type: 'group',
        heading: LABELS.organisations,
        items: [
          ...settings.memberships.map((m, i, all): SettingGroupItem => ({
            type: 'page',
            name: pageName(m, i, all),
            // Role and region only. Which server holds it is an operator's
            // detail, and lives under Advanced for anyone reporting a problem.
            desc: `${m.role}${m.region ? ` · ${m.region.toUpperCase()}` : ''}`,
            displayValue: () => organisationSummary(m, foldersSyncedFor(m.id, this.plugin.settings.folderMappings, this.plugin.settings.memberships.length)),
            status: () => organisationWarning(m),
            page: () => new OrganisationPage(m.id, pageName(m, i, all)),
          })),
          host('Create or join an organisation', (el) => this.displayOrganisationControls(el), false),
        ],
      },
      {
        type: 'group',
        heading: LABELS.more,
        items: [
          { type: 'page', name: LABELS.security, desc: 'Your passphrase, your key fingerprint, signed-in vaults and passkeys.', page: () => new PanePage(LABELS.security, (c) => { this.displayEncryption(c); this.displayCloudDevices(c); }) },
          { type: 'page', name: LABELS.editing, desc: 'Mouse pointers, and marks in the file explorer.', page: () => new PanePage(LABELS.editing, (c) => this.displayCollaboration(c)) },
          { type: 'page', name: LABELS.advanced, desc: 'Diagnostic log, crash reports, and which servers this vault uses.', page: () => new PanePage(LABELS.advanced, (c) => { this.displayTroubleshooting(c); this.displayServers(c); }) },
        ],
      },
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
      window.clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.pendingSections.clear();
    this.slots = {};
    this.accountSlots.clear();
    this.folderSlots.clear();
    this.keys.recheck();
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
    this.pollTimer = window.setInterval(() => this.scheduleRefresh('poll'), PANE_POLL_MS);
  }

  private stopPoll(): void {
    if (this.pollTimer) window.clearInterval(this.pollTimer);
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
    if (reason === 'poll' || reason === 'structure') this.keys.recheck();
    for (const section of sectionsFor(reason)) this.pendingSections.add(section);
    if (this.flushTimer) return;
    this.flushTimer = window.setTimeout(() => {
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
   *
   * That is also why the heading here is an `h2` rather than `setHeading()`,
   * which Obsidian's guidelines otherwise ask for. `setHeading()` makes a
   * Setting row, and a row is the thing this screen is deliberately not. Every
   * heading that *is* a row uses it — see the Invitations, Signed-in vaults and
   * Passkeys sections. Worth knowing if a review flags the tag: it is a
   * considered exception, not an oversight.
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
      this.update();
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
    // `containerEl`, not the `messageEl` the deprecation notice suggests:
    // messageEl is the inner text, and this makes the whole notice the cancel
    // target, which is what `noticeEl` used to be.
    waiting.containerEl.addEventListener('click', () => cancel.abort());
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
        this.update();
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
    this.update();
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
      this.update();
      return true;
    } catch (err) {
      working.hide();
      new Notice(`Could not create the organisation: ${err instanceof Error ? err.message : String(err)}`);
      this.update();
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
      this.update();
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
      .setName('Signed in as')
      .setDesc(`${settings.username} (${settings.userRole})`)
      .addButton((btn) =>
        btn.setButtonText(LABELS.signOut).setDestructive().onClick(async () => {
          await this.doLogout();
        })
      );

    // Shared Folders section
    this.displaySharedFolders(containerEl, this.plugin.servers()[0]);

    this.displayCollaboration(containerEl);
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
        btn.setButtonText('Sign out').setDestructive().onClick(async () => {
          await this.plugin.signOutCloud('Signed out');
          this.update();
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
            if (await this.setCloudPassphrase()) this.update();
          }),
        );
    }

  }

  /**
   * One line that answers "is this working?" before anything else on the pane:
   * the connection in words, and how many folders this vault syncs.
   */
  private displayStatusLine(containerEl: HTMLElement): void {
    const folders = this.plugin.settings.folderMappings.length;
    const locked = this.plugin.settings.folderMappings.filter((m) => !this.plugin.folderCrypto.hasKeys(m.sharedFolderId)).length;
    const shown = this.plugin.shownConnection();
    const parts = [CONNECTION_LABELS[shown], foldersSyncingLine(folders, locked)];
    const row = new Setting(containerEl).setName('Status').setDesc(parts.join(' · '));
    if (locked || PROBLEM_CONNECTIONS.has(shown)) row.descEl.addClass('mod-warning');
  }

  /** The first-run checklist: what is done, what is next. */
  getStartedSteps(): { show: boolean; steps: Array<{ done: boolean; name: string; desc: string; action?: { label: string; run: () => void } }> } {
    const { settings } = this.plugin;
    const steps = [
      {
        done: !!settings.keyMaterial?.publicKey,
        name: 'Choose your encryption passphrase',
        desc: 'It encrypts everything you share, and never leaves this device.',
        action: { label: 'Set passphrase', run: () => void this.setCloudPassphrase().then((ok) => ok && this.update()) },
      },
      {
        done: settings.memberships.length > 0,
        name: 'Have an organisation',
        desc: 'Somewhere to share from. Accept an invitation above, or create one of your own.',
      },
      {
        done: settings.folderMappings.length > 0,
        name: 'Share a folder, or add one shared with you',
        desc: 'Right-click any folder in the file explorer and choose Nectenda: Share folder…',
        action: { label: LABELS.shareAFolder, run: () => void this.plugin.shareFromCommand(null) },
      },
      {
        done: Object.values(settings.knownKeys ?? {}).some((k) => k.comparedAt),
        name: 'Compare a collaborator\'s key (optional)',
        desc: 'Check a fingerprint with them outside Nectenda, then mark it compared. It rules out a server that swaps keys.',
      },
    ];
    const essentialsDone = steps.slice(0, 3).every((s) => s.done);
    return { show: !settings.getStartedDismissed && !essentialsDone, steps };
  }

  private displayGetStarted(containerEl: HTMLElement): void {
    heading(containerEl, LABELS.getStarted).addExtraButton((btn) =>
      btn.setIcon('x').setTooltip('Hide this list').onClick(async () => {
        this.plugin.settings.getStartedDismissed = true;
        await this.plugin.saveSettings();
        this.update();
      }),
    );
    const group = rowGroup(containerEl);
    for (const step of this.getStartedSteps().steps) {
      const row = new Setting(group).setName(`${step.done ? '✓' : '○'} ${step.name}`).setDesc(step.desc);
      if (step.done) row.settingEl.addClass('nectenda-step-done');
      else if (step.action) row.addButton((btn) => btn.setButtonText(step.action!.label).onClick(step.action!.run));
    }
  }

  /**
   * Everything waiting for this person: invitations to accept, and folders
   * already shared with them that this vault has not added. The second used
   * to be a list inside each organisation's page, which nobody arriving from
   * an invitation email would think to open.
   */
  private displaySharedWithYou(containerEl: HTMLElement): void {
    const header = heading(containerEl, LABELS.sharedWithYou);
    header.addButton((btn) =>
      btn.setButtonText('Refresh').onClick(async () => {
        try {
          await this.plugin.refreshMemberships();
          await this.plugin.awaitingFolders?.run();
        } catch (err) {
          new Notice(err instanceof Error ? err.message : 'Could not reach the identity service');
        }
        this.update();
      }),
    );
    const slot = containerEl.createDiv();
    this.slots.invitations = slot;
    this.renderInvitations(slot);
    // The folder half is drawn from the last look and refreshed by a new one,
    // so the pane opens with what is known and corrects itself.
    void this.plugin.awaitingFolders?.run().then(() => {
      if (this.alive() && this.slots.invitations === slot) this.renderInvitations(slot);
    }).catch(() => undefined);
  }

  /** A folder row's value on the home pane: the one thing to know before opening it. */
  private folderSummary(m: FolderMapping): string {
    if (!this.plugin.folderCrypto.hasKeys(m.sharedFolderId)) return LABELS.needsPassphrase;
    // Per folder: only this folder's organisation decides whether it syncs.
    const status = shownConnection(this.plugin.connectionStatus, this.plugin.settings.memberships, [m]);
    if (status === 'connected') return 'Syncing';
    return CONNECTION_LABELS[status];
  }

  /** One folder in this vault: what it is, who is in it, and how to stop. */
  displayFolderPage(c: HTMLElement, m: FolderMapping): void {
    const owner = m.role === 'owner';
    const org = this.plugin.settings.memberships.find((x) => x.id === m.membershipId)?.accountName;
    const hasKeys = this.plugin.folderCrypto.hasKeys(m.sharedFolderId);
    new Setting(c)
      .setName('Status')
      .setDesc([hasKeys ? this.folderSummary(m) : `${LABELS.needsPassphrase} — nothing in this folder syncs until it is unlocked.`, org ? `in ${org}` : null, owner ? 'you are an owner' : 'you can edit'].filter(Boolean).join(' · '));
    if (!hasKeys) {
      new Setting(c).setName('Unlock this folder').setDesc('Enter your passphrase to open its key on this device.').addButton((btn) =>
        btn.setButtonText(LABELS.unlock).setCta().onClick(async () => {
          if (await this.loadFolderKeys(m.sharedFolderId, m.sharedFolderName, m.membershipId ?? null)) {
            this.plugin.refreshSync();
            new Notice(`Unlocked "${m.sharedFolderName}"`);
          }
          this.update();
        }),
      );
    }

    heading(c, LABELS.people);
    if (owner) {
      new Setting(c)
        .setName('Invite someone')
        .setDesc('By email. Someone new gets an invitation and has this folder as soon as they join.')
        .addButton((btn) => btn.setButtonText(LABELS.invite).setCta().onClick(() => this.plugin.inviteToFolder(m)))
        .addButton((btn) => btn.setButtonText(LABELS.showPeople).onClick(() => {
          new FolderMembersModal(this.app, this.plugin.membersDeps(m), m.sharedFolderId, m.sharedFolderName).open();
        }));
    } else {
      // Read-only, but there: an editor compares fingerprints too, and this
      // is where a folder's settings send someone looking for them.
      new Setting(c)
        .setName('People and their keys')
        .setDesc('Only the folder\'s owners can invite or remove people. Compare key fingerprints with them here.')
        .addButton((btn) => btn.setButtonText(LABELS.showPeople).onClick(() => {
          new FolderMembersModal(this.app, this.plugin.membersDeps(m), m.sharedFolderId, m.sharedFolderName).open();
        }));
    }

    heading(c, LABELS.thisDevice);
    new Setting(c)
      .setName('Location')
      .setDesc(m.localPath)
      .addButton((btn) => btn.setButtonText(LABELS.showInExplorer).onClick(() => this.revealInExplorer(m.localPath)));

    heading(c, LABELS.dangerZone);
    new Setting(c)
      .setName(LABELS.stopSyncingHere)
      .setDesc('This vault stops syncing the folder. Your notes stay where they are, and nobody else is affected. You can add it again later.')
      .addButton((btn) => btn.setButtonText(LABELS.stopSyncingHere).setDestructive().onClick(async () => {
        this.plugin.settings.folderMappings = this.plugin.settings.folderMappings.filter((x) => x.sharedFolderId !== m.sharedFolderId);
        await this.plugin.saveSettings();
        this.plugin.refreshSync();
        new Notice(`"${m.sharedFolderName}" no longer syncs in this vault. Your notes are still there.`);
        this.update();
      }));
    if (owner) {
      new Setting(c)
        .setName('Stop sharing for everyone')
        .setDesc('Removes the folder from the server for every member. Everyone keeps their notes as ordinary files.')
        .addButton((btn) => btn.setButtonText(LABELS.stopSharing).setDestructive().onClick(() => {
          const server = this.plugin.serverFor(m.sharedFolderId);
          void this.unshareFolder({ id: m.sharedFolderId, name: m.sharedFolderName }, server, createDiv()).then(() => this.update());
        }));
    }
  }

  /** Select a vault folder in the file explorer, opening the explorer if it is closed. */
  private revealInExplorer(path: string): void {
    const target = this.app.vault.getAbstractFileByPath(path);
    if (!target) {
      new Notice(`"${path}" is not in this vault any more.`);
      return;
    }
    const leaf = this.app.workspace.getLeavesOfType('file-explorer')[0];
    const view = leaf?.view as unknown as { revealInFolder?(f: unknown): void } | undefined;
    if (leaf) void this.app.workspace.revealLeaf(leaf);
    view?.revealInFolder?.(target);
  }

  /** Under the folder list: the two ways a folder gets into this vault. */
  private displayVaultActions(containerEl: HTMLElement): void {
    if (this.plugin.settings.folderMappings.length === 0) {
      noteRow(containerEl, 'Nothing in this vault syncs yet. Share a folder of yours, or add one someone shared with you.');
    }
    new Setting(containerEl)
      .setName('Share a folder')
      .setDesc('Or right-click a folder in the file explorer.')
      .addButton((btn) => btn.setButtonText(LABELS.shareAFolder).setCta().onClick(() => void this.plugin.shareFromCommand(null)));
  }

  /** Which server each organisation lives on: for a support request, not for daily use. */
  private displayServers(containerEl: HTMLElement): void {
    const { memberships } = this.plugin.settings;
    if (!memberships.length) return;
    heading(containerEl, 'Servers');
    const group = rowGroup(containerEl);
    for (const m of memberships) {
      new Setting(group).setName(m.accountName).setDesc(`${m.shardId}${m.region ? ` (${m.region.toUpperCase()})` : ''} — ${m.endpoint}`);
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
        this.update();
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
    const awaiting = this.plugin.awaitingFolders?.report ?? { ready: [], waiting: [] };
    if (invites.length === 0 && awaiting.ready.length === 0 && awaiting.waiting.length === 0) {
      noteRow(slot, 'Nothing waiting. Invitations, and folders people share with you, appear here.');
    }
    if (awaiting.ready.length || awaiting.waiting.length) {
      const folders = rowGroup(slot);
      for (const f of awaiting.ready) {
        const who = f.folder.createdByDisplayName ?? f.folder.createdByUsername ?? 'Someone';
        new Setting(folders)
          .setName(`A folder from ${who}`)
          .setDesc('Shared with you and ready. Adding it never mixes it with a folder of yours: if the name is taken, it goes beside it.')
          .addButton((btn) => btn.setButtonText(LABELS.addToVault).setCta().onClick(async () => {
            await this.addSharedFolder(f.folder, f.membershipId);
            await this.plugin.awaitingFolders?.run();
            this.update();
          }));
      }
      for (const f of awaiting.waiting) {
        const who = f.folder.createdByDisplayName ?? f.folder.createdByUsername ?? 'its owner';
        new Setting(folders)
          .setName(`A folder from ${who}`)
          .setDesc(`Waiting for its key. This finishes by itself the next time ${who} has Obsidian open.`);
      }
    }
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
            this.update();
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
            this.update();
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
  private displaySentInvitations(containerEl: HTMLElement, accountId?: string): void {
    // No nectenda class: it carries no styling of its own and its rows are
    // ordinary Setting rows. Filled in once every organisation has answered.
    const holder = containerEl.createDiv();
    this.slots.sentInvites = holder;
    this.sentInvitesFor = accountId ?? null;
    void this.loadSentInvitations(holder);
  }

  /** The organisation whose page shows sent invitations, or null for all. */
  private sentInvitesFor: string | null = null;

  private async loadSentInvitations(holder: HTMLElement): Promise<void> {
    const generation = this.generations.next('sentInvites');
    // Read at load time, not at display time, so a membership refresh that
    // made this person an owner somewhere new is reflected without a gesture.
    const managed = this.plugin.settings.memberships.filter((m) => (m.role === 'owner' || m.role === 'admin') && (!this.sentInvitesFor || m.accountId === this.sentInvitesFor));
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
      heading(holder, this.sentInvitesFor ? 'Invitations sent' : `Sent from ${m.accountName}`);
      const group = rowGroup(holder);
      for (const { invite, status } of rows) {
        const row = new Setting(group).setName(invite.email).setDesc(sentInviteDescription(invite, status));
        if (invite.mailError) row.descEl.addClass('mod-warning');
        row.addButton((btn) =>
          btn.setButtonText('Revoke').setDestructive().onClick(async () => {
            try {
              await client.revokeInvite(token, m.accountId, invite.id);
              new Notice(`The invitation to ${invite.email} is revoked.`);
            } catch (err) {
              new Notice(err instanceof Error ? err.message : 'Could not revoke');
            }
            this.update();
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
      .setName('Invite to the organisation')
      .setDesc('To bring someone into one folder, invite them from the folder instead. An invitation here goes to one address; the share link lets anyone holding it take a seat.')
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
      );
    const shareLinkRow = containerEl.createDiv();
    this.renderShareLinkRow(shareLinkRow, m, null);
    // Once the page is in the document, not now: a page is drawn before
    // Obsidian attaches it, and loadShareLinkRow takes a detached row for one
    // an action left behind and drops it. Started here, it was never asked,
    // and an owner saw Copy alone with no way to take a link back.
    window.setTimeout(() => void this.loadShareLinkRow(shareLinkRow, m), 0);
    this.displaySentInvitations(containerEl, m.accountId);
  }

  /**
   * Ask the server whether the share link is on, then redraw the row. Until it
   * answers the row offers Copy alone, as it always did: a Turn off or Turn on
   * button before then would be a guess at the state.
   */
  private async loadShareLinkRow(holder: HTMLElement, m: StoredMembership): Promise<void> {
    // An action that finishes after the page redrew holds a detached row.
    // Taking a generation for it would discard the live row's answer.
    if (!holder.isConnected) return;
    const generation = this.generations.next('shareLink');
    let enabled: boolean | null = null;
    try {
      enabled = (await shareLinkFor(m, this.plugin.serverForMembership(m.id), (url, init) => this.apiFetch(url, init))).enabled;
    } catch {
      // Left at "not heard from": Copy still works, and says why if it cannot.
    }
    if (!this.alive() || !this.generations.isCurrent('shareLink', generation)) return;
    this.renderShareLinkRow(holder, m, enabled);
  }

  private renderShareLinkRow(holder: HTMLElement, m: StoredMembership, enabled: boolean | null): void {
    holder.empty();
    const row = new Setting(holder)
      .setName('Share link')
      .setDesc(
        enabled === false
          ? 'Turned off. Nobody can take a seat with it until it is turned on again.'
          : 'Anyone holding the link can take a seat. Replace it if it reached someone it should not have.',
      );
    const server = () => this.plugin.serverForMembership(m.id);
    const fetch = (url: string, init?: RequestInit) => this.apiFetch(url, init);
    for (const action of shareLinkActions(enabled)) {
      if (action === 'copy') {
        row.addButton((btn) => btn.setButtonText('Copy').onClick(() => this.copyShareLink(m)));
      } else if (action === 'replace') {
        row.addButton((btn) =>
          btn.setButtonText('Replace…').onClick(async () => {
            if (!(await this.confirmReplaceShareLink(m.accountName))) return;
            let link: string;
            try {
              link = await replaceShareLink(m, server(), fetch);
            } catch (err) {
              new Notice(err instanceof Error ? err.message : 'Could not replace the share link');
              void this.loadShareLinkRow(holder, m);
              return;
            }
            // Rotating leaves the on/off switch alone, and another admin may
            // have turned the link off since this row was drawn. Copying then
            // would hand out a link that admits nobody, so ask first.
            let stillOn = false;
            try {
              stillOn = (await shareLinkFor(m, server(), fetch)).enabled;
            } catch {
              // Unknown: say the old link is dead, which is certain, and copy nothing.
            }
            if (!stillOn) {
              new Notice('The old share link has stopped working. The link is turned off, so nothing was copied.');
            } else {
              try {
                await navigator.clipboard.writeText(link);
                new Notice('The old share link has stopped working. The new one is copied.');
              } catch {
                // The replace itself succeeded: say so, or the owner may think
                // the old link still works.
                new Notice('The old share link has stopped working. Copying the new one failed; use Copy.');
              }
            }
            void this.loadShareLinkRow(holder, m);
          }),
        );
      } else if (action === 'off') {
        row.addButton((btn) =>
          btn.setButtonText('Turn off…').setDestructive().onClick(async () => {
            if (!(await this.confirmTurnOffShareLink(m.accountName))) return;
            try {
              await setShareLinkEnabled(server(), false, fetch);
              new Notice('The share link is off and has stopped working.');
            } catch (err) {
              new Notice(err instanceof Error ? err.message : 'Could not turn the share link off');
            }
            void this.loadShareLinkRow(holder, m);
          }),
        );
      } else {
        row.addButton((btn) =>
          btn.setButtonText('Turn on').onClick(async () => {
            try {
              await setShareLinkEnabled(server(), true, fetch);
              // Same key as before: say so, since an old copy works again.
              new Notice('The share link is on again. It is the same link as before, so any copy already sent works again.');
            } catch (err) {
              new Notice(err instanceof Error ? err.message : 'Could not turn the share link on');
            }
            void this.loadShareLinkRow(holder, m);
          }),
        );
      }
    }
  }

  /** Its own method so a test can answer it without driving a modal. */
  private confirmReplaceShareLink(organisation: string): Promise<boolean> {
    return new Promise((resolve) => new ConfirmModal(this.app, {
      title: `Replace the share link for ${organisation}?`,
      body:
        'The current link stops working at once, for everyone who has it. People who already joined keep their seats. ' +
        'A new link is copied for you to send.',
      confirm: 'Replace link',
      cancel: 'Cancel',
    }, resolve).open());
  }

  /** Its own method so a test can answer it without driving a modal. */
  private confirmTurnOffShareLink(organisation: string): Promise<boolean> {
    return new Promise((resolve) => new ConfirmModal(this.app, {
      title: `Turn off the share link for ${organisation}?`,
      body:
        'The link stops working at once: nobody can take a seat with it. People who already joined keep their seats. ' +
        'Turning it on again brings back the same link, so if it reached someone it should not have, replace it instead.',
      confirm: 'Turn off',
      cancel: 'Cancel',
    }, resolve).open());
  }

  /** Copy an organisation's share link. The pane's button and the palette command both land here. */
  async copyShareLink(m: StoredMembership): Promise<void> {
    try {
      const result = await shareLinkFor(m, this.plugin.serverForMembership(m.id), (url, init) => this.apiFetch(url, init));
      if (!result.enabled) {
        new Notice('The share link is turned off for this organisation.');
        return;
      }
      await navigator.clipboard.writeText(result.link);
      new Notice('Share link copied. Anyone with it can take a seat, so send it only to people you mean to.');
    } catch (err) {
      new Notice(err instanceof Error ? err.message : 'Could not fetch the share link');
    }
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
          await this.joinWithLink(this.pendingShareLink);
          this.update();
        }),
      );
  }

  /** Join with a pasted link or key. The pane's Join and the palette command both land here. */
  async joinWithLink(raw: string): Promise<void> {
    if (!raw) return;
    let key = raw.trim();
    let endpoint: string | undefined;
    try {
      if (key.startsWith('obsidian://')) {
        const u = new URL(key);
        key = u.searchParams.get('key') ?? '';
        endpoint = u.searchParams.get('endpoint') ?? undefined;
      }
      if (!this.plugin.settings.keyMaterial?.publicKey && !(await this.setCloudPassphrase())) return;
      const joined = await this.plugin.joinByShareKey(key, endpoint);
      new Notice(`You have joined ${joined.accountName}.`);
    } catch (err) {
      new Notice(`Could not join: ${err instanceof Error ? err.message : String(err)}`);
    }
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
          btn.setButtonText('Sign out').setDestructive().onClick(async () => {
            log.info("Ending another vault's session", { sessionId: s.id, label: s.label ?? null });
            try {
              await this.plugin.identityClient().revokeSession(this.plugin.settings.identityAccessToken, s.id);
              new Notice('That vault will have to sign in again.');
            } catch (err) {
              new Notice(err instanceof Error ? err.message : 'Could not revoke');
            }
            this.update();
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
            btn.setButtonText('Remove').setDestructive().onClick(async () => {
              try {
                await this.plugin.identityClient().deletePasskey(this.plugin.settings.identityAccessToken, pk.credentialId);
              } catch (err) {
                new Notice(err instanceof Error ? err.message : 'Could not remove');
              }
              this.update();
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
    heading(section, this.plugin.settings.mode === 'cloud' ? 'Plan, storage and devices' : 'Account');
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
            new ManageStorageModal(this.app, {
              mappings: () => this.plugin.settings.folderMappings,
              stored: (id) => this.plugin.storedAttachments(id),
              remove: (id, relativePath) => this.plugin.deleteAttachment(id, relativePath),
            }, () => this.update()).open();
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
        this.displayBilling(into, server, data.account.id);
      }
    });

    redraw('members', [data.users, server.role, server.localUserId], (into) => {
      this.displayMembers(into, server, data.users ?? []);
    });

    redraw('attachments', [
      this.plugin.settings.pendingBlobUploads,
      this.plugin.settings.oversizedAttachments,
      // What is on disk, not the record: a listed note deleted or resized
      // changes nothing in the record until this reads it.
      this.plugin.oversizedNotes.listStillOversized((f, p) => this.plugin.noteSize(f, p)),
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
      heading(into, 'Devices');
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
          .setDesc('It holds none of this organisation\'s device slots, so it is not syncing here. Adding it takes a slot.')
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
              this.update();
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
          btn.setButtonText('Remove').setDestructive().onClick(async () => {
            if (d.thisDevice && !(await this.confirmRemoveDevice(server.label))) return;
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
            this.update();
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
  /**
   * Buying and cancelling, from inside the product.
   *
   * Cancelling has to be possible here rather than only on a web page: it is
   * what our merchant of record requires, and it is the difference between
   * leaving a subscription and asking permission to leave one.
   *
   * Both buttons do the same thing — ask the identity service for a URL and
   * open it in the system browser, exactly as signing in already does. The
   * plugin never sees a card and never renders a payment form; there is no
   * webview here and no third-party script, which is the same boundary the
   * rest of the product keeps.
   *
   * Drawn only in cloud mode. A self-hosted server sells nothing, has no
   * merchant of record, and would answer these routes with a 404.
   */
  private displayBilling(
    into: HTMLElement,
    server: ReturnType<NectendaPlugin['servers']>[number],
    accountId: string,
  ): void {
    if (this.plugin.settings.mode !== 'cloud' || !this.plugin.settings.identity) return;

    const open = async (
      what: 'checkout' | 'portal',
      choice?: { planId: string; term: 'month' | 'year'; seats: number },
    ): Promise<void> => {
      const client = this.plugin.identityClient();
      const token = this.plugin.settings.identityAccessToken;
      try {
        const { url } =
          what === 'portal'
            ? await client.billingPortal(token, accountId)
            // Never a default plan. Until 19 September 2026 this sent everyone
            // to Personal, monthly, one seat, whatever they had chosen — the
            // picker is what makes the other five buyable.
            : await client.checkout(token, { accountId, ...choice! });
        // The system browser, never a webview. A payment page rendered inside
        // Obsidian would be indistinguishable from one a malicious plugin drew.
        window.open(url);
      } catch (err) {
        // Deliberately specific. "Something went wrong" on a payment screen is
        // the point at which somebody stops trusting the product.
        //
        // **On the code before the status.** Two different facts used to share
        // a 404 and therefore shared a sentence: "we have not heard of this
        // organisation yet" and "this organisation has never been paid for".
        // The first is what a brand-new organisation gets for up to a minute,
        // and it was being told it had no subscription to manage — on the
        // button whose entire purpose is to create the first one.
        const code = err instanceof IdentityError ? err.code : undefined;
        const message =
          code === 'UNKNOWN_ACCOUNT'
            ? 'This organisation was only just created and is still being registered. Try again in a few seconds.'
            : code === 'NO_SUBSCRIPTION'
              ? 'This organisation has no subscription to manage yet.'
              : err instanceof IdentityError && err.status === 403
                ? 'Only the owner of an organisation can change its plan.'
                : err instanceof IdentityError && err.status === 404
                  ? 'This organisation has no subscription to manage yet.'
                  : err instanceof IdentityError && err.status === 503
                    ? 'This server is not selling subscriptions.'
                    : err instanceof Error
                      ? err.message
                      : 'That could not be opened.';
        new Notice(message, 8000);
      }
    };

    const row = new Setting(into)
      .setName('Subscription')
      .setDesc(
        server.role === 'owner'
          ? 'Change plan, update your payment method, see invoices, or cancel. Opens in your browser.'
          : 'Only the owner of this organisation can change its plan.',
      );

    row.addButton((b) =>
      b
        .setButtonText('Change plan')
        // Enabled for any owner, and deliberately not gated on the summary
        // below: its job is to create a *first* subscription, so requiring one
        // to exist would make the button useless exactly when it is needed.
        .setDisabled(server.role !== 'owner')
        .onClick(() => {
          new PlanPickerModal(
            this.app,
            async () => (await this.plugin.identityClient().billingPlans(this.plugin.settings.identityAccessToken)).plans,
            (choice) => void open('checkout', choice),
          ).open();
        }),
    );

    // Starts disabled and is enabled only if the service says a portal can be
    // opened. The alternative — enabling it from the local role, as this used
    // to — is the same mistake the checkout button made: the plugin knows what
    // the *shard* said and asserts it about a service that may not have heard
    // of the organisation, let alone hold a customer for it.
    let manage: { setDisabled(v: boolean): unknown } | null = null;
    row.addButton((b) => {
      manage = b.setButtonText('Manage subscription').setDisabled(true).onClick(() => void open('portal'));
    });

    /**
     * What this organisation is actually on, from our own rows.
     *
     * Read from the identity service rather than from the shard, because only
     * it knows the subscription: the term, when it renews, whether a
     * cancellation is already scheduled, and whether a portal can be opened at
     * all. The shard knows the plan and nothing about the money.
     *
     * `billingSummary` was written, tested and then called by nothing at all
     * until 19 September 2026 — which is why none of this was on screen.
     *
     * Failure is silent on purpose. This decorates a row that already works;
     * an organisation the service has not pulled yet is simply absent from the
     * answer, and that is a normal few seconds after creating one rather than
     * a fault worth a notice.
     */
    void this.plugin.identityClient()
      .billingSummary(this.plugin.settings.identityAccessToken)
      .then((summary) => {
        const org = summary.organisations.find((o) => o.accountId === accountId);
        if (!org) return;
        manage?.setDisabled(!org.canManage);
        const parts: string[] = [];
        if (org.term) parts.push(org.term === 'year' ? 'billed yearly' : 'billed monthly');
        if (org.seats) parts.push(`${org.seats} seat${org.seats === 1 ? '' : 's'}`);
        // Whichever date is the live one. A scheduled ending outranks a
        // renewal, because it is the one that changes what they get.
        if (org.endingAt) parts.push(`ends ${new Date(org.endingAt * 1000).toLocaleDateString()}`);
        else if (org.graceUntil) parts.push(`payment failed — update it by ${new Date(org.graceUntil * 1000).toLocaleDateString()}`);
        else if (org.renewsAt) parts.push(`renews ${new Date(org.renewsAt * 1000).toLocaleDateString()}`);
        if (parts.length) row.setDesc(`${parts.join(' · ')}. Opens in your browser.`);
      })
      .catch(() => undefined);
  }

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
    heading(section, LABELS.people);
    const roleLabel: Record<string, string> = { owner: 'owner', admin: 'admin', member: 'member' };
    const refresh = (): void => this.update();
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
          btn.setButtonText('Remove').setDestructive().onClick(async () => {
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

    heading(containerEl, `Waiting for space (${pending.length})`);
    const waiting = createFragment();
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
    // Read from disk each time, which also drops notes since trimmed or gone.
    const largeNotes = this.plugin.oversizedNotes.listStillOversized(
      (folderId, path) => this.plugin.noteSize(folderId, path),
    );
    if (stranded.length === 0 && !misconfigured && oversizedCount === 0 && largeNotes.length === 0) return;

    // "Files", not "Attachments": notes too large to sync are listed here too.
    heading(containerEl, 'Files that will not sync');

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
            this.update();
          }),
        );
    }

    // Too large for the account, as opposed to merely in the wrong place.
    // Nothing the user does to the folder layout will fix these.
    // Both lists are files with a problem, so they share one box. The row
    // above is a setting to change, not a file, and stays outside it.
    const problems = rowGroup(containerEl);

    // No "Try again" here, unlike an attachment: a held note retries by itself
    // on its next edit (SAFE-A11), so the button would have nothing to do.
    for (const note of largeNotes) {
      const mapping = this.plugin.settings.folderMappings.find((m) => m.sharedFolderId === note.sharedFolderId);
      if (!mapping) continue;
      const path = `${mapping.localPath}/${note.relativePath}`;
      new Setting(problems)
        .setName(path)
        .setDesc(
          `A note of ${mib(note.bytes)}, over the ${mib(MAX_PUSH_BYTES)} limit for a note, so it `
            + 'does not sync. It stays on this device. Split it or remove the large part, '
            + 'and it syncs by itself.',
        )
        .addButton((b) =>
          b.setButtonText('Open').onClick(() => {
            void this.app.workspace.openLinkText(path, '', false);
          }),
        );
    }

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
            this.update();
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
            this.update();
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

    heading(containerEl, 'Not downloaded on this device');
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
            this.update();
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
    heading(containerEl, LABELS.sharedFolders);

    const foldersContainer = createDiv('nectenda-surface nectenda-folders');
    new Setting(containerEl)
      .setName('Share a folder')
      .setDesc(
        this.plugin.settings.mode === 'cloud'
          ? 'Choose a vault folder to share with this organisation. You can also right-click a folder.'
          : 'Choose a vault folder to share with all users on this server. You can also right-click a folder.',
      )
      .addButton((btn) =>
        btn.setButtonText(LABELS.shareAFolder).setCta().onClick(() => {
          new FolderPickerModal(this.app, (folder) => {
            void this.shareFolder(folder.path, folder.name, server, foldersContainer)
              .catch((err: unknown) => {
                log.warn('Could not share the folder', { error: String(err) });
              });
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
    heading(containerEl, 'Folders needing attention');
    noteRow(containerEl, 'These folders were added before this vault recorded which organisation each belongs to, and it now belongs to several. They still sync; stop syncing one here, then share or add it again from its organisation\'s page.');
    const group = rowGroup(containerEl);
    for (const m of unclaimedMappings(this.plugin.settings.folderMappings, this.plugin.settings.memberships.length)) {
      new Setting(group)
        .setName(m.sharedFolderName)
        .setDesc(`Local: ${m.localPath}`)
        .addButton((btn) =>
          btn.setButtonText(LABELS.stopSyncingHere).setDestructive().onClick(async () => {
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
            btn.setButtonText(LABELS.showNames).setCta().onClick(async () => {
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
        noteRow(container, 'Nothing shared here yet. Share a folder from this vault, or ask someone to invite you to theirs.');
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
            this.update();
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
        heading(container, LABELS.needsPassphrase);
        const lockedGroup = rowGroup(container);
        for (const locked of keyless) {
          const folder = folders.find((f) => f.id === locked.sharedFolderId)!;
          new Setting(lockedGroup)
            .setName(locked.sharedFolderName)
            .setDesc(
              `${locked.localPath} — this device has no key for this folder yet, so nothing syncs. ` +
                'Unlock it with your passphrase, or stop syncing it here.',
            )
            .addButton((btn) =>
              btn
                .setButtonText(LABELS.unlock)
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
              btn.setButtonText(LABELS.stopSyncingHere).setDestructive().onClick(async () => {
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
        heading(container, LABELS.noLongerShared);
        const orphanGroup = rowGroup(container);
        for (const orphan of orphans) {
          new Setting(orphanGroup)
            .setName(orphan.sharedFolderName)
            .setDesc(
              `${orphan.localPath} — this folder is no longer on the server: its owner unshared it, ` +
                'or it was deleted. Your notes are untouched; this only stops Nectenda looking for it.',
            )
            .addButton((btn) =>
              btn
                .setButtonText(LABELS.stopSyncingHere)
                .setDestructive()
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
        heading(container, LABELS.inThisVault);
        const mappedGroup = rowGroup(container);
        for (const folder of mapped) {
          const mapping = mappings.find((m) => m.sharedFolderId === folder.id)!;
          const roleLabel = folder.role === 'owner' ? ' \u2014 owner' : '';
          const setting = new Setting(mappedGroup)
            .setName(label(folder))
            .setDesc(`Local: ${mapping.localPath} \u2014 ${describe(folder).join(' \u00b7 ')}${roleLabel}`);
          // Invite is on the folder's own page and its menu; four buttons here
          // squeezed the description into a column one word wide. People is
          // on every row: an editor compares fingerprints too.
          setting.addButton((btn) =>
            btn.setButtonText(LABELS.showPeople).onClick(() => {
              new FolderMembersModal(this.app, this.plugin.membersDeps(mapping), folder.id, folder.name).open();
            }),
          );
          if (mayUnshare(folder, server)) {
            setting.addButton((btn) =>
              btn.setButtonText(LABELS.stopSharing).setDestructive().onClick(() => {
                void this.unshareFolder(folder, server, container);
              }),
            );
          }
          setting
            .addButton((btn) =>
              btn.setButtonText(LABELS.stopSyncingHere).onClick(async () => {
                this.plugin.settings.folderMappings = this.plugin.settings.folderMappings.filter((m) => m.sharedFolderId !== folder.id);
                await this.plugin.saveSettings();
                this.plugin.refreshSync();
                await this.loadSharedFolders(container, server);
              })
            );
        }
      }

      if (unmapped.length > 0) {
        heading(container, LABELS.availableToAdd);
        const unmappedGroup = rowGroup(container);
        for (const folder of unmapped) {
          const row = new Setting(unmappedGroup)
            .setName(label(folder))
            .setDesc(describe(folder).join(' \u00b7 '))
            .addButton((btn) =>
              btn.setButtonText(LABELS.addToVault).setCta().onClick(async () => {
                await this.quickMapFolder(folder, container);
              })
            )
            .addButton((btn) =>
              btn.setButtonText(LABELS.chooseLocation).onClick(() => {
                new FolderPickerModal(this.app, (localFolder) => {
                  void (async () => {
                    if (pathState(localFolder) === 'occupied'
                      && !(await this.confirmAdopt(localFolder.path))) return;
                    await this.mapFolder(folder, localFolder.path, container);
                  })().catch((err: unknown) => {
                    log.warn('Could not map the folder', { error: String(err) });
                  });
                }).open();
              })
            );
          if (mayUnshare(folder, server)) {
            row.addButton((btn) =>
              btn.setButtonText(LABELS.stopSharing).setDestructive().onClick(() => {
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

  /**
   * Paths with a share or a map under way. Either adds its mapping only after
   * a round trip (the server for a share, the key unwrap for a map), so the
   * covering check alone lets a second one onto the same path while the first
   * is in flight — two mappings for one vault folder, the replacement it
   * exists to stop. The pane's picker, the palette and the folder menu can
   * each start a share, and the pane's folder list can start a map.
   */
  private sharing = new Set<string>();

  /** The in-flight path overlapping `path`, if any; otherwise claims it and returns undefined. */
  private claimPath(path: string): string | undefined {
    const inFlight = [...this.sharing].find((p) => mappingCovering(path, [{ sharedFolderId: '', sharedFolderName: '', localPath: p }]));
    if (inFlight !== undefined) {
      new Notice(`"${inFlight}" is being shared or mapped already. Wait for that to finish.`);
      return inFlight;
    }
    this.sharing.add(path);
    return undefined;
  }

  async shareFolder(path: string, name: string, server: FolderServer, container: HTMLElement | null = null): Promise<void> {
    // A vault folder belongs to one organisation. Sharing a path that is
    // mapped already — here or anywhere else — used to replace the earlier
    // mapping without a word; it is refused, naming what is in the way.
    const covering = mappingCovering(path, this.plugin.settings.folderMappings);
    if (covering) {
      new Notice(this.alreadySharedMessage(path, covering));
      return;
    }
    if (this.claimPath(path) !== undefined) return;
    try {
      await this.doShareFolder(path, name, server, container);
    } finally {
      this.sharing.delete(path);
    }
  }

  private async doShareFolder(path: string, name: string, server: FolderServer, container: HTMLElement | null): Promise<void> {
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

      new Notice(`Folder "${name}" is shared. Invite someone with a right-click on it.`);
      // Redraw the list in place: a rebuild of the pane would close the page.
      // A share from the palette or the folder menu passes no container, but
      // settings open in a window of their own on 1.13, so the organisation's
      // page may be on screen beside it; its list is redrawn where it is.
      const list = container ?? this.folderSlots.get(server.base)?.el ?? null;
      if (list) await this.loadSharedFolders(list, server);
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

  /**
   * Add a folder shared with this person to the vault, from outside the pane
   * — the "shared a folder with you" notice. Same path as the pane's own
   * button, into a location that holds no notes already.
   */
  async addSharedFolder(folder: SharedFolderInfo & { role?: FolderRole }, membershipId: string | null): Promise<void> {
    await this.quickMapFolder({ ...folder, membershipId }, createDiv());
    this.plugin.refreshSettingsPane();
  }

  /** Its own method so a test can answer it without driving a modal. */
  private confirmAdopt(path: string): Promise<boolean> {
    return new Promise((resolve) => new ConfirmModal(this.app, {
      title: `Add into "${path}"?`,
      body:
        `"${path}" already has notes in it. They will be uploaded to everyone in the shared folder, ` +
        'and where a note of the same name differs, your copy is kept in .nectenda-backups/. ' +
        'To keep them private, choose an empty folder instead.',
      confirm: 'Add and share these notes',
      cancel: 'Choose another folder',
    }, resolve).open());
  }

  /** Its own method so a test can answer it without driving a modal. */
  private confirmUnshare(name: string, others: number | null): Promise<boolean> {
    return new Promise((resolve) => new UnshareFolderModal(this.app, name, others, resolve).open());
  }

  /** Its own method so a test can answer it without driving a modal. */
  private confirmRemoveDevice(organisation: string): Promise<boolean> {
    return new Promise((resolve) => new RemoveDeviceModal(this.app, organisation, resolve).open());
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
          'Try again and enter your passphrase, or ask an owner to share it with you.',
      );
      return;
    }

    const name = await openFolderName(this.plugin.folderCrypto.get(folder.id), folder)
      ?? folder.name;
    // Never into a folder that already holds notes: those would be uploaded to
    // everyone in the shared folder. See add-location.ts.
    const vaultRef = this.plugin.app.vault;
    const localPath = defaultAddLocation(name, (p) => pathState(vaultRef.getAbstractFileByPath(p) as { children?: unknown[] } | null));
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
    return this.keys.ownPublicKey();
  }

  private async publishKeys(
    folderId: string,
    keys: Omit<FolderKeyRecord, 'folderId'>[],
    server?: { base: string; token: string },
  ): Promise<void> {
    return this.keys.publish(folderId, keys, server);
  }

  /** The identity keypair, asking for the password if this session has none. */
  async ensureIdentity(reason: string): Promise<CryptoKeyPair | null> {
    return this.identity.ensure(reason);
  }

  /** One attempt at the passphrase, as an outcome rather than an exception. */
  private async verifyPassphrase(
    password: string,
    keyMaterial: KeyMaterial & { kdfParams?: KdfParams | null },
    selfHostedParams: KdfParams | null,
  ): Promise<VerifyOutcome> {
    return this.identity.verify(password, keyMaterial, selfHostedParams);
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
    return this.keys.load(folderId, folderName, membershipId);
  }

  /** As above, with an identity already in hand. Never prompts. */
  private async fetchFolderKeys(folderId: string, identity: CryptoKeyPair, server: { base: string; token: string }): Promise<boolean> {
    return this.keys.fetch(folderId, identity, server);
  }

  /** Open what this device has no key for yet. Safe to call from a render. */
  private async openEnvelopes(folders: Array<{ id: string }>, server: FolderServer): Promise<void> {
    return this.keys.openEnvelopes(folders, server);
  }

  private async mapFolder(
    folder: SharedFolderInfo & { role?: FolderRole; membershipId?: string | null },
    localPath: string,
    container: HTMLElement,
  ): Promise<void> {
    if (this.claimPath(localPath) !== undefined) return;
    try {
      await this.doMapFolder(folder, localPath, container);
    } finally {
      this.sharing.delete(localPath);
    }
  }

  private async doMapFolder(
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
          'Try again and enter your passphrase, or ask an owner to share the folder with you.',
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

  /**
   * A pending reset, at the top of the pane, keys or no keys: a device that is
   * signed in is exactly what can cancel one somebody else asked for, so it
   * must not be tucked under a page a worried person would not open
   * (start-over.ts).
   */
  private displayPendingRelease(containerEl: HTMLElement): void {
    const pending = this.plugin.settings.pendingRelease;
    if (!pending) return;
    const { title, detail } = pendingReleaseText(pending);
    new Setting(containerEl)
      .setName(title)
      .setDesc(detail)
      .addButton((btn) =>
        btn.setButtonText('Cancel reset').setCta().onClick(async () => {
          btn.setDisabled(true);
          try {
            await this.plugin.cancelStartOver();
          } catch (err) {
            new Notice(`Nectenda: could not cancel the reset. ${err instanceof Error ? err.message : String(err)}`);
          }
          this.update();
        }),
      );
  }

  private displayEncryption(containerEl: HTMLElement): void {
    const publicKey = this.plugin.settings.keyMaterial?.publicKey;
    if (!publicKey) return;

    heading(containerEl, 'Encryption');
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
    const pendingRelease = this.plugin.settings.pendingRelease;
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
            this.update();
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
      // For when the recovery key is gone too. Last, and not a call to action:
      // it gives up everything the other two buttons keep.
      if (!pendingRelease) {
        new Setting(containerEl)
          .setName('Lost both the passphrase and the recovery key?')
          .setDesc('Nobody can decrypt what they protected, including us. You can start over with a new, empty account for this address.')
          .addButton((btn) =>
            btn.setButtonText('Start over').setDestructive().onClick(() => {
              const email = this.plugin.settings.identity?.email;
              if (!email) return;
              new StartOverModal(this.app, email, (confirmed) => {
                if (!confirmed) return;
                void this.plugin
                  .requestStartOver()
                  .catch((err: unknown) => new Notice(`Nectenda: could not start over. ${err instanceof Error ? err.message : String(err)}`))
                  .then(() => this.update());
              }).open();
            }),
          );
      }
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

  /**
   * The two pointer switches. Separate on purpose, because they answer
   * different questions: the first is privacy (may others see where my mouse
   * is?), the second is noise (do I want to see theirs?). Turning off one says
   * nothing about the other.
   */
  private displayCollaboration(containerEl: HTMLElement): void {
    heading(containerEl, 'Collaboration');

    new Setting(containerEl)
      .setName('Share my mouse pointer')
      .setDesc(
        'Let people with the same note open see where your mouse is, with your name beside it. ' +
          'It is encrypted like your cursor, so the server cannot read it. ' +
          'Turn this off to keep your pointer to yourself.',
      )
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.sharePointer).onChange(async (value) => {
          await this.plugin.setSharePointer(value);
        }),
      );

    new Setting(containerEl)
      .setName("Show collaborators' mouse pointers")
      .setDesc(
        "Draw where other people's mice are in the note you have open. " +
          'Turning this off only hides them on this device; it does not stop yours being shared.',
      )
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.showPointers).onChange(async (value) => {
          await this.plugin.setShowPointers(value);
        }),
      );

    new Setting(containerEl)
      .setName('Live sync for Excalidraw drawings')
      .setDesc(
        'Show changes to an open drawing in the other vaults as they are made, with collaborators’ pointers and selections drawn on it. ' +
          'Turn this off if live drawing misbehaves: drawings are then merged when they are saved instead, a few seconds behind, ' +
          'and edits made in two places at once are still kept.',
      )
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.liveExcalidraw).onChange(async (value) => {
          await this.plugin.setLiveExcalidraw(value);
        }),
      );

    new Setting(containerEl)
      .setName('Live sync for Kanban boards')
      .setDesc(
        'Save an open board moments after each change, so a moved card shows in the other vaults within a second, and show which card each collaborator is on. ' +
          'Turn this off if a board misbehaves: it then saves on Obsidian’s usual two-second pace and is merged when it is saved. ' +
          'Who is on the board still shows in its header.',
      )
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.liveKanban).onChange(async (value) => {
          await this.plugin.setLiveKanban(value);
        }),
      );

    new Setting(containerEl)
      .setName('Show sync status in the file explorer')
      .setDesc(
        'Mark each note in a shared folder with whether the server has every change from this device. ' +
          'Hover a mark to see what it means. The same mark shows which entries of a shared base are shared.',
      )
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.fileStatusIcons).onChange(async (value) => {
          this.plugin.settings.fileStatusIcons = value;
          await this.plugin.saveSettings();
          this.plugin.fileStatus?.apply();
          this.plugin.redrawBasesShared();
        }),
      );

    // Where the Nectenda status icon shows. The same icon and menu in each;
    // at least one stays on, or the state would have nowhere to be seen.
    heading(containerEl, 'Nectenda status');
    const places: Array<[keyof StatusPlaces, string, string]> = [
      ['header', 'In each note\'s header', 'The icon at the top of every open note, describing that note.'],
      ['ribbon', 'In the ribbon', 'The Nectenda logo in the ribbon, describing the note you are in — or the connection when none is open.'],
      ['statusBar', 'In the status bar', 'The same icon at the bottom of the window.'],
    ];
    const available: StatusPlaces = { header: true, ribbon: true, statusBar: !Platform.isMobile };
    for (const [key, name, desc] of places) {
      if (!available[key]) continue;
      new Setting(containerEl).setName(name).setDesc(desc).addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.statusIn[key]).onChange(async (value) => {
          if (!value && !mayHide(this.plugin.settings.statusIn, key, available)) {
            new Notice('Nectenda: keep the status in at least one place.');
            toggle.setValue(true);
            return;
          }
          this.plugin.settings.statusIn = { ...this.plugin.settings.statusIn, [key]: value };
          await this.plugin.saveSettings();
          this.plugin.headerStatus?.apply();
        }),
      );
    }
  }

  private displayTroubleshooting(containerEl: HTMLElement): void {
    heading(containerEl, 'Troubleshooting');

    new Setting(containerEl)
      .setName('Diagnostic log')
      .setDesc(
        'Write a detailed log to the plugin folder, for reporting a sync problem. ' +
          'It records which files sync and which fail, including their paths, so keep it off ' +
          'unless you are chasing something. Capped at 5 MB and never sent anywhere on its own.',
      )
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.diagnosticLog).onChange((value) => this.plugin.setDiagnosticLog(value)),
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
    heading(containerEl, 'Admin');

    new Setting(containerEl)
      .setName('Invite tokens')
      .setDesc('Generate a token to invite a new user')
      .addButton((btn) =>
        btn.setButtonText('Generate Invite').setCta().onClick(async () => {
          await this.generateInvite();
        })
      );

    const adminContent = containerEl.createDiv('nectenda-surface nectenda-admin-content');
    void this.loadAdminData(adminContent).catch((err: unknown) => {
      log.warn('Could not load the admin section', { error: String(err) });
    });
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
          heading(container, 'Active invite tokens');
          const tokenGroup = rowGroup(container);
          for (const invite of unused) {
            new Setting(tokenGroup)
              .setName(invite.token)
              .setDesc(`Created ${new Date(invite.createdAt * 1000).toLocaleDateString()}`)
              .addButton((btn) =>
                btn.setButtonText('Copy').onClick(() => {
                  void navigator.clipboard.writeText(invite.token).then(
                    () => new Notice('Invite token copied to clipboard'),
                    () => new Notice('Could not copy the invite token'),
                  );
                })
              );
          }
        }
      }

      if (usersRes.ok) {
        const { users } = await usersRes.json() as { users: UserInfo[] };
        heading(container, 'Users');
        const userGroup = rowGroup(container);
        for (const user of users) {
          const setting = new Setting(userGroup)
            .setName(`${user.username} (${user.role})`)
            .setDesc(user.email);

          if (user.role !== 'admin') {
            setting.addButton((btn) =>
              btn.setButtonText('Remove').setDestructive().onClick(async () => {
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

  /**
   * The self-hosted server address, or null once it has said so.
   *
   * `serverUrl` defaults to empty rather than to a localhost address, so for
   * the first time it can genuinely be unset when one of these three runs.
   * Without this the address reaches `apiBaseUrl('')` and the failure surfaces
   * as "Login failed: Could not connect" — which names the wrong problem and
   * sends the reader looking at their server.
   */
  private serverAddress(): string | null {
    const url = this.plugin.settings.serverUrl.trim();
    if (!url) {
      new Notice('Enter the address of your server first');
      return null;
    }
    return url;
  }

  private async doLogin(username: string, password: string): Promise<void> {
    if (!username || !password) {
      new Notice('Username and password required');
      return;
    }
    if (!this.serverAddress()) return;

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
      new Notice(`Sign-in failed: ${err instanceof Error ? err.message : 'Could not connect'}`);
    }
  }

  /** Persist a new session and start syncing. */
  private async applySession(result: SessionResult): Promise<void> {
    this.plugin.settings.token = result.token;
    // A real sign-in: every folder shared with this person from here on is
    // worth offering. Only a vault that was signed in before offers existed
    // starts from null, and treats its first look as what was already there.
    this.plugin.settings.offeredFolders ??= [];
    this.plugin.welcomeNotice?.hide();
    this.plugin.welcomeNotice = null;
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
      new Notice(`Signed in as ${result.user.username}`);
    }
    this.update();
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
    if (!this.serverAddress()) return;

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
    if (!this.serverAddress()) return;
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
    this.plugin.settings.offeredFolders = null;
    this.plugin.settings.errorReportDsn = '';
    this.plugin.sessionKeys = null;
    await this.plugin.saveSettings();
    this.plugin.refreshSettingsPane();

    new Notice('Signed out');
    this.update();
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
      this.update();
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


