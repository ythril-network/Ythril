/**
 * The re-key of a legacy file row writes NO tombstone of any kind, links included (Q-413, bundle-88 review F3).
 *
 * ## The rule
 *
 * "My instance = my data" (CLAUDE.md): no action this instance takes decides what a peer holds, and a re-key is housekeeping, not an act of
 * a user. It repairs where THIS instance keeps a row, so what it does to the row's links is local too:
 *
 *  1. The legacy row's data survives (it wins, nothing at the key beats it): its links are carried to the key, every one of them, each
 *     under the author that wrote it (a link another instance wrote stays another instance's, so the delete that removes "the links this
 *     instance wrote" still tells them apart), and nothing the key already held is removed. No link tombstone is written.
 *  2. The legacy row loses (a row at the key has the higher or an equal version) or is shadowed by a held file tombstone: its links are
 *     removed from this instance's own rows without a tombstone, and the key's links are what they were.
 *  3. The only tombstones the space holds afterwards are the ones it held before: no file tombstone, no link tombstone.
 *
 * ## Seen red
 *
 * On the base the re-key retired the legacy id's links through the reconcile that writes a tombstone per link (1 and 2: a link tombstone for
 * the link this instance wrote AND for the one another instance wrote), carried them only when the legacy row won (2 dropped them), and its
 * non-additive carry removed what the key already held, with tombstones (1, the last case).
 *
 * Run: YTHRIL_TEST_MONGO_PORT=27117 YTHRIL_TEST_MONGO_CREDS=ythril:ythril-test-pw node --test testing/standalone/a-rekey-of-a-legacy-file-row-writes-no-link-tombstone-db.test.js
 * (requires a prior `npm run build:server`)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { openFileActDoors } from './_file-act-doors.mjs';
import { build } from './_push-door.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();

const S = 'rekeylinks';
const T0 = '2026-09-01T00:00:00.000Z';
const LEGACY = 'a//b.txt';
const KEY = 'a/b.txt';

/** What a file can link to: ids are UUID v4 under the default strict linkage, and the entities exist (a link to a missing one is not carried). */
const E_OWN = '11111111-1111-4111-8111-111111111111';
const E_THEIRS = '22222222-2222-4222-8222-222222222222';
const E_HELD = '33333333-3333-4333-8333-333333333333';
const E_LEGACY = '44444444-4444-4444-8444-444444444444';

let d, forgetLegacyIndex, fileRowIdFor, linkIdFor, authorRef;
const rows = () => d.door.coll(S, 'files');
const linkRows = (from) => d.door.coll(S, 'links').find({ from }).toArray();

const row = (id, seq, extra = {}) => build.filemeta(S, id, seq, { sizeBytes: 3, createdAt: T0, updatedAt: T0, ...extra });
async function plantLegacy(seq = 7) {
  await d.files.writeFile(S, KEY, 'abc');
  await rows().insertOne(row(LEGACY, seq));
  forgetLegacyIndex(S);
}
const rekey = () => fileRowIdFor(S, KEY);
const nothingTombstoned = async (what) => {
  assert.deepEqual(await d.links.tombstoned(), [], `${what}: the re-key wrote a link tombstone`);
  assert.deepEqual(await d.raw(), [], `${what}: the re-key wrote a file tombstone`);
};

