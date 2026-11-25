/**
 * A write group asks the write gate for every family it writes BEFORE its transaction opens, and a registered wipe of any one of them refuses
 * the whole group: nothing lands (`Q-760`; vet-1 S2).
 *
 * ## The rule
 *
 * `commitWriteGroup` enters `admitSpaceWriteUnit` for the families of its plans (and `links` when a plan carries link rows) before the session,
 * and leaves in a `finally`. A wipe registered for one family refuses the group with the gate's own refusal (`SpaceNotWritableError`, its
 * code), never a partial landing: the group is whole or nothing even against an act.
 *
 * ## Why it matters
 *
 * `commitPlans` asks per stage and, once a stage landed, turns a later stage's refusal into item outcomes: a facts stage lands and the entity
 * stage is refused. For a group that must land whole, that is the partial landing the group exists to prevent.
 *
 * ## Seen red
 *
 * On the base (3f48206ac) the fixture writes the plans with `commitPlans`: the facts land and the entity stage is refused as an outcome (red
 * line in the Q-760 Work-Log). Mutation: the gate asked for the plans' first family only (the entity wipe no longer refuses the group).
 *
 * Run: node --test testing/standalone/a-write-group-asks-the-write-gate-before-its-session-db.test.js (a Mongo the harness accepts; `npm run build` in server/)
 */
import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { seedActEntry, clearActEntries } from './_space-act-harness.mjs';
import { SPACE, openWriteGroupFixture, factId, entityId, insertFact, insertEntity, settle, countTransactions } from './_write-group.mjs';

const skip = await mongoSkipReason();

let fx;
let gate;

describe('a write group asks the write gate', { skip }, () => {
  before(async () => {
    fx = await openWriteGroupFixture('writegroupgate');
    gate = await import('../../server/dist/spaces/space-write-gate.js');
  });
  after(async () => { clearActEntries(fx.loader); await fx?.cleanup(); });
  beforeEach(async () => { clearActEntries(fx.loader); await fx.clear(); });
  afterEach(() => clearActEntries(fx.loader));

  const group = () => [insertFact(factId(1), 'a fact'), insertFact(factId(2), 'another fact'), insertEntity(entityId(1), 'An Entity')];

  it('control: with no act standing the group lands', async () => {
    const out = await settle(fx.commitGroup(group()));
    assert.equal(out.error, undefined, `the control group failed: ${out.error?.message}`);
    assert.equal(await fx.coll('facts').countDocuments({}), 2);
    assert.equal(await fx.coll('entities').countDocuments({}), 1);
  });

  it('a registered wipe of the entities refuses the whole group before a session, and no fact of it lands', async () => {
    await seedActEntry(fx.loader, { kind: 'wipe', localId: SPACE, types: ['entities'] });
    const txns = countTransactions(fx.mongo);
    let out;
    try { out = await settle(fx.commitGroup(group())); } finally { txns.restore(); }
    assert.equal(await fx.coll('facts').countDocuments({}), 0, 'the facts of a group landed although a wipe of its entities stands');
    assert.equal(await fx.coll('entities').countDocuments({}), 0, 'the entity of a group landed although its family is being wiped');
    assert.ok(out.error, 'a group with a wiped family was answered as written');
    assert.ok(gate.isSpaceNotWritable(out.error), `the refusal is not the write gate's: ${out.error.name}: ${out.error.message}`);
    assert.equal(out.error.code, 'space_being_wiped');
    assert.equal(txns.started(), 0, 'a transaction was opened for a group the gate refuses');
  });
});
