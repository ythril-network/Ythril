/**
 * A collection's search index exists only while the collection holds a record (Q-165) — against real mongot.
 *
 * ## Why
 *
 * mongot keeps one change-stream cursor per search index over the shared oplog, and half the record collections
 * on a measured instance were empty and each still carried one. So an index is now built on a collection's
 * first record and dropped after its last (`spaces/search-index-presence.ts`), and the writes that drive it are
 * observed where every write goes (`db/record-write-observer.ts`). What only a real database can say:
 *
 *  - an empty collection carries no index, and every read on it answers EMPTY and HEALTHY — no error, no
 *    `degraded` reason, and a readiness wait that does not wait for an index nobody will build;
 *  - the first write brings an index up, and its record is found at once (the fresh-write channel) AND after the
 *    fresh window has closed (the index, which therefore ingested it);
 *  - an index built after records exist ingests every one of them;
 *  - emptying the collection drops the index;
 *  - a record written as the last one is deleted never ends up in a collection with no index;
 *  - an existing space heals: an empty collection's leftover index is dropped, a populated one's is kept as is.
 *
 * ## Seen red
 *
 * Each mutation made by hand in the built lifecycle and put back by hand:
 *
 *  - an empty collection given its index as every space used to have (the base behaviour): the first case fails;
 *  - the drop replaced by "dropped": the emptying and heal cases fail, each after a minute of polling;
 *  - the observer's write report ignored: the first-write and ingest cases fail;
 *  - the `settling` mark removed, so a write reported during the emptiness read queues nothing: BOTH race cases
 *    fail — the record is left in a collection with no index and never served.
 *
 * Needs a MongoDB with mongot (atlas-local): `npm run test:up`, or a scratch one pointed at with
 * YTHRIL_TEST_MONGO_PORT / YTHRIL_TEST_MONGO_CREDS= — CI runs it against the test stack.
 *
 * Run: node --test testing/standalone/a-search-index-exists-only-while-its-collection-holds-a-record-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';
import { unitAt, queryAxis, startStubEmbedder, createSpaceCollections, waitUntilServing, waitUntilTrue } from './_vector-harness.mjs';
import { sleep } from '../_shared/sleep.mjs';

const skip = await mongoSkipReason();

const DIMS = 8;
const FRESH_MS = 4_000;
const SPACE = 'lazyidx';
const HEAL = 'lazyheal';
const SUFFIXES = ['facts', 'entities', 'edges', 'chrono', 'files'];
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-lazyidx-'));
const CONFIG_PATH = path.join(tmpDir, 'config.json');
process.env['CONFIG_PATH'] = CONFIG_PATH;
process.env['EMBEDDING_DIMENSIONS'] = String(DIMS);
process.env['YTHRIL_HYBRID_SEARCH'] = 'off';
// A short fresh-write window, so "found after the window closed" means "found through the index".
process.env['DUPE_FRESH_WINDOW_MS'] = String(FRESH_MS);

let mongo, presence, vectorIndex, recallMod, stub;
let seq = 0;
const rec = (id, extra = {}) => {
  const now = new Date().toISOString();
  return { _id: id, spaceId: SPACE, name: id, type: 'thing', tags: [], properties: {}, embedding: unitAt(5, DIMS),
    embeddingModel: 'stub', seq: ++seq, createdAt: now, updatedAt: now, ...extra };
};
const names = async (coll) => (await mongo.col(coll).listSearchIndexes().toArray()).map(i => i.name).sort();

/** mongot's catalogue lags a drop by a moment, so absence is polled for rather than read once. */
const eventually = (what, fn, timeoutMs = 60_000) => waitUntilTrue(what, fn, timeoutMs, 500);

async function recallAll(spaceId, filter) {
  const degraded = [];
  const results = await recallMod.recall(spaceId, 'Q', 10, undefined, ['fact', 'entity', 'edge', 'chrono', 'file'],
    undefined, undefined, filter, { degraded });
  return { ids: results.map(r => r._id), degraded };
}

