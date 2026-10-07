/**
 * A score computed locally is the score the vector engine reports — for every metric an index can use (`Q-117`).
 *
 * `vector-score.ts` stated its mapping table rather than deriving it, and the agreement check only ever ran on cosine.
 * Probed against mongodb-atlas-local: euclidean is `1 / (1 + d²)` on the engine and `1 / (1 + d)` here, up to 0.09
 * apart — so on a euclidean instance the fresh-write duplicate threshold acted on the wrong scale and the lexical
 * channel's agreement check always failed. This compares the two for real, per metric, so the table follows the test.
 *
 * Run: `npm run test:up` first, then node --test testing/standalone/a-local-vector-score-is-the-engines-db.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';
import { sleep } from '../_shared/sleep.mjs';

const skip = await mongoSkipReason();
const DIMS = 4;
const METRICS = ['cosine', 'dotProduct', 'euclidean'];

/** A few vectors, unit length so dotProduct is allowed, spread so their scores differ. */
const unit = (v) => { const n = Math.hypot(...v); return v.map(x => x / n); };
const DOCS = [[1, 0, 0, 0], [0.8, 0.6, 0, 0], [0.2, 0.3, 0.9, 0.1], [-0.5, 0.5, 0.5, 0.5], [0, 0, 0, 1]].map(unit);
const QUERY = unit([0.9, 0.3, 0.2, 0.1]);

let mongo, score;

async function waitQueryable(coll, name) {
  for (let i = 0; i < 120; i++) {
    const idx = await coll.listSearchIndexes(name).toArray();
    if (idx[0]?.queryable) return;
    await sleep(500);
  }
  throw new Error(`search index ${name} never became queryable`);
}

describe('the local score mapping agrees with the engine, per metric', { skip }, () => {
  before(async () => {
    mongo = await openTestMongo('q117');
    score = await import('../../server/dist/brain/vector-score.js');
  });

  after(async () => { await closeTestMongo(); });

  for (const similarity of METRICS) {
    it(`${similarity}: every record's local score equals vectorSearchScore`, async () => {
      const coll = mongo.getDb().collection(`q117_${similarity}`);
      await coll.insertMany(DOCS.map((embedding, i) => ({ _id: `d${i}`, embedding })));
      const name = `q117_${similarity}_idx`;
      await coll.createSearchIndex({ name, type: 'vectorSearch',
        definition: { fields: [{ type: 'vector', path: 'embedding', numDimensions: DIMS, similarity }] } });
      await waitQueryable(coll, name);

      const rows = await coll.aggregate([
        { $vectorSearch: { index: name, path: 'embedding', queryVector: QUERY, exact: true, limit: DOCS.length } },
        { $project: { embedding: 1, s: { $meta: 'vectorSearchScore' } } },
      ]).toArray();
      assert.equal(rows.length, DOCS.length, 'the engine did not score every record');

      const worst = Math.max(...rows.map(r => Math.abs(score.atlasVectorScore(QUERY, r.embedding, similarity) - r.s)));
      assert.ok(worst < score.SCORE_AGREEMENT_EPSILON,
        `${similarity}: the local mapping is off the engine's by up to ${worst.toFixed(4)}`);
    });
  }
});
