/**
 * A revive that failed for one space at boot is retried by the worker's stall tick, for that space only, until it succeeds
 * (`Q-274`, `S-R3`, `OB-9`, bundle-53 G14).
 *
 * ## The defect
 *
 * The boot revive of `failed` embed jobs (one clean attempt per server version) was a fire-and-forget `void` whose failure was a
 * warn line: a space whose revive threw at boot was never revived on that version, because the revive keys on the version and
 * nothing asked again. And its INFO line counted the jobs it revived, which reads complete when a space was skipped.
 *
 * ## What is pinned, against a real MongoDB
 *
 * Space 1's embed-job collection is a VIEW at boot (every write to it fails), space 2's is ordinary. Then:
 *  - the boot sweeps revive space 2 and say so in an INFO line that names how many spaces it reached: "in 1 of 2 spaces";
 *  - the worker's tick, while the view is still there, retries space 1 and fails again, and is not blamed on space 2;
 *  - the first tick after the view is gone revives space 1 - and ONLY space 1: a new failed job in space 2 stays failed, because
 *    space 2 is not owed a revive;
 *  - once it has succeeded the retry ends: a new failed job in space 1 stays failed too (the revive is once per version).
 *
 * Run: a Mongo the harness accepts, then node --test testing/standalone/a-failed-revive-is-retried-by-the-workers-tick-db.test.js
 * (requires a prior `npm run build:server`)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';
import { withCollectionAsView } from './_write-faults.mjs';
import { logLinesDuring } from './_log-lines.mjs';

const skip = await mongoSkipReason();

const S1 = 'revive-view';
const S2 = 'revive-plain';
const OLD = '2026-08-15T00:00:00.000Z';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-revive-tick-'));
const CONFIG_PATH = path.join(tmpDir, 'config.json');
process.env['CONFIG_PATH'] = CONFIG_PATH;

let mongo; let worker; let version;
const jobs = (s) => mongo.col(`${s}_embed_jobs`);
const failedJob = (space, id) => ({
  _id: `fact:${id}`, spaceId: space, recordType: 'fact', recordId: id, status: 'failed', priority: 0,
  attempts: 5, transientFailures: 0, lostChildFailures: 0, maxAttempts: 5, lastError: 'embedder unreachable',
  claimedAt: null, progressAt: null, claimableAfter: null, claimToken: null, createdAt: OLD, updatedAt: OLD,
});
const statusOf = async (space, id) => (await jobs(space).findOne({ _id: `fact:${id}` }))?.status;

describe('a failed boot revive is retried by the worker\'s tick (real MongoDB)', { skip }, () => {
  before(async () => {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(
      { spaces: [{ id: S1, label: 'View' }, { id: S2, label: 'Plain' }], networks: [], tokens: [] }, null, 2));
    mongo = await openTestMongo('revivetick');
    (await import('../../server/dist/config/loader.js')).loadConfig();
    worker = await import('../../server/dist/brain/embed-worker.js');
    ({ SERVER_VERSION: version } = await import('../../server/dist/util/server-version.js'));
  });

  after(async () => {
    await closeTestMongo();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it('boot says "in 1 of 2 spaces"; the tick retries space 1 only, until it succeeds, and then stops', async () => {
    await jobs(S2).insertOne(failedJob(S2, 'first'));

    await withCollectionAsView(mongo.getDb(), `${S1}_embed_jobs`, `${S1}_view_source`, async () => {
      const boot = await logLinesDuring(() => worker.runEmbedBootSweeps());
      assert.ok(boot.lines.some((l) => /re-queued 1 job\(s\).* in 1 of 2 spaces/.test(l)),
        `the INFO line must say how many spaces it reached:\n${boot.lines.join('\n')}`);
      assert.equal(await statusOf(S2, 'first'), 'pending', 'the space that could be revived was');

      // Space 2 gets a NEW failed job: it is not owed a revive, so no tick may touch it.
      await jobs(S2).insertOne(failedJob(S2, 'second'));
      await logLinesDuring(() => worker.runEmbedStallTick());
      assert.equal(await statusOf(S2, 'second'), 'failed', 'the tick revived a space that was not owed one');
    }, { restore: async () => { await jobs(S1).insertOne(failedJob(S1, 'a')); } });

    // The view is gone and space 1 holds a failed job that never carried this version's marker.
    assert.equal(await statusOf(S1, 'a'), 'failed');
    const tick = await logLinesDuring(() => worker.runEmbedStallTick());
    assert.equal(await statusOf(S1, 'a'), 'pending', 'the tick never retried the space whose revive had failed');
    assert.equal((await jobs(S1).findOne({ _id: 'fact:a' })).revivedForVersion, version);
    assert.equal(await statusOf(S2, 'second'), 'failed', 'and still only that space');
    assert.ok(tick.lines.some((l) => /re-queued 1 job\(s\)/.test(l)), `the retry is said:\n${tick.lines.join('\n')}`);

    // Done: nothing is owed now, so a later failed job is left alone.
    await jobs(S1).insertOne(failedJob(S1, 'later'));
    await worker.runEmbedStallTick();
    assert.equal(await statusOf(S1, 'later'), 'failed', 'the retry went on after it had succeeded');
  });
});
