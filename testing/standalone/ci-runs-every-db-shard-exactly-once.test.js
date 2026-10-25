/**
 * CI's database job runs every shard of the `-db` plan, each once, and the evidence of one shard does not overwrite another's (Q-623).
 *
 * ## What it prevents
 *
 * `Standalone (database)` ran the whole `-db` third in one job (about 23 minutes on CI's runner, which has room for one
 * shard). It becomes a matrix of jobs, one per shard of `planDbShards`, each against its own Mongo. Splitting a run
 * is exactly where a test stops running without anything going red:
 *
 *  - **A matrix shorter than the count** (indices 0..2 of 4): a quarter of the `-db` files run nowhere, and every job is green.
 *  - **A matrix longer or repeated** (an index twice, or one past the count): a file runs twice, or a job's runner refuses.
 *  - **A count the plan does not accept** (`planDbShards` throws, or leaves a shard with no file).
 *  - **`fail-fast` left on**: the first red shard cancels the other three, and the failure that is read is one of four.
 *  - **Four uploads under one name**: `upload-artifact` refuses the second, or the shards' evidence overwrite one another, and
 *    the gate's `executed-tests` reads a quarter of the run as the whole of it.
 *  - **Result files that collide when merged**: the gate downloads `test-results-*-<attempt>` with `merge-multiple`, so two
 *    shards writing `standalone-db-1.jsonl` leave one file of the two, with nothing said.
 *  - **A gate that stops waiting for the job**: `Build & Test` must still need the matrix job and check its result (a
 *    matrix's result is `failure` when any one of its jobs failed).
 *
 * ## How it is written
 *
 * The rules are `shardProblems(doc)` over the PARSED workflow: the job is the one whose steps run `test:standalone:db`, its
 * count and index are what its env says, never a literal here, and the files are the runner's own list
 * (`splitStandalone().offlineDb`). The same function is run against a conforming miniature and single deliberate breakages
 * of it first, so each rule is seen to fire where the real file is already right.
 *
 * Run: node --test testing/standalone/ci-runs-every-db-shard-exactly-once.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { splitStandalone } from '../_shared/standalone-split.mjs';
import * as shardPlan from '../_shared/db-shard-plan.mjs';
import {
  loadCi, parseWorkflow, jobEntries, stepsOf, shellOf, usesOf, expressionOf, mergeGateEntries, isTrue,
} from '../_shared/ci-workflow.mjs';
import { REPO_ROOT } from './_sources.mjs';

const { planDbShards, DB_SHARDS_MAX } = shardPlan;
const COUNT_ENV = 'YTHRIL_TEST_DB_SHARDS';
const INDEX_ENV = 'YTHRIL_TEST_DB_SHARD_INDEX';
const DB_SCRIPT = 'test:standalone:db';

const { offlineDb } = splitStandalone({ root: REPO_ROOT });

/** The job that runs the `-db` third: the one whose steps run `npm run test:standalone:db`. Exactly one, or the rule has no subject. */
function dbJobOf(doc) {
  const found = jobEntries(doc).filter(({ job }) => stepsOf(job).some(s => shellOf(s).includes(DB_SCRIPT)));
  if (found.length !== 1) throw new Error(`${found.length} job(s) run ${DB_SCRIPT} (${found.map(j => j.id).join(', ')}) — exactly one is the subject of this rule`);
  return found[0];
}

/** The value an env var has where the test step runs: the step's own, else the job's. */
function envOf(job, name) {
  const step = stepsOf(job).find(s => shellOf(s).includes(DB_SCRIPT));
  return step?.env?.[name] ?? job.env?.[name];
}

/** What a job's matrix says: the axis the index env reads, and that axis's values. `null` when there is no matrix. */
function matrixAxisOf(job, indexExpr) {
  const matrix = job.strategy?.matrix;
  const m = /^matrix\.([\w-]+)$/.exec(indexExpr ?? '');
  if (!matrix || !m || !Array.isArray(matrix[m[1]])) return null;
  return { axis: m[1], values: matrix[m[1]] };
}

