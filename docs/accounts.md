# Accounts, plans and devices

**Status:** implemented in Phase 8 Stage 0. Quota accounting hangs off this and
arrives in Stage 3; nothing here measures storage yet.

## Why an account exists at all

Until Phase 8 there were only users, flat, with a `role` of `admin` or `editor`
meaning authority over the whole server. That is enough to run a self-hosted
instance and not enough to bill anyone: storage has to be charged to something
that outlives an individual user and can hold several of them.

So the **account** is the billable unit. It holds users, each of whom may
connect some number of devices at once, and it is what a storage quota will
attach to. A folder's storage is charged to the account of whoever created it —
`shared_folders.created_by` — so one folder has one bill, and that bill does not
move when a user leaves.

## The shape

```
plans      ──<  accounts  ──<  users  ──<  devices
                              (account_role)
```

| Table | Holds |
|---|---|
| `plans` | What a tier includes. Data, not constants. |
| `accounts` | The billable unit, its plan, per-account overrides, and status. |
| `users.account_id` | Which account a user belongs to. |
| `shared_folders` | Belong to the account of the member who created them, and never cross it. In the plugin a vault folder is mapped into at most one organisation; sharing it into a second is refused, naming the first. (Relay draws the same line: a folder holds one relay.) |
| `users.account_role` | `owner` \| `admin` \| `member` — authority *within* the account. |
| `devices` | Which installs have ever connected, for naming and visibility. |

**`account_role` is not `role`.** `users.role` is authority over the server;
`account_role` is authority over one account's seats and usage. They are
deliberately separate: conflating them is how one tenant ends up able to
administer another.

## How a limit is resolved

Every limit is read through **`effectiveLimits(db, accountId)`** and nowhere
else. Resolving `COALESCE(override, plan)` at each enforcement point is how one
of them ends up disagreeing with the others.

Precedence, highest first:

1. **Environment** — `MAX_BLOB_BYTES`. Whoever runs the server owns the
   hardware, and a self-hoster setting this should not be quietly overruled by a
   row in a table they never edited.
2. **Per-account override** — `accounts.*_override`. This is where a client who
   needs more than the tier allows is configured: one row update, no redeploy
   and no code change.
3. **The plan** — `plans.*`.

**`0` means unlimited, everywhere it appears.** That is what makes the
self-hosted default unrestricted without a separate "is this the hosted tier?"
flag that every call site would have to remember to check.

An account that does not exist resolves to `null`, and callers must treat that
as a refusal. An unknown account is a bug or an attack, and neither deserves
unlimited storage.

### Stock plans

Seeded with `INSERT OR IGNORE`, so an operator who edits a plan's limits keeps
the edit across restarts. Seeding is for a fresh database, not a reset.

| Plan | Storage | Seats | Devices per seat | Attachments | Max attachment |
|---|---|---|---|---|---|
| `self-hosted` (default) | unlimited | unlimited | unlimited | yes | 100MB |
| `free` | none | 3 | 2 | **no** — text sync only | — |
| `personal` | 10 GB | 5 | 3 | yes | 100MB |
| `team` | 5 GB per seat | 10 | 4 | yes | 100MB |
| `small-business` | 20 GB per seat | 25 | 6 | yes | 100MB |

The default is unrestricted because self-hosting is this project's default
posture. A hosted deployment sets `DEFAULT_PLAN_ID` rather than this being a
code change.

**Per-seat storage** is `quota_bytes + quota_per_user_bytes × seats`, computed
before the "0 means unlimited" rule is applied, so a plan with no base and a
per-seat allowance is a finite quota rather than an unlimited one. Attachments
being switched off is an explicit flag, `attachments_enabled`, not a zero quota:
uploads on such a plan are refused with a distinct code and text sync is
unaffected.

That flag is why the `free` row reads "none" here while the seed carries a
one-gigabyte figure. With attachments off the quota gates nothing — no upload
can reach it — and the number survives only as the reference the text-growth
flag is measured against, at twice the quota. A reader comparing this table to
the seed should not conclude the table is wrong.

**`free` allows three seats, not one.** A free tier on a collaboration product
has to be able to demonstrate collaboration, and one seat cannot. It is also how
the product spreads: every paying customer invites collaborators, and a paywall
on the invitation is a failed invitation. Attachments are the paid boundary, not
seats — text costs almost nothing to carry.

