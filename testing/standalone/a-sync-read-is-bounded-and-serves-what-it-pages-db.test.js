/**
 * A sync read route is bounded by what it is asked, refuses a start it cannot read, and serves the same
 * fields by id as it serves by page (`Q-388`).
 *
 * ## The defects
 *
 * - `limit` was `Math.min(parseInt(limit, 10) || 100, 500)`. A NEGATIVE value passes both halves, and
 *   `.limit(-1 + 1)` is `.limit(0)`, which Mongo reads as NO limit: any token that reaches the space got the
 *   whole collection in one response, built in memory. The tombstone route had the same parse.
 * - `sinceSeq=abc` became `NaN`, so the range `{ $gt: NaN }` matched nothing and the page came back empty with
 *   `nextCursor: null` — which every client reads as "nothing left". A malformed `cursor` read as 0 and
 *   silently restarted the read from the beginning.
 * - The by-id reads (`/facts/:id` and five more) returned the stored document whole, so the fields a page
 *   never serves (the vector, the matched text, the retention stamps) left by id, and a file CHUNK — which the
 *   page excludes — was readable by id.
 *
 * ## The rules, over every family route (derived from `REPLICATED_FAMILIES`, floor 6) and the tombstone route
 *
 * 1. A `limit` below 1 serves one row, never every row; a garbage `limit` serves the default page.
 * 2. A start that is not a non-negative integer — `sinceSeq` or a `cursor` that does not decode to one — is a
 *    `400`, with one text everywhere, that does not repeat the value.
 * 3. A record read by id carries exactly the fields the page would carry, and a record the page would never
 *    serve is not found by id.
 * 4. Every route-level `limit` in `server/src` is read through `parseLimit`, the module every list route uses.
 *
 * Run: node --test testing/standalone/a-sync-read-is-bounded-and-serves-what-it-pages-db.test.js
 * (requires a prior `npm run build` in server/, and the test Mongo)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';
import { readTrackedSources } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';

const skip = await mongoSkipReason();

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-sync-read-bounds-'));
process.env['CONFIG_PATH'] = path.join(tmpDir, 'config.json');

const SPACE = 'bounds';
const AUTH = { rights: { perSpace: {}, spaceAdmin: { floor: true, spaces: [] } } }; // reaches every space
/** Three records per collection, so "one row" and "every row" are told apart. */
const SEEDED = 3;
/** Fields only the stored copy has: each must be absent from every answer, paged or by id. */
const LOCAL_ONLY = { embedding: [0.1, 0.2], embeddingModel: 'm', matchedText: 'secret text', _expireAt: new Date(), _contentExpireAt: new Date() };

let mongo, families, localOnly, docsRouter, tombstonesRouter;

