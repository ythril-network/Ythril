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
 *  - a size that is not a positive integer is refused, never read as "no limit";
 *  - a caller's `maxTimeMS` (Q-481, design rev 4 item 1) is a server deadline PER PAGE for a read outside any bound scope: it reaches
 *    the `find` command as given, a value that is not a positive integer is refused, and inside a scope (housekeeping or hold) it is
 *    refused, because there a caller's `maxTimeMS` keeps the lower figure and takes no driver `timeoutMS`
 *    (`a-housekeeping-op-carries-its-bound`), so a read against a store that stopped answering would be bounded by the server alone.
 *    What reaches the server is read off the driver's own command events (`monitorCommands`), not off the pager's arguments.
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
  let mongo, pager, wb;
  /** Every `find` the server's client sent on the pager's collection, as the driver handed it over. */
  const finds = [];
  before(async () => {
    mongo = await openTestMongo('idpager', { query: '&monitorCommands=true' });
    mongo.getMongo().on('commandStarted', (ev) => {
      if (ev.commandName === 'find' && ev.command?.find === COLLECTION) finds.push(ev.command);
    });
    pager = await import('../../server/dist/db/id-keyset-page.js');
    wb = await import('../../server/dist/db/write-bound.js');
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

  describe('a caller\'s maxTimeMS (Q-481 item 1)', () => {
    it('outside any scope it reaches every page\'s find as given, and a spec without one sends none', async () => {
      finds.length = 0;
      await pager.eachIdPage(spec({ maxTimeMS: 750 }), async () => {});
      assert.ok(finds.length >= 2, `the walk sent ${finds.length} find(s) on ${COLLECTION}: the command monitor sees nothing, so this case proves nothing`);
      assert.deepEqual(finds.map(c => c.maxTimeMS), finds.map(() => 750),
        'a maxTimeMS the caller set did not reach the server on every page: the read is bounded by nothing it asked for');
      finds.length = 0;
      await pager.idKeysetPage(spec(), undefined);
      assert.equal(finds.length, 1);
      assert.equal('maxTimeMS' in finds[0], false, 'a spec without maxTimeMS sent one anyway');
    });

    it('refuses a maxTimeMS that is not a positive integer, before reading', async () => {
      for (const maxTimeMS of [0, -1, 1.5, NaN, Infinity, '500']) {
        finds.length = 0;
        await assert.rejects(() => pager.idKeysetPage(spec({ maxTimeMS }), undefined), /maxTimeMS/,
          `maxTimeMS ${String(maxTimeMS)} was not refused`);
        assert.equal(finds.length, 0, `maxTimeMS ${String(maxTimeMS)} was refused only after a read was sent`);
      }
    });

    it('refuses a maxTimeMS inside a bound scope, housekeeping or hold, before reading', async () => {
      const scopes = {
        housekeeping: (fn) => wb.withinHousekeepingBound(fn, { opMs: 5000 }),
        hold: (fn) => wb.withinWriteBound(fn),
      };
      for (const [name, within] of Object.entries(scopes)) {
        finds.length = 0;
        await assert.rejects(() => within(() => pager.idKeysetPage(spec({ maxTimeMS: 750 }), undefined)), /maxTimeMS/,
          `inside a ${name} scope a caller's maxTimeMS was taken: it keeps the lower figure and gets no driver timeoutMS, so a read `
          + 'against a store that stopped answering is bounded by the server alone');
        assert.equal(finds.length, 0, `inside a ${name} scope the maxTimeMS was refused only after a read was sent`);
        // The same page without one is the scope's to bound, and is read.
        await within(() => pager.idKeysetPage(spec(), undefined));
      }
    });
  });
});
