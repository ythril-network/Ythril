/**
 * A small entity merges into a survivor whose own edges are far more than one read batch holds (bundle-30 I8,
 * pre-ship performance lens).
 *
 * ## The defect
 *
 * The merge looked for collisions by reading EVERY edge of the survivor, inside its transaction — and a read there
 * must come back in one batch (16 MB, `db/write-bound.ts`). So merging an entity with one edge into a hub of about
 * eighty thousand edges failed as a store error, though it relinks one record. Collisions are found by the identities
 * the relink PRODUCES (at most `MERGE_MAX_RELINKS`), never by the survivor's degree.
 *
 * Asserted with a collision present, so the identity lookup is shown to find one: the absorbed entity's edge that
 * duplicates a survivor edge is deleted, and its other edge relinked.
 *
 * Run: node --test testing/standalone/a-small-entity-merges-into-a-hub-larger-than-a-batch-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';

const skip = await mongoSkipReason();

process.env['YTHRIL_MODELS_OFFLINE'] = '1';
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-merge-bighub-'));
process.env['CONFIG_PATH'] = path.join(tmpDir, 'config.json');
process.env['DATA_ROOT'] = path.join(tmpDir, 'data');

const S = 'mergebighub';
const AUTHOR = { instanceId: 'merge-bighub-test', instanceLabel: 'Here' };
const T0 = '2026-09-01T00:00:00.000Z';
/**
 * Survivor edges: just past what one read batch holds of their identities, and no further — this file shares the test
 * database with every other -db file, and the seed is most of its cost.
 *
 * Measured (bundle-30 I9): the identity projection the old read made, `{_id, from, to, label}` of an edge seeded here
 * (no kinds), is 226 bytes of BSON with this 71-character label, and a batch element costs ~7 bytes more (type byte,
 * decimal index key, NUL). 16 MiB (16 777 216 bytes) holds about 72 000 of them; 75 000 is 17.5 MB, about 4 % past
 * the limit, so the read needed a second batch. With the old survivor read put back by hand: red at 75 000 ("cannot
 * set maxTimeMS on getMore"), green at 70 000 — the boundary sits where the arithmetic puts it.
 */
const HUB_EDGES = 75_000;
const LABEL = 'a-relationship-label-long-enough-that-the-identity-set-passes-one-batch';

let mongo, merge;
const coll = (n) => mongo.col(`${S}_${n}`);

describe('a small entity merges into a hub larger than one read batch', { skip }, () => {
  before(async () => {
    mongo = await openTestMongo('mergebighub');
    fs.writeFileSync(process.env['CONFIG_PATH'], JSON.stringify({
      instanceId: AUTHOR.instanceId, instanceLabel: 'Here', tokens: [], networks: [],
      spaces: [{ id: S, label: 'Big hub', folders: [], meta: { suppressEmbeddings: true } }],
    }, null, 2), { mode: 0o600 });
    (await import('../../server/dist/config/loader.js')).loadConfig();
    await (await import('../../server/dist/spaces/lifecycle.js')).initSpace(S, { waitForVectorReady: false });
    merge = await import('../../server/dist/brain/merge.js');
  });
  after(async () => {
    await closeTestMongo();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it('succeeds, relinking the one edge and deleting the one that collides', { timeout: 240_000 }, async () => {
    const { edgeIdFor } = await import('../../server/dist/brain/edge-id.js');
    let seq = 1;
    const entity = (name) => ({ _id: randomUUID(), spaceId: S, name, type: 'thing', tags: [], properties: {}, author: AUTHOR,
      createdAt: T0, updatedAt: T0, seq: seq++ });
    const survivor = entity('Hub');
    const absorbed = entity('Hub copy');
    await coll('entities').insertMany([survivor, absorbed]);
    const edge = (from, to) => ({ _id: edgeIdFor(from, to, LABEL), spaceId: S, from, to, label: LABEL, tags: [], author: AUTHOR,
      createdAt: T0, updatedAt: T0, seq: seq++ });

    const shared = randomUUID();
    for (let i = 0; i < HUB_EDGES; i += 10_000) {
      const batch = [];
      for (let j = i; j < Math.min(HUB_EDGES, i + 10_000); j++) batch.push(edge(survivor._id, j === 0 ? shared : randomUUID()));
      await coll('edges').insertMany(batch, { ordered: false });
    }
    const lone = randomUUID();
    const collides = edge(absorbed._id, shared);
    const moves = edge(absorbed._id, lone);
    await coll('edges').insertMany([collides, moves]);

    await merge.executeMerge(S, survivor, absorbed, {}, undefined);

    assert.equal(await coll('entities').findOne({ _id: absorbed._id }), null, 'the absorbed entity is still stored');
    assert.equal(await coll('edges').countDocuments({ $or: [{ from: absorbed._id }, { to: absorbed._id }] }), 0,
      'an edge still names the absorbed entity');
    assert.equal(await coll('edges').countDocuments({ from: survivor._id, to: shared }), 1,
      'the colliding edge was relinked into a second copy of a relationship the survivor holds');
    assert.ok(await coll('edges').findOne({ from: survivor._id, to: lone }), 'the absorbed entity\'s own edge did not reach the survivor');
    assert.equal(await coll('edges').countDocuments({ from: survivor._id }), HUB_EDGES + 1);
  });
});
