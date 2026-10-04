/**
 * Per path, an act publishes exactly ONE file tombstone, and publishing it removes every other pending tombstone for
 * that path — the earlier attempts of the same act never happened as acts of their own (bundle-30 I17,
 * verify-drive-5 F1).
 *
 * ## The defect
 *
 * A file act that a store failure stops leaves its pending tombstone behind: the write landed, and the act's own
 * clean-up could not reach the store either. Its retry then writes a pending tombstone of its own and publishes it.
 * The first attempt's was published as well, as a SECOND tombstone for the same path:
 *
 * - **a retried move** at once — `settleBegunMove` settles every pending tombstone carrying the move's marker, and the
 *   first attempt's carries the same marker (two published, ~4 ms apart, in the drive);
 * - **a retried delete** (one file, MCP `delete_file`, a directory) ten minutes later — the TTL settle found the path's
 *   bytes gone, which the retry had done, and published the leftover stamped then.
 *
 * A duplicate is not harmless: a receiver deletes its copy for every tombstone it is sent, with no time comparison
 * (`api/sync/tombstones.ts`), so a late one deletes a re-upload a peer made of that path in between. 16 of 30 paths in
 * the drive ended with two.
 *
 * ## What is asserted
 *
 * "Published" is what a peer can learn: the `GET /api/sync/file-tombstones` door and the push a sync cycle makes
 * (`_file-act-doors.mjs`). Every case ends past the TTL settle's staleness window, because the second tombstone of a
 * delete appears only once the settle has run (verify-drive-5 observation 1).
 *
 * - A move, a file delete and a directory delete, each stopped by a store failure whose pending write landed and whose
 *   clean-up never ran, then retried: exactly one published tombstone per path, on both doors where both exist, and
 *   nothing left pending for it once the retry has published.
 * - A failed attempt's pending write that lands only AFTER the retry has published (a paused store applying what it
 *   had buffered): the settle finds a published tombstone for that path newer than the leftover, and drops the
 *   leftover rather than publish a second.
 * - The plain success cases stay one per path (guards: green before the fix).
 *
 * Run: node --test testing/standalone/an-act-publishes-one-tombstone-per-path-db.test.js
 */
import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openFileActDoors } from './_file-act-doors.mjs';
import { driverWriteFailures, eventually, failWrites } from './_write-faults.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();
const S = 'onepath';

let acts, tombstones, F, faults;

const TOMBSTONES = `${S}_file_tombstones`;
/** Past the TTL settle's staleness window, so every leftover is settled. */
const PAST_THE_WINDOW = () => new Date(Date.now() + 24 * 3_600_000);
const settle = () => tombstones.settleStalePendingFileTombstones(S, PAST_THE_WINDOW());
const dropsSettled = () => tombstones.whenPendingFileTombstoneDropsSettle();
const pendingFor = async (p) => (await acts.raw()).filter(t => t.pending && t.path === p);

/**
 * The first attempt is stopped by a store failure on its pending write, the write LANDED, and the act's own clean-up
 * never reaches the store — what a paused store leaves behind (verify-drive-5 §1, "tombstone pending").
 */
function stopTheFirstAttempt() {
  faults.fail('insertMany', TOMBSTONES, F.storeGone.bulk, { land: true });
  faults.fail('deleteMany', TOMBSTONES, F.storeGone.single, { times: Infinity });
}

/** Each path's published tombstones, counted on both ways a peer learns of them. */
async function publishedCounts() {
  const count = (list) => list.reduce((m, t) => ({ ...m, [t.path]: (m[t.path] ?? 0) + 1 }), {});
  return { served: count(await acts.served()), pushed: count(await acts.pushed()) };
}
const onceEach = (paths) => {
  const one = Object.fromEntries(paths.map(p => [p, 1]));
  return { served: one, pushed: one };
};

