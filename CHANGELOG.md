# Changelog

All notable changes to Ythril are documented here. This file covers the **current major series**;
earlier majors are archived under [`changelog/`](changelog/) and linked at the bottom.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

**Store failures, sync and background jobs are hardened: a failing database answers a retryable `503` and a failing space is skipped, not stopping others; sync decides alike on push and pull and processes a peer's files by the receiver's rules; embedding moves to a supervised child process.**

| Changes on upgrade | Action |
|---|---|
| A store failure (timed-out write, exhausted or closed pool, paused store, about forty REST routes, sync POSTs, space rename or create, links) answers `503` with `Retry-After` and `retryable: true`, was `500`/`400`/`404`/`409`/`422` | Branch on `retryable`; retry on `503` |
| An unmeetable write concern answers `500` with `retryable: false`, was `503`; other non-store failures answer `{"error":"Internal server error"}` | Do not retry on `retryable: false`; update body matchers |
| Options in `MONGO_URI` win; `connectTimeoutMS` and `serverSelectionTimeoutMS` default to 10 s and `heartbeatFrequencyMS` to 5 s (a `serverSelectionTimeoutMS` in your string was overridden before) | Check the options your string carries |
| `DELETE /api/files/:spaceId`, `POST /api/delete_file` and `delete_file` answer `404` for a second delete of a flagged file or a derived record (chunk, face), with no tombstone, `file.deleted` or `seq`; a store failure there is `503` | A `404` on a retry can mean the first delete completed |
| A path with neither bytes nor metadata, a move with a missing source and a path through a regular file (`a.txt/x`) answer `404` on REST and MCP (MCP said `400`, REST `500`) | Handle `404` on both doors |
| `POST /api/admin/reload-config` answers `500` naming spaces that failed to initialise, or `503` with `Retry-After` when the database was down, where it answered success | The next reload retries them |
| `npm run links:convert` exits non-zero when a space could not be converted; the other spaces are still converted | Check the exit code in upgrade scripts |
| A background job's failure is logged as `<job> failed for space '<id>' (<part>): <reason> — retried <when>` or `<job> stopped: the store is not answering …` | Update log matchers |
| One entity merge relinks at most 2500 records: a larger one answers `422` `code: "merge_too_large"` (`relinks`, `bound`) and writes nothing; a merge a `strict` space refuses answers `400`, was `500` | Split the merge or delete records first |
| A bulk fact or chrono item carrying the `id` of an existing record counts in `updated`, not `inserted` (new records only); `bulk.write` fires for a batch that only converged | Read `updated` as well as `inserted` |
| `POST /api/sync/tombstones` takes at most 5000 per request (more is `400`; this instance sends 500) and answers `{ applied, refused }`; one whose seq is in the protocol's ceiling reserve is refused | Send smaller pages; read `refused` |
| A pushed fact over 50 000 characters is refused on the sync door, and `batch-upsert` allows a fact at most 10 forks (the eleventh counts in `forkDepthRefused` and `rejected`) | Older peers pushing these are refused; upgrade both ends |
| A pulled page is validated and decided as a push is, and a sender pushes targets first (facts, entities, chrono, file metadata, edges, links) | Upgrade both ends: an older sender may trigger link violations an older receiver does not record |
| A record arriving by push, pull or import without an expiry takes this space's retention window from its own creation time, so an older one is due at once and the sweep deletes it | Check the retention windows before syncing old data |
| The Merkle root no longer hashes `spaceId`, instance-local files (conversion sidecars too) or soft-deleted file rows, so equal data matches (`spaceMap` aliases too) | Mixed-version `merkle: true` networks log `MERKLE_DIVERGENCE` until all upgrade |
| A file a peer pushes or this instance pulls fires no `file.created` webhook and no live-view event (a push did, with the peer's token) | List files instead of waiting for `file.created` |
| Converted and extracted files (`_converted/`, `_extracted/`) no longer travel; each instance converts by its own settings, so conversion off holds no derived text; an offer answers `200 {"ignored":"instance-local"}` | Peers' sidecars are retired on upgrade |
| A document or media file a peer pushes or this instance pulls is converted by this instance's pipeline, external assist included where consented; a backlog is worked off over sync cycles | Expect conversion load and consented external-model traffic |
| A removed description, source, property, tag or suppression mark reaches a peer only when both run this release; one made while a peer ran older reaches it on the file's next edit | Upgrade both ends; edit the file to resend |
| A soft-deleted file's row stays local (never pushed, served or hashed) and the deletion travels as the file tombstone, which a receiver applies by its own `softDeleteFileMeta`; an older sender still pushes the row, stripped of its flag | Upgrade senders |
| A file's processing status, or a move of another instance's file, no longer changes its `updatedAt`; one that drifted converges on its author's after a `MERKLE_DIVERGENCE` re-reads that peer's files (`ythril_sync_file_meta_rereads_owed`) | Without `merkle: true` it clears at its next edit |
| A soft-deleted file's record answers `404` on the by-path read, the extract and `PATCH`, `update_file_meta` refuses it as a missing path, and it leaves stats, search, graph and link targets; `filter` still returns it | Filter on `deletedAt` to find deleted files |
| A file row whose `updatedAt` is not an ISO instant under 40 characters is refused on the sync doors (`400` on push) | Send ISO timestamps |
| `ythril_reindex_in_progress` is the number of spaces with a run going, was 0 or 1; a second reindex of a space with a run going answers `409` | Change an alert `== 1` to `> 0` |
| `POST /api/brain/similar` answers in the `similar` tool's shape: hits `{score, spaceId, type, record}`, `source` `{type, id, summary}`; `topK` above 100 is `400` | Read `hit.record.<field>` and `source.id` |
| A `recall` over several spaces, a proxy or no space ranks by relevance across the merged pool, so spaces interleave and `fusedScore` and `vectorRank` change | Nothing for one-space recall; re-check stored scores |
| `recall` or `similar` without `space` (or `similar` with `crossSpace: true`) search only spaces where the token holds the tool's area, so a `files: read` token no longer ranks records | Grant the area on the spaces to search |
| `POST /api/duplicates/:id/merge` needs `dataQuality` write and `knowledge` write in the pair's space; a refused candidate answers `404` | Grant both rights to the token that merges |
| `POST /api/brain/spaces/:spaceId/traverse` answers `400` for what it clamped (`maxDepth` outside 1-10, `limit` outside 1-1000, a bad `direction`, `edgeLabels` or blank `startId`); a bulk array over 500 items is `400` (was `207`) | Send values in range |
| `400` past: `tags`, `deleteFields`, `edgeLabels`, `folders` 100; `linkEntities`/`linkFacts`/`linkChronos`, id lists (`spaces`, `proxyFor`, `ids`) 1 000; inline `edges` 500; bulk-resolve `ids` 2 000; notify `data` 8 KiB; `types`/`kinds`/`events` beyond their set | Stay within them (REST and MCP) |
| An `ingest` conversation over 1 000 sessions or 20 000 turns, an upload whose JSON `tags` is not an array, `network_sync_history` `limit` outside 1-100 and an embed-queue `limit` over 200 answer `400` | Send values in range |
| A fifth concurrent `ingest` run answers `429`; each live-event stream kind admits 200 connections (then `503` with `Retry-After`) and drops a reader 256 KiB behind | Retry later; read events promptly |
| `POST /api/<tool>` carries the answer once: `data` holds it and `text` is one fixed sentence (still the answer when a tool has no structured result) | Parse `data`, not `text` |
| MCP `content` and `structuredContent` are each held to half the stated budget (about half the rows per page; `budgetChars` is the stated budget); `read_file` is budgeted and paged by `markdownSkip` with `truncated` and `markdownNextSkip` | Follow `nextSkip` / `markdownNextSkip` |
| Every list that stopped at a number says so and pages whole rows to the end on both doors (`count`, `total`, `limit`, `skip`, `truncated`, `nextSkip`); a non-numeric `limit` or `skip` is refused | Page until `truncated` is absent |
| A type-schema write sending a changed definition beside a `$ref` answers `400` naming the field, was stored inline | Change the library entry or drop `$ref` |
| The admin import refuses a document whose `seq` is not a non-negative integer below the ingest ceiling and lists each in `refused` | Check `refused` after an import |
| A proxy space no longer gets collections at boot, and a hand-edited `"proxyFor": []` is removed on load (warning), so the space becomes a real one, embedded and scanned | Remove `proxyFor: []` if it was not meant |
| MCP `save_bulk` refuses a retired or unknown key (such as `{"memories": […]}`) with REST's `400`, naming `facts`; it answered success and wrote nothing | Send `facts`, not `memories` |
| `POST /api/duplicates/scan` and `POST /api/contradictions/scan` answer `200` with `failedSpaces` (`[{ spaceId, reason }]`) and `scannedSpaces` when one space fails, was `500`; a dead store is `503` | Read `failedSpaces` |
| Sync reads: a `sinceSeq` that is not a whole number ≥ 0, or a `cursor` that does not decode, answers `400` (was an empty page); a page's `nextCursor` names a seq and a record, so a client that builds or parses one breaks | Echo `nextCursor` unchanged |
| On a pub/sub network or a tree, a deletion from your direct publisher or parent now deletes the records it delivered to you, whoever wrote them (its retention sweep's too); records you wrote are never deleted by it | A compromised publisher can delete what it relayed |
| In its first sync each space stamps its stored records once with the peer that delivered them, then re-reads every upstream's tombstones from the start; a deletion the upstream already pruned is not recovered | Upgrade root-first; watch `ythril_sync_tombstone_rereads_owed` reach `0` |
| File tombstones carry `issuer` and `rowSeq`, apply only under the deletion rule and only to the version they name; `POST /api/sync/file-tombstones` takes pages and answers `{ applied, refused?, declined? }` | Send pages; read `declined` |
| `GET /api/sync/file-tombstones` takes `cursor` and answers `nextCursor`; without `cursor` it answers as before, cut at its fixed ceiling | Page with `cursor` to read past the ceiling |
| `POST /api/sync/tombstones` answers `declined`; a peer's upload of a file this instance deleted answers `200 { tombstoned: true }`; batch `filemeta` gains `tombstoned` | Read a missing counter as zero |
| A rollback leaves `deliveredBy` on stored records: an older build hashes and serves it, so a `merkle: true` network logs divergences and an older peer refuses those file records | Expect the warnings until the upgrade is redone |
| Records an earlier version skipped at a page boundary stay missing on a peer until edited; nothing re-sends them | None, or edit a record to send it again |
| A refused inline `edges` entry stores nothing (a bulk item with one is refused whole) and answers `schema_violation`: REST `400` on create, `422` on update (was `500`); MCP a structured `422` (was `400`); `strictLinkage` refuses a missing far end of any kind | Branch on `schema_violation` |
| `POST .../edges`, `save_edge` and a bulk top-level edge refuse a missing end as `schema_violation` (REST `400`, MCP structured `422`; was `{ "error" }` / plain `400`); a fact POST refusal carries the full documented body | Match on `schema_violation` |
| A write that stored its record and failed on its connections answers that cause's status with `retryable: false`, no `Retry-After` and `written: { kind, id, edges }` (was a retryable `503`); a bulk row carries `written` | Send the missing edges as an update to `written.id` |
| Each edges collection gains a unique index (background pass; a restore rebuilds it, answering `edgeIndexes.failed`) | Races refused once the pass has run |
| A second edge to the same `to` of another kind under a `functional` label is refused; `validate-schema` adds `staleGuards`; a relabel onto a held identity answers `409 edge_identity_taken`, was `500` | Read `staleGuards`; handle `409` |

### Changed

- **Errors:** The store-failure `503` carries the store's `code`, `codeName` and one retry sentence on REST (writes included), `POST /api/<tool>` and MCP; recall, similar and traverse send `Retry-After` too.
- **Errors:** An unmeetable write concern (more acknowledgements than members, an undefined named concern, `w` above `1` on a standalone) carries `code` and `codeName` and may have applied its write: read the record before repeating; a sync receiver stops the page.
- **Errors:** Pool checkouts time out only where `waitQueueTimeoutMS` is in `MONGO_URI`. A failed space rename answers its code (`ENOENT`), not the data path.
- **Database:** New `YTHRIL_WRITE_TIMEOUT_MS` (default 30 s per write operation) and `YTHRIL_HOLD_DEADLINE_MS` (45 s per hold); both refuse `0`. A `timeoutMS` in `MONGO_URI` does not apply to them; boot warns once on a `socketTimeoutMS` below the write bound.
- **Database:** Boot logs one INFO line, `MongoDB client options: …`, naming the timeouts in use (never the string); a changed string takes a restart. An operation in flight when the database stops answering ends with the retryable `503` (`0` means no bound; `loadBalanced`: selection only).
- **Database:** The first connection retries more kinds of "not up yet"; bad credentials fail at once.
- **Database:** A search service (`mongot`) that starts after the app is picked up by a background retry (5 s backing off to 5 min); a waiting space stays `building` and `GET /api/spaces` adds `indexWaiting` and `indexWaitingSince`.
- **Database:** `indexStatus: "failed"` now means only a build that failed or timed out, so an alert keyed on it for a late service stops firing; `INDEX_READY_TIMEOUT_MS` starts when indexes are confirmed. `GET /ready` shares one probe.
- **Database:** A collection's vector index (`files`, the face gallery too) exists only while it holds a record: dropped `SEARCH_INDEX_DROP_DELAY_MS` (default `60000`) after its last is deleted, and at boot for empty ones.
- **Database:** Such an empty collection answers search empty with no `degraded` reason and shows `empty: true` in `GET /api/admin/pipeline-status`.
- **Server:** `space.reload_added` is written after initialisation with its real status. A refused manual reload moves `ythril_config_reload_failed_total` and holds `ythril_config_reload_pending`; a reload that succeeds clears the gauge.
- **Server:** A `links:convert` failure prints `<id>: FAILED (<reason>) | not converted, not marked | file seqs NOT stamped`; the boot summary *"Link conversion FAILED for N space(s)…"* names hung, not-reached and skipped spaces.
- **Server:** Failure lines are said once per step, space and part in a window; the old *"Candidate prune"*, *"Tombstone prune"*, *"File tombstone prune"*, *"drop-link-arrays: … failed"*, *"convert links …"* and *"kept for the next cycle"* lines are gone.
- **Server:** New `ythril_housekeeping_space_failures_total{step,kind}` (`failure`, `timeout`, `store_down`, `stalled`), `ythril_housekeeping_records_failed_total{step}`, `ythril_interval_tick_skipped_total{job}` and gauge `ythril_housekeeping_quarantined_spaces` (alert above `0`).
- **Housekeeping:** A repeating job whose previous run is still going skips its next tick; an error escaping a tick logs `<job> failed:`. The webhook retry poll delivers due retries four at a time.
- **Housekeeping:** The retention sweep removes up to 500 records per collection each 5 minutes and keeps an expiry this instance holds when a peer updates the record.
- **Records:** The `merge_too_large` message (merge route, `POST /api/duplicates/:id/merge`, `graph_merge`) names both entities and counts
  edges, links and face labels apart; automerge leaves such a pair open. A conflict plan is `422` on `POST /api/graph_merge`, `409` on the REST merge route.
- **Records:** A merge relinks a hub's edges, links and face labels in one transaction of a few bulk writes. An entity delete with `cascadeToken` removes edges 500 at a time, one transaction per chunk with its tombstones, one `edge.deleted` webhook per edge after its chunk commits.
- **Records:** A bulk write reads a batch once and writes one block per kind; items still see earlier items. An item depending on an unwritten one names that refusal, a `$ref` key used twice refuses the batch, a per-item reason never carries database text.
- **Records:** A converge that loses a race is decided again against the record as it now is; losing twice is `409` on a create door
  and an item error in a batch. `save_bulk` declares the `id` of fact and chrono items.
- **Sync:** A tombstone of a type the receiver does not know still answers `400`, so the sender re-sends after it upgrades. Tombstone
  pages and every arriving record (push, pull, import, file metadata included) cost a handful of database commands per page.
- **Sync:** A fork's id derives from the parent's id, seq and text, so a re-sent push upserts it; an older receiver accepts an eleventh.
  A fork outlives its parent's delete. Documents past the 500-per-family cap and records the store refuses count in `rejected`.
- **Sync:** A link under another id for linked endpoints is `skipped`. A space's Merkle root is not re-read when nothing changed, so
  `GET /api/sync/merkle` and `merkle: true` cycles are far cheaper (the file manifest is still walked); `computedAt` is when the root was computed.
- **Sync:** `GET /api/sync/tombstones` takes the same opaque `cursor` as the record pages; a page without `full=true` carries no deletion stubs. The push no longer sends a record's vector or retention stamps.
- **Sync:** Each space gets a `(seq, _id)` index per record collection, built in the background on the first start; paging stays
  tie-safe meanwhile, only slower. Rolling back to 5.6.x rebuilds the old `seq` index before the server listens.
- **Sync:** Each record stores which peer delivered it (`deliveredBy`: local, never sent, not shown by REST or MCP).
- **Sync:** New `ythril_sync_tombstones_applied_total`, `ythril_sync_tombstones_declined_total` and gauge `ythril_sync_tombstone_rereads_owed`; a declined deletion is said once per peer, space and reason; a page applying upstream deletions logs one line, the re-read one per space.
- **Sync:** New `ythril_sync_file_arrivals_total{door,outcome}` counts arrivals, record failures, repairs, refused bodies, quota refusals and ignored offers.
- **Embedding:** The bundled model runs in a supervised child process, so embedding no longer blocks the server (`/health` stays fast in bulk imports) and a native fault no longer takes it down; it exits after ten idle minutes (next embed pays a 1-2 s load).
- **Embedding:** `mem_limit` or a pod memory limit counts both processes. The child gets a minimal environment (never the Mongo URI, master key or an API token). A lost process is replaced after a growing delay; a record that kills it three times is `failed`, the crash in its `lastError`.
- **Embedding:** A model that cannot load stays failed until it or an offline flag changes, or a restart.
- **Embedding:** New `ythril_embed_wait_seconds`, `ythril_embed_process_restarts_total{reason}`, `ythril_embed_process_state`; `ythril_embedding_duration_seconds` times the inference process. `GET /api/admin/pipeline-status` gains `inference` and `state: "down"` on a sticky load failure.
- **Embedding:** A recall query is embedded ahead of queued documents; `embedConcurrency` keeps its defaults (2 bundled, 8 external) and bounds queue pressure on one process. Lanes: local writes, then peer arrivals and `reembed`, then reindex, each lower lane keeping one claim in eight.
- **Embedding:** `POST /api/brain/spaces/:id/reindex` and `space_reindex` record a run and return (the ack still carries `reindexed: 0, errors: 0`); every record is queued as a rebuild and the run survives a restart. It also rebuilds passages, captions and transcripts.
- **Embedding:** `GET .../reindex-status` and `space_meta` carry `reindexRun: { running, remaining, failed }`; poll until `running` is `false`. `needsReindex` stays `true` and recall refuses until every record is rebuilt.
- **Media:** A media worker slot refills the moment it frees; a raised `workerConcurrency` takes effect within one poll interval.
- **Search:** Every answer the size budget cuts carries `budgetBoundBy` (`maxChars`, `maxTokens`, `maxBytes`, or two), on both doors, for
  recall, similar, record lists, query pages, traversals and spill reads; absent when not cut or a walk ran out.
- **Search:** `filter`'s `limit` stays uncapped: a single-space read stops at twice the answer budget and answers `truncated` with
  `nextSkip`. `recall` and `similar` with `traverse > 0` walk up to 16 result rows together.
- **Search:** Text rank is per record type, so a fact no longer outranks an entity for being longer; fused results carry `vectorRank` and `lexicalRank` beside `fusedScore` (about 0.016-0.033).
- **Search:** A failing or slow reranker is set aside for 30 s, doubling to 5 min; searches report `degraded: ["rerank_unavailable"]` without waiting.
- **MCP:** `list_embed_jobs` takes `skip`, reads and sums a proxy space's members, and on both doors returns `transientFailures`.
- **MCP:** `recall`, `similar`, `filter` and `read_spill` take their size parameters from one schema: MCP accepts any `maxBytes` and
  raises a `maxChars` under 1000 to 1000, as REST did. `network_join_remote` states its 8 192-character limit on `inviteCode`.
- **MCP:** Tool calls cache one validator per token reach (64 kept), counted in `ythril_tool_validator_cache_total{result="hit|miss|evict"}`.
- **MCP:** The delete tools and `move_file` say who a deletion reaches: peers holding a copy this instance wrote, and everything below it on a pub/sub network or a tree.
- **Schemas:** A schema-library type reads as `{ "$ref": "library:<name>", ...definition }` by default on `GET /api/spaces/:id/meta`
  and `space_meta` (which takes `resolve` as REST does); `resolve=false` returns the stored `{ $ref }` alone, and new keys show beside each `$ref`.
- **Spaces:** `GET /api/spaces/:id/meta` and `space_meta` keep `stats` and `actualSchema` per space until the next write to its
  records, so an unchanged read is near-instant.
- **Networks:** A closed or democratic network connects every member to a newcomer; roster entries others propose wait for **Accept**
  (`POST /api/networks/:id/introductions/:instanceId/accept`, MCP `network_introduction_accept`); `GET /api/networks/:id` and `network_get` answer `introductions`.
- **Networks:** A club is a mesh: members pair directly via `POST /api/sync/networks/:id/pair` and `/pair/confirm`.
- **Files:** A file's extract returns its converted Markdown whole or in whole paragraphs that page to the end (**Show more**; it was cut
  at 256K characters), and its image list says when it is cut. `GET …/files/extract` takes `read_file`'s budget parameters.
- **Files:** A chunked upload's `202` carries `maxBodyBytes`; a chunk may send `x-expected-sha256` (`422` on a mismatch). A push above a peer's single-body limit goes chunked (it was `413` every cycle); a pull streams and verifies.
- **Files:** `read_file` and the extract hold only their window in memory. An unrecognised extension is marked `skipped`; identical bytes of a document or media file whose job is `pending` or `processing` are left alone.
- **Import/Export:** The admin export streams every replicated family, links included, omitting this instance's own state (vector, its
  model, `matchedText`, an edge's write guard). The import keeps the export's retention stamps as dates and a file's sync base, never the replaced copy's.
- **Import/Export:** The import drops file chunks, face records, byte-describing file keys and a restored file's old `embedding`, keeps
  the highest seq of a repeated id, and names records restored over a local deletion in `restoredOverTombstone`.
- **UI:** **Settings → Preferences** has a **Date and time** card (**Automatic** by default, **ISO 8601** or **Day.month.year, 24-hour**; **local time** or **UTC**), kept in this browser; hover shows ISO 8601 UTC.
- **UI:** Settings → Spaces shows a space waiting for search as "Waiting for search service", apart from "Indexing". The Query tab's
  structured mode is called Filter; the Graph view reads every page of `graph_traverse` and says when the walk stopped at its `limit`.
- **Docs:** The hosting guide names `YTHRIL_MONGO_MEM_LIMIT` (default `4g`) for spaces of tens of thousands of records. Help gains a testing guide (CI jobs, caches; the CI log is public).
- **CI:** A push to `full-run/<bundle>` runs every `ci.yml` job as checks named `Full run / <job>`, testing a bundle before its pull request; `Build & Test` stays the only merge gate.

### Fixed

- **Errors:** An error that only names `maxTimeMS` is no longer read as a missed deadline (no retryable `503`); a missing reference named like `mongot` stays `400`. A write the store could not finish answers `503 retryable` on create and converge doors too.
- **Sync:** A chrono `type` outside the space's vocabulary is still stored on pull (a push answers `unknownType`). Two peers pushing
  different text for one fact at one seq keep both (a fork), with the divergent copy's `createdAt` and `updatedAt`.
- **Sync:** Strict-linkage violations are recorded for every landed edge and link on every door, once per dangling end after a pull
  or push is whole (one `link_violation.created`). A push no longer waits for the check; a part-way pull still checks what landed.
- **Sync:** A file deletion reaches every peer once: its tombstone goes out only once the file is gone, once per path, is never pruned
  before it is sent (gauge `ythril_file_tombstone_oldest_hold_seconds`), and survives a wipe or a peer that sent the bytes first.
- **Sync:** A stalled write can no longer stop a space's replication (it ends within the write bound): gauge `ythril_seq_horizon_oldest_hold_seconds`,
  warning `seq horizon held <age>s …`. Seq-paged routes, the push loop and the scanners stop below any unfinished write.
- **Sync:** A peer with more than 1000 deletions of one kind passes on all of them, by pull and push (a peer on 5.6.x pulls at most
  1000 per kind). A page holding one id twice stores the highest seq; a stale tombstone is deleted only once its superseding record landed.
- **Sync:** Pulled records and entities pushed via `POST /api/sync/entities` are queued for embedding (earlier pulls lack a vector: run
  `POST /api/spaces/:id/reembed` once per synced space); a counter left behind answers a push `500` and sets `counterBehind: true` on an import (re-run it).
- **Sync:** Every push door moves the seq counter past every seq it received before answering. A peer's edit no longer erases this
  instance's vector and retention stamps; a record pushed under a `spaceMap` alias is stored under the local space id.
- **Sync:** A duplicate link in a push is `skipped` (it answered `500`) and a refused document gets one warning per page naming ids and
  reason. A database fault writing a pulled page no longer counts as `PEER UNREACHABLE`: it holds that family's position and refetches.
- **Sync:** A driver argument error drops only its own document (`rejected`; a single route `400`). A merge-dropped duplicate edge's or
  re-keyed link's tombstone carries `originalSeq`, so a peer that never held it is not sent the deletion.
- **Sync:** Records that share a sequence number are no longer skipped at a page or batch boundary, on pull, push and the duplicate and
  contradiction scans.
- **Sync:** A tombstone page whose elements are all refused no longer holds a peer's position for good against an upgraded server, and a
  refused element's seq no longer moves it; an older server still holds it.
- **Sync:** A tombstone `instanceId` over 256 characters is refused.
- **Sync:** A file deleted on one peer is removed on the others at the version it names; one re-created since (other bytes, or a newer version by its deleter) is kept. Tombstones page past a pull's cut; a push logs refusals.
- **Sync:** An admin restore removes a file description, source, property, tag or mark its backup lacks (`keysRemoved`).
- **Files:** A peer's file, pushed or pulled, is processed by this instance's rules (converted, chunked, media); a new version replaces old passages; a failed record write leaves no new file unless the database was down.
- **Files:** A pushed file's later description and tag edits are no longer skipped; arriving bytes revive a soft-deleted path and get this instance's retention window; a metadata arrival no longer overwrites a newer copy.
- **Files:** A file's processing status or a move of a peer's file no longer changes its `updatedAt` (a false Merkle divergence); changed media over a `complete` file is analysed again.
- **Files:** A soft-deleted file's record keeps no description, vector, chunk or face, and is removed once the space's file retention window has passed since the deletion; a space with no file window keeps it.
- **Files:** Re-uploading a file with metadata takes one sequence number and a write that changes nothing takes none; a peer's file row with no author gets no derived description.
- **Files:** File metadata a 4.0-5.6.1 pull left in `<space>_filemeta` is recovered (audit `file.stray_filemeta.drain`), never over a
  row's own description or tags, waiting up to 30 days for a missing file; a wrong-typed key or any `parentFileId` is discarded and counted refused.
- **Files:** Moving a file or folder leaves nothing at its old path, even mid-processing, and carries chunks, sidecars, their queued
  jobs and links (`PATCH /api/files/:spaceId`, `move_file`). A retried move completes only a move it began; a directory delete needs `confirm: true`.
- **Files:** A file whose bytes are gone but whose metadata remains is completed by REST delete, `delete_file` and the TTL sweep.
- **Files:** A deleted file no longer returns from a peer by any door unless re-created; a delete takes what derives from it. A file's id is its canonical path (NFC, no `.` or empty segments); peers reject others.
- **Search:** Records matching a `recall` query equally well come back in a stable order (ties break by id), so paging with `skip`/`nextSkip` shows each once, on MCP and `POST /api/brain/recall`.
- **Search:** `recall`, `similar` and the write-time duplicate check right after a space's first write no longer answer `503`
  while its vector index initialises. `filter`'s `total` counts what a `fromName`, `toName` or `entityName` join matches, on REST and MCP.
- **Records:** A small entity merges into a hub of any size (it failed with ~80 000 edges); a too-large refusal says *more than* the
  bound and `relinks` is a lower bound. A merge whose reply was lost after commit is answered as merged and still queues edges and sends webhooks.
- **Records:** A refused entity cascade removes nothing, and a cascade-removed edge is never gone without its tombstone, so peers cannot
  bring it back. `graph_traverse` and `POST /api/brain/spaces/:id/traverse` answer whole nodes in hop order with `skip`/`nextSkip`, `remainderDump`, `limitReached`.
- **Records:** A bulk edge whose end is a `$ref` to a fact or chrono entry stores that record's kind (it stored an entity end). A
  chrono entry rewritten through its `id` re-embeds its content, and an edge stores the property default its label's schema defines.
- **Records:** Two writers can no longer both store an edge under a `functional` label in a `strict` space: the loser is refused like a sequential one.
- **Embedding:** A record or file this instance suppresses (flag, type or space) keeps no vector from a peer's update or file bytes, passages, captions and transcripts included; a record retired from search gets none when rewritten without the flag.
- **Embedding:** Suppression turned on by a network (meta pull, space addition, leaving, precedence) or a saved type schema removes
  vectors already stored, files included, at once and at every start; `matchedText` is kept.
- **Embedding:** An embed job no longer writes a vector over a record that changed while it embedded. A reindex embeds the same text as
  the original write; `reembed` no longer gives a passage, face crop or converted copy a vector of its path.
- **Schemas:** `POST /api/notify` accepts `meta_change_pending`, so a schema-change round reaches peers (was `400`). `GET
  /api/schema-library` answers `usageCounts`; the dry-run reports checked-of-total per collection and pages.
- **Spaces:** One space that cannot be initialised no longer stops start-up or a reload for the others: it is logged once (`space init
  failed for space '<id>': … — retried next reload`) and retried; a reload confirms its vector index readiness (`building`, then `ready` or `failed`) without waiting.
- **Spaces:** Deleting a space no longer loses a race with the media worker (`ENOTEMPTY`), and one unfinished delete no longer makes later
  renames and deletes answer `500 "… is still pending"`. A new space no longer stays "building" when a `config.json` read fails with `ENODATA`.
- **Tokens:** A completed network handshake revokes the peer tokens it replaces, on both sides and for club pairings, and start-up drops unused leftovers; a peer no longer accumulates one `peer:` token per join.
- **Networks:** A network joined before 5.6.0's join default gets its sync schedule (every 15 minutes, or the inviter's) at the next
  start, named in the log. Clearing a schedule stores manual as `""`, so a deliberate manual stays.
