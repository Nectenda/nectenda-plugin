# Changelog

Every release of the Nectenda plugin, newest first. Each release on GitHub also
carries the SHA-256 of its `main.js`, so you can check that the plugin you are
running is the source you read — see the README.

## 0.5.2 — 10 October 2026

### Added
- **A note edited inside a canvas card syncs live,** with collaborators' cursors, as it does in the note's own pane.
- On a shared canvas you now see the edge a collaborator has selected, who is typing in a note card, the connection they are drawing (curved, with its arrowhead, snapping onto the card it will join), and the edges of a card they are dragging.

### Fixed
- **Typing in a canvas card that shows a note no longer undoes a collaborator's change to that note.** Both edits are kept.
- Canvas cards that show a note or an image now find their file in every vault, even where the shared folder has a different name.

### Known
- **Everyone sharing a canvas should update to 0.5.2.** Once a vault on 0.5.2 has synced a canvas, a collaborator on an earlier version leaves it untouched and asks them to update. Edits they made offline still arrive. Nothing is lost.
- A canvas card pointing at a file outside the shared folder still says "could not be found" in the other vaults, which do not have that file.
- A canvas card that shows one section of a note syncs when it is saved, not as you type, and shows no cursors.
- **Everyone sharing a drawing should update to 0.5.0 or later.** A collaborator on an earlier version still sees it as a note and merges it as text. Their edits reach you as conflict copies beside the drawing, about one per save. Nothing is lost.
- When two people move or resize the same shape at once, one move wins and the other is not kept.
- Live sync of drawings is tested against Excalidraw 2.27.3 and 2.28.1. An Excalidraw release that changes what Nectenda relies on falls back, with a notice, to syncing a drawing when it is saved, a few seconds behind.
- A shape type one vault's Excalidraw does not know, such as a sticky note in an older Excalidraw, is kept but not shown there until that vault updates Excalidraw.
- With live sync for drawings off, nobody is shown on a drawing.
- While a drawing is open, its file can be up to a minute behind it. Nothing is lost, but another app reading the file sees changes late.
- A Kanban board edited in the first second or so after Obsidian starts, before it has synced, is not merged: your edit is kept in `.nectenda-backups` with a notice, and the board shows it as gone until you restore it from there.
- Two people moving the same Kanban card, or changing the same line, at the same moment can leave both versions on the board. The extra one can be deleted.
- In a Kanban board torn out into its own window, a collaborator's change is not held back while you are editing a card.
- **Everyone sharing a base should be on 0.4.0 or later.** A collaborator on an earlier version still syncs bases as whole files. Their edits reach you as conflict copies beside the base, and yours do not reach them. Nothing is lost, but the base does not merge until they update.
- A collaborator on 0.3.0 or earlier still edits properties as text. Their edits are taken in, but if they and someone on 0.4.0 set the same property at once, the 0.4.0 value wins. The note as it stood is backed up first.
- When two people change the same presentation setting of a base at once, such as its sort or column order, one value is kept with no conflict copy. Filters, formulas and grouping still get a conflict copy.
- Column widths in a base are each vault's own, and a base whose filters reach outside the shared folder shows different rows in each vault. Entries without the shared mark are that vault's own.
- If a collaborator moves a card while you are dragging it, your drop wins its position.
- Collaborators still on 0.1.5 or earlier will appear to have no cursor. Their edits sync normally.
- iOS is untested on a device. It should work, since it is the same JavaScript as Android, but nobody has run it on an iPhone, so it is not claimed.
- On Android, all vaults in the app share one secret store: signing one vault in signs them all in.
- There is no read-only membership. Everyone in a shared folder can edit it.
- Not audited. The client ships unminified and the build is reproducible, so the claim is checkable, but no third party has checked it.

## 0.5.1 — 9 October 2026

