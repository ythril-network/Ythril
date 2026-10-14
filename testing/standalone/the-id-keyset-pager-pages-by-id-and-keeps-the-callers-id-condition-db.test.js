/**
 * The `_id` pager (`db/id-keyset-page.ts`) reads every row of a filter once, in `_id` order, and narrows a caller's own `_id`
 * condition with its cursor instead of replacing it (bundle-113: written twice before it was written once, by the directory
 * delete and by the leaked-rows repair).
 *
 * ## What is held
 *
 *  - pages come back in `_id` order and the last one is the short one, with `end` set; a collection of exactly one page's rows
 *    is ended by an EMPTY second page, which `eachIdPage` does not hand to its callback;
 *  - a filter that conditions `_id` itself (a prefix) keeps that condition once the cursor is added: no row outside the prefix
 *    is returned, and none inside it is skipped or read twice;
 *  - rows the callback of `eachIdPage` deletes do not move the cursor: every row is seen exactly once;
 *  - a size that is not a positive integer is refused, never read as "no limit".
 *
 * Run: node --test testing/standalone/the-id-keyset-pager-pages-by-id-and-keeps-the-callers-id-condition-db.test.js
 * (requires a prior `npm run build` in server/, and the test Mongo)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';

const skip = await mongoSkipReason();
const COLLECTION = 'idpager_rows';

describe('the _id pager', { skip }, () => {
  let mongo, pager;
  before(async () => {
    mongo = await openTestMongo('idpager');
    pager = await import('../../server/dist/db/id-keyset-page.js');
  });
  after(async () => { await closeTestMongo(); });
  beforeEach(async () => {
    await mongo.col(COLLECTION).deleteMany({});
    // Inserted out of order on purpose: the order is the pager's, not the insert's.
    const ids = ['d/e', 'a/1', 'd/a', 'b/1', 'd/c', 'd/b', 'd/d', 'c/1'];
    await mongo.col(COLLECTION).insertMany(ids.map(_id => ({ _id, live: true })));
  });

  const spec = (over = {}) => ({ collection: COLLECTION, filter: {}, projection: { _id: 1 }, size: 3, ...over });
  const idsOf = (rows) => rows.map(r => r._id);

  it('pages in _id order and ends on the short page', async () => {
    const first = await pager.idKeysetPage(spec(), undefined);
    assert.deepEqual(idsOf(first.rows), ['a/1', 'b/1', 'c/1']);
    assert.equal(first.last, 'c/1');
    assert.equal(first.end, false);
    const second = await pager.idKeysetPage(spec(), first.last);
    assert.deepEqual(idsOf(second.rows), ['d/a', 'd/b', 'd/c']);
    const third = await pager.idKeysetPage(spec(), second.last);
    assert.deepEqual(idsOf(third.rows), ['d/d', 'd/e']);
    assert.equal(third.end, true, 'a page shorter than asked for did not say it was the last');
  });

  it('a caller\'s own _id condition survives the cursor', async () => {
    const filter = { _id: { $regex: '^d/' } };
    const seen = [];
    let after;
    for (;;) {
      const page = await pager.idKeysetPage(spec({ filter, size: 2 }), after);
      seen.push(...idsOf(page.rows));
      if (page.end) break;
      after = page.last;
    }
    assert.deepEqual(seen, ['d/a', 'd/b', 'd/c', 'd/d', 'd/e'], 'the cursor replaced the prefix, or skipped a row inside it');
  });

  it('eachIdPage sees every row once, whatever its callback removes, and never an empty page', async () => {
    const seen = []; let calls = 0;
    await pager.eachIdPage(spec({ size: 4 }), async rows => {
      calls++;
      assert.ok(rows.length > 0, 'the callback was handed an empty page');
      seen.push(...idsOf(rows));
      await mongo.col(COLLECTION).deleteMany({ _id: { $in: idsOf(rows) } });
    });
    assert.deepEqual(seen, ['a/1', 'b/1', 'c/1', 'd/a', 'd/b', 'd/c', 'd/d', 'd/e']);
    assert.equal(calls, 2);
  });

  it('a collection of exactly one page ends without handing over a second', async () => {
    let calls = 0;
    await pager.eachIdPage(spec({ size: 8 }), async () => { calls++; });
    assert.equal(calls, 1);
  });

  it('refuses a size that is not a positive integer', async () => {
    for (const size of [0, -1, 1.5, NaN]) {
      await assert.rejects(() => pager.idKeysetPage(spec({ size }), undefined), /size must be a positive integer/);
    }
  });
});
