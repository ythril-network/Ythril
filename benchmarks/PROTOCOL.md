# Benchmark protocol — pre-registered

> **This file is committed BEFORE any benchmark is run.** That ordering is the whole point of it, and it is
> provable: `git log --diff-filter=A -- benchmarks/PROTOCOL.md` gives the date this landed, and every result file
> under `benchmarks/results/` carries the commit it was produced at. A method chosen after seeing the score is
> not a method, whatever it is called afterwards.
>
> **Amendments are appended, never edited in.** If something here turns out to be unworkable, add a dated entry
> to [Amendments](#amendments) saying what changed and why, and re-run everything affected. A silent edit to this
> file after a run invalidates the run.

## What this is for, stated plainly

Ythril is a memory system, and the claim we want to be able to make is that it retrieves better, cheaper, or
faster than the alternatives on long conversations. That claim is worth exactly as much as the method behind it,
and memory benchmarking currently has a credibility problem: published comparisons routinely drop the category
they do worst on, grade with an unpublished judge prompt, and run competitors on defaults while their own system
is tuned.

So the target here is not a good number. **It is a number a sceptical reader can re-derive**, which is the only
kind worth putting in front of somebody who will check.

Two things follow from that, and both are binding:

1. **Every category is reported, including the ones we lose.** See [If we lose](#if-we-lose).
2. **The harness and the raw model outputs are committed**, not just the scores.

## The benchmarks

### LoCoMo

*Evaluating Very Long-Term Conversational Memory of LLM Agents* (Maharana et al., 2024). Multi-session dialogues
between two personas with question–answer pairs over the whole history, categorised by reasoning type
(single-hop, multi-hop, temporal, open-domain knowledge, and **adversarial** — questions the conversation does not
answer).

**Why it is here:** it is the dataset the competing vendors quote, so it is the only way to be comparable with
their published claims.

**What is wrong with it, recorded up front:** it is small — on the order of ten conversations — so a difference
of a few points between systems is inside the noise, which is why [variance reporting](#runs-and-variance) is
mandatory here rather than optional. It has also been public since 2024 and the dialogues are model-generated,
so part of any score is the answerer recognising the text rather than retrieving it. That is what the
[contamination probe](#control-3-no-context-contamination-probe) exists to measure.

### LongMemEval

A larger, purpose-built long-term-memory evaluation with a wider set of reasoning types and a cleaner design than
LoCoMo.

**Why it is here:** it carries the credibility that LoCoMo cannot, being bigger and built for this task rather
than adapted to it. LoCoMo carries the comparability. Neither alone is enough.

### Pinning

Before the first run, `benchmarks/pins.json` records for each dataset: the source URL, the commit or release tag,
a `sha256` of every file used, the licence, and the **counts actually observed** — conversations, questions, and
questions per category. Counts come from the data at pin time and not from any paper's abstract, because the
published figure and the released file have disagreed before in this field.

## Systems under test

| system | what it is | why it is here |
|---|---|---|
| **Ythril** | the system, configured as [below](#ythrils-configuration) | the subject |
| **Full context** | the entire conversation in the answerer's prompt, no retrieval | the CEILING. If retrieval beats it, something is wrong and we go looking rather than publishing |
| **No memory** | the question alone, no conversation | the FLOOR. Anything a system scores below this is worse than useless |
| **At least one competing memory system** | configured per its own maintainers' published recommendation | the comparison anyone actually cares about |

**The competitor's configuration is committed, verbatim, in `benchmarks/configs/`, with a link to the
documentation it came from.** If their docs are ambiguous we take the more generous reading, and we say in the
results which reading we took. A benchmark where the competitor is on defaults and we are tuned is the most
common way this goes wrong and the easiest to spot from outside.

Where a competitor has published their own LoCoMo number, we report **both** — theirs as published and ours as
measured — and if the two differ we say so and do not quietly prefer the flattering one.

## Ythril's configuration

Every retrieval knob is pinned in `benchmarks/configs/ythril.json` and echoed into each result file. No value is
chosen per question, per category, or per dataset — one configuration answers everything, because a system tuned
per category is not the system anybody deploys.

Pinned explicitly, at minimum: `topK`, `budgetBytes`, whether `traverse` expansion is on and to what depth,
reranking on or off and which model, the embedding model, and whether the deterministic `query` path is used at
all. Anything left at its default is recorded as the default with its value written out, so "default" cannot
change underneath a published number.

### Ingestion strategies, scored individually — the table that matters most

**How a conversation becomes records is a bigger lever than any retrieval knob**, and it is the half a results
table normally hides. A memory system that extracts atomic facts with a model will beat one that stores raw turns
on almost any question, and that difference has nothing to do with the store underneath. So ingestion is a
**dimension of the experiment**, not a fixed preprocessing step, and each rung is its own row:

| # | strategy | what is written | what it costs at write |
|---|---|---|---|
| **S0** | raw turns | one memory per dialogue turn, verbatim | nothing — no model call |
| **S0+** | deterministic structure | S0, plus **everything the source already states**: the two speakers as entities, one `chrono` per session carrying its real timestamp, and an edge from each turn to its speaker | **nothing — no model call** |
| **S1** | session summaries | one memory per session | one call per session |
| **S2** | atomic facts | model-extracted facts as memories, the shape competing systems use | one call per session |
| **S3** | facts + graph | S2, plus entities (people, places, organisations, objects) with typed edges between them | S2 plus one extraction pass |
| **S4** | facts + graph + chrono | S3, plus every dated event as a `chrono` record with `startsAt`/`endsAt` | S3 plus date resolution |

The ladder is the point. **S0 is the floor that costs nothing**, and if S4 does not beat it by more than its
token cost is worth, that is a finding about this product and it gets published as one. The interesting
comparisons are the rungs, not the totals:

- **S0 → S0+** is the one nobody thinks to run, and it is free. LoCoMo already carries `speaker_a`/`speaker_b`
  and a real `session_N_date_time` per session, so speakers become entities and every session becomes a `chrono`
  record with a genuine `startsAt` **without a model reading anything**. If a measurable part of the temporal
  gain is available for zero tokens, that is a stronger claim than any comparison against a competitor: it says
  the structure earns its keep before the extraction does. And if S0+ does not move temporal at all, then chrono
  is not reaching retrieval and the S3 → S4 result needs re-reading.

- **S2 → S3** answers *does the knowledge graph earn its keep?* — and the answer should show up in the
  **multi-hop** category specifically, because that is what edges are for. If multi-hop does not move, the graph
  is not paying for itself on this workload and we say so.
- **S3 → S4** answers the same question for chrono, and the place to look is the **temporal** category. Ythril
  models dated events as first-class records with a real start and end; nearly every competing system stores them
  as text. If that does not show up in temporal accuracy, the modelling is not reaching the retrieval.

### Isolating the store from the extraction

The obvious confound: if we beat a competitor, is it because our storage model is better or because our
extraction prompt is? A comparison that cannot separate those is a comparison of prompts wearing an
architecture's name.

So where a competitor's ingestion can be driven with facts we supply, **the same extracted fact set is written
into both systems** and the retrieval is compared on that. Where it cannot, the results say so explicitly and the
comparison is labelled end-to-end rather than architectural. This is one run more than anybody else does and it
is the difference between a leaderboard position and an explanation.

### Ingestion never sees the questions — at run time OR at design time

Two separate rules, and the second is the stronger one.

**At run time, prevented structurally rather than promised.** The ingest stage is given the conversation and
nothing else: the QA file is not passed to it, not reachable from it, and a gate asserts that the ingest module
cannot import or read the question set at all. The extraction prompts live in `benchmarks/prompts/` and are
published with everything else.

**At design time, the ingestion model is a PRODUCT decision and may not be derived from this dataset's
questions — including their aggregate statistics.** Owner's ruling, 2026-08-29, and it corrects a weaker line
this document originally took.

The weaker line said structural statistics were fair game: how many turns an answer typically cites, how often
evidence crosses sessions. They are not, and the reason is not benchmark hygiene — it is that **a record model
calibrated to one corpus's shape is a worse product.** A user might have two sessions or two hundred, dense
relationships or almost none, and mostly *"what did I say about X"* or mostly *"when did Y happen"*. A design
fitted to this dataset's proportions would look good here and worse everywhere real, which is exactly the pattern
that has made vendor benchmarks untrustworthy.

So the design is justified in general terms or it is cut. The test applied to every element, and recorded with
the specification: **would this still be right for a user whose conversations look nothing like this dataset?**

What the dataset's own structure may legitimately be used for:

- **parsing** — mapping the source format into records is not design;
- **sizing** — how many calls a run costs;
- **interpretation, only after results exist** — *"this corpus is N% cross-session, which is why that rung helped
  here"*. That is a statement about the dataset, made afterwards, and it is the opposite of designing around it.

Iterating an extraction prompt is legitimate work. Iterating it against the conversations we then report on is
not, which is why any such iteration happens on the development conversations named in
[Development versus reporting](#development-versus-reporting) and the consequence is reported on the untouched
ones.

### Mapping a conversation onto Ythril's primitives

Recorded here so the mapping is a stated design rather than something a reader has to reverse-engineer from the
harness:

- **space** — one per conversation. Isolation is what makes cross-conversation leakage impossible rather than
  merely unlikely, and it is how a real deployment would separate two customers.
- **memory** — an atomic fact, one claim per record. Speaker attribution and session index are properties.
- **entity** — a person, place, organisation or object, typed, with a schema per type.
- **edge** — a typed relation between two entities. Direction is part of the claim.
- **chrono** — a dated event, with `startsAt` and where known `endsAt`. Relative dates in the dialogue ("last
  month") are resolved against the session's own timestamp, and **the resolution is recorded on the record** so a
  wrong resolution is visible in the raw output rather than silently wrong in a score.
- **file** — unused. LoCoMo's images are out of scope for this run, and saying so is better than leaving a reader
  to wonder whether they were quietly included.

### Retrieval methods, scored individually

Ythril has several retrieval paths that competing systems collapse into one, and scoring them separately is the
most useful thing this benchmark can produce — for a reader deciding how to configure it, and for us deciding
what to improve. Each is a **separate row in every results table**, not a variant hidden inside one number:

| method | what it exercises |
|---|---|
| **vector only** | semantic recall alone — the baseline every memory system has |
| **lexical only** | the keyword channel alone, no embeddings |
| **hybrid (RRF)** | both channels fused, which is the shipped path |
| **hybrid + rerank** | fusion followed by the cross-encoder |
| **hybrid + traverse** | fusion, then graph expansion from each hit along typed edges |
| **hybrid + traverse + rerank** | everything |
| **deterministic `query`** | no ranking at all — a predicate over the store. Included because some questions have an exact answer and a benchmark that only measures ranking cannot see that |

The last row matters for an honest reading: `query` will lose badly on open-ended questions and may win outright
on ones with a nameable answer. Both halves of that are informative, and reporting only the hybrid row would hide
a real capability.

### The parameter sweep

A grid over the knobs that plausibly move retrieval quality, run for every method above where the knob applies:

| axis | values |
|---|---|
| `topK` | 5, 10, 20, 50 |
| `traverse` depth | 0 (off), 1, 2 |
| `minScore` | off, and one threshold chosen at pin time from the score distribution |
| `budgetBytes` | the MCP default, the REST default, and one deliberately tight value |
| rerank | off, on |

**The full grid is published — every cell, not the best one.** That is the whole discipline here, and it is worth
being blunt about why.

#### What the grid costs, and why it is ONE AXIS AT A TIME

The grid as first written was a full factorial — `topK` × traverse × `minScore` × budget × rerank — which is
**144 cells**, and across five ingestion strategies, three seeds and an answer-plus-judge pair per question it
runs to hundreds of millions of model calls. That was an unbounded specification and it is corrected here rather
than quietly reduced later; see [Amendment 1](#amendment-1--the-grid-is-one-axis-at-a-time-and-the-run-is-tiered).

**One axis at a time, from the shipped default.** Each axis is varied while the others hold at their default
value, so the grid is `4 + 3 + 2 + 3 + 2 = 14` cells rather than 144. What that gives up is interaction effects —
whether `topK: 50` behaves differently at traverse depth 2 than at depth 0 — and on ten conversations those are
undetectable anyway: an interaction smaller than the run-to-run spread is not a finding, it is a coin. Giving up
what cannot be measured is not a compromise.

**Grid cells are graded lexically, not by the judge.** The lexical metric is free and deterministic, so the
14-cell sweep costs answerer calls and nothing else. The judge is spent where a claim depends on it: the
head-to-head configurations, on the reported question set. To check that the free metric is not ranking the cells
differently from the paid one, **the best three and worst three cells are also judged** — six cells' worth of
grading to validate fourteen cells' worth of ranking.

**Extraction output is cached on disk and committed.** Ingestion is per conversation, not per question, so S1–S4
cost roughly `conversations × sessions` calls ONCE. Re-running the answerer against cached records must never
re-extract; a harness that re-extracts per seed turns the cheapest part of the run into the most expensive.

**One judge call grades every candidate for a question.** The blind shuffle already presents the candidates
unlabelled, so presenting all of them together in one call is the same measurement for a fraction of the calls —
and it is strictly better judging, because the candidates are compared against each other rather than each
against the grader's mood.

#### The sweep is an ablation, not a search for a headline

Running forty configurations and reporting the winner is **the** classic way to manufacture a benchmark result,
and it is indistinguishable from cheating no matter how the run was intended. With ten conversations, the best
cell of a forty-cell grid is very likely best **by noise**: it is the maximum of forty noisy draws, and its
expected value is above the true best configuration's. Three rules make the sweep legitimate instead:

1. **The head-to-head number against any competitor uses ONE configuration, declared in this file before the
   first run** — the product's shipped defaults, listed in `configs/ythril.json`. Not the grid's winner. If the
   grid later shows a better default, that is a change to the *product*, shipped and released, and only then does
   it become the number we quote.
2. **If the grid is used to CHOOSE anything**, the choice is made on the development conversations named in
   [Development versus reporting](#development-versus-reporting) and the consequence is reported on the ones
   never looked at. A configuration selected and reported on the same data is not a measurement.
3. **The noise floor is published with the grid.** Every cell carries its own ± std across the three seeds, and
   the results state in words how the best cell compares to the median cell *relative to that spread*. Where the
   spread swallows the spread of the grid, the finding is "these parameters do not measurably matter on this
   dataset" — which is a real and useful result, not a failed experiment.

#### What the grid is actually for

Three things, none of which is a bigger headline number:

- **Where the knobs bite.** If traverse depth 2 costs 40% more tokens for one point of accuracy, an operator
  wants to know that, and it is exactly the kind of guidance a single benchmark number cannot carry.
- **Whether our defaults are right.** The most valuable outcome is discovering the shipped default is beaten by
  another cell on the held-out conversations — because then we change the default and say so.
- **Where the architecture pays off.** Graph traversal and chrono records should help most on multi-hop and
  temporal questions and least on single-hop. If the per-category grid does not show that, the claim that the
  graph earns its keep is weaker than we thought, and the results say so.

Cost is on every cell, not only accuracy: a configuration that buys two points for triple the retrieval tokens is
a worse default than the one it beats, and the table has to make that visible rather than leaving it to a reader
to work out.

### Ingestion is part of the cost, and is disclosed

How a memory system writes is where the real expense usually sits, and it is what a benchmark that reports only
retrieval accuracy hides. For every system, including ours, the results record:

- what happens per session at write time, in one sentence;
- **tokens sent to any model during ingestion**, per conversation;
- wall-clock to ingest one conversation;
- bytes stored per conversation.

A system that spends a hundred thousand tokens of model extraction per conversation may well be more accurate.
That is a legitimate design, and the number belongs next to the accuracy rather than out of frame.

## The answerer

One model answers for every system, so the comparison is between retrieval and nothing else.

- Model pinned by exact id and version in `pins.json`.
- `temperature: 0`, seed fixed and recorded.
- The answering prompt is in `benchmarks/prompts/answer.md`, used byte-identically for every system. Only the
  retrieved context differs.

## Grading

**Two metrics, reported side by side, always.** They fail in different directions and a claim that only survives
one of them is not a claim.

### 1. Lexical

The metric from the dataset's own paper (F1 against the gold answer for LoCoMo). No model in the loop, so no
prompt sensitivity and no judge bias. It under-credits a correct answer worded differently, which is exactly why
it does not appear alone.

### 2. LLM-as-judge

- The judge prompt is in `benchmarks/prompts/judge.md`, reproduced verbatim in the results, and frozen by this
  protocol.
- Judge model pinned by exact id and version; `temperature: 0`.
- **The judge is blind.** Answers from all systems for one question are shuffled and presented without labels,
  so the judge cannot know which system produced which. The mapping is restored after grading. This costs
  nothing and removes the most obvious source of judge bias; almost no published comparison does it.
- The judge never sees the retrieved context — only the question, the gold answer, and the candidate. Showing it
  the context invites it to grade the retrieval instead of the answer.
- **Judge agreement is measured, not assumed:** a random sample of at least 100 gradings is checked by hand and
  the agreement rate is published. A judge that agrees with a human 70% of the time cannot support a claim of a
  three-point difference, and saying so is more useful than a decimal place.

## Controls

### Control 1: no memory

Question only. Establishes the floor.

### Control 2: full context

The whole conversation in the prompt. Establishes the ceiling and, more usefully, the **exchange rate**: the
headline result we care about is not "we beat a competitor by N points" but *"X% of full-context quality at Y% of
the tokens"*, which is the number that decides whether a memory system is worth running at all.

### Control 3: no-context contamination probe

Every question asked with **no conversation and no retrieval**, to the same answerer. Anything it gets right, it
either memorised from the public dataset or could guess from the question alone.

Two scores are then published for every system:

- **primary** — all questions, the number comparable to everyone else's;
- **contamination-excluded** — the same run with every question the no-context probe answered correctly removed.

The second will be lower. Publishing it is the point: it is the check nobody else runs, and being the party that
reports the deflated number is worth more than the points it costs.

## Runs and variance

- **Three runs per system**, different seeds, everything else identical.
- Report **mean ± standard deviation**, never a single run.
- **Per-conversation scores are published**, so a reader can see whether a lead comes from all ten conversations
  or from one.
- A difference smaller than the standard deviation is reported as **no measured difference**, in those words. On
  a ten-conversation dataset that will happen, and pretending otherwise is how this field lost its credibility.

## Cost and latency, in the same table as accuracy

Accuracy alone flatters whichever system is allowed to spend the most. Every results table carries, per system:

| column | why |
|---|---|
| accuracy (both metrics, ± std) | the claim |
| ingest tokens / conversation | what writing costs |
| retrieval tokens / question | what reading costs |
| p50 / p95 retrieval latency | what a user waits |
| stored bytes / conversation | what it costs to keep |
| **accuracy per 1k retrieval tokens** | the derived number that actually differentiates a memory system |

## The run is tiered, and the floor is publishable

A benchmark nobody can afford to re-run is not reproducible, whatever the harness says. So the run is defined in
tiers, each a superset of the one before, and **the floor is a complete publishable result on its own** rather
than a smoke test.

### Tier 0-R — retrieval only, and it costs nothing

**No model anywhere.** Ythril's embeddings run in-process on a bundled model, so ingestion and retrieval need no
API at all; what needs one is the answerer and the judge. This tier removes both and measures the retriever
directly.

| | |
|---|---|
| metric | **evidence recall@k** — of the turns the gold answer is evidenced by, how many appear in what retrieval returned |
| ingestion | S0 and S0+ — the two model-free rungs |
| retrieval | the seven methods and the 14-cell one-axis-at-a-time grid, in full |
| cost | **zero**, in money and in external calls |

Two numbers, because they answer different questions:

- **all-evidence@k** — every cited turn retrieved. This is the one that matters, because a multi-evidence
  question is not answerable from a subset.
- **any-evidence@k** — at least one. Reported beside it, since the gap between the two IS the cross-session
  difficulty: a question whose evidence spans ten sessions is where the two diverge.

**This is not a consolation prize, and it is not an accuracy number.** It measures something an accuracy number
cannot: retrieval isolated from the answerer. An end-to-end score confounds "did the retriever find it" with
"was the model good at using it", and a weaker answerer flatters a better retriever by failing on both. Evidence
recall has no such term.

**What it cannot say**, stated so no result from it is over-read:

- **Nothing about answer quality**, and nothing comparable to any published LoCoMo accuracy figure. A result
  from this tier is never quoted alongside one from a vendor's leaderboard.
- **Nothing about the adversarial category.** Those questions are designed so the conversation does NOT answer
  them, and their single cited turn is the near-miss passage a retriever is meant to be lured by. Retrieving it
  is not success and not failure; the category is reported separately with that said, never folded into a total.
- **Nothing about questions with no evidence at all** — four of them in the release. Excluded, and the exclusion
  is printed with the count rather than left to a reader to notice a total that does not add up.
- **Nothing about the ingestion rungs that need a model.** S1 through S4 are absent, so the graph claim is
  untested at this tier: S0+ carries the free structure only.

Reported as **Tier 0-R** in every result file, never as Tier 0.

### Tier 0 — the floor

| | |
|---|---|
| dataset | LoCoMo only |
| questions | a **stratified subsample**, fixed seed, proportional across categories including adversarial. The same subsample for every system — that is what keeps it fair — and its size and seed are recorded in the results |
| ingestion | **S0, S0+ and S4** — the free floor, the free structured rung, and the full graph-plus-chrono shape. S0+ adds no model calls, so the extra rung costs only its answering pass |
| retrieval | shipped defaults only, no grid |
| systems | Ythril, the no-memory floor, the full-context ceiling |
| grading | lexical for all; judge once per question over all candidates blind |
| seeds | 1, and the result is labelled exploratory until Tier 1 |

Order of magnitude: **~1,000 model calls**, of which the full-context answers are the expensive ones. The
no-context contamination probe is the same run as the no-memory floor, so it costs nothing extra.

### Tier 1 — reportable

Adds the S2 rung (the shape competitors use, so the comparison is against like), the 14-cell one-axis-at-a-time
grid on lexical grading, **three seeds on the head-to-head only**, and one competing system. Single-digit
thousands of calls.

### Tier 2 — complete

Adds LongMemEval, the remaining ingestion rungs, the full question set rather than a subsample, and the
same-facts-into-both-stores isolation run.

**A tier is only published with its own tier named in the results**, so a Tier 0 number is never quoted as though
it were Tier 2. And a subsampled result says so, with its size, because a wider confidence interval that is
declared is honest and one that is hidden is not.

## Development versus reporting

There is no train split in either dataset, so the risk of tuning on the test set is real and has to be managed
explicitly rather than promised away.

- Conversations used while building the harness are **named** in the results.
- Scores are reported on the full set **and** separately on the conversations never looked at during development.
- If the two differ materially, the untouched number is the headline.

## If we lose

**Every category is published, including the ones where a competitor beats us, and including a losing headline.**

This is not modesty. A selectively reported benchmark is worth less than no benchmark to the only audience that
matters — the reader who checks — and the first person to notice a missing category will be the competitor whose
number we omitted. If Ythril loses a category, the results say so, and the analysis says why, and that is a more
persuasive document than a clean sweep nobody believes.

If the overall result is bad, we publish it and fix the system. The protocol does not get renegotiated.

## What would falsify a claim we make

Stated in advance so it cannot be argued away later:

- a reproduction from the committed harness that lands outside our reported ± std;
- a competitor demonstrating their system was misconfigured, judged against the config we committed;
- a judge-prompt change that moves the ranking — which is why the prompt is frozen here and the lexical metric is
  reported beside it;
- the contamination-excluded score reversing the ranking, which is why it is published rather than kept.

Any of these and the claim is withdrawn and corrected in place, with the correction dated.

## Reproduction

One command, from a clean checkout, with the datasets fetched by `pins.json`:

```bash
npm run bench
```

Raw model outputs — every question, every candidate answer, every judge verdict — are committed under
`benchmarks/results/<date>-<commit>/`. A results table nobody can drill into is a press release.

## Amendments

Append here, dated, with the reason and what was re-run. A silent edit elsewhere in this file invalidates the
runs it covers; this section is how a change stays legitimate.

### Amendment 7 — every rank-1 score is published beside the highest score its question set allows

**2026-09-09, after reading a Tier 0-R result table while trying to raise the number.**

The headline asks whether the single top result held **every** turn the gold answer cites. On the published
199-question sample, 30 of those questions — 15.1% — cite turns from two different sessions of the
conversation. One record built from consecutive turns cannot contain both, at any width. So those questions
are lost before retrieval runs, and **every window rung in the programme is capped at 84.9%**.

That number was not known while the programme was being designed, and not knowing it was expensive. The
window-shape sweep exists to find points that the shape can move; measured against the layout of the
evidence, the whole sweep from a 3-turn window to a 25-turn window is worth at most **one** point. Three of
its cells were still queued as outstanding work. A target was also set above the ceiling, which no honest
run could ever have met.

**Changed:** a Tier 0-R report states the ceiling and the cross-session share in its header, and
`report-tier0r.mjs` refuses to render without them — a rank-1 score with nothing beside it cannot be read as
near or far from the maximum. This is the same defence as the `top record chars` column that Amendment 6
added: a number that can be quoted alone will be.

**It is derived, never written down.** `benchmarks/harness/evidence-shape.mjs` computes it from the pinned
dataset and the seeded sample, because a different `--questions` or `--seed` is a different set of questions
with a different layout, and a constant in prose would be right for exactly one run.

**What the ceiling does not bound, stated so it is not over-read.** Rank-1 credit reaches through a result's
graph expansions — the runner gives an expanded node its parent's rank, because a caller reading result 1
reads them with it. A rung that LINKS turns across sessions can therefore carry a second session's turn into
the first result and is genuinely not capped at 84.9%. The export is named for contiguous windows for that
reason, and nothing asserts that a score is below it.

**Nothing re-run.** No measurement changed and no result moved; this adds a column that was always
computable and was never computed. The existing `2026-09-06-tier0r-rank` report was regenerated from its own
unmodified `rows.json` to carry the line, and every other figure in it is byte-identical.

### Amendment 6 — the retrieval headline is a RANK, because coverage can be brute-forced

**2026-09-06.** Owner's ruling, after reading a Tier 0-R score that had been raised from 66% to 90%: *"do not
cheat... first answer must be right - it must reflect reality, not brute force."*

Amendment 4 defined Tier 0-R's metric as **all evidence** — every turn the gold answer cites appeared somewhere
in the `topK` results. That metric is accurate and it is nearly meaningless, which is a worse combination than
being wrong. A retrieval score can be raised two ways:

1. **Rank the right record first.** Hard, and it is what retrieval means.
2. **Return more of the conversation per record**, so the evidence gets swept up somewhere inside `topK`.
   Trivial, produces a much larger number, and is not retrieval at all — a caller still has to read every
   result to find the answer.

The second is not cheating in the sense of breaking a rule. It is worse: it satisfies the metric exactly as
written, so it survives every review by being *true*. **A benchmark whose metric can be satisfied without doing
the work is not measuring the work.**

**What the tier reports from here.** The headline is `all at rank 1` — did the single top-ranked record hold
every turn the answer cites. There is only one first result, so nothing can be padded into it.

| column | what it answers | why it is in the headline |
|---|---|---|
| `all at rank 1` | did result 1 hold all the evidence | the only score no amount of coverage can inflate |
| `top record chars` | how big result 1 was | closes the one cheat rank-1 still has, below |
| `MRR` | reciprocal of the first evidence hit's rank | a miss counts 0, never dropped from the mean |
| `mean depth` | how far down the caller had to read for all of it | what a reader actually pays |
| `all evidence` | the Amendment 4 metric | retained, demoted, never quoted alone |

**`all at rank 1` has exactly one cheat, and the column beside it closes it.** A rung that put the entire
transcript into one record would rank it first, and it would contain every evidence turn — 100%, with no
retrieval performed. So the size of that first record is printed next to the score it earned. A high rank-1
score beside a large top record is a transcript being handed back. Read together or neither means anything.

**The two are not the same measurement, and the divergence is measured rather than argued.** On a
single-conversation run, the strategy with the MOST coverage — 94.9 source turns reached per query, against 47.4
and 71.5 for the other two — scored the WORST at rank 1, 6.3% against 43.8% and 75.0%. Gathering more text near
a query is not the same as ranking the right text first, and under the old metric that strategy would have
looked competitive.

**Re-run: everything.** Every Tier 0-R number produced before this date was a coverage number, and no coverage
number is republished without its rank columns beside it. The rows already on disk are kept and re-scored where
the run recorded enough to do so; where it did not, the run is repeated rather than the number being carried
forward.

### Amendment 5 — the grid's axis values, pinned before the first cell ran

**2026-08-29.** The grid was specified by its axes and not by its values. `topK` named four numbers, but
`minScore` said *"off, and one threshold chosen at pin time from the score distribution"* and `budgetBytes` said
*"the MCP default, the REST default, and one deliberately tight value"* — three placeholders that a later reader
would have had to take on trust, and that the harness refused to invent. `gridCells` errors rather than guessing,
which is how this gap was found: **a module that will not make up a threshold cannot be run until somebody
commits to one.**

Pinned now, before any grid cell has been executed:

| axis | values | where they come from |
|---|---|---|
| `topK` | 5, 10, 20, 50 | unchanged from the original protocol |
| `traverse` depth | 0, 1, 2 | unchanged |
| `budgetBytes` | 25 000, 100 000, 8 000 | the MCP door's default, the REST door's default, and the tight value |
| `minScore` | off, and one threshold | **a rule, not a number** — see below |

**Why 8 000 is the tight value and not a rounder number.** It is roughly a third of the MCP default, which is the
smallest budget where a `topK: 20` request can still return twenty short records rather than being truncated by
construction. A tight budget that truncates every cell measures the truncator, not the retrieval.

**`minScore` is pinned as a RULE because a number pinned today would be a number invented today.** The threshold
has to come from the observed score distribution, and no scores have been observed yet. So the rule is committed
instead, and it is deterministic — given the same first run, anybody re-deriving it gets the same number:

> The threshold is the **25th percentile of the scores of records that were actually retrieved** in the Tier 0-R
> default-cell run, taken across all conversations and both model-free rungs, rounded to three decimals.

Two properties make this honest. It is computed from a run that **does not grade accuracy against it** — Tier 0-R
at the default cell applies no threshold at all, so the distribution is not selected by how well the threshold
performs. And it is fixed before the cell that uses it runs, so it cannot be tuned toward a result.

**Nothing re-run.** No grid cell had executed when this was written.

### Amendment 4 — a retrieval-only tier, added because there is no answerer

**2026-08-29, before the run it defines.**

The machine this was first run on has no model credentials and no local model: `config/secrets.json` carries only
peer tokens and a signing key, no API key is in the environment, and no OpenAI-compatible endpoint answers on any
of the usual local ports. Checked rather than assumed. So the answer-and-judge half of every tier is blocked on
something only the owner can supply.

What is NOT blocked is everything else: Ythril's embeddings run in-process on a bundled model, so ingestion and
retrieval cost nothing and need no network.

Added **Tier 0-R**, defined above, which measures evidence recall@k — the retriever directly, with the answerer
removed. It was written and committed BEFORE the run, which is the same rule every other tier is held to and the
reason this amendment exists rather than a results file appearing with a metric nobody had agreed.

The temptation this forecloses: running the retrieval, seeing which numbers look good, and *then* deciding what
to call the metric. That is the ordering this whole document exists to make impossible, and a blocked dependency
is not a licence to suspend it.

### Amendment 3 — the DESIGN is question-blind too, not just the run

**2026-08-29, before any run.**

The protocol originally allowed the ingestion design to use aggregate, structural statistics about the questions
— evidence counts, cross-session rates — while forbidding the ingest code from reading them at run time. The
owner rejected that, and the argument is better than the one it replaced: *"I prefer the actual usage experience
to be great and therefore work for every dataset the user might have."*

He is right. Fitting a record model to one corpus's proportions is not merely benchmark-adjacent cheating; it
produces a worse product, and it produces exactly the kind of number that collapses when somebody runs it on
their own data.

Changed: the design phase and its synthesis are given **nothing derived from the questions** — not content, not
counts, not category distributions. Every element of the specification carries a justification that a user with
entirely different data would accept, and the design work was re-run under that rule rather than filtered
afterwards. Question-derived statistics survive only as a dataset characterisation, used after results exist to
explain why a rung helped here.

**Nothing re-run in the benchmark sense — nothing has been run.** The design exploration was re-run, which is the
point: the rule was applied before the specification existed rather than to a specification already shaped.

### Amendment 2 — a free rung, S0+, between raw turns and summaries

**2026-08-29, before any run.**

Added `S0+`: raw turns plus the structure the dataset already states — speakers as entities, one `chrono` per
session with its real timestamp, turn-to-speaker edges. **No model call**, so it costs nothing to run and nothing
to re-run.

The prompt was the owner asking why filling Ythril needs model calls at all, which it does not — writing records
is deterministic HTTP, and only *deciding what to write* needs a model. That question exposed a rung the ladder
was missing: between "store the text" and "have a model read it" there is "use what the source already tells
you", and on this dataset that includes every session's date. Verified against `locomo10.json` before adding it:
`speaker_a`, `speaker_b` and `session_N_date_time` are all present and parseable, and turns carry a `dia_id` the
QA pairs reference as evidence.

Numbering: inserted as **S0+** rather than renumbering S1–S4, because renumbering a pre-registered ladder makes
every earlier reference ambiguous for the sake of tidiness.

**Nothing re-run — nothing has been run.**

### Amendment 1 — the grid is one axis at a time, and the run is tiered

**2026-08-28, before any run.**

The first version of this protocol specified a full-factorial grid and gave no bound on the total, which came to
hundreds of millions of model calls once multiplied by ingestion strategies, seeds, and an answer-plus-judge pair
per question. That was a specification error rather than a change of mind, and nothing had been run against it.

Changed: the sweep is one-axis-at-a-time from the shipped default (14 cells, not 144); grid cells are graded
lexically with the best and worst three also judged as a ranking check; extraction output is cached and
committed; one judge call grades every candidate for a question, which the blind shuffle already made possible;
and the run is defined in three tiers with a publishable floor of roughly a thousand calls.

**Nothing re-run, because nothing had been run.** Recorded anyway — an amendment made before the first result is
exactly as much a part of the record as one made after, and a protocol whose amendment log starts only when it
becomes embarrassing is not a protocol.
