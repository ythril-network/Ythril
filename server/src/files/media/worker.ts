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
 * - Concurrency: up to `workerConcurrency` jobs run at once; a slot is refilled as soon as it frees (`slot-pool.ts`)
 * - Stalled job recovery: reset "processing" jobs older than `stalledJobTimeoutMs`
 *
 * Behaviour when a media class is turned off (its `levels` entry → `off`):
 *   New uploads of that class are never enqueued (dispatch marks them `skipped`),
 *   but the worker still drains any jobs enqueued while the class was on. This is
 *   intentional — those uploads already incurred CPU/disk and the user expects the
 *   corresponding chunks to appear in recall results. To stop processing in flight,
 *   set `workerConcurrency: 0` (or restart the pod, which leaves any pending jobs in
 *   the queue for later).
 *
 * Provider/worker config is hot-reloaded WITHOUT a restart. A dedicated timer
 * (`providerRefreshJob`, an interval job) re-reads the config and rebuilds the provider bundle
 * when the provider-relevant config actually changes. It runs on its own interval,
 * decoupled from the job loop *on purpose*: a job can block the loop for up to the
 * provider timeout (image 120 s, audio 300 s), and a config change — often made
 * precisely because a provider is hanging — must not have to wait for that job to
 * drain. The read is an in-memory config lookup, not a network call. Each tick
 * snapshots the current bundle for its jobs, so a job always runs against one stable
 * provider set (no mid-job swap).
 */

import { getMediaEmbeddingConfig , getDocumentProcessingConfig } from '../../config/loader.js';
import { toSafeRelPath } from '../../util/paths.js';
import { concreteSpaceIds } from '../../spaces/proxy.js';
import { intervalJob, type IntervalJob } from '../../util/interval-job.js';
import type { MediaJobDoc } from '../../config/types.js';
import { log } from '../../util/log.js';
import { createMediaProviders } from './providers.js';
import type { MediaProviderBundle } from './providers.js';
import { removeFileHere } from '../remove-file-here.js';
import { claimNextJob, completeJob, failJob, resetStalledJobs, currentWorkEpoch, waitForWork, wakeWorkers, touchJobProgress , releaseClaimedJob } from './job-queue.js';
import { embedImage } from './image-embedder.js';
import { embedAudio } from './audio-embedder.js';
import { embedVideo } from './video-embedder.js';
import { setFileProcessingState, setDerivedDescriptionIfUnset, setDerivedExcerpt, type FileProcessingState } from '../derived-fields.js';
import { mimeTypeForPath } from '../mime.js';
import { describeDocument } from '../converters/describe.js';
import {
  runConversionPipeline,
  storeConversionResults,
  deleteConversionArtifacts,
} from '../converters/pipeline.js';
import type { ResolvedFormat } from '../converters/pipeline.js';
import { ConversionUnavailableError } from '../converters/types.js';
import type { StepProgress } from '../converters/types.js';
import { isLeaseLost, isAbandonment, holdsClaim, JobLeaseLostError, type JobClaim } from './lease.js';
import { effectiveDocExtractionMode } from '../converters/extraction-level.js';
import { effectiveTextLevel, effectiveVideoLevel, videoDoesKeyframes } from '../converters/media-level.js';
import path from 'path';
import { spaceRoot } from '../sandbox.js';
import {
  mediaJobsCompletedTotal,
  mediaJobsFailedTotal,
  mediaJobsRetriedTotal,
  mediaJobDurationSeconds,
} from '../../metrics/registry.js';
import { stallTimeoutWithWarning } from './stall-floor.js';
import { worstRenderWindowMs } from '../converters/render-budget.js';
import { FFMPEG_STEP_TIMEOUT_MS } from './transcode.js';
import { providerHopMs } from './providers.js';
import { slotTimeoutMs } from '../../config/model-slots.js';
import { getModelSlots } from '../../config/loader.js';
import { assistHopMs } from '../../config/assist-backend.js';
import { AUDIO_STEPS, VIDEO_STEPS } from './progress.js';
import { runSlotPool } from './slot-pool.js';
import { bytesPresent, isMissingPath, readStored, StoredFileUnreadable } from '../stored-bytes.js';

let running = false;
/** Bumped by every start, so a pool left over from a stop that raced this start sees it is no longer the current one and winds down. */
let generation = 0;
/** The pool's `drained`: start awaits the previous one, so a stop-then-start never runs two pools at once. */
let poolDrained: Promise<void> = Promise.resolve();
/** The two repeating jobs of a started worker: constant labels, because a job's label is the `job` label of its skipped-tick counter. */
const STALL_SWEEP_JOB = 'Media stall sweep';
const PROVIDER_REFRESH_JOB = 'Media provider refresh';
let stalledSweepJob: IntervalJob | null = null;
let providerRefreshJob: IntervalJob | null = null;

