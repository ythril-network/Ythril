# Changelog

All notable changes to Ythril are documented here. This file covers the **current major series**;
earlier majors are archived under [`changelog/`](changelog/) and linked at the bottom.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

> **THE NEXT RELEASE IS 5.0 AND IT BREAKS EVERY PUBLIC NAME.** Owner decision, 2026-09-15: *"break
> everything right away."* No aliases, no compatibility window, nothing built for 4.x. A peer below 5.0.0 is
> refused at the handshake with a `426` — `MIN_PEER_VERSION` derives from our own major — so a network
> upgrades together or not at all. Read the migration section of the 5.0 notes before upgrading one instance
> of several.

### Added

- **An AI assistant can save a picture, a PDF or anything else that is not text.** `write_file` takes
  `encoding: "base64"` alongside its existing UTF-8 default, which the REST upload had accepted throughout.
  Reported by the canary operator after one of their coding sessions was asked to put a photograph of a
  whiteboard on a record and could not: `write_file` is the only file-writing tool a write-capable token is
  offered, so a session reached through MCP could create a text file and could never create a byte file.

  **The ceiling is the request rather than the file store, and the schema says so.** A tool call arrives as
  one JSON body capped at 10 MB and base64 costs a third more than the bytes it carries, so about 7 MB of
  file fits; anything larger goes through `POST /api/files/{path}`, which takes a raw body and supports
  chunked upload.

  **Base64 that is not base64 is now refused on BOTH doors.** `Buffer.from` skips characters outside the
  alphabet rather than failing, so a `data:image/png;base64,…` URL used to be stored as a short, corrupt
  file under a `201` — with a plausible sha256 and a plausible size, and nothing downstream able to tell.
  The decode, the encoding vocabulary and that refusal are one module behind both doors.

- **A record's links and edges can be changed after it is created.** `linkEntities`, `linkFacts`,
  `linkChronos`, `linkFiles` and `edges` are now accepted on the UPDATE verb of every door that accepts
  them on create — `facts`, `chrono` and `entities`, on both surfaces — with the same meaning they have
  there: links REPLACE per class (`[]` detaches, a kind you do not name is untouched) and edges UPSERT.

  **Until now they were create-only, and on a converted space that left no way at all.** `entityIds` and
  its siblings were the workaround, and `array-write-refusal` refuses those outright once a space has
  been through the link conversion — so a record's relationships were settled the moment it was written,
  by either door, and the gap grew as spaces converted. The only way round was to delete and re-create
  the record, which costs its id and its history.

  **`edges` rides in the same body**, so an edge can be drawn or adjusted through the record it hangs
  off, on an update as well as a create.

  A body carrying only a connection field is a valid patch. It used to answer
  `400 "At least one field must be provided"` — the field was not in the update allowlist, so it was not
  rejected, it was not SEEN.

- **`filter` finds one file by `path`, and forgives how you spell it.** *(files only, both doors.)* The
  file-metadata list route always did — it ran the path through the same normalisation the store uses, so
  a Windows-style spelling and a leading slash both find `notes/a.md`. `filter` did not, and
  `filter: { path }` is a bare equality: a caller holding a path from their own filesystem got an empty
  page and a `200`, which reads exactly like "no such file".

  It is EXACT after the normalisation — not a prefix, not a substring. For those there is `search`, which
  also spans the description.

  **Sending both spellings is a `400` rather than one of them quietly winning.** `path` and
  `filter: { path }` are two ways to ask one question and only the argument is normalised, so together
  they would disagree — the same call `recall` made about its two filter grammars.

  This is what `B-9` step 3b needs before the file-metadata list route can go: deleting a forgiving read
  and leaving an exact one is the *route does work around the query* shape that step 3a already paid for
  once. **`includeChunks` deliberately did NOT move**: that is a default the route applies rather than a
  transform, a caller can write `filter: { parentFileId: { $exists: false } }`, and adopting it here would
  change what every existing `filter` caller gets back.

- **A schema type and each of its properties can now say what they are FOR, in prose.** `description` on
  a type schema (4000 characters) and on any property (2000) — stored, returned by `get_space_meta` and
  the space listing, editable in the Schema tab, and **never parsed**. The type already says a value is a
  number; the property note is where you say it is the retry BUDGET rather than the retry count, or that
  one record means one deployed instance rather than one repository.

  **It is deliberately prose rather than an ontology, and that is the whole decision.** Owner,
  2026-09-17, asking whether `F-24`'s semantic layer could be satisfied this way: the answer splits by
  who READS it. Everything whose reader is a model — what a type is for, which property carries meaning,
  whether two types in different spaces are the same thing — is satisfied by a sentence, and better,
  because it needs no vocabulary and cannot be wrong-but-parseable. Nothing whose reader is the ENGINE is
  satisfied by it at all: a query cannot widen to subtypes it cannot parse.

  So the engine-facing half — inverse pairs, transitivity, subtyping — is not built, and will not be
  until a named consumer changes behaviour because of it. **A vocabulary that nothing enforces looks
  machine-readable and is not**, which is worse than prose rather than a lesser version of it: shipping
  `transitive: true` while `traverse` ignores it is the documented-but-inert defect at the scale of a
  feature.

  The pattern is already proven one tier up — a SPACE carries `usageNotes`, and that is where the shared
  dev board keeps the runbook three parties read at handshake.

- **A chrono entry's `status` meant two different things, and which one you got was decided by the DOOR
  you read through.** The chrono list route returns the DERIVED status — `overdue` where a due moment has
  passed, unless the type's `whenDuePasses` says otherwise — while `filter` and sync return the value the
  collection holds. Both are correct, and a predicate read must see the stored one or it cannot be used
  to repair anything. What was wrong is that the two were indistinguishable from outside.

  Reported in substance by the canary operator, 2026-09-15, after a fortnight-old episode read `active`
  through one door and `overdue` through the other: *"'I checked the status' is not a claim anyone can
  evaluate without the door being named"*. Every attempt they made to confirm the suspicion queried the
  collection, got `active`, and read as a clean bill of health. It degrades rather than breaking, too —
  a record read shortly after it is written still says `active`, so code built against the stored literal
  works the day it ships and starts failing only as records outlive their due moment.

  `filter` takes `deriveStatus` now, on both doors, **defaulting false** — so every existing caller sees
  exactly what it saw before, and the client asks for `true`, so the Brain page is unchanged too. Nothing
  moves for anybody who does not ask. Sending it on any collection but `chrono` is refused rather than
  ignored: a silently dropped flag is a caller who believes they asked for something.

  It is the same derivation the list route uses, not a second one — `whenDuePasses` makes "what a passed
  due moment means" a per-TYPE decision, and a copy of that rule would be a second answer to it. Proved
  against a live instance on both doors, including that `deriveStatus: true` and the list route agree
  about the same entry, which is the condition for ever retiring that route.

  **And the operator page now says the status it shows is worked out rather than stored**, because that
  is the half an operator meets: a backup or an export reads what was stored, so an entry the page calls
  overdue reads as active there.

- **`filter` returned an edge as two bare UUIDs, and a file with no job progress.** Two of the nine
  per-collection list routes do work on their rows AFTER the query, and the one call meant to replace all
  nine did neither: `GET .../edges` resolves both endpoints' display names — batched by endpoint KIND,
  because an entity's name is `name`, a chrono entry's is `title` and a fact's is `fact` — and
  `GET .../files` joins the embedding job's step progress for rows still in flight. `filter` now does
  both, on the tool and on `POST /api/brain/filter`, through one module.

  **A decoration is not a parameter, which is why nothing had reported this.** It appears in no body
  allowlist, no `inputSchema` and no capability map, so the two doors were never compared. The retirement
  of those routes would have taken both with them silently — an agent reading edges would have started
  getting ids where a browser gets names, and the Files tab would have shown a stage indicator that never
  resolves.

  **`includeDiagnostics` was the third, and it was refused rather than ignored.** Four list routes honour
  it; `filter` accepted it nowhere — a `400` on the route, an `additionalProperties` refusal on the tool.
  It is accepted and APPLIED on both doors now, defaulting false on each. Admitting it without wiring the
  projection would have been the worse half: a `200` with the flag doing nothing.

  **The file join moved out of a route file to make this possible at all.** `attachJobProgress` lived in
  `api/brain/file-meta.ts`, and a `brain/` module may not import from `api/` — so no amount of care in
  `filter` could have reached it where it was. It is `files/file-job-progress.ts` now, with its own gate
  asserting exactly one declaration.

