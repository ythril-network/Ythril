/**
 * One tombstone per path: only this instance's OWN publications decide, by this instance's own order, and the publishers
 * of one path cannot interleave into two (bundle-71, Q-352, plan rev 3.1).
 *
 * ## The defect
 *
 * `publishOnePerPath` (`files/tombstones.ts`) is the one way a file tombstone is published, and its rule — one per path, a
 * leftover older than a publication is dropped — was written for ONE publisher reading and then writing. It can publish
 * what it should not, or fail to publish what it should, in these ways:
 *
 * - **Two publishers, one stale read.** The act's confirm and the TTL settle both reach a path; each reads the path's rows,
 *   then writes. A publisher whose read is behind a publication made since upserts its winner AGAIN — the upsert exists
 *   to re-create a row the stale settle dropped — so the path ends with two published tombstones, and the older delete is
 *   stamped AFTER the newer one (a receiver applies them in that order).
 * - **The settle's bump moves the clock the rule reads.** A row the settle could not look at has its `deletedAt` set to the
 *   settle's `now`, which puts a leftover ABOVE the tombstone that already covers its path; when the path can be looked at
 *   it is published as a second one.
 * - **A relayed tombstone suppresses an own one.** The rule compares with the newest published POSITION for the path, and a
 *   relayed tombstone's position is its receive time: a peer's tombstone for a path suppresses this instance's own delete
 *   of it, which is then never told to anybody.
 * - **A move's marker goes with a row that is dropped or pruned.** `moveWasBegun` is the only thing that tells a retried
 *   move it is owed; removed as "another pending tombstone" or pruned as delivered, a move the store stopped is not
 *   completed, and the unfinished one is taken for an orphan beside an unrelated destination.
 * - **The prune takes a published tombstone out from under a late leftover.** The leftover is then published (a path the
 *   prune just freed has nothing to cover it) as a second tombstone, below a position every peer acknowledged.
 *
 * ## What is asserted — the rule, never one implementation of it
 *
 * Each case states the OUTCOME a correct publisher must reach whichever way it orders the two (a lock that makes the second
 * wait is as right as one that lets it through), so `holdWhileOtherRuns` never awaits the second runner past a window.
 *
 * - (a) delete, re-upload, delete, the first publish's READ parked after the second's: no published tombstone of a LOWER
 *   version is stamped after one of a higher version, and the later delete's is published.
 * - (b) a published tombstone beside a late pending leftover: the prune keeps the published one while the leftover is pending.
 * - (c) a leftover the settle could not look at stays below the tombstone that covers its path: one published, never two.
 * - (d) a move's marker survives the row that carried it being superseded; a published row that carries one is not pruned
 *   while younger than a day, and one older is.
 * - (e) a relayed tombstone of another issuer, with and without a `rowSeq`, never stops an own pending one publishing.
 * - (f) two publishers on one path (the act's confirm and the settle) publish ONE tombstone.
 * - (g) a path whose candidates are more than one slice of the publish still publishes one.
 *
 * Each park is PROVED reached (`holdWhileOtherRuns`), and a lateness is proved by the row landing.
 *
 * Run: node --test testing/standalone/a-path-has-one-own-published-tombstone-however-its-publishers-interleave-db.test.js
 */
import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import fs from 'node:fs';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { openFileActDoors } from './_file-act-doors.mjs';
import { driverWriteFailures, eventually, failWrites } from './_write-faults.mjs';
import { holdWhileOtherRuns, parkReadsAfterAnswer } from './_read-park.mjs';
import { sleep } from '../_shared/sleep.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();
const S = 'tombrace';
const TOMBSTONES = `${S}_file_tombstones`;
const DAY = 24 * 3_600_000;
const FAR = '9999-12-31T23:59:59.999Z';

let acts, tombstones, F, faults, reads;
const realLstat = fsp.lstat;
let lstatRefusesLocked = false;
const LOCKED = `${path.sep}locked${path.sep}`;

const raw = () => acts.raw();
const publishedFor = async (p) => (await raw()).filter(t => !t.pending && t.path === p);
const pendingFor = async (p) => (await raw()).filter(t => t.pending && t.path === p);
const positionOf = (t) => t.positionAt ?? t.deletedAt;
/** The tombstone rows a path ends with, as `{ id, rowSeq, position }`, oldest position first. */
const endState = async (p) => (await publishedFor(p)).map(t => ({ id: t._id, rowSeq: t.rowSeq, position: positionOf(t) })).sort((a, b) => a.position.localeCompare(b.position));
/** Drop the file bytes of `p` the way an act's unlink does (the row, when there is one, stays: it is the act's to remove). */
const unlink = (p) => fs.rmSync(path.join(acts.root(), p), { force: true });
/** Past the TTL settle's staleness window, so every leftover is settled. */
const PAST = (days = 1) => new Date(Date.now() + days * DAY);