describe('a search index exists only while its collection holds a record', { skip }, () => {
  before(async () => {
    stub = await startStubEmbedder(() => queryAxis(DIMS));
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({
      spaces: [{ id: SPACE, label: SPACE }, { id: HEAL, label: HEAL }], networks: [], tokens: [],
    }, null, 2));
    mongo = await openTestMongo('lazyidx');
    (await import('../../server/dist/config/loader.js')).loadConfig();
    presence = await import('../../server/dist/spaces/search-index-presence.js');
    vectorIndex = await import('../../server/dist/spaces/vector-index.js');
    recallMod = await import('../../server/dist/brain/recall.js');
    await createSpaceCollections(mongo, SPACE);
    await createSpaceCollections(mongo, HEAL);
    for (const s of [SPACE, HEAL]) await mongo.col(`${s}_entities`).createIndex({ seq: 1 });
    await mongo.checkVectorSearchAvailability();
    // What `initSpace` does first, without the file directory it would also create (a CI runner cannot write it).
    presence.armSearchIndexPresence();
  });

  after(async () => {
    await closeTestMongo();
    await stub?.close();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it('an empty space carries no search index at all', async () => {
    await presence.reconcileSpaceSearchIndexes(SPACE);
    for (const s of SUFFIXES) {
      assert.deepEqual(await names(`${SPACE}_${s}`), [], `${SPACE}_${s} holds nothing and still carries an index`);
    }
  });

  it('reads on the empty space answer empty and healthy — no error, no degraded reason', async () => {
    const plain = await recallAll(SPACE);
    assert.deepEqual(plain, { ids: [], degraded: [] });
    const { resolveRecallFilter } = await import('../../server/dist/brain/recall-filter.js');
    const r = resolveRecallFilter({ 'properties.marker': 'x' });
    const filtered = await recallAll(SPACE, r.filter);
    assert.deepEqual(filtered, { ids: [], degraded: [] }, 'a filtered recall over index-less empty collections must not say filter_window');
  });

  it('the readiness wait does not wait for an index nobody will build', async () => {
    const started = Date.now();
    const ok = await vectorIndex.waitForSpaceIndexesReady(SPACE, { timeoutMs: 30_000 });
    assert.equal(ok, true, 'an empty space was reported not ready — its badge would read failed');
    assert.ok(Date.now() - started < 10_000, `took ${Date.now() - started} ms: it polled for indexes that are absent by design`);
  });

  it('the first write brings the index up; its record is found at once and after the fresh window closes', async () => {
    const coll = `${SPACE}_entities`;
    const writtenAt = Date.now();
    await mongo.col(coll).insertOne(rec('first'));
    const atOnce = await recallAll(SPACE);
    assert.deepEqual(atOnce.ids, ['first'], 'the fresh-write channel must answer for a record whose index is still building');

    await presence.searchIndexPresenceSettled(SPACE);
    assert.deepEqual(await names(coll), [`${coll}_embedding`], 'the first write did not bring an index up');
    for (const s of SUFFIXES.filter(x => x !== 'entities')) assert.deepEqual(await names(`${SPACE}_${s}`), []);
    await waitUntilServing(mongo, coll, `${coll}_embedding`, { dims: DIMS, n: 1 });

    await sleep(Math.max(0, writtenAt + FRESH_MS + 500 - Date.now()));
    const later = await recallAll(SPACE);
    assert.deepEqual(later.ids, ['first'], 'past the fresh window only the index can answer — it did not ingest the first record');
  });

  it('an index built after records exist ingests every one of them', async () => {
    const coll = `${SPACE}_chrono`;
    await mongo.col(coll).insertMany(['c1', 'c2', 'c3', 'c4', 'c5'].map(id => rec(id, { title: id })));
    await presence.searchIndexPresenceSettled(SPACE);
    assert.deepEqual(await names(coll), [`${coll}_embedding`]);
    await waitUntilServing(mongo, coll, `${coll}_embedding`, { dims: DIMS, n: 5 });
  });

  it('emptying a collection drops its index, and the space still reads healthy', async () => {
    const coll = `${SPACE}_chrono`;
    await mongo.col(coll).deleteMany({});
    await presence.checkEmptinessNow(coll);
    await eventually(`${coll}'s index being dropped`, async () => (await names(coll)).length === 0 || await names(coll));
    const after = await recallAll(SPACE);
    assert.deepEqual(after.degraded, []);
    assert.ok(!after.ids.some(id => id.startsWith('c')), 'deleted records came back');
  });

  for (const order of ['check first', 'write first']) {
    it(`a record written as the last one is deleted always has an index (${order})`, async () => {
      const coll = `${SPACE}_edges`;
      for (let round = 0; round < 3; round++) {
        await mongo.col(coll).insertOne(rec(`e-seed-${order}-${round}`));
        await presence.searchIndexPresenceSettled(SPACE);
        await mongo.col(coll).deleteMany({});
        const id = `e-${order}-${round}`;
        const both = order === 'check first'
          ? [presence.checkEmptinessNow(coll), mongo.col(coll).insertOne(rec(id))]
          : [mongo.col(coll).insertOne(rec(id)), presence.checkEmptinessNow(coll)];
        await Promise.all(both);
        await presence.searchIndexPresenceSettled(SPACE);
        // The real invariant, asked of the index itself rather than of the catalogue: it serves the record.
        await waitUntilServing(mongo, coll, `${coll}_embedding`, { dims: DIMS, n: 1 });
        await mongo.col(coll).deleteMany({});
      }
      await presence.checkEmptinessNow(coll);
    });
  }

  it('an existing space heals: an empty collection loses its index, a populated one keeps its own', async () => {
    const empty = `${HEAL}_facts`;
    const full = `${HEAL}_edges`;
    await mongo.col(full).insertOne({ ...rec('kept'), spaceId: HEAL });
    // The pre-upgrade state, built the way every space used to be: an index on each collection, empty or not.
    for (const s of ['facts', 'edges']) {
      await vectorIndex.ensureVectorSearchIndex(HEAL, s, DIMS, 'cosine', 'embedding', 'embedding', true,
        vectorIndex.vectorFilterFieldsFor(HEAL, s));
    }
    const idBefore = (await mongo.col(full).listSearchIndexes().toArray()).find(i => i.name === `${full}_embedding`)?.id;
    assert.ok(idBefore, 'fixture check: the populated collection has its index before the upgrade');
    assert.deepEqual(await names(empty), [`${empty}_embedding`], 'fixture check: the empty collection has one too');

    await presence.reconcileSpaceSearchIndexes(HEAL);

    await eventually(`${empty}'s leftover index being dropped`, async () => (await names(empty)).length === 0 || await names(empty));
    const idAfter = (await mongo.col(full).listSearchIndexes().toArray()).find(i => i.name === `${full}_embedding`)?.id;
    assert.equal(idAfter, idBefore, 'the populated collection\'s index was rebuilt — an upgrade must not touch a serving index');
  });
});
