/**
 * A REAL media worker, over a REAL Mongo and the real file doors, whose model calls WAIT until the test lets them answer — the
 * question "what does a run do, and what does everything else do to it, while it is inside a call it cannot yet finish"
 * (bundle-44 D-29, Q-436), answered once for every test that asks it.
 *
 * ## Why a module
 *
 * The claim fence is about an interleaving: a delete, a move or a space wipe landing between the moment a run read what it
 * will write for and the moment it writes. A test that calls a writer directly sets that interleaving up by patching the
 * driver; a test that drives the worker gets it from the run itself, because the model call IS the long step and the test is
 * the only thing that decides when it ends. Two suites ask this (`a-derived-write-racing-a-delete-or-a-move-leaves-no-row-db`,
 * `a-job-writes-nothing-about-its-file-after-its-claim-went-db`), which is why it is here and not in either.
 *
 * ## What it does, and what a hand-written copy drops
 *
 * **A call is released by the test, never by a timer.** Each vision (and, with faces on, face) request is recorded in arrival
 * order and answered only when `release(n)` is called, so "the run is inside its caption call" is a fact the test waits for
 * (`arrival(n)`), not a sleep it guesses at. **The end of a run is read from the worker's own log line**, subscribed BEFORE the
 * release (`runEnded`): a run that ended between the release and the subscribe would be waited for for ever, and a run read as
 * ended by the state it left would pass over the case this exists for — a run that wrote something after its claim went.
 * **The file doors are the real ones** (`openFileActDoors`): a delete, a move or a re-upload is the act a user makes.
 *
 * It does not stub the worker, the queue, the embedders or the writers; only the two model endpoints answer for themselves.
 * The caller must have a reachable mongod and a private address (`privateAddressSkipReason`: the external face provider is
 * fetched through the SSRF guards, which refuse loopback).
 */
import http from 'node:http';
import { openFileActDoors } from './_file-act-doors.mjs';
import { privateHostAddress } from './_private-address.mjs';
import { listenOnLoopback } from '../_shared/local-server.mjs';
import { waitFor } from '../_shared/wait-for.mjs';

/** The width of a face descriptor the external provider answers with (`faceDescriptorDimsFor`'s default). */
const FACE_DIMS = 128;

/**
 * A model endpoint whose every call waits for the test. `calls[n - 1]` is call `n`: `{ n, released, release() }`.
 * `arrival(n)` resolves once call `n` has reached the server; `release(n)` lets it answer; `parking(false)` makes every call from
 * now on answer at once (a control run, or the second run of a test that parks only the first).
 */
function parkedEndpoint(answer) {
  const calls = [];
  const arrivals = new Map();
  let parking = true;
  const arrivedFn = (n) => {
    if (!arrivals.has(n)) { let resolve; const p = new Promise(r => { resolve = r; }); arrivals.set(n, { p, resolve }); }
    return arrivals.get(n);
  };
  const handler = (req, res) => {
    req.resume();
    req.on('end', () => {
      const call = { n: calls.length + 1, released: false };
      call.gate = new Promise(r => { call.release = () => { call.released = true; r(); }; });
      calls.push(call);
      arrivedFn(call.n).resolve(call);
      if (!parking) call.release();
      void call.gate.then(() => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(answer(call.n)));
      });
    });
  };
  return {
    handler, calls,
    arrival: (n) => arrivedFn(n).p,
    release: (n) => calls[n - 1]?.release(),
    /** Park every call from now on (`true`), or answer every call at once (`false`, which also lets go of the parked ones). */
    parking(on) { parking = on; if (!on) for (const c of calls) c.release(); },
    releaseAll() { for (const c of calls) c.release(); },
  };
}

/**
 * @param {object} o
 * @param {string} o.suite  harness database slug, unique to the caller
 * @param {string} o.space
 * @param {boolean} [o.faces]  the external face provider on, the space at the `recognition` rung
 */
export async function openParkedMediaRuns({ suite, space, faces = false }) {
  const acts = await openFileActDoors({ suite, space });
  const loader = await import('../../server/dist/config/loader.js');
  const queue = await import('../../server/dist/files/media/job-queue.js');
  const worker = await import('../../server/dist/files/media/worker.js');
  const logMod = await import('../../server/dist/util/log.js');

  const vision = parkedEndpoint((n) => ({ message: { content: `caption of call ${n}` } }));
  const visionServer = await listenOnLoopback(http.createServer(vision.handler));
  const face = faces ? parkedEndpoint(() => ({ faces: [{ embedding: Array.from({ length: FACE_DIMS }, (_, i) => (i + 1) / 200) }] })) : null;
  let faceServer = null;
  let faceUrl = null;
  if (face) {
    faceServer = http.createServer(face.handler);
    // own-listener: binds the host's private address, because the SSRF guard refuses loopback and the face provider is fetched through it
    await new Promise(r => faceServer.listen(0, privateHostAddress(), r));
    faceUrl = `http://${privateHostAddress()}:${faceServer.address().port}/faces`;
  }

  const cfg = loader.getConfig();
  cfg.mediaEmbedding = {
    levels: { images: faces ? 'recognition' : 'caption' },
    visionProvider: 'local',
    vision: { baseUrl: visionServer.url, model: 'fake' },
    workerPollIntervalMs: 100,
    workerMaxPollIntervalMs: 200,
    workerConcurrency: 2,
    faceRecognition: faces
      ? { enabled: true, externalModel: { baseUrl: faceUrl, acknowledgedHost: new URL(faceUrl).host } }
      : { enabled: false },
  };
  if (faces) cfg.allowPrivateModelEndpointsBySlot = { faceExternal: true };

  /** The log lines a run of `p` ends with: completed, abandoned, failed, or its source found gone. */
  const endOf = (p) => new RegExp(`Media worker: (completed \\w+ job|abandoning|job|source file) ${space}/${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);

  return {
    acts, vision, face, queue, worker, space,
    /**
     * Subscribe to the end of the NEXT run of `p`, and answer a promise of its log line. Call it BEFORE releasing the call the
     * run is parked in, and keep the promise: a run that ends first is otherwise waited for for ever.
     */
    runEnded(p) {
      const re = endOf(p);
      let unsubscribe;
      const ended = new Promise(resolve => {
        unsubscribe = logMod.subscribeLogLines(line => { if (re.test(line)) resolve(line); });
      });
      return ended.finally(() => unsubscribe());
    },
    /** Queue the job for the already-stored file `p` and make sure the worker is running. */
    async startRun(p, mime = 'image/png') {
      await queue.enqueueMediaJob(space, p, mime, 'image');
      worker.startMediaEmbeddingWorker();
    },
    /** Wait until the job of `p` is claimed (`processing`) — the run exists. */
    async claimed(p) {
      await waitFor(async () => (await acts.door.coll(space, 'media_jobs').findOne({ _id: p }))?.status === 'processing', 15_000, 50,
        `the worker never claimed the job of ${p}`);
    },
    async close() {
      worker.stopMediaEmbeddingWorker();
      vision.parking(false);
      face?.parking(false);
      await visionServer.close();
      await new Promise(r => (faceServer ? faceServer.close(r) : r()));
      await acts.close();
    },
  };
}