- **An agent could not ask for "facts tagged release", and a browser could.** `filter` took a MongoDB
  predicate and knew nothing else, while the nine per-collection list routes it is meant to replace have
  always accepted five conveniences: `tag` (a case-insensitive SUBSTRING over the tag array, so `rel`
  finds `release`), `type`, `description` (that column only), `properties` (a value scan) and `search`
  (freetext over the collection's own text fields). Both doors were present and one accepted less, which
  is the half of the parity rule that hides — and it hid here for as long as the capability map paired
  the tool with the routes and called the pair answered.

  All five are arguments of `filter` now, on the tool and on `POST /api/brain/filter`, in the same
  change. `filter` itself is no longer REQUIRED: narrowing by tag alone used to mean sending
  `filter: {}` to say "and no predicate", which is a shape you have to be told about.

  **They are assembled by one module, and that is the point rather than tidiness.** The same four-line
  sequence existed five times — `buildFactFilter`, the entities route, `listEdges`, `buildChronoQuery`
  and the file-meta route — each reading the same names into the same three primitives. `filter` would
  have been the sixth, which is how the browser and an agent come to disagree about what `tag` means.

  **The guard the module carries could not have survived a hand-written copy.** The old assemblies
  merged the freetext `$or` by assignment, which is safe only because none of them has a caller-supplied
  predicate to collide with. `filter` does: a caller passing `{$or: [...]}` beside `search` would have
  had their disjunction silently REPLACED by ours — no error, no log, a plausible answer over the wrong
  set. Everything accumulates under `$and` now, asserted against a live instance on both doors.

  **`links` refuses rather than ignoring.** It is a pair of ids, with no tags, type, description or text
  of its own, so `search` there would have matched every link in the space — and a filter that matched
  everything is indistinguishable from a filter that was ignored. Both doors answer with the same
  refusal naming the collection. Same shape as the `links` sort crash fixed earlier this release: the
  answer lives in the function that RECEIVES the collection, not at a call site.

- **`filter` takes `entityName`, `fromName` and `toName`.** They were REST-only, so an agent could not ask
  for “facts about Alice” by name — it had to filter entities, take the ids, then filter facts, and on a
  proxy space the ids differ per member. They are a JOIN rather than a predicate, which is why no Mongo
  filter a caller writes can express them. Refused on a collection they cannot mean rather than ignored.

- **`space_reembed` — the embedding backfill now has a tool.** `POST /api/spaces/:id/reembed` has queued
  embeddings for records with no vector since 4.4, and had no MCP counterpart. It is also
  `POST /api/space_reembed`, takes `kinds` and `limit`, and returns the same counts the route does.

  **It was invisible rather than forgotten, which is the part worth reading.** The capability map paired
  that route with `space_reindex` and the parity gate reads the map, so a REST-only capability was recorded
  as covered — inside the file built to end exactly that. The two do opposite things: `space_reindex`
  re-embeds EVERY record with the configured model and returns as soon as the job starts; `space_reembed`
  touches only records with no vector, is awaited, and the counts are the answer. A map keyed on which
  DATA a door touches cannot tell those apart; the question is what makes a pairing true.

### Changed

- **The graph guide's `Links` section is its own page, `04g-links-api.md`.** `04b-graph-api.md` sat on the
  900-line cap, and the last three changes to it each ended in compressing a paragraph to make room —
  which is the cap doing its job and being answered the wrong way. Links is a distinct capability with its
  own conversion story, its own pre-flight and its own lifecycle, so it is the boundary.

  Every line was MOVED by line range, never retyped, and the move asserts a conserved multiset of prose
  lines — an earlier hand-split of this guide lost a twenty-line block mid-word and shipped the remains
  for months. Nothing was reworded. The `## Links` heading is kept, so an inbound `#links` anchor still
  resolves; `#traverse-graph`, which `04a` links to, stays on the graph page.

- **A token that reaches exactly ONE space no longer has to name it.** `space` is optional on every
  writing tool when the calling token's accessible-space list has one member — `save_fact({fact: "…"})`
  lands. With two or more it stays required, and the refusal lists the spaces you can choose between.

  **`space`'s enum was already narrowed to what the token reaches**, so with one member there is no other
  space the call could mean. Requiring it there bought no safety and cost every caller who did not read
  the schema — which is every GENERIC client, because a generic client matches a tool by name and fills
  the parameters it recognises. `B-6` came from reading one: it sent `save_fact({content})`, was refused
  for a missing `space` it had no way to know about, and the run then stored nothing, searched an empty
  space and scored about zero **with no error anybody saw** — the harness swallows its own reset failure
  and one 400 goes into a log nobody reads.

  **The schema you are SHOWN says so**, per token: `space` is absent from `required` for a single-space
  token and present for every other. Advertising and enforcement come from one materialisation, so a
  caller cannot be told to send something they need not, or told they may omit it and then refused.

  **A READ did not move.** `recall`, `filter` and `similar` treat an omitted `space` as *every space this
  token can reach* — an answer rather than a default — and folding the two would turn a cross-space
  search into a single-space one the day a token gained a second space.
- **Every Brain tab reads through `filter` now, which is what the nine per-collection list routes were
  waiting on.** Facts, Entities, Edges and Chrono all issue one `POST /api/brain/filter`; the service
  re-keys `results` to the key each tab already destructures, so **not one caller changed** and deleting
  those routes becomes a server-only change.

  It took four preceding fixes to be possible at all, and each was a gap that would have changed what a
  tab shows: `filter` had none of the five list CONVENIENCES, none of the two DECORATIONS those routes
  apply after the query, a silent page clamp of 100 where they serve 200 or 500, and a chrono `status`
  that matched the stored value while the route matched the derived one.

  **What the client sends is arguments, not rules.** The fuzzy things — `tag`, `search`, `description`,
  `properties` — go as conveniences the server assembles; the exact ones — an entity's `name`, a fact's
  `entityIds`, a chrono tag set or date range — go as plain predicates. The line matters: a RULE written
  twice drifts, and a second copy of the substring-and-scan logic in the browser is the thing this whole
  row exists to avoid.

- **`filter` silently returned 100 rows to a caller who asked for 200.** `limit` was clamped, not
  defaulted — so a page came back short and `total` with `truncated` made it read as a correct short
  page. It matters because `filter` is replacing the nine per-collection list routes, which serve 200
  (`edges`, `files`) and 500 (`facts`, `entities`, `chrono`): the replacement returned LESS than every
  door it replaces, and those three did not agree with each other either.

  Owner, 2026-09-17: *"cap should be a parameter and default to 200"*. `limit` is that parameter on both
  doors, it defaults to **200**, and there is no maximum. The MCP schema carries no `maximum` for the
  same reason `windowDays` carries none: the dispatcher enforces the schema before the handler, so one
  would refuse a page the REST door serves.

  **What bounds an answer now that a row count does not** — and none of it is new, which is why the
  clamp was never the protection:

  | | |
  |---|---|
  | the byte budget | `maxChars` / `maxBytes` trims the page, says `truncated`, and hands back `nextSkip` |
  | `maxTimeMS` | hard-capped at 10 000, so an absurd `limit` is bounded in time |
  | a PROXY space | `skip + limit` past the merge ceiling is an explicit `400` naming the limit |

  So an oversized request is refused out loud on a proxy, bounded in time on a single space, and trimmed
  with disclosure either way. The clamp added nothing those three do not do, and hid the one thing they
  all report.

- **BREAKING — `POST /api/brain/recall` returns the same result SHAPE as the MCP tool.** A hit is
  `{score, spaceId, type, record: {…}}` — the ranking beside the record rather than mixed into it. REST
  returned one FLAT object until now.

  ```json
  { "score": 0.86, "spaceId": "work", "type": "fact",
    "record": { "_id": "…", "fact": "…", "tags": ["…"] } }
  ```

  **This was a divergence with nothing behind it.** `RECALL_ENVELOPE_KEYS` existed only to stop a
  `projection` on the flat door eating the `score` the caller searched for; with the record in its own
  object the distinction is structural and needs no list. The two shapes are also not mechanically
  inter-convertible — `toRecallRecord` puts an entity's own type under `record.type` while the envelope
  `type` is the knowledge type — so a door translating between them would have to reimplement the mapping,
  which is what collapsing the route removed.

  **What to change:** read `hit.record.<field>` where you read `hit.<field>`. `score`, `spaceId`, `type`,
  `_graph` and the per-stage scores stay where they were. Traversed neighbours under `_graph` are
  unchanged — they were already `{edge, node, paths}`.

  **And it fixes something rather than only costing.** The flat envelope put the knowledge type and the
  record's own `type` under one key, so an entity matched by `filter: {type: 'message'}` came back reading
  `type: 'entity'` with its real type unreachable. They are `type` and `record.type` now.

  **`unrecognized_keys` is not on this route's 400 any more.** It came from `unknownBodyFields`, which a
  route uses when it parses its own body; the refusal now comes from the shared dispatcher, which names the
  offending key in `error` (`unexpected property 'topk'`). The other read routes are unchanged.

- **BREAKING — the fresh-write scan honours `filter` and `tags`, and it did not.** The scan adds records
  the vector index has not ingested yet, and it added them without applying the caller's predicate: a
  recall with `filter: {"type": "note"}` could return a record whose type is not `note`, at `200`. It was
  survivable while the scan was opt-in behind `includeFreshWrites`, because combining that flag with a
  filter was rare; making the scan unconditional made it the common case, which is how it was found. A
  filtered recall now excludes non-matching fresh records, as it always claimed to.

- **BREAKING — three recall parameters renamed or removed.** 5.0 breaks every public name, and these three
  were each lying in their own way.

  | before | after | why |
  |---|---|---|
  | `includeFreshWrites` | **gone — the scan always runs** | the name read as *exclude recent records*, which is not what it did and not something anybody wants. Measured: a plain recall answered `count: 0` for **three seconds** after a write, then found the record. The cost of always scanning, on a space with 220 records inside the window: 91–101 ms against 159–167 ms, and nothing at all on a quiet space. Owner: *"if checking the parameter takes >10ms remove the parameter and just always do it."* A flag whose only function is to let a caller opt into a blind spot is not a performance feature |
  | `includeContent` | `includeFileContent` | it gates one field on one record kind — a file chunk's `content` — and nothing else. Read as a general switch it looked like the way to trim a large answer; that is `projection` |
  | `charsPerToken` | **gone — the ratio is fixed at 3.5** | it did nothing unless `maxTokens` was also set, and what the override bought was the ability to make an estimate differently wrong. A caller who needs the ceiling exact states `maxChars`, which is the unit the budget is applied in |

  All three are unknown fields now, so a caller still sending one gets a `400` rather than silence.

- **`POST /api/brain/recall` holds no implementation.** It was four hundred lines answering the same
  question as the `recall` tool, kept in step by somebody checking both every time either changed — and
  they had already drifted where nobody was looking (the byte budget, above). It hands its body to
  `callTool` now and translates the envelope back, which is what every door is supposed to be. The response
  shape is unchanged; `POST /api/recall` still returns the tool envelope.

- **The filter sanitizer is its own module.** Owner: *"add the sanitizer and make it a real module."* The
  operator refusals and the ReDoS guard lived in `brain/query.ts` beside the query builder that happened to
  be their first caller, while the key-shape guard for the other filter grammar lived in `brain/filter.ts`
  — one rule, two files, each grammar protected by a different subset of it. `brain/filter-sanitizer.ts`
  answers the whole question for every door, and is where value coercion will go when it arrives.

- **BREAKING — every tool is `POST /api/<tool-name>`, and both doors call ONE function.** Owner,
  2026-09-16: *"create modules that are used by both doors"*, then *"this shared module concept for both
  doors should be applied to each and every tool"*.

  ```http
  POST /api/recall
  { "space": ["work", "research"], "query": "quarterly targets", "limit": 5 }
  ```

  The body is the tool's arguments exactly — the same JSON you would send over MCP, `space` included. One
  envelope comes back for every tool: `{ok: true, text, data}` on success, `{ok: false, error, data}` on a
  refusal, with `error` word-for-word what MCP puts in `content`.

  **It is one route, not forty-five.** `mcp/call-tool.ts` now holds everything between *a caller named a
  tool* and *the tool answered* — the visibility gate, the space parse, existence, reach, the per-space
  rung, the space-admin grant, argument validation against the published schema, the throttle, the error
  classification and the audit entry. The MCP dispatcher and the HTTP route are translations of their own
  envelope into it and back. A tool added tomorrow is reachable both ways on the day it is written, because
  there is no per-tool code on either door to forget.

  **Two real defects fell out of the extraction**, both the same shape — one rule, two implementations,
  the weaker one deciding:

  - **The rung was checked against the FIRST named space.** Since space lists landed, a three-space
    `recall` over MCP was authorised against one of the three and read all three. The REST body-scoped
    guard checked every one. The check is inside the per-space loop now.
  - **The destructive-call throttle only existed on REST.** `bulkWipeRateLimit` was express middleware, so
    a browser was held to five wipes a minute and an agent to none. It is declared by the tool
    (`heavy: true`) and enforced in the shared function, before the gates — a caller getting it wrong in a
    loop is slowed down too.

  **`ythril_mcp_tool_calls_total` is renamed `ythril_tool_calls_total` and gains a `door` label** (`mcp` or
  `rest`). It was about to start counting browser traffic under a name that says MCP, which an operator
  reading a dashboard has no way to notice. `door="mcp"` is the old question, still answerable.

  The older REST routes are unchanged and still work. They are the shapes this replaces.

- **BREAKING — emptying a space is `POST /api/delete_space_data`, and both doors call one module.**

  ```json
  { "space": "work", "confirm": true, "types": ["facts", "chrono"] }
  ```

  It was FIVE routes — `DELETE /api/brain/spaces/:spaceId/facts` and one each for entities, edges, chrono
  and files — against one MCP tool taking `types[]`. Different parameters, different response, and
  different safety: the routes demanded `confirm: true` and the tool demanded nothing.

  **They also did different things.** The routes called `bulkDelete<Collection>` directly while the tool
  asked `planSpaceWipe` first — so on a space belonging to a network, **the tool opened a vote and the
  routes deleted shared data immediately.** Nothing reported it, because each door did exactly what its own
  code said. The capability now lives in `spaces/delete-space-data.ts` and both doors are adapters over it,
  so the governance step is not something either can forget.

  `confirm: true` is required on both doors now, and the route is named after the tool with `space` as a
  body parameter — the shape the rest of the REST surface moves to.

  **Two things the collapse changed that are worth knowing before you upgrade:**

  - **Emptying a collection no longer writes a tombstone per record.** The five routes did; the tool never
    has, because on a space belonging to a network it opens a governed round instead and every member
    wipes — so there is nothing for a peer to offer back. On a space in no network there is no peer. The
    tombstone-writing path had no caller left and is deleted rather than kept warm.
  - **Wiping entities unlabels every face, on both doors.** A face descriptor is a file-meta record
    carrying `faceEntityId`, and that cascade lived in the ROUTE — so the door being kept was the one
    without it, and `types: ["entities"]` would have left every labelled face pointing at a person who no
    longer exists. It is inside `wipeSpace` now, where neither door can drop it.

- **Removed: the metadata-only file delete.** `DELETE /api/brain/spaces/:spaceId/files?path=` purged a
  metadata record without touching disk. Every file has metadata and `deleteFileCascade` removes both, and
  the orphan case — a record whose bytes went missing out of band — is already handled by the file delete,
  which answers `204` when it finds one. It was a second door onto half of one act, and the half it could
  do alone left a file with no metadata.

- **BREAKING — space administrator is a rung you GRANT, and four admin rungs are no longer it.**

  ```json
  { "spaceAdmin": { "floor": false, "spaces": ["work"] } }
  ```

  It used to be derived: `admin` on all four areas of a space WAS administering it. Two things were wrong
  with that. The capability could not be granted in one action — the canary operator asked twice — and the
  equivalence is false: holding every DATA rung is not authority over the space's tokens and settings, so
  the derivation handed the space's token surface to any token that happened to hold four rungs.

  | | |
  |---|---|
  | `spaceAdmin` | ⟹ `admin` in all four areas of that space |
  | `admin` in all four | ⟹̸ `spaceAdmin` |

  **Nothing can disagree, for a better reason than before.** The grant is an INPUT to `grantedRung`, the
  single funnel every per-space rung resolves through — not a second opinion checked beside the rungs,
  which is what an earlier decision rejected a flag for.

  **Two scopes, like everything else in the matrix.** `spaces` names them; `floor` reaches every space
  including ones created later. The floor form exists because a real configuration needs it: a token
  administering every space holds no per-space rows at all.

  **Nobody is stranded.** A boot migration writes the grant for every token that held all four — under the
  previous rule those tokens WERE administrators, and an upgrade is not the moment to reinterpret that. A
  floor of all-admin migrates to the floor form, never to a list of the spaces that happen to exist today.

- **`delete_space_data` asks what its REST routes ask.** It carried `admin: true` — instance admin — while
  the wipe routes need admin on the space in the path, so a space's administrator could empty it over REST
  and was refused over MCP.

- **`help()` told every caller the two doors reach the same things, and that was false in twenty-two
  places.** `REST_ONLY_CAPABILITIES` was empty, its own comment called the emptiness *"the finished state
  rather than an oversight"*, and the gate guarding it asserted both halves of every row — so with zero
  rows it asserted nothing, for ever.

  The list now names what is actually missing: **network governance** (create, join, fork, invite, manage
  members, read the sync history, and cast a **vote** — an agent can belong to a governance process it
  cannot take part in), **a file's original bytes** (`read_file` returns extracted text, which is right for
  a document and wrong for a PNG), **the media embedding queue** (`retry_embed_media` can retry what no
  tool can list), **the per-type schema write**, and **the rights catalogue**.

  **What replaces the empty list is a derivation.** The build enumerates all 222 mounted routes and fails
  unless each is answered by a named tool, declared here, or classified as something an agent would never
  call — with the reason. A route in none of the three fails, so "I did not think about MCP" is no longer
  expressible, and the published capability table is generated from the same classification a gate holds
  true.

  The README claimed *"every capability is on both doors… the exemption list for that check is empty"*. It
  now claims what the build can keep: nothing is missing **silently**.

