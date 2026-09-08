# Changelog

All notable changes to Ythril are documented here. This file covers the **current major series**;
earlier majors are archived under [`changelog/`](changelog/) and linked at the bottom.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- **A token with `schema` read on a space can validate that space's schema again.**

  `POST /api/spaces/:id/validate-schema` is a dry run — it scans stored data against the schema and writes
  nothing — and the rights panel lists it at the `schema` area's **read** rung. It was in fact refusing
  anyone who was not an instance administrator or a full space administrator, with `Admin token required`.

  So an operator who granted exactly what the panel asked for was refused, and the message reads as INSTANCE
  admin, which is a different thing again. One reported operator lost an afternoon to this twice.

  `GET /api/spaces/:id/meta` — the same area, one call apart — always honoured the rung, and now this does
  too.

- **Five more space routes are now guarded at the rung the rights panel advertises, not above it.**

  `validate-schema` above was one of six. The other five said the same thing and did the same thing: they
  named an area and a rung, and then admitted only an instance administrator or a full space administrator
  (`admin` on all four areas at once). The rung was decoration on every one of them.

  | route | needs | changed from |
  |---|---|---|
  | `PUT /api/spaces/:id/schema` | `schema` **admin** | `schema` write, guarded at space-admin |
  | `PUT /api/spaces/:id/meta/typeSchemas/:kt/:name` | `schema` write | guarded at space-admin |
  | `DELETE /api/spaces/:id/meta/typeSchemas/:kt/:name` | `schema` write | guarded at space-admin |
  | `POST /api/spaces/:id/rebuild-indexes` | `knowledge` admin | `schema` admin, guarded at space-admin |
  | `POST /api/spaces/:id/reembed` | `knowledge` admin | `schema` admin, guarded at instance admin |

  **Nobody loses access.** A space administrator holds `admin` on all four areas, so every one of these still
  admits exactly the people it admitted yesterday — through the rung instead of through a separate check.
  What is new is that a token given one of those rungs and nothing else now works, which is what the grid
  was always claiming.

  Rebuilding and re-embedding moved from `schema` to `knowledge` because neither reads or writes a type
  definition: they rewrite the vectors and indexes that recall searches, and while a rebuild runs, recall
  returns nothing. They sat under `schema` because of the URL they are registered on.

  `PATCH /api/spaces/:id` and `DELETE /api/spaces/:id` went the other way and are now declared as NOT
  area-scoped. Settings are Space-admin — a column in the design, and not one of the four data areas — and
  deleting a space destroys all four at once. Neither guard changed; what changed is that they no longer
  advertise a rung that could not open them. Governing the settings body per FIELD by area is separate work.

  On the MCP door, `update_space_schema` needs `schema` `admin` on the space rather than all four areas, so
  the two doors admit the same callers. `reindex` moved to `knowledge` admin with its route.

- **A space's settings are governed field by field, so a media level no longer costs the whole space.**

  Every one of the twenty-two fields on `PATCH /api/spaces/:id` demanded Space-admin — `admin` on all four
  areas at once. On the busiest space-configuration door in the API the four areas therefore bought nothing:
  a `files` administrator could not set a media-analysis level, a `dataQuality` writer could not tune a
  duplicate rule, and either had to be handed the entire space instead.

  Each field now answers to the area that owns it. Media levels and `faceDescriptorDims` are `files`, the
  duplicate rules are `dataQuality`, `recordTtlDays` / `completeLinkage` / `meta.suppressEmbeddings` are
  `knowledge` admin, and the type schemas are `schema`. `label`, `meta.purpose` and `meta.usageNotes` stay
  with the space administrator: they are the space's description of itself and no data area owns them. The
  full table is in the integration guide.

  **`maxGiB` is the one field that TIGHTENED.** A space's quota is its share of the host's disk, so it takes
  the instance administrator — a space administrator raising their own was self-granting. The route already
  refused it per-field; that hand-written check is gone and the table says it once.

  A body mixing a field you may set with one you may not is refused **whole**, with a `403` naming each
  refused field and what it needs. A half-applied settings save is worse than a refused one, and one save
  should produce one conversation with whoever grants rights rather than one per field.

  Both MCP tools that write space meta run the same table, so no field means something different on the two
  doors. `update_space` still asks for the space administrator at the door, which makes MCP the stricter
  surface here — a narrowing, not a second rule.

  **In the web UI this reaches the tabs that save a narrow body — the Danger Zone and Duplicates — and not
  yet the main space-settings dialog**, which posts every field on the form whether or not it changed, so
  the highest requirement in the form still decides. Nothing there behaves differently than before; the
  dialog simply does not benefit yet.

### Internal

- An MCP tool now forwards the arguments its own schema declares, rather than a list of names written beside
  it. Two tools had that shape and one was already wrong — a field declared on the tool, accepted, and
  dropped before the write while the REST door stored it. A gate refuses a third.


- `whenDuePasses` is now exercised end to end against a real store, not only asserted from source. The
  standalone gate reads the status filter's query SHAPE, and a query whose shape is plausible can still match
  the wrong rows — so the four-row truth table an operator actually cares about (both read paths, and the
  filter in both directions) is driven against a live instance on every run.

## [4.3.0] — 2026-09-08

**The release where you decide what a passed date means.** A chrono entry whose due moment has passed reads
back as *overdue* — right for a deadline, wrong for a record of something that happened. A chrono type, or a
whole space, can now say that a past date means nothing, and those entries come back with the status you
stored.

**No breaking changes, and nothing changes unless you set something.** Absent is exactly the previous
behaviour, down to the database query, which is byte-for-byte unchanged on a space that has not set the
field.

**Documentation changed in this release**, for deployments that re-ingest the guides on deploy: a
size-idempotent refresh skips a file whose byte size matches the stored copy, so use `--force` for these.

| file | why |
|---|---|
| `docs/integration-guide/04c-chrono-api.md` | what `whenDuePasses` does to `status`, with the value table |
| `docs/integration-guide/06a-schema-api.md` | the field on `TypeSchema`, and the space-wide tier |
| `docs/integration-guide/16-mcp.md` | the meta fields `update_space_schema` writes |
| `docs/userguide/02-brain.md` | the Chrono tab's note on how *overdue* is worked out |

### Added

- **You decide what a passed date means, per chrono type.**

  A chrono entry whose due moment has passed reads back as **overdue**. That is right for a deadline and
  wrong for a record of something that HAPPENED — a deploy, a backup run, an alert episode — where a date in
  the past is the normal condition and means the opposite of late. One operator had two readers comparing
  the returned status against `active`; because those records are past-dated by construction, neither
  comparison could ever succeed, and **1 687 of 1 806 entries in one space never closed**.

  Set `whenDuePasses` to `"nothing"` on a chrono type in the space schema — or on the space itself, to cover
  every type that does not say otherwise — and those entries come back with the status you stored. Set
  `"overdue"`, or leave it out, and nothing changes.

  **Absent everywhere is exactly today's behaviour**, so an instance that sets nothing sees no difference.
  Resolution is schema over space, the same order `retention` and `suppressEmbeddings` use. It applies to the
  status FILTER too, so listing by `overdue` cannot return an entry that reads as `active` everywhere else.

  Refused on the other collections rather than stored and ignored: only a chrono entry has a due moment.

## [4.2.0] — 2026-09-08

**The release where a control that was documented actually applies.** Everything here is one shape found in
three places: a setting an operator could read about, set, and get no effect from. Three of the ten per-model
time limits had no control at all and four had no effect when set; a budget you did set read back blank on
every reload; and a space could be converted to link records with no way to see whose writers would break.

**No breaking changes.** One thing to re-check before upgrading a busy instance: if you had set
`modelSlots.docVlm`, `docRepair`, `docVerify` or `assist` and it appeared to do nothing, **it does something
now** — confirm the value is still the one you want.

**Documentation changed in this release**, for deployments that re-ingest the guides on deploy: a
size-idempotent refresh skips a file whose byte size matches the stored copy, so use `--force` for these.

