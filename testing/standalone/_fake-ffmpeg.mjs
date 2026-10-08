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
 */
import fs from 'node:fs';
import cp from 'node:child_process';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';

function fakeFfmpeg(args) {
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  const last = String(args[args.length - 1]);
  let stderr = '';
  if (args.includes('-af')) stderr = '';                                  // silencedetect: no silence, one chunk
  else if (last === '-') stderr = 'Duration: 00:00:10.00, start: 0.000000'; // the duration probe
  else if (last.includes('%06d')) fs.writeFileSync(last.replace('%06d', '000001'), 'jpeg'); // one keyframe, at 0 s
  else fs.writeFileSync(last, 'wav');                                     // an extracted segment or audio track
  setImmediate(() => {
    if (stderr) proc.stderr.emit('data', Buffer.from(stderr));
    proc.emit('close', 0);
  });
  return proc;
}

/**
 * Patch `spawn` so a call for `ffmpeg` is answered by the fake and anything else goes to the real one. Returns the function that
 * puts the real `spawn` back. THROWS when the patch is not the one the dist modules would see.
 */
export function installFakeFfmpeg() {
  const realSpawn = cp.spawn;
  cp.spawn = (cmd, ...rest) => (cmd === 'ffmpeg' ? fakeFfmpeg(rest[0]) : realSpawn(cmd, ...rest));
  syncBuiltinESMExports();
  if (cp.spawn === realSpawn) throw new Error('_fake-ffmpeg.mjs: spawn was not patched');
  return () => { cp.spawn = realSpawn; syncBuiltinESMExports(); };
}
