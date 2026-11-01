import { createServer } from 'http';
import { configExists, getConfig, loadConfig, loadSecrets, loadSchemaLibrary, getMongoUri, flushConfig, migrateStateFilesAtRest, requireEncryptedAtRest, atRestEncryptionActive } from './config/loader.js';
import { runShutdown } from './shutdown.js';
import { configureConnections } from './http-connections.js';
import { connectMongo, checkVectorSearchAvailability } from './db/mongo.js';
import { createApp } from './app.js';
import { startConfiguredInstanceServices } from './bootstrap.js';
import { markListening } from './util/after-listening.js';
import { startChunkCleanup } from './files/chunk-cleanup-job.js';
import { log, redactSecrets, peerText } from './util/log.js';
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

    // And instance admins stored without their space-admin floor (S-11): without it they reach only the spaces they
    // have rows for.
    {
      const { migrateInstanceAdminFloor } = await import('./config/migrate-instance-admin-floor.js');
      if (migrateInstanceAdminFloor(getConfig().tokens).granted.length > 0) flushConfig();
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
      // The one-time tombstone re-reads still owed, counted from the config at scrape time — the same reason, the same shape.
      {
        const { setRereadsOwedProvider } = await import('./metrics/registry.js');
        const { rereadsOwed } = await import('./sync/deletion-authority.js');
        const { getConfig } = await import('./config/loader.js');
        setRereadsOwedProvider(() => rereadsOwed(getConfig()));
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

  /*
   * What every brain write accepts is derived from its paired MCP tool's schema (`contract/write-accepts.ts`), and the derivation THROWS
   * when an operation has no tool or declares nothing. Forced here, after the tool registry is built and before the server listens, on a
   * first-run start as well (it needs no config), so a broken derivation stops the boot instead of answering the first write of that
   * kind with a 500.
   */
  const { warmAcceptedWriteKeys } = await import('./contract/write-accepts.js');
  warmAcceptedWriteKeys();

  const app = createApp();
  const server = createServer(app);
  configureConnections(server);

  // Periodic stale-chunk cleanup (every hour), a job `files/chunk-cleanup-job.ts` owns and `runShutdown` stops with the other jobs.
  startChunkCleanup();

  server.listen(PORT, () => {
    // Work the bootstrap held for the listen (`util/after-listening.ts`) starts now.
    markListening();
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

  // The shutdown sequence lives in `shutdown.ts`, where a test can run it; this only starts it. It ends the process itself (`exit`), and a
  // second signal while it runs does nothing.
  process.on('SIGTERM', () => void runShutdown({ signal: 'SIGTERM', server }));
  process.on('SIGINT', () => void runShutdown({ signal: 'SIGINT', server }));

  // Crash handlers — catch unhandled rejections/exceptions so they are logged
  // instead of silently killing the process.
  // Both write to the console as well as the ring buffer on purpose: a dying process may never have
  // its buffer read. Both go through redactSecrets first — an unhandled fetch rejection quotes the
  // endpoint it failed on, and that endpoint may carry a credential in its userinfo or query string.
  process.on('unhandledRejection', (reason, promise) => {
    log.error(`Unhandled rejection at: ${peerText(promise)}, reason:`, reason);
    console.error(redactSecrets(`UNHANDLED REJECTION: ${String(reason)}`));
  });
  process.on('uncaughtException', (err) => {
    log.error('Uncaught exception:', err);
    console.error(redactSecrets(`UNCAUGHT EXCEPTION: ${err.stack ?? String(err)}`));
    process.exit(1);
  });
}

main().catch(err => {
  console.error(redactSecrets(`Fatal startup error: ${err?.stack ?? String(err)}`));
  process.exit(1);
});
