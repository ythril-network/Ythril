/**
 * The shutdown sequence, as a function a test can run.
 *
 * ## Why it left `index.ts`
 *
 * It was the body of a closure inside `main()`, so the one property that matters — what is waited for, in what order, before the database closes — could
 * only be read from the source, never driven. Bundle-39 D5 added the wait for a sync cycle in flight, and a rule about an order is worth little if
 * nothing can run the order: `shutdown-lets-a-running-sync-stop-at-its-page-db` runs this function against the real engine with a page in flight.
 * `index.ts` calls it from its signal handlers and nothing else is different: the same steps, in the same order, with `server` and `exit` handed in.
 *
 * ## Order, and why
 *
 *  1. Not ready (`beginShutdown`), then the readiness grace. Beginning shutdown also ends what a sync turn does at its next page (`lifecycle.ts`).
 *  2. Scheduling closes, a reload in flight is waited for; then every job and worker is stopped, so nothing starts during the drain.
 *  3. The HTTP drain, and ALONGSIDE it the wait for sync cycles in flight: a running cycle stops at its next page and answers, bounded by
 *     {@link CYCLE_WAIT_MS} and never by more than the drain has left, so the two share one budget (Docker's 10 s stop grace) instead of adding up.
 *  4. The final flushes, the config, `closeMongo`, `exit`.
 */
import type { Server } from 'http';
import { getConfig, flushConfig } from './config/loader.js';
import { beginShutdown, isShuttingDown } from './lifecycle.js';
import { closeMongo } from './db/mongo.js';
import { stopSyncScheduler } from './sync/scheduler.js';
import { isNetworkSyncing, syncCyclesInFlight, syncCyclesSettled } from './sync/engine.js';
import { stopBackupScheduler } from './db/backup-scheduler.js';
import { stopDupeScanner } from './brain/dupe-scanner.js';
import { stopChunkCleanup } from './files/chunk-cleanup-job.js';
import { closeScheduling } from './schedulers.js';
import { log, peerText } from './util/log.js';
import { envInt } from './config/env-num.js';

/** What the sequence needs of the HTTP server: `index.ts` hands its `http.Server`, a test a stub. */
export type ShutdownServer = Pick<Server, 'close' | 'closeAllConnections'>;

export interface ShutdownOptions {
  /** The signal that began it, for the one debug line. */
  signal: string;
  server: ShutdownServer;
  /** Ends the process after the database closed. `process.exit` in production; a test hands a spy. */
  exit?: (code: number) => void;
}

/**
 * The most a shutdown waits for sync cycles in flight. A cycle stops at its NEXT page, so this is one page of one fetch and one write, not a cycle:
 * five seconds is far above a page on a healthy store and still inside the drain. Cut down to what the drain has left, never added to it.
 */
const CYCLE_WAIT_MS = 5_000;

/**
 * Wait, bounded, for the sync cycles running now to stop at their page and answer. A cycle that does not stop in time is named (by network) and
 * left: the database closing ends it, the page it was on is re-sent next cycle, and its mark has not passed that page.
 */
async function waitForSyncCycles(ms: number): Promise<void> {
  const running = syncCyclesInFlight();
  if (running === 0) return;
  log.info(`Shutdown: waiting up to ${ms}ms for ${running} sync cycle(s) to stop at their next page`);
  if ((await syncCyclesSettled(ms)).finished) return;
  const networks = getConfig().networks.filter(n => isNetworkSyncing(n.id)).map(n => `'${peerText(n.label)}'`);
  log.warn(`Shutdown: ${syncCyclesInFlight()} sync cycle(s) still running after ${ms}ms${networks.length > 0 ? ` (networks ${networks.join(', ')})` : ''}`
    + ' — ended by the database closing; the page each was on is re-sent next cycle');
}

/**
 * Graceful shutdown that actually drains.
 *
 * `server.close()` is asynchronous — it stops accepting new connections and calls back once the
 * existing ones have finished. It used to be called without being awaited, so the lines after it ran
 * immediately: Mongo was closed and `process.exit(0)` fired while requests were still running. A
 * container restart during a file upload or a brain write would tear the database connection out from
 * under it mid-write, and the process would report success on the way out.
 *
 * Now the close is awaited, bounded by `SHUTDOWN_DRAIN_MS`. A connection that has not finished by then is forced
 * shut rather than allowed to hold the shutdown open — an idle keep-alive socket would otherwise keep
 * the process alive until the orchestrator SIGKILLs it, turning a graceful stop into a hard one.
 *
 * Re-entrant-safe: a second signal while the first runs does nothing. The guard is the lifecycle's own flag, which `resetLifecycleForTests` restores,
 * so a test can run the sequence more than once in one process.
 */
