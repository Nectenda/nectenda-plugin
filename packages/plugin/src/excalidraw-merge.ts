import { canonical } from './structured-records';
import type { SceneElement } from './excalidraw-format';

/**
 * Which of two versions of one Excalidraw element stands, and what to do with
 * the one that does not (SAFE-A27).
 *
 * **The rule is Excalidraw's own** (`reconcileElements` in
 * `packages/excalidraw/data/reconcile.ts`): the higher `version` wins; on equal
 * versions the lower `versionNonce`. Excalidraw keeps the local copy when even
 * the nonces are equal, which two vaults cannot agree on, so the last step here
 * is the lower canonical JSON instead — a total order every vault computes the
 * same. Following Excalidraw's rule means a drawing open in its own view, which
 * reconciles that way, and the same drawing merged over disk end in the same
 * place; `excalidraw-merge.property.test.ts` holds the two together.
 *
 * **Where it parts from Excalidraw is the version that loses.** Excalidraw
 * drops it. Here, when it was someone's writing — text, a link, a stroke, a
 * colour — it is put back into the drawing as a copy, inside a frame that
 * says whose edit it was and when, beside the original. Losing only a
 * position or a size is not losing writing, and converges with a log line, as
 * a sort order does (SAFE-A22).
 */

/** Fields that place or account for an element, rather than say what it is. */
const NOT_CONTENT = new Set([
  'x', 'y', 'width', 'height', 'angle',
  'version', 'versionNonce', 'updated', 'seed', 'index',
  'boundElements', 'groupIds', 'frameId',
]);

/** Marks a field as the merge's own bookkeeping, not the file's. */
export const INTERNAL = '\u0001';

/**
 * An arrow's path and what it is attached to, which are where it is rather
 * than what it says: Excalidraw re-routes an arrow whenever a shape it is
 * attached to moves, in whichever vault moves it, so two vaults moving
 * connected shapes at once each write a new path. Kept as content, every such
 * pair left a "Kept by Nectenda" copy of the arrow (seen in the user's vaults);
 * as position the newer path wins and the other is logged, as a move does.
 * Decided with the user on 4 October 2026. Its colour, style, arrowheads and
 * link are still content. Not a freehand stroke's points: those are the stroke.
 */
const ARROW_PATH = new Set([
  'points', 'startBinding', 'endBinding', 'lastCommittedPoint', 'fixedSegments', 'startIsSpecial', 'endIsSpecial',
]);

/** What an element says, as a string: everything but where it is and its bookkeeping. */
export function contentOf(el: Record<string, unknown>): string {
  const out: Record<string, unknown> = {};
  const arrow = el.type === 'arrow';
  // A text element's `text` is its `originalText` wrapped to its width, which
  // releases lay out differently: what it says is the original.
  const wrapped = el.type === 'text' && typeof el.originalText === 'string';
  for (const [k, v] of Object.entries(el)) {
    if (NOT_CONTENT.has(k) || k.startsWith(INTERNAL)) continue;
    if (arrow && ARROW_PATH.has(k)) continue;
    if (wrapped && k === 'text') continue;
    out[k] = v;
  }
  return canonical(out);
}

/** A value a release fills in as a default when the file has none. */
function emptyLike(v: unknown): boolean {
  if (v === null || v === undefined || v === false || v === 0 || v === '') return true;
  if (Array.isArray(v)) return v.length === 0;
  return typeof v === 'object' && Object.keys(v).length === 0;
}

/**
 * Whether two `contentOf` strings say the same: every key both have equal,
 * and a key only one has empty-like. Releases fill in fields a file lacks as
 * they load it (frameId, locked, link: all null or false) without raising the
 * version, so a version saved by one and the version another wrote it on
 * differ only by those, and were read as an edit, and kept in a frame. A key
 * only one side has with a real value — a link set, say — is still an edit.
 */
