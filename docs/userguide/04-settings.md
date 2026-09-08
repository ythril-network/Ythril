# Settings — Spaces, Tokens, Networks and Media

> Part of the [Ythril User Guide](../userguide.md).

## Settings — Spaces, Tokens, Networks and Media

## Settings — Spaces

> **Editing one space you are already in?** The Brain has a **cog at the far right of its tab strip** that
> opens this same editor for the selected space, without leaving the page. Use the list below to create,
> reorder or compare spaces.

Open **Settings → Spaces** to manage all spaces on this instance. A summary above the list shows the total number of spaces, the storage in use across all of them, and how many are still building (or have failed to build) their search index. If a space's index is still preparing, its row is flagged so you know recall may be incomplete for it.

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

The table has never been described here, and two of its columns are not self-explanatory.

| Column | What it shows |
|---|---|
| **Label** / **ID** | The name you gave the space, and the identifier the API uses |
| **Storage** | **One column, not two.** `1.20 GiB / 5 GiB` when the space has a quota, just the amount used when it does not, and `—` when it is empty and unlimited. A bar behind it turns amber past 70% of the quota and red past 90% |
| **Usage (7d)** | Calls in the last seven days, and the share of recalls that **found something**. A low percentage is the one number on this page worth acting on — it means people are asking that space questions it cannot answer |
| **Networks** | Which networks share this space |
| **Proxy** | Marked when this space stands in for others |

Storage shows **megabytes** below 1 GiB, so a small space reads `40 MB` rather than `0.04 GiB`.

### Creating a space

Click **Create New Space**. Fill in:

- **Display Name** — the human-readable label shown everywhere in the UI.
- **ID** — optional. Short lowercase identifier (auto-generated from the name if left blank).
- **Max GiB** — optional storage quota. Leave blank for unlimited.
- **Purpose** — optional description of what this space is for. Visible to AI assistants.
- **Proxy for** — optionally mark this as a proxy space standing in for one or more other spaces (tick individual spaces or "all").
- **Validation mode** — the schema-validation posture for the new space: `off`, `warn`, or `strict`.
- **Strict linkage** — a tickbox, on by default. While it is on, the space refuses to delete a record that another record still points at, and refuses a link to something that is not there. Untick it to allow both. This is the seventh field and the note below is about it as much as about validation.

> **New spaces start strict.** A freshly created space now defaults to **`strict` validation** *and*
> **strict linkage** — it enforces its schema and referential integrity from day one. You can relax
> either from the space's **Schema tab** at any time. (Until you define per-type schemas there's nothing
> to violate, so a brand-new empty space still accepts anything.) Spaces created by joining a federation
> network are the exception — they stay lenient so incoming federated records are never rejected.

### Space settings

Click the gear icon on any space row to open its settings panel. Changes save and close automatically. An accidental click **outside** the panel won't close it (so you can't lose half-typed edits that way) — close it deliberately with **✕**, **Cancel**, or **Escape**; if you have unsaved changes you'll be asked to confirm.

> **A `Governed` badge in the panel header means Save opens a vote.** The space belongs to one or more
> networks (hover the badge to see which), so a change to its purpose, usage notes or schema is **submitted
> for a vote** in each network rather than applied immediately — you'll see *"saved as a proposal"* and the
> change takes effect when the vote passes. Local, operational settings (storage quota, auto-delete window,
> extraction and media-analysis overrides, duplicate rules) are never voted and apply at once. No badge
> means the space is in no network and everything applies immediately.

**Settings tab:** Update the display name, purpose, usage notes for AI assistants, storage quota, auto-delete window, document-extraction mode, and per-space **media-analysis** levels — grouped into **Identity**, **Purpose**, **Limits**, **Document extraction**, and **Media analysis** cards. The Media analysis card lets you override, per space, how **images**, **audio**, **video**, and **text** are analysed on upload (each defaulting to **Inherit instance default**). As with extraction, each picker only offers the levels **the instance ceiling allows** (set per class under **Settings → Media Processing**) — a space can never analyse more than the instance permits, so higher levels are hidden and a note names the ceiling. When a storage quota, auto-delete window, or extraction override is left blank, the field's own placeholder (**Unlimited** / **No expiry**) or the **Use instance default** / **Inherit** option shows what the default will be.

- **Delete records after (days)** — an optional space-wide expiry, **on the Danger tab** rather than here: it deletes data, so it sits with the other destructive settings. It is **one window per kind of record** — entities, memories, edges, chrono, files — because a space rarely holds one kind of thing. Leave a field blank or `0` to keep that kind forever. Deletion propagates over sync, so an expired record won't come back from a connected peer.

  It is the **least** specific of three tiers — most specific first, a single record's own TTL (set by the API on the write), then that record *type's* window on the **Schema** tab, then this space-wide number. A type with its own window ignores this one.
