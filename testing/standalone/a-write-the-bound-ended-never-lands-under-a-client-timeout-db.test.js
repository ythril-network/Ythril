/**
 * A `timeoutMS` in `MONGO_URI` cannot make the client's clock end a bounded write before the server's deadline (`Q-372`, pre-ship
 * finding F1; `Q-716`) — the experiment of `a-write-the-bound-ended-never-lands-db.test.js`, run on a client whose URI names one
 * below the bound.
 *
 * ## The defect
 *
 * The bound puts the server's deadline (`maxTimeMS`) on a bounded write, and no driver clock: a clock starts before the operation has
 * a connection and fires before the server's deadline. A client clock the write inherited from the URI would end it first: the door
 * answers `503` and the hold is released while the write is alive in the server, and it lands after. From driver 7.8.0 the URI option
 * is parsed and ignored, and no server code passes `timeoutMS` (`Q-716`).
 *
 * ## The rule this file holds
 *
 * On a client whose URI sets `timeoutMS=1500` against a 3000 ms bound: the URI names the option, below the bound, and the driver set
 * no clock from it; and **no answer comes before the server's deadline**, on one door lane. A bound that let the client's 1500 ms
 * through would answer at about 1500 ms, which is the red.
 *
 * ## Why one lane, once (bundle-348, Q-923)
 *
 * This file ran the whole table again, every lane repeated: the base experiment on a client the driver configures exactly like the
 * harness's own. Each defect those repetitions could catch is caught elsewhere:
 *
 * - a driver that honours the URI `timeoutMS`: the case "the driver set no clock from it" here (`options.timeoutMS` of the server's
 *   client), and `mongo-client-options.test.js` (the URI's `timeoutMS` is not handed to the client);
 * - a product write that carries `timeoutMS`: `every-bounded-call-carries-the-server-deadline-and-no-client-timeout.test.js` and
 *   `no-server-code-uses-the-drivers-client-timeout.test.js`, and every lane of the base experiment;
 * - an answer before the server's deadline on this client: the one door lane kept here.
 *
 * So one door lane, one repetition: a second client, not a second statistical claim.
 *
 * Run: a Mongo the harness accepts (see `_mongo-harness.mjs`), then
 *      node --test testing/standalone/a-write-the-bound-ended-never-lands-under-a-client-timeout-db.test.js
 * (requires a prior `npm run build` in server/)
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { landingExperiment } from './_write-landing-experiment.mjs';

// Declared HERE, not in the helper: node records a test against the file that calls `it`.
const x = landingExperiment({
  title: 'a write the bound ended never lands afterwards, on a client whose MONGO_URI sets timeoutMS=1500',
  suite: 'boundlandsuri',
  query: '&timeoutMS=1500',
  // The table's first lane: the doors come first in it, so this is a door, whose answer is the 503 a caller reads.
  laneIndexes: [0],
  reps: 1,
  minReps: 1,
  // The bound is 3000 ms and the client's clock half of that. Every OTHER operation of a lane inherits the clock too (the
  // door's own lookups, the harness's reads and seeds — the operator asked for it) and is not the subject: at a 600 ms clock
  // against a 1000 ms bound, a read slowed by the suite's load answered a lane at 573 to 901 ms in most full runs, which is
  // the client's clock firing on an operation the bound does not cover. 1500 ms is room for those and still well below the
  // bound, so an answer before 3000 ms is the clock on the WRITE.
  clientTimeoutMs: 1500,
  boundMs: 3000,
  holdMs: 6000, // an operation late in a hold is bounded by what is left of it: the hold must not be the shorter of the two
});
describe(x.title, { skip: x.skip }, () => {
  before(x.before, { timeout: x.timeout });
  after(x.after);
  it('the one lane kept is a door, so the order claim is held on the answer a caller reads', () => {
    const lanes = x.cases.filter(c => /: nothing it would have written lands after the answer/.test(c.name));
    assert.equal(lanes.length, x.laneCount, 'the lane cases are not one per lane');
    assert.ok(x.laneCount >= 1 && lanes.every(c => c.name.startsWith('door: ')), `the lanes kept are ${lanes.map(c => c.name).join('; ') || 'none'}: not a door`);
  });
  for (const c of x.cases) it(c.name, c.fn);
});
