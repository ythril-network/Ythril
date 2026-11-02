/**
 * A recall over a collection whose vector index cannot answer says so, instead of reading the refusal as an empty collection
 * or failing every space (Q-326, bundle-72).
 *
 * ## The defect
 *
 * mongot refuses a `$vectorSearch` in three ways, told apart only by message (PROBE M1): the index is absent (no error, no
 * hits), it exists and is not serving YET (`Index <name> not initialized`, `... while in state NOT_STARTED|INITIAL_SYNC`), or
 * it exists and will not serve without action (a dimension mismatch, a path not indexed as vector, FAILED). Recall answered
 * the not-yet and absent cases as "this collection holds nothing" with no reason, though the collection holds records the
 * index should serve, and answered the will-not-serve case with a thrown error: one broken collection in one space made a
 * global recall, and every caller of it, a 503 (O6).
 *
 * ## The rules, one case each
 *
 *  - not yet, over AGED vectored records (an hour old, outside the fresh-write window): the fresh writes, plus the degraded
 *    reason `index_not_ready` - older records may be missing. All three wordings, as mongot gives them.
 *  - not yet, over a NEW collection - empty, or holding only records inside the fresh-write window, which the fresh-write
 *    scan already answers: empty or the fresh writes, and NO reason (B1, B2: a search straight after a space's first write
 *    answers 200 and never says "degraded"). Passes on the base; it guards the rule the first case must not break.
 *  - an ABSENT index (never built, or dropped; mongot answers no error and no hits) over aged records: `index_not_ready`, on
 *    the plain, the file and the filtered (predicate) recall; over an empty collection: reasonless.
 *  - a REAL will-not-serve refusal (an index built with the wrong `numDimensions` on the harness mongot): that collection
 *    answers `index_unavailable`, the other types of the same space answer, and nothing is thrown - a throw is what the
 *    store-failure classifier turns into a 503. A global recall over two spaces, one of them broken, is a partial answer.
 *  - `checkDuplicates` under a not-yet refusal keeps the matches its fresh-write half finds (it ignores the reason: an
 *    insert-time hint stores nothing). Passes on the base; it guards the composition when recall starts throwing a signal.
 *
 * "Seen red" on the base: the not-yet cases answer reasonless, the absent cases answer reasonless, the will-not-serve cases
 * throw the mongot refusal.
 *
 * Needs a MongoDB with mongot (atlas-local): `npm run test:up`.
 *
 * Run: node --test testing/standalone/a-recall-over-an-index-that-cannot-answer-says-which-records-may-be-missing-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';
import {
  unitAt, queryAxis, startStubEmbedder, createSpaceCollections, insertAll, waitUntilServing, waitUntilTrue,
} from './_vector-harness.mjs';
import { REFUSALS, refuseVectorSearch } from './_mongot-refusals.mjs';

const skip = await mongoSkipReason();

const DIMS = 8;
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-idxreasons-'));
const CONFIG_PATH = path.join(tmpDir, 'config.json');
process.env['CONFIG_PATH'] = CONFIG_PATH;
process.env['EMBEDDING_DIMENSIONS'] = String(DIMS);
process.env['YTHRIL_HYBRID_SEARCH'] = 'off';

/** An hour ago: outside the fresh-write window, so only the INDEX could supply these records. */
const OLD = new Date(Date.now() - 3_600_000).toISOString();

const NYAGED = 'rsnyaged';     // aged vectored entities and one fresh one; the refusal is injected
const NYNEW = 'rsnynew';       // empty collections
const NYFRESH = 'rsnyfresh';   // only a record inside the fresh-write window
const ABSENT = 'rsabsent';     // aged vectored entities and files, no index ever built
const DROPPED = 'rsdropped';   // an index that served, then was dropped
const UNAVAIL = 'rsunavail';   // entities index with the wrong numDimensions (a real refusal); facts index fine
const GOK = 'rsgok';           // a healthy space for the global recall
const SPACES = [NYAGED, NYNEW, NYFRESH, ABSENT, DROPPED, UNAVAIL, GOK];

