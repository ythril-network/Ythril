/**
 * Process lifecycle state, in one place both the shutdown handler and the readiness probe can see.
 *
 * ## Why readiness has to fail BEFORE the drain starts
 *
 * `#537` made shutdown await `server.close()`, so in-flight requests finish before the database
 * connection drops. That fixed the requests already running. It did not stop NEW ones arriving.
 *
 * `server.close()` refuses new *connections*, but a load balancer or ingress holding an established
 * keep-alive connection keeps using it — and keeps getting `200` from `/ready`, because the probe only
 * knew about MongoDB. So during the drain window the instance advertises itself as healthy, receives
 * work it is about to stop doing, and those requests die at `process.exit`.
 *
 * The standard sequence, and the one this enables:
 *
 *   1. SIGTERM → **mark not-ready**, so the orchestrator takes this instance out of rotation;
 *   2. wait long enough for it to notice (`SHUTDOWN_READY_GRACE_MS`);
 *   3. only then stop accepting and drain what is left.
 *
 * Skipping step 1 is what turns a rolling update into a handful of dropped requests per instance.
 *
 * ## Liveness is deliberately NOT affected
 *
 * `/health` keeps returning `200` throughout. Liveness answers "is this process wedged, should it be
 * killed?" — and during a graceful stop the answer is no, it is doing exactly what it was asked. A
 * liveness probe that fails on SIGTERM invites the orchestrator to SIGKILL the process mid-drain, which
 * is the opposite of the intent.
 */

let shuttingDown = false;
let shutdownController = new AbortController();

/** True once a shutdown signal has been received. Readiness reports not-ready from this moment. */
export function isShuttingDown(): boolean {
  return shuttingDown;
}

/**
 * Aborted when shutdown begins: a sync turn's fetches take it beside their own timeout (`turnSignal`, `sync/held-answer.ts`), so a batch fetch of up
 * to a minute ends at once instead of outliving the drain (bundle-39 D5 v6 S2). It is its OWN signal, never the act fence's: an abort here is read as
 * shutdown (`stopKindOfThrow`, `sync/arrival-stop.ts`), never as an act cutting a space.
 */
export function shutdownSignal(): AbortSignal {
  return shutdownController.signal;
}

/** Called by the signal handler, before anything is torn down. Idempotent. */
export function beginShutdown(): void {
  shuttingDown = true;
  if (!shutdownController.signal.aborted) shutdownController.abort(new Error('shutting down'));
}

/** Test-only: restore the initial state between cases. */
export function resetLifecycleForTests(): void {
  shuttingDown = false;
  shutdownController = new AbortController();
}
