/**
 * A search service that comes up late is found, for the life of the process (Q-113) — offline, in virtual time.
 *
 * ## The failure this prevents
 *
 * `searchAvailable()` used to wait 6 x 2 s ONCE per process and cache its answer, FALSE included. A mongot that
 * lost the race with the app by thirteen seconds left semantic recall empty until somebody restarted the
 * process or pressed the rebuild button, with one warn line as the only trace. Every rule below is a part of the
 * replacement, `spaces/search-readiness.ts`: a state (`unknown | up | down | absent`), a watcher for `down`, and
 * a list of things waiting for `up`.
 *
 * ## What is pinned, and why each is its own case
 *
 *  - the cold-start window runs ONCE and is single-flight, or a boot pays it per collection per space;
 *  - a probe that HANGS counts as a failed probe — mongot up but wedged is the same outage as mongot absent;
 *  - callers never probe while down (they read the state), only the watcher does;
 *  - the watcher's delay reaches its cap and STAYS there for hours, and its re-arm cannot be skipped by a probe
 *    that throws synchronously;
 *  - `absent` (a mongod with no mongot at all) needs three CONSECUTIVE matches of a listSearchIndexes refusal,
 *    because a transient match that parked recovery for an hour would be the original defect again;
 *  - waiters are keyed (a second registration replaces the first), one that throws does not stop the next, and
 *    they run three at a time so a mongot that has just started is not stampeded;
 *  - every NEW log line carries the error class and code, never the message or a URI.
 *
 * Injected probe, clock, scheduler and sleep: no real timer is created, so hours of backoff take milliseconds.
 *
 * Run: node --test testing/standalone/a-late-search-service-is-retried.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { createVirtualTime, captureLog, settle } from './_virtual-time.mjs';

const HOUR = 3_600_000;
const MIN = 60_000;

let createSearchReadiness;
before(async () => { ({ createSearchReadiness } = await import('../../server/dist/spaces/search-readiness.js')); });

/** The refusal a mongod WITHOUT mongot gives `listSearchIndexes` (code 31082, SearchNotEnabled). */
const noMongotError = () => Object.assign(
  new Error('Using Atlas Search Database Commands and the $listSearchIndexes aggregation stage requires additional '
    + 'configuration. Please connect to Atlas or an AtlasCLI local deployment to enable.'),
  { name: 'MongoServerError', code: 31082, codeName: 'SearchNotEnabled' });
const refusedError = () => Object.assign(new Error('connect ECONNREFUSED 10.0.0.5:27027'),
  { name: 'MongoNetworkError', code: 'ECONNREFUSED' });

/**
 * A readiness object over virtual time, with a probe the test steers.
 * `probe` is whatever `behaviour()` says right now: return a value to succeed, throw to fail, or return a
 * never-resolving promise to hang.
 */
function build(behaviour) {
  const vt = createVirtualTime();
  const cap = captureLog();
  const state = { behaviour, calls: 0, callTimes: [] };
  const probe = () => { state.calls++; state.callTimes.push(vt.now()); return state.behaviour(state.calls); };
  const r = createSearchReadiness({ probe, sleep: vt.sleep, now: vt.now, scheduler: vt.scheduler, log: cap.log });
  return { r, vt, cap, state };
}
const ok = () => [];
const failing = (mk = refusedError) => () => { throw mk(); };
const hang = () => new Promise(() => {});

/** Drive a fresh readiness through its cold-start window into `down`. */
async function intoDown(b) {
  const first = await b.vt.drive(b.r.searchAvailable());
  assert.equal(first, false, 'fixture check: the probe fails throughout, so the window must end unavailable');
  return first;
}

