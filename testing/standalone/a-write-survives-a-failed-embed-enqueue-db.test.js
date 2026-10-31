/**
 * A write whose embed job cannot be queued still lands, and a failed enqueue WARNS, once, with the one spelling of the repair (Q-261).
 *
 * ## The rule
 *
 * `enqueueEmbedJob` never throws into the write it announces: the record is stored, and a job that could not be queued must not fail
 * a caller who cannot retry it. But it used to swallow the failure in silence, so a single local write (a fact, a file's metadata, a
 * peer's file metadata merged by a sync) that lost its job left a record without a vector, or an updated one with the vector and the
 * lexical text of its previous content, and nothing anywhere said so. The failure now warns, naming how many records and the repair
 * (`EMBED_REPAIR_HINT`: `POST /api/spaces/:id/reembed`, which queues both a record that has no vector and an updated one).
 *
 * ## What is asked
 *
 * With the jobs collection failing: a single fact write answers success and warns; a local file-metadata write stores its row and
 * warns; a peer's file metadata merged onto a row that holds its bytes (the sync merge path) stores the row and warns. Each warning
 * says what is true for an update as well as for a new record and names the repair that covers both.
 *
 * Run: node --test testing/standalone/a-write-survives-a-failed-embed-enqueue-db.test.js
 * (requires a prior `npm run build:server`, and the test Mongo)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';

const skip = await mongoSkipReason();

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-enqueue-fails-'));
const CONFIG_PATH = path.join(tmpDir, 'config.json');
process.env['CONFIG_PATH'] = CONFIG_PATH;

const SPACE = 'general';

let mongo, fact, files, shared, log, embedQueue;
let original = null;
let failJobs = false;
const coll = (n) => mongo.col(`${SPACE}_${n}`);

/** Every warning the server logs while `fn` runs, with the jobs collection failing. */
async function warningsWhileFailing(fn) {
  const warned = [];
  const was = log.warn;
  log.warn = (m) => { warned.push(String(m)); };
  failJobs = true;
  try { await fn(); } finally { failJobs = false; log.warn = was; }
  return warned.join('\n');
}

describe('a write survives a failed embed enqueue, and says so', { skip }, () => {
  before(async () => {
    mongo = await openTestMongo('enqueuefails');
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({
      instanceId: 'enqueue-fails-test', instanceLabel: 'test', tokens: [], networks: [],
      spaces: [{ id: SPACE, label: 'General', builtIn: true, folders: [], meta: {} }],
    }, null, 2), { mode: 0o600 });
    (await import('../../server/dist/config/loader.js')).loadConfig();
    fact = await import('../../server/dist/brain/fact.js');
    files = await import('../../server/dist/files/file-meta.js');
    shared = await import('../../server/dist/api/sync/_shared.js');
    embedQueue = await import('../../server/dist/brain/embed-queue.js');
    log = (await import('../../server/dist/util/log.js')).log;
    const proto = Object.getPrototypeOf(mongo.col('probe'));
    original = proto.updateOne;
    proto.updateOne = async function maybeFail(...args) {
      if (failJobs && this.collectionName === `${SPACE}_embed_jobs`) throw new Error('simulated jobs-collection failure');
      return original.apply(this, args);
    };
  });

  after(async () => {
    if (original) Object.getPrototypeOf(mongo.col('probe')).updateOne = original;
    await closeTestMongo();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  beforeEach(async () => {
    failJobs = false;
    for (const c of ['facts', 'files', 'embed_jobs', 'links']) await coll(c).deleteMany({});
  });

  /** The text every warning about a lost job must carry: the count, and the one spelling of the repair. */
  function assertSaysWhatIsTrue(text, what) {
    assert.match(text, /NOT queued for embedding/, `${what} said nothing about a job it could not queue: ${JSON.stringify(text)}`);
    assert.ok(text.includes(embedQueue.EMBED_REPAIR_HINT), `${what} did not use the one spelling of the repair: ${JSON.stringify(text)}`);
    assert.match(text, /an updated one keeps the vector and the lexical text of its previous content/, `${what} does not say what an update is left with`);
    assert.doesNotMatch(text, /queues every record that has no vector|queues them again/, `${what} promises a repair that skips an updated record`);
  }

  it('a single fact write lands and answers success, and the warning says what is true for an update too', async () => {
    let stored;
    const text = await warningsWhileFailing(async () => { stored = await fact.saveFact(SPACE, 'stored although its job could not be queued'); });
    assert.ok(await coll('facts').findOne({ _id: stored._id }), 'the fact was not stored');
    assert.equal(await coll('embed_jobs').countDocuments({}), 0, 'the simulated failure did not apply: the test checks nothing');
    assertSaysWhatIsTrue(text, 'a single fact write');
  });

  it('a local file-metadata write whose job cannot be queued warns instead of passing silently', async () => {
    const text = await warningsWhileFailing(() => files.upsertFileMeta(SPACE, 'docs/enqueue-fails.md', 12, { description: 'stored although its job could not be queued' }));
    assert.ok(await coll('files').findOne({ _id: 'docs/enqueue-fails.md' }), 'the file row was not stored');
    assert.equal(await coll('embed_jobs').countDocuments({}), 0, 'the simulated failure did not apply: the test checks nothing');
    assertSaysWhatIsTrue(text, 'a local file-metadata write');
  });

  it('a peer\'s file metadata merged onto a row that holds its bytes warns when its job cannot be queued', async () => {
    const T0 = '2026-09-01T00:00:00.000Z';
    const id = 'docs/peer-merge.md';
    await coll('files').insertOne({ _id: id, spaceId: SPACE, path: id, tags: [], seq: 1, sizeBytes: 12, sha256: 'a'.repeat(64),
      author: { instanceId: 'peer', instanceLabel: 'Peer' }, createdAt: T0, updatedAt: T0 });
    const text = await warningsWhileFailing(() => shared.ingestFileMeta(SPACE, {
      _id: id, spaceId: SPACE, path: id, tags: [], description: 'a newer description', seq: 2,
      author: { instanceId: 'peer', instanceLabel: 'Peer' }, createdAt: T0, updatedAt: T0,
    }));
    assert.equal((await coll('files').findOne({ _id: id })).seq, 2, 'the merge did not land');
    assert.equal(await coll('embed_jobs').countDocuments({}), 0, 'the simulated failure did not apply: the test checks nothing');
    assertSaysWhatIsTrue(text, 'the file-metadata merge');
  });
});
