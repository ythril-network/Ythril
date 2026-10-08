/**
 * "Which indexes does this collection have" — the strict spelling: a collection that does not exist has none, and a store that
 * fails is an error.
 *
 * ## What it prevents
 *
 * `listIndexes` throws `NamespaceNotFound` (code 26) for a collection MongoDB has not created yet, and that is a normal answer
 * ("no indexes, so build them"), not a failure. Two readers of the list (the keyset readiness probe in `util/seq-keyset.ts`, and
 * the pass that builds the keyset indexes in `spaces/keyset-indexes.ts`) each wrote the catch, and the two have to agree on what
 * is swallowed: a copy that swallows EVERY error reads "the store did not answer" as "no index", and a pass that then builds
 * (or a reader that then falls back) on that is acting on a lie. So this swallows exactly the missing collection and rethrows the
 * rest; a caller that wants a softer rule catches around it and says so there.
 *
 * Not for the migrations in `spaces/_shared.ts` that read each index's KEYS and may skip on any error: they answer a different
 * question (what is the shape of the indexes, best-effort) and are deliberately not routed through here.
 */
import { col } from './mongo.js';

/** The names of a collection's indexes; `[]` for a collection that does not exist yet; anything else the store throws is thrown. */
export async function indexNamesOf(collName: string): Promise<string[]> {
  try {
    return (await col(collName).listIndexes().toArray()).map(ix => String(ix['name']));
  } catch (err) {
    if ((err as { codeName?: string }).codeName === 'NamespaceNotFound' || (err as { code?: number }).code === 26) return [];
    throw err;
  }
}

/**
 * Drop the indexes among `names` that the collection has, and answer the names left. An index already gone is the state
 * wanted, so only a listed one is dropped, and a drop that fails any other way is the caller's failure — never caught on a
 * guessed error code. `present` is a listing the caller already holds, so a pass that just built an index does not list twice.
 * The one way a replaced index is dropped (the keyset pass's bare index, the file tombstones' settle index).
 */
export async function dropIndexesIfPresent(
  collName: string, names: readonly string[], present?: readonly string[],
): Promise<string[]> {
  const listed = present ?? await indexNamesOf(collName);
  const gone = names.filter(n => listed.includes(n));
  for (const name of gone) await col(collName).dropIndex(name);
  return listed.filter(n => !gone.includes(n));
}
