/**
 * A move that placed a hard link and did not remove the source name is finished or undone, never refused as an occupied
 * destination and never left as two names (bundle-44, D-29, Q-437; rulings 11, 20, 21).
 *
 * ## The rule
 *
 * A file moves by a hard link and then the removal of its old name (`moveStoredIfFree`). Between the two the bytes have two names, and
 * what a reader of the disk sees there is exactly what an OPERATOR'S own hard link looks like. They are told apart by evidence, and
 * only evidence, because the wrong answer either deletes a name that was never the move's or refuses a move that is half made:
 *
 *  - the removal of the source name FAILS: the destination's link is rolled back and the failure is the move's answer, so the move is
 *    wholly not done — the source intact, nothing published, the jobs it held released;
 *  - the removal finds the source already GONE (`ENOENT`): that is a success, the move did what it was asked;
 *  - the two names share an inode and a BEGUN-MOVE MARKER names this very pair (`from` to `to`): it is the move's own half-made link,
 *    and the next attempt, or housekeeping, removes the source name and finishes the move;
 *  - the two names share an inode and NO marker names the pair: it is somebody's hard link, an occupied destination, refused;
 *  - the two names are ONE entry under two spellings (a case-only rename: `nlink` 1): a rename, never an unlink — an unlink there
 *    would delete the file.
 *
 * Every case drives the real doors and the real cascade; the failing step is the seam's (`setMoveStepsForTest`), the crash is made by
 * hand (a link and a begun-move marker, which is what a process that died between the two steps leaves).
 *
 * Run: node --test testing/standalone/a-half-made-link-is-finished-or-undone-db.test.js
 */
import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { openFileActDoors } from './_file-act-doors.mjs';
import { caseInsensitiveAt, stateOf, sentenceOf } from './_move-destination.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();

const S = 'halflink';
const T0 = '2026-09-01T00:00:00.000Z';
const DAY = 24 * 3_600_000;
const LATER = () => new Date(Date.now() + DAY);

let acts, stored, tombstones, finish, walk, seen;
const files = () => acts.door.coll(S, 'files');
const rowOf = (id) => files().findOne({ _id: id });
const abs = (p) => path.join(acts.root(), p);
const read = (p) => fs.readFileSync(abs(p), 'utf8');

function seam(steps) {
  assert.equal(typeof stored.setMoveStepsForTest, 'function', 'files/stored-bytes.ts exports no setMoveStepsForTest: the steps of a move\'s bytes have no seam');
  stored.setMoveStepsForTest(steps);
}
const eacces = () => Object.assign(new Error('EACCES: permission denied, unlink'), { code: 'EACCES' });
const named = (p, name) => path.basename(p) === name;

const jobFor = (p) => ({
  _id: p, spaceId: S, filePath: p, mimeType: 'text/plain', mediaType: 'text', status: 'pending', attempts: 0, maxAttempts: 3,
  lastError: null, claimedAt: null, claimableAfter: null, createdAt: T0, updatedAt: T0,
});

/**
 * What a process that died between the link and the unlink leaves, made by hand: a second name for the file, and the marker the move
 * wrote before it began (written pending, as the cascade writes it, with the identity of the bytes).
 */
async function crashedBetweenLinkAndUnlink(from, to) {
  await acts.seed(from, { description: 'A' });
  fs.linkSync(abs(from), abs(to));
  const identity = await tombstones.bytesIdentityAt(S, from);
  assert.ok(identity, 'fixture: the source has no identity to record');
  await tombstones.writePendingFileTombstones(S, [from], { from, to, ...identity });
}

/** One pass of the completion over the space, as production runs it (`housekeeping-finishes-an-owed-move-db`). */
async function pass(now) {
  let outcome;
  const runner = walk.createHousekeepingWalk({ storeAnswers: async () => true });
  const result = await runner.eachSpace('TTL sweep: finishing interrupted file moves', [{ id: S }], async () => { outcome = await finish.finishOwedMoves(S, now); });
  return { outcome, failed: result.failed };
}

