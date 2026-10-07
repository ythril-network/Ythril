/**
 * The ONE-TIME back-fill of `deliveredBy` on records stored before the stamp existed (bundle-51 plan §1, D-14 = C).
 *
 * ## What it answers
 *
 * *"A record already here carries no stamp of who delivered it: whose is it?"* The upstream deletion ground
 * (`sync/deletion-authority.ts`) stands on the stored stamp alone. Every record written after this release has one, by its
 * writer; the rows from before have none, and judging them by a second live rule ("no stamp, so look at the networks")
 * would be a rule that changes under them whenever the network does. So each space is stamped ONCE, here, by the one
 * question `backfillStamp` answers — the upstream's id where the upstream was the only way a record could have reached the
 * space, `''` (nobody's) otherwise — and from then on the stamp is the only rule.
 *
 * ## Why it runs where it does
 *
 * Lazily, in the sync cycle, per member and space, BEFORE that space's tombstone pull: a tombstone applied before its
 * target is stamped is declined, and the repair (`sync/tombstone-reread.ts`) would then be owed for a deletion the first
 * pull could have made. The stamp is a LOCAL field (never hashed, never served), so this is a migration of local state, which
 * the repo's rule allows to be eager; it is lazy because the answer depends on the networks, which only a running instance
 * knows, and because a space nobody syncs has nobody to hand the power to.
 *
 * ## What it prevents
 *
 *  - **A second pass.** The marker (`SpaceConfig.deliveredByBackfilled`) is set when a space has been stamped and never
 *    again cleared. A query-defined pass ("stamp whatever is unstamped") would, from the second cycle on, stamp what a LOCAL
 *    write created without one — and a stamp decided today for a row written tomorrow is the live rule this exists to avoid.
 *    A row that arrives unstamped after the marker is simply not stamped.
 *  - **A per-row decision.** The answer depends on the space and on the row's author alone, so it is asked once per distinct
 *    author and applied as one `updateMany`, and everything else gets `''` in one more: a handful of commands per collection,
 *    whatever the row count.
 *  - **A stamp the upstream did not earn.** Every doubt resolves to `''` inside `backfillStamp` (a mesh or club network that
 *    carries the space, an unlisted peer token that reaches it, this instance's own record, an author-less one): a stamp given to
 *    a row the upstream never sent hands it the power to delete data it never relayed, which is one row more than D-14 accepted.
 *
 * Residual, stated: a record an admin pushed or restored into such a space BEFORE this release, authored by someone else, is
 * stamped as the upstream's — nothing stored says it came any other way.
 *
 * A failure is the space's: `eachSpace` bounds every operation, reports a failure once per window through the shared reporter
 * and goes on, and the marker is set only when every collection was stamped, so the next cycle finishes what this one did not.
 */
import { col, asFilter, asUpdate } from '../db/mongo.js';
import { spaceCollection } from '../db/space-collection.js';
import { getConfig, saveConfig } from '../config/loader.js';
import { BRAIN_COLLECTIONS } from '../config/types.js';
import { eachSpace, eachUnit } from '../util/housekeeping-walk.js';
import { log, peerText } from '../util/log.js';
import { backfillStamp } from './deletion-authority.js';

const STEP = 'sync deliveredBy back-fill';

/** Rows with no stamp at all — `''` counts as a stamp: it is somebody's answer (nobody's), and never revisited. */
const UNSTAMPED = { deliveredBy: { $exists: false } } as const;

/** Stamp every unstamped row of one collection: per distinct author where the answer is the upstream's, the rest `''`. */
async function stampCollection(spaceId: string, part: (typeof BRAIN_COLLECTIONS)[number]): Promise<number> {
  const coll = col<{ _id: string }>(spaceCollection(spaceId, part));
  const cfg = getConfig();
  const selfId = cfg.instanceId;
  let stamped = 0;
  const authors = (await coll.distinct('author.instanceId', asFilter<{ _id: string }>({ ...UNSTAMPED })) as unknown[])
    .filter((a): a is string => typeof a === 'string' && a !== '');
  for (const author of authors) {
    const stamp = backfillStamp(cfg, spaceId, { author: { instanceId: author } }, selfId);
    if (stamp === '') continue;
    const r = await coll.updateMany(
      asFilter<{ _id: string }>({ ...UNSTAMPED, 'author.instanceId': author }),
      asUpdate<{ _id: string }>({ $set: { deliveredBy: stamp } }));
    stamped += r.modifiedCount ?? 0;
  }
  // Everything the question did not hand to the upstream: this instance's own rows, author-less ones, and every row of a
  // space with more than one route.
  const rest = await coll.updateMany(asFilter<{ _id: string }>({ ...UNSTAMPED }), asUpdate<{ _id: string }>({ $set: { deliveredBy: '' } }));
  return stamped + (rest.modifiedCount ?? 0);
}

/**
 * Stamp the rows of `spaceId` that carry no `deliveredBy`, once. A space already marked, or not in the config, costs nothing
 * but the config read. Never throws: a failure is reported by the walk and the space is tried again next cycle.
 */
export async function stampDeliveriesOnce(spaceId: string): Promise<void> {
  if (getConfig().spaces.find(s => s.id === spaceId)?.deliveredByBackfilled === true) return;
  await eachSpace(STEP, [spaceId], async () => {
    let total = 0;
    const { failed } = await eachUnit([...BRAIN_COLLECTIONS], async (part) => { total += await stampCollection(spaceId, part); });
    if (failed.length > 0) return;   // a collection is still owed: the marker waits, and the next cycle finishes it
    // The live config, read after the awaits above: a copy taken before them can be a reload behind.
    const cfg = getConfig();
    const space = cfg.spaces.find(s => s.id === spaceId);
    if (!space) return;
    space.deliveredByBackfilled = true;
    saveConfig(cfg);
    if (total > 0) {
      log.info(`Stamped ${total} record(s) of space '${peerText(spaceId)}' with who delivered them (one time, after upgrading); `
        + 'a record written from now on carries its own stamp.');
    }
  });
}
