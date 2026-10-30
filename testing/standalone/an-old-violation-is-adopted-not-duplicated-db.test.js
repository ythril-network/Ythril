/**
 * A dangling end recorded under a random id before bundle-30 is ADOPTED by the derived-id record the next check files,
 * not duplicated beside it, and is not announced again (Q-336).
 *
 * ## The defect
 *
 * A violation's `_id` has been derived from what it says since bundle-30, and written with `$setOnInsert`, so the same
 * dangling end is one record however often it is checked. Before that the row was inserted with a random uuid, and its
 * `docId`, `docType`, `field` and `reason` text were the very ones the check writes today. So the first re-landing of an
 * old dangling end, after an upgrade, found no record under its derived id, inserted a second row for the same end, and
 * fired `link_violation.created` for something the operator had been told about long ago — the copy that RECORDS rather
 * than refuses, which an operator reads as new damage.
 *
 * ## What is asserted
 *
 * - one old row (random id), then the same end checked again: one row, under the derived id, with the OLD `detectedAt`,
 *   and no `link_violation.created` for it;
 * - two old rows for one end (the upgrade's first re-land had already doubled it): one row left, with the earliest
 *   `detectedAt`;
 * - the event still fires for an end that is genuinely new (the spy sees the bus, so the quiet above is not a deaf spy);
 * - an old row for a DIFFERENT end of the same document is left alone.
 *
 * Run: node --test testing/standalone/an-old-violation-is-adopted-not-duplicated-db.test.js
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { build } from './_push-door.mjs';
import { openPullDoor } from './_pull-door.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();

const S = 'oldviolation';
const OLD = '2024-01-02T03:04:05.000Z';
const OLDER = '2023-06-07T08:09:10.000Z';
let door, linkage, events;

const rowsOf = (docId) => door.mongo.col(`${S}_link_violations`).find({ docId }).toArray();
const settled = () => linkage.whenLinkageChecksSettle();

/** A dangling edge pushed at `seq`, and the check it started finished. */
async function pushEdge(edge, seq, from, to) {
  const r = await door.push('/batch-upsert',
    { edges: [build.edge(S, edge, seq, { from, to, fromKind: 'chrono', toKind: 'chrono' })] }, { spaceId: S });
  assert.equal(r.code, 200, JSON.stringify(r.body));
  await settled();
}

describe('an old violation is adopted, not duplicated', { skip }, () => {
  let unsubscribe;
  before(async () => {
    door = await openPullDoor({ suite: 'oldviolation', spaces: [S], direction: 'push' });
    linkage = await import('../../server/dist/sync/linkage-check.js');
    const bus = await import('../../server/dist/brain/brain-events.js');
    events = [];
    unsubscribe = bus.subscribeBrainChanges(S, (ev) => { if (ev.event === 'link_violation.created') events.push(ev.entry); });
  });
  after(async () => { unsubscribe?.(); await door?.close(); });
  beforeEach(async () => {
    await door.reset({ direction: 'push' });
    await door.mongo.col(`${S}_link_violations`).deleteMany({});
    events.length = 0;
  });

  /** Make the one record the check filed look like what a pre-bundle-30 instance left: random id, older stamp. */
  async function asLegacy(docId, detectedAt) {
    const [row] = await rowsOf(docId);
    assert.ok(row, 'the first check recorded nothing — the fixture is broken');
    await door.mongo.col(`${S}_link_violations`).deleteOne({ _id: row._id });
    const legacyId = randomUUID();
    await door.mongo.col(`${S}_link_violations`).insertOne({ ...row, _id: legacyId, detectedAt });
    return { ...row, legacyId };
  }

  it('one old row for the end: the next check leaves ONE row, under the derived id, keeping the old date, silently', async () => {
    const [from, missing, edge] = [randomUUID(), randomUUID(), randomUUID()];
    await door.push('/batch-upsert', { chrono: [build.chrono(S, from, 1)] }, { spaceId: S });
    await pushEdge(edge, 2, from, missing);
    assert.equal(events.length, 1, 'the first record of a new end was not announced — the spy is deaf or the fixture is broken');
    const derived = await asLegacy(edge, OLD);
    events.length = 0;

    await pushEdge(edge, 3, from, missing);

    const rows = await rowsOf(edge);
    assert.equal(rows.length, 1, `a second record was filed for an end that was already recorded: ${JSON.stringify(rows.map(r => r._id))}`);
    assert.equal(rows[0]._id, derived._id, 'the surviving row is not the derived-id one');
    assert.equal(rows[0].detectedAt, OLD, 'the old row\'s detectedAt was not kept: the operator is told the end is new');
    assert.deepEqual(events, [], 'link_violation.created fired for an end that was already recorded');
  });

  it('two old rows for the end (a first re-land had doubled it): one is left, the earliest date kept', async () => {
    const [from, missing, edge] = [randomUUID(), randomUUID(), randomUUID()];
    await door.push('/batch-upsert', { chrono: [build.chrono(S, from, 1)] }, { spaceId: S });
    await pushEdge(edge, 2, from, missing);
    const derived = await asLegacy(edge, OLD);
    await door.mongo.col(`${S}_link_violations`).insertOne({ ...derived, _id: randomUUID(), detectedAt: OLDER });
    events.length = 0;

    await pushEdge(edge, 3, from, missing);

    const rows = await rowsOf(edge);
    assert.equal(rows.length, 1, `old rows were left beside the adopted one: ${JSON.stringify(rows.map(r => r._id))}`);
    assert.equal(rows[0]._id, derived._id);
    assert.equal(rows[0].detectedAt, OLDER);
    assert.deepEqual(events, []);
  });

  it('an end that is new is still recorded and announced, and an old row for another end of the document is untouched', async () => {
    const [from, missingA, missingB, edge] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    await door.push('/batch-upsert', { chrono: [build.chrono(S, from, 1)] }, { spaceId: S });
    await pushEdge(edge, 2, from, missingA);
    const legacy = await asLegacy(edge, OLD);
    events.length = 0;

    // The edge now points its `to` at another missing target: a different end (`to` again, another id), so a NEW record.
    await pushEdge(edge, 3, from, missingB);

    const rows = await rowsOf(edge);
    assert.equal(rows.length, 2, `expected the old row and the new end's record: ${JSON.stringify(rows)}`);
    assert.ok(rows.some(r => r._id === legacy.legacyId && r.detectedAt === OLD), 'the old row of the ended dangling end was changed');
    assert.equal(events.length, 1, 'a genuinely new dangling end was not announced');
  });
});
