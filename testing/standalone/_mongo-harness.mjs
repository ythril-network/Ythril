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
 *
 * ## It never lets the local model download (Q-583)
 *
 * A recall, a write, a merge or a file embed in a database test reaches the local model loader. On a cold cache that
 * starts a download of about 274 MB inside the test's own timeout, which fails a test on a slow link for reasons that
 * have nothing to do with what it tests. So this module, at import and before anything it exports can run, sets the
 * model offline AND points the cache at a path that holds no model and is never created: offline alone, with a warm
 * default cache, would still run real inference. A test that needs ranking uses the stub embedder (`EMBEDDING_URL`).
 * Every database test imports this module, so no test can forget the guard, and
 * `a-database-test-never-downloads-a-model.test.js` forbids a second copy of it.
 *
 * The harness is also imported by `testing/sync/setup.js`, `_shared/reindex-run-seed.mjs` and the bench scripts. They
 * get 'unavailable' from the local model too, which is what they want: a script that measures real inference must
 * not import this module.
 */

import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { absentInputReason } from '../_shared/absent-input.mjs';
import { TEST_MONGO_HOST, TEST_MONGO_PORT } from '../_shared/test-mongo-address.mjs';

process.env['YTHRIL_MODELS_OFFLINE'] = '1';
process.env['MODEL_CACHE_DIR'] = path.join(os.tmpdir(), 'ythril-test-no-model-cache');

/** Host/port of the published test Mongo (`_shared/test-mongo-address.mjs`, so a pure test can read it too). */
export { TEST_MONGO_HOST, TEST_MONGO_PORT };

/**
 * `user:password` for the test Mongo. Set `YTHRIL_TEST_MONGO_CREDS=` (empty) to run the DB-backed files against a
 * developer's own mongod that has no users — together with the host/port overrides above. The default is the
 * test stack's, so CI and `npm run test:up` need nothing set.
 */
const CREDS = process.env['YTHRIL_TEST_MONGO_CREDS'] ?? 'ythril:ythril-test-pw';

/**
 * Connection URI for a dedicated harness database. `port` names a relay standing in front of the test Mongo
 * (`_delayed-write-relay.mjs`); the default is the stack's own. `query` is extra URI options, as an operator would put
 * them in `MONGO_URI` (`'&timeoutMS=300'`): the way a test makes a client whose DEFAULTS differ from the harness's.
 */
export function testMongoUri(dbName, { port = TEST_MONGO_PORT, query = '' } = {}) {
  return `mongodb://${CREDS ? `${CREDS}@` : ''}${TEST_MONGO_HOST}:${port}/${dbName}` +
    `?directConnection=true${CREDS ? '&authSource=admin' : ''}${query}`;
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
 * @param query extra URI options for the server's own client, `'&timeoutMS=300'` (see `testMongoUri`).
 * @returns the live `db/mongo.js` module namespace (`col`, `asFilter`, `asUpdate`, `getDb`, …).
 */
export async function openTestMongo(suite, { port, query } = {}) {
  globalThis.setTimeout = REAL_SET_TIMEOUT; // a file that reopens after a close is not over (see lettingTimersLapse)
  process.env['MONGO_URI'] = testMongoUri(`ythril_harness_${suite}`, { port, query });

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

/**
 * A client of the harness's own for a test's FIXTURE steps — seeding, wiping, holding a lock, reading what a case left — that
 * is not the server's client.
 *
 * ## What it prevents
 *
 * A test that makes the server's client carry an option on purpose (`'&timeoutMS=1500'`, an operator's `MONGO_URI`) makes every
 * fixture step that goes through `openTestMongo`'s module carry it too, and the option is the SUBJECT of the test, not of its
 * setup: on a loaded host a seed, a lock or a read died with `Timed out during socket read (1499ms)` and the case reported "a
 * repetition could not run" — about the machine, not the rule. This client has the driver's defaults, goes straight to the stack
 * (not through a relay that holds writes back) and answers to the harness database the server's client uses, so what the
 * server does and what the fixture sees are one database.
 *
 * It has the SURFACE the fixture helpers read (`getDb`, `getMongo`, `col`), so `holdDocumentLock`, `activeOperations` and
 * `snapshotSpaceInOneRead` take it where they take the server's module. The server's own module is still what runs the write
 * under test.
 *
 * @param suite the same slug the server's client was opened with (`openTestMongo`)
 * @returns {Promise<{ getMongo: () => object, getDb: () => object, col: (name: string) => object, close: () => Promise<void> }>}
 */
export async function openFixtureMongo(suite) {
  const { MongoClient } = await import('mongodb');
  const dbName = `ythril_harness_${suite}`;
  const client = new MongoClient(testMongoUri(dbName));
  await client.connect();
  const db = client.db(dbName);
  return { getMongo: () => client, getDb: () => db, col: (name) => db.collection(name), close: () => client.close() };
}

/**
 * After the database is closed, a timer started by anything is background work and does not hold the process open (Q-623).
 *
 * ## What it prevents
 *
 * A restore leaves the server's `pollVectorIndexReady` polling the swapped search index for up to 60 s, one `setTimeout` of
 * a second after another. The harness has closed the connection by then, so the poll only logs `Client must be connected
 * before running operations` and holds the process open until its own bound. Twelve restore-family files spent those 60 s
 * each AFTER their tests had passed and been reported (`a-restore-counts-the-files-out-of-step-db`: 63.8 s alone, 2.9 s
 * without the wait): 720 s of worker time in a full `-db` run, each one holding a slot of its shard.
 *
 * Two ways of ending the wait were measured and refused. `node --test --test-force-exit` crashes a file whose process still
 * has native work at exit (`a-notice-releases-the-answer-it-does-not-read-db`, 0xC0000409, every time), turning a passing
 * file into a failing one. A harness `process.exit()` after a delay ends the process before node:test has reported the file,
 * so its results line is missing. This takes neither: `closeTestMongo` makes every timer created AFTER it unref'd, the poll's
 * next tick included, so the process ends by itself, the way a file with nothing left to wait for always did, reporting
 * everything. A later `openTestMongo` puts the real `setTimeout` back, so a file that closes and reopens is not affected.
 *
 * The server-side poll that does not stop when its connection closes is the defect; this is the harness not paying for it.
 */
const REAL_SET_TIMEOUT = globalThis.setTimeout;

function lettingTimersLapse() {
  globalThis.setTimeout = (...args) => {
    const timer = REAL_SET_TIMEOUT(...args);
    timer.unref?.();
    return timer;
  };
}

/** Drop the harness database and disconnect. Call from `after()`. */
export async function closeTestMongo() {
  if (!_mongo) return;
  try { await _mongo.getDb().dropDatabase(); } catch { /* best-effort */ }
  await _mongo.closeMongo();
  _mongo = null;
  lettingTimersLapse();
}
