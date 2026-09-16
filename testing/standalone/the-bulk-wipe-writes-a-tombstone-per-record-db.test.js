/**
 * A space wipe writes one tombstone per record, in one reserved seq range — characterization, before the four
 * copies of it become one.
 *
 * ## Why these exist and why now
 *
 * `bulkDeleteEntities`, `bulkDeleteFacts`, `bulkDeleteEdges` and `bulkDeleteChrono` are the same thirty
 * lines four times, in four of the largest files in the server (`R-4`). Extracting them is the obvious move and
 * the repo rule is the reason it needs tests first: weak coverage plus a refactor means characterization tests
 * as their own change, proven green against the original code.
 *
 * The coverage really is weak. Before this file, the only assertion on any wipe was in
 * `face-label-cascade.test.js` — and it covers the ENTITY one, because the face cascade is what that file is
 * about. The tombstone behaviour of the other three, which is the whole point of a wipe on a synced
 * collection, was asserted nowhere.
 *
 * ## What a wipe has to get right, and why each is a separate case
 *
 * A wipe on a replicated collection is not a delete. It is a delete plus a **tombstone per document**, because
 * a peer that has the record has to be told it is gone; a wipe that empties the collection and writes no
 * tombstones is a wipe that the next sync cycle silently UNDOES, record by record, from the peer's copy.
 *
 * And the seq range is reserved in ONE round trip rather than one `nextSeq()` per document. That is a
 * performance decision with a correctness edge: gaps in the range are harmless because sync compares with `>`,
 * but REUSE would not be, so the block is taken up front and never rolled back. Both halves are asserted,
 * because a rewrite to "one seq per tombstone" would look tidier and would be wrong at 100k documents.
 *
 * ## The one that is NOT the same as the other three
 *
 * The entity wipe also clears every face label in the space, wholesale rather than by `$in` — its own comment
 * says why: on a 100k-entity wipe an id list would build a 100k-element query for a filter meaning "all of
 * them". An extraction that treats the four as identical drops that, and what is left behind is a file-meta
 * record pointing at an entity that no longer exists. `face-label-cascade.test.js` catches it; this file
 * asserts it too, so the case sits beside the three it differs from.
 *
 * Run: `npm run test:up` first, then
 *      node --test testing/standalone/the-bulk-wipe-writes-a-tombstone-per-record-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';

const skip = await mongoSkipReason();

// The tombstone carries `instanceId` from config, so it has to be loadable before the brain modules import.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-bulk-wipe-'));
const CONFIG_PATH = path.join(tmpDir, 'config.json');
process.env['CONFIG_PATH'] = CONFIG_PATH;

const SPACE = 'general';
const INSTANCE = 'bulk-wipe-test';

let mongo, brain, edges, entitiesMod, chronoMod;

const coll = (name) => mongo.col(`${SPACE}_${name}`);
const tombstones = () => coll('tombstones');

/** A minimal stored document of each type — only the fields a wipe reads. */
const doc = (id, extra = {}) => ({ _id: id, spaceId: SPACE, seq: 1, createdAt: '2026-01-01T00:00:00.000Z', ...extra });

/**
 * The four wipes, each with the collection it empties and the tombstone `type` it must write.
 *
 * A table rather than four copied blocks, for the reason the subject of this file is about: the assertions are
 * the same four times, and writing them out four times is how one of them comes to differ.
 */
const WIPES = [
  { name: 'entities', type: 'entity', collection: 'entities' },
  { name: 'facts', type: 'fact', collection: 'facts' },
  { name: 'edges', type: 'edge', collection: 'edges' },
  { name: 'chrono', type: 'chrono', collection: 'chrono' },
];

/** The exported wipe for a type, resolved at run time so a rename fails loudly rather than silently skipping. */
function wipeFor(name) {
  const fns = {
    entities: () => entitiesMod.bulkDeleteEntities(SPACE),
    facts: () => brain.bulkDeleteFacts(SPACE),
    edges: () => edges.bulkDeleteEdges(SPACE),
    chrono: () => chronoMod.bulkDeleteChrono(SPACE),
  };
  const fn = fns[name];
  assert.ok(fn, `no wipe wired for ${name} — re-anchor this gate`);
  return fn;
}

