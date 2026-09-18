import { scrubSecrets } from '@nectenda/shared';

const PREFIX = '[Nectenda]';

/**
 * Diagnostic sink: mirrors every line to a file in the vault.
 *
 * What reaches the file is scrubbed of secrets but **keeps vault paths**. Both
 * halves are deliberate. A token, a wrapped key or a recovery code has no
 * business sitting in a file somebody may mail to us or paste into an issue,
 * and several call sites log a whole caught error whose message could carry
 * one. The paths stay because the file exists to answer "which note failed to
 * sync", and a log that will not say which note is a slower way of losing the
 * same information.
 *
 * Console output is not scrubbed: it goes to the developer tools of the
 * person's own Obsidian and nowhere else, and keeping it verbatim is what
 * makes the console useful while debugging.
 */
type Sink = (line: string) => void;
let sink: Sink | null = null;

export function setLogSink(fn: Sink | null): void {
  sink = fn;
}

function emit(level: string, args: unknown[]): void {
  if (!sink) return;
  const parts = args.map((a) => {
    if (typeof a === 'string') return a;
    try {
      return JSON.stringify(a);
    } catch {
      return String(a);
    }
  });
  sink(scrubSecrets(`${new Date().toISOString()} ${level} ${parts.join(' ')}`));
}

/**
 * Whether routine console output is wanted.
 *
 * Obsidian's plugin guidelines ask that the developer console show only errors
 * by default, and this plugin was printing an `[Nectenda]` line at `info` for
 * every sync, sign-in and folder event — in the console of a person who had not
 * asked to see any of it, and alongside every other plugin doing the same.
 *
 * Tied to the diagnostic-log setting, which already exists and already defaults
 * to off, rather than to a new one: somebody turning diagnostics on wants to
 * see what is happening, and that is the same wish. Warnings and errors ignore
 * this — they are the exception the guideline makes — and the file sink is
 * untouched, because what reaches the file is governed by whether a sink was
 * installed at all.
 */
let verbose = false;

export function setVerboseLogging(on: boolean): void {
  verbose = on;
}

export const log = {
  debug(...args: unknown[]) { if (verbose) console.debug(PREFIX, ...args); emit('DEBUG', args); },
  // `console.debug`, like `debug` above: Obsidian asks that a plugin's console
  // output be errors only by default. The cost is that devtools hides debug
  // level unless "Verbose" is ticked, so somebody talked through turning
  // diagnostics on sees nothing here until they raise it too — the vault file
  // still receives every line, and that is the artefact we ask people for.
  // The sink label stays 'INFO ', padding included: it aligns the file.
  info(...args: unknown[]) { if (verbose) console.debug(PREFIX, ...args); emit('INFO ', args); },
  warn(...args: unknown[]) { console.warn(PREFIX, ...args); emit('WARN ', args); },
  error(...args: unknown[]) { console.error(PREFIX, ...args); emit('ERROR', args); },
};
