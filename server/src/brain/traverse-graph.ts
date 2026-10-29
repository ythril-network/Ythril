/**
 * The graph walk: "starting at ONE node, what is reachable from it". Answers `traverse` and the `graph_traverse`
 * tool, and owns the result types the walk's other modules (`traverse-bodies.ts`, `traverse-page.ts`) shape.
 *
 * Moved out of `edges.ts` (Q-360), which crossed its size limit: the walk is not edge CRUD ("write, read or
 * remove an edge"), and its helpers already lived in their own modules (`traverse-subgraph.ts`,
 * `frontier-query.ts`, `link-frontier.ts`, `edge-endpoint-names.ts`). The recall-seed walk, which starts at
 * the records a search matched, is `recall-seed-traversal.ts`.
 */
import { col, asFilter } from '../db/mongo.js';
import { spaceCollection } from '../db/space-collection.js';
import { NEVER_RETURNED_PROJECTION } from './read-projection.js';
import { linkClassFor, LINK_CLASSES } from './link-adjacency.js';
import { frontierEdgeQuery } from './frontier-query.js';
import { linkedRecordsAtFrontier, recordDisplayName, recordDisplayType }
  from './link-frontier.js';
import { neighbourNodes, startNode } from './edge-endpoint-names.js';
import { subgraphEdges, type TraverseEdge } from './traverse-subgraph.js';
import { syntheticEdgeId } from './edge-id.js';
import type { EdgeDoc, FileMetaDoc } from '../config/types.js';
import type { RefKind } from '../config/types-knowledge.js';

export interface TraverseNode {
  _id: string;
  name: string;
  type: string;
  depth: number;
  /**
   * WHICH collection this node lives in.
   *
   * Absent on an entity — every node was one until chrono entries became reachable, so absence keeps every
   * existing response byte-identical. Present and `'chrono'` on a chrono entry, or `'fact'` on a fact,
   * because each is looked up in a different collection and a caller that follows `_id` needs to know where
   * to look. Guessing from `type` does not work: a chrono's `type` is `event`/`deadline`/…, a fact's is
   * optional entirely, and an entity's is whatever the space calls it.
   */
  kind?: 'chrono' | 'fact' | 'file';
  /**
   * File META only, and only on a `kind: 'file'` node. A file's searchable body is its CHUNKS, which are
   * large and are what recall returns; a traverse answer that carried passage text would blow up in size for
   * a walk that asked about structure. So a file node reports what the file IS — its path as `name`, plus
   * these two — and a caller who wants the content reads it with the file API.
   */
  description?: string;
  tags?: string[];
}

export interface TraverseResult {
  nodes: TraverseNode[];
  edges: TraverseEdge[];
  truncated: boolean;
}

/**
 * The three synthetic link labels, re-exported from where a link is DEFINED.
 *
 * They were declared here, beside the one traversal that emitted them. A second traversal now emits the same
 * three, so they moved onto `LinkClass` — a label is part of what a link is, not part of one walk. These
 * names stay because they are what `edgeLabels` callers and four test suites already spell.
 */
// `!` because `LINK_CLASSES` declares all three — a missing one is a programming error, not a runtime state.
export const CHRONO_LINK_LABEL = linkClassFor('chrono', 'entity')!.label;

/**
 * Every synthetic link label, all six.
 *
 * The three named constants above are the ENTITY classes and keep their names because `edgeLabels`
 * callers and four test suites already spell them. They are no longer the whole set: three more classes
 * gained readers in 4.0, and a caller building an `edgeLabels` filter from the three would silently
 * exclude the other half of the graph.
 */
export const ALL_LINK_LABELS: readonly string[] = LINK_CLASSES.map(c => c.label);

