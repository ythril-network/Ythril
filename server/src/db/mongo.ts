import { MongoClient, type Db, type Collection } from 'mongodb';
import { getMongoUri } from '../config/loader.js';
import { log } from '../util/log.js';

let _client: MongoClient | null = null;
const DB_NAME = 'ythril';

/** Tri-state: null = not yet checked, true = available, false = unavailable */
let _vectorSearchAvailable: boolean | null = null;
let _vectorSearchDetails = '';

export async function connectMongo(): Promise<MongoClient> {
  const uri = getMongoUri();
  log.debug(`Connecting to MongoDB at ${uri.replace(/\/\/.*@/, '//[credentials]@')}`);
  _client = new MongoClient(uri, {
    serverSelectionTimeoutMS: 10_000,
  });
  await _client.connect();
  log.debug('MongoDB connected');
  return _client;
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

  const db = getMongo().db(DB_NAME);

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

/** Reset the cached availability state (for testing). */
export function _resetVectorSearchCache(): void {
  _vectorSearchAvailable = null;
  _vectorSearchDetails = '';
}

export function getMongo(): MongoClient {
  if (!_client) throw new Error('MongoDB not connected — call connectMongo() first');
  return _client;
}

export function getDb(): Db {
  return getMongo().db(DB_NAME);
}

export function col<T extends object>(name: string): Collection<T> {
  return getDb().collection<T>(name);
}

// Graceful shutdown
export async function closeMongo(): Promise<void> {
  if (_client) {
    await _client.close();
    _client = null;
  }
}
