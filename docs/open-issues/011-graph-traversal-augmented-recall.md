# [Feature] Graph-traversal augmented recall — optionally follow edges N hops from semantic matches

**Labels:** `enhancement`, `recall`, `graph`, `search`
**Repo:** https://github.com/ythril-network/Ythril

---

## Summary

`recall` finds semantically similar records but returns them in isolation. The graph structure (edges between entities, memories linked to entities) is not consulted during retrieval. Adding an optional `traverse` parameter — `traverse: N` — instructs the server to follow edges up to N hops from every matched record and include the reached neighbours in the response. This turns semantic search into a context-aware knowledge retrieval that respects the relationships already encoded in the graph.

## Current behaviour

- `recall` returns a flat list of the top-K most similar records.
- Related entities and memories reachable via edges are not returned unless they themselves ranked in the top-K by similarity.
- An agent that needs "everything connected to ADR-0042" must make N separate `query` calls after recall — or already know the entity name.
- The graph topology built by `upsert_edge` is unused during retrieval.

## Desired behaviour

### New `traverse` parameter on `recall`

```json
{
  "query": "authentication token scoping",
  "space": "adrs",
  "traverse": 2
}
```

Behaviour:
1. Execute the standard vector similarity search to find seed records (top-K matches above `minScore`).
2. For each seed record, follow all outbound **and** inbound edges up to `traverse` hops in the knowledge graph.
3. Return the seed set plus all reached neighbours, each annotated with:
   - `source: "recall"` (directly matched) or `source: "traverse"` (reached via graph)
   - `hops: N` (0 = seed, 1 = one edge away, etc.)
   - `path: [{from, label, to}]` — the edge chain that connected this record to the seed
4. Deduplicate: if a record is reachable via multiple paths, keep the shortest path and mark it once.
5. Default `traverse: 0` — no graph expansion, identical to today's behaviour.

### Response shape change

```json
{
  "results": [
    {
      "score": 0.91,
      "source": "recall",
      "hops": 0,
      "path": [],
      "spaceId": "adrs",
      "type": "entity",
      "record": { ... }
    },
    {
      "score": null,
      "source": "traverse",
      "hops": 1,
      "path": [{ "from": "adr-0042", "label": "implements", "to": "adr-0079" }],
      "spaceId": "adrs",
      "type": "entity",
      "record": { ... }
    }
  ],
  "count": 2,
  "traverseDepth": 2
}
```

`score` is `null` for traversal-only results (they were not ranked by the vector search).

### MCP tool surface

Extend the `recall` MCP tool with an optional `traverse` argument (integer, 0–5, default 0). Document that `traverse > 2` on dense graphs may be slow and should be used with `filter` or `tags` to narrow the seed set.

### Guard rails

- Hard cap: `traverse` max = 5 (configurable server-side).
- Result cap: total returned records (seed + traversal) capped at `topK * (traverse + 1) * 4` by default, configurable.
- Cycle detection: visited record IDs tracked per traversal; cycles do not produce duplicate results.
- Cross-space edges: when an edge points to a record in another space, traverse only if the requesting token has access to that space.

## Use case

1. **Agent context loading:** Recall "what do we know about the Vault service?" with `traverse: 1` returns the Vault entity, all its linked ADRs, all linked memories about incidents or decisions — without needing to name each one.
2. **Impact analysis:** Recall a changed component entity; `traverse: 2` surfaces all downstream services, open issues, and related decisions automatically.
3. **Knowledge exploration:** A new team member queries any topic and gets not just the matching record but the surrounding cluster of related knowledge, providing immediate context.
4. **Debugging:** Recall an error memory; `traverse: 1` brings in the linked service entity and the ADR that governs its behaviour — the full picture in one call.

## Scope

- **In scope:** `traverse: N` on `recall` (REST + MCP); edge following (outbound + inbound); hop annotation; path annotation; cycle detection; cross-space guard; result cap.
- **Out of scope:** Weighted traversal (prioritising high-weight edges), directional-only traversal (out vs in as separate options), graph visualisation, `query` tool traversal (separate issue if needed).

## Implementation Plan

1. Add `traverse` (integer, 0–5, default 0) to recall endpoint schema and MCP tool definition.
2. Implement `traverseFromSeeds(seeds, depth, token)`:
   - BFS over the edge collection, depth-limited to `traverse` hops.
   - At each hop, fetch all edges where `from` or `to` = any visited record ID.
   - Fetch the neighbour record; check token access for cross-space records.
   - Track visited IDs in a `Set` to detect cycles.
3. Merge seed results and traversal results; annotate each with `source`, `hops`, `path`.
4. Apply total result cap; prefer lower-hop results when truncating.
5. Update response schema to include `traverseDepth` field.
6. Add integration tests:
   - `traverse: 0` → same as today.
   - `traverse: 1` → seed + direct neighbours returned.
   - Cycle in graph → no infinite loop, no duplicate records.
   - Cross-space edge to inaccessible space → neighbour omitted silently.
7. Update integration guide: document `traverse` param, guard rails, and performance guidance.

## Acceptance Criteria

- [ ] `recall` with `traverse: 0` is behaviourally identical to the current implementation.
- [ ] `recall` with `traverse: 1` returns seed records AND their directly-connected neighbours via any edge.
- [ ] Each traversal result carries `source: "traverse"`, `hops: 1`, and `path` showing the connecting edge.
- [ ] A circular edge graph (A → B → A) does not cause infinite traversal or duplicate results.
- [ ] A cross-space edge to a space not accessible to the requesting token is silently skipped (no 403 leak).
- [ ] `traverse: 6` is rejected with 400 (exceeds server cap).
- [ ] Total result count is bounded by the configured cap even on very dense graphs.
- [ ] MCP tool description documents the `traverse` argument with a usage example.

## Verification Evidence

- PR/commit:
- Test output:
- Logs/screenshots:

## Risk and Rollback

- **Risk:** BFS on a dense graph with `traverse: 3+` can issue hundreds of MongoDB queries — implement BFS with batched edge lookups (`$in` on ID array), not one query per node.
- **Risk:** Result cap must be enforced strictly; an unbounded traversal response could exhaust agent context windows.
- **Rollback:** `traverse` defaults to 0; no existing call is affected. Removing the param from the schema reverts completely.

## Ownership

- Owner:
- Due date (optional):
