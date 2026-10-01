/**
 * A crashed inference process, a slow embed and a late finish, against a real MongoDB.
 *
 * ## Why these exist (Q-99 part 1)
 *
 * Moving inference into a child process adds three failure shapes the queue never had, and each one is a way for
 * the queue to go quietly wrong:
 *
 *  1. **A record that kills the runtime.** A lost child is the EMBEDDER's fault, so it is transient: retried with
 *     backoff and never spending the record's attempts. An input that segfaults onnxruntime looks exactly like that,
 *     for ever. So it is also capped per record: `lostChildFailures`, three, then terminal `failed` with the crash
 *     named in `lastError`, where an operator sees it and can `retry_embed_record`. Retry, rewrite and a new server
 *     version each give the record a clean count.
 *  2. **A slow embed is not a dead worker.** The stall sweep revives a `processing` job whose `progressAt` is older
 *     than two minutes. A cold model load, or a queue behind a document, can now take longer, so the worker
 *     heartbeats its claim while an embed is in flight.
 *  3. **A late finish must not undo a newer claim.** Once the sweep has revived a job and another worker holds it,
 *     the first worker's `completeEmbedJob` (which DELETES the job) or `failEmbedJob` would act on a claim that is
 *     no longer its own. Both take the claim token and change nothing when it is stale.
 *
 * And one more about waiting: while the inference host is in respawn backoff the worker does not CLAIM, because
 * every claim in that window would fail at once and spend a transient step per job in a crash loop.
 *
 * The host is scripted (`_scripted-inference-host.mjs`): what is under test is the queue and the worker, against
 * the error the real host raises (`LostChildError`).
 *
 * Run: npm run test:up, then
 *      node --test testing/standalone/embed-queue-lost-child-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';
import { createScriptedHost, gate } from './_scripted-inference-host.mjs';
import { createFakeSpawn, autopilot } from './_fake-child.mjs';

const skip = await mongoSkipReason();
const SPACE = 'general';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-embed-lost-'));
process.env['CONFIG_PATH'] = path.join(tmpDir, 'config.json');

let mongo, memory, queue, worker, local, errors, host;
const jobs = () => mongo.col(`${SPACE}_embed_jobs`);
const memories = () => mongo.col(`${SPACE}_facts`);

/** Poll a condition with a ceiling. Used only where the thing waited for is a timer inside the code under test. */
async function until(fn, what, ceilingMs = 10_000) {
  const end = Date.now() + ceilingMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise(r => setTimeout(r, 10));
  }
}

