# Changelog

All notable changes to Ythril are documented here. This file covers the **current major series**;
earlier majors are archived under [`changelog/`](changelog/) and linked at the bottom.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- **Errors:** **BREAKING:** a write concern the deployment can never meet (more acknowledgements than members, an
  undefined named concern, `w` above `1` on a standalone) answers `500` with `retryable: false`, was `503`. Branch on `retryable`.
- **Errors:** That `500` also carries the server's `code` and `codeName`, on REST, `POST /api/<tool>` and MCP alike. On a
  replica set the write may have applied, so read the record before repeating it; a sync receiver stops the page on it.
- **Errors:** **BREAKING:** a connection-pool checkout timeout or a closed pool answers a retryable `503` with
  `Retry-After`, was `500`, on REST, `POST /api/<tool>` and MCP. Checkouts time out only where `waitQueueTimeoutMS` is in `MONGO_URI`.
- **Errors:** **BREAKING:** a store failure while renaming a space, creating one or adding a link answers a retryable
  `503`, was `404`, `409` or `422` in the driver's words; retry the request. A refusal that is the caller's is unchanged.
- **Errors:** A file-system failure in a space rename's directory move is answered by its code (`ENOENT`, `EACCES`) and
  no longer carries the server's absolute data path.
- **Errors:** **BREAKING:** a write the store cannot finish in time answers a retryable `503` with `Retry-After`, on REST
  record routes, `POST /api/<tool>`, MCP and every sync push route; REST and sync push answered `500` for it.
- **Database:** New `YTHRIL_WRITE_TIMEOUT_MS` (default 30 s, per database operation of a write) and `YTHRIL_HOLD_DEADLINE_MS`
  (default 45 s, per hold); both refuse `0`. A `timeoutMS` in `MONGO_URI` does not apply to these operations.
- **Database:** **BREAKING:** options in `MONGO_URI` win; `connectTimeoutMS` and `serverSelectionTimeoutMS` default to 10 s,
  `heartbeatFrequencyMS` to 5 s. A `serverSelectionTimeoutMS` your string carried was overridden before and is honoured now.
- **Database:** An operation in flight when the database stops answering now ends with the retryable `503` instead of
  waiting out the driver's defaults. `0` means no bound; a `loadBalanced` string has only the selection bound.
- **Database:** Boot writes one INFO line, `MongoDB client options: …`, naming the timeouts in use and which came from the
  string (never the string). The setup and data pages' connection test honours timeouts the string names. A changed string takes a restart.
- **Database:** The first connection retries more kinds of "not up yet": a node not primary or not serving reads, an
  exhausted or closed pool, a closed client, driver-labelled retryable errors. Bad credentials and a malformed string fail at once.
- **Database:** A search service (`mongot`) that starts after the app is now picked up by a background retry (5 s backing
  off to 5 min) and its indexes built; a waiting space stays `building` and `GET /api/spaces` adds `indexWaiting` and `indexWaitingSince`.
- **Database:** `indexStatus: "failed"` now means only a build that really failed or timed out, so an alert keyed on
  `failed` for a late service stops firing. `INDEX_READY_TIMEOUT_MS` starts when the indexes are confirmed, not at boot.
- **Database:** Admin pipeline status says search is down, since when and how often it was checked; one warn line an hour
  and one info line when back. `GET /ready` shares one probe across concurrent requests.
- **Database:** A collection's vector index (on `files`, also the face gallery) now exists only while it holds a record:
  built on its first, dropped a minute after its last is deleted. `SEARCH_INDEX_DROP_DELAY_MS` (default `60000`) sets that delay.
- **Database:** On upgrade, boot drops the indexes of empty collections and keeps populated ones. An empty collection
  answers search empty with no `degraded` reason; `GET /api/admin/pipeline-status` marks it `empty: true` and leaves it out of `live`.
- **Files:** **BREAKING:** a second delete of an already-flagged file record, or a delete naming a derived record (a document
  chunk, a face), answers `404` on `DELETE /api/files/:spaceId`, `POST /api/delete_file` and `delete_file`; no tombstone, `file.deleted` webhook or `seq` move.
- **Files:** An interrupted first delete still completes on retry, so a `404` on the retry of a timed-out delete can mean the first one completed.
- **Server:** **BREAKING:** `POST /api/admin/reload-config` answers `500` naming spaces that failed to initialise, or `503`
  with `Retry-After` when the database was down, where it answered success; the next reload retries them.
- **Server:** `space.reload_added` is written after initialisation, with its real status. A refused manual reload moves
  `ythril_config_reload_failed_total` and holds `ythril_config_reload_pending`; any reload that succeeds clears the gauge.
- **Server:** **BREAKING:** `npm run links:convert` exits non-zero when a space could not be converted (`<id>: FAILED
  (<reason>) | not converted, not marked | file seqs NOT stamped` on stderr); the other spaces are still converted.
- **Server:** The boot summary *"Link conversion FAILED for N space(s)…"* names hung, not-reached and skipped spaces with
  a reason, and the embed boot line says *"in N of M spaces"* when a space was not reached.