describe('an act publishes one tombstone per path', { skip }, () => {
  before(async () => {
    acts = await openFileActDoors({ suite: 'onepath', space: S });
    F = await driverWriteFailures('ythril_harness_onepath');
    tombstones = await import('../../server/dist/files/tombstones.js');
    faults = failWrites(Object.getPrototypeOf(acts.door.mongo.col('probe')), ['insertMany', 'deleteMany']);
  });
  after(async () => {
    faults?.restore();
    await acts?.close();
  });
  beforeEach(async () => {
    faults.clear();
    await acts.reset();
  });
  afterEach(() => { faults.clear(); });

  for (const via of ['REST', 'MCP']) {
    it(`${via}: a move a store failure stopped, then retried, publishes one tombstone for its source`, async () => {
      await acts.seed('mv.txt');
      stopTheFirstAttempt();
      const first = await acts.move(via, 'mv.txt', 'mv-new.txt');
      assert.equal(acts.statusOf(first), 503, `the first attempt: ${JSON.stringify(first.body ?? first.text)}`);
      await dropsSettled();
      faults.clear();
      assert.equal((await pendingFor('mv.txt')).length, 1, 'the first attempt left no pending tombstone — not the case the drive saw');

      const retry = await acts.move(via, 'mv.txt', 'mv-new.txt');
      assert.ok(!acts.failed(retry), `the retry: ${JSON.stringify(retry.body ?? retry.text)}`);
      assert.ok(!acts.onDisk('mv.txt') && acts.onDisk('mv-new.txt'), 'the retry did not move the file');
      assert.deepEqual(await pendingFor('mv.txt'), [],
        'publishing the retry\'s tombstone left the first attempt\'s pending — the same intent, waiting to be published again');
      await settle();
      assert.deepEqual(await publishedCounts(), onceEach(['mv.txt']),
        'a retried move published a second tombstone for its source: a peer deletes a re-upload of that path on the late one');
    });

    it(`${via}: a delete a store failure stopped, then retried, publishes one tombstone — also once the TTL settle has run`, async () => {
      await acts.seed('del.txt');
      stopTheFirstAttempt();
      const first = await acts.del(via, 'del.txt');
      assert.equal(acts.statusOf(first), 503, `the first attempt: ${JSON.stringify(first.body ?? first.text)}`);
      await dropsSettled();
      faults.clear();
      assert.equal((await pendingFor('del.txt')).length, 1, 'the first attempt left no pending tombstone — not the case the drive saw');

      const retry = await acts.del(via, 'del.txt');
      assert.ok(!acts.failed(retry), `the retry: ${JSON.stringify(retry.body ?? retry.text)}`);
      assert.ok(!acts.onDisk('del.txt'), 'the retry did not delete the file');
      assert.deepEqual(await pendingFor('del.txt'), [],
        'publishing the retry\'s tombstone left the first attempt\'s pending, for the TTL settle to publish as a second');
      await settle();
      assert.deepEqual(await publishedCounts(), onceEach(['del.txt']),
        'the TTL settle published the failed attempt\'s leftover as a second tombstone for a path deleted once');
    });
  }

  it('a directory delete a store failure stopped, then retried, publishes one tombstone per file', async () => {
    const tree = ['dir/a.txt', 'dir/b.txt'];
    for (const p of tree) await acts.seed(p);
    stopTheFirstAttempt();
    const first = await acts.rest('DELETE', { path: 'dir' }, { confirm: true });
    assert.equal(first.code, 503, `the first attempt: ${JSON.stringify(first.body)}`);
    await dropsSettled();
    faults.clear();
    for (const p of tree) assert.equal((await pendingFor(p)).length, 1, `the first attempt left no pending tombstone for ${p}`);

    const retry = await acts.rest('DELETE', { path: 'dir' }, { confirm: true });
    assert.ok(!acts.failed(retry), `the retry: ${JSON.stringify(retry.body)}`);
    for (const p of tree) assert.ok(!acts.onDisk(p), `the retry did not delete ${p}`);
    for (const p of tree) assert.deepEqual(await pendingFor(p), [], `the first attempt's tombstone for ${p} was left pending`);
    await settle();
    assert.deepEqual(await publishedCounts(), onceEach(tree), 'a retried directory delete published a path twice');
  });

  for (const act of ['move', 'delete']) {
    it(`a ${act}'s failed write that lands only after its retry published is dropped by the settle, not published`, async () => {
      await acts.seed('late.txt');
      // A paused store applies the buffered write once it comes back — here, after the retry is done.
      faults.fail('insertMany', TOMBSTONES, F.storeGone.bulk, { lateMs: 1_500 });
      const run = () => (act === 'move' ? acts.move('REST', 'late.txt', 'late-new.txt') : acts.del('REST', 'late.txt'));
      assert.equal(acts.statusOf(await run()), 503, 'the first attempt did not fail');
      await dropsSettled();
      faults.clear();
      const retry = await run();
      assert.ok(!acts.failed(retry), `the retry: ${JSON.stringify(retry.body)}`);
      assert.deepEqual(await pendingFor('late.txt'), [], 'the late write landed before the retry published — the case is not reached');
      assert.ok(await eventually(async () => (await pendingFor('late.txt')).length === 1, 10_000, 50),
        'the first attempt\'s write never landed — the case is not reached');
      await settle();
      assert.deepEqual(await publishedCounts(), onceEach(['late.txt']),
        'a leftover older than the path\'s published tombstone was published as a second one');
      assert.deepEqual(await pendingFor('late.txt'), [], 'the leftover was kept pending instead of being dropped');
    });
  }

  for (const via of ['REST', 'MCP']) {
    it(`${via}: a delete and a move that succeed at once publish one tombstone per path (guard)`, async () => {
      await acts.seed('gone.txt');
      await acts.seed('from.txt');
      assert.ok(!acts.failed(await acts.del(via, 'gone.txt')));
      assert.ok(!acts.failed(await acts.move(via, 'from.txt', 'to.txt')));
      await settle();
      assert.deepEqual(await publishedCounts(), onceEach(['from.txt', 'gone.txt']));
    });
  }

  it('a directory delete that succeeds at once publishes one tombstone per file (guard)', async () => {
    const tree = ['ok/a.txt', 'ok/b.txt'];
    for (const p of tree) await acts.seed(p);
    assert.ok(!acts.failed(await acts.rest('DELETE', { path: 'ok' }, { confirm: true })));
    await settle();
    assert.deepEqual(await publishedCounts(), onceEach(tree));
  });
});
