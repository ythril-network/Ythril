/**
 * Face auto-labelling finds a labelled face behind closer unlabelled ones (Q-102, the gallery half).
 *
 * ## The defect
 *
 * `gallerySearch` is the same shape as the filtered-recall window, one module over: `$vectorSearch exact:true
 * limit: 1000` over every face, THEN `$match {faceEntityId: exists}`. In a gallery with more than a thousand
 * unlabelled faces nearer the query than the nearest labelled one — every face in a photo archive is
 * unlabelled until someone labels it — the labelled match is outside the window and the face is recorded as
 * "no match". Permanently: the chunk is written unlabelled and nothing re-runs it.
 *
 * And a failure was indistinguishable from "no match" too — the catch returned `null`. A timeout or an index
 * that refuses the id-restricted search must make the media job RETRY, not write a permanently unlabelled face.
 *
 * `gallerySearch` is exported as the test seam, as the plan names it.
 *
 * Run: `npm run test:up` first, then
 *      node --test testing/standalone/face-gallery-finds-a-labelled-face-behind-closer-ones-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';
import { unitAt, createSpaceCollections, insertAll, waitUntilServing, liveFilterPaths } from './_vector-harness.mjs';

const skip = await mongoSkipReason();

const TEXT_DIMS = 8;
const GALLERY = 'gallery';        // face index built by production's builder
const GALLERY_OLD = 'galleryold'; // face index on the definition shipped before `_id` joined it
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-facegallery-'));
const CONFIG_PATH = path.join(tmpDir, 'config.json');
process.env['CONFIG_PATH'] = CONFIG_PATH;
process.env['EMBEDDING_DIMENSIONS'] = String(TEXT_DIMS);

let mongo, faceEmbedder, FACE_DIMS, threshold;
const OLD = new Date(Date.now() - 3_600_000).toISOString();
const UNLABELLED = 1100; // more than the 1000-face window the gallery searched

/** The unlabelled crowd (5-30°) nearer than the one labelled face (60°, still well above the threshold). */
const gallery = (spaceId) => [
  ...Array.from({ length: UNLABELLED }, (_, i) => ({
    _id: `photo-${i}.jpg#face-chunk0`, spaceId, path: `photo-${i}.jpg#face-chunk0`, tags: [],
    parentFileId: `photo-${i}.jpg`, chunkIndex: 0, faceEmbedding: unitAt(5 + (25 * i) / UNLABELLED, FACE_DIMS),
    createdAt: OLD, updatedAt: OLD,
  })),
  {
    _id: 'portrait.jpg#face-chunk0', spaceId, path: 'portrait.jpg#face-chunk0', tags: [], parentFileId: 'portrait.jpg',
    chunkIndex: 0, faceEmbedding: unitAt(60, FACE_DIMS), faceEntityId: 'person-1', createdAt: OLD, updatedAt: OLD,
  },
];

describe('the face gallery finds a labelled face behind closer unlabelled ones', { skip }, () => {
  before(async () => {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(
      { spaces: [GALLERY, GALLERY_OLD].map(id => ({ id, label: id })), networks: [], tokens: [] }, null, 2));
    mongo = await openTestMongo('facegallery');
    const loader = await import('../../server/dist/config/loader.js');
    loader.loadConfig();
    assert.ok(loader.getFaceRecognitionConfig().enabled, 'fixture check: face recognition must be enabled for the face index to be built');
    threshold = loader.getFaceRecognitionConfig().confidenceThreshold;
    ({ FACE_DESCRIPTOR_DIMS: FACE_DIMS } = await import('../../server/dist/files/media/face-descriptor.js'));
    faceEmbedder = await import('../../server/dist/files/media/face-embedder.js');
    const vectorIndex = await import('../../server/dist/spaces/vector-index.js');

    for (const id of [GALLERY, GALLERY_OLD]) {
      await createSpaceCollections(mongo, id);
      await insertAll(mongo, `${id}_files`, gallery(id));
      await mongo.col(`${id}_entities`).insertOne({ _id: 'person-1', spaceId: id, name: 'Ada', type: 'person', tags: [], properties: {} });
    }
    await vectorIndex.buildSpaceVectorIndexes(GALLERY, true);
    // The old definition: the face index as production built it before, with no filter fields at all.
    await vectorIndex.ensureVectorSearchIndex(GALLERY_OLD, 'files', FACE_DIMS, 'cosine', 'faceEmbedding', 'faceEmbedding',
      true, [], { refuseWidthChange: true });
    for (const id of [GALLERY, GALLERY_OLD]) {
      await waitUntilServing(mongo, `${id}_files`, `${id}_files_faceEmbedding`,
        { path: 'faceEmbedding', dims: FACE_DIMS, n: UNLABELLED + 1 });
    }
  });

  after(async () => {
    await closeTestMongo();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  const seam = () => {
    assert.equal(typeof faceEmbedder.gallerySearch, 'function',
      'files/media/face-embedder.js must export gallerySearch — the plan names it as this test\'s seam');
    return faceEmbedder.gallerySearch;
  };

  it('the face index production builds declares _id as a filter field', async () => {
    const paths = await liveFilterPaths(mongo, `${GALLERY}_files`, `${GALLERY}_files_faceEmbedding`);
    assert.ok(paths.includes('_id'), `the face index declares [${paths.join(', ')}] — no _id, so the labelled-face `
      + 'id set cannot restrict the gallery search');
  });

  it('a labelled face behind more than a thousand closer unlabelled faces is matched', async () => {
    const match = await seam()(GALLERY, unitAt(0, FACE_DIMS), threshold);
    assert.equal(match?.entityId, 'person-1',
      `got ${JSON.stringify(match)}: the labelled face scores well above the threshold and ranks behind `
      + `${UNLABELLED} unlabelled ones, so a search that filters for labels AFTER a 1000-face window never sees it`);
  });

  it('an index that refuses the id-restricted search is RETRYABLE, never "no match"', async () => {
    // The labelled face is outside the window, so completing the answer needs the id-restricted search, and
    // this index cannot filter on _id. `null` here would be written as a permanently unlabelled face.
    const search = seam();
    await assert.rejects(() => search(GALLERY_OLD, unitAt(0, FACE_DIMS), threshold),
      'resolving (null or otherwise) records an answer the search could not give — the media job must retry');
  });
});
