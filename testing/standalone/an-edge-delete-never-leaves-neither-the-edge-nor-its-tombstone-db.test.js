/**
 * An edge delete never leaves an edge that is gone HERE and has no tombstone — the order is tombstone first, then
 * delete (Q-361 item 13).
 *
 * ## The defect
 *
 * `deleteEdge` deleted the edge, retired its embed job, and only then wrote the tombstone. A tombstone write that failed
 * (a store refusal, a step-down, a dropped socket) left the edge gone on this instance and alive on every peer that
 * held it: no tombstone ever travelled, so the next pull from any of them brought the edge back — with the deletion
 * the operator made undone, silently, and the cascade that "removed" it reporting success or failure by luck.
 *
 * ## The rule (no transaction, no new hold: the cost of one on the hot delete path is a stall that freezes every peer's pull)
 *
 * The TOMBSTONE is written first, through the existing tombstone write, and the edge is deleted after it:
 *
 *  - a tombstone that cannot be written fails the delete BEFORE anything is removed — the edge is still here, and a retry
 *    completes it;
 *  - a delete that fails after the tombstone landed leaves a tombstone beside a LIVE edge, which a retry completes (the
 *    tombstone is replaced by id) and which can never resurrect a deleted edge on a peer: the only direction the defect
 *    was about is closed. At no point are both the edge and its tombstone absent;
 *  - the embed job's retirement and the webhook run AFTER both writes and cannot fail the delete: a retirement that
 *    fails is logged and the edge stays deleted and tombstoned.
 *
 * ## How the faults are made
 *
 * Real store refusals, never built errors: a validator no tombstone satisfies (code 121), and a collection that is a VIEW
 * (every write to it fails at the command level). Both are installed by `_write-faults.mjs`, which reads the store
 * back to prove it holds the fault.
 *
 * Seen red on 6eb5a333 (5.6.3): a refused tombstone leaves the edge deleted and nothing recorded; a refused delete
 * leaves no tombstone; a failed job retirement stops the tombstone being written at all.
 *
 * Run: node --test testing/standalone/an-edge-delete-never-leaves-neither-the-edge-nor-its-tombstone-db.test.js
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openPushDoor, build } from './_push-door.mjs';
import { withValidator, withCollectionAsView } from './_write-faults.mjs';

const skip = await mongoSkipReason();

const S = 'edgedel';
const ID = 'edge-1';
/** A validator no tombstone satisfies: every write of one is refused by the store (code 121). */
const REFUSE_EVERY_TOMBSTONE = { refusedByTheTest: { $exists: true } };

let door, edges, log;

const edge = () => door.coll(S, 'edges').findOne({ _id: ID });
const tombstone = () => door.coll(S, 'tombstones').findOne({ _id: ID });

