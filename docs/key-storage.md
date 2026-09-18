# Where the keys live, and why

Phase 7 makes the server unable to read anything. That guarantee is only worth
what the client-side key storage is worth, so this records what is stored, what
an attacker gets from it, and what Obsidian actually offers — the last measured
against a running app rather than taken from documentation.

## What was stored

> This section describes the position **before** the changes below, which is
> what prompted them. For where things live now, see "What ends up where".

In `data.json`, in the vault, mode `-rw-r--r--`:

| Field | What it is |
|---|---|
| `masterKey` | The raw 32-byte master key, base64 |
| `folderKeys` | Raw name and content keys for every mapped folder |
| `keyMaterial.wrappedPrivateKey` | The identity private key, wrapped under `encKey` |
| `keyMaterial.recoveryBlob` | The master key wrapped under the recovery key |
| `token` | A valid JWT |

The wrapped fields are fine — they are sealed. The first two were not.

## What an attacker gets

The usual defence is that the notes are in the same vault anyway, so a reader of
`data.json` already has them in plaintext. That is true and incomplete.

`deriveEncKey(masterKey)` unwraps the identity private key with **no password**
(`session.ts`, `unlockIdentity`). So the master key yields, beyond the notes
already on disk:

1. **Folders never mapped in this vault.** The identity key unwraps any folder
   key the server holds for this account, including folders shared with them
   that this device has never opened.
2. **Everything future.** Every later update to every folder shared with the
   account, decryptable from server ciphertext indefinitely.
3. **Immediate server access**, from the token beside it.

It does not permit a password login — `deriveAuthHash` needs the password — but
the token makes that academic.

**The realistic threat is not malware.** Obsidian vaults are commonly synced
with Dropbox, iCloud or Syncthing. Where they are, `data.json` goes too, and the
master key lands on a third party's servers — which quietly undoes the property
this phase exists to provide. The user stops trusting the Nectenda server and
starts trusting a different cloud without being told.

## What Obsidian offers

`app.secretStorage`, `@since 1.11.4`. Measured directly against Obsidian 1.13.7
on desktop rather than assumed:

```
hasSecretStorage:       true
isEncryptionAvailable:  true
roundTrip:              works
localStorage:           "<vault-id>-secrets-encrypted", 70 chars
```

**It really is encrypted.** A unique marker was stored as a secret value and all
of localStorage scanned for it; the marker does not appear. A forum report of
secrets being kept in plain localStorage does not hold for this version.

**There is no isolation between plugins.** Our plugin wrote and then read a
secret under the id `dataview-api-key`, and `listSecrets()` enumerated both ids.
This is deliberate — the official guide describes a centralised store where "any
plugin can reference it by that name". Method surface is wider than the
typings: `isEncryptionAvailable`, `peekSecret`, `deleteSecret`, `getLastAccess`,
`recordAccess`, `validateId`.

From documentation, **not** independently verified: introduced in 1.11.0
(Dec 2025) and finalised in 1.11.4 (Jan 2026); backed by Electron `safeStorage`
onto macOS Keychain, Windows DPAPI or a Linux secret store; and secrets do not
sync between devices.

**Desktop is vault-scoped — measured, not assumed.** Obsidian 1.13.7 on macOS,
one `--user-data-dir` shared across two vaults, driven over CDP:

| | vault A (`30ad2be…`) | vault B (`bbbb2222…`) |
|---|---|---|
| wrote `nectenda-probe-marker` | marker A | marker B |
| `getSecret` returns | marker A | marker B |
| `listSecrets()` before writing | `['nectenda-probe-marker']` | `[]` |

The same secret id holds a different value in each vault, and neither vault can
read the other's. `localStorage` ends up with one encrypted blob per vault —
`30ad2be35dbc51fc-secrets-encrypted` and `bbbb2222bbbb2222-secrets-encrypted`,
94 bytes each — sitting side by side.

Raw `localStorage`, by contrast, **is** shared across vaults in one
installation — measured the same way, by writing a UUID under
`nectenda-device-id` in vault A and reading the identical value back in vault B.
That is the distinction the plugin depends on: `app.saveLocalStorage` namespaces
by vault id, while `window.localStorage` does not, which is what lets
`getOrCreateDeviceId` (`device.ts:41-56`) treat three vaults on one laptop as
one device while their secrets stay apart.