- **Extraction mode** — how thoroughly documents (PDF / DOCX / EPUB) uploaded to *this* space are read. Leave it on **Instance default** to follow the instance-wide setting (**Settings → Media Processing**), or choose one for this space: **Off**, **OCR** (fastest, text + layout), **VLM** (transcribe pages with a vision model, always falling back to OCR), **Repair** (adds a pass that reconciles the transcription against the OCR text), or **Auto** (as much as the instance can do). Useful when one space holds scanned archives that need the heavier path while the rest of the instance stays light. The dropdown only offers the modes **the instance ceiling allows** (set under **Settings → Media Processing**) — a space can never extract more than the instance permits, so higher modes are hidden with a note naming the ceiling.

  The instance setting is a **ceiling, not a default**: a space can ask for less than the instance allows, never more. If the instance is on **OCR**, a space set to **Repair** runs OCR — it keeps its choice and returns to it if the ceiling is raised again. Raising the instance level lifts only spaces on **Auto**.

  **Off means documents are stored but never read.** No text is extracted, so nothing inside them can be found by search — those uploads are marked *skipped* rather than sitting in the processing queue. This override is local to your instance — it is never synced to connected peers.

**Schema tab:** Define what data this space accepts. A **Schema validation** bar at the very top holds the space-wide **Validation mode** and **Strict linkage** controls — these govern *every* type in the space, not the collection you happen to be viewing. Below it, the entity / edge / memory / chrono collections each list their types on the left; click one to edit its rules in a stable panel on the right (you don't lose your place editing a type or property, and several property editors can be open at once).

- **Validation mode** — `off` means anything goes; `warn` lets writes through but flags violations; `strict` blocks invalid writes entirely.
  > **Editing is checked too, as of 2.2.** Previously only *creating* a record was validated; an edit
  > could save a value the same space would have rejected on create. Now the record **as it will be** —
  > yours plus the existing fields — is checked before it saves.
  >
  > **`strict` refuses what your edit breaks, not what was already broken.** A record can be invalid before
  > you touch it — written before you tightened the schema, imported, or synced from another brain. That is
  > reported, not refused: the problem is already saved, so blocking your edit would not fix it, it would
  > only stop you maintaining the record. Until 3.1 it did block, which meant tightening a schema quietly
  > froze every record that no longer fitted.
  >
  > The message still says which is which — *"the change violates…"* versus *"this record was already
  > non-compliant before your change…"* — so you are not sent looking at the wrong field. Validation is of
  > the result, so fixing the named field in any later save repairs the record.
- **Strict linkage** — when on, references between items must be valid IDs and deletion of referenced items is blocked.
- **Type schemas** — define per-type rules under each knowledge type (entity, memory, edge, chrono). For each named type you can set:
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

The toolbar at the top of the tab has **four** whole-space actions, and this guide listed three. **Export JSON** / **Import JSON** download or load the entire space's type schemas as one file. **Import library** pulls type definitions in from the instance's Schema Library — the reverse of the button beside it, and the one that was missing here. **Export to library** copies the *whole* space schema into the Schema Library in one step — one reusable entry per type, grouped under a name you choose (defaulting to the space's), so you can later apply the whole set to another space. Types already linked to the library (`From Lib`) are skipped. Save any pending edits first — it exports the last saved version.

**Duplicates tab:** The fourth tab, and the one this guide has never mentioned. It decides what this
space does when the background scanner finds two records that look like the same thing.

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

**Danger tab:** Set the space-wide retention window, rebuild search indexes, rename the space ID, wipe all data, or delete the space entirely.

**Retention** is the space-wide default: **Delete records after (days)**, as **five fields** — Entities, Memories, Edges, Chrono, Files — each applying to records of that kind with no TTL of their own and no window on their type. Five, not one, because a `tickets` space keeps ticket entities for a year and their status-change chrono entries for a month; **Files** gets its own because uploads share this setting and have no type for the Schema tab to reach.

A space that set a single number before this split keeps working exactly as it did: it shows on all five fields, which is what it always meant.

> **These numbers are yours alone, and a peer's are not.** In a space that syncs, every instance applies **its own** windows to every record it holds — including records that arrived from somebody else. An instance keeping tickets for a year does not start deleting them after a week because the peer it syncs with keeps them for a week. The expiry is worked out here, from the fields above, and is recomputed on this instance whenever the record is next written.
>
> **Before 4.0 that was true of records pushed to you and not of records you pulled**, so an instance doing the pulling could inherit the sender's expiry and delete data early — with nothing logged, and nothing to tell it apart from your own policy working. Nothing is restored by upgrading: what a peer's window already deleted is gone, and a stamp that came from a peer is replaced by your own the next time that record is written.

Below the fields, any type that *does* have its own window is listed read-only — that list is where you see what actually overrides these numbers, and it is edited on the type, in the **Schema** tab.

**Rebuild search indexes** is the repair for *search returns nothing and nothing says why* — a space whose vector indexes are missing or were destroyed (restoring a backup used to do this). It re-creates them from your existing content; search stays empty until it finishes, and nothing is deleted. Reindexing is not a substitute: it re-embeds content against the current model and cannot recreate a missing index. Requires an admin token (and TOTP when MFA is on). The same rebuild is also available per space directly from the **vector-index table** under Settings → Media Processing → Tools — the one place the drift (recorded *ready* vs. a database with no index) is actually visible — behind the same confirmation.

> **Optional indexes do not count towards those states.** The face gallery is built when face recognition is enabled and is not part of what search needs, so a space with every search index in place reads as *Ready* even when the gallery is absent. Before 3.2.0 it did count, and the result was that turning face recognition on without giving it a model — no external model configured, no model files placed — made every space report *Missing* here, *Failed* on its own Indexing panel, and the whole Tools tab *down*, permanently, on an instance whose search was working. A red state that is always red is one you learn to stop reading. A missing gallery is still reported; it just no longer reports it as the space failing.

The other three are guarded: because renaming changes the space ID (which breaks existing token and MCP references to it), **Rename** — like Wipe and Delete — now asks you to type the current space ID to confirm.

Each space row carries only a gear/configure (⚙) button — there is no pencil icon. Rebuilding indexes, renaming, wiping, and deleting all live inside the space's settings panel, on the **Danger** tab.

### Renaming a space

Open the space's settings panel and go to the **Danger** tab to rename its ID. All data, files, token scopes, and network sync mappings are updated automatically.

### Deleting a space

In the space's settings panel, open the **Danger** tab and click **Delete space**. You will be asked to type the space ID to confirm.

### Wiping a space

In the **Danger** tab, click **Wipe all data**. A confirmation dialog shows how many items are in each collection and asks you to type the space ID before you proceed. The space itself (its settings, label, schema) is kept — only the data inside it is removed.

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

> **The two instance-level checkboxes were documented on no page at all, and they are the widest thing
> this dialog can grant.** **Instance administrator** and **May create new spaces** are not rungs on a
> space: the dialog says so itself — *"these apply to the whole instance. A space-restricted administrator
> cannot grant them."* An operator ticking one from a paragraph that described three fields had no way to
> know what they were reading.

The matrix is the whole permission model. Earlier versions also offered a spaces checkbox list and a
three-way Read-only / Standard / Admin choice; those described the same access in an older vocabulary, and
the server refuses a request that uses both at once. The matrix says everything they said and things they
could not — such as **admin on Files in one space and nothing anywhere else**.

The tokens list shows each token's scope at any time. The **Permission** column draws a small **bar chart**,
one bar per rights area, each bar's height being the highest rung that area reaches, with a red line marking
the floor that applies to every space. So a glance separates a token that is admin everywhere from one that
is admin on Files in a single space — which a single colour could not.

> This described a **pill colour-coded by privilege** — *"admin is red, standard is green, read-only is
> yellow"* — and there is no such pill. Those three colour labels exist in the translation file and are
> referenced by nothing; the bar chart replaced them when the matrix did, because a token with four areas
> and a per-space override has no single privilege to colour. An operator told to scan for red pills was
> looking for something that had not been there for a release.

This dialog has no "Library Access" toggle. Library Access tokens (for sharing your schema library with other instances) are created separately, from the **Schema Library** page's own **Create token** dialog — see [Schema Library](03-files-and-schemas.md#schema-library).

**Editing a token.** Each row has **two** pencils, and they do different things. The one beside the label
renames in place and saves on its own. The one in the **Permission** column opens the rights editor. So a
rename and a scope change are two edits, not one — this paragraph said they were saved together in a single
request, which is the opposite of what it warns about. The secret is untouched by either; use **Rotate** for
that.

#### The four areas

Every space row has one cell per area, and they are not interchangeable — `write` on Files and `write` on
Knowledge are different permissions:

| Area | What it covers |
|---|---|
| **Knowledge** | Memories, entities, relationships and timeline entries — the records the space is made of, and searching them |
| **Files** | Documents stored in the space: reading them, writing them, and the folder structure they live in |
| **Schema** | The shape the space expects its records to take — which types exist and which properties they carry |
| **Data quality** | Finding and resolving duplicates, contradictions and gaps, and the review decisions that follow |

> **This page named three of them and never mentioned Data quality**, while a paragraph further down told
> you to *"set all four cells"*. So the instruction counted an area the guide had not introduced, and an
> operator granting rights had no idea what the fourth column governed.

#### Hover a rung to see what it grants

Each of the four segments in a cell carries a tooltip, and it leads with what that level actually allows —
*"Your agent can add, edit and delete single records"* — in the same words as the column header's `?`. The
description differs per column, because `write` on Files and `write` on Knowledge are not the same permission.
What clicking will do follows after it, including the fact that clicking the level you are already on steps
down one.

#### Administering one space, without administering the instance

**A token with all four areas at `admin` for one space is that space's administrator.** There is no separate
checkbox for it, and there deliberately is not: the four rungs already say it, and a second setting could
disagree with them. But it *is* a real, named thing, and until now nothing on this page told you so — which
is why it was asked for twice by an operator who already had it and could not tell.

What it means in practice: that token can manage **that space's own tokens** — list, mint and edit them — and
**that space's own settings**, schema and index rebuilds. Nothing wider.

**What it cannot do, which is the part worth trusting:** it is never instance-wide. It cannot grant
**instance admin** or **create spaces**, it cannot set the all-spaces floor, and it cannot see or edit tokens
that reach any space it does not administer — those tokens do not appear in its list at all. So handing
somebody administration of one space does not quietly hand them a way to widen it.

**To check whether a token has it:** set all four cells in that space's row to admin, or read the row — four
admins is the state. An agent can ask `help` and its space list marks the spaces the calling token
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
> name an area the server no longer knows, or leave one of the four out, the editor could open it and never
> save it — the server refused the very shape it had handed over. Startup now normalizes such a matrix and
> writes it down: an unknown area is dropped, a missing one comes back at **none**, and every rung the server
> can still read is kept exactly as it was. The repair only ever narrows, so re-check the token's matrix after
> upgrading if you see one change; it never restores access from the pre-3.0 `admin` / `read-only` / spaces
> fields.

#### Setting all four areas to admin makes a space administrator

**There is a `Space admin` column for this, at the right-hand end of the matrix.** Press **A** on a space's row
and all four of its areas go to admin in one action; press **–** and they all clear. The column also shows the
state: a row already at admin on all four areas reads as **A** whether you set it that way or reached it through
**All spaces**.

It is a shortcut and a read-out, not a fifth kind of right. Anything other than all-or-nothing is still said with
the four area cells, and the column simply reflects them — which is why it has two positions and not four. Before
3.2.0 the column did not exist, so the commonest grant meant setting four cells and hoping none was missed.

Give a token **admin** on all four areas of one space and it becomes that space's administrator. It can then do
two things it could not before:

- **Manage that space's tokens** — create them, edit their rights, rotate and revoke them. It only ever sees
  and edits tokens whose own reach sits inside the spaces it administers.
    Rotating and revoking are bounded the same way, and refuse with a message naming which spaces put the
    token out of reach.
- **Change that space's settings** — its name, its schema and types, and a re-index of its own search
  indexes.

**Since 4.4 almost none of that needs all four areas.** Each setting answers to its own area — media levels
to `Files`, duplicate rules to `Data quality`, the record lifetime and embedding switch to `Knowledge` admin,
types to `Schema`. A space administrator holds all of them, so nothing they could do is gone; a token needing
only one can now be given only that one. A save touching something the token may not change is refused
WHOLE, naming each field, so nothing is half-applied.

All four areas, deliberately. Admin on **Files** alone would be enough to mint tokens if any single area
counted, which is a bigger grant than the cell appears to make.

**Administering one space grants nothing in another.** The check is against the space being edited, so an
administrator of *Research* who opens *Finance* is refused exactly as before.

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

**Why it is worth a line.** A grid of four areas looks complete, and nothing used to say that three
space-scoped actions sat outside all four. If you were checking whether a token can rename a space, no cell in
the matrix answered and none said it would not.

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

## Multi-factor authentication (MFA)

MFA adds a one-time code requirement for admin actions (creating tokens, managing spaces). Normal data operations are not affected. There is no separate "MFA" page — the MFA panel lives inside **Settings → Preferences**, under the **Security** heading (the language switcher sits above it).

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

> **There is no schedule field in this dialog.** This step said to set one here *"(cron expression)"*,
> and the cron box is on the network card afterwards — see [Sync schedule](#sync-schedule) below, which
> describes it correctly. The voting deadline, which IS in the dialog, was not mentioned at all.

### Inviting another brain

1. Expand the network card and click **Generate invite**.
2. Click **Copy invite** — one long line starting `ythril1_`, with nothing to trim or unwrap.
3. Send it to the other admin **the way you would send a password**. Anyone holding that line can complete
   the join, and it looks like gibberish, which is exactly why people assume posting it in a group channel
   is safe. It is encoded, not encrypted. It expires after 1 hour and works only once. (An instance that has
   not been upgraded still produces the older JSON blob, which keeps working.)

**Both ends are recorded in the audit log.** Generating an invite appears as `network.invite.generate`, and the moment the other brain actually becomes a member — or is held for a join vote — appears as `network.member.join`. Until 2026-08-28 neither did: the whole invite path was exempt from auditing as "peer-facing", which was true about who calls it and beside the point about what it changes.

### Joining a network

1. Click **Join Network**.
2. Paste the invite code — the line starting `ythril1_`. (An older brain may have sent you the earlier JSON
   form; paste that instead and it works the same.)
3. Enter your brain's publicly reachable URL (e.g. `https://brain.example.com`).
4. If any space IDs overlap with existing local spaces, a dialog lets you choose to merge into the existing space or map the remote space to a new local ID.
5. Click **Join network**.

### Sync schedule

Enter a cron expression on the network card (e.g. `*/5 * * * *` for every 5 minutes). Click **Sync now** to trigger an immediate sync without waiting. Leave the field empty for manual-sync only — that is a real setting, not an omission.

**A value the scheduler cannot run is refused, and the message tells you what to send instead.** It used to be accepted: the field saved, the card looked right, and the network never synced again — the only sign was a line in the server log. If you have been using one of the old short forms (`every 5m`, `*/2 hours`), the refusal names the cron expression it always meant, so the fix is a copy and paste. Anything already saved was converted on upgrade, so an existing network keeps its schedule.

One case is worth checking after upgrading: a short form outside cron's range, such as `every 90m`, never worked at all, so a network holding one has been syncing only when you pressed **Sync now**. Those are listed by name in the server log at startup, and are left as they are rather than rounded to something you did not choose.

### Sync history

Expand a network card and click **Sync History** to see a log of every sync cycle — timestamp, status, items pulled and pushed, and any errors.

Each member row in the expanded card also shows its **last successful sync** (or *Never synced*) and, when a peer's recent sync attempts have been failing, a red **Failing (N)** badge counting the consecutive failures since the last success — so you can spot a stuck peer without opening the full history.

**A *Version too old* badge is a different thing from *Failing (N)*, and telling them apart saves an
afternoon.** *Failing* means the peer was called and did not answer. *Version too old* means it was never
called: nothing was attempted, so there is no failure to count and no timestamp to show — which is also
what a brand-new member looks like. See *The version a peer has to be running* below.

### The version a peer has to be running

Every brain on a network has to be recent enough for the others to trust what it sends. From 4.0.0 each
one tells the others what version it runs, and a brain that is too old is not sent data and is not
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
the way it always has, as **Failing (N)**. This matters for real setups rather than being a technical
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

**Signed votes:** a network can set `requireSignedVotes` so every vote cast must carry a valid Ed25519 signature from the voting member (verified against its pinned signing key). Enable it once all members have published a signing key; if a member rotates its signing key, the new key is accepted with a rotation proof that references the previous one.

### Leaving a network

Click **Leave network** at the bottom of the network card. Your local data in the network's spaces is kept.

---

## Settings — Media Processing

**Settings → Media Processing** (admin only, MFA-protected) controls how Ythril turns image, audio, video, and document uploads into searchable content.

The page has **no heading of its own** — the left-hand navigation and the tab strip already tell you where you are, so there is nothing to look for at the top. This guide used to say the page was titled *Models & Media*, which was wrong twice over: there is no title, and the name it gave was not the one in the navigation.

By default, Ythril ships with a bundled vision service (Ollama running `moondream`) and a bundled speech-to-text service (faster-whisper-server). When you upload a picture, Ythril writes a short caption of what's in it; when you upload audio or video, it transcribes the words. The result is added to the same search index as your memories, so you can find an attachment by what's *inside* it, not just its filename.

### The three tabs, and where each control lives

The page is split into **Models**, **Pipelines** and **Tools**, and knowing which is which saves
hunting:

| Tab | What is on it |
|---|---|
| **Models** | Which model answers for vision and speech — provider, endpoint, model name, API key, and each slot's call budget |
| **Pipelines** | **The per-class ceilings.** How far Ythril may go with an image, audio, video or text file — the highest level any space is allowed to ask for |
| **Tools** | The vector-index table and the per-space index rebuild |

**The image ceiling has four settings, not two**, and only the third is worth explaining:

| Setting | What happens to an uploaded image |
|---|---|
| **Off** | Stored as-is; nothing is read out of it |
| **Caption** | A short description of what is in the picture, added to search |
| **Recognition** | Caption **plus face recognition** — this is the one that identifies people, so it is the rung to think about before raising |
| **Auto** | As much as the instance can do |

A space can never ask for more than the ceiling set here. Raise a space's own level under its Settings
tab and the picker simply does not offer anything above this line, with a note saying why.

### When to change this

- **Turn a class off.** There is no single on/off switch — each media class has its own **level**, and
  there are **four**: images, audio, video and **text**. Set a class to **Off** if you don't upload that
  kind of media or your machine is tight on memory; its provider card then reads **off** and new uploads
  of that class are stored as-is (existing files keep their captions). **All four have to be Off** to
  turn media embedding off entirely — this said three, so following it left Text running.
- **Use an external provider.** Switch the **Provider** on the **Vision** or **Speech** card to *External* if you'd rather call OpenAI, Azure, or any other OpenAI-compatible service. Fill in the **Endpoint**, **Model**, and **API key (external only)** for that provider. API keys are stored in the encrypted secrets file, never alongside the rest of the configuration.
- **Use a different local model.** Keep the provider on *Local* but change the **Model** field — for example, switch the vision model from `moondream` to `llava` if you've pulled it into Ollama.

### How long a model may take

Each model slot has its own call budget — how long **one** request to that model may run before Ythril gives up on it. The defaults suit the bundled models: 2 minutes for image captioning, 5 minutes for transcription, 20–30 seconds for the smaller text models, 1 minute for the document models.

Raise one when a model is slower than the default allows — a large vision model on a busy GPU, or a host that loads a model from disk before it can answer the first request. The symptom is a job that reports a timeout while the model itself was working fine.

Two things happen automatically when you raise a budget, and both matter:

- **The stall detector follows it.** Ythril re-queues a job that has reported no progress for a while, and a single long call reports nothing while it runs. So the stall timeout is raised above the longest budget you set — otherwise a job would be re-queued in the middle of a call it was allowed to make, throw the work away, and reach the same call again. You do not have to adjust it yourself.
- **Nothing else changes.** The budget bounds one call. It is not a retry count, not a queue setting, and it does not affect how many jobs run at once.

**The three document cards — Document VLM, Document repair and Document verify — show a budget too, and it is the one setting on those cards that is yours.** Their model and endpoint really are fixed by your infrastructure administrator; the budget and the reasoning effort are not, and there is no environment variable for them at all, so this screen is the only place they can be set.

**How the document page budget and a document slot budget fit together.** The DOCUMENTS pipeline has a **per-page time limit** that applies to every model call made while reading a page. A budget you set on one of the three document cards **replaces it for that model** — leave the card blank and the page limit is what that model gets. So the page limit is still the one number to change when the whole document path is too slow, and a card budget is for the one model that needs longer than the rest.

Your infrastructure administrator can fix a slot's budget so it cannot be changed here — it will show the **env** badge described below.

### Asking a model to think less

Some models reason before they answer, and reason at length: a 27-billion-parameter model measured on a
partner platform takes **3 minutes 32 seconds** at its own default. Nothing is wrong when that happens — it is
thinking — but if your call budget is three minutes, every one of those calls fails and the log says timeout.

Raising the budget is one answer; asking for less thinking is usually the better one. Each slot has a
**Reasoning effort** setting for it: leave it blank and nothing is sent, which is what every installation did
before this existed. `none` turns thinking off outright and works on any model; `low`, `medium`, `high`,
`xhigh`, `minimal` and `max` are passed to the model itself.

**Check which values YOUR model accepts, because a wrong one fails every call** — the server starts normally
and then rejects each request. Qwen3.8, for example, takes `low`, `medium` and `xhigh` and errors on the other
three; on it, `medium` cuts the wait by about a third.

If you have a second model, pointing the slot at one that does not think is better still. This setting is for
when you have one model and need it to answer faster.

### Locked fields

Fields shown with an **env** badge cannot be changed from the UI — they are pinned by an environment variable set by your infrastructure administrator. This is normal in managed deployments where credentials are injected by Kubernetes secrets or similar.

### When a provider won't connect

*New in 2.1.*

**Test connection** reports what the server actually gets back, and the failure text names the reason
rather than just saying it failed. Two cases account for almost all of them:

- **"Blocked SSRF target … resolves to blocked address 10.x / 192.168.x / 172.16-31.x"** — the endpoint
  is on a private network address. Ythril refuses those by default, because an admin-settable URL that
  the server will call is the classic way to make a server fetch things it should not. If the endpoint is
  a model server you run yourself, that refusal is wrong for your case and an administrator can permit it
  — for that one endpoint alone, or instance-wide — see
  [Diagnosing a Misconfiguration](../integration-guide/02-hosting.md#diagnosing-a-misconfiguration). The message names
  the exact setting for the endpoint you were testing. It cannot be enabled from this page, on purpose.
- **"Blocked SSRF target … 169.254.x" or a loopback address** — these stay blocked whatever the setting.
  Point the endpoint at a real service address.

And one result that looks like a problem and is not:

- **"Reachable · no model list"** — the endpoint answered, and it has no page listing its models. That is
  the normal shape of a single-purpose inference server: a Whisper service serves only its transcription
  route, so asking it for a model list can only ever come back "not found". Test connection says what it
  found and leaves the card green, because a missing *list* is not a missing *service*. Use **Verify** to
  confirm the model itself answers — it sends a real request down the real path. If Verify fails too,
  hover the result: the detail names the exact URL that was tried, which is usually a base URL with a
  wrong path.

Every refusal is also written to the server log with the same detail, so an administrator can find it
without you having to reproduce the click.

### Verify — does the model actually answer?

*New in 2.2.*

**Test connection** asks "is something there". It cannot answer *does my model work* — an endpoint can be
reachable, list your model, and still fail on every real request. **Verify** sends one real request and
tells you what came back. There is a button on the **Vision**, **Speech-to-text**, **Embedding** and
**Assist** cards.

**It never sends your data.** The payload is always generated: a 1×1 transparent image, a few
milliseconds of synthesised silence, or the word `ping`. It goes through the same code path the worker
uses, so a transport problem shows up here instead of on someone's first upload.

Four outcomes:

| Result | Meaning |
|---|---|
| **OK** | The model answered. A short sample of what it returned is shown. |
| **Still loading** | It did not answer within 3 minutes. Not a failure — a backend that swaps models onto a shared GPU can legitimately take 30 seconds or more on the first call. Try again. |
| **Failed** | It answered, but wrongly — or the call errored. The detail names what happened. |
| **Not configured** | No model is set for that card. |

Silence transcribing to no text is a **pass** for speech-to-text: the payload is silent, so reaching a
proper response *is* the result.

Verify costs a real request, so on a metered endpoint it costs money. It is recorded in the audit log for
that reason; Test connection, which only lists models, is not.

### Privacy note

When both providers are set to *Local*, no file content ever leaves your instance. Switching to *External* sends image frames or audio segments to the configured endpoint — review your data residency policy before doing so.

### External assist model (documents)

The **External assist model** card lets you point a bigger, hosted model at the **document repair pass** — the one used by the `repair` extraction level (and by `auto` when a repair model is configured). There is no separate "used for" tick: repair is the only thing it does, so the **extraction level is the switch**. Fill in an **Endpoint** + **Model**, then raise **Document extraction** to **Repair** (or **Auto**) to route repairs through it. At that point you are asked to **acknowledge the egress** — document content (OCR text, and page images) is sent to that host. The acknowledgement is recorded against the host and re-checked at run time, so an endpoint you have not acknowledged is never contacted: repairs fall back to the local model instead.

This is the one document setting that sends content off your instance: the model receives OCR-extracted text and draft transcriptions (and, for future image tasks, rendered page images). Because of that, configuring a host pops an **acknowledgment dialog** naming exactly what data goes where — you must confirm before it is used, and Ythril records that consent against the host and re-checks it at run time, so content is never sent somewhere you did not acknowledge. Endpoints are checked to be public addresses, and the API key is stored in the encrypted secrets file. Leave it unconfigured — or keep **Document extraction** below **Repair** — to keep document processing fully local.

---

### Face Recognition

Face recognition lets Ythril automatically detect faces in uploaded images and link them to person entities in your space. Once you label a few photos, new uploads containing the same person are tagged automatically.

**This feature is opt-in and disabled by default.** It requires local model files to be placed on disk (not bundled). See the [integration guide](../integration-guide.md) for download links and setup.

#### How to use it

1. **Place the model files** — Download `blazeface-back.json`, `blazeface-back.bin`, `faceres.json`, and `faceres.bin` from `https://vladmandic.github.io/human/models/` and place them in the `human-models/` folder inside your data directory.
2. **Raise the Images pipeline to `recognition`** — face recognition has no switch of its own: it is the top rung of the **Images** pipeline. Set the instance ceiling under **Settings → Media Processing → Images** to **Caption + face recognition** (or `auto`), then, if you want it only in certain spaces, leave the others on **Caption**. Images deliberately default to **Caption** — face embeddings are biometric data, so an instance never acquires them just by being installed. `FACE_RECOGNITION_ENABLED=false` in the environment remains available as an infra-level hard-off that overrides every ladder.
3. **Upload images** — Any image that goes through the media pipeline is automatically processed. Faces are detected, embedded, and stored. If no gallery exists yet, faces are stored unlabeled.
4. **Label a face** — Open the file in the Files view and link it to a person entity (via the entity tag in the file metadata panel). The face embedding is immediately added to the gallery.
5. **Auto-labeling kicks in** — From this point on, new images containing that person's face are automatically linked to their entity, as long as the match score exceeds the confidence threshold.

#### Deleting a person

Deleting a person entity **removes their label from every face linked to it**, and stops those faces from auto-labeling anyone in future. This happens on every path a person can disappear by: deleting them from the Brain, wiping all entities in the space, or the entity expiring through its TTL.

The face records themselves are kept, with their label cleared. That is deliberate: the face belongs to the *photo*, which you did not delete — after removing the person, Ythril simply no longer claims to know whose face it is. If you want the face data itself gone, delete the image; that removes its face records along with every other derived artifact.

> Under `strictLinkage`, face labels do **not** block deleting a person. Other references (edges, memories, chrono entries) still do. Faces are written automatically by the recogniser rather than created by you, and they are cleared safely by the deletion itself — so blocking on them would only make the person impossible to remove.

#### Settings

These are set in `config.json` under `mediaEmbedding.faceRecognition`, or pinned by your infrastructure through the matching environment variable (`FACE_RECOGNITION_ENABLED`, `_CONFIDENCE_THRESHOLD`, `_MIN_FACE_SIZE_FRACTION`, `_MODEL_PATH`, `_PERSON_ENTITY_TYPES`, `_REPROCESS_SYNCED_IMAGES`). An environment value wins over `config.json`, so `FACE_RECOGNITION_ENABLED=false` guarantees no faces are processed on that instance — including after restoring a backup taken where it was on. Neither is editable from the UI:

>
> **If a save on Media Processing is refused, the page now tells you which field the API objected to.** The
> outcome of every save on that page — the refusal with its reason, or the confirmation that it was stored —
> appears below the tabs. It previously appeared nowhere, so a refused save looked exactly like a button that
> did nothing, and so did a successful one.
>
> **If Save on Models or Media Processing did nothing at all, that was a bug and it is fixed.** On 3.2.0 both pages sent one field the API had stopped accepting — the face-recognition master switch, which is now set only by your infrastructure — and because the whole request is checked at once, the API refused *everything* on the page rather than that one field. The symptom was a Save that appeared to work and changed nothing, on either page, whatever you had edited. Nothing was lost; nothing was ever written.
>
> **Any field your infrastructure pins is refused by the API too, not just greyed out in the interface** — and from 3.2.0 that holds for every pinnable field rather than only the face-recognition ones. Before then, a pinned model or key elsewhere in Media Processing could be saved without complaint: the value that actually ran was still the pinned one, but the save reported success and left the stored settings disagreeing with the running ones. If you saw a setting that would not stay changed, that was this.
>
> **And a field can now be fixed at NOTHING**, which was previously impossible. Setting a variable to empty does
> not pin it — your orchestrator cannot tell "the operator left this blank" from "the operator wants it blank",
> so treating an empty value as a lock would freeze every field on every deployment. Instead list the fields:
> `YTHRIL_PINNED_FIELDS=rerank.apiKey,nli.apiKey`. Each one becomes read-only here and is refused by the API, at
> whatever it currently resolves to. That is the answer for a key field pointing at an endpoint inside your
> cluster that needs no key: empty is the correct value, and now it can be the fixed one.
>
> **If you misspell a name, the page tells you.** A notice at the top of **Settings → Media Processing → Models**
> lists any entry that matched no field, because a pin you believe is in force and is not would be worse than no
> pin at all. Names have to be fields this page can save; anything the API never accepts is already fixed and
> needs no pin.

| Setting | Default | What it does |
|---|---|---|
| `enabled` | `false` | Master switch — must be set to `true` to activate the feature |
| `confidenceThreshold` | `0.6` | How similar a face must be to a gallery entry to be auto-labeled (0–1). Start conservative; increase as your gallery grows. |
| `minFaceSizeFraction` | `0.05` | Minimum face size (as a fraction of the image's shorter side). Smaller faces in crowd shots are ignored. |
| `personEntityTypes` | `["person"]` | Entity types considered as people. Only entities of these types can enter the face gallery. In the admin UI (**Settings → Media Processing → Face recognition**) these are **picked from your Schema Library's entity types**, shown as removable chips; any value already stored stays selectable even if it's no longer in the library. |
| `reprocessSyncedImages` | `true` | When true, images received from other instances via sync are queued for face recognition automatically. |

#### Configuring an external face service asks you to confirm it — once, at the right moment

Pointing Ythril at your own face-recognition service means face crops leave this machine, so it asks you to
confirm the exact destination before using it. Two moments raise that question, and they are the two moments
you are actually deciding:

- **Setting or changing the endpoint**, on **Settings → Media Processing → Models**.
- **Raising the image level to “Caption + face recognition”**, on **Settings → Media Processing** — because
  that is equally an act of switching faces on.

Until you confirm, the endpoint is **saved and not used**: faces are handled by the built-in model instead,
exactly as they would be if your service were unreachable. Nothing is lost and nothing leaves.

**What changed, in case you met the old behaviour.** An unconfirmed endpoint used to make the whole page
refuse to save — any setting, on either page, whether or not it had anything to do with faces. If you have
seen a Save fail with a message about acknowledging a host while you were editing something unrelated, that
was this.

#### If face recognition finds nobody, check the descriptor width first

**This is the one failure here that is silent and, until it is fixed, permanent.** A face gallery is built at
a fixed vector width, and a face measured at any other width is skipped — logged once per restart and never
again. So the symptom is not an error: it is photographs that plainly contain people being recorded as
containing none.

The default width is **128**, which is what the bundled recogniser produces. If you point Ythril at your own
recogniser — the `externalModel` setting above — and it is one of the 512-wide families (ArcFace, AdaFace,
FaceNet, EdgeFace, buffalo_l), the space needs to be told. **Nothing derives the width from the endpoint you
configure**, so an untold space stays at 128 and skips everything your model sends it.

There is no control for this on the Settings page; it is a per-space number set through the API
(`faceDescriptorDims`). What matters at this level is knowing to ask:

- **A space that has never held a face can be moved to a new width.** Ask whoever administers the instance
  to set it; the change is accepted.
- **A space that already holds faces cannot.** Its stored vectors were measured at the old width and nothing
  re-measures them, so re-declaring it would break every face already labelled rather than fix the new ones.
  Those photographs have to be re-processed in a space created at the right width.

The practical order, if you are bringing your own recogniser: get the width right **before** the first
photograph is uploaded. Everything after that is recoverable only by re-processing.

---

### Document Processing (OCR & Image Extraction)

When you upload a PDF, DOCX, or EPUB, Ythril converts it to text using the `unstructured-api` sidecar, which includes Tesseract OCR. The conversion strategy controls the trade-off between speed and quality.

These settings live in `config.json` under `mediaEmbedding.documentProcessing`:

| Setting | Default | What it does |
|---|---|---|
| `strategy` | `"hi_res"` | `"hi_res"`: full OCR + layout analysis — accurate on scanned documents, extracts embedded images and tables. `"auto"`: sidecar decides. `"fast"`: text layer only, no OCR, fastest. `"ocr_only"`: forces OCR even on born-digital PDFs. |
| `extractImages` | `true` | When using `hi_res`, images embedded in the document are extracted, saved, and queued for the media pipeline (captioning + face recognition). |

**Default behaviour (no configuration needed):** every uploaded PDF is OCR'd with full layout detection, embedded images are extracted and independently captioned, and tables are converted to structured HTML. For text-heavy documents without scanned content or images, `"fast"` is significantly quicker.

---

## Settings — Embedding

**Who may show Ythril inside their own page.** By default, nobody: Ythril can only be framed by itself, and a
portal that tries gets nothing. Adding an origin here is how you say yes.

The case this is for: somebody runs a portal and wants your brain to appear inside it as a panel rather than
opening in a new browser tab. They cannot grant that themselves — only the brain's operator can, and until 3.2.0
that meant editing `config.json` on the server.

### Adding an origin

Enter one exact origin per row — scheme, host and port, nothing else:

```text
https://portal.example.com
https://intranet.example.com:8443
```

Then **Save**. The change is active on the next request; nothing needs restarting.

What is refused, and why the form tells you rather than tidying up:

| Entry | Result |
|---|---|
| `https://portal.example.com` | accepted |
| `https://portal.example.com/app` | refused — an origin has no path |
| `http://portal.example.com` | refused — `https` is required (except on `localhost`) |
| `*` or `https://*.example.com` | refused — there is no "allow everything" mode, by design |

A refused row is marked and named back to you. An entry that was silently dropped would look like a save that
worked, and you would go looking at the portal for a fault that was here.

If the list looks right and a portal still opens in a tab, the row to check is any one marked red on load: an
invalid entry written directly into `config.json` is skipped by the server and shown as refused here.

### What you are agreeing to

**A listed origin gets two permissions together, and they cannot be separated:**

1. it may display Ythril inside a frame on its own page; and
2. it may restyle Ythril at runtime — colours, surfaces, the whole palette.

They share one list deliberately: an origin you trust to render Ythril inside its own chrome is exactly the origin
you trust to change how it looks. Both are also ways to impersonate this interface — a frame can be positioned
under something else, and a restyle can make a real page look like a different one. So the practical rule is the
same as for any credential: list only origins you operate, or trust to the degree you would trust yourself.

Removing an origin takes effect immediately too. There is no per-user version of this list and no API that lets a
non-admin token extend it; changing it requires an instance admin and a second factor.
