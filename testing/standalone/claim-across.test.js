/**
 * `WorkSignal.claimAcross`: the ONE find-first claim walk (`Q-274`, `Q-358`, bundle-53 G14).
 *
 * ## The defect it prevents
 *
 * `claimNextEmbedJob` and `claimNextJob` each walked the probed spaces by hand: no catch, so one space whose claim threw (or hung)
 * ended the claim for every space behind it, and with it the worker's loop; and each remembered, by hand, the two decisions that
 * look like bookkeeping - `noteEmpty` only for a space that answered empty in EVERY pass, `noteClaimed` on a claim. The walk is now
 * `walkSpaces` with `stopAfterFirst` and the claim bound, and this module owns what a hand-written copy drops.
 *
 * ## The truth table pinned here (no Mongo: the clock and `storeAnswers` are injected)
 *
 *   empty in every pass, none threw  -> noteEmpty        (the space leaves the probe hint)
 *   claimed                          -> noteClaimed      (the space stays hinted)
 *   threw                            -> neither          (a failing HINTED space stays hinted)
 *   skipped (quarantined)            -> neither          (the quarantine is honoured by a full scan; C4)
 *   every space threw                -> null, no throw
 *   the store is down                -> null, neither note called
 *
 * Plus: the probe slot is consumed ONCE per claim (an unhinted lane-2 job on a full scan is claimed); a lane-2 job behind an empty
 * lane-0 is still claimed; lanes run ACROSS spaces; a space that threw is not asked again in the claim's later passes; the first
 * timeout quarantines, a write lifts it for ONE probe, the window ends it, a success resets the backoff; every operation a claim
 * issues carries `CLAIM_OP_MS`, and an enclosing scope can only tighten it.
 *
 * Run: node --test testing/standalone/claim-across.test.js   (requires a prior build of server/)
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { MongoNetworkError } from 'mongodb';
import { createWorkSignal } from '../../server/dist/util/work-signal.js';
import { createHousekeepingWalk, STALLED_AFTER_TIMEOUTS, QUARANTINE_BASE_MS } from '../../server/dist/util/housekeeping-walk.js';
import { spaceFailureReporter } from '../../server/dist/util/space-failure.js';
import * as wb from '../../server/dist/db/write-bound.js';
import { StoreTimeout } from '../../server/dist/db/write-timeout.js';

const STEP = 'Test claim';

/** A signal over a walk with its own clock, reporter, quarantine map and store: nothing shared between cases. */
function make({ storeUp = true } = {}) {
  const clock = { t: 10_000_000 };
  const lines = [];
  const store = { up: storeUp, calls: 0 };
  const storeAnswers = async () => { store.calls++; return store.up; };
  const reporter = spaceFailureReporter({ now: () => clock.t, warn: (m) => lines.push(m) });
  const walk = createHousekeepingWalk({ now: () => clock.t, storeAnswers, reporter });
  const signal = createWorkSignal({ now: () => clock.t, walk });
  return { clock, lines, store, walk, signal };
}

const timeout = () => new StoreTimeout();
const storeDown = () => new MongoNetworkError('connection closed');
const boom = () => new Error('boom');

/** Which of `ids` the signal would probe now: the hinted ones, or all of them when a full scan is due (this CONSUMES the slot). */
const hinted = (signal, ids) => signal.spacesToProbe(ids);

/** Spend the full-scan slot, so what the hint holds is what the case seeded and the next claim is NOT a full scan. */
function spendFullScan(signal, ids) {
  signal.reset();
  signal.spacesToProbe(ids);
}

/** A tryClaim that answers per (space, pass) from `plan`, recording what it was asked in order. */
function script(plan = {}) {
  const asked = [];
  const tryClaim = async (spaceId, pass) => {
    asked.push(`${spaceId}:${pass}`);
    const what = plan[`${spaceId}:${pass}`] ?? plan[spaceId];
    if (what instanceof Error) throw what;
    return what ?? null;
  };
  return { asked, tryClaim };
}

const PASSES = ['p0', 'p1'];

