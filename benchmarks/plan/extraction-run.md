# How one conversation gets extracted

This is the procedure, written down because it has now been run thirty times across three rounds and each
round began by reconstructing it slightly differently. A reconstructed procedure is how a corpus ends up
produced by two protocols, which is the defect `producedBy` exists to catch — so the protocol itself is a
file rather than a paragraph somebody remembers.

**It is written for whoever is extracting ONE conversation, in a context that has seen nothing else.** That
isolation is the point: an extractor that has seen another conversation's records, or any retrieval score,
is doing development rather than producing evidence.

**Two or three conversations at a time, never ten.** Measured 2026-09-20: ten extractors launched together
exhausted the session window in about twenty minutes and finished **none** of them, every one dying between
reading its conversation and writing its file. Three at a time finished three in the same wall-clock. Launch
the next only as one comes back.

## What you may read, and what you may not

| | |
|---|---|
| read | `benchmarks/prompt/extraction.md` — the rules, in full, first |
| read | `benchmarks/plan/extraction-format.md` — the shape of the file you are producing |
| read | `benchmarks/space/schema.json` — the types, labels and enums that exist |
| read | the conversation, dumped by the command below |
| **never** | the LoCoMo release file directly, any `*questions*`, any answer key, any score |

`node benchmarks/bench.mjs dump` is the only door that hands back a conversation with the questions,
answers and evidence ids removed. Reading the release with `JSON.parse` is one line shorter and it carries
the answer key, which is why nothing here does it.

## Before you start: find out what is already done

```bash
node benchmarks/bench.mjs status
```

`done` means extracted **under the prompt now in the tree**. `RE-DO` is a file from an earlier prompt and
needs extracting again. A line ending `2/4 parts written, resume at part 3` is a conversation an earlier
session got part-way through — **pick up at that part, do not start again.**

## The steps

```bash
node benchmarks/bench.mjs dump conv-NN > <your own scratch dir>/conv-NN.md
```

Read the prompt. Read the conversation.

**Write it in parts of about ten sessions**, because one reply carrying 130 KB of JSON is where a long
extraction gets truncated in the middle of an array. Each part is a file carrying only the sessions,
entities, chrono, edges and claims of its own session range, plus:

- `"conversationId": "conv-NN"` on every part
- `"part": { "index": 1, "of": 4 }` — the merge refuses an incomplete run, and this is what lets it
- `"producedBy": { "promptSha256": "<the sha `status` printed>", "unattended": true }` on **every** part

**The parts go in `benchmarks/.cache/extraction-parts/conv-NN/`, named `part1.json`, `part2.json`, …**, and
NOT in a session scratch directory. A scratch directory is wiped between sessions, which is exactly when
the parts are needed: a round killed by a rate limit used to lose everything it had written, and the next
session started again at part 1. Write each part the moment it is finished rather than at the end.

**The fingerprint on every part is not bookkeeping.** Parts that survive a session survive a prompt change,
and merging last week's parts with today's produces one conversation described under two sets of rules —
which `bench.mjs merge` would then stamp with a single fingerprint, so nothing downstream could see it. A
resume refuses a directory whose parts name a different prompt. If that happens, delete the directory and
extract the conversation again.

**Carry the entity keys forward.** A person named in session 3 and again in session 30 is one node, so a
later part reuses the key the earlier part minted rather than inventing a second. The merge reconciles by
key and refuses a key that comes back with a different type.

`unattended: true` is an attestation, not a formality. It says no retrieval score was visible while this
was written. If one was, write `false` — a file that lies here is worse than one that is honest about being
development, because every figure taken across the corpus afterwards is unattributable.

Then join and check:

```bash
node benchmarks/bench.mjs merge benchmarks/.cache/extraction-parts/conv-NN/part*.json > benchmarks/locomo/extractions/conv-NN.json
node benchmarks/bench.mjs check benchmarks/locomo/extractions/conv-NN.json
```

`merge` stamps the prompt's fingerprint from the working tree, which is why it is not optional even for a
single part. `check` reports every problem at once and refuses the file until there are none — including
the one the file cannot see about itself, which is whether its records belong to the conversation it names.

## A script may assemble the file, but it may not write the claims

Building the JSON with a small script in your scratch directory is fine and is often the only way to get
the turn lists right. **What must not be generated is the content**: a claim derived by a rule from a turn's
text is a transcript line with a template around it, which is the one failure the whole prompt is written
against. Every claim, description and title is written by reading. If a script is emitting sentences, stop.

## Done means

`check` prints `valid` **and** `all N declared turns are named by a claim`. A `WARNING` about uncovered
turns is not done: an extraction that kept only the turns that seemed to say something covered 34.6% of a
conversation and scored worse than storing the raw turns.
