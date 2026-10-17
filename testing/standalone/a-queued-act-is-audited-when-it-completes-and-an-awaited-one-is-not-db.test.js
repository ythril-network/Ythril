/**
 * An act a round passed, that completes AFTER its door answered, is audited as `network.round.space_act`; one the door waited for is not (bundle-106
 * R-X17a; design v5 section 2.6 "Audit", X17, INT S10).
 *
 * ## What was true before
 *
 * A wipe or a deletion that a round passed ran inside the request (the base only acts at conclusion, by the tick or a gossip pass), and a
 * completion nobody asked for left no entry: the operator who clicked saw `202`, the act finished minutes later, and the audit log said nothing
 * about the emptied space - the one effect no request asked this instance for.
 *
 * ## The rule
 *
 * `settleSpaceAct('completed')` writes `network.round.space_act` UNLESS the request that started the act is still waiting for it: the door's await
 * registers a waiter on the job and removes it when it answers. A door that already answered (`202 queued`, a timeout, a dropped connection) leaves
 * no waiter, so the completion is audited; a door that waited has the route's own entry, and a second one would count the same effect twice.
 *
 * ## How it is driven
 *
 * A club (one yes passes at open) carrying two spaces, each with data:
 *
 * 1. `other` is wiped through the admin door with the default answer budget: the door awaits the act and answers `200 wiped`;
 * 2. `notes` is wiped with the answer budget lowered (`setSpaceActKnobsForTest`) and the first batch latched (`setSpaceActHooksForTest`, a hook INSIDE
 *    the real body): the door answers `202 queued`, the latch is released, and the act completes after.
 *
 * Then, once the runner is idle: exactly ONE `network.round.space_act` entry exists and it is `notes`'s. The audit write is queued, not awaited, so the
 * absence for `other` is read only after `notes`'s entry (written later, by the same queue) has appeared - the twin that proves the same path writes.
 *
 * ## Seen red
 *
 * On the base a club wipe passes at open only as an unanswered `202 vote_pending`: there is no runner, no queued answer and no such entry, so the
 * precondition rows fail. After the fix, by hand: audit every completion -> the entry for `other` appears and the identity row is red; audit none
 * -> no entry for `notes`.
 *
 * Run: node --test testing/standalone/a-queued-act-is-audited-when-it-completes-and-an-awaited-one-is-not-db.test.js
 * (requires a prior server build and the test MongoDB)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';
import { removeInstanceDir } from './_vote-round-instance.mjs';
import { deferred, untilRunnerIdle, resetRunnerForTest, auditRowsOf } from './_space-act-harness.mjs';
import { M1, tempInstance, networkOf, boot, seedFacts, factCount, doors, requireRunner, databaseTakesCollections, warmSpaceCreation } from './_round-open-fixtures.mjs';

const dir = tempInstance('ythril-act-audit-');
const skip = await mongoSkipReason();

describe('a queued act is audited when it completes, an awaited one is not', { skip }, () => {
  let mongo;
  before(async () => {
    process.env['YTHRIL_MODELS_OFFLINE'] = '1';
    mongo = await openTestMongo('act_audit');
    await databaseTakesCollections(mongo);
    await boot(dir, { networks: [] });
    await warmSpaceCreation();
  });
  after(async () => { await closeTestMongo(); removeInstanceDir(dir); });

  it('the act the door waited for writes no network.round.space_act entry; the act the door had already answered writes exactly one', async () => {
    const runner = await requireRunner();
    const loader = await boot(dir, { spaces: ['notes', 'other'], networks: [networkOf('club', [M1], { spaces: ['general', 'notes', 'other'] })] });
    await mongo.col('audit_log').deleteMany({ operation: 'network.round.space_act' });
    await seedFacts(mongo, 'notes', 2, 'queued');
    await seedFacts(mongo, 'other', 2, 'awaited');

    // 1. The door waits: the default budget is far longer than a two-record wipe.
    const awaited = await doors.wipeSpace('other');
    assert.deepEqual([awaited.code, awaited.body?.status], [200, 'wiped'], `the awaited wipe answered ${awaited.code} ${JSON.stringify(awaited.body)?.slice(0, 200)}`);
    assert.equal(await factCount(mongo, 'other'), 0, 'the answer says wiped and the space still holds records');

    // 2. The door answers first: the budget is lowered and the first batch is parked on a latch.
    runner.setSpaceActKnobsForTest({ SPACE_ACT_ANSWER_MS: 25 });
    const hold = deferred();
    runner.setSpaceActHooksForTest({ beforeBatch: async (collection) => { if (String(collection).startsWith('notes')) { hold.arrive(); await hold.promise; } } });
    const queued = await doors.wipeSpace('notes');
    await hold.reached;
    assert.deepEqual([queued.code, queued.body?.status, queued.body?.queued], [202, 'passed', true], `the door did not answer queued: ${queued.code} ${JSON.stringify(queued.body)?.slice(0, 200)}`);
    assert.ok(await factCount(mongo, 'notes') > 0, 'the act completed before the latch was released, so the door\'s answer proves nothing about "after"');
    hold.release();
    await untilRunnerIdle(runner, loader);
    assert.equal(await factCount(mongo, 'notes'), 0, 'the queued act never completed');

    const rows = await auditRowsOf(mongo, 'network.round.space_act', { atLeast: 1 });
    const spacesNamed = rows.map(r => ['notes', 'other'].filter(s => JSON.stringify(r).includes(s)));
    assert.deepEqual(spacesNamed, [['notes']], `the completion entries name ${JSON.stringify(spacesNamed)}: exactly the act the door had already answered is audited, and an awaited one is the route's own entry`);
    resetRunnerForTest(runner);
  });
});
