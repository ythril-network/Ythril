# Changelog

All notable changes to Ythril are documented here. This file covers the **current major series**;
earlier majors are archived under [`changelog/`](changelog/) and linked at the bottom.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- **A space's Merkle root is not re-read when nothing changed (`Q-107`, part 4).** Every sync cycle of a
  `merkle: true` network and every peer's `GET /api/sync/merkle` streamed all six record collections of the
  space. Each collection's leaves are now kept while nothing writes to it, and only a written collection is read
  again; a call with nothing changed returns the stored root. Measured on the standalone harness, 40 000 records:
  390 ms for the first call, 2 ms for the next with nothing changed, 179 ms after one fact was written (every
  call was about 330 ms before). The file manifest is still walked on every call. `computedAt` is when the root
  was computed, which for a kept root is not now.
- **An entity delete with `cascadeToken` removes a hub's edges a chunk at a time (`Q-107`, part 3b).** It removed
  them one edge at a time — a read, a delete, a job retire, a seq and a tombstone per edge, so a hub of 1 500 edges
  was some 7 500 round trips while the caller waited. Each chunk of 500 is now one transaction: the edges' delete
  and their tombstones commit together, and a hub costs the same few commands per chunk whatever its size. One
  `edge.deleted` webhook per removed edge, as before, sent after its chunk committed.
- **An entity merge relinks a hub in one transaction of a few bulk writes, and a merge too large for one is
  refused before anything is written (`Q-107`, part 3a).** A merge used to relink the absorbed entity's edges,
  links and face labels one record at a time — five commands an edge, about 13 ms each with vectors on the test
  store — so a hub of 10 000 edges could not commit at all. Each kind of record is now one bulk write with one
  block of sequence numbers, and a merge of 2500 records takes seconds. What an integrator will notice:
  - **BREAKING for a caller merging hubs: one merge relinks at most 2500 records** (the absorbed entity's
    edges, links and face labels together). A larger merge answers `422` with `code: "merge_too_large"`,
    `relinks` and `bound`, on the REST merge route, `POST /api/duplicates/:id/merge` and the `graph_merge` tool
    alike, and automerge leaves such a pair open with one warning. Nothing is written, not even a sequence number.
    The bound is set from measurement: half of the largest merge that still committed on the test store.
  - **The `merge_too_large` text says what its reader can see and do** (bundle-30). It named the two entities by
    id, which the Review page never shows, and said to "move or delete some of its edges", although no door can
    move an edge. It now names both entities by name (each id follows in brackets), states the absorbed entity's
    edges, links and face labels separately, and suggests deleting at least as many edges or links as the merge
    is over — or says the face labels alone exceed the bound — and merging the other way round only when that
    merge fits, with what it would relink. `code`, `relinks` and `bound` are unchanged.
  - **A merge a `strict` space refuses answers `400` on every door.** The REST merge route answered `500`
    "Internal server error" and the duplicate route `500` "Internal error" while the tool answered `400`. The
    refusal is now decided before anything is written, so it no longer spends sequence numbers either.
  - **The `graph_merge` description states the statuses the doors really answer**: an unresolved conflict plan
    is an error result (`422` on `POST /api/graph_merge`; the REST merge route still answers the plan `409`).
  - The four doors run one merge sequence (plan, resolutions, merge), so a check added to it reaches all four.
- **`POST /api/sync/tombstones` checks each tombstone on its own, answers `refused`, and takes at most 5000 per
  request (bundle-46).** A malformed tombstone, or one whose seq the counter cannot carry, is refused alone and the
  rest of the page applies; the answer is `{ applied, refused }`, where `applied` keeps its meaning (the tombstones
  admitted by shape and seq) and `refused` is new and additive. A malformed page used to be refused whole with a
  `400`, which held the sender's watermark and stopped every deletion from it. A tombstone of a type the receiver
  does not know still answers `400`, so the sender re-sends it after the receiver upgrades. More than 5000
  tombstones in one request is a `400`; this instance sends 500. A tombstone page also costs the same handful of
  database commands whatever its size, on both doors, instead of four per tombstone.
- **A pushed or pulled page is written in a handful of database commands, not four per document (`Q-107`,
  part 1).** Every record that arrives from elsewhere — a peer's push (batch or single record), a pulled page, an
  admin import — is now stored by one writer. A fork-free page of 200 facts, entities, edges, chrono entries or
  links went from 801 commands to the same small number as a page of 20 (measured on the standalone harness).
  File metadata now too (`Q-107` part 2): a 200-document page went from 403 commands (two per document) to the same
  number as a page of 20, pushed or pulled — one guarded bulk merge, one read for which files' bytes are here, one
  batched enqueue. What an integrator will notice:
  - **BREAKING for a peer relying on it: `batch-upsert` now caps fork fan-out too.** A fact may have at most 10
    forks; the forks one request creates count with the stored ones. An eleventh is counted in `forkDepthRefused`
    and `rejected`, as a deep chain always was. An older receiver accepts it, so a network mixing versions can hold
    different fork sets for such a record.
  - **A fork's id is derived** from the parent's id, the seq and the text, so a push re-sent after a lost response
    upserts the fork it already made instead of forking again.
  - **Documents past the 500-per-family cap are counted in `rejected`** instead of being dropped unsaid — the
    sender used to count them as delivered and move past them.
  - **A record the receiver's store refuses (a schema validator, a value it cannot hold) is counted in
    `rejected` and named in the receiver's log**, and never fails the page; a fault that is not one document's
    still answers `500`, and the page is safe to re-send.
  - **A link arriving under another id for endpoints already linked is `skipped`**, never a `500`.
- **The admin export carries links, and the import restores what the export wrote (`Q-205`, `Q-206`).** The
  export now streams every replicated family, links included, and leaves out only what this instance derives (the
  vector, its model, `matchedText`). The import checks every `seq` (a non-negative integer below the ingest
  ceiling; absent only for older file metadata), keeps the retention stamps as dates and a file's sync base, drops
  file chunks, face records and file keys that describe bytes, stores the highest seq of a repeated id, names
  every document it did not store with the reason (`refused`), and names every record restored over a deletion
  this instance holds (`restoredOverTombstone`).
- **Arriving records take this instance's retention (`D-9`).** A record that arrives by push, pull or import
  without an expiry here is given this space's window (type schema over space), counted from its own creation
  time. A record older than the window is therefore removed by the next retention sweep, and that deletion is
  passed on to peers. An expiry this instance already holds for a record is kept when a peer updates it.
- **A bulk write costs a handful of database round trips, not several per item (`Q-99`, part 3 of 3).** A batch
  is now read once — every record, edge end and triplet it names in one query per kind — decided item by item by
  the same code each single-record endpoint uses, and written in one block per kind. Measured on the standalone
  harness: 200 facts went from 800 database commands to a handful, 200 edges between existing entities from 1800.
  Items still see the earlier items of the same call as written (a repeated edge becomes one edge and an update,
  a `functional` label counts the batch's earlier edges, the duplicate-name warning sees earlier entities), and an
  item that addresses something an earlier item also writes is applied after it, as two calls would be. What an
  integrator will notice:
  - **BREAKING for a reader of `inserted`: a converge counts under `updated`.** A fact or chrono item carrying the
    `id` of an existing record converges onto it, and was counted in `inserted` although nothing new was created;
    it now counts in `updated`, as an entity always did. `inserted` means new records, as the guide always said.
    The `bulk.write` webhook fires for a batch that only converged.
  - **An item that depends on an item that was not written says why** — an edge from a `$ref` whose item was
    refused names that refusal, not "unknown `$ref`" — and a `$ref` key used twice is refused before anything is
    written rather than reported after.
  - **A per-item reason never carries the database's own text** (a duplicate-key message named the internal
    collection and index).
  - **A converge that loses a race to another write is decided again**, against what the record now says, so the
    other write's change is kept; losing twice is a `409` on every create door and an item error in a batch.
  - `save_bulk` documents and declares the `id` its fact and chrono items always accepted.

- **A reindex queues its records for the embedding worker instead of embedding them in a loop of its own, and it
  survives a restart (`Q-99`, part 2 of 3).** `POST /api/brain/spaces/:id/reindex` and `space_reindex` record a
  run for the space and return; every record is then queued as a rebuild job and rebuilt by the same worker and the
  same text builder every write goes through, even where its text has not changed, because a new prefix scheme, a
  new dimension or new weights behind the same model name make a different vector from the same text. What an
  integrator or operator will notice:
  - **Progress is readable.** `GET .../reindex-status` and `space_meta` (both doors, one function) carry
    `reindexRun: { running, remaining, failed }` beside `needsReindex`. Poll until `reindexRun.running` is `false`;
    `needsReindex` now stays `true`, and recall in the space keeps refusing, until every record is rebuilt rather
    than only until the loop ended. The REST acknowledgement still carries `reindexed: 0, errors: 0`.
  - **The refusal is per space.** A space with a run going answers `409` to a second reindex; any other space
    starts. One reindex per INSTANCE was the rule while the work ran inline and two loops fought over the main
    thread; the queue serialises embedding now, so a script that reindexed spaces one at a time by retrying on
    `409` still works and simply stops waiting.
  - **The embed queue has lanes.** A local write is claimed first, a record a peer sent and a backfill
    (`reembed`) next, a reindex last, and every fourth claim starts one lane lower in turn, so under load each
    lower lane keeps at least one claim in eight. A large reindex or backfill no longer holds the write somebody
    is waiting to search for, and the claim of a never-tried job no longer sorts every pending job in memory (it
    was about 60 ms a claim with 40,000 jobs queued).
  - **A run is a document** (`<space>_reindex_run`): a restart re-asserts its space's `needsReindex` in the same
    step that computes it, continues the sweep where it stopped, and starts it again if the embedding
    configuration changed meanwhile. It moves with a rename and goes with a delete or a full wipe.
  - **An embedder outage strips nothing.** A rebuild that cannot reach the embedder leaves the record as it was and
    retries. A run that has made no progress for ten minutes says so once in the log.
  - **`ythril_reindex_in_progress` is the number of spaces with a run going**, no longer 0 or 1. An alert written
    as `== 1` should become `> 0`.
  - A reindex now also rebuilds the passages of converted documents and the captions and transcripts of media, so
    it takes longer on a document-heavy space, and a reindex no longer runs the duplicate check on every record it
    rebuilds.

- **The bundled embedding model runs in a child process of its own, so embedding no longer stops the server from
  answering (`Q-99`, part 1 of 3).** It ran inside the server: one text took 39 ms of CPU and the event loop's lag
  was 38 ms at the median (the lag *was* the inference), a batch of 16 blocked it for 516 ms, and a bulk import of
  50 facts made `/health` answer in 1639 ms at the 95th percentile, against 3 ms idle. The model is now loaded and
  run by a supervised child process (`brain/embed-process.ts`, hosted by the generic `util/supervised-worker.ts`):
  on the same texts the loop's lag stays at the timer floor, flat, whichever way the texts are fed
  (`testing/bench/inference-blocks-the-loop.mjs` measures both ways on your own model cache), and a test holds it on
  every machine by running the real child with an inference that spins the CPU for half a second and failing if the
  main thread goes 100 ms without running a timer. A thread would have fixed the lag and nothing else, so it is a
  process: a native fault in the model (an out-of-memory kill, a segfault) no longer takes the server down, and the
  process exits after ten idle minutes, which is what returns the model's memory to the operating system (the ONNX
  arena never gives any back while the process lives). What changed for an operator: the first embed after ten idle
  minutes pays the model load, one to two seconds; `mem_limit` or a pod memory limit now counts **both** processes,
  and the child competes with the server for the container's cores; and the child gets a minimal environment (the
  platform basics, the model cache directory and the three offline flags), never the Mongo URI, the master key or an
  API token. A lost process is replaced with a growing delay (about a second, doubling, capped at a minute), requests
  that arrive during the delay fail at once rather than hang, the embed queue waits the delay out before it claims,
  and **a record that keeps killing the process is left `failed` after three losses**, with the crash named in its
  job's `lastError`, instead of being retried for ever (only the record the process was working on is counted: one
  queued behind it fails `embedding process unavailable`, is retried, and is never charged); a retry, a rewrite and a new server version each give it a
  clean count. A model that cannot be loaded **stays failed until the model or an offline flag changes, or the server
  restarts**: it is tried once, not on every embed, so a bulk write against an unreachable model costs one process and
  its jobs end `failed` after their attempts exactly as before, with the same error text. A recall query goes ahead
  of queued documents in the one inference queue and never interrupts the embed already running. The brain embed
  worker now heartbeats its claim while an embed is in flight, and finishes or fails a job only under the claim it
  holds, so a slow embed is not re-claimed by the stall sweep and a late finish cannot delete a newer claim.
  **The inference process sizes its threads to the container's CPU quota** (read from the cgroup by the server, by
  the new `util/cpu-budget.ts`, and passed to the child), because onnxruntime counts the host's cores and ignores the
  quota: on a one-CPU container on a 16-core host that was 640 ms per text with its default pool against 54 ms with
  the count matched, slow enough that a thousand-record seed did not embed in ten minutes. **Batching was measured and not built:** several texts in one inference call were slower on mixed-length text, 161
  to 215 ms per text against 96 one at a time, because every text in a call is padded to the longest. Three metrics
  are new: `ythril_embed_wait_seconds` (queue wait, kept out of `ythril_embedding_duration_seconds`, which now
  carries the inference process's own timing for the local model), `ythril_embed_process_restarts_total{reason}` and
  `ythril_embed_process_state`. `embedConcurrency` keeps its defaults (2 bundled, 8 external) but what it bounds is
  now queue pressure on one inference process, not event-loop starvation, and the document pipeline's per-chunk
  `setImmediate` yield, which existed only because an embed blocked the loop, is gone. The bundled embedding stage of
  `GET /api/admin/pipeline-status` gains an additive `inference` object (the process `phase`, the model it was started
  for, consecutive losses, the backoff remaining and the sticky `loadFailure` for the configured model), read live
  rather than from the 20-second cache, and a sticky load failure turns the stage's `state` to `down` with the reason
  as its `detail`, so the Models screen's dot is no longer green over a model every embed fails on. No route, tool, parameter or
  setting changed; the `list_embed_jobs` description gained the one case in which a transient failure ends a job.
  The local-agent launcher and the inference host now share one `resolveEntry` for starting a compiled or a
  development entry point.

- **A tool call no longer builds a validator, and a media worker slot refills the moment it frees (`Q-114`).** Every
  tool call, on both doors, built an Ajv and compiled the tool's schema before its handler ran: 4.3 ms of main
  thread per call measured (`testing/bench/tool-call-setup-cost.mjs`, `recall`; `save_entity` 4.2 ms), against 1 us
  for a validator that already exists. A tool's schema depends on exactly one thing, the list of spaces the token
  reaches in order (the `space` enum keeps that order and is printed in the refusal), so the validator is now built
  once per reach and kept in a bounded cache of 64 (`ythril_tool_validator_cache_total{result="hit|miss|evict"}`;
  a steady `evict` rate means more distinct reaches are in rotation than it holds). `tools/list`, the server
  instructions and the refusal text come from the same cached schemas, so both doors refuse with the same bytes as
  before. The media worker claimed up to `workerConcurrency` jobs and awaited all of them before claiming again,
  so one 30-minute document conversion beside a 2-second image left the second slot idle for 28 minutes with a
  queue behind it; a slot now refills as soon as it frees, claims stay one at a time, and a raised
  `workerConcurrency` starts a slot within one poll interval even while every slot is busy. Shutdown is unchanged:
  a job claimed before stop runs to its end or is handed back, and one claimed after stop is handed back and not run.
- **Every date in the UI is shown in the format you choose, and dates follow the language you pick (`Q-146`,
  `Q-100`).** **Settings → Preferences** has a new **Date and time** card: **Automatic** (the default: your
  browser's locale when it speaks the interface language, otherwise the interface language), **ISO 8601**
  (`2026-09-29 07:59:03`) or **Day.month.year, 24-hour**, with the time in **local time** or **UTC**. It is kept in
  this browser, beside the language. Twenty places formatted their own dates in five spellings, and none of them
  could follow a setting; the German interface showed change notes and token expiries in US English because the
  app registers no Angular locale data, and "2 hours ago" stayed English after a switch to Deutsch. Every date now
  goes through `core/date-format.ts`, hovering any date shows its exact ISO 8601 UTC value, and a client spec
  fails when any other file formats a date itself. Stored and transmitted values are unchanged — ISO 8601 UTC. The
  token table's Created, Last used and Expires columns now use the two-line date-over-time cell the other tables
  use, where they showed one browser-formatted string.
- **A shortened answer names the size parameter that shortened it (`Q-116`).** Every answer the size budget cuts
  now carries `budgetBoundBy` — `maxChars`, `maxTokens` or `maxBytes`, the parameter whose ceiling the next match
  would have passed (two of them when it would have passed both) — on both doors, on recall, find-similar, the
  record lists, the query page, traversals and spill reads alike, from the one admission meter that decides it.
  It is absent when the answer was not cut, or was cut by a walk that ran out. The Query tab's advice, which said
  "raise Max response size" over a form with three fields of that name, now names the field by its label, and
  after a walk ran out it gives no size advice at all. Three stale claims went with it: the byte field's tooltip
  said it defaulted to 100000 with a floor of 1000 (it has neither — empty means no byte ceiling, and its
  placeholder now says "none"); the Brain guide put `maxChars` under "The answer" (that field is `maxBytes`) and
  described a characters-per-token field removed in 5.0; and the MCP `recall` description called a `budget` cut
  "bytes" when the default ceiling is characters. Additive for a reader: a new field, present only on a cut.

- **A search service that starts late is found and used, and a space waiting for it is no longer marked `failed`
  (`Q-113`).** `mongot` (the search process next to `mongod`) can start after the app. The app used to wait twelve
  seconds for it once, remember "no" for the life of the process, and at boot poll every populated collection for up
  to ten minutes against a service that was not there, then write `indexStatus: "failed"` on a healthy space; a record
  written while search was down was then never indexed, and semantic recall stayed empty until a restart or the rebuild
  button. Now the app keeps asking in the background, backing off from 5 seconds to 5 minutes for as long as it runs
  (once an hour on a database that has no search component at all), builds every missing index when search answers,
  and confirms the waiting spaces by itself. **What operators see:** while search is down a space stays `building`
  and `GET /api/spaces` adds `indexWaiting: true` and `indexWaitingSince` to it (derived when the list is read, never
  stored, not on MCP `list_spaces`, which carries no `indexStatus`); the admin pipeline status says search is down,
  since when and how often it was checked; one warn line an hour names the error class and code, never the message,
  and one info line says search is back. **`failed` now means only a build that really failed or timed out, so an
  alert keyed on `failed` for a late service stops firing.** `INDEX_READY_TIMEOUT_MS` starts when the indexes are
  confirmed, not at boot. `GET /ready` and the watcher agree (its own successful probe marks search up at once; a
  failed one never marks it down), and concurrent `/ready` requests share one probe. The retry delay rule moved into
  `backoffDelayMs` in `util/backoff.ts`, which the database connect loop and the embedding retry now use with
  identical delays. `YTHRIL_MONGO_MEM_LIMIT` (default 4g) is named in the hosting guide as the knob for a space of tens
  of thousands of records, unmeasured at that size. **In the UI:** Settings -> Spaces shows such a space as "Waiting
  for search service" with a still dot (no spinner) and counts it apart from "Indexing"; the Brain Overview and the
  Graph tab's slow-load note say the same; the page's index poll now starts from every list load, has no attempt
  cap, asks every 3 seconds while a true build runs and every 30 seconds while every building space is only
  waiting, skips its tick while the tab is hidden, and stops with the page.
- **A space-meta read no longer rescans the space, and both doors build it with one function (`Q-95`).** `stats`
  and `actualSchema` were rebuilt on every `GET /api/spaces/:id/meta` and every MCP `space_meta` — an entity scan,
  an edge scan, three link scans and seven counts per member space — by two hand-written copies of the answer. They
  are now kept per space and replaced by the first read after a write to that space's records (the record-write
  observer reports every committed write; a restore empties them), and the declared schema is joined fresh on every
  read. Measured on a space of 100 000 records (`testing/bench/space-meta-cost.mjs`): every read took a median
  236 ms before; now the first read takes 238 ms, a read with nothing written since takes under 1 ms, and the first
  read after a write takes 213 ms (then under 1 ms again). Same answer,
  same fields. The record-write registry also stopped letting a second subscriber replace the first one's
  collections, which this change would otherwise have done to the search-index lifecycle.
- **A schema-library type reads with its reference AND its definition, the same on both doors, and writes back
  whole (`Q-168`).** `GET /api/spaces/:id/meta` returned a library type as its bare `{ "$ref" }` unless asked
  `?resolve=1`, and MCP `space_meta` returned the entry's definition in place of the reference — so an agent could not
  see the link, and writing its answer back (`schema_update`) stored the definition inline and silently cut the type
  loose from its library entry. Both doors now return `{ "$ref": "library:<name>", ...definition }` by default, and
  `space_meta` takes `resolve` as REST does, with the same default; `resolve=false` returns the stored `{ $ref }`
  alone on both. Every door that writes type schemas takes the definition beside a `$ref` back to the reference
  when it is the entry's, and refuses an EDITED one with a `400` naming the field (change the library entry, or drop
  `$ref` to define the type inline) rather than losing the edit. **Who could notice:** `GET /meta` without
  `?resolve=` now includes the definition beside each `$ref` — additive for a reader, but a client asserting deep
  equality on that response sees new keys; and a write sending a changed definition beside a `$ref`, which was
  accepted and stored inline before, is now a `400`.
- **Breaking:** **A tool answer crosses the wire once, within the budget it states (`Q-111`).** Every answer was
  carried twice — MCP `content` and `structuredContent`, the REST tool door's `text` and `data` — so a stated
  budget bounded half of what was sent. Measured on a 400-fact space: an MCP `filter` page at the 25 000 default was
  50 247 bytes and is 25 053; the REST tool door's page at 50 000 was 102 296 bytes and is 50 124; a 2.16 MB
  `read_file` over MCP was 4 336 090 bytes and is 24 139. **REST** now carries the answer once: `data` holds it,
  and `text` is one fixed sentence saying so (`text` is still the answer when a tool has no structured result).
  **MCP** keeps both halves, because a client may read either alone (the rule in `mcp/tools/types.ts`), and holds
  each to half the stated budget — so a page holds about half the rows it did, and `nextSkip` reaches the rest;
  `budgetChars` still reports the budget as stated. **`read_file` is budgeted and paged**: whole paragraphs from
  `markdownSkip` within `maxChars` / `maxBytes` / `maxTokens`, `truncated` and `markdownNextSkip` saying where to go
  on — the parameters `GET …/files/extract` now takes for its Markdown window too, resolved by one function. A
  paragraph larger than a window is split at a line break rather than returned whole past the budget, on both.
  **Who is affected:** a script calling `POST /api/<tool>` that parses `text` instead of reading `data`; an MCP
  client that expected a whole file from one `read_file`, or a page's old row count at a given `maxChars`.

- **Breaking:** **Every quantity a caller sends has a bound, the same on both doors, and past it is a `400` naming it
  (`Q-108`).** `tags` 100 per record (what the sync door already refused, so a record with more could never be pushed),
  `linkEntities` / `linkFacts` / `linkChronos` 1 000 each, inline `edges` 500, `deleteFields` 100, `edgeLabels` 100,
  space-id lists (network `spaces`, `proxyFor`, webhook `spaces`, reorder `ids`) 1 000, space-create `folders` 100, an
  array of a fixed set (`types`, `kinds`, webhook `events`) the size of the set, conflict bulk-resolve `ids` 2 000 (the
  most the list shows), a notify event's `data` 8 KiB, and an `ingest` conversation 1 000 sessions and 20 000 turns.
  Four `ingest` runs may be in progress at once (a fifth start is a `429`), and each live-event stream kind admits 200
  connections (then `503` with `Retry-After`) and drops a reader 256 KiB behind rather than buffering for it. A
  pushed fact over 50 000 characters is refused on the sync door as on every write door. `filter`'s `limit` stays
  uncapped as documented: what is READ is bounded instead — a single-space read stops at twice the answer budget and
  answers `truncated` with `nextSkip`. All in `util/request-bounds.ts`, listed in the integration guide's Request bounds.
  **Who is affected:** a caller sending more than any of these in one request (none of the shipped clients does), a
  peer on an older release pushing a fact over 50 000 characters, and an upload whose JSON `tags` was not an array
  (it was ignored; it is refused now).
- **A collection's search index exists only while the collection holds a record (`Q-165`).** mongot keeps one
  change-stream cursor per search index over the shared oplog, so mongod's cost grows with index count times write
  rate, and index freshness is one rotation of every index; measured on a production instance, half of the record
  collections were empty and each still carried its index. A collection's vector index (and, on `files`, the face
  gallery) is now built when its first record arrives and dropped when its last one goes — a minute after the last
  delete of a burst, so a record deleted and replaced does not cost a rebuild. Every write reaches this through the one
  door every write already used, so no write path can skip it, and a record written as the last one is deleted is
  never left in a collection with no index. **Nothing changes for a caller:** a search on an empty collection answers
  empty with no `degraded` reason, a first record is found at once through the fresh-write channel while its index
  builds, and a space whose collections are empty reads *ready* — `GET /api/admin/pipeline-status` marks each such
  collection `empty: true` and leaves it out of `live`. **On upgrade**, boot drops the indexes of every empty
  collection and leaves every populated one's untouched; a new space starts with none. `SEARCH_INDEX_DROP_DELAY_MS`
  (default `60000`) sets the delay before an emptied collection loses its index.
- **A traversing recall walks its rows a window at a time, with every row exactly the graph it had before**
  (`Q-136`). `recall` and `similar` with `traverse > 0` walked each result row on its own, so a page cost about
  four queries per hop PER ROW — its edges, its link scan, the facts it named and the records it reached. Up to 16
  rows are now walked together: one query of each kind per hop for the whole window, each row keeping its own
  visited set, routes and bookkeeping. Measured on 20 rows of a 3 000-entity graph (MongoDB 8.2): depth 1 went
  from 73 queries and 34.2 ms to 8 and 5.6 ms, depth 2 from 152 and 80.9 ms to 16 and 19.0 ms, depth 5 from 392
  and 310.4 ms to 40 and 136.3 ms (`benchmarks/row-walk/`). Nothing in any answer changes: a row whose share of an
  edge read would reach its own cap — a hub over the row ceiling — is read alone for that read, and the row
  ceiling, `incompleteRows` reasons, the call's walk budget and the deadline behave as before. A differential
  test walks every row both ways over hubs, cycles, self-loops, fact, chrono and file endpoints, linked records
  and every narrowing, and requires them equal.
- **Breaking:** **REST traverse refuses what it used to clamp (`Q-109`).** `POST /api/brain/spaces/:spaceId/traverse` now
  answers through the `graph_traverse` tool, as `/recall` and `/similar` answer through theirs, so the two doors share
  one set of caps and refusals. What REST quietly adjusted is a `400` now, as it always was on MCP: `maxDepth` outside
  1–10, `limit` outside 1–1000, a non-number for either, a `direction` other than `outbound`/`inbound`/`both` (it became
  `outbound`), an `edgeLabels` list holding a non-string (it became ALL labels — a widening) and a blank `startId`.
  Refusals carry the tool's wording, and an unknown key is named in the message rather than in `unrecognized_keys`.
  **Who is affected:** a REST client that relied on a clamp or fallback.
- **A request past a cap is refused, not served smaller (`Q-109`).** A bulk write with more than 500 items in one array
  refuses the whole batch with a `400` naming the array, before anything is written; it used to drop the items past
  500 and answer with the same `207` as a clean batch. `network_sync_history`'s `limit` is refused outside 1–100 on both
  doors (REST clamped 500 to 100 and let a negative through). The embed-queue listing's `limit` over 200 is a `400`
  where REST echoed it and served 200. **Who is affected:** a caller that relied on the quiet cut.
- **`list_embed_jobs` reaches every job, on a proxy too (`Q-109`).** It is now the act REST's embed-queue listing calls:
  it takes `skip`, reads and sums a proxy space's members, and — on both doors — returns `transientFailures`, the field
  its own description told callers to read and neither door sent.
- **The Graph view draws the whole neighbourhood, not the first page of it (`Q-109`).** Since `graph_traverse` pages its
  nodes under the byte budget, the view sent no `skip` and drew whatever the first page held; it now reads every page
  and joins them. It still says the graph is partial when the walk itself stopped at its `limit`.

- **Breaking:** **REST `POST /api/brain/similar` answers in the `similar` tool's shape (`Q-89`).** Each hit is now
  `{score, spaceId, type, record}` and `source` is `{type, id, summary}`, as MCP has always answered — the route
  used to return flat hits (`{_id, name, …, score}`) and the whole source record with `score: 1.0`, so one
  capability had two shapes by door. **Who is affected:** a REST client of `/similar` reads `hit.record.<field>`
  where it read `hit.<field>`, and `source.id` where it read `source._id`. MCP callers and the web UI see no change.
  The route now answers through the tool, as `/recall` does, so its refusals are the tool's words too; an entry that
  does not exist is still a `404`. And `topK` above 100 is a `400` there, as it always was on MCP, where REST clamped.
- **A search that names no space reads only where the token may read (`Q-89`).** `recall` or `similar` without
  `space`, or `similar` with `crossSpace: true`, searched every space the token could reach — and reaching a space is
  not holding its knowledge, so a token with only `files: read` somewhere had that space's records ranked. The REST
  `/similar` route narrowed its own set; moving it onto the tool showed the tool never did, on either door. Every read
  tool now searches only the spaces where the token holds the tool's area.
- **Every budgeted MCP tool states its size ceilings from one schema (`Q-161`).** `recall`, `similar`, `filter` and
  `read_spill` each carried their own copy of `maxChars`/`maxBytes`/`maxTokens`, and the copies had drifted from the
  rule they all resolve through: MCP refused a `maxBytes` under 1000 and (except `read_spill`) a `maxChars` under 1000,
  where the resolver honours any `maxBytes` and raises a small `maxChars` to 1000. The schema now follows the
  resolver, so MCP accepts what REST always did; `recall`'s `maxTokens` text no longer says it converts onto bytes.

- **A store that cannot complete a write in time answers `503`, retryable, on every door (`Q-213`).** Every
  database operation a write issues while it holds its sequence number, and every operation of a sync push page,
  is now bounded: `YTHRIL_WRITE_TIMEOUT_MS` (default 30 s) per operation and `YTHRIL_HOLD_DEADLINE_MS` (default
  45 s, below the 60 s a peer waits for a push answer) per hold, both new and both refusing `0`. A write the bound
  ends answers `503` with `retryable: true`, a `Retry-After` and a message of ours (never the driver's text) on the
  REST record routes, `POST /api/<tool>`, the MCP tools and every sync push route. A REST write used to answer the
  same store failure `500` while the tool door answered `503`; a sync push route answered `500` for every store
  failure, and now answers `503` when the store is the cause — a sender holds its watermark and re-sends on either.
  A `timeoutMS` in `MONGO_URI` does not apply to these operations: the bound is set on each.

### Fixed

- **Paging through a recall answer no longer repeats some matches and drops others when their text scores tie.**
  Records written from one template score exactly alike in the keyword channel, and the database ordered that tie
  differently on every call. That order is part of the fused ranking, and `skip`/`nextSkip` re-run the search for
  each page, so two identical recalls could rank the same records differently. Ties now break by id, as every other
  ranking step already did. This affects both doors, `recall` on MCP and `POST /api/brain/recall` on REST.

- **A write answered "timed out, retry" can no longer land after the answer** (Q-372). The bound on one database
  write was the driver's own timer, which starts before the command is even sent, so the client gave up first: the
  `503` went out and the space's seq hold was released while the operation was still alive on the server, and it
  could land a moment later. The bound is now the server's own deadline (`maxTimeMS`), so the server ends the write
  and answers; a client backstop 500 ms later covers the one wait the server does not interrupt (an upsert queued
  behind another session's uncommitted insert of the same record — a sync push fork). Reads keep the driver timer.
  A `timeoutMS` in `MONGO_URI` no longer cuts this short either: the driver would hand it to every write that sets
  none of its own and end the write before the server's deadline, so a bounded write is now sent with its own
  `timeoutMS` of 0 beside the server deadline. A page a peer pushes or pulls, and a page of peer tombstones, is
  written in chunks sized so that each chunk is one command to the database (a larger batch is split by the driver
  into several, each with a deadline of its own), and the page's size no longer decides whether a late second command
  can land. The bulk writes whose size is the store's own, not a request's — an entity merge relinking a hub's edges,
  files and links, a directory move, file tombstones, the file hash cache and the usage counters — are written the
  same way, in chunks of at most 99 999 operations (one fewer than the server's write batch size of 100 000, because the
  driver itself cuts a batch there) and 16 MiB, so a set under those limits is the one command it was before; a bulk that
  mixes inserts, updates and deletes is sliced by type, in the order the driver sends them (inserts, updates, deletes),
  because the driver sends one command per type, and an unordered one still attempts every chunk and reports every chunk
  that failed in one error, whose cause is the failure that ended the write when the store or a bound did (so a duplicate
  key followed by a timeout is answered as the retryable `503`, not as a `400`) and otherwise the first failure. The entity merge writes its relinked edges, files and links in
  its transaction, which the server aborts at the first error, so it stops at the first failed chunk and answers with that
  failure as the driver would. When the client backstop does end a write, the log line now says which collection and space it was, and
  the server warns once at boot if `MONGO_URI` carries a `socketTimeoutMS` below the write bound, which the server
  cannot neutralise (leave it unset or above `YTHRIL_WRITE_TIMEOUT_MS`).
  For integrators: the same retryable `503`; a write blocked in that one state is answered up to 500 ms later than
  the bound. No new database privilege is needed.
- **A recall straight after a space's first write no longer answers 503 while its search index initialises**
  (Q-325). A collection's vector index is built after its first record, and until it serves the search service
  refuses queries in several wordings. Recall, `similar` and the write-time duplicate check answer that refusal as
  "nothing from the index yet" and find the new record through the fresh-write scan, but the first wording
  (`Index <name> not initialized`) was not recognised, so for the first moments of a space's life the same recall
  answered 503 or 200 depending on timing. All the wordings are now recognised in one place. The write-time
  duplicate check also keeps its fresh-write matches through that refusal instead of answering none.

- **A small entity merges into a hub of any size** (bundle-30). The merge looked for edge collisions by reading every
  edge of the survivor inside its transaction, where a read must come back in one batch, so merging an entity with
  one edge into a survivor with about eighty thousand failed as a store error. It now looks up only the identities
  the relink produces. A too-large merge counts each kind only up to one past the bound, so refusing a hub no
  longer counts all of it: the refusal then says *more than* the bound, and `relinks` is a lower bound.

- **A strict-linkage violation is no longer recorded for a target later in the same transfer, nor twice for one
  dangling end** (bundle-30). Edges and links received by pull or batch push were checked right after each page
  landed, and a pull lands its families one page at a time — edges before chrono entries, links and files — so an
  edge to a chrono entry created in the same interval was recorded as pointing at nothing. Each record had a fresh
  id, so every re-delivery of the edge added another. A transfer's references are now checked once it is whole (a
  pull after every family of the space, a push after the request), with one existence read per target kind instead
  of one or two per record, a family whose transfer stopped early is not judged, and a violation's id is derived from
  what it says, so the same dangling end is one record and one `link_violation.created`.

  A push request carries ONE family — the sender pushes them one request each — so checking "after the request" was
  not enough on its own: the families were sent edges before chrono entries and links before file metadata, and the
  push door still recorded those edges and links. **The families now travel targets first** (facts, entities, chrono,
  file metadata, edges, links), and the push door leaves the families still to come in that order unjudged. A sender
  older than this release still pushes the old order, and from it an edge to a chrono entry or a link to a file
  created in the same interval can still be recorded; a receiver older than this release, sent the new order, records
  none of them. The protocol reference (`docs/sync-protocol.md`, Push phase and `POST /batch-upsert`) now states
  the order a receiver relies on, where it is read from (`REPLICATED_FAMILIES`), and what a receiver records from a
  sender that pushes references first (bundle-30 I15).

  The push door also no longer waits for the check before answering: it awaited it after the page, outside the
  door's write bound and with no deadline on its read, so a stalled store held the push answer past the sender's
  60 s — the timeout the bound exists to beat. The check now starts after the page lands and runs in a write bound
  of its own. A pull whose fetch failed part-way skipped the check altogether, and the edges that had landed were
  never checked again (re-served, they plan as already current); it now checks what landed, with the family that
  failed and every one after it left unjudged. And grouping the targets copied the list per target, ~1.3 s of
  blocked event loop at 20 000 targets (one 50-page pull); it is now under a millisecond.

- **An error that names `maxTimeMS` because the option was misused is no longer read as a deadline the store
  missed** (bundle-30). The deadline question matched the word `maxTimeMS` in any message, so the store's refusal of a
  misplaced bound (`cannot set maxTimeMS on getMore …`, a `BadValue`) was answered as a retryable `503` timeout on a
  write door and as "the search ran out of time" on recall, predicate recall, the row graphs and the face gallery.
  A deadline is now code 50 or 262, or — only for an error that lost its code — the store's own "exceeded time limit"
  wording.

- **A restored file no longer keeps the replaced copy's vector** (`Q-234`, bundle-30). A restore carries nothing from
  the copy it replaces, and every family did that except file metadata, which is merged rather than replaced: the
  merge removed the replaced copy's retention stamps but kept its `embedding`, `embeddingModel` and `matchedText`.
  The merge now asks the arrival writer's own rule for what the stored row keeps.

- **A peer's file bytes landing here follow this instance's suppression** (bundle-30). The bytes writer queued the
  file for embedding directly, so a file this instance suppresses (its own flag, or the space) was queued, claimed
  and discarded, and kept any vector it had. It now takes the same step as arriving file metadata: a suppressed
  file holds no vector, any other is queued.

- **A store failure is answered by one function on every door** (bundle-30). The REST read helper, the REST error
  handler, the MCP dispatcher and the sync push helper each built the `503` by hand: a REST write's body dropped the
  store's `code` and `codeName` that a read and the tool carry, and five sync POSTs (file tombstones, members, votes,
  change notes, both pairing steps) still answered a store failure `500`. They now all answer `503`, `Retry-After`,
  `retryable: true` — in words of our own, with the store's `code` and `codeName`, on every door and to every
  reader alike — and one retry sentence.

  The rest of the HTTP doors now answer it the same way. `POST /api/brain/recall`, `POST /api/brain/similar`,
  `POST /api/brain/spaces/:spaceId/traverse` and every `POST /api/<tool>` answered `503` without `Retry-After`. About
  forty route handlers answered their own `500 Internal error` without asking whether the failure was the store's —
  among them `POST /api/brain/spaces/:spaceId/entities`, the UI's create form, which showed an operator *"Internal
  server error"* for a condition a retry clears, and every `/api/conflicts`, `/api/contradictions`,
  `/api/duplicates`, webhook, network and sync read route. An edge or link write whose reference lookup failed on
  the store answered `400` with the driver's text — and a missing reference whose own text names `mongot`, `$search`
  or a vector search index (a file `notes/mongot-setup.md`, a space `mongotest`) is the caller's `400`, not a
  retryable `503`, because the store's message patterns are read only from the driver's own errors; `space_rename`
  answered it as `Error (500)` with the driver's text; a space create answered `500 Failed to create space` and
  logged nothing. A file delete through a store failure answered `200` with no sync tombstone written, so a peer
  re-pushed the file; it now answers `503`, and the retried delete writes the tombstone — see the next entry for why
  the retry can. Every one now answers through one sender. A failure on those routes that is NOT the store's still
  answers `500`, now with the body `{"error":"Internal server error"}` (it read `Internal error` on most of them),
  logged with its stack under the route's name — and so is a store failure's log line.
  The store message's retry sentence used to say *"Nothing was confirmed written by it"*, also on a list load or a
  search, which wrote nothing; it now says what is true of both.

