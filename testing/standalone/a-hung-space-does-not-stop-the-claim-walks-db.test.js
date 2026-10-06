/**
 * One hung space does not stop the embed and media claim walks, the revive, or the stall resets (`Q-274`, `Q-358`, bundle-53 G14).
 *
 * ## The defect
 *
 * `claimNextEmbedJob`, `claimNextJob`, `reviveFailedEmbedJobs`, `resetStalledEmbedJobs` and `resetStalledJobs` each looped over the
 * spaces with no catch and no bound. A space whose operation never returned (a document lock another writer holds, a stalled
 * store behind one collection) held the loop, and with it the worker, for as long as the driver waited; a space whose operation
 * threw ended the walk for every space behind it.
 *
 * ## What is pinned, against a real MongoDB
 *
 * A document lock (`holdDocumentLock`: another session's open transaction) on the only claimable / revivable / stalled job of
 * space 1 stalls the operation that must write it. Under a bound of 1.5 s (an enclosing `withinHousekeepingBound` can only tighten
 * the claim's own 10 s), for each of the five walks:
 *
 *  1. space 2's work is done IN THE SAME CALL, after one bound;
 *  2. a second call does NOT wait another bound: space 1 is quarantined (a full scan included);
 *  3. after `await lock.release()` (which drains) and a write to space 1 (which lifts its quarantine for one probe), space 1's
 *     work is done. The window's own end (60 s) is pinned against an injected clock in `claim-across.test.js`.
 *
 * And the store-wide case: the freezable relay stops the store answering with every socket open. A claim walk then pays ONE bound
 * and ONE ping, answers null, and says ONE `store` line - not one bound per space.
 *
 * The whole file's connection runs through the relay (thawed except in the last case).
 *
 * Run: a Mongo the harness accepts, then node --test testing/standalone/a-hung-space-does-not-stop-the-claim-walks-db.test.js
 * (requires a prior `npm run build:server`)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';
import { startFreezableRelay } from './_freezable-relay.mjs';
import { holdDocumentLock, settleWithin } from './_write-faults.mjs';
import { logLinesDuring } from './_log-lines.mjs';
import { holdsWithin } from '../_shared/wait-for.mjs';

const skip = await mongoSkipReason();

const BOUND_MS = 1_500;
/** One bound, the client backstop behind it, and slack for a loaded machine. */
const ONE_BOUND_MS = BOUND_MS + 500 + 2_000;
const OLD = '2026-07-22T11:00:00.000Z';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-hung-claims-'));
const CONFIG_PATH = path.join(tmpDir, 'config.json');
process.env['CONFIG_PATH'] = CONFIG_PATH;

const DB_SUFFIX = 'hungclaims';
const QUERY = '&connectTimeoutMS=1000&heartbeatFrequencyMS=500&serverSelectionTimeoutMS=20000';

let relay; let mongo; let queue; let mediaQueue; let wb; let probes;

const embedJobs = (s) => mongo.col(`${s}_embed_jobs`);
const mediaJobs = (s) => mongo.col(`${s}_media_jobs`);

const embedJob = (space, id, over = {}) => ({
  _id: `fact:${id}`, spaceId: space, recordType: 'fact', recordId: id, status: 'pending', priority: 0,
  attempts: 0, transientFailures: 0, lostChildFailures: 0, maxAttempts: 5, lastError: null,
  claimedAt: null, progressAt: null, claimableAfter: null, claimToken: null, createdAt: OLD, updatedAt: OLD, ...over,
});
const mediaJob = (space, id, over = {}) => ({
  _id: id, spaceId: space, filePath: id, mimeType: 'application/pdf', mediaType: 'text', status: 'pending',
  attempts: 0, maxAttempts: 3, lastError: null, claimedAt: null, createdAt: OLD, updatedAt: OLD, ...over,
});

/** Run `fn` inside a housekeeping scope that tightens every bound to the case's, and say how long it took. */
async function timed(fn) {
  const started = Date.now();
  const value = await wb.withinHousekeepingBound(fn, { opMs: BOUND_MS });
  return { value, ms: Date.now() - started };
}

/**
 * A WRITE to the space, which is what lifts its quarantine for one probe (`markSpaceMayHaveWork`): the production door the
 * quarantine has besides its 60 s window. The window's own end is pinned in `claim-across.test.js` against an injected clock,
 * because the process-wide walk reads the real one and a minute of waiting per case is not a test.
 */
const nudgeEmbed = (space) => queue.enqueueEmbedJob(space, 'fact', 'nudge', { priority: queue.EMBED_PRIORITY.write });
const nudgeMedia = (space) => mediaQueue.markSpaceMayHaveWork(space);

