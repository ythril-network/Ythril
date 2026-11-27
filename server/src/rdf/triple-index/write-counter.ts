/**
 * The update part that raises the triple index's write counter (`writes` on the state row), spelled once (bundle-378, Q-976, lens finding L1.2).
 *
 * ## The question it answers
 *
 * "How does a write of the state row say the index changed?" The planner's counts are kept under the counter and reused while it reads the same
 * (`read.ts`), so every write that changes the index raises it by exactly one, in the same write as the change, and a write that is not a change
 * (a lease, a build fence) never does. Three writers raise it: the index's own writes (`store.ts`), the stale mark (`stale-mark.ts`, which keeps
 * out of `store.ts`'s import cycle) and the 5.6 rollback tool (`sync/positions-rollback.ts`, which runs with no instance up). A copy spelled by hand
 * in a fourth writer could name another field or another step, and the cache would then believe an index that changed was the one it counted.
 *
 * ## What it prevents
 *
 * A leaf on purpose: it imports nothing, so no writer takes the store (and the cycle it sits in) for one constant.
 * `the-triple-index-write-counter-update-is-spelled-in-one-module.test.js` fails a second spelling.
 */

/** Spread into an update beside its own `$set`/`$max`: `{ $set: { status }, ...RAISE_WRITES }`. */
export const RAISE_WRITES = Object.freeze({ $inc: Object.freeze({ writes: 1 }) });
