# Files, Conflicts and the Schema Library

> Part of the [Ythril User Guide](../userguide.md).

## Files, Conflicts and the Schema Library

## Files

> Files is a **tab inside Brain**, not a separate page. Open Brain and click the **Files** tab.

The file manager lets you upload, download, organise, and preview files within each space.

**Uploading:** Click **↑ Upload** in the toolbar, or drag and drop files directly onto the file list. Large files are uploaded in chunks automatically.

**Stored encrypted when the server has a master secret.** Nothing about uploading or downloading changes; a file
that cannot be decrypted fails its download with a message naming it instead of opening as garbage. See
[Uploaded files are encrypted at rest](05-storage-data-and-audit.md#uploaded-files-are-encrypted-at-rest).

**Uploading over a file that already exists asks first.** *New in 2.2.* A file with the same name in the
same folder is **replaced**, and everything derived from the old one is removed and rebuilt: conversion
chunks, extracted images, and any description generated from them. The dialog names all of that, because
what you need to weigh is that the derived records disappear — not that some bytes change.

You are asked **once for a whole batch**, not once per file: a drop of twenty files where three collide is
one question. **Cancel is the default**, and Replace is styled as destructive. There is no undo.

**Uploading the very same image, audio or video again is free.** If the file you upload is byte-for-byte the
one already there and Ythril finished analysing it, the analysis is kept instead of being redone. Looking at a
picture or transcribing a recording is the slowest, most power-hungry thing the server does, and repeating it on
unchanged content could only produce the same description it already has.

Anything less than certain is analysed again, so nothing gets skipped by accident: a file whose contents changed
at all, one whose analysis failed, was still running, or was never done, and every file uploaded before this
release. **Re-uploading is still how you retry a failed analysis.** To have a file looked at again after it
succeeded, delete it and upload it again.

**Actions per row:**

| Action | How |
|--------|-----|
| Preview | Click the file name or the 👁 icon |
| Download | Click the ↓ icon |
| Rename | Click **Rename** |
| Delete | Click ✕ and confirm |

**A file has one name, however it was spelled.** An accented name typed or sent in its decomposed form (as some
macOS apps do), a doubled slash (`docs//a.txt`) or a `./` is stored, listed and synced under one canonical name, so
two spellings never become two files. A name in any script — `日本.txt`, an emoji — downloads and previews under its
real name. Moving or renaming a document carries everything made from it, including work still queued for it.

**A delete or a rename that fails on a database outage says so — it never reports success.** When the failure
comes before the file is touched, nothing changed: the file is still there under its old name, and trying again
is safe. When it comes after the file itself was removed or moved, the list already shows that (the row is gone,
or is under its new name without its status and tags) while the file's metadata is not finished; repeat the same
delete or rename through the API (`DELETE` or `PATCH /api/files/:spaceId?path=…`) or the MCP `delete_file` /
`move_file` tool once the database is back, and it completes. This page cannot repeat it for you, because it no
longer has a row for the old path.

**A file whose bytes were removed outside Ythril while its metadata stayed has no row here** — the list is read
from disk — although the **Files** count still includes it. Delete it through the API
(`DELETE /api/files/:spaceId?path=…`) or the MCP `delete_file` tool: the delete is completed, and synced peers are
told to remove their copy too (which ones apply it is explained next).

**Deleting a file twice is not a second success.** Where the instance keeps a deleted file's record for audit
([Keeping a record of deleted files](04-settings.md#keeping-a-record-of-deleted-files)), that
record stays, flagged as deleted: it is this instance's own, so it is not listed, is never sent to peers, and
is not counted when instances compare their data. A second delete of the same path, or a delete naming one of a file's pieces (a
chunk of a document or a face found in a picture) rather than the file, answers **404 not found** on the API and as
an error from the MCP `delete_file` tool: nothing is deleted again, no second removal notice goes to synced peers
and no second `file.deleted` webhook fires. So after a delete that timed out, a **404** on the retry can mean the
first one did complete; check the file list before deleting again.

**Which peers delete their copy when you delete a file.** Deleting a file, or moving it, tells synced peers, and a peer applies the notice only where the rule allows it: every peer that holds **a copy your instance wrote** deletes it, and on a **pub/sub network or a tree** everything *below* you does as well, including a file you only relayed from above. A file **another instance wrote**, deleted here on a club, closed or democratic network, is removed on your instance alone: the other peers keep it, and it stays gone here until the instance that wrote it changes the file again. A peer applies the notice to the version you deleted, so a file someone uploaded again to that path since is kept, and it removes the file's text, thumbnails and search entries with it. A peer that has no one below it applies the deletion and does not keep the file's name afterwards.

**What a file's derived data does when the file is deleted.** Everything Ythril made from a file goes with it: the text it extracted, the images it pulled out of a document, and the captions, faces and search entries of those images — however many steps removed from the file they are. Each instance makes its own text and images from a file, by its own settings, and they never travel to a peer (see below), so a peer removes its own pieces when it applies the deletion; pieces an older peer delivered before this release are retired by the next retention pass. So no peer restores a deleted file or anything made from it. A file written again at the same path is a new file: it is converted afresh and its pieces are kept.

**A file a peer delivers is processed by your own settings, and the pieces are yours.** When a synced peer sends you a file — pushed to you, or fetched by your own sync — Ythril converts, chunks and analyses it the way it would an upload to this instance: the document mode, the models and, where you have confirmed an external one, the external assist model are your own, and a new version of the file replaces the passages of the old one. The converted text and extracted images are **not** sent to or from peers: a space with document conversion switched off holds no converted text of a file it was given, however the sender's instance is set up. After an upgrade, files a peer delivered earlier and your instance never converted are picked up by later sync cycles, a few at a time, so expect some conversion work (and external-model use, if you have confirmed one) for a while. A file that arrives from a peer is listed after the page is refreshed; the Files page does not move on its own for a change you did not make here.

**New folder:** Click **New folder** in the toolbar.

**Navigation:** A breadcrumb bar (`root / docs / guides`) at the top lets you jump to any parent directory. The **tree sidebar** (toggle with **Show tree** / **Hide tree**) provides a full directory view.

**Folder sizes:** the Size column shows a folder's **total content size** — the sum of every file inside it (recursively), not just files. An empty folder shows `0 B`.

**Status & tags:** each file row also shows its **embedding status** (a pill: *Embedded*, *Embedding*, *Partial*, *Failed*, *Skipped*…) and its **tags**, pulled from the file's metadata — so a space's file-processing state is visible right in the list. (This is the file manager and the *File Meta* tab coming together into one view.)

**What the pills mean, and the two that are easy to misread:**

| pill | what happened |
|---|---|
| *Embedded* | fully indexed; the file is findable by meaning |
| *Embedding* | work in progress — a stage bar replaces the pill while it runs (below) |
| *Partial* | **some of it is findable and some is not.** A long recording whose transcription failed for a few of its pieces, or a document where some pages did not convert. The file stays retry-eligible, so **Retry** is worth pressing |
| *Failed* | nothing was indexed and the reason was not a refusal — most often a file whose stored bytes could not be read. Retrying reads the same bytes, so a *Failed* file usually needs the cause fixed first |
| *Skipped* | **nothing was indexed because Ythril declined, not because anything broke.** Either the file is larger than the instance's size limit, or this kind of media is switched **Off** for the space (Settings → Media Processing). The file itself is stored and downloadable either way — only the indexing was skipped |

**While a file is being processed**, the Status column shows a **stage bar** instead of the pill: a segment
per stage of *that file's own route* — a PDF might run render → VLM → repair, an audio file transcribe →
embed, a video transcribe → caption → embed — with
the current stage filling as its pages land and a `12 / 40` count where the work is countable. It replaces a
generic "Embedding" that looked the same for every file and every stage. If the worker stops reporting for
longer than the stall timeout the bar turns amber and says **stalled**, so a wedged job no longer looks like
a working one. The moment the file finishes, the row goes back to its status pill.

If **nothing** will run, it says so and why: the file's type is switched off for this space, or the file is
larger than the processing size limit. If a stage isn't available (for example a vision level with no page
renderer configured), it says that it falls back to plain text extraction. That is the answer to *"why did
nothing happen to my scan?"* — previously only findable by cross-checking Settings → Media Processing
against the space's own overrides.

**Sorting:** click the **Name**, **Status**, **Size** or **Modified** header to sort the current folder. Clicking cycles ascending → descending → back to the folder's own order. **Folders always stay at the top** — a file explorer where directories interleave with files by size or date is hard to navigate. Sorting applies to the folder you are looking at, which is the whole set the view holds.

> **Editing a file's custom properties got safer in 3.1.** Saving used to replace the whole set, so an API
> caller that changed one property silently lost the others — the four Brain record types had been fixed
> years earlier and files had been missed. Properties are now **merged**: the ones you do not touch are kept.
> Removing one still removes it. Tags and the entity / fact / chrono links are unchanged — those are
> replaced by whatever you save, so save the full list you want.

### Detail pane (preview + description ⇄ file meta)

Clicking a file opens a **docked detail pane** to the right of the list (the list runs full width until then, and reclaims it when you close the pane). The pane has two faces, switched with the segmented toggle in its header:

- **Preview & description** — the file preview, with the file's metadata **description** shown beneath it:

  | Type | How it renders |
  |------|---------------|
  | Markdown (.md, .markdown) | **Formatted** — headings, lists, links, code blocks, tables, and `mermaid` diagrams |
  | Text, code, JSON, YAML… | Syntax-highlighted source |
  | Images (.png, .jpg, .gif, .webp, .svg…) | Inline image |
  | PDF | Embedded viewer |
  | Spreadsheets (.xlsx, .xlsm) | First sheet as a table (capped at 200 rows × 40 columns, with a note when truncated) |
  | Everything else | File info + download button |

  A **full-screen** button (top-right of the preview) expands the preview to fill the window; **Escape** or its close button collapses it back to the docked pane.

  **Where the description came from.** For an uploaded document Ythril writes one itself, and labels it so
  you know whose words you are reading:

  - **generated** — the model configured for documents answered *what is this file?* from the file's own
    text. Nobody has checked it, which is what the label is for.
  - **from the document** — the opening of the document's own text, taken verbatim. This is what an
    instance with no document model configured produces.
  - **no label** — a person wrote it. Editing the description on the **File meta** side removes any label,
    because the words become yours.

  The document's own opening text is kept either way and is searchable, so a phrase you remember from
  inside a file still finds it — even when the description is a generated summary that does not contain
  that phrase.

- **File meta** *(in the Brain)* — the editable metadata record: **description**, **tags**, and links to **entities**, **facts** and **chrono** entries, plus a **Retry** action to re-queue embedding for a failed or partial file. This is where the former *File Meta* tab's editing now lives. (On the standalone Files page, outside the Brain, the pane shows preview + description only.)

- **Extract** *(in the Brain, and only for files that have been processed)* — **what retrieval actually
  sees.** This is the tab to open when a document is in the system and still answers questions badly:

  | Section | What it tells you |
  |---|---|
  | **Chunks** | The pieces search actually matches on, in order. Each shows where it came from — the **heading** it opened for a document, or its **position in the recording** (`1:05-1:35`) for audio and video. If a chunk is missing text you expected, the conversion is where to look, not the search. |
  | **Extracted images** | The images pulled out of the document, each with its caption and whether that caption was **generated** or written by a person. |
  | **Converted markdown** | Exactly what the converter produced from the file — the input everything else is derived from. Long documents are shown up to 256 KB. |

  Nothing here is new: these are the records the pipeline already wrote. They were only visible before by
  browsing the internal `_converted/` and `_extracted/` folders, which are now hidden — hidden from
  browsing, not from inspection.

  A file with no chunks is worth noticing on its own: it means **nothing from that file is searchable yet**.

Press **Escape** or the close button to dismiss the pane. Use arrow keys to move to the previous or next file in the directory.

---

**When a folder in the tree will not open, the tree says so.** Clicking a folder in the sidebar can fail —
the store is briefly unreachable, or the folder was removed by somebody else — and until 3.7 the only sign was
the little arrow springing back: no message, anywhere. Now the reason appears in red under the folder that
refused, and clicking it again retries. If the whole tree cannot load, the message sits at the top of the
sidebar instead, so a space whose folders could not be fetched no longer looks like a space with no folders.

**And the file list beside it is emptied rather than left behind.** Opening a folder whose listing fails used
to leave the previous folder's files on screen under the new folder's name, with nothing to say the listing
had failed — you were reading one directory's contents labelled as another's. The list now shows the failure
and a **Retry**, which loads the folder named in the path above it.

This is only true of OPENING a folder. A background refresh that fails keeps the files it is already showing
and marks them as not current, because a momentary hiccup while a file is being processed must not blank a
list that is perfectly good.

## Conflict resolution

When two connected brains **both** modify the same file before syncing, a conflict is created. When only one of them changed it since they last agreed, the other simply takes the new version, with no conflict. Conflict copies and the `schemas/` snapshots each instance writes for itself stay on that instance and are never synced. A dedicated **Conflicts** item then appears in the sidebar's Workspace section, carrying a red count badge of how many are waiting.

Open **Conflicts** from the sidebar to see them. For each conflict choose what to do:

| Option | Result |
|--------|--------|
| **Keep local** | Your version wins, the incoming version is discarded |
| **Keep incoming** | The incoming version replaces yours |
| **Keep both** | Both versions are kept (you can rename the incoming copy) |
| **Save to space** | The incoming version is copied to a different space, then the conflict is removed |

Every conflict ends in one of these four. There is no dismiss: a conflict closes only by one of these, so an incoming copy is never left behind under its conflict name.

**You do not have to do them one at a time.** Tick the conflicts you want — or use **Select all** — pick
an action, and **Resolve N selected** applies it to every one. You are asked to confirm, with the count
and the action named, before anything happens.

This matters after a sync that went wrong: a hundred conflicts is otherwise a hundred clicks, which is
the point at which people start leaving them unresolved. If some of the batch cannot be resolved, the
result says how many succeeded and how many failed rather than reporting the whole run as one outcome.
One batch holds at most 2 000 conflicts — the most the list shows at once — so **Select all** always fits.

---

### An edge label can say what it connects (3.7)

A space can already list which **edge labels** it accepts. From 3.7 a label can also say what kind of thing sits
at each end of it, and whether one thing may have more than one.

Two settings, and both are for **edges only** — the other record types have no ends:

- **Endpoints.** *"A `reports_to` edge goes from a person to a person."* Either end can be left open: saying only
  that `mentions` starts at a document leaves what it points at unrestricted, which is usually what you want. An
  entity with no type counts as `UNTYPED`, and you have to say so to allow it.
- **One or many.** *"A person reports to at most one manager."* Set it on `reports_to` and leave it off
  `works_with`.

**If you list two things on each side, any combination of them is allowed.** Saying a `belongs_to` goes from a
document or a person, to a project or a team, also permits a document belonging to a team. If you need exactly
one pairing, make a second label — that is what the two labels are for.

**A new link that breaks the rule is refused.** Whichever way it arrives — the app, the API, an AI assistant,
or a bulk import — the write is turned away and the message says which end is wrong and what the label does
accept. If the space is set to *warn* rather than *strict*, it is written and reported instead.

**Nothing is deleted or refused retroactively.** Declaring a rule on a label you have already used does not touch
the links you already have, and it does not lock them: you can still edit a link that breaks the rule, as long as
your edit does not change the ends. So a rule can never make an existing record impossible to maintain. To find
out which links break a new rule, use **Validate** on the space's Schema tab: it lists each one and which end is
wrong. A link pointing at something that no longer exists is reported separately, as a dangling link, and not as
a wrong type — and for the same reason it is not refused when written.

**Both are set on the Schema tab**, under **Permitted ends** when an edge type is selected. Two lists — the
types allowed at the **From** end and at the **To** end — and a checkbox for the cardinality. A list you leave
untouched means *any entity type*, which is not the same as an empty one: unticking the last box returns that
end to *any* rather than forbidding every edge of the label.

**A type you deleted still shows in the ends lists if an edge names it, marked *(deleted type)*.** That is
so you can untick it: the edge still enforces the name, and until 5.0 there was no checkbox for it at all,
so the declaration was stuck and invisible. Untick it and it is gone for good — it is not a type this
space declares, so there is nothing to tick it back on to.

**Every type and every property can carry a note saying what it is for.** The Schema tab has a box at the
top of a selected type, and one on each property when you open its row. It is plain text: nobody parses
it, nothing validates against it, and leaving it empty changes nothing.

It is there because an assistant reading the space has to work out what a type is FOR from its name
alone. The type already says a property is a number; the note is where you say it is the retry BUDGET
rather than the retry count, or that one record means one deployed instance rather than one repository.
That is the difference between an assistant guessing and an assistant knowing, and it costs you a
sentence.

**A type can be renamed without losing what is on it.** Use the pencil beside the name in the detail pane
and press Enter, or click away; Escape abandons it. Every property, pattern and enum value comes with it,
and so does every edge that names the type as a permitted end. This is the fix for a spelling mistake
noticed after the properties are in — the name used to be the one thing about a type you could not change.

> **Records already written keep the OLD type name.** A rename changes what the space DECLARES, not what
> is stored, so records created before it will not match the renamed type until they are updated. If you
> are renaming a type you have just built and not yet used, there is nothing to update.

**The two lists are not paired.** Every combination of a From type with a To type is allowed, so two on the
left and three on the right permits six kinds of link, not two. The tab states the number and shows the
combinations under the lists, because a pair of lists side by side reads like pairing to most people.

**no type at all** is a choice in both lists, not the absence of one: an entity may genuinely carry no type,
and permitting that is a decision you can make.

## Schema Library

The Schema Library is an instance-wide store of reusable data definitions. Instead of copying the same schema into every space, define it once here and reference it from any space.

Open **Schema Library** from the sidebar (under Workspace).

### My Library tab

This tab lists all schema definitions on this instance. An entry that spaces use shows how many space types
reference it (for example **3 links**); the counts arrive with the list, so a large library opens with one request.

**Browsing:** Use the search bar to filter by name or description. Use the type filter pills (entity / fact / edge / chrono) to narrow by knowledge type.

**Creating an entry:** Click **+ New entry**. Fill in:

- **Name** — the display name (e.g. `Service`). A unique identifier is derived from it automatically.
- **Knowledge Type** — which kind of data this schema applies to.
- **Description** — optional, surfaced to AI assistants.
- **Naming pattern** — an optional regular expression that entity names must match. A pattern that could
  take exponential time to run is **refused when you save it**, naming the part to rewrite: a repeated
  group such as `(,abc)*` is the usual cause, and a character class normally does the same job. Ythril
  will not store a rule it cannot apply, because a rule that is never applied silently rejects every
  record instead of checking them.
- **Property schemas** — click **+ Add property** to define properties with optional type, constraints, and whether they are required.

Click anywhere on a card to open and edit it. Changes save and close automatically.

**Importing from a file:** Use **Import from file** to load a `.json` file. It accepts either a single library entry (or an array of them) *or* a whole space's exported schema (a `{ typeSchemas: … }` file from a space's Schema tab **Export JSON**) — in the latter case every type is auto-grouped into the library under a group named after the file's space, mirroring **Export to library**. Types linked to the library are skipped.

