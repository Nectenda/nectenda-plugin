import type * as Y from 'yjs';
import { basesCodec } from './bases-codec';
import { canvasCodec } from './canvas-codec';

/**
 * How one file format maps between its text on disk and a Y.Doc.
 *
 * StructuredSync never interprets a value. Everything it knows about a format
 * is here, and everything here is about the format: the lifecycle, the disk
 * writes, the backups and the conflict copies are the same for every codec and
 * live in structured-sync.ts, where they are tested once.
 *
 * The boundary between a file and its document is where structured sync loses
 * data if it loses any — the merge itself is Yjs's and is not in question. So a
 * codec has obligations, not just methods:
 *
 * - **Nested shared types only under keys unique to one peer**, such as an id a
 *   peer generated. Two peers each creating a `Y.Map` under the same fixed key
 *   do not merge: one subtree replaces the other whole. A fixed name belongs at
 *   the root (`ydoc.getMap(name)`), which Yjs does merge by name.
 * - **Key by stable id, never by position.** A list of records diffed by index
 *   turns one insertion into a rewrite of everything after it.
 * - **Keep what it does not understand.** A field another program wrote, or a
 *   newer version of the format added, goes into the document and back out
 *   verbatim. Dropping it is silent loss that surfaces weeks later.
 * - **`serialise(read(apply(parse(t))))` is stable.** A serialiser that does not
 *   survive its own round trip rewrites the file forever, each write provoking
 *   the next.
 * - **Decide what deleting a record means.** Removing a key that holds a nested
 *   type discards every edit inside it, including one another vault made that
 *   the deleting vault never saw. StructuredSync keeps such an edit when it
 *   had not yet reached the server, but when it had, and the deleter had not
 *   yet seen it (typically offline), nothing in the update says so and the
 *   edit is lost. A codec whose
 *   records hold anyone's writing should delete by tombstone, so that a
 *   concurrent edit survives the delete and can bring the record back.
 * - **The root named `meta` is StructuredSync's**, and a codec must not touch it.
 */
export interface StructuredCodec {
  /** The name recorded in the listing and in the document, e.g. `canvas`. */
  readonly format: string;
  /**
   * The document schema this codec writes. A document stamped with a higher
   * version was written by a newer client, and this one hands it off rather
   * than reading fields it does not know as absent.
   */
  readonly version: number;
  /**
   * Read a file. `ok: false` for anything the codec would have to guess at —
   * invalid syntax, the wrong shape — and never a partial or empty value in its
   * place: "could not read" must not become "delete everything".
   */
  parse(text: string): { ok: true; value: unknown } | { ok: false; error: string };
  /**
   * Bring an edit made on disk into the document, as a minimal keyed diff.
   * Called inside a transaction the caller owns, so the whole change is one
   * update.
   *
   * `base` is the value disk and document last agreed on, or null when there
   * is none (the first fill of an empty document). With a base, change **only
   * what differs between `base` and `value`** — never diff against the
   * document itself. The document may already hold remote changes the file has
   * not received yet; diffing against it would read their absence from the
   * file as the user reverting them, and push that reversion to everyone.
   */
  apply(ydoc: Y.Doc, value: unknown, base: unknown): void;
  /** The value the document holds now. */
  read(ydoc: Y.Doc): unknown;
  /** Text for disk, in the form the owning application itself writes. */
  serialise(value: unknown): string;
  /**
   * Whether two values mean the same file. Semantic, not byte-wise: a file the
   * user reformatted, or the owning application re-saved with its own key
   * order, is not a change, and treating it as one rewrites the file under them.
   */
  equal(a: unknown, b: unknown): boolean;
  /**
   * The Obsidian view type that shows this format (`canvas`, `bases`). Open
   * views of that type are flushed before a write and watched after it
   * (SAFE-A19, text-view-guard.ts).
   */
  readonly viewType?: string;
  /**
   * Padding bucket for this format's sealed presence (CRYPTO-113), when its
   * presence state is larger than the default bucket holds.
   */
  readonly presencePadBytes?: number;
  /**
   * The value to write, given the document's value and what disk holds now
   * (`null` if unreadable or empty). For a format with keys that are each
   * vault's own (SAFE-A21): put this vault's values for those keys back from
   * disk, so a write never replaces them with another vault's. `equal` must
   * then ignore those keys, or every write differs. Absent: write the
   * document's value as it is.
   */
  withLocal?(docValue: unknown, diskValue: unknown): unknown;
  /**
   * Whether a concurrent overwrite of `key` in the root map `root` is only a
   * matter of presentation — a sort, a size — that may converge on one value
   * without a conflict copy (SAFE-A22). It is still logged. Must be false for
   * anything that holds someone's writing, and for any key the codec does not
   * know. Absent: nothing is.
   */
  presentationOnly?(root: string, key: string): boolean;
  /**
   * Whether writing over `text` would drop something the value cannot carry —
   * YAML comments, say — so that the file must be backed up first (SAFE-A13).
   */
  dropsOnRewrite?(text: string): boolean;
}

/**
 * Structured formats this build syncs, by extension (lower case, with the dot).
 *
 * A format joins here only with a codec that meets every obligation above, and
 * until then its files stay attachments — whole-file replacement with a
 * conflict copy, which is coarse but loses nothing. Adding one moves files
 * that are already shared from attachment to structured (SAFE-A17), so it is
 * also the moment to raise the plugin version floor.
 */
export const STRUCTURED_FORMATS: Readonly<Record<string, StructuredCodec>> = {
  '.canvas': canvasCodec,
  '.base': basesCodec,
};

/** The codec for a file extension, or null. */
export function codecForPath(
  path: string,
  formats: Readonly<Record<string, StructuredCodec>> = STRUCTURED_FORMATS,
): StructuredCodec | null {
  const slash = path.lastIndexOf('/');
  const dot = path.lastIndexOf('.');
  if (dot <= slash + 1) return null;
  return formats[path.slice(dot).toLowerCase()] ?? null;
}

/** The codec for a format name, as a listing entry records it, or null. */
export function codecForFormat(
  format: string,
  formats: Readonly<Record<string, StructuredCodec>> = STRUCTURED_FORMATS,
): StructuredCodec | null {
  for (const codec of Object.values(formats)) {
    if (codec.format === format) return codec;
  }
  return null;
}
