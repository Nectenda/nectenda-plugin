# Sync limitations and how each is handled

Every case here is one where two vaults can disagree, or where local work can be
at risk. For each: what happens, how the code handles it, and what covers it.

Grouped by whether the handling is settled, a deliberate trade, or open.

The governing principle is in `CLAUDE.md`: **no data loss.** A user's writing is
the only thing here that cannot be reconstructed, so where a choice exists the
code keeps both versions and lets the user decide, rather than picking one and
discarding the other silently. Clutter is recoverable; a lost paragraph is not.

Two corollaries do most of the work below. Absence of confirmation is not
permission to overwrite — an empty document may mean "empty" or "not heard from
yet", and where the code cannot tell it must assume the user's content is at
risk. And silent loss is the worst failure mode: if something is discarded it
must be visible, never just gone.

---

## Settled

### A deletion arriving over an unsynced edit

Deletion and editing do not commute, so no CRDT merge exists — one vault deleted
a note, another edited it, and both are legitimate.

**Handling.** The deletion proceeds, but before the file is trashed the vault
holding the edit writes `{name} (conflicted copy {ISO}).md` beside it
(`file-sync.ts`, `preserveThenTrash`). A sibling file rather than a trashed one
on purpose: `.trash` is easy to miss and is pruned automatically, and the point
is that the user can see their work survived.

Preserving reads the **live document** when yCollab is bound, not the file
(`content-sync.ts`, `unsyncedLocalContent`). Obsidian writes the buffer on its
own debounce, so the file can be seconds behind what was typed, and preserving
the file would save a version missing the work the copy exists to protect.

The decision to preserve is sticky: work this client contributed counts even
after it has been pushed. Manual testing found the ordering where the edit
reached the server 39ms before the deletion arrived — disk and document agreed,
so a naive check skipped the copy and sent the work to a document nobody would
read again.

**Covered by** `two-vaults.test.ts` (deletion racing an edit), and nine unit
tests in `conflict-copy.test.ts` driving the real rule.

**Known wrinkle.** The conflict copy is a new file in a shared folder, so it
syncs to the vault that performed the deletion. That vault sees a file it did
not create. Left as-is deliberately: the alternative is a copy that exists in
only one vault, which is worse when the deletion was the mistake.

### Joining a folder whose copy has diverged from yours

Your local file and the server's copy are both non-empty and different — two
independent versions of the same note.

**Handling.** Before the server's copy is written, the local one is preserved to
`.nectenda-backups/{timestamp}/{path}` (`content-sync.ts`, `backupLocalFile`).
The server's copy still wins on disk; the backup is a safety net, not a merge.

This existed in Phase 4, was silently deleted by Phase 6's rewrite, and was
restored in Phase 6.5 — in `ContentSync` rather than `EditorBridge`, so it now
covers every background-synced file rather than only the one open in the editor.

**Covered by** `first-sync.test.ts`, on both paths: joining while the server is
unreachable, and joining while it is up.

**Note for anyone verifying this by hand.** `.nectenda-backups` is a
dot-directory, and Obsidian excludes those from its vault index — so
`app.vault.getMarkdownFiles()` cannot see the backups. Check through the vault
adapter, or the backup will appear not to exist when it does.

### An empty document blanking a file

A document that is empty because nothing has confirmed it yet is not the same as
a document that is genuinely empty. Writing the first over a file with content
destroys it.

**Handling.** `writeToDisk` refuses to write an empty document over a non-empty
file until the server has confirmed the document at least once. Once confirmed,
an empty document is taken as a real deletion and written through — but the
local copy is put aside in `.nectenda-backups/` first, and the removal is
logged. Blanking a file is the one write that syncing again cannot undo, and
confirmation turned out not to be the guarantee it reads as: see below.

**Covered by** `first-sync.test.ts` (joining while unreachable),
`first-sync-backup.test.ts` and `empty-document-guard.test.ts`.

### A placeholder file emptying the document it was waiting for

Found 15 September 2026, and it destroyed a note in both vaults at once.

