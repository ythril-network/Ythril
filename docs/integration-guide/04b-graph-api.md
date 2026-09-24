# Entities, Edges & Graph

> Part of the [Ythril Integration Guide](../integration-guide.md).

## Entities, Edges & Graph

### Upsert an Entity

```http
POST /api/brain/spaces/:spaceId/entities
```

```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "name": "Kubernetes",
  "type": "technology",
  "tags": ["infra", "containers"],
  "description": "CNCF-graduated container orchestration platform.",
  "properties": { "cncf": true, "version": "1.32" }
}
```

**Response** `201`: Full entity doc.

> **`type` IS REQUIRED, and this is a BREAKING change in 4.0.** It used to default to the empty string on
> this endpoint alone: `save_entity`, the batch importer and `save_bulk` have always demanded it. `type`
> is what selects the per-type property schema, so an entity without one is an entity nothing can validate
> — and this was the door producing them. A create that omits it now answers `400`.
>
> There is no vocabulary to pick from in a space that declares no entity types, and none is needed: any
> non-empty string is accepted. Name the kind of thing it is.

**Identity model**: If `id` is supplied (must be a valid UUID v4), the entity with that `_id` is updated; if no entity with that ID exists, a new one is created with that ID. If `id` is omitted, a new entity is always inserted with a freshly generated UUID v4. Name is a non-unique searchable label, not a primary key. Multiple entities with the same name and type can coexist in a space (e.g. several "Lisa" entities of type "person").

**Duplicate warning**: When inserting without `id` and entities with the same `name` + `type` already exist, the response includes a `warning` field:

```json
{
  "_id": "...",
  "name": "Lisa",
  "type": "person",
  "warning": "2 existing entities with name 'Lisa' and type 'person' already exist in this space. A new entity was created because no id was supplied. To update an existing entity, provide its id."
}
```

Tags are merged (deduplicated union), properties are shallow-merged (new keys added, existing keys overwritten).

**Constraints**: `name` required string; `type` optional string (defaults to empty); `id` optional UUID v4 (400 if invalid); `tags` optional array of strings; `description` optional string (included in embedding text); `properties` optional object where each value must be a string, number, or boolean.

---

### Read one entity, or a set of them, by id

There is no `GET .../entities/:id`, and there has not been since 5.0. One record is a predicate over one
collection, so it is `filter` — the same call, the same envelope and the same refusals as a page of them:

```http
POST /api/filter
Content-Type: application/json

{ "space": "work", "collection": "entities", "filter": { "_id": "8f3c…" }, "limit": 1 }
```

**A record that is not there is `200` with `results: []`, not `404`.** A predicate matching nothing and a
record not existing are the same event to a filter. Branch on `results.length`, not on the status.

A SET of ids is `{"_id": {"$in": [...]}}`, which is what `entities/by-ids` did — unknown ids are absent
from `results`, as before. Keep your own cap; the route stopped at 100 and that is still a sensible number.
Matching a NAME is a predicate too: `{"name": "Kubernetes"}` is exact, and the sibling argument
`{"search": "kuber"}` is the case-insensitive substring across the searchable fields.

**A CHRONO entry is the exception, and it is the one that costs you if you miss it.** Its `status` is
DERIVED on read — an entry past its due moment is `overdue` whatever it was stored as, unless its type says
a passed date means nothing. The deleted route did that for you; `filter` returns the STORED value unless
asked, because a predicate has to be able to match what is on disk. Send `deriveStatus: true` for what the
old route gave you — it is refused on any other collection rather than ignored:

```json
{ "space": "work", "collection": "chrono", "filter": { "_id": "8f3c…" }, "limit": 1, "deriveStatus": true }
```

---

### List entities

There is no `GET .../entities`, and there has not been since 5.0 — listing a collection is one shape for
all of them:

```http
POST /api/filter
Content-Type: application/json

{ "space": "work", "collection": "entities", "limit": 50, "sort": "name", "dir": "asc" }
```

The answer is `{ results, count, total, limit, skip, truncated }` — `results` where the route said
`entities`, and `total` so a pager can tell a short page from the end of the match set.

`limit` defaults to 200 and has no maximum; the route's 50/500 are gone. Every narrowing parameter and
what each refuses is documented once in [the filter body](04d-brain-ops-api.md).

---

### Delete an Entity

```http
DELETE /api/brain/spaces/:spaceId/entities/:id
```

**Response** `204` when nothing references the entity (or the space has opted out with `strictLinkage: false`).

