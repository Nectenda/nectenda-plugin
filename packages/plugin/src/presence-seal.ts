import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import { toBase64, fromBase64 } from '@nectenda/shared';
import type { DocCipher } from './multiplexed-provider';

/**
 * Presence, sealed.
 *
 * An awareness state (who someone is, where their caret sits) used to reach the
 * server as readable JSON. Positions are CRDT item ids rather than text, so no
 * note content leaked, but the server could see where in a note each person was
 * — and nothing in the security model said so.
 *
 * The server never needed to read a state. It coalesces by client id and clock,
 * vouches and retracts by which socket introduced a client id, treats `null` as
 * a removal, and relays the frame's bytes. All of that is outside the state
 * JSON, so the state can be replaced by a sealed envelope while the awareness
 * wire format stays exactly as it was:
 *
 *   count, then per entry: clientID, clock, JSON
 *   JSON = null                                    (a removal, left plain)
 *        | {"e": base64(IV ‖ ciphertext ‖ tag), "k": keyId}
 *
 * The local Awareness keeps holding plaintext, so y-codemirror, the presence
 * circles and the compaction election never see any of this.
 */

/**
 * Plaintext is padded to a multiple of this, so a ciphertext's length does not
 * say which field changed — a pointer move and a selection change otherwise
 * differ by exactly the bytes that moved.
 *
 * 512, not 256, because 256 was measured and leaked: y-codemirror's cursor
 * (two relative positions) is set to null when the editor loses focus, and a
 * focused state (~310 bytes) and an unfocused one (~140) landed in different
 * 256-byte buckets. One bucket holds a text state with its caret, pointer and
 * viewport. A multiple rather than one fixed size, because a canvas selection
 * of many ids must still fit — and a state that large does show its size.
 */
export const PRESENCE_PAD_BYTES = 512;

/** Separates presence from anything else ever sealed under a folder key. */
const AAD_LABEL = 'nectenda:v1:presence';

/**
 * What a sealed state is bound to: one note, one participant, one moment.
 *
 * Without the note, a server could replay one note's presence into another;
 * without the client id, attribute one person's caret to someone else; without
 * the clock, re-send an old state under a newer clock and move the caret back.
 * Content payloads carry no additional data at all, so this also means a
 * presence ciphertext can never open as a content update, nor the reverse.
 */
export function presenceAad(docName: string, clientID: number, clock: number): Uint8Array {
  const enc = encoding.createEncoder();
  encoding.writeVarString(enc, AAD_LABEL);
  encoding.writeVarString(enc, docName);
  encoding.writeVarUint(enc, clientID);
  encoding.writeVarUint(enc, clock);
  return encoding.toUint8Array(enc);
}

/**
 * Pad with trailing spaces. JSON.parse ignores trailing whitespace, so the
 * padding needs no length field and no stripping on the way out.
 */
function pad(bytes: Uint8Array): Uint8Array {
  const size = Math.max(PRESENCE_PAD_BYTES, Math.ceil(bytes.length / PRESENCE_PAD_BYTES) * PRESENCE_PAD_BYTES);
  const out = new Uint8Array(size).fill(0x20);
  out.set(bytes, 0);
  return out;
}

/** Seal one non-null state. Returns the envelope as the JSON string that goes on the wire. */
export async function sealPresence(
  cipher: DocCipher,
  docName: string,
  clientID: number,
  clock: number,
  state: unknown,
): Promise<string> {
  const plaintext = pad(new TextEncoder().encode(JSON.stringify(state)));
  const { payload, keyId } = await cipher.encryptPayload(docName, plaintext, presenceAad(docName, clientID, clock));
  return JSON.stringify({ e: toBase64(payload), k: keyId });
}

/**
 * Open one entry's JSON. `null` is a removal and comes back as null.
 *
 * Throws on anything else that is not a sealed envelope which opens to an
 * object. Accepting a readable state here would let the server bypass the seal
 * entirely just by sending one, so a plaintext state is refused, not tolerated.
 */
export async function openPresence(
  cipher: DocCipher,
  docName: string,
  clientID: number,
  clock: number,
  json: string,
): Promise<Record<string, unknown> | null> {
  const outer: unknown = JSON.parse(json);
  if (outer === null) return null;
  if (
    typeof outer !== 'object' || Array.isArray(outer) ||
    typeof (outer as { e?: unknown }).e !== 'string' ||
    typeof (outer as { k?: unknown }).k !== 'string'
  ) {
    throw new Error('presence state is not sealed');
  }
  const { e, k } = outer as { e: string; k: string };
  const plaintext = await cipher.decryptPayload(docName, fromBase64(e), k, presenceAad(docName, clientID, clock));
  const state: unknown = JSON.parse(new TextDecoder().decode(plaintext));
  if (typeof state !== 'object' || state === null || Array.isArray(state)) {
    throw new Error('presence state did not open to an object');
  }
  return state as Record<string, unknown>;
}

/** One entry of an awareness update, with its state still as JSON text. */
export interface PresenceEntry {
  clientID: number;
  clock: number;
  json: string;
}

/** y-protocols' awareness update layout, read without interpreting the states. */
export function decodeEntries(update: Uint8Array): PresenceEntry[] {
  const dec = decoding.createDecoder(update);
  const count = decoding.readVarUint(dec);
  const entries: PresenceEntry[] = [];
  for (let i = 0; i < count; i++) {
    const clientID = decoding.readVarUint(dec);
    const clock = decoding.readVarUint(dec);
    const json = decoding.readVarString(dec);
    entries.push({ clientID, clock, json });
  }
  return entries;
}

/** The inverse, and byte-compatible with `encodeAwarenessUpdate`. */
export function encodeEntries(entries: PresenceEntry[]): Uint8Array {
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, entries.length);
  for (const { clientID, clock, json } of entries) {
    encoding.writeVarUint(enc, clientID);
    encoding.writeVarUint(enc, clock);
    encoding.writeVarString(enc, json);
  }
  return encoding.toUint8Array(enc);
}
