import { log } from './logger';

/**
 * A guard against a synchronous loop: code that triggers itself through
 * observers, inside one turn of the event loop, never yields, and freezes
 * Obsidian with nothing in the log to say why — a renderer spinning at full
 * CPU with memory climbing was all the hardness run could see (seed 4, round
 * 87, twice). Each guarded call counts itself; the count resets on the next
 * turn of the event loop (a timer). Not a microtask: the loop that froze it
 * was itself a chain of microtasks — settle queued as one after each
 * transaction — which never yields to timers, and a count reset in a
 * microtask between its links never reached the limit. Past
 * the limit it logs the name and the stack, and throws: the caller's failure
 * path lets go of whatever it was doing, so the user keeps a working app and
 * the log says which loop it was.
 */
const counts = new Map<string, number>();
const LIMIT = 500;

export class RunawayLoop extends Error {}

let stops = 0;

/** How many loops have been stopped, ever: for tests to assert none was. */
export function runawaysStopped(): number {
  return stops;
}

export function guardRunaway(name: string, detail?: Record<string, unknown>): void {
  const n = (counts.get(name) ?? 0) + 1;
  counts.set(name, n);
  if (n === 1) window.setTimeout(() => counts.delete(name), 0);
  if (n <= LIMIT) return;
  counts.delete(name);
  stops++;
  const err = new RunawayLoop(`${name} ran ${LIMIT} times without yielding`);
  log.error('Stopped a runaway loop', { name, ...detail, stack: err.stack });
  throw err;
}
