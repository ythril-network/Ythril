/**
 * `intervalJob` — the ONE owner of every repeating timer in `server/src` (`Q-317`, bundle-53 G9).
 *
 * ## The defect it prevents
 *
 * Fifteen bare `setInterval` timers, each answering the same five questions by hand, mostly wrongly: what if the previous tick is still
 * running (four of them overlapped, three skipped through `runExclusive`, the rest did neither), what if a tick throws (an unhandled
 * rejection, or an unthrottled line per tick), is a tick's database work bounded (none was), is a tick that never ends ever named
 * (none was: a hung tick under a skip guard is a job that is off, silently), and does the timer keep the process alive (some forgot
 * `unref`). It answers them once.
 *
 * ## What is pinned, in virtual time (`_virtual-time.mjs`; no real timer fires in this file except the one case that reads `hasRef`)
 *
 * start is idempotent and stop clears and nulls; a restart is `stop(); start()`; an overlapping tick is SKIPPED and COUNTED
 * (`tick-skipped`, which `ythril_interval_tick_skipped_total{job}` is built from); a throw is contained and said once per window; the
 * timer does not keep the process alive; a function-form interval is read at start and a later change does not move a running job;
 * the skip warning is throttled; a tick that has run longer than `max(3 x interval, housekeepingOpMs())` is named once per window with
 * the elapsed figure; every tick runs inside the housekeeping bound; the walks of ONE tick share one budget (K = 3 per tick); `armed`
 * reflects the state.
 *
 * Run: node --test testing/standalone/interval-job.test.js   (requires a prior build of server/)
 */
import { describe, it, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createVirtualTime, settle } from './_virtual-time.mjs';

let intervalJob, INTERVAL_JOB_WINDOW_MS, wb, createHousekeepingWalk, StoreTimeout, onHousekeepingSignal, declareJob, declaredJobs;

before(async () => {
  ({ intervalJob, INTERVAL_JOB_WINDOW_MS } = await import('../../server/dist/util/interval-job.js'));
  wb = await import('../../server/dist/db/write-bound.js');
  ({ createHousekeepingWalk } = await import('../../server/dist/util/housekeeping-walk.js'));
  ({ StoreTimeout } = await import('../../server/dist/db/write-timeout.js'));
  ({ onHousekeepingSignal, declareJob, declaredJobs } = await import('../../server/dist/util/housekeeping-signals.js'));
});
after(() => wb?.setWriteBoundForTest(null));

const gate = () => { let release; const p = new Promise(r => { release = r; }); return { p, release }; };

/**
 * `arm` / `disarm` over the virtual clock: an interval is a timer that re-arms itself, and its handle answers `unref` / `hasRef` the
 * way a Node one does, across the re-arms, so `refedTimers()` reads what a real event loop would stay alive for.
 */
function virtualInterval(vt) {
  const live = [];
  const arm = (fn, ms) => {
    const handle = { ms, dead: false, refed: true, timer: null, unref() { handle.refed = false; handle.timer?.unref(); return handle; } };
    const schedule = () => {
      handle.timer = vt.setTimer(() => { if (handle.dead) return; schedule(); fn(); }, ms);
      if (!handle.refed) handle.timer.unref();
    };
    schedule();
    live.push(handle);
    return handle;
  };
  const disarm = (handle) => { handle.dead = true; vt.clearTimer(handle.timer); };
  return { arm, disarm, armed: () => live.filter(h => !h.dead).length, made: () => live.length };
}

/** A job over a virtual clock, with every line and every skip signal it raises captured. */
function rig({ every = 1000, run, label = 'Test job' } = {}) {
  const vt = createVirtualTime();
  const timers = virtualInterval(vt);
  const lines = { warn: [], error: [] };
  const skipped = [];
  const off = onHousekeepingSignal((e) => { if (e.type === 'tick-skipped' && e.job === label) skipped.push(e); });
  const calls = { n: 0 };
  const job = intervalJob(label, every, async () => { calls.n++; return run?.(calls.n); }, {
    now: vt.now, arm: timers.arm, disarm: timers.disarm,
    warn: (m) => lines.warn.push(m), error: (m) => lines.error.push(m),
  });
  return { vt, timers, lines, skipped, calls, job, off };
}

