/**
 * An item of a record a conversion could not convert goes stale by ITS type, and is removed by the watcher's tick, never by a read (Q-746 and
 * Q-919, bundle-284 design r5 section 6 "Stale and removed", findings S9, N5).
 *
 * ## The rule
 *
 * - A change to another type (the space's fingerprint moves) leaves the item: its record is judged by its own type, which is defined as it was.
 * - A change to the item's own type makes it stale; the next tick of the run module's watcher removes it.
 * - Listing the items writes nothing: a stale item is still listed until the tick, and the list call leaves every row as it found it.
 *
 * ## What was wrong
 *
 * r3 purged every item whose fingerprint was not the space's (any schema write emptied the list, S9) and swept stale items from the list read
 * (a GET that wrote, N5).
 *
 * Seen red on 14af4644: the run module is not built.
 *
 * Run: node --test testing/standalone/a-stale-item-is-swept-by-type-db.test.js (test stack up, after `npm run build:server`)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openConvertDoor, CONVERT_META } from './_schema-convert.mjs';
import { waitForValue } from '../_shared/wait-for.mjs';

const skip = await mongoSkipReason();
const S = 'stale-items';
const OTHER_TYPE_CHANGED = structuredClone(CONVERT_META);
OTHER_TYPE_CHANGED.typeSchemas.fact.claim.propertySchemas.source = { type: 'string' };
const OWN_TYPE_CHANGED = structuredClone(OTHER_TYPE_CHANGED);
OWN_TYPE_CHANGED.typeSchemas.entity.person.propertySchemas.height = { type: 'number' };

describe('a stale item is swept by type (real MongoDB)', { skip }, () => {
  let door, run, items;
  before(async () => {
    door = await openConvertDoor({ name: 'b284staleitems', spaces: [S] });
    run = await door.runModule();
    items = await door.itemsModule();
  });
  after(async () => { run?.stopSchemaConvertWatcher(); await door?.close(); });

  it('another type\'s change keeps the item; its own type\'s change removes it at the next tick; a list writes nothing', async () => {
    await door.seed(S, 'entities', [{ _id: 'bad', name: 'Bad', type: 'person', properties: { age: 'old' } }]);
    const started = await run.startSchemaConvertRun({ spaceId: S, types: [{ kind: 'entity', type: 'person' }], steps: [], source: { kind: 'act' } });
    assert.equal(started.ok, true, JSON.stringify(started));
    await waitForValue(async () => (await door.runDoc(S))?.state === 'complete' || null, 20_000, 100, undefined, { what: 'the run to complete' });
    const [item] = await door.itemRows(S);
    assert.equal(item?.recordId, 'bad', 'precondition: the run wrote an item for the record it could not convert');

    door.setMeta(S, OTHER_TYPE_CHANGED);
    await run.schemaConvertRunTick();
    assert.deepEqual((await door.itemRows(S)).map(i => i._id), [item._id], 'a change to another type removed the item');

    door.setMeta(S, OWN_TYPE_CHANGED);
    const rowsBefore = await door.itemRows(S);
    const listed = await items.listUnconvertedItems(S, {});
    assert.deepEqual(listed.items.map(i => i.recordId), ['bad'], 'until the tick, the stale item is still listed');
    assert.deepEqual(await door.itemRows(S), rowsBefore, 'the list wrote to the items');

    await run.schemaConvertRunTick();
    assert.deepEqual(await door.itemRows(S), [], 'a change to the item\'s own type left it after the tick');
  });
});
