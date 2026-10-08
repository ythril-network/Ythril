# Settings — Spaces, Tokens and Networks

> Part of the [Ythril User Guide](../userguide.md).

## Settings — Spaces, Tokens and Networks

## Settings — Spaces

> **Editing one space you are already in?** The Brain has a **cog at the far right of its tab strip** that
> opens this same editor for the selected space, without leaving the page. Use the list below to create,
> reorder or compare spaces.

Open **Settings → Spaces** to manage all spaces on this instance. A summary above the list shows the total number of spaces, the storage in use across all of them, and how many are still building (or have failed to build) their search index. A space that is waiting for the search service has its own count, *Waiting for search*, which is not added to *Indexing*: nothing is being built for it. If a space's index is still preparing, its row is flagged so you know recall may be incomplete for it.

### Finding a space, and ordering the list

**A search box sits above the table** (*Search spaces…*) and filters the list as you type. On an instance with more than a screenful of spaces it is the fastest way to the one you want.

Beside it are **seven sort buttons**, and the last two are the reason to know they exist — they answer questions the table cannot otherwise be read for:

| Button | Orders by |
|---|---|
| **⠿** | Your own custom order — drag rows to arrange them |
| **A→Z** / **Z→A** | Name |
| **↓ GiB** / **↑ GiB** | Storage used, most or least first |
| **↓ calls** | Busiest first — most calls in the last 7 days |
| **↑ answered** | **Worst answer rate first** — the spaces being asked questions they cannot answer |

That last one is a diagnosis rather than a sort: a space near the top is one people are querying and not getting answers from, which usually means it is missing content rather than misconfigured.

### What the columns mean

Two of the table's columns are not self-explanatory.

| Column | What it shows |
|---|---|
| **Label** / **ID** | The name you gave the space, and the identifier the API uses |
| **Storage** | **One column, not two.** `1.20 GiB / 5 GiB` when the space has a quota, just the amount used when it does not, and `—` when it is empty and unlimited. A bar behind it turns amber past 70% of the quota and red past 90% |
| **Usage (7d)** | Calls in the last seven days, and the share of recalls that **found something**. A low percentage is the one number on this page worth acting on — it means people are asking that space questions it cannot answer |
| **Networks** | Which networks share this space |
| **Proxy** | Marked when this space stands in for others |

Storage shows **megabytes** below 1 GiB, so a small space reads `40 MB` rather than `0.04 GiB`.

### Creating a space

You need a token that **may create new spaces** (or an instance administrator). The space you create is then
yours to administer.

If the database is not answering when you click **Create New Space**, the answer is `503`, *database unavailable, try again*, over the API and the `save_space` tool alike. It does not say that a space with that ID already exists unless one does; press the button again once the database is back.

Click **Create New Space**. Fill in:

- **Display Name** — the human-readable label shown everywhere in the UI.
- **ID** — optional. Short lowercase identifier (auto-generated from the name if left blank).
- **Max GiB** — optional storage quota. Leave blank for unlimited.
- **Purpose** — optional description of what this space is for. Visible to AI assistants.
- **Proxy for** — optionally mark this as a proxy space standing in for one or more other spaces (tick individual spaces or "all"). A proxy stores nothing of its own, so it gets no collections, is never embedded, scanned or swept, and deleting it removes only its entry. A space whose `config.json` entry says `"proxyFor": []` (only a hand edit writes one) is an ordinary space: the server removes the empty list when it reads the file and logs a warning naming the space.
- **Validation mode** — the schema-validation posture for the new space: `off`, `warn`, or `strict`.
- **Strict linkage** — a tickbox, on by default. While it is on, the space refuses to delete a record that another record still points at, and refuses a link to something that is not there. Untick it to allow both. This is the seventh field and the note below is about it as much as about validation.

> **New spaces start strict.** A freshly created space defaults to **`strict` validation** *and*
> **strict linkage** — it enforces its schema and referential integrity from day one. You can relax
> either from the space's **Schema tab** at any time. (Until you define per-type schemas there's nothing
> to violate, so a brand-new empty space still accepts anything.) Spaces created by joining a federation
> network are the exception — they stay lenient so incoming federated records are never rejected.

### Space settings

Click the gear icon on any space row to open its settings panel. Changes save and close automatically. An accidental click **outside** the panel won't close it (so you can't lose half-typed edits that way) — close it deliberately with **✕**, **Cancel**, or **Escape**; if you have unsaved changes you'll be asked to confirm.

> **A `Governed` badge in the panel header means Save opens a vote.** The space belongs to one or more
> networks (hover the badge to see which), so a change to its purpose, usage notes or schema is **submitted
> for a vote** in each network rather than applied immediately — you'll see *"saved as a proposal"* and the
> change takes effect when the vote passes. **If your vote alone decides it** — you organise the club, you
> publish the pub/sub network, or you are the only member — it passes on Save and applies at once. Local, operational settings (storage quota, auto-delete window,
> extraction and media-analysis overrides, duplicate rules) are never voted and apply at once. No badge
> means the space is in no network and everything applies immediately.

**Settings tab:** Update the display name, purpose, usage notes for AI assistants, storage quota, auto-delete window, document-extraction mode, and per-space **media-analysis** levels — grouped into **Identity**, **Purpose**, **Limits**, **Document extraction**, and **Media analysis** cards. The Media analysis card lets you override, per space, how **images**, **audio**, **video**, and **text** are analysed on upload (each defaulting to **Inherit instance default**). As with extraction, each picker only offers the levels **the instance ceiling allows** (set per class under **Settings → Media Processing**) — a space can never analyse more than the instance permits, so higher levels are hidden and a note names the ceiling. When a storage quota, auto-delete window, or extraction override is left blank, the field's own placeholder (**Unlimited** / **No expiry**) or the **Use instance default** / **Inherit** option shows what the default will be.

- **Delete records after (days)** — an optional space-wide expiry, **on the Danger tab** rather than here: it deletes data, so it sits with the other destructive settings. It is **one window per kind of record** — entities, facts, edges, chrono, files — because a space rarely holds one kind of thing. Leave a field blank or `0` to keep that kind forever. Deletion propagates over sync, so an expired record won't come back from a connected peer.

  It is the **least** specific of three tiers — most specific first, a single record's own TTL (set by the API on the write), then that record *type's* window on the **Schema** tab, then this space-wide number. A type with its own window ignores this one.
