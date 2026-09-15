# LongMemEval

500 questions over long chat histories, testing five named memory abilities. It is the benchmark that asks
the thing LoCoMo does not: **whether a system knows when it does not know.**

| | |
|---|---|
| source | `xiaowu0162/LongMemEval` (ICLR 2025), data on Hugging Face |
| instances | 500, in three variants |
| abilities | information extraction, multi-session reasoning, knowledge updates, temporal reasoning, **abstention** |
| judged by | a model, against the reference answer |
| state here | pinned in `pin.json`, not yet fetched and not yet run |

## The three variants, and which one is the honest test

| variant | chat history | what it measures |
|---|---|---|
| `longmemeval_oracle` | only the sessions holding the evidence | the answerer, with retrieval removed |
| `longmemeval_s` | ~115k tokens, about 40 sessions | memory against a long context window that can hold it all |
| `longmemeval_m` | about 500 sessions | memory where no context window can hold it |

**`_s` is the one to run first and `_m` is the one that matters.** At 115k tokens a frontier model can simply
be handed the whole history, so a memory system that does not beat that has not earned its place — this is
the finding an independent harness keeps reproducing, that raw context outperforms most memory products
because they compress faster than they organise. `_m` is where no such shortcut exists. `_oracle` is a
control: it measures the answering model, so it is the number to subtract rather than the number to quote.

## Why abstention is the interesting column

Four of the five abilities have a LoCoMo equivalent. Abstention does not: the question is answerable only if
the history never contained the answer, and the correct output is to say so. A system that retrieves
something plausible for every query scores well everywhere else and fails here, which is exactly the failure
mode a confident reranker produces — measured on our own corpus, the wrong cross-encoder scored 0.9958 for
the right passage against 0.9969 for a wrong one and overturned the ranking on every query.

That makes this benchmark the one worth running **against ourselves** rather than against a leaderboard: it
names a defect we have already produced once, in a column where nothing else would show it.

## The one comparable published number, and what it costs to match

`gbrain` (MIT, 30k stars) publishes **strict `recall_all@5`** on LongMemEval-S: a question counts only when
**every** gold session lands in the top five distinct sessions. That is the same family as our measure and
the only competitor figure on the same axis — their own README says so: *"the 94 to 96% figures quoted for
Mastra, Mem0, MemCog, Supermemory and others are LLM-judged answer accuracy, a different race that scores the
reader and judge as much as the memory."*

| measured, gbrain v0.48.4.0, 2026-09-06, 470 scored, k=5 | |
|---|---|
| strict `recall_all@5`, no reranker | **93.40%** (439/470) |
| strict `recall_all@5`, `voyage:rerank-2.5` | **95.53%** (449/470) |
| loose any-hit `recall_any@5` | 98.72% / 99.79% — published as a diagnostic, not a headline |
| the k=5 ceiling | **99.4%**, because three questions carry six gold sessions |
| their first judged-answer number | 86.6% (433/500), Sonnet reader + gpt-4o judge |

**The denominator is 470, not 500.** The official scorer drops the 30 abstention questions from the
retrieval metric, because a question whose answer was never in the history has no gold session to retrieve.
Abstention is still the interesting column — it just belongs to the judged track, not this one.

**The gap between 95.53% retrieved and 86.6% answered is the READER, not the memory.** 449 questions had
every gold session retrieved and the reader converted 396 of them. Whatever we score on retrieval, a judged
run will land roughly ten points below it, and that is the answering model’s tax rather than ours — which is
the argument for reporting both columns and the baseline beside them.

## Three things somebody else already measured, so we do not have to

All three from gbrain’s own runs on this dataset, and all three are negative results — the expensive kind to
buy yourself:

1. **Dropping the tail of a result set destroys multi-evidence questions.** Their shipped default used
   "autocut" — keep the best session, drop the rest — and scored **379/470** against 449 with it off. **300
   of the 470 scored questions need two or more sessions.** Any heuristic that trims a result set to what
   looks best is a heuristic that answers single-evidence questions and fails the majority. Ours is the byte
   budget, and it trims by size rather than by confidence — which is the version that does not do this.
2. **Expanding one question into several queries is harmful at small k.** LLM multi-query expansion scored
   **255/470** against plain hybrid’s 449 — paired, it gained 3 questions and lost 187 — and even tuned to
   its best setting it stayed 43 questions behind. This is the direct answer to *"why not deconstruct the
   question into two recalls?"*: measured, at scale, by somebody else, it is strongly negative at k=5. The
   variants dilute the ranking, and a strict all-gold-in-top-5 metric punishes dilution hardest.
3. **Hybrid fusion buys nothing on this benchmark.** Pure vector scored 93.8% against hybrid’s 93.40% — they
   call it "roughly neutral on this benchmark and earns its keep elsewhere." We RRF-fuse vector and lexical
   too, so the honest expectation is that fusion is not where a LongMemEval number comes from.

What did move their number: a **cross-encoder reranker**, +2.13 points (gaining 18 questions, losing 8). Which
is the same conclusion our own corpus produced, including the sign flip on a badly chosen model.

## Before it can run

1. **Fetch and pin.** `pin.json` carries the URL and no hash. The first fetch records the sha256 and the byte
   count, and every fetch after that is refused on a mismatch — the same rule as LoCoMo.
2. **Confirm the licence.** Not stated in the repository's README. It is answered in `pin.json` before any
   result from this dataset is published, not assumed permissive.
3. **A loader with the same two doors.** Histories out of one function carrying no question data, questions
   out of another. The LoCoMo loader is the model for it.
4. **An answerer and a judge**, because there is no rank-only version of this benchmark: the abstention
   questions have no evidence to retrieve, so "did the evidence come back" is undefined for them. That makes
   this dependent on `B-2`.
