import * as Y from 'yjs';
import type { IndexeddbPersistence } from 'y-indexeddb';
import { toBase64, fromBase64 } from '@nectenda/shared';
import { log } from './logger';

/**
 * Remember how far through the server's log this device has read.
 *
 * `lastSeq` lived only in memory, so every restart asked for the whole log from
 * zero. With Stage 2 compaction that is now a snapshot plus a short tail rather
 * than every keystroke ever typed, but it is still a download and a decrypt of
 * the entire document on every launch, for every file in every shared folder.
 *
 * ## Why this is dangerous, and what makes it safe
 *
 * A `lastSeq` that is *ahead* of what IndexedDB actually holds is silent data
 * loss. Say the log was read to sequence 100 but the browser died before
 * y-indexeddb flushed updates 81-100. On restart the document loads with
 * content through 80, we tell the server "everything after 100, please", and
 * 81-100 are never asked for again. The note is quietly missing a paragraph and
 * nothing reports it.
 *
 * The two stores cannot be written atomically — y-indexeddb persists updates in
 * its own object store and gives no completion signal per update — so the
 * checkpoint cannot simply be trusted. Instead it records **what the document
 * contained when the sequence was taken**, as a Yjs state vector, and refuses
 * itself on load unless the document restored from IndexedDB is byte-for-byte
 * the same state.
 *
 * That makes the failure safe by construction rather than by timing:
 *
 * - IndexedDB lost the tail  → restored vector is smaller → mismatch → 0.
 * - Edits landed after the checkpoint → restored vector is larger → mismatch → 0.
 * - Everything flushed        → vectors match → the sequence is provably valid.
 *
 * Falling back to 0 costs a full catch-up, which is exactly the behaviour that
 * existed before this file. So the worst case here is the old behaviour, and
 * there is no case where a hole is skipped.
 */
const KEY = 'nectenda-seq';

interface Checkpoint {
  seq: number;
  /** base64 Yjs state vector of the document when `seq` was recorded. */
  sv: string;
}

/**
 * The sequence this document may safely resume from, or 0.
 *
 * Must be called after the IndexedDB provider has finished loading, or the
 * state vector compared against will be of an empty document and every
 * checkpoint will be rejected.
 */
export async function loadSeqCheckpoint(
  idb: IndexeddbPersistence,
  ydoc: Y.Doc,
): Promise<number> {
  try {
    const raw = (await idb.get(KEY)) as string | undefined | null;
    if (!raw) return 0;

    const parsed = JSON.parse(raw) as Partial<Checkpoint>;
    // Anything malformed is treated as absent. A checkpoint is an optimisation;
    // guessing at a half-written one is not worth a single lost paragraph.
    if (typeof parsed.seq !== 'number' || !Number.isInteger(parsed.seq) || parsed.seq <= 0) return 0;
    if (typeof parsed.sv !== 'string') return 0;

    const current = Y.encodeStateVector(ydoc);
    const stored = fromBase64(parsed.sv);
    if (!vectorsEqual(current, stored)) {
      log.debug('Ignoring seq checkpoint: document does not match what it recorded', {
        seq: parsed.seq,
      });
      return 0;
    }
    return parsed.seq;
  } catch (err) {
    log.warn('Could not read seq checkpoint; starting from 0', { error: String(err) });
    return 0;
  }
}

/**
 * Record the sequence together with the document it describes.
 *
 * Both halves are captured in one synchronous block. Reading the state vector
 * after an await would let an edit land in between and produce a checkpoint
 * describing a document that never existed — which would then be trusted.
 */
export async function saveSeqCheckpoint(
  idb: IndexeddbPersistence,
  ydoc: Y.Doc,
  seq: number,
): Promise<void> {
  if (seq <= 0) return;
  const record: Checkpoint = { seq, sv: toBase64(Y.encodeStateVector(ydoc)) };
  try {
    await idb.set(KEY, JSON.stringify(record));
  } catch (err) {
    // Losing a checkpoint costs a replay next launch and nothing else.
    log.debug('Could not persist seq checkpoint', { error: String(err) });
  }
}

/**
 * Defence in depth, deliberately.
 *
 * The length check cannot be made to fail a test: lib0 encodes the number of
 * entries first, so two vectors that differ in length always differ in their
 * leading bytes and the loop catches it. It stays because relying on that
 * encoding detail to protect against a lost update is not a trade worth making
 * for one comparison. The same applies to the `typeof parsed.sv` guard above,
 * which `fromBase64` would throw past anyway.
 */
function vectorsEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
