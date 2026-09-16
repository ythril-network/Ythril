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
 *
 * ## A MEASUREMENT THAT COULD NOT READ EVERYTHING SAYS SO
 *
 * Both halves used to contribute 0 on failure. An unreadable directory under `/data/files` returned early and
 * a refused `dbStats` returned 0, so the usage came back LOWER than reality with nothing logged — and a hard
 * limit compared against a number that is only a floor never fires. An operator who set a quota then sees a
 * quota that simply never triggers, which is indistinguishable from being under it.
 *
 * `metrics/registry.ts` had already reasoned this out one layer up, for the same quantity: the storage gauge
 * emits NO series rather than a zero, because *"an absent series says 'not measured yet' where a zero would
 * have claimed 'empty'"*. That rule was right and it stopped at the gauge; the measurement it reads from was
 * still claiming empty. One rule, two implementations, the weaker one winning silently.
 *
 * So `UsageGiB` carries `incomplete`, every measurement that skips part of its subject records WHY, and
 * `checkQuota` says it in the result. **It still fails OPEN** — a transient `EIO` on one subdirectory must not
 * refuse writes on an otherwise healthy instance — but it can no longer do so quietly.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { getDataRoot, getStorageConfig } from '../config/loader.js';
import { getDb } from '../db/mongo.js';
import { log } from '../util/log.js';

const GiB = 1024 ** 3;

// ── Types ──────────────────────────────────────────────────────────────────

export interface UsageGiB {
  files: number;  // GiB used by /data/files/
  brain: number;  // GiB used by MongoDB (dataSize + indexSize)
  total: number;  // files + brain
  /**
   * What this measurement could NOT read, per area, one entry per reason. Both empty on a complete measurement.
   *
   * Present so a caller can tell "0.4 GiB used" from "at least 0.4 GiB used" — the whole difference between a
   * quota that is satisfied and one that could not be evaluated. The corresponding number above is a FLOOR
   * whenever its list is non-empty.
   *
   * PER AREA rather than one flat list, because the two halves fail for unrelated reasons and an operator acts
   * on them differently: an unlistable directory is a filesystem or permission problem, a refused `dbStats` is a
   * database-user grant. A single list would have forced the metric to parse a prefix out of a message to say
   * which half was affected, and a metric that parses prose is a metric that will one day be wrong quietly.
   */
  incomplete: { files: string[]; brain: string[] };
}

/** Every area a storage measurement covers. Exported so the metric cannot drift from the measurement. */
export const USAGE_AREAS = ['files', 'brain'] as const;
export type UsageArea = (typeof USAGE_AREAS)[number];

/** True when nothing in this measurement fell short. */
export function usageIsComplete(usage: UsageGiB, area?: UsageArea): boolean {
  if (area) return usage.incomplete[area].length === 0;
  return USAGE_AREAS.every(a => usage.incomplete[a].length === 0);
}

/** What a directory walk read, and what it could not. */
export interface DirSize {
  bytes: number;
  /** Paths the walk could not read, so `bytes` is a floor rather than a total. */
  unreadable: string[];
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
  /**
   * True when the usage behind this verdict could not be measured completely — so "not breached" means "not
   * breached by what we could read".
   *
   * Separate from `softBreached` on purpose. A soft breach is a fact about the store; this is a fact about the
   * MEASUREMENT, and conflating them would let a caller report a healthy quota as a warning or, worse, an
   * unmeasurable one as healthy.
   */
  measurementIncomplete: boolean;
}

// ── Usage measurement ──────────────────────────────────────────────────────

/**
 * Recursively sum file sizes under a directory, reporting what it could not read.
 *
 * An ABSENT root is not incompleteness — a space with no files directory yet uses no files, and reporting that
 * as unmeasurable would put every fresh instance permanently in the degraded state. Anything else that fails
 * IS: a directory the process cannot list, or a file it cannot stat, means the total below it is missing and
 * the sum is a floor.
 */