const jobs = [];
const track = (r) => { jobs.push(r); return r; };
afterEach(() => { for (const r of jobs.splice(0)) { r.job.stop(); r.off(); } });

describe('start and stop', () => {
  it('start is idempotent: a second start arms nothing and the job ticks once per interval', async () => {
    const r = track(rig());
    r.job.start(); r.job.start(); r.job.start();
    assert.equal(r.timers.made(), 1);
    assert.equal(r.vt.pendingTimers(), 1);
    await r.vt.advance(3000);
    assert.equal(r.calls.n, 3);
  });

  it('does not run at start: the first tick is one interval later', async () => {
    const r = track(rig());
    r.job.start();
    await settle();
    assert.equal(r.calls.n, 0);
    await r.vt.advance(999);
    assert.equal(r.calls.n, 0);
    await r.vt.advance(1);
    assert.equal(r.calls.n, 1);
  });

  it('stop clears the timer and nulls it, and is idempotent', async () => {
    const r = track(rig());
    r.job.start();
    r.job.stop();
    assert.equal(r.vt.pendingTimers(), 0, 'no timer is left');
    assert.equal(r.job.armed, false);
    r.job.stop();
    await r.vt.advance(10_000);
    assert.equal(r.calls.n, 0, 'a stopped job does not tick');
  });

  it('stop before start is a no-op', () => {
    const r = track(rig());
    assert.doesNotThrow(() => r.job.stop());
    assert.equal(r.job.armed, false);
  });

  it('restart is stop(); start(): ticks resume and the phase begins again', async () => {
    const r = track(rig());
    r.job.start();
    await r.vt.advance(1500);
    assert.equal(r.calls.n, 1);
    r.job.stop();
    r.job.start();
    assert.equal(r.job.armed, true);
    assert.equal(r.timers.armed(), 1, 'one live timer, not two');
    await r.vt.advance(999);
    assert.equal(r.calls.n, 1, 'a full interval after the restart, not the 500 ms the old phase had left');
    await r.vt.advance(1);
    assert.equal(r.calls.n, 2);
  });

  it('`armed` reflects the state: false, true after start, false after stop', () => {
    const r = track(rig());
    assert.equal(r.job.armed, false);
    r.job.start();
    assert.equal(r.job.armed, true);
    r.job.stop();
    assert.equal(r.job.armed, false);
  });

  it('refuses an interval that is not a finite positive number, where it is seen', () => {
    for (const bad of [0, -5, NaN, Infinity]) {
      assert.throws(() => intervalJob('Bad', bad, async () => {}).start(), /interval/i, `every = ${bad}`);
    }
    assert.throws(() => intervalJob('Bad', () => 0, async () => {}).start(), /interval/i, 'the function form is read at start and refused there');
  });
});

describe('the timer does not keep the process alive', () => {
  it('the handle is unref\'d: no ref\'d timer is waiting', () => {
    const r = track(rig());
    r.job.start();
    assert.equal(r.vt.pendingTimers(), 1);
    assert.equal(r.vt.refedTimers(), 0, 'hasRef() is false');
  });

  it('and with the real timer: starting a job adds no ref\'d Timeout to the event loop', () => {
    const count = () => process.getActiveResourcesInfo().filter(x => x === 'Timeout').length;
    const before = count();
    const job = intervalJob('Real timer job', 3_600_000, async () => {});
    job.start();
    try {
      assert.equal(job.armed, true);
      assert.equal(count(), before, 'an unref\'d timer is not an active resource');
    } finally { job.stop(); }
    assert.equal(job.armed, false);
  });
});

