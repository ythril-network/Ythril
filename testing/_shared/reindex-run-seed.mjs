/**
 * Hold a reindex run open on instance A by writing its run document straight into A's database.
 *
 * ## Why seed rather than start one
 *
 * A real reindex of a test space is over in well under the watcher's 5 s tick, so "send two and expect one 409"
 * passed or failed on timing — which is why `reindex-contract` and `mcp-reindex` used to accept `[200, 409]`, and
 * an assertion that accepts both outcomes tests neither. A seeded ACTIVE run (no `error`, `sweepComplete: false`)
 * is the state the per-space guard reads, held for exactly as long as the test needs it and removed after.
 *
 * `sweepComplete: false` is deliberate: the watcher deletes a run only once its sweep is complete and no rebuild
 * job remains, so a seeded incomplete run is not finished out from under the test.
 *
 * ## Where it writes
 *
 * The published test Mongo (`ythril-mongo-a`, 127.0.0.1:27117, the harness URI) and the database name instance A
 * itself uses — read from the container's own `MONGO_URI` through the server's `dbNameFromUri`, never written
 * here, so a compose change that names the database moves this with it. The collection name comes from the
 * server's registry (`spaceCollection(space, 'reindexRun')`), so a kind that does not exist fails here, loudly.
 */
import { MongoClient } from 'mongodb';
import { dockerExec } from '../sync/helpers.js';
import { testMongoUri } from '../standalone/_mongo-harness.mjs';

let _client = null;
let _dbName = null;

async function stackDb() {
  if (!_dbName) {
    const { dbNameFromUri } = await import('../../server/dist/db/db-name.js');
    const uri = dockerExec('docker exec ythril-a printenv MONGO_URI').trim();
    _dbName = dbNameFromUri(uri);
  }
  if (!_client) {
    _client = new MongoClient(testMongoUri(_dbName), { serverSelectionTimeoutMS: 5_000 });
    await _client.connect();
  }
  return _client.db(_dbName);
}

async function runCollection(spaceId) {
  const { spaceCollection } = await import('../../server/dist/db/space-collection.js');
  return (await stackDb()).collection(spaceCollection(spaceId, 'reindexRun'));
}

/** Write an ACTIVE run for `spaceId` on instance A. */
export async function seedActiveReindexRun(spaceId, extra = {}) {
  const coll = await runCollection(spaceId);
  await coll.replaceOne({ _id: 'run' }, {
    _id: 'run', spaceId, members: [spaceId], flagged: false,
    target: { model: 'seeded-by-test', dimensions: 0, prefixScheme: 'none' },
    startedAt: new Date().toISOString(), cursor: null, sweepComplete: false, ...extra,
  }, { upsert: true });
}

/** Write a FAILED rebuild job, so `reindexRun.failed` has something to count that the worker will not take. */
export async function seedFailedRebuildJob(spaceId, recordId) {
  const { spaceCollection } = await import('../../server/dist/db/space-collection.js');
  const now = new Date().toISOString();
  await (await stackDb()).collection(spaceCollection(spaceId, 'embedJobs')).replaceOne(
    { _id: `fact:${recordId}` },
    {
      _id: `fact:${recordId}`, spaceId, recordType: 'fact', recordId, status: 'failed', rebuild: true, priority: 2,
      attempts: 5, maxAttempts: 5, transientFailures: 0, lostChildFailures: 0, lastError: 'seeded by test',
      claimedAt: null, progressAt: null, claimableAfter: null, claimToken: null, createdAt: now, updatedAt: now,
    },
    { upsert: true },
  );
}

/** Remove what the seeders wrote for `spaceId`. Safe to call when nothing was seeded. */
export async function clearSeededReindexState(spaceId) {
  try { await (await runCollection(spaceId)).deleteMany({}); } catch { /* nothing seeded */ }
  try {
    const { spaceCollection } = await import('../../server/dist/db/space-collection.js');
    await (await stackDb()).collection(spaceCollection(spaceId, 'embedJobs')).deleteMany({ lastError: 'seeded by test' });
  } catch { /* nothing seeded */ }
}

export async function closeReindexSeed() {
  await _client?.close();
  _client = null;
}
