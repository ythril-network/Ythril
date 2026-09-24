/**
 * The name of one of a space's collections — the question, answered once.
 *
 * ## Why this exists when two maps already name collections
 *
 * `COLLECTION_SUFFIX` and `RECORD_COLLECTION` answer a NARROWER question: *"which collection does this
 * knowledge TYPE live in"*. That is the right question for a type-driven caller, and it is not the question
 * most callers have. A space owns TEN collections that are not a knowledge type — `_tombstones`, `_links`,
 * `_conflicts`, `_dupe_candidates`, `_contradiction_candidates`, `_embed_jobs`, `_file_tombstones`,
 * `_media_jobs`, `_link_violations` and `_file_hashes`. None was in any map, so all ten were spelled out at
 * the call.
 *
 * **The first sweep for this work found only six of them**, because it searched for the suffixes it already
 * knew — the shape this module exists against, arriving inside the work to remove it. A set you enumerate
 * is a set you measure wrong. The gate therefore reads EVERY `${...}_suffix` in the tree and requires each
 * suffix to be either a collection named here or an explicitly classified non-collection, so a sixteenth
 * fails on the day it is written rather than on the day somebody happens to grep for it.
 *
 * So the common question had no home, and 294 call sites answered it with a template string. This is that
 * home. The two type maps stay — they still answer the type question — and `recordCollection` below is the
 * bridge, so a type-keyed caller and a collection-keyed one arrive at the same string. A gate holds every
 * `RECORD_COLLECTION` value to appearing here, which is the check that keeps the two from drifting.
 *
 * ## The guard, which is the whole point and is what a template string drops
 *
 * A collection is `{spaceId}_{suffix}`, and three operations select a space's collections by a bare prefix
 * match on `<spaceId>_`:
 *
 *   `spaces/rename.ts`    MOVES every match
 *   `spaces/lifecycle.ts` DROPS every match
 *   `spaces/_shared.ts`   rewrites a field in every match
 *
 * All three are correct for exactly one reason: a space id is validated `^[a-z0-9-]+$`, so `_` cannot occur
 * inside an id and is an unambiguous separator. The sibling space `work-archive` owns `work-archive_facts`,
 * which does not carry the prefix `work_`.
 *
 * **Relax that charset for any good-sounding reason and deleting the space `work` silently drops
 * `work_archive`'s collections** — another space's data, no confirmation, recoverable only from a backup.
 *
 * A template string cannot check that, and nobody writing one remembers to. So the check lives here, and it
 * THROWS rather than returning a name it cannot vouch for: a helper that hands back a plausible value where
 * it should refuse has moved the bug rather than fixed it.
 *
 * `space-id-prefix-safety.test.js` is the tripwire on the VALIDATION sites, and stays. This is the same rule
 * asserted where the name is BUILT — because a validated id and a trusted id are not the same thing, and the
 * ids reaching these call sites come from a request body, a peer's space map, a config file and a migration.
 *
 * ## One question per module
 *
 * It answers *"what is this space's X collection called"* and nothing else. It does not open the collection
 * — `col()` in `mongo.ts` does that, and folding the two would make every caller of a name depend on a
 * database handle.
 */
import { RECORD_COLLECTION } from '../config/types-knowledge.js';

/**
 * Every collection a space owns, keyed by what it holds.
 *
 * Keyed by the COLLECTION's own name, not by knowledge type, because that is the question callers have: a
 * tombstone sweep and a dupe scan are not types. `recordCollection` below is the type-keyed door onto the
 * same names, so the two vocabularies meet in one place instead of at every call.
 *
 * Every value of `RECORD_COLLECTION` must appear here, and the gate asserts that rather than this file
 * spreading the map in: spreading would key the record entries by TYPE and the rest by collection, so one
 * object would answer two different questions depending on which key you happened to use.
 */
export const SPACE_COLLECTIONS = {
  facts: 'facts',
  entities: 'entities',
  edges: 'edges',
  chrono: 'chrono',
  files: 'files',
  tombstones: 'tombstones',
  links: 'links',
  conflicts: 'conflicts',
  dupeCandidates: 'dupe_candidates',
  contradictionCandidates: 'contradiction_candidates',
  embedJobs: 'embed_jobs',
  fileTombstones: 'file_tombstones',
  mediaJobs: 'media_jobs',
  linkViolations: 'link_violations',
  fileHashes: 'file_hashes',
} as const;

export type SpacePart = keyof typeof SPACE_COLLECTIONS;

/**
 * The space-id charset, written here as well as at the validation sites — deliberately, and it is not a
 * second copy of a rule so much as the second HALF of one.
 *
 * A validation site answers *"may this id be created"*. This answers *"may this id be turned into a
 * collection name"*, and the ids arriving here were not all created through a validation site: they come
 * from a peer's space map, from a config file edited by hand, and from migrations reading what is already
 * stored. `space-id-prefix-safety.test.js` reads both out of the source and holds them to each other.
 */
const SAFE_SPACE_ID = /^[a-z0-9-]+$/;

/**
 * `<spaceId>_<suffix>` — refusing rather than guessing.
 *
 * @throws if the space id could forge the `_` separator, or the part is not one this space owns. Both are
 *   programming errors at the call site, and both produce silent damage if allowed through: the first lets
 *   one space's delete reach another's data, the second builds a collection nothing else reads or writes,
 *   which presents as an empty result rather than as an error.
 */
export function spaceCollection(spaceId: string, part: SpacePart): string {
  if (typeof spaceId !== 'string' || !SAFE_SPACE_ID.test(spaceId)) {
    throw new Error(
      `space id ${JSON.stringify(spaceId)} cannot be used to name a collection: it must match `
      + `${SAFE_SPACE_ID.source}. An underscore in particular would make this space's collections carry `
      + "another space's prefix, and a space delete selects by that prefix.",
    );
  }
  const suffix = SPACE_COLLECTIONS[part];
  if (suffix === undefined) {
    throw new Error(
      `'${String(part)}' is not one of a space's collections (${Object.keys(SPACE_COLLECTIONS).join(', ')}). `
      + 'Building the name anyway would address a collection nothing else reads, which answers empty rather '
      + 'than failing.',
    );
  }
  return `${spaceId}_${suffix}`;
}

