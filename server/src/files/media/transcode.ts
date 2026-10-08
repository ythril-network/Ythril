/**
 * The ONE place the server starts the transcoder (`ffmpeg`), bounded in time and killable.
 *
 * ## Why this file is not called `ffmpeg.ts`
 *
 * `ffmpeg-licensing-is-stated` refuses any module import whose path contains "ffmpeg": NOTICE claims the binary is
 * "invoked as a separate process; not linked", and that claim is what keeps its GPL out of Ythril's own licensing. A
 * native binding or a WASM build would arrive as exactly such an import. This module SPAWNS the binary, so the gate is
 * right and the name is what moved.
 *
 * ## What it prevents
 *
 * The audio and the video embedder each had their own wrapper — `spawn` plus a promise that settles on close, line for
 * line the same — and neither had a timeout, a kill, or an abort when the job lost its lease. A corrupt or adversarial
 * file that wedges ffmpeg therefore held a worker slot until stall recovery re-queued the job, and recovery then
 * started a SECOND ffmpeg on the same file while the first was still running. Two such wedges are the whole pool.
 *
 * The bound is Node's own `timeout`, which kills the child with `killSignal` — not a timer racing the promise, which
 * leaves the process running and the slot held. A caller that can lose its claim passes `signal` as well, so a lease
 * lost mid-transcode ends the process rather than the wait.
 *
 * ## What it hardens, and why each
 *
 * `-nostdin`: ffmpeg reads stdin for interactive keys, so a build that inherits a terminal can have it consume input
 * meant for something else and block. `-protocol_whitelist file,pipe`: an input file is a CONTAINER, and a crafted one
 * can name another protocol in a playlist or a segment list — an `http://` reference in a file an operator uploaded is
 * a request this server makes on its behalf. The whitelist is placed before the caller's arguments because it is a
 * demuxer option: after `-i` ffmpeg has already chosen the protocol.
 *
 * `FFMPEG_STEP_TIMEOUT_MS` is fed to the media stall floor (`hopBudgets`), so the detector cannot fire inside a step
 * this bound still allows — the re-queue loop that list exists to prevent, arriving through a new door.
 */
import { spawn } from 'node:child_process';

/**
 * How long ONE ffmpeg step may take: a duration probe, a silence pass, a segment extract, a keyframe pass.
 *
 * A constant rather than a setting, deliberately: it is a ceiling on a step, not a quality control, and a setting
 * would owe its env var and its config-key documentation for a number no operator has a reason to choose. Ten minutes
 * is far above any step the media path takes on a file it accepts (the largest segment is capped, and the keyframe
 * pass is capped) and far below the point at which a wedged process has cost the pool a slot for a working day.
 */
export const FFMPEG_STEP_TIMEOUT_MS = 10 * 60_000;

export interface FfmpegResult { stdout: Buffer; stderr: string }

/**
 * Run `ffmpeg` with `args` and answer its output. Rejects when it exits non-zero, when it is killed by the bound, or
 * when `signal` aborts it.
 *
 * `args` begin with the input: `['-i', path, ...]`. The hardening flags and `-y` go in front of them here, so no caller
 * can forget one.
 */
export function runFfmpeg(args: string[], opts: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<FfmpegResult> {
  return new Promise((resolve, reject) => {
    const stdout: Buffer[] = [];
    const stderrChunks: string[] = [];
    const timeoutMs = opts.timeoutMs ?? FFMPEG_STEP_TIMEOUT_MS;

    const proc = spawn('ffmpeg', ['-nostdin', '-y', '-protocol_whitelist', 'file,pipe', ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      // Node kills the child when this passes, which is the difference between a bound and a timer: a timer that
      // settles the promise leaves the process running and the worker slot held.
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    proc.stdout.on('data', (d: Buffer) => stdout.push(d));
    proc.stderr.on('data', (d: Buffer) => stderrChunks.push(d.toString()));
    proc.on('error', reject);
    proc.on('close', (code, signal) => {
      const stderr = stderrChunks.join('');
      if (signal) {
        // Named as what it is: the two ways a step ends without finishing read very differently to whoever gets the
        // error, and "exited null" reads as neither.
        reject(new Error(`ffmpeg was killed (${signal}) after ${timeoutMs} ms or on abort: ${stderr.slice(-500)}`));
        return;
      }
      if (code !== 0) reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-500)}`));
      else resolve({ stdout: Buffer.concat(stdout), stderr });
    });
  });
}
