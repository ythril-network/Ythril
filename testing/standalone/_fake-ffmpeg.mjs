/**
 * `ffmpeg` answered at the `child_process.spawn` boundary, so the audio and video embedders run their real chunking, storing and
 * re-embedding code on any machine, with or without the binary.
 *
 * ## What it prevents
 *
 * The audio and video embedders shell out to `ffmpeg` for the duration, the silence map, a wav segment, the audio track and the
 * keyframes. A test of what they STORE needs those calls answered and nothing else faked: everything after them stays real. The
 * first test that needed this wrote the fake inline (`a-suppressed-file-holds-no-conversion-or-media-vector-db.test.js`); this is
 * the second site, so it is a module. Dropping the `syncBuiltinESMExports()` half leaves the dist modules' own
 * `import { spawn } from 'child_process'` binding on the real one, and the audio and video cases then fail for a reason that has
 * nothing to do with their subject (no binary on a laptop, a real one on CI) — which is why the install and the restore are one
 * pair and the install says whether it took.
 *
 * The answers: no silence (one chunk), a ten-second duration, one keyframe at 0 s, and a one-word file for every extracted
 * segment or audio track.
 *
 * ## Every decode pass prints the input's Duration line (Q-984, bundle-41)
 *
 * The real ffmpeg prints `  Duration: HH:MM:SS.ss, …` in the stderr of EVERY run that opens an input, the silencedetect pass included
 * (probe P1, ffmpeg 5.1.9, 2026-11-28). This fake used to print it only for the bare `-f null -` probe, so a code path that reads the
 * duration off the silence pass saw none here and was tested against an ffmpeg that does not exist. `{ duration: false }` prints no
 * Duration line on any pass (an input whose container states no length), only the progress `time=` line.
 *
 * The restore function carries `calls`: every call's arguments, in order, so a test can count the passes a job ran.
 */
import fs from 'node:fs';
import cp from 'node:child_process';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';

/** What the real ffmpeg prints for an input of ten seconds, in the shape probe P1 printed for its eight. */
const DURATION_LINE = '  Duration: 00:00:10.00, start: 0.000000, bitrate: 256 kb/s\n';
/** The progress line a decode prints as it goes. */
const PROGRESS_LINE = 'size=N/A time=00:00:10.00 bitrate=N/A speed= 500x\n';

/** A whole-input decode to the null muxer: the duration probe and the silencedetect pass. */
const isDecodePass = (args) => args.some((a, i) => a === '-f' && args[i + 1] === 'null');

function fakeFfmpeg(args, opts, calls) {
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  calls.push({ args: [...args] });
  const last = String(args[args.length - 1]);
  let stderr = '';
  let code = 0;
  const failure = opts.fail(args);
  if (failure !== null && failure !== undefined) { stderr = String(failure); code = 1; }
  else if (isDecodePass(args)) stderr = opts.duration ? `${DURATION_LINE}${PROGRESS_LINE}` : PROGRESS_LINE; // no silence: one chunk
  else if (last.includes('%06d')) fs.writeFileSync(last.replace('%06d', '000001'), 'jpeg'); // one keyframe, at 0 s
  else fs.writeFileSync(last, 'wav');                                     // an extracted segment or audio track
  setImmediate(() => {
    if (stderr) proc.stderr.emit('data', Buffer.from(stderr));
    proc.emit('close', code);
  });
  return proc;
}

/**
 * Patch `spawn` so a call for `ffmpeg` is answered by the fake and anything else goes to the real one. Returns the function that
 * puts the real `spawn` back, carrying `calls`. THROWS when the patch is not the one the dist modules would see.
 *
 * @param {object} [o]
 * @param {boolean} [o.duration]  every decode pass prints the Duration line (default true, as the real ffmpeg does)
 * @param {(args: string[]) => string|null} [o.fail]  a string makes that call exit 1 with it on stderr
 */
export function installFakeFfmpeg({ duration = true, fail = () => null } = {}) {
  const realSpawn = cp.spawn;
  const calls = [];
  cp.spawn = (cmd, ...rest) => (cmd === 'ffmpeg' ? fakeFfmpeg(rest[0], { duration, fail }, calls) : realSpawn(cmd, ...rest));
  syncBuiltinESMExports();
  if (cp.spawn === realSpawn) throw new Error('_fake-ffmpeg.mjs: spawn was not patched');
  const restore = () => { cp.spawn = realSpawn; syncBuiltinESMExports(); };
  restore.calls = calls;
  return restore;
}
