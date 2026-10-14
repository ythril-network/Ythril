/**
 * A case-only rename publishes nothing until its records have been carried, a stopped one is owed and finished, and a converter's
 * scratch link is not a reason to refuse it (bundle-44, D-29, Q-437; rulings 39, 40, 41; verify drive F1, sweep F1 and F2).
 *
 * ## The rules
 *
 * On a case-insensitive file system (this development machine is NTFS; the cases that need the alias skip, `expected-in-ci:`, on a case-sensitive runner, where
 * `a-case-only-settle-is-decided-by-the-move-not-the-disk-db` holds the settle's rule through a seam):
 *
 *  1. **A failed rename publishes nothing.** The rename step failing (`EBUSY`), or the hold of the file's jobs failing before it, leaves
 *     `a.txt` live. Its old-id tombstone was published by a settle that read "bytes answer at the old spelling" as "the act removed
 *     the path", and a peer deleted a live file.
 *  2. **A stopped one is owed, and housekeeping finishes it.** The bytes are under the new spelling and the records are not carried: the
 *     answer is `503 move_still_owed`, the move IS owed (a begun marker, one entry under two spellings, a record still at the old id), the old
 *     ids are not yet published, and the housekeeping pass carries the records and then publishes them.
 *  3. **A scratch hard link is not an occupant.** A converter holds a second hard link to the file while it runs (`nlink` 2, verify drive F1);
 *     the two spellings of the file's own name are one file whatever its link count says.
 *  4. **Two different names for one inode are never the same name.** An operator's hard link at the destination refuses the move.
 *
 * Run: node --test testing/standalone/a-case-only-rename-is-owed-until-its-records-carry-db.test.js   (after `npm run build:server`)
 */
import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { openFileActDoors, NOTHING } from './_file-act-doors.mjs';
import { caseInsensitiveAt, sentenceOf } from './_move-destination.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();

const S = 'caseowed';
const T0 = '2026-09-01T00:00:00.000Z';
const DAY = 24 * 3_600_000;
const LATER = () => new Date(Date.now() + DAY);
// On a case-sensitive file system `a` and `A` are different entries, so there is no alias to settle. CI runners' file systems are
// case-sensitive and the cases that need the alias skip there (listed in testing/_shared/expected-in-ci.mjs); the settle's rule is held
// on CI by a-case-only-settle-is-decided-by-the-move-not-the-disk-db and the classification by a-destination-is-classified-by-inode-link-count-and-marker.
const SKIPPED = 'expected-in-ci: the file system is case-sensitive';

let acts, stored, tombstones, finish, walk, insensitive;
const files = () => acts.door.coll(S, 'files');
const rowOf = (id) => files().findOne({ _id: id });
const abs = (p) => path.join(acts.root(), p);
const read = (p) => fs.readFileSync(abs(p), 'utf8');
const names = () => fs.readdirSync(acts.root()).filter(n => n !== '_converted').sort();

/** The failure of the rename step of a move: the file system refusing it. */
const busy = () => Object.assign(new Error('EBUSY: resource busy or locked, rename'), { code: 'EBUSY' });

/** The `insertMany` of the files collection fails when `matches(docs)`: the step that carries a record stops. */
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

/** The next `updateMany` of the job collection fails: the hold of a file's jobs, the first thing a move does to them. */
function failJobHold(err) {
  const proto = Object.getPrototypeOf(acts.door.mongo.col('probe'));
  const original = proto.updateMany;
  let fired = 0;
  proto.updateMany = async function failing(...args) {
    if (this.collectionName === `${S}_media_jobs`) { fired++; throw err; }
    return original.apply(this, args);
  };
  return { restore: () => { proto.updateMany = original; }, fired: () => fired };
}

