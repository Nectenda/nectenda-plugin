/**
 * Redacting what must never leave, wherever a report is built.
 *
 * Shared between the server's error reporter and the plugin's, because two
 * copies of nine regular expressions is exactly the divergence that produced
 * the leak on 11 September 2026: the server's rule gained a pattern and
 * nothing else did. One copy, one set of tests, both sides.
 *
 * On the server this is a denylist over text that should never have contained
 * any of it — the server holds ciphertext, so a match means something upstream
 * is wrong and the report is the symptom. On the client it is the second of
 * two defences: the payload is built from an allowlist (see
 * `error-report.ts` in the plugin), and this runs over what survives, because
 * paths are baked into `Error.message` by the vault adapter and therefore
 * reach stack traces from call sites that never handled a path themselves.
 *
 * It is published deliberately. The plugin ships these patterns inside
 * `main.js` whatever we do, and `docs/security-model.md` exists to be checked
 * rather than believed.
 */
const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/Bearer\s+[A-Za-z0-9._~+/=-]+/g, 'Bearer [redacted]'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[jwt]'],
  [/\bnk_[a-z2-7]{26}\b/g, '[share-key]'],
  [/\b[0-9A-Z]{4}(?:-[0-9A-Z]{4}){4,}\b/g, '[recovery-key]'],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]'],
  // Key material, wraps and ciphertext are long base64 or hex runs. Ids are
  // 32 hex or UUIDs and stay below this length on purpose.
  [/\b[A-Fa-f0-9]{64,}\b/g, '[hex]'],
  [/[A-Za-z0-9+/_-]{64,}={0,2}/g, '[base64]'],
];

/**
 * Vault paths.
 *
 * A note's name is the user's content — "Q3 layoffs.md" tells you what no
 * ciphertext would — and two published documents promise they never ship.
 * Only user-content extensions are listed: .ts/.js/.mjs/.json are deliberately
 * absent, because redacting them would gut the stack traces these reports
 * exist for. Applied before the query pattern so an attachment URL loses its
 * path as well as its signature.
 *
 * Separate from the secrets above because the two have different audiences.
 * Anything leaving the machine must lose both. The plugin's own diagnostic
 * log, which never leaves unless a person sends it, must lose the secrets and
 * **keep** the paths: it exists to diagnose which file failed to sync, and a
 * log that will not say which file is a slower way of losing the same
 * information.
 */
const PATH_PATTERNS: Array<[RegExp, string]> = [
  [/(?:[^\s"'<>|:*?\\]+\/)*[^\s"'<>|:*?/\\]+\.(?:md|canvas|base|png|jpe?g|gif|webp|bmp|svg|pdf|mp3|m4a|wav|ogg|flac|mp4|mov|webm|avi|mkv|zip|docx?|xlsx?|pptx?)\b/gi, '[path]'],
  // Query strings: presigned URLs carry their signature there.
  [/\?[^\s"'<>]+/g, '?[query]'],
];

function apply(s: string, patterns: Array<[RegExp, string]>): string {
  let out = s;
  for (const [re, sub] of patterns) out = out.replace(re, sub);
  return out;
}

/**
 * Everything that must never leave the device: secrets **and** paths.
 *
 * What every error report goes through, on the server and in the plugin.
 */
export function scrubString(s: string): string {
  return apply(apply(s, SECRET_PATTERNS), PATH_PATTERNS);
}

/**
 * Secrets only, for a log that stays on the user's own disk.
 *
 * Tokens, key material and recovery codes have no business in a file the user
 * may mail to us or paste into an issue; the paths do, because they are the
 * question such a file exists to answer.
 */
export function scrubSecrets(s: string): string {
  return apply(s, SECRET_PATTERNS);
}
