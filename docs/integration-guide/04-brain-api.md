# Brain API

> Part of the [Ythril Integration Guide](../integration-guide.md).

## Brain API

Base path: `/api/brain`

> **Proxy spaces:** Read operations aggregate across all member spaces. Write operations require `?targetSpace=<member>` in the query string.

### Route prefix

Every fact endpoint lives under the `/spaces/:spaceId/` prefix — the same prefix used by all other brain resource types (entities, edges, chrono, stats). For example:

```http
POST /api/brain/spaces/general/facts
```

> **Removed in 2.0:** the two-segment shape `/api/brain/:spaceId/facts` (e.g. `/api/brain/general/facts`) answers `404`. Port any client still using it to the `/spaces/:spaceId/` prefix.

## Retry Safety

**A request that times out has not necessarily failed.** If you retry a create, whether you get one record or
two depends on the record type — so this is the first thing to read if anything you write is retried, and
anything an agent writes is retried.

| type | retried create | how |
|---|---|---|
| **edge** | **idempotent** | the natural key `(from, to, label)` — a retry lands on the same edge |
| **fact** | **not idempotent** | see below; a blind retry can produce a second record |
| **chrono** | **not idempotent** | same |
| **entity** | **not idempotent** | same; reconcile by `name` if your space treats names as unique |

