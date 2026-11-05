/**
 * `POST /api/duplicates/scan` and `POST /api/contradictions/scan` say which types an index held, and a held scan is never a clean answer
 * (Q-697, b235 design v3 item 12; integration S3, testing S8).
 *
 * ## The defect
 *
 * A scan that held (a type whose neighbour search ran over an index that was not ready: its position kept, its records to be read again)
 * answered like one that finished: `200`, `scanned`, `found`, no field for the hold. The Review tab's scan button reads that answer, and
 * "0 found" over a held scan reads as "nothing disagrees" - the conflation `nliStalled` was added to stop for a judge that was down,
 * and `contradictions.ts` says outright that no incomplete scan may read as a clean one.
 *
 * ## The rule
 *
 * Both scan responses carry `indexHeld: [{ spaceId, type, pass? }]`:
 *
 *  - present on EVERY answer, an empty list when nothing held (a client reads `indexHeld.length` without a guard, as it reads
 *    `failedSpaces.length`), and the held types otherwise, one entry per type that held in a space the scan covered. `pass` names the
 *    contradiction cursor that held (`structured` or `nli`); the duplicate scanner has one cursor per type and names none;
 *  - built AFTER the token-reach intersection, from the spaces the token may scan: a token that cannot scan a space is not told that
 *    space's index is not ready (the same list would otherwise name every space of the instance to a caller that may not see them);
 *  - both routes are driven as mounted (`duplicatesRouter`, `contradictionsRouter`): the route's own handler, past rate limit and auth.
 *
 * ## How it is observed
 *
 * The held space has aged, vectored facts and its search is refused with the store's own not-ready wording (`_mongot-refusals.mjs`),
 * which holds the type for certain; the healthy space has a real, serving index over aged facts, which does not hold.
 *
 * "Seen red" on the base: the field is absent from both answers.
 *
 * Needs a MongoDB with mongot (atlas-local): `npm run test:up`.
 *
 * Run: node --test testing/standalone/a-scan-response-says-which-types-an-index-held-db.test.js
 * (requires a prior `npm run build:server`)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openPushDoor, PEER_TOKEN } from './_push-door.mjs';
import { unitAt, startStubEmbedder, queryAxis, waitUntilServing } from './_vector-harness.mjs';
import { REFUSALS, refuseVectorSearch } from './_mongot-refusals.mjs';
import { spaceAdminRights } from '../_shared/space-admin-rights.mjs';

const skip = await mongoSkipReason();

const DIMS = 8;
process.env['EMBEDDING_DIMENSIONS'] = String(DIMS);
process.env['YTHRIL_HYBRID_SEARCH'] = 'off';
delete process.env['NLI_URL'];   // the contradiction scanner runs its structured pass: `pass: 'structured'` is then the one cursor per type

const HELD = 'ihold-held';
const HEALTHY = 'ihold-healthy';
const SPACES = [HELD, HEALTHY];
const OLD = new Date(Date.now() - 3_600_000).toISOString();
const fact = (space, i) => ({
  _id: `${space}-f${i}`, spaceId: space, fact: `fact ${i} of ${space}`, tags: [], embedding: unitAt(10 * (i + 1), DIMS), embeddingModel: 'stub',
  seq: i, pos: i, posAtSeq: i, createdAt: OLD, updatedAt: OLD,
});

/** The two routes, as this file asks them. */
const ROUTES = [
  {
    name: 'POST /api/duplicates/scan', router: () => import('../../server/dist/api/duplicates.js').then(m => m.duplicatesRouter),
    expected: (spaceId) => [{ spaceId, type: 'fact' }], wantsPass: false,
  },
  {
    name: 'POST /api/contradictions/scan', router: () => import('../../server/dist/api/contradictions.js').then(m => m.contradictionsRouter),
    expected: (spaceId) => [{ spaceId, type: 'fact' }], wantsPass: true,
  },
];

