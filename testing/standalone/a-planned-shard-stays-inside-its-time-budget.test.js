/**
 * Every shard CI runs the standalone files in is planned inside a time budget of recorded seconds (bundle-373, Q-977).
 *
 * ## Why
 *
 * A CI run ends with its slowest job, and the slowest was always a database shard: a file's shard there is a function of its NAME, so no
 * plan follows what a file costs. From the newest runs of main the critical path was 2 010 s at its median (1 876 s before bundle 270, 2 630 s on
 * the newest run) and the first pure shard 990 s against 725 s: new RDF, SPARQL and SPARQL Update files added about 1 200 s of file time, and the
 * pure table that packs the shards (`pure-file-seconds.json`) still carried the times of an older run, so those files were packed at a fifth
 * of a second each. Nothing said so: each file was added by a bundle that ran in its own time, and every bundle waits on the sum.
 *
 * ## The rule
 *
 * Plan each kind the way CI runs it (the database plan at the workflow's shard count, the pure plan at `PURE_SHARDS`), add up each shard's files
 * by the committed tables of recorded seconds (`db-file-seconds.json`, `pure-file-seconds.json`), and refuse a shard over its budget
 * (`DB_SHARD_BUDGET_S`, `PURE_SHARD_BUDGET_S`, `shard-budget.mjs`). The first pure shard also carries the text-only files, which run there only.
 * The answer to a red case is a shard more, or a cut that spreads the files better, and the tables regenerated from a recorded run
 * (`testing/_init/record-shard-seconds.mjs`), never a budget raised to pass.
 *
 * ## Seen red
 *
 * On c6efec2a7 with the tables regenerated from the newest recorded runs: the four database shards were planned at 2 067, 2 078, 2 189 and
 * 2 401 s against 1 876, and the two pure shards at 998 s (the text-only files included) and 942 s against 725.
 *
 * Run: node --test testing/standalone/a-planned-shard-stays-inside-its-time-budget.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { splitStandalone, pureShardFiles, PURE_SHARDS, loadPureFileSeconds } from '../_shared/standalone-split.mjs';
import { planDbShards, loadDbFileSeconds, DB_SHARDS_MAX } from '../_shared/db-shard-plan.mjs';
import { shardsOverBudget, plannedShardSeconds, DB_SHARD_BUDGET_S, PURE_SHARD_BUDGET_S } from '../_shared/shard-budget.mjs';
import { textOnlyFiles } from '../_shared/text-only-test.mjs';
import { loadCi, jobRunning, stepsOf, shellOf, stepEnv, DB_SHARD_SCRIPT } from '../_shared/ci-workflow.mjs';
import { REPO_ROOT } from './_sources.mjs';

const split = splitStandalone({ root: REPO_ROOT });
const path = (f) => `testing/standalone/${f}`;

/** The shard count CI's database job sets for the runner, read from the workflow and never written here. */
function ciDbShardCount() {
  const ci = loadCi();
  const { job } = jobRunning(ci, DB_SHARD_SCRIPT);
  const count = Number(stepEnv(job, stepsOf(job).find((s) => shellOf(s).includes(DB_SHARD_SCRIPT)), 'YTHRIL_TEST_DB_SHARDS'));
  assert.ok(Number.isInteger(count) && count > 1 && count <= DB_SHARDS_MAX, `CI's database job sets ${count} shards`);
  return count;
}

/** The text-only files run in the first pure shard only; their recorded total stands in as one entry of the table. */
const TEXT_STEP = 'the text-only step';