describe('the cold-start window', () => {
  it('is 6 attempts 2 s apart, run once per process however many callers ask at once', async () => {
    const b = build(failing());
    const answers = await b.vt.drive(Promise.all([b.r.searchAvailable(), b.r.searchAvailable(), b.r.searchAvailable()]));
    assert.deepEqual(answers, [false, false, false]);
    assert.equal(b.state.calls, 6, 'concurrent callers must share ONE window — a boot pays it once, not per collection');
    assert.equal(b.vt.slept.filter(ms => ms === 2_000).length, 5, 'five 2 s waits between six attempts, none after the last');
    assert.equal(b.r.snapshot().state, 'down');
  });

  it('a healthy database answers at once with no wait', async () => {
    const b = build(ok);
    assert.equal(await b.vt.drive(b.r.searchAvailable()), true);
    assert.equal(b.state.calls, 1);
    assert.deepEqual(b.vt.slept, []);
    assert.equal(b.r.snapshot().state, 'up');
  });

  it('never runs again: the window is not repeated when the watcher later finds search still down', async () => {
    const b = build(failing());
    await intoDown(b);
    await b.vt.advance(3 * HOUR);
    assert.equal(b.vt.slept.filter(ms => ms === 2_000).length, 5, 'a second cold window started');
  });

  it('a probe that HANGS counts as a failed probe, so the window still ends', async () => {
    // mongot up but wedged is the same outage as mongot absent, and a hung listSearchIndexes awaited for ever
    // would pin every caller (boot included) behind it.
    const b = build(hang);
    assert.equal(await b.vt.drive(b.r.searchAvailable(), { limitMs: 5 * MIN }), false);
    assert.equal(b.r.snapshot().state, 'down');
    assert.equal(b.state.calls, 6, 'each hung attempt must time out and let the next begin');
  });

  it('a hung probe later in the watcher is a failed probe too, and does not stop the watcher', async () => {
    const b = build(failing());
    await intoDown(b);
    b.state.behaviour = hang;
    await b.vt.advance(30 * MIN);
    const callsWhileHung = b.state.calls;
    assert.ok(callsWhileHung > 6 + 2, `the watcher stopped after a hung probe (${callsWhileHung} calls)`);
    b.state.behaviour = ok;
    await b.vt.advance(10 * MIN);
    assert.equal(b.r.snapshot().state, 'up', 'and it must still notice the service when it answers');
  });
});

