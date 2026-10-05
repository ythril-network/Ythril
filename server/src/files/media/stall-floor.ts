/**
 * The stall timeout can never be shorter than the longest thing a job is allowed to do in one step.
 *
 * ## Measured, at the defaults
 *
 *     stalledJobTimeoutMs   300 000 ms
 *     pageTimeoutMs          60 000 ms   0.20x
 *     ocrTimeoutMs          120 000 ms   0.40x
 *     describeTimeoutMs      30 000 ms   0.10x
 *
 * Safe. The trap is what an operator may configure, from the admin PATCH schema:
 *
 *     pageTimeoutMs        1 000 …   600 000 ms   (2x the stall default)
 *     describeTimeoutMs    1 000 …   600 000 ms   (2x)
 *     ocrTimeoutMs        10 000 … 1 800 000 ms   (6x)
 *
 * ## Why exceeding it is not merely slow
 *
 * Each of those is **one call**, and a call reports no progress while it is in flight — the heartbeat fires
 * between steps, not inside one. So a hop longer than the stall timeout means the job is re-queued *while that
 * hop is still working*. Since #601 the original run then discovers its claim is gone and abandons; the
 * replacement starts the same document, reaches the same hop, and is re-queued at the same point. A loop that
 * never completes — precisely the "slow job killed and killed again at the same page" failure the per-page
 * heartbeat was introduced to end, reachable again through configuration.
 *
 * And reachable by following our own advice one step too far: the docs tell a swap-based host to raise
 * `describeTimeoutMs` to 60–180 s (safe), and tell large-scan operators to raise `ocrTimeoutMs` (whose ceiling
 * is thirty minutes).
 *
 * ## Why a floor rather than a rejected setting
 *
 * Rejecting the PATCH would block a legitimate two-step change (raise the stall timeout, then the hop) and
 * would not help an instance whose `config.json` was hand-edited. Silently clamping the HOP would override a
 * deliberate choice about how long a model may take. So the derived value moves instead: the stall detector
 * uses whichever is larger, and says so once. Nothing an operator set is contradicted — the detector simply
 * stops firing inside a step it authorised.
 */
import { log, peerText } from '../../util/log.js';

/**
 * Head-room over the longest hop. A stall timeout equal to the hop budget would fire in the same instant the
 * hop legitimately gives up, making the two indistinguishable in the log.
 */
export const STALL_FLOOR_FACTOR = 1.5;

export interface StallFloor {
  /** What the stall detector should use. */
  ms: number;
  /** Set when the floor raised the configured value — the reason, ready for a log line. */
  raised?: { from: number; hop: string; hopMs: number };
}

/**
 * The stall timeout to actually use, given the configured hops.
 *
 * Pure and total: it takes numbers and returns a number, so the rule can be tested without a config, a
 * database or a worker.
 */
export function effectiveStallTimeoutMs(
  configuredMs: number,
  hops: Record<string, number | undefined>,
): StallFloor {
  let worst: { hop: string; hopMs: number } | null = null;
  for (const [hop, hopMs] of Object.entries(hops)) {
    if (typeof hopMs !== 'number' || !Number.isFinite(hopMs) || hopMs <= 0) continue;
    if (!worst || hopMs > worst.hopMs) worst = { hop, hopMs };
  }
  if (!worst) return { ms: configuredMs };

  const floor = Math.ceil(worst.hopMs * STALL_FLOOR_FACTOR);
  if (floor <= configuredMs) return { ms: configuredMs };
  return { ms: floor, raised: { from: configuredMs, hop: worst.hop, hopMs: worst.hopMs } };
}

/** Remembers what has been warned about, so a sweep every 30 s does not print the same line forever. */
let _lastWarned = '';

/** The effective timeout, warning at most once per distinct combination. */
export function stallTimeoutWithWarning(
  configuredMs: number,
  hops: Record<string, number | undefined>,
): number {
  const { ms, raised } = effectiveStallTimeoutMs(configuredMs, hops);
  if (raised) {
    const key = `${raised.from}:${raised.hop}:${raised.hopMs}:${ms}`;
    if (key !== _lastWarned) {
      _lastWarned = key;
      log.warn(`Stall detection: using ${ms} ms instead of the configured ${raised.from} ms, because `
        + `${peerText(raised.hop)} allows a single step of ${raised.hopMs} ms. A step longer than the stall timeout `
        + `reports no progress while it runs, so the job would be re-queued mid-step, abandon its work, and `
        + `reach the same step again — a loop that never finishes. Raise stalledJobTimeoutMs above `
        + `${Math.ceil(raised.hopMs * STALL_FLOOR_FACTOR)} ms to silence this.`);
    }
  }
  return ms;
}

/** Test hook: forget what has been warned about. */
export function _resetStallWarningForTests(): void {
  _lastWarned = '';
}
