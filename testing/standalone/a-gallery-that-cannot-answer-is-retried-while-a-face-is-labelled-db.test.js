/**
 * A face gallery that cannot answer is RETRIED while a labelled face exists, and answers "no gallery" only when there is none (Q-327, bundle-72).
 *
 * ## The defect
 *
 * `gallerySearch` (`files/media/face-embedder.ts`) ends its `catch` with `return null`, and `null` is the answer "no labelled face matches":
 * `embedFaces` then writes the face UNLABELLED, and nothing ever runs it again. The docs promise the opposite (`05c-face-recognition.md:54`:
 * a gallery search that cannot be completed, "or the face index is still being updated", makes the media job retry), and `GalleryIncompleteError`
 * exists for exactly that, but only a deadline and a degraded stage-2 reach it. So a photo uploaded while the face index is rebuilding - after a
 * container recreate that is 120 s or more - is recorded as a stranger for good, in a space whose gallery has labelled faces in it.
 *
 * A gallery that answers NOTHING is the same defect with no error at all: an absent index answers no documents (probe M1: ok, 0 results), and
 * stage 1 reads 0 documents as an exhausted window, so the face is again recorded as unmatched.
 *
 * ## The rules (DESIGN v3, item 9; AUDIT-VET S1, A-S5)
 *
 *  1. A not-yet refusal (mongot's own wordings, verbatim below) while the space holds a labelled face -> `GalleryIncompleteError`.
 *  2. A face labelled SECONDS ago counts: the gallery has no fresh-write scan, so its labelled-face read has no age clause (S1).
 *  3. An absent index (the search answers no documents, no error) while a labelled face exists -> `GalleryIncompleteError`.
 *  4. A store condition (code 6, a dead mongot) while a labelled face exists -> `GalleryIncompleteError`, never null (A-S5).
 *  5. No labelled face anywhere -> `{ kind: 'no_match' }`, whatever the index is doing: there is no gallery to be incomplete about (B7, `face-embedder.ts:223-225`).
 *  6. An index that will not serve without action (here a REAL one created with half the face width: mongot refuses every query) with a labelled
 *     face -> `{ kind: 'could_not_answer', reason: 'index_unavailable' }` (bundle-236, Q-698: a typed answer, so a label the face already had is kept
 *     where `null` read as "no one"), so the caption and the rest of the image job still complete, and `ythril_faces_stored_unmatched_total{reason}` counts the
 *     face stored unlabelled for want of a gallery (S10).
 *
 * Rule 5 held on the base as `null` and rule 6 answered `null`: bundle-236 types the answer (`match` | `no_match` | `could_not_answer`), so those two cases read the typed shape and
 * fail on the base, which still answers `null`. The others fail on the base too.
 *
 * ## How
 *
 * `gallerySearch` is the exported seam. The not-yet and store-condition refusals are injected at `toArray` of the gallery's own `$vectorSearch`
 * aggregate, after the real store has been asked, with mongot's messages as the probe recorded them (`plan.md`, PROBE M1/M2); everything else,
 * including the labelled-face read, runs against the real store. The absent and the will-not-serve indexes are real.
 *
 * Needs a MongoDB with mongot (atlas-local): `npm run test:up`.
 *
 * Run: node --test testing/standalone/a-gallery-that-cannot-answer-is-retried-while-a-face-is-labelled-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';
import { unitAt, createSpaceCollections, insertAll } from './_vector-harness.mjs';
import { REFUSALS, refuseVectorSearch } from './_mongot-refusals.mjs';
import { waitFor } from '../_shared/wait-for.mjs';

const skip = await mongoSkipReason();

const TEXT_DIMS = 8;
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-galleryretry-'));
const CONFIG_PATH = path.join(tmpDir, 'config.json');
process.env['CONFIG_PATH'] = CONFIG_PATH;
process.env['EMBEDDING_DIMENSIONS'] = String(TEXT_DIMS);

/** One space per situation, so no case reads another's records or index. */
const S = {
  labelled: 'galretrylab',      // an old labelled face among unlabelled ones; no face index
  fresh: 'galretryfresh',       // a labelled face written just now; no face index
  absent: 'galretryabsent',     // a labelled face; the face index does not exist at all
  none: 'galretrynone',         // unlabelled faces only
  wrongWidth: 'galretrywide',   // a labelled face; a REAL face index of half the width
};