/** Invoke a route's own handler in-process, past rate-limit and auth middleware the test does not exercise. */
async function call(router, routePath, query = {}, params = {}) {
  const layer = router.stack.find(l => l.route?.path === routePath && l.route.methods.get);
  assert.ok(layer, `no GET ${routePath}`);
  const handler = layer.route.stack.at(-1).handle;
  const res = { code: 200, body: undefined, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
  await handler({ query: { spaceId: SPACE, full: 'true', ...query }, params, authToken: AUTH, get: () => undefined }, res);
  return res;
}

const b64 = (s) => Buffer.from(s).toString('base64url');
/** The records of a page, without the tombstones that ride along with them (`deletedAt` stubs). */
const recordsOf = (body) => body.items.filter(d => d.deletedAt === undefined);
/** Starts that are not a non-negative integer, as each parameter would carry them. */
const BAD_SINCE = ['abc', '-5', '1.5', '1e400', ''];
const BAD_CURSOR = ['!!!', b64('abc'), b64('-3'), b64('2.5')];

describe('a sync read is bounded and serves what it pages', { skip }, () => {
  before(async () => {
    mongo = await openTestMongo('syncreadbounds');
    fs.writeFileSync(process.env['CONFIG_PATH'], JSON.stringify({
      instanceId: 'sync-read-bounds', instanceLabel: 'test', tokens: [], networks: [],
      spaces: [{ id: SPACE, label: 'Bounds', folders: [], meta: {} }],
    }, null, 2), { mode: 0o600 });
    (await import('../../server/dist/config/loader.js')).loadConfig();
    ({ REPLICATED_FAMILIES: families } = await import('../../server/dist/sync/replicated-families.js'));
    ({ LOCAL_ONLY_FIELDS: localOnly } = await import('../../server/dist/sync/local-only-fields.js'));
    ({ syncDocsRouter: docsRouter } = await import('../../server/dist/api/sync/docs.js'));
    ({ syncTombstonesRouter: tombstonesRouter } = await import('../../server/dist/api/sync/tombstones.js'));

    // Seeded directly, BEFORE the first read, so the seq horizon (seeded from the highest stored seq) covers them.
    for (const f of families) {
      const docs = [];
      for (let i = 1; i <= SEEDED; i++) docs.push({ _id: `${f.collection}-${i}`, spaceId: SPACE, seq: i, tags: [], ...LOCAL_ONLY });
      // A chunk: a file record the page never serves (it has a parent), so it must not be served by id either.
      if (f.pushFilter) docs.push({ _id: `${f.collection}-chunk`, spaceId: SPACE, seq: SEEDED + 1, parentFileId: `${f.collection}-1`, ...LOCAL_ONLY });
      await mongo.col(`${SPACE}_${f.collection}`).insertMany(docs);
    }
    await mongo.col(`${SPACE}_tombstones`).insertMany([1, 2, 3].map(i => ({
      _id: `fact-gone-${i}`, type: 'fact', spaceId: SPACE, seq: i, deletedAt: new Date().toISOString(), instanceId: 'x',
    })));
  });

  after(async () => {
    await closeTestMongo();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it('derives the family routes, so an empty set cannot pass', () => {
    assert.ok(families.length >= 6, `only ${families.length} replicated families`);
  });

  it('a limit below 1 serves one row on every family route, never every row', async () => {
    for (const f of families) {
      for (const limit of ['-1', '0', '-500']) {
        const res = await call(docsRouter, `/${f.payloadKey}`, { limit });
        assert.equal(res.code, 200, `${f.payloadKey} limit=${limit}: ${JSON.stringify(res.body)}`);
        assert.deepEqual(recordsOf(res.body).map(d => d._id), [`${f.collection}-1`],
          `${f.payloadKey} limit=${limit} served ${recordsOf(res.body).length} records`);
        assert.ok(res.body.nextCursor, `${f.payloadKey} limit=${limit}: a one-row page of three must say there is more`);
      }
      const garbage = await call(docsRouter, `/${f.payloadKey}`, { limit: 'lots' });
      assert.equal(garbage.code, 200);
      assert.equal(recordsOf(garbage.body).length, SEEDED, `${f.payloadKey}: a garbage limit serves the default page`);
    }
  });

  it('a limit below 1 serves one tombstone per kind, never every tombstone', async () => {
    const res = await call(tombstonesRouter, '/tombstones', { limit: '-1' });
    assert.equal(res.code, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body.facts.map(t => t._id), ['fact-gone-1']);
  });

  it('a start that is not a non-negative integer is a 400 that does not repeat it, on every route', async () => {
    const routes = [...families.map(f => [docsRouter, `/${f.payloadKey}`]), [tombstonesRouter, '/tombstones']];
    const texts = new Set();
    for (const [router, route] of routes) {
      for (const sinceSeq of BAD_SINCE) {
        const res = await call(router, route, { sinceSeq });
        assert.equal(res.code, 400, `${route} sinceSeq=${JSON.stringify(sinceSeq)} answered ${res.code} ${JSON.stringify(res.body)}`);
        assert.ok(!sinceSeq || !JSON.stringify(res.body).includes(sinceSeq), `${route}: the refusal repeats the value`);
        texts.add(res.body.error);
      }
    }
    for (const f of families) {
      for (const cursor of BAD_CURSOR) {
        const res = await call(docsRouter, `/${f.payloadKey}`, { cursor });
        assert.equal(res.code, 400, `/${f.payloadKey} cursor=${cursor} answered ${res.code} ${JSON.stringify(res.body)}`);
        assert.ok(!JSON.stringify(res.body).includes(cursor), `/${f.payloadKey}: the refusal repeats the cursor`);
        texts.add(res.body.error);
      }
    }
    assert.equal(texts.size, 1, `one refusal text everywhere, got: ${[...texts].join(' | ')}`);
  });

  it('a well-formed start still pages: the cursor a page hands back reads the next page', async () => {
    for (const f of families) {
      const first = await call(docsRouter, `/${f.payloadKey}`, { limit: '1' });
      const second = await call(docsRouter, `/${f.payloadKey}`, { limit: '1', cursor: first.body.nextCursor });
      assert.equal(second.code, 200, JSON.stringify(second.body));
      assert.deepEqual(recordsOf(second.body).map(d => d._id), [`${f.collection}-2`]);
    }
  });

  it('a record read by id carries no field the page withholds', async () => {
    assert.ok(localOnly.size >= 5, `only ${localOnly.size} local-only fields — the derivation is broken`);
    for (const f of families) {
      const paged = await call(docsRouter, `/${f.payloadKey}`, {});
      const byId = await call(docsRouter, `/${f.payloadKey}/:id`, {}, { id: `${f.collection}-1` });
      assert.equal(byId.code, 200, `/${f.payloadKey}/:id ${JSON.stringify(byId.body)}`);
      for (const field of localOnly) {
        assert.ok(!(field in recordsOf(paged.body)[0]), `/${f.payloadKey} page carries ${field}`);
        assert.ok(!(field in byId.body), `/${f.payloadKey}/:id carries ${field}, which the page withholds`);
      }
    }
  });

  it('a record the page never serves is not found by id', async () => {
    const chunked = families.filter(f => f.pushFilter);
    assert.ok(chunked.length >= 1, 'no family with its own filter — the derivation is broken');
    for (const f of chunked) {
      const res = await call(docsRouter, `/${f.payloadKey}/:id`, {}, { id: `${f.collection}-chunk` });
      assert.equal(res.code, 404, `/${f.payloadKey}/:id served a ${f.collection} record its page excludes`);
    }
  });
});

describe('no limit falls through a falsy default', () => {
  /*
   * The shape of the defect, not every hand-written parse: `parseInt(limit) || 100` sends 0 and NaN to the
   * default and lets every NEGATIVE number through, and a negative limit is what read a whole collection. A
   * parse that refuses or clamps below 1 (the vote and change-note doors, the embed-job list) answers a
   * different question and is not this.
   */
  it('no source reads a limit as `parse(x) || default`', () => {
    const offenders = [];
    for (const { file, text } of readTrackedSources('server/src', { ext: ['.ts'], floor: 100 })) {
      const src = stripComments(text);
      for (const m of src.matchAll(/(?:parseInt|Number)\([^)]*\blimit\b[^)]*\)\s*\|\|/gi)) offenders.push(`${file}: ${m[0]}`);
    }
    assert.deepEqual(offenders, [],
      'a falsy default lets a negative limit through, and `limit=-1` read a whole collection; use parseLimit (util/pagination.ts)');
  });

  /*
   * The start's twin: a route that parses `sinceSeq` itself turns `abc` into NaN, an empty page and a
   * `nextCursor: null` that reads as "nothing left". Every sync start goes through `syncReadStart`, so a new
   * route cannot quietly bring the silent default back.
   */
  it('no source reads a sync start by hand', () => {
    const offenders = [];
    for (const { file, text } of readTrackedSources('server/src', { ext: ['.ts'], floor: 100 })) {
      const src = stripComments(text);
      for (const m of src.matchAll(/(?:parseInt|Number|parseFloat)\([^)]*\bsinceSeq\b[^)]*\)/g)) offenders.push(`${file}: ${m[0]}`);
    }
    assert.deepEqual(offenders, [], 'read a sync start with syncReadStart (api/sync/_shared.ts), which refuses what it cannot read');
  });
});