- **`space` takes a LIST on `recall`, `filter` and `similar` — both doors.** Naming three of your twelve
  spaces used to mean three calls and a merge, or reading all twelve and paying for the nine you did not
  want. The byte budget is spent before a client-side merge, so that second option dropped results it never
  showed you.

  | you send | you get |
  |---|---|
  | `"space": "a"` | that space, as before |
  | `"space": ["a", "b"]` | exactly those, proxies expanded, deduplicated |
  | `"space"` omitted | every space the token can read |
  | `"space": []` | **refused** — an empty list is not "all" |

  **One named space you cannot reach refuses the whole call**, and the message names which. Filtering it
  away would answer with fewer results, and a caller cannot tell a filtered answer from a small one: "three
  matches" reads as *there are three* rather than as *you may not see the rest*. Omitting `space` still
  filters, because a caller who named nothing asked for whatever they can see.

  **Only the search family takes a list.** Every other tool acts on one space, and is handed a list it
  refuses rather than using the first entry — being told a write succeeded in a space you did not mean is
  worse than being told the tool takes one space.

- **A space's collection name is built in one place, and that place refuses an id it cannot vouch for.**

  Every per-space collection is `{spaceId}_{suffix}`, and 298 call sites built that string by hand. They now
  go through `spaceCollection(spaceId, part)`, which carries the check a template literal cannot: a space id
  must match `^[a-z0-9-]+$`, because `_` is the separator and three operations select a space's collections
  by that prefix — one of which DROPS them. An id containing `_` would make one space's collections carry
  another's prefix, so deleting `work` would take `work_archive`'s data with it.

  **Four collections turn out never to have been mapped at all** — `_file_tombstones`, `_media_jobs`,
  `_link_violations` and `_file_hashes` — alongside six more that were spelled out at every call. Nothing is
  renamed and no data moves; this is where the name comes from, not what it is.

- **BREAKING — the knowledge type `memory` is now `fact`, everywhere, and 5.0 does not accept the old word.**

  | was | is |
  |---|---|
  | `remember`, `update_memory`, `delete_memory` | `save_fact`, `update_fact`, `delete_fact` |
  | `POST /api/brain/spaces/:id/memories` | `POST /api/brain/spaces/:id/facts` |
  | `<space>_memories` | `<space>_facts` |
  | `recordTtlDays: { memory }`, `memory.created` | `recordTtlDays: { fact }`, `fact.created` |
  | `ythril_memories_total` | `ythril_facts_total` |

  **The six array fields keep their spelling.** `memoryIds`, `includeMemories` and `chrono.memoryIds` are
  replicated and merkle-hashed, so renaming them is a wire break this release did not take. A link's synthetic
  edge LABEL does move, because its first half is the kind: `memory.entityIds` is now `fact.entityIds`.

  **Three boot migrations run once, automatically, and there is nothing for an operator to do** — but read
  what they cover, because every failure they prevent is SILENT and none of them would appear in a log:

  | migration | what it moves | what happens without it |
  |---|---|---|
  | `db/rename-memories-to-facts.ts` | `<space>_memories` → `<space>_facts`, and `memory.*` webhook subscriptions | a space reports zero facts while holding thousands, because reading a collection that does not exist is an empty result |
  | `config/migrate-memory-to-fact.ts` | `recordTtlDays: { memory }` → `{ fact }` | the retention window is unread, so those records are kept for ever |
  | `db/rekey-memory-kind-to-fact.ts` | the `_id` of every edge and link, plus tombstone types and queued embed jobs | a fact's connections match no query; a peer hits the unique index; a deletion is never served; a record never enters search |

  Each is idempotent, and each REPORTS a conflict rather than guessing: two collections with the same name,
  or an id another row already holds, are logged and left for a human. Watch the boot log once on the first
  5.0 start — a `WARN` there is the only case that needs you.

- **BREAKING — three tools fold into others, and the MCP surface is 45 rather than 48.**

  | gone | use instead |
  |---|---|
  | `er_model`, `GET /api/brain/spaces/:id/er-model` | `space_meta` / `GET /api/spaces/:id/meta` — the same answer arrives as `actualSchema` |
  | `find_entities_by_name`, `GET …/entities/by-name` | `filter` with `collection: 'entities'`, `filter: { name }` |
  | `list_chrono` | `filter` with `collection: 'chrono'`. `GET …/chrono` is UNCHANGED |

  **The `er_model` fold gains something neither half had.** `actualSchema` comes back in the DECLARED
  schema’s own format, so a type a space really holds can be **promoted into its declared schema** without
  the JSON being written by hand. They were always two answers to one question — a space can declare twenty
  types and hold three, or hold records of a type nobody declared — and a caller needed both to know either.

  **`list_chrono` was the only list TOOL any record type had**, while every type has a REST listing. Removing
  it makes the surface consistent rather than poorer, and its REST route is untouched. Every parameter it
  took is expressible — `status`/`type` as equality, `tagsAny` as `$in`, `after`/`before` as
  `startsAt: {$gte,$lt}`, and `search` as `$or` of two case-insensitive `$regex` — verified against the
  operator allowlist rather than assumed. The cost is four lines of predicate where there was one word.

  **And two documented blind spots stopped existing rather than moving.** `list_chrono`’s `after`/`before`
  filtered when an entry was WRITTEN, on a tool full of dates; `find_entities_by_name` was exact and
  case-sensitive, so an empty list did not mean the thing was absent. Both were warnings about a predicate
  the wrapper hid. In `filter` the caller writes the predicate, so there is nothing left to warn about —
  which is the general case: every hidden predicate is a blind spot somebody has to be told about in prose.

- **BREAKING — every remaining MCP tool is renamed to the verb-first scheme.** 23 of them, on top of the
  search family that moved with its routes. No aliases: the old names are gone.

  | | |
  |---|---|
  | create or update a record | `save_fact`, `save_entity`, `save_edge`, `save_link`, `save_chrono`, `save_space`, `save_bulk` |
  | edit one by id | `update_fact` (was `update_memory`) |
  | delete | `delete_fact`, `delete_entity_preview` (was `entity_cascade_preview`), `delete_space_data` (was `wipe_space`) |
  | graph actions | `graph_traverse`, `graph_merge`, `graph_link_preflight` |
  | the space | `space_stats`, `space_meta`, `space_reindex` |
  | schema, federation, embedding | `schema_update`, `network_peers`, `network_sync`, `retry_embed_record`, `retry_embed_media`, `retry_embed_file` |

  **What a caller changes: the tool name, nothing else.** No parameter, default, cap or refusal moved.
  `delete_space_data` is the one worth reading twice — it was `wipe_space`, and the new name says what it
  removes rather than what it does.

  **Audit operations follow the tools**, so a log filter on an old operation name stops matching. The
  exported constants follow too: a `delete_memoryTool` exporting a tool named `delete_fact` is a trap for
  the next reader.

  **Three names were NOT swept, deliberately.** `remember` is also a brain function, `traverse` is also
  recall's `traverse` BODY FIELD — including its entry in the allowlist — and `reindex` is also a route
  segment. A blanket rename would have removed a documented parameter from `RECALL_BODY_FIELDS`, so every
  caller sending `traverse` would get a 400 naming a key the guide tells them to send. Measured before
  applying: of seven `'traverse'` sites in the server, two are the tool.

