/**
 * "Did the store answer that the collection is not there, or is already there?" - the two answers a drop, a create or an index read may
 * take as a normal state rather than a failure.
 *
 * ## What it prevents
 *
 * A drop of a collection that does not exist throws `NamespaceNotFound` (26) and a create of one that does throws `NamespaceExists`
 * (48); both mean the state the caller wanted already holds. The copies that tolerated them wrote `.catch(() => {})`, which swallows the
 * store's timeout too: a restore into a target that had stopped answering had its drop and its create time out silently and carried on
 * to the load, paying one full operation bound each before anything failed (Q-564; at the default bound, a migrate held every space for
 * more than eleven minutes). A catch through these swallows exactly the named answer and rethrows the rest.
 */

/** The store answered that the collection does not exist (code 26, `NamespaceNotFound`). */
export function isNamespaceNotFound(err: unknown): boolean {
  const e = err as { code?: unknown; codeName?: unknown } | null;
  return e?.codeName === 'NamespaceNotFound' || e?.code === 26;
}

/** The store answered that the collection already exists (code 48, `NamespaceExists`). */
export function isNamespaceExists(err: unknown): boolean {
  const e = err as { code?: unknown; codeName?: unknown } | null;
  return e?.codeName === 'NamespaceExists' || e?.code === 48;
}
