import { isMap, isScalar, parseDocument } from 'yaml';
import { parseObsidianYaml, stringifyObsidianYaml } from './obsidian-yaml';

/**
 * A note's frontmatter as text: where it is, what it says key by key, and how to
 * change one key's value without touching anything else.
 *
 * Pure functions, so the rules that decide what is rewritten can be tested
 * without a document, a vault or Obsidian. `frontmatter-sync.ts` is the only
 * caller that changes anything.
 *
 * ## Where the block is
 *
 * Exactly where Obsidian looks (`getFrontMatterInfo`, 1.13.7): the text starts
 * with `---` and a line break, and the block ends at the first later `---`
 * that begins a line and is followed by a line break or the end of the text.
 * Finding it any other way would mean disagreeing with Obsidian about which
 * lines are properties and which are the note.
 *
 * ## Key by key
 *
 * The block is split at its top-level keys. Each key owns the lines from its
 * own line up to the next key's line, so a key's continuation lines (a list,
 * a nested map) move with it. Lines before the first key belong to nobody and
 * are never rewritten.
 *
 * Rewriting a key replaces only its lines, with exactly what Obsidian's writer
 * produces for that key alone. At the top level a block mapping's keys are
 * independent, so that is the same text Obsidian would write for the key in
 * the whole block. Every other line stays byte for byte, which is what keeps
 * hand-written formatting elsewhere from being churned.
 */

/** A located frontmatter block. Offsets are into the whole note. */
export interface BlockRange {
  /** First character of the YAML, just after the opening `---` line. */
  from: number;
  /** First character of the closing `---`. */
  to: number;
  /** The YAML itself: `text.slice(from, to)`. */
  yaml: string;
}

/** One top-level key's lines. Offsets are into the block's YAML. */
export interface KeyEntry {
  key: string;
  start: number;
  end: number;
  /** Whether these lines parse on their own. */
  ok: boolean;
  /** The value these lines hold, when they parse. */
  value: unknown;
}

export type Reading =
  /** No frontmatter: the note does not start with `---`. */
  | { kind: 'none' }
  /** It starts with `---` and nothing closes it. Obsidian shows no properties. */
  | { kind: 'unclosed' }
  /**
   * Characters glued to the front of the first line, ahead of a `---` that
   * opens a block. Obsidian sees no frontmatter, but the properties are all
   * still there: someone typed before the delimiter, or a merge stranded a
   * removed line's text there. Never read as "every property removed".
   */
  | { kind: 'stranded' }
  /** A block whose lines cannot be attributed to top-level keys. Never rewritten. */
  | { kind: 'unattributable'; block: BlockRange }
  /**
   * A block split into keys. `values` is the whole block parsed as Obsidian
   * parses it, or null when it does not parse: a duplicated key, or a value
   * merged into something that is not YAML.
   */
  | { kind: 'read'; block: BlockRange; entries: KeyEntry[]; values: Record<string, unknown> | null };

const OPENING = /^---(\r?\n)/;
const CLOSING = /---(\r?\n|$)/g;

/** Locate the block as Obsidian's `getFrontMatterInfo` does, or say why there is none. */
export function locateFrontmatter(text: string): BlockRange | 'none' | 'unclosed' {
  const open = OPENING.exec(text);
  if (!open) return 'none';
  const from = open[0].length;
  CLOSING.lastIndex = from;
  let close = CLOSING.exec(text);
  // Obsidian only accepts a `---` that begins a line. One in the middle of a
  // value (`title: a---b`) is part of the YAML.
  while (close && text.charAt(close.index - 1) !== '\n') close = CLOSING.exec(text);
  if (!close) return 'unclosed';
  return { from, to: close.index, yaml: text.slice(from, close.index) };
}

/**
 * Where the opening `---` is when characters have been glued in front of it
 * on the first line, or null. The one shape that leaves: no line break before
 * it, and a block it opens. Never a `---` further down, which is the note's
 * own (a horizontal rule, say).
 */