- **Housekeeping:** An error or hang in one space no longer stops a background job for the others (sweeps, claims, drains, prunes, scanners, reindex resume). New `YTHRIL_HOUSEKEEPING_OP_TIMEOUT_MS` (default 240 s, min 1 s, max 1 h) ends each of their database operations.
- **Housekeeping:** A pass ends early when the database does not answer or 3 spaces in a row time out; a timed-out space is passed
  over 60 s, doubling to 300 s. A record the retention sweep cannot delete is skipped and counted in `ythril_housekeeping_records_failed_total`.
- **Housekeeping:** A reindex run the server could not resume at start is retried every few seconds, and one whose sweeper died is taken
  over once its lease expires; `ythril_reindex_in_progress` keeps its last value if a space is unreadable.
- **Housekeeping:** Duplicate and contradiction scans report a lookup failure and move past a record that keeps failing; their review
  lists page instead of stopping at 500. An automerge a space refuses is reported once per pair, its survivor the older record.
- **Server:** A background job no longer logs under the request id of the request that armed it. Shutdown stops the sweeps, prunes,
  scanner, audit retention and chunk cleanup before the drain. An unknown tool name answers `404` without becoming a `ythril_tool_calls_total` label.
- **Server:** The notify event store holds at most 1 MiB (oldest out first) and its event list pages and says when it is cut.
- **Database:** Pushed and pulled pages and store-side bulks write in chunks of at most 99 999 operations and 16 MiB; a duplicate key
  then a timeout answers `503`, not `400`. The `MONGO_URI` user must be able to list and end its own operations, or each backstop ending logs an error.
