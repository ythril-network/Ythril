/**
 * Every given predicate must hold — as `$and`, never as one object built by spreading.
 *
 * A spread lets a later predicate's key REPLACE an earlier one's: a caller's `{_id: …}` erases the server's
 * `{_id: {$in: …}}`, a caller's `{updatedAt: {$exists: true}}` erases the freshness window. Each site that did
 * that was correct until a caller named the same key, and nothing reported the widening. So the merge is one
 * function, and the forgettable part — that it is an intersection — is the only thing it does.
 *
 * Empty and absent predicates are dropped, and a single survivor is returned as itself, so the common case
 * reads exactly as it did. `undefined` when nothing constrains.
 *
 * In `db/` rather than beside the recall filter it was written for, because the seq-keyset reader
 * (`util/seq-keyset.ts`) and the record push (`sync/push-family.ts`) AND a caller's predicate with their own guard by the
 * same rule, and a module under `util/` or `sync/` must not reach up into the recall code for it.
 * `brain/recall-filter.ts` re-exports it, so its callers are unchanged.
 */
export function andPredicates(
  ...parts: Array<Readonly<Record<string, unknown>> | null | undefined>
): Record<string, unknown> | undefined {
  const kept = parts.filter((p): p is Record<string, unknown> => p != null && Object.keys(p).length > 0);
  if (kept.length === 0) return undefined;
  return kept.length === 1 ? kept[0] : { $and: kept };
}
