/**
 * Ensure every declared index exists on EVERY space, not only on newly created ones.
 *
 * ## Why this is a separate boot step
 *
 * `initSpace` creates a space's collections and indexes, and it runs for EVERY space at EVERY boot, before the server
 * listens (`index.ts`). It cannot be where a slow index is built: a compound over a collection of a million records,
 * awaited there, is a boot that does not finish. So an index added to it is cheap on the spaces it creates and, for
 * the ones an operator already has, either a boot-time cost nobody budgeted or a line that reaches the changelog
 * and not the database.
 *
 * So: a small, idempotent pass over every non-proxy space, started AFTER the server listens (`bootstrap.ts`).
 * `createIndex` is a no-op when the index is already there, which is what makes running this every boot cheap rather
 * than wasteful.
 *
 * ## What is in here: the whole declaration
 *
 * Every index of the per-space declaration (`spaces/space-indexes.ts`), boot-safe or not, one unit per index. The ones that are
 * not boot-safe are the reason the pass exists: the seq-keyset compounds (the sync pages, the push and the scanners read records in
 * `(seq, _id)` order; each collection's compound is built here for an existing space, with the bare `{ seq: 1 }` it replaces dropped
 * in the same unit once the compound is confirmed), the write guard (`Q-439`), and the TTL sweep's indexes. The first build of a
 * large space can take a while and the server is already serving; sync reads behave as before until each collection's compound
 * exists, and the log says when the first build starts and when each space's ends. The boot-safe ones are here too, so a space whose
 * collection came into being without them (a 4.x conversion's first insert creates a collection and no indexes) gets them, and so an
 * index that failed at `initSpace` is tried again.
 *
 * Proxy spaces are skipped: they own no collections.
 */
import { log, peerText } from '../util/log.js';
import { warnOnce } from '../util/warn-once.js';
import { type KeysetBuild } from './keyset-indexes.js';
import { SPACE_INDEXES, buildSpaceIndexUnits } from './space-indexes.js';
import { dropReplacedFileTombstoneIndexes, positionLegacyFileTombstones } from '../files/tombstones.js';
import { configuredSpaces } from './space-lookup.js';
import { eachSpace, eachUnit } from '../util/housekeeping-walk.js';
import { declareStep } from '../util/housekeeping-signals.js';

const QUERY_INDEXES_STEP = declareStep('query indexes');

/**
 * Create any missing index of the per-space declaration, for every space.
 *
 * Every declared index, each its own unit through the walk (`eachSpace`, `eachUnit`), whatever its policy: a failure on one index
 * is said with the space and the index named and the others are still built; a failure that is the whole space's (a store that
 * stopped answering, a space that stalls) ends that space's pass; one space's failure never stops the next or the boot. Beside the
 * builds, two steps that are not builds: the local position a file tombstone stored before positions existed lacks, and the drop of
 * the file tombstone index a later release replaced.
 *
 * Returns how many units were issued, so a caller can log it and a test can assert the loop ran rather than trusting that it did.
 * The builds themselves stay unbounded: an index build scales with the collection, so no one figure is right (`db/write-bound.ts`
 * states the exemption).
 */
export async function ensureQueryIndexes(): Promise<number> {
  let issued = 0;
  await eachSpace(QUERY_INDEXES_STEP, configuredSpaces(), async (space) => {   // pre-setup: none, so nothing to index yet
    const keyset: KeysetBuild[] = [];
    // The declaration's order: the keyset indexes first, because the sync readers wait for them and the others are cheap beside them.
    await buildSpaceIndexUnits(space.id, SPACE_INDEXES, {
      onKeysetBuild: announceFirstKeysetBuild,
      onBuilt: (_ix, k) => { issued++; if (k) keyset.push(k); },
    });
    const others: Array<{ name: string; run: () => Promise<unknown> }> = [
      // The local position a tombstone stored before positions existed lacks (bundle-51): the paged read and the push read it.
      { name: 'file tombstone positions', run: () => positionLegacyFileTombstones(space.id) },
      // The file tombstone index a later release replaced (bundle-71, Q-352), after the one that replaced it was built.
      { name: 'replaced file tombstone indexes', run: () => dropReplacedFileTombstoneIndexes(space.id) },
    ];
    await eachUnit(others, async (unit) => {
      await unit.run();
      issued++;
    }, unit => unit.name);
    // One line per space that had something to build or drop, never one per boot of a space that had nothing.
    const built = keyset.filter(k => k.built).length;
    const dropped = keyset.filter(k => k.droppedBare).length;
    if (built + dropped > 0) {
      log.info(`Sync keyset indexes for space '${peerText(space.id)}': ${built} built, ${dropped} bare seq index(es) dropped`);
    }
  }, { when: 'next boot' });
  return issued;
}

/** Said once per process, at the start of the first build: sync reads are unchanged until each collection's ends. */
const keysetBuildAnnouncement = warnOnce<'first build'>();
function announceFirstKeysetBuild(): void {
  keysetBuildAnnouncement('first build', () => log.info('Sync keyset indexes: building them in the background, collection by collection. '
    + 'Sync reads behave as before until each collection\'s build ends, and the bare seq index it replaces is dropped once its compound is confirmed.'));
}