**A seat is a membership.** One person may belong to several organisations and
takes one seat in each.

**Changing a seeded plan does not change an existing database.** Seeding is
`INSERT OR IGNORE`, deliberately, so that an operator's edits survive a restart.
Schema and plan changes that must reach existing databases go through numbered
migrations (`PRAGMA user_version`), which is how the table above replaced the
earlier `free` / `team` / `enterprise` seed.

## Seats

An invite is minted against an account and joins that account when redeemed. An
invite with **no** account creates a new one. That route is still
instance-admin-only, and it holds because the whole `/api/admin/*` surface is,
not because the handler checks: there is no separate test inside it, so the
guarantee would be lost the moment that route were opened to account admins.

It is no longer the only way an account comes into being. **Anyone who signs in
creates one of their own**, on the free plan, and may create more. The rationale
that used to be written here — that self-serve creation hands out storage nobody
has agreed to pay for — was true when it was written and is not true now: the
free plan carries no attachments, so it hands out no storage. Pointing
`SELF_SERVE_PLAN_ID` at a plan with a quota would make the old objection apply
again. "When a plan shrinks", below, says what the limits do afterwards.

The seat check runs **twice, deliberately**:

- **At creation**, counting unredeemed invites as taken seats. Without that an
  admin can mint ten invites against one free seat and nine people hit a wall
  having already been told they were invited.
- **At redemption**, because seats can fill in between.

An invite **expires after 14 days** (`INVITE_TTL_SECONDS`), enforced both in the
route and in the conditional `UPDATE` that claims it. It is a bearer credential —
whoever holds the string becomes a user and takes a seat — and unbounded lifetime
was only survivable while tokens were copied between admins on one screen. A
token minted before the column existed has `expires_at IS NULL` and never
expires, because backfilling would retroactively invalidate invites people are
already holding.

Redemption is **one transaction**: the user is created and the invite claimed
together, and losing the claim rolls the user back. It cannot be two statements.
`handleRegister` awaits bcrypt between validating the invite and consuming it,
and bcrypt is deliberately slow, so that await hands the event loop to the next
request for roughly 100ms. Before this was a transaction, five concurrent
registrations quoting one token produced **five users** — the conditional
`UPDATE` had always detected the losers, and the boolean it returned was
discarded.

## Devices

### A device is a machine, and it holds a slot by being on the roster

**Decided 14 September 2026.** A device is one Obsidian installation — a
laptop, a phone — and every vault on it is one device. Each organisation
keeps a **roster** of the devices each member has added; a device holds one
of the member's slots there from the moment it is added until somebody
removes it, whether or not Obsidian is open. That is the model people
already have of "my devices", it is how the nearest competitor counts, and it
makes the count a list a person can act on rather than a fact about this
minute.

Two ids, then. The **device id** is a random UUID kept in the installation's
own storage, which every vault window on the machine shares, so all of them
read the same value; it carries nothing about the hardware, because deriving
one from the machine would mean fingerprinting — unreliable, and a privacy
regression in a product whose whole claim is that the server knows nothing.
The **install id** is the vault's own random id, kept in the secret store
beside the token; it is what a sign-in belongs to, so signing one vault in
does not sign in the other vault on the same laptop. That holds because the
secret store is vault-scoped — which is true on desktop and **false on
Android**, where every vault of the app shares one store, so the install id and
the token are common to all of them and a sign-in covers the lot. The device id
is unaffected either way, so seat counting is right on both. See
`docs/key-storage.md`. The sync server lists
the vaults a device syncs from under it, by their names, for recognition;
they cost nothing.

In the plugin, an organisation's account view is its **own page** in
settings (Settings → Nectenda → the organisation, since 14 September 2026):
plan and storage, the members, the devices, and — for an owner or admin —
invitations and the share link. The entry on the main pane says the one
thing worth knowing before opening it: the roster count, or *not added on
this device*.

### Adding and removing

A device is added — the server word is *enrolled* — when it signs in, when it
creates an organisation, and when it joins one; a background refresh only
asks where it stands, so a slot freed for one device is not taken by
whichever other refreshes next. When the member's slots in an organisation
are all taken the device is refused for that organisation only: the sign-in
succeeds, the seat is real, the token is issued, and the device opens no
socket there until someone removes another device or adds this one once a
slot is free. Every session the server issues says which (`device.enrolled`,
with `used` and `max`).

