/**
 * A file this instance suppresses is given its own text with no vector beside it, its passages' vectors included.
 *
 * ## The defect it prevents
 *
 * `storeSuppressedFileText` wrote the `$set` of `derivedFieldsForWrite` and dropped its `$unset`. On the stray-filemeta fill
 * (`sync/arrivals.ts`, `fillOnly`), which sets `suppressEmbeddings` on a row that held a vector and never removes it itself, the
 * row then held its old vector beside its new text. Its passage rows kept theirs too. The job the fill queues would have removed
 * them, but if that enqueue failed neither repair walk sees the row (its text is current and it has a vector), so the suppressed
 * file stayed in meaning-ranked search for good.
 *
 * Run: a Mongo the harness accepts (see `_mongo-harness.mjs`), then
 *      node --test testing/standalone/a-suppressed-file-keeps-no-vector-beside-its-text-db.test.js
 * (requires a prior `npm run build:server`)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';

const skip = await mongoSkipReason();

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-suppressed-file-vector-'));
const CONFIG_PATH = path.join(tmpDir, 'config.json');
process.env['CONFIG_PATH'] = CONFIG_PATH;

const SPACE = 'general';
const NOW = '2026-01-01T00:00:00.000Z';
const VEC = [0.1, 0.2, 0.3, 0.4];
const row = (id, extra = {}) => ({ _id: id, spaceId: SPACE, path: id, tags: [], createdAt: NOW, updatedAt: NOW, sizeBytes: 3, seq: 1, ...extra });

let mongo, text, embedRecord;

describe('a suppressed file keeps no vector beside its text', { skip }, () => {
  before(async () => {
    mongo = await openTestMongo('suppressedfilevector');
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({
      instanceId: 'suppressed-file-vector-test', instanceLabel: 'test', tokens: [], networks: [],
      spaces: [{ id: SPACE, label: 'General', builtIn: true, folders: [], meta: {} }],
    }, null, 2), { mode: 0o600 });
    (await import('../../server/dist/config/loader.js')).loadConfig();
    text = await import('../../server/dist/sync/suppressed-file-text.js');
    embedRecord = await import('../../server/dist/brain/embed-record.js');
  });

  after(async () => {
    await closeTestMongo();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it('a suppressed row that held a vector is left with its own text and no vector, and so are its passages', async () => {
    const files = mongo.col(`${SPACE}_files`);
    await files.deleteMany({});
    await files.insertMany([
      row('docs/quiet.md', { suppressEmbeddings: true, description: 'newly kept out', embedding: VEC, embeddingModel: 'm', matchedText: 'old text' }),
      row('docs/quiet.md#chunk0', { parentFileId: 'docs/quiet.md', chunkIndex: 0, content: 'a passage', embedding: VEC, embeddingModel: 'm' }),
      row('docs/loud.md', { description: 'embedded', embedding: VEC, embeddingModel: 'm', matchedText: 'loud text' }),
    ]);
    await text.storeSuppressedFileText(SPACE, ['docs/quiet.md', 'docs/loud.md']);

    const quiet = await files.findOne({ _id: 'docs/quiet.md' });
    assert.equal(quiet.matchedText, await embedRecord.buildEmbedText(SPACE, 'file', quiet), 'the row was not given its own text');
    assert.equal(quiet.embedding, undefined, 'the suppressed row keeps a vector beside its new text');
    assert.equal(quiet.embeddingModel, undefined, 'the suppressed row keeps its vector\'s model');
    assert.equal((await files.findOne({ _id: 'docs/quiet.md#chunk0' })).embedding, undefined, 'a passage of the suppressed file keeps its vector');

    const loud = await files.findOne({ _id: 'docs/loud.md' });
    assert.deepEqual([loud.embedding, loud.matchedText], [VEC, 'loud text'], 'a row this instance embeds was touched');
  });
});
