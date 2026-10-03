/**
 * Has a space's record collection changed since a stamp was taken? — the one answer every cache over a space's
 * records keys itself by (`Q-107` part 4, extracted from `brain/space-shape.ts`).
 *
 * ## Why a module
 *
 * The space-meta cache (`brain/space-shape.ts`) kept a generation per space, bumped by the write observer, and the
 * Merkle root needed the same thing per COLLECTION: a cached set of leaves is good for exactly as long as nothing
 * wrote to the collection it was read from. Two copies of "what invalidates a cache over a space's records" would
 * drift on the case each of them forgets — and the case a copy forgets is the restore.
 *
 * ## What changes a stamp
 *
 *  - **A write this process makes**, reported by `getDb()`'s observer (`db/record-write-observer.ts`) for every write
 *    method — inserts, updates, replaces, deletes, bulk writes, a drop — and, for a write inside a transaction, when
 *    its session ends.
 *  - **A database replaced underneath the observer** (`reportDatabaseReplaced()`: the restore, on its own client).
 *    That bumps a GLOBAL epoch every stamp carries, so a space nothing else had touched cannot keep answering from
 *    before the restore.
 *
 * A stamp is a string of the epoch and the collection's generation; equal stamps mean nothing this process can see
 * has written to that collection in between. A generation is never reset — a dropped collection's entry is bumped,
 * not removed — because a reset would make a stamp taken before the drop match again after the space is recreated.
 *
 * ## The one rule a consumer must keep
 *
 * Take the stamp BEFORE reading, and keep what was read only if the stamp is unchanged after: a write that landed
 * while the read ran is then either seen by the read or reported against the stamp. `brain/space-shape.ts` and
 * `brain/merkle.ts` both do.
 *
 * It subscribes when this module loads, and a collection handle taken from `getDb()` before then is not observed for
 * it — see `brain/space-shape.ts` for why that holds in this codebase (no module caches a handle at load).
 */
import { onRecordCollectionWrite } from './mongo.js';
import { EVERY_COLLECTION } from './record-write-observer.js';
import { BRAIN_COLLECTIONS, type BrainCollection } from '../config/types-knowledge.js';

/** The record collections a stamp is kept for: every brain collection, the set both caches read. */
const WATCHED_SUFFIXES = new Set<string>(BRAIN_COLLECTIONS);

let epoch = 0;
let counter = 0;
const generation = new Map<string, number>();

/** True for `<spaceId>_<suffix>` of a watched record collection. */
function isWatched(name: string): boolean {
  const cut = name.indexOf('_');
  return cut > 0 && WATCHED_SUFFIXES.has(name.slice(cut + 1));
}

onRecordCollectionWrite(isWatched, (name) => {
  if (name === EVERY_COLLECTION) { epoch++; return; }
  generation.set(name, ++counter);
});

/** The stamp of one space's record collection now — see the module docblock for what changes it. */
export function collectionStamp(spaceId: string, part: BrainCollection): string {
  return `${epoch}:${generation.get(`${spaceId}_${part}`) ?? 0}`;
}

/** One stamp over several of a space's collections: it changes when any of them does. */
export function spaceStamp(spaceId: string, parts: readonly BrainCollection[]): string {
  return parts.map(p => collectionStamp(spaceId, p)).join('|');
}
