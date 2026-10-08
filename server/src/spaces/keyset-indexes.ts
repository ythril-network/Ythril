/**
 * Creating the seq-keyset indexes (`SEQ_KEYSET_INDEXES`, `util/seq-keyset.ts`) — the two ways a collection gets one, and
 * the one order that cannot leave a read without an index.
 *
 * ## Why two doors
 *
 * **`initSpace` runs for EVERY space at EVERY boot, before the server listens** (`index.ts`). A compound index built
 * there, on a collection that already holds a million records, is a boot that does not finish — so `initSpace` creates the
 * keyset indexes ONLY for a collection that did not exist yet ({@link createKeysetIndexesFor}), where the build is free,
 * and never creates the bare `{ seq: 1 }` again (it would put back, at every boot, an index the pass below removed).
 * A collection that EXISTS gets its compound from the background pass (`ensureQueryIndexes`, {@link buildKeysetIndex}),
 * after the server is up. Until then a keyset read behaves as it did before (`util/seq-keyset.ts`, the readiness note).
 *
 * ## The order, in one unit
 *
 * `buildKeysetIndex` creates the compound, then LOOKS — only a `listIndexes` that shows it counts — and only then drops
 * the bare index it replaces, in the same call. A build that fails or is killed drops nothing: the reader keeps the index
 * it had. Dropping is the half that matters for cost, not correctness: two seq indexes are two index writes on every
 * record write for ever. An older build recreates the bare index at its own boot (it creates it unconditionally), so a
 * rollback is safe and leaves the compound behind, harmless.
 */
import { col } from '../db/mongo.js';
import { spaceCollection, type SpacePart } from '../db/space-collection.js';
import { dropIndexesIfPresent, indexNamesOf } from '../db/index-names.js';
import { SEQ_KEYSET_INDEXES, bareKeysOf, indexNameOf, noteKeysetIndexes, type SeqKeysetIndex } from '../util/seq-keyset.js';

/**
 * Create every keyset index of the collections a space has JUST created. Called by `initSpace` with the parts whose
 * collection did not exist before this boot: they are empty, so the build is instant and the compound is there from the
 * first write. A new collection has no bare index to replace, and none is created.
 */
export async function createKeysetIndexesFor(spaceId: string, isNew: (part: SpacePart) => boolean): Promise<void> {
  const touched = new Set<SpacePart>();
  for (const ix of SEQ_KEYSET_INDEXES) {
    if (!isNew(ix.part)) continue;
    await col(spaceCollection(spaceId, ix.part)).createIndex({ ...ix.keys });
    touched.add(ix.part);
  }
  // A reader waits for the compound, and these collections have it: say so, rather than let their first read look.
  for (const part of touched) {
    const collName = spaceCollection(spaceId, part);
    noteKeysetIndexes(collName, await indexNamesOf(collName));
  }
}

/** What one `buildKeysetIndex` did, for the pass's log. */
export interface KeysetBuild { built: boolean; droppedBare: boolean }

/**
 * Make sure one existing collection has `index`, then remove the bare index it replaces. See the header for the order.
 * Throws when the compound is not in the index list after its build, so a pass never drops on the strength of a call that
 * returned.
 */
export async function buildKeysetIndex(
  spaceId: string, index: SeqKeysetIndex, { onBuild }: { onBuild?: () => void } = {},
): Promise<KeysetBuild> {
  const collName = spaceCollection(spaceId, index.part);
  const name = indexNameOf(index.keys);
  const bare = indexNameOf(bareKeysOf(index));
  let names = await indexNamesOf(collName);
  const built = !names.includes(name);
  if (built) {
    onBuild?.();   // before the build, so a log line says it STARTED rather than only that it ended
    await col(collName).createIndex({ ...index.keys });
    names = await indexNamesOf(collName);
    if (!names.includes(name)) throw new Error(`index ${name} on ${collName} is not in its index list after its build; the bare ${bare} is kept`);
  }
  const droppedBare = names.includes(bare);
  names = await dropIndexesIfPresent(collName, [bare], names);
  noteKeysetIndexes(collName, names);
  return { built, droppedBare };
}
