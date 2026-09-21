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

You are reading a long conversation recorded over many sessions. Turn it into a knowledge graph, so that a
question asked later can be answered from it — including one whose answer needs something said in an early
session and something said long afterwards.

**Do not assume the shape of it.** It may be two people or a person and an assistant; it may run over years
or over a fortnight with six sessions in a day; the sessions may not be handed to you in time order, and one
turn may be an entire document somebody pasted in. Each of those has a section below, because each of them
changes what the right answer is — and reading this paragraph as a description of the conversation in front
of you is how a rule written for a different shape gets applied to this one.

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

## When somebody PASTES something

People paste. An article, a contract, a log, an error page, a draft somebody else wrote, a recipe — dropped
into a turn and followed by *"what does this say about X?"* or *"can you fix this?"*. The turn is enormous
and almost none of it is the speaker talking.

**A pasted document is MATERIAL, not assertion.** The person did not say the things in it; they brought it.
So the fact the conversation establishes is that they brought it, and what they wanted from it:

> *"On 12 July 2023 Dana pasted the Wikipedia article on the GDPR and asked what it said about AI
> regulation."*

That is one claim, and the pasted turn is its `sourceTurns`. **Do not mine the document for claims.** An
article yields a hundred statements about its subject, none of them about anybody in the conversation, and
a graph that swallows them is a graph where a question about the person returns paragraphs about data
protection law.

**`attributed` is not the tool here, and reaching for it makes a second mistake.** That mark is for a claim
an AI assistant originated, and the writer refuses it on a person's claim — correctly. A pasted document is
a third thing: not the speaker's assertion, not the assistant's output, just material they put on the table.

**What to take from it, if anything.** Only what the exchange establishes about the people in it:

- **what they were doing** — reviewing a contract, debugging a stack trace, researching a regulation. That
  is a fact about them, and it is usually the point.
- **what they said ABOUT it** — *"this clause is the one my lawyer flagged"* is theirs, and it is a claim.
- **a detail the conversation then turns on** — if they and the assistant go on to discuss one figure from
  the document for three turns, that figure has become part of the conversation and can be a claim.

Everything else stays in the transcript, which is where the verbatim text lives and where anything can be
quoted from exactly.

**The same goes for something the assistant pastes back** — a rewritten draft, a corrected file. That it
produced the thing is true and is one attributed claim; the contents are not a hundred more.

## When a turn carries an IMAGE

Many turns end in something like `[image: a photo of two dogs running in a field]`. That caption was
generated by a machine looking at the picture. **It is not speech, and nobody in the conversation said
it** — so it is a third thing again: not the speaker's assertion, not a pasted document, not the
assistant's output.

**Treat a caption as context, never as a fact of its own.** What the conversation establishes is that
somebody shared a picture and what they said about it:

> *"On 19 August 2023 Melanie showed Caroline a black-and-white bowl with a flower design that she had
> made."*

That is one claim, and the image turn is in its `sourceTurns`.

**Never write a claim from a caption alone, because the captions are often wrong.** Running shoes
captioned pink are called purple by the person who owns them. A turn about Charlotte's Web is captioned
*"a girl and a cat"*. A caption reading *"a soccer team"* sits on a turn about basketball. Several have no
relation at all to the turn they are attached to. An extractor that mines captions does not merely add
noise — it writes a claim the conversation disproves two lines further down, with a real turn id under it.

Where the dialogue picks a detail up — they discuss the colour, they name the place — that detail is
established by the DIALOGUE and is a claim like any other. The caption was how you understood it, which is
what `sourceTurns` is for.

A turn that is only a photo and *"Wow, that's a great photo!"* establishes nothing of its own. It rides in
the `sourceTurns` of the claim it belongs to, and a conversation with many of those genuinely yields fewer
claims than it has turns.

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

**But world knowledge is only worth recording when the conversation TURNS on it**, and this is where an
assistant conversation will mislead you. An assistant answers at length: lists of suggestions, options,
examples, background. Most of it is reference material that could have come from anywhere, that nobody
returns to, and that no later question is about — and writing a claim for each one buries the handful of
facts about the person under a hundred records of generic advice.

