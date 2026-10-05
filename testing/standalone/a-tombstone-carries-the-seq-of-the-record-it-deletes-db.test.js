/**
 * Every tombstone a merge or a link reconcile writes carries `originalSeq` — the seq of the record it deletes
 * (Q-361 item 14).
 *
 * ## Why the field is not optional
 *
 * `tombstoneDoc`'s docblock calls it the forgettable half. The tombstone page a peer pulls filters a tombstone out when
 * the peer's watermark never reached the record it deletes (`originalSeq > since` is the test; an UNDEFINED one always
 * passes). So a tombstone written without it is offered to every peer — including one that never held the record — as a
 * deletion, and the same record on a peer that did hold it is deleted by a tombstone that cannot say which version it
 * meant. `deleteEdge` and the plain deletes carry it; four other writers of a tombstone did not:
 *
 *  - the DUPLICATE edge a merge drops because the survivor already has the same one (`merge.ts`);
 *  - the LINK a merge moves off the absorbed entity — it is re-keyed, and the old id is tombstoned (`merge.ts`);
 *  - the ABSORBED ENTITY itself (`merge.ts`, phase 5);
 *  - the LINK a reconcile removes because the record no longer names its target (`links.ts` `reconcileLinks`), whose read
 *    of the existing set projected `_id` alone and so had no seq to carry.
 *
 * Each is asserted on the record it deletes, read BEFORE the operation, so an `originalSeq` that is merely present but
 * wrong (the tombstone's own seq, the survivor's) fails too.
 *
 * Driven through `executeMerge`, which every merge door calls, and `reconcileLinks`, in a space initialised as production
 * does so the unique indexes are real.
 *
 * Seen red on 6eb5a333 (5.6.3): all four tombstones carry no `originalSeq`.
 *
 * Run: node --test testing/standalone/a-tombstone-carries-the-seq-of-the-record-it-deletes-db.test.js
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';

const skip = await mongoSkipReason();

process.env['YTHRIL_MODELS_OFFLINE'] = '1';
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-tomb-seq-'));
process.env['CONFIG_PATH'] = path.join(tmpDir, 'config.json');
process.env['DATA_ROOT'] = path.join(tmpDir, 'data');

const S = 'tombseq';
const INSTANCE = 'tomb-seq-test';
const LOCAL = { instanceId: INSTANCE, instanceLabel: 'Here' };
const T0 = '2026-09-01T00:00:00.000Z';

let mongo, merge, links, edgeIdFor, linkIdFor;
let seq = 100;
const coll = (n) => mongo.col(`${S}_${n}`);

const entity = (_id) => ({ _id, spaceId: S, name: `E ${_id.slice(0, 4)}`, type: 'thing', tags: [], properties: {},
  author: LOCAL, createdAt: T0, updatedAt: T0, seq: ++seq });
const edge = (over) => ({ spaceId: S, label: 'knows', fromKind: 'entity', toKind: 'entity', tags: [], author: LOCAL,
  createdAt: T0, updatedAt: T0, seq: ++seq, ...over });
const link = (from, fromKind, to, toKind) => ({ _id: linkIdFor(from, fromKind, to, toKind), spaceId: S, from, fromKind, to, toKind,
  author: LOCAL, createdAt: T0, updatedAt: T0, seq: ++seq });

async function runMerge(survivorId, absorbedId) {
  const survivor = await coll('entities').findOne({ _id: survivorId });
  const absorbed = await coll('entities').findOne({ _id: absorbedId });
  return merge.executeMerge(S, survivor, absorbed, {}, undefined);
}

describe('a tombstone carries the seq of the record it deletes', { skip }, () => {
  before(async () => {
    mongo = await openTestMongo('tombseq');
    fs.writeFileSync(process.env['CONFIG_PATH'], JSON.stringify({
      instanceId: INSTANCE, instanceLabel: 'Here', tokens: [], networks: [],
      spaces: [{ id: S, label: 'Tomb seq', folders: [], completeLinkage: true, meta: {} }],
    }, null, 2), { mode: 0o600 });
    (await import('../../server/dist/config/loader.js')).loadConfig();
    await (await import('../../server/dist/spaces/lifecycle.js')).initSpace(S, { waitForVectorReady: false });
    merge = await import('../../server/dist/brain/merge.js');
    links = await import('../../server/dist/brain/links.js');
    ({ edgeIdFor } = await import('../../server/dist/brain/edge-id.js'));
    ({ linkIdFor } = links);
  });
  after(async () => {
    await closeTestMongo();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });
  beforeEach(async () => {
    for (const c of ['entities', 'edges', 'links', 'facts', 'files', 'tombstones', 'embed_jobs']) await coll(c).deleteMany({});
  });

  it('a duplicate edge a merge drops: its tombstone carries the seq of that edge', async () => {
    const [SURV, ABS, X] = [randomUUID(), randomUUID(), randomUUID()];
    await coll('entities').insertMany([entity(SURV), entity(ABS), entity(X)]);
    const kept = edge({ from: SURV, to: X });
    kept._id = randomUUID();
    const doomed = edge({ from: ABS, to: X });
    doomed._id = edgeIdFor(doomed.from, doomed.to, doomed.label, doomed.fromKind, doomed.toKind);
    await coll('edges').insertMany([kept, doomed]);
    const out = await runMerge(SURV, ABS);
    assert.deepEqual(out.deletedDuplicateEdgeIds, [doomed._id], 'fixture check: the merge did not drop the duplicate');
    const tomb = await coll('tombstones').findOne({ _id: doomed._id });
    assert.ok(tomb, 'no tombstone for the dropped duplicate');
    assert.equal(tomb.originalSeq, doomed.seq, `the duplicate's tombstone carries originalSeq ${tomb.originalSeq}, not the deleted edge's seq ${doomed.seq}`);
  });

  it('a link a merge moves off the absorbed entity: the old id\'s tombstone carries the seq of that link', async () => {
    const [SURV, ABS, F] = [randomUUID(), randomUUID(), randomUUID()];
    await coll('entities').insertMany([entity(SURV), entity(ABS)]);
    const old = link(F, 'fact', ABS, 'entity');
    await coll('links').insertOne(old);
    await runMerge(SURV, ABS);
    assert.ok(await coll('links').findOne({ _id: linkIdFor(F, 'fact', SURV, 'entity') }), 'fixture check: the link was not moved onto the survivor');
    const tomb = await coll('tombstones').findOne({ _id: old._id, type: 'link' });
    assert.ok(tomb, 'no tombstone for the moved link\'s old id');
    assert.equal(tomb.originalSeq, old.seq, `the moved link's tombstone carries originalSeq ${tomb.originalSeq}, not the link's seq ${old.seq}`);
  });

  it('the absorbed entity: its tombstone carries the seq the entity held', async () => {
    const [SURV, ABS] = [randomUUID(), randomUUID()];
    const absorbed = entity(ABS);
    await coll('entities').insertMany([entity(SURV), absorbed]);
    await runMerge(SURV, ABS);
    const tomb = await coll('tombstones').findOne({ _id: ABS, type: 'entity' });
    assert.ok(tomb, 'no tombstone for the absorbed entity');
    assert.equal(tomb.originalSeq, absorbed.seq, `the absorbed entity's tombstone carries originalSeq ${tomb.originalSeq}, not its seq ${absorbed.seq}`);
  });

  it('a link a reconcile removes: its tombstone carries the seq of that link', async () => {
    const [F, E] = [randomUUID(), randomUUID()];
    await coll('entities').insertOne(entity(E));
    const old = link(F, 'fact', E, 'entity');
    await coll('links').insertOne(old);
    // The fact no longer names the entity: an authoritative write of an empty set detaches it.
    const out = await links.reconcileLinks(S, F, 'fact', { entity: [] }, LOCAL);
    assert.equal(out.removed, 1, `fixture check: the reconcile removed ${out.removed} link(s)`);
    const tomb = await coll('tombstones').findOne({ _id: old._id, type: 'link' });
    assert.ok(tomb, 'no tombstone for the removed link');
    assert.equal(tomb.originalSeq, old.seq, `the removed link's tombstone carries originalSeq ${tomb.originalSeq}, not the link's seq ${old.seq}`);
  });

  it('PIN a link that carries no seq (written before seqs) is tombstoned without one, as it must be', async () => {
    const [F, E] = [randomUUID(), randomUUID()];
    await coll('entities').insertOne(entity(E));
    const old = link(F, 'fact', E, 'entity');
    delete old.seq;
    await coll('links').insertOne(old);
    const out = await links.reconcileLinks(S, F, 'fact', { entity: [] }, LOCAL);
    assert.equal(out.removed, 1);
    const tomb = await coll('tombstones').findOne({ _id: old._id, type: 'link' });
    assert.ok(tomb, 'no tombstone for the removed link');
    assert.equal(tomb.originalSeq, undefined, 'an originalSeq was invented for a link that never had a seq');
  });
});