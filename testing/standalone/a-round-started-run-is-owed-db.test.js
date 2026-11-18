/**
 * A round-started run is owed: store failures past three passes never make it `failed`, and it completes once the store answers (Q-746,
 * bundle-284 design r5 sections 4.2 and 5.2 "Failures", findings S12, B3; decision 12 points 2-3).
 *
 * ## The rule
 *
 * A page that the store fails is a failed pass: the run records `failures` and the last `error` and is retried. A run that only an act or a
 * save started records `state: 'failed'` after three failed passes, as a reindex does. A run a passed vote started (`owed: true`) is the
 * instance's to finish, like a delete vote's act: it is never set failed, however many passes fail, and the pass after the store answers again
 * converts its records and completes it.
 *
 * The passes are driven one at a time (`driveSchemaConvertRun`), the store fault is the driver's own connection error on the space's entity
 * collection (`injectStoreFault`).
 *
 * Seen red on 14af4644: the run module is not built.
 *
 * Run: node --test testing/standalone/a-round-started-run-is-owed-db.test.js (test stack up, after `npm run build:server`)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openConvertDoor } from './_schema-convert.mjs';
import { injectStoreFault } from './_write-faults.mjs';

const skip = await mongoSkipReason();
const OWED = 'owed';
const NOT_OWED = 'not-owed';
const FAILING_PASSES = 4;

const runDocOf = (toFp, source) => ({
  _id: 'run', toFp, types: [{ kind: 'entity', type: 'person', done: false }], steps: [], stepsRefused: [], splitDeclared: {},
  sources: [{ kind: source, ...(source === 'round' ? { roundId: 'round-1' } : {}), at: '2026-11-18T10:00:00.000Z' }], owed: source === 'round',
  syncedFirst: { asked: 0, answered: 0 }, startedAt: '2026-11-18T10:00:00.000Z', cursor: null,
  counts: { stamped: 0, rewritten: 0, unconverted: 0, moved: 0, edgesRestamped: 0 }, state: 'running', failures: 0, sweepLeaseAt: 0,
});

describe('a round-started run is owed (real MongoDB, injected store fault)', { skip }, () => {
  let door, run;
  before(async () => {
    door = await openConvertDoor({ name: 'b284owed', spaces: [OWED, NOT_OWED] });
    run = await door.runModule();
    for (const [space, source] of [[OWED, 'round'], [NOT_OWED, 'act']]) {
      await door.seed(space, 'entities', [1, 2].map(n => ({ _id: `${space}-p${n}`, name: `P${n}`, type: 'person', properties: { age: n } })));
      await door.mongo.col(door.spaceCollection(space, 'schemaConvertRun')).insertOne(runDocOf(door.fp(space), source));
    }
  });
  after(async () => { run?.stopSchemaConvertWatcher(); await door?.close(); });

  const proto = () => Object.getPrototypeOf(door.coll(OWED, 'entities'));

  it('the run an act started is failed after three failed passes (the contrast the owed run is held against)', async () => {
    const fault = await injectStoreFault(proto(), ['bulkWrite', 'updateOne', 'updateMany', 'findOneAndUpdate'], `${NOT_OWED}_entities`);
    try {
      for (let i = 0; i < 3; i++) await run.driveSchemaConvertRun(NOT_OWED);
      assert.ok(fault.fired() > 0, 'the store fault was never reached: the passes wrote nothing to the space');
    } finally { fault.restore(); }
    const doc = await door.runDoc(NOT_OWED);
    assert.equal(doc.state, 'failed', `an act-started run was not failed after three failed passes: ${JSON.stringify(doc)}`);
  });

  it('an owed run with store failures past three passes is not failed, shows its failures and error, and completes once the store answers', async () => {
    const fault = await injectStoreFault(proto(), ['bulkWrite', 'updateOne', 'updateMany', 'findOneAndUpdate'], `${OWED}_entities`);
    try {
      for (let i = 0; i < FAILING_PASSES; i++) await run.driveSchemaConvertRun(OWED);
      assert.ok(fault.fired() > 0, 'the store fault was never reached');
    } finally { fault.restore(); }
    const failing = await door.runDoc(OWED);
    assert.equal(failing.state, 'running', `an owed run was set ${failing.state} after ${FAILING_PASSES} failed passes`);
    assert.equal(failing.failures, FAILING_PASSES);
    assert.equal(typeof failing.error, 'string', 'the status shows the last error');

    await run.driveSchemaConvertRun(OWED);
    const done = await door.runDoc(OWED);
    assert.equal(done.state, 'complete', `the owed run did not complete once the store answered: ${JSON.stringify(done)}`);
    const toFp = door.fp(OWED);
    for (const n of [1, 2]) assert.equal((await door.coll(OWED, 'entities').findOne({ _id: `${OWED}-p${n}` })).schemaFingerprint, toFp);
  });
});