describe('a path ends with one own published tombstone, however its publishers interleave', { skip }, () => {
  before(async () => {
    acts = await openFileActDoors({ suite: 'tombrace', space: S });
    F = await driverWriteFailures('ythril_harness_tombrace');
    tombstones = await import('../../server/dist/files/tombstones.js');
    faults = failWrites(Object.getPrototypeOf(acts.door.mongo.col('probe')), ['insertMany', 'deleteMany']);
    reads = parkReadsAfterAnswer(acts.door.mongo);
    fsp.lstat = function (p, ...rest) {
      if (lstatRefusesLocked && String(p).includes(LOCKED)) {
        return Promise.reject(Object.assign(new Error(`EACCES: permission denied, lstat '${p}'`), { code: 'EACCES', syscall: 'lstat' }));
      }
      return realLstat.call(fsp, p, ...rest);
    };
  });
  after(async () => {
    fsp.lstat = realLstat;
    reads?.restore();
    faults?.restore();
    await acts?.close();
  });
  beforeEach(async () => {
    faults.clear();
    lstatRefusesLocked = false;
    await acts.reset();
  });
  afterEach(() => { faults.clear(); lstatRefusesLocked = false; });

  // ── (a) ────────────────────────────────────────────────────────────────────────────────────────────────────────────

  it('(a) delete, re-upload, delete — the first publish held after its read — never leaves the older delete stamped after the newer', async () => {
    await acts.seed('re.txt', { seq: 5 });
    const first = await tombstones.writePendingFileTombstones(S, ['re.txt']);
    assert.equal(first.docs[0]?.rowSeq, 5, 'the first delete did not read the version it erases — the case is not the one the race is about');
    unlink('re.txt');

    const park = reads.arm(TOMBSTONES, (f) => f.path?.$in !== undefined);
    await holdWhileOtherRuns(park, {
      first: () => tombstones.confirmFileTombstones(first),
      second: async () => {
        // The path is uploaded again — a newer version of it — and deleted again, while the first publish waits.
        await acts.door.coll(S, 'files').updateOne({ _id: 're.txt' }, { $set: { seq: 9 } });
        await acts.files.writeFile(S, 're.txt', 'uploaded again');
        await sleep(5);
        const later = await tombstones.writePendingFileTombstones(S, ['re.txt']);
        assert.equal(later.docs[0]?.rowSeq, 9, 'the second delete did not read the newer version');
        unlink('re.txt');
        await tombstones.confirmFileTombstones(later);
      },
    });

    const rows = await endState('re.txt');
    assert.ok(rows.some(r => r.rowSeq === 9), `the later delete was never published: ${JSON.stringify(rows)}`);
    for (const older of rows.filter(r => r.rowSeq === 5)) {
      for (const newer of rows.filter(r => r.rowSeq === 9)) {
        assert.ok(older.position < newer.position,
          `the delete of version 5 is stamped at ${older.position}, AFTER the delete of version 9 at ${newer.position}: a receiver applies the older delete last`);
      }
    }
    assert.deepEqual(await pendingFor('re.txt'), [], 'a pending tombstone was left for a path that is published');
  });

  // ── (b) ────────────────────────────────────────────────────────────────────────────────────────────────────────────

  it('(b) the prune keeps a published tombstone while a pending leftover for its path exists, and takes it once there is none', async () => {
    await acts.seed('keep.txt');
    assert.ok(!acts.failed(await acts.del('REST', 'keep.txt')), 'the delete did not happen');
    const [published] = await publishedFor('keep.txt');
    assert.ok(published, 'the delete published nothing');
    await sleep(5);
    // A leftover the published tombstone does not cover yet: a failed attempt's write that landed after it.
    const leftover = await tombstones.writePendingFileTombstones(S, ['keep.txt']);
    assert.equal((await pendingFor('keep.txt')).length, 1, 'the leftover was not written — the case is not reached');

    await tombstones.pruneFileTombstonesUpTo(S, FAR);
    assert.ok((await publishedFor('keep.txt')).some(t => t._id === published._id),
      'the prune took the published tombstone while a pending one waited for its path: the leftover is then published as the path\'s only tombstone, below every position a peer acknowledged');

    tombstones.dropPendingFileTombstones(leftover);
    await tombstones.whenPendingFileTombstoneDropsSettle();
    assert.deepEqual(await pendingFor('keep.txt'), [], 'the leftover was not dropped — the control below says nothing');
    await tombstones.pruneFileTombstonesUpTo(S, FAR);
    assert.deepEqual(await publishedFor('keep.txt'), [], 'with nothing pending the prune must still take a delivered tombstone (a guard that keeps everything is not a prune)');
  });

  // ── (c) ────────────────────────────────────────────────────────────────────────────────────────────────────────────

  it('(c) a leftover the settle could not look at stays below the tombstone that covers its path: one is published, never two', async () => {
    await acts.seed('locked/a.txt');
    // The first attempt's pending write lands only after the retry has published: a leftover OLDER than the publication.
    faults.fail('insertMany', TOMBSTONES, F.storeGone.bulk, { lateMs: 1_500 });
    assert.equal(acts.statusOf(await acts.del('REST', 'locked/a.txt')), 503, 'the first attempt did not fail');
    await tombstones.whenPendingFileTombstoneDropsSettle();
    faults.clear();
    const retry = await acts.del('REST', 'locked/a.txt');
    assert.ok(!acts.failed(retry), `the retry: ${JSON.stringify(retry.body ?? retry.text)}`);
    assert.equal((await publishedFor('locked/a.txt')).length, 1, 'the retry did not publish');
    assert.ok(await eventually(async () => (await pendingFor('locked/a.txt')).length === 1, 10_000, 50),
      'the first attempt\'s write never landed — the case is not reached');

    // The settle cannot look at the path: the leftover is neither dropped nor published, and is asked again later.
    lstatRefusesLocked = true;
    const looked = await tombstones.settleStalePendingFileTombstones(S, PAST(1));
    lstatRefusesLocked = false;
    assert.equal(looked.confirmed, 0, 'the settle published a path it could not look at');
    // Later it can. Whatever the first pass did to the leftover's clock, it must still be below the published tombstone.
    await tombstones.settleStalePendingFileTombstones(S, PAST(2));
    const rows = await publishedFor('locked/a.txt');
    assert.equal(rows.length, 1, `a path deleted once has ${rows.length} published tombstones: the settle's retry stamp lifted the leftover above the tombstone that covers it`);
    assert.deepEqual(await pendingFor('locked/a.txt'), [], 'the leftover is still pending: nothing will ever settle it');
  });

  // ── (d) ────────────────────────────────────────────────────────────────────────────────────────────────────────────

  it('(d) a move\'s marker survives the row that carried it being superseded', async () => {
    const move = { from: 'mv/from.txt', to: 'mv/to.txt' };
    await tombstones.writePendingFileTombstones(S, ['mv/from.txt'], move);
    assert.equal(await tombstones.moveWasBegun(S, move.from, move.to), true, 'the move\'s marker was not written — the case is not reached');
    await sleep(5);
    // Another act on the source path (no marker of its own) publishes: the move's row is "another pending tombstone" of the path.
    const covering = await tombstones.writePendingFileTombstones(S, ['mv/from.txt']);
    await tombstones.confirmFileTombstones(covering);
    assert.equal((await publishedFor('mv/from.txt')).length, 1, 'the covering act did not publish — the case is not reached');
    assert.equal(await tombstones.moveWasBegun(S, move.from, move.to), true,
      'the move row was removed with its marker: a retry cannot tell the move it began from an orphan beside an unrelated destination');
  });

  it('(d) a published row that carries a move marker is not pruned while it is younger than a day; one older is, and so is one whose move finished', async () => {
    const young = { from: 'mk/young.txt', to: 'mk/young-to.txt' };
    const old = { from: 'mk/old.txt', to: 'mk/old-to.txt' };
    for (const m of [young, old]) await tombstones.confirmFileTombstones(await tombstones.writePendingFileTombstones(S, [m.from], m));
    const longAgo = new Date(Date.now() - 3 * DAY).toISOString();
    // The age of a row, whichever of its stamps the code reads it by.
    await acts.door.coll(S, 'file_tombstones').updateMany({ path: old.from },
      { $set: { deletedAt: longAgo, positionAt: longAgo, writtenAt: longAgo, settleAt: longAgo } });
    await sleep(5);

    await tombstones.pruneFileTombstonesUpTo(S, FAR);
    assert.equal((await publishedFor(young.from)).length, 1, 'the prune took the tombstone of a move begun moments ago: its marker is the only record that the move is owed');
    assert.deepEqual(await publishedFor(old.from), [], 'a marker older than a day kept its row for ever: no row is unprunable');

    await tombstones.forgetFinishedMove(S, young.from, young.to);
    await tombstones.pruneFileTombstonesUpTo(S, FAR);
    assert.deepEqual(await publishedFor(young.from), [], 'a finished move\'s row is still kept: the marker was not cleared where it is');
  });

  // ── (e) ────────────────────────────────────────────────────────────────────────────────────────────────────────────

  for (const [what, extra] of [['with a rowSeq', { rowSeq: 1_000 }], ['without a rowSeq', {}]]) {
    it(`(e) a relayed tombstone of another issuer, ${what}, never stops an own pending one publishing`, async () => {
      await acts.seed('rel.txt', { seq: 4 });
      const own = await tombstones.writePendingFileTombstones(S, ['rel.txt']);
      unlink('rel.txt');
      await sleep(5);
      // A peer's tombstone for the same path arrives (its position is the RECEIVE time, later than the own act was written).
      await tombstones.storeRelayedFileTombstones(S, [{ _id: `relayed-${extra.rowSeq ?? 'bare'}`, path: 'rel.txt',
        deletedAt: '2026-09-01T00:00:00.000Z', issuer: 'some-other-instance', ...extra }]);
      assert.equal((await publishedFor('rel.txt')).length, 1, 'the relayed tombstone was not stored — the case is not reached');
      await tombstones.confirmFileTombstones(own);
      const ownPublished = (await publishedFor('rel.txt')).filter(t => t._id === own.docs[0]._id);
      assert.equal(ownPublished.length, 1, 'this instance\'s own delete was dropped as "covered" by a tombstone another instance issued: nobody is ever told of it');
      assert.ok((await acts.served()).some(t => t._id === own.docs[0]._id), 'the own tombstone is stored but not served');
    });
  }

  // ── (f) ────────────────────────────────────────────────────────────────────────────────────────────────────────────

  it('(f) the act\'s confirm and the TTL settle publishing one path publish ONE tombstone', async () => {
    // Two pending tombstones for one path: an earlier attempt's (stale) and the retry's (fresh). Nothing holds bytes there.
    const attempt = await tombstones.writePendingFileTombstones(S, ['two.txt']);
    await sleep(60);
    const retry = await tombstones.writePendingFileTombstones(S, ['two.txt']);
    assert.equal((await pendingFor('two.txt')).length, 2, 'the two attempts were not both written — the case is not reached');
    // A settle that finds only the earlier one stale.
    const staleOnly = new Date(Date.parse(attempt.docs[0].deletedAt) + 10 * 60_000 + 30);

    const park = reads.arm(TOMBSTONES, (f) => f.path?.$in !== undefined);
    await holdWhileOtherRuns(park, {
      first: () => tombstones.confirmFileTombstones(retry),
      second: () => tombstones.settleStalePendingFileTombstones(S, staleOnly),
    });

    const rows = await endState('two.txt');
    assert.equal(rows.length, 1, `two publishers each published a tombstone for a path deleted once: ${JSON.stringify(rows)}`);
    assert.deepEqual(await pendingFor('two.txt'), [], 'a pending tombstone was left behind for a published path');
  });

  // ── (g) ────────────────────────────────────────────────────────────────────────────────────────────────────────────

  it('(g) a path with more candidates than one slice of the publish still publishes one (a guard: red only on a slicer that splits a path)', async () => {
    const many = tombstones.FILE_TOMBSTONE_PAGE + 5;
    assert.equal(typeof tombstones.FILE_TOMBSTONE_PAGE, 'number', 'the publish\'s slice is not exported to size this case by');
    const docs = [];
    for (let i = 0; i < many; i++) docs.push(...(await tombstones.writePendingFileTombstones(S, ['crowd.txt'])).docs);
    assert.equal((await pendingFor('crowd.txt')).length, many, 'the candidates were not all written — the case is not reached');
    // A second path after them: the slice boundary falls inside the first path unless candidates are grouped BY PATH.
    const other = await tombstones.writePendingFileTombstones(S, ['crowd-b.txt']);

    await tombstones.confirmFileTombstones({ spaceId: S, docs: [...docs, ...other.docs] });
    assert.equal((await publishedFor('crowd.txt')).length, 1, 'a path whose candidates straddle two slices published once per slice');
    assert.equal((await publishedFor('crowd-b.txt')).length, 1, 'the path after the crowd was not published');
    assert.deepEqual(await pendingFor('crowd.txt'), [], 'a candidate of the crowd was left pending');
  });
});
