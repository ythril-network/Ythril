/**
 * The one clause for "the record, not an unchosen version of it" (Q-624, design rev 4 sections 1 and 6).
 *
 * ## What it prevents
 *
 * A fork row is an unchosen version of a record: the copy another instance wrote at the same version with another body, kept beside its subject until a
 * person decides (`brain/forks.ts`). For an edge it carries the SAME five identity fields as its subject, so a reader that applies no clause answers "that
 * relationship exists twice": a duplicate that is not one, an endpoint-rule break, a contradiction of its own subject, a second edge under a functional
 * label, a parallel edge to the same neighbour. Every reader that means "the relationship" and not "every stored row" spreads this clause into its filter, and
 * the shared builders (`tripletClause`, `frontierEdgeQuery`, `storedEdgeIdentities`, `relationshipEdgesOfRecord`) hold it INSIDE them, so a caller of one
 * cannot drop it. The entity readers use it too (`findEntitiesByName`, the dupe scanner): a fork entity is not a second entity of the same name.
 *
 * `{ forkOf: null }` matches a row whose `forkOf` is absent or null, which is every row but a fork. It is also exactly the predicate of the partial edge
 * identity index (`spaces/edge-identity-index.ts`): MongoDB serves a query from a partial index only when the query names the predicate, so the clause is what
 * keeps the identity read indexed as well as correct.
 *
 * `every-read-of-the-edges-collection-says-whether-a-fork-counts` derives every reader of the edges collection and holds it to this clause or to a reasoned
 * exemption. A reader that WANTS fork rows (a list, a count, a search, sync paging, the delete cascade) is exempt there, with its reason.
 *
 * It is a leaf: it imports nothing, so a module that needs the clause pulls nothing in with it.
 */

/** The filter fragment that keeps a record and leaves its unchosen versions out. Frozen: a caller that edited it would edit it for every reader. */
export const CHOSEN_VERSION_ROWS: Readonly<{ forkOf: null }> = Object.freeze({ forkOf: null });