The test is whether the exchange DID something. The user picked one of the options, said they would use it,
came back to it later, or the reply is the only place a fact about their world appears. *"The assistant
suggested ten ways to organise a playlist"* is not a fact about anybody; *"the assistant recommended two
particular hostels, and she booked one"* is one claim, and it belongs to her.

When in doubt, leave it out. An assistant's turn that established nothing still appears in the
`sourceTurns` of the claim it helped resolve, so nothing is lost by not making it a record of its own.

Both are written as claims with `speaker: "assistant"` and `attributed: true`. **`attributed` means the
graph records that this was SAID, not that it is SO** — the same distinction a citation makes between
*"Vasari wrote that Leonardo painted the Mona Lisa"* and *"Leonardo painted the Mona Lisa"*.

Leave `attributed` off everywhere else. A claim with no mark is one a person asserted, and in any real
conversation that is almost all of them.

## When the answer is too long for one reply

A history recorded over years — a support account, an assistant's whole relationship with one person, a
project channel — runs to hundreds of turns. **Reading it is rarely the problem; answering is.** The graph
of a long conversation is a large document in its own right, and it will often be longer than one reply can
carry even where the conversation itself fitted comfortably in front of you.

When that happens, return the file in **parts**, each covering a contiguous run of sessions, each a complete
file of the normal shape with one extra block:

```json
{ "conversationId": "conv-x", "part": { "index": 2, "of": 4 }, "sessions": [ ... ], "claims": [ ... ] }
```

**Say `of` correctly in the FIRST part and never change it.** The parts are joined by a step that refuses an
incomplete run, and that refusal is the only thing anywhere that can notice a part went missing: three parts
of four concatenate into a file that is perfectly valid and describes three-quarters of a conversation.

**Carry the entities forward.** Identity is the whole job, and it does not restart at a seam. Each part after
the first repeats **every entity minted so far**, with its key, its type and its description brought up to
date with what the new sessions added. A part that mints a fresh key for somebody already in the graph
produces two nodes for one person, which is the failure that makes the whole thing useless.

Three rules for what you repeat, and the third is the one that gets missed:

1. **Entities: all of them, every time.** They are cheap, and they are what the next part resolves against.
2. **A key keeps its type.** If session 40 makes you think you misread the subject, fix it in the part where
   you first wrote it, do not change it later — a type that differs between parts is refused, because the
   edges drawn against the old one now run to the wrong kind of thing.
3. **Claims, chrono entries and edges are NOT repeated.** Each belongs to the part whose sessions it came
   from. Repeating a claim writes it twice.

**Split on a session boundary, never inside one.** A claim may draw on several turns of one session, so a
seam inside a session leaves a fact half-written on each side of it.

## Every dated thing is an `event`, and `status` says whether it happened

There is one chrono type. What varies is `status`, and it is required:

| | |
|---|---|
| `completed` | it happened. Most of them. |
| `upcoming` | they mean to do it and the date has not come, or the conversation never says it did |
| `cancelled` | it was called off, and the conversation says so |

**A thing somebody plans is an event that has not happened yet, not a different kind of thing.**
*"Joanna planned to visit Nate on the 4th"* is `{"type": "event", "status": "upcoming"}`. Writing a
separate type for it would say the same fact twice and let the two disagree.

**When the conversation sets something up and never mentions it again, it stays `upcoming`.** *"The
opening night is tomorrow"*, and then nothing — no later session says it happened, and a month afterwards
the speaker is still looking forward to opening. Do not promote it to `completed` because it probably
happened; the graph would be asserting something nobody said.

**Something merely ONGOING is not a chrono entry at all.** A course being taken, a studio being run, a diet
being kept to, a build in progress. None of them has a stated start, so `date` gets filled with the day the
thing happened to be mentioned — a date nobody gave you, wearing the authority of one somebody did. A
subject that persists is what an **entity** is for: the course and the studio are an `organization`, the
routine is an `activity`, and the claims say how it is going. What IS a chrono entry is the moment it
changed — starting it, finishing it, giving it up — because somebody dated that.