describe('a half-made link is finished or undone (real MongoDB)', { skip }, () => {
  before(async () => {
    acts = await openFileActDoors({ suite: 'halflink', space: S });
    stored = await import('../../server/dist/files/stored-bytes.js');
    tombstones = await import('../../server/dist/files/tombstones.js');
    finish = await import('../../server/dist/files/finish-owed-moves.js');
    walk = await import('../../server/dist/util/housekeeping-walk.js');
    seen = await import('../../server/dist/files/owed-moves-seen.js');
  });
  after(async () => { stored?.setMoveStepsForTest?.(null); await acts?.close(); });
  beforeEach(async () => {
    await acts.reset();
    for (const part of ['links', 'media_jobs']) await acts.door.coll(S, part).deleteMany({});
  });
  afterEach(() => { stored?.setMoveStepsForTest?.(null); });

  it('(a) the removal of the source name fails: the link is rolled back, the failure is the answer, and the move is wholly not done', async () => {
    await acts.seed('a.txt', { description: 'A' });
    await acts.door.coll(S, 'media_jobs').insertOne(jobFor('a.txt'));
    const before = await stateOf(acts, S);
    // Only the SOURCE's name fails to go: the rollback removes the destination's, and a seam that failed every unlink would fail that too.
    seam({ unlink: async (p) => { if (named(p, 'a.txt')) throw eacces(); await fsp.unlink(p); } });

    const answer = await acts.move('REST', 'a.txt', 'b.txt');

    const ans = acts.answerOf(answer);
    assert.equal(ans.status, 500, `answered ${ans.status}: ${sentenceOf(answer)}`);
    assert.equal(ans.code, 'file_system_fault');
    assert.doesNotMatch(sentenceOf(answer), new RegExp(String(process.env['DATA_ROOT']).replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')), 'the answer names the data root');
    assert.equal(acts.onDisk('b.txt'), false, 'the destination\'s link was not rolled back: the file has two names');
    assert.equal(read('a.txt'), 'content of a.txt', 'the source lost its bytes');
    assert.equal((await rowOf('a.txt'))?.description, 'A');
    await tombstones.whenPendingFileTombstoneDropsSettle();
    assert.deepEqual(await acts.published(), { served: [], pushed: [] }, 'a move whose last step failed published a tombstone');
    assert.deepEqual(await stateOf(acts, S), before, 'the move that failed at its last step changed something');
  });

  it('(b) the removal of the source name finds it already gone: that is a success, not a failure', async () => {
    await acts.seed('a.txt', { description: 'A' });
    // The source went meanwhile (a concurrent delete): the removal still happens, and then reports it was not there.
    seam({ unlink: async (p) => { await fsp.unlink(p); throw Object.assign(new Error('ENOENT: no such file or directory, unlink'), { code: 'ENOENT' }); } });

    const answer = await acts.move('REST', 'a.txt', 'b.txt');

    assert.equal(acts.statusOf(answer), 200, `a move whose source name was already gone failed: ${sentenceOf(answer)}`);
    assert.equal(read('b.txt'), 'content of a.txt');
    assert.equal((await rowOf('b.txt'))?.description, 'A');
    assert.equal(await rowOf('a.txt'), null);
  });

  it('(c) an OPERATOR\'S hard link (the same inode, two names, no marker) is an occupied destination: refused, both names intact', async () => {
    await acts.seed('a.txt', { description: 'A' });
    fs.linkSync(abs('a.txt'), abs('b.txt'));
    const before = await stateOf(acts, S);

    const answer = await acts.move('REST', 'a.txt', 'b.txt');

    const ans = acts.answerOf(answer);
    assert.equal(ans.status, 409, `answered ${ans.status}: ${sentenceOf(answer)}`);
    assert.equal(ans.code, 'destination_exists');
    assert.equal(ans.path, 'b.txt');
    assert.equal(fs.statSync(abs('a.txt')).ino, fs.statSync(abs('b.txt')).ino, 'a name of the operator\'s hard link was removed or replaced');
    assert.deepEqual(await stateOf(acts, S), before, 'refusing the operator\'s link changed something');
  });

  describe('a crash between the link and the removal of the source name', () => {
    it('(d) housekeeping finishes it: the source name goes, the records follow, the marker is cleared and the move is no longer owed', async () => {
      await crashedBetweenLinkAndUnlink('a.txt', 'b.txt');
      assert.equal(await tombstones.moveIsOwed(S, 'a.txt', 'b.txt'), true, 'a marked half-made link is not read as an owed move, so nothing would ever finish it');

      const { outcome, failed } = await pass(LATER());

      assert.deepEqual(failed, [], `housekeeping failed on a half-made link: ${JSON.stringify(failed)}`);
      assert.equal(outcome.finished, 1, 'housekeeping did not finish the half-made link');
      assert.equal(acts.onDisk('a.txt'), false, 'the source name is still there: the file has two names');
      assert.equal(read('b.txt'), 'content of a.txt');
      assert.equal((await rowOf('b.txt'))?.description, 'A', 'the record did not follow the file');
      assert.equal(await rowOf('a.txt'), null, 'the record is still at the source');
      assert.equal(await tombstones.moveMarkerOf(S, 'a.txt', 'b.txt'), undefined, 'the finished move kept its marker');
      assert.equal(seen.owedMoveCount(S), 0, 'the owed gauge still counts the move');
      assert.deepEqual((await acts.raw()).filter(t => !t.pending).map(t => t.path), ['a.txt'], 'the path the move left is not tombstoned exactly once');
    });

    it('(d) the retry of the request finishes it: 200, not a refusal of a destination that is the move\'s own', async () => {
      await crashedBetweenLinkAndUnlink('a.txt', 'b.txt');

      const answer = await acts.move('REST', 'a.txt', 'b.txt');

      assert.equal(acts.statusOf(answer), 200, `the retry of a move that crashed between its link and its unlink was refused: ${sentenceOf(answer)}`);
      assert.equal(acts.onDisk('a.txt'), false, 'the source name is still there');
      assert.equal(read('b.txt'), 'content of a.txt');
      assert.equal((await rowOf('b.txt'))?.description, 'A');
      assert.equal(await tombstones.moveMarkerOf(S, 'a.txt', 'b.txt'), undefined);
    });
  });

  it('(e) one entry under two spellings and a marker is an ALIAS: the file is renamed, never unlinked (case-insensitive file systems only)', async (t) => {
    if (!caseInsensitiveAt(acts.root())) { t.skip('the file system under the files tree is case-sensitive: a name has no second spelling here; the classification is held by a-destination-is-classified-by-inode-link-count-and-marker (pure)'); return; }
    await acts.seed('case.txt', { description: 'A' });
    const identity = await tombstones.bytesIdentityAt(S, 'case.txt');
    await tombstones.writePendingFileTombstones(S, ['case.txt'], { from: 'case.txt', to: 'Case.txt', ...identity });

    const answer = await acts.move('REST', 'case.txt', 'Case.txt');

    assert.equal(acts.statusOf(answer), 200, `a case-only rename with a marker failed: ${sentenceOf(answer)}`);
    assert.ok(fs.readdirSync(acts.root()).includes('Case.txt'), 'the file is not under its new spelling: it was unlinked, or not renamed');
    assert.equal(read('Case.txt'), 'content of case.txt', 'the file is gone: an alias was treated as a second name and unlinked');
    assert.equal((await rowOf('Case.txt'))?.description, 'A');
  });
});