describe('down: callers read, the watcher probes', () => {
  it('callers never probe while down, and get their answer without waiting', async () => {
    const b = build(failing());
    await intoDown(b);
    const before = b.state.calls;
    const pending = Array.from({ length: 50 }, () => b.r.searchAvailable());
    assert.ok(await b.vt.settledWithoutWaiting(Promise.all(pending)), 'a caller waited on something while search was down');
    assert.deepEqual([...new Set(await Promise.all(pending))], [false]);
    assert.equal(b.state.calls, before, 'a caller probed the database — fifty of them would be fifty probes per write');
  });

  it('the watcher heals it: down, then up, and search is reported available without a restart', async () => {
    const b = build(failing());
    await intoDown(b);
    b.state.behaviour = ok;
    await b.vt.advance(15_000);
    assert.equal(b.r.snapshot().state, 'up', 'the first watcher delay is seconds, not minutes');
    assert.equal(await b.r.searchAvailable(), true);
  });

  it('heals and emits ONCE: every waiter is called exactly one time however long it stays up', async () => {
    const b = build(failing());
    await intoDown(b);
    let a = 0; let c = 0;
    b.r.afterSearchUp('a', () => { a++; });
    b.r.afterSearchUp('c', () => { c++; });
    b.state.behaviour = ok;
    await b.vt.advance(15_000);
    await b.vt.advance(6 * HOUR);
    assert.deepEqual([a, c], [1, 1]);
  });

  it('after the heal the watcher is gone: no probe runs for hours while it stays up', async () => {
    const b = build(failing());
    await intoDown(b);
    b.state.behaviour = ok;
    await b.vt.advance(15_000);
    const calls = b.state.calls;
    await b.vt.advance(6 * HOUR);
    assert.equal(b.state.calls, calls, 'a healed service is still being probed on a timer');
  });

  it('the watcher survives a probe that throws synchronously instead of rejecting', async () => {
    // The re-arm must sit OUTSIDE any step that can throw. A probe that throws before returning a promise is what
    // a driver does when its client is closed, and a watcher that stops re-arming on it never retries again.
    // (`failing()` throws synchronously; this case pins that the watcher keeps going across many of them.)
    const b = build(failing());
    await intoDown(b);
    await b.vt.advance(20 * MIN);
    assert.ok(b.state.calls > 7, 'fixture check: the watcher is probing');
    b.state.behaviour = ok;
    await b.vt.advance(10 * MIN);
    assert.equal(b.r.snapshot().state, 'up');
  });

  it('a probe that REJECTS (the usual driver failure) heals the same way as one that throws', async () => {
    const b = build(() => Promise.reject(refusedError()));
    await intoDown(b);
    await b.vt.advance(20 * MIN);
    assert.equal(b.r.snapshot().state, 'down');
    b.state.behaviour = async () => [];
    await b.vt.advance(10 * MIN);
    assert.equal(b.r.snapshot().state, 'up');
  });

  it('delays grow to a 5 minute cap and stay there over six hours of virtual time', async () => {
    const b = build(failing());
    await intoDown(b);
    const t0 = b.vt.now();
    await b.vt.advance(6 * HOUR);
    const times = b.state.callTimes.slice(6).map(t => t - t0);
    const gaps = times.slice(1).map((t, i) => t - times[i]);
    assert.ok(gaps.length > 60, `only ${gaps.length} probes in six hours`);
    assert.ok(times[0] >= 2_500 && times[0] <= 10_000, `the first watcher probe came after ${times[0]} ms`);
    assert.ok(gaps.every(g => g <= 5 * MIN + 1), `a gap exceeded the 5 minute cap: ${Math.max(...gaps)} ms`);
    assert.ok(gaps.every(g => g >= 2_500), `a gap was below half the base delay: ${Math.min(...gaps)} ms`);
    const tail = gaps.slice(-30);
    assert.ok(tail.every(g => g >= 2.5 * MIN - 1), `the delay did not reach the cap and stay there: ${Math.min(...tail)} ms`);
    assert.ok(gaps.length <= 160, `${gaps.length} probes in six hours — backoff is not reaching the cap`);
    assert.ok(gaps[0] < gaps.at(-1), 'the delay must GROW, not start at the cap');
  });

  it('reset stops the watcher and forgets the state: the next caller starts a fresh cold window', async () => {
    const b = build(failing());
    await intoDown(b);
    b.r.reset();
    const calls = b.state.calls;
    await b.vt.advance(6 * HOUR);
    assert.equal(b.state.calls, calls, 'reset left a watcher probing');
    assert.equal(b.r.snapshot().state, 'unknown');
    b.state.behaviour = ok;
    assert.equal(await b.vt.drive(b.r.searchAvailable()), true);
  });
});