/**
 * BFS graph traversal from a starting entity.
 *
 * ── Chrono entries are nodes ──────────────────────────────────────────────────────────────────────────────
 *
 * A chrono-to-entity link is the only thing joining a chrono to the graph, and until now it was legible to
 * `query()` and invisible to `traverse` — which is the retrieval path an agent reaches for first. An
 * integrator measured the cost: reconstructing a 33-day hardware-RMA timeline took four `query()` calls plus
 * two repo greps, and the first pass still missed the actual carrier ticket, which had to be found by a name
 * regex instead of by traversal from the incident.
 *
 * So a chrono LINKED to a frontier node is reached as though it were joined by an INBOUND
 * edge — which is what that field is. No schema change and no migration: the link already exists, it simply
 * had no reader here.
 *
 * **On by default, because the defect was discoverability.** A flag defaulting to off leaves the graph
 * looking the same to everyone who does not already know the answer. What that costs is a response that can
 * now contain a node from another collection, so every chrono node carries `kind: 'chrono'` and entity nodes
 * are unchanged down to the byte. `includeChrono: false` restores the old shape for a client that assumed
 * one collection.
 *
 * The synthetic edge is labelled `chrono.entityIds` and carries its OWN id — see `syntheticEdgeId`. It used
 * to reuse the chrono's `_id`, on a rationale that was the opposite of true.
 *
 * @param memberIds  Space IDs to search for edges and entities (supports proxy spaces).
 * @param startId    UUID of the starting entity.
 * @param direction  Follow edges from the node (outbound), to the node (inbound), or both.
 * @param edgeLabels If provided, only traverse edges with one of these labels. Also filters the synthetic
 *                   chrono link, which is labelled `chrono.entityIds`.
 * @param maxDepth   Maximum hop count from startId (hard cap enforced by caller).
 * @param limit      Maximum total nodes to return.
 */
