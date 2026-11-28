/**
 * An audio file's length is read from the stderr of the one decode pass that also maps its silences (Q-984, bundle-41):
 * `durationFromFfmpegLog(stderr)` (`server/src/files/media/audio-embedder.ts`).
 *
 * ## The order it reads
 *
 *  1. the input's `Duration: HH:MM:SS.ss` line, which ffmpeg prints for every run that opens the input (probe P1, ffmpeg 5.1.9);
 *  2. else the LAST `time=HH:MM:SS.ss` progress line, which is how far the decode got: an input whose container states no length
 *     (`Duration: N/A`) has still been decoded to its end by the silencedetect pass. The old fallback, the file's size over 32 000 bytes a
 *     second, is right only for 16 kHz mono 16-bit PCM and under-reads compressed audio, which dropped its tail from the last chunk;
 *  3. else `null`, and the caller falls back to the size.
 *
 * The stderr cases are copies of what ffmpeg prints (probe P1's Duration line; progress lines in ffmpeg's own format).
 *
 * Seen red on 890cf234b: `durationFromFfmpegLog` does not exist.
 *
 * Run: node --test testing/standalone/an-audio-files-length-is-read-from-its-one-decode.test.js   (requires a prior `npm run build:server`)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const audio = await import('../../server/dist/files/media/audio-embedder.js');

const PROBE_P1 = [
  "Input #0, wav, from 'speech.wav':",
  '  Duration: 00:00:08.00, bitrate: 256 kb/s',
  '  Stream #0:0: Audio: pcm_s16le ([1][0][0][0] / 0x0001), 16000 Hz, 1 channels, s16, 256 kb/s',
  '[silencedetect @ 0x55d1] silence_start: 2.5',
  '[silencedetect @ 0x55d1] silence_end: 3.1 | silence_duration: 0.6',
  'size=N/A time=00:00:08.00 bitrate=N/A speed= 812x',
].join('\n');
const NO_DURATION = [
  "Input #0, ogg, from 'stream.ogg':",
  '  Duration: N/A, start: 0.000000, bitrate: N/A',
  'size=N/A time=00:00:03.20 bitrate=N/A speed= 300x',
  'size=N/A time=00:00:07.50 bitrate=N/A speed= 310x',
].join('\r\n');
const NEITHER = "Input #0, wav, from 'broken.wav':\n[wav @ 0x5601] invalid start code in RIFF header\n";

const parse = (stderr) => {
  assert.equal(typeof audio.durationFromFfmpegLog, 'function', 'audio-embedder.ts exports no durationFromFfmpegLog(stderr): the length is still asked of a second decode');
  return audio.durationFromFfmpegLog(stderr);
};

describe('durationFromFfmpegLog reads the length off the one decode pass', () => {
  it('a Duration line answers its seconds (probe P1: 8 s), not the progress line beside it', () => {
    assert.equal(parse(PROBE_P1), 8);
  });

  it('an hour-long Duration line is read whole: hours and minutes count', () => {
    assert.equal(parse('  Duration: 01:02:03.50, start: 0.000000, bitrate: 128 kb/s\nsize=N/A time=00:00:01.00 bitrate=N/A'), 3723.5);
  });

  it('no Duration figure (Duration: N/A): the LAST time= the decode printed, 7.5 s, not the first', () => {
    assert.equal(parse(NO_DURATION), 7.5);
  });

  it('neither a Duration nor a time= line: null, so the caller falls back to the size', () => {
    assert.equal(parse(NEITHER), null);
    assert.equal(parse(''), null);
  });
});
