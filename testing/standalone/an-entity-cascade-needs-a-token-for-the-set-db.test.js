/**
 * An entity delete can take its edges — only when it quotes back a token for exactly the set it was shown.
 *
 * ## The ruling, and why the shape IS the ruling
 *
 * Owner, 2026-09-02 (`P-29`): *"a preview that returns what WOULD go, then a delete that quotes back a token
 * from the preview."* Not a flag, and the reason is that the guard's whole value is the pause: an entity is a
 * hub, the records a cascade would remove are not visible in the call, there is no undo, and a flag saying
 * *"I looked"* cannot be checked. A token from a preview can be.
 *
 * The reporter this came from spent four probes — `?cascade=true`, `?force=true`, `?deleteEdges=true`,
 * `?withEdges=true` — before implementing clear-then-delete by hand, because the `409` listed the blocking
 * ids and said nothing about a cascade existing at all.
 *
 * ## The token is bound to the SET, and that is the whole property
 *
 * *"A token that still validates after somebody adds an edge would authorise removing a record the operator
 * never saw. That is the whole point of the two steps, so an expiry alone is not enough."*
 *
 * So it is a hash over the space, the entity and the SORTED blocking set — deterministic, unstored, and with
 * no expiry, because those three choices each follow from the property rather than from convenience:
 *
 *   - **deterministic** — nothing to store, so nothing to leak, expire wrongly, or lose on a restart. A
 *     stored token would also need a sweep, and a sweep that lapses turns a refusal into an acceptance.
 *   - **no secret** — the token proves the caller saw THIS set. Anyone who can compute it already knows the
 *     set, and knowing the set is the thing being proved. The `409` prints the ids too, deliberately.
 *   - **no expiry** — a token that still matches means the set has not moved, which is exactly when the
 *     operator's decision is still good. An expiry would refuse a correct decision and accept a stale one
 *     whenever the clock happened to agree.
 *
 * Run: node --test testing/standalone/an-entity-cascade-needs-a-token-for-the-set-db.test.js
 * (requires a prior `npm run build` in server/, and a reachable mongod)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';

const skip = await mongoSkipReason();

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-cascade-'));
const CONFIG_PATH = path.join(tmpDir, 'config.json');
process.env['CONFIG_PATH'] = CONFIG_PATH;

const SPACE = 'general';
const ENT = 'aaaaaaaa-0000-4000-8000-000000000001';
const OTHER = 'aaaaaaaa-0000-4000-8000-000000000002';
const E1 = 'cccccccc-0000-4000-8000-000000000001';
const E2 = 'cccccccc-0000-4000-8000-000000000002';
const AUTHOR = { instanceId: 'cascade-test', instanceLabel: 'test' };

let mongo, cascade, entities;

const coll = (n) => mongo.col(`${SPACE}_${n}`);

describe('an entity cascade needs a token for the set', { skip }, () => {
  before(async () => {
    mongo = await openTestMongo('cascade');
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({
      instanceId: 'cascade-test', instanceLabel: 'test', tokens: [], networks: [],
      // `strictLinkage` on: the guard only refuses under it, so the cascade only has anything to do there.
      spaces: [{ id: SPACE, label: 'General', builtIn: true, folders: [], completeLinkage: true, meta: { strictLinkage: true } }],
    }, null, 2), { mode: 0o600 });
    const loader = await import('../../server/dist/config/loader.js');
    loader.loadConfig();
    cascade = await import('../../server/dist/brain/entity-delete-cascade.js');
    entities = await import('../../server/dist/brain/entities.js');
  });

  after(async () => {
    await closeTestMongo();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  beforeEach(async () => {
    for (const c of ['entities', 'edges', 'facts', 'chrono', 'files', 'links', 'tombstones']) {
      await coll(c).deleteMany({});
    }
    await coll('entities').insertMany([
      { _id: ENT, spaceId: SPACE, name: 'Hub', type: 'thing', tags: [], author: AUTHOR, seq: 1 },
      { _id: OTHER, spaceId: SPACE, name: 'Other', type: 'thing', tags: [], author: AUTHOR, seq: 2 },
    ]);
    await coll('edges').insertMany([
      { _id: E1, spaceId: SPACE, from: ENT, to: OTHER, label: 'knows', tags: [], author: AUTHOR, seq: 3 },
      { _id: E2, spaceId: SPACE, from: OTHER, to: ENT, label: 'knows_back', tags: [], author: AUTHOR, seq: 4 },
    ]);
  });

  it('the module exports the three parts', () => {
    assert.equal(typeof cascade.previewEntityCascade, 'function', 'the preview');
    assert.equal(typeof cascade.deleteEntityCascade, 'function', 'the delete');
    assert.equal(typeof cascade.cascadeTokenFor, 'function', 'the token, so both halves derive it one way');
  });

  it('the preview returns exactly what would go, and a token', async () => {
    const p = await cascade.previewEntityCascade(SPACE, ENT);
    assert.deepEqual(p.removes.map(r => `${r.type}:${r._id}`).sort(), [`edge:${E1}`, `edge:${E2}`].sort(),
      'the preview must return the SAME set the 409 computes — a preview that differs from the refusal is '
      + 'worse than none, because the operator approves a list the delete does not use');
    assert.ok(typeof p.token === 'string' && p.token.length >= 16, 'and a token bound to that set');
    assert.equal(p.entityId, ENT);
  });

  it('the token is DERIVED from the set, so both halves compute it the same way', async () => {
    const p = await cascade.previewEntityCascade(SPACE, ENT);
    assert.equal(p.token, cascade.cascadeTokenFor(SPACE, ENT, p.removes),
      'the preview mints a token the verifier cannot reproduce — two implementations of one rule, and the '
      + 'weaker one decides whether a delete is allowed');
  });

  it('the delete goes through with the right token, and takes the edges', async () => {
    const p = await cascade.previewEntityCascade(SPACE, ENT);
    const r = await cascade.deleteEntityCascade(SPACE, ENT, p.token);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(await coll('entities').countDocuments({ _id: ENT }), 0, 'the entity is gone');
    assert.equal(await coll('edges').countDocuments({}), 0, 'and both edges with it');
    assert.equal(await coll('entities').countDocuments({ _id: OTHER }), 1,
      'the entity at the OTHER end of each edge is NOT touched — a cascade takes the relationships, not the '
      + 'records they join');
  });

  it('a tombstone is written for every edge it removed', async () => {
    // Without one, the next pull from any peer that still holds the edge brings it back — pointing at an
    // entity that no longer exists, which is the dangling reference `strictLinkage` refused the delete for.
    const p = await cascade.previewEntityCascade(SPACE, ENT);
    await cascade.deleteEntityCascade(SPACE, ENT, p.token);
    const tombs = await coll('tombstones').find({ type: 'edge' }).toArray();
    assert.deepEqual(tombs.map(t => t._id).sort(), [E1, E2].sort(),
      'an edge deleted without a tombstone comes back on the next sync cycle');
  });

  it('REFUSES a token for a set that has since changed — the whole point of two steps', async () => {
    const p = await cascade.previewEntityCascade(SPACE, ENT);
    // Somebody adds an edge between the preview and the delete. The operator never saw it.
    await coll('edges').insertOne({
      _id: 'cccccccc-0000-4000-8000-000000000003', spaceId: SPACE,
      from: ENT, to: OTHER, label: 'added_later', tags: [], author: AUTHOR, seq: 9,
    });
    const r = await cascade.deleteEntityCascade(SPACE, ENT, p.token);
    assert.equal(r.ok, false, 'a stale token was accepted, so the cascade removed a record nobody approved');
    assert.match(r.error, /preview|changed|stale/i, 'and the refusal must say the list moved');
    assert.equal(await coll('entities').countDocuments({ _id: ENT }), 1, 'nothing was deleted');
    assert.equal(await coll('edges').countDocuments({}), 3, 'including the edge that arrived');
  });

  it('REFUSES a token from a different entity', async () => {
    const p = await cascade.previewEntityCascade(SPACE, OTHER);
    const r = await cascade.deleteEntityCascade(SPACE, ENT, p.token);
    assert.equal(r.ok, false, "a token for one entity authorised deleting another's edges");
    assert.equal(await coll('edges').countDocuments({}), 2);
  });

  it('REFUSES a missing or malformed token rather than defaulting to allow', async () => {
    for (const t of [undefined, '', 'not-a-token', null]) {
      const r = await cascade.deleteEntityCascade(SPACE, ENT, t);
      assert.equal(r.ok, false, `token ${JSON.stringify(t)} was accepted`);
    }
    assert.equal(await coll('edges').countDocuments({}), 2);
  });

  it('an entity with NOTHING pointing at it still needs a token', async () => {
    /*
     * The tempting shortcut is to let an empty set through without one, since nothing would be removed. It
     * would also mean the delete behaves differently depending on a race: the operator calls it, an edge
     * lands, and the same call now takes a record they never saw — which is the exact failure the token
     * exists for, arriving through the case that looked safe.
     */
    await coll('edges').deleteMany({});
    const bare = await cascade.deleteEntityCascade(SPACE, ENT, undefined);
    assert.equal(bare.ok, false, 'an empty cascade set is still a set, and the token still binds to it');

    const p = await cascade.previewEntityCascade(SPACE, ENT);
    assert.deepEqual(p.removes, [], 'the preview says nothing would go');
    const r = await cascade.deleteEntityCascade(SPACE, ENT, p.token);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(await coll('entities').countDocuments({ _id: ENT }), 0);
  });

  it('FACE labels are unlabelled, not deleted — the exemption the guard already makes', async () => {
    /*
     * `entityDeleteBlockers` reports face records and does not block on them: a face label is an annotation
     * the system inferred, and blocking would make "delete this person" the one thing an operator cannot do
     * for the subject whose data is biometric. A cascade must not delete them either — the record is a photo.
     */
    await coll('edges').deleteMany({});
    await coll('files').insertOne({
      _id: 'photos/party.jpg#face0', spaceId: SPACE, path: 'photos/party.jpg#face0',
      parentFileId: 'photos/party.jpg', faceEntityId: ENT, tags: [], seq: 7,
    });
    const p = await cascade.previewEntityCascade(SPACE, ENT);
    assert.ok(!p.removes.some(r => r.type === 'face'),
      'a face label is not part of the cascade set — it is unlabelled by the delete, not removed');
    const r = await cascade.deleteEntityCascade(SPACE, ENT, p.token);
    assert.equal(r.ok, true, JSON.stringify(r));
    const face = await coll('files').findOne({ _id: 'photos/party.jpg#face0' });
    assert.ok(face, 'the photo must survive');
    assert.equal(face.faceEntityId, undefined, 'and be unlabelled');
  });
});
