/**
 * A record written while the search service was down is indexed when it comes back (Q-113) — against real mongot.
 *
 * ## The failure this prevents
 *
 * `search-index-presence.ts` recorded an `unavailable` outcome as belief `indexed` "on purpose": there was nothing
 * a write could do, and the probe that decided it was memoised for the process. So after a probe that lost the
 * race with mongot, NO write ever tried again — the first record of a collection arrived, the index was not
 * built, and semantic recall stayed empty until a restart or the rebuild route.
 *
 * The contract now: an `unavailable` outcome records belief `deferred` and registers ONE waiter for the
 * service's return. Until then a write costs a map lookup (no reconcile is scheduled, which is what is counted
 * here through the collection reads a reconcile begins with). On the return, the waiter runs a forced reconcile
 * and the index exists.
 *
 * ## How the outage is made, and what is real
 *
 * The database, the driver, mongot and the index are real. Only the answer of the readiness probes is forced to
 * fail (`_search-outage.mjs`, which says where and why). The watcher heals on its own schedule, so the test
 * waits for the heal rather than calling it.
 *
 * ## Cases
 *
 *  1. a write while down: belief `deferred`, no index;
 *  2. further writes schedule NO reconcile (the reads are counted);
 *  3. search returns: the index EXISTS, serves every record, and recall returns them past the fresh-write window;
 *  4. the flip can land ANYWHERE between "answered unavailable" and "recorded deferred" and the index still
 *     appears — swept over microtask depths, because a flip that lands between the two steps is exactly the one
 *     a check-then-register implementation loses;
 *  5. a restore (`reportDatabaseReplaced`) clears the belief, and a forced reconcile while still down re-defers
 *     it, so the return still builds the index.
 *
 * Needs a MongoDB with mongot (atlas-local): `npm run test:up`, or a scratch one pointed at with
 * YTHRIL_TEST_MONGO_PORT / YTHRIL_TEST_MONGO_CREDS= — CI runs it against the test stack.
 *
 * Run: node --test testing/standalone/a-record-written-while-search-was-down-is-indexed-when-it-returns-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';
import { unitAt, queryAxis, startStubEmbedder, createSpaceCollections, waitUntilServing } from './_vector-harness.mjs';
import { installSearchOutage } from './_search-outage.mjs';

const skip = await mongoSkipReason();

const DIMS = 8;
const FRESH_MS = 3_000;
const SPACE = 'lateidx';
const RESTORED = 'laterestore';
const FLIP_SPACES = Array.from({ length: 10 }, (_, i) => `lateflip${i}`);
const DEPTHS = [0, 1, 2, 3, 4, 5, 6, 8, 10, 14];
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-lateidx-'));
const CONFIG_PATH = path.join(tmpDir, 'config.json');
process.env['CONFIG_PATH'] = CONFIG_PATH;
process.env['EMBEDDING_DIMENSIONS'] = String(DIMS);
process.env['YTHRIL_HYBRID_SEARCH'] = 'off';
process.env['DUPE_FRESH_WINDOW_MS'] = String(FRESH_MS);

let mongo, presence, vectorIndex, recallMod, readiness, outage, stub;
let seq = 0;
const rec = (spaceId, id) => {
  const now = new Date().toISOString();
  return { _id: id, spaceId, name: id, type: 'thing', tags: [], properties: {}, embedding: unitAt(5, DIMS),
    embeddingModel: 'stub', seq: ++seq, createdAt: now, updatedAt: now };
};
const names = async (coll) => (await mongo.col(coll).listSearchIndexes().toArray()).map(i => i.name).sort();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function eventually(what, fn, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await fn();
    if (last === true) return;
    await sleep(250);
  }
  assert.fail(`${what} did not happen within ${timeoutMs} ms (last: ${JSON.stringify(last)})`);
}

/** Put the production readiness singleton into `down` over the simulated outage. */
async function startOutage() {
  readiness.resetSearchReadyProbe();
  outage.setDown(true);
}

