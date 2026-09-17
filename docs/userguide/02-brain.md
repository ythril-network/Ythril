# Brain and Graph

> Part of the [Ythril User Guide](../userguide.md).

## Brain and Graph

## Brain

The Brain is where all your knowledge lives. It has nine tabs: **Overview**, **Query**, **Graph**, **Review**, **Entities**, **Edges**, **Facts**, **Chrono** and **Files**. This said eight and left out **Review**, which has its own section further down this page.

**Overview** is the **default landing tab** — opening a space lands here first. It is a per-space dashboard assembled from what the Brain already knows: a **Storage** panel (storage used against the space's quota — and when the instance could not read part of that space's file directory the figure is prefixed **≥** with a **partly unreadable** warning beside it, because a number that is silently short reads as a quota nowhere near its limit), an **Indexing** panel (the vector index's state, plus a **Reindex** button — behind a confirmation — when embeddings have gone stale), an **Embedding queue** panel (pending / processing / failed background-embedding job counts, with the file + reason for any failures, and a **Retry all failed** button — behind a confirmation — that re-queues every failed job in the space at once), a **Networks** panel (the networks this space syncs with and its aggregate sync status, or a note when it belongs to none), a **Governance** panel (open votes in this space's networks — subject, deadline, and tally — shown only when there are any), a **Data model** panel (the space’s entity types drawn as a diagram, with each type’s declared properties, how many records it actually holds, and the relationships between types — inferred from the schema AND from the records, so a type that has records but was never declared shows up rather than being silently left out; a record count is a link that opens that type in the Entities tab, and admins get a pencil on each type that opens the schema editor without leaving the page. **Facts, chrono entries and files appear as boxes too** — one per kind, carrying that kind’s total, joined to each entity type they link to with the per-type count on the join. They are drawn dashed and unfilled because they have no schema of their own, and a kind with no links anywhere gets no box rather than an empty one; their counts open the matching tab; **the boxes are drawn at one of three heights and a row of them shares a top and bottom edge**, and **the types that participate in no relationship are laid out along the bottom across the full width of the card** rather than wrapping after four however much room there is — a height per property count meant no horizontal line anywhere in the picture, which is most of what made a diagram of twenty types hard to follow), a **Usage** panel (how often this space was called over the last seven days, how many of those calls were recall, and what share of them actually answered — demand without the answer rate is not usefulness; admins get a **Reset usage** button there, which deletes the recorded history for this space behind a confirmation and is irreversible), and — **for admins only** — a **Token access** panel (which API tokens can reach this space and at what level: admin, read/write, or read-only, with network-peer and all-spaces tokens flagged and any expiry shown).

At the top of the page a row of **space chips** lets you switch space; each chip shows the space's total record count. The tab buttons themselves carry small count badges for the collection they open.

At the **far right of the tab strip**, past Files, a **cog** opens the settings for the space you are already
looking at — the same editor as **Settings → Spaces**, with its Settings, Schema, Duplicates and Danger Zone
tabs. It is not a tenth tab: it opens a dialog over the page, so nothing you were reading is lost, and closing
it returns you to the tab you were on. The cog is greyed out until a space is selected.

The admin list at **Settings → Spaces** is unchanged and remains the place to create, reorder and compare
spaces; the cog is the shortcut for the one you are working in.

The same state is on both APIs as `needsReindex` on a space's meta, so an agent can check it without watching
the screen.

If the search index needs rebuilding (for example after the embedding model changes), a banner appears reading *"Embeddings are stale — a reindex is recommended."* Click **Reindex** to rebuild it. (Both quotations here were longer than what the screen says.)

> **Reindex and rebuild are different repairs.** *Reindex* re-embeds your content against the current model. It does **not** help when the search index itself is missing or broken — the symptom there is search quietly returning nothing at all, with no error. That one needs **Rebuild search indexes** on the space's **Danger** tab (see below).

### Facts

Facts are the core knowledge unit — plain-language statements you want to remember.

**Creating a fact:** Click **+ Add fact**. Fill in:

| Field | Notes |
|-------|-------|
| **Fact** | The statement to store. Required. |
| **Description** | Optional context or rationale. Same size as Fact. |
| **Tags** | Comma-separated keywords for filtering. |
| **Entities** | Type in the inline entity search to find one (name or semantic) and click a result to link it — add several in a row. Linked items appear as chips above the search; click a chip's × to unlink. |
| **Properties** | Click to open the JSON editor. Enter any key-value pairs you want to attach. |

Click **Save**. The fact is indexed immediately and available for search.

**Searching:** The top search bar is **Semantic** (meaning-based) — type and it returns a ranked, non-paginated set. Plain-text (substring) search moved into the column headers: use the **freetext box under the Fact column** (see Filtering). Clearing the top bar restores the normal paginated list.

**Filtering:** Each column that can be filtered has its control docked directly under the column header — a **freetext box** under the main text column (Name / Relation / Fact) that matches a substring of the row's text, a type/kind dropdown under the **Type**/**Kind** column, and a tag box under the **Tags** column. Clicking a tag or entity badge on a row still fills the matching filter (the active entity filter shows as a chip above the table, with **×** to clear). Filtering happens on the server across the whole list, and clears back to everything when you empty the control.

**Sorting:** Click a column header with a caret (▾) to sort the list by that column — click again to flip the direction, and a third time to return to the default order. The caret fills in and points up or down to show the active sort. Sorting happens on the server, so it orders the **whole** list across every page, not just the rows currently on screen. Sortable columns vary by tab: **Entities** — Name, Type, Created · **Edges** — From, Relation, To, Weight, Created · **Facts** — Created · **Chrono** — Title, Kind, Status, Starts, Ends, Created.

