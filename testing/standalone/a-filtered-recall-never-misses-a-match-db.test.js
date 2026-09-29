/**
 * A filtered recall fills `topK` from EVERY record that satisfies the filter, whatever its vector rank (Q-102).
 *
 * ## The defect
 *
 * A filter the index cannot apply natively — an undeclared `properties.*` key, `$exists`, `$ne`, most raw
 * grammar — took the exhaustive path: `$vectorSearch exact:true` with `limit = min(10000, max(k*100, 1000))`,
 * THEN `$match`, then `$limit`. So "exhaustive" scored only the nearest window, and a matching record outside
 * it was dropped. Measured on a 40k-record space: 39 of 40 single-record filters on an undeclared property
 * answered `count: 0`, `truncated: false`, while `filter` found the record. Nothing told the caller. The
 * schema description, `help()` and CLAUDE.md all promised the opposite.
 *
 * ## What this pins, and the traps each case avoids
 *
 * - Every index is built by production's `buildSpaceVectorIndexes` (or, for the old-definition case,
 *   production's `ensureVectorSearchIndex` with production's field list minus `_id`), and its LIVE definition
 *   is asserted — a hand-written definition would test a copy.
 * - Records are inserted BEFORE the index is built and an unfiltered exact count is polled to N, so index lag
 *   cannot pose as the defect.
 * - Every record's `updatedAt` is an hour old, outside the fresh-write window, so the collection scan that
 *   finds just-written records cannot supply the target and make a broken index path look correct.
 * - Hybrid (lexical) search is off: it is a second channel with its own eligibility, pinned in
 *   `recall-predicate-merges-by-and-db.test.js`, and here it would only add traffic to classify.
 * - Each "the target comes back" case has a positive control: the unfiltered ranking is the decoys, so a
 *   red is for the stated reason (rank) and not because the target is unreachable some other way.
 * - Which stage answered is observed through MONGO's traffic (the profiler on the harness database), never an
 *   internal probe — see `_vector-harness.mjs`.
 *
 * Run: `npm run test:up` first, then
 *      node --test testing/standalone/a-filtered-recall-never-misses-a-match-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';
import {
  unitAt, queryAxis, cosineScoreAt, startStubEmbedder, createSpaceCollections, insertAll, waitUntilServing,
  liveFilterPaths, recordTraffic, isIdFilteredSearch, isCollectionPass,
} from './_vector-harness.mjs';

const skip = await mongoSkipReason();

const DIMS = 8;
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-predrecall-'));
const CONFIG_PATH = path.join(tmpDir, 'config.json');
process.env['CONFIG_PATH'] = CONFIG_PATH;
process.env['EMBEDDING_DIMENSIONS'] = String(DIMS);
process.env['YTHRIL_HYBRID_SEARCH'] = 'off';

/** An hour ago: outside any fresh-write window, so only the INDEX path can supply these records. */
const OLD = new Date(Date.now() - 3_600_000).toISOString();

/** The five spaces, one question each. */
const FAR = 'far';        // 10500 records; three sparse matches ranked below every decoy
const TIE = 'tie';        // identical vectors, so the window's cut falls inside a tie
const SMALL = 'small';    // fewer records than any window
const CHUNK = 'chunk';    // more matches than one stage-2 id batch, best one in the second batch
const OLDDEF = 'olddef';  // an index built with the definition shipped before `_id` joined it
const SPACES = [FAR, TIE, SMALL, CHUNK, OLDDEF];

let mongo, recallMod, resolveRecallFilter, vectorIndex, stub;
/** From the module the plan names; the fallback is the plan's own figure, and a case asserts the export. */
let ID_CHUNK = null;

const entity = (spaceId, id, deg, properties = {}, extra = {}) => ({
  _id: id, spaceId, name: id, type: 'thing', tags: [], properties,
  description: `record ${id}`, embedding: unitAt(deg, DIMS), embeddingModel: 'stub',
  seq: 0, createdAt: OLD, updatedAt: OLD, ...extra,
});

