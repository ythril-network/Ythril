import { createServer } from 'http';
import os from 'os';
import { configExists, loadConfig, loadSecrets } from './config/loader.js';
import { connectMongo, closeMongo } from './db/mongo.js';
import { initAllSpaces } from './spaces/spaces.js';
import { createApp } from './app.js';
import { generateSetupCode } from './setup/routes.js';
import { startSyncScheduler, stopSyncScheduler } from './sync/engine.js';
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

  // Generate (and hold) setup code before any async work so it's in scope for
  // the listen banner. The code is ephemeral — generateSetupCode() stores it in
  // memory and clears it after the first successful POST /api/setup.
  const setupCode = isFirstRun ? generateSetupCode() : null;

  if (!isFirstRun) {
    loadConfig();
    loadSecrets();

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

  if (!isFirstRun) {
    await initAllSpaces();
    startSyncScheduler();
  }

  const app = createApp();
  const server = createServer(app);

  server.listen(PORT, () => {
    const url = `http://localhost:${PORT}`;
    console.log('');
    if (isFirstRun) {
      console.log(`  ${BOLD}ythril${RESET}  ·  first-run setup required`);
      console.log('');
      console.log(`  URL         ${url}`);
      console.log(`  Setup code  ${ORANGE}${setupCode}${RESET}`);
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
    server.close(() => log.debug('HTTP server closed'));
    await closeMongo();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch(err => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
