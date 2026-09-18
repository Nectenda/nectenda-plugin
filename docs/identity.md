# Signing in, and what the identity service can and cannot see

Nectenda's hosted service separates **who you are** from **what encrypts your
notes**. This document says exactly how, in the same spirit as
`docs/security-model.md`: every claim here is checkable against the plugin, which
ships as readable JavaScript, and if a claim and the code disagree, the code is
right and this document is a bug.

> **Scope.** This describes the hosted service at `accounts.nectenda.com`. A
> self-hosted server works differently and more simply; the difference is stated
> at the end, with the reason.

---

## The short version

| | Hosted service holds |
|---|---|
| Your encryption passphrase | **No** — never sent, in any form |
| Anything derived from your passphrase | **No** — not a hash, not a verifier, nothing |
| Your email address, verified | **Yes** |
| Which sign-in providers you linked | **Yes** — the provider's opaque subject id |
| Your passkeys | The **public** half only |
| Your display name | **Yes** |
| Which organisations you belong to, and your role in each | **Yes** |
| Your private key | Wrapped under a key derived from your passphrase — opaque |
| Share keys and invite tokens | As **hashes** only |

## Two secrets, kept apart

Your **identity** is something external that can be verified: control of an email
address, a passkey, or a Google, Apple or Microsoft account. It is what lets the
service know which organisations to connect you to.

Your **encryption passphrase** is used for exactly one thing: deriving the key
that unwraps your private key, which in turn unwraps every folder key you hold. It
is entered in the plugin, on your device, and it never leaves it. Not as a hash,
not as a verifier, not in any derived form. There is nothing on our side to check
it against, because checking it is not our job — decrypting your notes is, and
only your device does that.

That separation is the whole design. An identity provider can prove who you are;
it cannot hand over a secret it never held. And because the hosted service never
holds anything derived from the passphrase, a copy of its database gives an
attacker nothing to guess at.

If you forget the passphrase, the recovery key you were shown once at
registration is the only way back (`docs/security-model.md`, *Forgetting your
password*). Nobody can reset it for you. That is not a policy; there is no
mechanism by which anyone could.

## Three ways to sign in, one flow

Every method runs the same way: the plugin opens your system browser at
`accounts.nectenda.com`, you prove your identity there, and you return to
Obsidian. The browser page completes a sign-in and nothing else — it never asks
for, receives or handles a passphrase or a key. Once back in the plugin you enter
your passphrase, on your device, to unwrap your keys.

1. **Email code — the root.** A six-digit code is sent to your address and typed
   into the page, or into the plugin directly if you prefer not to use a browser.
   This is how an account is created, how a lost passkey is recovered from, and
   the fallback for everything else.
2. **Passkey — the default fast path.** After your first sign-in you are offered
   a passkey (Face ID, Touch ID, Windows Hello, or a password manager). It is a
   public-key credential bound to `nectenda.com`, so it cannot be phished, and it
   removes email delivery from your daily path. On a device that does not hold
   the passkey, the browser offers a QR code so a phone can sign the challenge.
   Losing every passkey falls back to the email code, then a new passkey.
3. **Google, Apple or Microsoft.** A standard sign-in with the provider, which
   returns a verified email and an opaque subject id. A provider identity whose
   verified email matches an existing account is linked to it automatically.
   Apple's private-relay addresses do not match and create a separate account
   until linked by hand; linking from the account view is not yet built.

You sign in on a **new device**, after revoking a device, or when changing
something sensitive. Otherwise each device keeps a long-lived session (90 days,
extended by use) that you can see and revoke under *Signed-in vaults* in
the settings. The identity service's "device" is the vault **on desktop**: sign
one vault in and the other vault on the same laptop is not signed in. On Android
that does not hold — the secret store the session token sits in is shared by
every vault of the app, so signing one vault in signs them all in, and a second
vault starts out holding the first one's session. Measured; see
`docs/key-storage.md`. The sync servers
count devices as machines, on a per-organisation roster — `docs/accounts.md`.
Each sync server issues its own shorter session from that, so **syncing never
depends on the identity service being reachable** — if it is down, devices that
are already signed in carry on. Ending a session works the other way round:
every token names its session, the identity service refuses a token whose
session has ended (`SESSION_REVOKED`), and it hands each sync server the list
of ended sessions — at once after a sign-out, and again before every
directory pull — so the device is signed out everywhere within about a
minute, open sockets included. Sessions that vanish with a deleted identity
would not reach that list; nothing deletes identities yet.