describe('a space wipe tombstones every record it deletes', { skip }, () => {
  before(async () => {
    mongo = await openTestMongo('bulkwipe');
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({
      instanceId: INSTANCE, instanceLabel: 'test', tokens: [], networks: [],
      spaces: [{ id: SPACE, label: 'General', builtIn: true, folders: [] }],
    }, null, 2), { mode: 0o600 });
    const loader = await import('../../server/dist/config/loader.js');
    loader.loadConfig();
    brain = await import('../../server/dist/brain/fact.js');
    edges = await import('../../server/dist/brain/edge-bulk-delete.js');
    entitiesMod = await import('../../server/dist/brain/entities.js');
    chronoMod = await import('../../server/dist/brain/chrono.js');
  });

  after(async () => {
    await closeTestMongo();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  beforeEach(async () => {
    for (const w of WIPES) await coll(w.collection).deleteMany({});
    await tombstones().deleteMany({});
    await coll('files').deleteMany({});
  });

  it('all four wipes are reachable (the suite cannot pass by importing nothing)', () => {
    // Floors every case below: a moved export would make each `it` throw rather than assert, and a typo in the
    // module path would surface as a confusing failure inside one case instead of here.
    for (const w of WIPES) assert.equal(typeof wipeFor(w.name), 'function');
  });

  for (const w of WIPES) {
    it(`${w.name}: every deleted record leaves a tombstone of type '${w.type}'`, async () => {
      /*
       * The reason a wipe is not a delete. A peer holding these records has to be told they are gone; with no
       * tombstone the next sync cycle pulls every one of them back from the peer's copy, and the wipe looks
       * like it silently failed hours later.
       */
      await coll(w.collection).insertMany([doc('a'), doc('b'), doc('c')]);
      const n = await wipeFor(w.name)();

      assert.equal(n, 3, 'the count returned is the number of records deleted');
      assert.equal(await coll(w.collection).countDocuments({}), 0, 'the collection is empty');

      const tombs = await tombstones().find({ type: w.type }).toArray();
      assert.deepEqual(tombs.map(t => t._id).sort(), ['a', 'b', 'c']);
      for (const t of tombs) {
        assert.equal(t.spaceId, SPACE);
        assert.equal(t.instanceId, INSTANCE, 'a tombstone says WHICH instance issued it');
        assert.ok(t.deletedAt, 'and when');
      }
    });

    it(`${w.name}: the tombstone seq range is contiguous, from one reservation`, async () => {
      /*
       * Asserted as a RANGE rather than as specific numbers, because the starting point depends on what the
       * space has already written. What matters is that three tombstones got three consecutive seqs: the block
       * is reserved in one round trip, so a rewrite to `nextSeq()` per document — which reads as simpler — would
       * pay one awaited round trip per record and is the thing this shape exists to avoid.
       */
      await coll(w.collection).insertMany([doc('a'), doc('b'), doc('c')]);
      await wipeFor(w.name)();

      const seqs = (await tombstones().find({ type: w.type }).toArray()).map(t => t.seq).sort((x, y) => x - y);
      assert.equal(seqs.length, 3);
      assert.deepEqual(seqs, [seqs[0], seqs[0] + 1, seqs[0] + 2], 'three records, three consecutive seqs');
      assert.ok(seqs[0] > 0, 'a tombstone seq is never zero — a peer compares with > and would ignore it');
    });

    it(`${w.name}: an empty collection is a no-op that returns 0`, async () => {
      // Not a formality: the early return is what stops `reserveSeqBlock(spaceId, 0)` being called and an
      // empty `bulkWrite` being issued, which Mongo rejects rather than ignoring.
      assert.equal(await wipeFor(w.name)(), 0);
      assert.equal(await tombstones().countDocuments({}), 0, 'and it writes no tombstone at all');
    });

    it(`${w.name}: wiping twice is safe, and the second is the no-op`, async () => {
      // The shape an operator actually produces by double-clicking. The second call must not write a second
      // tombstone per id, because `replaceOne … upsert` would silently bump every seq for no reason.
      await coll(w.collection).insertMany([doc('a'), doc('b')]);
      await wipeFor(w.name)();
      const first = (await tombstones().find({ type: w.type }).toArray()).map(t => t.seq).sort();
      assert.equal(await wipeFor(w.name)(), 0);
      const second = (await tombstones().find({ type: w.type }).toArray()).map(t => t.seq).sort();
      assert.deepEqual(second, first, 'the second wipe left the tombstones exactly as they were');
    });
  }

  it('the MEMORY wipe hands out its tombstone seqs newest-first', async () => {
    /*
     * The memory wipe sorts `{ createdAt: -1, _id: -1 }` and the other three do not. Its stated reason is that
     * recently written docs then land near the front of the generated seq range even on a very large
     * collection.
     *
     * Written when the four became one, because until then NOTHING asserted it: the option could have been
     * dropped in the extraction, or quietly applied to all four, and no test would have moved. A documented
     * property with no test is a property that survives only as long as whoever wrote the comment is reading.
     */
    await coll('facts').insertMany([
      doc('oldest', { createdAt: '2026-01-01T00:00:00.000Z' }),
      doc('newest', { createdAt: '2026-06-01T00:00:00.000Z' }),
      doc('middle', { createdAt: '2026-03-01T00:00:00.000Z' }),
    ]);
    await wipeFor('facts')();

    const byId = new Map((await tombstones().find({ type: 'fact' }).toArray()).map(t => [t._id, t.seq]));
    assert.ok(byId.get('newest') < byId.get('middle'), 'the newest record takes the lowest seq');
    assert.ok(byId.get('middle') < byId.get('oldest'), 'and the oldest takes the highest');
  });

  it('and the other three do NOT sort — they take the collection order', async () => {
    /*
     * The control, and the reason the shared helper takes the sort as an OPTION rather than applying it
     * everywhere. Asserted by absence of the memory ordering rather than by asserting a specific order, because
     * an unsorted find has no guaranteed order to assert — what matters is that the wipe did not impose one.
     */
    await coll('chrono').insertMany([
      doc('a', { createdAt: '2026-01-01T00:00:00.000Z' }),
      doc('b', { createdAt: '2026-06-01T00:00:00.000Z' }),
    ]);
    await wipeFor('chrono')();
    const byId = new Map((await tombstones().find({ type: 'chrono' }).toArray()).map(t => [t._id, t.seq]));
    assert.ok(byId.get('a') < byId.get('b'),
      'chrono took insertion order; a newest-first sort was applied where none was asked for');
  });

  it('a wipe tombstones ONLY its own type, so the four do not tread on each other', async () => {
    /*
     * The case an extraction could plausibly break by passing the wrong type through — and the symptom would be
     * the worst kind: the peer deletes the wrong records, on the strength of a tombstone that looks valid.
     */
    for (const w of WIPES) await coll(w.collection).insertMany([doc(`${w.type}-1`)]);

    await wipeFor('edges')();

    assert.deepEqual((await tombstones().find({}).toArray()).map(t => t.type), ['edge']);
    for (const w of WIPES.filter(x => x.name !== 'edges')) {
      assert.equal(await coll(w.collection).countDocuments({}), 1, `${w.name} was not touched`);
    }
  });

  it('the ENTITY wipe also clears every face label — the one that is not like the others', async () => {
    /*
     * `bulkDeleteEntities` ends with `unlabelAllFaces`, wholesale rather than by `$in`, and its own comment
     * gives the reason: on a 100k-entity wipe an id list would build a 100k-element query for a filter that
     * means "all of them".
     *
     * Here because an extraction that treats the four as identical drops it, and what is left is a file-meta
     * record pointing at an entity that does not exist. `face-label-cascade.test.js` asserts this too; the
     * duplication is deliberate, so the difference sits beside the three cases it differs FROM.
     */
    await coll('entities').insertMany([doc('alice'), doc('bob')]);
    await coll('files').insertOne({
      _id: 'a.jpg#face-chunk0', spaceId: SPACE, parentFileId: 'a.jpg',
      faceEntityId: 'alice', faceScore: 0.9,
    });

    await wipeFor('entities')();

    const face = await coll('files').findOne({ _id: 'a.jpg#face-chunk0' });
    assert.ok(face, 'the file-meta record itself survives — only the label is cleared');
    assert.equal(face.faceEntityId, undefined, 'a label pointing at a deleted entity is a dangling reference');
  });

  it('and the other three leave face labels alone', async () => {
    // The control. Clearing labels on a memory or chrono wipe would be a cascade nobody asked for, and the
    // extraction is exactly where a shared `afterDelete` could be wired to the wrong callers.
    await coll('files').insertOne({
      _id: 'b.jpg#face-chunk0', spaceId: SPACE, parentFileId: 'b.jpg',
      faceEntityId: 'carol', faceScore: 0.8,
    });
    await coll('facts').insertOne(doc('m1'));
    await wipeFor('facts')();

    const face = await coll('files').findOne({ _id: 'b.jpg#face-chunk0' });
    assert.equal(face.faceEntityId, 'carol', 'a memory wipe must not touch a face label');
  });
});