A device is removed from the account view; removing it frees the slot at once
and closes that device's sockets to the organisation with `4003`. The device
keeps its notes; it stops syncing that organisation. A device is renamed the
same way; the default name is its platform ("Desktop (macOS)", "Phone (iOS)").

### Enforcement

The socket handshake consults the roster: a device not on it is refused,
however few sockets are open, and a device on it connects however many it
already holds. Enrolment is the one place a slot is taken, and it happens
in one transaction, so two devices racing for the last slot cannot both
pass. An unlimited plan (`0`) keeps no roster gate at all, which is what
lets a self-hosted client that sends no device id keep connecting; on a
limited plan a client with no id cannot be enrolled — the old rule folded
every such client into one shared slot, which on a roster would be a slot
nobody could see or remove.

### Refuse the newcomer, never evict an incumbent

Eviction reads better in a brochure and is wrong here. Two devices reconnecting
would flap against each other indefinitely, and disconnecting a device that
holds unsent offline work is exactly the hazard the no-data-loss principle
exists to prevent.

Refusal loses nothing: the new device keeps editing locally and syncs once it
is added. It is closed with **`4003`** (`WS_CLOSE_DEVICE_LIMIT`), an
application close code distinct from any auth failure, because the plugin must
not present it as one — nothing is wrong with the credentials, and "try logging
in again" would be useless advice. The plugin records the refusal against the
membership, closes the connection rather than knocking, marks the
organisation *not added on this device*, and offers **Add this device** in the
account view.

### A session that ends, ends everywhere

Signing a device out — from itself, or from any other signed-in device — used
to flip one column on the identity service and change nothing on any sync
server: the device kept its week-long session and its open sockets. Now the
identity service hands every sync server the list of ended sessions, at once
after each sign-out and again before every directory pull, and each server
refuses those sessions on the handshake, on every request and on every queued
frame, closing what it held with **`4005`** (`WS_CLOSE_SIGNED_OUT`). The plugin
does not act on that code alone — signing in again from the same install
ends its own previous session, and the old socket is closed while the new
sign-in is still being applied. It asks the identity service first, re-mints
if it is still signed in there, and signs out only when it is not. Within
about a minute of the sign-out, the device is signed out everywhere; a
socket-only "Disconnect" that the device undid a second later is gone.

A hosted token that names no session — one minted before this rule — is
refused on every request too, but at the WebSocket handshake rather than with
`4005`: a plugin old enough to hold such a token treats any close code as a
plain drop and, with the upgrade accepted first, would reconnect every
second. A handshake refusal backs it off, and it re-mints at its next load.

## Suspension

`accounts.status = 'suspended'` refuses new connections and every request that
writes or grows anything — uploads, folder creation, membership changes,
invitations — with a distinct code so the plugin can say why. Still permitted:
signing in, the account view (which carries the explanation), reading usage,
downloading attachments so a suspended customer can still get their data out,
recovery, and removing a device. Suspending closes the organisation's live
connections. It is **a state, never a deletion** — nothing stored is touched, and
lifting it restores service. It exists so that an account whose text usage grows
far beyond its quota can be acted on by a human under the terms of service,
which is the only enforcement text ever gets: text sync itself is never blocked
by quota. Suspension is per organisation; a person's other memberships are
unaffected.

**Suspension is not the non-payment lever.** It was briefly written down as one,
and that was revised on 14 September 2026: a failed renewal drops the plan to
free instead, which stops what was being paid for without stopping a team from
working together over an expired card. Suspension stays what this section
describes — the lever a human reaches for, under the terms, for abuse, for usage
that degrades the service for others, and for a chargeback.

## When a plan shrinks

A plan can get smaller: a downgrade, a cancellation, or a failed renewal, all of
which end in a smaller plan rather than in a deletion. The account route accepts
the change **even when the organisation no longer fits**, and nothing is removed
to make it fit. Each limit then does exactly what it does for an account that
grew into it naturally, which is why no new enforcement was needed for any of
this:

| No longer fits | What happens to what is already there | What is refused |
|---|---|---|
| Seats | Every member keeps their seat and keeps working | New invitations and new joins, `ACCOUNT_FULL` |
| Storage quota | Every attachment still downloads | New uploads, 507 `QUOTA_EXCEEDED` |
| Attachments not in the plan | Every attachment still downloads | New uploads, 403 `ATTACHMENTS_NOT_INCLUDED` |
| Devices per seat | Every device on the roster stays | The next device to be added, `DEVICE_LIMIT`; a device not on the roster, close code 4003 |

