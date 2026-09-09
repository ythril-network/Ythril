# Ingestion plan

How a conversation becomes the space described by `../space/schema.json`.

## The unit of work

One conversation, one space. A conversation arrives as sessions; each session has a date and a sequence of
turns; each turn has a speaker and text. Nothing else about the source file survives ingestion.

Four kinds of record come out:

| | |
|---|---|
| **entities** | the stable things the conversation keeps returning to |
| **edges** | how two of them are related, and for how long |
| **chrono** | anything that happened on a date, linked to what it concerns |
| **memories** | the individual things said, each with a speaker and a date |

## Order of writing

**1. Resolve the session date.** Everything downstream needs it. A session's date is the anchor every
relative expression is resolved against.

**2. Mint the speakers.** Both participants exist before any turn is read. They are the coreference anchors
everything else hangs from.

**3. Walk the turns in order.** For each turn:

- **Write the claim.** One thing said, as it was said, with `speaker` and `statedOn`.
- **Find or mint the entities it names.** Match on name and on `aliases`. A mention in session 3 and a
  mention in session 18 must resolve to one node.
- **Link the claim to those entities.**
- **Draw the edges it asserts.** `works_at`, `lives_in`, `owns` — with `since` and `until` when the turn
  says so.
- **Write a chrono entry for anything that happened on a date**, linked to the entities it concerns.

**4. Nothing is written twice.** Re-reading a session must produce the same graph, not a second copy of it.

## The rules that decide the shape

**Identity is the ingestion.** The value of the graph is that two mentions of the same thing become one node.
`Deb`, `Deborah` and a nickname are one person, which is what `aliases` is for. Two nodes for one person is
not a small error — it is the failure that makes the graph unable to answer what it was built for.

**A claim stays one thing said.** Do not merge statements to make a record richer. A record holding a dozen
unrelated statements has no subject in the sense a question has one, so its vector sits near everything and
therefore near nothing.

**Link, do not concatenate.** A claim names its entities through links. Never paste entity names into the
text to make it findable: ranking and reachability are carried by different mechanisms and must not be traded
against each other.

**Store resolved dates.** *"Last year"* and *"last weekend"* are resolved against the session date and the
resolved value is what is stored. A stored `last year` answers nothing.

**A date goes on an edge only if it says how long a relationship held.** Everything else dated is a chrono
entry.

**Nothing from the source file enters the graph.** No turn numbers, no session ordinals, no offsets. Every
property is folded into the text that gets embedded, so anything stored is something a search has to compete
with.

## Extraction

Turning free dialogue into typed entities and labelled edges is the hard part and it needs a model. A rule
based on word shape or word frequency does not produce entities; it produces common words, which link
everything to everything and are worse than no graph at all.

Two ways to pay for it, and the choice is the owner's:

- **A local model** — free per run, reproducible only if the model file is pinned by hash the way the dataset
  is.
- **A hosted model** — comparable to what other systems publish, and it costs per run. Extraction happens
  once per conversation, so the bill is paid ten times, not once per question.

Until one is chosen this plan can build the loader, the schema and the writer, and cannot fill the graph.

## What is measured

**Rank 1** — did the single first result hold everything the answer cites. Coverage can be brute-forced by
returning more per record; rank cannot.

**Multi-hop rank 1** — the questions whose answer needs two remarks from different sessions. This is the
number the graph exists for. If it does not move, the graph bought nothing, whatever the total does.

**Cost beside the score** — model calls, and bytes returned. A graph walk is charged against the same answer
budget as everything else, so a walk that returns noise must score *worse*, not merely bigger.

**A control** — one record per turn, no graph. A graph number with nothing beside it is not a result.