- **Database:** A write answered `503` "timed out, retry" can no longer land after the answer: the server's deadline ends it, with a backstop 500 ms later.
- **Database:** `POST /api/admin/data/config/test` answers an unreachable host `200` with `{ "ok": false, "error": … }`. A large entity merge no longer prints `MaxListenersExceededWarning`.
- **Backup:** A scheduled backup that outlasts its cron period is skipped, not overlapped; its failure line reads `Scheduled backup failed: …`, was `Scheduled backup error: …`.
- **Media:** A job holds its file by path, not in memory, and is complete only after its file is; an ffmpeg step stops after 10 minutes, an audio segment at 5, a video at 1000 keyframes; a killed job leaves no plaintext; an unreadable source is not read as deleted.
- **Media:** With `reprocessSyncedImages` off, an image a peer pushes is no longer analysed for faces; the setting governs push and pull.
- **MCP:** `delete_entity`'s description names its cascade (`cascadeToken`, from `delete_entity_preview`).
- **UI:** The client never shows an answer older than the last one asked for (graph depth slider, record tabs, selected record card).
  The Graph tab says why it is slow after 3 s and ends in an error state with Retry after 30 s; German and Polish labels say the action.
- **Help:** Links in Help no longer open dead tabs (between split-guide parts, to headings such as `#links`, to repository files) and keep their place in the URL.
- **CI:** `node scripts/test-times.mjs --record-ci <runId>` fails when the run is missing from its listing after three minutes (`YTHRIL_TEST_RUNS_LISTING_WAIT_MS`); it reported success.

