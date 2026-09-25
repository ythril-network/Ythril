/**
 * Audio embedding pipeline.
 *
 * Strategy:
 *   1. Detect natural chunk boundaries using ffmpeg `silencedetect`.
 *   2. For each chunk, extract the audio segment and call the STT provider.
 *   3. Apply an overlap window (overlapMs, default 5 s) by extending each
 *      chunk to include the tail of the previous and the head of the next.
 *      Boundaries are pushed to the nearest natural pause — never mid-sentence.
 *   4. Embed each chunk's transcript with nomic-embed-text-v1.5.
 *   5. Store one FileMetaDoc chunk record per segment.
 */

import { spawn } from 'child_process';
import { authorRef } from '../../config/author.js';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { col, asDoc, asFilter } from '../../db/mongo.js';
import { embed } from '../../brain/embedding.js';
import type { FileMetaDoc } from '../../config/types.js';
import type { SttProvider, SttSegment } from './providers.js';
import { extForMimeType } from '../mime.js';
import { log } from '../../util/log.js';
import { AUDIO_STEPS, type MediaProgressOpts } from './progress.js';
import { spaceCollection } from '../../db/space-collection.js';


// ── ffmpeg helpers ────────────────────────────────────────────────────────

/**
 * Run ffmpeg with the given args and return { stdout, stderr }.
 * Rejects if ffmpeg exits non-zero.
 */
