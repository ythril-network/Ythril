/**
 * The pool that runs the standalone test units never has more than its width alive at once, and a unit that fails, cannot start or never
 * exits does not stop the rest (Q-863, bundle-310).
 *
 * ## What it prevents
 *
 * Preflight's pure batches and its parse check ran one child at a time, so the machine's other cores sat idle while one batch's slowest file
 * finished (measured: a 61.6 s file held a 66.7 s batch). They now run through two shared modules, and each carries a rule a caller
 * must not be able to drop:
 *
 * - `testing/_shared/pool.mjs`, `poolEach(items, width, work)`: at most `width` calls of `work` at once, results in input order, a width
 *   that is not a positive integer refused (a width of 0 would never start a job, and a pool that quietly starts none reports a clean run).
 * - `testing/_shared/run-test-units.mjs`, `runTestUnits(units, { width, args, labelOf, envOf, header, onUnitDone, spawn, write })`: one
 *   `node --test` child per unit through `poolEach`, extracted from `runShardUnits` of `testing/_init/run-standalone.mjs`. Each child is
 *   bounded (`boundedTestArgs` on its command line, a SIGKILL at `batchTimeoutMs(files)` with a named line), gets `testChildEnv(...)` and never
 *   rejects: a non-zero exit, a spawn error, a spawn that throws and a kill at the bound each become a failed unit, and the stage fails once,
 *   after every unit ended (amendments a-g of the plan on Q-863). Its output is held and written whole under a header, so units never
 *   interleave. It answers `{ ran, failed }`.
 *
 * ## What the cases drive
 *
 * `spawn` is injectable, so the cases drive a fake child (it emits data, exits with a code, errors, or never exits) and a fake clock for the bound
 * (`mock.timers`, so the real 15-minute bound is crossed in a tick). One case runs the real `node` over two fixture files, so a fake that
 * agrees with the module but not with node is seen (the vet's "mock hides nothing").
 *
 * The modules are imported inside each case, so a missing module fails each case by name instead of the whole file at load.
 *
 * ## Seen red
 *
 * On the base (d113c9e6) neither module exists: every case fails with ERR_MODULE_NOT_FOUND for `pool.mjs` or `run-test-units.mjs`.
 *
 * Run: node --test testing/standalone/a-test-unit-pool-runs-at-most-its-width.test.js
 */
import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { boundedTestArgs, batchTimeoutMs, TEST_FILE_TIMEOUT_MS } from '../_shared/test-file-bound.mjs';
import { isTestChild } from '../_shared/test-child-env.mjs';
import { elapse } from '../_shared/sleep.mjs';
import { scratchRoot as scratchRootOf } from '../../scripts/_shared/scratch-root.mjs';

const loadPool = () => import('../_shared/pool.mjs');
const loadUnits = () => import('../_shared/run-test-units.mjs');

/** Lets every already-scheduled immediate and microtask run: the pool and the fake children move on `setImmediate`, never on a timer. */
const settle = async (rounds = 5) => { for (let i = 0; i < rounds; i++) await new Promise((r) => setImmediate(r)); };

/** Waits (real time, bounded) until `ok()`: a case that would hang on a pool that never starts a job fails with a message instead. */
async function until(ok, what) {
  const deadline = Date.now() + 5000;
  while (!ok()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await new Promise((r) => setImmediate(r));
  }
}

// ───────────────────────────────────────────────────── poolEach ─────────────────────────────────────────────────────

