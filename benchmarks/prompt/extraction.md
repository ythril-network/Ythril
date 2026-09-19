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

## The one thing to get right

**You are recording what is TRUE, not what was typed.** A conversation is the evidence; the graph is what the
conversation establishes. If you store the lines of the transcript you have built a transcript with tags on
it, and it retrieves exactly as well as the transcript did — which is to say, badly, because a line of
dialogue is not self-contained.

*"I went to a LGBTQ support group yesterday and it was so powerful."*

Nothing in that sentence says who, or when. A search engine sees those words and nothing else. The fact is:

*"Caroline attended an LGBTQ support group on 7 May 2023 and found it powerful."*

Every record you write must read like the second one: **it names its subjects, it carries resolved dates, and
it makes sense to somebody who has never seen the conversation.** That is the whole difference between a
graph that models reality and a pile of chat lines.

The verbatim words are not lost — they live in the session transcript, which is kept as a file so anything
can be quoted exactly. The graph is for finding; the transcript is for quoting.

## When one of the speakers is an ASSISTANT

Some conversations are between people. Others are between a person and an AI assistant, and then the turns
are not equal: a person's turn is somebody asserting something, and an assistant's turn is a model producing
text. **Having been said by a model does not make a thing so**, and a graph that cannot tell the two apart
hands back the model's guesses beside the user's own words, ranked the same.

Three rules, in this order.

**1. An assistant's turn is CONTEXT first.** Read it to understand the person's turns — *"Yes."* means
nothing without the question above it, and a date, a name or a subject is often only recoverable from the
reply. Do not mine it for claims by default.

**2. Attribute a fact to whoever ORIGINATED it, not to the turn you read it in.** Most of what an assistant
appears to state is the user's own fact handed back: *"Congratulations on raising $250 for the charity
ride!"* establishes nothing the user did not already say. The claim is the user's, `speaker` is the user,
and the assistant's turn was how you resolved it. **This is the commonest case by a wide margin** — an
assistant confirms, congratulates and summarises constantly, and almost none of it is new.

**3. When the assistant is genuinely the origin, write the claim and mark it `attributed`.** Two cases, and
both are real:

- **it supplied world knowledge** — a restaurant's signature dishes, the refining processes at three
  refineries, hostels in Amsterdam. This may be right, stale or invented, and nothing in the conversation
  settles which;
- **it produced something the user asked for** — a shift rotation for seven named staff, a draft chapter.
  That the assistant produced it is simply true, whatever the thing is worth.

Both are written as claims with `speaker: "assistant"` and `attributed: true`. **`attributed` means the
graph records that this was SAID, not that it is SO** — the same distinction a citation makes between
*"Vasari wrote that Leonardo painted the Mona Lisa"* and *"Leonardo painted the Mona Lisa"*.

Leave `attributed` off everywhere else. A claim with no mark is one a person asserted, and in any real
conversation that is almost all of them.

## How to do it well

**Identity is the whole job.** The graph is worth having because a mention in session 3 and a mention in
session 18 become one node. Give each real thing one `key` and reuse it everywhere. `Deb`, `Deborah` and *"my
friend from the pottery class"* are one person; put the variants in `aliases`. Two keys for one thing is the
failure that makes the graph useless — when unsure whether two mentions are the same, prefer merging them and
say why in the entity's `aliases`.

**Every entity carries a `description` saying what is known about it**, written from the whole conversation
and updated as it goes. `Luna, animal, cat` is a label and deserves to lose to a sentence in any search.
*"Melanie's cat, one of two pets along with the dog Oliver; a third, Bailey, arrived in August 2023"* is a
retrieval target — and it is the natural hub for any question about the pets. An entity is a place facts
accumulate, not a tag.

**Mint an entity only for something the conversation returns to, or plainly could.** A named person, place,
employer, pet, project, possession, work, activity or condition. Not a passing noun. An entity nobody
mentions twice and nothing links to is noise with a type on it.

**A claim is one RESOLVED FACT, and it may draw on several turns.** Write what the exchange establishes, in
a sentence that stands alone: subjects named, dates resolved, pronouns replaced. One exchange about one thing
is one claim, even when it took four turns to say. A turn that only says *"Thanks, that's so sweet!"*
contributes nothing of its own and belongs in the `sourceTurns` of the claim it is part of.

**Write the ARC as well as the moments.** When the conversation establishes how something developed
across sessions — a project that progressed, a habit that started and stopped, a household that gained a
pet — write that as a claim of its own, naming the turns that state it. The per-turn claims stay; these
are additional.

A system that can report *"she applied in August"* and *"she passed in October"* but not *"the adoption
went from researching agencies in May to passing the interviews in October"* is a log, not a knowledge
base — and a question about the arc has nothing to match. This is the one place a claim may draw on turns
from more than one session.

Keep it bounded: a claim names the turns that state what it says, never everything about the subject. A
record whose provenance covers most of a conversation is a summary of the conversation, which the writer
refuses.

**Every turn must appear in some claim's `sourceTurns`.** That is how the claim layer stays complete without
being a transcript: facts cover the turns they came from, including the ones that carry no fact alone. An
extraction that dropped the quiet turns covered 34.6% of a conversation and scored worse than storing raw
turns, because a question about a dropped turn cannot be answered by anything.

**Resolve every date, everywhere.** *"Yesterday"*, *"last Friday"*, *"three years ago"* — against the date of
the session the remark was made in. The resolved date goes in the sentence itself, not only in a chrono
entry, because the sentence is what gets searched. A question asking *when* has nothing to match against the
word "yesterday".

**Link every claim to what it is about.** This is what makes it reachable from another session, and it is how
two facts stated months apart become one answer: both hang off the subject they share.

**Anything that happened on a date is also a chrono entry**, linked to what it concerns, with its title
written the same self-contained way.

**Draw an edge when the conversation asserts a relationship**, not when two things are merely mentioned
together. `works_at`, `lives_in`, `family_of` — and `since` / `until` only when the text says so.



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
- **Every claim whose `speaker` is the assistant carries `attributed: true`**, and no other claim does.
- **Every turn of every session appears in some claim's `sourceTurns`.** Count them.
- **Every entity has a `description`.** A bare name loses every search it takes part in.
- **Every claim reads on its own** — subjects named, dates resolved, no pronoun pointing outside it.
