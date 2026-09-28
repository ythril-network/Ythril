/**
 * The fresh-write scan keeps serving filtered recall, and a caller's filter cannot switch its guards off (Q-102).
 *
 * ## Why the scan stays for every type
 *
 * Completing a filtered recall (stage 2) scores candidate ids THROUGH the vector index, and the index lags the
 * collection by up to 150 s on a loaded deployment. So the collection scan of just-written records is still
 * the only thing that can return a record written a moment ago — filtered or not. The first case pins that it
 * does, with no wait; it is green on the base commit and has to stay green through the change.
 *
 * ## Why the guards are ANDed
 *
 * The scan's `$match` was `{updatedAt: {$gte: cutoff}, embedding: {$type: 'array'}, ...predicate}`. A raw filter
 * naming `updatedAt` or `embedding` then REPLACED the guard rather than narrowing it: `{updatedAt: {$exists:
 * true}}` turned "the last three minutes" into "every record in the capped window", and `{embedding: {$exists:
 * true}}` let a vectorless record into vector arithmetic, where `$size` of a non-array fails the whole
 * aggregate — and the scan's own catch then returns nothing, dropping the valid fresh record beside it.
 *
 * Run: `npm run test:up` first, then
 *      node --test testing/standalone/fresh-writes-keep-their-guards-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';
import { unitAt, queryAxis, startStubEmbedder, createSpaceCollections, insertAll, waitUntilServing } from './_vector-harness.mjs';

const skip = await mongoSkipReason();

const DIMS = 8;
const SPACE = 'freshguard';
const COLL = `${SPACE}_entities`;
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-freshguard-'));
const CONFIG_PATH = path.join(tmpDir, 'config.json');
process.env['CONFIG_PATH'] = CONFIG_PATH;
process.env['EMBEDDING_DIMENSIONS'] = String(DIMS);
process.env['YTHRIL_HYBRID_SEARCH'] = 'off';

let mongo, recallMod, fresh, resolveRecallFilter, stub;
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();
const rec = (id, seq, deg, ageMs, extra = {}) => ({
  _id: id, spaceId: SPACE, name: id, type: 'thing', tags: [], properties: {},
  embedding: unitAt(deg, DIMS), embeddingModel: 'stub', seq, createdAt: iso(ageMs), updatedAt: iso(ageMs), ...extra,
});
const raw = (f) => {
  const r = resolveRecallFilter(f);
  assert.ok(r.ok && r.kind === 'mongo', `fixture check: ${JSON.stringify(f)} should resolve as raw Mongo`);
  return r.filter.__raw;
};

/** 1200 indexed records, an hour old and nearer than anything written in the cases below. */
const BASE = Array.from({ length: 1200 }, (_, i) => rec(`old-${String(i).padStart(4, '0')}`, i + 1, 10 + i * 0.04, 3_600_000));

describe('the fresh-write scan keeps its guards', { skip }, () => {
  before(async () => {
    stub = await startStubEmbedder(() => queryAxis(DIMS));
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({ spaces: [{ id: SPACE, label: SPACE }], networks: [], tokens: [] }, null, 2));
    mongo = await openTestMongo('freshguard');
    (await import('../../server/dist/config/loader.js')).loadConfig();
    recallMod = await import('../../server/dist/brain/recall.js');
    fresh = await import('../../server/dist/brain/fresh-writes.js');
    ({ resolveRecallFilter } = await import('../../server/dist/brain/recall-filter.js'));
    const vectorIndex = await import('../../server/dist/spaces/vector-index.js');
    await createSpaceCollections(mongo, SPACE);
    await insertAll(mongo, COLL, BASE);
    await mongo.col(COLL).createIndex({ seq: 1 });
    await vectorIndex.buildSpaceVectorIndexes(SPACE, true);
    await waitUntilServing(mongo, COLL, `${COLL}_embedding`, { dims: DIMS, n: BASE.length });
    await mongo.checkVectorSearchAvailability();
  });

  after(async () => {
    await closeTestMongo();
    await stub?.close();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  beforeEach(async () => { await mongo.col(COLL).deleteMany({ _id: { $not: /^old-/ } }); });

  it('a record written a moment ago that matches an UNDECLARED filter is returned, with no wait', async () => {
    // Written and asked for immediately — no sleep, no poll. It ranks below 1200 indexed decoys, so only the
    // collection scan can supply it before the index ingests it.
    await mongo.col(COLL).insertOne(rec('just-written', 5000, 80, 1000, { properties: { marker: 'new' } }));
    const r = resolveRecallFilter({ 'properties.marker': 'new' });
    const results = await recallMod.recall(SPACE, 'Q', 10, undefined, ['entity'], undefined, undefined, r.filter);
    assert.deepEqual(results.map(x => x._id), ['just-written'],
      'the index lags the collection; stage 2 scores through the index, so the fresh-write scan is still the only '
      + 'channel that can see this record');
  });

  it('a raw filter naming updatedAt cannot widen the freshness window', async () => {
    await mongo.col(COLL).insertOne(rec('inside', 5001, 80, 1000));
    const ids = (await fresh.matchFreshWrites(COLL, queryAxis(DIMS), Date.now(), raw({ updatedAt: { $exists: true } })))
      .map(m => m._id);
    assert.deepEqual(ids, ['inside'],
      `the scan returned ${ids.length} record(s), ${ids.filter(i => i.startsWith('old-')).length} of them an hour `
      + 'old: the filter\'s updatedAt key replaced the window instead of narrowing it');
  });

  it('a raw filter naming embedding cannot let a vectorless record into the vector arithmetic', async () => {
    await mongo.col(COLL).insertOne(rec('embedded', 5002, 80, 1000));
    await mongo.col(COLL).insertOne(rec('vectorless', 5003, 80, 1000, { embedding: null }));
    const ids = (await fresh.matchFreshWrites(COLL, queryAxis(DIMS), Date.now(), raw({ embedding: { $exists: true } })))
      .map(m => m._id);
    assert.deepEqual(ids, ['embedded'],
      `got [${ids.join(', ')}]: the filter's embedding key replaced the {$type: 'array'} guard, the null vector `
      + 'reached $size, the aggregate failed, and the scan\'s catch dropped the valid record with it');
  });
});
