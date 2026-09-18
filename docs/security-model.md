# What Nectenda's server can and cannot see

Nectenda is end-to-end encrypted: **the server stores an append-only log of
ciphertext it has no key for.** This document says exactly what that does and
does not cover, because a privacy claim you cannot check is worth very little.

Every claim below is checkable against the client, which ships as readable
JavaScript — see *Checking this yourself*. If a claim and the code ever
disagree, the code is right and this document is a bug.

The cryptographic parameters are stated exactly, because a security document
that hides them is asking to be trusted rather than checked. What is left out
is our server's internal shape — table and column names, internal function
names — which tells you nothing about whether the encryption holds and rather
more than it should about where to push on a system nobody has audited yet.

> **Scope.** This describes the cryptography and what the server holds. It is
> not a promise about a particular deployment's logging, retention or
> jurisdiction; those belong in a privacy policy and are not verifiable from
> code by anyone.

---

## The short version

| | Server sees |
|---|---|
| Note content | **No** — AES-256-GCM ciphertext only |
| Note and folder *paths* | **No** — document ids are HMACs of the path |
| Attachment content | **No** — sealed in a chunked AEAD envelope |
| Attachment filenames | **No** — they live inside the encrypted listing |
| Your passphrase | **No** — on the hosted service, never sent in any form; a self-hosted server receives an independent derivation that cannot yield the key |
| Your private key | **No** — stored wrapped, unwrappable only by your password |
| Folder display names | **No** — sealed under the folder's content key |
| Who shares a folder with whom | **Yes** |
| Sizes, timing, device and account records | **Yes** |

## Why you do not have to trust the server

The keys never reach it.

**Your passphrase never leaves the device.** It is stretched with PBKDF2-SHA256
at 600,000 iterations into a master key. That key is never sent and never
stored. On the **hosted service nothing derived from it is sent either**: you
sign in by a code to your email, a passkey, or a provider account, and the
passphrase is used only to unwrap your keys locally — see `docs/identity.md`. A
**self-hosted server** uses the passphrase as its login password too, by split
derivation: it receives a *second, independent* derivation, which cannot be used
to derive the encryption key, and bcrypts even that before storing it, because
it is still password-equivalent for logging in.

**Your identity key is wrapped before it is uploaded.** A P-256 ECDH keypair is
generated on device; the private half is encrypted under a key derived from the
master key, and only then stored server-side. The server holds a blob it cannot
open.

**Folder keys are wrapped to each member individually.** Sharing a folder means
sealing its content key to the recipient's public key using ECIES over P-256,
with a fresh ephemeral keypair for every wrap. The server stores ciphertext,
one record per member, and never handles an unwrapped folder key.

**Folder names are sealed too.** A folder called "Redundancy consultation —
legal" says as much as the notes inside it, so the name is stored as ciphertext
under the folder's content key, alongside a note of which key generation sealed
it. It cannot be null and the create route refuses an unsealed name: there is
no such thing as a folder whose name the server can read.

**Document ids are HMACs, not paths.** A document is addressed as its folder id
followed by `HMAC-SHA256(nameKey, relativePath)` truncated to 16 bytes. The
server cannot reverse it and therefore never learns your folder structure or
note titles. The name key is wrapped to members like any other folder secret,
and is deliberately separate from the content key so that rotating content keys
does not rewrite every id in the log.

**Content is encrypted before it is pushed.** Each update is sealed with
AES-256-GCM, IV prepended, 28 bytes of overhead. Attachments use a chunked
envelope whose additional authenticated data binds the blob id, the chunk index,
the total chunk count and the algorithm, so a reordered, truncated or
substituted chunk is rejected rather than decrypted.

## The attack this does not stop by itself

Encrypting content protects you from a server that **reads**. It does not, on
its own, protect you from a server that **actively interferes**.