| file | why |
|---|---|
| `README.md` | the MCP tool count |
| `docs/integration-guide/04b-graph-api.md` | the conversion pre-flight endpoint |
| `docs/integration-guide/05a-conversion-pipeline.md` | `pageTimeoutMs` is a default, not an override |
| `docs/integration-guide/05b-media-embedding.md` | the other side of that sentence, in the slot table |
| `docs/integration-guide/16-mcp.md` | the new tool's rows |
| `docs/userguide/04-settings.md` | the three document cards, and how the page budget and a slot budget fit together |
| `docs/userguide/05-storage-data-and-audit.md` | check who still writes the arrays before converting |

### Added

- **You can now find out who is still writing the old connection lists, before you convert a space.**

  Converting a space (`links:convert`) turns its `entityIds` / `memoryIds` / `chronoIds` entries into link
  records and makes those fields refuse further writes. The refusal is correct and it is opt-in — but it
  reaches a caller on its **next write**, not at conversion time, so an operator converts and then learns
  which of their writers still use the old surface when one of them breaks, possibly days later. One
  operator had five and knew about none of them.

  `GET /api/brain/spaces/:spaceId/links/convert-preflight` and the `links_convert_preflight` tool answer with
  the access tokens that have sent a connection list to that space: which fields, when each last did, and how
  many times. `windowDays` defaults to 30.

  **Read the `since` in the answer before the count.** It says how far back the answer looks, and a count
  with no window on it cannot be told apart from a count over a shorter one. Nothing older than 90 days is
  kept, and asking for a longer window is capped to it rather than refused — on both doors.

  Deleting a space forgets its answer with it, so a space recreated under the same id is never told about
  writers that wrote to its predecessor.

### Fixed

- **A per-model time limit you had set showed as blank whenever you reloaded the Models page.**

  The value was stored and applied correctly the whole time — the page just could not read it back. The
  settings screen asks the server for its media configuration, and the per-slot budgets and reasoning
  efforts were the one block that answer never contained, so every one of those boxes rendered empty on load
  with the built-in default showing as a placeholder. Set a budget, save, reload, and it looked as though
  nothing had been saved.

  Nothing was lost, and nothing needs re-entering: reload the page and the values you set are there.

- **Three of the ten per-model time limits could not be set anywhere, and four of them had no effect when
  they were.**

  Each model Ythril calls has its own budget — how long one request to it may take. The Models tab offered
  seven of them. The three document models — Document VLM, Document repair and Document verify — offered
  none, and there is deliberately no environment variable for these, so there was no door at all. All three
  now have a call budget, a reasoning effort and their own Save.

  **The larger half was behind the missing door.** Every model call the document pipeline makes was handed
  the DOCUMENTS per-page time limit as an override, so whatever an operator set for `docVlm`, `docRepair`,
  `docVerify` or `assist` was discarded — including the one slot of those four that did have a control.
  Both numbers default to 60 seconds, so the setting an operator read and the one the code used agreed
  exactly until somebody changed one.

  **What changes for you:** the page limit is now the DEFAULT those four models fall back to, and a budget
  set on a model wins for that model. Set nothing and nothing moves. If you had set one of those four and
  wondered why it did nothing, it works now — check the value is one you still want.

### Internal

- The Save button on a model card was the same five lines of markup in ten places; it is one component, and
  the Models tab is 21 lines smaller than before three cards gained one.

## [4.1.0] — 2026-09-08

### Added

- **An invite to join a network is now ONE line to copy, not a JSON object to paste.**

  Owner, 2026-09-02: *"i just would like it to be a single string at the end and not something that looks
  like a json object -- thats too frightening for some tech-averse people i had to learn from my wife."*

  `POST /api/invite/generate` returns an `inviteCode` beside the fields it already returned: the same bundle
  as one unbroken line beginning `ythril1_`. No braces, no quotes, no line breaks -- a PEM key has plenty of
  those, which is what made the old form wrap in email and break in chat clients. The joiner's dialog takes
  either shape, so an invite generated before the upgrade still works.

  **The whole bundle travels, and that is the safer choice rather than the lazy one.** The alternative was a
  short URL the joiner fetches the rest from -- but the inviter's public key is what pins the handshake to
  the intended instance, so a fetch is a place to substitute a key, after which the joiner encrypts to
  whoever answered. Carrying it keeps the key out of band and adds no unauthenticated endpoint.

  **It is an encoding, not encryption.** The code contains the handshake credential, so it is a secret in
  transit and the UI now says to send it the way you would send a password. What limits it is that the
  handshake expires and is consumed on use.

- **A batch can now connect the records it creates.** `bulk_write` took four record arrays in one payload and
  its own contract said why that was not enough: you cannot reference a record the call creates, because
  identities are minted server-side. Put `"$ref": "post-1"` on an item and later items name it as
  `"$ref:post-1"` — in an edge's `from`/`to`, or in a link field.

  The operator who asked measured the cost: posting ONE message to their board took six round trips, one
  `upsert_entity` and five `upsert_edge` for `posted_by`, `addressed_to`, two `answers` and one `corrects`.
  It is one call now.

  **The key is not an id.** It is scoped to the call, never stored, and means nothing after the response —
  the record's identity is still minted by the write.

  **Edges are written LAST**, after every record array. They used to run before chrono entries, and the order
  was documented as mattering only for records a batch updates; a correlation key changes that, because a
  reference cannot point forwards and an edge to a chrono entry in the same payload could never have
  resolved. Now "declare it earlier in the call" is true for every kind rather than for the two that
  happened to come first.

  **A stated kind is now CHECKED rather than used.** `fromKind`/`toKind` exist because a bare UUID can name
  records in two collections and a wrong guess stores a relationship that reads as correct and points at
  nothing. A `$ref` cannot be ambiguous — the array it was declared in says what it is — so a kind that
  disagrees is refused rather than resolved. A key used twice is refused too, rather than overwritten.

- **`bulk_write` checks references for EXISTENCE on a converted space.** This door has always been laxer than
  the single-record ones — shape only, never existence — which is a defensible trade for an import where
  records legitimately arrive in an order nobody controls.

  It stops being defensible once the correlation key makes the batch the normal way to write a linked record.
  In the reporter's words: their correspondence, deploy log and ticket updates would all move onto the door
  with the weaker guarantee, *"and a dangling `answers` edge is exactly the failure we would never notice —
  it reads as an unanswered post forever."*

  Scoped to spaces that have converted to link records, which is exactly the concern raised: such a space has
  already declared that links are the model. An unconverted space keeps the import trade unchanged.

- **A record and its relationships are ONE call again, on every create door.** Reported by a fleet operator
  as the thing stopping them converting to link records: every write door takes a reference at create time
  today, those are refused after conversion, and attaching a record to three things becomes four calls.

  Two fields, on `memories`, `chrono`, `entities` and their MCP twins:

  - **`linkEntities`, `linkMemories`, `linkChronos`, `linkFiles`** create unlabelled links. Named as verbs
    rather than as `entityIds`, because after conversion the same name would mean *go and create these
    links* — a field named like a property and behaving like an instruction reads correctly and is
    understood wrongly. An old caller gets a refusal naming the new field.
  - **`edges`** creates LABELLED relationships, with the optional `weight`, `type`, `description`, `tags` and
    `properties` an edge carries. `posted_by` and `addressed_to` from one record to two parties are two
    different facts, and no array of bare ids can say which is which.

  **They differ on what an update does, and both descriptions say so.** A `link*` field REPLACES the links of
  its kind — `[]` detaches them all, omitting it leaves them alone, other kinds are never touched. `edges`
  UPSERTS and removes nothing: an edge carries a label, properties and possibly another author, so clearing
  the set would delete work nobody asked to delete. That was the third thing the operator asked us to state,
  and the answer already existed in the writer.

  Neither can connect two records the same call creates — identities are minted server-side. That case is
  `bulk_write`, and the correlation key for it is tracked separately.

- **Each search result now says which score put it there, and a short graph says it is short.**
  Ordering precedence is `rerankScore` → `fusedScore` → `score`, so on an instance with a reranking model
  configured, plain vector similarity is not the number that ordered the answer — and the panel was showing
  exactly that number, labelled "Score". It names the deciding field now, with any other stage that ran
  beside it.

  A stage that did not run is left out rather than shown as zero: no reranker configured is a different
  statement from a reranker scoring nothing, and the second one is what a zero says.

  **A traversal that stopped short was indistinguishable from a complete one.** `graphTruncated` and
  `graphComplete` were not in the client types at all, so `graphNodes: 7` could be the whole neighbourhood or
  the first seven of forty with nothing to tell them apart. The panel reports it above the results and offers
  the whole graph as a download where the instance could write one — which it cannot always: a bounded link
  scan leaves nothing complete to write, because the records missing are precisely the ones never read.

