/**
 * A batch that deletes an edge and then plans the same triplet writes ONE record, converged in place, never two plans of one id
 * (`Q-963`, review A3).
 *
 * ## The rule
 *
 * The edge's identity is its triplet and the kinds of its ends, so the edge a batch re-adds after deleting it is the SAME record. The planner
 * plans a converge onto the deleted record (`planEdge`, `existed: true`, at the version the delete was planned against), and the write group
 * drops the delete: the edge stays stored, at a new version, with the new fields and no tombstone, and the group lands. A record planned twice
 * in any other way is refused by name (`a-write-group-abort-names-its-record-and-is-counted-db`).
 *
 * ## Seen red
 *
 * On 96be09a1c `planEdge` reads the deleted edge as absent and plans an INSERT of the same id: the plan is not a converge, and the group
 * throws a bare `Error` "the edge '...' is planned twice in one group".
 *
 * Run: node --test testing/standalone/a-an-edge-deleted-and-planned-again-in-one-batch-is-converged-db.test.js (a Mongo the harness accepts; `npm run build` in server/)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { SPACE, openWriteGroupFixture, entityId, entityDoc, edgeDoc, settle } from './_write-group.mjs';

const skip = await mongoSkipReason();

let fx;
let m;
const [A, B] = [entityId(1), entityId(2)];

/** The stored edge A -knows-> B at version 10, as a planner stores one (an entity end carries no kind), and a read set that has loaded it and its ends. */
async function stored() {
  await fx.coll('entities').insertMany([{ ...entityDoc(A, 'Ada'), seq: 1 }, { ...entityDoc(B, 'Bo'), seq: 2 }]);
  const id = m.edgeIdFor(A, B, 'knows');
  const doc = { ...edgeDoc(m.edgeIdFor, A, B, 'knows'), _id: id, tags: ['old'], seq: 10 };
  delete doc.fromKind;
  delete doc.toKind;
  await fx.coll('edges').insertOne(doc);
  const input = { from: A, to: B, label: 'knows', tags: ['new'] };
  const rs = new m.ReadSet(SPACE);
  await rs.load({ records: { edge: [id] }, triplets: [{ from: A, to: B, label: 'knows' }] });
  await rs.load(m.edge.edgeWant(SPACE, input));
  return { id, input, rs };
}

describe('an edge deleted and planned again in one batch is converged', { skip }, () => {
  before(async () => {
    fx = await openWriteGroupFixture('edgereinsert');
    m = {
      ReadSet: (await import('../../server/dist/brain/write-plan/read-set.js')).ReadSet,
      edge: await import('../../server/dist/brain/write-plan/plan-edge.js'),
      planDelete: (await import('../../server/dist/brain/write-plan/plan-delete.js')).planDelete,
      edgeIdFor: (await import('../../server/dist/brain/edge-id.js')).edgeIdFor,
    };
  });
  after(async () => { await fx?.cleanup(); });
  beforeEach(async () => { await fx.clear(); });

  it('the planner plans a converge onto the deleted edge, at the version the delete was planned against', async () => {
    const { id, input, rs } = await stored();
    const del = m.planDelete(rs, 'edge', id);
    assert.equal(del.expectSeq, 10, 'premise: the delete is planned against version 10');
    const planned = await m.edge.planEdge(SPACE, input, rs);
    assert.equal(planned.plan.op, 'converge', `the re-added edge is planned as ${planned.plan.op}, not as a converge onto the deleted record`);
    assert.equal(planned.plan.id, id);
    assert.equal(planned.plan.expectSeq, 10);
    assert.equal(planned.existed, true, 'the planner says the triplet was not stored before');
  });

  for (const order of ['delete first', 'converge first']) {
    it(`the group lands, the edge stays stored at a new version with the new fields and no tombstone (${order})`, async () => {
      const { id, input, rs } = await stored();
      const del = m.planDelete(rs, 'edge', id);
      const { plan } = await m.edge.planEdge(SPACE, input, rs);
      const plans = order === 'delete first' ? [del, plan] : [plan, del];
      const out = await settle(fx.commitGroup(plans));
      assert.equal(out.error, undefined, `the group failed: ${out.error?.name}: ${out.error?.message}`);
      const edges = await fx.coll('edges').find({}).toArray();
      assert.deepEqual(edges.map(e => e._id), [id], 'the edges after the group are not the one edge');
      assert.ok(edges[0].seq > 10, `the edge was not written (still at version ${edges[0].seq})`);
      assert.deepEqual([...edges[0].tags].sort(), ['new', 'old'], 'the edge does not hold the merge of its tags');
      assert.equal(await fx.coll('tombstones').countDocuments({ _id: id }), 0, 'a tombstone for the edge that stayed was written: every peer would delete it');
      assert.equal(out.value.seqs[order === 'delete first' ? 0 : 1], 0, 'a delete that was dropped reports a version');
      assert.equal(out.value.seqs[order === 'delete first' ? 1 : 0], edges[0].seq, 'the converge does not report the version it landed at');
    });
  }
});
