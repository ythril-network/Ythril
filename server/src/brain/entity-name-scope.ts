/**
 * "Records attached to an entity whose name looks like this" — the predicate, in one place.
 *
 * ## The defect it exists for, measured rather than reasoned
 *
 * A record could name an entity two ways and both were documented: the `entityIds` array, and
 * `linkEntities`, which writes a link record and left the array alone. This predicate read the array, so
 * the RECOMMENDED way to attach an entity produced a record the documented filter could not find — and it
 * said so by answering `{facts: [], total: 0}`, which reads as *there are none* rather than *this cannot
 * see them*.
 *
 * **The reasoning that let it ship is worth more than the bug.** `link-adjacency.ts` justified reading the
 * arrays with *"the arrays are complete on every space, always"*. That was true when every writer
 * maintained them, and `linkEntities` did not. A sentence that was true when written, load-bearing for a
 * branch, and never re-checked against a writer added afterwards.
 *
 * ## One shape since 5.0, and that is what removed the `$or`
 *
 * This asked both ways round — the array OR the link records — because the two shapes coexisted on every
 * space that had been written to since the upgrade. 5.0 deleted the arrays and every space is converted
 * before its links can be read at all, so the link records ARE the set. Keeping the array half would now
 * be a predicate over a field no document has.
 */
import { resolveEntityIdsByName } from './entities.js';
import { linkClassFor, linkedFromIds } from './link-adjacency.js';

/** The record kinds that can name an entity. Edges are NOT here: they store `from`/`to` directly. */
export type EntityLinkedKind = 'fact' | 'chrono';

/**
 * A Mongo predicate selecting records of `kind` in `spaceId` attached to an entity matching `needle`.
 *
 * Resolved PER SPACE by the caller, never once for a proxy: an id belongs to the space that owns it, so
 * resolving a name against one member and querying another matches nothing while looking correct.
 *
 * **A name that matches nothing yields a predicate that matches nothing**, deliberately. Returning `{}` —
 * "no constraint" — would turn a typo into a full-collection read that is indistinguishable from a
 * successful search, which is the worst available failure for a filter.
 */
export async function attachedToEntityNamed(
  spaceId: string,
  kind: EntityLinkedKind,
  needle: string,
): Promise<Record<string, unknown>> {
  const entityIds = await resolveEntityIdsByName(spaceId, needle);
  if (entityIds.length === 0) {
    // Matches nothing, and says so in the shape rather than by being absent.
    return { _id: { $in: [] } };
  }

  const cls = linkClassFor(kind, 'entity');
  const viaLinks = cls ? await linkedFromIds(spaceId, cls, entityIds) : [];

  // An id set, because a link record's `from` IS the record being selected. A kind with no class for
  // entities — there is none today — selects nothing rather than everything.
  return { _id: { $in: viaLinks } };
}
