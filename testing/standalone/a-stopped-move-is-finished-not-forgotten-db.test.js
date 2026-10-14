/**
 * A move a failure stopped AFTER its bytes is finished, never forgotten: nothing that runs by itself may drop it, and an act
 * that cannot be recorded does not begin (bundle-44, Q-345; plan rev 3 D4, D4b, D8).
 *
 * ## The defect
 *
 * A move carries the bytes first and the records after. A store failure between the two leaves the bytes at `to`, the record
 * (its links, its job) at `from`, and the MARKER the move wrote with its tombstones: the marker is the only thing that tells a
 * retry "this is a move I began", as against an orphan `from` beside an unrelated file at `to`. Three things used to forget
 * the move behind its back, and each strands the records at `from` for ever:
 *
 * - the TTL sweep's settle forgot the marker of ANY move whose bytes were at `to` and none at `from`, once it was ten minutes
 *   old — it never asked whether the record was still at `from`, so the retry answered 404;
 * - the media worker, once the job's hold had run out, found no bytes at the old path and reconciled "a deleted source": it
 *   REMOVED the stranded record, the job and the artefacts;
 * - a delete of the destination (the file the move was carrying, deleted where it went) left the record at `from`, and no
 *   delete would ever reach it.
 *
 * And two acts began with no tombstone at all: the pending tombstone write logged a failure that was not the store's and
 * returned nothing, so the move went on, and so did a delete — the bytes went, no peer was told, and a peer's manifest
 * brought the file back. A move onto ITSELF published a tombstone for a file that was still there.
 *
 * ## What is asserted — the rule, on every door that reaches it
 *
 * - The settle keeps the marker of a move that is still owed (a live record at `from`, the bytes at `to`), and the retry of
 *   that move completes it. A marker whose move FINISHED (the record is at `to`) is still forgotten: the control, green today.
 * - The worker's deleted-source reconcile removes nothing of an owed move, after the hold ran out, and the move then completes.
 * - A tombstone write that fails for a reason that is not the store's refuses the move and both delete doors (the file delete,
 *   on REST and on MCP, and the directory delete) BEFORE a byte moves or goes: bytes and records in place, no tombstone.
 * - A delete of the destination of an owed move leaves nothing of the file at the source.
 * - A move onto itself publishes no tombstone, and the file is still there, listed and recorded.
 *
 * Every case drives the real doors and the real cascades over the real store; the injected error of a store failure is the
 * one the driver produced (`driverWriteFailures`), and the one that is NOT a store failure is a plain `Error`.
 *
 * Run: node --test testing/standalone/a-stopped-move-is-finished-not-forgotten-db.test.js
 */
import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { openFileActDoors } from './_file-act-doors.mjs';
import { driverWriteFailures, failWrites } from './_write-faults.mjs';
import { waitFor } from '../_shared/wait-for.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();
const S = 'owedmove';
const FILES = `${S}_files`;
const TOMBSTONES = `${S}_file_tombstones`;
const JOBS = `${S}_media_jobs`;
const DAY = 24 * 3_600_000;
/** Past the settle's staleness window: every marker is old enough to be "past its act". */
const PAST = () => new Date(Date.now() + DAY);

let acts, tombstones, markerMod, F, faults, worker, queue;

const row = (p) => acts.door.coll(S, 'files').findOne({ _id: p });
/** A row a reader would list: there, and not flagged by a soft delete. */
const liveRow = async (p) => { const r = await row(p); return r && !r.deletedAt ? r : null; };
const jobOf = (p) => acts.door.coll(S, 'media_jobs').findOne({ _id: p });
const publishedPaths = async () => (await acts.raw()).filter(t => !t.pending).map(t => t.path).sort();
const everyTombstonePath = async () => (await acts.raw()).map(t => t.path).sort();
const status = (a) => acts.statusOf(a);
const body = (a) => JSON.stringify(a.body ?? a.text);

/** The next call of `method` on `collection` fails as `failWrites` fails it. */
const fail = (method, collection, err, opts) => faults.fail(method, collection, err, opts);

/**
 * A move a store failure stopped after its bytes: the file is at `to`, its record still at `from`, its marker kept. The failure is
 * in the RECORD step (the records' re-key transaction), the one the outage test uses, so every step before it ran.
 */
async function moveStoppedAfterItsBytes(from, to, via = 'REST') {
  await acts.seed(from);
  fail('deleteMany', FILES, F.storeGone.single);
  const a = await acts.move(via, from, to);
  assert.equal(status(a), 503, `the move was not stopped by the store: ${body(a)}`);
  assert.ok(acts.onDisk(to) && !acts.onDisk(from), 'the bytes did not move — the case is not the one a stopped move leaves');
  assert.ok(await row(from), 'the record is not at the source — the case is not the one a stopped move leaves');
  assert.equal((await markerMod.moveMarkerOf(S, from, to)) !== undefined, true, 'the move left no marker — the case is not reached');
}

