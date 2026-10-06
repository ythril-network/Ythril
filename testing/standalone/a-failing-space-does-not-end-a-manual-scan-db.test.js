/**
 * A manual scan of every space scans every space it can, and names the ones it could not (`Q-381`, the 5.6.6 patch).
 *
 * ## The defect it prevents
 *
 * `POST /api/duplicates/scan` and `POST /api/contradictions/scan` looped the scanner's `scanSpace` over the target spaces with no `catch`
 * of their own. One space whose scan threw ended the whole request in the route's catch: a `500 Internal error`, no word of which space,
 * and the spaces behind it never scanned — while the ones before it had been, so the operator could not tell what the failed request had
 * done.
 *
 * ## What is held, for each of the two routes
 *
 *  - a space whose scan FAILS is answered, not fatal: `200`, the healthy space behind it scanned, and `failedSpaces`
 *    (`[{ spaceId, reason }]`) naming it with a reason in OUR words (`caughtFailureText`: our own error as it is, the database
 *    driver's failure as one sentence of ours — never the driver's text, which names hosts and collections);
 *  - the failure is said once in the server log, naming the space;
 *  - `failedSpaces` is PRESENT and empty when nothing failed, so a client reads `failedSpaces.length` without a guard.
 *
 * Both routes are driven as mounted (`duplicatesRouter`, `contradictionsRouter`): the route's own handler, past rate limit and auth.
 *
 * Run: a Mongo the harness accepts (see `_mongo-harness.mjs`), then
 *      node --test testing/standalone/a-failing-space-does-not-end-a-manual-scan-db.test.js
 * (requires a prior `npm run build:server`)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { MongoNetworkError } from 'mongodb';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openPushDoor, PEER_TOKEN } from './_push-door.mjs';
import { logLinesDuring } from './_log-lines.mjs';

const skip = await mongoSkipReason();

/** The two routes, as this file asks them. Each has its OWN failing spaces. */
const ROUTES = [
  {
    name: 'POST /api/duplicates/scan', step: 'Dupe scan', prefix: 'mdupe',
    router: () => import('../../server/dist/api/duplicates.js').then(m => m.duplicatesRouter),
  },
  {
    name: 'POST /api/contradictions/scan', step: 'Contradiction scan', prefix: 'mcontra',
    router: () => import('../../server/dist/api/contradictions.js').then(m => m.contradictionsRouter),
  },
];
const FAIL = (r) => `${r.prefix}-fail`;
const DOWN = (r) => `${r.prefix}-down`;
/** Last in the config, so a request that stops at the first failure leaves exactly this one unscanned. */
const OK = 'manual-ok';
const ALL = [...ROUTES.flatMap(r => [FAIL(r), DOWN(r)]), OK];

const fact = (space, i) => ({ _id: `${space}-f${i}`, spaceId: space, fact: `fact ${i} of ${space}`, seq: i, createdAt: '2025-01-01T00:00:00.000Z' });

/** What the driver says about the failing read: none of it may reach the answer. */
const DRIVER_WORDS = /ECONNREFUSED|10\.1\.2\.3|27017|MongoNetworkError/i;