- **Server:** **BREAKING:** a background job's failure is logged as `<job> failed for space '<id>' (<part>): <reason> — retried
  <when>`, or `<job> stopped: the store is not answering …` / `… <n> spaces timed out in a row …`; update log matchers.
- **Server:** Failure lines are said once per step, space and part in a window. Gone: *"Candidate prune"*, *"Tombstone
  prune"*, *"File tombstone prune"*, *"drop-link-arrays: … failed"*, *"convert links …"*, *"kept for the next cycle"*, the duplicate and contradiction scans' per-space lines.
- **Server:** A failed heartbeat beat is logged at warn, once per job, where it was debug.
- **Server:** New `ythril_housekeeping_space_failures_total{step,kind}` (`failure`, `timeout`, `store_down`, `stalled`),
  `ythril_housekeeping_records_failed_total{step}`, `ythril_interval_tick_skipped_total{job}` and gauge `ythril_housekeeping_quarantined_spaces`, all `0` from start.
- **Server:** Alert on `ythril_housekeeping_quarantined_spaces` staying above `0`: that space's housekeeping is not running.
  Per-space gauges now read each space on its own, so one failing space keeps its last value and is named in one log line.
- **Housekeeping:** A repeating job whose previous run is still going skips its next tick, counted in
  `ythril_interval_tick_skipped_total{job}`. An error escaping a tick logs `<job> failed:` and the job keeps its schedule.
- **Housekeeping:** The webhook retry poll delivers due retries four at a time, so one slow receiver no longer holds back every other receiver's retries.
- **Records:** **BREAKING:** one entity merge relinks at most 2500 records (edges, links and face labels together); a larger
  one answers `422` `code: "merge_too_large"` with `relinks` and `bound`, writing nothing. Merge route, `POST /api/duplicates/:id/merge`, `graph_merge`.
- **Records:** Automerge leaves a pair over the bound open with one warning. The `merge_too_large` message names both
  entities by name (id in brackets), counts edges, links and face labels separately, and says how many to delete.
- **Records:** **BREAKING:** a merge a `strict` space refuses answers `400` on every door, was `500` on the REST merge and
  duplicate routes; it is decided before anything is written, so it spends no sequence numbers.
- **Records:** `graph_merge`'s description states the real statuses: an unresolved conflict plan is `422` on
  `POST /api/graph_merge`, while the REST merge route answers the plan `409`.
- **Records:** A merge relinks a hub's edges, links and face labels in one transaction of a few bulk writes, so a hub of
  thousands of edges merges in seconds.
- **Records:** An entity delete with `cascadeToken` removes a hub's edges 500 at a time, each chunk one transaction with
  its tombstones; one `edge.deleted` webhook per removed edge, sent after its chunk commits.
- **Records:** A bulk write reads a batch once and writes one block per kind, a handful of database commands instead of
  several per item; items still see the earlier items of the same call as written.
- **Records:** **BREAKING:** a bulk fact or chrono item carrying the `id` of an existing record counts in `updated`, not
  `inserted`, which now means new records only; the `bulk.write` webhook fires for a batch that only converged.
- **Records:** An item depending on one that was not written names that refusal; a `$ref` key used twice refuses the batch
  before anything is written. A per-item reason never carries the database's own text.
- **Records:** A converge that loses a race to another write is decided again against the record as it now is; losing twice is
  a `409` on a create door and an item error in a batch. `save_bulk` documents and declares the `id` of fact and chrono items.
- **Sync:** **BREAKING:** `POST /api/sync/tombstones` takes at most 5000 per request (more is `400`; this instance sends 500)
  and answers `{ applied, refused }`: a malformed tombstone is refused alone, not the whole page as before.
- **Sync:** A tombstone of a type the receiver does not know still answers `400`, so the sender re-sends after the
  receiver upgrades. A tombstone page costs a handful of database commands, not four per tombstone, on both doors.
- **Sync:** **BREAKING:** `batch-upsert` caps fork fan-out: a fact has at most 10 forks, counting those one request creates;
  an eleventh is counted in `forkDepthRefused` and `rejected`. An older receiver accepts it, so mixed versions can hold different forks.
- **Sync:** **BREAKING:** a pushed fact over 50 000 characters is refused on the sync door as on every write door, so a
  peer on an older release pushing one is refused.
- **Sync:** **BREAKING:** a record arriving by push, pull or import without an expiry here takes this space's retention
  window (type schema over space) from its own creation time, so an older one is due at once and the sweep deletes it.
- **Sync:** The retention sweep removes up to 500 records per collection each 5-minute cycle, so a large backlog takes several
  cycles; its deletions pass to peers. An expiry this instance already holds is kept when a peer updates the record.
- **Sync:** Every arriving record (peer push, pulled page, admin import) is stored in a handful of database commands per
  page, not four per document, file metadata included.
- **Sync:** A fork's id is derived from the parent's id, seq and text, so a push re-sent after a lost response upserts the
  fork it made instead of forking again.
- **Sync:** Documents past the 500-per-family cap are counted in `rejected` (the sender used to count them delivered). A
  record the receiver's store refuses is counted in `rejected` and named in its log, never failing the page.
- **Sync:** A link arriving under another id for endpoints already linked is `skipped`, never a `500`.
- **Sync:** A space's Merkle root is not re-read when nothing changed, so `GET /api/sync/merkle` and `merkle: true` sync
  cycles are far cheaper; the file manifest is still walked. `computedAt` is when the root was computed, not necessarily now.
- **Embedding:** The bundled model now runs in a supervised child process, so embedding no longer blocks the server
  (`/health` stays fast during bulk imports); a native fault in it no longer takes the server down.
- **Embedding:** The child exits after ten idle minutes, so the next embed pays a 1-2 s model load. `mem_limit` or a pod
  memory limit now counts both processes, which also compete for the container's cores.
- **Embedding:** The child gets a minimal environment (platform basics, model cache directory, the three offline flags),
  never the Mongo URI, master key or an API token, and sizes its threads to the container's CPU quota.
- **Embedding:** A lost process is replaced with a growing delay (1 s doubling to 1 min); requests during it fail at once.
  A record that keeps killing it is left `failed` after three losses, the crash named in its job's `lastError`.
- **Embedding:** A model that cannot be loaded stays failed until the model or an offline flag changes or the server
  restarts; jobs end `failed` after their attempts with the same error text.
- **Embedding:** New `ythril_embed_wait_seconds`, `ythril_embed_process_restarts_total{reason}` and
  `ythril_embed_process_state`; `ythril_embedding_duration_seconds` now carries the inference process's own timing for the local model.
- **Embedding:** The bundled stage of `GET /api/admin/pipeline-status` gains an `inference` object (`phase`, model, consecutive
  losses, backoff, `loadFailure`), read live; a sticky load failure sets the stage `state` to `down` with the reason as `detail`.
- **Embedding:** A recall query is embedded ahead of queued documents. `embedConcurrency` keeps its defaults (2 bundled, 8
  external) but now bounds queue pressure on one process. A slow embed is no longer re-claimed by the stall sweep.
- **Embedding:** `POST /api/brain/spaces/:id/reindex` and `space_reindex` record a run and return; every record is queued as
  a rebuild job even if its text is unchanged, and the run survives a restart and resumes if the embedding configuration changed.
- **Embedding:** `GET .../reindex-status` and `space_meta` carry `reindexRun: { running, remaining, failed }`; poll until
  `running` is `false`. `needsReindex` stays `true` and recall refuses until every record is rebuilt. The REST ack still carries `reindexed: 0, errors: 0`.
- **Embedding:** **BREAKING:** `ythril_reindex_in_progress` is the number of spaces with a run going, was 0 or 1; change an
  alert `== 1` to `> 0`. A second reindex of a space with a run going answers `409`; other spaces start.
- **Embedding:** The embed queue has lanes: local writes first, then peer arrivals and `reembed`, then reindex, each lower
  lane keeping at least one claim in eight, so a large reindex no longer holds the write someone waits to search for.
- **Embedding:** A rebuild that cannot reach the embedder leaves the record as it was and retries; a run without progress for
  ten minutes says so once in the log. A reindex now also rebuilds document passages and media captions and transcripts.
- **Media:** A media worker slot refills the moment it frees instead of waiting for its whole claimed batch, and a raised
  `workerConcurrency` takes effect within one poll interval.
- **Search:** **BREAKING:** REST `POST /api/brain/similar` answers in the `similar` tool's shape: hits are
  `{score, spaceId, type, record}`, `source` is `{type, id, summary}`; read `hit.record.<field>` and `source.id`. `topK` above 100 is now `400`.
- **Search:** Every answer the size budget cuts carries `budgetBoundBy` (`maxChars`, `maxTokens`, `maxBytes`, or two), on
  both doors, for recall, similar, record lists, query pages, traversals and spill reads; absent when not cut or a walk ran out.
- **Search:** `filter`'s `limit` stays uncapped: a single-space read stops at twice the answer budget and answers
  `truncated` with `nextSkip`.
- **Search:** `recall` and `similar` with `traverse > 0` walk up to 16 result rows together, far fewer database queries
  per page, with identical answers.
- **Tokens:** **BREAKING:** `recall` or `similar` without `space` (or `similar` with `crossSpace: true`) now search only
  spaces where the token holds the tool's area; a token with only `files: read` no longer has that space's records ranked. REST and MCP.
- **REST:** **BREAKING:** `POST /api/brain/spaces/:spaceId/traverse` refuses with `400` what it clamped: `maxDepth` outside 1-10,
  `limit` outside 1-1000, a non-number, a `direction` other than `outbound`/`inbound`/`both`, a non-string in `edgeLabels` or a blank `startId`.
- **REST:** **BREAKING:** a bulk write with over 500 items in one array answers `400` naming the array and writes nothing,
  was `207` with the surplus dropped; `network_sync_history` `limit` outside 1-100 and an embed-queue `limit` over 200 are `400`.
- **REST:** **BREAKING:** request quantities are bounded alike on REST and MCP, past it `400`: `tags` 100, `linkEntities`/
  `linkFacts`/`linkChronos` 1 000, inline `edges` 500, `deleteFields` 100, `edgeLabels` 100, space-create `folders` 100.
- **REST:** **BREAKING:** also `400` past these: space-id lists (network `spaces`, `proxyFor`, webhook `spaces`, reorder `ids`) 1 000,
  fixed-set arrays (`types`, `kinds`, webhook `events`) beyond the set, bulk-resolve `ids` 2 000, notify `data` 8 KiB.
- **REST:** **BREAKING:** an `ingest` conversation over 1 000 sessions or 20 000 turns, and an upload whose JSON `tags` is not an array, answer `400`.
- **REST:** **BREAKING:** a fifth concurrent `ingest` run answers `429`; each live-event stream kind admits 200 connections
  (then `503` with `Retry-After`) and drops a reader 256 KiB behind.
- **REST:** **BREAKING:** `POST /api/<tool>` carries the answer once: `data` holds it and `text` is one fixed sentence
  saying so (still the answer when a tool has no structured result). Parse `data`, not `text`.
- **MCP:** `list_embed_jobs` takes `skip`, reads and sums a proxy space's members, and on both doors returns `transientFailures`.
- **MCP:** Tool calls no longer build a validator per call: one is cached per token reach (64 kept), counted in
  `ythril_tool_validator_cache_total{result="hit|miss|evict"}`; a steady `evict` rate means more distinct reaches than it holds.
- **MCP:** **BREAKING:** `content` and `structuredContent` each stay but are held to half the stated budget, so a page
  holds about half its old rows; follow `nextSkip`. `budgetChars` still reports the budget as stated.
- **MCP:** **BREAKING:** `read_file` is budgeted and paged: whole paragraphs from `markdownSkip` within `maxChars`/`maxBytes`/
  `maxTokens`, with `truncated` and `markdownNextSkip`; `GET …/files/extract` takes the same parameters for its Markdown window.
- **MCP:** `recall`, `similar`, `filter` and `read_spill` take their size parameters from one schema: MCP now accepts any
  `maxBytes` and raises a `maxChars` under 1000 to 1000, as REST always did.
- **Schemas:** A schema-library type reads as `{ "$ref": "library:<name>", ...definition }` by default on `GET
  /api/spaces/:id/meta` and `space_meta`, which takes `resolve` as REST does; `resolve=false` returns the stored `{ $ref }` alone.
- **Schemas:** **BREAKING:** a type-schema write sending a changed definition beside a `$ref` answers `400` naming the field,
  was stored inline; change the library entry or drop `$ref`. An unchanged one is accepted, and `GET /meta` now shows new keys beside each `$ref`.
- **Spaces:** `GET /api/spaces/:id/meta` and `space_meta` keep `stats` and `actualSchema` per space until the next write
  to its records, so a read with nothing written since is near-instant; fields are unchanged.
- **UI:** **Settings → Preferences** has a **Date and time** card: **Automatic** (default), **ISO 8601** or **Day.month.year,
  24-hour**, in **local time** or **UTC**, kept in this browser beside the language; every date in the UI follows it.
- **UI:** Dates follow the interface language (the German UI no longer shows US English, relative times switch too); hovering
  any date shows its ISO 8601 UTC value. The token table's date columns use the two-line cell; stored values are unchanged.
- **UI:** Settings → Spaces shows a space waiting for search as "Waiting for search service", counted apart from "Indexing"; the
  index poll asks every 3 s during a build, every 30 s while only waiting, and pauses on a hidden tab.
- **UI:** The Query tab's size advice names the field by its label and gives none after a walk ran out. The Graph view
  reads every page of `graph_traverse` and draws the whole neighbourhood, still saying so when the walk stopped at its `limit`.
- **Docs:** The hosting guide names `YTHRIL_MONGO_MEM_LIMIT` (default `4g`) as the knob for spaces of tens of thousands of
  records. The byte field's tooltip and the Brain guide now say `maxBytes` has no default or floor, and `recall`'s `budget` cut is in characters.
- **Import/Export:** The admin export streams every replicated family, links included, and omits only what this instance
  derives (vector, its model, `matchedText`).
- **Import/Export:** **BREAKING:** the admin import refuses a document whose `seq` is not a non-negative integer below the
  ingest ceiling (absent only for older file metadata) and lists each in `refused`; check `refused` after an import.
- **Import/Export:** The import keeps retention stamps as dates and a file's sync base, drops file chunks, face records and
  byte-describing file keys, stores the highest seq of a repeated id, and names records restored over a local deletion in `restoredOverTombstone`.

### Fixed

- **Errors:** **BREAKING:** A store failure now answers `503` with `Retry-After`, `retryable: true`, the store's `code`
  and `codeName` and one retry sentence on every door, REST writes included. Retry on `503`.
- **Errors:** **BREAKING:** About forty REST routes (entity create, `/api/conflicts`, `/api/contradictions`,
  `/api/duplicates`, webhooks, networks, sync reads) answer a store failure `503`, was `500`.
- **Errors:** **BREAKING:** `POST /api/brain/recall`, `/similar`, `/spaces/:spaceId/traverse` and `POST /api/<tool>`
  now send `Retry-After` on their store-failure `503`.
- **Errors:** **BREAKING:** An edge or link write whose reference lookup hit a store failure, `space_rename` and a space
  create answer `503` (were `400`, `Error (500)`, `500`). A missing reference named like `mongot` stays `400`.
- **Errors:** **BREAKING:** A failure that is not the store's answers `500` with the body
  `{"error":"Internal server error"}`, was `Internal error` on most routes.
- **Errors:** An error that only names `maxTimeMS` (the store refusing a misplaced bound) is no longer read as a missed
  deadline: no retryable `503` on a write, no "search ran out of time" on recall.
- **Database:** A write answered `503` "timed out, retry" can no longer land afterwards: the bound
  (`YTHRIL_WRITE_TIMEOUT_MS`) is the server's own `maxTimeMS`, and a blocked write may answer up to 500 ms late.
- **Database:** An unconfirmed backstop ending of a write is logged as an error. The `MONGO_URI` user must be able to
  list and end its own operations, or every backstop logs unconfirmed.
- **Database:** A `timeoutMS` in `MONGO_URI` no longer shortens a bounded write; the server warns once at boot when
  `MONGO_URI` has a `socketTimeoutMS` below `YTHRIL_WRITE_TIMEOUT_MS` (leave it unset or above).
- **Database:** Pushed and pulled pages and store-side bulks (entity-merge relinks, directory move, file tombstones)
  write in chunks of at most 99 999 operations and 16 MiB; a duplicate key then a timeout answers `503`, not `400`.
- **Database:** `POST /api/admin/data/config/test` answers an unreachable host `200` with `{ "ok": false, "error": … }`,
  as the integration guide now says (it said `500` and a `latencyMs` the route never returned).
- **Sync:** **BREAKING:** Five sync POSTs (file tombstones, members, votes, change notes, both pairing steps) answer a
  store failure `503`, was `500`; a sender holds its watermark and re-sends on either.
- **Sync:** **BREAKING:** A pulled page is now validated and decided as a push is: a held tombstone is not overridden,
  an equal-seq divergent fact forks, wrong-typed or undeclared fields and a non-string `parentFileId` are refused.
- **Sync:** A chrono `type` outside the space's vocabulary is still stored on pull (a push answers `unknownType`);
  strict-linkage violations are now recorded for every landed edge and link on every door.
- **Sync:** The stray file-metadata drain checks each record against the same schema: one with a wrong-typed key or any
  `parentFileId` is discarded and counted as refused; one lacking `tags`, `author` or `seq` is still filled.
- **Sync:** Two peers pushing different text for one fact at one seq keep both texts (a fork), and the fork keeps the
  divergent copy's `createdAt` and `updatedAt`, so retention sees its real age and the space hash agrees.
- **Sync:** A file-metadata arrival no longer overwrites a newer copy written between the accept read and the merge.
- **Sync:** Strict-linkage violations are no longer recorded for a target later in the same transfer, nor twice for one
  dangling end: references are checked once a pull or push is whole, one `link_violation.created` each.
- **Sync:** **BREAKING:** A sender now pushes its families targets first (facts, entities, chrono, file metadata, edges,
  links). An older sender can still trigger same-interval violations, an older receiver records none: upgrade both ends.
- **Sync:** A push no longer waits for the link check before answering (a stalled store held it past the sender's 60 s),
  and a pull that failed part-way still checks what landed.
- **Sync:** `GET /api/sync/file-tombstones` and the sync push serve a file tombstone only once its file is gone or
  moved, so a failed delete or move no longer has peers delete this instance's copy.
- **Sync:** File tombstones are published per path and once per path, retries included: a conversion sidecar still here,
  a file a failed directory delete kept, or a re-upload made before a retry is no longer deleted on peers.
- **Files:** **BREAKING:** A store failure during a file delete or move answers `503` on REST and MCP, was `200`/`204`
  or `404`, and retrying the same request completes it (a directory delete needs `confirm: true`).
- **Files:** **BREAKING:** A path with neither bytes nor metadata, a move whose source is missing and a path through a
  regular file (`a.txt/x`) answer `404` on REST and MCP (MCP `move_file`/`delete_file` answered `400`, REST `500`).
- **Files:** A file whose bytes are gone but whose metadata remains is completed by REST delete, MCP `delete_file` and
  the TTL sweep; `delete_file` no longer claims a missing path "succeeds quietly".
- **Files:** A retried move completes only a move it began: moving an orphan `a.txt` onto an unrelated `b.txt` answers
  `404` and leaves `b.txt` untouched.
- **Search:** Records that match a `recall` query equally well now come back in a stable order (ties break by id), so
  paging with `skip` / `nextSkip` shows every match once. MCP `recall` and `POST /api/brain/recall` alike.
- **Search:** `recall`, `similar` and the write-time duplicate check straight after a space's first write no longer
  answer `503` while its vector index initialises; they find the new record.
- **Records:** A small entity merges into a hub of any size (one edge into a survivor with ~80 000 failed as a store
  error); a too-large merge's refusal says *more than* the bound and `relinks` is a lower bound.
- **Embedding:** A record or file this instance suppresses (own flag, type or space) no longer receives or keeps a
  vector from a peer's update or a peer's file bytes; a suppressed file's derived passages lose theirs.
- **Embedding:** Suppression turned on by a network (meta pull, space addition, leaving, precedence) or a saved type
  schema now removes vectors already stored, files included; `matchedText` is kept. It also runs at every start.
- **Embedding:** An embed job no longer writes a vector over a record that changed while it embedded. A failed embed
  revive at start is retried by the worker's next stall tick.
- **Import/Export:** An admin import never keeps the retention stamps or `syncBase` of the copy it replaces (a record
  restored to "never expires" no longer expires on the old date); a restored file drops the old `embedding` vector.
- **Housekeeping:** An error or hang in one space no longer stops a background job for the others: sweeps, queue claims,
  drains, prunes, scanners and reindex resume skip the space, report it and carry on.
- **Housekeeping:** `YTHRIL_HOUSEKEEPING_OP_TIMEOUT_MS` (new, default 240 s, min 1 s, max 1 h, read at start) ends every
  database operation of those jobs; a queue claim or stall reset has its own 10 s. A write the bound ends does not land.
- **Housekeeping:** A pass ends early when the database does not answer or 3 spaces in a row time out; a timed-out
  space is passed over 60 s, doubling to 300 s (`ythril_housekeeping_quarantined_spaces`), retried at once on new work.
- **Housekeeping:** A record the retention sweep cannot delete is skipped for the cycle and retried next, reported once
  in the log and `ythril_housekeeping_records_failed_total`; pacing is unchanged (500 deletes per collection per 5 min).
- **Housekeeping:** A reindex run the server could not resume at start is retried every few seconds; a run whose sweeper
  died is taken over once its lease expires. `ythril_reindex_in_progress` keeps its last value if a space is unreadable.
- **Housekeeping:** A duplicate or contradiction scan, scheduled or manual, reports a seed or candidate lookup failure
  and moves past a record that keeps failing; the legacy spill sweep reports an unreadable directory.
- **Housekeeping:** **BREAKING:** `POST /api/duplicates/scan` and `POST /api/contradictions/scan` answer `200` with
  `failedSpaces` (`[{ spaceId, reason }]`) and `scannedSpaces` when one space fails, was `500`; a dead store is `503`.
- **Spaces:** One space that cannot be initialised no longer stops start-up or a reload for the others: it is logged
  once (`space init failed for space '<id>': … — retried next reload`) and retried on every reload.
- **Spaces:** A space a reload initialises or retries now has its vector index readiness confirmed, so `GET /api/spaces`
  shows `building`, then `ready` or `failed`; a reload no longer waits for the index builds.
- **Server:** A background job or scheduled task no longer logs under the request id of the request that armed it (a
  first-run instance showed the `/setup` request's id on the TTL sweep).
- **Server:** Shutdown now stops the retention sweep, the candidate and tombstone prunes, the contradiction scanner,
  audit change retention and stale chunk cleanup before the drain.
- **Backup:** A scheduled backup that outlasts its cron period is skipped, not overlapped; its failure line reads
  `Scheduled backup failed: …`, was `Scheduled backup error: …`.
- **Media:** The media worker no longer reads an unreadable source as deleted and removes what the job wrote.
- **Sync:** **BREAKING:** The Merkle root no longer hashes `spaceId` or instance-local files, so equal data matches
  (also under a `spaceMap` alias). Mixed-version `merkle: true` networks log `MERKLE_DIVERGENCE` until all upgrade.
- **Sync:** A stalled write can no longer stop a space's replication: it ends within the write bound. New gauge
  `ythril_seq_horizon_oldest_hold_seconds`, and a `seq horizon held <age>s space=… seq=… holder=… ended=…` warning.
- **Sync:** A peer no longer misses a record for good when two writes overlap: every seq-paged route, the push loop and
  the duplicate and contradiction scanners stop below any write that has not finished.
- **Sync:** A peer with more than 1000 deletions of one kind now passes on all of them, by pull and push; a transfer
  that cannot finish holds the watermark and logs space, peer and seq. A peer on 5.6.x pulls at most 1000 per kind.
- **Sync:** **BREAKING:** `POST /api/sync/tombstones` and the pull now refuse (and log) a tombstone whose seq is inside
  the protocol's ceiling reserve; it can no longer drag the seq counter or move the pull cursor past real deletions.
- **Sync:** A page holding the same id twice stores the highest seq (equal seqs keep the first), on pull and import,
  and a stale tombstone is deleted only once the record superseding it has landed.
- **Sync:** Pulled records and entities pushed via `POST /api/sync/entities` are now queued for embedding. Records
  pulled earlier lack a vector: run `POST /api/spaces/:id/reembed` once per synced space (Settings → Spaces).
- **Sync:** A landed record is always queued for embedding, even when the seq counter cannot move after it. A counter
  left behind answers a push `500`, holds a pull's position, and sets `counterBehind: true` on an import (re-run it).
- **Sync:** Every push door moves the seq counter past every seq it received before answering, so a local write never
  takes a seq below a record a peer holds, and a fork gets a seq above the arrival that caused it.
- **Sync:** A peer's edit no longer erases this instance's vector and retention stamps; the vector is kept only while
  this instance still embeds the record (not for an arrival it suppresses).
- **Sync:** A record pushed under a `spaceMap` alias is stored under the local space id, as a pulled one always was; it
  kept the sender's id and every list missed it.
- **Sync:** A duplicate link in a push is `skipped` (it answered `500`, so the sender re-sent for ever), and a refused
  document gets one warning per page naming ids and reason instead of `(unknown)`.
- **Sync:** A database fault writing a pulled page no longer counts as `PEER UNREACHABLE`: it holds that family's
  position, logs a record-write failure naming space and family, and refetches next cycle.
- **Sync:** A driver argument error drops a peer's document only when it is that document's own (counted in
  `rejected`; a single route answers `400`); one from the write bound or every document of a page fails the page.
- **Sync:** Peer-supplied values that reach a log line on push, pull or import (document ids, peer labels) are written
  with control characters escaped (`\r`, `\n`, `\u001b`), so a peer can no longer forge a log line.
- **Sync:** The tombstone of an edge a merge drops as a duplicate, or of a link a write re-keys or unlinks, carries the
  deleted record's seq (`originalSeq`), so a peer that never held it is not sent the deletion.
- **Networks:** A network joined before 5.6.0's join default gets its sync schedule (every 15 minutes, or the inviter's)
  at the next start, named in the log. Clearing a schedule stores manual as `""`, so manual set on purpose stays.
- **Networks:** A closed or democratic network now connects every member to a newcomer; roster entries others propose
  wait for **Accept** (`POST /api/networks/:id/introductions/:instanceId/accept`, MCP `network_introduction_accept`).
- **Networks:** A club is now a mesh: members pair directly via `POST /api/sync/networks/:id/pair` and `/pair/confirm`;
  `GET /api/networks/:id` and MCP `network_get` answer `introductions`.
- **Files:** A file a publisher pushes is recorded as an arrival, so later description and tag edits are no longer
  skipped; arriving bytes revive a soft-deleted path and get this instance's file retention window.
- **Files:** File metadata a 4.0-5.6.1 pull left in `<space>_filemeta` is now recovered, never over a row's own
  description or tags, waiting up to 30 days for a missing file; audit entry `file.stray_filemeta.drain`.
- **Files:** Moving a file or folder leaves nothing at its old path, even mid-processing, and carries chunks, the
  `_converted/` and `_extracted/` sidecars and links. REST `PATCH /api/files/:spaceId` and MCP `move_file` run one move.
- **Files:** A file's extract returns its converted Markdown whole or in whole paragraphs that page to the end with
  **Show more** (it was cut mid-sentence at 256K characters), and its image list says when it is cut.
- **Search:** **BREAKING:** A `recall` over several spaces, a proxy or no space now ranks by relevance across the merged
  pool, so spaces interleave; result order and `fusedScore` / `vectorRank` values change. One-space recall is unchanged.
- **Search:** A reranker that fails, times out or uses over half its time limit is set aside for 30 s, doubling to 5
  min: searches skip it at once and still report `degraded: ["rerank_unavailable"]`, instead of waiting 20 s each.
- **Search:** Text rank is now per record type, so a fact no longer outranks an entity for being longer. Fused results
  carry `vectorRank` and `lexicalRank` beside `fusedScore`, a rank score (about 0.016-0.033), on both doors.
- **Search:** `filter`'s `total` counts what a `fromName`, `toName` or `entityName` join matches, not the whole
  collection, on REST and MCP alike.
- **Records:** A refused entity cascade removes nothing, and an edge a cascade removes is never gone without its
  tombstone (each chunk's delete and tombstones commit together), so peers cannot bring it back.
- **Records:** A merge whose reply was lost after its commit landed is answered as merged and still queues its edges and
  sends its webhooks; a slow first model load no longer fails it with `503`.
- **Records:** `graph_traverse` and `POST /api/brain/spaces/:id/traverse` answer whole nodes in hop order with
  `skip`/`nextSkip` and `remainderDump`; a walk that hit `limit` says `limitReached`.
- **Records:** A bulk edge whose end is a `$ref` to a fact or chrono entry now stores the kind of the record the key
  names (it was stored as an entity end when the item gave no kind).
- **Records:** A chrono entry rewritten through its `id` now re-embeds its new content, and an edge created with a
  property its label's schema defaults now stores that default.
- **Embedding:** A record retired from meaning-ranked search no longer gets a vector when rewritten without restating
  the flag (create endpoints with `waitForEmbedding` or `checkDuplicates`, batches, merge survivors).
- **Embedding:** A reindex embeds the same text as the original write and rebuilds passage and caption vectors;
  `reembed` no longer gives a vectorless passage, face crop or converted copy a vector of its path.
- **Schemas:** `POST /api/notify` accepts `meta_change_pending`, so a schema-change round reaches peers (was `400`).
  `GET /api/schema-library` answers `usageCounts`; the dry-run reports checked-of-total per collection and pages.
- **Spaces:** Deleting a space no longer loses a race with the media worker (`ENOTEMPTY`), and one unfinished delete no
  longer makes every later rename and delete answer `500 "… is still pending"`: the next one finishes it first.
- **Spaces:** **BREAKING:** A proxy space no longer gets collections at boot, and a hand-edited `"proxyFor": []` is
  removed on load (warning), so that space is a real one: it starts being embedded and scanned.
- **Spaces:** A new space no longer stays "building" until restart when a `config.json` read fails with `ENODATA`
  (Docker Desktop bind mount); a read spoiled by a concurrent writer is retried.
- **Tokens:** A completed network handshake revokes the peer tokens it replaces, on both sides and for club pairings,
  and start-up drops unused leftovers; a peer no longer accumulates one `peer:` token per join.
- **Housekeeping:** The duplicate and contradiction review lists page instead of stopping at 500, and the Review tab
  reads every page. An automerge a space refuses is reported once per pair, and its survivor is the older record.
- **MCP:** **BREAKING:** `save_bulk` now refuses a retired or unknown key (such as `{"memories": […]}`) with the same
  `400` message as REST, naming `facts`; it answered success and wrote nothing.
- **MCP:** `delete_entity`'s description now names its cascade (`cascadeToken`, from `delete_entity_preview`).
- **REST:** **BREAKING:** Every list that stopped at a number now says so and pages whole rows to the end, on REST and
  MCP alike: `count`, `total`, `limit`, `skip`, `truncated`, `nextSkip`; a non-numeric `limit` or `skip` is refused.
- **Server:** An unknown tool name answers `404` without becoming a `ythril_tool_calls_total` label, and the notify
  event store holds at most 1 MiB (oldest out first); the notify event list pages and says when it is cut.
- **Server:** The server's own audit entries (sweeps, alias heals, creator grants) carry a request id of their own.
- **Database:** A transaction under the sequence hold can read more than 101 rows, and a merge of a large entity no
  longer prints `MaxListenersExceededWarning`.
- **Errors:** A write the store could not finish in time answers `503 retryable` on the create and converge doors too,
  while nothing of the request has landed.
- **UI:** The client never shows an answer older than the last one asked for (graph depth slider, record tabs, selected
  record card); opening a record sends one request per linked kind.
- **UI:** The Query tab's structured mode is called Filter, as in `POST /api/filter` (was Advanced Query); walk headings
  show counts, not `({count})`; the search folds to one line on results, shows its duration, and expands all at once.
- **UI:** German and Polish labels say the action ("Ergebnisse löschen", "Wyczyść wyniki", "Zresetuj", "Zamknij") and a
  space is "Space" / "przestrzeń", not "Leerzeichen" / "spacja". Resolving entities by id asks for every id.
- **UI:** The Graph tab says why it is slow after three seconds (search indexes building, records awaiting embedding),
  and after thirty seconds ends in the error state with those reasons and Retry.

### Security

- **Errors:** **BREAKING:** Every door answers a store failure with one fixed `503` message, `retryable: true`,
  `Retry-After` and the store's `code` / `codeName`, no longer the driver's text naming internal hosts and ports.
- **Errors:** `POST /api/networks/:id/sync?wait=true` and `POST /api/networks/peers/:peerId/sync?wait=true` answer a
  cycle's store failure with that `503`, was `500 { error }` with the exception's own text.
- **Errors:** **BREAKING:** An unrecognised driver error answers `500` ("An internal database fault stopped this
  operation"), was `400` carrying its message; the database's own refusals (bad query, validation) still answer `400`.
- **Errors:** A paused store, a cleared connection pool or a failed bulk write now answers `503`, was `400` with the
  store's address; write-concern failures are `503` too, refused documents (duplicate key) stay `400`.
- **Errors:** The driver's message is logged once per request as a `Store-side failure answered 503` warning naming
  the route, or `tool <name>` from MCP.
- **Server:** Every log line is one line and each value in it is cut (4096 characters, 100 per list) and escaped, so a
  peer's member label, round id or megabyte `seq` can no longer forge a line or flood the log.
- **Server:** Values quoted back in answers are bounded and escaped: a reference refusal names its first five
  references (256 characters each, then `…(+N more)`), `Unknown field(s)` / `unrecognized_keys` the first 10 keys.
- **Server:** Sync refusal reasons, the fork-limit `400`, an admin import's `refused`, `schemaViolations` and
  `restoredOverTombstone`, and the `500` bodies of admin wipe, export, config reload and signing-key are bounded alike.
- **Server:** Stored error text (an embed job's `lastError`, a reindex run's `error`, a media job's and a webhook
  delivery's `error`) and a chat model server's error text (cut at 200 characters) are bounded and escaped.
- **Server:** Redacting a log line no longer takes time growing with the square of a value, which let a peer's megabyte
  `_id` hold the event loop for minutes; 5.6.x releases are affected too.
- **Sync:** A peer's tombstone applies only to the space its sync admitted, not the one it names: a peer could delete
  its authored records in any other space, and under a `spaceMap` an honest peer's deletions never reached the space.
- **Sync:** A tombstone is authorised before it is stored: one whose issuer is not the delivering peer, or for a record
  another instance wrote, is refused and no longer blocks that record's real author.
- **Sync:** A record pushed with its author's own peer token is no longer refused as `tombstoned` by a tombstone
  another instance planted; pushed by anyone else, a record with a deleted id is still refused.
- **Sync:** Unchanged: author-less (older) records stay deletable by an admitted peer's tombstone, and tombstones
  already planted in a space the peer was not admitted to stay in place.
- **Records:** **BREAKING:** `POST /api/duplicates/:id/merge` needs `dataQuality` **write** and `knowledge` **write**
  in the pair's space, so a token with read there can no longer delete an entity; a refused candidate answers `404`.

### Internal

- **CI:** `Build & Test` is now a gate job over parallel client, standalone and stack jobs, every run writes per-test
  timing records to `test-results/`, and a CI job has a 90-minute ceiling; release lines keep their single-job workflow.
- **Help:** Links in the in-app Help no longer open dead tabs: between parts of a split guide, to headings such as
  `#links`, and to repository files; they keep their place in the URL and move focus to the target.
