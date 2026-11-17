/**
 * The preflight's pure files that take longest run each in a unit of their own, and first (Q-869).
 *
 * ## The defect this refuses
 *
 * The preflight runs its pure standalone files as units, a few at a time (`runTestUnits`), and `batched` cuts those units by the summed
 * length of the path text with no time input. One unit therefore held the slowest file together with its neighbours in name order, and
 * ran as long as that file and all of them: measured over five CI runs, the stage took 301 s where the slowest single file takes 250 s.
 * The wall time of a pool is at least its slowest unit, so the slow files must start first and must not wait behind anything in
 * their own unit. `slowFirstUnits(runs, times, { maxSlow })` (`scripts/_shared/slow-first-units.mjs`) answers that: each file the recorded
 * times put at `SLOW_FILE_MS` or more is a unit of its own, slowest first, at the front (at most `maxSlow` of them; the preflight passes
 * 2 x its unit width, so the units that run alone do not outnumber the workers); the rest stay in the batches `batched` cut, in their order.
 *
 * Input from outside the run is a risk to the plan, never to the set of files: the times come from a snapshot file written from records
 * on an instance. A key in it that names no pure file (a `@ci-only` file the preflight leaves out, a file that is gone) is never added
 * to the plan; a key that every object has (`constructor`, `__proto__`) is not a time; and the result is asserted to be a partition of
 * the files it was given, every unit non-empty (`node --test` with no file runs node's own discovery, which is everything).
 *
 * ## What it asserts
 *
 * - each slow file alone, slowest first, at the front, marked `slow: true`; the rest in their batches, in their order, `slow: false`;
 * - 15 000 ms is slow and 14 999 is not;
 * - at most `maxSlow` slow units: the slowest ones, the rest of the slow files staying in their batches;
 * - a batch the slow files empty is dropped, never run as a unit with no file;
 * - a fixture that would break the partition (a slow file listed in two batches) makes it throw, naming the fault;
 * - a key in the times that is no input file is never added;
 * - no times, times with no file in them, or no slow file gives exactly the input runs;
 * - only a time the object holds itself is a time;
 * - end to end: the REAL `scripts/preflight.mjs --static`, run in a scratch checkout whose every other stage passes, with a planted
 *   `test-results/file-times.json` naming one planted pure file (and a `@ci-only` file that is not run) as slow, says on a
 *   `preflight: units` line that one slow file runs alone first, from the times of 5 runs, starts that file's unit first, runs it with
 *   `--test-concurrency=1`, and still runs every other pure file; with no snapshot the line says the units are cut by path length.
 *
 * Run: node --test testing/standalone/the-slowest-pure-files-run-alone-and-first.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { REPO_ROOT } from './_sources.mjs';
import { makeScratchRepo } from '../_shared/scratch-git-repo.mjs';
import { testChildEnv } from '../_shared/test-child-env.mjs';

/** Imported inside each case, so a base without the module fails each case by name and not the whole file at load. */
const unitsModule = () => import(pathToFileURL(join(REPO_ROOT, 'scripts/_shared/slow-first-units.mjs')).href);

const P = (name) => `testing/standalone/${name}.test.js`;
const run = (...names) => ({ kind: 'pure', args: [], files: names.map(P) });
const unit = (names, slow = false) => ({ files: names.map(P), args: [], slow });
const times = (byName) => ({ files: Object.fromEntries(Object.entries(byName).map(([n, ms]) => [P(n), ms])) });
/** What no slow file must change: the input runs, as units. */
const asUnits = (runs) => runs.map(r => ({ files: r.files, args: r.args, slow: false }));

