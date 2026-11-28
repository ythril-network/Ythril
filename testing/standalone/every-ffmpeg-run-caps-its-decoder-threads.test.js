/**
 * Every ffmpeg run caps its decoder's and its filter graph's threads at the container's CPU budget, at most 16 (Q-298, bundle-41).
 *
 * ## The defect
 *
 * ffmpeg sizes its decoder and filter thread pools from the HOST's core count. In a container limited to two CPUs on a 32-core host, a media
 * job's ffmpeg started dozens of threads that the quota then throttled, and the instance's other work starved behind them. `-threads N` and
 * `-filter_threads N` before `-i` cap both pools for that run (probe 2026-11-28, ffmpeg 5.1.9: the silencedetect pass, a segment extract and a
 * keyframe extract print the same Duration and silence lines with and without them).
 *
 * ## What it holds
 *
 *  1. `ffmpegArgs(args, cpus)` (`server/src/files/media/transcode.ts`), the one builder of what is spawned: for 1, 8 and 32 CPUs the value is
 *     1, 8 and 16 (above 16 an explicit count raises ffmpeg's memory over its own default cap); `-threads` and `-filter_threads` each appear
 *     ONCE, both before the first `-i`, after the hardening flags (`-nostdin`, `-protocol_whitelist`); the caller's arguments follow unchanged.
 *     The CPU count is a parameter, so the test never compares the code's answer with the code's own reading of the budget.
 *  2. `runFfmpeg` spawns exactly what `ffmpegArgs` builds for the count it read, a count in 1..16: no caller can leave the cap out.
 *
 * Seen red on 890cf234b: `ffmpegArgs` does not exist, and the spawned arguments carry no `-threads`.
 *
 * Run: node --test testing/standalone/every-ffmpeg-run-caps-its-decoder-threads.test.js   (requires a prior `npm run build:server`)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { installFakeFfmpeg } from './_fake-ffmpeg.mjs';

const transcode = await import('../../server/dist/files/media/transcode.js');
const CALLER = ['-i', 'input.wav', '-af', 'silencedetect=n=-30dB:d=0.5', '-f', 'null', '-'];

/** The value after `flag` in `args`, and how many times `flag` appears. */
const valueAndCount = (args, flag) => ({ value: args[args.indexOf(flag) + 1], count: args.filter(a => a === flag).length });

describe('every ffmpeg run caps its decoder and filter threads', () => {
  it('ffmpegArgs is exported by transcode.ts', () => {
    assert.equal(typeof transcode.ffmpegArgs, 'function', 'transcode.ts exports no ffmpegArgs(args, cpus): nothing builds the thread cap');
  });

  for (const [cpus, threads] of [[1, '1'], [8, '8'], [32, '16']]) {
    it(`${cpus} CPU(s): -threads ${threads} and -filter_threads ${threads}, once each, after the hardening flags and before the first -i`, () => {
      assert.equal(typeof transcode.ffmpegArgs, 'function', 'transcode.ts exports no ffmpegArgs(args, cpus)');
      const args = transcode.ffmpegArgs([...CALLER], cpus);
      const firstInput = args.indexOf('-i');
      assert.ok(firstInput >= 0, `no -i in ${JSON.stringify(args)}`);
      for (const flag of ['-threads', '-filter_threads']) {
        const { value, count } = valueAndCount(args, flag);
        assert.equal(count, 1, `${flag} appears ${count} time(s) in ${JSON.stringify(args)}`);
        assert.equal(value, threads, `${flag} is ${value} for ${cpus} CPU(s), expected min(cpus, 16) = ${threads}`);
        assert.ok(args.indexOf(flag) < firstInput, `${flag} comes after the first -i: ffmpeg would read it as an output option`);
        for (const hardening of ['-nostdin', '-protocol_whitelist']) {
          assert.ok(args.indexOf(hardening) >= 0 && args.indexOf(hardening) < args.indexOf(flag), `${flag} is not after ${hardening} in ${JSON.stringify(args)}`);
        }
      }
      assert.deepEqual(args.slice(firstInput), CALLER, 'the caller\'s arguments were changed');
    });
  }

  it('runFfmpeg spawns exactly what ffmpegArgs builds, with a thread count in 1..16', async () => {
    const restore = installFakeFfmpeg();
    try {
      await transcode.runFfmpeg([...CALLER]);
    } finally { restore(); }
    assert.equal(restore.calls.length, 1, `fixture: ${restore.calls.length} ffmpeg call(s)`);
    const spawned = restore.calls[0].args;
    const { value } = valueAndCount(spawned, '-threads');
    const n = Number(value);
    assert.ok(Number.isInteger(n) && n >= 1 && n <= 16, `runFfmpeg spawned -threads ${JSON.stringify(value)}: ${JSON.stringify(spawned)}`);
    assert.equal(typeof transcode.ffmpegArgs, 'function', 'transcode.ts exports no ffmpegArgs(args, cpus)');
    assert.deepEqual(spawned, transcode.ffmpegArgs([...CALLER], n), 'runFfmpeg spawned a list ffmpegArgs does not build');
  });
});
