/**
 * `/query` orders by a caller-chosen field and reports the MATCH TOTAL — against a real MongoDB.
 *
 * ## The ask
 *
 * The fleet integrator, 2026-08-11T1045Z, alongside the `skip` finding: `sort` on `/query`, and an explicit way to fetch everything.
 * #863 honoured `skip` and turned `sort` from silently ignored into an explicit `400` naming it — the right direction, and
 * still not the thing they asked for.
 *
 * ## Why `total` is the more important half
 *
 * `count` on the response is the PAGE length. A caller sweeping with `skip` cannot distinguish a short last page from a
 * truncated one without an extra request that returns nothing — so the total was the number they were computing by hand,
 * which is how it got fabricated in the first place.
 *
 * ## What the sort has to preserve
 *
 * Paging works because the order is TOTAL: `_id` breaks every tie, so no row drifts between pages. A caller-supplied sort
 * that dropped that would re-create the original defect on a different axis, so `toMongoSort` appends `_id` and the
 * assertions below page through a custom order and demand the same tiling property as the default one.
 *
 * And the proxy merge comparator is built FROM the sort handed to MongoDB. The previous version hardcoded the default
 * keys, which was correct only while `/query` had no `sort`: the moment a caller could choose, a proxy space would have
 * merged its members by the old order and returned a page in an order nobody asked for.
 *
 * Run: `npm run test:up` first, then
 *      node --test testing/standalone/query-sort-and-total-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';

const skip = await mongoSkipReason();

const SPACE = 'general';
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-query-sort-'));
const CONFIG_PATH = path.join(tmpDir, 'config.json');
process.env['CONFIG_PATH'] = CONFIG_PATH;

let mongo, query, entities;
const NAMES = ['delta', 'alpha', 'charlie', 'echo', 'bravo'];

describe('query sort and total (real MongoDB)', { skip }, () => {
  before(async () => {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(
      { spaces: [{ id: SPACE, label: 'General' }], networks: [], tokens: [] }, null, 2,
    ));
    mongo = await openTestMongo('querysort');
    const loader = await import('../../server/dist/config/loader.js');
    loader.loadConfig();
    query = await import('../../server/dist/brain/query.js');
    entities = await import('../../server/dist/brain/entities.js');

    await mongo.col(`${SPACE}_entities`).deleteMany({});
    // Insertion order deliberately NOT alphabetical, so a name sort cannot pass by accident on insertion order.
    for (const n of NAMES) await entities.upsertEntity(SPACE, n, 'thing');
  });

  after(async () => {
    await closeTestMongo();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  const q = (opts = {}) => query.queryBrain(
    SPACE, 'entities', opts.filter ?? {}, undefined,
    opts.limit ?? 100, 5000, opts.skip ?? 0, opts.sort,
  );

  it('the fixture is unsorted on purpose', async () => {
    const rows = await q();
    assert.equal(rows.length, NAMES.length);
    const names = rows.map(r => r.name);
    assert.notDeepEqual(names, [...names].sort(), 'the default order must not already be alphabetical');
  });

  it('orders ascending by a chosen field', async () => {
    const rows = await q({ sort: { name: 1, _id: 1 } });
    assert.deepEqual(rows.map(r => r.name), [...NAMES].sort());
  });

  it('orders descending by a chosen field', async () => {
    const rows = await q({ sort: { name: -1, _id: -1 } });
    assert.deepEqual(rows.map(r => r.name), [...NAMES].sort().reverse());
  });

  it('pages through a CUSTOM order without repeats or gaps', async () => {
    // The property that matters: a caller-chosen order must page as reliably as the default, or the fabricated-number
    // defect returns on a different axis.
    const sort = { name: 1, _id: 1 };
    const all = await q({ sort });
    const stitched = [];
    for (let s = 0; s < NAMES.length; s += 2) stitched.push(...await q({ sort, limit: 2, skip: s }));
    assert.deepEqual(stitched.map(r => r.name), all.map(r => r.name));
    assert.equal(new Set(stitched.map(r => r._id)).size, NAMES.length);
  });

  it('compareBySort reproduces the database order for the SAME sort', async () => {
    // The proxy merge depends on this. Asserted for a custom order, because the old hardcoded comparator was correct for
    // the default one and would have silently mis-merged every other.
    for (const sort of [{ name: 1, _id: 1 }, { name: -1, _id: -1 }, query.DEFAULT_QUERY_SORT]) {
      // The default order is by `pos`, which no answer carries (`ORDER_ONLY_FIELDS`), so its rows are read from the collection with it; a cross-space merge holds the
      // same rows with `pos` until it has ordered by it and strips it after (`brain/read-projection.ts`).
      const fromDriver = sort === query.DEFAULT_QUERY_SORT
        ? await mongo.col(`${SPACE}_entities`).find({}).sort({ ...sort }).toArray()
        : await q({ sort });
      const shuffled = [...fromDriver].reverse().sort(query.compareBySort(sort));
      assert.deepEqual(shuffled.map(r => r._id), fromDriver.map(r => r._id),
        `comparator disagreed with the driver for ${JSON.stringify(sort)}`);
    }
  });

  it('compareBySort still puts a record missing the key LAST, in both directions', () => {
    for (const dir of [1, -1]) {
      const sorted = [{ _id: 'a' }, { _id: 'b', name: 'x' }].sort(query.compareBySort({ name: dir }));
      assert.equal(sorted[0]._id, 'b', `dir ${dir}: the record with the field must come first`);
    }
  });

  it('countBrain counts MATCHES, not the page', async () => {
    assert.equal(await query.countBrain(SPACE, 'entities', {}), NAMES.length);
    // The distinction the whole ask is about: a page of 2 out of 5.
    assert.equal((await q({ limit: 2 })).length, 2);
    assert.equal(await query.countBrain(SPACE, 'entities', {}), NAMES.length, 'the total ignores limit and skip');
  });

  it('countBrain honours the filter it is given', async () => {
    assert.equal(await query.countBrain(SPACE, 'entities', { name: 'alpha' }), 1);
    assert.equal(await query.countBrain(SPACE, 'entities', { name: 'nobody' }), 0);
  });

  it('countBrain refuses an unknown collection rather than counting nothing', async () => {
    // Returning 0 for a typo'd collection is a wrong answer that looks like an empty space.
    await assert.rejects(() => query.countBrain(SPACE, 'memoriez', {}));
  });

  it('the default sort is still the documented one', () => {
    // It is now a value rather than an inline literal, so a reordering of these keys would change every page silently.
    // Landing order (bundle-81, decisions 11 and 20): the one constant every Brain list defaults to, `LANDING_ORDER` in `brain/list-sort.ts`.
    assert.deepEqual(query.DEFAULT_QUERY_SORT, { pos: -1, _id: -1 });
    assert.equal(Object.keys(query.DEFAULT_QUERY_SORT).at(-1), '_id',
      '`_id` must be LAST, which is what makes the order total and therefore pageable');
  });
});
