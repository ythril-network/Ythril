/**
 * Narrowing a set of figures for a test — merged, and refused when it cannot be used.
 *
 * ## The question it answers
 *
 * "A test wants a 20 ms hold or a 50 ms write bound: how does a module let it narrow some of its figures without the test being able
 * to set nothing, or set the wrong thing, and pass for the wrong reason?" Two modules keep figures a test narrows
 * (`db/write-bound.ts`, `files/move-timing.ts`) and each had the same body for it, word for word.
 *
 * ## What it prevents
 *
 * - **A seam that copies exactly the figures it knew**: a caller that passed the two it had always passed set a figure added later to
 *   `undefined`, and `Math.min(undefined, …)` is `NaN`, a bound that is no bound. It MERGES.
 * - **A figure that is not a finite positive number**: `0` is, to the driver, "no bound", and `NaN` or a string is a typo of a kind a
 *   test would otherwise pass with. It is refused.
 * - **A typo in a name** (`writeTimeoutM`) that would set nothing: a name that is not one of `current`'s is refused.
 * - **An empty call**, which narrows nothing and reads as if it did.
 *
 * A refusal changes nothing: the figures are returned, never mutated. `caller` and `subject` only word the refusal.
 */

/** `current` with `given` merged over it, or a refusal naming `caller` (the function the test called) and `subject` (what the figures are of). */
export function narrowedFigures<T extends object>(caller: string, subject: string, current: T, given: Partial<T>): T {
  const known = Object.keys(current);
  const entries = Object.entries(given);
  if (entries.length === 0) throw new Error(`${caller}: no figure given (${known.join(', ')})`);
  for (const [name, value] of entries) {
    if (!known.includes(name)) throw new Error(`${caller}: "${name}" is not a figure of ${subject} (${known.join(', ')})`);
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      throw new Error(`${caller}: ${name} must be a finite positive number, got ${String(value)}`);
    }
  }
  return { ...current, ...given };
}
