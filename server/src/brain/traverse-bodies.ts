/**
 * The records a graph walk reached, projected — so one `graph_traverse` call can return a whole subgraph with
 * its bodies (`F-32`).
 *
 * Owner, 2026-09-23, reading a three-call recipe for fetching one flow from the `flows` space: *"is that not
 * just an includes flag?"* It was not, and it should have been. `recall`'s traverse has applied a
 * `projection` to every node and every edge at every depth since 3.x (`recall-graph.ts`); the standalone walk
 * returned `_id`/`name`/`type`/`depth` and `from`/`to`/`label`, so reading a subgraph's content took the walk
 * plus a `filter` per collection over the ids it returned.
 *
 * It lives BESIDE the walk rather than inside it: `edges.ts` is frozen at its size, and the walk's job is which
 * nodes are reached, not what they contain. With no projection nothing here runs and the answer is the lean
 * one, byte for byte — nobody who does not ask pays for the bodies.
 *
 * What a projection can never do, on this door as on every other read door:
 *  - return the vector — `embedding` is stripped before the projection sees the record;
 *  - return the diagnostics unless `includeDiagnostics` asked for them;
 *  - remove the walk's own envelope: `_id`, `depth`, `kind` on a node and `_id`, `from`, `to`, `label` on an
 *    edge. Those say how the answer hangs together; a projection that could drop `from` would return an edge
 *    list nobody can read.
 */
import { col, asFilter } from '../db/mongo.js';
import { spaceCollection } from '../db/space-collection.js';
import { collectionForRefKind } from './entity-refs.js';
import { NEVER_RETURNED_PROJECTION } from './read-projection.js';
import { applyProjection, type NormalisedProjection } from './projection.js';
import { RECALL_RECORD_DIAGNOSTICS, NEVER_RETURNED_FIELDS } from './recall-shape.js';
import type { TraverseResult, TraverseNode } from './edges.js';
import type { TraverseEdge } from './traverse-subgraph.js';
import type { RefKind } from '../config/types-knowledge.js';

type Doc = Record<string, unknown>;
/** A stored record as the driver returns it: every one of them has a string `_id` in this product. */
type IdDoc = { _id: string; [k: string]: unknown };

/** Diagnostics off unless asked; the vector off always. The same rule `recall-graph.ts` applies to its walk. */
function stripFields(doc: Doc, includeDiagnostics: boolean): Doc {
  const out = { ...doc };
  const drop = includeDiagnostics ? NEVER_RETURNED_FIELDS : [...RECALL_RECORD_DIAGNOSTICS, ...NEVER_RETURNED_FIELDS];
  for (const k of drop) delete out[k];
  return out;
}

/**
 * The pure half: lay the fetched bodies over the lean answer. Exported for its tests — the shape is the
 * contract, and it should be assertable without a database.
 */
export function shapeTraverseBodies(
  result: TraverseResult,
  nodeDocs: ReadonlyMap<string, Doc>,
  edgeDocs: ReadonlyMap<string, Doc>,
  projection: NormalisedProjection | undefined,
  includeDiagnostics: boolean,
): TraverseResult {
  if (!projection) return result;
  const nodes = result.nodes.map((n) => {
    const doc = nodeDocs.get(n._id);
    if (!doc) return n; // no stored body — the lean node is the truth
    const body = applyProjection(stripFields(doc, includeDiagnostics), projection);
    return { ...body, _id: n._id, depth: n.depth, ...(n.kind ? { kind: n.kind } : {}) } as unknown as TraverseNode;
  });
  const edges = result.edges.map((e) => {
    const doc = edgeDocs.get(e._id);
    if (!doc) return e; // a link-derived edge has no stored document
    const body = applyProjection(stripFields(doc, includeDiagnostics), projection);
    return { ...body, _id: e._id, from: e.from, to: e.to, label: e.label } as unknown as TraverseEdge;
  });
  return { ...result, nodes, edges };
}

/**
 * Fetch the bodies of every node and stored edge a walk returned, across the member spaces, and project them.
 *
 * One read per collection per member space, `_id $in` the ids the walk produced — never more than the walk
 * already bounded with `limit`. A proxy walk's records live in its members, so every member is asked; an id is
 * unique, so the first match is the record.
 */
export async function withTraverseBodies(
  memberIds: string[],
  result: TraverseResult,
  projection: NormalisedProjection | undefined,
  includeDiagnostics: boolean,
): Promise<TraverseResult> {
  if (!projection) return result;

  const byKind = new Map<RefKind, string[]>();
  for (const n of result.nodes) {
    const kind = (n.kind ?? 'entity') as RefKind;
    const ids = byKind.get(kind) ?? [];
    ids.push(n._id);
    byKind.set(kind, ids);
  }
  const edgeIds = result.edges.map(e => e._id);

  const nodeDocs = new Map<string, Doc>();
  const edgeDocs = new Map<string, Doc>();
  await Promise.all(memberIds.flatMap((space) => [
    ...[...byKind].map(async ([kind, ids]) => {
      const docs = await col<IdDoc>(spaceCollection(space, collectionForRefKind(kind)))
        .find(asFilter<IdDoc>({ _id: { $in: ids } }), { projection: NEVER_RETURNED_PROJECTION }).toArray();
      for (const d of docs) if (!nodeDocs.has(d._id)) nodeDocs.set(d._id, d);
    }),
    (async () => {
      if (edgeIds.length === 0) return;
      const docs = await col<IdDoc>(spaceCollection(space, 'edges'))
        .find(asFilter<IdDoc>({ _id: { $in: edgeIds } }), { projection: NEVER_RETURNED_PROJECTION }).toArray();
      for (const d of docs) if (!edgeDocs.has(d._id)) edgeDocs.set(d._id, d);
    })(),
  ]));

  return shapeTraverseBodies(result, nodeDocs, edgeDocs, projection, includeDiagnostics);
}
