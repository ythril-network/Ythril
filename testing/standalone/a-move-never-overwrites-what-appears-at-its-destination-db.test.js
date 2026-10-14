/**
 * What a move meets at its destination BETWEEN the check and the placing of the bytes is never overwritten either
 * (bundle-44, D-29, Q-437 — the window a pre-check alone leaves open).
 *
 * ## The rule
 *
 * The refusal of an occupied destination is made twice: once before anything is written (`assertDestinationFree`), and once by the
 * step that places the bytes (`moveStoredIfFree`), under both paths' locks. A file is placed by a HARD LINK, which the kernel refuses
 * when the name exists whoever wrote it, and the source's name is removed after; a directory by a rename, which the kernel refuses for
 * a non-empty directory. So a file or a tree that appears at the destination after the check is refused as an occupied destination
 * (`409 destination_exists`), the foreign bytes are untouched, the source is where it was, and the move leaves nothing behind: no
 * tombstone pending or published, the jobs it held released.
 *
 * ## The seam, and why the tests need one
 *
 * A foreign writer landing in that window cannot be timed from outside. `setMoveStepsForTest({ beforeLink })` runs a callback UNDER the
 * locks, after the destination was classified free and before the bytes are placed, so a test lands the foreign write exactly there.
 * `link` and `unlink` are replaceable the same way (a file system that refuses a hard link is not available on request).
 *
 * ## Where the guarantee ends, stated
 *
 * On a file system that refuses hard links the step falls back to a rename, counted (`ythril_file_move_link_fallback_total`) and said
 * once in the log; the in-process guarantee (the classification under the locks) holds, and a foreign PROCESS writing at the
 * destination in that instant can be overwritten. A case below holds the fallback's count and its one line.
 *
 * Run: node --test testing/standalone/a-move-never-overwrites-what-appears-at-its-destination-db.test.js
 */
import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { openFileActDoors } from './_file-act-doors.mjs';
import { logLinesDuring } from './_log-lines.mjs';
import { MOVE_DOORS, stateOf, sentenceOf } from './_move-destination.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();

const S = 'movenooverwrite';
const T0 = '2026-09-01T00:00:00.000Z';

let acts, stored, registry, tombstones;
const files = () => acts.door.coll(S, 'files');
const rowOf = (id) => files().findOne({ _id: id });
const abs = (p) => path.join(acts.root(), p);
const read = (p) => fs.readFileSync(abs(p), 'utf8');
const put = (p, content) => { fs.mkdirSync(path.dirname(abs(p)), { recursive: true }); fs.writeFileSync(abs(p), content); };

/** The seam, or the plain failure that it does not exist — so a build without it fails these cases with the reason and not with a TypeError. */
function seam(steps) {
  assert.equal(typeof stored.setMoveStepsForTest, 'function', 'files/stored-bytes.ts exports no setMoveStepsForTest: the placing of a move\'s bytes has no seam to land a foreign write at');
  stored.setMoveStepsForTest(steps);
}

/** A queued job for `p`: the move holds it for its duration, and a refusal must hand it back exactly as it was. */
const jobFor = (p) => ({
  _id: p, spaceId: S, filePath: p, mimeType: 'text/plain', mediaType: 'text', status: 'pending', attempts: 0, maxAttempts: 3,
  lastError: null, claimedAt: null, claimableAfter: null, createdAt: T0, updatedAt: T0,
});

const linkMetric = async () => (await registry.fileMoveLinkFallbackTotal.get()).values.reduce((n, v) => n + v.value, 0);