## What the identity service holds, exactly

- Your **email address** and when it was verified.
- For each linked provider, the provider's **subject id** — an opaque string —
  and the email it asserted at link time.
- For each passkey, the **public key**, a counter, and the label you gave it.
- Your **display name**: free text, spaces allowed, not unique. It is shown above
  your cursor and in organisation rosters, and it is the only thing other people
  see. It is not an identifier.
- Your **key material**: your public key, your private key wrapped under a key
  derived from your passphrase, and your recovery material — the same opaque
  blobs `docs/security-model.md` describes, held centrally so that you can unwrap
  them from any organisation's sync server. Previous versions are kept when you
  change your passphrase, as before.
- Your **memberships**: which organisations you belong to, your role in each, and
  which sync server each lives on.
- **Hashes** of share keys and invite tokens. The service can recognise one it is
  shown; a copy of its database cannot be used to redeem one.
- Your **device sessions**: a device id, a label, a platform string, and when each
  was created and last used. One live session per install: signing in again from
  a vault that already has one replaces it rather than adding another, because
  the plugin holds a single refresh token and the previous one is a credential
  nobody has any more. The plugin presents that token once at a time: however
  many of its requests are refused in the same moment, one refresh runs and
  the rest wait for it, because a rotated token presented twice is what a
  stolen one looks like (below) and would end the session.

## What a compromised identity service could do

Stated plainly, because a document that only lists strengths is marketing.

- It could **sign in as you** to the sync servers that hold your organisations.
  That yields ciphertext under opaque document names, plus the metadata
  `docs/security-model.md` already lists — the same as a compromised sync server
  today.
- It could **substitute a public key** when someone shares a folder with you.
  That is the key-substitution attack the security model already describes, and
  the defence is the same: compare fingerprints out of band.
- It could **not** read a note, a title, a folder name or an attachment, and it
  could not learn your passphrase, because it holds nothing derived from it.

## Organisations, seats and invitations

You get one the moment you sign in: your own, on the free plan, named after
you, and you can create more. An **organisation** is the billable unit. Its owner is billed; the owner and any
admins manage seats. A person may belong to several organisations — at work, with
a client, with friends — each on whatever sync server holds it, in whatever
region, and one vault can map folders from all of them at once.

Getting into one happens in three ways. The first needs nobody else:

- **Create one.** Yours, on the free plan. The identity service says which sync
  server should hold it and that server creates it, with you as its owner. It
  happens by itself the first time you sign in with no invitation waiting, and
  there is a button for making more.

The other two need somebody who already has one:

- **An invitation to your email address.** An owner or admin invites an address;
  you get an email, but the email is only a notification. Every pending invitation
  addressed to your verified email is **shown in the plugin's account view**, and
  you accept or decline there, whether or not the email arrived. An invitation can
  be redeemed only by a signed-in identity whose verified email matches, so a
  forwarded email is useless to anyone else. Invitations expire after 14 days and
  can be revoked.
- **A share link.** An organisation can enable a link that lets anyone with a
  Nectenda identity take a seat. It can be rotated or switched off at any time.
  Holding the link is authorisation to take a *seat*; it never grants access to a
  folder's content, because folder keys are wrapped to a specific person's public
  key by someone who already holds them.

Removing someone ends their access to future updates. It does not un-share what
they already have — they hold a local vault and the keys they were given — and
we say so rather than implying a revocation that did not happen.

## Where your data lives

Your organisation's sync server is in the region its owner chose at sign-up — EU,
US or Asia — and its attachments are stored with an object-storage provider in
that region. The identity record itself lives in the EU. The privacy policy names
the providers per region and states where placement is a hard guarantee and where
it is best effort.

## Self-hosting is different, deliberately

A self-hosted server has no identity service, and usually no outbound mail. It
keeps the original model: you register with an email and a password, and that one
password serves both purposes by **split derivation** — one derivation becomes an
authentication hash the server bcrypts, an independent derivation becomes the
encryption key that never leaves your device. The two cannot be turned into each
other. It is the shape Bitwarden and Proton use, it is sound, and on your own
server it is the right trade: one secret to remember, and nothing to configure.

The hosted service goes further — nothing derived from the passphrase leaves the
device at all — because there the identity store is ours, and we would rather it
hold nothing worth guessing at.

## What we do not claim

