/**
 * The embed queue's metrics, declared on the registry's `Registry`: its two job counters (`ythril_embed_jobs_failed_total` and
 * `ythril_embed_jobs_handed_back_total`), its size by lane (`ythril_embed_jobs{lane,status}`) and the wait before a job's first claim
 * (`ythril_embed_job_claim_age_seconds{lane}`).
 *
 * ## What it prevents
 *
 * `registry.ts` is frozen by the size ratchet (`no-new-god-files`), so a metric added to it is a line it may not grow by; the metrics of one concern live
 * here, beside the `*-count.ts` leaves the queue counts through, and the registry holds one call. The registry imports this module, so this module cannot import
 * the registry back (`no-runtime-import-cycles`): the registry hands its `Registry`, its per-space collect helpers and the queue's lane count in, and re-exports
 * what comes back, so every caller keeps importing the counters from `./registry.js`. Names, labels and help texts are what dashboards and alert rules read
 * (`docs/integration-guide/11-setup-api.md`).
 *
 * ## The series, and why each
 *
 * - `ythril_embed_jobs_failed_total{reason}`: embed jobs left `failed`, by why (`brain/embed-queue.ts`: ONE helper writes the status, so no writer can drop the
 *   count, and counts through `embed-job-failed-count.ts`, which the queue can import where it cannot import the registry): `refused_413` (the embedder answered
 *   payload-too-large), `over_ceiling` (a stored passage is larger than the embedder accepts and needs its file re-converted), `budget` (the attempts ran
 *   out), `lost_child` (the inference process was lost too often).
 * - `ythril_embed_jobs_handed_back_total`: attempts handed back to a job that waits instead of spending one (counted through `embed-job-handed-back-count.ts`):
 *   the embedder could not be reached, answered a status of the wait set (408, 429, 502, 503, 504, 520 to 524, 529, 530), or the inference process was lost. A waiting job is not `failed`, so this is the series an outage
 *   shows on, where the first does not move.
 * - `ythril_embed_jobs{lane,status}` (Q-182): the jobs standing in each lane (`write`, `background`, `rebuild`) by status, summed over the spaces at scrape
 *   time from the queue's one count (`countEmbedJobsByLane`). It answers whether writes wait behind a reindex, so it is labelled by lane, not by space. A
 *   sum that left out a space that failed to read would read as a drained queue, so when any space failed the series are REMOVED for that scrape (absent:
 *   a dashboard shows a gap, and `absent()` can alert); the next scrape that reads every space sets all of them again.
 * - `ythril_embed_job_claim_age_seconds{lane}` (Q-182): how long a job waited before its first claim since its budget was granted (an insert, a rewrite, a
 *   revive or a retry), observed by the queue through `embed-claim-age.ts`. A retry after a hand-back is not a first claim and is not observed.
 */
import { Counter, Gauge, Histogram, type Registry } from 'prom-client';
import { setEmbedJobFailedSink, EMBED_JOB_FAILED_REASONS } from './embed-job-failed-count.js';
import { setEmbedJobHandedBackSink } from './embed-job-handed-back-count.js';
import { setEmbedClaimAgeSink } from './embed-claim-age.js';
import { EMBED_LANE_NAMES, EMBED_JOB_STATUSES, type EmbedLaneCounts } from '../brain/embed-job-names.js';
import { configuredSpaces } from '../spaces/space-lookup.js';

/** Seconds from 50 ms to an hour: a write claimed at once, a backfill that waits minutes, a reindex that waits behind writes for an hour. */
const CLAIM_AGE_BUCKETS = [0.05, 0.25, 1, 5, 15, 60, 300, 900, 3600];

/** What the registry hands in: its budget and per-space walk (`registry.ts`), and the queue's one count of a space's jobs by lane. */
export interface EmbedJobCollect {
  withCollectBudget(collector: string, work: () => Promise<void>, abandon: () => void): Promise<void>;
  collectEachSpace(collector: string, read: (spaceId: string) => Promise<void>, spaces?: ReadonlyArray<{ id: string }>): Promise<void>;
  countByLane(spaceId: string): Promise<EmbedLaneCounts>;
}

/**
 * Declares the embed queue's metrics on `register`, gives the queue's leaves their sinks and pre-declares every series at zero.
 *
 * Called once, by the registry. A second call on the same registry would register the names twice and throw.
 */
export function declareEmbedJobMetrics(register: Registry, collect: EmbedJobCollect) {
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

  const embedJobs = new Gauge({
    name: 'ythril_embed_jobs',
    help: 'Embed jobs by lane (write, background, rebuild) and status (pending, processing, failed), summed over spaces at scrape time; absent for a scrape in which a space could not be read',
    labelNames: ['lane', 'status'] as const,
    registers: [register],
    async collect() {
      await collect.withCollectBudget('embed_jobs', async () => {
        const spaces = configuredSpaces();
        const read = new Map<string, EmbedLaneCounts>();
        await collect.collectEachSpace('embed_jobs', async (id) => { read.set(id, await collect.countByLane(id)); }, spaces);
        // Every space read, or no series at all: a sum without a space reads as that space's queue drained.
        if (spaces.some(({ id }) => !read.has(id))) { this.reset(); return; }
        for (const lane of EMBED_LANE_NAMES) {
          for (const status of EMBED_JOB_STATUSES) {
            let n = 0;
            for (const counts of read.values()) n += counts[lane][status];
            this.set({ lane, status }, n);
          }
        }
      }, () => this.reset());
    },
  });

  const embedJobClaimAge = new Histogram({
    name: 'ythril_embed_job_claim_age_seconds',
    help: 'Seconds an embed job waited before its first claim since its attempt budget was granted (queued, rewritten, revived or retried), by lane',
    labelNames: ['lane'] as const,
    buckets: CLAIM_AGE_BUCKETS,
    registers: [register],
  });
  setEmbedClaimAgeSink((lane, seconds) => embedJobClaimAge.labels({ lane }).observe(seconds));
  for (const lane of EMBED_LANE_NAMES) embedJobClaimAge.zero({ lane });

  return { embedJobsFailedCounter, embedJobsHandedBackCounter, embedJobs, embedJobClaimAge };
}
