/**
 * An image run removes the rows that OTHER bytes at its path made, before it spends a model call, and stamps every row it writes with the
 * bytes it analysed (bundle-236, Q-698, DESIGN v3 C3 and C17).
 *
 * ## The defect that bought it
 *
 * A picture replaced at its path kept its caption row and every face row of the picture that was there before, until a new run happened to
 * write the same ids. New bytes with fewer faces left the extra face row where it was, stored, matched by the gallery and carrying a label,
 * under an image it was never made from. Nothing on a derived row said which bytes it came from, so nothing could tell it from the new run's.
 *
 * ## The rules
 *
 *  1. Every derived row a run writes (its caption, each face row) carries `sourceSha256`, the job's own hash (`MediaJobDoc.sha256`): stamped by
 *     the writer from the run's claim, so no caller can drop it.
 *  2. At the START of the run, before the vision call, the rows of the file whose `sourceSha256` is present and DIFFERS from the job's are gone:
 *     the old caption, the old faces, including the face row the new bytes do not have. A row with NO `sourceSha256` (written before the stamp
 *     existed) counts as the same bytes and stays.
 *  3. A run whose job has NO hash (an extracted image's, a lazy repair's) stamps nothing and clears nothing: there is nothing to call different.
 *
 * ## How
 *
 * The real worker over a real Mongo, the vision call parked (`_parked-media-runs.mjs`): "at the start of the run, before any model call" is
 * read as the state of the rows WHILE the run is parked inside its caption call, which is a fact the test waits for, not a guess.
 *
 * ## Seen red
 *
 * With the stamp and the clear taken out (the writer's `stampedWith` returning the row as given, the worker's `clearRowsOfOtherBytes` call
 * removed): case 1 fails at the parked state (the old caption and faces are still stored while the run is inside its vision call) and on the
 * stamp of the rows it writes; case 2 fails on the stamp. Case 3 is the characterisation of the empty hash and stays green on both.
 *
 * Needs a MongoDB and a private address (the face endpoint is fetched through the SSRF guards): `npm run test:up`.
 *
 * Run: node --test testing/standalone/a-media-run-clears-the-rows-of-other-bytes-at-its-start-db.test.js
 * (requires a prior `npm run build:server`)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { openParkedMediaRuns } from './_parked-media-runs.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();
const S = 'clearotherbytes';
const T0 = '2026-09-01T00:00:00.000Z';
const OLD = 'o'.repeat(64);
const NEW = 'n'.repeat(64);

let runs, acts, png;
const files = () => acts.door.coll(S, 'files');
const jobs = () => acts.door.coll(S, 'media_jobs');

const seedPicture = (p) => runs.seedPicture(p, png);

/** A derived row of `p` as an earlier run stored it; `sourceSha256: undefined` is a row written before the stamp existed. */
const derivedRow = (p, suffix, sourceSha256, extra = {}) => ({
  _id: `${p}#${suffix}`, spaceId: S, path: `${p}#${suffix}`, tags: [], createdAt: T0, updatedAt: T0, sizeBytes: 5, parentFileId: p, chunkIndex: 0,
  content: `stored for ${suffix}`, ...(sourceSha256 ? { sourceSha256 } : {}), ...extra,
});
const seedRows = (p, rows) => files().insertMany(rows.map(([suffix, sha, extra]) => derivedRow(p, suffix, sha, extra)));
const idsOf = (p) => runs.derivedIds(p);

/** A job the worker can claim now; `sha256` absent is a job with no known hash. */
const pendingJob = (p, sha256) => ({ _id: p, spaceId: S, filePath: p, mimeType: 'image/png', mediaType: 'image', status: 'pending', attempts: 0,
  maxAttempts: 3, lastError: null, claimedAt: null, claimToken: null, claimableAfter: new Date(Date.now() - 1_000).toISOString(),
  ...(sha256 ? { sha256 } : {}), createdAt: T0, updatedAt: T0 });

/** Start the run of `p` and answer once it is INSIDE its (parked) vision call; the caller releases it and waits for the end. */
async function startParked(p, job) {
  runs.vision.parking(true);
  const n = runs.vision.calls.length + 1;
  const ended = runs.runEnded(p);
  await jobs().insertOne(job);
  runs.queue.markSpaceMayHaveWork(S);
  runs.worker.startMediaEmbeddingWorker();
  await runs.vision.arrival(n);
  return { n, ended };
}
const finish = async ({ n, ended }) => { runs.vision.release(n); return ended; };

