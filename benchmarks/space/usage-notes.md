# Usage notes

How to write to this space, and how to read from it.

## Writing

**Mint an entity once and find it again.** The value of this space is that a mention in one session and a
mention months later become the same node. Match on the name and on `aliases` — a first name, a full name and
a nickname are one person. Two nodes for one person is the failure that makes the graph unable to answer what
it is for.

**A claim is one thing said, kept as it was said.** Do not merge several statements into one record to make it
richer. A record holding a dozen unrelated statements has no subject in the sense a question has one, so its
vector sits near everything and therefore near nothing.

**Link, do not concatenate.** A claim names its entities through links. Never paste entity names into the text
to make it findable — ranking and reachability are carried by different mechanisms, and doing one with the
other costs both.

**Resolve dates at write time.** People say *"last year"* and *"last weekend"*. Store the resolved date,
computed against the date of the session the remark was made in. A stored `last year` answers nothing.

**Put a date where it belongs.** Something that happened is a chrono entry linked to what it concerns. How
long a relationship held goes on the edge, as `since` and `until`. Nowhere else.

**Every claim carries `speaker` and `statedOn`, and both are required.** A claim nobody can attribute is not
auditable, and one with no date cannot answer a question about when.

**An edge does not narrate.** It says that two things are related and for how long. How strongly someone likes
a thing, how severe a condition became, how a role changed — each of those is something somebody said, so it
is a claim.

## Reading

**Search finds a claim; the graph gets you the rest.** A question usually matches one remark. What makes a
second, related remark reachable is the walk from that match to the entities it names and back out to the
other claims naming them — so a search worth making is a search with traversal on.

**Ask for linked records explicitly.** A walk returns the entities a match names by default; the claims that
name those entities are opt-in. Without that, an expansion returns nodes and not sentences, which looks like
the graph is working and answers nothing.

**Expansion is charged against the answer budget.** Records a walk brings back displace records that would
otherwise have been returned. That is deliberate: a walk that returns noise comes out *worse*, not merely
bigger. If turning traversal on makes answers worse, the links are wrong — do not raise the budget to hide it.

## The failure to watch for

**Joints that connect everything connect nothing.** If entities are minted from common words, every claim
links to every other and a walk returns the whole space trimmed to noise. It looks exactly like a working
graph and performs exactly like having none.

The check is cheap: read the entity list. If it is not full of names of things, it is not a graph.
