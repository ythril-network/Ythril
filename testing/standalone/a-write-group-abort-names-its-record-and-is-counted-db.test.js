/**
 * Every way a write group stops names the record it stopped on, never answers a bare 500 for a plan its read set produced, and is counted by its
 * reason (`Q-760`, `Q-963`; review A3, A4, A5, A9).
 *
 * ## The rule
 *
 * - **A stale delete names the record that was missing or moved**, not one the same group had already removed.
 * - **A duplicate key names the record** (the bulk error's index is mapped to its plan).
 * - **A link row at the version ceiling under a deleted record** aborts the group `version_ceiling`, naming the deleted record, as a record
 *   at the ceiling does; it is no bare `RecordVersionAtCeiling`.
 * - **A record planned twice in one group is refused by name** (`409`, `write_group_record_planned_twice`, its kind and id): a refusal of the
 *   request, never a bare `Error`, and nothing is sent. A delete and a converge of the same edge are one record written once (the converge
 *   wins: see `a-an-edge-deleted-and-planned-again-in-one-batch-is-converged-db`).
 * - **A group that met a write conflict on every one of its `GROUP_MAX_TRIES` runs aborts `retries`**; a record at the version ceiling aborts
 *   `version_ceiling`.
 * - **Each abort adds one to `ythril_write_group_aborts_total{reason}`**, and the group that landed adds none.
 *
 * ## Seen red
 *
 * On 96be09a1c the stale delete names the record removed before the missing one, a duplicate key names none, the link row at the ceiling
 * escapes as `RecordVersionAtCeiling`, and a record planned twice is a plain `Error`. The retries and version-ceiling cases were never run.
 *
 * Run: node --test testing/standalone/a-write-group-abort-names-its-record-and-is-counted-db.test.js (a Mongo the harness accepts; `npm run build` in server/)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { holdDocumentLock } from './_write-faults.mjs';
import {
  SPACE, AUTHOR, openWriteGroupFixture, factId, entityId, factDoc, entityDoc, insertFact, convergeFact, deleteRecord, settle, countTransactions, abortsOf,
} from './_write-group.mjs';

const skip = await mongoSkipReason();

let fx;
let linkIdFor;
let MAX_INGEST_SEQ;

/** Run `plans` as a group and say how it stopped, with the metric's step for `reason`. */
async function abortOf(plans, reason) {
  const before = await abortsOf(reason);
  const out = await settle(fx.commitGroup(plans));
  assert.ok(out.error, `a group that cannot land was answered as written (${reason})`);
  assert.equal(out.error.name, 'GroupAborted', `the failure is not the group's abort: ${out.error.name}: ${out.error.message}`);
  assert.equal(out.error.reason, reason);
  assert.equal(await abortsOf(reason), before + 1, `the abort did not count one write_group_aborts_total{reason="${reason}"}`);
  return out.error;
}

