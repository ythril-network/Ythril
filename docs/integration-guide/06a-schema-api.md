# Space Schemas & Validation

> Part of the [Ythril Integration Guide](../integration-guide.md).

## Space Schemas & Validation

> **On a space in a network, every schema write is a vote** (Q-52). `PUT /schema`, the single-type upsert and
> delete below, and the schema library's apply open a `meta_change` round exactly as `PATCH /api/spaces/:id` does
> and answer `202 { "status": "vote_pending", "rounds": [...] }`; nothing is written until the round passes. Where
> this instance's own yes already carries it (a club organiser, a publisher, a network with no other member) the
> answer is `200 { "space": … }`. A space in no network is written at once, as before.

### Get Single Type Definition

```http
GET /api/spaces/:id/meta/typeSchemas/:knowledgeType/:typeName
Authorization: Bearer <token>
```

Returns a single type definition from the space's `typeSchemas`. `:knowledgeType` must be one of `entity`, `fact`, `edge`, `chrono`.

**Response** `200`:

```json
{
  "knowledgeType": "entity",
  "typeName": "service",
  "schema": {
    "namingPattern": "^[a-z][a-z0-9-]{1,60}$",
    "propertySchemas": {
      "status": { "type": "string", "enum": ["active", "deprecated"], "required": true }
    }
  }
}
```

Returns `404` when the space or the requested type name does not exist. Returns `400` for an invalid `:knowledgeType`.

---

### Replace Full Schema (Bulk Overwrite)

```http
PUT /api/spaces/:id/schema
Content-Type: application/json
Authorization: Bearer <token with schema:admin on the space>
```

**This is the `schema` area's `admin` rung, and it is the only route that carries it.** One call rewrites the
whole type map, and `typeSchemasMode: "replace"` is how a type is DELETED — so it is the area's irreversible
operation. Editing a single type is `schema` `write`, on the two granular routes below. An instance
administrator and a space administrator both still pass, because both hold `admin` on `schema`.

Full-replace semantics for the entire `meta.typeSchemas` map. Use this when you want to overwrite all type definitions across all knowledge types in a single call (for example, restoring an exported schema). For incremental updates, prefer `PUT /api/spaces/:id/meta/typeSchemas/:knowledgeType/:typeName` (single type) or `PATCH /api/spaces/:id` (deep-merge).

Before the new schema is written, the previous `typeSchemas` is automatically backed up to `_schema-backup-<ISO-timestamp>.json` inside the space's file store, so a bad replacement can be recovered or re-imported. Backup write failures are logged but never block the replacement.

`$ref` values inside any property schema are validated against the instance's schema library — unknown refs return `422` with the list of missing entries.

