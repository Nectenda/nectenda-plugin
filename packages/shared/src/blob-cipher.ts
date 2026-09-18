import { toBase64 } from './crypto.js';
import { gzipBytes, gunzipBytes } from './deflate.js';

/**
 * The chunked envelope for attachments.
 *
 * ## Why this is not `encrypt()` from crypto.ts
 *
 * `crypto.subtle.encrypt` is one-shot: it takes the whole plaintext and returns
 * a whole new ciphertext buffer. For a 100MB attachment that is the file read
 * plus the plaintext plus the ciphertext all live at once — around 300MB, which
 * iOS terminates Obsidian well before. Encrypting in chunks bounds the crypto
 * overhead to a couple of chunks no matter how large the file is.
 *
 * Measured, so the trade is on the record: AES-GCM runs at 1-2.5 GB/s here, so
 * a 100MB file is roughly 100ms of actual cipher work. **CPU was never the
 * problem; memory is.** Obsidian's API has no partial binary read, so the
 * plaintext itself is always fully resident — chunking takes the peak from
 * ~300MB to ~110MB, which is the difference between working and being killed.
 *
 * ## The part that is easy to get wrong
 *
 * Splitting one AEAD into many independent ones destroys the guarantee that
 * made it an AEAD. Each chunk verifies perfectly well on its own, so whoever
 * controls storage can **reorder, drop, duplicate or truncate** chunks and
 * every individual tag still checks out. The file that comes back is wrong and
 * nothing reports it.
 *
 * So every chunk is bound to its position and to the shape of the whole:
 *
 *     AAD = blobId ‖ u32 chunkIndex ‖ u32 totalChunks ‖ u8 algo ‖ u8 codec
 *
 * A moved chunk fails on `chunkIndex`. A truncated file fails on `totalChunks`,
 * and again on the count actually received. A chunk lifted from a different
 * attachment fails on `blobId`. A header edited to change the codec fails
 * because the codec is authenticated even though it is stored in the clear.
 * The whole-file SHA-256 is the backstop for anything the framing misses.
 *
 * The IV is random per chunk and never derived from the chunk index: a counter
 * looks tidy and turns a single key reuse across two versions of a file into
 * the catastrophic GCM nonce-reuse case, which leaks the authentication key.
 */

const MAGIC = new Uint8Array([0x4e, 0x43, 0x42, 0x31]); // "NCB1"
const VERSION = 1;
const ALGO_AES_GCM = 1;
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const HEADER_LENGTH = 4 + 1 + 1 + 1 + 4 + 4; // magic, version, algo, codec, chunkSize, totalChunks

/** Plaintext bytes per chunk. Bounds peak memory; not a security parameter. */
export const BLOB_CHUNK_SIZE = 4 * 1024 * 1024;

/**
 * Largest attachment an account may store unless its plan says otherwise.
 *
 * Shared because both ends need the same number: the server enforces it, and
 * the client refuses locally rather than uploading 400MB to earn a 413. It is
 * also where a device's own learned ceiling starts before it has learned
 * anything.
 */
export const DEFAULT_MAX_BLOB_BYTES = 100 * 1024 * 1024;

export type BlobCodec = 'none' | 'gzip';
const CODEC_ID: Record<BlobCodec, number> = { none: 0, gzip: 1 };
const CODEC_BY_ID: Record<number, BlobCodec> = { 0: 'none', 1: 'gzip' };

export interface SealedBlob extends SealedMeta {
  /** Header first, then one entry per chunk. Concatenate, or hand to a Blob. */
  parts: Uint8Array[];
}

export async function sha256Base64(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return toBase64(new Uint8Array(digest));
}

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource));
}

