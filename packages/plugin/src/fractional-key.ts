/**
 * Order keys: strings that sort in the order their items should appear, where
 * a new key can always be made between any two others without renumbering.
 *
 * Used for canvas z-order. A position in an array is the obvious model and the
 * wrong one for a CRDT: one "bring to front" renumbers every card after it, and
 * two vaults doing it at once overwrite each other's orderings wholesale. A key
 * per item means a reorder changes only the item that moved.
 *
 * The midpoint construction is the one in rocicorp's `fractional-indexing`
 * (CC0), without its integer part: keys are digit strings read as fractions in
 * (0, 1), compared by plain string comparison. Two things are added, because
 * that library assumes a central authority and we have none:
 *
 * - **Jitter.** Keys are deterministic in the library, so two vaults appending
 *   a card to the same board compute the same key. tldraw hit exactly this,
 *   crashing on duplication, and moved to a jittered fork. Here each key is
 *   placed at a random one of 2^JITTER_BITS sub-intervals of the gap.
 * - **Equal keys are expected, not an error.** Jitter makes a collision rare,
 *   not impossible. Readers sort by `(key, id)`, so equal keys still give one
 *   order everywhere, and nothing ever asks for a key between two equal ones:
 *   `keysBetween` treats a range it cannot fit into as open above.
 */

const DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const ZERO = DIGITS[0];
const JITTER_BITS = 4;

/** Whether a key is one this module could have made. Anything else sorts, but is never built on. */
export function isValidKey(key: string): boolean {
  if (key === '' || key.endsWith(ZERO)) return false;
  for (const c of key) if (!DIGITS.includes(c)) return false;
  return true;
}

/** A key strictly between `a` and `b` ('' is the bottom, null the top). */
function midpoint(a: string, b: string | null): string {
  if (b !== null) {
    let n = 0;
    while ((a[n] ?? ZERO) === b[n]) n++;
    if (n > 0) return b.slice(0, n) + midpoint(a.slice(n), b.slice(n));
  }
  const digitA = a ? DIGITS.indexOf(a[0]) : 0;
  const digitB = b !== null ? DIGITS.indexOf(b[0]) : DIGITS.length;
  if (digitB - digitA > 1) return DIGITS[Math.round(0.5 * (digitA + digitB))];
  if (b !== null && b.length > 1) return b.slice(0, 1);
  return DIGITS[digitA] + midpoint(a.slice(1), null);
}

/**
 * `n` ascending keys strictly between `lo` and `hi`.
 *
 * `lo` of '' means "before everything", `hi` of null "after everything". A
 * range that is empty or inverted — equal neighbours, or an order a concurrent
 * edit disturbed — is treated as open above rather than refused: the new keys
 * land after `lo`, and the `(key, id)` tie-break keeps every reader agreeing.
 */
export function keysBetween(lo: string, hi: string | null, n: number, random: () => number = Math.random): string[] {
  if (n <= 0) return [];
  let a = isValidKey(lo) ? lo : '';
  let b = hi !== null && isValidKey(hi) && hi > a ? hi : null;
  // Narrow to a random sub-interval, so two vaults filling the same gap at
  // once rarely pick the same keys.
  for (let i = 0; i < JITTER_BITS; i++) {
    const m = midpoint(a, b);
    if (random() < 0.5) b = m;
    else a = m;
  }
  return spread(a, b, n);
}

/** `n` keys spread evenly through (a, b), so a long run stays short. */
function spread(a: string, b: string | null, n: number): string[] {
  if (n === 0) return [];
  const mid = midpoint(a, b);
  const left = Math.floor((n - 1) / 2);
  return [...spread(a, mid, left), mid, ...spread(mid, b, n - 1 - left)];
}
