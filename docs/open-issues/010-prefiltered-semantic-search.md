# [Feature] Prefiltered semantic search — combine vector similarity with property equality filters

**Labels:** `enhancement`, `recall`, `search`
**Repo:** https://github.com/ythril-network/Ythril

---

## Summary

The `recall` tool and `GET /api/recall` endpoint currently perform pure vector similarity search across all records of a given type. There is no way to restrict the candidate set to records where a specific property equals a specific value before (or after) computing similarity. Adding property filter expressions — e.g. `properties.status = "active"` — as a first-class parameter to recall dramatically improves precision and enables workloads that are currently impossible (e.g. "find memories about auth that are tagged as unresolved").

## Current behaviour

- `recall` accepts `space`, `query`, `types[]`, `tags[]`, `topK`, and `minScore`.
- `tags[]` is an AND filter on the record's top-level `tags` array — the only filtering capability today.
- `properties.*` fields are embedded but there is no way to filter on them pre- or post-similarity.
- Workaround: retrieve a large `topK`, then filter client-side — wasteful and misses records that ranked below topK but would pass the filter.

## Desired behaviour

### New `filter` parameter on `recall` / `GET /api/recall`

```json
{
  "query": "authentication flow decisions",
  "space": "adrs",
  "types": ["entity", "memory"],
  "filter": {
    "properties.status": { "eq": "accepted" },
    "properties.domain": { "eq": "security" }
  }
}
```

Filter expressions applied **before** vector similarity scoring (pre-filter on the MongoDB `$vectorSearch` `filter` param where supported, or as a `$match` stage in the aggregation pipeline before `$vectorSearch`).

### Supported operators (MVP)

| Operator | Meaning |
|---|---|
| `eq` | Exact equality (`=`) |
| `ne` | Not equal (`!=`) |
| `in` | Value is in array (`["a","b"]`) |
| `exists` | Property is present (boolean) |
| `gt`, `gte`, `lt`, `lte` | Numeric comparisons |

### MCP tool surface

Extend the `recall` MCP tool with an optional `filter` argument:

```
filter: Record<string, { eq | ne | in | exists | gt | gte | lt | lte }>
```

Document that keys must use dot-notation for nested properties (e.g. `properties.status`, not `status`).

### MongoDB implementation note

MongoDB Atlas `$vectorSearch` supports a `filter` document for pre-filtering on indexed scalar fields. The implementation should add those property fields to the Atlas vector search index definition and pass the filter document directly for maximum efficiency. For self-hosted MongoDB (non-Atlas), fall back to a `$match` stage immediately before `$vectorSearch` in the aggregation pipeline.

## Use case

1. **Status-gated agent workflows:** An AI agent querying "what ADRs are about security?" wants only `status: accepted` ADRs — not proposals that were later superseded.
2. **Domain-scoped recall:** `properties.domain = "infra"` narrows recall to infrastructure concerns without polluting results with unrelated domains.
3. **Time-bounded queries:** `properties.createdYear = 2026` combined with a natural-language query restricts results to the current year.
4. **Debugging:** `filter: { "properties.validationMode": { "eq": "strict" } }` finds only spaces that have strict validation enabled.

## Scope

- **In scope:** `filter` parameter on `recall` tool and REST endpoint; pre-filter execution in MongoDB aggregation; `eq`, `ne`, `in`, `exists`, `gt/gte/lt/lte` operators; dot-notation property paths; updated MCP tool description with filter syntax docs.
- **Out of scope:** Full query DSL (OR logic, nested AND/OR), full-text filter expressions, cross-type joins, SQL-style `SELECT` projection.

## Implementation Plan

1. Define `FilterExpression` type: `Record<string, { eq?, ne?, in?, exists?, gt?, gte?, lt?, lte? }>`.
2. Add `filter` param to `recall` REST endpoint schema and MCP tool definition.
3. Build a `buildMongoFilter(filter: FilterExpression)` helper that converts the expression to a MongoDB match document.
4. In the recall aggregation pipeline: insert the match document as a pre-filter on `$vectorSearch` (Atlas) or as a `$match` stage (self-hosted).
5. Validate filter keys against a whitelist (must start with `properties.`, `tags`, `type`, `name`) to prevent arbitrary query injection.
6. Add integration tests: recall with `filter.properties.status = "accepted"` returns only accepted ADRs; records with other statuses are absent regardless of similarity score.
7. Update the integration guide with filter syntax documentation and examples.

## Acceptance Criteria

- [ ] `recall` with `filter: { "properties.status": { "eq": "accepted" } }` returns only records where `properties.status === "accepted"`.
- [ ] A record with high similarity but a non-matching filter value is **not** returned.
- [ ] `filter: { "properties.count": { "gt": 10 } }` correctly applies numeric comparison.
- [ ] `filter: { "tags": { "in": ["security", "auth"] } }` returns records tagged with either value (note: `in` on tags = any-of, not AND).
- [ ] Filter keys not starting with `properties.`, `tags`, `type`, or `name` are rejected with a 400 error (injection prevention).
- [ ] Existing `recall` calls without `filter` are unaffected.
- [ ] MCP tool description documents the filter syntax with a clear example.

## Verification Evidence

- PR/commit:
- Test output:
- Logs/screenshots:

## Risk and Rollback

- **Risk:** Pre-filtering on non-indexed fields in self-hosted MongoDB causes a collection scan before vector search — document that heavy-use filter fields should be indexed.
- **Risk:** Filter key validation whitelist must be maintained as new top-level fields are added to knowledge types.
- **Rollback:** `filter` is a new optional param; omitting it restores exact current behaviour.

## Ownership

- Owner:
- Due date (optional):
