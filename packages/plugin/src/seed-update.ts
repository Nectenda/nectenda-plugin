import * as Y from 'yjs';
import { log } from './logger';

/**
 * Filling an empty document from disk, without two vaults doing it twice.
 *
 * ## The problem
 *
 * Three paths fill a document from a file: `ContentSync.seedIfEmpty` on the
 * provider's first `synced`, `ContentSync.reconcileFromDisk`'s no-baseline adopt
 * branch on every editor bind, and `EditorBridge`'s explicit seed before it
 * installs `yCollab`. All three insert the file's text into an empty `Y.Text`,
 * and all three can run in two vaults at once:
 *
 * - **Online.** Both vaults ask a server that genuinely holds nothing for the
 *   document, because the other vault's first append has not landed yet. The
 *   window is one server round trip.
 * - **Offline.** Neither vault can ask anything. Both bind, both fill from disk,
 *   and this one is not a race — it happens every time.
 *
 * Yjs then concatenates, correctly by its own rules: it identifies every
 * character by `(clientID, clock)`, the two inserts carry different client ids,
 * so they are different characters. The note is doubled on every vault in the
 * folder. Turning on sync across two devices that already hold the same vault
 * doubles every note in it.
 *
 * ## Why waiting cannot fix it
 *
 * A grace period before seeding is the first thing that comes to mind and it
 * buys nothing. The second vault avoids duplicating iff its sync offset exceeds
 * the round trip; add a wait `W` to both vaults and the condition becomes
 * `offset + W > W + round trip`, which is the same condition. And the offset is
 * not bounded by a round trip at all — two vaults offline for hours both seed.
 * No finite wait creates the shared knowledge that deduplication needs.
 *
 * ## What this does instead
 *
 * Make the two seeds *the same operation*. The identity of a seed comes from
 * what it contains rather than from who happened to run it:
 *
 *     clientID = SEED_CLIENT_ID_BASE + first 48 bits of SHA-256(docName ‖ 0 ‖ content)
 *
 * Two vaults with identical content then author a byte-identical update, and
 * applying an update Yjs already holds is a no-op. One copy. Two vaults with
 * *different* content derive different ids and both inserts survive, which is
 * the right answer — two versions are two versions, and this codebase keeps
 * both.
 *
 * ## Why the identity is pushed above 2^32
 *
 * Yjs generates a document's own client id with `random.uint32`, so a real id is
 * always below `2 ** 32`. Deriving above that line means a derived id can never
 * equal a live peer's — impossible by construction rather than merely unlikely.
 * The line matters because the failure it prevents is worse than the bug being
 * fixed: two *different* structs authored under one client id leave two vaults
 * permanently disagreeing **with identical state vectors**, so neither ever asks
 * for what it is missing. Measured against this Yjs: two documents seeded
 * `"AAAA"` and `"BBBB"` under one id settle on `"AAAA"` and `"BBBB"`
 * respectively, agree that they are in sync, and never converge.
 *
 * 48 bits of digest keeps `base + n` inside `Number.MAX_SAFE_INTEGER`, which
 * Yjs handles: ids up to `MAX_SAFE_INTEGER` were checked to round-trip through
 * `encodeStateAsUpdate` and back.
 *
 * ## The one collision left, and what happens on it
 *
 * Two *different* contents hashing to one id is ~1e-14 for the handful ever
 * seeded into one document, and it is still guarded rather than argued away: if
 * the document already knows the derived id at a different clock, the seed is
 * inserted under the document's own client id instead and a warning is logged.
 * That degrades to the duplication this module exists to prevent — visible, and
 * over-preserving — rather than to silent divergence.
 *
 * ## This derivation is an interop constant
 *
 * Two vaults only deduplicate if they derive the same id, so the hash input, the
 * digest, the 48-bit truncation and the base are shared between clients as
 * surely as a wire message number is. Changing any of them makes old and new
 * clients duplicate against each other, and is a compatibility break of the same
 * class.
 */

/**
 * The floor for a derived seed identity.
 *
 * `Y.Doc`'s own client id comes from `random.uint32`, so it is uniform in
 * `[0, 2 ** 32)`. Anything at or above this line cannot be a real peer.
 */
export const SEED_CLIENT_ID_BASE = 2 ** 32;