**Never write `active` or `overdue`.** `active` is the ongoing case above and belongs in the entity layer.
`overdue` is derived on read from the dates, so a stored one disagrees with what the reader is shown.

**`upcoming` will be rare, and that is a limit of the format rather than a failure of yours.** A plan is
usually dated coarsely — *"next month"*, *"sometime in the spring"*, *"once the weather turns"* — and a
chrono entry needs a resolved day, so most plans get no entry and live as claims instead. Never manufacture
a day to make one fit. A conversation whose plans are all vague ends with no `upcoming` entries, and that is
the correct outcome.

## When something took MORE THAN A DAY

*"Last weekend"*, *"over the bank holiday"*, *"we were there Friday to Sunday"*. This is a third case and
the two date rules above do not cover it: it is not one day, so *"resolve it"* has no single answer, and
it is not vague — the speaker knows exactly which days they mean, and so do you.

**Give the chrono entry both ends.** `date` is the day it started, `endsAt` the day it ended:

```json
{ "key": "pride-parade", "type": "event", "title": "Caroline went to the city pride parade",
  "date": "2023-07-15", "endsAt": "2023-07-16", "entities": ["caroline"] }
```

**Do not pick one of the two days, and do not drop the entry.** Picking invents a day that nothing in the
conversation says; dropping it is worse, and it is the one that actually happened. Ten extractions written
before this section existed each hit the same wall and each chose to drop — so a marriage, a medical
diagnosis, a pride parade and a career-high game are absent from their timelines, while a photograph taken
on a named Friday is present. **What reached the timeline was decided by the grammar the speaker used, not
by whether the event mattered.**

Omit `endsAt` entirely for a one-day event. A range that runs backwards is refused before anything is
written; a range of one day is accepted and simply means you are being explicit.

**`endsAt` is how long the thing LASTED. It is never how unsure you are about when it happened.** This is
the distinction the whole section turns on, and it is easy to slide off:

| said | how long it lasted | does the conversation hand you both ends | entry |
|---|---|---|---|
| *"last weekend"* | two days | yes — the Saturday and Sunday before this session | a span |
| *"Friday to Sunday"* | three days | yes | a span |
| *"a short trip last week"* | more than a day, unknown | no | no chrono entry |
| *"last week I got married"* | one day | irrelevant — it is not a span at all | no chrono entry |
| *"the concert last weekend"* (one evening) | one evening | irrelevant — the two days are the doubt, not the event | no chrono entry |
| *"we painted last weekend"* | **not stated** | yes | **no chrono entry** |
| *"sometime in the spring"* | one day, or unknown | no | no chrono entry |

**The fourth row is the commonest of all and the easiest to get wrong.** *"We painted last weekend"*,
*"I had a quiet weekend"*, *"hiking with some buddies this weekend"* — both ends are handed to you and
the length is never stated. **Not stated is not the same as two days.** You have to KNOW it took more
than a day, and a weekend that merely contains something tells you when, not how long. One extraction
counted four such turns in a single conversation and read them one way; read the other way its span count
changes by a factor of two or three, on no evidence either way. So: no chrono entry, and the weekend goes
in the claim.

**What a thing IS can tell you it lasted more than a day, and that counts as knowing it.** Camping entails
a night. So does a stay with somebody, a festival that runs Friday to Sunday, a trip far enough that
nobody drives it twice in an evening. A 5K does not; nor does a concert, a wedding, a dinner or a match.
The length is carried by the ordinary meaning of the word the speaker chose, and declining to read it is
not caution — it is discarding something every reader of the sentence already knows. So *"we went camping
last weekend"* is a span; *"we ran the 5K last weekend"* is not.

**It has to be ENTAILED, not merely likely.** *"We were at the lake last weekend"* could be an afternoon,
and *"we had people over last weekend"* almost certainly was. If the word does not carry the night with
it, the length is not stated and the rule above applies unchanged.

