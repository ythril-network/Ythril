/**
 * A face that already had a label keeps it through a re-run whose gallery COULD NOT ANSWER, and through nothing else (Q-698, bundle-236).
 *
 * ## The defect
 *
 * `embedFaces` stores every face of a run as a fresh row, label and all: the label is whatever `gallerySearch` answered for it. When the
 * gallery cannot answer - the face index refuses every search (`index_unavailable`), or the job's deferrals are spent - the face is stored
 * with NO label, and a label a person set (or the gallery gave on an earlier run) is overwritten by "nobody". Nothing runs the face again.
 * The answer was `null` for "no labelled face matches" and for "could not answer" alike, so the writer could not tell a stranger from a
 * gallery that was down.
 *
 * ## The rules (DESIGN v3 C10, v3-premises C20)
 *
 * `gallerySearch` answers `match` | `no_match` | `could_not_answer`. Only `could_not_answer` carries a label, from a snapshot of the file's
 * stored face rows taken once before the loop:
 *
 *  1. The new box and an old row's box overlap at IoU of at least 0.5 (exactly 0.5 carries; just below does not).
 *  2. Assignment is one-to-one: two new boxes over one old row, only the better takes it.
 *  3. A row without `faceBbox` carries nothing; a zero-area box carries nothing (its IoU is 0/0), old or new.
 *  4. A `no_match` (a gallery that ANSWERED) does not carry: the face is no one the gallery knows.
 *  5. A label whose person no longer resolves does not carry.
 *  6. The label and its `faceScore` travel together, and a carried label NEVER sets the parent's person link: the link is a replicated
 *     write, and the label is only kept, not found.
 *  7. A job whose deferrals are spent (`galleryMayDefer: false`) is a `could_not_answer` too: it carries, and the counter of faces stored
 *     unmatched counts each face once.
 *
 * ## Why every case holds a control face
 *
 * A "does not carry" case is green on the base for a wrong reason: the base carries nothing at all. So each case re-runs TWO faces, the
 * case and a control whose box is identical to its old row's (IoU 1, a person that exists): the control must carry, the case must not. On
 * the base the control fails, which is the failure the change fixes; the case's own assertion is what holds after it.
 *
 * ## How
 *
 * The real `embedFaces` over a real Mongo, with the external face provider answered by the parked harness (`_parked-media-runs.mjs`, which
 * now answers a `boxRaw`), under a claim made by `seedClaim`. The gallery that cannot answer is injected with `refuseVectorSearch` (a
 * dimension mismatch is `index_unavailable`; a not-yet refusal with deferrals spent is `deferral_spent`); the gallery that answers is a REAL
 * face index holding one labelled face far from the query. Same bytes only (a row made from other bytes carries nothing) is C3's rule and
 * needs the run's `sourceSha256`, whose shape the implementation fixes; it is not asserted here.
 *
 * Seen red on the base: the control face comes back unlabelled (`faceEntityId` undefined), and `gallerySearch` answers `null`.
 *
 * Needs a MongoDB with mongot and a private address: `npm run test:up`.
 *
 * Run: node --test testing/standalone/a-face-keeps-its-label-through-a-re-run-only-when-the-gallery-could-not-answer-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { openParkedMediaRuns } from './_parked-media-runs.mjs';
import { seedClaim } from './_media-claim.mjs';
import { REFUSALS, refuseVectorSearch } from './_mongot-refusals.mjs';
import { unitAt, waitUntilServing } from './_vector-harness.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();
const S = 'facecarry';
const T0 = '2026-09-01T00:00:00.000Z';
const FACE_DIMS = 128;
const PERSON = 'person-1';
const GONE = 'person-gone';
const SCORE = 0.91;

/** The old row's box, and what overlaps it by a known IoU. Boxes are [x, y, w, h], normalised; every number is a dyadic fraction, so the IoU is exact. */
const A = [0.25, 0.25, 0.5, 0.5];
const A_HALF = [0.25, 0.25, 0.5, 0.25];      // inside A, half its area: IoU exactly 0.5
const A_JUST_UNDER = [0.25, 0.25, 0.5, 0.24]; // 0.12 / 0.25 = 0.48
const A_THREE_QUARTERS = [0.25, 0.25, 0.5, 0.375]; // 0.75
/** The control: a box away from every other, identical in the old row and the new face. */
const CTL = [0.0, 0.0, 0.125, 0.125];

