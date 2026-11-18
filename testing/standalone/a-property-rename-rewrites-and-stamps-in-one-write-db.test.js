/**
 * A record the steps change is rewritten and stamped in ONE write (Q-746, bundle-284 design r5 section 5.3 step 4, findings S4, DI-4).
 *
 * ## The rule
 *
 * A `renameProperty` step moves the value to the new name and removes the old one through the kind's own update function, at the version the
 * run read: one write per record, which lands the moved value, the run's fingerprint and one new version together. A rewrite is a real edit
 * (it replicates, which is the point), but it passes no actor, so no webhook and no live update is published for it.
 *
 * ## What it prevents
 *
 * A rewrite and a stamp in two writes leave a window in which the record is stored converted and unstamped (or stamped and unconverted), and a
 * second version that a peer receives for nothing.
 *
 * Seen red on 14af4644: the run module is not built.
 *
 * Run: node --test testing/standalone/a-property-rename-rewrites-and-stamps-in-one-write-db.test.js (test stack up, after `npm run build:server`)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openConvertDoor, CONVERT_META } from './_schema-convert.mjs';
import { STORE_WRITE_METHODS } from './_write-faults.mjs';
import { waitForValue } from '../_shared/wait-for.mjs';

const skip = await mongoSkipReason();
const S = 'rename';
const RENAME = { op: 'renameProperty', kind: 'entity', type: 'person', from: 'nick', to: 'alias' };
const AFTER = structuredClone(CONVERT_META);
AFTER.typeSchemas.entity.person.propertySchemas = { age: { type: 'number' }, alias: { type: 'string' } };

const WRITES = [...STORE_WRITE_METHODS, 'deleteOne', 'deleteMany'];

describe('a property rename rewrites and stamps in one write (real MongoDB)', { skip }, () => {
  let door, run, events, unsubscribe;
  before(async () => {
    door = await openConvertDoor({ name: 'b284rename', spaces: [S] });
    run = await door.runModule();
    const { subscribeBrainChanges } = await import('../../server/dist/brain/brain-events.js');
    events = [];
    unsubscribe = subscribeBrainChanges(S, ev => events.push(ev));
  });
  after(async () => { unsubscribe?.(); run?.stopSchemaConvertWatcher(); await door?.close(); });

  it('one write per record: the value moved, the stamp the run\'s, the version one up, nothing published', async () => {
    const [seeded] = await door.seed(S, 'entities', [{ _id: 'p-1', name: 'P', type: 'person', properties: { age: 4, nick: 'bob' } }]);
    door.setMeta(S, AFTER);
    const toFp = door.fp(S);
    const counterBefore = await door.counter(S);

    const proto = Object.getPrototypeOf(door.coll(S, 'entities'));
    const originals = Object.fromEntries(WRITES.map(m => [m, proto[m]]));
    const writes = [];
    for (const m of WRITES) {
      proto[m] = function spied(...args) {
        if (this.collectionName === `${S}_entities`) writes.push(m);
        return originals[m].apply(this, args);
      };
    }
    try {
      const started = await run.startSchemaConvertRun({ spaceId: S, types: [{ kind: 'entity', type: 'person' }], steps: [RENAME], source: { kind: 'act' } });
      assert.equal(started.ok, true, JSON.stringify(started));
      await waitForValue(async () => (await door.runDoc(S))?.state === 'complete' || null, 20_000, 100, undefined, { what: 'the run to complete' });
    } finally {
      Object.assign(proto, originals);
    }

    const row = await door.coll(S, 'entities').findOne({ _id: 'p-1' });
    assert.deepEqual(row.properties, { age: 4, alias: 'bob' }, 'the value moves to the new name and the old name is gone');
    assert.equal(row.schemaFingerprint, toFp, 'the rewrite carries the run\'s fingerprint');
    assert.ok(row.seq > seeded.seq, 'a rewrite is a new version');
    assert.equal(row.seq, counterBefore + 1, 'exactly one version was taken for the record');
    assert.deepEqual(writes, ['findOneAndUpdate'], `one write of the record, the update function's own: ${writes.join(', ')}`);
    assert.deepEqual(events, [], 'the run passes no actor: nothing is published for a rewrite');
    assert.equal((await door.runDoc(S)).counts.rewritten, 1);
  });
});
