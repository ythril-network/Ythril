/**
 * Media embedding job queue.
 *
 * Persists `MediaJobDoc` records in the per-space `<spaceId>_media_jobs`
 * collection.  The worker claims jobs atomically via findOneAndUpdate.
 */

import { col, asFilter, asDoc, asUpdate } from '../../db/mongo.js';
import type { ClientSession } from 'mongodb';
import { inBoundedTransaction } from '../../db/bounded-transaction.js';
import { READ_CHUNK, readStoredById } from '../../db/read-by-id.js';
import { inChunks } from '../../util/chunks.js';
import { toDocId } from '../../util/paths.js';
import type { StepProgress } from '../converters/types.js';
import type { MediaJobDoc, FileMetaDoc } from '../../config/types.js';
import { log, peerText } from '../../util/log.js';
import { withJitter } from '../../util/backoff.js';
import { newClaimToken, revokingClaims, stalledJobWarning, writeUnderClaim, type JobClaim } from './lease.js';
import { createWorkSignal } from '../../util/work-signal.js';
import { eachSpace } from '../../util/housekeeping-walk.js';
import { declareStep } from '../../util/housekeeping-signals.js';
import { CLAIM_OP_MS } from '../../db/write-bound.js';
import { spaceCollection } from '../../db/space-collection.js';
import { idsUnder, jobIdClausesOf, jobPathsOf, movedPairs, movedRoot, sidecarsOf, type PathKind } from '../moved-paths.js';
import { setFileProcessingState } from '../derived-fields.js';
import { rekeyRows } from '../rekey-rows.js';
import { moveTiming } from '../move-timing.js';
import { sameKnownHash } from '../same-known-hash.js';
import { moveIsRunningAt } from '../move-flight.js';
import { moveCarriesRecordsAt } from '../move-markers.js';

const MAX_ATTEMPTS = 3;

/**
 * The indexes `<space>_media_jobs` needs, declared where the queries live.
 *
 * The per-space declaration (`spaces/space-indexes.ts`) reads them, so `initSpace`, the background pass and a restore build them;
 * the database-level test builds them through that declaration and then asserts the winning
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
 * Exponential backoff schedule (in ms) keyed by next attempt number.
 * After attempt 1 fails → wait 30 s; after 2 fails → wait 2 min.
 * The cap (`maxAttempts`) means we never schedule a wait beyond attempt 3.
 */
const RETRY_BACKOFF_MS: Record<number, number> = {
  1: 30_000,    // first retry available 30 s after the first failure
  2: 120_000,   // second retry available 2 min after the second failure
};

/** How long a deferred job waits before it is claimable again ({@link deferJob}). */
export const DEFERRAL_WAIT_MS = 60_000;

/** How long a job may be deferred in all, measured from its first deferral; past it {@link deferJob} refuses. */
export const DEFERRAL_CAP_MS = 30 * 60_000;

/**
 * What a deferral leaves on a media job (Q-327), written only by {@link deferJob} and read by the worker.
 *
 * `deferredSince` is stamped by the FIRST deferral and kept by every later one, so the cap is measured from it. `facesOnly` says the
 * caption of the job's file is already stored, so the re-run need not make it again (`image-embedder.ts` skips it only when the caption
 * row is there). Both go ({@link DEFERRAL_MARKS}) when the job ends ({@link endJob}) and whenever the job is returned to pending as a
 * whole new run ({@link RUN_RESET}: a manual retry, a replacement of its bytes by {@link replaceContent}, the enqueue's terminal reset).
 */
export type MediaJobDeferral = Pick<MediaJobDoc, 'deferredSince' | 'facesOnly'>;

/**
 * The `$unset` of a deferral's marks (`deferredSince`, `facesOnly`): what ends them, in one place, so a writer that ends a job or
 * starts a new run cannot forget one (a retried job kept both and skipped the caption the retry was asked for: S8).
 */
export const DEFERRAL_MARKS: Readonly<Record<keyof MediaJobDeferral, ''>> = { deferredSince: '', facesOnly: '' };

/**
 * What returning a job to `pending` as a WHOLE NEW RUN sets, as a `$set` spread: the run state and nothing else (no attempt spent, no
 * error, no claim). Every writer that does it spreads this and its {@link RUN_RESET_UNSET}, so a seventh cannot spell a reset that
 * forgets a field (`every-write-returning-a-media-job-to-pending-goes-through-run-reset` reads job-queue.ts for it).
 *
 * It names no identity key: the job's `mimeType`, `mediaType`, `arrival` and `sha256` are set by the write door ({@link replaceContent})
 * and by the enqueue, never by a reset, or a retry would turn a peer's arrived image into one written here. `updatedAt` and
 * `claimableAfter` are the caller's: when the job may be claimed is a different question for each writer. A reset of a TEXT job keeps its
 * `resolvedFormat`, which is the document format the run converts by and not run state.
 */
export const RUN_RESET = {
  status: 'pending',
  attempts: 0,
  lastError: null,
  claimedAt: null,
  claimToken: null,
} as const;

