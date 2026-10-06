/**
 * ONE runner for "do per-space work with a failure or a hang contained" (`Q-274`, bundle-53 G8).
 *
 * ## The defect it prevents
 *
 * Every loop over the spaces outside a request (the TTL sweep, the legacy spill sweep, the claim walks, the scanners, the
 * reindex tick, ...) had its own answer to "what if one space fails?": a `catch { continue; }` that swallowed it, no catch so one
 * space stopped every space after it, a per-unit catch that logged on every pass. And none had an answer for "what if one
 * operation HANGS?": a space whose operation never returns held the walk, and with it the next tick, for as long as the driver
 * waited. The runner answers both once: isolation, the one verdict (`walkVerdict`), the stop when the store is down, the stop when
 * the store only LOOKS up (K spaces time out in a row, per TICK), the quarantine of a space that hung, and the report.
 *
 * ## What is pinned
 *
 * isolation and the return shape; the sub-step; `limit`; the bound entered per callback; store-down ends the walk with ONE line and
 * no Mongo (`storeAnswers` and the clock are injected); K = 3 per tick across walks that share a budget; the quarantine (first
 * timeout, skipped while it lasts - a full scan included - one probe per lift, 60 s doubling to 300 s, reset on success);
 * `eachUnit` (an ordinary unit failure is reported and the loop goes on, a store-down or a timeout is rethrown to the space);
 * `stopAfterFirst`, which a claim walk is built on; and that every verdict is awaited.
 *
 * Run: node --test testing/standalone/housekeeping-walk.test.js   (requires a prior build of server/)
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MongoNetworkError, MongoServerError } from 'mongodb';
import {
  createHousekeepingWalk, WalkBudget, withWalkBudget, STALLED_AFTER_TIMEOUTS, QUARANTINE_BASE_MS, QUARANTINE_MAX_MS,
} from '../../server/dist/util/housekeeping-walk.js';
import { spaceFailureReporter } from '../../server/dist/util/space-failure.js';
import { onHousekeepingSignal } from '../../server/dist/util/housekeeping-signals.js';
import * as wb from '../../server/dist/db/write-bound.js';
import { StoreTimeout } from '../../server/dist/db/write-timeout.js';

const STEP = 'Test step';

/** A walk with its own clock, reporter, quarantine map and store: nothing shared between cases. */
function make({ storeUp = true } = {}) {
  const clock = { t: 10_000_000 };
  const lines = [];
  const store = { up: storeUp, calls: 0 };
  const storeAnswers = async () => { store.calls++; return store.up; };
  const reporter = spaceFailureReporter({ now: () => clock.t, warn: (m) => lines.push(m) });
  const walk = createHousekeepingWalk({ now: () => clock.t, storeAnswers, reporter });
  return { clock, lines, store, walk };
}

const timeout = () => new StoreTimeout();
const storeDown = () => new MongoNetworkError('connection closed');
const boom = () => new Error('boom');

/** A callback that fails the spaces it is told to, with the error it is told to, and records the order it ran in. */
function script(plan = {}) {
  const ran = [];
  const fn = async (space) => {
    const id = typeof space === 'string' ? space : space.id;
    ran.push(id);
    const what = plan[id];
    if (what) throw (typeof what === 'function' ? what() : what);
  };
  return { ran, fn };
}