describe('a move never overwrites what appears at its destination after the check (real MongoDB)', { skip }, () => {
  before(async () => {
    acts = await openFileActDoors({ suite: 'movenooverwrite', space: S });
    stored = await import('../../server/dist/files/stored-bytes.js');
    registry = await import('../../server/dist/metrics/registry.js');
    tombstones = await import('../../server/dist/files/tombstones.js');
  });
  after(async () => { stored?.setMoveStepsForTest?.(null); await acts?.close(); });
  beforeEach(async () => {
    await acts.reset();
    for (const part of ['links', 'media_jobs']) await acts.door.coll(S, part).deleteMany({});
  });
  afterEach(() => { stored?.setMoveStepsForTest?.(null); });

  for (const via of MOVE_DOORS) {
    it(`${via}: a FILE that lands at the destination in the window is refused, intact, and the move leaves nothing behind`, async () => {
      await acts.seed('a.txt', { description: 'A' });
      await acts.door.coll(S, 'media_jobs').insertOne(jobFor('a.txt'));
      const before = await stateOf(acts, S);
      seam({ beforeLink: (_srcAbs, dstAbs) => { fs.writeFileSync(dstAbs, 'FOREIGN'); } });

      const answer = await acts.move(via, 'a.txt', 'b.txt');

      const ans = acts.answerOf(answer);
      assert.equal(ans.status, 409, `answered ${ans.status}: ${sentenceOf(answer)}`);
      assert.equal(ans.code, 'destination_exists');
      assert.equal(ans.path, 'b.txt');
      assert.equal(read('b.txt'), 'FOREIGN', 'the foreign file was overwritten by the move');
      assert.equal(read('a.txt'), 'content of a.txt', 'the source changed');
      assert.equal((await rowOf('a.txt'))?.description, 'A', 'the source\'s record changed');
      assert.equal(await rowOf('b.txt'), null, 'a record appeared at the destination of a refused move');
      await tombstones.whenPendingFileTombstoneDropsSettle();
      assert.deepEqual(await acts.raw(), [], 'a move that lost the race left a tombstone, pending or published');
      assert.deepEqual(await acts.published(), { served: [], pushed: [] }, 'a move that lost the race published a tombstone');
      const after = await stateOf(acts, S);
      assert.deepEqual(after.jobs, before.jobs, 'the job the move held was not handed back as it was');
      assert.deepEqual({ ...after, tree: undefined }, { ...before, tree: undefined }, 'a refused move changed a record, a link or a job');
      assert.deepEqual(after.tree, { ...before.tree, 'b.txt': 'FOREIGN' }, 'the files tree changed by more than the foreign file');
    });
  }

  it('a DIRECTORY that lands, non-empty, at the destination in the window is refused whole (the kernel refuses the rename)', async () => {
    put('srcdir/y', 'Y');
    seam({ beforeLink: (_srcAbs, dstAbs) => { fs.mkdirSync(dstAbs, { recursive: true }); fs.writeFileSync(path.join(dstAbs, 'x'), 'FOREIGN'); } });

    const answer = await acts.move('REST', 'srcdir', 'dstdir');

    const ans = acts.answerOf(answer);
    assert.equal(ans.status, 409, `answered ${ans.status}: ${sentenceOf(answer)}`);
    assert.equal(ans.code, 'destination_exists');
    assert.equal(ans.path, 'dstdir');
    assert.equal(read('dstdir/x'), 'FOREIGN', 'the foreign directory\'s file is gone');
    assert.equal(read('srcdir/y'), 'Y', 'the source directory lost its file');
    assert.equal(acts.onDisk('dstdir/y'), false, 'the source\'s file was moved into the foreign directory');
    await tombstones.whenPendingFileTombstoneDropsSettle();
    assert.deepEqual(await acts.raw(), []);
  });

  it('a file system that refuses a hard link: a free destination still moves, counted and said ONCE; an occupied one is still refused', async () => {
    await acts.seed('a.txt', { description: 'A' });
    await acts.seed('c.txt', { description: 'C' });
    await acts.seed('taken.txt', { description: 'T' });
    seam({ link: async () => { throw Object.assign(new Error('EPERM: operation not permitted, link'), { code: 'EPERM' }); } });
    const before = await linkMetric();

    const { lines, result } = await logLinesDuring(async () => [await acts.move('REST', 'a.txt', 'b.txt'), await acts.move('REST', 'c.txt', 'd.txt'), await acts.move('REST', 'c.txt', 'taken.txt')]);

    const [first, second, third] = result;
    assert.equal(acts.statusOf(first), 200, `the move was refused or failed without a hard link: ${sentenceOf(first)}`);
    assert.equal(acts.statusOf(second), 200, `the second move failed: ${sentenceOf(second)}`);
    assert.equal(read('b.txt'), 'content of a.txt');
    assert.equal(read('d.txt'), 'content of c.txt');
    assert.equal(acts.onDisk('a.txt') || acts.onDisk('c.txt'), false, 'a source kept its bytes after the fallback moved them');
    assert.equal((await rowOf('b.txt'))?.description, 'A');
    assert.equal(await linkMetric(), before + 2, 'the fallback was not counted once per move that took it');
    assert.equal(lines.filter(l => /hard link/i.test(l)).length, 1, `the fallback was said ${lines.filter(l => /hard link/i.test(l)).length} times, not once: ${lines.join(' | ')}`);
    // The fallback is a rename, but the classification before it is the same one: an occupied destination is refused.
    const answer = acts.answerOf(third);
    assert.equal(answer.status, 409, 'without a hard link, a move onto an existing file was not refused');
    assert.equal(answer.code, 'destination_exists');
    assert.equal(read('taken.txt'), 'content of taken.txt');
  });

  it('a write to the destination that is waiting for the move\'s locks lands AFTER the move, never inside it', async () => {
    await acts.seed('a.txt', { description: 'A' });
    let writer;
    // Started under the locks the move holds: it queues behind them, so the move still finds the name free and the writer wins after.
    seam({ beforeLink: (_srcAbs, dstAbs) => { writer = stored.writeStored(dstAbs, 'WRITER'); } });

    const answer = await acts.move('REST', 'a.txt', 'b.txt');
    await writer;

    assert.equal(acts.statusOf(answer), 200, `the move was refused by a write that has to wait for its locks: ${sentenceOf(answer)}`);
    assert.equal(read('b.txt'), 'WRITER', 'the write did not land after the move');
    assert.equal(acts.onDisk('a.txt'), false);
    const leftovers = fs.existsSync(stored.storedTmpDir()) ? fs.readdirSync(stored.storedTmpDir()) : [];
    assert.deepEqual(leftovers, [], 'a staged temp file was left behind');
  });
});
