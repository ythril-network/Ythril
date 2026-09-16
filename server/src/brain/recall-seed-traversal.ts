/**
 * The graph expansion `recall` and `find_similar` perform around their matches.
 *
 * ## Why its own module (A-4)
 *
 * `edges.ts` was 688 code lines against a 650 ceiling, and its raise was owed a decomposition. This is the
 * largest coherent thing in it and the only one with a different subject: `traverseGraph` answers "walk out
 * from ONE start node", while this answers "walk out from the records a search matched" — a different entry
 * shape, a different budget, a pre-pass that follows a matched record's `entityIds` out to entities, and
 * `paths`/`altPaths` bookkeeping the standalone walk has no use for.
 *
 * ## What did NOT come along
 *
 * `frontierEdgeQuery` and `TraverseNarrowing`, which both traversals use — they went sideways into
 * `frontier-query.ts` rather than travelling here, because a shared helper taken along leaves a copy behind.
 * `frontierEdgeQuery` was itself written twice once, with the copies disagreeing, so duplicating it during the
 * extraction that separates its callers would have repeated the exact defect it exists to fix.
 *
 * `syntheticEdgeId` stays in `edges.ts`: the standalone traversal builds those ids too, and the id format is a
 * fact about edges rather than about this walk.
 */

import { col, asFilter } from '../db/mongo.js';
import { NEVER_RETURNED_PROJECTION } from './read-projection.js';
import { linkedRecordsAtFrontier, entitiesLinkedFromRecords, linkedRecordName, linkedRecordType, type LinkedRecord } from './link-frontier.js';
import { frontierEdgeQuery, type TraverseNarrowing } from './frontier-query.js';
import { syntheticEdgeId } from './edges.js';
import type { EdgeDoc, EntityDoc, FileMetaDoc } from '../config/types.js';

/** Hard cap on the `traverse` depth accepted by graph-augmented recall. */
export const MAX_RECALL_TRAVERSE = 5;

/**
 * How many ALTERNATE routes to one node are recorded before the rest are dropped.
 *
 * A dense graph can reach one node dozens of ways, and every one of them is a small array copied per hop. The
 * cap is reported (`altPathsTruncated`) rather than silent: a caller that cannot tell "these are all the
 * routes" from "these are the first eight" can conclude something false from the shape, which is the defect
 * B-19 was filed for one function over.
 */
export const MAX_ALT_PATHS_PER_NODE = 8;

/**
 * The edge a hop reports when there is no stored edge to report.
 *
 * A link is a FIELD, not a record, so the hop that followed one has no `author`, no `createdAt` and no `seq`.
 * Inventing them to satisfy `EdgeDoc` would put fabricated timestamps in a response, and returning `null`
 * instead would make every consumer branch on a case that is not exceptional. So the hop edge is a union and
 * a derived edge carries exactly what is derived: an id (`<label>:<from>:<to>`), the two ends, and the label
 * that says it came from a field.
 */
export interface SyntheticLinkEdge {
  _id: string;
  spaceId: string;
  from: string;
  to: string;
  label: string;
}

/** The edge for one traversed hop: a stored relationship, or a link expressed as one. */
export type TraverseHopEdge = EdgeDoc | SyntheticLinkEdge;

/** The record one hop reached. Non-entity kinds carry `kind`; an entity does not, and never did. */
export type TraverseHopRecord = EntityDoc | (LinkedRecord['doc'] & { kind: LinkedRecord['kind'] });

/** A neighbour reached by following the edge graph out from a recall seed set. */
/**
 * What a seed traversal reached, and whether a link scan stopped reading before it ran out of matches.
 *
 * Separate from `altPathsTruncated`, which is per node and about ROUTES. This one is about the walk: it says
 * the neighbourhood is short, and it exists because the length checks the callers already had cannot tell —
 * a capped scan finishes below the cap it was capped by.
 */
export interface SeedTraverse {
  neighbours: SeedTraverseNeighbor[];
  scanCapped: boolean;
}

