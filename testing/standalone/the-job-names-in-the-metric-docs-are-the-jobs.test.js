/**
 * The `job` label values the docs name for `ythril_interval_tick_skipped_total` are the repeating jobs the server runs
 * (bundle-53 G27, Q-317).
 *
 * ## The defect it prevents
 *
 * An operator alerting on a job that skips ticks writes `job="Seq hold watchdog"` from the metrics table. The label is the
 * job's own name, and a job added without a docs row is a series nobody was told about; a job renamed leaves an alert that
 * matches nothing and never fires. `metric-docs-coverage` holds that the METRIC is documented, not its label values.
 *
 * ## What it holds, and where the set comes from
 *
 * Every `intervalJob(<label>, …)` call in `server/src` — the label is a string literal or a module constant holding one — is
 * read out of the source, and the metric's row in `11-setup-api.md` must name each in backticks. The set is DERIVED and has a
 * floor, because an empty set passes every loop written over it; a call whose label this reader cannot resolve THROWS, so a
 * job spelled in a way the reader does not know is never silently left out. A name documented that no job carries is refused
 * too, so a rename cannot leave the old name in the table.
 *
 * Run: node --test testing/standalone/the-job-names-in-the-metric-docs-are-the-jobs.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { trackedSources } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';

const METRIC = 'ythril_interval_tick_skipped_total';
const FLOOR = 10;

/** Every job label the server declares: `intervalJob(` first arguments, resolved to their strings. */
function declaredJobLabels() {
  const labels = new Map();
  for (const file of trackedSources('server/src', { exclude: ['server/src/util/interval-job.ts'] })) {
    const text = stripComments(readFileSync(file, 'utf8'));
    for (const m of text.matchAll(/\bintervalJob\(\s*([^,]+?)\s*,/g)) {
      const arg = m[1];
      let label = arg.match(/^'([^']+)'$/)?.[1];
      if (label === undefined && /^[A-Za-z_][A-Za-z0-9_]*$/.test(arg)) {
        label = text.match(new RegExp(`\\bconst ${arg}\\s*=\\s*'([^']+)'`))?.[1];
      }
      assert.ok(label, `${file}: cannot read the label of \`intervalJob(${arg}, …)\` — spell it as a string literal or a module constant holding one, or teach this gate the new spelling`);
      labels.set(label, file);
    }
  }
  return labels;
}

const row = readFileSync('docs/integration-guide/11-setup-api.md', 'utf8').split(/\r?\n/).find(l => l.startsWith(`| \`${METRIC}\``));
const documented = new Set([...(row ?? '').matchAll(/`([^`]+)`/g)].map(m => m[1]));
const jobs = declaredJobLabels();

describe(`the jobs named under ${METRIC} are the jobs the server runs`, () => {
  it('finds the metric row and a set of jobs worth checking (a floor)', () => {
    assert.ok(row, `no row for ${METRIC} in docs/integration-guide/11-setup-api.md`);
    assert.ok(jobs.size >= FLOOR, `only ${jobs.size} job label(s) read from server/src`);
  });

  for (const [label, file] of jobs) {
    it(`names '${label}' (${file})`, () => {
      assert.ok(documented.has(label), `the ${METRIC} row does not name the job '${label}' (declared in ${file}). An alert on job="${label}" would be written from guesswork.`);
    });
  }

  it('names no job the server does not run', () => {
    // The row's backticked words are the metric name, the `job` label and the job names; the rest are not jobs.
    const notJobs = new Set([METRIC, 'job', 'YTHRIL_HOUSEKEEPING_OP_TIMEOUT_MS']);
    const stale = [...documented].filter(w => !notJobs.has(w) && !/^\d+$/.test(w) && !jobs.has(w));
    assert.deepEqual(stale, [], `the ${METRIC} row names ${stale.join(', ')}, which no job carries: renamed or removed`);
  });
});
