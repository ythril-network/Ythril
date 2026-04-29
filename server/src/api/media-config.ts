/**
 * Admin media embedding configuration API.
 *
 *   GET  /api/admin/media-config   — return current config + lockedByInfra fields
 *   PATCH /api/admin/media-config  — update writable fields in config.json
 *
 * Fields supplied by env vars (listed in `lockedByInfra`) are returned as-is
 * but PATCH rejects attempts to overwrite them.
 */

import { Router } from 'express';
import { z } from 'zod';
import { getConfig, saveConfig, getMediaEmbeddingConfig, getSecrets, saveSecrets } from '../config/loader.js';
import { requireAdmin, requireAdminMfa } from '../auth/middleware.js';
import { globalRateLimit } from '../rate-limit/middleware.js';
import { isSsrfSafeUrl } from '../util/ssrf.js';
import { log } from '../util/log.js';

export const mediaConfigRouter = Router();

// Rate-limit applies to both methods. Auth differs by mutation level:
//   GET  → requireAdmin (read of (masked) config)
//   PATCH → requireAdminMfa (mutates security-relevant config: external endpoints, API keys)
mediaConfigRouter.use(globalRateLimit);

// ── GET /api/admin/media-config ───────────────────────────────────────────────

mediaConfigRouter.get('/', requireAdmin, (req, res) => {
  const cfg = getMediaEmbeddingConfig();
  // Never return API keys in plaintext — mask them
  const masked = maskSecrets(cfg);
  res.json(masked);
});

// ── PATCH /api/admin/media-config ─────────────────────────────────────────────

const ProviderPatchSchema = z.object({
  baseUrl: z.string().url().optional(),
  model: z.string().max(128).optional(),
  apiKey: z.string().max(512).optional().nullable(),
  label: z.string().max(128).optional(),
}).strict();

const MediaConfigPatchSchema = z.object({
  enabled: z.boolean().optional(),
  visionProvider: z.enum(['local', 'external']).optional(),
  sttProvider: z.enum(['local', 'external']).optional(),
  vision: ProviderPatchSchema.optional(),
  stt: ProviderPatchSchema.optional(),
  workerConcurrency: z.number().int().min(1).max(16).optional(),
  workerPollIntervalMs: z.number().int().min(100).max(60_000).optional(),
  workerMaxPollIntervalMs: z.number().int().min(1_000).max(600_000).optional(),
  fallbackToExternal: z.boolean().optional(),
  maxFileSizeBytes: z.number().int().min(1).max(10_737_418_240 /* 10 GiB */).optional(),
  stalledJobTimeoutMs: z.number().int().min(30_000).max(3_600_000).optional(),
}).strict();

mediaConfigRouter.patch('/', requireAdminMfa, (req, res) => {
  const parsed = MediaConfigPatchSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid request body', details: parsed.error.issues });
    return;
  }

  const activeCfg = getMediaEmbeddingConfig();
  const locked = new Set(activeCfg.lockedByInfra ?? []);

  // Reject attempts to overwrite locked fields
  const attempted = Object.keys(parsed.data);
  const blocked = attempted.filter(k => locked.has(k));
  if (blocked.length > 0) {
    res.status(403).json({
      error: 'Fields are locked by infrastructure env vars and cannot be changed via the UI',
      locked: blocked,
    });
    return;
  }

  // ── SSRF guard for external provider URLs ──────────────────────────────────
  // Local providers are trusted (cluster DNS — `*.svc.cluster.local`, addressed
  // via NetworkPolicy). External providers are admin-typed URLs that must
  // resolve to a public endpoint, never to private networks or cloud metadata.
  const effectiveVisionType = parsed.data.visionProvider ?? activeCfg.visionProvider ?? 'local';
  const effectiveSttType    = parsed.data.sttProvider    ?? activeCfg.sttProvider    ?? 'local';
  if (effectiveVisionType === 'external' && parsed.data.vision?.baseUrl
      && !isSsrfSafeUrl(parsed.data.vision.baseUrl)) {
    res.status(400).json({ error: 'vision.baseUrl rejected: must be a public http(s) URL (no private/loopback/metadata addresses)' });
    return;
  }
  if (effectiveSttType === 'external' && parsed.data.stt?.baseUrl
      && !isSsrfSafeUrl(parsed.data.stt.baseUrl)) {
    res.status(400).json({ error: 'stt.baseUrl rejected: must be a public http(s) URL (no private/loopback/metadata addresses)' });
    return;
  }

  try {
    // ── Split sensitive fields into secrets.json ─────────────────────────────
    // API keys are credentials and live alongside peerTokens / TOTP secret in
    // the 0o600 secrets.json — never in the world-readable config.json.
    const visionApiKeyChange = (parsed.data.vision && 'apiKey' in parsed.data.vision)
      ? parsed.data.vision.apiKey ?? null  // null/undefined both mean "delete"
      : undefined;                          // undefined = "leave existing untouched"
    const sttApiKeyChange = (parsed.data.stt && 'apiKey' in parsed.data.stt)
      ? parsed.data.stt.apiKey ?? null
      : undefined;

    if (visionApiKeyChange !== undefined || sttApiKeyChange !== undefined) {
      const secrets = getSecrets();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sAny = secrets as any;
      sAny.mediaEmbedding = sAny.mediaEmbedding ?? {};
      if (visionApiKeyChange !== undefined) {
        if (visionApiKeyChange === null || visionApiKeyChange === '') delete sAny.mediaEmbedding.visionApiKey;
        else sAny.mediaEmbedding.visionApiKey = visionApiKeyChange;
      }
      if (sttApiKeyChange !== undefined) {
        if (sttApiKeyChange === null || sttApiKeyChange === '') delete sAny.mediaEmbedding.sttApiKey;
        else sAny.mediaEmbedding.sttApiKey = sttApiKeyChange;
      }
      saveSecrets(secrets);
    }

    const cfg = getConfig();
    const existing = cfg.mediaEmbedding ?? {};
    const merged: Record<string, unknown> = { ...existing, ...parsed.data };
    // Remove runtime-only lockedByInfra — never persisted to config.json
    delete merged['lockedByInfra'];
    // Strip apiKey from config.json — it lives in secrets.json now
    if (merged['vision']) {
      const v = { ...(merged['vision'] as Record<string, unknown>) };
      delete v['apiKey'];
      merged['vision'] = v;
    }
    if (merged['stt']) {
      const s = { ...(merged['stt'] as Record<string, unknown>) };
      delete s['apiKey'];
      merged['stt'] = s;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    cfg.mediaEmbedding = merged as any;
    saveConfig(cfg);
    log.info(`Media embedding config updated by admin`);
    res.json({ ok: true, config: maskSecrets(getMediaEmbeddingConfig()) });
  } catch (err) {
    log.warn(`Failed to save media config: ${err}`);
    res.status(500).json({ error: 'Failed to save configuration' });
  }
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function maskSecrets(cfg: ReturnType<typeof getMediaEmbeddingConfig>): unknown {
  const mask = (v: string | undefined) => v ? '••••••••' : undefined;
  return {
    ...cfg,
    vision: cfg.vision ? { ...cfg.vision, apiKey: mask(cfg.vision.apiKey) } : cfg.vision,
    stt: cfg.stt ? { ...cfg.stt, apiKey: mask(cfg.stt.apiKey) } : cfg.stt,
  };
}
