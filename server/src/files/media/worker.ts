/**
 * MediaEmbeddingWorker
 *
 * Starts an async background loop that continuously polls for pending media
 * embedding jobs across all non-proxy spaces.
 *
 * Design principles:
 * - Worker starts unconditionally at process start (never gated on `enabled`)
 * - Enqueueing is skipped at write_file time when `enabled: false`
 * - Exponential idle backoff: double poll interval on empty queue, cap at max
 * - Concurrency: up to `workerConcurrency` jobs processed in parallel per tick
 * - Stalled job recovery: reset "processing" jobs older than `stalledJobTimeoutMs`
 *
 * Behaviour when `mediaEmbedding.enabled` flips from `true` → `false`:
 *   The worker still drains any jobs that were enqueued while it was enabled.
 *   This is intentional — those uploads already incurred CPU/disk and the
 *   user expects the corresponding chunks to appear in recall results. To
 *   stop processing in flight, set `enabled: false` AND set
 *   `workerConcurrency: 0` (or restart the pod, which leaves any pending
 *   jobs in the queue for a future enable).
 *
 * Provider config is read ONCE at worker start (config hot-reload requires a
 * pod restart). This avoids fetching env vars on every tick.
 */

import { getConfig, getMediaEmbeddingConfig } from '../../config/loader.js';
import { isProxySpace } from '../../spaces/proxy.js';
import type { MediaJobDoc } from '../../config/types.js';
import { log } from '../../util/log.js';
import { createMediaProviders } from './providers.js';
import { claimNextJob, completeJob, failJob, resetStalledJobs } from './job-queue.js';
import { embedImage } from './image-embedder.js';
import { embedAudio } from './audio-embedder.js';
import { embedVideo } from './video-embedder.js';
import { col, mFilter } from '../../db/mongo.js';
import type { FileMetaDoc } from '../../config/types.js';
import { updateFileMeta } from '../file-meta.js';
import {
  runConversionPipeline,
  storeConversionResults,
  deleteConversionArtifacts,
} from '../converters/pipeline.js';
import type { ResolvedFormat } from '../converters/pipeline.js';
import fs from 'fs/promises';
import path from 'path';
import { spaceRoot } from '../sandbox.js';
import {
  mediaJobsCompletedTotal,
  mediaJobsFailedTotal,
  mediaJobsRetriedTotal,
  mediaJobDurationSeconds,
} from '../../metrics/registry.js';

let running = false;
let stalledSweepTimer: NodeJS.Timeout | null = null;

/** Start the media embedding worker loop. Idempotent — safe to call multiple times. */
export function startMediaEmbeddingWorker(): void {
  if (running) return;
  running = true;
  log.info('Media embedding worker: started');
  void workerLoop();
}

/** Stop the worker loop gracefully (completes the in-flight batch). */
export function stopMediaEmbeddingWorker(): void {
  running = false;
  if (stalledSweepTimer) {
    clearInterval(stalledSweepTimer);
    stalledSweepTimer = null;
  }
  log.info('Media embedding worker: stop requested');
}

// ── Internal ──────────────────────────────────────────────────────────────

async function workerLoop(): Promise<void> {
  const mediaCfg = getMediaEmbeddingConfig();
  const stalledJobTimeoutMs = mediaCfg.stalledJobTimeoutMs ?? 300_000;
  const workerConcurrency = mediaCfg.workerConcurrency ?? 2;
  const workerPollIntervalMs = mediaCfg.workerPollIntervalMs ?? 1_000;
  const workerMaxPollIntervalMs = mediaCfg.workerMaxPollIntervalMs ?? 30_000;
  const visionProviderType: 'local' | 'external' = mediaCfg.visionProvider ?? 'local';
  const sttProviderType: 'local' | 'external' = mediaCfg.sttProvider ?? 'local';
  const fallbackToExternal = mediaCfg.fallbackToExternal ?? false;

  let currentPollMs = workerPollIntervalMs;

  // On startup: reset any stalled jobs (crash recovery)
  const spaceIds = getLocalSpaceIds();
  if (spaceIds.length > 0) {
    await resetStalledJobs(spaceIds, stalledJobTimeoutMs).catch(err =>
      log.warn(`Media worker: stalled job reset error: ${err instanceof Error ? err.message : String(err)}`),
    );
  }

  // Schedule periodic stalled-job sweep so a pod crash mid-job is recovered
  // even when the worker loop is otherwise idle (no new uploads). Interval is
  // half the stall timeout so a job is recovered within ~1.5× the timeout.
  const sweepIntervalMs = Math.max(30_000, Math.floor(stalledJobTimeoutMs / 2));
  stalledSweepTimer = setInterval(() => {
    if (!running) return;
    const ids = getLocalSpaceIds();
    if (ids.length === 0) return;
    void resetStalledJobs(ids, stalledJobTimeoutMs).catch(err =>
      log.warn(`Media worker: periodic stalled reset error: ${err instanceof Error ? err.message : String(err)}`),
    );
  }, sweepIntervalMs);
  // Don't keep the event loop alive solely for the sweep timer
  if (typeof stalledSweepTimer.unref === 'function') stalledSweepTimer.unref();

  const providers = createMediaProviders(
    mediaCfg.vision ?? {},
    mediaCfg.stt ?? {},
    visionProviderType,
    sttProviderType,
    fallbackToExternal,
  );

  while (running) {
    // Re-read space list on each tick (handles dynamic space creation/removal)
    const activeSpaceIds = getLocalSpaceIds();

    if (activeSpaceIds.length === 0) {
      await sleep(currentPollMs);
      continue;
    }

    // Claim up to `workerConcurrency` jobs
    const claimed: MediaJobDoc[] = [];
    for (let i = 0; i < workerConcurrency; i++) {
      const job = await claimNextJob(activeSpaceIds).catch(err => {
        log.warn(`Media worker: claim error: ${err instanceof Error ? err.message : String(err)}`);
        return null;
      });
      if (!job) break;
      claimed.push(job);
    }

    if (claimed.length === 0) {
      // Exponential backoff on empty queue
      currentPollMs = Math.min(currentPollMs * 2, workerMaxPollIntervalMs);
      await sleep(currentPollMs);
      continue;
    }

    // Reset backoff — we have work
    currentPollMs = workerPollIntervalMs;

    // Process jobs concurrently
    await Promise.allSettled(claimed.map(job => processJob(job, providers)));

    // Brief pause to prevent tight loop when constantly finding work
    await sleep(currentPollMs);
  }
}

