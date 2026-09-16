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

### Find Entities by Name

```http
GET /api/brain/spaces/:spaceId/entities/by-name?name=Kubernetes
```

**Response** `200`:

```json
{
  "entities": [ ... ]
}
```

Returns entities whose name matches the query as a **case-insensitive substring** (not an exact match), regardless of type, **capped at 20 results**. Multiple entities may share a name (name is not a unique key).

---

### Get Entities by IDs

```http
GET /api/brain/spaces/:spaceId/entities/by-ids?ids=id1,id2,id3
```

Batch-fetch entities by ID. `ids` is a comma-separated list (required — `400` if missing), deduplicated and capped at **100** IDs per call. Returns `{ "entities": [ ... ] }`; unknown IDs are simply absent from the result.

---

### Get an Entity by ID

```http
GET /api/brain/spaces/:spaceId/entities/:id
```

Returns the single entity, or `404` if no entity with that ID exists in the space. Edges and chrono entries have the same single-doc shape — `GET /api/brain/spaces/:spaceId/edges/:id` and `GET /api/brain/spaces/:spaceId/chrono/:id`.

---

### List Entities

```http
GET /api/brain/spaces/:spaceId/entities?limit=50&skip=0&sort=name&dir=asc
```

**Response** `200`:

```json
{
  "entities": [ ... ],
  "limit": 50,
  "skip": 0
}
```

Default limit: 50, max: 500.