**Editing:** Click the **⊙ view-details** button on any row to open the full editable drawer — the same drawer
the entity and edge tabs use. Every field you can set when creating a fact can be changed there, including
tags, linked entities and properties.

**Deleting:** Each row has a **✕** button. A small inline confirmation appears — click **Yes** to confirm, **No** to cancel.

**Wiping everything:** There is no "Wipe all" button on the Brain toolbar. To clear a space's data, go to **Settings → Spaces → (space) → Danger tab** and use **Wipe all data**. You will be asked to type the space ID to confirm.

---

### Entities

Entities are named concepts — people, services, projects, tools, anything you want to connect knowledge around.

Each entity has a **name**, a **type** (e.g. `person`, `service`), optional **tags**, an optional
**description**, and optional **properties** (key-value pairs like `{ "version": "3.0", "active": true }`).

> **The type is required from 4.0, and it used to be optional here.** It is what tells Ythril which set of
> properties this kind of thing has, so an entity without one is an entity none of the space's rules can
> check — and this form was the only way to make one. If the space has declared its entity types you pick
> from them; if it has not, type whatever the thing is.

**A property value has to be plain — a word, a number, or true/false.** You cannot nest one property inside
another, and that is on purpose: something with parts inside it is a set of connected things, and those work
better as their own entities joined with edges. A plan with three phases stored as one nested value has to be
rewritten whole to change one phase, and nothing on the Graph tab can see the phases at all. Three entities
with an edge each can be edited one at a time, and they show up.

**Creating an entity:** Click **+ Add entity**, fill in the fields, and click **Save**.

When a **type** is selected and the space has a schema defined for that type, the properties section is automatically pre-populated with all property fields from that type's schema:

- **Required properties** — shown with a `*` badge; must be filled in before the record can be saved (strict mode) or will generate a warning (warn mode).
- **Optional properties** — shown with a remove (×) button; any field left blank when you click Save is silently omitted from the stored record.
- Switching the type dropdown **immediately rebuilds** the properties form for the newly selected type; values you have already filled in are preserved where the field name matches.

**Searching:** The top search bar is a **semantic entity finder** — type to see meaning-ranked matches in a dropdown, then click one to narrow the list to it (it fills the Name column filter). For an **exact / partial name** lookup (e.g. a specific ID like `ADR002`), use the **freetext box under the Name column** — semantic recall is poor at exact IDs, so the column filter is the reliable path. Column filters and sorting work as on Facts.

**Editing:** Click the ⊙ view-details button on any row to open the full editable drawer.

**Merging two entities can leave a link that no longer fits its rule, and you will be told which.** When two
records turn out to be the same thing, merging moves every link off the record being absorbed and onto the one
you keep. If a link's label says what kind of thing may sit at each end — *"reports to runs from a person to a
person"* — and the record you keep is a different kind, that link now breaks its own rule. The merge still goes
ahead and lists the links it affected.

That is deliberate. Merging is often exactly how you fix a record that was the wrong kind in the first place,
so a rule added later must never leave you stuck with two copies of something. Fix the listed links
afterwards, or widen the rule on the space's Schema tab.

**Deleting:** Each row has an inline **✕ → confirm** flow.

**A delete can be refused, and that is usually the right answer.** If anything else in the space still points
at the entity — a link you drew, or a fact, timeline entry or file that names it — the delete is turned away
and the message lists what is holding it. Clearing those first is deliberate: deleting the entity would leave
every one of them pointing at a record that no longer exists.

For a **link**, the message also says which end of it this entity is, `from` or `to`, because that is what
tells you where to look. **Both ends count.** A link that runs out of this entity blocks the delete exactly as
one that runs into it does — either would be left half-attached — and the message used to say "inbound", which
sent people looking at the wrong side of their own links.

Two things worth knowing. **Faces do not block.** A photo where this person was recognised is listed, so you
can see the labels that are about to come off, but it never stops the delete — the labels are removed with the
entity. And **there is no "delete everything attached"** button: nothing removes an entity together with its
links in one action, on purpose, because the pause is what stops a hub record taking a hundred relationships
with it. Clear what you meant to clear, then delete.

If a space has turned linkage checking off in its settings, none of this applies there and the delete just
happens.

Results are paginated — use **← Prev / Next →** to page through them. The list also reports the **total** number of matching records, not just the ones on screen, so "first page of 4,831" is visible rather than something you have to page to the end to discover.

---

### Edges

Edges connect two records and describe the relationship between them (e.g. *service-a* `depends_on` *service-b*).

Each edge has a **from** record, a **to** record, a **label** (the relationship name), and optional **type**, **weight**, **tags**, **description**, and **properties**.

**From 3.7 an endpoint does not have to be an entity.** Either end can be an entity, a fact, a chrono entry
or a file, and the edge records which kind it is. Think of a photo taken at a party: the photo can point at
the people in it (entities), at the party itself (a chrono event), and at what happened there (a fact) —
three different kinds of record, from one file.

> **The Edges tab still creates entity-to-entity edges only.** The pickers offer entities, and an edge you
> create here has no kind recorded, which means entity — exactly what it meant before 3.7. Edges with other
> kinds of endpoint are written through the API or by an agent. They **display** properly in this table: a
> fact endpoint shows its fact, a chrono endpoint its title, a file endpoint its path. Pickers for the other
> three kinds are not in this release.

**Searching:** The top search bar is **Semantic** (ranks edges by meaning), same as Facts. Plain-text matching (label / endpoint names) is the **freetext box under the Relation column**.

**Creating an edge:** Click **+ Add edge**. Use the entity pickers to select the source and target, choose or type a label, and click **Save**.

When a **label** is selected and the space has a schema defined for that label, the properties section is pre-populated with all fields from that label's schema — the same required/optional behaviour as entities applies.