/**
 * The integrity hash for an attachment: SHA-256 over the concatenated SHA-256
 * of each plaintext chunk.
 *
 * **Not** SHA-256 of the whole file, and that is forced rather than chosen.
 * WebCrypto's `digest` is one-shot — there is no incremental or streaming
 * variant — so hashing a whole file means holding a whole file, which is the
 * exact cost streaming exists to avoid. Hashing per chunk keeps the peak at one
 * chunk and needs no third-party hash implementation.
 *
 * It buys something too: a download can verify each chunk as it arrives instead
 * of only discovering at the end that the file is wrong.
 *
 * The value depends on `chunkSize`, so anything recomputing it for comparison
 * must use the chunk size recorded in the entry, not its own default.
 */
export async function chunkTreeRoot(chunkHashes: Uint8Array[]): Promise<string> {
  const joined = new Uint8Array(chunkHashes.length * 32);
  chunkHashes.forEach((h, i) => joined.set(h, i * 32));
  return toBase64(await sha256(joined));
}

/** The same hash, computed from a stream, for comparing a local file. */
export async function hashChunkStream(
  source: AsyncIterable<Uint8Array>,
  chunkSize: number,
): Promise<{ hash: string; size: number }> {
  const hashes: Uint8Array[] = [];
  let size = 0;
  // Same one-empty-chunk rule as sealing, or an empty file would hash
  // differently depending on which path computed it.
  for await (const chunk of atLeastOne(rechunk(source, chunkSize))) {
    hashes.push(await sha256(chunk));
    size += chunk.length;
  }
  return { hash: await chunkTreeRoot(hashes), size };
}

/**
 * Re-cut a stream into exactly `chunkSize` pieces.
 *
 * The source decides its own chunk sizes — the probe saw Obsidian's resource
 * handler deliver 2MiB regardless of what we asked for — but the envelope's
 * chunk boundaries are part of what each chunk is authenticated against, so
 * they cannot be left to whatever the transport happened to do.
 */
export async function* rechunk(
  source: AsyncIterable<Uint8Array>,
  chunkSize: number,
): AsyncGenerator<Uint8Array> {
  let held: Uint8Array[] = [];
  let heldBytes = 0;
  for await (const piece of source) {
    let at = 0;
    while (at < piece.length) {
      const want = chunkSize - heldBytes;
      const take = Math.min(want, piece.length - at);
      held.push(piece.subarray(at, at + take));
      heldBytes += take;
      at += take;
      if (heldBytes === chunkSize) {
        yield join(held, heldBytes);
        held = [];
        heldBytes = 0;
      }
    }
  }
  if (heldBytes > 0) yield join(held, heldBytes);
}

/**
 * Guarantee at least one chunk.
 *
 * An empty file produces no chunks at all, but the envelope needs exactly one:
 * `totalChunks` of zero would make it useless as a truncation check, and the
 * count check at the end would reject the file it just sealed.
 */
async function* atLeastOne(source: AsyncIterable<Uint8Array>): AsyncGenerator<Uint8Array> {
  let any = false;
  for await (const chunk of source) {
    any = true;
    yield chunk;
  }
  if (!any) yield new Uint8Array(0);
}

function join(parts: Uint8Array[], length: number): Uint8Array {
  if (parts.length === 1 && parts[0].length === length) return parts[0];
  const out = new Uint8Array(length);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export async function generateBlobKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
}

