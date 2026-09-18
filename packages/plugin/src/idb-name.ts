/**
 * Naming for the local IndexedDB copy of a document.
 *
 * Obsidian runs every vault in one origin — `app://obsidian.md` — and
 * IndexedDB is per-origin, so two vaults open on the same machine share one
 * database. A store named only after the document is therefore the *same*
 * store in both, and two vaults sharing a folder silently share their Yjs
 * state locally, without the server relaying anything.
 *
 * That is not a caching quirk. It bypasses access control completely: a vault
 * whose account has no membership still hands its edits to any other vault on
 * the machine that maps the same folder. It was found exactly that way — a
 * locked-out account's edits reached a collaborator after a restart, while the
 * server had correctly refused every one of them.
 *
 * So the store is namespaced by vault. Changing this orphans existing stores;
 * that costs nothing, because the content is on disk and on the server, and
 * the first-sync backup net covers any divergence.
 */
export function idbStoreName(vaultKey: string, docName: string): string {
  return `nectenda:${vaultKey}:${docName}`;
}
