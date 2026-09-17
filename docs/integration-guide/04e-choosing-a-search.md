# Choosing a Search

> Part of the [Ythril Integration Guide](../integration-guide.md).

## Choosing a Search

Ythril has four ways to look things up, and they are not interchangeable. Picking the wrong one is the most common
reason a search "does not work": the call succeeds, returns something plausible, and misses the thing you wanted.

This page is the decision, then the tuning. The parameters themselves are documented per endpoint in
[Recall & Similarity](04a-recall-api.md), [Entities, Edges & Graph](04b-graph-api.md) and
[Brain Ops](04d-brain-ops-api.md).

## The one-line rule

| you know | use |
|---|---|
| roughly **what it says** | `recall` — meaning-ranked |
| exactly **which field equals what** | `query` — a filter, no ranking |
| **a record**, and want ones like it | `similar` — no re-embedding |
| **a record**, and want what it connects to | `traverse`, or `recall` with `traverse > 0` |

If two of those are true at once, read on: the combinations are where the real choice is.

## `recall` — when the words matter and the wording does not

`recall` embeds your query and ranks by meaning, so *"the auth rewrite broke PKCE"* finds a fact phrased
*"PKCE flow regressed during the authentication migration"*. Nothing else here does that.

**It is the wrong tool when you need completeness.** `topK` is a cut, and a cut with a *rank* behind it: result 11
of a `topK: 10` is not absent, it simply lost. If your question is *"every record where `status` is open"*, the
honest answer is `query` — `recall` will give you ten good guesses.

Reach for it when:

- the caller typed a phrase, not a field
- the vocabulary in the store does not match the vocabulary in the question
- "close enough, best first" is what you want

## `query` — when you can name the condition

`query` runs an allowlisted MongoDB filter and returns rows in a **total order** (`seq`, `updatedAt`, `createdAt`,
`_id`), so it pages without a row drifting between pages. It does not rank, and it does not care what anything
means.

Reach for it when:

- the condition is exact: `type`, `status`, a `properties.*` value, a tag
- you need **all** matches, not the best ones — with `skip` and `total` to walk them
- you are counting

**It is the wrong tool for a phrase.** A `$regex` over `fact` is not semantic search: it matches characters, so it
finds *"PKCE"* and misses *"the auth flow"*.

## `similar` — when you already have the record

Given an id, `similar` uses that record's **stored** vector — no embedding call, no query text to get wrong.
For deduplication, "more like this", and merge detection it is both cheaper and more accurate than pasting the
record's own text into `recall`.

## `traverse` vs `recall` with `traverse`

Both walk edges in both directions. The difference is where the walk **starts**:

| | starts from | use when |
|---|---|---|
| `POST /traverse` | one id you supply | you already have the node |
| `recall` with `traverse: n` | whatever the query matched | you can describe the starting point but do not know its id |

A traversed node is **not** ranked against the matches — it is nested under the match that reached it, with no
score, because it was reached structurally rather than by matching. That is the point: the party who posted a
message is rarely textually similar to the message's subject.

## Combining them: the two-call pattern that beats one clever call

**Filter first, rank second — in one call.** `recall`'s `filter` accepts the same grammar `query` does, including
`$or` and `$regex` nested to depth 8. **`topK` is filled from records that satisfy the filter**, never applied to
an already-cut shortlist — so a filtered `topK: 10` still returns ten, and nothing matching is silently dropped.

That promise holds however the filter is written; only the speed differs. A simple condition on an allowlisted
key becomes a native pre-filter inside the vector index. **Raw MongoDB — including the `$or` above — cannot**, so
the whole space is scored and then filtered: slower, same records. Declaring a heavily-filtered property in the
space schema is what keeps it on the fast path.

```json
{ "query": "who owns the vault service",
  "filter": { "$or": [ { "type": "service" }, { "tags": "ownership" } ] },
  "topK": 10 }
```

**Locate, then read.** `includeFileContent: false` returns file-chunk locations and metadata without the passage
bodies — by far the largest field in a result, paid for `topK` times. Find *where* something is, then read only the
chunk you chose.

**Count, then fetch.** `query` with a `projection` of `{"_id": 1}` and `total` tells you how big the answer is
before you decide to pull it.

## Optimising by what you are actually doing

### "I want the one right answer"

Small `topK` (5–10), and a `filter` if you can name one. A reranker, when configured, reorders the top candidates
by a cross-encoder — it improves the top of the list, so a *smaller* `topK` benefits most.

### "I want everything that matches a condition"

`query`, with `skip`/`sort`/`dir` and `total`. Not `recall` with a huge `topK` — nothing caps it since 4.0,
so it will not lie to you, but the tail of a ranked list is noise rather than completeness, and you pay
meaning-ranking's cost for every one of those rows. `query` filters instead of ranking, which is the
question you are actually asking.

### "I want context around an answer"

`recall` with `traverse: 1`. Depth 2 is occasionally right; depth 3+ on a dense graph is almost never what someone
meant — the node budget is `topK × (traverse + 1) × 4`, and the response itself is bounded by **`maxBytes`**
(default 50 000 characters over REST and 25 000 over MCP — the parameter is `maxChars`; `maxBytes` exists and has no
default), so a deep traversal comes back as the matches that fit plus a `nextSkip` to page through the
rest. `truncated: true` on a call you expected to be small is a signal you asked a bigger question than you
wanted: lower `traverse` or narrow the seeds rather than raising the budget.

### "It is too slow"

In order of effect:

1. **Narrow before ranking** — a `filter` or `tags` cuts the candidate set the vector search scores.
2. **Drop the passages** — `includeFileContent: false`.
3. **Lower `traverse`** — each hop multiplies the frontier.
4. **Lower `topK`** — this is last on purpose: with a reranker configured, a wider net is cast *before* the cut, so
   `topK` costs less than it looks.
5. **`maxTimeMS`** — a deadline, not an optimisation: on expiry the answer comes back **partial** and flagged
   `degraded`, which is better than a hang and worse than a narrower question.

### "The results are almost right but the wrong records win"

- `minScore` cuts weak matches, and it is applied **last** — it can drop a `minPerType` guarantee.
- `minPerType` guarantees coverage per knowledge type; `maxPerType` stops one noisy type filling the answer.
- `types` is blunter and cheaper than either.

### "I wrote it a second ago and cannot find it"

Nothing to do — `recall` already handles it. Writes do not wait for the embedding model, and the vector index
lags the collection by a few seconds after that, so every recall also scans the newest records straight from
each collection. Measured: a plain recall used to answer `count: 0` for three seconds after a write.

This was the `includeFreshWrites` flag until 5.0. **Delete it if you send it** — it is an unknown field and a
`400` now. What it does not cover is a record still QUEUED for embedding: the scan compares vectors, so there
has to be one.

## The mistakes worth naming

| symptom | cause | fix |
|---|---|---|
| counts that keep growing | paging `recall` with `topK`/an unsupported `offset` | `query` with `skip` and `total` |
| a phrase search finds nothing | `$regex` over prose | `recall` |
| "this record has no relationships" | a truncated traversal, before the spill | check `truncated` / `graphTruncated`, fetch `complete` |
| a filtered recall returns fewer than `topK` | assuming a post-filter | `topK` is filled from records that SATISFY the filter, so nothing matching was dropped — the candidates genuinely ran out |
| slow, wide answers | `traverse` 2+ with a large `topK` | narrow the seeds first |

---

*The MCP tools take the same parameters as the routes throughout — see the
[capability map](16-mcp.md#capability-map--both-doors-and-what-a-token-needs) for both doors side by side.*