describe('a hung space does not stop the claim walks (real MongoDB, through the freezable relay)', { skip }, () => {
  before(async () => {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({ spaces: [], networks: [], tokens: [] }, null, 2));
    relay = await startFreezableRelay(`ythril_harness_${DB_SUFFIX}`, { query: QUERY });
    mongo = await openTestMongo(DB_SUFFIX, { port: Number(relay.address.split(':')[1]), query: QUERY });
    (await import('../../server/dist/config/loader.js')).loadConfig();
    queue = await import('../../server/dist/brain/embed-queue.js');
    mediaQueue = await import('../../server/dist/files/media/job-queue.js');
    wb = await import('../../server/dist/db/write-bound.js');
    probes = await import('../../server/dist/util/cached-probe.js');
  });

  after(async () => {
    relay?.thaw();
    await closeTestMongo();
    await relay?.close();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it('claimNextEmbedJob: space 2\'s job is claimed in the same call; a second claim waits no second bound; space 1 is claimed once the quarantine ends', async () => {
    const [s1, s2] = ['embed-claim-1', 'embed-claim-2'];
    await embedJobs(s1).insertOne(embedJob(s1, 'locked'));
    await embedJobs(s2).insertMany([embedJob(s2, 'one'), embedJob(s2, 'two')]);
    const lock = await holdDocumentLock(mongo, `${s1}_embed_jobs`, { filter: { _id: 'fact:locked' } });
    try {
      queue.resetEmbedPendingHint();
      const first = await timed(() => queue.claimNextEmbedJob([s1, s2]));
      assert.equal(first.value?.spaceId, s2, 'the hung space stopped the claim for the space behind it');
      assert.ok(first.ms <= ONE_BOUND_MS, `the first claim took ${first.ms} ms: more than one bound (${BOUND_MS} ms)`);

      queue.resetEmbedPendingHint(); // a FULL scan is due again: the quarantine, not the hint, is what skips space 1
      const second = await timed(() => queue.claimNextEmbedJob([s1, s2]));
      assert.equal(second.value?.spaceId, s2);
      assert.ok(second.ms < BOUND_MS, `the second claim took ${second.ms} ms: it waited on the quarantined space`);
    } finally { await lock.release(); }

    await nudgeEmbed(s1);
    const later = await timed(() => queue.claimNextEmbedJob([s1, s2]));
    assert.equal(later.value?.recordId, 'locked', 'space 1 was never claimed again after its quarantine ended');
    assert.equal(later.value?.spaceId, s1);
  });

  it('claimNextJob (media): the same three', async () => {
    const [s1, s2] = ['media-claim-1', 'media-claim-2'];
    await mediaJobs(s1).insertOne(mediaJob(s1, 'locked.pdf'));
    await mediaJobs(s2).insertMany([mediaJob(s2, 'one.pdf'), mediaJob(s2, 'two.pdf')]);
    const lock = await holdDocumentLock(mongo, `${s1}_media_jobs`, { filter: { _id: 'locked.pdf' } });
    try {
      mediaQueue.resetMediaPendingHint();
      const first = await timed(() => mediaQueue.claimNextJob([s1, s2]));
      assert.equal(first.value?.spaceId, s2, 'the hung space stopped the claim for the space behind it');
      assert.ok(first.ms <= ONE_BOUND_MS, `the first claim took ${first.ms} ms`);

      mediaQueue.resetMediaPendingHint();
      const second = await timed(() => mediaQueue.claimNextJob([s1, s2]));
      assert.equal(second.value?.spaceId, s2);
      assert.ok(second.ms < BOUND_MS, `the second claim took ${second.ms} ms: it waited on the quarantined space`);
    } finally { await lock.release(); }

    mediaQueue.resetMediaPendingHint();
    nudgeMedia(s1);
    const later = await timed(() => mediaQueue.claimNextJob([s1, s2]));
    assert.equal(later.value?.spaceId, s1);
    assert.equal(later.value?._id, 'locked.pdf');
  });

  it('reviveFailedEmbedJobs: space 2 is revived in the same call, the failed set names space 1, a second call waits no second bound', async () => {
    const [s1, s2] = ['revive-1', 'revive-2'];
    await embedJobs(s1).insertOne(embedJob(s1, 'locked', { status: 'failed', attempts: 5 }));
    await embedJobs(s2).insertOne(embedJob(s2, 'ok', { status: 'failed', attempts: 5 }));
    const lock = await holdDocumentLock(mongo, `${s1}_embed_jobs`, { filter: { _id: 'fact:locked' } });
    try {
      const first = await timed(() => queue.reviveFailedEmbedJobs([s1, s2], '9.9.9'));
      assert.equal(first.value.revived, 1);
      assert.deepEqual(first.value.failed, [s1], 'the failed set is what the worker\'s tick retries');
      assert.equal((await embedJobs(s2).findOne({ _id: 'fact:ok' })).status, 'pending');
      assert.ok(first.ms <= ONE_BOUND_MS, `the first revive took ${first.ms} ms`);

      const second = await timed(() => queue.reviveFailedEmbedJobs([s1, s2], '9.9.9'));
      assert.deepEqual(second.value.failed, [s1], 'a quarantined space is not revived, and is still owed');
      assert.ok(second.ms < BOUND_MS, `the second revive took ${second.ms} ms: it waited on the quarantined space`);
    } finally { await lock.release(); }

    await nudgeEmbed(s1);
    const later = await timed(() => queue.reviveFailedEmbedJobs([s1, s2], '9.9.9'));
    assert.deepEqual(later.value.failed, []);
    assert.equal((await embedJobs(s1).findOne({ _id: 'fact:locked' })).status, 'pending');
  });

  it('resetStalledEmbedJobs: space 2 is reset in the same call, a second call waits no second bound, space 1 is reset after its quarantine', async () => {
    const [s1, s2] = ['stall-1', 'stall-2'];
    const stale = { status: 'processing', attempts: 1, claimedAt: OLD, progressAt: OLD, claimToken: 'tok' };
    await embedJobs(s1).insertOne(embedJob(s1, 'locked', stale));
    await embedJobs(s2).insertOne(embedJob(s2, 'ok', stale));
    const lock = await holdDocumentLock(mongo, `${s1}_embed_jobs`, { filter: { _id: 'fact:locked' } });
    try {
      const first = await timed(() => queue.resetStalledEmbedJobs([s1, s2], 60_000));
      assert.equal(first.value, 1);
      assert.equal((await embedJobs(s2).findOne({ _id: 'fact:ok' })).status, 'pending');
      assert.ok(first.ms <= ONE_BOUND_MS, `the first reset took ${first.ms} ms`);

      const second = await timed(() => queue.resetStalledEmbedJobs([s1, s2], 60_000));
      assert.equal(second.value, 0);
      assert.ok(second.ms < BOUND_MS, `the second reset took ${second.ms} ms: it waited on the quarantined space`);
    } finally { await lock.release(); }

    await nudgeEmbed(s1);
    const later = await timed(() => queue.resetStalledEmbedJobs([s1, s2], 60_000));
    assert.equal(later.value, 1);
    assert.equal((await embedJobs(s1).findOne({ _id: 'fact:locked' })).status, 'pending');
  });

  it('resetStalledJobs (media): the same three', async () => {
    const [s1, s2] = ['mstall-1', 'mstall-2'];
    const stale = { status: 'processing', attempts: 1, claimedAt: OLD, progressAt: OLD, claimToken: 'tok' };
    await mediaJobs(s1).insertOne(mediaJob(s1, 'locked.pdf', stale));
    await mediaJobs(s2).insertOne(mediaJob(s2, 'ok.pdf', stale));
    const lock = await holdDocumentLock(mongo, `${s1}_media_jobs`, { filter: { _id: 'locked.pdf' } });
    try {
      const first = await timed(() => mediaQueue.resetStalledJobs([s1, s2], 60_000));
      assert.equal((await mediaJobs(s2).findOne({ _id: 'ok.pdf' })).status, 'pending', 'the hung space stopped the reset for the space behind it');
      assert.ok(first.ms <= ONE_BOUND_MS, `the first reset took ${first.ms} ms`);

      const second = await timed(() => mediaQueue.resetStalledJobs([s1, s2], 60_000));
      assert.ok(second.ms < BOUND_MS, `the second reset took ${second.ms} ms: it waited on the quarantined space`);
      assert.equal((await mediaJobs(s1).findOne({ _id: 'locked.pdf' })).status, 'processing');
    } finally { await lock.release(); }

    nudgeMedia(s1);
    await timed(() => mediaQueue.resetStalledJobs([s1, s2], 60_000));
    assert.equal((await mediaJobs(s1).findOne({ _id: 'locked.pdf' })).status, 'pending');
  });

  it('a frozen store: a claim walk pays ONE bound and ONE ping, answers null, and says ONE store line', async () => {
    const ids = ['frozen-1', 'frozen-2', 'frozen-3'];
    for (const s of ids) await embedJobs(s).insertOne(embedJob(s, 'x'));
    queue.resetEmbedPendingHint();
    probes.forgetCachedProbes();
    relay.freeze();
    try {
      // Let the monitor notice and clear the pool, as a paused store does after its first beat: the ping then waits its own bound.
      await new Promise((r) => setTimeout(r, 2_500));
      let timing;
      const { lines } = await logLinesDuring(async () => { timing = await timed(() => queue.claimNextEmbedJob(ids)); });
      assert.equal(timing.value, null, 'a store that does not answer claims nothing');
      const limit = BOUND_MS + 500 + 3_000 + 2_500;
      assert.ok(timing.ms <= limit, `the claim took ${timing.ms} ms; one bound (${BOUND_MS}) + one ping (3000) is ${BOUND_MS + 3_000}: it paid one bound per space`);
      const stoppedLines = lines.filter((l) => /Embed claim stopped: the store is not answering/.test(l));
      assert.equal(stoppedLines.length, 1, `expected one store line, got:\n${lines.join('\n')}`);
      assert.equal(lines.filter((l) => /Embed claim failed for space/.test(l)).length, 0, 'a store-wide stop is not reported once per space');
    } finally { relay.thaw(); }
    const back = await holdsWithin(async () => {
      const done = await settleWithin(mongo.getMongo().db('admin').command({ ping: 1 }, { timeoutMS: 1_000 }), 1_500);
      return done.settled && done.ok;
    }, 15_000, 200);
    assert.ok(back, 'the store did not answer again after thaw()');
  });
});