**Moving a whole GROUP at once, in either direction.** Two buttons above the list work on many entries
rather than one, and they are the pair most people want after setting a space up:

- **Export space schema** — takes every type defined inline in a space and adds it to the library,
  tagged with a group name you choose. The result says how many were created and how many updated.
- **Apply group to space** — the other direction: every library entry in a group is applied to a target
  space as a link, so the space follows the library rather than holding its own copy.

**A linked type shows both its link and its fields.** Wherever the space's schema is read — the API, an AI
assistant — a linked type carries the library link and the library entry's fields together. Saving it back keeps
the link. To change a linked type's fields, edit its library entry here, or unlink the type in the space's Schema
tab to give it its own copy; a changed field sent back beside the link is refused with the field named, because
the change would otherwise be lost.

Together they are how a space stops carrying its own definitions: export once to seed the group, then
apply it back to that space and to every space that should match it. Doing this entry by entry is the
same work with more clicks and more chances to miss one.

**The group Ythril ships: `conversation`.** Every instance's library holds the types the conversation
extractor writes — people, places, animals and the other things a conversation is about, the relationships
between them, the dated events, and the `utterance` fact a claim is stored as. **Ingesting a conversation into a
space needs every one of them**, and the way a space gets them is **Apply group to space** with the group
`conversation`. Ingest never adds them itself; a space without them is refused before any model is asked, and
the refusal names the types that are missing.

