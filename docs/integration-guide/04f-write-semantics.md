# Brain API — Write & Read Semantics

> Part of the [Ythril Integration Guide](../integration-guide.md).

How a brain record behaves when you write it, update it and read it back: expiry, stamp integrity, what a
`PATCH` does to `tags` and `properties`, optimistic concurrency, what a read never sends, retiring a record
from semantic search, and partial updates with `deleteFields`.

**These rules are not about facts.** They apply to entities, edges and chrono entries the same way — they
were documented on the fact page because facts were written up first. The endpoints themselves are in
[Brain API](04-brain-api.md), [Entities, Edges & Graph](04b-graph-api.md) and [Chrono](04c-chrono-api.md).

---

## Write & read semantics

### Record Expiry (TTL)

Any record — fact, entity, edge, or chrono entry — can be given an expiry after which it is
**deleted automatically**. Deletion runs through the normal delete path, so it writes a tombstone that
propagates over sync: an expired record cannot resurrect from a peer (which a raw MongoDB TTL index,
deleting below the application, would allow).

Two ways to set it, both usable together:

- **Per-record** — send `ttlDays` on any write (create or update):
  - `ttlDays > 0` → the record expires that many days after the write (integer, max `36500` ≈ 100 years).
  - `ttlDays: 0` or `ttlDays: null` → the record **never** expires, overriding any space default.
  - `ttlDays` omitted → the space's auto-TTL default is applied **only if the record has no expiry yet**
    (an existing expiry is never silently re-slid by an unrelated edit).
  - A present-but-invalid `ttlDays` (negative, non-integer, out of range) is rejected with `400`.
