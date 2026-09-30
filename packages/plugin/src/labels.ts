/**
 * The words the settings pane uses for things, in one place.
 *
 * One word per thing, everywhere. The pane had drifted: "Sign in" and "Login",
 * "passphrase" and "password" for the same secret, "Quick Map" and "Unmap"
 * for actions nobody outside this codebase would name that way, Title Case
 * beside sentence case. The user guides quote these labels in bold, and a test
 * holds the guides to this file, so a label renamed here without the guide
 * following fails rather than leaving a guide that points at a button that is
 * no longer there.
 *
 * Sentence case throughout, as Obsidian's own settings are.
 */
export const LABELS = {
  // Headings on the home pane.
  sharedWithYou: 'Shared with you',
  thisVault: 'This vault',
  organisations: 'Organisations',
  account: 'Account',
  more: 'More',
  getStarted: 'Get started',

  // Pages.
  security: 'Security',
  editing: 'Editing',
  advanced: 'Advanced',

  // A folder's list and page.
  inThisVault: 'In this vault',
  availableToAdd: 'Available to add',
  needsPassphrase: 'Needs your passphrase',
  noLongerShared: 'No longer shared',
  sharedFolders: 'Shared folders',
  people: 'People',
  thisDevice: 'This device',
  dangerZone: 'Danger zone',

  // Buttons.
  shareAFolder: 'Share a folder…',
  addToVault: 'Add to vault',
  chooseLocation: 'Choose location…',
  stopSyncingHere: 'Stop syncing here',
  stopSharing: 'Stop sharing for everyone…',
  invite: 'Invite…',
  showPeople: 'People…',
  unlock: 'Unlock',
  showNames: 'Show names',
  signIn: 'Sign in',
  signOut: 'Sign out',
  showInExplorer: 'Show in file explorer',
  openFolderSettings: 'Open',
} as const;

export type Label = (typeof LABELS)[keyof typeof LABELS];
