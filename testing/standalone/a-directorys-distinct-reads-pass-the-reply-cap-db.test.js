/**
 * The reads that name what a directory holds are not capped by one reply (bundle-44, preship).
 *
 * ## The defect
 *
 * A directory move, the abandon of one and a directory delete take their roots from two reads: the parents every derived row under
 * the directory names (`rootsOfDirectory`) and the files its links start from (`fileLinkSourcesUnder`). Both were the driver's
 * `distinct`, which answers in ONE reply of at most 16 MB; a directory with enough files under it made the act fail with a size
 * error where the cursor reads they replaced had no ceiling. Both are `distinctStringsOf` now (`db/distinct-strings.ts`), an
 * aggregation read as a cursor.
 *
 * ## What is asserted, at a size that passes the cap
 *
 * - The fixture is past the cap: the driver's own `distinct` over it is REFUSED. Without that the cases below prove nothing about
 *   size.
 * - `distinctStringsOf` returns every distinct value, once, over the same data; `rootsOfDirectory` and `fileLinkSourcesUnder` do the
 *   same through their real collections, with the empty-root refusal and the anchored, escaped prefix kept.
 * - Only matching string values come back: a filter, an absent, null or non-string value and a repeated value change nothing but what
 *   they should; a dotted field works; a failing read throws instead of returning part of the answer.
 *
 * Run: node --test testing/standalone/a-directorys-distinct-reads-pass-the-reply-cap-db.test.js   (after `npm run build:server`)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';

const skip = await mongoSkipReason();
const S = 'distinctcap';
/** Values this long, this many of them: past 16 MB in one `distinct` reply. */
const VALUE_BYTES = 4000;
const VALUES = 5000;
const PAD = 'x'.repeat(VALUE_BYTES);

let mongo, distinct, derived, adjacency;

const files = () => mongo.col(`${S}_files`);
const links = () => mongo.col(`${S}_links`);
const big = (prefix, i) => `${prefix}/${String(i).padStart(6, '0')}${PAD}`;

/** Insert `docs` in batches the driver takes comfortably, by the server's own chunker. */
async function insertInBatches(coll, docs) {
  const { inChunks } = await import('../../server/dist/util/chunks.js');
  for (const batch of inChunks(docs, 500)) await coll.insertMany(batch);
}

describe('what a directory holds is read past the one-reply cap (real MongoDB)', { skip }, () => {
  before(async () => {
    mongo = await openTestMongo('distinctcap');
    distinct = await import('../../server/dist/db/distinct-strings.js');
    derived = await import('../../server/dist/files/derived-rows.js');
    adjacency = await import('../../server/dist/brain/link-adjacency.js');
  });
  after(async () => { await closeTestMongo(); });
  beforeEach(async () => {
    await files().deleteMany({});
    await links().deleteMany({});
  });

  it('fixture: the driver\'s own distinct is refused at this size, so the cases below are about size', async () => {
    await insertInBatches(files(), Array.from({ length: VALUES }, (_, i) => ({ _id: `row${i}`, parentFileId: big('dir', i) })));
    await assert.rejects(() => files().distinct('parentFileId', { parentFileId: { $regex: '^dir/' } }), /16|too big|BSONObjectTooLarge|size/i,
      'distinct answered a reply past 16 MB: the fixture is too small to say anything about the cap');
  });

  it('distinctStringsOf returns every distinct value past the cap, once each', async () => {
    const docs = Array.from({ length: VALUES }, (_, i) => ({ _id: `row${i}`, parentFileId: big('dir', i % (VALUES - 10)) }));
    await insertInBatches(files(), docs);
    const got = await distinct.distinctStringsOf(files(), 'parentFileId', { parentFileId: { $regex: '^dir/' } });
    assert.equal(got.length, VALUES - 10, 'a value was dropped or repeated');
    assert.equal(new Set(got).size, got.length);
    assert.equal(got.every(v => v.startsWith('dir/')), true);
  });

  it('rootsOfDirectory answers a directory whose roots pass the cap, and keeps the prefix anchored and the empty root refused', async () => {
    await insertInBatches(files(), [
      ...Array.from({ length: VALUES }, (_, i) => ({ _id: `row${i}`, parentFileId: big('dir', i) })),
      { _id: 'other1', parentFileId: `dir2/${PAD}` }, { _id: 'other2', parentFileId: `xdir/${PAD}` },
    ]);
    const roots = await derived.rootsOfDirectory(S, 'dir');
    assert.equal(roots.length, VALUES, 'the directory\'s roots are not all there');
    assert.equal(roots.some(r => r.startsWith('dir2/') || r.startsWith('xdir/')), false, 'a path that only STARTS like the directory was taken');
    await assert.rejects(() => derived.rootsOfDirectory(S, ''), RangeError);
    await assert.rejects(() => derived.rootsOfDirectory(S, '/'), RangeError);
  });

  it('fileLinkSourcesUnder answers a directory whose link sources pass the cap, escaped and anchored, empty root refused', async () => {
    await insertInBatches(links(), [
      ...Array.from({ length: VALUES }, (_, i) => ({ _id: `link${i}`, from: big('d.r', i), fromKind: 'file', to: 'e', toKind: 'entity' })),
      { _id: 'o1', from: `dXr/${PAD}`, fromKind: 'file', to: 'e', toKind: 'entity' },   // `.` is not a wildcard
      { _id: 'o2', from: `d.r/${PAD}`, fromKind: 'entity', to: 'e', toKind: 'entity' },   // not a file's link
    ]);
    const sources = await adjacency.fileLinkSourcesUnder(S, 'd.r');
    assert.equal(sources.length, VALUES, 'a link source is missing, or one that is not the directory\'s was returned');
    assert.equal(sources.every(s => s.startsWith('d.r/')), true);
    await assert.rejects(() => adjacency.fileLinkSourcesUnder(S, ''), RangeError);
  });

  it('only matching string values come back: a filter, absent, null and non-string values, repeats, a dotted field', async () => {
    await files().insertMany([
      { _id: 'a', parentFileId: 'p1', author: { instanceId: 'i1' } }, { _id: 'b', parentFileId: 'p1', author: { instanceId: 'i1' } },
      { _id: 'c', parentFileId: 'p2', author: { instanceId: 'i2' } }, { _id: 'd', parentFileId: null }, { _id: 'e' },
      { _id: 'f', parentFileId: 7 }, { _id: 'g', parentFileId: 'q1', author: { instanceId: 'i3' } },
    ]);
    const sorted = (xs) => [...xs].sort();
    assert.deepEqual(sorted(await distinct.distinctStringsOf(files(), 'parentFileId', {})), ['p1', 'p2', 'q1'], 'null, absent and non-string values must not come back, a repeat once');
    assert.deepEqual(sorted(await distinct.distinctStringsOf(files(), 'parentFileId', { parentFileId: { $regex: '^p' } })), ['p1', 'p2'], 'a filter on the field itself was overwritten');
    assert.deepEqual(sorted(await distinct.distinctStringsOf(files(), 'author.instanceId', { _id: { $in: ['a', 'c', 'g'] } })), ['i1', 'i2', 'i3']);
    await assert.rejects(() => distinct.distinctStringsOf(files(), '$parentFileId', {}), RangeError, 'an expression was taken for a field path');
  });

  it('a read that fails throws, and returns no part of the answer', async () => {
    await files().insertOne({ _id: 'a', parentFileId: 'p1' });
    await assert.rejects(() => distinct.distinctStringsOf(files(), 'parentFileId', { $badOperator: 1 }));
  });
});
