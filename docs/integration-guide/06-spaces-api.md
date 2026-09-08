# Spaces API

> Part of the [Ythril Integration Guide](../integration-guide.md).

## Spaces API

Base path: `/api/spaces`

### List Spaces

```http
GET /api/spaces
GET /api/spaces?counts=true
```

Returns spaces accessible to the requesting token. Tokens with a `spaces`
scope restriction only receive spaces in their allowlist; full-access tokens
receive all spaces.

Add `?counts=true` to include per-space document counts (memories, entities,
edges, chrono). Useful for agents deciding which spaces are populated and
worth querying.

**Response** `200`:

```json
{
  "spaces": [
    {
      "id": "general",
      "label": "General",
      "builtIn": true,
      "description": "Default workspace space.",
      "counts": { "memories": 42, "entities": 10, "edges": 5, "chrono": 3 },
      "usageGiB": 0.05
    }
  ],
  "docExtractionCeiling": "auto",
  "storage": {
    "usageGiB": { "files": 0.02, "brain": 0.03, "total": 0.05 },
    "limits": { "totalLimitGiB": 200, "warnAtPercent": 80 }
  }
}
```

> **Note:** `counts` fields are only present when `?counts=true` is passed. `storage.usageGiB` is the instance total (files + brain), and `storage.limits` echoes the configured quota (`totalLimitGiB`, `warnAtPercent`); each space object also carries its own `usageGiB` number. `docExtractionCeiling` is the instance document-extraction ceiling (`off` / `ocr` / `vlm` / `repair` / `auto`) — the highest mode any space may pick; the admin UI uses it to constrain each space's extraction dropdown.

#### `usageGiB` can be a FLOOR, and `usageIncomplete` is how you know

A directory the instance cannot read contributes nothing to the figure. That used to be indistinguishable from
an empty space — both report `0` — so a quota being approached could read as 0% used, and a hard limit compared
against a floor never fires.

**`usageIncomplete` is present only when the number is a lower bound**, and it names what could not be read.

**Response** (trimmed to the storage fields):

```json
{
  "spaces": [
    { "id": "general", "usageGiB": 0.05, "usageIncomplete": ["3 path(s) unreadable, first: /data/files/general/x: EACCES"] }
  ],
  "storage": {
    "usageGiB": { "files": 0.02, "brain": 0.0, "total": 0.02 },
    "usageIncomplete": { "files": [], "brain": ["dbStats: not authorized on ythril to execute command"] }
  }
}
```

- **Per space** it is a flat list of strings; **instance-wide** it is split by area (`files`, `brain`), because
  the two halves fail for unrelated reasons an operator acts on differently — a filesystem permission versus a
  database grant.
- An **absent** field means the measurement was whole. A caller that ignores the field is never misled about a
  healthy space, only about an unreadable one, which is why it is a field rather than a flag on every response.
- An **absent files directory is not incompleteness**: a space that has never held a file uses no files, and
  reporting that as unmeasurable would put every fresh instance permanently in the degraded state.
- The instance also publishes `ythril_storage_usage_complete{area}` for alerting — see the metrics table in
  `11-setup-api.md`.

**On MCP, `list_spaces` reports the same three fields** — `maxGiB`, `usageGiB` and `usageIncomplete` — from the
same measurement. It previously returned counts only while `help()` told callers to look there for storage.

---

### Create a Space

**Admin only** — `POST /api/spaces` requires an admin token (and a valid `X-TOTP-Code` when MFA is enabled); it is `requireAdminMfa`-gated. A non-admin token gets `403`.

```http
POST /api/spaces
Authorization: Bearer <admin-token>
```