describe('eachSpace: isolation and the shape of what it returns', () => {
  it('runs the callback for each space in order, with the space and a context that names the step', async () => {
    const { walk } = make();
    const seen = [];
    const out = await walk.eachSpace(STEP, ['a', { id: 'b' }, 'c'], async (space, ctx) => { seen.push([space, ctx.spaceId, ctx.step]); });
    assert.deepEqual(seen, [['a', 'a', STEP], [{ id: 'b' }, 'b', STEP], ['c', 'c', STEP]]);
    assert.deepEqual(out.failed, []);
    assert.deepEqual(out.outcomes.map(o => [o.spaceId, o.status]), [['a', 'ok'], ['b', 'ok'], ['c', 'ok']]);
    assert.equal(out.storeDown, undefined);
    assert.equal(out.stalled, undefined);
  });

  it('a failing space does not stop the ones after it, and is returned with its step and its reason', async () => {
    const { walk, lines } = make();
    const s = script({ b: boom });
    const out = await walk.eachSpace(STEP, ['a', 'b', 'c'], s.fn);
    assert.deepEqual(s.ran, ['a', 'b', 'c']);
    assert.equal(out.failed.length, 1);
    assert.equal(out.failed[0].spaceId, 'b');
    assert.equal(out.failed[0].step, STEP);
    assert.match(out.failed[0].reason, /boom/, 'the reason survives, for the caller that reports a summary of its own');
    assert.equal(lines.length, 1);
    assert.match(lines[0], new RegExp(`^${STEP} failed for space 'b': .*boom.* — retried next cycle$`));
  });

  it('never throws for a space failure, whatever it is', async () => {
    const { walk } = make();
    const out = await walk.eachSpace(STEP, ['a'], async () => { throw 'not even an Error'; });
    assert.equal(out.failed.length, 1);
  });

  it('the sub-step the callback sets is the step the failure is reported under', async () => {
    const { walk, lines } = make();
    const out = await walk.eachSpace('Drain', ['a'], async (_s, ctx) => { ctx.step = 'Drain: write'; throw boom(); });
    assert.equal(out.failed[0].step, 'Drain: write');
    assert.match(lines[0], /^Drain: write failed for space 'a'/);
  });

  it('`when` says when the space is retried', async () => {
    const { walk, lines } = make();
    await walk.eachSpace(STEP, ['a'], async () => { throw boom(); }, { when: 'next tick' });
    assert.match(lines[0], /— retried next tick$/);
  });

  it('a space that failed and then succeeded is reported again when it fails again', async () => {
    const { walk, lines } = make();
    const flaky = { fail: true };
    const fn = async () => { if (flaky.fail) throw boom(); };
    await walk.eachSpace(STEP, ['a'], fn);
    await walk.eachSpace(STEP, ['a'], fn);
    assert.equal(lines.length, 1, 'the second failure in a row is the same condition');
    flaky.fail = false;
    await walk.eachSpace(STEP, ['a'], fn);
    flaky.fail = true;
    await walk.eachSpace(STEP, ['a'], fn);
    assert.equal(lines.length, 2, 'a success in between makes the next failure news');
  });

  it('`limit` is how many spaces run at once; the default is one', async () => {
    for (const [limit, expected] of [[undefined, 1], [2, 2], [10, 5]]) {
      const { walk } = make();
      let inFlight = 0; let peak = 0;
      await walk.eachSpace(STEP, ['a', 'b', 'c', 'd', 'e'], async () => {
        inFlight++; peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
      }, limit === undefined ? {} : { limit });
      assert.equal(peak, expected, `limit ${limit}`);
    }
  });

  it('an empty list is an empty answer, not an error', async () => {
    const { walk } = make();
    const out = await walk.eachSpace(STEP, [], async () => { throw new Error('never'); });
    assert.deepEqual([out.failed, out.outcomes], [[], []]);
  });
});

describe('every callback runs inside the housekeeping bound', () => {
  after(() => wb.setWriteBoundForTest(null));

  /** What the driver is handed for a `find` issued inside the callback. */
  async function findOptionsInside(walk, opts) {
    let seen;
    await walk.eachSpace(STEP, ['a'], async () => {
      await wb.callBounded('find', [{}, {}], (args) => { seen = args[1]; return Promise.resolve([]); }, { collection: 'a_facts', inheritedTimeoutMs: undefined });
    }, opts);
    return seen;
  }

  it('a read in the callback carries timeoutMS === housekeepingOpMs()', async () => {
    wb.setWriteBoundForTest({ housekeepingOpMs: 4321 });
    const { walk } = make();
    const seen = await findOptionsInside(walk);
    assert.equal(seen.timeoutMS, 4321);
    assert.equal(wb.housekeepingOpMs(), 4321, 'the seam set what the case is written against');
  });

  it('`opMs` is the claim bound: a claim walk carries CLAIM_OP_MS', async () => {
    wb.setWriteBoundForTest({ housekeepingOpMs: 4321 });
    const { walk } = make();
    const seen = await findOptionsInside(walk, { opMs: wb.CLAIM_OP_MS });
    assert.equal(seen.timeoutMS, wb.CLAIM_OP_MS);
  });

  it('outside a callback nothing is bound, and the scope ended with the callback', async () => {
    wb.setWriteBoundForTest({ housekeepingOpMs: 4321 });
    const { walk } = make();
    await findOptionsInside(walk);
    let seen;
    await wb.callBounded('find', [{}, {}], (args) => { seen = args[1]; return Promise.resolve([]); }, { collection: 'a_facts', inheritedTimeoutMs: undefined });
    assert.equal(seen.timeoutMS, undefined);
  });

  it('a timeout is reported with the figure that fired and the setting that moves it', async () => {
    wb.setWriteBoundForTest({ housekeepingOpMs: 4321 });
    const { walk, lines } = make();
    await walk.eachSpace(STEP, ['a'], async () => { throw timeout(); });
    assert.match(lines[0], /4321 ms/);
    assert.match(lines[0], /YTHRIL_HOUSEKEEPING_OP_TIMEOUT_MS/);
    const claims = make();
    await claims.walk.eachSpace(STEP, ['a'], async () => { throw timeout(); }, { opMs: wb.CLAIM_OP_MS });
    assert.match(claims.lines[0], /10000 ms/);
    assert.doesNotMatch(claims.lines[0], /YTHRIL_HOUSEKEEPING_OP_TIMEOUT_MS/, 'a claim\'s bound is not the setting\'s');
  });
});

