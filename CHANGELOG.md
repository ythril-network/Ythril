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

- **Networks:** A `space_deletion` or `space_wipe` round now acts only once passed, only on a space its network
  carries, and once. An expired round, or one naming an unshared (even private) space, let any member delete it;
  restore from backup if so.
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

- **UI:** Settings → Networks (under **Open votes**) and the Brain overview's Governance panel list open vote rounds
  again, and Yes and Veto reach the round, so a stuck join, removal or space-settings change can be decided there.
  API, MCP and peer votes were unaffected.

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

- **Networks:** Joining a second network with the same peer no longer cuts off the first, whose pushes and pulls
  answered `403` both ways with nothing logged. Each request is still admitted only to spaces of networks the peer
  belongs to, so leaving one withdraws its spaces.
- **Networks:** A joining side no longer hands over an all-spaces token when the network carries no spaces; the token
  reaches none.
- **Networks:** A space-settings change that your own vote already passes (one yes on a club or pub/sub network) now
  concludes when it opens; it used to wait for the same yes to be cast again or the vote to expire a day later.
- **Sync:** A cycle whose transfers were refused is no longer recorded as `success`. The history's `errors` names the
  space, direction and transfers that stopped, and the member's consecutive-failure count rises; a member with no peer
  token is reported the same way.

## [5.1.1] — 2026-09-24

A security patch: a network invite that was applied and never finalized no longer leaves a permanent peer token behind.

| Changes on upgrade | Action |
|---|---|
| At start, peer tokens whose instance shares no network with this one are revoked, removing leftovers of earlier handshakes | Nothing; a member or a joiner with an open vote round is never touched. |

### Security

- **Networks:** An invite applied but never finalized (joiner crashed, was refused, lost the connection, or a restart
  in between) left a peer token to the network's spaces that never expired and belonged to no member. It now expires
  with its handshake; finalize clears the expiry.

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
- **UI:** Deleting an entity that has edges in the Brain UI now opens a confirmation counting what goes by kind (an
  edge is removed, the record at its other end stays); confirming repeats the delete with the preview token. An entity
  nothing points at deletes in one click.
- **UI:** A failed delete of a fact, chrono entry, edge or entity now shows its reason above the list, not nothing.

## [5.0.1] — 2026-09-22

A patch: `filter` and `similar` on MCP are no longer audit-logged as writes when `audit.logReads` is `false` (the
default); take it if your agents call them.

### Changed

- **Docs:** The audit guide now lists every operation the log can contain (it lacked `conflict.*`, `contradiction.*`,
  `data.*`, `schema_library.*`, `token.update`, `token.regenerate`, `link.create`, `link.delete`) and drops five that
  nothing records: `brain.query`, `brain.er_model`, `brain.find_similar`, `brain.recall_global`, `brain.bulk_write`.

### Fixed

- **Audit:** MCP `filter` and `similar` (`brain.filter`, `brain.similar`) no longer appear as writes when
  `audit.logReads` is `false`; an MCP tool's read or write class now comes from its REST route, so
  `entity.cascade_preview` is a read too. Existing rows stay as written.
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
  `fact.created`; `ythril_memories_total` → `ythril_facts_total`; link edge label `memory.entityIds` → `fact.entityIds`.
  `includeMemories` keeps its name.
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