export async function traverseGraph(
  memberIds: string[],
  startId: string,
  direction: 'outbound' | 'inbound' | 'both' = 'outbound',
  edgeLabels?: string[],
  maxDepth = 3,
  limit = 100,
  /**
   * Follow chrono-to-entity links inbound, so a chrono entry is reachable from the entities it is
   * about. Default ON — see the note above the function.
   */
  includeChrono = true,
  /**
   * Follow fact-to-entity links the same way, so a fact about an entity is reachable from it.
   *
   * **Default OFF, unlike chrono, and the asymmetry is deliberate.** Chrono defaults on because chrono
   * entries are both invisible otherwise and sparse — an incident has ten, not ten thousand. Facts are
   * usually the most numerous record type in a space, and every node emitted counts against `limit`: on by
   * default, a fact-heavy space would fill the answer with facts and truncate away the entities the
   * caller traversed for. A flag that silently starves the primary result is worse than one you have to know
   * about, so this one is opt-in.
   */
  includeMemories = false,
  /**
   * Follow file-to-entity links, so a document about an entity is reachable from it. Opt-in for the same reason as
   * facts, and the node carries **file meta only** — path, description, tags. Never chunk text: a file's
   * body is its chunks, they are the largest thing the product stores, and a structural walk must not pay for
   * them.
   */
  includeFiles = false,
  /**
   * Whether the returned answer carries the edge list.
   *
   * This does NOT change the walk. Edges are how the graph is traversed, so declining to follow them would
   * return a different set of nodes rather than a smaller payload — the flag is about what comes back, not
   * about what is visited.
   */
  includeEdges = true,
): Promise<TraverseResult> {
  // Set by a link scan that stopped reading rather than running out of matches. It cannot be answered on the
  // spot: the hop's records are already read and belong in the result, so the walk finishes and reports here.
  let scanCapped = false;
  const visited = new Set<string>([startId]);
  // frontier: nodes whose outgoing edges we need to explore at the current depth
  let frontier: string[] = [startId];
  let frontierSet = new Set<string>(frontier);
  let currentDepth = 0;
  const resultNodes: TraverseNode[] = [];
  /** Link-derived hops. They have no stored document, so they are built once and kept as they are. */
  const resultEdges: TraverseEdge[] = [];

  // The subgraph's edges — `Q-24`. See `traverse-subgraph.ts` for what a hand-written version drops.
  const subgraph = subgraphEdges();

  // Three return sites below, and every one of them owed the same decision about the edge list. A rule copied
  // three times is a rule that will eventually disagree with itself, so it is written once here.
  const answer = (truncated: boolean): TraverseResult => ({
    nodes: resultNodes,
    edges: includeEdges ? [...resultEdges, ...subgraph.among()] : [],
    truncated: truncated || edgeScanCapped,
  });

  /**
   * Set when a hop's EDGE read hit its budget (W-11). Read by every return site through `answer` above, for the
   * reason that comment gives: three return sites each owing the same decision is a rule that will disagree
   * with itself.
   *
   * Separate from the link scan's `scanCapped` only because they are set in different places; they mean the
   * same thing and are reported through the same flag.
   */
  let edgeScanCapped = false;

  /*
   * THE START NODE, at depth 0 — which the tool's own schema has always promised and the walk never sent.
   *
   * *"`startId` itself at depth 0, so a walk that finds nothing still comes back with one node rather than
   * empty — an empty `nodes` means the id resolved to nothing, which is a different answer from 'it has no
   * neighbours'."* Measured 2026-09-18: an isolated entity answered `nodes: []`, indistinguishable from a
   * bad id, and that reading cost four probe iterations on an instance where the id was demonstrably good.
   *
   * **Absent when nothing resolves, and that is the other half of the promise.** A placeholder here would
   * make every walk non-empty and destroy the distinction from the other side — "empty means the id
   * resolved to nothing" is only useful while a bad id is actually empty.
   *
   * It counts against `limit` because it IS a node; a node that did not count would be a cap that lies by
   * one. `limit: 1` therefore answers the start alone, which is also the cheapest "does this id exist".
   */
  const started = await startNode(memberIds, startId);
  // `push` returns the new length, so the cap is checked against the value that just changed — and this
  // file is frozen at its size, so the short form is the one that fits beside the reasoning above it.
  if (started) subgraph.reached(startId);
  if (started && resultNodes.push(started) >= limit) return answer(true);

  while (frontier.length > 0 && currentDepth < maxDepth) {
    // Batch-fetch all edges for the current frontier across all member spaces
    const adjacentEdges: EdgeDoc[] = [];
    for (const mid of memberIds) {
      /*
       * BOUNDED, and the bound is documents rather than nodes (W-11).
       *
       * This was `.find(...).toArray()` with no limit, so one hub entity read its entire edge set into fact
       * per hop per member space. `limit` reads as the ceiling and is not: it counts nodes EMITTED, and a
       * neighbour that is already visited or is not an entity is skipped without spending any of it. So the
       * flag stayed quiet in exactly the case where the read was largest — a hub whose edges mostly lead back
       * where you came from.
       *
       * `+ 1` is how truncation is DETECTED rather than guessed: reading one more than the budget says whether
       * there was more, without reading how much more.
       *
       * Same shape as `linkedRecordsAtFrontier` beside it, deliberately — that scan already took a budget and
       * returned `scanCapped`, and its docblock carries the reasoning this comment is short for. Two
       * implementations of one rule is what `frontierEdgeQuery` was extracted to stop; the BOUND is the same
       * kind of rule and belongs on both.
       */
      const hopBudget = Math.max(0, limit - resultNodes.length);
      const q = frontierEdgeQuery(mid, frontier, { edgeLabels, direction });
      const edges = await col<EdgeDoc>(spaceCollection(mid, 'edges'))
        .find(asFilter<EdgeDoc>(q), { projection: NEVER_RETURNED_PROJECTION })
        .limit(hopBudget + 1).toArray() as EdgeDoc[];
      if (edges.length > hopBudget) {
        // A capped scan is a truncation even when the answer never fills up: the budget was spent on documents
        // that are then discarded, so "it did not fill up" says nothing about whether it is complete.
        edgeScanCapped = true;
        edges.length = hopBudget;
      }
      adjacentEdges.push(...edges);
      // Collected here rather than where a neighbour is chosen, because an edge the node loop skips —
      // a self-loop, a second edge to a pair already joined, a same-level connection — is still a
      // relationship among the nodes being returned.
      subgraph.saw(edges);
    }

    // Collect new neighbor IDs (not yet visited) and their traversed edges
    const newNeighborIds: string[] = [];
    /*
     * The KIND each neighbour was declared as, captured where the end is chosen rather than re-derived.
     *
     * An undeclared kind means `entity` — read through `storedEdgeKind` at the write, and the same default
     * applies here. Deriving it a second time from the id would mean guessing which collection to look in,
     * which is exactly what the kind exists to stop.
     */
    const neighborKinds: (RefKind | undefined)[] = [];
    for (const edge of adjacentEdges) {
      let neighborId: string;
      let neighborKind: RefKind | undefined;
      if (direction === 'outbound') {
        neighborId = edge.to;
        neighborKind = edge.toKind;
      } else if (direction === 'inbound') {
        neighborId = edge.from;
        neighborKind = edge.fromKind;
      } else {
        // For 'both', skip if both ends are in the current frontier (same-level connection)
        if (frontierSet.has(edge.from) && frontierSet.has(edge.to)) continue;
        const takeTo = frontierSet.has(edge.from);
        neighborId = takeTo ? edge.to : edge.from;
        neighborKind = takeTo ? edge.toKind : edge.fromKind;
      }
      if (visited.has(neighborId)) continue;
      visited.add(neighborId);
      newNeighborIds.push(neighborId);
      neighborKinds.push(neighborKind);
    }

    // Linked records that point AT the current frontier. A link is an inbound edge in everything but
    // name, so this reads it as one — see the note above the function.
    //
    // Collected BEFORE the early break, and counted by it. Keying the break on entity neighbours alone meant
    // an entity whose only link is a timeline returned nothing at all — which is the reported scenario, not
    // an edge case: an incident with ten chrono entries and no edges is exactly what someone traverses from.
    // Verified against a running server; the source-level gate passed happily either way.
    //
    // Three blocks until 3.6, one per class, differing in the small. `linkedRecordsAtFrontier` is now the
    // only implementation and recall's expansion calls the same one.
    // Bounded by THIS walk's node cap. Without it one hub entity returns its whole mention set per class per
    // member space per hop, and the cap below cannot help because it counts records after they are hydrated.
    const { records: linkedHere, scanCapped: hopScanCapped } = await linkedRecordsAtFrontier(
      memberIds, frontier, visited,
      { includeChrono, includeMemories, includeFiles }, edgeLabels,
      Math.max(0, limit - resultNodes.length));

    /*
     * A capped scan is a truncation even when the result never fills up, and that is the whole point: the
     * bound is spent on documents that are then discarded, so this loop can burn its budget on records
     * already visited and still exit below `limit`. The check on `resultNodes.length` is the only other
     * truncation signal here, and it cannot see that.
     *
     * Remembered rather than returned on: this hop's records HAVE been read and belong in the answer, so
     * leaving here would throw away the very work the bound was spent on. The flag is read at the bottom.
     */
    if (hopScanCapped) scanCapped = true;

    if (newNeighborIds.length === 0 && linkedHere.length === 0) break;

    /*
     * EVERY new neighbour, in whatever collection it lives — entities and, since 5.0, the rest.
     *
     * An edge may declare a `fact`, `chrono` or `file` endpoint; the writer REFUSES a kind that does not
     * match the record, so such an edge is validated, stored, hashed and replicated. This used to read
     * `<space>_entities` alone and `if (!entity) continue` discarded everything else — no flag, no
     * truncation marker. A stored edge that no retrieval path reached, which is report `#695` arriving by
     * a different route.
     *
     * **No include flag gates this, unlike the link scan below.** `includeMemories` and `includeFiles`
     * default off because a fact-heavy space would fill the answer with facts nobody traversed for — an
     * argument about IMPLICIT links, of which a hub entity has thousands. An edge document exists only
     * because somebody drew it, so there are exactly as many as were meant, and gating them would leave
     * the capability inert for everyone who does not already know the flag.
     *
     * The resolution lives in `edge-endpoint-names.ts` because this file is frozen at its size, and the
     * gate that freezes it says why: new behaviour goes BESIDE a god-file rather than inside it.
     */
    const nodeFor = await neighbourNodes(memberIds, newNeighborIds, neighborKinds, currentDepth + 1);

    // Build results for this depth level
    const nextFrontier: string[] = [];
    for (let i = 0; i < newNeighborIds.length; i++) {
      const neighborId = newNeighborIds[i];
      const node = nodeFor.get(neighborId);
      // Still a `continue`, and now it means what it always read as: the record is NOT THERE. An edge can
      // outlive the record it points at, and inventing a placeholder node would be a fact the walk made up.
      if (!node) continue;

      // The reaching edge is no longer pushed here: it is in `storedEdges` with every other edge read
      // this hop, and pushing it again would report it twice.
      subgraph.reached(neighborId);
      resultNodes.push(node);

      if (resultNodes.length >= limit) {
        return answer(true);
      }

      /*
       * It joins the next frontier, AND THAT IS THE DIFFERENCE from a linked record.
       *
       * The scan below deliberately does not expand its records: a link only ever points back at entities,
       * so walking on from one returns where you came from. An explicit edge CHAINS — a `supersedes` from
       * the newest claim to the one before it to the one before that is the shape the knowledge-updates
       * case is made of — so stopping here would answer one hop of a chain and call it the neighbourhood.
       */
      nextFrontier.push(neighborId);
    }

    // A linked record is emitted at this depth but does NOT join the next frontier: it links to entities,
    // never to another record of its own kind, so expanding from one would only walk back to entities
    // already visited. Files carry their meta — never chunk text, which is what the class projection is for.
    for (const rec of linkedHere) {
      // A link has no stored document, so it is pushed rather than collected — it cannot be filtered
      // against the emitted set because it is created at the same moment its node is.
      resultEdges.push({
        _id: syntheticEdgeId(rec.label, rec.via, rec.doc._id), from: rec.via, to: rec.doc._id, label: rec.label,
      });
      subgraph.reached(rec.doc._id);
      const file = rec.kind === 'file' ? rec.doc as FileMetaDoc : undefined;
      resultNodes.push({
        _id: rec.doc._id, name: recordDisplayName(rec.kind, rec.doc), type: recordDisplayType(rec.kind, rec.doc),
        depth: currentDepth + 1, kind: rec.kind,
        ...(file?.description ? { description: file.description } : {}),
        ...(file?.tags && file.tags.length > 0 ? { tags: file.tags } : {}),
      });
      if (resultNodes.length >= limit) {
        return answer(true);
      }
    }

    frontier = nextFrontier;
    frontierSet = new Set<string>(frontier);
    currentDepth++;
  }

  // NOT `answer(false)`. The walk ran out of frontier, which is what a complete neighbourhood looks like —
  // and also what a neighbourhood looks like when a scan stopped reading and the records it would have
  // reached were never added to it. Only the flag can tell those apart.
  return answer(scanCapped);
}

// The recall-augmenting traversal lives in `recall-seed-traversal.ts` (A-4): 374 lines, and a different
// subject from the walk above — that one starts at ONE node, this one at the records a search matched.
// `frontierEdgeQuery` and `TraverseNarrowing`, which BOTH use, went sideways into `frontier-query.ts`.