FileSync creates an empty placeholder as soon as a folder listing names a file.
The content then arrives from the server and fills the document. Obsidian's
modify event for that placeholder can land *after* it — one millisecond after,
in the run that caught this. `onLocalModify` read the empty placeholder as an
edit, deleted every character that had just arrived, and pushed the deletion.
The vault that wrote the note applied it and blanked its own copy too, so the
writing was gone from both machines with no conflict copy and no warning. The
`hasSyncedOnce` guard above did not help: the server had confirmed the document,
and the emptiness it confirmed was this vault's own.

That is why "the server says empty" is not evidence on its own. The server's
copy is empty whenever a vault has failed to upload, or another vault has just
deleted the content by this same route.

**Handling.** An empty file does not empty a document until this vault has seen
the two agree at least once (`lastSyncedContent === null` means they never
have). Emptying a file that *has* held the document's content is a real edit by
a real person and still travels. Separately, seeding a document from disk now
completes before the document is marked confirmed, so the write scheduled on
confirmation can no longer beat the content into place.

**Covered by** `empty-document-guard.test.ts` (both directions, mutation-checked)
and `recovery.test.ts` end to end, which failed about one run in three before
and passed twelve of twelve after.

### Edits made while disconnected

The socket is closed, so updates cannot be sent.

**Handling.** Yjs keeps the edit in the document and y-indexeddb keeps it on
disk. The provider marks the subscription as having unsent work, and on
reconnect computes the delta the server is missing by diffing against everything
catch-up delivered, then pushes it (`multiplexed-provider.ts`,
`pushLocalDelta`). The server cannot say what it lacks — under encryption it
cannot read its own log — so the client works it out.

**Covered by** `two-vaults.test.ts` (outage with both vaults running),
`offline-startup.e2e.ts`, and the server-side scenario suite.

**A deploy is a short disconnect the server announces.** The sync server
closes every socket with code 1001 before it stops, and the plugin treats
that as "restarting": for a minute it retries at one second and then every
two, shows *Server updating* in the status bar, and raises no notice — the
process is back in seconds and the doubling backoff would otherwise have
made the reconnect wait at its thirty-second attempt. Everything above still
holds during that minute: edits are local until acknowledged, and unsent
work is re-derived when the socket returns. Covered by
`provider-restart.test.ts` and the `restart.test.ts` e2e, which types on two
vaults across a real server restart.

### Files created or deleted while disconnected

**Handling.** Creations reach the folder's `__meta__` document and sync on
reconnect like any other change. Deletions are queued (`pendingDeletes`) and
flushed before re-subscribing, so a document deleted offline is not resurrected
by the catch-up that follows.

**Covered by** `two-vaults.test.ts` (offline creation, offline deletion).

### A file created before the folder's listing has opened — fixed

A note created in the window between sync starting and the folder's listing
document becoming writable was dropped and never revisited. The listing's id is
an HMAC that has to be derived, and IndexedDB then has to load; until both
finish there is nowhere to record a new file. Nothing looked again afterwards
either — the folder scan that would have found it had already run, and the
folder was marked scanned.

The file stayed on disk, correct and complete, and reached no other vault. No
warning, no conflict copy, nothing to notice: silent loss of the kind the
governing principle exists to prevent.

**Handling.** `VaultWatcher` holds creates that arrive before the listing exists
(`pendingCreates`) and replays them when `FileSync` announces the folder ready
(`onFolderReady`). Only files still present are replayed, so one created and
deleted inside the window is not announced to other vaults.

Deliberately *not* handled by rebuilding the listing from disk on connect, which
would fix this symptom and reintroduce a worse bug: a file present locally but
absent from the listing may be new, or may be one another vault deleted while
this one was away, and re-adding those resurrects deletions.

The window is a few milliseconds on a developer machine and never once appeared
there. It appeared on every CI run, which is slower — as a large vault or a cold
disk would be for a user.

