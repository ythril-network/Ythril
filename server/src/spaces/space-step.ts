/**
 * One space's step of a loop over the spaces — its failure is said once, naming the space, and does not end the loop.
 *
 * ## The failure this exists for
 *
 * Boot's init, the config reload's init, the legacy read-spill sweep and the embed queue's claim, stall-reset and revive each walked the
 * configured spaces with no `try` of their own. A throw from one space (a collection that cannot be read, an index that is rebuilding) left
 * the loop at that space, so every space AFTER it in the config was skipped — every cycle, for as long as the first one failed — and the
 * line that reported it named a driver error and not the space. The claim loop is the worker's: one bad space starved the embedding of all
 * the others.
 *
 * ## What a hand-written copy drops
 *
 * **The name.** A `catch` that logs the error says what failed and not WHERE; the space is what an operator acts on.
 *
 * **Once.** A loop that runs every poll or every five minutes says a space that stays broken at the rate of the loop. The line is said
 * once per window for each (step, space), and again when the space had succeeded in between — a condition that cleared is news when it
 * returns. A caller that wants every failure said (boot, a reload: they run rarely and the operator is waiting) passes `everyTime`.
 *
 * **The error itself.** The result carries it, so a caller that owes the space a retry (init) knows which failed and why without a
 * second `catch`.
 *
 * One question: *run this ONE space's step so its failure cannot escape*. It does not decide what a failure means for the loop — a store
 * that is not answering at all is the caller's to notice from `ok: false` for every space.
 */
import { log, peerText } from '../util/log.js';
import { storeFailureDetail } from '../brain/store-failure.js';
import { warnOnce } from '../util/warn-once.js';

/** How long a failure said for a (step, space) is not said again by a loop that keeps meeting it. */
export const SPACE_STEP_REPORT_WINDOW_MS = 10 * 60_000;

/** What a step returned, or the failure it was contained as. */
export type SpaceStepResult<T> = { ok: true; value: T } | { ok: false; error: unknown };

const reported = warnOnce<string>({ every: SPACE_STEP_REPORT_WINDOW_MS });

/**
 * Run `step` for `spaceId`. Never throws: a failure is logged (`<operation> failed for space '<id>': <detail>`) and returned as
 * `{ ok: false, error }`. `operation` is what the step was doing, as the operator will search for it (`'Embed claim'`).
 */
export async function runSpaceStep<T>(
  operation: string,
  spaceId: string,
  step: () => Promise<T>,
  { everyTime = false }: { everyTime?: boolean } = {},
): Promise<SpaceStepResult<T>> {
  const key = `${operation}\u0000${spaceId}`;
  try {
    const value = await step();
    reported.forget(key);
    return { ok: true, value };
  } catch (error) {
    const say = () => log.warn(`${peerText(operation)} failed for space '${peerText(spaceId)}': ${peerText(storeFailureDetail(error))}`);
    if (everyTime) say(); else reported(key, say);
    return { ok: false, error };
  }
}
