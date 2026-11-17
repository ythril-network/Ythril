/**
 * Runs `node --test` units a bounded number at a time, each ended at its time bound, its output held and written whole (Q-863, Q-623).
 *
 * ## What it prevents
 *
 * This is the pool the standalone runner's `-db` shards had (`runShardUnits`), moved here so preflight's pure stage uses the same one instead of
 * a second copy. Every rule a caller could forget is inside:
 *
 * - at most `width` children alive at once (`poolEach`, which refuses a width that is not a positive integer, and then no child starts);
 * - every child is `node` with `boundedTestArgs(...)` and is SIGKILLed at `batchTimeoutMs(files.length)` with a line naming it, so a file that
 *   hangs after its tests cannot hold a run for ever; the timer is cleared when the child ends;
 * - every child gets `testChildEnv(...)`, so the recorder's credentials and the runner's context never reach a test;
 * - a unit never rejects: a non-zero exit, a kill, an 'error' event and a `spawn` that throws each become one failed unit, and the rest still run;
 * - a unit's stdout and stderr are held and written whole, in arrival order, under a header, so units that ran together never interleave and the
 *   `not ok` / `# fail` lines readers grep stay at the start of their lines. A start line is written when a unit launches, so a long run is not silent.
 *
 * ## The call
 *
 * `runTestUnits(units, { width, args, labelOf, envOf, header, onUnitDone, spawn, write })`: `units` is a list of lists of file paths. `args`, `labelOf`
 * and `envOf` are called as `(files, index)` when the unit launches, with the index its position in `units`, so a timing file or a label belongs to the
 * unit and not to the order the units ended in. `header({ label, code, index, total, files, startedAt, endedAt })` is the line written when the unit
 * ends (the times are `Date.now()` values). `spawn` and `write` are injectable for tests. It answers `{ ran, failed }`: `ran` counts launched units
 * (a failed start included), `failed` those that did not end with exit code 0.
 */
import { spawn as nodeSpawn } from 'node:child_process';
import { poolEach } from './pool.mjs';
import { boundedTestArgs, batchTimeoutMs } from './test-file-bound.mjs';
import { testChildEnv } from './test-child-env.mjs';

/**
 * Runs `units` through the pool and answers `{ ran, failed }`. Rejects only for an invalid `width` (before any child starts).
 *
 * @param {string[][]} units lists of test file paths, one `node --test` child each
 */
export async function runTestUnits(units, {
  width, args = () => [], labelOf = (files, index) => `unit-${index}`, envOf = () => ({}),
  header = ({ label, code }) => `# ${label}: exit ${code}\n`, onUnitDone = () => {},
  spawn = nodeSpawn, write = (chunk) => process.stdout.write(chunk),
}) {
  let ran = 0;
  let failed = 0;

  /** One unit: always resolves, with the exit code (1 for anything that is not a clean exit). */
  const runUnit = (files, index) => new Promise((resolve) => {
    ran++;
    const label = labelOf(files, index);
    const startedAt = Date.now();
    const out = [];
    let bound;
    let settled = false;
    const finish = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(bound);
      const endedAt = Date.now();
      write(header({ label, code, index, total: units.length, files, startedAt, endedAt }));
      write(Buffer.concat(out));
      onUnitDone();
      if (code !== 0) failed++;
      resolve(code);
    };
    write(`# ${label} started: ${files.length} file(s)\n`);
    let child;
    try {
      child = spawn('node', boundedTestArgs(...args(files, index), ...files),
        { env: testChildEnv(envOf(files, index)), stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      out.push(Buffer.from(`${label} did not start: ${e?.message ?? e}\n`));
      finish(1);
      return;
    }
    // A unit that never exits (a handle left open after its tests) is ended at its bound and named, never waited on for ever.
    bound = setTimeout(() => {
      out.push(Buffer.from(`${label} ended at its time bound (${batchTimeoutMs(files.length)} ms): ${files.join(', ')}\n`));
      child.kill('SIGKILL');
    }, batchTimeoutMs(files.length));
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => out.push(d));
    child.on('error', (e) => { out.push(Buffer.from(`${label} did not run: ${e?.message ?? e}\n`)); finish(1); });
    child.on('close', (c) => finish(c ?? 1));
  });

  await poolEach(units, width, runUnit);
  return { ran, failed };
}
