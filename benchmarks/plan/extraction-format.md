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
      "date": "2023-05-07", "entities": ["caroline"] },
    { "key": "pride-parade", "type": "event", "title": "Caroline went to the city pride parade",
      "date": "2023-07-15", "endsAt": "2023-07-16", "entities": ["caroline"] }
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

## `producedBy` — how the file was made

Every extraction carries one, and `check` refuses a file without it:

```json
{ "producedBy": { "promptSha256": "b1c042ac…", "unattended": true } }
```

**You supply `unattended` and nothing else.** Put it in the first part; the merge carries it through.
`promptSha256` is stamped by the merge from the prompt file on disk, because which prompt produced a file
is a fact about the working tree rather than something worth asking anyone to copy correctly.

**`unattended: true` means no retrieval score, benchmark result or accuracy figure was visible to whoever
or whatever wrote this extraction, at any point.** If one was, say `false` — that is legitimate
development and the flag simply records which it was. Leaving it out is refused rather than read as
`true`: the run that would misreport is exactly the run that omits it.

**Why the fingerprint is a hash and not a version.** A version somebody types is a claim about the
prompt; a hash of its bytes is the prompt, and it cannot survive an edit. Its newlines are normalised
first, so a CRLF checkout and an LF one agree — otherwise one prompt would produce two digests and the
corpus would report itself as made by two prompts, permanently and on nothing.

**What it is for.** Two things have gone wrong that nothing else could see. One extraction was written by
hand while its author watched the retrieval scores, and sat in the directory indistinguishable from nine
that were not. And twice in one day a corpus ended up made by two prompts — once when a rate limit killed
a round halfway, once when a rule was clarified between conversations. Every per-conversation difference
afterwards is unattributable, and the files are individually perfect either way.

## Rules

**`key` is local to the file.** It is how one record refers to another before anything has an id. The writer
resolves every key to the record it created; a key naming nothing is an error, not a skipped link.

**Every `type` and `label` must exist in `../space/schema.json`.** The instance would refuse an undeclared one
at write time, so the file is checked against the schema before a single record is written — a corpus that
fails halfway leaves a space nobody can interpret.

**Every edge's endpoints must match the label's declared ends.** `works_at` from anything but a person is an
error in the file, not something to discover from a 400.

**A chrono entry may carry `endsAt`, and that is how a two-day event gets onto the timeline.** `date` is
the day it started and `endsAt` the day it ended; omit `endsAt` for anything that happened on one day. It
exists because a weekend is neither one date nor a vague span — and before it did, a marriage, a medical
diagnosis, a pride parade and a career-high game were all left off the timeline while a photograph taken
on a named Friday was on it. What reached the timeline was being decided by the grammar somebody happened
to use. The range must not run backwards; a same-day range is fine and is simply explicit.

**Dates are `YYYY-MM-DD`, resolved.** No `last year`, no relative expressions, no partial dates. The session
date is the anchor and resolution happens during extraction, where the surrounding text is available.

**An entity and a chrono entry may carry `sourceTurns` too, and should.** A claim always does; those two
are optional and are the turns that established the SUBJECT — where the person was introduced, where the
event was described. **The validator has always had a rule about them and the format never said they
existed**, so a run following this document exactly never wrote the field and the rule never fired: a
synthesised record may name at most 12% of a conversation as its provenance, because a few sentences
about one subject cannot have been derived from most of a transcript.

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

## A day may hold more than one session

**The date does not identify a session.** A conversation recorded over months has one session a day and the
date reads as a name; a history recorded over a fortnight has several a day, and then two sessions share it.

That matters because the writer names each transcript after its session and files each claim under one. So
a session carries an optional `key`, and a claim carries an optional `session` naming it:

```json
{ "sessions": [
    { "key": "s1", "date": "2023-05-20", "turns": ["D1:1", "D1:2"] },
    { "key": "s2", "date": "2023-05-20", "turns": ["D2:1"] }
  ],
  "claims": [
    { "session": "s1", "text": "Ada planned a road trip.", "speaker": "Ada", "statedOn": "2023-05-20",
      "entities": ["ada"], "sourceTurns": ["D1:1"] }
  ] }
```

Both fall back to the date, so a file with one session per day needs neither and none of the committed
LoCoMo extractions changes. **Two sessions that resolve to the same identity are refused** — without that,
one transcript silently overwrites the other and both sessions' claims are filed under whichever survived,
which nothing downstream can see.

`statedOn` stays a date and still means the day the claim was made. It is what a reader sees in the record;
`session` is only how the file refers to one of its own sessions.

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