**Editing / Deleting:** Same as entities — ⊙ view-details drawer or inline ✕ confirm.

> **Deleting an entity that other things point at (4.0).** In a space with the strict reference setting on,
> deleting an entity is refused while edges still connect it to something — the message lists them. There
> are two ways forward: delete those edges yourself, or use the API to **preview** exactly what would go and
> then repeat the delete quoting the token the preview gives back.
>
> The token is tied to the exact list you were shown. If anything changes in between, the delete is refused
> rather than quietly taking something you never saw. There is no button for this in the Edges tab yet — it
> is an API capability in this release.

---

### Links — the other kind of connection

An edge says **how** two things relate. A link says only that one record **is about** another, and that is
a different thing you already use every day: the entities you attach to a fact, the entities and facts
you attach to a chrono entry, the three lists on a file. Those attachments are links.

They have always existed as lists on the record. From 4.0 each one is also a record of its own, so that
everything asking *"what is connected to this?"* — the graph, search, the ER model — looks in one place
instead of each following a different part of the lists.

**Nothing you do changes — but you will see MORE.** Attach an entity to a fact the way you always have and
the link is made for you. Remove it and the link goes. There is no new box to tick and no new step.

What is new is that three kinds of connection you could already record are finally followed: a timeline
entry pointing at a **fact**, and a file pointing at a **fact** or at a **timeline entry**. Those
attachments have been saved and shown on the record since 3.x, and nothing that walked the graph looked at
them — so a graph from a fact did not reach the timeline entry about it. It does now, on every space,
with nothing to run.

**Where to see them:** the **Query** tab, Advanced mode, with the collection picker set to **links** — one
row per connection, showing which record it hangs off and which record it names.

> **A link is not an edge and cannot become one.** It carries no label, no weight and no properties, on
> purpose. If you want to record *why* two things are connected, that is an edge, and the Edges tab is
> where you make one.

**Making one directly** is an API capability in this release — `POST /api/brain/spaces/:spaceId/links` or the
`save_link` tool, needing the same **write knowledge** right as an edge. There is no button for it,
because the ordinary way to make a link is to attach the record, which the tabs already do.

### Two things change when a space is converted

Converting a space (an administrator runs it once) turns the connection lists into records for good, and two
things follow. **Nothing changes on a space nobody has converted.**

**1. Deleting a record that something still points at is refused** — but only in a space with the strict
reference setting on. Delete a fact that a timeline entry refers to and you get a message naming what refers
to it, instead of the delete going through. This is a **change**: it always went through before, and the
timeline entry was quietly left pointing at a fact that was no longer there.

**2. Writing the old connection lists through the API is refused**, with the error naming the link endpoint to
use instead. Nothing you have stored is lost — the lists are still read, still saved and still copied between
instances. The tabs are unaffected: attaching a record still works exactly as it did.

---

### Chrono

Chrono stores time-anchored entries: events, deadlines, plans, predictions, and milestones.

**Creating an entry:** Click **+ Add entry**. Required fields are **title**, **type**, and **starts at** (date and time). You can also add a description, tags, status, linked **entities**, linked **facts**, and **properties** — the fact field is a searchable picker (type to find a fact by its fact and click to link it; linked facts show as chips), and the properties editor lets you fill in any fields the chrono type's schema defines (switching the type reseeds its property fields). The same pickers and properties editor are available when editing an entry in its detail drawer.

> **Clearing a property on a chrono entry works from 3.1.** Properties are *merged* when you save — the ones
> you do not touch are kept — so before 3.1 an API caller had no way to remove one at all and a stale key
> stayed for ever. Removing a property in the editor now removes it. The entry's **title**, **type** and
> **starts at** cannot be cleared, because an entry without them could not be shown; change them instead, or
> delete the entry.

**Searching:** The top search bar is **Semantic** (ranks entries by meaning). Plain-text matching (title / description) is the **freetext box under the Title column**.

**Filtering:** The filter bar above the table lets you narrow by tag text and status. Filters apply immediately.

> **"Overdue" is worked out from the clock, and you can decide what a past date means.** By default an entry
> you left as *upcoming* whose date has passed shows as **overdue** on its own — nobody has to mark it. That
> also means filtering by *upcoming* or *active* leaves those entries out, because they are counted as
> overdue now. Set an entry to *completed* or *cancelled* to stop it being counted that way.
>
> **Not every entry is a deadline.** If a chrono type records something that HAPPENED — a deploy, a backup
> run, an alert episode — then a date in the past is the normal condition and does not mean late. For those,
> set **`whenDuePasses` to `nothing`** on that type in the space's schema, or on the space itself to cover
> every type that does not say otherwise, and those entries keep the status you gave them. Leave it alone and
> nothing changes. *New in 4.3.*
>
> The status dropdown does offer **overdue**, and filtering by it finds those entries too. You rarely want
> it: an entry marked overdue by hand stays overdue after you move its dates forward, where one left as
> *upcoming* corrects itself.

**Editing:** Click the **⊙ view-details** button on any row to open the editable drawer, as on the other record
tabs. Title, type, dates, status, tags, description and properties can all be changed there.

**Deleting:** Inline ✕ confirmation per row.

---

### Query

The Query tab has two modes, switched with the buttons at the top: **Semantic Search** and **Advanced Query**.

#### Semantic Search

Type a natural-language query and press Enter (or click **Search**) to find the most relevant records
across the space. **The question sits beside two cards — a JSON filter and a JSON projection** — because
those three are what decide *what* is searched; everything below them decides how much comes back and in
what shape.

**A search that matches nothing says so.** If you see "no records matched", the search ran and the space
holds nothing that fits — try a broader question, fewer filters, or a lower minimum score. An error message
means something different: the search did not finish, so it found nothing because it never looked.

