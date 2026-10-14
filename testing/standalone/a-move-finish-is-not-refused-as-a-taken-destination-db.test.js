/**
 * The FINISH of a move whose bytes already moved is never refused as "the destination exists" — the destination is the move's own —
 * and it still refuses to replace a live record of ANOTHER file (bundle-44, D-29, Q-437; rulings 3, 12).
 *
 * ## The rule
 *
 * A move has two branches. A FIRST attempt (the bytes are at the source) refuses an occupied destination. A RESUME (the bytes are at the
 * destination, the move is owed) is the move finishing what it began: the destination is occupied by the moved file itself, and by the
 * rows its own earlier batches carried. What it meets at the ids it still has to take is decided by ONE classification, whose answer
 * differs by phase (`holdsAtDestination`):
 *
 *  - a row of the moved file's own tree (its top parent lies in the destination's subtree: a late write at an old id that its batch
 *    already moved, "the same chunk at both ids") is the move's own and is REPLACED: the straggler's row moves and wins;
 *  - debris (a derived row whose parent is gone or flagged) and a flagged audit row are removed;
 *  - a LIVE record or row of ANY OTHER file at a moved id refuses the finish with its own answer, `409 destination_held_after_move`,
 *    whose text says the bytes already moved: nothing is half-carried, the foreign row is untouched, the marker is kept, the move stays
 *    owed and housekeeping reports it stranded after its attempts. Deleting that other file lets the move finish on its own.
 *
 * What the finish costs is bounded: the rows at the destination are read in a fixed number of reads however many there are, never one
 * read per row.
 *
 * A repeat of a FINISHED move is still the documented `404`; a NEW, unrelated move onto the finished destination is a first attempt and
 * is refused (`409 destination_exists`).
 *
 * Run: node --test testing/standalone/a-move-finish-is-not-refused-as-a-taken-destination-db.test.js
 */
import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { openFileActDoors } from './_file-act-doors.mjs';
import { sentenceOf } from './_move-destination.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();

const S = 'movefinish';
const T0 = '2026-09-01T00:00:00.000Z';
const DAY = 24 * 3_600_000;
const LATER = (n = 1) => new Date(Date.now() + n * DAY);

let acts, tombstones, finish, walk, timing, plan, registry, seen;
const files = () => acts.door.coll(S, 'files');
const row = (id) => files().findOne({ _id: id });
const chunkRow = (parent, i, content) => ({
  _id: `${parent}#chunk-${i}`, spaceId: S, path: `${parent}#chunk-${i}`, parentFileId: parent, chunkIndex: i, content, tags: [], createdAt: T0, updatedAt: T0, sizeBytes: content.length,
});

/** The rows of a file written to `files` by an `insertMany`, failed when `matches(docs)`: how a batch is stopped at the one the test names. */
function failFilesInsertWhen(matches, err) {
  const proto = Object.getPrototypeOf(acts.door.mongo.col('probe'));
  const original = proto.insertMany;
  let fired = 0;
  proto.insertMany = async function counted(docs, ...rest) {
    if (this.collectionName === `${S}_files` && Array.isArray(docs) && matches(docs)) { fired++; throw err; }
    return original.call(this, docs, ...rest);
  };
  return { restore: () => { proto.insertMany = original; }, fired: () => fired };
}

async function pass(now, limits) {
  let outcome;
  const runner = walk.createHousekeepingWalk({ storeAnswers: async () => true });
  const result = await runner.eachSpace('TTL sweep: finishing interrupted file moves', [{ id: S }], async () => { outcome = await finish.finishOwedMoves(S, now, limits); });
  return { outcome, failed: result.failed };
}

const replacedMetric = async () => (await registry.fileMoveRowsReplacedTotal.get()).values.find(v => v.labels.space === S)?.value ?? 0;

/** A directory move stopped after its bytes: the first batch (file `dir/a.txt`, its chunks) landed, the second (`dir/b.txt`) did not. */
async function directoryMoveStoppedAfterItsFirstBatch(chunks) {
  for (const n of ['a', 'b']) {
    await acts.seed(`dir/${n}.txt`, { description: n });
    for (let i = 0; i < chunks; i++) await files().insertOne(chunkRow(`dir/${n}.txt`, i, `chunk ${i} of ${n}`));
  }
  // A budget that holds the first file's rows and not both files': the plan's own sizes decide it, never a number written here.
  const p = await plan.planMove(S, 'dir', 'moved', 'directory', 'before-the-bytes');
  const of = (g) => p.rows.filter(r => r.group === g).reduce((n, r) => n + r.bytes, 0);
  timing.setMoveTimingForTest({ txnBytes: of('dir/a.txt') + 10 });
  const fault = failFilesInsertWhen(docs => docs.some(d => String(d._id).startsWith('moved/b.txt')), new Error('the record step failed'));
  let answer;
  try { answer = await acts.move('REST', 'dir', 'moved'); } finally { fault.restore(); }
  assert.equal(fault.fired(), 1, 'fixture: the second batch was not the one that failed');
  assert.equal(acts.statusOf(answer), 503, `fixture: the move was not stopped after its bytes: ${sentenceOf(answer)}`);
  assert.ok(await row('moved/a.txt'), 'fixture: the first batch did not land');
  assert.equal(await row('moved/b.txt'), null, 'fixture: the second batch landed');
}

