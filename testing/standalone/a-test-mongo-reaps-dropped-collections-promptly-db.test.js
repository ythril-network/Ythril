/**
 * The test Mongo frees a dropped collection within seconds, not after MongoDB's five-minute snapshot window.
 *
 * ## What it cost, measured
 *
 * MongoDB keeps a dropped collection's storage for `minSnapshotHistoryWindowInSeconds` (default 300) so a
 * snapshot read from before the drop still works. Every collection and every index it carries stays OPEN in the
 * storage engine until then. A production instance drops a space now and then; the test suites create and drop
 * thousands of collections in that window. The bundle-30 re-verify found `ythril-mongo-a` holding 9 766 dropped
 * idents and 25 714 open data handles over 147 live collections: mongod at 1.45 GB, of which 0.09 GB was the
 * data cache, and the container at 2.06 GiB of its 2.5 GiB cap after the integration suite alone. CI then runs
 * the standalone suite on the same database, last. Lowering the window to five seconds reaped the 9 000 idents
 * inside 40 s and dropped mongod to 1.03 GB.
 *
 * Nothing in the server reads a snapshot from the past (no `atClusterTime`, no snapshot read concern), so a short
 * window costs the tests nothing they exercise.
 *
 * ## Why a runtime setting, set from two places
 *
 * The `mongodb-atlas-local` image starts mongod with a fixed command line, so the window cannot be set in the
 * compose file; it is a runtime parameter and is lost on restart. `tuneTestMongo` sets it, and it is called by
 * the two things every run passes through: `testing/sync/setup.js`, which provisions the stack after it comes up
 * (CI and `npm run test:up:rebuild`), and `openTestMongo`, which every database-backed file opens — so a
 * standalone run against a mongo-a started on its own is covered too.
 *
 * Run: node --test testing/standalone/a-test-mongo-reaps-dropped-collections-promptly-db.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MongoClient } from 'mongodb';
import {
  mongoSkipReason, openTestMongo, closeTestMongo, testMongoUri, TEST_SNAPSHOT_HISTORY_SECONDS,
} from './_mongo-harness.mjs';
import { stripComments } from './_strip-comments.mjs';

const skip = await mongoSkipReason();
const WINDOW = 'minSnapshotHistoryWindowInSeconds';

describe('the test Mongo reaps dropped collections promptly', { skip }, () => {
  let admin;
  let client;
  let found;

  before(async () => {
    client = new MongoClient(testMongoUri('admin'));
    await client.connect();
    admin = client.db('admin');
    found = (await admin.command({ getParameter: 1, [WINDOW]: 1 }))[WINDOW];
  });

  after(async () => {
    // Put back what this file found, so a red run does not leave the server on the default it simulated.
    await admin?.command({ setParameter: 1, [WINDOW]: found }).catch(() => {});
    await client?.close();
  });

  it('opening the harness shortens the window on a server still at the default', async () => {
    // A freshly started mongo-a is at 300; simulate that, then do what every database-backed file does.
    await admin.command({ setParameter: 1, [WINDOW]: 300 });
    await openTestMongo('reaps-dropped-collections');
    try {
      const now = (await admin.command({ getParameter: 1, [WINDOW]: 1 }))[WINDOW];
      assert.ok(now <= TEST_SNAPSHOT_HISTORY_SECONDS,
        `the window is ${now}s after openTestMongo — dropped collections stay open for that long`);
    } finally {
      await closeTestMongo();
    }
    found = TEST_SNAPSHOT_HISTORY_SECONDS;
  });

  it('the stack provisioning sets it too, so the suites before standalone are covered', () => {
    // integration, sync and redteam open no harness database; setup.js is what runs before them in CI and in
    // test:up:rebuild. A source read because setup.js provisions live instances and cannot be run from a test.
    const setup = stripComments(readFileSync(new URL('../sync/setup.js', import.meta.url), 'utf8'));
    assert.match(setup, /\bawait\s+tuneTestMongo\(\s*\)/, 'testing/sync/setup.js does not call tuneTestMongo()');
  });
});
