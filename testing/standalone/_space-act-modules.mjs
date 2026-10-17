/**
 * Which of PR A's modules this build has, and "the acts have all ended": the two questions a test of an act in the middle of a transfer asks before
 * it can say anything about the act (bundle-106).
 *
 * ## The question each answers, and what a hand-written copy drops
 *
 * - {@link loadRunnerIfBuilt} / {@link loadFenceIfBuilt} - *"is the design's runner (or fence) in this build"*. A test whose rule must be observable
 *   on a build WITHOUT them (a wipe that starts mid-transfer is red on the base for its data, not for a missing import) asks this and degrades;
 *   a test whose rule IS the module uses {@link requireRunner} / {@link requireFence}, which fail with the rule's name instead of a stack. The guard a
 *   hand-written `try { await import(...) } catch { return null }` drops is the DISCRIMINATION: it swallows every failure, so a runner that is built
 *   and throws while loading reads as "not built" and every row quietly runs its base-build half. Only `ERR_MODULE_NOT_FOUND` for THAT module is
 *   an absence.
 * - {@link settleActs} - *"nothing the cycle or the act started is still running"*: the door's counter writes have landed and the runner, when there
 *   is one, is idle. An assertion made before it holds is about a moment the work had not reached (design section 6.1 v5, TS-6).
 */
import { untilRunnerIdle } from './_space-act-harness.mjs';
import { loadModuleIfBuilt } from './_round-open-fixtures.mjs';

export { requireRunner, requireFence } from './_round-open-fixtures.mjs';

export const loadRunnerIfBuilt = () => loadModuleIfBuilt('../../server/dist/spaces/space-act-runner.js');
export const loadFenceIfBuilt = () => loadModuleIfBuilt('../../server/dist/sync/space-transfer-fence.js');

/** Everything a cycle or an act started has ended: the door's counter writes landed, and the runner (when built) is idle. */
export async function settleActs(door, loader) {
  await door.settled();
  const runner = await loadRunnerIfBuilt();
  if (runner) await untilRunnerIdle(runner, loader);
}
