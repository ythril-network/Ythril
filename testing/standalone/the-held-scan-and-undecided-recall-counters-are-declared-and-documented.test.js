/**
 * The two counters that make a quiet failure countable are declared at zero and documented with the alert they exist for (Q-696 and Q-697,
 * b235 design v3 items 3, 6 and 10; observability S1/S8, documentation).
 *
 *  - `ythril_scan_holds_total{scanner}`: a background scan held a type because its index was not ready (Q-697);
 *  - `ythril_recall_undecided_total`: a filtered recall that found nothing could not tell whether the index missed a match, and answered
 *    the empty answer (Q-696, the one named fail-open).
 *
 * ## Why the existing metric-docs gates are not enough
 *
 * `metric-docs-coverage` (every exposed metric is named somewhere in the docs) and `metric-docs-are-accurate` (a row carries the concepts
 * of its metric's help) will both go red when either metric is declared without a row, and neither can be red before: they enumerate the
 * registry. They do not ask where the row is or what it tells the operator. These two metrics are signals about what is NOT being done -
 * a scan that kept its place, a recall that answered empty on a doubt - and a row that only names them is a counter nobody alerts on. So:
 *
 *  - each is declared in `metrics/registry.ts` and reports from process start, so a scrape before the first event says `0`, not nothing
 *    (absent-versus-zero is the ambiguity every other counter of this kind refuses);
 *  - each has a row in the "Metrics exposed" table of `docs/integration-guide/11-setup-api.md` (the table the coverage gate's message
 *    names), and the row says what to alert on.
 *
 * "Seen red" on the base: neither metric is declared, and neither has a row.
 *
 * Run: node --test testing/standalone/the-held-scan-and-undecided-recall-counters-are-declared-and-documented.test.js
 * (requires a prior `npm run build:server`)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const METRICS = ['ythril_scan_holds_total', 'ythril_recall_undecided_total'];
const doc = readFileSync(join(ROOT, 'docs/integration-guide/11-setup-api.md'), 'utf8');
const registrySource = readFileSync(join(ROOT, 'server/src/metrics/registry.ts'), 'utf8');
const { register } = await import('../../server/dist/metrics/registry.js');
const scrape = await register.metrics();

describe('the held-scan and undecided-recall counters', () => {
  for (const name of METRICS) {
    describe(name, () => {
      it('is declared in the registry', () => {
        assert.match(registrySource, new RegExp(`name:\\s*'${name}'`), `${name} is not declared in metrics/registry.ts`);
      });

      it('reports 0 from process start, before anything has happened', () => {
        const lines = scrape.split('\n').filter(l => l.startsWith(`${name}`) && !l.startsWith('#'));
        assert.ok(lines.length > 0, `a scrape before the first event has no ${name} series: absent reads as "no such metric", not "none yet"`);
        for (const l of lines) assert.match(l, /\s0$/, `${l}: a series that is not 0 at process start`);
      });

      it('has a row in the Metrics exposed table of 11-setup-api.md, and the row says what to alert on', () => {
        const row = doc.split('\n').find(l => l.startsWith(`| \`${name}\` |`));
        assert.ok(row, `11-setup-api.md has no table row for ${name}: an operator cannot find the metric, and nothing says what to alert on`);
        assert.match(row, /\|\s*counter\s*\|/, `the ${name} row does not say it is a counter`);
        assert.match(row, /alert/i, `the ${name} row names no alert: a counter of a quiet failure is worth what the sentence beside it says to do with it`);
      });
    });
  }
});
