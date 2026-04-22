import express from 'express';
import path from 'path';
import fs from 'node:fs';
import crypto from 'node:crypto';
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
import { aboutRouter } from './api/about.js';
import { oidcRouter } from './api/oidc.js';
import { metricsRouter } from './api/metrics.js';
import { themeRouter } from './api/theme.js';
import { auditRouter } from './api/audit.js';
import { setupRouter } from './setup/routes.js';
import { mcpRouter } from './mcp/router.js';
import { auditMiddleware } from './audit/middleware.js';
import { webhooksRouter } from './api/webhooks.js';
import { schemaLibraryRouter } from './api/schema-library.js';
import { localAgentRouter } from './api/local-agent.js';
import { globalRateLimit } from './rate-limit/middleware.js';
import { configExists, reloadConfig, getConfig, saveConfig, loadSecrets } from './config/loader.js';
import { requireAuth, requireAdminMfa } from './auth/middleware.js';
import { clearTokenCache } from './auth/tokens.js';
import { clearOidcCache } from './auth/oidc.js';
import { initSpace, ensureGeneralSpace, wipeSpace, WIPE_COLLECTION_TYPES } from './spaces/spaces.js';
import { col } from './db/mongo.js';
import { log } from './util/log.js';
import { getReadiness } from './ready.js';
import {
  httpRequestsTotal,
  httpRequestDurationSeconds,
  httpRequestSizeBytes,
  httpResponseSizeBytes,
} from './metrics/registry.js';

// Server version — read once at startup from the package.json that sits two
// directories up from the compiled output (server/dist → server → root).
const _pkgPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
const _serverVersion: string = JSON.parse(fs.readFileSync(_pkgPath, 'utf8')).version;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** Path to the compiled Angular SPA — configurable via env for Docker flexibility */
const clientDist =
  process.env['CLIENT_DIST'] ??
  path.resolve(__dirname, '..', '..', 'client', 'dist', 'browser');

