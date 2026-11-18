/**
 * A record whose conversion keeps failing for a reason the converter does not know does not hold the run for ever: after the stated number of
 * failed passes it becomes an item naming the kind of error, and the run goes on (`Q-746`, bundle-284 fix round after the lens sweep: S4).
 *
 * ## What it prevents
 *
 * A per-record refusal outside the listed classes failed the whole page. A run a vote started is owed and never set `failed`, so it retried that
 * page every few minutes for ever and never reached its later types. And a strict refusal by the update function itself (`SchemaViolationError`, a
 * classification that differed from the pre-check) was one of those unknown errors, though it is a refusal of the record.
 *
 * ## What holds (the rewrite of one record is made to fail on cue; everything else is production's)
 *
 * - a `SchemaViolationError` from the rewrite is the record's own refusal at once: an item `not_conforming`, the run goes on;
 * - a plain error from the rewrite of one record fails the page, and again on the next passes; once that record has failed the stated number of
 *   passes (`SCHEMA_CONVERT_RECORD_FAILED_PASSES`) it is an item `conversion_failed` whose violation names the error's kind (its class name),
 *   never its message; every other record is converted and the run completes;
 * - the item holds no word of the error's message.
 *
 * Run: node --test testing/standalone/a-record-that-keeps-failing-becomes-an-item-db.test.js (test stack up, after `npm run build:server`)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openConvertDoor, CONVERT_META } from './_schema-convert.mjs';
import { waitForValue } from '../_shared/wait-for.mjs';

const skip = await mongoSkipReason();
const RENAMED = structuredClone(CONVERT_META);
RENAMED.typeSchemas.entity.person.propertySchemas = { age: { type: 'number' }, handle: { type: 'string' } };
const STEP = { op: 'renameProperty', kind: 'entity', type: 'person', from: 'nick', to: 'handle' };
const SECRET = 'a message that must never reach an item';

describe('a record that keeps failing becomes an item (real MongoDB)', { skip }, () => {
  let door, run, validation;
  before(async () => {
    door = await openConvertDoor({ name: 'b284failing', spaces: ['violates', 'fails'] });
    run = await door.runModule();
    validation = await import('../../server/dist/brain/write-validation.js');
  });
  after(async () => { run?.stopSchemaConvertWatcher(); await door?.close(); });

  /** Five persons with a nick, the schema renamed, and a run started with the rename; `onRewrite` decides what the rewrite of each record does. */
  async function startOn(space, onRewrite) {
    await door.seed(space, 'entities', Array.from({ length: 5 }, (_, i) => ({ _id: `p-${i}`, name: `P${i}`, type: 'person', properties: { nick: `n${i}` } })));
    door.setMeta(space, RENAMED);
    run.stopSchemaConvertWatcher();
    const started = await run.startSchemaConvertRun({ spaceId: space, types: [{ kind: 'entity', type: 'person' }], steps: [STEP], source: { kind: 'act' } }, { onRewrite });
    assert.equal(started.ok, true, JSON.stringify(started));
    // The watcher's tick would retry a failed pass WITHOUT the hook (it holds no deps), so it is stopped, and each pass after the first is driven
    // here with the hook, once the pass before it has let go of the lease.
    run.stopSchemaConvertWatcher();
    for (let pass = 0; pass < 10; pass++) {
      const doc = await waitForValue(async () => { const d = await door.runDoc(space); return d && (d.state !== 'running' || d.sweepLeaseAt === 0) ? d : null; },
        10_000, 50, async () => `the pass did not let go: ${JSON.stringify(await door.runDoc(space))}`, { what: `a pass of ${space} to end` });
      if (doc.state !== 'running') return doc;
      await run.driveSchemaConvertRun(space, { onRewrite });
    }
    return await door.runDoc(space);
  }

  it('a SchemaViolationError from the rewrite is the record\'s refusal at once: an item not_conforming, the run goes on', async () => {
    const onRewrite = (_kind, record) => {
      if (record._id === 'p-2') {
        throw new validation.SchemaViolationError({ blocked: true, message: 'strict', all: [{ field: 'properties.handle', reason: 'strict' }], violations: [] });
      }
    };
    const done = await startOn('violates', onRewrite);
    assert.equal(done.state, 'complete', `the run did not complete: ${JSON.stringify(done)}`);
    assert.equal(done.counts.rewritten, 4);
    const items = await door.itemRows('violates');
    assert.deepEqual(items.map(i => [i.recordId, i.reason]), [['p-2', 'not_conforming']], JSON.stringify(items));
  });

  it('a plain error from one record\'s rewrite: after the stated passes it is an item conversion_failed naming the error\'s kind, and the run completes', async () => {
    let tries = 0;
    const onRewrite = (_kind, record) => {
      if (record._id === 'p-3') { tries++; throw new TypeError(SECRET); }
    };
    const done = await startOn('fails', onRewrite);
    assert.equal(done.state, 'complete', `the run was held by one failing record: ${JSON.stringify({ state: done.state, failures: done.failures, error: done.error })}`);
    // The records, not the counts: a page that failed rewrote the records before the failing one, and a failed page counts nothing.
    const held = await door.coll('fails', 'entities').find({}).sort({ _id: 1 }).toArray();
    assert.deepEqual(held.map(r => [r._id, Object.keys(r.properties)]), [['p-0', ['handle']], ['p-1', ['handle']], ['p-2', ['handle']], ['p-3', ['nick']], ['p-4', ['handle']]],
      `every record but the failing one was converted: ${JSON.stringify(done.counts)}`);
    assert.equal(tries, run.SCHEMA_CONVERT_RECORD_FAILED_PASSES, `the failing record was tried ${tries} times`);
    const items = await door.itemRows('fails');
    assert.equal(items.length, 1, JSON.stringify(items));
    assert.equal(items[0].recordId, 'p-3');
    assert.equal(items[0].reason, 'conversion_failed');
    assert.deepEqual(items[0].violations.map(v => v.reason), ['TypeError'], 'the item does not name the kind of error');
    assert.ok(!JSON.stringify(items[0]).includes(SECRET), 'the item holds the error\'s message');
  });
});