describe('claimAcross: the truth table', () => {
  it('empty in every pass and none threw -> noteEmpty: the space leaves the hint', async () => {
    const { signal } = make();
    for (const s of ['a', 'b']) signal.markSpaceMayHaveWork(s);
    const out = await signal.claimAcross(['a', 'b'], PASSES, script().tryClaim, { step: STEP });
    assert.equal(out, null);
    assert.deepEqual(hinted(signal, ['a', 'b']), [], 'both answered empty in both passes: neither stays hinted');
  });

  it('claimed -> noteClaimed: the space is hinted, the value is returned, and no later space is asked', async () => {
    const { signal } = make();
    const s = script({ 'b:p0': { id: 'job-b' } });
    const out = await signal.claimAcross(['a', 'b', 'c'], PASSES, s.tryClaim, { step: STEP });
    assert.deepEqual(out, { id: 'job-b' });
    assert.deepEqual(s.asked, ['a:p0', 'b:p0'], 'the walk stops at the first claim');
    assert.deepEqual(hinted(signal, ['a', 'b', 'c']), ['b']);
  });

  it('threw -> neither note: a failing HINTED space stays hinted, and the claim goes on to the next space', async () => {
    const { signal, lines } = make();
    signal.markSpaceMayHaveWork('a');
    const s = script({ a: boom(), 'b:p0': { id: 'job-b' } });
    const out = await signal.claimAcross(['a', 'b'], PASSES, s.tryClaim, { step: STEP });
    assert.deepEqual(out, { id: 'job-b' }, 'a failing space does not stop the claim for the space behind it');
    assert.ok(hinted(signal, ['a', 'b']).includes('a'), 'a threw: it must not have been noted empty');
    assert.equal(lines.length, 1);
    assert.match(lines[0], new RegExp(`^${STEP} failed for space 'a': .*boom.* — retried next claim$`));
  });

  it('empty in the first pass and THROWN in the second -> not noteEmpty', async () => {
    const { signal } = make();
    signal.markSpaceMayHaveWork('a');
    const s = script({ 'a:p1': boom() });
    assert.equal(await signal.claimAcross(['a'], PASSES, s.tryClaim, { step: STEP }), null);
    assert.deepEqual(hinted(signal, ['a']), ['a']);
  });

  it('a space that threw is not asked again in the claim\'s later passes: one failure costs one call', async () => {
    const { signal } = make();
    const s = script({ a: boom() });
    await signal.claimAcross(['a', 'b'], ['p0', 'p1', 'p2'], s.tryClaim, { step: STEP });
    assert.deepEqual(s.asked.filter(x => x.startsWith('a:')), ['a:p0'], 'six failed calls per claim would be six bounds');
  });

  it('skipped (quarantined) -> neither note: it stays hinted, and nothing claims it', async () => {
    const { signal } = make();
    signal.markSpaceMayHaveWork('q');
    await signal.claimAcross(['q'], PASSES, script({ q: timeout() }).tryClaim, { step: STEP });
    const s = script();
    assert.equal(await signal.claimAcross(['q', 'e'], PASSES, s.tryClaim, { step: STEP }), null);
    assert.ok(!s.asked.some(x => x.startsWith('q:')), 'a quarantined space is skipped, a full scan included');
    assert.ok(s.asked.some(x => x.startsWith('e:')));
    spendFullScan(signal, ['q', 'e']);
    signal.markSpaceMayHaveWork('q');
    await signal.claimAcross(['q', 'e'], PASSES, script().tryClaim, { step: STEP });
    assert.ok(hinted(signal, ['q', 'e']).includes('q'), 'skipped is not "answered empty": the hint is kept');
  });

  it('every space threw -> null, and it does not throw', async () => {
    const { signal } = make();
    const out = await signal.claimAcross(['a', 'b'], PASSES, script({ a: boom(), b: boom() }).tryClaim, { step: STEP });
    assert.equal(out, null);
  });

  it('the store is down -> null, neither note called, one `store` line, and nothing after the first space is asked', async () => {
    const { signal, lines } = make();
    signal.markSpaceMayHaveWork('a');
    signal.markSpaceMayHaveWork('b');
    const s = script({ a: storeDown() });
    assert.equal(await signal.claimAcross(['a', 'b'], PASSES, s.tryClaim, { step: STEP }), null);
    assert.deepEqual(s.asked, ['a:p0'], 'a walk that carried on would pay one bound per space');
    assert.deepEqual(hinted(signal, ['a', 'b']).sort(), ['a', 'b'], 'neither was noted: the store, not the spaces, failed');
    assert.equal(lines.length, 1);
    assert.match(lines[0], new RegExp(`^${STEP} stopped: the store is not answering`));
  });

  it('a bound that ended an operation on a store that does not answer its ping is the store\'s: null, one line, no quarantine', async () => {
    const { signal, lines, walk } = make({ storeUp: false });
    assert.equal(await signal.claimAcross(['a', 'b'], PASSES, script({ a: timeout() }).tryClaim, { step: STEP }), null);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /the store is not answering/);
    assert.deepEqual(walk.quarantinedSpaces(), []);
  });

  it('K = 3 timeouts on distinct spaces end the whole claim, later passes included', async () => {
    const { signal, lines } = make();
    const ids = ['a', 'b', 'c', 'd', 'e'];
    const s = script(Object.fromEntries(ids.map(i => [i, timeout()])));
    assert.equal(await signal.claimAcross(ids, PASSES, s.tryClaim, { step: STEP }), null);
    assert.equal(STALLED_AFTER_TIMEOUTS, 3);
    assert.deepEqual(s.asked, ['a:p0', 'b:p0', 'c:p0'], 'the fourth space is never asked, and pass 2 never starts on a stalled store');
    assert.ok(lines.some(l => /timed out in a row/.test(l)));
  });
});

