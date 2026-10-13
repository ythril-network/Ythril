/**
 * The settle's clearing of finished move markers is a walk with its guard: it resumes where it stopped, and says a move it could not
 * look at (bundle-44, S12).
 *
 * ## The defect
 *
 * `clearFinishedMoveMarkers` read the first `FILE_TOMBSTONE_SETTLE_BATCH` moves from the head on every sweep, so a move it could not
 * clear held the head of the window for ever, and swallowed each move's error in a bare `catch`, so a marker that was never cleared
 * left no line anywhere. Housekeeping's finishing of the owed moves (`files/finish-owed-moves.ts`) had both guards.
 *
 * ## What is asserted
 *
 * - The pager both passes share (`createMoveMarkerPager`) resumes after the last move it returned, wraps to the head once a call
 *   reached the end, and returns a move once per round.
 * - A move the clearing cannot look at (its destination leaves the space) is reported through the walk's reporter, named by its
 *   paths, and the move after it is still cleared.
 *
 * Run: node --test testing/standalone/clearing-finished-move-markers-is-a-guarded-walk-db.test.js   (after `npm run build:server`)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { openFileActDoors } from './_file-act-doors.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();
const S = 'clearmarkers';
const DAY = 24 * 3_600_000;
const OLD = '2026-01-01T00:00:00.000Z';

let acts, tombstones, walk;

const markers = () => acts.door.coll(S, 'file_tombstones');
const marker = (id, from, to) => ({ _id: id, spaceId: S, path: from, deletedAt: OLD, move: { from, to } });
const begun = (from, to) => tombstones.moveMarkerOf(S, from, to).then(m => m !== undefined);

describe('clearing the markers of finished moves is a guarded walk', { skip }, () => {
  before(async () => {
    acts = await openFileActDoors({ suite: 'clearmarkers', space: S });
    tombstones = await import('../../server/dist/files/tombstones.js');
    walk = await import('../../server/dist/util/housekeeping-walk.js');
  });
  after(async () => { await acts?.close(); });
  beforeEach(async () => { await acts.reset(); });

  it('a pager resumes after the last move it returned, and starts at the head once a call reached the end', async () => {
    await markers().insertMany(['a', 'b', 'c', 'd', 'e'].map(n => marker(`m-${n}`, `${n}.txt`, `${n}-to.txt`)));
    const next = tombstones.createMoveMarkerPager();
    const page = async () => (await next(S, '2026-06-01T00:00:00.000Z', 2));
    const first = await page();
    const second = await page();
    const third = await page();
    const fourth = await page();
    assert.deepEqual([first, second, third, fourth].map(p => p.markers.map(m => m.from)),
      [['a.txt', 'b.txt'], ['c.txt', 'd.txt'], ['e.txt'], ['a.txt', 'b.txt']], 'the pages do not walk the moves in order, once each, and wrap');
    assert.deepEqual([first, second, third, fourth].map(p => p.reachedTheEnd), [false, false, true, false]);
  });

  it('a move the clearing cannot look at is reported with its paths, and the move after it is still cleared', async () => {
    // `a-bad`: its destination leaves the space, so the question "are its bytes there" is refused. `b`: finished (bytes at `to`, none at `from`).
    await acts.seed('b-to.txt');
    await markers().insertMany([marker('m-a', 'a-bad.txt', '../outside.txt'), marker('m-b', 'b.txt', 'b-to.txt')]);
    const said = [];
    const reporter = {
      spaceFailure: (step, spaceId, err, opts) => said.push({ step, spaceId, unit: opts?.unit, message: String(err?.message ?? err) }),
      recovered() {}, storeDown() {}, storeStalled() {},
    };
    const runner = walk.createHousekeepingWalk({ storeAnswers: async () => true, reporter });
    const result = await runner.eachSpace('TTL sweep: settling file tombstones', [{ id: S }], async () => {
      await tombstones.settleStalePendingFileTombstones(S, new Date(Date.now() + DAY));
    });

    assert.equal(await begun('b.txt', 'b-to.txt'), false, 'the finished move after the one that failed was not cleared');
    assert.equal(await begun('a-bad.txt', '../outside.txt'), true, 'the marker of a move that could not be looked at was dropped');
    assert.equal(said.length, 1, `the failure was not said once through the reporter: ${JSON.stringify(said)}`);
    assert.equal(said[0].unit, 'a-bad.txt → ../outside.txt');
    assert.equal(result.failed.length, 1, 'the walk was not told which unit failed');
  });
});
