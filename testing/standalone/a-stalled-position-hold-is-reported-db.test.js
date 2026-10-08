/**
 * A file-tombstone POSITION hold that stalls is VISIBLE, and while it is open nothing reads above it — the position
 * instance's case of the report the seq hold already gives (`a-stalled-seq-hold-is-reported-db`; Q-346, bundle-71 D1,
 * gate T6c).
 *
 * ## The defect it would otherwise be
 *
 * The position hold keeps the push's pages and the prune below a stamp whose write has not landed. A hold whose write
 * does not settle therefore stops file-tombstone replication of the space, exactly as a stalled seq hold stops records,
 * and with the same symptom: every cycle succeeds over a short page. Without a gauge and a line nobody can see it, and a
 * hold that is never released holds the cap down for ever.
 *
 * ## The rule this file holds, a case for each of what the seq file holds and one more
 *
 *  1. **While a hold is open, the cap is pinned below it** (`settledPositionCap`): two reads apart return the same
 *     position, and it is older than the read, where an open space's cap follows the clock.
 *  2. **While it is open, `ythril_file_tombstone_oldest_hold_seconds{space}` reports its age**; once the space holds
 *     nothing, the series reads 0. The gauge is POISONED (-1) before the stall, so a gauge nobody wrote cannot pass by
 *     reading a plausible zero.
 *  3. **A hold that ended after the warn age logs one line**:
 *     `file tombstone position held <age>s space=<id> at=<iso> holder=<h> ended=<ok|timeout|error>`, read from the server's
 *     own log ring, so a line written anywhere else does not count.
 *  4. **When the bound ends the stalled write the hold is released**: the cap follows the clock again.
 *
 * ## The stall
 *
 * Real (`_write-faults.mjs holdDocumentLock`): another session's open transaction locks the PENDING tombstone's row, so the
 * publish's upsert of it waits inside its hold. The bound is 2 s through the write bound's seam, so the hold outlives the
 * warn age (half the deadline) and the bound ends it as `timeout`. The names and the line's shape are the plan's (rev 3,
 * D1); on the unchanged code there is no cap, no gauge and no line, each its own red.
 *
 * Run: node --test testing/standalone/a-stalled-position-hold-is-reported-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openFileActDoors } from './_file-act-doors.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { holdDocumentLock, settleWithin, setWriteBoundForTest } from './_write-faults.mjs';
import { sleep } from '../_shared/sleep.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();

const S = 'poshreport';
const GAUGE = 'ythril_file_tombstone_oldest_hold_seconds';
const BOUND = { writeTimeoutMs: 2000, holdDeadlineMs: 2000 };
/** Half the deadline: the hold must outlive it for the release line to be owed. */
const WARN_MS = BOUND.holdDeadlineMs / 2;
const CAP_MS = BOUND.holdDeadlineMs + 1500;
const POISON = -1;

let acts;
const seen = { seamError: null, capMissing: false, gaugeMissing: false, settledDuring: undefined, capA: undefined, capB: undefined,
  readAt: undefined, during: undefined, after: undefined, capAfterA: undefined, capAfterB: undefined, lines: [], res: null };

/** The gauge's value for `space`, or undefined (no series), or the string 'missing' (no such metric). */
async function gaugeFor(register, space) {
  const m = register.getSingleMetric(GAUGE);
  if (!m) return 'missing';
  const { values } = await m.get();
  return values.find(v => v.labels?.space === space)?.value;
}