- **Not audited.** No external audit of the identity service has been carried out.
- **Sign-in depends on things we do not run.** Email delivery for codes, the
  provider for provider sign-in, your passkey ecosystem for passkeys. If all of
  those fail you at once, you cannot sign in on a *new* device until one recovers.
  Existing devices are unaffected.
- **The lookup that finds your organisations can reveal that an email address has
  an account, and which region it is in**, to someone who already knows the
  address. It cannot reveal anything past that — key-derivation parameters are
  answered plausibly for unknown addresses, and everything else needs a signed-in
  identity.
- **A provider account compromise is an identity compromise.** If someone controls
  your Google account, they can sign in as you — to ciphertext. Passkeys and the
  email root are independent of it; your passphrase is independent of everything.
- **Display names are not identity.** Two people in one organisation may choose
  the same name. Fingerprints, not names, are what to compare when it matters.

## The routes, for anyone checking

The identity service is a small HTTP service. Everything it exposes is listed
here, so that the claims above can be checked rather than believed. Anything not
listed answers 404.

**The browser page**, at `accounts.nectenda.com/auth/start?nonce=…`. Served with
`default-src 'none'; script-src 'self'`, no third-party origin, no analytics. It
holds one short-lived token, good only for registering a passkey for the person
who just signed in.

| Route | Does |
|---|---|
| `POST /auth/flow` | the plugin starts a sign-in: a nonce and a PKCE challenge. The result can be collected only by whoever holds the verifier |
| `GET /auth/flow/:nonce` | what the page should offer: the address, whether it has a passkey, which providers are configured |
| `GET /auth/poll?nonce&verifier` | the plugin collects the result, **once**. A wrong verifier is answered exactly like an expired flow |
| `POST /auth/email/send`, `POST /auth/email/verify` | a six-digit code, or with no nonce the same thing typed straight into the plugin. Rate-limited per address and per address-family |
| `POST /auth/passkey/login/options\|verify`, `…/register/options\|verify` | the WebAuthn ceremonies. The challenge is bound to the flow, the origin and relying party are checked, and a counter that does not advance is refused |
| `GET /auth/provider/:name/start`, `GET\|POST /auth/callback/:name` | Google, Microsoft or Apple, by authorization code with PKCE. The `id_token` signature, audience and nonce are verified against the provider's own keys |
| `POST /auth/refresh` | a device session rotates. Replaying a rotated token revokes the session — that is what theft looks like |
| `POST /auth/logout` | sign out: retire the session this refresh token belongs to. Authenticated by the token being retired, so it works after the access token has expired. Always 200 — an unknown token is not distinguishable from a spent one, on purpose. Every sync server is told at once |

**The signed-in plugin**, with a short-lived access token from any of the above:

| Route | Does |
|---|---|
| `GET /api/me` | who you are, your memberships and their sync servers, pending invitations addressed to your verified email, your passkeys, your devices, and your key material |
| `PATCH /api/me` | `{ displayName }` |
| `POST\|PUT /api/me/keys` | enrol key material, or replace it after a passphrase change. Opaque blobs; the service cannot open them |
| `PATCH\|DELETE /api/me/passkeys/:id`, `DELETE /api/me/sessions/:id` | label or remove a passkey, revoke a device — which every sync server hears about at once, and the device itself within a minute |
| `POST /api/me/invites/:id/accept\|decline\|joined` | accept an invitation from inside Obsidian, without reading the email. Accepting returns a token the sync server verifies offline, bound to your address |
| `POST\|GET /api/invites`, `DELETE /api/invites/:id` | an owner or admin invites, lists and revokes. Only an owner may invite an admin |
| `GET /api/recover/params`, `POST /api/recover` | recovery with the recovery key. Unknown addresses get plausible parameters, never a 404 |
| `GET /api/placement` | which server should hold an organisation the caller is about to create. Answers only; the sync server creates it. 503 `NO_CAPACITY` when nothing is open, which `placementOk` on `/api/health` goes amber long before |
| `GET /api/directory/lookup` | which server holds a share key or invitation, **by hash**. An unknown hash is answered with an open server, so it cannot be used to enumerate |

**Us**, with an operator token, and **nothing that reads a person's data**:
register a sync server, list them, force a manifest pull, list accounts that
appear on two servers at once (a move that did not finish), and mail delivery
counts. There is no route that returns key material, a passphrase-derived value,
or the contents of anything.