describe('an edge delete writes its tombstone first', { skip }, () => {
  before(async () => {
    door = await openPushDoor({ suite: 'edgedel', spaces: [{ id: S, label: 'Edge delete', folders: [], meta: {} }] });
    edges = await import('../../server/dist/brain/edges.js');
    ({ log } = await import('../../server/dist/util/log.js'));
  });
  after(async () => { await door?.close(); });
  beforeEach(async () => {
    await door.wipe(S);
    await door.coll(S, 'edges').insertOne(build.edge(S, ID, 7));
  });

  it('control: a delete removes the edge and leaves its tombstone, carrying the seq the edge held', async () => {
    assert.equal(await edges.deleteEdge(S, ID), true);
    assert.equal(await edge(), null);
    assert.equal((await tombstone())?.originalSeq, 7, 'the tombstone does not carry the seq of the edge it deletes');
  });

  it('a tombstone the store refuses fails the delete and leaves the edge where it was', async () => {
    let raised = null;
    await withValidator(door.mongo.getDb(), `${S}_tombstones`, REFUSE_EVERY_TOMBSTONE, async () => {
      raised = await edges.deleteEdge(S, ID).then(() => null, (e) => e);
    });
    assert.equal(await tombstone(), null, 'fixture check: a tombstone landed through the validator');
    assert.ok(await edge(),
      'the edge is gone here and no tombstone was written: every peer holding it brings it back on the next pull');
    assert.ok(raised, 'a delete whose tombstone failed reported success');
  });

  it('a retry after a refused tombstone completes the delete, edge and tombstone both', async () => {
    await withValidator(door.mongo.getDb(), `${S}_tombstones`, REFUSE_EVERY_TOMBSTONE, async () => {
      await edges.deleteEdge(S, ID).catch(() => {});
    });
    assert.equal(await edges.deleteEdge(S, ID), true, 'the retry found nothing to delete: the first attempt had already removed the edge');
    assert.equal(await edge(), null);
    assert.equal((await tombstone())?.originalSeq, 7);
  });

  it('a delete the store refuses AFTER the tombstone landed leaves a tombstone beside a live edge, and a retry completes it', async () => {
    // The edges are a VIEW over their source while the fault is on: they read as the source reads, and every write fails.
    await door.coll(S, 'edges').deleteMany({});
    await door.mongo.getDb().collection(`${S}_edges_src`).insertOne(build.edge(S, ID, 7));
    let raised = null;
    await withCollectionAsView(door.mongo.getDb(), `${S}_edges`, `${S}_edges_src`, async () => {
      raised = await edges.deleteEdge(S, ID).then(() => null, (e) => e);
    });
    assert.ok(raised, 'fixture check: the delete the store refuses reported success');
    assert.ok(await tombstone(),
      'the delete failed and NO tombstone was written first: had it landed, a peer would hold the deletion');
    assert.ok(await door.mongo.getDb().collection(`${S}_edges_src`).findOne({ _id: ID }), 'fixture check: the edge itself changed');
    // The retry, with the store healthy again and the edge back in its collection.
    await door.coll(S, 'edges').insertOne(build.edge(S, ID, 7));
    assert.equal(await edges.deleteEdge(S, ID), true);
    assert.equal(await edge(), null);
    assert.equal(await door.coll(S, 'tombstones').countDocuments({ _id: ID }), 1, 'the retry wrote a second tombstone for one edge');
    await door.mongo.getDb().collection(`${S}_edges_src`).drop().catch(() => {});
  });

  it('a failed embed-job retirement is logged and cannot stop the delete: edge gone, tombstone written, true returned', async () => {
    await door.coll(S, 'embed_jobs').insertOne({ _id: `edge:${ID}`, recordType: 'edge', recordId: ID, status: 'pending' });
    const lines = [];
    const orig = { warn: log.warn, error: log.error };
    log.warn = (...a) => { lines.push(a.join(' ')); };
    log.error = (...a) => { lines.push(a.join(' ')); };
    let result;
    try {
      await door.coll(S, 'embed_jobs_src').insertOne({ _id: `edge:${ID}`, recordType: 'edge', recordId: ID, status: 'pending' });
      await withCollectionAsView(door.mongo.getDb(), `${S}_embed_jobs`, `${S}_embed_jobs_src`, async () => {
        result = await edges.deleteEdge(S, ID).then((v) => ({ v }), (e) => ({ e }));
      });
    } finally { Object.assign(log, orig); await door.coll(S, 'embed_jobs_src').drop().catch(() => {}); }
    assert.ok(await tombstone(), `the tombstone was never written (${JSON.stringify(result?.e?.message ?? result)}): the retirement ran before it and stopped the delete`);
    assert.equal(await edge(), null);
    assert.deepEqual(result, { v: true });
    assert.ok(lines.some(l => l.includes(ID) || /embed/i.test(l)), `the failed retirement was not logged: ${JSON.stringify(lines)}`);
  });

  it('PIN no transaction is started: the delete takes no hold on the seq horizon', async () => {
    // Transactions, not sessions: the driver opens an implicit session for every operation.
    const probe = door.mongo.getMongo().startSession();
    const proto = Object.getPrototypeOf(probe);
    await probe.endSession();
    const original = { startTransaction: proto.startTransaction, withTransaction: proto.withTransaction };
    let transactions = 0;
    proto.startTransaction = function counting(...a) { transactions++; return original.startTransaction.apply(this, a); };
    proto.withTransaction = function counting(...a) { transactions++; return original.withTransaction.apply(this, a); };
    try { assert.equal(await edges.deleteEdge(S, ID), true); } finally { Object.assign(proto, original); }
    assert.equal(transactions, 0, 'deleteEdge started a transaction: a held transaction on the hot delete path can stall every peer\'s pull');
  });
});
