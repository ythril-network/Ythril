# Benchmarks

Three public benchmarks measure what this folder is about: whether a memory system can answer a question
about something it was told earlier. One is being run here, one is prepared, one does not exist yet.

| folder | benchmark | what it asks | state here |
|---|---|---|---|
| `locomo/` | LoCoMo | can you answer a question about a conversation that ran over weeks | running; one conversation ingested |
| `longmemeval/` | LongMemEval | five named memory abilities, including knowing when to say you do not know | pinned, not yet run |
| `memoryarena/` | MemoryArena | does memory make an agent finish the task, not just recall the fact | not released by its authors |

Everything **above** those folders is shared: the schema, the ingestion prompt and the writer are not about
any benchmark, they are how a conversation becomes a Ythril space. A benchmark folder holds only what belongs
to that benchmark — its dataset pin, its loader, and the extractions made from it.

| | |
|---|---|
| `space/` | the importable schema, the space's purpose, and how to write to it and read from it |
| `plan/` | how ingestion works, and the exact shape of an extraction file |
| `prompt/` | the extraction prompt — the one step that needs a model |
| `writer/` | the deterministic half: validate an extraction, then replay it into a space |
| `DEVELOPMENT-LOG.md` | the measurements, including the ones that were wrong |

## Ingesting a conversation

Two steps. The first needs a model. The second does not, and anyone can run it.

```text
conversation  ──model──▶  <benchmark>/extractions/<id>.json  ──writer──▶  a Ythril space
```

Hand a session this: **read `benchmarks/prompt/extraction.md` and follow it for `<conversationId>`.** That
prompt is self-contained — it names the vocabulary, the rules and the output shape, and reads them from this
repository rather than restating them. Any model of comparable reasoning strength can do it; nothing in the
prompt depends on which one. If two models produce noticeably different graphs from the same conversation,
that is a fact about the prompt and it belongs in the results.

**Extraction never sees a question.** Not the text, not the answers, not the categories. A graph built while
looking at the questions scores well on them and describes nothing else. That is structural rather than
promised: the loaders hand out conversations carrying no question data at all, and a gate refuses an ingest
module that so much as names the question set. Where the rule has been broken it is recorded next to that
conversation's number rather than left to be inferred.

**The extraction is committed as data.** Extraction needs a model; replaying it does not. Pinning the output
means the exact graph can be rebuilt from this repository by anybody, and every record in it checked against
the transcript it came from. Only re-deriving an extraction needs a model of your own.

## Using this without any benchmark

The loader is the only benchmark-specific part. Give the prompt any conversation in the shape it asks for —
sessions with dates, turns with a speaker and text — and the same two steps produce the same kind of space.
The schema was written for conversations in general, not for these corpora.

## Reading anybody's number, including ours

**The headline figure of a memory benchmark is not one number, it is at least three questions.** Published
percentages differ by more than thirty points for the same system on the same dataset, and almost none of
that is the memory:

1. **What was measured.** *Did the evidence come back* (a retrieval rank) and *was the final answer right* (a
   judged answer) are different measurements, and the second depends on an answering model the memory system
   did not supply. Ours publishes the first; the second is `B-2`.
2. **Who ran it.** Bench'd, an independent harness, scores systems 20–60 points below what the same systems
   report about themselves — Mem0 self-reports 93.4% on LongMemEval and its open-source build scores 32.4%
   when somebody else runs it. A self-reported number is a claim about a configuration nobody else has.
3. **Which questions.** LoCoMo ships 1,986 questions; Bench'd runs 1,540 of them. A subset is legitimate and
   changes the number, so a percentage without a question count compares to nothing.

**And the number that is missing from almost every published figure is the baseline.** Bench’d puts a
plain long-context model with no memory at all at 50.4% on LoCoMo and 57.6% on LongMemEval, against
LlamaIndex at 54.8% and LangChain at 51.9% on LoCoMo — so the memory in those products is worth about three
points. A memory system’s result is only meaningful as *accuracy minus the same answerer given the whole
history*, on the same questions with the same judge, and any run here reports both columns.

The corresponding rule here: every figure is published beside the ceiling that method allows, the commit it
was measured at, and the questions it was measured over.
