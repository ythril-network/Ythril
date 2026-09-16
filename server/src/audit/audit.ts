/**
 * Audit log — append-only, immutable access log stored in a dedicated MongoDB
 * collection (`audit_log`).
 *
 * Responsibilities:
 *  - Initialise the collection and TTL / query indexes.
 *  - Insert audit entries (fire-and-forget to avoid slowing requests).
 *  - Query entries with filtering and pagination.
 */

import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db/mongo.js';
import { getConfig } from '../config/loader.js';
import { log } from '../util/log.js';
import type { AuditLogEntry } from './entry.js';
import type { AuditChange } from './audit-changes.js';
import type { Collection, Filter, Sort } from 'mongodb';

/**
 * The audit collection, EXPORTED so nothing has to spell it a second time.
 *
 * `change-retention.ts` had its own copy and spelled it `_audit_log`. Nothing has ever written to that
 * name, so its sweep ran on an empty collection every ten minutes for fourteen releases and reported
 * nothing, because `updateMany` on a collection that does not exist returns `modifiedCount: 0` and the
 * sweep only logs when the count is above zero. A silence indistinguishable from success.
 */
export const AUDIT_COLLECTION = 'audit_log';
const COLLECTION = AUDIT_COLLECTION;
const DEFAULT_RETENTION_DAYS = 90;

function col(): Collection<AuditLogEntry> {
  return getDb().collection<AuditLogEntry>(COLLECTION);
}

// ── Initialisation ─────────────────────────────────────────────────────────

/** Create the audit_log collection, TTL index, and query indexes. */
export async function initAuditCollection(): Promise<void> {
  const db = getDb();
  const existing = await db.listCollections({ name: COLLECTION }).toArray();
  if (existing.length === 0) {
    await db.createCollection(COLLECTION);
    log.debug(`Created collection ${COLLECTION}`);
  }

  const c = col();

  // TTL index — entries expire at the exact _expireAt BSON Date.
  // _expireAt is computed per entry at write time (now + retentionDays) so
  // each entry carries its own absolute expiry.  expireAfterSeconds: 0 means
  // "expire at the Date stored in the field" — no additional offset.
  // This also makes retention config changes forward-only: lowering retention
  // won't retroactively shorten existing entries' lifetimes.

  // Drop legacy string-based TTL index if present (it had no effect).
  try { await c.dropIndex('ttl_timestamp'); } catch { /* not present */ }

  // Ensure TTL index with expireAfterSeconds: 0.  Use collMod to update
  // the value in-place if the index already exists with a different value,
  // avoiding the noisy drop-and-recreate pattern.
  try {
    await c.createIndex(
      { _expireAt: 1 },
      { expireAfterSeconds: 0, name: 'ttl_expireAt' },
    );
  } catch {
    // Index already exists with a different expireAfterSeconds — update in-place.
    try {
      await db.command({
        collMod: COLLECTION,
        index: { name: 'ttl_expireAt', expireAfterSeconds: 0 },
      });
    } catch (err) {
      log.warn(`Could not update audit TTL index: ${err}`);
    }
  }

  // Query indexes
  await c.createIndex({ tokenId: 1, timestamp: -1 });
  await c.createIndex({ oidcSubject: 1, timestamp: -1 });
  await c.createIndex({ spaceId: 1, timestamp: -1 });
  await c.createIndex({ operation: 1, timestamp: -1 });
  await c.createIndex({ status: 1, timestamp: -1 });
  await c.createIndex({ ip: 1, timestamp: -1 });

  // Bare timestamp descending index — covers the most common admin query
  // ("show latest N entries" without any field filter).
  await c.createIndex({ timestamp: -1 });
}

// ── Write ──────────────────────────────────────────────────────────────────

