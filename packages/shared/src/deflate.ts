import { gunzipSync } from 'fflate';

/**
 * gzip, with a decompressor that is always available.
 *
 * The asymmetry here is the whole point, and getting it wrong is what prompted
 * this file:
 *
 * - **Compressing is optional.** If the engine cannot do it, we store the
 *   attachment uncompressed and nothing is lost but some bytes.
 * - **Decompressing is not.** Once a peer has stored a compressed attachment,
 *   every other member has to be able to read it. A reader that cannot
 *   decompress does not merely lose an optimisation — it cannot open the file
 *   at all, and an optimisation has quietly become a requirement.
 *
 * That is not hypothetical. `CompressionStream` needs iOS 16.4, and Obsidian
 * mobile runs from iOS 16.0, so a phone on 16.0-16.3 could be handed a file by
 * a desktop peer that it had no way to open. It failed safely — the local file
 * was left alone — but the attachment silently never arrived, and the log said
 * "failed verification", which was not what had happened.
 *
 * So decompression falls back to a pure-JS inflate. It is slower and it is only
 * reached on engines without the native API, but it means **no attachment is
 * ever unreadable because of a feature that exists to save space**.
 *
 * The same fallback makes the path testable: every engine we run tests on has
 * the native API, so without this there would be no way to exercise the
 * alternative at all.
 */

let nativeCompression: boolean | null = null;

/**
 * Whether this engine can compress.
 *
 * Callers use it to choose a codec. Answering "no" is always safe: it means an
 * attachment is stored uncompressed, which every reader can handle.
 */
export function canCompress(): boolean {
  if (nativeCompression === null) {
    nativeCompression = typeof globalThis.CompressionStream === 'function';
  }
  return nativeCompression;
}

/** For tests: re-run the feature detection after stubbing the global. */
export function resetCompressionSupport(): void {
  nativeCompression = null;
}

export async function gzipBytes(data: Uint8Array): Promise<Uint8Array> {
  if (!canCompress()) throw new Error('Compression is not available on this platform');
  return through(data, new CompressionStream('gzip'));
}

/**
 * Decompress. Never throws for want of platform support.
 *
 * Native when it exists because it is faster and streams; the bundled inflate
 * otherwise. Both produce identical output, and the caller cannot tell which
 * ran — which is the property that matters.
 */
export async function gunzipBytes(data: Uint8Array): Promise<Uint8Array> {
  if (typeof globalThis.DecompressionStream === 'function') {
    return through(data, new DecompressionStream('gzip'));
  }
  return gunzipSync(data);
}

async function through(
  data: Uint8Array,
  transform: { readable: ReadableStream; writable: WritableStream },
): Promise<Uint8Array> {
  const writer = (transform.writable as WritableStream<Uint8Array>).getWriter();
  void writer.write(data).then(() => writer.close());
  const chunks: Uint8Array[] = [];
  const reader = (transform.readable as ReadableStream<Uint8Array>).getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  let length = 0;
  for (const c of chunks) length += c.length;
  const out = new Uint8Array(length);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}
