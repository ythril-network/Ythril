/**
 * Database-level test harness — run a standalone test against a REAL MongoDB.
 *
 * ## Why this exists
 *
 * Standalone tests could not reach a database. The test stack published no Mongo port and nothing
 * connected to one, so every query rule in the codebase was only ever checked against hand-built
 * document fixtures and a minimal JS matcher. That checks *the rule as the author imagined it*, not
 * that MongoDB agrees — and those two things genuinely differ. The canonical example, live in this
 * repo: `{ progressAt: null }` matches documents where the field is **missing** in MongoDB, but a JS
 * matcher written the obvious way (`doc.progressAt === null`) does not. A fixture test cannot see
 * that; a database test cannot miss it.
 *
 * It is the same failure shape as the 204-null-body bug — a stand-in that passed while the real path
 * was broken. `_AUDIT-ANGLES.md §10` names it: "a mock that would pass even if the real code is
 * broken".
 *
 * ## What it connects to
 *
 * `ythril-mongo-a` from `testing/docker-compose.test.yml`, published on **127.0.0.1:27117**. Bring it
 * up with `npm run test:up`. CI already has the stack running when it invokes `test:standalone`, so
 * these tests execute there on every run.
 *
 * ## What it does NOT do
 *
 * It does not stub, wrap or re-implement the data layer. `withMongo()` points the server's own
 * `getMongoUri()` at the test database and calls the server's own `connectMongo()`, so the code under
 * test is the real `col()` / `asFilter()` / `asUpdate()` — production's Mongo layer, against
 * production's driver, against a real server. A harness that faked any of that would reintroduce the
 * exact gap it was built to close.
 *
 * Each caller gets its own database (`ythril_harness_<suite>`), dropped on entry and exit, so the
 * harness can never see or corrupt the data the integration/sync suites are using on the same server.
 */

import net from 'node:net';
import { absentInputReason } from '../_shared/absent-input.mjs';

/** Host/port of the published test Mongo. Override for a non-default stack. */
export const TEST_MONGO_HOST = process.env['YTHRIL_TEST_MONGO_HOST'] ?? '127.0.0.1';
export const TEST_MONGO_PORT = Number(process.env['YTHRIL_TEST_MONGO_PORT'] ?? 27117);

/**
 * `user:password` for the test Mongo. Set `YTHRIL_TEST_MONGO_CREDS=` (empty) to run the DB-backed files against a
 * developer's own mongod that has no users — together with the host/port overrides above. The default is the
 * test stack's, so CI and `npm run test:up` need nothing set.
 */
const CREDS = process.env['YTHRIL_TEST_MONGO_CREDS'] ?? 'ythril:ythril-test-pw';

/**
 * Connection URI for a dedicated harness database. `port` names a relay standing in front of the test Mongo
 * (`_delayed-write-relay.mjs`); the default is the stack's own.
 */
export function testMongoUri(dbName, { port = TEST_MONGO_PORT } = {}) {
  return `mongodb://${CREDS ? `${CREDS}@` : ''}${TEST_MONGO_HOST}:${port}/${dbName}` +
    `?directConnection=true${CREDS ? '&authSource=admin' : ''}`;
}

/**
 * Fast reachability probe. `connectMongo()` waits 10s on server selection, which is a long time to
 * spend discovering that a developer simply has not run `npm run test:up`.
 */
export async function isTestMongoUp(timeoutMs = 1500) {
  return new Promise(resolve => {
    const sock = new net.Socket();
    const done = (ok) => { sock.destroy(); resolve(ok); };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false));
    sock.once('error', () => done(false));
    sock.connect(TEST_MONGO_PORT, TEST_MONGO_HOST);
  });
}

/**
 * Reason to pass to `describe(..., { skip })`, or `false` when the database is available.
 *
 * **In CI this never skips — it throws.** A database test that silently turns into a no-op on the one
 * machine that gates merges is worse than no test at all: the suite still reports green, and the
 * coverage it claims does not exist. Locally, skipping with an actionable message is the right
 * behaviour; on CI, an unreachable database is a broken harness and must fail loudly.
 */
export async function mongoSkipReason() {
  if (await isTestMongoUp()) return false;
  const where = `${TEST_MONGO_HOST}:${TEST_MONGO_PORT}`;
  return absentInputReason(
    `needs the test MongoDB at ${where} — run \`npm run test:up\``,
    'The test stack must be up for standalone tests in CI. Check that testing/docker-compose.test.yml still '
    + 'publishes the ythril-mongo-a port.',
  );
}

/**
 * Seconds the test Mongo keeps a dropped collection open for snapshot reads (MongoDB's default is 300).
 * See `a-test-mongo-reaps-dropped-collections-promptly-db.test.js` for what the default cost.
 */
export const TEST_SNAPSHOT_HISTORY_SECONDS = 5;

/**
 * Make the test Mongo free dropped collections within seconds. The suites drop thousands of collections inside
 * MongoDB's default five-minute window, and each one holds its storage handles open until the window passes —
 * enough to take mongo-a to its memory cap. A runtime parameter, because the image fixes mongod's command line,
 * so it is lost on restart and set again by every caller. It THROWS rather than warning: a run that silently
 * keeps the default is the out-of-memory failure this exists to prevent, blamed on whichever test was unlucky.
 */
export async function tuneTestMongo() {
  const { MongoClient } = await import('mongodb');
  const client = new MongoClient(testMongoUri('admin'), { serverSelectionTimeoutMS: 10_000 });
  try {
    await client.connect();
    await client.db('admin').command({ setParameter: 1, minSnapshotHistoryWindowInSeconds: TEST_SNAPSHOT_HISTORY_SECONDS });
  } finally {
    await client.close();
  }
}

let _mongo = null;

/**
 * Connect the server's real Mongo layer to a dedicated harness database. Call from `before()`.
 *
 * `MONGO_URI` is set before importing `db/mongo.js` because `getMongoUri()` reads the environment
 * first — that is the documented override for infra-managed deployments, and reusing it here means
 * the harness needs no test-only branch inside production code.
 *
 * @param suite short slug — becomes the database name, so two suites never share state.
 * @param port  connect through a relay on this port instead of the stack's (`_delayed-write-relay.mjs`).
 * @returns the live `db/mongo.js` module namespace (`col`, `asFilter`, `asUpdate`, `getDb`, …).
 */
export async function openTestMongo(suite, { port } = {}) {
  process.env['MONGO_URI'] = testMongoUri(`ythril_harness_${suite}`, { port });

  const mongo = await import('../../server/dist/db/mongo.js');
  mongo._resetDbName?.();
  await mongo.connectMongo();
  // Held from the moment it is open, so `closeTestMongo` can close it whatever fails next: an open client keeps
  // the test process alive, and node's runner then waits on that file for ever instead of reporting it failed.
  _mongo = mongo;

  // Drop on ENTRY as well as exit: a previous run killed mid-test (Ctrl-C, CI timeout) would
  // otherwise leave documents behind and the next run would inherit them, which is how a
  // database-backed suite starts passing for the wrong reason.
  try {
    await tuneTestMongo();
    await mongo.getDb().dropDatabase();
  } catch (err) {
    await closeTestMongo();
    throw err;
  }
  return mongo;
}

/** Drop the harness database and disconnect. Call from `after()`. */
export async function closeTestMongo() {
  if (!_mongo) return;
  try { await _mongo.getDb().dropDatabase(); } catch { /* best-effort */ }
  await _mongo.closeMongo();
  _mongo = null;
}