Three properties hold this together and are worth stating so they are not
optimised away:

- **No read path consults a limit.** The blob `GET` branch checks folder
  membership and nothing else — no quota, no plan, no `attachments_enabled`, not
  even account status, since a suspended customer must be able to get their data
  out. This is what makes every row of that table true.
- **The collector is blind to billing.** Attachments are swept on one condition,
  that no client has vouched for the folder in the grace period, and then only
  after a second grace in quarantine from which any read restores them. No
  quota, plan or payment state appears anywhere in it. An abandoned
  organisation's attachments are reclaimed because nobody is using them, which
  is the only rule that is safe.
- **Seats and per-seat storage are coupled.** On a per-seat plan the quota is the
  per-seat amount times the seats allowed, so lowering the seat override lowers
  the storage with it. Say so when offering it; the customer will not infer it.

What is missing is **visibility**, not enforcement: nothing today reports which
organisations are sitting over a limit. Leniency is the deliberate posture, and
a report is what would let us revisit it on evidence.

## Unsharing a folder

An owner of a shared folder can unshare it: the server's copy goes, and with
it the edit history and the attachments, for everyone. What does not go is
anybody's notes. Every member keeps the files as they stand on their own
disk, as ordinary Markdown, and keeps the keys that opened them — so
unsharing takes nothing back that was already delivered; it ends the syncing.

Members are told at once rather than finding out later. The sync server sends
each socket subscribed to that folder one message naming it, the plugin stops
syncing the folder and says so, and the folder moves to *No longer shared* in
settings, where unmapping it is the last step. A member who was offline at the
time learns it from the folder listing the next time their settings pane asks.

There is no undo, and no way to share the same folder again: sharing it once
more makes a new folder, with new keys and an empty history.

Unsharing is offered to an owner and to whoever created the folder. The
creator is there because the server has always allowed them, and because a
role change can take an owner's ownership away: a folder must always have
somebody who can end it.

## Closing an organisation

An owner may close an organisation they own. It ends billing, stops sync, and
begins a retention window during which the close can be undone and attachments
can still be downloaded; after the window the organisation is purged. The window
exists for two reasons of equal weight: closures are regretted, and data
protection law expects a stated period rather than an indefinite one. A hosted
deployment states the number in its own terms and privacy notice, where a
customer can read it and hold the operator to it.

Closing touches no member's vault. The notes were always plain files on their
own disks, and that is what makes this safe to offer at all.

## Organisations, shards and moves

On the hosted service an organisation lives on one sync server, in the region
its owner chose. Folders can be shared only within an organisation, which is
what makes an organisation a unit that can be moved between servers without
splitting anything. When one is moved, the plugin is told to reconnect
elsewhere, edits made in the meantime stay in the local cache and are sent once
the move completes, and no update is lost or reordered. How you sign in and how
the plugin learns where your organisations live is `docs/identity.md`.

**Display names** are free text — spaces allowed, not unique — shown above your
cursor and in rosters. They are not identifiers; on the hosted service the
identifier is your verified email address, and members are added to a folder by
email or by picking them from the organisation's roster.

## Deleting a user

Two foreign keys point at a user and neither may simply cascade:

- `invite_tokens.used_by` is detached. The invite records that somebody joined
  and is worth keeping; the link to a user who no longer exists is not.
- `shared_folders.created_by` **moves to another owner or admin of the same
  account**, who is also added as a folder member so they can reach what they
  now own.

If there is nobody to move folders to, the delete is **refused**
(`LAST_OWNER_HAS_FOLDERS`, surfaced as `409`). Dropping the last owner would
strand folders whose storage nobody can free — the orphan case Phase 8 exists to
close.

## API

Any authenticated user, always their own account:

| Route | Returns |
|---|---|
| `GET /api/account` | the account, its resolved limits, usage, seats used, the roster of members (display names, emails, and `hasKeys` — whether a folder key can be wrapped for them yet), this member's devices (`devices`, each with the vaults it syncs from, a `connected` flag and `thisDevice`), `deviceSlots` (`used`, `max`, `thisDeviceEnrolled`), and `messages` — what the account view should say, decided server-side |
| `PATCH /api/account/me` | `{ displayName }` — the name shown above your cursor |
| `POST /api/account/devices` | add this device to the roster: `{ deviceId, deviceLabel?, devicePlatform?, installId?, installLabel? }`. 201 added, 200 already there, 409 `DEVICE_LIMIT` when the member's slots are all taken |
| `DELETE /api/account/devices/:deviceId` | remove one of this member's devices; frees the slot at once and closes that device's sockets with 4003 |
| `PATCH /api/account/devices/:deviceId` | `{ label }` — rename it, in this organisation |