- **Extraction mode** — how thoroughly documents (PDF / DOCX / EPUB) uploaded to *this* space are read. Leave it on **Instance default** to follow the instance-wide setting (**Settings → Media Processing**), or choose one for this space: **Off**, **OCR** (fastest, text + layout), **VLM** (transcribe pages with a vision model, always falling back to OCR), **Repair** (adds a pass that reconciles the transcription against the OCR text), or **Auto** (as much as the instance can do). Useful when one space holds scanned archives that need the heavier path while the rest of the instance stays light. The dropdown only offers the modes **the instance ceiling allows** (set under **Settings → Media Processing**) — a space can never extract more than the instance permits, so higher modes are hidden with a note naming the ceiling.

  The instance setting is a **ceiling, not a default**: a space can ask for less than the instance allows, never more. If the instance is on **OCR**, a space set to **Repair** runs OCR — it keeps its choice and returns to it if the ceiling is raised again. Raising the instance level lifts only spaces on **Auto**.

  **Off means documents are stored but never read.** No text is extracted, so nothing inside them can be found by search — those uploads are marked *skipped* rather than sitting in the processing queue. This override is local to your instance — it is never synced to connected peers.

**Network schema layers.** When the space is in networks that send schema, the Schema tab opens with a **Network
schema layers** panel: each network in the order it applies, the arrows to change that order, and every **clash**
— a type or property two networks define differently — with the network that currently applies marked. The one
higher in the list wins; both keep syncing their records either way. **Save order** rebuilds the space's schema.
Reordering needs the Schema right at admin. The panel is not shown for a space that no network sends schema to.
To settle a clash for good, **Propose** beside a network that holds the other definition offers it the one that
applies here: that network's members vote, and once it passes it becomes that network's definition on every
member. Your own definitions are not changed. It needs the Networks right at write.