**On a space in a network, a replace removes nothing, and the answer says so.** A networked space's schema is
the network's: the edit opens a `meta_change` round (`202`, or `200` where this instance's own yes passes it), and
a passed round is applied as a **merge** on every member and here — deleting a type across a network could break a
member's customisation, its reuse of the type, or another network the space is in. So a type the replacement
leaves out is kept, and the answer (`PUT /:id/schema`, `DELETE /:id/meta/typeSchemas/:kt/:type`, `PATCH /:id` with
`typeSchemasMode: "replace"`, the schema library's apply, and MCP `schema_update`) carries
`"appliedAsMerge": true`, `"keptTypes": ["entity:Profile"]` and a `mergeNote` sentence. Members are sent a change
note saying which types were kept, and each can retire a type locally.

**Request body**:

```json
{
  "typeSchemas": {
    "entity": {
      "service": { "namingPattern": "^[a-z][a-z0-9-]{1,60}$" },
      "person":  {}
    },
    "fact": { "decision": {} },
    "edge":   { "depends_on": {} },
    "chrono": { "release": {} }
  }
}
```

**Response** `200` — the updated space document.

**Errors:**

- `400` — body fails `TypeSchemas` validation, answered as `{ "error", "issues": [{ "code", "path" }] }`
  ([Error Format](03-auth-and-limits.md#error-format)). A rule this instance could not apply is refused here too, with
  the rule's name in the issue path ([Rules](#rules)).
- `404` — space not found.
- `422` — one or more `$ref` values point at non-existent schema-library entries.

---

### Upsert Single Type Definition

```http
PUT /api/spaces/:id/meta/typeSchemas/:knowledgeType/:typeName
Content-Type: application/json
Authorization: Bearer <token with schema:write on the space>
```

Adds or updates a single type definition in the space's `typeSchemas`. All other type definitions (including those of other knowledge types) are left unchanged. The request body is a `TypeSchema` object.

**Request body**:

```json
{
  "namingPattern": "^[a-z][a-z0-9-]{1,60}$",
  "propertySchemas": {
    "status": { "type": "string", "enum": ["active", "deprecated"], "required": true }
  }
}
```

An empty object `{}` is valid and registers the type name as allowed (no extra constraints).

**A type whose `rules` differ from the stored ones needs `schema` `admin`, not `write`.** A rule can start refusing
writes exactly as `validationMode` can, so it is priced at the same rung on every route that carries one. Sending the
type back with the rules it already has is not an edit of them, so a `schema` writer may still change the rest of a
type that carries rules. The refusal is the `403` `PATCH /api/spaces/:id` answers
(`Not allowed to change meta.typeSchemas.<kind>.<type>.rules (admin on schema)`), and a read-only token is refused
before it.

**Response** `200`:

```json
{
  "knowledgeType": "entity",
  "typeName": "service",
  "schema": { "..." : "..." }
}
```

**Constraints:**

- `:knowledgeType` must be one of `entity`, `fact`, `edge`, `chrono`.
- The body is validated by the same `TypeSchema` rules as the full `PATCH /api/spaces/:id` endpoint (property schema `mergeFn`/`type` compatibility, field max lengths, rules, etc.), and refused as `{ "error", "issues" }`.
- **A write to a space in a network is merged and priced against the space's own definitions**, never against the effective schema a network layer is laid under, so saving one type never turns a network's definition of it into yours.
- At most 200 type definitions per knowledge type. Adding a 201st type returns `400`.
- The meta version counter is incremented and the previous version is pushed to history (same as full PATCH).

---

### Delete Single Type Definition

```http
DELETE /api/spaces/:id/meta/typeSchemas/:knowledgeType/:typeName
Authorization: Bearer <token with schema:write on the space>
```

Removes a single type definition from the space's `typeSchemas`. All other types are left unchanged.

**Response** `204` (no body) on success.

Returns `404` when the space or type name does not exist. Returns `400` for an invalid `:knowledgeType`.

---

### Network Schema Layers

```http
GET /api/spaces/:id/schema-layers
PUT /api/spaces/:id/network-precedence
```

A space in networks that send schema (pub/sub and braintree) keeps each network's schema as its own **layer**
beside this instance's own definitions, and enforces own ⊕ layers in **precedence**: the network first in the list
wins where two define the same type, property or field differently (F-39.2). The GET answers:

```json
{
  "spaceId": "research",
  "own": { "typeSchemas": { } },
  "layers": [{ "networkId": "…", "networkLabel": "Publisher A", "meta": { }, "unknownFields": ["…"], "refusedRounds": [{ "roundId": "…", "reason": "…" }] }],
  "precedence": ["…", "…"],
  "clashes": [{ "kind": "entity", "type": "person", "property": "tier",
                "values": [{ "networkId": "…", "value": { "type": "number" } }, { "networkId": "…", "value": { "type": "string" } }] }],
  "fields": [{ "kind": "entity", "type": "person", "property": "tier",
               "own": { "type": "string" }, "effective": { "type": "number" }, "winner": "…", "hidden": true }]
}
```

In each clash the network listed first is the one that applies. A clash never stops either network's records.

**`own` is this instance's own definitions, and the space runs on something else when a layer outranks them.**
`GET /api/spaces`, `GET /api/spaces/:id/meta` and `space_meta` answer the effective schema (own definitions with every layer laid under them in
precedence); `own` here is what this instance itself defined. **`fields` is the answer to "did my edit take
effect?"** It lists every place a layer supplies — a top-level field such as `purpose`, one of a type's own fields,
or one property of a type — with `own` (absent when this instance holds nothing there), `effective` (what the space
runs on), `winner` (the network whose layer supplies it) and `hidden: true` when `own` is set and differs from
`effective`: an edit that was stored and that a network's layer outranks. It is read fresh from the own definitions
and the layers on every call and recorded nowhere, so reordering the networks, a layer arriving, a rename or leaving a
network changes it with no vote. A place no layer supplies is the own definitions' and is not listed.

**`unknownFields` and `refusedRounds` say what this instance could not read.** A layer is read tolerantly: the meta keys
and type fields this release knows are kept, and the names of the ones it has never heard of (a newer peer's) are
listed per layer, bounded in count and in the length of a name, instead of the layer being refused. A value that
is wrong for a key this release does know still refuses the whole layer. `refusedRounds` lists the passed or open
`meta_change` rounds this instance could not read: it cast no yes on them and applied none of them, and `reason`
says which type failed and why.

The PUT sets the order, highest first — `{ "networks": ["…", "…"] }` — rebuilds the space's schema and answers as
the GET does. Networks left out keep the order they were joined in, after the ones named; an id that is not a
network carrying the space is `400`, naming it. Rights: `schema: read` to see, `schema: admin` to reorder. MCP:
`space_schema_layers` and `space_set_network_precedence`, same parameters and answers. Audited as
`space.precedence.update`.

#### Settling a clash: propose a definition to one network

```http
PATCH /api/spaces/:id
```

```json
{ "targetNetwork": "…", "meta": { "typeSchemas": { "entity": { "person": { "propertySchemas": { "tier": { "type": "number" } } } } } } }
```

`targetNetwork` proposes `meta` to ONE network carrying the space as **that network's** definition, instead of
editing this instance's own (F-39.5). It merges over the network's layer — a named type is replaced whole, so send
the network's full definition of the type with your change in it — opens a `meta_change` round on that network
alone, and once passed lands in its layer on every member, the proposer included. Your own definitions are not
touched. The answer is the ordinary one: `202 vote_pending` naming the round, or `200` where this instance's own
yes carries it (a club organiser, a publisher).

Refused with `400`: a network that does not carry the space, a body without `meta`, and a body with anything but
`meta` and `typeSchemasMode` — a label, a quota or a TTL is this instance's, not the network's to vote on. Rights:
`networks: write` for `targetNetwork`, beside what each `meta` field needs. MCP: `targetNetwork` on
`schema_update`, same parameter and refusals.

#### What a schema write answers on a space in more than one network

A write that reaches **more than one** network opens a round in each, and the answer carries
`"layers": [{ "networkId", "networkLabel", "outcome": "applied" | "vote_pending" }]` beside its own outcome, on `PATCH`,
the two `PUT` routes, `DELETE` of a type, `schema_update` and `update_space` alike: for each network, whether its round
passed on this instance's own vote or is still open. A space in one network, or none, is answered as before. **What
happens after that is not in the answer** — a round that fails, or a layer that outranks the edit once it lands — and
is read on `GET /api/spaces/:id/schema-layers` (`fields`, `refusedRounds`).

**A round carries only what the write changed.** The types and fields the write touched are proposed, diffed against
the meta it read, never the whole effective schema: one network's types do not leak into another network's layer or
into this instance's own definitions. A member applies a round **whole or not at all**: one that cannot read a part of
it applies none of it and casts no yes on it (`refusedRounds`). The overwrite warning on a concluded round compares a
field against the value it held when the round was proposed, so a first conclusion no longer warns of an overwrite
nobody made.

**A write that sets a key an earlier release refuses answers success plus a `warnings` row.** Members on the release
before this one refuse a layer carrying `stampSkew` or `rules` whole, once per cycle, and a writer on this release is
not told by the sync. So the write itself says it:

```json
{ "code": "members_may_refuse_new_keys", "keys": ["rules"], "since": "5.7.0", "memberCount": 2,
  "members": ["Publisher A"], "message": "…" }
```

`members` names the members whose recorded version is older than `since` or unknown, and only for a caller who holds
`networks: read` on the networks that carry the space; any other caller gets `keys`, `memberCount` and no names. The
write is applied regardless. Upgrade every instance of the network ([Upgrading](02b-upgrading.md)).

### Validate Schema (Dry Run)

```http
POST /api/spaces/:id/validate-schema
Content-Type: application/json
Authorization: Bearer <token with schema:read on the space>
```

Scans existing data against the current (or proposed) schema definition without writing anything. Pass a `meta` body to test a schema change before applying it, or omit to validate against the current schema.

**It needs `schema` `read`, the same rung `GET /:id/meta` needs** — it is a dry run, so there is nothing to
authorise beyond seeing the space's shape. Until 4.4 it demanded a space administrator (`admin` on all four
areas) despite advertising `read`, which meant a token granted exactly what the rights panel asked for was
refused with `Admin token required`. The same correction reached the four routes above it in 4.4: each is now
guarded at the rung it advertises rather than at "administers the whole space".

**Request body** (optional) — the same parameters on MCP `schema_validate`:

| Parameter | Meaning |
|---|---|
| `meta` | The schema to check, in the shape `GET /:id/meta` returns it. Parsed exactly as a schema save parses it, so a rule or type the save would refuse is refused here in the same words (`400`). Omit it to check the space's stored schema |
| `sample` | `{ "kind": "entity" \| "edge" \| "fact" \| "chrono", "record": { … } }` — check **one record you supply** instead of the stored ones, in the STORED shape (`name` for an entity, `fact` for a fact, `title` for a chrono entry, `label` for an edge, with `type`, `description`, `tags`, `properties`; a field left out is empty). Nothing stored is read, it costs one evaluation, and it is not rate limited — **and, in either mode, a check runs only rules you could save**: a call with a `meta` whose rules (`rules`, or any type's `rules`) differ from the stored ones needs `admin` on `schema`, the right to save them, and is otherwise refused `403` (see *What it costs*) |
| `limit` | Violating records per page, 1 to 500 (default 500) |
| `after` | The `nextAfter` of the previous page. Opaque; one this check did not give is a `400` |
| `maxChars`, `maxBytes`, `maxTokens` | The size ceilings every budgeted read takes, on a stored-data check: the page is cut to **whole violating records** that fit, and `nextAfter` continues it. **Default `maxChars`: 50 000 on REST, 25 000 on MCP** — the one default the two doors deliberately differ on — and the answer discloses the number it used (`budgetChars`, `budgetBytes`). A value that is not a positive integer is a `400` |

A key the check does not take is dropped, never followed: a `projection` or `fields` in the body changes nothing about
what is read. **A body that fails validation is refused `400` with the whole refusal, `{ "error", "issues" }`** — the
one body every parse door answers ([Error Format](03-auth-and-limits.md#error-format)) — and MCP `schema_validate` answers
the same sentence with the same `issues` as the result's `structuredContent`.

```json
{
  "meta": {
    "validationMode": "strict",
    "typeSchemas": {
      "entity": { "service": {}, "person": {} }
    }
  }
}
```

A one-record check, trying a rule before saving it:

```json
{
  "meta": { "typeSchemas": { "entity": { "person": {
    "propertySchemas": { "age": { "type": "number" } },
    "rules": { "adult": { "rule": "self.properties.age >= 18", "message": "A person must be an adult" } }
  } } } },
  "sample": { "kind": "entity", "record": { "name": "Ada", "type": "person", "properties": { "age": 12 } } }
}
```

answers one record with `{ "field": "rules.adult", "reason": "A person must be an adult (rule 3f9a1c02)" }`.

**Response** `200`:

```json
{
  "spaceId": "eng-kb",
  "meta": { "validationMode": "strict", "typeSchemas": { "entity": { "service": {}, "person": {} } }, "..." : "..." },
  "checked": { "entities": { "checked": 200, "total": 14200 }, "edges": { "checked": 0, "total": 830 }, "...": "..." },
  "complete": false,
  "truncated": false,
  "budgetChars": 50000,
  "budgetBytes": null,
  "charsReturned": 184,
  "bytesReturned": 184,
  "violations": [
    {
      "collection": "entities",
      "_id": "550e8400-e29b-41d4-a716-446655440000",
      "violations": [
        { "field": "type", "value": "concept", "reason": "not in entityTypes allowlist: Person, Service" }
      ]
    }
  ],
  "staleGuards": [ { "_id": "7c9e6679-7425-40de-944b-e07fc1f90ae7", "label": "reports_to" } ],
  "nextAfter": "WyJlbmcta2IiLCJlbnRpdGllcyIsIjU1MGU4NDAwLi4uIl0",
  "progress": { "checked": 200, "total": 15030 }
}
```

**It says how much it checked, and pages by cursor** (`Q-129`). One call reads at most 10,000 records, walking each
member space's four collections in turn by `_id`, **and stops reading at the record that fills the page**: `limit`
violating records (or `limit` stale guards, or the byte budget — below), the 10,000-record bound, or the end. It does not
read on to count violations it will not show, and the next call continues right after the last record this one read, so no
record is read twice. `checked` reports, per collection, how many records this call read against how many the collection
holds; `progress` (stored data only) is `{ "checked", "total" }`: **`checked` is the number of records THIS call read — add
it up over your pages, and it reaches `total` when the walk ends** — and `total` is the space's record count when the check
started, taken from the collections' metadata, so a space that grows while you page can read above 100%.
`complete` is `true` only when the walk reached its end, and then `nextAfter` is absent. **While records are left the answer
carries `nextAfter`: send it back as `after` for the next page.** A page that filled its `limit` exactly on the last
violating record still carries `nextAfter`, and the next page is empty and `complete`. A clean answer with `complete: false` is a
clean answer for the records read so far — not for the space. This is the server's one `after` / `nextAfter` keyset
spelling; the `skip`, `count`, `total`, `nextSkip` and `totalViolations` fields this answer carried before 5.7.0 are gone,
and `limit` and `after` are taken in the body only.

**It is held to a byte budget**, as every read is (`maxChars`, `maxBytes`, `maxTokens` above): rows are cut to whole
violating records, the answer discloses `budgetChars`, `budgetBytes`, `charsReturned`, `bytesReturned`, and `truncated` is
`true` when the budget — not `limit` — ended the page (`budgetBoundBy` names the parameter to raise). The page always holds
its first violating record, however large. The cut continues by `nextAfter`, and `progress.checked` stops at the record before
the one that did not fit.

**What it shows whom.** The stored value of the property that broke the schema is shown only to a caller who may read
the space's knowledge (`knowledge` `read`, or an instance administrator): any other caller gets each row with its
`field` and `reason` and **no `value`**. A rule's row never carries a value for anybody — its reason is the rule's
message. The records are read through a fixed projection, never one a caller names, and no vector is read. A
`sample` check shows the values of the record you sent, whoever you are: they are yours.

**What it costs.** A stored-data check is counted with the other heavy calls — five runs a minute per token, shared
between this route and `schema_validate` (`429` beyond it) — and runs once per space at a time (`409` while another
is running). It yields to the event loop between pages, so it cannot stall the server. A `sample` check is neither
counted nor serialised — and **both modes run only rules you could save**. A rule is evaluated on the event loop, and the
heaviest rule set a save accepts takes about half a second on one record; a sample is off the rail and the stored-data walk runs the
rules over up to ten thousand records, so at `schema` `read` either would let a read-only token block the server for most of every
minute. So a call (a `sample` or the stored-data check) whose proposed `meta` changes a rule — a new or changed `meta.rules`
entry, a new or changed rule on any type, or one left out — is `403` unless the caller holds what saving that rule takes (`admin`
on `schema`, as `PATCH /api/spaces/:id` asks of `meta.rules` and of a type's `rules`). The refusal comes before the rail is charged, so it costs no slot. The answer is one sentence naming each rule
field and what it needs, the same on REST (`{ "error" }`) and on MCP (the tool's refusal, `Error: …`), for example
`… could not: meta.rules (admin on schema), meta.typeSchemas.entity.person.rules (admin on schema). Check with the stored rules, or ask for the right to change them.`
What stays open to a `schema` `read` token, in both modes, is **the stored rules** (omit `meta`) and **a proposed `meta` whose rules equal the stored
ones** — rules are compared as content, in any key order, and the effective meta and this instance's own definitions both count as
stored — whatever else in it differs, because the Schema tab always sends the whole staged meta. A `meta` the save would refuse is
still `400` first, in the save's words.
Rights: `schema` `read` on both doors, and `admin` on `schema` for a check of rules you changed; audited as `space.schema.validate` when the instance logs reads.

**`staleGuards` lists the stored edges that hold a write guard for a subject they are not under**, as
`[{ _id, label }]` (`[]` when there are none). The write guard is the instance's own lock on a functional label's
subject: it is never returned by a read, sent to a peer or exported, and it is not part of the schema. An edge holding
one for another subject does not break any rule, so it is **never a violation** — it is not in `violations`, which means
what it always did. The list is that of the edges **among the records this call read**, at most `limit`, held to the byte
budget with the violations; a page that holds `limit` guards ends there, so a guard is named once across the pages. The
first write that meets such a guard clears it and goes on to land, so the list is how to see them before a write does.

---

### Schema Validation

Each space can define a schema in its `meta` block that governs what data is accepted. The `validationMode` controls enforcement:

| Mode | Behaviour |
|------|-----------|
| `off` | No validation. All writes accepted: an undeclared property key is not judged and no [rule](#rules) is evaluated. This is what an **absent** `validationMode` resolves to. |
| `warn` | Violations are returned as `warnings` in the response but writes proceed. A key the type does not declare and a rule a record breaks are violations like any other. |
| `strict` | Violations the write introduces refuse it with the body below — `400` on a REST create, `422` on a REST update. |

> **A space you create is `strict`, not `off`.** New spaces are seeded with `validationMode: "strict"`
> and `strictLinkage: true`. Only a space whose meta never had the field — one created before those
> defaults, or through a path that does not seed meta — falls back to `off`. With no `typeSchemas`
> defined yet, `strict` still accepts every type and label, so it never blocks a brand-new empty space;
> it starts mattering the moment you define a schema.

**Every write validates the record as it will be.** A `PATCH` (and the matching `update_*` MCP tool)
validates the **merged** result — the stored record with your patch applied — not the patch on its own.
Validating the fragment would fail every partial update that does not restate every required property, so
the answer would be meaningless. In `strict` mode a violating update is refused with `422` (the same body on a create is a `400`):

```json
{
  "error": "schema_violation",
  "message": "The change violates this space's schema: status.",
  "introduced": [ { "field": "properties.status", "value": "nonsense", "reason": "not in enum: open, closed" } ],
  "preExisting": [],
  "violations": [ { "field": "properties.status", "value": "nonsense", "reason": "not in enum: open, closed" } ]
}
```

**This is the one refusal body, on every door.** The REST create and update routes, the MCP write tools (as
`structuredContent`, with `isError`), the `POST /api/<tool>` twin and a refused [merge](04b-graph-api.md#merge-two-entities)
answer it, and a refused bulk item carries it as `violation` beside its published `reason` string
([Bulk Write](04d-brain-ops-api.md#bulk-write)). `violations` is the union of the two lists. **Every list is cut to 20
rows after the classification** — never before it, so a new key sorted behind twenty stored ones cannot be the row that
is left out — and `truncated` is **how many rows were left out** of `introduced` and `preExisting` together; it is
absent when none were. (It was `true` before 5.7.0.) A row quotes what the caller sent through one bounded renderer: a
property name is cut at 256 characters and a string `value` is bounded and escaped, so a megabyte key is a sentence,
not a megabyte. A number, a boolean, `null` or a list in `value` is returned as it was sent.

**An inline `edges` entry is judged by the same rules and refused in the same shape**, with the record's own status for
that verb, `field` naming the entry (`edges[0].to`), and nothing stored — the record included. A record that does not
exist is `404` before it, and it comes before an `If-Match` `412`. A write that fails after the record was stored is not
a refusal and says so: [A refused connection writes nothing](04-brain-api.md#a-refused-connection-writes-nothing).

`introduced` and `preExisting` are the same violations, split by **whose fault they are**:

| Field | Meaning |
|-------|---------|
| `introduced` | Not present before this write, **or** present before and about something this write changed. Your change caused it. |
| `preExisting` | Present before, still present, and about something the write left alone. Your change neither caused nor fixed it. |

**A stored break does not shelter a new one.** A record whose `status` is already wrong, written again with a
*different* wrong `status`, has introduced a violation; sent back unchanged (a round-tripping editor) or left alone, it
has not. For a [rule](#rules) the paths asked about are the ones the rule reads — the fields it names, the properties
whose value it reads, the properties it only tests for, and the whole record when it reads `self` whole. This holds on
every door that classifies: REST, MCP, bulk, inline `edges`, merge and arriving records. The one exception is the
[undeclared-key row](#property-keys-a-type-does-not-declare), which is about a key's *presence*.

A record can be non-compliant before you touch it — written before the schema tightened, imported, or
synced from a peer with different meta.

**Only `introduced` blocks.** A violation the record already had is reported and does not refuse your patch.
It is already stored, so refusing would not improve the data; it would only stop the record being maintained.
Until 3.1 both kinds blocked, and the consequence was that tightening a schema retroactively froze every
record that no longer fitted — an operator could not correct a typo in a description without also resolving a
field their edit never touched.

Validation is still of the merged result, so including the offending field in a write repairs it. The
`message` says which of the two situations applies, so you are not sent after a field you did not touch, and
`preExisting` is in every response — a client that wants to insist on full compliance can refuse on it itself.

In `warn` mode the write proceeds and the violations are returned as `warnings` on the success answer — the same
rows, at most 20 of them, with `warningsTruncated: true` when rows were left out. REST routes and MCP tools answer
them alike (`structuredContent.warnings`, see [MCP](16-mcp.md#schema-warnings-and-refusals-on-the-write-tools)).

**An upsert onto an existing record is an update, and is validated the same way.** `POST .../entities`
with an `id` that already exists merges into the stored record, so it is the merged form that is checked —
you can set one property without restating the rest. For edges the identity is `(from, to, label)` with no
id involved at all, so **every** repeat `POST .../edges` merges. An upsert that lands on nothing is an
insert, and there the payload *is* the record: required properties must be present.

*New in 2.2.* Previously an update was validated only when the request used `deleteFields`; every other
patch could write a value the same space rejects at create time. *New in 2.3.* An upsert was validated
against the incoming payload rather than the merged record, so a partial upsert onto a complete record was
refused for properties that record already had.

**Schema structure — `typeSchemas`:**

The schema is expressed as a single `typeSchemas` object on the space `meta`. It groups configuration by knowledge type (`entity`, `edge`, `fact`, `chrono`) and then by type name (e.g. `"service"`, `"depends_on"`). Each entry is a `TypeSchema` object:

```typescript
interface TypeSchema {
  $ref?: string;                                  // "library:<name>" — use a schema-library entry instead
                                                  //   of the inline fields. When set, inline fields on the
                                                  //   same object are IGNORED, not merged.
  description?: string;                           // what this TYPE is for, in your own words. Free
                                                  //   text, never parsed, max 4000. An assistant reads
                                                  //   it; nothing validates against it. See 06-spaces-api.md.
  namingPattern?: string;                         // entity only — regex for name validation
  retention?: { days?: number; contentDays?: number };  // per-type retention, the middle tier of
                                                  //   record > schema > space. `contentDays` is chrono-only
                                                  //   and is rejected elsewhere. See 04-brain-api.md.
  propertySchemas?: Record<string, PropertySchema>;
  suppressEmbeddings?: boolean;                   // skip embedding this type. Absent = NOT STATED, falls
                                                  //   through to the space setting — it does not mean false.
                                                  //   Does NOT backfill when switched off (see below).
  whenDuePasses?: 'overdue' | 'nothing';          // CHRONO only, rejected elsewhere. What a passed due
                                                  //   moment MEANS for this type. Absent = today's
                                                  //   behaviour (`overdue`). `nothing` returns the STORED
                                                  //   status, for records of events that happened rather
                                                  //   than deadlines. schema > space. See 04c-chrono-api.md.
  endpoints?: { from?: string[]; to?: string[] };  // EDGE only — what kind of entity may sit at each end.
                                                  //   Each side independently optional; absent = any. Members
                                                  //   are entity type names, plus `UNTYPED`. Two arrays mean
                                                  //   the CROSS PRODUCT. See below.
  functional?: boolean;                           // EDGE only — at most one edge with this label per subject,
                                                  //   i.e. one edge per `(from, label)`, whatever its `to`. Absent = many.
  rules?: Record<string, { rule: string; message: string }>;  // the type's own CEL rules, by name; part of the
                                                  //   type, so replaced with it. Checked when saved.
}
interface PropertySchema {
  description?: string;  // what this property MEANS, in your own words. Free text, never parsed, max 2000
  type?: 'string' | 'number' | 'boolean' | 'date';
  enum?: (string | number | boolean)[];
  minimum?: number;
  maximum?: number;
  pattern?: string;    // regex, ReDoS-protected
  mergeFn?: 'avg' | 'min' | 'max' | 'sum' | 'and' | 'or' | 'xor';  // entity merge hint
  required?: boolean;  // if true, property must be present on every write
  default?: string | number | boolean;  // value inserted when property is absent
}
```

**`typeSchemas` example:**

```json
{
  "typeSchemas": {
    "entity": {
      "service": {
        "namingPattern": "^[a-z][a-z0-9-]{1,60}$",
        "propertySchemas": {
          "status": { "type": "string", "enum": ["active", "deprecated"], "required": true },
          "score":  { "type": "number", "minimum": 0, "maximum": 100, "mergeFn": "avg" }
        }
      },
      "team": {}
    },
    "edge": {
      "depends_on": {},
      "owns": {}
    },
    "fact": {
      "default": {
        "propertySchemas": {
          "confidence": { "type": "number", "minimum": 0, "maximum": 1, "default": 1 }
        }
      }
    },
    "chrono": {
      "milestone": {
      }
    }
  }
}
```

What the schema enforces:

- **Entity type allowlist** — the keys of `typeSchemas.entity` (e.g. `"service"`, `"team"`) define the allowed entity `type` values (max 200 per knowledge type).
- **Edge label allowlist** — the keys of `typeSchemas.edge` define the allowed edge `label` values.
- **Chrono type allowlist** — the keys of `typeSchemas.chrono` define the allowed `type` values.
- **Fact type allowlist** — the keys of `typeSchemas.fact` define the allowed `type` values.
- **Naming patterns** (`namingPattern`) — per entity type, a regex for validating `name` (max 500 chars, ReDoS-protected).
- **Property value constraints** (`propertySchemas`) — per type, define `type` (string/number/boolean/date), `enum`, `minimum`/`maximum`, `pattern` (regex, ReDoS-protected), `required`, `default`, and `mergeFn`.
- **Undeclared property keys** — a type that declares at least one property is a closed list: a write that *adds* a key outside it is refused in `strict`, flagged in `warn` and ignored in `off` ([below](#property-keys-a-type-does-not-declare)).
- **Rules** (`rules`) — per type and per space, an expression a record must satisfy, with the message a breaking write is told ([below](#rules)).
- **Tag suggestions** (`tagSuggestions`) — **removed in 3.0.** Both the per-type and the space-wide list
  are gone from every surface: neither is accepted, stored or returned. They were consumed by nothing —
  record forms suggest from the tags already in use in each collection, which is self-maintaining, and
  the MCP schema guidance never read either list.

**Top-level `meta` fields:**

| Field | Description |
|-------|-------------|
| `typeSchemas` | Per-type schema definitions (see above). **The PATCH merge is exactly two levels deep, and the second one REPLACES.** A knowledge type you do not mention is preserved; a *type name* you do not mention inside one is preserved; but a type name you **do** mention has its definition object **replaced wholesale**, not merged. So `PATCH {"meta":{"typeSchemas":{"chrono":{"event":{"retention":{"days":90}}}}}}` leaves `entity` and every other chrono type untouched — and wipes `event`'s own `propertySchemas`, `namingPattern` and `tagSuggestions`. **Read the type first and send it back complete.** Deleting a type needs `PUT /:id/schema` (full replace), because under merge semantics an absent type is indistinguishable from a removed one. |
| `strictLinkage` | When `true`, every reference — an edge's `from`/`to` (the far end of an inline `edges` entry on a record write included, of whichever kind its `toKind` names), and the ids in `linkEntities`, `linkFacts` and `linkChronos` — must be a valid UUID v4 naming a record that exists, and entity deletion is blocked while inbound backlinks exist. **Default: `true`** — and an absent value also resolves to `true`. Turning it off is a deliberate per-space choice to accept dangling references (the case it exists for is bulk import, where targets are resolved in a later pass); you do not get that by saying nothing. |
| `whenDuePasses` | **Chrono only.** What a PASSED due moment means across this space, for chrono types whose own schema is silent: `overdue` (the built-in behaviour) or `nothing`, which returns the STORED status. The OUTER tier of **schema > space** — a chrono type schema that states a value overrides it, and absent here is the built-in behaviour, so an instance that sets nothing sees no change. Set `nothing` on a space whose chrono entries mostly record events that happened — a deploy, a backup run, an alert episode — where a past date is the normal condition and does not mean late, then override per type where a real deadline lives. See [the chrono API](04c-chrono-api.md). |
| `suppressEmbeddings` | When `true`, records in this space are **not embedded**, so they never appear in semantic recall. **Default: `false`** — suppression is opt-in. This is the LOWEST of three tiers, all three spelled the same: a per-record `suppressEmbeddings` wins, then a type's own `suppressEmbeddings`, then this. (The record tier was called `excludeFromVectorSearch` before 3.1.0; 4.0 removed that spelling and sending it is now refused.) A type schema that says nothing falls through to this value rather than overriding it with `false`. Intended for records that are **state rather than prose** — a row whose text never changes but whose numbers are patched constantly, which would otherwise re-embed identical text on every write. **Switching it off does not backfill on its own** — records written while it was on have no vector and nothing revisits them. Run [`POST /api/spaces/:id/reembed`](06-spaces-api.md#re-embed-backfill) afterwards to queue the missing ones. |
| `stampSkew` | The stamp-integrity check ([Write Semantics](04f-write-semantics.md#stamp-integrity--when-a-records-own-timestamp-disagrees-with-the-servers)): `{ warnMinutes?, properties? }`, **replaced whole** — a field you leave out is gone. Needs `schema` `write`; `warnMinutes: 0` switches the check off, and the audit log records that number. |
| `rules` | Space-level [rules](#rules): a map of name to `{ rule, message, kinds? }`, **replaced whole** — send the map without a rule to delete it, `{}` to clear them. Needs `schema` **`admin`**, the rung of `validationMode`. |
| `purpose` | Short description of the space (max 4000 chars). Returned by `space_meta`. |
| `usageNotes` | Extended Markdown-formatted guidance for LLM clients (max 50 000 chars — the settings form shows a live count and accepts the same limit). Returned by `space_meta`. |

### Property keys a type does not declare

A type that declares **at least one property** (`propertySchemas` with a key) is a closed list. A write that **adds** a
property key outside it is judged by the space's mode: `strict` refuses it, `warn` stores it and names it in
`warnings`, `off` stores it quietly. The row says which key and what the type does declare:

```json
{ "field": "properties.statuz", "value": "x",
  "reason": "property 'statuz' is not declared on this type", "declared": ["owner", "status"] }
```

`declared` is sorted and bounded (at most 50 names, each cut at 256 characters). The rule is the same on every door:
the record routes, `save_*` and `update_*`, the bulk items, the inline `edges` of a record write, a merge, and an
extraction. What it does **not** do:

- **A type that declares no property is open**, on both doors: absent `propertySchemas`, or `{}`, accepts any key. A
  `null` value is an absent key.
- **A key the record already stores is never refused.** Only a write that *adds* a key is. Changing a stored key's
  value, or editing any other field of a record that carries stored undeclared keys, is not the write's fault
  (the P-6 split above), so a schema that is tightened later does not freeze the records written before it.
- **A retype is judged against the type it leaves and the type it lands on.** A key the new type does not declare is
  introduced by the retype when the old type declared it, or declared nothing; a key undeclared on both is
  pre-existing. To take keys off in the same write, send them in `deleteFields` (`properties.<key>`, at most 100 a
  write); the UI's retype dialog does exactly that.
- **A merge is a write of the survivor.** A key the survivor already stores is not blamed; a key brought in from the
  absorbed record that the survivor lacks is introduced, and a `strict` space refuses the merge naming only that key.
- **A peer's or a restore's document is stored as sent** and only *recorded* ([below](#what-arrivals-record)).
- **The extractor's own keys are exempt.** The conversation extractor writes `aliases` on entities, `since` and
  `until` on edges, and `speaker`, `statedOn` and `attributed` on claims; the shipped `conversation` types declare
  them, and the extractor's writer is exempt for them even in a space that narrowed those types. The exemption is an
  argument the extractor's writer passes in-process and can never be asked for by a request.

**Rolling this out.** A strict space that holds records carrying keys their type never declared refuses an *edit that
adds another one*, never the records themselves. Before upgrading a space, `POST /validate-schema` on the upgraded
instance lists every stored record with an undeclared key (`field: "properties.<key>"`, with `declared`), and a `warn`
space shows the same rows on every write. Declare the keys you mean to keep.

### Rules

A **rule** is an expression, written in CEL (the Common Expression Language), that a record must satisfy, and the
message a record that breaks it is told. A rule lives in one of two places and each is a map of name to rule:

```json
{ "typeSchemas": { "entity": { "person": {
    "propertySchemas": { "age": { "type": "number" }, "born": { "type": "string" } },
    "rules": {
      "adult":   { "rule": "self.properties.age >= 18", "message": "A person must be an adult" },
      "name-ok": { "rule": "size(self.title) > 3",      "message": "A name needs at least four characters" }
    }
} } },
  "rules": {
    "tagged": { "rule": "size(self.tags) > 0", "message": "Tag every record", "kinds": ["entity", "fact"] }
  } }
```

- **A type's own `rules`** (`typeSchemas.<kind>.<type>.rules`) govern records of that type. They are part of the type:
  **replaced with it** by `PATCH`, the `PUT` routes and a vote round.
- **`meta.rules`** govern the space. `kinds` names the knowledge types a rule governs; **leave it out and the rule
  governs every kind whose record has the fields the rule reads** (`self.title` governs entities, facts and chrono
  entries, not edges). The map is **replaced whole**; to delete a rule, send the map without it.
- **A rule reads `self`**: `self.title` (the entity's name, the fact's text, the chrono entry's title), `self.type`,
  `self.description`, `self.tags` and `self.properties.<name>`; an **edge** has `self.label` instead and never its ends
  (`from`/`to` — an edge is checked before they exist). It must answer true or false. Dates are strings: compare
  ISO dates as text, and `timestamp()` needs a full RFC 3339 instant. `size()` counts characters (code points).
  `matches()` takes a string **literal** pattern only, so a record can never choose the regex run over it.
- **A property the rule reads that the record lacks makes the rule not apply** to that record. `has(self.properties.x)`
  is how a rule tests for presence.
- **A type's rule may read only the properties its type declares**; a space rule reads the open `properties` map.

**Limits** (each is refused when saved, naming the rule): a rule name is a lower-case letter then letters, digits,
`_` and `-`, at most 64 characters, and not a name every object answers to (`constructor`, `__proto__`, `toString`, …);
a rule is at most 1000 characters and its message at most 300; at most 50 rules on a type, 50 on the space, and 50
that **apply to one record** (its type's plus the space's for its kind); an expression has at most 200 parts and no
loop inside a loop. The rules that apply to one record are also priced together when saved and refused above a fixed
budget, the same way every time. At evaluation a rule reads strings up to 10,000 characters, lists of up to 100 and maps
of up to 200 entries; a record over those on a path the rule reads is **too large to check** for that rule.

**A rule this instance could not apply is refused when the schema is saved**, in the one refusal shape
(`{ "error", "issues": [{ "code", "path" }] }`, the `path` ending in `rules.<name>`): it does not parse, reads a field
or property that is not there, calls a function that does not exist, or could answer something other than true or
false. It is `400` on `PATCH`, the `PUT` routes and library writes, and the same
words on `schema_validate`. Saving needs `schema` **`admin`**.

**What a record that breaks a rule is told.** One row per rule, on `rules.<name>` for a type's rule and
`meta.rules.<name>` for a space's, and no `value`; a row that is not a plain violation says which in `outcome`:

| Outcome | `outcome` | `reason` |
|---|---|---|
| violated | absent | the rule's message, then `(rule <8 hex>)` — a short hash of the rule's text, so an edited rule is a new violation |
| could not be evaluated | `could_not_evaluate` | the message, then `— could not be evaluated on this record (…)` and the hash: a runtime error, or an answer that was not true or false |
| too large to check | `too_large` | the message, then `— too large to check: self.<path> is …` and the hash |

All three are violations: classified **introduced or pre-existing** as above, so one a record already had does not
refuse an unrelated edit, and a strict space refuses only the introduced ones. A record that arrives from a peer or
an import is stored and recorded. `off` evaluates no rule on any door, the dry run included.

**A stored rule that stops compiling is skipped, not enforced.** A property removed from its type, a hand-edited
`config.json`, a layer from another release: one dead rule must not refuse every write of its type. It is skipped
(the other rules still run), named by `invalidRules` on `GET /api/spaces/:id/meta` and `space_meta` (names only, such
as `typeSchemas.entity.person.rules.adult` or `meta.rules.tagged`), counted in `ythril_schema_rules_invalid`, said
once in the log, and shown as a warning in the security posture. The check that counts and logs them runs at every
start (and after the first-run setup), after the shipped library entries are seeded; `invalidRules` itself is read
fresh with every `space_meta`. `schema-library.json` has no watcher, so a hand edit of it takes a restart. **If the rule
engine itself cannot load, the opposite holds: every rule reports "could not be evaluated"** (a strict space then
refuses the writes its rules govern), the posture check fails and `ythril_schema_rule_engine_available` is `0`.

**A resent type is judged whole.** `PATCH` and `schema_update` judge every type the body carries, changed or not: a
type sent back holding a rule that no longer compiles is refused, so the stored rule is fixed in the same save. (A
vote round carries only what its proposal changed, and a member judges only that.)

Try a rule before saving it with [`sample` on `validate-schema`](#validate-schema-dry-run) or MCP `schema_validate` (a caller who could
not save the rule is refused the trial, `403`).

### What arrivals record

A document a peer sends (push or pull) or an import restores is **stored as it arrived**, never refused for the local
schema — the sender validated against its own. What it carries against the *receiving* space's schema is **recorded**,
at one site, with these properties: only a document that was *stored*; only a violation the copy it replaced did not
already carry (the write classifier's verdict, so a key already stored is not recorded again and a changed bad value
is); nothing in a space whose `validationMode` is `off`; names and counts, never a value; and a recorder that fails
never stops the write (it warns once and is counted in `ythril_schema_recorder_failures_total`).

| Where it is said | What |
|---|---|
| a single-record sync route's answer | `schemaViolations`: the document's own rows (at most 20, values kept — they answer the sender about its own document) |
| a batch sync answer | `schemaViolations` as a **count of documents recorded**, per family; a stored-and-skipped document answers none |
| a pull's sync-history row | `schemaViolations: [{ spaceId, records, top: [{ name, count }] }]` — per space, how many documents and the field names most of them carried (no id, no value); [Networks](08-networks-api.md#sync-history) and MCP `network_sync_history` |
| an import's answer | per family, the first 50 documents by id and by `field`/`reason` — never a value — with `schemaViolationsTotal`, and `schemaViolationsTruncated: true` past 50 ([Admin](12-admin-api.md)) |
| the log | one line per space and peer per window, names and counts |
| metrics | `ythril_schema_violations_recorded_total{source}` |

### An edge label can declare its ends, and whether a subject may have more than one (3.7)

Two fields on an **edge** type schema, refused on the other three collections rather than silently ignored —
they name things an entity, a fact or a chrono entry does not have.

```json
{ "typeSchemas": { "edge": {
  "reports_to": { "endpoints": { "from": ["person"], "to": ["person"] }, "functional": true },
  "belongs_to": { "endpoints": { "from": ["document", "person"], "to": ["project", "team"] } },
  "mentions":   { "endpoints": { "from": ["document"] } }
} } }
```

**Each side is independently optional, and absent means any.** `mentions` above pins the subject and leaves the
object open, which is the ordinary case: in a fourteen-label model `likes` legitimately permits seven of nine
types on `to`, and a rule that has to enumerate seven of nine is a list somebody will forget to extend.

**Two arrays mean the CROSS PRODUCT.** `belongs_to` above permits `document → team` as well as the two pairs you
probably had in mind. That is the semantics, not an omission: if you need exactly one pair, declare a label per
pair — which you can already do. There is deliberately no pairs form.

**Members are entity type names**, in the same vocabulary [`space_meta`'s `actualSchema`](04b-graph-api.md)
reports, plus the literal
`UNTYPED` for entities that have no type. Untyped entities are ordinary, so they are admissible by SAYING so
rather than by being refused in silence — and an untyped entity at an end that names a type IS a violation. A
member may also be written `entity:<type>`; a bare name means the same thing. Any other knowledge-type prefix
(`fact:`, `chrono:`, `edge:`) is refused with a message saying why: the grammar is reserved for if those
records can ever be edge endpoints, so it cannot later be read as a type name that happens to contain a colon.

**`functional: true` means one edge per `(from, label)`.** "Another edge" is a different edge, not only a different
`to`: the same `to` reached as another kind (`toKind`, or `fromKind` at the other end) is a second edge too. Not per
`(from, to)` — that is already guaranteed by edge identity — and not per `to`, which is the inverse relation and has
its own name.

**Where the rules are enforced.** A write that would break either one is **refused**, on every door that creates or
edits an edge — the two edge routes, `save_edge`, `update_edge`, per item through `/bulk`, and the inline `edges` of
an entity, fact or chrono write (refused before the record is written, so nothing is stored). The violation names
`fromType`, `toType` or `functional` as its field, and the reason says which types the label admits. In a `warn`
space it is reported in the response instead of refused, like every other schema rule. An edge that arrives from a
sync peer or an import is stored as it was written, and a merge reports instead of refusing.

**Writers that run at the same time cannot both win.** In a `strict` space an instance's own writers — the two edge
routes, `save_edge`, `update_edge`, a bulk item and an inline edge — leave a subject at most one edge under a
functional label, even when two of them check at the same moment: the one that loses is decided again against the
winner and refused with the same `functional` violation a write made afterwards gets, on either door. A writer that
keeps losing, because the subject keeps changing under it, answers `409` and writes nothing, and a relabel onto an
identity another edge already holds answers `409 edge_identity_taken`. What this does not cover: a `warn` or `off`
space stores the second edge (`warn` reports it), and an edge that arrives from a sync peer, a merge or an import is
stored and reported, never refused — so a subject can still hold two, and `validate-schema` lists them. The
guarantee is in place from a new space's set-up, and for a space that existed before the upgrade once the background
index pass has reached it; a space where it could not be built says so (the `Edge indexes` step in
[Background jobs](11-setup-api.md#background-jobs-and-the-spaces-they-walk)) and is tried again by the next index pass,
and until then a race there behaves as it did before.

**A rule you declare later does not freeze the edges you already have.** Refusal is on what a write INTRODUCES:
if a stored edge already breaks the rule, an edit that leaves the ends alone still goes through, so declaring a
schema can never make a record unmaintainable. Re-writing the same edge — the same `from`, `to`, `label` and end
kinds — is likewise not a `functional` breach: an edge is not its own duplicate.

**An endpoint that resolves to nothing is not a type violation.** With `strictLinkage: false` a dangling
reference is a deliberate documented state, and `ErModel.danglingEdges` has a row for it; a `to` that cannot be
resolved is left unchecked rather than refused, so one setting's escape hatch is not read as another setting's
breach. Endpoint types are also only resolved for **entity** ends: a fact, chrono or file end has no type in
this vocabulary.

**And the stored edges are still auditable.** [`POST /api/spaces/:id/validate-schema`](06-spaces-api.md) lists
every stored edge that breaks either rule — what the enforcement cannot reach, because it was written before the
rule existed, arrived from a peer, was merged or imported, or came in while the space was in `warn`. The same answer
carries `staleGuards`, which is a different list: [see below](#validate-schema-dry-run).

Both fields are also accepted on a **schema-library** entry, unlike `retention`. The difference is shape versus
policy: what may sit at the end of a `reports_to` is a fact about the relationship, and travels with an entry any
number of spaces reference; a delete window belongs to a type in one space.

Schema validation runs on:

- Individual writes: `POST /entities`, `POST /edges`, `POST /facts`, `POST /chrono`, and the `PATCH` of each
- Bulk writes: `POST /bulk` (per-item; strict skips violating items, warn records warnings; a refused item carries the refusal body as `violation`)
- Inline `edges` of an entity, fact or chrono write
- MCP tools: `save_fact`, `save_entity`, `save_edge`, `save_chrono`, `save_bulk`, and the `update_*` tools
- Entity merge (`POST /entities/:survivorId/merge/:absorbedId`, the duplicate review's merge, `graph_merge`)
- Extraction (`ingest`), checked before anything is written

Arriving records (sync, import) are recorded, not refused ([above](#what-arrivals-record)).

**Security:** Regex patterns in `namingPattern` and `propertySchemas.pattern` are protected against ReDoS: patterns are limited to 500 characters, test values to 10K characters, and structural analysis rejects nested quantifiers and alternation-with-quantifier patterns.

**`mergeFn` in `propertySchemas`:** Optional merge function for entity properties. Used as the default `suggestedFn` when merging entities via `POST /entities/:survivorId/merge/:absorbedId`. Valid values depend on the declared `type`:

| Type | Valid `mergeFn` values |
|------|----------------------|
| `number` | `avg`, `min`, `max`, `sum` |
| `boolean` | `and`, `or`, `xor` |
| `string` | *(not supported — merge resolution is always explicit)* |

Incompatible `mergeFn`/`type` combinations (e.g. `sum` on `boolean`) are rejected with `400` at schema save time.