describe('claimAcross: the passes belong to the caller, and the probe slot is consumed once', () => {
  it('lanes run ACROSS spaces: every space in pass 1 before any in pass 2', async () => {
    const { signal } = make();
    const s = script();
    await signal.claimAcross(['a', 'b'], ['p0', 'p1', 'p2'], s.tryClaim, { step: STEP });
    assert.deepEqual(s.asked, ['a:p0', 'b:p0', 'a:p1', 'b:p1', 'a:p2', 'b:p2']);
  });

  it('a lane-2 job behind an empty lane-0 is still claimed, in a space that was not hinted (the full scan is consumed once per claim)', async () => {
    const { signal } = make();
    const s = script({ 'b:p2': { id: 'lane-2' } });
    const out = await signal.claimAcross(['a', 'b'], ['p0', 'p1', 'p2'], s.tryClaim, { step: STEP });
    assert.deepEqual(out, { id: 'lane-2' }, 'a probe taken per pass would see only the hinted spaces from the second pass on');
    assert.deepEqual(hinted(signal, ['a', 'b']), ['b']);
  });

  it('a space with only lane-2 work is not dropped from the hint after an empty lane-0 pass', async () => {
    const { signal } = make();
    signal.markSpaceMayHaveWork('a');
    await signal.claimAcross(['a'], ['p0', 'p2'], script({ 'a:p2': { id: 'x' } }).tryClaim, { step: STEP });
    assert.deepEqual(hinted(signal, ['a']), ['a']);
  });

  it('with nothing hinted and no full scan due, no space is asked at all', async () => {
    const { signal } = make();
    spendFullScan(signal, ['a']);
    const s = script();
    assert.equal(await signal.claimAcross(['a'], PASSES, s.tryClaim, { step: STEP }), null);
    assert.deepEqual(s.asked, []);
  });

  it('no passes, or no spaces, is a null claim and not an error', async () => {
    const { signal } = make();
    assert.equal(await signal.claimAcross([], PASSES, script().tryClaim, { step: STEP }), null);
    assert.equal(await signal.claimAcross(['a'], [], script().tryClaim, { step: STEP }), null);
  });
});