You can edit a shipped entry and the edit is kept. A shipped entry you delete comes back the next time the
instance starts, because ingest cannot run without it. They arrive published (globe on); unpublish them if your
library endpoint should not offer them.

**Publishing:** Click the globe icon on a card to make the entry visible to other Ythril instances. The icon turns accented when published. Click again to unpublish. No space data is ever exposed — only the schema definition.

**Sharing your library:** The **Share This Library** panel shows your instance's **Public endpoint** URL. Click **Copy URL** to copy it. Other instances can paste this URL when adding a catalog link.

To protect your library endpoint with a token (e.g. when your instance sits behind Cloudflare Access), click **Create access token**. Give the token a name and click **Create** — the value is shown once. Paste it into the **Library Access Token** field when the consuming instance adds a catalog link pointing to you.

**Deleting:** Click the trash icon. If spaces currently reference the entry, a dialog shows which ones and offers to unlink them automatically before deleting.

### Foreign Catalogs tab

This tab lets you link to other Ythril instances' public schema libraries and import their definitions.

**Adding a catalog:** Click **Add Catalog**. Enter a short ID (e.g. `acme`), the base URL of the remote instance (e.g. `https://brain.acme.example`), and an optional description. If the remote instance requires authentication on its public library endpoint (indicated by a lock icon or communicated by the owner), also enter the **Library Access Token** they issued you.

**Browsing:** Click **Browse** on a catalog card to see all published entries on that remote instance.

**Importing:** Click **Import** next to any entry. It is copied into your local library tagged with the source catalog for traceability.

**Removing a catalog link:** Click the trash icon on the catalog card. Previously imported entries stay in your library.

---