export async function measureDirSize(dirPath: string): Promise<DirSize> {
  let total = 0;
  const unreadable: string[] = [];

  async function walk(p: string, isRoot: boolean): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(p, { withFileTypes: true });
    } catch (err) {
      // ENOENT on the ROOT is "nothing stored here yet", which is a complete answer of zero. ENOENT deeper in
      // means something vanished mid-walk; any other code means we were refused.
      const code = (err as { code?: string }).code;
      if (!(isRoot && code === 'ENOENT')) unreadable.push(`${p}: ${code ?? String(err)}`);
      return;
    }
    for (const e of entries) {
      const full = path.join(p, e.name);
      if (e.isSymbolicLink()) {
        continue; // Skip symlinks to prevent quota inflation via external targets
      } else if (e.isDirectory()) {
        await walk(full, false);
      } else {
        try {
          total += (await fs.stat(full)).size;
        } catch (err) {
          // A file listed and then not stattable is either a race with a delete or a permission problem, and
          // the walk cannot tell which. Either way its bytes are missing from the sum.
          unreadable.push(`${full}: ${(err as { code?: string }).code ?? String(err)}`);
        }
      }
    }
  }

  await walk(dirPath, true);
  return { bytes: total, unreadable };
}

/**
 * The byte total alone, for callers that report a size and nothing else.
 *
 * Kept as its own function rather than making every caller destructure, and deliberately NOT the primary: a
 * caller that only wants a number should have to reach past the one that tells it whether the number is whole.
 */
export async function dirSizeBytes(dirPath: string): Promise<number> {
  return (await measureDirSize(dirPath)).bytes;
}

// ── Usage cache ──────────────────────────────────────────────────────────────
// measureUsage() recursively stat-sums the whole files tree AND runs a dbStats
// command — seconds of I/O on a large store. checkQuota() runs on EVERY upload
// chunk, so an uncached measure made a chunked upload O(total_files × chunks). This
// short-TTL cache collapses that: exact callers (first chunk, single writes, brain
// checks, metrics) re-measure and refresh it, so later chunks in the same burst read
// a fresh value instead of re-walking. See measureUsage(maxAgeMs).
let usageCache: { usage: UsageGiB; at: number } | null = null;
// Date.now() is fine here (not inside a workflow script); monotonic enough for a TTL.
const nowMs = (): number => Date.now();

/** Drop the cached usage so the next measureUsage() re-reads from disk/DB. Call
 *  after an operation that frees space (delete, wipe) so freed capacity is honoured
 *  immediately instead of after the TTL. Writes need no explicit call — the next
 *  exact check re-measures anyway. */
export function invalidateUsageCache(): void {
  usageCache = null;
}

/**
 * Read the cached usage WITHOUT measuring. Returns `null` if nothing has been measured yet.
 *
 * ## Why a read-only accessor exists
 *
 * `measureUsage()` walks the entire files tree. That is correct for a quota check, which must not admit a write
 * on a stale number, and **wrong for a Prometheus gauge**, which is sampled and already stale by the time it is
 * graphed. The canary proved the difference with numbers: on their platform instance the storage collector
 * averaged **22.150 s** against ~8.6 s for every MongoDB-backed collector, its distribution was bimodal (6 of 19
 * collections under 50 ms, 9 over 15 s — cold cache versus warm), and of 20 scrapes **10 failed** at exactly
 * `10.0012 s` while this collector exceeded 10 s exactly **10 times**. Same number. Their four small instances
 * completed every collector in 0.005–0.041 s, so it scales with stored volume, not with anything else.
 *
 * The argument against exactness here was already written in `metrics/registry.ts` for the brain totals — *"the
 * exactness that buys does not survive contact with what a gauge IS"* — and #606 acted on it by switching those
 * to `estimatedDocumentCount()`. It was simply never carried to the one collector where the cost was seconds
 * rather than milliseconds. The cache comment above even lists `metrics` among the callers that deliberately
 * re-measure; that line was the bug.
 *
 * So: the gauge reads this, reports what is known, and **never blocks a scrape on filesystem I/O**.
 */
export function peekUsage(): { usage: UsageGiB; ageMs: number } | null {
  if (!usageCache) return null;
  return { usage: usageCache.usage, ageMs: nowMs() - usageCache.at };
}

/** In-flight background refresh, so a slow walk cannot be started nine times over by nine scrapes. */
let backgroundRefresh: Promise<void> | null = null;