### Fixed
- **An edit made in a drawing while it was saving is no longer lost** when a change from another device arrives, or when you switch tab, close the drawing or it reloads. The same goes for a canvas or drawing saved just before a collaborator's change was written.
- **A drawing open without live sync no longer removes an edit from another device** that it had not yet shown. If the two conflict, the other edit is kept beside yours.
- A shape you delete in a drawing no longer comes back because Excalidraw adjusted it on another device, and shapes deleted while sync is off stay deleted after you quit and reopen Obsidian.
- A drawing tab closed just as someone else changed its note, settings or image links no longer undoes their change when it saves on closing.
- When a drawing taken over from text sync loses a change to a concurrent edit, the earlier version is now shown beside it as a labelled copy instead of being kept out of sight.
- Fewer needless "Kept by Nectenda" copies: none after a drawing reloaded a change just before you edited it, none after editing a drawing another device changed while devices run different Excalidraw versions, and none of your own earlier edit in a drawing opened with live sync off.
- A drawing nobody changed is no longer copied into `.nectenda-backups` when Obsidian is reopened.
- Live Excalidraw drawings no longer get stuck after a reconnect while opening, and a pasted image reaches the other vault's file within seconds instead of a minute later.
- On Obsidian 1.14, Kanban lanes added, hidden or moved in two vaults at once all keep their change, instead of one board replacing the other.
- On Obsidian 1.14, a shared base's Kanban board shows which card each collaborator is pointing at again.
- On Obsidian 1.14, the status icon's waiting dot and people count are sized to the icon in the ribbon again. They now follow the icon's size wherever it appears, whatever the theme or icon-size settings.
- The ribbon status icon stays hidden when it is switched off in settings, instead of coming back the next time the ribbon redraws.

### Known
- **Everyone sharing a drawing should update to 0.5.0 or later.** A collaborator on an earlier version still sees it as a note and merges it as text. Their edits reach you as conflict copies beside the drawing, about one per save. Nothing is lost.
- When two people move or resize the same shape at once, one move wins and the other is not kept.
- Live sync of drawings is tested against Excalidraw 2.27.3 and 2.28.1. An Excalidraw release that changes what Nectenda relies on falls back, with a notice, to syncing a drawing when it is saved, a few seconds behind.
- A shape type one vault's Excalidraw does not know, such as a sticky note in an older Excalidraw, is kept but not shown there until that vault updates Excalidraw.
- With live sync for drawings off, nobody is shown on a drawing.
- While a drawing is open, its file can be up to a minute behind it. Nothing is lost, but another app reading the file sees changes late.
- A Kanban board edited in the first second or so after Obsidian starts, before it has synced, is not merged: your edit is kept in `.nectenda-backups` with a notice, and the board shows it as gone until you restore it from there.
- Two people moving the same Kanban card, or changing the same line, at the same moment can leave both versions on the board. The extra one can be deleted.
- In a Kanban board torn out into its own window, a collaborator's change is not held back while you are editing a card.
- **Everyone sharing a base should be on 0.4.0 or later.** A collaborator on an earlier version still syncs bases as whole files. Their edits reach you as conflict copies beside the base, and yours do not reach them. Nothing is lost, but the base does not merge until they update.
- A collaborator on 0.3.0 or earlier still edits properties as text. Their edits are taken in, but if they and someone on 0.4.0 set the same property at once, the 0.4.0 value wins. The note as it stood is backed up first.
- When two people change the same presentation setting of a base at once, such as its sort or column order, one value is kept with no conflict copy. Filters, formulas and grouping still get a conflict copy.
- Column widths in a base are each vault's own, and a base whose filters reach outside the shared folder shows different rows in each vault. Entries without the shared mark are that vault's own.
- If a collaborator moves a card while you are dragging it, your drop wins its position.
- Collaborators still on 0.1.5 or earlier will appear to have no cursor. Their edits sync normally.
- iOS is untested on a device. It should work, since it is the same JavaScript as Android, but nobody has run it on an iPhone, so it is not claimed.
- On Android, all vaults in the app share one secret store: signing one vault in signs them all in.
- There is no read-only membership. Everyone in a shared folder can edit it.
- Not audited. The client ships unminified and the build is reproducible, so the claim is checkable, but no third party has checked it.

## 0.5.0 — 5 October 2026

### Added
- **Excalidraw drawings sync live.** A change in one vault appears in the other's open drawing within moments, merged shape by shape, with each person's pointer and selection shown on the canvas.
- **Boards of the Kanban plugin (not the native bases Kanban) update live** for everyone, keep a card you are editing safe while others change the board, and show who is on the board and which card they are editing.
- Two new settings, "Live sync for Excalidraw drawings" and "Live sync for Kanban boards", turn live updates off per plugin. Drawings and boards are still merged safely when saved.
- The Nectenda icon now appears in the header of canvases, bases and Excalidraw drawings as well as notes, under the same "in each note's header" setting.
- The diagnostic log keeps the previous session as `diag.prev.log`, so restarting Obsidian no longer erases the record of what happened just before.

