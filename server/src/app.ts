import { ReferenceRefusal } from './brain/entity-refs.js';
import express from 'express';
import compression from 'compression';
import { shouldCompress, staticCacheControl } from './util/transfer.js';
import { importDocuments, importPayloadError } from './api/admin-import.js';
import { SERVER_VERSION } from './util/server-version.js';
import path from 'path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'url';
import { tokensRouter } from './api/tokens.js';
import { brainRouter } from './api/brain/index.js';
import { spacesRouter } from './api/spaces.js';
import { spaceSchemaLayersRouter } from './api/space-schema-layers.js';
import { fileStoreRouter } from './api/files.js';
import { toolsRouter } from './api/tools.js';
import { conflictsRouter } from './api/conflicts.js';
import { duplicatesRouter } from './api/duplicates.js';
import { contradictionsRouter } from './api/contradictions.js';
import { syncRouter } from './api/sync/index.js';
import { editorScopeFor } from './auth/editor-scope.js';
import { planSpaceWipe, notifyPeersOfWipe } from './spaces/wipe-vote.js';
import { networksRouter } from './api/networks/index.js';
import { notifyRouter } from './api/notify.js';
import { inviteRouter } from './api/invite.js';
import { mfaRouter } from './api/mfa.js';
import { aboutRouter } from './api/about.js';
import { oidcRouter } from './api/oidc.js';
import { metricsRouter } from './api/metrics.js';
import { themeRouter } from './api/theme.js';
import { frameAncestorsDirective } from './config/embed.js';
import { requireEncryptedTransport } from './config/transport-security.js';
import { auditRouter } from './api/audit.js';
import { setupRouter } from './setup/routes.js';
import { mcpRouter } from './mcp/router.js';
import { buildMcpOAuthRouter } from './mcp/oauth.js';
import { auditMiddleware } from './audit/middleware.js';
import { webhooksRouter } from './api/webhooks.js';
import { schemaLibraryRouter } from './api/schema-library.js';
import { localAgentRouter } from './api/local-agent.js';
import { dataRouter } from './api/data.js';
import { mediaConfigRouter } from './api/media-config.js';
import { embedConfigRouter } from './api/embed-config.js';
import { modelVerifyRouter } from './api/model-verify.js';
import { pipelineStatusRouter } from './api/pipeline-status.js';
import { spaceActivityRouter } from './api/space-activity.js';
import { maintenanceMiddleware } from './maintenance.js';
import { globalRateLimit, ipFloodBackstop } from './rate-limit/middleware.js';
import { configExists, reloadConfig, getConfig, saveConfig, loadSecrets, startConfigWatcher } from './config/loader.js';
import { requireAuth, requireAdminMfa, requireAdminMfaScoped } from './auth/middleware.js';
import { clearTokenCache } from './auth/tokens.js';
import { clearOidcCache } from './auth/oidc.js';
import { initSpace, ensureGeneralSpace, wipeSpace, reconcilePendingSpaceOp, WIPE_COLLECTION_TYPES, type WipeCollectionType } from './spaces/lifecycle.js';
import { col, asFilter, asDoc } from './db/mongo.js';
import { log, runWithRequestId } from './util/log.js';
import { rearmCronSchedulers } from './schedulers.js';
import { getReadiness, classifyCheckError } from './ready.js';
import { isShuttingDown } from './lifecycle.js';
import {
  httpRequestsTotal,
  httpRequestDurationSeconds,
  httpRequestSizeBytes,
  httpResponseSizeBytes,
  configReloadFailedTotal,
  configReloadPending,
} from './metrics/registry.js';
import { spaceCollection } from './db/space-collection.js';

// Server version — one reader, in `util/server-version.ts`. This file and `api/about.ts` each resolved
// their own path to the same manifest; a third reader (the embed-job revive) is what made the duplication
// worth removing rather than copying again.
const _serverVersion: string = SERVER_VERSION;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** Path to the compiled Angular SPA — configurable via env for Docker flexibility */
const clientDist =
  process.env['CLIENT_DIST'] ??
  path.resolve(__dirname, '..', '..', 'client', 'dist', 'browser');

/**
 * Resolve the Express `trust proxy` setting from the TRUST_PROXY env var (takes
 * precedence) or `config.trustProxy`. Defaults to `false` so a directly-exposed
 * deployment derives `req.ip` from the socket, not a spoofable X-Forwarded-For.
 */