/**
 * Completed background walks since process start.
 *
 * Exists because coalescing is only testable by **counting walks**. The first version of the test asserted
 * "a refresh is in flight" before and after nine calls — which is true whether or not the guard exists, since
 * nine unguarded calls each leave *a* promise in the slot. The mutation that removed the guard survived it.
 *
 * It is also worth exposing: on a large store this is "how often are we walking the disk", which is the number
 * an operator wants when the answer is "more than you think".
 */
let usageMeasurements = 0;

/** Completed background usage walks since process start. Surfaced as a metric; also the coalescing assertion. */
export function usageMeasurementCount(): number {
  return usageMeasurements;
}

/**
 * Refresh the usage cache off the caller's critical path. Returns immediately.
 *
 * Coalesced: while a walk is running, further calls do nothing. That matters precisely because the walk can take
 * 22 s — without the guard, a 15-second scrape interval would stack walks on a filesystem that is already the
 * bottleneck, and on the canary's degraded RAID1 mid-rebuild that would be actively harmful.
 *
 * Never throws. A failed measurement leaves the previous value in place, which is the same contract every
 * collector already has for an unreachable dependency.
 */
export function refreshUsageInBackground(): void {
  if (backgroundRefresh) return;
  backgroundRefresh = measureUsageUncached()
    .then(usage => { usageCache = { usage, at: nowMs() }; })
    .catch(() => { /* keep the previous value; an error is not "unknown" */ })
    .finally(() => { usageMeasurements++; backgroundRefresh = null; });
}

/** True while a background walk is in flight — for tests, so they need not guess at timing. */
export function usageRefreshInFlight(): boolean {
  return backgroundRefresh !== null;
}

/**
 * Measure current storage usage.
 *
 * @param maxAgeMs  Reuse a cached measurement if it is younger than this many ms.
 *   Default 0 → always measure fresh (and refresh the cache). Pass a small window
 *   (e.g. 10_000) on hot, repeated checks like per-chunk quota enforcement where an
 *   exact re-walk per chunk is the bottleneck and a slightly stale value is safe.
 */
export async function measureUsage(maxAgeMs = 0): Promise<UsageGiB> {
  if (maxAgeMs > 0 && usageCache && nowMs() - usageCache.at < maxAgeMs) {
    return usageCache.usage;
  }
  const usage = await measureUsageUncached();
  usageCache = { usage, at: nowMs() };
  return usage;
}

/**
 * Measure current storage usage synchronously (uncached).
 *
 * Each half reports its own completeness. A half that could not be read fully contributes what it did read and
 * names what it did not, so the caller can tell a total from a floor — see the module header for why a zero was
 * the wrong answer to "I could not look".
 */
async function measureUsageUncached(): Promise<UsageGiB> {
  const dataRoot = getDataRoot();
  const filesDir = path.join(dataRoot, 'files');
  // In-progress chunked uploads stage under .chunks — count them toward the
  // files quota so partial uploads cannot fill the disk invisibly.
  const chunksDir = path.join(dataRoot, '.chunks');

  const [files, brain] = await Promise.all([
    Promise.all([measureDirSize(filesDir), measureDirSize(chunksDir)])
      .then(([a, b]) => ({ bytes: a.bytes + b.bytes, unreadable: [...a.unreadable, ...b.unreadable] })),
    (async (): Promise<DirSize> => {
      try {
        const db = getDb();
        const stats = await db.command({ dbStats: 1 }) as {
          dataSize?: number;
          indexSize?: number;
        };
        return { bytes: (stats.dataSize ?? 0) + (stats.indexSize ?? 0), unreadable: [] };
      } catch (err) {
        // A refused or unreachable `dbStats` used to read as 0 GiB of brain data, which is what a genuinely
        // empty instance also reads as. A restricted database user without the command, or a transient driver
        // error, then disabled the brain half of the quota for the life of the process with nothing logged.
        return { bytes: 0, unreadable: [`dbStats: ${err instanceof Error ? err.message : String(err)}`] };
      }
    })(),
  ]);

  const incomplete = {
    // Summarised, and the COUNT kept, because an unreadable tree can produce thousands of entries and neither a
    // log line nor an API response is a place to put them. The count is the part an operator acts on; the first
    // path is what they act on it with.
    files: files.unreadable.length > 0
      ? [`${files.unreadable.length} path(s) unreadable, first: ${files.unreadable[0]}`]
      : [],
    brain: brain.unreadable,
  };

  const reasons = [...incomplete.files.map(r => `files: ${r}`), ...incomplete.brain.map(r => `brain: ${r}`)];
  if (reasons.length > 0) {
    log.warn('Storage usage measurement is INCOMPLETE, so every figure below is a floor and a quota compared '
      + `against it can only under-report: ${reasons.join('; ')}`);
  }

  const filesGiB = files.bytes / GiB;
  const brainGiB = brain.bytes / GiB;
  return { files: filesGiB, brain: brainGiB, total: filesGiB + brainGiB, incomplete };
}

