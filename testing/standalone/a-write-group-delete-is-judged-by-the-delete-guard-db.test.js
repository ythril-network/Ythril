/**
 * A record delete in a write group is judged by the same delete guard every delete uses, against what the group itself writes (`Q-963`;
 * owner D-91; design d, alternative d, vet-2 S2).
 *
 * ## The rule
 *
 * A delete plan (`op: 'delete'`, `planDelete`) commits inside the group's one transaction. Under strict linkage the guard
 * (`entityDeleteBlockers`, batched) runs inside the callback after the group's writes, with the session, so it sees the group's own inserts
 * and deletes: a group that deletes an entity something still names is refused whole (`GroupAborted`, reason `referenced`, naming the
 * blockers) and nothing of it lands; a group that deletes the reference and the entity together lands, the reference's tombstone below the
 * entity's (a peer applies them in that order). There is no implicit cascade: the caller deletes the references in the same group.
 * A fact's links FROM it go in the same transaction as the fact.
 *
 * ## Seen red
 *
 * On the base (afa73cd5a) the group has no delete op: `writeStage` writes a delete plan as a converge, so the entity is stamped, not removed,
 * and the referenced delete is answered as written. Mutations, each restored: the guard call removed from the group (the referenced cases go
 * red); the guard run without the session (the reference-and-entity case goes red: the committed edge still blocks).
 *
 * Run: node --test testing/standalone/a-write-group-delete-is-judged-by-the-delete-guard-db.test.js (a Mongo the harness accepts; `npm run build` in server/)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import {
  SPACE, AUTHOR, openWriteGroupFixture, factId, entityId, factDoc, entityDoc, edgeDoc, insertFact, insertEdge, deleteRecord, settle,
} from './_write-group.mjs';

const skip = await mongoSkipReason();

let fx;
let edgeIdFor;
let linkIdFor;

describe('a write group delete is judged by the delete guard', { skip }, () => {
  before(async () => {
    fx = await openWriteGroupFixture('writegroupguard');
    ({ edgeIdFor } = await import('../../server/dist/brain/edge-id.js'));
    ({ linkIdFor } = await import('../../server/dist/brain/link-id.js'));
  });
  after(async () => { await fx?.cleanup(); });
  beforeEach(async () => { await fx.clear(); });

  /** Two stored entities and a stored edge from the first to the second; returns their ids. */
  async function seedEdge() {
    const a = entityId(1);
    const b = entityId(2);
    await fx.coll('entities').insertMany([{ ...entityDoc(a, 'Ada'), seq: 1 }, { ...entityDoc(b, 'Bea'), seq: 2 }]);
    const edge = { ...edgeDoc(edgeIdFor, a, b, 'knows'), seq: 3 };
    await fx.coll('edges').insertOne(edge);
    return { a, b, edge: edge._id };
  }

  it('a group deleting an entity an edge still names is refused with its blockers, and nothing of it lands', async () => {
    const { b, edge } = await seedEdge();
    const out = await settle(fx.commitGroup([insertFact(factId(1), 'beside the delete'), deleteRecord('entity', b, 2)]));
    assert.equal(await fx.coll('entities').countDocuments({ _id: b }), 1, 'the referenced entity was deleted');
    assert.ok(out.error, 'a group deleting a referenced entity was answered as written');
    assert.equal(out.error.name, 'GroupAborted', `the refusal is not the group's abort: ${out.error.name}: ${out.error.message}`);
    assert.equal(out.error.reason, 'referenced', `the abort is not for a reference: ${out.error.reason}`);
    assert.equal(out.error.recordId, b, 'the abort does not name the entity');
    assert.deepEqual((out.error.blockers ?? []).map(x => `${x.type} ${x._id}`), [`edge ${edge}`], 'the abort does not name the edge that blocks it');
    assert.match(out.error.message, new RegExp(edge), 'the refusal\'s sentence does not name the blocker');
    assert.equal(await fx.coll('facts').countDocuments({}), 0, 'the insert of a refused group landed');
    assert.equal(await fx.coll('tombstones').countDocuments({}), 0, 'a refused group left a tombstone');
    assert.equal((await fx.coll('entities').findOne({ _id: b })).seq, 2, 'the refused group changed the entity');
  });

  it('a group inserting an edge to an entity it deletes is refused: the guard sees the group\'s own writes', async () => {
    const a = entityId(1);
    const c = entityId(3);
    await fx.coll('entities').insertMany([{ ...entityDoc(a, 'Ada'), seq: 1 }, { ...entityDoc(c, 'Cy'), seq: 2 }]);
    const edge = edgeDoc(edgeIdFor, a, c, 'knows');
    const out = await settle(fx.commitGroup([insertEdge(edge), deleteRecord('entity', c, 2)]));
    assert.ok(out.error, 'a group that names an entity it deletes was answered as written');
    assert.equal(out.error.reason, 'referenced', `the abort is not for a reference: ${out.error.name}: ${out.error.message}`);
    assert.deepEqual((out.error.blockers ?? []).map(x => x._id), [edge._id], 'the abort does not name the group\'s own edge');
    assert.equal(await fx.coll('edges').countDocuments({}), 0, 'the edge of a refused group landed');
    assert.equal(await fx.coll('entities').countDocuments({ _id: c }), 1, 'the entity of a refused group was deleted');
  });

  it('a group deleting the edge and the entity together lands, the edge\'s tombstone below the entity\'s', async () => {
    const { b, edge } = await seedEdge();
    const out = await settle(fx.commitGroup([deleteRecord('entity', b, 2), deleteRecord('edge', edge, 3)]));
    assert.equal(out.error, undefined, `the group failed: ${out.error?.name}: ${out.error?.message}`);
    assert.equal(await fx.coll('entities').countDocuments({ _id: b }), 0, 'the entity is still stored');
    assert.equal(await fx.coll('edges').countDocuments({ _id: edge }), 0, 'the edge is still stored');
    const tombs = new Map((await fx.coll('tombstones').find({}).toArray()).map(t => [t._id, t]));
    assert.ok(tombs.get(b) && tombs.get(edge), `a removal has no tombstone (held: ${[...tombs.keys()].join(', ') || 'none'})`);
    assert.equal(tombs.get(b).originalSeq, 2, 'the entity\'s tombstone does not carry the version it buried');
    assert.ok(tombs.get(edge).pos < tombs.get(b).pos, 'the edge\'s tombstone is not below the entity\'s: a peer would remove the entity first');
  });

  it('a group deleting a fact and the entity it links to lands, and the fact\'s link rows go in the same transaction', async () => {
    const ent = entityId(5);
    const fact = factId(5);
    await fx.coll('entities').insertOne({ ...entityDoc(ent, 'Eve'), seq: 1 });
    await fx.coll('facts').insertOne({ ...factDoc(fact, 'Eve wrote it'), seq: 2 });
    const link = linkIdFor(fact, 'fact', ent, 'entity');
    await fx.coll('links').insertOne({ _id: link, spaceId: SPACE, from: fact, fromKind: 'fact', to: ent, toKind: 'entity', author: AUTHOR, seq: 3 });
    const out = await settle(fx.commitGroup([deleteRecord('fact', fact, 2), deleteRecord('entity', ent, 1)]));
    assert.equal(out.error, undefined, `the group failed: ${out.error?.name}: ${out.error?.message}`);
    assert.equal(await fx.coll('facts').countDocuments({ _id: fact }), 0, 'the fact is still stored');
    assert.equal(await fx.coll('entities').countDocuments({ _id: ent }), 0, 'the entity is still stored');
    assert.equal(await fx.coll('links').countDocuments({ _id: link }), 0, 'the deleted fact\'s link row is still stored');
    assert.equal(await fx.coll('tombstones').countDocuments({ _id: link }), 1, 'the deleted fact\'s link row has no tombstone');
  });
});