- **Space-wide default** — set `recordTtlDays` on the space (`PATCH /api/spaces/:id`, or the Danger Zone in the
  space's settings). Every new or updated record in that space that doesn't specify its own `ttlDays` expires
  after that many days. It takes **one window per kind of record** — see
  [The space tier is five windows](#the-space-tier-is-five-windows).

```json
{ "fact": "Temporary scratch note", "ttlDays": 7 }
```

The expiry surfaces as `_expireAt` (an ISO timestamp) on the record — **not `expiresAt`**, which is a different field on different things (a token, a recall graph download, a file-meta thumbnail) and is never present on a brain record. Reading back the wrong one returns nothing whether the expiry was set or not, which is how a working `ttlDays` gets measured as broken: it was, across 120 records, and reported as a bug on 2026-08-30. The sweep runs periodically on every
instance; expiry is eventual (granularity is days), not to-the-second. A `ttlDays`-only update (no other
fields) is a valid write — use it to set, extend, or clear an existing record's expiry.

`ttlDays` is accepted on the **MCP** write tools as well (`save_fact`, `update_fact`, `save_entity`,
`update_entity`, `save_edge`, `update_edge`, `save_chrono`, `update_chrono`, `write_file`) and per item in
`save_bulk` / `POST /bulk`, with the same semantics — so agents can set an expiry directly.

**Files** carry TTL too: pass `ttlDays` as a **query parameter** on the upload — `POST /api/files/:spaceId?path=…&ttlDays=30`
(a query param so it works for raw-binary bodies) — or the `ttlDays` field on the MCP `write_file` tool. The
expiry is stamped on the file's metadata record; when it lapses, the sweep runs the **full file delete**
(the blob, its embedding chunks, conversion artifacts and any queued job — not just the record), the same as
`DELETE /api/files/:spaceId`. The space-wide `recordTtlDays` default applies to uploads that omit `ttlDays`.

#### Per-type retention — `record > schema > space`

A space-wide TTL is the wrong axis for a space that mixes telemetry with knowledge. Deploy `event`s are
content-free by design, so they cluster tightly and **displace real answers in recall**; `health-snapshot` and
`metrics-snapshot` records exist to be trended, and a 90-day cap is one quarter with no year-over-year. One
number cannot serve both.

Retention therefore resolves in three tiers:

| tier | where | reaches |
|---|---|---|
| **record** | `ttlDays` on the write | that one record. Wins outright; `0`/`null` means never expire |
| **schema** | `typeSchemas.<collection>.<type>.retention` | every record of that type, in any of the four typed collections |
| **space** | `recordTtlDays` | everything else of that KIND, including records with no type at all — one window per kind, see below |

The middle tier lives **on the type**, beside `namingPattern` and `propertySchemas`, because retention is a
per-type rule and that is where the per-type rules already are:

```json
{
  "meta": {
    "typeSchemas": {
      "chrono": {
        "event":            { "retention": { "days": 90, "contentDays": 14 } },
        "health-snapshot":  { "retention": { "days": 3650 } }
      },
      "entity": {
        "ticket":  { "retention": { "days": 365 } },
        "roadmap": { "retention": { "days": 3650 } }
      }
    }
  }
}
```

> **A previous release documented a `chronoRetention` map on the space object.** That shape was replaced before
> it was ever in a tagged release, and it no longer exists — a per-type window on the space object would have
> been a second place to configure one rule. Use `typeSchemas.<collection>.<type>.retention`.

#### The space tier is five windows

`recordTtlDays` takes **one window per kind of record**, because a space does not hold one kind of thing. A
`tickets` space holds ticket *entities* that must outlive their status-change *chronos*; an `alerts` space holds
durable `alert-rule` entities beside `episode` chronos that are pure telemetry. The schema tier cannot express
either — it keys on a type *name*, and this is about a whole collection.

```json
{ "recordTtlDays": { "entity": null, "fact": null, "edge": null, "chrono": 90, "file": 30 } }
```

| | |
|---|---|
| buckets | `entity`, `fact`, `edge`, `chrono`, `file` — **five**, because files share this tier: they have no type, so the schema tier cannot reach them, and they are the largest and most obviously disposable of the five |
| a bucket set to `0` or `null` | no window for that kind. Same as absent — there is no tier above the space for a bucket to inherit from |
| **a partial object MERGES** | `{"chrono":90}` sets chrono and leaves the other four alone. **This is the opposite of the `typeSchemas` rule**, where a named type is replaced wholesale — there the value is a whole definition you are holding, here each bucket is one independent number |
| a bare number | the **legacy shape**, accepted forever, and it means all five. It also *replaces* a stored object: someone sending `90` means all five, and merging that would invent an intent they did not express |
| all five cleared | stored as no retention at all, so `{}`-vs-absent is never a distinction you have to reason about. An object mentioning **no** bucket is rejected with `400` — it would make "clear everything" and "change nothing" the same request |

No migration is needed for a space that set the scalar: it is read as all five buckets, permanently.

Two tiers per type, the same shape the audit log uses for its change payloads:

| field | effect |
|---|---|
| `contentDays` | **Chrono only.** The recallable part goes — `description`, `matchedText`, the embedding and `embeddingModel` — and `contentRedacted: true` is set with `contentRedactedAt`. The record stays and **so does `properties`**: it goes semantically silent while remaining queryable by field. Rejected on other collections rather than silently ignored. |
| `days` | The record is deleted, through the normal delete path, so it tombstones and propagates to peers. |

**Why `properties` survives redaction:** the thing that displaces knowledge in recall is the *vector*, plus the
free text that produced it. `properties` is structured, small, and reachable only by an explicit field query, and
for a telemetry record it is often the entire value — an alert episode's `alertname` / `fingerprint` /
`notifyCount` / `outcome` is what the record is *for*. Removing it bought nothing this feature exists to buy. If
you want the structured data gone too, that is what `days` is.

Rules worth knowing before you configure it:

- **A per-record `ttlDays` still wins**, including `0`/`null` for "never expire". Someone said what they wanted
  for that record.
- **A type with only `contentDays`** still deletes on that collection's `recordTtlDays` window. Setting a content
  window means "redact sooner", not "exempt from deletion".
- **A `contentDays` at or past the delete window is ignored**, because it could never fire, and a policy that
  silently does nothing is worse than a rejected one.
- **It applies to records you already have.** A background pass stamps existing records from **their own
  `createdAt`**, not from when you enabled the policy — so switching it on prunes the backlog rather than
  granting everything a fresh full window. It never re-slides an expiry a record already has, so a deliberate
  per-record `ttlDays` is safe from it, and the first time it reaches a space+type it logs one `info` line
  naming the window: a dormant policy that starts deleting records should say so.
  - **This is the schema tier only.** Changing the space-wide `recordTtlDays` does *not* reach back over records
    written before the change — that would start deleting history on every space that has ever set one.
- The schema lives in space meta, so this tier is **governed and replicated**: in a network the policy is agreed
  and each instance then expires its own copy locally, and the tombstones converge.
- **A type defined by `$ref` has no window.** A schema-library entry cannot carry `retention` — its schema
  rejects the field, because one entry is referenced by any number of spaces and a delete policy is not a
  property of the shape. Resolve the `$ref` to an inline definition first, or use the space-wide default.
- Set the space-wide number in **Settings → Spaces → Danger Zone**; set a type's window on the type, in the
  **Schema** tab, beside its naming pattern and property rules. Both are editable in the UI — the delete window
  on any type, and the content window on chrono types, where the editor also refuses a content window that
  could never fire.

---

### Stamp integrity — when a record's own timestamp disagrees with the server's

A record may carry its own idea of when it happened, as a property: `stampedAt`, `postedAt`, or whatever your convention
is. That value comes from the author, and **an estimated timestamp looks exactly like a measured one once it is written
down**. The server holds a number the author did not supply — `createdAt` — so it can compare the two, and you cannot.

On create, if the record carries one of the configured stamp properties and it disagrees with `createdAt` beyond the
space's threshold, the record gets a `stampSkew` field:

```json
{
  "property": "postedAt",
  "stamp": "2026-08-09T0942Z",
  "skewMs": -28800000,
  "thresholdMs": 2400000
}
```

`skewMs` is **signed**: negative means the author's stamp is *earlier* than the write. `stamp` is quoted back exactly as
sent, because the point is that it looked right. `thresholdMs` is what it was judged against, so a record read years later
still says what the rule was at the time.

**It is a warning, never a refusal.** The record is stored exactly as sent. A legitimately backdated record is a normal
thing — a historical import, a backfilled document — and what is being reported is a wrong number, not a corrupt record.

**The field is set only when the threshold is exceeded.** Absence means agreed, or unstamped, or not checked. That makes
presence the signal, and this the whole integrity check:

```http
POST /api/filter
{ "collection": "facts", "filter": { "stampSkew": { "$exists": true } } }
```

The compact form `2026-08-09T0942Z` — no colon, no seconds — is parsed, as are ordinary ISO 8601, an explicit offset, and
epoch seconds or milliseconds. A property that is not a timestamp at all is **not checked** rather than reported as skew.

#### Configuring it, per space

In the space's `meta`, so `PATCH /api/spaces/:id` and `schema_update` already write it:

```json
{ "meta": { "stampSkew": { "warnMinutes": 40, "properties": ["stampedAt", "postedAt"] } } }
```

| Field | Default | Meaning |
|---|---|---|
| `warnMinutes` | `40` | Warn beyond this much disagreement. **`0` disables the check** — it does *not* mean "warn on any difference", because a caller's stamp and the server's clock never agree to the millisecond |
| `properties` | `["stampedAt", "postedAt"]` | Which properties to check, in order. The **first one that parses** decides; naming your own **replaces** the defaults rather than adding to them |

The 40-minute default is not arbitrary: it is the clock tolerance the board protocol that prompted this already assumed
between two parties.

---

### What a `PATCH` does to `tags` and `properties`

**`properties` MERGE on every record type.** A patch that names one key keeps the others — the stored map with
your keys laid over it, one level deep. This is the same rule as an upsert and the same rule a converged retry
follows, so there is one thing to know across facts, entities, edges and chrono entries.

**`tags` differ by type, deliberately:**

| Endpoint / tool | `properties` | `tags` |
|---|---|---|
| `PATCH .../entities/:id`, `update_entity` | merge | **union** with the stored tags |
| `PATCH .../edges/:id`, `update_edge` | merge | **union** with the stored tags |
| `PATCH .../facts/:id`, `update_fact` | merge | **replaces** the stored tags |
| `PATCH .../chrono/:id`, `update_chrono` | merge | **replaces** the stored tags |

**A `PATCH` can change a record's CONNECTIONS too, since 5.0.** `linkEntities`, `linkFacts`, `linkChronos`,
`linkFiles` and `edges` are accepted on the update verb of every door that accepts them on create —
`facts`, `chrono` and `entities`, on both surfaces — and they mean exactly what they mean on a create:

| field | on a `PATCH` |
|---|---|
| `linkEntities` and its siblings | **REPLACES** the links of that kind. `[]` detaches them all; a kind you do not name is untouched |
| `edges` | **UPSERTS** each one. An edge you do not name is left alone; there is no list here that removes one |

A body carrying only a connection field is a valid patch — it used to answer
`400 "At least one field must be provided"`, because the field was not in the update allowlist and so was
not seen at all rather than rejected.

> **Before 5.0 a record's relationships were settled when it was created.** `entityIds` and its siblings were
> the only way to change them afterwards, and a space that has been through the link conversion refuses
> those outright — so on a converted space there was no way to change a record's links at all, by either
> door. If you worked around this by deleting and re-creating a record, you no longer need to, and that
> workaround cost you the record's id and its history.

**Removing a key is `deleteFields`' job, never an absence.** Omitting a property does not delete it, and sending
an empty `properties: {}` is a no-op rather than a wipe. If you need a key gone, name it:
`deleteFields: ["properties.oldKey"]`.

**A property value is a string, a number or a boolean — and on an entity that is enforced, on every door.**
`POST .../entities`, `PATCH .../entities/:id`, `POST .../bulk` and both MCP entity tools all refuse a nested
object or an array with **`properties` values must be string, number, or boolean**. The merge is one level
deep, so there is no level below it for a structure to live in.

**Structure belongs in records and edges, not in a property bag.** A nested value in a property is usually a
graph in the wrong place, and the reason is not the API's — it is that a property bag cannot be improved a
piece at a time. Storing the phases of a plan as one nested value means rewriting the whole value to change
one phase; storing each phase as a record with scalar properties, linked to what it belongs to, means editing
the phase. The second shape is also the one `graph_traverse`, `space_meta`'s `actualSchema` and the
backlink scans can see at all.

> **Fixed in 4.0.** `PATCH .../entities/:id` checked that `properties` was an object and never looked inside it, so
> a nested value was refused on create and **stored** on update — same field, same record, same space, two
> answers. Reported by an integrator who had written one through `PATCH`, read it back intact, and reasonably
> concluded nested properties were supported. If you have records carrying one, they are still there: nothing
> rewrites stored data, and `deleteFields: ["properties.theKey"]` removes it.
>
> **Changed in 2.4.1.** `PATCH .../facts/:id` and chrono updates previously **replaced** the whole
> `properties` map, so a patch naming one key silently dropped the rest — while `update_fact`'s own schema
> described the field as "properties to merge". If you were relying on the replace to clear keys, switch to
> `deleteFields`.

### Updating by id: use PATCH

`PATCH` is the update verb for every brain record type, without exception. Posting to a record **id** is a
**404** for all four.

| type | update by id | POST-as-update |
|---|---|---|
| fact | `PATCH .../facts/:id` | **no** (404) |
| entity | `PATCH .../entities/:id` | no — but a collection POST with a matching `id` upserts |
| edge | `PATCH .../edges/:id` | no — a collection POST upserts on `(from, to, label)` |
| chrono | `PATCH .../chrono/:id` | **no** (404) — **removed in 3.0**, see below |

**`POST .../chrono/:id` was removed in 3.0.** It was the only POST-that-updates in the brain API, it
predated the retry-safety design and duplicated it, and it was documented as legacy and listed for removal
at the next major. **Send `PATCH .../chrono/:id` instead** — the body is the same shape.

If you make creates idempotent by retrying, that is unchanged and was never this route's job: a
client-supplied UUID v4 in the **collection** POST body converges on the same record, for every type (see
[Retry Safety](04-brain-api.md#retry-safety)).

**Two reasons it went rather than stayed**, both of which were true of it the whole time and are the reason
an integrator with nine flows on it asked for them to be written down here:

| | the removed `POST .../chrono/:id` | `PATCH .../chrono/:id` |
|---|---|---|
| property validation | **none** — the `type` allowlist was the whole of it, so under strict validation it could write a record the same space rejects at create time | full, the same as every other type |
| audit snapshot | **none** | stores before **and** after, so the change appears in the audit trail |

So a flow moved onto `PATCH` gains validation and an audit trail it did not have. If a record it used to
write is now refused, that record was always outside the space's schema — the legacy verb simply never
checked.

### Optimistic concurrency (`If-Match`)

Brain-record `PATCH`es are last-write-wins by default. Two clients that read the same record, edit the
**same field**, and both save produce one silent loser: their value disappears with a `200` and no trace.
(Editing *different* fields is safe — a `PATCH` only writes the fields you send, and the record's search
vector is rebuilt from the record as **stored**, so a concurrent edit to another field cannot leave the two
disagreeing.)

To make your write conditional, send back the `seq` you read as an `If-Match` header:

```http
PATCH /api/brain/spaces/research/entities/8f2c…
If-Match: 41
```

If that record's `seq` has moved, nothing is written and you get **412 Precondition Failed**:

```json
{
  "error": "This entity has changed since you read it. Re-read it and re-apply your change.",
  "currentSeq": 46
}
```

`currentSeq` is read at the moment of the failure, so it is the value to retry with. If it is **absent**,
the record was deleted rather than changed — the message says so.

Notes:

- **The header is optional.** Omit it and the write proceeds unconditionally, exactly as before. Every
  existing client and script is unaffected.
- **All four record types**, on the `PATCH` route: `facts`, `entities`, `edges`, `chrono`.
- **`seq` is on every record** and is returned by every read. Treat it as an **opaque token**: it is a
  per-space counter, not a per-record version, so consecutive writes to one record will not give you
  `1, 2, 3`. Echo back what you read and do not reason about the gaps.
- Bare (`41`), quoted (`"41"`) and weak (`W/"41"`) forms are all accepted, as is `*`, which asks only that
  the record still exist.
- **A value that is not a `seq` — `If-Match: abc` — is a `400`, never ignored.** Silently dropping an
  unparseable precondition would leave you believing your write was protected when it was not.
- **The check is part of the write**, not a read before it. There is no window between the two in which
  another writer can land.
- **The removed `POST .../chrono/:id` used to refuse the header with a `400`** rather than ignore it, for the same
  reason it refuses `suppressEmbeddings` — see the table above. Use `PATCH`.
- **MCP has no equivalent**, and this is a property of the transport rather than an oversight: MCP tools
  take arguments, not headers, so there is nothing for an `If-Match` to travel in. Agents that need a
  conditional write should use the REST route.
- **File-metadata records are not covered**, and say so: they carry no `seq` to condition a write on, so
  `PATCH /api/brain/spaces/:spaceId/files` **refuses** an `If-Match` with a `400` rather than accepting and
  dropping it. Its search vector is still rebuilt from the record as stored, through the same background
  queue as everything else, so a concurrent edit cannot leave the record and its vector disagreeing — you
  simply cannot make *this* write conditional.

The same header, in the same spellings, is honoured on space-meta writes against `meta.version` — see the
[Spaces API](06-spaces-api.md).

### What a read never sends, and what you can drop

**The embedding vector is never returned — by any endpoint, on either door, and there is no parameter that
asks for it.** `POST /query` merges a mandatory exclusion into whatever projection you send and strips an
explicit `"embedding": 1` out of it, so the vector cannot be opted back in; every read of a record collection
projects it out before the document leaves the database. If you have been hunting for a flag to switch it off,
this is why you could not find one.

> **This was FALSE for the list routes in 3.1.0 and every version before it.** A `?limit=500` read of the
> entities list returned every record's vector: an integrator measured **11.19 MB** where `POST /query`
> answered the same 100 records in **0.145 MB**. They found it by running out of memory rather than by
> reading a response — because this paragraph told them the field could not be there, which is why the
> correction is here and not only in the changelog. **On 3.1.0 or earlier, use `POST /query` with a
> projection for any bulk read.**

What you *can* control:

| lever | where | what it drops |
|---|---|---|
| `projection` | `POST /query`, **and recall / find-similar** | any field you do not name. On recall it applies recursively, so a `traverse` answer's `_graph` is projected at every depth |
| `includeFileContent: false` | recall, find-similar | file-passage **bodies**, keeping path, heading, chunk index, tags and properties |
| `includeDiagnostics: false` *(the default)* | recall, find-similar | `matchedText`, `embeddingModel` and `seq` — **recursively**, so a `traverse` answer's `_graph` follows it at every depth. **NOT the per-stage scores** — see below |
| `includeDiagnostics` *(body field, default off)* | `POST /filter` | `matchedText` and `embeddingModel`. **`seq` is NOT dropped here**, unlike on recall: it is the `If-Match` value, and withholding it would take away conditional writes. Send `includeDiagnostics: true` to get the two fields back. It was a query string on the per-collection list routes until 5.0, when those routes went |

A projection is worth reaching for rather than skipping: a bare query over a dozen records with full
descriptions and properties is the cheapest way to overrun a token budget, and naming the four fields you
actually branch on turns that into a page you can read.

**The per-stage scores always come back on both doors and no parameter removes them — they are the ORDERING.** See [the recall API page](04a-recall-api.md#the-per-stage-scores-are-the-ordering).
**REST and MCP return the same recall content.** Until 3.1.0 they did not: REST sent all six unconditionally
while MCP sent none. Now the three RECORD fields are off by default on both (`includeDiagnostics: true`
restores them) and the three SCORES are on by default on both — which MCP had never sent at all.

What still differs is the **shape**, deliberately, because each is natural to its transport: a REST result is
flat — record fields beside `score` — while an MCP result nests them under `record`. The *field set* a caller
can read is identical, at the result level and at every depth of `_graph`, and a gate compares the two.

**The asymmetry this paragraph used to describe is gone.** It said the per-collection list routes had no
field selection and were the only read that did not — true until 5.0 deleted them. Listing a collection is
`POST /filter` now, which takes `projection` like every other read, so there is one answer for every read on
this surface rather than one exception.

### Retiring a record from semantic search

`suppressEmbeddings` is a boolean on **all four** record types (`facts`, `entities`, `edges`,
`chrono`), settable on the `PATCH` route and on the matching MCP `update_*` tool:

```http
PATCH /api/brain/spaces/:spaceId/chrono/:id
{ "suppressEmbeddings": true }
```

> **Renamed in 3.1.0, and the old spelling was REMOVED in 4.0.** This field was
> `excludeFromVectorSearch` up to and including 3.0.1. Until 4.0 that name was still accepted on both
> doors and still written into the stored record, so a peer on an older build kept honouring it.
>
> **Both halves went at once.** Sending it is now a refusal rather than a silent acceptance, and it is no
> longer stored. Send `suppressEmbeddings`.
>
> What made the removal safe is the peer version floor: a 4.x instance refuses every 3.x peer, so no peer
> that fails to understand the current name can be on the network. Nothing needs migrating — every write
> since 3.1.0 has set the current name.
>
> The name changed because the old one described the wrong thing. "Excluded from vector search" reads as
> *removed from search*, which would include traversal — and it never did (see the table below). The two
> tiers underneath were already called `suppressEmbeddings`, so there is now one name to look for.

It **may be the only field in the request** — retiring a record is a complete edit, not a modifier on some
other change.

**It is implemented as the absence of a vector, not as a query-time filter.** Setting it enqueues an embed
job that unsets the embedding; clearing it enqueues one that computes a fresh embedding. The job handles both
directions, so the flag is enforced once in the store rather than remembered at every call site.

The consequence is worth stating plainly, because it is the reason to choose this over a filter of your own:

| reader | sees a suppressed record? |
|---|---|
| `recall`'s ranked results, `similar`, duplicate/contradiction scans | **no**, and there is no parameter that asks for it back |
| `GET`/`PATCH` by id, `query`, `list`, exports | **yes**, unchanged and complete |
| the `graph_traverse` tool | **yes** |
| **`recall(traverse: n)` — the graph expansion** | **yes** |

That last row is the one people ask about, so it is spelled out rather than folded into "traverse". Recall's
own expansion walks **edges** out of a match: it never consults a vector, so a suppressed record is reached
exactly as it always was and appears in `_graph` like any other neighbour.

**A record retired from ranking is therefore still findable through its relationships.** It stops competing on
meaning; it does not disappear from the graph. That is usually the point — a record that would otherwise crowd
recall stays reachable from the things that reference it.

So an audit that must include retired records has to be a **structured read**, not a recall. If you point a
semantic search at retired records today by applying a filter you control, the flag will not reproduce that
behaviour — it removes the vector the search ranks on, and the result is a quietly shorter answer with no
error. Nothing in the record's own data is lost.

#### One switch, three tiers, one name

`suppressEmbeddings` on a record is the **top tier of one mechanism**, and the space and its type schemas
carry the same setting under the same name. They resolve `record > schema > space` — the same order `ttlDays`
uses — and `brain/suppress-embeddings.ts` is the one place that resolves them:

| tier | where it lives | name |
|---|---|---|
| record | the record itself — **set it on the CREATE**, or later via `PATCH` / an MCP `update_*` tool | `suppressEmbeddings` |
| type | `typeSchemas.<kind>.<type>` on the space meta | `suppressEmbeddings` |
| space | space meta (the Danger Zone in the UI) | `suppressEmbeddings` |

**A create can state it, from 3.7.** Until then the field was accepted on update and silently dropped on
create, on all four record types — so a record that was never meant to be searchable had to be written twice:
once embedded, once to remove the vector, with a window between them where it WAS searchable. Reported from
outside on 2026-08-30 by an integrator writing a dedupe marker on every inbound message. Setting it on the
create now stores the flag, skips the vector, and **queues no embed job** — a queued job would have stored
what the flag forbids a few seconds later, with nothing to come back and remove it.

Both spellings are accepted on create, as they are on update.

Until 3.1.0 the record tier was spelled differently, so nothing in its name suggested the other two existed.
One name is the fix, and the consequence still holds: **a record with no vector and no `suppressEmbeddings`
of its own is not a bug** — read `GET /api/spaces/:id/meta` before treating it as one, because a tier below
is answering. Files have no type and therefore skip the middle tier entirely: a file is governed by the
record flag or the space setting.

> **`suppressEmbeddings: false` means *not stated*, not *do embed*.** It falls through to the tiers
> below instead of overriding them, so sending `false` **cannot** re-embed a record whose type or space
> suppresses embedding — the write succeeds, and nothing changes. On a record no other tier suppresses,
> `false` does restore the vector. To un-suppress a whole type or space, clear its `suppressEmbeddings` and
> then run [`POST /api/spaces/:id/reembed`](06-spaces-api.md#re-embed-backfill), because nothing backfills on
> its own.

### Partial Update with deleteFields

**All five** `PATCH` update endpoints — entities, edges, facts, chrono entries and file metadata — accept an optional `deleteFields` array of dot-notation paths. This allows callers to remove specific fields from a document in the same atomic operation as normal property/tag updates.

```http
PATCH /api/brain/spaces/:spaceId/entities/:id
PATCH /api/brain/spaces/:spaceId/edges/:id
PATCH /api/brain/spaces/:spaceId/facts/:id
PATCH /api/brain/spaces/:spaceId/chrono/:id
PATCH /api/brain/spaces/:spaceId/files?path=…
```

> **`properties` MERGE on all five as of 3.1, and file metadata is the one that CHANGED.** Until 3.1 the file
> route replaced the whole `properties` object, so patching a single key destroyed the rest — the same defect
> that had already been fixed on the other four. It now merges, and `deleteFields` arrived with it in the
> same release, because merging alone would have removed the only way to clear a file property.
>
> **A caller that resends the whole object is unaffected** — until 3.1 that was the only thing that worked.
> A caller that patches a single key now keeps what it did not name, instead of losing it.
>
> **The lists still replace on every type**: `tags`, `entityIds`, `memoryIds` and `chronoIds` are overwritten
> by what you send. Only `properties` merge. And **patching an edge's `label` changes its `_id`** — see the graph API page, which owns edge identity.
>
> **Also fixed in 4.0: `update_file_meta`'s published SCHEMA said the opposite of all of this.** Its
> `properties` description read *"REPLACES the whole properties object — keys you do not send are DELETED"*,
> which had not been true since 3.1. The tool's own prose said merge, the implementation merged, and only
> the schema — the thing an agent reads while constructing its arguments — disagreed.
>
> **And a file's property VALUES are now checked on all four of its doors.** `write_file` always refused a
> nested object or an array; `update_file_meta`, `PATCH .../files` and the upload did not — the upload
> silently discarded a malformed bag and answered `2xx`, so the file stored and its properties did not.

<!-- markdownlint-disable-next-line MD028 -->

> **Chrono gained this in 3.1, and until then nothing could be removed from a chrono entry at all.** Its
> `properties` merge and an absent field means "leave alone", so with no `deleteFields` there was no request
> that unset anything — a key written once was permanent. Entries created before 3.1 are unaffected; the
> paths simply work now.
>
> Chrono's **required** fields — `title`, `startsAt`, `status` — are refused by name, alongside the
> server-owned `id` / `type` / `spaceId` / `createdAt` / `updatedAt`. A path that cannot be honoured answers
> `400` naming it rather than being accepted and doing nothing, so a delete that silently misses is not a
> state this API can reach. A *property* of the same name (`properties.title`) is an ordinary user key and
> stays deletable.

**Example — delete a property key while adding a new one:**

```json
{
  "properties": { "newKey": "value" },
  "tags": ["current-tag"],
  "deleteFields": [
    "properties.oldKey",
    "properties.anotherStaleKey",
    "description"
  ]
}
```

**Path semantics:**

| Path | Effect |
|------|--------|
| `"properties.oldKey"` | Deletes that key from the `properties` map |
| `"description"` | Deletes the top-level `description` field |
| `"properties"` | Deletes the entire `properties` map (only if the space schema allows it) |
| `"weight"` | Deletes the `weight` field (edges only) |
| `"properties.items.*.stale"` | Wildcard: deletes `stale` from every object inside the `items` array |

**Rules:**

- `deleteFields` is applied **after** the normal merge — so you can add new properties and delete stale ones in the same request.
- **Naming the same field in both halves is allowed, and the deletion wins.** `{"tags": ["a"], "deleteFields": ["tags"]}` stores no tags, because the delete is the later instruction. This follows from the rule above rather than being a separate one, but it is the case worth stating: it used to be rejected.
- Paths targeting non-existent keys are silently ignored (no error).
- System fields (`id`, `_id`, `name`, `type`, `spaceId`, `createdAt`, `updatedAt`) **cannot** be deleted. Attempting to do so returns `400`.
- Paths with empty segments (e.g. `"properties..key"`) are rejected with `400`.
- If the result after `deleteFields` + merge violates a `required: true` property schema in `typeSchemas` (with `validationMode: "strict"`), the request is rejected with `422` listing the missing required keys. No partial mutation occurs.
- `deleteFields` can be the **only** parameter in the request body (no other updates needed).
- Omitting `deleteFields` retains the existing merge behaviour — no breaking change for existing clients.
- **Re-embedding:** deleting any content field (`properties`, `description`, `tags`, `fact`, `entityIds`) triggers re-embedding of the affected document. Bulk `deleteFields` updates may incur embedding service latency.

**Response** — same shape as a normal `PATCH` update (`200` with the updated document).

**Error responses:**

| Status | Condition |
|--------|-----------|
| `400` | `deleteFields` is not an array of strings, contains empty strings, or targets a system field |
| `422` | Post-deletion state violates a `required: true` property schema in strict validation mode |

> **⚠️ Warning:** Fields deleted via `deleteFields` are **permanently removed**. Recovery requires audit logs or a backup. The explicit path list design is intentional — accidental data loss requires consciously naming each field to remove.

**MCP tools:** all five — `update_fact`, `update_entity`, `update_edge`, `update_chrono` and
`update_file_meta` — accept a `deleteFields` array with the same semantics. This named three, which read
as a deliberate parity gap against the five REST endpoints listed below. There is none.
