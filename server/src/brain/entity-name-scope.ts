/**
 * "Records attached to an entity whose name looks like this" — the predicate, in one place.
 *
 * ## The defect it exists for, measured rather than reasoned
 *
 * A record can name an entity two ways, and both are documented:
 *
 * | written with | `entityIds` array | link record | found by `entityName` before this |
 * |---|---|---|---|
 * | `entityIds: [id]` | populated | written | yes |
 * | `linkEntities: [id]` | **empty** | written | **no** |
 *
 * `linkEntities` is the newer form and the one the integration guide leads with. So the RECOMMENDED way to
 * attach an entity produced a record the documented filter could not find — and the filter said so by
 * answering `{facts: [], total: 0}`, which reads as *there are none* rather than *this cannot see them*.
 *
 * **The reasoning that let it ship is worth more than the bug.** `link-adjacency.ts` justifies reading the
 * arrays as the safe side of its branch with *"the arrays are complete on every space, always"*. That was
 * true when every writer maintained them, and `linkEntities` does not — it writes the link record and
 * leaves the array alone. A sentence that was true when written, load-bearing for a branch, and never
 * re-checked against a writer added afterwards.
 *
 * ## Why BOTH sides, rather than switching on `completeLinkage`
 *
 * `completeLinkage` is set only by `npm run links:convert`, so most spaces do not have it — and the two
 * shapes coexist on every unconverted space that has been written to since the upgrade. Reading either one
 * alone drops records silently: the arrays miss everything written with `linkEntities`, and the link
 * records miss everything written before the upgrade. An `$or` over both is the only answer that is
 * complete on a space mid-migration, which is every space that is not brand new.
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

  /*
   * `$or`, not a merge. The two shapes are alternatives on the SAME record set, and a record may satisfy
   * either — one written before the upgrade has the array, one written with `linkEntities` has the link,
   * and a record written with `entityIds` has both because that path mirrors.
   */
  return { $or: [{ entityIds: { $in: entityIds } }, { _id: { $in: viaLinks } }] };
}
