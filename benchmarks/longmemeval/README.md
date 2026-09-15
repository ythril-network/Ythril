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
