import { scrubString } from '@nectenda/shared';
import { PLUGIN_VERSION } from './client-version';

/**
 * Crash reports from the plugin, built from an allowlist.
 *
 * ## Why this is hand-rolled
 *
 * `@sentry/browser` would be a denylist: it owns the event, we subtract from
 * it in `beforeSend`, and a minor version that adds a field ships that field.
 * The specific hazard is breadcrumbs, which are on by default and would
 * capture exactly what this product exists to keep off a server — the
 * path-bearing log lines in `content-sync.ts` and `blob-sync.ts`, and the
 * presigned attachment URLs. Turning all that off takes four separate options
 * in the server's reporter, and every one is a thing somebody has to remember.
 *
 * Here the payload is constructed field by field and nothing else can appear.
 * That also keeps the published bundle small and readable, which is the
 * argument the unminified build rests on: an unminified telemetry SDK for one
 * function would cost more than it is worth.
 *
 * ## What goes
 *
 * The exception type, its scrubbed message, stack frames as line and column
 * numbers, the plugin and Obsidian versions, the platform, and the install id
 * the servers already hold. That is the whole list.
 *
 * ## What does not
 *
 * No `extra`, no context object, no breadcrumbs, no user, no request, no
 * vault name. On the client the stack trace *is* the report;
 * `content-sync.ts` logs a path and a document id together, and that pairing
 * is the one thing that would invert the path HMAC the server is never
 * supposed to be able to reverse. So context fields are not filtered here,
 * they are absent.
 */

/** A Sentry-compatible DSN, split into the parts the store endpoint needs. */
export interface ParsedDsn {
  origin: string;
  projectId: string;
  publicKey: string;
}

/**
 * `https://<key>@<host>/<project>` — the only shape GlitchTip issues.
 *
 * Null rather than throwing on anything unexpected: the DSN arrives from the
 * identity service at runtime, and a malformed one must disable reporting,
 * never break a sign-in.
 */
export function parseDsn(dsn: string): ParsedDsn | null {
  try {
    const u = new URL(dsn);
    const projectId = u.pathname.replace(/^\/+/, '');
    if (!u.username || !projectId || !/^\d+$/.test(projectId)) return null;
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    return { origin: u.origin, projectId, publicKey: u.username };
  } catch {
    return null;
  }
}

export interface ReportMeta {
  /** The install id, which already leaves the device on every request. */
  installId: string;
  /** `Platform`-derived, e.g. "macos" — never a machine or user name. */
  platform: string;
  /** Obsidian's own version, for "only happens on 1.10" questions. */
  obsidian: string;
}

interface Frame {
  filename: string;
  function: string;
  lineno: number;
  colno: number;
}

export interface ClientEvent {
  event_id: string;
  timestamp: number;
  platform: 'javascript';
  level: 'error';
  release: string;
  environment: 'cloud';
  exception: { values: Array<{ type: string; value: string; stacktrace: { frames: Frame[] } }> };
  tags: Record<string, string>;
}

/** The only tag keys that may appear. Anything else is dropped, not sanitised. */
const TAG_KEYS = ['plugin_version', 'obsidian', 'platform', 'install_id'] as const;

const MAX_MESSAGE = 300;
const MAX_FRAMES = 30;

/**
 * A frame's file, reduced to one of three literals.
 *
 * Never a real path. `obsidian-vault.ts` builds resource URLs out of vault
 * paths, so a throw inside one puts a path in `filename`; and the person's
 * home directory is in every frame on a desktop install. The build is
 * unminified and published, so a line and column number is enough to find the
 * code without a source map — which is also why none is ever uploaded.
 */
function frameFile(raw: string | undefined): string {
  if (!raw) return '[frame]';
  if (OURS.test(raw)) return 'plugin:nectenda';
  if (/\bapp\.js\b/.test(raw) || /obsidian\.md/i.test(raw)) return 'obsidian';
  return '[frame]';
}

/**
 * Our own bundle, by its install path rather than by the word "nectenda".
 *
 * Matching the bare word was wrong twice over: a person whose vault is called
 * "Nectenda", or any path with it anywhere above the plugins directory, would
 * have made every other plugin's error look like ours — and during
 * development every frame matches, because the repository itself sits in a
 * directory with that name. Obsidian installs to
 * `<vault>/.obsidian/plugins/<id>/main.js`, so the directory and the id are
 * the part that actually identifies us.
 */
const OURS = /plugins[/\\]nectenda[/\\]/i;

