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
 * file are run again at a lateness that is past the margin.
 *
 * ## The lateness is DERIVED, never a literal
 *
 * `SERVER_FIRST_MARGIN_MS + LATE_PAST_MARGIN_MS`, the margin read out of the built `write-bound.js`. A literal 600 here would
 * go stale the day the margin is raised, and the file would go on passing at a lateness the product is no longer beaten
 * by. The floor below asserts the figure really is past the margin, and the experiment's own case asserts the relay held
 * writes back at all.
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
import { SERVER_FIRST_MARGIN_MS } from '../../server/dist/db/write-bound.js';

/** How far past the backstop's margin the command is held: enough that the server's deadline is plainly after the answer. */
const LATE_PAST_MARGIN_MS = 100;

// Declared HERE, not in the helper: node records a test against the file that calls `it`.
const x = landingExperiment({
  title: 'a write the bound ended never lands afterwards, when its command reaches the server later than the backstop\'s margin',
  suite: 'boundlandslate',
  query: '',
  reps: 3,
  minReps: 3,
  lateByMs: SERVER_FIRST_MARGIN_MS + LATE_PAST_MARGIN_MS,
});
describe(x.title, { skip: x.skip }, () => {
  before(x.before, { timeout: x.timeout });
  after(x.after);
  it('the lateness is past the backstop\'s margin, so the server\'s deadline really is after the answer without the kill step', () => {
    assert.ok(Number.isInteger(SERVER_FIRST_MARGIN_MS) && SERVER_FIRST_MARGIN_MS > 0, `SERVER_FIRST_MARGIN_MS is ${SERVER_FIRST_MARGIN_MS}`);
    assert.ok(x.lateByMs > SERVER_FIRST_MARGIN_MS,
      `the relay holds a write back ${x.lateByMs} ms, not past the ${SERVER_FIRST_MARGIN_MS} ms margin: nothing here is later than the product already tolerates`);
  });
  for (const c of x.cases) it(c.name, c.fn);
});