export interface SeedTraverseNeighbor {
  _id: string;
  spaceId: string;
  /** Hop distance from the nearest seed (1 = directly connected to a seed). */
  hops: number;
  /** Edge chain connecting the nearest seed to this neighbour (shortest path). */
  path: { from: string; label: string; to: string }[];
  /**
   * The reached record (embedding stripped).
   *
   * An entity arrives whole. A record reached through a LINK — a chrono entry, fact or file whose
   * `entityIds` names something on the frontier — arrives holding its class projection and carrying `kind`,
   * exactly as `TraverseNode.kind` reports it on the standalone tool. `kind` is absent on an entity, so
   * every response that existed before this is unchanged down to the byte.
   */
  record: TraverseHopRecord;
  /** The record this one was reached FROM — its parent in the nesting. A seed id at hop 1. */
  parentId: string;
  /**
   * The WHOLE edge document for the reaching hop, not `{from, label, to}`.
   *
   * Its `description` is where the reason for a link lives, and its `tags` are how a caller filters one kind of
   * relationship from another. Reducing the edge to three fields threw both away on every traversal.
   *
   * A LINK hop has no stored edge, so it carries a synthetic one — see `SyntheticLinkEdge`.
   */
  edge: TraverseHopEdge;
  /** Ordered record ids, seed first and this node last. `idPath.length - 1` is the hop count. */
  idPath: string[];
  /** Every OTHER route from a seed to this node, ids in the same seed-first order. */
  altPaths: string[][];
  /** True when more routes exist than `MAX_ALT_PATHS_PER_NODE` recorded. */
  altPathsTruncated: boolean;
}

/**
 * Multi-source, depth-limited BFS over the edge graph of a SINGLE space, seeded
 * from a set of recall-match IDs. Follows edges in BOTH directions, records the
 * shortest path to each neighbour (BFS visit order guarantees shortest-first),
 * and detects cycles via a visited set so a circular graph never loops or
 * duplicates. Neighbours are hydrated as entities within THIS space only — an
 * edge pointing at an id absent from the space (e.g. a cross-space edge to a
 * space the caller can't see) yields no neighbour and is silently skipped.
 * Batched `$in` lookups keep this to ~2 queries per hop regardless of fan-out.
 */

