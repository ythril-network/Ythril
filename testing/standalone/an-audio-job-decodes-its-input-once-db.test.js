/**
 * An audio job decodes its whole input ONCE: the silencedetect pass answers both the file's length and its silences (Q-984, bundle-41).
 *
 * ## The defect
 *
 * `embedAudio` ran two full decodes of the same input to the null muxer: a "duration probe" (`-i <file> -f null -`) and then the silencedetect
 * pass (`-i <file> -af silencedetect=… -f null -`). The second prints the same `Duration:` line as the first (probe P1, ffmpeg 5.1.9), so the
 * first doubled the CPU an audio job costs before its first segment was cut. And the silencedetect pass's failure was swallowed: its `.catch`
 * read `stderr` off an `Error` that has none, so a pass that decoded nothing left the job chunking the file as one silence-free piece of a
 * guessed length, and it completed.
 *
 * ## What it holds (the real media worker over a real Mongo; ffmpeg answered at spawn, printing what the real one prints)
 *
 *  1. One audio job runs exactly one `-f null` decode pass, it completes, and its segments cover the length that pass printed (700 s).
 *  2. A silencedetect pass that fails fails the job: nothing was decoded, so no chunk can be placed.
 *  3. A pass that prints no Duration figure: the length is the last `time=` the decode printed (700 s), not the file's size over 32 000 bytes a
 *     second, which reads a few bytes as no audio at all.
 *
 * Seen red on 890cf234b: two decode passes; the failed pass leaves the job `complete`; with no Duration line the segments cover ~0 s.
 *
 * Run: node --test testing/standalone/an-audio-job-decodes-its-input-once-db.test.js
 * (requires a prior `npm run build:server` and the test MongoDB)
 */
import { describe, it, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openMediaJobDoor, installFfmpeg } from './_media-job-door.mjs';
import { listenOnLoopback } from '../_shared/local-server.mjs';

const skip = await mongoSkipReason();
const LENGTH_S = 700;

let stt, door, ffmpeg;

before(async () => {
  stt = await listenOnLoopback(http.createServer((req, res) => {
    req.resume();
    req.on('end', () => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ text: 'hello', segments: [] })); });
  }));
  door = await openMediaJobDoor({ suite: 'q984onedecode', sttUrl: stt.url });
});
after(async () => { await door?.close(); await stt?.close(); });
afterEach(() => { ffmpeg?.restore(); ffmpeg = undefined; });

const flagValue = (args, flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
/** The whole-input decodes to the null muxer a job ran. */
const decodePasses = () => ffmpeg.calls.filter(c => c.args.some((a, i) => a === '-f' && c.args[i + 1] === 'null'));
/** How far the extracted segments reach, in seconds. */
const coveredS = () => Math.max(0, ...ffmpeg.calls
  .filter(c => c.args.includes('-ss') && c.args.includes('-t') && c.last !== '-')
  .map(c => Number(flagValue(c.args, '-ss')) + Number(flagValue(c.args, '-t'))));

describe('an audio job decodes its input once (real worker, real Mongo, ffmpeg answered at spawn)', { skip }, () => {
  it('one -f null decode pass per audio job, and the segments cover the length that pass printed', async () => {
    ffmpeg = installFfmpeg({ durationS: LENGTH_S });
    const { job } = await door.runJob({ rel: 'once.wav', mime: 'audio/wav', mediaType: 'audio', source: Buffer.from('RIFF-once') });
    assert.equal(job?.status, 'complete', `fixture: the audio job did not complete: ${JSON.stringify(job)}`);
    const passes = decodePasses();
    assert.equal(passes.length, 1, `the job decoded its whole input ${passes.length} times:\n  ${passes.map(c => `ffmpeg ${c.args.join(' ')}`).join('\n  ')}`);
    assert.ok(passes[0].args.includes('-af'), 'the one decode pass is not the silencedetect pass');
    assert.ok(Math.abs(coveredS() - LENGTH_S) < 0.01, `the segments reach ${coveredS()} s of a ${LENGTH_S} s input`);
  });

  it('a silencedetect pass that fails fails the job: nothing was decoded, so no chunk can be placed', async () => {
    ffmpeg = installFfmpeg({ durationS: LENGTH_S, fail: (c) => (c.args.includes('-af') ? 'Invalid data found when processing input' : null) });
    const { job } = await door.runJob({ rel: 'broken.wav', mime: 'audio/wav', mediaType: 'audio', source: Buffer.from('RIFF-broken') });
    assert.ok(ffmpeg.calls.some(c => c.args.includes('-af') && c.exitCode === 1), 'fixture: the silencedetect pass was never made to fail');
    assert.equal(job?.status, 'failed', `a failed silencedetect pass left the job ${job?.status}: it was chunked as one silence-free piece of a guessed length`);
  });

  it('no Duration figure: the length is the last time= the decode printed, not the size over 32 000 bytes a second', async () => {
    ffmpeg = installFfmpeg({ durationS: LENGTH_S, durationLines: false });
    const { job } = await door.runJob({ rel: 'no-length.ogg', mime: 'audio/ogg', mediaType: 'audio', source: Buffer.from('OggS-no-length') });
    assert.equal(job?.status, 'complete', `fixture: the audio job did not complete: ${JSON.stringify(job)}`);
    assert.ok(Math.abs(coveredS() - LENGTH_S) < 0.01, `the segments reach ${coveredS()} s of a ${LENGTH_S} s input whose decode printed time=${LENGTH_S} s`);
  });
});