### Fixed
- **Two people editing the same shape at once no longer corrupt a drawing.** When the edit that loses changed the shape's text, style, link or points, it is kept beside the original, grouped and labelled with who made it and when.
- **A note you edited while sync was stopped is now merged when sync starts again,** instead of being overwritten by the other vaults' version. If both sides changed it, your copy is kept in `.nectenda-backups`. Drawings are treated the same way.
- Files added just after Obsidian started could upload but never reach the other vault, until a restart. They now arrive.
- Turning sync off and on no longer slows Obsidian down over time.
- Canvases and bases now show their real sync status, green when in sync, in their header and in the file explorer, instead of always grey. Drawings do too.

### Known
- **Everyone sharing a drawing should update to 0.5.0.** A collaborator on an earlier version still sees it as a note and merges it as text. Their edits reach you as conflict copies beside the drawing, about one per save. Nothing is lost.
- When two people move or resize the same shape at once, one move wins and the other is not kept.
- A shape deleted offline, in a drawing that is not live, comes back if Obsidian is quit before it reconnects.
- Live sync of drawings is tested against Excalidraw 2.27.3 and 2.28.1. An Excalidraw release that changes what Nectenda relies on falls back, with a notice, to syncing a drawing when it is saved, a few seconds behind.
- A shape type one vault's Excalidraw does not know, such as a sticky note in an older Excalidraw, is kept but not shown there until that vault updates Excalidraw.
- With live sync for drawings off, nobody is shown on a drawing.
- While a drawing is open, its file can be up to a minute behind it. Nothing is lost, but another app reading the file sees changes late.
- A Kanban board edited in the first second or so after Obsidian starts, before it has synced, is not merged: your edit is kept in `.nectenda-backups` with a notice, and the board shows it as gone until you restore it from there.
- Two people moving the same Kanban card, or changing the same line, at the same moment can leave both versions on the board. The extra one can be deleted.
- In a Kanban board torn out into its own window, a collaborator's change is not held back while you are editing a card.
- **Everyone sharing a base should be on 0.4.0 or later.** A collaborator on an earlier version still syncs bases as whole files. Their edits reach you as conflict copies beside the base, and yours do not reach them. Nothing is lost, but the base does not merge until they update.
- A collaborator on 0.3.0 or earlier still edits properties as text. Their edits are taken in, but if they and someone on 0.4.0 set the same property at once, the 0.4.0 value wins. The note as it stood is backed up first.
- When two people change the same presentation setting of a base at once, such as its sort or column order, one value is kept with no conflict copy. Filters, formulas and grouping still get a conflict copy.
- Column widths in a base are each vault's own, and a base whose filters reach outside the shared folder shows different rows in each vault. Entries without the shared mark are that vault's own.
- If a collaborator moves a card while you are dragging it, your drop wins its position.
- Collaborators still on 0.1.5 or earlier will appear to have no cursor. Their edits sync normally.
- iOS is untested on a device. It should work, since it is the same JavaScript as Android, but nobody has run it on an iPhone, so it is not claimed.
- On Android, all vaults in the app share one secret store: signing one vault in signs them all in.
- There is no read-only membership. Everyone in a shared folder can edit it.
- Not audited. The client ships unminified and the build is reproducible, so the claim is checkable, but no third party has checked it.

## 0.4.1 — 2 October 2026

### Added
- In a shared base, each entry that is shared carries the same sync mark as the file explorer: at the start of its row in a table, in the corner of a card, before the bullet in a list. Only marked entries can show where a collaborator is; an entry without one is in your vault only, even if its name matches one that is shared.

### Fixed
- In a base's cards and table views, the outline showing which entry a collaborator is on no longer lingers on the wrong entry while you scroll.

