/**
 * Housekeeping finishes the moves it began: an owed move is carried to its destination by the instance, within a budget, with a wait
 * between attempts, and is stranded rather than looped on or deleted (bundle-44, Q-345; plan rev 3 D4, D7).
 *
 * ## The defect
 *
 * A move whose bytes moved and whose records did not was finished only if the caller RETRIED: a peer's rename, a client that gave up
 * and a script that read the `503` and went on never did. The file then sat listed at a path that held no bytes, and the first thing
 * that looked at it (the media worker, the settle) took it for a deleted source. `a-stopped-move-is-finished-not-forgotten-db` holds
 * that nothing forgets the move; this holds that something FINISHES it.
 *
 * ## What is asserted, over the real cascade and the real store
 *
 * - A move inside the settle window (its request may still be running) is left alone; past it, the TTL sweep's own step finishes it:
 *   the record is at the destination and gone from the source, the marker is cleared, one tombstone for the source is published,
 *   the instance audits `file.move.finish`, counts it, and the owed gauge reads 0 after the pass.
 * - A move that keeps failing is counted on its marker, is not tried again before its wait is over, and after its attempts is
 *   STRANDED: the marker is kept, no further attempt is made, the stranded gauge says so, and a retry of the move then finishes it.
 * - The budget per pass holds: with a budget of one, three owed moves take three passes, none is starved behind the first.
 * - What a pass finds is what the owed gauge reads: an owed move is counted and its age is read from its marker.
 *
 * Run: node --test testing/standalone/housekeeping-finishes-an-owed-move-db.test.js   (after `npm run build:server`)
 */
import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { openFileActDoors } from './_file-act-doors.mjs';
import { driverWriteFailures, failWrites } from './_write-faults.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();
const S = 'owedhk';
const FILES = `${S}_files`;
const DAY = 24 * 3_600_000;
/** Past the settle threshold and every wait: `n` days on. */
const LATER = (n = 1) => new Date(Date.now() + n * DAY);

let acts, tombstones, finish, walk, registry, seen, sweep, F, faults;

const row = (p) => acts.door.coll(S, 'files').findOne({ _id: p });
const liveRow = async (p) => { const r = await row(p); return r && !r.deletedAt ? r : null; };
const status = (a) => acts.statusOf(a);
const fail = (method, collection, err, opts) => faults.fail(method, collection, err, opts);

/** A move a store failure stopped after its bytes: the file at `to`, its record still at `from`, its marker kept. */
async function moveStoppedAfterItsBytes(from, to) {
  await acts.seed(from);
  fail('deleteMany', FILES, F.storeGone.single);
  const a = await acts.move('REST', from, to);
  assert.equal(status(a), 503, `the move was not stopped by the store: ${JSON.stringify(a.body ?? a.text)}`);
  assert.ok(acts.onDisk(to) && !acts.onDisk(from), 'the bytes did not move — the case is not the one a stopped move leaves');
  assert.equal((await tombstones.moveMarkerOf(S, from, to)) !== undefined, true, 'the move left no marker — the case is not reached');
}

/**
 * One pass of the completion over the space, inside a walk as production runs it; what it did, and what failed in it. The walk
 * is the module's own runner with the store question answered "yes": a fault the test injects is a failure of the SPACE, and the
 * production question pings the instance's configured database, which the harness does not run.
 */
async function pass(now, limits) {
  let outcome;
  const runner = walk.createHousekeepingWalk({ storeAnswers: async () => true });
  const result = await runner.eachSpace('TTL sweep: finishing interrupted file moves', [{ id: S }], async () => { outcome = await finish.finishOwedMoves(S, now, limits); });
  return { outcome, failed: result.failed };
}

const finishedCount = async () => {
  const metric = await registry.fileMovesFinishedByHousekeepingTotal.get();
  return metric.values.find(v => v.labels.space === S)?.value ?? 0;
};