```json
{
  "id": "research",
  "label": "Research Notes",
  "description": "Papers, notes, and findings from the AI research team.",
  "folders": ["papers", "notes"],
  "maxGiB": 2
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `id` | no | Lowercase `^[a-z0-9-]+$`, max 40 chars. Auto-generated if omitted. |
| `label` | yes | Human-readable display name, max 200 chars. |
| `folders` | no | Pre-create these directories on disk at space creation time. |
| `maxGiB` | no | Maximum storage quota for the space (positive number in GiB). |
| `faceDescriptorDims` | no | Width of this space's face descriptors (integer, 64–4096, default 128). Changeable later **only while the space has never held a face descriptor** — see below. |

**`faceDescriptorDims` is refused by the space's STATE, not by the surface you ask on.** The space's face
gallery stores vectors at this width and nothing re-derives them, so re-dimensioning the index under stored
vectors would leave them indexed as a different size — every similarity score wrong, with no error reported
anywhere. That is what the rule protects, and it is why the rule is about vectors rather than about time.

So `PATCH /api/spaces/:id` and the `update_space` MCP tool both **accept** the field, and answer **409** in
exactly two states, each naming the number it found:

| State | Refusal |
| --- | --- |
| The space holds face descriptors | It says how many, and at what width |
| Its face index is built at a different width | It says which width the index is at |

On a space that has never held a face descriptor it succeeds. Sending the width the space already has is
always accepted and changes nothing, so a client re-sending its whole config can still save an unrelated
edit. To move a POPULATED gallery there is still no path: create a new space at the new width and
re-process its images.

Setting it at creation remains the reliable route, because it is the only one that cannot be refused.

Use it when you point `faceRecognition.externalModel` at a recogniser that does not emit 128 dimensions —
most current open models emit 512.

**Response** `201`: the created space object, wrapped in a `space` field:

```json
{ "space": { "id": "research", "label": "Research Notes", "indexStatus": "building" } }
```

> **Async vector-index build:** creating a real space returns immediately with `indexStatus: "building"`. The space is writable straight away, but semantic `recall` returns no results until the Atlas vector indexes finish building and `indexStatus` flips to `"ready"` (this can take up to a few minutes; a failed build reports `"failed"`). Poll the space via `GET /api/spaces` if you need to gate recall on readiness. Proxy spaces and spaces created before this behaviour have no `indexStatus` and should be treated as ready.

---

### Create a Proxy Space

A proxy space is a virtual space that groups multiple real spaces into a single endpoint. Reads aggregate across all member spaces; writes require a `targetSpace` parameter to specify the destination.

```http
POST /api/spaces
```

```json
{
  "id": "all-research",
  "label": "All Research",
  "description": "Aggregated view of biology and physics research spaces.",
  "proxyFor": ["bio-research", "physics-research"]
}
```

**Rules:**

- All `proxyFor` members must be existing real spaces (not proxies — nesting is not allowed).
- Proxy spaces are virtual: no DB collections or file directories are created.
- Creating the proxy is admin-gated (like any space creation); the create call validates only that each member exists and is not itself a proxy — it does **not** separately check the caller's space allowlist. (Per-space access is enforced at read/write time on the proxy's member spaces.)
- The single-element wildcard `"proxyFor": ["*"]` creates an **all-spaces** proxy: it aggregates over every real space the caller can access (resolved dynamically), skipping per-member validation. The wildcard cannot be mixed with explicit member IDs.

**Read operations** (GET memories, entities, edges, files, recall, query) aggregate results across all member spaces transparently.

**Write operations** (POST memories, write_file, upsert_entity, etc.) require a `targetSpace` query parameter:

```http
POST /api/brain/spaces/all-research/memories?targetSpace=bio-research
```

```json
{ "fact": "CRISPR efficiency improved by 40% with new guide RNA design." }
```

The `targetSpace` must be one of the proxy's `proxyFor` members. Omitting it on a write returns `400`.

**MCP**: When connected via MCP to a proxy space, read tools (`recall`, `query`, `read_file`, `list_dir`) aggregate automatically. Write tools (`remember`, `upsert_entity`, `write_file`, etc.) accept an optional `targetSpace` argument — required when the MCP endpoint is a proxy space.

---

### Rename a Space

```http
PATCH /api/spaces/:id/rename
Content-Type: application/json
Authorization: Bearer <admin-token>

