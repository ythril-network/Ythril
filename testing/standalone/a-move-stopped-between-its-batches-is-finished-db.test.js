/**
 * A move that stops partway is finished, and a move that cannot be finished is abandoned without touching what is at its
 * destination (bundle-44, Q-342, Q-345; plan rev 3 D3, D4, D4b). The four stops the plan names, each driven against the real store.
 *
 * ## What is asserted
 *
 *  1. **A fault in batch 2 of 3.** A directory move whose records go in three transactions (the byte budget narrowed to one row a
 *     batch, `setMoveTimingForTest`): batch 1 is at the destination whole, batches 2 and 3 are wholly at the source with their links, the
 *     door answered `503 move_still_owed`, the marker is kept, and housekeeping finishes the rest.
 *  2. **A commit that landed and whose reply was lost.** The batch is read back, found at its new id and gone from its old one, and
 *     the move is a success — not a `503` over a move that happened, not a second run of a batch that already ran.
 *  3. **A process that died after the bytes.** Nothing ran any more: the hold on the file's job ran out, and the media worker, which
 *     finds no bytes at the old path, removes nothing of the owed move (its records, its job, its marker). Housekeeping then finishes
 *     it, the job re-keyed with the file.
 *  4. **Bytes at the destination that are not the moved ones.** An unrelated file replaced them (a different size) after the move
 *     stopped: the move is no longer owed, nothing at the destination is overwritten, and when the marker is cleared the links the
 *     move had converged onto the destination are taken back off it — the destination is not linked to what a file that is not there
 *     was linked to.
 *
 * Every case drives the real doors (the REST handler) and the real cascade; the fault is an error the driver produced
 * (`driverWriteFailures`) or, for the lost reply, the commit the store really applied (`loseNextCommitReply`).
 *
 * Run: node --test testing/standalone/a-move-stopped-between-its-batches-is-finished-db.test.js
 * (requires a prior `npm run build` in server/, the test MongoDB, and a private IPv4 on the host)
 */
import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { openFileActDoors } from './_file-act-doors.mjs';
import { driverWriteFailures, loseNextCommitReply } from './_write-faults.mjs';
import { waitFor } from '../_shared/wait-for.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();

const S = 'batchstop';
const DAY = 24 * 3_600_000;
const LATER = () => new Date(Date.now() + DAY);
const T0 = '2026-09-01T00:00:00.000Z';
const E1 = '11111111-1111-4111-8111-111111111111';
const E2 = '22222222-2222-4222-8222-222222222222';

let acts, F, tombstones, finish, walk, timing, queue, worker, meta, adjacency;

const files = () => acts.door.coll(S, 'files');
const row = (id) => files().findOne({ _id: id });
const status = (a) => acts.statusOf(a);
const body = (a) => JSON.stringify(a.body ?? a.text);
const linkTargets = async (id) => (await adjacency.linksStartingFrom(S, [id])).map(r => `${r.toKind}:${r.to}`).sort();

/**
 * The Nth call of `insertMany` on the files collection fails (the one that writes a batch's rows). The wrapper counts the calls
 * itself: `failWrites` arms the NEXT call, and the rows of batch 1 are written by one that must succeed.
 */
function failFilesInsertOnCall(n, err) {
  const proto = Object.getPrototypeOf(acts.door.mongo.col('probe'));
  const original = proto.insertMany;
  let calls = 0;
  let fired = 0;
  proto.insertMany = async function counted(...args) {
    if (this.collectionName === `${S}_files` && ++calls === n) { fired++; throw err; }
    return original.apply(this, args);
  };
  return { restore: () => { proto.insertMany = original; }, fired: () => fired };
}

/** One housekeeping pass over the space, inside a walk as production runs it. */
async function pass(now) {
  let outcome;
  const runner = walk.createHousekeepingWalk({ storeAnswers: async () => true });
  const result = await runner.eachSpace('TTL sweep: finishing interrupted file moves', [{ id: S }], async () => { outcome = await finish.finishOwedMoves(S, now); });
  return { outcome, failed: result.failed };
}

/** Entities a file can link to, and a file linked to both. */
async function seedLinked(p) {
  await acts.seed(p, { description: `description of ${p}` });
  await meta.updateFileMeta(S, p, { linkEntities: [E1, E2] });
}

