/**
 * The graph-augmented recall SHAPE: traversal nested under the seed that reached it.
 *
 * The fleet integrator 2026-08-13T1035Z §3–§4 and 1100Z. The flat list this replaces appended every neighbour beside the
 * seeds with `score: null`, and three things followed from that:
 *
 * 1. **With more than one seed, nothing said WHICH seed reached a node.** It was recoverable from the old
 *    `path`, but only by intersecting the first edge's ends against the seed ids.
 * 2. **`count` mixed matches with neighbours.** They asked for `topK: 1` and got `count: 6`, so the number a
 *    caller uses to decide whether to page described something they had not asked for.
 * 3. **The edge was reduced to `{from, label, to}`**, dropping its `description` — which, on their board, is
 *    where the REASON for a link lives — along with its `tags` and `createdAt`.
 *
 * Nesting also settles the ranking question rather than answering it. A traversed node was never selected by
 * matching the query; it is there because the graph relates it to something that did. Off the ranked list
 * there is nothing to rank it against, no `null` score competing with a real one, and no cut for it to fall
 * off. (Our own pipeline already reranks seeds BEFORE traversal — `recall()` returns reranked seeds and the
 * route expands them afterwards — so §4's "rerank after traverse" describes a defect we do not have.)
 *
 * ## Owner rulings, 2026-08-13 — settled, not to be re-derived
 *
 * **The node is `{ edge, node, paths }`, and `paths` is EVERY route to it**, each an array of record ids from
 * the seed, seed first and this node last. The FIRST path is always the one it is nested under. That makes
 * direction implicit (an ordered array of ids IS the direction), makes depth derived (`paths[0].length - 1`),
 * and answers the two-seed case without duplicating the node: one node object, one nesting, every other route
 * recorded beside it.
 *
 * **A node appearing under more than one parent must be COMPLETE wherever it appears** — no stubs, no
 * `{ref: id}` placeholders. Here that is free: the node is nested exactly once and `paths` carries the rest.
 *
 * ## What an id-only path cannot carry, and why that is still right
 *
 * The old `path` carried each hop's `label`. `paths` does not. It is not lost for the route that matters: the
 * node's own `edge` is the whole edge document for its last hop, and every INTERMEDIATE node on that route is
 * itself a nested entry with its own `edge` — so walking the tree yields every label in order. What genuinely
 * has no label is the last hop of an ALTERNATE route, where the caller has both endpoint ids and can ask.
 * Trading that for the owner's stated `[[id],[id,id,id]]` is the right way round: the primary route, which is
 * the one being served, gains a full edge object where it used to have three fields.
 */
import type { EntityDoc } from '../config/types.js';
import { type SeedTraverseNeighbor, type TraverseHopEdge, type TraverseHopRecord } from './recall-seed-traversal.js';
import { RECALL_RECORD_DIAGNOSTICS, NEVER_RETURNED_FIELDS } from './recall-shape.js';
import { applyProjection, type NormalisedProjection } from './projection.js';

/**
 * The ONE shape a traversed node takes, on both doors.
 *
 * Owner, 2026-08-16: *"both deliver exact same content but in a standard way for their transport"*. The
 * envelope stays each transport's own — REST returns a flat result, MCP nests the record under `record` —
 * but the CONTENT does not get to differ, and `_graph[].node` was where it did: MCP mapped the entity
 * through an allowlist while REST attached the Mongo document, so a REST caller saw `_expireAt` and every
 * other stored field and an MCP caller did not.
 *
 * This lived in `mcp/tools/shared.ts` as `entityDocToRecord` and had exactly two callers, both of them graph
 * nesting. Moving it here is what makes "one shape" true rather than promised — REST cannot nest a node
 * without it now, because `mapGraphNodes` is the only nesting implementation and this is what it is given.
 *
 * All three record diagnostics are emitted; `stripDiag` removes them unless the caller asked for them. That
 * ordering matters: leaving `matchedText` out of the allowlist would mean `includeDiagnostics: true` gave a
 * REST caller a field the MCP caller could never get, which is the same divergence one layer down.
 */
