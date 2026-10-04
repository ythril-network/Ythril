/**
 * The record with this id, looked up only in the spaces where the token holds `needs` or better on `area`.
 *
 * ## Why it exists: an iterating route resolves its record by walking spaces, and the walk is the guard
 *
 * The Data quality routes (duplicates, contradictions, conflicts) take a record id and no space. They find the
 * record by trying each space the token can reach, and the space it turns up in is the one the action runs in.
 * So the SET OF SPACES walked is the whole authorisation. Middleware cannot gate the call, because it has no space
 * to check (see `auth/reachable-spaces.ts`).
 *
 * That loop was written by hand in each of those routers, more than once in some, beside a copy per router of an
 * `accessibleSpaces(req, needs = 'read')` wrapper. **The default rung was the defect (`Q-304`).**
 * `POST /api/duplicates/:id/merge` looked its candidate up through a copy that walked at `read`. Its rights row
 * says `write`, and `denyReadOnly` asks only whether the token may write ANYWHERE. So a token that could only read
 * a space's candidates merged one, deleting an entity in a space where it held `read`.
 *
 * **What a hand copy drops is the rung, so here it has no default.** A caller states the area and the rung at the
 * call, where a reviewer reads them and where `an-iterates-row-loops-at-its-rung` compares them to the route's
 * rights row.
 *
 * It lives beside `reachable-spaces.ts` and not inside it on purpose. That module holds the PRIMITIVES (the
 * iteration set and the per-space predicates), and the gate treats each primitive as a leaf. A lookup that walks
 * the iteration set is not a primitive, so the gate has to walk through it to read the rung it passes on.
 */
import { col, asFilter } from '../db/mongo.js';
import { spaceCollection, type SpacePart } from '../db/space-collection.js';
import { spacesWhereTokenMay } from './reachable-spaces.js';
import type { TokenRights, SpaceArea, Rung } from '../config/rights-shape.js';

/**
 * The first stored row with `_id === id` in `part`, over the spaces where `rights` holds `needs` on `area`, in
 * the configured space order. Returns the row and its space, or null when no reachable space holds it. A token
 * with no rights matrix reaches no space, so the answer is null.
 */
export async function findWhereTokenMay<T extends { _id: string }>(
  rights: TokenRights | undefined,
  area: SpaceArea,
  needs: Rung,
  part: SpacePart,
  id: string,
): Promise<{ doc: T; spaceId: string } | null> {
  for (const spaceId of spacesWhereTokenMay(rights, area, needs)) {
    const doc = await col<T>(spaceCollection(spaceId, part)).findOne(asFilter<T>({ _id: id })) as T | null;
    if (doc) return { doc, spaceId };
  }
  return null;
}