### Security

- **Housekeeping:** `POST /api/duplicates/:id/merge` now needs `dataQuality` write and `knowledge` write in the pair's space (a read token could delete an entity).
- **Errors:** Every door answers a store failure with one fixed `503` message, never the driver's text naming internal hosts, ports or the
  store's address (also `POST /api/networks/:id/sync?wait=true` and `POST /api/networks/peers/:peerId/sync?wait=true`, which echoed the exception).
- **Errors:** An unrecognised driver error answers `500` ("An internal database fault stopped this operation"), not `400` carrying its
  message; the database's own refusals (bad query, validation, duplicate key) stay `400`. The message is logged once per request as `Store-side failure answered 503`.
- **Server:** Log lines are single lines and each value in them is cut (4096 characters, 100 per list) and escaped, so a peer's member
  label, round id, document id or megabyte `seq` can no longer forge a line or flood the log; redaction no longer takes quadratic time (5.6.x is affected too).
- **Server:** Values quoted back in answers are bounded and escaped: a reference refusal names its first five (256 characters each, then
  `…(+N more)`), `Unknown field(s)` / `unrecognized_keys` the first 10 keys; sync refusal reasons, import `refused`/`schemaViolations`, admin `500` bodies likewise.
- **Server:** Stored error text (an embed job's `lastError`, a reindex run's `error`, a media job's and a webhook delivery's `error`)
  and a chat model server's error text (cut at 200 characters) are bounded and escaped.
