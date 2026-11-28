/**
 * Observe how long an embed job waited before its first claim, without importing the metrics registry (Q-182).
 *
 * ## The question it answers
 *
 * "How does the embed queue say how long a job waited, and in which lane, when the registry reaches the queue?" The registry imports the
 * modules that import `brain/embed-queue.ts`, so the queue cannot import the registry (`no-runtime-import-cycles`); the registry gives this
 * leaf a sink when it loads, as it does for `embed-job-failed-count.ts`, and an observation made before then (a unit test that never loads
 * the registry) is dropped, as no scrape would have read it. The histogram is `ythril_embed_job_claim_age_seconds{lane}`.
 *
 * The lane names live here, the one list both the queue (which observes) and the registry's embed-job slice (which declares the series and
 * counts `ythril_embed_jobs{lane,status}`) read, so a lane cannot be named two ways.
 */
import { countSink } from './count-sink.js';

/** The queue's lanes by priority (`EMBED_PRIORITY`: write 0, background 1, rebuild 2): the index is the priority. */
export const EMBED_LANE_NAMES = ['write', 'background', 'rebuild'] as const;
export type EmbedLaneName = typeof EMBED_LANE_NAMES[number];

/**
 * The statuses an embed job stands in, the one list the queue's count, the jobs page's filter and the `ythril_embed_jobs` gauge read, so a
 * status cannot be listed three ways (the page, the queue and the metric each held a copy before).
 */
export const EMBED_JOB_STATUSES = ['pending', 'processing', 'failed'] as const;
export type EmbedJobStatus = typeof EMBED_JOB_STATUSES[number];

/**
 * The lane a job's stored priority is claimed in. A job with no priority, or one outside the lanes, is claimed as `write` (the claim's
 * `laneMatch` takes a missing priority in the write lane), so no series is ever labelled `undefined`.
 */
export function embedLaneOf(priority: unknown): EmbedLaneName {
  return (typeof priority === 'number' && EMBED_LANE_NAMES[priority]) || 'write';
}

const observed = countSink<[lane: EmbedLaneName, seconds: number]>();

/** Called once by the registry's embed-job slice, at load. */
export const setEmbedClaimAgeSink = observed.set;

/** `ythril_embed_job_claim_age_seconds`, as the queue observes it: one first claim, its lane and how long it waited. */
export const embedClaimAge = { observe: observed.add };