describe('an overlapping tick is skipped and counted', () => {
  it('while a tick is running the next ones do not run, each is counted as skipped for THIS job, and the next one after it ends runs', async () => {
    const held = gate();
    const r = track(rig({ run: (n) => (n === 1 ? held.p : undefined) }));
    r.job.start();
    await r.vt.advance(4000);
    assert.equal(r.calls.n, 1, 'one tick started and three were skipped');
    assert.equal(r.skipped.length, 3);
    assert.ok(r.skipped.every(e => e.job === 'Test job'));
    held.release();
    await r.vt.advance(1000);
    assert.equal(r.calls.n, 2, 'the lock was released');
    assert.equal(r.skipped.length, 3);
  });

  it('a stop while a tick runs lets it finish, and a restart then still skips against it', async () => {
    const held = gate();
    const r = track(rig({ run: (n) => (n === 1 ? held.p : undefined) }));
    r.job.start();
    await r.vt.advance(1000);
    r.job.stop();
    r.job.start();
    await r.vt.advance(1000);
    assert.equal(r.calls.n, 1, 'the tick the old timer started is still the one in flight');
    assert.equal(r.skipped.length, 1);
    held.release();
  });
});

describe('a throw is contained and said once per window', () => {
  it('never rejects into the timer: the next tick runs, and the failure is one line, "<label> failed:", for the window', async () => {
    const r = track(rig({ run: () => { throw new Error('boom'); } }));
    r.job.start();
    await r.vt.advance(5000);
    assert.equal(r.calls.n, 5, 'a throw does not stop the job');
    assert.equal(r.lines.error.length, 1, JSON.stringify(r.lines.error));
    assert.match(r.lines.error[0], /^Test job failed: .*boom/);
  });

  it('is said again once the window has passed', async () => {
    const r = track(rig({ every: 60_000, run: () => { throw new Error('boom'); } }));
    r.job.start();
    await r.vt.advance(INTERVAL_JOB_WINDOW_MS - 60_000);
    assert.equal(r.lines.error.length, 1);
    await r.vt.advance(2 * 60_000);
    assert.equal(r.lines.error.length, 2);
  });

  it('a synchronous throw and a rejected promise are the same case', async () => {
    const r = track(rig({ run: (n) => (n === 1 ? Promise.reject(new Error('rejected')) : undefined) }));
    r.job.start();
    await r.vt.advance(2000);
    assert.equal(r.calls.n, 2);
    assert.match(r.lines.error[0], /rejected/);
  });

  it('two jobs do not silence each other: the throttle is per job', async () => {
    const a = track(rig({ label: 'Job A', run: () => { throw new Error('a'); } }));
    const b = track(rig({ label: 'Job B', run: () => { throw new Error('b'); } }));
    a.job.start(); b.job.start();
    await a.vt.advance(1000); await b.vt.advance(1000);
    assert.equal(a.lines.error.length, 1);
    assert.equal(b.lines.error.length, 1);
  });
});

describe('the interval is read at start', () => {
  it('the function form is called at start, and a later change does not move a running job', async () => {
    let every = 1000;
    let reads = 0;
    const vt = createVirtualTime();
    const timers = virtualInterval(vt);
    let calls = 0;
    const job = intervalJob('Fn form', () => { reads++; return every; }, async () => { calls++; },
      { now: vt.now, arm: timers.arm, disarm: timers.disarm, warn: () => {}, error: () => {} });
    assert.equal(reads, 0, 'not read at construction');
    job.start();
    assert.equal(reads, 1);
    every = 5000;
    await vt.advance(3000);
    assert.equal(calls, 3, 'the running job keeps the interval it started with');
    assert.equal(reads, 1, 'and does not read the function again');
    job.stop(); job.start();
    assert.equal(reads, 2);
    await vt.advance(4999);
    assert.equal(calls, 3);
    await vt.advance(1);
    assert.equal(calls, 4, 'a restart takes the new figure');
    job.stop();
  });
});

