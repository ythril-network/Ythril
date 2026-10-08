/**
 * An image a peer delivered is analysed for faces only when `faceRecognition.reprocessSyncedImages` is true, on EVERY door it can
 * arrive by (bundle-48, privacy lens; plan D1, faces).
 *
 * ## The defect
 *
 * `reprocessSyncedImages` is documented as the operator's choice of whether images received through a network sync build the
 * face gallery (`05c-face-recognition.md`, `04a-media-and-embedding.md`: `false` keeps the gallery to images uploaded here).
 * Face data is the part of the media pipeline with real privacy weight, and the setting was applied by WHICH DOOR a file came
 * through, not by the rule:
 *
 *  - the upload door (a peer's byte push) queued a normal media job, and `embedImage` analysed faces in it whatever the setting
 *    said, so `false` governed nothing for a pushed image;
 *  - the manifest pull obeyed it only through a re-enqueue of its own in the sync engine, which bundle-48 removes (a pulled image
 *    gets the one media job every arrival gets), so without a rule in the job a pulled image would have lost the setting too.
 *
 * ## The rule, over every door
 *
 *  1. an image that ARRIVED (a peer's push, single or chunked, or the manifest pull) is captioned either way, and analysed for
 *     faces when the setting is true and NOT when it is false;
 *  2. an image written HERE (a person's upload, single or chunked) is analysed for faces whatever the setting says: the setting
 *     governs what comes from a network, never what an operator uploads.
 *
 * ## What is observed, and why it is the real worker over the real doors
 *
 * Nothing is stubbed but the model endpoints. A real worker claims the job the door queued and runs `embedImage`; the vision
 * provider is a fake Ollama on loopback, and the space sits at the `recognition` rung so a face analysis is allowed. The image's
 * bytes are NOT a decodable image on purpose: the face analysis (`embedFaces`) decodes first and says so when it cannot
 * (`Face recogniser: image decode failed for <space>/<path>`), so that line is the observation "the face analysis ran" without
 * loading a face model. The control row (a person's upload under both settings) proves the line appears when the analysis runs,
 * so a negative cannot pass because the line was never going to be written.
 *
 * The doors are derived, not listed: the byte door's four callers come from `UPLOAD_DOORS` (a person and a peer, one request and
 * chunked) and the pull is added beside them.
 *
 * ## Seen red
 *
 * On the base the arrival rows with the setting `false` fail on all three arrival doors (the analysis ran), and every row with the
 * setting `true` and every person's row is green: they hold what the fix must not break.
 *
 * Run: node --test testing/standalone/an-arrived-image-gets-faces-only-when-synced-images-are-reprocessed-db.test.js
 * (requires a prior `npm run build:server`)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { openPullDoor } from './_pull-door.mjs';
import { openByteDoor } from './_byte-door.mjs';
import { UPLOAD_DOORS } from './_byte-door-uploads.mjs';
import { listenOnLoopback } from '../_shared/local-server.mjs';
import { waitFor } from '../_shared/wait-for.mjs';

// Models are offline: only the caption endpoint below is reachable, and the space suppresses vectors, so nothing asks an embedder.
process.env['YTHRIL_MODELS_OFFLINE'] = '1';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();

const S = 'arrivedfaces';
/** The bytes are not an image: the face analysis says so when it is asked to decode them, which is how it is seen to run. */
const NOT_AN_IMAGE = 'bytes that are not a decodable image';

let door, bytes, vision, worker;

/**
 * Every way an image gets here, as `{ name, arrival, deliver(path) }`. The byte door's four come from the module that owns them
 * (`UPLOAD_DOORS`: a person and a peer, one request and chunked); the pull is the fifth. `deliver` runs in a case, after `before`
 * has opened the doors.
 */
const DOORS = [
  ...UPLOAD_DOORS.map(u => ({
    name: u.name, arrival: u.arrival,
    deliver: async (id) => {
      const r = await u.send(bytes, { space: S, path: id, content: NOT_AN_IMAGE, peer: 'arrived-faces-peer' });
      assert.ok([201, 202].includes(r.code), `fixture: the upload of ${id} (${u.name}) was refused: ${JSON.stringify(r)}`);
    },
  })),
  {
    name: 'the manifest pull', arrival: true,
    deliver: async (id) => {
      door.seedPeerFile(S, id, NOT_AN_IMAGE);
      await door.sync();
      assert.ok(await door.coll(S, 'files').findOne({ _id: id }), `fixture: the pull did not record ${id}`);
    },
  },
];

const jobOf = (id) => door.coll(S, 'media_jobs').findOne({ _id: id });
const captionOf = (id) => door.coll(S, 'files').findOne({ _id: `${id}#media-chunk0` });

