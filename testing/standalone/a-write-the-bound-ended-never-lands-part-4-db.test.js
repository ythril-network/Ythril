/**
 * A write the bound answered as timed out NEVER LANDS afterwards — on every door a caller writes through and every holder of a seq
 * hold (`Q-372`). One part of the experiment (`PART` below, from 0).
 *
 * The rule, the lanes, what a lane proves and why the experiment is cut into parts are in
 * `a-write-the-bound-ended-never-lands-db.test.js` (part 1); the cut is `_landing-parts.mjs`'s. This file says which part it runs.
 *
 * Run: a Mongo the harness accepts (see `_mongo-harness.mjs`), then
 *      node --test testing/standalone/a-write-the-bound-ended-never-lands-part-4-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after } from 'node:test';
import { landingExperiment } from './_write-landing-experiment.mjs';
import { partOf } from './_landing-parts.mjs';

const PART = 3;
// Declared HERE, not in the helper: node records a test against the file that calls `it`.
const x = landingExperiment({
  title: `a write the bound ended never lands afterwards (part ${PART + 1})`,
  suite: 'boundlands4',
  query: '',
  reps: 20,
  part: partOf('a-write-the-bound-ended-never-lands', PART),
});
describe(x.title, { skip: x.skip }, () => {
  before(x.before, { timeout: x.timeout });
  after(x.after);
  for (const c of x.cases) it(c.name, c.fn);
});