describe('the skip warning is throttled', () => {
  it('twenty skipped ticks say it once, and again after the window', async () => {
    const held = gate();
    const r = track(rig({ run: (n) => (n === 1 ? held.p : undefined) }));
    r.job.start();
    await r.vt.advance(21_000);
    assert.equal(r.skipped.length, 20, 'every skip is COUNTED');
    const skips = r.lines.warn.filter(l => /skipping this tick/.test(l));
    assert.equal(skips.length, 1, 'and said once');
    assert.match(skips[0], /^Test job: skipping this tick/);
    await r.vt.advance(INTERVAL_JOB_WINDOW_MS);
    assert.equal(r.lines.warn.filter(l => /skipping this tick/.test(l)).length, 2);
    held.release();
  });
});

describe('a tick that has run too long is named', () => {
  after(() => wb.setWriteBoundForTest(null));
  const overruns = (r) => r.lines.warn.filter(l => /tick running for/.test(l));

  it('after max(3 x interval, housekeepingOpMs()), once per window, with the elapsed figure', async () => {
    wb.setWriteBoundForTest({ housekeepingOpMs: 5000 });
    const held = gate();
    const r = track(rig({ every: 1000, run: (n) => (n === 1 ? held.p : undefined) }));
    r.job.start();
    await r.vt.advance(6000);    // the tick began at 1 s: at 6 s it has run 5 s, which is not MORE than 5 s
    assert.equal(overruns(r).length, 0);
    await r.vt.advance(1000);    // 7 s: it has run 6 s
    assert.equal(overruns(r).length, 1);
    assert.match(overruns(r)[0], /^Test job tick running for 6s\b/);
    await r.vt.advance(30_000);
    assert.equal(overruns(r).length, 1, 'once for the window, not once per skipped tick');
    await r.vt.advance(INTERVAL_JOB_WINDOW_MS);
    assert.equal(overruns(r).length, 2);
    const seconds = Number(/running for (\d+)s/.exec(overruns(r)[1])[1]);
    assert.ok(seconds >= INTERVAL_JOB_WINDOW_MS / 1000, `the second report carries the NEW elapsed figure, got ${seconds}s`);
    held.release();
  });

  it('the floor is three intervals when the interval is long, and the housekeeping figure when that is larger', async () => {
    wb.setWriteBoundForTest({ housekeepingOpMs: 1000 });
    const long = gate();
    const a = track(rig({ every: 60_000, run: (n) => (n === 1 ? long.p : undefined) }));
    a.job.start();
    await a.vt.advance(60_000 + 3 * 60_000);   // started at 60 s; at 240 s it has run 180 s = 3 intervals, not more
    assert.equal(overruns(a).length, 0);
    await a.vt.advance(60_000);
    assert.equal(overruns(a).length, 1);
    long.release();

    wb.setWriteBoundForTest({ housekeepingOpMs: 240_000 });
    const held = gate();
    const b = track(rig({ every: 1000, run: (n) => (n === 1 ? held.p : undefined) }));
    b.job.start();
    await b.vt.advance(200_000);
    assert.equal(overruns(b).length, 0, 'a tick can legitimately use the whole housekeeping bound per operation');
    await b.vt.advance(60_000);
    assert.equal(overruns(b).length, 1);
    held.release();
  });

  it('a tick that finishes is never reported, however many were skipped behind it', async () => {
    wb.setWriteBoundForTest({ housekeepingOpMs: 1000 });
    const held = gate();
    const r = track(rig({ every: 1000, run: (n) => (n === 1 ? held.p : undefined) }));
    r.job.start();
    await r.vt.advance(2500);
    held.release();
    await r.vt.advance(60_000);
    assert.equal(overruns(r).length, 0);
  });
});

