# Benchmark development log

The measurements behind the LoCoMo work: what was tried, what the number was, and which premises turned
out to be wrong. It is here rather than in the CHANGELOG because none of it is a change to the product —
a reader of the changelog wants to know what is different for them, and this is the record of how the
benchmark got to the number it publishes.

## 2026-09-15 — moved out of the CHANGELOG

These entries were written as changelog entries and do not belong there: a changelog says what changed for
someone using the product, and none of this does. What each one is worth keeping for is the measurement in
it — a number that was believed and turned out to be wrong is the only thing here that saves anybody time.

- **The benchmark harness has a generic conversation schema, and it is read from the specification rather than copied.**

  `INGESTION.md` has always specified a product-grade knowledge schema for any conversation — nine entity
  types (`person`, `animal`, `place`, `organization`, `work`, `object`, `activity`, `condition`, `project`)
  and fourteen edge labels with both endpoints pinned, so `works_at` runs person to organization and an edge
  drawn any other way is refused at write time. **No ingest strategy implemented it.** Every one declared a
  transcript instead: a single `utterance` type carrying the session, the turn ids and the speaker, and the
  one strategy that declared entities typed them `subject` with a naming pattern of four-or-more lower-case
  letters, which admitted `anything`, `around` and `also` as nodes of the graph.

  The schema now lives in the harness and parses the specification's own JSON, so there is one source and a
  gate that fails when the two disagree. Dates documented as `YYYY-MM-DD` are declared as dates rather than
  strings, so they can be range-queried. The benchmark's own join key stays out of the shared vocabulary and
  is passed in per caller.

- **A benchmark result now credits everything it brought back, not just the first hop.**

  A recall answer nests a wrapper — `{ edge, node, paths, _graph }` — and a node's children hang off the
  wrapper, not off the node. The scorer read the node and then looked for children on it, so it descended
  exactly one level and stopped, at any depth, with nothing to indicate it. Against a live instance, a recall
  at depth 2 returned 10 matches, 18 linked entities and 92 linked memories; the scorer credited the 18 and
  none of the 92.

  Every graph strategy ever measured was scored as though its walk returned nothing past hop 1 — including
  the one whose entire claim is that a match reaches a record in a different session, which is the only
  mechanism that can answer a cross-session question at all. It is worth about a point at the equal byte
  budget the protocol fixes, because expansion is charged against that budget; the point is that the number
  was not a measurement of the thing it named.

  The scorer moved out of the runner to be testable at all: importing the runner executes its `main()`, so a
  scoring rule that decides every published figure had no test.

- **The strategy that links windows across sessions was joining them on stopwords.**

  Its subjects were derived as words appearing in several sessions of a conversation but not most of them —
  which is exactly the spread an ordinary English word has, so the rule could not separate a word that
  recurs because the speakers keep discussing it from one that recurs because it is English. It produced 484
  subjects for one conversation, beginning `able accomplishment advice after again ages album alive almost
  along also another anything around`.

  Fixed by giving the rule the rest of the corpus: a term appearing across most of the transcripts is
  English, a term in one or two is a topic. One conversation goes from 334 subjects to 34, now
  `transgender`, `transition`, `pottery`, `advocacy`, `inclusivity`, `identity`, `parade`, `pride`.

- **Two ingest strategies documented premises that were no longer true**, and both had cost a measurement. One
  stated that a property is not embedded — every property is appended to the embedded text as `key value`, so
  the strategy built to add a date added a second copy of one already there and correctly measured nothing.
  The other stated that graph traversal never reads a record's entity links and that linking cost 1.5 points
  of recall; traversal reads them now, and the 1.5 points were paid off by removing linked entity names from
  the embedded text rather than avoided.

- **A benchmark score is now published beside the highest score that question set allows.**

  The Tier 0-R headline asks whether the single top result held every turn the gold answer cites. On the
  published sample, 30 of 199 questions cite turns from two different sessions of the conversation, and no
  record built from consecutive turns can hold both — at any width. So every window strategy in the
  programme is capped at **84.9%** before retrieval runs, and a reader of the old table had no way to tell
  three points from the maximum apart from thirty.

  Every report now states that ceiling and the cross-session share in its header, and the report writer
  refuses to render without them. The number is derived from the pinned dataset and the seeded sample rather
  than written down, because a different sample is a different layout. A strategy that LINKS turns across
  sessions is not bound by it, and the report says so: rank-1 credit reaches through a result's graph
  expansions.

  Protocol Amendment 7. No measurement changed and no result moved — the existing report was regenerated
  from its own unmodified rows and every other figure in it is unchanged.