describe('an image run clears the rows of other bytes at its start and stamps the rows it writes (real worker, real Mongo)', { skip }, () => {
  before(async () => {
    runs = await openParkedMediaRuns({ suite: 'clearotherbytes', space: S, faces: true });
    acts = runs.acts;
    png = await createRequire(new URL('../../server/package.json', import.meta.url))('sharp')({
      create: { width: 64, height: 64, channels: 3, background: '#888888' },
    }).png().toBuffer();
  });
  after(async () => { await runs?.close(); });
  beforeEach(async () => {
    await acts.reset();
    await jobs().deleteMany({});
    await files().deleteMany({});
    runs.vision.parking(false);
    runs.face.parking(false);
    runs.setFaces([{}]);
  });

  it('new bytes: the old caption and the old faces are gone while the run is still inside its first model call; the rows it then writes carry its hash', async () => {
    const p = 'replaced.png';
    await seedPicture(p);
    // The picture that was here had a caption and TWO faces; the one that replaced it has one. A row stored before the stamp existed stays.
    await seedRows(p, [['media-chunk0', OLD], ['face-chunk0', OLD, { faceEmbedding: [0.1] }], ['face-chunk1', OLD, { faceEmbedding: [0.2] }], ['face-chunk7', undefined, { faceEmbedding: [0.3] }]]);

    const run = await startParked(p, pendingJob(p, NEW));

    assert.deepEqual(await idsOf(p), [`${p}#face-chunk7`],
      'the run is inside its vision call and the rows the OLD bytes made are still stored (only the row with no stamp may be): they are cleared at the start of the run, or never');
    await finish(run);

    const rows = await files().find({ parentFileId: p }).sort({ _id: 1 }).toArray();
    assert.deepEqual(rows.map(r => r._id), [`${p}#face-chunk0`, `${p}#face-chunk7`, `${p}#media-chunk0`],
      'the new run wrote one caption and one face: the old second face must not survive it');
    for (const r of rows.filter(r => r._id !== `${p}#face-chunk7`)) {
      assert.equal(r.sourceSha256, NEW, `${r._id} was written by the run over the new bytes and does not say so`);
    }
    assert.ok(!('sourceSha256' in rows.find(r => r._id === `${p}#face-chunk7`)), 'a row with no stamp is left exactly as it was');
    assert.equal((await jobs().findOne({ _id: p })).status, 'complete');
  });

  it('the same bytes: nothing of the run\'s own bytes is cleared (the stamp is compared, not assumed)', async () => {
    const p = 'same.png';
    await seedPicture(p);
    await seedRows(p, [['media-chunk0', NEW], ['face-chunk5', NEW, { faceEmbedding: [0.5] }]]);

    const run = await startParked(p, pendingJob(p, NEW));

    assert.deepEqual(await idsOf(p), [`${p}#face-chunk5`, `${p}#media-chunk0`], 'rows made from this run\'s own bytes were cleared at its start');
    await finish(run);
    assert.ok((await files().findOne({ _id: `${p}#face-chunk5` })), 'a same-bytes row the run did not rewrite is still there');
  });

  it('a job with no hash clears nothing and stamps nothing', async () => {
    const p = 'nohash.png';
    await seedPicture(p);
    await seedRows(p, [['media-chunk0', OLD], ['face-chunk5', OLD, { faceEmbedding: [0.5] }]]);

    const run = await startParked(p, pendingJob(p, undefined));

    assert.deepEqual(await idsOf(p), [`${p}#face-chunk5`, `${p}#media-chunk0`], 'a run with no hash to compare cleared rows: there is nothing to call different');
    await finish(run);

    const caption = await files().findOne({ _id: `${p}#media-chunk0` });
    assert.ok(caption.content.startsWith('caption of call'), 'the run did write its caption');
    assert.ok(!('sourceSha256' in caption), 'a claim with no hash stamped one');
    assert.equal((await files().findOne({ _id: `${p}#face-chunk5` })).sourceSha256, OLD, 'the row of the other bytes was touched by a run that cannot tell them apart');
  });
});
