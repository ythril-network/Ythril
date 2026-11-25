/**
 * A record delete is a planned op that lands inside a write group's one transaction, or aborts the group whole (`Q-963`; design-r2 R6, R9;
 * vet-2 S7, S11).
 *
 * ## The rule
 *
 * - **A stale delete aborts and sends no tombstone.** The removal is filtered by the version it was planned against (`{_id, seq}`), and
 *   `removeWithTombstones` returns its count: a record changed since it was planned is not removed, the group aborts `stale` naming it,
 *   and no tombstone for the still-live row leaves the transaction.
 * - **Deletes run before inserts.** A functional edge swapped in one group (the old one deleted, the new one under the same write guard
 *   inserted) lands: the old edge leaves the unique guard before the new one takes it. The read set agrees (`noteDeleted`): the deleted
 *   edge is no longer counted at its subject, its triplet and its existence are gone.
 * - **What was written to a deleted entity meanwhile is taken back after the commit.** The removal's after-commit tail is the one
 *   `removeRecords` runs (`settleReferencesToRemovedEntity` with `began`), so an edge another writer landed to the entity while the group
 *   committed is removed.
 * - **Deletes and the forks they settle count in the ceilings.** A delete writes its removal and a tombstone; each unresolved version of the
 *   record goes with it the same way. A group whose forks pass the operation ceiling is refused before a session opens.
 *
 * ## Seen red
 *
 * On the base (afa73cd5a) a delete plan is written as a converge: the record is stamped, not removed, so the landing cases fail; `planDelete`
 * does not exist; a delete counts one operation. Mutations, each restored: the short-count check in `removeInSession` removed (the stale case
 * goes red: a tombstone for the live row lands); the removal tail not run by the group (the concurrent edge stays). The swap is red on the
 * base, where the delete is no removal and the insert meets the guard's unique index.
 *
 * Run: node --test testing/standalone/a-write-group-delete-lands-whole-or-aborts-db.test.js (a Mongo the harness accepts; `npm run build` in server/)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import {
  SPACE, openWriteGroupFixture, factId, entityId, factDoc, entityDoc, edgeDoc, insertFact, insertEdge, deleteRecord, settle, countTransactions,
} from './_write-group.mjs';

const skip = await mongoSkipReason();
const SLOW = 120_000;

let fx;
let edgeIdFor;

describe('a write group delete lands whole or aborts', { skip }, () => {
  before(async () => {
    fx = await openWriteGroupFixture('writegroupdelete');
    ({ edgeIdFor } = await import('../../server/dist/brain/edge-id.js'));
  });
  after(async () => { await fx?.cleanup(); });
  beforeEach(async () => { await fx.clear(); });

  it('a stale delete aborts the group naming the record, and no tombstone for the live row lands; planned at its version it lands', async () => {
    const moved = factId(1);
    await fx.coll('facts').insertOne({ ...factDoc(moved, 'changed since it was planned'), seq: 4 });
    const out = await settle(fx.commitGroup([insertFact(factId(2), 'beside it'), deleteRecord('fact', moved, 3)]));
    assert.equal(await fx.coll('facts').countDocuments({ _id: moved }), 1, 'the stale delete removed the record');
    assert.equal(await fx.coll('tombstones').countDocuments({ _id: moved }), 0, 'a tombstone for the live row landed: every peer would delete it');
    assert.ok(out.error, 'a group with a stale delete was answered as written');
    assert.equal(out.error.name, 'GroupAborted');
    assert.equal(out.error.reason, 'stale');
    assert.equal(out.error.recordId, moved, 'the abort does not name the record that moved');
    assert.equal(await fx.coll('facts').countDocuments({ _id: factId(2) }), 0, 'the insert of an aborted group landed');

    const again = await settle(fx.commitGroup([deleteRecord('fact', moved, 4)]));
    assert.equal(again.error, undefined, `the delete at the stored version failed: ${again.error?.name}: ${again.error?.message}`);
    assert.equal(await fx.coll('facts').countDocuments({ _id: moved }), 0, 'the delete planned at the stored version did not remove the record');
    const tomb = await fx.coll('tombstones').findOne({ _id: moved });
    assert.ok(tomb, 'the removed record has no tombstone');
    assert.equal(tomb.originalSeq, 4, 'the tombstone does not carry the version it buried');
  });

  it('a functional edge swapped in one group lands: the old edge leaves the write guard before the new one takes it', async () => {
    const { EDGE_GUARD_INDEXES } = await import('../../server/dist/spaces/edge-guard-index.js');
    const { functionalSubjectKey } = await import('../../server/dist/brain/functional-subject.js');
    for (const ix of EDGE_GUARD_INDEXES) await fx.coll('edges').createIndex(ix.keys, ix.options);
    const [a, b, c] = [entityId(1), entityId(2), entityId(3)];
    await fx.coll('entities').insertMany([1, 2, 3].map(n => ({ ...entityDoc(entityId(n), `E${n}`), seq: n })));
    const guard = functionalSubjectKey(a, 'worksAt');
    const old = { ...edgeDoc(edgeIdFor, a, b, 'worksAt', { guard }), seq: 10 };
    await fx.coll('edges').insertOne(old);
    const swapped = edgeDoc(edgeIdFor, a, c, 'worksAt', { guard });
    const out = await settle(fx.commitGroup([insertEdge(swapped), deleteRecord('edge', old._id, 10)]));
    assert.equal(out.error, undefined, `the swap failed: ${out.error?.name}: ${out.error?.message}`);
    assert.deepEqual((await fx.coll('edges').find({}).toArray()).map(e => e._id), [swapped._id], 'the edges after the swap are not the new one alone');
  });

  it('the read set sees a planned delete: the edge is gone from its subject\'s count, its triplet and its existence', async () => {
    const { ReadSet } = await import('../../server/dist/brain/write-plan/read-set.js');
    const planDelete = (await import('../../server/dist/brain/write-plan/plan-delete.js').catch(() => ({}))).planDelete;
    assert.equal(typeof planDelete, 'function', 'there is no planDelete (brain/write-plan/plan-delete.ts)');
    const [a, b, c] = [entityId(1), entityId(2), entityId(3)];
    const old = { ...edgeDoc(edgeIdFor, a, b, 'worksAt'), seq: 10 };
    await fx.coll('edges').insertOne(old);
    const rs = new ReadSet(SPACE);
    const triplet = { from: a, to: b, label: 'worksAt', fromKind: 'entity', toKind: 'entity' };
    await rs.load({ records: { edge: [old._id] }, triplets: [triplet], functional: [{ from: a, label: 'worksAt' }] });
    const next = { from: a, to: c, label: 'worksAt', fromKind: 'entity', toKind: 'entity' };
    assert.equal(rs.otherEdgesFromSubject(next), 1, 'premise: the stored edge is counted at its subject');
    const plan = planDelete(rs, 'edge', old._id);
    assert.deepEqual({ op: plan.op, kind: plan.kind, id: plan.id, expectSeq: plan.expectSeq }, { op: 'delete', kind: 'edge', id: old._id, expectSeq: 10 });
    assert.equal(rs.otherEdgesFromSubject(next), 0, 'the deleted edge is still counted at its subject: the swap would be refused as a second edge');
    assert.equal(rs.triplet(triplet), null, 'the deleted edge\'s triplet is still held');
    assert.deepEqual(rs.missing('edge', [old._id]), [old._id], 'the deleted edge still exists to the read set');
  });

  it('an edge written to the entity while the group committed is taken back after the commit', async () => {
    const [a, gone] = [entityId(1), entityId(2)];
    await fx.coll('entities').insertMany([{ ...entityDoc(a, 'Ada'), seq: 1 }, { ...entityDoc(gone, 'Gil'), seq: 2 }]);
    const late = edgeDoc(edgeIdFor, a, gone, 'knows');
    // Another writer's edge lands after the guard read and before the group's commit: written without the group's session, as a door's would be.
    const session = fx.mongo.getMongo().startSession();
    const proto = Object.getPrototypeOf(session);
    void session.endSession();
    const commitOriginal = proto.commitTransaction;
    let planted = false;
    proto.commitTransaction = async function plantThenCommit(...args) {
      if (!planted) {
        planted = true;
        await fx.commit.writeStage(SPACE, 'edge', [insertEdge(late)]);
      }
      return commitOriginal.apply(this, args);
    };
    let out;
    try { out = await settle(fx.commitGroup([deleteRecord('entity', gone, 2)])); } finally { proto.commitTransaction = commitOriginal; }
    assert.ok(planted, 'fixture: the concurrent edge was not written');
    assert.equal(out.error, undefined, `the group failed: ${out.error?.name}: ${out.error?.message}`);
    assert.equal(await fx.coll('entities').countDocuments({ _id: gone }), 0, 'the entity is still stored');
    assert.equal(await fx.coll('edges').countDocuments({ _id: late._id }), 0, 'the edge written to the deleted entity meanwhile was not taken back');
    assert.equal(await fx.coll('tombstones').countDocuments({ _id: late._id }), 1, 'the edge taken back has no tombstone');
  });

  it('a delete counts its removal and its tombstone, and each fork it settles the same, in the group\'s ceilings', { timeout: SLOW }, async () => {
    const { writeGroupSize, GROUP_MAX_OPERATIONS } = fx.group;
    const one = writeGroupSize([deleteRecord('fact', factId(1), 1)]);
    assert.equal(one.operations, 2, `a delete counts ${one.operations} operation(s), not its removal and its tombstone`);
    const withForks = writeGroupSize([deleteRecord('fact', factId(1), 1)], { forks: 3 });
    assert.equal(withForks.operations, 8, `a delete with three forks counts ${withForks.operations} operation(s)`);
    assert.ok(withForks.bytes > one.bytes, 'the forks a delete settles add no bytes');

    const subject = factId(1);
    await fx.coll('facts').insertOne({ ...factDoc(subject, 'with many versions'), seq: 1 });
    const forks = Math.ceil(GROUP_MAX_OPERATIONS / 2);
    await fx.coll('facts').insertMany(Array.from({ length: forks }, (_, i) => ({ ...factDoc(`fork-${i}`, 'a version'), forkOf: subject, seq: 2 + i })));
    const txns = countTransactions(fx.mongo);
    let out;
    try { out = await settle(fx.commitGroup([deleteRecord('fact', subject, 1)])); } finally { txns.restore(); }
    assert.equal(await fx.coll('facts').countDocuments({ _id: subject }), 1, 'a delete whose forks pass the operation ceiling removed its record');
    assert.ok(out.error, 'a delete whose forks pass the operation ceiling was answered as written');
    assert.equal(out.error.code, 'write_group_too_large', `the refusal is not write_group_too_large: ${out.error.name}: ${out.error.message}`);
    assert.equal(out.error.ceiling, 'operations');
    assert.equal(txns.started(), 0, 'a transaction was opened for a group over its ceiling');
  });
});
