/**
 * The two counters of a media job that waits for an unavailable embedder (`files/media/job-queue.ts:handBackJob`, `files/media/embedder-outage-gate.ts`).
 *
 * ## What it prevents
 *
 * A media job whose run was cut short by, or met throughout, an unavailable embedder is handed back without spending an attempt, so `ythril_media_jobs_failed_total` does not
 * move during an outage, and the hand-back counter stops rising as soon as the media worker's pause holds the queue (nothing is claimed while it runs). An
 * operator with only those two would see a quiet queue and no reason. `ythril_media_embedder_probes_total{outcome="unavailable"}` keeps rising once per pause
 * step for as long as the outage lasts, which is the series to alert on; the hand-back counter says how many runs met it.
 *
 * ## Why it imports the registry
 *
 * `registry.ts` is held at its size by the ratchet and does not import this module (nothing it collects at scrape time reads a hand-back), so importing
 * `register` from it forms no cycle, as `schema-convert-metrics.ts` does. It is loaded with the media worker, which every configured start loads.
 *
 * Names, labels and help texts are what dashboards and alert rules read (`docs/integration-guide/11-setup-api.md`).
 */
import { Counter } from 'prom-client';
import { register } from './registry.js';

/** Runs of a media job handed back because the run was cut short by, or met throughout, an unavailable embedder, by space and media type (the labels of the media job counters). */
export const mediaJobsHandedBackTotal = new Counter({
  name: 'ythril_media_jobs_handed_back_total',
  help: 'Media job runs handed back without spending an attempt because the run was cut short by, or met throughout, an unavailable embedder, by space and media type',
  labelNames: ['space', 'media_type'] as const,
  registers: [register],
});
mediaJobsHandedBackTotal.labels({ space: '', media_type: 'text' }).inc(0);

/** What a probe of the embedder found, the one list: `answered` (no proven outage: the pause ends), `unavailable` (a proven outage: the next pause starts). */
export const MEDIA_EMBEDDER_PROBE_OUTCOMES = ['answered', 'unavailable'] as const;
export type MediaEmbedderProbeOutcome = (typeof MEDIA_EMBEDDER_PROBE_OUTCOMES)[number];

/** Probes the media worker made of the embedder after a hand-back, by outcome. */
export const mediaEmbedderProbesTotal = new Counter({
  name: 'ythril_media_embedder_probes_total',
  help: 'Probes of the embedder the media worker made before claiming after an outage, by outcome (answered, unavailable)',
  labelNames: ['outcome'] as const,
  registers: [register],
});
for (const outcome of MEDIA_EMBEDDER_PROBE_OUTCOMES) mediaEmbedderProbesTotal.labels({ outcome }).inc(0);