**A one-day event with an uncertain date is not a span, however tightly the uncertainty is bounded.**
Giving a wedding the Monday and Sunday of its calendar week says the wedding took a week. Nothing
downstream can tell that apart from a genuine week-long event, so a question about the Wednesday matches
something that did not happen on the Wednesday — and it is wrong in both directions at once, silently.
Write the week into the claim's own sentence, where it is true, and leave it off the timeline.

So the test is not what the speaker could tell you if you asked. **The test is whether the conversation
hands you both ends of something that genuinely took more than a day.** If it hands you neither, or if the
thing took a day, there is no span to record.

**An end you worked out from a LATER SESSION is not an end.** *"My wife and I just left"* on 6 November,
and a session on the 11th that speaks of the trip in the past tense — that gives you a start and a bound,
not two ends. *"He was back by the 11th"* does not say when he came back, so writing 6-11 November records
your uncertainty as the length of his holiday. The same goes for an end bounded by the next thing that
happened: *"I met back up with my teammates on the 15th"* closes a window, it does not date a return.

This one is worth saying because it decides a whole conversation at a time. One extraction read those as
bounds and produced **zero** spans; reading them as ends would have produced several, and nothing in the
file would have shown which rule had been applied.

**And that holds at two days as much as at seven.** *"We were away last weekend"* is a two-day event and
gets a span; *"the concert last weekend"* is one evening, and the Saturday-to-Sunday range would be the
doubt about which night rather than the length of the concert. The rule has no size threshold, because a
threshold would only say how large a lie is tolerable.

**Yes, this leaves real events off the timeline** — a death, a graduation, a career-high game, all dated
only to a week. That is a known and accepted cost: a timeline that is exact is worth more than one that is
complete, because the incomplete one is honest about what it does not know. The facts stay findable; they
are claims carrying their own dates in prose.

### "Last Tuesday" means the most recent Tuesday

It has two ordinary readings — the most recent past occurrence, and the same weekday of the previous week —
and they differ by seven days. Said on a Wednesday, *"last Tuesday"* is either yesterday or eight days ago.

**Take the nearest occurrence in the direction the sentence points: the most recent one for *"last
Friday"*, the next one for *"see you Friday"*.** A forward reference carries the identical ambiguity
mirrored — *"Saturday"*, proposed on a Saturday, is either today or in seven days — so it takes the
matching rule rather than a second judgement call.

**The day of speaking does not count as the occurrence, unless the exchange says it does.** *"Last
Friday"* said on a Friday is seven days back, not today. *"See you Friday"* said on a Friday is seven days
forward — **unless the same exchange places it today**: *"gonna head out soon"*, *"see you in an hour"*,
*"I am on my way"*. Somebody who meant today usually says so, and when they do, believe them over the
default.

**A weekend containing today is not "last weekend".** Said on a Sunday, *"last weekend"* is the previous
completed one, not yesterday-and-today — the same rule, since the day of speaking is inside the weekend it
would otherwise name.

**The same applies to a weekend**, which is where it bites hardest because a weekend also decides whether
a span is written at all: *"last weekend"* is the most recent completed one, and *"next weekend"* is the
one after the coming Saturday.

**`this weekend` names the weekend IN PROGRESS when the session falls inside one.** Said on a Saturday or a
Sunday, *"can you take me there this weekend?"* means today or tomorrow, not six or seven days out. This
is the one place the day of speaking does count, and it is not an exception bolted on: a weekend is a
two-day window rather than a point, so a session inside it is inside the thing being named. Said on any
other day, *"this weekend"* is the coming Saturday and Sunday. When that leaves a one-day plan on a known
day — a visit agreed on the Sunday, for the Sunday — it is a dated event like any other. The span rule does
not touch it, because the visit takes a day and you have the day.