export function sameContent(a: string, b: string, oneSidedIsFill = false): boolean {
  if (a === b) return true;
  let x: Record<string, unknown>;
  let y: Record<string, unknown>;
  try {
    x = JSON.parse(a) as Record<string, unknown>;
    y = JSON.parse(b) as Record<string, unknown>;
  } catch {
    return false;
  }
  for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) {
    const inX = k in x;
    const inY = k in y;
    if (inX && inY) {
      if (canonical(x[k]) !== canonical(y[k])) return false;
    } else if (!oneSidedIsFill && !emptyLike(inX ? x[k] : y[k])) {
      return false;
    }
  }
  return true;
}

/** The element without the merge's bookkeeping fields. */
export function stripInternal<T extends Record<string, unknown>>(el: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(el)) if (!k.startsWith(INTERNAL)) out[k] = v;
  return out as T;
}

/** Whether `a` beats `b`: a total order on versions of one element. */
export function beats(a: SceneElement, b: SceneElement): boolean {
  if (a.version !== b.version) return a.version > b.version;
  if (a.versionNonce !== b.versionNonce) return a.versionNonce < b.versionNonce;
  return canonical(stripInternal(a)) < canonical(stripInternal(b));
}

/** The version of an element that stands, of several. */
export function winnerOf<T extends SceneElement>(versions: readonly T[]): T {
  let best = versions[0];
  for (let i = 1; i < versions.length; i++) if (beats(versions[i], best)) best = versions[i];
  return best;
}

/** What to do with a version that lost. */
export type LoserFate =
  | { kind: 'keep'; why: string }
  | { kind: 'converge'; why: string };

/**
 * Decide a losing version's fate.
 *
 * `baseContent` is what the loser's author had before they changed it — the
 * content of the version their edit was made on — or null for an element new
 * to them. Comparing with it, rather than only with the winner, is what tells
 * "moved the box while someone else retyped it" (nothing of the mover's is
 * lost: their copy just carries the old text) from "retyped it while someone
 * else retyped it" (their words are lost unless kept).
 */
/** What Excalidraw changes on its own, with nothing a person did: see `onlyBookkeeping`. */
const BOOKKEEPING = new Set(['isDeleted', 'index', 'version', 'versionNonce', 'updated', 'seed']);

/**
 * Whether `a` and `b` differ in nothing a person changes — only in z-order,
 * version, nonce, timestamp, seed, and whether it is deleted. Excalidraw
 * raises an element's version itself as it draws it into a scene whose
 * z-order it must make room in, and a live vault carries that in as a
 * version of its own (NEC-229).
 */
export function onlyBookkeeping(a: SceneElement, b: SceneElement): boolean {
  // A field empty on one side and absent on the other is the same: a newer
  // release fills in empty defaults as it draws an element in (found in
  // review). A value on one side and empty on the other is still different —
  // a link removed is an edit.
  const empty = (v: unknown): boolean => v === null || v === undefined || v === false || v === ''
    || (Array.isArray(v) && v.length === 0) || (typeof v === 'object' && v !== null && Object.keys(v).length === 0);
  const rest = (el: SceneElement): string => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(el)) if (!BOOKKEEPING.has(k) && !k.startsWith(INTERNAL) && !empty(v)) out[k] = v;
    return canonical(out);
  };
  return rest(a) === rest(b);
}

export function fateOf(loser: SceneElement, winner: SceneElement, baseContent: string | null): LoserFate {
  if (loser.isDeleted) return { kind: 'converge', why: 'a delete lost to an edit; the element survives' };
  const content = contentOf(loser);
  // The same version and nonce, differing only by fields one copy has and the
  // other lacks, whatever their values: the same element, one release having
  // filled in what the file left out. Not when both have a field and disagree
  // on it — two vaults can land on one nonce with different text, and that is
  // an edit that lost (a case the property test found).
  if (loser.version === winner.version && loser.versionNonce === winner.versionNonce
    && sameContent(content, contentOf(winner), true)) {
    return { kind: 'converge', why: 'the same version, written twice' };
  }
  if (baseContent !== null && sameContent(content, baseContent)) return { kind: 'converge', why: 'only its position or size changed' };
  if (sameContent(content, contentOf(winner))) return { kind: 'converge', why: 'the version that won says the same' };
  return { kind: 'keep', why: winner.isDeleted ? 'an edit lost to a delete' : 'an edit lost to another edit' };
}