Both halves of that are load-bearing. The empty `listSecrets()` in vault B is
only meaningful because **vault A's blob is visibly present in the same
profile's localStorage at the time**, which proves the installation really was
shared rather than a second sandbox; and because vault B then wrote and read
back its own secret, which proves its store was working rather than broken. A
negative from the e2e harness could not say either: `wdio-obsidian-service`
gives every session a fresh `--user-data-dir`, so two vaults there are two
installations and cross-vault visibility is impossible by construction.

**So the two platforms genuinely differ**, and the difference is not a version
skew — 1.13.7 desktop and 1.13.8 Android. Desktop keeps one encrypted blob per
vault in `localStorage` under a vault-prefixed key — the store itself is shared,
the keys are not — while Android keeps the secrets in the Capacitor
`SecureStorage` plugin under a single constant key, with only the access-time
metadata scoped per vault.

### The vault scoping is namespacing, not a key boundary — measured

Obsidian's own desktop adapter, read out of `obsidian-1.13.7.asar`:

```js
n.safeStorage = window.electron.remote.safeStorage;
encrypt: safeStorage.encryptString(e).toString("base64")
save:    this.app.saveLocalStorage("secrets-encrypted", this.encrypt(...))
```

So `app.secretStorage` **is** Electron `safeStorage`. The per-vault property
comes entirely from `app.saveLocalStorage`, which prefixes the key with the
vault id. The encryption key itself is one OS keychain entry for the whole
installation.

Measured, same two vaults, same profile: a string encrypted in vault A and
written to **raw** `window.localStorage` decrypted correctly **in vault B**.

```
hasSafeStorage:      true        window.electron.remote.safeStorage
sameVaultRoundTrip:  true
cipherVisibleHere:   true        vault A's ciphertext, read from vault B
decrypted:           == plaintext written in vault A
garbageRejected:     true
acceptsUint8Array:   true        no Buffer, so no Node built-in needed
```

`garbageRejected` is the control that matters: a round trip which cannot fail
would be no evidence that the key did any work. Method surface is
`encryptString`, `decryptString`, their `…Async` variants,
`isEncryptionAvailable`, `isAsyncEncryptionAvailable` and
`setUsePlainTextEncryption` — that last is how a caller opts *into* an
unprotected store on Linux and must never be called.
`getSelectedStorageBackend` is Linux-only, so its absence on macOS is expected;
where it exists, a `basic_text` backend means a hardcoded key rather than the
OS keyring and must disqualify the slot.

**What this buys.** Encrypting with `safeStorage` and storing under a fixed key
in raw `window.localStorage` gives a slot that is device-wide, OS-encrypted and
outside the vault — the only way to ask for a passphrase once per machine
rather than once per vault. It is not new crypto and not a new trust
dependency: it is the store Obsidian already uses, with the vault id taken out
of the key name. `window.electron.remote` is undocumented for plugins, so it
must be feature-detected with a fallback; Obsidian relies on it in 36 places
and it was already present in 1.9.14.

### When the passphrase is asked

Once per device, at sign-in — but only where the key can be kept. A Cloud
sign-in that finds existing key material confirms the passphrase immediately,
so the folders are open by the time anyone looks at them.

Where there is **no credential store** the confirmation is skipped, because
there is nothing to confirm *for*: `rememberIdentity` writes nothing and
`restoreIdentity` finds nothing, so asking at sign-in would only move that one
session's single prompt earlier while every later start still asks lazily. Such
a device is asked when a folder needs the key. The same condition decides
whether the settings pane treats "no key open" as a fault or as the ordinary
state it is there.

It used to be asked lazily everywhere. Several paths reached a
signed-in-but-locked state with no prompt at all — the membership refresh
rewrites key material at every start — and the only symptom was folders reading
as "Locked" with nothing saying why.

