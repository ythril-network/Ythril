/**
 * Video embedding pipeline.
 *
 * Strategy:
 *   1. Extract the audio track via ffmpeg → run AudioEmbedder.
 *   2. Sample keyframes at a configurable interval (default every 30 s).
 *   3. Caption each keyframe via the vision provider.
 *   4. Prepend each frame caption to the transcript chunk it overlaps
 *      temporally, then re-embed the combined text.
 */

import { spawn } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { col, mFilter, mUpdate } from '../../db/mongo.js';
import { embed } from '../../brain/embedding.js';
import type { FileMetaDoc } from '../../config/types.js';
import type { VisionProvider, SttProvider } from './providers.js';
import { embedAudio, type AudioChunkRecord } from './audio-embedder.js';
import { log } from '../../util/log.js';

const DEFAULT_KEYFRAME_INTERVAL_S = 30;

// ── ffmpeg helpers ────────────────────────────────────────────────────────

function ffmpegSpawn(args: string[]): Promise<{ stdout: Buffer; stderr: string }> {
  return new Promise((resolve, reject) => {
    const stdout: Buffer[] = [];
    const stderrChunks: string[] = [];
    const proc = spawn('ffmpeg', ['-y', ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    proc.stdout.on('data', (d: Buffer) => stdout.push(d));
    proc.stderr.on('data', (d: Buffer) => stderrChunks.push(d.toString()));
    proc.on('error', reject);
    proc.on('close', code => {
      const stderr = stderrChunks.join('');
      if (code !== 0) reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-500)}`));
      else resolve({ stdout: Buffer.concat(stdout), stderr });
    });
  });
}

/** Extract audio track to a temporary WAV file. Returns the path. */
async function extractAudioTrack(videoPath: string, outPath: string): Promise<void> {
  await ffmpegSpawn([
    '-i', videoPath,
    '-vn',
    '-acodec', 'pcm_s16le',
    '-ar', '16000',
    '-ac', '1',
    outPath,
  ]);
}

/** Extract keyframe JPEG bytes at regular intervals. Returns array of { timestampS, jpegBytes }. */
async function extractKeyframes(
  videoPath: string,
  tmpDir: string,
  intervalS: number,
): Promise<Array<{ timestampS: number; jpegBytes: Buffer }>> {
  // Output pattern: frame_NNNNNN.jpg
  const pattern = path.join(tmpDir, 'frame_%06d.jpg');
  // fps=1/{intervalS} selects one frame per interval
  // select='eq(pict_type,I)' additionally prefers I-frames (ignored when fps is used)
  await ffmpegSpawn([
    '-i', videoPath,
    '-vf', `fps=1/${intervalS}`,
    '-vsync', 'vfr',
    '-q:v', '4',
    pattern,
  ]).catch(err => {
    log.warn(`Video embedder: keyframe extraction warning: ${err instanceof Error ? err.message : String(err)}`);
    return { stdout: Buffer.alloc(0), stderr: '' };
  });

  const entries = await fs.readdir(tmpDir);
  const frames = entries
    .filter(e => e.startsWith('frame_') && e.endsWith('.jpg'))
    .sort();

  const result: Array<{ timestampS: number; jpegBytes: Buffer }> = [];
  for (let i = 0; i < frames.length; i++) {
    const framePath = path.join(tmpDir, frames[i]!);
    try {
      const jpegBytes = await fs.readFile(framePath);
      const timestampS = i * intervalS;
      result.push({ timestampS, jpegBytes });
    } catch {
      // Frame file missing — skip
    }
  }
  return result;
}

// ── Main export ───────────────────────────────────────────────────────────

/**
 * Process a video file:
 *   1. Extract audio + run AudioEmbedder.
 *   2. Sample keyframes + caption each via vision provider.
 *   3. For each audio chunk, prepend overlapping frame captions and re-embed.
 *
 * @param keyframeIntervalS seconds between keyframe samples (default 30)
 */
export async function embedVideo(
  spaceId: string,
  fileId: string,
  videoBytes: Buffer,
  mimeType: string,
  vision: VisionProvider,
  stt: SttProvider,
  overlapMs = 5000,
  keyframeIntervalS = DEFAULT_KEYFRAME_INTERVAL_S,
): Promise<void> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ythril-video-'));
  const videoExt = mimeTypeToVideoExt(mimeType);
  const videoPath = path.join(tmpDir, `input.${videoExt}`);
  const audioPath = path.join(tmpDir, 'audio.wav');

  try {
    await fs.writeFile(videoPath, videoBytes);

    // Step 1: Extract audio + embed audio chunks
    await extractAudioTrack(videoPath, audioPath);
    const audioBytes = await fs.readFile(audioPath);
    const audioChunks: AudioChunkRecord[] = await embedAudio(
      spaceId,
      fileId,
      audioBytes,
      'audio/wav',
      stt,
      overlapMs,
    );

    if (audioChunks.length === 0) {
      log.warn(`Video embedder: no audio chunks produced for ${fileId}`);
    }

    // Step 2: Extract keyframes
    const keyframesDir = path.join(tmpDir, 'keyframes');
    await fs.mkdir(keyframesDir, { recursive: true });
    const keyframes = await extractKeyframes(videoPath, keyframesDir, keyframeIntervalS);

    if (keyframes.length === 0) {
      log.debug(`Video embedder: no keyframes extracted for ${fileId}`);
      return; // audio-only chunks are sufficient
    }

    // Step 3: Caption keyframes
    const captionedFrames: Array<{ timestampS: number; caption: string }> = [];
    for (const { timestampS, jpegBytes } of keyframes) {
      try {
        const caption = await vision.caption(jpegBytes, 'image/jpeg');
        if (typeof caption === 'string' && caption.trim()) {
          captionedFrames.push({ timestampS, caption: caption.trim() });
        }
      } catch (err) {
        log.warn(`Video embedder: keyframe caption failed at ${timestampS}s for ${fileId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    if (captionedFrames.length === 0) return;

    // Step 4: For each audio chunk, collect overlapping frame captions and re-embed
    const now = new Date().toISOString();
    for (const chunk of audioChunks) {
      const chunkStartS = chunk.startMs / 1000;
      const chunkEndS = chunk.endMs / 1000;

      const overlappingCaptions = captionedFrames
        .filter(f => f.timestampS >= chunkStartS && f.timestampS < chunkEndS)
        .map(f => `[visual at ${Math.round(f.timestampS)}s]: ${f.caption}`);

      if (overlappingCaptions.length === 0) continue;

      const combined = [...overlappingCaptions, chunk.transcript].join('\n');

      // Hard guard: input must be a string
      if (typeof combined !== 'string') continue;

      try {
        const embResult = await embed(combined);
        await col<FileMetaDoc>(`${spaceId}_files`).updateOne(
          mFilter<FileMetaDoc>({ _id: chunk.chunkId }),
          mUpdate<FileMetaDoc>({
            $set: {
              content: combined,
              matchedText: combined,
              embedding: embResult.vector,
              embeddingModel: embResult.model,
              updatedAt: now,
            },
          }),
        );
      } catch (err) {
        log.warn(`Video embedder: re-embed failed for chunk ${chunk.chunkId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────

function mimeTypeToVideoExt(mimeType: string): string {
  const map: Record<string, string> = {
    'video/mp4': 'mp4',
    'video/webm': 'webm',
    'video/x-matroska': 'mkv',
    'video/quicktime': 'mov',
    'video/x-msvideo': 'avi',
    'video/ogg': 'ogv',
  };
  return map[mimeType.split(';')[0]?.trim() ?? ''] ?? 'mp4';
}