**Two sessions can legitimately land on the same weekend, and that is not a mistake to fix.** A session on
the Monday and a session on the Saturday both say *"last weekend"* and both mean the same two days, so a
picnic described in one and a hike described in the other sit together on the timeline. That is what the
speakers said. Moving one of them to a different weekend to make the graph look tidier invents a date the
conversation does not contain.

Not because either is more correct, but because a weekday
reference LOOKS exactly resolvable, so it gets resolved silently and the choice is invisible in the file —
unlike a weekend, where the ambiguity is on the surface and you know you are deciding. A confidently wrong
date on a timeline has nothing anywhere to contradict it. One rule, applied everywhere, is worth more here
than the right answer case by case.

## When a later session makes an earlier fact WRONG

A conversation recorded over any length of time does not only add facts — it replaces them. Somebody changes
job, moves city, gives up a hobby, finishes a course they were halfway through. The earlier statement was
true when it was made and is not true now, and **both belong in the graph.**

Writing only the newer one loses the history, and a question about what used to be the case has nothing to
match. Writing both with nothing to separate them is worse: a search for *"where does she work"* hands back
two employers and no way to tell which is current, so the graph answers confidently and wrongly.

So the later claim gets written, the earlier one **stays exactly where it is and gains a mark**:

```json
{ "key": "worked-at-acme", "text": "Ada worked at Acme as a platform engineer from March 2021.",
  "speaker": "Ada", "statedOn": "2023-05-08", "superseded": true, "entities": ["ada", "acme"],
  "sourceTurns": ["D1:1"] }
```

and an edge says which claim replaced it:

```json
{ "label": "supersedes", "from": "works-at-beta", "to": "worked-at-acme" }
```

A claim needs a `key` only for this — give one to the two claims an edge names, and to no others.

**Three things to get right, and the second is the one that goes wrong.**

**1. Mark the OLD one, not the new one.** `superseded` means *this is no longer true*. The claim that
replaced it is current and carries nothing.

**2. Not every change is a supersession.** Ask whether the earlier statement is still true of the time it
described. *"I was nervous before the interview"* is not retired by *"I got the job"* — both remain true,
and they are two facts about a sequence. Retire a claim only when the world it described has been replaced:
a job that ended, an address that changed, a plan that was abandoned, a number that was corrected. **A habit
that stopped, a project that finished and a pet that died are all still TRUE of their period** — write the
ending as its own claim rather than retiring the beginning.

**3. A retirement often has no successor, and that is a complete record.** *"She left Acme"* with nothing
said about what came next is `superseded: true` on the old claim and no edge at all. Do not invent a
replacement to have something to point at.

**"Later" means a later DATE between sessions, and POSITION within one.** Sessions are not always handed
to you in time order, so the one that comes second on the page may have happened first — read the date,
and the time where two share a day. But an arrangement can be made and remade inside a single session:
Jolene proposes Monday, revises to Wednesday, Deborah has plans, they settle on Friday. Three claims, one
`statedOn`, two genuinely abandoned plans — and the only thing that orders them is where they appear. Read
position within a session and the date between sessions; do neither the other way round.

**And do not let the date rule freeze the file's order.** Sessions are not always handed to you
in time order, and the one that comes second on the page may have happened first. Every session carries its
date; read that, and if two sessions share a day, read the time on them. Retiring by position in nearly
half a corpus gets it exactly backwards — the stale claim asserted and the current one marked dead, which
is the inverse of what this section is for and shows up in no count.

**Expect very few of these, and do not go looking for more.** A conversation covering eight months, a
death, a job loss, a promotion, a church joined, two dogs acquired and a graduation yielded exactly two
retirements — and that was right, because the carve-outs above are right: a pet that died and a project
that finished are still true of their period. Across ten conversations and 5,882 turns there were 24 in
total. **A thin count is the expected result, not evidence you missed some**, and treating it as a target
is how a graph comes to assert that things are over which are not.

**Never retire something the conversation did not retire.** Two claims that merely disagree are not a
supersession — people misremember, and a later session repeating a fact differently is usually one fact said
twice, not two facts of which one is dead. Mark it only when the text says the situation changed.