describe('a scan answer says which types an index held', { skip }, () => {
  let door; let stub;

  before(async () => {
    stub = await startStubEmbedder(() => queryAxis(DIMS));
    door = await openPushDoor({ suite: 'indexheld', spaces: SPACES.map(id => ({ id, label: id, folders: [] })) });
    const available = await door.mongo.checkVectorSearchAvailability();
    assert.equal(available.available, true, 'the harness Mongo has no $vectorSearch: the scanners return before reading anything, so every case below would pass for no reason');
    const { raiseVersionTo } = await import('../../server/dist/util/version-stamp.js');
    const vectorIndex = await import('../../server/dist/spaces/vector-index.js');
    for (const space of SPACES) await raiseVersionTo(space, 20);
    await door.coll(HELD, 'facts').insertMany([1, 2, 3].map(i => fact(HELD, i)));
    await door.coll(HEALTHY, 'facts').insertMany([1, 2].map(i => fact(HEALTHY, i)));
    // Production's own builder: the healthy space's index is real and serves, so nothing in it can hold.
    await vectorIndex.ensureVectorSearchIndex(HEALTHY, 'facts', DIMS, 'cosine', 'embedding', 'embedding', true, []);
    await waitUntilServing(door.mongo, `${HEALTHY}_facts`, `${HEALTHY}_facts_embedding`, { dims: DIMS, n: 2 });
  });
  after(async () => {
    await door?.close();
    await stub?.close();
  });
  beforeEach(async () => { await door.mongo.col('ythril_dupe_scan_state').deleteMany({}); });

  /** The route's own handler, past rate limit and auth, as `token` reaches it (the shape the manual-scan test drives). */
  async function post(route, query = {}, token = PEER_TOKEN) {
    const router = await route.router();
    const layer = router.stack.find(l => l.route?.path === '/scan' && l.route.methods.post);
    assert.ok(layer, `no POST /scan on the ${route.name} router`);
    const req = { method: 'POST', path: '/scan', query, params: {}, body: {}, authToken: token, get: () => undefined, headers: {} };
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
  const refused = async (fn) => {
    const fault = refuseVectorSearch(REFUSALS.notInitialized, { only: (c) => c.startsWith(`${HELD}_`) });
    try { return await fn(); } finally { fault.restore(); }
  };
  /** The held entries as the answer names them: the space and the type, and the pass for the route that names one. */
  const heldOf = (route, body) => body.indexHeld.map(h => ({ spaceId: h.spaceId, type: h.type, ...(route.wantsPass ? { pass: h.pass } : {}) }));

  for (const route of ROUTES) {
    describe(route.name, () => {
      it('names the type that held, in the space that held it', { timeout: 60_000 }, async () => {
        const res = await refused(() => post(route, { space: HELD }));
        assert.equal(res.code, 200, JSON.stringify(res.body));
        assert.ok(Array.isArray(res.body.indexHeld), `the answer has no indexHeld: a held scan answers like a finished one (${JSON.stringify(res.body)})`);
        const want = route.expected(HELD).map(h => ({ ...h, ...(route.wantsPass ? { pass: 'structured' } : {}) }));
        assert.deepEqual(heldOf(route, res.body), want, `a scan whose type held did not say which: ${JSON.stringify(res.body)}`);
      });

      it('answers indexHeld, empty, when nothing held', { timeout: 60_000 }, async () => {
        const res = await post(route, { space: HEALTHY });
        assert.equal(res.code, 200, JSON.stringify(res.body));
        assert.deepEqual(res.body.indexHeld, [], `the field is present on a scan that held nothing: ${JSON.stringify(res.body)}`);
        assert.ok(res.body.scanned > 0, 'the healthy space was not scanned: the case did not produce the state it is about');
      });

      it('a scan of every space names the held one and not the healthy one', { timeout: 60_000 }, async () => {
        const res = await refused(() => post(route));
        assert.equal(res.code, 200, JSON.stringify(res.body));
        assert.deepEqual(res.body.indexHeld?.map(h => h.spaceId), [HELD], `indexHeld is ${JSON.stringify(res.body.indexHeld)}`);
      });

      it('names no space the token cannot scan', { timeout: 60_000 }, async () => {
        const narrow = Object.freeze({ rights: spaceAdminRights([HEALTHY]) });
        const res = await refused(() => post(route, {}, narrow));
        assert.equal(res.code, 200, JSON.stringify(res.body));
        assert.deepEqual(res.body.indexHeld, [], `a token that may scan only ${HEALTHY} was told about ${JSON.stringify(res.body.indexHeld)}: the list is built from the spaces the scan covered, after the token's reach`);
      });
    });
  }
});
