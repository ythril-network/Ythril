/**
 * The absent-bytes sweep walks a space once per pass, a walk longer than a tick does not stop the pass, it says what a pass did once, the removal
 * cap passes no due row by, and the awaiting-bytes gauge says what the stats say (bundle-70 lens fix, findings 2, 4 and 6).
 *
 * ## The defects
 *
 *  2. `sweepAbsentBytes` walked the space on EVERY tick of a pass, then read pages only while the tick's budget lasted: a walk longer than the
 *     budget read no page on any tick, never completed the pass and repeated its I/O every cycle; a pass of several ticks walked once per tick,
 *     where the docs say once per pass.
 *  4. The audit entry and the log line were written per tick, where the docs say one per space per pass; and due rows past the tick's removal cap
 *     sat on a page the cursor passed, so they waited for the next pass, a day later, counted neither held nor removed.
 *  6. `ythril_files_awaiting_bytes` was set only when a pass completed (to the pass's absent count, which includes the rows it then removed) and
 *     a restore's or an import's restart never reset it.
 *
 * ## The rule
 *
 *  - a walk slower than the tick's budget still lets the pass complete over the following ticks, with that one walk;
 *  - a pass of several ticks walks once; the next pass walks once more;
 *  - a pass whose removals fall in several ticks writes ONE audit entry naming them all;
 *  - due rows past the cap are removed by the next tick of the same pass;
 *  - the gauge equals `filesAwaitingBytes` after a tick that removed rows, and after a restart.
 *
 * Driven through `sweepExpired(now)` with the step seam (`walk`, `tickBudgetMs`, `pageSize`, `pagesPerTick`), as every sweep suite is.
 *
 * Red on 92e1ca8f: the walk seam is never asked (the walk is not counted; the slow-walk case counts 0 walks), two audit entries for one pass,
 * one of the 201 due rows left after the pass, and the gauge at 1 after the removal and after the restart.
 *
 * Run: node --test testing/standalone/the-absent-bytes-sweep-walks-once-per-pass-and-says-it-once-db.test.js
 * (requires a prior `npm run build -w @ythril/server`, and the test MongoDB)
 */
import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { openFileActDoors } from './_file-act-doors.mjs';
import { waitFor } from '../_shared/wait-for.mjs';
import { elapse } from '../_shared/sleep.mjs';
import { NOW, DAY, after as at, SHA_PRESENT, runPass, sweepSteps, resetSweepSteps, sweepOperation, orphan, retired } from './_absent-bytes-sweep.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();
const S = 'absentonce';
const LATER = at(DAY + 3_600_000);

let acts, loader, sweep, manifest, knownKeys, operation;
const rows = () => acts.door.coll(S, 'files');
const rowOf = (p) => rows().findOne({ _id: p });
const entryOf = () => loader.getConfig().spaces.find(s => s.id === S);
const auditRows = () => acts.door.mongo.getDb().collection('audit_log').find({ spaceId: S, operation }).toArray();

async function healthy(n) { for (let i = 0; i < n; i++) await acts.seed(`ok${String(i).padStart(4, '0')}.txt`, { sha256: SHA_PRESENT, seq: 1 }); }
async function lose(paths) { if (paths.length) await rows().insertMany(paths.map(p => orphan(S, p))); }

/** Ticks at `now` until the pass that is under way (or starts) completes; answers how many ticks it took. */
async function untilComplete(now, most = 30) {
  for (let n = 1; n <= most; n++) {
    await runPass(now);
    const scan = entryOf().absentBytesScan;
    if (scan?.running === undefined && scan?.last !== undefined && scan.last.completedAt === now.toISOString()) return n;
  }
  assert.fail(`the pass at ${now.toISOString()} did not complete in ${most} ticks: ${JSON.stringify(entryOf().absentBytesScan)}`);
}

/** The step seam with a counted walk (the real walk, after `delayMs`). */
async function countedWalk(extra = {}, delayMs = 0) {
  const walks = { n: 0 };
  (await sweepSteps())({
    ...extra,
    walk: async (id) => {
      if (id === S) walks.n++;
      if (delayMs > 0) await elapse(delayMs, 'simulated latency: a walk slower than the tick budget the case sets');
      return manifest.buildFileManifest(id, undefined, { listOnly: true });
    },
  });
  return walks;
}

/** The awaiting-bytes gauge of the space. */
async function gauge() {
  const { filesAwaitingBytesGauge } = await import('../../server/dist/metrics/registry.js');
  return (await filesAwaitingBytesGauge.get()).values.find(v => v.labels.space === S)?.value;
}