## When the conversation contradicts ITSELF

The section above is about a world that moved on. This is different and it is common: the same speaker
says flatly incompatible things about one unchanged world. Four dogs are Jack Russell mixes in July and
Lab mixes in October. A tour ends twice and then starts. A man fails the military aptitude test and later
refers to his time in the military. Someone has never been to Boston and was there a few years back.

**Nothing changed, so nothing is superseded — and writing both as plain current facts is not right
either.** A search then returns two answers with no way to tell them apart, which is the same failure the
supersession section opens by describing, arriving by a different route.

**Date the claim to its telling.** Not *"Calvin has never been to Boston"* but *"as of 9 June 2023 Calvin
said he had never been to Boston"*. Both claims are then true, both are findable, and the reader can see
that the conversation disagrees with itself rather than the graph being broken.

**Do not reconcile, and do not pick a winner.** You were not there. People misremember, exaggerate and
correct themselves without saying so, and deciding which telling was right is inventing a fact the
conversation does not contain.

**When the contradicted thing is a STATE rather than an event, write it once.** The examples above are
discrete — four dogs, one Boston trip, a tour that ended. A background state is different: somebody talks
about *running his own studio* and *his students* from February onward while, in other sessions, he is
still looking for premises and the opening night is in June. Dating every mention gives you twenty claims
that all read as hedging and bury the one fact underneath.

Write the state **once**, dated to its first telling, and let the later mentions be `sourceTurns` on that
one claim. Where the conversation genuinely contradicts it — the premises hunt, the opening night — those
are their own claims, dated to theirs. The reader then sees two facts that disagree instead of twenty.

**A count that GROWS is this, not a supersession — usually.** Two dogs become three; three countries
visited become five. Ask what changed: a household that gained a pet genuinely replaced its old
composition, so retire the old count. A tally of places someone has been only ever goes up, and the
earlier figure stays true of its date — qualify it and leave it standing.

## How to do it well

**Identity is the whole job.** The graph is worth having because a mention in session 3 and a mention in
session 18 become one node. Give each real thing one `key` and reuse it everywhere. `Deb`, `Deborah` and *"my
friend from the pottery class"* are one person; put the variants in `aliases`. Two keys for one thing is the
failure that makes the graph useless — when unsure whether two mentions are the same, prefer merging them and
say why in the entity's `aliases`.

**Not only people.** *"The Wolves"*, *"GoT"*, *"LOTR"*, *"NYC"*, *"the UK"* — a team, two works and two
places, every one of them referred to two ways in the same conversation. `aliases` is declared on
`person`, `animal`, `place`, `organization` and `work`; for a type that does not have it, put the variants
in the `description` so a reader can still find the join.

**An entity or a chrono entry may carry `sourceTurns` too, and should.** A claim always does; on these two
it is the turns that established the SUBJECT — where the person was introduced, where the event was
described. Keep it to the few turns that actually did: a record naming most of a transcript as its
provenance is refused, because a few sentences about one subject cannot have come from all of it.

**Every entity carries a `description` saying what is known about it**, written from the whole conversation
and updated as it goes. `Luna, animal, cat` is a label and deserves to lose to a sentence in any search.
*"Melanie's cat, one of two pets along with the dog Oliver; a third, Bailey, arrived in August 2023"* is a
retrieval target — and it is the natural hub for any question about the pets. An entity is a place facts
accumulate, not a tag.

**Mint an entity only for something the conversation returns to, or plainly could.** A person, place,
employer, pet, project, possession, work, activity or condition. Not a passing noun. An entity nobody
mentions twice and nothing links to is noise with a type on it.

**A thing with no NAME can still be an entity, and some of the most important ones are.** The test is
whether the conversation returns to it, never whether anybody named it. *"My mom's old house"* across ten
sessions, *"the park near my house"* across five, Nate's turtles across half the conversation, Andrew's
girlfriend across thirteen, the charity someone volunteers with, both shelters, all four courses — each is
a hub that a dozen claims need in order to join up, and dropping them scatters those claims with nothing
to connect them.

