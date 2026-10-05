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
import { eventually } from './_write-faults.mjs';

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

  it('a RERUN that rejects is logged by the runner and never an unhandled rejection (Q-361 item 11)', async () => {
    // Nothing awaits the rerun, so a job that throws on its second pass was an unhandled rejection, which ends the
    // process. The catch is the runner's, so every caller has it: a caller's own catch only ever sees the job it joined.
    const { log } = await import('../../server/dist/util/log.js');
    const runner = createCoalescingRunner();
    let starts = 0;
    const job = () => { starts++; return starts === 2 ? Promise.reject(new Error('the rerun failed')) : Promise.resolve('ok'); };
    const unhandled = [];
    const onUnhandled = (reason) => unhandled.push(reason);
    const warned = [];
    const warn = log.warn;
    log.warn = (...a) => { warned.push(a.join(' ')); };
    process.on('unhandledRejection', onUnhandled);
    try {
      const first = runner.run('net', job);
      void runner.run('net', job);                  // queues the rerun
      await first;
      // Wait for the event itself (the runner's own log line), then let the process drain a few ticks: an
      // unhandled rejection is reported after the microtask queue empties, so by then it has been or never will be.
      await eventually(() => warned.length > 0, 2000);
      await new Promise(r => setImmediate(r));
      await new Promise(r => setImmediate(r));
    } finally {
      process.off('unhandledRejection', onUnhandled);
      log.warn = warn;
    }
    assert.equal(starts, 2, 'the rerun never ran');
    assert.deepEqual(unhandled, [], 'a rerun that rejected escaped as an unhandled rejection');
    assert.ok(warned.some(l => /the rerun failed/.test(l)), `the failure was not logged: ${JSON.stringify(warned)}`);
    assert.equal(runner.isRunning('net'), false, 'a failed rerun left its key held');
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
