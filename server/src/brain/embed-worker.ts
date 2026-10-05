/**
 * The worker that drains the brain embedding queue.
 *
 * Deliberately much smaller than `files/media/worker.ts`: a media job renders pages, transcribes audio
 * and reports per-stage progress, so it needs heartbeats and a lease. Embedding one brain record is a
 * single short call, so the job either finishes or fails — there is nothing to heartbeat *during*.
 * The stall reset still exists, because a process killed mid-claim leaves a `processing` job that
 * nothing else would ever pick up.
 *
 * Sleeping is event-driven, not polled: `waitForEmbedWork` returns the moment an enqueue announces
 * work, so a write into an idle instance is embedded in milliseconds rather than waiting out a poll
 * interval. The epoch sampled before the claim is what closes the race where work arrives between a
 * failed claim and the start of the sleep.
 */

import {
  claimNextEmbedJob, completeEmbedJob, failEmbedJob, resetStalledEmbedJobs, reviveFailedEmbedJobs,
  currentEmbedWorkEpoch, waitForEmbedWork, wakeEmbedWorkers, isTransientEmbedError,
} from './embed-queue.js';
import { SERVER_VERSION } from '../util/server-version.js';
import { embedStoredRecord } from './embed-record.js';
import { getConfig } from '../config/loader.js';
import { log, peerText } from '../util/log.js';
import { storedFailureText } from './store-failure.js';

/** Idle sleep. Work announces itself, so this is only the backstop for a missed announcement. */
const IDLE_POLL_MS = 30_000;
/** A claimed job with no sign of life for this long is assumed dead and returned to the pool. */
const STALL_TIMEOUT_MS = 120_000;
/** How often to sweep for stalled jobs while running. */
const STALL_SWEEP_MS = 60_000;

let running = false;
let stopping = false;
let stallTimer: NodeJS.Timeout | null = null;

function spaceIds(): string[] {
  // Proxy spaces hold no records of their own — their members do — so they are never probed.
  return getConfig().spaces.filter(s => !s.proxyFor).map(s => s.id);
}

/**
 * Run one job if there is one. Returns whether anything was claimed, so the loop knows to go straight
 * round again rather than sleep. Exported for the tests, which drive it directly instead of racing a
 * background loop — a test that sleeps until a worker happens to have run is a test that flakes.
 */
export async function runOneEmbedJob(): Promise<boolean> {
  const job = await claimNextEmbedJob(spaceIds());
  if (!job) return false;

  try {
    // `gone` is a success: the record was deleted between the enqueue and the claim, so nothing is
    // owed. Retrying would keep a job alive for a document that will never come back.
    await embedStoredRecord(job.spaceId, job.recordType, job.recordId);
    // Under the claim this worker holds (`Q-249`): a rewrite meanwhile re-queued the job, and its job must survive.
    await completeEmbedJob(job.spaceId, job.recordType, job.recordId, job.claimToken);

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
    //
    // What is STORED is what `GET …/embedding-queue/records` and `list_embed_jobs` serve to a read token: a driver's
    // message names the host, the port and the namespace, so a failure on the store's side is stored as our sentence and
    // the error's class (`storedFailureText`), and our own error keeps its message (`Q-361`).
    await failEmbedJob(job.spaceId, job.recordType, job.recordId, job.attempts, storedFailureText(err, 'embed a record'),
      job.transientFailures ?? 0, job.claimToken, isTransientEmbedError(msg));
    // debug, not warn: an embedder that is down produces one of these per queued record, and a
    // thousand warnings say nothing the first one did not. The failed count is the signal.
    log.debug(`Embed job ${peerText(job._id)} in ${peerText(job.spaceId)} failed (attempt ${job.attempts}): ${peerText(msg)}`);
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
      log.warn(`Brain embedding worker: claim failed: ${peerText(err)}`);
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

  // Anything left `processing` by a previous process is dead by definition — nothing survives a
  // restart holding a claim. Sweeping at startup with a zero timeout returns them immediately rather
  // than making the first records of the new run wait out the stall window.
  void resetStalledEmbedJobs(spaceIds(), 0).catch(err =>
    log.warn(`Brain embedding worker: startup stall sweep failed: ${err}`));

  // One clean attempt per VERSION for anything that went terminally `failed` under an older one. A systemic
  // outage — an embedder unreachable for a quarter of an hour during an upgrade — spends every job's whole
  // attempt budget at once, and a terminal job is never claimed again. Reported from a live instance:
  // "after updating all space indexing failed and since has not been retried automatically."
  // Logged at INFO with a count, because a silent mass requeue is indistinguishable from nothing happening.
  void reviveFailedEmbedJobs(spaceIds(), SERVER_VERSION)
    .then(n => { if (n > 0) log.info(`Brain embedding worker: re-queued ${n} job(s) that failed under an earlier version (now ${SERVER_VERSION})`); })
    .catch(err => log.warn(`Brain embedding worker: startup revive sweep failed: ${err}`));

  stallTimer = setInterval(() => {
    void resetStalledEmbedJobs(spaceIds(), STALL_TIMEOUT_MS).catch(err =>
      log.warn(`Brain embedding worker: stall sweep failed: ${err}`));
  }, STALL_SWEEP_MS);
  if (typeof stallTimer.unref === 'function') stallTimer.unref();

  void loop();
}

export function stopBrainEmbeddingWorker(): void {
  stopping = true;
  if (stallTimer) { clearInterval(stallTimer); stallTimer = null; }
  // Wake the sleeper so shutdown is not delayed by a full idle interval.
  wakeEmbedWorkers();
}