describe('the absent-bytes sweep walks once per pass and says it once (real MongoDB)', { skip }, () => {
  before(async () => {
    acts = await openFileActDoors({ suite: 'absentonce', space: S });
    loader = await import('../../server/dist/config/loader.js');
    sweep = await import('../../server/dist/files/absent-bytes-sweep.js');
    manifest = await import('../../server/dist/files/manifest.js');
    knownKeys = Object.keys(entryOf());
    operation = await sweepOperation();
  });
  after(async () => { await resetSweepSteps(); await acts?.close(); });
  beforeEach(async () => {
    await acts.reset();
    await acts.door.mongo.getDb().collection('audit_log').deleteMany({ spaceId: S }).catch(() => {});
    const entry = entryOf();
    for (const k of Object.keys(entry).filter(k => !knownKeys.includes(k))) delete entry[k];
    loader.getConfig().softDeleteFileMeta = false;
  });
  afterEach(async () => { await resetSweepSteps(); });

  it('a walk slower than the tick budget still lets the pass complete over the next ticks, with that one walk (finding 2)', async () => {
    await healthy(4);
    await lose(['gone.txt']);
    const walks = await countedWalk({ tickBudgetMs: 150, pageSize: 1, pagesPerTick: 100 }, 400);

    const ticks = await untilComplete(NOW, 10);

    assert.equal(walks.n, 1, `the pass walked ${walks.n} times: the walk repeats every tick and eats the tick's budget`);
    assert.ok(ticks >= 2, `fixture: the pass completed in ${ticks} tick, so the walk did not outlast the budget`);
    assert.equal((await rowOf('gone.txt'))?.bytesAbsentSince, NOW.toISOString(), 'the pass completed without stamping the absent row');
  });

  it('a pass of several ticks walks once, and the next pass walks once more (finding 2: the docs\' "once per pass")', async () => {
    await healthy(4);
    await lose(['gone.txt']);
    const walks = await countedWalk({ pageSize: 1, pagesPerTick: 1 });

    const ticks = await untilComplete(NOW);
    assert.ok(ticks >= 4, `fixture: the pass took ${ticks} tick(s), not several`);
    assert.equal(walks.n, 1, `a pass of ${ticks} ticks walked the space ${walks.n} times`);
    await untilComplete(LATER);
    assert.equal(walks.n, 2, `the second pass walked ${walks.n - 1} times`);
  });

  it('a pass whose removals fall in several ticks writes one audit entry naming them all (finding 4)', async () => {
    await healthy(4);
    await lose(['a-gone.txt', 'z-gone.txt']);
    await countedWalk({ pageSize: 1, pagesPerTick: 1 });
    await untilComplete(NOW);
    await untilComplete(LATER);
    assert.ok(retired(await rowOf('a-gone.txt')) && retired(await rowOf('z-gone.txt')), 'fixture: the second pass did not remove both rows');

    await waitFor(async () => (await auditRows()).length >= 1, 5000, 50, 'no audit entry', { what: 'the sweep\'s audit entry' }).catch(() => {});
    await elapse(300, 'absence window: a second audit entry of the same pass');
    const audit = await auditRows();
    assert.equal(audit.length, 1, `one pass wrote ${audit.length} audit entries: ${JSON.stringify(audit.map(a => a.changes))}`);
    const said = JSON.stringify(audit[0]);
    assert.ok(said.includes('a-gone.txt') && said.includes('z-gone.txt'), `the pass's entry does not name both rows it removed: ${said}`);
  });

  it('due rows past the tick\'s removal cap are removed by the next tick of the same pass, not a pass later (finding 4)', async () => {
    const over = sweep.ABSENT_BYTES_REMOVALS_PER_TICK + 1;
    await healthy(over);
    const lost = Array.from({ length: over }, (_, i) => `lost${String(i).padStart(4, '0')}.txt`);
    await lose(lost);
    await untilComplete(NOW);
    await untilComplete(LATER);

    const left = (await rows().find({ _id: { $in: lost } }).toArray()).filter(r => !retired(r)).map(r => r._id);
    assert.deepEqual(left, [], `${left.length} due row(s) past the cap were passed by the cursor and wait a day for the next pass`);
  });

  it('the awaiting-bytes gauge is what filesAwaitingBytes answers after a tick that removed rows and after a restart (finding 6)', async () => {
    await healthy(4);
    await lose(['gone.txt']);
    await untilComplete(NOW);
    assert.equal(await gauge(), 1, 'fixture: the first pass did not count the stamped row');
    await untilComplete(LATER);
    assert.ok(retired(await rowOf('gone.txt')), 'fixture: the second pass did not remove the row');
    assert.equal(await sweep.filesAwaitingBytes(S), 0, 'fixture: the stats still count the removed row');
    assert.equal(await gauge(), 0, 'the gauge counts a row the pass removed: it says another number than the stats');

    await lose(['gone2.txt']);
    await untilComplete(at(3 * DAY));
    assert.equal(await gauge(), 1, 'fixture: the third pass did not count the stamped row');
    await sweep.restartAbsentBytesSweeps([S]);
    assert.equal(await sweep.filesAwaitingBytes(S), 0, 'fixture: the restart did not clear the stamp');
    assert.equal(await gauge(), 0, 'the restart cleared every stamp and the gauge still says a row waits');
  });
});
