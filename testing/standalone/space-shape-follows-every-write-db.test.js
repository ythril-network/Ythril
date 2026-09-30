/**
 * The space meta's `actualSchema` and `stats` are served from a cache, and the cache is never behind a write.
 *
 * ## Why a cache at all (`Q-95`)
 *
 * Every meta read rebuilt what a space holds from scratch: an entity scan, an edge scan, three link-class scans
 * and seven counts, per member — about 240 ms on a space of 100 000 records (`testing/bench/space-meta-cost.mjs`),
 * paid on every schema edit and every time an agent orients itself. Making it opt-in was the other option and was
 * rejected: the owner merged `er_model` into `space_meta` so a caller gets both halves in one answer, and an
 * opt-in would split them again for everyone who does not know to ask.
 *
 * ## What a cache costs, and what this file holds it to
 *
 * A cache is only acceptable if it is never stale in a way a caller could see. So:
 *
 *   - every write this process commits to one of the collections the answer reads — entities, edges, links,
 *     facts, chrono, files — invalidates that space, through `db/record-write-observer.ts`, the one door every
 *     writer uses (asserted here per collection, not for one);
 *   - the DECLARED half is joined at read time, so a schema edit shows at once without any record written;
 *   - a write the observer cannot see (a restore, through its own client) is followed by
 *     `reportDatabaseReplaced()`, which evicts everything;
 *   - and the reason for the cache is asserted too: a second read with no write in between builds nothing.
 *
 * Run: node --test testing/standalone/space-shape-follows-every-write-db.test.js
 * (requires a prior `npm run build` in server/, and the test Mongo)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';

const skip = await mongoSkipReason();
const SPACE = 'shapecache';
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-shape-cache-'));
process.env['CONFIG_PATH'] = path.join(tmpDir, 'config.json');

describe('the space meta is cached and never behind a write', { skip }, () => {
  let mongo, loader, answer, shape;
  const read = async () => (await answer.spaceMetaAnswer({ spaceId: SPACE, memberIds: [SPACE], resolveRefs: false }));
  const typeCount = (meta, type) => meta.actualSchema.entityTypes.find(t => t.type === type)?.count ?? 0;

  before(async () => {
    fs.writeFileSync(process.env['CONFIG_PATH'], JSON.stringify({
      instanceId: 'shape-cache', instanceLabel: 'test', tokens: [], networks: [],
      spaces: [{ id: SPACE, label: 'Shape cache', builtIn: true, folders: [], completeLinkage: true,
        meta: { typeSchemas: { entity: { service: {} } } } }],
    }, null, 2), { mode: 0o600 });
    loader = await import('../../server/dist/config/loader.js');
    loader.loadConfig();
    mongo = await openTestMongo('shapecache');
    answer = await import('../../server/dist/spaces/space-meta-answer.js');
    shape = await import('../../server/dist/brain/space-shape.js');
    await mongo.col(`${SPACE}_entities`).insertMany([
      { _id: 'e1', spaceId: SPACE, name: 'a', type: 'service' },
      { _id: 'e2', spaceId: SPACE, name: 'b', type: 'service' },
    ]);
  });
  after(async () => {
    await closeTestMongo();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it('answers what the space holds', async () => {
    const m = await read();
    assert.equal(typeCount(m, 'service'), 2);
    assert.equal(m.stats.entities, 2);
  });

  it('a second read with no write in between builds nothing', async () => {
    await read();
    const before = shape._shapeBuildCount();
    await read();
    await read();
    assert.equal(shape._shapeBuildCount(), before, 'a read with nothing written rebuilt the shape — the cache is not caching');
  });

  it('an entity write shows on the next read', async () => {
    await mongo.col(`${SPACE}_entities`).insertOne({ _id: 'e3', spaceId: SPACE, name: 'c', type: 'db' });
    const m = await read();
    assert.equal(typeCount(m, 'db'), 1, 'a new entity type was missing after its write');
    assert.equal(m.stats.entities, 3);
  });

  it('an edge write shows on the next read', async () => {
    await mongo.col(`${SPACE}_edges`).insertOne({ _id: 'g1', spaceId: SPACE, from: 'e1', to: 'e3', label: 'uses' });
    const m = await read();
    assert.deepEqual(m.actualSchema.relationships.map(r => [r.from, r.label, r.to]), [['service', 'uses', 'db']]);
    assert.equal(m.stats.edges, 1);
  });

  it('a link write shows on the next read', async () => {
    await mongo.col(`${SPACE}_facts`).insertOne({ _id: 'f1', spaceId: SPACE, fact: 'x' });
    // Read between the two writes, so the LINK write alone is what has to reach the cache.
    assert.equal((await read()).stats.facts, 1);
    await mongo.col(`${SPACE}_links`).insertOne({ _id: 'l1', spaceId: SPACE, from: 'f1', fromKind: 'fact', to: 'e1', toKind: 'entity' });
    const m = await read();
    assert.equal(m.actualSchema.entityTypes.find(t => t.type === 'service').linkedFrom.facts, 1,
      'a link write did not reach the cached answer — `_links` is not observed');
    assert.equal(m.stats.facts, 1);
  });

  it('chrono and files counts follow their writes', async () => {
    // One write per read, so each collection's report is what has to reach the cache on its own.
    await mongo.col(`${SPACE}_chrono`).insertOne({ _id: 'c1', spaceId: SPACE, title: 't' });
    assert.equal((await read()).stats.chrono, 1);
    await mongo.col(`${SPACE}_files`).insertOne({ _id: 'p1', spaceId: SPACE, path: 'a.txt' });
    assert.equal((await read()).stats.files, 1);
  });

  it('a delete shows on the next read', async () => {
    await mongo.col(`${SPACE}_entities`).deleteOne({ _id: 'e3' });
    const m = await read();
    assert.equal(typeCount(m, 'db'), 0);
    assert.equal(m.stats.entities, 2);
  });

  it('a schema edit shows at once, with no record written', async () => {
    const space = loader.getConfig().spaces.find(s => s.id === SPACE);
    space.meta = { typeSchemas: { entity: { service: {}, queue: {} } } };
    const m = await read();
    const queue = m.actualSchema.entityTypes.find(t => t.type === 'queue');
    assert.ok(queue && queue.declared === true && queue.count === 0, 'a newly declared type was missing from the answer');
  });

  it('a write the observer cannot see is covered by reportDatabaseReplaced', async () => {
    await read();
    // A second client is exactly how a restore writes: past `getDb()`, so nothing reports it.
    const { MongoClient } = await import('mongodb');
    const raw = new MongoClient(process.env['MONGO_URI']);
    await raw.connect();
    try {
      await raw.db().collection(`${SPACE}_entities`).insertOne({ _id: 'e9', spaceId: SPACE, name: 'z', type: 'restored' });
    } finally { await raw.close(); }
    mongo.reportDatabaseReplaced();
    assert.equal(typeCount(await read(), 'restored'), 1, 'a replaced database left the cached answer in place');
  });
});