An account's **owner or admin** (the `accountRole` on the row, never the token), and
only for their own account. An instance admin passes these too, so support can act
on any account with the same routes a customer uses:

| Route | Does |
|---|---|
| `GET /api/account/share-key` | reveals `{ shareKey, enabled }` |
| `PATCH /api/account/share-key` | `{ enabled }` — turn the standing invitation off or on |
| `POST /api/account/share-key/rotate` | replaces the key; anyone holding the old one can no longer join |
| `POST /api/account/invites` | `{ accountRole?: 'member' \| 'admin', email? }` — a one-person invite into this account; only the owner may mint an admin |
| `GET /api/account/invites`, `DELETE /api/account/invites/:token` | list and revoke this account's unredeemed invites |
| `DELETE /api/account/users/:id` | removes a member. Only the owner removes an owner; the last owner cannot be removed (`LAST_OWNER`, 409) |
| `PATCH /api/account/users/:id` | `{ accountRole }` — **owner only**; the last owner cannot be demoted |

Shared folders, for any member of the folder's organisation:

| Route | Returns |
|---|---|
| `GET /api/folders` | the folders this user belongs to, each with its sealed `name`, `nameKeyId`, `role`, and who shared it (`createdByDisplayName`, falling back to the username) |
| `GET /api/folders/:id/members` | every member: `userId`, `displayName`, `email`, `role`, and the `publicKey` a folder key is wrapped to (null until they enrol keys) |
| `POST /api/folders/:id/members` | **folder owner only**: `{ userId \| email \| username, role }` — someone already in this organisation; answers the member as above. The caller then wraps the folder keys for them. Naming an existing member changes their role, so naming the last owner with a lesser one is refused (409), as removing them is |
| `DELETE /api/folders/:id/members/:userId` | remove a member; the last owner cannot be removed |
| `GET /api/folders/:id/keys`, `POST /api/folders/:id/keys` | this member's wrapped folder keys, and publishing wraps for a member |
| `DELETE /api/folders/:id` | **any owner of the folder, its creator**, or the instance admin: unshare it. The server's copy goes — the folder row, every member, every wrapped key, the update log, the snapshots and the attachments — and the account's storage is credited back. Every member syncing it is told over its socket at once; nobody's local notes are touched |

Naming a user in another account on any of these gets the same 404 as naming
nobody, so none of them can be used to discover who has an account here.

**Instance admin** (`role = 'admin'`, the administrator of the whole server — on
the hosted service, us, and the control plane):

| Route | Does |
|---|---|
| `GET /api/admin/accounts[?status=]` | every account with plan, status, seats, pending invites and usage |
| `POST /api/admin/accounts` | `{ name, planId?, overrides? }` — an organisation with no users yet; provisioning, step one |
| `GET /api/admin/accounts/:id` | the account, limits, usage, users, invites, quota flags |
| `PATCH /api/admin/accounts/:id` | `{ planId?, status?, name?, notice?, overrides? }` — the single route commerce depends on. `null` clears an override or the notice. A status change closes the account's live sockets with the matching code in the same step; the transition table in `accounts.ts` refuses anything but `active ↔ suspended`, `→ migrating`, `migrating → active \| moved`, `moved → active` |
| `POST /api/admin/invites` | `{ newAccount? }`, or `{ accountId?, accountRole?: 'member' \| 'admin' \| 'owner', email? }` — an `owner` invite into a pre-created account is provisioning, step two |
| `GET /api/admin/users?accountId=`, `GET /api/admin/invites?accountId=` | instance-wide without the parameter, one account with it |
| `POST /api/admin/backup` | a verified online copy of the database into `BACKUP_DIR`, now |
| `POST /api/admin/test-error` | `{ sentinel? }` — sends one exception through error reporting carrying the sentinel beside a planted email address and vault path, so an operator can watch GlitchTip receive the first and not the others. 503 without a DSN |
| `GET /api/admin/shard-info` | which shard this is, its region, and which storage it uses (no credentials) |
| `POST /api/admin/accounts/:id/export`, `…/import`, `…/purge`, `GET …/summary`, `GET …/blobs` | carrying an account to another server. Export requires status `migrating` and waits for in-flight requests; import is one transaction that rolls back entirely on any mismatch and creates the account as `migrating`; purge is allowed only on `moved`. See `docs/identity.md` for what a move looks like from the user's side |

