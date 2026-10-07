/**
 * A peer's file tombstone is validated ELEMENT BY ELEMENT before anything is read or deleted, and one POST carries a bounded
 * number of them (bundle-51 Q-242, Q-396).
 *
 * ## What a peer's tombstone is, to the code that applies it
 *
 * Text a peer chose. Its `path` reaches the file system and the database, its `deletedAt` becomes a position that pruning and
 * acknowledgement compare as a string, its `issuer` becomes the attribution the next hop judges, its `rowSeq` is compared with
 * a number. The old apply read none of them as anything: a `path` it could not normalise was skipped silently, a `deletedAt` of
 * any string (or none) was stored, an element of any shape either applied or vanished, and a body of any length was applied
 * whole inside one request. The rules now:
 *
 *  1. **A path that leaves the space is refused and touches nothing.** Not normalised into the tree: refused, counted, and a
 *     file outside the space's directory is exactly as it was. (A `..` segment, however it is spelled.)
 *  2. **A `deletedAt` that is not a comparable ISO timestamp is refused ALONE.** The element is counted in `refused`, nothing
 *     of it is stored or applied, and the rest of the page applies. One that is comparable but absurd (the year 9999) is
 *     CLAMPED, never stored as the position: a far-future position would sit above every acknowledgement for ever.
 *  3. **Every other malformed element is refused alone**: no `_id`, a path that is not text, an empty or overlong one, an
 *     `issuer` that is not text, a `rowSeq` that is not a valid seq.
 *  4. **The answer says what happened**: `applied` keeps its meaning (admitted by shape), `refused` counts the refusals.
 *  5. **A POST over the per-request cap is refused WHOLE (400), before anything is read** — an honest sender pages well under
 *     it; the cap is the same constant the record tombstone route holds, not a second one.
 *
 * Rules 1-3 are held on the push door and the pull door (the pull seeds the malformed element on the peer's storage and the
 * real `GET` handler serves it); 4 and 5 are the push door's answer.
 *
 * Run: node --test testing/standalone/a-peer-file-tombstone-is-refused-by-shape-and-cap-db.test.js
 * (requires a prior `npm run build:server`)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { build, peerToken } from './_push-door.mjs';
import { openPullDoor, PEER, PEER_AUTHOR } from './_pull-door.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();

const S = 'ftshp';
let door, MAX;

const row = (id) => door.coll(S, 'files').findOne({ _id: id });
const tombs = () => door.coll(S, 'file_tombstones').find({}).toArray();
async function seedFile(p) {
  door.writeLocalFile(S, p, `bytes of ${p}`);
  await door.coll(S, 'files').insertOne(build.filemeta(S, p, 3, { author: PEER_AUTHOR, sizeBytes: 11 }));
}
const tomb = (p, extra = {}) => ({ _id: `ft-${p}`, spaceId: S, path: p, deletedAt: '2026-09-01T00:00:05.000Z', issuer: PEER, rowSeq: 3, ...extra });

const DOORS = {
  push: { async deliver(tombstones) { return door.push('/file-tombstones', { spaceId: S, tombstones }, { spaceId: S, token: peerToken(PEER) }); } },
  pull: {
    async deliver(tombstones) {
      // One valid position for every row, whatever its `deletedAt` says: the peer's own paging must serve the malformed element too.
      await door.seedPeerFileTombstones(S, tombstones.map(t => ({ ...t, spaceId: door.peerSide(S), positionAt: '2026-09-01T00:00:05.000Z' })));
      return door.sync();
    },
  },
};

/** A file OUTSIDE every space's tree: the data root's `files/` directory itself. */
const canaryPath = () => path.join(door.localFilesRoot(S), '..', 'canary.txt');