- **Docs:** New `docs/testing-guide.md`, also offered in the in-app Help, describes the CI job graph and caches.
- **MCP:** The `network_join_remote` schema now states the 8 192-character limit on `inviteCode` that the route
  already enforced.

## [5.6.5] — 2026-10-06

**A patch release for two defects in 5.6.4: take it if you page through `recall` answers or read the guides in Help.**

### Fixed

- **Search:** Records that match a `recall` query equally well now come back in a stable order, so paging with `skip` /
  `nextSkip` shows every match exactly once. MCP `recall` and `POST /api/brain/recall` alike.
- **Help:** A link from one page of a guide to another now opens that page in Help, scrolls to it and focuses it; the
  page stays in the address, so reload and Back return to it. Links to a section titled with `&` or `Links` now land.

## [5.6.4] — 2026-10-05

**A patch release of fixes for defects in 5.6.3; take it first for the security fixes: duplicate merge rights, store
errors no longer exposing the database, and bounded one-line log values.**

| Changes on upgrade | Action |
|---|---|
| Every start, once the server listens, sweeps the stored vectors of everything a space suppresses (records, files, chunks), one space at a time | Nothing; expect one scan per record kind per space at start, and `Suppression sweep: removed N <kind> vector(s) in <space>` where it removed any |
| Every log line is one line: a stack's breaks are written as `\n`, an `Error` renders as message and frames without the `Error:` prefix, a string extra argument is no longer JSON-quoted | Match a stack on its single line |
| A log value is cut at 4096 characters and a list at 100 items, and the line says how much (`…(+N chars)`, `…(+N more)`) | Nothing; a value that fits is written as before |
| A store failure's `error` text is a fixed sentence of ours at the status it already had; the driver's message is in the server log under the failed operation | Read `retryable`, not the prose; grep the log for the operation named in the failure line |
| An error of ours that only names the store (a path such as `notes/mongot-setup.md`) answers `400`, not a retryable `503`; a driver failure under a space rename or create answers `500`, not `404` or `409` | Nothing; a pooled connection cleared under a command keeps `400` |
| A refusal listing references or unknown keys cuts each at 256 characters and ends `…(+N more)`, where it read `(+N more)` | A client matching the old tail text must match the new one |
| A search right after a space's first write answers `200` and empty, not `503` | Retry logic that waited on that `503` can stop |
| A duplicate merge needs `knowledge` write and `dataQuality` write in the space where the pair lives; a pair elsewhere answers `404` | Grant both rights to the token that merges |
| A fork written from now on keeps the divergent copy's `createdAt` and `updatedAt`; a stored fork keeps its stamps | Nothing; on a mixed-version network the same fork differs in its timestamps until every member runs 5.6.4 |
| A link violation 5.6.3 stored under a random id gets one derived twin on the next delivery of its document, announcing `link_violation.created` once | Nothing; dismiss the older row if you do not want both |
| A duplicate pair stored with seq `0` (or none) is not re-fired by the first scan; its real seqs are stored as each pair is next scanned | Nothing; a merge that keeps the older record keeps it whichever end the scan started from |
| The reindex INFO line gains a field: `Reindex completed for space '<id>': reindexed=N, suppressed=N, superseded=N, errors=N` | A script reading that line reads the new field |

### Changed

- **Sync:** A failed cycle's sync-history entry reads the error's message, without the error class.
- **MCP:** `delete_entity` says that `cascadeToken` turns the call into a cascade and that a refused cascade removes
  nothing; `delete_entity_preview` says the same of a refusal.

### Fixed

- **Sync:** Two pushes of different text for one fact at one seq no longer lose one text while the sender is told it was
  delivered: every push door forks the divergence (`forked`), never `inserted`.
- **Sync:** A pull that finds a copy at the same seq with different text keeps the local copy, advances past it and logs
  once per page `kept the local copy; N document(s) arrived at the same seq with different text`; it does not fork.
- **Sync:** A fork keeps the divergent copy's `createdAt` and `updatedAt` instead of the time this instance made it, so
  its retention window is right and receivers forking one divergence store the same document.
- **Sync:** An older copy of a file's metadata can no longer overwrite a newer one stored between the read and the
  write; the write carries the seq condition.
- **Sync:** An edge delete writes its tombstone before deleting the edge, so a failed tombstone write no longer leaves
  the edge gone here and back from every peer on the next pull; a failure between the two is completed by a retry.
- **Sync:** Tombstones for a duplicate edge a merge drops, a link it moves, the absorbed entity and a link a reconcile
  removes now carry `originalSeq`, so a peer that never held the record is not offered the deletion.
- **Sync:** A strict-linkage violation is recorded once, not on every delivery of its edge (`POST /api/sync/edges`):
  `link_violation.created` fires only for an inserted record, and two different dangling ends stay two.
- **Sync:** A pull refuses only a document that would corrupt the receiver (a `parentFileId` that is not a string, an id
  or seq refusal) and logs per page `stored N document(s) that do not match their schema` for the rest it stores.
- **Embedding:** An embed job writes its vector only onto the version of the record it read, so a peer's newer copy no
  longer gets the old text's vector; a job that matched nothing ends as the new outcome `superseded` (done, no retry).
- **Embedding:** Suppression now reaches files with their chunks, network schema layers and vectors stored before it
  was set; the sweep runs after every write of a space's meta and at every start, removing vector and model.
- **Embedding:** A file arrival this instance suppresses lands with no vector, model or matched text, and a peer's file
  metadata no longer leaves this instance's vector on it; a schema layer turning suppression on removes local vectors.
- **Records:** A refused entity cascade (a fact, chrono entry or file names the entity) now removes nothing and answers
  with the list it decided on; it used to delete the blocking edges and spread their tombstones to peers first.
- **Records:** The duplicate scanner reads both records at their real seq, so the survivor is the configured
  `dupeMergeSurvivor` (the older record by default) whichever end started the merge, and a refused pair is not retried.
- **Search:** A search right after a space's first write answers `200` and empty, not `503`, whatever wording the store
  uses for an index not yet initialised.
- **Search:** A search is no longer reported as out of time because the store's error names `maxTimeMS`.
- **Errors:** An error of ours that mentions the store (a path like `notes/mongot-setup.md`) answers `400`, not a
  retryable `503`; `$vectorSearch is not supported` stays `503`. A cleared pooled connection keeps `400`.

### Security

- **Tokens:** `POST /api/duplicates/:id/merge` could merge, and so delete an entity, in a space where the token only
  read `dataQuality`. It now needs `dataQuality` and `knowledge` write where the pair lives, else `404`.
- **Errors:** A store failure is answered with a fixed sentence of ours (a cleared pool connection: `The store is not
  available right now.`), not the driver's message with its host, port and collection; that goes to the server log.
