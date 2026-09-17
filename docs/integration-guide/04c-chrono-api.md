# Chrono

> Part of the [Ythril Integration Guide](../integration-guide.md).

## Chrono

### Create a Chrono Entry

```http
POST /api/brain/spaces/:spaceId/chrono
```

**Body**:

`id` is optional here too — a **UUID v4** naming an **existing** entry to update, exactly as for a
fact. See [Retry Safety](04-brain-api.md#retry-safety).

```json
{
  "title": "Release v1.0",
  "type": "milestone",
  "startsAt": "2026-06-01T00:00:00Z",
  "description": "First public release",
  "status": "upcoming",
  "confidence": 0.9,
  "tags": ["release"],
  "entityIds": [],
  "memoryIds": []
}
```

- `type` — `event`, `deadline`, `plan`, `prediction`, `milestone` **unless the space declares its own chrono
  types**, in which case those **replace** this list rather than extending it. A space with
  `typeSchemas.chrono` set accepts its declared type names and **rejects all five built-ins**; a write with a
  type outside the space's list returns `400` naming the ones it will accept
  (`` `type` must be one of: … ``). Read the current list from `typeSchemas.chrono` in
  `GET /api/spaces/:id/meta` before offering a choice.
- `status` — `upcoming` (default), `active`, `completed`, `overdue`, `cancelled`.

  **What a passed due moment MEANS is the type's to decide, and by default it means late.** With no setting,
  an entry whose due moment (`endsAt`, or `startsAt` if it has none) has passed and that is not
  `completed`/`cancelled` is returned as `overdue` — **derived on read**, so you never need to set it
  yourself.

  **WHICH DOOR YOU READ THROUGH USED TO DECIDE WHICH STATUS YOU GOT, and since 5.0 it is a parameter.**
  The chrono list route derives; `filter` and sync return the value the collection HOLDS — both are
  correct, and a predicate read must see the stored one or it cannot be used to repair anything. What
  was wrong is that the two were indistinguishable from outside. Reported in substance by the canary
  operator, 2026-09-15, after a fortnight-old episode read `active` through one door and `overdue`
  through the other: *"'I checked the status' is not a claim anyone can evaluate without the door being
  named"* — every attempt they made to confirm the suspicion queried the collection, got `active`, and
  read as a clean bill of health.

  | where | what `status` means |
  |---|---|
  | `GET .../chrono` (the list route) | DERIVED, always |
  | `filter` / `POST /api/brain/filter` | STORED, unless you send `deriveStatus: true` |
  | sync | STORED, always — a peer must replicate what was written, not a reading of it |

  `deriveStatus` defaults **false** on both doors, so nothing an existing caller does changes. Sending it
  on any collection but `chrono` is refused rather than ignored: a silently dropped flag is a caller who
  believes they asked for something.

  **And it degrades rather than breaking**, which is why nobody catches it in review. A record read
  shortly after it is written still says `active`, so code built against the stored literal demonstrably
  works the day it ships and starts failing only as records outlive their due moment. Theirs presented
  as a change in alert volume.

  **Turn it off for a type whose records are events rather than deadlines.** Set `whenDuePasses: "nothing"`
  on a chrono type in `typeSchemas.chrono`, or on the space's `meta` to cover every type that says nothing,
  and those records return the status you STORED. For entries recording something that happened — a deploy,
  a backup run, an alert episode — a past date is the normal condition and does not mean late. *New in 4.3.*

  | `whenDuePasses` | what a past due moment does |
  |---|---|
  | absent | the default: reads as `overdue` |
  | `"overdue"` | the same, stated explicitly |
  | `"nothing"` | nothing — the stored status is returned |

  Resolution is **schema > space**, matching `retention` and `suppressEmbeddings`. There is no per-record
  override: the meaning of a past date belongs to the kind of thing, not to one instance of it.

  **Storing `overdue` is accepted and `status=overdue` finds it** — that filter returns both kinds, the
  derivable ones and the ones somebody marked. It is still not worth setting: a stored `overdue` never
  reverts, so an entry marked by hand stays overdue after you move its dates forward, where a derived one
  corrects itself. On a `"nothing"` type the filter returns only the stored ones, which is the same rule
  read consistently rather than a second behaviour.

  The derivation applies to the chrono read paths only: `POST /query` reads documents as stored, so a
  deriving entry is `upcoming` there and `overdue` in `GET /chrono`. Sync sees the stored value too.
- `endsAt` — optional ISO 8601. When present it **replaces `startsAt` as the due moment**, so an entry that
  began last month and ends next year is not overdue. **Nothing validates the order**: an `endsAt` earlier
  than `startsAt` is stored as sent, and on a type that derives the entry then reads as `overdue`
  immediately. Check it yourself if that matters.
- `confidence` — `0`–`1` (optional, useful for predictions)
- `entityIds` — array of UUID v4 entity IDs (not names); returns `400` if any value is not a valid UUID and `strictLinkage` is enabled
- `memoryIds` — array of UUID v4 fact IDs (not names); returns `400` if any value is not a valid UUID and `strictLinkage` is enabled

**Response** `201` — the created `ChronoEntry`.

---

### Update a Chrono Entry

```http
PATCH /api/brain/spaces/:spaceId/chrono/:id
```

> **`POST .../chrono/:id` was removed in 3.0** and now answers `404`. It was the only POST-that-updates in
> the brain API; it performed no property validation and wrote no audit snapshot. `PATCH` takes the same
> body and does both.

**Body**: partial object with any updatable fields (`title`, `type`, `status`, `startsAt`, `endsAt`, `confidence`, `tags`, `entityIds`, `memoryIds`, `description`, `properties`, `recurrence`, `suppressEmbeddings`, `ttlDays`), plus `deleteFields`.

> **`deleteFields` arrived in 3.1, and it is the only way to remove anything.** `properties` MERGE — patching
> one key keeps the others — and an omitted field means *leave it alone*, so before 3.1 there was no request
> that could unset a chrono field at all: a key written once was permanent. Send dot-notation paths, applied
> **after** the merge:
>
> ```json
> { "properties": { "venue": "Hall B" }, "deleteFields": ["properties.oldKey", "description"] }
> ```
>
> Chrono's **required** fields — `title`, `startsAt`, `status` — are refused by name, alongside the
> server-owned `id` / `type` / `spaceId` / `createdAt` / `updatedAt`. A path that cannot be honoured answers
> `400` naming it rather than being accepted and doing nothing. A *property* of the same name
> (`properties.title`) is an ordinary user key and stays deletable.
>
> Same parameter, same refusals, on the `update_chrono` MCP tool. See
> [Partial Update with deleteFields](04f-write-semantics.md#partial-update-with-deletefields) for the shared rules.

**Response** `200` — the updated `ChronoEntry`.

---

### List Chrono Entries

```http
GET /api/brain/spaces/:spaceId/chrono?limit=50&skip=0
```

#### Query parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `after` | ISO 8601 string | Return entries with `createdAt` > this timestamp |
| `before` | ISO 8601 string | Return entries with `createdAt` < this timestamp |
| `tags` | comma-separated strings | Return entries where `tags` contains **ALL** listed values (AND semantics) |
| `tagsAny` | comma-separated strings | Return entries where `tags` contains **ANY** listed value (OR semantics) |
| `search` | string | Case-insensitive substring match on `title` and `description` |
| `status` | string | Filter by status (`upcoming`, `active`, `completed`, `overdue`, `cancelled`). `overdue` is derived on read (past due + not completed/cancelled); filtering by `upcoming`/`active` excludes now-overdue entries |
| `type` | string | Filter by type (the five built-ins, or the space's own declared chrono types — see above) |
| `limit` | number | Max entries to return (default 50, max 500) |
| `skip` | number | Pagination offset (default 0) |
| `sort` | string | Sort field: `createdAt`, `title`, `startsAt`, or `type` (see [Sorting](04-brain-api.md#sorting-all-brain-list-endpoints)). Unknown field → `400` |
| `dir` | string | `asc` or `desc` (default `desc`) |

#### Example queries

```http
GET /api/brain/spaces/:id/chrono?after=2026-04-04T00:00:00Z
GET /api/brain/spaces/:id/chrono?after=2026-01-01T00:00:00Z&before=2026-04-01T00:00:00Z&tags=incident
GET /api/brain/spaces/:id/chrono?tagsAny=deploy,auth-service
GET /api/brain/spaces/:id/chrono?search=migration
```

**Response** `200`:

```json
{
  "chrono": [ ... ],
  "limit": 50,
  "skip": 0
}
```

---

### Delete a Chrono Entry

```http
DELETE /api/brain/spaces/:spaceId/chrono/:id
```

**Response** `204`, or `409` when something still points at it and the space has
`strictLinkage` on. The body carries `error`, `blocking` (what refused it) and
`references` (everything pointing at it). A file listing this entry in `chronoIds` blocks the delete.

> **This changed in 4.0 and a running script can hit it.** The same delete always succeeded before, because
> those link fields had no reader anywhere in the server — the reference was stored and replicated and
> nothing could see it, so the referring record was quietly left pointing at a chrono entry that no longer
> existed. With `strictLinkage` off it still always succeeds.
