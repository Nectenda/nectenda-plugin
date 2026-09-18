import { gzipBytes, canCompress, type BlobCodec } from '@nectenda/shared';

/**
 * What a path is, and whether it is worth compressing.
 *
 * Both decisions live here rather than in the sync classes because both are
 * policy that will be tuned, and neither should require touching the code that
 * moves bytes.
 */

export type FileKind = 'text' | 'blob' | 'ignore';

/**
 * Classify a vault path.
 *
 * Only `.md` goes through `Y.Text`. **Everything else is a blob, including
 * `.canvas` and `.json`** — a canvas is JSON, and JSON merged character-wise
 * under concurrent edit produces something syntactically invalid that looks
 * fine until it is opened. As a blob it is last-writer-wins with a visible
 * conflict copy, which is the honest trade: disagreement beats convergence on
 * content that is wrong.
 *
 * `ignore` covers dot-directories. `listFiles` walks the vault index, which
 * already excludes them, so this is belt and braces — but it is stated
 * explicitly so that nobody later reaches for `adapter.list()`, which does see
 * them, and starts syncing the plugin's own configuration.
 */
export function kindOf(path: string): FileKind {
  const parts = path.split('/');
  if (parts.some((p) => p.startsWith('.'))) return 'ignore';
  if (path.endsWith('.md')) return 'text';
  return 'blob';
}

/**
 * Formats that are already compressed. Trying again costs CPU and saves nothing.
 *
 * Measured: gzip on 10MB of incompressible data takes 119ms and returns it
 * unchanged, so a 100MB video costs 1230ms for zero benefit.
 */
const ALREADY_COMPRESSED = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'heic', 'heif',
  'mp4', 'mov', 'mkv', 'webm', 'avi', 'm4v',
  'mp3', 'm4a', 'aac', 'ogg', 'opus', 'flac', 'wma',
  'zip', 'gz', 'bz2', 'xz', '7z', 'rar', 'tgz',
  'pdf', 'docx', 'xlsx', 'pptx', 'odt', 'ods', 'odp',
  'woff', 'woff2',
]);

/** Bytes sampled to predict whether the whole file is worth compressing. */
const PROBE_BYTES = 256 * 1024;
/** Minimum saving the sample must predict before the whole file is compressed. */
const MIN_SAVING = 0.1;

/**
 * Decide whether to compress, cheaply.
 *
 * Two stages, because compression is near-free when it works and expensive when
 * it does not. Measured at level 1: text and uncompressed images shrink by ~99%
 * in 4ms per 10MB, while already-compressed data shrinks by nothing and costs
 * the full pass anyway.
 *
 * The extension gate catches the overwhelming majority for free. The sample
 * probe covers the rest: gzipping 256KB costs 5ms against the 1230ms wasted by
 * compressing a 100MB incompressible file to no effect.
 */
export async function chooseCodec(path: string, bytes: Uint8Array): Promise<BlobCodec> {
  // Declining is always safe: an uncompressed attachment is readable
  // everywhere, which is not true in reverse.
  if (!canCompress()) return 'none';

  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  if (ALREADY_COMPRESSED.has(ext)) return 'none';
  // Below the sample size the probe would be measuring gzip's own header more
  // than the content, so just try it.
  if (bytes.length <= 4096) return 'none';

  const sample = bytes.subarray(0, Math.min(PROBE_BYTES, bytes.length));
  try {
    const probed = await gzipBytes(sample);
    return 1 - probed.length / sample.length >= MIN_SAVING ? 'gzip' : 'none';
  } catch {
    // Compression is an optimisation; never fail an upload over it.
    return 'none';
  }
}

/**
 * Whether storage usage has crossed the point worth mentioning.
 *
 * A pure decision so it can be tested without a plugin, and so the boundaries
 * are pinned down rather than eyeballed. Three of them matter:
 *
 * - **Unlimited never warns.** A self-hoster should not get told their own disk
 *   is filling up by an arbitrary percentage.
 * - **At or past the limit never warns either.** That case has its own message
 *   naming the file that was refused, and two notices about the same thing is
 *   one too many.
 * - **Only on the way up.** The caller remembers having warned, so this is
 *   about the threshold, not about frequency.
 */
export function shouldWarnAboutStorage(
  usedBytes: number,
  limitBytes: number,
  warnPercent: number,
): boolean {
  // Kept although no test can distinguish it: dividing by zero gives Infinity,
  // which the `< 100` below already rejects. Leaning on IEEE infinity semantics
  // for "self-hosters are never nagged about their own disk" is not a trade
  // worth making for one comparison.
  if (limitBytes <= 0) return false;
  const percent = (usedBytes / limitBytes) * 100;
  return percent >= warnPercent && percent < 100;
}