**A wrong passphrase is retried, not punished.** The prompt stays open, says
what happened and clears the field. Nothing on this path signs anybody out.
It briefly did, and that was wrong: the sign-in's failure path is a full
sign-out, which retires the session on the identity service, drops the refresh
token and the device-held key, and **discards every folder mapping** — so one
mistyped character cost a fresh round of authentication plus re-mapping every
folder by hand.

Giving up instead leaves the device signed in and **locked**, which the settings
pane states rather than leaves to be inferred: an Encryption row says the
folders are locked and offers *Enter passphrase* and *Forgot passphrase?*, with
*Sign out* already beside the account.

The rest of the pane stays. Hiding it was considered and rejected: a locked
device can still do real work — browse its organisations, see what is synced,
unmap a folder, manage its devices — and the pane already degrades honestly,
showing *Some folder names are hidden* with a **Show names** button and an
*Unlock* button beside each locked folder. Removing all that would take away
more than it protected.

**What is verified is the key, not just the passphrase.** Opening the stored
blob proves the passphrase, because AES-GCM fails its tag on a wrong one. It
proves nothing about the two halves belonging together, since they are imported
independently and the public half cannot be derived from an ECDH private key.
So a wrap to the public key is opened with the private key, on both the prompt
path and the device-store path. A mismatch means the material is corrupt or was
substituted; it says so, and is the one failure that does **not** offer another
attempt, because trying again cannot help.

### Guessing at the prompt, and why there is no lockout

Wrong attempts are answered by an escalating pause — the first two free, then
one, two, four seconds, capped at eight — and by nothing else. There is no
attempt limit and no lockout, deliberately.

An attempt limit here would protect nothing. `data.json` holds the salt, the
iteration count *and* the wrapped private key, so anybody who can open this
dialog can equally copy that file and grind offline on a GPU, at a rate no
counter in the plugin can influence. `deriveMasterKey` even honours the
iteration count *stored in the file* rather than the constant, so an attacker
holding it can lower the cost themselves. The pause is a speed bump against
somebody trying a few guesses at an unattended machine, and is described as
nothing more.

Nor is the KDF the backstop it is sometimes assumed to be: 600,000
PBKDF2-SHA256 iterations measure at about **40ms** on an M-series Mac — roughly
24 guesses a second, not the "hundreds of milliseconds" the comments used to
claim. What actually protects the key is the passphrase's own entropy.

Set against that, a lockout has a real cost: it can shut the owner out of their
own folders, which is the trade this project does not make. Verification is
entirely local on the hosted service — nothing derived from the passphrase is
ever sent — so retrying costs no round trip and no server-side limiter ever sees
an attempt. A self-hosted unlock fetches its KDF parameters once, before the
prompt opens, so retrying cannot walk into that endpoint's rate limit either.

Self-hosted is otherwise unaffected: the login password *is* the passphrase, so
the identity is unlocked at login.

### Where the identity key is held, and what that costs

The unwrapped identity key is kept for the **installation**, not the vault:
encrypted with `safeStorage` and written to raw `window.localStorage`, which
every vault of an installation shares. On mobile the ordinary secret store is
already installation-wide, so it is used as-is. Where neither is available —
a Linux box with no keyring — nothing is held and the passphrase is asked, which
is the one place this must not fall back to `data.json`.

It is keyed by the account's public-key fingerprint, because two vaults on one
machine can be signed into two different accounts. The public key travels in the
blob and is checked on the way back, so a stale or planted entry reads as a miss
and is deleted rather than tried.

**What it costs.** The key opens every folder shared with the account, including
ones this vault has never opened and ones shared in future — the escalation this
document describes removing from `data.json`. It is now behind the OS credential
store instead, which is what adopting that store was for. It is **not**
revocable: the keypair is never rotated, and `enrolKeys` will only write a
public key `WHERE public_key IS NULL`, so no route can replace it.

What makes that bearable is that the key is inert alone. Its only use is
unwrapping envelopes fetched from the server, so revoking the session removes
the thing that makes it useful; a device that never reconnects has no server
access either. Signing out deletes it, forced sign-outs included.

