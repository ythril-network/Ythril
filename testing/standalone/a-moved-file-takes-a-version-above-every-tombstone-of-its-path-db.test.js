/**
 * A file this instance moves onto a path takes a version ABOVE every deletion held for that path, and a file uploaded again at a path
 * holding a deleted file's tombstone does too (bundle-112, Q-460).
 *
 * ## The defect
 *
 * A move re-keys a row and used to carry its version unchanged ("this write stamps no version"). A file tombstone records the version of
 * the row it erased (`rowSeq`), and a peer holding one refuses (shadows) every arrival at that path whose version is at or below it. So a file
 * moved back to a path it left (`a -> b -> a`) came back at the version `a`'s own tombstone names, and a file moved onto a path a deleted
 * file had came back at its old, lower version: both refused by every peer holding the deletion. The same held for a file uploaded again at
 * a path whose deleted file's tombstone named a higher version (a peer-authored row deleted here, version 1000, and the re-upload at the
 * counter's next number): `versionsFor` read the held tombstones of the BRAIN collections only.
 *
 * ## The rule this file states
 *
 * The row's version is above every file tombstone's `rowSeq` at its path, and the verdict a receiver reaches over those same tombstones
 * (`shadowDecision`, the one question it asks) is "not shadowed". `updatedAt` and the author are carried (Q-419).
 *
 * ## Seen red
 *
 * On the base (9d5fc992b): the moved rows keep their version (7 and 5), and the re-upload takes the counter's number, below 1000.
 *
 * Run: node --test testing/standalone/a-moved-file-takes-a-version-above-every-tombstone-of-its-path-db.test.js
 * (requires a prior `npm run build` in server/, a reachable mongod, and a private IPv4 on the host: the doors helper binds one)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { openFileActDoors } from './_file-act-doors.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();

const SPACE = 'movedabovetombs';
const PEER = { instanceId: 'peer-instance', instanceLabel: 'Publisher' };
const AUTHORED_AT = '2026-09-01T00:00:00.000Z';

let acts, cascade, deleteCascade, meta, shadow, author;

const row = (id) => acts.door.coll(SPACE, 'files').findOne({ _id: id });
const tombstonesAt = (p) => acts.door.coll(SPACE, 'file_tombstones').find({ path: p }).toArray();

/** What a row this instance wrote holds: its own author, a past clock, and the version the case names. */
const localFields = (seq, extra = {}) => ({
  tags: ['moved'], description: 'written here', author: author.authorRef(), createdAt: AUTHORED_AT, updatedAt: AUTHORED_AT, seq, deliveredBy: '', ...extra,
});

/** The highest version any file tombstone of `p` names. */
async function highestTombstonedAt(p) {
  const seqs = (await tombstonesAt(p)).map(t => t.rowSeq).filter(n => typeof n === 'number');
  assert.ok(seqs.length > 0, `fixture: no file tombstone at '${p}' names a version`);
  return Math.max(...seqs);
}

/** What a receiver holding every tombstone of `p` decides about the row at `p` arriving from its author: shadowed or not. */
async function shadowedAtReceiver(p, stored) {
  const held = shadow.heldByPath(await tombstonesAt(p)).get(p) ?? [];
  return shadow.shadowDecision(held, { kind: 'meta', seq: stored.seq, author: stored.author?.instanceId });
}

describe('a moved or re-uploaded file takes a version above the deletions held for its path (real MongoDB)', { skip }, () => {
  before(async () => {
    acts = await openFileActDoors({ suite: 'movedabovetombs', space: SPACE });
    cascade = await import('../../server/dist/files/move-cascade.js');
    deleteCascade = await import('../../server/dist/files/delete-cascade.js');
    meta = await import('../../server/dist/files/file-meta.js');
    shadow = await import('../../server/dist/files/tombstone-shadow.js');
    author = await import('../../server/dist/config/author.js');
  });
  after(async () => { await acts?.close(); });
  beforeEach(async () => { await acts.reset(); });

  it('a file moved away and back (a -> b -> a) comes back above the tombstone its first move left at a, and is not shadowed', async () => {
    await acts.seed('a.md', localFields(7));
    const before = await row('a.md');
    await cascade.moveFileCascade(SPACE, 'a.md', 'b.md');
    await cascade.moveFileCascade(SPACE, 'b.md', 'a.md');

    const back = await row('a.md');
    assert.ok(back, 'fixture: the row is not at its original path after the round trip');
    const tomb = await highestTombstonedAt('a.md');
    assert.ok(back.seq > tomb,
      `the file moved back to a.md is at version ${back.seq}, not above the ${tomb} its own deletion at a.md names: every peer holding that tombstone refuses it`);
    assert.equal(await shadowedAtReceiver('a.md', back), false, 'a peer holding the path\'s tombstones would still shadow the moved file');
    assert.equal(back.updatedAt, before.updatedAt, 'the move changed updatedAt (Q-419: the move carries the author\'s clock)');
    assert.deepEqual(back.author, before.author, 'the move changed the author');
  });

  it('a file moved onto a path a deleted file had takes a version above that file\'s deletion', async () => {
    await acts.seed('x.md', localFields(5));
    await acts.seed('dst.md', localFields(8));
    await deleteCascade.deleteFileCascade(SPACE, 'dst.md');
    assert.equal(await row('dst.md'), null, 'fixture: the file at dst.md was not deleted');
    const tomb = await highestTombstonedAt('dst.md');
    assert.ok(tomb >= 8, `fixture: the tombstone at dst.md names version ${tomb}, not the 8 of the erased row`);

    await cascade.moveFileCascade(SPACE, 'x.md', 'dst.md');

    const moved = await row('dst.md');
    assert.ok(moved, 'fixture: the file was not moved onto dst.md');
    assert.ok(moved.seq > tomb, `the file moved onto dst.md is at version ${moved.seq}, not above the ${tomb} of the deleted file's tombstone`);
    assert.equal(await shadowedAtReceiver('dst.md', moved), false, 'a peer holding dst.md\'s tombstone would shadow the moved file');
  });

  it('a file uploaded again at a path holding the tombstone of a peer-authored file deleted here lands above that tombstone', async () => {
    await acts.seed('re.md', localFields(1000, { author: PEER, deliveredBy: PEER.instanceId }));
    await deleteCascade.deleteFileCascade(SPACE, 're.md');
    assert.equal(await row('re.md'), null, 'fixture: the peer-authored file was not deleted');
    const tomb = await highestTombstonedAt('re.md');
    assert.ok(tomb >= 1000, `fixture: the tombstone at re.md names version ${tomb}, not the 1000 of the erased row`);

    await meta.upsertFileMeta(SPACE, 're.md', 12);

    const again = await row('re.md');
    assert.ok(again, 'fixture: the re-upload wrote no row');
    assert.ok(again.seq > tomb, `the file uploaded again is at version ${again.seq}, not above the ${tomb} of the deleted file's tombstone`);
    assert.equal(await shadowedAtReceiver('re.md', again), false, 'a peer holding the tombstone would shadow the re-uploaded file');
  });
});
