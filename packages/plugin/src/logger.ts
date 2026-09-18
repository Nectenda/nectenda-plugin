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

export const log = {
  debug(...args: unknown[]) { console.debug(PREFIX, ...args); emit('DEBUG', args); },
  info(...args: unknown[]) { console.log(PREFIX, ...args); emit('INFO ', args); },
  warn(...args: unknown[]) { console.warn(PREFIX, ...args); emit('WARN ', args); },
  error(...args: unknown[]) { console.error(PREFIX, ...args); emit('ERROR', args); },
};