**It matches meaning *and* exact wording.** Two rankings run and are combined: one by meaning (so
"how do we handle a data breach" finds a passage titled "incident reporting"), and one by the words
themselves (so a part number, form id or clause name is found even though such a string carries almost no
meaning for a language model). A record that scores on both ranks highest. If your administrator has
configured a reranking model, the top candidates are then re-scored by a model that reads your question
and each passage together.

None of that needs setting up, and none of it can make a search fail — a stage that is unavailable is
simply skipped.

**Reranking is the one stage that can quietly stop happening on long records, and the results still look
right.** It reads your question together with each candidate passage, so its work grows with how much TEXT
those candidates carry — not with how many there are. On records of several kilobytes it costs seconds per
result, and there is a time limit. When the limit is reached the search still answers, using the ranking by
meaning alone; nothing is missing from it, it is just ordered less precisely, and there is no sign of this on
the page.

Measured on a live instance with records of six to nine kilobytes: asking for one result took five seconds,
three took sixteen, and above four the reranker ran out of time. Another instance on the same server, same
model, reranked a similar-sized set in under three seconds — the difference was the length of the records.
So there is no single number to expect. **If your records are long and you want reranking on more than a
handful of results, ask your administrator to raise the reranking time limit** (`modelSlots.rerank.timeoutMs`).

**The answer arrives in its own card, and you can read it two ways.** *Rendered* is the default: one card
per result with its score, its neighbourhood underneath it, and the record itself as a tree you can fold. Any
nested part — a properties bag, a tag list — starts collapsed with a count beside it (`{…} 4 keys`), so a
long record is a few lines until you open the part you want. *JSON* shows the whole response exactly as the
API returned it, which is what an assistant calling the same search receives; **Expand all** and **Collapse
all** appear beside it. Every level has a copy button that copies that part alone.

The **Search** button sits at the top right of the panel and stays there while you scroll, so a parameter
changed at the bottom of a long form does not send you back up to run it.

**Each result says which score put it there.** The label is the API's own field name — `rerankScore`,
`fusedScore` or `score` — because the same name appears in the JSON view and in what an assistant receives.
Which one you see is which stage decided: if your administrator has configured a reranking model, that is
the number the order came from and plain similarity is not. Any other stage that ran is shown beside it,
dimmer. A stage that did not run is left out rather than shown as zero — no reranker configured is not the
same as a reranker scoring nothing.

**If a graph walk stops short, the panel says so** and offers the whole graph as a download where the
instance was able to write one. What is missing from a short graph are records the walk never read; the
results themselves are unaffected.

**You can create a record and its relationships in one go.** Anything that writes a fact, an entity or a
timeline entry — the app, the API, or an AI assistant — can attach it to other records in the same action,
rather than saving it and then connecting it four more times. Two kinds of connection, and they behave
differently when you change them later:

- **A plain connection** says two records are about each other, with no name on it. Changing the set
  replaces it: clearing it detaches everything of that kind, and connections of other kinds are untouched.
- **A labelled connection** says HOW they are related — *reported by*, *governed by*, *supersedes*. Writing
  the same one again updates it, and none are ever removed by a write. Deleting one is its own action, on
  purpose: a labelled connection can carry its own notes and may have been made by somebody else.

The record at the other end has to exist already.

Two options sit next to the query box:

- **topK** — how many results to return. **There is no upper limit**, and asking for more than exists is
  not an error — you get what there is. What bounds a large request is the SIZE of the answer, described
  under *When the answer itself does not fit* below: a result is returned whole or not at all, and the
  answer always tells you when something was left out. Before 4.0.0 this box silently reduced anything
  over 100 to 100 — silently being the problem, because you were then looking at the top 100 believing
  it was the top 500.
- **minScore** — drop results below this similarity score (0–1). This is always the **meaning** score, even
  when word-matching or reranking has changed the order — so a threshold you set once keeps meaning the
  same thing. **The threshold is applied before topK, not after**, so a topK of 10 with a threshold set
  gives you ten results that clear it rather than however many of the top ten happened to. That is a
  4.0.0 fix; earlier versions chose the ten first and then thinned them, which could return three.

**Nothing is hidden behind a disclosure.** The form is laid out in five groups — **the question**, **ranking**,
**the graph**, **the answer** and **Size and paging** — side by side across the width of the page, because a control you cannot see
is a capability you do not know you have. Everything the API accepts is on screen, so a search you can
describe is a search you can run without writing a request by hand:

- **Types** — restrict the search to specific record types (fact, entity, edge, chrono). For each ticked type you can also set a per-type **minimum** number of results to guarantee.
- **Max per type** — the ceiling to that floor. This is how you stop one long file passage from crowding out several one-line records that would answer the question more cheaply; a slot freed by the cap goes to another type.
- **Tags** — a tag filter applied to results.
- **Fields returned** — a JSON object choosing which fields each result carries, e.g. `{ "description": 1 }`; it can exclude as well as include. Leave it empty for whole records. Worth being careful with rather than clever: a selection that omits the field you are reading gives you a result that looks complete and is missing the answer.
- **Skip results** — start further down the ranking. When an answer is shortened it tells you where to continue from; that number goes here. It counts from the top of the ranking, not from the last page, so it replaces the previous value rather than adding to it.
- **Save what did not fit** — the one setting on this form that WRITES. It puts the matches that were cut off into this space as a JSON file, downloadable for a day, and the form says so as soon as you tick it.

**The request this would send** sits beside the form and updates as you type. It is the exact body the
**Search** button sends, with a **Copy** button — paste it into a `recall` call over MCP or REST and you get
the same answer. Two uses, and the second is the reason it is there:

