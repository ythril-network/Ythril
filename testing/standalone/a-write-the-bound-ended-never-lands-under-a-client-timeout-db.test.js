/**
 * A write the bound ended NEVER LANDS afterwards, on a client whose `MONGO_URI` carries a `timeoutMS` below the bound
 * (`Q-372`, pre-ship finding F1) — the experiment of `a-write-the-bound-ended-never-lands-db.test.js`, run on that client.
 *
 * ## The defect
 *
 * The bound puts `maxTimeMS` on a plain write and no `timeoutMS`, because a driver clock starts before the operation has a
 * connection and fires before the server's deadline. But the driver resolves `options?.timeoutMS ?? parent?.timeoutMS`
 * (`lib/utils.js`), so a `timeoutMS` an operator put in `MONGO_URI` is inherited by a write that sets none: the client's
 * clock ends the write first, the door answers `503` and the hold is released while the write is alive in the server, and it
 * lands after — the defect the bound exists to close, back for any operator who sets one.
 *
 * ## The rule this file holds
 *
 * Everything the base file holds (nothing a timed-out write would have written lands after the answer, on every door and
 * every holder), on a client whose URI sets `timeoutMS=1500` against a 3000 ms bound, and one thing more: **no answer comes
 * before the server's deadline**. A bound that lets the client's 1500 ms through answers at ~1500 ms, which is the red.
 *
 * Fewer repetitions than the base file: this is a second client, not a second statistical claim.
 *
 * Run: a Mongo the harness accepts (see `_mongo-harness.mjs`), then
 *      node --test testing/standalone/a-write-the-bound-ended-never-lands-under-a-client-timeout-db.test.js
 * (requires a prior `npm run build` in server/)
 */

import { defineLandingExperiment } from './_write-landing-experiment.mjs';

defineLandingExperiment({
  title: 'a write the bound ended never lands afterwards, on a client whose MONGO_URI sets timeoutMS=1500',
  suite: 'boundlandsuri',
  query: '&timeoutMS=1500',
  reps: 5,
  // The bound is 3000 ms and the client's clock half of that. Every OTHER operation of a lane inherits the clock too (the
  // door's own lookups, the harness's reads and seeds — the operator asked for it) and is not the subject: at a 600 ms clock
  // against a 1000 ms bound, a read slowed by the suite's load answered a lane at 573 to 901 ms in most full runs, which is
  // the client's clock firing on an operation the bound does not cover. 1500 ms is room for those and still well below the
  // bound, so an answer before 3000 ms is the clock on the WRITE.
  clientTimeoutMs: 1500,
  boundMs: 3000,
  holdMs: 6000, // an operation late in a hold is bounded by what is left of it: the hold must not be the shorter of the two
});
