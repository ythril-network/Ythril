/**
 * Every `ffmpeg` a media job starts is hardened, and every one of them reads the SAME bytes (bundle-89, Q-425 part 4, plan E5
 * items 3-4).
 *
 * ## The two rules
 *
 * **1. A hardened command line.** Every `ffmpeg` call carries `-nostdin` and `-protocol_whitelist file,pipe`, and reads an input
 * whose name cannot be taken for an option or a protocol. ffmpeg opens whatever protocol its input NAMES (`http:`, `concat:`,
 * `subfile:`) and probes inside the file for playlists that name more; a job that hands it a user's file must not let that file
 * make it read another one or open a socket. The merged wrapper the plan builds carries these; today's two wrappers carry
 * neither. (That the wrapper also has a timeout and a kill is held by `every-ffmpeg-spawn-is-bounded-and-killed.test.js`.)
 *
 * **2. A snapshot, not the live path.** ffmpeg re-opens its input BY PATH for the duration probe, the silence pass, every segment
 * extract and the keyframe pass. For an unencrypted file the plan returns the stored path itself instead of copying the bytes to
 * a private file (a saving of one whole copy), and a concurrent `encryptInPlace`, a re-upload or a move renames ANOTHER file over
 * that path while the job runs: the later segments then read different bytes under the silence map of the first. A hard link on
 * the same filesystem gives the snapshot at no memory cost. **Asserted: a rename over the stored path in the middle of the job
 * does not change what any later ffmpeg call reads.**
 *
 * ## Seen red
 *
 * Rule 1 is red on the unchanged code (neither flag is passed). **Rule 2 is a GUARD row: it holds on the unchanged code**, which
 * copies the bytes to a private file first, and it is what the planned saving must not break. It was seen red against a
 * deliberately wrong build that hands ffmpeg the live stored path (see the return of the assignment that wrote it).
 *
 * Run: node --test testing/standalone/a-media-job-ffmpeg-calls-are-hardened-and-read-a-snapshot-db.test.js
 * (requires a prior `npm run build:server` and the test MongoDB)
 */
import { describe, it, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openMediaJobDoor, installFfmpeg } from './_media-job-door.mjs';
import { listenOnLoopback } from '../_shared/local-server.mjs';

const skip = await mongoSkipReason();

let stt, vision, door, ffmpeg;

before(async () => {
  const answer = (body) => http.createServer((req, res) => {
    req.resume();
    req.on('end', () => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); });
  });
  stt = await listenOnLoopback(answer({ text: 'hello', segments: [] }));
  vision = await listenOnLoopback(answer({ message: { content: 'a frame' } }));
  door = await openMediaJobDoor({ suite: 'b89e5snap', visionUrl: vision.url, sttUrl: stt.url });
});
after(async () => { await door?.close(); await stt?.close(); await vision?.close(); });
afterEach(() => { ffmpeg?.restore(); ffmpeg = undefined; });

const valueOf = (args, flag) => args[args.indexOf(flag) + 1];

describe('a media job\'s ffmpeg calls (real worker, real Mongo, ffmpeg answered at spawn)', { skip }, () => {
  it('every call, for an audio file and for a video, carries -nostdin and -protocol_whitelist file,pipe and an input name that cannot be read as an option or a protocol', async () => {
    ffmpeg = installFfmpeg({ durationS: 700 });
    const a = await door.runJob({ rel: 'hardened.wav', mime: 'audio/wav', mediaType: 'audio', source: Buffer.from('RIFF-hardened') });
    const v = await door.runJob({ rel: 'hardened.mp4', mime: 'video/mp4', mediaType: 'video', source: Buffer.from('mp4-hardened') });
    assert.equal(a.job?.status, 'complete', `fixture: the audio job did not complete: ${JSON.stringify(a.job)}`);
    assert.equal(v.job?.status, 'complete', `fixture: the video job did not complete: ${JSON.stringify(v.job)}`);
    assert.ok(ffmpeg.calls.length >= 6, `fixture: only ${ffmpeg.calls.length} ffmpeg call(s) were made, so the rule was asked of too few`);

    const bad = [];
    for (const c of ffmpeg.calls) {
      const why = [];
      if (!c.args.includes('-nostdin')) why.push('no -nostdin');
      const wl = c.args.includes('-protocol_whitelist') ? valueOf(c.args, '-protocol_whitelist') : undefined;
      if (wl === undefined || [...new Set(wl.split(','))].sort().join(',') !== 'file,pipe') why.push(`-protocol_whitelist is ${JSON.stringify(wl)}`);
      const name = c.inputPath ? path.basename(c.inputPath) : '';
      if (!/^[A-Za-z0-9._][A-Za-z0-9._-]*$/.test(name)) why.push(`input name ${JSON.stringify(name)}`);
      if (why.length) bad.push(`ffmpeg ${c.args.join(' ')} :: ${why.join(', ')}`);
    }
    assert.deepEqual(bad, [], 'ffmpeg calls that are not hardened');
  });

  it('GUARD: a rename over the stored path in the middle of the job does not change what any later ffmpeg call reads', async () => {
    const original = Buffer.from('RIFF-the-bytes-the-job-was-queued-for');
    const other = Buffer.from('RIFF-ANOTHER-FILE-RENAMED-OVER-THE-PATH');
    let swapped = false;
    let stored;
    ffmpeg = installFfmpeg({
      durationS: 700,   // the silence pass and at least one segment extract come AFTER the first call
      onCall: () => {
        // The first call (the duration probe) has read its input; everything after this one reads whatever is at the path now.
        if (swapped || !stored) return;
        swapped = true;
        const intruder = `${stored}.intruder`;
        fs.writeFileSync(intruder, other);
        fs.renameSync(intruder, stored);
      },
    });
    const { job } = await door.runJob({
      rel: 'snapshot.wav', mime: 'audio/wav', mediaType: 'audio', source: original,
      whileRunning: ({ abs }) => { stored = abs; return Promise.resolve(); },
    });
    assert.equal(job?.status, 'complete', `fixture: the job did not complete: ${JSON.stringify(job)}`);
    assert.ok(swapped, 'fixture: the rename never happened');
    assert.deepEqual(fs.readFileSync(stored), other, 'fixture: the rename did not replace the stored file');
    assert.ok(ffmpeg.calls.length >= 3, `fixture: ${ffmpeg.calls.length} ffmpeg call(s): none came after the swap`);

    const reads = ffmpeg.calls.map(c => (c.input ? c.input.toString() : null));
    assert.deepEqual(reads.filter(r => r !== original.toString()).map(r => r?.slice(0, 20) ?? null), [],
      `ffmpeg calls read bytes other than the file the job was queued for, after a rename over its path: ${JSON.stringify(reads.map(r => r?.slice(0, 20)))}`);
  });
});
