# Extraction prompt

Hand this to a model, with one conversation, and it returns that conversation's extraction file. It is the
only step that needs a model. Everything after it is deterministic.

**Written to be model-portable.** Nothing in it depends on who is reading it. Any model of comparable
reasoning strength should produce a comparable graph; if two models disagree a lot, that is a finding about
the prompt, and it belongs in the results rather than being smoothed over.

## Two ways to deliver it

**To an agent that can read files** — say: *read `benchmarks/prompt/extraction.md` and follow it for
`<conversationId>`.* It will open the schema and the transcript itself.

**To a plain completion API** — inline the three inputs below into the request. Nothing else is needed, and
the prompt deliberately does not restate the schema, so the schema travels as data rather than as a second
copy that goes stale.

## Inputs

| | |
|---|---|
| the vocabulary | `benchmarks/space/schema.json` — the types, labels and endpoints you may use |
| the rules | `benchmarks/space/usage-notes.md` — how records are meant to be written |
| the output shape | `benchmarks/plan/extraction-format.md` — the exact JSON to return |
| the conversation | sessions, each with a date and a list of turns, each turn a speaker and text |

---

## The task

You are reading a long conversation between people, recorded over many sessions spread across months. Turn it
into a knowledge graph, so that a question asked later can be answered from it — including a question whose
answer needs one thing said in an early session and another said months afterwards.

Read `benchmarks/space/schema.json` first. It is the complete list of what you may create: the entity types,
the edge labels with the types allowed at each end, the chrono types, and the one claim type. **Do not invent
a type or a label.** Anything you cannot express in that vocabulary is either a claim or nothing.

Return a single JSON object in the shape given by `benchmarks/plan/extraction-format.md`. Return nothing else
— no commentary before or after it.

## How to do it well

**Identity is the whole job.** The graph is worth having because a mention in session 3 and a mention in
session 18 become one node. Give each real thing one `key` and reuse it everywhere. `Deb`, `Deborah` and *"my
friend from the pottery class"* are one person; put the variants in `aliases`. Two keys for one thing is the
failure that makes the graph useless — when unsure whether two mentions are the same, prefer merging them and
say why in the entity's `aliases`.

**Mint an entity only for something the conversation returns to, or plainly could.** A named person, place,
employer, pet, project, possession, work, activity or condition. Not a passing noun. An entity nobody
mentions twice and nothing links to is noise with a type on it.

**EVERY TURN BECOMES A CLAIM. The claim layer is complete, not curated.** Keep the words. Do not summarise
several turns into one, and do not split a turn unless it genuinely states separable things. Every claim
carries the speaker and the date of the session it was said in.

This rule replaces its opposite, and the opposite was measured. The first version of this prompt said a
claim mentioning nobody and nothing was probably a claim not worth making. Following that, an extraction of
a 419-turn conversation produced 145 claims covering **34.6%** of the turns — and scored WORSE than storing
the raw turns and nothing else, on every measure. Two thirds of what was said was simply gone, so no
question about it could be answered from any structure built on top.

A remark that seems to say nothing is still what somebody said, and later it is the only record that they
said it. Judging which remarks matter is the retrieval's job, at read time, when the question is known.

**Link every claim to what it is about.** This is what makes it reachable from another session. A claim with
no links is still written — it just has fewer ways in.

**Draw an edge when the conversation asserts a relationship**, not when two things are merely mentioned
together. `works_at`, `lives_in`, `family_of` — and `since` / `until` only when the text says so.

**Anything that happened on a date is a chrono entry**, linked to what it concerns. Resolve the date: people
say *"last year"* and *"last weekend"*, and the session's own date is what those are relative to. Store the
resolved `YYYY-MM-DD`. Never store a relative expression.

**An edge does not narrate.** It says that two things are related and for how long. How strongly someone
liked something, how bad a condition got, how a job changed — each of those is a claim.

**Record which turns each claim came from** in `sourceTurns`. It is kept outside the graph; it exists so a
result can be traced back to the transcript.

## What not to do

**Do not ask for the questions, and do not use them if you have somehow seen them.** This graph must be as
useful for a question nobody has written yet as for one that exists. A graph shaped around a known question
set scores well on it and describes nothing else, which is worse than useless — it is misleading.

**Do not put the conversation's structure into the graph.** No turn numbers, no session ordinals, no speaker
turn counts. The transcript is kept separately as a file; the graph is about what was said, not about the
file it arrived in.

**Do not pad the ENTITIES.** More entities is not better — an entity list full of common nouns links
everything to everything, which performs exactly like having no graph at all. If the entity list does not
read like a list of names of things, start again. This is about entities only: the claims are complete by
rule and are never trimmed.

**Do not leave a key dangling.** Every `from`, `to`, and every entry in a claim's `entities` or `chrono` must
name a `key` you defined in the same file.

## Before you return it

Check these yourself; the writer will refuse the file otherwise.

- Every `type` and `label` appears in `schema.json`.
- Every edge's two ends are types that label allows.
- Every date matches `YYYY-MM-DD`.
- Every referenced `key` is defined.
- Every claim has `speaker`, `statedOn` and at least one `sourceTurns` entry.
- **Every turn of every session appears in some claim's `sourceTurns`.** Count them.
