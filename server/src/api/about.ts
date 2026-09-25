import { Router } from 'express';
import fs from 'node:fs';
import { globalRateLimit } from '../rate-limit/middleware.js';
import { requireAuth, requireAdmin } from '../auth/middleware.js';
import { mintSseTicket } from '../auth/sse-ticket.js';
import { getConfig, getDocumentProcessingConfig, getMediaEmbeddingConfig } from '../config/loader.js';
import { isRenderAvailable, isOfficeRenderAvailable } from '../files/converters/renderer.js';
import { isNlpAvailable } from '../extractor/conversation/nlp-client.js';
import { summariseHealth } from './health-summary.js';
import { getMongo } from '../db/mongo.js';
import { getLogLines, subscribeLogLines } from '../util/log.js';
import { computeSecurityPosture, securityStrict } from '../config/security-posture.js';
import { dirSizeBytes } from '../quota/quota.js';
import { SERVER_VERSION } from '../util/server-version.js';

// One reader for the version, in `util/server-version.ts`. This file and `app.ts` each resolved their own
// path to the same manifest, and a third was about to be added — a version string is exactly the kind of
// value that goes quietly wrong when two copies disagree about which `package.json` they mean.
const version = SERVER_VERSION;

const DATA_ROOT = process.env['DATA_ROOT'] ?? '/data';

let _mongoVersion: string | null = null;

async function mongoVersion(): Promise<string> {
  if (_mongoVersion) return _mongoVersion;
  const info = await getMongo().db().admin().serverInfo();
  _mongoVersion = info.version as string;
  return _mongoVersion;
}

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const parts: string[] = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0) parts.push(`${h}h`);
  parts.push(`${m}m`);
  return parts.join(' ');
}

// Ythril's actual data footprint (recursive size of DATA_ROOT) is what the operator wants to see —
// `statfs` reports the WHOLE partition DATA_ROOT sits on, which in the common deployment (DATA_ROOT a
// subdir of the host root fs, not its own mount) is the host disk, not Ythril's usage (the bug the
// owner hit). A recursive `du` is O(files), so cache it with a TTL rather than pay it per /about call.
let _dataUsedCache: { bytes: number; at: number } | null = null;
const DATA_USED_TTL_MS = 5 * 60 * 1000;
async function getDataUsedBytes(): Promise<number> {
  const now = Date.now();
  if (_dataUsedCache && now - _dataUsedCache.at < DATA_USED_TTL_MS) return _dataUsedCache.bytes;
  try {
    const bytes = await dirSizeBytes(DATA_ROOT);
    _dataUsedCache = { bytes, at: now };
    return bytes;
  } catch {
    return _dataUsedCache?.bytes ?? 0;
  }
}

// `total`/`available`/`used` describe the filesystem/partition DATA_ROOT lives on (capacity context);
// `dataUsed` is Ythril's own footprint under DATA_ROOT — the figure the UI leads with.
async function getDiskInfo(): Promise<{ total: number; used: number; available: number; dataUsed: number }> {
  const dataUsed = await getDataUsedBytes();
  try {
    const stats = fs.statfsSync(DATA_ROOT);
    const total = stats.bsize * stats.blocks;
    const available = stats.bsize * stats.bavail;
    const used = total - available;
    return { total, used, available, dataUsed };
  } catch {
    return { total: 0, used: 0, available: 0, dataUsed };
  }
}

export const aboutRouter = Router();

aboutRouter.use(globalRateLimit, requireAuth);

aboutRouter.get('/', async (_req, res) => {
  const cfg = getConfig();
  const [mongoVer, diskInfo] = await Promise.all([mongoVersion(), getDiskInfo()]);
  const response: Record<string, unknown> = {
    instanceId: cfg.instanceId,
    instanceLabel: cfg.instanceLabel,
    version,
    uptime: formatUptime(process.uptime()),
    mongoVersion: mongoVer,
    diskInfo,
  };
  if (cfg.publicUrl) response.publicUrl = cfg.publicUrl;
  res.json(response);
});