describe('the store is down: the walk ends, says so once, and needs no Mongo to know', () => {
  it('a store condition ends the walk: later spaces are not run, storeDown is true, and exactly one line is said', async () => {
    const { walk, lines, store } = make();
    const s = script({ b: storeDown });
    const out = await walk.eachSpace(STEP, ['a', 'b', 'c', 'd'], s.fn);
    assert.deepEqual(s.ran, ['a', 'b']);
    assert.equal(out.storeDown, true);
    assert.equal(lines.length, 1);
    assert.match(lines[0], new RegExp(`^${STEP} stopped: the store is not answering \\(.*\\) — retried next cycle$`));
    assert.equal(store.calls, 0, 'a class of the store\'s condition is the evidence: nothing is pinged');
    assert.deepEqual(out.failed.map(f => f.spaceId), ['b'], 'the space it happened in is returned; the ones never run are not');
  });

  it('a bound that ended an operation, on a store that does not answer its ping, ends the walk at the FIRST timeout', async () => {
    const { walk, lines, store } = make({ storeUp: false });
    const s = script({ a: timeout });
    const out = await walk.eachSpace(STEP, ['a', 'b', 'c'], s.fn);
    assert.deepEqual(s.ran, ['a'], 'one bound spent, not one per space');
    assert.equal(out.storeDown, true);
    assert.equal(lines.length, 1);
    assert.equal(store.calls, 1);
  });

  it('a label alone does not end the walk while the store answers', async () => {
    const { walk } = make({ storeUp: true });
    const labelled = () => { const e = new MongoServerError({ errmsg: 'x', code: 999_999 }); e.addErrorLabel('RetryableWriteError'); return e; };
    const s = script({ a: labelled });
    const out = await walk.eachSpace(STEP, ['a', 'b'], s.fn);
    assert.deepEqual(s.ran, ['a', 'b']);
    assert.equal(out.storeDown, undefined);
  });

  it('a signal says store_down, once for the stop', async () => {
    const kinds = [];
    const off = onHousekeepingSignal((e) => { if (e.type === 'space-failure' && e.step === STEP) kinds.push(e.kind); });
    try {
      const { walk } = make();
      await walk.eachSpace(STEP, ['a', 'b'], script({ a: storeDown }).fn);
      assert.deepEqual(kinds, ['store_down']);
    } finally { off(); }
  });

  it('a walk in the same tick as one that found the store down does not pay another bound: it stops at once and says so for its own step', async () => {
    const { walk, lines } = make();
    await withWalkBudget(async () => {
      await walk.eachSpace('First step', ['a'], script({ a: storeDown }).fn);
      const s = script();
      const out = await walk.eachSpace('Second step', ['a', 'b'], s.fn);
      assert.deepEqual(s.ran, [], 'nothing was run');
      assert.equal(out.storeDown, true);
    });
    assert.ok(lines.some(l => /^First step stopped: the store is not answering/.test(l)));
    assert.ok(lines.some(l => /^Second step stopped: the store is not answering/.test(l)));
  });
});

