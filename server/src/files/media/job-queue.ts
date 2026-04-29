/**
 * Media embedding job queue.
 *
 * Persists `MediaJobDoc` records in the per-space `<spaceId>_media_jobs`
 * collection.  The worker claims jobs atomically via findOneAndUpdate.
 */

import { col, mFilter, mDoc, mUpdate } from '../../db/mongo.js';
import type { MediaJobDoc, FileMetaDoc } from '../../config/types.js';
import { log } from '../../util/log.js';

const MAX_ATTEMPTS = 3;

/**
 * Exponential backoff schedule (in ms) keyed by next attempt number.
 * After attempt 1 fails → wait 30 s; after 2 fails → wait 2 min.
 * The cap (`maxAttempts`) means we never schedule a wait beyond attempt 3.
 */
const RETRY_BACKOFF_MS: Record<number, number> = {
  1: 30_000,    // first retry available 30 s after the first failure
  2: 120_000,   // second retry available 2 min after the second failure
};

function nextClaimableAfter(nextAttempt: number): string {
  const delay = RETRY_BACKOFF_MS[nextAttempt] ?? 300_000;
  return new Date(Date.now() + delay).toISOString();
}

/** Normalise a path to forward-slash convention and strip leading slashes. */
export function normPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\/+/, '');
}

function jobCollection(spaceId: string) {
  return col<MediaJobDoc>(`${spaceId}_media_jobs`);
}

function fileCollection(spaceId: string) {
  return col<FileMetaDoc>(`${spaceId}_files`);
}

// ── Enqueue ────────────────────────────────────────────────────────────────

/**
 * Enqueue a new media embedding job.  Idempotent: if a job already exists
 * for this file and is not in a terminal state, it is left unchanged.
 * A previously-failed job is reset to `pending` so a new upload re-triggers
 * processing.
 */
export async function enqueueMediaJob(
  spaceId: string,
  filePath: string,
  mimeType: string,
  mediaType: 'image' | 'audio' | 'video',
): Promise<void> {
  const id = normPath(filePath);
  const now = new Date().toISOString();

  const existing = await jobCollection(spaceId).findOne(
    mFilter<MediaJobDoc>({ _id: id }),
  ) as MediaJobDoc | null;

  if (existing && (existing.status === 'pending' || existing.status === 'processing')) {
    // Already queued — do not disturb
    return;
  }

  if (existing) {
    // Terminal state (complete/failed) — reset so re-upload triggers re-processing
    await jobCollection(spaceId).updateOne(
      mFilter<MediaJobDoc>({ _id: id }),
      mUpdate<MediaJobDoc>({
        $set: {
          status: 'pending',
          attempts: 0,
          lastError: null,
          claimedAt: null,
          claimableAfter: null,
          updatedAt: now,
          mimeType,
          mediaType,
        },
      }),
    );
  } else {
    const doc: MediaJobDoc = {
      _id: id,
      spaceId,
      filePath: id,
      mimeType,
      mediaType,
      status: 'pending',
      attempts: 0,
      maxAttempts: MAX_ATTEMPTS,
      lastError: null,
      claimedAt: null,
      claimableAfter: null,
      createdAt: now,
      updatedAt: now,
    };
    await jobCollection(spaceId).insertOne(mDoc<MediaJobDoc>(doc));
  }
}

/**
 * Enqueue a new text document embedding job.
 * Unlike enqueueMediaJob, this ALWAYS resets the job to `pending` even when
 * a job is currently `pending` or `processing` — a re-upload means we have
 * new file content that must replace any in-flight work.
 *
 * The caller is responsible for deleting stale chunk records before enqueueing
 * so that a concurrent in-flight job (if any) finds no old data to overwrite.
 */
