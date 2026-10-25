/**
 * The owed job of the edge identity swap: every space still on the FULL unique edge identity index gets the partial one, retried every tick until it stands
 * (Q-624, design rev 4 section 5.4, D1).
 *
 * ## What it prevents
 *
 * A space built before the partial identity index holds the full one, which counts a fork edge as a duplicate of its subject. Until the swap lands the space
 * cannot store a fork edge, and its edges family waits (`503 edge_identity_building` on a push, a held transfer on a pull: `sync/accept-page.ts`). A swap tried once
 * at boot and never again would leave a space waiting for ever after one failed build, with nothing to say so. So the build is a job: every tick it asks each
 * space whether it admits forks (read from `listIndexes`, never remembered), sets `ythril_edge_identity_building_spaces` to how many do not, and builds for
 * those one after another. A failure is said through the shared reporter (unit `edge identity`) and tried again on the next tick; the full index stands
 * until the partial one is confirmed, so a failing build never leaves a space without a unique identity.
 *
 * ## What it does not do
 *
 * It never holds a space and never gives up: no time limit turns the hold into a drop, because a drop would lose one side of a conflict. The hold is the
 * edges family's alone, and it lasts as long as the build does, which is one tick in the normal case. The background index pass (`ensureQueryIndexes`)
 * does not build this index: one owner.
 *
 * It is an `intervalJob` (single flight, bounded, budgeted, a contained throw) started in `bootstrap.ts` and stopped before the drain in `index.ts`.
 */
import { intervalJob } from '../util/interval-job.js';
import { walkSpaces, eachSpace, eachUnit } from '../util/housekeeping-walk.js';
import { declareStep } from '../util/housekeeping-signals.js';
import { log, peerText } from '../util/log.js';
import { edgeIdentityBuildingSpaces } from '../metrics/registry.js';
import { configuredSpaces } from './space-lookup.js';
import { edgeIdentityState } from './edge-identity-index.js';
import { swapEdgeIdentity } from './space-indexes.js';

/** How often the job looks: a swap that failed is retried this often. */
export const EDGE_IDENTITY_OWED_INTERVAL_MS = 60_000;

const CHECK_STEP = declareStep('Edge identity check');
const BUILD_STEP = declareStep('Edge identity');

/**
 * One tick, to its end: ask every space, set the gauge to the count that does not admit forks yet, then build for those one at a time. Awaited by the tests,
 * which run a tick rather than wait for one. The gauge is what the tick FOUND, so the tick that builds reports the spaces it built for and the next reports 0.
 */
export async function runEdgeIdentityOwedTick(): Promise<void> {
  const walk = await walkSpaces(CHECK_STEP, configuredSpaces(), async (space) => {
    const state = await edgeIdentityState(space.id);
    return !(state.partial && !state.full);
  }, { when: 'next tick' });
  const owed = walk.outcomes.filter(o => o.status === 'ok' && o.value === true).map(o => o.spaceId);
  edgeIdentityBuildingSpaces.set(owed.length);
  if (owed.length === 0) return;
  // The builds are outside the walk's bound (an index build scales with the collection: no one figure is right), but each is its own space and its own unit.
  await eachSpace(BUILD_STEP, owed, async (spaceId) => {
    await eachUnit(['edge identity'], async () => {
      await swapEdgeIdentity(spaceId);
      log.info(`Space '${peerText(spaceId)}': the edge identity index is the partial one now; fork edges are stored.`);
    }, (unit) => unit);
  }, { when: 'next tick' });
}

const edgeIdentityOwedJob = intervalJob('Edge identity owed', EDGE_IDENTITY_OWED_INTERVAL_MS, () => runEdgeIdentityOwedTick());

/** Start the job (idempotent). Phase 2 of the boot, beside the positions owed job. */
export function startEdgeIdentityOwedJob(): void {
  if (edgeIdentityOwedJob.armed) return;
  edgeIdentityOwedJob.start();
  log.debug('Edge identity owed job started');
}

/** Stop the job: before the drain, so no tick starts over a closing connection. */
export function stopEdgeIdentityOwedJob(): void {
  edgeIdentityOwedJob.stop();
}