/** The `$unset` that goes with {@link RUN_RESET}: the step report of the run that was (`progress`) and the deferral's marks. */
export const RUN_RESET_UNSET: Readonly<Record<string, ''>> = { progress: '', ...DEFERRAL_MARKS };

/**
 * How long the write door and a manual retry keep a job unclaimable after they write it, in ms.
 *
 * Two things need the wait. The file ROW reads `pending` only after the job is written (a retry must leave the row alone when a
 * worker had claimed the job first), so the job cannot be claimable before that second write lands: a worker that claimed, marked the
 * row `processing` and finished in the gap would be overwritten by a late `pending`. And a path written again and again (an editor
 * saving, a sync client re-sending) would cost a whole run, caption included, for every write if the first could start at once: with a
 * wait, each write moves the start out again and the burst settles into ONE run. A few seconds: longer than a burst of saves and the
 * row write behind it, short enough that a single upload does not visibly wait.
 */
export const REPLACE_SETTLE_MS = 3_000;

/** May this job be deferred again: never deferred, or first deferred less than {@link DEFERRAL_CAP_MS} ago. */
export function mayDeferAgain(job: MediaJobDeferral): boolean {
  return !job.deferredSince || Date.now() - Date.parse(job.deferredSince) < DEFERRAL_CAP_MS;
}

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
 * Make sure a file has a media job. For the callers that ask without knowing whether the bytes changed: the lazy repair of a
 * pulled file (`file-meta.ts`) and the images extracted from a document (`converters/pipeline.ts`). Idempotent: a job that is
 * `pending` or `processing` is left as it is (but for the arrival rule below); a terminal one (`complete` or `failed`) is returned
 * to pending as a WHOLE new run ({@link RUN_RESET}), so the repair or re-extraction analyses again.
 *
 * It is NOT the write door. Bytes written or arrived at a path go through {@link replaceContent}, which also resets a queued job
 * (new bytes make the run under way obsolete), carries the hash that says whether the bytes are new, and orders the file row before
 * the claim. Here nothing says the bytes changed, so a queued job is never disturbed, and a terminal reset takes a stale hash off
 * (`sha256`): the job is about bytes this call cannot name.
 *
 * `opts.arrival` says the bytes came from a peer (`MediaJobDoc.arrival`); it is the whole of what the job carries about that,
 * and it is stamped on EVERY enqueue (a reset included), so a later local write to the path is not held to the rule of the
 * arrival that came before it. A LOCAL call onto a queued arrival job takes the mark off, even for the same bytes: the file is
 * now one a person wrote, and a person's image is analysed as a person's.
 */
