/**
 * A text run clears EVERY derived row of its file at its start, under its own claim and in chunks, and stops the instant the claim is lost
 * (bundle-236, Q-698, DESIGN v3 C3 and C16).
 *
 * ## The defect that bought it
 *
 * The text run's clear (`deleteConversionArtifacts`, from the worker) was one unfenced command per level. A run that had lost its claim to a
 * re-upload of the path and reached the clear late deleted the rows of the run that replaced it, and a document of a thousand passages was
 * removed by one command of no bound. The door of a replaced document also made the same delete with no claim at all (`dispatch.ts`), so the
 * old run could write its rows after it.
 *
 * ## The rules
 *
 *  1. `deleteConversionArtifactsUnderClaim` removes what `deleteConversionArtifacts` removes: the file's chunk rows, the converted and
 *     extracted rows, the caption and face rows of an extracted image (two levels down) and the queued jobs of the extracted images. It keeps
 *     the file's own row and the file's own job (the claim the run holds).
 *  2. The rows go per `READ_CHUNK` through the run's claim: when the claim is lost between two chunks the clear throws `JobLeaseLostError`,
 *     removes no more, and leaves what the new run wrote.
 *  3. A claim that is already lost clears nothing at all.
 *
 * ## Seen red
 *
 * On 1d998b5ef the function is not there (the worker called `deleteConversionArtifacts`, which has no claim to lose), so the cases fail with
 * "not a function". With the chunks taken out of the claim (a plain `deleteMany` in place of `writeUnderClaim`) case 2 fails: the claim is lost
 * and the clear goes on and removes every row.
 *
 * Needs a MongoDB: `npm run test:up`.
 *
 * Run: node --test testing/standalone/a-text-run-clears-its-files-conversion-under-its-claim-db.test.js
 * (requires a prior `npm run build:server`)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openDispatchDoor } from './_dispatch-door.mjs';
import { seedClaim, revoke } from './_media-claim.mjs';

const skip = await mongoSkipReason();
const S = 'textclear';
const FILE = 'docs/big.txt';
const T0 = '2026-09-01T00:00:00.000Z';
const OLD = 'o'.repeat(64);
const NEW = 'n'.repeat(64);
/** `READ_CHUNK` is 500: 1 100 rows are three chunks, so a claim lost after the first one has two chunks left to refuse. */
const PASSAGES = 1_100;

let d, pipeline, lease, mongodb;
const files = () => d.files();
const row = (id, parentFileId, extra = {}) => ({ _id: id, spaceId: S, path: id, tags: [], createdAt: T0, updatedAt: T0, sizeBytes: 5, parentFileId, ...extra });
const count = (filter) => files().countDocuments(filter);

async function seedConversion() {
  await files().insertOne({ _id: FILE, spaceId: S, path: FILE, tags: [], createdAt: T0, updatedAt: T0, sizeBytes: 5, seq: 1 });
  await files().insertMany(Array.from({ length: PASSAGES }, (_, i) => row(`${FILE}#chunk${i}`, FILE, { chunkIndex: i, content: `passage ${i}`, sourceSha256: OLD })));
}

describe('a text run clears its file\'s conversion under its claim and in chunks (real MongoDB)', { skip }, () => {
  before(async () => {
    d = await openDispatchDoor({ suite: 'textclear', space: S });
    pipeline = await import('../../server/dist/files/converters/pipeline.js');
    lease = await import('../../server/dist/files/media/lease.js');
    mongodb = createRequire(new URL('../../server/package.json', import.meta.url))('mongodb');
  });
  after(async () => { await d?.close(); });
  beforeEach(async () => {
    await files().deleteMany({});
    await d.jobs().deleteMany({});
  });

  it('removes every derived row at every level and the extracted images\' jobs, and keeps the file\'s own row and job', async () => {
    await seedConversion();
    const image = `_extracted/${FILE}/image-0.png`;
    await files().insertMany([
      row(`_converted/${FILE}.md`, FILE), row(image, FILE),
      row(`${image}#media-chunk0`, image, { content: 'caption of the extracted image' }), row(`${image}#face-chunk0`, image, { faceEmbedding: [0.1] }),
      // Another file's rows, named like this one's: left alone.
      row('docs/big.txt2#chunk0', 'docs/big.txt2'),
    ]);
    await d.jobs().insertOne({ _id: image, spaceId: S, filePath: image, mimeType: 'image/png', mediaType: 'image', status: 'pending', attempts: 0, maxAttempts: 3, createdAt: T0, updatedAt: T0 });
    const claim = await seedClaim(S, FILE, { mediaType: 'text', sha256: NEW });

    await pipeline.deleteConversionArtifactsUnderClaim(S, claim, FILE);

    assert.deepEqual((await files().find({}, { projection: { _id: 1 } }).toArray()).map(r => r._id).sort(), [FILE, 'docs/big.txt2#chunk0'].sort(),
      'what is left is the file\'s own row and another file\'s: every derived row of the file, at every level, was removed');
    assert.equal(await d.jobs().countDocuments({ _id: image }), 0, 'the extracted image\'s queued job survived the clear');
    assert.equal((await d.jobs().findOne({ _id: FILE }))?.status, 'processing', 'the clear took the run\'s own job: it would cancel its own claim');
  });

  it('a claim lost between two chunks stops the clear: the error is the lost lease, the remaining rows and the new run\'s row stay', async () => {
    await seedConversion();
    const claim = await seedClaim(S, FILE, { mediaType: 'text', sha256: NEW });
    // The first chunk's rows are committed, then its embed jobs are retired (`deleteMany` on the embed-job collection, outside any transaction):
    // that is the moment the file is written again — its claim is revoked, and the run that replaced this one has stored a row of its own.
    const proto = mongodb.Collection.prototype;
    const original = proto.deleteMany;
    let revoked = false;
    proto.deleteMany = async function (...args) {
      const answer = await original.apply(this, args);
      if (!revoked && /_embed_jobs$/.test(this.collectionName)) {
        revoked = true;
        await revoke(S, FILE);
        await files().insertOne(row(`${FILE}#chunk-of-the-new-run`, FILE, { content: 'the new run\'s passage', sourceSha256: NEW }));
      }
      return answer;
    };
    let thrown;
    try { await pipeline.deleteConversionArtifactsUnderClaim(S, claim, FILE); } catch (err) { thrown = err; } finally { proto.deleteMany = original; }

    assert.ok(revoked, 'fixture: the claim was never lost, so nothing below says anything');
    assert.ok(lease.isLeaseLost(thrown), `the clear ended with ${thrown ?? 'no error'}: a run that lost its claim must stop with the lost lease`);
    assert.equal(await count({ parentFileId: FILE, sourceSha256: OLD }), PASSAGES - 500,
      'the clear went on removing rows after its claim was lost (or removed fewer than the chunk it held)');
    assert.equal(await count({ _id: `${FILE}#chunk-of-the-new-run` }), 1, 'the row the new run stored was removed');
  });

  it('a claim that is already lost clears nothing', async () => {
    await seedConversion();
    const claim = await seedClaim(S, FILE, { mediaType: 'text', sha256: NEW });
    await revoke(S, FILE);

    await assert.rejects(() => pipeline.deleteConversionArtifactsUnderClaim(S, claim, FILE), lease.isLeaseLost);
    assert.equal(await count({ parentFileId: FILE }), PASSAGES, 'a run with no claim removed rows');
  });
});
