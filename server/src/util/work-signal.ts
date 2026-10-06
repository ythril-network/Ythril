/**
 * The wake-up and space-probing machinery a per-space job queue needs, with no job type in it.
 *
 * ## Why this is a module and not two copies
 *
 * `files/media/job-queue.ts` grew a careful answer to two problems that have nothing to do with media:
 *
 *  - **latency on an idle queue.** A worker that backs its poll off to 30 s is right for CPU and wrong
 *    for latency — work enqueued into an idle system waits up to the full interval before anything
 *    starts. The fix is an announcement that wakes the sleeper, plus an epoch counter to close the race
 *    where work arrives *between* a failed claim and the start of the sleep.
 *  - **the empty-queue walk.** Per-space collections mean claiming walks the spaces one
 *    `findOneAndUpdate` at a time. On an idle 100-space instance that is ~300 useless round trips per
 *    tick. A hint records which spaces might hold claimable work; a periodic full scan re-seeds it, which
 *    is what stops a job whose retry backoff has not yet elapsed from sitting unnoticed forever.
 *
 * Both are properties of "a queue with per-space collections and a sleeping worker". The brain embedding
 * queue is exactly that, and re-deriving forty lines of race-closing logic for it is how a codebase ends
 * up with two subtly different answers to one question — the same finding as `merge-fields.ts`.
 *
 * ## `claimAcross`: the whole find-first walk, owned here (`Q-274`, `Q-358`, bundle-53 G14)
 *
 * The walk used to be written twice, by hand, in each queue: take the probe, try each space, `noteClaimed` on a claim,
 * `noteEmpty` on an empty one. Each copy had no catch (a space whose claim threw, or hung, ended the claim for every space behind
 * it and with it the worker's loop) and each had to remember the two decisions that look like bookkeeping: a space leaves the
 * hint only when it answered empty in EVERY pass (a space holding only lane-2 work is empty in lane 0), and one that failed or
 * was passed over must not be noted at all. The walk is now `walkSpaces` (`util/housekeeping-walk.ts`) with `stopAfterFirst`
 * and the claim's bound, and what a hand-written copy would drop is inside:
 *
 *  - **the probe is taken once per claim**, then private to it. `spacesToProbe` CONSUMES the full-scan slot; taken per pass, the
 *    second pass would see only the hinted spaces and strand an unhinted lane-2 job until the next scan. It is not exported.
 *  - **one pass at a time across the spaces**, in the caller's pass order (embed: three lanes x two dues; media: one pass), so a
 *    write in the last space overtakes a reindex in the first.
 *  - **a failed space is isolated**, reported once per window through the reporter, and not asked again in this claim's later
 *    passes (six failed calls per claim would be six bounds).
 *  - **a hung space is quarantined** by the walk (60 s doubling to 300 s, any walk, a full scan included): a quarantined space is
 *    SKIPPED, which is neither "answered empty" nor a claim, so it keeps its hint. `markSpaceMayHaveWork` lifts it for one probe,
 *    because a write is what makes the space worth asking again.
 *  - **every operation carries `CLAIM_OP_MS`** (`db/write-bound.ts`), and an enclosing scope can only tighten it. A claim is one
 *    `findOneAndUpdate`, a plain write, which the SERVER ends first at the bound: a claim that the bound ended cannot land. What
 *    remains is a reply lost on the network after the claim landed, which burns an attempt on a job nobody holds; the stall reset
 *    returns it, as it returns a dead worker's.
 *  - **the store being down answers null**, with neither note called: the walk stops at the first space, says one line for the
 *    step, and a store that cannot answer says nothing about which spaces are empty.
 *
 * ## Why a factory rather than module-level state
 *
 * The media queue held `_workEpoch` and `_wakeWaiters` as module globals, which is correct while there
 * is one queue. With two, shared globals would mean a brain enqueue wakes the media worker: harmless
 * (it claims nothing and sleeps again) but it turns an idle instance into one that wakes on every write
 * and makes "why did this worker wake" unanswerable. Each queue gets its own signal.
 */

import { CLAIM_OP_MS } from '../db/write-bound.js';
import { walkSpaces, liftQuarantine, type HousekeepingWalk } from './housekeeping-walk.js';

/** How long a queue may go without re-probing every space, however quiet the hint says it is. */
export const DEFAULT_FULL_SCAN_INTERVAL_MS = 30_000;

/** When a failed claim is tried again, in the words of the reporter's line. */
const CLAIM_RETRY = 'next claim';

/** A monotonic clock, injectable so the tests do not sleep. Defaults to `Date.now`. */
export type NowFn = () => number;

