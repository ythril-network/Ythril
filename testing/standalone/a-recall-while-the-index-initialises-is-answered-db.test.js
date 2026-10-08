/**
 * A vector read that lands while a collection's index is still initialising is ANSWERED, never refused (Q-325) —
 * against real mongot.
 *
 * ## The defect
 *
 * A collection's search index is built on its first record (`spaces/search-index-presence.ts`), asynchronously, so a
 * recall right after a space's first write can reach mongot between `createSearchIndex` and the index serving. mongot
 * refuses the query in that window, and in more than one wording. Measured on the test store (bundle-30 I9): first
 * `Index <name> not initialized`, then `cannot query vector index … while in state NOT_STARTED`, then `… INITIAL_SYNC`,
 * then it serves — all code 8 `UnknownError`. Recall answered the later two as "this collection holds nothing yet",
 * the answer `search-index-presence.ts` promises for an absent index, and refused the first: the integration suite met
 * it as a REST recall answering 503 a hundred milliseconds before the MCP recall in the same space answered 200.
 *
 * ## Two cases, and why the second injects
 *
 *  1. **The real window.** Each attempt writes one record into a fresh space, creates the index, and recalls at once,
 *     with a pass-through spy on the recall's OWN `$vectorSearch` recording whether the real mongot refused it as not
 *     queryable yet. It must not throw, and must return the record through the fresh-write channel. An attempt whose
 *     recall was served is not counted; at least one must be caught, or the case fails rather than passing about a
 *     state it never produced. (It once inferred the refusal from two raw queries SANDWICHING the recall; on CI's mongot
 *     the build finished during the recall every time, so the query after it served and nothing was ever caught.)
 *  2. **The first wording, which this harness cannot hold open.** `not initialized` lasts tens of milliseconds on a
 *     warm mongot (measured: seen as the BEFORE query in one attempt of nine, never on both sides of a recall), so case
 *     1 almost always catches the later wordings. Case 2 lets every `$vectorSearch` aggregate reach the store and then
 *     answers it with mongot's exact refusal, as the driver delivers it (a `MongoServerError`, code 8, at `toArray`);
 *     everything else — the fresh-write scan, the record reads — runs against the real store. Every reader that
 *     queries a vector index is asked: `recall`, `findSimilar` and the insert-time `checkDuplicates`.
 *
 * Seen red on the build before the shared recogniser (`brain/index-not-queryable.ts`): recall and findSimilar threw
 * the refusal; checkDuplicates answered `[]`, losing the fresh-write half it can answer without the index.
 *
 * Needs a MongoDB with mongot (atlas-local): `npm run test:up` — CI runs it against the test stack.
 *
 * Run: node --test testing/standalone/a-recall-while-the-index-initialises-is-answered-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Collection, MongoServerError } from 'mongodb';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';
import { queryAxis, startStubEmbedder, createSpaceCollections } from './_vector-harness.mjs';

const skip = await mongoSkipReason();

const DIMS = 8;
/** Attempts at catching the real window. Each costs one index build over one record, well under a second. */
const ATTEMPTS = 12;
const SPACES = Array.from({ length: ATTEMPTS }, (_, i) => `initwin${i}`);
const INJECTED = 'initwininj';
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-initwin-'));
const CONFIG_PATH = path.join(tmpDir, 'config.json');
process.env['CONFIG_PATH'] = CONFIG_PATH;
process.env['EMBEDDING_DIMENSIONS'] = String(DIMS);
process.env['YTHRIL_HYBRID_SEARCH'] = 'off';

let mongo, recallMod, stub, notQueryableYet;

