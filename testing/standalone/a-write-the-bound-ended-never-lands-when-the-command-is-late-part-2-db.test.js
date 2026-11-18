/**
 * A write the bound answered as timed out NEVER LANDS afterwards, however LATE its command reaches the server (`Q-380`). Part 2 of
 * the late experiment.
 *
 * The rule, why the lateness is past the margin and the kill window, and why the experiment is cut into parts are in
 * `a-write-the-bound-ended-never-lands-when-the-command-is-late-db.test.js` (part 1); the options are `lateCommandExperiment`'s and the
 * cut is `_landing-parts.mjs`'s. This file says which part it runs.
 *
 * Run: a Mongo the harness accepts (see `_mongo-harness.mjs`), then
 *      node --test testing/standalone/a-write-the-bound-ended-never-lands-when-the-command-is-late-part-2-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after } from 'node:test';
import { lateCommandExperiment } from './_write-landing-experiment.mjs';
import { partOf } from './_landing-parts.mjs';

const PART = 1;
// Declared HERE, not in the helper: node records a test against the file that calls `it`.
const x = lateCommandExperiment({
  title: `a write the bound ended never lands afterwards, when its command reaches the server later than the backstop can wait (part ${PART + 1})`,
  suite: 'boundlandslate2',
  part: partOf('a-write-the-bound-ended-never-lands-when-the-command-is-late', PART),
});
describe(x.title, { skip: x.skip }, () => {
  before(x.before, { timeout: x.timeout });
  after(x.after);
  for (const c of x.cases) it(c.name, c.fn);
});