let runs, acts, embedFaces, metrics, png, scratch, seq = 0;
const files = () => acts.door.coll(S, 'files');

async function seedParent(p) {
  await files().insertOne({ _id: p, spaceId: S, path: p, sizeBytes: png.length, tags: [], createdAt: T0, updatedAt: T0, seq: 1 });
}

/** One stored face row of `file`: the old run's. `label: null` is an unlabelled face; `box: undefined` a row with no `faceBbox`. */
async function seedFaceRow(file, i, { box, label = PERSON, score = SCORE }) {
  const id = `${file}#face-chunk${i}`;
  await files().insertOne({
    _id: id, spaceId: S, path: id, tags: [], createdAt: T0, updatedAt: T0, sizeBytes: FACE_DIMS * 4, parentFileId: file, chunkIndex: i,
    faceEmbedding: unitAt(20 + i * 7, FACE_DIMS),
    ...(box ? { faceBbox: box } : {}), ...(label ? { faceEntityId: label, faceScore: score } : {}),
  });
}

/** The face rows of `file` after a run, by chunk index. */
async function faceRowsOf(file) {
  const rows = await files().find({ parentFileId: file, faceEmbedding: { $exists: true } }).sort({ chunkIndex: 1 }).toArray();
  return new Map(rows.map(r => [r.chunkIndex, r]));
}

/** Write the image to a handle `embedFaces` takes (a path and a size). */
function handleOf() {
  const p = path.join(scratch, `fixture-${seq++}.png`);
  fs.writeFileSync(p, png);
  return { path: p, size: png.length, copied: true, dispose: async () => { /* the suite removes its scratch */ } };
}

/**
 * Re-run the faces of `file`: the provider answers `boxes` (one face each, the embedding at 0 degrees from the query axis, so a gallery that
 * answers finds the labelled face far behind it), under `refusal` (a `REFUSALS` entry, or none for a gallery that answers).
 */
async function rerun(file, boxes, { refusal = REFUSALS.dimensionMismatch, opts = {} } = {}) {
  runs.setFaces(boxes.map(boxRaw => ({ boxRaw, embedding: unitAt(0, FACE_DIMS) })));
  const fault = refusal ? refuseVectorSearch(refusal) : null;
  try {
    await embedFaces(S, file, handleOf(), { claim: await seedClaim(S, file), ...opts });
  } finally {
    fault?.restore();
  }
  if (fault) assert.ok(fault.refused() >= 1, 'fixture check: the injected refusal never reached the gallery\'s vector search');
}

/** The control face (the last one of the run) kept its label: without it a "does not carry" case below is green on the base for the wrong reason. */
function assertControlKept(rows, i) {
  const r = rows.get(i);
  assert.ok(r, `fixture check: no face row ${i} was stored`);
  assert.equal(r.faceEntityId, PERSON,
    `the control face (an identical box over a row labelled ${PERSON}) came back with label ${JSON.stringify(r.faceEntityId)}: a gallery that could not answer wrote "no one" over a label the face had`);
  assert.equal(r.faceScore, SCORE, 'the label and its faceScore travel together');
}

const unlabelled = (r) => r && r.faceEntityId === undefined && r.faceScore === undefined;

/** The sum of the counter's series for one reason, read from the registry. */
async function unmatched(reason) {
  const text = await metrics.register.metrics();
  const m = text.match(new RegExp(`^ythril_faces_stored_unmatched_total\\{[^}]*reason="${reason}"[^}]*\\} (\\d+(?:\\.\\d+)?)$`, 'm'));
  return m ? Number(m[1]) : 0;
}