describe('a record written while search was down is indexed when it returns', { skip }, () => {
  before(async () => {
    stub = await startStubEmbedder(() => queryAxis(DIMS));
    const ids = [SPACE, RESTORED, ...FLIP_SPACES];
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({
      spaces: ids.map(id => ({ id, label: id })), networks: [], tokens: [],
    }, null, 2));
    mongo = await openTestMongo('lateidx');
    (await import('../../server/dist/config/loader.js')).loadConfig();
    presence = await import('../../server/dist/spaces/search-index-presence.js');
    vectorIndex = await import('../../server/dist/spaces/vector-index.js');
    readiness = await import('../../server/dist/spaces/search-readiness.js');
    recallMod = await import('../../server/dist/brain/recall.js');
    for (const id of ids) {
      await createSpaceCollections(mongo, id);
      await mongo.col(`${id}_entities`).createIndex({ seq: 1 });
    }
    await mongo.checkVectorSearchAvailability();
    presence.armSearchIndexPresence();
    outage = installSearchOutage(mongo);
  });

  after(async () => {
    outage?.restore();
    readiness?.resetSearchReadyProbe();
    await closeTestMongo();
    await stub?.close();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it('a record written while search is down is left `deferred`, with no index and no error', async () => {
    await startOutage();
    const coll = `${SPACE}_entities`;
    await mongo.col(coll).insertOne(rec(SPACE, 'first'));
    await presence.searchIndexPresenceSettled(SPACE);
    assert.equal(presence._presenceBeliefOf(coll), 'deferred',
      'an `unavailable` outcome was recorded as something a write will never revisit');
    assert.deepEqual(await names(coll), [], 'an index appeared although search was down');
    assert.equal(readiness.searchReadinessSnapshot().state, 'down');
  });

  it('further writes to a deferred collection schedule no reconcile — a write costs a map lookup', async () => {
    const coll = `${SPACE}_entities`;
    const readsBefore = outage.calls('findOne', coll);
    for (let i = 0; i < 6; i++) await mongo.col(coll).insertOne(rec(SPACE, `more-${i}`));
    await presence.searchIndexPresenceSettled(SPACE);
    await sleep(300);
    assert.equal(outage.calls('findOne', coll), readsBefore,
      'a write to a deferred collection started a reconcile — with search down, every write would retry the probe path');
    assert.equal(presence._presenceBeliefOf(coll), 'deferred');
  });

  it('when search returns, the index exists, serves every record, and recall finds them all', async () => {
    const coll = `${SPACE}_entities`;
    outage.setDown(false);
    await eventually(`${coll}'s index being built after the heal`, async () => (await names(coll)).includes(`${coll}_embedding`) || await names(coll));
    await presence.searchIndexPresenceSettled(SPACE);
    assert.equal(presence._presenceBeliefOf(coll), 'indexed');
    await waitUntilServing(mongo, coll, `${coll}_embedding`, { dims: DIMS, n: 7 });
    // Past the fresh-write window only the index can answer: the records must be in it.
    await sleep(FRESH_MS + 500);
    const got = await recallMod.recall(SPACE, 'Q', 20, undefined, ['entity'], undefined, undefined, undefined, { degraded: [] });
    assert.deepEqual(got.map(r => r._id).sort(), ['first', ...Array.from({ length: 6 }, (_, i) => `more-${i}`)].sort());
  });

  it('a flip landing between "answered unavailable" and "recorded deferred" is not lost, wherever it lands', async () => {
    for (const [i, depth] of DEPTHS.entries()) {
      const space = FLIP_SPACES[i];
      const coll = `${space}_facts`;
      await startOutage();
      // The 6th failed probe ends the cold window; the service returns `depth` microtasks after it was delivered.
      outage.flipAfter(6, depth, () => readiness.noteSearchUp());
      await mongo.col(coll).insertOne(rec(space, `r-${depth}`));
      await eventually(`${coll} getting its index (flip ${depth} microtasks after the window)`,
        async () => (await names(coll)).includes(`${coll}_embedding`) || await names(coll), 60_000);
      await presence.searchIndexPresenceSettled(space);
    }
  });

  it('a restore clears the belief; a forced reconcile while still down re-defers it, and the return builds the index', async () => {
    await startOutage();
    const coll = `${RESTORED}_facts`;
    await mongo.col(coll).insertOne(rec(RESTORED, 'kept'));
    await presence.searchIndexPresenceSettled(RESTORED);
    assert.equal(presence._presenceBeliefOf(coll), 'deferred');

    mongo.reportDatabaseReplaced();
    assert.equal(presence._presenceBeliefOf(coll), undefined, 'a restore left a belief about a database that was replaced');

    await presence.reconcileSpaceSearchIndexes(RESTORED);
    assert.equal(presence._presenceBeliefOf(coll), 'deferred',
      'the forced reconcile after a restore, with search still down, did not re-defer — the return would build nothing');
    assert.deepEqual(await names(coll), []);

    outage.setDown(false);
    await eventually(`${coll}'s index after the restore and the heal`, async () => (await names(coll)).includes(`${coll}_embedding`) || await names(coll));
    await waitUntilServing(mongo, coll, `${coll}_embedding`, { dims: DIMS, n: 1 });
  });
});