/** What a converter leaves while it runs: a second hard link to the file, under the swept scratch directory outside the tree. */
function converterScratchLink(rel) {
  const dir = path.join(process.env['DATA_ROOT'], '.stored-tmp', `plaintext-${process.pid}-${rel.replace(/\W/g, '-')}.tmp`);
  fs.mkdirSync(dir, { recursive: true });
  fs.linkSync(abs(rel), path.join(dir, 'input.txt'));
  assert.equal(fs.statSync(abs(rel)).nlink, 2, 'fixture: the file does not have a second link');
  return { remove: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

async function pass(now) {
  let outcome;
  const runner = walk.createHousekeepingWalk({ storeAnswers: async () => true });
  const result = await runner.eachSpace('TTL sweep: finishing interrupted file moves', [{ id: S }], async () => { outcome = await finish.finishOwedMoves(S, now); });
  return { outcome, failed: result.failed };
}

describe('a case-only rename is owed until its records carry (real MongoDB, case-insensitive file systems)', { skip }, () => {
  before(async () => {
    acts = await openFileActDoors({ suite: 'caseowed', space: S });
    stored = await import('../../server/dist/files/stored-bytes.js');
    tombstones = await import('../../server/dist/files/tombstones.js');
    finish = await import('../../server/dist/files/finish-owed-moves.js');
    walk = await import('../../server/dist/util/housekeeping-walk.js');
    insensitive = caseInsensitiveAt(acts.root());
  });
  after(async () => { stored?.setMoveStepsForTest(null); await acts?.close(); });
  beforeEach(async () => {
    await acts.reset();
    for (const part of ['links', 'media_jobs']) await acts.door.coll(S, part).deleteMany({});
  });
  afterEach(() => { stored.setMoveStepsForTest(null); });

  it('(1a) the rename step fails (EBUSY): nothing is published, a.txt and its record are live, and the retry then finishes the rename and publishes', async (t) => {
    if (!insensitive) { t.skip(SKIPPED); return; }
    await acts.seed('case.txt', { description: 'C' });
    await acts.files.writeFile(S, '_converted/case.txt.md', '# converted');
    stored.setMoveStepsForTest({ rename: async () => { throw busy(); } });

    const answer = await acts.move('REST', 'case.txt', 'Case.txt');

    assert.ok(acts.failed(answer), `the rename failed and the move answered ${acts.statusOf(answer)}`);
    assert.deepEqual(await acts.published(), NOTHING, 'a failed rename told a peer that case.txt is gone: the peer deletes a live file');
    assert.deepEqual((await acts.raw()).filter(r => !r.pending), [], 'a published tombstone stands for a path that is still live');
    assert.equal((await rowOf('case.txt'))?.description, 'C', 'the live record left its id');
    assert.equal(await rowOf('Case.txt'), null, 'a record was carried by a rename that failed');
    assert.equal(read('case.txt'), 'content of case.txt');

    stored.setMoveStepsForTest(null);
    const retry = await acts.move('REST', 'case.txt', 'Case.txt');
    assert.equal(acts.statusOf(retry), 200, `the retry of a failed case-only rename failed: ${sentenceOf(retry)}`);
    assert.equal((await rowOf('Case.txt'))?.description, 'C');
    assert.deepEqual(names(), ['Case.txt'], 'the bytes are not under the new spelling');
    assert.deepEqual(await acts.published(), { served: ['_converted/case.txt.md', 'case.txt'], pushed: ['_converted/case.txt.md', 'case.txt'] },
      'the finished rename did not tell a peer the old ids are gone');
  });

  it('(1b) the hold of the file\'s jobs fails before any byte moves: nothing is published, the pending tombstones are dropped, a.txt is live', async (t) => {
    if (!insensitive) { t.skip(SKIPPED); return; }
    await acts.seed('case.txt', { description: 'C' });
    await acts.door.coll(S, 'media_jobs').insertOne({
      _id: 'case.txt', spaceId: S, filePath: 'case.txt', mimeType: 'text/plain', mediaType: 'text', status: 'pending', attempts: 0, maxAttempts: 3,
      lastError: null, claimedAt: null, claimableAfter: null, createdAt: T0, updatedAt: T0,
    });
    const fault = failJobHold(new Error('the job store failed'));
    let answer;
    try { answer = await acts.move('REST', 'case.txt', 'Case.txt'); } finally { fault.restore(); }
    await tombstones.whenPendingFileTombstoneDropsSettle();

    assert.equal(fault.fired() > 0, true, 'fixture: the hold of the jobs was not attempted');
    assert.ok(acts.failed(answer), `the hold failed and the move answered ${acts.statusOf(answer)}`);
    assert.deepEqual(await acts.published(), NOTHING, 'a move that never touched a byte told a peer the old id is gone');
    assert.deepEqual(await acts.raw(), [], 'a tombstone of a move that did not begin its bytes is still stored');
    assert.equal((await rowOf('case.txt'))?.description, 'C');
    assert.equal(await tombstones.moveIsOwed(S, 'case.txt', 'Case.txt'), false, 'a move that did not begin is owed');
    assert.equal(read('case.txt'), 'content of case.txt');
  });

  it('(2) stopped after its bytes: 503 move_still_owed, the move IS owed, the old ids are not published yet, and housekeeping carries the records and publishes', async (t) => {
    if (!insensitive) { t.skip(SKIPPED); return; }
    await acts.seed('case.txt', { description: 'C' });
    await acts.files.writeFile(S, '_converted/case.txt.md', '# converted');
    const fault = failFilesInsertWhen(docs => docs.some(d => d._id === 'Case.txt'), new Error('the record step failed'));
    let stopped;
    try { stopped = await acts.move('REST', 'case.txt', 'Case.txt'); } finally { fault.restore(); }

    assert.equal(fault.fired(), 1, 'fixture: the record step did not run');
    assert.equal(acts.statusOf(stopped), 503, `a case-only move whose records did not follow was not answered 503: ${sentenceOf(stopped)}`);
    assert.equal(acts.answerOf(stopped).code, 'move_still_owed');
    assert.ok(names().includes('Case.txt'), 'fixture: the bytes are not under the new spelling');
    assert.equal(await tombstones.moveIsOwed(S, 'case.txt', 'Case.txt'), true, 'the 503 promises the move will be completed, and nothing reads it as owed: housekeeping would never finish it');
    assert.equal((await rowOf('case.txt'))?.description, 'C', 'fixture: the record was carried');
    assert.deepEqual(await acts.published(), NOTHING, 'the old ids were told to peers before the records left them');

    const done = await pass(LATER());

    assert.deepEqual(done.failed, [], `housekeeping failed on a case-only move: ${JSON.stringify(done.failed)}`);
    assert.equal(done.outcome.finished, 1, 'housekeeping did not finish the owed case-only move');
    assert.equal((await rowOf('Case.txt'))?.description, 'C', 'the record did not follow');
    assert.equal(await rowOf('case.txt'), null, 'the record is still at the old id');
    assert.equal(await tombstones.moveIsOwed(S, 'case.txt', 'Case.txt'), false);
    assert.equal(await tombstones.moveMarkerOf(S, 'case.txt', 'Case.txt'), undefined, 'the finished move kept its marker');
    assert.deepEqual((await acts.raw()).filter(r => r.pending), [], 'a tombstone is still pending after the move finished');
    assert.deepEqual(await acts.published(), { served: ['_converted/case.txt.md', 'case.txt'], pushed: ['_converted/case.txt.md', 'case.txt'] },
      'the finished move did not tell a peer the old ids are gone');
  });

  it('(3) a converter holds a scratch hard link (nlink 2): the case-only rename still succeeds and carries the record', async (t) => {
    if (!insensitive) { t.skip(SKIPPED); return; }
    await acts.seed('conv.txt', { description: 'V' });
    const scratch = converterScratchLink('conv.txt');
    try {
      const answer = await acts.move('REST', 'conv.txt', 'Conv.txt');

      assert.equal(acts.statusOf(answer), 200, `a case-only rename of a file a converter holds a link to was refused: ${sentenceOf(answer)}`);
      assert.ok(names().includes('Conv.txt'), 'the bytes are not under the new spelling');
      assert.equal((await rowOf('Conv.txt'))?.description, 'V', 'the record did not follow');
      assert.equal(await rowOf('conv.txt'), null);
      assert.deepEqual(await acts.published(), { served: ['conv.txt'], pushed: ['conv.txt'] }, 'the old id was not told to peers');
    } finally { scratch.remove(); }
  });

  it('(3b) the same through a directory component: Docs/a.txt to docs/a.txt while a converter holds a link', async (t) => {
    if (!insensitive) { t.skip(SKIPPED); return; }
    await acts.seed('Docs/a.txt', { description: 'D' });
    const scratch = converterScratchLink('Docs/a.txt');
    try {
      const answer = await acts.move('REST', 'Docs/a.txt', 'docs/a.txt');

      assert.equal(acts.statusOf(answer), 200, `a rename that differs in a directory component's case, of a file with a scratch link, failed: ${sentenceOf(answer)}`);
      assert.equal((await rowOf('docs/a.txt'))?.description, 'D');
      assert.equal(await rowOf('Docs/a.txt'), null);
    } finally { scratch.remove(); }
  });

  it('(4) an operator\'s hard link under ANOTHER name is an occupant, never the same name: 409 destination_exists, nothing changes', async () => {
    await acts.seed('p.txt', { description: 'P' });
    fs.linkSync(abs('p.txt'), abs('q.txt'));

    const answer = await acts.move('REST', 'p.txt', 'q.txt');

    assert.equal(acts.statusOf(answer), 409, `a move onto an operator's hard link was answered ${acts.statusOf(answer)}: ${sentenceOf(answer)}`);
    assert.equal(acts.answerOf(answer).code, 'destination_exists');
    assert.equal(read('p.txt'), 'content of p.txt', 'the source was unlinked');
    assert.equal(read('q.txt'), 'content of p.txt', 'the operator\'s link was replaced');
    assert.equal((await rowOf('p.txt'))?.description, 'P');
    assert.deepEqual(await acts.published(), NOTHING);
  });

  it('(4b) CASE-SENSITIVE file system: two entries a.txt and A.txt sharing an inode are two entries, so the move between them is refused and neither is touched', async (t) => {
    if (insensitive) { t.skip('the file system is case-insensitive: `a.txt` and `A.txt` cannot both exist; the classification is held by a-destination-is-classified-by-inode-link-count-and-marker'); return; }
    await acts.seed('pair.txt', { description: 'P' });
    fs.linkSync(abs('pair.txt'), abs('Pair.txt'));

    const answer = await acts.move('REST', 'pair.txt', 'Pair.txt');

    assert.equal(acts.statusOf(answer), 409, `a rename between two hard-linked entries was answered ${acts.statusOf(answer)}: ${sentenceOf(answer)}`);
    assert.equal(acts.answerOf(answer).code, 'destination_exists');
    assert.deepEqual(names().filter(n => n.toLowerCase() === 'pair.txt'), ['Pair.txt', 'pair.txt'], 'one of the two entries is gone');
    assert.equal((await rowOf('pair.txt'))?.description, 'P');
    assert.equal(await rowOf('Pair.txt'), null, 'a record was carried by a rename that did nothing');
    assert.deepEqual(await acts.published(), NOTHING);
  });

  it('(5) the request that finished a case-only rename, repeated, is a first attempt that changes nothing', async (t) => {
    if (!insensitive) { t.skip(SKIPPED); return; }
    await acts.seed('again.txt', { description: 'A' });
    assert.equal(acts.statusOf(await acts.move('REST', 'again.txt', 'Again.txt')), 200);

    const again = await acts.move('REST', 'again.txt', 'Again.txt');

    assert.equal(acts.statusOf(again), 200, `the repeat of a finished case-only rename failed: ${sentenceOf(again)}`);
    assert.equal((await rowOf('Again.txt'))?.description, 'A', 'the repeat disturbed the record');
    assert.equal(await rowOf('again.txt'), null);
    assert.equal(await tombstones.moveIsOwed(S, 'again.txt', 'Again.txt'), false);
  });
});
