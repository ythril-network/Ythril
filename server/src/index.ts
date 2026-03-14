import { createServer } from 'http';
import os from 'os';
import { configExists, loadConfig, loadSecrets } from './config/loader.js';
import { connectMongo, closeMongo } from './db/mongo.js';
import { initAllSpaces } from './spaces/spaces.js';
import { createApp } from './app.js';
import { generateSetupCode } from './setup/routes.js';
import { startSyncScheduler, stopSyncScheduler } from './sync/engine.js';
import { log } from './util/log.js';

const PORT = Number(process.env['PORT'] ?? 3200);

async function main(): Promise<void> {
  const isFirstRun = !configExists();

  if (isFirstRun) {
    const code = generateSetupCode();
    log.info('──────────────────────────────────────────────');
    log.info('  ythril — First-run setup required');
    log.info(`  Setup code: ${code}`);
    log.info('  Navigate to http://localhost:' + PORT + '/setup');
    log.info('──────────────────────────────────────────────');
  } else {
    loadConfig();
    loadSecrets();

    // TLS warning: if non-loopback binding and plaintext allowed
    const { getConfig } = await import('./config/loader.js');
    const cfg = getConfig();
    if (cfg.allowInsecurePlaintext) {
      const ifaces = Object.values(os.networkInterfaces()).flat();
      const hasExternal = ifaces.some(
        iface => iface && !iface.internal && iface.family === 'IPv4',
      );
      if (hasExternal) {
        log.warn('');
        log.warn('  ⚠  WARNING: allowInsecurePlaintext is true and this host has external');
        log.warn('     network interfaces. All traffic (including tokens) is unencrypted.');
        log.warn('     Deploy behind TLS termination (Nginx/Caddy/ingress) in production.');
        log.warn('');
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
    log.info(`ythril server listening on port ${PORT}`);
    if (isFirstRun) {
      log.info(`Open http://localhost:${PORT}/setup to complete setup`);
    }
  });

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    log.info(`${signal} received — shutting down`);
    stopSyncScheduler();
    server.close(() => log.info('HTTP server closed'));
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