/** How often the provider-refresh timer re-reads config to pick up a hot change. */
const PROVIDER_REFRESH_MS = 2_000;

/** Start the media embedding worker loop. Idempotent — safe to call multiple times. */
/**
 * The budgets that bound ONE step of a job — the things the stall detector must not fire inside.
 *
 * Named individually rather than "every number in the config": `maxPages` and `concurrency` are not durations,
 * and `workerPollIntervalMs` bounds the loop rather than a step. A wrong entry here would raise the stall
 * floor for no reason and make recovery slower than it needs to be.
 */
function hopBudgets(): Record<string, number | undefined> {
  const doc = getDocumentProcessingConfig();
  // Read the same three fields `buildProviders` reads, and default them the same way — a hop budget derived
  // from a different reading of the config than the one that built the providers is worse than no budget.
  const media = getMediaEmbeddingConfig();
  const visionType = media.visionProvider ?? 'local';
  const sttType = media.sttProvider ?? 'local';
  const fallback = media.fallbackToExternal ?? false;
  const hasAssistFallback = !!doc.assistModel?.fallback?.baseUrl?.trim();
  /*
   * Resolved through the same function the call sites use, never from the constants they used to carry.
   *
   * Fed a constant while an operator's configured value is larger, the floor would keep protecting the
   * DEFAULT — and a call longer than the stall timeout is re-queued mid-flight, abandons its work, and reaches
   * the same call again. That is the loop this whole list exists to prevent, re-armed by the control meant to
   * help. Asserted by `a-model-slot-timeout-is-settable.test.js`.
   */
  const cfg = getModelSlots();
  // Named `*Ms` because `stall-floor.test.js` requires every fed value to name a millisecond quantity — a hop
  // list whose entries could be counts or flags is how a non-duration once raised the floor for no reason.
  const slots = {
    visionMs: slotTimeoutMs('vision', cfg),
    sttMs: slotTimeoutMs('stt', cfg),
    faceExternalTimeoutMs: slotTimeoutMs('faceExternal', cfg),
    /*
     * The four document slots, and they became hops the day their budgets started applying.
     *
     * Until then every document model call was bounded by `pageTimeoutMs`, which is fed below, so the floor
     * covered them by covering it. A slot budget now WINS over the page limit — that is the whole point of
     * the fix — so an operator raising `modelSlots.docVlm.timeoutMs` to ten minutes against a one-minute
     * page limit would have a hop the detector never saw, and the job would be re-queued in the middle of a
     * call it was allowed to make. That is exactly the loop this list exists to prevent, arriving through a
     * new door.
     *
     * `slotTimeoutMs` and not `slotTimeoutMsOr`: the floor must protect the LARGER of the two, and the page
     * limit is fed separately below. Resolving with the page limit as a default here would report the page
     * limit twice and the slot budget never, whenever the operator had set neither.
     */
    docVlmMs: slotTimeoutMs('docVlm', cfg),
    docRepairMs: slotTimeoutMs('docRepair', cfg),
    docVerifyMs: slotTimeoutMs('docVerify', cfg),
    // One assist step can try the primary and then the fallback, so it costs both legs when a fallback is set (F-33).
    assistMs: assistHopMs(slotTimeoutMs('assist', cfg), hasAssistFallback),
  };
  return {
    pageTimeoutMs: doc.pageTimeoutMs,
    ocrTimeoutMs: doc.ocrTimeoutMs,
    describeTimeoutMs: assistHopMs(doc.describeTimeoutMs, hasAssistFallback),
    // The longest step of all, and it was missing — because it is not a config KEY. The render of a page
    // window is `pageTimeoutMs x min(maxPages, 20)`, which at the defaults is 1 200 000 ms against a
    // 300 000 ms stall timeout: four times over, with nothing configured. A list of names could not contain a
    // derived value, so the value now has a name (`render-budget.ts`) that both the call site and this list
    // use. `renderWindowMs` rather than a config key on purpose: it is what the detector must not fire inside.
    renderWindowMs: worstRenderWindowMs(doc),
    // One ffmpeg step, bounded by the one wrapper that starts it (`files/media/ffmpeg.ts`). It is here for the same
    // reason `renderWindowMs` is: a step the detector can fire inside is a job re-queued in the middle of work it was
    // allowed to do, which reaches the same step again.
    ffmpegStepMs: FFMPEG_STEP_TIMEOUT_MS,
    /*
     * The media provider calls, as CHAINS rather than as legs.
     *
     * These were listed as four separate budgets, and `effectiveStallTimeoutMs` takes the maximum of what it
     * is given — but `fallbackToExternal` makes one hop call the primary and then the fallback with nothing
     * beating in between, so the real cost is the SUM. With fallback on, STT was 600 000 ms of hop against a
     * 450 000 ms floor: the re-queue loop this list exists to prevent, out of reach of the list's own shape.
     *
     * STT's two legs are the same number because `ExternalWhisperProvider` extends `WhisperProvider` and
     * inherits its budget — passed twice deliberately rather than doubled here, so that if the external leg
     * ever gets its own constant this keeps saying what it means.
     */
    visionHopMs: providerHopMs(slots.visionMs, slots.visionMs, visionType, fallback),
    sttHopMs: providerHopMs(slots.sttMs, slots.sttMs, sttType, fallback),
    // No chain: `allowInProcessFallback` falls back to in-process detection rather than to a second HTTP
    // call, so nothing is added to the budget of the call itself.
    faceTimeoutMs: slots.faceExternalTimeoutMs,
  };
}

