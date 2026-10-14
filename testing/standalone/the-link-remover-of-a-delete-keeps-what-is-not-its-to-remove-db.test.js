/**
 * The remover a delete calls for a file's links (`removeLinksOfDeletedFiles`) removes only what the delete is owed, and answers for
 * what it kept (Q-464).
 *
 * ## What the doors' own cases leave open
 *
 * `a-directory-delete-is-the-same-act-on-every-door-db` holds the whole act: the links of a file and of its derived ids go, another
 * instance's stay, and a failure in the step fails the delete. Three rules live in the remover itself and are asked of it directly:
 *
 *  - **The second pass is bounded by an instant.** Once the row is gone the delete asks again with `createdUntil`: a link written
 *    at or before the instant is taken (a `save_link` that landed while the row was live), a link written after it is not (the new
 *    link of a file uploaded at the path since). Without the bound the second pass would take the links of the file that replaced this one.
 *  - **A file still on disk keeps its links.** `surviving` names the files a directory delete did not remove; their links, and those of
 *    their derived ids, stay, and the links of the files that went do not.
 *  - **The selection is on whole names.** `a.txt` owns `a.txt` and `a.txt#chunk0`, never `a.txt.bak`, and an empty path is refused
 *    rather than read as every file of the space.
 *
 * Run: node --test testing/standalone/the-link-remover-of-a-delete-keeps-what-is-not-its-to-remove-db.test.js
 * (requires the harness Mongo and a prior `npm run build:server`)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { openFileActDoors } from './_file-act-doors.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();
const S = 'linkremover';
const OLD = '2026-09-01T00:00:00.000Z';
let acts, remover, selector;

/** A link row from `from` to `to` written at `createdAt`, by `who` as `acts.links.put` says; returns the id. */
async function putAt(from, to, who, createdAt) {
  const id = await acts.links.put(from, to, who);
  await acts.door.coll(S, 'links').updateOne({ _id: id }, { $set: { createdAt } });
  return id;
}

describe('the remover of a delete\'s links', { skip }, () => {
  before(async () => {
    acts = await openFileActDoors({ suite: 'linkremover', space: S });
    remover = await import('../../server/dist/files/remove-file-here.js');
    selector = await import('../../server/dist/brain/link-adjacency.js');
  });
  after(async () => { await acts?.close(); });
  beforeEach(async () => { await acts.links.reset(); });

  it('the second pass takes a link written by the instant the row went and never one written after it', async () => {
    const early = await putAt('f/a.txt', 'e1', 'self', '2026-09-01T00:00:00.000Z');
    const late = await putAt('f/a.txt', 'e2', 'self', '2026-09-01T00:00:10.000Z');
    const removed = await remover.removeLinksOfDeletedFiles(S, 'f/a.txt', 'file', { createdUntil: '2026-09-01T00:00:05.000Z' });
    assert.equal(removed, 1);
    assert.deepEqual(await acts.links.idsUnder('f/a.txt'), [late], 'the link written after the instant was taken, or the one before it was not');
    assert.deepEqual(await acts.links.tombstoned(), [early]);
    assert.equal(await remover.removeLinksOfDeletedFiles(S, 'f/a.txt', 'file'), 1, 'without a bound the remaining link is taken');
    assert.deepEqual(await acts.links.idsUnder('f/a.txt'), []);
  });

  it('a file still on disk keeps its links and those of its derived ids; the links of the files that went do not stay', async () => {
    const gone = [await putAt('d/gone.txt', 'e1', 'self', OLD), await putAt('d/gone.txt#chunk0', 'e1', 'self', OLD)];
    const kept = [await putAt('d/kept.txt', 'e1', 'self', OLD), await putAt('d/kept.txt#chunk0', 'e1', 'self', OLD)];
    const removed = await remover.removeLinksOfDeletedFiles(S, 'd', 'directory', { surviving: ['d/kept.txt'] });
    assert.equal(removed, gone.length);
    assert.deepEqual(await acts.links.idsUnder('d'), [...kept].sort(), 'a link of the surviving file or of its derived id was removed, or a link of a file that went stayed');
    assert.deepEqual(await acts.links.tombstoned(), [...gone].sort());
  });

  it('a link another instance wrote, or one that is not file-sourced, is not removed and writes no tombstone', async () => {
    await putAt('p/a.txt', 'e1', 'peer', OLD);
    await acts.door.coll(S, 'links').insertOne({ _id: 'fact-link', spaceId: S, from: 'p/a.txt', fromKind: 'fact', to: 'e1', toKind: 'entity', createdAt: OLD, updatedAt: OLD, seq: 9 });
    assert.equal(await remover.removeLinksOfDeletedFiles(S, 'p/a.txt', 'file'), 0);
    assert.equal((await acts.links.idsFrom('p/a.txt')).length, 2);
    assert.deepEqual(await acts.links.tombstoned(), []);
  });

  it('selects on whole names, and refuses an empty path', async () => {
    await putAt('n/a.txt', 'e1', 'self', OLD);
    await putAt('n/a.txt#chunk0', 'e1', 'self', OLD);
    await putAt('n/a.txt.bak', 'e1', 'self', OLD);
    await putAt('n/a', 'e1', 'self', OLD);
    assert.deepEqual((await selector.fileLinkSourcesOf(S, 'n/a.txt', 'file')).sort(), ['n/a.txt', 'n/a.txt#chunk0']);
    assert.deepEqual((await selector.fileLinkSourcesOf(S, 'n', 'directory')).sort(), ['n/a', 'n/a.txt', 'n/a.txt#chunk0', 'n/a.txt.bak']);
    for (const kind of ['file', 'directory']) {
      await assert.rejects(() => selector.fileLinkSourcesOf(S, '', kind), RangeError);
      await assert.rejects(() => selector.fileLinkSourcesOf(S, '/', kind), RangeError);
    }
  });
});
