/**
 * The record embed queue is measured by lane: `ythril_embed_jobs{lane,status}` (gauge) and `ythril_embed_job_claim_age_seconds{lane}`
 * (histogram) (Q-182, bundle-41).
 *
 * ## The question they answer
 *
 * Whether a write waits behind a reindex. The queue has three lanes (`EMBED_PRIORITY`: write 0, background 1, rebuild 2; a job with no priority
 * is claimed as write), and nothing on `/metrics` said how many jobs stood in each, or how long a job waited before its first claim.
 *
 * ## What it holds (real MongoDB, the real queue, the registry's own text after a scrape)
 *
 *  1. One pending job per lane: after a scrape from a POISONED start (every series set to 999 999 first, so a collector that writes nothing
 *     fails), `ythril_embed_jobs{lane=…,status="pending"}` is 1 for each lane and processing and failed are 0.
 *  2. A claim moves its lane's claim-age histogram count by exactly 1 and no other lane's, and the gauge moves the job from pending to
 *     processing.
 *  3. A second claim of the same job after an outage hand-back (the attempt given back) does not move the histogram: the age is the wait
 *     before the FIRST claim since the job's budget was granted, never once per retry.
 *  3b. A job revived for a new server version (a fresh budget) is observed once at its next claim, timed from the revive: a job failed an
 *     hour after it was queued reports the wait since its revive, not its whole life (`createdAt` is set on insert only).
 *  4. A space that fails to read removes the gauge's series for that scrape (absent, so a dashboard shows a gap and `absent()` can alert),
 *     never a sum that reads as a drained queue; the next scrape that reads every space sets them again.
 *
 * The failing space is a VIEW named like its job collection over a source whose pipeline cannot convert a document (as in
 * `a-failing-space-does-not-blank-the-gauges-db`): every read of it is refused while the store answers every other call.
 *
 * Seen red on 890cf234b: neither metric exists.
 *
 * Run: node --test testing/standalone/the-embed-queue-is-measured-by-lane-db.test.js
 * (requires a prior `npm run build:server` and the test MongoDB)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';

const skip = await mongoSkipReason();

const SPACE = 'general';
const OTHER = 'second';
const GAUGE = 'ythril_embed_jobs';
const HISTOGRAM = 'ythril_embed_job_claim_age_seconds';
const LANES = ['write', 'background', 'rebuild'];
const STATUSES = ['pending', 'processing', 'failed'];
const POISON = 999_999;

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-q182-'));
const CONFIG_PATH = path.join(tmpDir, 'config.json');
process.env['CONFIG_PATH'] = CONFIG_PATH;

let mongo, queue, registry, errors;

const jobs = (space = SPACE) => mongo.col(`${space}_embed_jobs`);

/** One scrape through the window the route opens. */
async function scrape() {
  registry.beginScrape();
  try { return await registry.register.metrics(); } finally { registry.endScrape(); }
}

/** Every sample of `metric` in a scrape, keyed by its label text: `lane=write,status=pending` to value. */
function samples(text, metric) {
  const out = new Map();
  for (const line of text.split('\n')) {
    if (!line.startsWith(`${metric}{`)) continue;
    const m = /^[a-z_]+\{(.*)\}\s+(\S+)$/.exec(line);
    if (!m) continue;
    const labels = [...m[1].matchAll(/([a-z_]+)="([^"]*)"/g)].map(l => `${l[1]}=${l[2]}`).sort().join(',');
    out.set(labels, Number(m[2]));
  }
  return out;
}
const gaugeOf = (text, lane, status) => samples(text, GAUGE).get(`lane=${lane},status=${status}`);
const claimCount = (text, lane) => samples(text, `${HISTOGRAM}_count`).get(`lane=${lane}`);
const claimSum = (text, lane) => samples(text, `${HISTOGRAM}_sum`).get(`lane=${lane}`);

/** The gauge as the registry declares it; a plain failure when it does not. */
function gauge() {
  const metric = registry.register.getSingleMetric(GAUGE);
  assert.ok(metric, `the registry declares no ${GAUGE}: nothing says how many embed jobs stand in each lane`);
  return metric;
}
function poison() {
  const g = gauge();
  for (const lane of LANES) for (const status of STATUSES) g.set({ lane, status }, POISON);
}

/** Queue one fact job on each lane, ids `f-<lane>`. */
async function onePerLane() {
  for (const [i, lane] of LANES.entries()) await queue.enqueueEmbedJob(SPACE, 'fact', `f-${lane}`, { priority: i });
}

