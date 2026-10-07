/**
 * A seq hold that stalls is VISIBLE: its age is a gauge while it is held, and the hold logs a line when it ends
 * (`Q-200`, bundle-30 plan §A6).
 *
 * ## The defect
 *
 * A hold whose write does not settle stops replication of its space (`Q-213`, and
 * `a-write-inside-a-seq-hold-always-ends-db` holds the bound that ends it). Until it ends, nothing says so: the
 * in-flight registry in `util/seq.ts` keeps counts only — no holder, no start time — so no metric can report its
 * age and no line names it. The operator sees peers reporting empty pages and every cycle succeeding.
 *
 * ## The rule this file holds
 *
 *  1. **While a hold is open, `ythril_seq_horizon_oldest_hold_seconds{space}` reports its age**; once the space
 *     holds nothing, the series reads 0. The gauge is POISONED (-1) before the stall, so a gauge nobody wrote
 *     cannot pass by reading a plausible zero.
 *  2. **A hold that ended after `HOLD_WARN_MS` logs, at release, one line**:
 *     `seq horizon held <age>s space=<id> seq=<n> holder=<h> ended=<ok|timeout|error>` — read from the server's
 *     own log ring (`subscribeLogLines`), so a line written anywhere else does not count.
 *
 * The watchdog's warn-while-held line (plan §A6, "warned once by a watchdog started with the scheduler") is NOT
 * asserted here: the scheduler is not started in a -db test, and the release line is the half every hold logs.
 *
 * ## The stall
 *
 * Real (`_write-faults.mjs holdDocumentLock`): another session's open transaction locks the fact the update
 * writes, so the update waits inside its hold. The bound is set to 2 s through the plan's test seam, so the hold
 * lasts past `HOLD_WARN_MS` (half the deadline) and the bound ends it as `timeout`. On the unchanged code there is
 * no seam, no gauge and no line — and the write hangs until the test releases the lock; each is its own red.
 *
 * Run: a Mongo the harness accepts (see `_mongo-harness.mjs`), then
 *      node --test testing/standalone/a-stalled-seq-hold-is-reported-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openPushDoor, build } from './_push-door.mjs';
import { holdDocumentLock, settleWithin, eventually, setWriteBoundForTest } from './_write-faults.mjs';
import { sleep } from '../_shared/sleep.mjs';

const skip = await mongoSkipReason();
process.env['YTHRIL_MODELS_OFFLINE'] = '1';

const P = 'holdreport';
const F = 'bbbbbbbb-0000-4000-8000-0000000000f2';
const GAUGE = 'ythril_seq_horizon_oldest_hold_seconds';
const BOUND = { writeTimeoutMs: 2000, holdDeadlineMs: 2000 };
/** Half the deadline, as the plan defines `HOLD_WARN_MS`: the hold must outlive it for the release line to be owed. */
const WARN_MS = BOUND.holdDeadlineMs / 2;
const CAP_MS = BOUND.holdDeadlineMs + 1500;
const POISON = -1;

let door;
const seen = { seamError: null, gaugeMissing: false, heldAt: undefined, during: undefined, after: undefined, lines: [], res: null };

/** The gauge's value for `space`, or undefined (no series), or the string 'missing' (no such metric). */
async function gaugeFor(register, space) {
  const m = register.getSingleMetric(GAUGE);
  if (!m) return 'missing';
  const { values } = await m.get();
  return values.find(v => v.labels?.space === space)?.value;
}

describe('a stalled seq hold is reported', { skip }, () => {
  let restoreBound = () => {};

  before(async () => {
    door = await openPushDoor({ suite: 'holdreport', spaces: [{ id: P, label: P, folders: [], meta: { suppressEmbeddings: true } }] });
    const seq = await import('../../server/dist/util/seq.js');
    const { register } = await import('../../server/dist/metrics/registry.js');
    const { subscribeLogLines } = await import('../../server/dist/util/log.js');
    const fact = await import('../../server/dist/brain/fact.js');
    try { restoreBound = await setWriteBoundForTest(BOUND); } catch (err) { seen.seamError = err; }

    await door.coll(P, 'facts').insertOne(build.fact(P, F, 3));
    await door.setCounter(P, 3);
    const metric = register.getSingleMetric(GAUGE);
    if (metric) metric.set({ space: P }, POISON); else seen.gaugeMissing = true;

    const unsubscribe = subscribeLogLines(l => { seen.lines.push(l); });
    const lock = await holdDocumentLock(door.mongo, `${P}_facts`, { filter: { _id: F } });
    try {
      let done = false;
      const op = Promise.resolve().then(() => fact.updateFact(P, F, { fact: 'stalled edit' })).finally(() => { done = true; });
      await eventually(() => done || seq.lowestUncommittedSeq(P) !== undefined, 5000);
      seen.heldAt = seq.lowestUncommittedSeq(P);
      // Past the warn age, still inside the bound: the hold is open and old enough to owe a report.
      await sleep(WARN_MS + 300);
      seen.during = await gaugeFor(register, P);
      seen.res = await settleWithin(op, CAP_MS - WARN_MS - 300);
      seen.after = await gaugeFor(register, P);
    } finally {
      await lock.release();
      unsubscribe();
    }
    if (!seen.res?.settled) await seen.res?.rest;
  });
  after(async () => { restoreBound(); await door?.close(); });

  it('fixture: the update stalled inside a seq hold', () => {
    assert.equal(typeof seen.heldAt, 'number', 'the fact update never entered its hold — re-anchor the stall');
  });

  it('the write bound has a test seam (db/write-bound.ts setWriteBoundForTest)', () => {
    assert.equal(seen.seamError, null, seen.seamError?.message);
  });

  it(`while the hold is open, ${GAUGE}{space} reports its age`, () => {
    assert.equal(seen.gaugeMissing, false, `no metric named ${GAUGE} is registered — an operator cannot see a stalled hold`);
    assert.notEqual(seen.during, POISON, `the gauge still holds the poison ${POISON}: nothing wrote it while the hold on seq ${seen.heldAt} was open`);
    assert.ok(typeof seen.during === 'number' && seen.during >= WARN_MS / 1000,
      `the gauge read ${seen.during} for a hold open ${WARN_MS + 300} ms`);
  });

  it('a hold that outlived the warn age logs one line when it ends, naming space, seq, holder and how it ended', () => {
    const re = new RegExp(`seq horizon held (\\d+(?:\\.\\d+)?)s space=${P} seq=(\\d+) holder=(\\S+) ended=(ok|timeout|error)`);
    const hits = seen.lines.map(l => re.exec(l)).filter(Boolean);
    assert.equal(hits.length, 1,
      `expected one release line for the stalled hold on seq ${seen.heldAt} (the write ${seen.res?.settled ? `ended after ${seen.res.elapsedMs} ms` : 'never ended'}); `
      + `the log ring held ${seen.lines.length} line(s): ${JSON.stringify(seen.lines.slice(-5))}`);
    const [, age, s, holder, ended] = hits[0];
    assert.equal(Number(s), seen.heldAt, 'the line names another seq than the one held');
    assert.ok(Number(age) >= WARN_MS / 1000, `the line reports an age of ${age}s for a hold open past ${WARN_MS} ms`);
    assert.ok(holder && holder !== 'undefined', 'the line does not name its holder');
    assert.equal(ended, 'timeout', 'the bound ended this hold, and the line must say so');
  });

  it('once the space holds nothing, the gauge reads 0', () => {
    assert.equal(seen.gaugeMissing, false, `no metric named ${GAUGE} is registered`);
    assert.equal(seen.after, 0, `after the hold ended the gauge reads ${seen.after}`);
  });
});
