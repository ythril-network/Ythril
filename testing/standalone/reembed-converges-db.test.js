/**
 * The reembed backfill CONVERGES: a second call right after a drained first one reports nothing left to do.
 *
 * ## The defect (Q-99 part 2, design v3 items 1, 2, 7)
 *
 * `reembedSpace` queued every file record without a vector — and a file record that is DERIVED from another
 * (a face chunk, the converted markdown of a document, an image extracted from one) can have no text at all.
 * A face chunk holds a face vector, not words; a converted-doc record holds a path. Embedding the path of a face
 * crop is not a vector anybody searches for, and the v3 worker refuses it: a textless derived record is `textless`,
 * its vector is unset, and it stays vectorless for good.
 *
 * So the backfill as written can never finish. Every call re-queues every face chunk and every converted doc in
 * the space, `enqueued` never reaches zero, and an operator told "call again to continue" calls for ever.
 *
 * ## The rules pinned here, against a real MongoDB
 *
 *  - textless derived records are never queued;
 *  - a vectorless text chunk (derived WITH content) and a top-level record are;
 *  - after the queue is drained, a second call reports `enqueued: 0` and `truncated: false`;
 *  - the space-wide suppressed (`'all'`) branch still reports its candidates under `skippedSuppressed`;
 *  - a page of suppressed records at the front of a collection does not block the records behind it.
 *
 * ## The drain is a stub, and it does what the v3 worker does to each record
 *
 * Draining through the real worker needs an embedder, and what this file is about is the SWEEP, so the stub
 * stands in for the worker's outcome per record: a record with text gains a vector, a textless derived record
 * has its vector unset (design v3 item 2.2), and the job is deleted either way. "Textless" is written here
 * LITERALLY — a derived record (`parentFileId` set) whose `content` is not a non-empty string — because a fixture
 * that derived it from the code under test would assert that the code equals itself.
 *
 * Run: `npm run test:up` first, then node --test testing/standalone/reembed-converges-db.test.js
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
const QUIET = 'quiet';
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-reembed-converges-'));
const CONFIG_PATH = path.join(tmpDir, 'config.json');
process.env['CONFIG_PATH'] = CONFIG_PATH;

let mongo, reembed;
const c = (space, part) => mongo.col(`${space}_${part}`);
const VEC = [0.1, 0.2, 0.3, 0.4];
const now = '2026-01-01T00:00:00.000Z';

const file = (id, extra = {}) => ({ _id: id, spaceId: SPACE, path: id, tags: [], createdAt: now, updatedAt: now, sizeBytes: 1, ...extra });
const fact = (space, id, extra = {}) => ({ _id: id, spaceId: space, fact: `fact ${id}`, tags: [], entityIds: [], createdAt: now, updatedAt: now, ...extra });

/** The literal textless rule, as the plan states it — see the file comment on why it is not imported. */
const isTextlessDerived = (doc) => typeof doc.parentFileId === 'string'
  && !(typeof doc.content === 'string' && doc.content.length > 0);

const COLL = { fact: 'facts', entity: 'entities', edge: 'edges', chrono: 'chrono', file: 'files' };

/** Stand in for the worker: give a record with text a vector, unset a textless one's, delete the job. */
async function stubDrain(space) {
  const queued = await c(space, 'embed_jobs').find({}).toArray();
  for (const job of queued) {
    const coll = c(space, COLL[job.recordType]);
    const doc = await coll.findOne({ _id: job.recordId });
    if (doc && job.recordType === 'file' && isTextlessDerived(doc)) {
      await coll.updateOne({ _id: doc._id }, { $unset: { embedding: '', embeddingModel: '', matchedText: '' } });
    } else if (doc) {
      await coll.updateOne({ _id: doc._id }, { $set: { embedding: VEC, embeddingModel: 'stub' } });
    }
    await c(space, 'embed_jobs').deleteOne({ _id: job._id });
  }
  return queued;
}