**What it removes.** Before this, quitting Obsidian dropped the unwrapped key
even on a device that never came back — the only offline limit anywhere in the
product, since every withdrawal path is online and server-mediated. That limit
is gone and nothing replaces it. A time limit on the held key was considered and
rejected: the key is inert without server access, and remote sign-out lands
within about a minute of a device reconnecting.

### What it does on Windows — measured

Obsidian 1.13.7 on Windows 11 Pro x64, same probe, same controls:

```
window.localStorage       SHARED      same as macOS and Linux
app.saveLocalStorage      per vault
app.secretStorage         per vault
isEncryptionAvailable()   true        DPAPI
getSelectedStorageBackend method absent  (Linux-only, as expected)
cross-vault decrypt       SUCCEEDS
garbageRejected           true
acceptsUint8Array         true
```

**Windows agrees with macOS: the key is per installation, not per vault.** So
the device-wide slot is available on both platforms that have a working OS
credential store, and `Uint8Array` works on both, so no Node built-in is needed
anywhere.

That completes the desktop picture. Every platform gives the same three scopes;
the only thing that varies is whether a credential store exists to encrypt with.

### What it does on Linux with no keyring — measured

Obsidian 1.13.7 on Ubuntu 24.04 under WSL2, on a box with **no keyring at all**:
no `libsecret` installed, no session D-Bus, `XDG_CURRENT_DESKTOP` empty, and
`DBUS_SESSION_BUS_ADDRESS` set to a socket that does not exist. About as
hostile a configuration as a real Linux machine offers.

```
window.localStorage       SHARED      same as macOS
app.saveLocalStorage      per vault   same as macOS
app.secretStorage         per vault   same as macOS
isEncryptionAvailable()   false
getSelectedStorageBackend basic_text
encryptString             throws: "Encryption is not available."
```

**Electron fails closed, and the widely-repeated warning is wrong.** Published
reports say `isEncryptionAvailable()` returns *true* for `basic_text`, which
would mean any code gating on it believes secrets are protected when they are
not. That is not what happens: the backend is selected as `basic_text` **and**
availability reports false **and** encryption refuses. Backend selection and
encryption availability are separate signals, and the reports conflate them.

So `createSecretStore`, which gates on `isEncryptionAvailable()`, gets the
correct answer here and falls back to the vault file. It is not over-claiming.
This also matches what the CI container was already observed to do.

**The dangerous state is real but opt-in.** `setUsePlainTextEncryption(true)`
is the documented switch that makes `basic_text` usable — after it,
availability would be expected to report true while the key remains the one
published in Chromium's source. Obsidian never calls it: zero occurrences in
the 1.13.7 bundle. Neither must this plugin. But it is a process-wide setting
on a global any plugin can reach, so the backend check stays as defence in
depth rather than being dropped now that availability looks trustworthy.

Two things this run did **not** establish. `isAsyncEncryptionAvailable` and the
`…Async` variants were never called and must not be assumed to mirror the sync
ones; Obsidian does not use them either. And a Linux box *with* a working
keyring is still unmeasured — this is the fallback case, deliberately measured
first because installing a keyring destroys it.

Incidental, and worth knowing before anyone tries this: **a stock WSL2 cannot
run an Electron app at all.** `libnspr4`, `libnss3`, `libnssutil3`, `libsmime3`
and `libasound.so.2` are all absent, which is why the CI action installs that
same set.

### What it does on Android — measured

Obsidian **1.13.8**, Android 16, on an emulator, probed inside the running
app. It is a different implementation from desktop, not the same one reached
through a phone:

```
hasSecretStorage:       true
isEncryptionAvailable:  true          <- hardcoded; see below
roundTrip:              works
deleteSecret:           present, returns true, read-back is null
marker in localStorage: no            <- mutation-checked
marker in vault tree:   no            <- mutation-checked
survives force-stop:    yes
shared across vaults:   yes
```

**`isEncryptionAvailable()` means nothing on mobile.** Its implementation is
`!(this.adapter instanceof DesktopAdapter) || this.adapter.isEncryptionAvailable()`,
and the mobile adapter is a different class, so the first clause short-circuits
and it returns `true` without testing anything. Feature-detecting on it — which
is what `createSecretStore` does — can therefore never be false on a phone. The
same expression also gates Obsidian's own "secrets are not encrypted" warning,
so that warning cannot fire on mobile either.

