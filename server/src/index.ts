import { createServer } from 'http';
import os from 'os';
import { configExists, loadConfig, loadSecrets, loadSchemaLibrary, getMongoUri } from './config/loader.js';
import { connectMongo, closeMongo, checkVectorSearchAvailability } from './db/mongo.js';
import { initAllSpaces } from './spaces/spaces.js';
import { resetStaleWatermarksIfNeeded } from './util/seq.js';
import { createApp } from './app.js';
import { startSyncScheduler, stopSyncScheduler } from './sync/engine.js';
import { cleanupStaleChunks } from './files/chunks.js';
import { log } from './util/log.js';

// Enable debug logging when --debug flag is passed or DEBUG env is already set.
if (process.argv.includes('--debug')) {
  process.env['DEBUG'] = '1';
}

const PORT = Number(process.env['PORT'] ?? 3200);

// ANSI helpers — no-op when stdout is not a TTY (e.g. piped logs)
const isTTY = process.stdout.isTTY;
const BOLD   = isTTY ? '\x1b[1m'           : '';
const ORANGE = isTTY ? '\x1b[38;5;208m'    : '';
const GREEN  = isTTY ? '\x1b[32m'          : '';
const YELLOW = isTTY ? '\x1b[33m'          : '';
const RESET  = isTTY ? '\x1b[0m'           : '';

async function main(): Promise<void> {
  const isFirstRun = !configExists();

  if (!isFirstRun) {
    loadConfig();
    loadSecrets();
    loadSchemaLibrary();

    // Migration: tokens created before the prefix field was introduced have no
    // prefix and cannot be looked up efficiently (nor can the prefix be
    // recomputed from the stored hash). Remove them now — holders must create
    // new tokens.
    {
      const { getConfig, saveConfig } = await import('./config/loader.js');
      const cfg = getConfig();
      const before = cfg.tokens.length;
      cfg.tokens = cfg.tokens.filter(t => t.prefix);
      if (cfg.tokens.length < before) {
        log.warn(
          `Removed ${before - cfg.tokens.length} token(s) that pre-date the ` +
          'prefix field and cannot be verified. Affected PAT holders must create new tokens.',
        );
        saveConfig(cfg);
      }
    }

    // TLS warning: if non-loopback binding and plaintext allowed
    const { getConfig } = await import('./config/loader.js');
    const cfg = getConfig();
    if (cfg.allowInsecurePlaintext) {
      const ifaces = Object.values(os.networkInterfaces()).flat();
      const hasExternal = ifaces.some(
        iface => iface && !iface.internal && iface.family === 'IPv4',
      );
      if (hasExternal) {
        console.warn(
          `\n${YELLOW}  ⚠  WARNING${RESET}  allowInsecurePlaintext is true and this host has external\n` +
          `     network interfaces. All traffic (including tokens) is unencrypted.\n` +
          `     Deploy behind TLS termination (Nginx/Caddy/ingress) in production.\n`,
        );
      }
    }
  }

  // Always connect to MongoDB — needed on first run so the setup route can
  // initialise the general space immediately after writing the config.
  await connectMongo();

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
    // Ensure the built-in general space exists even if config was manually
    // edited or a previous test run left it missing.  Must run BEFORE
    // initAllSpaces() so the general space collections get created.
    const { ensureGeneralSpace } = await import('./spaces/spaces.js');
    await ensureGeneralSpace();

    await initAllSpaces();

    // Initialise the audit log collection and indexes
    const { initAuditCollection } = await import('./audit/audit.js');
    await initAuditCollection();

    // Initialise webhook delivery indexes and start retry worker
    const { initWebhookDeliveryIndexes } = await import('./webhooks/store.js');
    await initWebhookDeliveryIndexes();
    const { startRetryWorker } = await import('./webhooks/dispatcher.js');
    startRetryWorker();

    await resetStaleWatermarksIfNeeded();
    startSyncScheduler();
    cleanupStaleChunks().catch(err => log.error(`Stale chunk cleanup failed: ${err}`));
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

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    log.debug(`${signal} received — shutting down`);
    stopSyncScheduler();
    const { stopRetryWorker } = await import('./webhooks/dispatcher.js');
    stopRetryWorker();
    server.close(() => log.debug('HTTP server closed'));
    await closeMongo();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  // Crash handlers — catch unhandled rejections/exceptions so they are logged
  // instead of silently killing the process.
  process.on('unhandledRejection', (reason, promise) => {
    log.error(`Unhandled rejection at: ${promise}, reason: ${reason}`);
    console.error('UNHANDLED REJECTION:', reason);
  });
  process.on('uncaughtException', (err) => {
    log.error(`Uncaught exception: ${err.stack ?? err}`);
    console.error('UNCAUGHT EXCEPTION:', err);
    process.exit(1);
  });
}

main().catch(err => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