describe('slowFirstUnits: each slow file alone, slowest first, at the front', () => {
  it('takes every slow file out of its batch into a unit of its own, ordered by time, and keeps the rest in their batches and their order', async () => {
    const { slowFirstUnits } = await unitsModule();
    const runs = [run('a1', 'a2', 'a3', 'a4'), run('b1', 'b2', 'b3')];
    const units = slowFirstUnits(runs, times({ a1: 100, a2: 40_000, a3: 200, a4: 20_000, b1: 90_000, b2: 300, b3: 400 }), { maxSlow: 8 });
    assert.deepEqual(units, [unit(['b1'], true), unit(['a2'], true), unit(['a4'], true), unit(['a1', 'a3']), unit(['b2', 'b3'])]);
  });

  it('a unit that is not slow carries the args of the run it was cut from', async () => {
    const { slowFirstUnits } = await unitsModule();
    const runs = [{ kind: 'pure', args: ['--test-only'], files: [P('a1'), P('a2')] }, run('b1')];
    const units = slowFirstUnits(runs, times({ a1: 50_000 }), { maxSlow: 8 });
    assert.equal(units[0].slow, true);
    assert.deepEqual(units[0].files, [P('a1')]);
    assert.deepEqual(units[1], { files: [P('a2')], args: ['--test-only'], slow: false });
    assert.deepEqual(units[2], unit(['b1']));
  });

  it('15 000 ms is slow and 14 999 ms is not', async () => {
    const { slowFirstUnits, SLOW_FILE_MS } = await unitsModule();
    const at = slowFirstUnits([run('a', 'b', 'c')], times({ b: 15_000 }), { maxSlow: 8 });
    assert.deepEqual(at, [unit(['b'], true), unit(['a', 'c'])], 'a file at exactly 15 000 ms is not alone');
    const under = slowFirstUnits([run('a', 'b', 'c')], times({ b: 14_999 }), { maxSlow: 8 });
    assert.deepEqual(under, [unit(['a', 'b', 'c'])], 'a file at 14 999 ms is alone');
    // The constant the module exports is the one it applies: a file exactly at it is slow, one below it is not.
    const named = slowFirstUnits([run('a', 'b', 'c')], times({ a: SLOW_FILE_MS, c: SLOW_FILE_MS - 1 }), { maxSlow: 8 });
    assert.deepEqual(named, [unit(['a'], true), unit(['b', 'c'])]);
  });
});

describe('slowFirstUnits: at most maxSlow slow units', () => {
  it('keeps the slowest maxSlow files as units and leaves the other slow files in their batches', async () => {
    const { slowFirstUnits } = await unitsModule();
    const runs = [run('a1', 'a2', 'a3'), run('b1', 'b2', 'b3')];
    const t = times({ a1: 20_000, a2: 90_000, a3: 30_000, b1: 25_000, b2: 60_000, b3: 100 });
    const units = slowFirstUnits(runs, t, { maxSlow: 2 });
    assert.deepEqual(units, [unit(['a2'], true), unit(['b2'], true), unit(['a1', 'a3']), unit(['b1', 'b3'])]);
    assert.equal(units.filter(u => u.slow).length, 2, 'more slow units than maxSlow');
  });

  it('maxSlow 1 gives the one slowest alone; maxSlow 0 gives none alone, exactly the input runs', async () => {
    const { slowFirstUnits } = await unitsModule();
    const runs = [run('a1', 'a2'), run('b1')];
    const t = times({ a1: 20_000, b1: 30_000 });
    assert.deepEqual(slowFirstUnits(runs, t, { maxSlow: 1 }), [unit(['b1'], true), unit(['a1', 'a2'])]);
    assert.deepEqual(slowFirstUnits(runs, t, { maxSlow: 0 }), asUnits(runs));
  });
});

