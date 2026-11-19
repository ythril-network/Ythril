/**
 * Count an attempt an embed job was handed back, without importing the metrics registry.
 *
 * ## The question it answers
 *
 * "How does the embed queue say that a job waited instead of spending an attempt, when the registry reaches the queue?" The registry imports the
 * modules that import `brain/embed-queue.ts`, so the queue cannot import the registry (`no-runtime-import-cycles`); the registry gives this leaf a sink
 * when it loads, as `metrics/embed-job-failed-count.ts` does for the failed-jobs counter, and a count made before then (a unit test that never loads
 * the registry) is dropped, as no scrape would have read it. The counter is `ythril_embed_jobs_handed_back_total`, without labels.
 *
 * ## What it prevents
 *
 * A job that waits is not `failed`, so an embedder that is down moves no failed-jobs series: the outage of 18 Nov 2026 was visible only as jobs ending
 * `failed`, and once an unreachable embedder costs a wait that signal is gone. This is the series an outage shows on, counted in the one place the
 * queue hands an attempt back.
 */
import { countSink } from './count-sink.js';

const handedBack = countSink<[]>();

/** Called once by the registry, at load. */
export const setEmbedJobHandedBackSink = handedBack.set;

/** `ythril_embed_jobs_handed_back_total`, as the queue counts it: one attempt handed back to a job that waits. */
export const embedJobsHandedBackTotal = { count: handedBack.add };
