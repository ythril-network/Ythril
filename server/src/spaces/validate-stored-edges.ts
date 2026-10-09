import { col } from '../db/mongo.js';
import { readStoredById } from '../db/read-by-id.js';
import { validateEdge } from './schema-validation.js';
import type { SpaceMeta } from '../config/types.js';
import type { SchemaViolation } from './schema-validation.js';
import { spaceCollection } from '../db/space-collection.js';
import { SubjectEdges, guardNamesItsEdge } from '../brain/functional-subject.js';

/** One stored edge, as much of it as validation reads. */
interface StoredEdge {
  _id: string;
  label?: string;
  from?: string;
  to?: string;
  fromKind?: string;
  toKind?: string;
  properties?: Record<string, unknown>;
  _functionalGuard?: unknown;
}

/** What the dry run reports for one document. */
export interface StoredViolation {
  collection: string;
  _id: string;
  violations: SchemaViolation[];
}

/** An edge whose write guard names another subject than the one it is under: its id, and the label it is under. */
export interface StaleGuard {
  _id: string;
  label: string;
}

/** What the dry run found over a page of stored edges: violations of the schema, and (apart from them) stale write guards. */
export interface StoredEdgeFindings {
  violations: StoredViolation[];
  staleGuards: StaleGuard[];
}

/**
 * What the dry run reads of a stored edge. EXPLICIT, and it names the guard: the marker is withheld from every answer
 * (`NEVER_RETURNED_FIELDS`), so a read that wants it says so, and this is one of the two readers that do. Everything else
 * is what `validateEdge` and the subject count read.
 */
const STORED_EDGE_PROJECTION = { _id: 1, from: 1, to: 1, label: 1, fromKind: 1, toKind: 1, properties: 1, _functionalGuard: 1 } as const;

/**
 * Is this edge's write guard one it should not hold? A guard is `functionalSubjectKey(from, label)` or absent, so one that
 * is a string and is anything else is a PHANTOM: it holds a subject's unique slot for an edge that is not under it. Reported
 * as its own list and never as a schema violation — the schema did not break, an index entry outlived its edge — so
 * `totalViolations` means what it meant before the guard existed.
 */
function staleGuardOf(e: StoredEdge): StaleGuard | null {
  const guard = e._functionalGuard;
  if (typeof guard !== 'string') return null;
  return guardNamesItsEdge(e) ? null : { _id: String(e._id), label: typeof e.label === 'string' ? e.label : '' };
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
): Promise<StoredEdgeFindings> {
  const out: StoredViolation[] = [];
  const staleGuards: StaleGuard[] = [];
  const edges = await col(spaceCollection(spaceId, 'edges')).find({}, { projection: STORED_EDGE_PROJECTION }).limit(scanLimit).toArray();
  const docs = edges as unknown as StoredEdge[];
  if (docs.length === 0) return { violations: out, staleGuards };

  const endpointIds = [...new Set(docs.flatMap(e => [e.from, e.to]).filter((x): x is string => !!x))];
  const typeOf = new Map<string, string | null>();
  if (endpointIds.length > 0) {
    const ents = await readStoredById<{ type?: string }>(spaceCollection(spaceId, 'entities'), endpointIds, { type: 1 });
    for (const [id, e] of ents) typeOf.set(id, e.type ?? null);
  }

  /*
   * How many edges carry each `(from, label)`, counted over the SCANNED page.
   *
   * The page rather than the collection, because every other row this endpoint returns is about what it scanned:
   * a count reaching past the limit would make one answer depend on rows the caller was never shown, and two
   * runs with different limits would disagree about the same data.
   */
  // The one counting definition (`brain/functional-subject.ts`): a subject's other edges by identity, so the planner, the
  // merge and this report agree on "another edge". A row too malformed to name an edge is not counted.
  const subjectEdges = new SubjectEdges(docs.filter((e): e is StoredEdge & { from: string; label: string; to: string } =>
    !!e.from && !!e.label && typeof e.to === 'string'));

  for (const doc of docs) {
    const stale = staleGuardOf(doc);
    if (stale) staleGuards.push(stale);
    const v = validateEdge(meta, doc, {
      ...(doc.from && typeOf.has(doc.from) ? { fromType: typeOf.get(doc.from) } : {}),
      ...(doc.to && typeOf.has(doc.to) ? { toType: typeOf.get(doc.to) } : {}),
      // An edge is not its own duplicate: `others` excludes its own identity.
      ...(doc.from && doc.label && typeof doc.to === 'string'
        ? { otherEdgesFromSubject: subjectEdges.others({ from: doc.from, label: doc.label, to: doc.to, fromKind: doc.fromKind, toKind: doc.toKind }) }
        : {}),
    });
    if (v.length) out.push({ collection: 'edges', _id: String(doc._id), violations: v });
  }
  return { violations: out, staleGuards };
}
