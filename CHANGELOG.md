# Changelog

Every release of the Nectenda plugin, newest first. Each release on GitHub also
carries the SHA-256 of its `main.js`, so you can check that the plugin you are
running is the source you read — see the README.

## 0.2.0 — 25 September 2026

### Added
- Presence — collaborators' names, colours and cursor positions — is now end-to-end encrypted. Until now it travelled in the clear, so the server could see where in a note each person was working; it no longer can.
- Collaborators' mouse pointers now show in the note you share, labelled with their name. When someone is off-screen, an indicator at the edge of the view points to them and to their cursor. Two new settings let you stop sharing yours, or hide theirs.
- Every note in a shared folder now shows whether the server has all of your changes: a Nectenda icon at the top right of the note, carrying connection state, a count of who else is there and quick settings; marks in the file explorer; and a sync-state inspector that compares the note on disk with the synced document. **This replaces the status bar item, which is gone** — Obsidian on a phone has no status bar, so the status now lives where a phone can show it.
- Command-palette commands, a ribbon icon, and right-click actions on folders for sharing and managing members.
- A warning when a note in a shared folder is too large to sync, when it arrives rather than after you have typed into it, and a list of such notes in settings.
- The plugin's repository now carries a CHANGELOG.md, and each GitHub release lists what changed in that version.

### Fixed
- **An edit could be lost permanently.** If a change was sent in the moment a folder was still catching up, the plugin could record a sync position that skipped it, save that position, and never ask for the change again — so it was gone, with no warning and nothing to restore from. This is the most serious fix in this release, and it affects every version up to 0.1.5.
- **Two vaults opening the same not-yet-synced note could duplicate every note in the folder.** Both vaults filled the note from disk independently, and the two copies were combined rather than recognised as the same text. Both devices then agreed on the doubled version. Most likely with the server unreachable, and possible without it.
- Changes the server silently dropped are now sent again after a reconnect, and are no longer lost if Obsidian is restarted before they are confirmed.
- Notes up to 16 MiB now sync, raised from 4 MiB. A change too large to send now shows an error on the note instead of retrying in a loop.
- A note another member created just as you joined a shared folder could silently never reach your vault.

### Known
- **Collaborators still on 0.1.5 or earlier will appear to have no cursor.** Their presence is sent in the clear, and this version refuses to read that rather than accept something the server could have written. Their edits still sync normally — only their cursor, name and colour are missing, until they update.
- iOS is untested on a device. It should work — it is the same JavaScript as Android — but nobody has run it on an iPhone, so it is not claimed.
- On Android, all vaults in the app share one secret store: signing one vault in signs them all in.
- There is no read-only membership. Everyone in a shared folder can edit it.
- Not audited. The client ships unminified and the build is reproducible, so the claim is checkable — but no third party has checked it.

## 0.1.5 — 18 September 2026 — First public release

Nectenda is listed in the Obsidian community directory. This is the first
version anyone outside the project can install.

### Added
- Real-time collaborative editing with live cursors, name labels and presence.
- Shared folders, with creates, renames and deletes propagating to everyone in them.
- Offline editing that merges on reconnect rather than overwriting.
- End-to-end encryption of notes, attachments, filenames and folder names.
- Per-member key fingerprints you can compare off-server.
- Organisations, email invitations and seats.
- Device management, including signing another device out remotely.
- Sign-in by email code, passkey, or Google, Apple and Microsoft.
- Conflict copies and first-sync backups, so a disagreement never costs writing.

### Known
- iOS is untested on a device. It should work — it is the same JavaScript as Android — but nobody has run it on an iPhone, so it is not claimed.
- On Android, all vaults in the app share one secret store: signing one vault in signs them all in.
- There is no read-only membership. Everyone in a shared folder can edit it.
- Not audited. The client ships unminified and the build is reproducible, so the claim is checkable — but no third party has checked it.

> 0.1.0 to 0.1.5 all shipped the same day, 18 September 2026, and 0.1.1 onward
> each cleared warnings raised by the directory's automated review. They are
> listed together because separately they would be five entries about our own
> paperwork.