function resolveTrustProxy(): boolean | number | string {
  let raw: unknown = process.env['TRUST_PROXY'];
  if (raw === undefined) {
    try { raw = getConfig().trustProxy; } catch { raw = undefined; } // config not loaded on first run
  }
  if (raw === undefined || raw === null || raw === false || raw === '') return false;
  if (raw === true) return true;
  if (typeof raw === 'number') return raw;
  if (Array.isArray(raw)) return raw.join(',');
  if (typeof raw === 'string') {
    const s = raw.trim();
    if (s === 'true') return true;
    if (s === 'false' || s === '') return false;
    if (/^\d+$/.test(s)) return Number(s);
    return s; // 'loopback' or a comma-separated CIDR/IP list — Express parses these
  }
  return false;
}

export function createApp() {
  const app = express();

  // ── Proxy trust ──────────────────────────────────────────────────────────
  // Default false: the server is exposed directly in the default deployment, so
  // req.ip must come from the socket. Trusting a client-supplied X-Forwarded-For
  // would let an attacker spoof the IP that rate limiting and the audit log key
  // on — bypassing the only throttle in front of admin TOTP. Set trustProxy to
  // the exact hop count only when a known reverse proxy terminates connections.
  const trustProxy = resolveTrustProxy();
  app.set('trust proxy', trustProxy);
  if (trustProxy === true) {
    log.warn('trust proxy = true trusts the ENTIRE X-Forwarded-For chain (client-spoofable). Set it to the exact proxy hop count instead.');
  } else {
    log.debug(`trust proxy = ${JSON.stringify(trustProxy)}`);
  }

  // ── Response compression ─────────────────────────────────────────────────
  //
  // Measured before it was added: `client/dist/browser` is 5.83 MiB of JS/CSS/HTML and 1.64 MiB gzipped —
  // 72%, or 4.19 MiB per cold load — and API list responses compress in the same range on every interaction.
  // Nothing was compressed at all, and there is no reverse proxy to assume: in this product the Node process
  // IS the web server.
  //
  // First in the chain, because it wraps `res.write`/`res.end` for everything downstream. The filter is
  // `shouldCompress` (see `util/transfer.ts`) — an event stream must NOT be compressed or it stops being
  // live, and that failure is invisible to any test that only asks whether the event eventually arrived.
  app.use(compression({
    filter: (req, res) => shouldCompress(req, res, compression.filter),
  }));

  // ── Request body parsers ─────────────────────────────────────────────────
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true, limit: '10mb' }));

  // ── Security headers ─────────────────────────────────────────────────────
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // Use CSP frame-ancestors instead of X-Frame-Options: DENY.
    // 'self' allows same-origin iframing (required for OIDC silent refresh
    // and postMessage-based theming) while blocking cross-origin clickjacking.
    // Any origin the operator explicitly opted into via `embed.allowedOrigins`
    // is appended — that is the ONLY way a cross-origin portal may frame Ythril.
    // object-src 'none' disables Flash/plugin content (OWASP baseline).
    // base-uri 'self' prevents <base href> injection in any XSS context.
    res.setHeader(
      'Content-Security-Policy',
      // `font-src 'self'` is the enforcement half of self-hosting the UI font. The client used to fetch Inter from
      // a font CDN on every page load, and nothing here stopped it: there was no font-src, and `Referrer-Policy`
      // hides the referring page but not the IP. A self-hosted admin UI must not tell a third party who is
      // looking at it, and an air-gapped install must not depend on a route it does not have.
      //
      // Deliberately NOT adding `style-src`: Angular injects inline styles, so that directive would need
      // `'unsafe-inline'` to be correct and would then assert nothing. One narrow directive that actually holds
      // beats a broad one written to be satisfied.
      `frame-ancestors ${frameAncestorsDirective()}; object-src 'none'; base-uri 'self'; font-src 'self'`,
    );
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
  });

  // ── Request ID ───────────────────────────────────────────────────────────
  app.use((_req, res, next) => {
    const id = crypto.randomUUID();
    res.setHeader('X-Request-Id', id);
    /*
     * `next()` inside the async context, so every log line written while handling this request carries the id
     * the caller was given. It used to reach exactly one line — the unhandled-error handler — which meant an
     * operator handed a request id could only find it if the failure was an unhandled exception. Every HANDLED
     * failure, which is most of them, logged with nothing to join on.
     *
     * Mounted here, above every route, so it covers REST and `/mcp` alike: MCP is an express router on this
     * same app, and an MCP call is exactly the case where "which request produced this line" is hardest to
     * answer by eye, because a model makes many of them quickly.
     *
     * The id is no longer also parked on `req`. Nothing read it — the response carries the header and the log
     * carries the ambient value — and a property with one writer and no reader is the shape that gets
     * re-implemented by whoever needs it next, because a grep for it finds only its own assignment.
     */
    runWithRequestId(id, next);
  });

  // ── Health ───────────────────────────────────────────────────────────────
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', ts: new Date().toISOString() });
  });

  // ── Readiness ────────────────────────────────────────────────────────────
  app.get('/ready', async (_req, res) => {
    // Not-ready the instant a shutdown signal lands, before anything is torn down — so the orchestrator
    // takes this instance out of rotation while it can still serve what it already has. Checked ahead
    // of the dependency probes because it is decisive and free: a draining instance is not ready even
    // if MongoDB is perfectly healthy. See `lifecycle.ts` for why liveness deliberately stays 200.
    if (isShuttingDown()) {
      res.status(503).json({ ready: false, shuttingDown: true, checks: {} });
      return;
    }
    try {
      const result = await getReadiness();
      res.status(result.ready ? 200 : 503).json(result);
    } catch (err) {
      // A code, not the message. This endpoint is public by necessity — an orchestrator cannot carry a token —
      // and driver messages name internal hosts and addresses (`getaddrinfo ENOTFOUND mongo-a.internal`). The
      // detail is logged instead, which is also where it was missing entirely before. See `ready.ts`.
      log.error(`Readiness check itself failed: ${err instanceof Error ? err.message : String(err)}`);
      res.status(503).json({
        ready: false,
        checks: {
          mongodb: { status: 'error', reason: classifyCheckError(err) },
          vectorSearch: { status: 'error', reason: 'error' },
        },
      });
    }
  });

  // ── Prometheus metrics ───────────────────────────────────────────────────
  // Requires auth: Bearer METRICS_TOKEN (if configured) or a valid admin PAT.
  app.use('/metrics', metricsRouter);

  // ── Encrypted-transport enforcement (opt-in, instance-wide) ──────────────
  // When `requireEncryptedTransport` is set, every request past this point must have arrived over
  // TLS. `req.secure` reflects X-Forwarded-Proto only once `trust proxy` is configured (set above), so
  // a reverse proxy that terminates TLS MUST have trustProxy set or every request looks plaintext.
  // `/health`, `/ready`, and `/metrics` are registered ABOVE this gate, so orchestration probes remain
  // reachable over plaintext. Read live (not captured) so a config reload takes effect.
  app.use((req, res, next) => {
    if (!requireEncryptedTransport() || req.secure) { next(); return; }
    res.status(403).json({ error: 'This instance accepts encrypted (HTTPS) connections only (requireEncryptedTransport).' });
  });

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

  // ── Flood backstop ───────────────────────────────────────────────────────
  // The per-route limiters key on the CLIENT (see rate-limit/middleware.ts), which is what stops one
  // busy client starving the others. That keying alone would let a flood of random bearer strings mint
  // an unbounded number of buckets, so this per-IP ceiling sits in front of everything as the outer
  // bound. It is set far above any legitimate single client and is invisible in normal operation.
  // Mounted after the probe/metrics routes above so /health, /ready and /metrics are never throttled.
  app.use(ipFloodBackstop);

  // ── Maintenance mode ─────────────────────────────────────────────────────
  // When active, blocks all API traffic except /health, /ready, /metrics and
  // the /api/admin/ prefix (so admins can still toggle maintenance off).
  app.use(maintenanceMiddleware);

  /**
   * Setup (first-run only) — JSON API, and NOTHING at `/setup`.
   *
   * `setupRouter` used to be mounted twice: here at `/api/setup`, which is what the SPA polls for
   * `configExists()`, and again at `/setup`, which served a server-rendered HTML form and `404`ed once the
   * instance was configured. Express matches a mount before the SPA's index fallback, so that second line
   * made the Angular `/setup` route unreachable — the legacy form was the LIVE first-run path and the SPA's
   * own page had never served one.
   *
   * It was kept "for non-SPA access" from before the SPA existed. Removing it is deprecation 1.5, and the
   * risk is the reason it waited: this is the unauthenticated boot path, and getting it wrong means an
   * instance nobody can set up. So the removal ships with an end-to-end first-run proof rather than on the
   * argument that the SPA route exists — it existed the whole time and was never reachable.
   */
  app.use('/api/setup', setupRouter);

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
  /*
   * THE TOOL DOOR: `POST /api/<tool-name>`, taking the tool's own arguments, dispatching through the same
   * `callTool` the MCP door uses.
   *
   * Mounted at `/api` itself, which makes its position load-bearing in one direction only. It declares
   * `/:tool` and therefore sees every single-segment `/api` path — but hands back anything that is not a
   * tool name, so the routers below still serve `POST /api/spaces` and the rest. What it must come BEFORE
   * is any future router that would claim a whole single segment a tool is named after; what it comes
   * after here (`/api/theme`, `/api/tokens`) is safe because no tool bears those names, and
   * `no-tool-name-shadows-a-mounted-router.test.js` is what keeps that true rather than this comment.
   */
  app.use('/api', toolsRouter);
  app.use('/api/brain', brainRouter);
  app.use('/api/spaces', spacesRouter);
  app.use('/api/spaces', spaceSchemaLayersRouter);  // F-39.3: schema layers and network precedence
  app.use('/api/files', fileStoreRouter);
  app.use('/api/conflicts', conflictsRouter);
  app.use('/api/duplicates', duplicatesRouter);
  app.use('/api/contradictions', contradictionsRouter);
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

  // MCP OAuth authorization server (metadata + authorize + token + register +
  // consent). Mounted at the application root because OAuth discovery endpoints
  // live under /.well-known and the grant endpoints are root-relative. Returns
  // null (and mounts nothing) when the issuer URL is unusable for OAuth, e.g. a
  // plaintext non-loopback publicUrl — the static bearer flow still works.
  {
    const oauthRouter = buildMcpOAuthRouter();
    if (oauthRouter) app.use(oauthRouter);
  }

  // ── Webhook management ─────────────────────────────────────────────────────
  app.use('/api/admin/webhooks', webhooksRouter);
  app.use('/api/admin/local-agent', localAgentRouter);
  app.use('/api/admin/data', dataRouter);
  app.use('/api/admin/media-config', mediaConfigRouter);
  // Mounted on the same path: Verify is the counterpart to test-connection, and an operator looking for
  // one should not have to know they live in different files.
  app.use('/api/admin/media-config', modelVerifyRouter);
  app.use('/api/admin/pipeline-status', pipelineStatusRouter);
  // Who may frame and restyle this instance. Admin-only by the same reasoning as the media config: the write is
  // security-relevant, and the public `GET /api/theme` is what an embedder reads to find out the answer.
  app.use('/api/admin/embed-config', embedConfigRouter);
  // Cross-space usage comparison. One request for the whole table — per-space calls from the Spaces page
  // would be a front-end N+1, sixty-five requests to render sixty-five rows.
  app.use('/api/admin/space-activity', spaceActivityRouter);
  app.use('/api/schema-library', schemaLibraryRouter);

  // ── Admin: space wipe ─────────────────────────────────────────────────────
  // Wipes data from a space while preserving the space itself and its configuration.
  // Pass an optional `types` array to wipe only specific collections; omit to wipe all.
  // Requires an admin-scoped token and respects TOTP if MFA is enabled.
  app.post('/api/admin/spaces/:spaceId/wipe', globalRateLimit, requireAdminMfaScoped('spaceId'), async (req, res) => {
    const spaceId = req.params['spaceId'] as string;
    const cfg = getConfig();
    if (!cfg.spaces.some(s => s.id === spaceId)) {
      res.status(404).json({ error: `Space '${spaceId}' not found` });
      return;
    }
    // Optional `types` body parameter — validate each value.
    const rawTypes = req.body?.types;
    if (rawTypes !== undefined) {
      if (!Array.isArray(rawTypes) || rawTypes.some((t: unknown) => !WIPE_COLLECTION_TYPES.includes(t as WipeCollectionType))) {
        res.status(400).json({
          error: `'types' must be an array of: ${WIPE_COLLECTION_TYPES.join(', ')}`,
        });
        return;
      }
    }
    // X-5: on a space that belongs to a network, emptying it is a governed act and opens a vote instead of
    // happening now. A space in no network is unaffected — `planSpaceWipe` says which, and the same planner
    // answers for the `delete_space_data` tool so the two doors cannot drift.
    const plan = planSpaceWipe(spaceId, rawTypes);
    if (plan.governed) {
      notifyPeersOfWipe(spaceId, rawTypes);
      res.status(202).json({ status: 'vote_pending', rounds: plan.rounds });
      return;
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
  // Returns a full JSON snapshot of the space — all facts, entities, edges,
  // chrono entries, and file metadata (binary file content excluded by default).
  // Vector embeddings are omitted from the export to keep the payload small;
  // run POST /api/brain/spaces/:spaceId/reindex after import to rebuild them.
  app.get('/api/admin/spaces/:spaceId/export', globalRateLimit, requireAdminMfaScoped('spaceId'), async (req, res) => {
    const spaceId = req.params['spaceId'] as string;
    const cfg = getConfig();
    const space = cfg.spaces.find(s => s.id === spaceId);
    if (!space) {
      res.status(404).json({ error: `Space '${spaceId}' not found` });
      return;
    }

    // Stream the export instead of buffering it (P7).
    //
    // This used to `.toArray()` all five collections in parallel and then `res.json()` the
    // result — so the whole space sat on the heap TWICE (the documents, plus their serialised
    // JSON string) at once. A 100k-fact space OOM'd the backup endpoint, exactly when losing
    // data hurts most. We now walk each collection's cursor and write documents out one at a
    // time, respecting backpressure so the response buffer cannot grow unbounded either.
    //
    // The OUTPUT SHAPE is byte-for-byte identical to before — same object, same keys, same
    // order — so the import side and every existing consumer are untouched. (NDJSON would be
    // cleaner but would break the import contract; not worth it for the fact win.)
    const projection = { embedding: 0 };

    // Backpressure-aware write: pause the cursor walk when the socket buffer is full.
    const write = (chunk: string): Promise<void> =>
      res.write(chunk) ? Promise.resolve() : new Promise<void>(resolve => res.once('drain', resolve));

    /** Stream one collection as a JSON array value: `[doc, doc, …]`. */
    const streamArray = async (collName: string): Promise<void> => {
      await write('[');
      const cursor = col(collName).find({}, { projection });
      let first = true;
      for await (const doc of cursor) {
        await write((first ? '' : ',') + JSON.stringify(doc));
        first = false;
      }
      await write(']');
    };

    try {
      res.status(200);
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      // Envelope fields first — JSON.stringify each value so escaping is correct.
      await write(
        '{' +
        `"exportedAt":${JSON.stringify(new Date().toISOString())},` +
        `"spaceId":${JSON.stringify(spaceId)},` +
        `"spaceName":${JSON.stringify(space.label)},` +
        `"version":${JSON.stringify(_serverVersion)},`,
      );
      await write('"facts":'); await streamArray(spaceCollection(spaceId, 'facts'));
      await write(',"entities":'); await streamArray(spaceCollection(spaceId, 'entities'));
      await write(',"edges":'); await streamArray(spaceCollection(spaceId, 'edges'));
      await write(',"chrono":'); await streamArray(spaceCollection(spaceId, 'chrono'));
      await write(',"files":'); await streamArray(spaceCollection(spaceId, 'files'));
      await write('}');
      res.end();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!res.headersSent) {
        res.status(500).json({ error: msg });
      } else {
        // We have already sent `200` and a partial body, so we cannot change the status.
        // Destroy the socket so the client sees a TRUNCATED/aborted response rather than a
        // syntactically-valid JSON that is silently missing documents.
        log.error(`Space export for '${spaceId}' failed mid-stream: ${msg}`);
        res.destroy(err instanceof Error ? err : new Error(msg));
      }
    }
  });

  // ── Admin: space import ───────────────────────────────────────────────────
  // Upserts all documents from an export payload into the target space.
  // Existing documents with the same _id are replaced; new ones are inserted.
  // Returns per-type counts: { inserted, updated, errors }.
  app.post('/api/admin/spaces/:spaceId/import', globalRateLimit, requireAdminMfaScoped('spaceId'), async (req, res) => {
    const spaceId = req.params['spaceId'] as string;
    const cfg = getConfig();
    if (!cfg.spaces.some(s => s.id === spaceId)) {
      res.status(404).json({ error: `Space '${spaceId}' not found` });
      return;
    }

    /*
     * The body of this route lives in `api/admin-import.ts` now.
     *
     * It was inline here and did `replaceOne` on arbitrary documents: no validation, no embed job, so a
     * restored backup was stored and invisible to meaning-ranked search. Moving it out is what let it be
     * exercised against a real database without an HTTP server — what is left here is argument handling and
     * a status code.
     */
    const payload = (req.body ?? {}) as Record<string, unknown>;
    const shapeError = importPayloadError(payload);
    if (shapeError) { res.status(400).json({ error: shapeError }); return; }

    res.json(await importDocuments(spaceId, payload));
  });

  // ── Admin: config reload ───────────────────────────────────────────────────────────────
  // Reload config.json from disk without a container restart.  Useful when the
  // operator edits config.json directly or when integration tests inject new
  // settings.  Requires a valid Bearer PAT (same auth as all other API routes).
  //
  // Also runs automatically when the file changes on disk (see startConfigWatcher
  // below): an operator's edit is otherwise reverted by the next config write, and
  // reloading is only half the job — a space added by hand still needs initialising.
  // Both paths therefore go through this one function rather than the watcher doing
  // a bare re-parse.
  async function applyConfigFromDisk(): Promise<void> {
    const oldSpaceIds = new Set(getConfig().spaces.map(s => s.id));
    reloadConfig();
    loadSecrets(); // Also reload secrets.json (peer tokens injected by tests/scripts)
    // Prefix-less (legacy) tokens are NOT stripped — findMatchingToken()
    // verifies them via a fallback scan and backfills the prefix on first use.
    // Flush caches so revoked tokens and updated OIDC config take effect immediately
    clearTokenCache();
    clearOidcCache();
    // Ensure the built-in general space survives config edits
    await ensureGeneralSpace();
    // Complete any space rename/delete interrupted by a crash whose marker is
    // present in the (re)loaded config. Idempotent and a no-op without a marker;
    // gives operators a restart-free way to finish a stuck op. Runs before the
    // new-space init below so a rename isn't shadowed by re-creating its old id.
    await reconcilePendingSpaceOp();
    // Initialise any spaces that were added to the config file
    const newCfg = getConfig();
    for (const space of newCfg.spaces) {
      if (!oldSpaceIds.has(space.id) && !space.proxyFor) {
        await initSpace(space.id);
      }
    }
    /*
     * Re-arm the schedulers whose cron expression is captured at START time — the sync engine, the duplicate
     * scanner, the contradiction scanner.
     *
     * Without this, reloading a config that changed `dupeScanner.schedule` left the scanner on its boot-time
     * schedule, and ENABLING a scanner that was off did nothing at all until the instance was restarted. This
     * function is reached by the config watcher AND by `POST /api/admin/reload-config`, which answered
     * `{ ok: true }` — an endpoint whose entire purpose is "apply what I just changed", reporting success
     * without applying it.
     *
     * Last in the reload, deliberately: a scheduler re-armed before `initSpace` could fire against a space that
     * does not exist yet. See `schedulers.ts` for why the interval-driven sweeps are NOT re-armed here.
     */
    await rearmCronSchedulers();
  }

  /*
   * The watcher's outcome reaches the metrics from HERE, not from the loader (`Q-43`).
   *
   * `registry.ts` reaches the config loader through `quota` and `db/mongo`, so the loader importing it
   * would close a runtime import cycle. The composition root has both in scope already, which is what a
   * composition root is for.
   */
  startConfigWatcher(() => applyConfigFromDisk(), undefined, applied => {
    if (applied) { configReloadPending.set(0); return; }
    configReloadFailedTotal.inc();
    configReloadPending.set(1);
  });
  app.post('/api/admin/reload-config', globalRateLimit, requireAdminMfa, async (_req, res) => {
    try {
      await applyConfigFromDisk();
      res.json({ ok: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  // ── Admin: rotate the instance signing keypair ───────────────────────────
  // Generates a new Ed25519 governance-signing keypair and a continuity proof
  // signed by the old key. Peers that pinned the old key adopt the new one via
  // gossip; the new public key propagates on the next sync cycle. Requires an
  // unrestricted admin token (+ TOTP when MFA is enabled).
  app.post('/api/admin/rotate-signing-key', globalRateLimit, requireAdminMfa, async (req, res) => {
    // "Unrestricted" FROM THE MATRIX, and from nothing else — `editorScopeFor` returns `undefined` for a
    // token that reaches everything and a list for one that does not, and `[]` for a token with no matrix
    // at all.
    //
    // This line said *"with the legacy allowlist only as a fallback"*, directly above the paragraph
    // explaining that reading the allowlist WAS the defect. There is no fallback: it was removed with the
    // rest of them, and the same sentence had to be corrected on `api/brain/search.ts` in the same sweep.
    //
    // This tested `req.authToken?.spaces` for truthiness, and that array is `undefined` on every token
    // minted since the matrix. So a space-restricted administrator whose scope lives in `rights` read as
    // unrestricted here and could rotate the INSTANCE signing key — the credential every peer pins.
    if (editorScopeFor(req.authToken) !== undefined) {
      res.status(403).json({ error: 'Signing-key rotation requires an unrestricted admin token' });
      return;
    }
    try {
      const { rotateInstanceKeypair } = await import('./util/signing.js');
      const result = rotateInstanceKeypair();
      if (!result) {
        res.status(409).json({ error: 'Instance not initialised' });
        return;
      }
      res.json({ ok: true, signingPublicKey: result.publicKeyPem });
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
  // Content-hashed chunks are cached for a year and immutable; everything else — index.html above all, and
  // the unhashed `assets/i18n/*.json` — is `no-cache`, which still allows a 304 but never a stale read. The
  // rule lives in `staticCacheControl` because getting it backwards pins a browser to chunk hashes that no
  // longer exist, which is exactly the failure the fallback comment below describes.
  app.use(express.static(clientDist, {
    setHeaders: (res, filePath) => { res.setHeader('Cache-Control', staticCacheControl(filePath)); },
  }));

  // ── SPA fallback — return index.html for unmatched NAVIGATION requests ────
  //
  // The fallback deliberately does NOT cover build assets. Every Angular build rehashes its lazy-chunk
  // filenames, so a browser that still holds a pre-update `main-*.js` will ask for a `chunk-*.js` that no
  // longer exists. Answering that with index.html means the browser requested JavaScript and received
  // HTML: the module import fails with an opaque "error loading dynamically imported module", the route
  // click does nothing, and nothing on either side can tell a stale build from a real page. (That is
  // exactly how it presented in practice — a dead click with no network entry and no message.)
  //
  // A missing asset is a 404. The client turns that into a one-shot reload; see the chunk-load recovery
  // in the Angular app config.
  const ASSET_REQUEST = /\.(?:js|mjs|css|map|json|woff2?|ttf|eot|svg|png|jpe?g|gif|webp|avif|ico)$/i;
  app.get('/{*path}', (req, res, next) => {
    if (ASSET_REQUEST.test(req.path)) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
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
  app.use((err: unknown, req: express.Request, res: express.Response, _next: express.NextFunction) => {
    // Propagate HTTP-level errors from body-parser (e.g. 413 Payload Too Large)
    if (err && typeof err === 'object' && 'status' in err && typeof (err as { status: unknown }).status === 'number') {
      const httpErr = err as { status: number; message: string };
      const s = httpErr.status;
      const status = (s >= 400 && s < 600) ? s : 500;
      res.status(status).json({ error: httpErr.message ?? 'Request error' });
      return;
    }
    /*
     * A REFERENCE REFUSAL IS THE CALLER'S FAULT, and it reaches here rather than a route.
     *
     * The existence check for a link moved from the seven write doors into the writers — which is what
     * made it true of `linkEntities` as well as of the 4.x arrays it guarded. Express 5 forwards a
     * rejected handler here, so a caller naming a record that does not exist got **500 Internal server
     * error** where they used to get a `400` naming the id. A refusal that reads as a server fault is
     * worse than the silent write it replaced: there is nothing in it to act on.
     *
     * Answered HERE and not per door on purpose. Seven branches are seven chances for the next door to
     * be written without one, and the symptom is a 500 on the path nobody exercised.
     */
    if (err instanceof ReferenceRefusal) {
      res.status(400).json({ error: err.message });
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    /*
     * The id is no longer spelled out here: every line emitted during a request carries it now, so writing it
     * again produced it twice on the one line that already had it.
     */
    log.error(`Unhandled error: ${message}`);
    res.status(500).json({ error: 'Internal server error' });
  });

  void globalRateLimit; // imported for side-effect registration reference

  return app;
}
