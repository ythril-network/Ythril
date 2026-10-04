/**
 * An edge a merge moves onto the survivor keeps its vector — re-keyed or relinked in place (`Q-107` part 3a, PIN).
 *
 * ## Why this is pinned before the rewrite
 *
 * A merge relinks every edge of the absorbed entity. One authored HERE is RE-KEYED (`rekeyEdge`: deleted and
 * inserted under the id its new identity derives), and the re-inserted document is the stored one carried forward —
 * vector included — because dropping it would take the edge out of meaning-ranked search until the queue caught up,
 * on every merge. One authored by a PEER is relinked in place, and an in-place `$set` of its endpoints leaves the
 * vector where it is.
 *
 * The batched merge (`Q-107` part 3a) changes exactly the read this depends on: it reads the SURVIVOR's edges
 * projected to their identity (a hub's vectors would otherwise all ride into the transaction for a collision check),
 * and must read the ABSORBED edges WITH their vectors, because those are re-inserted from what was read. Projecting
 * both the same way is the natural mistake and the one nothing else would notice: the merge succeeds, every edge is
 * where it should be, and each re-keyed edge silently has no vector.
 *
 * Green on the unchanged code; seen red with the absorbed-edge read projected to drop `embedding`.
 *
 * Run: a Mongo the harness accepts (see `_mongo-harness.mjs`), then
 *      node --test testing/standalone/a-merged-edge-keeps-its-vector-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';
import { seedHub, vectorOf } from './_merge-hub.mjs';

const skip = await mongoSkipReason();

process.env['YTHRIL_MODELS_OFFLINE'] = '1';
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-merge-vectors-'));
process.env['CONFIG_PATH'] = path.join(tmpDir, 'config.json');
process.env['DATA_ROOT'] = path.join(tmpDir, 'data');

const S = 'mergevectors';
const INSTANCE = 'merge-vectors-test';
const LOCAL = { instanceId: INSTANCE, instanceLabel: 'Here' };
const PEER = { instanceId: 'some-peer', instanceLabel: 'Peer' };
const DIMS = 768;

let mongo, merge;
const coll = (n) => mongo.col(`${S}_${n}`);

describe('a merged edge keeps its vector', { skip }, () => {
  before(async () => {
    mongo = await openTestMongo('mergevectors');
    fs.writeFileSync(process.env['CONFIG_PATH'], JSON.stringify({
      instanceId: INSTANCE, instanceLabel: 'Here', tokens: [], networks: [],
      spaces: [{ id: S, label: 'Vectors', folders: [], completeLinkage: true, meta: {} }],
    }, null, 2), { mode: 0o600 });
    (await import('../../server/dist/config/loader.js')).loadConfig();
    await (await import('../../server/dist/spaces/lifecycle.js')).initSpace(S, { waitForVectorReady: false });
    merge = await import('../../server/dist/brain/merge.js');
  });
  after(async () => {
    await closeTestMongo();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it('PIN — re-keyed edges (authored here) and edges relinked in place (a peer\'s) both arrive with their vectors', async () => {
    const hub = await seedHub({ coll, space: S, author: LOCAL, edges: 5, vectorDims: DIMS });
    const peerVector = vectorOf(DIMS, 0.91);
    const peerEdge = { _id: randomUUID(), spaceId: S, from: hub.absorbedId, to: randomUUID(), label: 'rel', tags: [],
      author: PEER, createdAt: 'x', updatedAt: 'x', seq: hub.maxSeq + 1, embedding: peerVector, embeddingModel: 'seeded' };
    await coll('edges').insertOne(peerEdge);
    const before_ = new Map((await coll('edges').find({ from: hub.absorbedId }).toArray()).map(e => [e.to, e]));
    assert.equal(before_.size, 6, 'the seed did not store six edges');

    const survivor = await coll('entities').findOne({ _id: hub.survivorId });
    const absorbed = await coll('entities').findOne({ _id: hub.absorbedId });
    await merge.executeMerge(S, survivor, absorbed, {}, undefined);

    const after_ = new Map((await coll('edges').find({ from: hub.survivorId }).toArray()).map(e => [e.to, e]));
    assert.deepEqual([...after_.keys()].sort(), [...before_.keys()].sort(), 'not every edge reached the survivor');
    let rekeyed = 0;
    for (const [to, was] of before_) {
      const now = after_.get(to);
      if (now._id !== was._id) rekeyed++;
      const kind = now._id !== was._id ? 're-keyed' : 'relinked in place';
      assert.ok(Array.isArray(now.embedding) && now.embedding.length === DIMS,
        `the ${kind} edge to ${to} lost its vector (${now.embedding === undefined ? 'absent' : `length ${now.embedding?.length}`})`);
      assert.deepEqual(now.embedding, was.embedding, `the ${kind} edge to ${to} carries a different vector`);
      assert.equal(now.embeddingModel, was.embeddingModel, `the ${kind} edge to ${to} lost its embedding model`);
    }
    // Both mechanisms must have run, or the case proved half of what it says.
    assert.equal(rekeyed, 5, `${rekeyed} edge(s) were re-keyed; the five authored here should all have been`);
    assert.equal(after_.get(peerEdge.to)._id, peerEdge._id, "the peer's edge was moved rather than relinked in place");
  });
});