### Known
- **Everyone sharing a base should be on 0.4.0 or later.** A collaborator on an earlier version still syncs bases as whole files. Their edits reach you as conflict copies beside the base, and yours do not reach them. Nothing is lost, but the base does not merge until they update.
- A collaborator on 0.3.0 or earlier still edits properties as text. Their edits are taken in, but if they and someone on 0.4.0 set the same property at once, the 0.4.0 value wins. The note as it stood is backed up first.
- When two people change the same presentation setting of a base at once, such as its sort or column order, one value is kept with no conflict copy. Filters, formulas and grouping still get a conflict copy.
- Column widths in a base are each vault's own, and a base whose filters reach outside the shared folder shows different rows in each vault. Entries without the shared mark are that vault's own.
- If a collaborator moves a card while you are dragging it, your drop wins its position.
- Collaborators still on 0.1.5 or earlier will appear to have no cursor. Their edits sync normally.
- iOS is untested on a device. It should work, since it is the same JavaScript as Android, but nobody has run it on an iPhone, so it is not claimed.
- On Android, all vaults in the app share one secret store: signing one vault in signs them all in.
- There is no read-only membership. Everyone in a shared folder can edit it.
- Not audited. The client ships unminified and the build is reproducible, so the claim is checkable, but no third party has checked it.

## 0.4.0 — 1 October 2026

### Added
- **Bases merge.** Two people changing different filters, formulas or views of one base both keep their changes instead of one getting a conflict copy.
- In a shared base you can see who else has it open, which view they are on, and which row, cell or card they are on.
- **Note properties merge property by property.** Edited on two devices at once, a Kanban card dragged to two lanes lands in one of them, and the other choice is kept as a conflict copy, instead of the property becoming a mix of both.
- In a note's Properties panel you can see which property a collaborator is editing.
- An attachment skipped on this device now shows a "Download on this device" button in the note, which goes away once the file arrives.

### Fixed
- **A property you changed before restarting could be lost without a conflict copy** when another vault changed it just as the note reconnected.
- Collaborators' cursors and your typing could drift out of place in a note after a sign-in refresh, until you switched notes and back.
- While you drag a card on a live canvas, other people's moves of other cards now show straight away instead of waiting for you to let go.
- A card you are dragging on a live canvas can no longer be deleted out from under your drag by someone else if your window loses focus or a second finger lifts mid-drag.
- Turning the share link off or on, changing someone's role and publishing a folder's name failed with "Failed to fetch". They now work.
- An organisation's owner now sees Replace… and Turn off… for the share link as soon as the page opens, not only Copy.
- When the server needs a newer plugin, the status icon now says "Update the plugin to keep syncing" instead of Connected. When an organisation refuses this device, it says "Device limit reached".
- The box for the code from your email, on the sign-in screen, is now wide enough to show the code you type.
- Buttons for hard-to-undo actions, such as turning off sync or starting over, now use Obsidian's current destructive style.

### Known
- **Everyone sharing a base should update to 0.4.0.** A collaborator on an earlier version still syncs bases as whole files. Their edits reach you as conflict copies beside the base, and yours do not reach them. Nothing is lost, but the base does not merge until they update.
- A collaborator on 0.3.0 or earlier still edits properties as text. Their edits are taken in, but if they and someone on 0.4.0 set the same property at once, the 0.4.0 value wins. The note as it stood is backed up first.
- When two people change the same presentation setting of a base at once, such as its sort or column order, one value is kept with no conflict copy. Filters, formulas and grouping still get a conflict copy.
- Column widths in a base are each vault's own, and a base whose filters reach outside the shared folder shows different rows in each vault.
- If a collaborator moves a card while you are dragging it, your drop wins its position.
- Collaborators still on 0.1.5 or earlier will appear to have no cursor. Their edits sync normally.
- iOS is untested on a device. It should work, since it is the same JavaScript as Android, but nobody has run it on an iPhone, so it is not claimed.
- On Android, all vaults in the app share one secret store: signing one vault in signs them all in.
- There is no read-only membership. Everyone in a shared folder can edit it.
- Not audited. The client ships unminified and the build is reproducible, so the claim is checkable, but no third party has checked it.

## 0.3.0 — 30 September 2026

