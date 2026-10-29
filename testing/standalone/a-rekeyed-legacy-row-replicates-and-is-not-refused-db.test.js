/**
 * A pre-bundle-71 file row reaches a peer, once its sync cycle has put it at its key, and the peer does not refuse it (Q-413).
 *
 * A row stored under a spelling that is not its path's key is refused by every upgraded peer (`fileKeyRefusal`, counted in `filemeta.rejected`)
 * for as long as it is offered, and it was never even served: it has no landing position of this instance's stream. The sync cycle that reads
 * every top-level row puts it at its key first (lazily, never at boot), so the row takes a landing position and is served under its key, and a
 * receiver that holds the rule accepts it. The re-key writes no tombstone, so no peer deletes anything.
 *
 * Seen red on the base: after the cycle the page the peer pulls does not hold the row at all (it is still at its legacy id, with no position),
 * and the receiver is offered nothing. The control (a row stored under its key) pins that the cycle changes nothing else.
 *
 * The decomposed name is built with `normalize('NFD')`.
 *
 * Run: YTHRIL_TEST_MONGO_PORT=27117 YTHRIL_TEST_MONGO_CREDS=ythril:ythril-test-pw node --test testing/standalone/a-rekeyed-legacy-row-replicates-and-is-not-refused-db.test.js
 * (requires a prior `npm run build:server`)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { openFileActDoors } from './_file-act-doors.mjs';
import { build } from './_push-door.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();

const S = 'legacyrepl';
const RECEIVER = 'legacyrecv';
const KEY = 'Café.txt';
const LEGACY = KEY.normalize('NFD');
const T0 = '2026-09-01T00:00:00.000Z';

let d, forgetLegacyIndex, writeArrivals;

/** What a peer pulls from this instance for the files family. */
async function served() {
  return (await d.door.pull('/filemeta', { spaceId: S })).items;
}

describe('a re-keyed legacy row replicates and is not refused', { skip }, () => {
  before(async () => {
    d = await openFileActDoors({ suite: 'legacyrepl', space: S, otherSpaces: [RECEIVER] });
    ({ forgetLegacyIndex } = await import('../../server/dist/files/legacy-file-keys.js'));
    ({ writeArrivals } = await import('../../server/dist/sync/arrivals.js'));
  });
  after(async () => { await d?.close(); });
  beforeEach(async () => { await d.reset(); forgetLegacyIndex(S); await d.door.coll(RECEIVER, 'files').deleteMany({}); });

  it('before the cycle the legacy row is not offered; after it the row is served under its key and the receiver stores it', async () => {
    assert.notEqual(LEGACY, KEY, 'the fixture name has no decomposed form');
    await d.files.writeFile(S, KEY, 'bytes');
    await d.door.coll(S, 'files').insertOne(build.filemeta(S, LEGACY, 7, { description: 'legacy', sizeBytes: 5, createdAt: T0, updatedAt: T0 }));
    forgetLegacyIndex(S);

    await d.pushed();

    const items = await served();
    assert.deepEqual(items.map(i => i._id), [KEY], `the peer is offered ${JSON.stringify(items.map(i => i._id))}`);
    assert.equal(items[0].seq, 7, 'the re-key changed the version');
    const out = await writeArrivals(RECEIVER, 'files', 'file', items, { deliveredBy: 'legacy-sender' });
    assert.deepEqual(out.refused, [], 'the receiver refused the row');
    assert.deepEqual([...out.inserted], [KEY]);
    assert.equal(await d.door.coll(S, 'file_tombstones').countDocuments({}), 0, 'a re-key wrote a file tombstone');
  });

  it('control: a row stored under its key is served as it was, and a cycle changes nothing about it', async () => {
    await d.files.writeFile(S, KEY, 'bytes');
    await d.door.coll(S, 'files').insertOne(build.filemeta(S, KEY, 7, { description: 'canonical', sizeBytes: 5, createdAt: T0, updatedAt: T0, pos: 1, posAtSeq: 7 }));
    await d.pushed();
    const row = await d.door.coll(S, 'files').findOne({ _id: KEY });
    assert.equal(row.pos, 1, 'a row at its key took a new landing position');
    assert.equal(row.description, 'canonical');
  });
});