- **A conversation now records how things developed, not only what was said on each day.**

  Every claim came from a single exchange, so the graph held both ends of a story and never the story. A
  system that can report "she applied in August" and "she passed in October" but not "the adoption went
  from researching agencies in May to passing the interviews in October" is a log rather than a knowledge
  base, and a question about the arc has nothing to match.

  Twelve such claims on one conversation lifted `within 3` everywhere — multi-hop from 12.5% to 21.9%,
  single-hop from 82.9% to 85.7%. They are additional records: per-turn coverage is unchanged and
  complete, and each names only the turns that state what it says, the widest being nine.

  **What it did NOT move is coverage, and that is worth knowing.** `allEvidence` stayed at about 88% because
  at a fixed result count more records compete for the same slots. Coverage is near its ceiling for this
  shape; converting it into rank is the remaining work.

- **A synthesised record now carries the turns it was built from, and that is what finally answers a
  question spanning two sessions.**

  An entity description says what the whole conversation established about a subject — the adoption entry
  names research in May, a council meeting in July, an application in August and interviews passed in
  October. That is one record whose content spans four sessions, and it was unusable twice over: nobody
  could check it, and nothing could credit what it was drawn from.

  | | rank 1 | within 3 | all evidence | multi-session questions |
  |---|---|---|---|---|
  | one record per turn | 34.0% | 43.1% | 74.6% | 0.0% |
  | facts, no provenance | 39.1% | 57.9% | 85.8% | 0.0% |
  | with provenance | **47.2%** | 59.9% | **88.3%** | 0.0% |
  | with provenance, top 5 and one hop | **51.8%** | **64.0%** | 70.6% | **12.8%** |

  **The cheat this opens is closed in the same change.** Handing a record the union of every turn linked to
  it would let one entity claim most of the transcript, match once and score everything — the oldest trick
  in retrieval, wearing a graph. Provenance names the turns the description actually states, and a record
  claiming more than a small share of the conversation is refused: a few sentences about a subject were not
  derived from four hundred turns.

- **Storing resolved facts instead of transcript lines beats storing the transcript, by six points.**

  One conversation, 197 questions, equal budget, against one-record-per-turn:

  | | rank 1 | within 3 | all evidence |
  |---|---|---|---|
  | one record per turn | 33.0% | 42.1% | 73.6% |
  | resolved facts | **39.1%** | **57.9%** | **85.8%** |

  419 turns became 117 facts, each a sentence that stands on its own with its subjects named and its dates
  resolved, covering the turns of the exchange it came from. 82 entities carry descriptions. Nothing is
  dropped: every turn is still reachable through the fact that reports it.

- **The benchmark dataset was re-fetched from its pinned source, and extraction is now structurally blind to the answer key.**

  A session had read some of the questions and gold answers while investigating retrieval. The cached copy 
  was deleted and re-fetched from the URL the pin names; the bytes came back identical, so the corpus never
  changed — what changed is that no local copy carries anything from that session.

  The rule that extraction never sees a question is now enforced rather than promised. A gate walks the
  whole tree the loader hands the extraction step and fails on a question, answer, evidence reference or
  category appearing at any depth, and checks the bytes on disk still match the recorded hash. A graph built
  while looking at the answer key scores well on it and describes nothing else, and no results table can
  reveal that afterwards.

- **The benchmark folder was restarted from the schema, and 56 files were deleted.**

  Everything that was there took a conversation to be a pile of transcript chunks and asked how big to cut
  the chunks. Twelve ingestion strategies, a window sweep, a grid runner and a 65 KB specification all
  explored that one idea. Measured on 199 questions at an equal byte budget, the best of them answered 50.8%
  correctly at rank 1, the worst 10.6%, the whole sweep from a 3-turn to a 25-turn window was worth at most
  one point — and **multi-hop questions scored 0.0% under every single strategy**, because those answers need
  two remarks from sessions weeks apart and no run of consecutive turns can hold both.

  What is left is what a conversation actually is: `benchmarks/space/` holds an importable schema, the
  space's purpose and its usage notes; `benchmarks/dataset/` holds the loader; `benchmarks/plan/` holds the
  plan for the writer, written from the schema rather than from what was deleted.

  **The schema is data, not code** — an array of schema-library entries in one group, so it can be POSTed to
  a Ythril instance as-is and shared with anyone storing a conversation. Nine entity types, fourteen edge
  labels with both ends pinned so `works_at` from a place is refused at write time, five chrono types, and
  one claim type carrying who said it and when.

  Four rules shape it, and each one removes something the old vocabulary had: a date that does not say how
  long a relationship held is a chrono entry, not a property of a thing; every date is declared as a date, so
  it can be compared rather than only matched; an edge says *that* two things are related and *for how long*
  and never narrates, so how strongly, how severely and how it changed are claims; and no transcript
  bookkeeping appears anywhere, because every property is folded into the embedded text and a turn id is
  meaningless tokens inside every vector in the space.

  `scripts/LINK-READERS.md` moved out of `benchmarks/` rather than going with it — it is a server performance
  record, not a corpus artefact.