When you add a collaborator, your client asks the server for their public key
and wraps the folder key to it. A malicious server could return *its own* public
key instead. You would be sharing with the operator, and everything would look
normal.

**The defence is fingerprint comparison, and it requires you to act.** The
folder members screen shows a fingerprint for every member and for you. Compare
them
with your collaborators through any channel that is not this server — in person,
a phone call, a different messenger. If they match, no key was substituted.

This is the same mechanism as Signal's safety numbers and Threema's QR
verification, and it carries the same caveat: **it only works if somebody
checks.** Until then the guarantee holds against an operator who reads, not one
who interferes.

## What is not encrypted

Stated plainly, because a security document that only lists strengths is
marketing.

- **The membership graph.** Which accounts share which folders, and when they
  were added.
- **Account and identity records.** Username and email, account, plan, and role.
- **Device records.** A device id, a label, and the platform string, with
  first- and last-seen timestamps. The label a vault sends for itself is
  generic and not derived from anything you wrote — the platform plus four
  characters of the install id, so that two vaults on one machine are
  distinguishable on the roster. `describeInstall` in
  `packages/plugin/src/device.ts` is the whole of it.
- **How many people are in a folder, and when it was last written to.** Shown
  on the folder's row so that two folders carrying the same name can be told
  apart and an abandoned one recognised. Neither is new: any member could
  already list a folder's members, and update timings are the "sizes and
  timing" already recorded below. A folder's *size* is shown only to the
  account billed for it.
- **A folder's name, sealed, and re-sealed when its owner renames it.** The
  name is encrypted under the folder's own content key, as it always was; a
  rename replaces one ciphertext with another and the server can read neither.
  Only the folder's owner may change it, and it changes nothing but what the
  settings pane displays — no member's folder is moved and no file on any device
  is touched.
- **A sealed vault name, which is not a device record we can read.** So that
  your own device list names its rows rather than showing the same generic
  label twice, each vault also sends its real name ECIES-wrapped to your
  account's identity public key — `sealVaultLabel` in the same file, using the
  `wrapSecret` that seals folder keys. Every vault signed into your account
  opens it; the server has no key for it, and a client that cannot open one
  falls back to the generic label. Reading it needs your passphrase to have
  been entered, because that is what unwraps the identity key.
- **Sizes and timing.** Every update's byte length and arrival time, every
  attachment's encrypted size, and per-account usage totals.
- **Anything the network sees.** IP addresses and connection times, as with any
  service.
- **Recovery material.** Your master key wrapped under your recovery key, and the
  parameters needed to derive from it. Both are stored, both are opaque without
  the key, and the previous set is kept when you change your passphrase rather
  than being deleted.
- **Your identity record**, on the hosted service. Your verified email address,
  the opaque subject id of each sign-in provider you linked, the public half of
  each passkey, your display name, and which organisations you belong to. Share
  links and invitations are held as hashes only. What the identity service can
  and cannot do with this is spelled out in `docs/identity.md`.
- **Attachment ciphertext at a storage provider.** On the hosted service sealed
  attachments live with an object-storage provider in your organisation's region
  and are fetched from it directly by your devices. The provider sees ciphertext,
  opaque object ids, sizes and access timing — nothing the server does not also
  see. The privacy policy names the provider for each region.
- **Error reports from the server.** When the hosted server hits an unexpected
  error it reports it to an error tracker we run ourselves. Reports carry
  account and folder identifiers, never content, paths, names, tokens or key
  material; the scrubber that enforces that is
  `packages/shared/src/scrub.ts`, and it is tested by planting a forbidden
  string and confirming it does not arrive. If readable content ever appeared
  in a report, that would be an incident, not a policy question.