- it answers *"what would this look like from an agent"* without anybody having to write it out in prose;
- and it is how you can tell the screen is not lying to you. It is not a description of the request assembled
  a second time — the panel and the preview call the same code, so a request you can see is a request you can
  send. If one of the two JSON boxes above is not a valid object it says so and shows nothing, rather than
  leaving the last good request on screen.
- **Filter** — a JSON object of extra field constraints, validated before the search runs. The recall filter accepts fields such as `status` and `label`, which are applied as native `$vectorSearch` pre-filters (they narrow the candidate set inside the vector index rather than filtering afterwards). It also accepts **raw MongoDB** — `$or`, `$and`, `$in`, `$regex` and the comparisons — for conditions the simple form cannot express, such as *"status is open OR kind is ask"*. A raw filter is slower (the whole space is scored, then filtered) and returns the same records.
- **Graph hops** — follow the knowledge graph outward from each match, 0–5 hops. Connected entities come back **grouped under the match that reached them**, each carrying the relationship that connects it and every route back to the match, so you can ask "what surrounds this answer" in one search and still see which answer it surrounds. The result count stays the number of matches. Leave it at 0 for an ordinary search; deep values on a densely connected space are slow, so narrow the matches with a filter or tags first.

  **You can narrow the walk**, and once the hops are above 0 the controls for it appear beside them:

  - **Follow edges** — outward, inward, or both. It is not a detail: outward from a person reaches what they own, inward reaches who named them, and a walk that ignores the difference answers a different question and looks identical. Leave it on *Server default* to let the instance decide.
  - **Only these edge labels** — follow just these relationship types, comma-separated. This matters most on a space where a few records are connected to almost everything: an unnarrowed hop off one of those returns whichever neighbours fitted, and nothing distinguishes that from a deliberate answer.

  **The walk follows edges only, unless you ask for more.** A fact, timeline entry or file that names an entity is related to it — but that link is a field on the record, not an edge, so the hops above do not follow it. Three checkboxes turn each kind on: **Also return chrono entries / facts / files reached**. They are off by default because a search answer has a size budget and each match is counted together with everything hanging off it, so records nobody asked for are paid for in answers that no longer fit. With one on, a match that is itself a fact also stops coming back with an empty neighbourhood — the walk starts from the entities that fact names.
- **When the surroundings do not fit** — a search that reaches more connected records than it can show returns
  the ones nearest your matches and writes the *whole* neighbourhood to a downloadable file in the space, valid
  for a day. The result says both: how many it showed, and where the complete set is. A short graph would
  otherwise read as "this record has few relationships", which is a statement about your data rather than about
  the search.

  **Sometimes there is no complete set to offer, and the result says that too.** Following the records that
  merely *name* an entity is bounded per hop, so a dense space can use up a hop's budget on records it has
  already shown. The neighbourhood is then genuinely partial — the rest was never read, so there is nothing to
  write to a file — and the result is marked short with no download beside it. Narrowing the search, or asking
  for fewer hops, is what makes it whole.
- **When the answer itself does not fit** — a search result is also bounded by SIZE, not only by `topK`. Ask
  for a hundred matches with their surroundings and the answer can be larger than anything that should arrive
  in one piece, so what fits comes back in full and the answer says where to carry on from. Two things are
  guaranteed and they are the ones that matter: **every record you get is whole** — never half a passage, never
  a record missing part of its graph — and the results you get are the **top of the ranking**, in order, with
  nothing skipped in the middle. So a shortened answer is still the best answers, and the next request picks up
  exactly where this one stopped.

  **What that guarantee costs, and it is the thing to know before blaming the search.** A match is counted
  together with its whole graph, so asking for deeper or wider relationships means **fewer matches fit** — and
  the ones that do not fit are absent, not shortened. A search for a hundred matches that comes back with
  eleven has usually not found eleven things: it has found a hundred and spent the room on the relationships
  around the first eleven. Turn the expansion down, or raise **Max response size**, and the rest appear. And **the page tells you when it happened** — a notice above the results says
  how many of how many came back, states both guarantees, and says what to do about it. Until 3.2.0 it did not:
  a shortened answer looked exactly like a complete one, so a hundred-match search could show a handful of
  records with nothing anywhere explaining why.
  - **Max response size**, under **the answer**, is the ceiling itself — the API calls it `maxChars`, and it
    is counted in CHARACTERS. Raise it
    to get more of a shortened answer in one go; leave it empty for the default. **The default here is the
    larger one.** An agent talking to this instance over MCP gets a smaller default than this page does, because an
    agent's tool result has to fit inside its own client and a browser's does not — so a search that comes back
    whole here can come back shortened for an agent asking the same question, and that is deliberate rather
    than a discrepancy.
    - **The ceiling is one number in four currencies, and all four are on the form.** Bytes and characters
      sit under **the answer** and **size and paging**; tokens is there too, with **characters per token**
      appearing beside it once a token ceiling is set. **Set more than one and the smallest wins** — which
      is the rule that makes offering all four safe, and the reason this page used to say there was
      deliberately one control. Four is the honest number: the units are not interchangeable outside plain
      English, and tokens is the one an agent's budget is actually written in.
    - **A note on the word bytes, which used to be wrong here.** The API called this ceiling `maxBytes` until
      3.7 and counted characters — the same thing for English, and not for German, Polish or anything with an
      emoji in it, where a character can take two or three bytes. A space working in those languages was
      quietly going about a quarter over the limit it had been given. The counting was renamed to what it
      always did, and a real byte ceiling now exists for callers whose limit genuinely is in bytes. Nothing
      changes for this page: the control still sets the same thing it always set.
  - Narrowing the search — fewer results, fewer graph hops, a tighter filter — does the same job from the other
    end, and a search that comes back shortened is usually a sign the question was broader than intended.
  - **Getting the whole tail as one file is a request you make, not something that happens to you.** An API
    caller can add `remainderDump` to have everything that did not fit written to a downloadable file in the
    space, valid for a day. Until 3.2.0 that file was written on *every* shortened search whether anyone wanted
    it or not, which quietly grew the space's storage and slowed the usage figures an operator reads. Now
    nothing is written unless it was asked for.