/** `count` decoys spread evenly over [from, to) degrees, sequenced so every one has a distinct seq. */
const spread = (spaceId, prefix, count, from, to, props = () => ({})) =>
  Array.from({ length: count }, (_, i) => {
    const deg = from + ((to - from) * i) / count;
    return { ...entity(spaceId, `${prefix}-${String(i).padStart(6, '0')}`, deg, props(i)), seq: i + 1, _deg: deg };
  });

/** Every record's angle, kept beside the fixture so expected rankings are computed, never listed. */
const angleOf = new Map();
const stripDeg = (docs) => docs.map(({ _deg, ...d }) => { angleOf.set(d._id, _deg ?? null); return d; });

/** The filtered recall under test, through production's own filter resolution — the doors call the same. */
async function filteredRecall(spaceId, filter, topK, extra = {}) {
  const resolved = resolveRecallFilter(filter);
  assert.ok(resolved.ok, `the filter was refused: ${resolved.error}`);
  const f = resolved.kind === 'mongo' ? resolved.filter : resolved.kind === 'expression' ? resolved.expression : undefined;
  const degraded = [];
  const observePath = recallMod.observeRecallPath();
  const results = await recallMod.recall(spaceId, 'Q', topK, undefined, extra.types ?? ['entity'],
    undefined, undefined, f, { degraded, observePath, ...(extra.maxTimeMS ? { maxTimeMS: extra.maxTimeMS } : {}) });
  return { results, ids: results.map(r => r._id), degraded, path: observePath.path() };
}

/** The expected top-k of `ids`, by angle then id — the engine's order, computed without the engine. */
const expectedTop = (ids, k) => [...ids]
  .sort((a, b) => angleOf.get(a) - angleOf.get(b) || (a < b ? -1 : a > b ? 1 : 0))
  .slice(0, k);

