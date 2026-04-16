/**
 * Storage quota enforcement.
 *
 * Quota is configured in config.json under `storage`:
 *
 *   storage.total   — hard cap on files + brain combined
 *   storage.files   — hard cap on file storage alone
 *   storage.brain   — hard cap on MongoDB brain data alone
 *
 * Each area has a `softLimitGiB` (warning) and `hardLimitGiB` (reject).
 * If no `storage` key is present in config, quota enforcement is disabled.
 *
 * Usage measurement:
 *   files  — recursive stat-sum of /data/files/
 *   brain  — MongoDB dbStats (dataSize + indexSize)
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { getConfig, getDataRoot } from '../config/loader.js';
import { getDb } from '../db/mongo.js';

const GiB = 1024 ** 3;

// ── Types ──────────────────────────────────────────────────────────────────

export interface UsageGiB {
  files: number;  // GiB used by /data/files/
  brain: number;  // GiB used by MongoDB (dataSize + indexSize)
  total: number;  // files + brain
}

/** Thrown by checkQuota() when a hard limit is exceeded. */
export class QuotaError extends Error {
  readonly area: 'files' | 'brain' | 'total';
  readonly usedGiB: number;
  readonly limitGiB: number;

  constructor(area: 'files' | 'brain' | 'total', usedGiB: number, limitGiB: number) {
    super(
      `Storage ${area} hard limit exceeded: ` +
      `${usedGiB.toFixed(2)} GiB used of ${limitGiB} GiB allowed`,
    );
    this.name = 'QuotaError';
    this.area = area;
    this.usedGiB = usedGiB;
    this.limitGiB = limitGiB;
  }
}

export interface QuotaCheckResult {
  usage: UsageGiB;
  /** True if a soft limit is breached (warning only — write proceeds). */
  softBreached: boolean;
  /** Human-readable soft-limit warning message, if softBreached. */
  warning?: string;
}

// ── Usage measurement ──────────────────────────────────────────────────────

/** Recursively sum file sizes under a directory. Returns 0 if directory absent. */
export async function dirSizeBytes(dirPath: string): Promise<number> {
  let total = 0;

  async function walk(p: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(p, { withFileTypes: true });
    } catch {
      return; // directory doesn't exist or unreadable
    }
    for (const e of entries) {
      const full = path.join(p, e.name);
      if (e.isSymbolicLink()) {
        continue; // Skip symlinks to prevent quota inflation via external targets
      } else if (e.isDirectory()) {
        await walk(full);
      } else {
        try { total += (await fs.stat(full)).size; } catch { /* skip */ }
      }
    }
  }

  await walk(dirPath);
  return total;
}

/** Measure current storage usage synchronously. */
export async function measureUsage(): Promise<UsageGiB> {
  const dataRoot = getDataRoot();
  const filesDir = path.join(dataRoot, 'files');

  const [fileBytes, brainBytes] = await Promise.all([
    dirSizeBytes(filesDir),
    (async () => {
      try {
        const db = getDb();
        const stats = await db.command({ dbStats: 1 }) as {
          dataSize?: number;
          indexSize?: number;
        };
        return (stats.dataSize ?? 0) + (stats.indexSize ?? 0);
      } catch {
        return 0;
      }
    })(),
  ]);

  const filesGiB = fileBytes / GiB;
  const brainGiB = brainBytes / GiB;
  return { files: filesGiB, brain: brainGiB, total: filesGiB + brainGiB };
}

// ── Quota check ────────────────────────────────────────────────────────────

/**
 * Check quota limits for a write operation.
 *
 * @param area  'files' for file writes; 'brain' for memory/entity/edge writes
 * @throws QuotaError if any hard limit is exceeded — caller should return HTTP 507
 * @returns QuotaCheckResult — caller should surface `warning` to the user if softBreached
 */
export async function checkQuota(area: 'files' | 'brain'): Promise<QuotaCheckResult> {
  const cfg = getConfig();
  const storage = cfg.storage;

  // No storage config → quota disabled, always allow.
  if (!storage) {
    return { usage: { files: 0, brain: 0, total: 0 }, softBreached: false };
  }

  const usage = await measureUsage();
  const warnings: string[] = [];
  let softBreached = false;

  // ── Hard limits (throw on exceed) ─────────────────────────────────────

  if (storage.total?.hardLimitGiB != null && usage.total >= storage.total.hardLimitGiB) {
    throw new QuotaError('total', usage.total, storage.total.hardLimitGiB);
  }

  if (area === 'files' && storage.files?.hardLimitGiB != null && usage.files >= storage.files.hardLimitGiB) {
    throw new QuotaError('files', usage.files, storage.files.hardLimitGiB);
  }

  if (area === 'brain' && storage.brain?.hardLimitGiB != null && usage.brain >= storage.brain.hardLimitGiB) {
    throw new QuotaError('brain', usage.brain, storage.brain.hardLimitGiB);
  }

  // ── Soft limits (warn, do not reject) ─────────────────────────────────

  if (storage.total?.softLimitGiB != null && usage.total >= storage.total.softLimitGiB) {
    softBreached = true;
    warnings.push(
      `Storage soft limit reached: ${usage.total.toFixed(2)} GiB / ${storage.total.softLimitGiB} GiB total`,
    );
  }

  if (area === 'files' && storage.files?.softLimitGiB != null && usage.files >= storage.files.softLimitGiB) {
    softBreached = true;
    warnings.push(
      `File storage soft limit reached: ${usage.files.toFixed(2)} GiB / ${storage.files.softLimitGiB} GiB`,
    );
  }

  if (area === 'brain' && storage.brain?.softLimitGiB != null && usage.brain >= storage.brain.softLimitGiB) {
    softBreached = true;
    warnings.push(
      `Brain storage soft limit reached: ${usage.brain.toFixed(2)} GiB / ${storage.brain.softLimitGiB} GiB`,
    );
  }

  return {
    usage,
    softBreached,
    warning: warnings.length > 0 ? warnings.join('; ') : undefined,
  };
}