describe('slowFirstUnits: a batch the slow files empty is dropped', () => {
  it('a batch made only of slow files leaves no empty unit, and every file is in exactly one unit', async () => {
    const { slowFirstUnits } = await unitsModule();
    const runs = [run('s1', 's2'), run('x1', 'x2')];
    const units = slowFirstUnits(runs, times({ s1: 20_000, s2: 30_000 }), { maxSlow: 8 });
    assert.deepEqual(units, [unit(['s2'], true), unit(['s1'], true), unit(['x1', 'x2'])]);
    for (const u of units) assert.ok(u.files.length > 0, 'a unit with no file: node --test would run everything');
  });

  it('a slow file past maxSlow stays in its batch, which is then not empty and is not dropped', async () => {
    const { slowFirstUnits } = await unitsModule();
    const runs = [run('s1', 's2'), run('x1')];
    const units = slowFirstUnits(runs, times({ s1: 20_000, s2: 30_000 }), { maxSlow: 1 });
    assert.deepEqual(units, [unit(['s2'], true), unit(['s1']), unit(['x1'])]);
  });
});

describe('slowFirstUnits asserts its result is a partition of the files it was given', () => {
  it('a slow file listed in two batches would be one unit and a hole in its second batch: it throws, naming the fault', async () => {
    const { slowFirstUnits } = await unitsModule();
    const runs = [run('a', 'dup'), run('b', 'dup')];
    assert.throws(
      () => slowFirstUnits(runs, times({ dup: 50_000 }), { maxSlow: 8 }),
      (err) => err instanceof Error && /partition|duplicate|twice|more than once|missing|lost/i.test(err.message),
    );
  });
});

describe('slowFirstUnits never adds a file the runs did not hold', () => {
  it('a key in the times that is no input file (a @ci-only file, a gone file) is not added, however slow it is', async () => {
    const { slowFirstUnits } = await unitsModule();
    const runs = [run('a', 'b'), run('c')];
    const t = times({ 'a-ci-only-file-the-preflight-leaves-out': 250_000, 'a-file-that-is-gone': 190_000, b: 30_000 });
    const units = slowFirstUnits(runs, t, { maxSlow: 8 });
    assert.deepEqual(units, [unit(['b'], true), unit(['a']), unit(['c'])]);
    const all = units.flatMap(u => u.files);
    assert.deepEqual(all.filter(f => /ci-only|gone/.test(f)), [], 'a file no run held is in the plan');
  });

  it('times that name only files no run holds give exactly the input runs', async () => {
    const { slowFirstUnits } = await unitsModule();
    const runs = [run('a', 'b')];
    assert.deepEqual(slowFirstUnits(runs, times({ elsewhere: 250_000 }), { maxSlow: 8 }), asUnits(runs));
  });
});

describe('slowFirstUnits with nothing to go by gives the input runs', () => {
  const runs = () => [run('a', 'b'), { kind: 'pure', args: ['--x'], files: [P('c')] }];

  it('times null', async () => {
    const { slowFirstUnits } = await unitsModule();
    assert.deepEqual(slowFirstUnits(runs(), null, { maxSlow: 8 }), asUnits(runs()));
  });

  it('times with no file in them', async () => {
    const { slowFirstUnits } = await unitsModule();
    assert.deepEqual(slowFirstUnits(runs(), { files: {} }, { maxSlow: 8 }), asUnits(runs()));
  });

  it('times with no slow file', async () => {
    const { slowFirstUnits } = await unitsModule();
    assert.deepEqual(slowFirstUnits(runs(), times({ a: 14_999, b: 3, c: 0 }), { maxSlow: 8 }), asUnits(runs()));
  });
});

describe('slowFirstUnits reads a time only from the keys the object holds itself', () => {
  it('a key named constructor or __proto__ is no time for any file, and a slow time on the prototype is not the file\'s', async () => {
    const { slowFirstUnits } = await unitsModule();
    const runs = [run('a', 'toString', 'constructor'), run('b')];
    const parsed = JSON.parse('{"files":{"__proto__":900000,"constructor":900000,"toString":900000}}');
    assert.deepEqual(slowFirstUnits(runs, parsed, { maxSlow: 8 }), asUnits(runs));
    const inherited = { files: Object.create({ [P('a')]: 900_000, [P('b')]: 900_000 }) };
    assert.deepEqual(slowFirstUnits(runs, inherited, { maxSlow: 8 }), asUnits(runs), 'a time read through the prototype made a file slow');
  });
});