/** Set what the cases need: the setting under test, a vision endpoint that answers, and the ladder rung that allows faces. */
function configure(reprocessSyncedImages) {
  door.config().mediaEmbedding = {
    // The instance ceiling for images is `caption` by default, and a space cannot go above it.
    levels: { images: 'recognition' },
    vision: { baseUrl: vision.url, model: 'fake' },
    workerPollIntervalMs: 100,
    workerMaxPollIntervalMs: 200,
    faceRecognition: { enabled: true, reprocessSyncedImages },
  };
}

/** Run the real worker until the job for `id` has finished, and say whether the face analysis ran in it. */
async function facesRanWhileWorking(id) {
  const { lines } = await door.logsDuring(async () => {
    worker.startMediaEmbeddingWorker();
    try {
      await waitFor(async () => ['complete', 'failed'].includes((await jobOf(id))?.status), 30_000, 100,
        async () => `the worker never finished the job for ${id}: ${JSON.stringify(await jobOf(id))}`);
    } finally {
      worker.stopMediaEmbeddingWorker();
    }
  });
  const job = await jobOf(id);
  assert.equal(job?.status, 'complete', `fixture: the media job did not complete (${JSON.stringify(job)})`);
  assert.ok(await captionOf(id), `fixture: the caption chunk was not stored for ${id}: the job did not run the image embedder`);
  return lines.some(l => l.includes(`image decode failed for ${S}/${id}`));
}

describe('an arrived image is analysed for faces only when synced images are reprocessed', { skip }, () => {
  before(async () => {
    vision = await listenOnLoopback(http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ message: { content: 'a grey rectangle' } }));
      });
    }));
    door = await openPullDoor({
      suite: 'arrivedfaces', spaces: [S], files: true,
      meta: { [S]: { suppressEmbeddings: true } }, spaceExtra: { [S]: { imageAnalysis: 'recognition' } },
    });
    bytes = await openByteDoor();
    worker = await import('../../server/dist/files/media/worker.js');
  });
  after(async () => {
    try { worker?.stopMediaEmbeddingWorker(); } catch { /* never started */ }
    await door?.close();
    await vision?.close();
  });
  beforeEach(async () => { await door.reset(); });

  it('the doors are derived from what the byte door offers, and both kinds are present', () => {
    assert.ok(DOORS.some(d => d.arrival) && DOORS.some(d => !d.arrival), 'the table needs arrivals and local writes, or it asserts nothing');
    assert.ok(DOORS.filter(d => d.arrival).length >= 3, 'a peer push (single and chunked) and the pull are the arrival doors');
    assert.equal(new Set(DOORS.map(d => d.name)).size, DOORS.length, 'two doors share a name');
  });

  it('a person\'s write to a path whose queued job is an arrival\'s makes it a local image: faces run with the setting false', async () => {
    const id = 'faces-overwritten.png';
    configure(false);
    const peerDoor = DOORS.find(d => d.arrival && d.name === 'a peer, one request');
    await peerDoor.deliver(id);
    assert.equal((await jobOf(id))?.arrival, true, 'fixture: the peer\'s push did not queue an arrival job');
    const r = await UPLOAD_DOORS.find(u => !u.arrival && !u.chunked).send(bytes, { space: S, path: id, content: `${NOT_AN_IMAGE}, written here instead` });
    assert.ok([201, 202].includes(r.code), `fixture: the person's upload was refused: ${JSON.stringify(r)}`);
    assert.equal((await jobOf(id))?.status, 'pending', 'fixture: the person\'s write did not leave the job queued');

    assert.equal(await facesRanWhileWorking(id), true,
      'an image a person wrote over an arrival was held to the setting that governs what a network delivers');
  });

  for (const reprocess of [true, false]) {
    describe(`reprocessSyncedImages = ${reprocess}`, () => {
      DOORS.forEach((d, i) => {
        it(`${d.name}: faces run exactly when the rule says`, async () => {
          const id = `faces-${reprocess}-${i}.png`;
          configure(reprocess);
          await d.deliver(id);
          assert.equal((await jobOf(id))?.status, 'pending', 'fixture: the door queued no media job');

          const ran = await facesRanWhileWorking(id);

          // An arrival is held to the setting; an image written here never is.
          const want = d.arrival ? reprocess : true;
          assert.equal(ran, want, d.arrival
            ? `${d.name}: an arrived image ${ran ? 'WAS' : 'was NOT'} analysed for faces with reprocessSyncedImages=${reprocess}`
            : `${d.name}: an image written here ${ran ? 'was' : 'was NOT'} analysed for faces with reprocessSyncedImages=${reprocess}; the setting governs what a network delivers, never what a person uploads`);
        });
      });
    });
  }
});
