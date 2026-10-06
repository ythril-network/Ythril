/**
 * The landing experiment is CORRECT AT ANY LANE COUNT: a repetition never starts seeding a lane while the one before it is
 * still being watched (`Q-380`, found while diagnosing it).
 *
 * ## The defect in the harness
 *
 * `runAll` (`_write-landing-experiment.mjs`) chained a lane's repetitions through `previous[lane]`, but assigned it only AFTER
 * the repetition's stall had run. A worker that pulled the same lane's next repetition before that — possible whenever the
 * lanes are fewer than, or close to, the workers — awaited the initial resolved promise, wiped and re-seeded the lane's space
 * and set its counter while the previous repetition's settle window was open. The experiment then reported that re-seed as a
 * LANDING ("counter changed"), and the wipe as an `E11000` fixture error in the repetition after. With the whole table
 * (24 lanes, 4 workers) the next repetition of a lane is pulled 24 tasks later, which is longer than a stall, so the full
 * files were correct only because the lane count was large against the worker count.
 *
 * ## The rule this file holds
 *
 * Four lanes, four workers, against a product that is green at the lateness used (80 ms, as the main file): NOTHING is
 * reported landed and no repetition fails to run. A false landing or an `E11000` here is the harness, not the product.
 *
 * Run: a Mongo the harness accepts (see `_mongo-harness.mjs`), then
 *      node --test testing/standalone/a-write-the-bound-ended-never-lands-on-a-narrow-run-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { landingExperiment } from './_write-landing-experiment.mjs';

// Declared HERE, not in the helper: node records a test against the file that calls `it`.
const x = landingExperiment({
  title: 'a narrow run of the landing experiment (as many lanes as workers) reports no false landing',
  suite: 'boundlandsnarrow',
  query: '',
  reps: 6,
  laneIndexes: [0, 1, 2, 3],
});
describe(x.title, { skip: x.skip }, () => {
  before(x.before, { timeout: x.timeout });
  after(x.after);
  it('the run really is narrow: no more lanes than the workers it shares', () => {
    assert.equal(x.laneCount, 4, `${x.laneCount} lanes: the case that exposed the defect is as many lanes as workers`);
  });
  for (const c of x.cases) it(c.name, c.fn);
});