/**
 * Parse a stack into frames, keeping only numbers and a function name.
 *
 * Handles the two shapes V8 emits — `at fn (file:line:col)` and the bare
 * `at file:line:col` — and silently skips anything else, because a report
 * with fewer frames is worth more than no report.
 */
export function parseStack(stack: string | undefined): Frame[] {
  if (!stack) return [];
  const frames: Frame[] = [];
  for (const line of stack.split('\n').slice(1)) {
    const m =
      /^\s*at\s+(.+?)\s+\((.*):(\d+):(\d+)\)\s*$/.exec(line) ??
      /^\s*at\s+()(.*):(\d+):(\d+)\s*$/.exec(line);
    if (!m) continue;
    frames.push({
      // A function name can be a method on a user object, but never user
      // content; still scrubbed, because it costs nothing.
      function: scrubString(m[1] || '?').slice(0, 100),
      filename: frameFile(m[2]),
      lineno: Number(m[3]),
      colno: Number(m[4]),
    });
    if (frames.length >= MAX_FRAMES) break;
  }
  return frames;
}

function uuid(): string {
  // `crypto.randomUUID` is present in Obsidian's Electron and on mobile; the
  // fallback keeps this pure-testable without stubbing globals.
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  const raw = c?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
  return raw.replace(/-/g, '').slice(0, 32).padEnd(32, '0');
}

/**
 * Build the event. Pure: no Obsidian, no fetch, no I/O, no clock beyond
 * `Date.now`, so the whole payload can be asserted in a unit test.
 *
 * `dropped` exists only so a test — and the in-plugin test command — can hand
 * it strings that must not appear anywhere in the output. It is never read.
 */
export function buildEvent(err: unknown, meta: ReportMeta, _dropped?: Record<string, unknown>): ClientEvent | null {
  if (err === null || err === undefined) return null;
  const error = err instanceof Error ? err : new Error(String(err));

  const tags: Record<string, string> = {
    plugin_version: PLUGIN_VERSION,
    obsidian: meta.obsidian,
    platform: meta.platform,
    install_id: meta.installId,
  };
  // Belt: the keys are literals above, so this cannot drop anything today. It
  // is here so that adding a key without adding it to TAG_KEYS is inert
  // rather than a silent new field on the wire.
  for (const k of Object.keys(tags)) {
    if (!(TAG_KEYS as readonly string[]).includes(k)) delete tags[k];
  }

  const event: ClientEvent = {
    event_id: uuid(),
    timestamp: Math.floor(Date.now() / 1000),
    platform: 'javascript',
    level: 'error',
    release: `nectenda-plugin@${PLUGIN_VERSION}`,
    environment: 'cloud',
    exception: {
      values: [
        {
          type: scrubString(error.name || 'Error').slice(0, 100),
          value: scrubString(error.message || '').slice(0, MAX_MESSAGE),
          stacktrace: { frames: parseStack(error.stack) },
        },
      ],
    },
    tags,
  };

  // Braces: the allowlist above is the guarantee, and this is the second
  // pass over whatever survived it. Paths are baked into `Error.message` by
  // the vault adapter, so a message can carry one from a call site that never
  // handled a path itself.
  return scrubDeep(event) as ClientEvent;
}

function scrubDeep(v: unknown): unknown {
  if (typeof v === 'string') return scrubString(v);
  if (Array.isArray(v)) return v.map(scrubDeep);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = scrubDeep(val);
    return out;
  }
  return v;
}

/** The newline-delimited envelope the store endpoint takes. */
export function encodeEnvelope(dsn: ParsedDsn, e: ClientEvent): string {
  const header = JSON.stringify({ event_id: e.event_id, sent_at: new Date().toISOString() });
  const item = JSON.stringify({ type: 'event' });
  return `${header}\n${item}\n${JSON.stringify(e)}`;
}

export function envelopeUrl(dsn: ParsedDsn): string {
  return `${dsn.origin}/api/${dsn.projectId}/envelope/?sentry_key=${encodeURIComponent(dsn.publicKey)}&sentry_version=7`;
}