describe('the store only LOOKS up: K spaces time out in a row, per tick', () => {
  it('K is three', () => assert.equal(STALLED_AFTER_TIMEOUTS, 3));

  it('the third consecutive timeout on distinct spaces ends the walk, says so once, and the fourth space is never run', async () => {
    const { walk, lines } = make({ storeUp: true });
    const s = script({ a: timeout, b: timeout, c: timeout });
    const out = await walk.eachSpace(STEP, ['a', 'b', 'c', 'd'], s.fn);
    assert.deepEqual(s.ran, ['a', 'b', 'c']);
    assert.equal(out.stalled, true);
    assert.equal(lines.filter(l => /the store looks stalled/.test(l)).length, 1);
    assert.ok(lines.includes(`${STEP} stopped: 3 spaces timed out in a row; the store looks stalled — retried next cycle`));
  });

  it('a success between them breaks the run', async () => {
    const { walk } = make({ storeUp: true });
    const s = script({ a: timeout, b: timeout, d: timeout, e: timeout });
    const out = await walk.eachSpace(STEP, ['a', 'b', 'c', 'd', 'e', 'f'], s.fn);
    assert.deepEqual(s.ran, ['a', 'b', 'c', 'd', 'e', 'f']);
    assert.equal(out.stalled, undefined);
  });

  it('an ordinary failure between them breaks the run too: the store answered', async () => {
    const { walk } = make({ storeUp: true });
    const s = script({ a: timeout, b: timeout, c: boom, d: timeout });
    const out = await walk.eachSpace(STEP, ['a', 'b', 'c', 'd'], s.fn);
    assert.equal(out.stalled, undefined);
  });

  it('is counted per TICK: walks that share a budget add up, and a walk after the trip stops at once', async () => {
    const { walk, lines } = make({ storeUp: true });
    await withWalkBudget(async () => {
      const first = await walk.eachSpace('Step one', ['a', 'b'], script({ a: timeout, b: timeout }).fn);
      assert.equal(first.stalled, undefined, 'two is not three');
      const second = script({ c: timeout });
      const out = await walk.eachSpace('Step two', ['c', 'd'], second.fn);
      assert.equal(out.stalled, true, 'the third distinct space in the tick');
      assert.deepEqual(second.ran, ['c']);
      const third = script();
      const last = await walk.eachSpace('Step three', ['e', 'f'], third.fn);
      assert.deepEqual(third.ran, [], 'the tick is already known to be stalled');
      assert.equal(last.stalled, true);
    });
    assert.ok(lines.some(l => /^Step two stopped: 3 spaces timed out in a row/.test(l)));
    assert.ok(lines.some(l => /^Step three stopped: 3 spaces timed out in a row/.test(l)), 'each step says it, once');
  });

  it('a walk outside a tick makes its own budget: two walks of two timeouts do not add up', async () => {
    const { walk } = make({ storeUp: true });
    const one = await walk.eachSpace('Step one', ['a', 'b'], script({ a: timeout, b: timeout }).fn);
    const two = await walk.eachSpace('Step two', ['c', 'd'], script({ c: timeout, d: timeout }).fn);
    assert.equal(one.stalled, undefined);
    assert.equal(two.stalled, undefined);
  });

  it('an explicit budget is the one used', async () => {
    const { walk } = make({ storeUp: true });
    const budget = new WalkBudget();
    await walk.eachSpace('Step one', ['a', 'b'], script({ a: timeout, b: timeout }).fn, { budget });
    const out = await walk.eachSpace('Step two', ['c'], script({ c: timeout }).fn, { budget });
    assert.equal(out.stalled, true);
  });
});

describe('WalkBudget', () => {
  it('counts DISTINCT spaces: one space timing out three times is one space', () => {
    const b = new WalkBudget();
    assert.equal(b.noteTimeout('a'), false);
    assert.equal(b.noteTimeout('a'), false);
    assert.equal(b.noteTimeout('a'), false);
    assert.equal(b.noteTimeout('b'), false);
    assert.equal(b.noteTimeout('c'), true);
    assert.equal(b.tripped, true);
  });

  it('a success clears the run', () => {
    const b = new WalkBudget();
    b.noteTimeout('a'); b.noteTimeout('b');
    b.noteSuccess();
    assert.equal(b.noteTimeout('c'), false);
    assert.equal(b.tripped, false);
  });

  it('the figure is a parameter, and tripping is reported once', () => {
    const b = new WalkBudget(2);
    b.noteTimeout('a');
    assert.equal(b.noteTimeout('b'), true);
    assert.equal(b.noteTimeout('c'), false, 'it tripped on b; c is not the trip');
    assert.equal(b.tripped, true);
  });
});

