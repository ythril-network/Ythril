/**
 * What one space HOLDS — its record counts and the observed half of its entity-relationship model — kept
 * between reads, and never behind a write.
 *
 * ## Why this exists (`Q-95`)
 *
 * Every space-meta read, on both doors, rebuilt this from scratch: an entity scan and an edge scan (each up to
 * 200 000 rows), three link-class scans, two counts for the model and five more for `stats` — per member space.
 * Measured on a space of 100 000 records, about 240 ms a read (`testing/bench/space-meta-cost.mjs`), paid by the
 * schema editor on every edit and by every agent orienting itself before a write.
 *
 * The alternative was to make `actualSchema` opt-in. It was rejected: the owner folded `er_model` into
 * `space_meta` so a caller gets both halves in one answer, and an opt-in would split them again for everyone who
 * does not know to ask. A cache keeps the information in every answer and takes the cost away.
 *
 * ## Why it can never be stale
 *
 * A space's records change only through a write, and every write this process makes reaches the collection
 * through `getDb()`, whose collections report each committed write (`db/record-write-observer.ts`). The stamp of
 * the six collections the answer reads — entities, edges, links, facts, chrono, files — moves on every such report
 * (`db/space-generation.ts`, the one answer to "has this changed", shared with the Merkle cache). An entry is
 * served only while its stamp is current, and a build is kept only if the stamp did not move while it read, so a
 * build racing a write is answered and then discarded.
 *
 * The two ways round that, both handled rather than left to a call site:
 *
 *   - **The declared schema is NOT cached.** It changes through a meta edit, which writes no record, so it is
 *     joined at read time (`joinDeclared`) — a schema edit shows at once, and there is nothing to remember to
 *     invalidate on one.
 *   - **A writer the observer cannot see** — the restore, on its own client — ends with
 *     `reportDatabaseReplaced()`, which moves every stamp (`db/space-generation.ts`), so every entry is stale.
 *
 * **The stamps are kept from when `db/space-generation.ts` loads** (this module imports it), and a collection
 * handle taken from `getDb()` before that is not observed (`db/record-write-observer.ts` wraps a collection only
 * if a listener wants it when the handle is taken). The routers import this at boot, before any request, and no
 * module holds a collection handle at module scope — every write takes its handle per call — so nothing writes
 * past it. A module that cached a handle at load time would break this and the search-index lifecycle alike.
 *
 * ## One question
 *
 * *"What does this one concrete space hold?"* Composing members for a proxy and joining the meta around it is
 * `spaces/space-meta-answer.ts`; a proxy is never an entry here, because two types sharing a name in two
 * members mean different things and must never be merged.
 */
import { col } from '../db/mongo.js';
import { spaceStamp } from '../db/space-generation.js';
import { spaceCollection } from '../db/space-collection.js';
import { readErShape, joinDeclared, declaredEntityTypes, type ErModel, type ErObserved } from './er-model.js';

/** The record counts a space meta reports. */
export interface SpaceStats { facts: number; entities: number; edges: number; chrono: number; files: number }

interface SpaceShape { observed: ErObserved; stats: SpaceStats }

/** The collections the answer is read from — a write to any of them can change it. */
const READ_PARTS = ['entities', 'edges', 'links', 'facts', 'chrono', 'files'] as const;

const cache = new Map<string, { stamp: string; shape: SpaceShape }>();
const building = new Map<string, { stamp: string; promise: Promise<SpaceShape> }>();
let builds = 0;

/** The stamp of everything the answer reads (`db/space-generation.ts`): it moves when any of them is written. */
const stampOf = (spaceId: string): string => spaceStamp(spaceId, READ_PARTS);

async function build(spaceId: string): Promise<SpaceShape> {
  builds++;
  const count = (part: typeof READ_PARTS[number]) => col(spaceCollection(spaceId, part)).countDocuments();
  const [observed, facts, entities, edges, chrono, files] = await Promise.all([
    readErShape(spaceId), count('facts'), count('entities'), count('edges'), count('chrono'), count('files'),
  ]);
  return { observed, stats: { facts, entities, edges, chrono, files } };
}

/** What `spaceId` holds now — from the cache when nothing has been written since it was read. */
async function shapeOf(spaceId: string): Promise<SpaceShape> {
  const stamp = stampOf(spaceId);
  const hit = cache.get(spaceId);
  if (hit && hit.stamp === stamp) return hit.shape;

  // One build per space and stamp: concurrent readers share it rather than each scanning.
  const inflight = building.get(spaceId);
  if (inflight && inflight.stamp === stamp) return inflight.promise;

  const promise = build(spaceId).then(shape => {
    // Kept only if nothing was written while it read — otherwise it may predate a committed write.
    if (stampOf(spaceId) === stamp) cache.set(spaceId, { stamp, shape });
    return shape;
  }).finally(() => {
    if (building.get(spaceId)?.promise === promise) building.delete(spaceId);
  });
  building.set(spaceId, { stamp, promise });
  return promise;
}

/** A concrete space's record counts, as the meta's `stats` reports them. */
export async function spaceStatsOf(spaceId: string): Promise<SpaceStats> {
  return { ...(await shapeOf(spaceId)).stats };
}

/** A concrete space's actual schema: the observed half, joined with the schema it declares right now. */
export async function actualSchemaOf(spaceId: string): Promise<ErModel> {
  return joinDeclared((await shapeOf(spaceId)).observed, declaredEntityTypes(spaceId));
}

/** How many times the expensive read has run. For the test that holds the cache to caching. */
export function _shapeBuildCount(): number { return builds; }
