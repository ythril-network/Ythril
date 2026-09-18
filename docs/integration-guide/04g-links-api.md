# Links

> Part of the [Ythril Integration Guide](../integration-guide.md).

## Links

A **link** says one record CONCERNS another. A fact about an entity, a chrono entry about a fact, a
file about all three. It is not an edge and cannot become one: it carries no label, no weight, no
properties and no type, because saying **how** two things relate is what an edge is for.

These are the six public array fields — `fact.entityIds`, `chrono.entityIds`/`memoryIds` and
`file.entityIds`/`memoryIds`/`chronoIds` — stored as records of their own, so that everything which
asks *"what is adjacent to this?"* has one place to look instead of following a different subset of the six.

**The six classes, and there is no seventh:**

| from | to | the array it is |
|---|---|---|
| fact | entity | `fact.entityIds` |
| chrono | entity | `chrono.entityIds` |
| chrono | fact | `chrono.memoryIds` |
| file | entity | `file.entityIds` |
| file | fact | `file.memoryIds` |
| file | chrono | `file.chronoIds` |

An entity is only ever the **to** end. Nothing hangs off an entity, which is why there is no `entity.…`
class — the way to say something about two entities is an edge.

**All six are followed by a traversal from 4.0.** Three of them — `chrono.memoryIds`, `file.memoryIds` and
`file.chronoIds` — were accepted, resolvability-checked, stored, replicated and documented since 3.x with no
reader at all, so the ids were visible on the record and the graph returned nothing. They are also visible
to the scan that refuses a delete, and to the check sync runs on arriving records.

**Writing a link also writes the array**, and reading one back is the same fact either way. That is what
makes a link durable rather than a second opinion: an ordinary `PATCH` of the fact would otherwise
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
- **It never applies to a write that does not MENTION an array.** A `PATCH` of a fact's `fact` on a record
  still carrying a legacy array succeeds, or every unconverted record would become uneditable.

### Running the conversion — it runs itself at boot since 5.0

**You do not have to run anything.** Every start converts each space not yet marked `completeLinkage` and
marks the ones whose walk finished cleanly — additive, so an interrupted run is fixed by the next boot and
an already-marked space is skipped. A space that FAILS is left unmarked and named in an `ERROR` line, keeps
reading its arrays and accepting array writes exactly as before, and the instance still serves. This
replaced `npm run links:convert`, which is in `package.json` while `scripts/` is not in the published image
— a container deployment got a missing-module stack trace (2026-09-15). It still works from a source checkout.

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

**There is no `GET`.** Links are a queryable collection like any other — `POST /api/filter`
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
  "fromKind": "fact",
  "to": "8c41…",
  "toKind": "entity"
}
```

All four fields are required. `fromKind` and `toKind` are one of `entity`, `fact`, `chrono`, `file`, and
they are **not guessed from the id** — the same UUID could name records in two collections, and a wrong
guess produces a link that reads as correct and points at nothing.

**Response** `200` with the link record, including its `_id` and a derived `label` (`fact.entityIds`).

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

**Read this before a space is MARKED.** Conversion sets `completeLinkage`, after which the six array
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
| `recorderStartedAt` | when THIS instance began recording, or `null` if it has not restarted since the feature arrived. `since` is clamped to it, so the window you are told about is one the recorder was actually running for |
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
