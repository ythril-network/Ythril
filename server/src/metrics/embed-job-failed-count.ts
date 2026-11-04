/**
 * Count an embed job left `failed` without importing the metrics registry.
 *
 * ## The question it answers
 *
 * "How does the embed queue say that a job ended `failed`, and why, when the registry reaches the queue?" The registry imports the
 * modules that import `brain/embed-queue.ts`, so the queue cannot import the registry (`no-runtime-import-cycles`); the registry gives
 * this leaf a sink when it loads, as `metrics/version-raise-count.ts` does for the version counter, and a count made before then (a
 * unit test that never loads the registry) is dropped, as no scrape would have read it. The counter is `ythril_embed_jobs_failed_total`.
 */
import { countSink } from './count-sink.js';

/** Why a job was left `failed`: `refused_413` (the embedder said the payload is too large), `over_ceiling` (a stored passage larger than the embedder accepts), `budget` (the attempts ran out), `lost_child` (the inference process was lost too often). */
export type EmbedJobFailedReason = 'refused_413' | 'over_ceiling' | 'budget' | 'lost_child';

/** The reasons, so the registry pre-declares one series for each. */
export const EMBED_JOB_FAILED_REASONS: readonly EmbedJobFailedReason[] = ['refused_413', 'over_ceiling', 'budget', 'lost_child'];

const failed = countSink<[reason: EmbedJobFailedReason]>();

/** Called once by the registry, at load. */
export const setEmbedJobFailedSink = failed.set;

/** `ythril_embed_jobs_failed_total`, as the queue counts it: one job left `failed`, under its reason. */
export const embedJobsFailedTotal = { count: failed.count };
