# Graph-Augmented Recall (`traverse` parameter)

> Part of the [Ythril Integration Guide](../integration-guide.md).

## Graph-Augmented Recall (`traverse` parameter)

By default `recall` returns matches in isolation — the knowledge-graph edges between records are not consulted. Set `traverse` to an integer between `1` and `5` to follow the graph outward from every match: for each seed, the server walks edges up to `traverse` hops and returns the connected entities alongside the matches. This turns semantic search into context-aware retrieval — "recall the Vault service **and everything connected to it**" in one call, instead of a recall followed by manual `traverse`/`query` calls.

### Narrowing the walk: `traverse` as an object

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
KINDS at its ends rather than by the data. A fact names entities and an entity names nothing, so asking for
a fact's outbound links and its inbound links is not a choice between two answers; for an entity one of the
two is always empty. There is nothing for `direction` to select between, so it selects nothing.
Both walks treat a link as reaching the entity it names, whatever `direction` says: the standalone
[`POST /traverse`](04b-graph-api.md#traverse-graph) has always done so, and recall's expansion matches it.

The consequence worth knowing, because it surprises: `{"depth": 1, "direction": "inbound", "includeMemories":
true}` on a matched fact still returns the entities that fact **names**, which is an outbound step from the
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

**Same parameter, same parser, both doors, and on `similar` too.** Until 3.5 the expansion reachable from a
search could not narrow while the standalone tool could — one rule with two implementations, and the one people
actually reached was the weaker.

`traverse: 0` (the default) is behaviourally identical to classic recall and returns the classic response shape the [recall page](04a-recall-api.md#semantic-search-recall) documents. When `traverse > 0` the results are unchanged and each one gains a `_graph` array holding what the walk reached from it, plus `traverseDepth` and `graphNodes` on the envelope.

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
> list in two flows — the `/traverse` endpoint does exactly what they were building by hand.

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
      "score": 0.91, "spaceId": "work", "type": "entity",
      "record": { "_id": "adr-0042", "name": "Token Scoping", "type": "decision" },
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
| `edges` | **Every** edge joining this node to the one it is nested under, whole documents, `description` and `tags` included, `from`/`to` replaced by `direction` (`outbound`/`inbound`/`self`). Usually one; more for a pair joined twice, and on a node with a self-loop |
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
  ones that follow the `entityIds` a fact, chrono entry or file carries — are bounded per hop, and a hop can
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
  are always entities, and **links** — the `entityIds` field a fact, chrono entry or file carries naming what
  it is about. Edges are followed always; links are opt-in, one flag per kind:

  ```json
  { "traverse": { "depth": 2, "includeChrono": true, "includeMemories": true, "includeFiles": true } }
  ```

  Chrono and files default to **false** because the answer is budgeted: a match is counted with its whole
  `_graph` subtree, so every record admitted by default is paid for in matches that no longer fit. **Facts
  are the exception** — with `includeMemories` unsaid a walk brings the ATTRIBUTED claims of what it reached
  and no other fact, which is the only way a claim an AI assistant originated reaches you at all. All three
  values are tabulated on the [graph page](04b-graph-api.md#traverse-graph), with the standalone walk beside.

  A linked node arrives carrying `kind` (`chrono`, `fact` or `file`) and the fields that say what it is — a
  chrono's `title` and `type`, a fact's `fact`, a file's `path`, `description` and `tags`. **Never file chunk
  text:** a file's body is its passages, they are the largest thing stored, and a structural walk must not pay
  for them. Read the content with the file API if you want it.

  The reaching edge is **synthetic** and the only entry in that node's `edges`: `_id` in the form `<label>:<from>:<to>` — which is where its
  two ends still are — a label of `chrono.entityIds`, `fact.entityIds` or `file.entityIds`, and no `author`, `createdAt` or `seq`, because a
  derived edge has none. Do not look one up by that id; do use the label to tell a modelled relationship from a derived one. `edgeLabels`
  filters these exactly like any other label, so `{"edgeLabels": ["owns"]}` excludes them and
  `{"edgeLabels": ["owns", "fact.entityIds"]}` keeps the facts.
- **A non-entity seed reaches its own links.** An edge's endpoints are entity ids, so a fact, chrono entry or
  file that matched semantically has no edges of its own. With the matching flag on, the walk instead starts
  from the entities that match's `entityIds` names — they are hop 1, and everything an edge reaches from there
  is hop 2.

  Without the flags it still comes back with an empty `_graph`, which is what it always did. Before 3.6 there
  was no flag to turn on and the guidance here was to take the entity ids off the match and traverse from one
  of those by hand; that is now the server's job.

**Performance:** traversal issues roughly two batched (`$in`) MongoDB queries per hop, not one query per node. Even so, `traverse > 2` on a densely-connected graph can fan out quickly — pair it with `filter`, `tags`, or a low `topK` to keep the seed set (and therefore the traversal frontier) tight.
