import { createServer } from 'http';
import { configExists, getConfig, loadConfig, loadSecrets, loadSchemaLibrary, getMongoUri, flushConfig, migrateStateFilesAtRest, requireEncryptedAtRest, atRestEncryptionActive } from './config/loader.js';
import { beginShutdown } from './lifecycle.js';
import { connectMongo, closeMongo, checkVectorSearchAvailability } from './db/mongo.js';
import { createApp } from './app.js';
import { startConfiguredInstanceServices } from './bootstrap.js';
import { stopSyncScheduler } from './sync/scheduler.js';
import { stopBackupScheduler } from './db/backup-scheduler.js';
import { stopDupeScanner } from './brain/dupe-scanner.js';
import { cleanupStaleChunks } from './files/chunks.js';
import { log, redactSecrets } from './util/log.js';
import { envInt, assertNumericEnvOrExit } from './config/env-num.js';
import { assertNoRemovedEnvVarsOrExit } from './config/env-removed.js';

// Enable debug logging when --debug flag is passed or DEBUG env is already set.
if (process.argv.includes('--debug')) {
  process.env['DEBUG'] = '1';
}

const PORT = envInt('PORT', 3200);

// ANSI helpers — no-op when stdout is not a TTY (e.g. piped logs)
const isTTY = process.stdout.isTTY;
const BOLD   = isTTY ? '\x1b[1m'           : '';
const ORANGE = isTTY ? '\x1b[38;5;208m'    : '';
const GREEN  = isTTY ? '\x1b[32m'          : '';
const YELLOW = isTTY ? '\x1b[33m'          : '';
const RESET  = isTTY ? '\x1b[0m'           : '';

