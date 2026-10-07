/**
 * A peer's file tombstone, once it is authorised, removes EVERYTHING the file left here — on both doors, by one apply
 * (bundle-51 Q-242).
 *
 * ## The defect
 *
 * A file is not one blob. It is bytes on disk, a metadata row, the rows and sidecar files its conversion made (chunks, a
 * `_converted/` markdown, an `_extracted/` tree), a queued media job, a cached content hash in `<space>_file_hashes`, and a
 * usage figure. The local delete (`deleteFileCascade`) removes all of them in one order. The two peer doors each removed
 * ONE of those: the push route unlinked the bytes and left the row, so the listing still showed a file that was gone; the pull
 * removed bytes and row and left the chunks, the sidecars, the job (retrying for ever against a missing path) and the hash
 * cache. Two doors, two different leftovers, neither the cascade's. The apply is now one function that runs the cascade's
 * steps, and what a test of it must hold is the WHOLE list, so a step the next change forgets is a named failure.
 *
 * ## The rules
 *
 *  1. every artefact of the file is gone: bytes, row, chunk rows, conversion sidecars on disk, media job, hash-cache entry
 *  2. nothing that is not the file's goes: a neighbour with the same name prefix, another file's chunk rows and sidecars
 *  3. no prefix delete: a tombstone naming a directory removes nothing under it (a peer's tombstone is for ONE path)
 *  4. with `softDeleteFileMeta` the row is kept and flagged `deletedAt`, the bytes and artefacts still go
 *
 * Each is held on the push door (`POST /api/sync/file-tombstones`) and the pull door (the engine's tombstone step against
 * a fake peer serving the real `GET` handler). The authority is not the subject here (see
 * `a-peer-file-tombstone-is-judged-by-the-deletion-authority-db`): the file is the deliverer's own, so the deletion is authorised.
 *
 * Run: node --test testing/standalone/a-peer-file-tombstone-removes-everything-the-file-left-db.test.js
 * (requires a prior `npm run build:server`)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { build, peerToken } from './_push-door.mjs';
import { openPullDoor, PEER, PEER_AUTHOR } from './_pull-door.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();

const S = 'ftcas';
const GONE = 'docs/a.txt';
const NEIGHBOUR = 'docs/a.txt2';
const OTHER = 'docs/b.txt';

let door;

const row = (id) => door.coll(S, 'files').findOne({ _id: id });
const rows = (filter) => door.coll(S, 'files').find(filter).toArray();

/** A file with every artefact a converted, queued file has. `of` is its path. */
async function seedWholeFile(of) {
  door.writeLocalFile(S, of, `bytes of ${of}`);
  door.writeLocalFile(S, `_converted/${of}.md`, `# converted ${of}`);
  door.writeLocalFile(S, `_extracted/${of}/img.png`, 'png');
  await door.coll(S, 'files').insertMany([
    build.filemeta(S, of, 3, { author: PEER_AUTHOR, sizeBytes: 11 }),
    build.filemeta(S, `${of}#chunk-0`, 4, { author: PEER_AUTHOR, parentFileId: of }),
    build.filemeta(S, `_converted/${of}.md`, 5, { author: PEER_AUTHOR, parentFileId: of }),
  ]);
  await door.coll(S, 'file_hashes').insertOne({ _id: of, size: 11, mtimeMs: 1, sha256: `hash-${of}` });
  await door.coll(S, 'media_jobs').insertOne({ _id: of, spaceId: S, status: 'pending' });
}
/** What is left of a file's artefacts, by name. */
async function leftOf(of) {
  const left = [];
  if (door.localFileExists(S, of)) left.push('bytes');
  if (await row(of)) left.push('row');
  if (await row(`${of}#chunk-0`)) left.push('chunk row');
  if (await row(`_converted/${of}.md`)) left.push('converted row');
  if (door.localFileExists(S, `_converted/${of}.md`)) left.push('converted sidecar on disk');
  if (door.localFileExists(S, `_extracted/${of}/img.png`)) left.push('extracted sidecar on disk');
  if (await door.coll(S, 'file_hashes').findOne({ _id: of })) left.push('hash-cache entry');
  if (await door.coll(S, 'media_jobs').findOne({ _id: of })) left.push('media job');
  return left;
}