- **Error reports from the plugin**, when you are signed in to the hosted
  service and have not turned them off. This is the one thing on this list the
  client sends about itself, so it is worth being exact.

  A report is built from an allowlist rather than filtered: the code
  constructs each field by name and nothing else can appear. It carries the
  exception type, its message, stack frames as line and column numbers, your
  plugin and Obsidian versions, the platform string, and the install
  identifier every request already carries. It carries **no** context object
  of any kind — which matters, because the plugin's own logs pair a note's
  path with its document id, and that pairing is the one thing that would
  undo the HMAC above. The message and every frame then go through the same
  scrubber the server uses, because vault paths reach a stack trace through
  `Error.message`.

  Frames name our own published file, never a path on your disk. The build is
  unminified, so a line number is enough to find the code and no source map
  is ever uploaded. `packages/plugin/src/error-report.ts` is the whole of it,
  about a hundred lines, with no error-reporting SDK behind it — an SDK would
  own the payload and we would be subtracting from it, which is the wrong way
  round for a claim like this one.

  It is on by default and nothing is sent until you have been shown what a
  report contains. There is no endpoint compiled into the plugin: the address
  is handed to it by the server it signed in to, so **a self-hosted
  deployment reports nothing because there is nowhere to send it**, not
  because of a setting. You can turn it off under Settings → Nectenda →
  Troubleshooting, and reports are deleted after 90 days.

### Forgetting your password

There is a way back, and it is the recovery key you were shown once at
registration. Nothing else works: your password is not stored, and it is not
merely checked but *used* — it derives the key that unwraps everything — so no
administrator, and no amount of access to the server, can reset it for you.

Asking to recover discloses nothing until you prove you hold the key. Requesting
recovery parameters for a username returns only derivation parameters, and
returns plausible ones even for accounts that do not exist, so it cannot be used
to find out who has an account here. The wrapped key itself is released only
after the server has verified a proof it cannot forge, and failed attempts are
counted against the account rather than the network address they arrive from.

Recovering does not change your identity key, so every folder shared with you
stays readable afterwards. It does issue a **new** recovery key, because the old
one no longer opens anything — save it as you saved the first.

**Traffic analysis is real.** Sizes and timing alone can reveal that a document
is being actively edited, roughly how large it is, and who was connected at the
time. End-to-end encryption does not hide that, here or anywhere else, and no
amount of auditing the client will tell you what a server chooses to retain.

If that metadata is what you need to protect, the answer is not cryptography —
it is running the server yourself.

### Unsharing a folder

An owner can unshare a folder, which deletes the server's copy: the
ciphertext, the edit history, the attachments. It does not reach into anyone's
vault. Every member still holds the notes as plain files and still holds the
keys that opened them, so unsharing is not a revocation of anything already
delivered — the same limit as removing a member, and for the same reason: what
someone has read, they have.

## What we do not claim

- **Not audited.** No external security audit has been carried out. The design
  follows standard constructions and is covered by unit tests, but that is not
  the same thing and should not be presented as if it were.
- **No forward secrecy for stored history.** The append-only log is encrypted
  under the folder's current content key generation. Someone who obtains a
  content key and a copy of the log can read the history that key covers. Key
  rotation limits the window; it does not erase the past.
- **No protection against a compromised device.** Keys live in the OS keychain
  where available (`docs/key-storage.md`); malware running as you can read what
  you can read.
- **Your passphrase is confirmed when a device signs in.** A new device asks for
  it straight away and checks it really opens your key, rather than waiting
  until a shared folder needs it. Getting it wrong just asks again — a wrong
  passphrase never signs you out — and closing the prompt leaves the device
  signed in with your folders locked, with *Enter passphrase*, *Forgot
  passphrase?* and *Sign out* offered in settings, and folder names shown as
  hidden until you do. A device with no operating
  system credential store is not asked at sign-in at all, because it has nowhere
  to keep the answer; it asks when a folder needs the key.
- **Guessing the passphrase is limited by the passphrase, not by us.** Wrong
  attempts meet a short escalating pause, capped, with no lockout. We do not
  claim more: the wrapped key and its parameters sit in the vault's plugin
  folder, so anybody who can reach the prompt can also copy that file and guess
  offline as fast as their hardware allows. A lockout would not change that, and
  could shut you out of your own notes. Checking a passphrase never contacts a
  server, so nothing we run can see, count or throttle an attempt.