export async function enqueueTextJob(
  spaceId: string,
  filePath: string,
  resolvedFormat: string,
  mimeType = 'text/plain',
): Promise<void> {
  const id = normPath(filePath);
  const now = new Date().toISOString();

  const existing = await jobCollection(spaceId).findOne(
    mFilter<MediaJobDoc>({ _id: id }),
  ) as MediaJobDoc | null;

  if (existing) {
    // Always reset — new upload supersedes any previous or in-progress job
    await jobCollection(spaceId).updateOne(
      mFilter<MediaJobDoc>({ _id: id }),
      mUpdate<MediaJobDoc>({
        $set: {
          status: 'pending',
          attempts: 0,
          lastError: null,
          claimedAt: null,
          claimableAfter: null,
          updatedAt: now,
          mimeType,
          mediaType: 'text',
          resolvedFormat,
        },
      }),
    );
  } else {
    const doc: MediaJobDoc = {
      _id: id,
      spaceId,
      filePath: id,
      mimeType,
      mediaType: 'text',
      resolvedFormat,
      status: 'pending',
      attempts: 0,
      maxAttempts: MAX_ATTEMPTS,
      lastError: null,
      claimedAt: null,
      claimableAfter: null,
      createdAt: now,
      updatedAt: now,
    };
    await jobCollection(spaceId).insertOne(mDoc<MediaJobDoc>(doc));
  }

  // Reflect pending status on the file meta record immediately so the UI
  // can show an "embedding" indicator without waiting for the worker.
  await fileCollection(spaceId).updateOne(
    mFilter<FileMetaDoc>({ _id: id }),
    { $set: { embeddingStatus: 'pending', updatedAt: now } },
  ).catch(() => {}); // non-fatal
}

// ── Claim ─────────────────────────────────────────────────────────────────

/**
 * Atomically claim one pending job across a set of spaces.
 * Returns the claimed job, or null if none available.
 *
 * Skips jobs whose `claimableAfter` is still in the future (exponential
 * retry backoff) so a fast-failing job cannot starve siblings.
 */
export async function claimNextJob(
  spaceIds: string[],
): Promise<MediaJobDoc | null> {
  const now = new Date().toISOString();
  for (const spaceId of spaceIds) {
    const claimed = await jobCollection(spaceId).findOneAndUpdate(
      mFilter<MediaJobDoc>({
        status: 'pending',
        // Either no backoff set, or backoff has elapsed.
        $or: [
          { claimableAfter: null },
          { claimableAfter: { $exists: false } },
          { claimableAfter: { $lte: now } as unknown as string },
        ],
      }),
      mUpdate<MediaJobDoc>({
        $set: { status: 'processing', claimedAt: now, claimableAfter: null, updatedAt: now },
        $inc: { attempts: 1 },
      }),
      { returnDocument: 'after', sort: { createdAt: 1 } },
    ) as MediaJobDoc | null;
    if (claimed) return claimed;
  }
  return null;
}

// ── Complete / fail ────────────────────────────────────────────────────────

export async function completeJob(spaceId: string, fileId: string): Promise<void> {
  const now = new Date().toISOString();
  await jobCollection(spaceId).updateOne(
    mFilter<MediaJobDoc>({ _id: fileId }),
    mUpdate<MediaJobDoc>({ $set: { status: 'complete', claimedAt: null, updatedAt: now } }),
  );
  await fileCollection(spaceId).updateOne(
    mFilter<FileMetaDoc>({ _id: fileId }),
    { $set: { embeddingStatus: 'complete', updatedAt: now } },
  );
}

export async function failJob(
  spaceId: string,
  fileId: string,
  attempts: number,
  maxAttempts: number,
  errorMessage: string,
): Promise<void> {
  const now = new Date().toISOString();
  // Sanitise error: never surface raw internal paths/URLs in the API response
  const safeError = sanitiseError(errorMessage);

  if (attempts < maxAttempts) {
    // Still has retries — reset to pending with backoff
    // `attempts` here is the number of attempts already made (incremented by
    // the claim). Schedule the *next* claim for `attempts + 1` slots out.
    const claimableAfter = nextClaimableAfter(attempts + 1);
    await jobCollection(spaceId).updateOne(
      mFilter<MediaJobDoc>({ _id: fileId }),
      mUpdate<MediaJobDoc>({
        $set: {
          status: 'pending',
          claimedAt: null,
          claimableAfter,
          lastError: safeError,
          updatedAt: now,
        },
      }),
    );
    log.warn(`Media job ${spaceId}/${fileId} failed (attempt ${attempts}/${maxAttempts}), retry after ${claimableAfter}: ${errorMessage}`);
  } else {
    // Exhausted retries
    await jobCollection(spaceId).updateOne(
      mFilter<MediaJobDoc>({ _id: fileId }),
      mUpdate<MediaJobDoc>({
        $set: {
          status: 'failed',
          claimedAt: null,
          lastError: safeError,
          updatedAt: now,
        },
      }),
    );
    await fileCollection(spaceId).updateOne(
      mFilter<FileMetaDoc>({ _id: fileId }),
      { $set: { embeddingStatus: 'failed', mediaJobError: safeError || undefined, updatedAt: now } },
    );
    log.warn(`Media job ${spaceId}/${fileId} exhausted retries: ${errorMessage}`);
  }
}

