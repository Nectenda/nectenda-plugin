# Nectenda

**End-to-end encrypted real-time collaborative editing for [Obsidian](https://obsidian.md).**

Live cursors, offline editing, shared folders and attachments — on a server that
**cannot read your notes**. Content is encrypted on your device before it is
sent; the server stores ciphertext it has no key for, and document paths are
HMACs rather than filenames.

## This repository

The Obsidian plugin and the shared library it is built from, source-available
under the [PolyForm Shield License 1.0.0](LICENSE).

**This is the code that does the encrypting**, and it is why the repository is
published: every security property Nectenda claims is enforced here, on your
device, before anything leaves it. The server relays ciphertext it cannot read
and is not published — doing so would prove little, since nobody can verify
which build an operator is actually running.

Start with [docs/security-model.md](docs/security-model.md): it states exactly
what the server can and cannot see, and names the code implementing each claim
so you can check rather than believe.

The published `main.js` is **not minified**, so the file that runs in your
vault is one you can read directly.

## This plugin requires an account and a server

Nectenda is a client for a sync server. It does nothing on its own: there is no
offline-only or local-only mode, and with no account nothing syncs. Say so
plainly before you install it.

**You cannot sign yourself up.** Registering needs either an invitation issued
by someone already on the server or that account's share key. There is no open
registration on any server, ours or yours.

There are two ways to run it, and they differ in what reaches us:

**Hosted at [nectenda.com](https://nectenda.com).** We operate the server, so
your encrypted notes pass through our infrastructure and are stored on it. We
cannot read them: content is encrypted on your device before it is sent, the
keys are derived from your passphrase and never leave, and document paths are
HMACs rather than filenames. What the server does see is real and is listed
exhaustively in [docs/security-model.md](docs/security-model.md) — which
accounts share which folders, update sizes and timings, device records, and the
display name you choose for a shared folder. Signing in talks to
`accounts.nectenda.com`, the one address the plugin knows without being told.

**A server you run.** The plugin talks to whatever address you give it, and a
vault pointed at your own server sends us nothing at all — not the ciphertext
and not the metadata above. Note that the server is not something you can obtain
today: it is offered as a licensed image on Business and Enterprise plans, and
that is not yet available. Said here because the plugin will happily connect to
a self-hosted server and you should know which of the two you are in.

Both modes run the same encryption. The plugin talks to the server you point it
at and to no third party.

## What leaves your machine

Nothing about what you do. There is no analytics of any kind.

When you are signed in to the hosted service, the plugin reports its own
crashes to an error tracker Nectenda runs itself — not a third party. It is on
unless you turn it off, and it sends nothing until it has shown you what a
report contains. A report carries the exception and its message, stack frames
as line and column numbers in the published `main.js`, the plugin and
Obsidian versions, the platform, and the install identifier every request
already carries. It carries no note content, no note, folder or attachment
name, no file path, not your vault's name, and no token or key.

The payload is built from a fixed list of fields rather than filtered down from
a larger one — `packages/plugin/src/error-report.ts`, and there is no
error-reporting library behind it, because a library owns the event and we
would be subtracting from it. [docs/security-model.md](docs/security-model.md)
states the rule and names the code.

**Running your own server? None of this applies.** The address reports would go
to is supplied by the server you sign in to; a self-hosted one supplies none,
so none are sent.

## Installing

From the community plugin browser in Obsidian: **Settings → Community plugins →
Browse**, search for Nectenda, install and enable it.

To install a release by hand instead, take `main.js`, `manifest.json` and
`styles.css` from the [latest release](../../releases/latest), put all three in
`<your vault>/.obsidian/plugins/nectenda/`, and enable the plugin under
**Settings → Community plugins**.

Then open **Settings → Nectenda**, give it a server address, and sign in with
the account you were invited to. Share a folder from the plugin's pane and
anyone else with access to it sees your edits as you type.

## Build

```sh
pnpm install
pnpm build          # produces packages/plugin/main.js
```

Building it yourself is the point of publishing it: `scripts/verify-build.mjs`
rebuilds from this source and compares the result byte for byte against the
`main.js` in a release, so you can check that the file you installed is the
file you just read.

## Documentation

- [Security model](docs/security-model.md) — what the server can and cannot see
- [Sync limitations](docs/sync-limitations.md) — every known case two vaults can disagree
- [Key storage](docs/key-storage.md) — where keys live and what an attacker gets
- [Accounts](docs/accounts.md) — accounts, plans and devices
- [Identity](docs/identity.md) — signing in, and what the identity service holds

## Licence

[PolyForm Shield 1.0.0](LICENSE) — source-available, not open source.

Any purpose is permitted, commercial use included, **except** providing a product
that competes with Nectenda. Reading this code, auditing it, modifying it for
your own use, and building it to check the result against the `main.js` you
installed are all expressly permitted — that is what publishing it is for.

If you redistribute any part of it, PolyForm Shield requires you to pass on the
licence terms and this line, which also travels inside every built `main.js`:

```
Required Notice: Copyright (c) 2026 Nerchure Ltd (https://nectenda.com)
```

---

Generated from Nectenda's development repository; issues and pull requests are
welcome here, and changes are applied upstream and mirrored back.
