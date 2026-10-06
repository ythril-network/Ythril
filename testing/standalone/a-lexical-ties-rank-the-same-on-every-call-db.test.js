/**
 * Two identical lexical searches over an unchanged corpus rank their ties the same way — and by `_id`.
 *
 * ## What this prevents
 *
 * `lexicalSearch` sorted on `{ $meta: 'textScore' }` alone. A `$text` score is a function of the matched terms and the
 * field length, so records that share a template ("Vault credential rotation service number 7, scoping authentication
 * tokens") score EXACTLY alike, and the database orders a tie however its scan happened to produce it. Measured on the
 * test stack: 20 identical finds over 28 tied records returned 19 different orders, with no write in between.
 *
 * That order is the lexical channel's rank, the rank is a term of the fused score, and the fused score is the answer's
 * ranking — so two identical recalls ranked the same records differently. `skip` / `nextSkip` re-run the search on
 * every page, so a caller paging through the answer saw some matches twice and missed others (b56, the paging case of
 * `result-spill-both-doors`). Every other ranking sort in recall ends in `byIdAsc` (`byRankThenId`); this was the one
 * that ranks at the database and so was outside it.
 *
 * Run: node --test testing/standalone/a-lexical-ties-rank-the-same-on-every-call-db.test.js   (needs the test stack)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';

const skip = await mongoSkipReason();
const SUITE = 'lexical_ties';
const SPACE = 'ties';
const COUNT = 28;
const REPEATS = 20;
const QUERY = 'vault credential rotation service';

let lexicalSearch;

describe('lexicalSearch ranks tied records identically on every call', { skip }, () => {
  before(async () => {
    const mongo = await openTestMongo(SUITE);
    ({ lexicalSearch } = await import('../../server/dist/brain/lexical-search.js'));
    const coll = mongo.col(`${SPACE}_entities`);
    await coll.createIndex({ matchedText: 'text' }, { name: 'lexical_text' });
    // The same template for every record: only a number differs, and a number the query does not name scores nothing,
    // so every record carries the identical text score.
    await coll.insertMany(Array.from({ length: COUNT }, (_, i) => ({
      _id: `e-${randomUUID()}`,
      spaceId: SPACE,
      matchedText: `Vault credential rotation service number ${i}, scoping authentication tokens`,
    })));
  });

  after(async () => { await closeTestMongo(); });

  it('the corpus really is a tie, or the case below proves nothing', async () => {
    const hits = await lexicalSearch(SPACE, 'entity', QUERY, 84);
    assert.equal(hits.length, COUNT);
    assert.equal(new Set(hits.map(h => h.lexicalScore)).size, 1, 'every record must carry the same text score');
  });

  it(`${REPEATS} identical searches return one order, ascending by _id within the tie`, async () => {
    const orders = new Set();
    let first = [];
    for (let i = 0; i < REPEATS; i++) {
      const ids = (await lexicalSearch(SPACE, 'entity', QUERY, 84)).map(h => h._id);
      if (i === 0) first = ids;
      orders.add(ids.join(','));
    }
    assert.equal(orders.size, 1,
      `${orders.size} different orders over ${REPEATS} identical searches — a tie is ranked at the database's whim`);
    assert.deepEqual(first, [...first].sort(), 'and a tie is ranked _id ascending, the rule every other ranking sort uses');
  });
});