/** `test-results-*-${{ github.run_attempt }}`-style artifact patterns as a RegExp, the attempt taken as the literal 1. */
function artifactPatternOf(pattern) {
  const literal = String(pattern).replace(/\$\{\{\s*github\.run_attempt\s*\}\}/g, '1');
  return new RegExp(`^${literal.split('*').map(p => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
}

/** Every way `doc` fails the rule, as sentences; none means it holds. `files` is the `-db` file list the shards must cover. */
function shardProblems(doc, files) {
  const problems = [];
  const { id, job } = dbJobOf(doc);

  const axis = matrixAxisOf(job, expressionOf(envOf(job, INDEX_ENV)));
  if (!axis) {
    return [`${id} has no matrix over the shard index: its ${INDEX_ENV} is ${JSON.stringify(envOf(job, INDEX_ENV))} and strategy.matrix is ${JSON.stringify(job.strategy?.matrix)}`];
  }

  // `fail-fast` defaults to true, so an absent key is the failure too.
  if (isTrue(job.strategy['fail-fast']) || job.strategy['fail-fast'] === undefined) {
    problems.push(`${id}: fail-fast is not false, so the first red shard cancels the others`);
  }

  // The count, as a whole number the job sets (a literal, or the matrix's own length through strategy.job-total).
  const rawCount = expressionOf(envOf(job, COUNT_ENV));
  const count = rawCount === 'strategy.job-total' ? axis.values.length : Number(rawCount);
  if (!Number.isInteger(count)) {
    problems.push(`${id}: ${COUNT_ENV} is ${JSON.stringify(rawCount)}, not a whole number`);
    return problems;
  }
  if (!(count > 1 && count <= DB_SHARDS_MAX)) problems.push(`${id}: ${count} shards is not a count the plan accepts (more than 1, at most ${DB_SHARDS_MAX})`);

  const indices = axis.values.map(Number);
  const expected = Array.from({ length: count }, (_, i) => i);
  const missing = expected.filter(i => !indices.includes(i));
  const repeated = indices.filter((v, i) => indices.indexOf(v) !== i);
  const outside = indices.filter(v => !Number.isInteger(v) || v < 0 || v >= count);
  if (missing.length) problems.push(`${id}: no job runs shard(s) ${missing.join(', ')} of ${count}, so their files run nowhere`);
  if (repeated.length) problems.push(`${id}: shard(s) ${[...new Set(repeated)].join(', ')} appear twice in the matrix, so their files run twice`);
  if (outside.length) problems.push(`${id}: matrix value(s) ${outside.join(', ')} are not an index below ${count}`);

  // The files the jobs run are the plan's, by index: their union is every file, each once. Only for a count the plan takes.
  if (count >= 1 && count <= DB_SHARDS_MAX) {
    const plan = planDbShards(files, count);
    const ran = indices.filter(i => Number.isInteger(i) && i >= 0 && i < count).flatMap(i => plan[i]);
    const notRun = files.filter(f => !ran.includes(f));
    const twice = ran.filter((f, i) => ran.indexOf(f) !== i);
    if (notRun.length) problems.push(`${id}: ${notRun.length} of ${files.length} -db file(s) are in no job's shard, first ${notRun[0]}`);
    if (twice.length) problems.push(`${id}: ${new Set(twice).size} -db file(s) run in more than one job, first ${twice[0]}`);
  }

  // The uploads: every one under a name that carries the matrix axis, so the shards' names differ.
  const uploads = stepsOf(job).filter(s => usesOf(s)?.action === 'actions/upload-artifact');
  if (uploads.length === 0) problems.push(`${id}: uploads no artifact`);
  for (const u of uploads) {
    if (!String(u.with?.name ?? '').includes(`matrix.${axis.axis}`)) {
      problems.push(`${id}: upload "${u.name}" is named ${JSON.stringify(u.with?.name)}, which does not carry matrix.${axis.axis}, so the shards upload under one name`);
    }
  }
  return problems;
}

/** The artifact names the matrix job's uploads have, one per axis value, attempt 1. */
function artifactNames(doc) {
  const { job } = dbJobOf(doc);
  const axis = matrixAxisOf(job, expressionOf(envOf(job, INDEX_ENV)));
  if (!axis) throw new Error('the database job has no matrix over the shard index, so it has no per-shard artifact names');
  const uploads = stepsOf(job).filter(s => usesOf(s)?.action === 'actions/upload-artifact');
  return uploads.flatMap(u => axis.values.map(v => String(u.with.name)
    .replace(/\$\{\{\s*matrix\.[\w-]+\s*\}\}/g, String(v)).replace(/\$\{\{\s*github\.run_attempt\s*\}\}/g, '1')));
}

/** The conforming miniature: a four-way matrix, fail-fast off, an upload named by the index. Literal on purpose (a fixture). */
const MINI = (over = {}) => `
on: push
jobs:
  standalone-db:
    name: Standalone (database)
    runs-on: ubuntu-latest
    strategy:
      fail-fast: ${over.failFast ?? 'false'}
      matrix:
        shard: ${over.matrix ?? '[0, 1, 2, 3]'}
    steps:
      - name: Standalone tests that open the database
        run: npm run ${DB_SCRIPT}
        env:
          ${COUNT_ENV}: ${over.count ?? '4'}
          ${INDEX_ENV}: \${{ matrix.shard }}
      - name: Upload test results
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: ${over.artifact ?? 'test-results-standalone-db-${{ matrix.shard }}-${{ github.run_attempt }}'}
          path: test-results/
`;
const miniProblems = (over) => shardProblems(parseWorkflow(MINI(over)), offlineDb).join('\n');