describe('the finish of a move is not refused as a taken destination (real MongoDB)', { skip }, () => {
  before(async () => {
    acts = await openFileActDoors({ suite: 'movefinish', space: S, monitorCommands: true });
    tombstones = await import('../../server/dist/files/tombstones.js');
    finish = await import('../../server/dist/files/finish-owed-moves.js');
    walk = await import('../../server/dist/util/housekeeping-walk.js');
    timing = await import('../../server/dist/files/move-timing.js');
    plan = await import('../../server/dist/files/move-plan.js');
    registry = await import('../../server/dist/metrics/registry.js');
    seen = await import('../../server/dist/files/owed-moves-seen.js');
  });
  after(async () => { timing?.setMoveTimingForTest(null); await acts?.close(); });
  beforeEach(async () => {
    await acts.reset();
    for (const part of ['links', 'media_jobs']) await acts.door.coll(S, part).deleteMany({});
  });
  afterEach(() => { timing.setMoveTimingForTest(null); });

  it('a stopped move: the same request again finishes it (200), the rows are at the destination and the marker is gone', async () => {
    await directoryMoveStoppedAfterItsFirstBatch(1);
    assert.equal(await tombstones.moveIsOwed(S, 'dir', 'moved'), true, 'fixture: the stopped move is not owed');

    const retry = await acts.move('REST', 'dir', 'moved');

    assert.equal(acts.statusOf(retry), 200, `the retry of an owed move was refused or failed: ${sentenceOf(retry)}`);
    for (const n of ['a', 'b']) {
      assert.equal((await row(`moved/${n}.txt`))?.description, n, `moved/${n}.txt has no record after the move was finished`);
      assert.equal(await row(`dir/${n}.txt`), null, `dir/${n}.txt is still at the source`);
      assert.equal((await row(`moved/${n}.txt#chunk-0`))?.parentFileId, `moved/${n}.txt`);
    }
    assert.equal(await tombstones.moveMarkerOf(S, 'dir', 'moved'), undefined, 'the finished move kept its marker');
  });

  it('housekeeping finishes the same stopped move without a refusal', async () => {
    await directoryMoveStoppedAfterItsFirstBatch(1);

    const done = await pass(LATER());

    assert.deepEqual(done.failed, [], `the finish was refused or failed: ${JSON.stringify(done.failed)}`);
    assert.equal(done.outcome.finished, 1);
    assert.ok(await row('moved/b.txt'), 'the second batch is not at the destination');
    assert.equal(await row('dir/b.txt'), null);
  });

  it('a NEW, unrelated move onto the finished destination is a first attempt and is refused; a repeat of the finished move is the documented 404', async () => {
    await directoryMoveStoppedAfterItsFirstBatch(1);
    assert.equal(acts.statusOf(await acts.move('REST', 'dir', 'moved')), 200);
    await acts.seed('other.txt');

    const refused = acts.answerOf(await acts.move('REST', 'other.txt', 'moved'));
    assert.equal(refused.status, 409);
    assert.equal(refused.code, 'destination_exists');
    assert.equal(refused.path, 'moved');

    const again = await acts.move('REST', 'dir', 'moved');
    assert.equal(acts.statusOf(again), 404, `a repeat of a finished move is not the documented 404: ${sentenceOf(again)}`);
  });

  it('F3, a late writer put a row at the OLD id after its batch moved (the same chunk at both ids): the retry finishes, the moved row wins and the replacement is counted', async () => {
    await directoryMoveStoppedAfterItsFirstBatch(1);
    await files().insertOne({ ...chunkRow('dir/a.txt', 0, 'LATE chunk of a') });
    assert.equal((await row('moved/a.txt#chunk-0'))?.content, 'chunk 0 of a', 'fixture: the moved chunk is not at the new id');
    const before = await replacedMetric();

    const retry = await acts.move('REST', 'dir', 'moved');

    assert.equal(acts.statusOf(retry), 200, `a straggler stranded the finish: ${sentenceOf(retry)}`);
    assert.equal((await row('moved/a.txt#chunk-0'))?.content, 'LATE chunk of a', 'the straggler\'s row did not take the id: the finish did not carry what is at the old one');
    assert.equal(await row('dir/a.txt#chunk-0'), null, 'the straggler was left at the old id');
    assert.ok(await row('moved/b.txt'), 'the second batch did not finish');
    assert.equal(await replacedMetric(), before + 1, 'the replaced row was not counted (by row)');
  });

  it('a live record of ANOTHER file at a moved id after the bytes moved: 409 destination_held_after_move, the foreign row untouched, the move stays owed and is reported stranded', async () => {
    await acts.seed('one.txt', { description: 'ONE' });
    const fault = failFilesInsertWhen(() => true, new Error('the record step failed'));
    let stopped;
    try { stopped = await acts.move('REST', 'one.txt', 'two.txt'); } finally { fault.restore(); }
    assert.equal(acts.statusOf(stopped), 503, `fixture: the move was not stopped after its bytes: ${sentenceOf(stopped)}`);
    const foreign = { _id: 'two.txt', spaceId: S, path: 'two.txt', sizeBytes: 1, tags: [], description: 'FOREIGN', createdAt: T0, updatedAt: T0 };
    await files().insertOne(foreign);

    const retry = await acts.move('REST', 'one.txt', 'two.txt');

    const ans = acts.answerOf(retry);
    assert.equal(ans.status, 409, `answered ${ans.status}: ${sentenceOf(retry)}`);
    assert.equal(ans.code, 'destination_held_after_move');
    assert.equal(ans.path, 'two.txt');
    assert.match(sentenceOf(retry), /already moved/, 'the sentence does not say the bytes already moved');
    assert.deepEqual(await row('two.txt'), foreign, 'the foreign record was replaced');
    assert.equal((await row('one.txt'))?.description, 'ONE', 'the moved file\'s record left its source although nothing could carry it');
    assert.notEqual(await tombstones.moveMarkerOf(S, 'one.txt', 'two.txt'), undefined, 'the marker of a move that is still owed was cleared');
    assert.equal(await tombstones.moveIsOwed(S, 'one.txt', 'two.txt'), true, 'the move is not owed any more');

    // Housekeeping: the one attempt is spent and the move is STRANDED, said through the walk, its marker kept.
    const limits = { attempts: 1, backoffBaseMs: 60 * 60_000 };
    const first = await pass(LATER(1), limits);
    assert.equal(first.outcome.finished, 0, 'housekeeping carried a record over the foreign one');
    assert.equal(first.failed.length, 1, 'the refused finish was not reported through the walk');
    const second = await pass(LATER(2), limits);
    assert.equal(second.outcome.stranded, 1, 'a move whose attempts are spent was not counted stranded');
    assert.equal(seen.strandedMoveCount(S), 1);
    assert.deepEqual(await row('two.txt'), foreign, 'housekeeping replaced the foreign record');

    // The remedy the sentence names: delete that other file, and the move then finishes.
    await files().deleteOne({ _id: 'two.txt' });
    const done = await acts.move('REST', 'one.txt', 'two.txt');
    assert.equal(acts.statusOf(done), 200, `the move did not finish once the foreign record was gone: ${sentenceOf(done)}`);
    assert.equal((await row('two.txt'))?.description, 'ONE');
  });

  it('what the finish reads at the destination does not grow with the number of rows it meets: stragglers cost a fixed number of reads', async () => {
    const readsOfAFinishWith = async (stragglers) => {
      await acts.reset();
      await acts.door.coll(S, 'media_jobs').deleteMany({});
      await directoryMoveStoppedAfterItsFirstBatch(stragglers);
      for (let i = 0; i < stragglers; i++) await files().insertOne(chunkRow('dir/a.txt', i, `LATE ${i}`));
      let answer;
      const commands = await acts.door.commandsDuring(async () => { answer = await acts.move('REST', 'dir', 'moved'); });
      assert.equal(acts.statusOf(answer), 200, `the finish with ${stragglers} stragglers failed: ${sentenceOf(answer)}`);
      assert.equal((await row(`moved/a.txt#chunk-${stragglers - 1}`))?.content, `LATE ${stragglers - 1}`, 'the stragglers did not win');
      return commands.filter(c => c.endsWith(`${S}_files`) && /^(find|aggregate) /.test(c)).length;
    };
    const few = await readsOfAFinishWith(5);
    const many = await readsOfAFinishWith(120);
    assert.ok(many <= few + 2, `the finish read the files collection ${few} times for 5 stragglers and ${many} for 120: a read per row, not a read per level of ancestry`);
  });
});