- **BREAKING — the search family is renamed and drops the space from its path.**

  | was | is |
  |---|---|
  | `query` — `POST /api/brain/spaces/:spaceId/query` | **`filter`** — `POST /api/brain/filter` |
  | `find_similar` — `…/find-similar` | **`similar`** — `POST /api/brain/similar` |
  | `recall` — `…/recall` | `recall` — `POST /api/brain/recall` |

  `query` was the collision worth removing: it is the word every caller reads as *search*, and ours is the
  structured-predicate door — so a client reaching for meaning-ranked results picked it and got a 400 for a
  missing `collection`. `recall` keeps its name because it is what every memory protocol calls this.
  Audit operations follow: `brain.filter` and `brain.similar`, so a log filter on the old strings stops
  matching.

  **The space is a body field on all three, and you may omit it.**

  Omit it and the search runs across every space the token holds `knowledge: read` in, ranked together. A
  `traverse` keeps its path deliberately: it walks FROM an entity, and an entity lives in exactly one
  space, so there is nothing to omit.

  **`crossSpace` on `find-similar` stays, and checking why is the interesting part.** Its comment said it
  existed only because the space was in the PATH and "omit the space" could not be expressed — which this
  change would have retired. It does not, because on that route the space says where the SEED ENTRY lives
  rather than where to search. "The entry is in Research, find similar records everywhere" is a real
  request and omission cannot express it, because omitting the space stops pinning the entry too.

  A path segment cannot be omitted, so the old routes could never express "search everything I can reach" —
  MCP's `recall` has taken an optional space since it shipped, and REST callers had to point at a proxy
  space or make one call per space and merge the rankings by hand.

  **What a caller changes:** move the space out of the URL and into the body as `space`, or leave it out.
  A space you cannot read is skipped, not an error; a space you NAME and cannot read is a 403.

  **Authorisation happens once, and this is the part that needed building.** Every row in the rights
  inventory was `scope: 'path'` or `scope: 'iterates'` — nothing had ever authorised on a space read out of
  a body. `requireBodyScopedSpace` resolves it, checks the area and rung, and hands the handler the
  authorised list; the handler never reads `req.body.space` again, because acting on a second reading of a
  field is a vulnerability that no diff shows, the two readings being spelled identically. Where the caller
  names a space, not holding the rung there is a refusal. Where it names none, the spaces it cannot read are
  DROPPED rather than the call being refused — the path guard's all-or-nothing rule would have killed a
  cross-space search because some space the caller never asked about exists on the instance.

  **The audit log still says which spaces were read.** Its `spaceId` comes from a path match group, so this
  move would have logged `null` for every recall — a hole in the one record that answers "who read what". It
  now falls back to the spaces the guard AUTHORISED, never to the body, because an audit trail that
  disagrees with what happened is worse than one that says nothing. A cross-space read logs `a,b,c`.

- **A recall answer now spends the byte budget on what was remembered, not on where it is filed.**

  `maxChars` is a contract: it is how much of their context window a caller is willing to give to memory.
  Measured on a real corpus, **30% of what came back was content** — 3,314 characters of JSON carrying 986
  characters of remembered fact. The rest described the record's place in the store.

  Two rules, and only one of them is a choice. **An empty collection is never sent**: `"tags":[]` and
  `"properties":{}` say nothing their absence does not, and no caller can tell the difference — so that
  needs no flag and takes nothing away. **Storage bookkeeping is opt-in** through the new
  `includeRecordMeta`, default false on both doors: `createdAt`, `updatedAt` and the link-id arrays.
  Together they cut a response by about a third, and the space goes back to the caller as more evidence
  inside the same budget.

  `createdAt` is the one worth calling out: it is when the RECORD was written, not when the remembered
  thing happened. That lives in the record's own properties, put there by whoever stored it, and the two
  are routinely confused.

  Nothing a question is answered from is affected — the text, the properties, the id, the type and the
  scores all stay, and a gate asserts it. It applies recursively, so a `traverse` answer is trimmed at
  every depth, which is where the bytes actually are.

- **Two doors trigger a sync, and each one now says what it acts on.**

  `POST /api/networks/:id/sync` is the network door and has gained what the other route had: `?wait=true`
  and `?timeoutMs`. It also stops answering a bare `{ ok: true }` that said nothing about what happened —
  every door now answers `triggered`, `completed`, `timeout` or `error`, with `ok` kept as the one-bit
  summary so an existing reader is unaffected.

  `POST /api/networks/peers/:peerId/sync` is new, and syncs one peer across every network it belongs to.
  It sits on the networks COLLECTION rather than under one network's id because a peer is not a property
  of one network. The id is checked against the configured members and never treated as a URL.

  Both go through `sync/trigger.ts`, so a fourth door cannot invent a fourth set of semantics. The one
  asymmetry is deliberate and documented there: a network cycle races the timeout because it can span many
  peers, a peer cycle does not because it is already bounded by that peer's own request timeouts.

- **`POST /api/notify/trigger` is DEPRECATED.** Use the two routes above. It still works and delegates to the same code,
  so nothing breaks today.

  A sync trigger had no business on the peer NOTIFICATION channel, and the cost was not theoretical: that
  router was exempt from parts of the guard sweep under a reason written for the notification endpoint
  beside it, which is exactly why this route accepted any authenticated token until 4.4. The name was
  wrong, so the guard was wrong, and no gate could see it.

### Removed

- **`POST /api/brain/filter` is gone, and with it the last second shape of any capability.** `B-9` step
  3c, which closes a row open since 2026-09-16. It was not a thin route over the `filter` tool — it was a
  SECOND IMPLEMENTATION of it: its own body validation, its own paging parse, its own proxy fan-out, its
  own budget resolution and its own error handling, four hundred lines beside a tool that already did all
  of it.

  Read a collection at `POST /api/filter` — the generic tool door, which has no per-tool code at all.

  **THE ENVELOPE CHANGES, and that is the port.** One shape for every tool, so a caller writes the
  response handling once:

  | | was | is |
  |---|---|---|
  | `200` | `{results, count, total, limit, skip, truncated, …}` | `{ok: true, text, data}` — all of that inside `data` |
  | a refusal | `{error}` | `{ok: false, error, data}`, with the same sentence the MCP door uses |

  **Why this was worth four PRs rather than one.** Every capability gap had to close first, because a
  deletion that also removes something is indistinguishable, from outside, from a deletion that broke
  something. Steps 3a and 3b removed nine `GET` routes and found three defects in `filter` on the way;
  this one removes the tenth shape and nothing else.

  Governance simplifies with it: `filter` had a `ROUTE_RIGHTS` row beside its `TOOL_RIGHTS` row, which is
  two governance points for one capability. One row governs both doors now.
- **The five collection LIST routes are gone. Reading a collection is `filter`.** `B-9` step 3b, and a
  break: `GET /api/brain/spaces/:spaceId/{facts,entities,edges,chrono,files}` each answered what a
  predicate over one collection answers, with their own query grammar, their own page caps and their own
  response key.

  ```json
  POST /api/brain/filter
  { "space": "work", "collection": "facts", "limit": 100, "tag": "release" }
  ```

  | | the routes | `filter` |
  |---|---|---|
  | the rows | `{ facts }`, `{ entities }`, `{ edges }`, `{ chrono }`, `{ files }` | `{ results }`, whichever collection |
  | the page | default 50 or 100, hard max 200 or 500, and the five did not agree | `limit`, default 200, no maximum |
  | a fact by entity id | `?entity=<id>` | `filter: { entityIds: "<id>" }` |
  | an entity by exact name | `?name=` | `filter: { name: ... }` |
  | chrono tag sets and date ranges | `?tags=`, `?tagsAny=`, `?after=`, `?before=` | `$all`, `$in` and a `createdAt` range |
  | a file by path | `?path=` | `path`, an argument, normalised the same way |

  **THREE THINGS THE ROUTES DID THAT A CALLER NOW HAS TO ASK FOR**, and each is silent if you miss it:

  - **a chrono `status` derived on read** — send `deriveStatus: true`, or `active` means what is stored
    rather than what is true. The route always derived; `filter` defaults to the stored value because a
    predicate has to be able to match what is on disk.
  - **chunk records hidden from a file listing** — the route excluded them by default, `filter` does not.
    Send `filter: { parentFileId: { "$exists": false } }` or a converted document looks like the same
    file many times over.
  - **an unsupported paging name refused by name** — the routes answered `'offset' is not a parameter,
    use 'skip'`. `filter`'s body is strictly allowlisted so it is still a `400`, and it still names the
    parameter to use: the alias list moved onto the strict-body refusal rather than going with the routes.

  Nothing an operator does in the UI changed. `listFileMeta` went with them: it had no caller, because the
  file manager lists through the file STORE, which is a different question.
- **The five `GET` routes that read ONE brain record are gone. Read a record through `filter`.** `B-9`
  step 3a, and a break: `GET /api/brain/spaces/:spaceId/{facts,entities,edges,chrono}/:id` and
  `GET .../entities/by-ids` all answered what a predicate over one collection answers, with their own
  response shape, their own refusals and their own 404.

  ```json
  POST /api/brain/filter
  { "space": "work", "collection": "entities", "filter": { "_id": "8f3c…" }, "limit": 1 }
  ```

  A set of ids is the same call with `$in`, which is what `entities/by-ids` did; unknown ids are absent
  from `results` exactly as they were absent from `entities`.

  **The one behaviour that CHANGED, and it is the reason this is a `Removed` rather than a rename: a
  record that is not there is `200` with `results: []`, not `404`.** A predicate matching nothing and a
  record not existing are the same event to a filter, and pretending otherwise would mean `filter`
  answering 404 for an ordinary empty page. Branch on `results.length`.

  **Two things the routes DID after the query, which a straight swap drops silently.** Both are
  identical on most records and wrong on exactly the record somebody is looking at:

  | | the route | `filter` |
  |---|---|---|
  | a chrono `status` | derived on read | the STORED value unless `deriveStatus: true` |
  | `matchedText`, `embeddingModel` | returned by a by-id read, withheld by the list beside it | withheld unless `includeDiagnostics: true` |

  Send `deriveStatus: true` on a chrono read to get what the route gave you; it is refused on any other
  collection rather than ignored. The diagnostics default is now the same on both shapes, which the two
  routes never were.

  **A fixture bug fell out of this and it is worth naming, because it is the section rule one level up.**
  The duplicate-scanner suite waited for its records to be index-visible through a helper that took a flat
  list of four ids and looked at the first two. So it proved one PAIR was visible and concluded about both
  — CI then failed with `expected >=2 candidates, got 1`, on exactly the pair nobody had waited for. It
  takes a list of PAIRS now, so a caller cannot hand it two and have one silently ignored.

  Nothing an operator does in the UI changed: the client was already reading everything else through
  `filter` and now reads these the same way.

### Fixed

- **A file keeps its description, tags and properties across a move, and across a rewrite that does not
  mention them.** Both already held; neither was written down, and the cost of that landed on somebody
  else. A file is the one record type with no id of its own — its `_id` IS its path — so an integrator
  mapping an external reference onto a file measured the two behaviours from outside, found them correct,
  and then re-asserted their key after every single write **because they were undocumented**, paying a
  round trip per write to insure against a promise we were keeping.

  `05-files-api.md` now states both as guarantees, says why a file is path-keyed rather than UUID-keyed
  (a delete writes a tombstone per path and a file's link records hang off the same id, so a second
  identity is a second thing to reconcile), and shows the stable-handle pattern. Two tests hold it: a
  source gate on the two shapes that make it structural, and a live round trip through move and rewrite.