describe('a face keeps its label through a re-run only when the gallery could not answer (real embedFaces, real Mongo)', { skip }, () => {
  before(async () => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-facecarry-'));
    runs = await openParkedMediaRuns({ suite: 'facecarry', space: S, faces: true });
    acts = runs.acts;
    runs.face.parking(false);
    runs.vision.parking(false);
    ({ embedFaces } = await import('../../server/dist/files/media/face-embedder.js'));
    metrics = await import('../../server/dist/metrics/registry.js');
    png = await createRequire(new URL('../../server/package.json', import.meta.url))('sharp')({
      create: { width: 200, height: 200, channels: 3, background: '#8899aa' },
    }).png().toBuffer();
    await acts.door.coll(S, 'entities').insertOne({ _id: PERSON, spaceId: S, name: 'Ada', type: 'person', tags: [], properties: {} });
    // A REAL face index holding one labelled face 170 degrees from the query axis: a gallery that ANSWERS, and finds nobody near the query.
    await seedParent('anchor.png');
    await seedFaceRow('anchor.png', 0, { box: CTL });
    await files().updateOne({ _id: 'anchor.png#face-chunk0' }, { $set: { faceEmbedding: unitAt(170, FACE_DIMS) } });
    await (await import('../../server/dist/spaces/search-index-presence.js')).reconcileSpaceSearchIndexes(S, { waitForReady: true });
    await waitUntilServing(
      { col: (name) => acts.door.coll(S, name.replace(`${S}_`, '')) },
      `${S}_files`, `${S}_files_faceEmbedding`, { path: 'faceEmbedding', dims: FACE_DIMS, n: 1 });
  });
  after(async () => {
    await runs?.close();
    try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* best effort */ }
  });
  beforeEach(() => { runs.setFaces([{}]); });

  it('keeps the label of an old row the new box overlaps at IoU exactly 0.5, with its score, and writes no link on the file', async () => {
    const file = 'iou-half.png';
    await seedParent(file);
    await seedFaceRow(file, 0, { box: A });
    await seedFaceRow(file, 1, { box: CTL });
    await rerun(file, [A_HALF, CTL]);
    const rows = await faceRowsOf(file);
    assert.equal(rows.get(0)?.faceEntityId, PERSON, 'a box at IoU exactly 0.5 over a labelled row lost its label');
    assert.equal(rows.get(0)?.faceScore, SCORE, 'the label and its faceScore travel together');
    assertControlKept(rows, 1);
    // A carried label is kept, not found: it never sets the parent's person link (a replicated write, outside the claim's fence).
    assert.deepEqual(await acts.door.coll(S, 'links').find({ from: file }).toArray(), [], 'a carried label wrote a link from the file to the person');
    assert.equal((await files().findOne({ _id: file })).updatedAt, T0, 'a carried label touched the parent row');
  });

  it('does not keep it when the new box overlaps just below 0.5', async () => {
    const file = 'iou-under.png';
    await seedParent(file);
    await seedFaceRow(file, 0, { box: A });
    await seedFaceRow(file, 1, { box: CTL });
    await rerun(file, [A_JUST_UNDER, CTL]);
    const rows = await faceRowsOf(file);
    assertControlKept(rows, 1);
    assert.ok(unlabelled(rows.get(0)), `a box at IoU 0.48 took the label ${JSON.stringify(rows.get(0)?.faceEntityId)}`);
  });

  it('does not keep it from a row with no faceBbox, nor for a zero-area box', async () => {
    const noBox = 'no-box.png';
    await seedParent(noBox);
    await seedFaceRow(noBox, 0, { box: undefined });
    await seedFaceRow(noBox, 1, { box: CTL });
    await rerun(noBox, [A, CTL]);
    const rows = await faceRowsOf(noBox);
    assertControlKept(rows, 1);
    assert.ok(unlabelled(rows.get(0)), 'a row with no faceBbox gave its label to a box');

    // A zero-area box passes the size filter only when the minimum face size is 0; its IoU with an identical one is 0 / 0.
    const flat = [0.5, 0.5, 0, 0.25];
    const faceCfg = (await import('../../server/dist/config/loader.js')).getConfig().mediaEmbedding.faceRecognition;
    const was = faceCfg.minFaceSizeFraction;
    faceCfg.minFaceSizeFraction = 0;
    try {
      const zero = 'zero-area.png';
      await seedParent(zero);
      await seedFaceRow(zero, 0, { box: flat });
      await seedFaceRow(zero, 1, { box: CTL });
      await rerun(zero, [flat, CTL]);
      const zrows = await faceRowsOf(zero);
      assertControlKept(zrows, 1);
      assert.ok(unlabelled(zrows.get(0)), 'a zero-area box (0 / 0 overlap) took a label');
    } finally {
      faceCfg.minFaceSizeFraction = was;
    }
  });

  it('is one-to-one: two new boxes over one old row, only the better overlap takes the label', async () => {
    const file = 'one-to-one.png';
    await seedParent(file);
    await seedFaceRow(file, 0, { box: A });
    await seedFaceRow(file, 2, { box: CTL });
    // Face 0 overlaps at 0.75 and comes first; face 1 overlaps at 1.0. The row goes to face 1.
    await rerun(file, [A_THREE_QUARTERS, A, CTL]);
    const rows = await faceRowsOf(file);
    assertControlKept(rows, 2);
    assert.equal(rows.get(1)?.faceEntityId, PERSON, 'the box that overlaps best did not take the label');
    assert.equal(rows.get(1)?.faceScore, SCORE);
    assert.ok(unlabelled(rows.get(0)), 'the second box over the same old row took the label too: a label is one person\'s face, once');
  });

  it('does not keep the label of a person who no longer resolves', async () => {
    const file = 'gone.png';
    await seedParent(file);
    await seedFaceRow(file, 0, { box: A, label: GONE });
    await seedFaceRow(file, 1, { box: CTL });
    await rerun(file, [A, CTL]);
    const rows = await faceRowsOf(file);
    assertControlKept(rows, 1);
    assert.ok(unlabelled(rows.get(0)), `a label of a deleted person (${GONE}) was kept: the dangling reference would seed new labels`);
  });

  it('does not keep a label when the gallery ANSWERED (no_match), where it does when it could not', async () => {
    const answered = 'answered.png';
    const refused = 'refused.png';
    for (const file of [answered, refused]) {
      await seedParent(file);
      await seedFaceRow(file, 0, { box: A });
    }
    // The control: the same face, the gallery refusing - the label is kept.
    await rerun(refused, [A]);
    assert.equal((await faceRowsOf(refused)).get(0)?.faceEntityId, PERSON, 'control: a gallery that could not answer did not keep the label');
    // The gallery answers: the face is not the one labelled face the gallery holds (170 degrees away), so it is no_match, and no_match is an answer.
    const refusedBefore = await unmatched('index_unavailable');
    await rerun(answered, [A], { refusal: null });
    assert.equal(await unmatched('index_unavailable'), refusedBefore,
      'fixture check: the gallery that should have ANSWERED refused (the face index was not serving), so this case says nothing about no_match');
    assert.ok(unlabelled((await faceRowsOf(answered)).get(0)), 'a gallery that answered "no one" was overruled by the label the face had');
  });

  it('keeps a label when the job\'s deferrals are spent (the gallery could not answer in time), and counts each face once from any starting value', async () => {
    const file = 'spent.png';
    await seedParent(file);
    await seedFaceRow(file, 0, { box: A });
    await seedFaceRow(file, 1, { box: CTL });
    // Poisoned: the counter starts from a value a run cannot have made, so only the DIFFERENCE is the run's.
    metrics.facesStoredUnmatchedTotal.labels({ reason: 'deferral_spent' }).inc(41);
    const before = await unmatched('deferral_spent');
    await rerun(file, [A, CTL], { refusal: REFUSALS.initialSync, opts: { galleryMayDefer: false } });
    const rows = await faceRowsOf(file);
    assert.equal(rows.get(0)?.faceEntityId, PERSON, 'a face stored because the deferrals were spent lost the label it had');
    assertControlKept(rows, 1);
    assert.equal((await unmatched('deferral_spent')) - before, 2, 'ythril_faces_stored_unmatched_total{reason="deferral_spent"} did not move by one per face');
  });
});
