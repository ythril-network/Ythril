/**
 * The embed queue's two job counters, declared on the registry's `Registry` (`ythril_embed_jobs_failed_total` and `ythril_embed_jobs_handed_back_total`).
 *
 * ## What it prevents
 *
 * `registry.ts` is frozen by the size ratchet (`no-new-god-files`), so a counter added to it is a line it may not grow by; the two counters of one concern live
 * here, beside the `*-count.ts` leaves the queue counts through, and the registry holds one call. The registry imports this module, so this module cannot import
 * the registry back (`no-runtime-import-cycles`): the registry hands its `Registry` in and re-exports what comes back, so every caller keeps importing
 * the counters from `./registry.js`. Names, labels and help texts are what dashboards and alert rules read (`docs/integration-guide/11-setup-api.md`).
 *
 * ## The two series, and why both
 *
 * - `ythril_embed_jobs_failed_total{reason}`: embed jobs left `failed`, by why (`brain/embed-queue.ts`: ONE helper writes the status, so no writer can drop the
 *   count, and counts through `embed-job-failed-count.ts`, which the queue can import where it cannot import the registry): `refused_413` (the embedder answered
 *   payload-too-large), `over_ceiling` (a stored passage is larger than the embedder accepts and needs its file re-converted), `budget` (the attempts ran
 *   out), `lost_child` (the inference process was lost too often).
 * - `ythril_embed_jobs_handed_back_total`: attempts handed back to a job that waits instead of spending one (counted through `embed-job-handed-back-count.ts`):
 *   the embedder could not be reached, answered a status of the wait set (408, 429, 502, 503, 504, 520 to 524, 529, 530), or the inference process was lost. A waiting job is not `failed`, so this is the series an outage
 *   shows on, where the first does not move.
 */
import { Counter, type Registry } from 'prom-client';
import { setEmbedJobFailedSink, EMBED_JOB_FAILED_REASONS } from './embed-job-failed-count.js';
import { setEmbedJobHandedBackSink } from './embed-job-handed-back-count.js';

/**
 * Declares the two counters on `register`, gives the queue's leaves their sinks and pre-declares every series at zero.
 *
 * Called once, by the registry. A second call on the same registry would register the names twice and throw.
 */
export function declareEmbedJobMetrics(register: Registry) {
  const embedJobsFailedCounter = new Counter({
    name: 'ythril_embed_jobs_failed_total',
    help: 'Embed jobs left failed, by reason (refused_413, over_ceiling, budget, lost_child)',
    labelNames: ['reason'] as const,
    registers: [register],
  });
  setEmbedJobFailedSink(reason => embedJobsFailedCounter.labels({ reason }).inc());
  for (const reason of EMBED_JOB_FAILED_REASONS) embedJobsFailedCounter.labels({ reason }).inc(0);

  const embedJobsHandedBackCounter = new Counter({
    name: 'ythril_embed_jobs_handed_back_total',
    help: 'Attempts handed back to embed jobs that wait (embedder unreachable, an HTTP status that means busy or not available, an inference process lost)',
    registers: [register],
  });
  setEmbedJobHandedBackSink(() => embedJobsHandedBackCounter.inc());
  embedJobsHandedBackCounter.inc(0);

  return { embedJobsFailedCounter, embedJobsHandedBackCounter };
}
