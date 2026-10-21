/**
 * Run `fn` against each space of an EXPLICIT list in order and return the first accepted result: the read-by-id pattern of a personal view
 * (the record lives in exactly one member), and a write's one-element walk.
 *
 * `accept` decides what counts as a hit; it defaults to "non-null", which also treats a truthy boolean (a `deleteX() -> boolean`) as a hit.
 * Spaces after the first hit are not visited. Returns the accepted result, or `undefined` if no space produced one.
 *
 * **What it walks is the caller's to state, and it is a LIST** (`Q-440`, kept by Q-531): the spaces a view reads for this caller
 * (`readSpacesOfRequest` / `readSpacesOfCall`) or the one space a write lands in. It takes no id to expand: handed a view's id it would
 * have to visit every member, including ones the caller cannot read, and `204` against `404` says whether a record exists there.
 */
export async function findFirstAcrossMembers<T>(
  walk: readonly string[],
  fn: (spaceId: string) => Promise<T>,
  accept: (result: T) => boolean = (r): boolean => r != null && r !== false,
): Promise<T | undefined> {
  for (const spaceId of walk) {
    const result = await fn(spaceId);
    if (accept(result)) return result;
  }
  return undefined;
}
