/**
 * A peer's file tombstone for a path removes the BYTES only when no live record at another id names the same entry here (bundle-44,
 * D-29, Q-437; ruling 42; sweep 1 suspicion).
 *
 * ## The defect
 *
 * A case-only rename is a move to a new id: `a.txt` becomes `A.txt`, the old id's tombstone travels to every peer, and the new file
 * travels as an arrival. On a case-insensitive peer the two ids are one directory entry under two spellings. If the arrival of `A.txt`
 * lands first, the tombstone for `a.txt` then arrives and unlinks the path it names — which is the bytes that just arrived — so the peer
 * holds the record of `A.txt` and no bytes for it, until a later cycle fetches them again, if one ever does.
 *
 * ## The rule
 *
 * The apply of a received file tombstone (`files/peer-tombstone-apply.ts`, one for push and pull) asks, before it unlinks, whether a LIVE
 * record at ANOTHER id names the same entry on this file system. If one does, the tombstone removes the record it names and nothing of
 * the entry: the bytes, the sidecars of the other id and its rows stay. If none does, the apply is what it was: the bytes, the artefacts
 * and the row go. The question is asked of the file system (which spelling the entry really has), so a case-sensitive host, where the two
 * ids are two files, never answers yes.
 *
 * The cases that need the alias run where the files tree is case-insensitive (this development machine is NTFS); on a case-sensitive runner
 * (CI) they skip with `expected-in-ci:` and the cause. The two CONTROL cases need no alias and run on every file system.
 *
 * Run: node --test testing/standalone/a-peer-tombstone-for-an-old-spelling-keeps-the-bytes-db.test.js   (after `npm run build:server`)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { build, peerToken } from './_push-door.mjs';
import { openPullDoor, PEER, PEER_AUTHOR } from './_pull-door.mjs';
import { caseInsensitiveAt } from './_move-destination.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();

const S = 'oldspelling';
// On a case-sensitive file system the old and the new spelling are two entries, so a tombstone for one never names the other's bytes.
// Only the cases that need the alias skip there (listed in testing/_shared/expected-in-ci.mjs); the two CONTROL cases run everywhere.
const SKIPPED = 'expected-in-ci: the file system is case-sensitive';

let door, insensitive;
const row = (id) => door.coll(S, 'files').findOne({ _id: id });
const tree = () => path.join(door.localFilesRoot(S));
const tomb = (p, n = 1, rowSeq = 3) => ({ _id: `ft-${p}-${n}`, spaceId: S, path: p, deletedAt: `2026-09-01T00:00:${String(n).padStart(2, '0')}.000Z`, issuer: PEER, rowSeq });
const deliver = (tombstones) => door.push('/file-tombstones', { spaceId: S, tombstones }, { spaceId: S, token: peerToken(PEER) });

/** What a case-insensitive peer holds after the arrival of `A.txt` landed on top of the entry `a.txt` was: the new bytes under the new spelling, both ids' records. */
async function arrivalOfTheNewSpellingLanded() {
  door.writeLocalFile(S, 'Case.txt', 'the bytes that arrived');
  await door.coll(S, 'files').insertMany([
    build.filemeta(S, 'case.txt', 3, { author: PEER_AUTHOR, sizeBytes: 22 }),
    build.filemeta(S, 'Case.txt', 4, { author: PEER_AUTHOR, sizeBytes: 22 }),
  ]);
}