describe('a move stopped partway is finished, an abandoned one is not (real MongoDB)', { skip }, () => {
  before(async () => {
    acts = await openFileActDoors({ suite: 'batchstop', space: S });
    F = await driverWriteFailures('ythril_harness_batchstop');
    tombstones = await import('../../server/dist/files/tombstones.js');
    finish = await import('../../server/dist/files/finish-owed-moves.js');
    walk = await import('../../server/dist/util/housekeeping-walk.js');
    timing = await import('../../server/dist/files/move-timing.js');
    queue = await import('../../server/dist/files/media/job-queue.js');
    worker = await import('../../server/dist/files/media/worker.js');
    meta = await import('../../server/dist/files/file-meta.js');
    adjacency = await import('../../server/dist/brain/link-adjacency.js');
    const { getConfig } = await import('../../server/dist/config/loader.js');
    getConfig().mediaEmbedding = {
      levels: { images: 'caption' }, visionProvider: 'local', workerPollIntervalMs: 100, workerMaxPollIntervalMs: 200,
      faceRecognition: { enabled: false },
    };
  });
  after(async () => { worker?.stopMediaEmbeddingWorker(); timing?.setMoveTimingForTest(null); await acts?.close(); });
  beforeEach(async () => {
    await acts.reset();
    for (const part of ['links', 'entities', 'media_jobs', 'tombstones']) await acts.door.coll(S, part).deleteMany({});
    const now = new Date().toISOString();
    await acts.door.coll(S, 'entities').insertMany([E1, E2].map((_id, i) => ({ _id, spaceId: S, name: `E${i}`, type: 'thing', tags: [], createdAt: now, seq: i + 1, author: { instanceId: 'x', instanceLabel: 'x' } })));
  });
  afterEach(() => { worker.stopMediaEmbeddingWorker(); timing.setMoveTimingForTest(null); });

  it('a fault in batch 2 of 3: batch 1 is at the destination, the rest wholly at the source, the door says 503, and housekeeping finishes it', async () => {
    // One row a batch: three files, three transactions.
    timing.setMoveTimingForTest({ txnBytes: 1 });
    for (const n of ['a', 'b', 'c']) await seedLinked(`dir/${n}.txt`);
    const fault = failFilesInsertOnCall(2, F.storeGone.single);
    let a;
    try { a = await acts.move('REST', 'dir', 'moved'); } finally { fault.restore(); }

    assert.equal(fault.fired(), 1, 'the fault never fired: the move does not write its rows in a batch per file');
    assert.equal(status(a), 503, `the stopped move was not answered 503: ${body(a)}`);
    assert.equal((a.body ?? a.sc).code, 'move_still_owed', body(a));
    for (const n of ['a', 'b', 'c']) assert.ok(acts.onDisk(`moved/${n}.txt`) && !acts.onDisk(`dir/${n}.txt`), `the bytes of ${n} did not move`);
    const at = async (p) => (await row(p)) !== null;
    assert.deepEqual([await at('moved/a.txt'), await at('dir/a.txt')], [true, false], 'batch 1 is not whole at the destination');
    for (const n of ['b', 'c']) {
      assert.deepEqual([await at(`moved/${n}.txt`), await at(`dir/${n}.txt`)], [false, true], `batch of ${n}: half moved, or lost`);
      assert.deepEqual(await linkTargets(`dir/${n}.txt`), [`entity:${E1}`, `entity:${E2}`], `the links of ${n} left its record`);
    }
    assert.deepEqual(await linkTargets('moved/a.txt'), [`entity:${E1}`, `entity:${E2}`], 'the links of batch 1 did not follow it');
    assert.deepEqual(await linkTargets('dir/a.txt'), [], 'batch 1 left its links at the source');
    assert.equal((await tombstones.moveMarkerOf(S, 'dir', 'moved')) !== undefined, true, 'the marker was not kept');
    assert.equal(await tombstones.moveIsOwed(S, 'dir', 'moved'), true, 'the stopped move is not owed');

    const done = await pass(LATER());
    assert.equal(done.outcome.finished, 1, `housekeeping did not finish the move: ${JSON.stringify(done)}`);
    for (const n of ['a', 'b', 'c']) {
      assert.ok(await row(`moved/${n}.txt`), `moved/${n}.txt has no record after the move was finished`);
      assert.equal(await row(`dir/${n}.txt`), null, `dir/${n}.txt is still at the source`);
      assert.deepEqual(await linkTargets(`moved/${n}.txt`), [`entity:${E1}`, `entity:${E2}`]);
      assert.deepEqual(await linkTargets(`dir/${n}.txt`), []);
    }
    assert.equal((await tombstones.moveMarkerOf(S, 'dir', 'moved')) !== undefined, false, 'a finished move kept its marker');
  });

  it('a commit that landed and whose reply was lost is a landed batch: the move succeeds and runs nothing twice', async () => {
    await seedLinked('one.txt');
    await acts.door.coll(S, 'files').insertOne({ _id: 'one.txt#chunk-0', spaceId: S, path: 'one.txt#chunk-0', parentFileId: 'one.txt', content: 'c', tags: [], createdAt: T0, updatedAt: T0, sizeBytes: 1 });
    const lost = await loseNextCommitReply(acts.door.mongo);
    let a;
    try { a = await acts.move('REST', 'one.txt', 'two.txt'); } finally { lost.restore(); }

    assert.ok(lost.fired(), 'no commit reply was lost: the move does not commit a transaction');
    assert.ok(!acts.failed(a), `a batch that landed was answered as a failure (${status(a)}): ${body(a)}`);
    assert.ok(await row('two.txt') && await row('two.txt#chunk-0'), 'the rows are not at the destination');
    assert.equal(await row('one.txt'), null);
    assert.equal(await row('one.txt#chunk-0'), null);
    assert.deepEqual(await linkTargets('two.txt'), [`entity:${E1}`, `entity:${E2}`]);
    assert.deepEqual(await linkTargets('one.txt'), []);
    assert.equal((await tombstones.moveMarkerOf(S, 'one.txt', 'two.txt')) !== undefined, false, 'the finished move kept its marker');
  });

  it('a move whose process died after the bytes: the worker, finding no bytes at the old path after the hold ran out, removes nothing, and housekeeping finishes it', async () => {
    await acts.seed('pics/from.png');
    await queue.enqueueMediaJob(S, 'pics/from.png', 'image/png', 'image');
    // The records' re-key never ran: everything after the bytes is what a killed process leaves.
    const fault = failFilesInsertOnCall(1, new Error('the process died'));
    let a;
    try { a = await acts.move('REST', 'pics/from.png', 'pics/to.png'); } finally { fault.restore(); }
    assert.equal(status(a), 503, `the move was not stopped after its bytes: ${body(a)}`);
    assert.ok(acts.onDisk('pics/to.png') && !acts.onDisk('pics/from.png'), 'the bytes did not move');

    // The hold ran out (ten minutes; nothing that held it is running).
    await acts.door.coll(S, 'media_jobs').updateOne({ _id: 'pics/from.png' }, { $set: { claimableAfter: null } });
    worker.startMediaEmbeddingWorker();
    try {
      await waitFor(async () => { const j = await acts.door.coll(S, 'media_jobs').findOne({ _id: 'pics/from.png' }); return j === null || j.attempts >= 1; }, 30_000, 50,
        async () => `the worker never claimed the job: ${JSON.stringify(await acts.door.coll(S, 'media_jobs').findOne({ _id: 'pics/from.png' }))}`);
    } finally { worker.stopMediaEmbeddingWorker(); }
    await waitFor(async () => { const j = await acts.door.coll(S, 'media_jobs').findOne({ _id: 'pics/from.png' }); return j === null || j.status !== 'processing'; }, 30_000, 50);

    assert.ok(await row('pics/from.png'), 'the worker removed the record of a move that was owed');
    assert.ok(await acts.door.coll(S, 'media_jobs').findOne({ _id: 'pics/from.png' }), 'the worker removed the job of a move that was owed');
    assert.equal((await tombstones.moveMarkerOf(S, 'pics/from.png', 'pics/to.png')) !== undefined, true, 'the marker was forgotten');

    const done = await pass(LATER());
    assert.equal(done.outcome.finished, 1, `housekeeping did not finish the move: ${JSON.stringify(done)}`);
    assert.ok(await row('pics/to.png'), 'the record did not follow the file');
    assert.equal(await row('pics/from.png'), null);
    assert.ok(await acts.door.coll(S, 'media_jobs').findOne({ _id: 'pics/to.png' }), 'the job did not follow the file');
    assert.equal(await acts.door.coll(S, 'media_jobs').findOne({ _id: 'pics/from.png' }), null);
  });

  it('bytes at the destination that are not the moved ones: not owed, nothing overwritten, and the links the move put at the destination are taken back off when the marker is cleared', async () => {
    await seedLinked('from.txt');
    const fault = failFilesInsertOnCall(1, F.storeGone.single);
    let a;
    try { a = await acts.move('REST', 'from.txt', 'to.txt'); } finally { fault.restore(); }
    assert.equal(status(a), 503, `the move was not stopped: ${body(a)}`);
    assert.deepEqual(await linkTargets('to.txt'), [`entity:${E1}`, `entity:${E2}`], 'fixture: the stopped move put no links at the destination');
    assert.deepEqual(await linkTargets('from.txt'), [`entity:${E1}`, `entity:${E2}`], 'fixture: the stopped move took the links off the source');

    // An unrelated file replaces the moved bytes at the destination: another size.
    const unrelated = 'an entirely different and longer file that somebody wrote at the destination afterwards';
    fs.writeFileSync(path.join(acts.root(), 'to.txt'), unrelated);
    assert.equal(await tombstones.moveIsOwed(S, 'from.txt', 'to.txt'), false, 'the bytes at the destination are not the moved ones, and the move is still owed');

    const retry = await acts.move('REST', 'from.txt', 'to.txt');
    assert.equal(status(retry), 404, `the retry of an abandoned move was not refused as a source that names nothing: ${body(retry)}`);
    assert.equal(fs.readFileSync(path.join(acts.root(), 'to.txt'), 'utf8'), unrelated, 'the move overwrote the unrelated file at the destination');
    assert.equal(await row('to.txt'), null, 'the move wrote a record over an unrelated file');
    assert.deepEqual(await linkTargets('to.txt'), [], 'the destination is still linked to what a file that is not there was linked to');
    assert.deepEqual(await linkTargets('from.txt'), [`entity:${E1}`, `entity:${E2}`], 'the abandoned move took the links off the source');
    assert.equal((await tombstones.moveMarkerOf(S, 'from.txt', 'to.txt')) !== undefined, false, 'the marker of an abandoned move was not cleared');
  });
});