- **The Query panel's answer is a card, its records fold, and the Search button is where you look for it.**
  Owner-directed, 2026-09-07. Three things at once, because they are one complaint:

  - **A long record is a few lines until you open it.** Every result renders as a JSON tree — a nested part
    starts collapsed with its size beside it (`{…} 4 keys`, `[…] 3 items`), each level has a copy button that
    copies that part alone, and *Expand all* / *Collapse all* sit in the card header. It replaces a
    pretty-printed dump per result, which is unreadable the moment a record carries a properties bag.
  - **The answer sits in its own card**, with a header saying how many results and how big the answer was.
    There is no longer a row holding one button wedged between the request and the answer.
  - **Run and Clear are on a sticky bar at the top right**, so a parameter changed at the bottom of a long
    form does not send you back up to run it.

  A **JSON** view beside the rendered one shows the whole response exactly as the API returned it — the
  count, the truncation flag, the budget figures and every graph subtree. That is what an assistant calling
  the same search receives, and this panel is where a search is tried before it is sent by something else.

  The tree walks only into what is OPEN, so a hundred elements behind a closed caret cost one line rather
  than a hundred. That is what keeps it usable on the answers the byte budget exists for.

- **The link conversion can be previewed, and the guides now say what it touches and how to undo it.**
  `npm run links:convert -- --preview` reads and writes nothing: per space, how many records carry each
  connection list, how many entries those lists hold, and how many link records already exist. Run it again
  after converting and only the link count has moved.

  Reported by an operator who had not run the migration and said exactly why — they could not see its scale
  beforehand, the `400` that follows lands on some other service's next write, and nothing anywhere said
  whether it could be undone. *"An operator who believes a step is irreversible defers it, which is what we
  are doing."*

  **Three of those four answers already existed in the code and nowhere a reader would find them**, and they
  are now on both the integrator's and the operator's page:

  - **It is per space, and one space is a real pilot.** Converting a named space deliberately does not set
    `completeLinkage`, so links are created and nothing starts being refused.
  - **The prerequisite is therefore "before you MARK", not "before you convert".** Between the two you can
    find your remaining array writers at your own pace — including agent sessions, since `create_chrono` and
    its siblings accept `entityIds` directly.
  - **The marker is reversible.** It is an ordinary space setting; turn it off and array writes are accepted
    again. The link records stay, because they are not what it switches.

  The preview is a separate function from the conversion rather than a dry-run flag through it, and a gate
  holds it to an allowlist of read calls — a preview sharing the writer's path is one forgotten branch away
  from writing, and a preview an operator does not trust is worse than none.

- **A slot can ask a thinking model to think less.** Each model slot gains a **Reasoning effort** setting,
  sent as `reasoning_effort` on the OpenAI-shaped request. Blank means the field is not sent at all, which is
  what every installation did before this existed.

  **The case it was reported from, with the number.** A 27B model answers, and takes **3 minutes 32 seconds**
  at its own default effort — nothing misconfigured, it is thinking. Three callers around it were failing at
  three different deadlines against that one endpoint, and none of them could ask for less, so each had only a
  timeout to fail on. A longer budget is not a fix for that shape.

  **Check which values your model accepts.** Only `none` is handled by the inference server (it turns thinking
  off outright, whatever the model). `minimal`, `low`, `medium`, `high`, `xhigh` and `max` are passed to the
  model's own chat template, and **a template that does not know a value rejects the request** — the server
  starts normally and then fails every call. Qwen3.8 accepts `low`, `medium` and `xhigh` and errors on
  `minimal`, `high` and `max`; on it, `medium` cuts the wait by about a third.

  Where a second model is available, pointing the slot at one that does not think is still better than asking
  one that does to stop.

  **Both per-slot settings are now on the Models page**, on each model's own card: the call budget, which had
  been config-only since it shipped, and the reasoning effort beside it — the effort only on the cards whose
  requests actually carry it, because a control wired to nothing reads as configuration that took effect. An
  empty budget means the built-in default, shown as the placeholder; an empty effort means nothing is sent.
  Infra pins a slot as before, and both controls lock together.

### Changed

- **A release note too long for GitHub now leads with what breaks, instead of with whatever came first.**
  Breaking entries are lifted above everything else, all of them, and the notice at the top says how many of
  how many are shown. The paragraphs a release opens with are kept whole; the rest follows in its original
  order.

  Reported by an operator who read the abridged 4.0.0 notes and missed the largest change in the release —
  the link system, which changes what happens to every caller writing `entityIds`. They found it because
  their own owner asked, not because the release told them. **The finding is the truncation, not the
  omission:** 81 entries of 227 were shown, chosen by nothing but document order, and no amount of raising
  the budget fixes a selection rule that is *"whatever came first"*.

  What counts as breaking is read out of the text rather than kept in a list: the word itself, in either
  spelling this changelog has used, or membership of the `Removed` section — because a removal breaks a
  caller whether or not its author happened to write the word.

  A release whose notes fit is published unchanged, as before.

- **The guides now say what reranking COSTS, which is the number that decides whether you get it.** The
  cross-encoder reads your question together with each candidate passage, so its work tracks the total TEXT
  of `topK × candidateMultiplier` candidates rather than their count. On records of several kilobytes that is
  seconds per result — measured on a live instance, one result took 5.09 s and four took 17.79 s, while
  another instance on the same server and model reranked a comparable set in 2.83 s. The only difference was
  how long the records were.

  Nothing about the behaviour changed. What was missing is that the failure is silent: when the budget
  expires the search still answers, ordered by meaning alone, and looks entirely reasonable. At the default
  multiplier of 4 and the default 20-second budget that puts the ceiling at about four results on six-to-
  nine-kilobyte records, and nobody reports a result that looks fine.

  Covered on all three pages that an operator or an integrator would open for it, including which of the two
  possible deadlines is ours: raising `modelSlots.rerank.timeoutMs` past the limit of whatever proxy sits in
  front of the API buys nothing.

- **The question, the JSON filter and the JSON projection are three cards side by side** on Brain → Query →
  Semantic Search. They are the three controls that decide WHAT is searched; the rest of the panel decides
  how much comes back and in what shape. The filter and projection were previously buried below the question
  among the tag and type fields.




- **Every benchmark ingest strategy declares what its corpus may contain, and the instance enforces it.**
  The spaces were created bare: `validationMode` defaults to strict, but with no `typeSchemas` there is
  nothing to validate, so every malformed record was accepted. A missing field then scores low and reads as a
  finding about retrieval rather than as a bug.

- **Linking a record to what it is about costs its ranking nothing** (measured, 199 questions). Three
  strategies in the benchmark folder claimed it cost 1.5 points by prepending linked entity names to the
  fact; `entityIds` never reaches the embedded text. Walking those links is a different matter: at a fixed
  answer budget a `traverse: 2` recall returned 6.0 records where the same query without the walk returned
  19.7. Filed as `F-24` — a caller cannot cap how far one match spreads.

### Fixed

- **Two sidecar containers had their memory, CPU and process ceilings written into `docker-compose.yml`**,
  so an operator whose documents needed more headroom had to edit the compose file -- the exact thing the
  gate covering this says they never have to do. It checked three services of the five that carry ceilings.
  Both are `${VAR:-default}` now and the six new variables are documented in `.env.example`.

- **The hosting guide's list of `/ready` reason codes is now checked against the type that declares them.**
  The check named five of six. The sixth was documented anyway; nothing would have said so if it were not.

- **`recall` and `query` held byte-identical copies of the filter key allowlist and its matching rule** --
  in two modules, one of which already imported the other. That pair is the example the parity rule was
  written from: a caller reaches one grammar or the other depending on which door they picked, and a copy
  that drifted would be invisible from both sides. The stake is not injection alone -- a key outside the set
  is one the index cannot serve, so widening one copy is a performance cliff wearing a feature's clothes.