// Admin-only: log lines may contain space names, peer URLs, and internal paths.
aboutRouter.get('/logs', requireAdmin, (_req, res) => {
  const lines = Math.min(Math.max(1, Number(_req.query['lines']) || 200), 1000);
  res.json({ lines: getLogLines(lines) });
});

// Component liveness for the Instance panel (F9 follow-up). Admin-only: it names which optional
// services an instance is wired to, which is deployment shape.
//
// NOT part of `/ready`, deliberately — see health-summary.ts. Everything probed here is optional, and
// a dead render sidecar must degrade a feature, not pull a healthy instance out of the load balancer.
aboutRouter.get('/health', requireAdmin, async (_req, res) => {
  const docCfg = getDocumentProcessingConfig();
  // The NLI judge is a media-embedding PROVIDER (same shape as vision/stt), not a field on the
  // contradiction-scanner block — the scanner consumes it but does not own it.
  const nli = getMediaEmbeddingConfig().nli;

  // Each probe is already cached and timeout-bounded at its source, so this route cannot hang on a
  // sidecar that accepts connections and never answers.
  const [render, office, nlpUp] = await Promise.all([
    isRenderAvailable().catch(() => false),
    isOfficeRenderAvailable().catch(() => false),
    isNlpAvailable().catch(() => false),
  ]);

  const renderWanted = docCfg.mode !== 'off';
  const components = [
    {
      id: 'doc-render',
      label: 'Document renderer',
      configured: renderWanted,
      reachable: renderWanted ? render : null,
      impact: 'PDFs fall back to plain text extraction — no page images, so no VLM or OCR route.',
    },
    {
      id: 'doc-office',
      label: 'Office renderer',
      configured: renderWanted,
      reachable: renderWanted ? office : null,
      impact: 'Office formats (docx, pptx, xlsx…) cannot be rasterised; they fall back to text.',
    },
    {
      id: 'doc-nlp',
      label: 'NLP (conversation extraction)',
      // Opt-in like doc-office (the `nlp` profile), and reported the same way: wired by compose, probed here.
      configured: true,
      reachable: nlpUp,
      impact: 'Conversations cannot be extracted — there is nothing to find their mentions with.',
    },
    {
      id: 'nli',
      label: 'Contradiction judge (NLI)',
      configured: !!nli?.baseUrl,
      reachable: null,   // no cheap liveness probe — the endpoint shape varies by provider
      impact: 'Contradiction findings stay at the structured pass; the NLI cursor parks.',
    },
  ];

  res.json(summariseHealth(components));
});

// Security posture report (PR-S3). Admin-only — reveals the instance's security configuration.
aboutRouter.get('/security', requireAdmin, (_req, res) => {
  const posture = computeSecurityPosture();
  res.json({ ...posture, strict: securityStrict() });
});

// Mint a single-use ticket for the log-stream SSE below (EventSource can't send an Authorization header;
// a raw token in the URL would leak into logs/history). Admin-only, single-use, ~1 min, bound to the
// stream path only. The client POSTs here, then opens the stream with `?ticket=`.
aboutRouter.post('/logs/ticket', requireAdmin, (req, res) => {
  const bearer = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '').trim();
  if (!bearer) {
    res.status(400).json({ error: 'Ticket minting requires an Authorization: Bearer header' });
    return;
  }
  res.json(mintSseTicket(bearer, '/api/about/logs/stream'));
});

// SSE stream for real-time log tailing. Admin-only.
aboutRouter.get('/logs/stream', requireAdmin, (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(':\n\n'); // initial comment to establish connection

  const unsubscribe = subscribeLogLines((line) => {
    if (res.destroyed) { unsubscribe(); return; }
    // Escape newlines to preserve SSE protocol framing
    const escaped = line.replace(/\n/g, '\\n').replace(/\r/g, '\\r');
    res.write(`data: ${escaped}\n\n`);
  });

  // Heartbeat: send SSE comment every 30s to keep the connection alive
  // and detect dead clients early (write to destroyed socket triggers close).
  const heartbeat = setInterval(() => {
    if (res.destroyed) { clearInterval(heartbeat); unsubscribe(); return; }
    res.write(':\n\n');
  }, 30_000);

  req.on('close', () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
});
