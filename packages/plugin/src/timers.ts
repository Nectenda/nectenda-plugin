/** A `window.setTimeout`/`setInterval` handle: a number.
 *
 * Spelled out rather than `ReturnType<typeof window.setTimeout>`, which looks
 * tidier and is wrong here. `@types/node` is a devDependency, so the global is
 * overloaded, and `ReturnType<>` resolves the *last* overload — Node's
 * `Timeout` — while the call itself resolves the DOM one and returns a number.
 * The two disagree and nothing says so until an assignment fails.
 */
export type TimerHandle = number;