describe('a stopped move is finished, not forgotten, and an act that cannot be recorded does not begin', { skip }, () => {
  before(async () => {
    acts = await openFileActDoors({ suite: 'owedmove', space: S });
    F = await driverWriteFailures('ythril_harness_owedmove');
    tombstones = await import('../../server/dist/files/tombstones.js');
    markerMod = await import('../../server/dist/files/move-markers.js');
    worker = await import('../../server/dist/files/media/worker.js');
    queue = await import('../../server/dist/files/media/job-queue.js');
    // What the worker needs to run and, for a file it cannot find, do nothing with a provider: no endpoint is called.
    const { getConfig } = await import('../../server/dist/config/loader.js');
    getConfig().mediaEmbedding = {
      levels: { images: 'caption' }, visionProvider: 'local', workerPollIntervalMs: 100, workerMaxPollIntervalMs: 200,
      faceRecognition: { enabled: false },
    };
    faults = failWrites(Object.getPrototypeOf(acts.door.mongo.col('probe')), ['insertMany', 'deleteOne', 'deleteMany']);
  });
  after(async () => {
    worker?.stopMediaEmbeddingWorker();
    faults?.restore();
    await acts?.close();
  });
  beforeEach(async () => {
    faults.clear();
    await acts.reset();
    for (const part of ['media_jobs', 'links', 'tombstones']) await acts.door.coll(S, part).deleteMany({});
  });
  afterEach(() => { worker.stopMediaEmbeddingWorker(); faults.clear(); });

  // ── The settle ──────────────────────────────────────────────────────────────────────────────────────────────────────

  for (const via of ['REST', 'MCP']) {
    it(`${via}: the TTL settle keeps the marker of a move that is still owed — the record is at the source`, async () => {
      await moveStoppedAfterItsBytes('from.txt', 'to.txt', via);
      await tombstones.settleStalePendingFileTombstones(S, PAST());
      assert.equal((await markerMod.moveMarkerOf(S, 'from.txt', 'to.txt')) !== undefined, true,
        'the settle forgot the marker of a move whose record is still at the source: the retry is taken for an orphan and answers 404, and the record is stranded');
    });

    it(`${via}: the retry of a stopped move completes it after the settle has run past its marker`, async () => {
      await moveStoppedAfterItsBytes('from.txt', 'to.txt', via);
      await tombstones.settleStalePendingFileTombstones(S, PAST());
      const retry = await acts.move(via, 'from.txt', 'to.txt');
      assert.ok(!acts.failed(retry), `the retried move was refused (${status(retry)}): ${body(retry)}`);
      assert.ok(await liveRow('to.txt'), 'the record did not follow the file to its destination');
      assert.equal(await row('from.txt'), null, 'the record is still at the source');
      assert.deepEqual(await publishedPaths(), ['from.txt'], 'the path the move left is not tombstoned, once');
    });
  }

  it('control: the settle still forgets the marker of a move that FINISHED (its record is at the destination)', async () => {
    await moveStoppedAfterItsBytes('done-from.txt', 'done-to.txt');
    // The record reaches the destination another way — what a finished move leaves when only the clearing of its marker failed.
    const files = acts.door.coll(S, 'files');
    const r = await files.findOne({ _id: 'done-from.txt' });
    await files.deleteOne({ _id: 'done-from.txt' });
    await files.insertOne({ ...r, _id: 'done-to.txt', path: 'done-to.txt' });
    await tombstones.settleStalePendingFileTombstones(S, PAST());
    assert.equal((await markerMod.moveMarkerOf(S, 'done-from.txt', 'done-to.txt')) !== undefined, false,
      'a finished move\'s marker was kept: a later orphan at the source would be taken for this move');
  });

  // ── The media worker ────────────────────────────────────────────────────────────────────────────────────────────────

  it('the media worker, finding no bytes at the old path after the hold ran out, removes nothing of an owed move', async () => {
    await acts.seed('pics/from.png');
    await queue.enqueueMediaJob(S, 'pics/from.png', 'image/png', 'image');
    // The job's re-keying is the first record step: the store fails there, so the job is HELD at the old path with the bytes gone.
    fail('deleteMany', JOBS, F.storeGone.single);
    const a = await acts.move('REST', 'pics/from.png', 'pics/to.png');
    assert.equal(status(a), 503, `the move was not stopped by the store: ${body(a)}`);
    assert.ok(acts.onDisk('pics/to.png') && !acts.onDisk('pics/from.png'), 'the bytes did not move — the case is not reached');
    const held = await jobOf('pics/from.png');
    assert.ok(held && held.claimableAfter, `the job is not held at the old path — the case is not reached: ${JSON.stringify(held)}`);
    assert.ok(await liveRow('pics/from.png'), 'the record is not at the source — the case is not reached');

    // The hold has run out (it lasts ten minutes; the move that took it is not running any more).
    await acts.door.coll(S, 'media_jobs').updateOne({ _id: 'pics/from.png' }, { $set: { claimableAfter: null } });
    worker.startMediaEmbeddingWorker();
    try {
      // The worker has claimed it (a claim counts an attempt) or has already ended it.
      await waitFor(async () => { const j = await jobOf('pics/from.png'); return j === null || j.attempts >= 1; }, 30_000, 50,
        async () => `the worker never claimed the held job: ${JSON.stringify(await jobOf('pics/from.png'))}`);
    } finally { worker.stopMediaEmbeddingWorker(); }
    // A run in flight finishes its reconcile after the stop.
    await waitFor(async () => { const j = await jobOf('pics/from.png'); return j === null || j.status !== 'processing'; }, 30_000, 50,
      async () => `the worker's run never ended: ${JSON.stringify(await jobOf('pics/from.png'))}`);

    assert.ok(await liveRow('pics/from.png'),
      'the worker reconciled "a deleted source" and removed the record of a file that was MOVED: the move can no longer be completed');
    assert.ok(await jobOf('pics/from.png'), 'the worker removed the job of an owed move');
    assert.equal((await markerMod.moveMarkerOf(S, 'pics/from.png', 'pics/to.png')) !== undefined, true, 'the move was forgotten');

    const retry = await acts.move('REST', 'pics/from.png', 'pics/to.png');
    assert.ok(!acts.failed(retry), `the retried move was refused (${status(retry)}): ${body(retry)}`);
    assert.ok(await liveRow('pics/to.png'), 'the record did not follow the file');
  });

  // ── A tombstone that cannot be written ──────────────────────────────────────────────────────────────────────────────

  const notTheStore = () => new Error('the tombstone could not be built');

  /** The answer every door gives an act it could not record: 500, `act_not_recorded`, and the path the act was asked about. */
  const assertNotRecorded = (via, a, path) => {
    const answer = acts.answerOf(a);
    assert.equal(answer.status, 500, `${via}: the act was not refused as a failure of the server: ${answer.status} ${body(a)}`);
    assert.equal(answer.code, 'act_not_recorded', `${via}: the answer carries code ${JSON.stringify(answer.code)}: ${body(a)}`);
    assert.equal(answer.path, path, `${via}: the answer names path ${JSON.stringify(answer.path)}, not the one the act was asked about: ${body(a)}`);
    assert.equal(answer.retryAfter, undefined, `${via}: an act nothing did carries a Retry-After`);
  };

  // `TOOL` is `POST /api/<tool>`: the third door that reaches the same answer, carrying it as `data`.
  for (const via of ['REST', 'TOOL', 'MCP']) {
    it(`${via}: a move whose tombstone write fails for a reason that is not the store's is refused before a byte moves`, async () => {
      await acts.seed('keep.txt');
      fail('insertMany', TOMBSTONES, notTheStore());
      const a = await acts.move(via, 'keep.txt', 'moved.txt');
      assertNotRecorded(via, a, 'keep.txt');
      assert.ok(acts.onDisk('keep.txt') && !acts.onDisk('moved.txt'), 'the bytes moved although nothing could record the move: no peer is told, and the manifest brings the old path back');
      assert.ok(await liveRow('keep.txt') && !await row('moved.txt'), 'the record moved with a move that was not recorded');
      assert.deepEqual(await everyTombstonePath(), [], 'a tombstone was left behind for an act that did not begin');
    });

    it(`${via}: a file delete whose tombstone write fails for a reason that is not the store's is refused before the bytes go`, async () => {
      await acts.seed('stay.txt');
      fail('insertMany', TOMBSTONES, notTheStore());
      const a = await acts.del(via, 'stay.txt');
      assertNotRecorded(via, a, 'stay.txt');
      assert.ok(acts.onDisk('stay.txt'), 'the bytes went although the deletion could not be recorded: a peer pushes the file back');
      assert.ok(await liveRow('stay.txt'), 'the record went with a delete that was not recorded');
    });
  }

  it('a directory delete whose tombstone write fails for a reason that is not the store\'s is refused before the tree goes', async () => {
    await acts.seed('tree/one.txt');
    await acts.seed('tree/two.txt');
    fail('insertMany', TOMBSTONES, notTheStore());
    const a = await acts.rest('DELETE', { path: 'tree' }, { confirm: true });
    assertNotRecorded('REST', a, 'tree');
    assert.ok(acts.onDisk('tree/one.txt') && acts.onDisk('tree/two.txt'), 'the tree went although the deletion could not be recorded');
    assert.ok(await liveRow('tree/one.txt') && await liveRow('tree/two.txt'), 'the records went with a delete that was not recorded');
  });

  // ── A delete at the destination of an owed move ─────────────────────────────────────────────────────────────────────

  for (const via of ['REST', 'MCP']) {
    it(`${via}: deleting the destination of an owed move leaves nothing of the file at the source`, async () => {
      await moveStoppedAfterItsBytes('gone-from.txt', 'gone-to.txt');
      const del = await acts.del(via, 'gone-to.txt');
      assert.ok(!acts.failed(del), `the delete of the file where the move put it was refused: ${body(del)}`);
      assert.equal(acts.onDisk('gone-to.txt'), false, 'the bytes are still there');
      assert.equal(await liveRow('gone-from.txt'), null,
        'the file was deleted where it went, and its record is still live at the source: nothing will ever delete it, and it lists a file that has no bytes');
      // Nothing of it is left to complete: the retried move finds a file that is gone, not a move to finish.
      const retry = await acts.move(via, 'gone-from.txt', 'gone-to.txt');
      assert.equal(status(retry), 404, `the retried move of a deleted file: ${body(retry)}`);
      assert.equal(acts.onDisk('gone-to.txt'), false, 'the retried move brought the deleted file back');
    });
  }

  // The links of the file (Q-464): a delete at the destination removes the links this instance wrote from the source's name AND the
  // destination's, and the marker goes in the same act. Before, a link the delete left kept the move "owed" for ever: the marker stayed
  // and the next file uploaded at the source path was taken for the rest of this move.
  for (const via of ['REST', 'MCP']) {
    it(`${via}: deleting the destination of an owed move removes the links of both names, and clears the marker in the same act`, async () => {
      await acts.seed('lk-from.txt');
      const own = [await acts.links.put('lk-from.txt', 'e1', 'self'), await acts.links.put('lk-from.txt', 'e2', 'none'), await acts.links.put('lk-from.txt#chunk-0', 'e1', 'self')];
      fail('deleteMany', FILES, F.storeGone.single);
      const stopped = await acts.move(via, 'lk-from.txt', 'lk-to.txt');
      assert.equal(status(stopped), 503, `the move was not stopped by the store: ${body(stopped)}`);
      faults.clear();
      assert.ok(acts.onDisk('lk-to.txt') && !acts.onDisk('lk-from.txt'), 'fixture: the bytes did not move');
      assert.equal((await markerMod.moveMarkerOf(S, 'lk-from.txt', 'lk-to.txt')) !== undefined, true, 'fixture: the move left no marker');

      const del = await acts.del(via, 'lk-to.txt');
      assert.ok(!acts.failed(del), `the delete of the file where the move put it was refused: ${body(del)}`);

      assert.deepEqual(await acts.links.idsUnder('lk-from.txt'), [], 'a link this instance wrote still names the source of the deleted file');
      assert.deepEqual(await acts.links.idsUnder('lk-to.txt'), [], 'a link this instance wrote still names the file at the destination, which is gone');
      assert.deepEqual((await acts.links.tombstoned()).filter(id => own.includes(id)), [...own].sort(), 'a link was removed without its tombstone');
      assert.equal(await markerMod.moveMarkerOf(S, 'lk-from.txt', 'lk-to.txt'), undefined,
        'the marker of the move outlived the delete: a link kept the move owed, so the next file at the source path is taken for the rest of it');
    });
  }

  // ── A move onto itself ──────────────────────────────────────────────────────────────────────────────────────────────

  for (const via of ['REST', 'MCP']) {
    it(`${via}: a move onto itself publishes no tombstone, and the file is still there, recorded and listed`, async () => {
      await acts.seed('same.txt');
      const a = await acts.move(via, 'same.txt', 'same.txt');
      assert.deepEqual(await acts.published(), { served: [], pushed: [] },
        'a tombstone was published for a file that is still here: every peer deletes it');
      assert.ok(acts.onDisk('same.txt'), 'the bytes are gone');
      assert.ok(await liveRow('same.txt'), 'the record is gone');
      const listed = (await acts.files.listFilesRecursive(S, '')).map(p => String(p).replace(/\\/g, '/'));
      assert.ok(listed.includes('same.txt'), `the file is not listed: ${JSON.stringify(listed)}`);
      assert.deepEqual(await everyTombstonePath(), [], 'a pending tombstone or marker was left for an act that did not begin');
      assert.ok(status(a) >= 400 && status(a) < 500, `a move onto itself was not refused as the caller's: ${status(a)} ${body(a)}`);
    });
  }
});
