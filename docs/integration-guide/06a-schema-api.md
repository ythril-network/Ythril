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

- `400` — body fails `TypeSchemas` Zod validation.
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
- The body is validated with the same `TypeSchema` Zod rules as the full `PATCH /api/spaces/:id` endpoint (property schema `mergeFn`/`type` compatibility, field max lengths, etc.).
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
  "layers": [{ "networkId": "…", "networkLabel": "Publisher A", "meta": { } }],
  "precedence": ["…", "…"],
  "clashes": [{ "kind": "entity", "type": "person", "property": "tier",
                "values": [{ "networkId": "…", "value": { "type": "number" } }, { "networkId": "…", "value": { "type": "string" } }] }]
}
```

In each clash the network listed first is the one that applies. A clash never stops either network's records.

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

**Request body** (optional):

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

**Response** `200`:

```json
{
  "spaceId": "eng-kb",
  "meta": { "validationMode": "strict", "typeSchemas": { "entity": { "service": {}, "person": {} } }, "..." : "..." },
  "totalViolations": 3,
  "violations": [
    {
      "collection": "entities",
      "_id": "550e8400-e29b-41d4-a716-446655440000",
      "violations": [
        { "field": "type", "value": "concept", "reason": "not in entityTypes allowlist: Person, Service" }
      ]
    }
  ]
}
```

Scans up to 10,000 documents per collection per member space. Response capped at 500 violations.

---

### Schema Validation

Each space can define a schema in its `meta` block that governs what data is accepted. The `validationMode` controls enforcement:

| Mode | Behaviour |
|------|-----------|
| `off` | No validation. All writes accepted. This is what an **absent** `validationMode` resolves to. |
| `warn` | Violations are returned as `warnings` in the response but writes proceed. |
| `strict` | Violations cause a `400` with `{ "error": "schema_violation", "violations": [...] }`. |

> **A space you create is `strict`, not `off`.** New spaces are seeded with `validationMode: "strict"`
> and `strictLinkage: true`. Only a space whose meta never had the field — one created before those
> defaults, or through a path that does not seed meta — falls back to `off`. With no `typeSchemas`
> defined yet, `strict` still accepts every type and label, so it never blocks a brand-new empty space;
> it starts mattering the moment you define a schema.

**Every write validates the record as it will be.** A `PATCH` (and the matching `update_*` MCP tool)
validates the **merged** result — the stored record with your patch applied — not the patch on its own.
Validating the fragment would fail every partial update that does not restate every required property, so
the answer would be meaningless. In `strict` mode a violating update is refused with `422`:

```json
{
  "error": "schema_violation",
  "message": "The change violates this space's schema: status.",
  "violations": [ { "field": "status", "value": "nonsense", "reason": "not in enum: open, closed" } ],
  "introduced": [ { "field": "status", "…": "…" } ],
  "preExisting": []
}
```

`introduced` and `preExisting` are the same violations, split by **whose fault they are**:

| Field | Meaning |
|-------|---------|
| `introduced` | Not present before this patch. Your change caused it. |
| `preExisting` | Present before and still present. Your change neither caused nor fixed it. |

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

In `warn` mode the write proceeds and the same three lists are reported.

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
                                                  //   i.e. one `to` per `(from, label)`. Absent = many.
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
- **Tag suggestions** (`tagSuggestions`) — **removed in 3.0.** Both the per-type and the space-wide list
  are gone from every surface: neither is accepted, stored or returned. They were consumed by nothing —
  record forms suggest from the tags already in use in each collection, which is self-maintaining, and
  the MCP schema guidance never read either list.

**Top-level `meta` fields:**

| Field | Description |
|-------|-------------|
| `typeSchemas` | Per-type schema definitions (see above). **The PATCH merge is exactly two levels deep, and the second one REPLACES.** A knowledge type you do not mention is preserved; a *type name* you do not mention inside one is preserved; but a type name you **do** mention has its definition object **replaced wholesale**, not merged. So `PATCH {"meta":{"typeSchemas":{"chrono":{"event":{"retention":{"days":90}}}}}}` leaves `entity` and every other chrono type untouched — and wipes `event`'s own `propertySchemas`, `namingPattern` and `tagSuggestions`. **Read the type first and send it back complete.** Deleting a type needs `PUT /:id/schema` (full replace), because under merge semantics an absent type is indistinguishable from a removed one. |
| `strictLinkage` | When `true`, every reference — an edge's `from`/`to`, and the ids in `linkEntities`, `linkFacts` and `linkChronos` — must be a valid UUID v4 naming a record that exists, and entity deletion is blocked while inbound backlinks exist. **Default: `true`** — and an absent value also resolves to `true`. Turning it off is a deliberate per-space choice to accept dangling references (the case it exists for is bulk import, where targets are resolved in a later pass); you do not get that by saying nothing. |
| `whenDuePasses` | **Chrono only.** What a PASSED due moment means across this space, for chrono types whose own schema is silent: `overdue` (the built-in behaviour) or `nothing`, which returns the STORED status. The OUTER tier of **schema > space** — a chrono type schema that states a value overrides it, and absent here is the built-in behaviour, so an instance that sets nothing sees no change. Set `nothing` on a space whose chrono entries mostly record events that happened — a deploy, a backup run, an alert episode — where a past date is the normal condition and does not mean late, then override per type where a real deadline lives. See [the chrono API](04c-chrono-api.md). |
| `suppressEmbeddings` | When `true`, records in this space are **not embedded**, so they never appear in semantic recall. **Default: `false`** — suppression is opt-in. This is the LOWEST of three tiers, all three spelled the same: a per-record `suppressEmbeddings` wins, then a type's own `suppressEmbeddings`, then this. (The record tier was called `excludeFromVectorSearch` before 3.1.0; 4.0 removed that spelling and sending it is now refused.) A type schema that says nothing falls through to this value rather than overriding it with `false`. Intended for records that are **state rather than prose** — a row whose text never changes but whose numbers are patched constantly, which would otherwise re-embed identical text on every write. **Switching it off does not backfill on its own** — records written while it was on have no vector and nothing revisits them. Run [`POST /api/spaces/:id/reembed`](06-spaces-api.md#re-embed-backfill) afterwards to queue the missing ones. |
| `purpose` | Short description of the space (max 4000 chars). Returned by `space_meta`. |
| `usageNotes` | Extended Markdown-formatted guidance for LLM clients (max 50 000 chars — the settings form shows a live count and accepts the same limit). Returned by `space_meta`. |

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

**`functional: true` means one `to` per `(from, label)`.** Not per `(from, to)` — that is already guaranteed by
edge identity — and not per `to`, which is the inverse relation and has its own name.

**Where the rules are enforced.** A write that would break either one is **refused**, on every door — the two
edge routes, `save_edge`, `update_edge`, and per item through `/bulk`. The violation names `fromType`, `toType`
or `functional` as its field, and the reason says which types the label admits. In a `warn` space it is reported
in the response instead of refused, like every other schema rule.

**A rule you declare later does not freeze the edges you already have.** Refusal is on what a write INTRODUCES:
if a stored edge already breaks the rule, an edit that leaves the ends alone still goes through, so declaring a
schema can never make a record unmaintainable. Re-writing the same `(from, to, label)` is likewise not a
`functional` breach — an edge is not its own duplicate.

**An endpoint that resolves to nothing is not a type violation.** With `strictLinkage: false` a dangling
reference is a deliberate documented state, and `ErModel.danglingEdges` has a row for it; a `to` that cannot be
resolved is left unchecked rather than refused, so one setting's escape hatch is not read as another setting's
breach. Endpoint types are also only resolved for **entity** ends: a fact, chrono or file end has no type in
this vocabulary.

**And the stored edges are still auditable.** [`POST /api/spaces/:id/validate-schema`](06-spaces-api.md) lists
every stored edge that breaks either rule — what the enforcement cannot reach, because it was written before the
rule existed, arrived from a peer, or came in while the space was in `warn`.

Both fields are also accepted on a **schema-library** entry, unlike `retention`. The difference is shape versus
policy: what may sit at the end of a `reports_to` is a fact about the relationship, and travels with an entry any
number of spaces reference; a delete window belongs to a type in one space.

Schema validation runs on:

- Individual writes: `POST /entities`, `POST /edges`, `POST /facts`, `POST /chrono`
- Bulk writes: `POST /bulk` (per-item; strict skips violating items, warn records warnings)
- MCP tools: `save_fact`, `save_entity`, `save_edge`, `save_chrono`, `save_bulk`

**Security:** Regex patterns in `namingPattern` and `propertySchemas.pattern` are protected against ReDoS: patterns are limited to 500 characters, test values to 10K characters, and structural analysis rejects nested quantifiers and alternation-with-quantifier patterns.

**`mergeFn` in `propertySchemas`:** Optional merge function for entity properties. Used as the default `suggestedFn` when merging entities via `POST /entities/:survivorId/merge/:absorbedId`. Valid values depend on the declared `type`:

| Type | Valid `mergeFn` values |
|------|----------------------|
| `number` | `avg`, `min`, `max`, `sum` |
| `boolean` | `and`, `or`, `xor` |
| `string` | *(not supported — merge resolution is always explicit)* |

Incompatible `mergeFn`/`type` combinations (e.g. `sum` on `boolean`) are rejected with `400` at schema save time.
