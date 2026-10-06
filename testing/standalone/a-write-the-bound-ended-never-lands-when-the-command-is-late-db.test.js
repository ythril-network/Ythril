/**
 * A write the bound answered as timed out NEVER LANDS afterwards, however LATE its command reaches the server (`Q-380`).
 *
 * ## The defect
 *
 * `a-write-the-bound-ended-never-lands-db.test.js` holds the rule with the command held back 80 ms on the wire. That is
 * inside the headroom the bound has: the server's deadline starts when the command ARRIVES, the client backstop's at the
 * CALL, and the backstop is armed `SERVER_FIRST_MARGIN_MS` after the server's deadline would be — so the server's deadline is
 * past by the backstop only when the command arrived less than `SERVER_FIRST_MARGIN_MS` late. A command later than that
 * (a starved client process, a CPU-starved mongod taking it late, a full connection pool) leaves the server operation ALIVE
 * when the caller is answered `503` and the hold is released, and it lands the moment its blocker goes. Measured in the
 * diagnosis (bundle-53, with the relay at 600 ms): 2 of 24 lanes green, 53 of 63 repetitions landed.
 *
 * ## The rule this file holds
 *
 * **The caller is answered, and a hold released, only once the server operation is gone** — ended by its own deadline, or
 * killed by the backstop (`callBounded`: a `comment` on the write, `$currentOp`, `killOp`). So the SAME lanes as the 80 ms
 * file are run again at a lateness that is past what the backstop can wait out.
 *
 * ## Why the lateness is past the margin AND the kill window
 *
 * The backstop answers at most `SERVER_FIRST_MARGIN_MS + KILL_WAIT_MS` after the server's deadline would have been. A command
 * later than the margin but earlier than the margin plus the kill window is ended by the server's own deadline INSIDE the kill
 * window, whether or not anything is killed: a backstop that only polled (the kill removed) would pass there, which is how this
 * file first came to be green under the mutation it exists to catch. Past both, only the kill ends the operation before the
 * answer: with `SERVER_FIRST_MARGIN_MS + KILL_WAIT_MS + LATE_PAST_MS`, the server's deadline is `LATE_PAST_MS` after the
 * backstop's last look.
 *
 * ## The lateness is DERIVED, never a literal
 *
 * Both figures are read out of the built `write-bound.js`. A literal here would go stale the day either is changed, and the file
 * would go on passing at a lateness the product is no longer beaten by. The floor below asserts the figure really is past both,
 * and the experiment's own case asserts the relay held writes back at all.
 *
 * Three repetitions per lane, as the diagnosis found enough to be red without the kill step: a lane is a window, not a race.
 *
 * Run: a Mongo the harness accepts (see `_mongo-harness.mjs`), then
 *      node --test testing/standalone/a-write-the-bound-ended-never-lands-when-the-command-is-late-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { landingExperiment } from './_write-landing-experiment.mjs';
import * as writeBound from '../../server/dist/db/write-bound.js';

// A namespace import: a build without `KILL_WAIT_MS` fails the floor below instead of the whole file at link time.
const { SERVER_FIRST_MARGIN_MS, KILL_WAIT_MS } = writeBound;
/** How far past the backstop's last look the server's deadline falls: enough that it is plainly after the answer. */
const LATE_PAST_MS = 100;

// Declared HERE, not in the helper: node records a test against the file that calls `it`.
const x = landingExperiment({
  title: 'a write the bound ended never lands afterwards, when its command reaches the server later than the backstop can wait',
  suite: 'boundlandslate',
  query: '',
  reps: 3,
  minReps: 3,
  lateByMs: SERVER_FIRST_MARGIN_MS + (KILL_WAIT_MS ?? 0) + LATE_PAST_MS,
  // The relay holds EVERY bounded write of a lane back, so an operation that is not the first of its hold starts its clock a
  // lateness later each. At the 1000 ms hold the 80 ms file keeps, the hold's own deadline was spent by the first writes of the
  // pushed-fork lanes and the write the lane stalls was never SENT (a hold whose time is spent refuses the next operation): the
  // lane stalled nothing. A hold of 10 000 ms leaves every lane's stalled write its own full bound; the per-operation bound
  // stays the 1000 ms minimum.
  holdMs: 10_000,
  boundMs: 1000,
});
describe(x.title, { skip: x.skip }, () => {
  before(x.before, { timeout: x.timeout });
  after(x.after);
  it('the lateness is past the backstop\'s margin AND its kill window, so only the kill ends the operation before the answer', () => {
    assert.ok(Number.isInteger(SERVER_FIRST_MARGIN_MS) && SERVER_FIRST_MARGIN_MS > 0, `SERVER_FIRST_MARGIN_MS is ${SERVER_FIRST_MARGIN_MS}`);
    assert.ok(Number.isInteger(KILL_WAIT_MS) && KILL_WAIT_MS > 0, `KILL_WAIT_MS is ${KILL_WAIT_MS}`);
    assert.ok(x.lateByMs > SERVER_FIRST_MARGIN_MS + KILL_WAIT_MS,
      `the relay holds a write back ${x.lateByMs} ms, not past the ${SERVER_FIRST_MARGIN_MS} ms margin plus the ${KILL_WAIT_MS} ms kill window: `
      + 'a backstop that only waited would pass');
  });
  for (const c of x.cases) it(c.name, c.fn);
});