- **A file's sync tombstone is written before its bytes go, so a failed delete or move is safe to retry**
  (bundle-30 I13). The tombstone was written after the unlink, after a directory's tree was removed and after a move.
  A store failure on it then left the file gone with no tombstone, and the retry could not repair it: the REST delete
  found no bytes and answered `204` writing no tombstone, a directory delete answered `404`, a move found no source,
  and the TTL sweep failed on the missing file every cycle — while a peer's manifest pushed the file back. Every path
  that removes a file now writes the tombstone first, so a store failure on it answers `503` with the file where it
  was. A file whose bytes are gone while its metadata remains is
  completed on every door (REST delete, MCP `delete_file`, the TTL sweep): tombstone written, record, jobs and
  artifacts removed. A path with neither bytes nor metadata, and a move whose source is not there, answer `404` on
  both doors; MCP answered them with the filesystem's `ENOENT` and the absolute data path. `delete_file`'s description
  said a missing path "succeeds quietly", which was not true; it now says what each door answers.

  A store failure AFTER the bytes now fails the act too (bundle-30 I14). With the store paused, a delete unlinked
  the bytes, failed its job, artifact and metadata steps — each caught and logged — and answered `204`; a move
  carried the bytes, failed to re-key its records and answered `200`. Each step's own failure is still survived,
  but the store's answers `503` on REST and MCP, and the metadata record goes last, so the same request retried
  completes the act: a delete as an orphan, a move by finding the file at its destination and the record at the
  old path, a directory delete (`confirm: true`) by finding records under a folder whose tree is gone. The
  directory delete's cascade moved from the REST route into `files/delete-cascade.ts`.

  **A file tombstone is published only once the file is gone (bundle-30 I15).** Written before the bytes, a
  tombstone was served and pushed at once, and a peer that receives one deletes its copy, keeps the tombstone and
  serves it back — so when the delete or move then failed, the next cycles deleted this instance's own copy, the
  only one left. Withdrawing it afterwards (retried in memory) lost that race to a sync cycle, and to a restart
  outright; a delete whose unlink failed for a reason that was not the store's (a directory, a permission) never
  withdrew it, and the TTL sweep added another every cycle. Now the tombstone is written PENDING and confirmed once
  the bytes are gone or moved; nothing that serves, pushes, prunes or counts file tombstones sees a pending one
  (`GET /api/sync/file-tombstones`, the sync push, the prune, the stray-metadata drain all read them through
  `files/tombstones.ts`). A failed act settles its own from the disk at once, and one that outlives its act is
  settled the same way by the TTL sweep — dropped while the path still has its file, published once it has none.
  `pending` never crosses the wire: served tombstones carry `_id`, `spaceId`, `path` and `deletedAt` only, and a
  confirmed one is stamped with the time it was confirmed.

  **Per path, not per act (bundle-30 I16).** One act's paths lose their bytes at different steps, and a tombstone is
  now published only after its own path's: a move's and a directory delete's conversion sidecars (`_converted/…`,
  `_extracted/…`) are published after the sidecar itself moved or went, and dropped when that step failed, where they
  used to be published with the file — so a sidecar still here was deleted back by every peer. A directory delete
  whose tree removal stopped part way dropped every tombstone, including those of the files it HAD removed, and the
  retry lists only what remains, so peers pushed those back; a failed step is now settled per path from the disk. The
  TTL sweep settles the oldest first, and one whose path it cannot look at goes to the back of the queue rather than
  coming back first every cycle and starving the rest of the space. `<space>_file_tombstones` gains the two indexes
  those questions need (the settle's, partial on `pending`, and the move marker's), on new and existing spaces.

  **One tombstone per path per act, retries included (bundle-30 I17).** A file act a store failure stopped left its
  pending tombstone behind, and its retry published one of its own — and then the first as well: a retried move at
  once, because its settle took every tombstone carrying the move's mark, and a retried delete (one file, MCP
  `delete_file`, a directory) ten minutes later, when the TTL sweep found the path's bytes gone — gone because the
  retry had removed them. A peer deletes its copy for every tombstone it is sent, so the late one deleted a re-upload
  of that path made in between. Now there is one way a tombstone is published, and publishing a path's removes every
  other pending tombstone for that path; the sweep drops a leftover whose path already has a tombstone published
  after it was written (a failed write the store applied late) rather than publish a second. File tombstones gain
  an index on `path` for it.

  **A retried move completes only a move it began (bundle-30 I15).** The completion took any source with records and
  no bytes beside an existing destination for a move still owed — so moving an orphan `a.txt` (its file gone out of
  band) onto an unrelated `b.txt` replaced `b.txt`'s jobs, chunks and sidecars, lost `a.txt`'s record and answered
  `200`. A move's tombstones now carry a mark of the move, the completion requires it, and without it the move is
  `404` and `b.txt` is untouched. "Are the bytes here" has one answer (`bytesPresent`): only a path that does not
  exist is absent, and a failure to look (a permission) is an error rather than an absent source sent down that
  path. The completions ask the store for one record instead of loading every record id under a folder. **A path
  through a regular file (`a.txt/x`) is a path that does not exist (bundle-30 I16):** Linux answers it `ENOTDIR`,
  not `ENOENT`, so MCP `move_file` and `delete_file` of one answered `400` carrying the server's absolute data path,
  REST answered `500`, and the TTL sweep kept such a tombstone pending for ever — all now `404`, and published. Every
  "does this path exist" test in the server reads the one predicate, `isMissingPath`, and a gate holds it there. The
  media worker's "was the source deleted mid-job" check read ANY failure to look as "deleted" and removed what the
  job wrote; it now asks `bytesPresent`, and the conversion's and the manifest's own swallowed stats are gone too.