- **Server:** A value a request, a peer or a backup chooses can no longer flood or forge a log line: it is cut at 4096
  characters and a list at 100 items, and line breaks and stacks are escaped so every log line is one line.
- **Server:** A refusal quoting a caller's reference, an unknown key (`unrecognized_keys` keeps every key) or a
  fork-capped `_id` cuts each at 256 characters (`…(+N more)`); a model server's error text is quoted at 200.
- **Server:** Credentials in a URL are redacted in linear time: a long run of scheme characters in a peer's id could
  stall the event loop for seconds when logged. Redaction is otherwise unchanged.

## [5.6.3] — 2026-10-03

**A patch release for sync's tombstone and file-metadata defects; take it first for the security fix that stops a peer's
tombstone deleting records in a space it was not admitted to.**

| Changes on upgrade | Action |
|---|---|
| The first boot builds one index per space on its tombstones (`type`, `seq`) | Nothing |
| A stray `<space>_filemeta` collection 5.6.2 had not dropped is recovered at most 2,000 records per space per cycle; a record whose file has not arrived waits up to 30 days | Nothing; where 5.6.2 already dropped it, nothing is left to recover |
| `POST /api/sync/tombstones` answers `{ applied, refused }` and takes at most 5000 tombstones per request (more is `400`) | Nothing for a Ythril peer (it sends 500); `applied` keeps its meaning |
| First pulls after a long absence carry up to 5000 deletions per kind per request, 200 requests per cycle | Nothing; a peer on 5.6.2 or earlier pulls at most 1000 per kind |
| A tombstone whose issuer is not the delivering peer, or whose record here another instance wrote, is refused and not stored | Nothing for an honest peer |
| A record its author pushes is no longer refused by a tombstone another instance issued for its id | Nothing; applies to pushes received by an instance on 5.6.3 |

### Changed

- **Sync:** `POST /api/sync/tombstones` checks each tombstone on its own: a malformed one, or one whose seq the counter
  cannot carry, is refused alone and the rest applies, where a malformed page was refused whole with `400`.
- **Sync:** A tombstone of a type the receiver does not know still answers `400`, so the sender re-sends it after the
  receiver upgrades. A page costs the same few database commands whatever its size, on both doors.

### Fixed

- **Sync:** A peer with more than 1000 deletions of one kind now passes on all of them: push and pull page by a
  cursor that re-reads a full page's last seq, and a transfer that cannot finish holds the watermark and logs why.
- **Sync:** A tombstone with an impossible seq no longer reaches the counter by pull: both doors refuse it alone, log it
  and do not move the counter, and a refused tombstone no longer moves the pull's cursor past real deletions.
- **Sync:** File metadata a 4.0-5.6.1 pull left in `<space>_filemeta` is now actually recovered: a row this instance
  made is filled with the keys it lacks (never over its own description or tags), others follow newer-wins.
- **Sync:** The recovery works 2,000 records per space per cycle; a record whose file is missing waits up to 30 days.
  A failing space no longer stops the others; the drop writes audit `file.stray_filemeta.drain`.
- **Sync:** A file whose metadata arrived before its bytes now takes this instance's file retention window, once; it
  never expired before. A later copy or the bytes never re-slide it, and a space with no window stores none.
- **Sync:** A stale push can no longer delete a tombstone written for the id meanwhile at a higher seq; the cleanup is
  bounded by the stored copy's seq.
- **Embedding:** A record rewritten while it was being embedded no longer keeps its old vector: a worker's late finish
  matches only the claim it holds, so it can no longer delete the new job or overwrite its backoff.
- **Import/Export:** A restore leaves a file with exactly the backup's derived rows (chunks, face records), so extra
  chunks no longer stay matched by recall; a file the backup lacks or carries without derived rows is untouched.
- **Import/Export:** A restore that stopped part-way after a failed counter move now reports the family as errors, not
  as restored; the log says re-running the import repairs it.
- **Housekeeping:** The server's own audit entries (sweeps, alias heals, creator grants) now carry a request id of
  their own.

### Security

- **Sync:** A peer's tombstone is applied to the space its sync admitted, never the space it names: a peer admitted to
  one space could delete records it authored in any other, and under a `spaceMap` every honest deletion was lost.
- **Sync:** A tombstone is authorised before it is stored: one whose issuer is not the delivering peer, or whose record
  another instance wrote, is refused, so it can no longer block that record's real author.
- **Sync:** A record its author pushes with its own peer token is no longer refused as `tombstoned` by a tombstone
  another instance planted; a deleted id pushed by an admin token or non-author peer is still refused.
- **Sync:** Unchanged: a record with no author stays deletable by an admitted peer's tombstone, and tombstones a peer
  already planted in a space it was not admitted to stay, being indistinguishable from legitimate ones.

## [5.6.2] — 2026-10-02

**A patch release of fixes for defects in 5.6.1, chiefly in sync: pulled records were never queued for embedding,
pushes could leave the counter behind, and file descriptions could miss subscribers; take it if you sync.**

| Changes on upgrade | Action |
|---|---|
| Records pulled from a peer by 5.6.1 or earlier have no vector here and stay out of meaning-ranked search | Run `POST /api/spaces/:id/reembed` (Settings → Spaces → Danger Zone → **Backfill missing embeddings**) once per synced space; pace a large one with `limit` |
| A subscriber's first pull queues every record it receives for embedding, in the queue local writes use | Nothing; embedding of your own edits lags until a large first pull has drained |
| A space export now carries the space's links | Take a fresh export: one made by 5.6.1 or earlier restores without its links |
| An import now moves this instance's counter past the records it restored | Nothing |
| A duplicate link in a push is counted as `skipped` instead of answering `500` | Nothing; a sender that re-sent that page for ever now moves on |
| A tombstone pushed with a seq too close to the protocol ceiling is refused and logged; the rest of the push applies | Nothing |
| File metadata a pull stored in a stray `<space>_filemeta` collection since 4.0 is merged into the space's files and the collection dropped | Nothing; one log line per space says how many records were merged |

### Fixed

- **Sync:** Every push door (single routes, `batch-upsert`) moves the seq counter past every seq it received before
  answering, and a pulled page as it lands, so the next local write never takes a seq below a peer's record.
- **Sync:** File metadata pulled from a peer is now merged into this instance's files like a pushed page; since 4.0 it
  went to a collection nothing reads, so descriptions and tags never reached a subscriber that pulls.
- **Sync:** Metadata pulled before 5.6.2 is recovered within five minutes of start: each space's stray
  `<space>_filemeta` is merged (never over a newer copy) and dropped, and a recovered description is re-embedded.
- **Sync:** Bytes a peer pushes are recorded as the publisher's, so they no longer freeze the subscriber's copy of the
  file's description and tags; arriving bytes revive a soft-deleted path, and a new file gets the retention window.
- **Sync:** A record pushed in a batch under a `spaceMap` alias is stored under the local space id, not the sender's.
- **Sync:** A stale tombstone is deleted only once the record that supersedes it has landed, so a failed write no
  longer loses both.
- **Sync:** A page holding one id twice stores the highest seq (the first at equal seq), on push, pull and import.
- **Sync:** A push re-sent after a lost answer finds the fork it already made (id derived from the record and the
  arrival) and answers `forked` with its id, writing nothing, even if the parent has since reached a fork cap.
- **Sync:** `POST /api/sync/tombstones` refuses a tombstone with a seq inside the protocol's ceiling reserve on its own
  and logs it, instead of accepting any number and dragging the counter towards the ceiling.
- **Sync:** A duplicate link in a push is counted `skipped` instead of answering `500`, so the sender stops re-sending.
- **Sync:** A database fault while writing a pulled page holds that family's position, logs a record-write failure
  naming the space and family and refetches next cycle, where it was reported as an unreachable peer.
- **Sync:** A document a push or pull did not store is named: one warning per page lists ids and reason, where
  duplicate-key warnings said `(unknown)`.
- **Sync:** A failure to queue a record for embedding or to move the counter is now a warning, and one no longer skips
  the other; a counter not moved past a pulled page holds that family's position, and a push answers `500`.
- **Embedding:** A record pulled from a peer, and a new entity pushed through the single `POST /api/sync/entities`, were
  never queued for embedding and stayed out of meaning-ranked search; both are now queued by this instance's rules.
- **Embedding:** A peer's pushed or pulled edit no longer erases this instance's own vector and retention stamps; the
  vector is kept only while this instance embeds the record; a suppressed arrival keeps no vector, model or matched text.
- **Import/Export:** The space export now streams every replicated family, links included, so a restore keeps its links.
- **Import/Export:** An import no longer stores the export's vector model and matched text, restores retention stamps as
  dates (the sweep ignored them as text), and moves the counter past every plausible restored seq.
- **Import/Export:** A restored record holds exactly the stamps and file sync bases its backup carried; a family whose
  counter could not be moved reports every document in `errors` though stored, so run the import again.

### Security

- **Sync:** A peer could forge a log line with a line break in a document id, file path or peer label. Every peer-sent
  value reaching a log line (sync, import, gossip, votes, members) now has `\r`, `\n` and `\u001b` escaped.

## [5.6.1] — 2026-10-01

**A patch release for defects present in 5.6.0; take it first if you sync, where two overlapping writes could leave a peer missing a record for good.**

| Changes on upgrade | Action |
|---|---|
| A recall across several spaces is ranked by one fusion over the merged results, so its order changes | Nothing; a caller that pinned an order across spaces should re-read it |
| A network joined before 5.6.0's join default gets the default sync schedule at boot | Nothing; a network set to manual stays manual |
| A peer that completes a new handshake has the older tokens it replaces revoked | Nothing; run 5.6.1 on every member so each side keeps one token |
| A space whose config was hand-edited to `"proxyFor": []` is loaded as a real space, with a warning | Nothing, unless that space was meant to be a proxy |
| `GET /api/notify` answers `400` to a `limit` or `skip` that is not a number (it fell back to the default) | Send numbers, or leave the parameter out |
| `PATCH /api/networks/:id` with `syncSchedule: ""` stores manual (`''`) instead of dropping the field | Nothing, unless you relied on `""` meaning unset |

### Fixed

- **Sync:** A peer no longer misses a record for good when two writes overlap: every seq-paged route (record families,
  `filemeta`, `tombstones`), the push loop and the duplicate and contradiction scanners stop below any unfinished write.
- **Networks:** A network joined before 5.6.0's join default syncs on its own: it gets the default schedule (every 15
  minutes, or the inviter's) at the next start, named in the log. Manual set on purpose (`""`) is never replaced.
- **Networks:** A peer keeps one token, not one per join: a completed handshake revokes the tokens it replaces on both
  sides, and unused leftovers are dropped at start. A token still in a handshake is left alone.
- **Networks:** On a closed or democratic network a member that learned a join vote by gossip no longer admits the joiner
  on its own concluding vote; only the member holding the joiner's credentials may add it.
- **Networks:** Peers accept and record the `meta_change_pending` schema-change notice on `POST /api/notify` instead of
  answering `400` to the sender.
- **Records:** A bulk edge whose end is a `$ref` to a fact or chrono entry, with no kind stated, now stores the kind of
  the record the key names, not an entity end that never existed.
- **Records:** An edge created with a property its label's schema defaults now stores that default.
- **Records:** `save_bulk` on MCP now refuses a retired or unknown key (`{"memories": […]}`) with REST's `400` and the
  same message, instead of answering success with nothing written.
- **Embedding:** A chrono entry rewritten through its `id` is re-embedded, so its vector matches its content.
- **Embedding:** A rewrite without the suppression flag keeps the stored flag, so a record retired from meaning-ranked
  search gets no vector: on every create endpoint with `waitForEmbedding` or `checkDuplicates`, batches and merges.
- **Embedding:** A reindex embeds the same text a write does (edge ends by name, passages and captions from their own
  text) and rebuilds vectors even when the text is unchanged; an embedder outage leaves a record's vector as it was.
- **Embedding:** A backfill (`reembed`) no longer gives a text-less passage, face crop or converted copy a path-based
  vector, and removes those it gave; passages of files with suppressed embeddings are not embedded.
- **Search:** A failing, timed-out or slow reranker (over half its limit) is set aside for 30 s, doubling to 5 min, so
  searches skip it at once and report `degraded: ["rerank_unavailable"]`; a background probe restores it.
- **Search:** A record's text rank in a fused `recall` is its rank among its own type, so the order changes where several
  types matched. `fusedScore` is a rank score (`1/(60 + rank by meaning) + 1/(60 + rank by text)`), never a similarity.
- **Search:** A `recall` over several spaces, a proxy or no space is fused once over the merged pool, so spaces
  interleave by relevance and every result carries a `fusedScore`. A one-space recall is unchanged.
- **Search:** `filter`'s `total` with `fromName`, `toName` or `entityName` counts what the name join matches, not the
  whole collection. REST and MCP alike.
- **Spaces:** A new space no longer stays "building" until restart when a config read hit `ENODATA` during a concurrent
  rewrite (Docker Desktop bind mounts); that read is retried.
- **Spaces:** Boot and restore no longer create collections for a proxy space (existing ones stay, empty), and a
  hand-edited `proxyFor: []` is removed on load with a warning, so that space is a real space and is embedded and scanned.
- **Spaces:** A space delete no longer fails `ENOTEMPTY` against the media worker, and an unfinished delete no longer
  makes every rename and delete answer `500 "… is still pending …"`: removal retries, and the next operation finishes it.
- **Files:** Moving a file or folder leaves nothing at the old path, even mid-conversion, and carries its chunks,
  sidecars and, for a folder, every file's links. REST `PATCH /api/files/:spaceId` and MCP `move_file` run the same move.
- **REST:** `POST /api/spaces/:id/validate-schema` reports per collection what it checked (`checked`, `complete`) and
  pages its violations instead of stopping at 500. `GET /api/notify` pages with `skip` and says when cut, not at 200.
- **REST:** Both lists answer `count`, `total`, `limit`, `skip`, `truncated` and `nextSkip`, whole rows within the byte
  budget, and refuse a non-numeric `limit` or `skip` with `400`.
- **Server:** An unknown tool name no longer becomes a `ythril_tool_calls_total` label, so a caller cannot mint a series
  per spelling. The notify event store holds at most 1 MiB, oldest out first, as well as 500 events.
- **UI:** The Graph tab says after 3 s what the space is doing (indexes building, records awaiting embedding), and after
  30 s ends in an error state with those reasons and Retry. Entities are resolved by id past 100.
- **UI:** The Query tab's walk headings show their counts (`({count})` and `{hops} hop(s)` were printed literally), and
  the latest request wins on every tab, the graph's depth slider and its record card, never an older, slower answer.
- **UI:** German and Polish labels that read the wrong sense now read correctly (Clear results, Reset, Close, Projection),
  and a space is "Space" / "przestrzeń", not "Leerzeichen" / "spacja".

## [5.6.0] — 2026-09-29

**A minor release: a filtered recall returns every record that matches, a search never writes into a space, and a token can be allowed to create spaces without being an instance admin; upgrade every member of a network.**

