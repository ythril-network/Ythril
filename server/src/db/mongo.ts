import { MongoClient, type Db, type Collection, type Document, type Filter, type UpdateFilter, type OptionalUnlessRequiredId, type AnyBulkWriteOperation } from 'mongodb';
import { getMongoUri } from '../config/loader.js';
import { log } from '../util/log.js';
import { dbNameFromUri } from './db-name.js';
import { withJitter } from '../util/backoff.js';
import { envInt } from '../config/env-num.js';

let _client: MongoClient | null = null;
let _dbName = 'ythril';

/** Tri-state: null = not yet checked, true = available, false = unavailable */
let _vectorSearchAvailable: boolean | null = null;
let _vectorSearchDetails = '';

/** Total time the first connection may spend retrying before boot gives up. */
const CONNECT_RETRY_BUDGET_MS = envInt('MONGO_CONNECT_RETRY_MS', 30_000);

/**
 * Errors worth retrying: the database is there but not yet able to hold a connection.
 *
 * An **allowlist**, so anything unrecognised is thrown immediately rather than retried. That is the
 * safer default here: an authentication failure or a malformed URI will never succeed however long we
 * wait, and quietly retrying one for thirty seconds turns a clear immediate error into a boot that
 * appears to hang. `MongoServerError` (bad credentials) and `MongoParseError` (bad URI) are excluded by
 * simply not being on the list.
 *
 * An earlier version also carried an explicit `if (MongoServerError || MongoParseError) return false`
 * line. Mutation testing showed deleting it changed nothing — the allowlist already excluded them — so
 * it was a line that read like a safeguard and did no work. Removed rather than left to be trusted.
 */
const TRANSIENT_CONNECT_ERRORS = new Set([
  'MongoNetworkError',          // ECONNRESET / ECONNREFUSED — the observed CI failure
  'MongoNetworkTimeoutError',
  'MongoServerSelectionError',  // nothing answering yet
  'MongoTopologyClosedError',
]);

/**
 * Transient `MongoServerError` **codes** — because the name alone cannot decide this one.
 *
 * The allowlist above excludes `MongoServerError` on purpose: bad credentials carry that name, and retrying
 * them for thirty seconds turns a clear error into a boot that appears to hang. But so does this, observed in
 * CI on #774 with the container dying at startup:
 *
 *     Fatal startup error: MongoServerError: interrupted at shutdown
 *         at async continueScramConversation (…/cmap/auth/scram.js:131:15)
 *
 * That is the same boot race the class comment above describes, one layer later. The replica-set entrypoint
 * restarts mongod after initiation, and a driver that opened a socket just before gets interrupted **mid-SCRAM**.
 * The healthcheck had already passed. Whichever instance loses the race dies, which is why it reads as a flake
 * and moves between containers.
 *
 * So the name bounds the *class* of failure and says nothing about its *transience* — the discriminator is the
 * server's error code. Retry these; anything else keeping the `MongoServerError` name, `AuthenticationFailed`
 * (18) above all, still fails immediately.
 */
const TRANSIENT_SERVER_ERROR_CODES = new Set([
  11600,  // InterruptedAtShutdown — the observed failure
  91,     // ShutdownInProgress
  11602,  // InterruptedDueToReplStateChange
  189,    // PrimarySteppedDown
  13436,  // NotPrimaryOrSecondary — stepping up during rs initiation
]);

function isTransientConnectError(err: unknown): boolean {
  const name = (err as { name?: string } | null)?.name ?? '';
  if (TRANSIENT_CONNECT_ERRORS.has(name)) return true;
  // Narrow by code, and only for the one name where a code can mean "not up yet". Widening by code alone would
  // re-admit every unrecognised failure the allowlist exists to reject.
  if (name !== 'MongoServerError') return false;
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'number' && TRANSIENT_SERVER_ERROR_CODES.has(code);
}

/**
 * Connect, retrying while the failure looks like "not up yet".
 *
 * ## Why this is not over-engineering
 *
 * `ythril-d exited (1)` had failed CI three times across this release and was carried as "still
 * undiagnosed" — the container's own log finally showed it:
 *
 *     Fatal startup error: MongoNetworkError: read ECONNRESET
 *
 * Compose waits for the Mongo container's healthcheck, and the healthcheck passes while mongod/mongot is
 * still finishing startup — so the very first driver connection gets its socket reset. One attempt, one
 * rejection, `main().catch` exits 1, and a perfectly healthy stack fails to come up. Whichever instance
 * loses the race dies; that is why it moved between `ythril-b` and `ythril-d` and read as a flake.
 *
 * It is not only a CI concern. The same shape is a Mongo restart or failover underneath a running
 * deployment: the pod dies on a blip that would have cleared in under a second.
 *
 * `serverSelectionTimeoutMS` does not cover it — that governs *selecting* a server, while this is the
 * socket being reset mid-handshake, which rejects immediately.
 */
export async function connectMongo(): Promise<MongoClient> {
  const uri = getMongoUri();
  _dbName = dbNameFromUri(uri);
  const safeUri = uri.replace(/\/\/[^@]*@/, '//[credentials]@');
  log.debug(`Connecting to MongoDB at ${safeUri} (database: ${_dbName})`);

  const deadline = Date.now() + CONNECT_RETRY_BUDGET_MS;
  let delay = 250;
  for (let attempt = 1; ; attempt++) {
    _client = new MongoClient(uri, { serverSelectionTimeoutMS: 10_000 });
    try {
      await _client.connect();
      if (attempt > 1) log.info(`MongoDB connected after ${attempt} attempts.`);
      else log.debug('MongoDB connected');
      return _client;
    } catch (err) {
      // Close the failed client before making another, or each retry leaks its topology and its timers.
      await _client.close().catch(() => { /* it never opened */ });
      const name = (err as { name?: string } | null)?.name ?? 'Error';
      if (!isTransientConnectError(err) || Date.now() >= deadline) throw err;
      const wait = withJitter(delay);
      log.warn(`MongoDB not ready yet (${name}, attempt ${attempt}); retrying in ${wait}ms.`);
      await new Promise(r => setTimeout(r, wait));
      delay = Math.min(delay * 2, 4_000);
    }
  }
}

