/**
 * A write whose embed jobs cannot be queued still lands, and the failure is not silent (`Q-99` part 3).
 *
 * ## The rule
 *
 * The write commit queues the embed jobs of the records it wrote in one batch (`enqueueWriteEmbedJobs`). If that
 * batch fails, the records are stored — failing the write would trade a delayed search hit for lost data — so
 * the write answers success. But a failed batch is many records missing from recall at once, so it is not
 * swallowed quietly either: it warns with the count and the repair.
 *
 * The sweep lane is the opposite on purpose — `enqueueEmbedJobs` REJECTS, because a reindex that swallowed a
 * failed batch would report itself done over records it never queued (`embed-bulk-enqueue-db.test.js`). Both
 * lanes share one runner; whether to swallow is each lane's decision, and this file holds the write lane's.
 *
 * Run: node --test testing/standalone/a-write-survives-a-failed-embed-enqueue-db.test.js
 * (requires a prior `npm run build` in server/, and the test Mongo)
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

let mongo, fact, bulk, log;
let original = null;
let failJobs = false;
const coll = (n) => mongo.col(`${SPACE}_${n}`);

describe('a write survives a failed embed enqueue', { skip }, () => {
  before(async () => {
    mongo = await openTestMongo('enqueuefails');
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({
      instanceId: 'enqueue-fails-test', instanceLabel: 'test', tokens: [], networks: [],
      spaces: [{ id: SPACE, label: 'General', builtIn: true, folders: [], meta: {} }],
    }, null, 2), { mode: 0o600 });
    (await import('../../server/dist/config/loader.js')).loadConfig();
    fact = await import('../../server/dist/brain/fact.js');
    bulk = await import('../../server/dist/brain/bulk.js');
    log = (await import('../../server/dist/util/log.js')).log;
    const proto = Object.getPrototypeOf(mongo.col('probe'));
    original = proto.bulkWrite;
    proto.bulkWrite = async function maybeFail(...args) {
      if (failJobs && this.collectionName === `${SPACE}_embed_jobs`) throw new Error('simulated jobs-collection failure');
      return original.apply(this, args);
    };
  });

  after(async () => {
    if (original) Object.getPrototypeOf(mongo.col('probe')).bulkWrite = original;
    await closeTestMongo();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  beforeEach(async () => {
    failJobs = false;
    for (const c of ['facts', 'embed_jobs', 'links']) await coll(c).deleteMany({});
  });

  it('a single fact write lands and answers success, with a warning naming the count', async () => {
    const warned = [];
    const was = log.warn;
    log.warn = (m) => { warned.push(String(m)); };
    failJobs = true;
    let doc;
    try {
      doc = await fact.saveFact(SPACE, 'stored although its job could not be queued');
    } finally {
      failJobs = false;
      log.warn = was;
    }
    assert.ok(doc?._id, 'the write failed because its embed job could not be queued');
    assert.ok(await coll('facts').findOne({ _id: doc._id }), 'the record was not stored');
    assert.equal(await coll('embed_jobs').countDocuments({}), 0, 'the simulated failure did not apply — the test checks nothing');
    assert.ok(warned.some(m => /1 record\(s\)/.test(m) && /NOT queued/.test(m) && /reembed/.test(m)),
      `no warning said how many records were not queued and how to repair it: ${JSON.stringify(warned)}`);
  });

  it('a batch lands every record and reports no item error for the queue', async () => {
    failJobs = true;
    let res;
    try {
      res = await bulk.bulkWrite(SPACE, { facts: [{ fact: 'one' }, { fact: 'two' }, { fact: 'three' }] });
    } finally {
      failJobs = false;
    }
    assert.equal(res.inserted.facts, 3, `the batch did not write its records: ${JSON.stringify(res)}`);
    assert.deepEqual(res.errors, [], 'a queue failure was reported as the records failing — a resend would duplicate them');
    assert.equal(await coll('facts').countDocuments({}), 3);
  });
});
