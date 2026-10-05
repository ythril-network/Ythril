/**
 * A failed embed job stores OUR sentence and the error's class — never the driver's message — in the `lastError` that
 * `GET /api/brain/spaces/:id/embedding-queue/records` and `list_embed_jobs` serve (`Q-361`, the security lens' SEC-1).
 *
 * ## The channel the answer-side fixes did not reach
 *
 * `embed-worker.ts` takes `err.message` of ANY throw from `embedStoredRecord` — which reads and writes the store — and
 * hands it to `failEmbedJob`, which keeps `errorMessage.slice(0, 500)`. A store failure that hit an embed job therefore
 * stored `connection 5 to 172.16.0.9:27017 closed`, and a read token (`list_embed_jobs` is `knowledge: read`) read it
 * back. That is a driver's text leaving by STORAGE rather than by a response, so no check of the answers could see it; the
 * gate (`an-error-reaches-a-caller-only-through-caughtFailureText`) derives the writers of a `lastError` for it, and this
 * test shows what ends up on the record.
 *
 * ## What is stored
 *
 * - **a driver-side failure**: `The store could not complete this request.` plus the error's class (`MongoNetworkError`),
 *   which is stable — so `failedByReason`, which groups jobs by their `lastError`, still groups them, and two jobs that
 *   failed against different hosts read alike;
 * - **our own error**: its message, cut at 500 characters as before — an embedder that is down says so in its own words and
 *   an operator reads which.
 *
 * Driven through the real worker (`runOneEmbedJob`) against a real MongoDB, with the driver's own error class thrown where
 * the worker reads the record. The model is unreachable here (as in `embed-jobs-are-visible-db.test.js`), which is the
 * own-error case for free.
 *
 * ## Seen red
 *
 * On 6eb5a333 (v5.6.3): `lastError` is `connection 5 to 172.16.0.9:27017 closed` — the driver's message, verbatim.
 *
 * Run: a Mongo the harness accepts (see `_mongo-harness.mjs`), then
 *      node --test testing/standalone/an-embed-job-stores-no-driver-text-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';
import { HOST_TEXT, LEAK, SENTENCES, wrappers, driver } from './_store-failure-fixtures.mjs';

const skip = await mongoSkipReason();

const SPACE = 'general';
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-embed-lasterror-'));
const CONFIG_PATH = path.join(tmpDir, 'config.json');
process.env['CONFIG_PATH'] = CONFIG_PATH;
const EMPTY_CACHE = path.join(tmpDir, 'empty-model-cache');
fs.mkdirSync(EMPTY_CACHE, { recursive: true });
process.env['YTHRIL_MODELS_OFFLINE'] = '1';
process.env['MODEL_CACHE_DIR'] = EMPTY_CACHE;
const WRAPPERS = await wrappers();

let mongo, memory, queue, worker, embed;

const jobs = () => mongo.col(`${SPACE}_embed_jobs`);
const facts = () => mongo.col(`${SPACE}_facts`);

const writeFact = async (text) => (await memory.saveFact(SPACE, text, [], []))._id;

/** Run one worker turn with the record read failing in the driver's own way. */
async function failingOnRead(error) {
  const original = driver.Collection.prototype.findOne;
  driver.Collection.prototype.findOne = function findOne(...args) {
    if (this.collectionName === `${SPACE}_facts`) return Promise.reject(error);
    return original.apply(this, args);
  };
  try { return await worker.runOneEmbedJob(); } finally { driver.Collection.prototype.findOne = original; }
}

const lastErrors = async () => (await queue.listEmbedJobs(SPACE)).map(j => j.lastError);