// ── The frame a kept version goes in ────────────────────────────────────────

const ID_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/**
 * An 8-character id derived from `seed`, so that settling the same loser twice —
 * after a crash, or on a reconnect that replays it — writes the same elements
 * rather than a second frame. Eight because the Excalidraw plugin renames any
 * text element whose id is longer, and marks the drawing changed when it does.
 */
export function derivedId(seed: string): string {
  // Two 32-bit FNV-1a hashes, four characters from each: 62^8 ids, without
  // BigInt, which the plugin's build target does not have.
  let out = '';
  for (const salt of ['a', 'b']) {
    let h = fnv1a(`${salt}\u0000${seed}`);
    for (let i = 0; i < 4; i++) {
      out += ID_CHARS[h % 62];
      h = Math.floor(h / 62);
    }
  }
  return out;
}

/** 32-bit FNV-1a, unsigned. */
function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/** A 31-bit nonce derived from `seed`, for the same reason as `derivedId`. */
export function derivedNonce(seed: string): number {
  return fnv1a(seed) & 0x7fffffff;
}

interface Box { x: number; y: number; w: number; h: number }

function boxOf(el: Record<string, unknown>): Box | null {
  const { x, y, width, height } = el as { x?: unknown; y?: unknown; width?: unknown; height?: unknown };
  if (typeof x !== 'number' || typeof y !== 'number') return null;
  const w = typeof width === 'number' ? Math.abs(width) : 0;
  const h = typeof height === 'number' ? Math.abs(height) : 0;
  return { x: Math.min(x, x + (typeof width === 'number' ? width : 0)), y: Math.min(y, y + (typeof height === 'number' ? height : 0)), w, h };
}

const overlaps = (a: Box, b: Box): boolean =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** Padding inside the frame, and the gap kept from anything else. */
const PAD = 20;
const GAP = 40;