- **The thing a question matches is now a resolved fact, not a line of the transcript.**

  The graph had been scoring level with storing raw turns, and the reason was structural rather than a
  tuning problem: the retrievable records WERE the raw turns, with links hung off them. A line of dialogue
  is not self-contained — *"I went to a support group yesterday"* names nobody and dates nothing, and an
  embedding sees exactly those words. The fact it establishes — *Caroline attended an LGBTQ support group on
  7 May 2023* — is what a question can actually match.

  Three changes follow, and all three are now refused rather than advised against. A claim that opens with
  its own speaker's name is a transcript line and is rejected. An entity with no `description` is rejected:
  a bare name embeds as two words, loses every search it takes part in, and still occupies a ranked slot.
  And entities and chrono entries are searchable again — they hold the resolved facts, so suppressing them
  had hidden the answers; edges stay suppressed, because a label has no content.

  The verbatim words are not lost. They live in the session transcript file, which exists so anything can be
  quoted exactly: the graph is for finding, the transcript is for quoting.

- **The graph layer no longer competes with the claims for a place in the answer.**

  Entities, edges and chrono entries are declared `suppressEmbeddings`. They are joints and dates, not
  sentences: an entity embeds as its name and type, matches a query weakly, and takes a ranked slot that a
  claim would have used. Measured on one conversation, that cost about **ten points** of rank-1 accuracy —
  24.9% against the control's 33.5% — and the fix brings it to 34.0%, level with the control and with no
  `types` filter needed at the call site. They stay fully reachable by walking, which is what they are for.

  Two extraction rules were also found the expensive way and are now measured facts rather than advice: the
  claim layer must cover **every** turn, and a claim's text must be the turn **verbatim**. Trimming
  greetings out of 118 otherwise-verbatim claims was worth several points on its own, because a paraphrase
  drops the words a question might match on.

- **The first conversation was extracted, measured against a control, and lost — for a reason the
  measurement names exactly.**

  A 419-turn conversation became 74 entities, 68 edges, 57 chrono entries and 145 claims. Scored against
  one-record-per-turn on the same questions at the same byte budget, the graph answered 22.3% correctly at
  rank 1 against the control's 32.5% — worse on every column.

  The cause is not the graph. The claims covered **34.6%** of the turns, because the extraction prompt said
  a claim mentioning nobody and nothing was probably not worth making. Two thirds of the conversation was
  therefore absent, and no structure built on top can answer a question about a remark that was never
  stored. Nothing in the result looked wrong: the graph had entities, edges, dates and links.

  The rule is reversed — every turn becomes a claim, and the claim layer is complete rather than curated —
  and it is now enforced rather than advised: the validator refuses an extraction whose sessions declare
  their turns and whose claims do not cover them. Judging which remarks matter is retrieval's job, at read
  time, when the question is known.

- **The deterministic half of ingestion exists: a writer that replays an extraction file into a space.**

  Extraction needs a model and happens once; replaying its output does not and can be repeated by anyone.
  The writer creates the space from the schema, its purpose and its usage notes, then writes entities,
  chrono entries, claims, edges and one transcript file per session — in that order, because each step names
  records the one before it created, and a link to a record that does not exist yet is dropped silently
  rather than refused.

  Which turns a claim came from is returned to the caller and stored in no record. Every property is folded
  into the text that gets embedded, so a turn id inside a claim would be unique noise in every vector in the
  space, and no user of the product has one.

  A validator runs before the first write and reports every problem at once. Half of what it catches the
  instance would catch too, but only on the request that reaches it — leaving a space holding most of a
  conversation, which is interpretable, wrong, and says nothing about it. The other half the instance cannot
  catch at all: an extraction refers to its own records by local key, and a claim naming a key nothing
  defines produces a valid record with one fewer link and a successful response.