- **Twenty-four sentences still sent a caller to a tool 5.0 had removed.** A rename is the one change that
  passes the compiler while leaving the writing wrong, and these were in the writing a caller reads while
  constructing a call: `save_entity` told them to look an entity up with a tool that is gone, `space_meta`
  told them to read the shape with `er_model` — which it had absorbed — ten chrono sentences named
  `list_chrono` after `filter` replaced it, and the integrator's MCP page described what `merge_entities`
  carries over the webhook. Each now names the live tool.

  **Nobody would have reported any of them.** A caller sent to a tool that is not there does not file a bug
  about the sentence; they conclude the capability is missing. So the fix comes with a gate that derives the
  retired set from the previous major's last release tag rather than a list, and holds every tool
  description, every guide page and every use-case example to naming only tools that exist — unless the
  sentence is saying the old one is gone, which is the most useful sentence a migration note has.

  Part of the pre-5.0 audit (`Q-22`); it is the first of that audit's six sweeps, and the two it covers are
  the guide pages and the schema descriptions.

- **Upgrading stopped quietly rewriting file records that every peer also holds.** Giving a file uploaded
  before 4.0 its position in a space's history is a one-time change to a record that replicates, and it rode
  inside the link conversion — which was an operator-run script until 5.0 taught the instance to run it at
  every startup. From then on every instance in a network stamped the same records with its own counter at
  whatever moment it happened to restart, and each overwrote the others in turn. The stamp is back on
  `npm run links:convert`, which now prints how many records it stamped per space; the boot conversion does
  links only.

  **A container deployment cannot run that script, so its pre-4.0 file descriptions stay local** until the
  record is next written — which is what they did before 5.0, and is the smaller of the two problems.

- **The gate that refuses boot migrations over synced data can follow a call.** It read one function's own
  body, so a migration that did its writing three calls away was invisible to it — which is how the case
  above went unnoticed for eleven days. It now resolves each call through the importing module's own import
  list, keyed `path:name` rather than by bare name, and walks the real startup graph to exhaustion. Its list
  of which collections replicate is read out of `sync/replicated-families.ts` rather than kept by hand,
  which is how `links` came to be missing from it.

- **A backfill could report records as suppressed when nothing was suppressed.** `space_reembed`'s
  `skippedSuppressed` is the number that tells an operator *"the setting is still on"*, and it was
  computed as `count(vectorless) - count(vectorless AND allowed)` — two separate reads of a collection
  the embed worker is actively DRAINING. Every record the worker finishes gains a vector and leaves the
  first population, so a worker landing between the two reads shrinks the second count for a reason that
  has nothing to do with suppression, and the difference goes positive.

  Both counts now come from one `$facet` pass, so they describe the same instant and their difference is
  what the exclusion removed rather than what the worker happened to finish in between. `remaining` came
  from a third live read and now shares the same snapshot.

  Caught as an intermittent `skippedSuppressed: 1` in a loaded full-suite run, against a space whose
  suppression had just been turned off — and passing when that file ran alone, which is the signature the
  same file already documents twelve lines above the assertion that failed.

- **Merging two entities left every LINK RECORD pointing at the entity it had just deleted.** `merge.ts`
  relinks edges, facts, chrono entries and file metadata by rewriting their `entityIds` arrays, and had
  no reference to the `links` collection at all. On a space that has been through the link conversion —
  which every space becomes at the boot after it is created — the links therefore survived the merge
  unchanged, pointing at an id phase 5 then removed.

  Measured on a live instance: before the merge the link named the absorbed entity, after it the link
  still named it, and the entity was gone.

  **A link is RE-KEYED rather than updated.** Its `_id` is derived from both endpoints, so moving the
  `to` changes its identity — the same reason edges have a re-key path. The old id gets a tombstone, or
  the next pull from a peer still holding it would re-create the dangling link and undo the repair.

  **Deleting an entity was never exposed to this**: the delete guard reads link records and refuses with
  a `409`. A merge deletes the absorbed entity directly rather than passing that guard, which is why it
  was the one path that could do it.

  It is the shape phase 3b of the same function already describes — *"Edges, facts and chrono were
  relinked and files were not"* — one collection later.

- **The link conversion DELETED links that existed only as records, and its own log said it removed
  nothing.** The 5.0 migration walks each record and reconciles its links from the legacy ARRAY fields.
  A link written through `linkEntities` before that spelling was fixed exists as a link RECORD with an
  empty array beside it — so the desired set said "this record links to nothing" and the reconcile
  deleted it. **With a tombstone**, so the loss replicated to every peer and a re-run could not repair
  it.

  The operator was told the opposite in the same breath: *"It is additive: nothing is removed, the
  arrays keep being read until a space is marked."*

  **The count is what hid it.** `N link(s) created` was a `countDocuments` delta, not a count of
  creations — one creation and one removal net to `0`, which is indistinguishable from a space that
  needed no work. A live instance printed `general converted — -1 link(s) created`, and a creation
  count cannot be negative.

  The conversion no longer deletes, and it reports the creation count `reconcileLinks` already returns
  rather than measuring around it. **An ordinary write still deletes** — `linkEntities: []` means
  detach, and that is the whole point of it — so the exception is pinned by a gate to the one module
  entitled to it: a sync ingest that became additive would stop honouring a peer's detach and the link
  would return on every pull.

  **If you converted a space while holding record-only links, those links are gone and the tombstones
  are with them.** They can be re-created; nothing else was touched.

- **A test wrote the retired link arrays to the built-in `general` space, and failed whenever the stack
  had restarted.** Every boot converts every space that is not yet marked, so `general` becomes
  `completeLinkage` and then refuses `entityIds` / `memoryIds` — correctly. A rebuild wipes the config,
  so the first-run boot converts nothing and CI never saw it; any restart that preserves the config did.
  The failure named the link migration, which the test had nothing to do with.

  Nothing about the product changed. The case now writes `linkEntities`/`linkFacts`, which work on a
  converted space and an unconverted one alike, and asserts the link through a WALK rather than through
  the echoed arrays — those are populated only on the unconverted side, so asserting them asserted which
  side of the migration the space happened to be on.

  A new gate refuses an array-link field aimed at a space a test did not create.

- **A walk did not return the node it started from, so an isolated record and a bad id looked the same.**
  `graph_traverse`'s own schema has always described *"`startId` itself at depth 0, so a walk that finds
  nothing still comes back with one node rather than empty — an empty `nodes` means the id resolved to
  nothing, which is a different answer from 'it has no neighbours'."* It never sent that node.

  A caller who believed the description read every empty walk as a bad id. That cost four probe
  iterations here, on an instance where the id was demonstrably good, and a schema description is what a
  caller reads while constructing arguments.

  **The promise is made true rather than the sentence corrected.** Both were open; emitting the node
  costs one row and gives callers the distinction, and correcting the sentence would have left them with
  no way to tell a bad id from a lonely one — which is the reason the sentence exists.

  The start node counts against `limit`, because it is a node: `limit: 1` answers the start alone, which
  is also the cheapest way to ask whether an id exists. **An id that resolves to nothing is still empty**,
  which is the other half — the promise is only useful while a bad id is actually empty.

  A walk started from a fact or chrono entry returns that record, with its `kind`, resolved exactly as a
  neighbour is.

- **`linkEntities` and its three siblings were accepted with a `201` and the link was reached by
  nothing** — on any space created since the instance last restarted.

  A link is stored in two shapes during the 4.x transition: a record in the space's `links` collection,
  and the array on the record itself. `usesLinkRecords` picks which shape a space is READ through, and
  `link-adjacency.ts` calls it *"the ONLY place that decides"* — which was true of readers and of nothing
  else. The writer wrote a link record and stopped, so on a space still read through the arrays it wrote
  a row every reader looks away from: not `traverse`, not a graph-augmented `recall`, not the delete
  guard.

  **The conversion that flips a space runs at BOOT**, so a space created afterwards keeps the array path
  until the next restart. The same call therefore worked or silently lost the link depending on when the
  instance was last rebooted — which is why it went unreported: a reporter could not reproduce it and a
  responder could.

  **It also meant the two spellings swapped validity across a line a caller cannot see**: `entityIds`
  worked and `linkEntities` did not on an unconverted space, and a converted space refuses `entityIds`
  outright. And `linkEntities` is the spelling the MCP schemas publish, so an agent reading the contract
  was told to use the one that did nothing.

  The writer now resolves the shape through the same selector every reader uses. **Nothing about the
  request changed**, and a caller who worked around this with `entityIds` is unaffected.

  **Not fixed by making new spaces converted**, which was the first idea and contradicts a recorded
  decision: the conversion is *"a performance and consistency upgrade rather than a correctness
  prerequisite"*, so an unconverted space is a supported state and the writer has to work on one.

- **An edge you drew to a fact, chrono entry or file was stored and reached by nothing.** An edge declares
  the kind at each end, the writer REFUSES a kind that does not match the record, and the edge is then
  validated, stored, hashed and replicated — so `supersedes` between two claims is a real edge that
  everything accepted. The walk resolved every neighbour against the entities collection alone and dropped
  whatever was not there: no flag, no `truncated`, no error. On the Graph tab such an edge was saved, listed
  on the Edges table, and never drawn.

  That is the *"stored, returned, and points at nothing traversable"* report arriving by a different route,
  and it is why the contradiction resolver still refuses to draw one of these — a refusal written a month
  before endpoint kinds existed, whose stated reason is obsolete and whose EFFECT was right, which is why
  nothing ever contradicted it.

  **No include flag governs it, and the asymmetry is deliberate.** `includeMemories` and `includeFiles` are
  opt-in because they follow IMPLICIT links — a record that happens to name this one — of which a busy node
  has thousands. An edge exists only because somebody drew it, so there are exactly as many as were meant.
  A record reached through an edge also EXPANDS, unlike one reached through a mention: an edge chains, and a
  chain of `supersedes` stopped at one hop would answer a fragment and call it the neighbourhood.

  **A walk may now start from a fact or a chrono entry**, not only an entity.

- **Almost every tool answered with no structured half, so `data` was `null` over HTTP and
  `structuredContent` was absent over MCP.** Thirty-three successful returns across eleven tool files put
  the whole answer in the text half and nothing beside it. A client that surfaces the structured form —
  several do — got `null` and had to parse prose to recover a result it had just asked for.

  **This is the defect the canary operator reported against `query`, answered on the tool they named.**
  Nothing swept the siblings, and the sweep is where the cost was.

  It was two classes, and the second is the expensive one. `recall`, `similar`, `graph_traverse`,
  `save_bulk`, `save_link`, `delete_entity_preview`, `list_spaces`, `space_stats`, `space_meta` and
  `network_peers` already built an object and dropped it — `graph_traverse` answered
  `{"ok":true,"text":"{\"nodes\":[…]}","data":null}` throughout. **Every write tool then had the same
  defect wearing a sentence**: `save_entity` answered `Entity 'Ada' (person) upserted (ID 9f2…).` and
  nothing else, so getting the id of a record you had just written meant a regular expression over
  English. Creates, updates, deletes, merges, file writes and `network_sync` were all in that state.

  **What a tool carries now is the record it wrote, or the identity of what it acted on** — one rule, not
  a decision per tool. A delete answers `{"_id": …, "deleted": true}`; a merge answers the survivor and
  the absorbed id; `move_file` answers `{"from": …, "to": …}`.

  Where the answer is naturally an array the structured half NAMES it, because `structuredContent` must
  be an object: `list_spaces` carries `{"spaces": […]}` and `network_peers` carries `{"peers": […]}`.
  **The text half of both is still the bare array**, so a caller that indexes it is unaffected —
  `network_peers` has a recorded refusal of an envelope on exactly that ground, and it governs the text
  half only.

