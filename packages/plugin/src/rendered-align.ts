/**
 * Where a caret in a card's Markdown falls in the card as rendered — for a card
 * someone is typing in that this person is only looking at (canvas-presence.ts).
 *
 * A rendered card is not its source. Syntax is dropped (`**`, `#`, `[[`), a link
 * shows its alias and hides its URL, and an embed or a formula is replaced by
 * something that shares no characters with what was typed. So the rendered text
 * is matched back to the source, and a caret is placed only where that match
 * can be trusted. Where it cannot, no bar is drawn and the card's outline alone
 * says who is typing in it: a caret in the wrong place is worse than none.
 *
 * Matched **in order**, never by searching the whole source for each piece: a
 * word that occurs twice is then matched to the copy that comes next, not to
 * the first one in the card.
 *
 * Pure: strings in, indices out. The DOM side is in canvas-presence.ts.
 */

/** How far ahead in the source a piece of rendered text may be found. */
const WINDOW = 400;
/** Past this many unmatched visible source characters around a caret inside them — an embed, a formula — no bar. */
export const MAX_GAP = 16;
/** Below this share of the rendered text matched, the card is too unlike its source to place a bar in. */
export const MIN_COVERAGE = 0.6;

export interface Alignment {
  /** `[source index, rendered index]`, ascending in both. Whitespace is never matched. */
  pairs: Array<[number, number]>;
  /** The rendered text aligned, for placing a caret on the whitespace between matches. */
  rendered: string;
  /** Of the rendered text's visible characters, the share matched to the source. */
  coverage: number;
}

const isSpace = (c: string): boolean => /\s/.test(c);

/**
 * Match the rendered text to the source, in order.
 *
 * Each run of visible rendered characters is looked for whole first, at or
 * after the last match: that keeps a word from being scattered across a URL
 * the renderer hid (`[go](https://go.example) home` renders "go home", and the
 * "h" of "home" must not land on the "h" of "https"). A run not found whole —
 * formatting inside a word, `**bo**ld` — is matched character by character,
 * each within a bounded window; one not found at all is left unmatched.
 */
export function alignRendered(source: string, rendered: string): Alignment {
  const pairs: Array<[number, number]> = [];
  let visible = 0;
  let matched = 0;
  let i = 0;
  const runs = rendered.matchAll(/\S+/g);
  for (const run of runs) {
    const text = run[0];
    const at = run.index ?? 0;
    visible += text.length;
    const whole = source.indexOf(text, i);
    if (whole !== -1 && whole - i <= WINDOW) {
      for (let k = 0; k < text.length; k++) pairs.push([whole + k, at + k]);
      matched += text.length;
      i = whole + text.length;
      continue;
    }
    for (let k = 0; k < text.length; k++) {
      const limit = Math.min(source.length, i + WINDOW);
      let found = -1;
      for (let s = i; s < limit; s++) {
        if (source[s] === text[k]) {
          found = s;
          break;
        }
      }
      if (found === -1) continue;
      pairs.push([found, at + k]);
      matched++;
      i = found + 1;
    }
  }
  return { pairs, rendered, coverage: visible === 0 ? 0 : matched / visible };
}

/**
 * Where to draw a caret at `caret` in `source`: beside a rendered character,
 * `before` or `after` it — or null when that cannot be trusted.
 *
 * A caret on a matched character goes before it. A caret in text the renderer
 * hid snaps to the nearer matched neighbour, by source distance: inside `**`
 * before a word it lands at the word, after the last letter it stays there.
 * Too many hidden visible characters around it, and it is inside something
 * that was replaced rather than restyled; that gives no bar, as does a card
 * whose rendering matches too little of its source at all.
 */
export function renderedCaret(
  source: string,
  alignment: Alignment,
  caret: number,
  /**
   * Which neighbour a caret in hidden text snaps to: the nearer one, for a
   * caret; for a selection's ends, inward — its start to the next visible
   * character and its end to the previous — so selecting `**bold**` covers
   * "bold" and not the spaces around it.
   */
  snap: 'nearest' | 'forward' | 'backward' = 'nearest',
): { rendered: number; side: 'before' | 'after' } | null {
  const { pairs, rendered } = alignment;
  if (pairs.length === 0 || alignment.coverage < MIN_COVERAGE) return null;
  // The first pair at or after the caret.
  let lo = 0;
  let hi = pairs.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (pairs[mid][0] < caret) lo = mid + 1;
    else hi = mid;
  }
  const next = pairs[lo];
  const prev = lo > 0 ? pairs[lo - 1] : undefined;
  if (next && next[0] === caret) return { rendered: next[1], side: 'before' };

  const gapStart = prev ? prev[0] + 1 : 0;
  const gapEnd = next ? next[0] : source.length;
  // Hidden visible characters on each side of the caret, within the gap. A
  // long run with some on both sides has the caret inside it — an embed, a
  // formula — and there is nowhere true to draw it. At the run's edge, with
  // only whitespace between the caret and the text beside it, it belongs to
  // that text however long the run beyond it is.
  let before = 0;
  let after = 0;
  for (let s = gapStart; s < caret; s++) if (!isSpace(source[s])) before++;
  for (let s = caret; s < gapEnd; s++) if (!isSpace(source[s])) after++;
  if (before + after > MAX_GAP) {
    if (before === 0 && prev) return { rendered: prev[1], side: 'after' };
    if (after === 0 && next) return { rendered: next[1], side: 'before' };
    return null;
  }

  if (!prev) return next ? { rendered: next[1], side: 'before' } : null;
  if (!next) return { rendered: prev[1], side: 'after' };
  // Whitespace only, rendered as the very same whitespace (a space between
  // two words): the caret is on a character that is there, so it is placed
  // there rather than snapped — a selection starting at a space covers it.
  const renderedGap = rendered.slice(prev[1] + 1, next[1]);
  if (before + after === 0 && renderedGap === source.slice(gapStart, gapEnd) && !renderedGap.includes('\n')) {
    return caret === gapStart
      ? { rendered: prev[1], side: 'after' }
      : { rendered: prev[1] + 1 + (caret - gapStart), side: 'before' };
  }
  if (snap === 'forward') return { rendered: next[1], side: 'before' };
  if (snap === 'backward') return { rendered: prev[1], side: 'after' };
  return caret - gapStart <= gapEnd - caret
    ? { rendered: prev[1], side: 'after' }
    : { rendered: next[1], side: 'before' };
}

/**
 * A selection from source `a` to `b`, either way round, as a span of the
 * rendered text: `start` inclusive, `end` exclusive. Null unless both ends can
 * be placed by `renderedCaret`'s rules — a selection reaching into an embed is
 * not half drawn — or when it covers nothing that is rendered, such as a
 * selection of only the `**` around a word.
 */
export function renderedSpan(
  source: string,
  alignment: Alignment,
  a: number,
  b: number,
): { start: number; end: number } | null {
  const from = renderedCaret(source, alignment, Math.min(a, b), 'forward');
  const to = renderedCaret(source, alignment, Math.max(a, b), 'backward');
  if (!from || !to) return null;
  const start = from.side === 'before' ? from.rendered : from.rendered + 1;
  const end = to.side === 'before' ? to.rendered : to.rendered + 1;
  return end > start ? { start, end } : null;
}