describe('housekeeping finishes an owed move', { skip }, () => {
  before(async () => {
    acts = await openFileActDoors({ suite: 'owedhk', space: S });
    F = await driverWriteFailures('ythril_harness_owedhk');
    tombstones = await import('../../server/dist/files/tombstones.js');
    finish = await import('../../server/dist/files/finish-owed-moves.js');
    walk = await import('../../server/dist/util/housekeeping-walk.js');
    registry = await import('../../server/dist/metrics/registry.js');
    seen = await import('../../server/dist/files/owed-moves-seen.js');
    sweep = await import('../../server/dist/brain/ttl-sweep.js');
    faults = failWrites(Object.getPrototypeOf(acts.door.mongo.col('probe')), ['insertMany', 'deleteOne', 'deleteMany']);
  });
  after(async () => { faults?.restore(); await acts?.close(); });
  beforeEach(async () => { faults.clear(); await acts.reset(); await acts.door.coll(S, 'audit_log').deleteMany({}).catch(() => {}); });
  afterEach(() => faults.clear());

  it('leaves a move inside the settle window to its own request, and the TTL sweep finishes it once it is past it', async () => {
    await moveStoppedAfterItsBytes('hk/from.txt', 'hk/to.txt');
    const before = await finishedCount();

    await sweep.sweepExpired(new Date());
    assert.ok(await liveRow('hk/from.txt'), 'the sweep finished a move whose request may still be running');
    assert.equal((await tombstones.moveMarkerOf(S, 'hk/from.txt', 'hk/to.txt')) !== undefined, true, 'the marker of a move still inside its window was cleared');

    await sweep.sweepExpired(LATER());
    assert.ok(await liveRow('hk/to.txt'), 'the record did not follow the file to its destination: nothing finished the move');
    assert.equal(await row('hk/from.txt'), null, 'the record is still at the source');
    assert.equal((await tombstones.moveMarkerOf(S, 'hk/from.txt', 'hk/to.txt')) !== undefined, false, 'a finished move kept its marker');
    assert.deepEqual((await acts.raw()).filter(t => !t.pending).map(t => t.path).sort(), ['hk/from.txt'], 'the path the move left is not tombstoned, once');
    assert.equal(await finishedCount(), before + 1, 'the finished move was not counted');
    const audit = await acts.door.mongo.getDb().collection('audit_log').find({ spaceId: S, operation: 'file.move.finish' }).toArray();
    assert.equal(audit.length, 1, `the instance finished a move no request named and did not audit it: ${JSON.stringify(audit)}`);
    assert.equal(seen.owedMoveCount(S), 0, 'the owed gauge still reads a move that is finished');
  });

  it('counts an attempt on the marker, waits before the next, strands the move after its attempts and keeps its marker', async () => {
    await moveStoppedAfterItsBytes('st/from.txt', 'st/to.txt');
    const limits = { attempts: 2, backoffBaseMs: 60 * 60_000 };
    // A failure that is not the store's: the cascade survives it, so what says the move did not finish is the pass asking again.
    fail('deleteMany', FILES, new Error('the record step failed'), { times: 100 });

    const first = await pass(LATER(1), limits);
    assert.equal(first.outcome.finished, 0, 'the move finished with the store failing');
    assert.equal(first.failed.length, 1, 'the failed attempt was not reported through the walk');
    let marker = await tombstones.moveMarkerOf(S, 'st/from.txt', 'st/to.txt');
    assert.equal(marker.attempts, 1, 'the attempt was not counted on the marker');
    assert.ok(typeof marker.nextAttemptAt === 'string' && marker.nextAttemptAt > LATER(1).toISOString(), 'the marker names no wait before the next attempt');

    const waiting = await pass(LATER(1), limits);
    assert.equal(waiting.outcome.waiting, 1, 'a move inside its wait was not left waiting');
    assert.equal((await tombstones.moveMarkerOf(S, 'st/from.txt', 'st/to.txt')).attempts, 1, 'a move inside its wait was tried again');

    const second = await pass(LATER(2), limits);
    assert.equal((await tombstones.moveMarkerOf(S, 'st/from.txt', 'st/to.txt')).attempts, 2, 'the second attempt was not made once its wait was over');
    assert.equal(second.outcome.finished, 0);

    const stranded = await pass(LATER(3), limits);
    assert.equal(stranded.outcome.stranded, 1, 'a move whose attempts are spent was not counted stranded');
    assert.equal(stranded.failed.length, 1, 'a stranded move was not said through the walk');
    marker = await tombstones.moveMarkerOf(S, 'st/from.txt', 'st/to.txt');
    assert.equal(marker.attempts, 2, 'a stranded move was tried again');
    assert.equal(seen.strandedMoveCount(S), 1, 'the stranded gauge does not count it');
    assert.equal(seen.owedMoveCount(S), 1, 'a stranded move is owed still');
    assert.ok(await liveRow('st/from.txt'), 'a stranded move lost its record');

    // The marker is kept: the retry of the request still finishes it.
    faults.clear();
    const retry = await acts.move('REST', 'st/from.txt', 'st/to.txt');
    assert.ok(!acts.failed(retry), `the retry of a stranded move was refused (${status(retry)}): ${JSON.stringify(retry.body ?? retry.text)}`);
    assert.ok(await liveRow('st/to.txt'), 'the retry did not finish the stranded move');
  });

  it('finishes at most its budget per pass, and the moves behind the first are not starved', async () => {
    for (const n of ['a', 'b', 'c']) await moveStoppedAfterItsBytes(`bud/${n}-from.txt`, `bud/${n}-to.txt`);
    const limits = { finishedPerTick: 1 };
    const finished = [];
    for (let i = 0; i < 3; i++) {
      const { outcome } = await pass(LATER(1), limits);
      finished.push(outcome.finished);
      assert.ok(outcome.finished <= 1, `a pass finished ${outcome.finished} moves with a budget of one`);
    }
    assert.deepEqual(finished, [1, 1, 1], `the passes finished ${JSON.stringify(finished)}: a move was starved or the budget was ignored`);
    for (const n of ['a', 'b', 'c']) assert.ok(await liveRow(`bud/${n}-to.txt`), `bud/${n} was not finished`);
  });

  it('publishes what a complete pass found to the owed gauge, with the age of the oldest marker', async () => {
    await moveStoppedAfterItsBytes('g/from.txt', 'g/to.txt');
    // Nothing is tried: every attempt is spent, so the pass only looks.
    await acts.door.coll(S, 'file_tombstones').updateMany({ 'move.from': 'g/from.txt' }, { $set: { 'move.attempts': 99 } });
    const marked = await acts.door.coll(S, 'file_tombstones').findOne({ 'move.from': 'g/from.txt' });
    const back = new Date(Date.parse(marked.deletedAt) - 3_600_000).toISOString();
    await acts.door.coll(S, 'file_tombstones').updateMany({ 'move.from': 'g/from.txt' }, { $set: { deletedAt: back } });
    await pass(new Date(), { attempts: 1 });
    assert.equal(seen.owedMoveCount(S), 1, 'the owed gauge does not count an owed move');
    assert.ok(seen.oldestOwedMoveAgeSeconds(S) >= 3_590, `the oldest age reads ${seen.oldestOwedMoveAgeSeconds(S)}s for a marker written an hour ago`);
  });
});