export async function traverseFromSeeds(
  spaceId: string,
  seedIds: string[],
  maxDepth: number,
  limit: number,
  narrowing?: TraverseNarrowing,
): Promise<SeedTraverse> {
  if (seedIds.length === 0 || maxDepth < 1 || limit < 1) return { neighbours: [], scanCapped: false };

  // Set by either link scan when it stopped reading rather than running out of matches. Carried out rather
  // than returned early: unlike the standalone traversal this one has a pre-pass whose results are still
  // wanted, so the honest answer is "here is what was reached, and it is short".
  let capped = false;
  const visited = new Set<string>(seedIds);
  const pathTo = new Map<string, { from: string; label: string; to: string }[]>();
  for (const id of seedIds) pathTo.set(id, []);
  // Ordered ids per node, seed first. This is what makes the chain's DIRECTION readable: the old `path` stored
  // each edge's own from/label/to, so orienting it meant intersecting the first entry against the seed set.
  const idPathTo = new Map<string, string[]>();
  for (const id of seedIds) idPathTo.set(id, [id]);
  // Routes to a node OTHER than the one it is nested under. The old loop skipped a visited neighbour outright,
  // so a node reachable two ways was attributed to whichever edge won the race and the other link was invisible.
  const altPathTo = new Map<string, string[][]>();
  const altTruncated = new Set<string>();
  const reachedBy = new Map<string, { parentId: string; edge: EdgeDoc }>();

  let frontier: string[] = [...new Set(seedIds)];
  let frontierSet = new Set<string>(frontier);
  let depth = 0;
  const results: SeedTraverseNeighbor[] = [];
  /** Entities reached from a non-entity SEED's own links. Hop 1, so they join the frontier at depth 1. */
  const deferred: string[] = [];

  // ── A non-entity seed is no longer a dead end ──────────────────────────────────────────────────────────
  //
  // Edge endpoints are entity ids, so a fact, chrono entry or file that MATCHED semantically had nothing to
  // follow: `recall(traverse: n)` returned it with an empty `_graph` at any depth, and both doors documented
  // that and told the caller to lift the `entityIds` off the match and traverse from one of those by hand.
  //
  // That instruction was the query below, performed by the caller because the server declined to. Reading it
  // here makes the seed's own links a first hop, so the walk continues from the entities it names — which is
  // what makes the rest of the traversal reachable from a matched fact at all.
  //
  // Once, on the seeds. Everything reached afterwards is an entity or a leaf.
  if (narrowing?.includeChrono || narrowing?.includeMemories || narrowing?.includeFiles) {
    const { records: outbound, scanCapped: seedScanCapped } = await entitiesLinkedFromRecords(
      [spaceId], frontier, narrowing, narrowing.edgeLabels, limit);
    if (seedScanCapped) capped = true;
    const wanted = outbound.filter(l => !visited.has(l.to));
    if (wanted.length > 0) {
      const linkedEntities = await col<EntityDoc>(`${spaceId}_entities`)
        .find(asFilter<EntityDoc>({ _id: { $in: [...new Set(wanted.map(l => l.to))] } }))
        .project(NEVER_RETURNED_PROJECTION)
        .toArray() as EntityDoc[];
      const byId = new Map(linkedEntities.map(e => [e._id, e]));
      for (const link of wanted) {
        const entity = byId.get(link.to);
        // Absent means the id names something outside this space, exactly as a cross-space edge target does.
        if (!entity || visited.has(link.to)) continue;
        visited.add(link.to);
        pathTo.set(link.to, [{ from: link.from, label: link.label, to: link.to }]);
        idPathTo.set(link.to, [link.from, link.to]);
        altPathTo.set(link.to, []);
        results.push({
          _id: entity._id, spaceId, hops: 1, path: pathTo.get(link.to) ?? [], record: entity,
          parentId: link.from,
          edge: { _id: syntheticEdgeId(link.label, link.from, link.to), spaceId, from: link.from, to: link.to, label: link.label },
          idPath: [link.from, link.to], altPaths: altPathTo.get(link.to) ?? [], altPathsTruncated: false,
        });
        if (results.length >= limit) return { neighbours: stampTruncation(results, altTruncated), scanCapped: capped };
        // Held for the NEXT frontier, not this one. These entities are hop 1, and the loop below emits what a
        // frontier reaches at `depth + 1` — putting them beside the seeds would make everything one edge past
        // them arrive labelled hop 1 and, worse, be walked at all on a `traverse: 1` that has no budget for it.
        deferred.push(link.to);
      }
    }
  }

  while (frontier.length > 0 && depth < maxDepth) {
    const hopBudget = Math.max(0, limit - results.length);
    const edges = await col<EdgeDoc>(`${spaceId}_edges`)
      // An EDGE is a searchable record with a vector of its own, and this query fetched it whole: the edge
      // document is returned verbatim as `_graph[].edge`, so a `recall(traverse: n)` shipped a full float
      // array per hop, on both doors. Nothing consumes it — `nestNeighbours` only nests the document — so
      // dropping it is pure subtraction.
      //
      // **This comment used to claim it was "matching the entity query below and every other read path in
      // the codebase". That was false, and the claim is why nobody checked.** Five readers had no projection
      // at all — the three list functions and the two entity lookups — and a caller measured 11.19 MB from
      // `GET /entities?limit=500` where `/query` answered 0.145 MB. All of them now share
      // `NEVER_RETURNED_PROJECTION`, so the sentence is true; do not restate universality here again, because
      // the constant is what makes it true and a comment cannot.
      //
      // NARROWED, since 3.5: `edgeLabels` and `direction` reach here now. They did not before, so recall's
      // expansion followed every edge both ways while the standalone `traverse` tool — building the same
      // query twenty lines away — applied both. One rule, two implementations, and this was the weaker one.
      //
      // The `spaceId` field is in the predicate because `frontierEdgeQuery` is shared with the standalone
      // path, which queries across member spaces by name and needs it. Here the collection name already scopes
      // it, so the extra clause is redundant rather than wrong — see the note below on why filtering the
      // ENTITY read on a redundant spaceId was actively harmful.
      .find(asFilter<EdgeDoc>(frontierEdgeQuery(spaceId, frontier, narrowing)))
      .project(NEVER_RETURNED_PROJECTION)
      // Bounded for the same reason as the standalone walk's, and with the same `+ 1` truncation probe (W-11):
      // unbounded, one hub read its whole edge set per hop, and the node cap counts hydrated rows rather than
      // documents. The rule belongs on BOTH paths — these two have drifted before, twenty lines apart, which is
      // why `frontierEdgeQuery` exists at all.
      .limit(hopBudget + 1)
      .toArray() as EdgeDoc[];
    if (edges.length > hopBudget) {
      capped = true;
      edges.length = hopBudget;
    }

    const newNeighborIds: string[] = [];
    for (const edge of edges) {
      // Same-level edge (both ends already in the frontier) — introduces no new node.
      if (frontierSet.has(edge.from) && frontierSet.has(edge.to)) continue;
      const frontierEnd = frontierSet.has(edge.from) ? edge.from : edge.to;
      const neighborId = frontierEnd === edge.from ? edge.to : edge.from;
      const routeHere = [...(idPathTo.get(frontierEnd) ?? [frontierEnd]), neighborId];
      if (visited.has(neighborId)) {
        // Already nested somewhere: this is a SECOND route to it, so record the route without re-nesting or
        // re-expanding the node. `paths` carrying every route is what lets one node object stay one row —
        // duplicating it under each parent would make a caller counting rows double-count the same record.
        const alts = altPathTo.get(neighborId);
        if (alts) {
          const known = [idPathTo.get(neighborId)?.join('>'), ...alts.map(p => p.join('>'))];
          if (!known.includes(routeHere.join('>'))) {
            if (alts.length >= MAX_ALT_PATHS_PER_NODE) altTruncated.add(neighborId);
            else alts.push(routeHere); // the live array — see where it is created
          }
        }
        continue;
      }
      visited.add(neighborId);
      pathTo.set(neighborId, [...(pathTo.get(frontierEnd) ?? []), { from: edge.from, label: edge.label, to: edge.to }]);
      idPathTo.set(neighborId, routeHere);
      // Created HERE, so the array the result object gets is the one later hops push alternates into. Building
      // it with `?? []` at push time would hand out a copy that no later discovery could reach — and an
      // alternate route is usually found at a deeper hop than the one that nested the node.
      altPathTo.set(neighborId, []);
      reachedBy.set(neighborId, { parentId: frontierEnd, edge });
      newNeighborIds.push(neighborId);
    }

    // Records that point AT the current frontier through `entityIds`, which is an inbound link in everything
    // but name. Until 3.6 this walk followed stored edges ALONE, while the standalone `traverse` tool —
    // building the same query in the same file — followed both. One rule, two implementations, and the one
    // reachable from a search had the weaker: in a space whose relationships are mentions rather than edge
    // records, which is most spaces, `recall(traverse: n)` returned an empty graph and said nothing about why.
    //
    // Collected BEFORE the break for the same reason the standalone walk collects it there: a seed whose only
    // links are a timeline is not a dead end, and keying the break on entity neighbours alone would make it
    // look like one.
    // Same bound, same reason — and it matters more here, because this is the RECALL path: a depth-N call
    // with all three flags on makes up to 3N of these reads.
    const { records: linkedHere, scanCapped: hopScanCapped } = await linkedRecordsAtFrontier(
      [spaceId], frontier, frontierSet, visited, narrowing ?? {}, narrowing?.edgeLabels,
      Math.max(0, limit - results.length));
    if (hopScanCapped) capped = true;

    // `deferred` counts: a fact seed has no edges and links nothing backwards, so both counters above are
    // zero on its first pass — breaking there would discard the entities its own links reached and undo the
    // whole point of the pre-pass.
    if (newNeighborIds.length === 0 && linkedHere.length === 0 && deferred.length === 0) break;

    // NOTE: no `spaceId` filter here — deliberately, and it must stay that way.
    //
    // The edge query above (same loop) does not filter on the spaceId field either, and the
    // collection name `{spaceId}_entities` is already the only real scope. When the two
    // disagreed, a document with a stale spaceId produced the worst possible outcome: the
    // EDGE was found but its neighbour ENTITY was silently dropped, so a traversal returned
    // half a graph with no error. Filtering on a redundant, denormalised field is what made
    // a space rename hide data in the first place.
    const entities = await col<EntityDoc>(`${spaceId}_entities`)
      .find(asFilter<EntityDoc>({ _id: { $in: newNeighborIds } }))
      .project(NEVER_RETURNED_PROJECTION)
      .toArray() as EntityDoc[];
    const entityMap = new Map<string, EntityDoc>();
    for (const e of entities) entityMap.set(e._id, e);

    const nextFrontier: string[] = [];
    for (const neighborId of newNeighborIds) {
      const entity = entityMap.get(neighborId);
      if (!entity) continue; // not an entity in this space (e.g. cross-space edge target) — skip
      const reached = reachedBy.get(neighborId);
      if (!reached) continue; // unreachable in practice: every new neighbour is recorded above with its edge
      results.push({
        _id: entity._id, spaceId, hops: depth + 1, path: pathTo.get(neighborId) ?? [], record: entity,
        parentId: reached.parentId, edge: reached.edge, idPath: idPathTo.get(neighborId) ?? [neighborId],
        altPaths: altPathTo.get(neighborId) ?? [], altPathsTruncated: false,
      });
      if (results.length >= limit) return { neighbours: stampTruncation(results, altTruncated), scanCapped: capped };
      nextFrontier.push(neighborId);
    }

    // Linked records are LEAVES — they do not join the next frontier. A chrono entry links to entities, never
    // to another chrono entry, so expanding from one would only walk back to entities already visited.
    //
    // They carry no `altPaths`: a second route to a linked record would have to arrive through a second
    // frontier entity in the same hop, and `visited` claims it at the first. Recording that properly means
    // the same alternate-route bookkeeping the edge half does, and it is deliberately not built here — an
    // empty array is the truthful shape for "one route recorded", which is also what a first-hop entity
    // reports.
    for (const rec of linkedHere) {
      const viaPath = idPathTo.get(rec.via) ?? [rec.via];
      results.push({
        _id: rec.doc._id,
        spaceId,
        hops: viaPath.length,
        path: [...(pathTo.get(rec.via) ?? []), { from: rec.via, label: rec.label, to: rec.doc._id }],
        // `spaceId` stamped rather than projected: the class projection is shared with the ER scan, which has
        // no use for it, and the walk already knows which space it is reading. Without it a linked node would
        // be the only node in the answer that cannot say where it lives.
        record: { ...rec.doc, spaceId, kind: rec.kind },
        parentId: rec.via,
        edge: { _id: syntheticEdgeId(rec.label, rec.via, rec.doc._id), spaceId, from: rec.via, to: rec.doc._id, label: rec.label },
        idPath: [...viaPath, rec.doc._id],
        altPaths: [],
        altPathsTruncated: false,
      });
      if (results.length >= limit) return { neighbours: stampTruncation(results, altTruncated), scanCapped: capped };
    }

    // The seed's own linked entities join here, once, on the first pass — see `deferred`.
    nextFrontier.push(...deferred.splice(0));

    frontier = nextFrontier;
    frontierSet = new Set<string>(frontier);
    depth++;
  }

  return { neighbours: stampTruncation(results, altTruncated), scanCapped: capped };
}

