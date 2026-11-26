/**
 * The triple index's follower applies a committed write while another transaction holds a floor below it, and applies nothing once the
 * space's form changed (bundle-273, Q-764 slice S1; design-r2 R1 and R3; contract rows 4 and 6).
 *
 * ## The rules
 *
 * 1. **R1: a held floor does not hide a committed write.** While a transaction of the space holds its position floor (the settled cap stays
 *    below it), a write that lands above the floor and commits is in the index when it returns: the follower applies every visible record
 *    above `appliedPos`, whatever the cap. `appliedPos` itself stays below the floor (it advances only to cap - 1).
 * 2. **R3: a new form stops the follower.** The index is built for one form of the space's meta (`formKey`). After the meta changes, the next
 *    write's batch compares the form it computed with against `formKey` inside its transaction, marks the index `stale` and applies nothing:
 *    the new record has no row, and the old record's row is as it was.
 *
 * ## Seen red
 *
 * On aae46da89 (no index): rule 1 fails at "the write above the floor is in the index", rule 2 at the first state read.
 *
 * Run: a Mongo the harness accepts, npm run build:server, then
 *      node --test testing/standalone/the-triple-index-follower-passes-a-held-floor-and-stops-at-a-new-form-db.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openSparqlDoors, rdfMeta } from './_sparql-doors.mjs';
import { assertIndexedAsStored, indexedStatements, indexState } from './_triple-index.mjs';

const skip = await mongoSkipReason();
const H = 'tix-held';
const F = 'tix-form';
const STAMP = '2026-03-04T05:06:07.000Z';

let d, stream, held, clock;
const col = (space, part) => d.col(d.spaceCollection(space, part));
const entity = (space, id, name) => ({ _id: id, spaceId: space, name, type: 'thing', seq: 1, tags: [], createdAt: STAMP, updatedAt: STAMP });

async function landed(space, doc) {
  await stream.withLandingStamp(space, [stream.localRow(1)], async ([patch]) => {
    await col(space, 'entities').replaceOne({ _id: doc._id }, { ...doc, ...patch }, { upsert: true });
  }, 'test.landing');
}

describe('the triple index follower passes a held floor and stops at a new form', { skip }, () => {
  before(async () => {
    d = await openSparqlDoors({ suite: 'b273-tix-follow', spaces: [{ id: H, meta: rdfMeta(H) }, { id: F, meta: rdfMeta(F) }] });
    stream = await import('../../server/dist/sync/record-position-stream.js');
    held = await import('../../server/dist/brain/held-transaction.js');
    clock = await import('../../server/dist/util/position-clock.js');
  });
  after(async () => { await d?.close(); });

  it('R1: a write that commits while another transaction holds a floor is in the index when it returns', async () => {
    await landed(H, entity(H, 'h0', 'Before'));
    let release;
    const gate = new Promise((r) => { release = r; });
    let entered;
    const inside = new Promise((r) => { entered = r; });
    const txn = held.inHeldTransaction(H, 'test.floor', async () => { entered(); await gate; });
    try {
      await inside;
      const floor = clock.lowestOpenPosition(stream.recordPositions, H);
      assert.ok(typeof floor === 'number', 'the transaction holds a floor');
      await landed(H, entity(H, 'h1', 'Above the floor'));
      const row = await col(H, 'entities').findOne({ _id: 'h1' });
      assert.ok(row.pos > floor, 'the write took a position above the open floor');
      await assertIndexedAsStored(assert, d, H, 'entity', 'entities', 'h1');
      assert.ok((await indexedStatements(d, H, 'entity', 'h1')).length > 0, 'the write above the floor is in the index');
      const state = await indexState(d, H);
      assert.ok(state.appliedPos < floor, `appliedPos ${state.appliedPos} stays below the held floor ${floor}`);
    } finally {
      release();
      await txn;
    }
    await landed(H, entity(H, 'h2', 'After'));
    const state = await indexState(d, H);
    assert.ok(state.appliedPos >= (await col(H, 'entities').findOne({ _id: 'h2' })).pos, 'with the floor gone, appliedPos passes the last write');
  });

  it('R3: after the meta changes, the next write marks the index stale and applies nothing', async () => {
    await landed(F, entity(F, 'f0', 'Old form'));
    await assertIndexedAsStored(assert, d, F, 'entity', 'entities', 'f0');
    const before = await indexState(d, F);
    assert.equal(before?.status, 'ready', `the index starts ready: ${JSON.stringify(before)}`);
    const oldRow = await d.col(`${F}_rdf_records`).findOne({ _id: 'entity:f0' });

    await d.loader.mutateConfig((cfg) => {
      const space = cfg.spaces.find(s => s.id === F);
      space.meta = { ...space.meta, typeSchemas: { entity: { thing: { propertySchemas: { size: { type: 'number' } } } } } };
    });
    await landed(F, entity(F, 'f1', 'New form'));

    const after = await indexState(d, F);
    assert.equal(after.status, 'stale', `a batch under a new form marks the index stale: ${JSON.stringify(after)}`);
    assert.equal(after.formKey, before.formKey, 'the stored formKey is the old form\'s');
    assert.equal(after.appliedPos, before.appliedPos, 'a stale batch moves appliedPos nowhere');
    assert.equal(await indexedStatements(d, F, 'entity', 'f1'), null, 'the record written under the new form is not applied');
    assert.deepEqual(await d.col(`${F}_rdf_records`).findOne({ _id: 'entity:f0' }), oldRow, 'the old record row is untouched');
  });
});
