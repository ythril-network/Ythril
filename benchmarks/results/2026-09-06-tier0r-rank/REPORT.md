# Tier 0-R — evidence recall, no model anywhere

**Run:** 2026-09-06 · commit `2c2afc96` · ythril/ythril:4.0.0
**Dataset:** LoCoMo, sha256 `79fa87e90f040813…`
**Questions:** 199 sampled from 1982 answerable (4 excluded: no evidence cited)
**Retrieval:** `recall` at the shipped default, `topK: 60`, no traverse, no threshold
**Model calls:** 0
**Ceiling:** 84.9% for any rung whose answering record is a run of consecutive turns — 30 of 199 questions (15.1%) are **cross-session**, citing turns from different sessions, and no window of any width holds both. A rung that LINKS turns across sessions is not bound by it: rank-1 credit reaches through a result's graph expansions.

## What this measures, and what it does not

For each question, the turns the gold answer cites as evidence are known. The retrieval is run and
the question asked is: **did those turns come back?** That is all. Specifically:

- **Recall is not accuracy.** A retrieved turn does not mean a model would answer correctly from it.
- **A miss is not necessarily a failure.** The same fact is often restated elsewhere in the
  transcript, so an answer may be available from a turn the gold key does not cite.
- **The headline is rank 1, because coverage can be brute-forced and rank cannot.** The owner ruled it
  on 2026-09-06: *"first answer must be right - it must reflect reality, not brute force."*
  Whether the evidence appeared *somewhere* in twenty results is a weak question — a strategy that
  packs more of the conversation into every record wins it without ever having ranked the right
  thing first, and a caller still has to read all twenty. `all at rank 1` asks whether the single
  top result held everything the answer cites. There is only one first result, so nothing can be
  padded into it.
- **And `all at rank 1` has its own cheat, which the column beside it closes.** One record holding
  the entire conversation would rank first and contain every evidence turn, scoring perfectly while
  doing no retrieval at all. `top record chars` is how big that first result was: a high rank-1
  score next to a large top record is a transcript being handed back, not a question being
  answered. Read the two together or neither means anything.
- **`mean depth` is what a caller actually pays.** How far down the list they had to read before
  holding all the evidence. A strategy can raise `all evidence` from 66% to 90% while pushing this
  from 4 to 18 — worse retrieval, sold as better.
- **"Adversarial" does not mean unanswerable here.** Category 5 is named adversarial and it is easy to
  assume that means the answer is absent from the transcript — it is not. In this release all 446 of
  them cite evidence and carry a real answer, in a separate `adversarial_answer` field rather than
  the usual one. They score like any other single-hop category and are read that way below.

## Overall

| rung | questions | all at rank 1 | top record chars | all within 3 | MRR | mean depth | all evidence | any evidence | mean records | mean turns covered | mean ms |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `s0` | 199 | **31.7%** | 177 | 46.2% | 0.513 | 5.7 | 73.4% | 81.9% | 48.5 | 48.5 | 260 |
| `s0e` | 199 | **10.6%** | 1322 | 17.6% | 0.228 | 4.1 | 31.7% | 45.2% | 14.3 | 96.9 | 40 |
| `s0w` | 199 | **50.8%** | 717 | 69.3% | 0.703 | 2.9 | 86.4% | 92.5% | 21.9 | 77.7 | 57 |
| `s0wd` | 199 | **50.8%** | 779 | 66.3% | 0.709 | 2.9 | 86.9% | 93.5% | 20.7 | 73.6 | 117 |

## By question category

**`s0`**

| category | questions | all at rank 1 | all within 3 | MRR | all evidence | any evidence |
|---|---|---|---|---|---|---|
| 1 — multi-hop | 28 | **0.0%** | 14.3% | 0.553 | 46.4% | 85.7% |
| 2 — temporal | 32 | **46.9%** | 62.5% | 0.611 | 87.5% | 93.8% |
| 3 — open-domain | 9 | **44.4%** | 44.4% | 0.676 | 66.7% | 77.8% |
| 4 — single-hop | 85 | **45.9%** | 60.0% | 0.590 | 82.4% | 85.9% |
| 5 — adversarial | 45 | **11.1%** | 28.9% | 0.241 | 64.4% | 64.4% |