describe('an embed job stores no driver text in its lastError (real MongoDB)', { skip }, () => {
  before(async () => {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({ spaces: [{ id: SPACE, label: 'General' }], networks: [], tokens: [] }, null, 2));
    mongo = await openTestMongo('embedlasterror');
    (await import('../../server/dist/config/loader.js')).loadConfig();
    memory = await import('../../server/dist/brain/fact.js');
    queue = await import('../../server/dist/brain/embed-queue.js');
    worker = await import('../../server/dist/brain/embed-worker.js');
    ({ embed } = await import('../../server/dist/brain/embedding.js'));
  });
  after(async () => {
    await closeTestMongo();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });
  beforeEach(async () => {
    await jobs().deleteMany({});
    await facts().deleteMany({});
    queue.resetEmbedPendingHint();
  });

  it('PIN: our own error is stored in its own words, cut at 500 — an embedder that is down says so', async () => {
    await writeFact('the embedder is not reachable for this one');
    let expected;
    try { await embed('anything'); } catch (err) { expected = err.message; }
    assert.ok(expected, 'fixture check: the model is reachable, so there is no own error to store');
    assert.equal(await worker.runOneEmbedJob(), true, 'the worker claimed nothing');
    assert.deepEqual(await lastErrors(), [expected.slice(0, 500)]);
  });

  it('a store failure under the worker: the record carries our sentence and the class, not the driver\'s message', async () => {
    await writeFact('a record whose read fails in the driver');
    assert.equal(await failingOnRead(new driver.MongoNetworkError(HOST_TEXT)), true);
    const [lastError] = await lastErrors();
    assert.ok(lastError, 'the failure left no lastError at all');
    assert.doesNotMatch(lastError, LEAK, `the record stores the driver's text: ${lastError}`);
    assert.ok(lastError.includes(SENTENCES.incomplete), `not our sentence: ${lastError}`);
    assert.ok(lastError.includes('MongoNetworkError'), `the class is what an operator groups by: ${lastError}`);
  });

  it('two jobs that failed against DIFFERENT hosts read alike, so failedByReason still groups them', async () => {
    await writeFact('first');
    await failingOnRead(new driver.MongoNetworkError('connection 5 to 172.16.0.9:27017 closed'));
    await jobs().deleteMany({});
    await writeFact('second');
    await failingOnRead(new driver.MongoNetworkError('connection 8 to 10.9.9.9:27018 closed'));
    const [a] = await lastErrors();
    await jobs().deleteMany({});
    await facts().deleteMany({});
    await writeFact('third');
    await failingOnRead(new driver.MongoNetworkError('connection 5 to 172.16.0.9:27017 closed'));
    const [b] = await lastErrors();
    assert.equal(a, b, 'the stored text depends on the host, so two outages of one kind never group');
  });

  it('the class is kept for a driver class that is not a network error (a server selection that failed)', async () => {
    await writeFact('pool');
    await failingOnRead(new driver.MongoServerSelectionError('getaddrinfo ENOTFOUND mongo-a.internal', {}));
    const [lastError] = await lastErrors();
    assert.doesNotMatch(lastError, LEAK);
    assert.ok(lastError.includes('MongoServerSelectionError'), lastError);
  });

  // The three fields an error travels inside another by (`cause`, `underlying`, `errorResponse`), each built by its own
  // class: the wrapper's message quotes the driver's, so a store that looked only at the outermost error would keep it.
  for (const { label, wrap } of WRAPPERS) {
    it(`a driver failure carried in \`${label}\`: the record carries our sentence, none of the driver's text`, async () => {
      await writeFact('a record whose read fails inside a wrapper');
      assert.equal(await failingOnRead(wrap(new driver.MongoNetworkError(HOST_TEXT))), true);
      const [lastError] = await lastErrors();
      assert.ok(lastError, 'the failure left no lastError at all');
      assert.doesNotMatch(lastError, LEAK, `the record stores the driver's text: ${lastError}`);
      assert.ok(lastError.includes(SENTENCES.incomplete), `not our sentence: ${lastError}`);
      assert.match(lastError, /\(Mongo\w*Error\)$/, `the class an operator groups by is missing: ${lastError}`);
    });
  }

  it('PIN: an own error wrapping nothing of the driver stays in its own words even when it names a host-like thing', async () => {
    await writeFact('own');
    await failingOnRead(new Error('the record is unreadable: notes/mongot-setup.md is not valid'));
    assert.deepEqual(await lastErrors(), ['the record is unreadable: notes/mongot-setup.md is not valid']);
  });
});
