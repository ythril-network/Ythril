# Extraction format

One file per conversation, at `benchmarks/locomo/extractions/<conversationId>.json`. It is the output of the step
that needs a model and the input to the step that does not, so it holds **no Ythril ids** — nothing that
depends on a write having happened.

## Shape

```json
{
  "conversationId": "conv-26",
  "sessions": [
    { "date": "2023-05-08", "turns": ["D1:1", "D1:2"] }
  ],
  "entities": [
    { "key": "caroline", "type": "person", "name": "Caroline",
      "properties": { "aliases": "Caro" } }
  ],
  "edges": [
    { "label": "practices", "from": "caroline", "to": "pottery",
      "properties": { "since": "2023-02-01" } }
  ],
  "chrono": [
    { "key": "support-group-visit", "type": "event", "title": "Caroline attended an LGBTQ support group",
      "date": "2023-05-07", "entities": ["caroline"] }
  ],
  "claims": [
    { "text": "Caroline: I went to a LGBTQ support group yesterday and it was so powerful.",
      "speaker": "Caroline", "statedOn": "2023-05-08",
      "entities": ["caroline"], "chrono": ["support-group-visit"],
      "sourceTurns": ["D1:3"] },
    { "text": "The assistant recommended Stayokay Amsterdam Vondelpark and ClinkNOORD as budget hostels in Amsterdam.",
      "speaker": "assistant", "attributed": true, "statedOn": "2023-05-08",
      "entities": ["caroline"], "sourceTurns": ["D1:4"] }
  ]
}
```

## Rules

**`key` is local to the file.** It is how one record refers to another before anything has an id. The writer
resolves every key to the record it created; a key naming nothing is an error, not a skipped link.

**Every `type` and `label` must exist in `../space/schema.json`.** The instance would refuse an undeclared one
at write time, so the file is checked against the schema before a single record is written — a corpus that
fails halfway leaves a space nobody can interpret.

**Every edge's endpoints must match the label's declared ends.** `works_at` from anything but a person is an
error in the file, not something to discover from a 400.

**Dates are `YYYY-MM-DD`, resolved.** No `last year`, no relative expressions, no partial dates. The session
date is the anchor and resolution happens during extraction, where the surrounding text is available.

**`sourceTurns` is the one thing that never reaches Ythril.** It records which turns of the transcript a claim
came from, so a benchmark can join a result back to an answer key. The writer keeps it in a side map and
writes it nowhere — a turn id inside a record is meaningless tokens in every vector in the space, and no user
of the product has one.

**A claim is one thing said.** Do not merge turns into a summary claim; do not split a turn into several
claims unless it genuinely states several separable things.

**`attributed: true` marks a claim the graph does not assert.** It is for a claim whose origin is an AI
assistant — world knowledge it supplied, or something it produced at the user's request — and it means the
graph records that this was SAID, not that it is SO. Written to the record as an ordinary property, so both
doors can filter on it with no new parameter.

Absence is the default and is the overwhelming case: a claim with no mark is one a person asserted. **A
claim whose `speaker` is the assistant MUST carry it, and no other claim may** — the writer refuses the
file otherwise, because a mark that is optional in practice is a mark nobody can filter on.

The assistant echoing a user's own fact is NOT this case: that claim belongs to the user, with the user as
`speaker` and no mark. See the assistant-turn section of `../prompt/extraction.md`.

## What the writer does with it

1. Creates the space with `../space/schema.json`, its purpose and its usage notes.
2. Writes every entity, keeping `key → id`.
3. Writes every chrono entry, linked to its entities.
4. Writes every claim, linked to its entities and chrono entries.
5. Writes every edge, resolving both ends through the key map.
6. Writes one transcript file per session, naming the claims and entities it produced.
7. Returns the `sourceTurns` side map to whoever asked, and stores none of it.

Edges last: both ends must exist. The transcript last of all: it names records that must already have ids.
