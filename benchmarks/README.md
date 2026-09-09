# Ingesting a conversation into Ythril

Two steps. The first needs a model. The second does not, and anyone can run it.

```text
conversation  ──model──▶  extractions/<id>.json  ──writer──▶  a Ythril space
```

## Taking this on

Hand a session this: **read `benchmarks/prompt/extraction.md` and follow it for `<conversationId>`.** That
prompt is self-contained — it names the vocabulary, the rules and the output shape, and it reads them from
this repository rather than restating them.

Any model of comparable reasoning strength can do it. Nothing in the prompt depends on which one. If two
models produce noticeably different graphs from the same conversation, that is a fact about the prompt and it
belongs in the results.

## What is here

| | |
|---|---|
| `space/` | the schema, the space's purpose, and how to write to it and read from it |
| `plan/` | how ingestion works, and the exact shape of an extraction file |
| `prompt/` | the extraction prompt — the one step that needs a model |
| `dataset/` | the LoCoMo loader, for the benchmark. Not needed to ingest anything else |
| `extractions/` | one committed JSON file per conversation: the model's output, pinned |

## Why the extraction is committed

Extraction needs a model; replaying it does not. Pinning the output as data means the exact graph can be
rebuilt from this repository by anybody, and every record in it can be checked against the transcript it came
from. Only re-deriving an extraction needs a model of your own.

## Using it without the benchmark

The dataset loader is the only benchmark-specific part. Give the prompt any conversation in the shape it asks
for — sessions with dates, turns with a speaker and text — and the same two steps produce the same kind of
space. The schema was written for conversations in general, not for this corpus.

## The rule the whole thing rests on

**Extraction never sees a question.** Not the text, not the answers, not the categories. A graph built while
looking at the questions scores well on them and describes nothing else. If that rule is broken for a
conversation, it is recorded next to that conversation's number rather than left to be inferred.
