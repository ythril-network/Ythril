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
 * worker got there first. All 48 names are unique today and
 * `a-db-harness-name-is-unique.test.js` is what keeps them so; it exists because parallelism is what
 * turns a duplicate from harmless into a race.
 *
 * Run: node testing/_init/run-standalone.mjs
 */
import { spawnSync } from 'node:child_process';
import { statSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { splitStandalone, batched } from '../_shared/standalone-split.mjs';

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

const { all, offline, needsInstance } = splitStandalone();
const path = (f) => `testing/standalone/${f}`;

console.log(`standalone: ${all.length} files — ${offline.length} offline (parallel), `
  + `${needsInstance.length} need a running instance (serial)`);

let failed = 0;
const t0 = Date.now();

/** Default concurrency: node uses one worker per core, and these files share nothing. */
for (const batch of batched(offline.map(path))) {
  const r = spawnSync('node', ['--test', ...batch], { stdio: 'inherit' });
  if (r.status !== 0) failed++;
}

/*
 * ONE AT A TIME, and against the live stack. These drive :3200, so two of them at once would interleave
 * writes to one instance — the failure the concurrency flag was added for in the first place.
 */
for (const batch of batched(needsInstance.map(path))) {
  const r = spawnSync('node', ['--test', '--test-concurrency=1', ...batch], { stdio: 'inherit' });
  if (r.status !== 0) failed++;
}

console.log(`standalone finished in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
if (failed > 0) {
  console.error(`standalone: ${failed} batch(es) failed`);
  process.exit(1);
}
