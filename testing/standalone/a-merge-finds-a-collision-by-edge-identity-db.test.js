/**
 * A merge finds the absorbed edges that would COLLIDE with the survivor's by the edges' identity — `(from, to,
 * label, fromKind, toKind)`, the unique index — whatever `_id` the survivor's edge is stored under
 * (`Q-107` part 3a, data integrity).
 *
 * ## Why the id is the wrong key
 *
 * Since 3.6 an edge's `_id` is DERIVED from its identity (`edgeIdFor`), so a batched merge is tempted to find
 * collisions by asking for the derived ids it is about to write. Two kinds of stored edge do not carry one: an edge
 * created before 3.6 (a v4 id), and an edge a PEER authored that an earlier merge relinked in place — `rekeyEdge`
 * declines to move a peer's edge, so it keeps an id its identity no longer derives. Looked up by derived id, the
 * collision is invisible; the relinked edge then hits the unique index and the whole merge fails — or, worse, a
 * writer that skips duplicates drops the absorbed edge without the tombstone that tells peers.
 *
 * Today's per-edge loop keys the survivor's edges by `edgeIdFor` of their FIELDS, which is the identity, so the
 * identity cases below are PINS: green on the unchanged code, held for the batched rewrite (`Q-107` part 3a).
 *
 * ## The half that is red today
 *
 * A colliding absorbed edge is deleted with a tombstone, and that tombstone does not carry `originalSeq` — the seq
 * of the record it deletes. `tombstoneDoc`'s docblock calls that the forgettable half: the pull filters a tombstone
 * out for a peer whose watermark never reached the record, and without it that peer is sent deletions for records it
 * never had. The plan's batched `writeTombstones` carries it; the per-edge `writeTombstone` call here omits it.
 *
 * Driven through `executeMerge`, which every merge door calls (`a-refused-merge-answers-alike-on-every-door-db`
 * derives them), in a space initialised as production does so the unique index is real.
 *
 * Run: a Mongo the harness accepts (see `_mongo-harness.mjs`), then
 *      node --test testing/standalone/a-merge-finds-a-collision-by-edge-identity-db.test.js
 * (requires a prior `npm run build` in server/)
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
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-merge-identity-'));
process.env['CONFIG_PATH'] = path.join(tmpDir, 'config.json');
process.env['DATA_ROOT'] = path.join(tmpDir, 'data');

const S = 'mergeidentity';
const INSTANCE = 'merge-identity-test';
const LOCAL = { instanceId: INSTANCE, instanceLabel: 'Here' };
const PEER = { instanceId: 'some-peer', instanceLabel: 'Peer' };
const T0 = '2026-09-01T00:00:00.000Z';

let mongo, merge, edgeIdFor;
let seq = 0;
const coll = (n) => mongo.col(`${S}_${n}`);

const entity = (_id) => ({ _id, spaceId: S, name: `E ${_id.slice(0, 4)}`, type: 'thing', tags: [], properties: {},
  author: LOCAL, createdAt: T0, updatedAt: T0, seq: ++seq });
const edge = (over) => ({ spaceId: S, label: 'knows', fromKind: 'entity', toKind: 'entity', tags: [], author: LOCAL,
  createdAt: T0, updatedAt: T0, seq: ++seq, ...over });

async function runMerge(survivorId, absorbedId) {
  const survivor = await coll('entities').findOne({ _id: survivorId });
  const absorbed = await coll('entities').findOne({ _id: absorbedId });
  return merge.executeMerge(S, survivor, absorbed, {}, undefined);
}

/** The ids stored under one identity — the unique index's key, read back field by field. */
const idsWithIdentity = async (e) => (await coll('edges').find({ from: e.from, to: e.to, label: e.label,
  fromKind: e.fromKind, toKind: e.toKind }, { projection: { _id: 1 } }).toArray()).map(d => d._id);