export function graphNodeRecord(e: TraverseHopRecord): Record<string, unknown> {
  /*
   * A record reached through a LINK is not an entity and has no `name`. It arrives holding its class
   * projection — `title`/`type` for a chrono, `fact`/`type` for a fact, `path`/`description`/`tags` for a
   * file — plus `kind`, and that projection IS the contract: a structural walk must not pay for a file's
   * passage text or a fact's whole body, which is why the projection exists in `LINK_CLASSES` at all.
   *
   * So the allowlist below is the ENTITY allowlist, and running a chrono through it would return an object
   * with an id and nothing else — a node that looks empty rather than one that says what it is. Emitting
   * what was fetched is the honest answer, and it is the same answer the standalone `traverse` gives.
   */
  const kind = (e as { kind?: string }).kind;
  if (kind !== undefined) return { ...e };

  const ent = e as EntityDoc;
  const rec: Record<string, unknown> = { _id: ent._id, spaceId: ent.spaceId, name: ent.name, type: ent.type };
  if (ent.createdAt !== undefined) rec['createdAt'] = ent.createdAt;
  if (ent.updatedAt !== undefined) rec['updatedAt'] = ent.updatedAt;
  if (ent.tags !== undefined) rec['tags'] = ent.tags;
  if (ent.description !== undefined) rec['description'] = ent.description;
  if (ent.properties !== undefined) rec['properties'] = ent.properties;
  if (ent.seq !== undefined) rec['seq'] = ent.seq;
  if (ent.embeddingModel !== undefined) rec['embeddingModel'] = ent.embeddingModel;
  const mt = (ent as unknown as { matchedText?: unknown }).matchedText;
  if (mt !== undefined) rec['matchedText'] = mt;
  return rec;
}

/** One traversed node, nested under whatever reached it. */
export interface GraphNode {
  /**
   * The edge for the hop that reached this node — `paths[0]`'s last hop.
   *
   * The whole document when a stored edge reached it. A record reached through a LINK has no stored edge and
   * carries a synthetic one instead, which holds only what is derived: see `SyntheticLinkEdge`.
   */
  edge: TraverseHopEdge;
  /** The reached record itself, embedding stripped. Non-entity kinds carry `kind`. */
  node: TraverseHopRecord;
  /**
   * Every route from a seed to this node, ids only, seed first.
   *
   * `paths[0]` is the route it is nested under. `paths[0].length - 1` is the hop count.
   */
  paths: string[][];
  /** True when this node has more routes than were recorded. */
  pathsTruncated?: boolean;
  /** Nodes reached FROM this one. Absent rather than empty when it is a leaf, so depth reads as a tree. */
  _graph?: GraphNode[];
}

export interface RecallGraph {
  /** Seed id → the nodes hanging off it. A seed that reached nothing is absent. */
  bySeed: Map<string, GraphNode[]>;
  /** How many traversed nodes the tree holds, in total, across every seed. */
  nodes: number;
}

/**
 * The same tree with every `node` put through `shapeNode`.
 *
 * REST returns entity documents as they are; MCP returns its own record shape. Mapping the finished tree keeps
 * ONE nesting implementation instead of one per door — which is the defect this repo produces most, and the
 * reason `_graph` had to reach both surfaces in the same commit anyway.
 */
export function mapGraphNodes<T>(
  nodes: GraphNode[] | undefined,
  shapeNode: (doc: TraverseHopRecord) => T,
  /**
   * Carry the system-facing fields into the tree, or drop them (default: drop).
   *
   * Owner, 2026-08-16: *"on traverse stuff make sure the subentries in _graph also respect this"* — and it
   * is the branch where it matters most. `edge` is the WHOLE edge document, once per hop, and an edge is a
   * searchable record with a `matchedText` of its own; a depth-2 traversal off ten seeds can carry more
   * diagnostic text than the matches it was expanding. Honouring the flag on the results and not on their
   * neighbourhood would have left the largest half of the saving unmade.
   *
   * It is applied HERE rather than in each door's `shapeNode` for the reason this function exists at all:
   * one nesting implementation, so neither surface can forget. It also reaches the `edge`, which no
   * `shapeNode` ever sees.
   */
  includeDiagnostics = false,
  /**
   * The caller's projection, applied to every `node` AND every `edge` at every depth.
   *
   * It has to reach here for the same reason `includeDiagnostics` did: a projection that trimmed the top-level
   * results while a traverse answer kept returning whole documents would be a lever that silently stops
   * working exactly where the response is largest. `edge` is the WHOLE edge document once per hop, so on a
   * traversing call it is usually the bulk of what a projection is being asked to remove.
   */
  projection?: NormalisedProjection,
): { edge: TraverseHopEdge; node: T; paths: string[][]; pathsTruncated?: boolean; _graph?: unknown[] }[] | undefined {
  if (!nodes) return undefined;
  return nodes.map(n => {
    const children = mapGraphNodes(n._graph, shapeNode, includeDiagnostics, projection);
    const edge = stripDiag(n.edge, includeDiagnostics) as TraverseHopEdge;
    return {
      edge: (projection ? applyProjection(edge, projection) : edge) as TraverseHopEdge,
      // The node goes through the caller's shaping FIRST and is stripped after, so this holds whether the
      // door passes the document through (REST) or maps it to its own record shape (MCP). Stripping an
      // allowlisted record is a no-op, which is the correct outcome rather than a wasted branch.
      node: (() => {
        const shaped = stripDiag(shapeNode(n.node) as unknown as object, includeDiagnostics);
        return (projection ? applyProjection(shaped, projection) : shaped) as T;
      })(),
      paths: n.paths,
      ...(n.pathsTruncated ? { pathsTruncated: true } : {}),
      ...(children ? { _graph: children } : {}),
    };
  });
}

