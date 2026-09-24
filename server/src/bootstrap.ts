import { log } from './util/log.js';

/**
 * Initialise space collections + indexes and start every background service a
 * configured instance needs: the webhook retry worker, sync scheduler, backup
 * scheduler, dedup scanner, stale-chunk cleanup, and the media embedding worker.
 *
 * Called from TWO places so a configured instance always ends up fully running:
 *   1. boot, when the config already exists (`!isFirstRun` in index.ts); and
 *   2. the setup route, immediately after a first-run instance is configured — so a
 *      freshly set-up instance is fully operational WITHOUT a process restart.
 *
 * A process is only ever one of those cases (a first-run boot skips this; the setup
 * route 404s once configured), so this runs exactly once per process. The config
 * must already be loaded before calling — every service below reads it.
 *
 * Structured in two phases on purpose: DB initialisation (phase 1) can hit a
 * transient error (e.g. a MongoDB replica-set election right after boot surfaces
 * "interrupted at shutdown"), and that must NOT stop the background workers (phase 2)
 * from starting. The workers tolerate a not-yet-ready DB — they retry and idle — and
 * the boot path re-runs phase 1 on the next restart, so a one-off phase-1 hiccup
 * self-heals while the instance stays operational in the meantime.
 */
export async function startConfiguredInstanceServices(): Promise<void> {
  // Peer tokens whose instance shares no network with us — left by handshakes that applied and never finalized,
  // before those tokens expired with their handshake. Local state, and `revokePeerCredentialsIfOrphaned` re-checks
  // membership before revoking anything, so a live peer is never touched.
  try {
    const { getConfig } = await import('./config/loader.js');
    const { orphanedPeerInstanceIds, revokePeerCredentialsIfOrphaned } = await import('./auth/tokens.js');
    for (const id of orphanedPeerInstanceIds(getConfig())) await revokePeerCredentialsIfOrphaned(id);
  } catch (err) {
    log.error(`Sweeping orphaned peer tokens failed: ${err}`);
  }

  // ── Phase 1: DB initialisation (best-effort) ──────────────────────────────
  try {
    // Ensure the built-in general space exists BEFORE initAllSpaces() so its
    // collections get created.
    const { ensureGeneralSpace, initAllSpaces, reconcilePendingSpaceOp } = await import('./spaces/lifecycle.js');
    await ensureGeneralSpace();
    // Complete any space rename/delete interrupted by a crash BEFORE initAllSpaces()
    // — otherwise init could recreate empty collections under the pre-rename id.
    await reconcilePendingSpaceOp();
    await initAllSpaces();

    const { initAuditCollection } = await import('./audit/audit.js');
    await initAuditCollection();

    const { initWebhookDeliveryIndexes } = await import('./webhooks/store.js');
    await initWebhookDeliveryIndexes();

    const { resetStaleWatermarksIfNeeded } = await import('./util/seq.js');
    await resetStaleWatermarksIfNeeded();

    // Per-space usefulness counters: the TTL index above all. An activity log without one becomes the largest
    // collection in the instance, which is the standard way a metrics table stops being worth having.
    const { ensureActivityIndexes } = await import('./metrics/space-activity-store.js');
    await ensureActivityIndexes();

  } catch (err) {
    log.error(`Instance DB initialisation failed (background services will still start): ${err}`);
  }

  // ── Phase 2: start background services (always) ───────────────────────────
  // Synchronous, non-throwing loop/timer starters that tolerate a not-yet-ready DB,
  // so they must start regardless of any phase-1 hiccup above.
  const { startRetryWorker } = await import('./webhooks/dispatcher.js');
  startRetryWorker();

  const { startSyncScheduler } = await import('./sync/scheduler.js');
  startSyncScheduler();
  const { startBackupScheduler } = await import('./db/backup-scheduler.js');
  startBackupScheduler();
  const { startDupeScanner } = await import('./brain/dupe-scanner.js');
  startDupeScanner();
  // Its own scheduler, not a rider on the dupe sweep: the contradiction pass may call an NLI model per
  // pair, so it has to be opted into separately. Without this the sweep only ever ran when an admin hit
  // POST /api/contradictions/scan by hand, which left the Review tab's Contradictions view permanently
  // empty on any instance nobody had poked manually.
  const { startContradictionScanner } = await import('./brain/contradiction-scanner.js');
  startContradictionScanner();
  const { startTtlSweep } = await import('./brain/ttl-sweep.js');
  startTtlSweep();
  // Read-path indexes for EVERY space, not only ones created after this release. `initSpace` runs for new
  // spaces only, so an index added there would reach the changelog and never the database an operator
  // already has. Idempotent — `createIndex` is a no-op when the index exists — and best-effort per space.
  const { ensureQueryIndexes } = await import('./spaces/ensure-query-indexes.js');
  void ensureQueryIndexes().then(n => { if (n > 0) log.debug(`Read-path indexes ensured (${n} calls)`); });
  // The per-space usefulness counters accumulate in memory at ~19 ns per request and are written down once a
  // minute — one upsert per space that was actually used, so the write cost does not scale with traffic. The
  // timer is unref'd, and `stopSpaceActivityFlush` on the shutdown path writes the last partial minute.
  const { startSpaceActivityFlush } = await import('./metrics/space-activity-store.js');
  startSpaceActivityFlush();
  // Housekeeping for review findings whose records are gone. Deliberately NOT hung off the duplicate or
  // contradiction scanner: both are off by default, so orphans would accumulate on exactly the instances
  // that never enabled them.
  const { startCandidatePrune } = await import('./brain/candidate-prune.js');
  startCandidatePrune();
  // Drops tombstones every peer has confirmed applying. Deliberately NOT hung off the sync engine: a space
  // with no peers never syncs, and that is precisely the space whose whole tombstone collection is droppable.
  const { startTombstonePrune } = await import('./brain/tombstone-prune.js');
  startTombstonePrune();
  // Redacts the `changes` payload on brain record-edit audit entries past their shorter retention.
  // The entry itself keeps `audit.retentionDays` — only the user content inside it expires early.
  const { startAuditChangeRetention } = await import('./audit/change-retention.js');
  startAuditChangeRetention();

  const { cleanupStaleChunks } = await import('./files/chunks.js');
  cleanupStaleChunks().catch(err => log.error(`Stale chunk cleanup failed: ${err}`));

  const { startMediaEmbeddingWorker } = await import('./files/media/worker.js');
  startMediaEmbeddingWorker();

  const { startBrainEmbeddingWorker } = await import('./brain/embed-worker.js');
  startBrainEmbeddingWorker();
}