- **The seven merge functions were written out four times**: two type unions, two `Set`s in the validator,
  and a `z.enum` in the space-schema body. The one that matters is the validator -- a function the schema
  offers and the validator does not know is a merge that refuses a value the UI put in front of the operator.
  One list now, with the types derived from it.

- **The three security-posture verdict levels were a type union plus a copy of it in the metrics registry.**
  The registry pre-declares one series per level at zero, because an absent series and a zero one look
  identical on a graph and mean opposite things -- so a fourth level added to the type would have been the
  one an operator's alert never sees, with nothing failing anywhere to say so.

  A union is erased at runtime, which is why there was a copy at all; the levels are a runtime list in a leaf
  module now, with the type derived from it, and both ends import it. A leaf module because the registry
  cannot import the posture module without inverting the dependency direction.

- **The four size-budget parameter names were written out at three read routes, and the routes refuse what
  they do not name.** A fifth budget parameter would have been accepted by the resolver and answered with a
  400 by `/query`, `recall` and `find_similar` -- a refusal nothing described, on a parameter the product
  supports. The vocabulary now lives once, in the module that owns it, and the doors spread it.

- **A gate that keeps unsortable fields out of "every whitelist" was watching two of the three.** The third
  link array, `chronoIds`, arrived with M-2 and could have been made sortable on any collection with nothing
  to say so -- and sorting by an id array orders rows by nothing a reader can see.

  Two more lists of the same kind were derived rather than re-typed: the fields a `deleteFields` path may
  clear on a chrono entry and on a file's metadata. Both mix the record's own optional fields, which are
  named, with its LINK arrays, which are whatever the link classes say -- and a settable field missing from
  that list is a path accepted at the door that then silently does nothing.

  The lesson is in the two comments above those lists: both said the fields were "derived rather than
  hand-listed", directly above a hand-written list. A sentence like that is worse than none, because it is
  what stops the next reader checking.

- **A space rename carried its four per-space sync watermarks with four copies of one rule, and the copies are
  now a loop over a declared list.** The failure a missed copy produces is silent by construction: a watermark
  that is not carried resets to "unknown", which is SAFE -- the pull re-reads from zero, idempotent, and the
  retention floors simply stop pruning. Nothing errors and nothing is lost, so nobody would ever report it,
  and a fifth watermark would be added to the type by somebody with no reason to open the rename.

  The list sits beside the interface where that fifth one gets added, and a gate reads the interface's own
  source to check nothing has been added to it and left out of the list.

  THREE gates were checking that rule, each written by somebody adding the watermark they had just built:
  one named four fields, one named three, one named two. The one that named three could not see
  `lastFileTombstoneAckedAt` at all. They now share one derivation.

- **Every level of the logger is now shown to redact a bearer token, rather than being named in a list.**
  The security gate for this checked that the source TEXT mentioned four level names -- which a fifth level
  added without redaction passes, and so does an existing level rewritten to log the message directly. Each
  level is now called with a real token and its output read back.

- **Three of the six link classes had no database index, so every traversal hop scanned those collections.**
  A link is a (collection, FIELD) pair, and the index creation named three COLLECTIONS with the field written
  out as `entityIds`. That was right while `entityIds` was the only link field; M-2 gave a chrono entry
  `memoryIds` and a file `memoryIds` and `chronoIds`, and those three arrived unindexed.

  Nothing reported it, which is the part worth keeping: an unindexed scan returns the correct answer, just
  slowly, and only on a space large enough to feel it. The gate covering this said "all three link
  collections get an index" and was true as written.

  Both the create path and the existing-space backfill now derive their indexes from the link-class list, so
  a seventh class arrives with its index. Existing operators get the three missing ones on the next boot.

- **A retention case that says "in every collection" now includes the collection the feature was built for.**
  It inserted an entity, a memory and an edge, and never a chrono entry -- so the case proving an unpoliced
  type is left alone proved nothing about chrono. Found by `Q-6` round 12, which reads gates whose TITLE
  claims a whole set while their body reads part of it.

  **And the gate that shipped one PR earlier found five more of the sweeps it was written for.** They hoist
  the pathspec into a variable, so the statement making the call names no file extension at all -- invisible
  to a grep, and invisible to the first version of the detector, which read forward from the call only. The
  window reaches two lines back now, which is where a hoisted pathspec lives.

  Four more gates in that round were converted to take the record types from the source that defines them,
  rather than from four names written into each test. The sharper find was a SECOND list hiding inside one
  line: a gate looped over four type names and then read `mcp/tools/${type}.ts`, assuming a module is named
  after its type. That is true today and is a rule nowhere, so a tool moved into a shared module would have
  stopped being checked with nothing going red. Each tool is now found by the declaration it makes.
- **A gate that asks what source files this repo has now goes through one module, and a new gate cannot roll
  its own.** Seven more sweeps were found by the gate itself, after a grep had reported the set complete --
  they spell the same call with a different flag, which is precisely why deriving the set beats listing it.

  The module gained two things a conversion would otherwise have lost. It reads the listing NUL-separated, so
  a path containing a space or a non-ASCII byte is no longer quoted by git and silently skipped by every
  endsWith the caller wrote. And it takes an option for including files that are not committed yet, which two
  gates need for the same reason: an unbounded upstream read, or a boot migration over synced data, is worth
  refusing before it is pushed, and a tracked-only listing cannot see one written five minutes ago.

  The floor is what the module is really for. A listing that returns nothing passes every loop written over
  it -- no offenders, green tick, nothing checked -- and that guard is one line that looks like boilerplate,
  so it is the line a copy leaves out. Asking for the sources now gives you the floor whether you remembered
  it or not, and it throws rather than returning empty.

- **Three more source sweeps moved onto the shared helper, and two were marked as ones that must NOT move.**
  The two are the useful half: `source-text-hygiene` sweeps EVERY tracked file, because a control byte in a
  `.json` or a `.md` is the same defect and narrowing it to sources would quietly stop checking most of the
  repository; `upstream-reads-are-bounded` deliberately includes UNCOMMITTED files, because an unbounded read
  added in the working copy is exactly the one worth catching before it is pushed.

  Both now say so where the next person will look. A shared helper that absorbs a caller asking a different
  question is the failure mode of consolidating, and it is silent — the gate keeps passing while checking
  less.

- **Twenty-two gates that swept the source tree by hand now go through the one helper.** Each was the same
  four lines — shell out to `git ls-files`, split, filter by extension, assert a floor — and the floor is the
  half that matters: an empty listing passes every loop written over it, so a gate whose scan breaks reports
  a green tick about a set it never read. In `trackedSources` it throws instead, and cannot be forgotten.

  Converted one at a time, each verified on its own, because a mechanical rewrite of all of them was tried
  first and reverted: cutting each call to the following semicolon drops whatever else was chained there, and
  twelve gates went red at once.

- **The gate sweep's own output had become a copy, and now has a module.** Six rounds of replacing
  hand-written file lists with a derived one had produced the same four lines — shell out to `git ls-files`,
  split, filter, assert a floor — ten times over, written by the work whose subject is that a rule written
  twice is a rule that can be wrong once.

  `testing/standalone/_sources.mjs` answers that one question, and the floor lives INSIDE it: an empty
  listing throws rather than returning nothing, because a caller that receives nothing loops over nothing and
  reports a green tick about a set it never read. It drops `.d.ts` without being asked, since every
  hand-rolled copy did.

  Owner rule, now in `CLAUDE.md` and applying to every project: *"Wherever possible reuse modules or build
  modules to be reused and perfectly maintainable."* Extract at the SECOND site, put the forgettable guard
  inside, and keep one question per module — a shared thing that grows a flag per caller is a switch
  statement with extra steps.

- **Two more copies of a shared vocabulary, both on paths where a copy is expensive.** `edge-id.ts` had its
  own default for an edge endpoint's kind — and that module decides an edge's IDENTITY, so the day the
  default changes an id derived there would disagree with the kind stored beside it, and the two would
  describe different edges while looking like one. The five chrono statuses were spelled out again in the
  sync INGEST schema, where a list two words wrong refuses a status the rest of the product accepts and holds
  the replication watermark on it, and in the bulk tool's published schema.

  All three now read the one list. Nothing behaves differently today: every copy agreed with what it was
  copying, which is exactly why nothing had reported them.

  Found by finishing the file-path half of the gate sweep — four more titles that claimed a whole set
  (*"no door"*, *"nothing writes them out again"*, *"neither door"*, *"every door"*) while reading between
  one and four named files. Two hard-coded counts went with them.

