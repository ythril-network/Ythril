/**
 * Recall asks its text search beside its vector search, not after it, and the fused ranking is unchanged (bundle-378, Q-976 S3, contract
 * rows 1, 3 and 4).
 *
 * ## The rule
 *
 * At BSBM 1 000 a recall took about 180 ms, of which the text (lexical) search took about 150: one `$text` query whose matching records
 * (20 256 for "product offer") the store fetches and scores whatever the limit. Its query needs only the query text and the recall's own
 * predicate, never the vector results, yet it was sent only after the query embedding, every vector search and the fresh-write scan had
 * ended. It is now started as soon as the recall knows its types, so the store runs it while the embedding, the vector searches and the
 * fresh scan run, and the fusion waits only for what is left of it.
 *
 * The cost assertion: the vector search is held until the text query has been sent (at most a few seconds); before the cut the text query
 * is only sent after every vector search answered, so it never is.
 *
 * ## The guarantee the cut must keep
 *
 * The ranking: every result's fused score is `1/(60 + vectorRank) + 1/(60 + lexicalRank)` (the second term only where the text search found
 * it), the answer is in that order with ties by id, and a record written just before the recall (the fresh scan's) is ranked by its text
 * like any other.
 *
 * ## Seen red
 *
 * On 17dce733e the text query is sent after the vector searches answered: the held vector search waits out its bound with no text query.
 *
 * Run: a Mongo the harness accepts, npm run build:server, then
 *      node --test testing/standalone/recall-asks-its-text-search-beside-the-vector-search-db.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Collection } from 'mongodb';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';
import { queryAxis, unitAt, startStubEmbedder, createSpaceCollections } from './_vector-harness.mjs';
import { patchVectorSearch } from './_mongot-refusals.mjs';
import { holdsWithin } from '../_shared/wait-for.mjs';

const skip = await mongoSkipReason();

const DIMS = 8;
const SPACE = 'lexbeside';
/** How long the held vector search waits for the text query before it answers anyway. */
const HOLD_MS = 3_000;
const RRF_K = 60;
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-lexbeside-'));
const CONFIG_PATH = path.join(tmpDir, 'config.json');
process.env['CONFIG_PATH'] = CONFIG_PATH;
process.env['EMBEDDING_DIMENSIONS'] = String(DIMS);
delete process.env['YTHRIL_HYBRID_SEARCH'];

let mongo, recallMod, stub;

/** Records written just now, so the fresh scan supplies them; each at its own angle, so the vector order is known. */
const RECORDS = [
  { id: 'r-a', deg: 10, text: 'gear lever housing' },
  { id: 'r-b', deg: 20, text: 'widget spring' },
  { id: 'r-c', deg: 30, text: 'widget widget bracket' },
  { id: 'r-d', deg: 40, text: 'bolt washer' },
];

/** Note each `$text` find the server's driver is asked for, in order. */
function watchTextFinds() {
  const original = Collection.prototype.find;
  const seen = [];
  Collection.prototype.find = function find(filter, ...rest) {
    if (filter && typeof filter === 'object' && '$text' in filter) seen.push(this.collectionName);
    return original.call(this, filter, ...rest);
  };
  return { seen, restore: () => { Collection.prototype.find = original; } };
}

describe('recall asks its text search beside its vector search', { skip }, () => {
  before(async () => {
    stub = await startStubEmbedder(() => queryAxis(DIMS));
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({ spaces: [{ id: SPACE, label: SPACE }], networks: [], tokens: [] }, null, 2));
    mongo = await openTestMongo('lexbeside');
    (await import('../../server/dist/config/loader.js')).loadConfig();
    recallMod = await import('../../server/dist/brain/recall.js');
    await mongo.checkVectorSearchAvailability();
    await createSpaceCollections(mongo, SPACE);
    await mongo.col(`${SPACE}_entities`).createIndex({ matchedText: 'text' }, { name: 'lexical_text' });
    const now = new Date().toISOString();
    await mongo.col(`${SPACE}_entities`).insertMany(RECORDS.map((r, i) => ({
      _id: r.id, spaceId: SPACE, name: r.id, type: 'thing', tags: [], properties: {}, matchedText: r.text,
      embedding: unitAt(r.deg, DIMS), embeddingModel: 'stub', seq: i + 1, createdAt: now, updatedAt: now,
    })));
  });

  after(async () => {
    await closeTestMongo();
    await stub?.close();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it('the text query is sent before the vector search answers, and the fused ranking holds', { timeout: 60_000 }, async () => {
    const finds = watchTextFinds();
    let textBeforeVector = null;
    // The vector index answers nothing (it has not taken the records): the fresh scan supplies them, as for a write just made.
    const held = patchVectorSearch(() => async (_real, cursor) => {
      const sent = await holdsWithin(() => finds.seen.length > 0, HOLD_MS, 10, { what: 'the text query to be sent' });
      if (textBeforeVector === null) textBeforeVector = sent;
      await cursor.close();
      return [];
    });
    let results;
    try {
      results = await recallMod.recall(SPACE, 'widget', 10, undefined, ['entity']);
    } finally {
      held.restore();
      finds.restore();
    }
    assert.ok(finds.seen.length > 0, 'the recall sent no text query at all, so the case below proves nothing');
    assert.equal(textBeforeVector, true,
      'the text query was sent only after the vector search answered: the store ran the two one after the other');

    // The guarantee: the fused ranking, computed from the ranks each result carries, and the order the answer is in.
    const ids = results.map(r => r._id);
    assert.deepEqual([...ids].sort(), RECORDS.map(r => r.id).sort(), `every fresh record is answered: ${JSON.stringify(ids)}`);
    const byVector = [...RECORDS].sort((a, b) => a.deg - b.deg).map(r => r.id);
    for (const r of results) {
      assert.equal(r.vectorRank, byVector.indexOf(r._id) + 1, `${r._id}: its vector rank is its place by meaning`);
      const expected = 1 / (RRF_K + r.vectorRank) + (r.lexicalRank !== undefined ? 1 / (RRF_K + r.lexicalRank) : 0);
      assert.ok(Math.abs(r.fusedScore - expected) < 1e-12, `${r._id}: fused ${r.fusedScore}, the ranks give ${expected}`);
    }
    assert.deepEqual(results.filter(r => r.lexicalRank !== undefined).map(r => r._id).sort(), ['r-b', 'r-c'],
      'the text search ranks exactly the records whose text names the query');
    const ordered = [...results].sort((a, b) => b.fusedScore - a.fusedScore || (a._id < b._id ? -1 : a._id > b._id ? 1 : 0)).map(r => r._id);
    assert.deepEqual(ids, ordered, 'the answer is in fused order, ties by id');
  });
});
