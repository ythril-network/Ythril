# LoCoMo

Ten conversations between two people, each running over weeks in dated sessions, with questions whose answers
are spread across them. It is the benchmark most memory products quote, which is the main reason it is here.

| | |
|---|---|
| source | `snap-research/locomo`, pinned by sha256 in `pin.json` |
| measured from the file | 10 conversations, 272 sessions, 5,882 turns, 1,986 questions |
| categories | 1 multi-hop, 2 temporal, 3 open-domain, 4 single-hop, 5 adversarial |
| `loader.mjs` | parses it into the harness's neutral shape |
| `extractions/` | one committed JSON file per conversation — the model's output, pinned |

**The dataset is pinned, not vendored.** It is fetched by URL and refused if the hash does not match.
Redistributing somebody else's dataset inside this repository would put us in the business of hosting it, and
a local copy is one more thing that can drift from what the authors publish.

**It may not be edited.** Not to repair a malformed evidence reference, not to normalise a date. Nine
references in the public release are malformed; the loader repairs them in memory and documents every one of
them in its own header, so the repair is visible and the file on disk is what the authors published.

## The two doors, and why they are separate

`loadConversations` returns objects carrying no question data at all — not the evidence ids, not the
categories, not a count. That is not tidiness. The strongest way to overfit a memory benchmark is to shape
extraction around the answer key, and it is invisible from a results table: nobody can tell that a prompt was
iterated thirty times against the gold answers. A gate refuses an ingest module that so much as names the
question set, and this is the other half — even a module that wanted the key has nothing to reach.

## What is known about the ceiling

The approach this folder replaced stored transcript windows and could not exceed **84.9%** on the retrieval
measure, no matter how the windows were cut: a multi-hop question needs two remarks from sessions weeks
apart, and no run of consecutive turns holds both. That is a ceiling for that method, not for the dataset,
and it is why the current approach stores resolved facts instead. See `../DEVELOPMENT-LOG.md`.

## Comparing to a published figure

Numbers quoted for LoCoMo are usually **judged answer accuracy** — a model reads what memory returned and
answers, and a second model grades it. Ours is currently **retrieval rank**: did the cited turns come back,
and did they come back first. Those are different measurements and the rank one is the harder of the two to
flatter, because an answering model can be right about a question whose evidence never arrived.

Bench'd, which runs systems independently rather than accepting their numbers, scores LlamaIndex at 54.8% and
LangChain at 51.9% on 1,540 of these questions, against a no-memory baseline of 50.4% — while Mem0 self-reports
68.5%. Read any LoCoMo percentage together with who ran it and over how many questions.
