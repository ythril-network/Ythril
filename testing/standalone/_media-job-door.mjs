/**
 * Drive the REAL media worker over a REAL Mongo and the real file door, with the model endpoints and `ffmpeg` answered at
 * the process boundary: the question "what does a media job do with the file it was queued for", answered once for every
 * test that asks it (bundle-89, Q-425).
 *
 * ## Why this is a module and the door is the worker
 *
 * The embedders (`embedImage`, `embedAudio`, `embedVideo`) take what the worker hands them, and bundle-89 changes what that
 * is (a plaintext path or a stream where it was one `Buffer`). A test that called an embedder directly would be written
 * against a signature that is about to change. The worker's door does not change: a file is stored, a job is queued, the
 * worker claims it and the endpoints see the result. Every rule this module is used for (memory, scratch copies, segment
 * lengths, the snapshot an `ffmpeg` reads) is observable from there, so the tests keep stating the rule when the plumbing
 * behind it moves.
 *
 * ## The things a hand-written copy drops
 *
 * **The file goes in through the file door** (`pipeToStored`), as an upload does: with a master secret it is ciphertext on
 * disk, which is the half of the question that costs memory and leaves a decrypted copy. A file written with `fs` would be
 * plaintext whatever the secret said.
 *
 * **The file is written as a STREAM.** A large fixture built as one `Buffer` raises the process's peak before the job starts,
 * and a peak only ever rises: the measurement would read the fixture, not the job.
 *
 * **`ffmpeg` is answered at `child_process.spawn`**, so the audio and video embedders run their real chunking, storing and
 * wrapper code on a machine without the binary (`a-suppressed-file-holds-no-conversion-or-media-vector-db` does the same).
 * The fake keeps what a test needs to ask: every call's arguments, the bytes its INPUT held when it was started, and whether it
 * was killed. It honours `-t`, `-frames:v` and `-vframes` the way ffmpeg does, so a cap the code adds is seen to work rather
 * than only to be present.
 *
 * ## What it does not do
 *
 * It does not stub the worker, the queue, the file door, the embedders or the providers. Nothing is faked but the model
 * endpoints a test names and the `ffmpeg` binary.
 */
import fs from 'node:fs';
import path from 'node:path';
import cp from 'node:child_process';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { openPushDoor } from './_push-door.mjs';
import { waitFor } from '../_shared/wait-for.mjs';

process.env['YTHRIL_MODELS_OFFLINE'] = '1';

export { MARKER, streamOfSize } from './_sized-stream.mjs';

// ── ffmpeg, at the process boundary ──────────────────────────────────────────────────────────────────────────────

const realSpawn = cp.spawn;

