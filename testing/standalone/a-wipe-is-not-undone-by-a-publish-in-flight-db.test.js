/**
 * A wipe of a space's files is not undone by a publish that was already on its way (bundle-71, Q-406, D7).
 *
 * ## The defect
 *
 * A file act writes its tombstone PENDING, removes the bytes, and publishes: `publishOnePerPath` upserts its winner by id,
 * and the upsert is deliberate — it writes again a row the stale settle dropped while the act was still running. The
 * wipe of a space (`wipeSpace` with `files`) empties the tombstone collection too, so a publish whose act, move settle or
 * TTL settle read its rows before the wipe and writes after it re-creates a tombstone in a space that has just been
 * emptied. The re-created row is published: it is served, pushed to every peer, and a peer deletes its copy of a path
 * of the new, empty space on the strength of a deletion nobody asked for.
 *
 * ## What is asserted
 *
 * Three ways into the one publish, each with a wipe between the act's pending write (or the settle's read) and the
 * publish's write, and each leaving the wiped space with NO tombstone:
 *
 * - the act confirms after the wipe (`confirmFileTombstones`, the file delete, the directory delete and the move);
 * - a move's settle (`settleBegunMove`) that read its pending rows before the wipe;
 * - the TTL settle (`settleStalePendingFileTombstones`) that read its stale rows before the wipe.
 *
 * The two settles' reads are PARKED after they answered (`_read-park.mjs`) and the park is proved reached, so the wipe
 * lands between the read and the write — a wipe before the read would find nothing to re-create and pass on any code.
 *
 * The control is the half a guard that refuses everything would fail: after the wipe a NEW delete of the same path
 * publishes.
 *
 * Run: node --test testing/standalone/a-wipe-is-not-undone-by-a-publish-in-flight-db.test.js
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { openFileActDoors } from './_file-act-doors.mjs';
import { holdWhileOtherRuns, parkReadsAfterAnswer } from './_read-park.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();
const S = 'tombwipe';
const TOMBSTONES = `${S}_file_tombstones`;

let acts, tombstones, lifecycle, reads;
const raw = () => acts.raw();
const wipeFiles = () => lifecycle.wipeSpace(S, ['files']);

describe('a wipe is not undone by a publish in flight', { skip }, () => {
  before(async () => {
    acts = await openFileActDoors({ suite: 'tombwipe', space: S });
    tombstones = await import('../../server/dist/files/tombstones.js');
    lifecycle = await import('../../server/dist/spaces/lifecycle.js');
    reads = parkReadsAfterAnswer(acts.door.mongo);
  });
  after(async () => {
    reads?.restore();
    await acts?.close();
  });
  beforeEach(async () => { await acts.reset(); });

  it('the act confirms after the wipe: the wiped space has no tombstone', async () => {
    const pending = await tombstones.writePendingFileTombstones(S, ['w/a.txt']);
    assert.equal((await raw()).length, 1, 'the pending tombstone was not written — the case is not reached');
    await wipeFiles();
    assert.deepEqual(await raw(), [], 'the wipe left a tombstone — the case is not reached');

    await tombstones.confirmFileTombstones(pending);
    assert.deepEqual((await raw()).map(t => t.path), [],
      'a delete in flight when the space was wiped published its tombstone into the emptied space: a peer deletes a file of the new space on it');
    assert.deepEqual(await acts.served(), [], 'the emptied space serves a tombstone');
  });

  it('a move\'s settle that read its pending rows before the wipe writes none after it', async () => {
    const move = { from: 'w/b.txt', to: 'w/c.txt' };
    await tombstones.writePendingFileTombstones(S, [move.from], move);
    const park = reads.arm(TOMBSTONES, (f) => f['move.from'] !== undefined);
    await holdWhileOtherRuns(park, {
      first: () => tombstones.settleBegunMove(S, move.from, move.to),
      second: () => wipeFiles(),
    });
    assert.deepEqual((await raw()).map(t => t.path), [], 'the move\'s settle re-created a tombstone in a space the wipe had emptied');
  });

  it('the TTL settle that read its stale rows before the wipe writes none after it', async () => {
    await tombstones.writePendingFileTombstones(S, ['w/d.txt']);
    const park = reads.arm(TOMBSTONES, (f) => f.pending === true && f.path === undefined && f['move.from'] === undefined);
    await holdWhileOtherRuns(park, {
      first: () => tombstones.settleStalePendingFileTombstones(S, new Date(Date.now() + 24 * 3_600_000)),
      second: () => wipeFiles(),
    });
    assert.deepEqual((await raw()).map(t => t.path), [], 'the TTL settle re-created a tombstone in a space the wipe had emptied');
  });

  it('after a wipe a NEW delete of the same path still publishes (the control: a guard that refuses everything is not a guard)', async () => {
    await acts.seed('w/e.txt');
    await wipeFiles();
    await acts.seed('w/e.txt');
    const answer = await acts.del('REST', 'w/e.txt');
    assert.ok(!acts.failed(answer), `the delete: ${JSON.stringify(answer.body ?? answer.text)}`);
    assert.deepEqual((await acts.served()).map(t => t.path), ['w/e.txt'], 'a delete made after the wipe was not published');
  });
});