describe('every tick runs inside the housekeeping bound and shares one walk budget', () => {
  after(() => wb.setWriteBoundForTest(null));

  it('a database call made by a tick carries the housekeeping figure, and nothing outside the tick does', async () => {
    wb.setWriteBoundForTest({ housekeepingOpMs: 4321 });
    let seen;
    const r = track(rig({
      run: async () => {
        await wb.callBounded('find', [{}, {}], (args) => { seen = args[1]; return Promise.resolve([]); }, { collection: 'a_facts', inheritedTimeoutMs: undefined });
      },
    }));
    r.job.start();
    await r.vt.advance(1000);
    assert.equal(seen?.timeoutMS, 4321);
    let outside;
    await wb.callBounded('find', [{}, {}], (args) => { outside = args[1]; return Promise.resolve([]); }, { collection: 'a_facts', inheritedTimeoutMs: undefined });
    assert.equal(outside.timeoutMS, undefined);
  });

  /** A walk of its own, so no quarantine is shared with the process-wide one. */
  const timesOut = (spaces) => {
    const walk = createHousekeepingWalk({ now: () => 1, storeAnswers: async () => true, reporter: { spaceFailure() {}, storeDown() {}, storeStalled() {}, recovered() {} } });
    return walk.eachSpace('Budget step', spaces, async () => { throw new StoreTimeout(); });
  };

  it('two walks in one tick share ONE budget: the third distinct space to time out, in the second walk, stops it as stalled', async () => {
    const results = [];
    const r = track(rig({
      run: async () => {
        results.push(await timesOut(['a', 'b']));
        results.push(await timesOut(['c', 'd']));
      },
    }));
    r.job.start();
    await r.vt.advance(1000);
    assert.equal(results.length, 2);
    assert.equal(results[0].stalled, undefined);
    assert.equal(results[1].stalled, true, 'K = 3 counted across the two walks');
    assert.deepEqual(results[1].outcomes.map(o => o.spaceId), ['c'], 'and the walk stopped at the space that tripped it');
  });

  it('the next tick starts with a fresh budget', async () => {
    const results = [];
    const r = track(rig({ run: async () => { results.push(await timesOut(['a', 'b'])); } }));
    r.job.start();
    await r.vt.advance(3000);
    assert.equal(results.length, 3);
    assert.ok(results.every(x => x.stalled === undefined), 'two timeouts a tick never reach K = 3');
  });
});

describe('a job names itself at construction, so its skipped-tick series can start at 0', () => {
  /** Every `job-declared` event for `label` while `fn` runs. */
  const declaredDuring = (label, fn) => {
    const seen = [];
    const off = onHousekeepingSignal((e) => { if (e.type === 'job-declared' && e.job === label) seen.push(e.job); });
    try { fn(); } finally { off(); }
    return seen;
  };
  const make = (label) => intervalJob(label, 1000, async () => {});

  it('constructing a job declares its label once: it is in declaredJobs() and the event fires once, before any tick or start', () => {
    const label = 'Declared at construction';
    assert.equal(declaredJobs().includes(label), false);
    const seen = declaredDuring(label, () => { make(label); });
    assert.deepEqual(seen, [label]);
    assert.equal(declaredJobs().filter(j => j === label).length, 1);
  });

  it('a second job with the same label, and start() of either, declare nothing more', () => {
    const label = 'Declared twice';
    make(label);
    const seen = declaredDuring(label, () => { const again = make(label); again.start(); again.stop(); });
    assert.deepEqual(seen, []);
    assert.equal(declaredJobs().filter(j => j === label).length, 1);
  });

  it('declareJob is idempotent and returns the name; declaredJobs is a copy; an empty name throws', () => {
    assert.equal(declareJob('Declared by hand'), 'Declared by hand');
    assert.deepEqual(declaredDuring('Declared by hand', () => declareJob('Declared by hand')), []);
    declaredJobs().push('not a job');
    assert.equal(declaredJobs().includes('not a job'), false);
    for (const bad of ['', '   ', undefined, 7]) assert.throws(() => declareJob(bad), /needs a name/, `name = ${String(bad)}`);
  });

  it('a listener that throws does not stop the declaration', () => {
    const off = onHousekeepingSignal(() => { throw new Error('registry mid-reset'); });
    try { assert.doesNotThrow(() => make('Declared past a failing listener')); } finally { off(); }
    assert.ok(declaredJobs().includes('Declared past a failing listener'));
  });
});