describe('poolEach: at most `width` jobs at once, results in input order', () => {
  /** A job that stays alive for a few turns of the loop and records how many jobs were alive with it. */
  function tracker() {
    const t = { live: 0, max: 0, started: [], work: null };
    t.work = async (item) => {
      t.started.push(item);
      t.live++;
      t.max = Math.max(t.max, t.live);
      await settle(3);
      t.live--;
      return `done-${item}`;
    };
    return t;
  }

  it('runs two jobs at the same time (the pool overlaps work: width 2 is not width 1)', async () => {
    const { poolEach } = await loadPool();
    const started = [];
    let release;
    const bothStarted = new Promise((r) => { release = r; });
    const work = async (item) => {
      started.push(item);
      if (started.length === 2) release();
      // A job waits for the other to start: a pool that runs them one after the other never gets there.
      let timer;
      const giveUp = new Promise((r) => { timer = setTimeout(r, 3000); });
      try { await Promise.race([bothStarted, giveUp]); } finally { clearTimeout(timer); }
      return started.length;
    };
    const results = await poolEach(['a', 'b'], 2, work);
    assert.deepEqual(results, [2, 2], 'each job saw the other running: the pool did not overlap them');
  });

  it('never has more than `width` jobs alive, whatever the number of items, and does use the whole width', async () => {
    const { poolEach } = await loadPool();
    for (const width of [1, 2, 3, 7]) {
      const t = tracker();
      await poolEach(Array.from({ length: 20 }, (_, i) => i), width, t.work);
      assert.equal(t.max, width, `width ${width}: ${t.max} jobs were alive at once`);
      assert.equal(t.started.length, 20, `width ${width}: every item is worked`);
    }
  });

  it('answers the results in INPUT order, not in the order the jobs finished', async () => {
    const { poolEach } = await loadPool();
    // The first item finishes last: a pool that pushes results as they land answers [c, b, a].
    const finishOrder = [];
    const delays = { a: 12, b: 6, c: 0 };
    const results = await poolEach(['a', 'b', 'c'], 3, async (item) => {
      await elapse(delays[item], 'simulated latency: the first item finishes last, so results landing in finish order would come back reversed');
      finishOrder.push(item);
      return item.toUpperCase();
    });
    assert.deepEqual(finishOrder, ['c', 'b', 'a'], 'fixture check: the jobs finish in the reverse of their input order');
    assert.deepEqual(results, ['A', 'B', 'C']);
  });

  it('hands each job its item and its index in the input', async () => {
    const { poolEach } = await loadPool();
    const seen = [];
    await poolEach(['x', 'y', 'z'], 2, async (item, index) => { seen.push([item, index]); });
    assert.deepEqual(seen.sort(), [['x', 0], ['y', 1], ['z', 2]]);
  });

  it('an empty list answers an empty list and starts no job', async () => {
    const { poolEach } = await loadPool();
    let calls = 0;
    const results = await poolEach([], 4, async () => { calls++; });
    assert.deepEqual(results, []);
    assert.equal(calls, 0);
  });

  it('a width over the number of items runs every item at once and no more jobs than items', async () => {
    const { poolEach } = await loadPool();
    const t = tracker();
    const results = await poolEach(['a', 'b', 'c'], 50, t.work);
    assert.equal(t.max, 3, 'three items, three jobs alive together');
    assert.deepEqual(results, ['done-a', 'done-b', 'done-c']);
  });

  it('refuses a width that is not a positive integer, and starts no job when it does', async () => {
    const { poolEach } = await loadPool();
    for (const width of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '2', undefined]) {
      let calls = 0;
      await assert.rejects(async () => poolEach(['a', 'b'], width, async () => { calls++; }), `width ${String(width)} was accepted`);
      assert.equal(calls, 0, `width ${String(width)}: a refused pool still started a job`);
    }
  });
});

// ─────────────────────────────────────────────────── runTestUnits ───────────────────────────────────────────────────

/** A child process as `spawn` answers it: stdout and stderr to read, `kill`, and 'close' / 'error' to wait for. */
function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = [];
  // As a real child: a kill ends it, and it reports no exit code, only the signal.
  child.kill = (signal) => { child.killed.push(signal); queueMicrotask(() => child.emit('close', null, signal)); return true; };
  return child;
}

/**
 * A `spawn` whose children follow a script keyed by the unit's first file: `{ code, out, err }` exits with that code after writing its output,
 * `'hang'` never exits, `'error'` emits an error and nothing else, `'throw'` makes the call itself throw. Every call is kept, with the number of
 * children alive at that moment, so a case can read the width the pool actually used.
 */