**Response** `409 Conflict` while anything still references it (the default; a space that opted out with `strictLinkage: false` deletes regardless). Delete or relink those items first — **or cascade**, which is `?cascadeToken=` and is documented under [Preview and Cascade a Delete](#preview-and-cascade-a-delete) below. The refusal body carries the preview route and the parameter name, so the next call is discoverable from the error itself.

> This paragraph used to read *"**There is no cascade** — no query parameter deletes an entity together with its references … so probing for a spelling that works will not find one"*, thirty lines above the section that documents exactly that. It was true until 4.0, and it is the reason the integrator who asked for the capability tried `?cascade=true`, `?force=true`, `?deleteEdges=true` and `?withEdges=true` before writing clear-then-delete by hand.

**BOTH ENDS OF AN EDGE COUNT, and the refusal used to say "inbound".** An edge pointing FROM this entity blocks the delete exactly as one pointing at it does, because either would be left dangling. The old message named a direction the check has never had, so a caller filtered on `to`, found nothing, and could not clear the block. It no longer names one, and each edge row carries the end that matched instead — `from`, `to`, or `both` for a self-loop.

Everything that can reference an entity is checked: **edges** on either endpoint, and the LINKS from **facts**, **chrono entries** and **files**. Only an edge has ends, so `end` is absent on the other three — a link says one record is about another rather than terminating at it, and labelling them would send you looking for an edge that does not exist.

Face labels (`file.faceEntityId`) are reported too, with `type: "face"` — but they are deliberately **not blocking**, because a face label is something the system inferred rather than a link somebody wrote. `backlinks` is the blocking set; `references` is everything found, face rows included, so a UI can warn *"this will unlabel N faces"* while showing why the delete was refused.

Response body:

```json
{
  "error": "Cannot delete: entity still has references — edge e1b2c3d4-... (at its from end), fact m5f6a7b8-.... Delete or relink those first — or remove the entity with its blocking edges in one step, through the cascade below.",
  "backlinks": [
    { "type": "edge", "_id": "e1b2c3d4-...", "end": "from" },
    { "type": "fact", "_id": "m5f6a7b8-..." },
    { "type": "chrono", "_id": "c9d0e1f2-..." },
    { "type": "file", "_id": "f3a4b5c6-..." }
  ],
  "references": [
    { "type": "edge", "_id": "e1b2c3d4-...", "end": "from" },
    { "type": "fact", "_id": "m5f6a7b8-..." },
    { "type": "chrono", "_id": "c9d0e1f2-..." },
    { "type": "file", "_id": "f3a4b5c6-..." },
    { "type": "face", "_id": "photo.jpg#face-chunk0" }
  ],
  "cascade": {
    "hint": "Either clear these edges yourself, or call the preview below and repeat this DELETE with its `cascadeToken`, which removes the EDGES and this entity and nothing at the other end of them.",
    "preview": "GET /api/brain/spaces/{spaceId}/entities/{id}/cascade-preview",
    "parameter": "cascadeToken"
  }
}
```

The MCP `delete_entity` tool refuses with the **same sentence**, from the same check. It used to word it differently and return no rows at all, so which client you used decided whether you could see what to clear.

---

### Preview and Cascade a Delete

A `DELETE` on an entity is refused with `409` while anything still references it, in a space with
`strictLinkage` on. **From 4.0 there is a second way out**, and the refusal now names it: preview exactly
what a cascade would remove, then repeat the delete quoting the token the preview returns.

```http
GET /api/brain/spaces/:spaceId/entities/:id/cascade-preview
```

**Response** `200`:

```json
{
  "entityId": "8c41…",
  "removes": [{ "type": "edge", "_id": "3f2a…" }, { "type": "edge", "_id": "9b7d…" }],
  "token": "b3d4…"
}
```

Then:

```http
DELETE /api/brain/spaces/:spaceId/entities/:id?cascadeToken=b3d4…
```

**Response** `204`, or `409` with the CURRENT preview attached if the token does not match.

**The token is bound to the SET, not to the entity.** It is a hash of the space, the entity and the sorted
list you were shown — so if an edge is added or removed between the two calls, the delete is refused and
tells you the list moved. **A record created after you looked cannot be deleted by a decision taken before
it existed**, which is the whole reason this is two calls rather than a `?cascade=true` flag: a flag saying
*"I checked"* cannot be checked.

It never expires and it is not a secret. A token that still matches means the list has not moved, which is
exactly when your decision is still good — and anyone who can compute it already knows the list, because
the `409` prints it.

**What it removes:** the EDGES and the entity. Nothing at the other end of those edges — a cascade takes
the relationships, not the records they join. A face label is not in the list either: the photo survives
and is unlabelled, which an ordinary delete already does.

**What it does NOT remove:** a fact, chrono entry or file that names the entity. Those are records of
their own rather than relationships, and they still block — the refusal names them, and you edit them to
drop the reference.

**An empty list still needs the token.** Nothing would be removed today, and a delete that skipped the
token when the list was empty would behave differently depending on a race.

---

### Merge Two Entities

```http
POST /api/brain/spaces/:spaceId/entities/:survivorId/merge/:absorbedId
Content-Type: application/json
```

Merge two entities into one. The **survivor** keeps its identity (ID, name, type, description); the **absorbed** entity is deleted after all references are relinked.

**Request body** (optional):

```json
{
  "resolutions": [
    { "key": "score", "resolution": "fn:avg" },
    { "key": "label", "resolution": "survivor" },
    { "key": "category", "resolution": "custom", "customValue": "merged-category" }
  ]
}
```

**Behaviour:**

| Scenario | Status | Response |
|----------|--------|----------|
| No property conflicts, or all conflicts resolved | `200` | Merged entity + relinking info |
| Unresolved property conflicts remain | `409` | `MergePlan` with conflict details |
| Survivor or absorbed entity not found | `404` | Error |
| Invalid resolution | `400` | Error |

**Response `200`** (merge executed):

```json
{
  "merged": { "_id": "...", "name": "...", "properties": { ... }, ... },
  "absorbedId": "absorbed-entity-uuid",
  "relinked": true,
  "duplicateEdgeWarnings": [
    {
      "survivorEdgeId": "edge-1-uuid",
      "absorbedEdgeId": "edge-2-uuid",
      "from": "survivor-uuid",
      "to": "target-uuid",
      "label": "depends_on"
    }
  ]
}
```

**Response `409`** (unresolved conflicts — no mutation):

```json
{
  "survivorId": "...",
  "absorbedId": "...",
  "propertyConflicts": [
    {
      "key": "score",
      "type": "number",
      "survivorValue": 80,
      "absorbedValue": 100,
      "suggestedFn": "avg",
      "resolved": false
    }
  ],
  "absorbedOnlyProperties": [
    { "key": "extra", "value": "info" }
  ],
  "duplicateEdgeWarnings": [],
  "endpointRuleWarnings": []
}
```

**Per-property resolution options:**

| Property type | Valid resolutions |
|---------------|-------------------|
| `number` | `"survivor"`, `"absorbed"`, `"fn:avg"`, `"fn:min"`, `"fn:max"`, `"fn:sum"` |
| `boolean` | `"survivor"`, `"absorbed"`, `"fn:and"`, `"fn:or"`, `"fn:xor"` |
| `string` / other | `"survivor"`, `"absorbed"`, `"custom"` (with `customValue`) |

**Relinking:** All edges, facts, and chrono entries referencing the absorbed entity are unconditionally rewritten to reference the survivor. Edges where `(from, to, label)` become identical after relinking appear in `duplicateEdgeWarnings[]` — the agent resolves them via `DELETE /api/brain/spaces/:spaceId/edges/:id`.

**`endpointRuleWarnings[]` — edges the relink moves onto an end their label forbids.** A merge is the only
operation that can produce one: every path that CREATES an edge refuses a broken `endpoints` or `functional`
rule, but a merge rewrites the `from`/`to` of stored edges, and merging entities of different types is the
normal case rather than a mistake — it is how a mistyped record gets fixed.

Each row is `{ edgeId, label, end, field, reason }`. `end` is which end of that edge the merge moves (`from`,
`to`, or `both` for a self-loop on the absorbed entity), `field` is `fromType`, `toType` or `functional` — the
same names a refused write uses — and `reason` says what the label admits.

**They are REPORTED, never blocking**, on the `409` preview and on the success body alike. Only an unresolved
property conflict makes a plan unresolved: a broken endpoint rule has no resolution to offer, and refusing
would leave duplicates unmergeable in any space that declared a rule after the data existed. Present on the
success body because that is when it matters — a plan with no property conflicts never produces a preview, so
reporting them only on the `409` would mean the commonest merge said nothing.

Only the end that MOVES is reported. The other end is unchanged by the merge; if it already breaks the rule
that is stored data, and [`POST /api/spaces/:id/validate-schema`](06-spaces-api.md) is what lists those.

**`suggestedFn`:** When `propertySchemas` includes a `mergeFn` for a conflicting property, it appears as `suggestedFn` in the conflict. The agent may accept or override it.

**Proxy spaces:** Not supported — target member spaces directly.

---

### Upsert an Edge

```http
POST /api/brain/spaces/:spaceId/edges
```

```json
{
  "from": "550e8400-e29b-41d4-a716-446655440000",
  "to": "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d",
  "label": "depends_on",
  "weight": 0.9,
  "type": "causal",
  "tags": ["infra"],
  "description": "K8s uses Docker as its container runtime."
}
```

**Response** `201`: Full edge doc.

| Field | Required | Description |
|-------|----------|-------------|
| `from` | yes | Source record id — an entity UUID v4 unless `fromKind` says otherwise, and a space-relative PATH when `fromKind` is `file`. Returns `400` for the wrong shape, or for an id that names nothing, when `strictLinkage` is on. |
| `to` | yes | Target record id, read the same way against `toKind`. |
| `fromKind` | no | What kind of record `from` points at: `entity`, `fact`, `chrono` or `file`. **Omit for an entity** — see below. |
| `toKind` | no | The same for `to`. |
| `label` | yes | Relationship label (e.g. `depends_on`, `related_to`) |
| `weight` | no | Numeric weight (0–1). Defaults to none. |
| `type` | no | Free-form edge type string (e.g. `causal`, `hierarchical`). |
| `tags` | no | Array of strings. Merged (union) with existing tags on upsert. Included in embedding text and filterable via `recall`. |
| `description` | no | Optional prose description of the relationship. Included in embedding text. |
| `properties` | no | Optional key-value metadata object. Values must be string, number, or boolean. Shallow-merged on upsert. |

Upserts on `(spaceId, from, to, label)`.

#### An endpoint is an entity unless the edge says otherwise (3.7)

An edge used to join two entities and nothing else, so `from` and `to` were bare entity ids and every reader
knew where to look them up. From 3.7 an endpoint can be **any** of the four kinds of record, and the edge says
which:

```json
{
  "from": "photos/2019/party.jpg",
  "fromKind": "file",
  "to": "550e8400-e29b-41d4-a716-446655440000",
  "toKind": "chrono",
  "label": "taken_at"
}
```

The case it exists for: a photo taken at a party. Its file meta wants to point at the people in it
(`entity`), at the party itself (`chrono`), and at what happened there (`fact`) — three collections, and a
bare `to` says nothing about which one to search. Guessing by trying each in turn is not an option, because
two records in different collections may share an id and the answer would then depend on the order the code
happened to try them.

**Omitting the field is the correct thing to do for an entity, and is not the same as sending `"entity"`.** An
omitted kind is stored as nothing at all, and every reader treats an absent kind as `entity` — so every edge
written before 3.7, and every ordinary entity-to-entity edge written after it, is byte-identical. Nothing was
migrated and nothing needs to be.

| | `entity` | `fact` | `chrono` | `file` |
|---|---|---|---|---|
| **the id is** | UUID v4 | UUID v4 | UUID v4 | space-relative path |
| **`400` on** | not a UUID | not a UUID | not a UUID | leading `/`, a `..` segment, or a backslash |
| **looked up in** | entities | facts | chrono | file meta |

A path is checked for shape on every write, and for existence only under `strictLinkage` — the same rule the
UUID kinds have always had.

**A stated kind that is wrong is refused, not stored.** Under `strictLinkage` the endpoint is looked up in the
collection its kind names, so `"toKind": "chrono"` with an entity's id is a `400` rather than a dead link. A
kind that is not one of the four is a `400` in every space, strict or not.

**Correcting one is a `PATCH`.** Both fields are accepted by `PATCH /edges/:id`, and they are the only way to
fix a wrong or missing kind: an edge's identity is its `(from, to, label)` triplet so the endpoint itself
cannot be moved, and delete-and-recreate does not survive a sync network — a tombstone removes only its
ISSUER's own content, so a peer-authored edge comes back. A corrected kind re-embeds on the next pass, because
the endpoint then resolves in the right collection.

**What the edge embeds changes with the kind.** An edge's vector is built from `from label to` with the
endpoints resolved to names: an entity's `name`, a chrono entry's `title`, a fact's `fact` (capped at 200
characters, so a long fact cannot crowd out the relationship itself), and for a file the path, which is
already its name. An endpoint that resolves to nothing falls back to the raw id, as it always has.

