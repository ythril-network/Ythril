/**
 * `similar` over an index that cannot answer says which records may be missing, on every door, and its reasons are not
 * recall's to count (Q-326, bundle-72 DESIGN v3 items 3-5; vet S11, S16).
 *
 * ## The defect
 *
 * `findSimilar` answered `{ source, results }` and had no channel for a reason: a not-yet index (`Index <name> not initialized`)
 * read as "no neighbours", and an index that will not serve threw, so one broken space failed a cross-space `similar`. The MCP
 * `similar` tool and `POST /api/brain/similar` returned the same flat answer. Recall already carries `degraded`; `similar`
 * asks the same collections the same question and must tell its caller the same thing.
 *
 * ## The rules, one case each
 *
 *  - `findSimilar`'s answer carries `degraded` (`index_not_ready` over aged records behind a not-yet refusal; `index_unavailable`
 *    for a REAL will-not-serve refusal, an index built with the wrong `numDimensions`), and a cross-space `similar` with one
 *    broken space answers from the others instead of throwing.
 *  - the MCP `similar` tool and REST `/api/brain/similar` return `degraded` when non-empty, and omit the key when healthy
 *    (additive: a client that does not know the field sees an unchanged answer).
 *  - `ythril_recall_degraded_total` does NOT move for a `similar` call (S11): it counts recalls, and a `similar` is not one.
 *  - a recall counts a reason ONCE per recall, not once per collection that gave it (two collections refused, one count).
 *
 * "Seen red" on the base: `findSimilar` has no `degraded`, the doors omit it, the will-not-serve case throws, and a recall
 * over two refused collections counts no `index_not_ready` at all (the reason does not exist yet).
 *
 * Needs a MongoDB with mongot (atlas-local): `npm run test:up`.
 *
 * Run: node --test testing/standalone/a-similar-over-an-index-that-cannot-answer-carries-the-reason-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';
import {
  unitAt, queryAxis, startStubEmbedder, createSpaceCollections, insertAll, waitUntilServing, waitUntilTrue,
} from './_vector-harness.mjs';
import { REFUSALS, refuseVectorSearch } from './_mongot-refusals.mjs';
import { routeHandler, viaRest as restDoor, viaMcp as mcpDoor } from '../_shared/route-and-tool-doors.mjs';

const skip = await mongoSkipReason();

const DIMS = 8;
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-simreasons-'));
process.env['CONFIG_PATH'] = path.join(tmpDir, 'config.json');
process.env['DATA_ROOT'] = path.join(tmpDir, 'data');
process.env['EMBEDDING_DIMENSIONS'] = String(DIMS);
process.env['YTHRIL_HYBRID_SEARCH'] = 'off';

/** An hour ago: outside the fresh-window, so only the INDEX could supply these records. */
const OLD = new Date(Date.now() - 3_600_000).toISOString();

const NY = 'smny';          // seed + aged entities, no index; the not-yet refusal is injected
const TWO = 'smtwo';        // aged entities AND facts, no index; for counting a reason once per recall
const OK = 'smok';          // a healthy served index
const BROKEN = 'smbroken';  // entities index built with the wrong numDimensions (a real refusal)
const SPACES = [NY, TWO, OK, BROKEN];
/** The tool's schema wants a v4 uuid for the seed's id. */
const NY_SEED = 'cccccccc-0000-4000-8000-0000000a0001';
const OK_SEED = 'cccccccc-0000-4000-8000-0000000a0002';

let mongo, recallMod, vectorIndex, stub, callTool, ADMIN, similarHandler, register;

const entity = (spaceId, id, deg, extra = {}) => ({
  _id: id, spaceId, name: id, type: 'thing', tags: [], properties: {}, description: `record ${id}`,
  embedding: unitAt(deg, DIMS), embeddingModel: 'stub', seq: 1, createdAt: OLD, updatedAt: OLD, ...extra,
});
const fact = (spaceId, id, deg) => ({
  _id: id, spaceId, fact: `fact ${id}`, tags: [], embedding: unitAt(deg, DIMS), embeddingModel: 'stub',
  seq: 1, createdAt: OLD, updatedAt: OLD,
});

const viaRest = (body) => restDoor(similarHandler, body, { rights: ADMIN });
const viaMcp = (args) => mcpDoor(callTool, 'similar', args, { rights: ADMIN });

