/**
 * Readiness check module
 *
 * Implements the checks behind `GET /ready`:
 *   - mongodb: admin ping + writable-primary verification
 *   - vectorSearch: mongot availability via listSearchIndexes
 *
 * Results are cached for CACHE_TTL_MS to avoid hammering MongoDB on every
 * Kubernetes probe interval.
 */

import { getMongo } from './db/mongo.js';

const TIMEOUT_MS = 2_000;
const CACHE_TTL_MS = 2_000;

export interface CheckResult {
  status: 'ok' | 'error';
  latencyMs?: number;
  error?: string;
}

export interface ReadinessResult {
  ready: boolean;
  checks: {
    mongodb: CheckResult;
    vectorSearch: CheckResult;
  };
}

// ── Simple in-memory cache ────────────────────────────────────────────────────
let _cached: ReadinessResult | null = null;
let _cachedAt = 0;

/** Exposed only for unit tests — resets the cache */
export function _resetCache(): void {
  _cached = null;
  _cachedAt = 0;
}

// ── Individual checks ─────────────────────────────────────────────────────────

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function checkMongoDB(): Promise<CheckResult> {
  const start = Date.now();
  try {
    const client = getMongo();
    const admin = client.db().admin();

    // Ping verifies the connection is alive
    await withTimeout(admin.ping(), TIMEOUT_MS);

    // Verify that the node we're connected to is a writable primary so writes work
    const hello = await withTimeout(
      admin.command({ hello: 1 }),
      TIMEOUT_MS,
    );
    const isWritable = hello['isWritablePrimary'] === true || hello['ismaster'] === true;
    if (!isWritable) {
      return { status: 'error', error: 'not primary' };
    }

    return { status: 'ok', latencyMs: Date.now() - start };
  } catch (err) {
    return {
      status: 'error',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function checkVectorSearch(): Promise<CheckResult> {
  try {
    const db = getMongo().db();
    // listSearchIndexes on any collection exercises the mongot connection.
    // An empty collection / non-existent collection still reaches mongot; a missing
    // mongot process throws immediately.
    await withTimeout(
      db.collection('_ready_probe').listSearchIndexes().toArray(),
      TIMEOUT_MS,
    );
    return { status: 'ok' };
  } catch (err) {
    return {
      status: 'error',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function getReadiness(): Promise<ReadinessResult> {
  const now = Date.now();
  if (_cached && now - _cachedAt < CACHE_TTL_MS) {
    return _cached;
  }

  const [mongodb, vectorSearch] = await Promise.all([
    checkMongoDB(),
    checkVectorSearch(),
  ]);

  const result: ReadinessResult = {
    ready: mongodb.status === 'ok' && vectorSearch.status === 'ok',
    checks: { mongodb, vectorSearch },
  };

  _cached = result;
  _cachedAt = now;
  return result;
}
