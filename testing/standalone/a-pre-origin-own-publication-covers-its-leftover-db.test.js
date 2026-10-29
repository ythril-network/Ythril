/**
 * A tombstone this instance published before `origin` existed still covers the pending leftover of its own act (bundle-88, Q-414).
 *
 * ## The defect
 *
 * `covers()` takes only a published row stamped `origin: 'own'` for this instance's own publication. A row published before the
 * stamp existed (bundle-71) carries none, though it does carry `issuer`, and it was therefore taken for nobody's: the pending
 * leftover of the same act, written before it, was published a second time on the first settle after the upgrade.
 *
 * ## The rule this file states
 *
 * A published row with no `origin`, no `storedVia` (it was not relayed here) and this instance as its `issuer` is an own
 * publication. A row that names another instance as issuer, or that a peer delivered (`storedVia`), is not.
 *
 * ## Seen red
 *
 * On the base (1e430410c): the settle publishes the leftover, so the path holds two published tombstones.
 *
 * Run: node --test testing/standalone/a-pre-origin-own-publication-covers-its-leftover-db.test.js
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { openFileActDoors } from './_file-act-doors.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();
const S = 'preorigin';
const WRITTEN = '2026-09-01T00:00:00.000Z';
const PUBLISHED = '2026-09-01T00:05:00.000Z';
const PAST_THE_WINDOW = () => new Date(Date.now() + 24 * 3_600_000);

let acts, tombstones, author;

const publishedFor = async (p) => (await acts.raw()).filter(t => !t.pending && t.path === p);
const pendingFor = async (p) => (await acts.raw()).filter(t => t.pending && t.path === p);
const plantPublished = (id, p, extra) => acts.door.coll(S, 'file_tombstones').insertOne(
  { _id: id, spaceId: S, path: p, deletedAt: PUBLISHED, positionAt: PUBLISHED, ...extra });
const plantLeftover = (id, p) => acts.door.coll(S, 'file_tombstones').insertOne(
  { _id: id, spaceId: S, path: p, deletedAt: WRITTEN, writtenAt: WRITTEN, settleAt: WRITTEN, pending: true });

describe('a publication from before origin existed covers its leftover', { skip }, () => {
  before(async () => {
    acts = await openFileActDoors({ suite: 'preorigin', space: S });
    tombstones = await import('../../server/dist/files/tombstones.js');
    author = (await import('../../server/dist/config/author.js')).authorRef();
  });
  after(async () => { await acts?.close(); });
  beforeEach(async () => { await acts.reset(); });

  it('a published row with no origin and this instance as issuer: the leftover is dropped, not published again', async () => {
    assert.ok(author.instanceId, 'this instance has no id — the case cannot be built');
    await plantPublished('legacy-own', 'a.txt', { issuer: author.instanceId });
    await plantLeftover('leftover', 'a.txt');
    await tombstones.settleStalePendingFileTombstones(S, PAST_THE_WINDOW());
    const published = await publishedFor('a.txt');
    assert.deepEqual(published.map(t => t._id), ['legacy-own'],
      `the leftover of an act already published was published a second time: ${JSON.stringify(published.map(t => t._id))}`);
    assert.deepEqual(await pendingFor('a.txt'), []);
  });

  it('a published row naming another instance as issuer, or one a peer delivered, is not this instance\'s publication', async () => {
    await plantPublished('other-issuer', 'b.txt', { issuer: 'another-instance' });
    await plantLeftover('left-b', 'b.txt');
    await plantPublished('delivered', 'c.txt', { issuer: author.instanceId, storedVia: 'upstream' });
    await plantLeftover('left-c', 'c.txt');
    await tombstones.settleStalePendingFileTombstones(S, PAST_THE_WINDOW());
    assert.equal((await publishedFor('b.txt')).length, 2, 'another instance\'s publication covered this instance\'s own pending delete');
    assert.equal((await publishedFor('c.txt')).length, 2, 'a tombstone a peer delivered covered this instance\'s own pending delete');
  });
});