function fakeSpawn(script) {
  const fake = { calls: [], live: 0, max: 0 };
  fake.spawn = (command, args, options) => {
    const files = args.filter((a) => a.endsWith('.js'));
    const call = { command, args, options, files, child: fakeChild(), liveAtStart: 0, writesAtStart: null };
    fake.calls.push(call);
    const how = script[files[0]] ?? { code: 0 };
    if (how === 'throw') throw new Error(`spawn refused for ${files[0]}`);
    fake.live++;
    fake.max = Math.max(fake.max, fake.live);
    call.liveAtStart = fake.live;
    const end = () => { fake.live--; };
    call.child.once('close', end);
    call.child.once('error', end);
    if (how === 'hang') return call.child;
    if (how === 'error') { setImmediate(() => call.child.emit('error', new Error(`spawn ENOENT ${files[0]}`))); return call.child; }
    setImmediate(() => {
      if (how.out) call.child.stdout.emit('data', Buffer.from(how.out));
      if (how.err) call.child.stderr.emit('data', Buffer.from(how.err));
      setImmediate(() => call.child.emit('close', how.code, null));
    });
    return call.child;
  };
  return fake;
}

/** Starts `runTestUnits` the way preflight does: a label, flags and environment per unit, FIXED by the unit's position in the list. */
async function start(units, fake, over = {}) {
  const { runTestUnits } = await loadUnits();
  const written = [];
  const state = { written, done: 0, infos: [] };
  // Wrapped, so a refusal that is thrown and one that is rejected both reach the case as a rejected promise.
  state.promise = (async () => runTestUnits(units, {
    width: 2,
    args: (files, index) => [`--mark=${index}`],
    labelOf: (files, index) => `unit-${index}`,
    envOf: (files, index) => ({ UNIT_MARK: String(index) }),
    header: (info) => { state.infos.push(info); return `HDR ${info.label} exit ${info.code}\n`; },
    onUnitDone: () => { state.done++; },
    spawn: fake.spawn,
    write: (chunk) => { written.push(String(chunk)); },
    ...over,
  }))();
  state.text = () => written.join('');
  return state;
}

