/**
 * A write the bound answered as timed out NEVER LANDS afterwards — on every door a caller writes through and every
 * holder of a seq hold (`Q-372`, found by main's CI run 37231507558).
 *
 * ## The defect
 *
 * The write bound is a driver `timeoutMS` (`db/write-bound.ts`). The driver starts that timer when the operation
 * starts; the server's `maxTimeMS` is derived from what is left when the command is built, less the round-trip time,
 * and armed when the command ARRIVES. Normally the two deadlines are a millisecond apart. When the command is late —
 * a busy server, a slow link, a connection that had to be opened — the CLIENT's deadline passes first: the caller is
 * answered `503`, the seq hold is released, and the write is still alive in the server, waiting behind whatever
 * stalled it. When that goes (here: the lock is released) it retries, finds the way clear, and writes — after the
 * answer, after the hold, and in the CI run that found this, after the next case's wipe, so its fork collided with
 * the next case's lock (`E11000`).
 *
 * That breaks the promise `write-bound.ts` states and `docs/integration-guide/02-hosting.md` repeats: the bound ends the
 * operation on the client AND the server, so a hold is released when its write ENDS, never abandoned while the write is
 * alive. A record landing with a seq below a reader's cursor is exactly `Q-196`, the defect the hold exists for.
 *
 * ## The rule this file holds
 *
 * **Once a door has answered that a write timed out, nothing that write would have written ever lands.** Not a count
 * of documents: the identity of every document of the space (and its counter row) is read at the moment the door
 * answers, the stall is released AT ONCE, and the same documents are read again for a settle window. Anything added,
 * removed or rewritten in that window is named.
 *
 * ## The lateness is made, not hoped for (`_delayed-write-relay.mjs`)
 *
 * On a quiet machine the two deadlines are so close that the write is not alive long enough after the answer for a
 * release to reach it — which is why this was a one-in-N flake in CI and would be a one-in-N test here. So the server's
 * Mongo layer reaches the store through a relay that holds back every write carrying the bound's `maxTimeMS` by
 * `LATE_BY_MS`: the server's deadline is then that much later than the client's, on every run, and the defect is a
 * window of known width instead of a race. A bound that really ends the operation on the server first (a server
 * deadline earlier than the client's by more than `LATE_BY_MS`) is green however late the command is.
 *
 * ## Every door, and every holder — derived, never listed
 *
 * The lanes are `_stalled-write-doors.mjs`'s doors (the table `a-write-timeout-answers-503-on-every-door-db` walks) and
 * `_seq-hold-cases.mjs`'s holder cases (the table `a-write-inside-a-seq-hold-always-ends-db` walks), each with a space
 * of its own so several stall together. Floors on both sets: an empty table would pass every loop written over it.
 * A holder whose write runs inside a transaction is green for the right reason — a timed transaction that was aborted
 * cannot land anything — and only a plain bounded write can be red.
 *
 * ## Repeated, at the bound's minimum
 *
 * Each lane is run `reps` times with the bound at its 1000 ms minimum (`setWriteBoundForTest`). Every repetition is its
 * own result; a lane is green only when none of them landed anything.
 *
 * ## And on a client whose own defaults would end the write first
 *
 * An operator may put `timeoutMS` in `MONGO_URI`; every operation without a `timeoutMS` of its own inherits it, and a bounded
 * plain write sets none (a driver clock is what the bound avoids), so the bound has to switch it off for the write. That is
 * held by the same experiment on a client whose URI carries one below the bound:
 * `a-write-the-bound-ended-never-lands-under-a-client-timeout-db.test.js` (a file of its own: the server's modules are one
 * client per process, `_write-landing-experiment.mjs`).
 *
  * ## What else a lane proves
 *
 * That it STALLED: the server is asked, while the call waits, whether a write is alive on the locked collection — a lock
 * that stalled nothing makes "nothing landed" a claim about nothing. That the door answered `503` where the door table says it must. That the release did not fail
 * (`_write-faults.mjs` makes it wait for the server to be quiet, and throw when it is not).
 *
 * Run: a Mongo the harness accepts (see `_mongo-harness.mjs`), then
 *      node --test testing/standalone/a-write-the-bound-ended-never-lands-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { defineLandingExperiment } from './_write-landing-experiment.mjs';

defineLandingExperiment({
  title: 'a write the bound ended never lands afterwards',
  suite: 'boundlands',
  query: '',
  reps: 20,
});