/**
 * Stamp `altPathsTruncated` once the walk is over.
 *
 * A node is pushed into the results the hop it is reached, but its alternate routes keep being discovered for
 * every hop after that — so the flag cannot be computed at push time. `altPaths` itself is a live array and
 * needs no fixing up; a boolean cannot be.
 */
function stampTruncation(results: SeedTraverseNeighbor[], truncated: Set<string>): SeedTraverseNeighbor[] {
  if (truncated.size > 0) for (const r of results) r.altPathsTruncated = truncated.has(r._id);
  return results;
}

/**
 * Expand a set of recall seeds into their graph neighbours across the caller's
 * authorized spaces. Seeds are grouped by space (only spaces in `memberIds` are
 * traversed — the cross-space access guard), each space is BFS-expanded via
 * `traverseFromSeeds`, and the merged neighbours are truncated to `limit` with
 * lower-hop results preferred. Never touches a space outside `memberIds`.
 */
export async function traverseRecallSeeds(
  memberIds: string[],
  seeds: { _id: string; spaceId: string }[],
  maxDepth: number,
  limit: number,
  narrowing?: TraverseNarrowing,
): Promise<SeedTraverse> {
  if (seeds.length === 0 || maxDepth < 1 || limit < 1) return { neighbours: [], scanCapped: false };
  const allowed = new Set(memberIds);
  const bySpace = new Map<string, string[]>();
  for (const s of seeds) {
    if (!allowed.has(s.spaceId)) continue;
    const arr = bySpace.get(s.spaceId) ?? [];
    arr.push(s._id);
    bySpace.set(s.spaceId, arr);
  }

  const collected: SeedTraverseNeighbor[] = [];
  // Any member space whose scan stopped early makes the WHOLE answer short — the caller sees one merged
  // neighbourhood and cannot tell which space came back partial.
  let scanCapped = false;
  for (const [sid, ids] of bySpace) {
    const walk = await traverseFromSeeds(sid, ids, maxDepth, limit, narrowing);
    collected.push(...walk.neighbours);
    if (walk.scanCapped) scanCapped = true;
  }
  collected.sort((a, b) => a.hops - b.hops); // prefer lower-hop neighbours when truncating
  // Dropping the tail here is itself a truncation, and it was already reported by length downstream. Saying
  // it explicitly costs nothing and stops that reporting depending on a comparison made in another file.
  if (collected.length > limit) scanCapped = true;
  return { neighbours: collected.slice(0, limit), scanCapped };
}