describe('runTestUnits: the pool over a fake child', () => {
  it('runs every unit and answers { ran, failed } (all green: ran = the units, failed = 0)', async () => {
    const fake = fakeSpawn({});
    const run = await start([['a.js'], ['b.js'], ['c.js']], fake);
    const result = await run.promise;
    assert.deepEqual(result, { ran: 3, failed: 0 });
    assert.equal(run.done, 3, 'onUnitDone is called once per unit');
  });

  it('an empty list runs nothing and answers { ran: 0, failed: 0 }', async () => {
    const fake = fakeSpawn({});
    const run = await start([], fake);
    assert.deepEqual(await run.promise, { ran: 0, failed: 0 });
    assert.equal(fake.calls.length, 0);
  });

  it('never has more than `width` children alive, and uses the width it was given', async () => {
    const fake = fakeSpawn({});
    const run = await start(Array.from({ length: 9 }, (_, i) => [`f${i}.js`]), fake, { width: 3 });
    assert.deepEqual(await run.promise, { ran: 9, failed: 0 });
    assert.equal(fake.max, 3, `${fake.max} children were alive at once, width was 3`);
    assert.ok(fake.calls.every((c) => c.liveAtStart <= 3));
  });

  it('refuses a width under 1 and starts no child', async () => {
    const fake = fakeSpawn({});
    for (const width of [0, -2, 0.5]) {
      const run = await start([['a.js']], fake, { width });
      await assert.rejects(run.promise, `width ${width} was accepted`);
    }
    assert.equal(fake.calls.length, 0);
  });

  it('one failing unit does not stop the others: they all run, and the run reports one failure', async () => {
    const fake = fakeSpawn({ 'b.js': { code: 3, out: 'not ok 1 - b broke\n' } });
    const run = await start([['a.js'], ['b.js'], ['c.js'], ['d.js']], fake, { width: 1 });
    const result = await run.promise;
    assert.deepEqual(result, { ran: 4, failed: 1 });
    assert.deepEqual(fake.calls.map((c) => c.files[0]), ['a.js', 'b.js', 'c.js', 'd.js'], 'a unit after the failing one still ran');
    assert.match(run.text(), /HDR unit-1 exit 3\nnot ok 1 - b broke\n/, 'the failing unit\'s output is written, under its header, with its exit code');
  });

  it('a spawn error is a failed unit, never a rejection, and the others still run', async () => {
    const fake = fakeSpawn({ 'b.js': 'error' });
    const run = await start([['a.js'], ['b.js'], ['c.js']], fake, { width: 1 });
    const result = await run.promise;
    assert.deepEqual(result, { ran: 3, failed: 1 });
    assert.equal(run.done, 3, 'a unit that errored is still a unit that ended');
    assert.ok(fake.calls.some((c) => c.files[0] === 'c.js'), 'the unit after the errored one ran');
  });

  it('a spawn that throws is a failed unit, never a rejection, and the others still run', async () => {
    const fake = fakeSpawn({ 'a.js': 'throw' });
    const run = await start([['a.js'], ['b.js']], fake, { width: 1 });
    const result = await run.promise;
    assert.deepEqual(result, { ran: 2, failed: 1 });
    assert.ok(fake.calls.some((c) => c.files[0] === 'b.js'), 'the unit after the throwing spawn ran');
  });

  it('every failure kind at once: a failing exit, an error and a throw are three failures, the green unit is not one', async () => {
    const fake = fakeSpawn({ 'a.js': { code: 1 }, 'b.js': 'error', 'c.js': 'throw', 'd.js': { code: 0 } });
    const run = await start([['a.js'], ['b.js'], ['c.js'], ['d.js']], fake, { width: 4 });
    assert.deepEqual(await run.promise, { ran: 4, failed: 3 });
  });

  it('a unit that never exits is killed with SIGKILL at its bound, named, counted failed, and the others finish', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const fake = fakeSpawn({ 'hang.js': 'hang', 'ok.js': { code: 0 } });
      const run = await start([['hang.js'], ['ok.js']], fake, { width: 2 });
      await until(() => fake.calls.length === 2, 'both units to start');
      await settle();
      assert.deepEqual(fake.calls[0].child.killed, [], 'killed before its bound');
      mock.timers.tick(batchTimeoutMs(1));
      const result = await run.promise;
      assert.deepEqual(fake.calls[0].child.killed, ['SIGKILL']);
      assert.deepEqual(fake.calls[1].child.killed, [], 'the unit that ended in time was killed too');
      assert.deepEqual(result, { ran: 2, failed: 1 });
      const line = run.text().split('\n').find((l) => l.includes('unit-0') && /bound/i.test(l));
      assert.ok(line, `no line names the killed unit and its bound:\n${run.text()}`);
      assert.ok(line.includes('hang.js'), 'the line names the files of the unit it ended');
    } finally {
      mock.timers.reset();
    }
  });

  it('each unit\'s bound is batchTimeoutMs of ITS file count: a three-file unit outlives a one-file unit', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const fake = fakeSpawn({ 'one.js': 'hang', 'three-a.js': 'hang' });
      const run = await start([['one.js'], ['three-a.js', 'three-b.js', 'three-c.js']], fake, { width: 2 });
      await until(() => fake.calls.length === 2, 'both units to start');
      await settle();
      mock.timers.tick(TEST_FILE_TIMEOUT_MS);
      await settle();
      assert.deepEqual(fake.calls[0].child.killed, ['SIGKILL'], 'the one-file unit is ended at one file\'s bound');
      assert.deepEqual(fake.calls[1].child.killed, [], 'the three-file unit was ended at one file\'s bound');
      mock.timers.tick(batchTimeoutMs(3) - TEST_FILE_TIMEOUT_MS);
      assert.deepEqual(await run.promise, { ran: 2, failed: 2 });
      assert.deepEqual(fake.calls[1].child.killed, ['SIGKILL'], 'the three-file unit is ended at three files\' bound');
    } finally {
      mock.timers.reset();
    }
  });

  it('a unit that exits in time is not killed later: its bound is cleared', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const fake = fakeSpawn({ 'a.js': { code: 0 } });
      const run = await start([['a.js']], fake, { width: 1 });
      assert.deepEqual(await run.promise, { ran: 1, failed: 0 });
      mock.timers.tick(batchTimeoutMs(1) * 2);
      await settle();
      assert.deepEqual(fake.calls[0].child.killed, [], 'a finished child was killed when its bound passed');
    } finally {
      mock.timers.reset();
    }
  });

  it('holds each unit\'s output and writes it whole under its header: units that ran together never interleave', async () => {
    const fake = fakeSpawn({ 'a.js': 'hang', 'b.js': 'hang' });
    const run = await start([['a.js'], ['b.js']], fake, { width: 2 });
    await until(() => fake.calls.length === 2, 'both units to start');
    const [a, b] = fake.calls.map((c) => c.child);
    // Chunks arrive alternately, on both streams; nothing may be written until a unit has ended.
    a.stdout.emit('data', Buffer.from('a1\n'));
    b.stdout.emit('data', Buffer.from('b1\n'));
    a.stderr.emit('data', Buffer.from('a2\n'));
    b.stderr.emit('data', Buffer.from('b2\n'));
    await settle();
    assert.ok(!/a1|a2|b1|b2/.test(run.text()), `output was written before its unit ended:\n${run.text()}`);
    b.emit('close', 0, null);
    await settle();
    assert.ok(run.text().includes('HDR unit-1 exit 0\nb1\nb2\n'), `unit 1's output is not whole under its header:\n${run.text()}`);
    assert.ok(!/a1|a2/.test(run.text()), 'unit 0 wrote while it was still running');
    a.emit('close', 0, null);
    assert.deepEqual(await run.promise, { ran: 2, failed: 0 });
    assert.ok(run.text().includes('HDR unit-0 exit 0\na1\na2\n'), `unit 0's output is not whole under its header:\n${run.text()}`);
  });

  it('writes a start line when a unit launches (its name and file count), before its output', async () => {
    const fake = fakeSpawn({ 'a.js': 'hang' });
    let atSpawn = '';
    const run = await start([['a.js', 'b.js']], fake, { width: 1 });
    await until(() => fake.calls.length === 1, 'the unit to start');
    atSpawn = run.text();
    assert.match(atSpawn, /unit-0/, 'no line names the unit when it starts');
    assert.match(atSpawn, /\b2 file/, 'the start line does not say how many files the unit runs');
    fake.calls[0].child.emit('close', 0, null);
    await run.promise;
  });

  it('fixes each unit\'s label, flags and environment by its position in the list, whatever order the units end in', async () => {
    // Unit 0 ends last and unit 2 first: a label taken from the order of ending would hand them the wrong timing file.
    const fake = fakeSpawn({ 'a.js': 'hang', 'b.js': 'hang', 'c.js': 'hang' });
    const run = await start([['a.js'], ['b.js'], ['c.js']], fake, { width: 3 });
    await until(() => fake.calls.length === 3, 'all units to start');
    const [a, b, c] = fake.calls.map((x) => x.child);
    c.emit('close', 0, null);
    await settle();
    b.emit('close', 0, null);
    await settle();
    a.emit('close', 0, null);
    await run.promise;
    for (const call of fake.calls) {
      const index = { 'a.js': 0, 'b.js': 1, 'c.js': 2 }[call.files[0]];
      assert.deepEqual(call.args, boundedTestArgs(`--mark=${index}`, ...call.files), `unit ${index}: the command line is boundedTestArgs, the caller's flags, then its files`);
      assert.equal(call.options.env.UNIT_MARK, String(index), `unit ${index}: its environment is its own`);
    }
    assert.deepEqual(run.infos.map((i) => i.label).sort(), ['unit-0', 'unit-1', 'unit-2']);
    assert.deepEqual(run.infos.map((i) => i.label), ['unit-2', 'unit-1', 'unit-0'], 'fixture check: the units ended in the reverse order');
  });

  it('starts every child as `node` with an argument array, no shell, its output piped, and the environment testChildEnv builds', async () => {
    const before = process.env.YTHRIL_TEST_RUNS_TOKEN;
    process.env.YTHRIL_TEST_RUNS_TOKEN = 'a-secret-only-the-recorder-may-hold';
    try {
      const fake = fakeSpawn({});
      const run = await start([['a.js']], fake, { width: 1 });
      await run.promise;
      const { command, args, options } = fake.calls[0];
      assert.equal(command, 'node');
      assert.ok(Array.isArray(args), 'the arguments are an array: through a shell the line is capped and the paths are parsed');
      assert.ok(!options.shell, 'a unit is started through a shell');
      assert.equal(options.stdio[1], 'pipe', 'stdout is not piped: the unit\'s output could not be held');
      assert.equal(options.stdio[2], 'pipe', 'stderr is not piped: the unit\'s output could not be held');
      assert.equal(options.env.YTHRIL_TEST_RUNS_TOKEN, undefined, 'the recorder\'s token reached a test child');
      assert.equal(isTestChild(options.env), false, 'a child that sees the runner\'s context takes itself for a worker of it and runs nothing');
      assert.equal(options.env.UNIT_MARK, '0', 'what envOf adds is merged in');
    } finally {
      if (before === undefined) delete process.env.YTHRIL_TEST_RUNS_TOKEN; else process.env.YTHRIL_TEST_RUNS_TOKEN = before;
    }
  });
});