**An answer carrying `written` is not a failed create.** It means the record was stored and a later step — its
connections — failed, so the create must not be sent again, whatever the status; its `retryable` is `false`. See
[A refused connection writes nothing](#a-refused-connection-writes-nothing).

### Identity is server-generated

**You cannot choose a record's id.** `id` on a create names an **existing** record to update; an id that matches
nothing is ignored and the record is created with a fresh, server-minted UUID.

This is deliberate. Adopting a caller's id would make the caller a co-author of the primary key, and that has a
sharp edge across a network: the natural way to produce a stable id is to derive it from a stable key, so two
instances following the same convention would collide **by design** — and sync resolves a collision by `seq`
alone, so one version would silently replace the other with every reference still resolving to the survivor.

If you need to carry your own reference into Ythril, put it in **`name`**, **`description`**, or a property. Those
fields are for describing a record. `id` identifies one.

### How to make a create retry-safe

Use the duplicate check, which is on by default:

```js
// checkDuplicates is TRUE by default: the response carries `similar` when the write matched
// something already stored, so a retry that landed twice is detectable rather than silent.
const res = await post('/api/brain/spaces/general/facts', { fact });
if (res.similar?.length) {
  // The first attempt probably succeeded and its response was lost. Reconcile instead of retrying:
  // read the match, and delete this one if it is a duplicate of it.
}
```

Two things follow from that:

- **A duplicate check costs a vector.** `checkDuplicates: true` computes the embedding before the insert, so the
  write waits on the embedder and fails if it is unreachable. That is the trade: an answerable "is this already
  here?" in exchange for a synchronous dependency. Pass `checkDuplicates: false` to opt out, and accept that a
  retry after an ambiguous failure may duplicate.
- **For an edge, just retry.** `(from, to, label)` is the natural key and a second write converges.

### What happens on a genuine update

When `id` names a record that exists, the write lands on it:

- `seq` and `updatedAt` advance, so it is a real write and appears in the audit log and in
  `ythril_brain_write_seq_total`;
- **tags union and properties shallow-merge**, they do not replace;
- the webhook event is `fact.updated` / `chrono.updated` / `entity.updated`, **not** the created event.

### Rules

- `id` must be a **UUID v4**. Anything else is a `400` — it becomes the record's identity across
  every peer in every network the space belongs to, so it is held to a shape.
- **Omitting `id`** creates a new record on every call.
- An id that names nothing is ignored and the record is created with a server-minted id — see
  [Identity is server-generated](#identity-is-server-generated).
- The MCP tools `save_fact` and `save_chrono` take the same optional `id`, with the same
  meaning.

---

### Write a Fact

```http
POST /api/brain/spaces/:spaceId/facts
```

```json
{
  "id": "3f2b1c9e-7d84-4a51-9e60-1b2c3d4e5f60",
  "fact": "Kubernetes pods are ephemeral by design",
  "type": "note",
  "tags": ["k8s", "architecture"],
  "description": "This means pod-local storage is lost on restart.",
  "properties": { "source": "k8s-docs", "confidence": 0.95 }
}
```

#### A record and its relationships in ONE call

Every write door — `facts`, `chrono`, `entities`, and their MCP twins — takes the relationships the
record needs alongside the record itself, **on the update verb as well as the create**.
Two fields, and they behave differently on purpose. What a `PATCH` does with them is in
[Write & Read Semantics](04f-write-semantics.md#what-a-patch-does-to-tags-and-properties).

**`linkEntities`, `linkFacts`, `linkChronos`, `linkFiles`** create LINKS. A link is unlabelled and which
way it runs follows from the kinds at its ends, so a bare id is the whole thing. `linkFiles` takes
space-relative paths; the other three take UUIDs.

> **Changed in 5.0:** `entityIds`, `memoryIds` and `chronoIds` are refused — port them to `linkEntities`,
> `linkFacts` and `linkChronos`, ids unchanged.
>
> A connection is a record in the space's `links` collection and nothing else, so an ordinary edit of a fact
> cannot drop a link somebody else made. **A body carrying one of the old fields is REFUSED** whole, with the
> new field named in the message, so a body naming one stores nothing. What else a connection can be refused for,
> and what a failure after the record was stored answers, is in
> [A refused connection writes nothing](#a-refused-connection-writes-nothing).

```json
{
  "fact": "The 72-hour clock starts at detection, not at containment.",
  "linkEntities": ["3f2b1c9e-7d84-4a51-9e60-1b2c3d4e5f60"],
  "linkFiles": ["policies/incident-response.md"]
}
```

**`edges`** creates LABELLED relationships. An edge carries a label, a direction that is data rather than
derivable, and optionally `weight`, `type`, `description`, `tags` and `properties` — `posted_by` and
`addressed_to` from the same record to two parties are two different facts, and no array of bare ids can say
which is which.

```json
{
  "name": "Incident 2026-09-04",
  "type": "incident",
  "edges": [
    { "to": "3f2b1c9e-…", "label": "reported_by" },
    { "to": "7a1e4d2b-…", "label": "affects", "weight": 0.8, "properties": { "severity": "high" } },
    { "to": "policies/incident-response.md", "label": "governed_by", "toKind": "file" }
  ]
}
```

**They differ on what an UPDATE does, and this is the part to read twice.**

| | on a create | on an update |
|---|---|---|
| `linkEntities` and its siblings | creates those links | **REPLACES** the links of that kind. `[]` detaches them all; omitting the field leaves them alone. Other kinds are never touched. |
| `edges` | creates those edges | **UPSERTS**. The same `(to, label)` written again is updated; nothing is ever removed. |

The difference is not an inconsistency. An unlabelled link set is something one record owns wholesale, so
replacing it is meaningful. An edge carries a label, properties and possibly a different author — clearing
the set would delete work nobody asked to delete. Remove one with `DELETE /api/brain/spaces/:spaceId/edges/:id`
or the `delete_edge` tool.

**The other end must already exist.** Neither field can connect two records the same call creates, because
identities are minted server-side. That case is `save_bulk`, which takes `entities` and `edges` in one
payload.

**On a space with `strictLinkage` (the default), a far end that names nothing is refused**, not stored — the same
rule the rest of the API applies, so a dangling relationship cannot be created by accident. It holds for a far end
of every kind (`toKind` entity, fact, chrono or file). A space with `strictLinkage: false` stores it, for staged
imports whose targets arrive in a later pass; see [Reference integrity](12-admin-api.md#reference-integrity). One
thing worth knowing under strict: a UUID is a legal filename, so a `toKind: "file"` end holding an entity id is not
a *shape* error. It is caught by the existence check instead, which is why that check is not optional.

#### A refused connection writes nothing

**A connection that cannot be honoured is refused before the record is written, and then nothing is stored** — not
the record, and not the entries of `edges` that came before the bad one. An `edges` entry is judged as the same edge
sent to `POST …/edges` would be: its label and end types against the space's schema, the second target of a
`functional` label (counting the other entries of the same body) and, on a space with `strictLinkage`, whether its far
end exists. The refusal names the entry — `edges[1].to` — so a body with several faults is corrected in one pass. A
`link*` id that names nothing is refused the same way.

**What was refused sets the status.** An `edges` entry the space refuses — its schema, or on a `strictLinkage` space a
far end that names nothing — is a `schema_violation`, the record's own schema refusal with the status it has on that
verb: a `POST` answers `400` and a `PATCH` answers `422`, both with the body documented under
[Schema Validation](06a-schema-api.md#schema-validation); an MCP tool answers the same body as a structured
`schema_violation` ([MCP](16-mcp.md)). A `link*` id that names nothing, and a malformed body (an id that is not a
UUID, a retired field), is a `400` with `{ "error" }` on every verb, a `PATCH` included. On an update, a record that
does not exist is `404` before any of this, and the refusal comes before an `If-Match` `412`. Under `validationMode: warn` a schema rule is reported as a warning and the
write proceeds, as for every other schema rule; `strictLinkage` is its own switch.

**What this does not cover is the window after the record is stored.** A single-record write stores the record, then
its edges — an edge needs both ends — and the two are not one transaction. If the store fails in between, or a far
end is deleted between the check and the write, the record exists and some of its edges may not. That answer says so,
with the status of the cause's class, the same on a `POST` and a `PATCH` — `422` for a schema refusal that only shows
after the record landed, `400` for a reference, `409` for a write conflict, `503` or `500` for the store — and:

```json
{ "error": "…", "retryable": false,
  "written": { "kind": "entity", "id": "3f2b1c9e-…", "edges": ["b81c0e5a-…"] } }
```

`written` names the record and the edges that DID land, at the top level of the body. It is never `retryable` and
carries no `Retry-After`, **even when the status is a `503`**: a create sent again without an id stores a second
record. When the cause is a refusal the body adds `refusal`, its words. Send the edges that did not land as an update
to `written.id`; an edge you send again that had landed is upserted, not duplicated. An MCP tool carries the same
object in `structuredContent`, `POST /api/<tool>` under `data`, and on `/bulk` and `save_bulk` it rides on the failed
item's row in `errors` ([Bulk](04d-brain-ops-api.md)).

#### A batch that connects what it creates

`POST /api/brain/spaces/:spaceId/bulk` and `save_bulk` take facts, entities, chrono entries and edges in
one payload, at most 500 of each. A longer array refuses the whole batch with a `400` naming it, before anything is
written — it used to be cut at 500 and answered with the same `207` as a clean batch (`Q-109`). Identities are minted server-side, so an id you invent for a record in the payload is not the id
it gets, and an edge naming it would point at nothing.

Put `"$ref"` on an item and name it later in the same call:

```json
{
  "entities": [
    { "$ref": "post-1", "name": "2026-09-07 status", "type": "message" }
  ],
  "edges": [
    { "from": "$ref:post-1", "to": "3f2b1c9e-…", "label": "posted_by" },
    { "from": "$ref:post-1", "to": "7a1e4d2b-…", "label": "answers" }
  ]
}
```

**It is a correlation key, not an id.** It is scoped to the one call and never stored; the record's identity
is still minted by the write. The response answers with what each key was given, in `refs`:
`{ "post-1": { "id": "…", "kind": "entity" } }`. A key whose item was refused is absent, so every row in
`refs` names a record that exists — take the ids from there rather than reading the space back by text.

**Every record array is written before any edge**, so an edge can reference any record in the payload.
Within a single array a reference cannot point forwards: an item can only name something declared above it.

**The KIND comes from the array, not from you.** `fromKind`/`toKind` exist because a bare UUID can name
records in two collections and a wrong guess stores a relationship that reads as correct and points at
nothing. A `$ref` cannot be ambiguous, so stating a kind becomes a CHECK — one that disagrees with the array
the key was declared in is refused rather than resolved.

**A key used twice is refused**, not overwritten: the second item is reported and not written. Two items
claiming one name is a mistake with two readings, and picking one silently means half your payload points
somewhere you did not intend.

**A key whose item was not written is not a key.** It is absent from `refs`, and an item referencing it fails
with a reason naming why that item was refused — not "unknown `$ref`", which would say it was never declared.

**References are checked for EXISTENCE under `strictLinkage`**, the same rule the single-record doors apply.
This door used to be laxer — shape only, on a space that had not been converted to link records — and 5.0
removed that shape, so a well-formed id pointing at nothing is refused here as it is everywhere else. With
`strictLinkage: false` neither shape nor existence is checked. A resolved `$ref` always exists, so this costs a
batch nothing.

#### An item carries its own relationships

Every single-record write takes the link classes its kind can hold plus an `edges` array, so attaching a
record to three things is one call. **A batch item takes the same fields, through the same code**, so a
batch of hundreds of records needs no second pass to connect them.

```json
{
  "facts": [
    {
      "fact": "The 20s budget is what the canary's 502 was hitting.",
      "linkEntities": ["3f2b1c9e-…"],
      "edges": [ { "to": "7a1e4d2b-…", "label": "corrects" } ]
    }
  ]
}
```

**An item's own `edges` name records that ALREADY EXIST, and a `$ref` there is refused.** An item is applied
at the moment it is written, so a key declared further down the payload could not resolve — and resolving
only backwards would make whether a payload works depend on the order somebody happened to type it in. The
refusal names the top-level `edges` array, which runs after every record array and resolves a key to
anything in the call.

**A connection that cannot be honoured is refused before the record is written.** An `edges` entry with no
label, a label or end the space's schema refuses, a far end that does not exist on a `strictLinkage` space, or a
link class the record's kind cannot hold, is reported against that item's index, names the entry (`edges[1]`), and
the record does not exist afterwards. The alternative is an error plus a row you did not ask for, which on a batch
of five hundred is worse than either. The one case outside that is a failure after the record was stored: the
item's row then carries `written` and is not to be sent again as a create
([A refused connection writes nothing](#a-refused-connection-writes-nothing)).

**What each kind may hold is the link vocabulary's answer, not this door's.** An entity holds no link
classes — it is only ever the far end of one — and it still takes `edges`, because a labelled relationship
starts anywhere.

**Response** `201`:

```json
{
  "_id": "a1b2c3d4-...",
  "spaceId": "general",
  "fact": "Kubernetes pods are ephemeral by design",
  "type": "note",
  "tags": ["k8s", "architecture"],
  "description": "This means pod-local storage is lost on restart.",
  "properties": { "source": "k8s-docs", "confidence": 0.95 },
  "seq": 42,
  "createdAt": "2026-03-25T14:00:00.000Z",
  "updatedAt": "2026-03-25T14:00:00.000Z",
  "author": { "instanceId": "c6ff5d55-...", "instanceLabel": "My Ythril" }
}
```

#### A create tells you which fields it did not understand

**Every brain create returns a `warnings` array naming any body key it does not accept**, and stores the record
anyway. `{"fact": "...", "totallyMadeUpField": "xyzzy"}` returns `201` with:

```json
"warnings": [
  {
    "field": "totallyMadeUpField",
    "value": "xyzzy",
    "reason": "unknown field — ignored. This route accepts: checkContradictions, checkDuplicates, description, dupeThreshold, edges, fact, id, linkChronos, linkEntities, linkFacts, linkFiles, properties, suppressEmbeddings, tags, ttlDays, type, waitForEmbedding"
  }
]
```

**It is a warning, never a refusal.** A `400` would break every forward-compatible client the day a field is
removed. The point is not to reject the write — it is that a caller can tell *"this parameter is not
implemented"* from *"this parameter was applied"*, which a bare `201` and an id cannot say.

The rows share the `warnings` array with schema violations in a `warn` space, and the same
`{field, value, reason}` shape. An object or array value is named by its type rather than reflected back, and a
long string is truncated: a warning is not a place to echo a payload.

**MCP refuses where REST warns**, and the difference is deliberate. A tool's input schema is
`additionalProperties: false` and the dispatcher enforces it, so an unknown argument there is an error before
any handler runs. An MCP schema is published to its caller and a REST body shape is not, so the strict door can
afford to refuse and the open one has to explain. **Test through one and deploy through the other and you will
get two different answers to the same mistake** — which is worth knowing before it surprises you.

**The UPDATE routes answer both questions too.** An update response carries `warnings` when there is
something to say, with the schema violations (in a `warn`-mode space) and the unknown-field rows in the same
array — an edit is told about a schema violation exactly as a create is.

Their accepted-field lists differ from the creates', which is worth knowing before you copy one:
`deleteFields` is an update field, and `id` is a path parameter rather than a body key.

**Constraints**: `id` optional — a **UUID v4** naming an **existing** record to update. It is not a way to choose an id: identity is server-generated, so an id that matches nothing is ignored rather than adopted, and the record is created with a fresh one. Anything that is not a UUID v4 is a `400`. To carry your own reference, put it in `name` or `description`. See [Retry Safety](#retry-safety). **Constraints**: `fact` max 50 000 chars. `type` optional string — stored on the document and validated against the space's `typeSchemas.fact` allowlist when set. `tags` must be an array of strings. `description` optional string. `properties` optional object; property values should be a string, number, or boolean (unlike the ENTITY endpoints, the fact/edge/chrono write paths don't reject non-primitive values at the API layer — schema validation is the gate when the space defines the property). Every entity door does reject them: create, `PATCH`, `bulk` and both MCP tools, with one message. See [What a PATCH does to tags and properties](04f-write-semantics.md#what-a-patch-does-to-tags-and-properties) for why structure belongs in records and edges. Every id in `linkEntities` must be a UUID v4 **and** name an entity that exists — passing a name, a malformed id, or an id that resolves to nothing returns `400` and stores nothing. The 4.x `entityIds` is refused by name, and the refusal says to send `linkEntities` instead. This is the default; a space can opt out with `meta.strictLinkage: false` (see [Reference integrity](12-admin-api.md#reference-integrity)). `ttlDays` optional — see [Record Expiry (TTL)](04f-write-semantics.md#record-expiry-ttl). `waitForEmbedding` optional boolean — see below.

#### Catching a near-duplicate at write time (`checkDuplicates`, `checkContradictions`)

A write can tell you it looks like something you already have, before you have two of them:

```json
{ "fact": "Deploys are frozen on Fridays after 14:00 UTC", "checkDuplicates": true }
```

```json
{ "_id": "…", "fact": "…",
  "similar": [ { "_id": "…", "type": "fact", "score": 0.94, "summary": "Deploys freeze Friday 14:00 UTC" } ] }
```

Available on `POST …/facts`, `POST …/entities` and `POST …/chrono`, with the same meaning as on the MCP
tools.

| field | default on REST | effect |
|---|---|---|
| `checkDuplicates` | `false` | Report existing records that are semantically near-identical, as `similar` (`_id`, `type`, `score`, `summary`). |
| `checkContradictions` | `false` | Report near-neighbours that set the same single-valued property to a DIFFERENT value, as `contradicts`. A different question from redundancy, so it is a separate flag. |
| `dupeThreshold` | `0.92` | Score at or above which a neighbour is reported. Must be between 0 and 1. |

- **It never blocks the write.** The record is stored either way and the warning rides on the `201`. An agent
  correcting an outdated fact must be able to contradict the record it supersedes — the point is that it is
  told, not that it is stopped.
- **`checkDuplicates` is opt-in here and defaults ON over MCP; `checkContradictions` defaults OFF on
  BOTH doors.** The asymmetry is deliberate: the check implies `waitForEmbedding`, because it needs the vector
  before the insert so the new record cannot match itself. On REST — which is also how a fleet imports
  thousands of records — defaulting it on would make every integration pay the embedding model synchronously
  without asking.
- **`recall` is not a substitute**, and the scores show why: the same pair can score **0.94** on this
  check and **0.896** on recall, while unrelated topical neighbours sit at 0.845. No recall threshold
  separates the true near-duplicate from the coincidences, and the two scales are not interchangeable.
- `GET /api/duplicates` is the background scanner's review queue, not an on-demand similarity search — it
  lists what a scheduled sweep has already found.

A non-boolean flag (or a `dupeThreshold` outside 0–1) is a `400`, never a coercion: `"false"` is truthy, and
a hygiene check that silently turns itself off is worse than one that was never asked for.

#### When does a fact become searchable? (`waitForEmbedding`)

**By default, a moment after the write returns.** The write stores the record and hands the embedding to a
background queue, so the write does not pay the model's latency. A worker embeds it immediately afterwards, and a
failure retries with backoff rather than being final.

Until that lands, the record **is not returned by `recall`** — not ranked lower, absent. Both retrieval
channels need the vector: the semantic one obviously, and the lexical one because it computes a real
similarity for the records it introduces rather than inventing a score. The gap is normally milliseconds.

Send `"waitForEmbedding": true` when that gap matters:

```json
{ "fact": "Kubernetes pods are ephemeral by design", "waitForEmbedding": true }
```

| | `waitForEmbedding: false` (default) | `waitForEmbedding: true` |
|---|---|---|
| write latency | does not include the model | includes the model |
| searchable when the call returns | not yet | yes |
| embedder unavailable | write **succeeds**; the queue retries | write **fails** |

Use it when you will search for what you just wrote in the same flow, or when a record that cannot be embedded
should be a visible error rather than a background repair. `checkDuplicates` and `checkContradictions` imply
it — a duplicate check needs the vector before the insert so the new record cannot match itself.

**A `PATCH` re-embeds through the same queue**, and always — you do not have to work out whether the fields
you sent were the ones the vector is built from. The record keeps its previous vector until the worker
catches up, which is a moment later; unlike a create, an updated record is never *absent* from `recall` in
the meantime, it is briefly ranked on its previous text. **If the embed then fails** (the embedder is down), the
previous vector is dropped rather than kept: it describes text the record no longer holds. Until a retry succeeds
the record is found by its current words and not ranked by meaning, and `list_embed_jobs` shows the failed job.
Its matched text is the current text on every path, embedded, suppressed or failed, so text you removed stops
matching at once.

That is deliberate and it is the correctness argument, not a convenience: the worker rebuilds the text from
the record **as stored**, so it sees every concurrent edit. An update that computed the vector itself could
only build it from the record as that request read it — so two clients editing different fields would both
succeed, lose nothing, and still leave the stored vector describing a record that exists nowhere. `PATCH`
does not take `waitForEmbedding`; if you need the new vector before you search, poll the record or re-read it.

---

### Write & read semantics

Expiry, stamp integrity, `PATCH` semantics for `tags` and `properties`, optimistic concurrency,
what a read never sends, retiring a record from semantic search, and partial updates with
`deleteFields` are in **[Write & Read Semantics](04f-write-semantics.md)** — they apply to every
brain record, not only to facts.

### Read one fact by id

There is no `GET .../facts/:id` (removed in 5.0 — port reads to `filter`). One record is a predicate over
one collection, so it is `filter`:

```http
POST /api/filter
Content-Type: application/json

{ "space": "work", "collection": "facts", "filter": { "_id": "8f3c…" }, "limit": 1 }
```

**A record that is not there is `200` with `results: []`, not `404`** — branch on `results.length`. The
reasoning, and the `$in` form for a set of ids, are in
[Read one entity, or a set of them, by id](04b-graph-api.md).

**Response** `200`: `results` holds the full `FactDoc` (same shape as the write response).

> **What a stored record carries beyond the fields you wrote.** A read by id or a list returns the
> document as stored, minus the embedding vector — which, as everywhere else, is never returned
> and cannot be requested. Three of the remaining fields are the system's rather than yours:
>
> | field | what it is |
> |---|---|
> | `seq` | The sync counter, and the value to send as `If-Match` on a conditional write. Useful, not internal |
> | `matchedText` | The exact text this record's vector was built from. Derived from the fields above it, and for a file chunk it is the heading plus the passage — so the passage a SECOND time |
> | `embeddingModel` | Which model produced the vector. Identical for every record in a space |
>
> **`matchedText` and `embeddingModel` are withheld by DEFAULT here** — `matchedText` is the passage a
> second time, on the read most likely to be made in bulk. Send `includeDiagnostics: true` to get them
> back — the same name `recall` uses, as a body field on `filter`.
>
> **`seq` comes back, always, and that is deliberate rather than an oversight.** `recall` withholds it along
> with the other two, but here it is the `If-Match` value: dropping it would remove the conditional-write
> path, which costs more than the bytes are worth. So the two doors withhold a *different* set by one field,
> on purpose.
>
> The structured [`POST /api/filter`](04d-brain-ops-api.md#structured-query-read-only) route accepts a
> `projection`, which is the way to bound a read to named fields.

---

### List facts

There is no `GET .../facts` (removed in 5.0 — port lists to `filter`). Listing a collection is one shape for
all of them — a predicate, a page, and the same envelope whichever collection you name:

```http
POST /api/filter
Content-Type: application/json

{ "space": "work", "collection": "facts", "limit": 100, "skip": 0 }
```

Every parameter the removed list route took, `filter` takes: `tag`, `type`, `description`, `properties`, `search`,
`entityName`, `sort`, `dir`, `limit`, `skip`. They are documented once, with what each refuses, in
[the filter body](04d-brain-ops-api.md). Two differences worth knowing before you port a caller:

| | the route | `filter` |
|---|---|---|
| a fact linked to an entity ID | `?entity=<id>` | a `filter` over `links` — `{ "to": "<id>", "fromKind": "fact" }` — whose `from` ids are the facts. A connection is its own record, so it is not a predicate over the fact. When a NAME will do, `entityName` still answers in one call |
| the page size | default 100, hard max 500 | `limit`, default 200 and no maximum |

**Compare your running sum against `total` and stop.** That is what `total` is for. Page with `skip`:
`filter`'s body is strictly allowlisted, so `offset` is a `400` that names `skip` rather than a silently
ignored key.

On a **proxy space** the page is computed over the merged set of member spaces, not per member, so `skip`
means the same thing it does on a plain space. `skip + limit` is bounded there — a deep page needs that many
rows from every member — and exceeding the bound is a `400` naming the ceiling.

**`limit` has no maximum, and what is READ is bounded instead.** On a single space the rows are taken off the
database cursor only until they are twice the answer budget (`maxChars` / `maxBytes`), and the answer is trimmed
to the budget with `truncated: true` and `nextSkip` — so `limit: 1000000` costs one budget's worth of reading, not
the collection. Page on with `nextSkip`; compare against `total` to know when you are done.

---

> **A malformed optional field is REFUSED, not dropped.** Sending `"description": 12345` or
> `"properties": "not-an-object"` answers `400`, on a create as on a `PATCH`. The `warnings` array still reports only
> keys the server does not recognise — a known key with a wrong value is an error, not a warning.
>
> **`PATCH` enforces every value rule its `POST` enforces.** The 50 000-character limit on `fact`, the
> array-of-strings rules, the plain-object rule for `properties`, and the 0–1 bound on an edge `weight` and
> a chrono `confidence` all apply to both doors. What a create still demands and an update does not is that
> a field be PRESENT.

### Delete a Fact

```http
DELETE /api/brain/spaces/:spaceId/facts/:id
```

**Response** `204`, or `409` when something still points at it and the space has
`strictLinkage` on. The body carries `error`, `blocking` (what refused it) and
`references` (everything pointing at it). A chrono entry or a file LINKED to this fact blocks the delete; clear the link first (`linkFacts: []` on the referring record, or `DELETE .../links/:id`).

> **Changed in 4.0:** a linked chrono entry or file blocks this delete, so a script that deleted such a fact
> on an older version now gets `409` — clear the link first. With `strictLinkage` off it always succeeds.

Deleting a fact does not delete its forks — the facts sync created when a peer sent a different text for it at the
same version (they carry `forkOf` naming this fact). To erase a text everywhere it was kept, list them first with
[`POST /api/filter`](04d-brain-ops-api.md#structured-query-read-only) on `facts`, `{"forkOf": "<id>"}`. A fork is its own record, deleted like any other fact.

---

### Empty a space

```http
POST /api/delete_space_data
Content-Type: application/json

{ "space": "work", "confirm": true, "types": ["facts", "chrono"] }
```

`types` is a subset of `facts`, `entities`, `edges`, `chrono`, `files`. **Omit it and all five go** — an
omitted `types` is not a safe default. A partial wipe clears only the tombstones and review findings
belonging to the types you named.

**Response** `200` `{ "ok": true, "text": "The answer is in data…", "data": { "facts": 12, "entities": 3, ... } }` — the
[tool-door envelope](16-mcp.md#the-same-tools-over-plain-http), because this path IS the `delete_space_data`
tool. Zeroes mean the space was already empty, not that anything refused. Throttled to 5 calls a minute per
token **on both doors**, and rejected on a proxy space (`400`) — target member spaces individually.

`confirm: true` is required. The act is irreversible: no undo, no trash.

**On a space that belongs to a network nothing is deleted yet.** Emptying a shared space is a governed act:
a round opens in every network holding the space, this instance votes yes, and the wipe happens on every
member when a round passes — one veto stops it. The reply is still `200`, with
`data.status: "vote_pending"` and the open rounds. **That is the success case** — do not retry it, and do
not read the absence of counts as a failure. Branch on `data.status`, which is the same field MCP returns.

> **Changed in 5.0:** the per-collection bulk `DELETE` routes, which answered `{ deleted: <count> }`, are
> gone — port to this route with `types[]`. It is the `delete_space_data` tool: same arguments, same answer.

---

### Live Change Stream (Server-Sent Events)

```http
GET /api/brain/spaces/:spaceId/events
```

A [Server-Sent Events](https://developer.mozilla.org/docs/Web/API/Server-sent_events) stream that emits
one message per brain mutation in the space, so a UI can refresh live instead of polling. Each message:

```text
data: {"event":"fact.created","id":"a1b2c3d4-..."}
```

`event` is the change type (`fact.created` / `entity.updated` / `edge.deleted` / `chrono.created` / …,
or `bulk.write` for a batch); `id` is the affected record's ID when applicable. Comments (`:\n\n`) are
sent on connect and every 30 s as a keep-alive.

- **Auth:** space-scoped; read-only tokens may subscribe. A browser `EventSource` cannot set an
  `Authorization` header, and a raw token in the URL leaks into logs/history — so authenticate with a
  **single-use ticket**: `POST /api/brain/spaces/:id/events/ticket` with the normal `Authorization`
  header returns `{ ticket, expiresInMs }`; open the stream with `?ticket=<ticket>`. The ticket is
  single-use (mint a fresh one per connect, including reconnects), expires in ~60 s, and is bound to this
  space's stream. A non-browser client that can set headers should just use `Authorization` directly.
- **Scope:** events fire for writes made through the REST and MCP APIs on this instance. Changes applied
  by the **sync engine** — records pulled or pushed from a peer, and the bytes of a file a peer pushed or this
  instance pulled — are not emitted here: no webhook fires for them either. They appear on the next load.
- **Bounds:** at most **200** streams of this kind are open at once, instance-wide; the next is a `503` with
  `Retry-After`. A reader more than **256 KiB** behind is disconnected rather than buffered for. Reconnect with a
  FRESH ticket (the old one is spent) and re-read — every message means "something changed, re-read", so the
  re-read restores anything the gap missed. The Brain page does exactly this.

```js
// Browser: mint a single-use ticket (token stays in the header), then open the stream with it.
const { ticket } = await fetch(`/api/brain/spaces/${space}/events/ticket`, {
  method: 'POST', headers: { Authorization: `Bearer ${token}` },
}).then((r) => r.json());
const es = new EventSource(`/api/brain/spaces/${space}/events?ticket=${encodeURIComponent(ticket)}`);
es.onmessage = (e) => { const { event, id } = JSON.parse(e.data); /* refresh the affected view */ };
// On es.onerror, mint a new ticket before reconnecting — the old one is already spent.
```

---

### Sorting (all brain list endpoints)

There are no `GET` list endpoints: a collection is read with
[`POST /api/filter`](04d-brain-ops-api.md#structured-query-read-only), and that is where sorting lives. It
takes `sort` and `dir` (`asc` / `desc`, default `desc`). The sort is applied server-side **before** paging,
so it orders the whole result, not only the page you fetch.

The sortable fields are fixed per collection; an unrecognized field is a `400` naming the allowed ones,
never a silent fall-back to the default order:

| Collection | Sortable fields |
|------------|-----------------|
| entities | `createdAt`, `name`, `type` |
| edges | `createdAt`, `label`, `from`, `to`, `type`, `weight` |
| facts | `createdAt`, `type` |
| chrono | `createdAt`, `title`, `startsAt`, `endsAt`, `status`, `type` |
| files | `createdAt`, `updatedAt`, `path` |

With no `sort`, results are newest first.

### Freetext search (`?search=`)

`filter` takes a `search` argument that matches a **case-insensitive substring** of the record's text
fields, applied server-side before paging (so it spans the whole set, like sort). The value is a
**literal** — regex metacharacters are escaped, so `a.b` matches the three characters `a.b`, not "a, any
char, b". It is refused on `links`, which has no text of its own.

| Collection | Searched fields |
|------------|-----------------|
| entities | `name`, `description` |
| edges | `label`, `description` |
| facts | `fact`, `description` |
| chrono | `title`, `description` |
| files | `path`, `description` |

For an exact match use a predicate instead: `filter: { name: ... }` for an entity, or the `path` argument
for a file, normalised the same way (see [the filter body](04d-brain-ops-api.md)).

---

---