describe('the brain embed queue and a lost inference process (real MongoDB)', { skip }, () => {
  before(async () => {
    fs.writeFileSync(process.env['CONFIG_PATH'], JSON.stringify(
      { spaces: [{ id: SPACE, label: 'General' }], networks: [], tokens: [] }, null, 2));
    mongo = await openTestMongo('embedlostchild');
    const loader = await import('../../server/dist/config/loader.js');
    loader.loadConfig();
    memory = await import('../../server/dist/brain/fact.js');
    queue = await import('../../server/dist/brain/embed-queue.js');
    worker = await import('../../server/dist/brain/embed-worker.js');
    local = await import('../../server/dist/brain/local-inference.js');
    errors = await import('../../server/dist/brain/embed-errors.js');
  });

  after(async () => {
    local?._setLocalInferenceForTests?.(null);
    await closeTestMongo();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  beforeEach(async () => {
    await jobs().deleteMany({});
    await memories().deleteMany({});
    queue.resetEmbedPendingHint();
    host = createScriptedHost();
    local._setLocalInferenceForTests(host);
  });

  const lose = () => { host.behaviour = async () => { throw new errors.LostChildError('code=139 signal=null'); }; };
  const enqueue = async (text = 'an input that kills the runtime') => {
    const doc = await memory.saveFact(SPACE, text, [], []);
    return { doc, id: `fact:${doc._id}` };
  };
  /** Run the job once, as the passage of the backoff would allow. */
  const runOnce = async (id) => {
    await jobs().updateOne({ _id: id }, { $set: { claimableAfter: null } });
    queue.resetEmbedPendingHint();
    assert.equal(await worker.runOneEmbedJob(), true, 'the job was claimed');
    return jobs().findOne({ _id: id });
  };

  describe('a record that keeps killing the process', () => {
    it('retries the first two crashes with backoff and hands the attempt back each time', async () => {
      lose();
      const { id } = await enqueue();

      let job = await runOnce(id);
      assert.equal(job.status, 'pending');
      assert.equal(job.lostChildFailures, 1);
      assert.equal(job.transientFailures, 1, 'still a transient failure, so the backoff schedule applies');
      assert.equal(job.attempts, 0, 'the record\'s own attempt budget is not spent on the embedder\'s fault');
      assert.ok(job.claimableAfter, 'and it waits');

      job = await runOnce(id);
      assert.equal(job.status, 'pending');
      assert.equal(job.lostChildFailures, 2);
      assert.equal(job.attempts, 0);
    });

    it('ends terminally failed on the third, naming the crash, and is never claimed again', async () => {
      lose();
      const { id } = await enqueue();
      await runOnce(id);
      await runOnce(id);
      const job = await runOnce(id);

      assert.equal(queue.MAX_LOST_CHILD_FAILURES, 3);
      assert.equal(job.status, 'failed', 'an input that kills the runtime must not loop for ever');
      assert.equal(job.lostChildFailures, 3);
      assert.ok(job.lastError.includes(errors.LOST_MARKER), job.lastError);
      assert.match(job.lastError, /code=139/, 'an operator reading the failure sees how it died');

      queue.resetEmbedPendingHint();
      assert.equal(await worker.runOneEmbedJob(), false, 'a failed job is not claimed again');
    });

    it('does not cap an outage: unreachable-endpoint failures stay transient for as long as they last', async () => {
      host.behaviour = async () => { throw new Error('connect ECONNREFUSED 127.0.0.1:11434'); };
      const { id } = await enqueue('outage');
      let job;
      for (let i = 0; i < 8; i++) job = await runOnce(id);
      assert.equal(job.status, 'pending', 'an outage costs waiting, not the budget');
      assert.equal(job.lostChildFailures ?? 0, 0, 'and is not counted as a crash');
      assert.equal(job.transientFailures, 8);
    });

    it('gives a record a clean count when an operator retries it, when it is rewritten, and when a new version revives it', async () => {
      lose();
      const { doc, id } = await enqueue();
      await runOnce(id); await runOnce(id); await runOnce(id);
      assert.equal((await jobs().findOne({ _id: id })).status, 'failed');

      assert.equal(await queue.retryEmbedJob(SPACE, 'fact', doc._id), 'ok');
      let job = await jobs().findOne({ _id: id });
      assert.equal(job.status, 'pending');
      assert.equal(job.lostChildFailures ?? 0, 0, 'retry_embed_record is the operator\'s way out');

      await runOnce(id); await runOnce(id); await runOnce(id);
      await memory.saveFact(SPACE, 'rewritten', [], [], undefined, undefined, undefined, undefined, undefined, undefined, doc._id);
      job = await jobs().findOne({ _id: id });
      assert.equal(job.lostChildFailures ?? 0, 0, 'new content is a new record');

      await runOnce(id); await runOnce(id); await runOnce(id);
      assert.equal((await jobs().findOne({ _id: id })).status, 'failed');
      await queue.reviveFailedEmbedJobs([SPACE], 'some-new-version');
      job = await jobs().findOne({ _id: id });
      assert.equal(job.status, 'pending');
      assert.equal(job.lostChildFailures ?? 0, 0);
    });
  });

  describe('a record queued behind one that kills the process', () => {
    // The REAL host (`createLocalInference`) over a scripted child, because what is under test is the hand-off
    // between the two: the host rejects everything the lost child had, the queue charges a crash per record, and
    // only the record that was IN FLIGHT can have caused it. With `embedConcurrency` above one a bystander is
    // queued behind the poison record every time, so charging it too ends an innocent record `failed` after three.
    it('charges the crash to the record in flight only; the bystander is not counted and later completes', async () => {
      const spawns = createFakeSpawn({
        onSpawn: (child) => {
          autopilot(child);
          const send = child.send.bind(child);
          // The poison input is taken and never answered: the test kills the child while it holds it.
          child.send = (msg, cb) => {
            if (msg?.type === 'request' && String(msg.input).includes('poison')) {
              child.sent.push(msg);
              queueMicrotask(() => cb?.(null));
              return true;
            }
            return send(msg, cb);
          };
        },
      });
      const real = local.createLocalInference({ spawn: spawns.spawn, backoffMs: () => 0, log: () => {} });
      local._setLocalInferenceForTests(real);

      const poison = await enqueue('poison record');
      const innocent = await enqueue('an innocent record');
      const hold = (id) => jobs().updateOne({ _id: id }, { $set: { claimableAfter: '2999-01-01T00:00:00.000Z' } });
      const release = (id) => jobs().updateOne({ _id: id }, { $set: { claimableAfter: null } });

      for (let crash = 1; crash <= queue.MAX_LOST_CHILD_FAILURES; crash++) {
        // The poison record first, until it is the request the child holds; then the innocent one, until it waits
        // behind it in the host's queue. Then the child dies.
        await hold(innocent.id);
        await release(poison.id);
        queue.resetEmbedPendingHint();
        const first = worker.runOneEmbedJob();
        await until(() => real.state().inFlight === 1, `the poison record in flight (crash ${crash})`);
        await release(innocent.id);
        queue.resetEmbedPendingHint();
        const second = worker.runOneEmbedJob();
        await until(() => real.state().queued === 1, `the innocent record queued behind it (crash ${crash})`);
        spawns.last().exit(null, 'SIGSEGV');
        assert.deepEqual(await Promise.all([first, second]), [true, true]);

        const bystander = await jobs().findOne({ _id: innocent.id });
        assert.equal(bystander.status, 'pending', `crash ${crash}: the bystander is retried`);
        assert.equal(bystander.lostChildFailures ?? 0, 0, `crash ${crash}: a record that was never sent is not charged`);
        assert.equal(bystander.attempts, 0, 'and spends none of its attempts: the embedder was at fault');
      }

      const culprit = await jobs().findOne({ _id: poison.id });
      assert.equal(culprit.status, 'failed', 'the record that kills the runtime ends failed after three');
      assert.equal(culprit.lostChildFailures, queue.MAX_LOST_CHILD_FAILURES);
      assert.ok(culprit.lastError.includes(errors.LOST_MARKER), culprit.lastError);

      await release(innocent.id);
      queue.resetEmbedPendingHint();
      assert.equal(await worker.runOneEmbedJob(), true, 'the bystander is claimed again');
      assert.equal(await jobs().countDocuments({ _id: innocent.id }), 0, 'and completes on a fresh process');
      await real.stop();
    });
  });

  describe('a slow embed', () => {
    it('advances the claim\'s progressAt while the embed is in flight, so the stall sweep leaves it alone', async () => {
      const held = gate();
      host.behaviour = async (r) => {
        await held.promise;
        return { vector: [0.1, 0.2], modelId: r.modelId, inferenceMs: 5 };
      };
      assert.equal(worker.EMBED_HEARTBEAT_MS, 30_000, 'the documented beat: a quarter of the stall window');
      const { id } = await enqueue('slow');

      const run = worker.runOneEmbedJob({ heartbeatMs: 25 });
      await until(async () => (await jobs().findOne({ _id: id }))?.status === 'processing', 'the job to be claimed');
      await jobs().updateOne({ _id: id }, { $set: { progressAt: '2000-01-01T00:00:00.000Z' } });

      const beat = await until(async () => {
        const j = await jobs().findOne({ _id: id });
        return j.progressAt > new Date(Date.now() - 5_000).toISOString() ? j : null;
      }, 'a heartbeat to advance progressAt');
      assert.equal(beat.status, 'processing');
      assert.equal(await queue.resetStalledEmbedJobs([SPACE], 60_000), 0, 'the sweep cannot revive a live embed');

      held.open();
      await run;
      assert.equal(await jobs().countDocuments({ _id: id }), 0, 'and it completes normally');
    });

    it('stops heartbeating when the embed is over', async () => {
      const { id } = await enqueue('quick');
      await worker.runOneEmbedJob({ heartbeatMs: 10 });
      await new Promise(r => setTimeout(r, 60));
      assert.equal(await jobs().countDocuments({ _id: id }), 0);
      assert.equal(await jobs().countDocuments({ status: 'processing' }), 0,
        'a beat after the finish must not resurrect or re-mark the job');
    });

    it('heartbeatEmbedJob answers true for the holder of the claim and false, changing nothing, for anyone else', async () => {
      const { id, doc } = await enqueue('beat');
      queue.resetEmbedPendingHint();
      const claimed = await queue.claimNextEmbedJob([SPACE]);
      await jobs().updateOne({ _id: id }, { $set: { progressAt: '2000-01-01T00:00:00.000Z' } });

      assert.equal(await queue.heartbeatEmbedJob(SPACE, 'fact', doc._id, 'not-the-token'), false);
      assert.equal((await jobs().findOne({ _id: id })).progressAt, '2000-01-01T00:00:00.000Z');

      assert.equal(await queue.heartbeatEmbedJob(SPACE, 'fact', doc._id, claimed.claimToken), true);
      assert.ok((await jobs().findOne({ _id: id })).progressAt > '2001');
    });
  });

  describe('a finish that arrives after the claim was taken over', () => {
    it('does not delete, fail or otherwise touch the newer claim', async () => {
      const held = gate();
      host.behaviour = async (r) => {
        if (host.calls.length === 1) await held.promise;      // the first worker's embed is the slow one
        return { vector: [0.1, 0.2], modelId: r.modelId, inferenceMs: 5 };
      };
      const { id, doc } = await enqueue('taken over');

      const first = worker.runOneEmbedJob({ heartbeatMs: 10_000 });
      await until(async () => (await jobs().findOne({ _id: id }))?.status === 'processing', 'the first claim');
      const staleToken = (await jobs().findOne({ _id: id })).claimToken;

      // The sweep decides the first worker is dead, and a second worker takes the job.
      assert.equal(await queue.resetStalledEmbedJobs([SPACE], 0), 1);
      queue.resetEmbedPendingHint();
      const second = await queue.claimNextEmbedJob([SPACE]);
      assert.ok(second && second.claimToken !== staleToken, 'a new claim with a new token');

      held.open();
      await first;                                    // the first worker finishes, late, with success

      const after = await jobs().findOne({ _id: id });
      assert.ok(after, 'the late finish deleted the job that the new claimant holds');
      assert.equal(after.status, 'processing');
      assert.equal(after.claimToken, second.claimToken);

      // And a late FAILURE is equally inert.
      await queue.failEmbedJob(SPACE, 'fact', doc._id, 1, 'late and wrong', 0, { claimToken: staleToken });
      const still = await jobs().findOne({ _id: id });
      assert.equal(still.status, 'processing');
      assert.equal(still.claimToken, second.claimToken);
      assert.notEqual(still.lastError, 'late and wrong');

      // The holder of the current claim can finish it.
      await queue.completeEmbedJob(SPACE, 'fact', doc._id, second.claimToken);
      assert.equal(await jobs().countDocuments({ _id: id }), 0);
    });

    it('completeEmbedJob and failEmbedJob without a token keep their old behaviour', async () => {
      const a = await enqueue('legacy complete');
      await queue.completeEmbedJob(SPACE, 'fact', a.doc._id);
      assert.equal(await jobs().countDocuments({ _id: a.id }), 0);

      const b = await enqueue('legacy fail');
      queue.resetEmbedPendingHint();
      const claimed = await queue.claimNextEmbedJob([SPACE]);
      await queue.failEmbedJob(SPACE, 'fact', b.doc._id, claimed.attempts, 'boring failure');
      assert.equal((await jobs().findOne({ _id: b.id })).lastError, 'boring failure');
    });
  });

  describe('while the inference host is backing off', () => {
    it('claims nothing until the backoff is over, then claims and embeds', async () => {
      const release = gate();
      host.backoff = () => release.promise;
      const { id } = await enqueue('waits for the host');

      const run = worker.runOneEmbedJob();
      for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r));
      assert.equal((await jobs().findOne({ _id: id })).status, 'pending',
        'a claim made while every embed is refused would spend a transient step for nothing');

      release.open();
      assert.equal(await run, true);
      assert.equal(await jobs().countDocuments({ _id: id }), 0, 'and once the host is back the job goes through');
    });
  });
});