/**
 * Probe whether `$vectorSearch` is available on the connected MongoDB.
 *
 * Strategy: run a minimal `$vectorSearch` aggregation against a temporary
 * probe collection.  The stage is recognised immediately — before any index
 * or collection look-up — so we can distinguish three outcomes:
 *
 *  - Stage unknown / unrecognised → not available (vanilla MongoDB < 8.0)
 *  - Any other error (index not found, collection missing, etc.) → available
 *  - Success (empty result set) → available
 *
 * The result is cached; subsequent calls return the cached value instantly.
 */
export async function checkVectorSearchAvailability(): Promise<{
  available: boolean;
  details: string;
}> {
  if (_vectorSearchAvailable !== null) {
    return { available: _vectorSearchAvailable, details: _vectorSearchDetails };
  }

  const db = getDb();

  // Collect server version for the log message
  let serverVersion = 'unknown';
  try {
    const info = await db.admin().command({ buildInfo: 1 }) as { version?: string };
    if (typeof info.version === 'string') serverVersion = info.version;
  } catch { /* best-effort */ }

  // Probe: a $vectorSearch on a dummy collection with a zero-dimensional query.
  // The stage is validated before collection/index resolution, so an "unknown
  // stage" error fires immediately on servers that don't support it.
  try {
    await db.collection('_vectorsearch_probe').aggregate([
      {
        $vectorSearch: {
          index: '_probe_idx',
          path: 'embedding',
          queryVector: [0, 0, 0],
          numCandidates: 1,
          limit: 1,
        },
      },
    ]).toArray();
    // Aggregation succeeded (0 results expected) — stage is supported.
    _vectorSearchAvailable = true;
    _vectorSearchDetails = `MongoDB ${serverVersion}`;
    return { available: true, details: _vectorSearchDetails };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    // "Unrecognized pipeline stage name: '$vectorSearch'" (or similar wording)
    // means the stage does not exist on this server.
    if (/unrecognized|unknown.*stage|no.*such.*stage|\$vectorSearch.*not.*support/i.test(msg)) {
      _vectorSearchAvailable = false;
      _vectorSearchDetails = `MongoDB ${serverVersion}`;
      return { available: false, details: _vectorSearchDetails };
    }
    // Any other error (index not found, collection not found, wrong dimensions…)
    // means the stage IS recognised — $vectorSearch is available.
    _vectorSearchAvailable = true;
    _vectorSearchDetails = `MongoDB ${serverVersion}`;
    return { available: true, details: _vectorSearchDetails };
  }
}

/** Returns true if `$vectorSearch` is available on the connected MongoDB. */
export function isVectorSearchAvailable(): boolean {
  return _vectorSearchAvailable === true;
}

/** Reset the active database name (for testing). */
export function _resetDbName(): void {
  _dbName = '';
}

export function getMongo(): MongoClient {
  if (!_client) throw new Error('MongoDB not connected — call connectMongo() first');
  return _client;
}

export function getDb(): Db {
  return getMongo().db(_dbName);
}

export function col<T extends object>(name: string): Collection<T> {
  return getDb().collection<T>(name);
}

// ── Typing bridges (NOT validators) ─────────────────────────────────────────
//
// The helpers below are pure `as unknown as` casts that bridge our plain document
// interfaces to MongoDB's strict generics (which expect an index signature). They
// perform NO sanitisation and NO validation: an object that is hostile going in is
// still hostile coming out.
//
// This matters because a lot of peer-supplied sync data passes through them. Real
// validation of ingested documents happens at the call sites, via the Zod
// `Incoming*Doc` schemas in `api/sync.ts` — not here.
//
// They are named `as*` precisely so they read as casts. The previous `m`-prefixed
// names read like "sanitise for Mongo", which is exactly the wrong assumption to
// invite for code on the sync-ingest path.

/**
 * Cast a plain object to MongoDB's `Filter<T>`. A typing bridge, not a sanitiser.
 * The cast is semantically correct: the object IS intended as a filter for T.
 */
export function asFilter<T extends object>(f: Record<string, unknown>): Filter<T> {
  return f as unknown as Filter<T>;
}

/**
 * Cast a document value to `OptionalUnlessRequiredId<T>` for insertOne / replaceOne.
 * A typing bridge, not a sanitiser: d is the document being inserted.
 */
export function asDoc<T extends object>(d: T | Record<string, unknown>): OptionalUnlessRequiredId<T> {
  return d as unknown as OptionalUnlessRequiredId<T>;
}

/**
 * Cast a plain update-operator object to MongoDB's `UpdateFilter<T>`.
 * A typing bridge, not a sanitiser: u is an update descriptor (`{ $set: {...} }`) for T.
 */
export function asUpdate<T extends object>(u: Record<string, unknown>): UpdateFilter<T> {
  return u as unknown as UpdateFilter<T>;
}

/**
 * Cast a bulk-write operations array to `AnyBulkWriteOperation<T>[]`.
 * A typing bridge, not a sanitiser.
 */
export function asBulk<T extends object>(ops: unknown[]): AnyBulkWriteOperation<T>[] {
  return ops as unknown as AnyBulkWriteOperation<T>[];
}

// Graceful shutdown
export async function closeMongo(): Promise<void> {
  if (_client) {
    await _client.close();
    _client = null;
    _dbName = '';
  }
}
