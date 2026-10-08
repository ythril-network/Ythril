/**
 * Media embedding job queue.
 *
 * Persists `MediaJobDoc` records in the per-space `<spaceId>_media_jobs`
 * collection.  The worker claims jobs atomically via findOneAndUpdate.
 */

import { col, asFilter, asDoc, asUpdate } from '../../db/mongo.js';
import { writeInOneCommands } from '../../db/one-command.js';
import { readStoredById } from '../../db/read-by-id.js';
import { toDocId } from '../../util/paths.js';
import type { StepProgress } from '../converters/types.js';
import type { MediaJobDoc, FileMetaDoc } from '../../config/types.js';
import { log, peerText } from '../../util/log.js';
import { withJitter } from '../../util/backoff.js';
import { newClaimToken, stalledJobWarning } from './lease.js';
import { createWorkSignal } from '../../util/work-signal.js';
import { eachSpace } from '../../util/housekeeping-walk.js';
import { declareStep } from '../../util/housekeeping-signals.js';
import { CLAIM_OP_MS } from '../../db/write-bound.js';
import { spaceCollection } from '../../db/space-collection.js';
import { idsUnder, jobPathsOf, movedId, movedRoot, sidecarsOf, type PathKind } from '../moved-paths.js';

const MAX_ATTEMPTS = 3;

/**
 * The indexes `<space>_media_jobs` needs, declared where the queries live.
 *
 * `initSpace` creates them; the database-level test creates them from THIS list and then asserts the winning
 * plan for the real queries. One source, so a test cannot pass against indexes the product does not build —
 * which is exactly what happens when a test declares its own copy of a schema.
 *
 * Nine sibling collections had indexes and this one had none, while the worker queries it every second and
 * nothing ever prunes it (a completed job stays until its file is deleted). Each entry says which query it
 * serves; add one only with the query that needs it.
 */
export const MEDIA_JOB_INDEXES: Array<Record<string, 1>> = [
  // claimNextJob: { status, $or:[claimableAfter …] } sorted by createdAt. Status leads because every query
  // pins it to one value; createdAt last so the sort is satisfied by the index rather than in memory.
  { status: 1, claimableAfter: 1, createdAt: 1 },
  // resetStalledJobs: { status, progressAt < cutoff }. Its prefix also serves the three `{status}` counts the
  // metric collectors take per space per scrape.
  { status: 1, progressAt: 1 },
];

/**
 * Create the job-queue indexes for one space. Idempotent — an existing index of the same shape is a no-op,
 * which is what makes this safe to run on every boot for every space, including spaces that predate it.
 *
 * Exported so `initSpace` has one call to make and the database-level test can exercise the REAL creation
 * path. A test that builds its own indexes and then asserts a query plan proves that the KEY PATTERNS work;
 * it says nothing about whether the product ever creates them.
 */
export async function ensureMediaJobIndexes(spaceId: string): Promise<void> {
  for (const keys of MEDIA_JOB_INDEXES) {
    await jobCollection(spaceId).createIndex(keys);
  }
}

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
  // Jittered: twenty files failing together while a sidecar restarts would otherwise all become
  // claimable on the same tick and hit it again in one burst, at the moment it is least able to cope.
  return new Date(Date.now() + withJitter(delay)).toISOString();
}

function jobCollection(spaceId: string) {
  return col<MediaJobDoc>(spaceCollection(spaceId, 'mediaJobs'));
}

function fileCollection(spaceId: string) {
  return col<FileMetaDoc>(spaceCollection(spaceId, 'files'));
}

// ── Queue summary (F9 Overview embedding-queue panel) ────────────────────────

/** How many individual failed jobs to name. A list, not a report — the grouping below is the report. */
export const FAILED_SAMPLE_LIMIT = 5;

/** Distinct failure reasons to return. Beyond a handful the answer is "lots of different things". */
export const FAILED_REASON_LIMIT = 10;

export interface MediaJobCounts {
  pending: number;
  processing: number;
  complete: number;
  failed: number;
  /** Up to a few failed jobs (file path + reason) for the panel to surface, not the whole failed set. */
  failedSample: Array<{ path: string; lastError: string | null }>;
  /**
   * Every failure grouped by reason, most common first — computed over the WHOLE failed set, not the sample.
   *
   * `failedSample` shows five paths, which answers "which file" and not "why", and with forty failures an
   * operator could not tell one dead endpoint from forty unrelated problems. The counts here do not depend on
   * which five happened to come back first.
   */
  failedByReason: Array<{ reason: string | null; count: number }>;
}