describe('a peer tombstone for an old spelling keeps the entry another record names', { skip }, () => {
  before(async () => {
    door = await openPullDoor({ suite: 'oldspelling', spaces: [S], files: true });
    insensitive = caseInsensitiveAt(door.localFilesRoot(S));
  });
  after(async () => { await door?.close(); });
  beforeEach(async () => {
    await door.reset();
    for (const part of ['media_jobs', 'file_hashes']) await door.coll(S, part).deleteMany({});
    door.config().softDeleteFileMeta = false;
  });

  it('the tombstone of a.txt arrives after A.txt: the record of a.txt goes, the bytes and the record of A.txt stay', async (t) => {
    if (!insensitive) { t.skip(SKIPPED); return; }
    await arrivalOfTheNewSpellingLanded();

    await deliver([tomb('case.txt')]);

    assert.equal(fs.readFileSync(path.join(tree(), 'Case.txt'), 'utf8'), 'the bytes that arrived', 'the old id\'s tombstone removed the bytes that A.txt\'s arrival had just written');
    assert.deepEqual(fs.readdirSync(tree()).filter(n => n.toLowerCase() === 'case.txt'), ['Case.txt'], 'the entry is gone or renamed');
    assert.equal((await row('Case.txt'))?._id, 'Case.txt', 'the live record of the new spelling was removed');
    assert.equal(await row('case.txt'), null, 'the record the tombstone names was not removed');
  });

  it('what the old id\'s record derived goes with it (chunks, a converted-sidecar row, an extracted image and its caption, the job), and nothing of the new id\'s does', async (t) => {
    if (!insensitive) { t.skip(SKIPPED); return; }
    await arrivalOfTheNewSpellingLanded();
    door.writeLocalFile(S, '_converted/Case.txt.md', '# converted');
    const derived = (id, parent) => build.filemeta(S, id, 5, { author: PEER_AUTHOR, parentFileId: parent, sizeBytes: 1 });
    await door.coll(S, 'files').insertMany([
      derived('case.txt#chunk-0', 'case.txt'), derived('_converted/case.txt.md', 'case.txt'),
      derived('_extracted/case.txt/img.png', 'case.txt'), derived('_extracted/case.txt/img.png#caption', '_extracted/case.txt/img.png'),
      derived('Case.txt#chunk-0', 'Case.txt'), derived('_converted/Case.txt.md', 'Case.txt'),
    ]);
    await door.coll(S, 'media_jobs').insertMany([{ _id: 'case.txt', spaceId: S, status: 'pending' }, { _id: 'Case.txt', spaceId: S, status: 'pending' }]);

    await deliver([tomb('case.txt', 5)]);

    const left = (await door.coll(S, 'files').find({}, { projection: { _id: 1 } }).toArray()).map(r => r._id).sort();
    assert.deepEqual(left, ['Case.txt', 'Case.txt#chunk-0', '_converted/Case.txt.md'], 'a row of the old id survived (an orphan), or a row of the new id was removed');
    assert.deepEqual((await door.coll(S, 'media_jobs').find({}).toArray()).map(j => j._id), ['Case.txt'], 'the old id\'s job was not removed, or the new id\'s was');
    assert.equal(fs.readFileSync(path.join(tree(), 'Case.txt'), 'utf8'), 'the bytes that arrived');
    assert.equal(fs.readFileSync(path.join(tree(), '_converted/Case.txt.md'), 'utf8'), '# converted', 'the sidecar the new id\'s record stands on was removed');
  });

  it('the same on the pull door: the tombstone relayed by the sender\'s cycle', async (t) => {
    if (!insensitive) { t.skip(SKIPPED); return; }
    await arrivalOfTheNewSpellingLanded();
    await door.seedPeerFileTombstones(S, [tomb('case.txt', 2)].map(x => ({ ...x, spaceId: door.peerSide(S), positionAt: x.deletedAt })));

    await door.sync();

    assert.equal(fs.readFileSync(path.join(tree(), 'Case.txt'), 'utf8'), 'the bytes that arrived', 'the pull removed the bytes of the new spelling');
    assert.equal(await row('case.txt'), null);
    assert.equal((await row('Case.txt'))?._id, 'Case.txt');
  });

  it('CONTROL: the tombstone of the spelling the entry really has removes its bytes and its record, as before', async () => {
    await arrivalOfTheNewSpellingLanded();

    await deliver([tomb('Case.txt', 3, 4)]);

    assert.deepEqual(fs.readdirSync(tree()).filter(n => n.toLowerCase() === 'case.txt'), [], 'a tombstone for the entry\'s own spelling left its bytes');
    assert.equal(await row('Case.txt'), null, 'a tombstone for the entry\'s own spelling left its record');
  });

  it('CONTROL: no other record names the entry: the tombstone of a.txt removes the bytes and the record', async () => {
    door.writeLocalFile(S, 'only.txt', 'bytes');
    await door.coll(S, 'files').insertOne(build.filemeta(S, 'only.txt', 3, { author: PEER_AUTHOR, sizeBytes: 5 }));

    await deliver([tomb('only.txt', 4)]);

    assert.equal(door.localFileExists(S, 'only.txt'), false, 'a tombstone with no other record to protect left the bytes');
    assert.equal(await row('only.txt'), null);
  });
});