export async function runShutdown(opts: ShutdownOptions): Promise<void> {
  const { signal, server } = opts;
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  if (isShuttingDown()) return;      // a second SIGTERM must not race the first through this
  log.debug(`${signal} received — shutting down`);

  // Both are read when the sequence runs, so a test sets them for its own process.
  /**
   * How long in-flight requests get to finish before they are cut off.
   *
   * Under Docker's default `stop` grace period the process is SIGKILLed 10 s after SIGTERM, so the
   * whole drain has to finish inside that or it accomplishes nothing. Eight seconds leaves room for the
   * config flush and the Mongo close that follow. Kubernetes' default is 30 s, so this is the tighter
   * of the two constraints; raise `SHUTDOWN_DRAIN_MS` if your orchestrator gives you longer.
   */
  const DRAIN_MS = envInt('SHUTDOWN_DRAIN_MS', 8_000);
  /**
   * How long to keep serving after readiness starts reporting false, before the drain begins.
   *
   * Long enough for an orchestrator's readiness probe to fire and take this instance out of rotation.
   * Kubernetes' default `periodSeconds` is 10, so a value below that means some probes never see the
   * change; 2 s is a compromise that helps a typical setup without stalling every restart. Set it to 0
   * on a single-instance deployment — there is no load balancer to inform, so the wait is pure delay.
   *
   * Comes out of the same budget as DRAIN_MS: both must fit inside the orchestrator's stop grace.
   */
  const READY_GRACE_MS = envInt('SHUTDOWN_READY_GRACE_MS', 2_000);

  // Step one, before anything is torn down: stop advertising readiness, then give the orchestrator a
  // moment to notice and route elsewhere. Without this the drain below is only half the job — it
  // finishes the requests already running while new ones keep arriving over established keep-alive
  // connections, and those die at exit. Zero on a single-instance deployment, where there is no load
  // balancer to inform and the wait is pure delay.
  beginShutdown();
  if (READY_GRACE_MS > 0) await new Promise(r => setTimeout(r, READY_GRACE_MS));

  // Before any stop below: the config watcher stops, a reload in flight is waited for, and cron arming closes, so nothing
  // re-arms a scheduler this handler stops (a reload during the drain used to re-arm three of them; `Q-570`). The direct
  // stops stay, one per module, because `every-started-job-is-stopped-at-shutdown` holds each module's stop to this handler.
  // The wait for a reload in flight comes OUT of the HTTP drain's budget, not on top of it: ready grace + drain is sized to the
  // orchestrator's stop grace (Docker's 10 s), and a wait added beside it would push the end past the SIGKILL.
  const settleStarted = Date.now();
  await closeScheduling({ withinMs: Math.min(2_000, DRAIN_MS) });
  const httpDrainMs = Math.max(0, DRAIN_MS - (Date.now() - settleStarted));
  stopSyncScheduler();
  stopBackupScheduler();
  stopDupeScanner();
  const { stopHorizonHoldWatchdog } = await import('./util/horizon-holds.js');
  stopHorizonHoldWatchdog();
  const { stopRoundExpiry } = await import('./networks/round-expiry.js');
  stopRoundExpiry();
  // The media worker was never stopped here, though `stopMediaEmbeddingWorker` exists and promises to
  // complete the in-flight batch. Without it the worker kept CLAIMING new jobs while the process drained —
  // a job picked up in the last second of life is abandoned instantly — and whatever it held died
  // `processing` with a live token, so the next boot waited out the full stall timeout before re-queuing it.
  const { stopMediaEmbeddingWorker } = await import('./files/media/worker.js');
  stopMediaEmbeddingWorker();
  // Same reasoning for the brain embedding worker: a job claimed while the process drains dies
  // `processing`, and the next boot waits out a stall timeout to rediscover it.
  const { stopBrainEmbeddingWorker } = await import('./brain/embed-worker.js');
  stopBrainEmbeddingWorker();
  const { stopRetryWorker, drainFirstDeliveries } = await import('./webhooks/dispatcher.js');
  stopRetryWorker();
  // The background check after a webhook delivery success: none starts from here on, so none lands after `closeMongo`.
  const { stopSuccessChecks } = await import('./webhooks/store.js');
  stopSuccessChecks();
  // Space acts: refused from now on, and nothing waits for one. Each is on disk, so it resumes after the next start; a body that
  // fails from here on (the store closes under it) records nothing.
  const { closeSpaceActs } = await import('./spaces/space-act-runner.js');
  const { left } = closeSpaceActs();
  if (left.length > 0) {
    log.info(`Shutdown: ${left.length} space act(s) not finished, resumed after the next start: `
      + left.map(a => `${a.kind} of '${peerText(a.localId)}' (${a.state})`).join(', '));
  }
  // First deliveries still waiting in the dispatcher's per-subscription queues were never attempted: written to the retry queue now,
  // while the database is open, so the next boot delivers them instead of losing them (Q-469). Events emitted from here on go there too.
  // Bounded by the shutdown's own drain budget (a database that stopped answering must cost the budget, not the orchestrator's kill), and
  // done again after the HTTP drain below: an event a request emitted while the server drained goes to the same rows.
  await drainFirstDeliveries({ withinMs: DRAIN_MS }).then(
    persisted => { if (persisted > 0) log.info(`Shutdown: ${persisted} queued webhook deliveries persisted for retry`); },
    err => log.warn(`Shutdown: persisting queued webhook deliveries failed: ${err instanceof Error ? err.message : String(err)}`));
  // The reindex watcher resumes a run whose lease is stale, which starts a sweep: not while the process drains.
  const { stopReindexWatcher } = await import('./brain/reindex.js');
  stopReindexWatcher();
  // Every other scheduled job (`every-started-job-is-stopped-at-shutdown` derives the set): a tick that starts while the HTTP
  // drain runs reaches into a database the shutdown is about to close, and a tick that lands late is a write racing `closeMongo`.
  // The TTL sweep, the candidate and tombstone prunes and the contradiction scanner exported a stop that nothing called.
  stopChunkCleanup();
  const { stopTtlSweep } = await import('./brain/ttl-sweep.js');
  stopTtlSweep();
  const { stopCandidatePrune } = await import('./brain/candidate-prune.js');
  stopCandidatePrune();
  const { stopViewSweep } = await import('./config/views-sweep-job.js');
  stopViewSweep();
  const { stopTombstonePrune } = await import('./brain/tombstone-prune.js');
  stopTombstonePrune();
  const { stopPositionsOwedJob } = await import('./sync/positions-owed.js');
  stopPositionsOwedJob();
  const { stopEdgeIdentityOwedJob } = await import('./spaces/edge-identity-owed.js');
  stopEdgeIdentityOwedJob();
  const { stopContradictionScanner } = await import('./brain/contradiction-scanner.js');
  stopContradictionScanner();
  const { stopAuditChangeRetention } = await import('./audit/change-retention.js');
  stopAuditChangeRetention();

  // The HTTP drain and the wait for sync cycles run side by side, so a cycle's one page costs no time the drain was not already spending; the
  // cycle wait is bounded by what the drain has left.
  await Promise.all([
    new Promise<void>(resolve => {
      const forced = setTimeout(() => {
        log.warn(`Shutdown: connections still open after ${httpDrainMs}ms — closing them`);
        server.closeAllConnections();
        resolve();
      }, httpDrainMs);
      forced.unref();
      server.close(() => { clearTimeout(forced); log.debug('HTTP server closed'); resolve(); });
    }),
    waitForSyncCycles(Math.min(CYCLE_WAIT_MS, httpDrainMs)),
  ]);
  // The final flush: what requests that finished during the drain above emitted is in the dispatcher's rows now, and `closeMongo` is
  // below. Before the inference stop, which is slower and has nothing to do with the retry queue.
  await drainFirstDeliveries({ withinMs: DRAIN_MS }).then(
    persisted => { if (persisted > 0) log.info(`Shutdown: ${persisted} more queued webhook deliveries persisted for retry`); },
    err => log.warn(`Shutdown: the final flush of the webhook retry queue failed: ${err instanceof Error ? err.message : String(err)}`));

  // The local embedding model lives in a child process. Drain the inference in flight (a request that was mid-embed
  // when the HTTP drain ended, or the brain worker's job) and end the process, rather than leaving it to notice that
  // its parent is gone. After the drain, so requests that embed can still finish; before `closeMongo`, because what
  // the worker does with an answer is a database write. Bounded: past the budget the child is killed.
  const { stopLocalInference } = await import('./brain/local-inference.js');
  await stopLocalInference({ budgetMs: 2_000 }).catch(err =>
    log.debug(`Shutdown: stopping the inference process failed: ${err instanceof Error ? err.message : String(err)}`));

  // Only now is nothing mid-request. Persist coalesced config writes (sync watermarks), then drop
  // the database connection.
  await flushConfig();
  // The last partial minute of per-space usefulness counters. After the drain, so calls that finished while
  // connections were closing are counted too — and before `closeMongo`, since this needs the connection.
  // Hand back any claim this process still holds, before the connection goes. A planned shutdown can say
  // what happened; stall recovery exists for when nobody can.
  const { releaseHeldJobs } = await import('./files/media/worker.js');
  await releaseHeldJobs().catch(err =>
    log.debug(`Shutdown: releasing held jobs failed: ${err instanceof Error ? err.message : String(err)}`));

  const { stopSpaceActivityFlush } = await import('./metrics/space-activity-store.js');
  await stopSpaceActivityFlush().catch(err =>
    log.debug(`Shutdown: space activity flush failed: ${err instanceof Error ? err.message : String(err)}`));
  await closeMongo();
  exit(0);
}
