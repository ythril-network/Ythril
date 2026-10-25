/**
 * `npm run test:standalone` — the offline half in PARALLEL, the live-instance half one at a time.
 *
 * ## Why, measured
 *
 * The whole suite ran under `--test-concurrency=1`, which serialises every file. Measured on this
 * machine over the 591 offline files:
 *
 * | | |
 * |---|---|
 * | `--test-concurrency=1` | **191.0s** |
 * | default (one worker per core) | **46.6s** |
 *
 * Both green. That is four minutes a cycle spent waiting for files that never touch each other.
 *
 * ## Why the serialisation existed, and why it does not apply here
 *
 * It is right for the suites that share ONE live instance: `testing/integration` run concurrently
 * latches maintenance mode and reports 314 false failures. The standalone offline files have no
 * instance to share — that is what `@needs-instance` declares — so the reason does not reach them.
 *
 * **The 16 files that DO declare it still run one at a time**, against the same stack, exactly as
 * before. The split is `standalone-split.mjs`, shared with preflight so the two cannot disagree about
 * which file is which.
 *
 * ## What makes parallel safe for the DB-backed half
 *
 * A `-db` file opens `ythril_harness_<suite>` and DROPS it on entry and exit. Two files sharing a suite
 * name would therefore wipe each other's data — invisibly, and only sometimes, because it depends which
 * worker got there first. Every name is unique and
 * `a-db-harness-name-is-unique.test.js` is what keeps them so; it exists because parallelism is what
 * turns a duplicate from harmless into a race.
 *
 * ## Why the DB-backed half runs NARROWER
 *
 * Every `-db` file shares one MongoDB, and at full width they ran it out of memory: the offline run is one
 * plan, `offlineRuns` in `standalone-split.mjs`, which runs the pure files at node's default width and the
 * database-backed ones at `DB_TEST_CONCURRENCY`. The measurement is beside the constant.
 *
 * ## And over several Mongos when the machine has room (Q-623)
 *
 * The one Mongo was the limit: the third took 1 179 s on it. `runDbSharded` below spreads the same files over up to four
 * fresh Mongos (`_shared/db-shard-plan.mjs` for which file goes where and why, `db-shard-stack.mjs` for starting and removing
 * them) and the third takes 340 s, 5 426 tests, the same verdicts. A host the size of CI's runner has room for one Mongo, so CI
 * runs the shards as separate jobs instead: `YTHRIL_TEST_DB_SHARDS=N` with `YTHRIL_TEST_DB_SHARD_INDEX=i` runs exactly one shard
 * against the Mongo the job started (`dbFilesThisProcessRuns`), and starts no container.
 *
 * Run: node testing/_init/run-standalone.mjs
 */
import { spawn, spawnSync } from 'node:child_process';
import { statSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { splitStandalone, batched, offlineRuns, DB_TEST_CONCURRENCY } from '../_shared/standalone-split.mjs';
import { timingReporterFlags, clearTimingResults } from '../_shared/timing-reporter-flags.mjs';
import { testChildEnv } from '../_shared/test-child-env.mjs';
import { planDbShards, unitsOf, dbShardPort, dbFilesThisProcessRuns, dbBatchLabel } from '../_shared/db-shard-plan.mjs';
import { resolveDbShardConfig, startDbShards, stopDbShards } from './db-shard-stack.mjs';

/**
 * REFUSE a stale `server/dist`, rather than testing the wrong build and reporting either answer.
 *
 * These files import from `server/dist`. `npm run preflight` builds it first; `test:all:core` never has,
 * so running the suite straight after a branch switch tests whatever was compiled last. It cost two
 * confused diagnoses in one evening: a fix that was already merged looked broken, and a build from two
 * branches ago looked like a regression in the change under test.
 *
 * A check rather than a build, deliberately. Building here would hide the mistake and add a minute to
 * every run; refusing costs milliseconds and says exactly what to do. `--allow-stale` is for the case
 * where you know the dist is what you meant.
 */
function refuseStaleDist() {
  if (process.argv.includes('--allow-stale')) return;
  const newest = (dir) => {
    let t = 0;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) t = Math.max(t, newest(p));
      else if (e.name.endsWith('.ts')) t = Math.max(t, statSync(p).mtimeMs);
    }
    return t;
  };
  let built;
  try { built = statSync('server/dist/index.js').mtimeMs; } catch {
    console.error('server/dist is missing — run `npm run build --workspace=server` first.');
    process.exit(1);
  }
  const src = newest('server/src');
  if (src > built) {
    console.error(`server/dist is OLDER than server/src (${new Date(built).toISOString()} < `
      + `${new Date(src).toISOString()}). These tests import from dist, so this run would test a build `
      + 'you did not make. Run `npm run build --workspace=server`, or pass --allow-stale if that is '
      + 'really what you meant.');
    process.exit(1);
  }
}