describe('absent: a database with no search component at all', () => {
  const stateAfter = async (b, ms) => { await b.vt.advance(ms); return b.r.snapshot().state; };

  it('three consecutive refusals of the no-mongot kind park it: one probe an hour, quiet after the first warn', async () => {
    const b = build(failing(noMongotError));
    await intoDown(b);
    assert.equal(await stateAfter(b, 20 * MIN), 'absent');
    const callsThen = b.state.calls;
    const warnsThen = b.cap.lines.warn.length;
    await b.vt.advance(5 * HOUR);
    const probes = b.state.calls - callsThen;
    assert.ok(probes >= 4 && probes <= 11, `${probes} probes in five hours while absent — expected about one an hour`);
    assert.equal(b.cap.lines.warn.length, warnsThen, 'an absent search service warned again on a later probe');
  });

  it('the moment search first stopped answering is kept when `down` becomes `absent`', async () => {
    // `since` is what GET /api/spaces reports as indexWaitingSince: it must say when the service STOPPED answering,
    // not when the watcher finished counting refusals. A live drive saw it move from :41 to :04 on the first read
    // after the change of state.
    const b = build(failing(noMongotError));
    await intoDown(b);
    const first = b.r.snapshot();
    assert.equal(first.state, 'down');
    assert.ok(typeof first.since === 'number');
    await b.vt.advance(20 * MIN);
    const later = b.r.snapshot();
    assert.equal(later.state, 'absent');
    assert.equal(later.since, first.since, 'since moved when down became absent');
    // and it starts over only once search has really been up: a new outage is a new moment
    b.state.behaviour = ok;
    await b.vt.advance(2 * HOUR);
    assert.equal(b.r.snapshot().state, 'up');
    b.state.behaviour = failing(noMongotError);
    b.r.reset();
    assert.equal(b.r.snapshot().since, null);
  });

  it('absent heals too: the day a mongot is added, the waiters run', async () => {
    const b = build(failing(noMongotError));
    await intoDown(b);
    await b.vt.advance(20 * MIN);
    assert.equal(b.r.snapshot().state, 'absent');
    let called = 0;
    b.r.afterSearchUp('k', () => { called++; });
    b.state.behaviour = ok;
    await b.vt.advance(2 * HOUR);
    assert.equal(b.r.snapshot().state, 'up');
    assert.equal(called, 1);
  });

  it('a match that is not THREE IN A ROW never parks recovery: refuse, refuse, other, repeat — it stays down and retries', async () => {
    // A transient message that happened to match, parking the watcher for an hour, would leave a late mongot
    // undiscovered for an hour: the defect this change removes, with a longer fuse.
    const pattern = [noMongotError, noMongotError, refusedError];
    const b = build((n) => { throw pattern[(n - 1) % 3](); });
    await intoDown(b);
    for (let h = 0; h < 8; h++) {
      assert.equal(await stateAfter(b, 15 * MIN), 'down', `parked as absent after ${(h + 1) * 15} minutes`);
    }
    const before = b.state.calls;
    await b.vt.advance(2 * HOUR);
    assert.ok(b.state.calls - before >= 20, `only ${b.state.calls - before} probes in two hours: recovery was slowed`);
  });

  it('an error that is not a no-mongot refusal is never absent, however many times it repeats', async () => {
    const b = build(failing(refusedError));
    await intoDown(b);
    assert.equal(await stateAfter(b, 4 * HOUR), 'down');
  });

  it('the vector-QUERY refusals in PERMANENT_PROBE_ERRORS are not the absent list', async () => {
    // That list is matched on the message of a $vectorSearch refusal ("zero vector", "numCandidates",
    // "queryVector"). It answers a different question, and reusing it would park a healthy mongot whose probe
    // hit a malformed query.
    const vectorRefusal = () => Object.assign(new Error('queryVector is malformed; numCandidates out of range; zero vector'),
      { name: 'MongoServerError', code: 8 });
    const b = build(failing(vectorRefusal));
    await intoDown(b);
    assert.equal(await stateAfter(b, 3 * HOUR), 'down');
  });
});

