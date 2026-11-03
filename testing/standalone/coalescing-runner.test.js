/**
 * The coalescing runner — the two sync-lock behaviours that could not be tested before the split.
 *
 * `sync-engine-lock.test.js` characterized everything about the per-network lock that was observable
 * from outside `runSyncForNetwork`, and stated plainly what was not:
 *
 *   - that a concurrent trigger starts NO second cycle, and
 *   - that a trigger arriving mid-cycle fires exactly ONE more afterwards.
 *
 * Neither could be asserted. `runSyncForNetwork` is `async`, so the in-flight promise it returns is
 * never referentially equal to the one it holds; and a sync cycle with no reachable members resolves
 * entirely in microtasks, so a queued rerun began and finished before any caller's continuation ran
 * (measured at 2ms, including against a closed port).
 *
 * Both need the job COUNTED, and counting needs it injectable. That was the stated requirement of the
 * split, and this file is what it bought: `run(key, job)` takes the work as a parameter, so a test can
 * hand it a counter and a promise it controls. Nothing here is a mock of the sync engine — it is the
 * same runner the engine uses, driven with a job that does nothing but record and wait.
 *
 * Run: node --test testing/standalone/coalescing-runner.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

let createCoalescingRunner;

before(async () => {
  ({ createCoalescingRunner } = await import('../../server/dist/sync/coalescing-runner.js'));
});

/** A job whose completion the test controls, and whose every start is counted. */
function controllableJob() {
  const state = { starts: 0, resolvers: [] };
  const job = () => {
    state.starts++;
    return new Promise(resolve => state.resolvers.push(resolve));
  };
  /** Finish the oldest outstanding run and let microtasks drain. */
  state.finishOne = async (value = { synced: 0, errors: 0 }) => {
    const resolve = state.resolvers.shift();
    assert.ok(resolve, 'expected a job to be in flight');
    resolve(value);
    await new Promise(r => setImmediate(r));
  };
  return { job, state };
}

describe('coalescing runner — one job per key', () => {
  it('starts exactly ONE job however many concurrent triggers arrive', async () => {
    // THE test that motivated the split. Ten triggers, one cycle. Without this the engine would run
    // ten sync cycles at once against the same peers — correct output, ten times the connections,
    // and no symptom other than load.
    const runner = createCoalescingRunner();
    const { job, state } = controllableJob();

    const calls = Array.from({ length: 10 }, () => runner.run('net', job));
    assert.equal(state.starts, 1, 'ten concurrent triggers must start one job');

    await state.finishOne({ synced: 3, errors: 0 });
    const results = await Promise.all(calls);
    for (const r of results) {
      assert.deepEqual(r, { synced: 3, errors: 0 }, 'every joiner gets the result of the job it joined');
    }
  });

  it('fires exactly ONE rerun after the cycle, not one per trigger', async () => {
    // The second impossible test. The rerun is a Set, not a counter, so five triggers during one
    // cycle collapse to a single follow-up. If it were a queue, a burst of triggers would produce a
    // burst of cycles back-to-back — the very pile-up the lock exists to prevent, merely delayed.
    const runner = createCoalescingRunner();
    const { job, state } = controllableJob();

    const first = runner.run('net', job);
    for (let i = 0; i < 5; i++) void runner.run('net', job);
    assert.equal(state.starts, 1);

    await state.finishOne();
    await first;
    assert.equal(state.starts, 2, 'five mid-cycle triggers must produce exactly one rerun');

    await state.finishOne();                       // let the rerun finish
    assert.equal(state.starts, 2, 'the rerun must not itself queue another');
  });

  it('does not rerun when nothing arrived during the cycle', async () => {
    const runner = createCoalescingRunner();
    const { job, state } = controllableJob();
    const p = runner.run('net', job);
    await state.finishOne();
    await p;
    assert.equal(state.starts, 1, 'an uncontended cycle runs once');
  });

  it('runs a fresh job for a trigger that arrives AFTER the cycle ended', async () => {
    // The other side of coalescing: once the key is free, a trigger is a new cycle rather than a
    // no-op. A lock that stayed held would make this silently do nothing.
    const runner = createCoalescingRunner();
    const { job, state } = controllableJob();
    const p1 = runner.run('net', job);
    await state.finishOne();
    await p1;

    const p2 = runner.run('net', job);
    assert.equal(state.starts, 2);
    await state.finishOne();
    await p2;
  });
});

