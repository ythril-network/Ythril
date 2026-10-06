import { MongoClient, type Db, type Collection, type Filter, type UpdateFilter, type OptionalUnlessRequiredId, type AnyBulkWriteOperation } from 'mongodb';
import { getMongoUri } from '../config/loader.js';
import { log, peerText } from '../util/log.js';
import { dbNameFromUri } from './db-name.js';
import { backoffDelayMs } from '../util/backoff.js';
import { envInt } from '../config/env-num.js';
import { observeRecordWrites, EVERY_COLLECTION, type RecordWriteListener } from './record-write-observer.js';
import { warnIfSocketTimeoutBelowWriteBound } from './write-bound.js';
import { mongoClientOptions, effectiveClientOptions, describeClientOptions } from './client-options.js';
import { isStoreUnreachable } from './store-condition.js';

let _client: MongoClient | null = null;
let _dbName = 'ythril';

/** Tri-state: null = not yet checked, true = available, false = unavailable */
let _vectorSearchAvailable: boolean | null = null;
let _vectorSearchDetails = '';

/** Total time the first connection may spend retrying before boot gives up. */
const CONNECT_RETRY_BUDGET_MS = envInt('MONGO_CONNECT_RETRY_MS', 30_000);

/**
 * The words that say WHICH failure a boot retry is waiting on: the driver's class, and the server's code and name for it
 * when it gave them. `MongoServerError 11600 InterruptedAtShutdown` tells an operator what the store is doing; `MongoServerError`
 * alone does not. The server's name is the server's own text, so it goes through `peerText` like every value that came from
 * outside.
 */
function describeConnectFailure(err: unknown): string {
  const e = err as { name?: unknown; code?: unknown; codeName?: unknown } | null;
  const name = typeof e?.name === 'string' && e.name ? e.name : 'Error';
  if (typeof e?.code !== 'number') return peerText(name);
  const codeName = typeof e.codeName === 'string' && e.codeName ? ` ${peerText(e.codeName)}` : '';
  return `${peerText(name)} ${e.code}${codeName}`;
}

/**
 * Connect, retrying while the store cannot answer YET, and only then.
 *
 * ## What is retried: one predicate
 *
 * `isStoreUnreachable` (`db/store-condition.ts`), the same question the request path and the housekeeping walk ask. It
 * used to be a list of four class names and five server codes here. A name list cannot see a subclass (a pool cleared by a
 * network failure is `MongoPoolClearedError`, a class the driver does not export), and the list had already diverged from
 * the other two answers. What it accepts is the store being unreachable: a network error or timeout, a server that cannot
 * be selected, a closed or exhausted pool, a closed client, a primary stepping down or a host that cannot be reached by
 * code, and anything the driver itself labels as one to try again. What stays fail-fast is what waiting cannot cure:
 * `AuthenticationFailed` (18), a malformed URI, missing credentials, and a plain `Error` that merely carries a store-looking
 * name. An authentication failure retried for thirty seconds turns a clear immediate error into a boot that appears to hang.
 *
 * ## How long one attempt may take: `mongoClientOptions`
 *
 * The client is built from `db/client-options.ts`, the one place its liveness options live: an option the connection string
 * names is the operator's and wins, and the rest are the module's defaults. The effective figures are logged once, before
 * the first attempt, so a boot that never connects still says what it was waiting under. `serverSelectionTimeoutMS` is
 * therefore operator-overridable here; it used to be an inline 10 s that beat the URI's.
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
 * The selection timeout does not cover it — that governs *selecting* a server, while this is the
 * socket being reset mid-handshake, which rejects immediately.
 */
