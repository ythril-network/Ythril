/**
 * A strict-linkage violation is recorded only for a target that is NOT COMING — never for one later in the same
 * transfer — and recorded once, however often the record is checked (bundle-30 I8, pre-ship data-integrity lens).
 *
 * ## The defect
 *
 * The check ran fire-and-forget right after each PAGE landed, and a pull lands its families one page at a time in
 * `REPLICATED_FAMILIES` order (facts, entities, edges, chrono, links, filemeta). So an edge to a chrono entry created
 * in the same interval was checked while its target was still to be pulled, and recorded as a violation with a fresh
 * uuid nothing dedupes — the copy that RECORDS rather than refuses, which an operator reads as real damage.
 *
 * ## What is asserted
 *
 * - An edge pulled with its chrono end in the same cycle records nothing.
 * - An edge to an end that never arrives records exactly one violation per end, and a later edit of that edge
 *   (which lands and is checked again) still leaves exactly one.
 *
 * Run: node --test testing/standalone/a-linkage-violation-waits-for-the-whole-transfer-db.test.js
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { build } from './_push-door.mjs';
import { openPullDoor, PEER_AUTHOR } from './_pull-door.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();
process.env['YTHRIL_MODELS_OFFLINE'] = '1';

const S = 'linkwait';
let door;

/** What the violation log holds for `docId`, after any check still in flight had time to land. */
async function violationsOf(docId) {
  await new Promise(r => setTimeout(r, 400));
  return door.mongo.col(`${S}_link_violations`).find({ docId }).toArray();
}

describe('a linkage violation waits for the whole transfer, and is recorded once', { skip }, () => {
  before(async () => { door = await openPullDoor({ suite: 'linkwait', spaces: [S] }); });
  after(async () => { await door?.close(); });
  beforeEach(async () => {
    await door.reset();
    await door.mongo.col(`${S}_link_violations`).deleteMany({});
  });

  it('an edge pulled with its chrono end in the same cycle records no violation', async () => {
    const [from, to, edge] = [randomUUID(), randomUUID(), randomUUID()];
    const remote = door.remoteOf(S);
    door.state.records[remote] = {
      edges: [build.edge(remote, edge, 3, { from, to, fromKind: 'chrono', toKind: 'chrono', author: { ...PEER_AUTHOR } })],
      chrono: [from, to].map((id, i) => build.chrono(remote, id, 1 + i, { author: { ...PEER_AUTHOR } })),
    };
    await door.sync();
    assert.ok(await door.mongo.col(`${S}_edges`).findOne({ _id: edge }), 'the edge did not land — the fixture is broken');
    assert.ok(await door.mongo.col(`${S}_chrono`).findOne({ _id: to }), 'the chrono end did not land — the fixture is broken');
    const v = await violationsOf(edge);
    assert.deepEqual(v.map(x => `${x.field}: ${x.reason}`), [],
      'a target later in the same transfer was recorded as missing');
  });

  it('an edge to an end that never arrives records exactly one violation, and a re-check adds none', async () => {
    const [from, missing, edge] = [randomUUID(), randomUUID(), randomUUID()];
    const remote = door.remoteOf(S);
    const page = (seq, description) => ({
      edges: [build.edge(remote, edge, seq, { from, to: missing, fromKind: 'chrono', toKind: 'chrono', description,
        author: { ...PEER_AUTHOR } })],
      chrono: [build.chrono(remote, from, 1, { author: { ...PEER_AUTHOR } })],
    });
    door.state.records[remote] = page(3, 'first');
    await door.sync();
    const once = await violationsOf(edge);
    assert.deepEqual(once.map(x => x.field), ['to'], 'the dangling end must be recorded, once, and the present one not');

    // An edit of the same edge lands and is checked again; the end is still missing — still ONE record of it.
    door.member().lastSeqReceived = {};
    door.state.records[remote] = page(4, 'edited');
    await door.sync();
    assert.equal((await door.mongo.col(`${S}_edges`).findOne({ _id: edge }))?.description, 'edited',
      'the edit did not land, so nothing was checked again — the fixture is broken');
    const twice = await violationsOf(edge);
    assert.deepEqual(twice.map(x => x.field), ['to'], 'a re-check recorded the same violation a second time');
  });
});