describe('the embed queue is measured by lane (real MongoDB, the registry\'s own text)', { skip }, () => {
  before(async () => {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({
      spaces: [{ id: SPACE, label: 'General' }, { id: OTHER, label: 'Second' }], networks: [], tokens: [],
    }, null, 2));
    mongo = await openTestMongo('q182embedlanes');
    (await import('../../server/dist/config/loader.js')).loadConfig();
    queue = await import('../../server/dist/brain/embed-queue.js');
    errors = await import('../../server/dist/brain/embed-errors.js');
    registry = await import('../../server/dist/metrics/registry.js');
  });

  after(async () => {
    await closeTestMongo();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  beforeEach(async () => {
    await jobs().deleteMany({});
    try { await mongo.getDb().collection(`${OTHER}_embed_jobs`).drop(); } catch { /* not there */ }
    queue.resetEmbedPendingHint();
  });

  it('one pending job per lane reads 1 pending on each lane after a scrape from a poisoned start', async () => {
    await onePerLane();
    poison();
    const text = await scrape();
    for (const lane of LANES) {
      assert.equal(gaugeOf(text, lane, 'pending'), 1, `${GAUGE}{lane="${lane}",status="pending"} reads ${gaugeOf(text, lane, 'pending')}`);
      assert.equal(gaugeOf(text, lane, 'processing'), 0, `${lane} processing`);
      assert.equal(gaugeOf(text, lane, 'failed'), 0, `${lane} failed`);
    }
  });

  it('a claim moves its lane\'s claim-age count by 1 and no other lane\'s, and moves the job from pending to processing', async () => {
    await queue.enqueueEmbedJob(SPACE, 'fact', 'f-claimed', { priority: queue.EMBED_PRIORITY.write });
    gauge();
    const before = await scrape();
    const counts = Object.fromEntries(LANES.map(l => [l, claimCount(before, l)]));
    for (const lane of LANES) assert.equal(typeof counts[lane], 'number', `${HISTOGRAM}{lane="${lane}"} is not declared at zero (${counts[lane]})`);

    const job = await queue.claimNextEmbedJob([SPACE]);
    assert.equal(job?.recordId, 'f-claimed', 'fixture: the queued job was not claimed');
    const after = await scrape();
    assert.equal(claimCount(after, 'write') - counts.write, 1, 'the first claim of a write-lane job was not observed once');
    for (const lane of ['background', 'rebuild']) assert.equal(claimCount(after, lane) - counts[lane], 0, `a write-lane claim moved the ${lane} lane's count`);
    assert.equal(gaugeOf(after, 'write', 'pending'), 0);
    assert.equal(gaugeOf(after, 'write', 'processing'), 1);
  });

  it('a second claim of the same job after an outage hand-back does not move the claim-age count', async () => {
    await queue.enqueueEmbedJob(SPACE, 'fact', 'f-outage', { priority: queue.EMBED_PRIORITY.write });
    gauge();
    const first = await queue.claimNextEmbedJob([SPACE]);
    assert.equal(first?.recordId, 'f-outage', 'fixture: the queued job was not claimed');
    const afterFirst = claimCount(await scrape(), 'write');
    assert.equal(typeof afterFirst, 'number', `${HISTOGRAM}{lane="write"} is not declared`);

    await queue.failEmbedJob(SPACE, 'fact', 'f-outage', first.attempts, new errors.EmbedUnreachableError('the embedder is down'), 0, { claimToken: first.claimToken });
    const handedBack = await jobs().findOne({ recordId: 'f-outage' });
    assert.deepEqual([handedBack.status, handedBack.attempts, handedBack.transientFailures], ['pending', 0, 1], 'fixture: the outage did not hand the attempt back');
    await jobs().updateMany({ status: 'pending' }, { $set: { claimableAfter: null } });

    const second = await queue.claimNextEmbedJob([SPACE]);
    assert.equal(second?.recordId, 'f-outage', 'fixture: the handed-back job was not claimed again');
    assert.equal(second.attempts, 1, 'fixture: the second claim does not look like a first attempt, so it would not tempt an observation');
    assert.equal(claimCount(await scrape(), 'write'), afterFirst, 'a claim after an outage hand-back was observed again: the age counts retries, not the wait before the first claim');
  });

  it('a job revived for a new server version is observed once at its next claim, timed from the revive, not from its insert', async () => {
    await queue.enqueueEmbedJob(SPACE, 'fact', 'f-revived', { priority: queue.EMBED_PRIORITY.write });
    const anHourAgo = new Date(Date.now() - 3_600_000).toISOString();
    await jobs().updateOne({ recordId: 'f-revived' }, { $set: { status: 'failed', attempts: 5, createdAt: anHourAgo, queuedAt: anHourAgo } });
    gauge();
    const before = await scrape();
    const [count0, sum0] = [claimCount(before, 'write'), claimSum(before, 'write')];
    assert.equal(typeof count0, 'number', `${HISTOGRAM}{lane="write"} is not declared`);

    const { revived } = await queue.reviveFailedEmbedJobs([SPACE], 'q182-revive');
    assert.equal(revived, 1, 'fixture: the failed job was not revived');
    const job = await queue.claimNextEmbedJob([SPACE]);
    assert.equal(job?.recordId, 'f-revived', 'fixture: the revived job was not claimed');
    const after = await scrape();
    assert.equal(claimCount(after, 'write') - count0, 1, 'the first claim after a revive was not observed once');
    const waited = claimSum(after, 'write') - sum0;
    assert.ok(waited >= 0 && waited < 60, `the revived job's claim age is ${waited} s: timed from its insert an hour ago, not from the revive`);
  });

  it('a space that fails to read removes the gauge\'s series for that scrape; the next full read sets them again', async () => {
    await onePerLane();
    const db = mongo.getDb();
    await db.collection('q182_src').deleteMany({});
    await db.collection('q182_src').insertOne({ _id: 1, a: 'not-a-number' });
    await db.createCollection(`${OTHER}_embed_jobs`, { viewOn: 'q182_src', pipeline: [{ $project: { x: { $toInt: '$a' } } }] });
    poison();
    const broken = await scrape();
    assert.deepEqual([...samples(broken, GAUGE).entries()], [], `with '${OTHER}' unreadable the gauge still reports a sum that reads as a whole queue`);

    await db.collection(`${OTHER}_embed_jobs`).drop();
    const healed = await scrape();
    for (const lane of LANES) assert.equal(gaugeOf(healed, lane, 'pending'), 1, `after '${OTHER}' reads again, ${lane} pending is ${gaugeOf(healed, lane, 'pending')}`);
  });
});
