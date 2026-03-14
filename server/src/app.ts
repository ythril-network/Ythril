import express from 'express';
import { tokensRouter } from './api/tokens.js';
import { brainRouter } from './api/brain.js';
import { spacesRouter } from './api/spaces.js';
import { filesRouter } from './api/files.js';
import { conflictsRouter } from './api/conflicts.js';
import { syncRouter } from './api/sync.js';
import { networksRouter } from './api/networks.js';
import { notifyRouter } from './api/notify.js';
import { inviteRouter } from './api/invite.js';
import { brainUiRouter } from './brain-ui/routes.js';
import { setupRouter } from './setup/routes.js';
import { settingsRouter } from './settings/routes.js';
import { mcpRouter } from './mcp/router.js';
import { globalRateLimit } from './rate-limit/middleware.js';
import { configExists } from './config/loader.js';
import { log } from './util/log.js';

export function createApp() {
  const app = express();

  // ── Request body parsers ─────────────────────────────────────────────────
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true, limit: '10mb' }));

  // ── Security headers ─────────────────────────────────────────────────────
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
  });

  // ── Health ───────────────────────────────────────────────────────────────
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', ts: new Date().toISOString() });
  });

  // ── Setup (first-run only) ───────────────────────────────────────────────
  app.use('/setup', setupRouter);

  // ── Settings UI ──────────────────────────────────────────────────────────
  app.use('/settings', settingsRouter);

  // ── Brain UI ─────────────────────────────────────────────────────────────
  app.use('/brain', brainUiRouter);

  // ── Redirect bare root ───────────────────────────────────────────────────
  app.get('/', (_req, res) => {
    res.redirect(302, configExists() ? '/settings' : '/setup');
  });

  // ── API routes ───────────────────────────────────────────────────────────
  app.use('/api/tokens', tokensRouter);
  app.use('/api/brain', brainRouter);
  app.use('/api/spaces', spacesRouter);
  app.use('/api/files', filesRouter);
  app.use('/api/conflicts', conflictsRouter);
  app.use('/api/sync', syncRouter);
  app.use('/api/networks', networksRouter);
  app.use('/api/notify', notifyRouter);
  app.use('/api/invite', inviteRouter);

  // ── MCP endpoints ────────────────────────────────────────────────────────
  app.use('/mcp', mcpRouter);

  // ── 404 handler ──────────────────────────────────────────────────────────
  app.use((_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  // ── Global error handler ─────────────────────────────────────────────────
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const message = err instanceof Error ? err.message : String(err);
    log.error(`Unhandled error: ${message}`);
    res.status(500).json({ error: 'Internal server error' });
  });

  void globalRateLimit; // imported for side-effect registration reference

  return app;
}