describe('quarantine: a space that hung is not asked again for a while', () => {
  const secondsIn = (line) => Number(/after quarantine \((\d+)s\)/.exec(line)?.[1]);

  it('the figures are 60 s doubling to 300 s', () => {
    assert.equal(QUARANTINE_BASE_MS, 60_000);
    assert.equal(QUARANTINE_MAX_MS, 300_000);
  });

  it('begins on the FIRST timeout, and says how long', async () => {
    const { walk, lines } = make();
    await walk.eachSpace(STEP, ['a'], script({ a: timeout }).fn);
    assert.match(lines[0], /— retried after quarantine \(60s\)$/);
    assert.deepEqual(walk.quarantinedSpaces(), ['a']);
  });

  it('a quarantined space is skipped by any later walk, a full scan included, and is returned as skipped, not failed', async () => {
    const { walk, clock } = make();
    await walk.eachSpace(STEP, ['a', 'b'], script({ a: timeout }).fn);
    clock.t += 30_000;
    const s = script();
    const out = await walk.eachSpace('Another step', ['a', 'b'], s.fn);
    assert.deepEqual(s.ran, ['b'], 'a is skipped for every step, not only the one that timed out');
    assert.deepEqual(out.skipped, ['a']);
    assert.deepEqual(out.failed, []);
    assert.deepEqual(out.outcomes.map(o => [o.spaceId, o.status]), [['a', 'skipped'], ['b', 'ok']]);
  });

  it('is asked again after the window, once: a second walk during the probe skips the space', async () => {
    const { walk, clock } = make();
    await walk.eachSpace(STEP, ['a'], script({ a: timeout }).fn);
    clock.t += QUARANTINE_BASE_MS;
    let release; let probes = 0;
    const gate = new Promise((r) => { release = r; });
    const probing = walk.eachSpace(STEP, ['a'], async () => { probes++; await gate; });
    await new Promise((r) => setImmediate(r));
    const during = script();
    const out = await walk.eachSpace(STEP, ['a'], during.fn);
    assert.deepEqual(during.ran, [], 'the probe is single-flight');
    assert.deepEqual(out.skipped, ['a']);
    release();
    await probing;
    assert.equal(probes, 1);
    assert.deepEqual(walk.quarantinedSpaces(), [], 'the probe succeeded: the quarantine ended');
  });

  it('doubles on each timeout in a row up to 300 s, and a success resets it', async () => {
    const { walk, clock, lines } = make();
    const seconds = [];
    for (let i = 0; i < 6; i++) {
      const before = lines.length;
      await walk.eachSpace(`Step ${i}`, ['a'], script({ a: timeout }).fn);
      seconds.push(secondsIn(lines[before]));
      clock.t += QUARANTINE_MAX_MS;
    }
    assert.deepEqual(seconds, [60, 120, 240, 300, 300, 300]);
    await walk.eachSpace('Recovered', ['a'], script().fn);
    const before = lines.length;
    await walk.eachSpace('Again', ['a'], script({ a: timeout }).fn);
    assert.equal(secondsIn(lines[before]), 60, 'back to the base');
  });

  it('markSpaceMayHaveWork lifts it for ONE probe: liftQuarantine', async () => {
    const { walk } = make();
    await walk.eachSpace(STEP, ['a'], script({ a: timeout }).fn);
    walk.liftQuarantine('a');
    const probe = script();
    await walk.eachSpace(STEP, ['a'], probe.fn);
    assert.deepEqual(probe.ran, ['a'], 'a write marked the space: it is probed before the window ends');
    assert.deepEqual(walk.quarantinedSpaces(), []);
  });

  it('a lift is one probe: a failing probe puts the quarantine back, and the next walk skips', async () => {
    const { walk } = make();
    await walk.eachSpace(STEP, ['a'], script({ a: timeout }).fn);
    walk.liftQuarantine('a');
    await walk.eachSpace(STEP, ['a'], script({ a: timeout }).fn);
    const next = script();
    const out = await walk.eachSpace(STEP, ['a'], next.fn);
    assert.deepEqual(next.ran, []);
    assert.deepEqual(out.skipped, ['a']);
  });

  it('lifting a space that is not quarantined is a no-op', () => {
    const { walk } = make();
    assert.doesNotThrow(() => walk.liftQuarantine('nobody'));
    assert.deepEqual(walk.quarantinedSpaces(), []);
  });

  it('an ordinary failure on the probe ends the quarantine: the space answered, it is not hung', async () => {
    const { walk, clock } = make();
    await walk.eachSpace(STEP, ['a'], script({ a: timeout }).fn);
    clock.t += QUARANTINE_BASE_MS;
    await walk.eachSpace(STEP, ['a'], script({ a: boom }).fn);
    assert.deepEqual(walk.quarantinedSpaces(), []);
  });

  it('a skipped space is neither a success nor a timeout for the tick\'s run', async () => {
    const { walk } = make({ storeUp: true });
    const budget = new WalkBudget();
    await walk.eachSpace('One', ['a', 'b'], script({ a: timeout, b: timeout }).fn, { budget });
    const out = await walk.eachSpace('Two', ['a', 'c'], script({ c: timeout }).fn, { budget });
    assert.deepEqual(out.skipped, ['a'], 'a is quarantined');
    assert.equal(out.stalled, true, 'the skip did not break the run, and c is the third distinct space');
  });

  it('the gauge: a signal carries how many spaces are quarantined, up on entering and down on leaving', async () => {
    const counts = [];
    const off = onHousekeepingSignal((e) => { if (e.type === 'quarantined-spaces') counts.push(e.count); });
    try {
      const { walk, clock } = make();
      await walk.eachSpace(STEP, ['a', 'b'], script({ a: timeout, b: timeout }).fn);
      assert.equal(counts.at(-1), 2);
      clock.t += QUARANTINE_BASE_MS;
      await walk.eachSpace(STEP, ['a', 'b'], script().fn);
      assert.equal(counts.at(-1), 0);
    } finally { off(); }
  });

  it('a store-down verdict does not quarantine the space: it is the store\'s', async () => {
    const { walk } = make();
    await walk.eachSpace(STEP, ['a'], script({ a: storeDown }).fn);
    assert.deepEqual(walk.quarantinedSpaces(), []);
  });
});