`sort` and `?search=` work the same way on every brain list endpoint — see [Sorting](04-brain-api.md#sorting-all-brain-list-endpoints) and [Freetext search](04-brain-api.md#freetext-search-search).

---

### Delete an Entity

```http
DELETE /api/brain/spaces/:spaceId/entities/:id
```

**Response** `204` when nothing references the entity (or the space has opted out with `strictLinkage: false`).

**Response** `409 Conflict` while anything still references it (the default; a space that opted out with `strictLinkage: false` deletes regardless). Delete or relink those items first — **or cascade**, which is `?cascadeToken=` and is documented under [Preview and Cascade a Delete](#preview-and-cascade-a-delete) below. The refusal body carries the preview route and the parameter name, so the next call is discoverable from the error itself.

> This paragraph used to read *"**There is no cascade** — no query parameter deletes an entity together with its references … so probing for a spelling that works will not find one"*, thirty lines above the section that documents exactly that. It was true until 4.0, and it is the reason the integrator who asked for the capability tried `?cascade=true`, `?force=true`, `?deleteEdges=true` and `?withEdges=true` before writing clear-then-delete by hand.

**BOTH ENDS OF AN EDGE COUNT, and the refusal used to say "inbound".** An edge pointing FROM this entity blocks the delete exactly as one pointing at it does, because either would be left dangling. The old message named a direction the check has never had, so a caller filtered on `to`, found nothing, and could not clear the block. It no longer names one, and each edge row carries the end that matched instead — `from`, `to`, or `both` for a self-loop.

Everything that can reference an entity is checked: **edges** on either endpoint, and the `entityIds` of **memories**, **chrono entries** and **files**. Only an edge has ends, so `end` is absent on the other three — they HOLD a reference in a list rather than terminating at one, and labelling them would send you looking for an edge that does not exist.

Face labels (`file.faceEntityId`) are reported too, with `type: "face"` — but they are deliberately **not blocking**, because a face label is something the system inferred rather than a link somebody wrote. `backlinks` is the blocking set; `references` is everything found, face rows included, so a UI can warn *"this will unlabel N faces"* while showing why the delete was refused.

Response body:

```json
{
  "error": "Cannot delete: entity still has references — edge e1b2c3d4-... (at its from end), memory m5f6a7b8-.... Delete or relink those first; there is no cascade delete for an entity.",
  "backlinks": [
    { "type": "edge", "_id": "e1b2c3d4-...", "end": "from" },
    { "type": "memory", "_id": "m5f6a7b8-..." },
    { "type": "chrono", "_id": "c9d0e1f2-..." },
    { "type": "file", "_id": "f3a4b5c6-..." }
  ],
  "references": [
    { "type": "edge", "_id": "e1b2c3d4-...", "end": "from" },
    { "type": "memory", "_id": "m5f6a7b8-..." },
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

**What it does NOT remove:** a memory, chrono entry or file that names the entity. Those are records of
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

**Relinking:** All edges, memories, and chrono entries referencing the absorbed entity are unconditionally rewritten to reference the survivor. Edges where `(from, to, label)` become identical after relinking appear in `duplicateEdgeWarnings[]` — the agent resolves them via `DELETE /api/brain/spaces/:spaceId/edges/:id`.

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
| `fromKind` | no | What kind of record `from` points at: `entity`, `memory`, `chrono` or `file`. **Omit for an entity** — see below. |
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
(`entity`), at the party itself (`chrono`), and at what happened there (`memory`) — three collections, and a
bare `to` says nothing about which one to search. Guessing by trying each in turn is not an option, because
two records in different collections may share an id and the answer would then depend on the order the code
happened to try them.

**Omitting the field is the correct thing to do for an entity, and is not the same as sending `"entity"`.** An
omitted kind is stored as nothing at all, and every reader treats an absent kind as `entity` — so every edge
written before 3.7, and every ordinary entity-to-entity edge written after it, is byte-identical. Nothing was
migrated and nothing needs to be.

| | `entity` | `memory` | `chrono` | `file` |
|---|---|---|---|---|
| **the id is** | UUID v4 | UUID v4 | UUID v4 | space-relative path |
| **`400` on** | not a UUID | not a UUID | not a UUID | leading `/`, a `..` segment, or a backslash |
| **looked up in** | entities | memories | chrono | file meta |

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
endpoints resolved to names: an entity's `name`, a chrono entry's `title`, a memory's `fact` (capped at 200
characters, so a long fact cannot crowd out the relationship itself), and for a file the path, which is
already its name. An endpoint that resolves to nothing falls back to the raw id, as it always has.

**Both kinds cross the wire.** They are declared on the sync ingest schema, so a peer receives the edge
meaning what its author meant. A field on a replicated document that the ingest schema does not declare is
kept on pull and deleted on push — same version, one direction, silently — which is why this is worth stating.

#### An edge's `_id` is DERIVED from the relationship, and moves when the relationship does

Since 3.6 an edge's `_id` is `uuidv5` over `(from, to, label)`, each part length-prefixed so no part can forge
the separator — and since 3.7 over the endpoint KINDS as well, because each collection assigns its own UUIDs
and a memory may hold the same id as an entity. `(X) -[mentions]-> (Y as entity)` and the same triplet with Y a
memory are two relationships, so they must be two ids.

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

### List Edges

```http
GET /api/brain/spaces/:spaceId/edges?limit=50&skip=0
```

**Response** `200`:

```json
{
  "edges": [ ... ],
  "limit": 50,
  "skip": 0
}
```

---

### Delete an Edge

```http
DELETE /api/brain/spaces/:spaceId/edges/:id
```

**Response** `204`.

---

## Links

A **link** says one record CONCERNS another. A memory about an entity, a chrono entry about a memory, a
file about all three. It is not an edge and cannot become one: it carries no label, no weight, no
properties and no type, because saying **how** two things relate is what an edge is for.

These are the six public array fields — `memory.entityIds`, `chrono.entityIds`/`memoryIds` and
`file.entityIds`/`memoryIds`/`chronoIds` — stored as records of their own, so that everything which
asks *"what is adjacent to this?"* has one place to look instead of following a different subset of the six.

**The six classes, and there is no seventh:**

| from | to | the array it is |
|---|---|---|
| memory | entity | `memory.entityIds` |
| chrono | entity | `chrono.entityIds` |
| chrono | memory | `chrono.memoryIds` |
| file | entity | `file.entityIds` |
| file | memory | `file.memoryIds` |
| file | chrono | `file.chronoIds` |

An entity is only ever the **to** end. Nothing hangs off an entity, which is why there is no `entity.…`
class — the way to say something about two entities is an edge.

**All six are followed by a traversal from 4.0.** Three of them — `chrono.memoryIds`, `file.memoryIds` and
`file.chronoIds` — were accepted, resolvability-checked, stored, replicated and documented since 3.x with no
reader at all, so the ids were visible on the record and the graph returned nothing. They are also visible
to the scan that refuses a delete, and to the check sync runs on arriving records.

**Writing a link also writes the array**, and reading one back is the same fact either way. That is what
makes a link durable rather than a second opinion: an ordinary `PATCH` of the memory would otherwise
silently drop a link record the array never claimed.

**On a CONVERTED space the arrays stop being a write surface.** Once `npm run links:convert` has finished a
space, `completeLinkage` is set on it and a body carrying `entityIds`, `memoryIds` or `chronoIds` is refused
with a `400` naming this endpoint. The fields are still READ, still stored and still replicated — nothing you
have is lost, and nothing changes on a space you have not converted.

Three things it deliberately never does:

- **It is not `validationMode: strict`.** That governs schema rules and is already set on live spaces;
  hung off it, every one of them would start refusing on upgrade.
- **It never applies to records arriving from a peer.** Sync ingest is validated, counted and let in — a
  refusal there would hold the watermark and the channel would stop.
- **It never applies to a write that does not MENTION an array.** A `PATCH` of a memory's `fact` on a record
  still carrying a legacy array succeeds, or every unconverted record would become uneditable.

### Running the conversion: scope, preview, prerequisites, and undoing it

**Preview first. It reads and writes nothing**, and it answers the question you actually have before running
a migration against live data — how much is there:

```bash
npm run links:convert -- --preview            # every space
npm run links:convert -- --preview <spaceId>  # one space
```

It prints, per space, how many records carry each connection list, how many entries those lists hold, and how
many link records the space already has. Run it again afterwards: the link count rises and nothing else
moves. The entry count is a CEILING rather than a prediction — an entry naming a record that no longer exists
makes no link, and two entries naming the same pair make one.

**It is per SPACE, and one space is a real pilot.** `npm run links:convert -- <spaceId>` converts that space
alone and deliberately does NOT set `completeLinkage`. So the link records appear, the graph starts answering
from them, and **every existing writer keeps working** — nothing is refused, because the marker is what arms
the refusal. Only a run with no argument walks every space and marks each one that finished without failures.

**So the prerequisite is not "before you convert" — it is "before you MARK".** Between the two you can find
your remaining array writers at your own pace. Note that the list includes agent sessions: `save_chrono`
and its siblings accept `entityIds` directly, so an agent writing to a marked space gets the same `400`.

**And the marker is reversible.** `completeLinkage` is an ordinary space setting:

```bash
curl -X PATCH https://<host>/api/spaces/<spaceId> \
  -H 'authorization: Bearer <token>' -H 'content-type: application/json' \
  -d '{"completeLinkage": false}'
```

Array writes are accepted again immediately. The link records a conversion created stay — they are not what
the marker switches, and they are what the graph reads either way.

**Running it twice is a no-op.** A link's id is derived from the pair and the class, so a second run
recomputes the same ids, finds them stored, and writes nothing. An interrupted run is fixed by running it
again rather than by working out where it stopped. It never removes an array.

**There is no `GET`.** Links are a queryable collection like any other — `POST /api/brain/filter`
with `collection: "links"` and the full filter grammar. A list endpoint here would be a second, weaker copy
of it.

---

### Create a Link

```http
POST /api/brain/spaces/:spaceId/links
Content-Type: application/json
```

```json
{
  "from": "3f2a…",
  "fromKind": "memory",
  "to": "8c41…",
  "toKind": "entity"
}
```

All four fields are required. `fromKind` and `toKind` are one of `entity`, `memory`, `chrono`, `file`, and
they are **not guessed from the id** — the same UUID could name records in two collections, and a wrong
guess produces a link that reads as correct and points at nothing.

**Response** `200` with the link record, including its `_id` and a derived `label` (`memory.entityIds`).

**It is an upsert, and `200` rather than `201` says so.** A link's `_id` is a UUIDv5 over the two records
and the class, so one connection has exactly one id for ever: creating a link that already exists succeeds
and changes nothing. Retry it as often as you like — it cannot produce a duplicate, and it will never
report a conflict.

**Refusals:**

| | |
|---|---|
| `400` | a `(fromKind, toKind)` pair outside the six — the error names the ones that are allowed |
| `400` | under `strictLinkage`, either end failing to resolve |
| `404` | the `from` record does not exist — there is no array to write into |

---

### Delete a Link

```http
DELETE /api/brain/spaces/:spaceId/links/:id
```

**Response** `204`, or `404` if the id is not a link.

The two records at either end are untouched. The array entry goes with the record, so nothing is left
claiming the connection, and a tombstone is written so the removal reaches peer instances on the next sync
instead of being restored by one that still holds it.

---

### Conversion Pre-flight — who still writes the arrays

```http
GET /api/brain/spaces/:spaceId/links/convert-preflight?windowDays=30
```

MCP: `graph_link_preflight`, same parameter and same default.

**Read this before running `links:convert`.** Conversion sets `completeLinkage`, after which the six array
fields are refused on write. That refusal reaches a caller on its **next write**, not at conversion time — so
without this you convert, and learn which of your writers still use the old surface when one of them breaks,
possibly a week later.

**Response**:

```json
{
  "spaceId": "tasks",
  "since": "2026-08-09T07:00:00.000Z",
  "retentionDays": 90,
  "converted": false,
  "writers": [
    { "tokenId": "…", "tokenLabel": "ingest-worker", "fields": ["entityIds"], "lastAt": "2026-09-07T22:14:03.001Z", "count": 412 }
  ]
}
```

| field | meaning |
|---|---|
| `since` | the instant the answer starts from. **Read it before the count** — a count with no window on it cannot be told apart from a count over a shorter one |
| `retentionDays` | how far back a note can exist at all. A larger `windowDays` cannot see past it, and is capped to it |
| `writers` | one row per token, with the array fields it sent, when it last did, and how many times. Empty is what you are hoping for |
| `converted` | already converted? Then the arrays are refused and this answers about the window before that |

A writer whose token no longer exists still appears, under the label it had. A write that arrived with no
token is reported with `tokenId: null` rather than dropped — dropping it would make the count lower than the
truth, and a lower count reads exactly like a cleaner space.

**`windowDays`** defaults to `30` and is CAPPED at `retentionDays` rather than refused -- ask for 365 and you are served 90, with `since` saying so. A non-positive value is refused on both doors, because there is no honest answer to serve for one. **Both doors behave identically here**, deliberately: the cap lives in the resolver they share, and an `inputSchema` bound would have made MCP refuse what REST served.

**What is counted**: any write naming `entityIds`, `memoryIds` or `chronoIds`, on any of the seven write
doors, including creates and including a value of `[]` or `null` — a present key is a write. Notes are taken
only while a space is unconverted, which is the window this question is about.

---

### Traverse Graph

BFS traversal from a starting entity, following edges up to `maxDepth` hops.

> **Not to be confused with `recall`'s `traverse` parameter**, which shares the name and does a different
> job: it expands outward from whatever a *semantic query* matched, while this endpoint starts from an
> **entity id you already hold**. Use this one when you have the node; use
> [`recall` with `traverse`](04a-recall-api.md#graph-augmented-recall-traverse-parameter) when you can only describe it.

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
| `includeChrono` | — | `true` | Also reach chrono entries whose `entityIds` reference a traversed node. Set `false` for entity-only results. A non-boolean is a `400`, never coerced |
| `includeMemories` | — | `false` | Also reach memories whose `entityIds` reference a traversed node, marked `kind: "memory"`. **Opt-in, unlike `includeChrono`** — see the note below. A non-boolean is a `400` |
| `includeFiles` | — | `false` | Also reach files whose `entityIds` reference a traversed node, marked `kind: "file"` and carrying **file meta only**. Opt-in. A non-boolean is a `400` |
| `includeEdges` | — | `true` | Whether the response carries the `edges` list. **This does not change the walk** — edges are how the graph is traversed. A non-boolean is a `400` |

**`truncated: true` has three causes, and one of them is new in 3.7.** The node cap filled; a link scan spent
its budget; or **a hop's EDGE read spent its budget**. The third used to be impossible to report because the
read was unbounded — one hub entity pulled its entire edge set into memory per hop, and the node cap could not
prevent it, because that cap counts nodes EMITTED and a neighbour already visited or of a non-entity kind is
skipped without spending any of it.

So a walk through a hub now answers `truncated: true` where it previously answered a complete-looking result it
had paid a very large read for. Treat the flag as *"there was more graph than this answer contains"* rather
than as *"the node cap filled"* — the two were the same thing until this release and are not any more.

**`direction` narrows stored edges and never links.** A link is a **record** with a `from` and a `to` since 4.0 — but which way it runs is fixed by the
KINDS at its ends rather than by the data. A memory names entities and an entity names nothing, so asking for
a memory's outbound links and its inbound links is not a choice between two answers; for an entity one of the
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

- `nodes` — records discovered during traversal, excluding the start entity itself; each node includes a `depth` field indicating the hop count from `startId`
- `edges` — only the edges actually traversed (not all edges of the returned nodes)
- `truncated: true` if `limit` was reached before exhausting the graph

Server-side cycle detection ensures each record is visited at most once, so cyclic graphs are handled safely.

#### Chrono entries are nodes

`chrono.entityIds` is the link between a timeline and the graph, and traversal follows it — a chrono entry
that references a traversed node is returned as though joined by an **inbound** edge, which is what that
field is. No schema change was needed; the link already existed and simply had no reader here.

- **A chrono node carries `kind: "chrono"`. An entity node carries no `kind` at all**, so every response you
  were already parsing is unchanged. Read `kind` before following an `_id`: the two live in different
  collections, and `type` cannot tell you which (a chrono's is `event`/`deadline`/…, an entity's is whatever
  the space calls it).
- **The synthetic edge is labelled `chrono.entityIds`** and carries its own id, shaped
  `<label>:<from>:<to>` — deliberately not a UUID, because there is no stored edge behind it and an id that
  looked like a real one would invite a lookup that cannot succeed. **Do not fetch a synthetic edge by id:**
  `GET /edges/:id` reads the edge collection only, so any id here answers `404`. Follow the NODE instead.
  Because the label is real, `edgeLabels` filters it like any other: an explicit filter that does not name it
  **excludes** chrono entries.

  > *Changed:* this id used to be the chrono's own `_id`, on the stated rationale that looking it up would
  > resolve to the chrono. It never did — the edge lookup is collection-scoped — and sharing an id between a
  > node and an edge made graph libraries drop the edge, since they keep one id namespace for both.
- **A chrono is a leaf.** Traversal does not expand outward from one — a chrono links to entities, not to
  other chrono entries, so expanding would only walk back to entities already visited.
- Set `includeChrono: false` for the previous entity-only behaviour.

#### Memories are nodes too, on request

`memory.entityIds` is the same kind of link, and `includeMemories: true` follows it. A memory node carries
`kind: "memory"`, its `name` is the memory's `fact`, and its `type` may be an empty string — a memory's type is
optional, unlike a chrono's. The synthetic label is `memory.entityIds`, and like the chrono label it is filtered
by an explicit `edgeLabels`. A memory is a leaf, for the same reason a chrono is.

**Why this one is opt-in when `includeChrono` is not.** Chrono entries are sparse — an incident has ten, not ten
thousand — and were invisible without traversal. Memories are usually the most numerous record type in a space,
and every node returned counts against `limit`. On by default, a memory-heavy space would fill the answer with
memories and truncate away the entities you traversed for. Turn it on deliberately, and raise `limit` with it.

#### Files are nodes too, and only their meta comes back

`includeFiles: true` follows `file.entityIds`, so a document about an entity is reachable from it. The node is
the **file**, not its passages: `_id` and `name` are the path, and `description` and `tags` ride along when set.

**No passage text, ever.** A file's body is its chunks — the largest thing this product stores, and what
`recall` returns when you search for content. A structural walk must not pay for them, so a file node carries
none: no `content`, no `matchedText`, no `chunkIndex`. Once you know which document you want, read it with the
file API.

This also means **one node per file, not one per chunk**. Chunks live in the same collection as the file they
belong to and are distinguished only by `parentFileId`; the traversal excludes them explicitly. A forty-passage
document is one node.

Opt-in for the same reason as memories, and the synthetic label is `file.entityIds`.

#### Suppressing the edge list

`includeEdges: false` returns the same `nodes` with `edges: []`. It is a **response** switch, not a traversal
one: the walk still follows every edge it would otherwise, so the node set is byte-for-byte what you would get
with the list included. Use it when you want what is reachable and the connecting relationships would only cost
tokens — a large traversal spends much of its payload on edges.

If you need fewer edges *followed*, that is `edgeLabels`, which genuinely narrows the walk.

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
      "linkedFrom": { "memories": 412, "chrono": 0, "files": 89 }
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
