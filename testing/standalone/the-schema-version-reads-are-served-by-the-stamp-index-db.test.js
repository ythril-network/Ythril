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
/** Q-744: a collection whose stamp index is multikey (one stamped record has an array type), and one with 600 versions. */
const MULTI = 'svmulti';
const SEED = 'svseed600';
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
    door = await openToolDoor({ suite: 'svindex', monitorCommands: true, spaces: [SPACE, RETIRE, MULTI, SEED].map(id => ({ id, label: id, folders: [], meta: META })) });
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

  /**
   * The Q-744 reads (bundle-268 design r4 §1, §4, amend "one rule", §10 T5). Every one hints the stamp index, takes `timeLeft` (a function
   * answering the milliseconds left) and throws on failure; none walks the records:
   * - R2 `unnamedFingerprintsIn(space, coll, among, timeLeft)`: on a non-multikey stamp index a covered read (IXSCAN, 0 records);
   * - R3 `typeOnAnyOf(space, coll, T, fps, timeLeft)`: at most |fps| + 1 keys, stopping at the first hit;
   * - R4 `fingerprintsOfType(space, coll, T, timeLeft)`: non-multikey, one covered `distinct`; multikey, the guarded loose scan, one
   *   command per stamp T carries plus one, each examining at most the hit and the keys of an array record;
   * - R5 `recordTypeNamesIn(space, coll, timeLeft)`: DISTINCT_SCAN on `type_1`, or on `label_1` for edges.
   * Counted work, never time, through `standingWork()` (spaces/type-standing.js: `{ textsRead, textsParsed, diffs }`, totals since the
   * process started): a cold `kind` read over 600 versions parses the misses plus the anchor once, a warm one diffs nothing and reads no
   * text, four concurrent cold reads make one pass, and no `kind` read sends the `(stamp, type)` `$group` (`fingerprintTypesIn`).
   * Seen red at 327b105e: none of the readers, nor `standingWork`, nor the `kind` form exists.
   */
  describe('the Q-744 reads are index seeks, and their work is counted', () => {
    const tl = () => 10_000;
    let mod, multiV, seedCount;
    before(async () => {
      const { need } = await import('./_type-history.mjs');
      mod = await need('spaces/schema-snapshot-carried.js', ['unnamedFingerprintsIn', 'typeOnAnyOf', 'fingerprintsOfType', 'recordTypeNamesIn']);
    });

    it('R2 on a non-multikey stamp index is covered and answers the unnamed stamp alone', async () => {
      const { result, sent } = await readsDuring(client, `${SPACE}_entities`, () => mod.unnamedFingerprintsIn(SPACE, 'entities', [V1.fp, V2.fp, NOT_HELD], tl));
      assert.deepEqual([...result], [V1.fp], 'R2 is not the stamp of the record typed 42');
      assert.equal(sent.length, 1);
      await assertCovered(sent[0], NEW);
    });

    it('R3 stops at the first hit: at most |fps| + 1 keys, and answers whether T carries any of them', async () => {
      const { result, sent } = await readsDuring(client, `${SPACE}_entities`, () => mod.typeOnAnyOf(SPACE, 'entities', 'A', [NOT_HELD, V2.fp, V1.fp], tl));
      assert.equal(result, true);
      assert.equal(sent.length, 1);
      const plan = await explainOf(db, sent[0]);
      assert.ok(plan.indexes.includes(NEW), `R3 does not read ${NEW}: ${plan.indexes}`);
      assert.ok(plan.keysExamined <= 4, `R3 examined ${plan.keysExamined} keys for 3 stamps`);
      assert.equal(await mod.typeOnAnyOf(SPACE, 'entities', 'B', [V2.fp], tl), false, 'B, never at V2, is found there');
    });

    it('R4 on a non-multikey index is one covered distinct answering exactly the stamps T carries', async () => {
      const { result, sent } = await readsDuring(client, `${SPACE}_entities`, () => mod.fingerprintsOfType(SPACE, 'entities', 'A', tl));
      assert.deepEqual([...result].sort(), [V1.fp, V2.fp].sort(), 'R4 is not the stamps of A\'s stamped records');
      assert.equal(sent.length, 1, `R4 sent ${sent.length} commands on a non-multikey index`);
      // One covered grouping read (`distinctStringsOf`), not the driver's `distinct`: a one-reply distinct is refused under server/src by
      // `no-source-reads-distinct-values-in-one-reply`, which keeps no exemption list (bundle-268 build).
      assert.equal(sent[0].name, 'aggregate');
      await assertCovered(sent[0], NEW);
    });

    it('R5 is a DISTINCT_SCAN on type_1, and on label_1 for edges', async () => {
      try { await (await import('../../server/dist/spaces/ensure-query-indexes.js')).ensureQueryIndexes(); } catch { /* the plan below says what is missing */ }
      for (const [part, index, want] of [['entities', 'type_1', ['A', 'B']], ['edges', 'label_1', ['knows', 'likes']]]) {
        const { result, sent } = await readsDuring(client, `${SPACE}_${part}`, () => mod.recordTypeNamesIn(SPACE, part, tl));
        assert.deepEqual([...result].sort(), want, `${part}: the record type names are not the string names`);
        const plan = await explainOf(db, sent[0]);
        assert.ok(plan.indexes.includes(index) && plan.stages.includes('DISTINCT_SCAN'), `${part}: ${plan.indexes} ${plan.stages}`);
      }
    });

    describe('a multikey stamp index', () => {
      before(async () => {
        multiV = [];
        const docs = [];
        let i = 0;
        for (let k = 0; k < 30; k++) {
          const fp = k.toString(16).padStart(64, 'a');
          multiV.push(fp);
          docs.push(recordOf('entities', MULTI, ++i, { type: 'A', fp }), recordOf('entities', MULTI, ++i, { type: 'B', fp }));
        }
        docs.push(recordOf('entities', MULTI, ++i, { type: ['A', 'X'], fp: multiV[3] }));
        await door.coll(MULTI, 'entities').insertMany(docs);
        const { ensureTtlIndexes } = await import('../../server/dist/spaces/space-indexes.js');
        assert.deepEqual((await ensureTtlIndexes(MULTI)).failed, []);
      });

      it('R2 equals the brute force; R4 is a loose scan of one bounded step per stamp, fetching at most the hit and an array record', async () => {
        assert.deepEqual([...await mod.unnamedFingerprintsIn(MULTI, 'entities', multiV, tl)], [multiV[3]], 'R2 misses the array-typed record\'s stamp');
        const { result, sent } = await readsDuring(client, `${MULTI}_entities`, () => mod.fingerprintsOfType(MULTI, 'entities', 'A', tl));
        assert.deepEqual([...result].sort(), [...multiV].sort());
        assert.ok(sent.length <= multiV.length + 1, `R4 sent ${sent.length} commands for ${multiV.length} stamps`);
        for (const s of sent) {
          const plan = await explainOf(db, s);
          assert.ok(!plan.stages.includes('COLLSCAN'), plan.stages.join(' > '));
          assert.ok(plan.keysExamined <= 4 && plan.docsExamined <= 2, `one step examined ${plan.keysExamined} keys and ${plan.docsExamined} records`);
        }
      });
    });

    describe('the counted work over 600 versions', () => {
      before(async () => {
        const { canonicalJson } = await import('../../server/dist/util/canonical-json.js');
        const { createHash } = await import('node:crypto');
        const rows = [], docs = [];
        for (let k = 0; k < 600; k++) {
          const text = canonicalJson({ format: 1, typeSchemas: { entity: { A: { propertySchemas: { [`p${k}`]: { type: 'string' } } } } }, rules: {} });
          const fp = createHash('sha256').update(text, 'utf8').digest('hex');
          rows.push({ _id: fp, text, origin: 'fetched', from: 'a-peer', links: { own: fp, layers: [], served: [] }, at: new Date(Date.UTC(2026, 0, 1) + k * 60_000).toISOString() });
          docs.push(recordOf('entities', SEED, k + 1, { type: 'A', fp }));
        }
        await door.mongo.col(`${SEED}_schema_snapshots`).insertMany(rows);
        await door.coll(SEED, 'entities').insertMany(docs);
        seedCount = rows.length;
        await saveVersion(SEED, { ...META, typeSchemas: { entity: { A: { propertySchemas: { now: { type: 'string' } } } } } });
        const { ensureTtlIndexes } = await import('../../server/dist/spaces/space-indexes.js');
        assert.deepEqual((await ensureTtlIndexes(SEED)).failed, []);
      });

      it('cold: the misses plus the anchor are parsed once, and no (stamp, type) group is sent; warm: no diff, no text', async () => {
        const { need } = await import('./_type-history.mjs');
        const { standingWork } = await need('spaces/type-standing.js', ['standingWork']);
        const kindRead = () => door.call('space_schema_versions', { space: SEED, kind: 'entity' });
        const before0 = { ...standingWork() };
        const { result, sent } = await readsDuring(client, `${SEED}_entities`, kindRead);
        assert.ok(!result.result.isError, result.text.slice(0, 300));
        const cold = standingWork();
        assert.equal(cold.textsParsed - before0.textsParsed, seedCount + 1, 'a cold pass did not parse each miss and the anchor exactly once');
        assert.equal(cold.diffs - before0.diffs, seedCount, 'a cold pass did not diff each miss once');
        const groups = sent.filter(s => s.name === 'aggregate' && JSON.stringify(s.command.pipeline).includes('$group') && JSON.stringify(s.command.pipeline).includes('"t"'));
        assert.deepEqual(groups.map(g => g.command.pipeline), [], 'the kind read sent the (stamp, type) group of fingerprintTypesIn');
        const warmBefore = { ...standingWork() };
        const again = await kindRead();
        assert.ok(!again.result.isError);
        const warm = standingWork();
        assert.deepEqual({ diffs: warm.diffs - warmBefore.diffs, textsRead: warm.textsRead - warmBefore.textsRead }, { diffs: 0, textsRead: 0 }, 'a warm pass diffed or read a text');
      });

      it('four concurrent cold reads for one key make one pass', async () => {
        const { standingWork } = await import('../../server/dist/spaces/type-standing.js');
        await saveVersion(SEED, { ...META, typeSchemas: { entity: { A: { propertySchemas: { later: { type: 'string' } } } } } });
        const b = { ...standingWork() };
        const answers = await Promise.all(Array.from({ length: 4 }, () => door.call('space_schema_versions', { space: SEED, kind: 'entity' })));
        assert.ok(answers.every(a => !a.result.isError), answers.map(a => a.text.slice(0, 120)).join(' | '));
        const w = standingWork();
        // One pass against the new current diffs each carried version once: the seedCount seeds. The version current before this save is
        // carried by no record, so it is no miss (a pass parses the misses plus the anchor: seedCount + 1 parses, seedCount diffs, as the
        // cold case above holds). Four passes would make 4 x seedCount.
        assert.equal(w.diffs - b.diffs, seedCount, `four concurrent reads made ${w.diffs - b.diffs} diffs, not one pass's ${seedCount}`);
        assert.equal(w.textsParsed - b.textsParsed, seedCount + 1, `four concurrent reads parsed ${w.textsParsed - b.textsParsed} texts, not one pass's ${seedCount + 1}`);
      });
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