refuseStaleDist();

/**
 * `--only=pure|db|instance` runs one third of the plan: the pure offline files, the database-backed ones, or the
 * `@needs-instance` ones. CI runs the three as separate jobs because they need different things (nothing, one
 * MongoDB, two instances); no argument runs all three, in the order they always ran. The thirds are the plan's own
 * (`offlineRuns` kinds, and the instance batches below), never a second list of files. An unknown value, or a
 * selection that matches nothing, is an error: an empty run reports success about nothing.
 */
const THIRDS = ['pure', 'db', 'instance'];
const onlyArg = process.argv.find(a => a.startsWith('--only='));
const only = onlyArg ? onlyArg.slice('--only='.length) : null;
if (only !== null && !THIRDS.includes(only)) {
  console.error(`standalone: --only=${only} is not one of ${THIRDS.join(', ')}`);
  process.exit(1);
}
const wants = (third) => only === null || only === third;

const split = splitStandalone();
const { all, offline, offlineDb, needsInstance } = split;

/**
 * ONE shard of the `-db` third (Q-623): `YTHRIL_TEST_DB_SHARDS=N` with `YTHRIL_TEST_DB_SHARD_INDEX=i`. CI runs the third as N
 * jobs, each with its own Mongo already up at `YTHRIL_TEST_MONGO_PORT`; this process runs exactly `planDbShards(files, N)[i]`
 * against it and starts no shard container. `dbFilesThisProcessRuns` REFUSES an index with no count or outside 0..N-1 and the
 * refusal is not caught here, so the process ends non-zero: a silent full run is N times the work, a silent empty one is a green
 * job about nothing. It is asked before any file runs, and only for `--only=db`: a run of every third has no one shard.
 */
const oneShardFiles = dbFilesThisProcessRuns(offlineDb, {
  count: process.env['YTHRIL_TEST_DB_SHARDS'], index: process.env['YTHRIL_TEST_DB_SHARD_INDEX'],
});
if (oneShardFiles !== null && only !== 'db') {
  console.error('standalone: YTHRIL_TEST_DB_SHARD_INDEX selects one shard of the -db third, which only --only=db runs');
  process.exit(1);
}

const path = (f) => `testing/standalone/${f}`;

console.log(`standalone: ${all.length} files — ${offline.length} offline (parallel; the ${offlineDb.length} `
  + `database-backed ones ${DB_TEST_CONCURRENCY} at a time), ${needsInstance.length} need a running instance (serial)`);

let failed = 0;
let ran = 0;
const t0 = Date.now();

/**
 * One `node --test` batch, with the timing reporter attached by the shared helper: one destination per batch
 * (`test-results/standalone-<kind>-<n>.jsonl`), the flags AFTER the plan's own args so the plan stays about the
 * files, and the child's environment without the recorder's credentials. A batch that did not exit 0 counts as
 * failed, a signal-killed one (no status) included.
 */
const nextBatch = {};
function runBatch(kind, args, files) {
  ran++;
  nextBatch[kind] = (nextBatch[kind] ?? 0) + 1;
  // Every batch of the selected third is part of a whole run of it: this runner takes no file or pattern arguments.
  const flags = timingReporterFlags({ suite: 'standalone', batch: `${kind}-${nextBatch[kind]}`, scope: 'full' });
  const r = spawnSync('node', ['--test', ...args, ...flags.args, ...files], { stdio: 'inherit', env: testChildEnv(flags.env) });
  if (r.status !== 0) failed++;
}

// Results of an earlier run are not this run's: a plan that shrank would leave its higher-numbered batches behind.
// Only the thirds this run selects are cleared, so running one third leaves another's results alone.
for (const third of THIRDS) if (wants(third)) clearTimingResults(`standalone-${third}`);

/**
 * One shard's files, run by `width` workers that each pull the shard's next unit when they finish one (`unitsOf`: slow files
 * alone and first, then chunks of the rest). One `node --test` per unit, at width 1 inside it: the workers ARE the width. A
 * unit's output is held and written whole under a header naming the shard. `port` pins the children to that shard's Mongo
 * (`YTHRIL_TEST_MONGO_PORT`); undefined leaves the Mongo the environment already names, which is what a CI shard job wants.
 * Batches are named by `dbBatchLabel`, shard and unit, so shards never write the same results file.
 */