let mongo, faceEmbedder, FACE_DIMS, threshold, registry;
const OLD = new Date(Date.now() - 3_600_000).toISOString();

const face = (spaceId, i, extra, at = OLD) => ({
  _id: `photo-${i}.jpg#face-chunk0`, spaceId, path: `photo-${i}.jpg#face-chunk0`, tags: [], parentFileId: `photo-${i}.jpg`,
  chunkIndex: 0, faceEmbedding: unitAt(5 + i * 3, FACE_DIMS), createdAt: at, updatedAt: at, ...extra,
});

/** The records of one space: `unlabelled` faces, and a labelled one when `labelledAt` is given. */
const gallery = (spaceId, { unlabelled = 3, labelledAt } = {}) => [
  ...Array.from({ length: unlabelled }, (_, i) => face(spaceId, i, {})),
  ...(labelledAt ? [face(spaceId, 99, { faceEntityId: 'person-1' }, labelledAt)] : []),
];

/** What the gallery search answers or throws, with the refusal injected for the duration. */
async function searchRefusedAs(space, refusal) {
  const fault = refuseVectorSearch(refusal);
  try {
    const answer = await faceEmbedder.gallerySearch(space, unitAt(0, FACE_DIMS), threshold).then(v => ({ v }), e => ({ e }));
    assert.ok(fault.refused() >= 1, 'fixture check: the injected refusal never reached the gallery\'s vector search');
    return answer;
  } finally {
    fault.restore();
  }
}

const isIncomplete = (e) => e instanceof Error && e.name === 'GalleryIncompleteError';
const describeOutcome = (o) => ('e' in o ? `threw ${o.e?.name}: ${o.e?.message}` : `answered ${JSON.stringify(o.v)}`);

/** The sum of every series of the counter that counts faces stored unlabelled for want of a gallery, `{reason}` labelled. */
async function unmatchedStored() {
  const text = await registry.register.metrics();
  const rows = [...text.matchAll(/^ythril_faces_stored_unmatched_total\{([^}]*)\} (\d+(?:\.\d+)?)$/gm)];
  for (const r of rows) assert.match(r[1], /reason="[^"]+"/, `a series of the counter carries no reason label: ${r[0]}`);
  return rows.reduce((n, r) => n + Number(r[2]), 0);
}