**Both kinds cross the wire.** They are declared on the sync ingest schema, so a peer receives the edge
meaning what its author meant. A field on a replicated document that the ingest schema does not declare is
kept on pull and deleted on push — same version, one direction, silently — which is why this is worth stating.

#### An edge's `_id` is DERIVED from the relationship, and moves when the relationship does

Since 3.6 an edge's `_id` is `uuidv5` over `(from, to, label)`, each part length-prefixed so no part can forge
the separator — and since 3.7 over the endpoint KINDS as well, because each collection assigns its own UUIDs
and a fact may hold the same id as an entity. `(X) -[mentions]-> (Y as entity)` and the same triplet with Y a
fact are two relationships, so they must be two ids.

**An entity-to-entity edge derives exactly the id it did before**, and that is a requirement rather than a
courtesy: a peer on an older build derives without the kinds, so appending them unconditionally would give the
two peers different ids for the same ordinary edge. They are appended only when at least one endpoint is not an
entity — a combination that could not exist before 3.7 and therefore has no older peer to disagree with. If you
derive ids yourself, omit the kinds for an entity-to-entity edge; do not send `"entity"`.

The unique index moved with it, to `(from, to, label, fromKind, toKind)`. An entity endpoint stores nothing —
`"entity"` is normalised to absent — so every edge written before 3.7 keys identically to a new ordinary one. Two peers creating the same relationship therefore arrive at the same id **without talking**,
and the sync collision is an idempotent no-op instead of a duplicate key on every cycle. `spaceId` is
deliberately not part of the key: space aliasing lets one logical space carry a different local id on each
peer, so including it would derive differently on the two sides — which is the defect this removes.