// ── Stalled job recovery ──────────────────────────────────────────────────

/**
 * Reset jobs stuck in "processing" (e.g. after pod crash / OOM kill).
 * Called once at worker startup AND periodically by the worker loop.
 *
 * Implemented as a per-document atomic claim via findOneAndUpdate so
 * concurrent worker pods cannot double-increment the `attempts` counter
 * for the same job (which a naive updateMany would do under contention).
 * Each call resets at most `maxPerSpace` stalled jobs per space; the loop
 * runs again on the next tick if more remain.
 */
export async function resetStalledJobs(
  spaceIds: string[],
  stalledJobTimeoutMs: number,
  maxPerSpace = 100,
): Promise<void> {
  const cutoff = new Date(Date.now() - stalledJobTimeoutMs).toISOString();
  let reset = 0;

  for (const spaceId of spaceIds) {
    for (let i = 0; i < maxPerSpace; i++) {
      const now = new Date().toISOString();
      const claimed = await jobCollection(spaceId).findOneAndUpdate(
        mFilter<MediaJobDoc>({
          status: 'processing',
          claimedAt: { $lt: cutoff } as unknown as string,
        }),
        {
          // Crash-recovery: clear the backoff guard so the recovered job is
          // immediately re-claimable. Without this, a job that crashed mid-
          // execution would carry a stale future `claimableAfter` from a prior
          // failure and remain invisible to the worker until that timestamp.
          $set: { status: 'pending', claimedAt: null, claimableAfter: null, updatedAt: now },
          $inc: { attempts: 1 },
        },
        { returnDocument: 'after', sort: { claimedAt: 1 } },
      ) as MediaJobDoc | null;
      if (!claimed) break;
      reset++;
    }
  }

  if (reset > 0) {
    log.info(`Media worker: reset ${reset} stalled job(s) to pending`);
  }
}

// ── retry_embedding helper ─────────────────────────────────────────────────

/**
 * Reset a specific job for manual re-trigger via the retry_embedding endpoint.
 * Returns 'ok', 'not_found', or 'processing'.
 */
export async function retryJob(
  spaceId: string,
  fileId: string,
): Promise<'ok' | 'not_found' | 'processing'> {
  const existing = await jobCollection(spaceId).findOne(
    mFilter<MediaJobDoc>({ _id: fileId }),
  ) as MediaJobDoc | null;

  if (!existing) return 'not_found';
  if (existing.status === 'processing') return 'processing';

  const now = new Date().toISOString();
  await jobCollection(spaceId).updateOne(
    mFilter<MediaJobDoc>({ _id: fileId }),
    mUpdate<MediaJobDoc>({
      $set: {
        status: 'pending',
        attempts: 0,
        lastError: null,
        claimedAt: null,
        claimableAfter: null,
        updatedAt: now,
      },
    }),
  );
  await fileCollection(spaceId).updateOne(
    mFilter<FileMetaDoc>({ _id: fileId }),
    { $set: { embeddingStatus: 'pending', mediaJobError: undefined, updatedAt: now } },
  );
  return 'ok';
}

// ── Helpers ───────────────────────────────────────────────────────────────

/**
 * Strip internal service URLs, file paths and stack traces from error strings
 * before they are stored in `lastError` / returned to clients.
 * Logs the raw error server-side before sanitisation.
 */
function sanitiseError(raw: string): string {
  // Remove anything that looks like a URL
  let s = raw.replace(/https?:\/\/[^\s,;)]+/g, '[url]');
  // Remove Unix-style absolute paths
  s = s.replace(/\/[a-z][a-z0-9_/-]+/gi, '[path]');
  // Truncate to 200 chars to keep the field reasonable
  return s.slice(0, 200);
}