export async function connectMongo(): Promise<MongoClient> {
  const uri = getMongoUri();
  _dbName = dbNameFromUri(uri);
  const safeUri = uri.replace(/\/\/[^@]*@/, '//[credentials]@');
  log.debug(`Connecting to MongoDB at ${peerText(safeUri)} (database: ${peerText(_dbName)})`);

  // Once per boot and before the first attempt: what the client will wait under, and which figures are the operator's.
  log.info(describeClientOptions(effectiveClientOptions(uri)));

  const deadline = Date.now() + CONNECT_RETRY_BUDGET_MS;
  for (let attempt = 1; ; attempt++) {
    _client = new MongoClient(uri, mongoClientOptions(uri));
    try {
      await _client.connect();
      if (attempt > 1) log.info(`MongoDB connected after ${attempt} attempts.`);
      else log.debug('MongoDB connected');
      // Once per connection, after it works: a string that cannot connect has a worse thing to say.
      warnIfSocketTimeoutBelowWriteBound(uri);
      return _client;
    } catch (err) {
      // Close the failed client before making another, or each retry leaks its topology and its timers.
      await _client.close().catch(() => { /* it never opened */ });
      if (!isStoreUnreachable(err) || Date.now() >= deadline) throw err;
      // 250 ms doubling to 4 s, equal-jittered: attempt 1 of the loop is the helper's attempt 0.
      const wait = backoffDelayMs(attempt - 1, 250, 4_000);
      log.warn(`MongoDB not ready yet (${describeConnectFailure(err)}, attempt ${attempt}); retrying in ${wait}ms.`);
      await new Promise(r => setTimeout(r, wait));
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

/**
 * Who hears about writes to a space's record collections (Q-165) — see `db/record-write-observer.ts`.
 *
 * A registry rather than an import, so the db layer does not depend on the modules that listen:
 * `spaces/search-index-presence.ts` and `brain/space-shape.ts` subscribe when they are loaded.
 *
 * **Each listener keeps its OWN collections** (`Q-95`). This held one predicate for the whole registry and each
 * subscription overwrote it — invisible while there was one subscriber, and a silent re-scoping of the first the
 * day a second arrived: the index lifecycle would have heard the collections the shape cache asked for, or missed
 * its own, depending on which module loaded last. A write is observed if ANY listener wants its collection, and
 * reported only to the listeners that do.
 */
const recordWriteListeners: { wants: (name: string) => boolean; listener: RecordWriteListener }[] = [];

/** Subscribe to the writes `getDb()` observes, on the collections `isRecordCollection` names. */
export function onRecordCollectionWrite(isRecordCollection: (name: string) => boolean, listener: RecordWriteListener): void {
  recordWriteListeners.push({ wants: isRecordCollection, listener });
}

/**
 * Tell every listener that the database changed underneath the observer, so whatever it knew is void.
 *
 * For the one kind of write `getDb()` cannot see: a writer on its own client. The restore is the one that exists
 * (`db/restore.ts`, exempted in `a-record-write-reaches-the-index-presence-observer.test.js`), and it drops and
 * rewrites every collection. Reported as a `forget` on {@link EVERY_COLLECTION}, to every listener whatever its
 * predicate — a listener that ignored it would keep answering from the database as it was before the restore.
 */
export function reportDatabaseReplaced(): void {
  for (const { listener } of recordWriteListeners) {
    try { listener(EVERY_COLLECTION, { forget: true }); } catch { /* a listener logs its own failures */ }
  }
}

let observedDb: { client: MongoClient; name: string; db: Db } | null = null;

/**
 * The database every reader and writer in this process uses — and it reports the writes it carries.
 *
 * Built once per client and database name: the wrapper is a pair of proxies, and `getDb()` is on every query.
 */
export function getDb(): Db {
  const client = getMongo();
  if (observedDb && observedDb.client === client && observedDb.name === _dbName) return observedDb.db;
  const db = observeRecordWrites(client.db(_dbName), name => recordWriteListeners.some(l => l.wants(name)), (name, effect) => {
    for (const l of recordWriteListeners) if (l.wants(name)) l.listener(name, effect);
  });
  observedDb = { client, name: _dbName, db };
  return db;
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
