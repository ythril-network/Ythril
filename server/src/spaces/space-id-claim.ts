/**
 * The claim a space create holds on its id while it builds the space (Q-978).
 *
 * ## What it prevents
 *
 * `createSpace` checks that its id is free, then awaits the creation of the space's collections and counter, and only then pushes the space
 * to the config. A rename of another space to that id, registered in between, found the id free too (nothing is configured under it yet),
 * moved its collections under it and committed; the create then pushed its space and the config held the id twice, the created space
 * owning the renamed space's collections and counter. Deleting either dropped both spaces' data. Two creates of one id raced the same way.
 *
 * ## The one claim
 *
 * Two kinds of holder own an id that is not configured yet. A rename that is registered or marked owns its new id in the config
 * (`isRenameTarget`, which `createSpace` already refuses). A create owns it here, from its check to its end. `claimIdForCreate` is taken in
 * the same synchronous step as the check (no await between them), so of two callers exactly one holds the id and the other is refused.
 *
 * ## The guard a caller drops
 *
 * **Released on every path.** The claim is a release function the caller must call in a `finally`; `withIdClaimedForCreate` is that
 * `finally`, so a create that throws, or one that returns, gives the id back. A claim that leaked would refuse the id until a restart.
 */

/** Ids a create is building a space under now. */
const creating = new Set<string>();

/** A create holds `id`: refused to a second create and to a rename's new id, until the first create ends. */
export function isIdBeingCreated(id: string): boolean {
  return creating.has(id);
}

/**
 * Run `body` holding the claim on `id`. Throws `refusal()` at once when a create already holds it. The claim is taken before anything awaits
 * and released when `body` settles, whichever way.
 */
export async function withIdClaimedForCreate<T>(id: string, refusal: () => Error, body: () => Promise<T>): Promise<T> {
  if (creating.has(id)) throw refusal();
  creating.add(id);
  try {
    return await body();
  } finally {
    creating.delete(id);
  }
}