- **The next-PR plan can no longer be a receipt for work that shipped.** The check on it looked for a merged
  pull-request NUMBER, and a plan is written in tracker ids rather than numbers — so a second half was added
  asking whether it names an open row. That half is skipped entirely by the words `owner-directed`, which
  exists because work arrives by message before it is filed.

  So a plan sat there for two days describing a branch that had shipped, green on both: no number, and
  `owner-directed` present. It now also checks the BRANCH the plan names. A branch that does not exist yet is
  fine — that is the file used as its name says, planning ahead — and one that has been cut and is not the
  branch in hand is a receipt.

- **The function that flattened a graph into the result list is deleted, not merely unused.** The Query panel
  stopped calling it when the reported bug was fixed — a traversed neighbour arriving in rank order, counted
  in the total, looking exactly like a match — but the function stayed exported, with its own tests keeping
  it alive and a comment in the API service still pointing at it as the thing that turns the tree into rows.

  Nothing in the product called it. What it cost is the next component to go looking for a way to render a
  traversal: the flattener was the obvious answer, it was documented as the answer, and using it would have
  reintroduced the bug in a second place. The behaviour is pinned either way — a spec asserts that two
  neighbours under one match leave one result, not three.

- **Nine gates that asserted a whole set while reading a hand-written list of files now read the codebase.**
  Each had a title claiming *"nothing in `server/src`"*, *"no module"*, *"any route"*, *"every reader"*,
  *"every list function"*, *"no door"* — and a body that looked at between one and five named files, which
  were the files somebody had open on the day it was written. Their sets are derived from `git ls-files` or
  from who imports the thing under test, each with a floor on what it found, because an empty scan passes
  every loop written over it.

  Three assertions carrying an exact call count went with them. A number in a title or an assertion is a
  second copy of a fact the code already holds, and it fails in both directions: a new site is invisible to
  it, and a site that legitimately appears goes red on arithmetic rather than on the rule.

  **One found a real defect.** Three modules in the access layer each kept their own copy of the four
  permission areas — two as arrays, one as a hand-written type — and nothing compared them; one of the three
  is what decides whether a token may touch a space at all. They agreed, so nothing was wrong today. What
  they cost is the day a fifth area is declared, when the copies nobody remembers keep governing access with
  the old vocabulary and the compiler is happy with every one of them. All three now read the one list.

- **The tracker gate compared against whatever `main` pointed at locally**, so a branch cut while that ref
  was behind diffed against an older tree — files the branch never touched read as changes, and the rule
  that every change owes an `[Unreleased]` entry passed on somebody else's commits. Three pull requests
  shipped with no entry that way, each ticking the row, each green. It asks `origin/main` first now.

- **Three modules in the access layer each kept their own copy of the four permission areas**, and nothing
  compared them. Two held the names as an array — including the module that decides whether a token may
  touch a space at all — and a third held them as a hand-written type. All three now read the one list.

  Nothing was wrong today: all four copies happened to agree. What they cost is the day a fifth area is
  declared, when the copies that were missed keep governing access with the old vocabulary and the compiler
  is happy with every one of them.

  Found by making four gates check what their own titles claimed. Each said *"nothing in `server/src`"*,
  *"no module"*, *"any route"*, *"every reader"* — and each read a hand-written list of two to five files,
  which were the files somebody had open on the day it was written. The gate that claimed the whole access
  layer was reading three of its modules; derived from `git ls-files`, it found the other two immediately.

- **A refused save on Media Processing now says what the server said.** Selecting an extraction mode the
  installation cannot serve left the Save button looking inert: the request was made, the API answered with a
  reason, and the page threw it away. An operator hit this against 4.0.0 and spent an hour not knowing which
  field was objecting.

  It was broader than the one form they hit. The bar that renders the outcome sat behind a condition that was
  the literal `false`, so it never appeared — and that bar was the **only** place on the page where either a
  refusal or a confirmation was ever shown. Every card and every pipeline sets both; nothing displayed
  either. The success half mattered as much: with no confirmation, silence meant "saved" and "refused"
  equally.

- **A token that administers every space through the rights FLOOR was refused by the token routes**, where the
  guide promises it a scoped listing. It held `admin` on all four areas with no `instanceAdmin`, and
  `GET /api/tokens` answered `Admin token required`.

  The gate counted per-space rows, and a floor names no space, so it read zero as "administers nothing" —
  while the same rights already scoped that token to every space. **The cost was a daily token-inventory job
  running blind for two weeks**, so an expiring credential lapsed with no warning. The same count hid every
  space-admin tool from that token over MCP, and is corrected with it.

- **The vector-index panel no longer declares every space broken on a self-hosted MongoDB, next to a button
  that would re-embed everything.** `listSearchIndexes` is the Atlas Search API; a replica set running
  `$vectorSearch` natively has nothing behind it, so the call succeeds and returns an empty list — which was
  read as "no index exists". Every space then showed as drifted, in red, each row offering **Rebuild**.

  Reported against a live fleet where recall on those exact spaces returned correctly ranked results with
  real scores. **The danger was the button**: a 79-file re-ingest on that host took embedding from 80 ms to
  2–9 seconds for forty minutes and starved the reranker; fifteen spaces would have been hours of it, on a
  false alarm.

  When not one index is found anywhere on the instance, the panel now says the deployment does not report
  search indexes, and points at the check that actually answers the question — whether recall returns ranked
  results. A single space missing an index among others that have them still reports as missing.

- **The document verify model has its own call budget again — it never actually had one.** `docVerify` was a
  declared slot: it had a default, the admin API accepted it, infrastructure could pin it, and the field
  reference documented it. Nothing read it. The second-opinion pass runs against its own endpoint, usually a
  different model, and was charged to `docVlm` for its budget, its egress permission and its reasoning
  effort — so an operator who raised `modelSlots.docVerify.timeoutMs` because that model is slower got no
  effect and no warning.
- **The Query panel no longer reshapes the answer it shows you.** Records reached by graph traversal were
  appended to the result list as if they were matches — in rank order, counted in the total, and
  indistinguishable from a record that actually answered the question. They now sit under the match that
  reached them, grouped as entities, memories, chrono entries and files, each shown whole with its hop count
  and the link that reached it.

  **Why this is a bug and not a preference:** the panel is where queries are tested before they are sent by
  something else. A request tried there and then issued by an MCP client has to come back the same shape, or
  the screen is teaching a contract the product does not have.

- **A semantic search that matched nothing now says so.** It rendered exactly what the panel shows before
  you have searched at all — nothing — so the natural reading was that the button had not worked. The
  advanced-query side has always said "no documents"; this side kept only the result list, and an empty list
  cannot tell "found nothing" from "not asked yet". An error still reads as an error rather than as no
  matches, because a search that failed did not find nothing, it did not finish.



- **Internal: shell scripts are pinned to LF in `.gitattributes`.** No deployment was affected — the
  committed bytes have always been LF, and a Linux or macOS checkout gets them unchanged. It bites a
  contributor on Windows, whose checkout converts to CRLF, when a POSIX shell then runs that working tree:
  a container bind-mounting it, or WSL. `sh` reads the carriage return after `set -e` as part of the option
  name and the script dies on its first line.
- **The benchmark's own bookkeeping was inside the records it was ranking.** A memory's embedded text is
  built from its fact, tags, description and properties — key and value both — so every benchmark record
  carried `turn D3:1,D3:2,D3:3 speaker Caroline,Melanie statedOn 2023-06-27 turns 5` in its vector. That is
  how a result was joined back to the answer key, not something any deployment would store. It now lives
  outside the corpus.

- **A benchmark rung could be measured before its records were searchable**, scoring 0% for a corpus that was
  fine. An empty embedding queue cannot distinguish "finished" from "not enqueued yet", and only fast ingests
  were affected. The harness now waits until a search actually returns something.

## [4.0.1] — 2026-09-06