/** `YYYY-MM-DD HH:MM`, local time. */
function when(ms: unknown): string {
  const d = new Date(typeof ms === 'number' ? ms : Date.now());
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * `YYYY-MM-DD HH:MM UTC`, or nothing for a version with no time of its own:
 * for a label every vault must write alike. Local time differs between two
 * vaults in different zones, and "now" between two settling minutes apart;
 * either made each keep the other's label as a copy of a label.
 */
function whenAnywhere(ms: unknown): string {
  if (typeof ms !== 'number') return '';
  const d = new Date(ms);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `, ${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())} UTC`;
}

/**
 * The elements that keep a losing version in the drawing: a copy of it under a
 * new id, and a frame around the copy naming whose edit it was.
 *
 * Placed beside the original, never over it — to its right, stepping further
 * right until the frame overlaps nothing live — so nobody mistakes the copy for
 * the element itself. The copy is cut loose from anything that would tie it
 * back: groups, a container, arrow bindings. `top` is the highest z-order
 * index among live elements, so both land on top. `whose` is what the label
 * says the version was: "Bob's edit", or, for a fill no vault wrote, the same
 * words in every vault. `anywhere` asks for a label every vault writes alike
 * (`whenAnywhere`), for a version more than one vault may keep.
 */
export function keptCopy(
  loser: SceneElement,
  winner: SceneElement,
  live: readonly SceneElement[],
  seed: string,
  whose: string,
  top: string | null,
  anywhere = false,
): SceneElement[] {
  const copyId = derivedId(`${seed}\u0000copy`);
  const outlineId = derivedId(`${seed}\u0000frame`);
  const labelId = derivedId(`${seed}\u0000label`);
  // One group, not a frame. In Excalidraw a frame takes in whatever is dropped
  // over it and deleting it deletes what it holds: a user deleting a kept copy
  // lost an image that had come to sit over it. A group of the copy, an
  // outline and a label takes nothing in, and deleting it removes only those
  // three. Decided with the user on 4 October 2026.
  const groupId = derivedId(`${seed}\u0000group`);
  const label = anywhere
    ? `Kept by Nectenda: ${whose}${whenAnywhere(loser.updated)}`
    : `Kept by Nectenda: ${whose}, ${when(typeof loser.updated === 'number' ? loser.updated : Date.now())}`;
  const from = boxOf(loser) ?? { x: 0, y: 0, w: 100, h: 60 };
  const anchor = boxOf(winner.isDeleted ? loser : winner) ?? from;
  const fontSize = 14;
  const labelH = Math.round(fontSize * 1.25);
  const labelW = Math.round(label.length * fontSize * 0.6);
  const frameW = Math.max(from.w + 2 * PAD, labelW);
  const frameH = from.h + 2 * PAD + labelH + PAD;
  const others = live.map(boxOf).filter((b): b is Box => b !== null);
  let fx = Math.max(anchor.x + anchor.w, from.x + from.w) + GAP;
  const fy = from.y - PAD - labelH - PAD;
  for (let i = 0; i < 200; i++) {
    const frameBox = { x: fx - GAP / 2, y: fy - GAP / 2, w: frameW + GAP, h: frameH + GAP };
    if (!others.some((b) => overlaps(frameBox, b))) break;
    fx += frameW + GAP;
  }
  const updated = typeof loser.updated === 'number' ? loser.updated : Date.now();
  const common = {
    angle: 0, backgroundColor: 'transparent', fillStyle: 'solid', strokeWidth: 1, roughness: 0, opacity: 100,
    groupIds: [groupId], frameId: null, roundness: null, version: 1, isDeleted: false, boundElements: null,
    updated, link: null, locked: false,
  };
  const outline: SceneElement = {
    ...common,
    id: outlineId,
    type: 'rectangle',
    x: fx,
    y: fy,
    width: frameW,
    height: frameH,
    strokeColor: '#999999',
    strokeStyle: 'dashed',
    seed: derivedNonce(`${seed}\u0000frame-seed`),
    versionNonce: derivedNonce(`${seed}\u0000frame`),
    index: top === null ? null : `${top}V`,
  };
  const copy: SceneElement = {
    ...stripInternal(loser),
    id: copyId,
    x: fx + PAD + ((typeof loser.x === 'number' ? loser.x : 0) - from.x),
    y: fy + PAD + labelH + PAD + ((typeof loser.y === 'number' ? loser.y : 0) - from.y),
    version: 1,
    versionNonce: derivedNonce(`${seed}\u0000copy`),
    isDeleted: false,
    groupIds: [groupId],
    frameId: null,
    boundElements: null,
    index: top === null ? null : `${top}VV`,
    updated,
  };
  if ('containerId' in copy) copy.containerId = null;
  if ('startBinding' in copy) copy.startBinding = null;
  if ('endBinding' in copy) copy.endBinding = null;
  const caption: SceneElement = {
    ...common,
    id: labelId,
    type: 'text',
    x: fx + PAD,
    y: fy + PAD,
    width: labelW,
    height: labelH,
    strokeColor: '#7a7a7a',
    strokeStyle: 'solid',
    seed: derivedNonce(`${seed}\u0000label-seed`),
    versionNonce: derivedNonce(`${seed}\u0000label`),
    text: label,
    originalText: label,
    rawText: label,
    fontSize,
    fontFamily: 5,
    textAlign: 'left',
    verticalAlign: 'top',
    containerId: null,
    autoResize: true,
    lineHeight: 1.25,
    index: top === null ? null : `${top}VVV`,
  };
  return [outline, copy, caption];
}
