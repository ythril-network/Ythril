# Links

> Part of the [Ythril Integration Guide](../integration-guide.md).

## Links

A **link** says one record CONCERNS another. A fact about an entity, a chrono entry about a fact, a
file about all three. It is not an edge and cannot become one: it carries no label, no weight, no
properties and no type, because saying **how** two things relate is what an edge is for.

**A link is a record of its own, and since 5.0 that is the only shape it has.** It lives in the space's
`links` collection, it replicates as itself, and neither record at its ends carries a copy — so an
ordinary `PATCH` of a fact cannot drop a link somebody else made.

**The six classes, and there is no seventh:**

| from | to | the label a link of this class carries |
|---|---|---|
| fact | entity | `fact.entityIds` |
| chrono | entity | `chrono.entityIds` |
| chrono | fact | `chrono.memoryIds` |
| file | entity | `file.entityIds` |
| file | fact | `file.memoryIds` |
| file | chrono | `file.chronoIds` |

An entity is only ever the **to** end. Nothing hangs off an entity, which is why there is no `entity.…`
class — the way to say something about two entities is an edge.

**Those labels are FROZEN tokens, and they read like fields because they were.** Each names the 4.x array
the class replaced. A link's `_id` is a UUIDv5 over the pair, the two kinds and the label, so renaming one
would re-key every link record on every instance — the same connection would have two ids and neither door
would find the other's. Read them as names, not as fields to send.

### Attaching records when you write one

**Every write door takes the connections in the same call**, so creating a record and attaching it to three
things is one request rather than four:

| field | attaches to |
|---|---|
| `linkEntities` | entities |
| `linkFacts` | facts |
| `linkChronos` | chrono entries |

Each takes the ids you want attached. **A class you NAME is replaced wholesale and a class you omit is left
alone** — so `linkEntities: []` detaches every entity and leaves the fact links untouched, and there is no
add-only trap. Under `strictLinkage` every id must resolve, and the call is refused rather than storing a
link that points at nothing.

**The 4.x spelling is REFUSED, by name.** A body carrying `entityIds`, `memoryIds` or `chronoIds` gets a
`400` naming the field to send instead — the same sentence on both doors, and the ids do not change. The
call is refused whole, so a record never lands without the connections it asked for. `[]` and `null` are
refused too: a present key is a write, and the call that meant "detach everything" is the one that must not
be read as "said nothing".

**What a record no longer carries is the LIST.** A fact read back does not carry the ids of the entities it
names, on either door and at any setting of `includeRecordMeta`. Ask the graph instead — `traverse`, or
`recall`'s `traverse` object, both of which return the records rather than ids to look up one at a time —
or filter the `links` collection directly.

### The conversion runs itself at boot

**You do not have to run anything.** Every start converts each space that still holds the 4.x lists and
marks the ones whose walk finished cleanly — additive, so an interrupted run is fixed by the next boot and
an already-marked space is skipped.

**A space whose conversion FAILED is refused rather than answered.** Every link read on it returns an error
naming the space, and the failure is in the startup log. Answering with an empty link set would be a lie
every reader believes, which is the one outcome worse than an error.

**There is no way to turn a converted space back.** It was an ordinary reversible setting while the arrays
existed and both shapes could be read; with one shape left, turning it off would mean "read my links from a
shape that does not exist". The setting is refused for every caller, an instance administrator included.

**Running the conversion twice is a no-op.** A link's id is derived from the pair and the class, so a
second run recomputes the same ids, finds them stored, and writes nothing.

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

**Response** `200` with the link record, including its `_id` and its `label` (`fact.entityIds`).

**It is an upsert, and `200` rather than `201` says so.** A link's `_id` is a UUIDv5 over the two records
and the class, so one connection has exactly one id for ever: creating a link that already exists succeeds
and changes nothing. Retry it as often as you like — it cannot produce a duplicate, and it will never
report a conflict.

**Refusals:**

| | |
|---|---|
| `400` | a `(fromKind, toKind)` pair outside the six — the error names the ones that are allowed |
| `400` | under `strictLinkage`, either end failing to resolve |
| `404` | the `from` record does not exist — a link hanging off nothing is the dangling half this refuses to create |

---

### Delete a Link

```http
DELETE /api/brain/spaces/:spaceId/links/:id
```

**Response** `204`, or `404` if the id is not a link.

The two records at either end are untouched. The link record IS the whole connection, so removing it
removes the connection — there is no second copy on either end to contradict it. A tombstone is written, so
the removal reaches peer instances on the next sync instead of being restored by one that still holds it.