describe('shardsOverBudget names every shard planned over its budget', () => {
  const seconds = { 'a.js': 100, 'b.js': 60, 'c.js': 30 };
  it('names the shard over, with its planned seconds, and none that is under', () => {
    assert.deepEqual(shardsOverBudget([['a.js'], ['b.js', 'c.js']], seconds, { budget: 95, who: 'demo' }), ['demo shard 1 of 2 is planned at 100 s, over its budget of 95 s']);
  });
  it('holds a plan exactly at its budget', () => assert.deepEqual(shardsOverBudget([['b.js', 'c.js']], seconds, { budget: 90, who: 'demo' }), []));
  it('plans a file the table does not name at the table\'s median, never at zero', () => {
    assert.deepEqual(plannedShardSeconds([['a.js', 'new.js']], seconds, { unnamed: 7 }), [107]);
    assert.match(shardsOverBudget([['new.js', 'x.js', 'y.js']], seconds, { budget: 20, who: 'demo', unnamed: 7 })[0], /planned at 21 s/);
  });
  it('adds the files that run in a shard besides its plan', () => {
    assert.match(shardsOverBudget([['b.js'], ['c.js']], seconds, { budget: 80, who: 'demo', extra: [['a.js']] })[0], /shard 1 of 2 is planned at 160 s/);
  });
  it('refuses to answer with no budget or no shard', () => {
    assert.throws(() => shardsOverBudget([['a.js']], seconds, { who: 'demo' }), /no budget/);
    assert.throws(() => shardsOverBudget([], seconds, { budget: 5, who: 'demo' }), /no shard/);
  });
});

describe('the committed tables of recorded seconds', () => {
  it('the database table names only database files that exist, at least half of them, and carries a median for a file it does not name', () => {
    const table = JSON.parse(readFileSync(join(REPO_ROOT, 'testing/_shared/db-file-seconds.json'), 'utf8'));
    const names = new Set(split.offlineDb);
    assert.deepEqual(Object.keys(table.seconds).filter((f) => !names.has(f)), [], 'db-file-seconds.json names files that are not database-backed standalone files: regenerate it with testing/_init/record-shard-seconds.mjs');
    assert.ok(Object.keys(table.seconds).length >= names.size / 2, `only ${Object.keys(table.seconds).length} of ${names.size} database files have a recorded time`);
    assert.ok(table.median > 0, 'the database table has no median for a file it does not name');
  });
  it('the pure table carries what the text-only files add to the first shard', () => {
    assert.ok(loadPureFileSeconds().median > 0);
    assert.ok(JSON.parse(readFileSync(join(REPO_ROOT, 'testing/_shared/pure-file-seconds.json'), 'utf8')).textSeconds > 0, 'pure-file-seconds.json has no textSeconds');
  });
});

describe('the plans CI runs stay inside their budgets of recorded seconds', () => {
  it(`every database shard at the workflow's count is planned at ${DB_SHARD_BUDGET_S} s or less`, () => {
    const count = ciDbShardCount();
    const { seconds, median } = loadDbFileSeconds();
    const shards = planDbShards(split.offlineDb, count);
    assert.deepEqual(shardsOverBudget(shards, seconds, { budget: DB_SHARD_BUDGET_S, who: `the database plan (${count} shards)`, unnamed: median }), []);
  });

  it(`every pure shard is planned at ${PURE_SHARD_BUDGET_S} s or less, the first with the text-only files that run there`, () => {
    const table = loadPureFileSeconds();
    const text = new Set(textOnlyFiles(split, { root: REPO_ROOT }));
    const pure = split.offlinePure.map(path).filter((f) => !text.has(f));
    const shards = Array.from({ length: PURE_SHARDS }, (_, i) => pureShardFiles(pure, { index: i + 1, count: PURE_SHARDS }));
    const textSeconds = JSON.parse(readFileSync(join(REPO_ROOT, 'testing/_shared/pure-file-seconds.json'), 'utf8')).textSeconds;
    assert.deepEqual(shardsOverBudget(shards, { ...table.seconds, [TEXT_STEP]: textSeconds }, {
      budget: PURE_SHARD_BUDGET_S, who: `the pure plan (${PURE_SHARDS} shards)`, unnamed: table.median, extra: [[TEXT_STEP]],
    }), []);
  });
});
