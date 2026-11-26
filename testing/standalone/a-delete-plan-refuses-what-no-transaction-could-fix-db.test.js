/**
 * `planDelete` refuses, by name and before anything is noted, the deletes no transaction could make good (`Q-963`, lens-b).
 *
 * ## The rule
 *
 * A record that is not stored is `NotFoundError`; an unresolved version (a fork row) is `ForkRowReadOnly`, resolved and never deleted by id; a
 * record whose version is at the highest sync accepts is `RecordVersionAtCeiling` (its tombstone would be refused by every peer). A refused
 * delete leaves the read set as it was (nothing is noted deleted: the record is still stored for the next plan of the batch), and one a
 * version below the ceiling is planned at that version.
 *
 * ## Seen red
 *
 * Mutations, each restored: the `NotFoundError` branch removed (a missing record is planned as a delete at `null`); the ceiling comparison
 * moved to `>` (the record at the ceiling is planned); `noteDeleted` moved above the checks (a refused record is held as gone).
 *
 * Run: node --test testing/standalone/a-delete-plan-refuses-what-no-transaction-could-fix-db.test.js (a Mongo the harness accepts; `npm run build` in server/)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { SPACE, openWriteGroupFixture, factId, factDoc } from './_write-group.mjs';

const skip = await mongoSkipReason();

let fx;
let m;

/** A read set that has loaded `id` as a fact, and what planning its delete does: `{ plan }` or `{ error }`, with the read set. */
async function planDeleteOf(id) {
  const rs = new m.ReadSet(SPACE);
  await rs.load({ records: { fact: [id] } });
  try { return { plan: m.planDelete(rs, 'fact', id), rs }; } catch (error) { return { error, rs }; }
}

describe('planDelete refuses what no transaction could fix', { skip }, () => {
  before(async () => {
    fx = await openWriteGroupFixture('planDeleteRefusals');
    m = {
      ReadSet: (await import('../../server/dist/brain/write-plan/read-set.js')).ReadSet,
      planDelete: (await import('../../server/dist/brain/write-plan/plan-delete.js')).planDelete,
      errors: await import('../../server/dist/util/errors.js'),
      ceiling: await import('../../server/dist/brain/write-precondition.js'),
      seq: await import('../../server/dist/util/seq.js'),
    };
  });
  after(async () => { await fx?.cleanup(); });
  beforeEach(async () => { await fx.clear(); });

  it('a record that is not stored is NotFoundError, naming it', async () => {
    const { error } = await planDeleteOf(factId(1));
    assert.ok(error instanceof m.errors.NotFoundError, `a missing record was planned or refused as ${error?.name}`);
    assert.match(error.message, new RegExp(factId(1)), 'the refusal does not name the record');
  });

  it('an unresolved version (a fork row) is ForkRowReadOnly, and the read set still holds it', async () => {
    const fork = factId(2);
    await fx.coll('facts').insertOne({ ...factDoc(fork, 'a version'), forkOf: factId(1), seq: 4 });
    const { error, rs } = await planDeleteOf(fork);
    assert.equal(error?.name, 'ForkRowReadOnly', `a fork row was planned or refused as ${error?.name}`);
    assert.deepEqual(rs.missing('fact', [fork]), [], 'a refused delete was noted: the fork row is held as gone');
  });

  it('a record at the version ceiling is RecordVersionAtCeiling, carrying its id, and is still stored for the next plan', async () => {
    const stuck = factId(3);
    await fx.coll('facts').insertOne({ ...factDoc(stuck, 'at the ceiling'), seq: m.seq.MAX_INGEST_SEQ });
    const { error, rs } = await planDeleteOf(stuck);
    assert.ok(error instanceof m.ceiling.RecordVersionAtCeiling, `a record at the ceiling was planned or refused as ${error?.name}`);
    assert.equal(error.id, stuck, 'the refusal does not carry the record it is for');
    assert.deepEqual(rs.missing('fact', [stuck]), [], 'a refused delete was noted: the record at the ceiling is held as gone');
  });

  it('a record one version below the ceiling is planned at that version, and noted as gone', async () => {
    const edge = factId(4);
    await fx.coll('facts').insertOne({ ...factDoc(edge, 'just below'), seq: m.seq.MAX_INGEST_SEQ - 1 });
    const { plan, error, rs } = await planDeleteOf(edge);
    assert.equal(error, undefined, `a record below the ceiling was refused: ${error?.name}: ${error?.message}`);
    assert.equal(plan.op, 'delete');
    assert.equal(plan.expectSeq, m.seq.MAX_INGEST_SEQ - 1);
    assert.deepEqual(rs.missing('fact', [edge]), [edge], 'a planned delete was not noted: the record is still there for the next plan');
  });
});