describe('coalescing runner — keys are independent', () => {
  it('runs different keys concurrently rather than serialising them', async () => {
    // A global lock would queue every network in the instance behind the slowest peer.
    const runner = createCoalescingRunner();
    const { job, state } = controllableJob();

    const a = runner.run('net-a', job);
    const b = runner.run('net-b', job);
    assert.equal(state.starts, 2, 'two keys must not block each other');
    assert.equal(runner.isRunning('net-a'), true);
    assert.equal(runner.isRunning('net-b'), true);

    await state.finishOne();
    await state.finishOne();
    await Promise.all([a, b]);
  });

  it('a rerun queued for one key does not run the other', async () => {
    const runner = createCoalescingRunner();
    const { job, state } = controllableJob();

    const a = runner.run('net-a', job);
    void runner.run('net-a', job);          // queue a rerun for A only
    const b = runner.run('net-b', job);
    assert.equal(state.starts, 2);

    await state.finishOne();                // finish A
    await a;
    assert.equal(state.starts, 3, "A's rerun started");
    assert.equal(runner.isRunning('net-b'), true, 'B is untouched');

    await state.finishOne();
    await state.finishOne();
    await b;
  });
});

describe('coalescing runner — failure does not wedge a key', () => {
  it('releases the key when the job REJECTS', async () => {
    // The silent-forever failure. Without the `finally`, one failed cycle would leave the key held
    // and that network would never sync again — no error, no retry, no log, and every other network
    // behaving normally.
    const runner = createCoalescingRunner();
    const boom = () => Promise.reject(new Error('peer exploded'));

    await assert.rejects(() => runner.run('net', boom), /peer exploded/);
    assert.equal(runner.isRunning('net'), false, 'a rejected job must release its key');
  });

  it('runs again after a rejection', async () => {
    const runner = createCoalescingRunner();
    let calls = 0;
    const failThenSucceed = () => {
      calls++;
      return calls === 1 ? Promise.reject(new Error('transient')) : Promise.resolve('ok');
    };

    await assert.rejects(() => runner.run('net', failThenSucceed), /transient/);
    assert.equal(await runner.run('net', failThenSucceed), 'ok', 'the key recovers');
  });

  it('still fires a queued rerun after the joined job rejects', async () => {
    // A trigger arriving during a cycle that then fails must not be swallowed — the thing that
    // prompted it still needs syncing.
    const runner = createCoalescingRunner();
    let starts = 0;
    let failNext = true;
    const job = () => {
      starts++;
      if (failNext) { failNext = false; return Promise.reject(new Error('first fails')); }
      return Promise.resolve('ok');
    };

    const first = runner.run('net', job);
    const joined = runner.run('net', job);      // queues a rerun, joins the failing cycle
    await assert.rejects(() => first, /first fails/);
    await assert.rejects(() => joined, /first fails/);
    await new Promise(r => setImmediate(r));

    assert.equal(starts, 2, 'the queued rerun still ran after the failure');
    assert.equal(runner.isRunning('net'), false);
  });
});

describe('coalescing runner — isRunning', () => {
  it('is false for a key that has never run', () => {
    assert.equal(createCoalescingRunner().isRunning('never'), false);
  });

  it('tracks the in-flight window', async () => {
    const runner = createCoalescingRunner();
    const { job, state } = controllableJob();
    assert.equal(runner.isRunning('net'), false);
    const p = runner.run('net', job);
    assert.equal(runner.isRunning('net'), true);
    await state.finishOne();
    await p;
    assert.equal(runner.isRunning('net'), false);
  });
});

/**
 * `join(key, job)` — the handle a trigger reads progress from (bundle-231, Q-675).
 *
 * A waited sync that runs out of time answers the members that had finished, so the trigger has to reach the running cycle's progress. The
 * runner owns who joined what, so it is the runner that hands each trigger the progress of the cycle IT joined: `join` returns
 * `{ promise, progress }`, the runner creates a fresh holder for every run it starts and passes it to the job as its argument, and a trigger
 * that joins reads that same holder. `run` stays what it was (a promise of the joined job's result), for its other caller.
 *
 * Red until `join` exists: the handle is read off a function the runner does not have yet (`runner.join is not a function`).
 */