const hhmmss = (s) => {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s - h * 3600 - m * 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${sec.toFixed(2).padStart(5, '0')}`;
};
const flag = (args, name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };

/**
 * Replace `ffmpeg` for this process. `spawn(cmd, args)` for any other command goes to the real one.
 *
 * @param {object} o
 * @param {number|((call: object) => number)} [o.durationS]  what the duration probe reports, and the length the input holds (a function of the call, so the video's audio track can be shorter than the video)
 * @param {string} [o.silenceStderr]  what the silence-detection pass prints (default: no silence at all)
 * @param {(call: object) => boolean} [o.wedge]  true = this call never ends by itself (it ends only when it is killed)
 * @param {(call: object) => void} [o.onCall]  told of each call as it starts, before it answers
 * @returns {{ calls: object[], restore: () => void }}
 */
export function installFfmpeg({ durationS: durationOf = 10, silenceStderr = '', wedge = () => false, onCall = () => {} } = {}) {
  const calls = [];
  cp.spawn = (cmd, ...rest) => {
    if (cmd !== 'ffmpeg') return realSpawn(cmd, ...rest);
    const args = rest[0];
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.stdin = null;
    const inputPath = flag(args, '-i');
    let input = null;
    try { if (inputPath && fs.existsSync(inputPath)) input = fs.readFileSync(inputPath); } catch { /* an input that is gone reads as null */ }
    const last = String(args[args.length - 1]);
    const call = { cmd, args, spawnOptions: rest[1], inputPath, input, last, killed: false, signal: null, startedAt: Date.now() };
    calls.push(call);
    let closed = false;
    const close = (code) => { if (!closed) { closed = true; proc.emit('close', code, call.signal); } };
    proc.kill = (signal = 'SIGTERM') => { call.killed = true; call.signal = signal; setImmediate(() => close(null)); return true; };
    onCall(call);
    if (wedge(call)) return proc;   // it will never answer: only a kill ends it

    let stderr = '';
    const t = flag(args, '-t');
    const durationS = typeof durationOf === 'function' ? durationOf(call) : durationOf;
    if (args.includes('-af')) stderr = silenceStderr;
    else if (last === '-') stderr = `Duration: ${hhmmss(durationS)}, start: 0.000000`;
    else if (last.includes('%06d')) {
      // The keyframe pass: one frame per `fps=1/<interval>` second, as many as the (optionally capped) input has.
      const interval = Number(/fps=1\/(\d+(?:\.\d+)?)/.exec(String(flag(args, '-vf') ?? ''))?.[1] ?? 30);
      let frames = Math.floor((t !== undefined ? Math.min(durationS, Number(t)) : durationS) / interval);
      const cap = flag(args, '-frames:v') ?? flag(args, '-vframes') ?? flag(args, '-frames');
      if (cap !== undefined) frames = Math.min(frames, Number(cap));
      call.framesWritten = frames;
      for (let i = 1; i <= frames; i++) fs.writeFileSync(last.replace('%06d', String(i).padStart(6, '0')), 'jpeg');
    } else {
      // An extracted segment or the audio track: 16 kHz mono 16-bit, so 32 000 bytes a second; the fake writes a stub and
      // records the length it stands for.
      call.standsForS = t !== undefined ? Number(t) : durationS;
      fs.writeFileSync(last, 'wav');
    }
    setImmediate(() => {
      if (stderr) proc.stderr.emit('data', Buffer.from(stderr));
      close(0);
    });
    return proc;
  };
  syncBuiltinESMExports();
  return { calls, restore() { cp.spawn = realSpawn; syncBuiltinESMExports(); } };
}

// ── The door ─────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Open the door. Everything here is the real thing except what the arguments name.
 *
 * @param {object} o
 * @param {string} o.suite  harness database slug (`ythril_harness_<suite>`), unique to the caller
 * @param {boolean} [o.faces]  face recognition ON in config AND the space at the `recognition` rung (the default of a real install)
 * @param {boolean} [o.secret]  a master secret in force, so a stored file is ciphertext
 * @param {string} [o.visionUrl]  the vision endpoint (an Ollama-shaped one for `local`, OpenAI-shaped for `external`)
 * @param {'local'|'external'} [o.visionProvider]
 * @param {string} [o.sttUrl]
 * @param {object} [o.media]  further `mediaEmbedding` config
 */
export async function openMediaJobDoor({ suite, faces = false, secret = false, visionUrl, visionProvider = 'local', sttUrl, media = {}, space = 'media' }) {
  if (secret) process.env['YTHRIL_MASTER_KEY'] = crypto.randomBytes(32).toString('base64');
  else delete process.env['YTHRIL_MASTER_KEY'];
  const door = await openPushDoor({
    suite,
    spaces: [{ id: space, label: space, folders: [], meta: { suppressEmbeddings: true }, imageAnalysis: faces ? 'recognition' : 'caption' }],
  });
  const loader = await import('../../server/dist/config/loader.js');
  const stored = await import('../../server/dist/files/stored-bytes.js');
  const queue = await import('../../server/dist/files/media/job-queue.js');
  const worker = await import('../../server/dist/files/media/worker.js');
  const { spaceRoot } = await import('../../server/dist/files/sandbox.js');
  stored.resetStoredKeyCacheForTests();

  loader.getConfig().mediaEmbedding = {
    levels: { images: faces ? 'recognition' : 'caption' },
    visionProvider,
    ...(visionUrl ? { vision: { baseUrl: visionUrl, model: 'fake', ...(visionProvider === 'external' ? { apiKey: 'sk-b89e5' } : {}) } } : {}),
    ...(sttUrl ? { stt: { baseUrl: sttUrl, model: 'fake' } } : {}),
    workerPollIntervalMs: 100,
    workerMaxPollIntervalMs: 200,
    faceRecognition: { enabled: faces },
    ...media,
  };

  const jobOf = (id) => door.coll(space, 'media_jobs').findOne({ _id: id });

  /**
   * Store a file through the file door, queue its job, run the worker until the job ends, and return the job row.
   * `source` is a Buffer or an iterable of Buffers (a stream: nothing holds the file whole). `sourceFile` streams a file off disk.
   * `whileRunning({ abs, rel })` runs alongside the worker (a test that acts on the stored file mid-job).
   */
  async function runJob({ rel, mime, mediaType, source, sourceFile, until = ['complete', 'failed'], timeoutMs = 120_000, whileRunning }) {
    const abs = path.join(spaceRoot(space), rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    const body = sourceFile ? fs.createReadStream(sourceFile) : (Buffer.isBuffer(source) ? [source] : source);
    const { size } = await stored.pipeToStored(abs, body);
    const now = new Date().toISOString();
    await door.coll(space, 'files').insertOne({ _id: rel, spaceId: space, path: rel, tags: [], createdAt: now, updatedAt: now, sizeBytes: size, seq: 1, mimeType: mime });
    await queue.enqueueMediaJob(space, rel, mime, mediaType);
    worker.startMediaEmbeddingWorker();
    try {
      const running = whileRunning ? whileRunning({ abs, rel }) : Promise.resolve();
      await waitFor(async () => until.includes((await jobOf(rel))?.status), timeoutMs, 100,
        async () => `the worker never ended the job for ${rel}: ${JSON.stringify(await jobOf(rel))}`);
      await running;
    } finally {
      worker.stopMediaEmbeddingWorker();
    }
    return { job: await jobOf(rel), abs, size };
  }

  return {
    door, space, runJob, jobOf, stored, loader,
    dataRoot: process.env['DATA_ROOT'],
    async close() { worker.stopMediaEmbeddingWorker(); await door.close(); },
  };
}
