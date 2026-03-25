import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { tokensRouter } from './api/tokens.js';
import { brainRouter } from './api/brain.js';
import { spacesRouter } from './api/spaces.js';
import { filesRouter } from './api/files.js';
import { conflictsRouter } from './api/conflicts.js';
import { syncRouter } from './api/sync.js';
import { networksRouter } from './api/networks.js';
import { notifyRouter } from './api/notify.js';
import { inviteRouter } from './api/invite.js';
import { mfaRouter } from './api/mfa.js';
import { setupRouter } from './setup/routes.js';
import { mcpRouter } from './mcp/router.js';
import { globalRateLimit } from './rate-limit/middleware.js';
import { configExists, reloadConfig } from './config/loader.js';
import { requireAuth } from './auth/middleware.js';
import { log } from './util/log.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** Path to the compiled Angular SPA — configurable via env for Docker flexibility */
const clientDist =
  process.env['CLIENT_DIST'] ??
  path.resolve(__dirname, '..', '..', 'client', 'dist', 'browser');

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

  // ── Setup (first-run only) — JSON API ────────────────────────────────────
  app.use('/api/setup', setupRouter);
  app.use('/setup', setupRouter);  // legacy HTML form (kept for non-SPA access)

  // ── Settings UI ──────────────────────────────────────────────────────────
  // Served by the Angular SPA — no server-rendered HTML routes here.

  // ── Brain UI / File Manager ───────────────────────────────────────────────
  // Served by the Angular SPA — no server-rendered HTML routes here.

  // ── Redirect bare root ───────────────────────────────────────────────────
  // The Angular SPA handles all routing. The root redirect below is only a
  // safety fallback if the static middleware cannot find index.html.
  app.get('/', (_req, res) => {
    res.redirect(302, configExists() ? '/brain' : '/setup');
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
  app.use('/api/mfa', mfaRouter);

  // ── MCP endpoints ────────────────────────────────────────────────────────
  app.use('/mcp', mcpRouter);

  // ── Admin: config reload ───────────────────────────────────────────────────────────────
  // Reload config.json from disk without a container restart.  Useful when the
  // operator edits config.json directly or when integration tests inject new
  // settings.  Requires a valid Bearer PAT (same auth as all other API routes).
  app.post('/api/admin/reload-config', globalRateLimit, requireAuth, (_req, res) => {
    try {
      reloadConfig();
      res.json({ ok: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  // ── API 404 — must precede SPA fallback ─────────────────────────────────
  // Any /api/ path not matched by the routers above is an unknown endpoint.
  // Return JSON 404 here so the SPA fallback never swallows API typos.
  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  // ── Angular SPA — static assets ──────────────────────────────────────────
  // Serve the compiled Angular app. All non-API routes fall through to
  // index.html so Angular's client-side router handles navigation.
  app.use(express.static(clientDist));

  // ── SPA fallback — return index.html for all unmatched GET requests ───────
  app.get('/{*path}', (_req, res, next) => {
    const indexPath = path.join(clientDist, 'index.html');
    res.sendFile(indexPath, (err) => {
      if (err) next(); // fall through to 404 if index.html not built yet
    });
  });

  // ── 404 handler ──────────────────────────────────────────────────────────
  app.use((_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  // ── Global error handler ─────────────────────────────────────────────────
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    // Propagate HTTP-level errors from body-parser (e.g. 413 Payload Too Large)
    if (err && typeof err === 'object' && 'status' in err && typeof (err as { status: unknown }).status === 'number') {
      const httpErr = err as { status: number; message: string };
      res.status(httpErr.status).json({ error: httpErr.message ?? 'Request error' });
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    log.error(`Unhandled error: ${message}`);
    res.status(500).json({ error: 'Internal server error' });
  });

  void globalRateLimit; // imported for side-effect registration reference

  return app;
}