- **A pulled page is decided by the same rules as a pushed one (`Q-204`, `Q-225`).** The pull accepted whatever was
  newer by seq and validated nothing, so the same document delivered the other way round was decided differently:
  a record this instance holds a tombstone for was stored again, an equal-seq divergent fact lost one side instead of
  forking, a field of the wrong type and a key the schema strips were stored, and a file whose `parentFileId` was a
  number, `0`, `false` or an object became a top-level file. A pulled document now passes its family's `Incoming*`
  schema (a refusal is that document's alone, and the rest of the page lands), is planned against held tombstones and
  the fork caps exactly as on push, and is written by the same writer. One stated difference: a chrono `type`
  outside this space's vocabulary is stored on pull (a push answers `unknownType`), because on pull the schema
  comes from the same upstream and dropping the record would lose it for good. Strict-linkage violations are now
  recorded for every landed edge and link on every door (only the single edge route and the batch's links did).
  The stray-filemeta drain (`Q-219`) checks each record through the same schema as a FILL: the keys it carries must
  be valid, and none it lacks is required, because it writes only what it carries. A record with a key of the wrong
  type or a `parentFileId` of any kind is discarded and counted as refused, where it used to be partly filled; a
  record with no `tags`, `author` or `seq` is still filled.
- **Two peers pushing different text for one fact at one seq at the same moment keep both texts (`Q-232`).** The
  push whose write lost the race found a copy at its own seq and counted itself landed, while its text was stored
  nowhere. A same-seq copy with different content is now a divergence, and forks.
- **A fork keeps the divergent copy's `createdAt` and `updatedAt`.** It was stamped with the moment this instance
  forked it, so its retention window ignored its age and two receivers forking one divergence stored two documents
  under one derived fork id — which the space hash reported as a divergence for ever.
- **An arrival this instance suppresses holds no vector (`Q-230`).** The writer carried the stored copy's vector,
  model and `matchedText` across a peer's update whatever the receiver's suppression said, so a record its author,
  its type or its space retired from semantic search stayed findable by the content it no longer had. A suppressed
  arrival now carries the retention stamps and `syncBase` only, on every door, and a file's derived passages lose
  their vectors with it.
- **An admin import never keeps the stamps or `syncBase` of the copy it replaces (`Q-234`).** A record whose export
  carried no retention stamp kept the replaced copy's, so a record restored to "never expires" went on expiring on
  the old date, and a file kept a `syncBase` the backup never recorded. It now stores the backup's values, a stamp
  the backup lacks from this instance's retention (D-9), and nothing of the replaced copy's.
- **A file-metadata arrival is held to the write guard.** It was merged by `_id` alone, so a newer copy written
  between the accept read and the merge was overwritten by an older one, with a `200` on the way back.
- **Suppression that a network turns on removes the vectors already stored (`Q-230`).** A space whose type or
  space-level `suppressEmbeddings` arrived from a network — a meta pull, a meta round, a space addition, leaving a
  network or changing its precedence — reported its records suppressed and went on ranking them by meaning until
  each was rewritten: only an operator's own edit swept. Every change of the effective meta now sweeps — and so
  does a type schema saved on a space no network carries (`PUT /schema`, the per-type upsert and delete, a schema
  library apply), which swept nothing while the same edit on a networked space did. One change is swept once: a meta
  change applied by a vote was swept two or three times, each a pass over every collection of the space. The sweep
  also covers files and their derived passages (it covered none), removes the model name with the vector (it left
  it behind), keeps `matchedText` (the content did not change), and runs once at every start, so vectors stored
  before this version are cleared without waiting for the next edit. That start sweep begins once the server is
  listening and sweeps one space at a time, so its scans never compete with each other or with the boot.
- **An embed job no longer writes over a record that changed while it was embedding.** The job reads a record,
  calls the model, then wrote the vector by id alone: a peer's newer copy landing during the model call received
  the OLD text's vector and `matchedText` — and a copy this instance suppresses received a vector it must never
  hold. Every write the job makes is now guarded by the seq it read; the newer copy's own job embeds it.
- **Two members holding the same data report the same Merkle root (`Q-307`).** The root hashed each record's
  `spaceId` — which the receiver rewrites to its own id for the space, so a space held under a `spaceMap` alias
  differed in every leaf — and the files that never leave an instance (a conflict copy, a schema snapshot). A
  network with `merkle: true` logged `MERKLE_DIVERGENCE` for such a space on every cycle over identical content.
  **Mixed versions:** a root from an earlier version never equals one from this version, so a `merkle: true`
  network running both reports `MERKLE_DIVERGENCE` for every space until all its members have upgraded. The
  check is advisory and blocks nothing.
- **A refused entity cascade removes nothing.** A cascade a fact, chrono entry or file still blocked deleted every
  blocking edge, wrote their tombstones (so peers deleted them too), and only then answered "cannot delete". The
  whole set is now decided first, and a cascade that cannot finish removes no edge.
- **An edge a cascade removes is never gone without its tombstone.** The tombstone was written after the edge
  was deleted, so a failed tombstone write left the edge gone here and alive on every peer, which brought it back
  on the next pull pointing at the entity being deleted. Each chunk's delete and tombstones now commit together.
- **`delete_entity` no longer says "There is no cascade."** It has one (`cascadeToken`, from
  `delete_entity_preview`), and the description now says so where a caller reads first.
- **A merge reported as failed after its commit landed is answered as merged, and still queues its edges and
  sends its webhooks.** A commit whose reply was lost used to throw past both, leaving re-keyed edges without a
  vector and subscribers never told the absorbed entity was deleted. The merge reads back, while still holding
  the sequence horizon, whether it landed.
- **A merge's first-time model load no longer fails the merge.** The survivor's embedding is computed before the
  merge takes its hold, so a slow model load can no longer outlast the hold's deadline and answer `503`.
- **The tombstone of an edge a merge drops as a duplicate, and of a link it re-keys or a write unlinks, carries
  the seq of the record it deletes** (`originalSeq`). Without it a peer whose watermark never reached the record
  was sent its deletion.
- **An automerge a space refuses is reported once per pair, not twice on every scan.** The scanner recorded a
  pair at a seq it never read for the record it started from, so a refused pair never matched itself and was
  merged again — a whole transaction, rolled back — and warned about from both ends on every scan. The survivor
  of an automerge is now also the older record as configured, rather than whichever the scan reached first.
- **A write the store could not finish in time answers `503` on the create and converge doors too.** A planned
  write whose bulk write the write bound ended was answered per item as "did not complete" through a read-back
  that ran after the deadline; while nothing of the request has landed it is now the store timeout every door
  answers `503 retryable`.
- **A transaction under the sequence hold can read more than one batch of rows.** The driver sends a time limit
  on such a cursor's `getMore`, which the server refuses, so any read of more than 101 rows inside a held
  transaction failed it. A cursor there now asks for every row in its first batch.
- **A write that stalled could stop a space's replication indefinitely (`Q-213`).** While a write holds its
  sequence number, every peer pulling the space is served nothing past it, and nothing bounded the write: a
  document lock held elsewhere, a stalled socket or a transaction retrying a conflict for two minutes held every
  pull of the space with it, while each cycle reported success. The write now ends within the bound above, its
  hold is released when it ends, and the pull continues.
- **A stalled write is visible while it stalls (`Q-200`).** New gauge `ythril_seq_horizon_oldest_hold_seconds`
  per space (0 when nothing is held), and a `seq horizon held <age>s space=… seq=… holder=… ended=…` warning for
  every hold that lasted past half the deadline — once while still open, and when it ends.
- **A record that landed was never queued for embedding when the counter could not move after it (`Q-224`).** The
  arrival writer moved the counter, then booked and queued what landed, in one `finally`; a counter that could not
  move threw out of it first, so the records were stored, never queued, and a re-sent page read them as current and
  never queued them either — and the counter's error replaced the write's own, so an import called every document
  refused over records it had written. Each step now runs whatever the one before did, the write's own error wins,
  and a counter left behind fails the page after what landed is booked and queued: a push answers `500`, a pull
  holds its position, and an import reports what it restored with the new per-family `counterBehind: true` (run the
  import again). The push door's own counter move follows the same rule.
- **A driver argument error drops a peer's document only when the error is that document's own.** Every
  `MongoInvalidArgumentError` was read as the refusal of the document being written, so one that the write bound or
  the call itself raised dropped a peer's document from its sync page for good. A document whose own write the
  driver refuses as an invalid argument is still refused alone, counted in `rejected` with a reason (a single route
  answers `400`); an argument error the write bound caused, or one every document of a page raised, fails the page,
  so it is sent again.
- **A merge of a large entity no longer prints `MaxListenersExceededWarning` (`Q-311`).** Every write inside a
  transaction hung its own listener on the session until it ended, so a merge relinking thousands of edges hung
  thousands of them. A session now carries one, and every write is still reported once after the commit.
- **A file a publisher pushed could freeze its subscriber's copy of the file's description and tags (`Q-239`, as
  in 5.6.2).** The pushed bytes reached the subscriber's upload door, which stored them as the subscriber's own
  upload: its own next seq, itself as the author of a new file, and a description it derived itself. That copy then
  tied or outranked the publisher's next description or tag edit, which was skipped on arrival for good. Bytes a
  peer pushes are now recorded as an arrival, as a download already was (`Q-143`). Arriving bytes, pushed or
  pulled, also make a soft-deleted path live again, and a file new on this instance is given its file retention
  window: a pushed file had that before, a pulled one did not.
- **File metadata a 4.0-5.6.1 pull left in `<space>_filemeta` is now actually recovered (`Q-219`).** 5.6.2's drain
  merged it by seq, but a receiver before 5.6.0 had stamped its OWN seq on the file rows of peers' files it pulled,
  so most stray descriptions counted as older than the stored copy and were dropped with the collection. The drain
  now FILLS a row this instance made itself with the keys it lacks — never over a description or tags it has (an
  automatic caption gives way to the sender's wording), never changing its seq, author or update time — and gives a
  row another instance wrote the usual newer-wins rule. It never creates a row: a record whose file is missing waits
  up to 30 days for the file's bytes, or is discarded when a file tombstone says the file was deleted. It works a
  bounded amount per cycle and resumes, a failing space no longer stops the others and is named in the log, and the
  drop of an emptied collection writes an audit entry, `file.stray_filemeta.drain`. The server's own audit entries
  (sweeps, alias heals, creator grants) now carry a request id of their own instead of reading as older than the field.
- **A peer with more than a thousand deletions of one kind to pass on now passes on all of them (`Q-237`).** The
  tombstone pull asked once, was served at most 1000 per kind, and called itself complete, so every later deletion
  was never applied and never asked for again. The push paged, but lost the part of a run of equal seqs that
  straddled a page (equal seqs are normal for deletions relayed from several instances). Both now page by a
  cursor that re-reads a full page's last seq, and a transfer that cannot finish — a refused request, a page of one
  seq it cannot page past, its per-cycle bound — holds the watermark where it stopped and says so, naming the
  space, the peer and the seq. A peer still on 5.6.x pulls at most 1000 per kind until it upgrades.
- **A tombstone with an impossible seq no longer reaches the counter by pull (`Q-221`).** The push refused it; the
  pull checked nothing, so a peer could drag this instance's seq counter into its ceiling reserve with one
  tombstone. Both doors now refuse it on its own, log it, and do not move the counter to it — and a refused
  tombstone no longer moves the pull's cursor past the real deletions after it.
- **A record pulled from a peer was never queued for embedding (`Q-203`).** It was stored and absent from every
  meaning-ranked search on this instance until somebody ran a reindex. Pulled records are now queued by this
  instance's suppression rules, like pushed ones. **Records pulled before this release** stay without a vector until
  queued: run `POST /api/spaces/:id/reembed` (Settings → Spaces → Danger Zone → Backfill embeddings) once per
  synced space.
- **A new entity pushed through the single `POST /api/sync/entities` route was never embedded.** It was inserted
  by a write that never reached the embed queue.
- **A push could leave this instance's seq counter below what it had received (`Q-198`).** The single push routes
  never moved it, `batch-upsert` left out links and file metadata and moved it only after answering, and
  `POST /api/sync/tombstones` did not wait for it. Every push door now moves the counter past every seq it received
  before it answers, so the next local write never takes a seq below a record a peer already holds. A fork is then
  written with a seq above the arrival that caused it.
- **A peer's edit erased this instance's own vector and retention stamps.** A pushed or pulled update replaced the
  whole document, so the record stopped expiring here, dropped out of vector search until re-embedded, and was
  re-embedded even when its text had not changed. They are now kept across the update — the vector only while this
  instance still embeds the record: an arrival this instance suppresses (by the record's own mark, its type's
  schema or the space) keeps no vector, model or matched text (`Q-230`, above).
- **A record pushed under a `spaceMap` alias kept the sender's space id**, so every list and lookup on this
  instance missed it. It is now stored under the local space id, as a pulled record always was.
- **A stale tombstone was deleted before the record that superseded it was written**, so a write that then failed
  lost both. It is deleted only once the record has landed.
- **A page holding the same id twice could store the older copy**, on pull and on import. The highest seq now wins,
  and two copies at the same seq keep the first — the same reading the push door has always applied.
- **`POST /api/sync/tombstones` accepted any number as a seq.** A tombstone with a seq inside the protocol's ceiling
  reserve is now refused on its own (and logged); it used to refuse every later copy of its record and drag the
  counter towards the ceiling.
- **A duplicate link in a push answered `500`**, so the sender re-sent that page for ever. It is now `skipped`.
- **A database fault while writing a pulled page was reported as an unreachable peer.** It counted toward
  `PEER UNREACHABLE` and named only the driver error. It now holds that family's position, logs a record-write
  failure naming the space and family, and the page is fetched again next cycle.
- **A refused document in a push or pull no longer goes unnamed:** one warning per page names the ids and the
  reason, where duplicate-key warnings used to list `(unknown)`.
- **A peer could forge a line in this instance's log.** A document id or a peer label containing a line break was
  written into the log as it arrived, so a peer could add a line that read exactly like this server's own. Every
  value a peer sends that reaches a log line on the push, pull or import path is now written with its control
  characters escaped (`\r`, `\n`, `\u001b`), so it stays visible and stays on its line.
- **A new space could stay "building" until the next restart.** Once its search indexes were ready, the space
  recorded that in config.json, re-reading the file first so a concurrent edit is kept. On Docker Desktop the file
  is a bind mount, and a read that landed while the file was being rewritten failed with `ENODATA` — and the
  first such failure was taken as final. A read spoiled by a concurrent writer is now retried a few times; any
  other error is still reported at once.
- **A peer could miss a record for good when two writes overlapped (`Q-196`).** A write took its sequence number
  a moment before it stored the record, and every page a peer pulls served whatever sequence numbers were stored —
  so a later write that finished first could be handed out while an earlier one was still being stored, the peer
  moved its watermark past it, and never came back for it. Every seq-paged route (the five record families,
  `filemeta`, `tombstones`), the push loop and the duplicate and contradiction scanners now stop below any write
  that has not finished; a write's sequence number is taken as part of the write and released when it settles,
  including inside a transaction, which holds it until it commits.
- **A bulk edge whose end was a `$ref` to a fact or chrono entry was stored as an entity end (`Q-193`)** when the
  item did not state the kind: it was checked for existence as the fact it named and stored pointing at an entity
  that did not exist, so a traversal from the fact never found it. The edge now stores the kind of the record the
  key names.
- **A chrono entry rewritten through its `id` kept the vector of its old content (`Q-192`).** The converge branch
  never queued the re-embed the insert branch queues, so the entry's search vector described what it no longer said.
- **A record retired from meaning-ranked search got a vector anyway when it was rewritten without restating the
  flag (`Q-194`)** — on every create endpoint with `waitForEmbedding` or `checkDuplicates`, through a batch, and on
  the survivor of a merge. The write now decides suppression on the record it leaves: the stored flag unless the
  write states one.
- **`save_bulk` on MCP accepted a retired or unknown key and wrote nothing (`Q-195`)**: `{"memories": […]}`
  answered success while the REST door refused it with a `400` naming `facts`. Both doors now run the same check
  and refuse the same keys with the same message.
- **An edge created with a property its label's schema defaults was stored without the default**, although the
  default was what passed validation; the stored edge now carries the value that was checked.

- **A reindex embedded different text from the write that created the record, and never rebuilt a passage or a
  caption (`Q-99`, part 2).** Its five hand-written loops were a copy of the embed queue's text builder that had
  drifted: an edge whose end is a fact, a chrono entry or a file embedded that end's raw id instead of its name, and
  a converted document re-embedded without its own text, because the loop never read the `excerpt` it passed on.
  Derived records were skipped outright, so after a model change every passage and media caption kept the old
  model's vector. And a backfill (`reembed`) gave a vectorless passage, face crop or converted copy a vector of its
  PATH (`docs/a.pdf#chunk0`). One builder now serves all of them: a passage or caption is rebuilt from its own text
  (`chunkEmbedText`, shared with the conversion pipeline), a derived record with no text is left without a vector
  (any path-vector a backfill gave it is removed), and a passage of a file whose owner suppressed its embeddings, at
  any depth, is not embedded.

- **The client never shows an answer older than the one you asked for last (`Q-112`).** The graph's depth slider
  started a traversal on every step it passed and drew whichever answer arrived last, so a slow depth-3 answer
  could land over depth 4 — and a depth drawn from the cache could be redrawn by a deeper request still in flight.
  It now asks once the slider rests and cancels what it no longer needs. The record tabs (entities, edges, facts,
  chrono) let a slow answer to an old filter replace the new filter's rows, and a list load could replace a
  semantic search's rows or the reverse; every answer that writes a tab's rows now goes through one latest-wins
  slot (`core/latest-wins.ts`, which the tab search bars had privately), and so do the graph's selected-record
  card and linked records. Opening a record resolved each linked fact and chrono title with its own request; it
  is one request per kind now. The schema library asked `…/usages` once per entry to show its link counts;
  `GET /api/schema-library` now answers `usageCounts` beside the entries, counted by the function the per-entry
  route uses. The Brain page's chunk was 292 kB against a 260 kB budget and the space settings dialog's 179 kB
  against 175 kB; deferring the tabs that are not where each opens brings them to 194 kB and 42 kB, and the budgets
  are tightened to hold that. The nine unused standalone imports the build warned about are gone, and an unused
  one now fails the build.
- **The Query tab's walk headings show their counts (`Q-101`).** "Reached by the walk", and the Entities, Facts,
  Chrono and Files headings under it, rendered `({count})` literally in all three languages, and each reached record
  read `{hops} hop(s)`: the values used single braces, which the translation layer does not interpolate. A client
  spec now fails on a single-brace placeholder in any value of any locale, and on a German or Polish value that
  interpolates different parameters from the English one.
- **Buttons that name an action say it in German and Polish (`Q-115`).** "Clear results" read "Klare Ergebnisse"
  (clear as in transparent) and the entity search's Clear read "Klar"; in Polish they read "Jasne", Reset read
  "Nastawić" (to set a clock) and Close the infinitive "Zamknąć". They now read "Ergebnisse löschen" / "Leeren",
  "Wyczyść wyniki" / "Wyczyść", "Zresetuj" and "Zamknij". The Query form's Projection field had the same fault
  ("Vorsprung", "Występ") and now reads "Projektion" / "Projekcja". A client spec derives every English label that
  starts with Clear, Reset or Close and fails when the German or Polish value does not contain a verb that does it.
  The same fault on the product's noun: German called a space a "Leerzeichen" (the typed whitespace character) in
  8 places — "Noch keine Leerzeichen" on the Brain page, "Leerzeichen erstellen/löschen" on the MFA card — and
  Polish a "spacja" in 11; they now say "Space" / "przestrzeń" as the rest of each file does, and the same spec
  fails on any value whose English names a space and whose German or Polish uses the whitespace word.
- **A space delete no longer loses a race with the media worker, and one unfinished delete no longer blocks every
  space operation until a restart.** Deleting a space while the worker was still converting one of its files failed
  `ENOTEMPTY` when removing the files directory — the worker was writing artifacts under it — and the delete kept
  its marker, as it must. But the marker was only ever resumed at boot, so every later rename and delete on the
  instance answered `500 "… is still pending … It resumes automatically on restart"`. Three fixes: every removal of
  a space's directories retries what a concurrent writer causes (one helper, `files/remove-tree.ts`); a space being
  deleted or renamed away refuses new file writes at the file door, which the media worker treats as an abandonment,
  like a moved file's; and the next rename or delete finishes a pending op before it proceeds, refusing only when
  that fails again — with the reason. Found by a Docker integration run, where it cascaded into sixteen failures.
- **A recall across spaces ranks by relevance, not by which spaces had a text match (`Q-82`).** Each space fused
  its own candidates only when its text search found something, so a cross-space answer mixed rank scores near
  0.03 with cosine scores near 0.3-0.9: without a reranker every result of a space whose text search missed came
  before every result of one whose text search hit, whole spaces in blocks; with one, the rerank's unscored tail
  did the same. `recallGlobal` now fuses the merged pool once — one ranking by meaning over every candidate, and
  each space's per-type text ranking as its own channel — so every result carries a `fusedScore` from the same
  fusion, spaces interleave by relevance, and the reranker picks its candidates by that order. **Who is affected:**
  a `recall` naming several spaces, a proxy, or no space — the ORDER of its results, and the values of `fusedScore`
  and `vectorRank` on them (now computed over the merged candidates). A recall over one space is unchanged.
- **A proxy space no longer gets collections at boot, and a hand-edited `proxyFor: []` is a real space everywhere
  (`Q-80`, `Q-98`).** `initAllSpaces` walked every configured space, so each boot created a proxy's collections —
  which creating it never made and deleting it (a config-only removal) never dropped; the restore index rebuild
  walked proxies too. And "is this a proxy" was answered about forty times in two spellings that disagreed on an
  empty member list: such a space was served as a real space and skipped as a proxy by the embed worker, the
  duplicate and contradiction scanners, the prunes and the metrics, and deleted as a proxy with its collections left
  behind. The loader now removes an empty `proxyFor` on load and reload (with a warning), `isProxy` is the only
  test, and every walk over the spaces that own collections iterates one `concreteSpaces()`, which also answers the
  pre-setup case once. **Who is affected:** an instance with a proxy space (its boot stops creating collections for
  it; ones already created are left as they are, empty), and one whose config was edited by hand to hold
  `"proxyFor": []` (that space starts being embedded and scanned).
- **A space schema-change round reached no peer (`Q-108`).** `meta_change_pending` was sent to every member and was
  not an event `POST /api/notify` accepted, so each peer answered `400` to a sender that does not read the answer.
- **An unknown tool name no longer becomes a metric label (`Q-108`).** It was counted in `ythril_tool_calls_total`
  before the `404`, so any caller could mint a time series per spelling.
- **The notify event store is bounded by bytes, not only by count (`Q-108`).** 500 events of up to the JSON body
  limit each could hold gigabytes; it now holds at most 1 MiB, oldest out first.
- **Moving a file or folder leaves nothing at its old path, even while the file is still being processed.** A
  document's conversion that finished after the move wrote its chunk records under the path the file had just
  left — a folder that no longer existed, with nothing to ever delete them (caught on CI by `files.test.js`,
  two records left under a moved folder). The conversion now commits its records in one transaction that holds
  only while its job is still claimed, and a move takes that claim before any bytes leave, then re-queues the job
  at the new path. A run that finds its moved file missing no longer "cleans up a deleted file" either — which
  deleted the job and records the move was carrying. And a move now carries everything a file owns: a renamed
  file's chunks used to stay at the old path, a moved folder's chunks kept naming parents that no longer existed
  (so deleting the moved file removed none of them), and the `_converted/`/`_extracted/` sidecars moved for
  neither. REST `PATCH /api/files/:spaceId` and MCP `move_file` now run the same move (`files/move-cascade.ts`).
  **And a moved folder keeps its files' links** (`Q-164`): renaming one file re-created its links under the new
  path, but moving a folder re-rooted the records and left every link naming a path that was gone, so each file in
  it silently lost what it was linked to. Both now carry links through one step.
- **Every list that stopped at a number now says so and can be read to the end** (bundle-34). Owner rule: *"if i
  get a result i want to be sure i get what i asked for."* Each now pages through one rule (`brain/list-page.ts`):
  whole rows, `limit` and `skip` refused rather than floored when they are not numbers, the byte budget, and
  `count`, `total`, `limit`, `skip`, `truncated` and `nextSkip` on every answer.
  - **`graph_traverse` and `POST /api/brain/spaces/:id/traverse`** answer whole nodes in hop order under the byte
    budget, each page carrying the edges back to nodes already delivered, with `skip`/`nextSkip` and `remainderDump`;
    `limit` still caps the walk and a walk that hit it says `limitReached` (`Q-132`).
  - **The duplicate and contradiction review lists** page instead of stopping at 500; the Review tab reads every
    page (`Q-127`).
  - **A file's extract** returns its converted Markdown whole, or in whole paragraphs that page to the end with
    **Show more** — it was cut mid-sentence at 256K characters — and its image list says when it is cut (`Q-128`).
  - **The schema dry-run** says, per collection, how many records it checked against how many exist and whether the
    check was complete, and pages its violations (`Q-129`).
  - **The notify event list** pages and says when it is cut (`Q-130`).
  - **Resolving entities by id** in the web UI asks for every id instead of dropping those past 100 (`Q-131`).
- **A network joined before the join default now syncs on its own.** 5.6.0 gave a new join a schedule (every 15
  minutes, or the inviter's), but a network joined earlier kept none and pulled only when its peer started a cycle —
  seen on an instance whose two joined networks had no schedule at all. It gets the default at the next start, named
  in the log. Clearing a schedule now stores manual as a choice (`""`) rather than as nothing, so manual set on
  purpose is never replaced; one cleared before this change reads as never set, so it is scheduled once.

- **A peer keeps one token, not one per join (`Q-163`).** Every network joined with the same instance minted it a
  new token and left the previous one valid, though the peer keeps only the newest and could never present the
  others: an instance showed eight `peer:` tokens for one peer, seven of them last used minutes after they were made.
  A completed handshake now revokes the tokens it replaces, on both sides and for club pairings too, and an instance
  drops the unused leftovers when it starts. A token still in a handshake is left alone, since two joins can overlap.

- **A closed or democratic network connects every member too, on its own votes (`Q-154`).** Only the member that
  held a newcomer's credentials used to admit it; every other member concluded the join vote and connected to
  nobody. Now a passed join round introduces the newcomer on every member and the two pair as club members do, and
  a newcomer trusts the list of the member that admitted it. A roster entry anyone else proposes — on a network
  whose members joined before this, with their votes long pruned — waits under **Connecting** for the operator's
  **Accept** (`POST /api/networks/:id/introductions/:instanceId/accept`, MCP `network_introduction_accept`,
  instance-admin), because a member of a voted network votes and one member's word must not let it in. A refused
  pairing is retried after half a minute, doubling to five: members learn of a passed vote at about the same moment,
  so a first call that arrives before the other side has concluded it is a race, not a refusal.
- **A slow or failing reranker no longer holds every search (`Q-157`).** Measured on a 5.6.0 instance: every
  recall took 20 s — the reranker's time limit — and was answered in fused order anyway, while the same recall
  without reranking took 90 ms. A reranker pass that fails, runs out its own time limit, or takes more than half of
  it now sets the reranker aside for 30 s, doubling to 5 min; searches in between skip it at once and still report
  `degraded: ["rerank_unavailable"]`. A background probe, never a user's search, brings it back. The assist
  model's fallback rule and this one are now one module.
- **A record's text rank is its rank among records of its own type (`Q-159`).** The text channel sorted every
  type's matches together by raw MongoDB text score, whose scale is each collection's own, so a fact could outrank
  an entity only because facts are longer — the comparison reciprocal rank fusion exists to avoid. The Query tab
  now says what `fusedScore` is: a rank score, `1/(60 + rank by meaning) + 1/(60 + rank by text)`, about 0.016 to
  0.033, never a similarity. Every fused result also carries the two ranks it came from, `vectorRank` and
  `lexicalRank` (absent when the text search missed it), on both doors, and the Query tab shows them beside the
  figure — so the score can be checked rather than taken on trust.
- **`filter`'s `total` counts what a name join matches (`Q-160`).** With `fromName`, `toName` or `entityName`, the
  rows were right and `total` counted the whole collection — `count: 2, total: 86` on a space of 86 edges — so a
  caller comparing the two, as the tool tells it to, read on for pages that did not exist. Reported by the platform
  operator; both doors.
- **The Query tab's structured mode is called Filter (`Q-156`)**, the name it has as the `filter` tool and
  `POST /api/filter`; it was *Advanced Query*.
- **The Query tab folds its search to one line once results arrive, says how long the search took, and expands or
  collapses every result at once (`Q-158`).**
- **A club is a mesh: every member connects to every other member, not only to whoever admitted it (`Q-135`).**
  An admission landed on the admitting instance alone, so two members admitted by the organiser never learned of
  each other and the club stopped when the organiser did. Now each member learns the others from its peers'
  rosters during the gossip every sync cycle already runs, and the two pair directly with a new two-call exchange
  on the peer protocol (`POST /api/sync/networks/:id/pair` and `/pair/confirm`), so an existing club heals on its
  next cycle without re-joining. A club removal travels to every member the same way. `GET /api/networks/:id` and
  MCP `network_get` answer `introductions` — members still being connected to, with why an attempt failed — and the
  network card lists them under **Connecting**. Club only: pub/sub and trees are star and tree by design, and voted
  networks follow in `Q-154`, because a peer's roster must not stand in for a vote.

- **The Graph tab says why it is slow instead of spinning with nothing on it (`Q-155`).** After three seconds of
  waiting it says the server has not answered yet and names what the space is doing — search indexes being built,
  records waiting to be embedded — and after thirty seconds the wait ends in the error state with those reasons
  and Retry. Reported on 5.6.0 while an upgraded instance rebuilt every space's search indexes.

### Security

- **No door answers a store failure with the database driver's text.** A dropped connection, a failed server
  selection or a step-down arrives with a driver message that names internal hosts, addresses and ports
  (`connection 5 to 172.16.0.9:27017 closed`). The REST brain read routes and the MCP tools put that message in their
  `503` body, and the REST error handler did the same for every route that lets a store failure reach it, including
  routes a peer or an unauthenticated caller reaches. Every door — REST reads and writes, `POST /api/<tool>`, MCP
  tools and sync push — now answers one message of ours, in one spelling, *"A store-side failure stopped this
  operation. It did not complete as far as this server can confirm; retry the request (store-side failure;
  retryable)."*, with `retryable: true`, `Retry-After` (on every HTTP door), and the store's own `code` and
  `codeName` when it gave them. The driver's message, with any cause it attached, is logged once per request as a
  `Store-side failure answered 503` warning naming the operation that failed — the route, the method and path when
  the app's error handler answered it, or `tool <name>` from MCP (bundle-30 I15: only a route's own catch named it,
  so a store failure under an edge or link reference check, one reaching the error handler, and every MCP tool's
  logged a line naming nothing; the operation is now a required argument of the one function that writes it). A client that
  matched the old prose should read `retryable` and `code` instead. That includes
  `POST /api/networks/:id/sync?wait=true` and `POST /api/networks/peers/:peerId/sync?wait=true`, which answered a
  cycle's failure as `500 { error }` with the exception's own message.

  A store failure is recognised by what the driver says it IS — its class, its error labels, the server's code —
  not by a list of error names. The list could not see a subclass: the error the driver raises when it clears its
  connection pool (`MongoPoolClearedError`, a network error by class) answered `400` with the driver's text, naming
  the internal host, address and port, to whichever request was in flight when a store went away. A driver error
  that is recognised as nothing in particular now answers `500` with *"An internal database fault stopped this
  operation; its cause is in the server log."* rather than a `400` carrying its message. What the database server
  itself refused — a malformed query, a validation failure — still answers `400` in its own words.

  A failure under a bulk write (`insertMany`, `bulkWrite`) is classified by the error the driver wrapped (bundle-30
  I14). The driver rethrows whatever is thrown under one as a `MongoBulkWriteError`: a server error by class, with no
  code, and — for a server it could not select, which is how a paused store arrives — no label. So a paused store
  answered `400` with the store's address on any door a bulk write reached, and the file delete it reached took it
  for "not the store's" and went on without its tombstone. A write concern failure, bulk or single, is the store's
  too (`503`): no caller chooses one here. A bulk write's refused documents — a duplicate key — are still the
  caller's `400`.

- **A model server's error text is bounded and escaped where it is quoted** (bundle-30). When a chat model server
  answered with an `error`, its text was quoted whole into the error the call raised — and from there into a log
  line and an answer. It now goes through the one renderer every peer-supplied text uses, cut at 200 characters
  (saying how much it cut) and escaped.

- **Every log line is one line, and every value in it is bounded (`Q-231`, `Q-214`, `Q-270`).** The escaping above
  covered the push, pull and import paths; a member label arriving by gossip, a vote round id, a caller's parameter
  on a REST brain or MCP door, a driver's error text and the meta argument of any log call still reached a line raw,
  so a peer could still forge a governance line, and a megabyte `seq` or `_id` made a megabyte line in the ring,
  the container log and every aggregator after it. One renderer (`peerText`, `peerList` for a list) now redacts,
  cuts at 4096 characters per value (100 per list) saying how much it cut, and escapes; every door's log lines go
  through it (a gate holds them to it), the meta argument goes through it where every line is built, and the line
  as a whole is escaped. The same bound applies where such a value is named back in an answer: a sync refusal's
  reason, the fork-limit `400`, and an admin import's `refused`, `schemaViolations` and `restoredOverTombstone`.
  A reference refusal on the REST and MCP write doors (a link, an edge end or a file reference that is malformed
  or names nothing) names its first five references each cut at 256 characters and escaped, where it echoed a
  caller's megabyte reference whole — and the count of the rest is now written `…(+N more)`, where it read
  ` (+N more)`. A key a door does not take is quoted by the same bound on both doors: a REST body's
  `Unknown field(s)` and `unrecognized_keys` name the first 10 unknown keys, and an MCP call's `unexpected property`
  its key and path, each cut at 256 characters and escaped — both echoed a caller's key whole. A sync refusal that
  quotes a schema's issues or the driver's message (200 characters) now says where it was cut and never splits a
  character in two.
  An error logged with its stack keeps the stack, escaped onto its line, with its message bounded.
  Error text that is STORED and read back goes through the same renderer: an embed job's `lastError`, a reindex
  run's `error`, a media job's error and a webhook delivery's `error`, and a supervised worker's child error, where
  each was cut by code unit (and the webhook's not at all). The `500` bodies of the admin wipe, export, config
  reload and signing-key routes bound the message they quote, and the uncaught-exception, unhandled-rejection,
  readiness and unhandled-error lines pass the error itself, so the stack is kept and the message bounded.
- **Redacting a log line no longer takes time that grows with the square of a value (`R9`).** The userinfo pattern
  (`scheme://user:pass@`) could start a match at every character of a run of letters and scan the rest of the run
  from each: 40 000 letters took 0.7 s, so a peer's megabyte `_id` of letters held the event loop for minutes on
  the line that logged it. The pattern now starts a scheme only where no scheme character precedes it, which is
  linear, and a value is redacted over a bounded window before it is cut. The 5.6.x line carries the same pattern.

- **A peer's tombstone is applied to the space its sync admitted, never to the space the tombstone names
  (`Q-236`).** Both tombstone doors — a peer's push and this instance's pull — applied each tombstone to the space
  written inside it. So a peer admitted to one space could delete records it authored in any other space this
  instance holds, and store tombstones there or in a space this instance does not have. And under a `spaceMap`
  (a space joined under another name) every deletion an honest peer sent was stored under the network's name and
  **never reached the local space**: those deletions were silently lost. Every tombstone is now applied to the
  local space the door admitted.
- **A tombstone is authorised before it is stored.** One whose issuer is not the peer delivering it, or whose
  record here another instance wrote, is refused and no longer stored — stored, it refused every later copy of that
  record from its real author.
- **A tombstone no longer blocks another author's record.** A record its author pushes with its own peer token is
  no longer refused as `tombstoned` by a tombstone another instance issued for the id, so a tombstone one peer
  planted cannot keep another instance's record out. A claimed author is not enough: pushed by anyone else, a
  record with a deleted id is still refused, so a forged author cannot bring a deleted record back.
- **What stays as it was, named:** a record with no author (data older than authorship) stays deletable by an
  admitted peer's own tombstone; tombstones a peer already planted in a space it was not admitted to stay where they
  are, because they cannot be told apart from legitimate ones; a 5.5 peer serves tombstones without the settled
  horizon, as before.
- **`POST /api/duplicates/:id/merge` merges only where the token may merge (`Q-304`).** It looked its candidate up
  in every space where the token held `dataQuality` **read**, and the guard in front of it asked only whether the
  token could write anywhere. So a token that could only read a space's duplicate candidates, and could write in
  any other space, merged a pair in the first one, deleting an entity there. The candidate is now looked up only
  where the token holds `dataQuality` **write**, the rung the route's rights row always named, and the merge also
  needs `knowledge` **write** in the pair's space, the rung the REST entity merge and MCP `graph_merge` require.
  A candidate the token may not merge answers `404`, as dismiss and reopen do. The duplicates, contradictions and
  conflicts routes now look a record up by id through one function whose rung has no default.

### Internal

- **CI runs as parallel jobs behind one gate, every run measures itself, a skip is refused unless it was expected, every
  test file is reached, and there is one way to wait (bundle-56: `Q-370`, `Q-272`, `Q-283`, `Q-319`).** Nothing in the
  product changes; this is how the tests that guard it are run and trusted. What a contributor will notice:
  - **Parallel CI.** `Build & Test` is a gate-only job that waits for the rest and fails unless each succeeded; the
    client tests, the pure and the database-backed standalone files start at once, and the jobs that drive a running
    instance wait for one `prepare` job that builds the test image, each starting only the services its suite needs.
    Only a push to `main` writes a cache. Release lines keep their single-job workflow. The new `docs/testing-guide.md`
    (also offered in the in-app Help) describes the job graph, the caches and the stack's per-job budget.
  - **Timing records.** A `node:test` reporter writes one line per test, suite and file to `test-results/` for every
    standalone, stack and preflight run, and each CI job uploads its folder; a file without its closing line is
    incomplete, never passed. `scripts/test-times.mjs` can record the runs to a Ythril instance you point it at and
    read the trend back (optional, for maintainers).
  - **Skips are refused unless expected.** An input a test needs goes through one module that skips on a laptop and
    throws on CI; a skip CI expects carries `expected-in-ci:` and one cause, from a listed file; print-and-return
    skips and silent exits became real skips or assertions, and the embedder skips go through `requireEmbedding`.
  - **Every test file is reached.** `scripts/unrun-tests.mjs` subtracts what CI selects from the tracked test files,
    `scripts/executed-tests.mjs` subtracts what produced a test event, and a nested standalone test file is refused.
  - **One wait helper.** `testing/_shared/wait-for.mjs` decides what a timeout says, whether a thrown probe ends the
    wait, whether a hung probe can outlast the deadline and that no timer is left armed; hand-written polls moved onto
    it and a gate refuses a new one unless it says `// waits-differently:` and why.
  - **The test Mongo's search heap is explicit** (`YTHRIL_TEST_MONGOT_A_HEAP`, with a larger limit for the first
    database), and the test stack's budget is held per set of services one `compose up` starts. The document sidecars
    in the test stack are hardened like production and bound to loopback, and `doc-office` joins the integration job.
  - **The recorder's declaration and the published reports.** `node scripts/test-times.mjs --type-schema` prints the
    `schema_update` call that declares the `Test-Run` type with its one-year retention, so the retention is something a
    maintainer can send rather than something that depends on someone having once typed it. The client's test report
    is masked (first line, token shapes, home paths, 300 characters) before the CI job uploads it, as the node
    suites' lines already were; a report the step cannot read is removed rather than uploaded. The masker handles a
    long line in time proportional to its length. `--record-ci` stops at the first run already recorded without
    downloading its artifacts, does not write an empty row for a recorded run whose artifacts have expired, and does
    not fail every pass over one artifact that can never be read.
  - The test stack's four app instances now publish their ports on `127.0.0.1` only, like the database and the sidecars.
  - The in-app Help no longer shows links that go nowhere: the dependencies, contribution and testing guides named
    repository files (`LICENSE`, `NOTICE`, package manifests) as links, and now name them as code, with a gate over every page
    Help lists. A link from one part of a split guide to a sibling part (`](02-hosting.md)`, 42 of them in the integration
    and user guides) opened a dead tab; Help now resolves a link against the directory of the guide it is read in, so it
    opens in Help and the guides stay correct on GitHub. Inside one guide such a link takes the reader to the start of the
    page it names (every part of a split guide has an anchor at its start; a link to the guide itself goes to its top) and
    moves keyboard focus to the heading there, as a link to a heading does. A heading whose id is a property of `document`
    (`## Links`) lost its id to the sanitizer's DOM-clobbering protection and could not be linked to; it now has the
    `user-content-` form of the id, and a link to `#links` finds it. A heading with an `&` in it (`## Duplicate Scanner & Action Rules`)
    got the id `…-amp-…` instead of the GitHub one every link and help control uses, so linking to it scrolled nowhere;
    the id is now slugged from the heading's text. The gate now replays both rules over every link and `#anchor`.
    A link inside a guide also writes its place to the URL (so a reload and Back keep it); keyboard focus lands on the
    part's own anchor, named with the part's title, rather than on the first heading after it; a link into another guide
    with no place in it takes focus to that guide's first heading; and a change of the URL's `#fragment` while Help is
    open scrolls and focuses like a link click.
  - The suite READMEs and the contribution guide no longer carry hand-written file lists or container counts.
- **The test database no longer runs out of memory by the time CI reaches the standalone suite.** MongoDB keeps a
  dropped collection open for five minutes for snapshot reads, and the suites drop thousands in that window: after
  the integration suite alone, `ythril-mongo-a` held 9 766 dropped collections and 25 714 open storage handles over
  147 live collections, at 2.06 GiB of its 2.5 GiB cap, with the standalone suite still to run on it. The test
  stack now sets that window to five seconds (`tuneTestMongo`, called by `testing/sync/setup.js` and by every
  database-backed test file), which freed the 9 000 within 40 seconds; nothing in the server reads an old snapshot.
  The database-backed standalone files also run in their own batches, four at a time, in `test:standalone` and
  `preflight` alike: at the full width some timed out on the one-CPU test database, and four finished in half the
  time.
- **A database test whose setup fails now fails, instead of hanging the run.** The test harness kept its Mongo
  connection open when a setup step threw after connecting, and node's test runner waits for every file's process
  to exit, so one such file held `test:standalone` with no output for as long as the CI job lived. The harness now
  closes what it opened on a failed setup, and the CI job has a 90-minute ceiling, so a hang nobody has found yet
  fails the run instead of holding it.
- **A gate proves no read-rung door can reach a write into a space (`Q-97`).** `a-read-never-writes-a-space`
  derives every door a `read` token may call — `TOOL_RIGHTS` and `ROUTE_RIGHTS` rows at `read`, every mounted GET
  without a row or on a `NOT_AREA_SCOPED` path — walks what each call causes, and fails on any path to a space
  write, printing it door to writer. The writers are derived alias-aware (`_space-writers.mjs`): a mutator through
  `col()`, `.collection()`, a local binding of either or a helper that returns one, on a per-space collection or
  the sequence counter, plus filesystem writes on the space file tree. `_call-graph.mjs` can now root an MCP tool
  handler and a REST handler closure, and resolves method calls through namespace imports and exported objects. The
  one exception is the `/api/sync/*` GETs rebuilding the file-hash cache, scoped to that collection. Its first run
  found no read door writing a space; its first red run found that REST `recall`, `similar` and `traverse` answer
  through a runtime tool lookup the walk could not see, now resolved.
- **A gate compares each tool's bounds with its route's (`Q-109`).** `a-tool-and-its-route-agree-on-bounds` pairs
  every tool with its route through the capability map, reads the route's bounds from the zod schemas its handler
  reaches (walking the call graph, so a schema parsed inside an act counts), and compares `min`/`max`/`minLength`/
  `maxLength`/`minItems`/`maxItems`/`enum` and requiredness per shared parameter. A route that hands its body to
  `callTool` agrees by construction and is detected, not listed; fields `BOUND_BY_FIELD` names are left to the
  Q-108 gate, whose validator derivation both now share (`_validator-schemas.mjs`). Its first run found
  `network_join_remote`'s schema silent on `inviteCode`'s 8 192-character limit, which the route and the act already
  refused; the schema now states it from the same constant. Routes that validate by hand are counted, and may only
  get fewer.
- **Every read of stored records by a list of ids goes through one reader (`Q-211`).** `readStoredById` (a Map) and
  `readRowsById` (rows in the caller's id order) read in chunks of 500 with a few chunks in flight, project to the
  fields the caller names or to everything but the never-returned fields, AND a caller's predicate with the ids
  instead of spreading it beside them, and give every chunk its share of the caller's deadline. The graph walk's
  second reader, recall's fresh-hit hydration and duplicate check, the reference and delete guards, traverse
  bodies and the rest moved onto it; several of them read every id in one query before. One fix came with it: the
  walk's reader spread its narrowing beside `_id`, so a narrowing that named `_id` replaced the id list. A gate
  (`a-record-is-read-by-id-through-one-reader`) fails on a by-id read anywhere else unless its function is
  allowlisted with the reason it asks a different question.
- **The call graph the source gates walk sees a call written as an argument of another call, and follows a
  closure built at module scope (`Q-309`).** Its call scans consumed the character before a name, so in `f(g(x))`
  the call to `g` was invisible to every gate built on it.

## [5.6.5] — 2026-10-06

**A patch release with two fixes for defects in 5.6.4, and nothing else.** Paging through a recall answer no longer
shows some matches twice and others never, and links between the pages of a guide in the in-app Help work.

| What changes on upgrade | What to do |
|---|---|
| Two identical recalls over an unchanged space return their matches in the same order | Nothing. A caller that pages with `skip` / `nextSkip` now sees every match exactly once |
| A link from one page of a guide to another opens that page in Help | Nothing |

Documents changed in this release: `docs/dependencies.md` and `docs/contribution-guide.md`; their references to files
outside the guides are now shown as file names rather than links, because Help can open only the guides themselves.

### Fixed

- **Recall: paging no longer repeats or skips matches.** When several records matched a query's words equally well
  (typical for records written from one template), they came back in a different order on every call. A caller paging
  through the answer with `skip` / `nextSkip` could therefore see some records twice and miss others. Equal matches are
  now always returned in the same order. This applies to the MCP `recall` tool and to `POST /api/brain/recall` alike.
- **Help: links between the pages of a guide work.** A link from one page of a guide to another opened an empty
  browser tab; it now opens the page in Help, scrolls to it and moves keyboard focus there. The page you are on is kept
  in the address, so reloading or going Back returns to it, and a link into another guide focuses that guide's first
  heading. Links to a section whose title contains `&`, or is titled `Links`, now land on that section.

## [5.6.4] — 2026-10-05

**A patch release: every fix PR #1483 made on `main` for a defect present in 5.6.3, and nothing else.** It follows
the owner's decision that a patch on the 5.6 line carries fixes only: what `main` changed in behaviour, wire or
defaults alongside them stays on `main` and is named at the end. The ones to take first are the Security fixes: a
duplicate merge could delete a record in a space where the token could only read data quality, a store failure was
answered in the driver's own words (its host, its port, its collection), and a value a peer or a caller chose reached
a log line or a refusal at any length and across lines. It also makes the suppression sweep reach files and run at
every start, keeps both texts of two divergent same-seq pushes, and makes an entity cascade that is going to be
refused remove nothing.

| What changes on upgrade | What to do |
|---|---|
| Every start, once the server listens, sweeps the stored vectors of everything a space suppresses — records, files and file chunks — one space at a time; a space with no `meta` is swept by its records' own flags | Nothing; expect one scan per record kind per space at each start, and `Suppression sweep: removed N <kind> vector(s) in <space>` where it removed anything (for files N counts rows, chunks and passages included) |
| Every log line is one line: a stack is written on one line with its breaks as `\n`; an `Error` passed to the log is rendered by its message and frames, without the `Error:` prefix; a string passed as the extra argument is no longer JSON-quoted | Match a stack on the single line, not across lines |
| A value in a log line is cut at 4096 characters, a list at 100 items, and the line says how much was left out (`…(+N chars)`, `…(+N more)`) | Nothing; a value that fits is written exactly as before |
| A store failure's `error` text is one of our own sentences, at the status the failure already had; the driver's message is in the server log under the operation that failed | Read `retryable`, not the prose; an operator greps the log for the operation named in the failure line |
| Two statuses move with that text: an error of ours that merely names the store (a path such as `notes/mongot-setup.md`) answers as the refusal it is, no longer as a retryable `503`; and a failure underneath a space rename or create that used to read as a `404` or `409` because the driver's words matched now answers `500` | Nothing; a pooled connection cleared under a command keeps its `400`, now with `The store is not available right now.` |
| A refusal that lists references or unknown keys cuts each at 256 characters and ends `…(+N more)` where it read `(+N more)` | Nothing for a client that reads the list; a client matching the old tail text must match the new one |
| A search right after a space's first write answers `200` and empty, not `503` | Nothing; retry logic that waited on that `503` can stop |
| A duplicate merge needs `knowledge` write, and `dataQuality` write, in the space where the pair lives; a pair elsewhere answers `404` | Grant the rights to a token that merges, or merge with one that has them |
| A fork written from now on keeps the divergent copy's `createdAt` and `updatedAt`; a fork already stored keeps the stamps it has | Nothing; on a network of mixed versions the same fork differs in its timestamps until every member runs 5.6.4 |
| A link violation 5.6.3 stored under a random id gets one derived twin on the next delivery of its document, and the twin announces `link_violation.created` once | Nothing; dismiss the older row if you do not want both |
| A duplicate pair stored with a seq of `0` (or none) is not re-fired by the first scan; its real seqs are stored as each pair is next scanned | Nothing; a merge that keeps the older record now keeps it whichever end the scan started from |
| A pull names, once per page, a document it kept its own copy over (same seq, other text) and a document it stored that does not match its schema | Nothing; the lines are in the receiver's log |
| The reindex INFO line gains a field: `Reindex completed for space '<id>': reindexed=N, suppressed=N, superseded=N, errors=N` | A script reading that line reads the new field; the others keep their place |
| A failed sync cycle's entry in the sync history reads the error's message, without the error class in front of it | Nothing |

Documents changed in this release: `docs/sync-protocol.md`, `docs/integration-guide/02-hosting.md`,
`docs/integration-guide/03-auth-and-limits.md`, `docs/integration-guide/04b-graph-api.md`,
`docs/integration-guide/06a-schema-api.md`, `docs/integration-guide/09-sync-api.md`,
`docs/integration-guide/10-mfa-and-conflicts.md`, `docs/integration-guide/14-duplicates-and-webhooks.md`,
`docs/integration-guide/15-about-and-embedding.md`, `docs/integration-guide/16-mcp.md`,
`docs/userguide/02-brain.md`, `docs/userguide/04-settings.md` and `docs/userguide/05-storage-data-and-audit.md`,
and `CLAUDE.md`, whose claims about what a pull validates and what file metadata unsets now match the code.

### Security

- **A duplicate merge needs the merge rights where the pair lives (`Q-304`).** `POST /api/duplicates/:id/merge` looked
  its candidate up in every space the token could READ data quality in, and the guard in front of it asks only whether
  the token may write anywhere — so a token with `dataQuality` read in one space and write in another merged a pair in
  the first, deleting an entity where it could only read. The lookup now walks only the spaces where the token holds
  `dataQuality` write (the rung its rights row names), and a merge, which deletes a record, also needs `knowledge` write
  in the pair's space, as the entity merge and `graph_merge` do. A candidate in a space where the token lacks either
  answers `404`, as dismiss and reopen do. Contradictions and conflicts keep the rungs they had (a resolve there still
  acts on `dataQuality` write alone); the three copies of the space list each router wrote are gone.
- **A store failure is answered in our words, never the driver's.** A driver's own message names the host, the port and
  the collection it failed on, and the doors that answered it handed it to whoever asked. Every door that answered an
  error's own text — the read routes, the MCP dispatcher, the admin, data, file and space routes, the sync triggers, the
  join and rename acts — now answers a fixed sentence of ours when the failure is on the driver's side, at the status it
  already had; what the server refused in its own words (a malformed regular expression) and what this server refused
  keep their text, and so does the `$vectorSearch is not supported` sentence that tells an operator to upgrade
  MongoDB. The driver's message goes to the server log, once, under the operation that failed. An embed or media job
  that failed on the store stores that sentence and the error's class in the `lastError` a read token is served, and a
  sync cycle's failure list says it the same way, without the class in front of the message. A driver-side failure
  underneath a space rename or create, which a mapping read as `404` or `409` when the driver's words matched, answers
  `500`. A pooled connection cleared under a command keeps its `400` and says `The store is not available right
  now.`, with no "try again", since `retryable` is `false` there; `main` answers that case `503`, which stays on
  `main`.
- **A refusal or a log line no longer carries a megabyte a peer or caller chose, or a line break.** 5.6.2's notes said
  every value a peer sends that reaches a log line was written with its control characters escaped. It was escaped, but
  not bounded, and some slots were raw: a value a request, a peer or a backup could reach was interpolated as it came,
  and a stack ran across lines. Every value already escaped for a log line is now also cut at 4096 characters, the line
  saying how much (`…(+N chars)`), and a list at 100 items; every log line is one line — a value's line breaks, and a
  stack's, are written as escapes; an `Error` is rendered by its message and frames; and every raw interpolation of an
  outside value a request, a peer or a backup can reach into a log line goes through the one renderer, which a
  structural gate now derives from the mounted routes and the start-up code. The refusals that quoted a caller's
  reference, an unknown key or a fork-capped `_id` cut each at 256 characters and name the rest with `…(+N more)`
  (it read `(+N more)`); `unrecognized_keys` keeps every key, each cut at 256. A model server's own error text is
  quoted at 200.
- **Credentials in a URL are redacted in linear time.** The URL pattern backtracked over a run of scheme characters, so
  a long run of letters in a peer's id took seconds of event loop to log. It is now linear and redacts exactly what it
  did, including a scheme that follows digits (`9https://u:pw@h`).

### Fixed

- **A search right after a space's first write answers `200` and empty, not `503` (`Q-325`).** The vector index is built
  after the first record and mongot refuses a query against it with `Index <name> not initialized`, a wording recall did
  not know. One recogniser now knows every wording the store uses.
- **A search is no longer reported as out of time because its error names `maxTimeMS`.** The store names the option
  whenever it refuses a misplaced one, which is a defect in the bound, not a deadline.
- **An error of ours that mentions the store is no longer a retryable store failure.** A refusal quoting a path such as
  `notes/mongot-setup.md` answered `503` and told the client to retry it for ever; the message patterns are now read
  only from errors the driver raised, and our own `$vectorSearch is not supported` sentence is a typed error that stays
  `503`. The refusal answers with its own text at `400`, where it answered `503`.
- **Two peers pushing different text for one fact at one seq could lose one of the texts (`Q-232`).** Each push is
  planned against what is stored; when neither is stored yet, both plan an insert, the first write lands, and the
  second write's read-back compared only the seq — so it counted itself landed with its text stored nowhere, and the
  sender was told it had been delivered. The writer now compares the text too. A copy that finds another at its own seq
  with different text is a divergence on every push door, forked by the same rules as a planned one (the fork already
  made, and the fork caps), never `inserted`. A **pull** does not fork on 5.6.x: it keeps the local copy, advances past
  the document, and names its id once per window in one line per page — `kept the local copy; N document(s) arrived at
  the same seq with different text` — where it used to say nothing. The pulled text of such a document is not stored.
- **A fork carried the moment this instance made it instead of the moment its text was written.** It now keeps the
  divergent copy's `createdAt` and `updatedAt`: stamped "now" it was a record whose age was this instance's sync
  schedule — a fresh retention window however old the text — and two receivers forking one divergence on different days
  stored two different documents under one id. Forks written from now on keep them; forks already stored keep theirs.
- **An older copy of a file's metadata could overwrite a newer one.** The merge's write filtered on the id alone, so a
  copy stored between the accept read and the write was overwritten, with a `200` on the way back. The write now
  carries the seq condition every other family's does, in the filter, with no extra read.
- **An embed job could write a vector onto a newer copy of its record (`Q-230`).** The job reads a record, calls the
  model — the slow step — and wrote the vector, the model and the matched text by id alone, so a peer's newer copy
  that landed inside the model call got the old text's vector, or a vector this instance suppresses. Every write the job
  makes now lands only on the version it read; one that matched nothing ends as the new outcome `superseded`, which is
  done, never retried, and counted by a reindex as done. The media and pipeline derived-vector writers are not changed.
- **Suppression did not reach files, network layers, or vectors stored before it was set (`Q-230`).** The
  stored-vector sweep ran after a PATCH of a space and nowhere else, covered four record kinds, removed the vector and
  left its model name, stopped at the first kind the store refused, and removed its queued jobs with one delete over
  every id. A network's schema layer, a schema route on a space no network carries, and the schema library's apply swept
  nothing; and a peer's file metadata, which is merged rather than replaced, kept this instance's vector on a file
  it suppresses (and its chunks theirs). The sweep now runs after every write of a space's meta, however it was made,
  coalesced per space; covers files and their chunk and passage rows; removes the vector and its model, never the matched
  text; isolates each kind, naming the ones that failed in one warning; and works in pages, so a large space is never
  one delete. It runs again at every start, once the server listens, one space at a time. A file arrival this instance
  suppresses — by its own flag, the stored one, or the space — now lands with no vector, model or matched text, and its
  chunks lose theirs before the row is written. 5.6.2's notes said an arrival this instance suppresses keeps no
  vector; that held for records and not for files. A schema layer that turns suppression on removes this instance's local
  vectors: that is the receiver applying its own effective suppression.
- **A refused entity cascade had already removed every blocking edge.** A fact, chrono entry or file that names the
  entity blocks the delete, and a cascade does not remove those; it refused after it had deleted the edges, written
  their tombstones and spread those removals to every peer. The refusal is now decided on the preview before anything is
  removed, and answers with the list it decided on.
- **An edge delete could leave the edge gone here and alive on every peer.** The edge was deleted first and its
  tombstone written after, so a tombstone that failed to write (a refusal, a step-down, a dropped socket) left nothing for
  a peer to learn the deletion from, and the next pull brought the edge back. The tombstone is now written first, then
  the edge deleted — with no transaction and no hold on the seq horizon. A failure between the two leaves a tombstone
  beside a live edge, which a retry completes; the retirement of the edge's embed job and the webhook follow both and
  cannot fail the delete. The edge is read for its seq, tombstoned and deleted by id, the same window every other delete
  has. This is the edge delete only: an entity, a fact, a chrono entry and a link still delete before they tombstone.
- **Merge and link tombstones named no seq (`originalSeq`).** The duplicate edge a merge drops, the link it moves off the
  absorbed entity, the absorbed entity, and a link a reconcile removes were tombstoned without the seq of the record they
  delete, so a peer that never held the record was offered the deletion. Each carries it now.
- **The duplicate scanner read one end of a pair at seq 0.** The seed of a pair was read without its seq, so which
  record counted as older depended on which end started the scan: an automerge kept the newer record under
  `dupeMergeSurvivor: 'older'`, a pair was stored with a `0` for the seed, a pair the space refuses (a strict schema)
  was merged and refused again from each end on every scan, and the manual merge door followed the ids. Both records
  are read at their real seq. The survivor is now the configured one — the older record by default, which is what the
  setting is documented to do — whichever end started the merge. A stored seq of `0` or none is unknown, not changed, so
  a pair a 5.6.3 scan stored is not re-fired or re-opened by it, and its real seqs are stored as it is next scanned;
  the manual merge reads both records' current seqs while a stored one is unknown. The seq is never in the answer of
  `similar`.
- **A strict-linkage violation was recorded again on every delivery.** Each record had a fresh random id, and the
  single `POST /api/sync/edges` checks an arriving edge on every delivery, so one dangling end became one more
  record — and one more `link_violation.created` — each time its edge was re-sent or edited. The id is now derived from the
  document type, the document, the field and the target, the record is written once, and the announcement fires only
  for one that was inserted. Two different dangling ends stay two records. A record 5.6.3 stored under a random id gets one
  derived twin on the next delivery of its document, with one announcement, and no more after it. What is stored of the
  reason, which quotes the target a peer sent, is now bounded.
- **A pull stored a document whatever its shape (`Q-225`, the 5.6.x half).** It now parses each document against the
  schema a push holds it to — through one table and one parse shared with the push doors — and refuses only a shape that
  would corrupt the receiver: a `parentFileId` that is present and not a string (it turns a file into a half-derived
  row), and the id and seq refusals the writer already made. Everything else is stored as received, as 5.6.3 stored
  it, and each stored document that fails its schema is named, once per page, with its reason (`stored N document(s)
  that do not match their schema`). Refusing them, as a push does, stays on `main`: a pull cannot tell its sender from what the
  sender's own copy was.

### Changed

- **`delete_entity` no longer says "There is no cascade."** Its description named the cascade nowhere while its own
  `cascadeToken` parameter offered one. It now says `cascadeToken` turns the call into a cascade, and that a refused
  cascade removes nothing; `delete_entity_preview` says the same of a refusal.

### Not carried — stays on `main`

Each of these shipped beside the fixes above in PR #1483 and changes behaviour, a wire shape or a default, so it waits
for the next minor.

- **The write bound and its environment defaults:** a bound on each write and on how long the seq horizon is held, set
  by environment variables, whose expiry answers `503`.
- **The seq-horizon gauge:** the per-space metric and warning that make a stalled hold visible.
- **The pull's tombstone and fork semantics (`Q-204`):** a pull here keeps the local copy at a same-seq divergence and does not fork.
- **The merkle hash change:** the space hash keeps the fields it hashes in 5.6.3.
- **The file-tombstone pending model:** a file tombstone reaches peers only once its act happened, with the `404` and `503` answers that come with it.
- **The merge cap of 2500 records:** a merge that would relink more answers `422`.
- **The strict-merge refusal status:** a refused strict merge keeps the status it has.
- **The push family order and the timing of linkage checks:** a push applies its families in the order 5.6.3 does.
- **The pool-cleared `400` becoming `503`:** the status of that failure stays `400`, with `retryable` `false`.
- **`Retry-After` on every `503`:** it stays on the brain read routes that carry it today.

## [5.6.3] — 2026-10-03

**A patch release: sync's tombstone and file-metadata fixes from `main`, and five defects found in 5.6.2, and
nothing else.** The one to take first is a security fix: a peer's tombstone was applied to whatever space it named,
so a peer admitted to one space could delete its own records in another, and under a `spaceMap` every deletion an
honest peer sent was lost. It also makes a peer with many deletions pass on all of them, makes the stray
file-metadata recovery 5.6.2 shipped actually recover the descriptions, and corrects three things 5.6.2's notes
said that were only partly true.

| What changes on upgrade | What to do |
|---|---|
| The first boot builds one index per space on its tombstones (`type`, `seq`) | Nothing |
| A stray `<space>_filemeta` collection 5.6.2 had not dropped yet is now recovered at most 2,000 records per space per cycle; a record whose file has not arrived waits up to 30 days | Nothing; where 5.6.2 already dropped the collection there is nothing left to recover |
| `POST /api/sync/tombstones` answers `{ applied, refused }` and takes at most 5000 tombstones per request | Nothing for a Ythril peer (it sends 500); an integrator reading `applied` keeps its meaning |
| The first pulls after a long absence carry up to 5000 deletions per kind per request, 200 requests per cycle | Nothing; a peer still on 5.6.2 or earlier pulls at most 1000 per kind until it upgrades |
| A record its author pushes is no longer refused by a tombstone another instance issued for its id | Takes effect for pushes received by an instance on 5.6.3 |

Documents changed in this release: `docs/sync-protocol.md`, `docs/network-types.md`,
`docs/integration-guide/02-hosting.md`, `docs/integration-guide/09-sync-api.md`,
`docs/integration-guide/12-admin-api.md`, `docs/integration-guide/13-audit-log-api.md`,
`docs/userguide/04-settings.md` and `docs/userguide/05-storage-data-and-audit.md`.

### Security

- **A peer's tombstone is applied to the space its sync admitted, never to the space the tombstone names
  (`Q-236`).** Both tombstone doors — a peer's push and this instance's pull — applied each tombstone to the space
  written inside it. So a peer admitted to one space could delete records it authored in any other space this
  instance holds, and store tombstones there or in a space this instance does not have. And under a `spaceMap`
  (a space joined under another name) every deletion an honest peer sent was stored under the network's name and
  **never reached the local space**: those deletions were silently lost. Every tombstone is now applied to the
  local space the door admitted.
- **A tombstone is authorised before it is stored.** One whose issuer is not the peer delivering it, or whose
  record here another instance wrote, is refused and no longer stored — stored, it refused every later copy of that
  record from its real author.
- **A tombstone no longer blocks another author's record.** A record its author pushes with its own peer token is
  no longer refused as `tombstoned` by a tombstone another instance issued for the id, so a tombstone one peer
  planted cannot keep another instance's record out. A claimed author is not enough: pushed by an admin token or by
  a peer that is not the author, a record with a deleted id is still refused, so a forged author cannot bring a
  deleted record back. This takes effect for pushes an instance on 5.6.3 receives.
- **What stays as it was, named:** a record with no author (data older than authorship) stays deletable by an
  admitted peer's own tombstone; tombstones a peer already planted in a space it was not admitted to stay where they
  are, because they cannot be told apart from legitimate ones.

### Fixed

- **A peer with more than a thousand deletions of one kind to pass on now passes on all of them (`Q-237`).** The
  tombstone pull asked once, was served at most 1000 per kind, and called itself complete, so every later deletion
  was never applied and never asked for again. The push paged, but lost the part of a run of equal seqs that
  straddled a page (equal seqs are normal for deletions relayed from several instances). Both now page by a
  cursor that re-reads a full page's last seq, and a transfer that cannot finish — a refused request, a page of one
  seq it cannot page past, its per-cycle bound — holds the watermark where it stopped and says so, naming the
  space, the peer and the seq.
- **A tombstone with an impossible seq no longer reaches the counter by pull (`Q-221`).** The push refused it; the
  pull checked nothing, so a peer could drag this instance's seq counter into its ceiling reserve with one
  tombstone. Both doors now refuse it on its own, log it, and do not move the counter to it — and a refused
  tombstone no longer moves the pull's cursor past the real deletions after it.
- **File metadata a 4.0-5.6.1 pull left in `<space>_filemeta` is now actually recovered (`Q-219`).** 5.6.2's notes
  said the drain merged it "never over a newer copy"; but a receiver before 5.6.0 had stamped its OWN seq on the
  file rows of peers' files it pulled, so most stray descriptions counted as older than the stored copy and were
  dropped with the collection. The drain now FILLS a row this instance made itself with the keys it lacks — never
  over a description or tags it has (an automatic caption gives way to the sender's wording), never changing its
  seq, author or update time — and gives a row another instance wrote the usual newer-wins rule. It never creates a
  row: a record whose file is missing waits up to 30 days for the file's bytes, or is discarded when a file
  tombstone says the file was deleted. It works a bounded amount per cycle (2,000 records per space) and resumes;
  a page whose counter could not be moved is kept for the next cycle; a failing space no longer stops the others
  and is named in the log; and the drop of an emptied collection writes an audit entry,
  `file.stray_filemeta.drain`. The server's own audit entries (sweeps, alias heals, creator grants) now carry a
  request id of their own instead of reading as older than the field.
- **A file whose metadata arrived before its bytes never expired (`Q-250`).** 5.6.2's notes said a file new on
  this instance is given its file retention window; that held only when the bytes arrived first. When a peer's
  metadata arrived first — by push or by pull — it created the row with no expiry, and the bytes then found the
  row and never stamped it. The row the metadata creates now takes this instance's file window too, once; a later
  copy or the bytes never re-slide it, and a space with no window stores none.
- **A stale push could delete a deletion written meanwhile (`Q-253`).** 5.6.2's notes said a stale tombstone is
  deleted only once the record that supersedes it has landed; that held for a record that landed. For a record
  older than the stored copy the cleanup deleted the id's tombstone by id alone, after reading it — so a tombstone
  written for the id in between, at a higher seq, was deleted with it, and the record it was meant to remove lived
  on. That cleanup is now bounded by the stored copy's seq in the delete itself.
- **A record rewritten while it was being embedded could keep its old vector (`Q-249`).** The rewrite re-queued
  the record's embed job, and the worker's late finish then matched the job by its id alone: a success deleted the
  new job, so the new text was never embedded, and a failure wrote the old attempt's backoff over it. A finish now
  names the claim it holds and matches nothing once that claim is gone.
- **A restore left a file with chunks the backup does not hold (`Q-251`).** The import replaces one row per id, so
  a file stored with more chunks than the backup has kept the extras — text the restored file no longer has, still
  matched by recall. A file whose row the restore carried and wrote is now left with exactly the backup's derived
  rows (chunks and face records). A file the backup does not carry, or carries without any derived rows, is left
  alone, and the import's log line counts what was removed.
- **A restore that stopped part-way could report records as restored while the counter was behind them
  (`Q-252`).** When the writer stopped on a later chunk after an earlier chunk's counter move had failed, the
  family reported the earlier chunk as restored, though the next local write could take a seq below it. The family
  is now answered as errors, as a clean write with the counter behind already was, and the log says re-running the
  import repairs it.

### Changed

- **`POST /api/sync/tombstones` checks each tombstone on its own, answers `refused`, and takes at most 5000 per
  request.** A malformed tombstone, or one whose seq the counter cannot carry, is refused alone and the rest of the
  page applies; the answer is `{ applied, refused }`, where `applied` keeps its meaning (the tombstones admitted by
  shape and seq) and `refused` is new and additive. A malformed page used to be refused whole with a `400`, which
  held the sender's watermark and stopped every deletion from it. A tombstone of a type the receiver does not know
  still answers `400`, so the sender re-sends it after the receiver upgrades. More than 5000 tombstones in one
  request is a `400`; this instance sends 500. A tombstone page also costs the same handful of database commands
  whatever its size, on both doors, instead of several per tombstone.

## [5.6.2] — 2026-10-02

**A patch release: every fix on `main` for a defect present in 5.6.1, and nothing else.** The ones to take first
are sync's: a record pulled from a peer was never queued for embedding, so meaning-ranked search on the receiver
could not find it; a push could leave this instance's counter below a record it had received, so a peer could
miss the next local write; and a publisher's file descriptions and tags could fail to reach a subscriber, which
this release also recovers for files synced before it. It also makes the space export carry links, makes the
import restore what the export wrote, and stops a peer from forging a line in this instance's log. Breaking changes
and features already on `main` are not part of it; they ship in the next minor.

| What changes on upgrade | What to do |
|---|---|
| Records pulled from a peer by 5.6.1 or earlier have no vector here and stay out of meaning-ranked search | Run `POST /api/spaces/:id/reembed` (Settings → Spaces → the space's Danger Zone tab → **Backfill missing embeddings**) once per synced space. Pace a large space with `limit`: embedding runs on the server's main thread in 5.6, so it answers more slowly while the backlog drains, and your own new records wait behind it |
| A subscriber's first pull now queues every record it receives for embedding, in the same queue as local writes | Nothing to run; expect embedding of your own edits to lag until a large first pull has drained |
| A space export now carries the space's links | Take a fresh export: one made by 5.6.1 or earlier restores without its links |
| An import now moves this instance's counter past the records it restored | Nothing |
| A duplicate link in a push is counted as `skipped` instead of answering `500` | Nothing; a sender that was re-sending that page for ever now moves on |
| A tombstone pushed with a seq too close to the protocol ceiling is refused and logged; the rest of the push applies | Nothing |
| File metadata a pull stored in a stray `<space>_filemeta` collection since 4.0 is merged into the space's files, and the collection dropped | Nothing; one log line per space says how many records were merged |

Documents changed in this release: `docs/sync-protocol.md`, `docs/integration-guide/09-sync-api.md`,
`docs/integration-guide/12-admin-api.md` and `docs/userguide/04-settings.md`.

### Fixed

#### Sync

- **A record pulled from a peer was never queued for embedding (`Q-203`).** It was stored and absent from every
  meaning-ranked search on this instance until somebody ran a reindex. Pulled records are now queued by this
  instance's suppression rules, like pushed ones. Records pulled before this release need the reembed above.

- **A new entity pushed through the single `POST /api/sync/entities` route was never embedded.** It was inserted
  by a write that never reached the embed queue.

- **A push could leave this instance's seq counter below what it had received (`Q-198`).** The single push routes
  never moved it, `batch-upsert` left out links and file metadata and moved it only after answering, and
  `POST /api/sync/tombstones` did not wait for it. Every push door now moves the counter past every seq it received
  before it answers, and a pulled page moves it as it lands, so the next local write never takes a seq below a
  record a peer already holds. A fork is written with a seq above the arrival that caused it.

- **File metadata pulled from a peer never reached this instance's files.** Since 4.0 a pulled page of file
  metadata was written to a collection nothing reads, so a subscriber that pulls (rather than being pushed to)
  never received a publisher's file descriptions and tags. It is now merged into the files the same way a pushed
  page is. Metadata pulled before this release is recovered on upgrade (`Q-219`): the next housekeeping cycle
  (within five minutes of start) merges each space's stray `<space>_filemeta` collection into its files, never over
  a newer copy and never over this instance's own size and hash, then drops the collection and logs one line per
  space. A description that lands this way is re-embedded once this instance holds the file's bytes.

- **A file a publisher pushed could freeze its subscriber's copy of the file's description and tags.** The pushed
  bytes reached the subscriber's upload door, which stored them as the subscriber's own upload: its own next seq,
  itself as the author of a new file, and a description it derived itself. That copy then tied or outranked the
  publisher's next description or tag edit, which was skipped on arrival for good. Bytes a peer pushes are now
  recorded as the publisher's, as downloaded bytes already were (`Q-239`). Arriving bytes, pushed or pulled, also
  make a soft-deleted path live again. A file new on this instance is now given its file retention window: a pushed
  file had that before, a pulled one did not.

- **A peer's edit erased this instance's own vector and retention stamps.** A pushed or pulled update replaced the
  whole document, so the record stopped expiring here, dropped out of vector search until re-embedded, and was
  re-embedded even when its text had not changed. They are now kept across the update — the vector only while this
  instance still embeds the record: an arrival this instance suppresses (by the record's own mark, its type's
  schema or the space) keeps no vector, model or matched text, as 5.6.1 left it.

- **A record pushed in a batch under a `spaceMap` alias kept the sender's space id**, so every list and lookup on
  this instance missed it. It is now stored under the local space id, as the single routes and the pull already did.

- **A stale tombstone was deleted before the record that superseded it was written**, so a write that then failed
  lost both. It is deleted only once the record has landed.

- **A page holding the same id twice could store the older copy**, on push, pull and import. The highest seq now
  wins, and of two copies at the same seq the first is kept.

- **A push re-sent after a lost answer forked a divergent fact again.** A fork's id is now derived from the record
  and the arrival that caused it, so the re-sent push finds the fork it already made and is answered `forked` with
  its id, writing nothing — also when the parent has reached a fork cap since, where it used to be refused.

- **`POST /api/sync/tombstones` accepted any number as a seq.** A tombstone with a seq inside the protocol's
  ceiling reserve is now refused on its own and logged; it used to refuse every later copy of its record and drag
  the counter towards the ceiling.

- **A duplicate link in a push answered `500`**, so the sender re-sent that page for ever. It is now `skipped`.

- **A database fault while writing a pulled page was reported as an unreachable peer.** It now holds that family's
  position, logs a record-write failure naming the space and family, and the page is fetched again next cycle.

- **A document a push or pull did not store is named.** One warning per page names the ids and the reason, where
  duplicate-key warnings used to list `(unknown)`.

- **A queueing failure after an arrival was silent.** If the record could not be queued for embedding, or the
  counter could not be moved, nothing was logged; both are now warnings, and one failing no longer skips the other.
  A counter that could not be moved past a pulled page also holds that family's position, so the page is fetched
  again next cycle; a push answers `500` for it, as it does for any failed write.

#### Security

- **A peer could forge a line in this instance's log.** A document id, a file path or a peer label containing a
  line break was written into the log as it arrived, so a peer could add a line that read exactly like this
  server's own. Every value a peer sends that reaches a log line on the push, pull and import paths — and in the
  rest of sync: gossip, votes, members, change notes, file sync and the sync triggers — is now written with its
  control characters escaped (`\r`, `\n`, `\u001b`), so it stays visible and stays on its line.

#### Export and import

- **The space export left out links (`Q-206`)**, so restoring it lost every link between records. It now streams
  every replicated family.

- **The import kept what this instance derives, and never moved the counter (`Q-205`).** An import stored the
  export's vector model and matched text, kept the retention stamps as text (so the retention sweep never acted on
  them), and left this instance's counter below the restored records. It now leaves out what this instance derives,
  restores the stamps as dates, and moves the counter past every plausible seq it restored. A restored record holds
  exactly the stamps and file sync bases its backup carried, never the replaced copy's. A family whose counter
  could not be moved is answered with every document counted in `errors`, though it is stored; run the import
  again.

### Internal

- **A database test whose setup fails now fails, instead of hanging the run.** The test harness kept its Mongo
  connection open when a setup step threw after connecting, so one such file held `test:standalone` for as long as
  the CI job lived. The harness now closes what it opened, and the CI job has a 90-minute ceiling.

## [5.6.1] — 2026-10-01

**A patch release: every fix since 5.6.0 for a defect present in 5.6.0, and nothing else.** The one to take first
is sync: two overlapping writes could leave a peer missing a record for good. It also fixes bulk writes that
stored the wrong edge kind or a vector a record had retired, a reindex that embedded different text from the write
that created a record, a cross-space recall ranked by the wrong signal, and a set of space, file, network and
client defects. Breaking changes and features already on `main` are not part of it; they ship in the next minor.

| What changes on upgrade | What to do |
|---|---|
| A recall across several spaces is ranked by one fusion over the merged results, so its order changes | Nothing; a caller that pinned an order across spaces should re-read it |
| A network joined before 5.6.0's join default gets the default schedule at boot | Nothing; a network set to manual stays manual |
| A peer that completes a new handshake has the older tokens it replaces revoked | Nothing; every member should run 5.6.1 so each side keeps one token |
| A space whose config was hand-edited to `"proxyFor": []` is loaded as a real space, with a warning | Nothing, unless that space was meant to be a proxy |
| `GET /api/notify` answers `400` to a `limit` or `skip` that is not a number, where it fell back to the default | Send numbers, or leave the parameter out |
| `PATCH /api/networks/:id` with `syncSchedule: ""` stores manual (`''`) instead of dropping the field | Nothing, unless you relied on `""` meaning unset |

### Fixed

#### Sync and networks

- **A peer could miss a record for good when two writes overlapped (`Q-196`).** A write took its sequence number
  a moment before it stored the record, and every page a peer pulls served whatever sequence numbers were stored —
  so a later write that finished first could be handed out while an earlier one was still being stored, the peer
  moved its watermark past it, and never came back for it. Every seq-paged route (the five record families,
  `filemeta`, `tombstones`), the push loop and the duplicate and contradiction scanners now stop below any write
  that has not finished; a write's sequence number is taken as part of the write and released when it settles,
  including inside a transaction, which holds it until it commits. A record a peer pushed with a sequence number
  above this instance's own counter is still served.

- **A network joined before the join default now syncs on its own.** 5.6.0 gave a new join a schedule (every 15
  minutes, or the inviter's), but a network joined earlier kept none and pulled only when its peer started a cycle.
  It gets the default at the next start, named
  in the log. Clearing a schedule now stores manual as a choice (`""`) rather than as nothing, so manual set on
  purpose is never replaced; one cleared before this change reads as never set, so it is scheduled once.

- **A peer keeps one token, not one per join (`Q-163`).** Every network joined with the same instance minted it a
  new token and left the previous one valid, though the peer keeps only the newest and could never present the
  others, so unused tokens piled up. A completed handshake now revokes the tokens it replaces, on both sides, and an instance drops the unused leftovers
  when it starts. A token still in a handshake is left alone, since two joins can overlap.

- **A member that learned a join vote from another member no longer admits the joiner on its own vote**
  (`Q-154`). On a closed or democratic network only the member holding the joiner's credentials may add it, and the
  sync pass already held to that. Casting the concluding vote did not: a member whose copy of the round came by
  gossip, with no credential for the joiner, added it anyway — a member that could never authenticate there. A local
  vote now follows the same rule.

- **A space schema-change notice is accepted by its peers (`Q-108`).** `meta_change_pending` was sent to every
  member and was not an event `POST /api/notify` accepted, so each peer answered `400` to a sender that does not read
  the answer. Peers now accept and record it.

#### Writes and embedding

- **A bulk edge whose end was a `$ref` to a fact or chrono entry was stored as an entity end (`Q-193`)** when the
  item did not state the kind: it was checked for existence as the fact it named and stored pointing at an entity
  that did not exist, so a traversal from the fact never found it. The edge now stores the kind of the record the
  key names.

- **A chrono entry rewritten through its `id` kept the vector of its old content (`Q-192`).** A rewrite never queued
  a re-embed, as a new entry does, so the entry's search vector described what it no longer said.

- **A record retired from meaning-ranked search got a vector anyway when it was rewritten without restating the
  flag (`Q-194`)** — on every create endpoint with `waitForEmbedding` or `checkDuplicates`, through a batch, and on
  the survivor of a merge. The write now decides suppression on the record it leaves: the stored flag unless the
  write states one.

- **`save_bulk` on MCP accepted a retired or unknown key and wrote nothing (`Q-195`)**: `{"memories": […]}`
  answered success while the REST door refused it with a `400` naming `facts`. Both doors now run the same check
  and refuse the same keys with the same message.

- **An edge created with a property its label's schema defaults was stored without the default**, although the
  default was what passed validation; the stored edge now carries the value that was checked.

- **A reindex embedded different text from the write that created the record, and never rebuilt a passage or a
  caption (`Q-99`, part 2).** It built a record's text its own way, not the way a write does: an edge whose end is a fact, a chrono entry or a file embedded that end's raw id instead of its name, and
  a converted document re-embedded without its own text.
  Derived records were skipped outright, so after a model change every passage and media caption kept the old
  model's vector. And a backfill (`reembed`) gave a vectorless passage, face crop or converted copy a vector of its
  PATH (`docs/a.pdf#chunk0`). A reindex now builds every record's text as a write does: a passage
  or caption is rebuilt from its own text, a derived record
  with no text is left without a vector (any path-vector a backfill gave it is removed, and a backfill no longer
  queues it), and a passage of a file whose owner suppressed its embeddings, at any depth, is not embedded. A
  reindex rebuilds a vector even when its text is unchanged, and an embedder outage during one leaves a record's
  vector as it was.

#### Search

- **A slow or failing reranker no longer holds every search (`Q-157`).** While the reranker was slow or down,
  every recall waited out its time limit (20 s) and was then answered in fused order anyway. A reranker pass that fails, runs out its own time limit, or takes more than half of
  it now sets the reranker aside for 30 s, doubling to 5 min; searches in between skip it at once and still report
  `degraded: ["rerank_unavailable"]`. A background probe, never a user's search, brings it back.

- **A record's text rank is its rank among records of its own type (`Q-159`).** The text channel sorted every
  type's matches together by raw MongoDB text score, whose scale is each collection's own, so a fact could outrank
  an entity only because facts are longer — the comparison reciprocal rank fusion exists to avoid. The Query tab
  now says what `fusedScore` is: a rank score, `1/(60 + rank by meaning) + 1/(60 + rank by text)`, about 0.016 to
  0.033, never a similarity. **Who is affected:** the ORDER of a fused recall's results changes where several
  record types matched the text.

- **`filter`'s `total` counts what a name join matches (`Q-160`).** With `fromName`, `toName` or `entityName`, the
  rows were right and `total` counted the whole collection — `count: 2, total: 86` on a space of 86 edges — so a
  caller comparing the two, as the tool tells it to, read on for pages that did not exist. Both doors.

- **A recall across spaces ranks by relevance, not by which spaces had a text match (`Q-82`).** Each space fused
  its own candidates only when its text search found something, so a cross-space answer mixed rank scores near
  0.03 with cosine scores near 0.3-0.9: without a reranker every result of a space whose text search missed came
  before every result of one whose text search hit, whole spaces in blocks; with one, the rerank's unscored tail
  did the same. The merged pool is now fused once — one ranking by meaning over every candidate, and each space's
  per-type text ranking as its own channel — so every result carries a `fusedScore` from the same fusion, spaces
  interleave by relevance, and the reranker picks its candidates by that order. **Who is affected:** a `recall`
  naming several spaces, a proxy, or no space — the ORDER of its results and the values of `fusedScore` on them.
  A recall over one space is unchanged.

#### Spaces and files

- **A new space could stay "building" until the next restart.** Once its search indexes were ready, the space
  recorded that in config.json, re-reading the file first so a concurrent edit is kept. On Docker Desktop the file
  is a bind mount, and a read that landed while the file was being rewritten failed with `ENODATA` — and the
  first such failure was taken as final. A read spoiled by a concurrent writer is now retried a few times; any
  other error is still reported at once.

- **A proxy space no longer gets collections at boot, and a hand-edited `proxyFor: []` is a real space everywhere
  (`Q-80`, `Q-98`).** The boot initialisation walked every configured space, so each boot created a proxy's
  collections — which creating it never made and deleting it (a config-only removal) never dropped; the restore
  index rebuild walked proxies too. And "is this a proxy" was answered in two spellings that disagreed on an empty
  member list: such a space was served as a real space and skipped as a proxy by the embed worker, the duplicate
  and contradiction scanners, the prunes and the metrics, and deleted as a proxy with its collections left behind.
  The loader now removes an empty `proxyFor` on load and reload (with a warning), and the boot and the restore
  rebuild walk only the spaces that own collections. **Who is affected:** an instance with a proxy space (its boot
  stops creating collections for it; ones already created are left as they are, empty), and one whose config was
  edited by hand to hold `"proxyFor": []` (that space starts being embedded and scanned).

- **Moving a file or folder leaves nothing at its old path, even while the file is still being processed.** A
  document's conversion that finished after the move wrote its chunk records under the path the file had just
  left — a folder that no longer existed, with nothing to ever delete them. The conversion now commits its records
  in one transaction that holds only while its job is still claimed, and a move takes that claim before any bytes
  leave, then re-queues the job at the new path. A run that finds its moved file missing no longer "cleans up a
  deleted file" either — which deleted the job and records the move was carrying. And a move now carries
  everything a file owns: a renamed file's chunks used to stay at the old path, a moved folder's chunks kept naming
  parents that no longer existed (so deleting the moved file removed none of them), and the
  `_converted/`/`_extracted/` sidecars moved for neither. REST `PATCH /api/files/:spaceId` and MCP `move_file` now
  run the same move. **And a moved folder keeps its files' links** (`Q-164`): renaming one file re-created its
  links under the new path, but moving a folder re-rooted the records and left every link naming a path that was
  gone, so each file in it silently lost what it was linked to. Both now carry links through one step.

- **A space delete no longer loses a race with the media worker, and one unfinished delete no longer blocks every
  space operation until a restart.** Deleting a space while the worker was still converting one of its files failed
  `ENOTEMPTY` when removing the files directory — the worker was writing artifacts under it — and the delete kept
  its marker, as it must. But the marker was only ever resumed at boot, so every later rename and delete on the
  instance answered `500 "… is still pending … It resumes automatically on restart"`. Three fixes: every removal of
  a space's directories retries what a concurrent writer causes; a space being deleted or renamed away refuses new
  file writes, which the media worker treats as an abandonment, like a moved file's; and the next rename or delete
  finishes a pending op before it proceeds, refusing only when that fails again — with the reason.

#### Lists, notify and metrics

- **Two lists that stopped at a number now say so and can be read to the end.** Each now pages the same way:
  whole rows, `limit` and `skip` refused with a `400` rather than floored when they are not numbers, the byte budget,
  and `count`, `total`, `limit`, `skip`, `truncated` and `nextSkip` on every answer.
  - **The schema dry-run** (`POST /api/spaces/:id/validate-schema`) says, per collection, how many records it
    checked against how many exist and whether the check was complete (`checked`, `complete`), and pages its
    violations instead of stopping at 500 (`Q-129`).
  - **The notify event list** (`GET /api/notify`) pages with `skip` and says when it is cut, instead of stopping at
    200 (`Q-130`).
  - **Resolving entities by id** in the web UI asks for every id instead of dropping those past 100 (`Q-131`).

- **An unknown tool name no longer becomes a metric label (`Q-108`).** It was counted in `ythril_tool_calls_total`
  before the `404`, so any caller could mint a time series per spelling.

- **The notify event store is bounded by bytes, not only by count (`Q-108`).** 500 events of up to the JSON body
  limit each could hold gigabytes; it now holds at most 1 MiB, oldest out first.

#### Client

- **The Graph tab says why it is slow instead of spinning with nothing on it (`Q-155`).** After three seconds of
  waiting it says the server has not answered yet and names what the space is doing — search indexes being built,
  records waiting to be embedded — and after thirty seconds the wait ends in the error state with those reasons
  and Retry — for example while an upgraded instance rebuilds its search indexes.

- **The Query tab's walk headings show their counts (`Q-101`).** "Reached by the walk", and the Entities, Facts,
  Chrono and Files headings under it, rendered `({count})` literally in all three languages, and each reached record
  read `{hops} hop(s)`: the values used single braces, which the translation layer does not interpolate.

- **Buttons that name an action say it in German and Polish (`Q-115`).** "Clear results" read "Klare Ergebnisse"
  (clear as in transparent) and the entity search's Clear read "Klar"; in Polish they read "Jasne", Reset read
  "Nastawić" (to set a clock) and Close the infinitive "Zamknąć". They now read "Ergebnisse löschen" / "Leeren",
  "Wyczyść wyniki" / "Wyczyść", "Zresetuj" and "Zamknij". The Query form's Projection field had the same fault
  ("Vorsprung", "Występ") and now reads "Projektion" / "Projekcja". The same fault on the product's noun: German called a space a "Leerzeichen" (the typed whitespace character) in
  8 places — "Noch keine Leerzeichen" on the Brain page, "Leerzeichen erstellen/löschen" on the MFA card — and
  Polish a "spacja" in 11; they now say "Space" / "przestrzeń" as the rest of the interface does.

- **The client never shows an answer older than the one you asked for last (`Q-112`).** The graph's depth slider
  started a traversal on every step it passed and drew whichever answer arrived last, so a slow depth-3 answer
  could land over depth 4 — and a depth drawn from the cache could be redrawn by a deeper request still in flight.
  It now asks once the slider rests and cancels what it no longer needs. The record tabs (entities, edges, facts,
  chrono) let a slow answer to an old filter replace the new filter's rows, and a list load could replace a
  semantic search's rows or the reverse; now the latest request always wins on every tab,
  and on the graph's selected-record card and linked records. Opening a record resolved each linked fact and chrono title with its own request; it
  is one request per kind now.

## [5.6.0] — 2026-09-29

**A minor release: a filtered recall returns every record that matches, a search never writes into a space, and a
token can be allowed to create spaces without being an instance admin.** It also closes a way for a relaying member
to re-aim a vote, makes joined networks sync on their own, and delivers published file descriptions to subscribers
that had already processed the file. Upgrade every member of a network; older members keep working during the
transition.

| What changes on upgrade | What to do |
|---|---|
| The read spills older versions wrote into spaces (`_tmp/results-*.json`, `_tmp/graph-*.json`) are deleted, once | Nothing. A caller that kept a spill path reads the answer's `remainder` instead; see [Recall API](docs/integration-guide/04a-recall-api.md) |
| Every vector index is rebuilt once in the background, with no gap in search | Nothing. Until it finishes, a filtered recall that needs completing says `filter_window`; see [Hosting](docs/integration-guide/02-hosting.md) |
| `POST /api/spaces` needs the `createSpaces` right instead of instance admin | Grant `createSpaces` to any non-admin token that should create spaces; instance admins are unaffected |
| Vote casts carry a second signature, and 5.6.0 voters must send it | Upgrade every member; a cast from an older member is still checked the old way |
| A network you join syncs on the inviter's schedule, or every 15 minutes | Pass `syncSchedule` on the join to choose another |

### Added

- **`npm run docker:compact` can run without a UAC prompt** (Q-119, development tooling). `npm run
  docker:compact:install`, run once from an elevated shell, copies the compaction step to
  `C:\ProgramData\Ythril\` where only Administrators and SYSTEM may write, and registers an on-demand task that runs
  that copy with highest privileges; `docker:compact` then starts the task instead of asking UAC, and asks UAC as
  before when it is not installed. The task runs only the protected copy, takes no arguments, and attaches the disk
  read-only. `-Uninstall` removes both.
- **`rerank: false` on `recall`** (Q-88), on both doors: skips the configured cross-encoder — no over-fetch for it and
  no rerank pass, on one space and across many — and returns the fused order at once; nothing is reported in
  `degraded`, since it is a skip the caller chose. The reranked answer stays the default. The search bars in the
  Entities, Facts, Edges and Chrono tabs and the entity pickers now send it, because the rerank dominated their
  latency (16-25 s on a shared GPU), and keep only the newest search, cancelling the one before; the Query tab keeps
  reranking and gains a **Rerank** switch. See [Recall API](docs/integration-guide/04a-recall-api.md).
- **`space_rename` renames a space over MCP** (Q-139), the door `PATCH /api/spaces/:id/rename` lacked: instance admin
  or administering the space, the same `{ space }` answer, and the same refusals — including `409` with
  `code: space_name_in_use`. See [MCP → tools](docs/integration-guide/16-mcp.md).
- **`degraded` reason `filter_window`**: a filtered answer that could not be completed says so, and returns what it
  found (Q-102). Treat an unknown reason as "degraded". **`ythril_recall_fresh_scan_capped_total`** counts fresh-write
  scans whose window held more records than `DUPE_FRESH_SCAN_CAP`.
- **Uploaded files are encrypted at rest when the instance has a master secret** (F-43). The same
  `YTHRIL_MASTER_KEY` / `YTHRIL_MASTER_PASSPHRASE` that already encrypts the state files now covers every file under
  `<data-root>/files/` and the resumable-upload staging area, in a chunked AES-256-GCM format that streams a file of
  any size. Nothing changes for a caller: downloads, `read_file`, sync and indexing see the file as uploaded, and
  sizes and hashes stay the plaintext's, so an encrypting peer and a plaintext one compare equal. Files stored before
  the secret was set are encrypted in the background after each start, keeping their modification times. A file that
  cannot be decrypted is refused by name (`500` on download, an error on `read_file`, a failed indexing job) instead of
  being served as ciphertext, and so is an encrypted file on an instance whose secret was removed. The security
  report gains `atRest.files`. See [Encryption at Rest](docs/integration-guide/02a-encryption-at-rest.md#uploaded-files) for what
  stays readable on disk, rolling back, and the temporary plaintext copy `ffmpeg` needs while it indexes media.
- **`read_spill` and `GET /api/brain/spills/:id` read what a search could not return inline** (Q-92). One act behind
  both doors, the same parameters on each — `id`, `skip`, `maxChars`, `maxBytes`, `maxTokens` — paged like a
  search, with whole items, `truncated` and `nextSkip`. Only the token that ran the search can read its spill, and
  only while it holds knowledge read on every space whose records are inside; anyone else, an unknown id and an
  expired one all get the same `404`, and a spill its owner's newer spills evicted answers `410`. See
  [Reading a spill](docs/integration-guide/04a-recall-api.md#reading-a-spill-get-apibrainspillsid-and-mcp-read_spill).
- **`remainder` carries a `spillId`**, the id `read_spill` takes.
- **`incompleteRows`, `incompleteCount` and `truncatedBy` on a traversing `recall` or `similar`** (Q-126), on both
  doors. `incompleteRows` names each match left out because its graph could not be read whole —
  `{_id, spaceId, type, name, reason}`, reason `walk_ceiling`, `link_scan`, `paths` or `deadline`, at most 50
  named — and `incompleteCount` counts them all. `truncatedBy`, beside `nextSkip`, says which bound ended the
  answer: `budget`, `walk_budget` or `deadline`.
- **`spillRefused`**: a `recall` or `similar` whose spill could not be kept says why — `over-share`,
  `instance-ceiling`, `no-token`, `unattributed`, `empty` or `failed` — and still answers in full, with `truncated`
  and `nextSkip` exactly as without it. A spill never fails the search.
- **Three limits on read spills**, validated at boot like every numeric setting: `READ_SPILL_TOKEN_MAX_MB` (64)
  and `READ_SPILL_TOKEN_MAX_COUNT` (50) bound one token, and past them the token's own oldest spills make room;
  `READ_SPILL_INSTANCE_MAX_MB` (1024) bounds the instance, and refuses a new spill rather than evicting anybody
  else's. All three count raw JSON megabytes. See
  [Environment Variables](docs/integration-guide/02-hosting.md#environment-variables).

### Changed

- **The `createSpaces` right creates a space on every door, and the creator administers it** (Q-134). `POST
  /api/spaces` and `save_space` required an instance administrator while a network join honoured `createSpaces`;
  all three now ask one predicate, with one `403` sentence on REST and MCP, and `save_space` is listed to a token
  holding the right. MFA still applies to the REST create. The token that creates a space — directly, by joining a
  network, or as the token a network was joined with when it later adds one — is added to that space's
  administrators (`rights.spaceAdmin.spaces`) in the same write, audited as the new operation `token.creator_grant`;
  its floor, `instanceAdmin` and other rows are untouched. An OIDC session stores no rights, so its identity mapping
  still decides what it reaches. A join that creates a space still needs a floor of `networks: write`. See
  [Spaces API](docs/integration-guide/06-spaces-api.md) and [Tokens API](docs/integration-guide/07-tokens-api.md).
- **A network's `spaceMap` may name several keys for one local space** (Q-133): the first is the network's id,
  later ones are the local names a rename left behind, kept for members that joined under them. A join or network
  answer lists every one. Renaming a space back to its network id removes the mapping.
- **New refusals, each with a `code`** (Q-133), identical on REST and MCP: joining a network is refused `400`
  `join_mapping_collision` when two of its spaces would land in one local space, `network_id_aliased` when a network
  id is already another space's alias, and `invalid_answer` for a malformed invite answer; renaming a space, and
  adding one to a network, is refused `409` `space_name_in_use` when another space already syncs under that name.
  Nothing is created or moved by a refused call.
- **A space vote round carries `networkSpaceId`** beside `spaceId`, and `GET /api/networks/:id/votes` /
  `network_votes` name each round's space by `localSpaceId`, as this instance calls it (Q-133).
- **Accepting a pending space with `mapTo` onto a space the network already carries records the alias** instead of
  answering `409`, when that space has no network id yet (Q-133).
- **On upgrade, a network's schema layer and membership origin kept under a renamed space's old name move to its
  current name** (Q-133, `migrateNetworkSpaceKeys`). Nothing is dropped. Rolling back, the space loses that
  network's schema layer until the network next sends it — see
  [Rolling back](docs/integration-guide/02-hosting.md#rolling-back).

- **A recall with both `tags` and a filter naming `tags` applies both** (Q-102). The filter used to REPLACE the
  `tags` parameter, so `tags: ["a"]` with `filter: {"tags": "b"}` answered records tagged `b` alone. A caller who
  relied on that gets fewer records now: the ones carrying both.
- **Every vector index gains `_id` as a filter field, rebuilt once on the first boot with no gap in search**
  (Q-102). See [Upgrading](docs/integration-guide/02-hosting.md#upgrading).
- **The shipped Kubernetes Deployment uses `strategy: Recreate`**, so an old and a new pod never write the same
  data volume at once during a rollout.
- **A traversing `recall` or `similar` returns each match with its WHOLE graph, or leaves it out and names it**
  (Q-126, owner ruling 2026-09-28: *"if i get a result i want to be sure i get what i asked for"*). Each match is
  walked on its own, to the depth asked for; a neighbourhood past the per-match node ceiling, a link scan past its
  bound, a node reachable more ways than are recorded, or the deadline leaves that match out of `results` and in
  `incompleteRows`, and no returned graph is ever shortened. The whole call has one walk budget and one deadline,
  and running out of either ends the answer at the last whole match with `truncated`, `nextSkip` and
  `truncatedBy`, exactly as the byte budget does. **Removed: `graphComplete`**, the link to a spilled whole graph
  beside a shortened inline one, and the spill behind it — nothing is written unless `remainderDump: true` is
  sent. **`graphTruncated` changed meaning**: it is now `true` exactly when `incompleteCount` is, and never means a
  returned graph is short. **Removed: `pathsTruncated`** on a node, for the same reason. A caller that read
  `graphComplete` reads `incompleteRows` and narrows `edgeLabels` or `traverse` to bring a match back. See
  [Graph-augmented recall](docs/integration-guide/04h-graph-augmented-recall.md).
- **A spill's `download` is `/api/brain/spills/:id`**. It was the files route on the seed's space, which a token
  with knowledge read and no files read could not fetch.
- **A spill lives up to one day, and may be evicted earlier** by its own token's newer spills. Every place that said
  "expires after one day" says so now.
- **Backups and the storage quota leave read spills out.** A backup would have kept a copy — of records since
  deleted or redacted — for as long as backups are kept, and counting them could have tripped the brain quota on
  writes with nothing to show why. A restore leaves the current spills alone.
- **The read spills versions before 5.6.0 wrote into spaces are removed, and never sync again.** A root
  `_tmp/graph-<uuid>.json` or `_tmp/results-<uuid>.json` is left out of the manifest and the space hash, its bytes
  are never pulled and its metadata is dropped on push and pull (counted as `skipped`, so an older peer's push still
  succeeds), and the retention sweep, every few minutes, deletes every copy on this instance — written here or pulled from a peer — with no
  tombstone and no webhook, and one `file.legacy_spill.sweep` audit entry per space it cleaned. **The deletion
  cannot be undone**; a `_tmp` folder of your own deeper in the tree, and other files under the root `_tmp`, are not
  touched. See [Upgrading](docs/integration-guide/02-hosting.md#upgrading).
- **Deprecated: `path` on `remainder`, and its resolution through `read_file` and
  `GET /api/files/:spaceId?path=`** — removed at the next major. No such file exists since Q-92; the files doors
  answer exactly that path from the spill store, for the token that ran the search alone, so a caller built on
  `path` + `read_file` keeps working until then. One read of that path now answers ONE window — the first page
  under the door's default budget, with `nextSkip` when there is more — where it used to return the whole file;
  continue with `read_spill` or the spill route from `nextSkip`. Read by `spillId`.

### Fixed

- **A published file's description and tag edits reach a subscriber that has already processed the file**
  (Q-143). Three writes on the receiving instance stamped the file as if someone there had edited it: recording
  the downloaded bytes, writing the converted document's excerpt, and deriving a description. The receiver's copy
  then compared newer, and the publisher's next edit was skipped on arrival — with a false Merkle divergence
  beside it. A file write now advances the record's `seq` only when it changes a field that replicates, and a
  description is derived only on the instance that authored the file. Records already stamped heal after a few
  more writes on the publisher. See [Conversion pipeline](docs/integration-guide/05a-conversion-pipeline.md).
- **A network's sync schedule stops when the network is gone** (Q-144). Leaving, deleting or being ejected from
  a network, or a config reload that drops it, left its cron task running, and each tick logged
  `Scheduled sync failed … not found` at ERROR. Since joins arm a schedule by default, that was every network an
  instance had left. The tick now stops itself when its network is no longer configured, and a reload stops the
  tasks it no longer lists.
- **A filtered recall no longer reads as complete when the vector index is behind the collection** (Q-142). While
  an index definition was updated in place, the index could accept the search and answer for fewer of the matching
  records than the collection holds, and the answer carried no `degraded` reason. It now says `filter_window` when
  a record that satisfies the filter, older than the fresh-write window, is missing from the index's answer. See
  [Recall API](docs/integration-guide/04a-recall-api.md).
- **On an instance whose vector index uses `euclidean`, locally computed scores match the engine's** (Q-117). The
  engine scores euclidean as `1 / (1 + d²)` and Ythril computed `1 / (1 + d)`, up to 0.09 apart, so the fresh-write
  duplicate threshold acted on the wrong scale and the lexical channel's agreement check never passed. Cosine and
  `dotProduct` were already right. The mapping is now held to the engine's own score for all three metrics by a
  database test.
- **`includeRecordMeta` holds at every depth, and on `similar`** (Q-90). A traversed recall carried every match's and
  every neighbour's `createdAt`/`updatedAt` whatever the flag said, and `similar` accepted no such flag although the
  guide documented it. Both doors of both searches now drop the bookkeeping unless asked, on the match and every
  node of its graph; the four ways a search row was built are one builder.
- **Semantic search in the Graph picker, the entity pickers and the Facts, Edges and Chrono tabs shows its results**
  (Q-87). A recall hit carries its record under `record`, and these read the record's fields off the hit itself, so
  every result rendered as a blank row with no id, and a chrono entry showed `chrono` as its type and always
  `upcoming` as its status. The client reads a hit through one accessor that refuses a hit without a record, and its
  hit type no longer lets a flat read compile. The Query tab's traversed neighbours show the label of the edge that
  reached them again, and "view in graph" is offered on entity and edge hits again.
- **Text removed from a record stops matching searches, whatever became of its embedding** (Q-94). The lexical
  channel reads the record's matched text, and only a successful embed rewrote it — so on a record with embeddings
  suppressed, a deleted property went on matching and was shown as the matched text, and a failed embed left both the
  old text and the old vector. Every embed outcome now writes the current text; a failed one also drops the vector,
  which described text that is gone, so a retry re-embeds instead of taking the stale vector as current. See
  [Brain API](docs/integration-guide/04-brain-api.md).
- **A large `topK` is served, not a 500** (Q-103). The vector stage was handed a per-type limit that followed `topK`
  while its candidate count stopped at 1000, and the index refuses a limit above its candidates — so a recall asking
  for more than about 666 of a type answered a 500 labelled retryable, as did a `minPerType` floor above 1000. The
  sizing lives in `brain/search-bounds.ts` with the per-type bound (2000), a floor is clamped to both `topK` and that
  bound, and a `topK` past the bound on a type that fills it answers `degraded: ["candidate_cap"]` rather than
  reading as complete. `topK` still has no ceiling.
- **A joined network syncs on its own** (Q-137). The join registered the network with no schedule, which is manual
  only, so a joiner never pulled and a subscriber depended on its publisher pushing everything. The join now adopts
  the inviter's schedule, carried as `syncSchedule` in the invite apply answer, or every 15 minutes when the inviter
  offers none it could run. `POST /api/networks/join-remote`, `/join-by-key` and both MCP join tools take an optional
  `syncSchedule` that wins (`""` for manual), refused `400` before the handshake when it cannot run. A network joined
  before this keeps no schedule; set one on its card. See
  [Join Remote](docs/integration-guide/08-networks-api.md#join-remote-rsa-handshake).
- **A renamed space reaches a new member once, under the network's name** (Q-133). An invite answered with the
  inviter's LOCAL space ids, while every later exchange used the network's, so a member joining after the publisher
  renamed a space held it twice — `y-twin` beside `y-project-template` — and the second copy never synced. Invite
  answers now carry `networkSpaces`, index-aligned with `spaces`, and the joiner records each space under it. A
  member that already has the duplicate heals from its publisher or tree parent once both run this version
  (audited as `network.space_alias.heal`); on a club, closed or democratic network, accept the waiting space with
  `mapTo` naming the space you carry. The idle duplicate is left for you to remove. A pre-5.6.0 joiner of an
  upgraded publisher still gets the duplicate until it upgrades too. See
  [Networks API](docs/integration-guide/08-networks-api.md) and
  [A space that shows up twice](docs/userguide/04-settings.md#a-space-that-shows-up-twice).

- **A filtered recall returns every matching record it has room for, whatever its vector rank** (Q-102). A filter
  the vector index cannot apply — an undeclared property, `exists`, `ne`, most raw MongoDB — scored only the
  nearest 1000–10000 records and filtered after, so a match outside that window was dropped with `count: 0` and
  `truncated: false`, while the schema, `help()` and the guide promised the opposite. The window is now completed
  from the matching records whenever it cannot prove it held the answer; a filter the index can apply costs what it
  did, and any other costs a pass over the matching records. Both doors.
- **Face auto-labelling finds a labelled face behind closer unlabelled ones** (Q-102). The gallery looked at the
  nearest thousand faces only, so in a large archive a labelled match behind them was recorded as "no match", for
  good. A gallery search that cannot be completed now makes the media job retry instead of writing the face
  unlabelled.
- **A filter can no longer switch off the fresh-write scan's own guards** (Q-102). A raw filter naming `updatedAt`
  widened the "written in the last three minutes" window to every recent record, and one naming `embedding` failed
  the scan and dropped the record written a moment ago.
- **A restore answers in time however many spaces the instance holds.** After reloading the data, the restore
  rebuilt every space's vector indexes one space after another before answering, so the request grew by several
  seconds per space, and an instance with a few dozen spaces saw it time out — reporting a failed restore that had
  in fact succeeded. The spaces are now rebuilt several at a time.
- **A file arriving by sync is written inside its own space, whatever path the peer names.** The pull path joined
  the peer's manifest path onto the space directory without the sandbox check every other write gets, so a path
  climbing out of the space would have been written outside it.
- **The Query tab's spill download works.** "Download the whole graph" was a plain link, which carries no
  `Authorization` header, so it could never be followed. It is gone with the graph spill (Q-126); the remainder a
  search kept with "Keep what did not fit" is offered as a button that fetches every page and saves one file, with
  its expiry, and a spill that is gone or was not kept says so. A match left out because its graph could not be
  read whole is named above the results, with the reason.

### Security

- **Every regex a filter can run passes the catastrophic-pattern guard** (Q-118). The guard read only `$regex`,
  while `$expr` is accepted, so `$regexMatch`, `$regexFind` and `$regexFindAll` ran any pattern — `(a+)+$` pinned
  MongoDB's CPU for the whole `maxTimeMS`, per member space on a proxy, on the filter tool, recall's `filter` and
  `/query` alike. They are now guarded like `$regex`, and their pattern must be a literal: one read from a field is
  refused, since no guard can inspect it. The filter tool's description no longer promises an allowlist nothing
  enforced; it names what is refused, from the sets that refuse it.
- **A relaying member cannot re-aim a vote round** (Q-138). A vote cast's signature covered the round's id but not
  what it does, so a member relaying a `space_deletion` or `space_wipe` round could rewrite its target space or wiped
  types and every honest cast still verified on the instance that learned the round from it. A cast now also carries
  `bsig`, signed over the round's type, `spaceId`, `networkSpaceId` and `wipeTypes` and checked against the round it
  is applied to. A cast without it is refused from a voter known to run 5.6.0 or later; from an older member the old
  check stands until it upgrades. See [Signed vote casts](docs/sync-protocol.md#signed-vote-casts).
- **`POST /api/sync/warm` warms only a network the calling peer belongs to, and only the spaces that network
  carries** (Q-133). It opened collection handles for any space id in the body.

- **A search never writes into a space** (Q-92). A `recall` or `similar` whose traversal outgrew its inline cap, or
  that asked for `remainderDump`, saved the rest as a file in the seed's space: a blob under `_tmp/`, a file record,
  a change that synced it to every peer, and an embedding job for the search's own output — so a token holding only
  knowledge read changed a space by searching it. Spills now live in a store outside every space, for the token
  that caused them.
- **Only the token that ran a search can read what it kept.** A spill was an ordinary file on the space, so any
  token with files read there could list `_tmp` and read every other caller's search results. The spill route and
  `read_spill` check the issuing token and knowledge read on every space in the spill, today rather than when it
  was made, and answer anyone else as if the spill did not exist. The deprecated `path` resolves under the same
  rule.
- **Spills no longer reach peers, and the copies that did are removed.** A spill replicated like content, and the
  copy a peer pulled never expired there, so one caller's results accumulated on every instance in a network. Spills
  are instance-local now, sync drops the old path shape in both directions, and the retention sweep deletes what is
  left.
- **The web app sends its session token to this instance only.** The request interceptor tested "same origin" as
  "starts with `/` or with the origin", so a protocol-relative URL (`//other.example/…`, and `/\other.example/…`,
  which a browser reads the same way) or a host that merely begins with the origin (`<origin>.other.net`) received
  the bearer too. One rule now decides it for the interceptor and for authenticated downloads alike.

## [5.5.2] — 2026-09-27

**A patch: recall ranks reranked results first again, a proxy recall reranks once, and a proxy is no longer
reported unconverted at every start.** Upgrade every instance with a reranker configured, and every instance
that holds a proxy space made before 5.0. Nothing to change in configuration or calls.

### Fixed

**Recall**

- **A reranked result always ranks above one the reranker did not score** (`Q-79`). The cross-encoder scores
  at most 100 candidates, and an unfiltered recall gathers more; the rest kept only their vector or fused score,
  which sits on a higher scale than a cross-encoder's relevance, so they took the top of the answer. The recall
  came back in vector order with no `degraded` and every batch answered 200. The 100 scored are now the
  `minPerType` floor results first, then the pool's best by its fused order (by vector similarity across several
  spaces), and the rest follow every scored result. Floor results are also fused with the pool now, so they
  are ranked on the same scale as the results around them. *Docs changed:* `docs/integration-guide/04a-recall-api.md`,
  `05b-media-embedding.md`, `02-hosting.md`; `docs/userguide/02-brain.md`.
- **A recall on a proxy or on named spaces reranks once** (`Q-81`). It merged its members by hand and sent one
  rerank request per member, the fan-out already fixed for a recall naming no space; it now takes the same path,
  with one query embedding and one rerank pass.

**Links**

- **A proxy space is no longer reported unconverted on every start** (`Q-78`). The link conversion never walks a
  proxy, because it holds no records, so a proxy made before 5.0 never carries the marker, and the array clean-up
  that runs after the conversion listed it as still holding its links as arrays. Link reads through a proxy were
  not affected: they are answered by its members. The warning and the link-read refusal now say that each start
  retries the conversion, since `npm run links:convert` is not in the image; the script refuses a proxy by name.
  *Docs changed:* `docs/integration-guide/04g-links-api.md`, `06-spaces-api.md`; `docs/userguide/02-brain.md`.

## [5.5.1] — 2026-09-27

**A patch: a network no longer deletes a member's space.** Upgrade every instance that is a member of a network,
since the change applies on each member when a deletion vote passes.

### Fixed

- **A network never deletes a member's space** (`Q-70`). Deleting a networked space opens a vote as before, but
  when it passes the space now leaves the network on every member instead of being deleted there: each member
  keeps its copy and data as a local space and can add it to a network again. Only the instance that asked for the
  delete removes its own copy. On a club or pub/sub network one yes used to delete the space on every member.
  Emptying a space by vote is unchanged. *Docs changed:* `docs/network-types.md`, `docs/sync-protocol.md`,
  `docs/integration-guide/08-networks-api.md`, `docs/userguide/04-settings.md`.

## [5.5.0] — 2026-09-27

**Files sync between members again, a file edited on one side is no longer a conflict, and a sync can carry a
change note to the members below.** It also carries everything in 5.4.2 and 5.4.3.

| what changed | what to do |
|---|---|
| `DELETE /api/conflicts/:id` and the Dismiss button are gone | resolve with `POST /api/conflicts/:id/resolve` (keep local, keep incoming, keep both, save to space) |
| idle connections stay open 95 s | a proxy that holds idle upstream connections longer than 95 s should be lowered below it (*Hosting → TLS Termination*) |

*Docs changed:* `docs/network-types.md`, `docs/sync-protocol.md`, and in `docs/integration-guide/`
`02-hosting`, `06a-schema-api`, `08-networks-api`, `09-sync-api`, `10-mfa-and-conflicts`, `13-audit-log-api`,
`14-duplicates-and-webhooks`, `15-about-and-embedding`, `16-mcp`; in `docs/userguide/` `03-files-and-schemas`
and `04-settings`.

### Added

- **A sync can carry a change note to the members below** (`F-42`). A pub/sub publisher or a braintree node
  can attach a note (markdown, and the spaces it concerns) to a sync, on every door: the `{ note, spaces }` body
  of `POST /api/networks/:id/sync`, `note` and `spaces` on MCP `network_sync` (which also gains `networkId`), and
  **Sync with this note** on the network card. The note is queued per member and delivered in that member's next
  exchange, so a member that is offline gets it when it is back. A note that cannot travel — no member below this
  instance, or a network type that syncs both ways — is refused with `409` and the sync does not run. The network
  drafts its own for a schema update it carries and for a space added to it. Each member lists what arrived
  (`GET /api/networks/:id/change-notes`, MCP `network_change_notes`, the card's **Change notes**), and each arrival
  fires the new webhook event `change_note.received`.

### Removed

- **Dismiss on a file conflict, and `DELETE /api/conflicts/:id` behind it.** It closed the conflict and left the
  incoming copy in the space under its conflict name, where it replicated to every member: a keep-both without the
  rename, shown as if it deferred the choice. A call now answers `404` and leaves the conflict open; resolve with
  `POST /api/conflicts/:id/resolve` (keep local, keep incoming, keep both, save to space).

### Fixed

**File sync**

- **A file changed on one side only is no longer a conflict** (`Q-66`). Each end now remembers, per file and per
  peer, the version both last held. A copy nobody touched locally takes the other side's edit; our own edit is
  carried by the push instead of raising a conflict on our next pull; only edits on both sides still make a
  conflict, and then nothing is overwritten (the push no longer overwrites a peer's edit because its file is
  older). Conflict copies and each instance's `schemas/` snapshots no longer replicate, so a schema change stops
  raising a conflict on every member.
- **The files of a space renamed on both ends of a network sync again** (`Q-68`). A rename keeps the network's id
  for the space and maps it to the new local one, and the sync routes translate that id, but a file travels through
  the plain file routes, which do not: every file push and pull was refused `403` while the space's records synced.
  The peer's file manifest now names its local id for the space (`spaceId` in `GET /api/sync/manifest`), and the
  transfers use it. A peer on an older build is addressed as before.
- **A file's description and tags replicate** (`Q-69`). The push sent a file's whole stored metadata, including
  what only the local instance derives (size, hash, vector, excerpt), and the receiver's strict schema refused
  every one, so a file's bytes arrived on a peer and its description and tags never did. Both ends now send and
  write only the fields the sync schema declares, so the receiver also no longer takes the sender's size and hash.
- **`GET /api/conflicts?spaceId=` narrows to that space**, as documented, and answers `403` for a space the token
  cannot reach. It read the parameter nowhere and returned every accessible space's conflicts.
- **The conflict page's action selects look editable on every theme.** They were styled with a theme token no
  stylesheet defines, so their border and background were dropped; five other reads of undefined tokens are fixed
  and a gate now holds every `var()` the client reads to a defined token.

**Networks and schemas**

- **A push the receiver refused is no longer reported as pushed** (`Q-59`). `batch-upsert` answers a `rejected`
  count per family, covering every record it neither stored nor already held: schema-invalid, an implausible
  `seq`, a fork chain at its cap, or a chrono type the space does not declare. The sender subtracts it and records
  the cycle as **partial**, naming the family and the count, so a cycle whose records all bounced no longer reads
  `success`. A peer that refused records answered, so its failure count does not rise. The watermark still
  advances, as before. Links are now counted in the cycle's totals too.
- **A space added to a network reaches its members with its schema** (`Q-60`). A schema-library reference now
  travels resolved, where it was sent as a name the member's library did not have and the member refused the
  whole schema. A type whose reference neither side can resolve is left out on its own. A space added to a club,
  closed or democratic network carries its schema on the vote. And the proposer of a club schema change now
  updates the network's layer as well as its own definitions: before, the stale layer outranked its own edit, so
  the one instance that made the change could not see it.
- **A schema replace on a networked space says it kept what it did not remove** (`Q-61`). A network round is
  applied as a merge on every member and on the proposer, so a replace that left a type out removed nothing, and
  every schema door answered `200` as if it had. The answer now carries `appliedAsMerge`, `keptTypes` and a
  sentence, on REST and MCP alike, and the members are sent a change note naming the kept types. Removing a type
  from a network stays impossible on purpose: it could break a member's customisation, its reuse of the type, or
  another network the space is in.

**Server**

- **A request is no longer dropped after the server was busy** (`Q-73`). An idle connection was closed after
  Node's default 5 seconds, checked before the server read what had arrived on it. So after a few seconds of heavy
  work, a request a client or proxy had already sent on a pooled connection failed with "other side closed", and
  nothing was logged. Idle connections now stay open for 95 seconds, above the common proxy defaults; see
  *Hosting → TLS Termination*.
- **A space update that carries no schema no longer logs "Suppression sweep failed"** (`Q-74`). Changing only a
  setting such as the text level ran the embedding-suppression sweep without a schema to read, so it failed and
  warned on every such write. It now runs only when the write carried one.

**Embedding in a frame**

- **`?embedded=1` survives a sign-in inside the frame.** The flag was read from the URL only, so after the identity
  provider's redirect, a new document whose query is `code` and `state`, the topbar and Sign out came back in a
  framed brain. It is now kept for the tab in `sessionStorage`; another tab is unaffected and `?embedded=0` clears it.


## [5.4.3] — 2026-09-27

**A security patch for democratic networks: a round needs a real majority of the members.** Upgrade every
instance that is a member of a democratic network.

### Fixed

- **A democratic network needs a majority of its members, not half** (`Q-77`, security). The yes votes were
  compared against half of the OTHER members, so on an even-sized network exactly half passed a round, and on two
  members the proposer's own yes decided for both. A round now passes on more than half of all members, and only a
  member's yes counts. No documentation changed: the docs always said majority.

## [5.4.2] — 2026-09-27

**A security patch for closed networks: no member's space can be deleted, wiped or changed without that member's
own vote.** Upgrade every instance that is a member of a closed or braintree network.

### Fixed

- **A closed network no longer passes a round on a member that has not voted** (`Q-76`, security). A member counted
  only the OTHER members' yeses, so a round it learned from a peer passed as soon as they had all voted. On two
  members, the proposer alone decided for the other, which then deleted, wiped or changed its own space without
  having voted. Every member's own yes is now required, as the docs always said; braintree's every-member fallback
  had the same gap and is fixed with it. *Docs changed:* `docs/network-types.md` (Closed network),
  `docs/sync-protocol.md` (round conclusion).

## [5.4.1] — 2026-09-26

**Subscribing a webhook to fact events works from Settings → Webhooks again.** Since 5.0 the page offered event
names the server no longer accepts, so any subscription that ticked a fact event was refused.

| | |
|---|---|
| fixed | the Webhooks page offers `fact.created`, `fact.updated` and `fact.deleted`, the names the server emits |
| what to do | upgrade; a subscription that failed to save from the page can be saved again. Subscriptions made through the API were never affected |

**Documents that changed**: none.

### Fixed

- **Subscribing a webhook to fact events works from Settings → Webhooks again** (`Q-65`). Since 5.0 renamed the
  knowledge type `memory` to `fact`, the server's events are `fact.created`, `fact.updated` and `fact.deleted`, but
  the page went on offering `memory.created`, `memory.updated` and `memory.deleted`, and the server refused any
  subscription that ticked one with "Invalid event type". The page now offers the server's names. A gate reads both
  lists, so an event added on one side and not the other fails the build. Subscriptions made through the API were not
  affected.

## [5.4.0] — 2026-09-26

**A network now asks before it adds a space, and a pub/sub can be joined by pasting its key.** A space a publisher,
a tree parent or a passed vote adds is created here only if the token that joined the network could have joined
it; everything else waits on the network card for you to accept or dismiss. A config reload no longer drops a
space the file forgot, and a published pub/sub key is enough to join, with no step on the publisher.

| | |
|---|---|
| added | **Join network** takes a publisher URL and its published key; nobody on the publisher has to admit you |
| security | spaces a network proposes wait unless the joining token could have joined them; a same-named local space always waits; a reload keeps a space it no longer lists unless `removeSpaces` names it |
| what changes on upgrade | networks joined or created before 5.4.0 have no recorded joining token, so every space they announce from now on waits for an accept on the network card |
| what to do | upgrade; then check each network card for **Announced, waiting for you** after its next sync. If you remove spaces by editing `config.json`, list them in `removeSpaces` |

**Documents that changed**, for anyone who keeps a copy: `docs/integration-guide/08-networks-api.md`, `docs/integration-guide/09-sync-api.md`, `docs/integration-guide/12-admin-api.md`, `docs/integration-guide/13-audit-log-api.md`, `docs/integration-guide/16-mcp.md`, `docs/network-types.md`, `docs/sync-protocol.md`, `docs/userguide/04-settings.md`.

### Added

- **Join a pub/sub network by pasting its published key** (`F-41`). The docs always said a pub/sub key is
  reusable so it can be published, and that a subscriber's join is accepted without a vote. But the only route that
  took the key demanded an admin token on the publisher, so a stranger holding the key could not use it. Now the
  publisher answers `POST /api/invite/redeem` with a handshake for the key alone. The joiner's
  `POST /api/networks/join-by-key` (MCP `network_join_by_key`) runs the whole join from the publisher's URL and the
  key, and the **Join network** dialog takes both. Redeem answers only for a pub/sub network the instance
  publishes, and is bounded because anyone may call it: rate-limited, at most 25 open handshakes per network and 3
  per caller, each living 10 minutes. Regenerating the key closes every handshake it already opened, and looking a
  handshake up costs one password-hash comparison however many are open.

### Security

- **A network's announcement is a proposal: the token that joined it decides what it may add** (`S-9`). A
  publisher or tree parent that added a space made every subscriber or child create it, join a same-named local
  space to the network, and widen the peer tokens to it, whatever the joining token was allowed. Now the join
  records its token, and a later announced space is added only if that token could have joined it. A same-named
  local space is never joined this way. The same rule governs a passed vote that would create a space here, and a
  joining token that was deleted or has expired adds nothing. Anything else waits on the network card as a pending
  space with its reason, and the operator accepts or dismisses it: `POST /api/networks/:id/pending-spaces`, MCP
  `network_pending_space`. A dismissal is remembered, so the network does not propose that space again. **Networks joined or created before this version have no recorded joining token, so every space
  they announce from now on waits for an accept.**
- **A config reload never drops a space silently** (`S-10`). A space the running instance had and a reloaded
  `config.json` no longer listed simply left the configuration, with its data orphaned and nothing logged beyond
  "reloading". Whoever wrote the file (a deploy step, a restore, a second replica, a hand edit) removed spaces.
  Now such a space is kept and the log says so. To remove one by editing the file, list its id in a top-level
  `removeSpaces`. Every space a reload adds, removes or keeps is audited (`space.reload_added`,
  `space.reload_removed`, `space.reload_kept`), whether the watcher or `POST /api/admin/reload-config` ran it.

## [5.3.1] — 2026-09-26

**An instance administrator holds every right on every space again.** Since 5.0 an instance-admin token stored
with rows for only some spaces was refused on every other space, including spaces a network had just created,
and could not widen itself. Granting instance admin now also grants space admin on the all-spaces floor, so it
covers spaces created later, and instance-admin tokens stored without it are repaired when the instance starts.
Renaming a space also keeps its named administrators.

| | |
|---|---|
| fixed | instance admins reach every space, present and future; a renamed space keeps its space admins; an OIDC login mapped to instance admin gets the same floor |
| what changes on upgrade | at startup, each instance-admin token without the space-admin floor gets it, and the log names every token changed |
| docs | the tokens guides no longer say four admin cells make a space administrator; only the **Space admin** grant does |
| what to do | upgrade. Nothing to configure |

**Documents that changed**, for anyone who keeps a copy: `docs/integration-guide/06-spaces-api.md`, `docs/integration-guide/07-tokens-api.md`, `docs/userguide/04-settings.md`.

### Fixed

- **An instance administrator holds every right on every space again** (`S-11`). Before 5.0, space admin was
  worked out from holding all four admin rungs, so an instance admin had it everywhere. The 5.0 grant migration
  kept that only for tokens whose all-spaces floor was admin in every area, so an instance admin stored with rows
  for one space lost space admin everywhere else. It was refused (403) on spaces it did not name, including
  spaces a network had just created, and it could not widen itself. Granting instance admin now also sets
  **Space admin** on the all-spaces floor, through every door that writes a token's rights, so it covers spaces
  created later. Instance-admin tokens stored without it are repaired at startup, and the log names each one.
  Three readers that ignored space admin now respect it:
  - a space administrator reaches the spaces it administers even with no area rows;
  - a space-admin floor can delegate the admin floor rungs it holds;
  - the token list's rights glyph draws a space administrator at admin instead of at nothing.

  An OIDC identity mapped to instance admin gets the same floor. The audit entry for a rights edit now records
  the rights as stored. The tokens guides said four admin cells make a token its space's administrator; they
  do not (only the **Space admin** grant does), and both guides now say so.
- **Renaming a space keeps its named administrators** (`Q-58`). A rename moved each token's per-space rights to the
  new id but left the space-admin list on the old one, so a token that administered the space by name silently
  stopped administering it.

### Internal

- **`todo:check` no longer reads a working-order checklist.** Its checks were written for a hand-ticked file,
  and that ordering is now enforced by the flow's own gates, so the rule, its helper and its tests are gone.
  The exemption list also loses the three loop write-ups deleted from `todo/`.
- **`todo:check` passes a `todo/` with no queue file and no open work.** A project whose queue is kept elsewhere
  (tickets, checked by the flows' own tracker check) failed every local preflight on the missing index. Open items
  left in a tracker file with no index still fail, and name each one.

## [5.3.0] — 2026-09-25

**The assist model can keep to a budget, fall back when it cannot answer, and be a Claude model.** A token budget
caps what the External assist model spends in a rolling window, and a fallback answers when the main endpoint is
unreachable, rate-limited, over budget or declines a request — a local fallback needs no consent, a hosted one is
consented per use. Either endpoint can speak the Claude API with a Claude Console API key. The guides now describe
only what exists, and the code lost about a thousand lines of dead code and history.

| | |
|---|---|
| new | assist budget and fallback; the Claude API as an assist backend; the Models card shows which endpoint is answering and what the budget has spent |
| consent | a hosted fallback asks for its own per-use consent; a local one sends nothing off the instance |
| docs | the integration guide and user guide name only tools, routes and types that exist, and state rules rather than their history |
| fixed | the NLP sidecar has its card on the Models tab; a file deleted while it was being processed no longer leaves records behind |
| what to do | upgrade. Nothing changes until an operator sets a budget or a fallback |

**Documents that changed**, for anyone who keeps a copy: `CLAUDE.md`, `docs/integration-guide/04-brain-api.md`, `docs/integration-guide/04a-recall-api.md`, `docs/integration-guide/04b-graph-api.md`, `docs/integration-guide/04c-chrono-api.md`, `docs/integration-guide/04d-brain-ops-api.md`, `docs/integration-guide/04f-write-semantics.md`, `docs/integration-guide/05a-conversion-pipeline.md`, `docs/integration-guide/07-tokens-api.md`, `docs/integration-guide/16-mcp.md`, `docs/sync-protocol.md`, `docs/usecase-examples/01-sharing-and-distribution.md`, `docs/usecase-examples/02-operations-research-and-agents.md`, `docs/usecase-examples/03-proxy-multi-space-and-personal.md`, `docs/userguide/02-brain.md`, `docs/userguide/04-settings.md`, `docs/userguide/04a-media-and-embedding.md`, `NOTICE`.

### Added

- **The assist model gets a token budget and a fallback, and can be a Claude model** (`F-33`, `F-33.1`). A budget
  caps what the assist endpoint spends — so many tokens in any rolling so many hours — and a fallback answers when it
  cannot: unreachable, rate-limited, over budget, or declining a request. A local fallback (a model on this instance)
  sends nothing off it and needs no consent; a hosted one is consented per use like the main endpoint. The assist
  endpoint and its fallback can each speak the Claude API with an API key from the Claude Console, besides any
  OpenAI-compatible server. The Models card shows which endpoint is answering documents and conversations now, what
  the budget has spent, and when the main one is paused after a failure; Test and Verify check the fallback too.

### Changed

- **The integration guide and user guide describe only what exists, as it works now** (`Q-45.1`, `Q-45.2`). Examples
  and references to tools, routes and types that are gone now name their replacements (`save_fact`, `filter`,
  `POST /api/filter`, `FactDoc`). Nine pages that told the history of a behaviour — what it used to do, which
  release fixed it — now state the rule, keeping a version note only where an older client has to change
  something. Several statements that no longer matched the server were corrected on the way: for example, a
  supplied unknown id is ignored and the server mints one, an entity's `type` is required, and `filter`'s default
  `limit` is 200.

### Fixed

- **The NLP sidecar has a card on the Models tab** (`F-31`). It was wired and probed on the About page, but
  missing from the Models screen and from the pipeline status that screen reads. So an operator could not see
  from there that conversation ingest has what it needs. The sidecar cards are now one shared component, and the
  gate that checks every sidecar has a card reads the list from the compose file instead of a hand-written one.

- **A file deleted while it was being processed no longer leaves records behind.** A text file's chunk records
  are written at the end of its processing job, so deleting the file or its folder during the job left those
  records behind as orphans that still appeared in file metadata. The job now checks that its file still exists
  after writing, and removes what it wrote if not.

### Internal

- **Cleanup, part 2** (`Q-45.3`, `Q-45.4`). No behaviour changes:
  - About 250 unused imports, locals and parameters are gone from server and client, and the compiler now
    refuses new ones (`noUnusedLocals`, `noUnusedParameters`). An intentionally unused parameter starts with `_`.
  - Four of the most commented server files keep what each comment prevents and lose the history, about 680
    lines.
  - Four rules that were asserted in several test files each have one home. Two gates that could miss a case
    now derive what they check, and a third that passed on an unused import reads the file that applies the rule.
  - Eleven test files carried mis-decoded UTF-8; they are repaired, and the encoding gate now covers `testing/`.

## [5.2.0] — 2026-09-25

**Networks become a whole feature on both doors, a space's schema travels with its records, and a conversation can
be ingested into records.** Every network act now has its MCP tool, a token below instance admin can govern the
networks of the spaces it holds, a space can join an existing network later, and a space in two networks keeps each
network's schema as its own layer — the clashes shown, the order the operator's to change, and a combined
definition proposed to one network by vote. `ingest` turns a raw conversation into entities, claims, edges and a
timeline.

| | |
|---|---|
| new | MCP tools for every network act (invite, fork, join, members, votes, topology); a Networks column in token rights; a space added to an existing network; schema replicated with the records, per network, with clash view, reorder and propose; `ingest`; `graph_traverse` bodies via `projection`; a batch answers with its `refs` |
| now voted | a schema write on a NETWORKED space through `PUT /schema`, the single-type upsert and delete, and the library's apply answers `202 vote_pending` instead of `200`, and changes only when the round passes — as `PATCH` already did |
| consent | the External assist model is consented to per use: an instance that ingested conversations through it must **Allow conversations** once, or ingest refuses and says so |
| memory | the compose install caps `ythril` and `ythril-mongo` at 4 GB each by default (`YTHRIL_MEM_LIMIT`, `YTHRIL_MONGO_MEM_LIMIT`); raise them in `.env` for very large spaces |
| security | a round from a peer can no longer pass itself off as this instance's own; starting ingest runs is rate limited on REST as on MCP |
| what to do | upgrade. A script that writes a networked space's schema should expect `202`; an instance using an external assist model for conversations allows conversations once on Settings → Models |

**Documents that changed**, for anyone who keeps a copy: `README.md`, `docs/dependencies.md`, `docs/integration-guide.md`, `docs/integration-guide/02-hosting.md`, `docs/integration-guide/04-brain-api.md`, `docs/integration-guide/04a-recall-api.md`, `docs/integration-guide/04b-graph-api.md`, `docs/integration-guide/04d-brain-ops-api.md`, `docs/integration-guide/04i-ingest-api.md`, `docs/integration-guide/05a-conversion-pipeline.md`, `docs/integration-guide/05b-media-embedding.md`, `docs/integration-guide/06-spaces-api.md`, `docs/integration-guide/06a-schema-api.md`, `docs/integration-guide/06b-schema-library-api.md`, `docs/integration-guide/07-tokens-api.md`, `docs/integration-guide/08-networks-api.md`, `docs/integration-guide/09-sync-api.md`, `docs/integration-guide/13-audit-log-api.md`, `docs/integration-guide/16-mcp.md`, `docs/network-types.md`, `docs/sync-protocol.md`, `docs/userguide.md`, `docs/userguide/02-brain.md`, `docs/userguide/03-files-and-schemas.md`, `docs/userguide/04-settings.md`, `docs/userguide/04a-media-and-embedding.md`.

### Added

- **A schema clash between two networks can be settled by proposing a definition to one of them** (`F-39.5`,
  closing `F-39`). `targetNetwork` on `PATCH /api/spaces/:id` and MCP `schema_update` proposes the meta to that
  network alone, as its definition: a vote there, landing in its layer on every member once passed, with this
  instance's own definitions untouched. The Schema tab's clash list has a **Propose** action beside each network
  that holds the other definition.

- **An agent can mint an invite key and fork a network over MCP** (`F-36`, slice 3). `network_invite` and
  `network_fork` are the same acts as `POST /api/networks/:id/invite` and `/fork` — same parameters, answers and
  refusals on both doors.

- **An agent can join a remote network and manage its members over MCP** (`F-36`, slice 4). `network_join_remote`,
  `network_member_add` and `network_member_remove` are the same acts as `POST /api/networks/join-remote`,
  `POST /api/networks/:id/members` and `DELETE /api/networks/:id/members/:instanceId`: the same handshake and Networks
  rung, the same vote-or-direct answer per network type, and an inviter's refusal relayed with its own sentence.

- **Every network route now has its MCP tool** (`F-36`, slice 5, closing it). `network_member_admit` (the inviter's
  half of a join by invite key), `network_member_signing_key`, and the braintree topology acts `network_reparent_self`,
  `network_member_adopt` and `network_member_revert_parent` are the same acts as their routes, instance-admin on both
  doors. `mcp/parity.ts` no longer declares any network capability REST-only.

- **A passed space-settings vote reaches every member** (`F-39.4`). On a club the organiser's own yes passed a
  meta change before any member could see the round, and a member that joined later never saw it either, so the
  change stayed on the instance that proposed it. The passed round is now served to peers, each member re-decides it
  from the casts, and applies it as that network's definition — beside its own, never over it.

- **See and settle a schema clash between networks** (`F-39.3`). A space in several schema-sending networks
  shows, on its Schema tab, each network's layer in the order it applies and every clash between them, with the
  network that currently applies marked; the order can be changed there. `GET /api/spaces/:id/schema-layers` and
  `PUT /api/spaces/:id/network-precedence`, and MCP `space_schema_layers` / `space_set_network_precedence`, with the
  same parameters and answers.

- **An agent can see and cast network votes over MCP** (`F-36`, slice 2). `network_votes`, `network_vote` and
  `network_sync_history` are the same acts as the votes and sync-history routes — same parameters, answers and
  refusals, instance-admin on both doors. A vote is how a networked space approves a destructive act, and until now
  an agent could be a member of a governance process it could not take part in.

- **A space in two networks keeps each network's schema apart** (`F-39.2`). What each network sends is kept as
  its own layer beside this instance's own definitions, and the space runs on own ⊕ layers in precedence: the network
  joined first wins where two define the same property differently, and both keep syncing their records. Each
  network is sent only this instance's own definitions plus its own layer, never the other network's, and an
  operator's schema edits land in the own definitions so they survive the next layer. Seeing clashes and reordering
  come next (`F-39.3`).

- **A space can be added to a club, closed or democratic network too** (`F-38.4`). There it is a `space_addition`
  vote: a club organiser's own yes carries it at once, a closed network needs every member, a democratic one a
  majority with no veto. Same route, tool and picker as the pub/sub and braintree case; a vote answers `202`. Each
  member applies the passed round itself, and a member that already has a local space of that name keeps it out of
  the network unless it voted yes, because those networks sync both ways and joining it would send its records to
  everyone.

- **A space's schema flows down its network with the records** (`F-39.1`). On a pub/sub network or a tree, each
  instance now takes a shared space's type schemas, purpose, usage notes and the rest of its governed meta from the
  instance above it every cycle (`GET /api/sync/meta`), so a space created by a join is no longer bare. The merge only
  adds: new types are added, a type both sides hold keeps its local properties and gains the network's, and an exact
  type-and-property match takes the network's definition. Nothing local is removed, nothing flows up, operational
  settings stay local, and a schema that cannot be merged is skipped without stopping the records.

- **A space can be added to an existing network** (`F-38.3`). Until now a network carried the spaces it was created
  with and nothing more. The publisher of a pub/sub network, or the root of a tree, now adds one from the network card,
  `POST /api/networks/:id/spaces` or MCP `network_add_space` — same parameters, rights and refusals on all three. The
  members' tokens reach the new space at once, and each instance below adopts it on its next sync from its upstream
  only (a subscriber from its publisher, a node from its parent): created if missing, merged into if present, nothing
  overwritten or deleted. Club, closed and democratic networks decide it by vote (`F-38.4`, below). Audited as
  `network.space.add`.

- **Joining a network lets you choose where each of its spaces goes** (`F-38.2`). The join dialog lists every space
  the invite carries, not only the ones whose name collides with a local space, and each can go under the same name,
  into any space you already have, or under a new name. The dialog says, beside the choice, that joining only adds:
  nothing local is overwritten or deleted.

- **Each network says what this instance is in it** (`F-38.1`). The Networks page shows a role — Publisher or
  Subscriber, Organiser or Member, Root, Node or Leaf — instead of a flat member count, and lists the members that
  role acts on: a publisher's subscribers, a subscriber's publisher, a club's or voted network's peers, and in a tree
  the path to the root and the subtree below. It also lists the spaces the network carries. `GET /api/networks/:id`,
  the list, and MCP `network_get` carry the same `myRole`. A club created from now on remembers its organiser; one
  stored before reads as Member.

- **A network can be read, created, updated and left over MCP** (`F-36`, first slice): `network_get`,
  `network_create`, `network_update` and `network_leave`. Each is the same act as its REST route — same parameters,
  the same rights (the Networks column, or administering every space), the same refusal sentence and the same body
  — so an agent is no longer limited to listing peers and triggering a sync. Joining, invites, members, votes,
  topology and sync history stay REST-only for now and are listed as such.

- **A space admin creates, joins and invites into networks with the spaces it administers** (`F-37`). A token
  administering every space an act touches may create a network carrying them, join a network mapped onto them —
  onto a new space too, when it may also create spaces — see that network, and generate its invite, with no
  Networks column. A space it does not administer still needs the column and is named in the refusal; a network
  carrying one stays invisible to it. Peers, votes, topology and sync are unchanged and instance-admin.

- **Joining a remote network goes by the Networks column too** (`F-34.1`, `POST /api/networks/join-remote`). A
  token below instance admin may join with `networks: write` on every local space the join maps to; a space the
  join would create also needs `createSpaces` and a floor of `write`. The check runs after the handshake's apply
  and before finalize — the only point the space list is known and nothing is written — so a refused join leaves
  nothing behind, and the membership is recorded as the joining token's for the leave rule.
- **Token rights gain a Networks column** (`F-34`). A token below instance admin can now act on networks through
  the `networks` rung it holds on the spaces a network carries — on EVERY one of them: `read` sees a network
  (`GET /api/networks`, `GET /api/networks/:id`, MCP `network_peers`; one it may not see is a 404), `write` creates
  one with the space and leaves a membership it established, `admin` changes a network's settings and leaves
  anyone's. A membership with no recorded establisher needs `admin` to leave. Joining a remote network, invites,
  peers, topology, votes and sync stay instance-admin. Existing tokens hold `networks: none`; a matrix body may
  omit `networks` and gets `none`, so a client written before the column keeps minting. Space admin does not
  include it — sharing a space with another instance is its own decision.
- **An `ingest` run reports its provenance** — `ids` (each key of the extraction → the record id it has now)
  and `sourceTurns` (record id → the turns it came from), on `GET …/ingest/:runId` and `ingest_status`.
  Reported, never stored: a turn id in a record would be noise in its vector, so the run is the one place a
  caller can join a record back to the conversation.
- **`ingest`: a conversation in, records out** (`F-31`; `POST /api/brain/spaces/:spaceId/ingest` and
  `GET …/ingest/:runId`, MCP `ingest` and `ingest_status`). A raw conversation (`sessions`) runs every phase of
  the conversation extractor; an extraction already made (`extraction`) is validated and written with no model.
  It answers `202` with a run id at once and the run is read back: phase, counts written, claims dropped and
  why, turns no claim covers, which backends answered. Refused with `409` BEFORE any model is paid for when the
  space lacks the `conversation` group or, for a raw conversation, a decision model, the assist model or the
  `doc-nlp` sidecar — each refusal names what to change. Every record goes through the batch door's rules;
  transcripts are files, so they are written only for a token that also holds `files: write`. Runs are held in
  memory. See the integration guide's Ingest page.
- **The Schema Library ships the `conversation` group** — the types the extractor writes — seeded into every
  instance at start, first run included. Seeding adds a missing entry by name and never replaces one, so an
  operator's edit is kept. Apply it to a space with **Apply group to space**.
- **A batch answers with the ids its keys were given** (`refs` on `POST /bulk` and `save_bulk`). An item's
  `$ref` key was resolved inside the call and thrown away, so a caller that needed the new ids read the
  space back by text. The response now carries `{ "post-1": { id, kind } }`, one row per key whose item
  was written; a refused item's key is absent.
- **An NLP sidecar for the conversation extractor** (`F-31`, `sidecars/doc-nlp`). It is bundled like the
  other models, and `DOC_NLP_REPLICAS=0` leaves it out. It returns spaCy's named entities and noun phrases, which the
  extractor proposes as candidate mentions (step 4.1). The decision model then judges them, so casing and
  misspellings are its to handle, not a rule's.
  - **Why spaCy's transformer model:** measured on the ten committed LoCoMo extractions, it proposes 96% of
    the entities whose name the conversation says. That is ahead of spaCy's large model (92%), wink-nlp
    (87%), hand-written rules (88%) and GLiNER (87%), at about 30 ms a turn over HTTP.
  - **Hardening and wiring:** it is hardened like `doc-render` (non-root, read-only, internal network, no
    egress) and never downloads at runtime. The server reaches it through `NLP_SIDECAR_URL`.

- **A decision model for the extractors, configurable on Settings → Models** (`F-31`). The conversation
  extractor asks a model only its judgement questions (*who is "she"*, *is this turn pasted*), and this is
  the model it asks. It defaults to TypeSafe's System One (`https://api.typesafe.ai`, `jev-latest`) and
  follows that API's contract, so choices come back with their full probability distribution. Set it in
  config (`decisionModel`), through `PATCH /api/admin/media-config`, or with `DECISION_URL` /
  `DECISION_MODEL` / `DECISION_API_KEY`. The key lives in `secrets.json`. **Nothing is sent until the operator
  acknowledges the host**, and that is checked when the call is made as well as on save. Without consent,
  the same questions go to the assist model, constrained to the listed options. With neither, extraction
  is refused up front instead of guessed. Code checks every answer before anything reads it: a choice
  outside its options, or a missing answer, is marked `invalid`. A question that offers no no-match option
  is refused before it is sent. It has its own call budget (`modelSlots.decision`) and private-address
  switch (`YTHRIL_ALLOW_PRIVATE_DECISION`), and appears in the egress matrix.
- **`graph_traverse` returns the records it reached, not only their names** (`F-32`). A new `projection`
  parameter on both doors (MCP `graph_traverse` and `POST /spaces/:spaceId/traverse`) takes the same
  grammar as `query` and `recall` and is applied to every node and every stored edge. With it, one call
  reads a whole subgraph with its content. Without it, reading one flow from a space took a walk plus a
  `query` per collection over the ids the walk returned.
  - Omitted, the answer is the lean one, unchanged.
  - The walk's envelope always survives: `_id`, `depth` and `kind` on a node; `_id`, `from`, `to` and `label`
    on an edge.
  - The vector never comes back, and the diagnostics only with the new `includeDiagnostics`.
  - An edge's `properties` come with it, so a conditional edge's instruction and predicate arrive in the
    same answer.

  The owner, shown the three-call recipe, asked *"is that not just an includes flag?"* — and `recall`'s own
  traverse has taken a projection for a long time.

- **The benchmark schema is fingerprinted beside the prompt, and a pet can like a place** (`Q-27`). The
  schema is an input every extractor reads, exactly as the prompt is, and it went unrecorded — so a
  vocabulary change landing mid-round would leave half a corpus written against one schema and half against
  another, with nothing in any file to say so. Every extraction now carries `schemaSha256` beside
  `promptSha256`; `check` refuses a file without it, `merge` stamps it from the tree, `status` counts a file
  done only under both, and `stats` warns on a two-schema corpus.

  **The ten committed extractions are stamped with the schema of the commit that produced them**, which
  neither the schema nor any of the ten has moved from since. Then `likes` widened to run from an `animal`
  as well as a `person`: `conv-44`'s extractor drew one from a dog to a dog park and the merge refused it.
  Landed between rounds and after the stamp, so the corpus records the vocabulary it was written against.

- **One graded benchmark run: every question, both arms, every seed, one report** (`B-6`). The retrieve, arm
  and grade steps each held one rule; `benchmarks/harness/run.mjs` holds the ones that only exist once they
  are joined, and each of them produces a plausible number when dropped. The judge's independence is checked
  before anything is called. Retrieval runs once per question, not once per seed. The answerer is handed
  the question, the context and the seed, and nothing that names which arm it is in. A failed step leaves a
  seed UNSCORED rather than low, and the published figure carries its min and max across seeds.

  **The grade step ships with it, and had never been committed.** `grade.mjs` and its test were written for
  the previous `B-6` increment and existed in one working tree only. The answerer and the judge are handed
  in, so all of this runs against fakes today; with the two provider keys it is configuration, not a build.

- **A graded run that needs no provider key, and survives a rate limit** (`B-6`). `benchmarks/tier0.mjs`
  runs the whole round as files: one input and one answer file per conversation per arm, one batch file
  per judge upload, every write atomic, and `status` read off the disk. So a run stopped at any point
  resumes from what is already there. An answer file counts as done only for the input it was made
  from, so a changed input cannot be graded against a stale answer. Every answer gets LoCoMo's token F1
  with no model. A balanced 200-question sample goes to an external judge blind to the arm, and a
  truncated reply leaves the rest ungraded rather than wrong. What the answerer is handed is checked to
  carry no reference answer, adversarial answer or evidence.

  **The first round is recorded, and its method is disclosed with it.** One answerer answered both arms
  of all ten conversations, memory arm first and each arm independently of the other, so a baseline
  answer never saw the retrieved hits and a memory answer never saw the transcript. On F1 over 1,540
  scored questions the memory arm reads 62.7 against the baseline's 67.5. The baseline is the whole
  transcript in context, which is the ceiling and not a competitor. **Judged by a GPT model from a
  different vendor on a blind, balanced 200-question sample: memory 82.5% against the baseline's 84.5%,
  a gap of −2.0 with a 95% interval of −6.2 to +2.2**, from about 2% of the text per question. With the
  judge in place the graded runner shipped: retrieve, both arms, a different-family judge and the baseline
  column. Method and caveats are in `benchmarks/README.md` → Results.

### Changed

- **The compose install caps the app and the database's memory** (`Q-46`). `ythril` and `ythril-mongo` had no
  ceiling while every sidecar did, so on a shared host MongoDB sized its cache from the whole machine and the
  app grew without bound. Both now default to 4 GB (`YTHRIL_MEM_LIMIT`, `YTHRIL_MONGO_MEM_LIMIT`), and MongoDB
  sizes its cache from the ceiling. An existing install picks the limit up on the next `docker compose up`;
  raise it in `.env` for very large spaces or ingests. Kubernetes deployments keep setting their own pod limits.

- **The benchmark writes its corpus through `ingest`** (`F-31`). `benchmarks/writer/write-space.mjs` validates
  an extraction, creates the space and hands the extraction to the product's door, so the space a benchmark
  scores is written exactly as a user's conversation is — by one writer. Three things the old writer never
  did now happen, so **a score measured after this is not comparable blind to one before it**: an entity's
  description is written, a chrono entry links the claims that dated it, and transcripts live under
  `transcripts/<conversationId>/`.
- **The External assist model is consented to per use** (`F-35`). It does two jobs that send different things —
  the document repair pass, and conversation work for `ingest` (writing claims, and answering the extractor's
  questions when no decision model is set). Consent was one host acknowledgement, given under a dialog that
  named document content alone, and both jobs read it. `acknowledgedHost` now means documents only, so no
  consent given before grows; conversations have their own `acknowledgedHostForConversations`, set by the card's
  **Allow conversations** in a dialog that names what they send. **An instance that ingested raw conversations
  through the assist model must allow conversations once** — until then ingest refuses and says so.
- **The user guide's media, model and embedding settings are their own chapter**
  (`docs/userguide/04a-media-and-embedding.md`). The settings chapter had reached the 900-line limit, and
  the Models tab is a topic of its own. Every anchor is unchanged, so the in-app help links still land.

- **The README describes Ythril as a knowledge management system, and its quickstart works on 5.x.**
  It pitched a memory for one assistant, and a rename had left it saying *"give your AI a fact"* and *"the
  fact layer"*. The quickstart pointed MCP clients at `/mcp/general`, a 4.x per-space address that 5.0
  replaced with the single `/mcp`, and it named two tools, `find_similar` and `er_model`, that 5.x does
  not register. It now leads with what the product holds (semantic search, the graph, the timeline,
  files, sync, one API over MCP and REST), shows the REST door beside the MCP one, and publishes the
  LoCoMo result with its method. The gate holding the README's lookup claim matched the retired
  `find_similar` name, so it kept passing on a stale sentence. It now matches the blind-spots claim, and
  the tool names are checked against the registry.

### Fixed

- **A round arriving from a peer can no longer pass itself off as this instance's own** (security, `S-7`). An
  instance read "I proposed this" off the round's subject, which a peer sets — so a peer could make a member
  treat a space addition as its own, joining a private space of the same name to the network, and a passed schema
  change as an edit of its own definitions. Each instance now records which rounds it opened itself and never takes
  that from a peer. (The same fix's voter rule shipped in 5.1.7.)
- **Starting ingest runs is rate limited on REST as it already was on MCP** (security, `S-8`). The MCP
  `ingest` tool was held to the heavy-call limit while `POST /api/brain/spaces/:spaceId/ingest` had only the global
  limiter, so a token allowed to write knowledge could start runs without bound over REST and exhaust the model
  backends. The limit now sits in the one module both doors call, the two doors share a single count per token, and
  only a run that actually starts is counted.


- **A network card counts one member in the singular** (`Q-54`). The role badge read "1 peers", "1 subscribers";
  one member now takes its own string in English, German and Polish.

- **An unchanged network schema no longer rewrites the config every sync cycle** (`F-39.2` follow-up). Storing what
  an upstream sent, and rebuilding the space's schema from it, saved the whole config file for every space on every
  cycle even when nothing had changed. An identical layer is now nothing to do, and a rebuild writes only when
  something it holds changed.

- **A networked space's schema is changed by the network's vote on every door** (`Q-52`). `PATCH` and MCP
  `schema_update` turned a schema edit on a networked space into a vote; `PUT /schema`, the single-type upsert and
  delete, and the schema library's apply wrote it at once. They now open the same `meta_change` round and answer
  `202 vote_pending`. A space in no network is unchanged.
  **For an integrator:** a script that writes a networked space's schema through those routes now gets `202`
  rather than `200`, and the schema changes only when the round passes.

- **An edit made through MCP is audited with what it changed** (`Q-50`). The REST door recorded each edit's
  before and after as the audit entry's `changes`; the same edit through an MCP tool left the operation alone, and
  no record id. Ten tools now record both — the record edits, the entity merge, the network settings and space
  additions, and the space and schema updates — and a gate derives the set from the routes that record changes, so a
  new pair cannot miss it.

- **A space mapped under another name at join answers its peers** (`Q-51`). When a join maps a network's space onto
  a local space of a different name, this instance translated the name on its own requests but not on its peers':
  they asked for the network's name and were refused with `403`, so every sync cycle a peer ran for that space
  failed, while this instance's own cycle still moved the data. Incoming sync requests are now translated before
  anything admits or reads by them.

- **A network member's link direction and address were never shown on the Networks page.** Each member row read two
  field names the server does not send, so every member was labelled `both` — a publisher's subscriber included —
  and no address appeared. The rows now show the real direction and the peer's URL.

- **A stored rights matrix missing an area read as reaching the space** (`reachesSpace`). The check compared each
  area's rung to `none`, and a missing area is `undefined`, which is not `none` — so a matrix without an area
  reached every space it had a row or floor for. Latent until an area was added; a missing area is now `none`.
- **A document pasted into an ingested conversation could be mined into claims** (`F-31`, 2.5). The claim
  writer now sees a pasted turn marked as material the speaker brought, as a bounded preview, under a rule to
  say what was shared and asked — never to state its contents as facts. A pasted document also no longer sets
  the size of the writer's prompt.
- **An ingested conversation with an assistant in it filed the assistant's facts as the person's** (`F-31`,
  5.4 / 5.5). A claim took the speaker of its exchange's first turn, so a restaurant or a dosage an assistant
  supplied became something the person said — and a speaker named `assistant` failed the whole ingest at
  validation. Where an assistant speaks, the extractor now asks who originated the fact: only the assistant
  as origin is its claim, marked `attributed` and stored unranked; restating, unclear or a refused answer is the
  person's. An assistant's fact the conversation did nothing with is dropped and reported.
- **A batch item dropped `superseded` and `suppressEmbeddings`** (`POST /bulk`, `save_bulk`), on all four
  record kinds and both doors. The guide says an item takes the same fields as its single-record endpoint,
  and every single create takes both; the batch answered 207 and stored the record without them. Both are
  now read by one shared parser that iterates the declared flags (`parseRecordFlags`), so a non-boolean
  refuses the item and a future flag reaches the batch door by being declared.
- **A REST upload whose metadata write failed answered 2xx** (`files/store-file.ts`). The single-request
  upload swallowed that failure and reported the file as written, so the bytes sat on disk with no record
  behind them and nothing said so. It now fails the request, the same as MCP `write_file` always did.
- **MCP clients were told to call tools that no longer exist** (Q-45). The server instructions, the first
  text a connecting agent reads, named `list_chrono`, `find_similar`, `list_peers` and `sync_now`. `help()`
  named `find_entities_by_name`, `get_space_meta` and a `query` tool. All of these were renamed or folded
  away. The instructions' space sentence is now derived from the tools' own schemas.
  `mcp-text-names-only-real-tools.test.js` fails on any snake_case word in the help, the instructions or a
  tool description that is neither a tool nor a parameter. `retry_embed_record` pointed files at a
  nonexistent `retry_embedding` (it is `retry_embed_file`), and a schema refusal said `get_space_meta`.
- **The entity-delete refusal contradicted itself** (Q-45). The 409 said *"there is no cascade delete for an
  entity"* while the same body described the cascade. It now says the cascade removes the blocking edges.

- **A recall across several spaces reranks once, over all of them** (`P-35`). Reported by the platform
  operator, 2026-09-23T1842Z: one recall naming no space, on an instance reaching 15 spaces, put 13
  concurrent requests on the reranker. Ten of them died under the shared deadline, so the answer came back
  `degraded: ["rerank_unavailable"]` with 2 of 10 rows reranked. Each per-space `recall` ran its own
  cross-encoder pass, the same fan-out the query embedding had until it was embedded once. The spaces now
  hand back their candidate pools, and the merged pool is scored in one request of at most 100 passages, so
  the scores in one answer also come from one call. Single-space recall is unchanged.

- **The benchmark harness reaches a 5.x instance** (`B-6`). Three 4.x addresses stopped it the first
  time it ran against 5.1. The writer sent `entityIds`/`memoryIds`, which 5.0 refuses by name, so every
  conversation stopped at its first chrono entry. The client called `recall` and `query` at their 4.x
  per-space addresses, both removed in 5.0. And retrieval flattened recall's results but not the
  `_graph` each one carries, so a run recorded `traverse: 1` and handed the answerer nothing the
  traversal reached. The dropped half was the multi-hop half of the graph.

- **The 5.0.0 breaking table names the retired routes with their methods, and says to reconnect MCP clients.**
  Reported by the canary operator, 2026-09-23T0850Z and 0840Z. It said *"the five per-collection list routes
  are gone"* — ten `GET` routes went, and an audit that matched on PATH cleared `GET .../files` because
  `PATCH .../files` still exists. The path survived, the method did not, and their documentation ingest
  went stale with one warning in a long log. The table now lists all ten with their verb. A client that
  stayed connected across the upgrade holds the old tool list and sees every call fail rather than the
  rename, so the table now says to reconnect.

### Internal

- **The test stack leaves the machine room to work** (`Q-57`). Every test service now has a CPU ceiling as well as a
  memory one, and the defaults together come to 8.5 CPUs and 16 GB — two thirds of the Docker VM at most — where nine memory
  ceilings had added up to more than the VM and nothing bounded CPU. Each is raised by
  `YTHRIL_TEST_{APP,MONGO,DOCRENDER}_{CPUS,MEM}` on a bigger runner, and instance A — which carries the standalone and
  integration suites — has its own larger memory defaults (`YTHRIL_TEST_APP_A_MEM`, `YTHRIL_TEST_MONGO_A_MEM`).

- **Build & Test runs on pull requests into a release branch** (`Q-56`). A patch is bumped through a PR into
  `release/X.Y.x`, and the changelog check counts an entry under a version section that same change adds, as it
  counts one under `[Unreleased]` — a section that already existed still does not.

- **Which endpoint each assist-model caller uses is pinned before it changes** (`F-33`, characterization).
  `which-assist-endpoint-each-caller-uses.test.js` states, through a loaded config, when the describe step, the
  extractor's writer and its decision fallback use the assist model, so the resolver `F-33` moves them to is held to
  the same answers.

- **`npm run machine:free` gives the machine back its disk and memory in one command** (`Q-55`, `scripts/machine-free.ps1`):
  removes the test stack, prunes everything no running container needs, trims the VM disk, then runs
  `docker:compact` — which restarts WSL, the only thing that returns the Docker VM's held memory. `-Wipe` deletes
  the whole data disk instead. First run: 21.9 GB returned to O:, 14 GB of memory freed.

- **A merge its dates contradict can be seen as one** (`F-31`, 4.7). The entity judge now sees each turn's resolved
  dates beside every candidate's description, and the merge question says a card whose dates contradict them is
  not it — judged where both halves are visible, rather than guessed by a code rule.
- **The conversation extractor writes the ARC as well as the moments** (`F-31`, 5.8, `arcs.ts`). A subject with
  claims in three or more sessions gets one claim saying how it developed, written from those claims and checked
  like any claim — linted, refused by the evidence gate, citation-checked, one rewrite; the writer may answer NONE.
  It cites a few turns, never most of the conversation, and is added after change tracking so it cannot retire
  the moments it describes.
- **A state told in several sessions is written once** (`F-31`, 5.9, `repeats.ts`). A later telling of the same
  unchanged fact is folded into the first claim as its source turns, so one answer does not fill five ranked slots.
  Asked only across sessions and between claims sharing an entity; it runs before change tracking, so a change is
  never folded away, and a person's claim is never merged with an assistant's.
- **The conversation extractor dates an edge only when its text does** (`F-31`, 6.3, `edge-dates.ts`). `since`
  and `until` are asked per day-precise, non-approximate date of the edge's own claims, and written only on a
  confident yes; a date merely near the relationship dates nothing, and an end before its start writes neither.
- **The server build copies `src/**/*.json` into `dist/`** (`server/scripts/copy-src-assets.mjs`). `tsc` emits
  JavaScript only and the image ships `dist` only, so a data file under `src` did not exist at runtime; an empty
  copy fails the build.
- **The conversation extractor writes what it found** (`F-31`, phase 10, `extractor/conversation/write-extraction.ts`).
  The server port of the benchmark's `write-space.mjs`, over the batch door rather than the bare record
  writers, so an ingested record meets the same schema, linkage and flag rules as any other write. An
  entity the space already held is linked by id; the validator now accepts those keys and requires a UUID.
- **Every door writes a file through one sequence** (`files/store-file.ts`, `storeFile` / `recordStoredFile`):
  quota, bytes, metadata, the processing queue and the webhook. The REST upload (single and chunked) and MCP
  `write_file` each held a copy, and `ingest` was about to be the third. The hash-hand-over gate now asserts
  the sequence once and that no door writes metadata or dispatches on its own.
- **The extraction validator moved into the server** (`F-31`, 9.2, `extractor/validate-extraction.ts`). The
  benchmark's `writer/validate-extraction.mjs` now re-exports it, so the benchmark writer and the product's
  `ingest` refuse the same files for the same reasons, from one copy of the rules.

- **An evidence check refutes what code can prove, before any model is asked** (`evidence/evidence-check.ts`).
  - **What it refutes.** A text that names someone, states a number or states a date its evidence does not
    hold is refused, with the reason.
  - **What it never does.** It never passes a text: every term being present proves nothing about the relation
    between them. A negation mismatch is reported as a signal and decides nothing.
  - **Where it runs.** It is reusable. The extractor calls it in front of the citation check on claims and on
    entity descriptions, so those failures are rewritten without a model call.
  - The month and number words it shares with the time tagger now live in one list (`text/english.ts`).

- **The conversation extractor runs end to end** (`F-31`, `extract.ts`, `assemble.ts`). Phases 1–9 run in order,
  from a raw conversation to an extraction in the committed format. The benchmark's own validator accepts
  the output under test.
  - **Injected.** Every model and service is: the decision model, the writer, the NLP sidecar, the space's
    search.
  - **Returned.** Every judgement is kept with its raw answers, alongside the dropped claims and any
    uncovered turns.
  - **Existing entities.** Mentions merged into entities the space already holds go in `existingEntities`,
    so no Ythril id appears inside a record.

- **The conversation extractor describes each entity from its own claims** (`F-31`, 4.10,
  `describe-entities.ts`). Each description is written once, at the end, and the assist model is handed only
  the claims that name the entity. It is checked like a claim and gets one rewrite. If it still fails, the
  entity's first claim is used as the description, because the format requires every entity to have one.

- **The conversation extractor tracks change over time** (`F-31`, 7.1–7.6, `change.ts`). Each claim is compared
  with the few earlier claims that share an entity with it. The decision model is asked four things:
  - whether the situation was replaced, simply ended, or is unchanged;
  - whether the earlier claim was still true of its own period (a yes vetoes retiring it);
  - whether the two are incompatible tellings of the same fact;
  - how two numbers relate.

  Only a clear change supersedes, and a `supersedes` edge is drawn only when something replaced the earlier
  claim. Incompatible tellings and cumulative counts are both dated to their telling ("As of 9 June 2023, …").

- **The conversation extractor builds its timeline** (`F-31`, 8.1–8.4, `timeline.ts`). A claim with a resolved
  day is a candidate event, and the decision model is asked three things:
  - its status: completed, upcoming, cancelled, or unclear (`active` and `overdue` cannot be chosen);
  - whether it is merely ongoing;
  - whether it genuinely lasted more than a day, asked only when the conversation gave both ends.

  An unclear status, an ongoing thing, or no usable date means no timeline entry, and the date stays in the
  claim. A span needs both given ends and a confident multi-day answer.

- **The conversation extractor draws only legal edges** (`F-31`, 6.1 / 6.2, `relations.ts`). For each pair of
  entities one claim names, the decision model chooses among the labels whose declared endpoint types fit the
  pair, in the direction they fit, or `none`. Code filters the vocabulary before asking and checks the answer
  after, so an illegal edge is never written. The same edge from two claims is one edge citing both.

- **The conversation extractor writes one claim per exchange, and checks it** (`F-31`, 5.2 + 5.10,
  `write-claim.ts`).
  - **Writing.** The assist model is handed the exchange with its dates already resolved ("9 May 2023") and
    its entities already named, so it has nothing to work out itself. Turns about nothing are cited but never
    handed to it.
  - **Checking.** The claim is linted, then the decision model judges whether its own turns support it.
  - **Failures.** Either failure gets one rewrite with the reason attached; a second failure drops the claim
    and reports it. A refused check is not a pass.

- **The extractors write through the assist model, and wait out a busy model in one place** (`F-31`,
  `extractor/generate.ts`, `extractor/model-post.ts`).
  - **Who writes.** The steps that must write text (a claim's sentence, an arc, a description) go to
    `documentProcessing.assistModel`, and only once its host is consented to.
  - **Waiting.** The retry-and-stop logic for 429, 503 and 529 is now one helper, shared by the decision
    client and the generation client.

- **The conversation extractor groups turns into exchanges and checks its claims** (`F-31`, 5.1 / 5.3 / 5.7,
  `claims.ts`).
  - **Grouping.** Per session, one request asks whether each turn continues the exchange before it, starts
    one, or is about nothing. A refused answer continues; a turn about nothing rides along and is never
    written from.
  - **Checking.** A written claim is refused if a resolved date is missing, if it opens with a pronoun, or if
    it carries turn or session references.
  - **Coverage.** Every turn ends up in some claim's source turns, and an exchange with no claim is reported.
  - **Linking.** A claim is linked to the entities it names among those its turns mention. A thing
    mentioned once is minted when a claim names it; a turn that merely falls inside a claim is not enough.

- **The conversation extractor judges its entities** (`F-31`, 4.12 / 4.2 / 4.4 / 4.6, `judge-entities.ts`).
  - **What is asked.** Per turn, one request asks the decision model about every mention: is it a thing the
    conversation is about, which shortlisted entity is it or is it new, which of the space's types it would
    be, and whether it names a group.
  - **What is not asked.** A pronoun is only asked what it refers to. *"I"* and *"you"* are the speaker and
    the addressee, and are not asked at all.
  - **The policy, in code.**
    - A picked entity is a merge.
    - A type the space does not declare, or `none`, means no entity.
    - Only what the conversation returns to is minted: a thing mentioned once is kept aside for a claim to
      link.
    - Every other surface form becomes an alias.
  - Raw answers are kept with the run; the thresholds are 0.5 and still unmeasured.

- **The conversation extractor shortlists what a mention could be** (`F-31`, 4.3, `shortlist.ts`). The
  decision model then picks from the shortlist (4.4); it can only pick a card it was dealt, so the hand is
  generous, bounded to six, and built from four sources:
  - the run's own entities, exact names first, then near spellings and shared distinctive words;
  - the speaker for *"I"* and the other person for *"you"*;
  - the recent turns' entities for *"it"*, *"they"* and *"the book"*;
  - the space's own entity search, once per distinct mention.

  On the committed extractions it deals the right entity for 85% of later mentions, up from 62% on names
  alone. The recall gate is local-only.

- **Cleanup, part 1** (Q-45). Removed, in each case with nothing referencing it:
  - 165 committed build files (`client/out-tsc/`, now ignored).
  - Debris files: `purge_networks.py`, `server/_gen_token.mjs`, two `testing/_init` scratch scripts, and a
    one-off script carrying a personal path.
  - Eight npm packages that nothing imports: `multer`, `@types/multer`, eslint and its two plugins (there is no
    eslint config), `@phosphor-icons/core`, `@angular/platform-browser-dynamic`, `@types/sharp`,
    `@types/dompurify`. The lockfile is ~1,100 lines shorter.
  - 24 eslint-disable comments.
  - 30 exported functions and constants that no code or test used, including a second, unused file-quota
    check.
  - Six test files that guarded features removed in 3.0/3.1 or tested local copies of the code instead of the
    code.

- **Sidecar health probes are one module** (`util/sidecar-health.ts`). The cached `/health` probe was private
  to the render client, and the NLP client would have been its second copy.

- **The conversation extractor asks its first judgement questions** (`F-31`, DECOMPOSITION.md 2.3, 2.5,
  3.4, 3.12). `judge-turns.ts` asks only about what the code half flagged:
  - a speaker's role, when the source does not say, asked once per speaker;
  - whether a candidate paste is material the speaker brought;
  - whether a bare weekday points back or forward;
  - whether a forward weekday said on that same weekday means today.

  A turn with nothing to ask sends no request. An unclear or refused answer always takes the outcome that
  cannot add a wrong fact: a person, the speaker's own words, no day. The raw answers are kept with the run,
  so the thresholds (0.5, unmeasured) can be measured later without asking again.

- **Egress consent is one function** (`config/egress-consent.ts`). The *"is this the host the operator
  acknowledged"* comparison was written out in the document describer, the repair pass, the face model and
  the settings route. All four now ask `egressConsented`, and a gate refuses a hand-written comparison
  anywhere in `server/src`. The save-time refusal moved there too, so the decision model's settings reuse it.

- **The conversation extractor's load, classify and time phases are code** (`F-31`). `classify.ts` splits
  image captions from speech and keeps them apart, so a caption can never become a claim. It proposes paste
  candidates, each with the reason it was proposed. It also marks a photo-only reaction to ride along in a
  neighbour's claim. `load.ts` refuses a conversation it
  cannot read, naming every problem at once. It puts sessions in time order rather than page order, keys
  two sessions on one day apart, and gives every turn an id. `time.ts` finds temporal expressions and
  resolves them by the prompt's own rules, as calendar arithmetic in UTC:
  - *"last Friday"* said on a Friday is seven days back;
  - a weekend that contains today is not *"last weekend"*;
  - *"about three weeks ago"* stays approximate, with no day derived from it;
  - *"last week"* gives no day.

  It also decides what may reach a timeline. A two-ended range becomes a span only when the event
  genuinely took more than a day. That judgement, and whether the exchange places a weekday today, are
  handed in rather than guessed. So is a bare weekday's direction — newly decomposed as step 3.12,
  because it is the sentence's tense. 30 tests, each worked from a rule the prompt states; two were seen
  red by letting the day of speaking count. No route yet.

- **The conversation extractor is decomposed before it is built** (`F-31`, first step). `ingest` will turn
  a raw conversation into records inside the product, so an independent harness can reproduce what today
  needs an assistant session. `server/src/extractor/conversation/DECOMPOSITION.md` traces every rule of the
  extraction prompt to one of three treatments:
  - code;
  - a bounded Jev-style decision over a domain the code supplies (choice, score or probability);
  - open-world writing.

  Of 66 steps, 40 become code and 4 remain writing: even a mention is found by code and judged by the
  model, never named by it, and every written claim is checked against its own source turns. The space must already hold the extractor's schema
  group; `ingest` refuses before any model call otherwise, and never writes schema itself. The type and label choices draw from the schema, so an
  invented type is impossible rather than forbidden. The schemas sit beside it one file per record type, the
  way the `flows` space lays its own out. A gate recounts the tally from the tables and holds the split
  schemas identical to the benchmark's until the benchmark reads them from here.

- **`F-19` leaves the manual-verify exemption map.** Its exploration finished — no demand signal for a rules
  engine, and the cheap parts already exist — so it became an owner decision rather than open work, and a
  stale exemption fails `todo:check`. The map stays, empty, for the next item whose evidence cannot be a count.

## [5.1.7] — 2026-09-25

A security patch for networks: a deletion or wipe vote can only act on a space its network carries, and only once it
has passed, and a member can no longer be named as a round's proposer to have its vote ignored. Please roll it onto
every instance that is in a network.

**Who is affected.** Every instance in a network. A `space_deletion` or `space_wipe` round was applied whenever it had
concluded with no veto — so a proposal that EXPIRED without enough yes deleted or emptied the space as if it had
passed — and it acted on the space id exactly as the round named it, without checking that the network shares that
space. Any member of any network could therefore delete or empty any space on another member, including a private
one no network carries, and an old deletion round re-applied to a space later re-created under the same name.

**What to do.** Roll the image. There is no config change and no migration. If a space disappeared or was emptied
on a networked instance and nobody voted for it, it is gone; restore it from a backup.

### Fixed

- **A deletion or wipe vote acts only on a round that passed, only on a space its network carries, and once**
  (security). An expired round deletes nothing, a round naming a space the network does not share is ignored, and a
  concluded round is applied here at most once.
- **A member cannot be named as another round's proposer to drop its vote** (security). A round's subject was left
  out of its voters on every round type, so a peer could name any member as the proposer of a deletion or schema
  change and that member's vote was no longer needed on the other members. The subject is now left out only on a
  join or a removal; the real proposer's yes is cast, signed, when it opens the round.

## [5.1.6] — 2026-09-25

A security patch for networks: an invite can no longer be applied under another peer's instance id. Please roll it onto
every instance that is in a network.

**Who is affected.** Every instance in two or more networks with the same peer. Since 5.1.2 the token an invite
handshake mints reaches every network the two instances already share, and the joining side's instance id was taken
on its word. So anyone handed an invite bundle for one network — including, since 5.1.x, one minted by a space
administrator — could apply under the id of a peer the inviter already syncs with, and read every space the inviter
shares with that peer. The joining side trusted the inviter's claimed id the same way.

**What to do.** Roll the image. There is no config change and no migration. An instance joining a network for the
first time is unaffected; a peer that is already connected and joins a SECOND network proves itself automatically once
it runs 5.1.6 too — an older joiner is refused (`403`, naming the reason) by a patched inviter until it is upgraded.

### Fixed

- **An invite cannot be applied under another peer's instance id** (security). An id that is already a peer must now
  present a token the inviter issued to it, which a genuine peer's own join does, and a joiner refuses an inviter that
  claims a known peer's id from another address. A refused apply mints nothing and is logged.

## [5.1.5] — 2026-09-25

A patch for networks: two networks joined from the same peer at the same moment both keep syncing.

**Who is affected.** An operator who joins two networks from the same instance within seconds of each other — or
whose two instances join each other into two networks at once. Each instance keeps one token per peer, and each
handshake hands over a new one scoped to the networks the pair shared at that moment. When the two handshakes'
steps interleaved, the token that was kept lacked one of the two networks, and that network answered every sync with
`403` until another handshake happened. Joins made one after the other were never affected (fixed in 5.1.2).

**What to do.** Roll the image. A pair already caught by it recovers on its next handshake, or by leaving and
rejoining the network that answers `403`. There is no config change and no migration.

### Fixed

- **Two networks joined from the same peer at once both keep syncing.** Once a join is registered, every token
  either side keeps for the other now also reaches that network's spaces — at finalize on the inviter, and after
  registration on the joiner — so whichever token a racing second handshake leaves in place reaches both. A wider
  token is not wider access: a peer is still admitted only to the spaces of networks it is a member of.

## [5.1.4] — 2026-09-25

A patch for the web interface: network votes can be seen and cast from the Networks page again.

**Who is affected.** Every operator who governs a network from the web interface. Since the vote list was written,
the page read a vote round in a shape the server never sent, so it listed no open round at all — on the Networks page
and on the Brain overview's Governance panel — and showed nothing to vote on. Votes cast through the API or MCP, and
votes that peers cast, were never affected: the server always held and decided the rounds correctly, and a round
nobody could see from the page simply ran to its deadline. A network whose join, removal or space-settings change
seemed stuck for that reason can now be decided from the page.

**What to do.** Roll the image, open Settings → Networks, and look under **Open votes** on each network. There is no
config change and no migration.

### Fixed

- **The Networks page lists open votes, and Yes and Veto reach the round.** The page read `id`, `subject` and
  `status` where the server sends `roundId`, `subjectLabel` and `concluded`, so every round was filtered out as not
  open, and a cast would have gone to `/votes/undefined`. The rounds are now translated in one place, where both the
  Networks page and the Governance panel read them.

## [5.1.3] — 2026-09-25

A patch: a token granted only space administration can write again.

**Who is affected.** Only tokens whose rights are a space-administration grant and nothing else — no floor and no
per-space rungs. That shape has been possible since 5.0, when space administration became a grant of its own. Such a token could read its
spaces and was refused every write with *"This token has read-only access"*, although it administers them. A token
that also holds any written `write` rung was never affected.

**What to do.** Nothing, beyond rolling the image. There is no config change and no migration: the grant was always
stored correctly, and it is only the check that now reads it.

### Fixed

- **A token granted only space administration was refused as read-only.** Since 5.0 space administration can be
  granted on its own, and it means `admin` in every data area of those spaces — but the read-only check counted
  only written rungs, so a token holding just the grant was turned away with *"This token has read-only access"* by
  every route that refuses read-only tokens, before that route's own check ran. It now counts the grant.

## [5.1.2] — 2026-09-25

A patch for networks: two instances that share more than one network keep syncing all of them, a sync that
transferred nothing no longer reports success, and a space-settings change your own vote passes applies at once.

### Fixed

- **Joining a second network with the same peer no longer cuts off the first.** Each instance keeps one token per
  peer, and every handshake replaced it with a token that reached only the network being joined — so the moment
  two instances shared a second network, every push and pull on the first answered `403`, in both directions, with
  nothing logged as an error. A peer token now reaches every network the two instances share; each request is still
  admitted only to the spaces of networks the peer is a member of, so leaving one network still withdraws its
  spaces. The joining side also no longer hands over an all-spaces token when the network carries no spaces — it
  reaches none. **After upgrading, re-join any second network created between the same two instances**, so both
  sides hold a token that reaches all of them.

- **A sync cycle whose transfers were refused is no longer recorded as a success.** A refused or cut-short
  transfer held its watermark and logged a warning, and the cycle still counted the member as synced — so a network
  answering `403` on every request showed `success` in its history while nothing transferred. Such a member now
  fails the cycle (`partial` or `failed`), the history's `errors` names the space, direction and transfers that
  stopped, and the member's consecutive-failure count rises. A member with no peer token is reported the same way.

- **A space-settings change your own vote already passes is applied at once.** On a club or pub/sub network one
  yes passes a vote, and the proposer's yes was recorded when the vote opened, but nothing counted it — so the
  change answered `202 vote_pending` and did nothing until somebody cast the same yes again or the vote expired a
  day later. It now concludes when it opens if the proposer's vote is enough, and answers `200`.

## [5.1.1] — 2026-09-24

A security patch: a network invite that was applied and never finalized no longer leaves a permanent peer
token behind, and any left by earlier handshakes are revoked when the instance starts.

### Fixed

- **A network invite that was applied and never finalized left a permanent peer token behind** (security). Apply
  creates the joiner's token on the inviting instance before finalize registers the member, and it had no expiry;
  the handshake session that knew about it lived only in memory for an hour. So a joiner that crashed, was
  refused, or lost the connection between the two steps — or a restart in between — left a token to the
  network's spaces that never expired and belonged to no member. The token now expires with its handshake and
  finalize clears the expiry once the member is real. **At start, peer tokens whose instance shares no network
  with this one are revoked**, which removes any left by earlier handshakes; a member or a joiner with an open
  vote round is never touched.

## [5.1.0] — 2026-09-23

**A batch item can carry its own relationships, and five things that answered success while doing nothing
now say so.** One capability and a week of reports from the canary operator and the fleet integrator,
released before the benchmark work starts so none of it waits behind that.

| | |
|---|---|
| new | a `/bulk` / `save_bulk` item takes the `link*` fields its kind can hold plus `edges`, and the reply counts them under `connections` |
| now refused | `/bulk` with a retired key (`memories`) or an item with a retired link array (`entityIds`), which used to answer `207` with nothing written |
| now visible | a failed watched config reload, on `ythril_config_reload_pending` and `ythril_config_reload_failed_total` |
| now works | reranking against a stock reranker, which refused the unbatched request |
| what to do | upgrade. A batch still sending `memories` gets a `400` naming `facts` — that is the fix, not a regression |

### Added

- **A batch item attaches its own relationships, exactly as a single write does** (`Q-44`). Every
  single-record door takes the link classes its kind can hold plus `edges`, so a record and everything it
  points at is one call. The batch door took two link classes, validated by its own copy of the rule, and
  refused `edges` outright — so the door where the arithmetic is worst, hundreds of records at a time, was
  the one that still needed a second pass.

  Both surfaces now build those fields from the same module the single doors call, which is also what
  retires the copy: this loop had a UUID pattern per link field that checked less than the shared one and
  had drifted from it in the direction nothing reports — a `linkFiles` on a fact was accepted and never
  read, a non-array `linkEntities` was quietly treated as empty.

  **The response grew a `connections` count**, separate from `inserted.edges` deliberately: that number is
  the top-level `edges` array, a collection the caller wrote, while these are relationships hung off records
  the caller wrote. Folded together neither could be reconciled against the payload. The `bulk.write`
  webhook carries it too, and it counts toward whether that webhook fires at all — fifty attachments to
  records that were only updated is fifty rows written, and a workflow watching for exactly that would have
  been told nothing happened.

  **An item's own `edges` name records that already exist; a `$ref` there is refused** and the refusal names
  the top-level array, which runs after every record array and resolves one. An item is applied when it is
  written, so a key declared further down could not resolve, and resolving only backwards would make a
  payload's validity depend on the order it was typed in. **A connection that cannot be honoured is refused
  before the record is written**, so a bad `edges` entry leaves no row behind.

### Fixed

- **A config reload that failed left one log line and nothing to alert on** (`Q-43`). Reported by the
  canary operator, whose edit sat out of effect until the next restart with the only evidence in a pod log
  nobody was tailing. The endpoint they blamed is correct — `POST /api/admin/reload-config` answers `500`
  on a file it refuses. The silent half is the **watcher**, which has no caller to answer and logs instead.

  Two metrics now, because they answer different questions. `ythril_config_reload_pending` is the one to
  alert on: `1` while a refused reload has left the running configuration older than the file, cleared by
  the next reload that succeeds. `ythril_config_reload_failed_total` is the history beside it.

  **The gauge matters more than the counter here**, and the reason is in the watcher: it claims the file's
  modification time *before* reloading, so broken bytes are not re-read every tick — which means a failed
  watched reload is never retried on its own. A counter that moved an hour ago says it happened; the gauge
  says it is still true.

- **`/bulk` read a retired name as success, and it was the one write door that did** (`Q-41`). Reported by
  the fleet integrator: `{"memories": […]}` answered `207` with nothing inserted and an empty `errors`
  array — the same answer a body that legitimately wrote nothing gives. Around thirty of their builders had
  been writing into that key and seeing success.

  The batch body takes its four keys and no others now. `memories` is refused by name with `facts` as the
  replacement; any other unrecognised key is refused with the four that are accepted. **An item carrying a
  retired link array is refused the same way** — `entityIds`, `memoryIds` and `chronoIds` were dropped just
  as quietly one level down, and a batch is where that costs most.

  Both go through the module every single-record door already calls, rather than a second check that would
  need its own sentence kept in step. The allowed keys are derived from one tuple, so a fifth collection
  cannot be accepted by the writer and refused by the door.

- **The reranker was sent up to a hundred passages in one request, and a stock server refuses that**
  (`Q-42`). Reported by the canary operator: every unfiltered search on their fleet had been served in
  fused order, for as long as their settings had been what they are. A `413 Payload Too Large` reaches the
  caller as `degraded: ["rerank_unavailable"]`, which is indistinguishable from a search with no reranker
  configured — so it can be true for months with nothing to see.

  Candidates are split into batches of **32** now, settable as
  `mediaEmbedding.rerank.maxPassagesPerRequest` (1 … 100) through the admin API. Total work is unchanged —
  a cross-encoder is a forward pass per passage — and the pass keeps **one** deadline rather than one per
  batch, so a recall somebody is waiting on is bounded exactly as it was.

  **If any batch fails the whole pass is abandoned** and the vector order stands. A list ordered partly by
  cross-encoder score and partly by vector score, with nothing saying which is which, is a plausible wrong
  answer; no opinion at all is an honest one.

  The candidate pool still scales with the number of knowledge types searched, which is why an unfiltered
  recall is the most expensive shape there is. That is a separate question and is not changed here.

- **Sync never checked a FILE's links, so a broken one was recorded as nothing at all** (`Q-39`). A peer
  sending a file linked to an entity this instance does not hold produced no violation, no warning and no
  trace — and an operator reads an empty violation list as everything being fine. Absent and clean looked
  identical, which is the one failure a diagnostic must not have.

  A file's links are checked like any other record's now, and `docType` on a link violation can be `file`.
  For that one, `docId` is the file's **path** rather than a UUID, because that is what identifies a file.

  **The narrowing was removed rather than extended.** It read `fromKind !== 'fact' && fromKind !== 'chrono'`;
  what decides whether a link is checked is now the link vocabulary itself, so a fifth kind declared next
  year is checked on the day it is declared instead of waiting for somebody to add it to a list.

- **Deleting an entity that has an edge failed SILENTLY in the Brain UI.** Reported by the owner: the row
  stayed on screen, nothing was said, and the click looked as though it had not registered.

  **The server had already said everything.** It answers `409` with what blocks the delete, the preview
  route and the name of the parameter that authorises a cascade. The client's handler was
  `error: () => {}`.

  The refusal now opens a confirmation naming what would go — **counted by kind, not listed as
  identifiers**, because the decision in front of an operator is *how much goes with it* and twenty UUIDs
  obscure that. It also says what does NOT go: an edge is removed and the record at the other end of it
  stays. On confirm the delete repeats with the token from the preview, which removes the entity and the
  records blocking it. A stale token is not retried — the server returns the CURRENT set with its
  refusal, so the operator is asked again about the set as it now stands.

  An entity with nothing pointing at it still deletes in one click. Asking to confirm a cascade that
  would remove nothing is a dialog that teaches people to dismiss dialogs.

- **All four record tabs threw their delete error away, not just entities.** Facts, chrono and edges had
  the identical `error: () => {}` — the same omission four times, so the surface for it lives on the
  state the four already share rather than being added to each. A delete that did not happen now says
  why, above the list, where the row that would not go is still visible.

- **An integration file stopped testing anything the day 5.0 shipped, and reported itself as skipped**
  (`Q-38`). `a-traversed-recall-returns-whole-graphs` sent `includeFreshWrites: true` on every recall.
  5.0 removed that parameter, so every call answered `400` — and the file's own fixture guard turned that
  into a skip, saying *"could not measure the full traversed answer"*, which reads as a fixture that
  could not be built.

  **A test that skips is indistinguishable from one that passes in every summary anybody reads.** The
  measuring call asserts its status now, so a refusal fails loudly instead of disappearing into a guard
  written for a different problem.

  **Waking it found a SECOND 5.0 change it had been too inert to notice**, which is the argument for
  doing this rather than deleting the file: `recall`'s hit became `{score, spaceId, type, record}`,
  so every `r._id` read `undefined`. The comparison keyed every graph on that same `undefined`,
  collapsed to one entry, and compared one hub's subtree against a different hub's — reporting *"the
  graph on undefined differs"*, which is the tell. One accessor now reads the record, and it falls
  back to the hit itself rather than asserting which shape it got.

  A gate derives the allowed parameter names from the `recall` tool's own input schema — which IS the
  REST body's schema, because the route hands its body to `callTool` — and refuses any test sending a
  name that is not one of them. A parameter renamed or removed next year is covered as it stands.

- **A missing import in a Docker-only suite now fails in `preflight` instead of in CI.** Adding the
  index wait above to four files and the import to three of them threw `waitForIndexed is not
  defined` inside a `before` — which CANCELS every subtest under it, so one missing word reported as
  **eight failures**, seven of them saying only *"test did not finish before its parent and was
  cancelled"*.

  There is no ESLint here to lean on, and `preflight` cannot run the integration, sync or red-team
  suites because they need Docker — so that class of mistake was invisible locally and cost a full
  CI round trip. A gate derives the helper names from the shared module and checks those three
  directories, which is where the cost is: a standalone gate with the same mistake fails the moment
  anybody runs preflight.

- **Three tests recalled a record they had just written without waiting for the vector index** (`Q-38`).
  Recall's fresh-write scan covers a record whose embedding is still PENDING, so there is a window —
  after the embed job finishes and before `$vectorSearch` holds the vector — where neither path finds it.
  A test landing in it fails saying its own control is missing, which reads as a defect in the thing
  under test.

  **Pinning a seed by `_id` is not an exemption**, which is what two of the three assumed: recall ranks,
  and a filter narrows what `$vectorSearch` may return rather than replacing it.

  **Read one by one rather than swept.** Of the fifteen recall tests with no wait, most are right without
  one: some assert a refusal, some assert only a status, and `result-spill-both-doors` deliberately
  relies on the fresh-write scan and records the measurement behind that choice — waiting there hit the
  index-lag timeout and failed twelve assertions for a reason unrelated to its subject.

### Internal

- **A test named after the bulk 500-item cap had never exercised it** — exposed by the `/bulk` refusal
  above. It posted its 502 items under the retired `memories` key, so nothing was written, and its
  assertion — `inserted + errors <= 500` — was satisfied by zero. It sends `facts` now and asserts that
  exactly 500 of the 502 were processed, because a bound a zero satisfies is not a bound.

## [5.0.1] — 2026-09-22

**A read was logged as a write on the MCP door, so an operator who had turned read logging OFF still got
them.** Found hours after 5.0.0 published, and patched rather than held: a defect in an image people can
already pull is a different thing from one in a tree nobody has.

| | |
|---|---|
| who is affected | any instance on the default `audit.logReads: false` whose agents call `filter` or `similar` |
| what it cost | extra rows in the audit log. No data lost, no call refused, no record changed |
| what to do | upgrade. Nothing to re-point and nothing to re-configure |

Entries already written for those two operations stay where they are. They are correct entries under a
wrong classification, not wrong entries.

### Fixed

- **Two read tools were logged as writes, so an operator who turned reads OFF still got them.** A
  regression of the 5.0 renames, found the same day. `audit.logReads` is off by default; REST declares
  which operations are reads with `read: true` on the route rule, and the MCP door held a second,
  hand-written set of nine operation names beside it.

  `query` became `filter` and `find_similar` became `similar`; the audit MAP was updated and that set was
  not. So it still named `brain.query`, which nothing records any more, and named neither `brain.filter`
  nor `brain.similar` — **the two highest-volume read paths an agent has**. Nothing said so, because a
  read logged as a write is an extra row rather than an error, and a dead name in a hand-written set is
  never wrong out loud.

  The set is derived from the route rules now, where `read: true` sits beside the route it describes. One
  rule, one declaration: a capability cannot be a read on one door and not the other, and a new read
  route classifies the tool that mirrors it without anybody remembering to. `entity.cascade_preview` was
  also reclassified by that — it reports what a cascade would remove and removes nothing.

- **The audit guide documented 53 of the 115 operations the log can contain** (`Q-40`). The page opens by
  promising *"a full access trail"* and then lists the operations; 62 were missing, including every
  `conflict.*` and `contradiction.*`, all of `data.*`, all of `schema_library.*`, `token.update`,
  `token.regenerate`, `link.create` and `link.delete`. An integrator builds an audit query from that
  table, so an operation absent from it is a filter nobody writes.

  Found by deriving the set to check that the two operations above were documented — they were not.

  **A gate keeps it true rather than a corrected table**, which would be the same defect with a later
  date: the set comes from the route rules, the tool map and the one operation neither produces, and the
  window is the table itself, because several operations appear in that page's prose and a whole-file
  check would pass while the table stayed short.

  The gate also runs the other way. It found five operations the table named that nothing records —
  `brain.query`, `brain.er_model`, `brain.find_similar`, `brain.recall_global` and `brain.bulk_write`,
  all left behind by the 5.0 renames and folds. An integrator filtering for those reads the silence as
  *"this never happens here"* rather than as a stale page.

- **An agent syncing ONE peer was audited under the network-wide name** (`Q-37`). `network_sync` with a
  `peerId` does exactly what `POST /api/networks/peers/:peerId/sync` does, and that route records
  `peer.sync_trigger` — the tool recorded `network.sync_trigger` for both subjects, because the resolver
  was handed the tool NAME and nothing else. So an operator filtering the audit log for
  `peer.sync_trigger` saw the browser's peer syncs and none of an agent's.

  It is the defect `a-tool-and-its-route-log-one-operation` exists for, one level down, and invisible to
  that gate because the tool's first operation IS a name a route records.

  **The resolver takes the call's arguments now, and it does not trust them.** A chooser is a function of
  caller input, so it is caught, and a result outside the tool's own declared operations is refused.
  Both failures fall back to the first name: **an unaudited call is worse than one under a
  slightly-wrong name**, and that is the direction this must not fail in. The gate asserts the rule for
  every tool with a chooser rather than for the one that has one.

  **Not put on the tool definition**, where it would have been lighter for a single case: that puts the
  audit name somewhere the coverage gate does not read, and answers a question the audit map already
  answers — the same rule in two places.

## [5.0.0] — 2026-09-22

**Ythril 5 breaks every public name.** A tool, a route, a record type and a link field were each spelled
the way they happened to be spelled first; this release fixes all of them at once, with no aliases and no
compatibility window. Owner decision, 2026-09-15: *"break everything right away."* One upgrade, one edit
to your client, and the vocabulary stops being a thing you look up.

**A peer below 5.0.0 is refused at the handshake with a `426`** — `MIN_PEER_VERSION` derives from our own
major — so a network upgrades together or not at all. Upgrade every instance in a network before you
restart any of them.

### What breaks, and what to do about it

| what changed | what to do |
|---|---|
| A peer below 5.0.0 is refused at the handshake (`426`) | Upgrade every instance in the network together |
| The knowledge type `memory` is now `fact`, everywhere | Send `fact`; `memory` is refused, not translated |
| Every MCP tool is renamed verb-first, and three fold into others — 45 tools, not 48 | Re-read `tools/list`; a retired name is an error, not an alias |
| Every tool is `POST /api/<tool-name>`, and ten `GET` routes are gone: `GET /api/brain/spaces/:spaceId/{facts,entities,edges,chrono,files}`, `GET /api/brain/spaces/:spaceId/{facts,entities,edges,chrono}/:id` and `GET /api/brain/spaces/:spaceId/entities/by-ids`. **Match on METHOD and path**: `PATCH`/`DELETE` on the `:id` paths, `PATCH .../files`, `GET .../entities/:id/cascade-preview` and `GET .../files/extract` all still exist | Read a collection with `POST /api/filter` |
| An MCP client that stayed connected across the upgrade still holds the 4.x tool list | Reconnect it. The list is fetched at connect, so a live session sees every call fail rather than the rename |
| The search family drops the space from its path | `POST /api/brain/recall`, with `space` in the BODY |
| The six link ARRAY fields are gone | Send `linkEntities` / `linkFacts` / `linkChronos` — the same ids. The refusal names the field |
| A record no longer returns its links | Walk them: `traverse`, or a `filter` over the `links` collection |
| `completeLinkage` cannot be turned off, by anyone | Nothing. A space whose conversion FAILED is named in the startup log and refuses link reads until it is converted |
| Three recall parameters renamed or removed (`includeFreshWrites`, `includeContent`, `charsPerToken`) | Delete the first and third; `includeContent` is `includeFileContent` |
| Emptying a space is `POST /api/delete_space_data` | Re-point the call |
| Space administrator is a rung you GRANT | Grant it; four admin rungs no longer imply it |
| `recall`'s REST response has the tool's result shape | One handler for both doors — see the recall entry |

**The link change is the largest one and it is under `Removed` → *The 4.x link arrays*.** Read that
section before upgrading an instance that other people write to: the conversion runs itself on the first
5.0 boot, and the only thing an operator can be asked to do is re-run it for a space whose walk failed.

### Documentation changed in this release

**44 of the 52 documentation files changed, and not one of them kept its byte size.** A refresh that skips
a file whose size did not move therefore sees every change in this release — `--force` is not needed for
5.0.0. The eight that did NOT change are the four decision records (`docs/decisions.md` and
`docs/decisions/01`–`03`), `docs/integration-guide/10-mfa-and-conflicts.md`,
`docs/integration-guide/15-about-and-embedding.md`, `docs/network-types.md` and `docs/ui-primitives.md`.

Two guides are NEW: `docs/integration-guide/04g-links-api.md` (links as their own collection) and
`docs/integration-guide/04h-graph-augmented-recall.md`.

### Added

#### The benchmark corpus and its extraction pipeline

- **The seven gaps the extraction round found in the rules it was run under, and the uneven-treatment figure halves
  again** (`B-19`). 5,882 turns → 2,236 claims, 462 entities, 290 chrono entries, 470 edges. **Chrono entries per
  1,000 turns now spread 2.4x across the ten, against 4.6x and 6.6x in the two rounds before** — the number this
  work is judged by, because a corpus whose timeline is decided by the grammar somebody happened to use has a
  timeline that means nothing.

  **The lever was one clause.** An undated *"it just happened"* now takes the session date, while *"last
  week I got married"* does not: an offset makes the session date KNOWN to be wrong. Also: `active` is no
  longer a status an extraction may write, `knows.kind` gains `partner` beside `ex_partner`, *"this
  weekend"* said on a Saturday or Sunday is the weekend in progress, and `upcoming` being rare is recorded
  as a limit of the format.

  **One rule bought nothing and is reported anyway.** Lexical knowledge now counts as knowing a duration —
  camping entails a night, a 5K does not — and the span count did not move: 6 before, 6 after. What it
  bought is that a file no longer depends on which reading its author picked.

- **An extraction round survives the session that started it** (`B-19`). Parts are written to `benchmarks/.cache/`
  as they are finished, rather than to a session scratch directory that is wiped between sessions — exactly when the
  parts are needed. `bench.mjs status` answers *"where did the last round get to"*: `done` means extracted under the
  prompt in the tree, so a file from an earlier prompt reads `RE-DO`.

  **Measured twice.** Ten extractors launched together exhausted the session window in twenty minutes and
  finished none. With checkpoints, a later limit killed three mid-flight and cost one conversation.

  **A resume refuses a directory whose parts name a different prompt**, because merging last week's parts
  with today's produces one conversation under two sets of rules wearing a single fingerprint.

- **An extraction records how it was produced, and the whole corpus is regenerated under one prompt** (`B-15`,
  `B-18`, and the chrono vocabulary). 5,882 turns → 2,275 claims, 474 entities, 199 chrono entries, 489 edges, every
  one stamped by the run that made it.

  **`producedBy`, split so neither half can be forgotten.** Which prompt produced a file is a fact about
  the working tree, so `bench.mjs merge` stamps its sha256. Whether a retrieval score was visible is an
  attestation only the extractor can make, so it travels in the first part, and a missing flag is refused
  rather than read as `true`. `stats` warns when a corpus came from more than one prompt.

  **It found a real defect on first use:** the 3.5x figure published earlier the same day was measured
  across eight files from one prompt and two from another. It is withdrawn.

  **The chrono vocabulary is now one type.** The five conversation chrono types become `event` alone with
  `status` required. `deadline` had collected one record across 5,882 turns and `prediction` none;
  `milestone` was an opinion nothing filters on; `plan` duplicated a field the store already had.
  `overdue` is refused, because the read path derives it. **No product default changes** —
  `getAllowedChronoTypes` still returns the same five to a space that declares none.

  **The headline moved the wrong way and that is the result.** Spread 6.6x → 4.6x, a third narrower rather
  than the halving the withdrawn number suggested. Spans fell 42 → 6 and chrono entries 251 → 199, because
  the tightened duration rule refuses far more than it admits — which `B-19` then corrected.

- **All ten conversations re-extracted under the revised prompt, and the uneven-treatment figure halves** (`B-16`,
  `B-17`). 5,882 turns → 2,445 claims, 457 entities, 251 chrono entries, 477 edges, every turn named by a claim.

  **Two extractions had to be redone, and why was worth more than the number.** `conv-43` came back at 34
  chrono entries against 7, which alone would have closed most of the gap — and all 24 of its spans were
  week-windows over one-day events. It was following a convention rather than a rule, so the spread
  appeared to narrow because two extractors applied a different one.

  **`B-17` is the clarification that decided it.** `endsAt` is how long something lasted, never how unsure
  you are about when it happened. Bracketing a wedding to the Monday and Sunday of its week says the
  wedding took a week, and nothing downstream can tell that from a genuine week-long event. Stated with no
  size threshold, because a threshold only says how large a lie is tolerable.

  **The cost is documented rather than hidden.** Events dated only to a week stay off the timeline — eight
  of about twenty datable happenings in `conv-43`, which is why it remains the sparsest conversation at
  17.6 entries per 1,000 turns against `conv-26`'s 62.1. That is a property of two speakers who date
  everything to a week, and it turns `F-29` from a preference into a measured argument.

- **`bench.mjs stats` — the corpus states how unevenly one prompt treated it** (`B-16`).
  `benchmarks/writer/corpus-spread.mjs`, printed by a new CLI verb.

  The figure that decided the last three rows was a 6.6x range in chrono entries per 1,000 turns across ten
  conversations extracted by one prompt and one model. It was arrived at by a command typed once, and the
  next round is judged by whether it narrows — **a number nobody can recompute is a number everybody
  quotes**, so the derivation is code.

  Two headlines it refuses to print rather than render: a conversation with no chrono entries makes the
  ratio infinite, and a corpus of one has no spread at all, so `1.0` would read as perfect consistency.
  Totals are summed rather than averaged, because an average weights a 369-turn conversation like a
  689-turn one.

- **The extraction prompt's nine gaps are closed, and a two-day event can now reach the timeline** (`B-14`). Every
  one was reported independently by extractions that could not see each other — one model finding an ambiguity is a
  model having an opinion; five finding the same one is the prompt not saying something.

  **The one that was a bug rather than a judgement call.** A Ythril chrono record carries `startsAt` and
  `endsAt`; the extraction format offered only a single `date`, so a weekend was inexpressible and five
  runs each invented the same fallback — write the span into the sentence and emit no chrono entry. A
  marriage, a gastritis diagnosis, a pride parade and a career-high game are absent from their timelines
  while a photograph taken on a named Friday is present. **What reached the timeline was being decided by
  the grammar the speaker happened to use.** `endsAt` is now in the format, the prompt, the writer and
  `conversation.event`; a backwards range is refused, a same-day range is accepted as explicit, and a
  one-day event carries no `endsAt` key at all.

  **Six new prompt sections**, each answering a question ten runs had to answer for themselves: a
  conversation that contradicts itself (date the claim to its telling); a turn carrying a machine-written
  image caption (context, never a fact, because captions are frequently wrong); a recurring subject with no
  name; order within a session (position orders claims inside one, the date between); *"last Tuesday"*
  (the most recent past occurrence); and that a thin supersession count is the expected result.

  Also: `aliases` now exists on `place`, `organization` and `work`, and the format documents that an entity
  or chrono entry may carry `sourceTurns` — **the validator has always capped it at 12% of a transcript,
  and a run following the format exactly never wrote the field, so that rule had never once fired.**

- **All ten LoCoMo conversations are extracted unattended, and conv-26 was re-extracted unattended too** (`B-4`).
  5,882 turns across 272 sessions, producing 2,294 claims, 470 entities, 212 chrono entries and 527 edges, every
  file passing `bench.mjs check`.

  **Each conversation was extracted in a context that had seen none of the others, and no retrieval score
  was measured until all ten were committed.** That is the row rather than a procedural detail: a prompt
  that only works while its author watches the scoreboard is not a product capability, and the only way to
  find out is to not look. `conv-26`'s previous extraction was written by hand with the scores visible —
  legitimate development, illegitimate evidence — and the unattended replacement finds 198 claims where it
  found 129.

  **What the run measured about the prompt.** One prompt and one model produce a 6.6x spread in how much of
  a conversation reaches the timeline, and supersessions ranging 0 to 8 across conversations of comparable
  length. The prompt says two models disagreeing a lot is a finding about the prompt; one model disagreeing
  with itself by 6.6x meets that test without a second model.

  **The prompt is deliberately unchanged.** Editing it between conversation six and seven would produce a
  corpus extracted by two prompts, and every per-conversation difference afterwards would be
  unattributable.

- **An extraction is now checked against the conversation it NAMES, not only against itself** (`B-4`).
  `benchmarks/writer/extraction-matches-conversation.mjs`, called by `bench.mjs check`.

  The validator reads the extraction alone and the merge refuses a run with a part missing. Between them
  they catch everything except records from a **different conversation**: a spliced file is internally
  perfect, and turn coverage reads 100% because the foreign part brought its own `sessions` block. The
  graph is consistent and it is about somebody else.

  It is not hypothetical. The ten extractions run in ten separate contexts and the scratch directory they
  wrote into turned out to be shared; two runs had a working file overwritten mid-extraction. Nothing
  foreign reached a committed file — which is the point, because nothing would have said so.

  **A turn id is the witness**, and the check is honest about how far that goes: ids are positional, so
  swapping one whole extraction in under another's name leaves only 23 of 369 foreign. Coverage measured
  against the CORPUS is the other half, because the file's own `sessions` block is the reading a truncated
  extraction passes at 100%. The corpus is never present in CI, so the skip is loud.

- **`benchmarks/bench.mjs` — the four things an extraction takes, so the next nine do not rewrite them** (`B-4`).
  `conv-30` was extracted with four throwaway scripts — dump, merge, validate, write — each written at the keyboard
  and deleted. Nine conversations remained, each extracted in a fresh context, so without this every one starts by
  rewriting those four slightly differently.

  `status` reads which are done off the directory rather than a list. `check` reports every problem at once
  and counts the turns no claim names, since an extraction that dropped the quiet turns once covered 34.6%
  of a conversation.

  **The part a rewritten copy would drop is why it is committed:** `dump` goes through `loadConversations`.
  The pinned release is one object per instance — history, question, answer and evidence together — so
  parsing it directly is one line shorter and puts the answer key in front of the model doing the
  extraction.

- **The no-memory baseline, built so the two arms cannot differ in anything but the memory** (`B-6`). `B-2` says the
  number to publish is not the accuracy but *"the accuracy minus what the same answerer scores with the whole
  history in its context"*. Without it a figure in the eighties says nothing about whether the memory did anything,
  and it is the column every self-reported figure omits.

  **One configuration produces both arms, and there is no way to ask for one.** A subtraction measures the
  memory only if the arms differ in exactly one thing, and two arms configured separately drift in a way
  nothing reports. `MEMORY_ONLY` is the whole list of what may differ, and `armsDisagreeOn` catches a pair
  somebody else assembled.

  Two refusals, both in the flattering direction nobody checks: a baseline handed a conversation with no
  sessions answers nothing and makes the memory look better by exactly that much, and absent hits are not
  empty hits. A negative delta is a real result and is reported as one.

- **`benchmarks/harness/` exists again, with the half of a graded run that needs no model** (`B-6`, first
  increment). `#1282` deleted the previous one — 56 files, on the owner's instruction — because everything in it
  rested on the premise that a conversation is a pile of transcript chunks, under which multi-hop scored **0.0%
  across all twelve** strategies. This retrieves from the graph the writer produces instead.

  The exact request comes back beside the answer, because `topK` and the traversal depth are part of what a
  figure means. The `superseded` mark is carried through, since a grader that cannot see it scores a correct
  historical answer as a wrong current one.

  **A failed call is not an empty result.** If a broken instance reported "no results", a run against a down
  service would publish a low score rather than an error, and nothing afterwards would tell them apart.

  The answerer and the judge are **parked on two provider API keys**, which `B-2` requires from different
  hosted families so the judge is not marking its own phrasing.

- **The second-corpus work is finished, and its measurements are written down** (`B-5`, closed). Six fixes shipped
  from `longmemeval_s` and each has its own entry; what none of them carried is the arithmetic. That is now one
  entry in `benchmarks/DEVELOPMENT-LOG.md`.

  **The row's method was substituted and the log says so.** It asked for three histories to be extracted and
  read; two were read directly and the whole 500-instance release was measured instead. Four of the six
  defects are distribution facts — 211 of 500 histories out of time order, 18,565 of 25,112 sessions sharing
  a date, 253 of 500 carrying a pasted document, 896 turns flagged as evidence — invisible in any single
  extraction and undeniable across the release.

  The extraction prompt is now FROZEN, which is what `B-4` waits on.

- **The conversation-writer ships, and `B-3` closes on work that was already done** (`B-3`). The row's remaining
  scope read *"what is left to build is the writer"* — and all of it was in `benchmarks/writer/` already. What had
  never happened is the CHANGELOG line the row watches for, so a reader of the tracker would have concluded the
  writer did not exist.

  The proof arrived with `conv-30`: a committed extraction carrying no Ythril ids, replayed deterministically
  into a live space as 133 records. Anybody can rebuild the exact graph from the repository, and only
  re-deriving the extraction needs a model.

  **Three rows in a row have now turned out to be stale in their central premise** — `B-2` said a graded
  harness exists when it was deleted, this one said the writer was unbuilt when it was built. A verify clause
  catches the second kind and not the first: it can tell you a row has not closed, and cannot tell you the
  reason it gives is no longer true.

- **`conv-30` is extracted, and it is the first conversation the shipped pipeline has produced end to end** (`B-4`,
  1 of 10). 19 sessions, 369 turns, 84 claims, 12 entities, 25 chrono entries, 12 edges — and **all 369 turns are
  named by some claim's `sourceTurns`**, with none invented.

  Delivered in three parts and joined by `mergeExtractionParts`, which is the protocol's first real use
  rather than its test fixture; the merged file passed `validateExtraction` first time and wrote 133 records
  into a live space.

  **It carries a real supersession**, which is what `Q-35` and the prompt rule were built for: Jon goes
  full-time on the dance studio on 9 July and takes a temporary job on 21 July. The July claim carries
  `superseded: true`, a `supersedes` edge runs from the later claim to it, and a recall returns the earlier
  one **marked** rather than hidden.

  **No score was read.** No retrieval score may be measured until all ten extractions are committed.

- **A pasted document is treated as material rather than assertion** (`B-5`). Measured on the pinned corpora:
  LoCoMo's longest turn ever is **454 characters**; LongMemEval has **351 user turns over 5,000**, across **253 of
  500 histories**, the largest **76,560** — somebody pasting the Wikipedia article on the GDPR. Assistant turns over
  5,000: three, in the entire corpus. So a long turn is almost always somebody pasting something in, and half the
  corpus has one.

  The prompt had a rule for the ASSISTANT supplying world knowledge and none for a person pasting it, and
  `attributed` is the wrong tool twice over. So a pasted article would have become either a hundred unmarked
  claims the graph ASSERTS, or a refusal. It is now a third thing: the person did not say what is in it, they
  brought it, and the fact is that they brought it and what they wanted from it.

  **With a validator rule, because the prompt half depends on the model having read it.** No single turn may
  account for more than a share of a file's claims — a share rather than a count, because a threshold in
  records is wrong for a short conversation and meaningless for a long one.

- **LongMemEval has a loader, and it exists because the answer key is inside the histories** (`B-5`). LoCoMo keeps
  its questions beside the conversation; a LongMemEval instance is one object holding the history AND `question`,
  `answer`, `question_type` and `answer_session_ids` — and **896 turns inside the haystack carry `has_answer:
  true`**. That last one is the dangerous one: a third key on a turn otherwise holding `role` and `content`, on
  exactly the turns a score is computed from. Anything reading the release directly would have handed the extraction
  model a flag saying *this turn is the evidence*.

  A turn is BUILT from named fields rather than copied, so a field the authors add later cannot ride along, and
  an unknown key stops the run. Twelve turns of 246,930 carry no content and are dropped and REPORTED. Ids are
  minted from the PUBLISHED position, so a dropped turn leaves a gap — renumbering would make a committed
  extraction's `sourceTurns` point at the wrong remark with nothing to reveal it.

- **An extraction may arrive in parts, and an incomplete run is refused** (`B-5`). A long history reads in one pass;
  the graph of one does not always write back in one. A part declares `part: {index, of}` and covers a contiguous
  run of sessions, and `mergeExtractionParts` joins them.

  **The refusal is the point:** three parts of four concatenate into a file that is valid in every other way
  and describes three-quarters of a conversation, so the hole only ever surfaces as a question that returns
  nothing — which reads as a retrieval failure. Identity crosses the seam by every part repeating every
  entity; a key whose TYPE changed between parts is refused rather than resolved, because whichever side won,
  the edges the other part drew now run to the wrong kind of thing.

- **`longmemeval_s` is measured rather than quoted, and the number this repository had been repeating was wrong
  twice over.** The tracker called the corpus structurally different because *"a history runs to 500 sessions rather
  than 20"*. 500 is the number of INSTANCES, and the 500-sessions figure belongs to `longmemeval_m`, which is
  neither pinned nor fetched. Measured from the file: 39–66 sessions per history (p50 50), 396–616 turns (p50 492),
  462–514 KB. The pin now carries an `observed` block beside the authors' `stated` one.

- **The extraction harness can say that a later session made an earlier fact wrong** (`B-5`). The prompt had no
  sentence about supersession, so a chat log saying *"I left Acme"* produced two equally live claims. A claim may
  now carry `superseded: true`, written as a record field rather than a property — `superseded` is the product's
  vocabulary, and a second spelling of a real field in the space people read to judge the product is worse than no
  mark. It does not suppress: the retired claim keeps its vector and keeps ranking, so *"where DID she work?"* still
  has an answer.

  A claim may also carry a local `key`, and the three key spaces became one, because an edge end is a bare key
  and says nothing about which collection it is in. `supersedes` is exempt from the schema's label allowlist
  for the reason the server exempts it, and a gate compares the harness's spelling against the server's.

  **The validator's rule is the implication and not the pair.** A retirement need not have a successor —
  demanding an edge would make the model invent one. An edge saying X replaced Y with Y unmarked is refused,
  because both then come back looking equally current. Between two entities it is refused outright: that is a
  merge, and `aliases` is where a merge belongs.

#### Claims, chrono, supersession and contradictions

- **A superseded record is badged wherever a record is listed** (`Q-36`). The mark reached the API, an
  export, a sync and every assistant answer, and no view in the app. An operator resolving a contradiction
  saw the pair leave the review queue and then found both claims sitting in the Facts tab looking identical
  — which reads as the resolve having done nothing, the impression `Q-35` existed to end. It is the same
  defect one surface down: `Q-35` was *the judgement reaches the record and not retrieval*, this was *it
  reaches retrieval and not the operator*.

- **A record can be marked as no longer true, and it keeps ranking.** `superseded` is a boolean on facts,
  entities, edges and chrono entries, accepted on the create and the update, on both doors. Owner's
  decision, answering a proposal that a retired record be stored unembedded the way an attributed claim is:
  *"what if you ask 'where did ada work?' or 'list all workplaces' — A kills that."* It does, so the mark
  does not touch the vector. A superseded record still embeds, still ranks and comes back carrying
  `superseded: true`; retrieval marks rather than decides. Which record replaced it, if any did, is a
  `supersedes` edge — kept separate because *"she left and has no new job"* is a retirement with no
  successor. Filtering on it is index-served, so *"only what is still believed"* costs nothing extra.

- **Resolving a contradiction now reaches retrieval, and draws the edge for every pair kind** (`Q-35`).
  `supersededId` was written onto the review finding and nowhere else, so a reviewer could settle a
  contradiction and change nothing at all about the next `recall`: both claims came back ranked together
  with nothing to choose between them. The losing RECORD is now marked, through its own writer so the change
  replicates and is audited, and the response carries `markedRecord`. The edge was drawn for entity pairs
  only, on the ground that a fact→fact edge would be stored and never walked — true when it was written, and
  no longer, since 5.0 made the walk follow an edge to a fact, chrono entry or file. Re-measured against a
  control before the refusal was removed. The one pair that still gets no edge is a pair of EDGES, because
  an edge is not a thing an edge can point at, and which kinds can is read out of `REF_KINDS` rather than
  restated — the `note` field says so in that case and in no other.

- **An attributed claim is stored without a vector, so nothing can rank it — and everything can still reach
  it.** Owner's decision: a model's contribution must not compete for space in an answer somebody asked a
  question to get, and must not be hidden either. Suppression is the one mechanism that is neither. A record
  with no vector cannot be ranked by `recall` even deliberately, while `filter`, `graph_traverse` and
  recall's own expansion still reach it in full, because the walk follows links and never consults a vector.

### Changed

#### The benchmark corpus and its extraction pipeline

- **The extraction prompt learned three things from reading a second corpus, which is what `B-5` is for.**
  Each was visible in the output with no question involved, which is the rule that keeps this work from
  contaminating the benchmark.

  **World knowledge is only worth recording when the conversation TURNS on it.** An assistant answers at
  length — lists of options, examples, background — and the rule as written would have made a claim of each
  one, burying the handful of facts about the person under a hundred records of generic advice. The test is
  now whether the exchange did something: the user picked one, said they would use it, or came back to it.

  **An approximation stays approximate.** *"For about three weeks now"* was being resolved to an exact day,
  which is searchable and invented. The anchor date is the exact part and the offset is as exact as the
  speaker made it — and a fuzzy span gets no chrono entry, because a chrono entry is for something that
  happened ON a date and one built from a guess puts a made-up day on the timeline.

  **A day may hold more than one session**, so each gets a `key` and each claim names its session.

- **The gate that keeps the extractor blind now derives its corpora.** Its title has claimed something
  about *"the extraction step"* since it was written, while its body read LoCoMo alone — so LongMemEval
  would have been covered by nothing, and it is the corpus that needed covering most. Adding a third is now
  a row rather than an edit to the assertions. Seen red before being believed: putting `has_answer` back
  into the loader's output fails it.

#### One API, two doors: the 5.0 renames

- **A link is audited again, as the sets a caller sends.** An audit entry recorded what changed by diffing
  the record before against the record after, and a record no longer carries its connections — so a re-link
  would have left an entry saying something changed and not what, which reads as *the links were untouched*.
  The fact, chrono and file update routes now fold the before/after link sets into their snapshots, under
  the names a caller writes: `linkEntities`, `linkFacts`, `linkChronos`.

- **`update_file_meta` honours the link fields its own description promised.** Both doors accept
  `linkEntities`, `linkFacts` and `linkChronos` on a file, and the MCP tool declares them, so the schema a
  caller reads while constructing arguments is the contract the dispatcher enforces.

- **A link id is existence-checked wherever it is written.** It was checked at each door for the array
  spelling and NOWHERE for `linkEntities`, so on a strict space one spelling was refused and the other
  stored. The check moved into the writer, which is what `write-connections.ts` always claimed. `save_bulk`
  checks its edge endpoints under the same `strictLinkage` setting the single-record doors read — a space
  that turns linkage off still accepts a staged import whose targets resolve later.

- **A refused link no longer leaves the record behind.** The existence check moved into the writers, and
  they reconcile AFTER the insert — so a link id naming nothing answered `400` with the record already
  stored, which is the silent unlinked write made noisy rather than fixed. Every writer now refuses the
  whole call before it touches anything, and the refusal is a `400` rather than a `500`.

- **A write door cannot ask for a link class that does not exist.** There are six, and a pair outside them
  has no label — so `save_fact` naming `linkChronos` stored a link nothing reads. Refused now, on both
  doors, and the create tools advertise only the classes their record kind can hold.

- **The UI reads a record's links as records.** The Brain and Files tabs draw their chips from one query
  over the links collection per page, and every form and label names the field the API takes. A searched
  list shows the same links the paged list does.

- **An index the conversion never created.** A space upgraded from 4.x got its `links` collection from the
  conversion's first insert, which creates a collection and no indexes — so the spaces with the most links
  to read were the ones reading them unindexed. The boot backfill now asks for the same index set space
  creation does.

- **BREAKING — three recall parameters renamed or removed.** 5.0 breaks every public name, and these three
  were each lying in their own way.

  | before | after | why |
  |---|---|---|
  | `includeFreshWrites` | **gone — the scan always runs** | the name read as *exclude recent records*, which is not what it did and not something anybody wants. Measured: a plain recall answered `count: 0` for **three seconds** after a write, then found the record. The cost of always scanning, on a space with 220 records inside the window: 91–101 ms against 159–167 ms, and nothing at all on a quiet space. Owner: *"if checking the parameter takes >10ms remove the parameter and just always do it."* A flag whose only function is to let a caller opt into a blind spot is not a performance feature |
  | `includeContent` | `includeFileContent` | it gates one field on one record kind — a file chunk's `content` — and nothing else. Read as a general switch it looked like the way to trim a large answer; that is `projection` |
  | `charsPerToken` | **gone — the ratio is fixed at 3.5** | it did nothing unless `maxTokens` was also set, and what the override bought was the ability to make an estimate differently wrong. A caller who needs the ceiling exact states `maxChars`, which is the unit the budget is applied in |

  All three are unknown fields now, so a caller still sending one gets a `400` rather than silence.

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

- **BREAKING — every remaining MCP tool is renamed to the verb-first scheme.** 22 of them, on top of the
  search family that moved with its routes. No aliases: the old names are gone.

  | | |
  |---|---|
  | create or update a record | `save_fact`, `save_entity`, `save_edge`, `save_link`, `save_chrono`, `save_space`, `save_bulk` |
  | edit one by id | `update_fact` (was `update_memory`) |
  | delete | `delete_fact`, `delete_entity_preview` (was `entity_cascade_preview`), `delete_space_data` (was `wipe_space`) |
  | graph actions | `graph_traverse`, `graph_merge` |
  | the space | `space_stats`, `space_meta`, `space_reindex` |
  | schema, federation, embedding | `schema_update`, `network_peers`, `network_sync`, `retry_embed_record`, `retry_embed_media`, `retry_embed_file` |

  **What a caller changes: the tool name, nothing else.** No parameter, default, cap or refusal moved.
  `delete_space_data` is the one worth reading twice — it was `wipe_space`, and the new name says what it
  removes rather than what it does.

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

  **The space is a body field on all three, and you may omit it.**

  Omit it and the search runs across every space the token holds `knowledge: read` in, ranked together. A
  `traverse` keeps its path deliberately: it walks FROM an entity, and an entity lives in exactly one
  space, so there is nothing to omit.

  **What a caller changes:** move the space out of the URL and into the body as `space`, or leave it out.
  A space you cannot read is skipped, not an error; a space you NAME and cannot read is a 403.

#### `filter` is the one read path

- **Every Brain tab reads through `filter` now, which is what the nine per-collection list routes were
  waiting on.** Facts, Entities, Edges and Chrono all issue one `POST /api/brain/filter`; the service
  re-keys `results` to the key each tab already destructures, so **not one caller changed** and deleting
  those routes becomes a server-only change.

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

- **BREAKING — the fresh-write scan honours `filter` and `tags`, and it did not.** The scan adds records
  the vector index has not ingested yet, and it added them without applying the caller's predicate: a
  recall with `filter: {"type": "note"}` could return a record whose type is not `note`, at `200`. It was
  survivable while the scan was opt-in behind `includeFreshWrites`, because combining that flag with a
  filter was rare; making the scan unconditional made it the common case, which is how it was found. A
  filtered recall now excludes non-matching fresh records, as it always claimed to.

- **The filter sanitizer is its own module.** Owner: *"add the sanitizer and make it a real module."* The
  operator refusals and the ReDoS guard lived in `brain/query.ts` beside the query builder that happened to
  be their first caller, while the key-shape guard for the other filter grammar lived in `brain/filter.ts`
  — one rule, two files, each grammar protected by a different subset of it. `brain/filter-sanitizer.ts`
  answers the whole question for every door, and is where value coercion will go when it arrives.

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

#### Recall, expansion and the byte budget

- **BREAKING — a recall's expansion now brings the ATTRIBUTED claims of what it reached, unasked.** A claim
  an AI assistant originated is stored with no vector, so nothing can rank it. That is half a decision: it
  has to ARRIVE, or it is merely hidden by a different mechanism. So with `includeMemories` unsaid, a walk
  brings those claims — and no other fact.

  **A narrowing, not the whole class.** Admitting linked facts wholesale is what the flag's `false` default
  existed to prevent: *"a match is counted with its whole `_graph` subtree, so every record admitted by
  default is paid for in matches that no longer fit."* Measured on a live instance against a control space
  holding ten ordinary linked facts and one attributed claim:

  | call | bytes | graph nodes | attributed | ordinary |
  |---|---|---|---|---|
  | default | 2 894 | 1 | yes | 0 |
  | `includeMemories: false` | 2 332 | 0 | no | 0 |
  | `includeMemories: true` | 6 485 | 7 | yes | 6 |

  **`false` still means false.** An explicit refusal brings nothing, attributed included — a default that
  overrode it would make the flag stop meaning what its own description says. Absent and `false` were
  already kept apart by the parser, which is what made this expressible.

  **The standalone `graph_traverse` is unchanged**: its `includeMemories` is a real `false`, because its
  caller is explicitly exploring a graph and says what it wants.

- **BREAKING — `POST /api/brain/recall` returns the same result SHAPE as the MCP tool.** A hit is
  `{score, spaceId, type, record: {…}}` — the ranking beside the record rather than mixed into it. REST
  returned one FLAT object until now.

  ```json
  { "score": 0.86, "spaceId": "work", "type": "fact",
    "record": { "_id": "…", "fact": "…", "tags": ["…"] } }
  ```

  **What to change:** read `hit.record.<field>` where you read `hit.<field>`. `score`, `spaceId`, `type`,
  `_graph` and the per-stage scores stay where they were. Traversed neighbours under `_graph` are
  unchanged — they were already `{edge, node, paths}`.

  **`unrecognized_keys` is not on this route's 400 any more.** It came from `unknownBodyFields`, which a
  route uses when it parses its own body; the refusal now comes from the shared dispatcher, which names the
  offending key in `error` (`unexpected property 'topk'`). The other read routes are unchanged.

- **`POST /api/brain/recall` holds no implementation.** It was four hundred lines answering the same
  question as the `recall` tool, kept in step by somebody checking both every time either changed — and
  they had already drifted where nobody was looking (the byte budget, above). It hands its body to
  `callTool` now and translates the envelope back, which is what every door is supposed to be. The response
  shape is unchanged; `POST /api/recall` still returns the tool envelope.

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

#### Spaces, tokens and the rights matrix

- **A token that reaches exactly ONE space no longer has to name it.** `space` is optional on every
  writing tool when the calling token's accessible-space list has one member — `save_fact({fact: "…"})`
  lands. With two or more it stays required, and the refusal lists the spaces you can choose between.

  **The schema you are SHOWN says so**, per token: `space` is absent from `required` for a single-space
  token and present for every other. Advertising and enforcement come from one materialisation, so a
  caller cannot be told to send something they need not, or told they may omit it and then refused.

  **A READ did not move.** `recall`, `filter` and `similar` treat an omitted `space` as *every space this
  token can reach* — an answer rather than a default — and folding the two would turn a cross-space
  search into a single-space one the day a token gained a second space.

- **BREAKING — emptying a space is `POST /api/delete_space_data`, and both doors call one module.**

  ```json
  { "space": "work", "confirm": true, "types": ["facts", "chrono"] }
  ```

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

- **BREAKING — space administrator is a rung you GRANT, and four admin rungs are no longer it.**

  ```json
  { "spaceAdmin": { "floor": false, "spaces": ["work"] } }
  ```

  | | |
  |---|---|
  | `spaceAdmin` | ⟹ `admin` in all four areas of that space |
  | `admin` in all four | ⟹̸ `spaceAdmin` |

  **Two scopes, like everything else in the matrix.** `spaces` names them; `floor` reaches every space
  including ones created later. The floor form exists because a real configuration needs it: a token
  administering every space holds no per-space rows at all.

  **Nobody is stranded.** A boot migration writes the grant for every token that held all four — under the
  previous rule those tokens WERE administrators, and an upgrade is not the moment to reinterpret that. A
  floor of all-admin migrates to the floor form, never to a list of the spaces that happen to exist today.

- **`delete_space_data` asks what its REST routes ask.** It carried `admin: true` — instance admin — while
  the wipe routes need admin on the space in the path, so a space's administrator could empty it over REST
  and was refused over MCP.

- **A space's collection name is built in one place, and that place refuses an id it cannot vouch for.**

  Every per-space collection is `{spaceId}_{suffix}`, and 298 call sites built that string by hand. They now
  go through `spaceCollection(spaceId, part)`, which carries the check a template literal cannot: a space id
  must match `^[a-z0-9-]+$`, because `_` is the separator and three operations select a space's collections
  by that prefix — one of which DROPS them. An id containing `_` would make one space's collections carry
  another's prefix, so deleting `work` would take `work_archive`'s data with it.

  **Four collections turn out never to have been mapped at all** — `_file_tombstones`, `_media_jobs`,
  `_link_violations` and `_file_hashes` — alongside six more that were spelled out at every call. Nothing is
  renamed and no data moves; this is where the name comes from, not what it is.

#### Files

- **Removed: the metadata-only file delete.** `DELETE /api/brain/spaces/:spaceId/files?path=` purged a
  metadata record without touching disk. Every file has metadata and `deleteFileCascade` removes both, and
  the orphan case — a record whose bytes went missing out of band — is already handled by the file delete,
  which answers `204` when it finds one. It was a second door onto half of one act, and the half it could
  do alone left a file with no metadata.

#### Sync, peers and migrations

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

#### Documentation, gates and internal structure

- **The graph guide's `Links` section is its own page, `04g-links-api.md`.** `04b-graph-api.md` sat on the
  900-line cap, and the last three changes to it each ended in compressing a paragraph to make room —
  which is the cap doing its job and being answered the wrong way. Links is a distinct capability with its
  own conversion story, its own pre-flight and its own lifecycle, so it is the boundary.

### Removed

#### The 4.x link arrays

- **BREAKING — the six link array fields are gone, on the wire, in storage and as input.** `fact.entityIds`,
  `chrono.entityIds`/`memoryIds` and `file.entityIds`/`memoryIds`/`chronoIds` were a record's connections
  written onto the record itself. A connection is a link RECORD and nothing else now, so an ordinary edit of
  a fact can no longer drop a link somebody else made, and one indexed lookup answers *"what points at
  this?"* where six collection scans used to.

  | you sent | send instead |
  |---|---|
  | `entityIds` | `linkEntities` |
  | `memoryIds` | `linkFacts` |
  | `chronoIds` | `linkChronos` |

  **The ids do not change.** A body still carrying an old name is REFUSED, with the new name in the message,
  on both doors — the whole call, so a record never lands without the connections it asked for. `[]` and
  `null` are refused too: the call that meant *detach everything* is the one that must not be read as *said
  nothing*.

  **They are no longer READ either.** A record comes back without them, `recall`'s `includeRecordMeta` no
  longer adds them, and a `filter` predicate over one matches nothing because no document has the key. To
  find what a record is connected to, walk it — `traverse`, or `recall`'s `traverse` object, both of which
  return the records rather than ids to look up one at a time — or filter the `links` collection directly.

  **Every space converts itself on the first 5.0 start, and a space whose conversion FAILED is refused
  rather than answered.** Every link read on it returns an error naming the space; answering "no links" for
  records that have plenty is the one outcome worse than an error. The failure is in the startup log.

- **The conversion pre-flight is gone with the arrays it watched** — `GET /api/brain/spaces/:spaceId/links/`
  `convert-preflight` and the `graph_link_preflight` tool. It answered *"who still writes the old lists to
  this space"* so an operator could convert with their eyes open; there is no shape left to write, so the
  question has no subject.

- **`completeLinkage` can no longer be turned off**, by anyone, an instance administrator included. It was a
  reversible setting while a space could be read either way. With one shape left, turning it off would mean
  *"read my links from a shape that does not exist"* — a working space that stops answering.

#### `filter` is the one read path

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

  Nothing an operator does in the UI changed: the client was already reading everything else through
  `filter` and now reads these the same way.

#### Sync, peers and migrations

- **`POST /api/notify/trigger` is gone. Trigger a sync through the door that names its subject.** Deprecated
  in 4.5, removed here: `POST /api/networks/:id/sync` for a network and `POST /api/networks/peers/:peerId/sync`
  for one peer across every network it belongs to. The body goes into the path; `?wait=true` and `?timeoutMs`
  behave exactly as they did, and the answer shape is unchanged.

  **ONE BEHAVIOUR DOES CHANGE, and only a request shows it.** The removed route accepted any `networkId` and
  answered `200 {status:"triggered"}` for one that does not exist, because it fired and forgot before
  anything looked. **Both replacements validate their subject first and answer `404`.** A caller that
  fire-and-forgets a stale or mistyped id used to get a success it could not act on; it now gets a refusal
  naming the subject. Nothing else about the two doors differed.

  **It was removed rather than left working because the NAME was the defect.** A sync trigger sat on the peer
  notification channel, so the guard-coverage gate was told to look away by a router-wide exemption written for
  the notification endpoint beside it — and the route accepted any valid token, one with every area `none` and
  no spaces, until 4.4. With it gone the exemption's reason is finally true of every route on that router.

  **And the deletion moved something nothing would have reported.** `network_sync` was audited under
  `sync.trigger`, which was THIS route's operation, so removing the route would have left the tool writing a
  name no route records: an operator filtering the audit log by the REST operation would have seen no agent
  traffic, and the cross-door parity gate would have gone quiet rather than red, because an unpaired tool is
  skipped. A gate now refuses any tool whose operation no route records.

  **A tool may now name more than one REST operation**, because `network_sync` IS both routes — a full cycle or
  one named peer — and REST spells them apart only because a path has to name its subject. With a single name
  the parity gate compared the tool against half of itself and called `peerId` a parameter no route accepts.

### Fixed

#### The benchmark corpus and its extraction pipeline

- **A tracker row said the graded benchmark harness exists. It was deleted eight weeks ago** (`B-2`).
  The row opened *"it is a DECISION rather than a build: the harness exists (`benchmarks/harness/` —
  dataset, ingest, retrieve, grade, report, pins)"*, and there is no such directory: `#1282` removed 56
  files on the owner's instruction, because everything in them rested on one premise — that a
  conversation is a pile of transcript chunks — under which **multi-hop scored 0.0% across all twelve**
  strategies built on it, since those answers need two remarks from sessions weeks apart.

- **The extraction prompt opened by describing one corpus, and five sections now contradicted it**
  (`B-5`). Its first paragraph said *"a long conversation between people, recorded over many sessions
  spread across months"* — written against LoCoMo and true of it. By the time the second corpus had
  been read, the sections below covered a person and an assistant, a fortnight with six sessions in a
  day, sessions handed over out of time order, and a turn that is an entire pasted document. The
  opening paragraph is the first thing a model reads and it was telling it none of that applied.

  It now says the shape is not to be assumed and names the four that have their own section, because a
  rule written for one shape applied to another is the failure every one of those sections exists for.

- **A history's sessions are handed to extraction in TIME order, which the release is not** (`B-5`).
  Measured across the pinned corpus: **211 of 500 histories list their sessions out of chronological
  order**, 3,382 backward steps, the largest a full day. LoCoMo: **0 of 10** — so nothing in the harness had
  ever needed to think about it, and the array order was being read as time everywhere.

  That is worse than untidy. The extraction prompt's supersession rule is *"when a LATER session makes an
  earlier fact wrong"* and the parts protocol splits on *"a contiguous run of sessions"*; told to retire the
  earlier claim, a model reading position would retire the wrong one in nearly half the corpus — asserting
  the stale fact and marking the current one dead, which is the exact inverse of what supersession is for
  and appears in no count.

- **A day with more than one session no longer loses all but the last of them** (`B-5`). The writer named
  each transcript `transcripts/<date>.md` and filed each claim by `statedOn`. That is correct for a
  conversation with one session a day and silently destructive for one without — measured across both
  pinned corpora, LoCoMo has **0 of 272** sessions sharing a date and LongMemEval has **18,565 of 25,112,
  in 500 of 500 histories**. Six sessions on one day became one transcript, keeping the last, and all six
  sessions' claims were filed under whichever survived. Nothing failed: the space held most of the
  conversation, and a question about a lost session returned nothing, which reads as a retrieval result.

  A session now carries an optional `key` and a claim an optional `session`, both falling back to the date
  so none of the ten committed LoCoMo extractions changes. Two sessions resolving to one identity are
  REFUSED by the validator, before the first record is written — a key that merely defaults to the date is
  a fix a caller can forget, and forgetting it restores the overwrite exactly. The writer holds no second
  copy of that check: `writeSpace` validates first, so a copy there could not be reached, and an
  unreachable guard is a claim about safety rather than safety.

- **A product rule was justified by a benchmark corpus, in the text every ingest reads.** The assistant-turn
  rules shipped citing *"54 of the 896 evidence turns"* and *"842 of the 896"* in the extraction prompt —
  and there is one ingester, so those sentences are read when somebody ingests a support history, a
  transcript or an agent's own conversation. The rules were right on product grounds and said so nowhere.

  **Tuning does not arrive as a decision, it arrives as a justification.** A rule that cites a corpus
  teaches the next reader it exists for the benchmark, and the day the corpus changes somebody deletes it.
  The rules now stand on what is true of any conversation; the measurements stay in the changelog and the
  tracker, where a number about a corpus belongs.

  A gate holds it: no product-facing instruction may name a pinned corpus, with the names derived from the
  pin files rather than listed, because a corpus is added by dropping a `pin.json` in — which is exactly
  the moment nobody edits a gate.

#### One API, two doors: the 5.0 renames

- **Another seventeen schema descriptions told a caller to use `query`, a tool 5.0 renamed `filter`** —
  *"sortable by `query`"*, *"filterable by `query` on the `files` collection"*, *"as `recall` and `query`
  report it"* — plus a dozen more naming `traverse` where they meant `graph_traverse`. All of them sit in
  the text a caller reads while constructing a call.

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

#### `filter` is the one read path

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

  **`links` refuses rather than ignoring.** It is a pair of ids, with no tags, type, description or text
  of its own, so `search` there would have matched every link in the space — and a filter that matched
  everything is indistinguishable from a filter that was ignored. Both doors answer with the same
  refusal naming the collection. Same shape as the `links` sort crash fixed earlier this release: the
  answer lives in the function that RECEIVES the collection, not at a call site.

- **`filter` takes `entityName`, `fromName` and `toName`.** They were REST-only, so an agent could not ask
  for “facts about Alice” by name — it had to filter entities, take the ids, then filter facts, and on a
  proxy space the ids differ per member. They are a JOIN rather than a predicate, which is why no Mongo
  filter a caller writes can express them. Refused on a collection they cannot mean rather than ignored.

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

- **The filter sanitiser silently turned a `Date` into `{}`.** Found by the above: it walks a filter and
  rebuilds each object key by key, and `Object.entries(new Date())` is empty — so a date value came out
  as an empty object, the comparison it was part of stopped meaning anything, and the query answered
  `200` over the wrong set.

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

#### Recall, expansion and the byte budget

- **`POST /api/recall` answered to HALF the byte budget of `POST /api/brain/recall`.** 25 000 characters
  against 50 000, same server, same capability, same transport — because the tool module picked MCP's
  default itself, which was correct while MCP was the only door it had and stopped being correct when
  `B-9` gave every tool an HTTP one. The lower default belongs to the TRANSPORT that received the call, not
  to the module that answers it: `defaultBudgetChars(transport)` is the one place that is decided.

- **The recall guide said `includeDiagnostics` hides the per-stage scores. It does not, deliberately, and
  has not for some time.**

  `lexicalScore`, `fusedScore` and `rerankScore` are returned unconditionally on both doors — the reasoning
  is in the code and it is sound: the number that DECIDED a result's position must not be the one a caller
  cannot read, and three floats are not a cost worth a flag. The flag governs `matchedText`,
  `embeddingModel` and `seq`, which is three fields rather than six.

- **The guides now say which cross-encoder to pick, because the wrong one is a regression rather than a
  no-op.** Same instance, same questions, same budget, only the model changed: no reranker 45.7% first
  answers right, `bge-reranker-base` **27.4%**, `ms-marco-MiniLM-L-6-v2` **53.8%**.

  A cross-encoder replaces the retrieval ordering, which is right when it knows better and catastrophic
  when it does not. The failing model saturated — 0.9958 for the right passage against 0.9969 for a wrong
  one — so a difference of 0.001 overturned a vector margin of 0.100, confidently, on every query. Nothing
  in the API can say a reranker is making things worse: from outside, a worse ordering looks exactly like
  an ordering. So the advice is to pick a model trained for question-to-passage relevance, and to measure
  it against no reranker on your own corpus before leaving it on.

#### Links, edges and entity merges

- **A traversal answered per NODE while its response promised per EDGE, so a self-loop and a second edge
  between one pair were silently dropped** (`Q-24`). Reported from outside against a live instance and
  reproduced through both graph-reading doors. `truncated` stayed `false` throughout — which the product
  documents as *"nothing was cut for size reasons"* — so the one signal a caller had for an incomplete
  answer was actively saying the answer was complete.

  **So the answer is the subgraph: the nodes reached, and every relationship among them.** `traverse`
  already returned a flat `edges` list and its shape is unchanged — it now holds every edge among the
  returned nodes rather than one per node, and an edge to a record that is not in `nodes` is still left out.
  **`recall(traverse: n)`'s `_graph` entries carry `edges` (plural) in place of `edge`**, whole documents as
  before, and a record that loops back on itself appears as its own neighbour. Both doors, same commit, plus
  the two schema descriptions, the recall and graph API guides, and the sentence in the graph guide that
  said the list held *"only the edges actually traversed"*.

  **The endpoint ids go, and the answer gets SMALLER rather than larger.** Every edge in one `_graph` entry
  joins the same pair — this node and the one it is nested under — so `from` and `to` were two UUIDs per
  edge restating what `node._id` and `paths[0]` already say. They are replaced by `direction`:
  `outbound`, `inbound`, or `self` for a record joined to itself. The far end is
  `paths[0][paths[0].length - 2]`. The flat `edges` list on `POST /traverse` is unaffected — it has no entry
  around it to state the ends — so this is one shape changing, not two.

- **The recorder-start stamp could be skipped by an unrelated failure five statements earlier.** The
  conversion pre-flight clamps its `since` to when this instance began recording, so an unstamped
  instance reports the full retention window over a recorder it cannot vouch for — the defect `B-13`
  was filed for, where a space of 270 chronos answered `count: 1`.

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

- **Merging two entities left every LINK RECORD pointing at the entity it had just deleted.** `merge.ts`
  relinks edges, facts, chrono entries and file metadata by rewriting their `entityIds` arrays, and had
  no reference to the `links` collection at all. On a space that has been through the link conversion —
  which every space becomes at the boot after it is created — the links therefore survived the merge
  unchanged, pointing at an id phase 5 then removed.

  **A link is RE-KEYED rather than updated.** Its `_id` is derived from both endpoints, so moving the
  `to` changes its identity — the same reason edges have a re-key path. The old id gets a tombstone, or
  the next pull from a peer still holding it would re-create the dangling link and undo the repair.

  **Deleting an entity was never exposed to this**: the delete guard reads link records and refuses with
  a `409`. A merge deletes the absorbed entity directly rather than passing that guard, which is why it
  was the one path that could do it.

- **The link conversion DELETED links that existed only as records, and its own log said it removed
  nothing.** The 5.0 migration walks each record and reconciles its links from the legacy ARRAY fields.
  A link written through `linkEntities` before that spelling was fixed exists as a link RECORD with an
  empty array beside it — so the desired set said "this record links to nothing" and the reconcile
  deleted it. **With a tombstone**, so the loss replicated to every peer and a re-run could not repair
  it.

  The operator was told the opposite in the same breath: *"It is additive: nothing is removed, the
  arrays keep being read until a space is marked."*

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

  A new gate refuses an array-link field aimed at a space a test did not create.

- **A walk did not return the node it started from, so an isolated record and a bad id looked the same.**
  `graph_traverse`'s own schema has always described *"`startId` itself at depth 0, so a walk that finds
  nothing still comes back with one node rather than empty — an empty `nodes` means the id resolved to
  nothing, which is a different answer from 'it has no neighbours'."* It never sent that node.

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

  The writer now resolves the shape through the same selector every reader uses. **Nothing about the
  request changed**, and a caller who worked around this with `entityIds` is unaffected.

- **An edge you drew to a fact, chrono entry or file was stored and reached by nothing.** An edge declares
  the kind at each end, the writer REFUSES a kind that does not match the record, and the edge is then
  validated, stored, hashed and replicated — so `supersedes` between two claims is a real edge that
  everything accepted. The walk resolved every neighbour against the entities collection alone and dropped
  whatever was not there: no flag, no `truncated`, no error. On the Graph tab such an edge was saved, listed
  on the Edges table, and never drawn.

  **No include flag governs it, and the asymmetry is deliberate.** `includeMemories` and `includeFiles` are
  opt-in because they follow IMPLICIT links — a record that happens to name this one — of which a busy node
  has thousands. An edge exists only because somebody drew it, so there are exactly as many as were meant.
  A record reached through an edge also EXPANDS, unlike one reached through a mention: an edge chains, and a
  chain of `supersedes` stopped at one hop would answer a fragment and call it the neighbourhood.

  **A walk may now start from a fact or a chrono entry**, not only an entity.

- **A declared edge end could not be REMOVED once its entity type was deleted.** Owner-reported. The
  ends picker listed one checkbox per entity type the space currently declares, so a name stored on the
  edge and no longer declared had no checkbox at all — nothing to untick, still enforced, invisible on a
  control that looked complete. It lists the union of the vocabulary and what is already picked now, and
  marks the strays, so an operator meeting a name they do not recognise can tell what it is.

- **The conversion pre-flight claimed ninety days on an instance that had been recording for thirty
  minutes.** Reported by the canary operator 2026-09-15 with a controlled measurement: the endpoint caught
  a single `entityIds` write within two seconds and named the token and the field — it works — but the
  space holds 270 chronos already carrying `entityIds`, `count` was 1, and `since` reported ninety days
  back because that is `retentionDays`.

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

- **The link conversion runs itself at boot, because the documented way to run it could not be run.**
  The canary operator, 2026-09-15: `npm run links:convert` on a deployed instance answers

  ```
  Error: Cannot find module '/app/scripts/convert-links.mjs'
  ```

  Every start now converts each space not yet marked `completeLinkage` and marks the ones whose walk
  finished cleanly. It is additive — links are created, no array is removed, a space reads correctly
  before, during and after — so an interrupted run is fixed by the next boot, and an already-marked space
  is skipped outright. Owner: *"make the script autorun at startup … remove that on 6.0"*, recorded as
  `_DEPRECATIONS.md` row 6.1.

  **A boot migration over synced data is normally forbidden, and the peer floor is what suspends it.**
  `MIN_PEER_VERSION` derives from our own major, so a 5.0 instance refuses every 4.x peer at the
  handshake and no peer can write the arrays back. `renameMemoriesToFacts` runs at boot in the same
  release on the same argument.

#### Claims, chrono, supersession and contradictions

- **A claim an AI assistant originated is marked, so the graph records that it was SAID rather than that it
  is SO.** Ingesting a chat log is not ingesting a conversation between people: an assistant's turn may
  state a fact about the world, hand back one the user just gave it, or invent one — and until now nothing
  told the extractor which, so a model's guess would land beside the user's own words and rank the same.

  Three rules, and the middle one carries most of the weight. An assistant turn is CONTEXT first, read to
  resolve the user's (*"Yes."* means nothing alone). A fact is attributed to whoever ORIGINATED it, not to
  the turn it was read in — most of what an assistant appears to state is the user's own fact echoed back.
  What is left, where the assistant really is the origin, is written with `attributed: true`.

  The mark is a declared boolean on the claim type, so a filter on it is a native index pre-filter on both
  doors rather than an exhaustive scan, and the validator refuses a file in BOTH directions — an unmarked
  assistant claim, and a person's claim wearing the mark. The second is the quiet one: it retires a real
  fact from every reader that filters, and nothing contradicts it.

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

  **And the operator page now says the status it shows is worked out rather than stored**, because that
  is the half an operator meets: a backup or an export reads what was stored, so an entry the page calls
  overdue reads as active there.

- **A derived chrono status could not be combined with a convenience.** The status rewrite ran AFTER the
  conveniences, which accumulate under `$and` — so a caller's top-level `status` was buried in one by the
  server, and the rewrite's refusal (written for a `status` the CALLER nested inside `$or`) fired on the
  server's own transformation. The error told the caller to put `status` at the top level, which is
  exactly where they had put it. The rewrite reads the caller's filter first now.

#### Schemas and the space editor

- **A suppressed record being REACHABLE had never been tested, only its being stored.** Three schema descriptions promise that
  a suppressed record cannot be ranked but is still reached — the behaviour the field was renamed for in
  August, after *"i want entries to be findable via traversal even if they are not embedded themselves"*.
  The suite proved suppression is STORED, that `false` is stored rather than dropped, and that a re-embed
  sweep skips it. That it is still REACHED was asserted nowhere: a promise living in three descriptions and
  no gate, which is the shape nobody reports, because nobody reports a capability they were told they had.

  Now an integration test, run against a live instance, with an unsuppressed control on every assertion —
  without one, *"recall did not return it"* is equally good evidence that recall returned nothing at all.

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

#### Spaces, tokens and the rights matrix

- **`space_reembed` — the embedding backfill now has a tool.** `POST /api/spaces/:id/reembed` has queued
  embeddings for records with no vector since 4.4, and had no MCP counterpart. It is also
  `POST /api/space_reembed`, takes `kinds` and `limit`, and returns the same counts the route does.

- **A route was attributed to a path nothing serves, in every gate that reads the route list.** The MCP
  OAuth consent screen is served at `/mcp-oauth/consent`; the mount graph resolved its router by bare name,
  another file's function parameter is also called `router`, and that one is mounted under `/api/files` —
  so the route was reported at `/api/files/mcp-oauth/consent`. A guard gate checking a path that does not
  exist is checking nothing, and the real path went unchecked.

  The graph now scopes a parameter alias to the file that binds it, keeps a direct mount authoritative
  everywhere (a first attempt at this dropped all five space routes), and learned the fourth mount form —
  a router BUILT by a function and mounted through the value it returns.

  It reads the shared list and the imported map now, accounts explicitly for the routes only one side can
  see, and **runs in preflight**. A check nobody runs is a claim.

- **Two more gates were asking their question of two thirds of the API.** The rights-row gate and the
  route-parameter reader each kept their own copy of the route scan — the same pattern, with the same two
  blind spots: it cannot match a route declared straight on the express app, and it walks `server/src/api`,
  which does not contain `app.ts`. Between them that hid fifteen routes, including every one of the five
  heaviest admin operations and all three MCP transport routes.

  Nothing was wrong behind them; what was wrong is that neither gate had looked. Both read the shared route
  list now, which gained the ability to hand back the source that registers each route — that window was
  the reason the second copy existed.

- **A backfill could report records as suppressed when nothing was suppressed.** `space_reembed`'s
  `skippedSuppressed` is the number that tells an operator *"the setting is still on"*, and it was
  computed as `count(vectorless) - count(vectorless AND allowed)` — two separate reads of a collection
  the embed worker is actively DRAINING. Every record the worker finishes gains a vector and leaves the
  first population, so a worker landing between the two reads shrinks the second count for a reason that
  has nothing to do with suppression, and the difference goes positive.

  Both counts now come from one `$facet` pass, so they describe the same instant and their difference is
  what the exclusion removed rather than what the worker happened to finish in between. `remaining` came
  from a third live read and now shares the same snapshot.

#### Files

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

- **Upgrading stopped quietly rewriting file records that every peer also holds.** Giving a file uploaded
  before 4.0 its position in a space's history is a one-time change to a record that replicates, and it rode
  inside the link conversion — which was an operator-run script until 5.0 taught the instance to run it at
  every startup. From then on every instance in a network stamped the same records with its own counter at
  whatever moment it happened to restart, and each overwrote the others in turn. The stamp is back on
  `npm run links:convert`, which now prints how many records it stamped per space; the boot conversion does
  links only.

  **A container deployment cannot run that script, so its pre-4.0 file descriptions stay local** until the
  record is next written — which is what they did before 5.0, and is the smaller of the two problems.

#### Sync, peers and migrations

- **The gate that refuses boot migrations over synced data can follow a call.** It read one function's own
  body, so a migration that did its writing three calls away was invisible to it — which is how the case
  above went unnoticed for eleven days. It now resolves each call through the importing module's own import
  list, keyed `path:name` rather than by bare name, and walks the real startup graph to exhaustion. Its list
  of which collections replicate is read out of `sync/replicated-families.ts` rather than kept by hand,
  which is how `links` came to be missing from it.

#### Documentation, gates and internal structure

- **An entry that breaks a caller can no longer fall off the end of an abridged GitHub Release.** Lifting
  those entries ahead of everything else was the fix after an operator read the 4.0.0 notes and missed the
  link system. It stops being enough once they no longer fit BETWEEN THEM: this release has twenty of them
  totalling some 26 000 characters, so a tighter budget dropped whole entries off the end of the lifted
  block — the same failure one level in, and with the reader's guard down, because the notes now promise
  those entries come first.

  Each of their headlines is charged to the budget before anything else is spent; what is left upgrades
  entries to their full text in order, and the notice says how many were cut to one line. Twenty headlines
  beat fifteen full entries because of what a reader can DO with them — a headline sends you to the full
  notes, and an entry that is not there cannot.

  **It never reached a reader.** At the real ceiling all twenty fit; the gate squeezing to 20 000
  characters is what found it, which is what that squeeze is for.

- **The gate holding the never-embed rename asked the wrong file, and a correct release process made it
  red.** It read `CHANGELOG.md` for both spellings of the suppression mark on the rule that an upgrader
  searching the old one must find it. Archiving the 4.x notes at this release moved both into
  `changelog/CHANGELOG-4.x.md`, so the gate reported a documentation hole where the release process had
  done exactly what it is supposed to. **Its own comment had predicted the day** — *"when this file is
  archived, the gate goes red and asks to be revisited"*.

  It reads the whole series now, derived from `changelog/` with a floor, and asserts the file holding the
  answer is linked from the current notes — because a word documented in a file nobody opens is not
  documented. That is the third time this assertion's window has decayed at a release; a window measured
  in releases always will.

- **Two feature ids were reused for different work, so grepping either one misled in both directions.**
  `#1262` shipped as `F-25` — *"find out who still writes the arrays before converting a space"* — and
  `#1265` as `F-26`, *"a passed date means what the schema says"*. Seven source files cite `F-25` and
  three cite `F-26` meaning exactly those. The tracker then reused both ids in September for new
  owner-directed asks: a skill endpoint and aggregation pipelines.

  So a reader of the skill-endpoint row who greps the code finds writer-attribution plumbing and
  concludes it is half built; a reader of `request-actor.ts` who looks up `F-25` finds a skill endpoint
  that has nothing to do with it. I made the first mistake myself while checking the queue.

  The UNSTARTED rows move — to `F-27` and `F-28` — because the shipped side is quoted in source
  comments and in merged PR titles that cannot be corrected. Both rows record why.

- **A client method called a route the server has never served.** `updateSyncSchedule` PATCHed
  `/api/networks/{id}/members/{memberId}`; that collection takes a `POST`, a `PUT` on the signing key and a
  `DELETE`, and nothing else. Nothing in the client called the method, so nobody had seen the 404 yet — it
  is deleted rather than pointed somewhere, because a method with no caller and no route is not a feature
  waiting to be wired up.

- **The gate that checks every mutating route is guarded could not see the five most destructive ones.**
  Wiping a space, importing one, exporting one, reloading the config and rotating the signing key are
  declared straight on the express app rather than on a router, and both halves of the analysis missed
  them: the pattern matched only names containing "router", and the file scan never read `app.ts` at all.
  They were not reported as unguarded — they were **absent**.

  **All five turned out to be correctly guarded and correctly audited**, so nothing was exposed; what was
  missing was the check. Proven by mutation: stripping the admin guard off `POST /api/admin/reload-config`
  left the suite green before this change and names the route after it.

- **Every path the client calls is now checked against a route the server mounts.** There is no type
  between a template string and a router, so a renamed route is a runtime 404 rather than a build error —
  and what an operator sees is an empty panel, not an error naming the call. Nothing was broken when the
  check was added; 5.0 renames almost every public name, which is why it exists now.

- **One refusal, written out by hand in three places, is built from the vocabulary instead.**
  `Invalid knowledgeType … Must be one of: entity, fact, edge, chrono` sat beside a check that reads the
  same list from the code. They agree today; the rename from `memory` to `fact` had to find all three, and
  nothing would have failed had it missed one.

  These three close the pre-5.0 audit (`Q-22`).

- **Almost every tool answered with no structured half, so `data` was `null` over HTTP and
  `structuredContent` was absent over MCP.** Thirty-three successful returns across eleven tool files put
  the whole answer in the text half and nothing beside it. A client that surfaces the structured form —
  several do — got `null` and had to parse prose to recover a result it had just asked for.

  **This is the defect the canary operator reported against `query`, answered on the tool they named.**
  Nothing swept the siblings, and the sweep is where the cost was.

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

### Internal

#### The benchmark corpus and its extraction pipeline

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

  `longmemeval_s` is now pinned at `08d8dad4be43…`, 278,025,796 bytes. `_m` and `_oracle` remain
  recorded and unpinned, which the fetcher refuses exactly as it refuses a mismatch.

- **`benchmarks/` now holds a folder per benchmark: LoCoMo, LongMemEval and MemoryArena.** LongMemEval is
  recorded and not yet fetched, MemoryArena is not released by its authors, and a dataset whose hash is
  missing is now refused rather than read as nothing to check.

- **The LoCoMo benchmark was rebuilt around the conversation schema.** Storing resolved facts instead of
  transcript lines, with provenance and cross-session synthesis, took first-result accuracy from 33.0% to
  55.3% and evidence delivery to 91.4% on the first conversation. The measurements, the dead ends and the
  ceiling that method has are in `benchmarks/DEVELOPMENT-LOG.md`.

#### `filter` is the one read path

- **The `filter` tool moved out of `search.ts` into `mcp/tools/filter.ts`.** Not a tidy-up: the size gate
  refused the two lines the `path` argument added, and the file was at its ceiling. The three tools there
  were never one responsibility — `recall` and `similar` RANK, and `filter` is the one that does not,
  which is what its own description already calls it.

  **Six gates named `server/src/mcp/tools/search.ts` as "the MCP door for `filter`" and all six went red
  at once.** Each would have been fixed by editing a literal, and six literals is six chances for the next
  move to leave one pointing at a file that no longer holds what the gate reads. They derive it now, from
  `testing/_shared/search-doors.mjs`, which also asserts that each file still declares the handler that
  makes it a door — a gate handed a file that moved concludes whatever its regex says about the wrong text.

#### Recall, expansion and the byte budget

- **A cross-door budget fixture was sized from the larger door, and only luck made it bind on the other.**

  A REST result flattens the record into the ranking envelope; an MCP result nests it under `record` with a
  narrower envelope, so the same corpus is a different number of bytes through each door and MCP’s has
  always been the smaller. The spill test budgeted at 80% of REST’s full answer and asserted that MCP
  truncates too — which held by a margin nobody had measured.

#### Documentation, gates and internal structure

- **Graph-augmented recall is its own page, and the gates that named the page it used to be on now find it
  by its heading** (`Q-26`). `docs/integration-guide/04a-recall-api.md` stood at exactly 900 lines, which is
  the cap every tracked document is held to, so the next change to it was blocked — the previous one had
  already been squeezed to net zero lines to fit. The `traverse`-on-recall section is now
  `04h-graph-augmented-recall.md`, registered in `HELP_DOCS` and the index in numbered order. Moved by
  `split-part.mjs` and checked by `verify-part.mjs`: 746 prose lines before, 747 after, nothing lost.

  **The interesting half is what a split does to the gates around it.** Two named `04a-recall-api.md` as
  "the integrator's recall page" and both went red the moment the section left it — the lucky outcome. The
  unlucky one is a gate that asserts an ABSENCE, or greps a spelling the remaining page happens to keep: it
  goes on passing about a document that no longer contains its subject, and nothing ever contradicts it. So
  the page is resolved by DERIVATION now, from headings rather than from a filename, in
  `testing/_shared/integration-guide-parts.mjs`. Headings and not whole files, because `04a` still refers to
  graph-augmented recall twice by name — a file search answers with the page the section moved out of. It
  throws on no match and on more than one, so a reworded heading cannot arrive as `undefined` and be read as
  "nothing to check here".

  **And a split silently breaks every "above" and "below" that now points at another file.** Nothing
  mechanical sees those: the link resolves, the anchor exists, the sentence is simply about a page the reader
  is not on. Two here, both rewritten to name what they mean.

- **The offline standalone tests run in parallel, and the split is one module instead of two copies.**
  Measured on 591 offline files: **191.0s serialised, 46.6s at default concurrency**, both green.
  `npm run test:standalone` goes 257s → 160s, and preflight's own offline pass — which was serialised
  too — drops by the same three and a half minutes, so the set is no longer paid for twice per cycle.

  **`--test-concurrency=1` is right where it came from and wrong here.** `testing/integration` shares
  ONE live instance: run concurrently it latches maintenance mode and reports 314 false failures. The
  offline files have no instance to share, which is what `@needs-instance` declares — and the 16 files
  that do declare it still run one at a time.

  **And the runner REFUSES a stale `server/dist`.** These files import from it; preflight builds it
  first and `test:all:core` never has, so running the suite straight after a branch switch tested
  whatever was compiled last. That cost two confused diagnoses in one evening — a fix that was already
  merged looked broken, and a build from two branches ago looked like a regression in the change under
  test. A check rather than a build, deliberately: building would hide the mistake and add a minute to
  every run, while refusing costs milliseconds and says what to do. `--allow-stale` is the escape hatch.

- **Six gates asserted a SITE rather than a rule, and every one of them went red on a change that improved
  the code.**

  All six now assert the rule: the guard list is DERIVED from the middleware that reaches `resolveAuthOrFail`
  with a floor under it, the extractor knows both route shapes, the wrapper is checked per route, and the
  reach rule is checked in the module it moved to. This is the argument for doing the whole rename at once
  rather than a name at a time — it moves every identifier together, so it finds these as a batch instead of
  one false alarm a year that somebody talks themselves past.

## Earlier releases

- [4.x](changelog/CHANGELOG-4.x.md) — 6 releases
- [3.x](changelog/CHANGELOG-3.x.md) — 6 releases
- [2.x](changelog/CHANGELOG-2.x.md) — 17 releases
- [1.x](changelog/CHANGELOG-1.x.md) — 10 releases
- [0.x](changelog/CHANGELOG-0.x.md) — 18 releases