| Changes on upgrade | Action |
|---|---|
| Read spills older versions wrote into spaces (`_tmp/results-*.json`, `_tmp/graph-*.json`) are deleted once, with no tombstone, and it cannot be undone | Nothing; read the answer's `remainder` / `spillId` instead of a kept spill path |
| Every vector index is rebuilt once in the background (it gains `_id` as a filter field), with no gap in search | Nothing; until it finishes, a filtered recall that needs completing answers `degraded: ["filter_window"]` |
| `POST /api/spaces` and `save_space` need the `createSpaces` right instead of instance admin | Grant `createSpaces` to any non-admin token that should create spaces; instance admins are unaffected |
| Vote casts carry a second signature (`bsig`), required from a voter running 5.6.0 or later | Upgrade every member; a cast from an older member is still checked the old way |
| A network you join syncs on the inviter's schedule, or every 15 minutes | Pass `syncSchedule` on the join to choose another (`""` for manual) |
| A traversing `recall` / `similar` returns each match with its whole graph or lists it in `incompleteRows`; `graphComplete` and `pathsTruncated` are gone | Read `incompleteRows`; narrow `edgeLabels` or `traverse` to bring a match back. `graphTruncated` is true only when `incompleteCount` is |
| `recall` with `tags` and a `filter` naming `tags` applies both; the filter used to replace `tags` | Expect fewer records if you relied on the replacement |
| A spill's `download` is `/api/brain/spills/:id`; `path` on `remainder` is deprecated (removed next major) and one read of it answers one window | Read by `spillId` with `read_spill`; continue from `nextSkip` |
| Joining, renaming and adding a space can be refused with `join_mapping_collision`, `network_id_aliased`, `invalid_answer` (`400`) or `space_name_in_use` (`409`) | Handle the codes; a refused call creates and moves nothing |
| A vote round carries `networkSpaceId`, and `GET /api/networks/:id/votes` / `network_votes` name its space by `localSpaceId` | Read `localSpaceId` for the local space |
| A network's schema layer and membership origin kept under a renamed space's old name move to its current name | Nothing; rolling back, the space loses that network's schema layer until the network next sends it |
| With a master secret set, uploaded files are encrypted in the background after each start | Nothing for callers; read the Encryption at Rest guide before rolling back |

### Added

- **Search:** `recall` takes `rerank: false` on both doors, skipping the cross-encoder and returning the fused order at
  once, with nothing in `degraded`; reranking stays the default. Search bars send it; the Query tab gains a switch.
- **Search:** A filtered answer that could not be completed says `degraded: ["filter_window"]` and returns what it found.
  Treat an unknown `degraded` reason as "degraded".
- **Search:** `read_spill` and `GET /api/brain/spills/:id` read what a search could not return inline, with `id`, `skip`,
  `maxChars`, `maxBytes`, `maxTokens`, whole items, `truncated` and `nextSkip`; `remainder` carries the `spillId`.
- **Search:** Only the token that ran the search, still holding knowledge read on every space inside, reads its spill.
  Anyone else, an unknown id and an expired one get `404`; a spill evicted by newer ones answers `410`.
- **Search:** A traversing `recall` or `similar` adds `incompleteRows` (`{_id, spaceId, type, name, reason}`, at most 50;
  reasons `walk_ceiling`, `link_scan`, `paths`, `deadline`), `incompleteCount` and `truncatedBy` (`budget`, `walk_budget`, `deadline`).
- **Search:** `spillRefused` says why a spill could not be kept (`over-share`, `instance-ceiling`, `no-token`,
  `unattributed`, `empty`, `failed`); the search still answers in full. A spill never fails a search.
- **Files:** Uploaded files and the upload staging area are encrypted at rest (chunked AES-256-GCM) when
  `YTHRIL_MASTER_KEY` / `YTHRIL_MASTER_PASSPHRASE` is set; sizes and hashes stay the plaintext's; older files follow.
- **Files:** A file that cannot be decrypted, or is encrypted on an instance whose secret was removed, is refused by
  name (`500` on download, an error on `read_file`, a failed indexing job). The security report gains `atRest.files`.
- **MCP:** `space_rename` renames a space, as `PATCH /api/spaces/:id/rename` does: instance admin or space administrator,
  the same `{ space }` answer and refusals, including `409` with `code: space_name_in_use`.
- **Server:** `READ_SPILL_TOKEN_MAX_MB` (64) and `READ_SPILL_TOKEN_MAX_COUNT` (50) bound one token's spills, evicting its own
  oldest; `READ_SPILL_INSTANCE_MAX_MB` (1024) bounds the instance and refuses a new spill instead of evicting others'.
- **Server:** `ythril_recall_fresh_scan_capped_total` counts fresh-write scans whose window held more records than
  `DUPE_FRESH_SCAN_CAP`.

### Changed

- **Search:** A traversing `recall` or `similar` returns each match with its whole graph, or leaves it out of `results`
  and names it in `incompleteRows`: per-match node ceiling, link scan, unrecorded path counts and the deadline.
- **Search:** One walk budget and one deadline cover the call; running out of either ends the answer at the last whole
  match with `truncated`, `nextSkip` and `truncatedBy`. Nothing is spilled unless `remainderDump: true` is sent.
- **Search:** `graphComplete` and `pathsTruncated` are removed, and `graphTruncated` is true exactly when `incompleteCount`
  is. A caller that read `graphComplete` reads `incompleteRows` and narrows `edgeLabels` or `traverse`.
- **Search:** A `recall` with both `tags` and a `filter` naming `tags` applies both; the filter used to replace `tags`, so
  `tags: ["a"]` with `filter: {"tags": "b"}` answered records tagged `b` alone.
- **Search:** Every vector index gains `_id` as a filter field, rebuilt once on the first boot with no gap in search.
- **Search:** A spill's `download` is `/api/brain/spills/:id`, which a token with knowledge read and no files read can
  fetch; a spill lives up to one day and may be evicted earlier by its own token's newer spills.
- **Search:** `path` on `remainder`, resolved through `read_file` and `GET /api/files/:spaceId?path=`, is deprecated and
  removed at the next major. It answers one window (first page, `nextSkip` for more) for the issuing token only.
- **Tokens:** The `createSpaces` right creates a space on every door: `POST /api/spaces`, `save_space` and a network join
  share one rule and one `403` sentence, and `save_space` is listed to a token holding it. MFA still applies to REST create.
- **Tokens:** The token that creates a space, directly or by joining a network, becomes its administrator
  (`rights.spaceAdmin.spaces`) in the same write, audited as `token.creator_grant`. A creating join needs `networks: write`.
- **Networks:** A network's `spaceMap` may name several keys for one local space: the first is the network's id, later
  ones are names a rename left behind. Join and network answers list every one; renaming back to the network id removes it.
- **Networks:** Join, rename and add-space refusals carry a `code`, identical on REST and MCP: `400`
  `join_mapping_collision`, `network_id_aliased`, `invalid_answer`; `409` `space_name_in_use`. A refused call changes nothing.
- **Networks:** A vote round carries `networkSpaceId` beside `spaceId`, and `GET /api/networks/:id/votes` /
  `network_votes` name each round's space by `localSpaceId`.
- **Networks:** Accepting a pending space with `mapTo` onto a space the network already carries, which has no network id
  yet, records the alias instead of answering `409`.
- **Networks:** On upgrade, a network's schema layer and membership origin kept under a renamed space's old name move to
  its current name. Nothing is dropped; rolling back loses that layer until the network next sends it.
- **Housekeeping:** Read spills written into spaces before 5.6.0 (root `_tmp/graph-<uuid>.json`, `_tmp/results-<uuid>.json`)
  never sync again (counted `skipped` on push) and the retention sweep deletes every copy, with no tombstone or webhook.
- **Housekeeping:** One `file.legacy_spill.sweep` audit entry is written per space cleaned. The deletion cannot be undone;
  your own deeper `_tmp` folders and other root `_tmp` files are untouched.
- **Backup:** Backups and the storage quota leave read spills out, so they are not kept in backups or counted against the
  brain quota. A restore leaves current spills alone.
- **Server:** The shipped Kubernetes Deployment uses `strategy: Recreate`, so an old and a new pod never write the same
  data volume during a rollout.

### Fixed

- **Search:** A filtered `recall` returns every matching record it has room for, whatever its vector rank, on both doors.
  Filters the index cannot apply (undeclared property, `exists`, `ne`, most raw MongoDB) used to answer `count: 0`.
- **Search:** A filtered recall no longer reads as complete when the vector index is behind the collection: it answers
  `degraded: ["filter_window"]` when a matching record older than the fresh-write window is missing from the index.
- **Search:** A raw filter naming `updatedAt` or `embedding` can no longer widen or break the fresh-write duplicate scan.
- **Search:** A large `topK` is served, not a retryable `500` (recall asked for over ~666 of a type, or a `minPerType`
  above 1000). A `topK` past the per-type bound of 2000 that a type fills answers `degraded: ["candidate_cap"]`.
- **Search:** On a `euclidean` vector index, locally computed scores now match the engine's `1 / (1 + d²)`, so the
  fresh-write duplicate threshold and the lexical agreement check act on the right scale.
- **Search:** `includeRecordMeta` holds at every depth of a traversed `recall` and on `similar` (REST and MCP), dropping
  `createdAt` / `updatedAt` on the match and every graph node unless asked.
- **Embedding:** Text removed from a record stops matching searches whatever became of its embedding: every embed outcome
  writes the current text, and a failed one drops the stale vector so a retry re-embeds.
- **Media:** Face auto-labelling finds a labelled face behind closer unlabelled ones; a gallery search that cannot be
  completed makes the media job retry instead of writing the face unlabelled.
- **Sync:** A published file's description and tag edits reach a subscriber that already processed the file: a file write
  advances `seq` only when a replicated field changes, and a description is derived only where the file was authored.
- **Networks:** A joined network syncs on its own: the join adopts the inviter's `syncSchedule` (from the invite answer),
  or every 15 minutes. `POST /api/networks/join-remote`, `/join-by-key` and both MCP join tools take `syncSchedule`.
- **Networks:** A bad `syncSchedule` on a join is refused `400` before the handshake; `""` means manual. A network joined
  before 5.6.0 keeps no schedule until you set one on its card.
- **Networks:** A renamed space reaches a new member once, under the network's name: invite answers carry `networkSpaces`
  beside `spaces`. A member holding the duplicate heals once its publisher or parent runs 5.6.0 (`network.space_alias.heal`).
- **Networks:** On a club, closed or democratic network, accept a waiting duplicate with `mapTo` naming the space you
  carry, then remove the idle copy. A pre-5.6.0 joiner of an upgraded publisher still gets the duplicate until it upgrades.
- **Networks:** A network's sync schedule stops when the network is gone (left, deleted, ejected or dropped by a config
  reload) instead of logging `Scheduled sync failed … not found` at ERROR on every tick.
- **Backup:** A restore answers in time however many spaces the instance holds: vector indexes are rebuilt several
  spaces at a time, so a large instance no longer times out on a restore that had succeeded.
- **UI:** Semantic search in the Graph picker, entity pickers and the Facts, Edges and Chrono tabs shows its results
  (they rendered blank rows, `chrono` as type and `upcoming` as status); traversed neighbours show their edge label again.
- **UI:** The Query tab's "Download the whole graph" link, which could not send `Authorization`, is gone with the graph
  spill; a kept remainder downloads as one file with its expiry, and a match left out is named above the results.

### Security

- **Search:** `$regexMatch`, `$regexFind` and `$regexFindAll` in a filter pass the catastrophic-pattern guard like `$regex`
  and need a literal pattern, so `(a+)+$` can no longer pin MongoDB's CPU through `filter`, `recall` or `/query`.
- **Search:** A search never writes into a space: a `recall` or `similar` that outgrew its inline cap, or asked for
  `remainderDump`, saved a file in the seed's space that synced to every peer. Spills now live outside every space.
- **Search:** Only the token that ran a search can read what it kept. Any token with files read could list `_tmp` and read
  other callers' results; the spill route and `read_spill` now check the issuing token and knowledge read on each space.
- **Sync:** Spills no longer reach peers and the copies that did are removed: spills are instance-local, sync drops the
  old path shape in both directions, and the retention sweep deletes what is left.
- **Sync:** A file arriving by pull is written inside its own space; a manifest path climbing out of the space is no longer
  written outside it.
- **Sync:** `POST /api/sync/warm` warms only a network the calling peer belongs to, and only the spaces it carries, not
  any space id in the body.
- **Networks:** A relaying member can no longer re-aim a `space_deletion` or `space_wipe` vote round: a cast also carries
  `bsig`, signed over its type, `spaceId`, `networkSpaceId` and `wipeTypes`, and is refused without it from 5.6.0+ voters.
- **UI:** The web app sends its session token to this instance only; a protocol-relative URL (`//other.example/…`,
  `/\other.example/…`) or a host merely starting with the origin no longer receives the bearer, nor do downloads.

### Internal

- **Server:** `npm run docker:compact:install`, run once from an elevated Windows shell, registers a protected on-demand
  task so `npm run docker:compact` runs without a UAC prompt; `-Uninstall` removes it.

## [5.5.2] — 2026-09-27

**A patch for instances with a reranker or a proxy space made before 5.0: reranked recall results rank first
again.**

### Fixed

- **Search:** A reranked result now always ranks above one the reranker did not score. An unfiltered `recall` that
  gathered more than 100 candidates used to return the unscored rest on top, in vector order, with no `degraded`.
- **Search:** `recall` on a proxy or on named spaces now reranks once, with one query embedding, not once per member.
- **Spaces:** A proxy space made before 5.0 is no longer reported unconverted at every start; link reads were never
  affected. The warning says each start retries the conversion (`npm run links:convert` is not in the image).

## [5.5.1] — 2026-09-27

**A patch: a network no longer deletes a member's space, so upgrade every instance that is a member of a network.**

### Fixed

- **Networks:** A passed deletion vote now makes a networked space leave the network on every member, each keeping its
  copy and data as a local space; only the requester removes its own copy. Emptying a space by vote is unchanged.

## [5.5.0] — 2026-09-27

**Files sync between members again, a file edited on one side is no longer a conflict, and a sync can carry a
change note to the members below, and it includes everything in 5.4.2 and 5.4.3.**