**Hosted mode only** (`IDENTITY_PUBLIC_KEYS` set; a self-hosted server answers
404 to both, so it never grows a second way in). Neither needs the identity
service to be reachable: the tokens are Ed25519 and verified against public keys
this server holds, so a sign-in works while the identity service is down and a
compromised shard cannot mint one.

| Route | Does |
|---|---|
| `POST /api/auth/session` | `{ identityToken, deviceId? }` — one shard session per membership held here, because a token carries an account and everything downstream resolves limits from it. `NOT_A_MEMBER` (403) when the identity has no seat here, `ACCOUNT_MOVED` (409) when its only one has left. The display name and address follow the identity |
| `POST /api/auth/join` | `{ identityToken, inviteToken \| shareKey \| newAccountName, publicKey? }` — takes a seat. `newAccountName` is the third form and the only one needing nobody else: it creates an organisation on `SELF_SERVE_PLAN_ID` with the caller as its owner, refusing past `MAX_SELF_SERVE_ACCOUNTS` (`TOO_MANY_ACCOUNTS`) and when that is 0 (`SELF_SERVE_DISABLED`). The other two: The invitation names an address and only that address may redeem it (`INVITE_WRONG_EMAIL`), and one addressed to another shard is refused (`INVITE_WRONG_SHARD`). Redeeming twice signs in rather than taking a second seat, and a *different* public key on the second attempt is refused rather than replacing the one members have already wrapped folder keys against |

**The identity service** (hosted only), with its own read-only token:

| Route | Does |
|---|---|
| `GET /api/admin/directory-manifest` | accounts, memberships, and **hashes** of share keys and unredeemed invites on this shard, with capacity numbers; `ETag`/304. Accounts that have `moved` are omitted, which is what makes them stop resolving here |

### Recovery, and the accounts that cannot use it

A user who forgets their password recovers with the recovery key issued at
registration. The server verifies possession before disclosing anything, using
`users.recovery_auth_hash` — a bcrypt of a value the client derives from the
recovery key alone, in the same shape as `auth_hash` is derived from a password.
Deriving it from the recovery key rather than from the master key it unwraps is
what allows proof to come before disclosure.

Two consequences worth knowing:

- **An account created before recovery existed has `recovery_auth_hash IS NULL`
  and cannot recover.** It cannot be backfilled: the server has never seen a
  recovery key and cannot derive one. Such an account is refused with the same
  message as a wrong key, so the endpoint stays useless for enumeration. The fix
  for a real account in that state is to re-register.
- **A reset keeps the old credentials, for an operator.** `user_key_history`
  retains the previous wrapped private key, recovery blob, parameters and
  hashes. The old password does **not** keep working — `replaceCredentials`
  overwrites `users.auth_hash` and login reads only that column. Nothing in the
  product reads the history table; it exists so that a reset that goes wrong is
  recoverable by hand rather than terminal, which is the same rule as conflict
  copies applied to credentials.

  *(An earlier version of this page said the old password keeps working. It
  never did.)*

### Restoring a superseded credential set

Manual, deliberately: it needs database access, and there is no route because
there is no safe way to expose "revert someone's password" over an API. On a
server with `sqlite3`:

```sql
-- Inspect what is available first. One row per reset, newest last.
SELECT id, superseded_at, datetime(superseded_at, 'unixepoch')
  FROM user_key_history WHERE user_id = 'USER-ID' ORDER BY superseded_at;

-- Restore the most recent superseded set.
UPDATE users SET
  kdf_params          = (SELECT kdf_params          FROM user_key_history h WHERE h.user_id = users.id ORDER BY h.superseded_at DESC LIMIT 1),
  auth_hash           = (SELECT auth_hash           FROM user_key_history h WHERE h.user_id = users.id ORDER BY h.superseded_at DESC LIMIT 1),
  wrapped_private_key = (SELECT wrapped_private_key FROM user_key_history h WHERE h.user_id = users.id ORDER BY h.superseded_at DESC LIMIT 1),
  recovery_blob       = (SELECT recovery_blob       FROM user_key_history h WHERE h.user_id = users.id ORDER BY h.superseded_at DESC LIMIT 1),
  recovery_params     = (SELECT recovery_params     FROM user_key_history h WHERE h.user_id = users.id ORDER BY h.superseded_at DESC LIMIT 1),
  recovery_auth_hash  = (SELECT recovery_auth_hash  FROM user_key_history h WHERE h.user_id = users.id ORDER BY h.superseded_at DESC LIMIT 1)
WHERE id = 'USER-ID';
```

