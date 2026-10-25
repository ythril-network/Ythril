/**
 * The standalone runner can run exactly ONE shard of the `-db` plan against the Mongo that is already up (Q-623).
 *
 * ## What it prevents
 *
 * CI's database job becomes four jobs, each with its own Mongo and its own `YTHRIL_TEST_DB_SHARDS=N` plus
 * `YTHRIL_TEST_DB_SHARD_INDEX=i`. The runner's other modes start shard Mongos of its own (N > 1) or run every file (N = 1),
 * so without this mode a job would start four containers on a runner with room for one, or run all the files four times.
 * Three ways it goes wrong quietly, each held here:
 *
 *  - **Index i selects some other set than `planDbShards(files, N)[i]`**: a second partition rule beside the plan's, so the
 *    four jobs' files are not the plan's and `ci-runs-every-db-shard-exactly-once` proves coverage of a plan nobody runs.
 *  - **An index out of range, or an index with no count, runs everything or nothing**: a silent full run is four times the
 *    work and a silent empty run is a green job about nothing. Both are refused (the function throws; the runner does not
 *    catch it, so the exit is non-zero). Garbage in an env value (`abc`, `1.5`, `-1`) is refused the same way.
 *  - **The runner does not use it**: the function exists and the runner never reads the index.
 *
 * The selection is `dbFilesThisProcessRuns(files, { count, index })` in `_shared/db-shard-plan.mjs`: `null` when there is no
 * index (not a one-shard run: the runner's own sharded or single-Mongo mode), the shard's files when both are valid, a throw
 * otherwise. `count` and `index` are numbers or the raw env strings; an empty string is unset, as `resolveDbShardConfig`
 * reads it. The runner is not spawned here: on a machine with Docker, a run that is not refused starts shard Mongos and
 * runs every file.
 *
 * Run: node --test testing/standalone/a-db-runner-runs-one-shard-of-n.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as shardPlan from '../_shared/db-shard-plan.mjs';
import { splitStandalone } from '../_shared/standalone-split.mjs';
import { REPO_ROOT } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';

const { planDbShards, DB_SHARDS_MAX } = shardPlan;
const { offlineDb } = splitStandalone({ root: REPO_ROOT });
/** The export, or the failure that it is missing — asserted OUTSIDE any `assert.throws`, so a missing export can never read as a refusal. */
function selection() {
  assert.equal(typeof shardPlan.dbFilesThisProcessRuns, 'function', 'db-shard-plan.mjs must export dbFilesThisProcessRuns(files, { count, index })');
  return shardPlan.dbFilesThisProcessRuns;
}
const select = (...args) => selection()(...args);
/** Asserts the selection REFUSES `{ count, index }`, with a message matching `why`; a missing export fails before it. */
const refuses = (given, why, message) => { const fn = selection(); assert.throws(() => fn(offlineDb, given), why, message); };

describe('which files this process runs', () => {
  it('has -db files to select from, so an empty list cannot pass', () => {
    assert.ok(offlineDb.length >= 30, `only ${offlineDb.length} -db file(s) found`);
  });

  it('index i of N selects exactly planDbShards(files, N)[i], for every N the plan allows and every i', () => {
    for (let count = 1; count <= DB_SHARDS_MAX; count++) {
      const plan = planDbShards(offlineDb, count);
      for (let index = 0; index < count; index++) {
        assert.deepEqual(select(offlineDb, { count, index }), plan[index], `index ${index} of ${count}`);
        // The env spells both as strings.
        assert.deepEqual(select(offlineDb, { count: String(count), index: String(index) }), plan[index], `index "${index}" of "${count}"`);
      }
    }
  });

  it('the shards it selects over one count are the database-backed files, each once', () => {
    for (let count = 2; count <= DB_SHARDS_MAX; count++) {
      const ran = Array.from({ length: count }, (_, index) => select(offlineDb, { count, index })).flat();
      assert.deepEqual([...ran].sort(), [...offlineDb].sort(), `${count} one-shard processes do not run every file exactly once`);
    }
  });

  it('is not a one-shard run when no index is set', () => {
    assert.equal(select(offlineDb, {}), null);
    assert.equal(select(offlineDb, { count: undefined, index: undefined }), null);
    assert.equal(select(offlineDb, { count: '', index: '' }), null);
    assert.equal(select(offlineDb, { count: 4 }), null);
    assert.equal(select(offlineDb, { count: '4', index: '' }), null);
  });

  it('refuses an index with no count', () => {
    refuses({ index: 2 }, /count/i);
    refuses({ index: '0', count: '' }, /count/i);
  });

  it('refuses an index outside 0..N-1, for every N', () => {
    for (let count = 1; count <= DB_SHARDS_MAX; count++) {
      for (const index of [-1, count, count + 1, 99]) {
        refuses({ count, index }, /index/i, `index ${index} of ${count} was not refused`);
      }
    }
  });

  it('refuses an index or a count that is not a whole number in range', () => {
    for (const index of ['abc', '1.5', '-1', ' ', 'NaN', 1.5, NaN]) {
      refuses({ count: 4, index }, /index/i, `index ${JSON.stringify(index)} was not refused`);
    }
    for (const count of ['abc', '2.5', '0', '-4', String(DB_SHARDS_MAX + 1), 0, DB_SHARDS_MAX + 1]) {
      refuses({ count, index: 0 }, /count|shards/i, `count ${JSON.stringify(count)} was not refused`);
    }
  });
});

describe('the runner uses it', () => {
  const read = (rel) => stripComments(readFileSync(join(REPO_ROOT, rel), 'utf8'));
  const runner = read('testing/_init/run-standalone.mjs');
  const modes = `${runner}\n${read('testing/_init/db-shard-stack.mjs')}`;

  it('reads YTHRIL_TEST_DB_SHARD_INDEX (in code, not in a comment)', () => {
    assert.ok(modes.includes('YTHRIL_TEST_DB_SHARD_INDEX'), 'neither run-standalone.mjs nor db-shard-stack.mjs reads YTHRIL_TEST_DB_SHARD_INDEX');
  });

  it('asks dbFilesThisProcessRuns which files it runs, rather than choosing a shard itself', () => {
    assert.ok(runner.includes('dbFilesThisProcessRuns'), 'run-standalone.mjs never calls dbFilesThisProcessRuns');
  });

  it('names its results batches through dbBatchLabel, so shards\' result files differ', () => {
    assert.ok(runner.includes('dbBatchLabel'), 'run-standalone.mjs never calls dbBatchLabel');
  });
});