describe('a merge finds a collision by edge identity', { skip }, () => {
  before(async () => {
    mongo = await openTestMongo('mergeidentity');
    fs.writeFileSync(process.env['CONFIG_PATH'], JSON.stringify({
      instanceId: INSTANCE, instanceLabel: 'Here', tokens: [], networks: [],
      spaces: [{ id: S, label: 'Identity', folders: [], completeLinkage: true, meta: {} }],
    }, null, 2), { mode: 0o600 });
    (await import('../../server/dist/config/loader.js')).loadConfig();
    await (await import('../../server/dist/spaces/lifecycle.js')).initSpace(S, { waitForVectorReady: false });
    merge = await import('../../server/dist/brain/merge.js');
    ({ edgeIdFor } = await import('../../server/dist/brain/edge-id.js'));
  });
  after(async () => {
    await closeTestMongo();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });
  beforeEach(async () => {
    for (const c of ['entities', 'edges', 'links', 'files', 'tombstones', 'embed_jobs']) await coll(c).deleteMany({});
  });

  /** How the survivor's edge is stored: the three ids a stored edge can have. */
  const SURVIVOR_ID = {
    derived: (e) => edgeIdFor(e.from, e.to, e.label, e.fromKind, e.toKind),
    'pre-3.6 v4, authored here': () => randomUUID(),
    'v4, authored by a peer (left in place by an earlier merge)': () => randomUUID(),
  };

  for (const [how, idOf] of Object.entries(SURVIVOR_ID)) {
    for (const end of ['to', 'from']) {
      it(`PIN — the survivor's edge stored with a ${how} id collides at the ${end} end`, async () => {
        const [SURV, ABS, X] = [randomUUID(), randomUUID(), randomUUID()];
        await coll('entities').insertMany([entity(SURV), entity(ABS), entity(X)]);
        const ends = (me) => (end === 'to' ? { from: me, to: X } : { from: X, to: me });
        const kept = edge({ ...ends(SURV), ...(how.includes('peer') ? { author: PEER } : {}) });
        kept._id = idOf(kept);
        const doomed = edge({ ...ends(ABS) });
        doomed._id = edgeIdFor(doomed.from, doomed.to, doomed.label, doomed.fromKind, doomed.toKind);
        await coll('edges').insertMany([kept, doomed]);

        const out = await runMerge(SURV, ABS);

        assert.deepEqual(await idsWithIdentity(kept), [kept._id],
          `after the merge the identity (${end} end, ${how}) is held by ${JSON.stringify(await idsWithIdentity(kept))} — the `
          + "survivor's edge must be the one row left, under the id it was stored with");
        assert.equal(await coll('edges').findOne({ _id: doomed._id }), null, 'the colliding absorbed edge is still stored');
        assert.deepEqual(out.deletedDuplicateEdgeIds, [doomed._id], 'the merge did not report the edge it dropped as a duplicate');
        assert.ok(await coll('tombstones').findOne({ _id: doomed._id, type: 'edge' }),
          'the dropped edge has no tombstone, so a peer still holding it brings it back on the next pull');
      });
    }
  }

  it('PIN — an edge that differs from the survivor\'s only in an endpoint kind is not a collision', async () => {
    // The control: the kinds are part of the identity (and of the unique index), so this one is RELINKED.
    const [SURV, ABS, F] = [randomUUID(), randomUUID(), randomUUID()];
    await coll('entities').insertMany([entity(SURV), entity(ABS)]);
    const factEdge = edge({ from: F, to: SURV, fromKind: 'fact', label: 'about' });
    factEdge._id = randomUUID();
    const entityEdge = edge({ from: F, to: ABS, fromKind: 'entity', label: 'about' });
    entityEdge._id = randomUUID();
    await coll('edges').insertMany([factEdge, entityEdge]);
    const out = await runMerge(SURV, ABS);
    assert.deepEqual(out.deletedDuplicateEdgeIds, [], 'an edge of another endpoint kind was dropped as a duplicate');
    assert.equal((await idsWithIdentity({ ...entityEdge, to: SURV })).length, 1, 'the entity-kind edge was not relinked onto the survivor');
    assert.deepEqual(await idsWithIdentity(factEdge), [factEdge._id], "the survivor's fact-kind edge was touched");
  });

  it('the tombstone of a dropped duplicate carries the seq of the edge it deletes', async () => {
    const [SURV, ABS, X] = [randomUUID(), randomUUID(), randomUUID()];
    await coll('entities').insertMany([entity(SURV), entity(ABS), entity(X)]);
    const kept = edge({ from: SURV, to: X });
    kept._id = randomUUID();
    const doomed = edge({ from: ABS, to: X });
    doomed._id = edgeIdFor(doomed.from, doomed.to, doomed.label, doomed.fromKind, doomed.toKind);
    await coll('edges').insertMany([kept, doomed]);
    await runMerge(SURV, ABS);
    const tomb = await coll('tombstones').findOne({ _id: doomed._id });
    assert.ok(tomb, 'no tombstone for the dropped duplicate');
    assert.equal(tomb.originalSeq, doomed.seq,
      `the duplicate's tombstone carries originalSeq ${tomb.originalSeq}, not the deleted edge's seq ${doomed.seq} — a peer `
      + 'that never received the edge is then sent its deletion');
  });
});
