/**
 * The worker that drains the brain embedding queue.
 *
 * Deliberately much smaller than `files/media/worker.ts`: a media job renders pages, transcribes audio
 * and reports per-stage progress, so it needs a lease and step reports. Embedding one brain record is a
 * single call, so the job either finishes or fails. The stall reset still exists, because a process killed
 * mid-claim leaves a `processing` job that nothing else would ever pick up.
 *
 * ## Three things the inference process added (Q-99 part 1)
 *
 * The model runs in a child process behind a FIFO host, so an embed can now take long: a cold model load, or a
 * queue behind a large document. The stall sweep revives a `processing` job whose `progressAt` is two minutes old,
 * so while an embed is in flight the worker **heartbeats its claim**, and `completeEmbedJob` / `failEmbedJob` name
 * the claim token so a finish that arrives after the sweep handed the job to someone else changes nothing.
 *
 * And while the host is respawning a crashed child the worker **does not claim**: every claim in that window would
 * fail at once and spend a transient step per job. The host is asked (`waitOutLocalInferenceBackoff`), and answers
 * immediately whenever there is no backoff, including for an external endpoint that never starts a child.
 *
 * Sleeping is event-driven, not polled: `waitForEmbedWork` returns the moment an enqueue announces
 * work, so a write into an idle instance is embedded in milliseconds rather than waiting out a poll
 * interval. The epoch sampled before the claim is what closes the race where work arrives between a
 * failed claim and the start of the sleep.
 */

import {
  claimNextEmbedJob, completeEmbedJob, failEmbedJob, heartbeatEmbedJob, resetStalledEmbedJobs, reviveFailedEmbedJobs,
  currentEmbedWorkEpoch, waitForEmbedWork, wakeEmbedWorkers, EMBED_PRIORITY,
} from './embed-queue.js';
import { waitOutLocalInferenceBackoff } from './local-inference.js';
import { SERVER_VERSION } from '../util/server-version.js';
import { embedStoredRecord } from './embed-record.js';
import { concreteSpaceIds } from '../spaces/proxy.js';
import { log, peerText } from '../util/log.js';
import { intervalJob, INTERVAL_JOB_WINDOW_MS } from '../util/interval-job.js';
import { warnOnce } from '../util/warn-once.js';

/** Idle sleep. Work announces itself, so this is only the backstop for a missed announcement. */
const IDLE_POLL_MS = 30_000;
/** A claimed job with no sign of life for this long is assumed dead and returned to the pool. */
const STALL_TIMEOUT_MS = 120_000;
/** How often to sweep for stalled jobs while running. */
const STALL_SWEEP_MS = 60_000;
/** How often an embed in flight says it is alive: a quarter of the stall window, so three beats can be lost. */
export const EMBED_HEARTBEAT_MS = 30_000;

/**
 * The labels of the two interval jobs. CONSTANT, because a job's label is also the `job` label of
 * `ythril_interval_tick_skipped_total`: the job id of a heartbeat goes in its log line, never in its label.
 */
const STALL_SWEEP_JOB = 'Brain embedding stall sweep';
const HEARTBEAT_JOB = 'Brain embedding heartbeat';

let running = false;
let stopping = false;

/**
 * The spaces whose boot revive did not complete, and so are owed one by the stall tick (`S-R3`). Revive is idempotent per
 * version (a job revived carries `revivedForVersion`), so asking a space twice costs nothing and a space asked after it
 * succeeded matches no job.
 */
let reviveOwed = new Set<string>();

/** A heartbeat that fails is said once per job per window, naming the job: one line per beat would be a thousand an outage. */
const heartbeatFailedOnce = warnOnce<string>({ max: 1_000, every: INTERVAL_JOB_WINDOW_MS });

/**
 * Revive the failed jobs of `ids` for this server version and say what it did: how many it re-queued, and, when a space was not
 * reached, how many spaces were ("in 1 of 2 spaces"), because a count that reads complete while a space was skipped is a lie.
 * Keeps the spaces it could not finish as the set the stall tick retries.
 */
async function reviveFor(ids: string[]): Promise<void> {
  if (ids.length === 0) { reviveOwed = new Set(); return; }
  const { revived, failed } = await reviveFailedEmbedJobs(ids, SERVER_VERSION);
  reviveOwed = new Set(failed);
  if (revived > 0) {
    const reached = failed.length > 0 ? ` in ${ids.length - failed.length} of ${ids.length} spaces` : '';
    log.info(`Brain embedding worker: re-queued ${revived} job(s) that failed under an earlier version (now ${SERVER_VERSION})${reached}`);
  }
}

/**
 * The stall tick: return the jobs of dead workers to the pool, then retry the revive for the spaces whose boot revive did not
 * complete. Exported for the tests, which drive it directly (as `runOneEmbedJob`); the worker runs it as an interval job.
 */
export async function runEmbedStallTick(): Promise<void> {
  await resetStalledEmbedJobs(concreteSpaceIds(), STALL_TIMEOUT_MS);
  if (reviveOwed.size === 0) return;
  // Only spaces that still exist: a space deleted since boot owes nothing.
  const existing = new Set(concreteSpaceIds());
  await reviveFor([...reviveOwed].filter(id => existing.has(id)));
}