**`s0w`**

| category | questions | all at rank 1 | all within 3 | MRR | all evidence | any evidence |
|---|---|---|---|---|---|---|
| 1 — multi-hop | 28 | **0.0%** | 14.3% | 0.590 | 46.4% | 85.7% |
| 2 — temporal | 32 | **46.9%** | 75.0% | 0.681 | 90.6% | 93.8% |
| 3 — open-domain | 9 | **33.3%** | 55.6% | 0.504 | 77.8% | 77.8% |
| 4 — single-hop | 85 | **65.9%** | 78.8% | 0.754 | 95.3% | 95.3% |
| 5 — adversarial | 45 | **60.0%** | 84.4% | 0.733 | 93.3% | 93.3% |

**`s0e`**

| category | questions | all at rank 1 | all within 3 | MRR | all evidence | any evidence |
|---|---|---|---|---|---|---|
| 1 — multi-hop | 28 | **3.6%** | 3.6% | 0.388 | 10.7% | 78.6% |
| 2 — temporal | 32 | **21.9%** | 31.3% | 0.330 | 53.1% | 62.5% |
| 3 — open-domain | 9 | **0.0%** | 0.0% | 0.148 | 0.0% | 22.2% |
| 4 — single-hop | 85 | **10.6%** | 18.8% | 0.187 | 31.8% | 35.3% |
| 5 — adversarial | 45 | **8.9%** | 17.8% | 0.150 | 35.6% | 35.6% |

**`s0wd`**

| category | questions | all at rank 1 | all within 3 | MRR | all evidence | any evidence |
|---|---|---|---|---|---|---|
| 1 — multi-hop | 28 | **0.0%** | 3.6% | 0.626 | 42.9% | 85.7% |
| 2 — temporal | 32 | **53.1%** | 81.3% | 0.726 | 93.8% | 96.9% |
| 3 — open-domain | 9 | **33.3%** | 55.6% | 0.559 | 77.8% | 77.8% |
| 4 — single-hop | 85 | **64.7%** | 76.5% | 0.754 | 96.5% | 96.5% |
| 5 — adversarial | 45 | **57.8%** | 77.8% | 0.694 | 93.3% | 93.3% |

## By how much evidence the question needs

The column that matters most. A question citing one turn needs one hit; a question citing four needs
all four before `all evidence` counts it. If the strict score falls away as the evidence count rises,
that is the multi-hop weakness the graph is supposed to address — and it is measurable here, before
any model is involved.

**`s0`**

| evidence turns | questions | all at rank 1 | mean depth | all evidence | any evidence |
|---|---|---|---|---|---|
| 1 | 160 | **39.4%** | 5.0 | 80.6% | 80.6% |
| 2 | 21 | **0.0%** | 9.4 | 66.7% | 81.0% |
| 3 | 8 | **0.0%** | 18.0 | 25.0% | 100.0% |
| 4 | 4 | **0.0%** | — | 0.0% | 100.0% |
| 5 or more | 6 | **0.0%** | 17.0 | 16.7% | 83.3% |

**`s0w`**

| evidence turns | questions | all at rank 1 | mean depth | all evidence | any evidence |
|---|---|---|---|---|---|
| 1 | 160 | **61.3%** | 2.2 | 93.1% | 93.1% |
| 2 | 21 | **14.3%** | 7.3 | 85.7% | 95.2% |
| 3 | 8 | **0.0%** | 9.0 | 37.5% | 87.5% |
| 4 | 4 | **0.0%** | 4.0 | 25.0% | 75.0% |
| 5 or more | 6 | **0.0%** | 14.0 | 16.7% | 83.3% |

**`s0e`**

