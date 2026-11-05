/**
 * The index probe answers how many records the index served, not only whether it refused (Q-696, design v3 item 2).
 *
 * ## The defect it is part of
 *
 * A filtered recall whose native search answered nothing cannot tell an index that serves and missed a match (`filter_window`)
 * from an index that serves nothing at all (`index_not_ready`): both are "no error, no hits". The probe that already asks an
 * index one question (`indexServes`: one unfiltered `$vectorSearch`, `limit: 1`) throws the answer away and keeps "no error".
 * `askIndexOnce` in `spaces/vector-index.ts` is that one question with its answer kept: `{ records }` (how many came back), or
 * `{ error }` (the store refused it). `indexServes` is built on it and keeps its meaning (served = no error); the recall's
 * decision reads `records`.
 *
 * ## What these rows pin
 *
 *  - it is exported, and asks the question the poll and recall ask: a `$vectorSearch` on the named index, at the indexed
 *    path, with a query vector of the index's width, `limit: 1`;
 *  - it returns the count of records the store gave, and 0 records is a count of 0: not an error, and not a record (an index that
 *    answers nothing has served nothing);
 *  - it takes `maxTimeMS` as its fourth argument and puts it on the aggregate, so a caller bounds the read it is making;
 *  - a refusal is `{ error }` with the store's message and NO `records` key, so a refusal is never read as zero hits.
 *
 * Red on the base: `askIndexOnce` is not exported. No database: the collection is a recording stand-in, because the contract is
 * about what the function asks and returns, and a live mongot is pinned by the recall cases.
 *
 * Run: node --test testing/standalone/a-probe-of-an-index-answers-how-many-records-it-served.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const vectorIndex = await import('../../server/dist/spaces/vector-index.js');

const TARGET = { vectorPath: 'embedding', dims: 8 };
const INDEX = 'someSpace_entities_embedding';

/** A collection that records what it was asked and answers `rows`, or throws `fail`. */
function standIn({ rows = [], fail } = {}) {
  const asked = [];
  return {
    asked,
    coll: {
      aggregate(pipeline, options) {
        asked.push({ pipeline, options });
        return { toArray: async () => { if (fail) throw fail; return rows; } };
      },
    },
  };
}

describe('the index probe answers how many records it served', () => {
  it('is exported by spaces/vector-index', () => {
    assert.equal(typeof vectorIndex.askIndexOnce, 'function', 'askIndexOnce is not exported: the probe keeps no count, and the recall cannot tell an empty index from a lagging one');
  });

  it('asks one $vectorSearch of the named index, at the indexed path, with a vector of the index\'s width, limit 1', async () => {
    const { coll, asked } = standIn({ rows: [{ _id: 'a' }] });
    await vectorIndex.askIndexOnce(coll, INDEX, TARGET, 3_000);
    assert.equal(asked.length, 1, 'the probe is ONE read');
    const stage = asked[0].pipeline[0]?.['$vectorSearch'];
    assert.ok(stage, `the probe's first stage is not a $vectorSearch: ${JSON.stringify(asked[0].pipeline[0])}`);
    assert.equal(stage.index, INDEX);
    assert.equal(stage.path, TARGET.vectorPath);
    assert.equal(stage.queryVector.length, TARGET.dims);
    assert.equal(stage.limit, 1);
    assert.equal(stage.filter, undefined, 'the probe is UNFILTERED: it asks whether the index serves at all, not whether it serves a match');
  });

  it('returns the count of records the store gave', async () => {
    const one = await vectorIndex.askIndexOnce(standIn({ rows: [{ _id: 'a' }] }).coll, INDEX, TARGET, 3_000);
    assert.deepEqual(one, { records: 1 });
  });

  it('0 records is a count of 0: not an error, and not a record', async () => {
    const none = await vectorIndex.askIndexOnce(standIn({ rows: [] }).coll, INDEX, TARGET, 3_000);
    assert.deepEqual(none, { records: 0 }, 'an index that answers no hits is `{ records: 0 }`: served nothing, and not refused');
    assert.ok(!('error' in none));
  });

  it('takes maxTimeMS as its fourth argument and puts it on the aggregate', async () => {
    for (const ms of [250, 2_000, 7_001]) {
      const { coll, asked } = standIn({ rows: [] });
      await vectorIndex.askIndexOnce(coll, INDEX, TARGET, ms);
      assert.equal(asked[0].options?.maxTimeMS, ms, `the read was not bounded by the ${ms} ms its caller gave`);
    }
  });

  it('a refusal is `{ error }` with the store\'s message and no `records`, never zero hits', async () => {
    const refusal = Object.assign(new Error('Executor error during aggregate command :: caused by :: Index x not initialized'), { code: 8 });
    const answer = await vectorIndex.askIndexOnce(standIn({ fail: refusal }).coll, INDEX, TARGET, 3_000);
    assert.ok(!('records' in answer), `a refusal carries a count: ${JSON.stringify(answer)}`);
    assert.match(String(answer.error), /not initialized/, 'the error names what the store said');
  });
});
