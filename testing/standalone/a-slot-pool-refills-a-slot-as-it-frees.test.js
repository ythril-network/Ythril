/**
 * A worker slot is refilled the moment it frees, not at the end of a batch (`Q-114`).
 *
 * The media worker claimed up to `workerConcurrency` jobs, then awaited ALL of them before claiming again. One
 * 30-minute document conversion beside one 2-second image therefore left the second slot idle for 28 minutes
 * with a queue behind it. `runSlotPool` is the supervisor that replaces the batch: one claimer, capacity re-read
 * on every pass, a slot refilled as it frees.
 *
 * ## The contract these cases hold (PLANNED module `server/dist/files/media/slot-pool.js`)
 *
 *     runSlotPool({ limits, claim, onClaimed, run, release, sampleEpoch, waitForWork, isRunning })
 *         -> { drained: Promise<void> }
 *
 * - `limits()` -> `{ concurrency, pollMs, maxPollMs }`, re-read on every pass (the field names are this test's
 *   assumption of the plan; the implementation may adapt the harness, not the rules);
 * - `claim()` -> a job or null; one claim in flight at a time;
 * - `onClaimed(job)` runs on the claim's own resolution, with no await between (worker.ts records the claim in
 *   `_heldJobs` there, so a shutdown that runs a tick later can hand it back);
 * - `waitForWork(ms, epoch)` -> Promise<boolean>, the interruptible sleep; `epoch` comes from `sampleEpoch()`
 *   taken BEFORE the claim it guards;
 * - `release(job)` hands a claim back; `isRunning()` false means stop; `drained` settles when nothing is running.
 *
 * ## Determinism
 *
 * No sleeps and no timers. Every claim, run and wait is a promise the test holds and settles by hand, and the
 * only clock is a macrotask flush (`setImmediate`), which is the yield the pool is itself required to make.
 *
 * Run: npm run build -w server && node --test testing/standalone/a-slot-pool-refills-a-slot-as-it-frees.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const mod = await import('../../server/dist/files/media/slot-pool.js');
const { runSlotPool } = mod;

const flush = () => new Promise(r => setImmediate(r));
/** Flush macrotasks until `cond()` holds; fails by assertion, never by hanging. */
async function until(cond, what) {
  for (let i = 0; i < 200; i++) { if (cond()) return; await flush(); }
  assert.fail(`never reached: ${what}`);
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/**
 * A pool over a hand-settled world. `queue` is the jobs still to claim (a job is `{ id }`), and
 * `claimMode` can be switched to `'hold'` (claim stays pending until the test settles it) or `'throw'`.
 */
function world({ concurrency = 2, pollMs = 1_000, maxPollMs = 30_000, jobs = [], claimMode = 'queue', infinite = null } = {}) {
  const w = {
    limits: { concurrency, pollMs, maxPollMs },
    queue: [...jobs],
    claimMode,
    running: true,
    claims: [],        // { resolve, reject } for held claims
    claimCalls: 0,
    claimsInFlight: 0, maxClaimsInFlight: 0,
    started: [], finished: [], released: [], onClaimedCalls: [],
    active: new Set(), maxActive: 0,
    runs: new Map(),   // job id -> deferred
    waits: [],         // { ms, epoch, resolve }
    waitsResolved: 0,
    epoch: 0, epochsSampled: [],
    stopEpoch: -1,     // a wake() raises the epoch: a wait begun with an older one returns at once
  };
  const settleClaim = v => { w.claimsInFlight--; return v; };
  w.pool = runSlotPool({
    limits: () => w.limits,
    claim: () => {
      w.claimCalls++;
      w.claimsInFlight++;
      w.maxClaimsInFlight = Math.max(w.maxClaimsInFlight, w.claimsInFlight);
      if (w.claimMode === 'throw') return Promise.reject(new Error('mongo went away')).finally(() => w.claimsInFlight--);
      if (w.claimMode === 'hold') {
        const d = deferred();
        w.claims.push(d);
        return d.promise.then(settleClaim, e => { w.claimsInFlight--; throw e; });
      }
      const next = infinite ? infinite() : (w.queue.shift() ?? null);
      return Promise.resolve(next).then(settleClaim);
    },
    onClaimed: job => { w.onClaimedCalls.push(job.id); },
    run: job => {
      w.started.push(job.id);
      w.active.add(job.id);
      w.maxActive = Math.max(w.maxActive, w.active.size);
      const d = deferred();
      w.runs.set(job.id, d);
      return d.promise.finally(() => { w.active.delete(job.id); w.finished.push(job.id); });
    },
    release: job => { w.released.push(job.id); return Promise.resolve(); },
    sampleEpoch: () => { w.epochsSampled.push(++w.epoch); return w.epoch; },
    waitForWork: (ms, epoch) => {
      const d = deferred();
      if (epoch <= w.stopEpoch) { w.waits.push({ ms, epoch, resolve() {} }); return Promise.resolve(true); }
      w.waits.push({ ms, epoch, resolve: v => { w.waitsResolved++; d.resolve(v); } });
      return d.promise;
    },
    isRunning: () => w.running,
  });
  w.finish = id => w.runs.get(id).resolve();
  w.fail = id => w.runs.get(id).reject(new Error(`job ${id} failed`));
  w.wakeAll = v => { for (const x of w.waits.splice(0)) x.resolve(v); };
  w.stop = async () => { w.running = false; w.stopEpoch = w.epoch; w.wakeAll(true); };
  return w;
}

describe('the planned module exists', () => {
  it('exports runSlotPool and it returns { drained }', () => {
    assert.equal(typeof runSlotPool, 'function', 'server/src/files/media/slot-pool.ts exports runSlotPool');
  });
});

describe('a slot is refilled as it frees', () => {
  it('a long job does not hold the other slot', async () => {
    const w = world({ concurrency: 2, jobs: [{ id: 'long' }, { id: 'b' }, { id: 'c' }] });
    await until(() => w.started.length === 2, 'two slots filled');
    assert.deepEqual(w.started, ['long', 'b'], 'claims are served in order');
    assert.equal(w.waitsResolved, 0, 'a non-empty claim is followed by another claim, never by a sleep');
    w.finish('b');
    await until(() => w.started.includes('c'), 'c takes the slot b freed while long is still running');
    assert.ok(w.active.has('long'), 'the long job is still running when c starts');
    assert.equal(w.waitsResolved, 0, 'refilling did not wait for the poll interval');
    w.finish('long'); w.finish('c');
    await w.stop();
    await w.pool.drained;
  });

  it('the concurrency cap is never exceeded, and every job runs', async () => {
    const ids = ['j1', 'j2', 'j3', 'j4', 'j5', 'j6'];
    const w = world({ concurrency: 2, jobs: ids.map(id => ({ id })) });
    // settle in an order that is not start order
    await until(() => w.started.length === 2, 'first two');
    for (const id of ['j2', 'j1', 'j3', 'j4', 'j6', 'j5']) {
      await until(() => w.runs.has(id), `${id} started`);
      w.finish(id);
      await flush();
    }
    await until(() => w.finished.length === ids.length, 'all six finished');
    assert.ok(w.maxActive <= 2, `${w.maxActive} ran at once with a limit of 2`);
    assert.equal(w.maxActive, 2, 'and the two slots were both used');
    assert.deepEqual([...w.started].sort(), [...ids].sort());
    await w.stop();
    await w.pool.drained;
  });

  it('claims stay serial: a second claim is not started while one is pending', async () => {
    const w = world({ concurrency: 3, claimMode: 'hold' });
    await until(() => w.claims.length >= 1, 'first claim made');
    await flush(); await flush();
    assert.equal(w.claimCalls, 1, 'three free slots still make ONE claim at a time');
    w.claims[0].resolve({ id: 'a' });
    await until(() => w.claimCalls === 2, 'the next claim follows the first');
    assert.equal(w.maxClaimsInFlight, 1);
    await w.stop();
    w.claims[1].resolve(null);
    w.finish('a');
    await w.pool.drained;
  });
});

describe('the limit is read on every pass', () => {
  it('a raised limit starts a slot within one poll interval while every slot is busy', async () => {
    const w = world({ concurrency: 2, pollMs: 1_000, jobs: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] });
    await until(() => w.started.length === 2, 'both slots busy');
    await until(() => w.waits.length >= 1, 'the pool is parked waiting (for a slot, the signal or the poll)');
    // What parks it must be bounded by the poll interval, or a raised limit waits for a job that may take half an hour.
    for (const x of w.waits) assert.ok(x.ms <= 1_000, `parked for ${x.ms} ms with a poll interval of 1000`);
    assert.equal(w.started.includes('c'), false, 'the limit is still 2');
    w.limits = { ...w.limits, concurrency: 3 };
    w.wakeAll(false); // the poll interval elapsing, nothing else happening: no job finished, no work announced
    await until(() => w.started.includes('c'), 'c started on the raised limit with both slots still busy');
    assert.ok(w.active.has('a') && w.active.has('b'));
    assert.equal(w.maxActive, 3);
    for (const id of ['a', 'b', 'c']) w.finish(id);
    await w.stop();
    await w.pool.drained;
  });

  it('a lowered limit stops refilling until the running count falls below it', async () => {
    const w = world({ concurrency: 3, jobs: ['a', 'b', 'c', 'd', 'e'].map(id => ({ id })) });
    await until(() => w.started.length === 3, 'three running');
    w.limits = { ...w.limits, concurrency: 1 };
    w.finish('a');
    await flush(); await flush(); w.wakeAll(false); await flush();
    assert.equal(w.started.length, 3, 'two running against a limit of 1: nothing refills');
    w.finish('b');
    await flush(); await flush(); w.wakeAll(false); await flush();
    assert.equal(w.started.length, 3, 'one running against a limit of 1: nothing refills');
    w.finish('c');
    await until(() => w.started.length === 4, 'the last slot freed, so one job starts');
    assert.equal(w.started[3], 'd');
    await flush(); await flush();
    assert.equal(w.started.length, 4, 'and only one');
    w.finish('d');
    await until(() => w.started.length === 5, 'e');
    w.finish('e');
    await w.stop();
    await w.pool.drained;
  });

  it('the epoch is sampled fresh for each claim, not once per pool', async () => {
    const w = world({ concurrency: 1, jobs: [] });
    await until(() => w.waits.length === 1, 'an empty queue parks the pool');
    const first = w.waits[0].epoch;
    w.wakeAll(false);
    await until(() => w.waits.length === 1, 'parked again');
    assert.notEqual(w.waits[0].epoch, first, 'the same epoch twice means a job announced between them is missed');
    assert.ok(w.epochsSampled.length >= 2);
    await w.stop();
    await w.pool.drained;
  });
});