A patch for one defect: a schema rule the server would not run rejected every record it was supposed to check.

### Fixed

- **A schema pattern too risky to evaluate was reported as though your data were wrong, and it rejected every
  record of that type for ever.** The ordinary way to write *"one or more of these, comma-separated"* uses a
  repeated group — `^D[0-9]+:[0-9]+(,D[0-9]+:[0-9]+)*$`. The server declines to run a pattern that can
  backtrack exponentially, and said so by answering *"does not match"*: the same answer a value that genuinely
  failed produces. The schema was accepted when it was saved, and nothing anywhere said it had never been
  applied.

  **What to do if you have one.** Such a pattern is now refused when the schema is saved, on `namingPattern`
  as well as on a property, with a message naming the construct to rewrite — a character class usually does
  the same job (`^D[0-9]+:[0-9,:D]*$`). A pattern **already stored** now reports `pattern not evaluated, so
  nothing was checked`, which points at the schema instead of at a record that is correct.

  The safety check itself is unchanged: a stored schema still cannot hang the server on a hostile value.

### Added

- **The benchmark folder publishes measured results, not only a method** (`B-1`). It held a protocol written
  before any result existed and no figure anywhere.

  What is published is the tier that needs no model: for each question the turns the reference answer cites
  are known, a search is run, and the question asked is **whether the FIRST result held them**. Overlapping
  five-turn windows get the first answer right 50.8% of the time and put everything the answer needs into the
  top three 69.3% of the time, against 31.7% and 46.2% for one record per conversation turn. Strategies that
  lost are published beside the ones that won.

  **The ceiling is 85.9%, not 100%,** and the reason is stated rather than left to be discovered: 28 of the
  199 questions need evidence from two conversations weeks apart, which no single record can hold.

  **It is deliberately not the number other systems quote.** Those are end-to-end answering — did the system
  get the question right — and this is whether the evidence was retrieved, so the tier is named everywhere the
  figure appears. Nothing in the retrieval path was tuned to produce it, and the window shape used is the one
  written down before any result was read.

## [4.0.0] — 2026-09-05

**4.0 is the release where a link became a record.**

Until now, two records could only be related if both were entities: an edge's endpoints were entity ids, so a
memory, a timeline entry or a file could be *named* by something but could never be walked to. The arrays that
were supposed to express those relationships — `chrono.memoryIds`, `file.memoryIds`, `file.chronoIds` — were
stored and read by nothing.

Now a relationship is a record in its own right. A search that matches a memory is no longer a dead end: the
walk continues through what that memory names. Graph expansion follows links as well as edges, an edge can say
what KIND each of its ends is, and the scan that refuses a delete can finally see a reference from a memory, a
timeline entry or a file instead of only from another entity.

The six entries that describe it open **Added**, directly below. Everything else in this release is smaller
than they are.

**Breaking, and what to do about each.**

| what changed | what to do |
|---|---|
| `OLLAMA_URL`, `WHISPER_URL`, `WHISPER_MODEL` **refuse the boot** | rename to `VISION_BASE_URL`, `STT_BASE_URL`, `STT_MODEL`. A manifest written for 4.0 also runs on 3.x; one using the old names starts on 3.x and will not start on 4.0 |
| `POST /api/tokens` refuses `spaces`, `admin`, `readOnly` | send `rights`; the refusal names the replacement for each |
| a token with **no rights matrix reaches nothing** | nothing to do — every token gets one at mint, at boot, or per request. Listed because it removes a fallback, not because it should bite |
| `excludeFromVectorSearch` is gone | it is `suppressEmbeddings`, and has been since 3.1 |
| the **MCP SSE transport** is gone (`GET /mcp`) | use `POST /mcp`, recommended throughout 3.x |
| the two `syncSchedule` shorthands are gone | write real cron. An unrunnable schedule is now refused rather than ignored |
| the server-rendered setup form is gone, with `GET`/`POST /api/setup` | use the SPA, or `POST /api/setup/json` |
| a peer's retention stamp no longer sets **your** expiry | nothing to do. If records vanished earlier than your policy allows while syncing with a shorter-retention peer, this was why |

**Docs:** 31 files changed. A size-idempotent re-ingest should `--force` this tag rather than diffing a file
list.

### Added

- **A relationship can now point at any kind of record, not just an entity.** `from` and `to` on an edge take
  `fromKind` / `toKind` — one of `entity`, `memory`, `chrono` or `file` — on `POST /edges`,
  `PATCH /edges/:id`, `upsert_edge`, `update_edge` and both bulk doors. A photo's file record can point at the
  people in it, the party it was taken at, and what happened there.

  Omitting the kind means `entity`, so **every edge you already have is unchanged and nothing was migrated**.
  A file endpoint is the space-relative path rather than a UUID, because that is what a file's id is.

- **Three link fields that were stored but never read now work: `chrono.memoryIds`, `file.memoryIds` and
  `file.chronoIds`.** They have been accepted, validated and replicated since 3.x, and nothing walked them —
  a traverse from a memory did not reach the timeline entry that named it. It does now, on every space.

- **`recall`'s graph expansion follows links, not only edges.** Two records can be related by a stored edge or
  by the `entityIds` a memory, timeline entry or file carries. Expansion followed edges alone, so a space
  whose relationships are mentions — which is most spaces, because mentions happen automatically and edges are
  written deliberately — got an empty graph back from `recall(traverse: n)`.

  ```json
  { "traverse": { "depth": 2, "includeChrono": true, "includeMemories": true, "includeFiles": true } }
  ```

  **All three default to false, so no existing response changes.** A recall's answer is budgeted and a match
  is counted with its whole subtree, so anything admitted by default costs you matches. A linked node arrives
  with its `kind` and the fields that identify it, never file chunk text.

- **A search result that is not an entity is no longer a dead end.** A memory, timeline entry or file that
  matched came back with an empty graph at any depth, and both APIs told you to lift its `entityIds` out and
  traverse from those yourself. With the matching flag on, the walk starts from what the match names.

- **A space converted with `npm run links:convert` refuses array writes and points at the link door.** Sending
  `entityIds`, `memoryIds` or `chronoIds` to a write door answers `400` naming `POST .../links`, so one fact
  cannot be written two ways and then disagree with itself.

  **The fields are still read, stored and replicated — nothing you have is lost**, and a space you have not
  converted is untouched. Records arriving from a peer are never refused, and editing a record that still
  carries a legacy array works as long as the edit does not mention the array.

- **Converting is a speed upgrade, never a correctness prerequisite.** A converted space answers "what is
  related to this?" from indexed link records; an unconverted one keeps walking the arrays. Both answer all
  six link classes, so the three fields above work everywhere immediately.
- **Deleting a memory or a timeline entry can now be REFUSED, and this is the change most likely to reach a
  running script.** In a space with `strictLinkage` on, a timeline entry that lists a memory — or a file that
  lists either — blocks the delete with a `409` naming what refers to it. With `strictLinkage` off, deletes
  still always succeed.

  It always succeeded before because three of the six link fields had no reader, so the reference was stored,
  replicated and invisible — leaving the referring record pointing at something that no longer existed, which
  is exactly what `strictLinkage` is for. `delete_edge` is unchanged: links run from a record to what it is
  about, so nothing can point at an edge.

- **Deleting an entity can take its edges with it, behind a preview and a token.** A `DELETE` on an entity is
  still refused while edges connect it to something, and the refusal now names the way out: call
  `GET .../entities/:id/cascade-preview`, read exactly what would go, and repeat the `DELETE` with the
  `cascadeToken` it returns. `entity_cascade_preview` is the same capability for an agent.

- **A space can restrict which memory TYPES it accepts.** Declaring one or more `typeSchemas.memory` entries
  makes those the allowed set, exactly as it already did for entities, edges and timeline entries. A space
  that declares none still accepts any string, so this can only newly refuse a write where you explicitly
  declared types.

  Both memory type controls become a **select** where a space declares types and stay free text where it does
  not. The column filter still offers declared types plus the values actually present, so a record written
  before a schema change stays findable.

- **A brain says what version it runs, and one too old is refused rather than trusted.** Every instance reports
  its version over member gossip in both directions, and a peer below the required minimum is sent no data and
  accepted from for none. The refusal names both numbers — what the peer runs, and what is required — because
  the person who has to act on it is the operator of the *other* instance, reading it in their own log.