export interface AuditEntryInput {
  /**
   * The `X-Request-Id` of the request that produced this entry, so the audit log and the server log can be
   * joined on one value.
   *
   * ABSENT means "written before this field existed", never "no request". Every entry has a request behind it —
   * that is what the audit log is — so an absent id is a fact about the RECORD's age and the UI has to say so
   * rather than showing a blank that reads as "none".
   */
  requestId?: string | null;
  tokenId?: string | null;
  tokenLabel?: string | null;
  authMethod?: 'pat' | 'oidc' | null;
  oidcSubject?: string | null;
  ip: string;
  method: string;
  path: string;
  spaceId?: string | null;
  operation: string;
  status: number;
  entryId?: string | null;
  durationMs: number;
  /** Allowlisted field changes — see `audit-changes.ts`. Omitted when the operation has no allowlist. */
  changes?: AuditChange[];
  /**
   * Set once a record-edit entry's `changes` have aged out and been unset (see `change-retention.ts`).
   *
   * Distinguishes "this operation records no changes" from "it did, and they have expired" — without
   * it, an absent `changes` quietly implies nothing was ever captured.
   */
  changesRedacted?: boolean;
}

/** Insert an audit log entry. Fire-and-forget — never throws. */
export function logAuditEntry(input: AuditEntryInput): void {
  let retentionDays = DEFAULT_RETENTION_DAYS;
  try { retentionDays = getConfig().audit?.retentionDays ?? DEFAULT_RETENTION_DAYS; } catch { /* pre-setup */ }

  const entry: AuditLogEntry = {
    _id: uuidv4(),
    timestamp: new Date().toISOString(),
    _expireAt: new Date(Date.now() + retentionDays * 86_400_000),
    tokenId: input.tokenId ?? null,
    tokenLabel: input.tokenLabel ?? null,
    authMethod: input.authMethod ?? null,
    oidcSubject: input.oidcSubject ?? null,
    ip: input.ip,
    method: input.method,
    path: input.path,
    spaceId: input.spaceId ?? null,
    operation: input.operation,
    status: input.status,
    entryId: input.entryId ?? null,
    durationMs: input.durationMs,
    /*
     * Omitted rather than written as null when there is no id, which is the same rule `changes` follows above
     * and for the same reason: absent means "not recorded", and a stored `null` would claim the request had no
     * id — which cannot happen, since every request is given one. The only entries without it are the ones
     * written before the field existed, and an absent key is exactly how a reader tells them apart.
     */
    ...(input.requestId ? { requestId: input.requestId } : {}),
    // Omitted entirely when there is nothing allowlisted to say, so an entry never carries an empty array
    // that reads as "we looked and nothing changed" when in fact we never looked.
    ...(input.changes && input.changes.length > 0 ? { changes: input.changes } : {}),
  };

  col().insertOne(entry as any).catch((err: unknown) => {
    log.warn(`Audit log write failed: ${err}`);
  });
}

// ── Query ──────────────────────────────────────────────────────────────────

export interface AuditQueryParams {
  after?: string;
  before?: string;
  /**
   * Exact `X-Request-Id`. The whole point of storing it: an operator holding an id from a bug report asks for
   * one row rather than paging a filtered log looking for it.
   *
   * Exact match, not a prefix or a regex — a UUID is either the one you were given or it is not, and a partial
   * match here would return somebody else's request while looking like a helpful search.
   */
  requestId?: string;
  tokenId?: string;
  oidcSubject?: string;
  spaceId?: string;
  operation?: string;   // comma-separated list
  status?: number;
  ip?: string;
  limit?: number;
  offset?: number;
}

export interface AuditQueryResult {
  entries: AuditLogEntry[];
  total: number;
  hasMore: boolean;
}

/**
 * The Mongo filter for a set of query parameters.
 *
 * Extracted so the paged query and the streaming export cannot drift: an export that silently interpreted
 * `operation=a,b` differently from the screen the operator built the filter on would be worse than no export,
 * because the difference is invisible in the result.
 */