### Added
- **Canvases are collaborative.** Two people moving different cards, or typing in the same card, both keep their changes instead of getting a conflict copy.
- Open canvases are live: you see other people's moves, edits and typing as they happen. Their mouse pointers show with their names, and stick to the edge of the canvas when they are off-screen. Text they select inside a card is highlighted in their colour. Undo steps back only your own changes.
- On a live canvas you see a collaborator's caret, with their name, inside the card they are typing in. A card someone is typing in is outlined with their name even when you are only looking at it.
- Click a person's circle in the header to jump to them: in a note, to their cursor, or to their pointer if they have no cursor there; on a canvas, to their pointer or to the card they are typing in.
- Invite someone to a shared folder by email in one step, from the folder's right-click menu, the command palette or the folder's people list. They get the folder as soon as they join.
- Your vault now shares a folder's key with new members automatically. It refuses if a collaborator's key has changed since you last shared with them.
- A folder someone shares with you is offered once its key arrives: "shared a folder with you — Add to this vault".
- The people list shows whether you have compared each collaborator's key fingerprint, with a "Mark as compared" button, and lists pending invitations. Editors can open it too, not only owners.
- Settings are reorganised. There is a "This vault" list with a page per shared folder, "Shared with you" for invitations and folders waiting to be added, a short "Get started" list, and Security, Editing and Advanced pages. Names are clearer throughout ("Stop syncing here", "Add to vault", "People").
- Choose where Nectenda's status appears: each note's header, the ribbon (now the Nectenda logo) or, on desktop, the status bar. Each shows the same icon and opens the same menu, which lists who is in the note, anything waiting for you, and the folder's settings.
- New commands: open a shared folder's settings, add a folder shared with you, join an organisation with a link, and forget your passphrase on this device.
- Right-click a synced folder, or a note in one, for "Nectenda: Folder settings…". Owners also get "Invite to folder…" on notes.
- Shared folders have an accent-coloured indentation guide in the file explorer, and a note a collaborator changes briefly pulses there.
- User guides are published at nectenda.com/docs. A new install shows one notice pointing to Nectenda's settings.
- Owners and admins can turn their organisation's share link off, or replace it with a new one, from the organisation page. The old link stops working at once.
- If you have lost both your passphrase and your recovery key, you can start over with a new, empty account under the same email address. The reset waits seven days, and any device still signed in can cancel it. A vault left open notices such a request within the hour, or when you return to the window.

### Fixed
- **A note's text could be copied into a different note** when two notes were open in split panes.
- **A key typed the moment a shared note's pane became active could be erased.**
- A collaborator's cursor and name no longer flash while they type.
- Deleting or renaming a canvas that was shared before canvases merged no longer brings the old file back on the next restart.
- A phone or computer that was already signed in when you joined an organisation on another device now syncs that organisation's folders, instead of adding them and staying empty.
- Adding a shared folder no longer reuses an existing folder of the same name that already holds notes. It goes to "<name> (shared)" instead, so those notes are not shared by accident.
- The dot and number on the Nectenda status icon now scale with the icon and sit evenly at its corners.
- The recovery dialogs consistently say "passphrase".

### Known
- **Everyone sharing a canvas should update to 0.3.0.** A collaborator on an earlier version still syncs canvases as whole files. Their edits reach you as conflict copies beside the canvas, and yours do not reach them. Nothing is lost, but the canvas does not merge until they update.
- When two people change the same thing on a canvas at once, such as the same card's position or colour, one change is kept and the other person gets a conflict copy of the canvas beside it, with a notice. A card someone deletes can come back if another person was editing it at the same time.
- If a collaborator moves a card while you are dragging it, your drop wins its position.
- Live canvases rely on parts of Obsidian that it does not document. If an Obsidian update changes them, the canvas stops being live, with a notice, and syncs through the file instead, as it does before its document is ready. Then it reloads when someone else changes it: you can lose your place in a card you are typing in, undo can undo other people's changes, and a keystroke or change made in the same instant as a remote one can be overwritten.
- A collaborator's caret shows only while their Obsidian window has focus. Inside an embed in a canvas card, the card is outlined with their name but no caret is drawn.
- Live canvases have not been run on a phone.
- Collaborators still on 0.1.5 or earlier will appear to have no cursor. Their edits sync normally.
- iOS is untested on a device. It should work — it is the same JavaScript as Android — but nobody has run it on an iPhone, so it is not claimed.
- On Android, all vaults in the app share one secret store: signing one vault in signs them all in.
- There is no read-only membership. Everyone in a shared folder can edit it.
- Not audited. The client ships unminified and the build is reproducible, so the claim is checkable — but no third party has checked it.

## 0.2.1 — 25 September 2026

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

> 0.2.0 was published on 25 September 2026 and withdrawn before the community
> directory listed it: its automated review rejected the release over how one
> animation was applied in the code, not over anything the plugin does. Nobody
> was ever offered it, so its contents are listed here as 0.2.1 rather than as
> a version of their own. The 0.2.0 tag and its release still exist, and this
> is the note that explains them.

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