let mongo, recallMod, vectorIndex, stub, resolveRecallFilter;

const entity = (spaceId, id, deg, extra = {}) => ({
  _id: id, spaceId, name: id, type: 'thing', tags: [], properties: { marker: 'x' }, description: `record ${id}`,
  embedding: unitAt(deg, DIMS), embeddingModel: 'stub', seq: 1, createdAt: OLD, updatedAt: OLD, ...extra,
});
const fact = (spaceId, id, deg, extra = {}) => ({
  _id: id, spaceId, fact: `fact ${id}`, tags: [], embedding: unitAt(deg, DIMS), embeddingModel: 'stub',
  seq: 1, createdAt: OLD, updatedAt: OLD, ...extra,
});
const file = (spaceId, id, deg, extra = {}) => ({
  _id: id, spaceId, path: id, sizeBytes: 10, tags: [], description: `file ${id}`, embedding: unitAt(deg, DIMS),
  embeddingModel: 'stub', matchedText: `text of ${id}`, seq: 1, createdAt: OLD, updatedAt: OLD, ...extra,
});
const justNow = () => { const now = new Date().toISOString(); return { createdAt: now, updatedAt: now }; };

/** A recall the way the doors make it: the answer, what it said was degraded, and what it threw. */
async function recallAnswer(spaceId, types, filter) {
  const degraded = [];
  let results = [];
  let thrown;
  try {
    results = await recallMod.recall(spaceId, 'Q', 10, undefined, types, undefined, undefined, filter, { degraded });
  } catch (err) {
    thrown = err instanceof Error ? err.message : String(err);
  }
  return { ids: results.map(r => r._id), degraded, thrown };
}

/** The predicate-path filter a caller sends (an undeclared `properties.*` key), resolved as the doors resolve it. */
function predicateFilter() {
  const resolved = resolveRecallFilter({ 'properties.marker': 'x' });
  assert.ok(resolved.ok, `the filter was refused: ${resolved.error}`);
  return resolved.kind === 'mongo' ? resolved.filter : resolved.kind === 'expression' ? resolved.expression : undefined;
}