export function buildAuditFilter(params: AuditQueryParams): Filter<AuditLogEntry> {
  const filter: Filter<AuditLogEntry> = {};

  if (params.after || params.before) {
    const ts: Record<string, string> = {};
    if (params.after) ts['$gte'] = params.after;
    if (params.before) ts['$lte'] = params.before;
    filter.timestamp = ts as Filter<AuditLogEntry>['timestamp'];
  }

  if (params.requestId) filter.requestId = params.requestId;
  if (params.tokenId) filter.tokenId = params.tokenId;
  if (params.oidcSubject) filter.oidcSubject = params.oidcSubject;
  if (params.spaceId) filter.spaceId = params.spaceId;
  if (params.ip) filter.ip = params.ip;
  if (params.status !== undefined) filter.status = params.status;

  if (params.operation) {
    const ops = params.operation.split(',').map(s => s.trim()).filter(Boolean);
    if (ops.length === 1) {
      filter.operation = ops[0];
    } else if (ops.length > 1) {
      filter.operation = { $in: ops } as Filter<AuditLogEntry>['operation'];
    }
  }

  return filter;
}

/**
 * Every matching entry, oldest first, as a cursor — for the NDJSON export.
 *
 * **Ascending**, unlike the paged query. The screen wants the newest thing first; a file wants to read like a
 * log, and appending a later export to an earlier one should produce something still in order.
 *
 * No `limit`: the paged endpoint caps at 1,000 rows because a browser table has to stop somewhere, and that cap
 * is exactly what made "give me the whole record" a paging script. The cursor streams, so an unbounded result
 * set costs bounded fact.
 */
export function streamAuditEntries(params: AuditQueryParams): AsyncIterable<AuditLogEntry> {
  return col()
    .find(buildAuditFilter(params))
    .sort({ timestamp: 1 } as Sort)
    .batchSize(500);
}

export async function queryAuditLog(params: AuditQueryParams): Promise<AuditQueryResult> {
  const filter = buildAuditFilter(params);

  const limit = Math.min(Math.max(params.limit ?? 100, 1), 1000);
  const offset = Math.max(params.offset ?? 0, 0);

  // Fetch ONE extra row to decide `hasMore` (P11).
  //
  // This used to run a full filtered countDocuments() on EVERY page load, purely so that
  // `hasMore` could be derived from `total`. The audit log is append-only and therefore only
  // ever grows, so that count gets steadily more expensive forever — and it was being paid on
  // every click of "next". The extra row answers the question exactly, for free.
  const rows = await col()
    .find(filter)
    .sort({ timestamp: -1 } as Sort)
    .skip(offset)
    .limit(limit + 1)
    .toArray();

  const hasMore = rows.length > limit;
  const entries = hasMore ? rows.slice(0, limit) : rows;

  // `total` is only used to render "showing N of M", so it does not need to be exact to the
  // millisecond — but it DID need a full scan. Cache it briefly per filter: paging through a
  // result set now counts once instead of once per page.
  const total = await cachedTotal(filter);

  return { entries, total, hasMore };
}

// ── Cached totals ───────────────────────────────────────────────────────────
// Keyed by the serialised filter. Bounded so a caller cannot grow it without limit by
// sending endless distinct filters.
const TOTAL_TTL_MS = 30_000;
const TOTAL_CACHE_MAX = 64;
const _totalCache = new Map<string, { total: number; at: number }>();

async function cachedTotal(filter: Filter<AuditLogEntry>): Promise<number> {
  const key = JSON.stringify(filter);
  const now = Date.now();

  const hit = _totalCache.get(key);
  if (hit && now - hit.at < TOTAL_TTL_MS) return hit.total;

  const total = await col().countDocuments(filter);

  // Simple bound: drop the oldest insertion when full. Map preserves insertion order.
  if (_totalCache.size >= TOTAL_CACHE_MAX) {
    const oldest = _totalCache.keys().next();
    if (!oldest.done) _totalCache.delete(oldest.value);
  }
  _totalCache.set(key, { total, at: now });
  return total;
}