describe('the real preflight (end to end, in a scratch checkout whose other stages all pass)', () => {
  const PREFLIGHT = join(REPO_ROOT, 'scripts/preflight.mjs');
  const FILLERS = 100;
  const SLOW = 'pure-007';
  const test = (label, body = '') => `import test from 'node:test';\n${body}test(${JSON.stringify(`ran ${label}`)}, () => {});\n`;
  /** A pure test that says how the runner that holds it was started (Linux: the parent's command line; elsewhere nothing to say). */
  const reportingTest = (label) => `import test from 'node:test';
import { readFileSync } from 'node:fs';
let args = 'not-readable';
try { args = readFileSync('/proc/' + process.ppid + '/cmdline', 'utf8').split(String.fromCharCode(0)).join(' '); } catch { /* not Linux */ }
test(${JSON.stringify(`ran ${label} runner-args`)} + ' ' + args, () => {});
`;

  /**
   * Runs `scripts/preflight.mjs --static` in a scratch git checkout that holds what the stages read and nothing that fails: the gates are
   * trivial passing tests, the scripts exit 0, and the standalone folder holds the files the split needs (a floor of 100 test files, 30 that
   * import the database harness, 20 helper modules), so the pure files are real and the run reaches its standalone stage.
   * `fileTimes` is planted as `test-results/file-times.json` (after the files are tracked), or left out.
   */
  async function plantedRun({ fileTimes }) {
    const { SOURCE_GATES, BUILT_GATES } = await import(pathToFileURL(join(REPO_ROOT, 'scripts/_shared/preflight-stages.mjs')).href);
    const { dir, git, cleanup } = makeScratchRepo({ prefix: 'preflight-units-' });
    try {
      mkdirSync(join(dir, 'scripts'));
      mkdirSync(join(dir, 'testing/standalone'), { recursive: true });
      mkdirSync(join(dir, 'testing/_shared'), { recursive: true });
      for (const s of ['unregistered-local-files', 'check-changelog', 'unrun-tests', 'surface-matrix-audit']) writeFileSync(join(dir, `scripts/${s}.mjs`), 'process.exit(0);\n');
      writeFileSync(join(dir, 'scripts/ok.mjs'), 'process.exit(0);\n');
      writeFileSync(join(dir, 'package.json'), JSON.stringify({
        name: 'planted', private: true, type: 'module',
        scripts: { 'todo:check': 'node scripts/ok.mjs', 'lint:docs': 'node scripts/ok.mjs', 'build:server': 'node scripts/ok.mjs', 'typecheck:client': 'node scripts/ok.mjs' },
      }));
      for (const [name] of [...SOURCE_GATES, ...BUILT_GATES]) writeFileSync(join(dir, `testing/standalone/${name}.test.js`), test(name));
      for (let i = 1; i <= FILLERS; i++) {
        const label = `pure-${String(i).padStart(3, '0')}`;
        writeFileSync(join(dir, `testing/standalone/${label}.test.js`), label === SLOW ? reportingTest(label) : test(label));
      }
      for (let i = 1; i <= 30; i++) writeFileSync(join(dir, `testing/standalone/db-${i}.test.js`), `import { openTestMongo } from './_mongo-harness.mjs';\nvoid openTestMongo;\n`);
      writeFileSync(join(dir, 'testing/standalone/planted-ci-only.test.js'), `/**\n * @ci-only\n */\n${test('planted-ci-only')}`);
      for (let i = 1; i <= 20; i++) writeFileSync(join(dir, `testing/_shared/helper-${i}.mjs`), 'export {};\n');
      git('add', '-A');
      if (fileTimes) {
        mkdirSync(join(dir, 'test-results'), { recursive: true });
        writeFileSync(join(dir, 'test-results/file-times.json'), JSON.stringify(fileTimes));
      }
      const base = { ...process.env };
      delete base.RUNNER_HEAD;
      const r = spawnSync(process.execPath, [PREFLIGHT, '--static'], { cwd: dir, encoding: 'utf8', env: testChildEnv({ RUNNER_HEAD: 'planted-head' }, base), timeout: 170_000, maxBuffer: 64 * 1024 * 1024 });
      return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
    } finally { cleanup(); }
  }

  const unitsLine = (out) => out.split(/\r?\n/).find(l => /^preflight: units\b/.test(l)) ?? '';
  /** What the unit called `label` held: from its header line to the next unit's. */
  const blockOf = (out, label) => {
    const lines = out.split(/\r?\n/);
    const from = lines.findIndex(l => /^\s*batch \d+\/\d+ /.test(l) && l.includes(`(${label})`));
    if (from < 0) return '';
    const next = lines.findIndex((l, i) => i > from && /^\s*batch \d+\/\d+ /.test(l));
    return lines.slice(from, next < 0 ? undefined : next).join('\n');
  };
  const firstStarted = (out) => out.match(/^# (\S+) started: (\d+) file\(s\)/m);
  const ranNames = (out) => new Set([...out.matchAll(/ran (pure-\d{3})/g)].map(m => m[1]));
  const timesFile = (over = {}) => ({
    generatedAt: new Date().toISOString(), newestSourceAt: new Date(Date.now() - 3_600_000).toISOString(), runs: 5,
    files: { [`testing/standalone/${SLOW}.test.js`]: 60_000, 'testing/standalone/planted-ci-only.test.js': 250_000, 'testing/standalone/a-file-that-is-gone.test.js': 90_000 },
    ...over,
  });

  it('with a planted snapshot: one slow file runs alone first and with one worker, the @ci-only and gone files are not run, every other pure file runs', { timeout: 200_000 }, async () => {
    const r = await plantedRun({ fileTimes: timesFile() });
    assert.equal(r.status, 0, r.out.slice(-3000));
    assert.match(r.out, /Preflight STATIC passed/, r.out.slice(-1500));
    const said = unitsLine(r.out);
    assert.ok(said, `no line starting 'preflight: units':\n${r.out.slice(0, 2500)}`);
    assert.match(said, /\b1 slow file/, said);
    assert.match(said, /\b5\b/, `the line does not say how many runs the times rest on: ${said}`);
    assert.doesNotMatch(said, /cut by path length/, said);
    const first = firstStarted(r.out);
    assert.ok(first, `no unit started:\n${r.out.slice(0, 2500)}`);
    assert.equal(first[2], '1', `the first unit to start holds ${first[2]} file(s), not the one slow file`);
    const held = blockOf(r.out, first[1]);
    assert.match(held, new RegExp(`ran ${SLOW}\\b`), `the first unit is not the slow file's:\n${held.slice(0, 1500)}`);
    if (process.platform === 'linux') {
      assert.match(held, /runner-args[^\n]*--test-concurrency=1(?!\d)/, `the slow file's unit does not run with one worker:\n${held.slice(0, 1500)}`);
    }
    assert.doesNotMatch(r.out, /ran planted-ci-only/, 'a @ci-only file ran in the preflight because the snapshot named it');
    assert.equal(ranNames(r.out).size, FILLERS, 'a pure file was left out, or the plan ran something that is not one');
  });

  it('with no snapshot: the line says the units are cut by path length, and the first unit holds more than one file', { timeout: 200_000 }, async () => {
    const r = await plantedRun({ fileTimes: null });
    assert.equal(r.status, 0, r.out.slice(-3000));
    const said = unitsLine(r.out);
    assert.ok(said, `no line starting 'preflight: units':\n${r.out.slice(0, 2500)}`);
    assert.match(said, /cut by path length/, said);
    const first = firstStarted(r.out);
    assert.ok(first && Number(first[2]) > 1, `the first unit holds ${first?.[2]} file(s) with no times to go by`);
    assert.equal(ranNames(r.out).size, FILLERS);
  });
});