**Schema tab:** Define what data this space accepts. A **Schema validation** bar at the very top holds the space-wide **Validation mode** and **Strict linkage** controls — these govern *every* type in the space, not the collection you happen to be viewing. Below it, the entity / edge / fact / chrono collections each list their types on the left; click one to edit its rules in a stable panel on the right (you don't lose your place editing a type or property, and several property editors can be open at once).

- **Validation mode** — `off` means anything goes; `warn` lets writes through but flags violations; `strict` blocks invalid writes entirely.
  > **Editing is checked too.** The record **as it will be** — yours plus the existing fields — is checked
  > before it saves, so an edit cannot save a value the same space would reject on create.
  >
  > **`strict` refuses what your edit breaks, not what was already broken.** A record can be invalid before
  > you touch it — written before you tightened the schema, imported, or synced from another brain. That is
  > reported, not refused: the problem is already saved, so blocking your edit would not fix it, it would
  > only stop you maintaining the record.
  >
  > The message says which is which — *"the change violates…"* versus *"this record was already
  > non-compliant before your change…"* — so you are not sent looking at the wrong field. Validation is of
  > the result, so fixing the named field in any later save repairs the record.
- **Strict linkage** — when on, references between items must be valid IDs and deletion of referenced items is blocked.
- **Type schemas** — define per-type rules under each knowledge type (entity, fact, edge, chrono). For each named type you can set:
  - **Naming pattern** — a regex the name must match. Refused on save if it could run exponentially
    (typically a repeated group like `(,abc)*`); the message names what to change.
  - **Retention** — how long records of *this type* are kept, overriding the space-wide window on the Danger tab. Leave **Delete records after** empty to inherit it; the hint names the number you would inherit. A type with a window carries a yellow **ttl** badge in the list, so what expires is visible without opening each type.
    - **Drop detail after (days)** appears for **chrono types only**. It removes the description, matched text and embedding at that point — the record stops competing in search — while its properties, title, type and dates stay queryable. Useful for telemetry that crowds out real answers but whose fields are still worth having. It must be **shorter** than the delete window, or it could never happen; the editor says so if it isn't.
    - A type **linked to the Schema Library** has no retention of its own: a library entry cannot carry a window (it would apply to every space using it). **Unlink** first, or set the window on the space-wide default instead. Saving a type *to* the library also leaves its window behind, and says so when it does.
  - **Permitted ends** — **edge types only**: which entity types may sit at each end of a link with this
    label, and whether an entity may have more than one. Two lists (**From** and **To**) plus **At most one
    edge with this label per source entity**. A list left untouched means any entity type — unticking the last
    box returns that end to *any*, never to *none*. **The lists are not paired**: every From type combines with
    every To type, so the tab states how many combinations that is and lists them. **no type at all** is a
    pickable choice in both lists, for entities carrying no type. Breaking a rule is reported or refused
    according to the space's **Validation mode**, like every other rule here — see the Files & Schemas guide
    for what happens to links that already exist.
  - **Property schemas** — rules for each property field (type, allowed values, min/max, pattern, required, default).
- **From Lib** — import a schema from the Schema Library. The type row shows a badge and stays in sync with the library automatically. While linked, the type's properties are shown **read-only** so you can see what it enforces; click **Unlink** to copy the library schema inline (breaking the link) and then customise it for this space.
- **From File** — import a schema from a previously exported JSON file.
- **Save to Lib** — save the current type schema to the Schema Library for reuse in other spaces.

The toolbar at the top of the tab has **four** whole-space actions. **Export JSON** / **Import JSON** download or load the entire space's type schemas as one file. **Import library** pulls type definitions in from the instance's Schema Library — the reverse of the button beside it. **Export to library** copies the *whole* space schema into the Schema Library in one step — one reusable entry per type, grouped under a name you choose (defaulting to the space's), so you can later apply the whole set to another space. Types already linked to the library (`From Lib`) are skipped. Save any pending edits first — it exports the last saved version.

**Duplicates tab:** The fourth tab. It decides what this space does when the background scanner finds two records that look like the same thing.

With no rules, a likely duplicate is simply **flagged for review** and waits for you on the Duplicates
page. A rule raises that: give it a **minimum score** and an **action**, and any pair scoring at or above
it gets that action instead.

| Action | What happens |
|---|---|
| **Flag for review** | The default. The pair waits for a person |
| **Notify (webhook)** | Posts to your webhook subscriptions, or to a URL you override here |
| **Auto-merge (entities)** | **Merges the pair unattended and permanently.** Entities only |

Auto-merge asks you to confirm when you switch it on, and it is worth reading: one record of every
matching pair is absorbed with no review. **Merge survivor** decides which one is kept — older by default,
or newer.

**Evaluate rules in real time (on insert)** is off by default and is the setting most worth understanding.
Left off, rules run only during the scheduled scan. Switched on, they also run the moment a record is
written — **including bulk inserts**, so an import of ten thousand records evaluates ten thousand times.
Turn it on when duplicates must not exist even briefly; leave it off when writes come in batches.

Rules are evaluated highest-threshold first, and these settings are local: they apply at once and are
never put to a network vote.

**Danger tab:** Set the space-wide retention window, rebuild search indexes, rename the space ID, wipe all data, or delete the space entirely. It also holds **Backfill embeddings**, which is what you press after turning **Suppress embeddings** off: suppression leaves records unembedded and nothing revisits them, so search stays blind to whatever was written while it was on. It queues a job per record with no vector and reports how many it found — bounded, so a large space may say there are more left and you run it again. Not the same as **Rebuild search indexes**, which rebuilds the index over vectors you already have. Integrators: `POST /api/space_reembed`.

**Retention** is the space-wide default: **Delete records after (days)**, as **five fields** — Entities, Facts, Edges, Chrono, Files — each applying to records of that kind with no TTL of their own and no window on their type. Five, not one, because a `tickets` space keeps ticket entities for a year and their status-change chrono entries for a month; **Files** gets its own because uploads share this setting and have no type for the Schema tab to reach.

**Expired records are removed by a sweep that runs every 5 minutes, and a large backlog clears over several runs.** Each run deletes up to **500** expired records per collection, so shortening a window over a space with thousands of due records, or importing an old backup, does not empty it at once; the rest go on the following runs. A record the sweep **cannot delete** (the database refused it, or timed out) is skipped for that run and reported in the Server Log with a count and its first few ids — see *A retention sweep that cannot delete a record skips it and reports how many* in [Storage, data and audit](05-storage-data-and-audit.md) — and it does not hold back the expired records behind it. A collection that keeps failing is logged and counted (`ythril_housekeeping_records_failed_total`) rather than retried until the run ends, and is tried again on the next run. One space failing or hanging does not stop the sweep of the other spaces.

> **In a space that syncs, every instance applies its own windows — and a deletion travels.** Each instance works out an expiry from the fields above for every record it holds, including records that arrived from a peer or an import: a record that has no expiry here yet is given **this** instance's window, **counted from when the record was created**, not from when it arrived. So a record older than your window arrives already due, and the retention sweep removes it (a backlog over the sweep's per-run limit, above, takes several runs). **That removal is a normal delete, and its tombstone is passed on to peers** — and a peer applies a tombstone to the records its issuer AUTHORED and, on a pub/sub network or a tree, to the records that issuer *delivered* to it from above, whoever wrote them. So on a synced space, the shortest window any member has decides how long an old record lives on that member; when the record's author is the one with the short window, its sweep deletes the record on every peer; and **on a pub/sub network or a tree, a publisher's (or parent's) sweep deletes, on every instance below it, the records it relayed from others too**. Records you wrote yourself are never removed by your publisher's sweep. An instance keeping tickets for a year loses the year-old tickets written by a peer that keeps them for a week, as soon as that peer's sweep reaches them. Give every member of a network the same windows if they must keep the same records. Once a record has an expiry here, a peer's later edit keeps it rather than restarting the clock; a local write recomputes it. An **import** is a restore: it keeps the expiry the backup recorded (or gives this instance's window to a record the backup recorded none for) and never the expiry of the record it overwrites — a record backed up as "never expires" stays that way.
>
> Upgrading from before 4.0: records a peer's window already deleted are not restored, and a stamp that came from a peer is replaced by your own the next time that record is written.

Below the fields, any type that *does* have its own window is listed read-only — that list is where you see what actually overrides these numbers, and it is edited on the type, in the **Schema** tab.

**Rebuild search indexes** is the repair for *search returns nothing and nothing says why* — a space whose vector indexes are missing or were destroyed. It re-creates them from your existing content; search stays empty until it finishes, and nothing is deleted. Reindexing is not a substitute: it re-embeds content against the current model and cannot recreate a missing index. Requires an admin token (and TOTP when MFA is on). The same rebuild is also available per space directly from the **vector-index table** under Settings → Media Processing → Tools — the one place the drift (recorded *ready* vs. a database with no index) is actually visible — behind the same confirmation.

> **A space can be *Waiting for search service*, and that clears by itself.** The search service (`mongot`, next to the database) can start after Ythril does. Until it answers, a space shows *Waiting for search service* with a still dot instead of the spinning *Preparing indexes*, because nothing is being built: semantic search is simply not there yet. The page keeps checking (about every 30 seconds while every such space is only waiting, every few seconds while a real build runs, and not while the tab is hidden), the badge changes when the service is back, and Ythril builds every missing index on its own. Use **Rebuild search indexes** only if the state never goes away. *Index build failed* now means a build that really failed or ran out of time, and **Rebuild search indexes** is the repair for it.
>
> **An empty collection has no search index, and that is healthy.** A search index exists only while its collection holds something: it is built when the first record of that kind arrives and removed a minute after the last one is deleted, because every index costs the database work on every write whether or not it can return anything. A new space therefore starts with none and still reads *Ready*, and its first entity is findable straight away while the index for it builds. **Rebuild search indexes** rebuilds only the collections that hold records.
>
> **Optional indexes do not count towards those states.** The face gallery is built when face recognition is enabled and is not part of what search needs, so a space with every search index in place reads as *Ready* even when the gallery is absent — including when face recognition is on with no model configured. A missing gallery is still reported, but not as the space failing.

The other three are guarded: because renaming changes the space ID (which breaks existing token and MCP references to it), **Rename** — like Wipe and Delete — asks you to type the current space ID to confirm.

Each space row carries only a gear/configure (⚙) button — there is no pencil icon. Rebuilding indexes, renaming, wiping, and deleting all live inside the space's settings panel, on the **Danger** tab.

### Renaming a space

Open the space's settings panel and go to the **Danger** tab to rename its ID. All data, files, token scopes, and network sync mappings are updated automatically. An agent
administering the space can do the same over MCP with the `space_rename` tool.

A space in a network keeps syncing under the name the network knows it by, so members that joined before the rename see no change. A name another space already syncs under, in any network this instance belongs to, is refused before anything moves — the message names that space and the network; pick another name.

**A rename that meets a database outage says so and can be repeated.** The answer is `503`, *database unavailable, try again*, and it never claims that the name is taken or that the space does not exist. A rename that was interrupted part-way keeps its place: repeat the same rename once the database answers again and it is finished. The same holds for the MCP `space_rename` tool.

### Deleting a space

In the space's settings panel, open the **Danger** tab and click **Delete space**. You will be asked to type the space ID to confirm.

### Wiping a space

In the **Danger** tab, click **Wipe all data**. A confirmation dialog shows how many items are in each collection and asks you to type the space ID before you proceed. The space itself (its settings, label, schema) is kept — only the data inside it is removed.

### Keeping a record of deleted files

Deleting a file removes its bytes and, by default, its record too. The **`softDeleteFileMeta`** setting keeps the record instead, flagged as deleted, as an audit trail. It is a top-level key of `config.json` (default `false`); there is no control for it in the app, and the file's own bytes and everything made from them (its text, thumbnails, search entries) are removed either way.

**The kept record belongs to this instance alone.** It is not shown in the file list or counted in a space's file totals, and it is never sent to a peer or counted when instances compare their data, so keeping records never makes two synced instances look different. A restore from an export brings the flag back with the record. Writing the same path again, here or through a file a peer delivers, makes it a live file again and clears the flag.

**A deleted file does not come back as an answer.** The kept record is not a search result — not by meaning and not by
word — nothing you draw a connection from or to can point at it, and it cannot be edited: asking for it by path gets
the same "not found" a path that never existed gets. **Where you CAN read it is Brain → Query**, the panel where you
write a condition instead of a search: ask the Files collection for records with a `deletedAt`, and you get what was
deleted and when. That is deliberate — it is the one place the record is readable, and keeping it readable nowhere
would make an audit trail you cannot audit.

**Each instance follows its own setting.** A peer learns of a deletion from the removal notice, and applies it by *its* `softDeleteFileMeta`, whatever yours is: an instance with the setting on keeps a flagged record of a file a peer deleted, one with it off removes the record. The audit trail therefore exists exactly on the instances that switched it on.

---

## Settings — Tokens

All access to Ythril — from the web UI, REST API, or AI assistants — requires an access token.

**Token types:**

| Type | Access |
|------|--------|
| Admin | Everything, including token and space management |
| Standard | Brain, files, and MCP tools; cannot manage tokens, spaces, or networks |
| Read-only | Search and read only; all writes blocked |
| Library Access | Public schema library endpoints only (`/api/schema-library/public*`); no space data, no brain, no files |

Tokens can also be **space-scoped** — restricted to a specific list of spaces. Spaces outside that list are invisible to the token. Library Access tokens are always space-less.

**Tokens named `peer:…` belong to other instances in your networks**, and each has exactly one. Joining another network with the same instance hands it a new token, and the one it replaces is revoked at once — an instance keeps only the newest token you gave it, so the older one could never be used again. Instances that had collected several from earlier joins drop the unused ones the next time they start.

### Finding a token in the list

**Every column sorts except the buttons.** Click a column heading to order the list by it; click the same one
again to reverse it. The caret beside the heading fills in to show which column is active and which way it is
pointing. Sorting happens in the browser — the list is not paged, so what you see is the whole of it.

**Two columns have a search box docked under the heading**: **Label** and **Spaces**. Both match on any part of
what you type, ignoring capitals, and the two narrow the list together rather than as alternatives. Clearing a
box widens it again. Searching **Spaces** also matches the words the badge shows, so typing `all` finds the
tokens that are not restricted to any space — the ones with the widest reach, which have no space names to
match on.

If a search leaves nothing, the table says so and offers to clear it. That is deliberately a different message
from the empty state you see with no tokens at all: filtering to nothing does not mean your tokens are gone.

**Two of the orderings are worth knowing, because a sensible-looking alternative would be wrong.**

- **Spaces sorts by reach, not alphabetically.** Library-Access tokens first, then the tokens restricted to
  fewest spaces, and the unrestricted ones last. So one click puts your broadest tokens at one end, which is
  the question this column is usually being asked.
- **Blanks stay at the bottom, whichever way you sort.** *Never used* and *No expiry* are absences rather than
  values. Sorted as though they were dates, every never-used token would head the list as if it were the
  least recently used, and a block of permanent tokens would bury the ones expiring soonest.

Sorting is a view, not a setting: it is not remembered, and reloading the page returns to the server's order.

### Creating a token

Click **Create Token**. The dialog asks for:

- **Label**
- **Expires (optional)**
- **Requests per minute** — this token's own rate limit; leave it empty to inherit the instance default
- **Permission level** — the per-space rights matrix
- **Instance-level rights**, a separate block at the bottom of the dialog with two checkboxes

Then **Create token** — the value is shown **once**. Copy it immediately.

> **The two instance-level checkboxes are the widest thing this dialog can grant.** **Instance
> administrator** and **May create new spaces** are not rungs on a space: the dialog says so itself —
> *"these apply to the whole instance. A space-restricted administrator cannot grant them."*
>
> **May create new spaces is enough to create one**, from this page, over the API, with the `save_space` tool, or by
> joining a network — no instance administrator needed. The token that creates a space becomes its administrator,
> and that grant is written to the audit log (`token.creator_grant`).

The matrix is the whole permission model. A spaces list and a three-way Read-only / Standard / Admin level
describe the same access in an older vocabulary, and the server refuses a request that uses both those and
the matrix at once. The matrix says everything they say and things they cannot — such as **admin on Files in
one space and nothing anywhere else**.

The tokens list shows each token's scope at any time. The **Permission** column draws a small **bar chart**,
one bar per rights area, each bar's height being the highest rung that area reaches, with a red line marking
the floor that applies to every space. So a glance separates a token that is admin everywhere from one that
is admin on Files in a single space — which a single colour could not.

This dialog has no "Library Access" toggle. Library Access tokens (for sharing your schema library with other instances) are created separately, from the **Schema Library** page's own **Create token** dialog — see [Schema Library](03-files-and-schemas.md#schema-library).

**Editing a token.** Each row has **two** pencils, and they do different things. The one beside the label
renames in place and saves on its own. The one in the **Permission** column opens the rights editor. So a
rename and a scope change are two edits, not one. The secret is untouched by either; use **Rotate** for
that.

#### The areas

Every space row has one cell per area, and they are not interchangeable — `write` on Files and `write` on
Knowledge are different permissions:

| Area | What it covers |
|---|---|
| **Knowledge** | Facts, entities, relationships and timeline entries — the records the space is made of, and searching them |
| **Files** | Documents stored in the space: reading them, writing them, and the folder structure they live in |
| **Schema** | The shape the space expects its records to take — which types exist and which properties they carry |
| **Data quality** | Finding and resolving duplicates, contradictions and gaps, and the review decisions that follow. **Merging** a duplicate pair also needs **Knowledge** write in that space, because a merge deletes one of the two records |
| **Networks** | Sharing the space with other instances: **read** sees the networks it is in, **write** creates a network with it and leaves a membership this token made, **admin** changes a network's settings and leaves anyone's |

**Networks is different from the other four in two ways.** A network carries several spaces, so a token needs the
rung on **every** space in it — one space short and the action is refused, naming that space. And it is **not
part of administering a space**: the Space admin column leaves the Networks cell as it is. A space admin can
still share **its own** spaces without it: create a network with them, join one onto them, and invite others. Tokens
created before this column existed hold `none` there.

#### Hover a rung to see what it grants

Each of the four segments in a cell carries a tooltip, and it leads with what that level actually allows —
*"Your agent can add, edit and delete single records"* — in the same words as the column header's `?`. The
description differs per column, because `write` on Files and `write` on Knowledge are not the same permission.
What clicking will do follows after it, including the fact that clicking the level you are already on steps
down one.

#### Administering one space, without administering the instance

**A space administrator holds `admin` in all four areas of one space — and you grant it in one
press**, with the **Space admin** column at the right-hand end of the matrix.

The grant is stored as itself, so it survives an edit to a neighbouring cell. Four admin cells set by hand are
not the same thing: they give full access to the space's data, but not to its tokens or its settings.

What it means in practice: that token can manage **that space's own tokens** — list, mint and edit them — and
**that space's own settings**, schema and index rebuilds. Nothing wider.

**What it cannot do, which is the part worth trusting:** it is never instance-wide. It cannot grant
**instance admin** or **create spaces**, it cannot set the all-spaces floor, and it cannot see or edit tokens
that reach any space it does not administer — those tokens do not appear in its list at all. So handing
somebody administration of one space does not quietly hand them a way to widen it.

**An instance administrator administers every space.** Ticking **Instance administrator** also turns on the
**Space admin** switch in the **All spaces** row, which covers every space including ones created later, and
that switch stays locked on while the box is ticked. Unticking the box leaves the switch on; turn it off
yourself if the token should lose it. Instance-admin tokens created by 5.0 to 5.3 without the switch get it back
when the instance starts, and the log names each token it changed.

**To check whether a token has it:** read the **Space admin** column. **A** means the token administers that
space, by name or through the **All spaces** row; four admin cells alone do not. An agent can ask `help` and its space list marks the spaces the calling token
administers.

#### Some cells hold each other up

A cell will not always go as low as you click, and the greyed-out segments say why when you hover them. There
are two reasons a cell is held:

- **The all-spaces floor.** The top row is a *minimum*, not a bulk setting, so no space below it can sit lower.
- **Another area needs it.** Setting **Knowledge** to **write** holds **Schema** at **read** in the same
  space, because writing a record against a schema means reading that schema first. A token with write on
  Knowledge and none on Schema is not a narrower token — it is one that cannot do the thing it was granted.

The second is applied when access is checked, not written into the token. The matrix keeps saying what you
set, so lowering Knowledge back to **read** returns Schema to whatever you had chosen rather than leaving
behind a permission nobody picked. This is why the Schema cell can show **read** while the token you exported
shows `none` — both are correct, and the grid is showing you what the token can actually do.

> **A matrix stored in an obsolete shape is repaired when the instance starts.** If a token's stored rights
> name an area the server no longer knows, or leave one of the four out, startup normalizes the matrix and
> writes it down: an unknown area is dropped, a missing one comes back at **none**, and every rung the server
> can still read is kept exactly as it was. The repair only ever narrows, so re-check the token's matrix after
> upgrading if you see one change; it never restores access from the pre-3.0 `admin` / `read-only` / spaces
> fields.

#### The Space admin column

**Press A on a space's row to make that token the space's administrator; press – to take it back.** The
column reads the state too: a row shows **A** when the token administers the space, granted on that row or
through **All spaces**. Four admin cells set by hand do not show **A**, because they do not make the token the
space's administrator. Two positions and not four, because administering a space is not a
level — anything in between is still said with the four area cells.

Pressing **A** records *"this token administers this space"* as a grant of its own, so the next edit to a
cell does not remove the role. Pressing **–** withdraws the grant and leaves the area cells as they are. The token can then do two things:

- **Manage that space's tokens** — create them, edit their rights, rotate and revoke them. It only ever sees
  and edits tokens whose own reach sits inside the spaces it administers.
    Rotating and revoking are bounded the same way, and refuse with a message naming which spaces put the
    token out of reach.
- **Change that space's settings** — its name, its schema and types, and a re-index of its own search
  indexes.

**Almost none of that needs all four areas.** Each setting answers to its own area — media levels
to `Files`, duplicate rules to `Data quality`, the record lifetime and embedding switch to `Knowledge` admin,
types to `Schema`. A space administrator holds all of them; a token needing only one can be given only that
one. A save touching something the token may not change is refused
WHOLE, naming each field, so nothing is half-applied.

All four areas, deliberately. Admin on **Files** alone would be enough to mint tokens if any single area
counted, which is a bigger grant than the cell appears to make.

**Administering one space grants nothing in another.** The check is against the space being edited, so an
administrator of *Research* who opens *Finance* is refused.

**Two things stay with the instance owner**, and both refuse with a message saying so:

| Stays instance-only | Why |
| --- | --- |
| **Max size (GiB)** of the space | It is that space's share of the machine's disk, not a setting of the space |
| Creating, reordering and **deleting** spaces | There is no space to scope those to, and deleting one is not one of its settings |

If MFA is on, a space administrator is prompted for a code like everybody else.

**The second factor is not a token setting.** MFA is instance-wide and lives in **Settings → Preferences**;
there is nothing about it in the token dialogs, and there is no per-token exemption to grant here.

#### A few actions belong to no area, and the panel now says which

Open the **?** beside `Space admin` and, under what it grants, there is a short list of routes the four-area
grid does **not** decide — renaming a space, reading which tokens reach it, and its usage counters — each with
the reason. They are read from the server, so the list cannot fall out of step with what is enforced.

**Why it is worth a line.** A grid of four areas looks complete, but these space-scoped actions sit outside
all four: if you are checking whether a token can rename a space, no cell in the matrix answers it.

It does **not** mean those actions are unguarded. A token that cannot reach the space cannot call them at all,
and each one still needs admin or space-admin. What the list says is only which mechanism decides.

### How many requests a token may make

**Each token has its own request budget, per minute.** Left alone, every token gets the instance's number — so
you do not have to think about this at all unless one client is drowning out the others.

Set a lower one on a token when it is doing bulk work you do not want competing with people using the product:
a nightly importer, an agent that crawls, anything that would happily send a thousand requests a second if you
let it.

#### What you will see on the token list

Two numbers, and the second is the one that answers questions:

| column | means |
|---|---|
| the value you set | blank on most tokens, and blank means *use the instance's number* — not *unlimited* |
| the effective limit | what is actually enforced right now |

When a client goes over, its requests get **429 Too Many Requests** and a `Retry-After` telling it how long to
wait. Other tokens are unaffected — the budget is per token, which is the entire point.

#### If the box refuses your number

Whoever runs this instance can set a ceiling that admins cannot exceed. If they have, and you ask for more, the
save is refused and the message tells you the ceiling and who owns it. Nothing is saved in that case — you will
not find a smaller number quietly stored in place of what you typed.

That ceiling is set outside the product, in the instance's environment. If you need it raised, that is a
conversation with whoever operates the server rather than something this page can change.

### Rotating a token

Click the ↺ icon on any token row. A new secret is generated; the old one stops working immediately. The new value is shown once.

### Revoking a token

Click the ✕ icon and confirm. The token is deleted and can never be used again.

Your current session token is marked **(current session)** in the list.

---

## Settings — Preferences

**Settings → Preferences** holds the choices that belong to you in this browser rather than to the instance:
the interface language, how dates and times are shown, and your second factor (see the next section). The first
two are kept in this browser only — another browser, or a private window, starts from the defaults.

### Language

English, Deutsch or Polski. The switch takes effect at once, without a reload, and dates that follow the
language (see below) switch with it.

### Date and time

Every date and time Ythril shows — a table's created column, a record's Created and Updated fields, a token's
last use and expiry, a network member's last sync, a change note, a shortened search's download expiry — is shown
in the format you pick here. What is **stored** does not change: every timestamp is kept, sent and synced as
ISO 8601 in UTC, and this setting only decides how it reads on your screen.

- **Format**
  - **Automatic** (the default) — your locale decides the order and the clock. It is your browser's locale when
    your browser speaks the interface language (English in a `en-GB` browser reads day first), and the interface
    language itself when it does not: switch the interface to Deutsch in an English browser and dates read the
    German way, `29.09.2026`. The option names the locale it is using.
  - **ISO 8601** — `2026-09-29 07:59:03`, year first and a 24-hour clock, the same in every language.
  - **Day.month.year, 24-hour** — `29.09.2026 07:59:03`.
- **Time zone** — **Local time** shows your browser's zone (the option names it, for example `Europe/Berlin`);
  **UTC** shows UTC and says so after the time.

Each format option shows the current moment in that format, in the zone you have chosen, so you can see what
picking it does before you pick it. **Hover over any date** to see its exact value, as the ISO 8601 UTC timestamp
that is stored.

---

## Multi-factor authentication (MFA)

MFA adds a one-time code requirement for admin actions (creating tokens, managing spaces). Normal data operations are not affected. There is no separate "MFA" page — the MFA panel lives inside **Settings → Preferences**, under the **Security** heading (the language switcher and the date and time settings sit above it).

**The switch is instance-wide, and that is the whole model.** It applies to admin actions, not to normal data
operations, so a script or scheduler doing ordinary reads and writes is unaffected by turning it on. There is
no per-token second-factor setting in the interface.

### Enrolling

1. Open **Settings → Preferences** and click **Enable MFA**.
2. Scan the QR code with an authenticator app (Google Authenticator, Authy, 1Password, Bitwarden, etc.).
3. Enter the 6-digit code shown in the app and click **Confirm**.

The TOTP secret is generated **on the server** and returned to your browser so it can be shown as the QR code / setup key. Your authenticator and the server then share that secret to verify future codes.

### Day-to-day use

When you perform an admin action, the UI prompts for a 6-digit code. After entering it, the code is cached for 15 minutes so you are not asked again on every click.

### Disabling

Click **Disable MFA**. This **requires a current 6-digit code** — you cannot turn MFA off without your authenticator, which is deliberate: a stolen admin token must not be able to silently remove the second factor.

**Lost your authenticator?** Because disabling needs a code, recovery is an operator action on the host: remove the `totpSecret` entry from `secrets.json` in the instance's config directory and restart. MFA is then disabled and you can re-enrol.

---

## Settings — Networks

Networks sync selected spaces between multiple Ythril instances over the internet.

**Who can manage them.** An instance administrator can do everything here. A token with the **Networks** right
on a space (Settings → Tokens) can create a network with that space, see it, and leave a membership it created;
at **admin** it can also change a network's settings and leave any membership. **Joining** a network from an
invite needs the Networks right at write on each of your spaces it will share — and, if it brings spaces you do not
have yet, the right to create spaces too. **A space admin needs none of that for its own spaces**: it can create a
network with any of the spaces it administers, join a network onto them (or onto new spaces, if it may create
spaces), and generate the invite. Peers, votes and sync stay with the instance administrator.

**Each network card says what this instance is in it.** Beside the type is its role — Publisher or Subscriber on
a pub/sub network, Organiser or Member on a club, Member on a closed or democratic one, Root, Node or Leaf in a tree
— and the members shown follow the role: a publisher sees its subscribers, a subscriber sees only its publisher, a
club or voted network shows your peers, and a tree shows the path up to the root and everything below you. The
card also lists the spaces the network carries, and for a space you mapped under another name when joining, the
network's name for it. A subscriber sees no invite and cannot remove its publisher: on pub/sub only the publisher
invites and removes; a subscriber that wants out leaves the network.

**On a club every member connects to every other member, not only to whoever invited it.** When the organiser
admits a new member, the others learn of it on their next sync and connect to it directly, so the club keeps
syncing when the organiser is offline. Until a connection is made the card lists that member under **Connecting**,
with the reason if an attempt failed. Removing a member from a club removes it on every member.

**A closed or democratic network connects its members too, on its own votes.** When a join vote passes, every
member connects to the newcomer by itself, and a newcomer connects to the members its inviter knows. A member that
only another member's list names — typically on a network whose members joined before this version — appears under
**Connecting** as **waiting for your OK**, with an **Accept** button: a member of a voted network votes, so one
member's word must not let it in. Accept it and the two connect on the next sync.

**Adding a space to a network.** The card's Spaces list has an **Add space** picker offering your spaces the
network does not carry yet, where your position allows it: the publisher of a pub/sub network, the root of a tree or
a club's organiser, which all add it at once, or any member of a closed or democratic network, where it opens a vote
that appears under **Open votes** for every member. It needs the Networks right at admin on every space already in
the network and at write on the one you add (or administering all of them). Every other member gets the space on its
next sync, created if it has none. It only adds: nothing there is overwritten or deleted. One exception protects your
own data: on a club, closed or democratic network, a space of yours with the same name that is not in the network
stays out of it unless you voted yes, because those networks sync both ways and joining it would send your records to
every member.

**The schema comes with the space.** On a pub/sub network or a tree, each instance takes a shared space's type
schemas, purpose and usage notes from the instance above it on every sync, so a space created by a join is not bare.
It only adds: types you do not have are added, a type you both have keeps your properties and gains the network's, and
where you both define the same property the network's definition is used. Nothing of yours is removed, and your own
settings — duplicate rules, retention, document extraction — stay yours. Nothing flows back up. A schema that cannot be
merged (for instance, one using a schema-library entry you do not have) is skipped and noted in the log; the records
still sync. A space shared through two networks keeps each network's schema apart: where they define the same
property differently, the network you joined first wins, both keep syncing their records, and each network is only
ever sent your own definitions plus its own, never the other network's. Your own edits stay yours across updates.
A change the network voted on reaches every member, also one that joined later or never saw the vote open, and it
applies as the network's definition, next to yours rather than in place of it.

**What your publisher or parent can delete.** On a pub/sub network or a tree, a deletion your publisher (or, in a tree, your parent) makes also deletes here the records it delivered to you, **whoever wrote them** — a record it relayed from a third instance goes too, and so does a record its retention sweep removes. It never deletes a record **you** wrote, and a record that reached you through another network or another peer is not its to delete. That is the trust a subscriber places in its publisher: a publisher that is compromised or misconfigured could delete everything it sent you. On a club, closed or democratic network a peer can delete only what that peer itself wrote. The first sync after an upgrade also picks up the deletions your publisher made while an older version declined them (Settings → Logs → Server Log says when each space has finished).

### Network types

| Type | Who approves joins and leaves |
|------|-------------------------------|
| **Closed** | All members must agree unanimously |
| **Democratic** | Majority vote, any member can veto |
| **Club** | The person who invited decides alone |
| **Braintree** | All parent nodes up to the root must agree |
| **Pub/Sub** | No approval — any compatible brain can subscribe |

### Enabling networks

The first time you open **Settings → Networks**, networking is off. Click **Enable Networks** to run a short 3-step wizard (Step *N* of 3) that walks you through exposing your brain's connector and confirming the risk model before the Create / Join controls appear.

### Creating a network

Click **Create Network**. The dialog asks for a **label**, a **type**, the **spaces** to include, and a
**Voting deadline (hours)** — how long a vote round stays open before it lapses, 1 to 72.

> **There is no schedule field in this dialog.** The cron box is on the network card afterwards — see
> [Sync schedule](#sync-schedule) below.

### Inviting another brain

1. Expand the network card and click **Generate invite**.
2. Click **Copy invite** — one long line starting `ythril1_`, with nothing to trim or unwrap.
3. Send it to the other admin **the way you would send a password**. Anyone holding that line can complete
   the join, and it looks like gibberish, which is exactly why people assume posting it in a group channel
   is safe. It is encoded, not encrypted. It expires after 1 hour and works only once. (An instance that has
   not been upgraded still produces the older JSON blob, which keeps working.)

**Both ends are recorded in the audit log.** Generating an invite appears as `network.invite.generate`, and the moment the other brain actually becomes a member — or is held for a join vote — appears as `network.member.join`.

### Joining a network

**A pub/sub network's published key joins on its own.** Paste the key (it starts `ythril_invite_`) into
**Join Network**, enter the publisher's URL and your brain's URL, and join. Nobody on the publisher has to accept
you. The spaces you join with are the ones your token may hold. For any other network, or an invite the other side
generated for you, follow these steps:

1. Click **Join Network**.
2. Paste the invite code — the line starting `ythril1_`. (An older brain may have sent you the earlier JSON
   form; paste that instead and it works the same.)
3. Enter your brain's publicly reachable URL (e.g. `https://brain.example.com`).
4. For **each space the network carries**, choose where it goes: under the same name here (into your space of that
   name if you have one, otherwise it is created), **into another space you already have**, or under a new name.
   Joining only adds — the network's records are added next to what a space holds, nothing is overwritten or
   deleted, and no peer, your publisher or parent included, can ever delete a record your instance wrote.
5. Click **Confirm and join**.

The joined network syncs on its own from then on: on the inviter's schedule, or every 15 minutes when the inviter
syncs only by hand. Change it on the network card (see [Sync schedule](#sync-schedule)).

**Two of the network's spaces cannot go into one of yours.** The dialog marks both rows and says which space they collide on; change one of them. Joining with a key (rather than an invite code) has no mapping rows, so a collision there is refused with a pointer to the invite code instead.

**Spaces the network adds later wait for you unless your token could have joined them.** When a publisher, a
parent or a passed vote adds a space you do not have, your instance creates it here only if the token you joined
with could have: the right to create spaces, and that token still valid (not deleted, not expired). A space whose
name you already have **always** waits, whoever joined — the network never starts syncing a space that only shares
its name. Waiting spaces appear on the network card under **Announced, waiting for you**, with the reason. Press
**Accept** to add it, optionally typing a local id to carry it under, or **Dismiss** to say no: a dismissed space is
not proposed again (to change your mind, accept it by its id through the API or the `network_pending_space` tool). Networks joined or created before 5.4 have no record
of the joining token, so everything they announce waits here.

### A space that shows up twice

Before 5.6.0 a space the publisher had renamed reached a new member under the publisher's local name AND under the network's name, so the member held it twice (for example `y-twin` next to `y-project-template`). Upgrading stops it happening again. For a member that already has the duplicate:

- **On a pub/sub network or a tree, it heals by itself** once both sides run 5.6.0: the publisher tells the member which name it means, and the member's copy syncs under the network's name again. Each repair is in the audit log as `network.space_alias.heal`. The now-idle duplicate stays until you remove it: take it out of the network (**not** Dismiss, which would stop the real one being repaired), then delete the space.
- **On a club, closed or democratic network**, press **Accept** on the waiting space and type the name of the space you already carry: that records the network's name for it instead of creating a second one.

Open votes name a space as this instance calls it, so a round about a renamed space shows your name, not the proposer's.

### Sync schedule

Enter a cron expression on the network card (e.g. `*/5 * * * *` for every 5 minutes). Click **Sync now** to trigger an immediate sync without waiting. Leave the field empty for manual-sync only — that is a real setting, not an omission.

**A network you joined before 5.6 had no schedule** and synced only when the other instance started a sync. It gets the every-15-minutes default the next time your instance starts, and the server log names each network it scheduled. A network you set to manual yourself keeps manual — but one cleared before this change cannot be told apart from one never set, so check the card after upgrading and clear it again if you meant manual.

**A value the scheduler cannot run is refused, and the message tells you what to send instead.** A short form such as `every 5m` or `*/2 hours` is refused with the cron expression it means, so the fix is a copy and paste. Short forms already saved are converted on upgrade, so an existing network keeps its schedule.

Upgrading: a saved short form outside cron's range, such as `every 90m`, cannot be converted, so that network syncs only when you press **Sync now**. Each one is listed by name in the server log at startup and left as it is rather than rounded to something you did not choose.

### Change notes

A network that sends downward — a pub/sub you publish, a braintree node with children — can tell its members
what changed. Expand the network card, open **Change notes**, write the note, tick the spaces it concerns if the
network carries more than one, and press **Sync with this note**. The sync runs now, and each member gets the
note in its next exchange, so a member that is offline gets it when it is back. The network also writes a note
by itself when it carries a schema update or a space is added to it.

On every network the same section lists the notes **received from above**, with who wrote them and when; where you
send, it also lists what you **sent** and how many members have not received it yet. A subscriber has nobody below
it, so it sees the received list only. To react to a note automatically, subscribe a webhook to
**change_note.received** (Settings → Webhooks, group **Other**).

**A schema update in a network adds and changes, it never removes.** Saving a space's schema without a type the
network carries keeps that type, here and on every member, and the answer says which types were kept; the
members' note says so too, and each can retire the type locally.

### Sync history

Expand a network card and click **Sync History** to see a log of every sync cycle — timestamp, status, items pulled and pushed, and any errors.

A cycle shows **success** only when every member's transfers completed and nothing sent was refused; a member that refused records shows the cycle as **partial**, with the kind and count, without being treated as unreachable. If a peer refused a transfer or a transfer
was cut short, the cycle shows **partial** (some members completed) or **failed** (none did), and its errors name
the space, the direction and what stopped. A network that shows **failed** on every cycle is not syncing at all,
even though it looks connected.

**A push answered `503` is the peer's database, and it is retried.** When the receiving brain's database cannot
take a page in time — a write it had to stop, a database restarting — it answers that it could not, rather than
leaving the request hanging; this brain keeps its place and sends the page again next cycle, so the cycle counts that transfer as
stopped until the peer's database recovers. The peer's own Server Log names the stalled write
(`seq horizon held …`).

Each member row in the expanded card also shows its **last successful sync** (or *Never synced*) and, when a peer's recent sync attempts have been failing, a red **Failing (N)** badge counting the consecutive failures since the last success — so you can spot a stuck peer without opening the full history.

**A *Version too old* badge is a different thing from *Failing (N)*, and telling them apart saves an
afternoon.** *Failing* means the peer was called and did not answer. *Version too old* means it was never
called: nothing was attempted, so there is no failure to count and no timestamp to show — which is also
what a brand-new member looks like. See *The version a peer has to be running* below.

### The version a peer has to be running

Every brain on a network has to be recent enough for the others to trust what it sends. Each one
tells the others what version it runs, and a brain that is too old is not sent data and is not
accepted from — its member row shows a red **Version too old** badge, and hovering it gives the two
numbers: what that peer runs, and what is required.

**What is required is the first number of your own version, with zeros after it.** A 4.something brain
requires 4.0.0 from every peer; a 5.something brain requires 5.0.0. There is nothing to configure, and
it moves on its own when you upgrade.

That first number is the one that changes when something is removed rather than added, which is why it
is the line. It also stops a chain forming: if the requirement were a few versions back, a 4.1 brain
would accept a 3.2 brain, which would accept a 2.5 brain, and your records would travel all the way
down a chain whose two ends were never compatible with each other.

**What this means for upgrading:** when the first number changes, upgrade every brain in the same
session. Until they are all up, the ones left behind do not sync. Upgrades that only change the second
or third number are unaffected — do those in any order, at any time.

**A brain that ANSWERED and said nothing counts as too old**, and that is deliberate rather than a gap.
Only versions from 4.0.0 onward report themselves, so for a brain you have actually exchanged with,
"said nothing" and "older than 4.0.0" are the same statement. Read the other way round — unknown, so
probably fine — the check would let through every brain it exists to stop.

**A brain you have never exchanged with is a different case, and it is not refused.** Until the two
have talked once, there is nothing to judge — so the badge stays off and an unreachable peer shows up
as **Failing (N)**. This matters for real setups rather than being a technical
nicety: a network where only one side holds the configuration, or where you added a peer by hand, may
never complete the exchange that reports a version, and refusing those would stop them syncing for good
with nothing to show why.

**Nothing needs doing to recover.** Upgrade the old brain and it reports its new version on the next
sync round; the badge clears and data starts flowing again by itself. There is no button, and no restart
on your side.

**Why this matters even though it looks like housekeeping.** A record can be marked *never send this to
an embedding model*. An old brain does not know about that mark, so it drops it, and its copy of the
record comes back with nothing saying to leave it alone. Nobody is told. Requiring a minimum version is
how that stops being possible.

**What it is not.** A brain reports its own version, and nothing checks that claim, so this stops an
OLD brain from mishandling your data — it is not a defence against a brain that lies about itself.
Trust between brains is what the voting and signing settings are for.

**One thing to plan for:** if you run several brains, upgrade them within the same maintenance window
when the required version rises. A network can be upgraded one brain at a time while the requirement
stays where it is, but a brain still below it does not sync in the meantime.

### Voting

When a vote is open (e.g. a member wants to leave), expand the network card and scroll to **Open votes**. Each open vote shows its **Deadline** and a running tally (`N yes · M veto`). Click **✓ Yes** to approve, or **✗ Veto** to block the round — a veto asks you to confirm ("A veto blocks this pending round for the whole network. This cannot be undone.") before it is cast.

**A vote to delete or empty a space acts only if it passes.** A round that reaches its deadline without enough yes
lapses and the space is kept on every member. A member acts on such a vote only for a space its network actually
carries, and only once — a vote cannot reach a space the network does not share.

**Deleting a networked space takes it out of the network; it does not delete anyone else's copy.** When that vote
passes, the space leaves the network on every member, and each member keeps its copy and everything in it as an
ordinary local space, which it can add to a network again. Only your own copy is deleted, as you asked, once no
other network still carries it. Emptying a space is different: a passed wipe vote empties the network's data on
every member.

**Proposing counts as your yes.** When you delete, empty, add or change a networked space, your instance opens the
vote and its yes is already in the tally; the other members' votes decide it.

**Signed votes:** a network can set `requireSignedVotes` so every vote cast must carry a valid Ed25519 signature from the voting member (verified against its pinned signing key). Enable it once all members have published a signing key; if a member rotates its signing key, the new key is accepted with a rotation proof that references the previous one.

### Leaving a network

Click **Leave network** at the bottom of the network card. Your local data in the network's spaces is kept.
