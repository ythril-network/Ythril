/**
 * Ensure the read-path indexes exist on EVERY space, not only on newly created ones.
 *
 * ## Why this is a separate boot step
 *
 * `initSpace` creates a space's collections and indexes, and `app.ts` calls it only for spaces that are **new to
 * the config** (`!oldSpaceIds.has(space.id)`). That is right for creation — but it means an index added to
 * `initSpace` in a release reaches new spaces and never touches the ones an operator already has. The
 * optimisation would land in the changelog and not in the database.
 *
 * So: a small, idempotent pass over every non-proxy space at boot. `createIndex` is a no-op when the index is
 * already there, which is what makes running this every boot cheap rather than wasteful. The TTL sweep's
 * `ensureSweepIndexes` established the pattern for exactly this reason.
 *
 * ## What is in here, and why only this
 *
 * `{ type: 1 }` on the four record collections. Measured with `explain()` against a live instance: a
 * `{type: …}` filter — which every list endpoint exposes and every `total` counts with — returned **COLLSCAN**
 * on facts, entities, edges and chrono. Entities look covered by `{ name: 1, type: 1 }` and are not: `type`
 * is not a prefix of that index, so it cannot serve a query on `type` alone.
 *
 * Quality-neutral by construction. The same documents come back, in the same order, with the same counts; only
 * the plan changes. Nothing here trades accuracy for speed, which is the whole point of putting it in this file
 * rather than in a tuning knob.
 *
 * Proxy spaces are skipped: they own no collections.
 */
import { col } from '../db/mongo.js';
import { COLLECTION_SUFFIX } from '../config/types-knowledge.js';
import { LINK_CLASSES } from '../brain/link-adjacency.js';
import { getConfig } from '../config/loader.js';
import { log } from '../util/log.js';

/**
 * The record collections a `type` filter reaches, with the index that filter needs.
 *
 * NOT ALL BRAIN COLLECTIONS, and two are missing for two different reasons. `files` has no `type` field —
 * a file's kind is its path and its media handling. `links` has no type field either, and cannot get one:
 * a link's kind IS its two endpoint kinds, which the unique index in `lifecycle.ts` already covers. A
 * `type` index on the links collection would index a field no link document has.
 */
// The four knowledge-type collections, from the map that defines them rather than written out again.
const TYPE_FILTERED = Object.values(COLLECTION_SUFFIX);

/**
 * The collections a LINK scan reads, with the field it reads — one entry per LINK CLASS, derived.
 *
 * `initSpace` creates these, and that only ever reaches a space NEW to the config — so an index added there
 * leaves every existing operator on the collection scan. That is the half this file exists for, and it is why
 * the two lists have to widen together: `entityIds` was created for facts alone, while
 * `linkedRecordsAtFrontier` reads it on all three, once per class per member space per hop.
 *
 * **It said three collections and one field, and a link is a (collection, FIELD) pair.** M-2 gave a chrono
 * entry `memoryIds` and a file `memoryIds` and `chronoIds` — three link classes whose scans had no index at
 * all, because the list named the collections while the field stayed written out as `entityIds`. Nothing
 * reported it: an unindexed scan returns the right answer, slowly, and only on a space large enough to
 * notice. Derived from `LINK_CLASSES` now, so a seventh class arrives with its index.
 */
const LINK_SCANNED: readonly { collection: string; field: string }[] =
  [...new Map(LINK_CLASSES.map(c => [`${c.collection}.${c.field}`, { collection: c.collection, field: c.field }]))
    .values()];

/**
 * Create any missing read-path index, for every space.
 *
 * Returns how many index calls were issued, so a caller can log it and a test can assert the loop ran rather
 * than trusting that it did. Best-effort per space: a failure on one must not stop the others or the boot.
 */
export async function ensureQueryIndexes(): Promise<number> {
  let cfg;
  try { cfg = getConfig(); } catch { return 0; }   // pre-setup: nothing to index yet

  let issued = 0;
  for (const space of cfg.spaces ?? []) {
    if (space.proxyFor?.length) continue;
    for (const name of TYPE_FILTERED) {
      try {
        await col(`${space.id}_${name}`).createIndex({ type: 1 });
        issued++;
      } catch (err) {
        log.warn(`ensureQueryIndexes: ${space.id}_${name} type index: ${err}`);
      }
    }
    for (const { collection, field } of LINK_SCANNED) {
      try {
        await col(`${space.id}_${collection}`).createIndex({ [field]: 1 });
        issued++;
      } catch (err) {
        log.warn(`ensureQueryIndexes: ${space.id}_${collection} ${field} index: ${err}`);
      }
    }
  }
  return issued;
}