| evidence turns | questions | all at rank 1 | mean depth | all evidence | any evidence |
|---|---|---|---|---|---|
| 1 | 160 | **12.5%** | 4.1 | 36.9% | 36.9% |
| 2 | 21 | **0.0%** | 4.3 | 14.3% | 76.2% |
| 3 | 8 | **12.5%** | 1.0 | 12.5% | 87.5% |
| 4 | 4 | **0.0%** | — | 0.0% | 50.0% |
| 5 or more | 6 | **0.0%** | — | 0.0% | 100.0% |

**`s0wd`**

| evidence turns | questions | all at rank 1 | mean depth | all evidence | any evidence |
|---|---|---|---|---|---|
| 1 | 160 | **61.9%** | 2.5 | 93.8% | 93.8% |
| 2 | 21 | **9.5%** | 5.4 | 81.0% | 95.2% |
| 3 | 8 | **0.0%** | 8.3 | 50.0% | 100.0% |
| 4 | 4 | **0.0%** | 4.0 | 25.0% | 75.0% |
| 5 or more | 6 | **0.0%** | 12.0 | 16.7% | 83.3% |

## Per conversation

Included because a mean over ten conversations can hide one that failed completely, and a reader who
cannot see the spread has to take the mean on trust.

**`s0`**

| conversation | questions | all evidence | any evidence |
|---|---|---|---|
| conv-26 | 16 | 81.3% | 81.3% |
| conv-30 | 12 | 75.0% | 75.0% |
| conv-41 | 12 | 91.7% | 100.0% |
| conv-42 | 33 | 66.7% | 69.7% |
| conv-43 | 22 | 72.7% | 81.8% |
| conv-44 | 15 | 66.7% | 80.0% |
| conv-47 | 20 | 75.0% | 85.0% |
| conv-48 | 28 | 78.6% | 89.3% |
| conv-49 | 25 | 72.0% | 84.0% |
| conv-50 | 16 | 62.5% | 81.3% |

**`s0w`**

| conversation | questions | all evidence | any evidence |
|---|---|---|---|
| conv-26 | 16 | 93.8% | 93.8% |
| conv-30 | 12 | 100.0% | 100.0% |
| conv-41 | 12 | 75.0% | 91.7% |
| conv-42 | 33 | 84.8% | 90.9% |
| conv-43 | 22 | 95.5% | 95.5% |
| conv-44 | 15 | 73.3% | 93.3% |
| conv-47 | 20 | 95.0% | 95.0% |
| conv-48 | 28 | 85.7% | 92.9% |
| conv-49 | 25 | 84.0% | 88.0% |
| conv-50 | 16 | 75.0% | 87.5% |

**`s0e`**

| conversation | questions | all evidence | any evidence |
|---|---|---|---|
| conv-26 | 16 | 18.8% | 25.0% |
| conv-30 | 12 | 33.3% | 33.3% |
| conv-41 | 12 | 16.7% | 41.7% |
| conv-42 | 33 | 30.3% | 48.5% |
| conv-43 | 22 | 36.4% | 59.1% |
| conv-44 | 15 | 20.0% | 33.3% |
| conv-47 | 20 | 45.0% | 50.0% |
| conv-48 | 28 | 32.1% | 39.3% |
| conv-49 | 25 | 36.0% | 56.0% |
| conv-50 | 16 | 37.5% | 50.0% |

**`s0wd`**

| conversation | questions | all evidence | any evidence |
|---|---|---|---|
| conv-26 | 16 | 93.8% | 93.8% |
| conv-30 | 12 | 91.7% | 91.7% |
| conv-41 | 12 | 75.0% | 91.7% |
| conv-42 | 33 | 84.8% | 93.9% |
| conv-43 | 22 | 100.0% | 100.0% |
| conv-44 | 15 | 80.0% | 100.0% |
| conv-47 | 20 | 95.0% | 95.0% |
| conv-48 | 28 | 85.7% | 92.9% |
| conv-49 | 25 | 84.0% | 88.0% |
| conv-50 | 16 | 75.0% | 87.5% |