describe('stopping', () => {
  it('a job claimed before stop runs to the end, and is not released', async () => {
    const w = world({ concurrency: 1, jobs: [{ id: 'a' }, { id: 'b' }] });
    await until(() => w.started.includes('a'), 'a running');
    await w.stop();
    await flush(); await flush();
    let drained = false;
    w.pool.drained.then(() => { drained = true; });
    await flush(); await flush();
    assert.equal(drained, false, 'drained waits for the job that was claimed before stop');
    assert.deepEqual(w.released, [], 'a claim that was run is never handed back');
    assert.deepEqual(w.started, ['a'], 'nothing new starts after stop');
    w.finish('a');
    await w.pool.drained;
    assert.deepEqual(w.finished, ['a']);
  });

  it('a job whose claim resolves after stop is released, not run', async () => {
    const w = world({ concurrency: 1, claimMode: 'hold' });
    await until(() => w.claims.length === 1, 'a claim is pending');
    await w.stop();
    w.claims[0].resolve({ id: 'late' });
    await w.pool.drained;
    assert.deepEqual(w.released, ['late'], 'the late claim is handed back through release');
    assert.deepEqual(w.started, [], 'and never run');
  });
});

describe('a claim that throws', () => {
  it('counts as nothing found: the pool waits, and carries on', async () => {
    const w = world({ concurrency: 1, claimMode: 'throw' });
    await until(() => w.waits.length >= 1, 'waitForWork called after the failed claim');
    assert.ok(w.waits[0].ms > 0 && w.waits[0].ms <= 30_000, `waited ${w.waits[0].ms} ms`);
    assert.deepEqual(w.started, [], 'nothing runs from a failed claim');
    w.claimMode = 'queue';
    w.queue.push({ id: 'after' });
    w.wakeAll(false);
    await until(() => w.started.includes('after'), 'the pool recovered and claimed the next job');
    w.finish('after');
    await w.stop();
    await w.pool.drained;
  });
});