- **A file's metadata now replicates** — its description, tags, properties and the records attached to it. The
  bytes always travelled; what somebody wrote about a file did not, so a file linked to an entity on one
  instance showed the connection in the peer's graph and nothing in the peer's file list.

  Only the authored half crosses the wire, and the write **merges** rather than replaces: each instance keeps
  what it worked out from its own copy of the bytes — size, checksum, extracted text, search vector. A field
  the sender omits is left alone rather than cleared, so a peer on an older build cannot erase a description
  it has never heard of.

- **A file metadata record has a `seq`, which it never had.** It is the ordering primitive replication runs on.
  Its absence was also a live defect with nothing to do with sync: two writers appending to a file's entity
  list had nothing to order them, so one append could silently drop the other.

  Metadata written before 4.0 has none and does not reach a peer until the record is next written.
  `npm run links:convert` stamps what is already stored — idempotent, safe to run twice.

- **The divergence check covers a file's metadata, and only the authored half.** Cover nothing and two
  instances holding different descriptions report themselves identical. Cover the derived fields too and two
  instances that agree about everything anybody wrote diverge for ever over a size in bytes, which teaches an
  operator to ignore the warning. The check is advisory and blocks nothing.

- **Every model slot's call budget is operator-settable.** Only the document pipeline was configurable before.

- **The token list sorts on every column and searches on Label and Spaces.** Spaces sorts by reach rather than
  alphabetically: library-access tokens first, then space-restricted ones, then unrestricted.

- **"What is next to this?" is answered from one definition everywhere.** Five readers each followed a
  different subset of the six link fields — the standalone traverse, the walk inside `recall`, the scan that
  refuses a delete, the ER diagram, and the check sync runs on arriving records. The last had never adopted
  the shared module at all, so a record arriving from a peer had one link field checked instead of six. It
  still only records what it finds: sync ingest is validated, counted and let in.

- **The delete scan compares an edge endpoint's KIND as well as its id.** Matching on the id alone could block
  a delete because of an edge pointing at a different record that happened to share it.

### Changed

- **A request with no authenticated token is no longer read as an unrestricted legacy one.** An empty record
  used to resolve to full access.

- **A token with no permission grid reaches nothing**, on both APIs and at both the space check and the area
  check. There is no fallback left. Every token has a grid, so this should not bite.

- **BREAKING: an entity must have a type.** `POST /api/brain/spaces/:id/entities` refuses a create without
  one. The type selects the per-type schema, so a typeless entity is one nothing can validate.

- **BREAKING: `maxBytes` on `recall` and `find_similar` means bytes.** It counted characters. If you set it
  against a byte budget, it was letting through roughly twice what you asked for on non-ASCII content.

- **A relationship between two records is a record of its own**, in its own collection, written by every path
  that used to write one of the six arrays. `POST /api/brain/spaces/:id/links` is the door, on both APIs, and
  `npm run links:convert` turns an existing space's arrays into records.

- **`completeLinkage` on a space says its links are all records.** A LOCAL setting — never voted, never
  replicated — because it describes what this instance has converted.

- **An edge id is derived from what identifies the edge**, so two peers that independently create the same
  relationship now agree on its id instead of storing it twice. **Existing edges keep their ids and there is
  no migration.** Changing an edge's identity now moves it to the id that identity derives — so the call
  succeeds and your *next* request for the old id is a `404`.

- **An edge label can declare what kind of entity sits at each end, and how many.** A write that breaks the
  rule is refused rather than stored, and the refusal names the label and what it expects.

- **`recall`'s graph expansion is the real traverse**: it narrows by edge label and direction like the
  standalone tool, instead of following everything.

- **`/query` answers within a size budget**, like every other read path.

- **An update refuses what its create refuses.** Eight defects of one shape — a rule enforced on the way in
  and not on the way back. A create no longer silently discards a malformed field; a memory update checks
  that an entity EXISTS rather than only that its id is well-formed; changing an edge endpoint's kind
  re-resolves that endpoint; and a batch write stopped dropping four things its own documentation promised.

- **The refusal that blocks an entity delete now names the direction it checks**, and a `409` carries
  `references` alongside `backlinks` — everything found, rather than half of it.

- **A retention setting meant for timeline entries was accepted on every collection and applied to none.**

- **`ttlDays` works and always did** — the field to read it back was never the one it looked like.

- **A vector never crosses the wire.** A record arriving from a peer is embedded by the receiver with its own
  model. Ranking one model's vectors against another's does not fail; it returns plausible results in the
  wrong order.

- **A memory's and a file's embedding is built from its own content**, not from records it happens to name.

- **A plaintext peer URL is refused where it is ADDED**, on every door, rather than coming back as a `400`
  from the other instance.

- **The text-embedding API key no longer stays in `config.json`.** It moves to `secrets.json` (`0o600`) on
  first boot, like the other provider keys — `config.json` is the file operators copy, paste into issues and
  mount as a ConfigMap.

- **Three legacy env-var spellings are scheduled for removal at the next major** rather than now: breaking a
  documented env var to improve its spelling is not a worthwhile trade mid-series.

- **Four config migrations are permanent, not release tails.** They lift settings written under older
  spellings every time the config is read, and removing them would silently reset those settings.

- **The Search panel can do everything a `recall` call can**, shows the request it would send live with a
  Copy button, and lays every control out across the width instead of hiding some.

- **The README said 31 MCP tools. There are 44** — and it did not mention nine capabilities the product has.

### Removed

- **`POST /api/tokens` no longer accepts `spaces`, `admin` or `readOnly`** (breaking). Send `rights` — the
  per-space permission grid, which has been the real permission model since 2.6 and is what the Tokens page
  already sends. **Nothing changes in the interface.**

  Scripts that mint tokens with the old fields get a `400` naming the replacement for each: `spaces` →
  `rights.perSpace`, `admin` → `rights.instanceAdmin`, `readOnly` → `rights.floor` with read rungs.

  **A token with no permission grid now reaches nothing.** In practice every token has one — minted with it,
  or given one at boot, or derived per request for a login session — so this should not bite. It is listed
  because it removes a fallback that used to treat "no permissions recorded" as "all permissions".

- **The two `syncSchedule` shorthands are gone, and a schedule that cannot run is now refused** (breaking).
  Send cron: `"*/5 * * * *"`. **Nothing to do on upgrade** — a shorthand already in `config.json` is rewritten
  at boot to the expression it always meant, so an existing network keeps syncing at the same rate.

  The refusal matters more than the removal. `syncSchedule` accepted any string and answered `2xx`; if it did
  not resolve, the scheduler logged a line and carried on, so you could set a schedule, be told it saved, and
  have that network never sync again. Both doors now refuse with a `400` naming the format, and a shorthand's
  refusal names the cron it used to mean.

  **One case has no honest translation and is left alone:** a shorthand outside cron's range — `"every 90m"` —
  never resolved on any build, so a network holding one has been on manual sync since the day it was set.
  Those are named individually in the startup log rather than rounded to a schedule nobody chose.

- **`excludeFromVectorSearch` is gone** (breaking). It is `suppressEmbeddings`, and has been since 3.1 — the
  switch is unchanged, only the old name is retired. Sending the old name is now refused rather than accepted.

  **Nothing needs migrating.** Every write since 3.1 has used the current name, and the peer version floor
  added in this release keeps an instance old enough to only know the other one off the network.

- **The MCP SSE transport is gone** (breaking). `GET /mcp` answers `405` with `Allow: POST`. Use one
  `POST /mcp` per JSON-RPC call with an `Authorization: Bearer` header — the recommended transport throughout
  3.x. The `ythril_mcp_connections_active` metric is removed rather than pinned at zero, because a stateless
  transport holds no connections to count.

- **Three legacy media env vars are gone** (breaking): `OLLAMA_URL`, `WHISPER_URL`, `WHISPER_MODEL`. They are
  `VISION_BASE_URL`, `STT_BASE_URL` and `STT_MODEL`.

  **Setting a removed name STOPS THE BOOT rather than being ignored**, deliberately: ignoring it meant an
  instance captioning and transcribing against a built-in default while the operator believed their own
  setting was in force. A manifest written for 4.0 also runs on 3.x; one still using the old names runs on
  3.x and will not start on 4.0.

