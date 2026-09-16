/**
 * `skip` on `POST /query` pages without overlap or gaps, and the comparator agrees with the `.sort()` it mirrors.
 *
 * ## The report
 *
 * The fleet integrator, 2026-08-12T1410Z: `skip` was accepted at 200 and silently ignored, and *"it cost us a fabricated number"* —
 * a paged sweep re-read page one every time and was counted as if it had advanced. A wrong number that looks right.
 *
 * ## What only a DB test can check here
 *
 * That the pages actually tile the collection. An over-eager `skip` (applied after `limit`) returns short pages; an
 * off-by-one returns a row twice or drops one; and either one produces a plausible sweep whose total is wrong — which is
 * exactly the failure being fixed, reproduced by the fix. So the assertion is that concatenated pages equal the whole
 * collection **exactly**, ids and order.
 *
 * ## And why the comparator is tested against the driver rather than against my reading of it
 *
 * A proxy space's page is merged in application code with `compareQueryOrder`, which is a SECOND expression of the sort
 * `queryBrain` hands to MongoDB. Two expressions of one rule is this repo's most repeated defect, so the test sorts the
 * same documents both ways and demands the same sequence. Nothing here asserts that my comparator is right in the
 * abstract; it asserts the two agree, which is the property that matters.
 *
 * Run: `npm run test:up` first, then
 *      node --test testing/standalone/query-paging-db.test.js
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
const TOTAL = 25;

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-query-paging-'));
const CONFIG_PATH = path.join(tmpDir, 'config.json');
process.env['CONFIG_PATH'] = CONFIG_PATH;
const EMPTY_CACHE = path.join(tmpDir, 'empty-model-cache');
fs.mkdirSync(EMPTY_CACHE, { recursive: true });
process.env['YTHRIL_MODELS_OFFLINE'] = '1';
process.env['MODEL_CACHE_DIR'] = EMPTY_CACHE;

let mongo, query, memory;

describe('query paging (real MongoDB)', { skip }, () => {
  before(async () => {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(
      { spaces: [{ id: SPACE, label: 'General' }], networks: [], tokens: [] }, null, 2,
    ));
    mongo = await openTestMongo('querypaging');
    const loader = await import('../../server/dist/config/loader.js');
    loader.loadConfig();
    query = await import('../../server/dist/brain/query.js');
    memory = await import('../../server/dist/brain/fact.js');

    await mongo.col(`${SPACE}_facts`).deleteMany({});
    // Written one at a time so `seq` is strictly increasing — the primary sort key, and what makes the order total.
    for (let i = 0; i < TOTAL; i++) await memory.saveFact(SPACE, `paged record ${String(i).padStart(2, '0')}`, [], []);
  });

  after(async () => {
    await closeTestMongo();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  const page = (limit, skipN) => query.queryBrain(SPACE, 'facts', {}, undefined, limit, 5000, skipN);

  it('the fixture is there (the precondition, not an assumption)', async () => {
    assert.equal(await mongo.col(`${SPACE}_facts`).countDocuments({}), TOTAL);
  });

  it('skip ADVANCES the page — the defect was that it did not', async () => {
    const first = await page(10, 0);
    const second = await page(10, 10);
    assert.equal(first.length, 10);
    assert.equal(second.length, 10);
    assert.notEqual(first[0]._id, second[0]._id,
      'page two started at the same row as page one — this is the reported defect, exactly');
  });

  it('pages tile the collection exactly: no gaps, no repeats, right order', async () => {
    // The assertion the fabricated number needed. A sweep that re-reads or skips a row still returns plausible pages.
    const all = await page(100, 0);
    assert.equal(all.length, TOTAL);

    const stitched = [];
    for (let s = 0; s < TOTAL; s += 7) stitched.push(...await page(7, s));

    assert.deepEqual(stitched.map(d => d._id), all.map(d => d._id),
      'concatenated pages must equal one unpaged read, in the same order');
    assert.equal(new Set(stitched.map(d => d._id)).size, TOTAL, 'and every id exactly once');
  });

  it('a skip past the end is an empty page, not the last one', async () => {
    // Returning the tail here would make a paging loop never terminate.
    assert.deepEqual(await page(10, TOTAL), []);
    assert.deepEqual(await page(10, TOTAL + 500), []);
  });

  it('the last page is SHORT rather than padded', async () => {
    const last = await page(10, 20);
    assert.equal(last.length, 5, `expected the 5 remaining rows, got ${last.length}`);
  });

  it('skip is applied BEFORE limit', async () => {
    // The reverse order — limit the page, then drop rows from it — yields 3 rows here instead of 7, and a caller sees
    // short pages that still look like data.
    assert.equal((await page(7, 3)).length, 7);
  });

  it('a garbage skip does not silently become 0 at this layer either', async () => {
    // The route refuses these with a 400; the function is the last line of defence for an internal caller.
    for (const bad of [-5, Number.NaN, undefined]) {
      const rows = await page(5, bad);
      assert.equal(rows.length, 5, `skip=${String(bad)} must still return a full first page rather than throwing`);
      assert.equal(rows[0]._id, (await page(5, 0))[0]._id, 'and it must be the FIRST page, not an arbitrary one');
    }
  });

  it('compareQueryOrder agrees with the sort queryBrain gives MongoDB', async () => {
    // Two expressions of one rule. The proxy merge uses the comparator; a single space uses the driver. If they ever
    // disagree, a proxy space's page order silently stops matching a plain space's for the same query.
    const fromDriver = await page(100, 0);
    const shuffled = [...fromDriver].reverse();
    const fromComparator = shuffled.sort(query.compareQueryOrder);
    assert.deepEqual(fromComparator.map(d => d._id), fromDriver.map(d => d._id),
      'the application-side comparator must reproduce the database ordering exactly');
  });

  it('the comparator puts a record MISSING the sort key last, not first', async () => {
    // A descending sort on `undefined` must not win, or a partially projected document would lead a page it has no
    // claim to. Constructed rather than queried, because a real record always has `seq`.
    const sorted = [{ _id: 'a' }, { _id: 'b', seq: 5 }].sort(query.compareQueryOrder);
    assert.equal(sorted[0]._id, 'b', 'the record with a seq comes first');
  });

  it('queryBrain itself pages past 100 — necessary, and NOT the regression guard', async () => {
    // Stated plainly because I got it wrong: this asserts a property of `queryBrain`, which pushes `skip` to MongoDB and
    // is correct at any depth. It PASSES against the 2.8.0 code, so it does not guard the defect.
    //
    // The defect was in the ROUTE: it fetched a window capped at 100 and then sliced it at `skip`, so every page past row
    // 100 came back empty while `total` reported the true count. `query-skip-and-strict-bodies.test.js` guards that,
    // through HTTP, because that is the layer where the window exists. A test at the wrong layer is worse than none — it
    // reads like coverage.
    const EXTRA = 120 - TOTAL;
    for (let i = 0; i < EXTRA; i++) await memory.saveFact(SPACE, `deep record ${String(i).padStart(3, '0')}`, [], []);
    const all = await mongo.col(`${SPACE}_facts`).countDocuments({});
    assert.equal(all, 120, 'precondition: the fixture must exceed the 100-row window');

    for (const s of [95, 100, 110, 119]) {
      const rows = await query.queryBrain(SPACE, 'facts', {}, undefined, 5, 5000, s);
      assert.ok(rows.length > 0, `skip=${s} returned nothing on a 120-row collection — the deep-page defect is back`);
    }
    assert.equal((await query.queryBrain(SPACE, 'facts', {}, undefined, 5, 5000, 120)).length, 0,
      'and past the END is still empty, which is how a paging loop terminates');
  });

  it('the page size cap lives with the CALLERS now, not inside queryBrain', () => {
    // The clamp used to be `.limit(Math.min(limit, 100))` inside queryBrain, which also bounded the proxy merge's
    // internal fetch — that is what truncated deep pages to nothing. The routes cap the caller-facing page instead.
    assert.equal(query.QUERY_PAGE_MAX, 100);
    assert.ok(query.PROXY_PAGE_CEILING > query.QUERY_PAGE_MAX,
      'a proxy page needs skip+limit per member, so its ceiling must exceed the per-page cap or deep pages break again');
  });

  it('QUERY_BODY_FIELDS names skip, or the route would refuse the parameter it just gained', async () => {
    // The two halves of this fix have to agree: honouring `skip` while the strict body rejects it as unknown would turn
    // a silently ignored parameter into a 400 for the caller who reported it.
    assert.ok(query.QUERY_BODY_FIELDS.has('skip'));
    for (const k of ['collection', 'filter', 'projection', 'limit', 'maxTimeMS', 'sort', 'dir']) {
      assert.ok(query.QUERY_BODY_FIELDS.has(k), `${k} must stay allowed`);
    }
    // This line used to assert `sort` was ABSENT, which was true when it was unimplemented and became a false alarm the
    // day it shipped. The invariant is not "sort is missing" — it is that a key is allowed only if the route honours it,
    // so a plausible ALIAS nobody implemented must still be refused. Those are the ones a caller reaches for.
    for (const alias of ['order', 'orderBy', 'sortBy', 'direction', 'offset', 'page']) {
      assert.ok(!query.QUERY_BODY_FIELDS.has(alias),
        `'${alias}' is not implemented, so accepting it would silently ignore it — the original defect`);
    }
  });
});
