/**
 * The recurring sweep that ends the personal views of an owner with no live token for 30 days (Q-531).
 *
 * A token expires lazily (it simply stops authenticating) and a connector's cap eviction removes the token without deleting its views, so
 * nothing else ever notices that a view's owner is gone. The sweep (`sweepOwnerlessViews`) is the one place that does, after
 * `VIEW_OWNER_GRACE_MS`: a connector that re-consents under the same client id gets its views back. Daily is plenty for a 30-day grace.
 */
import { intervalJob } from '../util/interval-job.js';
import { sweepOwnerlessViews } from './views.js';

const SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;

const sweepJob = intervalJob('Personal view sweep', SWEEP_INTERVAL_MS, async () => { await sweepOwnerlessViews(); });

/** Start the sweep (always on: it only deletes what its grace rule says is orphaned). */
export function startViewSweep(): void {
  if (sweepJob.armed) return;
  sweepJob.start();
}

export function stopViewSweep(): void {
  sweepJob.stop();
}