- **maxTimeMS** — a time limit for this one search. It can only make the search stricter than the instance's own budget, never looser. When the limit is reached you get a **partial** answer rather than an error or a hang: whatever finished is returned, and the result says it was cut short.
- **Something you wrote seconds ago is findable, and there is no longer a box for it.** Meaning-matching
  reads an index, and that index takes a few seconds to catch up after a write — measured here at about
  three. Every search now also scans the newest records directly, so the gap is covered without you doing
  anything. This used to be an **Include fresh writes** checkbox, off by default; it was removed because
  the only thing turning it off bought was a search that confidently found nothing. One limit worth
  knowing: a record still WAITING to be processed for meaning-matching has nothing to match against yet,
  and the Embedding queue on this page is where you see whether that queue is behind.
- **Include passage text** — on by default. Turn it off to get passage *locations* without their text: useful when you want to find which document holds something and read only that part, since passage bodies are the largest thing a result carries.
- **Include diagnostic fields** — off by default, and off is right for ordinary searching. Turn it on to see *why* a result ranked where it did: the exact text that was embedded, the embedding model, the sync counter, and the score from each ranking stage separately. It follows graph hops too, at every depth, so a search with **Graph hops** set shows the same detail on the connected records. The embedding vector itself is never returned and there is no option that asks for it.
- **Include storage bookkeeping** — off by default, and off is what you want almost always. A result normally tells you what was remembered; this adds back where it is filed: when the record was written, when it was last changed, and the ids of everything it is linked to. Those fields are large and repeat on every result — measured on a real space, only about a third of an answer was the remembered content and most of the rest was this — so leaving it off gets you more actual fact inside the same size limit. One trap worth knowing: the creation date is when the RECORD was written, not when the thing you are remembering happened. That date lives in the record’s own properties, put there by whoever stored it.

**If a search fails, read whether it says it can be retried.** Some failures are the question — a filter the
system cannot parse, a value out of range — and those will fail the same way however many times you try. But a
search can also fail because the part of the database that does meaning-matching was momentarily unavailable:
most often for a while after the server restarts, while it rebuilds its search indexes. **That kind of failure
is not your search and is not your data, and the message now says so in as many words.** Try it again; it
clears on its own, in seconds after a blip and in longer after a big rebuild. Nothing is lost while it lasts,
and word-matching searches and the structured Query tab keep working throughout, because they do not use the
same index.
**Results that exist in the graph carry a graph button.** An entity result opens the Graph tab focused on that
entity; an edge result opens it on the entity the relationship starts from — the same jump the Entities and Edges
tabs offer. Facts, chrono entries and file passages have no node in the graph, so they show no button rather
than one that lands nowhere.

**File results are grouped by document.** Searching over files matches *passages*, not whole documents, so a
long paper that is relevant in five places would otherwise fill the list with five near-identical rows. Each
document instead appears once — named, with a badge saying how many passages matched, and each passage listed
under the heading it sits beneath with its text.

Because several rows collapse into one, the header states both counts: *"1 result from 6 matching passages"*.
So a **topK** of 10 can legitimately show fewer than ten rows — the passage count tells you nothing was lost.

**A record can be deliberately kept out of semantic search, and then no search option brings it back.** The
setting is called **`suppressEmbeddings`** and it exists at three levels, all under that one name: on a single
record, on a record *type* (**Settings → Spaces → Schema**, where it reads *"Suppress for this type"*), and on
the whole space (**Settings → Spaces → Danger Zone**). The most specific one wins — record, then type, then
space.

**The two you can set in the app are the type and the space.** The per-RECORD one is API-only today: there
is no control for it on a record's form, either when creating it or when editing it, so an operator who
wants one record out of search sets it on its type instead — or asks whoever writes to the API. It is worth
knowing the tier exists, because a record with no embedding and nothing suppressing its type or space was
set that way through the API. It is meant for records that are **state rather than prose**: a row whose text never changes while its
numbers are updated constantly, which would otherwise be re-embedded on every write for no gain.

What it does is remove the record's embedding, not hide the record. So a suppressed record is still returned by
**Advanced Query**, still opens from its tab, still exports, and is still reached by **Graph hops** from a match
next to it — it simply stops competing on meaning. If a record you know exists never appears in a search, check
these three levels before treating it as a fault.

> Turning suppression off does not go back and embed what was written while it was on. Use the space's
> **Reindex** control on the Overview tab, or re-save an individual record.
>
> The per-record setting is API-only today — there is no checkbox for it in the UI. It was called
> `excludeFromVectorSearch` before version 3.1.0, and 4.0 removed that old name: a script still
> sending it is now refused rather than quietly accepted, so nothing is left half-working.

**In a network, each instance searches with its own model, and from 3.7 that is explicit.** A record that
arrives from another instance is prepared for search **here**, using this instance's own model — the sending
instance's version is never used, because two instances configured with different models produce numbers that
cannot be compared, and the result would be a search that looks fine and ranks wrongly.

The three levels above are read **here** as well, so this instance decides what its own search contains. The
one part that travels with the record is the per-record setting: if the author of a record marked it *"keep this
out of semantic search"*, that mark arrives with it and is respected. Before 3.7 the mark was silently dropped
in one direction — so a record its author had deliberately retired from search would quietly re-enter it on
every other instance, the next time anybody rebuilt that space's search index.

#### Advanced Query

