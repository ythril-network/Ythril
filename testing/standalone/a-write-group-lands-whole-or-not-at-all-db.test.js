/**
 * A group of planned inserts and converges lands in ONE transaction, or nothing of it lands (`Q-760`, D-73 a16 and b4).
 *
 * ## The rule
 *
 * `commitWriteGroup(spaceId, plans)` (`brain/write-plan/write-group.ts`) writes every plan inside one bounded transaction under the position
 * floor. A failing operation (a duplicate key), a converge whose record moved since it was planned (a short matched count) or a version at
 * the ceiling aborts the whole group: not one record, link row or embed job of it is left. What follows a write (embed jobs, take-backs,
 * duplicate rules) runs only after the commit, so an aborted group queues nothing. Every write inside the transaction carries its session:
 * one that does not is outside the transaction and survives the abort (probe E4).
 *
 * ## Why it matters
 *
 * A SPARQL Update (`Q-761`) is one request that must land whole. `commitPlans` writes a group stage by stage with no transaction and never
 * throws once something landed, so a failure part-way leaves part of the request written and reports the rest failed.
 *
 * ## Seen red
 *
 * On the base (3f48206ac) the group writer does not exist and the fixture writes the same plans with `commitPlans`; the red lines are in the
 * Q-760 Work-Log. Mutations, each restored: the session dropped from the stage writer's `bulkWrite` (the one-in-ten case and the watcher
 * case go red); the matched-count check removed (the stale case goes red).
 *
 * Run: node --test testing/standalone/a-write-group-lands-whole-or-not-at-all-db.test.js (a Mongo the harness accepts; `npm run build` in server/)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import {
  SPACE, AUTHOR, openWriteGroupFixture, factId, entityId, factDoc, insertFact, convergeFact, settle, watchSessionlessWrites,
} from './_write-group.mjs';

const skip = await mongoSkipReason();

let fx;
const ids = (n, from = 1) => Array.from({ length: n }, (_, i) => factId(from + i));

describe('a write group lands whole or not at all', { skip }, () => {
  before(async () => { fx = await openWriteGroupFixture('writegroupwhole'); });
  after(async () => { await fx?.cleanup(); });
  beforeEach(async () => { await fx.clear(); });

  it('control: ten inserts land together, each at its own version, and their embed jobs are queued after the commit', async () => {
    const plans = ids(10).map((id, i) => insertFact(id, `fact ${i}`, { enqueue: true }));
    const out = await settle(fx.commitGroup(plans));
    assert.equal(out.error, undefined, `the control group failed: ${out.error?.message}`);
    const stored = await fx.coll('facts').find({}, { projection: { seq: 1 } }).toArray();
    assert.deepEqual(stored.map(d => d._id).sort(), ids(10).sort(), 'the control group did not store its ten facts');
    assert.equal(new Set(stored.map(d => d.seq)).size, 10, 'two records of the group share a version');
    assert.equal(await fx.coll('embed_jobs').countDocuments({}), 10, 'the landed group queued no embed job for its records');
  });

  it('one failing operation in ten (a duplicate key) leaves zero of the ten landed', async () => {
    const taken = factId(5);
    await fx.coll('facts').insertOne({ ...factDoc(taken, 'already stored'), seq: 1 });
    const plans = ids(10).map((id, i) => insertFact(id, `fact ${i}`));
    const out = await settle(fx.commitGroup(plans));
    const landed = await fx.coll('facts').countDocuments({ _id: { $in: ids(10).filter(id => id !== taken) } });
    assert.equal(landed, 0, `${landed} of the nine other records landed although one operation of the group failed`);
    assert.ok(out.error, 'a group with a failed operation was answered as written');
    assert.equal(out.error.name, 'GroupAborted', `the failure is not the group's abort: ${out.error.name}: ${out.error.message}`);
    assert.equal(out.error.reason, 'duplicate_key');
    assert.equal((await fx.coll('facts').findOne({ _id: taken })).fact, 'already stored', 'the stored record was changed by the aborted group');
  });

  it('a converge whose record moved since it was planned aborts the group, and its inserts do not land', async () => {
    const moved = factId(100);
    await fx.coll('facts').insertOne({ ...factDoc(moved, 'as stored'), seq: 7 });
    const plans = [...ids(3).map((id, i) => insertFact(id, `fact ${i}`)), convergeFact(moved, 'as planned', 6)];
    const out = await settle(fx.commitGroup(plans));
    assert.equal(await fx.coll('facts').countDocuments({ _id: { $in: ids(3) } }), 0, 'the inserts of a group with a stale converge landed');
    assert.equal((await fx.coll('facts').findOne({ _id: moved })).fact, 'as stored', 'the stale converge was written over the record');
    assert.ok(out.error, 'a group with a stale converge was answered as written');
    assert.equal(out.error.name, 'GroupAborted');
    assert.equal(out.error.reason, 'stale');
    assert.equal(out.error.recordId, moved, 'the abort does not name the record that moved');
  });

  it('an aborted group queues no embed job and leaves no link row', async () => {
    const taken = factId(9);
    const target = entityId(1);
    await fx.coll('facts').insertOne({ ...factDoc(taken, 'already stored'), seq: 1 });
    const plans = ids(10).map((id, i) => insertFact(id, `fact ${i}`, { enqueue: true, links: [target] }));
    const out = await settle(fx.commitGroup(plans));
    assert.equal(await fx.coll('embed_jobs').countDocuments({}), 0, 'an embed job was queued for a record of a group that did not land');
    assert.equal(await fx.coll('links').countDocuments({}), 0, 'a link row of a group that did not land is stored');
    assert.ok(out.error, 'the group was answered as written');
  });

  it('every write the group makes inside its transaction carries the session', async () => {
    const target = entityId(2);
    const stored = factId(200);
    await fx.coll('facts').insertOne({ ...factDoc(stored, 'before'), seq: 3 });
    // A stored link row of the converged fact that its plan no longer wants: its removal and tombstone are writes of the group too.
    const oldLink = (await import('../../server/dist/brain/link-id.js')).linkIdFor(stored, 'fact', entityId(3), 'entity');
    await fx.coll('links').insertOne({ _id: oldLink, spaceId: SPACE, from: stored, fromKind: 'fact', to: entityId(3), toKind: 'entity', author: AUTHOR, seq: 4 });
    const converge = { ...convergeFact(stored, 'after', 3), links: { fromKind: 'fact', desired: { entity: [target] }, author: AUTHOR } };
    const plans = [...ids(3).map((id, i) => insertFact(id, `fact ${i}`, { links: [target] })), converge];
    const watch = watchSessionlessWrites(fx.mongo);
    let out;
    try { out = await settle(fx.commitGroup(plans)); } finally { watch.restore(); }
    assert.equal(out.error, undefined, `the group failed: ${out.error?.message}`);
    for (const family of ['facts', 'links', 'tombstones']) {
      assert.ok(watch.written().includes(`${SPACE}_${family}`),
        `the group's ${family} writes were not made inside a transaction (inside one: ${watch.written().join(', ') || 'none'})`);
    }
    assert.deepEqual(watch.sessionless(), [], 'a write inside the group\'s transaction carried no session: it lands outside the transaction and survives an abort');
    assert.equal(await fx.coll('links').countDocuments({ _id: oldLink }), 0, 'the unwanted link row was not removed');
    assert.equal(await fx.coll('tombstones').countDocuments({ _id: oldLink }), 1, 'the removed link row has no tombstone');
  });

  it('the watcher catches a session-less write planted in a transaction (it is what the case above relies on)', async () => {
    const watch = watchSessionlessWrites(fx.mongo);
    try {
      await settle(fx.held.inHeldTransaction(SPACE, 'test.plant', async (session) => {
        await fx.coll('facts').insertOne({ ...factDoc(factId(300), 'in the session'), seq: 1 }, { session });
        await fx.coll('facts').insertOne({ ...factDoc(factId(301), 'planted without it'), seq: 2 });
        throw new Error('abort the planted transaction');
      }));
    } finally { watch.restore(); }
    assert.deepEqual(watch.sessionless(), [`insertOne on ${SPACE}_facts`], 'the watcher did not flag the planted session-less write');
    assert.equal(await fx.coll('facts').countDocuments({ _id: factId(300) }), 0, 'the write in the session survived the abort');
    assert.equal(await fx.coll('facts').countDocuments({ _id: factId(301) }), 1,
      'premise: a session-less write inside a transaction survives its abort (probe E4) — if it no longer does, this rule needs rereading');
  });
});
