import { col } from '../db/mongo.js';
import { validateEdge } from './schema-validation.js';
import type { SpaceMeta } from '../config/types.js';
import type { SchemaViolation } from './schema-validation.js';
import { spaceCollection } from '../db/space-collection.js';

/** One stored edge, as much of it as validation reads. */
interface StoredEdge {
  _id: string;
  label?: string;
  from?: string;
  to?: string;
  properties?: Record<string, unknown>;
}

/** What the dry run reports for one document. */
export interface StoredViolation {
  collection: string;
  _id: string;
  violations: SchemaViolation[];
}

/**
 * Validate a page of stored edges against a space's schema, including the parts that need a lookup.
 *
 * ## Why edges are the one collection with a module of their own
 *
 * Entities, facts and chrono entries validate from the document. An edge does not: an `endpoints`
 * declaration is about the TYPE of the entity at each end, and `functional` is about how many edges share a
 * subject. Neither is readable from the edge, and `validateEdge` is pure and synchronous — two gates import it
 * from `dist` and call it with plain objects — so the caller resolves and hands over what it found.
 *
 * It lives here rather than inline in `api/spaces.ts` because that file is frozen for size, and the gate's
 * message is the reason rather than the rule: every change lands in the same place because that is where the
 * code already is.
 *
 * ## Two batched queries for the whole page, never one per edge
 *
 * A per-edge lookup is one round trip per row, and this endpoint scans up to ten thousand. `assertRefsResolve`
 * next door already learned this: one `$in` for every endpoint on the page, one pass to count subjects.
 *
 * ## The distinction that decides what gets reported
 *
 * A `null` type means the entity is THERE and has no type, which an `endpoints` list matches with `UNTYPED`. An
 * endpoint MISSING from the map means the entity is not there at all — a dangling reference, which
 * `strictLinkage: false` makes a deliberate documented state and `ErModel.danglingEdges` already reports on its
 * own row. Folding that into a type violation would make one setting's escape hatch look like another setting's
 * breach, so an unresolvable endpoint is passed as "not resolved" and the type rule stays silent about it.
 */
export async function validateStoredEdges(
  spaceId: string,
  meta: SpaceMeta,
  scanLimit: number,
): Promise<StoredViolation[]> {
  const out: StoredViolation[] = [];
  const edges = await col(spaceCollection(spaceId, 'edges')).find({}).limit(scanLimit).toArray();
  const docs = edges as unknown as StoredEdge[];
  if (docs.length === 0) return out;

  const endpointIds = [...new Set(docs.flatMap(e => [e.from, e.to]).filter((x): x is string => !!x))];
  const typeOf = new Map<string, string | null>();
  if (endpointIds.length > 0) {
    const ents = await col(spaceCollection(spaceId, 'entities'))
      .find({ _id: { $in: endpointIds } } as never, { projection: { _id: 1, type: 1 } })
      .toArray() as unknown as Array<{ _id: string; type?: string }>;
    for (const e of ents) typeOf.set(String(e._id), e.type ?? null);
  }

  /*
   * How many edges carry each `(from, label)`, counted over the SCANNED page.
   *
   * The page rather than the collection, because every other row this endpoint returns is about what it scanned:
   * a count reaching past the limit would make one answer depend on rows the caller was never shown, and two
   * runs with different limits would disagree about the same data.
   */
  const subjectCounts = new Map<string, number>();
  /*
   * Length-prefixed, the same way `edgeIdFor` builds its key and for the same reason: a label is
   * operator-supplied text, so any separator can appear inside a part. A plain `${from}:${label}` counts
   * ('a:b', 'c') and ('a', 'b:c') as one subject, and would report a functional violation between two
   * unrelated edges.
   *
   * A NUL separator is injective too and was the first draft — it makes git treat the file as BINARY, so
   * `source-text-hygiene` refuses it: no diff, no blame, no review.
   */
  const subjectKey = (from: string, label: string) => `${from.length}:${from}${label.length}:${label}`;
  for (const e of docs) {
    if (!e.from || !e.label) continue;
    const k = subjectKey(e.from, e.label);
    subjectCounts.set(k, (subjectCounts.get(k) ?? 0) + 1);
  }

  for (const doc of docs) {
    const v = validateEdge(meta, doc, {
      ...(doc.from && typeOf.has(doc.from) ? { fromType: typeOf.get(doc.from) } : {}),
      ...(doc.to && typeOf.has(doc.to) ? { toType: typeOf.get(doc.to) } : {}),
      // Minus one: an edge is not its own duplicate.
      ...(doc.from && doc.label
        ? { otherEdgesFromSubject: (subjectCounts.get(subjectKey(doc.from, doc.label)) ?? 1) - 1 }
        : {}),
    });
    if (v.length) out.push({ collection: 'edges', _id: String(doc._id), violations: v });
  }
  return out;
}