describe('a filtered recall never misses a matching record', { skip }, () => {
  const fixtures = {};

  before(async () => {
    stub = await startStubEmbedder(() => queryAxis(DIMS));
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(
      { spaces: SPACES.map(id => ({ id, label: id })), networks: [], tokens: [] }, null, 2,
    ));
    mongo = await openTestMongo('predrecall');
    const loader = await import('../../server/dist/config/loader.js');
    loader.loadConfig();
    vectorIndex = await import('../../server/dist/spaces/vector-index.js');
    recallMod = await import('../../server/dist/brain/recall.js');
    ({ resolveRecallFilter } = await import('../../server/dist/brain/recall-filter.js'));
    try { ({ ID_CHUNK } = await import('../../server/dist/brain/predicate-recall.js')); } catch { /* asserted below */ }

    // FAR: 10500 records. Decoys from 10° to 70° (every one nearer than the matches); three matches at
    // 86-88°. Half the decoys carry band 'even' so the same space answers the many-matches row too.
    const farDecoys = spread(FAR, 'd', 10497, 10, 70, i => ({ band: i % 2 === 0 ? 'even' : 'odd' }));
    const farMatches = [86, 87, 88].map((deg, i) => ({ ...entity(FAR, `target-${i}`, deg, { marker: 'target' }), seq: 20000 + i, _deg: deg }));
    fixtures.far = stripDeg([...farDecoys, ...farMatches]);

    // TIE: 1600 records at the SAME angle. A window of 1500 then cuts inside a tie by construction.
    fixtures.tie = stripDeg(spread(TIE, 't', 1600, 20, 20, i => ({ band: i % 2 === 0 ? 'even' : 'odd' })));

    // SMALL: 300 records, three far matches — fewer records than any window, so stage 1 has seen them all.
    const smallDecoys = spread(SMALL, 's', 297, 10, 70);
    const smallMatches = [80, 81, 82].map((deg, i) => ({ ...entity(SMALL, `small-target-${i}`, deg, { marker: 't' }), seq: 1000 + i, _deg: deg }));
    fixtures.small = stripDeg([...smallDecoys, ...smallMatches]);

    // CHUNK: 1600 non-matching decoys nearest (15-40°), three matches INSIDE the window (5-7°), then
    // ID_CHUNK + 50 matches far away (50-85°) in insertion and id order, and the best of the far ones (45°)
    // inserted LAST with the highest id — so whichever order the id cursor streams, it lands in batch two.
    const chunkSize = (typeof ID_CHUNK === 'number' ? ID_CHUNK : 20_000) + 50;
    fixtures.chunk = stripDeg([
      ...[5, 6, 7].map((deg, i) => ({ ...entity(CHUNK, `a-near-${i}`, deg, { kind: 'm' }), seq: i + 1, _deg: deg })),
      ...spread(CHUNK, 'b-decoy', 1600, 15, 40, () => ({ kind: 'n' })).map(d => ({ ...d, seq: d.seq + 10 })),
      ...spread(CHUNK, 'c-match', chunkSize, 50, 85, () => ({ kind: 'm' })).map(d => ({ ...d, seq: d.seq + 2000 })),
      { ...entity(CHUNK, 'zz-best', 45, { kind: 'm' }), seq: chunkSize + 5000, _deg: 45 },
    ]);

    // OLDDEF: three matches inside the window, 1600 decoys, one match far outside it.
    fixtures.olddef = stripDeg([
      ...[5, 6, 7].map((deg, i) => ({ ...entity(OLDDEF, `near-${i}`, deg, { marker: 'x' }), seq: i + 1, _deg: deg })),
      ...spread(OLDDEF, 'o', 1600, 10, 30).map(d => ({ ...d, seq: d.seq + 10 })),
      { ...entity(OLDDEF, 'far-target', 88, { marker: 'x' }), seq: 9000, _deg: 88 },
    ]);

    // Insert BEFORE any index exists, then build.
    for (const id of SPACES) await createSpaceCollections(mongo, id);
    for (const [id, docs] of Object.entries(fixtures)) await insertAll(mongo, `${id}_entities`, docs);

    // Production's builder for the four current-definition spaces, concurrently: they are independent.
    await Promise.all([FAR, TIE, SMALL, CHUNK].map(id => vectorIndex.buildSpaceVectorIndexes(id, true)));
    // OLDDEF: production's ensure, with production's field list minus `_id` — the definition an instance
    // upgraded from the previous image is still serving. Derived, so it tracks the real list either way.
    const oldFields = vectorIndex.vectorFilterFieldsFor(OLDDEF, 'entities').filter(f => f !== '_id');
    await vectorIndex.ensureVectorSearchIndex(OLDDEF, 'entities', DIMS, 'cosine', 'embedding', 'embedding', true, oldFields);

    for (const [id, docs] of Object.entries(fixtures)) {
      await waitUntilServing(mongo, `${id}_entities`, `${id}_entities_embedding`, { dims: DIMS, n: docs.length });
    }
    await mongo.checkVectorSearchAvailability();
  });

  after(async () => {
    await closeTestMongo();
    await stub?.close();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it('the vector index production builds declares _id as a filter field', async () => {
    // Stage 2 scores a candidate id set through the index; an index that cannot filter on `_id` refuses it.
    for (const id of [FAR, TIE, SMALL, CHUNK]) {
      const paths = await liveFilterPaths(mongo, `${id}_entities`, `${id}_entities_embedding`);
      assert.ok(paths.includes('_id'),
        `${id}_entities_embedding declares [${paths.join(', ')}] — no _id, so the id-restricted search that `
        + 'completes a filtered recall has nothing to filter on');
    }
  });

  it('positive control: unfiltered, the nearest records are the decoys and none of the targets', async () => {
    // Without this, "the target is missing" could mean the target is unreachable for some reason other than
    // its rank, and every red below would be for the wrong reason.
    const results = await recallMod.recall(FAR, 'Q', 10, undefined, ['entity']);
    assert.ok(results.length > 0, 'the unfiltered recall returned nothing — the index is not serving');
    for (const r of results) {
      assert.ok(r._id.startsWith('d-'), `${r._id} is not a decoy — the fixture does not rank the way it says`);
      assert.ok(r.score > cosineScoreAt(80), `${r._id} scored ${r.score}, not nearer than the targets`);
    }
  });

  describe('the truth table', () => {
    it('sparse matches behind a full window: stage 2 finds all three far targets', async () => {
      const { ids, path: p } = await filteredRecall(FAR, { 'properties.marker': 'target' }, 10);
      assert.deepEqual(ids, ['target-0', 'target-1', 'target-2'],
        `got [${ids.join(', ')}]: the three records that satisfy the filter rank below 10497 decoys, and a `
        + 'recall that scores only the nearest window and filters after drops every one of them — count 0, '
        + 'truncated false, nothing telling the caller');
      assert.equal(p, 'exhaustive', 'an undeclared property cannot be applied by the index');
      const { degraded } = await filteredRecall(FAR, { 'properties.marker': 'target' }, 10);
      assert.ok(!degraded.includes('filter_window'),
        `degraded [${degraded.join(', ')}] on a complete answer: the index holds every matching record`);
    });

    it('10500 records, topK 100: the 10000-record ceiling on the window is not a ceiling on the answer', async () => {
      const { ids } = await filteredRecall(FAR, { 'properties.marker': 'target' }, 100);
      assert.deepEqual(ids, ['target-0', 'target-1', 'target-2'],
        `got [${ids.join(', ')}]: at topK 100 the window is capped at 10000, and the targets rank 10498-10500`);
    });

    it('many matches: stage 1 answers exactly, with no pass over the collection', async () => {
      const { result, ops } = await recordTraffic(mongo, `${FAR}_entities`,
        () => filteredRecall(FAR, { 'properties.band': 'even' }, 10));
      const even = fixtures.far.filter(d => d.properties.band === 'even').map(d => d._id);
      assert.deepEqual(result.ids, expectedTop(even, 10), 'the ten nearest even decoys, in order');
      const passes = ops.filter(o => isCollectionPass(o, 'properties.band') || isIdFilteredSearch(o));
      assert.deepEqual(passes.map(o => o.text.slice(0, 200)), [],
        'the window held more than topK matches, all strictly above its cut — stage 1 was exact, and a '
        + 'collection pass here is a cost every well-served filtered recall would pay');
    });

    it('few matches in a collection smaller than the window: exact, with no pass', async () => {
      const { result, ops } = await recordTraffic(mongo, `${SMALL}_entities`,
        () => filteredRecall(SMALL, { 'properties.marker': 't' }, 10));
      assert.deepEqual(result.ids, ['small-target-0', 'small-target-1', 'small-target-2']);
      const passes = ops.filter(o => isCollectionPass(o, 'properties.marker') || isIdFilteredSearch(o));
      assert.deepEqual(passes.map(o => o.text.slice(0, 200)), [],
        'the window came back shorter than asked for, so the index was exhausted and stage 1 had seen every '
        + 'record — a second pass proves nothing and costs a collection scan');
    });

    it('a tie across the window cut: stage 2 runs', async () => {
      // Every record scores the same, so records outside the window are as good as the last one inside it.
      // Accepting stage 1 here would let the window's arbitrary cut decide the answer.
      const { result, ops } = await recordTraffic(mongo, `${TIE}_entities`,
        () => filteredRecall(TIE, { 'properties.band': 'even' }, 10));
      assert.equal(result.ids.length, 10);
      for (const id of result.ids) {
        assert.equal(fixtures.tie.find(d => d._id === id)?.properties.band, 'even', `${id} does not match`);
      }
      assert.ok(ops.some(o => isCollectionPass(o, 'properties.band') || isIdFilteredSearch(o)),
        'the topK-th hit ties the window\'s last score, so stage 1 cannot know nothing equal lies beyond the '
        + `cut — it must go to stage 2. Mongo saw ${ops.length} operation(s) and none of them was stage 2.`);
    });

    it('matches spanning two id batches: the best one, in the second batch, is returned first', async () => {
      const { ids } = await filteredRecall(CHUNK, { 'properties.kind': 'm' }, 10);
      const matching = fixtures.chunk.filter(d => d.properties.kind === 'm').map(d => d._id);
      const want = expectedTop(matching, 10);
      assert.equal(want[3], 'zz-best', 'fixture check: the best far match ranks right after the three near ones');
      assert.deepEqual(ids, want,
        `got [${ids.join(', ')}]: the running top-K must merge across batches — a pass that stops after the `
        + 'first batch, or keeps only one batch\'s answer, loses zz-best');
      assert.equal(typeof ID_CHUNK, 'number',
        'brain/predicate-recall.js must export ID_CHUNK: this fixture sizes itself from it, and a fallback to '
        + 'the plan\'s figure is a second copy of that number');
    });
  });

  describe('when the answer cannot be completed, it says so (filter_window)', () => {
    it('an index still on the old definition refuses the _id filter: filter_window, and the stage-1 hits kept', async () => {
      const paths = await liveFilterPaths(mongo, `${OLDDEF}_entities`, `${OLDDEF}_entities_embedding`);
      assert.ok(!paths.includes('_id'), 'fixture check: this index must be the old definition, without _id');
      const { ids, degraded } = await filteredRecall(OLDDEF, { 'properties.marker': 'x' }, 10);
      assert.ok(['near-0', 'near-1', 'near-2'].every(id => ids.includes(id)),
        `got [${ids.join(', ')}], degraded [${degraded.join(', ')}]: what stage 1 found must survive stage 2 failing — never an empty answer`);
      assert.ok(degraded.includes('filter_window'),
        `degraded is [${degraded.join(', ')}]: far-target satisfies the filter and was not returned, and the `
        + 'caller must be told the answer may be missing matching records');
    });

    it('an index that does not hold a matching record the collection has: filter_window', async () => {
      // The silent miss seen during an in-place index update (Q-142): the index accepted the `_id` filter and
      // answered for fewer records than the collection holds. A vector of the wrong dimension is one the index
      // never holds, which makes the same state deterministic. Older than the fresh-write window, so it is not a
      // record the index merely has not ingested yet.
      await mongo.col(`${FAR}_entities`).insertOne(
        { ...entity(FAR, 'unindexed', 5, { marker: 'unindexed' }), embedding: unitAt(5, DIMS * 2), seq: 30000 });
      try {
        const { ids, degraded } = await filteredRecall(FAR, { 'properties.marker': 'unindexed' }, 10);
        assert.deepEqual(ids, []);
        assert.ok(degraded.includes('filter_window'),
          `degraded [${degraded.join(', ')}]: a record satisfies the filter and the index could not score it, `
          + 'so the answer may be missing matching records and must say so');
      } finally {
        await mongo.col(`${FAR}_entities`).deleteOne({ _id: 'unindexed' });
      }
    });

    it('a record inside the fresh-write window the index has not ingested yet: no filter_window', async () => {
      // The same short batch, for a record written moments ago: the index is behind by design, and flagging it
      // would put filter_window on every filtered recall in a busy space.
      const now = new Date().toISOString();
      await mongo.col(`${FAR}_entities`).insertOne({ ...entity(FAR, 'just-written', 5, { marker: 'just-written' }),
        embedding: unitAt(5, DIMS * 2), seq: 30001, createdAt: now, updatedAt: now });
      try {
        const { degraded } = await filteredRecall(FAR, { 'properties.marker': 'just-written' }, 10);
        assert.ok(!degraded.includes('filter_window'),
          `degraded [${degraded.join(', ')}]: a record inside the fresh-write window is not evidence of a lagging index`);
      } finally {
        await mongo.col(`${FAR}_entities`).deleteOne({ _id: 'just-written' });
      }
    });

    it('a stage-2 deadline keeps the stage-1 hits and says search_timeout', async () => {
      // Stage 2 ALONE is made to run out (Q-142). This squeezed the whole recall to 250 ms instead, and on a loaded
      // machine stage 1 itself ran out, so the case read "stage 1 never finished" as "stage 1's hits were dropped".
      // With stage 1 given its normal budget and stage 2 an expired one, the promise is tested and nothing else.
      const { overrideStageTwoDeadlineForTest } = await import('../../server/dist/brain/predicate-recall.js');
      overrideStageTwoDeadlineForTest(1);
      let result;
      try {
        result = await filteredRecall(CHUNK, { 'properties.kind': 'm' }, 10);
      } finally {
        overrideStageTwoDeadlineForTest(null);
      }
      const { ids, degraded } = result;
      assert.ok(degraded.includes('search_timeout'),
        `stage 2 ran out and the answer does not say so: degraded [${degraded.join(', ')}]`);
      assert.ok(['a-near-0', 'a-near-1', 'a-near-2'].every(id => ids.includes(id)),
        `a timed-out stage 2 must keep what stage 1 found, never empty the type: got [${ids.slice(0, 5).join(', ')}], degraded [${degraded.join(', ')}]`);
    });

    it('NOT raised on a healthy filtered recall across all five types, four of them empty', async () => {
      const { ids, degraded } = await filteredRecall(SMALL, { 'properties.marker': 't' }, 10,
        { types: ['fact', 'entity', 'edge', 'chrono', 'file'] });
      assert.deepEqual(ids, ['small-target-0', 'small-target-1', 'small-target-2']);
      assert.ok(!degraded.includes('filter_window'),
        'an empty collection is an answer, not an incomplete one — filter_window on a healthy recall teaches '
        + 'every caller to ignore it');
    });

    it('a real in-place update to the new definition: disclosed while pending, complete once it serves', async () => {
      // Production's builder against the OLD definition issues the in-place update. The old definition keeps
      // serving meanwhile, so the recall right after must be complete or say filter_window.
      await vectorIndex.buildSpaceVectorIndexes(OLDDEF, false);
      const during = await filteredRecall(OLDDEF, { 'properties.marker': 'x' }, 10);
      assert.ok(during.ids.includes('far-target') || during.degraded.includes('filter_window'),
        `during the update: [${during.ids.join(', ')}], degraded [${during.degraded.join(', ')}]`);
      assert.ok(['near-0', 'near-1', 'near-2'].every(id => during.ids.includes(id)), `and never emptier than stage 1: degraded [${during.degraded.join(', ')}]`);

      const deadline = Date.now() + 120_000;
      let paths = [];
      while (Date.now() < deadline) {
        paths = await liveFilterPaths(mongo, `${OLDDEF}_entities`, `${OLDDEF}_entities_embedding`);
        if (paths.includes('_id')) {
          try {
            // The record must come BACK, not merely the query run: CI saw the new definition accept the `_id` filter
            // while it still held none of the records, so a probe that only did not throw ended the wait too early.
            const probe = await mongo.col(`${OLDDEF}_entities`).aggregate([{ $vectorSearch: {
              index: `${OLDDEF}_entities_embedding`, path: 'embedding', queryVector: queryAxis(DIMS),
              exact: true, limit: 1, filter: { _id: { $in: ['far-target'] } } } }]).toArray();
            if (probe.some(d => d._id === 'far-target')) break;
          } catch { /* the new definition is not serving yet */ }
        }
        await new Promise(r => setTimeout(r, 1000));
      }
      assert.ok(paths.includes('_id'),
        `production's builder left ${OLDDEF}_entities_embedding at [${paths.join(', ')}] — the in-place update `
        + 'to a definition with _id never happened');
      const settled = await filteredRecall(OLDDEF, { 'properties.marker': 'x' }, 10);
      assert.ok(settled.ids.includes('far-target'),
        `once the _id filter serves the answer must be complete: [${settled.ids.join(', ')}], degraded [${settled.degraded.join(', ')}]`);
      assert.ok(!settled.degraded.includes('filter_window'),
        'a refusal verdict cached past the index\'s recovery would disclose a gap that no longer exists');
    });
  });
});