async function runShardUnits(files, shardIndex, width, port, onUnitDone = () => {}) {
  const units = unitsOf(files);
  let next = 0;
  await Promise.all(Array.from({ length: width }, async () => {
    while (next < units.length) {
      const n = ++next;
      const batch = units[n - 1].map(path);
      ran++;
      const startedAt = ((Date.now() - t0) / 1000).toFixed(0);
      const flags = timingReporterFlags({ suite: 'standalone', batch: dbBatchLabel(shardIndex, n), scope: 'full' });
      const out = [];
      const code = await new Promise((resolve) => {
        const child = spawn('node', ['--test', '--test-concurrency=1', ...flags.args, ...batch],
          { env: testChildEnv({ ...flags.env, ...(port === undefined ? {} : { YTHRIL_TEST_MONGO_PORT: String(port) }) }), stdio: ['ignore', 'pipe', 'pipe'] });
        child.stdout.on('data', d => out.push(d));
        child.stderr.on('data', d => out.push(d));
        child.on('error', () => resolve(1));
        child.on('close', (c) => resolve(c));
      });
      const where = port === undefined ? '' : ` (127.0.0.1:${port})`;
      process.stdout.write(`# -db shard ${shardIndex}${where} unit ${n} of ${units.length}: ${batch.length} file(s), ${startedAt}s to ${((Date.now() - t0) / 1000).toFixed(0)}s, exit ${code}
`);
      process.stdout.write(Buffer.concat(out));
      onUnitDone();
      if (code !== 0) failed++;
    }
  }));
}

/**
 * The `-db` third over several fresh Mongos (Q-623, `_shared/db-shard-plan.mjs` for the why): every shard runs its own
 * files at its own width at the same time, each `node --test` pinned to its shard's Mongo by `YTHRIL_TEST_MONGO_PORT`
 * (the address every harness file and relay reads, `_shared/test-mongo-address.mjs`). A shard's output is held and
 * written whole when its batch ends, under a header naming the shard: interleaved TAP from concurrent children is a log
 * nobody can read, and the `# fail` / `not ok` lines every reader greps stay at the start of their lines. A heartbeat
 * says the run is alive in between.
 */
async function runDbSharded(shardCount, width) {
  const plan = planDbShards(offlineDb, shardCount);
  console.log(`standalone: -db third on ${shardCount} Mongo shards, ${width} files at a time each: ${plan.map(f => f.length).join(', ')} files`);
  const shards = await startDbShards(shardCount);
  const stop = () => stopDbShards(shards);
  const onSignal = (sig) => { stop().finally(() => process.exit(sig === 'SIGINT' ? 130 : 143)); };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  let doneBatches = 0;
  const heartbeat = setInterval(() => console.log(`standalone: -db shards still running (${doneBatches} batch(es) done, ${((Date.now() - t0) / 1000).toFixed(0)}s)`), 60_000);
  try {
    console.log(`standalone: -db shards up after ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    await Promise.all(plan.map((files, i) => runShardUnits(files, i, width, dbShardPort(i), () => { doneBatches++; })));
  } finally {
    clearInterval(heartbeat);
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    await stop();
  }
}

/** The pure files at node's default width (one worker per core); the database-backed ones capped. */
const dbShards = wants('db') ? await resolveDbShardConfig({ defaultWidth: DB_TEST_CONCURRENCY }) : { count: 1, width: DB_TEST_CONCURRENCY };
for (const run of offlineRuns(split)) {
  if (!wants(run.kind)) continue;
  if (run.kind === 'db' && (oneShardFiles !== null || dbShards.count > 1)) continue; // the paths below run the database-backed files
  runBatch(run.kind, run.args, run.files);
}
if (oneShardFiles !== null) {
  const index = Number(process.env['YTHRIL_TEST_DB_SHARD_INDEX']);
  console.log(`standalone: -db shard ${index} of ${dbShards.count}: ${oneShardFiles.length} files, ${dbShards.width} at a time, on the Mongo at YTHRIL_TEST_MONGO_PORT`);
  await runShardUnits(oneShardFiles, index, dbShards.width, undefined);
} else if (wants('db') && dbShards.count > 1) await runDbSharded(dbShards.count, dbShards.width);

/*
 * ONE AT A TIME, and against the live stack. These drive :3200, so two of them at once would interleave
 * writes to one instance — the failure the concurrency flag was added for in the first place.
 */
if (wants('instance')) for (const batch of batched(needsInstance.map(path))) runBatch('instance', ['--test-concurrency=1'], batch);

if (ran === 0) {
  console.error(`standalone: --only=${only} selected no files — the split found none of that kind`);
  process.exit(1);
}

console.log(`standalone finished in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
if (failed > 0) {
  console.error(`standalone: ${failed} batch(es) failed`);
  process.exit(1);
}