export function startMediaEmbeddingWorker(): void {
  if (running) return;
  running = true;
  log.info('Media embedding worker: started');
  void workerLoop();
}

/** Stop the worker loop gracefully (jobs already running finish; nothing new is claimed). */
/** Claims this process currently holds. Small by construction: bounded by `workerConcurrency`. */
type HeldJob = { spaceId: string; jobId: string; claimToken?: string | null };
const _heldJobs = new Set<HeldJob>();

/**
 * Hand back every claim this process holds, for a PLANNED shutdown.
 *
 * Awaited by the shutdown path before the database connection closes. Each release is guarded on the claim
 * token, so a job that has already been recovered and re-claimed elsewhere is left alone.
 */
export async function releaseHeldJobs(): Promise<number> {
  const held = [..._heldJobs];
  if (held.length === 0) return 0;
  const results = await Promise.all(
    held.map(h => releaseClaimedJob(h.spaceId, h.jobId, h.claimToken)),
  );
  const released = results.filter(Boolean).length;
  if (released > 0) {
    log.info(`Media embedding worker: handed back ${released} claim(s) on shutdown — they are pending again, `
      + `so the next boot starts them immediately instead of waiting out stalledJobTimeoutMs.`);
  }
  return released;
}

export function stopMediaEmbeddingWorker(): void {
  running = false;
  stalledSweepJob?.stop();
  stalledSweepJob = null;
  providerRefreshJob?.stop();
  providerRefreshJob = null;
  // The idle wait is interruptible, so wake it: otherwise a worker parked on a 30s backoff
  // would keep the process alive for up to that long after a stop request.
  wakeWorkers();
  log.info('Media embedding worker: stop requested');
}

// ── Internal ──────────────────────────────────────────────────────────────

/**
 * Signature of the provider-relevant config. Providers are rebuilt only when this
 * changes, so hot-reloading does not churn provider clients on every tick.
 */
export function providerSignature(cfg: ReturnType<typeof getMediaEmbeddingConfig>): string {
  return JSON.stringify([
    cfg.visionProvider ?? 'local',
    cfg.sttProvider ?? 'local',
    cfg.fallbackToExternal ?? false,
    cfg.vision ?? {},
    cfg.stt ?? {},
  ]);
}

// Provider bundle the worker is CURRENTLY running, plus the signature it was built
// from. Hoisted to module scope so the provider-refresh timer can rebuild them even
// while the job loop is blocked on a slow job — a hung provider call must never
// freeze config hot-reload.
let activeProviders: MediaProviderBundle | null = null;
let activeProviderSig = '';

function buildProviders(cfg: ReturnType<typeof getMediaEmbeddingConfig>): MediaProviderBundle {
  return createMediaProviders(
    cfg.vision ?? {},
    cfg.stt ?? {},
    cfg.visionProvider ?? 'local',
    cfg.sttProvider ?? 'local',
    cfg.fallbackToExternal ?? false,
  );
}

/**
 * Re-read the media config and rebuild the provider bundle if the provider-relevant
 * config changed. Cheap (an in-memory config read + a rebuild only on real change),
 * so it is safe to call on a short timer. Runs independently of the job loop.
 */
function refreshProviders(): void {
  const cfg = getMediaEmbeddingConfig();
  const sig = providerSignature(cfg);
  if (activeProviders && sig === activeProviderSig) return;
  const firstBuild = activeProviders === null;
  activeProviders = buildProviders(cfg);
  activeProviderSig = sig;
  if (!firstBuild) log.info('Media worker: provider config changed — providers reloaded');
}

/**
 * The provider signature the worker is actually running right now. Compare it
 * against `providerSignature(getMediaEmbeddingConfig())` to tell whether a saved
 * config change has been picked up yet — the refresh timer applies it on its own,
 * with no restart, even while a slow job is in flight.
 */
export function getActiveProviderSignature(): string {
  return activeProviderSig;
}

