# Ingestion plan

How a conversation becomes the space described by `../space/schema.json`.

## This is a product capability, not a benchmark step

**One ingester, and the benchmark is one of its callers.** Everything below describes ingesting a
conversation into Ythril for its own sake — a chat log, a support history, a set of meeting transcripts. It
runs with no benchmark present and knows nothing about questions or scoring.

That splits the work in three, and the split is what keeps the ingester honest:

| | |
|---|---|
| **a source** | turns a corpus into sessions of speaker-and-text with dates. The LoCoMo loader is one; a chat export is another |
| **the ingester** | everything on this page. Takes sessions, writes the space. The only part that touches Ythril |
| **the measurement** | questions, answer keys, scoring. Present only when there is a benchmark |

An ingester that can see the questions will end up shaped by them, and a vocabulary fitted to one corpus is
a worse product. Keeping the measurement out of the ingester is what makes both usable.

## The unit of work

One conversation, one space. A conversation arrives as sessions; each session has a date and a sequence of
turns; each turn has a speaker and text. Nothing else about the source file survives ingestion.

Five kinds of record come out:

| | |
|---|---|
| **entities** | the stable things the conversation keeps returning to |
| **edges** | how two of them are related, and for how long |
| **chrono** | anything that happened on a date, linked to what it concerns |
| **memories** | the individual things said, each with a speaker and a date |
| **files** | the verbatim transcript, one per session, so anything can be quoted exactly |

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

**4. Write the session transcript as a file**, named by the session date and tagged `transcript`, naming
the claims it produced and the people in it. It is the evidence a claim can be checked against, and it is
written last because it names records that must already exist.

**5. Nothing is written twice.** Re-reading a session must produce the same graph, not a second copy of it.

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

Turning free dialogue into typed entities and labelled edges needs a model. A rule based on word shape or
word frequency does not produce entities; it produces common words, which link everything to everything and
are worse than no graph at all.

**The model is the assistant doing the work.** Owner, 2026-09-09. That costs nothing extra and needs no key,
and it raises one problem that has to be solved rather than noted: a benchmark whose extraction happened
inside an interactive session is not reproducible by anybody else.

### So the extraction is pinned as data

Extraction runs **once per conversation** and its output is written to a committed JSON file — the entities,
edges, chrono entries and claims, with no Ythril ids in them. The writer replays that file into a space
deterministically.

| | |
|---|---|
| **extract** | needs a model, happens once, output committed |
| **write** | pure, repeatable, no model, anybody can run it |

So a sceptic can rebuild the exact graph from the repository and check every record against the transcript.

What they cannot do is re-derive the extraction without a model of their own — which is true of every
system in this space, and is why the file is committed rather than regenerated.

### The rule extraction runs under

**It never sees a question.** Not the text, not the answers, not the categories, not how many there are of
each kind. The extractor is handed sessions of speaker-and-text and nothing else. A graph built while
looking at the questions scores well here and describes nothing else, which is the opposite of the point.

**Disclosure, because it is already partly untrue.** While investigating the old approach this assistant
read about ten questions and their gold answers, across four of the ten conversations, to work out where the
evidence sat. That exposure exists and cannot be undone. It is recorded here rather than left for somebody
to infer, and the honest options are to extract those four conversations with a fresh context or to report
their numbers separately. Whichever is chosen goes in the results.

## What is measured

**Rank 1** — did the single first result hold everything the answer cites. Coverage can be brute-forced by
returning more per record; rank cannot.

**Multi-hop rank 1** — the questions whose answer needs two remarks from different sessions. This is the
number the graph exists for. If it does not move, the graph bought nothing, whatever the total does.

**Cost beside the score** — model calls, and bytes returned. A graph walk is charged against the same answer
budget as everything else, so a walk that returns noise must score *worse*, not merely bigger.

**A control** — one record per turn, no graph. A graph number with nothing beside it is not a result.