/** One record, diagnostics removed unless asked for. Copies — the tree is also handed to the spill writer. */
function stripDiag<T extends object>(doc: T, include: boolean): T {
  // `NEVER_RETURNED_FIELDS` is dropped on BOTH branches — `includeDiagnostics` restores diagnostics,
  // never the vector, and an early return here would have made it an opt-in to a 768-float array.
  const out = { ...doc } as Record<string, unknown>;
  // `RECALL_RECORD_DIAGNOSTICS`, not the old union that also held the three ranking scores. Nothing observable
  // changes HERE — a traversed node was never ranked, so it never had a `lexicalScore` to strip — but naming
  // the record set is what stops this line silently becoming the one place that still hides an ordering score
  // if a future change ever attaches one to a node.
  const drop = include ? NEVER_RETURNED_FIELDS : [...RECALL_RECORD_DIAGNOSTICS, ...NEVER_RETURNED_FIELDS];
  for (const k of drop) delete out[k];
  return out as T;
}

/**
 * Turn the flat neighbour list into one tree per seed.
 *
 * Exported for its own tests: the nesting is pure and the BFS is not, and a shape this load-bearing should be
 * assertable without a database.
 */
export function nestNeighbours(flat: SeedTraverseNeighbor[], seedIds: string[]): RecallGraph {
  const byParent = new Map<string, GraphNode[]>();
  const nodeFor = new Map<string, GraphNode>();

  // Shallowest first, so a parent always exists before the child that hangs off it. `traverseRecallSeeds`
  // already sorts by hops, but this function is also called with hand-built lists and must not depend on that.
  const ordered = [...flat].sort((a, b) => a.hops - b.hops);

  for (const n of ordered) {
    const gn: GraphNode = {
      edge: n.edge,
      node: n.record,
      paths: [n.idPath, ...n.altPaths],
      ...(n.altPathsTruncated ? { pathsTruncated: true } : {}),
    };
    nodeFor.set(n._id, gn);
    const siblings = byParent.get(n.parentId) ?? [];
    siblings.push(gn);
    byParent.set(n.parentId, siblings);
  }

  // Attach children to their parents. A child whose parent was dropped by the node limit is attached to the
  // seed its route starts from instead of being discarded: its `paths` still state the real route, so the
  // relationship stays true, and dropping it would make the limit delete a node the caller never asked about.
  const seedSet = new Set(seedIds);
  for (const [parentId, children] of byParent) {
    if (seedSet.has(parentId)) continue;
    const parent = nodeFor.get(parentId);
    if (parent) parent._graph = children;
  }

  const bySeed = new Map<string, GraphNode[]>();
  for (const seedId of seedIds) {
    const direct = byParent.get(seedId);
    if (direct && direct.length > 0) bySeed.set(seedId, direct);
  }
  const orphaned = [...byParent.entries()]
    .filter(([parentId]) => !seedSet.has(parentId) && !nodeFor.has(parentId))
    .flatMap(([, children]) => children);
  for (const child of orphaned) {
    const seedId = child.paths[0]?.[0];
    if (!seedId) continue;
    const list = bySeed.get(seedId) ?? [];
    list.push(child);
    bySeed.set(seedId, list);
  }

  return { bySeed, nodes: nodeFor.size };
}