describe('who is waiting for search, and how they are called', () => {
  it('a waiter registered AFTER the flip is called at once — it is never lost to the window between the two', async () => {
    const b = build(ok);
    await b.vt.drive(b.r.searchAvailable());
    let called = 0;
    b.r.afterSearchUp('late', () => { called++; });
    await settle();
    assert.equal(called, 1);
  });

  it('a keyed registration REPLACES the first instead of appending', async () => {
    const b = build(failing());
    await intoDown(b);
    const hits = [];
    b.r.afterSearchUp('space-a_facts', () => hits.push('first'));
    b.r.afterSearchUp('space-a_facts', () => hits.push('second'));
    b.r.afterSearchUp('space-b_facts', () => hits.push('other'));
    b.state.behaviour = ok;
    await b.vt.advance(15_000);
    assert.deepEqual(hits.sort(), ['other', 'second']);
  });

  it('forgetSearchWaiter removes the entry — a deleted space is not run against after the flip', async () => {
    const b = build(failing());
    await intoDown(b);
    const hits = [];
    b.r.afterSearchUp('gone', () => hits.push('gone'));
    b.r.afterSearchUp('kept', () => hits.push('kept'));
    b.r.forgetSearchWaiter('gone');
    b.r.forgetSearchWaiter('never-registered');
    b.state.behaviour = ok;
    await b.vt.advance(15_000);
    assert.deepEqual(hits, ['kept']);
  });

  it('the list is capped: a hundred thousand distinct keys are neither all kept nor an error', async () => {
    const b = build(failing());
    await intoDown(b);
    let called = 0;
    for (let i = 0; i < 100_000; i++) b.r.afterSearchUp(`k${i}`, () => { called++; });
    b.state.behaviour = ok;
    await b.vt.advance(15_000);
    await settle(200);
    assert.ok(called > 0, 'nothing ran');
    assert.ok(called < 100_000, 'the waiting list is unbounded');
  });

  it('a subscriber that throws, or rejects, does not stop the next', async () => {
    const b = build(failing());
    await intoDown(b);
    const ran = [];
    b.r.afterSearchUp('boom-sync', () => { throw new Error('first subscriber exploded'); });
    b.r.afterSearchUp('boom-async', async () => { throw new Error('second subscriber rejected'); });
    b.r.afterSearchUp('fine', () => { ran.push('fine'); });
    b.state.behaviour = ok;
    await b.vt.advance(15_000);
    assert.deepEqual(ran, ['fine']);
    assert.ok(b.cap.lines.warn.length >= 2, 'a failed subscriber must be reported, not swallowed');
    assert.equal(b.r.snapshot().state, 'up');
  });

  it('even when as many subscribers throw as there are concurrent workers, the ones behind them still run, each failure named', async () => {
    // Added with the mutation run: with only one or two throwers a worker that dies on its waiter leaves the others
    // to drain the list, so dropping the per-subscriber try survives. It takes as many throwers as workers (three)
    // for the ones queued behind them to be skipped, and that is the case worth holding.
    const b = build(failing());
    await intoDown(b);
    const ran = [];
    for (let i = 0; i < 3; i++) b.r.afterSearchUp(`boom-${i}`, () => { throw new Error('exploded'); });
    for (let i = 0; i < 3; i++) b.r.afterSearchUp(`fine-${i}`, () => { ran.push(`fine-${i}`); });
    const warnsBefore = b.cap.lines.warn.length;
    b.state.behaviour = ok;
    await b.vt.advance(15_000);
    assert.deepEqual(ran.sort(), ['fine-0', 'fine-1', 'fine-2'], 'subscribers queued behind three failures never ran');
    const mine = b.cap.lines.warn.slice(warnsBefore);
    for (let i = 0; i < 3; i++) assert.ok(mine.some(l => l.includes(`boom-${i}`)), `the failure of boom-${i} was not reported`);
  });

  it('subscribers run three at a time, after the state is already up', async () => {
    const b = build(failing());
    await intoDown(b);
    let running = 0; let max = 0; let total = 0; const gates = []; const stateSeen = [];
    for (let i = 0; i < 10; i++) {
      b.r.afterSearchUp(`w${i}`, async () => {
        stateSeen.push(b.r.snapshot().state);
        running++; max = Math.max(max, running);
        await new Promise(res => gates.push(res));
        running--; total++;
      });
    }
    b.r.noteSearchUp();
    await settle();
    assert.equal(running, 3, 'the first wave must be exactly the concurrency bound — no herd against a mongot that just started');
    while (total < 10) {
      const open = gates.splice(0);
      open.forEach(g => g());
      await settle();
    }
    assert.equal(max, 3);
    assert.ok(stateSeen.every(s => s === 'up'), 'a subscriber ran before the state was set');
  });
});

describe('noteSearchUp — /ready and the watcher agree', () => {
  it('is idempotent and emits only on a transition', async () => {
    const b = build(failing());
    await intoDown(b);
    let called = 0;
    b.r.afterSearchUp('k', () => { called++; });
    b.r.noteSearchUp();
    b.r.noteSearchUp();
    b.r.noteSearchUp();
    await settle();
    assert.equal(called, 1);
    // Already up: a waiter registered now runs once, and further notes add nothing.
    let late = 0;
    b.r.afterSearchUp('late', () => { late++; });
    b.r.noteSearchUp();
    await settle();
    assert.equal(late, 1);
    assert.equal(called, 1);
  });

  it('stops the watcher: a service /ready has seen answer is not probed again for hours', async () => {
    const b = build(failing());
    await intoDown(b);
    b.r.noteSearchUp();
    const calls = b.state.calls;
    await b.vt.advance(6 * HOUR);
    assert.equal(b.state.calls, calls);
    assert.equal(b.r.snapshot().state, 'up');
    assert.equal(await b.r.searchAvailable(), true);
  });

  it('works from absent too', async () => {
    const b = build(failing(noMongotError));
    await intoDown(b);
    await b.vt.advance(20 * MIN);
    assert.equal(b.r.snapshot().state, 'absent');
    b.r.noteSearchUp();
    assert.equal(b.r.snapshot().state, 'up');
  });
});