describe('eachUnit: the units inside a space', () => {
  it('an ordinary unit failure is reported once, with its unit, and the loop goes on', async () => {
    const { walk, lines } = make();
    const ran = [];
    const out = await walk.eachSpace(STEP, ['a'], async () => {
      const inner = await walk.eachUnit(['facts', 'entities', 'edges'], async (unit) => { ran.push(unit); if (unit === 'entities') throw boom(); });
      assert.deepEqual(inner.failed.map(f => f.unit), ['entities']);
    });
    assert.deepEqual(ran, ['facts', 'entities', 'edges']);
    assert.equal(lines.length, 1);
    assert.match(lines[0], new RegExp(`^${STEP} failed for space 'a' \\(entities\\): .*boom`));
    assert.deepEqual(out.failed.map(f => [f.spaceId, f.unit]), [['a', 'entities']], 'and the space is returned as failed: the caller needs to know');
    assert.equal(out.outcomes[0].status, 'failed');
  });

  it('a space with a failed unit is not a success: its throttle is kept, so the next cycle does not say it again', async () => {
    const { walk, lines } = make();
    const fn = async () => { await walk.eachUnit(['facts'], async () => { throw boom(); }); };
    await walk.eachSpace(STEP, ['a'], fn);
    await walk.eachSpace(STEP, ['a'], fn);
    assert.equal(lines.length, 1);
  });

  it('a timeout in a unit is rethrown to the space: later units are not run, the walk reports it as the space\'s timeout and goes on', async () => {
    const { walk, lines } = make();
    const ran = [];
    const out = await walk.eachSpace(STEP, ['a', 'b'], async (space) => {
      await walk.eachUnit(['facts', 'entities', 'edges'], async (unit) => { ran.push(`${space}:${unit}`); if (space === 'a' && unit === 'entities') throw timeout(); });
    });
    assert.deepEqual(ran, ['a:facts', 'a:entities', 'b:facts', 'b:entities', 'b:edges']);
    assert.match(lines[0], /after quarantine \(60s\)/);
    assert.deepEqual(out.failed.map(f => f.spaceId), ['a']);
  });

  it('a store-down in a unit is rethrown: the walk ends', async () => {
    const { walk } = make();
    const ran = [];
    const out = await walk.eachSpace(STEP, ['a', 'b'], async (space) => {
      await walk.eachUnit(['facts', 'entities'], async (unit) => { ran.push(`${space}:${unit}`); throw storeDown(); });
    });
    assert.deepEqual(ran, ['a:facts']);
    assert.equal(out.storeDown, true);
  });

  it('is only for use inside a walk: outside one it throws rather than report against no space', async () => {
    const { walk } = make();
    await assert.rejects(() => walk.eachUnit(['facts'], async () => {}), /inside/);
  });

  it('a unit may be a name or an object with a name or an id', async () => {
    const { walk } = make();
    let units;
    await walk.eachSpace(STEP, ['a'], async () => {
      const r = await walk.eachUnit(['x', { name: 'y' }, { id: 'z' }], async () => { throw boom(); });
      units = r.failed.map(f => f.unit);
    });
    assert.deepEqual(units, ['x', 'y', 'z']);
  });
});