- **Sync:** A peer's tombstone applies only to the space its sync admitted, not the one it names: a peer could delete its authored
  records in any other space, and under a `spaceMap` an honest peer's deletions never reached the space. Planted ones in other spaces stay.
- **Sync:** A tombstone is authorised before it is stored: one not delivered by its issuer, or for a record another instance wrote
  (unless it comes from that record's upstream), is refused and no longer blocks its author. Author-less records stay deletable by their peer.
- **Sync:** A record pushed with its author's own peer token is no longer refused as `tombstoned` by a tombstone another instance planted; pushed by anyone else, a deleted id is still refused.
- **Sync:** A negative `limit` on a sync read no longer returns the whole collection, and a read by id (`/api/sync/<family>/:id`)
  no longer returns a record's vector, matched text or retention stamps, nor a file chunk.
- **Sync:** A peer can no longer stop other members' deletions by planting more than 5000 tombstones at one seq, for pullers on this release; an older puller stays stuck until it upgrades.
- **Sync:** One deletion rule decides every record and file tombstone: the issuer's own, or the direct upstream's on a pub/sub network or a tree, for what it delivered.
- **Sync:** A peer's file tombstone needs the issuer's own authority or the upstream's (any admitted peer could delete the bytes), and a relayed one keeps its issuer. A held one refuses a later copy only as a record tombstone would, so a peer cannot block a path.
- **Sync:** A pull no longer fetches a file past the space quota, stores nothing from a body that is not as declared, and takes back bytes no row names.

## [5.6.9] — 2026-10-08

A patch: a file whose name has a character outside Latin-1 downloads and previews again.

### Fixed

- **Files:** A file named outside Latin-1 (`日本.txt`, an emoji, an accent sent decomposed) downloads and previews; it answered `500`.
  The download names the file by `filename*` (RFC 6266) with an ASCII `filename` beside it for older clients.

## [5.6.8] — 2026-10-07

Sync no longer skips records that share a sequence number at a page or batch boundary.

| Changes on upgrade | Action |
|---|---|
| A sync page's `nextCursor` names a seq and a record; a client that builds or parses one breaks | Treat the cursor as opaque: send it back unchanged |
| Records an earlier version skipped at a page boundary stay missing on a peer until edited; nothing re-sends them | None, or edit a record to send it again |
| The first start builds a `(seq, _id)` index per record collection in the background, then drops the old `seq` one; a rollback to 5.6.7 rebuilds it before listening | None |

### Changed

- **Sync:** `GET /api/sync/tombstones` takes the same `cursor` as the record pages; without one it answers as before. A page asked for
  without `full=true` no longer carries deletion stubs. The push no longer sends a record's vector or retention stamps.

### Fixed

- **Sync:** Records that share a sequence number are no longer skipped at a page or batch boundary, on pull, push and the duplicate and
  contradiction scans, while the new index builds too. The scanners re-read one run once after the upgrade.
- **Sync:** A tombstone page whose elements are all refused no longer holds a peer's position for good against an upgraded server, and a
  refused element's seq can no longer move the position.

### Security

- **Sync:** A peer can no longer stop other members' deletions by planting more than 5000 tombstones at one seq, for pullers on
  this release; a puller on an older release stays stuck there until it upgrades.

## [5.6.7] — 2026-10-06

A security patch: the sync read routes no longer return a whole collection, or a record's internal fields, to a caller that asks.

| Changes on upgrade | Action |
|---|---|
| Sync reads: a `sinceSeq` that is not a whole number of 0 or more, or a `cursor` that does not decode, answers `400` (was an empty page); `limit` below 1 reads 1 | Send back the `nextCursor` a page returned |

### Security

- **Sync:** A negative `limit` on a sync read no longer returns the whole collection, and a read by id (`/api/sync/<family>/:id`)
  no longer returns a record's vector, matched text or retention stamps, nor a file chunk.

## [5.6.6] — 2026-10-06

Fixes only: one failing space no longer stops the others, and four background-job defects are gone.

| Changes on upgrade | Action |
|---|---|
| `POST /api/duplicates/scan` and `/api/contradictions/scan` answer `200` with `failedSpaces` (`[]` when none) | None |
| A config reload that cannot initialise a space answers `500` naming it, after initialising the rest | None |

### Fixed

- **Spaces:** a space that fails at startup, a config reload, the embedding queue, the legacy spill sweep or a manual scan
  no longer stops the spaces after it; it is named once in the Server Log and retried.
- **Retention:** a record that cannot be deleted no longer blocks the expired records behind it (up to 500 deletions or
  2 000 attempts per collection per cycle).
- **Backups:** a scheduled backup no longer overlaps the next; the late tick is skipped and logged.
- **Shutdown:** every background job is stopped before the drain.
- **Rename:** a failed space rename names the file-system error code, not the instance's data path.

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
- **Networks:** A club created from 5.2.0 on remembers its organiser; one stored before reads as Member there.
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
| The knowledge type `memory` is now `fact`: `remember` / `update_memory` / `delete_memory` → `save_fact` / `update_fact` / `delete_fact`, `.../memories` → `.../facts` | Send `fact`; `memory` is refused, not translated |
| Webhook event `memory.created` is `fact.created`, metric `ythril_memories_total` is `ythril_facts_total`, edge label `memory.entityIds` is `fact.entityIds` | Update receivers, dashboards and label matches |
| Boot migrations rename `<space>_memories` and `memory.*` subscriptions, rewrite `recordTtlDays`, re-key edge and link ids, tombstones and embed jobs | A conflict is logged at `WARN` and left: read the first 5.0 boot log |
| `ythril_mcp_tool_calls_total` is `ythril_tool_calls_total` and gains a `door` label (`mcp` or `rest`) | Update dashboards; `door="mcp"` is the old series |
| Every MCP tool is renamed verb-first, no aliases: `query` → `filter`, `find_similar` → `similar`, `entity_cascade_preview` → `delete_entity_preview`, `wipe_space` → `delete_space_data`; the rest are listed under Changed | Re-read `tools/list`; a retired name is an error |
| `er_model`, `find_entities_by_name` and `list_chrono` fold into other tools (45 tools, was 48), and `GET .../er-model` and `.../entities/by-name` go | `space_meta` answers `actualSchema`; use `filter` with `collection: 'entities'` and `filter: { name }`, or `collection: 'chrono'` |
| An MCP client that stayed connected still holds the 4.x tool list | Reconnect it; until then its calls fail |
| Ten `GET` routes are gone: `.../spaces/:spaceId/{facts,entities,edges,chrono,files}`, `.../{facts,entities,edges,chrono}/:id`, `.../entities/by-ids` | Read with `POST /api/filter`; `PATCH`/`DELETE` on `:id`, `PATCH .../files`, `GET .../cascade-preview` and `.../files/extract` stay |
| The search family drops the space from its path: `POST /api/brain/spaces/:spaceId/{query,find-similar,recall}` → `POST /api/filter`, `/api/brain/similar`, `/api/brain/recall` | Send `space` in the body (optional: omitted searches every space the token can read) |
| `filter` answers `{ok: true, text, data}` (rows in `data.results`) and refuses with `{ok: false, error, data}`; a record that is not there is `200` with `results: []`, not `404` | Parse the one envelope; branch on `results.length` |
| `filter` `limit` defaults to 200 with no maximum; a chrono `status` is the stored value; file chunks are listed; `matchedText`, `embeddingModel` are withheld | To get what the list routes gave: `deriveStatus: true`, `filter: { parentFileId: { "$exists": false } }`, `includeDiagnostics: true` |
| `filter: {"type": "note"}` (a bare scalar) was silently dropped, so `recall` answered `200` unfiltered; it now filters on equality | Expect fewer results where you sent one |
| `POST /api/brain/recall` hits are `{score, spaceId, type, record}` like MCP; a bad key is a `400` whose `error` names it, no `unrecognized_keys` | Read `hit.record.<field>` where you read `hit.<field>` |
| In `recall(traverse: n)` each `_graph` entry carries `edges` (a list) with `direction`, in place of `edge` with `from` / `to` | Read `edges[]`; the far end is `paths[0]`'s second-to-last id |
| Recall parameters `includeFreshWrites`, `includeContent`, `charsPerToken` are renamed or removed; sending one is a `400` | Delete `includeFreshWrites` (the scan always runs) and `charsPerToken` (fixed at 3.5; send `maxChars`); `includeContent` is `includeFileContent` |
| `recall` omits empty `tags` / `properties`, and `createdAt` / `updatedAt` are opt-in | Send `includeRecordMeta: true` to get them back |
| With `includeMemories` unsaid, a `recall` walk brings the attributed (AI-originated) facts of what it reached | `includeMemories: false` brings none; `true` brings every linked fact; `graph_traverse` still defaults to `false` |
| A filtered `recall` no longer returns just-written records that do not match its `filter` or `tags` | Nothing; drop any client-side filtering of them |
| `POST /api/recall` defaults to a 50 000-character byte budget, was 25 000; MCP keeps its lower default | Send `maxChars` for a fixed ceiling |
| The link arrays `entityIds`, `memoryIds`, `chronoIds` are gone from facts, chrono and files; a body carrying one is refused, `[]` and `null` too | Send `linkEntities` / `linkFacts` / `linkChronos` with the same ids; the refusal names the field |
| A record no longer returns its links, and a `filter` predicate over an old array matches nothing | Walk them with `graph_traverse` or recall's `traverse`, or `filter` the `links` collection |
| Links convert to their own collection on every 5.0 start; `npm run links:convert` could not run on a deployed image | Nothing: a space whose conversion failed is named in the startup log and refuses link reads until restarted; the boot conversion goes in 6.0 |
| `completeLinkage` can no longer be turned off, by anyone | Nothing |
| `GET /api/brain/spaces/:spaceId/links/convert-preflight` and the `graph_link_preflight` tool are gone | Delete the calls |
| A link id naming nothing is refused with `400` before anything is stored, and so is a link class the record kind cannot hold | Send existing ids and only the classes the kind holds |
| Emptying a space is `POST /api/delete_space_data` with `{ "space", "confirm": true, "types" }` on both doors, replacing the per-collection wipe routes | Re-point the call; `confirm: true` is required |
| Space administrator is a rung you grant; the four `admin` areas no longer imply it | Grant `{ "spaceAdmin": { "floor": false, "spaces": ["work"] } }`; a boot migration grants it to every token that held all four |
| `POST /api/notify/trigger` (deprecated in 4.5) is gone | Use `POST /api/networks/:id/sync` or `POST /api/networks/peers/:peerId/sync`; an unknown network or peer is now `404`, not `200` |
| `DELETE /api/brain/spaces/:spaceId/files?path=` (metadata-only delete) is gone | Use the file delete: it removes bytes and metadata and answers `204` for an orphaned record |

### Added

- **Records:** `superseded` is a boolean on facts, entities, edges and chrono entries, accepted on create and update on
  REST and MCP. A superseded record still embeds and ranks, comes back with `superseded: true` and is badged in the UI.
- **Records:** A `supersedes` edge says which record replaced another. Resolving a contradiction marks the loser
  `superseded` (response field `markedRecord`) and draws the edge for every pair kind except two edges (`note` says why).
- **Embedding:** An attributed claim (AI-originated, `attributed: true`) is stored without a vector: `recall` never
  ranks it, but `filter`, `graph_traverse` and recall's expansion still reach it.

### Changed

- **Search:** `recall`, `filter` and `similar` take `space` as an optional body field, and as a list on both doors:
  omitted, every space the token holds `knowledge: read` in, ranked together (an unreadable one is skipped).
- **Search:** A list searches exactly those spaces, proxies expanded and deduplicated. `[]` is refused, and a named
  space you cannot reach is a `403` for the whole call, naming it. Every other tool takes one space and refuses a list.
- **Search:** A `filter` answer stays bounded without a row cap: `maxChars` / `maxBytes` trims the page (`truncated`,
  `nextSkip`), `maxTimeMS` is capped at 10 000, and on a proxy space `skip + limit` past the merge ceiling is a `400`.
- **Records:** Audit entries for fact, chrono and file updates carry the before/after link sets under `linkEntities`,
  `linkFacts` and `linkChronos`; `update_file_meta` accepts the same three on both doors and in its MCP schema.
- **Records:** A refused link write stores nothing. `save_bulk` checks edge endpoints under `strictLinkage` (linkage off
  still accepts a staged import), and the create tools advertise only the link classes their kind holds.
- **MCP:** Verb-first names, nothing else changed: `save_fact`, `save_entity`, `save_edge`, `save_link`, `save_chrono`,
  `save_space`, `save_bulk`, `update_fact`, `delete_fact`, `graph_traverse`, `graph_merge`. Recall's `traverse` body field keeps its name.
- **MCP:** Also verb-first: `space_stats`, `space_meta`, `space_reindex`, `schema_update`, `network_peers`, `network_sync`,
  `retry_embed_record`, `retry_embed_media`, `retry_embed_file`.
- **MCP:** `space_meta` / `GET /api/spaces/:id/meta` returns `actualSchema` in the declared schema's own format.
- **REST:** Every tool is `POST /api/<tool-name>`: the body is the tool's arguments (`space` included) and the answer is
  the `{ok, text, data}` envelope, `error` word-for-word what MCP returns.
- **Sync:** `POST /api/networks/:id/sync` gains `?wait=true` and `?timeoutMs`, and every sync trigger answers
  `triggered`, `completed`, `timeout` or `error` instead of a bare `{ ok: true }` (`ok` stays as the summary).
- **Sync:** New `POST /api/networks/peers/:peerId/sync` syncs one peer across every network it belongs to; the id is
  checked against the configured members and never treated as a URL.
- **Spaces:** Emptying a collection no longer writes a tombstone per record (on a networked space it opens a governed round
  and every member wipes), and wiping `entities` unlabels every face (`faceEntityId`) on both doors.
- **Tokens:** `delete_space_data` now needs `admin` on the space (as its REST route does), not instance admin.
- **Tokens:** `space` is optional on every writing tool for a token reaching exactly one space (`save_fact({fact: "…"})`
  lands); with two or more it stays required and the refusal lists them.
- **Help:** `help()` lists what MCP lacks: network governance, a file's original bytes, listing the media embedding
  queue, the per-type schema write and the rights catalogue.
- **Database:** Spaces upgraded from 4.x get the full index set on their `links` collection at boot.
- **UI:** The Brain and Files tabs read links from the `links` collection and their forms name `linkEntities` /
  `linkFacts` / `linkChronos`.
- **Docs:** New integration-guide pages `04g-links-api.md` and `04h-graph-augmented-recall.md`; a size-based docs
  refresh needs no `--force`.

### Removed

- **Records:** The link conversion no longer deletes links that existed only as link records; a space converted before
  this fix lost them (tombstones reached peers): re-create them.
- **Search:** Port a list route to `filter` with `collection`: `?name=` → `filter: { name }`, `?tags=` / `?tagsAny=` →
  `$all` / `$in`, `?after=` / `?before=` → a `createdAt` range, `?path=` → `path`, one id → `{ "_id": "…" }`, a set `$in`.
- **Search:** `?entity=<id>` is gone: filter the `links` collection or use `graph_traverse`.
- **Search:** An unsupported paging name such as `offset` is a `400` naming the parameter to use (`skip`).

### Fixed

- **Search:** `filter` finds one file by `path`, forgiving its spelling (Windows separators, leading slash); `path` plus
  `filter: { path }` is a `400`. Files only, tool and REST alike.
- **Search:** `filter` on edges returns both endpoints' display names, on files the embedding job's step progress;
  `includeDiagnostics` is applied (default false), not refused.
- **Search:** `filter` takes `tag` (case-insensitive substring), `type`, `description`, `properties`, `search`,
  `entityName` (also finds `linkEntities` records), `fromName`, `toName` on the tool and `POST /api/filter`; `filter` is optional.
- **Search:** `filter` takes `deriveStatus` on both doors (default `false`): `true` returns a chrono entry's derived
  status (`overdue` once due, unless `whenDuePasses` says otherwise); refused outside `chrono`, combinable with `status`.
- **Search:** `filter` refuses an unusable `limit` (`abc`, `-5`, `0`) with a `400`, as it does `skip`. A `Date` value in a
  filter no longer turns into `{}` and answers over the wrong set.
- **Search:** A raw MongoDB equality on a declared field (`{"type": "note"}`) is served by the vector index, not a
  full scan; `$or`, `$not`, `$exists`, `$regex` and nested filters still scan.
- **Search:** Sorting the `links` collection by `createdAt`, `updatedAt`, `from` or `to` works; it crashed (REST `500`).
- **Records:** `graph_traverse` / `POST /traverse` return every edge among the returned nodes (self-loops and parallel
  edges included) and the start node at depth 0, counted against `limit`.
- **Records:** A graph walk now reaches an edge to a fact, chrono entry or file (no `includeMemories`/`includeFiles` flag
  governs it) and may start from a fact.
- **Records:** `linkEntities`, `linkFacts`, `linkChronos`, `linkFiles` and `edges` are accepted on update of `facts`,
  `chrono` and `entities`, on both surfaces: links replace per class (`[]` detaches), edges upsert.
- **Records:** `linkEntities` and its three siblings store the link in the shape the space is read through; on a space
  created since the last restart `traverse`, graph `recall` and deletes missed it.
- **Records:** Merging two entities re-keys the absorbed entity's link records to the survivor, tombstoning the old id.
- **Schemas:** A type schema (4000 characters) and any property (2000) take a prose `description`: stored, returned by
  `space_meta` and the space listing, editable in the Schema tab, never parsed.
- **Schemas:** A property `default` follows the declared type when the type changes and is omitted when the text
  cannot be one.
- **Schemas:** A schema type can be renamed on every knowledge type, keeping its properties and position and following
  the name into every edge-endpoint list; records already written keep the old type.
- **Spaces:** `space_reembed` is now an MCP tool (also `POST /api/space_reembed`), taking `kinds` and `limit` and
  returning the counts of `POST /api/spaces/:id/reembed` (`skippedSuppressed` and `remaining` come from one snapshot).
- **Files:** `write_file` takes `encoding: "base64"` beside its UTF-8 default, for binary files. About 7 MB fits (10 MB
  JSON body cap); larger goes through `POST /api/files/{path}`.
- **Files:** Text that is not valid base64 (such as a `data:image/png;base64,…` URL) is now refused on both doors; it
  used to store a short corrupt file under a `201`.
- **Files:** A file keeps its description, tags and properties across a move and a rewrite that omits them.
- **UI:** The edge-ends picker lists the declared entity types plus any name already on the edge, so an end whose type
  was deleted can be unticked.
- **UI:** The space editor's Save no longer disappears after a "nothing to save" notice, and clearing a key (`strictLinkage`
  off, an emptied `purpose` or `usageNotes`) counts as a change and is sent.