export async function enqueueMediaJob(
  spaceId: string,
  filePath: string,
  mimeType: string,
  mediaType: 'image' | 'audio' | 'video',
  opts: { arrival?: boolean } = {},
): Promise<void> {
  const id = toDocId(filePath);
  const now = new Date().toISOString();
  const arrival = opts.arrival === true;

  const existing = await jobCollection(spaceId).findOne(
    asFilter<MediaJobDoc>({ _id: id }),
  ) as MediaJobDoc | null;

  if (existing && (existing.status === 'pending' || existing.status === 'processing')) {
    // Already queued — do not disturb. The one exception is the arrival rule: a LOCAL call onto a queued arrival job takes the
    // arrival mark off.
    if (existing.arrival && !arrival) {
      await jobCollection(spaceId).updateOne(asFilter<MediaJobDoc>({ _id: id }), asUpdate<MediaJobDoc>({ $set: { arrival: false } }));
    }
    return;
  }

  if (existing) {
    // Terminal state (complete/failed) — a whole new run, so a repair or a re-extraction analyses again. The identity is this call's
    // (`mimeType`, `mediaType`, `arrival`); a stale hash and a text job's format go, because this call names neither.
    await jobCollection(spaceId).updateOne(
      asFilter<MediaJobDoc>({ _id: id }),
      asUpdate<MediaJobDoc>({
        $set: { ...RUN_RESET, claimableAfter: null, updatedAt: now, mimeType, mediaType, arrival },
        $unset: { ...RUN_RESET_UNSET, sha256: '', resolvedFormat: '' },
      }),
    );
  } else {
    const doc: MediaJobDoc = {
      _id: id,
      spaceId,
      filePath: id,
      mimeType,
      mediaType,
      ...(arrival ? { arrival } : {}),
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

/** What the write door knows of the bytes it was handed: the job's identity, set by {@link replaceContent} and by nothing else. */
export interface ReplacedContent {
  mimeType: string;
  /** `text` for a document the worker converts (`resolvedFormat` names its format), else the media class. */
  mediaType: MediaJobDoc['mediaType'];
  /** The document format of a text job (`md`, `pdf`, ...); the worker converts by it. Not for a media job. */
  resolvedFormat?: string;
  /** The hash of the bytes now at the path, when the caller has it: absent reads as "not the same bytes as any job's". */
  sha256?: string | undefined;
  /** The bytes came from a peer (`MediaJobDoc.arrival`). */
  arrival: boolean;
}

/**
 * The write door's ONE call for "the bytes at this path were replaced", for media and for documents: whatever job the path had
 * becomes a job for the NEW bytes, and the file row reads `pending` before any worker can claim it. It never throws: a failure sets the
 * row `failed` and is logged at ERROR (below), and the answer says which happened.
 *
 * ## What it prevents
 *
 *  - **The old run goes on over bytes that are gone.** A job that is `processing` for other bytes is taken over in the same write that
 *    resets it ({@link RUN_RESET}, under {@link revokingClaims}): the old run's claim matches nothing, so nothing it does lands
 *    (`writeUnderClaim`), and `deferJob` answers `'lost'`. A job for the SAME bytes (`sha256`) that is `pending` or `processing` is left
 *    alone: the run under way is the right one, and a second arrival must not throw half a conversion away. The one thing it still
 *    does is the arrival rule: a LOCAL write onto an arrival job takes the mark off.
 *  - **A run per write.** The job is claimable only after {@link REPLACE_SETTLE_MS}, measured from the LAST write: a path written
 *    continuously settles into one run, not a caption per save. While a move is running or owed at the path (`moveIsRunningAt`,
 *    `moveCarriesRecordsAt`) it is held until the move's hold is over as well, and keeps a later hold the job already carries (read inside
 *    the write, so a hold taken between the read and the write is not lost): a job unheld in the middle of a move would be claimed at
 *    the OLD path.
 *  - **A run's own state overwritten.** The row is written `pending` BEFORE the job is reset, as every writer that makes a job claimable
 *    does (`a-file-row-reads-pending-before-its-job-can-be-claimed`): a `pending` written after could land on the `processing` of a run
 *    that already claimed. An old run still holding its claim between the two writes can only write its own finish, which the new run's
 *    `processing` replaces once it claims.
 *  - **A spinner nothing ends.** A write that fails sets the row `failed` with the reason and logs ERROR with the path, the step and the cause; it is never
 *    swallowed into `pending`, because a `pending` row under the same hash is what `settledAndIdentical` reads as "work under way", so a
 *    re-upload, the one thing that would help, would be skipped too.
 *
 * `markSpaceMayHaveWork` runs in a `finally`, and again when the settle delay is over: a claim that finds the job not yet claimable
 * drops the space from the probe hint, so without the second announcement the job would wait for the next full scan.
 */
export async function replaceContent(spaceId: string, filePath: string, identity: ReplacedContent): Promise<'queued' | 'failed'> {
  const id = toDocId(filePath);
  const isText = identity.mediaType === 'text';
  let step = 'reading the job at the path';
  try {
    const existing = await jobCollection(spaceId).findOne(asFilter<MediaJobDoc>({ _id: id })) as MediaJobDoc | null;
    const sameBytes = sameKnownHash(identity.sha256, existing?.sha256);
    if (existing && sameBytes && (existing.status === 'pending' || existing.status === 'processing')) {
      step = 'taking the arrival mark off the job at the path';
      if (existing.arrival && !identity.arrival) {
        await jobCollection(spaceId).updateOne(asFilter<MediaJobDoc>({ _id: id }), asUpdate<MediaJobDoc>({ $set: { arrival: false } }));
      }
      return 'queued';
    }

    step = 'marking the file row pending';
    await setFileProcessingState(spaceId, id,
      { ...(identity.mediaType === 'text' ? {} : { mediaType: identity.mediaType }), embeddingStatus: 'pending', mediaJobError: undefined });

    step = 'writing the job at the path';
    const now = Date.now();
    const iso = new Date(now).toISOString();
    const settled = new Date(now + REPLACE_SETTLE_MS).toISOString();
    const moveHeld = await moveHoldsPath(spaceId, id);
    const lit = (v: string) => ({ $literal: v });
    // One write, an aggregation pipeline so that what the job already carries is read INSIDE it (a move's hold, the first creation's
    // stamp). `$literal` keeps a path or a type that starts with `$` from being read as a field.
    const claimableAfter = moveHeld
      ? { $max: [lit(settled), lit(new Date(now + moveTiming().holdMs).toISOString()), { $ifNull: ['$claimableAfter', ''] }] }
      : lit(settled);
    await revokingClaims(() => jobCollection(spaceId).updateOne(
      asFilter<MediaJobDoc>({ _id: id }),
      [
        { $set: {
          ...RUN_RESET,
          claimableAfter,
          updatedAt: lit(iso),
          spaceId: lit(spaceId),
          filePath: lit(id),
          mimeType: lit(identity.mimeType),
          mediaType: lit(identity.mediaType),
          arrival: identity.arrival,
          maxAttempts: { $ifNull: ['$maxAttempts', MAX_ATTEMPTS] },
          createdAt: { $ifNull: ['$createdAt', lit(iso)] },
          ...(identity.sha256 ? { sha256: lit(identity.sha256) } : {}),
          ...(isText && identity.resolvedFormat ? { resolvedFormat: lit(identity.resolvedFormat) } : {}),
        } },
        // The run that was: its step report and its deferral's marks; and what this write does not name (an unknown hash, the format of
        // a text job on a media one, and the reverse).
        { $unset: [
          ...Object.keys(RUN_RESET_UNSET),
          ...(identity.sha256 ? [] : ['sha256']),
          ...(isText && identity.resolvedFormat ? [] : ['resolvedFormat']),
        ] },
      ],
      { upsert: true },
    ));
    return 'queued';
  } catch (err) {
    await reportDoorFailure(spaceId, id, step, err);
    return 'failed';
  } finally {
    announceNowAndWhenSettled(spaceId);
  }
}

/**
 * Whether a move of `path` is running now or still owed its records (`moveIsRunningAt`, `moveCarriesRecordsAt`): the one question
 * both doors that reset a job ({@link replaceContent}, {@link retryJob}) ask before they write it. Asked as two reads at each door,
 * one of them could be dropped, and the reset would end the move's hold and let a worker claim the job at the OLD path.
 */
async function moveHoldsPath(spaceId: string, path: string): Promise<boolean> {
  return moveIsRunningAt(spaceId, path) || await moveCarriesRecordsAt(spaceId, path);
}

/**
 * Announce a space's work to the claim walk now, and again when a job written just now may be claimed ({@link REPLACE_SETTLE_MS}
 * later). A claim that found the job still waiting drops the space from the probe hint, so without the second announcement the job
 * would wait for the next full scan; written once at each door, the second half was the forgettable one.
 */
function announceNowAndWhenSettled(spaceId: string): void {
  markSpaceMayHaveWork(spaceId);
  setTimeout(() => markSpaceMayHaveWork(spaceId), REPLACE_SETTLE_MS + 100).unref();
}

/**
 * Say that a write door could not do what it set out to with a file's job or rows: the file's row reads `failed` with the reason, and
 * the cause is logged at ERROR with the path and the step. Never throws (the door's own failure is the one being reported); a row it
 * cannot write is logged too.
 *
 * What it prevents: a row left `pending` with no job behind it, which `settledAndIdentical` reads as work under way for as long as the
 * bytes stay the same, so the re-upload that would repair it is skipped (bundle-236, Q-698, C5).
 */
export async function reportDoorFailure(spaceId: string, id: string, step: string, err: unknown): Promise<void> {
  const cause = peerText(err);
  log.error(`Write door: ${peerText(step)} failed for ${peerText(spaceId)}/${peerText(id)}: ${cause}`);
  await setFileProcessingState(spaceId, id, {
    embeddingStatus: 'failed',
    mediaJobError: sanitiseError(`Could not queue the file for analysis (${step}): ${cause}`),
  }).catch(rowErr => {
    log.error(`Write door: the row of ${peerText(spaceId)}/${peerText(id)} could not be marked failed either: ${peerText(rowErr)}`);
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

/**
 * End a job for good: the file ROW's final state and the job's terminal status, in ONE transaction under the run's claim (`Q-434`).
 *
 * ## Why one transaction, and why under the claim
 *
 * Ending a job is two writes, and the order between them used to be the whole argument (`Q-434`): with the job first, anything that
 * stopped the second left a `complete` or `failed` job over a row that read `processing` for ever — nothing revisits a terminal job, so
 * the file showed a spinner indefinitely and Retry was never offered. With the row first, a failure between the two left the job CLAIMED
 * and stall recovery re-ran it. Both writes are now the one transaction, so there is no between: both land or neither does, and a
 * failure leaves the job claimed for recovery, as the row-first order did.
 *
 * It is the run's own claim that makes the transaction: a job's id is its file's path, so an end written by id lands on whichever job
 * holds the path — a run that lost its claim to a delete and a re-upload would complete the NEW run's job while that run was still
 * working. A run that no longer holds its claim ends nothing and gets `JobLeaseLostError`.
 *
 * A failure is THROWN, not logged: the caller's job is still claimed, and it is the caller that knows whether to retry, release or let
 * recovery have it.
 */
async function endJob(
  spaceId: string,
  claim: JobClaim,
  row: Parameters<typeof setFileProcessingState>[2],
  job: { status: 'complete' | 'failed'; lastError?: string | null },
): Promise<void> {
  await writeUnderClaim(spaceId, claim, async (session) => {
    await setFileProcessingState(spaceId, claim.jobId, row, { session });
    await jobCollection(spaceId).updateOne(
      asFilter<MediaJobDoc>({ _id: claim.jobId }),
      // A deferral's marks end with the job ({@link DEFERRAL_MARKS}): a manual retry or a re-upload of the path starts a whole run
      // ({@link RUN_RESET} takes them off too), caption included.
      asUpdate<MediaJobDoc>({ $set: { ...job, claimedAt: null, updatedAt: new Date().toISOString() }, $unset: { ...DEFERRAL_MARKS } }),
      { session },
    );
  });
}

/** Mark a job done. The job itself is always `complete` (no more retries), but the
 *  FILE's embeddingStatus reflects whether every chunk actually embedded: pass
 *  'partial' when some chunks stored without a vector so the file stays distinguishable
 *  and retry-eligible instead of masquerading as fully embedded (B3). Under the run's `claim`
 *  (see {@link endJob}). */
export async function completeJob(
  spaceId: string,
  claim: JobClaim,
  fileEmbeddingStatus: 'complete' | 'partial' = 'complete',
): Promise<void> {
  await endJob(spaceId, claim, { embeddingStatus: fileEmbeddingStatus }, { status: 'complete' });
}

export async function failJob(
  spaceId: string,
  claim: JobClaim,
  attempts: number,
  maxAttempts: number,
  errorMessage: string,
): Promise<void> {
  const now = new Date().toISOString();
  // Sanitise error: never surface raw internal paths/URLs in the API response
  const safeError = sanitiseError(errorMessage);
  const fileId = claim.jobId;

  if (attempts < maxAttempts) {
    // Still has retries — reset to pending with backoff
    // `attempts` here is the number of attempts already made (incremented by
    // the claim). Schedule the *next* claim for `attempts + 1` slots out.
    const claimableAfter = nextClaimableAfter(attempts + 1);
    // A fenced write too: a run that lost its claim must not put the job that replaced it behind a backoff.
    await writeUnderClaim(spaceId, claim, async (session) => {
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
        { session },
      );
    });
    // Pending again (behind a backoff). Announce it: the probe it triggers is cheap, and it
    // keeps the invariant simple — everything that makes a job pending marks the space.
    markSpaceMayHaveWork(spaceId);
    log.warn(`Media job ${spaceId}/${fileId} failed (attempt ${attempts}/${maxAttempts}), retry after ${claimableAfter}: ${errorMessage}`);
  } else {
    // Exhausted retries: ended through `endJob`, so the row and the job stop together.
    await endJob(spaceId, claim,
      { embeddingStatus: 'failed', mediaJobError: safeError || undefined },
      { status: 'failed', lastError: safeError });
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
    // A revoker's bound (`revokingClaims`): the heartbeat writes the job document a fenced write holds, so it waits as long as the holder may.
    const res = await revokingClaims(() => jobCollection(spaceId).updateOne(
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
    ));
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

/** What {@link deferJob} did: `'deferred'` the job is back behind its wait; `'past_cap'` the cap is spent and the run goes on; `'lost'` the claim is gone. */
export type DeferralOutcome = 'deferred' | 'past_cap' | 'lost';

/**
 * Give a claimed job back behind a short wait WITHOUT spending an attempt, because something it needs is not ready yet (Q-327).
 *
 * ## Why it is not `failJob`
 *
 * An image whose face gallery cannot answer yet (the face index rebuilding, 120 s or more after a container recreate) must run again
 * later, and that is not a failure. `failJob` is the only other way back with a wait, and it spends the attempt the claim counted:
 * three of them (30 s, then 2 min) end the job `failed` before a rebuild is over, and the caption of every face photo in the space
 * with it. This puts the job back to `pending`, claimable after {@link DEFERRAL_WAIT_MS}, and refunds the claim's increment.
 *
 * ## What bounds it
 *
 * `deferredSince` is stamped by the first deferral and kept by every later one; past {@link DEFERRAL_CAP_MS} from it the job is NOT
 * deferred again: it stays claimed and this answers `'past_cap'`, and the run goes on to its end ({@link mayDeferAgain} is the same
 * rule, read by the worker before the run). A gallery that never comes back cannot hold a job for ever.
 *
 * Fenced on the claim's token in the one conditional write, as every write a run makes: a holder that lost its claim (the job was
 * re-queued, replaced by new bytes, moved or deleted) defers nothing and gets `'lost'`. The two refusals are told apart by one read
 * of the job under the same claim, because they ask opposite things of the run: a lost claim ends it as abandoned, never as a failure,
 * and a spent cap lets it go on. A boolean could not say which, and the worker treated both as "carry on and write under a claim it no
 * longer holds". The deferred job carries `facesOnly`, so its re-run does not make the stored caption again. `reason` is the
 * caller's and is only said in the log: the queue stores no policy beyond the wait and the cap.
 */
export async function deferJob(spaceId: string, jobId: string, claimToken: string | null | undefined, reason: string): Promise<DeferralOutcome> {
  if (!claimToken) return 'lost';
  const now = new Date();
  const capStart = new Date(now.getTime() - DEFERRAL_CAP_MS).toISOString();
  const claimableAfter = new Date(now.getTime() + DEFERRAL_WAIT_MS).toISOString();
  const res = await jobCollection(spaceId).updateOne(
    asFilter<MediaJobDoc>({
      _id: jobId,
      status: 'processing',
      claimToken,
      $or: [{ deferredSince: { $exists: false } }, { deferredSince: null }, { deferredSince: { $gt: capStart } }],
    }),
    // A pipeline, so the first deferral's stamp is kept by the same write that would otherwise set it, and the refund never goes
    // below zero (a job claimed by a build that counted no attempt).
    [{ $set: {
      status: 'pending', claimedAt: null, claimToken: null, claimableAfter, updatedAt: now.toISOString(), facesOnly: true,
      deferredSince: { $ifNull: ['$deferredSince', now.toISOString()] },
      attempts: { $max: [0, { $subtract: ['$attempts', 1] }] },
    } }],
  );
  if (res.matchedCount === 0) {
    // Nothing matched: the claim is gone, or it is the cap that refused. The same claim, read once, tells them apart.
    const stillHeld = await jobCollection(spaceId).findOne(
      asFilter<MediaJobDoc>({ _id: jobId, status: 'processing', claimToken }), { projection: { _id: 1 } });
    return stillHeld ? 'past_cap' : 'lost';
  }
  markSpaceMayHaveWork(spaceId);
  log.info(`Media job ${peerText(spaceId)}/${peerText(jobId)} deferred for ${DEFERRAL_WAIT_MS / 1000} s, no attempt spent: ${peerText(reason)}`);
  return 'deferred';
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
 *
 * It is also the revocation of the claim a RUNNING job holds: a run's writes are fenced by its job document (`media/lease.ts`), so a
 * run that has not yet written finds nothing to match and writes nothing, and one that is writing is waited for. That is why it comes
 * BEFORE anything a delete removes of the file's rows, and why its bound is the holder's (`revokingClaims`).
 */
export async function cancelMediaJob(spaceId: string, filePath: string): Promise<void> {
  await cancelMediaJobs(spaceId, [filePath]);
}

/**
 * {@link cancelMediaJob} for many files: one `$in` delete per {@link READ_CHUNK} ids, never one command per id (a page of the
 * leaked-rows repair cancels hundreds). The same revocation, with the same bound, and the same place in a remover's order: BEFORE
 * anything it removes of the files' rows (`every-remover-of-file-rows-revokes-claims-first` names it among the revokers).
 */
export async function cancelMediaJobs(spaceId: string, filePaths: readonly string[]): Promise<void> {
  const ids = [...new Set(filePaths.map(toDocId))];
  for (const part of inChunks(ids, READ_CHUNK)) {
    await revokingClaims(() => jobCollection(spaceId).deleteMany(asFilter<MediaJobDoc>({ _id: { $in: part } })));
  }
}

/**
 * Delete every queued job of what `p` owns, as a `kind`: a directory's subtree, and every sidecar `sidecarsOf` names for `p` — a
 * sidecar FILE by its id, a sidecar TREE by its prefix. Called by a file's and a directory's delete, so neither spells the sidecar
 * paths itself; the set is `jobPathsOf`, the one a move holds and re-keys, so delete and move cannot disagree about whose a job
 * is. **A file's OWN job is not among them** (`cancelMediaJob` takes it): the text job of a file clears that file's
 * sidecars from inside itself (`deleteConversionArtifactsUnderClaim`, before it re-chunks), and would cancel its own lease.
 *
 * What it prevents: a job outliving its source, retrying for ever against a path nothing holds — or, worse, finishing after the
 * delete's cascade and writing a row of the deleted content. A peer that never converts holds `_converted/<f>.md` as an ordinary
 * file with a text job of its own, which is neither the file's id nor under a tree; the file's delete read only the trees, so that
 * job ran on and left a chunk of the deleted file's text, searchable, belonging to nothing (bundle-71 verify).
 */
export async function cancelJobsOwnedBy(spaceId: string, p: string, kind: PathKind, only?: readonly string[]): Promise<void> {
  const root = movedRoot(p);
  if (!root) return; // guard: an empty path would match everything
  // The same set a move holds (`jobPathsOf`), less a FILE's own job, which `cancelMediaJob` takes — and, when `only` names sidecar paths
  // (a move that finished without one of its sidecars), no more than those: the jobs of the sidecars that WERE placed are the move's to re-key.
  const owned = (kind === 'directory' ? jobPathsOf(root, kind) : sidecarsOf(root, kind)).filter(s => only === undefined || only.includes(s.path));
  if (owned.length === 0) return;
  await revokingClaims(() => jobCollection(spaceId).deleteMany(asFilter<MediaJobDoc>({ $or: idsUnder(owned) })));
}

/**
 * Delete EVERY job of a space — the revocation a space wipe makes before it removes the space's file rows.
 *
 * A wipe is a remover like a delete: a run that read its parent live would otherwise write its derived rows after the wipe removed
 * them, under files that are gone. With the jobs taken first, a run that has not yet written finds its claim gone, and one that is
 * writing is waited for (`revokingClaims`); the wipe's own removal of the rows then finds whatever that run wrote.
 */
export async function cancelEveryJobOfSpace(spaceId: string): Promise<void> {
  await revokingClaims(() => jobCollection(spaceId).deleteMany({}));
}

// ── Move (a file or directory changes path) ────────────────────────────────

/**
 * Take the claim on every unfinished job belonging to `src` and keep them unclaimable — step one of a move, BEFORE the
 * bytes leave. Returns the ids held, for `rekeyJobsForMove` or `releaseMoveHold`. How long they stay held is
 * `moveTiming().holdMs` (`files/move-timing.ts`): only a process that dies mid-move reaches the end of it, and then the job runs
 * at the old path, finds the file wherever the move left it, and — asking whether a move of that path is owed — reconciles nothing.
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
  const owned = jobIdClausesOf(src, kind);
  if (owned.length === 0) return [];
  const open = asFilter<MediaJobDoc>({
    $or: owned,
    status: { $in: ['pending', 'processing'] },
  });
  const ids = (await jobCollection(spaceId).find(open, { projection: { _id: 1 } }).toArray()).map(j => String(j._id));
  if (ids.length === 0) return [];
  const now = new Date().toISOString();
  await revokingClaims(() => jobCollection(spaceId).updateMany(
    asFilter<MediaJobDoc>({ _id: { $in: ids }, status: { $in: ['pending', 'processing'] } }),
    // Handed back rather than failed: nothing went wrong, so `attempts` is not charged — the same terms as a release.
    asUpdate<MediaJobDoc>({ $set: {
      status: 'pending', claimedAt: null, claimToken: null, updatedAt: now,
      claimableAfter: new Date(Date.now() + moveTiming().holdMs).toISOString(),
    } }),
  ));
  return ids;
}

/**
 * Keep the hold of a move that is still going: push the release of the jobs still at `src` out again — but only the ones whose hold
 * has less than `holdMarginMs` left, and by the path prefix a move holds by (`jobPathsOf`), not by a list of ids. A move of many
 * batches would otherwise outlive its hold and let the worker claim a job at the old path in the middle of it; one write per
 * batch is too many when almost every batch finds the hold nowhere near its end, so the filter, not a read, decides.
 */
export async function extendMoveHold(spaceId: string, src: string, kind: PathKind): Promise<void> {
  const owned = jobIdClausesOf(src, kind);
  if (owned.length === 0) return;
  const { holdMs, holdMarginMs } = moveTiming();
  const now = Date.now();
  await revokingClaims(() => jobCollection(spaceId).updateMany(
    asFilter<MediaJobDoc>({ $or: owned, status: 'pending', claimableAfter: { $ne: null, $lt: new Date(now + holdMarginMs).toISOString() } }),
    asUpdate<MediaJobDoc>({ $set: { claimableAfter: new Date(now + holdMs).toISOString() } }),
  ));
}

/** The ids of every job belonging to `src` as a `kind` — the set a move holds and re-keys (`jobPathsOf`), whatever its state. */
export async function jobIdsOwnedBy(spaceId: string, src: string, kind: PathKind): Promise<string[]> {
  const owned = jobIdClausesOf(src, kind);
  if (owned.length === 0) return [];
  return (await jobCollection(spaceId).find(asFilter<MediaJobDoc>({ $or: owned }), { projection: { _id: 1 } }).toArray()).map(j => String(j._id));
}

/** Undo `holdJobsForMove` where they stand — the move failed, so the jobs belong to the old path after all. */
export async function releaseMoveHold(spaceId: string, heldIds: string[]): Promise<void> {
  if (heldIds.length === 0) return;
  await revokingClaims(() => jobCollection(spaceId).updateMany(
    asFilter<MediaJobDoc>({ _id: { $in: heldIds } }),
    asUpdate<MediaJobDoc>({ $set: { claimableAfter: null, updatedAt: new Date().toISOString() } }),
  ));
  markSpaceMayHaveWork(spaceId);
}

/**
 * Re-key every job belonging to `src` onto its path under `dst`, releasing the ones `holdJobsForMove` held so they
 * run again where the file now is. A job's `_id` IS its path, so this is a re-key (`files/rekey-rows.ts`): the same one the
 * metadata it follows goes through, and a job is local state, so the row is a plain spread. A finished job keeps its state: it
 * describes bytes that moved unchanged. The jobs are the ones `holdJobsForMove` holds, by the same `kind`.
 *
 * A job still queued at a destination id is replaced: it is a stale one — a deleted file's, or a finished one — because a move never replaces a
 * live file (the move is refused before it gets here).
 *
 * With `within` — the cascade's batch transaction and the ids of the jobs that belong to the batch — the re-key is part of THAT
 * transaction, and waking the worker is the caller's, once the transaction has committed: a wake before the commit finds no row at
 * the new id, reports the job gone, and has it deleted. Without it the call is its own transaction and wakes the worker itself.
 * Returns how many jobs moved.
 */
export async function rekeyJobsForMove(
  spaceId: string, src: string, dst: string, heldIds: readonly string[], kind: PathKind,
  within?: { session: ClientSession; jobIds: readonly string[] },
): Promise<number> {
  const ids = within?.jobIds ?? await jobIdsOwnedBy(spaceId, src, kind);
  const held = new Set(heldIds);
  const now = new Date().toISOString();
  const moves = movedPairs(ids, src, dst);
  if (moves.length === 0) return 0;
  const moving = new Set(moves.map(m => m.from));
  const run = (session: ClientSession) => rekeyRows<MediaJobDoc>(spaceCollection(spaceId, 'mediaJobs'), session, {
    moves,
    rebuild: (j, to) => ({ ...j, _id: to, filePath: to, updatedAt: now, ...(held.has(j._id) ? { claimableAfter: null } : {}) }),
    refuse: (to) => new Error(`two jobs would take the id '${to}'`),
    replacements: { replaced: moves.map(m => m.to).filter(to => !moving.has(to)) },
  });
  if (within) return await run(within.session);
  const moved = await inBoundedTransaction(run);
  if (moved > 0) markSpaceMayHaveWork(spaceId);
  return moved;
}

// ── retry_embedding helper ─────────────────────────────────────────────────

/**
 * Put a specific job back as a WHOLE new run for a manual re-trigger (the `retry_embedding` endpoint and tool).
 * Returns 'ok', 'not_found', or 'processing' (a worker holds the job, or a move of the path is running or owed).
 *
 * ## What it prevents
 *
 *  - **Taking a claimed job.** The job is written FIRST, and only while it is not `processing` (`status: { $ne: 'processing' }`, in
 *    the write itself). A worker that claimed it between this read and this write leaves the write matching nothing: the answer is
 *    `'processing'` and the file row is as the run left it, never marked `pending` under a worker that is working. (It read, wrote the
 *    row, then wrote the job with no condition, and put a claimed job back to pending under its own token.)
 *  - **A retry that is not clean.** The reset is {@link RUN_RESET} with its {@link DEFERRAL_MARKS}: a deferred job retried skipped the
 *    caption the retry was asked for (S8). The job's identity (`arrival`, the type) is untouched.
 *  - **A late `pending` over a finished run.** The row is written after the job, so the job is not claimable for
 *    {@link REPLACE_SETTLE_MS}: a worker that claimed it in the gap would mark the row `processing` and finish, and the late `pending`
 *    would overwrite it. (A manual retry waits that long, and the space is announced again when it is over.)
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
  // A move of this path is running or owed: its hold is what keeps the job off the old path, and the reset below would end it.
  if (await moveHoldsPath(spaceId, fileId)) return 'processing';

  const now = new Date();
  const res = await jobCollection(spaceId).updateOne(
    asFilter<MediaJobDoc>({ _id: fileId, status: { $ne: 'processing' } }),
    asUpdate<MediaJobDoc>({
      $set: { ...RUN_RESET, claimableAfter: new Date(now.getTime() + REPLACE_SETTLE_MS).toISOString(), updatedAt: now.toISOString() },
      $unset: { ...RUN_RESET_UNSET },
    }),
  );
  if (res.matchedCount === 0) {
    // A claim landed between the read and the write, or the job went. The row is not this retry's to write.
    return await jobCollection(spaceId).countDocuments(asFilter<MediaJobDoc>({ _id: fileId }), { limit: 1 }) === 0 ? 'not_found' : 'processing';
  }
  // After the job, on purpose (see above): the job write itself made it unclaimable for REPLACE_SETTLE_MS, so no claim can precede this.
  await setFileProcessingState(spaceId, fileId, { embeddingStatus: 'pending', mediaJobError: undefined });
  // A manual retry must be picked up — announce it, now and when the settle delay is over, or the claim walk would not
  // probe this space until the next full scan (up to 30 s of the user staring at "pending").
  announceNowAndWhenSettled(spaceId);
  return 'ok';
}

/**
 * Put every FAILED job in a space back as a whole new run, for a bulk manual re-trigger (F9 "retry all
 * failed"). Skips jobs currently processing (a `failed` job is not). Returns the number reset. Mirrors `retryJob`'s reset
 * ({@link RUN_RESET}, so a retried arrival job keeps its mark) for the whole failed set rather than one file at a time, a chunk of ids
 * ({@link READ_CHUNK}) at a time: the rows of a chunk first (a worker may claim a job the moment it is pending), then its jobs, so no
 * command carries the whole set.
 */
export async function retryFailedJobs(spaceId: string): Promise<number> {
  const jc = jobCollection(spaceId);
  const failed = await jc
    .find(asFilter<MediaJobDoc>({ status: 'failed' }), { projection: { _id: 1 } })
    .toArray() as Array<{ _id: string }>;
  if (!failed.length) return 0;

  const now = new Date().toISOString();
  let reset = 0;
  for (const part of inChunks(failed.map(f => f._id), READ_CHUNK)) {
    // The rows first, as in retryJob's reasoning: a worker may claim a job the moment it is pending.
    await setFileProcessingState(spaceId, part, { embeddingStatus: 'pending', mediaJobError: undefined });
    const res = await jc.updateMany(
      asFilter<MediaJobDoc>({ _id: { $in: part }, status: 'failed' }),
      asUpdate<MediaJobDoc>({ $set: { ...RUN_RESET, claimableAfter: null, updatedAt: now }, $unset: { ...RUN_RESET_UNSET } }),
    );
    reset += res.matchedCount;
  }
  // Same reason as retryJob: announce the work or the claim walk waits up to a full scan (~30 s).
  markSpaceMayHaveWork(spaceId);
  return reset;
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
