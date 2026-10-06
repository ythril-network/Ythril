/**
 * A manual scan of every space scans every space it can, and names the ones it could not — `Q-381`, bundle-53 G31.
 *
 * ## The defect it prevents
 *
 * `POST /api/duplicates/scan` and `POST /api/contradictions/scan` looped the scanner's `scanSpace` over the target spaces with no
 * `catch` of their own. One space whose scan threw ended the whole request in `sendCaughtFailure`: a `500`, no word of which space,
 * and the spaces behind it never scanned — while the ones before it had been, so the operator could not even tell what the failed
 * request had done. (The background walks stopped doing that in G16; a request has no walk above it, so it was left.)
 *
 * ## What is held, for each of the two routes
 *
 *  - a space whose scan FAILS (a view on its facts that throws on read) is answered, not fatal: `200`, the healthy space behind it
 *    scanned, and `failedSpaces` (`[{ spaceId, reason }]`) naming it with a reason in OUR words — the driver's text names the stage and
 *    the value, and is the log's, said once by the shared reporter (`Dupe scan` / `Contradiction scan`, "retried next scan");
 *  - `failedSpaces` is PRESENT and empty when nothing failed, so a client reads `failedSpaces.length` without a guard;
 *  - a store that is NOT ANSWERING (a timeout) still ends the request: the next space would wait the same timeout, so it is the existing
 *    retryable `503`, and the space behind it is not asked.
 *
 * Both routes are driven as mounted (`duplicatesRouter`, `contradictionsRouter`): the route's own handler, past rate limit and auth.
 *
 * Run: a Mongo the harness accepts (see `_mongo-harness.mjs`), then
 *      node --test testing/standalone/a-failing-space-does-not-end-a-manual-scan-db.test.js
 * (requires a prior `npm run build:server`)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openPushDoor, PEER_TOKEN } from './_push-door.mjs';
import { withCollectionAsView } from './_write-faults.mjs';
import { logLinesDuring } from './_log-lines.mjs';

const skip = await mongoSkipReason();

/** The two routes, as this file asks them. Each has its OWN failing spaces: the reporter's throttle is process-wide. */
const ROUTES = [
  {
    name: 'POST /api/duplicates/scan', step: 'Dupe scan', prefix: 'mdupe',
    router: () => import('../../server/dist/api/duplicates.js').then(m => m.duplicatesRouter),
    cursorId: (space) => `${space}:fact`,
  },
  {
    name: 'POST /api/contradictions/scan', step: 'Contradiction scan', prefix: 'mcontra',
    router: () => import('../../server/dist/api/contradictions.js').then(m => m.contradictionsRouter),
    cursorId: (space) => `${space}:fact:contradiction`,
  },
];
const FAIL = (r) => `${r.prefix}-fail`;
const DOWN = (r) => `${r.prefix}-down`;
/** Last in the config, so a request that stops at the first failure leaves exactly this one unscanned. */
const OK = 'manual-ok';
const ALL = [...ROUTES.flatMap(r => [FAIL(r), DOWN(r)]), OK];

const fact = (space, i) => ({ _id: `${space}-f${i}`, spaceId: space, fact: `fact ${i} of ${space}`, seq: i, createdAt: '2025-01-01T00:00:00.000Z' });

/** What the driver says about the failing view's stage: none of it may reach the answer. */
const DRIVER_WORDS = /parse|convert|toInt|Bad digit|Mongo|\$/i;

describe('a failing space does not end a manual scan of every space', { skip }, () => {
  let door; let proto; let realFind; let StoreTimeout; let DRIVER_REFUSAL_MESSAGE;
  /** The collections whose batch read is armed to fail, and what they fail with. */
  const armed = new Map();

  before(async () => {
    door = await openPushDoor({ suite: 'manualscan', spaces: ALL.map(id => ({ id, label: id, folders: [] })) });
    const available = await door.mongo.checkVectorSearchAvailability();
    assert.equal(available.available, true, 'the harness Mongo has no $vectorSearch: the scanners return before reading anything, so every case below would pass for no reason');
    ({ StoreTimeout } = await import('../../server/dist/db/write-timeout.js'));
    ({ DRIVER_REFUSAL_MESSAGE } = await import('../../server/dist/brain/store-failure.js'));
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

  const cursorOf = async (route, space) => (await door.mongo.col('ythril_dupe_scan_state').findOne({ _id: route.cursorId(space) }))?.cursorSeq ?? null;

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
      it('a space whose scan fails is named with a reason in our words, and the space behind it is scanned', { timeout: 60_000 }, async () => {
        const space = FAIL(route);
        const db = door.mongo.getDb();
        await db.collection(`${space}_facts_src`).insertOne({ _id: 'bad', spaceId: space, seq: 1, f: 'not a number' });
        let outcome;
        try {
          // The stage sits on the SOURCE and the scanner's batch filter on the view: the read throws when the bad document reaches it.
          await withCollectionAsView(db, `${space}_facts`, `${space}_facts_src`, async () => {
            outcome = await logLinesDuring(() => post(route));
          }, { pipeline: [{ $addFields: { _x: { $toInt: '$f' } } }] });
        } finally {
          await db.collection(`${space}_facts_src`).drop().catch(() => {});
        }
        const { res, lines } = { res: outcome.result, lines: outcome.lines };
        assert.equal(res.code, 200, `a space that failed ended the request: ${JSON.stringify(res.body)}`);
        assert.equal(await cursorOf(route, OK), 3, 'the space behind the failing one was not scanned');
        assert.equal(res.body.scanned, 3, `what the request scanned is still reported: ${JSON.stringify(res.body)}`);
        assert.equal(res.body.failedSpaces.length, 1, `one space failed: ${JSON.stringify(res.body)}`);
        const [failed] = res.body.failedSpaces;
        assert.equal(failed.spaceId, space);
        assert.equal(failed.reason, DRIVER_REFUSAL_MESSAGE, 'the reason is the one sentence of ours for a refusal by the database');
        assert.doesNotMatch(JSON.stringify(res.body), DRIVER_WORDS, 'the driver\'s words reached the answer');
        const said = lines.filter(l => l.includes(`${route.step} failed for space '${space}'`));
        assert.equal(said.length, 1, `said once, in the reporter's words: ${lines.join(' | ')}`);
        assert.match(said[0], /— retried next scan$/);
      });

      it('answers failedSpaces, empty, when nothing failed', { timeout: 60_000 }, async () => {
        const res = await post(route);
        assert.equal(res.code, 200, JSON.stringify(res.body));
        assert.deepEqual(res.body.failedSpaces, [], `the field is present on success: ${JSON.stringify(res.body)}`);
        assert.equal(res.body.scanned, 3);
        assert.equal(await cursorOf(route, OK), 3);
      });

      it('a store that is not answering still ends the request, with the retryable 503, and the space behind it is not asked', { timeout: 60_000 }, async () => {
        const space = DOWN(route);
        armed.set(`${space}_facts`, () => new StoreTimeout(`the read of ${space}_facts`));
        let res;
        try {
          ({ result: res } = await logLinesDuring(() => post(route)));
        } finally {
          armed.clear();
        }
        assert.equal(res.code, 503, `a store that does not answer was answered ${res.code}: ${JSON.stringify(res.body)}`);
        assert.equal(res.body.retryable, true);
        assert.ok(res.headers['retry-after'], 'a retryable answer says when to retry');
        assert.equal(await cursorOf(route, OK), null, 'the request went on to the next space instead of ending at the store that is not answering');
      });
    });
  }
});