async function main(): Promise<void> {
  // Before anything else, including reading the config file: a malformed numeric setting stops the boot.
  //
  // These used to be `Number(process.env[X])` with no check, so a typo (`8OOO` with letter O, `30_000`, `5s`)
  // became NaN — and NaN does not fail, it silently changes behaviour. Measured: a NaN `SHUTDOWN_DRAIN_MS` makes
  // `setTimeout` fire after 0 ms, so the graceful drain does not drain; a NaN `MONGO_CONNECT_RETRY_MS` makes the
  // retry budget comparison false, so there are zero retries. Both are documented guarantees, lost in silence.
  // Same choice the at-rest encryption already makes: refuse to start rather than continue wrongly.
  assertNumericEnvOrExit();
  // And the same choice for a variable whose NAME is gone rather than whose value is wrong: a removed
  // name that is still set configures nothing, so the built-in default takes its place silently.
  assertNoRemovedEnvVarsOrExit();

  const isFirstRun = !configExists();

  if (!isFirstRun) {
    // At-rest encryption (PR-S2): if a master secret is configured, transparently encrypt any
    // still-plaintext state file in place BEFORE loading (round-trip verified; no plaintext left).
    migrateStateFilesAtRest();

    loadConfig();

    /*
     * And the one word in the config that 5.0 renamed. `recordTtlDays: { memory: 30 }` is a retention
     * window, and after the type became `fact` the key is unread — so the records it governed would be
     * kept for ever, with no error, no warning and no metric to say so.
     *
     * AFTER `loadConfig()`, not before: it rewrites what is already in memory, so reading the config
     * first is not an ordering preference — `getConfig()` throws when nothing has been loaded, which is
     * a boot that never reaches the migration it was added for.
     */
    {
      const { migrateMemoryToFact } = await import('./config/migrate-memory-to-fact.js');
      const moved = migrateMemoryToFact(getConfig().spaces);
      if (moved.ttlWindows.length > 0) flushConfig();
    }

    /*
     * And the tokens that administered a space under the rule 5.0 replaced.
     *
     * Space admin is its own grant now and the four area rungs no longer add up to it — so a token that
     * manages its space's tokens and settings today would quietly stop, with nothing failing and nothing
     * to read. This writes down the decision those grants already expressed.
     */
    {
      const { migrateSpaceAdminGrant } = await import('./config/migrate-space-admin-grant.js');
      const granted = migrateSpaceAdminGrant(getConfig().tokens);
      if (granted.granted.length > 0) flushConfig();
    }
    loadSecrets();
    loadSchemaLibrary();

    // Strict mode: refuse to boot if encryption-at-rest is required but no master secret is set.
    if (requireEncryptedAtRest() && !atRestEncryptionActive()) {
      console.error(
        `\n${YELLOW}  ✗ FATAL${RESET}  requireEncryptedAtRest is set but no master secret is configured.\n` +
        `     Set YTHRIL_MASTER_KEY (32 bytes, base64/hex) or YTHRIL_MASTER_PASSPHRASE, or disable\n` +
        `     requireEncryptedAtRest. Refusing to start with unencrypted state files.\n`,
      );
      process.exit(1);
    }

    // NOTE: tokens created before the `prefix` field existed are NOT deleted.
    // findMatchingToken() verifies them via a fallback bcrypt scan and backfills
    // the prefix on first use (self-healing migration), so upgrading no longer
    // silently invalidates existing PATs.

    // Ensure this instance has a persistent Ed25519 signing keypair for governance
    // vote signatures. Generated once (no-op on subsequent boots).
    {
      const { ensureInstanceKeypair } = await import('./util/signing.js');
      ensureInstanceKeypair();
    }

    // Aggregate security-posture report (PR-S3): one PASS/WARN/FAIL view over transport (S1), at-rest
    // (S2), and MongoDB auth. Advisory by default; `security.strict` aborts boot on any FAIL.
    {
      const { computeSecurityPosture, formatPostureLines, securityStrict } = await import('./config/security-posture.js');
      // The same findings, countable on /metrics, so a fleet does not learn about a misconfigured instance
      // by someone reading its boot log. Registered here rather than imported inside `registry.ts`, which
      // nearly every module pulls in — see `setPostureProvider`. Re-computed per scrape, never cached: the
      // posture depends on config that a running instance can change.
      {
        const { setPostureProvider } = await import('./metrics/registry.js');
        setPostureProvider(() => computeSecurityPosture().checks);
      }
      const posture = computeSecurityPosture();
      const issues = posture.checks.filter(c => c.level !== 'pass');
      if (issues.length === 0) {
        console.log(`  ${GREEN}✓${RESET} security posture: all checks passed`);
      } else {
        console.warn(`\n${YELLOW}  security posture — review the following:${RESET}`);
        for (const line of formatPostureLines({ checks: issues, worst: posture.worst })) console.warn(line);
        console.warn('');
      }
      if (securityStrict() && posture.worst === 'fail') {
        console.error(`  ${YELLOW}✗ FATAL${RESET}  security.strict is on and the posture has FAIL findings above. Refusing to start.\n`);
        process.exit(1);
      }
    }
  }

  // Always connect to MongoDB — needed on first run so the setup route can
  // initialise the general space immediately after writing the config.
  await connectMongo();

  /*
   * BEFORE ANY SERVICE READS A COLLECTION. 5.0 renamed the knowledge type `fact` to `fact`, and a
   * collection is named after its type — so an instance that skipped this would look for
   * `<space>_facts`, not find it, create an empty one, and report zero facts in a space holding
   * thousands. Nothing would error: reading a collection that does not exist is an empty result, which
   * is the same shape as a space nobody has written to.
   *
   * Safe as a BOOT migration, where a synced-content migration would have to be lazy: this renames a
   * container and touches no document, so every `_id`, field and hash is unchanged and a peer cannot
   * write the old shape back. The wire format changing in the same release is protected separately, by
   * the peer floor refusing anything below 5.0.0 at the handshake.
   */
  {
    const { renameMemoriesToFacts } = await import('./db/rename-memories-to-facts.js');
    await renameMemoriesToFacts();
    // AFTER the collections move, and it is a second migration because it answers a different question: the
    // collection rename fixes where a fact is STORED, this fixes every id derived from the word `fact` —
    // an edge or link endpoint kind. Both are silent failures and neither implies the other.
    const { rekeyMemoryKindToFact } = await import('./db/rekey-memory-kind-to-fact.js');
    await rekeyMemoryKindToFact();

  }

  // Validate $vectorSearch support and log the result.
  {
    const uri = getMongoUri();
    const safeUri = uri.replace(/\/\/.*@/, '//[credentials]@');
    log.debug(`Checking $vectorSearch support on ${safeUri}`);
    const vsCheck = await checkVectorSearchAvailability();
    if (vsCheck.available) {
      console.log(`  ${GREEN}✓${RESET} $vectorSearch available (${vsCheck.details})`);
    } else {
      console.log(`  ${YELLOW}✗${RESET} $vectorSearch not available (${vsCheck.details}) — semantic search (recall) will be disabled`);
      console.log(`    Upgrade to MongoDB 8.2+, use Atlas Local, or connect to managed Atlas`);
    }
  }

  if (!isFirstRun) {
    /*
     * INSIDE the first-run guard, and that placement is the whole of a bug this caught.
     *
     * It sat beside the two collection renames above, which need no config and run unconditionally. This
     * one reads the space list, and on a FIRST RUN there is no config yet — so `getConfig()` threw
     * `Config not loaded` from outside the function's own try, and a fresh instance could not boot at
     * all. The module promises it cannot take a boot down; the promise was true of its body and false of
     * its first line.
     *
     * A first-run instance has no spaces and therefore nothing to convert, so the guard is also the
     * correct answer rather than only the safe one. `startConfiguredInstanceServices` is here for the
     * same reason and the setup route calls it once the config is written.
     *
     * AFTER the two renames, because it walks `<space>_facts` and the collections have to be under their
     * new names first. BEFORE the services, so nothing reads a space mid-conversion.
     */
    const { convertLinksOnBoot } = await import('./brain/links-convert-on-boot.js');
    await convertLinksOnBoot();

    /*
     * AFTER the conversion, and the ordering is load-bearing rather than tidy.
     *
     * The conversion READS the six retired link arrays to create the records that replace them. Clear them
     * first and an unconverted space loses the only copy of its pre-upgrade links — silently, because an
     * emptied array and a converted one look identical to everything downstream. This only touches spaces
     * the conversion has marked, and says which it left alone.
     */
    const { dropLinkArrays } = await import('./db/drop-link-arrays.js');
    await dropLinkArrays();

    // Initialise spaces/indexes and start all background services. On a FIRST-run
    // boot this is skipped (config isn't written yet) — the setup route calls the
    // same function once it writes the config, so a freshly set-up instance is fully
    // operational without a restart. See startConfiguredInstanceServices().
    await startConfiguredInstanceServices();
  }

  const { warnRateLimitBypass } = await import('./rate-limit/middleware.js');
  warnRateLimitBypass();

  // Surface an opted-in cross-origin embedding allowlist at boot — framing + theming
  // rights are being granted to those origins, so make that visible in the logs.
  if (!isFirstRun) {
    const { warnIfEmbeddingEnabled } = await import('./config/embed.js');
    warnIfEmbeddingEnabled();
  }

  const app = createApp();
  const server = createServer(app);

  // Periodic stale-chunk cleanup (every hour)
  const chunkCleanupInterval = setInterval(
    () => cleanupStaleChunks().catch(err => log.error(`Stale chunk cleanup failed: ${err}`)),
    60 * 60 * 1000,
  );
  chunkCleanupInterval.unref(); // don't block shutdown

  server.listen(PORT, () => {
    const url = `http://localhost:${PORT}`;
    console.log('');
    if (isFirstRun) {
      console.log(`  ${BOLD}ythril${RESET}  ·  first-run setup required`);
      console.log('');
      console.log(`  Open ${url} to get started`);
      console.log('');
    } else {
      console.log(`  ${BOLD}ythril${RESET}  ${GREEN}✓ ready${RESET}  ·  ${url}`);
      console.log('');
    }
  });

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

  let shuttingDown = false;

  /**
   * Graceful shutdown that actually drains.
   *
   * `server.close()` is asynchronous — it stops accepting new connections and calls back once the
   * existing ones have finished. It used to be called without being awaited, so the lines after it ran
   * immediately: Mongo was closed and `process.exit(0)` fired while requests were still running. A
   * container restart during a file upload or a brain write would tear the database connection out from
   * under it mid-write, and the process would report success on the way out.
   *
   * Now the close is awaited, bounded by DRAIN_MS. A connection that has not finished by then is forced
   * shut rather than allowed to hold the shutdown open — an idle keep-alive socket would otherwise keep
   * the process alive until the orchestrator SIGKILLs it, turning a graceful stop into a hard one.
   */
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;      // a second SIGTERM must not race the first through this
    shuttingDown = true;
    log.debug(`${signal} received — shutting down`);

    // Step one, before anything is torn down: stop advertising readiness, then give the orchestrator a
    // moment to notice and route elsewhere. Without this the drain below is only half the job — it
    // finishes the requests already running while new ones keep arriving over established keep-alive
    // connections, and those die at exit. Zero on a single-instance deployment, where there is no load
    // balancer to inform and the wait is pure delay.
    beginShutdown();
    if (READY_GRACE_MS > 0) await new Promise(r => setTimeout(r, READY_GRACE_MS));

    stopSyncScheduler();
    stopBackupScheduler();
    stopDupeScanner();
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
    const { stopRetryWorker } = await import('./webhooks/dispatcher.js');
    stopRetryWorker();

    await new Promise<void>(resolve => {
      const forced = setTimeout(() => {
        log.warn(`Shutdown: connections still open after ${DRAIN_MS}ms — closing them`);
        server.closeAllConnections();
        resolve();
      }, DRAIN_MS);
      forced.unref();
      server.close(() => { clearTimeout(forced); log.debug('HTTP server closed'); resolve(); });
    });

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
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  // Crash handlers — catch unhandled rejections/exceptions so they are logged
  // instead of silently killing the process.
  // Both write to the console as well as the ring buffer on purpose: a dying process may never have
  // its buffer read. Both go through redactSecrets first — an unhandled fetch rejection quotes the
  // endpoint it failed on, and that endpoint may carry a credential in its userinfo or query string.
  process.on('unhandledRejection', (reason, promise) => {
    log.error(`Unhandled rejection at: ${promise}, reason: ${reason}`);
    console.error(redactSecrets(`UNHANDLED REJECTION: ${String(reason)}`));
  });
  process.on('uncaughtException', (err) => {
    log.error(`Uncaught exception: ${err.stack ?? err}`);
    console.error(redactSecrets(`UNCAUGHT EXCEPTION: ${err.stack ?? String(err)}`));
    process.exit(1);
  });
}

main().catch(err => {
  console.error(redactSecrets(`Fatal startup error: ${err?.stack ?? String(err)}`));
  process.exit(1);
});
