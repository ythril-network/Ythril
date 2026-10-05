/**
 * A vector read that reaches mongot while a collection's index says `Index <name> not initialized` is ANSWERED, never
 * refused (Q-325) — every reader that queries a vector index, against a real store.
 *
 * ## The defect
 *
 * A collection's search index is built on its first record (`spaces/search-index-presence.ts`), asynchronously, so a
 * recall right after a space's first write can reach mongot between `createSearchIndex` and the index serving. mongot
 * refuses the query in that window, and in more than one wording. Measured on the test store (main's bundle-30 I9):
 * first `Index <name> not initialized`, then `cannot query vector index … while in state NOT_STARTED`, then `…
 * INITIAL_SYNC`, then it serves — all code 8 `UnknownError`. Recall answered the later two as "this collection holds
 * nothing yet" (the answer `search-index-presence.ts` promises for an absent index) and refused the first: a REST recall
 * answered 503 a hundred milliseconds before the MCP recall in the same space answered 200.
 *
 * ## Why this injects, and the one case main also has is NOT here
 *
 * `not initialized` lasts tens of milliseconds on a warm mongot, so a case that waits for the real window races it:
 * main's first case (a recall sandwiched between two refused raw queries) passes about a state it may never produce, or
 * flakes. The patch's test lets every `$vectorSearch` aggregate reach the store and then answers it with mongot's exact
 * refusal, as the driver delivers it (a `MongoServerError`, code 8, at `toArray`); everything else — the fresh-write
 * scan, the record reads — runs against the real store. Every reader is asked: `recall`, `findSimilar` and the
 * insert-time `checkDuplicates`.
 *
 * Seen red on 6eb5a333 (v5.6.3): recall and findSimilar threw the refusal (answered 503 through the doors);
 * checkDuplicates answered `[]`, losing the fresh-write half it can answer without the index.
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
const INJECTED = 'initwininj';
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-initwin-'));
const CONFIG_PATH = path.join(tmpDir, 'config.json');
process.env['CONFIG_PATH'] = CONFIG_PATH;
process.env['EMBEDDING_DIMENSIONS'] = String(DIMS);
process.env['YTHRIL_HYBRID_SEARCH'] = 'off';

let mongo, recallMod, stub;

async function writeFirstRecord(space) {
  await createSpaceCollections(mongo, space);
  const now = new Date().toISOString();
  const id = `${space}-first`;
  await mongo.col(`${space}_entities`).insertOne({ _id: id, spaceId: space, name: id, type: 'thing', tags: [],
    properties: {}, embedding: queryAxis(DIMS), embeddingModel: 'stub', seq: 1, createdAt: now, updatedAt: now });
  return id;
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
      spaces: [{ id: INJECTED, label: INJECTED }], networks: [], tokens: [],
    }, null, 2));
    mongo = await openTestMongo('initwin');
    (await import('../../server/dist/config/loader.js')).loadConfig();
    recallMod = await import('../../server/dist/brain/recall.js');
    await mongo.checkVectorSearchAvailability();
  });

  after(async () => {
    await closeTestMongo();
    await stub?.close();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
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

  it('PIN: a refusal that is NOT "not yet" still reaches the caller (a deadline, a malformed query)', async () => {
    // What the recogniser must not swallow: reading these as an empty collection reports an incomplete answer as a
    // complete one. Injected the same way, with the words of an executor error that is not about an index being built.
    const original = Collection.prototype.aggregate;
    Collection.prototype.aggregate = function aggregate(pipeline, ...rest) {
      const cursor = original.call(this, pipeline, ...rest);
      if (!(Array.isArray(pipeline) && pipeline[0]?.['$vectorSearch'])) return cursor;
      cursor.toArray = async () => {
        await cursor.close();
        throw new MongoServerError({ ok: 0, code: 8, codeName: 'UnknownError',
          errmsg: 'Executor error during aggregate command on namespace: x.y :: caused by :: queryVector must have 8 dimensions' });
      };
      return cursor;
    };
    try {
      await assert.rejects(() => recallMod.recall(INJECTED, 'Q', 10, undefined, ['entity']), /queryVector must have 8 dimensions/);
    } finally {
      Collection.prototype.aggregate = original;
    }
  });
});