async function workerLoop(): Promise<void> {
  const myGeneration = ++generation;
  // A stop that has not finished draining leaves its pool running its last jobs: wait for it, so two pools never claim at once.
  await poolDrained;
  if (!running || generation !== myGeneration) return;
  const startupCfg = getMediaEmbeddingConfig();
  // Floored by the longest single hop a job may take: a step longer than the stall timeout reports no
  // progress while it runs, so the job would be re-queued mid-step and reach the same step again forever.
  //
  // It DOES bind at the defaults, and the earlier claim here that it never did was measured against config
  // keys only. The render of a page window is `pageTimeoutMs x min(maxPages, 20)` = 1 200 000 ms out of the
  // box, four times the 300 000 ms stall timeout, so the floor now raises to 1 800 000 ms on a stock install.
  // An operator raising a hop still binds too — ocrTimeoutMs alone goes to thirty minutes.
  const startupStalledTimeoutMs = stallTimeoutWithWarning(
    startupCfg.stalledJobTimeoutMs ?? 300_000,
    hopBudgets(),
  );

  // On startup: reset any stalled jobs (crash recovery)
  // The walk isolates a space that fails and quarantines one that hangs (`resetStalledJobs`), so this does not throw for a space.
  const spaceIds = concreteSpaceIds();
  if (spaceIds.length > 0) {
    await resetStalledJobs(spaceIds, startupStalledTimeoutMs).catch(err =>
      log.warn(`Media worker: stalled job reset error: ${err instanceof Error ? err.message : String(err)}`),
    );
  }

  // Schedule periodic stalled-job sweep so a pod crash mid-job is recovered
  // even when the worker loop is otherwise idle (no new uploads). Interval is
  // half the stall timeout so a job is recovered within ~1.5× the timeout.
  // The sweep re-reads the timeout each fire so a config change is honoured; the
  // interval itself is fixed at startup (changing it would mean re-arming the timer).
  const sweepIntervalMs = Math.max(30_000, Math.floor(startupStalledTimeoutMs / 2));
  stalledSweepJob = intervalJob(STALL_SWEEP_JOB, sweepIntervalMs, async () => {
    if (!running) return;
    const ids = concreteSpaceIds();
    if (ids.length === 0) return;
    // Re-read AND re-floored on every fire: the hop budgets are hot-reloadable too, so a raised OCR timeout
    // must move the stall floor without a restart.
    const stalledTimeoutMs = stallTimeoutWithWarning(
      getMediaEmbeddingConfig().stalledJobTimeoutMs ?? 300_000,
      hopBudgets(),
    );
    await resetStalledJobs(ids, stalledTimeoutMs);
  });
  stalledSweepJob.start();

  // Build the initial provider bundle, then keep it fresh on a dedicated timer.
  // A6: this is what makes provider config hot-reload without a restart. The timer
  // runs independently of the job loop below, so a config change is picked up even
  // while a slow job holds the loop (see the file header).
  refreshProviders();
  providerRefreshJob = intervalJob(PROVIDER_REFRESH_JOB, PROVIDER_REFRESH_MS, () => {
    if (!running) return;
    refreshProviders();
  });
  providerRefreshJob.start();

  // A claim this process holds, recorded the instant the pool's claim resolves (`onClaimed`) and dropped when the
  // job is done or handed back. A planned shutdown hands back whatever is still here. Looked up by job object so
  // `run` and `release` remove exactly what `onClaimed` added.
  const heldOf = new WeakMap<MediaJobDoc, HeldJob>();
  const dropHeld = (job: MediaJobDoc): void => {
    const held = heldOf.get(job);
    if (held) _heldJobs.delete(held);
  };

  // `Q-114`: one supervisor refills a slot the moment it frees, instead of claiming a batch and awaiting all of
  // it (a half-hour document conversion used to idle the other slot for its whole duration). `limits` is a
  // function the pool calls on every pass, so `workerConcurrency` and the poll intervals stay hot-reloadable.
  poolDrained = runSlotPool({
    limits: () => {
      const mediaCfg = getMediaEmbeddingConfig();
      return {
        concurrency: mediaCfg.workerConcurrency ?? 2,
        pollMs: mediaCfg.workerPollIntervalMs ?? 1_000,
        maxPollMs: mediaCfg.workerMaxPollIntervalMs ?? 30_000,
      };
    },
    // Re-read the space list on each claim (handles dynamic space creation/removal). No spaces is an empty
    // claim, which the pool answers with its idle backoff.
    claim: (): Promise<MediaJobDoc | null> => {
      const activeSpaceIds = concreteSpaceIds();
      return activeSpaceIds.length === 0 ? Promise.resolve(null) : claimNextJob(activeSpaceIds);
    },
    onClaimError: err => log.warn(`Media worker: claim error: ${err instanceof Error ? err.message : String(err)}`),
    // Track what this process holds, so a planned shutdown can hand the claims back instead of leaving them to
    // time out. Synchronous with the claim: the pool calls this with nothing in between.
    onClaimed: job => {
      const held = { spaceId: job.spaceId, jobId: String(job._id), claimToken: job.claimToken };
      heldOf.set(job, held);
      _heldJobs.add(held);
    },
    run: job => {
      // Snapshot the provider bundle when the job STARTS: it always runs against ONE stable provider set for its
      // whole duration, a config change mid-job can never swap it out from under it. Never null: refreshProviders()
      // ran before the pool started and the timer only ever replaces it.
      const jobProviders = activeProviders ?? buildProviders(getMediaEmbeddingConfig());
      // Removed in a `finally` per job: a leaked entry would make shutdown try to release a job that has already
      // completed, which the token guard would refuse anyway, but noisily.
      return processJob(job, jobProviders).finally(() => dropHeld(job));
    },
    // A claim that resolved after stop: pending again now, rather than after a stall timeout.
    release: job => {
      return releaseClaimedJob(job.spaceId, String(job._id), job.claimToken).finally(() => dropHeld(job));
    },
    sampleEpoch: currentWorkEpoch,
    waitForWork,
    isRunning: () => running && generation === myGeneration,
  }).drained;
  await poolDrained;
}