- **The server-rendered setup form is gone, with `GET`/`POST /api/setup`** (breaking). Use the web interface,
  or `POST /api/setup/json` for programmatic first-run setup — already the documented preference, and it
  returns the admin token as JSON.

### Fixed

**Permissions and tokens**

- **An administrator restricted to certain spaces could not create a token at all**, through the product's own
  Tokens page.
- **SECURITY: the two peer governance relays authenticated the caller and did not authorise them.**
- **Ten routes in the spaces router had no rights classification**, so their reach was enforced and their area
  was not.
- **The admin import wrote arbitrary documents with no validation and no embedding job**, so imported records
  were unsearchable.
- **A per-token rate limit above 300/min could not take effect, and the API said it had.**

**Sync**

- **A peer's retention schedule could delete this instance's records.** A record arriving by pull carried the
  sender's expiry, and the sweep acts on it — so an instance keeping data for a year, syncing with one that
  keeps a week, lost records after a week, with nothing logged on either side. There is no backfill: what was
  deleted is gone.
- **A record marked "never embed this" lost that mark when it synced**, so a peer embedded it and put it back
  into search results.
- **Every suppressed memory was silently deleted by sync, permanently.**
- **A memory's `type` was deleted whenever the memory arrived by push**, and a timeline entry lost the marks
  saying its description had expired.
- **A large file never replicated**, and a cycle carrying only file metadata never finished.
- **One duplicate relationship stopped a peer receiving any further edges, permanently** — and one duplicate
  key stopped a member syncing at all, reported as an unrelated error.
- **A record re-created after a peer deleted it could be refused for ever, silently.**
- **The divergence check reported every space with a retention policy as divergent**, so the one signal that
  means data is really missing was permanently false.
- **Three of the four single-record sync routes stored a peer's record without checking it**, and the one
  schema check that existed sat on the path a peer barely uses.
- **`sync_now` said it does not wait and that an unreachable peer is not an error.** Neither was true.

**Search, records and the graph**

- **A hard-filtered search returned fewer records than it could**, and a flag meant for finding similar records
  did not work.
- **A brain create accepted any field you invented and answered `201`.** A nested property was refused on
  create and stored on update; an update route dropped unknown fields silently; and a `warn`-mode space was
  told nothing about an edit.
- **`suppressEmbeddings` was honoured on exactly one write path and ignored on ten others**, and was silently
  dropped on create on all four record types. Turning suppression on now also removes vectors already stored,
  which is what it always claimed to do.
- **`maxBytes` counted characters** — the parameter, the refusal, the response field and the documentation all
  said bytes.
- **One traverse hop read every edge touching the frontier, with no limit**, on both APIs. The link scans were
  unbounded and unindexed, so following links from `recall` could be very slow, and a bounded scan could drop
  records while the answer claimed the graph was complete.
- **`graphNodes` counted nodes the caller never received.**
- **Timeline, memory and file links were silently missing from the graph view**, and tapping one of those nodes
  opened an empty panel with a blank name.
- **Merging two entities could move an edge onto an end its label forbids**, could write an entity its own
  space would have refused, and **emptied the survivor's face gallery**.
- **Changing a memory's type never validated against the new type.**
- **A property `default` did nothing at all**, and `propertySchemas` was documented as retired while being one
  of the most-read fields.
- **An entity referenced only by a file deleted cleanly**, leaving the file pointing at nothing.
- **A space that declared an edge-label allowlist would have lost its contradiction scanning.**

**Files, media and the interface**

- **A source preview could show one file's contents under another file's name**, and arrowing quickly through
  a folder of images could show the wrong one.
- **A queued upload went to whichever folder was open when its turn came**, not the one it was dropped into.
- **A folder whose listing failed showed the previous folder's files under the new folder's name**, and a
  folder that would not open said nothing at all.
- **Clicking a folder in the file tree listed that directory twice.**
- **A long audio or video file could be re-queued while it was still being processed.**
- **A mistyped `MAX_FILE_SIZE_BYTES` removed the media file-size limit instead of raising it.**
- **A stale `?space=` still moved the Brain page to another space**, and clicking a knowledge-type tab in any
  space but the first jumped back to the first.
- **A translation key defined twice used the wrong one**, and a mermaid diagram in a markdown preview rendered
  unstyled.
- **Every sortable table header in the app was lower-case**, alone among the tables.

**Configuration and operations**

- **Every start logged a warning about a repair that had already happened**, naming a retry that could not
  happen.
- **The same setting had two different legal ranges depending on which door it arrived through**, on nine of
  them.
- **Seven routes answered `5xx` and threw away the exception that caused it.**
- **Read-modify-write against `/api/admin/media-config` now works.**
- **A provider fallback ran two model calls inside one step**, and stall detection was told about only one.

### Security

- **A token with no permission grid reached every space. It now reaches none.**

  Two places decided what a token could see, and both fell back to the list of space names older versions
  used — treating an EMPTY list as *everything*. That list stopped being stored on tokens in 3.1, so it was
  always empty, so the fallback always meant unrestricted. The same fallback was then found in two more
  places, in the check that decides which *area* of a space a call may touch, on both APIs.

  **Nothing could reach it**, which is why it was never seen: every token has a grid — created with one,
  given one at startup, or built from its claims per request for a login session. That made it a branch
  nothing exercised, and one that would have handed over the whole instance if anything ever had.

  **You will notice nothing.** It closes a hole that could not be reached rather than changing what a working
  token can do.

### Internal

Nothing here changes what the product does. It is recorded because a reader deciding whether to upgrade is
entitled to know what moved underneath.

- **Documentation and internal correctness.** About forty corrections across eleven guide pages, where a page
  described behaviour the code no longer had. Thirteen rules this codebase states about itself were checked
  against the code and found false. Several source comments described their own fixed defects as still open —
  one instructing a future reader to remove a parameter that must never be removed.

- **The checks themselves.** A number of gates were passing while examining less than their titles claimed:
  hard-coded lists where the set should have been derived, assertions that could not fail, a gate that found
  its rows by number, and tracker checks reporting "all open items indexed" while twenty-five were not. A CI
  hook recorded as an intermittent flake for two days turned out to be a deterministic API error.

- **Large files were broken up.** The file manager's page became eight components and stores — preview, upload
  panel, metadata editor, extract view, directory listing, toolbar, tree — and the graph page, the file-upload
  route, the recall traversal and the network member row each moved out of the file they had grown inside.
  Characterization tests landed first in every case. Raising a file's size ceiling now owes a queued
  decomposition.

- **One definition instead of many.** The six replicated record types, the collection map, the record types and
  the knowledge types are each written once now rather than in nine, sixteen and several places. The four sync
  read routes became one function and four collection wipes became one.

- **The benchmark harness runs, and its first tier needs no model.** `benchmarks/harness/` fetches a pinned
  dataset, ingests it three model-free ways, retrieves, grades and reports, with the method fixed in
  `PROTOCOL.md` before any result existed. The measured floor is published in `benchmarks/README.md`;
  `INGESTION.md` describes how a conversation becomes records, written blind to the questions.

- **The release process gained the checks it was missing.** The GitHub Release for a large version is abridged
  rather than refused — GitHub caps a release body and this one exceeded it, which failed the publish after
  the images had already shipped. The 2.x and 3.x notes are archived, with a gate holding this file to one
  major series. These notes are grouped by subject, and a gate keeps one heading per kind.

- **The guideline sweep that gates this release is finished.** It re-checked everything merged since the
  previous audit against the places this project claims to be true — both APIs, both guides, the operator's
  pages, the project's own rules, and the checks meant to stop each going stale. Six rounds; only the first
  found something that had cost anything, and it is in **Fixed** above. The recurring pattern — a check whose
  title claims more than its body examines — is now written down as a rule of its own.

## Earlier releases

- [3.x](changelog/CHANGELOG-3.x.md) — 6 releases
- [2.x](changelog/CHANGELOG-2.x.md) — 17 releases
- [1.x](changelog/CHANGELOG-1.x.md) — 10 releases
- [0.x](changelog/CHANGELOG-0.x.md) — 18 releases