**Storage is the Capacitor `SecureStorage` plugin**, confirmed in
`Capacitor.Plugins`. Only the access-time metadata goes to `localStorage`, under
`<vault path>-secrets-meta`; the secrets themselves go through the native plugin
under a single constant key. Nothing lands in the vault: a unique marker was
stored as a secret and the whole vault tree grepped for it, with the grep
mutation-checked by planting the same marker and finding it. So a vault sync
does not carry secrets on Android — the property this phase exists to protect.

**All three storage scopes, measured on both platforms.** The same probe wrote
one value through each API in vault A, then read it back in vault B of the same
installation:

| scope | desktop 1.13.7 | Android 1.13.8 |
|---|---|---|
| `window.localStorage` (raw) | shared | shared |
| `app.saveLocalStorage` / `loadLocalStorage` | per vault | per vault |
| `app.secretStorage` | **per vault** | **shared** |

Only the last row differs, which is the whole of the platform divergence. The
middle row is what makes each reading trustworthy: `loadLocalStorage` returned
`null` in vault B on both platforms, so the two vaults really were distinct —
a shared reading elsewhere cannot be the probe accidentally talking to the same
vault. The first row is what `getOrCreateDeviceId` (`device.ts:41-56`) depends
on, and it holds everywhere: three vaults on one machine are one device.

**Secrets are shared across vaults on Android.** The report that used to sit in
this paragraph as hearsay is correct. A second vault was created and opened, and
`listSecrets()` there returned every secret written by the first — the plugin's
`nectenda-token`, `nectenda-folder-keys` **and `nectenda-device-id`** included.
Desktop is vault-scoped; mobile is not.

That last id is the one with a behavioural consequence rather than only a
privacy one — but a narrower one than it first looks. The plugin keeps **two**
ids (`device.ts:5-38`): the *device* id in raw `window.localStorage`, and the
*install* id in the secret store. Only the second is affected. On Android two
vaults share the install id, so they are one session to the identity service
where on desktop they would be two; the device id, and therefore the seat
count, is right on both platforms.

Combined with the absence of plugin isolation, anything cached on a phone is
readable from any vault and any plugin on that device.

**Not verified, and not to be claimed.** Whether Android encrypts at rest: the
marker's absence from the vault and from `localStorage` was confirmed, but
reading the app-private store needs root, which a Play-image emulator does not
give. So the vault-sync exposure is closed on Android and the stolen-disk case
is **unknown**. The emulator is also not a physical device.

### iOS — still unmeasured

Nothing here has been checked on iOS, and it cannot be checked without a
physical iPhone or iPad: Obsidian ships only as a FairPlay-encrypted App Store
binary, which no simulator or iOS VM will run.

## What this changes, and what it does not

Secret storage closes the exposure that matters most: nothing sensitive sits in
a file that a vault sync carries off the device.

It does **not** defend against another plugin, by design. That is not a
regression — any plugin can already read `data.json` — but it means secret
storage is not a complete answer and should not be described as one.

Adopting it needs `minAppVersion` at 1.11.4 or above, which is a hard gate, so
it is feature-detected (`app.secretStorage` present *and*
`isEncryptionAvailable()`) with a fallback rather than resting on the version
alone. `manifest.json` has since gone to **1.13.7** (`b49160a`), above that
floor, so the fallback currently has no audience Obsidian would let install the
plugin — but see the Android note above: the second half of that detection is
vacuous on mobile.

## Decisions

### Implemented

Both decisions below are done. Secrets are chosen at runtime by
`createSecretStore` (`secret-store.ts`): the keychain when `app.secretStorage`
exists *and* `isEncryptionAvailable()` is true, otherwise the plugin's
data.json. Existing secrets migrate into the keychain on the next start, so a
user who upgrades Obsidian past 1.11.4 is moved across without being asked.

Both branches are tested against real Obsidian binaries, and they take
genuinely different paths:

