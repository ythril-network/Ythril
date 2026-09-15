# Recall & Similarity

> Part of the [Ythril Integration Guide](../integration-guide.md).

## Recall & Similarity

### Semantic Search (Recall)

Available as both — REST `POST /api/brain/recall`, MCP tool `recall`:

```json
{
  "query": "how does OAuth PKCE work?",
  "topK": 10,
  "types": ["memory", "entity"],
  "minScore": 0.65
}
```

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `space` | — | every space you can read | Which space to search. **Omit it and the search runs across every space this token holds `knowledge: read` in**, ranked together — the reason this route no longer carries the space in its path. A space you cannot read is not searched and is not an error; a space you NAMED and cannot read is a 403. |
| `query` | ✅ | — | Natural-language search text (non-empty string) |
| `topK` | — | `10` | Max returned results, minimum 1 and **no ceiling** — the same on both doors since 4.0, where REST clamped to 100 silently. What comes back is bounded by the byte budget instead: every record whole, `truncated` on every response, `nextSkip` when it bit |
| `types` | — | all types | Restrict result knowledge types |
| `minScore` | — | none | Filter out low-similarity matches |
| `filter` | — | none | Property equality/comparison filter (see below) |
| `tags` | — | none | Array of strings — restrict to records carrying these tags |
| `minPerType` | — | none | Object mapping knowledge type → minimum hits, e.g. `{ "entity": 2 }`. Guarantees at least that many results of the type; each value is clamped to `topK` |
| `maxPerType` | — | none | Object mapping knowledge type → **maximum** hits, e.g. `{ "file": 2 }` — the ceiling to `minPerType`'s floor. A slot the cap frees goes to another type. Each value must be at least `1` and is clamped to `topK`; a value below `minPerType` for the same type is a `400` (see below) |
| `maxTimeMS` | — | the instance budget | Deadline for this recall, in ms. **Can only lower the instance's `RECALL_BUDGET_MS`, never raise it** — a larger value is clamped to it, and a very small one is clamped up to a 250 ms floor. On expiry you get a **partial** answer with a `degraded` field, not an error and not a hang |
| `traverse` | — | `0` | Graph expansion: an integer depth `0`–`5`, **or an object `{depth, edgeLabels, direction}`** — a `traverse` call without its start node, because the matches *are* the start nodes. `0` = classic recall. See [Graph-Augmented Recall](#graph-augmented-recall-traverse-parameter) |
| `includeFreshWrites` | — | `false` | Also scan the newest records straight from each collection, so a record written seconds ago is findable before the vector index has ingested it. See below. A non-boolean is a `400`, never coerced |
| `includeContent` | — | `true` | Whether file-chunk results carry `content` — the passage body. `false` returns locations and metadata only (path, heading, chunk index, tags, properties). **File chunks ONLY** — it does nothing on a search returning entities, memories, edges or chrono entries; use `projection` to trim those. A non-boolean is a `400`, never coerced |
| `includeRecordMeta` | — | `false` | Add back the fields that describe where a record SITS rather than what it says: `createdAt`, `updatedAt` and the link-id arrays. Measured on a real corpus only **30%** of a recall answer was content and most of the rest was this, which at a tight `maxChars` is evidence you paid for and did not get. `createdAt` is the one to be careful of — it is when the RECORD was written, not when the remembered thing happened, which lives in the record's own properties. **Applies recursively**, so a `traverse` answer's `_graph` follows it at every depth. MCP takes the same parameter with the same default. A non-boolean is a `400`, never coerced |
| `includeDiagnostics` | — | `false` | Add back the three fields a result carries for the SYSTEM rather than for you: `matchedText` (the exact pre-embedding source string — for a file chunk, the passage a SECOND time), `embeddingModel` and `seq`. **Applies recursively**, so a `traverse` answer's `_graph` nodes and edges follow it at every depth. Off by default since 3.1.0 — before then this door sent them unconditionally while MCP sent none. **It does NOT gate the per-stage scores.** `lexicalScore`, `fusedScore` and `rerankScore` are returned unconditionally on both doors, because the one that decided a result's position must not be the one you cannot read — and three floats are not a cost worth a flag. The embedding VECTOR is not among them and is never returned by anything. A non-boolean is a `400`, never coerced |
| `projection` | — | none | Fields to include (1) or exclude (0), the same grammar `POST /query` takes, applied to each result's record. Dotted paths work: `{"name": 1, "properties.status": 1}`. **Applies recursively** — a `traverse` answer's `_graph` nodes and edges are projected at every depth, which is where a large answer's size actually comes from. Inclusion and exclusion cannot be mixed (the non-`_id` fields decide which you meant); `_id` survives an inclusion projection unless you send `_id: 0`; and the embedding VECTOR can never be projected back in — an explicit `embedding: 1` is dropped rather than honoured. The ranking envelope (`score`, `spaceId`, `type`, `_graph`) always survives, so a projection cannot lose the score you searched for |
| `maxChars` | — | `50000` REST / `25000` MCP | Ceiling on the serialised response body, in **characters**, and the ceiling that carries the defaults. **The default differs by DOOR: 50000 over REST, 25000 over MCP.** Both doors accept this parameter identically — same floor, same ceiling, same refusal — and only the number applied when you send nothing differs, because an MCP tool result meets a hard per-result ceiling inside the client that the caller cannot raise while a REST body lands in a buffer its caller allocated. Measured: a correct, in-budget 98356-character answer was refused outright by an MCP client. Raise it if yours can take more. **This is the parameter that used to be called `maxBytes`**: that name always counted characters, which equal bytes only for ASCII. **The answer is a PREFIX of the ranked results and every record in it is WHOLE** — full body, full properties, complete `_graph`, byte-identical to that record from an unbudgeted call. Truncation is atomic at the match: the first match whose subtree would not fit is omitted and so is everything after it, so no answer has a gap and none carries a record with half its graph. **That is what the guarantee costs** — the budgeted unit is a match TOGETHER WITH its subtree, so a deeper or wider `traverse` means fewer matches fit, and the ones that do not are absent rather than shortened. `returned`, `count`, `truncated`, `budgetChars`, `budgetBytes`, `charsReturned` and `bytesReturned` are on EVERY response, so absence never has to be interpreted; a truncated one adds `nextSkip`, which you send back as `skip` |
| `maxBytes` | — | **none** | Ceiling on the serialised response body, in **real UTF-8 bytes**. **BREAKING IN 3.7: this used to bound characters** while its name, its refusal message, its response field and this table all said bytes — true for ASCII and wrong for everything else. `Grüße aus Köln — ąćę` counts 31 characters against 39 bytes; three emoji count 17 against 23. A transport or client limit IS in bytes, so a German or Polish space was overrunning its stated budget by about a quarter. If you set this before and want the old behaviour, send the same number as `maxChars`. **It has no default**, deliberately: bytes are always ≥ characters, so a byte default equal to the character one would silently become the binding constraint on every non-ASCII answer. **When you set both, both apply** — the answer stops at whichever ceiling it reaches first |
| `maxTokens` | — | none | A convenience onto **`maxChars`**, converted with `charsPerToken` — the conversion produces characters, which is what it was always compared against. If both are sent the **smaller** resulting character figure applies. It is an approximation — the server does not know your tokeniser |
| `charsPerToken` | — | `3.5` | Ratio used to convert `maxTokens` to CHARACTERS — the row above says so, and this one said bytes. 3.5 rather than the customary 4.0 because 4.0 UNDER-counts tokens and is worst on graph-heavy responses: undershooting costs one page, overshooting costs a blown context |
| `skip` | — | `0` | How many of the ranked matches to skip before filling the byte budget. **This is how you read a truncated answer**: a response with `truncated: true` carries `nextSkip`, and sending it back gets you the next prefix — no match repeated, none missed. The ranking is recomputed per call, so it is a continuation over one ordered answer rather than a cursor over a snapshot |
| `remainderDump` | — | `false` | Also write the matches that did not fit to the space as JSON and report it as `remainder`. Only meaningful when the answer truncates. Off by default because it is a write on a read path that counts against space storage — page with `skip` to reach the same records without one |

**Response** `200`:

```json
{
  "results": [
    { "_id": "...", "type": "memory", "fact": "...", "score": 0.91 }
  ],
  "count": 1
}
```

### Bounding a recall in time: `maxTimeMS` and `degraded`

A recall runs its hops in series — embed the query, search each collection, fuse the lexical channel, rerank —
and a slow one can outlast the client waiting for it. `maxTimeMS` puts the bound where the work is instead of
in each caller's HTTP timeout, which is the difference between a rule and a convention.

**What happens on expiry is the useful part: you get what finished.** Collections that answered are returned;
one that ran out of time contributes nothing and the response gains a `degraded` array:

```json
{
  "results": [ { "_id": "...", "type": "memory", "score": 0.83 } ],
  "count": 1,
  "degraded": ["search_timeout"]
}
```

| reason | meaning |
|---|---|
| `search_timeout` | at least one collection's vector search hit the deadline, so the answer is **partial** — fewer results than the corpus holds, not fewer results because the corpus is empty |
| `rerank_skipped_budget` | the cross-encoder was configured but not run: too little budget was left. The order is the hybrid-fusion order, which is a slightly worse ranking, delivered |
| `rerank_unavailable` | the cross-encoder was configured and did not answer (unreachable, non-2xx, unreadable body) |

**`degraded` is absent when nothing degraded** — it is not an empty array on every healthy response, because a
field that is almost always empty is one readers stop looking at. Treat its presence as "this answer is
thinner than it could have been", and note that the status is still `200`: partial results beat an error, and
both beat hanging.

**The clamps are deliberate.** `maxTimeMS` can only lower the instance's budget: letting a request body
extend it would hand any caller a denial-of-service lever, and how long the server may spend is the operator's
decision. A value below 250 ms is clamped up, because `maxTimeMS: 1` would otherwise be a guaranteed empty
answer, which reads as a broken parameter rather than an honoured one.

The same `degraded` field appears on `traverse > 0` responses, since seeds that were partial produce a partial
expansion and a longer list would otherwise hide it.

**A contradictory floor/ceiling pair is refused, not resolved.** `minPerType.entity: 5` with
`maxPerType.entity: 2` answers `400`, naming both values:

```json
{ "error": "minPerType.entity (5) is greater than maxPerType.entity (2) — the two contradict, so neither can be applied" }
```

Floor-wins and ceiling-wins are both defensible, which is exactly why the request has to say which it meant.
A `maxPerType` value of `0` is refused for the same kind of reason — it would be a second, less obvious way to
spell `types` without that type.

Searches **all knowledge types** (memories, entities, edges, chrono entries, and files) and includes a
`type` discriminator field on every result. No configuration needed — the defaults below are what a
fresh instance does.

#### How a result is ranked

Recall runs up to three stages. Each is independent, each degrades to the previous one if it is
unavailable, and **none of them can fail a search** — a stage that cannot answer simply has no opinion.

1. **Vector search** (always). The query is embedded with the same model and the same task prefix used at
   index time, and MongoDB `$vectorSearch` returns the nearest records per type. This produces `score`.

2. **Lexical search + rank fusion** (automatic). In parallel, a MongoDB `$text` (BM25-family) query ranks
   the same records lexically, producing `lexicalScore`; the two rankings are combined by **Reciprocal
   Rank Fusion** into `fusedScore`.

   This exists because vector search compares *meaning*, which is the wrong tool for the tokens a corpus
   is most precise about — article numbers, form ids, part codes, clause names, proper nouns. An opaque
   identifier has no useful semantic neighbourhood, so the right record could rank below plausible prose
   and fall outside `topK`. Nothing errored; the answer was just built from the wrong passages.

   Fusion uses **rank, never raw score**: `textScore` is unbounded and grows with term rarity, cosine is
   bounded, and any normalisation between them would need a calibration that drifts as a space grows. A
   record ranked well by *both* channels outranks one that wins a single channel — agreement between an
   exact-token match and a semantic match is the strongest signal either gives.

   The channel both **reorders** the candidate set and can **introduce** a record the vector search did
   not return at all — which matters most for exactly the queries it exists for, since an opaque
   identifier's embedding is nearly arbitrary and its record is therefore the most likely to sit outside
   the vector candidate pool.

   An introduced record is not given an invented score. Its embedding is read and compared against the
   query vector directly, so its `score` is measured on the same scale as every other result and
   `minScore` filters it exactly as it filters the rest. The mapping from raw similarity to the reported
   `score` is *verified on every query* rather than assumed: any record that appears in both channels
   already carries an engine-reported score, and its locally recomputed value must match. If they
   disagree — or if no record overlaps, leaving nothing to check against — **no record is introduced**
   and the channel falls back to reordering alone.

   Set `YTHRIL_HYBRID_SEARCH=off` to disable the whole channel.

3. **Cross-encoder reranking** (only when configured). If `mediaEmbedding.rerank` names an endpoint and a
   model, a cross-encoder reads the query and each candidate passage *together* and scores the actual
   match, producing `rerankScore`. A bi-encoder can only compare two independently-computed summaries of
   meaning; a cross-encoder reads the pair. That is what lifts precision in the top few results.

   It has no index, so it can only re-order what stages 1–2 found — hence `candidateMultiplier`, which
   widens the pool it gets to choose from. Unreachable or unconfigured means no opinion, and the fused
   order stands. See the `mediaEmbedding.rerank.*` rows in [Configuration](05b-media-embedding.md#configuration).

   **Budget for it: the cost tracks TEXT, not candidate count, and running out is silent.** The cross-encoder
   scores every candidate passage, so the budget must cover the total text of `topK x candidateMultiplier`
   candidates — on records of several kilobytes, **seconds per result**. Measured live, same query and space,
   only `topK` stepped, at the default multiplier of 4 and the default 20-second budget: 4 candidates took
   5.09 s, 12 took 15.70 s, 16 took 17.79 s, and 20 did not finish. **The third step is the informative one**
   — 2.09 s for 198 more bytes, where earlier steps added around 1 617 each — so count is only a proxy, and
   it holds while candidates are similar in size. A control instance on the same server and model reranked a
   comparable set (5 097 B against 5 133 B) in **2.83 s**.

   **When the budget expires the request still SUCCEEDS**: the stage logs `keeping the vector order` and a
   reasonable-looking answer comes back without the precision this stage exists to add. Raise
   `modelSlots.rerank.timeoutMs`, but not past whatever proxy sits in front of the API — the run above that
   did not finish was cut off by their gateway's own twenty seconds, not by ours. Read `rerankScore` to tell
   the cases apart: no field means the stage had no opinion.

**Ordering precedence is `rerankScore` → `fusedScore` → `score`** — the order of how much each signal
actually knows.

#### The per-stage scores are the ORDERING

`lexicalScore`, `fusedScore` and `rerankScore` are on **every** recall and find-similar result, on **both**
doors, each present only when that stage actually ran. **No parameter removes them**, and
`includeDiagnostics` does not govern them — that flag covers `matchedText`, `embeddingModel` and `seq`.

**Read the highest one present to know why a result placed where it did.** Precedence is
`rerankScore > fusedScore > score`, so on an instance with a cross-encoder configured, `score` — plain vector
similarity — is *not* the number that ordered the answer. Combined with the section below, where `minScore`
filters on `score` alone, a caller could previously threshold on one number while a different one decided the
positions, and could not read the second.

They sat behind `includeDiagnostics` until now. That flag exists to remove COST, and three floats per result
are not a cost — `matchedText` is, which is why it stayed behind the flag and these did not. MCP had never
sent them at all, so that door gained them rather than merely un-gating them.

An absent score means that stage did not run: no reranker configured, no lexical channel for that query.
That was always the contract; what changed is that you no longer have to ask.

#### `minScore` always filters on `score`

This is deliberate and worth being explicit about: `minScore` is a **vector-similarity** floor and stays
one. The three scores are on unrelated scales, so reinterpreting a caller's fixed threshold against a
fused rank or a cross-encoder logit would change what that threshold returns without anyone touching it.
Ordering may use the better signal; filtering does not.

The extra scores are returned when they were produced, so a caller can see why a result placed where it
did:

```json
{
  "results": [
    {
      "_id": "...", "type": "file", "path": "specs/NMK-240C.md",
      "score": 0.71,
      "lexicalScore": 4.83,
      "fusedScore": 0.0325,
      "rerankScore": 0.94
    }
  ],
  "count": 1
}
```

`lexicalScore` is absent when the record did not match lexically; `fusedScore` when hybrid is off;
`rerankScore` when no reranker is configured or it did not answer.

**Both doors return the per-stage scores.** The MCP tool spreads the same ranking fields on both its
branches, so an agent sees `lexicalScore`, `fusedScore` and `rerankScore` exactly as a REST caller does.

> This paragraph said *"the MCP `recall` tool returns `score` only … deliberately omitted there"*, and
> the same page says the opposite forty lines above — that they are on every recall, on both doors. An
> agent reading this one would not read the number that ordered its own answer.

#### A request using every capability

Nothing here is required — this is one call exercising all eight parameters at once, to show how they
compose.

```json
POST /api/brain/recall
{
  "query": "PKCE failures on form NMK-SI-11 during the auth rewrite",
  "topK": 20,
  "types": ["memory", "entity", "chrono", "file"],
  "tags": ["auth", "postmortem"],
  "minPerType": { "entity": 2, "chrono": 1 },
  "minScore": 0.55,
  "traverse": 1,
  "filter": {
    "properties.severity": { "in": ["high", "critical"] },
    "properties.reviewCount": { "gte": 2 },
    "properties.supersededBy": { "exists": false },
    "status": { "ne": "cancelled" }
  }
}
```

Read in the order the server applies them:

| Parameter | What it does here |
|---|---|
| `query` | Ranked semantically **and** lexically. `NMK-SI-11` is the reason the lexical channel matters — its embedding carries almost no meaning. |
| `types` | Restricts which collections are searched at all. Edges are excluded. |
| `tags` | Hard filter, **AND** semantics — a record must carry *both* `auth` and `postmortem`. |
| `filter` | Hard filter. Keys must start with `properties.`, `tags`, `type`, `name`, `status` or `label`; any other key is rejected. Operators: `eq`, `ne`, `in`, `exists`, `gt`, `gte`, `lt`, `lte`. All conditions must match. |
| `minPerType` | Guarantees a floor per type *if that many exist*, so a flood of file passages cannot crowd out every entity. Each value is clamped to `topK`. |
| `maxPerType` | The ceiling to that floor, and the other half of the same problem: one long file passage that scores well can take slots several one-line records would have answered more cheaply. A candidate whose type is already at its cap is **skipped and the walk continues**, so the freed slot goes to another type rather than shortening the list. |
| `minScore` | Applied **last**, on the vector score, and it can drop a `minPerType`-guaranteed result — a floor is a request for coverage, not a licence to return matches you called too weak. |
| `topK` | The final cut. |
| `traverse` | After the cut, follows knowledge-graph edges outward from every match — every label in both directions by default, or narrowed by `edgeLabels`/`direction` — and nests the connected entities **under the match that reached them**. |

**`traverse > 0` adds `_graph` to each match** — this is the one thing worth knowing before using it. The
results stay the matches, in rank order, exactly as `traverse: 0` returns them; what the graph reached hangs
off the match that reached it:

```json
{
  "results": [
    {
      "_id": "…", "type": "file", "path": "runbooks/NMK-SI-11.md",
      "score": 0.71, "lexicalScore": 4.83, "fusedScore": 0.0325, "rerankScore": 0.94,
      "matchedText": "Form NMK-SI-11 must be filed within 6 hours…",
      "_graph": [
        {
          "edge": {
            "_id": "…", "from": "runbooks/NMK-SI-11.md", "to": "security-team", "label": "owned-by",
            "description": "the team that signs the form off", "tags": ["ownership"],
            "createdAt": "2026-07-02T09:14:00.000Z"
          },
          "node": { "_id": "…", "type": "entity", "name": "security-team" },
          "paths": [["<match id>", "<security-team id>"]]
        }
      ]
    }
  ],
  "count": 1,
  "traverseDepth": 1,
  "graphNodes": 1
}
```

| field | meaning |
|---|---|
| `count` | the number of **matches** — what `topK` bounds |
| `graphNodes` | how many traversed nodes the trees hold in total |
| `edge` | the **whole** edge document for the hop that reached this node, including its `description` and `tags` |
| `node` | the reached record |
| `paths` | **every** route from a match to this node, record ids, match first. `paths[0]` is the route it is nested under, so `paths[0].length - 1` is the hop count |
| `pathsTruncated` | present and `true` only when a node had more routes than were recorded |
| `_graph` | on a nested node too — depth is a tree, so a two-hop node hangs off the one-hop node that reached it |

A traversed node carries **no score**. It was reached structurally, not matched: it has no similarity to the
query, and it is not in the ranked list at all — so there is no `null` competing with a real score, and
nothing for `minScore` or `topK` to act on that nobody measured.

An ordered array of ids **is** the direction — match first, this node last — so there is no orientation to
work out. The hop labels along the nesting route are not lost either: each node on it carries its own `edge`,
so walking the tree yields the chain in order. Only the last hop of an *alternate* route has no label, and
both of its endpoint ids are right there.

The MCP `recall` tool takes the same parameters, plus `space` (omit it to search every accessible space):

```json
{
  "space": "dev-apps",
  "query": "PKCE failures on form NMK-SI-11 during the auth rewrite",
  "topK": 20,
  "types": ["memory", "entity", "chrono", "file"],
  "tags": ["auth", "postmortem"],
  "minPerType": { "entity": 2, "chrono": 1 },
  "minScore": 0.55,
  "traverse": 1,
  "filter": {
    "properties.severity": { "in": ["high", "critical"] },
    "properties.reviewCount": { "gte": 2 },
    "properties.supersededBy": { "exists": false },
    "status": { "ne": "cancelled" }
  }
}
```

**Performance note.** `tags`, `type`, `name`, `status`, `label` — and, on spaces whose schema declares
them, `properties.<key>` — are pushed into the vector index as native pre-filters. Undeclared
`properties.*` and `exists` are still correct but scan exhaustively, so prefer declared fields on large
spaces. `traverse` above 2 on a dense graph is slow; narrow the seed set with `tags`/`filter` first.

#### Graph-Augmented Recall (`traverse` parameter)

By default `recall` returns matches in isolation — the knowledge-graph edges between records are not consulted. Set `traverse` to an integer between `1` and `5` to follow the graph outward from every match: for each seed, the server walks edges up to `traverse` hops and returns the connected entities alongside the matches. This turns semantic search into context-aware retrieval — "recall the Vault service **and everything connected to it**" in one call, instead of a recall followed by manual `traverse`/`query` calls.

##### Narrowing the walk: `traverse` as an object

A bare number follows **every edge label in both directions**, which is what this parameter did and all it could
do. Pass an object instead to walk the graph the way `POST /traverse` always could:

```json
{
  "query": "the vault service",
  "traverse": { "depth": 2, "edgeLabels": ["depends_on", "owned_by"], "direction": "outbound" }
}
```

| field | required | default | meaning |
|---|---|---|---|
| `depth` | yes | — | Hops, `0`–`5`. `traverse: 2` and `{"depth": 2}` are the same request |
| `edgeLabels` | no | every label | Follow only these. An empty array means no narrowing, not "match nothing" — the same reading `POST /traverse` takes |
| `direction` | no | `both` | `outbound`, `inbound` or `both`. A bare number means `both`. **It narrows stored edges only** — see below |

**Why this matters more than it sounds.** On any graph where a few nodes hold most of the edges — a person, a
project, a recurring topic — one unnarrowed hop off such a node returns whichever neighbours the node cap
happened to keep, and nothing in the response distinguishes that from a deliberate answer. Narrowing is how you
ask for the neighbourhood you meant.

**`direction` narrows stored edges only, and never links.** A link is a **record** with a `from` and a `to` since 4.0 — but which way it runs is fixed by the
KINDS at its ends rather than by the data. A memory names entities and an entity names nothing, so asking for
a memory's outbound links and its inbound links is not a choice between two answers; for an entity one of the
two is always empty. There is nothing for `direction` to select between, so it selects nothing.
Both walks treat a link as reaching the entity it names, whatever `direction` says: the standalone
[`POST /traverse`](04b-graph-api.md#traverse-graph) has always done so, and recall's expansion matches it.

The consequence worth knowing, because it surprises: `{"depth": 1, "direction": "inbound", "includeMemories":
true}` on a matched memory still returns the entities that memory **names**, which is an outbound step from the
record. Consistency between the two walks is deliberate, and so is leaving it this way now that a link has two
ends: honouring `direction` on links would make the DEFAULT traverse — `outbound` from an entity — return no
linked records at all, because nothing hangs off an entity. That is a large silent change to the commonest
call, for a parameter that would still have nothing useful to select between. If you want edges in one direction
and no links at all, leave the three `include*` flags off; they are off by default.

**`limit` is deliberately not accepted here.** In a standalone traverse the caller sets it; in a recall the node
cap comes from `topK` and the byte budget, and a `traverse.limit` would let one parameter overrule the budget
governing the rest of the answer. An unknown field inside the object is a `400`, not an ignored key.

**The response echoes what was applied** as `traverse` — a number when nothing was narrowed, so an existing
caller's assertion still holds, and the object when it was, so a narrowing you sent is one you can confirm took
effect.

**Same parameter, same parser, both doors, and on `find_similar` too.** Until 3.5 the expansion reachable from a
search could not narrow while the standalone tool could — one rule with two implementations, and the one people
actually reached was the weaker.

`traverse: 0` (the default) is behaviourally identical to classic recall and returns the classic response shape above. When `traverse > 0` the results are unchanged and each one gains a `_graph` array holding what the walk reached from it, plus `traverseDepth` and `graphNodes` on the envelope.

> **This parameter and the [`/traverse` endpoint](04b-graph-api.md#traverse-graph) are different tools that share a name.**
> The difference is where the walk STARTS, and it decides which one you want:
>
> | | starts from | use it when |
> |---|---|---|
> | `recall` with `traverse: n` | whatever the query matched semantically | you can *describe* the starting point but do not know its id |
> | `POST /traverse` | one entity id you supply (`startId`) | you already *have* the node and want its neighbourhood |
>
> Both walk edges in both directions, so neither is "the directional one". An integrator read this section,
> concluded that graph expansion only ever radiates outward from semantic matches, and hand-walked the edge
> list in two flows — the endpoint below does exactly what they were building by hand.

```json
{
  "query": "authentication token scoping",
  "types": ["entity"],
  "traverse": 2
}
```

**Response** `200` (when `traverse > 0`):

```json
{
  "results": [
    {
      "_id": "adr-0042", "name": "Token Scoping", "type": "decision", "score": 0.91,
      "_graph": [
        {
          "edge": {
            "_id": "e-42-79", "from": "adr-0042", "to": "adr-0079", "label": "implements",
            "description": "0079 is how 0042 was carried out", "tags": [],
            "createdAt": "2026-05-11T08:00:00.000Z"
          },
          "node": { "_id": "adr-0079", "name": "Vault Integration", "type": "decision" },
          "paths": [["adr-0042", "adr-0079"]],
          "_graph": [
            {
              "edge": { "_id": "e-79-88", "from": "adr-0079", "to": "adr-0088", "label": "supersedes" },
              "node": { "_id": "adr-0088", "name": "Vault Rotation", "type": "decision" },
              "paths": [["adr-0042", "adr-0079", "adr-0088"], ["adr-0042", "adr-0051", "adr-0088"]]
            }
          ]
        }
      ]
    }
  ],
  "count": 1,
  "traverseDepth": 2,
  "graphNodes": 2
}
```

| Field | Meaning |
|-------|---------|
| `count` | The number of **matches**, which is what `topK` bounds. It does **not** include traversed nodes |
| `graphNodes` | How many traversed nodes came back in total, across every match |
| `edge` | The **whole** edge document for the hop that reached this node — `description` and `tags` included |
| `node` | The reached **entity** document |
| `paths` | Every route from a match to this node, record ids, match first. `paths[0]` is the nesting route; `paths[0].length - 1` is the hop count |
| `pathsTruncated` | Present and `true` only when a node had more routes than were recorded (cap: 8) |
| `_graph` | Present on a nested node too, so depth is a tree: `adr-0088` hangs off `adr-0079`, which hangs off the match |
| `graphTruncated` | Present and `true` only when the inline graph is **short of the real neighbourhood** |
| `graphComplete` | `{nodes, path, download, expiresAt}` — where the **whole** graph was written. Present with `graphTruncated` whenever a complete copy exists, which is not always: see below |

Note `adr-0088` above: it is reachable two ways and appears **once**, with both routes in `paths`. A caller
counting rows never double-counts a record, and no relationship is invisible.

**Guard rails:**

- **Depth cap:** `traverse` must be `0`–`5`. A value of `6` or higher (or a negative/non-integer value) returns `400` — it is rejected, not clamped.
- **Node cap, and it is a spill point rather than a truncation point:** the inline traversed nodes are capped at
  `topK × (traverse + 1) × 4` minus the matches, preferring lower-hop records. When the neighbourhood is bigger
  than that, the **complete** graph is written to the space's `_tmp/` as JSON and the response carries
  `graphTruncated: true` plus `graphComplete`:

  ```json
  {
    "graphNodes": 7,
    "graphTruncated": true,
    "graphComplete": {
      "nodes": 30,
      "path": "_tmp/graph-9f1c….json",
      "download": "/api/files/dev-apps?path=_tmp%2Fgraph-9f1c….json",
      "expiresAt": "2026-08-14T15:41:00.000Z"
    }
  }
  ```

  So a caller either receives the whole neighbourhood inline or receives a link to the whole neighbourhood —
  never a silently short one. There is no `total` for a neighbourhood to compare against, and a short graph
  reads as *"this record has few relationships"*, which is a wrong conclusion about the data rather than about
  the request.

  - The **download is the ordinary authenticated file route** — your own token, the space's own access control.
    Which also means a token with brain read but **no files read** receives a link it cannot fetch. It still
    learns the graph was short, which is the part that was previously invisible; grant `files: read` on the
    space if you want the spill itself.
  - The file **expires after one day** and is removed with its record by the retention sweep.
  - It is **hidden from file browsing** (like `_converted/` and `_extracted/`) and is **never embedded**, so it
    cannot come back as a recall hit.
- **`graphTruncated` can arrive WITHOUT `graphComplete`, and that is the honest case.** The link scans — the
  ones that follow the `entityIds` a memory, chrono entry or file carries — are bounded per hop, and a hop can
  spend its whole budget on records it then discards as already-visited. The neighbourhood is short, and there
  is **no complete copy to offer**, because the records that are missing are exactly the ones never read. So
  the flag stands alone: you are told the graph is partial, and a narrower `edgeLabels` or a lower `traverse`
  is what makes it whole. Before 3.6.1 this case was reported as complete.

  - The spill walk is itself bounded, at 20× the inline cap. If even that is reached, `graphComplete.ceilingHit`
    is `true` and the same flag is inside the file — a second silent truncation inside the fix for the first one
    would be the same defect again.
- **Cycle-safe:** each record is visited once, so a circular graph (A→B→C→A) never loops or produces duplicates. A record reachable by several routes is nested under the **shortest** one, with the rest in `paths`.
- **Space-scoped:** traversal stays within the spaces the calling token may access. An edge pointing at a record in a space the token cannot see (or at an id that is not an entity) is silently skipped — no data and no `403` leak.
- **Entities, and the records that mention them.** A walk follows two things: stored **edges**, whose endpoints
  are always entities, and **links** — the `entityIds` field a memory, chrono entry or file carries naming what
  it is about. Edges are followed always; links are opt-in, one flag per kind:

  ```json
  { "traverse": { "depth": 2, "includeChrono": true, "includeMemories": true, "includeFiles": true } }
  ```

  All three default to **false**, which is deliberate and is why this changed nothing for existing callers. You
  asked for semantic matches; expansion is decoration on them, and the answer is budgeted — a match is counted
  together with its whole `_graph` subtree, so every extra record admitted by default would be paid for in
  matches that no longer fit. The standalone `traverse` tool defaults `includeChrono` to **true** because its
  caller is explicitly exploring a graph rather than searching.

  A linked node arrives carrying `kind` (`chrono`, `memory` or `file`) and the fields that say what it is — a
  chrono's `title` and `type`, a memory's `fact`, a file's `path`, `description` and `tags`. **Never file chunk
  text:** a file's body is its passages, they are the largest thing stored, and a structural walk must not pay
  for them. Read the content with the file API if you want it.

  The reaching `edge` is **synthetic** — there is no stored edge record for a link. It carries `_id` in the form
  `<label>:<from>:<to>`, its two ends, and a label of `chrono.entityIds`, `memory.entityIds` or
  `file.entityIds`. It has no `author`, `createdAt` or `seq`, because a derived edge has none; do not look one
  up by that id, and do use the label to tell a modelled relationship from a derived one. `edgeLabels` filters
  these exactly like any other label, so `{"edgeLabels": ["owns"]}` excludes them and
  `{"edgeLabels": ["owns", "memory.entityIds"]}` keeps the memories.
- **A non-entity seed reaches its own links.** An edge's endpoints are entity ids, so a memory, chrono entry or
  file that matched semantically has no edges of its own. With the matching flag on, the walk instead starts
  from the entities that match's `entityIds` names — they are hop 1, and everything an edge reaches from there
  is hop 2.

  Without the flags it still comes back with an empty `_graph`, which is what it always did. Before 3.6 there
  was no flag to turn on and the guidance here was to take the entity ids off the match and traverse from one
  of those by hand; that is now the server's job.

**Performance:** traversal issues roughly two batched (`$in`) MongoDB queries per hop, not one query per node. Even so, `traverse > 2` on a densely-connected graph can fan out quickly — pair it with `filter`, `tags`, or a low `topK` to keep the seed set (and therefore the traversal frontier) tight.

#### A large answer comes back as a prefix, and you page through the rest

The response is bounded by **`maxChars`** (default **50 000 over REST, 25 000 over MCP** — see the note on the parameter; `maxTokens` is the same control expressed
in tokens, and if you send both the smaller wins). What fits comes back as the **longest prefix of the ranked
matches**, every record whole, and `nextSkip` says where to continue from. A match is counted together with
its whole `_graph` subtree, so a deeper or wider traversal means fewer matches fit — they are absent, not
shortened:

```json
{
  "results": [ /* 22 matches, each complete, each with its own `_graph` */ ],
  "returned": 22,
  "count": 100,
  "truncated": true,
  "budgetBytes": 100000,
  "bytesReturned": 99612,
  "graphNodes": 240,
  "nextSkip": 22
}
```

- **The seven accounting fields are on EVERY response**, whether the budget bit or not: `returned`,
  `count`, `truncated`, `budgetChars`, `budgetBytes`, `charsReturned`, `bytesReturned` — with
  `budgetBytes` `null` unless you asked for a byte ceiling. A field that appeared only when it bit would
  be one whose absence has to be interpreted, and the caller who most needs it is the one who does not
  know to look. **This said five, omitting both CHARACTER figures**, which are the ones the default
  ceiling is expressed in — the same confusion that had `maxBytes` named as the defaulting parameter
  elsewhere in this guide.
- **`count` is the real total**, never what was sent, and it stays the total on every page rather than shrinking
  as you advance. `returned` is what was sent, and it is `results.length` — read `returned` and you never have
  to count.
- **`nextSkip` appears exactly when `truncated` is true.** Send it back as `skip` and you get the next prefix.
  It is stated rather than left as arithmetic on purpose: `skip + returned` is a sum a caller can get wrong,
  especially the second time round when `skip` was already non-zero.
- **Truncation is atomic at the match, and the answer is always a prefix.** The first match whose complete
  `_graph` subtree would not fit is omitted and so is every match after it, even a later smaller one. No
  answer has a hole in the middle and no record arrives with half its graph. **That is what makes `skip`
  correct** — a budget that packed the gaps with smaller matches would produce pages no offset can continue.
- **A single match larger than the whole budget is still returned, alone.** A budget must not become a wall.

##### Paging with `skip`

```json
{ "query": "vault credential rotation", "topK": 100, "maxBytes": 40000, "skip": 22 }
```

Loop while `truncated`, feeding `nextSkip` back as `skip`; the page that comes back with `truncated: false`
carries no `nextSkip` and is the last one. Skipping past the end returns zero results with `truncated: false`.

**This is a continuation over one ranked answer, not a cursor over a snapshot.** Each call re-runs the search,
so a write landing between two pages can shift what falls where — the same caveat `/query`'s `skip` carries. For
a set that must be internally consistent, ask for the remainder as a file instead.

**The ranking itself is deterministic, though**, which is what makes paging usable in the ordinary case: results
on the same score are ordered by `_id` ascending, so an unchanged corpus always produces the same order. Before
3.2.0 it did not — equally-scored matches came back in whatever order the database gave, so two identical recalls
could be permuted.

##### `remainderDump`: the whole remainder as one file (opt-in)

Send **`remainderDump: true`** and the matches that did not fit are also written to the space's `_tmp/` as JSON,
reachable through an authenticated download, and reported as `remainder`:

```json
{
  "remainder": {
    "matches": 78,
    "records": 264,
    "path": "_tmp/results-9f1c….json",
    "download": "/api/files/dev-apps?path=_tmp%2Fresults-9f1c….json",
    "expiresAt": "2026-08-14T20:11:00.000Z"
  }
}
```

- **It defaults to off, and until 3.2.0 it was unconditional.** Writing a file is a write on a read path: it
  counts against space storage and shows up in an operator's usage figures. The common caller wants the next
  page, not an artifact, and now says so by omission.
- **`remainder` holds ONLY what did not fit.** It is a continuation, not a copy: the records already in
  `results` are not repeated in it. The pre-3.2 shape dumped the whole set including the part already sent,
  which is most of why it cost a caller more than it saved.
- **`remainder.matches` and `remainder.records` describe the FILE** — matches in it, and matches plus their
  traversed nodes. Both are counted from what was actually written, so neither can disagree with the download.
- **`nextSkip` is still there when you ask for the file**, so wanting the artifact never costs you the ability
  to page.
- The file is **self-describing**: it repeats the request that produced it, the counts, and its own expiry.
- **No embedding vectors are written**, at any depth — a result set serialised verbatim is the one place they
  would otherwise land in a file an operator opens.
- Same authenticated download and same **one-day** expiry as the graph spill below.

> **This replaced a record cap, and the reason is worth one line.** Past 25 records the answer used to collapse
> to **three** inline matches plus a download of everything. That did not reduce what a caller had to read — it
> roughly doubled it, because `read_file` takes no offset or limit, so the file had to be read whole and it
> contained the three records already sent. A budget with a prefix and a remainder gives the caller the same
> ceiling without the duplication.

#### Recall without passage bodies (`includeContent`)

A file result's `content` is the passage body, and it is by far the largest field a result carries — paid for
`topK` times, in tokens. `includeContent: false` omits it and returns everything needed to decide *which*
passage you want: path, heading, chunk index, tags, properties.

```json
{ "query": "retention policy", "types": ["file"], "includeContent": false }
```

That turns one expensive call into a cheap two-phase flow — recall to find **where** something is, then read
only the chunk you chose (`GET /api/files/:spaceId/…`). MCP `recall` and `find_similar` have taken the same
flag with the same meaning since they shipped; REST had no way to ask, which an integrator pointed out.

It drops `content` and nothing else, on file results and nothing else — the flag is about the passage body,
not about thinning a result. The default is `true`, so no existing caller changes.

#### Searching for something you just wrote (`includeFreshWrites`)

`$vectorSearch` reads an index, and that index lags behind the collection. The vector is on the document the
moment it is written — insert-time duplicate detection sees a brand-new record immediately — but recall does
not see it until mongot has ingested it. **An integrator measured a memory still invisible to recall 150
seconds after writing it**, polled every 5 s, for a distinctive nine-word phrase.

`includeFreshWrites: true` also scans the newest records straight from each collection, which is exactly the
set the index has not caught up with:

```json
{ "query": "the phrase I just stored", "includeFreshWrites": true }
```

- **A fresh hit is indistinguishable from an indexed one** — same shape, same `score`, same per-type fields.
  You cannot tell which channel found a record, and should not need to.
- **It is off by default**, and that is a decision rather than an omission. The scan is paid per knowledge
  type, and recall is a path somebody is waiting on. Turn it on for the case it exists for: searching for
  something you just wrote. Bounded by a time window and a document cap, so its cost tracks how much has been
  written recently rather than how large the space is (~9 ms with an empty window, ~52 ms with a full one, at
  20k records).
- **`exact: true` is not an alternative** and was measured not to be. It scans the index exhaustively rather
  than the collection, so it skips the approximate traversal, not mongot: on the same insert, ANN first saw
  the record after 1088 ms and ENN after 1083 ms.

Operators can see whether the lag is biting on their instance: `ythril_recall_fresh_writes_found_total`
counts records returned that the index had not yet ingested. Zero means the index is keeping up with writes.

#### Prefiltered Recall (`filter` parameter)

Use `filter` to restrict results to records where specific properties match a condition.

**Two grammars are accepted.** The operator-object form below is unchanged: one operator object per key, AND-ed across
keys. **Raw MongoDB is also accepted** — the same operators `query` takes (`$or`, `$and`, `$not`, `$nor`, `$in`, `$regex`,
`$elemMatch`, the comparisons), nested to depth 8, validated by the same parser with the same refusals.

That exists because the operator-object form cannot express an OR at any length, so a caller who wanted meaning-ranking
*and* a real predicate had to run `query` first and feed ids into something else:

```json
{
  "query": "authentication architecture decisions",
  "types": ["entity"],
  "filter": {
    "type": "message",
    "$or": [
      { "properties.status": "open" },
      { "properties.kind": { "$in": ["ask", "request"] } }
    ]
  }
}
```

> **AND ON BOTH DOORS, which it was not until now.** REST accepted the raw grammar from the day it shipped;
> the MCP `recall` tool's `inputSchema` still declared the operator-object form only, so the dispatcher —
> which validates arguments *before* the handler runs — refused a raw filter that REST answered `200` for.
> Measured on one instance, one space, the same instant, with a filter an integrator had reported:
> `{type: 'message', 'properties.readBy': {$not: {$regex: 'ythril'}}}` → REST `200`, MCP
> `/filter/type: must be object; /filter/properties.readBy: unexpected property '$not'`.
>
> Both doors now accept and refuse the same filters, including the refusals: an out-of-allowlist key and a
> MIXED filter fail identically on each. `recall-filter-parity-both-doors.test.js` drives both and compares.

Three rules apply to both grammars:

- **A filter that MIXES them is a `400`** naming the offending keys, rather than one half quietly winning.
- **The key allowlist still applies**, recursively — including inside `$or`. Keys must start with `properties.`, `tags`,
  `type`, `name`, `status` or `label`. Widening the grammar did not widen the keys, because a recall filter that could name
  any field would be a way to filter a vector search on fields the index cannot serve.
- **A raw filter takes the exhaustive path.** `$or` and `$regex` cannot be pushed into `$vectorSearch` as a native
  pre-filter, so the whole space is scored and then filtered — slower, same records, and still nothing dropped by `topK`.

The operator-object form keeps the native pre-filter path where the fields are declared, so existing callers lose no
performance.

```json
{
  "query": "authentication architecture decisions",
  "types": ["entity"],
  "filter": {
    "properties.status": { "eq": "accepted" },
    "properties.domain": { "eq": "security" }
  }
}
```

**Supported operators:**

| Operator | Meaning | Example |
|----------|---------|---------|
| `eq` | Exact equality | `{ "eq": "accepted" }` |
| `ne` | Not equal | `{ "ne": "draft" }` |
| `in` | Value is in array (any-of) | `{ "in": ["security", "auth"] }` |
| `exists` | Property is/isn't present | `{ "exists": true }` |
| `gt` | Greater than (numeric) | `{ "gt": 10 }` |
| `gte` | Greater than or equal | `{ "gte": 5 }` |
| `lt` | Less than (numeric) | `{ "lt": 100 }` |
| `lte` | Less than or equal | `{ "lte": 99 }` |

Multiple operators on the same key are AND-ed (range queries):

```json
{ "properties.score": { "gte": 50, "lt": 100 } }
```

**Allowed filter key prefixes:** `properties.`, `tags`, `type`, `name`, `status`, `label`. Any other key returns `400`. This prevents filter-key injection attacks.

**Examples:**

```json
// Only accepted ADRs
{ "filter": { "properties.status": { "eq": "accepted" } } }

// Records tagged with "security" OR "auth" (any-of)
{ "filter": { "tags": { "in": ["security", "auth"] } } }

// Entities of type "service" with a count property > 0
{ "filter": { "type": { "eq": "service" }, "properties.count": { "gt": 0 } } }

// Records where properties.domain exists
{ "filter": { "properties.domain": { "exists": true } } }
```

> **Performance note:** A filter that references only declared index fields — `tags`, `type`, `name`, `status`, `label`, and any schema-declared `properties.<key>` — using the operators `eq`, `in`, `gt`, `gte`, `lt`, or `lte` is pushed into a native `$vectorSearch` `filter` and runs as `exact:true` search restricted to the matching subset, so cost is proportional to the number of matching records rather than the whole collection. Only undeclared dynamic `properties.*` keys, `exists`, and `ne` fall back to the exhaustive ENN path, which scores every document in the space before applying the filter. To keep a heavily-filtered property on the fast path, declare it in the space schema rather than adding a standalone MongoDB index.

**What is vector-indexed:**

| Data type | Embedded? | Fields included in embedding text | Returned by `recall`? |
|-----------|:---------:|-----------------------------------|:---------------------:|
| `memory` | ✅ | `tags` + entity names + `fact` + `description` + `properties` | ✅ |
| `entity` | ✅ | `name` + `type` + `tags` + `description` + `properties` | ✅ |
| `edge` | ✅ | `tags` + `from` + `label` + `to` + `type` + `description` + `properties` | ✅ |
| `chrono` | ✅ | `type` + `status` + `title` + `tags` + `description` + `properties` | ✅ |
| `file` | ✅ | `path` + `tags` + `description` | ✅ |

> **Note — `properties` in the embedding text.** `properties` are embedded as `key value`
> pairs (both the key *and* the value), so a phrase living only in `properties.outcome` is
> findable via `recall`. `edge` and `chrono` did **not** embed `properties` in releases up to
> 1.4.4 — if you are upgrading, existing records keep their old embedding until they are
> re-embedded. Reindex a space to pick up the change:
> `POST /api/brain/spaces/:spaceId/reindex`.

---

### Find Similar (Vector Similarity by Entry ID)

```http
POST /api/brain/spaces/:spaceId/find-similar
```

Given an existing entry's `_id`, find other entries with high vector similarity. Unlike `recall` (which re-embeds a text query), `find_similar` uses the entry's **stored embedding vector** directly — no re-embedding step. Ideal for deduplication, "more like this", and merge detection.

> **Also available as MCP tool:** `find_similar` — note the MCP tool makes `space` optional (omit it to search all accessible spaces, like `recall`); its `crossSpace` flag is deprecated in favour of omitting `space`. This REST endpoint keeps `spaceId` in the path and the `crossSpace` body flag. Every other parameter, including `traverse`, `includeContent` and `includeDiagnostics`, is identical on both doors.
>
> **The MCP tool returned plain TEXT at `traverse: 0` until 3.1.0**, and JSON only above it. It is now JSON at every depth, with the same per-result shape `recall` uses plus a `source` naming the entry you asked about. This REST endpoint has always returned JSON at every depth and is unchanged by that.

**Request body:**

```json
{
  "entryId": "<UUID of the source entry>",
  "entryType": "memory",
  "targetTypes": ["memory", "entity"],
  "topK": 10,
  "minScore": 0.7,
  "traverse": 0,
  "includeContent": true,
  "crossSpace": false
}
```

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `entryId` | ✅ | — | UUID of the entry to use as the query vector |
| `entryType` | ✅ | — | Knowledge type of the source entry (`memory`, `entity`, `edge`, `chrono`, `file`) |
| `targetTypes` | — | all types | Which knowledge types to search in |
| `topK` | — | `10` | Maximum results, minimum 1, no ceiling (see the note on the recall table above) |
| `minScore` | — | `0.0` | Minimum cosine similarity threshold |
| `traverse` | — | `0` | Graph-expansion depth (0–5). With `traverse > 0` each match is expanded along edges and the connected entities come back alongside it — see the response shape below |
| `includeContent` | — | `true` | Whether file-chunk results carry their passage `content`. `false` returns locations and metadata only, exactly as on `recall` |
| `includeRecordMeta` | — | `false` | Add back the fields that describe where a record SITS rather than what it says: `createdAt`, `updatedAt` and the link-id arrays. Measured on a real corpus only **30%** of a recall answer was content and most of the rest was this, which at a tight `maxChars` is evidence you paid for and did not get. `createdAt` is the one to be careful of — it is when the RECORD was written, not when the remembered thing happened, which lives in the record's own properties. **Applies recursively**, so a `traverse` answer's `_graph` follows it at every depth. MCP takes the same parameter with the same default. A non-boolean is a `400`, never coerced |
| `includeDiagnostics` | — | `false` | Add back the three fields a result carries for the SYSTEM rather than for you: `matchedText` (the exact pre-embedding source string — for a file chunk, the passage a SECOND time), `embeddingModel` and `seq`. **Applies recursively**, so a `traverse` answer's `_graph` nodes and edges follow it at every depth. Off by default since 3.1.0 — before then this door sent them unconditionally while MCP sent none. **It does NOT gate the per-stage scores.** `lexicalScore`, `fusedScore` and `rerankScore` are returned unconditionally on both doors, because the one that decided a result's position must not be the one you cannot read — and three floats are not a cost worth a flag. The embedding VECTOR is not among them and is never returned by anything. A non-boolean is a `400`, never coerced |
| `projection` | — | none | Fields to include (1) or exclude (0), the same grammar `POST /query` takes, applied to each result's record. Dotted paths work: `{"name": 1, "properties.status": 1}`. **Applies recursively** — a `traverse` answer's `_graph` nodes and edges are projected at every depth, which is where a large answer's size actually comes from. Inclusion and exclusion cannot be mixed (the non-`_id` fields decide which you meant); `_id` survives an inclusion projection unless you send `_id: 0`; and the embedding VECTOR can never be projected back in — an explicit `embedding: 1` is dropped rather than honoured. The ranking envelope (`score`, `spaceId`, `type`, `_graph`) always survives, so a projection cannot lose the score you searched for |
| `maxChars` | — | `50000` REST / `25000` MCP | Ceiling on the serialised response body, in **characters**, and the ceiling that carries the defaults. **The default differs by DOOR: 50000 over REST, 25000 over MCP.** Both doors accept this parameter identically — same floor, same ceiling, same refusal — and only the number applied when you send nothing differs, because an MCP tool result meets a hard per-result ceiling inside the client that the caller cannot raise while a REST body lands in a buffer its caller allocated. Measured: a correct, in-budget 98356-character answer was refused outright by an MCP client. Raise it if yours can take more. **This is the parameter that used to be called `maxBytes`**: that name always counted characters, which equal bytes only for ASCII. **The answer is a PREFIX of the ranked results and every record in it is WHOLE** — full body, full properties, complete `_graph`, byte-identical to that record from an unbudgeted call. Truncation is atomic at the match: the first match whose subtree would not fit is omitted and so is everything after it, so no answer has a gap and none carries a record with half its graph. **That is what the guarantee costs** — the budgeted unit is a match TOGETHER WITH its subtree, so a deeper or wider `traverse` means fewer matches fit, and the ones that do not are absent rather than shortened. `returned`, `count`, `truncated`, `budgetChars`, `budgetBytes`, `charsReturned` and `bytesReturned` are on EVERY response, so absence never has to be interpreted; a truncated one adds `nextSkip`, which you send back as `skip` |
| `maxBytes` | — | **none** | Ceiling on the serialised response body, in **real UTF-8 bytes**. **BREAKING IN 3.7: this used to bound characters** while its name, its refusal message, its response field and this table all said bytes — true for ASCII and wrong for everything else. `Grüße aus Köln — ąćę` counts 31 characters against 39 bytes; three emoji count 17 against 23. A transport or client limit IS in bytes, so a German or Polish space was overrunning its stated budget by about a quarter. If you set this before and want the old behaviour, send the same number as `maxChars`. **It has no default**, deliberately: bytes are always ≥ characters, so a byte default equal to the character one would silently become the binding constraint on every non-ASCII answer. **When you set both, both apply** — the answer stops at whichever ceiling it reaches first |
| `maxTokens` | — | none | A convenience onto **`maxChars`**, converted with `charsPerToken` — the conversion produces characters, which is what it was always compared against. If both are sent the **smaller** resulting character figure applies. It is an approximation — the server does not know your tokeniser |
| `charsPerToken` | — | `3.5` | Ratio used to convert `maxTokens` to CHARACTERS — the row above says so, and this one said bytes. 3.5 rather than the customary 4.0 because 4.0 UNDER-counts tokens and is worst on graph-heavy responses: undershooting costs one page, overshooting costs a blown context |
| `skip` | — | `0` | How many of the ranked matches to skip before filling the byte budget. **This is how you read a truncated answer**: a response with `truncated: true` carries `nextSkip`, and sending it back gets you the next prefix — no match repeated, none missed. The ranking is recomputed per call, so it is a continuation over one ordered answer rather than a cursor over a snapshot |
| `remainderDump` | — | `false` | Also write the matches that did not fit to the space as JSON and report it as `remainder`. Only meaningful when the answer truncates. Off by default because it is a write on a read path that counts against space storage — page with `skip` to reach the same records without one |
| `crossSpace` | — | `false` | If `true`, search across all spaces the token can access |

**Response** `200`:

```json
{
  "source": { "_id": "...", "type": "entity", "name": "auth-service", "score": 1.0 },
  "results": [
    { "_id": "...", "type": "entity", "name": "auth-gateway", "spaceId": "dev-apps", "score": 0.91 },
    { "_id": "...", "type": "memory", "fact": "Auth service uses PKCE...", "spaceId": "dev-apps", "score": 0.84 }
  ]
}
```

- `source` echoes the input entry with `score: 1.0` (self-match) — excluded from `results`
- Results sorted by `score` descending
- `spaceId` included on each result when `crossSpace: true`

**With `traverse > 0`** the response carries the same graph-augmented shape `recall` uses: each match gains a `_graph`
array of `{edge, node, paths}`, nested nodes carry their own `_graph`, and the envelope adds `traverseDepth` and
`graphNodes`. `count` stays the number of matches. The traversed nodes are capped at
`min(topK × (traverse + 1) × 4, 5000)` minus the matches — the formula shapes a normal answer, and the
absolute figure is what keeps an uncapped `topK` from turning a walk into an unbounded query. It is the same builder behind both endpoints and both doors — see
[Graph-Augmented Recall](#graph-augmented-recall-traverse-parameter) for the field-by-field table.

```json
{
  "source": { "_id": "...", "type": "entity", "name": "auth-service", "score": 1.0 },
  "results": [
    {
      "_id": "...", "type": "entity", "name": "auth-gateway", "spaceId": "dev-apps", "score": 0.91,
      "_graph": [
        {
          "edge": { "_id": "...", "from": "...", "to": "...", "label": "depends_on", "description": "gateway calls it on every login", "tags": [] },
          "node": { "_id": "...", "type": "entity", "name": "token-service" },
          "paths": [["<match id>", "<token-service id>"]]
        }
      ]
    }
  ],
  "count": 1,
  "traverseDepth": 1,
  "graphNodes": 1
}
```

**Common use cases:**

| Use case | Parameters |
|----------|-----------|
| Dedup scan | `entryType: "entity"`, `targetTypes: ["entity"]`, `minScore: 0.90` |
| "More like this" | `topK: 5`, all target types |
| Cross-space merge detection | `crossSpace: true`, `minScore: 0.85`, `targetTypes: ["entity"]` |
| Memory consolidation | `entryType: "memory"`, `targetTypes: ["memory"]`, `minScore: 0.88` |