export function createApp() {
  const app = express();

  // ── Proxy trust ──────────────────────────────────────────────────────────
  // Trust the first proxy hop (Traefik / nginx) so req.ip reflects the real
  // client address.  Without this, rate-limit and audit log all share the
  // Docker-gateway IP.
  app.set('trust proxy', 1);

  // ── Request body parsers ─────────────────────────────────────────────────
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true, limit: '10mb' }));

  // ── Security headers ─────────────────────────────────────────────────────
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // Use CSP frame-ancestors instead of X-Frame-Options: DENY.
    // 'self' allows same-origin iframing (required for OIDC silent refresh
    // and postMessage-based theming) while blocking cross-origin clickjacking.
    // object-src 'none' disables Flash/plugin content (OWASP baseline).
    // base-uri 'self' prevents <base href> injection in any XSS context.
    res.setHeader('Content-Security-Policy', "frame-ancestors 'self'; object-src 'none'; base-uri 'self'");
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
  });

  // ── Request ID ───────────────────────────────────────────────────────────
  app.use((req, res, next) => {
    const id = crypto.randomUUID();
    req.requestId = id;
    res.setHeader('X-Request-Id', id);
    next();
  });

  // ── Health ───────────────────────────────────────────────────────────────
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', ts: new Date().toISOString() });
  });

  // ── Readiness ────────────────────────────────────────────────────────────
  app.get('/ready', async (_req, res) => {
    try {
      const result = await getReadiness();
      res.status(result.ready ? 200 : 503).json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(503).json({
        ready: false,
        checks: {
          mongodb: { status: 'error', error: message },
          vectorSearch: { status: 'error', error: 'check skipped' },
        },
      });
    }
  });

  // ── Prometheus metrics ───────────────────────────────────────────────────
  // Requires auth: Bearer METRICS_TOKEN (if configured) or a valid admin PAT.
  app.use('/metrics', metricsRouter);

  // ── HTTP request instrumentation ─────────────────────────────────────────
  // Runs after /health and /metrics so those internal endpoints aren't tracked.
  app.use((req, res, next) => {
    const start = process.hrtime.bigint();
    const reqSize = parseInt(req.headers['content-length'] ?? '0', 10) || 0;

    res.on('finish', () => {
      // Use the Express route pattern if matched; fall back to normalised path.
      const route = (req.route?.path as string | undefined)
        ?? req.path.replace(/\/[0-9a-f-]{8,}/gi, '/:id');
      const method = req.method;
      const statusCode = String(res.statusCode);
      const durationSec = Number(process.hrtime.bigint() - start) / 1e9;
      const resSize = parseInt(res.getHeader('content-length') as string ?? '0', 10) || 0;

      httpRequestsTotal.inc({ method, route, status_code: statusCode });
      httpRequestDurationSeconds.observe({ method, route }, durationSec);
      if (reqSize > 0) httpRequestSizeBytes.observe({ method, route }, reqSize);
      if (resSize > 0) httpResponseSizeBytes.observe({ method, route }, resSize);
    });

    next();
  });

  // ── Audit log middleware ────────────────────────────────────────────────
  // Captures audit entries for every authenticated API request.
  // Runs after metrics so durationMs is accurate; before routes so it sees
  // the 'finish' event for every response.
  app.use(auditMiddleware);

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
  app.use('/api/theme', themeRouter);   // public — no auth required
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
  app.use('/api/about', aboutRouter);
  app.use('/api/auth', oidcRouter);
  app.use('/api/admin/audit-log', auditRouter);

  // ── MCP endpoints ────────────────────────────────────────────────────────
  app.use('/mcp', mcpRouter);

  // ── Webhook management ─────────────────────────────────────────────────────
  app.use('/api/admin/webhooks', webhooksRouter);
  app.use('/api/admin/local-agent', localAgentRouter);
  app.use('/api/schema-library', schemaLibraryRouter);

  // ── Admin: space wipe ─────────────────────────────────────────────────────
  // Wipes data from a space while preserving the space itself and its configuration.
  // Pass an optional `types` array to wipe only specific collections; omit to wipe all.
  // Requires an admin-scoped token and respects TOTP if MFA is enabled.
  app.post('/api/admin/spaces/:spaceId/wipe', globalRateLimit, requireAdminMfa, async (req, res) => {
    const spaceId = req.params['spaceId'] as string;
    const cfg = getConfig();
    if (!cfg.spaces.some(s => s.id === spaceId)) {
      res.status(404).json({ error: `Space '${spaceId}' not found` });
      return;
    }
    // Optional `types` body parameter — validate each value.
    const rawTypes = req.body?.types;
    if (rawTypes !== undefined) {
      if (!Array.isArray(rawTypes) || rawTypes.some((t: unknown) => !WIPE_COLLECTION_TYPES.includes(t as never))) {
        res.status(400).json({
          error: `'types' must be an array of: ${WIPE_COLLECTION_TYPES.join(', ')}`,
        });
        return;
      }
    }
    try {
      const deleted = await wipeSpace(spaceId, rawTypes);
      res.json({ deleted });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  // ── Admin: space export ───────────────────────────────────────────────────
  // Returns a full JSON snapshot of the space — all memories, entities, edges,
  // chrono entries, and file metadata (binary file content excluded by default).
  // Vector embeddings are omitted from the export to keep the payload small;
  // run POST /api/brain/spaces/:spaceId/reindex after import to rebuild them.
  app.get('/api/admin/spaces/:spaceId/export', globalRateLimit, requireAdminMfa, async (req, res) => {
    const spaceId = req.params['spaceId'] as string;
    const cfg = getConfig();
    const space = cfg.spaces.find(s => s.id === spaceId);
    if (!space) {
      res.status(404).json({ error: `Space '${spaceId}' not found` });
      return;
    }

    try {
      // Fetch all documents in parallel, stripping the embedding vector to keep the
      // payload manageable. embeddingModel is retained so the import consumer knows
      // what model was in use before the wipe.
      const projection = { embedding: 0 } as never;
      const [memories, entities, edges, chrono, files] = await Promise.all([
        col(`${spaceId}_memories`).find({}, { projection }).toArray(),
        col(`${spaceId}_entities`).find({}, { projection }).toArray(),
        col(`${spaceId}_edges`).find({}, { projection }).toArray(),
        col(`${spaceId}_chrono`).find({}, { projection }).toArray(),
        col(`${spaceId}_files`).find({}, { projection }).toArray(),
      ]);

      res.json({
        exportedAt: new Date().toISOString(),
        spaceId,
        spaceName: space.label,
        version: _serverVersion,
        memories,
        entities,
        edges,
        chrono,
        files,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  // ── Admin: space import ───────────────────────────────────────────────────
  // Upserts all documents from an export payload into the target space.
  // Existing documents with the same _id are replaced; new ones are inserted.
  // Returns per-type counts: { inserted, updated, errors }.
  app.post('/api/admin/spaces/:spaceId/import', globalRateLimit, requireAdminMfa, async (req, res) => {
    const spaceId = req.params['spaceId'] as string;
    const cfg = getConfig();
    if (!cfg.spaces.some(s => s.id === spaceId)) {
      res.status(404).json({ error: `Space '${spaceId}' not found` });
      return;
    }

    const payload = req.body ?? {};
    const IMPORT_TYPES = ['memories', 'entities', 'edges', 'chrono', 'files'] as const;
    type ImportType = typeof IMPORT_TYPES[number];

    // Validate that each supplied array is actually an array of objects.
    for (const t of IMPORT_TYPES) {
      if (payload[t] !== undefined) {
        if (!Array.isArray(payload[t])) {
          res.status(400).json({ error: `'${t}' must be an array` });
          return;
        }
      }
    }

    const results: Record<ImportType, { inserted: number; updated: number; errors: number }> = {
      memories: { inserted: 0, updated: 0, errors: 0 },
      entities: { inserted: 0, updated: 0, errors: 0 },
      edges: { inserted: 0, updated: 0, errors: 0 },
      chrono: { inserted: 0, updated: 0, errors: 0 },
      files: { inserted: 0, updated: 0, errors: 0 },
    };

    for (const t of IMPORT_TYPES) {
      const docs: unknown[] = Array.isArray(payload[t]) ? payload[t] : [];
      if (docs.length === 0) continue;

      const collName = `${spaceId}_${t}`;
      const result = results[t];

      for (const doc of docs) {
        if (!doc || typeof doc !== 'object' || !('_id' in doc) || typeof (doc as Record<string, unknown>)['_id'] !== 'string') {
          result.errors++;
          continue;
        }
        // Extract and coerce the _id to a plain string to prevent any operator injection.
        const docId = String((doc as Record<string, unknown>)['_id']);
        try {
          const r = await col(collName).replaceOne(
            { _id: docId } as never,
            doc as never,
            { upsert: true },
          );
          if (r.upsertedCount > 0) {
            result.inserted++;
          } else {
            result.updated++;
          }
        } catch {
          result.errors++;
        }
      }
    }

    log.info(
      `Import into space '${spaceId}': ` +
      IMPORT_TYPES.map(t => `${t}: +${results[t].inserted} ~${results[t].updated} !${results[t].errors}`).join(', '),
    );
    res.json({ spaceId, results });
  });

  // ── Admin: config reload ───────────────────────────────────────────────────────────────
  // Reload config.json from disk without a container restart.  Useful when the
  // operator edits config.json directly or when integration tests inject new
  // settings.  Requires a valid Bearer PAT (same auth as all other API routes).
  app.post('/api/admin/reload-config', globalRateLimit, requireAdminMfa, async (_req, res) => {
    try {
      const oldSpaceIds = new Set(getConfig().spaces.map(s => s.id));
      reloadConfig();
      loadSecrets(); // Also reload secrets.json (peer tokens injected by tests/scripts)
      // Migration: strip prefix-less tokens (same as startup migration)
      {
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
      // Flush caches so revoked tokens and updated OIDC config take effect immediately
      clearTokenCache();
      clearOidcCache();
      // Ensure the built-in general space survives config edits
      await ensureGeneralSpace();
      // Initialise any spaces that were added to the config file
      const newCfg = getConfig();
      for (const space of newCfg.spaces) {
        if (!oldSpaceIds.has(space.id) && !space.proxyFor) {
          await initSpace(space.id);
        }
      }
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
  app.use((err: unknown, req: express.Request, res: express.Response, _next: express.NextFunction) => {
    // Propagate HTTP-level errors from body-parser (e.g. 413 Payload Too Large)
    if (err && typeof err === 'object' && 'status' in err && typeof (err as { status: unknown }).status === 'number') {
      const httpErr = err as { status: number; message: string };
      const s = httpErr.status;
      const status = (s >= 400 && s < 600) ? s : 500;
      res.status(status).json({ error: httpErr.message ?? 'Request error' });
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    log.error(`Unhandled error [${req.requestId ?? '-'}]: ${message}`);
    res.status(500).json({ error: 'Internal server error' });
  });

  void globalRateLimit; // imported for side-effect registration reference

  return app;
}
