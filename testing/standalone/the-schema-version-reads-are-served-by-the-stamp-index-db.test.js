/**
 * The schema-version reads are served by the (stamp, type) index, the old single-key stamp index is retired by the index step with no
 * read left unserved in between, and a collection with neither index answers `503 schema_index_building` (bundle-267, design r3 §1,
 * final changes 1/2/5/6; probe 2 E1-E3; vet T1, R1, R3).
 *
 * ## The contract (written before the code)
 *
 * - Each stamped collection carries `schemaFingerprint_type_present`: `{ schemaFingerprint: 1, <type | label>: 1 }`, partial on
 *   `STAMP_PRESENT`; its SpaceIndex entry `replaces: ['schemaFingerprint_present']`, dropped by the index step (ensureTtlIndexes,
 *   ensureQueryIndexes) only after the new one is listed.
 * - `fingerprintTypesIn(spaceId, collection, { maxTimeMS })` (`spaces/schema-snapshot-carried.js`): one covered `$group` by
 *   (stamp, type field), answering `[{ fp, type, count }]`, fingerprint-shaped stamps and string-or-null types only.
 * - Every stamp reader hints the stamp index the collection lists (the new one when present, the old one otherwise); with neither it
 *   throws an error with `status: 503, code: 'schema_index_building'`, and the doors answer it so.
 *
 * ## What is held
 *
 * 1. The group is covered: PROJECTION_COVERED or an IXSCAN on the new index, no FETCH, no COLLSCAN, 0 documents examined; its counts
 *    are the records' own, and junk stamps are left out; a non-string type is answered `unnamed` (type null), never dropped (lens sweep F3).
 * 2. `fingerprintsCarriedIn` (gap scan, sweep, fetch) is covered too: today it holds `$exists` and FETCHes every stamped record.
 * 3. `older` as the filter tool runs it (the caller's `$and`, the default landing order) is index-served: no COLLSCAN.
 * 4. The retire: an existing collection with only the old index reads through it; the index step builds the new one and drops the
 *    old; with both listed the reader hints the new one; reads answer in every state.
 * 5. Neither index: `fingerprintsCarriedIn` throws 503 `schema_index_building`, and the filter tool answers it, not a raw hint error.
 *
 * ## Seen red at b299cde3
 *
 * 1 `fingerprintTypesIn` missing (new code); 2 the read FETCHes (behaviour); 3 `schemaVersion` is not a filter argument (new code);
 * 4 the index step leaves the old index and builds no compound (behaviour); 5 the hint fails with Mongo's own error (behaviour).
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openToolDoor } from './_tool-door.mjs';
import { recordOf, saveVersion, explainOf, readsDuring, typeFieldOf } from './_schema-version-fixtures.mjs';

const skip = await mongoSkipReason();

const SPACE = 'svindex';
const RETIRE = 'svretire';
const NEW = 'schemaFingerprint_type_present';
const OLD = 'schemaFingerprint_present';
const NOT_HELD = 'e'.repeat(64);
const META = { suppressEmbeddings: true };

let door, carried, db, client;
let V1, V2;
const want = new Map();   // `${fp}|${type}` -> count, for the entities of SPACE

const typeMeta = (prop) => ({ ...META, typeSchemas: {
  entity: { A: { propertySchemas: { [prop]: { type: 'string' } } }, B: { propertySchemas: { x: { type: 'number' } } } },
  edge: { knows: {}, likes: {} },
} });

describe('the schema-version reads are served by the (stamp, type) index (real MongoDB)', { skip }, () => {
  before(async () => {
    door = await openToolDoor({ suite: 'svindex', monitorCommands: true, spaces: [SPACE, RETIRE].map(id => ({ id, label: id, folders: [], meta: META })) });
    db = door.mongo.getDb();
    client = door.mongo.getMongo();
    carried = await import('../../server/dist/spaces/schema-snapshot-carried.js');
    V1 = await saveVersion(SPACE, typeMeta('p'));
    V2 = await saveVersion(SPACE, typeMeta('q'));
    const ents = [], edges = [];
    let i = 0;
    for (const [fp, type, n] of [[V1.fp, 'A', 40], [V1.fp, 'B', 30], [V2.fp, 'A', 50], [V2.fp, null, 5], [NOT_HELD, 'B', 7], [null, 'A', 120]]) {
      for (let k = 0; k < n; k++) ents.push(recordOf('entities', SPACE, ++i, { type, fp, tags: k % 10 === 0 ? ['x'] : ['y'] }));
      if (fp) want.set(`${fp}|${type}`, (want.get(`${fp}|${type}`) ?? 0) + n);
    }
    // What the group must leave out: a stamp that is no fingerprint. A type that is no string is kept, marked `unnamed`, so its stamp is
    // still counted and the filter answers it unclassified.
    ents.push(recordOf('entities', SPACE, ++i, { type: 'A', fp: 'not-a-fingerprint' }));
    ents.push(recordOf('entities', SPACE, ++i, { type: 42, fp: V1.fp }));
    want.set(`${V1.fp}|unnamed`, 1);
    for (const [fp, label, n] of [[V1.fp, 'knows', 20], [V2.fp, 'likes', 20]]) {
      for (let k = 0; k < n; k++) edges.push(recordOf('edges', SPACE, ++i, { type: label, fp }));
    }
    await door.coll(SPACE, 'entities').insertMany(ents);
    await door.coll(SPACE, 'edges').insertMany(edges);
    const { ensureTtlIndexes } = await import('../../server/dist/spaces/space-indexes.js');
    assert.deepEqual((await ensureTtlIndexes(SPACE)).failed, [], 'the sweep indexes did not build');
  });
  after(async () => { await door?.close(); });

  it('fingerprintTypesIn answers every (stamp, type) pair with its count from the index alone', async () => {
    assert.equal(typeof carried.fingerprintTypesIn, 'function', 'spaces/schema-snapshot-carried.js exports no fingerprintTypesIn');
    const { result, sent } = await readsDuring(client, `${SPACE}_entities`, () => carried.fingerprintTypesIn(SPACE, 'entities', { maxTimeMS: 10_000 }));
    const got = new Map(result.map(r => [`${r.fp}|${r.unnamed ? 'unnamed' : r.type}`, r.count]));
    assert.deepEqual(new Map([...got].sort()), new Map([...want].sort()), 'the pairs or their counts are not the records\'');
    assert.equal(sent.length, 1, `one command per call: ${sent.map(s => s.name).join(', ')}`);
    assert.ok(sent[0].command.maxTimeMS > 0, 'the group runs with no maxTimeMS');
    await assertCovered(sent[0], NEW);
    const edges = await carried.fingerprintTypesIn(SPACE, 'edges', { maxTimeMS: 10_000 });
    assert.deepEqual(edges.map(r => `${r.fp === V1.fp ? 'v1' : 'v2'}|${r.type}|${r.count}`).sort(), ['v1|knows|20', 'v2|likes|20'], 'an edge is typed by its label');
  });

  it('fingerprintsCarriedIn, in both forms, is answered from the index without reading a record', async () => {
    for (const among of [undefined, [V1.fp, NOT_HELD]]) {
      const { sent } = await readsDuring(client, `${SPACE}_entities`, () => carried.fingerprintsCarriedIn(SPACE, 'entities', among));
      assert.equal(sent.length, 1);
      await assertCovered(sent[0], NEW);
    }
  });

  it('older, as the filter tool reads it under a caller filter and the landing order, is index-served', async () => {
    const { result, sent } = await readsDuring(client, `${SPACE}_entities`,
      () => door.call('filter', { space: SPACE, collection: 'entities', schemaVersion: 'older', filter: { tags: 'x' }, limit: 10 }));
    assert.ok(!result.result.isError, `the filter refused older: ${result.text.slice(0, 300)}`);
    const finds = sent.filter(s => s.name === 'find' || s.name === 'aggregate');
    assert.ok(finds.length > 0, 'no read of the records was sent');
    for (const s of finds) {
      const plan = await explainOf(db, s);
      assert.ok(!plan.stages.includes('COLLSCAN'), `older is planned as a collection scan: ${plan.stages.join(' ')}`);
      assert.ok(plan.indexes.length > 0, `older reads no index: ${plan.stages.join(' ')}`);
    }
  });

  describe('the retire of the single-key stamp index', () => {
    const parts = ['entities', 'edges'];
    const indexesOf = async (part) => Object.fromEntries((await door.coll(RETIRE, part).listIndexes().toArray()).map(ix => [ix.name, ix.key]));

    before(async () => {
      // A collection as 6.6.0 left it: the single-key partial stamp index and no compound.
      for (const part of parts) {
        const c = door.coll(RETIRE, part);
        await c.dropIndexes();
        await c.createIndex({ schemaFingerprint: 1 }, { name: OLD, partialFilterExpression: { schemaFingerprint: { $exists: true } } });
        const docs = Array.from({ length: 30 }, (_, k) => recordOf(part, RETIRE, k + 1, { type: part === 'edges' ? 'knows' : 'A', fp: k % 2 ? V1.fp : V2.fp }));
        await c.insertMany(docs);
      }
    });

    it('reads through the old index while it is the only one', async () => {
      const { result, sent } = await readsDuring(client, `${RETIRE}_entities`, () => carried.fingerprintsCarriedIn(RETIRE, 'entities'));
      assert.deepEqual([...result].sort(), [V1.fp, V2.fp].sort());
      const plan = await explainOf(db, sent[0]);
      assert.ok(plan.indexes.includes(OLD) && !plan.stages.includes('COLLSCAN'), `${plan.indexes} ${plan.stages}`);
    });

    it('the index step builds the compound, keyed by the collection\'s type field, and drops the old one', async () => {
      const { ensureTtlIndexes } = await import('../../server/dist/spaces/space-indexes.js');
      assert.deepEqual((await ensureTtlIndexes(RETIRE)).failed, []);
      for (const part of parts) {
        const ix = await indexesOf(part);
        assert.deepEqual(ix[NEW], { schemaFingerprint: 1, [typeFieldOf(part)]: 1 }, `${part}: no ${NEW} keyed by the stamp and ${typeFieldOf(part)}: ${JSON.stringify(ix)}`);
        assert.equal(ix[OLD], undefined, `${part}: the step left ${OLD} beside the compound`);
      }
      const { result, sent } = await readsDuring(client, `${RETIRE}_entities`, () => carried.fingerprintsCarriedIn(RETIRE, 'entities'));
      assert.deepEqual([...result].sort(), [V1.fp, V2.fp].sort());
      await assertCovered(sent[0], NEW);
    });

    it('with both listed, the reader hints the compound', async () => {
      await door.coll(RETIRE, 'entities').createIndex({ schemaFingerprint: 1 }, { name: OLD, partialFilterExpression: { schemaFingerprint: { $exists: true } } });
      const { sent } = await readsDuring(client, `${RETIRE}_entities`, () => carried.fingerprintsCarriedIn(RETIRE, 'entities'));
      assert.equal(sent[0].command.hint, NEW, `the reader hinted ${JSON.stringify(sent[0].command.hint)} while the compound is listed`);
    });

    it('with neither, the reader fails closed as 503 schema_index_building, and the filter tool answers it so', async () => {
      await door.coll(RETIRE, 'entities').dropIndexes();
      const err = await carried.fingerprintsCarriedIn(RETIRE, 'entities').then(() => null, e => e);
      assert.ok(err, 'a collection with no stamp index was read anyway');
      assert.equal(err.status, 503, `the failure is not a 503: ${err.message}`);
      assert.equal(err.code, 'schema_index_building', `the failure is not worded for a caller: ${err.code} ${err.message}`);
      assert.match(err.message, /being built/);
      const viaTool = await door.call('filter', { space: RETIRE, collection: 'entities', schemaVersion: 'older' });
      assert.equal(viaTool.status, 503, `the filter tool answered ${viaTool.status}: ${viaTool.text.slice(0, 300)}`);
      assert.match(viaTool.text, /schema_index_building/);
    });
  });
});

/** The read is answered from the named index alone: no FETCH, no collection scan, no document examined. */
async function assertCovered(sent, index) {
  const plan = await explainOf(db, sent);
  const shown = JSON.stringify(sent.command.pipeline ?? sent.command.query ?? sent.command.filter);
  assert.ok(plan.indexes.includes(index), `${sent.name} ${shown} does not read ${index}: ${JSON.stringify(plan.indexes)}`);
  assert.ok(!plan.stages.includes('COLLSCAN') && !plan.stages.includes('FETCH'), `${sent.name} ${shown} reads the records: ${plan.stages.join(' > ')}`);
  assert.ok(plan.stages.includes('PROJECTION_COVERED') || plan.stages.includes('DISTINCT_SCAN') || plan.stages.includes('IXSCAN'), plan.stages.join(' > '));
  assert.equal(plan.docsExamined, 0, `${sent.name} ${shown} examined ${plan.docsExamined} documents`);
}