describe('a peer file tombstone is refused by shape, element by element', { skip }, () => {
  before(async () => {
    door = await openPullDoor({ suite: 'ftshape', spaces: [S], files: true, lateral: true });
    ({ MAX_TOMBSTONES_PER_REQUEST: MAX } = await import('../../server/dist/sync/tombstone-apply.js'));
  });
  after(async () => { await door?.close(); });
  beforeEach(async () => {
    await door.reset();
    fs.writeFileSync(canaryPath(), 'outside every space');
  });

  for (const [name, d] of Object.entries(DOORS)) {
    describe(`${name} door`, () => {
      it('a path that leaves the space is refused: nothing outside the tree is touched, nothing is stored, the rest applies', async () => {
        await seedFile('good.txt');
        const traversals = ['../canary.txt', 'a/../../canary.txt', 'sub/../../canary.txt'];
        const answer = await d.deliver([...traversals.map((p, i) => tomb(p, { _id: `ft-trav-${i}` })), tomb('good.txt')]);
        assert.ok(fs.existsSync(canaryPath()), 'a path with a ".." segment removed a file OUTSIDE the space\'s directory');
        assert.ok(!door.localFileExists(S, 'good.txt'), 'the sound element beside the refused ones was not applied');
        assert.deepEqual((await tombs()).map(t => t._id), ['ft-good.txt'], 'a traversal tombstone was stored (it would be served onward)');
        if (name === 'push') assert.equal(answer.body.refused, traversals.length, `refusals are not counted on the wire: ${JSON.stringify(answer.body)}`);
      });

      it('a deletedAt that is not a comparable ISO timestamp is refused ALONE', async () => {
        const bad = [['bad-word', 'yesterday'], ['bad-date-only', '2026-09-01'], ['bad-offset', '2026-09-01T00:00:00.000+02:00'], ['bad-none', undefined], ['bad-number', 1788220800000]];
        for (const [id] of bad) await seedFile(`${id}.txt`);
        await seedFile('fine.txt');
        const answer = await d.deliver([...bad.map(([id, v]) => tomb(`${id}.txt`, { deletedAt: v })), tomb('fine.txt')]);
        assert.ok(!door.localFileExists(S, 'fine.txt'), 'one malformed deletedAt refused the whole page: the sound element was not applied');
        for (const [id] of bad) {
          assert.ok(door.localFileExists(S, `${id}.txt`), `${id}: an element with an unusable deletedAt was applied (its bytes were removed)`);
          assert.ok(await row(`${id}.txt`), `${id}: an element with an unusable deletedAt removed the file's row`);
        }
        assert.deepEqual((await tombs()).map(t => t._id), ['ft-fine.txt'], 'a tombstone with an unusable deletedAt was stored');
        if (name === 'push') assert.equal(answer.body.refused, bad.length, JSON.stringify(answer.body));
      });

      it('a far-future deletedAt is clamped: applied, and never stored as the position', async () => {
        await seedFile('future.txt');
        const before = Date.now();
        await d.deliver([tomb('future.txt', { deletedAt: '9999-12-31T23:59:59.999Z' })]);
        assert.ok(!door.localFileExists(S, 'future.txt'), 'a comparable-but-absurd deletedAt refused the deletion (it is clamped, not refused)');
        const t = (await tombs())[0];
        assert.ok(t, 'the tombstone was not stored');
        const limit = new Date(before + 24 * 3_600_000).toISOString();
        assert.ok(t.deletedAt <= limit, `deletedAt ${t.deletedAt} was stored as given: it sits above every acknowledgement for ever`);
        if (t.positionAt !== undefined) assert.ok(t.positionAt <= limit, `positionAt ${t.positionAt} is the sender's far-future clock`);
      });

      it('every other malformed element is refused alone and the page still applies', async () => {
        const malformed = [
          ['empty-id', { _id: '' }], ['id-not-text', { _id: 42 }],
          ['path-not-text', { path: 7 }], ['path-empty', { path: '' }], ['path-overlong', { path: `${'a'.repeat(100_000)}.txt` }],
          ['issuer-not-text', { issuer: { instanceId: 'x' } }],
          ['rowseq-negative', { rowSeq: -1 }], ['rowseq-fractional', { rowSeq: 1.5 }], ['rowseq-text', { rowSeq: 'seven' }],
        ];
        for (const [id] of malformed) await seedFile(`m-${id}.txt`);
        await seedFile('sound.txt');
        const page = [...malformed.map(([id, over]) => ({ ...tomb(`m-${id}.txt`), ...over })), tomb('sound.txt')];
        const answer = await d.deliver(page);
        assert.ok(!door.localFileExists(S, 'sound.txt'), 'a malformed element refused the whole page');
        const applied = [];
        for (const [id] of malformed) if (!door.localFileExists(S, `m-${id}.txt`)) applied.push(id);
        assert.deepEqual(applied, [], 'malformed elements that were applied anyway');
        assert.deepEqual((await tombs()).map(t => t.path), ['sound.txt'], 'a malformed element was stored');
        if (name === 'push') assert.equal(answer.body.refused, malformed.length, JSON.stringify(answer.body));
      });
    });
  }

  describe('the push answer and the per-request cap', () => {
    it('the answer carries applied and refused; applied keeps meaning "admitted by shape"', async () => {
      await seedFile('a1.txt');
      const res = await door.push('/file-tombstones', { spaceId: S, tombstones: [tomb('a1.txt'), tomb('../canary.txt', { _id: 'ft-t' })] },
        { spaceId: S, token: peerToken(PEER) });
      assert.equal(res.code, 200, JSON.stringify(res.body));
      assert.deepEqual([res.body.applied, res.body.refused], [1, 1], `the answer does not count the refusal: ${JSON.stringify(res.body)}`);
    });

    it('a POST of more than the cap is refused whole (400), before any element is applied', async () => {
      await seedFile('first.txt');
      const page = [tomb('first.txt'), ...Array.from({ length: MAX }, (_, i) => tomb(`filler-${i}.txt`, { _id: `ft-filler-${i}` }))];
      assert.equal(page.length, MAX + 1);
      const res = await door.push('/file-tombstones', { spaceId: S, tombstones: page }, { spaceId: S, token: peerToken(PEER) });
      assert.equal(res.code, 400, `a body of ${page.length} tombstones was accepted (cap ${MAX}): ${JSON.stringify(res.body)}`);
      assert.ok(await row('first.txt'), 'the first element of a refused page was applied');
    });

    it('a POST of exactly the cap is accepted (the control: the cap refuses the excess, not the page)', async () => {
      const page = Array.from({ length: MAX }, (_, i) => tomb(`filler-${i}.txt`, { _id: `ft-filler-${i}` }));
      const res = await door.push('/file-tombstones', { spaceId: S, tombstones: page }, { spaceId: S, token: peerToken(PEER) });
      assert.equal(res.code, 200, JSON.stringify(res.body));
    });
  });
});