The user's **previous password and previous recovery key then work again**, and
their identity keypair is untouched throughout, so no shared folder is affected
either way. Take a copy of the database first: this overwrites the current set
without archiving it.

Failed attempts increment `users.recovery_attempts` and are refused past
`MAX_RECOVERY_ATTEMPTS`, **for `RECOVERY_WINDOW_SECONDS` after the last
failure**. They are cleared on a successful recovery and on a successful
password login. The counter is per account because the IP-based limiters read
`X-Forwarded-For`, which the caller sets — but it decays, because a cap with no
decay and no route to clear it is not a rate limit, it is a way to lose an
account. The first version of this had exactly that defect.

### `accountRole` does not yet authorize anything

*(Historical as of 9 September 2026: the gap below is closed by account-scoped
authorization in Phase 13 stage 1 — an owner or admin can invite, remove and
promote within their own organisation and nowhere else. The text is kept until
the code lands, because it describes the server as it is today.)*

Every user carries an `accountRole` of `owner`, `admin` or `member`. It is set
at registration, and it is returned to clients. **No route reads it when
deciding whether to permit something.**

Authorization today is the *instance* `role`, so `/api/admin/*` means the
administrator of the whole server. On a single-tenant server that is the same
person as the account owner and nothing is missing. On a server holding several
accounts it means:

- **An account owner cannot invite anyone into their own account**, list its
  users, or remove one. Only an instance admin can.
- Instance admin cannot be delegated to them as a substitute, because
  `GET /api/admin/users` is not scoped to an account and would return every
  user on the server.
- Sharing a folder therefore needs a collaborator's exact username typed in,
  because a non-admin has no route that lists who else is in their account.

Nothing here is unsafe: the gap fails closed, refusing rather than
over-permitting. But it is why a server holding more than one account currently
needs an instance administrator for routine membership changes. Account-scoped
authorization is the fix, and `listUsers` already takes an optional account id
to scope by.

## Migration

Every user who predates accounts is given **one account of their own, which they
own**, on the default plan, named after them. Behaviour afterwards is identical
to before — that equivalence is the property that makes this safe to land before
anything depends on it.

The backfill runs on every start and is idempotent, in the same spirit as
`backfillFolderOwners`. `users` and `invite_tokens` gain their columns by
`ALTER TABLE`, guarded on `PRAGMA table_info`: SQLite cannot add a `NOT NULL`
column without a default, and a default would have to name an account that does
not exist yet, so both are nullable in the schema and made non-null by the
backfill. Everything past `initDb` may assume `account_id` is set.

## Known gaps

1. **Device counting is per organisation and in the database** since 14
   September 2026 — the roster — so a multi-process server would count
   correctly; only the `connected` flag is per process.
2. **A device is a machine**, as above; a vault on a machine whose shared
   storage is unavailable counts as its own device, and says so in its log.
3. **No billing integration.** Plans and limits are enforced; nothing charges a
   card, and moving an account between plans is a row update by an instance
   admin. What those calls have to do is settled — upgrade is one call on an
   organisation that already exists, and a downgrade, a cancellation and a
   failed renewal all end on the self-serve plan — but nothing drives them
   yet.
4. **No self-serve account management UI** beyond the account view — changing a
   plan, renaming an account and promoting a member are database operations.
5. **A plan change validates nothing against current usage.** Moving an account
   to a plan it does not fit is accepted, which is the intended behaviour above,
   but the route also says nothing about what will now be refused. Checkout has
   to work that out for itself until it does.
6. **Nothing reports an organisation over its limits.** Deliberate leniency with
   no way to see how much of it is being taken.
7. **Closure has no representation.** `purge` exists but is a move tombstone's
   cleanup and is allowed only on `moved`; a closed organisation and its
   retention window are unbuilt.