describe('claimAcross: the quarantine of a space whose claim hung', () => {
  it('the first timeout starts it (60 s), and the claim goes on to the next space', async () => {
    const { signal, lines, walk } = make();
    const out = await signal.claimAcross(['h', 'ok'], PASSES, script({ h: timeout(), 'ok:p0': { id: 'j' } }).tryClaim, { step: STEP });
    assert.deepEqual(out, { id: 'j' });
    assert.equal(QUARANTINE_BASE_MS, 60_000);
    assert.match(lines[0], /— retried after quarantine \(60s\)$/);
    assert.deepEqual(walk.quarantinedSpaces(), ['h']);
  });

  it('a second claim does NOT ask the space again: it costs no second bound', async () => {
    const { signal, clock } = make();
    await signal.claimAcross(['h', 'ok'], PASSES, script({ h: timeout() }).tryClaim, { step: STEP });
    clock.t += 1_000;
    const s = script({ 'ok:p0': { id: 'j' } });
    assert.deepEqual(await signal.claimAcross(['h', 'ok'], PASSES, s.tryClaim, { step: STEP }), { id: 'j' });
    assert.ok(!s.asked.some(x => x.startsWith('h:')));
  });

  it('after the window it is asked once: a claim while the probe is out skips it', async () => {
    const { signal, clock } = make();
    await signal.claimAcross(['h'], PASSES, script({ h: timeout() }).tryClaim, { step: STEP });
    clock.t += QUARANTINE_BASE_MS + 1;
    let release;
    const gate = new Promise(r => { release = r; });
    const probing = signal.claimAcross(['h'], PASSES, async (id) => { await gate; return id === 'h' ? { id: 'back' } : null; }, { step: STEP });
    const second = script();
    await signal.claimAcross(['h'], PASSES, second.tryClaim, { step: STEP });
    assert.deepEqual(second.asked, [], 'one probe per lift');
    release();
    assert.deepEqual(await probing, { id: 'back' });
  });

  it('a write (markSpaceMayHaveWork) lifts it for ONE probe', async () => {
    const { signal } = make();
    await signal.claimAcross(['h'], PASSES, script({ h: timeout() }).tryClaim, { step: STEP });
    signal.markSpaceMayHaveWork('h');
    const probe = script({ 'h:p0': { id: 'landed' } });
    assert.deepEqual(await signal.claimAcross(['h'], PASSES, probe.tryClaim, { step: STEP }), { id: 'landed' });
    assert.deepEqual(probe.asked, ['h:p0']);
  });

  it('a failing probe puts the quarantine back, and the next claim skips', async () => {
    const { signal } = make();
    await signal.claimAcross(['h'], PASSES, script({ h: timeout() }).tryClaim, { step: STEP });
    signal.markSpaceMayHaveWork('h');
    await signal.claimAcross(['h'], PASSES, script({ h: timeout() }).tryClaim, { step: STEP });
    const later = script();
    await signal.claimAcross(['h'], PASSES, later.tryClaim, { step: STEP });
    assert.deepEqual(later.asked, []);
  });

  it('a success resets the backoff: the next timeout is 60 s again, not doubled', async () => {
    const { signal, clock, lines } = make();
    await signal.claimAcross(['h'], PASSES, script({ h: timeout() }).tryClaim, { step: STEP });
    clock.t += QUARANTINE_BASE_MS + 1;
    await signal.claimAcross(['h'], PASSES, script().tryClaim, { step: STEP });
    clock.t += 10 * 60_000;
    await signal.claimAcross(['h'], PASSES, script({ h: timeout() }).tryClaim, { step: STEP });
    const said = lines.filter(l => /quarantine \(/.test(l)).map(l => /quarantine \((\d+)s\)/.exec(l)[1]);
    assert.deepEqual(said.slice(-1), ['60']);
  });
});

describe('claimAcross: every operation a claim issues is bounded by CLAIM_OP_MS', () => {
  after(() => wb.setWriteBoundForTest(null));

  it('a read inside tryClaim carries timeoutMS === CLAIM_OP_MS, in every pass, whatever the housekeeping figure is', async () => {
    wb.setWriteBoundForTest({ housekeepingOpMs: 4321 });
    const { signal } = make();
    const seen = [];
    await signal.claimAcross(['a'], ['p0', 'p1'], async () => {
      await wb.callBounded('find', [{}, {}], (args) => { seen.push(args[1].timeoutMS); return Promise.resolve([]); }, { collection: 'a_embed_jobs', inheritedTimeoutMs: undefined });
      return null;
    }, { step: STEP });
    assert.deepEqual(seen, [wb.CLAIM_OP_MS, wb.CLAIM_OP_MS]);
  });

  it('a timeout line names the claim\'s figure and not the housekeeping setting', async () => {
    const { signal, lines } = make();
    await signal.claimAcross(['a'], PASSES, script({ a: timeout() }).tryClaim, { step: STEP });
    assert.match(lines[0], /10000 ms/);
    assert.doesNotMatch(lines[0], /YTHRIL_HOUSEKEEPING_OP_TIMEOUT_MS/);
  });

  it('an enclosing scope can only tighten it', async () => {
    const { signal } = make();
    let seen;
    await wb.withinHousekeepingBound(() => signal.claimAcross(['a'], ['p0'], async () => {
      await wb.callBounded('find', [{}, {}], (args) => { seen = args[1].timeoutMS; return Promise.resolve([]); }, { collection: 'a_embed_jobs', inheritedTimeoutMs: undefined });
      return null;
    }, { step: STEP }), { opMs: 1_500 });
    assert.equal(seen, 1_500);
  });
});