describe('a face gallery that cannot answer is retried while a face is labelled', { skip }, () => {
  before(async () => {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(
      { spaces: Object.values(S).map(id => ({ id, label: id })), networks: [], tokens: [] }, null, 2));
    mongo = await openTestMongo('galleryretry');
    const loader = await import('../../server/dist/config/loader.js');
    loader.loadConfig();
    assert.ok(loader.getFaceRecognitionConfig().enabled, 'fixture check: face recognition must be enabled');
    threshold = loader.getFaceRecognitionConfig().confidenceThreshold;
    ({ FACE_DESCRIPTOR_DIMS: FACE_DIMS } = await import('../../server/dist/files/media/face-descriptor.js'));
    faceEmbedder = await import('../../server/dist/files/media/face-embedder.js');
    registry = await import('../../server/dist/metrics/registry.js');
    assert.equal(typeof faceEmbedder.gallerySearch, 'function', 'face-embedder.js must export gallerySearch (the test seam)');

    const justNow = new Date().toISOString();
    for (const [space, opts] of [
      [S.labelled, { labelledAt: OLD }], [S.fresh, { unlabelled: 0, labelledAt: justNow }], [S.absent, { labelledAt: OLD }],
      [S.none, {}], [S.wrongWidth, { labelledAt: OLD }],
    ]) {
      await createSpaceCollections(mongo, space);
      await insertAll(mongo, `${space}_files`, gallery(space, opts));
    }

    // A REAL face index whose width is half the descriptor's: mongot accepts it, reports it ready, and then refuses every query
    // (`vector field is indexed with N dimensions but queried with M`, probe M1) - an index that will not serve without action.
    const name = `${S.wrongWidth}_files_faceEmbedding`;
    await mongo.col(`${S.wrongWidth}_files`).createSearchIndex({ name, type: 'vectorSearch',
      definition: { fields: [{ type: 'vector', path: 'faceEmbedding', numDimensions: Math.floor(FACE_DIMS / 2), similarity: 'cosine' }] } });
    let last = 'no answer yet';
    await waitFor(async () => {
      try {
        await mongo.col(`${S.wrongWidth}_files`).aggregate([{ $vectorSearch: { index: name, path: 'faceEmbedding',
          queryVector: unitAt(0, FACE_DIMS), exact: true, limit: 1 } }]).toArray();
        last = 'served';
        return false;
      } catch (err) {
        last = err instanceof Error ? err.message : String(err);
        return /indexed with \d+ dimensions/.test(last);
      }
    }, 120_000, 300, () => `the half-width index never refused with its dimensions; last answer: ${last}`,
    { what: 'the half-width face index to refuse a full-width query', tolerate: () => true });
  });

  after(async () => {
    await closeTestMongo();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  describe('a labelled face exists: the search that could not complete is retried', () => {
    for (const [wording, refusal] of [
      ['"Index … not initialized"', REFUSALS.notInitialized],
      ['"… while in state NOT_STARTED"', REFUSALS.notStarted],
      ['"… while in state INITIAL_SYNC"', REFUSALS.initialSync],
    ]) {
      it(`mongot refusing ${wording} throws GalleryIncompleteError, so the media job retries`, async () => {
        const o = await searchRefusedAs(S.labelled, refusal);
        assert.ok('e' in o && isIncomplete(o.e),
          `the gallery ${describeOutcome(o)} - null is written as a face with no label, for good, while the space holds a labelled face the search could not read`);
      });
    }

    it('a face labelled seconds ago counts: it alone makes the refused search incomplete', async () => {
      const o = await searchRefusedAs(S.fresh, REFUSALS.initialSync);
      assert.ok('e' in o && isIncomplete(o.e),
        `the gallery ${describeOutcome(o)} - the gallery has no fresh-write scan, so a face labelled moments ago is invisible to the index and must still hold the face back`);
    });

    it('an index that does not exist answers no documents - and a labelled face makes that incomplete, not "no match"', async () => {
      const o = await faceEmbedder.gallerySearch(S.absent, unitAt(0, FACE_DIMS), threshold).then(v => ({ v }), e => ({ e }));
      assert.ok('e' in o && isIncomplete(o.e),
        `the gallery ${describeOutcome(o)} - an absent face index answers nothing without an error, which stage 1 reads as an exhausted window `
        + 'while the space holds a labelled face');
    });

    it('a store condition (a dead mongot, code 6) throws GalleryIncompleteError, never null', async () => {
      const o = await searchRefusedAs(S.labelled, REFUSALS.hostUnreachable);
      assert.ok('e' in o && isIncomplete(o.e), `the gallery ${describeOutcome(o)}`);
    });
  });

  describe('no labelled face exists: there is no gallery, and no_match is the answer', () => {
    // Green on the base already: this is the answer the change must keep (B7).
    it('an absent index answers no_match', async () => {
      assert.deepEqual(await faceEmbedder.gallerySearch(S.none, unitAt(0, FACE_DIMS), threshold), { kind: 'no_match' });
    });
    for (const [wording, refusal] of [['a not-yet refusal', REFUSALS.initialSync], ['"Index … not initialized"', REFUSALS.notInitialized], ['a dead mongot (code 6)', REFUSALS.hostUnreachable]]) {
      it(`${wording} answers no_match`, async () => {
        const o = await searchRefusedAs(S.none, refusal);
        assert.ok('v' in o && o.v?.kind === 'no_match' && Object.keys(o.v).length === 1,
          `the gallery ${describeOutcome(o)} - with no labelled face there is nothing to retry for, and nothing a label could be kept for: no_match`);
      });
    }
  });

  describe('an index that will not serve without action', () => {
    it('with a labelled face answers could_not_answer index_unavailable (the job completes) and counts the face stored unlabelled', async () => {
      const before = await unmatchedStored();
      const o = await faceEmbedder.gallerySearch(S.wrongWidth, unitAt(0, FACE_DIMS), threshold).then(v => ({ v }), e => ({ e }));
      assert.deepEqual('v' in o ? o.v : o, { kind: 'could_not_answer', reason: 'index_unavailable' },
        `the gallery ${describeOutcome(o)} - a broken face index must not retry a photo for ever or lose its caption: it answers that it could not answer, so a label a face already had can be kept`);
      const after = await unmatchedStored();
      assert.equal(after - before, 1,
        'ythril_faces_stored_unmatched_total{reason} did not move by one: an operator sees faces stored unlabelled for want of a gallery only here');
    });
  });
});
