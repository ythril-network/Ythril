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
import { LINK_INDEXES } from '../brain/link-adjacency.js';
import { FORK_INDEXES } from '../sync/upsert-plan.js';
import { ensureFileTombstoneIndexes } from '../files/tombstones.js';
import { spaceCollection } from '../db/space-collection.js';
import { concreteSpaces } from './proxy.js';
import { eachSpace, eachUnit } from '../util/housekeeping-walk.js';
import { declareStep } from '../util/housekeeping-signals.js';

const QUERY_INDEXES_STEP = declareStep('query indexes');

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

/*
 * THE LINK INDEXES ARE ON THE LINKS COLLECTION, and this is the half that only bites an UPGRADED space.
 *
 * `initSpace` creates them with the collection, and it only ever reaches a space new to the config. A
 * space that came from 4.x got its links collection from the conversion's first insert — which creates a
 * collection and no indexes — so the spaces with the most links to read are exactly the ones that would
 * have none. Same set as `initSpace` asks for, from `LINK_INDEXES`, because two lists of indexes drift in
 * the direction nothing reports.
 *
 * It replaced a list of (collection, FIELD) pairs, one per link class, which is what a link scan read
 * while the arrays existed. The lesson is worth keeping: that list once said three collections and ONE
 * field, so three of the six classes had no index at all and nothing reported it. An unindexed scan
 * returns the right answer, slowly, and only on a space large enough to notice.
 */

/**
 * Create any missing read-path index, for every space.
 *
 * Returns how many index calls were issued, so a caller can log it and a test can assert the loop ran rather
 * than trusting that it did. Best-effort per space AND per index, through the walk (`eachSpace`, `eachUnit`): a failure on one
 * index is reported with the index named and the others are still created, a failure that is the whole space's (a store that
 * stopped answering, a space that stalls) ends that space's pass, and one space's failure never stops the next or the boot.
 * The `createIndex` calls themselves stay unbounded: an index build scales with the collection, so no one figure is right
 * (`db/write-bound.ts` states the exemption).
 */
export async function ensureQueryIndexes(): Promise<number> {
  let issued = 0;
  await eachSpace(QUERY_INDEXES_STEP, concreteSpaces(), async (space) => {   // pre-setup: none, so nothing to index yet
    const units: Array<{ name: string; ensure: () => Promise<unknown> }> = [
      ...TYPE_FILTERED.map(name => ({
        name: `${name} type index`,
        ensure: () => col(`${space.id}_${name}`).createIndex({ type: 1 }),
      })),
      ...LINK_INDEXES.map(ix => ({
        name: `links ${Object.keys(ix.keys).join(',')} index`,
        ensure: () => col(spaceCollection(space.id, 'links')).createIndex(ix.keys, ix.unique ? { unique: true } : {}),
      })),
      // The file tombstones' indexes, the same call `initSpace` makes (bundle-30 I16).
      { name: 'file tombstone indexes', ensure: () => ensureFileTombstoneIndexes(space.id) },
      // The fork caps' indexes, for a space `initSpace` never revisits — the same list it creates (`FORK_INDEXES`).
      ...FORK_INDEXES.map(ix => ({
        name: `facts ${Object.keys(ix.keys).join(',')} index`,
        ensure: () => col(spaceCollection(space.id, 'facts')).createIndex(ix.keys, { sparse: ix.sparse }),
      })),
    ];
    await eachUnit(units, async (unit) => {
      await unit.ensure();
      issued++;
    }, unit => unit.name);
  }, { when: 'next boot' });
  return issued;
}