describe('a failing space does not end a manual scan of every space', { skip }, () => {
  let door; let proto; let realFind;
  /** The collections whose batch read is armed to fail, and what they fail with. */
  const armed = new Map();

  before(async () => {
    door = await openPushDoor({ suite: 'manualscan', spaces: ALL.map(id => ({ id, label: id, folders: [] })) });
    const available = await door.mongo.checkVectorSearchAvailability();
    assert.equal(available.available, true, 'the harness Mongo has no $vectorSearch: the scanners return before reading anything, so every case below would pass for no reason');
    const { bumpSeq } = await import('../../server/dist/util/seq.js');
    for (const space of ALL) await bumpSeq(space, 20);
    proto = Object.getPrototypeOf(door.mongo.col('probe'));
    realFind = proto.find;
    proto.find = function armedFind(...args) {
      const make = armed.get(this.collectionName);
      if (!make) return realFind.apply(this, args);
      // The scanners' batch read is `find(...).sort(...).limit(...).toArray()`: a cursor whose end fails.
      const failing = { sort: () => failing, limit: () => failing, toArray: () => Promise.reject(make()) };
      return failing;
    };
  });
  after(async () => {
    if (proto && realFind) proto.find = realFind;
    await door?.close();
  });
  beforeEach(async () => {
    armed.clear();
    await door.mongo.col('ythril_dupe_scan_state').deleteMany({});
    await door.coll(OK, 'facts').deleteMany({});
    await door.coll(OK, 'facts').insertMany([1, 2, 3].map(i => fact(OK, i)));
  });

  /** The route's own handler, past rate limit and auth, as a token that may scan every space reaches it. */
  async function post(route, query = {}) {
    const router = await route.router();
    const layer = router.stack.find(l => l.route?.path === '/scan' && l.route.methods.post);
    assert.ok(layer, `no POST /scan on the ${route.name} router`);
    const req = { method: 'POST', path: '/scan', query, params: {}, body: {}, authToken: PEER_TOKEN, get: () => undefined, headers: {} };
    const res = {
      code: 200, body: undefined, sent: false, headers: {}, headersSent: false,
      status(c) { this.code = c; return this; },
      setHeader(name, value) { this.headers[name.toLowerCase()] = value; return this; },
      json(b) { this.body = b; this.sent = true; this.headersSent = true; return this; },
    };
    await layer.route.stack.at(-1).handle(req, res);
    assert.ok(res.sent, `${route.name} settled without answering`);
    return res;
  }

  for (const route of ROUTES) {
    describe(route.name, () => {
      it('a space whose scan fails is named with a reason, and the space behind it is scanned', { timeout: 60_000 }, async () => {
        const space = FAIL(route);
        armed.set(`${space}_facts`, () => new Error('the facts of this space cannot be read'));
        const { result: res, lines } = await logLinesDuring(() => post(route));
        assert.equal(res.code, 200, `a space that failed ended the request: ${JSON.stringify(res.body)}`);
        assert.equal(res.body.scanned, 3, `the space behind the failing one was not scanned: ${JSON.stringify(res.body)}`);
        const mine = res.body.failedSpaces.filter(f => f.spaceId === space);
        assert.equal(mine.length, 1, `the failed space is not named once: ${JSON.stringify(res.body)}`);
        assert.equal(typeof mine[0].reason, 'string');
        assert.ok(mine[0].reason.length > 0, 'a failed space says why');
        const said = lines.filter(l => l.includes(`'${space}'`) && /scan/i.test(l));
        assert.equal(said.length, 1, `the failed space is said ${said.length} time(s) in the log: ${lines.join(' | ')}`);
      });

      it('a space the database driver failed on is named in our words, never the driver\'s', { timeout: 60_000 }, async () => {
        const space = DOWN(route);
        armed.set(`${space}_facts`, () => new MongoNetworkError('connect ECONNREFUSED 10.1.2.3:27017'));
        const { result: res, lines } = await logLinesDuring(() => post(route));
        assert.equal(res.code, 200, `a space that failed ended the request: ${JSON.stringify(res.body)}`);
        assert.equal(res.body.scanned, 3, `the space behind the failing one was not scanned: ${JSON.stringify(res.body)}`);
        const [failed] = res.body.failedSpaces.filter(f => f.spaceId === space);
        assert.ok(failed, `the failed space is not named: ${JSON.stringify(res.body)}`);
        assert.doesNotMatch(JSON.stringify(res.body), DRIVER_WORDS, 'the driver\'s words reached the answer');
        assert.ok(lines.some(l => DRIVER_WORDS.test(l)), 'the driver\'s text is in the log, where an operator reads it');
      });

      it('answers failedSpaces, empty, when nothing failed', { timeout: 60_000 }, async () => {
        const res = await post(route);
        assert.equal(res.code, 200, JSON.stringify(res.body));
        assert.deepEqual(res.body.failedSpaces, [], `the field is present on success: ${JSON.stringify(res.body)}`);
        assert.equal(res.body.scanned, 3);
      });

      it('scannedSpaces counts the spaces scanned, so it is the number asked less the ones that failed', { timeout: 60_000 }, async () => {
        armed.set(`${FAIL(route)}_facts`, () => new Error('the facts of this space cannot be read'));
        const failed = (await post(route)).body;
        armed.clear();
        const clean = (await post(route)).body;
        assert.equal(failed.scannedSpaces, clean.scannedSpaces - 1, `${JSON.stringify(failed)} against ${JSON.stringify(clean)}`);
      });
    });
  }
});