describe('a job that always fails', () => {
  it('yields the event loop instead of spinning on the next claim', async () => {
    let calls = 0;
    let immediateFiredAtCall = null;
    setImmediate(() => { immediateFiredAtCall = calls; });
    let stopAfter = 5_000;
    let failures = 0;
    const pool = runSlotPool({
      limits: () => ({ concurrency: 1, pollMs: 1_000, maxPollMs: 30_000 }),
      claim: () => Promise.resolve({ id: `f${++calls}` }),
      onClaimed: () => {},
      run: () => { failures++; return Promise.reject(new Error('always fails')); },
      release: () => Promise.resolve(),
      sampleEpoch: () => 0,
      waitForWork: () => Promise.resolve(false),
      isRunning: () => stopAfter-- > 0,
    });
    await pool.drained;
    assert.ok(failures > 0, 'the always-failing job ran');
    assert.notEqual(immediateFiredAtCall, null, 'a macrotask never got a turn: the loop starved the event loop');
    assert.ok(immediateFiredAtCall < 5_000, `the loop made ${immediateFiredAtCall} passes before yielding a macrotask`);
  });
});

describe('the claim and the holder agree', () => {
  it('onClaimed runs on the claim\'s own resolution, before any later microtask', async () => {
    const order = [];
    const d = deferred();
    let running = true;
    const pool = runSlotPool({
      limits: () => ({ concurrency: 1, pollMs: 1_000, maxPollMs: 30_000 }),
      claim: () => d.promise,
      onClaimed: job => { order.push(`onClaimed:${job.id}`); },
      run: job => { order.push(`run:${job.id}`); return Promise.resolve(); },
      release: () => Promise.resolve(),
      sampleEpoch: () => 0,
      waitForWork: () => new Promise(() => {}),
      isRunning: () => running,
    });
    await flush();
    // The claim resolves, and in the same tick a microtask is queued BEHIND the pool's own reaction to it. A
    // shutdown that reads the held set a tick later must already see the job, so onClaimed cannot have awaited
    // anything since the resolution.
    d.resolve({ id: 'j' });
    queueMicrotask(() => order.push('later-microtask'));
    await until(() => order.includes('later-microtask') && order.includes('run:j'), 'both happened');
    assert.ok(order.indexOf('onClaimed:j') > -1 && order.indexOf('onClaimed:j') < order.indexOf('later-microtask'),
      `onClaimed ran after an await: ${JSON.stringify(order)}`);
    assert.ok(order.indexOf('onClaimed:j') < order.indexOf('run:j'), 'the claim is recorded before the job runs');
    running = false;
    void pool;
  });
});
