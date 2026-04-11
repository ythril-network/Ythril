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
import type { AuditLogEntry } from '../config/types.js';
import type { Collection, Filter } from 'mongodb';

const COLLECTION = 'audit_log';
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

  // TTL index — entries expire automatically.
  // Uses a dedicated _expireAt BSON Date field because `timestamp` is stored
  // as an ISO-8601 string for display/query simplicity, but MongoDB requires
  // a BSON Date for its TTL daemon to work.
  const retentionDays = getConfig().audit?.retentionDays ?? DEFAULT_RETENTION_DAYS;
  const expireAfterSeconds = retentionDays * 24 * 60 * 60;

  // Drop legacy string-based TTL index if present (it had no effect).
  try { await c.dropIndex('ttl_timestamp'); } catch { /* not present */ }

  try {
    await c.createIndex(
      { _expireAt: 1 },
      { expireAfterSeconds, name: 'ttl_expireAt' },
    );
  } catch {
    try {
      await c.dropIndex('ttl_expireAt');
      await c.createIndex(
        { _expireAt: 1 },
        { expireAfterSeconds, name: 'ttl_expireAt' },
      );
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
}

// ── Write ──────────────────────────────────────────────────────────────────

export interface AuditEntryInput {
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
}

/** Insert an audit log entry. Fire-and-forget — never throws. */
export function logAuditEntry(input: AuditEntryInput): void {
  const entry: AuditLogEntry = {
    _id: uuidv4(),
    timestamp: new Date().toISOString(),
    _expireAt: new Date(),
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
  };

  col().insertOne(entry as never).catch(err => {
    log.warn(`Audit log write failed: ${err}`);
  });
}

// ── Query ──────────────────────────────────────────────────────────────────

export interface AuditQueryParams {
  after?: string;
  before?: string;
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

export async function queryAuditLog(params: AuditQueryParams): Promise<AuditQueryResult> {
  const filter: Filter<AuditLogEntry> = {};

  if (params.after || params.before) {
    const ts: Record<string, string> = {};
    if (params.after) ts['$gte'] = params.after;
    if (params.before) ts['$lte'] = params.before;
    filter.timestamp = ts as never;
  }

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
      filter.operation = { $in: ops } as never;
    }
  }

  const limit = Math.min(Math.max(params.limit ?? 100, 1), 1000);
  const offset = Math.max(params.offset ?? 0, 0);

  const [entries, total] = await Promise.all([
    col()
      .find(filter as never)
      .sort({ timestamp: -1 })
      .skip(offset)
      .limit(limit)
      .toArray(),
    col().countDocuments(filter as never),
  ]);

  return {
    entries,
    total,
    hasMore: offset + entries.length < total,
  };
}