{ "newId": "new-space-name" }
```

`newId` must be lowercase alphanumeric + hyphens, 1-40 chars (`/^[a-z0-9-]+$/`).

The rename atomically:

- Moves all MongoDB collections (memories, entities, edges, chrono, tombstones, files, etc.) to the new prefix.
- Moves the file directory from `/data/files/{old}` to `/data/files/{new}`.
- Updates all network `spaces[]` arrays and adds a `spaceMap` entry so peers continue syncing.
- Updates all token `spaces[]` scopes that referenced the old ID.

**Response** `200`:

```json
{ "space": { "id": "new-space-name", "label": "My Space", ... } }
```

| Status | Meaning |
|--------|---------|
| `400`  | Invalid `newId` format, or trying to rename a built-in space (e.g. `general`) |
| `404`  | Source space does not exist |
| `409`  | `newId` already exists |
| `500`  | Partial rename failure (collections may be in an inconsistent state) |

---

### Re-embed backfill

```http
POST /api/spaces/:id/reembed
Authorization: Bearer <token with knowledge:admin on the space>
```

Queues an embedding job for every record in the space that **has no vector**. This is the way back from
`suppressEmbeddings`: suppression leaves records unembedded, and nothing revisits them on its own, so recall stays
blind to whatever was written while it was on.

It is also the repair for an embedding that never got queued — an enqueue failure is deliberately swallowed rather
than failing the write, which leaves exactly this state.

**Body — all fields optional.** An empty body sweeps every record kind at the default limit.

| Field | Description |
|-------|-------------|
| `kinds` | Narrow the sweep: any of `memory`, `entity`, `edge`, `chrono`, `file`. Omitted means all five. |
| `limit` | Maximum records to queue in one call. Default 5000, maximum 50000. |

An unknown field is a `400` rather than being ignored — a caller who meant to narrow the sweep and silently got
all of it would be worse off than one who got an error.

**Response** `200`:

```json
{
  "spaceId": "research",
  "enqueued": 1284,
  "skippedSuppressed": 0,
  "byKind": { "memory": 900, "entity": 384 },
  "remaining": 0,
  "truncated": false
}
```

| Field | Meaning |
|-------|---------|
| `enqueued` | Records a job was queued for. Embedding happens in the background afterwards. |
| `skippedSuppressed` | Candidates skipped because suppression **still applies**. See the note below. |
| `byKind` | Where the gap was, per record kind. |
| `remaining` | Candidates left after `limit` **that can actually be embedded**. Counted over the whole space, not over this page. Suppressed records are never counted here — see the note below. |
| `truncated` | `true` when `remaining > 0` — call again to continue. |

> **Turn suppression off first.** A record that is still suppressed at any tier is skipped, so that a backfill
> cannot re-index what an operator asked to keep out of recall. Running this while suppression is on is not an
> error: every candidate comes back under `skippedSuppressed`, which tells you the setting is still on.

**It queues rather than embeds.** A large space would time out mid-way through inline embedding, having done
partial work with no record of where it stopped. Queuing is idempotent per record, so repeating the call over the
same space converges instead of duplicating work.

**Nothing is truncated silently** — when more candidates remain than `limit` allowed, `remaining` says how many.

**`remaining` counts only work that can be done, and that distinction is load-bearing.** Suppression is applied
in the query, so a suppressed record never reaches `remaining`; it is reported under `skippedSuppressed` instead.
A space whose suppression is still on therefore answers `remaining: 0`, `truncated: false` — *there is no work*,
which is a different statement from *there is work left* and the one you can act on.

> **Fixed in 2.6.1.** Before that, `remaining` counted every record without a vector, suppressed ones included,
> and the candidate query had no sort. So a page of suppressed records at the front of a collection came back
> unchanged on every call, blocked every embeddable record behind it, and `truncated: true` said "call again to
> continue" — a loop that could not converge. If you scripted against `truncated`, it terminates now.

---

### Update a Space

```http
PATCH /api/spaces/:id
```

Update space properties. Requires an admin token (+ TOTP if MFA is enabled). At least one of `label`, `description`, or `meta` must be provided.

> **A SPACE ADMINISTRATOR reaches this route too, for its own space.** A token holding the `admin` rung on all
> four areas (`knowledge`, `files`, `schema`, `dataQuality`) of space X administers X, and may change X's
> settings without being an instance admin. Administering X grants nothing on space Y: the check is against the
> space id in the URL, not against "administers something".
>
> **`maxGiB` is the exception and answers `403`.** It is that space's share of the *host's* disk, so it is the
> instance's to give. Every other field in the body is accepted. The refusal names who can change it, so the
> right escalation is obvious rather than guessed.
>
> The same admission applies to `PATCH :id/rename` — a space's own configuration. It does **not** apply to
> `POST /api/spaces` (create), `POST /api/spaces/reorder`, or `DELETE /api/spaces/:id`: those are
> instance-shaped, and destroying a space is not one of its settings.
>
> **And `PATCH :id` itself is now governed FIELD BY FIELD**, since 4.4. See the table below: a `files`
> writer can set a media level without being handed the whole space, and `maxGiB` still needs the instance
> administrator. A body mixing a field you may set with one you may not is refused WHOLE, with every
> refused field named — a half-applied settings save is worse than a refused one.
>
> **The other five routes this note used to list have moved DOWN rather than out**, in 4.4: `PUT :id/schema`,
> the single-type `PUT`/`DELETE` on `:id/meta/typeSchemas/...`, `POST :id/validate-schema` and
> `POST :id/rebuild-indexes` are now guarded at the area rung they advertise. A space administrator holds
> `admin` on all four areas, so every one of them still admits the same people — through the rung instead of
> through a separate check, which is what makes the rights panel's rows true.
>
> MFA is unchanged. A space administrator is still a human with an authenticator, and exempting one would make
> the role a way around an instance-wide second factor.

#### What each field in the update body requires

Every field answers to the area that owns it rather than to the route. A token needs **one** of: the
instance administrator, the space's administrator (`admin` on all four areas), or the rung named here on
that space.

| field | requires |
|---|---|
| `label`, `meta.purpose`, `meta.usageNotes` | space administrator — the space's own description of itself, which no data area owns |
| `maxGiB` | **instance administrator** — it is the space's share of the host's disk, not a setting of the space |
| `faceDescriptorDims` | `files` **admin** — changing the width invalidates every stored face descriptor |
| `documentExtraction`, `imageAnalysis`, `audioAnalysis`, `videoAnalysis`, `textAnalysis` | `files` write |
| `meta.typeSchemas`, `typeSchemasMode`, `meta.whenDuePasses` | `schema` write |
| `meta.validationMode`, `meta.strictLinkage` | `schema` **admin** — enforcement: flipping either makes writes that used to succeed start failing |
| `meta.suppressEmbeddings` | `knowledge` **admin** — recall silently stops finding anything written afterwards |
| `recordTtlDays` | `knowledge` **admin** — it deletes records on a clock |
| `completeLinkage` | `knowledge` **admin** — the six legacy array fields start refusing writes for everyone in the space |
| `dupeRules`, `dupeMergeSurvivor` | `dataQuality` write |
| `dupeRulesOnInsert` | `dataQuality` **admin** — merges then happen ON WRITE, without anyone looking |

A refusal is a `403` naming each field and its requirement, so one save produces one conversation with
whoever grants rights rather than one per field.

**Optimistic concurrency (`If-Match`).** Meta writes are last-write-wins by default: if two clients read a space, both edit it, and both save, the second save replaces the first in full. To make your write conditional, send the `meta.version` you read as an `If-Match` header:

```http
PATCH /api/spaces/research
If-Match: 7
```

If the space's `meta.version` is no longer 7, the request is rejected with **412 Precondition Failed** and a body naming both versions — re-read the space, re-apply your change, and retry:

```json
{
  "error": "Space meta has changed since you read it (you expected version 7, it is now 9). Re-read the space and re-apply your change.",
  "expectedVersion": 7,
  "currentVersion": 9
}
```

Notes:

- **The header is optional.** Omit it and the write proceeds unconditionally, exactly as before — existing clients are unaffected.
- `meta.version` is returned by `GET /api/spaces`. A space that has never had meta written is version `0`, so `If-Match: 0` means "only if nobody has configured this yet".
- Bare (`7`), quoted (`"7"`) and weak (`W/"7"`) forms are all accepted, as is `*` (matches any existing space).
- A value that is not a version — `If-Match: abc` — is rejected with **400**, never ignored. Silently ignoring an unparseable precondition would give you the false impression that your write was protected.
- The same header is honoured by **every route that writes space meta**: `PUT /api/spaces/:id/schema` (checked before that route writes its schema backup file), and the single-type `PUT` and `DELETE` on `/api/spaces/:id/meta/typeSchemas/:knowledgeType/:typeName`.

**Read-modify-write needs no stripping step.** `GET /api/spaces/:id/meta` returns the meta fields alongside
`version` and `updatedAt`, which the server owns and you cannot set. `PATCH` **ignores** those (and
`previousVersions`) rather than rejecting the request, so you can send back what you read:

```http
GET  /api/spaces/research/meta      →  { "spaceId": "research", "spaceName": "Research",
                                          "purpose": "...", "typeSchemas": { ... },
                                          "version": 7, "updatedAt": "...", "stats": { ... } }