/**
 * Sending them, without becoming a hazard of its own.
 *
 * This file is on the failure path of a plugin whose one job is not losing
 * people's writing, and `void`-fired async work racing teardown has caused at
 * least four bugs in this repository. So:
 *
 * - `capture` is synchronous up to `void fetch(...)`, returns nothing, and is
 *   never awaited by any caller.
 * - No retries, no queue, no persistence, no flush on unload. A lost report
 *   costs nothing; a buffer of reports is both a retry storm and user data at
 *   rest in a new place.
 * - Every gate is checked before anything is allocated, cheapest first, so a
 *   loop throwing thousands of times a second costs a boolean and a `Set.has`.
 * - It holds no reference to the vault, the provider, the settings object or
 *   any Yjs document — only closures returning primitives, read into a plain
 *   object at capture time. An in-flight POST at teardown therefore cannot
 *   resurrect anything that `stopSync` is dismantling.
 * - `stop()` is called first in `onunload`, before anything else is torn down.
 */
export interface ErrorReportsOptions {
  /** The DSN the identity service handed us, or null when there is none. */
  dsn: () => string | null;
  /** The user's setting. */
  enabled: () => boolean;
  /** Whether the first-run notice has been acknowledged. Nothing sends before it is. */
  acknowledged: () => boolean;
  meta: () => ReportMeta;
  /** Injectable for tests; the plugin passes a plain `fetch`. */
  fetchFn?: typeof fetch;
  onSent?: (event: ClientEvent) => void;
}

/** Per session, because a broken build should not be able to hammer our own box. */
const SESSION_CAP = 5;
const MIN_GAP_MS = 30_000;
const SEND_TIMEOUT_MS = 5_000;

export class ErrorReports {
  private stopped = false;
  private sentCount = 0;
  private lastSentAt = 0;
  private seen = new Set<string>();
  private inFlight = new Set<AbortController>();

  constructor(private readonly opts: ErrorReportsOptions) {}

  /** Never throws, never rejects, never returns a promise. */
  capture(err: unknown, dropped?: Record<string, unknown>): void {
    try {
      if (this.stopped) return;
      if (!this.opts.enabled()) return;
      // On by default, but nothing leaves before the person has been told.
      if (!this.opts.acknowledged()) return;
      const raw = this.opts.dsn();
      if (!raw) return;
      if (this.sentCount >= SESSION_CAP) return;
      const now = Date.now();
      if (now - this.lastSentAt < MIN_GAP_MS) return;

      const signature = signatureOf(err);
      if (this.seen.has(signature)) return;

      const dsn = parseDsn(raw);
      if (!dsn) return;
      const event = buildEvent(err, this.opts.meta(), dropped);
      if (!event) return;

      this.seen.add(signature);
      this.sentCount += 1;
      this.lastSentAt = now;
      this.post(dsn, event);
    } catch {
      // Reporting a failure must never become one.
    }
  }

  private post(dsn: ParsedDsn, event: ClientEvent): void {
    const ac = new AbortController();
    this.inFlight.add(ac);
    const timer = setTimeout(() => ac.abort(), SEND_TIMEOUT_MS);
    const send = this.opts.fetchFn ?? fetch;
    void send(envelopeUrl(dsn), {
      method: 'POST',
      // A plain content type, so the request stays a simple CORS POST rather
      // than acquiring a preflight the tracker may not answer.
      headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
      body: encodeEnvelope(dsn, event),
      signal: ac.signal,
    })
      .then(() => this.opts.onSent?.(event))
      .catch(() => undefined)
      .finally(() => {
        clearTimeout(timer);
        this.inFlight.delete(ac);
      });
  }

  /**
   * Stop, and abandon anything in flight.
   *
   * Called as the first statement of `onunload`, so no callback can fire into
   * state that is being dismantled behind it.
   */
  stop(): void {
    this.stopped = true;
    for (const ac of this.inFlight) ac.abort();
    this.inFlight.clear();
  }
}

/**
 * One error, for de-duplication: the type, the message, and the top frame.
 *
 * Deliberately coarse. A loop that throws the same thing from the same place
 * is one report, however many times it goes round.
 */
function signatureOf(err: unknown): string {
  const e = err instanceof Error ? err : new Error(String(err));
  const top = (e.stack ?? '').split('\n')[1]?.trim() ?? '';
  return `${e.name}|${e.message}|${top}`;
}

/**
 * Is this our own failure?
 *
 * `window.onerror` fires for Obsidian itself and for every other installed
 * plugin. Another plugin's error may carry vault paths or note content we
 * have no business shipping, and its bugs are not ours to collect. This is
 * the most important line in the file.
 */
export function isOurs(err: unknown): boolean {
  const stack = err instanceof Error ? (err.stack ?? '') : '';
  if (!stack) return false;
  return OURS.test(stack);
}