export interface WorkSignal {
  /** Monotonic counter, bumped every time claimable work is announced. */
  currentEpoch(): number;
  /**
   * Sleep up to `ms`, returning early if work is announced. Resolves true if woken, false on timeout.
   *
   * `sinceEpoch` must be sampled BEFORE the caller's claim attempt — that is what makes the race
   * closed rather than merely unlikely.
   */
  wait(ms: number, sinceEpoch: number): Promise<boolean>;
  /** Wake every waiter. Used on announcement, and on shutdown so stopping is not delayed. */
  wake(): void;
  /**
   * Record that a space may have claimable work (enqueue, requeue-on-failure, stall reset). Also lifts the space's quarantine for
   * ONE probe: a write is what makes a space that hung worth asking again.
   */
  markSpaceMayHaveWork(spaceId: string): void;
  /**
   * Claim one job across `spaceIds`, or null. The WHOLE find-first walk (see the module docblock): the probe once, the caller's
   * `passes` one at a time across the probed spaces, `tryClaim(spaceId, pass)` isolated and bounded per space, `noteClaimed` on a
   * claim, `noteEmpty` only for a space that answered empty in every pass and threw in none, a quarantined space skipped and
   * noted neither way. Returns the first value `tryClaim` gives that is not null; null when nothing was claimed, when every space
   * failed, and when the store is not answering (neither note called). Never throws for a space's failure.
   *
   * `step` is a name declared once with `declareStep` (`util/housekeeping-signals.ts`): it labels the failure counters and lines.
   */
  claimAcross<P, R>(
    spaceIds: readonly string[], passes: readonly P[],
    tryClaim: (spaceId: string, pass: P) => Promise<R | null | undefined>, opts: { step: string },
  ): Promise<R | null>;
  /** A space that just yielded a job — keep probing it next time. */
  noteClaimed(spaceId: string): void;
  /** A space with nothing claimable right now. A future announcement or full scan puts it back. */
  noteEmpty(spaceId: string): void;
  /** Does the hint hold this space? Read only (it does not consume the full-scan slot): for tests and diagnostics. */
  isHinted(spaceId: string): boolean;
  /** Test seam: forget everything the hint knows, forcing the next claim to do a full scan. */
  reset(): void;
}

export function createWorkSignal(opts: {
  fullScanIntervalMs?: number;
  now?: NowFn;
  /** The walk runner the claims go through: the process-wide one, or a test's own (its clock, store question and reporter). */
  walk?: Pick<HousekeepingWalk, 'walkSpaces' | 'liftQuarantine'>;
} = {}): WorkSignal {
  const fullScanIntervalMs = opts.fullScanIntervalMs ?? DEFAULT_FULL_SCAN_INTERVAL_MS;
  const now = opts.now ?? Date.now;
  const walk = opts.walk ?? { walkSpaces, liftQuarantine };

  const pendingHint = new Set<string>();
  let lastFullScan = 0;
  let epoch = 0;
  let waiters: Array<() => void> = [];

  const wakeAll = (): void => {
    const current = waiters;
    waiters = [];
    for (const w of current) w();
  };

  /**
   * The spaces worth probing on this claim: every space when a full scan is due, otherwise only the hinted ones. CONSUMES the
   * full-scan slot, so `claimAcross` calls it exactly once per claim, and it is not part of the interface.
   */
  const spacesToProbe = (spaceIds: readonly string[]): string[] => {
    const due = now() - lastFullScan >= fullScanIntervalMs;
    if (due) {
      lastFullScan = now();
      return [...spaceIds];
    }
    return spaceIds.filter(s => pendingHint.has(s));
  };

  async function claimAcross<P, R>(
    spaceIds: readonly string[], passes: readonly P[],
    tryClaim: (spaceId: string, pass: P) => Promise<R | null | undefined>, { step }: { step: string },
  ): Promise<R | null> {
    // Before any early return: a claim over no passes still spends the slot, so the caller's cadence does not depend on its input.
    const probe = spacesToProbe(spaceIds);
    /** Spaces that answered empty, in how many passes. */
    const emptyIn = new Map<string, number>();
    /** Spaces that threw or were passed over in this claim: asked no more, noted neither way. */
    const unanswered = new Set<string>();

    for (const pass of passes) {
      const live = probe.filter(s => !unanswered.has(s));
      if (live.length === 0) break;
      const result = await walk.walkSpaces<string, R | null | undefined>(
        step, live, (spaceId) => tryClaim(spaceId, pass),
        { stopAfterFirst: (value) => value != null, opMs: CLAIM_OP_MS, when: CLAIM_RETRY },
      );
      // A store that does not answer says nothing about which spaces are empty, and a stalled one nothing about any.
      if (result.storeDown || result.stalled) return null;
      for (const outcome of result.outcomes) {
        if (outcome.status !== 'ok') { unanswered.add(outcome.spaceId); continue; }
        if (outcome.value != null) {
          pendingHint.add(outcome.spaceId);
          return outcome.value;
        }
        emptyIn.set(outcome.spaceId, (emptyIn.get(outcome.spaceId) ?? 0) + 1);
      }
    }
    for (const [spaceId, passesEmpty] of emptyIn) {
      if (passesEmpty === passes.length && !unanswered.has(spaceId)) pendingHint.delete(spaceId);
    }
    return null;
  }

  return {
    currentEpoch: () => epoch,

    wait(ms, sinceEpoch) {
      // Work already arrived while the caller was claiming — do not sleep at all.
      if (epoch !== sinceEpoch) return Promise.resolve(true);

      return new Promise<boolean>(resolve => {
        let settled = false;
        const finish = (woken: boolean) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          waiters = waiters.filter(w => w !== wake);
          resolve(woken);
        };
        const wake = () => finish(true);
        const timer = setTimeout(() => finish(false), ms);
        // Unref'd: a sleeping worker must never be the reason the process will not exit.
        if (typeof timer.unref === 'function') timer.unref();
        waiters.push(wake);
      });
    },

    wake: wakeAll,

    markSpaceMayHaveWork(spaceId) {
      pendingHint.add(spaceId);
      // A write is what makes a space that hung worth asking again: let ONE probe through its quarantine.
      walk.liftQuarantine(spaceId);
      epoch++;
      wakeAll();
    },

    claimAcross,
    noteClaimed(spaceId) { pendingHint.add(spaceId); },
    noteEmpty(spaceId) { pendingHint.delete(spaceId); },
    isHinted: (spaceId) => pendingHint.has(spaceId),

    reset() {
      pendingHint.clear();
      lastFullScan = 0;
    },
  };
}