PATCH /api/spaces/research          →  { "meta": { "purpose": "...", "typeSchemas": { ... },
                                                   "version": 7, "updatedAt": "..." } }   ✅ accepted
```

Ignoring is not accepting: the version the `If-Match` check reads cannot be written from a request body, and
the server still bumps it.

**Two things `meta` still rejects with a `400`, both deliberately:**

- **The response envelope.** `spaceId`, `spaceName` and `stats` are the shape of the `GET`, not part of `meta`.
  Posting the whole response body as `meta` is a real mistake and you should hear about it.
- **Any other unknown key.** A typo like `validationMdoe` must not be silently ignored — you would come away
  believing you had turned validation on. The tolerance covers only the fields that genuinely belong to `meta`
  and that we ourselves emit.

#### The same rule now applies at the TOP level of every space body

Until 3.1 the rule above stopped at `meta`. The outer body dropped anything it did not recognise, so one
misspelling got two different answers depending on how deep it sat:

```http
PATCH /api/spaces/research   { "meta": { "validationMdoe": "strict" } }   →  400  refused
PATCH /api/spaces/research   { "label": "x", "validaitonMode": "strict" } →  200  label applied, typo gone
```

**This is a breaking change.** A request carrying a field the API ignores now returns `400` naming the key,
where it used to return `200`. If you have been sending one, you will hear about it on the first call rather
than discovering later that a setting never took effect — which is what a misspelt `faceDescriptorDims` did:
it created a space at the default descriptor width and reported `201`.

**Round-tripping still works.** The fields a listing emits that a `PATCH` does not accept — `id`, `builtIn`,
`folders`, `usageGiB`, `indexStatus`, `proxyFor`, `networks` — are stripped before validation, the same way
`version` / `updatedAt` / `previousVersions` / `needsReindex` already were inside `meta`. So taking a space
out of the list, editing one field and writing the whole object back is still the supported pattern:

```http
GET   /api/spaces            →  { "spaces": [ { "id": "research", "label": "Research",
                                                "builtIn": false, "folders": [], "usageGiB": 0.4,
                                                "indexStatus": "ready", "meta": { ... } } ] }

