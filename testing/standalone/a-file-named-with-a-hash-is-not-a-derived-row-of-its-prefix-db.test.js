/**
 * A top-level file whose own name holds a `#` (`a#b.txt`, beside a file `a`) is a file of its own, never a derived row of `a` — in a move, a
 * delete and the repair of what a delete left (bundle-113, the one reading of a derived id: `isDerivedRowOf`, `files/moved-paths.ts`).
 *
 * ## The defect it prevents
 *
 * `a#chunk0` is a derived row of `a` and `a#b.txt` is spelled the same way. The reading of that `#` was written three times — the move's
 * id rule (`movedId`), the selection of a file's links (`fileLinkSourcesOf`, which had the guard) and the delete's "is this link's
 * source a derived row of a file that survives" (`removeLinksOfDeletedFiles`'s own `lastIndexOf('#')`, which had none) — and the repair
 * decides what to delete by the same id rule (`belongsTo`). Read as text alone, the weaker copy re-keys a user's file with its
 * neighbour's move, gives its links to the wrong delete, or removes it as debris. Each case below is the file `a#b.txt` standing by itself
 * with its bytes, its row and a link, beside a file `a` and a real derived row `a#chunk0`, and each act is on `a`.
 *
 * Run: node --test testing/standalone/a-file-named-with-a-hash-is-not-a-derived-row-of-its-prefix-db.test.js
 * (requires a prior `npm run build:server`, and the test MongoDB)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { openFileActDoors } from './_file-act-doors.mjs';
import { runPass, spaceEntry, addedKeys, derivedRow } from './_leaked-rows-repair.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();
const S = 'hashname';
const T0 = '2026-08-01T00:00:00.000Z';
const OWN = 'a#b.txt';

let acts, SELF, knownKeys, remover;
const files = () => acts.door.coll(S, 'files');
const rowOf = (id) => files().findOne({ _id: id });

/** `a` and its real derived row, and the file named `a#b.txt` standing by itself, each with a link written by this instance. */
async function seedNeighbours() {
  await acts.seed('a');
  await acts.seed(OWN);
  await files().insertOne(derivedRow(S, 'a#chunk0', 'a', { createdAt: T0, updatedAt: T0 }));
  await acts.links.putMany(['a', 'a#chunk0', OWN], 'e1', 'self');
}