/** 32 hex characters. Random, never derived from content — see the plan on why. */
export function newBlobId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function aad(blobId: string, index: number, total: number, codec: BlobCodec): Uint8Array {
  const id = new TextEncoder().encode(blobId);
  const out = new Uint8Array(id.length + 4 + 4 + 1 + 1);
  out.set(id, 0);
  const view = new DataView(out.buffer, out.byteOffset);
  view.setUint32(id.length, index, false);
  view.setUint32(id.length + 4, total, false);
  // Future-proofing, and untestable today: there is exactly one algorithm, so
  // no test can distinguish binding it from not. It stays so that adding a
  // second cipher cannot silently allow a downgrade, which is the moment the
  // omission would matter and the moment nobody would think to look.
  out[id.length + 8] = ALGO_AES_GCM;
  out[id.length + 9] = CODEC_ID[codec];
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  let length = 0;
  for (const p of parts) length += p.length;
  const out = new Uint8Array(length);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/**
 * Encrypt an attachment into a sequence of authenticated chunks.
 *
 * `codec` is the caller's decision, not this module's: whether compression is
 * worth attempting depends on the file type and on a cheap probe, and that
 * belongs where the file is known rather than here.
 */
export interface SealedMeta {
  totalChunks: number;
  chunkSize: number;
  codec: BlobCodec;
  size: number;
  hash: string;
  ciphertextBytes: number;
}

/**
 * Encrypt an attachment from a stream, handing each sealed part to `onPart`.
 *
 * Nothing here ever holds more than a chunk of plaintext and a chunk of
 * ciphertext, so peak memory is a property of `chunkSize` rather than of the
 * file. That is the whole point: measured against a 300MB file, reading it
 * whole cost 608MB of external memory, while streaming it plateaued at 136MB.
 *
 * `size` must be known up front because `totalChunks` is authenticated into
 * every chunk's AAD, and it comes from `stat()`. If the file changes underneath
 * us the count will not match what arrives, and the mismatch is caught rather
 * than sealed in — the caller gets an error instead of a subtly wrong blob.
 */
export async function sealBlobStream(
  key: CryptoKey,
  blobId: string,
  source: AsyncIterable<Uint8Array>,
  options: { size: number; codec?: BlobCodec; chunkSize?: number },
  onPart: (part: Uint8Array) => void | Promise<void>,
): Promise<SealedMeta> {
  const codec = options.codec ?? 'none';
  const chunkSize = options.chunkSize ?? BLOB_CHUNK_SIZE;
  if (chunkSize <= 0) throw new Error('chunkSize must be positive');

  // An empty file is one empty chunk, not zero: zero would make `totalChunks`
  // meaningless as a truncation check.
  const totalChunks = Math.max(1, Math.ceil(options.size / chunkSize));

  const header = new Uint8Array(HEADER_LENGTH);
  header.set(MAGIC, 0);
  header[4] = VERSION;
  header[5] = ALGO_AES_GCM;
  header[6] = CODEC_ID[codec];
  const hv = new DataView(header.buffer);
  hv.setUint32(7, chunkSize, false);
  hv.setUint32(11, totalChunks, false);
  await onPart(header);

  const chunkHashes: Uint8Array[] = [];
  let ciphertextBytes = header.length;
  let plaintextBytes = 0;
  let index = 0;

  for await (const slice of atLeastOne(rechunk(source, chunkSize))) {
    if (index >= totalChunks) {
      throw new Error('File grew while it was being read');
    }
    chunkHashes.push(await sha256(slice));
    plaintextBytes += slice.length;

    const body = codec === 'gzip' ? await gzipBytes(slice) : slice;
    const iv = new Uint8Array(IV_LENGTH);
    crypto.getRandomValues(iv);
    const sealed = await crypto.subtle.encrypt(
      {
        name: 'AES-GCM',
        iv: iv as BufferSource,
        additionalData: aad(blobId, index, totalChunks, codec) as BufferSource,
      },
      key,
      body as BufferSource,
    );

    const framed = new Uint8Array(4 + IV_LENGTH + sealed.byteLength);
    new DataView(framed.buffer).setUint32(0, IV_LENGTH + sealed.byteLength, false);
    framed.set(iv, 4);
    framed.set(new Uint8Array(sealed), 4 + IV_LENGTH);
    await onPart(framed);
    ciphertextBytes += framed.length;
    index += 1;
  }

  if (index !== totalChunks) {
    throw new Error(`File shrank while it was being read: ${index} of ${totalChunks} chunks`);
  }
  return {
    totalChunks,
    chunkSize,
    codec,
    size: plaintextBytes,
    hash: await chunkTreeRoot(chunkHashes),
    ciphertextBytes,
  };
}

/**
 * The whole-buffer form, for callers that already hold the plaintext.
 *
 * A thin wrapper so there is exactly one implementation of the envelope. Tests
 * and small files use it; the upload path does not.
 */
export async function sealBlob(
  key: CryptoKey,
  blobId: string,
  plaintext: Uint8Array,
  options: { codec?: BlobCodec; chunkSize?: number } = {},
): Promise<SealedBlob> {
  const parts: Uint8Array[] = [];
  const meta = await sealBlobStream(
    key,
    blobId,
    (async function* () {
      yield plaintext;
    })(),
    { ...options, size: plaintext.length },
    (p) => void parts.push(p),
  );
  return { ...meta, parts };
}

/**
 * Decrypt and verify an attachment.
 *
 * Fails closed on anything unexpected. A caller must treat a rejection as "not
 * heard from yet" and leave whatever is on disk alone — never as "the file is
 * empty", which would overwrite a good local copy with nothing.
 */
export async function openBlob(
  key: CryptoKey,
  blobId: string,
  ciphertext: Uint8Array,
  expected: { hash: string; size?: number },
): Promise<Uint8Array> {
  if (ciphertext.length < HEADER_LENGTH) throw new Error('Blob too short to contain a header');
  for (let i = 0; i < MAGIC.length; i++) {
    if (ciphertext[i] !== MAGIC[i]) throw new Error('Not a Nectenda blob');
  }
  if (ciphertext[4] !== VERSION) throw new Error(`Unsupported blob version ${ciphertext[4]}`);
  if (ciphertext[5] !== ALGO_AES_GCM) throw new Error(`Unsupported blob algorithm ${ciphertext[5]}`);

  const codec = CODEC_BY_ID[ciphertext[6]];
  if (codec === undefined) throw new Error(`Unsupported blob codec ${ciphertext[6]}`);

  const hv = new DataView(ciphertext.buffer, ciphertext.byteOffset);
  const totalChunks = hv.getUint32(11, false);
  if (totalChunks === 0) throw new Error('Blob claims zero chunks');

  const plaintextChunks: Uint8Array[] = [];
  const chunkHashes: Uint8Array[] = [];
  let at = HEADER_LENGTH;
  let index = 0;

  while (at < ciphertext.length) {
    if (index >= totalChunks) throw new Error('Blob has more chunks than its header claims');
    if (at + 4 > ciphertext.length) throw new Error('Truncated chunk length');
    // `hv` is offset to the start of `ciphertext`, so `at` indexes it directly.
    const length = hv.getUint32(at, false);
    at += 4;
    if (length < IV_LENGTH + TAG_LENGTH) throw new Error('Chunk too short to be valid');
    if (at + length > ciphertext.length) throw new Error('Truncated chunk body');

    const iv = ciphertext.subarray(at, at + IV_LENGTH);
    const body = ciphertext.subarray(at + IV_LENGTH, at + length);
    at += length;

    // Throws if the chunk was moved, duplicated, taken from another blob, or if
    // the header it was sealed under has been edited.
    const opened = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: iv as BufferSource, additionalData: aad(blobId, index, totalChunks, codec) as BufferSource },
      key,
      body as BufferSource,
    );
    const plain = codec === 'gzip' ? await gunzipBytes(new Uint8Array(opened)) : new Uint8Array(opened);
    plaintextChunks.push(plain);
    chunkHashes.push(await sha256(plain));
    index += 1;
  }

  if (index !== totalChunks) {
    throw new Error(`Blob truncated: ${index} of ${totalChunks} chunks`);
  }

  const plaintext = concat(plaintextChunks);
  if (expected.size !== undefined && plaintext.length !== expected.size) {
    throw new Error(`Blob size mismatch: ${plaintext.length} bytes, expected ${expected.size}`);
  }
  // The backstop. Everything above checks the framing; this checks the content,
  // and it is what catches a failure mode nobody thought of.
  if (chunkHashes.length === 0) chunkHashes.push(await sha256(new Uint8Array(0)));
  const hash = await chunkTreeRoot(chunkHashes);
  if (hash !== expected.hash) throw new Error('Blob hash mismatch');

  return plaintext;
}