describe('the re-key of a legacy file row writes no tombstone of any kind', { skip }, () => {
  before(async () => {
    d = await openFileActDoors({ suite: 'rekeylinks', space: S });
    ({ forgetLegacyIndex } = await import('../../server/dist/files/legacy-file-keys.js'));
    ({ fileRowIdFor } = await import('../../server/dist/files/file-meta.js'));
    ({ linkIdFor } = await import('../../server/dist/brain/link-id.js'));
    ({ authorRef } = await import('../../server/dist/config/author.js'));
  });
  after(async () => { await d?.close(); });
  beforeEach(async () => {
    await d.reset(); await d.links.reset(); forgetLegacyIndex(S);
    const entities = d.door.coll(S, 'entities');
    await entities.deleteMany({});
    await entities.insertMany([E_OWN, E_THEIRS, E_HELD, E_LEGACY].map((_id, i) => ({
      _id, spaceId: S, name: `Entity ${i}`, type: 'thing', tags: [], createdAt: T0, seq: i + 1, author: { instanceId: 'local-instance', instanceLabel: 'Local' } })));
  });

  it('a legacy row that wins carries every link to its key under the author that wrote it, and tombstones none (1)', async () => {
    await plantLegacy();
    const own = await d.links.put(LEGACY, E_OWN, 'self');
    const theirs = await d.links.put(LEGACY, E_THEIRS, 'peer');
    await rekey();
    assert.deepEqual(await d.links.idsFrom(LEGACY), [], 'a link is still at the legacy id');
    const atKey = await linkRows(KEY);
    assert.deepEqual(atKey.map(l => l.to).sort(), [E_OWN, E_THEIRS], 'the links do not answer at the key');
    assert.notEqual(own, theirs);
    const authorOf = (to) => atKey.find(l => l.to === to).author?.instanceId;
    assert.equal(authorOf(E_OWN), authorRef().instanceId, 'the link this instance wrote lost its author');
    assert.equal(authorOf(E_THEIRS), d.links.OTHER_INSTANCE.instanceId, 'the link another instance wrote was re-attributed');
    await nothingTombstoned('a legacy row that wins');
  });

  it('a legacy row that wins over a lower row at the key keeps what the key already held (1)', async () => {
    await plantLegacy(7);
    await rows().insertOne(row(KEY, 3));
    await d.links.put(KEY, E_HELD, 'self');
    await d.links.put(LEGACY, E_LEGACY, 'peer');
    await rekey();
    assert.deepEqual((await linkRows(KEY)).map(l => l.to).sort(), [E_HELD, E_LEGACY], 'the carry removed a link the key held, or lost the legacy one');
    await nothingTombstoned('a legacy row that wins over a lower one');
  });

  it('a legacy row that loses to the row at the key is dropped with its links, without a tombstone (2)', async () => {
    await plantLegacy(7);
    await rows().insertOne(row(KEY, 9));
    await d.links.put(KEY, E_HELD, 'self');
    await d.links.put(LEGACY, E_OWN, 'self');
    await d.links.put(LEGACY, E_THEIRS, 'peer');
    await rekey();
    assert.equal(await rows().findOne({ _id: LEGACY }), null, 'the losing legacy row survived');
    assert.deepEqual(await d.links.idsFrom(LEGACY), [], 'the losing row\'s links survived');
    assert.deepEqual((await linkRows(KEY)).map(l => l.to), [E_HELD], 'the key\'s links are not what they were');
    await nothingTombstoned('a legacy row that loses');
  });

  it('a legacy row a held tombstone shadows is dropped with its links, without a tombstone of the re-key\'s own (2)', async () => {
    await plantLegacy(7);
    await d.door.coll(S, 'file_tombstones').insertOne({ _id: `held-${KEY}`, spaceId: S, path: KEY, deletedAt: T0, positionAt: T0, rowSeq: 9, issuer: 'push-door-peer' });
    await d.links.put(LEGACY, E_OWN, 'self');
    await d.links.put(LEGACY, E_THEIRS, 'peer');
    await rekey();
    assert.equal(await rows().findOne({ _id: LEGACY }), null);
    assert.deepEqual(await d.links.idsFrom(LEGACY), []);
    assert.deepEqual(await linkRows(KEY), [], 'a shadowed row\'s links were carried to its key');
    assert.deepEqual(await d.links.tombstoned(), [], 'the re-key wrote a link tombstone');
    assert.equal((await d.raw()).length, 1, 'the re-key wrote a file tombstone (only the held one stands)');
  });

  it('the link ids at the key are derived from the key (control)', async () => {
    await plantLegacy();
    await d.links.put(LEGACY, E_OWN, 'self');
    await rekey();
    assert.deepEqual(await d.links.idsFrom(KEY), [linkIdFor(KEY, 'file', E_OWN, 'entity')]);
  });
});