/**
 * The sweeps of a worker's start. Anything left `processing` by a previous process is dead by definition (nothing survives a
 * restart holding a claim), so the reset runs with a zero timeout rather than making the first records of the new run wait out
 * the stall window; then the one clean attempt per VERSION for anything that went terminally `failed` under an older one. A
 * systemic outage — an embedder unreachable for a quarter of an hour during an upgrade — spends every job's whole attempt budget at
 * once, and a terminal job is never claimed again. Reported from a live instance: "after updating all space indexing failed and
 * since has not been retried automatically." Logged at INFO with a count, because a silent mass requeue is indistinguishable from
 * nothing happening. A space whose revive failed is retried by {@link runEmbedStallTick}. One-shot: the worker starts it with `void`.
 */
export async function runEmbedBootSweeps(): Promise<void> {
  await resetStalledEmbedJobs(concreteSpaceIds(), 0);
  await reviveFor(concreteSpaceIds());
}

const stallJob = intervalJob(STALL_SWEEP_JOB, STALL_SWEEP_MS, runEmbedStallTick);

/**
 * Run one job if there is one. Returns whether anything was claimed, so the loop knows to go straight
 * round again rather than sleep. Exported for the tests, which drive it directly instead of racing a
 * background loop — a test that sleeps until a worker happens to have run is a test that flakes.
 */
export async function runOneEmbedJob(opts: { heartbeatMs?: number } = {}): Promise<boolean> {
  // BEFORE the claim: while the inference host is respawning after a loss every embed is refused, and a job claimed
  // in that window would fail at once and spend one of its transient steps for nothing.
  await waitOutLocalInferenceBackoff();
  const job = await claimNextEmbedJob(concreteSpaceIds());
  if (!job) return false;

  // A slow embed is not a dead worker: keep `progressAt` moving so the stall sweep leaves a live claim alone. An interval job
  // of its own (one at a time, bounded, its throw contained), stopped in a `finally` so a throw cannot leave a timer writing to
  // a finished job. A failed beat is said at warn once per job, with the job in the line and not in the job's label.
  const heartbeat = job.claimToken
    ? intervalJob(HEARTBEAT_JOB, opts.heartbeatMs ?? EMBED_HEARTBEAT_MS, async () => {
        try {
          await heartbeatEmbedJob(job.spaceId, job.recordType, job.recordId, job.claimToken!);
        } catch (err) {
          heartbeatFailedOnce(job._id, () => log.warn(`Embed job ${peerText(job._id)}: heartbeat failed: ${peerText(err)}`));
        }
      })
    : null;
  heartbeat?.start();

  try {
    // `gone` is a success: the record was deleted between the enqueue and the claim, so nothing is
    // owed. Retrying would keep a job alive for a document that will never come back.
    await embedStoredRecord(job.spaceId, job.recordType, job.recordId, { rebuild: job.rebuild === true });
    await completeEmbedJob(job.spaceId, job.recordType, job.recordId, job.claimToken);

    // A rebuild nobody wrote into is not an insert: running the insert rule for it would scan every record of a
    // reindexed space against its neighbours and fill the Review surface with pairs that were already there. A write
    // into a queued rebuild lowers its lane to 0, and then it is an insert like any other.
    if (job.rebuild === true && job.priority === EMBED_PRIORITY.rebuild) return true;

    // The space-level insert rule runs HERE, not at the write, because it evaluates the STORED record
    // against its neighbours and a stored record has no vector until this job gives it one. Firing it at
    // insert time would compare nothing and find nothing, silently. It is internally gated on
    // `dupeRulesOnInsert`, so this is a no-op for every space that has not enabled it, and it writes
    // candidates to the Review surface rather than returning them — no caller is waiting on it.
    void import('./dupe-scanner.js')
      .then(m => m.evaluateRecordForDuplicates(job.spaceId, job.recordType, job.recordId))
      .catch(() => { /* best-effort, exactly as it was on the write path */ });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // `transientFailures` comes from the job the worker already holds — no second read, and no
    // `findOneAndUpdate` to recover a post-increment value.
    await failEmbedJob(job.spaceId, job.recordType, job.recordId, job.attempts, msg, job.transientFailures ?? 0, {
      lostChildFailures: job.lostChildFailures ?? 0,
      claimToken: job.claimToken,
    });
    // debug, not warn: an embedder that is down produces one of these per queued record, and a
    // thousand warnings say nothing the first one did not. The failed count is the signal, and a bundled
    // model that cannot load is warned about ONCE by the inference host (`util/supervised-worker.ts`).
    log.debug(`Embed job ${job._id} in ${job.spaceId} failed (attempt ${job.attempts}): ${msg}`);
  } finally {
    heartbeat?.stop();
  }
  return true;
}

async function loop(): Promise<void> {
  while (!stopping) {
    // Sampled BEFORE the claim — this is what makes the wake-up race closed rather than unlikely.
    const epoch = currentEmbedWorkEpoch();
    let claimed = false;
    try {
      claimed = await runOneEmbedJob();
    } catch (err) {
      log.warn(`Brain embedding worker: claim failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (claimed) continue;
    await waitForEmbedWork(IDLE_POLL_MS, epoch);
  }
  running = false;
}

export function startBrainEmbeddingWorker(): void {
  if (running) return;
  running = true;
  stopping = false;

  // One-shot, and not awaited: the reset of a dead process's claims, then the version's revive (see `runEmbedBootSweeps`). A space
  // either could not finish is reported by the walk and retried by the stall tick below.
  void runEmbedBootSweeps().catch(err => log.warn(`Brain embedding worker: startup sweeps failed: ${err instanceof Error ? err.message : String(err)}`));

  stallJob.start();

  void loop();
}

export function stopBrainEmbeddingWorker(): void {
  stopping = true;
  stallJob.stop();
  // Wake the sleeper so shutdown is not delayed by a full idle interval.
  wakeEmbedWorkers();
}