- **UI:** The Brain page marks a chrono status as derived; a backup or export holds the stored one (overdue reads `active`).
- **MCP:** Every tool now fills `structuredContent` (was empty; HTTP `data`) with the record written or id acted on:
  delete `{"_id", "deleted"}`, `move_file` `{"from", "to"}`, `list_spaces` `{"spaces"}`, `network_peers` `{"peers"}`.
- **Server:** Upgrading no longer rewrites file records peers also hold: the boot conversion does links only; the pre-4.0
  file stamp is on `npm run links:convert` (outside a container; `-- --preview` counts, `-- <spaceId>`: one).
- **Docs:** The recall guide says `lexicalScore`, `fusedScore`, `rerankScore` are always returned and recommends the
  `ms-marco-MiniLM-L-6-v2` reranker (`bge-reranker-base` cut accuracy).

### Security

- **Search:** An operator-object filter with a `$`-prefixed key (`{"$where": {"eq": "x"}}`) reached MongoDB unsanitised;
  it now takes the sanitised path. `__proto__`, `constructor` and `prototype` filter keys are refused on both grammars.
- **Tokens:** A multi-space `recall` over MCP is authorised against every named space; it checked only the first, so a
  token could read a space its rung did not cover.
- **Tokens:** The destructive-call throttle of five wipes a minute now holds MCP callers, not only the browser.

## Earlier releases

- [4.x](changelog/CHANGELOG-4.x.md) — 6 releases
- [3.x](changelog/CHANGELOG-3.x.md) — 6 releases
- [2.x](changelog/CHANGELOG-2.x.md) — 17 releases
- [1.x](changelog/CHANGELOG-1.x.md) — 10 releases
- [0.x](changelog/CHANGELOG-0.x.md) — 18 releases
