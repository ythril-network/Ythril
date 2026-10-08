/**
 * The child process a media-job test runs a worker in, so its PEAK MEMORY is its own and so it can be killed (bundle-89, Q-425).
 *
 * ## Why a child
 *
 * - **A peak only rises.** `process.resourceUsage().maxRSS` is the high-water mark of the whole process, so a measurement taken
 *   in the test runner would read every file that ran in it before. A child that does nothing else reads the job.
 * - **A kill leaves what a crash leaves.** An out-of-memory kill, the ticket's own trigger, runs no `finally`, no disposer and no
 *   shutdown hook. A test that wants to know what a decrypted scratch copy does then has to END a process that way.
 * - **Its temp directory is its own.** The parent points `TEMP`/`TMP`/`TMPDIR` at a private directory, so "every file this job
 *   left anywhere" is a directory listing and not a search of the machine.
 *
 * It is not a test (the runner only picks up `*.test.js`). The parent passes the scenario as JSON in `B89_CHILD` and reads the
 * answers off the IPC channel: `ready` (once the door is open, with the data root), then `done`.
 *
 * Scenario `memory`: a small job first (everything the worker loads lazily is loaded and its peak is behind it), then the large
 * one; the answer carries the process's peak before and after each.
 * Scenario `wedge`: one audio job whose first `ffmpeg` call never answers; the child says `wedged` the moment that call starts and
 * then waits to be killed.
 */
import http from 'node:http';
import { openMediaJobDoor, installFfmpeg, streamOfSize } from './_media-job-door.mjs';
import { listenOnLoopback } from '../_shared/local-server.mjs';

const sc = JSON.parse(process.env['B89_CHILD'] ?? '{}');
const peakKb = () => process.resourceUsage().maxRSS;
const send = (m) => new Promise((resolve) => process.send(m, resolve));

/** The file for a scenario: a stream of `size` bytes, or the file a parent wrote (`sourceFile`). */
const bodyOf = (size) => ({ source: streamOfSize(size) });

const sttStub = await listenOnLoopback(http.createServer((req, res) => {
  req.resume();
  req.on('end', () => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ text: 'hello', segments: [] })); });
}));

const door = await openMediaJobDoor({
  suite: sc.suite, faces: !!sc.faces, secret: !!sc.secret, visionUrl: sc.visionUrl, visionProvider: sc.visionProvider ?? 'local', sttUrl: sttStub.url,
});

try {
  if (sc.scenario === 'memory') {
    await send({ type: 'ready', dataRoot: door.dataRoot });
    const run = async (rel, size, sourceFile) => {
      const { job } = await door.runJob({ rel, mime: sc.mime, mediaType: 'image', ...(sourceFile ? { sourceFile } : bodyOf(size)) });
      if (job?.status !== 'complete') throw new Error(`the job for ${rel} ended ${job?.status}: ${job?.lastError}`);
    };
    const before = peakKb();
    await run(`small.${sc.ext}`, sc.smallSize ?? 64 * 1024, sc.smallFile);
    const afterSmall = peakKb();
    await run(`large.${sc.ext}`, sc.size, sc.sourceFile);
    await send({ type: 'done', peakKb: { before, afterSmall, afterLarge: peakKb() } });
  } else if (sc.scenario === 'wedge') {
    installFfmpeg({
      wedge: () => true,
      onCall: () => { void send({ type: 'wedged' }); },
    });
    await send({ type: 'ready', dataRoot: door.dataRoot });
    await door.runJob({ rel: 'call.wav', mime: 'audio/wav', mediaType: 'audio', ...bodyOf(sc.size ?? 256 * 1024), timeoutMs: 600_000 });
    await send({ type: 'done' });
  } else {
    throw new Error(`unknown scenario ${sc.scenario}`);
  }
} catch (err) {
  await send({ type: 'error', message: err instanceof Error ? err.stack : String(err) });
  process.exitCode = 1;
} finally {
  await door.close().catch(() => {});
  await sttStub.close();
  process.exit(process.exitCode ?? 0);
}
