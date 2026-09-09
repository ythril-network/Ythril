# Purpose

This space holds a **long-running conversation between people**, as a graph.

Not a transcript archive. The transcript is the source; what is stored is what the conversation is *about* —
the people in it, the places, organisations, works, possessions, activities, conditions and projects they
mention, how those are related, when things happened, and the individual things that were said.

## What it is for

Answering a question that needs something said months ago, and often needs **two** things said months apart.
A question like *"does he still want to expand the brand?"* is answered by one remark in one session and
another in a session six weeks later. Storing the transcript in pieces cannot join those; a graph can, because
both remarks name the same subject and a search that finds one can reach the other.

## What goes in it

| | |
|---|---|
| **entities** | the stable things the conversation keeps returning to — a person, a place, an employer, a pet, a project |
| **edges** | how two of those are related, and for how long — `works_at`, `family_of`, `lives_in`, `owns` |
| **chrono** | anything that happened on a date, linked to the entities it concerns |
| **memories** | the individual things said, each carrying who said it and when |

## What does not go in it

**The transcript's own bookkeeping.** No turn numbers, no session ordinals, no line offsets. Those describe
the file the conversation arrived in, not the conversation — and every property is folded into the text that
gets embedded, so a turn id in the schema is meaningless tokens inside every vector in the space.

**Dates as properties of things.** A date is something that happened, so it is a chrono entry linked to what
it concerns — not a field on an entity. The exception is a date that says how long a *relationship* held,
which belongs on the edge that holds it.

**Anything that tells a story.** How strongly someone likes a thing, how severe a condition became, how a role
changed — those are claims somebody made, so they are memories or chrono entries. An edge says *that* two
things are related and *when*; it does not narrate.

## Who it is for

Anyone storing a conversation. Every type earns its place with a reason that holds for a different set of
people talking about different things — a vocabulary fitted to one transcript is a worse product and a
dishonest measurement.
