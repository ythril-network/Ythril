/**
 * The reindex's walk (`queueEmbedSweep`, `match: 'all'`) asks a file row the FILE question, the one the worker and the backfill ask
 * (`fileEmbeddingSuppressedMany`: its two tiers, then its ancestors), once per page (Q-656, bundle-211).
 *
 * ## What it prevents
 *
 * The walk asked `embeddingSuppressedFor` per document, which knows a record's own tiers and no ancestor. A chunk whose PARENT is
 * suppressed (or missing: an orphan awaiting the chunk sweep) was therefore queued for a vector the worker then refused to write, on
 * every reindex of the space, while the backfill (which asks the file question) skipped it. One chunk, two answers by door.
 *
 * ## What is asserted (real MongoDB, a space whose queue starts empty)
 *
 * | file row | queued by the reindex walk |
 * |---|---|
 * | `ok.md`, ordinary file | yes |
 * | `ok.md#chunk0`, chunk of an ordinary parent | yes |
 * | `sup.md`, suppressed by its own flag, no vector | no, counted `skippedSuppressed` |
 * | `sup.md#chunk0`, chunk of a suppressed parent, no vector | no, counted `skippedSuppressed` |
 * | `sup.md#chunk1`, chunk of a suppressed parent still holding a vector | yes: the worker removes the vector |
 * | `orph.md#chunk0`, chunk whose parent is missing, no vector | no |
 * | `orph.md#chunk1`, chunk whose parent is missing, holding a vector | yes: the worker removes the vector |
 *
 * Run: `npm run test:up` first, then node --test testing/standalone/the-reindex-walk-asks-the-file-question-db.test.js
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
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-reindex-file-question-'));
const CONFIG_PATH = path.join(tmpDir, 'config.json');
process.env['CONFIG_PATH'] = CONFIG_PATH;

let mongo, sweep, priority, MODEL;
const c = (part) => mongo.col(`${SPACE}_${part}`);
const VEC = [0.1, 0.2, 0.3, 0.4];
const NOW = '2026-01-01T00:00:00.000Z';
const file = (id, extra = {}) => ({ _id: id, spaceId: SPACE, tags: [], createdAt: NOW, updatedAt: NOW, path: id, sizeBytes: 1, ...extra });
const chunk = (id, parent, extra = {}) => file(id, { parentFileId: parent, chunkIndex: 0, content: `text of ${id}`, ...extra });

describe('the reindex walk asks a file row the file question (real MongoDB)', { skip }, () => {
  before(async () => {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({
      instanceId: 'reindex-file-question-test', instanceLabel: 'test', tokens: [], networks: [],
      spaces: [{ id: SPACE, label: 'General', builtIn: true, folders: [] }],
    }, null, 2), { mode: 0o600 });
    mongo = await openTestMongo('reindexfilequestion');
    const loader = await import('../../server/dist/config/loader.js');
    loader.loadConfig();
    MODEL = loader.getEmbeddingConfig().model;
    sweep = await import('../../server/dist/brain/queue-embed-sweep.js');
    priority = (await import('../../server/dist/brain/embed-queue.js')).EMBED_PRIORITY;
  });
  after(async () => { await closeTestMongo(); });
  beforeEach(async () => {
    for (const p of ['facts', 'files', 'edges', 'entities', 'chrono', 'embed_jobs']) await c(p).deleteMany({});
    await c('files').insertMany([
      file('ok.md'),
      chunk('ok.md#chunk0', 'ok.md'),
      file('sup.md', { suppressEmbeddings: true }),
      chunk('sup.md#chunk0', 'sup.md'),
      chunk('sup.md#chunk1', 'sup.md', { chunkIndex: 1, embedding: VEC, embeddingModel: MODEL }),
      chunk('orph.md#chunk0', 'orph.md'),
      chunk('orph.md#chunk1', 'orph.md', { chunkIndex: 1, embedding: VEC, embeddingModel: MODEL }),
    ]);
  });

  it('queues a chunk under a suppressed or missing parent only when it still holds a vector to remove', async () => {
    const result = await sweep.queueEmbedSweep(SPACE, { match: 'all', priority: priority.rebuild, rebuild: true });
    const queued = (await c('embed_jobs').find({}).toArray()).map(j => `${j.recordType}:${j.recordId}`).sort();
    assert.deepEqual(queued, ['file:ok.md', 'file:ok.md#chunk0', 'file:orph.md#chunk1', 'file:sup.md#chunk1'].sort());
    assert.equal(result.enqueued, 4);
    assert.equal(result.skippedSuppressed, 2, 'sup.md and sup.md#chunk0 are skipped by the setting; the orphan awaits the chunk sweep and is not "the setting is on"');
  });
});