describe('what the log and the snapshot say — the class and the code, never the message', () => {
  const SECRETS = ['hunter2', 'db.internal', 'secret-detail', 'mongodb://', 'admin:'];
  const leaky = () => Object.assign(
    new Error('connect ECONNREFUSED mongodb://admin:hunter2@db.internal:27017/?secret-detail=1'),
    { name: 'MongoServerSelectionError', code: 'ECONNREFUSED' });

  /** The cold-start warn is the one line whose text is kept as it was (it names the rebuild route). */
  const coldStart = l => /did not answer after/.test(l);

  it('no log line written by the watcher, the recovery or a failing subscriber carries a message or a URI', async () => {
    const b = build(failing(leaky));
    await intoDown(b);
    b.r.afterSearchUp('thrower', () => { throw leaky(); });
    await b.vt.advance(3.5 * HOUR);
    b.state.behaviour = ok;
    await b.vt.advance(10 * MIN);
    const lines = b.cap.all().filter(l => !coldStart(l));
    assert.ok(lines.length > 5, `fixture check: expected probe, hourly and recovery lines, got ${lines.length}`);
    for (const l of lines) {
      for (const s of SECRETS) assert.ok(!l.includes(s), `a log line carries "${s}": ${l}`);
    }
    assert.ok(lines.some(l => l.includes('MongoServerSelectionError') || l.includes('ECONNREFUSED')),
      'the lines must still say WHAT failed — the class or the code — or they are useless as well as safe');
  });

  it('warns on entering down, about hourly while down by the wall clock, and says when it is back', async () => {
    const b = build(failing(leaky));
    await intoDown(b);
    await b.vt.advance(3.5 * HOUR);
    const warns = b.cap.lines.warn.filter(l => !coldStart(l));
    assert.ok(warns.length >= 2 && warns.length <= 6, `${warns.length} warns in 3.5 hours — expected about one an hour`);
    assert.ok(b.cap.lines.warn.some(coldStart), 'the existing cold-start warning must still be written');
    assert.ok(b.state.calls > 20, 'fixture check: many probes');
    b.state.behaviour = ok;
    await b.vt.advance(10 * MIN);
    assert.equal(b.cap.lines.info.filter(l => /search is back/i.test(l)).length, 1, 'recovery must be announced once');
  });

  it('the snapshot is an enum and numbers: nothing in it can carry a message', async () => {
    const b = build(failing(leaky));
    await intoDown(b);
    await b.vt.advance(HOUR);
    const snap = b.r.snapshot();
    assert.ok(['unknown', 'up', 'down', 'absent'].includes(snap.state), `unexpected state ${snap.state}`);
    for (const [k, v] of Object.entries(snap)) {
      assert.ok(v === null || ['number', 'boolean'].includes(typeof v) || (typeof v === 'string' && v.length <= 32),
        `snapshot.${k} is ${typeof v} ${JSON.stringify(v)?.slice(0, 60)} — only an enum and numbers may appear`);
    }
    for (const s of SECRETS) assert.ok(!JSON.stringify(snap).includes(s));
  });
});

describe('the production singleton', () => {
  it('exports the functions the factory returns, and resetSearchReadyProbe is still served from vector-index', async () => {
    const mod = await import('../../server/dist/spaces/search-readiness.js');
    for (const name of ['searchAvailable', 'afterSearchUp', 'forgetSearchWaiter', 'noteSearchUp', 'searchReadinessSnapshot', 'resetSearchReadyProbe']) {
      assert.equal(typeof mod[name], 'function', `${name} is not exported`);
    }
    const vi = await import('../../server/dist/spaces/vector-index.js');
    assert.equal(vi.resetSearchReadyProbe, mod.resetSearchReadyProbe,
      'the existing importers of resetSearchReadyProbe must reach the SAME reset, not a second copy');
  });
});
