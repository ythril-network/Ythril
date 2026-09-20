# How one conversation gets extracted

This is the procedure, written down because it has now been run thirty times across three rounds and each
round began by reconstructing it slightly differently. A reconstructed procedure is how a corpus ends up
produced by two protocols, which is the defect `producedBy` exists to catch — so the protocol itself is a
file rather than a paragraph somebody remembers.

**It is written for whoever is extracting ONE conversation, in a context that has seen nothing else.** That
isolation is the point: an extractor that has seen another conversation's records, or any retrieval score,
is doing development rather than producing evidence.

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

## The steps

```bash
node benchmarks/bench.mjs dump conv-NN > <your own scratch dir>/conv-NN.md
```

Read the prompt. Read the conversation. Then write the extraction into **your own** scratch directory — not
a shared one, and not `benchmarks/`. A shared scratch directory clobbered three extractions in one round.

**Write it in parts of about ten sessions**, because one reply carrying 130 KB of JSON is where a long
extraction gets truncated in the middle of an array. Each part is a file carrying only the sessions,
entities, chrono, edges and claims of its own session range, plus:

- `"conversationId": "conv-NN"` on every part
- `"part": { "index": 1, "of": 4 }` — the merge refuses an incomplete run, and this is what lets it
- `"producedBy": { "unattended": true }` on the FIRST part only

**Carry the entity keys forward.** A person named in session 3 and again in session 30 is one node, so a
later part reuses the key the earlier part minted rather than inventing a second. The merge reconciles by
key and refuses a key that comes back with a different type.

`unattended: true` is an attestation, not a formality. It says no retrieval score was visible while this
was written. If one was, write `false` — a file that lies here is worse than one that is honest about being
development, because every figure taken across the corpus afterwards is unattributable.

Then join and check:

```bash
node benchmarks/bench.mjs merge <scratch>/conv-NN.part1.json <scratch>/conv-NN.part2.json > benchmarks/locomo/extractions/conv-NN.json
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