describe('a top-level file named a#b.txt is not a derived row of a (real MongoDB)', { skip }, () => {
  before(async () => {
    acts = await openFileActDoors({ suite: 'hashname', space: S });
    SELF = (await import('../../server/dist/config/author.js')).authorRef().instanceId;
    remover = await import('../../server/dist/files/remove-file-here.js');
    knownKeys = Object.keys(await spaceEntry(S));
  });
  after(async () => { await acts?.close(); });
  beforeEach(async () => {
    await acts.reset();
    for (const part of ['links', 'media_jobs', 'tombstones']) await acts.door.coll(S, part).deleteMany({});
    const entry = await spaceEntry(S);
    for (const k of addedKeys(entry, knownKeys)) delete entry[k];
  });

  it('a move of a does not carry it: its row, bytes and links stay where they are, and the real derived row follows a', async () => {
    await seedNeighbours();

    const answer = await acts.move('REST', 'a', 'c');

    assert.equal(acts.statusOf(answer), 200, `the move of a failed: ${JSON.stringify(answer.body)}`);
    assert.ok(await rowOf(OWN), 'the file named a#b.txt lost its record to the move of a');
    assert.equal(await rowOf('c#b.txt'), null, 'the file named a#b.txt was re-keyed to c#b.txt as if it were a derived row of a');
    assert.ok(acts.onDisk(OWN), 'the bytes of the file named a#b.txt moved with a');
    assert.equal(acts.onDisk('c#b.txt'), false);
    assert.equal((await acts.links.idsFrom(OWN)).length, 1, 'the link of the file named a#b.txt was taken by the move of a');
    assert.equal((await rowOf('c#chunk0'))?.parentFileId, 'c', 'the real derived row did not follow a');
    assert.equal(await rowOf('a#chunk0'), null);
  });

  it('a delete of a does not take it: its row, bytes and links stay, and the links of a and of its real derived row go', async () => {
    await seedNeighbours();

    const answer = await acts.del('REST', 'a');

    const status = acts.statusOf(answer);   // a delete's success is 204 on REST
    assert.ok(status >= 200 && status < 300, `the delete of a failed (${status}): ${JSON.stringify(answer.body)}`);
    assert.ok(await rowOf(OWN), 'the file named a#b.txt lost its record to the delete of a');
    assert.ok(acts.onDisk(OWN), 'the bytes of the file named a#b.txt went with a');
    assert.equal((await acts.links.idsFrom(OWN)).length, 1, 'the delete of a took the link of the file named a#b.txt');
    assert.deepEqual(await acts.links.idsFrom('a', 'a#chunk0'), [], 'a link of a or of its derived row stayed');
    assert.equal(await rowOf('a#chunk0'), null, 'the real derived row stayed');
  });

  it('a directory delete that leaves a surviving: the file named a#b.txt is not kept as a derived row of the survivor, a real derived row is', async () => {
    await acts.links.putMany(['d/a', 'd/a#chunk0', 'd/a#b.txt'], 'e1', 'self');
    await files().insertMany([
      { _id: 'd/a', spaceId: S, path: 'd/a', createdAt: T0, updatedAt: T0 },
      { _id: 'd/a#b.txt', spaceId: S, path: 'd/a#b.txt', createdAt: T0, updatedAt: T0 },
      derivedRow(S, 'd/a#chunk0', 'd/a', { createdAt: T0, updatedAt: T0 }),
    ]);

    const removed = await remover.removeLinksOfDeletedFiles(S, 'd', 'directory', { surviving: ['d/a'] });

    assert.equal(removed, 1, 'exactly the link of the file that went (d/a#b.txt) is owed');
    assert.deepEqual(await acts.links.idsFrom('d/a#b.txt'), [], 'the file named d/a#b.txt was read as a derived row of the surviving d/a, and kept its links though it was deleted');
    assert.equal((await acts.links.idsFrom('d/a', 'd/a#chunk0')).length, 2, 'the links of the survivor or of its real derived row were removed');
  });

  it('the repair of what a delete left does not remove it, and removes what is a leak: a derived row of the missing a, and the links of a whatever their author', async () => {
    // `a` was deleted here (this instance published its tombstone) and nothing stands at it; `a#b.txt` is a live file of its own.
    await acts.seed(OWN);
    await files().insertOne(derivedRow(S, 'a#chunk0', 'a', { createdAt: T0, updatedAt: T0 }));
    await acts.door.coll(S, 'file_tombstones').insertOne({ _id: randomUUID(), spaceId: S, path: 'a', deletedAt: T0, positionAt: T0, writtenAt: T0, origin: 'own', issuer: SELF });
    const own = await acts.links.putMany([OWN], 'e1', 'self');
    const ofA = [await acts.links.put('a', 'e1', 'self'), await acts.links.put('a', 'e2', 'none')];

    await runPass();

    assert.ok(await rowOf(OWN), 'the repair removed the file named a#b.txt as a derived row of the missing a');
    assert.ok(acts.onDisk(OWN), 'the bytes of the file named a#b.txt went');
    assert.equal(await rowOf('a#chunk0'), null, 'the derived row of the missing a stayed');
    assert.deepEqual(await acts.links.idsFrom(OWN), own, 'the repair took the link of the live file named a#b.txt');
    assert.deepEqual(await acts.links.idsFrom('a'), [], `a link of the deleted a stayed: ${ofA.length} were owed, one written by this instance and one with no author (a row written before authorship was stamped, which the delete takes as this instance's and so does the repair)`);
  });
});