Runs a structured MongoDB-style query against one collection. Select a collection (`facts`, `entities`, `edges`, `chrono`, `files`, or `links`), optionally set a **limit** and **max time (ms)**, enter a filter as JSON, and click **Run**. Results appear below.

**`links` is the newest one and it is worth knowing what it holds.** When a fact, a chrono entry or a file
names other records — the "related entities" and similar fields — each of those mentions is also stored as its
own small record in `links`. Nothing new to fill in: you still write the connection on the record itself, and
this collection is where you can list them, count them, or find the ones pointing at something. A row is just
the two ends and what kind of record each end is.

The API behind this tab also takes **`skip`** (page through the results), **`sort`** and **`dir`** (order by a field), and returns a **`total`** — every record the filter matches, not just the page. Those are useful when you are driving it from a script rather than this form; see [Structured Query](../integration-guide/04d-brain-ops-api.md#structured-query-read-only) for the parameters and the sortable fields per collection.

Example — find all entities of type `service`:

```json
{ "type": "service" }
```

Example — find facts tagged `infra`:

```json
{ "tags": "infra" }
```

---

### File metadata (merged into Files)

There is no longer a separate **File Meta** tab. The metadata Ythril keeps for each uploaded file — the searchable side of a file (its caption/extracted text, tags, and links to entities, facts, and chrono entries) as distinct from the raw bytes — lives in the **[Files](03-files-and-schemas.md#files)** tab, so files and their metadata are one explorer-style view. Each file row shows its **embedding status** (or a live stage bar while it is being processed) and its **tags** inline, and opening a file docks a detail pane beside the preview with the full metadata record — description, tags, entity/fact/chrono links. See [Files](03-files-and-schemas.md#files).

---

## Graph

> Graph is a **tab inside Brain**, not a separate page. Open Brain and click the **Graph** tab.

The Graph view lets you explore how entities relate to each other visually.

**Getting started:**

1. Open the **Graph** tab in Brain.
2. Select a space from the **space chips above the tab strip** — not from the tab's own toolbar, which has no space control.
3. Type an entity name in the search bar and click the result to load its graph.

**Or jump straight there from a table.** The **Entities** and **Edges** tables carry a graph button beside
each row's *View details* eye. It opens this tab rooted at that node with **both directions at depth 2**, so
you land on the neighbourhood rather than on a lone node — then adjust with the toolbar as usual. From the
Edges table the view is centred on the edge's **from** endpoint; the `to` endpoint is one hop away, so the
edge itself is always on the canvas.

The Facts, Chrono and Files tables have no such button, because a graph always STARTS from an entity.
Those records are reachable *within* a graph — turn on the matching toggle and a walk brings back the facts,
timeline entries and files that mention what it passes through, and from 4.0 the ones that mention each other
as well. What they cannot be is the starting point. Use the **Entities** column in those tables to find the
entity you want, then open the graph from there.

**Toolbar controls:**

| Control | What it does |
|---------|-------------|
| **Search** | Find and load an entity as the root node |
| **Depth** | How many hops out from the root to show (1–10) |
| **Direction** | Show outbound edges, inbound edges, or both. It applies to the edges you drew between entities — not to the facts, timeline entries and files that merely MENTION an entity. A mention runs one way, from the record to the entity, so there is no second direction to choose and those are always reached the same way |
| **Labels** | Toggle edge labels. The pill is lit when labels are SHOWN, so switching it off hides them — this row called the control *Hide labels*, which is what it does rather than what it says. By default a label is shown only on the edges of the node you have selected, and on an edge you hover — labelling every edge at once is unreadable on a dense graph, because the labels overlap each other and the nodes |
| **Fit** | Zoom to fit the whole graph in view |
| **Reset** | Clear the graph |

**Interacting with the graph:**

- **Single-click** a node to select it and open the detail panel below.
- **Double-click** a node to make it the new root.
- **Click** an edge to see its details in a popup.
- The **👁** icon on nodes and edges opens a full detail popup.

The detail panel below the canvas shows all facts and chrono entries linked to the selected entity. Use the type filter and description filter to narrow what you see.

**Editing from the graph:** click any fact or chrono row in that panel to open the same editable detail drawer used on the Brain tabs — including tag suggestions, the entity and fact pickers, and the property fields defined by the record type's schema. Saving updates the row in the panel behind it.

---

---

## Brain — Review tab

> **A failed embedding job is retried once per upgrade, automatically.** A job that fails is retried five
> times with a growing pause — about twelve minutes in total — and then marked failed and left alone, which
> is right for one bad record and wrong for an outage. If the embedding model is unreachable for longer than
> that (during an upgrade, say), every queued job in every space is marked failed at once and nothing runs
> again until somebody presses **Retry all failed**. So starting a **new version** now re-queues everything
> that failed under the old one, once, and says how many in the log. Restarting the same version re-queues
> nothing — a record that genuinely cannot be embedded must not be retried on every boot for ever.
> **Reindex tells you it STARTED, not what it found.** The button schedules the work and returns at once —
> a whole-space re-embed is far too long to hold a request open — so there is no count to report yet, and
> the notification says the job is running in the background. The **Indexing** panel is where progress and
> completion show up. It used to print *"Reindexed 0 documents"* in green at the moment the job began, which
> was the acknowledgement being read as the result.
>
> **A proxy space has no Reindex button at all.** It holds no records of its own — its members do — so it has
> no index to rebuild, and the panel says to reindex the member spaces instead.

The **Review** tab inside a space's Brain is that space's record-QA queue, split into sub-tabs:
**Duplicates**, **Contradictions** and **Suggestions**. (Contradictions needs an NLI model configured
under **Settings → Media Processing**; until the scanner has run, the tab explains what it needs.)

**Suggestions** is the space's completeness report, worked as a queue. A space is "set up" long before
it is *usable* — schemas declare types nothing instantiates and properties nothing fills, entities pile
up with no edges between them, files land that recall cannot see. None of that produces an error, so
none of it was visible anywhere. Overview shows the score and its three heaviest deductions; this is
where you fix them.

Each failing check is a card: what it found ("6 of 12 entities have no edges"), **why it costs points**,
a sample of the offenders, how much of that check's weight the space kept, and a button that jumps
straight to the tab holding those records. Entity samples are shown by **name**, not by id. The sample
is capped at five, and a card whose finding is bigger than its sample says so rather than letting five
entries read as the whole story.

Checks that already pass are listed too, collapsed under a count — on a healthy space they are the whole
answer, and a blank page would read as *we checked nothing* rather than *nothing is wrong*. Three states
are kept firmly apart: **nothing to suggest** (every applicable check passes), **nothing to measure**
(the space declares no schemas and holds no records, so there is nothing to check it against), and a
**report that failed to load** — which never renders as a clean space.

A check that cannot be asked is simply absent. A space that declares no schemas has opted out of schema
governance on purpose; it is not scored down for that. The record-type dropdown does not apply here
either — suggestions are findings about the schema and the space, not about individual records.

**Contradictions** lists records in this space that *disagree*. Each card says **why**: a **Field conflict**
names the property and shows both values (deterministic — the two records simply set the same single-valued
property differently), while a **Model verdict** shows an entailment model's judgement and its confidence.
That distinction is the point — "these disagree on `port`" is a fact, "a model thinks these disagree" is an
opinion. Contradictions are never merged: both records are real and which one is wrong is your call, so you
either **dismiss** it (sticky, like a duplicate dismissal), mark it **resolved by edit** after correcting a
record, **link** the two as a contradiction, or pick a winner with **Keep A** / **Keep B**.

**Keep A / Keep B** is usually what you actually mean: *this one is right, that one is stale*. It records who
decided, marks the other record as superseded, and — for two entities — draws the `supersedes` edge for you.
**Nothing is deleted.** The superseded record stays exactly where it was, now labelled, because it was true
once and that history is often the reason you were looking. For a fact or chrono pair the decision is still
recorded, but no edge is drawn (edges connect entities) and the app tells you so rather than letting you
assume the graph changed.

Before deciding, use **Show both in full** on the card: the two lines you see are summaries, which is enough
to triage a pair and rarely enough to judge one.

The view carries the same controls as Duplicates: a **search box** (which matches the disagreeing field
values as well as the record summaries, so "the one about `port`" finds it), a **status filter**, and a
**Scan now** button. The status filter matters more here than on Duplicates, because there are three piles
rather than two — **open**, **dismissed** and **resolved** — and dismissing or resolving a pair moves it out
of the default view. Switch the filter to find it again. If a scan finishes while the entailment model is
unreachable, it says so: nothing was judged, which is not the same answer as nothing disagreeing.

An empty list tells you *which* empty it is. With no entailment model configured it says so and names what
still ran — the deterministic field check runs regardless, so contradiction detection is never simply off.

Facts, entities and **chrono entries** are reviewed. For a chrono pair, a field conflict includes its
**status** — the same event logged twice, once as *completed* and once as *cancelled*, is exactly the kind of
disagreement worth your attention. The **dates** are deliberately left out: two hand-logged occurrences of a
repeating event ("Team sync", every Monday) would otherwise be reported as contradicting each other every
single week, which is the fastest way to make a review queue not worth reading.

**Filtering by record type:** a **Record type** dropdown under the sub-tabs narrows *both* views to one kind
of record — handy once a space's queue mixes facts, entities and chrono entries. It lists only the types
actually present, and disappears when everything is the same type. If a filter empties the list, the page
says *no findings of this type* rather than pretending the queue is clear.

Both lists return at most **500 findings per space**. When that cap is reached the filter says so, because a
filter applied to a capped list can only mean "among the first 500" — clear the filter or resolve some
findings to see the rest.

**Duplicates** surfaces near-duplicate records found by the background semantic-duplicate scanner, **for that space**. It used to be a global page at `/settings/duplicates`; a duplicate pair only ever means something *inside* one space, so it now lives beside that space's data. (The old `/settings/duplicates` link still works — it redirects to the Brain.)

A summary row at the top shows how many pairs are **open**, the **average match confidence**, and how many are **shown**, alongside a **search box**, a status filter (**open / dismissed / all**) and a **Scan now** button. The search box narrows the list by record summary, type, or space — handy once a **dismissed** pile has grown. Each duplicate pair is a **comparison card**: the space and record type, a **confidence meter** (the similarity as a coloured percentage), when it was detected, and record **A** shown side-by-side with record **B**. For an entity pair you can **Merge** the two records (the older one is kept); any open pair can be **Dismiss**ed — dismissing asks for confirmation first, since it removes the pair from the open list.

**Dismissed pairs stay dismissed** — a routine re-embed, a peer re-sync, or an index rebuild no longer drags them back onto the list the way they used to. A dismissed pair **only resurfaces on its own when its content materially changes** (a real edit to one of the records); a re-write that leaves the content the same keeps it dismissed. To bring one back for review sooner, switch the filter to **dismissed** (or **all**) and use **Re-rate** on the card.

The scanner sweeps **facts, entities and chrono entries** by default — logging the same event twice is one of the commonest ways a knowledge base goes redundant.

**Per-space rules:** how the scanner reacts is configured per space on the **Settings → Spaces → (space) → Duplicates** tab. Each rule pairs a **minimum-confidence slider** with an action — `flag` a pair for review, `automerge` it (asks for confirmation, since it's destructive and unattended), or `notify` a webhook. With no rules, pairs are simply flagged for review. You also choose which record survives a merge (older or newer). The scanner is opt-in and off by default.

---
