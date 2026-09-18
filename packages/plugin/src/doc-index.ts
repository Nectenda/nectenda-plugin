import { deriveDocId } from '@nectenda/shared';
import type { FolderCryptoRegistry } from './folder-crypto';

/**
 * Translates between a vault path and the opaque name a document has on the wire.
 *
 * Document names are `{folderId}/{HMAC(nameKey, relativePath)}`. The folder id
 * stays in clear so the server can authorise and partition the log; the path
 * does not, because a plaintext name hands over the structure of every shared
 * folder — arguably worse than the note contents.
 *
 * Two reasons this exists rather than deriving at each call site. Derivation is
 * async and most call sites are not, so an index makes the common case
 * synchronous. And an HMAC cannot be reversed, while `ContentSync.acquireDoc`
 * needs to get from a document name back to a file path — so the mapping has to
 * be remembered as it is built.
 *
 * Deliberately **not persisted**. It is derivable in microseconds from the name
 * key and the paths, both of which survive a restart, and a plaintext
 * path-to-id table on disk is precisely what an attacker would want sitting
 * beside the ciphertext.
 */
export class DocIndex {
  private byPath = new Map<string, string>();
  private byId = new Map<string, { folderId: string; relativePath: string }>();

  constructor(private crypto: FolderCryptoRegistry) {}

  /**
   * A composite map key.
   *
   * The separator is a newline because a folder id is a UUID and a
   * vault-relative path cannot contain one, so no two different pairs can
   * produce the same key. A space would let `("a b", "c")` and `("a", "b c")`
   * collide.
   */
  private key(folderId: string, relativePath: string): string {
    return `${folderId}\n${relativePath}`;
  }

  /** The wire name, if it has already been derived. */
  refSync(folderId: string, relativePath: string): string | null {
    return this.byPath.get(this.key(folderId, relativePath)) ?? null;
  }

  /**
   * The wire name, deriving it if needed.
   *
   * Throws when the folder has no keys. That is not a failure to paper over:
   * without the name key this client cannot address the folder's documents at
   * all, and guessing would put it on the wrong ones.
   */
  async ref(folderId: string, relativePath: string): Promise<string> {
    const known = this.refSync(folderId, relativePath);
    if (known) return known;

    const keys = this.crypto.get(folderId);
    if (!keys) throw new Error(`No name key for folder ${folderId}`);

    const docName = `${folderId}/${await deriveDocId(keys.nameKey, relativePath)}`;
    this.byPath.set(this.key(folderId, relativePath), docName);
    this.byId.set(docName, { folderId, relativePath });
    return docName;
  }

  /** The vault-relative path behind a wire name, or null if never derived. */
  pathOf(docName: string): { folderId: string; relativePath: string } | null {
    return this.byId.get(docName) ?? null;
  }

  /**
   * Derive a batch of paths up front, so later lookups are synchronous.
   *
   * Called with the folder's local files when it connects, and with the keys of
   * the folder listing — which is how paths become known for documents this
   * vault has never opened.
   */
  async warm(folderId: string, relativePaths: string[]): Promise<void> {
    for (const relativePath of relativePaths) {
      if (this.refSync(folderId, relativePath)) continue;
      try {
        await this.ref(folderId, relativePath);
      } catch {
        // No keys for the folder: nothing can be addressed, and the caller
        // handles that by refusing to connect it at all.
        return;
      }
    }
  }

  forget(folderId: string, relativePath: string): void {
    const k = this.key(folderId, relativePath);
    const docName = this.byPath.get(k);
    if (docName) this.byId.delete(docName);
    this.byPath.delete(k);
  }

  dropFolder(folderId: string): void {
    for (const [docName, entry] of [...this.byId]) {
      if (entry.folderId !== folderId) continue;
      this.byId.delete(docName);
      this.byPath.delete(this.key(entry.folderId, entry.relativePath));
    }
  }
}