**This is a contract about ids, not only an implementation detail, because identity can change.** Mongo's
`_id` is immutable, so an edge whose identity changes is deleted and re-inserted under the id it now derives.
Two operations do that:

| what you did | what moves | what you get back |
|---|---|---|
| `PATCH /edges/:id` with a new `label` | the whole identity | a **different `_id`** in the response; the id you sent now `404`s |
| merging two entities | the relinked edges' endpoints | those edges come back under new ids |

**Read the id back from the response rather than reusing the one you sent** — the same discipline a file
`move` already asks for. Every other field patches in place and the id does not move; only `label` and the two
endpoints are identity.

An id you held across a merge answers `404`. To find where the relationship went, re-create the triplet with
`POST /edges` — an edge upsert is keyed on `(from, to, label)` rather than on an id, so it lands on the stored
row and hands you its current `_id`.

A merge resolves the collision case itself, by deleting the absorbed edge whose post-relink triplet a
survivor already holds.

An identity that is **already taken** by another edge is refused with `409 edge_identity_taken` naming the
edge in the way, rather than surfaced as an index violation.

**One case does not move: an edge this instance did not author.** Deleting the old id on a peer requires a
tombstone issued by the document's own author — that rule is what stops one instance deleting another's
content, and it applies here too. So an edge that arrived from a peer keeps its original id when its identity
changes, exactly as every edge did before 3.6. It is one row, it converges, and the only cost is that a third
peer creating the same relationship derives a different id and hits the unique index, which is the behaviour
this feature narrows rather than removes.