function ffmpeg(args: string[]): Promise<{ stdout: Buffer; stderr: string }> {
  return new Promise((resolve, reject) => {
    const stdout: Buffer[] = [];
    const stderrChunks: string[] = [];

    const proc = spawn('ffmpeg', ['-y', ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    proc.stdout.on('data', (d: Buffer) => stdout.push(d));
    proc.stderr.on('data', (d: Buffer) => stderrChunks.push(d.toString()));
    proc.on('error', reject);
    proc.on('close', code => {
      const stderr = stderrChunks.join('');
      if (code !== 0) {
        reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-500)}`));
      } else {
        resolve({ stdout: Buffer.concat(stdout), stderr });
      }
    });
  });
}

interface SilenceBoundary {
  start: number;  // seconds
  end: number;    // seconds
}

/**
 * Parse silence_start / silence_end lines from ffmpeg silencedetect stderr.
 * Returns an array of silence intervals in chronological order.
 */
function parseSilenceDetect(stderr: string, totalDurationS: number): SilenceBoundary[] {
  const silences: SilenceBoundary[] = [];
  const startRe = /silence_start:\s*([\d.]+)/g;
  const endRe = /silence_end:\s*([\d.]+)/g;

  const starts: number[] = [];
  const ends: number[] = [];

  let m: RegExpExecArray | null;
  while ((m = startRe.exec(stderr)) !== null) starts.push(parseFloat(m[1]!));
  while ((m = endRe.exec(stderr)) !== null) ends.push(parseFloat(m[1]!));

  // Pair starts with ends; if unbalanced (silence runs to end of file) cap at totalDurationS
  for (let i = 0; i < Math.max(starts.length, ends.length); i++) {
    const s = starts[i] ?? 0;
    const e = ends[i] ?? totalDurationS;
    silences.push({ start: s, end: e });
  }
  return silences;
}

/**
 * Convert silence boundaries into content chunk time windows.
 * Content lies between the *end* of one silence and the *start* of the next.
 */
function silencesToChunks(
  silences: SilenceBoundary[],
  totalDurationS: number,
): Array<{ startS: number; endS: number }> {
  const chunks: Array<{ startS: number; endS: number }> = [];
  let cursor = 0;

  for (const sil of silences) {
    if (sil.start > cursor + 0.5) {
      // There is audible content before this silence
      chunks.push({ startS: cursor, endS: sil.start });
    }
    cursor = sil.end;
  }
  // Content after the last silence (or the whole file if no silences found)
  if (cursor < totalDurationS - 0.5) {
    chunks.push({ startS: cursor, endS: totalDurationS });
  }
  // If nothing was found (no silence), treat whole file as one chunk
  if (chunks.length === 0) {
    chunks.push({ startS: 0, endS: totalDurationS });
  }
  return chunks;
}

/**
 * Apply overlap windows to chunk boundaries.
 * Each chunk is extended backward by `overlapMs / 2` and forward by `overlapMs / 2`,
 * clamped to file duration.  Never crosses a natural silence boundary.
 */
function applyOverlap(
  chunks: Array<{ startS: number; endS: number }>,
  overlapMs: number,
  totalDurationS: number,
): Array<{ startMs: number; endMs: number; overlapMs: number }> {
  const halfS = overlapMs / 2 / 1000;
  return chunks.map(c => ({
    startMs: Math.round(Math.max(0, c.startS - halfS) * 1000),
    endMs: Math.round(Math.min(totalDurationS, c.endS + halfS) * 1000),
    overlapMs,
  }));
}

/** Get duration of an audio/video file in seconds using ffprobe. */
async function getDurationSeconds(filePath: string): Promise<number> {
  const result = await ffmpeg([
    '-i', filePath,
    '-f', 'null', '-',
  ]).catch(err => {
    // ffmpeg exits 1 for probe (no output) but stderr has duration
    return { stdout: Buffer.alloc(0), stderr: String(err) };
  });
  // Parse: "Duration: HH:MM:SS.ss"
  const m = /Duration:\s*(\d+):(\d+):([\d.]+)/.exec(result.stderr);
  if (m) {
    return parseInt(m[1]!, 10) * 3600 + parseInt(m[2]!, 10) * 60 + parseFloat(m[3]!);
  }
  return 0;
}

/**
 * Extract an audio segment [startS, endS] from an audio file.
 * Returns raw PCM wav bytes.
 */
async function extractSegment(
  inputPath: string,
  startS: number,
  endS: number,
  outPath: string,
): Promise<void> {
  const duration = endS - startS;
  await ffmpeg([
    '-ss', String(startS),
    '-t', String(duration),
    '-i', inputPath,
    '-acodec', 'pcm_s16le',
    '-ar', '16000',
    '-ac', '1',
    outPath,
  ]);
}

// ── Main export ───────────────────────────────────────────────────────────

export interface AudioChunkRecord {
  chunkId: string;
  startMs: number;
  endMs: number;
  transcript: string;
}

/**
 * Process an audio file: detect silence boundaries, chunk, transcribe each
 * chunk, embed, and store chunk records.
 *
 * @param overlapMs  Overlap window in milliseconds (default 5000)
 * @returns array of produced chunk records (for logging / video pipeline reuse)
 */
/**
 * What an audio job actually achieved.
 *
 * `failed` exists because it did not before: chunk failures were logged and swallowed, only the
 * successes were returned, and the worker — having no way to tell the difference — recorded the job
 * `complete`. An operator saw success over audio that was never transcribed. The document path already
 * models this correctly with a `partial` status; audio simply never carried the number.
 */
export interface AudioEmbedResult {
  records: AudioChunkRecord[];
  /** Chunks whose transcription failed. Any non-zero value makes the job `partial`, never `complete`. */
  failed: number;
  total: number;
}

export async function embedAudio(
  spaceId: string,
  fileId: string,
  audioBytes: Buffer,
  mimeType: string,
  stt: SttProvider,
  overlapMs = 5000,
  opts?: MediaProgressOpts,
): Promise<AudioEmbedResult> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ythril-audio-'));
  const inputPath = path.join(tmpDir, `input.${mimeTypeToExt(mimeType)}`);

  try {
    await fs.writeFile(inputPath, audioBytes);

    // Step 1: total duration
    const totalDurationS = await getDurationSeconds(inputPath);
    if (totalDurationS <= 0) {
      log.warn(`Audio embedder: could not determine duration for ${fileId}, treating as single chunk`);
    }

    // Step 2: silence detection
    const { stderr } = await ffmpeg([
      '-i', inputPath,
      '-af', 'silencedetect=n=-30dB:d=0.5',
      '-f', 'null', '-',
    ]).catch(({ stderr: s }: { stderr: string }) => ({ stderr: s, stdout: Buffer.alloc(0) }));

    const silences = parseSilenceDetect(stderr, totalDurationS || (audioBytes.length / 32000));
    const rawChunks = silencesToChunks(silences, totalDurationS || (audioBytes.length / 32000));
    const chunks = applyOverlap(rawChunks, overlapMs, totalDurationS || (audioBytes.length / 32000));

    // Step 3: for each chunk, extract audio → transcribe → embed → store
    const results: AudioChunkRecord[] = [];
    let failed = 0;
    let lastError = '';
    const now = new Date().toISOString();

    // One `stt.transcribe` per chunk, and a hop budget bounds ONE of them: an hour of speech is dozens of
    // chunks at 300 s each, all inside a single job step. Without a beat the sweep re-queues the job mid-loop
    // however high that budget is; without the lease check the recovered run and this one transcribe the same
    // audio into the same chunk ids at the same time.
    const beat = (done: number): void =>
      opts?.onProgress?.({ step: 'transcribe', steps: [...(opts.steps ?? AUDIO_STEPS)], done, total: chunks.length });
    beat(0);
    for (let i = 0; i < chunks.length; i++) {
      // Before the call, not after: afterwards this run has already spent a full STT budget producing a chunk
      // the recovering run is about to overwrite.
      if (opts?.shouldStop?.()) {
        log.warn(`Audio embedder: lease lost after ${i}/${chunks.length} chunks for ${fileId} — stopping `
          + 'rather than competing with the run that recovered this job');
        break;
      }
      const { startMs, endMs } = chunks[i]!;
      const startS = startMs / 1000;
      const endS = endMs / 1000;
      const segPath = path.join(tmpDir, `seg${i}.wav`);

      try {
        await extractSegment(inputPath, startS, endS, segPath);
        const segBytes = await fs.readFile(segPath);

        const sttResult = await stt.transcribe(segBytes, 'audio/wav');
        const transcript = buildTranscript(sttResult.segments, sttResult.text);

        if (!transcript.trim()) {
          log.debug(`Audio embedder: chunk ${i} produced empty transcript, skipping`);
          continue;
        }

        // Hard guard: embedding input must be a string
        if (typeof transcript !== 'string') {
          throw new Error('STT returned non-string transcript; refusing to embed');
        }

        const embResult = await embed(transcript);
        const chunkId = `${fileId}#media-chunk${i}`;

        const chunkDoc: FileMetaDoc = {
          _id: chunkId,
          spaceId,
          path: chunkId,
          tags: [],
          createdAt: now,
          updatedAt: now,
          sizeBytes: Buffer.byteLength(transcript, 'utf8'),
          author: authorRef(),
          parentFileId: fileId,
          chunkIndex: i,
          content: transcript,
          matchedText: transcript,
          embedding: embResult.vector,
          embeddingModel: embResult.model,
          chunkOffsetMs: startMs,
          chunkDurationMs: endMs - startMs,
        };

        await col<FileMetaDoc>(spaceCollection(spaceId, 'files')).replaceOne(
          asFilter<FileMetaDoc>({ _id: chunkId }),
          asDoc<FileMetaDoc>(chunkDoc),
          { upsert: true },
        );

        results.push({ chunkId, startMs, endMs, transcript });
      } catch (err) {
        failed++;
        lastError = err instanceof Error ? err.message : String(err);
        log.warn(`Audio embedder: chunk ${i} of ${fileId} failed: ${lastError}`);
        // Continue processing remaining chunks — a partial transcript beats none. The COUNT is what the
        // caller needs, though: without it the worker marked the job `complete` over audio that was
        // never transcribed, which is a silent loss and worse than the error that caused it.
      } finally {
        await fs.unlink(segPath).catch(() => {});
        // In the `finally`, so a chunk the provider refused still counts as one this run got through. A beat
        // that only fired on success would go silent exactly when a provider starts failing — the moment the
        // stall detector most needs to know the worker is alive, and the moment it would instead re-queue a
        // job that is working correctly through a list of failures.
        beat(i + 1);
      }
    }

    // Every chunk failed. That is not a partial result, it is a failed job, and reporting success over an
    // empty transcript hides it forever. Throwing puts it back on the queue's retry/backoff path — which
    // matters most when the cause is systemic (an unreachable provider, a rejected request shape) and
    // will clear once the operator fixes it.
    if (chunks.length > 0 && failed === chunks.length) {
      throw new Error(`every audio chunk failed to transcribe (${chunks.length}/${chunks.length}); last error: ${lastError}`);
    }

    return { records: results, failed, total: chunks.length };
  } finally {
    // Cleanup temp files
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────

/**
 * Build a clean transcript string from STT segments, falling back to the
 * full transcript text if no segments are available.
 *
 * Ensures sentence boundaries are respected (no mid-sentence truncation)
 * by using the segment-level text returned by the STT provider.
 */
function buildTranscript(segments: SttSegment[], fallbackText: string): string {
  if (segments.length === 0) return fallbackText.trim();
  return segments.map(s => s.text.trim()).filter(Boolean).join(' ');
}

/**
 * Name the temp file ffmpeg reads. ffmpeg does probe content, so a wrong name is usually survivable —
 * but it picks the demuxer from the extension first, and `input.bin` (what an untyped job used to
 * produce) gives it nothing to go on.
 */
function mimeTypeToExt(mimeType: string): string {
  return extForMimeType(mimeType, 'bin');
}
