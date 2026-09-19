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

**`superseded: true` marks a claim that is no longer true**, and it is written as a record FIELD rather than
a property — unlike `attributed`. The difference is whose vocabulary it is: `attributed` belongs to this
corpus and is declared on the claim type, `superseded` belongs to the product and exists on every record in
every space. A second spelling of a real field, in the one space anybody reads to judge the product, is
worse than no mark at all.

It does not hide the claim. A superseded claim still embeds, still ranks and comes back labelled — hiding it
would make *"where DID she work?"* unanswerable in order to fix *"where does she work?"*.

**A claim MAY carry a `key`, and almost none do.** Nothing pointed at a claim until supersession; entities
and chrono entries have always needed one because something referred to them. Give a claim a key only when
an edge names it.

**One key names one record, across all three kinds.** An edge end is a bare key and says nothing about which
collection it is in, so two records sharing one make the edge point at whichever was resolved first.

**Which claim replaced which is a `supersedes` edge, claim to claim:**

```json
{ "claims": [
    { "key": "worked-at-acme", "text": "Ada worked at Acme as a platform engineer from March 2021.",
      "speaker": "Ada", "statedOn": "2023-05-08", "superseded": true,
      "entities": ["ada", "acme"], "sourceTurns": ["D1:1"] },
    { "key": "works-at-beta", "text": "Ada left Acme and started at Beta in June 2023.",
      "speaker": "Ada", "statedOn": "2023-06-14",
      "entities": ["ada"], "sourceTurns": ["D4:2"] }
  ],
  "edges": [ { "label": "supersedes", "from": "works-at-beta", "to": "worked-at-acme" } ] }
```

`supersedes` is the one label that is **not** declared in `../space/schema.json`, and must not be: the
instance writes it itself when a reviewer resolves a contradiction, so it is server-written vocabulary
rather than this corpus's.

**A retirement needs no successor.** *"She left Acme"* with nobody named after it is a real thing to record:
`superseded: true` stands alone and no edge is required. The implication runs the other way and the writer
enforces it — **if an edge says X replaced Y, then Y must carry the mark**, or both come back from a search
looking equally current, which is the thing the edge was drawn to prevent.

**Between two ENTITIES, `supersedes` is refused.** Two entities that turn out to be one thing are a merge,
and merging is what `aliases` is for; drawing an edge instead leaves two nodes where the whole value of the
graph is that there is one.

## An extraction delivered in parts

A big conversation reads in one pass and does not always WRITE back in one — the graph of a long history is
a large document even where the history itself fitted comfortably in front of the model. So a file may
arrive as several parts, each covering a contiguous run of sessions and each carrying its place:

```json
{ "conversationId": "conv-x", "part": { "index": 2, "of": 4 }, "sessions": [ ... ] }
```

`mergeExtractionParts` in `../writer/merge-extraction.mjs` joins them, and **refuses an incomplete run**.
That refusal is the only thing in the pipeline that can see a part went missing: three parts of four
concatenate into a file that is valid in every other way and describes three-quarters of a conversation, so
the hole surfaces as a question returning nothing — which reads as a retrieval failure.

| | |
|---|---|
| entities | repeated in every part, reconciled by key. Later wins on the description; `sourceTurns` and `aliases` are unioned. A key whose **type** changed between parts is refused rather than resolved |
| claims, chrono, edges | belong to the part whose sessions they came from, and are never repeated |
| sessions | concatenated in part order, whatever order the parts arrive in |
| a key used twice | refused, naming both parts — the seam is where a model forgets what it minted |

A single file with no `part` block is a whole extraction and passes through untouched. Every LoCoMo file is
one, and none of them needs changing.

## What the writer does with it

1. Creates the space with `../space/schema.json`, its purpose and its usage notes.
2. Writes every entity, keeping `key → id`.
3. Writes every chrono entry, linked to its entities.
4. Writes every claim, linked to its entities and chrono entries.
5. Writes every edge, resolving both ends through the key map.
6. Writes one transcript file per session, naming the claims and entities it produced.
7. Returns the `sourceTurns` side map to whoever asked, and stores none of it.

Edges last: both ends must exist. The transcript last of all: it names records that must already have ids.