| Obsidian | store | API present | encrypts | token in file | folder keys in file |
|---|---|---|---|---|---|
| 1.9.14 | `vault-file` | no | — | yes | yes |
| 1.13.7 | `keychain` | yes | yes | **no** | **no** |

1.9.14 is used for the older case because every 1.11.x build below .4 turns out
to be a beta requiring an Insiders account — and it is the version this
project's own vaults run, so it is the one that matters.

### What ends up where

| | pre-1.11.4 | 1.11.4+ |
|---|---|---|
| **master key** | **not stored** | **not stored** |
| **passphrase** (Cloud) | **not stored, never sent** | **not stored, never sent** |
| token (self-hosted) | `data.json` | keychain |
| refresh token, identity access token (Cloud) | `data.json` | keychain |
| sync-server session tokens, one per organisation (Cloud) | `data.json` | keychain |
| folder keys | `data.json` | keychain |
| **identity key, unwrapped** | **not held** | **held for the device** |
| wrapped private key | `data.json` | `data.json` |
| recovery blob | `data.json` | `data.json` |

The master key is not stored anywhere on any version, keychain included. It is
derived from the passphrase when a device signs in, held in memory for that
session, and gone when Obsidian closes. On Nectenda Cloud the passphrase is
used for that derivation and for nothing else: no authentication hash is
derived from it, and nothing derived from it is sent anywhere — identity is
proved separately, at the identity service. `SECRET_IDS` names every entry
that can reach the keychain: the self-hosted token, the folder keys, the
install id (the vault's own, which a sign-in belongs to; the machine-wide
device id an organisation counts lives in the installation's shared storage
instead, and is not a secret either), and the three Cloud tokens.

The Cloud tokens are bearer credentials, not keys. A refresh token signs the
device in to the identity service for ninety days and can be revoked from any
other signed-in device; a sync-server session lasts seven days, is re-issued
from the identity token, and stops being accepted within about a minute of
the device being signed out. None of them can decrypt anything on their own —
they reach ciphertext, and the copy of the private key in `data.json` is
wrapped and opens only with the passphrase. The *unwrapped* key is a separate
thing and is held for the device where the OS provides a credential store; see
below.

The last two rows stay in the file deliberately: both are already sealed. The
wrapped private key opens only with `encKey`, derived from the master key, and
the recovery blob only with the recovery code. Neither is worth anything to
someone reading the file, so there is nothing to gain by moving them.

The two changes are independent and compose. Dropping the master key removes the
*escalation* — a stolen `data.json` no longer yields folders never mapped on
that device, nor the ability to decrypt anything written later — and it applies
on every Obsidian version. Secret storage then removes what remains from the
file, which only helps from 1.11.4.

Below 1.11.4 the token and folder keys are still in the file and still travel
with a vault sync. What they unlock is limited to folders whose notes are
already sitting in that same vault in plaintext, which is precisely why the
master key went first.

### Decisions

1. **Do not cache the master key.** Still the rule, and the master key is still
   stored nowhere. **Superseded in part:** the *identity key* it unwraps is now
   held for the device where the OS provides a credential store, so the
   passphrase is asked once per machine rather than once per vault. The
   reasoning below is why the master key itself stays uncached — it additionally
   opens the recovery path and, with the password, a self-hosted login, none of
   which the identity key reaches.

   It is prompted for when needed rather than
   kept. This said `loadFolderKeys` was "its one consumer after startup", which
   stopped being true when **Show names** was added: that calls `ensureIdentity`
   directly to read the sealed names of folders shared since the last unlock, so
   a prompt can now be raised to render a list rather than only to join a folder.
   The decision stands; the cost is higher than it was written to be. Folder keys stay cached, and they unlock only folders
   whose notes are already on disk, so a stolen `data.json` yields nothing the
   vault did not already contain. This helps every user on every Obsidian
   version and costs nothing in normal use.
2. **Then move what remains into secret storage**, feature-detected, falling
   back to `data.json` where unavailable.
3. **Say what the guarantee is.** Against a reader of the vault's files: strong
   after (1) and (2). Against another plugin in the same vault: none, and no
   storage choice available to us changes that.