- **Your key is kept for the device, not just the session.** So that the
  passphrase is asked once per machine rather than once per vault, the key that
  opens your folders is held in the operating system's credential store — not in
  your vault, so syncing the vault does not carry it. It opens every folder
  shared with your account, including ones this vault has never opened. Signing
  out removes it, and so does signing the device out from elsewhere. It cannot
  be revoked on its own: it is only useful for fetching from the server, so
  ending the session is what withdraws it.
- **No isolation from other Obsidian plugins.** Secret ids are global to the
  app, so any plugin you install can read the keys this one stores. That is
  Obsidian's design and no storage choice available to us changes it — a plugin
  could read `data.json` regardless.
- **Vaults are not isolated from each other on Android.** On desktop each vault
  has its own secret store. On Android every vault of the app shares one, so the
  session token and the folder keys of one vault are readable from another on
  the same phone, and signing one vault in signs them all in. Measured, not
  assumed. If you keep vaults apart on a phone for separation, that separation
  is not cryptographic.
- **Read-only membership does not exist.** A member holding the folder content
  key can always write, whatever any server-side role says. See
  `docs/sync-limitations.md` — it is a direct consequence of E2EE, and any role
  we enforce server-side is a convenience, not a security boundary.

## Checking this yourself

The client is the whole trust anchor, and unusually for an encrypted product,
**you can read the exact code that runs**. Obsidian plugins ship as JavaScript:
`main.js` is on your disk, in your vault, at
`.obsidian/plugins/nectenda/main.js`. There is no compiled binary and no
reproducible-build problem to reason about — the file that executes is the file
you can inspect.

This is also why **there is no Nectenda web app, and will not be one.** A web
page is delivered fresh by a server on every visit, and can be delivered
differently to different people, so "read the code that runs" is not a promise a
browser-based product can keep. Everything that touches your password, your
master key, your identity key or a folder key happens in the plugin on your
disk. Anything of ours you reach in a browser — a marketing page, a checkout,
an invoice — never sees any of them, and cannot create or recover an account.

That boundary is a deliberate limit on the product, not an accident of what has
been built yet. It is the reason the claim above holds.

Worth checking, in rough order of value:

1. **That plaintext never leaves.** Every push goes through `encrypt` before it
   reaches the socket — see `packages/plugin/src/multiplexed-provider.ts`.
2. **That paths are not sent.** Document names are derived by `deriveDocId`;
   grep the traffic for a note title and you will not find one.
3. **That the server's copy is unreadable.** If you self-host, attach to your
   own server's database and read the stored update payloads. They are opaque
   without a folder key.
4. **That fingerprints match** what your collaborator sees.

### That the file you installed is the source you read

The above assumes the `main.js` in your vault corresponds to the published
source. You do not have to assume it. Every release carries the SHA-256 of its
`main.js`, and the source it was built from is the repository the release lives
in, at that tag:

```sh
git clone https://github.com/Nectenda/nectenda-plugin && cd nectenda-plugin
git checkout <the release tag>
node scripts/verify-build.mjs --built ~/vault/.obsidian/plugins/nectenda/main.js
```

It rebuilds and compares byte for byte. On a difference it reports the offset
and prints both sides around it, because "they do not match" does not
distinguish a differing esbuild version from a differing cipher — and those
deserve very different reactions.

**The licence does not restrict any of this.** The plugin is source-available
under PolyForm Shield 1.0.0: reading, auditing, building and comparing are
expressly permitted. What is withheld is the right to build a competing product,
which is not something verification requires. If anything the check matters more
now than it did under MIT — having narrowed what you may *do* with the code, the
claim rests entirely on what you can *check*.

---
