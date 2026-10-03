/**
 * An entity delete's cascade removes its edges ALL-OR-NOTHING per chunk: an edge is never gone without its
 * tombstone, and a tombstone is never written for an edge still here (`Q-107` part 3b, bundle-30 plan §B3).
 *
 * ## The defect
 *
 * `deleteEntityCascade` (`brain/entity-delete-cascade.ts`) removes the edges one at a time through `deleteEdge`:
 * delete the edge, THEN write its tombstone. A tombstone write that fails after the delete leaves the edge gone
 * with no tombstone — and an edge deleted without one comes back on the next pull from every peer that still holds
 * it, pointing at the entity being deleted: the dangling reference `strictLinkage` refused the plain delete for.
 * The plan puts each chunk of up to 500 edges in ONE held transaction (`deleteMany` + `writeTombstones`), so a
 * failure loses nothing and a re-run continues.
 *
 * ## The rule this file holds — over every edge, whatever the chunking
 *
 * After a cascade whose tombstone write fails part-way, **every edge of the set is either still here with no
 * tombstone, or gone with its tombstone** — the pairing, asserted per edge, so it holds for any chunk size and any
 * order the implementation picks. The edge whose tombstone the store refused is still here, and so is the entity.
 *
 * The fault is REAL (`_write-faults.mjs withValidator`): a validator on `<space>_tombstones` refusing the one
 * tombstone of the middle edge — so a per-edge loop has already removed some edges, with their tombstones, when it
 * meets the refusal, and the edge it was on is the one left without.
 *
 * Run: a Mongo the harness accepts (see `_mongo-harness.mjs`), then
 *      node --test testing/standalone/an-entity-cascade-chunk-is-all-or-nothing-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';
import { withValidator } from './_write-faults.mjs';

const skip = await mongoSkipReason();
process.env['YTHRIL_MODELS_OFFLINE'] = '1';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-cascade-atomic-'));
process.env['CONFIG_PATH'] = path.join(tmpDir, 'config.json');
process.env['DATA_ROOT'] = path.join(tmpDir, 'data');

const SPACE = 'general';
const HUB = 'aaaaaaaa-0000-4000-8000-0000000000a1';
const OTHER = 'aaaaaaaa-0000-4000-8000-0000000000a2';
const EDGES = ['cccccccc-0000-4000-8000-0000000000c1', 'cccccccc-0000-4000-8000-0000000000c2', 'cccccccc-0000-4000-8000-0000000000c3'];
const POISONED = EDGES[1];
const AUTHOR = { instanceId: 'cascade-atomic-test', instanceLabel: 'test' };

let mongo, cascade;
const coll = (n) => mongo.col(`${SPACE}_${n}`);

describe('an entity cascade chunk is all or nothing', { skip }, () => {
  before(async () => {
    mongo = await openTestMongo('cascadeatomic');
    fs.writeFileSync(process.env['CONFIG_PATH'], JSON.stringify({
      instanceId: 'cascade-atomic-test', instanceLabel: 'test', tokens: [], networks: [],
      // `strictLinkage` on: the guard only refuses under it, so the cascade only has anything to do there.
      spaces: [{ id: SPACE, label: 'General', builtIn: true, folders: [], completeLinkage: true, meta: { strictLinkage: true, suppressEmbeddings: true } }],
    }, null, 2), { mode: 0o600 });
    (await import('../../server/dist/config/loader.js')).loadConfig();
    cascade = await import('../../server/dist/brain/entity-delete-cascade.js');
  });
  after(async () => {
    await closeTestMongo();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });
  beforeEach(async () => {
    for (const c of ['entities', 'edges', 'tombstones', 'embed_jobs']) await coll(c).deleteMany({});
    await coll('entities').insertMany([
      { _id: HUB, spaceId: SPACE, name: 'Hub', type: 'thing', tags: [], author: AUTHOR, seq: 1 },
      { _id: OTHER, spaceId: SPACE, name: 'Other', type: 'thing', tags: [], author: AUTHOR, seq: 2 },
    ]);
    await coll('edges').insertMany(EDGES.map((_id, i) => ({
      _id, spaceId: SPACE, from: HUB, to: OTHER, label: `rel_${i}`, tags: [], author: AUTHOR, seq: 3 + i,
    })));
  });

  it('control: the cascade removes every edge with its tombstone when nothing fails', async () => {
    const p = await cascade.previewEntityCascade(SPACE, HUB);
    const r = await cascade.deleteEntityCascade(SPACE, HUB, p.token);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual((await coll('tombstones').find({ type: 'edge' }).toArray()).map(t => t._id).sort(), [...EDGES].sort());
  });

  it('the fault is real: the validator refuses that one tombstone', async () => {
    await withValidator(mongo.getDb(), `${SPACE}_tombstones`, { _id: { $ne: POISONED } }, async () => {
      await assert.rejects(coll('tombstones').insertOne({ _id: POISONED, type: 'edge', seq: 1 }), /validation/i);
      await coll('tombstones').insertOne({ _id: 'free', type: 'edge', seq: 1 });
    });
  });

  it('a tombstone write that fails leaves no edge gone without its tombstone, and the refused one in place', async () => {
    const p = await cascade.previewEntityCascade(SPACE, HUB);
    assert.deepEqual(p.removes.map(r => r._id).sort(), [...EDGES].sort(), 'fixture: the preview does not name the three edges');
    let outcome;
    await withValidator(mongo.getDb(), `${SPACE}_tombstones`, { _id: { $ne: POISONED } }, async () => {
      outcome = await cascade.deleteEntityCascade(SPACE, HUB, p.token).then(v => ({ value: v }), e => ({ error: e }));
    });
    assert.ok(outcome.error || outcome.value?.ok === false,
      `the cascade reported success over a tombstone the store refused: ${JSON.stringify(outcome.value)}`);

    const present = new Set((await coll('edges').find({ _id: { $in: EDGES } }).toArray()).map(e => e._id));
    const tombed = new Set((await coll('tombstones').find({ _id: { $in: EDGES } }).toArray()).map(t => t._id));
    const unpaired = EDGES.filter(id => present.has(id) === tombed.has(id))
      .map(id => `${id}: ${present.has(id) ? 'still here AND tombstoned' : 'GONE with no tombstone'}`);
    assert.deepEqual(unpaired, [],
      'an edge deleted without its tombstone comes back on the next pull from every peer holding it — pointing at the '
      + 'entity this cascade is deleting. A chunk\'s deletes and tombstones must commit together or not at all');
    assert.ok(present.has(POISONED), 'the edge whose tombstone the store refused is gone');
    assert.ok(await coll('entities').findOne({ _id: HUB }), 'the entity was deleted although its cascade did not complete');
  });
});
