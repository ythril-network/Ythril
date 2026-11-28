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
 * The lane names are the queue's vocabulary (`brain/embed-job-names.ts`), the one list the queue (which observes) and the registry's
 * embed-job slice (which declares the series) read; this file only carries the sink.
 */
import { countSink } from './count-sink.js';
import type { EmbedLaneName } from '../brain/embed-job-names.js';

const observed = countSink<[lane: EmbedLaneName, seconds: number]>();

/** Called once by the registry's embed-job slice, at load. */
export const setEmbedClaimAgeSink = observed.set;

/** `ythril_embed_job_claim_age_seconds`, as the queue observes it: one first claim, its lane and how long it waited. */
export const embedClaimAge = { observe: observed.add };