/** The counter's current value for one reason, read from the registry as an operator's scrape would. */
async function degradedCount(reason) {
  const metric = register.getSingleMetric('ythril_recall_degraded_total');
  const { values } = await metric.get();
  return values.find(v => v.labels.reason === reason)?.value ?? 0;
}

async function rawRefusal(space, suffix) {
  try {
    await mongo.col(`${space}_${suffix}`).aggregate([{ $vectorSearch: {
      index: `${space}_${suffix}_embedding`, path: 'embedding', queryVector: queryAxis(DIMS), numCandidates: 10, limit: 1,
    } }]).toArray();
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

describe('similar over an index that cannot answer carries the reason', { skip }, () => {
  before(async () => {
    stub = await startStubEmbedder(() => queryAxis(DIMS));
    fs.mkdirSync(process.env['DATA_ROOT'], { recursive: true });
    fs.writeFileSync(process.env['CONFIG_PATH'], JSON.stringify(
      { instanceId: 'simreasons', instanceLabel: 'test', tokens: [], networks: [],
        spaces: SPACES.map(id => ({ id, label: id, folders: [] })) }, null, 2), { mode: 0o600 });
    mongo = await openTestMongo('simreasons');
    (await import('../../server/dist/config/loader.js')).loadConfig();
    recallMod = await import('../../server/dist/brain/recall.js');
    vectorIndex = await import('../../server/dist/spaces/vector-index.js');
    ({ register } = await import('../../server/dist/metrics/registry.js'));
    ({ callTool } = await import('../../server/dist/mcp/call-tool.js'));
    const { SPACE_AREAS } = await import('../../server/dist/config/rights-shape.js');
    ADMIN = { instanceAdmin: true, createSpaces: true, perSpace: {}, floor: Object.fromEntries(SPACE_AREAS.map(a => [a, 'admin'])) };
    const { searchRouter } = await import('../../server/dist/api/brain/search.js');
    similarHandler = routeHandler(searchRouter, '/similar');
    for (const id of SPACES) await createSpaceCollections(mongo, id);

    await insertAll(mongo, `${NY}_entities`, [entity(NY, NY_SEED, 0),entity(NY, 'ny-1', 10), entity(NY, 'ny-2', 20)]);
    await insertAll(mongo, `${TWO}_entities`, [entity(TWO, 'two-e1', 10), entity(TWO, 'two-e2', 20)]);
    await insertAll(mongo, `${TWO}_facts`, [fact(TWO, 'two-f1', 12), fact(TWO, 'two-f2', 22)]);
    await insertAll(mongo, `${OK}_entities`, [entity(OK, OK_SEED, 0),entity(OK, 'ok-1', 10), entity(OK, 'ok-2', 20)]);
    await insertAll(mongo, `${BROKEN}_entities`, [entity(BROKEN, 'br-1', 10), entity(BROKEN, 'br-2', 20)]);
    await mongo.checkVectorSearchAvailability();

    await vectorIndex.ensureVectorSearchIndex(OK, 'entities', DIMS, 'cosine', 'embedding', 'embedding', true, []);
    await vectorIndex.ensureVectorSearchIndex(BROKEN, 'entities', 4, 'cosine', 'embedding', 'embedding', true, []);
    await waitUntilServing(mongo, `${OK}_entities`, `${OK}_entities_embedding`, { dims: DIMS, n: 3 });
    await waitUntilTrue('the four-wide index to refuse an eight-wide query as a dimension mismatch',
      async () => { const m = await rawRefusal(BROKEN, 'entities'); return /dimension/i.test(m ?? '') ? true : (m ?? 'served'); },
      120_000, 500);
  });

  after(async () => {
    await closeTestMongo();
    await stub?.close();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  describe('findSimilar', () => {
    it('behind a not-yet refusal over aged records: degraded carries index_not_ready', async () => {
      const fault = refuseVectorSearch(REFUSALS.notInitialized);
      let answer;
      try { answer = await recallMod.findSimilar(NY, NY_SEED, 'entity'); } finally { fault.restore(); }
      assert.ok(fault.refused() >= 1, 'the fault never reached findSimilar');
      assert.deepEqual(answer.results, [], 'the index refused, and these records are aged: nothing else can answer');
      assert.ok(answer.degraded?.includes('index_not_ready'),
        `degraded is ${JSON.stringify(answer.degraded)}: two aged neighbours exist and the answer is empty with no reason`);
    });

    it('over a real will-not-serve index: index_unavailable, and nothing is thrown', async () => {
      let answer, thrown;
      try { answer = await recallMod.findSimilar(BROKEN, 'br-1', 'entity'); } catch (err) { thrown = err instanceof Error ? err.message : String(err); }
      assert.equal(thrown, undefined, `findSimilar threw "${thrown}" for an index that exists and will not serve`);
      assert.ok(answer.degraded?.includes('index_unavailable'), `degraded is ${JSON.stringify(answer.degraded)}`);
    });

    it('a cross-space similar with one broken space answers from the others', async () => {
      let answer, thrown;
      try {
        answer = await recallMod.findSimilar(OK, OK_SEED, 'entity', 10, ['entity'], undefined, [OK, BROKEN]);
      } catch (err) { thrown = err instanceof Error ? err.message : String(err); }
      assert.equal(thrown, undefined, `findSimilar threw "${thrown}": one broken space fails every space`);
      const ids = answer.results.map(r => r._id);
      assert.ok(ids.includes('ok-1') && ids.includes('ok-2'), `the healthy space's neighbours are missing: [${ids.join(', ')}]`);
      assert.ok(answer.degraded?.includes('index_unavailable'), `degraded is ${JSON.stringify(answer.degraded)}`);
    });

    it('healthy: the neighbours, and no degraded reason (guards the omission on the healthy path)', async () => {
      const answer = await recallMod.findSimilar(OK, OK_SEED, 'entity');
      assert.deepEqual(answer.results.map(r => r._id), ['ok-1', 'ok-2']);
      assert.ok(!answer.degraded || answer.degraded.length === 0, `degraded is ${JSON.stringify(answer.degraded)} on a healthy answer`);
    });
  });

  for (const [door, ask] of [['MCP similar', (args) => viaMcp(args)], ['REST /api/brain/similar', (args) => viaRest(args)]]) {
    describe(door, () => {
      it('returns degraded when non-empty', async () => {
        const fault = refuseVectorSearch(REFUSALS.notStarted);
        let answer;
        try { answer = await ask({ space: NY, entryId: NY_SEED, entryType: 'entity', targetTypes: ['entity'] }); } finally { fault.restore(); }
        assert.equal(answer.status, 200, JSON.stringify(answer.body).slice(0, 300));
        assert.ok(Array.isArray(answer.body?.degraded) && answer.body.degraded.includes('index_not_ready'),
          `the answer's degraded is ${JSON.stringify(answer.body?.degraded)}: the caller cannot tell an empty answer from an incomplete one`);
      });

      it('omits degraded when healthy', async () => {
        const answer = await ask({ space: OK, entryId: OK_SEED, entryType: 'entity', targetTypes: ['entity'] });
        assert.equal(answer.status, 200, JSON.stringify(answer.body).slice(0, 300));
        assert.ok(!('degraded' in (answer.body ?? {})), `a healthy answer carries degraded: ${JSON.stringify(answer.body.degraded)}`);
      });
    });
  }

  describe('the metric', () => {
    it('does not move for a similar call, though the answer says index_not_ready', async () => {
      const before = await degradedCount('index_not_ready');
      const fault = refuseVectorSearch(REFUSALS.notInitialized);
      let answer;
      try { answer = await recallMod.findSimilar(NY, NY_SEED, 'entity'); } finally { fault.restore(); }
      assert.ok(answer.degraded?.includes('index_not_ready'), `the answer must carry the reason first: ${JSON.stringify(answer.degraded)}`);
      assert.equal(await degradedCount('index_not_ready'), before,
        'ythril_recall_degraded_total counts recalls; a similar call must not feed it (a similar is not a recall)');
    });

    it('a recall counts a reason once per recall, not once per collection that gave it', async () => {
      const before = await degradedCount('index_not_ready');
      const degraded = [];
      const fault = refuseVectorSearch(REFUSALS.notInitialized);
      try {
        await recallMod.recall(TWO, 'Q', 10, undefined, ['entity', 'fact'], undefined, undefined, undefined, { degraded });
      } finally { fault.restore(); }
      assert.ok(fault.refused() >= 2, `only ${fault.refused()} collection(s) were refused - the case needs two`);
      assert.deepEqual(degraded, ['index_not_ready'], 'the caller is told the reason once');
      assert.equal(await degradedCount('index_not_ready') - before, 1,
        'two collections gave the same reason in one recall: one count, or the metric reads collections, not recalls');
    });
  });
});