/**
 * Count this space's embedding jobs by status, a small sample of failed ones (path + reason), and every
 * failure grouped by reason.
 *
 * A missing collection aggregates to all-zero. Per single space — callers sum across members for a proxy
 * space. The two failure queries only run when something has actually failed, so the common case is one
 * aggregation.
 */
export async function getMediaJobCounts(spaceId: string): Promise<MediaJobCounts> {
  const rows = await jobCollection(spaceId)
    .aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }])
    .toArray() as Array<{ _id: string; n: number }>;
  const c: MediaJobCounts = {
    pending: 0, processing: 0, complete: 0, failed: 0, failedSample: [], failedByReason: [],
  };
  for (const r of rows) {
    if (r._id === 'pending' || r._id === 'processing' || r._id === 'complete' || r._id === 'failed') c[r._id] = r.n;
  }
  if (c.failed > 0) {
    const failed = await jobCollection(spaceId)
      .find(asFilter<MediaJobDoc>({ status: 'failed' }), { projection: { _id: 1, lastError: 1 } })
      .limit(FAILED_SAMPLE_LIMIT)
      .toArray() as Array<{ _id: string; lastError: string | null }>;
    c.failedSample = failed.map(d => ({ path: d._id, lastError: d.lastError ?? null }));

    // With 40 failures an operator saw five paths and could not tell whether they shared a cause. Grouping
    // by reason answers the question the sample was standing in for — "is this one broken endpoint or forty
    // different problems?" — at one aggregation rather than forty rows, and it covers EVERY failure rather
    // than the arbitrary first few.
    const byReason = await jobCollection(spaceId)
      .aggregate([
        { $match: { status: 'failed' } },
        { $group: { _id: { $ifNull: ['$lastError', null] }, n: { $sum: 1 } } },
        { $sort: { n: -1 } },
        { $limit: FAILED_REASON_LIMIT },
      ])
      .toArray() as Array<{ _id: string | null; n: number }>;
    c.failedByReason = byReason.map(r => ({ reason: r._id ?? null, count: r.n }));
  }
  return c;
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
  const id = toDocId(filePath);
  const now = new Date().toISOString();

  const existing = await jobCollection(spaceId).findOne(
    asFilter<MediaJobDoc>({ _id: id }),
  ) as MediaJobDoc | null;

  if (existing && (existing.status === 'pending' || existing.status === 'processing')) {
    // Already queued — do not disturb
    return;
  }

  if (existing) {
    // Terminal state (complete/failed) — reset so re-upload triggers re-processing
    await jobCollection(spaceId).updateOne(
      asFilter<MediaJobDoc>({ _id: id }),
      asUpdate<MediaJobDoc>({
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
    await jobCollection(spaceId).insertOne(asDoc<MediaJobDoc>(doc));
  }
  // The claim walk only probes spaces the hint knows about (P12) — so anything that CREATES
  // claimable work must announce it, or the job would sit unclaimed until the next full scan.
  markSpaceMayHaveWork(spaceId);
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
  const id = toDocId(filePath);
  const now = new Date().toISOString();

  const existing = await jobCollection(spaceId).findOne(
    asFilter<MediaJobDoc>({ _id: id }),
  ) as MediaJobDoc | null;

  if (existing) {
    // Always reset — new upload supersedes any previous or in-progress job
    await jobCollection(spaceId).updateOne(
      asFilter<MediaJobDoc>({ _id: id }),
      asUpdate<MediaJobDoc>({
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
    await jobCollection(spaceId).insertOne(asDoc<MediaJobDoc>(doc));
  }

  // Same as enqueueMediaJob: announce the work, or the claim walk will not probe this space.
  markSpaceMayHaveWork(spaceId);

  // Reflect pending status on the file meta record immediately so the UI
  // can show an "embedding" indicator without waiting for the worker.
  await fileCollection(spaceId).updateOne(
    asFilter<FileMetaDoc>({ _id: id }),
    { $set: { embeddingStatus: 'pending', updatedAt: now } },
  ).catch(err => {
    log.debug(`enqueueTextJob: could not set embeddingStatus on file meta ${peerText(spaceId)}/${peerText(id)}: ${peerText(err)}`);
  });
}

// ── Claim ─────────────────────────────────────────────────────────────────

/**
 * Atomically claim one pending job across a set of spaces.
 * Returns the claimed job, or null if none available.
 *
 * Skips jobs whose `claimableAfter` is still in the future (exponential
 * retry backoff) so a fast-failing job cannot starve siblings.
 */
// ── Pending-work hint (P12) ─────────────────────────────────────────────────
//
// Media job collections are PER SPACE, so there is no single cross-space query: claiming
// walks the spaces one findOneAndUpdate at a time and returns on the first hit. When the queue
// is empty — the normal state — every claim paid a full N-space walk just to discover there
// was nothing to do, and the worker does that (workerConcurrency + 1) times per tick. At 100
// spaces that is ~300 sequential round trips per tick, all of them useless.
//
// The hint records which spaces MIGHT hold claimable work, so the walk visits only those.
// It is an optimisation, never the source of truth: a stale hint can only cause an extra
// (harmless) probe, and work is never lost, because...
//
// ...a periodic FULL scan re-seeds it. That matters for one specific case: a job whose retry
// backoff (`claimableAfter`) has not yet elapsed is `pending` but not claimable, so the claim
// returns null and the hint is dropped — and when the backoff DOES elapse, nothing would
// re-add it. The full scan bounds how long such a job can sit unnoticed.
//
// Both concerns now live in `util/work-signal.ts` — they are properties of "a per-space queue with a
// sleeping worker", not of media, and the brain embedding queue needs the identical answer. This module
// keeps its own instance, so a brain enqueue never wakes the media worker.
const _signal = createWorkSignal();

/** The names a failure of each walk is counted and said under (`declareStep`: the series start at 0). */
const CLAIM_STEP = declareStep('Media claim');
const STALL_RESET_STEP = declareStep('Media stall reset');

/** Test seam: forget the probe hint, so the next claim is a full scan (the embed queue's twin is `resetEmbedPendingHint`). */
export const resetMediaPendingHint = (): void => _signal.reset();

// ── Worker wake-up ──────────────────────────────────────────────────────────
//
// On an empty queue the worker backs its poll interval off to workerMaxPollIntervalMs (30s by
// default) and sleeps on a plain setTimeout. That is right for CPU, and wrong for latency: an
// upload into an idle system then waits up to 30 SECONDS before embedding even starts, while
// the user watches the file sit in "pending".
//
// Since every path that creates claimable work already announces it (below), the announcement
// can simply wake the worker. The epoch counter closes the obvious race — work enqueued
// *between* the worker's failed claim and the start of its sleep would otherwise be missed and
// wait out the full backoff anyway. The worker samples the epoch BEFORE claiming and passes it
// to waitForWork(), which returns immediately if it has since moved.
/** Monotonic counter bumped every time claimable work is announced. */
export function currentWorkEpoch(): number {
  return _signal.currentEpoch();
}

/**
 * Sleep up to `ms`, returning early if work is announced.
 * Returns true if woken by work, false if it timed out.
 *
 * `sinceEpoch` must be sampled BEFORE the caller's claim attempt.
 */
export function waitForWork(ms: number, sinceEpoch: number): Promise<boolean> {
  return _signal.wait(ms, sinceEpoch);
}

/** Wake every waiter — used on announcement, and on shutdown so stopping is not delayed. */
export function wakeWorkers(): void {
  _signal.wake();
}

/** Record that a space may have claimable work (enqueue, requeue-on-failure, stall reset). */
export function markSpaceMayHaveWork(spaceId: string): void {
  _signal.markSpaceMayHaveWork(spaceId);
}

export async function claimNextJob(
  spaceIds: string[],
): Promise<MediaJobDoc | null> {
  const now = new Date().toISOString();

  // The walk is `WorkSignal.claimAcross`'s: on a full scan every space is probed (authoritative), otherwise only the hinted ones
  // (on an idle queue, none); a space that threw or hung is isolated and quarantined; a claim is bounded by `CLAIM_OP_MS`. A
  // claim is ONE pass here (the embed queue's lanes are its own).
  return _signal.claimAcross(spaceIds, [null], async (spaceId) =>
    await jobCollection(spaceId).findOneAndUpdate(
      asFilter<MediaJobDoc>({
        status: 'pending',
        // Either no backoff set, or backoff has elapsed.
        $or: [
          { claimableAfter: null },
          { claimableAfter: { $exists: false } },
          { claimableAfter: { $lte: now } as unknown as string },
        ],
      }),
      asUpdate<MediaJobDoc>({
        // `claimToken` identifies THIS run of THIS job. Stall recovery clears it, so a heartbeat from a
        // holder whose job was recovered matches nothing and the old run learns it has been replaced.
        $set: {
          status: 'processing', claimedAt: now, progressAt: now, claimableAfter: null, updatedAt: now,
          claimToken: newClaimToken(),
        },
        $inc: { attempts: 1 },
      }),
      { returnDocument: 'after', sort: { createdAt: 1 } },
    ) as MediaJobDoc | null,
  { step: CLAIM_STEP });
}

// ── Complete / fail ────────────────────────────────────────────────────────

/** Mark a job done. The job itself is always `complete` (no more retries), but the
 *  FILE's embeddingStatus reflects whether every chunk actually embedded: pass
 *  'partial' when some chunks stored without a vector so the file stays distinguishable
 *  and retry-eligible instead of masquerading as fully embedded (B3). */
export async function completeJob(
  spaceId: string,
  fileId: string,
  fileEmbeddingStatus: 'complete' | 'partial' = 'complete',
): Promise<void> {
  const now = new Date().toISOString();
  await jobCollection(spaceId).updateOne(
    asFilter<MediaJobDoc>({ _id: fileId }),
    asUpdate<MediaJobDoc>({ $set: { status: 'complete', claimedAt: null, updatedAt: now } }),
  );
  await fileCollection(spaceId).updateOne(
    asFilter<FileMetaDoc>({ _id: fileId }),
    { $set: { embeddingStatus: fileEmbeddingStatus, updatedAt: now } },
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
      asFilter<MediaJobDoc>({ _id: fileId }),
      asUpdate<MediaJobDoc>({
        $set: {
          status: 'pending',
          claimedAt: null,
          claimableAfter,
          lastError: safeError,
          updatedAt: now,
        },
      }),
    );
    // Pending again (behind a backoff). Announce it: the probe it triggers is cheap, and it
    // keeps the invariant simple — everything that makes a job pending marks the space.
    markSpaceMayHaveWork(spaceId);
    log.warn(`Media job ${spaceId}/${fileId} failed (attempt ${attempts}/${maxAttempts}), retry after ${claimableAfter}: ${errorMessage}`);
  } else {
    // Exhausted retries
    await jobCollection(spaceId).updateOne(
      asFilter<MediaJobDoc>({ _id: fileId }),
      asUpdate<MediaJobDoc>({
        $set: {
          status: 'failed',
          claimedAt: null,
          lastError: safeError,
          updatedAt: now,
        },
      }),
    );
    await fileCollection(spaceId).updateOne(
      asFilter<FileMetaDoc>({ _id: fileId }),
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
/**
 * Which processing jobs count as stalled at `cutoff`.
 *
 * Separated from the query so the rule is checkable without a database — the interesting part is not
 * "does Mongo work" but which of three cases a job falls into, and the third is easy to forget:
 *
 *   1. it ticked recently          → still working, leave it
 *   2. it has not ticked since the cutoff → stalled, recover it
 *   3. it has NO tick at all (claimed by a build older than the heartbeat) → fall back to the claim
 *      time, or those jobs become immortal and nothing ever recovers them
 */
export function stalledJobFilter(cutoff: string): Record<string, unknown> {
  return {
    status: 'processing',
    $or: [
      { progressAt: { $lt: cutoff } },
      { progressAt: { $exists: false }, claimedAt: { $lt: cutoff } },
      { progressAt: null, claimedAt: { $lt: cutoff } },
    ],
  };
}

/** What the file list needs to draw a progress bar for one in-flight file. */
export interface JobProgressView {
  progress?: { step: string; steps: string[]; done?: number; total?: number };
  /** ISO8601 of the last sign of life, so the UI can tell "working" from "wedged". */
  progressAt?: string | null;
}

/**
 * Look up step progress for a set of files, in ONE query.
 *
 * `MediaJobDoc._id` is the file `_id` — one job per file — so this is an `$in`, not an N+1 walk. It
 * is called per member space rather than per file, and only with the ids that are actually in
 * flight: a completed file has nothing to draw, and querying for it would make the common case
 * (a page of finished files) pay for the rare one.
 *
 * Best-effort like the heartbeat that writes the data: a failed lookup returns an empty map and the
 * UI falls back to the plain spinner. A progress bar is not worth failing a file listing over.
 */
export async function fetchJobProgress(
  spaceId: string,
  fileIds: string[],
): Promise<Map<string, JobProgressView>> {
  const out = new Map<string, JobProgressView>();
  if (fileIds.length === 0) return out;   // never issue an empty $in
  try {
    const docs = await readStoredById<JobProgressView>(
      spaceCollection(spaceId, 'mediaJobs'), fileIds, { progress: 1, progressAt: 1 });
    for (const [id, d] of docs) out.set(id, { progress: d.progress, progressAt: d.progressAt });
  } catch { /* best-effort — the listing matters, the bar does not */ }
  return out;
}

/**
 * Record that a claimed job is still doing something.
 *
 * Called by the worker as each unit of work lands. Deliberately best-effort and fire-and-forget: a
 * failed heartbeat must never fail the job it is reporting on — the worst case is that stall
 * detection falls back to the previous tick, which is exactly the behaviour without heartbeats.
 */
export async function touchJobProgress(
  spaceId: string,
  jobId: string,
  progress?: StepProgress,
  claimToken?: string | null,
): Promise<boolean> {
  const now = new Date().toISOString();
  try {
    const res = await jobCollection(spaceId).updateOne(
      // With a token, the heartbeat is also a lease check: it matches only while this run still holds the
      // claim. Without one (an older caller), it degrades to the previous behaviour rather than failing.
      asFilter<MediaJobDoc>({
        _id: jobId,
        status: 'processing',
        ...(claimToken ? { claimToken } : {}),
      }),
      // The step report rides along in the write the heartbeat already performs — reporting which
      // step is running costs nothing extra on top of saying that something happened.
      asUpdate<MediaJobDoc>({ $set: { progressAt: now, ...(progress ? { progress } : {}) } }),
    );
    return res.matchedCount > 0;
  } catch {
    // A failed heartbeat is not evidence the lease is gone — a dropped connection would otherwise abort a
    // healthy job. Report "still ours" and let stall detection do its job on the next tick.
    return true;
  }
}

/**
 * Hand a claim back, because this process is going away — the opposite of a crash.
 *
 * Stall recovery exists for the case where nobody can say what happened. A planned shutdown CAN say, and
 * saying so is worth a write: without this the job sits `processing` with a live token until
 * `stalledJobTimeoutMs` elapses on the next boot, so a rolling restart costs up to five minutes of dead time
 * per in-flight job for no reason.
 *
 * Guarded on the token so a job that has meanwhile been recovered and re-claimed by another run is left alone:
 * releasing it then would yank the claim out from under a worker that is making progress.
 */
export async function releaseClaimedJob(spaceId: string, jobId: string, claimToken?: string | null): Promise<boolean> {
  const now = new Date().toISOString();
  try {
    const res = await jobCollection(spaceId).updateOne(
      asFilter<MediaJobDoc>({
        _id: jobId,
        status: 'processing',
        ...(claimToken ? { claimToken } : {}),
      }),
      // `claimableAfter: null` so the next boot can pick it up immediately: this was not a failure, so there
      // is nothing to back off from. `attempts` is deliberately NOT incremented — the attempt did not fail,
      // it was interrupted, and charging it would spend the retry budget on our own deploys.
      asUpdate<MediaJobDoc>({
        $set: { status: 'pending', claimedAt: null, claimToken: null, claimableAfter: null, updatedAt: now },
      }),
    );
    if (res.matchedCount > 0) markSpaceMayHaveWork(spaceId);
    return res.matchedCount > 0;
  } catch (err) {
    // Best-effort by design: this runs during shutdown, where the database connection may already be going.
    // Failing to release is exactly the old behaviour — stall recovery still catches it.
    log.debug(`Could not release claim on ${spaceId}/${jobId}: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

export async function resetStalledJobs(
  spaceIds: string[],
  stalledJobTimeoutMs: number,
  maxPerSpace = 100,
): Promise<void> {
  // Measured from the last progress tick. `progressAt` is seeded at claim time, so a job that
  // dies immediately is still reaped after the timeout; `claimedAt` remains the fallback for jobs
  // claimed by an older build that predates the field.
  const cutoff = new Date(Date.now() - stalledJobTimeoutMs).toISOString();
  let reset = 0;

  // One space's failure is isolated and a hung one quarantined, so a space that does not answer cannot hold the reset (and the
  // sweep timer behind it) from the spaces that do. Each of the up-to-`maxPerSpace` operations carries the claim's bound.
  await eachSpace(STALL_RESET_STEP, spaceIds, async (spaceId) => {
    for (let i = 0; i < maxPerSpace; i++) {
      const now = new Date().toISOString();
      const claimed = await jobCollection(spaceId).findOneAndUpdate(
        asFilter<MediaJobDoc>(stalledJobFilter(cutoff) as unknown as Partial<MediaJobDoc>),
        {
          // Crash-recovery: clear the backoff guard so the recovered job is
          // immediately re-claimable. Without this, a job that crashed mid-
          // execution would carry a stale future `claimableAfter` from a prior
          // failure and remain invisible to the worker until that timestamp.
          //
          // `claimToken: null` is how the PREVIOUS holder finds out. If it is still alive — a slow job, not
          // a dead one — its next heartbeat matches nothing and it abandons instead of racing the new run.
          $set: { status: 'pending', claimedAt: null, claimableAfter: null, claimToken: null, updatedAt: now },
          $inc: { attempts: 1 },
        },
        { returnDocument: 'before', sort: { claimedAt: 1 } },
      ) as MediaJobDoc | null;
      if (!claimed) break;
      // One WARN per job, naming the file, the silence, the size and the step. `returnDocument: 'before'`
      // above is what makes that possible: the pre-reset document still carries the progress the job had
      // reached, which is the whole diagnostic — the reset itself is not news, what it interrupted is.
      let sizeBytes: number | undefined;
      try {
        const meta = await fileCollection(spaceId).findOne(
          asFilter<FileMetaDoc>({ _id: claimed._id }), { projection: { sizeBytes: 1 } },
        ) as { sizeBytes?: number } | null;
        sizeBytes = meta?.sizeBytes;
      } catch { /* the warning is worth more without the size than not at all */ }
      log.warn(stalledJobWarning({ ...claimed, spaceId }, Date.now(), sizeBytes));
      // Crash-recovered jobs are immediately claimable again — re-arm the hint, otherwise the
      // claim walk would skip this space until the next full scan.
      markSpaceMayHaveWork(spaceId);
      reset++;
    }
  }, { opMs: CLAIM_OP_MS, when: 'next stall sweep' });

  if (reset > 1) {
    // Each job already logged its own WARN above; this only adds the shape of a batch — several at once is
    // a pod that died, one at a time is a job being outrun by the timeout.
    log.info(`Media worker: reset ${reset} stalled job(s) to pending in one sweep`);
  }
}

// ── Cancel (on file / directory deletion) ──────────────────────────────────

/**
 * Delete the media job for a single file, if one exists. Called when the file
 * is deleted so a queued job cannot outlive its source and retry forever
 * against a path that no longer exists.
 */
export async function cancelMediaJob(spaceId: string, filePath: string): Promise<void> {
  const id = toDocId(filePath);
  await jobCollection(spaceId).deleteOne(asFilter<MediaJobDoc>({ _id: id }));
}

/**
 * Delete every queued job of what `p` owns, as a `kind`: a directory's subtree, and every sidecar `sidecarsOf` names for `p` — a
 * sidecar FILE by its id, a sidecar TREE by its prefix. Called by a file's and a directory's delete, so neither spells the sidecar
 * paths itself; the set is `jobPathsOf`, the one a move holds and re-keys, so delete and move cannot disagree about whose a job
 * is. **A file's OWN job is not among them** (`cancelMediaJob` takes it): the text job of a file clears that file's
 * sidecars from inside itself (`deleteConversionArtifacts`, before it re-chunks), and would cancel its own lease.
 *
 * What it prevents: a job outliving its source, retrying for ever against a path nothing holds — or, worse, finishing after the
 * delete's cascade and writing a row of the deleted content. A peer that never converts holds `_converted/<f>.md` as an ordinary
 * file with a text job of its own, which is neither the file's id nor under a tree; the file's delete read only the trees, so that
 * job ran on and left a chunk of the deleted file's text, searchable, belonging to nothing (bundle-71 verify).
 */
export async function cancelJobsOwnedBy(spaceId: string, p: string, kind: PathKind): Promise<void> {
  const root = movedRoot(p);
  if (!root) return; // guard: an empty path would match everything
  // The same set a move holds (`jobPathsOf`), less a FILE's own job, which `cancelMediaJob` takes.
  const owned = kind === 'directory' ? jobPathsOf(root, kind) : sidecarsOf(root, kind);
  await jobCollection(spaceId).deleteMany(asFilter<MediaJobDoc>({ $or: idsUnder(owned) }));
}

// ── Move (a file or directory changes path) ────────────────────────────────

/**
 * How long a move may hold its jobs before they become claimable again on their own. Only reached if the process
 * dies mid-move; then the job runs at the old path, finds the file wherever the move left it, and reconciles.
 */
const MOVE_HOLD_MS = 10 * 60_000;

/**
 * Take the claim on every unfinished job belonging to `src` and keep them unclaimable — step one of a move, BEFORE the
 * bytes leave. Returns the ids held, for `rekeyJobsForMove` or `releaseMoveHold`.
 *
 * Before the bytes, because both late writers a move can meet act on what they observe on disk. A run whose
 * conversion commits after this finds its claim gone and writes nothing (`writeUnderClaim`); a run that finds the file
 * missing asks whether it still holds the claim before it "reconciles a deleted source" — which, mid-move, would
 * delete the very job and records the move is carrying (`holdsClaim`). Held first, the answer is already "no" by the
 * time anything can see the file gone. Held after, both windows stay open.
 *
 * "Belonging to `src`" is `jobPathsOf(src, kind)`, the rule the delete cancels by — `kind` is what `src` IS, read from the disk
 * by the caller — so a sidecar's job (a peer's converted Markdown has one of its own) is held with its file and not left to run at
 * the old path.
 */
export async function holdJobsForMove(spaceId: string, src: string, kind: PathKind): Promise<string[]> {
  const owned = idsUnder(jobPathsOf(src, kind));
  if (owned.length === 0) return [];
  const open = asFilter<MediaJobDoc>({
    $or: owned,
    status: { $in: ['pending', 'processing'] },
  });
  const ids = (await jobCollection(spaceId).find(open, { projection: { _id: 1 } }).toArray()).map(j => String(j._id));
  if (ids.length === 0) return [];
  const now = new Date().toISOString();
  await jobCollection(spaceId).updateMany(
    asFilter<MediaJobDoc>({ _id: { $in: ids }, status: { $in: ['pending', 'processing'] } }),
    // Handed back rather than failed: nothing went wrong, so `attempts` is not charged — the same terms as a release.
    asUpdate<MediaJobDoc>({ $set: {
      status: 'pending', claimedAt: null, claimToken: null, updatedAt: now,
      claimableAfter: new Date(Date.now() + MOVE_HOLD_MS).toISOString(),
    } }),
  );
  return ids;
}

/** Undo `holdJobsForMove` where they stand — the move failed, so the jobs belong to the old path after all. */
export async function releaseMoveHold(spaceId: string, heldIds: string[]): Promise<void> {
  if (heldIds.length === 0) return;
  await jobCollection(spaceId).updateMany(
    asFilter<MediaJobDoc>({ _id: { $in: heldIds } }),
    asUpdate<MediaJobDoc>({ $set: { claimableAfter: null, updatedAt: new Date().toISOString() } }),
  );
  markSpaceMayHaveWork(spaceId);
}

/**
 * Re-key every job belonging to `src` onto its path under `dst`, releasing the ones `holdJobsForMove` held so they
 * run again where the file now is. A job's `_id` IS its path, so this is a delete and a re-insert — the same shape as
 * the metadata it follows. A finished job keeps its state: it describes bytes that moved unchanged. The jobs are the ones
 * `holdJobsForMove` holds, by the same `kind`.
 */
export async function rekeyJobsForMove(spaceId: string, src: string, dst: string, heldIds: string[], kind: PathKind): Promise<void> {
  const owned = idsUnder(jobPathsOf(src, kind));
  if (owned.length === 0) return;
  const jobs = await jobCollection(spaceId).find(
    asFilter<MediaJobDoc>({ $or: owned }),
  ).toArray() as MediaJobDoc[];
  const held = new Set(heldIds);
  const now = new Date().toISOString();
  const moved = jobs.flatMap(j => {
    const to = movedId(j._id, src, dst);
    return to ? [{ ...j, _id: to, filePath: to, updatedAt: now, ...(held.has(j._id) ? { claimableAfter: null } : {}) }] : [];
  });
  if (moved.length === 0) return;
  await jobCollection(spaceId).deleteMany(asFilter<MediaJobDoc>({ _id: { $in: jobs.map(j => j._id) } }));
  // Replacing anything already queued at the destination: a move onto an existing path replaces that file.
  await jobCollection(spaceId).deleteMany(asFilter<MediaJobDoc>({ _id: { $in: moved.map(j => j._id) } }));
  const jobsColl = jobCollection(spaceId);
  // ONE insert command for anything within the driver's one-command limits, 99 999 rows and 16 MiB (`db/one-command.ts`), as the driver sent it
  // before the write was sliced. The moved path's jobs are deleted BEFORE this insert, so a set larger than that — several commands — can
  // fail between two of them and leave the later rows deleted and not re-inserted: the limit of delete-then-insert, stated
  // here rather than hidden. Making it insert-first changes what the move does with a destination that is taken, and is owed
  // its own tests against the store.
  await writeInOneCommands(moved.map(j => asDoc<MediaJobDoc>(j)), (slice, { ordered }) => jobsColl.insertMany(slice, { ordered }), { ordered: true });
  markSpaceMayHaveWork(spaceId);
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
    asFilter<MediaJobDoc>({ _id: fileId }),
  ) as MediaJobDoc | null;

  if (!existing) return 'not_found';
  if (existing.status === 'processing') return 'processing';

  const now = new Date().toISOString();
  await jobCollection(spaceId).updateOne(
    asFilter<MediaJobDoc>({ _id: fileId }),
    asUpdate<MediaJobDoc>({
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
    asFilter<FileMetaDoc>({ _id: fileId }),
    { $set: { embeddingStatus: 'pending', mediaJobError: undefined, updatedAt: now } },
  );
  // A manual retry must be picked up promptly — announce it, or the claim walk would not
  // probe this space until the next full scan (up to 30 s of the user staring at "pending").
  markSpaceMayHaveWork(spaceId);
  return 'ok';
}

/**
 * Reset every FAILED job in a space back to pending for a bulk manual re-trigger (F9 "retry all
 * failed"). Skips jobs currently processing (the `status: 'failed'` filter excludes them). Returns
 * the number reset. Mirrors `retryJob` for the whole failed set rather than one file at a time.
 */
export async function retryFailedJobs(spaceId: string): Promise<number> {
  const jc = jobCollection(spaceId);
  const failed = await jc
    .find(asFilter<MediaJobDoc>({ status: 'failed' }), { projection: { _id: 1 } })
    .toArray() as Array<{ _id: string }>;
  if (!failed.length) return 0;

  const now = new Date().toISOString();
  await jc.updateMany(
    asFilter<MediaJobDoc>({ status: 'failed' }),
    asUpdate<MediaJobDoc>({
      $set: { status: 'pending', attempts: 0, lastError: null, claimedAt: null, claimableAfter: null, updatedAt: now },
    }),
  );
  await fileCollection(spaceId).updateMany(
    asFilter<FileMetaDoc>({ _id: { $in: failed.map(f => f._id) } }),
    { $set: { embeddingStatus: 'pending', mediaJobError: undefined, updatedAt: now } },
  );
  // Same reason as retryJob: announce the work or the claim walk waits up to a full scan (~30 s).
  markSpaceMayHaveWork(spaceId);
  return failed.length;
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
  // Bounded by the one renderer (redacted, cut on a code point, saying it was cut) — the URL and path scrubbing above
  // is a different question (internal topology, not secrets), so it stays here (bundle-30 I6, C16).
  return peerText(s, { max: 200 });
}