export function strandedOpening(text: string): number | null {
  const at = text.indexOf('---');
  if (at <= 0 || text.slice(0, at).includes('\n')) return null;
  return typeof locateFrontmatter(text.slice(at)) === 'string' ? null : at;
}

/** Read a note's frontmatter key by key. */
export function readFrontmatter(text: string): Reading {
  const block = locateFrontmatter(text);
  if (block === 'none' && strandedOpening(text) !== null) return { kind: 'stranded' };
  if (block === 'none' || block === 'unclosed') return { kind: block };
  const entries = splitKeys(block.yaml);
  if (entries === null) return { kind: 'unattributable', block };
  return { kind: 'read', block, entries, values: parseWhole(block.yaml) };
}

/**
 * The whole block as Obsidian reads it, or null when Obsidian would show no
 * properties. An empty block is an empty set of properties, not an error.
 */
function parseWhole(yaml: string): Record<string, unknown> | null {
  try {
    const value = parseObsidianYaml(yaml);
    if (value === null || value === undefined) return {};
    if (typeof value !== 'object' || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Split a block into its top-level keys, or null when its lines cannot be
 * attributed to keys with confidence.
 *
 * Read with duplicate keys allowed, because two vaults adding one key at once
 * is exactly the case this has to split. Anything else the reader complains
 * about (a value merged across a line break, say) means the key boundaries it
 * reports may not be where a person would put them, so the block is not split.
 * Refusing costs a notice. Guessing could rewrite a line that belonged to
 * someone else's key.
 */
function splitKeys(yaml: string): KeyEntry[] | null {
  if (yaml.trim() === '') return [];
  const doc = parseDocument(yaml, { uniqueKeys: false });
  if (doc.errors.length > 0) return null;
  if (doc.contents === null) return [];
  if (!isMap(doc.contents) || doc.contents.flow) return null;

  const starts: Array<{ key: string; start: number }> = [];
  for (const pair of doc.contents.items) {
    if (!isScalar(pair.key) || !pair.key.range) return null;
    const keyValue = pair.key.value;
    if (typeof keyValue !== 'string' && typeof keyValue !== 'number' && typeof keyValue !== 'boolean') return null;
    const at = pair.key.range[0];
    const lineStart = yaml.lastIndexOf('\n', at - 1) + 1;
    // A top-level key starts its own line. Anything else is a shape this
    // does not split (`? complex keys`, two keys on one line).
    if (yaml.slice(lineStart, at).trim() !== '') return null;
    starts.push({ key: String(keyValue), start: lineStart });
  }

  return starts.map(({ key, start }, i) => {
    const end = i + 1 < starts.length ? starts[i + 1].start : yaml.length;
    const lines = yaml.slice(start, end);
    try {
      const own = parseObsidianYaml(lines) as Record<string, unknown> | null;
      if (own && typeof own === 'object' && key in own) return { key, start, end, ok: true, value: own[key] };
    } catch {
      // Falls through: these lines do not parse on their own.
    }
    return { key, start, end, ok: false, value: undefined };
  });
}

/** What Obsidian writes for one key holding `value`, line break included. */
export function keyLines(key: string, value: unknown): string {
  return stringifyObsidianYaml({ [key]: value });
}

/**
 * Whether two property values mean the same thing.
 *
 * By value, with object keys in any order, so `[a, b]` written in flow style
 * and as a block list are equal and neither is ever rewritten into the other.
 */
export function sameValue(a: unknown, b: unknown): boolean {
  return canonical(a) === canonical(b);
}

function canonical(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? String(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(',')}}`;
}

/**
 * The whole block written from `values`, as Obsidian's `processFrontMatter`
 * writes it, for a block a merge has left beyond key-by-key repair.
 *
 * A pure function of the text and the values, and nothing else, because every
 * vault holding the same document has to write the same characters for the
 * rewrite to settle. Key order is the order the keys first appear in the text,
 * however mangled, then any others sorted.
 *
 * A merge can strand characters against a delimiter: a removed line's text
 * left glued to the front of the opening `---`, or onto the line of the
 * closing one. Both are read for what they are. Characters glued in front of
 * the opening are not deleted, since they may be someone's typing: they move
 * to the start of the body, where they stay visible. Characters on the closing
 * line are part of the block being rewritten. A block with no closing `---` at
 * all is refused, since there is then no telling where the body starts.
 *
 * As `processFrontMatter` does, no values means no block, and values for a
 * note with no block put one at the top.
 */
export function rebuildFrontmatter(
  text: string,
  values: ReadonlyMap<string, unknown>,
  knownClosingAt?: number,
): { kind: 'rebuilt'; text: string } | { kind: 'refused'; reason: 'unclosed' } {
  let stranded = '';
  let note = text;
  let block = locateFrontmatter(note);
  const glued = block === 'none' ? strandedOpening(text) : null;
  if (glued !== null) {
    stranded = text.slice(0, glued);
    note = text.slice(glued);
    block = locateFrontmatter(note);
  }
  if (block === 'unclosed' && knownClosingAt !== undefined) {
    block = closingAt(note, knownClosingAt - stranded.length) ?? block;
  }
  if (block === 'unclosed') block = closingOnItsLine(note, values) ?? block;
  if (block === 'unclosed') return { kind: 'refused', reason: 'unclosed' };
  if (block === 'none') {
    if (values.size === 0) return { kind: 'rebuilt', text };
    return { kind: 'rebuilt', text: `---\n${stringifyObsidianYaml(ordered(values, ''))}---\n${text}` };
  }

  const closingLine = /^---(\r?\n|$)/.exec(note.slice(block.to))?.[0] ?? '---';
  const body = note.slice(block.to + closingLine.length);
  if (values.size === 0) return { kind: 'rebuilt', text: stranded + body };
  const head = note.slice(0, block.from) + stringifyObsidianYaml(ordered(values, block.yaml)) + note.slice(block.to, block.to + closingLine.length);
  const joint = stranded && !closingLine.endsWith('\n') ? '\n' : '';
  return { kind: 'rebuilt', text: head + joint + stranded + body };
}

/**
 * The block, given the position of characters known (by their identity in the
 * document, not by reading the text) to be the closing `---` the block last
 * had. Whatever a merge left in front of them, they are the delimiter.
 */
function closingAt(text: string, at: number): BlockRange | null {
  const open = OPENING.exec(text);
  if (!open || at < open[0].length || !text.startsWith('---', at)) return null;
  const after = text.charAt(at + 3);
  if (after !== '' && after !== '\n' && after !== '\r') return null;
  return { from: open[0].length, to: at, yaml: text.slice(open[0].length, at) };
}

/**
 * The block of an opened note whose closing `---` has characters glued in
 * front of it on its line (`title: Plan---`), so that Obsidian no longer sees
 * it. Only used to rewrite the block, which puts the delimiter back at the
 * start of its line, so it is strict: everything it would rewrite has to be
 * properties the map knows. A delimiter someone deleted, with the note's own
 * text below, is refused. The first version took the first `---` ending any
 * line, and a horizontal rule (`----`) or a sentence ending `Wait---` in the
 * body was taken for the delimiter and every paragraph above it rewritten
 * away, in every vault.
 */
function closingOnItsLine(text: string, values: ReadonlyMap<string, unknown>): BlockRange | null {
  const open = OPENING.exec(text);
  if (!open) return null;
  const from = open[0].length;
  CLOSING.lastIndex = from;
  const close = CLOSING.exec(text);
  if (!close) return null;
  const before = text.charAt(close.index - 1);
  // Glued: something other than a line break or another dash just before it.
  if (before === '\n' || before === '-' || close.index === from) return null;
  const yaml = text.slice(from, close.index);
  // The lines above the glued one must all be properties the map knows, with
  // no blank line among them: a note's body is usually set off by one, and its
  // lines are not the map's properties. The glued line itself is either one of
  // those properties (`title: Plan---`) or the orphaned remains of a removed
  // line's value (`a---`), which hold no colon.
  const lastBreak = yaml.lastIndexOf('\n');
  const above = yaml.slice(0, lastBreak + 1);
  const glued = yaml.slice(lastBreak + 1);
  if (/(^|\n)\s*\n/.test(above)) return null;
  const entries = splitKeys(above);
  if (entries === null || entries.some((e) => !values.has(e.key))) return null;
  if (glued.includes(':')) {
    const own = splitKeys(`${glued}\n`);
    if (own === null || own.length !== 1 || !values.has(own[0].key)) return null;
  }
  return { from, to: close.index, yaml };
}

/** `values` in the order their keys first appear in `yaml`, then the rest sorted. */
function ordered(values: ReadonlyMap<string, unknown>, yaml: string): Record<string, unknown> {
  const order: string[] = [];
  for (const m of yaml.matchAll(/^([^\s#'"\-:][^:\n]*?):(?=\s|$)/gm)) {
    if (values.has(m[1]) && !order.includes(m[1])) order.push(m[1]);
  }
  for (const key of [...values.keys()].sort()) if (!order.includes(key)) order.push(key);
  const obj: Record<string, unknown> = {};
  for (const key of order) obj[key] = values.get(key);
  return obj;
}

export type Projection =
  /** The text already says what `wanted` says. Nothing to write. */
  | { kind: 'unchanged' }
  /** Nothing may be rewritten, and why. */
  | { kind: 'refused'; reason: 'none' | 'unclosed' | 'stranded' | 'unattributable' | 'still-unparseable' }
  /**
   * The note with the keys rewritten. `droppedComment` when a replaced key's
   * lines held a `#`, which may have been a comment; the caller backs up first.
   */
  | { kind: 'projected'; text: string; rewritten: string[]; removedDuplicates: string[]; droppedComment: boolean };

/**
 * Make each key the text shares with `wanted` hold `wanted`'s value.
 *
 * - **Values only, never the key set.** A key in `wanted` that the text lacks
 *   is not added, and a key the text has that `wanted` lacks is not removed.
 *   Which keys a note has arrives as text, with the edit that changed it.
 *   Writing a key line back from the map is how a deleted property returns.
 * - **One line per key.** A key the text holds twice, because two vaults
 *   added it at once, keeps its first place, holds `wanted`'s value, and
 *   loses the second copy. The second copy is deleted, never rewritten, so
 *   two vaults doing this at once delete the same characters and agree.
 *   A duplicated key `wanted` does not know is left alone, and so is the
 *   block.
 * - **Equal is left alone,** so formatting nobody changed is never churned.
 *
 * Refused unless the result parses. A rewrite that leaves the block broken
 * fixes nothing and changes someone's text.
 */
export function projectFrontmatter(text: string, wanted: ReadonlyMap<string, unknown>): Projection {
  const reading = readFrontmatter(text);
  if (reading.kind !== 'read') return { kind: 'refused', reason: reading.kind };
  const { block, entries } = reading;
  if (entries.length === 0) return { kind: 'unchanged' };

  const seen = new Set<string>();
  const rewritten: string[] = [];
  const removedDuplicates: string[] = [];
  let droppedComment = false;
  let yaml = block.yaml.slice(0, entries[0].start);

  for (const entry of entries) {
    const lines = block.yaml.slice(entry.start, entry.end);
    if (seen.has(entry.key) && wanted.has(entry.key)) {
      removedDuplicates.push(entry.key);
      if (lines.includes('#')) droppedComment = true;
      continue;
    }
    seen.add(entry.key);
    if (wanted.has(entry.key) && !(entry.ok && sameValue(entry.value, wanted.get(entry.key)))) {
      yaml += keyLines(entry.key, wanted.get(entry.key));
      rewritten.push(entry.key);
      if (lines.includes('#')) droppedComment = true;
      continue;
    }
    yaml += lines;
  }

  if (parseWhole(yaml) === null) return { kind: 'refused', reason: 'still-unparseable' };
  if (rewritten.length === 0 && removedDuplicates.length === 0) return { kind: 'unchanged' };
  return {
    kind: 'projected',
    text: text.slice(0, block.from) + yaml + text.slice(block.to),
    rewritten,
    removedDuplicates,
    droppedComment,
  };
}