const tomb = (path, n = 1) => ({ _id: `ft-${path}`, spaceId: S, path, deletedAt: `2026-09-01T00:00:${String(n).padStart(2, '0')}.000Z`, issuer: PEER, rowSeq: 3 });
const DOORS = {
  push: { async deliver(tombstones) { return door.push('/file-tombstones', { spaceId: S, tombstones }, { spaceId: S, token: peerToken(PEER) }); } },
  pull: {
    async deliver(tombstones) {
      await door.seedPeerFileTombstones(S, tombstones.map(t => ({ ...t, spaceId: door.peerSide(S), positionAt: t.deletedAt })));
      return door.sync();
    },
  },
};

describe('a peer file tombstone removes everything the file left here', { skip }, () => {
  before(async () => { door = await openPullDoor({ suite: 'ftcascade', spaces: [S], files: true }); });
  after(async () => { await door?.close(); });
  beforeEach(async () => {
    await door.reset();
    for (const part of ['media_jobs', 'file_hashes']) await door.coll(S, part).deleteMany({});
    door.config().softDeleteFileMeta = false;
  });

  for (const [name, d] of Object.entries(DOORS)) {
    describe(`${name} door`, () => {
      it('the file, its row, its chunk and conversion artefacts, its job and its hash-cache entry all go', async () => {
        await seedWholeFile(GONE);
        assert.deepEqual((await leftOf(GONE)).length, 8, 'fixture: the file does not have every artefact');
        await d.deliver([tomb(GONE)]);
        assert.deepEqual(await leftOf(GONE), [], 'what the tombstone left behind — every one of these is something the local delete removes');
      });

      it('nothing that is not the file\'s goes: a name-prefix neighbour and another file\'s artefacts stay', async () => {
        await seedWholeFile(GONE);
        await seedWholeFile(NEIGHBOUR);
        await seedWholeFile(OTHER);
        await d.deliver([tomb(GONE)]);
        assert.deepEqual(await leftOf(GONE), []);
        for (const kept of [NEIGHBOUR, OTHER]) {
          assert.equal((await leftOf(kept)).length, 8, `${kept} lost artefacts to a tombstone for ${GONE}: left ${await leftOf(kept)}`);
        }
      });

      it('a tombstone for a directory path removes nothing under it (no prefix delete)', async () => {
        await seedWholeFile(OTHER);
        await d.deliver([tomb('docs')]);
        assert.equal((await leftOf(OTHER)).length, 8, `a tombstone naming 'docs' removed what is under it: left ${await leftOf(OTHER)}`);
        assert.ok(door.localFileExists(S, 'docs'), 'the directory itself was removed');
      });

      it('with softDeleteFileMeta the row is kept and flagged, and the bytes and artefacts still go', async () => {
        door.config().softDeleteFileMeta = true;
        await seedWholeFile(GONE);
        await d.deliver([tomb(GONE)]);
        const left = await leftOf(GONE);
        assert.deepEqual(left.filter(x => x !== 'row'), [], 'bytes or artefacts survived a soft delete');
        const r = await row(GONE);
        assert.ok(r, 'a soft delete removed the row (the audit copy)');
        assert.equal(typeof r.deletedAt, 'string', 'the kept row is not flagged deleted: the listing still shows a file whose bytes are gone');
      });

      it('a tombstone whose file is already gone changes nothing and fails nothing (the page still applies)', async () => {
        await seedWholeFile(OTHER);
        await d.deliver([tomb('never-existed.txt', 1), tomb(OTHER, 2)]);
        assert.deepEqual(await leftOf(OTHER), []);
      });
    });
  }
});
