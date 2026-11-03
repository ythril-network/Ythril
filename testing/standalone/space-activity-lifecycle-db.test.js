/**
 * Database-level test: a space's usage rows do not outlive the space, and they follow a rename.
 *
 * ## The finding (lens 8, Data Integrity) — self-inflicted, two hours old
 *
 * `dropSpaceData` removes every collection whose name starts with `<spaceId>_`. `space_activity` is
 * **instance-wide**, keyed `<space>:<hour>`, so the prefix drop cannot reach it. Two consequences:
 *
 *   1. deleting a space leaves its usage rows behind for up to the 90-day retention — and **a space recreated
 *      with the same id inherits them**, so a brand-new empty space's Usage panel claims hundreds of recalls
 *      it never served. That is worse than showing nothing, because it is confidently wrong;
 *   2. a rename moves the collections and leaves the activity rows under the old id, so the renamed space
 *      starts blank while orphaned rows linger under an id that no longer exists.
 *
 * The lens names this exactly: *cascade deletion of derived artifacts so nothing is orphaned*. It was worth
 * running the lens over code written the same day — the collection is new, and every existing cascade was
 * written before it existed.
 *
 * Run: `npm run test:up` first, then
 *      node --test testing/standalone/space-activity-lifecycle-db.test.js
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';
import { configureSpaces } from './_configured-spaces.mjs';

const skip = await mongoSkipReason();

const HOUR = Date.parse('2026-08-01T14:20:00.000Z');
let mongo, activity, config;
let recordSpaceCall, drainSpaceActivity, flushSpaceActivity, purgeSpaceActivity, renameSpaceActivity,
  summariseActivity, ACTIVITY_COLLECTION;

/** Give a space some usage and write it down. */
async function seed(space, calls = 3, at = HOUR) {
  for (let i = 0; i < calls; i++) recordSpaceCall(space, 'recall', { ms: 20, answered: true, topScore: 0.8 });
  await flushSpaceActivity(at);
}

describe('space activity lifecycle — against a real MongoDB', { skip }, () => {
  before(async () => {
    // The spaces `seed` records calls against: a call is counted only against a configured space (Q-606).
    config = await configureSpaces(['general', 'doomed', 'keeper', 'reused', 'old-name', 'before', 'multi', 'same', 'purged-then-called'], 'space-activity-lifecycle');
    mongo = await openTestMongo('activitylifecycle');
    ({ recordSpaceCall, drainSpaceActivity } = await import('../../server/dist/metrics/space-activity.js'));
    ({ flushSpaceActivity, purgeSpaceActivity, renameSpaceActivity, summariseActivity, ACTIVITY_COLLECTION } =
      await import('../../server/dist/metrics/space-activity-store.js'));
    activity = mongo.col(ACTIVITY_COLLECTION);
  });

  after(async () => { await closeTestMongo(); });

  beforeEach(async () => { drainSpaceActivity(); await activity.deleteMany({}); });

  it('purges a deleted space\'s rows', async () => {
    await seed('doomed', 5);
    await seed('keeper', 2);
    assert.equal(await purgeSpaceActivity('doomed'), 1);
    assert.equal(await activity.countDocuments({ space: 'doomed' }), 0);
    assert.equal(await activity.countDocuments({ space: 'keeper' }), 1, 'it must not touch other spaces');
  });

  it('a space recreated with the same id does NOT inherit the old usage', async () => {
    // The sharp edge. Without the purge, a fresh space's Usage panel is confidently wrong — worse than blank.
    await seed('reused', 400);
    await purgeSpaceActivity('reused');
    drainSpaceActivity();
    const rows = await summariseActivity(24, HOUR + 60_000);
    assert.deepEqual(rows.filter(r => r.space === 'reused'), []);
  });

  it('a call that finishes after the space was deleted leaves no row to purge later (Q-606)', async () => {
    // The delete purged the rows; a response still in flight then reports its call. The counts are pending when the delete lands, so the
    // flush must not write them back under the id of a space that no longer exists - and a space recreated with that id inherits nothing.
    recordSpaceCall('purged-then-called', 'recall', { ms: 20, answered: true, topScore: 0.8 });
    config.removeSpace('purged-then-called');
    try {
      await flushSpaceActivity(HOUR);
      assert.equal(await activity.countDocuments({ space: 'purged-then-called' }), 0, 'the usage of a deleted space was written after its purge');
    } finally { config.addSpace('purged-then-called'); }
  });

  it('purging a space with no rows is a no-op, not an error', async () => {
    assert.equal(await purgeSpaceActivity('never-used'), 0);
  });

  it('carries usage across a rename, under the new id', async () => {
    // A rename preserves the space and its data, so losing its history would make every rename look like a
    // space that had never been used.
    await seed('old-name', 7);
    assert.equal(await renameSpaceActivity('old-name', 'new-name'), 1);

    assert.equal(await activity.countDocuments({ space: 'old-name' }), 0, 'no orphan under the old id');
    const moved = await activity.findOne({ space: 'new-name' });
    assert.ok(moved, 'the row must exist under the new id');
    assert.equal(moved._id, 'new-name:2026-08-01T14', 'the bucket key embeds the id, so it must be re-keyed');
    assert.equal(moved.calls.recall.n, 7, 'and the counts must survive the move');
  });

  it('a renamed space reads its own history back', async () => {
    await seed('before', 4);
    await renameSpaceActivity('before', 'after');
    drainSpaceActivity();
    const rows = await summariseActivity(24, HOUR + 60_000);
    assert.deepEqual(rows.map(r => r.space), ['after']);
    assert.equal(rows[0].recall, 4);
  });

  it('moves every bucket, not just the newest', async () => {
    await seed('multi', 2, HOUR);
    await seed('multi', 3, HOUR + 3_600_000);
    assert.equal(await renameSpaceActivity('multi', 'moved'), 2);
    assert.equal(await activity.countDocuments({ space: 'moved' }), 2);
  });

  it('renaming to the same id is a no-op', async () => {
    await seed('same', 2);
    assert.equal(await renameSpaceActivity('same', 'same'), 0);
    assert.equal(await activity.countDocuments({ space: 'same' }), 1);
  });

  describe('the lifecycle paths are wired to them', () => {
    // The suite above proves the operations work; these prove something calls them. Without that, the finding
    // is still live and every test here passes.
    it('dropSpaceData purges activity', () => {
      const src = readFileSync('server/src/spaces/lifecycle.ts', 'utf8');
      assert.match(src, /purgeSpaceActivity\(spaceId\)/,
        'deleting a space would leave its usage rows for a recreated space to inherit');
    });

    it('moveSpaceData carries activity across', () => {
      const src = readFileSync('server/src/spaces/rename.ts', 'utf8');
      assert.match(src, /renameSpaceActivity\(oldId, newId\)/,
        'a renamed space would start blank while orphans linger under the old id');
    });
  });
});
