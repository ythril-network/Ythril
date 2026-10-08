/**
 * An audio segment and a video's keyframe pass have a MAXIMUM, in code (bundle-89, Q-425 part 3, plan E5 item 5).
 *
 * ## The defect
 *
 * `silencesToChunks` (`files/media/audio-embedder.ts`) has no maximum chunk length. The "300 s" in the comment above the chunk
 * loop is a comment with no code behind it: audio without a silence of half a second becomes ONE segment, the whole recording,
 * which `embedAudio` then extracts to a wav, reads whole into a `Buffer` and copies again into a multipart body. A two-hour
 * lecture or a continuous recording is the common case, not a corner. `extractKeyframes` (`video-embedder.ts`) asks ffmpeg for
 * one frame per 30 s of the WHOLE video and reads every frame into one array: a 12-hour recording is 1 440 JPEGs in memory
 * and 1 440 vision calls in one job step.
 *
 * ## The rules
 *
 *  1. **No segment handed to the transcriber is longer than `SEGMENT_CAP_S` plus the overlap window**, and the segments still
 *     cover the whole recording (a cap that drops audio is not a cap, it is a loss). Stated over the ffmpeg calls that extract
 *     a segment (`-ss` and `-t` together), whatever the embedder names them, and over a recording with no silence at all.
 *  2. **The keyframe pass is bounded in the number of frames however long the video is**: at most `KEYFRAME_CEILING` frames for a
 *     12-hour video, which uncapped is 1 440. The fake ffmpeg honours `-frames:v`, `-vframes` and `-t` the way ffmpeg does, so
 *     a cap the code adds is SEEN to take effect and a flag that does nothing is not mistaken for one.
 *
 * Both numbers are CHOSEN bounds, not derived ones: `SEGMENT_CAP_S` is the 300 s the code's own comment promised, and
 * `KEYFRAME_CEILING` is a generous ceiling (about 8 hours at one frame per 30 s) that the unchanged code is far over. Neither is a
 * measured limit; the implementation picks its own cap and may pick a much lower one.
 *
 * It is driven through the worker (`_media-job-door.mjs`) and not through `silencesToChunks`, which is private and whose
 * caller's signature is about to change.
 *
 * ## Seen red
 *
 * On the unchanged code a one-hour silence-free recording is ONE segment of 3 600 s (+5 s overlap clamp), and a 12-hour video asks
 * ffmpeg for 1 440 frames.
 *
 * Run: node --test testing/standalone/a-media-segments-and-keyframes-are-capped-db.test.js
 * (requires a prior `npm run build:server` and the test MongoDB)
 */
import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openMediaJobDoor, installFfmpeg } from './_media-job-door.mjs';
import { listenOnLoopback } from '../_shared/local-server.mjs';

const skip = await mongoSkipReason();

/** Chosen, not derived: the 300 s the comment in `embedAudio` has always promised. */
const SEGMENT_CAP_S = 300;
/** The overlap window `embedAudio` adds (5 s, half each side): a capped chunk is extended by it. */
const OVERLAP_S = 5;
/** Chosen, not derived: a ceiling the unchanged code (1 440 frames for the video below) is far over. */
const KEYFRAME_CEILING = 1000;

const HOUR = 3600;
let stt, vision, door, ffmpeg;

before(async () => {
  stt = await listenOnLoopback(http.createServer((req, res) => {
    req.resume();
    req.on('end', () => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ text: 'hello', segments: [] })); });
  }));
  vision = await listenOnLoopback(http.createServer((req, res) => {
    req.resume();
    req.on('end', () => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ message: { content: 'a frame' } })); });
  }));
  door = await openMediaJobDoor({ suite: 'b89e5caps', visionUrl: vision.url, sttUrl: stt.url });
});
after(async () => {
  await door?.close();
  await stt?.close();
  await vision?.close();
});
afterEach(() => { ffmpeg?.restore(); ffmpeg = undefined; });

describe('segments and keyframes are capped in code (real worker, real Mongo, ffmpeg answered at spawn)', { skip }, () => {
  it(`a one-hour recording with no silence is cut into segments of at most ${SEGMENT_CAP_S} s (+${OVERLAP_S} s overlap) that still cover it`, async () => {
    ffmpeg = installFfmpeg({ durationS: HOUR });
    const { job } = await door.runJob({ rel: 'lecture.wav', mime: 'audio/wav', mediaType: 'audio', source: Buffer.from('RIFF-lecture') });
    assert.equal(job?.status, 'complete', `fixture: the audio job did not complete: ${JSON.stringify(job)}`);

    const extractions = ffmpeg.calls.filter(c => c.args.includes('-ss') && c.args.includes('-t') && c.last !== '-');
    assert.ok(extractions.length > 0, 'fixture: no segment was extracted, so there is nothing to bound');
    const lengths = extractions.map(c => Number(c.args[c.args.indexOf('-t') + 1]));
    const longest = Math.max(...lengths);
    assert.ok(longest <= SEGMENT_CAP_S + OVERLAP_S,
      `a segment of ${longest} s was handed to the transcriber (cap ${SEGMENT_CAP_S} s + ${OVERLAP_S} s overlap): the whole recording becomes one wav, read whole and copied again`);
    const covered = lengths.reduce((a, b) => a + b, 0);
    assert.ok(covered >= HOUR, `the segments cover ${covered} s of a ${HOUR} s recording: a cap that drops audio is a loss`);
  });

  it(`a 12-hour video asks for at most ${KEYFRAME_CEILING} keyframes (a chosen ceiling, not a measured limit)`, async () => {
    // The video's own track is long; its extracted audio is short, so this case asks about the keyframe pass and not about segments.
    ffmpeg = installFfmpeg({ durationS: (call) => (call.input?.subarray(0, 10).toString() === 'LONG-VIDEO' ? 12 * HOUR : 10) });
    const { job } = await door.runJob({ rel: 'recording.mp4', mime: 'video/mp4', mediaType: 'video', source: Buffer.from('LONG-VIDEO-bytes'), timeoutMs: 240_000 });
    assert.equal(job?.status, 'complete', `fixture: the video job did not complete: ${JSON.stringify(job)}`);

    const keyframePasses = ffmpeg.calls.filter(c => c.last.includes('%06d'));
    assert.equal(keyframePasses.length, 1, 'fixture: the keyframe pass did not run once (the video level must be full/auto)');
    const frames = keyframePasses[0].framesWritten;
    assert.ok(frames <= KEYFRAME_CEILING,
      `a 12-hour video produced ${frames} keyframes in one pass (ceiling ${KEYFRAME_CEILING}): every one is read into one array and captioned inside one job step`);
  });
});