**Covered by** `vault-watcher.test.ts` ("a file created before the folder
listing is open", three cases, mutation-checked) and, in the situation that
found it, `compaction.test.ts` under CI.

### A document that failed to subscribe stayed in the connected set — fixed

`ProviderRouter.subscribe` throws when a folder is routed to a connection that
does not exist, and routes are rewritten by `refreshSync` — which can name a
connection still being rebuilt after a reconnect. A shard restarting for a
deploy was enough to produce it.

The throw escaped a `void`-fired connect, and it escaped *after* the state had
been placed in `fileDocs`. What remained was a document nothing had subscribed:
no update observer, no `subscribed:` event, and `acquireDoc` handing it out
forever as though it were live. Nothing retried when the connection came back.

The symptom was not what it looked like. Two vaults had the same note open;
edits appeared on both sides, but no live cursors. The content was arriving
through the folder listing and being written to disk, which looks identical to
syncing from the outside — while the editor in the other vault had never bound,
so it announced no presence and drew none. It recovered only when the person
selected a different file and came back.

Three things were wrong and all three are fixed. A subscribe that fails now
tears the half-built document down, so nothing is left to hand out and the next
attempt genuinely reconnects. The router announces `routes-changed` when a
connection arrives or the folder table is rewritten, and ContentSync retries
the files it could not place — so this heals itself instead of waiting for a
click. And the editor's wait for a subscription re-checks on attach and is
bounded, because `subscribed:<docName>` is emitted once and waiting on an event
that has already passed is waiting for ever.

Worth keeping in mind for anything similar: "Document bound" was logged *before*
the subscribe that threw, so the diagnostic log read like a healthy connect. It
is logged after now. The two logs together were what identified this — one vault
showed the route warning either side of that line, the other showed its editor
binding a full thirty seconds later, at the moment the person clicked back.
### Renaming a shared folder emptied it for everyone else — fixed

Renaming a mapped folder in Obsidian matched nothing at all. `resolveMapping`
answers null for a mapping's own root — it resolves files, and a root is not one
— so the event fell through every branch, `localPath` kept pointing at a
directory that no longer existed, and everything beneath the new name resolved
to nothing. Sync stopped for that folder without saying so, while the settings
row still showed the old location.

Fixing the mapping exposed the worse half. Obsidian follows a folder rename with
one event per file inside it, and they arrive **before** anything asynchronous
started by the folder's own event can run — measured in e2e: the folder at T,
its eight files by T+4ms, an awaited handler not reaching the mapping until
T+7ms. While the mapping still said the old path, each of those files resolved
under the old root and matched nothing under the new one, which is the "moved
out of a shared folder" branch: it **deletes the file from the folder's
listing**. Renaming a folder announced every note in it as deleted to every
other vault, with the folder on disk perfectly intact throughout.

The mapping is now moved synchronously, inside the folder's own event, so the
file events that follow already see the new path; and because their path
*within* the folder has not changed, they are recognised and ignored rather than
re-announced. The connections are then rebuilt, because each was created with
the old path and would otherwise write beneath the directory that is gone.

Worth noting for anyone tempted to trust an end-to-end test here: the two-vault
e2e run passed both before and after this was fixed, and passed with the
reconnect removed as well. The delete and the repair raced, and the repair
usually won. Only driving the events in Obsidian's real order — which
`vault-watcher.test.ts` now does — fails when this regresses.

**A rename never travels.** Each vault keeps the folder wherever its own owner
put it; nothing a server returns is ever written to `localPath`. What does
travel is the folder's *name* as shown in Nectenda's settings, re-sealed under
the folder's own key by its owner.
### The commit runs on another thread, and what a crash between costs

Since 12 September 2026 the update log's commits happen on a worker thread
(the server's log writer). A push is posted to the writer; the
ack and the fan-out to collaborators happen only in the continuation that
runs when the writer reports the commit. Under load the writer commits
whatever arrived during the previous fsync as one transaction, so the
`synchronous = FULL` cost is paid once per batch rather than once per push.
Measured on `eu1` before it was built: 5,100 appends a second with the main
thread's event loop unaffected, against a cliff at about 800 concurrent
editors when every push blocked the loop for its own fsync.

**What can be lost.** Nothing that was acknowledged. A push the writer had not
yet committed when the process died was never acked, so the client still
holds it and re-sends it on reconnect exactly as it does for any push that
went unanswered. The writer thread dying is treated as fatal for the whole
process rather than survivable: a shard that keeps accepting pushes it cannot
make durable would be acking nothing while looking healthy, and a visible
restart is the cheaper failure.

**Ordering.** The writer answers in arrival order, so sequence numbers per
document and acks per socket are what one thread would have produced. Writes
that span other tables (deleting a folder, purging or importing an account)
stay on the main connection in their original transactions; before one of
them runs, the server refuses new pushes to that folder or account and waits
for the writer's barrier, so a push already in flight is committed and then
deleted with everything else, and one arriving meanwhile is refused (the
client keeps it; the folder is going). Without the hold, a push arriving
between the barrier being posted and it resolving would land after the rows
it belongs to were gone.

**Telling the members.** Once the transaction has committed — and only then,
never on the path where the delete was refused — the shard sends every socket
subscribed to that folder one message naming it, and forgets the folder's
documents so nothing in memory keeps serving them. The plugin stops syncing
the folder, keeps every local file and its keys, and says so. A member who was
offline at that moment gets no message and learns it from the folder listing
when their settings pane next asks: that is the remaining gap, and a vault
never opened again never finds out, which costs nothing.

**Covered by** `log-writer.test.ts`: the ack waits for a commit that is
artificially slowed; sequences stay contiguous across four sockets; a delete
lands between the pushes before and after it; a killed writer acks nothing
and reports the death; a folder delete with a push in flight leaves no row
behind. Each of the ordering guarantees was mutation-checked by removing it.
`unshare.test.ts` covers the notification: one message to each subscriber of
that folder, none to anyone else, and none at all when the delete was refused.

### Deleted documents accumulating on the server

Nothing removed a deleted file's updates, so content lingered indefinitely —
twenty orphans accumulated in a single afternoon. Under encryption that is
unrecoverable ciphertext growing without bound.

**Handling.** The client that performed the deletion sends `DeleteDoc`, subject
to the same folder authorisation as every other message. Other vaults learn of
the deletion through the folder listing and simply stop following the document.

**Covered by** `sync-scenarios.test.ts`, including a case asserting the server
refuses to purge a document outside an accessible folder.

---

## Deliberate trades

### Binding the editor while offline

**The trade.** `EditorBridge` used to wait for the provider's `synced` event
before installing yCollab. That event cannot arrive while disconnected, so a
file opened during an outage never bound: typing reached CodeMirror alone, and
when the connection returned the synced document was written over the file and
took the edit with it.

It now binds when the document is synced **or** when nothing is connected.
Connected-but-not-yet-synced still waits, because there the document really is
about to arrive and seeding from a stale disk copy would insert characters the
server holds under different identities.

**What this costs.** Binding ends with `editor.setValue(ytext.toString())` —
the document is treated as the source of truth — and sets `editorActive`, which
stops ContentSync reconciling. That line now runs while disconnected, which it
never did before. See the open issue below.

**Why the trade favours binding.** Both sides can lose data. Not binding loses
an edit typed during an outage into a newly opened file, which is the core
collaborative case. Binding risks an external change made during an outage,
which requires another program to be editing the vault at the same time.

**Covered by** `offline-startup.e2e.ts` and `two-vaults.test.ts` (saved and
unsaved variants).

### Diagnostics that survive encryption

Once payloads are ciphertext, reading a document back from the database to see
whose edit went missing stops being possible — and that was the decisive
evidence for most of the sync bugs found so far.

**Handling.** The reconciliation probes are permanent `log.debug` calls, and the
scenario tests assert on client-side state rather than the server's copy, so
both keep working after Phase 7. The vault file sink is opt-in and off by
default: it grows without limit and its lines carry vault-relative paths, which
is exactly what encryption exists to keep off the server.

### Compaction elected its uploader from the presence map

`maybeCompact` picks which client uploads a snapshot by taking the lowest
clientID in the document's awareness map, and awareness is presence data. So a
change to who is *shown* as present silently changed who *compacts* — and
compaction is the one operation where a client can make the server delete
updates.

It was also called from `receive` for every catch-up frame, with no check that
catch-up had finished. `handleCompactRequest`, which reaches the same
`sendSnapshot`, has always refused in that state. A client replaying a backlog
could therefore offer a snapshot of a document it had not finished assembling,
and the server deletes every update at or below the sequence a snapshot claims.

**Handling.** `maybeCompact` now returns early unless the subscription is
synced, matching the guard the server-driven path already had. Found while
adding the awareness retraction below: that made the client clear its peer map
on disconnect, so a just-reconnected client saw no peers, elected itself, and
compacted mid-replay. The election was always the wrong place to decide this;
clearing the map is what made it visible. **Covered by**
`provider-awareness.test.ts`, in both directions — a guard that always refused
would disable compaction entirely and let the log grow without limit.

---

### Presence on a busy note is relayed at most twenty times a second

Since 12 September 2026 the server relays presence (cursor, selection, name,
colour) per document in windows of 50 ms. A move on a document that has been
quiet for a window goes out at once, as its own bytes, exactly as before.
Moves that follow within the window are held and sent together at its end:
one frame carrying the latest state of everyone who moved. The editor emits
one presence message per caret movement, so a person typing fast sends eight
a second and the server was writing each of them to every other subscriber:
sixteen people on one note, on a shard already carrying 1,600 editors, was
19,000 socket writes a second for cursors alone and saturated the thread. A
busy document's cost is now bounded by its recipients times twenty, whatever
the typists do, and a quiet one costs what it always did.

**What is traded.** On a busy note a collaborator sees a caret move up to
50 ms later than before; on a quiet one, nothing changes. Positions
superseded inside a window are never sent, which loses nothing: presence is
last-writer-wins by clock and is never stored. A departed collaborator's
cursor is still retracted immediately. A stale presence message (a clock no
newer than the one held) is no longer relayed at all, which was always
redundant. A mover is not sent a frame holding only their own state.
Document updates are untouched: they go out once each, after the commit,
exactly as before.

**Covered by** `awareness-coalescing.test.ts`: the first move of a burst is
immediate and the rest become one frame with the last state; several people
share a frame; a stale frame is dropped; a departure is immediate; a mover
receives nothing of their own. Each rule was removed in turn and its test
failed.

### A collaborator's colour carries their theme, not yours

Presence colour is broadcast in the awareness state rather than derived on each
client from the seat index. A light-theme user therefore appears in their
light-theme colour on a dark-theme reader's screen: the hue is correct and the
person is still identifiable, but the lightness is tuned for the wrong ground.

**Handling.** Accepted, because the alternative is worse. `y-codemirror.next`
renders the remote caret with the colour inlined on the element and exposes no
hook for per-user CSS, so a client that derived its own value would paint the
presence circle in one colour and the caret belonging to the same person in
another. That is the single thing this feature must not do — the circles exist
to be matched to the cursors. One broadcast value guarantees they agree.

A theme change re-announces rather than going stale: the colour is sampled when
presence is announced, so without that, switching to dark mode mid-session would
leave everyone else painting you in the old value — and your own presence
circles read the same broadcast field, so your screen would disagree with
itself until something happened to rebind the editor. `css-change` is the hook.

The seat index is broadcast alongside the colour, so a future version can
re-derive locally if a way is found to restyle the caret without losing that
guarantee. **Covered by** `collaboration.test.ts`, which pins the agreement
across two vaults — the only place it can be observed.

---

## Handled since being documented

### An external change during an outage — handled, with a caveat

**What happens.** A file changed by another program — a second editor, a script,
a file-sync client — while Nectenda is offline, then opened in Obsidian. Binding
declares the document authoritative and `editorActive` then stops the
disk-to-document path, so without care the change is lost from the file itself.

**Introduced by** the offline-binding change above: `editor.setValue()` never
ran while disconnected before.

**Handling.** `ContentSync.reconcileFromDisk` runs before binding and decides by
**what can be lost**, not by who is probably newer:

- With a known baseline (`lastSyncedContent`), the answer is exact. File matches
  what we last wrote ⇒ the document is newer, possibly holding remote edits not
  yet flushed, so leave it. File differs ⇒ something else changed it, adopt it.
- With no baseline — which is common, because the comparison that establishes
  one runs on a debounce and binding can win that race by tens of milliseconds —
  adopt the file when everything the document holds is still in it, since taking
  it can then discard nothing. When each side holds something the other does
  not, the document wins on screen and the file's version is written to
  `.nectenda-backups/` first.

That last rule is the principle applied directly: with no way to tell which came
first, a stray backup costs a file and picking wrong costs someone's writing.

**Covered by** `external-edit.test.ts`. Eight consecutive passes, against a
roughly one-in-two failure rate before. Mutation-checked properly: removing the
adopt branch makes it fail, though only on the runs that hit the race — a single
mutant run passes, and five did before the sixth failed. Any future mutation
check here needs the same repetition.

**Expect this to be the first test that reddens a CI run**, and not because of
the change under review. It is timing-sensitive by construction, and a shared
runner is slower and more contended than the laptop the eight passes were
measured on. Re-run before investigating; if it fails twice, then suspect the
code.

**Two dead ends, recorded so they are not retried.** Making binding wait for the
connect-time reconciliation fails both ways round. Running that reconciliation
immediately instead of on its debounce truncated a file to empty in one run.
Awaiting the debounce delayed yCollab enough that basic A-to-B convergence
broke, because typing landed in an editor that had not bound — which would drop
a user's first keystrokes after opening a file. The fix had to avoid delaying
the bind at all, which is why it acts on what can be lost rather than waiting
for certainty.

### A forgotten password was unrecoverable — fixed

`RecoveryKeyModal` told every new user that the recovery key "is the only way
back into your notes if you forget your password", and there was no way to use
it: nothing called `recoverMasterKey`, and no route ever returned
`recovery_blob` after registration. On a fresh device — the actual
forgotten-password case — it could not be obtained at all. The cryptography was
correct and tested throughout; the surrounding feature did not exist.

Recovery now works end to end, and two decisions in it are worth knowing.

**Proof comes before disclosure.** `GET /api/auth/recovery-params` returns only
the KDF parameters for the recovery key, never the encrypted blob, and answers
unknown usernames with a deterministic decoy so it cannot be used to enumerate
accounts. The blob and the wrapped private key are released by
`POST /api/auth/recover`, and only to a caller who has proven possession of the
recovery key. Handing an encrypted key blob to anyone who names a username would
turn a per-account online problem into a one-pass offline corpus.

**The identity keypair is preserved.** A new password means a new master key, so
the private key is re-wrapped — but it is the *same* keypair, so every folder
key wrapped to that public key stays valid and no shared folder is lost. A reset
that regenerated the keypair would look like it worked and quietly cost the user
every folder ever shared with them, which is why a test asserts the folder keys
are byte-identical afterwards.

**Superseded credentials are kept, not overwritten.** `user_key_history` retains
the previous wrapped private key, recovery blob and parameters. Credentials are
not an exception to the rule that conflicting versions are both kept: it means a
botched reset is recoverable rather than terminal. It also means the old
password keeps working until that history is pruned, which is deliberate.

Failed attempts are counted **per account**, not only per IP, because the IP is
taken from a header the caller controls. The cap refuses further attempts; it
never destroys key material. Some products discard the escrow record after N
failures, but their secret is a short PIN — ours is a 100-bit key, and here a
lockout that deletes data would be the wrong trade.

Still true: an account registered before this existed has no stored verifier and
**cannot** recover, because the server has never seen its recovery key and
cannot derive one.

## Open

### Two vaults on one machine shared their local document store — fixed

Recorded because the shape of it is worth remembering, not because it is still
open.

Obsidian runs every vault in a single origin (`app://obsidian.md`) and
IndexedDB is per-origin, so a Yjs store named `nectenda:{folderId}/{path}` was
the **same store** in every vault that mapped the folder. Two vaults shared
document state locally, whatever the server said.

It surfaced during the membership work, reported as what looked exactly like a
broken access check: a locked-out account's live edits did not propagate, but
turned up in the other vault after a restart. They had never gone through the
server — its log shows it refused every one — and the shared IndexedDB carried
them, after which the legitimate member's vault pushed them on as its own.

Two lessons. **A local cache keyed only by document identity is shared state,
and shared state is a channel that ignores every check on the wire.** And a
symptom of the form *"blocked live, appears after a restart"* points at a
persistence layer, not at the protocol — the restart is what reloads the cache.

Fixed by namespacing the store with the vault's own id (`idb-name.ts`). It is
also the most plausible account of the duplicate note that appeared once during
Phase 6.5 testing and was never explained.

### There is no read-only membership, and cannot usefully be one

Every member of a shared folder can edit it. `owner` differs from `editor` only
in being able to change who else is a member.

A `viewer` role was built and removed. The editor half worked —
`EditorState.readOnly` through the extension array yCollab uses — but Obsidian
offers a plugin no way to veto a file operation: `vault.on('delete')` fires
after the fact, and there is no cancellable hook. A viewer could still delete
and create files from the file explorer, and their deletion applied to their own
copy of the folder listing, so it would have propagated the moment anyone
promoted them.

Detecting and undoing was possible — restore the file, keep their version as a
backup — but that is a different promise from "read-only", and the gap between
what the role says and what it does is where users lose work. Removed instead.

Anyone who needs to share something nobody can change should share a copy.

**This is the price of end-to-end encryption, and it should be quoted as such.**
A member holds the folder's content key; with it they can produce a valid
encrypted update, and a server that cannot read the plaintext cannot judge
whether it was allowed. Competitors whose servers read plaintext offer
role-based access control cheaply, because rejecting a write is just a check.
Ours cannot be, and any role we enforce server-side would be a convenience
rather than a security boundary.

A partial answer exists and has a real cost: sign each update with the author's
identity key so the server can refuse writes from a non-writer, which turns the
role into something enforceable at the relay without decrypting anything. That
adds a signature to every update, a verification step to every push, and a key
distribution problem when membership changes. It is worth doing when a customer
needs it; it is not worth pretending it exists in the meantime. `docs/security-model.md`
states the limitation plainly for the same reason.

### A folder with no keys will not sync at all

Both folder-connect paths refuse a folder whose keys this device does not hold,
rather than connecting part of it. That is deliberate: without keys the folder
listing cannot be decrypted, so no remote deletion can be observed, and a folder
that misreads its listing will trash local files.

The visible consequence is that a folder shared before encryption, or shared
with an account whose keys were not wrapped for it, silently does nothing but
log a warning and show a notice. Local files are untouched. The fix is for an
owner to re-share the folder, which is the no-migration decision working as
intended.

### An update that cannot be decrypted stops the sequence advancing

If a payload fails to decrypt — a missing key generation, a corrupt blob — the
client holds `lastSeq` at the last update it applied, keeps applying later
updates, and suppresses compaction until the gap closes.

That is the safe direction: advancing past it would mean never asking for it
again, and a snapshot taken over a known hole would make the server delete the
updates that would fill it. But a client stuck behind a gap it can never
decrypt will keep re-requesting it on every reconnect and will never compact.
Nothing surfaces that state beyond one warning and a notice.


### A background pane is wired to the active document

The plugin registers one editor extension array for all editors and swaps its
contents to whichever document binds last, so a background pane showing note A
is wired to note B's `Y.Text`.

**Current assessment: not a defect in practice.** `EditorBridge` rebinds when
the active leaf changes, and typing only happens in the active pane, so the
array is correct when it is used. `multi-pane.test.ts` opens two notes and
confirms each note's edits stay in its own document.

**What is not covered.** A background pane being written to by something other
than the user. Whether anything can reach one is unverified.

### Encryption keys are stored unencrypted — **fixed, kept for the record**

This said: "`masterKey` and `keyMaterial` sit in `data.json`. Obsidian offers no
secure storage." Both halves are now wrong. The master key is not stored
anywhere on any version, and Obsidian gained `app.secretStorage` in 1.11.4, which
the plugin uses when it is available. What is left in `data.json` is the wrapped
private key and the recovery blob, both already sealed and worthless to a reader
of the file. See `docs/key-storage.md` for what ends up where, and for the two
exposures that do remain: no isolation from other plugins on any platform, and
secrets shared across vaults on Android.

---

## Testing notes

Two mistakes cost several wrong conclusions during this work, and both are easy
to repeat:

**Assert through an API that can see the thing.** Backups were reported missing
because the check used Obsidian's vault index, which excludes dot-directories.
Earlier, a manual run was called valid because `pgrep -x Obsidian` reported
nothing — the app runs with no vaults open, so that proves nothing either.

**Confirm the build under test contains the change.** Two conclusions were drawn
from a stale bundle: once when a failed build left an old `main.js` in place,
and once when invoking vitest directly skipped the package's `pretest` hook. A
vitest `globalSetup` now builds the plugin before every e2e run. When marking a
mutation to verify it reached the bundle, use a string literal — esbuild strips
comments in production builds, so a `//` marker disappears while the mutation
itself is applied.
