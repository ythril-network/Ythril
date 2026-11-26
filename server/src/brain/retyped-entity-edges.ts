/**
 * An entity whose type changed takes the schema stamp off every edge that names it as an end.
 *
 * ## Why
 *
 * An edge's conformity depends on its ends' entity types (the endpoint rule of the schema check, `ResolvedEdgeEnds.fromType/toType`). A re-type
 * re-validates the entity only; the edges that name it were judged against its OLD type, and nothing checks them again. A stamp means "conforms as
 * stored" (ADR 22), so those edges lose it: the same reason a relink, which moves an edge onto new ends and checks nothing, is an UNSTAMP writer.
 * A change of the entity's other fields (its properties, its name) leaves its edges' stamps alone: no endpoint rule reads them.
 *
 * ## How
 *
 * One read of the stamped edges' ids over the edge ends' index (`edgeEndsAt`, the one spelling of "either end is this record"), then one
 * `updateMany` per chunk of ids, still narrowed to the ends and the stamp, so an entity whose edges carry no stamp writes nothing. The ids
 * let the triple index's journal name each edge (bundle-273, design-r2 R6). Admitted and counted as a write of the space,
 * as every record write is. The version of each edge is not moved: the stamp is version metadata, not content, and is not hashed (ADR 22).
 */
import { col, asFilter, asUpdate } from '../db/mongo.js';
import { spaceCollection } from '../db/space-collection.js';
import { READ_CHUNK } from '../db/read-by-id.js';
import { inChunks } from '../util/chunks.js';
import { admitSpaceWrite } from '../spaces/space-write-gate.js';
import { SCHEMA_FINGERPRINT_FIELD, UNSTAMP } from '../spaces/schema-stamp.js';
import { edgeEndsAt } from './edge-ends-of-record.js';
import type { EdgeDoc } from '../config/types.js';

/** Remove the schema stamp from every edge whose `from` or `to` is entity `entityId` of `spaceId`; answers how many edges lost it. */
export async function unstampEdgesOfRetypedEntity(spaceId: string, entityId: string): Promise<number> {
  const edges = col<EdgeDoc>(spaceCollection(spaceId, 'edges'));
  const stamped = { ...edgeEndsAt(entityId, 'entity'), [SCHEMA_FINGERPRINT_FIELD]: { $exists: true } };
  // The ids first (design-r2 R6): the stamp is a statement (`dcterms:conformsTo`), so the triple index's journal names each edge it clears;
  // a filter on the ends alone names no record, and would send the space's index to a rebuild for one retype.
  const ids = (await edges.find(asFilter<EdgeDoc>(stamped), { projection: { _id: 1 } }).toArray()).map(e => String(e._id));
  let unstamped = 0;
  for (const chunk of inChunks(ids, READ_CHUNK)) {
    const done = await admitSpaceWrite(spaceId, 'edges', () => edges.updateMany(
      asFilter<EdgeDoc>({ _id: { $in: chunk }, ...stamped }),
      asUpdate<EdgeDoc>({ $unset: { ...UNSTAMP.$unset } }),
    ));
    unstamped += done.modifiedCount;
  }
  return unstamped;
}