describe('a write group\'s abort names its record and is counted', { skip }, () => {
  before(async () => {
    fx = await openWriteGroupFixture('writegroupabort');
    ({ linkIdFor } = await import('../../server/dist/brain/link-id.js'));
    ({ MAX_INGEST_SEQ } = await import('../../server/dist/util/seq.js'));
  });
  after(async () => { await fx?.cleanup(); });
  beforeEach(async () => { await fx.clear(); });

  it('a stale delete names the record that was missing, not the one the group had already removed before it', async () => {
    const [first, gone] = [factId(1), factId(2)];
    await fx.coll('facts').insertOne({ ...factDoc(first, 'removed first'), seq: 1 });
    const err = await abortOf([deleteRecord('fact', first, 1), deleteRecord('fact', gone, 1)], 'stale');
    assert.equal(err.recordKind, 'fact');
    assert.equal(err.recordId, gone, `the abort names '${err.recordId}', not the record that was missing`);
    assert.equal(await fx.coll('facts').countDocuments({ _id: first }), 1, 'the first delete of an aborted group landed');
  });

  it('a duplicate key names the record that was created meanwhile', async () => {
    const taken = factId(5);
    await fx.coll('facts').insertOne({ ...factDoc(taken, 'already stored'), seq: 1 });
    const err = await abortOf(Array.from({ length: 10 }, (_, i) => insertFact(factId(i + 1), `fact ${i}`)), 'duplicate_key');
    assert.equal(err.recordKind, 'fact');
    assert.equal(err.recordId, taken, `the abort names '${err.recordId}', not the record that was already stored`);
    assert.match(err.message, new RegExp(taken), 'the sentence does not name the record');
  });

  it('a link row at the version ceiling under a deleted fact aborts the group version_ceiling, naming the fact, and removes nothing', async () => {
    const fact = factId(1);
    const link = linkIdFor(fact, 'fact', entityId(1), 'entity');
    await fx.coll('facts').insertOne({ ...factDoc(fact, 'owns a stuck link'), seq: 1 });
    await fx.coll('links').insertOne({ _id: link, spaceId: SPACE, from: fact, fromKind: 'fact', to: entityId(1), toKind: 'entity', author: AUTHOR, seq: MAX_INGEST_SEQ });
    const err = await abortOf([deleteRecord('fact', fact, 1)], 'version_ceiling');
    assert.equal(err.recordKind, 'fact');
    assert.equal(err.recordId, fact, 'the abort does not name the record whose link row is at the ceiling');
    assert.equal(await fx.coll('facts').countDocuments({ _id: fact }), 1, 'the fact of an aborted group was removed');
    assert.equal(await fx.coll('links').countDocuments({ _id: link }), 1, 'the link row at the ceiling was removed');
  });

  it('a record at the version ceiling aborts the group version_ceiling, naming it, and its inserts do not land', async () => {
    const stuck = factId(1);
    await fx.coll('facts').insertOne({ ...factDoc(stuck, 'at the ceiling'), seq: MAX_INGEST_SEQ });
    const err = await abortOf([insertFact(factId(2), 'beside it'), convergeFact(stuck, 'changed', MAX_INGEST_SEQ)], 'version_ceiling');
    assert.equal(err.recordId, stuck, 'the abort does not name the record at the ceiling');
    assert.equal(await fx.coll('facts').countDocuments({ _id: factId(2) }), 0, 'the insert of an aborted group landed');
  });

  it('a group that meets a write conflict on each of its three runs aborts retries, having run three times', async () => {
    const held = factId(1);
    await fx.coll('facts').insertOne({ ...factDoc(held, 'locked elsewhere'), seq: 3 });
    const lock = await holdDocumentLock(fx.mongo, `${SPACE}_facts`, { filter: { _id: held } });
    let err;
    try { err = await abortOf([insertFact(factId(2), 'beside it'), convergeFact(held, 'changed', 3)], 'retries'); } finally { await lock.release(); }
    assert.equal(err.attempts, fx.group.GROUP_MAX_TRIES, 'the group did not run the transaction GROUP_MAX_TRIES times before it gave up');
    assert.equal(await fx.coll('facts').countDocuments({ _id: factId(2) }), 0, 'the insert of an aborted group landed');
    const again = await settle(fx.commitGroup([insertFact(factId(2), 'beside it'), convergeFact(held, 'changed', 3)]));
    assert.equal(again.error, undefined, `the same group with the lock released failed: ${again.error?.name}: ${again.error?.message}`);
  });

  it('a group whose deleted entity is still named aborts referenced, and the one that landed adds no abort', async () => {
    const [ent, fact] = [entityId(1), factId(1)];
    await fx.coll('entities').insertOne({ ...entityDoc(ent, 'Eve'), seq: 1 });
    await fx.coll('facts').insertOne({ ...factDoc(fact, 'names Eve'), seq: 2 });
    await fx.coll('links').insertOne({ _id: linkIdFor(fact, 'fact', ent, 'entity'), spaceId: SPACE, from: fact, fromKind: 'fact', to: ent, toKind: 'entity', author: AUTHOR, seq: 3 });
    const err = await abortOf([deleteRecord('entity', ent, 1)], 'referenced');
    assert.equal(err.recordId, ent);
    const counts = {};
    for (const reason of fx.group.GROUP_ABORT_REASONS) counts[reason] = await abortsOf(reason);
    const out = await settle(fx.commitGroup([insertFact(factId(9), 'lands')]));
    assert.equal(out.error, undefined, `the control group failed: ${out.error?.message}`);
    for (const reason of fx.group.GROUP_ABORT_REASONS) assert.equal(await abortsOf(reason), counts[reason], `a group that landed counted an abort (${reason})`);
  });

  it('a record planned twice in one group is refused by name before a session opens: 409, its code, its kind and its id', async () => {
    const twice = factId(1);
    const txns = countTransactions(fx.mongo);
    let out;
    try { out = await settle(fx.commitGroup([insertFact(twice, 'once'), insertFact(factId(2), 'beside it'), insertFact(twice, 'twice')])); } finally { txns.restore(); }
    assert.ok(out.error, 'a record planned twice was answered as written');
    assert.equal(out.error.status, 409, `the refusal is not a 409: ${out.error.name}: ${out.error.message}`);
    assert.equal(out.error.code, 'write_group_record_planned_twice');
    assert.equal(out.error.recordKind, 'fact');
    assert.equal(out.error.recordId, twice);
    assert.match(out.error.message, new RegExp(twice));
    assert.equal(txns.started(), 0, 'a transaction was opened for a group that names a record twice');
    assert.equal(await fx.coll('facts').countDocuments({}), 0, 'a record of the refused group landed');
  });
});