/** One raw query against an index, the way mongot answers it: its refusal's message, or null when it served. */
async function rawRefusal(space, suffix) {
  try {
    await mongo.col(`${space}_${suffix}`).aggregate([{ $vectorSearch: {
      index: `${space}_${suffix}_embedding`, path: 'embedding', queryVector: queryAxis(DIMS), numCandidates: 10, limit: 1,
    } }]).toArray();
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

describe('a recall over an index that cannot answer says which records may be missing', { skip }, () => {
  before(async () => {
    stub = await startStubEmbedder(() => queryAxis(DIMS));
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({ spaces: SPACES.map(id => ({ id, label: id })), networks: [], tokens: [] }, null, 2));
    mongo = await openTestMongo('idxreasons');
    (await import('../../server/dist/config/loader.js')).loadConfig();
    recallMod = await import('../../server/dist/brain/recall.js');
    vectorIndex = await import('../../server/dist/spaces/vector-index.js');
    ({ resolveRecallFilter } = await import('../../server/dist/brain/recall-filter.js'));
    for (const id of SPACES) await createSpaceCollections(mongo, id);

    await insertAll(mongo, `${NYAGED}_entities`, [entity(NYAGED, 'aged-1', 10), entity(NYAGED, 'aged-2', 20), entity(NYAGED, 'aged-3', 30),
      entity(NYAGED, 'fresh-1', 5, justNow())]);
    await insertAll(mongo, `${NYFRESH}_entities`, [entity(NYFRESH, 'only-fresh', 5, justNow())]);
    await insertAll(mongo, `${ABSENT}_entities`, [entity(ABSENT, 'abs-1', 10), entity(ABSENT, 'abs-2', 20)]);
    await insertAll(mongo, `${ABSENT}_files`, [file(ABSENT, 'abs-a.md', 10), file(ABSENT, 'abs-b.md', 20)]);
    await insertAll(mongo, `${DROPPED}_entities`, [entity(DROPPED, 'drop-1', 10), entity(DROPPED, 'drop-2', 20), entity(DROPPED, 'drop-3', 30)]);
    await insertAll(mongo, `${UNAVAIL}_entities`, [entity(UNAVAIL, 'wide-1', 10), entity(UNAVAIL, 'wide-2', 20), entity(UNAVAIL, 'wide-fresh', 5, justNow())]);
    await insertAll(mongo, `${UNAVAIL}_facts`, [fact(UNAVAIL, 'fact-1', 12), fact(UNAVAIL, 'fact-2', 22)]);
    await insertAll(mongo, `${GOK}_entities`, [entity(GOK, 'ok-1', 11), entity(GOK, 'ok-2', 21), entity(GOK, 'ok-3', 31)]);
    await mongo.checkVectorSearchAvailability();

    // Production's own builder, so the live definition is production's. UNAVAIL's entities index is built four wide over
    // eight-wide vectors: mongot accepts it, reports READY, and refuses every query (PROBE M1: "indexed with 32 dimensions
    // but queried with 64"). That is a refusal the real store gives and no injection stands in for.
    await vectorIndex.ensureVectorSearchIndex(UNAVAIL, 'entities', 4, 'cosine', 'embedding', 'embedding', true, []);
    await vectorIndex.ensureVectorSearchIndex(UNAVAIL, 'facts', DIMS, 'cosine', 'embedding', 'embedding', true, []);
    await vectorIndex.ensureVectorSearchIndex(GOK, 'entities', DIMS, 'cosine', 'embedding', 'embedding', true, []);
    await vectorIndex.ensureVectorSearchIndex(DROPPED, 'entities', DIMS, 'cosine', 'embedding', 'embedding', true, []);
    await waitUntilServing(mongo, `${UNAVAIL}_facts`, `${UNAVAIL}_facts_embedding`, { dims: DIMS, n: 2 });
    await waitUntilServing(mongo, `${GOK}_entities`, `${GOK}_entities_embedding`, { dims: DIMS, n: 3 });
    await waitUntilServing(mongo, `${DROPPED}_entities`, `${DROPPED}_entities_embedding`, { dims: DIMS, n: 3 });
    // The refusal is the real one only once mongot gives it; wait for exactly that wording.
    await waitUntilTrue('the four-wide index to refuse an eight-wide query as a dimension mismatch',
      async () => { const m = await rawRefusal(UNAVAIL, 'entities'); return /dimension/i.test(m ?? '') ? true : (m ?? 'served'); },
      120_000, 500);
    // The dropped index: gone from the listing, so mongot answers it as absent (no error, no hits) rather than still serving.
    await mongo.col(`${DROPPED}_entities`).dropSearchIndex(`${DROPPED}_entities_embedding`);
    await waitUntilTrue('the dropped index to leave the listing', async () => {
      const left = (await mongo.col(`${DROPPED}_entities`).listSearchIndexes().toArray()).map(i => i.name);
      return left.length === 0 ? true : left;
    }, 120_000, 500);
  });

  after(async () => {
    await closeTestMongo();
    await stub?.close();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  describe('an index not serving yet', () => {
    for (const [wording, make] of [['Index <name> not initialized', REFUSALS.notInitialized],
      ['while in state NOT_STARTED', REFUSALS.notStarted], ['while in state INITIAL_SYNC', REFUSALS.initialSync]]) {
      it(`over aged records ("${wording}"): the fresh writes, and index_not_ready`, async () => {
        const fault = refuseVectorSearch(make);
        let answer;
        try { answer = await recallAnswer(NYAGED, ['entity']); } finally { fault.restore(); }
        assert.ok(fault.refused() >= 1, 'the fault never reached the recall - the case did not produce the state it is about');
        assert.equal(answer.thrown, undefined, `recall threw: ${answer.thrown}`);
        assert.ok(answer.ids.includes('fresh-1'), `the fresh write was lost: [${answer.ids.join(', ')}]`);
        assert.ok(!answer.ids.some(id => id.startsWith('aged-')), 'the index refused, so an aged record cannot have been served by it');
        assert.ok(answer.degraded.includes('index_not_ready'),
          `degraded is [${answer.degraded.join(', ')}]: three aged records the index should serve are missing from this answer, `
          + 'and a refusal read as an empty collection says nothing - the caller must be told they may be missing');
      });
    }

    it('over an empty collection: empty, and no reason (a search after a space\'s first write is never "degraded")', async () => {
      const fault = refuseVectorSearch(REFUSALS.notInitialized);
      let answer;
      try { answer = await recallAnswer(NYNEW, ['entity', 'fact', 'file']); } finally { fault.restore(); }
      assert.ok(fault.refused() >= 1, 'the fault never reached the recall');
      assert.deepEqual(answer, { ids: [], degraded: [], thrown: undefined });
    });

    it('over a collection holding only fresh records: those records, and no reason', async () => {
      const fault = refuseVectorSearch(REFUSALS.notInitialized);
      let answer;
      try { answer = await recallAnswer(NYFRESH, ['entity']); } finally { fault.restore(); }
      assert.ok(fault.refused() >= 1, 'the fault never reached the recall');
      assert.equal(answer.thrown, undefined);
      assert.deepEqual(answer.ids, ['only-fresh'], 'the fresh-write scan already holds every record of a new collection');
      assert.deepEqual(answer.degraded, [], 'no vectored record older than the fresh window exists, so none can be missing');
    });
  });

  describe('an index that is absent', () => {
    it('never built, aged records: index_not_ready (mongot answers no error and no hits)', async () => {
      const answer = await recallAnswer(ABSENT, ['entity']);
      assert.equal(answer.thrown, undefined, `recall threw: ${answer.thrown}`);
      assert.deepEqual(answer.ids, [], 'fixture check: no index, so nothing but the fresh-write scan can answer, and these are aged');
      assert.deepEqual(answer.degraded, ['index_not_ready'],
        `degraded is [${answer.degraded.join(', ')}]: two aged vectored records exist and the answer is empty with no reason`);
    });

    it('dropped after it served, aged records: index_not_ready', async () => {
      const answer = await recallAnswer(DROPPED, ['entity']);
      assert.equal(answer.thrown, undefined, `recall threw: ${answer.thrown}`);
      assert.deepEqual(answer.ids, []);
      assert.deepEqual(answer.degraded, ['index_not_ready'], 'a lost index over records it served is the "silently returns empty for ever" case');
    });

    it('a FILE recall over an absent index with aged file rows: index_not_ready', async () => {
      const answer = await recallAnswer(ABSENT, ['file']);
      assert.equal(answer.thrown, undefined, `recall threw: ${answer.thrown}`);
      assert.deepEqual(answer.ids, []);
      assert.deepEqual(answer.degraded, ['index_not_ready'], 'the file branch takes the predicate path; its empty first window is not "exhausted"');
    });

    it('a FILTERED recall (predicate path) over an absent index with aged records: index_not_ready', async () => {
      const answer = await recallAnswer(ABSENT, ['entity'], predicateFilter());
      assert.equal(answer.thrown, undefined, `recall threw: ${answer.thrown}`);
      assert.deepEqual(answer.ids, [], 'the predicate path completes from the collection only when its window proves too small');
      assert.ok(answer.degraded.includes('index_not_ready'),
        `degraded is [${answer.degraded.join(', ')}]: the index returned nothing at all over a collection that holds vectored records`);
    });

    it('over an empty collection (no index, no records): reasonless, on the plain, file and filtered recall', async () => {
      for (const [what, types, filter] of [['plain', ['entity']], ['file', ['file']], ['filtered', ['entity'], predicateFilter()]]) {
        const answer = await recallAnswer(NYNEW, types, filter);
        assert.deepEqual(answer, { ids: [], degraded: [], thrown: undefined }, `${what} recall over an empty collection`);
      }
    });
  });

  describe('a filter the database refuses is the caller\'s error, not an index that cannot answer', () => {
    it('a recall whose filter the store rejects (BadValue) throws what the classifier answers 400, with no index reason', async () => {
      const resolved = resolveRecallFilter({ 'properties.marker': { $in: 5 } });
      assert.ok(resolved.ok, `fixture check: the sanitizer must let this through to the store, or the case tests nothing: ${resolved.error}`);
      const filter = resolved.kind === 'mongo' ? resolved.filter : resolved.kind === 'expression' ? resolved.expression : undefined;
      const { classifyReadFailure } = await import('../../server/dist/brain/store-failure.js');
      const degraded = [];
      let caught;
      try {
        await recallMod.recall(GOK, 'Q', 10, undefined, ['entity'], undefined, undefined, filter, { degraded });
      } catch (err) {
        caught = err;
      }
      assert.ok(caught, `the recall answered (degraded [${degraded.join(', ')}]) where the store refused the caller's filter: `
        + 'a malformed filter would read as a 200 with index_unavailable, and the caller is never told its filter is wrong');
      assert.equal(classifyReadFailure(caught).status, 400, `the refusal classifies as ${classifyReadFailure(caught).status}, not the caller's 400`);
      assert.deepEqual(degraded, [], 'no index reason for a refusal of the caller\'s own filter');
    });
  });

  describe('an index that will not serve (a real refusal: wrong numDimensions)', () => {
    it('fixture check: the harness mongot refuses the query for the dimension mismatch', async () => {
      const refusal = await rawRefusal(UNAVAIL, 'entities');
      assert.match(refusal ?? 'served', /dimension/i, 'the index must be one mongot REALLY refuses, not an injected stand-in');
    });

    it('that collection answers index_unavailable, the other types answer, and nothing is thrown (no 503)', async () => {
      const answer = await recallAnswer(UNAVAIL, ['entity', 'fact']);
      assert.equal(answer.thrown, undefined,
        `recall threw "${answer.thrown}": a throw here reaches the store-failure classifier and is a 503 for the whole recall, `
        + 'though two of its three collections can answer');
      assert.ok(answer.ids.includes('fact-1') && answer.ids.includes('fact-2'), `the facts, whose index serves, are missing: [${answer.ids.join(', ')}]`);
      assert.ok(answer.ids.includes('wide-fresh'), 'the entities\' fresh-write half must still answer');
      assert.ok(!answer.ids.includes('wide-1'), 'fixture check: the broken index serves nothing, so an aged entity cannot be in the answer');
      assert.ok(answer.degraded.includes('index_unavailable'), `degraded is [${answer.degraded.join(', ')}]`);
      assert.ok(!answer.degraded.includes('index_not_ready'), 'a refusal that needs action is not "being built"');
    });

    it('a global recall over two spaces, one of them broken: a partial answer, not a store failure', async () => {
      const degraded = [];
      let results, thrown;
      try {
        results = await recallMod.recallGlobal([GOK, UNAVAIL], 'Q', 10, undefined, ['entity'], undefined, undefined, undefined, { degraded });
      } catch (err) {
        thrown = err instanceof Error ? err.message : String(err);
      }
      assert.equal(thrown, undefined,
        `the global recall threw "${thrown}": one broken collection in one space fails every space's answer`);
      const ids = results.map(r => r._id);
      assert.ok(['ok-1', 'ok-2', 'ok-3'].every(id => ids.includes(id)), `the healthy space's records are missing: [${ids.join(', ')}]`);
      assert.ok(degraded.includes('index_unavailable'), `degraded is [${degraded.join(', ')}]`);
    });
  });

  describe('the insert-time duplicate check', () => {
    it('keeps the matches its fresh-write half finds when the index refuses as not ready', async () => {
      const fault = refuseVectorSearch(REFUSALS.notInitialized);
      let dupes;
      try { dupes = await recallMod.checkDuplicates(NYAGED, 'entity', queryAxis(DIMS)); } finally { fault.restore(); }
      assert.ok(fault.refused() >= 1, 'the fault never reached the duplicate check');
      assert.deepEqual(dupes.map(d => d._id), ['fresh-1'],
        'a not-ready index over aged records must not take the fresh-write matches with it (the half that can answer without the index)');
    });
  });
});