PATCH /api/spaces/research   ←  that entry, unchanged except "label"                        ✅ accepted
```

Only fields we ourselves emit are dropped. Anything else is a typo, and a typo is refused.

A single space has no endpoint of its own: read it from the listing above, or read its metadata from
`GET /api/spaces/:id/meta`.

**Removing a type schema.** `PATCH` deep-merges by default, so omitting a type does not delete it — a merge that could delete would make every PATCH potentially destructive, and a client that round-trips a space would silently drop schemas whenever its serialiser emitted `null` for an unset field. There are three ways to delete:

- `DELETE /api/spaces/:id/meta/typeSchemas/:knowledgeType/:typeName` for one type (404 if it does not exist).
- `PUT /api/spaces/:id/schema` to replace the whole map. It writes a timestamped backup of the previous schema into the space first. Note it applies **directly**, so on a networked space it does not open a vote round — use the PATCH form below if the change should go to consensus.
- `PATCH /api/spaces/:id` with `"typeSchemasMode": "replace"` alongside `meta.typeSchemas`. The payload becomes authoritative: types absent from it are removed. This is the same request as any other meta change, so it takes the same network-vote path.

```jsonc
// Authoritative: the space ends up declaring exactly `flow`, and nothing else of any kind.
PATCH /api/spaces/flows
{ "typeSchemasMode": "replace",
  "meta": { "typeSchemas": { "entity": { "flow": { "namingPattern": "^f-" } },
                             "memory": {}, "edge": {}, "chrono": {} } } }
