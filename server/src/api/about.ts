import { Router } from 'express';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { globalRateLimit } from '../rate-limit/middleware.js';
import { requireAuth } from '../auth/middleware.js';
import { loadConfig } from '../config/loader.js';
import { getMongo } from '../db/mongo.js';
import { getLogLines } from '../util/log.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkgPath = path.resolve(__dirname, '..', '..', 'package.json');
const version: string = JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version;

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

async function getDiskInfo(): Promise<{ total: number; used: number; available: number }> {
  try {
    const stats = fs.statfsSync(DATA_ROOT);
    const total = stats.bsize * stats.blocks;
    const available = stats.bsize * stats.bavail;
    const used = total - available;
    return { total, used, available };
  } catch {
    return { total: 0, used: 0, available: 0 };
  }
}

export const aboutRouter = Router();

aboutRouter.use(globalRateLimit, requireAuth);

aboutRouter.get('/', async (_req, res) => {
  const cfg = loadConfig();
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

aboutRouter.get('/logs', (_req, res) => {
  const lines = Math.min(Math.max(1, Number(_req.query['lines']) || 200), 1000);
  res.json({ lines: getLogLines(lines) });
});