async function processJob(
  job: MediaJobDoc,
  providers: { vision: import('./providers.js').VisionProvider; stt: import('./providers.js').SttProvider },
): Promise<void> {
  const { spaceId, filePath, mediaType, _id: fileId, attempts, maxAttempts } = job;
  // Re-derive rather than trusting the stored value. Jobs queued before the enqueue path learned to
  // read the extension carry `application/octet-stream`, and those rows outlive the upgrade that
  // fixes the enqueue — an instance upgrading with a backlog would otherwise keep reproducing the
  // original failure (external vision 500s, Whisper filename rejects) on every retry, forever.
  // Self-healing on read, per the migration rule for state that replicates: no boot migration needed.
  const mimeType = mimeTypeForPath(filePath, job.mimeType);
  const endTimer = mediaJobDurationSeconds.startTimer({ media_type: mediaType });

  // The claim this run holds. Every heartbeat carries it, and the answer says whether the claim is still
  // ours: stall recovery clears the token, so a job recovered while this run was still working reports
  // `false` on the next beat. `leaseLost` is what the long phases poll to stop early — without it a
  // recovered job runs twice, both runs writing the same chunk ids and competing for the same CPU.
  let leaseLost = false;
  const claim: JobClaim = { jobId: String(fileId), claimToken: job.claimToken };
  const heartbeat = (p?: StepProgress): void => {
    void touchJobProgress(spaceId, String(fileId), p, job.claimToken).then(stillOurs => {
      if (!stillOurs) leaseLost = true;
    });
  };

  try {
    // Load file bytes from disk
    const absolutePath = resolveFilePath(spaceId, filePath);
    let fileBytes: Buffer;
    try {
      // Through the file door: with a master secret the bytes on disk are ciphertext (F-43).
      fileBytes = await readStored(absolutePath);
    } catch (err) {
      // Present but undecodable — a foreign key, altered bytes, or no secret for an encrypted file. Rethrown as it
      // is, so the failure path below can see it is TERMINAL: no retry reads different bytes.
      if (err instanceof StoredFileUnreadable) throw err;
      if (isMissingPath(err)) {
        // The source file is gone — it was deleted after this job was queued. Retrying can
        // never succeed, so this is TERMINAL, not a failure: reconcile to disk truth by
        // dropping the job and any orphaned metadata/artifacts, and stop (no retry, no
        // "exhausted retries" churn — that infinite loop is exactly what this avoids).
        await reconcileDeletedSource(spaceId, claim);
        log.info(`Media worker: source file ${spaceId}/${fileId} no longer exists — removed job and orphaned metadata (no retry)`);
        return;
      }
      throw new Error(`Could not read file for embedding: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Mark file as "processing" in file meta
    await setFileProcessingState(spaceId, fileId, { embeddingStatus: 'processing' })
      .catch(() => {}); // non-fatal — job tracking is the source of truth

    // Run the appropriate embedder
    let derivedDescription: string | undefined;
    // What produced `derivedDescription`, and the document's own opening prose when there is one. Both are
    // written to the parent record: "generated" is a claim about provenance, and the extractive text is
    // what keeps a phrase remembered FROM the document able to find the parent.
    let derivedSource: 'generated' | 'extracted' | undefined;
    let derivedExcerpt: string | undefined;
    // Final file embeddingStatus for a job that completes without retrying. Text
    // conversion may embed some chunks and fail others; a partial result is recorded
    // as 'partial' (not 'complete') so it stays visible and retry-eligible (B3).
    let fileEmbeddingStatus: 'complete' | 'partial' = 'complete';
    switch (mediaType) {
      case 'image':
        derivedDescription = await embedImage(spaceId, fileId, fileBytes, mimeType, providers.vision, { arrival: job.arrival === true });
        // A caption IS model output, so the record says so. It was the reference point for the whole
        // complaint — the images carried generated captions while the parent carried a truncation — and it
        // had no provenance of its own either.
        if (derivedDescription) derivedSource = 'generated';
        break;
      case 'audio': {
        // A chunk that failed to transcribe makes this PARTIAL, never complete. The count used to be
        // discarded here, so an operator saw success over audio that was never transcribed — the
        // document path has modelled this correctly all along and audio simply never carried the number.
        const a = await embedAudio(spaceId, fileId, fileBytes, mimeType, providers.stt, undefined,
          { onProgress: heartbeat, shouldStop: () => leaseLost, steps: AUDIO_STEPS });
        if (a.failed > 0) {
          fileEmbeddingStatus = 'partial';
          log.warn(`Media worker: ${a.failed}/${a.total} audio chunks failed for ${spaceId}/${fileId} — recording partial`);
        }
        break;
      }
      case 'video': {
        // Honour the video level: `audio` takes the audio pipeline only (no vision model); `full`/`auto`
        // add keyframe captioning. Previously keyframes always ran, so the `audio` level did nothing.
        const doKeyframes = videoDoesKeyframes(effectiveVideoLevel(spaceId));
        // Same rule as audio: a video whose spoken content partly failed to transcribe is not complete,
        // however good its keyframe captions are.
        const v = await embedVideo(spaceId, fileId, fileBytes, mimeType, providers.vision, providers.stt, doKeyframes,
          undefined, undefined, { onProgress: heartbeat, shouldStop: () => leaseLost, steps: VIDEO_STEPS });
        if (v.audioFailed > 0) {
          fileEmbeddingStatus = 'partial';
          log.warn(`Media worker: ${v.audioFailed}/${v.audioTotal} audio chunks failed for ${spaceId}/${fileId} — recording partial`);
        }
        break;
      }
      case 'text': {
        // Text/document embedding: chunk + embed the file content asynchronously.
        // Delete any stale chunks first so a re-upload always produces a clean set.
        await deleteConversionArtifacts(spaceId, fileId);
        const resolvedFmt = (job.resolvedFormat ?? 'text') as ResolvedFormat;
        // F11-c: a per-space extraction-mode override wins over the instance-wide default (pipeline
        // falls back to `documentProcessing.mode` when this is undefined).
        const spaceMode = effectiveDocExtractionMode(spaceId);
        // Documents governs how the file is READ; text governs what happens to the text that
        // comes out of it. Two ladders, two decisions, one job.
        const spaceTextLevel = effectiveTextLevel(spaceId);
        // Advance the stall heartbeat as each page lands. Without this the timeout measures wall
        // clock from the claim, so a long document is indistinguishable from a wedged one: it gets
        // requeued mid-flight, re-claimed, and killed again at the same page — forever.
        const { chunks, convertedMarkdown, extractedImages } = await runConversionPipeline(
          fileBytes, filePath, resolvedFmt,
          {
            mode: spaceMode,
            textLevel: spaceTextLevel,
            onProgress: heartbeat,
          },
        );
        if (chunks.length > 0 || extractedImages.length > 0) {
          const { chunkCount, convertedFileId, embedFailures } = await storeConversionResults(
            spaceId, filePath, chunks, convertedMarkdown, extractedImages,
            // Embedding is the longest phase and reported nothing, so a document with more than
            // `stalledJobTimeoutMs` of chunks in it was recovered mid-flight every time. `claim` fences the
            // commit itself: a claim a move took away while this ran leaves nothing written under the old path.
            { claim, onProgress: heartbeat, shouldStop: () => leaseLost },
          );
          const processed: FileProcessingState = { chunkCount };
          if (convertedFileId) processed.convertedFileId = convertedFileId;
          // Give the PARENT record a summary, through the SAME path images already use.
          //
          // Reported: after a PDF converts, its filemeta carries `convertedFileId`, `chunkCount` and
          // `embeddingStatus` — and no description, with `matchedText` being literally the filename.
          // Meanwhile every `_extracted/.../image-N.jpg` child gets a full generated caption. So the
          // record a human actually browses was findable only by its filename while its derived
          // children carried summaries.
          //
          // The mechanism was already here: `derivedDescription` is written to the parent below, only
          // when the operator has not written one, and re-embedded so it is searchable. Images set it;
          // documents never did. This is the same "the rule exists one branch over" shape as the audio
          // `partial` status.
          //
          // It was EXTRACTIVE — the head of the converted text — while the release note called it
          // generated, and on an invoice the head of the text is a payment reference cut mid-identifier.
          // `describeDocument` asks the model that already reads these files what the file IS, keeps the
          // document's own opening prose as the excerpt either way, and reports which one it produced.
          // One beat before the describe pass: it is a single model call with its own timeout, so the stall
          // clock should start when the phase does rather than partway through the one before it.
          heartbeat({ step: 'describe', steps: ['describe'] });
          const described = await describeDocument(convertedMarkdown, chunks);
          derivedDescription = described.text;
          derivedSource = described.source;
          derivedExcerpt = described.excerpt;
          // `describeDocument` above is a MODEL CALL with its own timeout, and this write is the only place
          // its output lands. Swallowing the failure silently meant the call was made and paid for, the
          // description was gone, and the job went on to report success — a file with no description and
          // nothing anywhere saying why, indistinguishable from "there was nothing to describe".
          //
          // Still not a throw: failing the job would retry a document whose analysis already succeeded and
          // re-pay for the model. What was missing is that the loss be VISIBLE.
          await setFileProcessingState(spaceId, fileId, processed).catch((err: unknown) => {
            log.warn(`Media worker: ${spaceId}/${fileId} described but the metadata write failed — the `
              + `description, excerpt and source from this run are lost and will not be recomputed: ${err}`);
          });

          // Embedding outcome drives the job result (B3): a total failure throws so
          // the existing failJob → backoff → retry path handles a transient embedder
          // outage; a partial failure is recorded but not retried (the embedded chunks
          // are useful and a retry re-embeds everything).
          if (chunkCount > 0 && embedFailures === chunkCount) {
            throw new Error(`All ${chunkCount} chunk(s) failed to embed`);
          }
          if (embedFailures > 0) {
            fileEmbeddingStatus = 'partial';
            log.warn(`Media worker: ${spaceId}/${fileId} embedded with ${embedFailures}/${chunkCount} chunk failure(s) — marked partial`);
          }
        }
        break;
      }
      default:
        throw new Error(`Unknown mediaType: ${String(mediaType)}`);
    }

    // The source can be deleted while the embedder runs, and the embedder's own writes (the chunk records a text
    // conversion inserts at the end) then land AFTER the delete removed the file's metadata, as orphans. Checked
    // after those writes and not before, so either the delete's removal of the blob comes first and this
    // reconciles, or it comes after and the delete's own metadata cleanup follows it. Asked of `bytesPresent`, which
    // throws a failure to look: read as "deleted", a permission refused here removed what this job wrote (preship-4 P4-5).
    if (!(await bytesPresent(absolutePath))) {
      await reconcileDeletedSource(spaceId, claim);
      log.info(`Media worker: source file ${spaceId}/${fileId} was deleted during its job — removed what the job wrote`);
      return;
    }

    // Write the derived description to the parent file meta if the user has not set one.
    // This also re-embeds the parent file meta so the description is searchable on the file itself.
    if (derivedDescription || derivedExcerpt) {
      // The excerpt goes in even when a person has written their own description: it is the document's own
      // text, not a competing summary, and it is what makes a remembered phrase find this record. Only the
      // description itself is theirs to keep.
      if (derivedExcerpt) {
        // Through the one writer of a derived field, which asks whether the file is still here: the excerpt is
        // derived from bytes a delete may have removed while the conversion ran.
        await setDerivedExcerpt(spaceId, filePath, derivedExcerpt).catch(err =>
          log.warn(`Media worker: failed to write excerpt to file meta ${spaceId}/${fileId}: ${err instanceof Error ? err.message : String(err)}`),
        );
      }
      // The description is a CONDITIONAL write, decided by the database in one operation.
      //
      // This used to read the stored description, compute `operatorWrote`, and then write on that decision. The intent
      // was right and the implementation could not deliver it: a read-modify-write loses to anything that lands in
      // between, so an operator PATCH issued while the worker was mid-flight was silently replaced by the derived text.
      // Nothing reported it — no field missing, no status wrong, the description simply somebody else's. Same shape as
      // the 2.5.1 defect that computed a vector from the record as the write had read it.
      if (derivedDescription) {
        await setDerivedDescriptionIfUnset(spaceId, filePath, derivedDescription, derivedSource).catch(err =>
          log.warn(`Media worker: failed to write description to file meta ${spaceId}/${fileId}: ${err instanceof Error ? err.message : String(err)}`),
        );
      }
    }

    await completeJob(spaceId, fileId, fileEmbeddingStatus);
    mediaJobsCompletedTotal.labels({ space: spaceId, media_type: mediaType }).inc();
    log.info(`Media worker: completed ${mediaType} job ${spaceId}/${fileId} (${fileEmbeddingStatus})`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // A lost lease is not a failed job. Stall recovery has already put this file back in the queue with an
    // attempt spent, and another claimant is on it: calling failJob here would spend a SECOND attempt and
    // write a `lastError` describing nothing that went wrong, and calling completeJob would report a
    // re-queued job as done. So this run simply stops, and says why at WARN so the pair is visible.
    //
    // Recovery is not the only thing that takes a claim: moving or deleting the file does too, and so does a
    // re-upload. The message names all of them, because naming only recovery sent the reader of a move's
    // abandonment looking for a slow job that never existed.
    //
    // A space being deleted or renamed away is the same outcome, and says so: its file door refused the write
    // (`spaces/space-write-gate.ts`), so the run stops before it adds anything under a tree being removed.
    if (isAbandonment(err) && !isLeaseLost(err)) {
      log.info(`Media worker: abandoning ${spaceId}/${fileId} — ${message}. Nothing more is written for it.`);
      return;
    }
    if (isAbandonment(err)) {
      log.warn(`Media worker: abandoning ${spaceId}/${fileId} — its claim was taken while it was still running,`
        + ` and nothing it produced was written. Either the file was moved, deleted or re-uploaded (the job, if`
        + ` any, now belongs to wherever the file went), or stall recovery re-queued it because it was slower`
        + ` than stalledJobTimeoutMs — in that case see the re-queue warning above for how long it was silent.`);
      mediaJobsRetriedTotal.labels({ space: spaceId, media_type: mediaType }).inc();
      return;
    }
    log.warn(`Media worker: job ${spaceId}/${fileId} failed: ${message}`);
    // An oversized document will never shrink — fail permanently instead of
    // burning the retry budget re-reading a file the pipeline refuses to convert.
    // A stored file that cannot be decoded is the same: retrying reads the same bytes under the same key (F-43).
    const unreadable = err instanceof StoredFileUnreadable;
    const permanent = unreadable || (err instanceof ConversionUnavailableError && err.reason === 'too_large');
    if (permanent) {
      // This write is what stops the file looking like work in progress. `mediaJobsFailedTotal` below is
      // incremented either way, so swallowing a failure here left the METRIC saying "permanently failed"
      // while the RECORD said `processing` for ever — a dashboard and a file page disagreeing, with the
      // dashboard right and nothing to reconcile them.
      //
      // Logged rather than thrown for the same reason as the describe write: the job is already failing
      // permanently, and rethrowing would replace an honest terminal state with a retry loop.
      // `failed` for an unreadable file, not `skipped`: nothing was declined, the bytes could not be read.
      await setFileProcessingState(spaceId, fileId, { embeddingStatus: unreadable ? 'failed' : 'skipped' }).catch((err: unknown) => {
        log.warn(`Media worker: ${spaceId}/${fileId} failed permanently but its status could not be written `
          + `— the record will read 'processing' while the failure counter has already moved: ${err}`);
      });
    }
    if (permanent || attempts >= maxAttempts) {
      mediaJobsFailedTotal.labels({ space: spaceId, media_type: mediaType }).inc();
    } else {
      mediaJobsRetriedTotal.labels({ space: spaceId, media_type: mediaType }).inc();
    }
    await failJob(spaceId, fileId, permanent ? maxAttempts : attempts, maxAttempts, message).catch(innerErr =>
      log.warn(`Media worker: failJob error: ${innerErr instanceof Error ? innerErr.message : String(innerErr)}`),
    );
  } finally {
    endTimer();
  }
}

/**
 * Reconcile a media job whose source file has been deleted: remove the job, its
 * orphaned file-meta record, and any conversion artifacts (chunks / converted /
 * extracted). Disk is the source of truth for the file store, so a job pointing at
 * a file that no longer exists is stale and must be cleaned up, not retried.
 * Best-effort throughout — each step swallows its own error.
 *
 * Only while this run still holds its claim, and otherwise it throws `JobLeaseLostError` and touches nothing. A file
 * gone from its path is not always a deleted file: a MOVE takes the claim first and then carries the file, its
 * job and its derived records to the new path. Reconciling "the deleted source" in that window deleted the very job
 * and records the move was about to carry — the moved file arrived with no job and nothing ever processed it.
 */
async function reconcileDeletedSource(spaceId: string, claim: JobClaim): Promise<void> {
  if (!(await holdsClaim(spaceId, claim))) throw new JobLeaseLostError(spaceId, claim.jobId);
  // The job, the artefacts, the cached hash and the record — honouring softDeleteFileMeta (flag the orphan for audit, or
  // remove it) — by the one list of what a file leaves; each step swallows its own failure, there being nothing to retry with.
  await removeFileHere(spaceId, claim.jobId, { failure: 'swallow' });
}


/** Resolve the absolute file path on disk for a given space + relative path. */
function resolveFilePath(spaceId: string, filePath: string): string {
  const base = spaceRoot(spaceId);
  // Prevent path traversal: only forward-slash paths, no `..` segments
  const safe = toSafeRelPath(filePath);
  return path.join(base, safe);
}