Edges created before 3.6 keep their original random ids. There is no migration and none is needed: a derived
id only has to be agreed on by peers creating an edge from now on.

---

### List edges

Same shape, different collection — and the same since 5.0:

```http
POST /api/filter
Content-Type: application/json

{ "space": "work", "collection": "edges", "limit": 50, "fromName": "Ada" }
```

Each row carries `fromName` and `toName` — the endpoint entities' names, resolved per member space. That
is a JOIN rather than a field, which is why a client holding ids cannot produce it and why `filter` does.

---

### Delete an Edge

```http
DELETE /api/brain/spaces/:spaceId/edges/:id
```

**Response** `204`.

---

### Traverse Graph

BFS traversal from a starting entity, following edges up to `maxDepth` hops.

> **Not to be confused with `recall`'s `traverse` parameter**, which shares the name and does a different
> job: it expands outward from whatever a *semantic query* matched, while this endpoint starts from an
> **entity id you already hold**. Use this one when you have the node; use
> [`recall` with `traverse`](04h-graph-augmented-recall.md#graph-augmented-recall-traverse-parameter) when you can only describe it.

```http
POST /api/brain/spaces/:spaceId/traverse
```

**Body**:

```json
{
  "startId":    "entity-uuid",
  "direction":  "outbound",
  "edgeLabels": ["depends_on", "references"],
  "maxDepth":   2,
  "limit":      50
}
```

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `startId` | ✅ | — | UUID of the starting entity |
| `direction` | — | `"outbound"` | `"outbound"` follows edges from the node, `"inbound"` follows edges to it, `"both"` follows in either direction. **Stored edges only** — it does not narrow links; see below |
| `edgeLabels` | — | all labels | Filter traversal to specific edge labels only |
| `maxDepth` | — | `3` | Maximum hops from `startId`; hard-capped at `10` |
| `limit` | — | `100` | Maximum total nodes returned, **clamped to 1–1000 on both doors** — `limit: 5000` silently becomes 1000. The neighbouring `maxDepth` row states its ceiling and this one did not |
| `includeChrono` | — | `true` | Also reach chrono entries LINKED to a traversed node. Set `false` for entity-only results. A non-boolean is a `400`, never coerced |
| `includeMemories` | — | `false` | Also reach facts LINKED to a traversed node, marked `kind: "fact"`. **Opt-in, unlike `includeChrono`** — see the note below. A non-boolean is a `400`. **This door's `false` is a real default**, so an unsaid flag brings no facts: recall's expansion differs and brings ATTRIBUTED claims when the flag is unsaid, because its caller asked a question rather than asked to explore — see [the recall page](04a-recall-api.md) |
| `includeFiles` | — | `false` | Also reach files LINKED to a traversed node, marked `kind: "file"` and carrying **file meta only**. Opt-in. A non-boolean is a `400` |
| `includeEdges` | — | `true` | Whether the response carries the `edges` list. **This does not change the walk** — edges are how the graph is traversed. A non-boolean is a `400` |
| `projection` | — | none | Return each reached record's **body**, projected — see [Bodies in one call](#bodies-in-one-call-projection) below. Omitted, the answer is the lean one, unchanged. A non-object is a `400` |
| `includeDiagnostics` | — | `false` | With `projection`: add back `matchedText`, `embeddingModel` and `seq` on each body. Never the vector. A non-boolean is a `400` |

> **`includeMemories` means three things on a RECALL, and this table is the one to read for it.** An
> *attributed* claim is one an AI assistant originated rather than a person. It is stored with no vector, so
> nothing can rank it — which keeps a model's contributions out of the ranked slots somebody asked a question
> to fill, and would hide them completely if the expansion did not reach them.
>
> | `includeMemories` on `recall`'s `traverse` | what arrives |
> |---|---|
> | unsaid | the attributed claims of what the walk reached, and no other fact |
> | `true` | every linked fact |
> | `false` | none, attributed included — an explicit refusal is still a refusal |
>
> **On THIS door it is a plain `false`** and an unsaid flag brings no facts at all: a caller here is
> exploring a graph and says what it wants, where a recall asked a question and is owed the context.

**`truncated: true` has three causes, and one of them is new in 3.7.** The node cap filled; a link scan spent
its budget; or **a hop's EDGE read spent its budget**. The third used to be impossible to report because the
read was unbounded — one hub entity pulled its entire edge set into fact per hop, and the node cap could not
prevent it, because that cap counts nodes EMITTED and a neighbour already visited or of a non-entity kind is
skipped without spending any of it.

So a walk through a hub now answers `truncated: true` where it previously answered a complete-looking result it
had paid a very large read for. Treat the flag as *"there was more graph than this answer contains"* rather
than as *"the node cap filled"* — the two were the same thing until this release and are not any more.

**`direction` narrows stored edges and never links.** A link is a **record** with a `from` and a `to` since 4.0 — but which way it runs is fixed by the
KINDS at its ends rather than by the data. A fact names entities and an entity names nothing, so asking for
a fact's outbound links and its inbound links is not a choice between two answers; for an entity one of the
two is always empty. There is nothing for `direction` to select between, so it selects nothing.

Honouring it on links would empty the DEFAULT traverse: `outbound` from an entity would reach no linked records
at all, because nothing hangs off an entity. With
`includeChrono`, `includeMemories` or `includeFiles` on, the walk reaches the records that NAME this entity
whatever `direction` says. The traverse expansion inside `recall` behaves identically, deliberately: two walks
disagreeing about one parameter is worse than either reading of it.

**Response** `200`:

```json
{
  "nodes": [
    { "_id": "...", "name": "auth-service", "type": "service", "depth": 1 },
    { "_id": "...", "name": "user-service",  "type": "service", "depth": 2 },
    { "_id": "...", "name": "Unit collected by carrier", "type": "event", "depth": 1, "kind": "chrono" }
  ],
  "edges": [
    { "_id": "...", "from": "...", "to": "...", "label": "depends_on" },
    { "_id": "...", "from": "...", "to": "...", "label": "chrono.entityIds" }
  ],
  "truncated": false
}
```

- `nodes` — `startId` itself at **depth 0**, then every record the walk reached, each with the `depth` it
  was found at. **An empty `nodes` therefore means the id resolved to nothing**, which is a different
  answer from "it has no neighbours" — an isolated record comes back as one node rather than as nothing.
  The start node counts against `limit` like any other, so `limit: 1` answers the start alone, which is
  also the cheapest way to ask whether an id exists.

  > *Changed in 5.0:* the start node was excluded, so an isolated record and a bad id both answered
  > `nodes: []`. The tool's schema described the depth-0 node throughout — this makes the description
  > true rather than correcting it, because the distinction it promises is the reason it was written.
- `edges` — **every** edge among the records in `nodes`, including a **self-loop** and including a second
  edge between a pair already joined once. An edge to a record that is not in `nodes` is not listed: a
  relationship to something the answer does not contain says nothing a caller can use.

  > *Changed in 5.0:* this listed one edge per node reached — the one that got there first. So a
  > self-loop was never returned (its far end is always already visited) and the second of two
  > differently-labelled edges between one pair silently disappeared, with `truncated: false`, which
  > means *nothing was cut for size*. If you read `edges` as the relationships in a neighbourhood, it
  > now is.
- `truncated: true` if `limit` was reached before exhausting the graph

Server-side cycle detection ensures each record is visited at most once, so cyclic graphs are handled safely.

#### An edge to a fact, chrono entry or file is followed, and no flag governs it

An edge declares the KIND at each end — `entity`, `fact`, `chrono` or `file` — and the writer refuses a kind
that does not match the record. So `supersedes` between two facts is a real, validated, stored, replicated
edge, and traversal follows it like any other. The node carries the `kind` of the collection it lives in.

**A walk can therefore START from a fact or a chrono entry**, not only an entity.

> *Changed in 5.0:* the walk used to resolve every neighbour against the entities collection alone and drop
> whatever was not there — no flag, no `truncated`, no error. An edge the write had accepted was stored and
> reached by nothing, which is the *"stored, returned, and points at nothing traversable"* report arriving by
> a different route. If you avoided non-entity endpoints because they seemed inert, they were.

**No include flag gates this, and the asymmetry with the flags below is deliberate.** `includeMemories` and
`includeFiles` are opt-in because they follow IMPLICIT links — a record that happens to name this one — of
which a busy node has thousands. An edge document exists only because somebody drew it, so there are exactly
as many as were meant.

#### Chrono entries are nodes

A chrono-to-entity link is what joins a timeline to the graph, and traversal follows it — a chrono entry
that references a traversed node is returned as though joined by an **inbound** edge, which is what that
field is. No schema change was needed; the link already existed and simply had no reader here.

- **A chrono node carries `kind: "chrono"`. An entity node carries no `kind` at all**, so every response you
  were already parsing is unchanged. Read `kind` before following an `_id`: the two live in different
  collections, and `type` cannot tell you which (a chrono's is `event`/`deadline`/…, an entity's is whatever
  the space calls it).
- **The synthetic edge is labelled `chrono.entityIds`** — a frozen token naming the 4.x field this link
  class replaced, and part of the link's derived id — and it carries its own id, shaped
  `<label>:<from>:<to>` — deliberately not a UUID, because there is no stored edge behind it and an id that
  looked like a real one would invite a lookup that cannot succeed. **Do not fetch a synthetic edge by id:**
  `GET /edges/:id` reads the edge collection only, so any id here answers `404`. Follow the NODE instead.
  Because the label is real, `edgeLabels` filters it like any other: an explicit filter that does not name it
  **excludes** chrono entries.

  > *Changed:* this id used to be the chrono's own `_id`, on the stated rationale that looking it up would
  > resolve to the chrono. It never did — the edge lookup is collection-scoped — and sharing an id between a
  > node and an edge made graph libraries drop the edge, since they keep one id namespace for both.
- **A chrono reached through its LINK is a leaf.** Traversal does not expand outward from one — a chrono's
  a chrono entry links to entities, not to other chrono entries, so expanding would only walk back to entities
  already visited. **A chrono reached through an explicit EDGE is not a leaf**: an edge chains, and stopping
  there would answer one hop of a chain and call it the neighbourhood.
- Set `includeChrono: false` for the previous entity-only behaviour.

#### Facts are nodes too, on request

A fact-to-entity link is the same kind of thing, and `includeMemories: true` follows it. A fact node carries
`kind: "fact"`, its `name` is the fact's `fact`, and its `type` may be an empty string — a fact's type is
optional, unlike a chrono's. The synthetic label is `fact.entityIds`, and like the chrono label it is filtered
by an explicit `edgeLabels`. A fact reached through that link is a leaf, for the same reason a chrono is —
but a fact reached through an explicit edge is expanded, which is what makes a chain of `supersedes` edges
walkable in one call.

**Why this one is opt-in when `includeChrono` is not.** Chrono entries are sparse — an incident has ten, not ten
thousand — and were invisible without traversal. Facts are usually the most numerous record type in a space,
and every node returned counts against `limit`. On by default, a fact-heavy space would fill the answer with
facts and truncate away the entities you traversed for. Turn it on deliberately, and raise `limit` with it.

#### Files are nodes too, and only their meta comes back

`includeFiles: true` follows a file-to-entity link, so a document about an entity is reachable from it. The node is
the **file**, not its passages: `_id` and `name` are the path, and `description` and `tags` ride along when set.

**No passage text, ever.** A file's body is its chunks — the largest thing this product stores, and what
`recall` returns when you search for content. A structural walk must not pay for them, so a file node carries
none: no `content`, no `matchedText`, no `chunkIndex`. Once you know which document you want, read it with the
file API.

This also means **one node per file, not one per chunk**. Chunks live in the same collection as the file they
belong to and are distinguished only by `parentFileId`; the traversal excludes them explicitly. A forty-passage
document is one node.

Opt-in for the same reason as facts, and the synthetic label is `file.entityIds`.

#### Suppressing the edge list

`includeEdges: false` returns the same `nodes` with `edges: []`. It is a **response** switch, not a traversal
one: the walk still follows every edge it would otherwise, so the node set is byte-for-byte what you would get
with the list included. Use it when you want what is reachable and the connecting relationships would only cost
tokens — a large traversal spends much of its payload on edges.

If you need fewer edges *followed*, that is `edgeLabels`, which genuinely narrows the walk.

#### Bodies in one call: `projection`

A walk returns nodes as `_id`, `name`, `type`, `depth` (and `kind`), and edges as `_id`, `from`, `to`, `label`.
That is what makes it cheap, and it is also why reading a subgraph's CONTENT used to take the walk plus a
`query` per collection over the ids it returned. Send a `projection` and each reached record comes back with
its body instead — the same grammar `query` and `recall` take, applied to every node and every stored edge:

```json
{ "startId": "cd2c0dc6-e7b0-4759-a3a9-bd537e4f2d64", "maxDepth": 10, "limit": 1000,
  "includeChrono": false, "projection": { "description": 1, "properties": 1 } }
```

- **The walk's envelope always survives.** `_id`, `depth` and `kind` on a node; `_id`, `from`, `to` and `label`
  on an edge. A projection cannot remove them, because they are how the answer hangs together.
- **The vector never comes back**, and `matchedText`/`embeddingModel`/`seq` only with `includeDiagnostics`.
- **An edge's `properties` come with it**, which is where a conditional edge keeps its instruction and
  predicate.
- **A link-derived edge** (`chrono.entityIds` and the like) has no stored document and is returned as it was;
  so is a node whose record was deleted between the walk and the read.
- It costs one read per collection per member space, bounded by the ids the walk already returned — the
  walk's own `limit` bounds it.

Same parameters on MCP `graph_traverse`. Added in `F-32`, after the owner, shown a three-call recipe for this,
asked: *"is that not just an includes flag?"*

This closes a gap an integrator measured: reconstructing a 33-day hardware-RMA timeline took four `query()`
calls plus two repository greps, and the first pass still missed the carrier ticket — it had to be found by a
name regex instead of by traversal from the incident.

---

### Data Model (inferred ER)

```http
GET /api/spaces/:spaceId/meta
```

The space's entity-relationship model, derived from the schema **and** from what is stored. Read-only,
nothing cached, every number a real count of records.

> **Folded into the space meta at 5.0.** The `er-model` route and the `er_model` tool are both gone; the same answer arrives as `actualSchema` on the space meta, beside the DECLARED schema. Both halves answer "what is this space like before I write to it", and having them together is what lets a type the space really holds be promoted into its declared schema. Same proxy rule (members reported separately),
> and available to every token including read-only ones. It answers what a space *contains*, where
> `space_meta` answers what its schema *permits*; an agent deciding how to write into an unfamiliar
> space usually wants both.

```json
{
  "spaceId": "ops",
  "entityTypes": [
    {
      "type": "service",
      "count": 128,
      "declared": true,
      "namingPattern": "^[a-z-]+$",
      "properties": [
        { "name": "tier", "type": "string", "required": true, "enumValues": ["gold", "silver"] }
      ],
      "linkedFrom": { "facts": 412, "chrono": 0, "files": 89 }
    }
  ],
  "relationships": [
    { "from": "deployment", "to": "service", "label": "targets", "count": 1204 }
  ],
  "danglingEdges": 0,
  "truncated": null,
  "totals": { "entities": 1771, "edges": 1929 }
}
```

**Both sources, because they disagree and the disagreement is the point.** Three cases, and a caller should
handle all three:

| `declared` | `count` | what it means |
|---|---|---|
| `true` | `> 0` | the ordinary case |
| `true` | `0` | a type nobody writes — the schema is aspirational, or the writers do not know it exists |
| `false` | `> 0` | **records outside the declared vocabulary.** Under `validationMode: "strict"` these can no longer be written, so they are history; under `warn` they are still arriving |

A model built from `typeSchemas` alone would show the second case and silently omit the third — which is
backwards, because the third is the one nobody knows about.

Notes:

- **`relationships` are type-level.** An edge joins two entity *instances*; a relationship is the edge set
  grouped by `(from type, label, to type)`, with `count` being how many real edges back it.
- **`danglingEdges`** counts edges whose endpoint does not resolve to an entity. Normally `0`; a non-zero
  value on a space with `strictLinkage` on is worth investigating.
- **`truncated`** is `null` or `{ scan, limit }`. Both reads are capped, and a capped read says so rather
  than presenting a partial diagram as complete. `totals` is measured **before** the cap, so you can see
  what share of the space the model covers.
- **An entity with no `type` is bucketed as `(untyped)`** rather than dropped, so the per-type counts add up.
- **`properties` lists what the schema declares**, not what records happen to carry. An undeclared type
  reports `[]` — the model does not infer a schema from data it has not been asked to validate.
- **On a proxy space the members are reported separately**, as `{ spaceId, members: [ …model per member… ] }`.
  They are not merged: two spaces can use one type name for different things, and an edge cannot cross a
  space, so a merged model would show relationships that can never be joined.