describe('a stalled file-tombstone position hold is reported', { skip }, () => {
  let restoreBound = () => {};

  before(async () => {
    acts = await openFileActDoors({ suite: 'poshreport', space: S });
    const tombstones = await import('../../server/dist/files/tombstones.js');
    const { register } = await import('../../server/dist/metrics/registry.js');
    const { subscribeLogLines } = await import('../../server/dist/util/log.js');
    try { restoreBound = await setWriteBoundForTest(BOUND); } catch (err) { seen.seamError = err; }
    seen.capMissing = typeof tombstones.settledPositionCap !== 'function';
    const metric = register.getSingleMetric(GAUGE);
    if (metric) metric.set({ space: S }, POISON); else seen.gaugeMissing = true;

    await acts.seed('stalled.txt');
    const pending = await tombstones.writePendingFileTombstones(S, ['stalled.txt']);
    assert.equal(pending.docs.length, 1, 'fixture: no pending tombstone was written');
    const unsubscribe = subscribeLogLines(l => { seen.lines.push(l); });
    const lock = await holdDocumentLock(acts.door.mongo, `${S}_file_tombstones`, { filter: { _id: pending.docs[0]._id } });
    try {
      let done = false;
      const op = Promise.resolve().then(() => tombstones.confirmFileTombstones(pending)).finally(() => { done = true; });
      // Past the warn age, still inside the bound: the hold is open and old enough to owe a report.
      await sleep(WARN_MS + 300);
      seen.settledDuring = done;
      seen.readAt = new Date().toISOString();
      if (!seen.capMissing) {
        seen.capA = await tombstones.settledPositionCap(S);
        await sleep(50);
        seen.capB = await tombstones.settledPositionCap(S);
      }
      seen.during = await gaugeFor(register, S);
      seen.res = await settleWithin(op, CAP_MS - WARN_MS - 300);
      seen.after = await gaugeFor(register, S);
    } finally {
      await lock.release();
      unsubscribe();
    }
    if (!seen.res?.settled) await seen.res?.rest;
    if (!seen.capMissing) {
      seen.capAfterA = await tombstones.settledPositionCap(S);
      await sleep(20);
      seen.capAfterB = await tombstones.settledPositionCap(S);
    }
  });
  after(async () => { restoreBound(); await acts?.close(); });

  it('fixture: the publish stalled inside its hold, past the warn age and inside the bound', () => {
    assert.equal(seen.settledDuring, false, 'the publish settled while its row was locked — the stall was not reached, so nothing below proves anything');
  });

  it('the write bound has a test seam (db/write-bound.ts setWriteBoundForTest)', () => {
    assert.equal(seen.seamError, null, seen.seamError?.message);
  });

  it('while the hold is open the cap is pinned below it, older than the read', () => {
    assert.equal(seen.capMissing, false, 'files/tombstones.ts exports no settledPositionCap — a page and a prune have nothing to stop them below an open hold');
    assert.equal(seen.capA, seen.capB, `the cap moved from ${seen.capA} to ${seen.capB} while a hold was open: it follows the clock, so it is not held`);
    const olderThanTheRead = new Date(Date.parse(seen.readAt) - WARN_MS / 2).toISOString();
    assert.ok(seen.capA < olderThanTheRead, `the cap ${seen.capA} is not below the hold's stamp (a hold open >= ${WARN_MS} ms; read at ${seen.readAt})`);
  });

  it(`while the hold is open, ${GAUGE}{space} reports its age`, () => {
    assert.equal(seen.gaugeMissing, false, `no metric named ${GAUGE} is registered — an operator cannot see a stalled position hold`);
    assert.notEqual(seen.during, POISON, `the gauge still holds the poison ${POISON}: nothing wrote it while the hold was open`);
    assert.ok(typeof seen.during === 'number' && seen.during >= WARN_MS / 1000, `the gauge read ${seen.during} for a hold open ${WARN_MS + 300} ms`);
  });

  it('a hold that outlived the warn age logs one line when it ends, naming space, position, holder and how it ended', () => {
    const re = new RegExp(`file tombstone position held (\\d+(?:\\.\\d+)?)s\\b.*\\bspace=${S}\\b.*\\bat=(\\S+).*\\bholder=(\\S+).*\\bended=(ok|timeout|error)`);
    const hits = seen.lines.map(l => re.exec(l)).filter(Boolean);
    assert.equal(hits.length, 1,
      `expected one release line for the stalled position hold (the write ${seen.res?.settled ? `ended after ${seen.res.elapsedMs} ms` : 'never ended'}); `
      + `the log ring held ${seen.lines.length} line(s): ${JSON.stringify(seen.lines.slice(-5))}`);
    const [, age, at, holder, ended] = hits[0];
    assert.ok(Number(age) >= WARN_MS / 1000, `the line reports an age of ${age}s for a hold open past ${WARN_MS} ms`);
    assert.ok(Number.isFinite(Date.parse(at)), `the line's position ${at} is not an ISO instant`);
    assert.ok(holder && holder !== 'undefined', 'the line does not name its holder');
    assert.equal(ended, 'timeout', 'the bound ended this hold, and the line must say so');
  });

  it('once the bound has ended the write the hold is released: the gauge reads 0 and the cap follows the clock', () => {
    assert.equal(seen.gaugeMissing, false, `no metric named ${GAUGE} is registered`);
    assert.equal(seen.after, 0, `after the hold ended the gauge reads ${seen.after}`);
    assert.equal(seen.capMissing, false, 'files/tombstones.ts exports no settledPositionCap');
    assert.ok(seen.capAfterB > seen.capAfterA, `the cap did not move (${seen.capAfterA}, then ${seen.capAfterB}) once nothing was held: the hold was never released`);
  });
});
