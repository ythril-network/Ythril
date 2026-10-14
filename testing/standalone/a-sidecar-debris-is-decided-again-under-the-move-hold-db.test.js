/**
 * What a move removes as "debris" at a sidecar destination is decided AGAIN under the move's hold, immediately before it is removed
 * (bundle-44, D-29, Q-437; ruling 43; sweep 3).
 *
 * ## The defect
 *
 * A sidecar destination that holds only debris (the converted Markdown of a file that has neither bytes nor a record) is not an occupant:
 * the move removes it before its bytes move. That decision was made by the pre-check, then the move wrote its tombstones and HELD the
 * file's jobs (a write that may wait for a running conversion, up to the hold's bound), and only then removed the debris — with no look
 * at it again. A file that appeared at the destination in that interval turned the debris into a live file's sidecar, the move removed
 * it all the same, and then refused at its bytes (`destination_exists`): the refused move had already deleted another file's converted
 * Markdown.
 *
 * ## The rule
 *
 * The debris is decided again once the jobs are held and nothing else can change the answer in its favour, immediately before the first
 * removal: the same question the pre-check asked (`assertDestinationFree`). A destination that is no longer free refuses the move with
 * the same answer the pre-check gives, and nothing at it is touched.
 *
 * ## How the interval is made
 *
 * The hold of the file's jobs is the first write the move makes after the pre-check; the job collection's `updateMany` is held for one
 * call and the file the "other writer" puts at the destination lands inside it. A job is seeded so the hold has something to write.
 *
 * Run: node --test testing/standalone/a-sidecar-debris-is-decided-again-under-the-move-hold-db.test.js   (after `npm run build:server`)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { openFileActDoors } from './_file-act-doors.mjs';
import { sentenceOf, stateOf, withJobsHandedBack } from './_move-destination.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();

const S = 'debrishold';
const T0 = '2026-09-01T00:00:00.000Z';

let acts;
const files = () => acts.door.coll(S, 'files');
const abs = (p) => path.join(acts.root(), p);
const exists = (p) => fs.existsSync(abs(p));

/** The next `updateMany` of the job collection runs `before` first: the writer that lands between the pre-check and the removal of the debris. */
function inTheHold(before) {
  const proto = Object.getPrototypeOf(acts.door.mongo.col('probe'));
  const original = proto.updateMany;
  let fired = 0;
  proto.updateMany = async function held(...args) {
    if (this.collectionName === `${S}_media_jobs` && fired === 0) { fired++; await before(); }
    return original.apply(this, args);
  };
  return { restore: () => { proto.updateMany = original; }, fired: () => fired };
}

describe('sidecar debris is decided again under the move\'s hold (real MongoDB)', { skip }, () => {
  before(async () => { acts = await openFileActDoors({ suite: 'debrishold', space: S }); });
  after(async () => { await acts?.close(); });
  beforeEach(async () => {
    await acts.reset();
    for (const part of ['links', 'media_jobs']) await acts.door.coll(S, part).deleteMany({});
  });

  /** `a.txt` with its converted Markdown and a pending job, and debris at the destination's sidecar: a converted Markdown with no file and no record. */
  async function aSourceAndDebrisAtItsDestination() {
    await acts.seed('a.txt', { description: 'A' });
    await acts.files.writeFile(S, '_converted/a.txt.md', '# converted a');
    await acts.files.writeFile(S, '_converted/b.txt.md', '# debris of a file that is gone');
    await acts.door.coll(S, 'media_jobs').insertOne({
      _id: 'a.txt', spaceId: S, filePath: 'a.txt', mimeType: 'text/plain', mediaType: 'text', status: 'pending', attempts: 0, maxAttempts: 3,
      lastError: null, claimedAt: null, claimableAfter: null, createdAt: T0, updatedAt: T0,
    });
  }

  it('CONTROL: the debris is still debris under the hold: the move removes it and finishes', async () => {
    await aSourceAndDebrisAtItsDestination();

    const answer = await acts.move('REST', 'a.txt', 'b.txt');

    assert.equal(acts.statusOf(answer), 200, `a move onto the name a converted file once had was refused: ${sentenceOf(answer)}`);
    assert.equal(fs.readFileSync(abs('_converted/b.txt.md'), 'utf8'), '# converted a', 'the sidecar did not take the debris\'s place');
    assert.equal(exists('a.txt'), false);
  });

  it('a file that appears at the destination after the pre-check makes the debris a live file\'s sidecar: the move is refused and removes nothing', async () => {
    await aSourceAndDebrisAtItsDestination();
    const before = withJobsHandedBack(await stateOf(acts, S));
    const appears = inTheHold(async () => {
      await acts.files.writeFile(S, 'b.txt', 'a file somebody wrote meanwhile');
      await files().insertOne({ _id: 'b.txt', spaceId: S, path: 'b.txt', sizeBytes: 31, tags: [], description: 'B', createdAt: T0, updatedAt: T0 });
    });
    let answer;
    try { answer = await acts.move('REST', 'a.txt', 'b.txt'); } finally { appears.restore(); }

    assert.equal(appears.fired(), 1, 'fixture: the hold of the jobs was not reached, so nothing appeared in the interval');
    assert.equal(acts.statusOf(answer), 409, `the move was answered ${acts.statusOf(answer)}: ${sentenceOf(answer)}`);
    assert.equal(acts.answerOf(answer).code, 'destination_exists');
    assert.equal(exists('_converted/b.txt.md'), true, 'the refused move removed the converted Markdown that now belongs to the file that appeared');
    assert.equal(fs.readFileSync(abs('_converted/b.txt.md'), 'utf8'), '# debris of a file that is gone');
    assert.equal(fs.readFileSync(abs('b.txt'), 'utf8'), 'a file somebody wrote meanwhile', 'the file that appeared was touched');
    assert.equal(fs.readFileSync(abs('a.txt'), 'utf8'), 'content of a.txt', 'the source moved');
    assert.equal(fs.readFileSync(abs('_converted/a.txt.md'), 'utf8'), '# converted a');
    assert.equal((await files().findOne({ _id: 'b.txt' }))?.description, 'B');
    assert.equal((await files().findOne({ _id: 'a.txt' }))?.description, 'A');
    const after = withJobsHandedBack(await stateOf(acts, S));
    const stripped = (s) => ({ ...s, tree: Object.fromEntries(Object.entries(s.tree).filter(([k]) => k !== 'b.txt')), files: s.files.filter(r => r._id !== 'b.txt'), tombstones: [] });
    assert.deepEqual(stripped(after).tree, stripped(before).tree, 'the refused move changed the tree');
    assert.deepEqual(after.tombstones.filter(t => !t.pending), [], 'a refused move published a tombstone');
  });
});