```

**A regex that cannot be evaluated is refused here, with a `400` naming the construct.** `namingPattern` and
`propertySchemas.*.pattern` are both checked when the schema is saved: a quantified group containing a
quantifier — `^D[0-9]+:[0-9]+(,D[0-9]+:[0-9]+)*$`, the ordinary way to write "a comma-separated list of
these" — can backtrack exponentially, so the server will not run it against a value. Rewrite it without the
group; a character class usually does the same job (`^D[0-9]+:[0-9,:D]*$`).

The refusal is at save time because the alternative is worse and used to be the behaviour: the pattern was
stored, never applied, and every write of that type was rejected with `does not match pattern` — naming the
caller's value for a check that never ran. A pattern stored before this now reports `pattern not evaluated,
so nothing was checked`, which points at the schema instead.

`typeSchemasMode` defaults to `merge`, which is the behaviour this endpoint has always had. Under `replace`, a knowledge type sent as `{}` clears it, and omitting a knowledge type entirely also clears it — so send all four keys unless you mean to empty the ones you leave out. Omitting `meta.typeSchemas` altogether still changes nothing, in either mode; `replace` says how to apply schemas that are present, not that absent ones should be erased.

```json
{
  "label": "Research Notes (Updated)",
  "description": "Updated description surfaced to MCP clients as space-level instructions.",
  "meta": {
    "purpose": "Team engineering knowledge base.",
    "validationMode": "strict",
    "typeSchemas": {
      "entity": {
        "service": {
          "namingPattern": "^[a-z][a-z0-9-]{1,60}$",
          "propertySchemas": {
            "status": { "type": "string", "enum": ["active", "deprecated", "planned"], "required": true },
            "score":  { "type": "number", "minimum": 0, "maximum": 100, "mergeFn": "avg" }
          }
        },
        "team": {},
        "technology": {},
        "concept": {}
      },
      "edge": {
        "depends_on": {},
        "owns": {},
        "related_to": {}
      },
      "memory": {
        "default": {
          "propertySchemas": {
            "count": { "type": "number", "mergeFn": "sum" }
          }
        }
      }
    },
    "strictLinkage": true
  }
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `label` | no | New display name, max 200 chars. |
| `meta` | no | Space schema definition (see [Schema Validation](06a-schema-api.md#schema-validation) below). |

**Response** `200`: the updated space object.

If the space participates in a network and `meta` is included, the update triggers a governance vote and returns `202`:

```json
{ "status": "vote_pending", "rounds": [...], "message": "Meta change requires network vote" }
```

**Two meta votes can be open at once, and they no longer overwrite each other.** A round records the
fields it proposes and the `meta.version` it was computed against; when it passes, only those fields are
applied, re-merged into whatever the meta says at that moment. Rounds stay open for
`votingDeadlineHours`, so a second proposal landing before the first concludes is ordinary — previously
the later round wrote back a full snapshot taken when it opened, silently reverting the earlier one's
edit with a correctly-recorded carried vote to hide it.

When two rounds change the **same** field the later one to conclude wins: the network voted for that
value, and refusing to apply a carried motion would relocate the silent loss rather than remove it. The
overwrite is written to the server log naming the field, the round's base version and the current one, so
the superseded operator can find out.

A round proposed by a peer running an older build carries neither field and is applied wholesale, exactly
as before — its proposer computed the snapshot as the complete intended result, so field-merging an
unknown changed-set would apply nothing at all.

> **MCP tool:** `update_space` — accepts `label` and `purpose`. Requires `admin: true`.

---

### Get Space Meta

```http
GET /api/spaces/:id/meta
Authorization: Bearer <token>
```

Returns the full schema definition for a space along with derived stats.

**Requires the token to be scoped to that space.** A token whose `spaces` allowlist excludes the space is refused with
`403` — as are `GET /api/spaces/:id/completeness` and the single-type
`GET /api/spaces/:id/meta/typeSchemas/:knowledgeType/:typeName`. Before 2.8.0 these three answered `200` for any
authenticated token, which is a fixed defect rather than a behaviour to rely on: a space's `purpose`, `usageNotes` and
type schemas are readable only by tokens that may reach the space.

> **A bare space id — `/api/spaces/<id>` with no sub-path — is not an endpoint.** It answers
> `404 {"error":"Not found"}`, the generic API catch-all, for **every** id, whether or not your token may reach it. So
> that status carries no information about permission and must not be branched on. Use the `/meta` route above
> instead: it answers `403` when scope refuses and `404 {"error":"Space 'x' not found"}` when the space genuinely does
> not exist, and the two bodies are how you tell them apart.

**Response** `200`:

```json
{
  "spaceId": "eng-kb",
  "spaceName": "Engineering Knowledge Base",
  "purpose": "Team engineering knowledge base.",
  "usageNotes": "Markdown-formatted usage guidance for the web UI.",
  "validationMode": "strict",
  "typeSchemas": {
    "entity": {
      "service": {
        "namingPattern": "^[a-z][a-z0-9-]{1,60}$",
        "propertySchemas": {
          "status": { "type": "string", "enum": ["active", "deprecated"], "required": true }
        }
      },
      "team": {}
    },
    "edge": {
      "depends_on": {},
      "owns": {}
    }
  },
  "stats": { "memories": 142, "entities": 53, "edges": 87, "chrono": 12, "files": 31 },
  "needsReindex": false
}
```

`needsReindex` is `true` when the space holds embeddings from a different model than the one configured — the
state `POST /reindex` clears. On a **proxy space** it is `true` when **any** member needs one, matching
[`GET /reindex-status`](04d-brain-ops-api.md).

It is here because `reindex` returns as soon as the job *starts*: this is the field you poll to learn it
finished. The dedicated `GET /api/brain/spaces/:spaceId/reindex-status` route still exists and is unchanged.

> **MCP tool:** `get_space_meta` — returns the same information, `needsReindex` included. Available to all
> tokens (not admin-only). Before this field existed, the `reindex` tool's own description told MCP callers to
> poll the REST status route — which a client with no HTTP door cannot do.

---

### Get Space Completeness

*New in 2.1.*

```http
GET /api/spaces/:id/completeness
Authorization: Bearer <token>
```

How much of what the space *declared* it would hold, it actually holds. A space is "set up" long before
it is usable: schemas declare types nothing instantiates and properties nothing fills, entities pile up
with no edges between them, files land that recall cannot see. None of that errors.

Separate from `/meta` on purpose — that endpoint is read on every schema edit and stays cheap, while this
one walks the collections. Read-only; the Brain's Overview panel is its main consumer.

**Response** `200`:

```json
{
  "spaceId": "eng-kb",
  "score": 74,
  "truncated": false,
  "checks": [
    {
      "id": "file-not-recallable",
      "severity": "warn",
      "scope": "file",
      "affected": 3,
      "total": 31,
      "weight": 3,
      "earned": 2.7096774193548385,
      "sample": ["contracts/2024-addendum.pdf", "scans/plan-b.tiff"],
      "targetTab": "files"
    },
    {
      "id": "declared-type-unused",
      "severity": "info",
      "scope": "edge",
      "affected": 1,
      "total": 2,
      "weight": 1,
      "earned": 0.5,
      "sample": ["owns"],
      "targetTab": "edges"
    }
  ]
}
```

**The checks are the primitive; `score` is their weighted roll-up.** A percentage nobody can decompose is
a number nobody can act on, so every point lost belongs to a named check with a sample and a destination.

| Field | Meaning |
|---|---|
| `score` | `0`–`100`, the weighted roll-up of `earned / weight` across `checks`. `null` only when no check applied at all. |
| `checks` | **Only checks that applied.** A check with no denominator is absent, not present with `total: 0` — a question this space cannot be asked is not one it failed. |
| `id` | Which check. A check id appears **once per knowledge kind** — an unused entity type and an unused edge label are different findings. |
| `severity` | `warn` = records are already wrong or invisible. `info` = the space is thinner than it declared. |
| `scope` | `entity` / `memory` / `edge` / `chrono` / `file`, or `space` for a finding about the space itself. |
| `affected` / `total` | How many of the checked things are wrong, out of how many were checked. |
| `weight` / `earned` | The check's contribution to the score, and how much of it this space kept. Credit is proportional: 1 unlinked entity in 40 does not score like 40 in 40. |
| `sample` | At most 5 identifiers — type names, `type.property` keys, or record ids/paths. |
| `targetTab` | The Brain tab holding the affected records, or `null` for a `space`-scoped finding. |
| `truncated` | `true` when a type declared more than 50 properties and the tail was not examined. Surfaced rather than silently dropped. |

**The checks:**

| `id` | What it finds |
|---|---|
| `declared-type-unused` | A key in `typeSchemas.<kind>` with no matching records — the schema describes an intention, not the contents. |
| `undeclared-type-in-use` | Records whose `type` (or edge `label`) is absent from a **non-empty** allowlist — exactly what `validationMode: "strict"` would now reject. An empty allowlist accepts everything, so it is not checked at all. Untyped records are out of scope: validation only fires on a value that is present and unknown. |
| `declared-property-never-filled` | A `propertySchemas` key no record of that type carries. Presence on *any* record clears it — this is not a fill-rate measure. |
| `entity-without-edges` | Entities with no inbound or outbound edge. An entity graph with no edges is a list. |
| `file-not-recallable` | File records that are neither embedded themselves nor chunked by the conversion pipeline — recall cannot reach them in any form. |
| `meta-purpose-missing` | `meta.purpose` is unset, so MCP clients get no directive at handshake. |
| `schemas-declared-but-unenforced` | `typeSchemas` is non-empty while `validationMode` is `off`. |

For a proxy space, the checks aggregate across every member space, the same as `/meta`'s counts.