async function processJob(
  job: MediaJobDoc,
  providers: { vision: import('./providers.js').VisionProvider; stt: import('./providers.js').SttProvider },
): Promise<void> {
  const { spaceId, filePath, mediaType, mimeType, _id: fileId, attempts, maxAttempts } = job;
  const endTimer = mediaJobDurationSeconds.startTimer({ media_type: mediaType });

  try {
    // Load file bytes from disk
    const absolutePath = resolveFilePath(spaceId, filePath);
    let fileBytes: Buffer;
    try {
      fileBytes = await fs.readFile(absolutePath);
    } catch (err) {
      throw new Error(`Could not read file for embedding: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Mark file as "processing" in file meta
    const now = new Date().toISOString();
    await col<FileMetaDoc>(`${spaceId}_files`).updateOne(
      mFilter<FileMetaDoc>({ _id: fileId }),
      { $set: { embeddingStatus: 'processing', updatedAt: now } },
    ).catch(() => {}); // non-fatal — job tracking is the source of truth

    // Run the appropriate embedder
    let derivedDescription: string | undefined;
    switch (mediaType) {
      case 'image':
        derivedDescription = await embedImage(spaceId, fileId, fileBytes, mimeType, providers.vision);
        break;
      case 'audio':
        await embedAudio(spaceId, fileId, fileBytes, mimeType, providers.stt);
        break;
      case 'video':
        await embedVideo(spaceId, fileId, fileBytes, mimeType, providers.vision, providers.stt);
        break;
      case 'text': {
        // Text/document embedding: chunk + embed the file content asynchronously.
        // Delete any stale chunks first so a re-upload always produces a clean set.
        await deleteConversionArtifacts(spaceId, fileId);
        const resolvedFmt = (job.resolvedFormat ?? 'text') as ResolvedFormat;
        const { chunks, convertedMarkdown, extractedImages } = await runConversionPipeline(
          fileBytes, filePath, resolvedFmt,
        );
        if (chunks.length > 0 || extractedImages.length > 0) {
          const { chunkCount, convertedFileId } = await storeConversionResults(
            spaceId, filePath, chunks, convertedMarkdown, extractedImages,
          );
          const metaUpdate: Record<string, unknown> = { chunkCount };
          if (convertedFileId) metaUpdate['convertedFileId'] = convertedFileId;
          await col<FileMetaDoc>(`${spaceId}_files`).updateOne(
            mFilter<FileMetaDoc>({ _id: fileId }),
            { $set: metaUpdate },
          ).catch(() => {});
        }
        break;
      }
      default:
        throw new Error(`Unknown mediaType: ${String(mediaType)}`);
    }

    // Write AI-generated caption to parent file meta description if not already set by user.
    // This also re-embeds the parent file meta so the caption is searchable on the file itself.
    if (derivedDescription) {
      const parentMeta = await col<FileMetaDoc>(`${spaceId}_files`).findOne(
        mFilter<FileMetaDoc>({ _id: fileId }),
        { projection: { description: 1 } },
      );
      if (!parentMeta?.description?.trim()) {
        await updateFileMeta(spaceId, filePath, { description: derivedDescription }).catch(err =>
          log.warn(`Media worker: failed to write caption to file meta ${spaceId}/${fileId}: ${err instanceof Error ? err.message : String(err)}`),
        );
      }
    }

    await completeJob(spaceId, fileId);
    mediaJobsCompletedTotal.labels({ space: spaceId, media_type: mediaType }).inc();
    log.info(`Media worker: completed ${mediaType} job ${spaceId}/${fileId}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn(`Media worker: job ${spaceId}/${fileId} failed: ${message}`);
    if (attempts >= maxAttempts) {
      mediaJobsFailedTotal.labels({ space: spaceId, media_type: mediaType }).inc();
    } else {
      mediaJobsRetriedTotal.labels({ space: spaceId, media_type: mediaType }).inc();
    }
    await failJob(spaceId, fileId, attempts, maxAttempts, message).catch(innerErr =>
      log.warn(`Media worker: failJob error: ${innerErr instanceof Error ? innerErr.message : String(innerErr)}`),
    );
  } finally {
    endTimer();
  }
}

/** Return all local (non-proxy) space IDs. */
function getLocalSpaceIds(): string[] {
  try {
    const cfg = getConfig();
    return (cfg.spaces ?? [])
      .map(s => s.id)
      .filter(id => !isProxySpace(id));
  } catch {
    return [];
  }
}

/** Resolve the absolute file path on disk for a given space + relative path. */
function resolveFilePath(spaceId: string, filePath: string): string {
  const base = spaceRoot(spaceId);
  // Prevent path traversal: only forward-slash paths, no `..` segments
  const safe = filePath.replace(/\\/g, '/').replace(/\.\.\//g, '').replace(/^\/+/, '');
  return path.join(base, safe);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
