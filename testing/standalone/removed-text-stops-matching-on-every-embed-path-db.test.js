/**
 * Text removed from a record stops matching, whatever became of its embedding (`Q-94`).
 *
 * The lexical channel reads `matchedText`, and only the path that stored a new vector rewrote it. A record whose
 * embeddings are suppressed kept the text it had when suppression began — so a deleted property went on matching
 * searches and was shown as the record's matched text. The same held when the embedder failed: the old text, and the
 * old vector, stayed. Every outcome of `embedStoredRecord` now leaves `matchedText` equal to the record's current text.
 *
 * Run: `npm run test:up` first, then node --test testing/standalone/removed-text-stops-matching-on-every-embed-path-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';

const skip = await mongoSkipReason();
const SPACE = 'general';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-q94-'));
const CONFIG_PATH = path.join(tmpDir, 'config.json');
process.env['CONFIG_PATH'] = CONFIG_PATH;
// No embedder: the failure path is the condition, not an accident of the machine.
const EMPTY_CACHE = path.join(tmpDir, 'empty-model-cache');
fs.mkdirSync(EMPTY_CACHE, { recursive: true });
process.env['YTHRIL_MODELS_OFFLINE'] = '1';
process.env['MODEL_CACHE_DIR'] = EMPTY_CACHE;

let mongo, embedRecord;
const entities = () => mongo.col(`${SPACE}_entities`);
const REMOVED = 'launch-codes-7731';

/** An entity as it stands after a property carrying `REMOVED` was deleted — its matchedText still has the old text. */
async function staleEntity(extra = {}) {
  const _id = `e-${Math.random().toString(36).slice(2)}`;
  await entities().insertOne({
    _id, spaceId: SPACE, name: 'Vault', type: 'place', tags: [], properties: { city: 'Basel' },
    matchedText: `Vault place city: Basel code: ${REMOVED}`, createdAt: new Date().toISOString(), seq: 1, ...extra,
  });
  return _id;
}

describe('matchedText follows the record on every embed outcome', { skip }, () => {
  before(async () => {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({ spaces: [{ id: SPACE, label: 'General' }], networks: [], tokens: [] }, null, 2));
    mongo = await openTestMongo('q94');
    (await import('../../server/dist/config/loader.js')).loadConfig();
    embedRecord = await import('../../server/dist/brain/embed-record.js');
  });

  after(async () => {
    await closeTestMongo();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  beforeEach(async () => { await entities().deleteMany({}); });

  it('suppressed: the vector goes and the removed text goes with it', async () => {
    const id = await staleEntity({ suppressEmbeddings: true, embedding: [0.1, 0.2], embeddingModel: 'm' });
    const outcome = await embedRecord.embedStoredRecord(SPACE, 'entity', id);
    assert.equal(outcome, 'excluded');
    const doc = await entities().findOne({ _id: id });
    assert.equal(doc.embedding, undefined, 'a suppressed record kept its vector');
    assert.ok(typeof doc.matchedText === 'string' && doc.matchedText.includes('Basel'), 'the current text is not there');
    assert.ok(!doc.matchedText.includes(REMOVED), `a deleted property still matches: ${doc.matchedText}`);
    assert.equal(doc.matchedText, await embedRecord.buildEmbedText(SPACE, 'entity', doc));
  });

  it('failed: the embed throws, and neither the removed text nor the stale vector survives it', async () => {
    const id = await staleEntity({ embedding: [0.1, 0.2], embeddingModel: 'm' });
    await assert.rejects(() => embedRecord.embedStoredRecord(SPACE, 'entity', id), 'the embedder is unreachable here');
    const doc = await entities().findOne({ _id: id });
    assert.ok(!doc.matchedText.includes(REMOVED), `a deleted property still matches after a failed embed: ${doc.matchedText}`);
    assert.equal(doc.matchedText, await embedRecord.buildEmbedText(SPACE, 'entity', doc));
    assert.equal(doc.embedding, undefined, 'the vector of text that is gone still ranks the record by meaning');
  });

  it('and a retry after a failure re-embeds rather than calling the record unchanged', async () => {
    // matchedText is also the fingerprint that lets an unchanged record skip the model. Written on failure WITHOUT
    // dropping the vector, a retry would see (vector, same text) and keep the stale vector for ever.
    // The configured model, or the shortcut can never fire and the case proves nothing.
    const { getEmbeddingConfig } = await import('../../server/dist/config/loader.js');
    const id = await staleEntity({ embedding: [0.1, 0.2], embeddingModel: getEmbeddingConfig().model });
    await assert.rejects(() => embedRecord.embedStoredRecord(SPACE, 'entity', id));
    await assert.rejects(() => embedRecord.embedStoredRecord(SPACE, 'entity', id),
      'the retry answered without trying the model — it read the stale vector as current');
  });
});
