/**
 * The hourly sweep of abandoned upload chunks, as a job with a start and a stop.
 *
 * It used to be registered inside `index.ts`'s `main()`, beside the shutdown handler that stopped it. The handler moved to `shutdown.ts` so a test can
 * run the real sequence (bundle-39 D5), and a job kept in `main()` is a handle the sequence cannot reach: the stop is exported here like every other
 * job's, which is the shape `every-started-job-is-stopped-at-shutdown` holds. An interval job: one tick at a time, a throw contained and said once per
 * window as "Stale chunk cleanup failed: …", an unref'd timer so shutdown does not wait for it. A tick that starts during the drain walks the upload
 * directories of a closing instance, so `runShutdown` stops it before the drain.
 */
import { intervalJob } from '../util/interval-job.js';
import { cleanupStaleChunks } from './chunks.js';

const chunkCleanup = intervalJob('Stale chunk cleanup', 60 * 60 * 1000, () => cleanupStaleChunks());

export function startChunkCleanup(): void { chunkCleanup.start(); }

export function stopChunkCleanup(): void { chunkCleanup.stop(); }