describe('walkSpaces: stopAfterFirst, which a claim walk is built on', () => {
  it('hands each space\'s value back, and stops at the first the predicate accepts', async () => {
    const { walk } = make();
    const ran = [];
    const out = await walk.walkSpaces(STEP, ['a', 'b', 'c', 'd'], async (space) => { ran.push(space); return space === 'b' ? 'job-1' : null; },
      { stopAfterFirst: (value) => value !== null });
    assert.deepEqual(ran, ['a', 'b']);
    assert.deepEqual(out.outcomes.map(o => [o.spaceId, o.status, o.value]), [['a', 'ok', null], ['b', 'ok', 'job-1']]);
  });

  it('a space that threw is failed, a quarantined one is skipped, an empty one is ok with its empty value: the three a claim tells apart', async () => {
    const { walk } = make();
    await walk.walkSpaces(STEP, ['q'], async () => { throw timeout(); });
    const out = await walk.walkSpaces(STEP, ['q', 'x', 'e'], async (space) => { if (space === 'x') throw boom(); return null; },
      { stopAfterFirst: (v) => v !== null });
    assert.deepEqual(out.outcomes.map(o => [o.spaceId, o.status]), [['q', 'skipped'], ['x', 'failed'], ['e', 'ok']]);
  });

  it('the predicate is not asked about a space that failed', async () => {
    const { walk } = make();
    let asked = 0;
    await walk.walkSpaces(STEP, ['x'], async () => { throw boom(); }, { stopAfterFirst: () => { asked++; return true; } });
    assert.equal(asked, 0);
  });
});

describe('one verdict, awaited', () => {
  const src = readFileSync(new URL('../../server/src/util/housekeeping-walk.ts', import.meta.url), 'utf8')
    .split('\n').filter(l => !/^\s*(\*|\/\/|\/\*)/.test(l)).join('\n');

  it('every call of walkVerdict in the walk is awaited: an unawaited verdict is a Promise, which is truthy', () => {
    const calls = [...src.matchAll(/walkVerdict\(/g)];
    assert.ok(calls.length >= 1, 'the walk asks the one verdict');
    // Structural: a call that is NOT the operand of an `await` is a match of the lookbehind form, whatever precedes it.
    const unawaited = [...src.matchAll(/(?<!\bawait\s+)\bwalkVerdict\(/g)];
    assert.deepEqual(unawaited.map(m => m.index), [], 'a walkVerdict( call is not the operand of an await');
  });

  it('the walk does not re-derive the verdict: it never asks isWriteTimeout, isStoreCondition or isStoreUnreachable itself', () => {
    for (const name of ['isWriteTimeout', 'isStoreCondition', 'isStoreUnreachable', 'storeConditionKind']) {
      assert.ok(!src.includes(name), `housekeeping-walk.ts asks ${name} directly`);
    }
  });
});
