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
 * would go on passing at a lateness the product is no longer beaten by. The floor case (`lateCommandExperiment` in
 * `_write-landing-experiment.mjs`, which holds this variant's options for every part) asserts the figure really is past both, and the
 * experiment's own case asserts the relay held writes back at all.
 *
 * Three repetitions per lane, as the diagnosis found enough to be red without the kill step: a lane is a window, not a race.
 *
 * ## More stalls at once, and cut into parts
 *
 * A repetition here is spent sleeping (the relay's lateness on every bounded write of the lane, then the bound), not on the event
 * loop, so this variant stalls more lanes at once than the base file (`LATE_WORKERS`). The lanes are still more
 * than a file's time holds, so they are cut into part files, each its own process with its own door: this file is part 1 and
 * `a-write-the-bound-ended-never-lands-when-the-command-is-late-part-2-db.test.js` the next. The cut is `_landing-parts.mjs`'s, and
 * that the parts run every lane exactly once is `the-parts-of-a-split-landing-experiment-run-every-lane-once.test.js`'s.
 *
 * Run: a Mongo the harness accepts (see `_mongo-harness.mjs`), then
 *      node --test testing/standalone/a-write-the-bound-ended-never-lands-when-the-command-is-late-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after } from 'node:test';
import { lateCommandExperiment } from './_write-landing-experiment.mjs';
import { partOf } from './_landing-parts.mjs';

const PART = 0;
// Declared HERE, not in the helper: node records a test against the file that calls `it`. The options, and the floor case that the
// lateness is past the margin and the kill window, are `lateCommandExperiment`'s: one copy for every part.
const x = lateCommandExperiment({
  title: `a write the bound ended never lands afterwards, when its command reaches the server later than the backstop can wait (part ${PART + 1})`,
  suite: 'boundlandslate',
  part: partOf('a-write-the-bound-ended-never-lands-when-the-command-is-late', PART),
});
describe(x.title, { skip: x.skip }, () => {
  before(x.before, { timeout: x.timeout });
  after(x.after);
  for (const c of x.cases) it(c.name, c.fn);
});