// ── Quota check ────────────────────────────────────────────────────────────

/**
 * Check quota limits for a write operation.
 *
 * @param area  'files' for file writes; 'brain' for fact/entity/edge writes
 * @param incomingBytes  projected size of the write being checked — added to
 *        current usage before hard-limit comparison so an upload that would
 *        push usage past the limit is rejected up front, not after landing
 * @throws QuotaError if any hard limit is exceeded — caller should return HTTP 507
 * @returns QuotaCheckResult — caller should surface `warning` to the user if softBreached
 * @param opts.maxAgeMs  reuse a usage measurement younger than this (default 0 = exact).
 *   Only pass a window on a hot repeated check (later upload chunks) where the first
 *   chunk already validated the full declared total exactly.
 */
export async function checkQuota(
  area: 'files' | 'brain',
  incomingBytes = 0,
  opts: { maxAgeMs?: number } = {},
): Promise<QuotaCheckResult> {
  // getStorageConfig(), not cfg.storage: an env pin must actually bind here or it is decoration.
  const storage = getStorageConfig();

  // No storage config → quota disabled, always allow. The zeros here are not a measurement at all, and
  // `incomplete` stays empty because nothing was attempted: there is no limit for a floor to fall short of.
  if (!storage) {
    return {
      usage: { files: 0, brain: 0, total: 0, incomplete: { files: [], brain: [] } },
      softBreached: false,
      measurementIncomplete: false,
    };
  }

  const usage = await measureUsage(opts.maxAgeMs ?? 0);
  const incomingGiB = incomingBytes / GiB;
  const warnings: string[] = [];
  let softBreached = false;

  // ── Hard limits (throw on exceed) ─────────────────────────────────────

  if (storage.total?.hardLimitGiB != null && usage.total + incomingGiB >= storage.total.hardLimitGiB) {
    throw new QuotaError('total', usage.total + incomingGiB, storage.total.hardLimitGiB);
  }

  if (area === 'files' && storage.files?.hardLimitGiB != null && usage.files + incomingGiB >= storage.files.hardLimitGiB) {
    throw new QuotaError('files', usage.files + incomingGiB, storage.files.hardLimitGiB);
  }

  if (area === 'brain' && storage.brain?.hardLimitGiB != null && usage.brain + incomingGiB >= storage.brain.hardLimitGiB) {
    throw new QuotaError('brain', usage.brain + incomingGiB, storage.brain.hardLimitGiB);
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

  /*
   * A measurement that could not read everything still ALLOWS the write — and says so.
   *
   * Failing closed here would turn one unreadable subdirectory, or a transient driver error on `dbStats`, into
   * a refusal of every write on an instance that is otherwise healthy. That trades a reporting gap for an
   * outage. But it is now a loud allow rather than a silent one: the measurement logged what it could not read,
   * and this flag travels with the verdict so a caller reporting "within quota" can qualify it.
   */
  if (!usageIsComplete(usage)) {
    const reasons = [
      ...usage.incomplete.files.map(r => `files: ${r}`),
      ...usage.incomplete.brain.map(r => `brain: ${r}`),
    ];
    warnings.push(`storage usage could not be measured completely, so this figure is a floor: ${reasons.join('; ')}`);
  }

  return {
    usage,
    softBreached,
    warning: warnings.length > 0 ? warnings.join('; ') : undefined,
    measurementIncomplete: !usageIsComplete(usage),
  };
}