| Changes on upgrade | Action |
|---|---|
| `DELETE /api/conflicts/:id` and the Dismiss button are removed; a call answers `404` | Resolve with `POST /api/conflicts/:id/resolve` (keep local, keep incoming, keep both, save to space) |
| Idle connections stay open 95 s (was Node's 5 s) | Lower a proxy's idle upstream timeout below 95 s (*Hosting → TLS Termination*) |
| `GET /api/conflicts?spaceId=` now narrows to that space and answers `403` for one the token cannot reach | Nothing |

### Added

- **Networks:** A pub/sub publisher or braintree node can attach a markdown change note to a sync: `{ note, spaces }`
  on `POST /api/networks/:id/sync`, `note`/`spaces`/`networkId` on MCP `network_sync`, **Sync with this note** on the card.
- **Networks:** Notes are queued per member and delivered in its next exchange; one that cannot travel (no member below,
  or a two-way type) is refused `409`. A network also drafts one for a schema update and for an added space.
- **Networks:** Members list notes with `GET /api/networks/:id/change-notes`, MCP `network_change_notes` or the card's
  **Change notes**; each arrival fires the new webhook event `change_note.received`.

### Removed

- **Files:** The Dismiss action on a file conflict and `DELETE /api/conflicts/:id` are gone: it left the incoming copy
  replicating under its conflict name, a keep-both without the rename. Use `POST /api/conflicts/:id/resolve`.

### Fixed

- **Files:** A file changed on one side only is no longer a conflict: each end remembers per file and peer the version
  both last held, so the edit is carried. Only edits on both sides conflict, and nothing is overwritten.
- **Files:** Conflict copies and each instance's `schemas/` snapshots no longer replicate, so a schema change stops
  raising a conflict on every member.
- **Files:** The files of a space renamed on both ends of a network sync again; every file push and pull was refused
  `403`. `GET /api/sync/manifest` now names the peer's local `spaceId`, and older peers are addressed as before.
- **Files:** A file's description and tags now replicate; both ends send and write only the fields the sync schema
  declares, so the receiver no longer takes the sender's size and hash.
- **Files:** `GET /api/conflicts?spaceId=` narrows to that space, as documented; it used to return every accessible
  space's conflicts.
- **Sync:** A push the receiver refused no longer reads as pushed: `batch-upsert` answers a `rejected` count per family
  and the sender records the cycle as **partial**, naming family and count, not `success`. Links count in totals too.
- **Networks:** A space added to a network reaches members with its schema: library references travel resolved (members
  used to refuse the whole schema), and a club, closed or democratic network carries it on the vote.
- **Networks:** The proposer of a club schema change now updates the network's layer too, so it sees its own edit.
- **Schemas:** A schema replace on a networked space now answers `appliedAsMerge`, `keptTypes` and a sentence on REST
  and MCP alike, as the round is a merge and removes no type; members get a change note naming the kept types.
- **Server:** A request sent on a pooled connection after the server was busy is no longer dropped with "other side
  closed"; idle connections now stay open 95 seconds, above common proxy defaults.
- **Server:** A space update that carries no schema no longer logs "Suppression sweep failed".
- **UI:** `?embedded=1` survives a sign-in inside a frame (kept per tab in `sessionStorage`; `?embedded=0` clears it).
- **UI:** The conflict page's action selects look editable on every theme; five other undefined theme tokens are fixed.

## [5.4.3] — 2026-09-27

**A security patch for democratic networks: a round needs a real majority of the members, so upgrade every
instance that is a member of one.**

| Changes on upgrade | Action |
|---|---|
| A democratic round passes only on more than half of all members (was half of the others) | Nothing; make sure enough members vote |

### Security

- **Networks:** A democratic network no longer passes a round on exactly half; on two members the proposer's own yes
  used to decide for both. A round needs more than half of all members.

## [5.4.2] — 2026-09-27

**A security patch for closed networks: no member's space can be deleted, wiped or changed without that member's
own vote, so upgrade every instance that is a member of a closed or braintree network.**

| Changes on upgrade | Action |
|---|---|
| A closed or braintree round passes only with every member's own yes | Nothing; make sure each member votes |

### Security

- **Networks:** A closed or braintree network no longer passes a round on a member that has not voted; on two members
  the proposer used to decide alone, and the other deleted, wiped or changed its own space.

## [5.4.1] — 2026-09-26

**Subscribing a webhook to fact events works from Settings → Webhooks again; since 5.0 the page offered event
names the server refuses.**

### Fixed

- **UI:** Settings → Webhooks offers `fact.created`, `fact.updated` and `fact.deleted`, not `memory.*` (refused
  "Invalid event type"). A subscription that failed to save can be saved again; API ones were never affected.

## [5.4.0] — 2026-09-26

**A network now asks before it adds a space (the rest waits on the network card for you to accept or dismiss), and
a pub/sub network can be joined by pasting its key.**

| Changes on upgrade | Action |
|---|---|
| Networks joined or created before 5.4.0 have no recorded joining token, so every space they announce waits for an accept | After the next sync, check each network card for **Announced, waiting for you** |
| A config reload keeps a space the file no longer lists | To remove one by editing `config.json`, list its id in a top-level `removeSpaces` |
| A space a network announces is added only if the joining token could have joined it; a same-named local space always waits | Accept or dismiss it on the network card |

### Added

- **Networks:** A pub/sub network can be joined with its published key alone: `POST /api/networks/join-by-key` (MCP
  `network_join_by_key`) and the **Join network** dialog take the publisher's URL and key; no one admits you.
- **Networks:** The publisher answers `POST /api/invite/redeem` with no admin token, for a pub/sub network it publishes
  only, rate-limited: 25 open handshakes per network, 3 per caller, 10 minutes each. Regenerating the key closes them.

### Security

- **Networks:** A network's announcement is now a proposal: a publisher or tree parent used to make every subscriber
  create a space, join a same-named local one and widen peer tokens, whatever the joining token allowed.
- **Networks:** A passed vote follows the same rule. What does not qualify waits on the card as a pending space; accept
  or dismiss it with `POST /api/networks/:id/pending-spaces` or MCP `network_pending_space`.
- **Spaces:** A config reload no longer silently drops a space that `config.json` stopped listing (its data used to be
  orphaned). It is kept and logged; list its id in `removeSpaces` to remove it.
- **Spaces:** Every space a reload adds, removes or keeps is audited (`space.reload_added`, `space.reload_removed`,
  `space.reload_kept`), whether the watcher or `POST /api/admin/reload-config` ran it.

## [5.3.1] — 2026-09-26

**An instance administrator holds every right on every space again; since 5.0 one stored with rows for only some
spaces was refused on the others.**

| Changes on upgrade | Action |
|---|---|
| Granting instance admin now also sets **Space admin** on the all-spaces floor, so it covers spaces created later | Nothing |
| At startup each instance-admin token without that floor gets it, and the log names every token changed | Nothing |

### Changed

- **Docs:** The tokens guides no longer say four admin cells make a token its space's administrator; only the
  **Space admin** grant does.

### Fixed

- **Tokens:** An instance administrator reaches every space, present and future, again; one stored with rows for a
  single space got `403` elsewhere. An OIDC identity mapped to instance admin gets the same floor.
- **Tokens:** A space administrator reaches its spaces even with no area rows, a space-admin floor can delegate the
  admin rungs it holds, and the rights glyph draws it at admin. The rights-edit audit entry records rights as stored.
- **Spaces:** Renaming a space keeps its named administrators; a token that administered it by name used to stop doing
  so.

## [5.3.0] — 2026-09-25

**The assist model can keep to a token budget, fall back when it cannot answer, and be a Claude model; nothing
changes until an operator sets one.**

### Added

- **Embedding:** The assist model gets a token budget per rolling window and a fallback for when the main endpoint is
  unreachable, rate-limited, over budget or declines. A hosted fallback is consented per use; a local one needs none.
- **Embedding:** The assist endpoint and its fallback can each speak the Claude API with a Claude Console key. The Models
  card shows which endpoint answers, the budget spent and a pause after failure.

### Changed

- **Docs:** The guides name only tools, routes and types that exist (`save_fact`, `filter`, `POST /api/filter`).
  Corrected: an unknown supplied id is ignored, an entity's `type` is required, `filter`'s default `limit` is 200.

### Fixed

- **Files:** A file or folder deleted while its text file was being processed no longer leaves chunk records behind as
  orphans in file metadata.
- **UI:** The NLP sidecar has its card on the Models tab and in the pipeline status it reads.

## [5.2.0] — 2026-09-25

**Networks become a whole feature on both doors: every network act has an MCP tool, a space's schema travels with its
records, and `ingest` turns a conversation into records.**

| Changes on upgrade | Action |
|---|---|
| A schema write on a networked space (`PUT /schema`, single-type upsert and delete, library apply) answers `202 vote_pending`, was `200`, and applies when the `meta_change` round passes | Expect `202` in scripts; re-read the schema after the vote |
| `acknowledgedHost` now covers documents only; conversations need `acknowledgedHostForConversations` | Click **Allow conversations** once on Settings → Models, or `ingest` through the assist model refuses |
| The compose install caps `ythril` and `ythril-mongo` at 4 GB each (`YTHRIL_MEM_LIMIT`, `YTHRIL_MONGO_MEM_LIMIT`) | Applied on the next `docker compose up`; raise them in `.env` for very large spaces |
| Members of a network now exchange a space's schema over sync (`GET /api/sync/meta`) and serve passed vote rounds to peers | Upgrade every member to receive schemas |
| Token rights gain a `networks` column: existing tokens and a matrix body omitting it get `none`, and a missing area now reads as `none` | Grant `networks` where a token must act on networks |

### Added

- **Networks:** MCP `network_get`, `network_create`, `network_update` and `network_leave` are the same acts as their
  REST routes: same parameters, rights, answers and refusals.
- **Networks:** MCP `network_invite`, `network_fork`, `network_join_remote`, `network_member_add` and
  `network_member_remove` are likewise the same acts as their REST routes.
- **Networks:** MCP `network_votes`, `network_vote`, `network_sync_history`, `network_member_admit` and
  `network_member_signing_key` are instance-admin like their routes.
- **Networks:** MCP `network_reparent_self`, `network_member_adopt` and `network_member_revert_parent` cover the
  braintree topology acts, instance-admin; no network act is REST-only now.
- **Networks:** Each network shows what this instance is in it (Publisher, Subscriber, Organiser, Member, Root, Node,
  Leaf) and the members and spaces it acts on; `myRole` is on `GET /api/networks`, `GET /api/networks/:id`, `network_get`.
- **Networks:** A pub/sub publisher or tree root can add a space to an existing network from the network card,
  `POST /api/networks/:id/spaces` or MCP `network_add_space` (audited `network.space.add`).
- **Networks:** Members adopt an added space on their next sync from upstream only: created if missing, merged if
  present, nothing overwritten or deleted.
- **Networks:** On club, closed and democratic networks adding a space is a `space_addition` vote (`202`): a club
  organiser's yes carries it, closed needs every member, democratic a majority with no veto.
- **Networks:** A member with a same-named local space keeps it out of the network unless it voted yes, since these
  networks sync both ways.
- **Networks:** The join dialog lists every space the invite carries; each goes under the same name, into an existing
  space or under a new name. Joining only adds: nothing local is overwritten or deleted.
- **Tokens:** The `networks` rung on every space a network carries governs a token below instance admin: `read` sees
  the network (`network_peers` too; else `404`), `write` creates one and leaves its own, `admin` changes settings.
- **Tokens:** `networks: admin` also leaves anyone's membership; space admin does not include the column, and a
  membership with no recorded establisher needs `admin` to leave.
- **Tokens:** A token administering every space an act touches may create, join, see and invite into a network
  carrying them without the column; any other space needs it and is named in the refusal.
- **Tokens:** `POST /api/networks/join-remote` needs `networks: write` on every local space the join maps to, plus
  `createSpaces` and a `write` floor for a space it creates; a refused join leaves nothing behind.
- **Sync:** On a pub/sub network or tree each instance takes a shared space's type schemas, purpose, usage notes and
  governed meta from upstream every cycle (`GET /api/sync/meta`); the merge only adds, nothing flows up.
- **Sync:** A passed space-settings vote now reaches every member, late joiners included, and each applies it as that
  network's definition beside its own.
- **Schemas:** A space in several networks keeps each network's schema as its own layer beside its own definitions;
  the network joined first wins a clash and both keep syncing records.
- **Schemas:** Each network is sent only your own definitions plus its own layer, never another network's.
- **Schemas:** The Schema tab shows each layer, every clash and which network applies, and the order can be changed:
  `GET /api/spaces/:id/schema-layers`, `PUT /api/spaces/:id/network-precedence`.
- **Schemas:** MCP `space_schema_layers` and `space_set_network_precedence` are the same acts as those two routes.
- **Schemas:** `targetNetwork` on `PATCH /api/spaces/:id` and MCP `schema_update` proposes the meta to that network
  alone, by vote there; the clash list has a **Propose** action per network.
- **Schemas:** The Schema Library ships the `conversation` group (the types the extractor writes), seeded at start
  without replacing an operator's edit; apply it with **Apply group to space**.
- **Search:** MCP `graph_traverse` and `POST /spaces/:spaceId/traverse` take `projection` (the `query` / `recall`
  grammar) for every node and stored edge, so one call reads a subgraph with its content.
- **Search:** With `projection`, a node keeps `_id`, `depth` and `kind` and an edge `_id`, `from`, `to` and `label`;
  an edge's `properties` come too; vectors never return and diagnostics only with `includeDiagnostics`.
- **Records:** A batch (`POST /bulk`, `save_bulk`) answers with `refs`, `{ "post-1": { id, kind } }`, one row per
  `$ref` key whose item was written.
- **Ingest:** `POST /api/brain/spaces/:spaceId/ingest` and MCP `ingest` turn a raw conversation (`sessions`) into
  entities, claims, edges and a timeline, or write an extraction made already (`extraction`) with no model; `202`.
- **Ingest:** `GET /api/brain/spaces/:spaceId/ingest/:runId` and MCP `ingest_status` report phase, counts, dropped
  claims, uncovered turns and backends; runs are held in memory.
- **Ingest:** A run also reports `ids` (extraction key to record id) and `sourceTurns` (record id to its source turns).
- **Ingest:** Refused with `409` before any model is paid for when the space lacks the `conversation` group or, for a
  raw conversation, a decision model, the assist model or the `doc-nlp` sidecar; the refusal names what to change.
- **Ingest:** Records are written under the batch door's rules; transcripts are files, so they need a token that also
  holds `files: write`.
- **Ingest:** The extractor asks the decision model judgement questions over options the space's schema supplies and
  checks every claim against its own turns (one rewrite, then dropped and reported).
- **Ingest:** An unclear or refused model answer takes the outcome that cannot add a wrong fact; a `supersedes` edge
  is drawn only on a clear replacement.
- **Ingest:** It writes one arc claim for a subject spanning three or more sessions and folds a repeated telling of an
  unchanged state into one claim.
- **Ingest:** It dates an edge (`since`, `until`) only when its own text does, builds a timeline of completed,
  upcoming or cancelled events, and describes each entity from its own claims.
- **Ingest:** Text is written by `documentProcessing.assistModel` once its host is consented to; an extraction links
  entities the space already holds by UUID through `existingEntities`.
- **Media:** A decision model for the extractors is set on Settings → Models: default TypeSafe System One
  (`https://api.typesafe.ai`, `jev-latest`), via `decisionModel`, `PATCH /api/admin/media-config` or `DECISION_URL`.
- **Media:** `DECISION_MODEL` and `DECISION_API_KEY` set the model and key (the key lives in `secrets.json`); it has its
  own `modelSlots.decision` budget and `YTHRIL_ALLOW_PRIVATE_DECISION` switch, and shows in the egress matrix.
- **Media:** Nothing is sent to the decision model until the operator acknowledges its host, checked on every call;
  without consent the questions go to the assist model, and with neither extraction is refused.
- **Media:** A decision answer outside its options, or missing, is marked `invalid`.
- **Server:** A bundled `doc-nlp` sidecar (spaCy) proposes named entities and noun phrases to the extractor;
  `NLP_SIDECAR_URL` points the server at it and `DOC_NLP_REPLICAS=0` leaves it out.
- **Server:** The sidecar runs non-root, read-only, with no egress, and never downloads at runtime.

### Changed

- **Docs:** The user guide's media, model and embedding settings are their own chapter (`04a`), anchors unchanged.
- **Docs:** The README describes Ythril as a knowledge management system; its quickstart points MCP clients at `/mcp`.
- **Docs:** The 5.0.0 breaking table lists all ten retired `GET` routes with their verb and says to reconnect MCP
  clients after upgrading.

### Fixed

- **Networks:** A network card counts one member in the singular in English, German and Polish.
- **Networks:** A member's link direction and address now show on the Networks page; every member read `both` with no
  address.
- **Sync:** A space mapped under another name at join now answers its peers; their requests for the network's name were
  refused with `403`, so every sync cycle a peer ran for it failed.
- **Sync:** An unchanged network schema no longer rewrites the config file on every sync cycle.
- **Records:** A batch item (`POST /bulk`, `save_bulk`) no longer drops `superseded` and `suppressEmbeddings` on any
  record kind; a non-boolean refuses the item.
- **Files:** A REST upload whose metadata write failed now fails the request instead of answering 2xx with bytes on disk
  and no record behind them, as MCP `write_file` always did.
- **Search:** A recall across several spaces reranks once over all candidates, in one request of at most 100 passages,
  instead of once per space; an instance reaching many spaces no longer answers `degraded: ["rerank_unavailable"]`.
- **MCP:** An edit made through an MCP tool is audited with its before and after as `changes` and the record id, as REST
  already did, on ten tools (record edits, entity merge, network settings and space additions, space and schema updates).
- **Help:** The MCP server instructions and `help()` no longer name removed tools (`list_chrono`, `find_similar`,
  `list_peers`, `sync_now`, `find_entities_by_name`, `get_space_meta`); `retry_embed_record` names `retry_embed_file`.
- **Errors:** The entity-delete `409` no longer says there is no cascade delete; it says the cascade removes the
  blocking edges.
- **Ingest:** A document pasted into a conversation is no longer mined into claims; it is marked as material the speaker
  brought and no longer sets the size of the writer's prompt.
- **Ingest:** A fact an assistant supplied is no longer filed as the person's: only a fact the assistant originated is
  its claim (`attributed`, stored unranked), and a speaker named `assistant` no longer fails validation.

### Security

- **Networks:** A round arriving from a peer can no longer pass itself off as this instance's own: a peer could make a
  member join a same-named private space to the network or treat a passed schema change as its own edit.
- **Ingest:** Starting runs over REST is rate limited per token like MCP, sharing one count; before, a token allowed to
  write could start runs without bound and exhaust the model backends.
- **Tokens:** A stored rights matrix missing an area now reads it as `none`; before, such a matrix reached every space
  it had a row or floor for.

### Internal

- **Server:** Unused npm packages (`multer`, eslint and its plugins, `@phosphor-icons/core`,
  `@angular/platform-browser-dynamic`, several `@types/*`) are no longer dependencies.
- **Server:** `npm run machine:free` removes the test stack, prunes unused Docker data, trims the VM disk and runs
  `docker:compact`; `-Wipe` deletes the whole data disk instead.
- **Server:** Test services have CPU and memory ceilings, raised by `YTHRIL_TEST_{APP,MONGO,DOCRENDER}_{CPUS,MEM}`, and
  Build & Test runs on pull requests into `release/X.Y.x`.

## [5.1.7] — 2026-09-25

A security patch for networks: a deletion or wipe vote acts only on a passed round for a space its network carries,
and a member can no longer be named proposer to have its vote ignored; roll it onto every networked instance.

### Security

- **Networks:** A `space_deletion` or `space_wipe` round now acts only once passed, on a space its network carries, and
  once; before, an expired round or one naming an unshared space let any member delete it (restore from backup).
- **Networks:** A member can no longer be named as another round's proposer to drop its vote: the subject is left out of the
  voters only on a join or removal, and the real proposer's signed yes is cast when it opens the round.

## [5.1.6] — 2026-09-25

A security patch for networks: an invite can no longer be applied under another peer's instance id; roll it onto
every networked instance.

| Changes on upgrade | Action |
|---|---|
| An older joiner already connected to the inviter and joining a second network is refused (`403`, naming the reason) by a patched inviter | Upgrade the joiner to 5.1.6; a patched peer proves itself automatically. |

### Security

- **Networks:** An invite can no longer be applied under another peer's instance id: an existing peer must present a token the
  inviter issued to it. Any invite-bundle holder could otherwise read every space the inviter shares with that peer.
- **Networks:** A joining side now refuses an inviter that claims a known peer's id from another address.

## [5.1.5] — 2026-09-25

A patch for networks: two networks joined from the same peer at the same moment both keep syncing.

### Fixed

- **Networks:** Networks joined from the same peer within seconds of each other both keep syncing; one used to answer
  every sync with `403`. A pair already caught recovers on its next handshake, or by leaving and rejoining that network.
- **Networks:** Once a join is registered, every token either side keeps for the other reaches that network's spaces
  too; a peer is still admitted only to the spaces of networks it is a member of.

## [5.1.4] — 2026-09-25

A patch for the web interface: open network votes are listed and can be cast from the Networks page again.

### Fixed

- **UI:** Settings → Networks (**Open votes**) and the Brain Governance panel list open vote rounds again, and Yes and
  Veto reach the round, so a stuck join, removal or settings change can be decided there.

## [5.1.3] — 2026-09-25

A patch: a token granted only space administration can write again.

### Fixed

- **Tokens:** A token whose rights are only a space-administration grant (no floor, no per-space rungs) is no longer
  refused every write with "This token has read-only access"; the grant counts as `admin` on those spaces.

## [5.1.2] — 2026-09-25

A patch for networks: two instances that share several networks keep syncing all of them, a sync that transferred
nothing no longer reports success, and your own passing vote applies at once.

| Changes on upgrade | Action |
|---|---|
| A peer token now reaches every network the two instances share (it reached only the network being joined) | After upgrading, re-join any second network created between the same two instances. |
| A sync cycle with a refused or cut-short transfer now fails (`partial` or `failed`) instead of recording `success` | Expect networks that answered `403` unnoticed to show failures in sync history. |
| A space-settings change your own vote already passes answers `200` (was `202 vote_pending`) | Nothing. |

### Fixed

- **Networks:** Joining a second network with the same peer no longer cuts off the first (pushes and pulls answered
  `403` both ways, unlogged). A request is still admitted only to spaces of networks the peer belongs to.
- **Networks:** A joining side no longer hands over an all-spaces token when the network carries no spaces; the token
  reaches none.
- **Networks:** A space-settings change that your own vote already passes (one yes on a club or pub/sub network) now
  concludes when it opens; it used to wait for the same yes to be cast again or the vote to expire a day later.
- **Sync:** A cycle whose transfers were refused is no longer recorded as `success`: the history's `errors` names the
  space, direction and transfers, and the member's consecutive-failure count rises (also for a member with no peer token).

## [5.1.1] — 2026-09-24

A security patch: a network invite that was applied and never finalized no longer leaves a permanent peer token behind.

| Changes on upgrade | Action |
|---|---|
| At start, peer tokens whose instance shares no network with this one are revoked, removing leftovers of earlier handshakes | Nothing; a member or a joiner with an open vote round is never touched. |

### Security

- **Networks:** An invite applied but never finalized (joiner crashed, refused, disconnected) left a peer token to the
  network's spaces that never expired and belonged to no member; it now expires with its handshake.

## [5.1.0] — 2026-09-23

A `/bulk` / `save_bulk` item can now carry its own relationships, and a refused batch key, a failed config reload and
a reranker refusal no longer pass silently.

| Changes on upgrade | Action |
|---|---|
| `/bulk` and `save_bulk` refuse the retired key `memories` (it answered `207` with nothing written) and any unknown top-level key, with a `400` | Send `facts`; the accepted keys are `facts`, `entities`, `edges` and `chrono`. |
| A bulk item carrying a retired link array (`entityIds`, `memoryIds`, `chronoIds`) is refused instead of dropped | Send the item's current `link*` fields. |
| A bulk item's link field its kind cannot hold (`linkFiles` on a fact) or a non-array link value is refused (was ignored, or read as empty) | Send only the link fields the item's kind supports, as arrays. |
| A bulk item's own `edges` entry naming a `$ref` is refused, naming the top-level `edges` array | Use existing record ids in an item's `edges`; keep `$ref` edges in the top-level array. |

### Added

- **Records:** A `/bulk` / `save_bulk` item takes the link fields its kind can hold plus `edges`, as a single write
  does, so a record and its relationships are one call; an unhonourable connection is refused before the record is written.
- **Records:** The `/bulk` reply counts these relationships under `connections`, separate from `inserted.edges`; the
  `bulk.write` webhook carries it and fires when only connections were written.
- **Server:** A failed watched config reload now shows on `ythril_config_reload_pending` (gauge, `1` until the next
  successful reload; alert on it) and `ythril_config_reload_failed_total`. The watcher never retries a refused file itself.

### Fixed

- **Search:** Reranking works against a stock reranker, which refused up to 100 passages in one request (`413`,
  surfacing as `degraded: ["rerank_unavailable"]` and fused order).
- **Search:** Rerank candidates go in batches of 32 (`mediaEmbedding.rerank.maxPassagesPerRequest`, 1 to 100, admin
  API) under one deadline; if any batch fails the pass is abandoned and the vector order stands.
- **Sync:** A file's links are now checked, so a file linked to an entity this instance lacks is reported as a link
  violation; `docType` can be `file`, with `docId` the file's path.
- **UI:** Deleting an entity that has edges in the Brain UI opens a confirmation counting what goes by kind (the record
  at an edge's other end stays); an entity nothing points at deletes in one click.
- **UI:** A failed delete of a fact, chrono entry, edge or entity now shows its reason above the list, not nothing.

## [5.0.1] — 2026-09-22

A patch: `filter` and `similar` on MCP are no longer audit-logged as writes when `audit.logReads` is `false` (the
default); take it if your agents call them.

### Changed

- **Docs:** The audit guide lists every operation the log can contain (added `conflict.*`, `contradiction.*`, `data.*`,
  `schema_library.*`, `token.update`, `token.regenerate`, `link.create`, `link.delete`; removed five nothing records).

### Fixed

- **Audit:** MCP `filter` and `similar` (`brain.filter`, `brain.similar`) no longer log as writes when `audit.logReads`
  is `false`; a tool's read/write class now follows its REST route (`entity.cascade_preview` is a read). Old rows stay.
- **Audit:** MCP `network_sync` with a `peerId` now records `peer.sync_trigger`, as
  `POST /api/networks/peers/:peerId/sync` does, not `network.sync_trigger`; a filter on it now sees an agent's syncs.

## [5.0.0] — 2026-09-22

**Ythril 5 renames every public name at once (tools, routes, the `memory` type, link fields) with no aliases, so upgrade every instance in a network together.**

| Changes on upgrade | Action |
|---|---|
| A peer below 5.0.0 is refused at the handshake with `426` | Upgrade every instance in the network before restarting any |
| The knowledge type `memory` is now `fact`, everywhere | Send `fact`; `memory` is refused, not translated |
| Every MCP tool is renamed verb-first and three fold into others (45 tools, was 48); a retired name is an error | Re-read `tools/list`; reconnect any MCP client that stayed connected, it still holds the 4.x list |
| Every tool is `POST /api/<tool-name>`; ten `GET` routes are gone: `.../spaces/:spaceId/{facts,entities,edges,chrono,files}`, `.../{facts,entities,edges,chrono}/:id`, `.../entities/by-ids` | Read a collection with `POST /api/filter` |
| Routes that still exist: `PATCH`/`DELETE` on the `:id` paths, `PATCH .../files`, `GET .../entities/:id/cascade-preview`, `GET .../files/extract` | Nothing; match on method and path, not path alone |
| The search family drops the space from its path | Call `POST /api/brain/recall` with `space` in the body |
| The six link array fields are gone | Send `linkEntities` / `linkFacts` / `linkChronos` with the same ids; the refusal names the field |
| A record no longer returns its links | Walk them with `traverse`, or `filter` over the `links` collection |
| Links convert to their own collection on the first 5.0 boot; `completeLinkage` cannot be turned off | Nothing; a space whose conversion failed is named in the startup log and refuses link reads until re-converted |
| Recall parameters `includeFreshWrites`, `includeContent`, `charsPerToken` are renamed or removed | Delete `includeFreshWrites` and `charsPerToken`; `includeContent` is now `includeFileContent` |
| `recall` on REST returns the MCP tool's result shape | Parse that one shape on both doors |
| Emptying a space is `POST /api/delete_space_data` | Re-point the call |
| Space administrator is a rung you grant; the four admin rungs no longer imply it | Grant it explicitly |

### Added

- **Records:** `superseded` is a boolean on facts, entities, edges and chrono entries, accepted on create and update
  on REST and MCP alike. A superseded record still embeds and ranks and comes back with `superseded: true`.
- **Records:** A `supersedes` edge says which record replaced another; a retirement may have no successor. Filtering
  on `superseded` is index-served.
- **Records:** Resolving a contradiction now marks the losing record `superseded` (response field `markedRecord`) and
  draws the `supersedes` edge for every pair kind except two edges, where `note` says why.
- **Embedding:** An attributed claim is stored without a vector: `recall` never ranks it, while `filter`,
  `graph_traverse` and recall's own expansion still reach it in full.
- **UI:** A superseded record is badged wherever records are listed, such as the Facts tab.
- **Docs:** Two new integration-guide pages cover the links API and graph-augmented recall; 44 of 52 documentation
  files changed, so a size-based docs refresh needs no `--force` for 5.0.0.

### Changed

- **Search:** `query` → `filter` and `find_similar` → `similar`, and the space leaves the path. Routes: `POST /api/filter`,
  `POST /api/brain/similar`, `POST /api/brain/recall` (name unchanged). `traverse` keeps its path.
- **Search:** `space` is an optional body field on all three: omitted, the search runs across every space the token holds
  `knowledge: read` in, ranked together. An unreadable space is skipped; a NAMED unreadable one is a `403`.
- **Search:** `recall`, `filter` and `similar` take `space` as a list on both doors: exactly those spaces, proxies
  expanded and deduplicated. `[]` is refused, and one named space you cannot reach refuses the whole call, naming it.
- **Search:** Every other tool acts on one space and refuses a list rather than using its first entry.
- **Search:** `filter` `limit` defaults to **200** on both doors, with no maximum (it was clamped to 100, so a page for
  200 came back short and looked complete).
- **Search:** A `filter` answer stays bounded without a row cap: `maxChars` / `maxBytes` trims the page (`truncated`,
  `nextSkip`), `maxTimeMS` is capped at 10 000, and on a proxy space `skip + limit` past the merge ceiling is a `400`.
- **Search:** `recall` drops `includeFreshWrites` (the fresh-write scan always runs) and `charsPerToken` (the ratio is
  fixed at 3.5; send `maxChars` for an exact ceiling) and renames `includeContent` → `includeFileContent`. A `400` if sent.
- **Search:** The fresh-write scan now honours `filter` and `tags`: a filtered `recall` no longer returns just-written
  records that do not match.
- **Search:** With `includeMemories` unsaid, a `recall` walk brings the attributed claims (AI-originated facts, stored
  without a vector) of what it reached, and no other fact. `false` brings nothing; `true` brings every linked fact.
- **Search:** `graph_traverse` is unchanged: its `includeMemories` is a real `false` by default.
- **Search:** `POST /api/brain/recall` hits are `{score, spaceId, type, record}` like MCP: read `hit.record.<field>` where
  you read `hit.<field>`. `score`, `spaceId`, `type`, `_graph` and the stage scores stay where they were.
- **Search:** A bad key on `POST /api/brain/recall` is a `400` whose `error` names it (`unexpected property 'topk'`);
  `unrecognized_keys` is no longer returned there.
- **Search:** `recall` no longer sends empty `tags` / `properties`, and `createdAt` / `updatedAt` are opt-in through
  `includeRecordMeta` (default false, both doors), about a third fewer bytes. `createdAt` is when the record was written.
- **Records:** The knowledge type `memory` is now `fact`, and the old word is not accepted: `remember` / `update_memory` /
  `delete_memory` → `save_fact` / `update_fact` / `delete_fact`; `POST /api/brain/spaces/:id/memories` → `…/facts`.
- **Records:** `<space>_memories` → `<space>_facts`; `recordTtlDays: { memory }` → `{ fact }`; webhook `memory.created` →
  `fact.created`; `ythril_memories_total` → `ythril_facts_total`; edge label `memory.entityIds` → `fact.entityIds`.
- **Records:** Boot migrations rename `<space>_memories` collections and `memory.*` webhooks, rewrite `recordTtlDays` and
  re-key edge and link ids, tombstones and embed jobs. A conflict is logged at `WARN` and left: read the first 5.0 boot log.
- **Records:** Audit entries for fact, chrono and file updates carry the before/after link sets under `linkEntities`,
  `linkFacts` and `linkChronos`, so a re-link no longer logs a change with no detail.
- **Records:** `update_file_meta` accepts `linkEntities`, `linkFacts` and `linkChronos` on both doors, and its MCP schema
  declares them.
- **Records:** A link id naming nothing is refused with `400` (not `500`) before anything is written. `save_bulk` checks edge
  endpoints under `strictLinkage`, so a space with linkage off still accepts a staged import.
- **Records:** There are six link classes. A write naming one the record kind cannot hold (`save_fact` with `linkChronos`)
  is refused on both doors, and the create tools advertise only the classes their kind holds.
- **MCP:** Every remaining tool is renamed verb-first, no aliases, nothing else changed: `save_fact`, `save_entity`,
  `save_edge`, `save_link`, `save_chrono`, `save_space`, `save_bulk`, `update_fact`, `delete_fact`, `graph_traverse`, `graph_merge`.
- **MCP:** Also renamed: `entity_cascade_preview` → `delete_entity_preview`, `wipe_space` → `delete_space_data`, `space_stats`,
  `space_meta`, `space_reindex`, `schema_update`, `network_peers`, `network_sync`.
- **MCP:** The embed-retry tools are `retry_embed_record`, `retry_embed_media` and `retry_embed_file`. Recall's `traverse` body
  field keeps its name.
- **MCP:** `er_model` and `GET /api/brain/spaces/:id/er-model` are gone: `space_meta` / `GET /api/spaces/:id/meta` answers
  it as `actualSchema`, in the declared schema's own format, so a held type can be promoted into the declared schema.
- **MCP:** `find_entities_by_name` (and `GET …/entities/by-name`) → `filter` with `collection: 'entities'`,
  `filter: { name }`; `list_chrono` → `filter` with `collection: 'chrono'`. The MCP surface is 45 tools, was 48.
- **REST:** Every tool is `POST /api/<tool-name>`: the body is the tool's arguments (`space` included) and one envelope
  comes back, `{ok: true, text, data}` or `{ok: false, error, data}`, with `error` word-for-word what MCP returns.
- **REST:** `POST /api/networks/:id/sync` gains `?wait=true` and `?timeoutMs`, and every sync trigger answers
  `triggered`, `completed`, `timeout` or `error` instead of a bare `{ ok: true }` (`ok` stays as the summary).
- **REST:** New `POST /api/networks/peers/:peerId/sync` syncs one peer across every network it belongs to; the id is
  checked against the configured members and never treated as a URL.
- **Spaces:** Emptying a space is `POST /api/delete_space_data` with `{ "space", "confirm": true, "types" }` on both doors,
  replacing the per-collection wipe routes. `confirm: true` is now required on both.
- **Spaces:** Emptying a collection no longer writes a tombstone per record (on a networked space it opens a governed round
  and every member wipes), and wiping `entities` unlabels every face (`faceEntityId`) on both doors.
- **Spaces:** A space id must match `^[a-z0-9-]+$` wherever its collections are named, so deleting one space cannot take
  another's data. No collection is renamed and no data moves.
- **Tokens:** `{ "spaceAdmin": { "floor": false, "spaces": ["work"] } }` grants space administrator: `admin` in all four areas
  of those spaces (`floor: true` reaches every space, later ones too). Four `admin` areas no longer imply it.
- **Tokens:** A boot migration grants `spaceAdmin` to every token holding `admin` in all four areas (an all-admin floor
  becomes the `floor` form), so no administrator is stranded.
- **Tokens:** `delete_space_data` now needs `admin` on the space, as its REST route does, instead of instance admin: a space
  administrator can empty it over MCP too.
- **Tokens:** `space` is optional on every writing tool for a token reaching exactly one space (`save_fact({fact: "…"})`
  lands); with two or more it stays required and the refusal lists them. The schema each token is shown says which.
- **Tokens:** A multi-space `recall` over MCP is now authorised against every named space (it checked the first and read
  all), and the destructive-call throttle of five wipes a minute now also holds MCP callers, not only the browser.
- **Help:** `help()` lists what MCP lacks: network governance (create, join, fork, invite, members, sync history, votes), a
  file's original bytes, listing the media embedding queue, the per-type schema write and the rights catalogue.
- **Server:** `ythril_mcp_tool_calls_total` is renamed `ythril_tool_calls_total` and gains a `door` label (`mcp` or
  `rest`); `door="mcp"` is the old series.
- **Database:** Spaces upgraded from 4.x get the full index set on their `links` collection at boot (the conversion had
  created it unindexed), so link reads on large spaces stop scanning.
- **UI:** The Brain and Files tabs read a record's links from the `links` collection and their forms name `linkEntities` /
  `linkFacts` / `linkChronos`; a searched list shows the same links as the paged one.
- **Docs:** The graph guide's `Links` section is its own page, `04g-links-api.md`.

### Removed

- **Records:** The 4.x link arrays are gone from the wire, storage and input: `entityIds` → `linkEntities`, `memoryIds` →
  `linkFacts`, `chronoIds` → `linkChronos`, on facts, chrono and files. A connection is a link record only; ids are unchanged.
- **Records:** A body still carrying an old array name is refused on both doors, naming the new one, and the whole call
  fails; `[]` and `null` are refused too, so *detach everything* is never read as *said nothing*.
- **Records:** Records come back without the arrays, `includeRecordMeta` no longer adds them, and a `filter` predicate over
  one matches nothing. Find connections with `traverse`, recall's `traverse` object, or `filter` on the `links` collection.
- **Records:** Every space converts itself on the first 5.0 start. A space whose conversion failed refuses every link read
  with an error naming it (never an empty answer); read the startup log, then restart or run `npm run links:convert`.
- **Records:** `npm run links:convert -- --preview` counts what would move without writing; `-- <spaceId>` converts one
  space. `GET /api/brain/spaces/:spaceId/links/convert-preflight` and the `graph_link_preflight` tool are gone.
- **Spaces:** `completeLinkage` can no longer be turned off by anyone, an instance administrator included.
- **Search:** `POST /api/brain/filter` is gone: read at `POST /api/filter`. The envelope is `{ok: true, text, data}`, with
  `results`, `count`, `total`, `limit`, `skip` and `truncated` inside `data`, and `{ok: false, error, data}` on refusal.
- **Search:** The list routes `GET /api/brain/spaces/:spaceId/{facts,entities,edges,chrono,files}` are gone: use `filter`
  with `collection`. Rows come back as `results` for every collection, and `limit` defaults to 200 with no maximum.
- **Search:** Porting a list route: `?name=` → `filter: { name }`, `?tags=` / `?tagsAny=` → `$all` / `$in`,
  `?after=` / `?before=` → a `createdAt` range, `?path=` → `path`. `?entity=` has no predicate; walk the links.
- **Search:** `filter` needs `deriveStatus: true` for a chrono `status` derived on read (else the stored value; refused on other
  collections) and `filter: { parentFileId: { "$exists": false } }` to hide file chunks, as the list routes did.
- **Search:** An unsupported paging name such as `offset` is a `400` naming the parameter to use (`skip`).
- **Search:** The routes reading ONE record are gone: `GET /api/brain/spaces/:spaceId/{facts,entities,edges,chrono}/:id` and
  `GET …/entities/by-ids`. Use `filter` with `{ "_id": "…" }`, or `$in` for a set.
- **Search:** A record that is not there is now `200` with `results: []`, not `404`: branch on `results.length`.
  `matchedText` and `embeddingModel` are withheld unless `includeDiagnostics: true`.
- **Files:** `DELETE /api/brain/spaces/:spaceId/files?path=` (the metadata-only delete) is gone: the file delete removes
  bytes and metadata together and answers `204` for an orphaned record.
- **Sync:** `POST /api/notify/trigger` (deprecated in 4.5) is gone: use `POST /api/networks/:id/sync` for a network or
  `POST /api/networks/peers/:peerId/sync` for one peer. `?wait=true`, `?timeoutMs` and the answer shape are unchanged.
- **Sync:** Both replacements validate their subject first and answer `404` for an unknown network or peer; the old route
  answered `200 {status:"triggered"}` for any `networkId`, so a stale id is now a refusal rather than a silent success.

### Fixed

- **Search:** `filter` finds one file by `path` and forgives its spelling (Windows separators, leading slash), exact
  after normalisation. Sending both `path` and `filter: { path }` is a `400`. Files only, tool and REST alike.

- **Search:** `filter` on edges now returns both endpoints' display names and on files the embedding job's step
  progress, as the list routes do. `includeDiagnostics` is accepted and applied (default false), not refused.

- **Search:** `filter` now takes `tag` (case-insensitive substring), `type`, `description`, `properties` and `search`,
  on the tool and `POST /api/brain/filter`; `filter` itself is optional. `links` refuses them, naming the collection.

- **Search:** `filter` takes `entityName`, `fromName` and `toName` on the MCP tool as on REST, refusing them on a
  collection they cannot mean. `entityName` also finds records attached with `linkEntities` (answered `total: 0`).

- **Search:** `filter` refuses an unusable `limit` (`abc`, `-5`, `0`) with a `400`, as it does `skip`; it used to
  answer the default page with a `200`.

- **Search:** `deriveStatus: true` plus any convenience (e.g. `?status=overdue&search=…`) is no longer refused with
  `Filter too deeply nested`, and a chrono `status` matches the derived value, as on the list route.

- **Search:** A `Date` value in a filter no longer turns into `{}` and answers `200` over the wrong set.

- **Search:** `filter: {"type": "note"}` (a bare scalar) now filters on equality; it was silently dropped and recall
  answered `200` unfiltered. Operator-object form is every value an object keyed by the eight operator names.

- **Search:** An operator-object filter such as `{"$where": {"eq": "x"}}` reached MongoDB unsanitised; `$`-prefixed
  keys now take the sanitised path. `__proto__`, `constructor`, `prototype` as filter keys are refused on both grammars.

- **Search:** A raw MongoDB equality on a declared field (`{"type": "note"}`) is now served by the vector index, not a
  full scan; `$or`, `$not`, `$exists`, `$regex` and nested filters still scan.

- **Search:** MCP `filter` no longer requires `space`; omitted, it reads across spaces like `POST /api/brain/filter`.

- **Search:** `POST /api/recall` now defaults to the same 50 000-character byte budget as `POST /api/brain/recall` (was
  25 000); the lower default is MCP's alone.

- **Records:** `graph_traverse` / `POST /traverse` return every edge among the returned nodes, including self-loops and
  a second edge between one pair, where they held one per node.

- **Records:** In `recall(traverse: n)` each `_graph` entry carries `edges` (plural) in place of `edge`, with
  `direction` (`outbound`, `inbound`, `self`) instead of `from` / `to`; the far end is `paths[0]`'s second-to-last id.

- **Records:** `graph_traverse` returns the start node at depth 0 (a fact or chrono entry too), counted against
  `limit`; an id that resolves to nothing still gives an empty `nodes`.

- **Records:** `linkEntities`, `linkFacts`, `linkChronos`, `linkFiles` and `edges` are now accepted on update of
  `facts`, `chrono` and `entities`, on both surfaces: links replace per class (`[]` detaches), edges upsert.

- **Records:** Merging two entities now re-keys the absorbed entity's link records to the survivor, tombstoning the
  old id; they were left pointing at the deleted entity.

- **Records:** The 5.0 link conversion no longer deletes links that exist only as records (written by `linkEntities`).
  On a space already converted they are gone, and the deletion replicated to peers; re-create them.

- **Records:** The link-conversion pre-flight no longer reports the full retention window on an instance without a
  recorder-start stamp; it clamps `since` to when recording began.

- **Help:** Tool and schema descriptions, guide pages and examples that named tools 5.0 removed or renamed (`query`,
  `traverse`, `list_chrono`, `er_model`) now name the live tool (`filter`, `graph_traverse`, `space_meta`).

- **Docs:** The recall guide now states that `lexicalScore`, `fusedScore` and `rerankScore` are always returned, and
  `includeDiagnostics` governs only `matchedText`, `embeddingModel` and `seq`.

- **Docs:** The guides say which reranker to pick: a cross-encoder replaces the retrieval order, and
  `bge-reranker-base` cut first-answer accuracy to 27.4% from 45.7%. Use `ms-marco-MiniLM-L-6-v2`; measure first.

- **Records:** `linkEntities` and its three siblings now store the link in the shape the space is read through; on a
  space created since the last restart they answered `201` and `traverse`, graph `recall` and deletes missed it.
- **Records:** An edge to a fact, chrono entry or file is now reached by a graph walk (it was silently dropped) and
  expands like any neighbour; no `includeMemories`/`includeFiles` flag governs it. A walk may start from a fact.
- **Records:** Claims an AI assistant originated are written with `attributed: true` (a declared boolean, a native
  pre-filter on both doors); the validator refuses an unmarked assistant claim and a person's claim carrying the mark.
- **Search:** Sorting the `links` collection now sorts by `createdAt`, `updatedAt`, `from` or `to`; it crashed (MCP
  `Cannot read properties of undefined`, REST `500` with `retryable: true`).
- **Search:** `filter` takes `deriveStatus` on both doors (default `false`): `true` returns a chrono entry's derived
  status (`overdue` once due, unless `whenDuePasses` says otherwise), `false` the stored one; refused outside `chrono`.
- **Search:** A top-level chrono `status` now combines with `deriveStatus` and the `filter` conveniences instead of
  being refused with advice to put `status` at the top level.
- **Schemas:** A type schema (4000 characters) and any property (2000) take a prose `description`: stored, returned by
  `get_space_meta` and the space listing, editable in the Schema tab, never parsed.
- **Schemas:** A property `default` now follows the declared type when the type changes (it was saved as `"5"` for a
  number, so a strict space refused records it created itself) and is omitted when the text cannot be one.
- **Schemas:** A schema type can be renamed on every knowledge type, keeping its properties and position and following
  the name into every edge-endpoint list; records already written keep the old type.
- **Spaces:** `space_reembed` is now an MCP tool (also `POST /api/space_reembed`), taking `kinds` and `limit` and
  returning the counts of `POST /api/spaces/:id/reembed`, which has queued embeddings for vectorless records since 4.4.
- **Spaces:** `space_reembed`'s `skippedSuppressed` and `remaining` now come from one snapshot, so a draining embed
  worker no longer makes them report suppressed records that are not.
- **Files:** `write_file` takes `encoding: "base64"` beside its UTF-8 default, so an MCP session can save a picture, a
  PDF or any binary file. About 7 MB fits (10 MB JSON body cap); larger goes through `POST /api/files/{path}`.
- **Files:** Text that is not valid base64 (such as a `data:image/png;base64,…` URL) is now refused on both doors; it
  used to store a short corrupt file under a `201`.
- **Files:** A file keeps its description, tags and properties across a move and across a rewrite that does not mention
  them; both are now documented guarantees, so there is no need to re-assert them after each write.
- **UI:** The edge-ends picker lists the declared entity types plus any name already on the edge (strays marked), so an
  end whose type was deleted can be unticked.
- **UI:** The space editor's Save no longer disappears after a "nothing to save" notice, and clearing a key (strict
  `strictLinkage` off, an emptied `purpose` or `usageNotes`) now counts as a change and is sent.
- **UI:** The Brain page now says a chrono status it shows is derived; a backup or export holds the stored status, so
  an entry shown overdue reads `active` there.
- **Server:** Every start converts each space not yet marked `completeLinkage` to link records, additively (an
  interrupted run completes next boot), because `npm run links:convert` failed on deployed instances; removal in 6.0.
- **Server:** Upgrading no longer rewrites file records peers also hold: the boot conversion does links only, and the
  pre-4.0 file stamp is back on `npm run links:convert`, which prints records stamped per space (containers cannot).
- **Server:** The conversion pre-flight clamps `since` to when this instance began recording and returns
  `recorderStartedAt` (`null` until the instance has started since upgrading), so it no longer claims ninety days.
- **MCP:** Every tool now fills `structuredContent` (was empty; HTTP `data`) with the record written or id acted on:
  delete `{"_id", "deleted"}`, `move_file` `{"from", "to"}`, `list_spaces` `{"spaces"}`, `network_peers` `{"peers"}`.
- **Docs:** Graph-augmented recall has its own integration-guide page, `04h-graph-augmented-recall.md`, split out of
  `04a-recall-api.md`.

### Internal

- **Build:** `npm run test:standalone` now runs the offline test files in parallel (257s to 160s) and refuses a stale
  `server/dist`; `--allow-stale` overrides.
- **Build:** The benchmark fetcher now streams and hash-verifies each corpus instead of buffering it (it died with
  `JavaScript heap out of memory` on `longmemeval_s`); `benchmarks/` holds a folder per benchmark.

## Earlier releases

- [4.x](changelog/CHANGELOG-4.x.md) — 6 releases
- [3.x](changelog/CHANGELOG-3.x.md) — 6 releases
- [2.x](changelog/CHANGELOG-2.x.md) — 17 releases
- [1.x](changelog/CHANGELOG-1.x.md) — 10 releases
- [0.x](changelog/CHANGELOG-0.x.md) — 18 releases