describe('coalescing runner — join hands each trigger the progress of the cycle it joined', () => {
  /** A job that records the progress holder it was handed and waits for the test to finish it. */
  function progressJob() {
    const state = { holders: [], resolvers: [] };
    const job = (progress) => {
      state.holders.push(progress);
      return new Promise(resolve => state.resolvers.push(resolve));
    };
    state.finishOne = async (value = 'done') => {
      const resolve = state.resolvers.shift();
      assert.ok(resolve, 'expected a job to be in flight');
      resolve(value);
      await new Promise(r => setImmediate(r));
    };
    return { job, state };
  }

  it('join exists on the runner', () => {
    const runner = createCoalescingRunner();
    assert.equal(typeof runner.join, 'function', 'server/dist/sync/coalescing-runner.js: createCoalescingRunner() has no join(key, job); the implementation adds it');
  });

  it('hands the job a progress holder, and the handle returns that holder while the job runs', async () => {
    const runner = createCoalescingRunner();
    const { job, state } = progressJob();
    const handle = runner.join('net', job);
    assert.equal(state.holders.length, 1, 'one job started');
    assert.equal(typeof state.holders[0], 'object', 'the job is handed a holder object');
    assert.notEqual(state.holders[0], null);
    assert.equal(handle.progress, state.holders[0], 'the handle reads the very holder the job was given');
    state.holders[0].finished = ['a'];                      // the job writes what it has done so far
    assert.deepEqual(handle.progress.finished, ['a'], 'what the job writes into its holder is what the trigger reads');
    await state.finishOne('result-1');
    assert.equal(await handle.promise, 'result-1');
  });

  it('a trigger that joins a running cycle reads the SAME holder, and starts nothing', async () => {
    const runner = createCoalescingRunner();
    const { job, state } = progressJob();
    const first = runner.join('net', job);
    const joined = runner.join('net', job);
    const third = runner.join('net', job);
    assert.equal(state.holders.length, 1, 'three triggers, one job');
    assert.equal(joined.progress, first.progress, 'a joiner reads the progress of the cycle it joined');
    assert.equal(third.progress, first.progress);
    state.holders[0].finished = ['x', 'y'];
    assert.deepEqual(joined.progress.finished, ['x', 'y'], 'the joiner sees what the cycle has finished');
    await state.finishOne('r1');
    assert.equal(await first.promise, 'r1');
    assert.equal(await joined.promise, 'r1', 'the joiner resolves with the result of the job it joined, as run() does');
    await state.finishOne('r2');                            // let the single rerun end
  });

  it('the rerun a joiner queued gets a holder of its own, and a trigger that joins the rerun reads that one', async () => {
    const runner = createCoalescingRunner();
    const { job, state } = progressJob();
    const first = runner.join('net', job);
    const joinedFirst = runner.join('net', job);            // queues the rerun, reads the first cycle
    state.holders[0].finished = ['from-cycle-1'];
    await state.finishOne('r1');
    await first.promise;
    assert.equal(state.holders.length, 2, 'the queued rerun started once the first cycle ended');
    assert.notEqual(state.holders[1], state.holders[0], 'the rerun has a fresh holder, not the finished cycle\'s');
    assert.equal(state.holders[1].finished, undefined, 'the rerun starts with nothing finished');
    const joinedRerun = runner.join('net', job);            // arrives while the rerun runs
    assert.equal(joinedRerun.progress, state.holders[1], 'a trigger that arrives during the rerun reads the rerun\'s holder');
    assert.equal(joinedFirst.progress, state.holders[0], 'the trigger that joined the first cycle still reads the first cycle\'s holder after it ended');
    assert.deepEqual(joinedFirst.progress.finished, ['from-cycle-1']);
    state.holders[1].finished = ['from-cycle-2'];
    assert.deepEqual(joinedRerun.progress.finished, ['from-cycle-2']);
    await state.finishOne('r2');
    assert.equal(await joinedRerun.promise, 'r2');
    await state.finishOne('r3');                            // the rerun the joiner of the rerun queued
  });

  it('keys keep separate holders', async () => {
    const runner = createCoalescingRunner();
    const { job, state } = progressJob();
    const a = runner.join('net-a', job);
    const b = runner.join('net-b', job);
    assert.equal(state.holders.length, 2);
    assert.notEqual(a.progress, b.progress, 'two keys, two cycles, two holders');
    await state.finishOne();
    await state.finishOne();
    await Promise.all([a.promise, b.promise]);
  });

  it('a job that throws still releases the key, and the joiner sees the rejection', async () => {
    const runner = createCoalescingRunner();
    let calls = 0;
    const job = () => { calls++; return calls === 1 ? Promise.reject(new Error('cycle threw')) : Promise.resolve('ok'); };
    const handle = runner.join('net', job);
    await assert.rejects(() => handle.promise, /cycle threw/);
    assert.equal(runner.isRunning('net'), false);
    assert.equal(await runner.join('net', job).promise, 'ok', 'the key recovers');
  });

  it('run() is unchanged: a promise of the joined result, for the caller that has no use for progress', async () => {
    const runner = createCoalescingRunner();
    const { job, state } = progressJob();
    const p = runner.run('net', job);
    assert.equal(typeof p.then, 'function', 'run returns a promise');
    assert.equal(state.holders.length, 1, 'run starts the job too');
    await state.finishOne('plain');
    assert.equal(await p, 'plain');
  });
});