describe('runTestUnits: the real node, two fixture files, no fake', () => {
  it('a green unit and a failing unit run side by side: their output is whole and under their headers, the run answers one failure', async () => {
    const { runTestUnits } = await loadUnits();
    const root = scratchRootOf();
    mkdirSync(root, { recursive: true });
    const dir = mkdtempSync(join(root, 'units-'));
    try {
      const green = join(dir, 'green.test.js');
      const red = join(dir, 'red.test.js');
      writeFileSync(green, "import { it } from 'node:test';\nit('green case', () => {});\n");
      writeFileSync(red, "import { it } from 'node:test';\nimport assert from 'node:assert/strict';\nit('red case', () => assert.equal(1, 2));\n");
      const written = [];
      const result = await runTestUnits([[green], [red]], {
        width: 2,
        args: () => [],
        labelOf: (files, index) => `real-${index}`,
        envOf: () => ({}),
        header: ({ label, code }) => `HDR ${label} exit ${code}\n`,
        onUnitDone: () => {},
        write: (chunk) => { written.push(String(chunk)); },
      });
      const text = written.join('');
      assert.deepEqual(result, { ran: 2, failed: 1 }, text);
      const greenAt = text.indexOf('HDR real-0 exit 0\n');
      const redAt = text.indexOf('HDR real-1 exit 1\n');
      assert.ok(greenAt >= 0 && redAt >= 0, `the headers are missing or carry the wrong exit code:\n${text}`);
      const [first, second] = greenAt < redAt ? [text.slice(greenAt, redAt), text.slice(redAt)] : [text.slice(redAt, greenAt), text.slice(greenAt)];
      const greenOut = greenAt < redAt ? first : second;
      const redOut = greenAt < redAt ? second : first;
      assert.match(greenOut, /green case/);
      assert.ok(!/red case/.test(greenOut), 'the red unit\'s output is inside the green unit\'s');
      assert.match(redOut, /red case/);
      assert.ok(!/green case/.test(redOut), 'the green unit\'s output is inside the red unit\'s');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