Give it a descriptive key and a descriptive name — `nates-turtles`, "Nate's turtles"; `moms-old-house`,
"Audrey's mother's old house" — and say in the `description` how it is referred to. Where the schema says
*"a named location"* or *"a named animal"*, read it as **"not a passing mention"**: it says *named* because
in a one-line example those are the same thing, and here they are not.

**A group is one entity, not several and not none.** *"The kids"*, *"my parents"*, *"the turtles"* —
returned to constantly, named individually never. Mint one entity for the group, type it as whatever its
members are, and say in the description that it is a group and who is in it as far as the conversation
says. Three thin entities nobody mentions separately is worse, and no entity at all leaves forty claims
with nothing to join them.

**The merging rule applies to those too, and it is harder there.** *"My project I've been working on for
weeks"*, *"a big project I had been working on for months"* and *"the game I've wanted to make since I was
a kid"* may be one thing or three, and unlike `Deb`/`Deborah` there is no spelling to go on. Prefer merging
when the dates and the details are consistent, keep them apart when something rules the merge out — a
*"first game"* released six months after a different game was finished cannot be the same project — and
say in the `description` which mentions you joined. A reader can then see the judgement; they cannot see a
silent one.

**Merging is for entities. Two claims that might describe one event stay two claims.** A road trip
returned from in December and a road trip described in April; a promotion in June and *"my new job"* in
July. An entity exists to be one node, so a wrong split there breaks every link that runs to it — but two
claims are just two sentences, and asserting they are one invents a fact while merely leaving them apart
costs a reader nothing. When it matters, say the relation in the later claim's text.

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

**When a day holds more than one session, give each one a `key`.** Some conversations are one session a
day over months; others are several a day over a fortnight, and then the date is not a name — it is shared.
Give each session a key, and put it on every claim from that session as `session`. Without it two sessions
are one, and everything either of them said is filed under whichever the writer reached last.

**Resolve every date, everywhere.** *"Yesterday"*, *"last Friday"*, *"three years ago"* — against the date of
the session the remark was made in. The resolved date goes in the sentence itself, not only in a chrono
entry, because the sentence is what gets searched. A question asking *when* has nothing to match against the
word "yesterday".

**Keep an approximation approximate.** *"For about three weeks now"* and *"a few months back"* are not
precise and must not become precise: write *"for about three weeks as of 24 May 2023"*, which is searchable
and true, rather than *"since 3 May 2023"*, which is searchable and invented. The anchor date is the exact
part; the offset is as exact as the speaker made it. And give a fuzzy span no chrono entry — a chrono entry
is for something that happened ON a date, so one built from a guess puts a made-up day on the timeline.

**An undated *"it just happened"* gets the SESSION date.** *"I just got a new car"*, *"I finally opened my
shop"*, *"I wrapped up my second script"* — news brought to the session with no day attached to it. The
session date is not a guess here. It is the tightest bound the conversation states, the speaker is saying
it because it is fresh, and the claim's `statedOn` already records that this is the day of the telling.
Write the chrono entry with the session date and `status: completed`.

**The distinction is where the uncertainty comes from, and it runs opposite to the rule above.** *"Last
week I got married"* names an offset, which makes the session date KNOWN to be wrong — so no entry. *"I
just finished"* names no offset at all, so nothing contradicts the session date. Refusing both is what put
a shop opening, a tour, a video shoot and a flood off one conversation's timeline, which ended with
sixteen entries across 568 turns: **this is the largest single source of missing events.**

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
- **Every `supersedes` edge runs claim to claim, and the claim at its `to` end carries `superseded: true`.**
  A mark with no edge is fine — a retirement need not have a successor.
- **Every turn of every session appears in some claim's `sourceTurns`.** Count them.
- **Every entity has a `description`.** A bare name loses every search it takes part in.
- **Every claim reads on its own** — subjects named, dates resolved, no pronoun pointing outside it.