describe('the rule, run against a miniature and single breakages of it', () => {
  it('the -db file list is big enough that an empty one cannot pass the rule', () => {
    assert.ok(offlineDb.length >= 30, `only ${offlineDb.length} -db file(s) found`);
  });
  it('holds for the conforming shape', () => assert.equal(miniProblems(), ''));
  it('fires on a matrix shorter than the count', () => assert.match(miniProblems({ matrix: '[0, 1, 2]' }), /no job runs shard\(s\) 3 of 4/));
  it('fires on a repeated index', () => assert.match(miniProblems({ matrix: '[0, 1, 1, 2, 3]' }), /appear twice/));
  it('fires on an index past the count', () => assert.match(miniProblems({ matrix: '[0, 1, 2, 4]' }), /not an index below 4/));
  it('fires on a count the plan does not accept', () => assert.match(miniProblems({ count: '9', matrix: '[0, 1, 2, 3, 4, 5, 6, 7, 8]' }), /not a count the plan accepts/));
  it('fires on a count of one (that is not a split)', () => assert.match(miniProblems({ count: '1', matrix: '[0]' }), /not a count the plan accepts/));
  it('fires on fail-fast left on', () => assert.match(miniProblems({ failFast: 'true' }), /fail-fast/));
  it('fires on an upload name without the index', () => assert.match(miniProblems({ artifact: 'test-results-standalone-db-${{ github.run_attempt }}' }), /does not carry matrix\.shard/));
  it('fires on a job with no matrix', () => {
    const doc = parseWorkflow(`on: push\njobs:\n  standalone-db:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm run ${DB_SCRIPT}\n`);
    assert.match(shardProblems(doc, offlineDb).join('\n'), /no matrix over the shard index/);
  });
});

describe('ci.yml runs every shard of the -db plan, once each', () => {
  const ci = loadCi();

  it('the database job is a matrix over the plan: every shard once, a count the plan accepts, fail-fast off, one upload name per shard', () => {
    assert.deepEqual(shardProblems(ci, offlineDb), []);
  });

  it('the shards\' artifact names differ from one another', () => {
    const names = artifactNames(ci);
    assert.ok(names.length >= 2, `${names.length} artifact name(s) derived`);
    assert.equal(new Set(names).size, names.length, `artifact names collide: ${names.join(', ')}`);
  });

  it('each name is one the gate\'s download pattern selects, or its evidence is never read', () => {
    const patterns = jobEntries(ci).flatMap(({ job }) => stepsOf(job))
      .filter(s => usesOf(s)?.action === 'actions/download-artifact' && s.with?.pattern)
      .map(s => s.with.pattern);
    assert.ok(patterns.length >= 1, 'no download-artifact step with a pattern found');
    const names = artifactNames(ci);
    assert.ok(names.length >= 2, `${names.length} artifact name(s) derived`);
    for (const name of names) {
      for (const p of patterns) assert.ok(artifactPatternOf(p).test(name), `${name} is not selected by ${p}`);
    }
  });

  it('the gate still waits for the matrix job and checks its result', () => {
    const gates = mergeGateEntries(ci);
    assert.equal(gates.length, 1);
    const { id } = dbJobOf(ci);
    assert.ok([].concat(gates[0].job.needs).includes(id), `Build & Test does not need ${id}`);
    const script = stepsOf(gates[0].job).map(s => shellOf(s)).join('\n');
    assert.ok(script.includes(`needs.${id}.result`), `Build & Test does not read needs.${id}.result`);
  });
});

describe('the results of one shard do not overwrite another\'s when merged', () => {
  it('names a unit\'s results batch by its shard AND its number, distinct across every shard and unit of every count', () => {
    assert.equal(typeof shardPlan.dbBatchLabel, 'function', 'db-shard-plan.mjs must export dbBatchLabel(shardIndex, unitNumber)');
    for (let count = 2; count <= DB_SHARDS_MAX; count++) {
      const seen = new Set();
      for (let shard = 0; shard < count; shard++) {
        for (let unit = 1; unit <= 5; unit++) seen.add(shardPlan.dbBatchLabel(shard, unit));
      }
      assert.equal(seen.size, count * 5, `${count} shards of 5 units made ${seen.size} distinct batch names`);
    }
  });
});
