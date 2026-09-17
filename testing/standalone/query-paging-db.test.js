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
import fs, { readFileSync } from 'node:fs';
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

    /*
     * AND ONE PAGE NOW HOLDS ALL 120, which is the whole of the `limit` change asserted against real
     * rows rather than against a constant. Under the old clamp this returned 100 — a short page that
     * `truncated` made look correct, on the read a fleet pages through.
     */
    const wholeCollection = await query.queryBrain(SPACE, 'facts', {}, undefined, 120, 5000, 0);
    assert.equal(wholeCollection.length, 120,
      `a 120-row page came back with ${wholeCollection.length} rows — the caller's \`limit\` is being clamped`);
  });

  it('`limit` is a DEFAULT on both doors, not a clamp on either', async () => {
    /*
     * Owner, 2026-09-17: *"cap should be a parameter and default to 200"*.
     *
     * It was a hard clamp of 100, applied silently — and `filter` is replacing the nine per-collection
     * list routes, which cap at 200 (`edges`, `files`) and 500 (`facts`, `entities`, `chrono`). So the
     * replacement returned LESS than every door it replaces, and `total`/`truncated` made a clamped page
     * read as a correct short one. That is the shape this asserts against: not a number, but that
     * neither door silently reduces what was asked for.
     *
     * Read out of the built tool and the route source rather than restated, so the two cannot default
     * differently — which is the parity defect one door's number would otherwise hide.
     */
    const { DEFAULT_QUERY_LIMIT } = query;
    assert.equal(typeof DEFAULT_QUERY_LIMIT, 'number');
    assert.ok(DEFAULT_QUERY_LIMIT >= 200,
      `the default page is ${DEFAULT_QUERY_LIMIT}, below the 200 the list routes it replaces serve`);
    assert.ok(query.PROXY_PAGE_CEILING > DEFAULT_QUERY_LIMIT,
      'a proxy page needs skip+limit per member, so its ceiling must exceed the default or deep pages break');

    const { ALL_TOOLS } = await import('../../server/dist/mcp/tools/index.js');
    const tool = ALL_TOOLS.find(t => t.name === 'filter');
    assert.ok(tool, 'the `filter` tool is gone or renamed — re-anchor this');
    const limitProp = tool.inputSchema({ requiredSpace: {}, optionalSpace: {} }).properties?.limit;
    assert.equal(limitProp?.default, DEFAULT_QUERY_LIMIT,
      'the tool and the resolver disagree about the default page size');
    /*
     * NO `maximum`, and this is the half that would bite hardest. The MCP dispatcher enforces the schema
     * BEFORE the handler runs, so a `maximum` here refuses a page the REST door serves — a 400 on one
     * door and an answer on the other, which is worse than either alone.
     */
    assert.equal(limitProp?.maximum, undefined,
      'a `maximum` on the tool refuses a page REST serves; the bound belongs to the byte budget');

    // And neither door may quietly reduce it. `Math.min(..., SOMETHING)` on the limit is the clamp
    // coming back, whatever the constant is called.
    for (const door of ['server/src/mcp/tools/search.ts', 'server/src/api/brain/search.ts']) {
      const text = readFileSync(new URL(`../../${door}`, import.meta.url), 'utf8');
      assert.ok(!/(?:const\s+(?:safeLimit|limit)\s*=\s*)Math\.min\(/.test(text),
        `${door} clamps the caller's \`limit\` again — a page smaller than asked for, with no way to tell`);
    }
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
