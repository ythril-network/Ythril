/**
 * Numeric environment variables, validated once, at boot, out loud.
 *
 * ## The finding — Observability & Operability audit lens
 *
 * Fifteen numeric settings were read as `Number(process.env[X])` and exactly **one** of them checked the result.
 * A typo — `8OOO` with letter O, `30_000`, `5s`, a trailing space in a YAML block — yields `NaN`, and `NaN` does
 * not fail. It silently changes behaviour. Measured, not assumed:
 *
 * | setting | typo'd value does | consequence |
 * |---|---|---|
 * | `SHUTDOWN_DRAIN_MS` | `setTimeout(fn, NaN)` fires after **0 ms** | the graceful drain does not drain: in-flight requests are cut off at SIGTERM, which is the exact guarantee the drain was added to provide |
 * | `MONGO_CONNECT_RETRY_MS` | `elapsed < NaN` is **false** | zero retries, reintroducing the boot race where the first connection is reset while mongod is still starting |
 * | `EMBEDDING_DIMENSIONS` | serialises as **`null`** | the vector index is created with a null dimension |
 * | `RECALL_BUDGET_MS` | every budget comparison is **false** | the budget silently stops applying |
 *
 * `PORT` is the one that was already safe, and worth recording because I expected otherwise: Node throws
 * `ERR_SOCKET_BAD_PORT` from `listen(NaN)`, so a typo there fails loudly at boot. That is the behaviour every
 * other setting now has.
 *
 * ## Why fail fast rather than fall back to the default
 *
 * Because a typo is never a preference. Falling back gives an operator an instance that runs with settings they did
 * not choose and cannot see — and for the three above, one that has quietly lost a documented guarantee. Refusing
 * to start is the same choice the at-rest encryption already makes: a wrong key stops the boot rather than
 * continuing without it.
 *
 * Every malformed value is reported in ONE message, not the first one only, so an operator with two typos learns
 * about both.
 */
import { log } from '../util/log.js';
import { DUAL_DOOR_BOUNDS, ENV_TO_CONFIG_PATH } from './setting-bounds.js';

/** A numeric setting: its name, its bounds, and what it means, for the error message. */
interface NumericSetting {
  name: string;
  min: number;
  max: number;
  /** Named in the failure message so an operator knows what they have broken. */
  what: string;
}

/**
 * An entry for a setting that is ALSO writable through the admin PATCH, taking its range from the one place
 * both doors read.
 *
 * Written as a helper rather than four inline spreads so the registry still reads as a list of settings, and so
 * that a fifth dual-door setting is one line rather than an invitation to paste numbers back in.
 */
function dual(name: keyof typeof ENV_TO_CONFIG_PATH): NumericSetting {
  const b = DUAL_DOOR_BOUNDS[ENV_TO_CONFIG_PATH[name]];
  return { name, min: b.min, max: b.max, what: b.what };
}

/**
 * Every numeric environment variable Ythril reads.
 *
 * Exhaustive by design, and asserted to be: a new `Number(process.env[…])` anywhere in the tree without an entry
 * here is a setting nobody validates, which is how this class of bug returns. See
 * `testing/standalone/numeric-env-is-validated.test.js`.
 */
export const NUMERIC_SETTINGS: readonly NumericSetting[] = [
  { name: 'PORT', min: 1, max: 65535, what: 'the HTTP listen port' },
  { name: 'MONGO_CONNECT_RETRY_MS', min: 0, max: 600_000, what: 'how long the first MongoDB connection may retry' },
  { name: 'SHUTDOWN_DRAIN_MS', min: 0, max: 300_000, what: 'how long in-flight requests get after SIGTERM' },
  { name: 'SHUTDOWN_READY_GRACE_MS', min: 0, max: 300_000, what: 'how long to keep serving after /ready turns 503' },
  { name: 'RECALL_BUDGET_MS', min: 1_000, max: 600_000, what: 'the end-to-end budget for one recall' },
  { name: 'RERANK_MIN_BUDGET_MS', min: 0, max: 600_000, what: 'the remaining budget below which reranking is skipped' },
  // The four dual-door settings take their range from `setting-bounds.ts` rather than repeating one here.
  // Each of these disagreed with the admin PATCH schema for the same field — `EMBEDDING_CONCURRENCY` allowed
  // 256 while the runtime clamps to 32 and says why, so the value was accepted here and silently discarded
  // later. A range written twice is a range that disagrees; see that file for which number won and on what
  // grounds.
  dual('EMBEDDING_DIMENSIONS'),
  dual('EMBEDDING_CONCURRENCY'),
  { name: 'MODEL_VERIFY_TIMEOUT_MS', min: 1_000, max: 1_800_000, what: 'how long a model verification may take' },
  dual('DOC_OCR_TIMEOUT_MS'),
  dual('DOC_DESCRIBE_TIMEOUT_MS'),
  { name: 'INDEX_READY_TIMEOUT_MS', min: 0, max: 3_600_000, what: 'how long boot waits for vector indexes' },
  // Q-165. Zero is allowed and means "drop as soon as the check runs"; a day is the ceiling because past it the
  // setting is keeping indexes on empty collections, which is the cost the rule exists to remove.
  { name: 'SEARCH_INDEX_DROP_DELAY_MS', min: 0, max: 86_400_000, what: 'how long after its last delete an emptied collection keeps its search index' },
  { name: 'MCP_OAUTH_TOKEN_TTL_DAYS', min: 0, max: 3_650, what: 'the lifetime of a connector token (0 = never expires)' },
  { name: 'YTHRIL_CONNECTOR_PORT', min: 1, max: 65535, what: "the local agent connector's listen port" },
  // Infra's instance-wide request quota, and the CEILING a per-token value may not exceed. Registered here
  // rather than read with a bare `??` for the reason this whole file exists: a typo in a rate limit would
  // otherwise become NaN, and `max: NaN` in express-rate-limit rejects every request — an instance that
  // refuses all traffic because somebody wrote `3OO`.
  { name: 'YTHRIL_RATE_LIMIT_PER_MINUTE', min: 1, max: 1_000_000, what: 'the instance-wide request quota per token, per minute' },
  // Both bound the same scan, and the ceilings are the point rather than the defaults. The scan runs on a
  // write path: 30 minutes of window or 5,000 documents would make a duplicate check cost seconds, which
  // is a slower way to fail than not checking at all.
  { name: 'DUPE_FRESH_WINDOW_MS', min: 0, max: 600_000, what: 'how far back the duplicate check reads the collection (0 = index only)' },
  { name: 'DUPE_FRESH_SCAN_CAP', min: 0, max: 5_000, what: 'the most records one duplicate check scores outside the index' },
  // A read spill (Q-92) is paid for by the token that caused it. The share bounds one token; the ceiling bounds
  // the instance, and it refuses rather than evicting somebody else's spill. Megabytes of RAW JSON, not gzip:
  // the cost a read pays is the decompressed size.
  { name: 'READ_SPILL_TOKEN_MAX_MB', min: 1, max: 16_384, what: 'the raw megabytes of read spills one token may hold' },
  { name: 'READ_SPILL_TOKEN_MAX_COUNT', min: 1, max: 100_000, what: 'how many read spills one token may hold' },
  { name: 'READ_SPILL_INSTANCE_MAX_MB', min: 1, max: 1_048_576, what: 'the raw megabytes of read spills the instance holds in all' },
] as const;