- **A gate had claimed this rule and could not see it.** `mcp-structured-content-carries-its-payload`
  refuses a `structuredContent` built from metadata alone; its subject is every `structuredContent: { … }`
  literal, so a return carrying none matched nothing and sat outside the sweep. It was green throughout
  while refusing the *lesser* form of the same defect — metadata with no answer — and blind to the greater
  one. Its replacement asserts presence instead, and **the parity test was wrong in the same direction**:
  it compared `data` across the two doors with `deepEqual`, which passes for two nulls, so it reported
  agreement about an answer neither door gave.

- **`filter` refused a bad `skip` and quietly ignored a bad `limit`.** One endpoint, one question — where
  does this page start and how big is it — and two answers to a value it cannot use. `skip: "abc"` was a
  `400`; `limit: "abc"`, `limit: -5` and `limit: 0` were accepted and silently answered with the default,
  which is a page nobody asked for with a `200` on it.

  Both refuse now, through one parser. The per-collection list routes had to coerce — a query string has
  no types, so `?limit=abc` is indistinguishable from a caller who meant something. A JSON body does, so
  there is no guess left to make, and this only became visible when the last list callers moved across.

- **The filter nesting cap counted the SERVER's clauses against the CALLER's budget.** `MAX_FILTER_DEPTH`
  bounds what a caller may ask for, and it was enforced at the last moment before the database — by which
  point the caller's filter had the server's own composition wrapped around it.

  That budget was already spent. A derived chrono `overdue` clause is itself depth 8 — an `$or` over an
  `$expr` over a `$toDate` over an `$ifNull` — so `deriveStatus: true` plus ANY convenience reached 9 and
  was refused with `Filter too deeply nested`, about a filter the caller had written one level deep. The
  combination it refused is `?status=overdue&search=…`, an ordinary query on the list route being removed
  in the same release: the capability would have gone quietly with it.

  The check runs where the caller's filter is still identifiable as theirs, and a branded type keeps it
  there — the read path cannot be handed an unchecked predicate without failing to compile. **The cap
  itself stays at 8** (owner, 2026-09-18): the thing to fix if something composes one level deeper is the
  composition.

- **A derived chrono status could not be combined with a convenience.** The status rewrite ran AFTER the
  conveniences, which accumulate under `$and` — so a caller's top-level `status` was buried in one by the
  server, and the rewrite's refusal (written for a `status` the CALLER nested inside `$or`) fired on the
  server's own transformation. The error told the caller to put `status` at the top level, which is
  exactly where they had put it. The rewrite reads the caller's filter first now.
- **`filter` matched a chrono `status` against the STORED value while the list route matched the DERIVED
  one, so the same question returned different records.** `deriveStatus` made the displayed status
  askable; this is the half that changes which rows come back. `status: "active"` returned a fortnight-old
  episode through `filter` and not through the list route, and `status: "overdue"` found derived ones
  through the route and only hand-typed ones through `filter`.

  `deriveStatus: true` now means the whole call speaks in derived terms, predicate included — through the
  same clause builder the route uses, extracted rather than copied, because `whenDuePasses` makes "what a
  passed due moment means" a per-TYPE decision and a second copy would be a second answer to it. A
  `status` nested inside `$or`/`$and` is REFUSED rather than rewritten: the derived clause is itself a
  disjunction in two of the three cases, so folding it into a caller's would change what theirs means.

  Nobody had hit this because the client has always used the list route — and it is what blocked moving
  that client onto `filter`, which is the next step of retiring the per-collection list routes.

- **The filter sanitiser silently turned a `Date` into `{}`.** Found by the above: it walks a filter and
  rebuilds each object key by key, and `Object.entries(new Date())` is empty — so a date value came out
  as an empty object, the comparison it was part of stopped meaning anything, and the query answered
  `200` over the wrong set.

  **No caller could have reached it**, which is why it survived: a filter arriving over HTTP is JSON, so
  its dates are strings. It bites the moment a predicate is built in-process, and the sanitiser is on the
  path of every one of those. Dates are preserved now, and the guards that refuse a value still refuse
  it — the general rule being that a sanitiser which REWRITES what it does not recognise is worse than
  one that refuses it, and every other branch in that module already threw.

- **The space editor could reach a state where saving was IMPOSSIBLE, and the only way out read as
  discard.** Owner-reported, and it was two defects that made each other worse.

  The footer swapped **Save changes** for the close-and-finish button whenever any notice was set. That
  was written for the vote-pending path, where it is right — a networked space answers `202`, the change
  IS submitted, and a button still offering to submit invites a second proposal for the same change. But
  the same signal carries *"nothing to save"*, which is not a submission. One Save that reported doing
  nothing retired the Save button for the rest of the session: the form stayed editable and the only
  control left closed the dialog.

  And *"nothing to save"* was easy to reach by accident, because **the diff could not see a key being
  removed**. It walked the keys of the CURRENT payload, while `strictLinkage` is emitted only when true
  and `purpose`/`usageNotes` only when non-empty — so turning strict linkage off, or clearing the
  purpose, produced an empty diff. The unsaved-changes guard said there were changes and the save said
  there were none; both were right about their own question, which is why neither looked wrong.

  The diff walks the union of both key sets now and sends a vanished key as its cleared value, and a
  finished state ends the moment there is another edit. **The server was never wrong** — its merge
  guards on "present", so `''` and `false` always cleared correctly; only the client failed to send
  them. It had bitten once before and been fixed for `typeSchemas` alone, which is why the rule now
  lives in the diff rather than in each key's emission.

- **A declared edge end could not be REMOVED once its entity type was deleted.** Owner-reported. The
  ends picker listed one checkbox per entity type the space currently declares, so a name stored on the
  edge and no longer declared had no checkbox at all — nothing to untick, still enforced, invisible on a
  control that looked complete. It lists the union of the vocabulary and what is already picked now, and
  marks the strays, so an operator meeting a name they do not recognise can tell what it is.

- **A property `default` kept its string type after the property became a number.** Owner-reported. The
  detail pane binds the default to a text input, so it is always text; change the type afterwards and
  the schema was saved with `default: "5"` for a numeric property. That is not cosmetic — the default is
  written into records that omit the property, so a strict space starts refusing records it created
  itself. The emitted schema carries a default of the DECLARED type now, or omits it when the text
  cannot be one: a default that cannot be honoured is worse than none.

- **A schema type can be RENAMED, on every knowledge type.** Owner-reported: *"i created an entity with
  full property definitions but made a spelling mistake in the entity name — had to redo all"*. A type's
  name is a map key and the editor offered add and delete and nothing between. The rename keeps every
  property and the type's position in the list, and follows the name into every edge-endpoint list that
  named it — leaving those behind would break the declaration exactly the way a deletion did. Records
  already written keep the old type: a schema rename does not migrate them, and the case this is for is
  a type built minutes ago.

- **The conversion pre-flight claimed ninety days on an instance that had been recording for thirty
  minutes.** Reported by the canary operator 2026-09-15 with a controlled measurement: the endpoint caught
  a single `entityIds` write within two seconds and named the token and the field — it works — but the
  space holds 270 chronos already carrying `entityIds`, `count` was 1, and `since` reported ninety days
  back because that is `retentionDays`.

  It is the second, quieter version of this endpoint's known worst failure. The first was an inert
  recorder answering `writers: []` for a space being written to. This one is a HEALTHY recorder whose
  window is younger than the field says — and our own guidance, *"read `since` before you read the
  count"*, does not save a reader, because `since` is the misleading field. The risk is a sequence rather
  than a value: upgrade, run the pre-flight, see `writers: []`, convert, and the writers surface
  afterwards one at a time as `400`s.

  `since` is clamped to when this instance began recording, and the new `recorderStartedAt` says why a
  ninety-day request came back as half an hour. The stamp is written once when the instance's services start —
  the path a first-run install goes through too, not only a restart — and it is **the oldest existing
  note rather than `now`** — a note from sixty days ago is proof the recorder was running sixty
  days ago, and stamping `now` would make an instance that has recorded for a year claim it started
  today. `null` means it has not started since this shipped, so nothing can be clamped.

- **Sorting `links` crashed instead of sorting, and on the REST door it crashed as a RETRYABLE 500.**
  Reported by the canary operator 2026-09-15 against the tool door, which answers
  `Cannot read properties of undefined (reading 'has')`. Measured here, the REST door is the worse half
  and was not in the report: `500 {"error":"Internal server error","retryable":true}` — telling a caller
  to retry a request that can never succeed.

  `SORTABLE_FIELDS` declared five collections while the `collection` enum offered six, so the lookup was
  `undefined` and `allowed.has()` threw where the tool's own text promises the field "is refused and
  names the allowed ones". `links` now sorts by `createdAt`, `updatedAt`, `from` and `to` — a link has no
  name, title or type of its own, it IS a pair of endpoints.

  **And `parseSortParam` accepts an absent set rather than assuming one.** Both doors index the map and
  pass the result straight through, so the function that RECEIVES it is the only place that can hold
  this: a collection somebody forgets is now a `400` saying sorting is not supported, not a crash. A gate
  reads the enum out of the published schema and requires every member to be sortable-or-refused, because
  what recurs is the PAIRING — a collection reaching the enum without reaching the map.

- **The link conversion runs itself at boot, because the documented way to run it could not be run.**
  The canary operator, 2026-09-15: `npm run links:convert` on a deployed instance answers

  ```
  Error: Cannot find module '/app/scripts/convert-links.mjs'
  ```

  The npm script survives into the published image and resolves its path correctly; `scripts/` is not
  copied. So it presents as a Node stack trace rather than `missing script`, and reads like a broken
  installation of theirs. `04b-graph-api.md` documented that script as **the** mechanism and there was no
  second route — the pre-flight only reports, and `POST /links` writes one link at a time. "Spaces
  converted" was a set a container deployment could not join, and the 5.0 removal of the six link ARRAY
  fields is gated on exactly that set.

  Every start now converts each space not yet marked `completeLinkage` and marks the ones whose walk
  finished cleanly. It is additive — links are created, no array is removed, a space reads correctly
  before, during and after — so an interrupted run is fixed by the next boot, and an already-marked space
  is skipped outright. Owner: *"make the script autorun at startup … remove that on 6.0"*, recorded as
  `_DEPRECATIONS.md` row 6.1.

  **A boot migration over synced data is normally forbidden, and the peer floor is what suspends it.**
  `MIN_PEER_VERSION` derives from our own major, so a 5.0 instance refuses every 4.x peer at the
  handshake and no peer can write the arrays back. `renameMemoriesToFacts` runs at boot in the same
  release on the same argument.

  **It does not refuse the boot on a failure**, deliberately: a space whose walk throws is left unmarked,
  which is exactly its behaviour before this ran — it keeps reading its arrays and accepting array
  writes. Exiting would turn a recoverable data problem into an instance nobody can log into to look at.
  The space is named in an `ERROR` line and the next boot retries, so the array removal has a condition
  it can check rather than an assumption: a space is either marked or named.