describe('the reembed backfill converges (real MongoDB)', { skip }, () => {
  before(async () => {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({
      spaces: [
        { id: SPACE, label: 'General' },
        { id: QUIET, label: 'Quiet', meta: { suppressEmbeddings: true } },
      ],
      networks: [], tokens: [],
    }, null, 2));
    mongo = await openTestMongo('reembedconverges');
    (await import('../../server/dist/config/loader.js')).loadConfig();
    reembed = await import('../../server/dist/brain/reembed.js');
    (await import('../../server/dist/brain/embed-queue.js')).resetEmbedPendingHint();
  });

  after(async () => {
    await closeTestMongo();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  beforeEach(async () => {
    for (const s of [SPACE, QUIET]) {
      for (const part of ['facts', 'files', 'embed_jobs', 'entities', 'edges', 'chrono']) await c(s, part).deleteMany({});
    }
  });

  async function seedDerivedSpace() {
    await c(SPACE, 'files').insertMany([
      // Top-level, vectorless: owed a vector.
      file('docs/top.md'),
      // A text chunk of it: derived WITH content, vectorless — owed a vector.
      file('docs/top.md#chunk0', { parentFileId: 'docs/top.md', chunkIndex: 0, headingText: 'Intro', content: 'The first section.' }),
      // A photo that already has its vector, and a FACE chunk of it: derived, no text, only a face vector.
      file('photos/p.jpg', { embedding: VEC }),
      file('photos/p.jpg#face-chunk0', { parentFileId: 'photos/p.jpg', chunkIndex: 0, faceEmbedding: VEC }),
      // A converted document: the original has its vector; the converted record and an extracted image are
      // derived and carry no content.
      file('docs/x.pdf', { embedding: VEC }),
      file('_converted/docs/x.pdf.md', { parentFileId: 'docs/x.pdf' }),
      file('_extracted/docs/x.pdf/image-0.png', { parentFileId: 'docs/x.pdf' }),
      // A derived record whose content is an EMPTY string is textless too.
      file('docs/x.pdf#chunk9', { parentFileId: 'docs/x.pdf', chunkIndex: 9, content: '' }),
    ]);
    await c(SPACE, 'facts').insertOne(fact(SPACE, 'f1'));
  }

  const TEXTLESS = ['photos/p.jpg#face-chunk0', '_converted/docs/x.pdf.md', '_extracted/docs/x.pdf/image-0.png', 'docs/x.pdf#chunk9'];

  it('textless derived records are never queued; text chunks and top-level records are', async () => {
    await seedDerivedSpace();
    const res = await reembed.reembedSpace(SPACE);
    const ids = (await c(SPACE, 'embed_jobs').find({}).toArray()).map(j => j._id).sort();
    for (const t of TEXTLESS) {
      assert.ok(!ids.includes(`file:${t}`),
        `${t} has no text and was queued; the worker can never give it a vector, so every backfill re-queues it`);
    }
    assert.deepEqual(ids, ['fact:f1', 'file:docs/top.md', 'file:docs/top.md#chunk0']);
    assert.equal(res.enqueued, 3);
    assert.deepEqual(res.byKind, { fact: 1, file: 2 });
  });

  it('a second call right after a drained first one reports enqueued 0 and truncated false', async () => {
    await seedDerivedSpace();
    const first = await reembed.reembedSpace(SPACE);
    assert.ok(first.enqueued > 0, 'the first call had work');
    await stubDrain(SPACE);

    const second = await reembed.reembedSpace(SPACE);
    assert.equal(second.enqueued, 0,
      `the second call queued ${second.enqueued} again (${JSON.stringify(second.byKind)}): the backfill does not `
      + 'converge while face chunks and converted documents are in the space');
    assert.equal(second.truncated, false);
    assert.equal(second.remaining, 0);
  });

  it("the space-wide suppressed ('all') branch still reports its candidates as skipped", async () => {
    await c(QUIET, 'facts').insertMany([fact(QUIET, 'q1'), fact(QUIET, 'q2')]);
    const res = await reembed.reembedSpace(QUIET);
    assert.equal(res.enqueued, 0);
    assert.equal(res.skippedSuppressed, 2, 'a space whose suppression is still on must say so, not look like a no-op');
    assert.equal(res.remaining, 0, 'there is no work, which is a different report from work left over');
    assert.equal(await c(QUIET, 'embed_jobs').countDocuments({}), 0);
  });

  it('a page of suppressed records at the front does not block the records behind it', async () => {
    await c(SPACE, 'facts').insertMany([
      fact(SPACE, 'a-1', { suppressEmbeddings: true }),
      fact(SPACE, 'a-2', { suppressEmbeddings: true }),
      fact(SPACE, 'a-3', { suppressEmbeddings: true }),
      fact(SPACE, 'z-1'),
      fact(SPACE, 'z-2'),
    ]);
    const queued = new Set();
    for (let call = 0; call < 6; call++) {
      const res = await reembed.reembedSpace(SPACE, { kinds: ['fact'], limit: 1 });
      for (const j of await stubDrain(SPACE)) queued.add(j.recordId);
      if (!res.truncated && res.enqueued === 0) break;
    }
    assert.deepEqual([...queued].sort(), ['z-1', 'z-2'], 'every embeddable record was reached, and no suppressed one');
  });
});