const BY_NAME = new Map(NUMERIC_SETTINGS.map(s => [s.name, s]));

/** Why a value was rejected, phrased for an operator rather than a developer. */
function reject(name: string, raw: string, why: string): string {
  const s = BY_NAME.get(name);
  return `${name}=${JSON.stringify(raw)} is not usable — ${why}.${s ? ` It sets ${s.what}` : ''}`
    + (s ? `, and must be a whole number between ${s.min} and ${s.max}.` : '');
}

/**
 * Strict parse. `null` when unset; a string when the value is present and unusable.
 *
 * The single definition of "usable", so the reader and the boot-time check can never disagree about a value —
 * which would be the worst outcome available: an instance that starts because the check passed and then behaves as
 * if the setting were absent.
 */
function parse(name: string): { value: number | null } | { problem: string } {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return { value: null };
  const s = BY_NAME.get(name);
  const n = Number(raw.trim());
  if (!Number.isFinite(n)) return { problem: reject(name, raw, 'it is not a number') };
  if (!Number.isInteger(n)) return { problem: reject(name, raw, 'it is not a whole number') };
  if (s && (n < s.min || n > s.max)) return { problem: reject(name, raw, `${n} is out of range`) };
  return { value: n };
}

/**
 * Parse one numeric env var, or `undefined` when it is unset or unusable.
 *
 * **Does not throw, deliberately.** Several of these are read at module scope, so a throw would happen during
 * import — before any of `index.ts` runs, producing a stack trace instead of the message an operator needs, and
 * from a module they have never heard of. Instead the problem is remembered, and
 * {@link assertNumericEnvOrExit} refuses to start the process. Nothing is served with a value nobody chose.
 */
export function envIntOpt(name: string): number | undefined {
  const r = parse(name);
  if ('problem' in r) return undefined;
  return r.value ?? undefined;
}

/** Parse one numeric env var, falling back to `fallback` when it is unset (or unusable — see above). */
export function envInt(name: string, fallback: number): number {
  return envIntOpt(name) ?? fallback;
}

/**
 * Check every numeric setting and report ALL problems.
 *
 * Returns rather than exits so it is testable: a test can assert the reporting without killing its own process.
 * Every offender is listed, not just the first — an operator with two typos should learn about both.
 */
export function validateNumericEnv(): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  for (const s of NUMERIC_SETTINGS) {
    const r = parse(s.name);
    if ('problem' in r) problems.push(r.problem);
  }
  // A pair that is valid alone and wrong together: an instance ceiling below one token's share refuses every
  // spill that token is entitled to, and each value on its own passes its range.
  const share = envInt('READ_SPILL_TOKEN_MAX_MB', 64);
  const ceiling = envInt('READ_SPILL_INSTANCE_MAX_MB', 1024);
  if (ceiling < share) {
    problems.push(`READ_SPILL_INSTANCE_MAX_MB=${ceiling} is below READ_SPILL_TOKEN_MAX_MB=${share} — the instance `
      + 'ceiling for read spills must be at least one token\'s share, or that share can never be used.');
  }
  return { ok: problems.length === 0, problems };
}

/** Report and exit, or return. The one place the process is allowed to die over a setting. */
export function assertNumericEnvOrExit(): void {
  const { ok, problems } = validateNumericEnv();
  if (ok) return;
  log.error(`Refusing to start: ${problems.length} environment setting${problems.length === 1 ? ' is' : 's are'} malformed.`);
  for (const p of problems) log.error(`  • ${p}`);
  log.error('A typo is never a preference: continuing would run this instance with settings you did not choose, '
    + 'and for the shutdown drain and the MongoDB connect retry it would silently drop a guarantee. '
    + 'Fix the value(s) above, or unset them to use the documented defaults.');
  process.exit(1);
}