/** A seed, and the identity it was authored under. */
export interface SeedUpdate {
  /** The Yjs update to apply. Byte-identical for identical inputs. */
  update: Uint8Array;
  clientId: number;
  /**
   * The clock the identity reaches, read back from the authored document rather
   * than computed from `content.length`.
   *
   * Exact by construction, so the question of whether `Y.Text` counts UTF-16
   * code units or code points never has to be answered here.
   */
  clock: number;
}

/** What `applySeed` did, so a caller can log or test the decision. */
export type SeedOutcome = 'seeded' | 'already-present' | 'collision-fallback';

/** The identity an identical copy of `content` gets in any vault. */
export async function deriveSeedClientId(docName: string, content: string): Promise<number> {
  // The document name is in the hash so that the same boilerplate in two
  // different notes — an empty daily note template, most obviously — does not
  // share one identity across them.
  //
  // `\u0000` written as an escape, deliberately. A raw NUL byte here compiles
  // and produces the same digest, and it is invisible in every diff and review —
  // which is intolerable for a value two clients must agree on byte for byte.
  // The golden id in the tests is the other half of that guard.
  const input = new TextEncoder().encode(`${docName}\u0000${content}`);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', input));
  let n = 0;
  for (let i = 0; i < 6; i++) n = n * 256 + digest[i];
  return SEED_CLIENT_ID_BASE + n;
}

/** Author `content` under its derived identity, without touching any real doc. */
export async function buildSeedUpdate(docName: string, content: string): Promise<SeedUpdate> {
  const seedDoc = new Y.Doc();
  // After the constructor, not through it. `DocOpts` has no `clientID` field, so
  // `new Y.Doc({ clientID })` is accepted, silently ignored, and leaves a random
  // id in place — which is exactly today's behaviour wearing this fix's clothes.
  const clientId = await deriveSeedClientId(docName, content);
  seedDoc.clientID = clientId;
  seedDoc.getText('content').insert(0, content);
  const update = Y.encodeStateAsUpdate(seedDoc);
  const clock = Y.decodeStateVector(Y.encodeStateVector(seedDoc)).get(clientId) ?? 0;
  seedDoc.destroy();
  return { update, clientId, clock };
}

/**
 * Apply a prepared seed to a real document.
 *
 * Synchronous on purpose. `EditorBridge` binds inside a sequence whose ordering
 * is load-bearing, and an `await` between the emptiness check and installing
 * `yCollab` would let a re-entrant bind interleave. Callers that can afford the
 * await use `seedDocument`; the bridge builds the seed earlier, beside the file
 * read it already does, and applies it here.
 *
 * Applied with **no origin**, so the provider's update handler treats it as
 * local work and pushes it. An origin of `'remote'` would leave the note on this
 * device and nowhere else.
 */
export function applySeed(ydoc: Y.Doc, seed: SeedUpdate, content: string): SeedOutcome {
  const known = Y.decodeStateVector(Y.encodeStateVector(ydoc)).get(seed.clientId);

  if (known !== undefined) {
    if (known === seed.clock) {
      // This exact seed is already in the document — another vault's, or ours
      // from a previous session restored out of IndexedDB. Applying it again
      // would be a no-op; returning here says so rather than relying on that.
      //
      // Exact equality, not `>=`. Nothing but a seed of this same content ever
      // authors under a derived identity, so any other clock means two different
      // contents have collided. `>=` was the first version and it read a
      // 12-character impostor as a known 11-character seed.
      //
      // The one case this cannot separate is a collision between two contents of
      // the *same* length, which would skip the seed. Below 1e-14, the vault's
      // file is untouched, and the first-sync backup still fires — so it fails
      // toward preserving rather than toward diverging.
      return 'already-present';
    }
    // The identity is present at a clock this content did not author, so two
    // different contents have collided. Do not apply the update: a second struct
    // under one id is how two vaults end up permanently disagreeing while their
    // state vectors claim they agree. Insert under this document's own identity
    // instead and say so.
    log.warn('Seed identity collided — kept both copies rather than diverging', {
      clientId: seed.clientId,
      expectedClock: seed.clock,
      knownClock: known,
      bytes: content.length,
    });
    ydoc.transact(() => {
      ydoc.getText('content').insert(0, content);
    });
    return 'collision-fallback';
  }

  Y.applyUpdate(ydoc, seed.update);
  return 'seeded';
}

/** Build and apply in one step, for callers already in an async path. */
export async function seedDocument(
  ydoc: Y.Doc,
  docName: string,
  content: string,
): Promise<SeedOutcome> {
  return applySeed(ydoc, await buildSeedUpdate(docName, content), content);
}