/** One raw query against the index recall reads: the refusal's message, or null when it served. */
async function rawRefusal(space) {
  try {
    await mongo.col(`${space}_entities`).aggregate([{ $vectorSearch: {
      index: `${space}_entities_embedding`, path: 'embedding', queryVector: queryAxis(DIMS), numCandidates: 10, limit: 1,
    } }]).toArray();
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

async function writeFirstRecord(space) {
  await createSpaceCollections(mongo, space);
  const now = new Date().toISOString();
  const id = `${space}-first`;
  await mongo.col(`${space}_entities`).insertOne({ _id: id, spaceId: space, name: id, type: 'thing', tags: [],
    properties: {}, embedding: queryAxis(DIMS), embeddingModel: 'stub', seq: 1, createdAt: now, updatedAt: now });
  return id;
}

/**
 * What the REAL store answered to every `$vectorSearch` aggregate issued while it is installed: per collection, how many
 * it refused as an index not queryable yet (the server's own recogniser, `isIndexNotQueryableYet`) and how many it
 * served. A pass-through spy — the query, its answer and its error reach the caller unchanged — on the same seam the
 * injection below uses, which every vector reader goes through (`toArray`; case 2 holds that).
 *
 * It is how case 1 knows the recall's OWN query landed inside the build window. It used to infer that from two raw
 * queries around the recall, both refused: on CI's mongot the index finished during the recall in every attempt, so the
 * query after it always served and the case failed without ever having been wrong about the recall (Q-423, main run
 * 37728673657).
 */
function watchVectorSearch() {
  const original = Collection.prototype.aggregate;
  const seen = new Map();
  const tally = (ns, key) => { const t = seen.get(ns) ?? { refused: 0, served: 0 }; t[key]++; seen.set(ns, t); };
  Collection.prototype.aggregate = function aggregate(pipeline, ...rest) {
    const cursor = original.call(this, pipeline, ...rest);
    if (!(Array.isArray(pipeline) && pipeline[0]?.['$vectorSearch'])) return cursor;
    const ns = this.collectionName;
    const toArray = cursor.toArray.bind(cursor);
    cursor.toArray = async () => {
      try {
        const docs = await toArray();
        tally(ns, 'served');
        return docs;
      } catch (err) {
        if (notQueryableYet(err)) tally(ns, 'refused');
        throw err;
      }
    };
    return cursor;
  };
  return { of: (ns) => seen.get(ns) ?? { refused: 0, served: 0 }, restore: () => { Collection.prototype.aggregate = original; } };
}

/**
 * Every `$vectorSearch` aggregate goes to the store and comes back as mongot's refusal of an index it has not
 * initialised — the message verbatim as the test store gave it, the namespace and index name this space's.
 */
function refuseVectorSearchAsNotInitialized() {
  const original = Collection.prototype.aggregate;
  let refused = 0;
  Collection.prototype.aggregate = function aggregate(pipeline, ...rest) {
    const cursor = original.call(this, pipeline, ...rest);
    const stage = Array.isArray(pipeline) ? pipeline[0]?.['$vectorSearch'] : undefined;
    if (!stage) return cursor;
    const err = new MongoServerError({ ok: 0, code: 8, codeName: 'UnknownError',
      errmsg: `Executor error during aggregate command on namespace: ${this.dbName}.${this.collectionName} :: caused by :: `
        + `Index ${stage.index} not initialized` });
    cursor.toArray = async () => { refused++; await cursor.close(); throw err; };
    return cursor;
  };
  return { refused: () => refused, restore: () => { Collection.prototype.aggregate = original; } };
}

describe('a vector read while the index initialises is answered', { skip }, () => {
  before(async () => {
    stub = await startStubEmbedder(() => queryAxis(DIMS));
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({
      spaces: [...SPACES, INJECTED].map(id => ({ id, label: id })), networks: [], tokens: [],
    }, null, 2));
    mongo = await openTestMongo('initwin');
    (await import('../../server/dist/config/loader.js')).loadConfig();
    recallMod = await import('../../server/dist/brain/recall.js');
    ({ isIndexNotQueryableYet: notQueryableYet } = await import('../../server/dist/brain/index-not-queryable.js'));
    await mongo.checkVectorSearchAvailability();
  });

  after(async () => {
    await closeTestMongo();
    await stub?.close();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it('a recall inside the real build window answers with the record', { timeout: 120_000 }, async (t) => {
    const caught = [];
    for (const space of SPACES) {
      const id = await writeFirstRecord(space);
      await mongo.col(`${space}_entities`).createSearchIndex({ name: `${space}_entities_embedding`, type: 'vectorSearch',
        definition: { fields: [{ type: 'vector', path: 'embedding', numDimensions: DIMS, similarity: 'cosine' }] } });

      // The recall goes straight after the index is created: a raw query first would only spend the window it needs.
      let answer, thrown;
      const watch = watchVectorSearch();
      try {
        answer = await recallMod.recall(space, 'Q', 10, undefined, ['entity']);
      } catch (err) {
        thrown = err instanceof Error ? err.message : String(err);
      } finally {
        watch.restore();
      }
      const own = watch.of(`${space}_entities`);
      const after = await rawRefusal(space);
      t.diagnostic(`${space}: the recall's own vector queries ${own.refused} refused, ${own.served} served | after=`
        + `${after ?? 'served'} | recall ${thrown ? `threw ${thrown}` : 'answered'}`);

      // Caught: the real mongot refused, as not queryable yet, a vector query the recall itself issued.
      if (own.refused > 0) caught.push(space);
      // Whatever window it landed in, a recall here never throws: the index absent, initialising or serving.
      assert.equal(thrown, undefined, `recall in ${space} threw while the index was being built: ${thrown}`);
      assert.ok(answer.some(r => r._id === id),
        `recall in ${space} lost the record it was written with: ${JSON.stringify(answer.map(r => r._id))}`);
      if (caught.length >= 3) break;
    }
    assert.ok(caught.length > 0, `in none of ${ATTEMPTS} attempts did the real store refuse a vector query the recall itself `
      + 'issued, so this run never produced the state it is about — the assertions above passed for an index that was already serving');
  });

  it('"Index … not initialized" is answered by recall, findSimilar and checkDuplicates', async () => {
    const id = await writeFirstRecord(INJECTED);
    const fault = refuseVectorSearchAsNotInitialized();
    try {
      const recalled = await recallMod.recall(INJECTED, 'Q', 10, undefined, ['entity']);
      assert.ok(recalled.some(r => r._id === id),
        `recall lost the record the fresh-write channel holds: ${JSON.stringify(recalled.map(r => r._id))}`);

      const similar = await recallMod.findSimilar(INJECTED, id, 'entity');
      assert.deepEqual(similar.results, [], 'findSimilar answers from the index alone, so an index not serving yet is an empty answer');

      const dupes = await recallMod.checkDuplicates(INJECTED, 'entity', queryAxis(DIMS));
      assert.deepEqual(dupes.map(d => d._id), [id],
        'the insert-time duplicate check lost the fresh-write half it can answer without the index');

      assert.ok(fault.refused() >= 3, `only ${fault.refused()} vector queries were refused — the fault never reached a reader`);
    } finally {
      fault.restore();
    }
  });
});