- **BREAKING — `filter: {"type": "note"}` was accepted and silently DROPPED.** A bare scalar value was read
  as a malformed operator object — the grammar where a value is spelled `{"eq": "note"}` — so the
  translation produced no predicate and the recall answered `200` with the **unfiltered** ranking.
  `{"type": "NOT-A-REAL-TYPE"}` returned every record. It is the defect the fleet integrator reported on
  `/query` (*"it cost us a fabricated number"*), on the spelling the schema description now recommends, and
  it went unbounded the moment the filter key allowlist was removed.

  Which grammar a filter is in is now decided by the shape of its VALUES rather than by whether a `$`
  appears anywhere: the operator-object form is every value being an object whose keys all come from the
  eight names it has, and everything else — a scalar, an array, a `$`-operator, a sub-document — is
  ordinary MongoDB. A filter that mixes the two is still refused rather than guessed at.

- **`{"$where": {"eq": "x"}}` reached the database.** The operator-object path has no sanitizer between it
  and Mongo, and the key check that had been incidentally blocking `$`-prefixed keys went with the field
  allowlist. Anything `$`-prefixed now routes to the raw path where the sanitizer lives, with a floor under
  it so a change to the classifier cannot reopen the hole. `__proto__`, `constructor` and `prototype` as
  filter keys are refused on both grammars for a related reason: `out[key] = …` on a plain object would set
  the prototype and add no key, so the constraint vanished from the filter and the query answered `200`
  unfiltered.

- **`POST /api/recall` answered to HALF the byte budget of `POST /api/brain/recall`.** 25 000 characters
  against 50 000, same server, same capability, same transport — because the tool module picked MCP's
  default itself, which was correct while MCP was the only door it had and stopped being correct when
  `B-9` gave every tool an HTTP one. The lower default belongs to the TRANSPORT that received the call, not
  to the module that answers it: `defaultBudgetChars(transport)` is the one place that is decided.

- **A raw Mongo filter was always exhaustive, including when the index could serve it.** `{"type": "note"}`
  is an equality on a declared field and pushes into `$vectorSearch` natively; it was taking the full scan
  on the note that *"a raw filter is never declarable"* — true of `$or`, false of the common case, and
  newly expensive because raw Mongo is now the recommended grammar. `$or`, `$not`, `$exists`, `$regex` and
  anything nested still go exhaustive as a whole: half a filter pushed natively would restrict the
  candidate set before scoring and silently change which records `topK` is filled from.

- **`entityName` could not see a record linked the recommended way.** A fact or chrono entry attached with
  `linkEntities` — the form the integration guide leads with — was invisible to `?entityName=`, on both
  doors, and the filter said so by answering `{facts: [], total: 0}`. Not an error: it reads as *there are
  none*.

  | written with | `entityIds` array | link record | found before |
  |---|---|---|---|
  | `entityIds: [id]` | populated | written | yes |
  | `linkEntities: [id]` | **empty** | written | **no** |

  Both shapes are read now, through one predicate. **Neither side is complete on its own** — the arrays
  miss what `linkEntities` wrote, the link records miss what predates the upgrade — and both coexist on
  every space written to since. If you have been filtering by entity name and getting short answers, this
  is why.

- **The `filter` MCP tool required a space while its route did not — one rule, two doors, the MCP one
  narrower.** Introduced by the change that moved the search family off the space path: `POST
  /api/brain/filter` took an optional space and read across spaces, and the tool kept demanding one. An
  agent asking the obvious question — *what do I have about X, anywhere* — got a validation error through
  one door and an answer through the other.

  Caught by an integration test calling `filter` with no space, not by a unit test: both surfaces were
  individually consistent, and only exercising them the same way showed the gap. The handler needed the
  other half too — `memberSpacesWithin('')` answers nothing, so an optional parameter would have turned
  into a read that silently returned empty rather than the cross-space read it advertises.

- **The recall guide said `includeDiagnostics` hides the per-stage scores. It does not, deliberately, and
  has not for some time.**

  `lexicalScore`, `fusedScore` and `rerankScore` are returned unconditionally on both doors — the reasoning
  is in the code and it is sound: the number that DECIDED a result's position must not be the one a caller
  cannot read, and three floats are not a cost worth a flag. The flag governs `matchedText`,
  `embeddingModel` and `seq`, which is three fields rather than six.

  An integrator reading the guide would have believed the ordering signal was hidden from them by default.
  Corrected in both copies of the parameter table.

- **The guides now say which cross-encoder to pick, because the wrong one is a regression rather than a
  no-op.** Same instance, same questions, same budget, only the model changed: no reranker 45.7% first
  answers right, `bge-reranker-base` **27.4%**, `ms-marco-MiniLM-L-6-v2` **53.8%**.

  A cross-encoder replaces the retrieval ordering, which is right when it knows better and catastrophic
  when it does not. The failing model saturated — 0.9958 for the right passage against 0.9969 for a wrong
  one — so a difference of 0.001 overturned a vector margin of 0.100, confidently, on every query. Nothing
  in the API can say a reranker is making things worse: from outside, a worse ordering looks exactly like
  an ordering. So the advice is to pick a model trained for question-to-passage relevance, and to measure
  it against no reranker on your own corpus before leaving it on.

### Internal

- **The benchmark fetcher could not fetch the corpus it was written to pin, and every LongMemEval URL
  404d.** Two independent failures on the same step.

  The pinned URLs append `.json`; the publisher's files have no extension. They were recorded from the
  dataset page rather than from a fetch, so nothing ever proved they resolved — which is the one thing
  pinning by URL is supposed to make impossible. Corrected against the HuggingFace file listing.

  And `fetchPinned` read `await res.arrayBuffer()`, holding the body twice. `longmemeval_s` is 278 MB
  against LoCoMo's 2.8 MB, so the process died with `JavaScript heap out of memory` before it could
  print a hash. It now hashes the response as it streams, writes to a `.partial`, and renames into the
  cache only after the digest verifies — so an unverified corpus never appears where a reader expects a
  pinned one.

  The refusal is expressed once, against a digest: `assertPinnedDigest` holds the rule and the buffer
  form delegates to it, rather than a streaming path growing its own copy of the comparison.

  `longmemeval_s` is now pinned at `08d8dad4be43…`, 278,025,796 bytes. `_m` and `_oracle` remain
  recorded and unpinned, which the fetcher refuses exactly as it refuses a mismatch.

- **The offline standalone tests run in parallel, and the split is one module instead of two copies.**
  Measured on 591 offline files: **191.0s serialised, 46.6s at default concurrency**, both green.
  `npm run test:standalone` goes 257s → 160s, and preflight's own offline pass — which was serialised
  too — drops by the same three and a half minutes, so the set is no longer paid for twice per cycle.

  **`--test-concurrency=1` is right where it came from and wrong here.** `testing/integration` shares
  ONE live instance: run concurrently it latches maintenance mode and reports 314 false failures. The
  offline files have no instance to share, which is what `@needs-instance` declares — and the 16 files
  that do declare it still run one at a time.

  Explicit sleeps across the whole test tree total 5.3 seconds in four call sites, so the time was
  queueing, not waiting.

  **And the runner REFUSES a stale `server/dist`.** These files import from it; preflight builds it
  first and `test:all:core` never has, so running the suite straight after a branch switch tested
  whatever was compiled last. That cost two confused diagnoses in one evening — a fix that was already
  merged looked broken, and a build from two branches ago looked like a regression in the change under
  test. A check rather than a build, deliberately: building would hide the mistake and add a minute to
  every run, while refusing costs milliseconds and says what to do. `--allow-stale` is the escape hatch.

  **The guard the change owes:** `openTestMongo('x')` drops `ythril_harness_x` on entry and exit, so two
  files sharing a name were harmless while everything ran one at a time and delete each other's
  documents in parallel — intermittently, blaming whichever file was unlucky.
  `a-db-harness-name-is-unique` keeps all 48 names distinct.

- **The `filter` tool moved out of `search.ts` into `mcp/tools/filter.ts`.** Not a tidy-up: the size gate
  refused the two lines the `path` argument added, and the file was at its ceiling. The three tools there
  were never one responsibility — `recall` and `find_similar` RANK, and `filter` is the one that does not,
  which is what its own description already calls it.

  **Six gates named `server/src/mcp/tools/search.ts` as "the MCP door for `filter`" and all six went red
  at once.** Each would have been fixed by editing a literal, and six literals is six chances for the next
  move to leave one pointing at a file that no longer holds what the gate reads. They derive it now, from
  `testing/_shared/search-doors.mjs`, which also asserts that each file still declares the handler that
  makes it a door — a gate handed a file that moved concludes whatever its regex says about the wrong text.
- **Six gates asserted a SITE rather than a rule, and every one of them went red on a change that improved
  the code.**

  A guard recognised by a list of five names — the same list whose missing `requireMcpAuth` once caused the
  entire agent-facing API to be *exempted* rather than checked. A client-body extractor that knew only the
  `/spaces/${id}/…` template and so reported "no client POST to /recall" for a route the client calls on
  every search. A count of one guard spelling standing in for "all three read routes carry the retryability
  wrapper". An inline expression pinned by its exact text, which broke when it moved into a shared helper
  that makes the rule harder to get wrong.

  All six now assert the rule: the guard list is DERIVED from the middleware that reaches `resolveAuthOrFail`
  with a floor under it, the extractor knows both route shapes, the wrapper is checked per route, and the
  reach rule is checked in the module it moved to. This is the argument for doing the whole rename at once
  rather than a name at a time — it moves every identifier together, so it finds these as a batch instead of
  one false alarm a year that somebody talks themselves past.

- **A cross-door budget fixture was sized from the larger door, and only luck made it bind on the other.**

  A REST result flattens the record into the ranking envelope; an MCP result nests it under `record` with a
  narrower envelope, so the same corpus is a different number of bytes through each door and MCP’s has
  always been the smaller. The spill test budgeted at 80% of REST’s full answer and asserted that MCP
  truncates too — which held by a margin nobody had measured.

  Making storage bookkeeping opt-in removes the same ABSOLUTE bytes from both doors, which is a smaller
  proportion of the larger one. The bar moved from `M > 0.8R` to `M > 0.8R + 0.2S`, MCP’s answer dropped
  under it, and CI failed an assertion with nothing wrong in either door. The budget is now 80% of the
  SMALLER door’s full answer, so it binds on both by construction and cannot rot the next time either
  envelope changes size.

- **`benchmarks/` now holds a folder per benchmark: LoCoMo, LongMemEval and MemoryArena.** LongMemEval is
  recorded and not yet fetched, MemoryArena is not released by its authors, and a dataset whose hash is
  missing is now refused rather than read as nothing to check.

- **The LoCoMo benchmark was rebuilt around the conversation schema.** Storing resolved facts instead of
  transcript lines, with provenance and cross-session synthesis, took first-result accuracy from 33.0% to
  55.3% and evidence delivery to 91.4% on the first conversation. The measurements, the dead ends and the
  ceiling that method has are in `benchmarks/DEVELOPMENT-LOG.md`.

## [4.4.0] — 2026-09-09

**The release where the rights matrix means what the panel says.** A token granted exactly the rung the
rights panel asked for was refused by five schema routes, because each was guarded above the rung it
advertised. Every one of them now answers to what it advertises, a space's settings answer field by
field to the area that owns them, the data-quality sweeps left instance-admin, and the settings dialog
stopped posting the whole form so those rungs reach the UI rather than stopping at the API.

**Nobody loses a permission they were using, with ONE exception.** Every rung change here loosens or is
neutral — a space administrator holds `admin` on all four areas, so it still passes the rung that
replaced the admin check. The exception is `POST /api/notify/trigger`, which accepted ANY valid token and
now needs an instance administrator; see Security below before upgrading.

**Documentation changed in this release**, for deployments that re-ingest the guides on deploy: a
size-idempotent refresh skips a file whose byte size matches the stored copy, so use `--force` for these.

| file | why |
|---|---|
| `docs/integration-guide/06-spaces-api.md` | the per-field requirement table for `PATCH /:id` |
| `docs/integration-guide/06a-schema-api.md` | three auth lines, and the whole-map replace as the area's `admin` rung |
| `docs/integration-guide/09-sync-api.md` | `peerId` on the trigger, and that the trigger needs an administrator |
| `docs/integration-guide/13-audit-log-api.md` | an MCP tool logs the same operation as the route it mirrors |
| `docs/integration-guide/16-mcp.md` | `update_space_schema` needs `schema` admin; `reindex` changed area |
| `docs/integration-guide/04d-brain-ops-api.md` | rebuild-indexes is `knowledge` admin, not `schema` |
| `docs/integration-guide/14-duplicates-and-webhooks.md` | both scans are `dataQuality` write, not admin |
| `docs/userguide/04-settings.md` | each setting answers to its own area |

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

- **The two data-quality sweeps answer to the `dataQuality` rung, not to instance admin.**

  `POST /api/duplicates/scan` and `POST /api/contradictions/scan` both narrow their work correctly already:
  each walks only the spaces where the token holds `dataQuality` write, so naming a space it cannot reach
  answers `404` and a destructive rule never fires outside its reach. The narrowing was never the problem.
  The guard in front of it was — `requireAdminMfa` refused everyone but an instance administrator before
  the loop was reached, so the `dataQuality` column in the rights panel could not open these doors either.

  Both now use a guard that is `requireAdminMfa` minus the admin demand: same authentication, same second
  factor, and the rung the panel advertises is what decides. An operator responsible for a space's data
  quality can run its scans without being handed the instance.

  `POST /api/conflicts/seed` went the other way. It inserts a conflict record directly — something no
  product path does, since a real conflict is written by the sync engine — and it exists for tests. It is
  now declared as not area-scoped and stays instance-admin, rather than advertising a `dataQuality` rung
  that never opened it.

  **`dataQuality` admin therefore now means one thing, and the rights panel says which:** switching on
  merging as records are written, so duplicates are combined without anyone reviewing them. Every other
  data-quality operation — including starting a scan — is `write`.

- **The space settings dialog saves only what you changed, so the per-field rungs mean something in the UI.**

  Every field on `PATCH /api/spaces/:id` answers to the area that owns it. The dialog posted all of them on
  every save regardless, so the highest requirement in the form decided — a token holding exactly the
  `files` write it needed to change a media level was refused for the twenty-one fields it had not touched.
  Nothing was broken; the loosening simply did not reach this dialog.

  Save now sends the difference against what the dialog opened with, and `meta` is diffed per key rather
  than sent whole — otherwise changing a validation mode would carry the space's purpose and its embedding
  switch along with it, each of which answers to something different.

  Two fields are not a plain diff and both have cost something before. `typeSchemasMode: "replace"` rides
  along whenever the type map does, or a type deleted in the editor is simply not mentioned and the server
  faithfully keeps it. `recordTtlDays` is still not in this payload at all: it belongs to the Danger Zone,
  which saves itself, and a scalar write would flatten all five per-collection windows to one figure.

  Pressing Save with nothing edited now says so instead of sending an empty body, which the route refuses.

- **A similarity search is audited under the same operation whichever door it came through.**

  `find_similar` over MCP logged `entity.list`; `POST /api/brain/spaces/:id/find-similar` logged
  `brain.find_similar`. So an operator filtering the audit log for `brain.find_similar` saw only REST calls,
  and one filtering `entity.list` found similarity searches mixed in with entity listings. Every sibling
  already agreed with its route — `query`, `recall`, `traverse`, `get_stats`, `er_model` — and the comment
  justifying the odd one out had simply missed that `brain.find_similar` existed.

  Gated, because a fix without one is a fix waiting to be undone: if a route operation's last segment names
  a tool, that tool must log that operation. Derived from both tables, so the next tool is covered without
  anybody remembering the rule. `retry_embedding` is skipped and says why — the name appears under two
  prefixes with a tool for each, and both are right — and the number of such skips is asserted so the hole
  cannot quietly widen.

- **A REST caller can sync one peer, which only an MCP caller could before.**

  `sync_now` has taken a `peerId` since it was written — it validates the id against the configured members
  and syncs that peer across every network it belongs to. No REST route accepted one anywhere, so a REST
  caller could sync a network and never a single peer. One capability, two doors, and the difference only
  visible from outside; found by the new parameter-parity gate rather than reported.

  `POST /api/notify/trigger` now takes `peerId` in place of `networkId`. Sending both is a `400` — they name
  different subjects — and an id belonging to no network is a `404`, because an unvalidated value would
  become the address this instance connects to. That check (SEC-16) now lives in one place and both doors
  call it, rather than the route growing a second copy of the tool's.

  `?wait=true` works on the peer path too, reporting `networksSynced` rather than `synced`.

- **A sync started from the "Sync now" button used to fail in silence.**

  `POST /api/networks/:id/sync` launched the cycle with a bare `void` and no `.catch`, and the cycle
  outlives the response — so a rejection had nowhere to go: no log line, no audit entry, an `ok: true`
  already sent to the operator, and an unhandled rejection at the process level. Pressing the button on a
  network whose peer was unreachable looked exactly like success.

  It now logs the failure, which is what `POST /api/notify/trigger` has always done for the same
  fire-and-forget.

### Security

- **Any valid token could start a sync cycle. Now it takes an administrator, as the sibling route always did.**

  `POST /api/notify/trigger` was guarded by `requireAuth` alone, so a token with `instanceAdmin: false`,
  every area at `none` and no spaces reached it and got `200 {"status": "triggered"}` — on any network id it
  named. `POST /api/networks/:id/sync`, which does the same thing, refused that token with
  `403 Admin token required`. Two doors onto one capability and the weaker one in charge, which is this
  repository's signature defect.

  It is now `requireAdmin`, matching the sibling. The route's own comment has always called it "(admin)";
  only the guard disagreed.

  **UPGRADE NOTE, and read this one if you integrate.** Nothing of OURS loses access: the peer protocol uses
  `POST /api/notify`, and the "Sync now" button uses the sibling. But your own tooling may call this route,
  and from 4.4 it needs an **instance-admin** token — a space administrator, however many spaces it
  administers, is refused. Check before you upgrade rather than after.

  **Why no gate caught it.** `route-guard-coverage` exempted the whole `notifyRouter` under the reason
  *"peer notifications + admin sync trigger — peer-authenticated"*, which is true of `POST /api/notify` and
  was never true of `/trigger`. The exemption now names the one route it was about, and putting the old
  guard back turns the gate red.

  **And the class, not just the instance.** Every remaining router-wide exemption was checked against every
  route on its router. One more had the same shape: `inviteRouter` was excused as *"authenticated by the
  invite key itself"*, which is true of the handshake's two joining legs and false of `POST /generate`,
  which MINTS the key. That route is correctly `requireAdmin` today, so nothing was open — but dropping the
  guard would have been invisible, which is exactly how the trigger came to take any token. Both are now
  exempt per ROUTE, and removing either guard turns the gate red.

  **What it did and did not reach.** A sync cycle authenticates peer-to-peer in both directions,
  so this exposed no data to the caller: what an unprivileged token could do was make this instance
  start work, repeatedly, against networks it holds no rights in. An unauthenticated denial-of-service
  surface rather than a disclosure — there is nothing to rotate.

### Internal

- The two sync doors are exercised by CI rather than by hand. `Q-21` added them and verified them against a
  scratch instance, which covers nothing afterwards. Nine cases now drive the live stack, and three assert
  things no source-reading gate can see: that `ok` is still beside `status` in the answer the UI colours its
  banner from, that both doors refuse a token with no rights, and that `/api/networks/peers/x/sync` is not
  shadowed by `/api/networks/:id/sync` — both answer 404, so only the REASON distinguishes them.

- Parameter parity between an MCP tool and its REST route is gated on every pair that can be READ, instead
  of on four out of forty-six. `_route-accept-keys.mjs` reads what a route accepts out of the route — an
  exported refusal list, a zod schema (including one declared locally), a destructure that is the whole of
  the reading, or nothing at all, which is an answer. Anything else comes back `unresolved` WITH the reason
  and is skipped, because "accepts nothing" and "we could not tell" looking alike is how a sweep reports
  clean about what nobody checked. 78 of 124 mutating routes are readable, and a case holds that number to
  only improving — alongside one that names the four pairs the previous gate covered, so they cannot go
  missing inside a bigger total.

  It found a real gap on its first honest run — `sync_now` takes a `peerId` no REST route accepts — which is
  filed rather than fixed here, with a case that fails if the exemption outlives the defect.

  **Eight wrong answers came before that one**, four of them arriving as findings, and each is recorded
  beside the code that now prevents it: a partial destructure read as the whole contract, query parameters
  compared against body keys, a query key reached through a helper, a helper's body slid to end-of-file, a
  tool compared against a sibling route because the right one was unreadable, path parameters counted as
  missing, and the mount graph that `Q-19` extracted. The last was the worst: a negated-comma class stopped
  inside `Record<string, unknown>`, so the four pairs the OLD gate checked were skipped while this one
  reported a bigger number. The pattern in all of them is the same: the shape of the output gave it away,
  not the code under test.

- Four sweeps each worked out where an Express router hangs, and two of them got it wrong. The graph is now
  `testing/standalone/_router-mounts.mjs` and the conclusions stay apart, because they genuinely differ:
  one asks whether a router is reachable at all, one wants the full path to match a rights row, one wants
  the mount prefix by name.

  The shared version resolves all three mount forms, and the two that were missed are why this is a module.
  `brainRouter.use(memoriesRouter)` carries no prefix argument — ten of the brain routers hang that way — and
  a route registered inside a function is written against that function's `router` PARAMETER, which nothing
  mounts by that name.

  Widening the guard sweep to see the second form put `POST /api/files/:spaceId` and
  `POST /mcp-oauth/consent` into the analysis for the first time. Both are fine: the upload route is
  guarded, and the consent POST is now exempt WITH its reason — it carries no bearer header because the
  token arrives in the form body, and the handler validates it itself.

  It throws below a floor rather than returning a thin map. A graph that resolves nothing makes every caller
  pass on an empty set, which is exactly how the gap stayed hidden.

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
