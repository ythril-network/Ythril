# Changelog

All notable changes to Ythril are documented here. This file covers the **current major series**;
earlier majors are archived under [`changelog/`](changelog/) and linked at the bottom.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- **MCP:** `network_sync` takes `wait` and `timeoutMs`, as `POST /api/networks/:id/sync` does, and waits at most `timeoutMs` per network (default 30 seconds) instead of without limit. It still waits by default; REST still does not. Every answer says the `wait` it used.
- **MCP:** `read_file` takes `limit`, `skip`, `imagesLimit` and `imagesSkip` like `GET …/files/extract`, and adds the file's chunk and image listing to its answer when you send any of them.
- **Files:** the extract's chunk page is held to the answer budget in whole chunks, saying `chunksTruncated` and `chunksNextSkip` when cut.
- **Data:** `POST /api/admin/data/restore` answers `202` after checking the manifest and each file's first line, not every record. A broken record fails every space's act, nothing replaced (abandon it); a missing or truncated file or no secret is `400`; a file-system error is retried.

### Fixed

- **Data:** the Data page's "accepted" line for a restore or migrate is replaced by the end sentence when the act ended before its first poll, and once by "cannot finish, abandon it" when every unfinished space needs an abandon.

- **Sync:** a file delete made while the file's record could not be read is published to peers even when an earlier delete of the same path was published first, so a peer that holds the newer version of the file deletes it too; a delete published before the upgrade no longer lets the same act's leftover be published a second time.
- **Sync:** one file path whose disk cannot be looked at (a pending delete under a permission error) no longer fails the whole page of file metadata with a `503` or stops a pull at that page: its metadata is decided from the stored row and the rest of the page is stored. The settle says such a path once per window, not once per pass.
- **Files:** a bad `imagesLimit` or `imagesSkip` on `GET …/files/extract` is refused naming the parameter you sent, not `imageslimit`.
- **Files:** a file moved back to its old path, or onto a path whose earlier file was deleted, now reaches peers; a file uploaded again at a path that held another instance's deleted file reaches peers too.
- **MCP:** `read_file` on a missing file answers `404` through `POST /api/read_file`, as the extract does, not `400`.
- **Sync:** `ythril_positions_building_spaces` counts only the spaces this instance serves and reaches 0 after the 6.0 carry; it counted spaces deleted before the upgrade.
- **Sync:** a space created with the id of a space deleted before the 6.0 upgrade is ready when its create answers, instead of answering `503 positions_building` until the next minute.
- **Sync:** an edge that arrives (push, pull, import) and breaks its label's `endpoints` or `functional` rule is counted in `schemaViolations`; it is still stored, never refused.
- **Spaces:** renaming a space on Windows no longer fails, or leaves its upload folder behind, while a file under it is still open; the move waits for it for about five seconds, and reports the rename as incomplete if the file is still held.
- **Spaces:** a rename into an id whose upload folder is empty or holds only an old upload's leftovers is no longer stopped by it (it blocked every other space operation for a day); a non-empty files folder still stops it, and the answer no longer names the server's data path.
- **Spaces:** deleting a space no longer waits without limit on the search service: each collection's search indexes are given 15 seconds, and the face gallery index goes with the space.
- **Spaces:** a delete that could not drop a collection's search indexes in time now says so in the log; a create or rename under that id meanwhile answers `503` `space_still_being_removed` with `Retry-After`; send it again in a few seconds.
- **Audit:** a tool call that is refused or fails now leaves one audit row at the status it was answered, on MCP and on `POST /api/<tool>`: a refused or failed read (when the log records reads), a write refused before its space resolved, and a refused act.
- **Audit:** `POST /api/brain/recall`, `/api/brain/similar` and `…/traverse` leave one audit row per call, not two.

## [6.0.1] — 2026-10-28

**A patch for defects present in 6.0.0, two of them security (a space administrator could mint a token that writes to every space, or take over a token that may create spaces); take it before or instead of 6.0.0.**

| Changes on upgrade | Action |
|---|---|
| `config.json` gains `versionMarks`, written by the server; a space's version numbers (`seq`) can jump by up to 100,000 after a start or a restore | Nothing; keep `config.json` with your backups, and never copy `versionMarks` to another instance |
| A space administrator minting a token must name its own spaces in `rights`; a request without `rights` is refused (`403`) unless an instance administrator sends it | Send `rights` from space-administrator integrations |

### Added

- **Config:** `config.json` carries a new key, `versionMarks`, written by the server: per space, the highest version its counter may already have reached. Do not edit it and do not copy it to another instance. A version can jump by up to 100,000 after a server start or a restore.

### Changed

- **Webhooks:** The webhook admin routes are listed as instance-admin in the rights table. No user-facing effect: managing webhooks still needs instance admin with MFA.
- **Client:** the networks page's sync history panel and the advanced query's request builder are their own modules. No user-facing effect.
- **Server:** the space act runner's request, context and knob types are their own module, and the runner re-exports them. No user-facing effect.

### Fixed

- **Config:** a change saved to `config.json` (a token, a space, a network, a peer's sync position) is no longer undone when it lands while a background save of sync bookkeeping is finishing.
- **Restore and wipe:** edits after a restore onto an empty database, a `docker compose down -v` that kept `config.json`, or an import onto an emptied space are no longer lost on peers. Losing `config.json` with the database, or a crash just before, can still lose them.
- **Migrate:** a migrate whose copy is retried keeps one backup, the one its report names, instead of one full dump per attempt, and a backup that fails part-way no longer leaves its directory behind. Offsite copies of earlier attempts stay until the offsite retention prunes them.
- **Migrate:** a completion write that fails (a full disk) no longer leaves every space refusing writes after you abandon the migrate; writes close only once the new URI is saved.
- **Data page:** the migrate block and the maintenance pill now show how a migrate ended, or that the instance stopped to switch database, instead of keeping "Migration accepted: N spaces are being copied" and the last copy count.

### Security

- **Tokens:** a space administrator can no longer mint a token that writes to every space by leaving `rights` out of `POST /api/tokens`, and can no longer rename, regenerate or revoke a token that holds `createSpaces` or `instanceAdmin`.

## [6.0.0] — 2026-10-27

**6.0 turns proxy spaces into personal views, pages sync by landing position (5.x and 6.0 peers do not sync; upgrade every instance of a network together) and keeps both edits of every record kind; a failing store answers a retryable `503`.**

| Changes on upgrade | Action |
|---|---|
| **Breaking:** a proxy space is now a personal view of one token, id `@<name>`; the upgrade makes one for each live instance-admin token, or keeps an unclaimed definition when none is live | Claim unclaimed views; recreate each integrator proxy as its own view |
| **Breaking:** sync pages by landing position (`afterPos` or `cursor` in, `positions: 1` in answers); `sinceSeq` and 5.x cursors answer `400`; a 5.x peer is refused ("Version too old") | Upgrade every instance of a network together |
| Fixed here only, no 5.6 patch: a server failure showed the runtime's text or data path, an unreadable folder read as a refusal, a restore or migrate was one act over every space, a search missed a moved file under its new name | Upgrade from 5.6.x |
| Fixed here only, no 5.6 patch: German and Polish named record kinds inconsistently, counts ignored plural forms, refusals read in English; a webhook subscription that went `failing` stayed so | Upgrade; on 5.6 re-enable a failing subscription by hand |
| The old proxy id leaves `spaces`, every network (peers see this member leave) and every token's rights, and answers `410` `space_retired` on every door; creating, renaming or joining under it is `409` | An instance admin purges it (`POST /api/admin/views/retired/:id/purge`) |
| The upgrade writes `config.json.pre-6.0` only when it converts proxies; 5.x does not read views, and views live in `config.json`, not in database backups | Restore the copy to undo a conversion; back up `config.json` |
| A webhook subscription that named only retired ids is disabled, not emptied | Subscribe to the member spaces |
| `targetSpace` is refused by name on every write door (both REST spellings, MCP), as is `proxyFor` on `POST /api/spaces` and `save_space` | Send `space`; make a view with `POST /api/views` or `view_create` |
| New REST and MCP doors: `/api/views` (list, read, create, rename, delete, copy) and `view_list`, `view_get`, `view_create`, `view_update`, `view_delete`, `view_copy` | A view id in a URL is percent-encoded (`%40team`) |
| New admin doors `/api/admin/views/{orphans,claim,retired/:id/purge,migration}` and their `view_*` tools; `GET /api/spaces` lists `retiredSpaceIds` to admins | Read the migration report after upgrading |
| A read door takes your view as `space`, reads each member you can read at that moment and names them in `viewMembers`; a view never writes; 50 views per owner, 1 000 members | Name a member space to write |
| A write or config door given a view id, and any door given a missing space in its body, answers `404 Space '<id>' not found`; network create, fork, add-space were `400`; `graph_merge`, merge, `reindex`, `reembed` refuse before any work | Name a member space; branch on `404` |
| Revoking a token deletes its owner's views at once; a connector rotation keeps them; a sweep ends the views of an owner with no live token for 30 days (OIDC owners' views are kept) | Copy a view first (`view_copy`) to keep it |
| A read through a view is one audit row with `spaceId: null` and `spaces`; `view.*` and `space.retired_id.purge` rows carry the owner key and member count, never a name | Query by `operation`, not `spaceId` |
| New metrics `ythril_views_total`, `ythril_views_deleted_total{reason}` and `ythril_retired_space_ids` | Alert on `ythril_retired_space_ids > 0` until each id is purged |
| A store failure (a timeout, a full or closed pool, a paused store; REST, sync, MCP) answers `503` with `Retry-After` and `retryable: true`, was `500`/`400`/`404`/`409`/`422` | Branch on `retryable`; retry on `503` |
| An unmeetable write concern answers `500` with `retryable: false`, was `503`; other non-store failures answer `{"error":"Internal server error"}` | Do not retry on `retryable: false`; update body matchers |
| Options in `MONGO_URI` win; `connectTimeoutMS` and `serverSelectionTimeoutMS` default to 10 s, `heartbeatFrequencyMS` to 5 s | Check the options your string carries |
| `DELETE /api/files/:spaceId`, `POST /api/delete_file` and `delete_file` answer `404` to a repeated delete of a flagged file or derived record (chunk, face), writing nothing; a store failure: `503` | A retry's `404` may mean the first delete completed |
| A path with neither bytes nor metadata, a move with a missing source and a path through a regular file (`a.txt/x`) answer `404` on REST and MCP (were MCP `400`, REST `500`) | Handle `404` on both doors |
| A path a regular file blocks (move, `mkdir`, upload, `write_file`; a directory into itself) is `409` `path_blocked`, was REST `500`, MCP `400` | Branch on `code` |
| A move onto a file, folder or file record is `409` `destination_exists` and changes nothing, was a `200` replace (upload, restore and `keep-incoming` still replace) | Delete the destination first (deleted on every replica) |
| `keep-both` (`rename`) and `save-to-space` onto a file, folder or record are `409` `destination_exists`, were a `200` replace; `save-to-space` needs `files: write` there | Choose another name or space |
| A directory delete needs `confirm: true` (`422` `confirm_required`; space root `400`), on MCP too; a `files: write` token can delete a tree; one `file.deleted` per file removed (was none) | Send `confirm`; review `files: write` tokens |
| A file act whose file-system call fails is `500` `file_system_fault` with `retryable: false` on every door, `write_file`, upload and chunked upload included (was `400` with the data path on `write_file`, a bare `500` on upload) | Update body matchers |
| A name that fits a path component but whose temporary name does not is `file_system_fault`, never `path_blocked` about your path | Shorten the name if it recurs |
| A delete the storage refuses is `500` `file_system_fault` (an unreadable path was `404`); REST's other delete failure is `500` `Failed to delete`, was `… file` / `… directory` | Update body matchers |
| An error in the server's code (`TypeError`, a thrown non-Error) is `500` `Internal server error`, `code: "internal"`, `retryable: false` on `POST /api/<tool>`, MCP and the read routes (was `400`); a socket failure is `502` | Branch on status and `code` |
| A `RangeError` the runtime raises on the upload, delete, move, `mkdir` and conflict-resolve routes is `500`, was `400`; our own path, encoding and chunk refusals stay `400` | A sync sender no longer drops a file for a server fault |
| An unreadable stored file is `500` in our words on REST as on the tool doors; a synchronous sync trigger's and the join's failure bodies no longer carry the exception's text | Update body matchers |
| A bulk conflict resolution's failed item for an error in our code is `code: "internal"`, was `file_system_fault` | Update body matchers |
| A bulk write (`save_bulk`, `POST /api/brain/spaces/:id/bulk`) with an item that is not an object (`null`, a number, a string, an array) is `400` naming the item, writing nothing; was a `500` or a silent `200` | Send objects; fix the named item |
| `GET /api/admin/data/browse-dirs` answers `404` for a gone directory, `403` for one the server may not read, `500` otherwise, in our words (was `400` with the runtime's sentence) | Update body matchers |
| New counter `ythril_tool_failures_total{door,tool,class}`: tool calls answered by the caught-failure classifier, `class` from a fixed set | Alert on a rising `internal` or `file_system` |
| A partly finished move is `503` `move_still_owed` with `Retry-After`; an act whose deletion cannot be recorded is `500` `act_not_recorded` | Retry (a `404` can mean it finished); repeat a move an older version stranded |
| A move another file's records hold back is `409` `destination_held_after_move` (`path`, `heldBy`); one whose sidecar target was taken finishes without it (was `503`) | Delete `heldBy`, repeat; reprocess the file |
| The sweep removes what earlier releases left behind deleted files, irreversibly | Watch `ythril_leaked_rows_removed_total` |
| `POST /api/admin/reload-config` answers `500` naming spaces that failed to initialise, or `503` with `Retry-After` when the database was down, was success | The next reload retries them |
| `npm run links:convert` exits non-zero when a space could not be converted; the rest still convert | Check the exit code in upgrade scripts |
| A background job's failure is logged as `<job> failed for space '<id>' (<part>): <reason> — retried <when>` or `<job> stopped: the store is not answering …` | Update log matchers |
| One entity merge relinks at most 2500 records: a larger one answers `422` `code: "merge_too_large"` and writes nothing; a merge a `strict` space refuses answers `400`, was `500` | Split the merge or delete records first |
| A bulk fact or chrono item carrying the `id` of an existing record counts in `updated`, not `inserted` (new records only); `bulk.write` fires for a batch that only converged | Read `updated` as well as `inserted` |
| A pushed fact over 50 000 characters is refused on the sync door, and `batch-upsert` allows a fact at most 10 forks | Older peers pushing these are refused; upgrade both ends |
| A pulled page is validated and decided as a push is, and a sender pushes targets first (facts, entities, chrono, file metadata, edges, links) | Upgrade both ends: an older sender may trigger link violations an older receiver does not record |
| A record arriving by push, pull or import without an expiry gets this space's retention window, counted from its creation; an older one is due at once and the sweep deletes it | Check the retention windows before syncing old data |
| The Merkle root no longer hashes `spaceId`, instance-local files (conversion sidecars too) or soft-deleted file rows; equal data now matches | Mixed-version `merkle: true` networks log `MERKLE_DIVERGENCE` until all upgrade |
| A file a peer pushes or this instance pulls fires no `file.created` webhook and no live-view event (a push did, with the peer's token) | List files instead of waiting for `file.created` |
| Converted and extracted files (`_converted/`, `_extracted/`) no longer travel; each instance converts by its own settings, an offer answers `200 {"ignored":"instance-local"}` | Peers' sidecars are retired on upgrade |
| A document or media file a peer pushes or this instance pulls is converted by this instance's pipeline, external assist included where consented | Expect conversion load and consented external-model traffic |
| A removed description, source, property, tag or suppression mark reaches a peer only when both run this release; one made while a peer ran older reaches it on the file's next edit | Upgrade both ends; edit the file to resend |
| A soft-deleted file's row stays local (never pushed, served or hashed) and the deletion travels as the file tombstone, applied by the receiver's own `softDeleteFileMeta`; an older sender still pushes the row, stripped of its flag | Upgrade senders |
| A file's processing status, or a move of another instance's file, no longer changes its `updatedAt`; one that drifted converges after a `MERKLE_DIVERGENCE` re-reads that peer's files | Without `merkle: true` it clears at its next edit |
| A soft-deleted file's record answers `404` on the by-path read, the extract and `PATCH`, `update_file_meta` refuses it as a missing path, and leaves stats, search, graph and link targets; `filter` still returns it | Filter on `deletedAt` to find deleted files |
| A file row whose `updatedAt` is not an ISO instant under 40 characters is refused on the sync doors (`400` on push) | Send ISO timestamps |
| `ythril_reindex_in_progress` is the number of spaces with a run going, was 0 or 1; a second reindex of a space with a run going answers `409` | Change an alert `== 1` to `> 0` |
| `POST /api/brain/similar` answers in the `similar` tool's shape: hits `{score, spaceId, type, record}`, `source` `{type, id, summary}`; `topK` above 100 is `400` | Read `hit.record.<field>` and `source.id` |
| `recall` or `similar` without `space` (or `similar` with `crossSpace: true`) search only spaces where the token holds the tool's area; a `files: read` token no longer ranks records | Grant the area on the spaces to search |
| `POST /api/brain/spaces/:spaceId/traverse` answers `400` for what it clamped (`maxDepth` outside 1-10, `limit` outside 1-1000, a bad `direction`, `edgeLabels` or blank `startId`); a bulk array over 500 items is `400` (was `207`) | Send values in range |
| `400` past: `tags`, `deleteFields`, `edgeLabels`, `folders` 100; `linkEntities`/`linkFacts`/`linkChronos`, id lists (`spaces`, view `members`, `ids`) 1 000; inline `edges` 500; bulk-resolve `ids` 2 000; notify `data` 8 KiB; `types`/`kinds`/`events` beyond their set | Stay within them |
| An `ingest` conversation over 1 000 sessions or 20 000 turns, an upload whose JSON `tags` is not an array, `network_sync_history` `limit` outside 1-100 and an embed-queue `limit` over 200 answer `400` | Send values in range |
| A fifth concurrent `ingest` run answers `429`; each live-event stream kind admits 200 connections (then `503` with `Retry-After`) and drops a reader 256 KiB behind | Retry later; read events promptly |
| `POST /api/<tool>` carries the answer once: `data` holds it and `text` is one fixed sentence (still the answer when a tool has no structured result) | Parse `data`, not `text` |
| MCP `content` and `structuredContent` are each held to half the stated budget; `read_file` is budgeted and paged by `markdownSkip` with `truncated` and `markdownNextSkip` | Follow `nextSkip` / `markdownNextSkip` |
| Every list that stopped at a number says so and pages whole rows to the end on both doors (`count`, `total`, `limit`, `skip`, `truncated`, `nextSkip`); a non-numeric `limit` or `skip` is refused | Page until `truncated` is absent |
| A type-schema write sending a changed definition beside a `$ref` answers `400` naming the field, was stored inline | Change the library entry or drop `$ref` |
| The admin import refuses a document whose `seq` is not a non-negative integer below the ingest ceiling and lists each in `refused` | Check `refused` after an import |
| `POST /api/duplicates/scan` and `POST /api/contradictions/scan` answer `200` with `scannedSpaces` beside `failedSpaces` (`[{ spaceId, reason }]`); a dead store is `503` | Read `scannedSpaces` |
| On a pub/sub network or a tree, a deletion from your direct publisher or parent now deletes the records it delivered to you, whoever wrote them (its retention sweep's too), never records you wrote | A compromised publisher can delete what it relayed |
| In its first sync each space stamps each record once with its delivering peer, then re-reads every upstream's tombstones; a deletion the upstream already pruned is not recovered | Upgrade root-first; watch `ythril_sync_tombstone_rereads_owed` reach `0` |
| File tombstones carry `issuer` and `rowSeq`, apply only under the deletion rule and only to the version they name; `POST /api/sync/file-tombstones` takes pages and answers `{ applied, refused?, declined? }` | Send pages; read `declined` |
| `GET /api/sync/file-tombstones` takes `cursor` and answers `nextCursor`; without `cursor` it answers as before, cut at its fixed ceiling | Page with `cursor` to read past the ceiling |
| `POST /api/sync/tombstones` answers `declined`; a peer's upload of a file this instance deleted answers `200 { tombstoned: true }`; batch `filemeta` gains `tombstoned` | Read a missing counter as zero |
| A rollback leaves `deliveredBy` on stored records: an older build hashes and serves it; a `merkle: true` network logs divergences and an older peer refuses those file records | Expect the warnings until the upgrade is redone |
| A refused inline `edges` entry stores nothing (a bulk item with one is refused whole), answering `schema_violation`: REST `400` on create, `422` on update (was `500`); MCP a structured `422` (was `400`); `strictLinkage` refuses a missing far end of any kind | Branch on `schema_violation` |
| `POST .../edges`, `save_edge` and a bulk top-level edge refuse a missing end as `schema_violation` (REST `400`, MCP structured `422`; was `{ "error" }` / plain `400`) | Match on `schema_violation` |
| A write that stored its record and failed on its connections answers the cause's status with `retryable: false`, no `Retry-After` and `written: { kind, id, edges }` (was a retryable `503`); a bulk row carries `written` | Send the missing edges to `written.id` |
| Each edges collection gains a unique index (background pass; a restore rebuilds it) | Races refused once the pass has run |
| A second edge to the same `to` of another kind under a `functional` label is refused; `validate-schema` adds `staleGuards`; a relabel onto a held identity answers `409 edge_identity_taken`, was `500` | Read `staleGuards`; handle `409` |
| A webhook or live-view `entry` no longer carries instance-local fields (`_expireAt`, `_contentExpireAt`, `syncBase`, `deliveredBy`, `matchedText`) | Fetch the record if you read them |
| A cast on a round past its deadline answers `409` `round_expired` naming it (it was taken) and the round is never listed as open | Handle `409`; read rounds on `/votes` |
| The first minute after upgrade concludes every round already past its deadline, and a failed join's orphaned peer credentials are revoked, which cannot be undone | Read the upgrade notes before upgrading a network with old rounds |
| A `strict` space refuses a write that adds a property key its type does not declare (a type with any property is a closed list); `warn` returns it, `off` ignores it; stored keys are never refused | Find them with `validate-schema` |
| A schema refusal's `truncated` is a count (was `true`); a refused merge answers the standard refusal body, still `400`; an invalid body answers `{ "error", "issues" }` without received values | Match `issues[].code` |
| `validate-schema` pages by `nextAfter` and stops at a full page (`skip`, `count`, `total`, `nextSkip`, `totalViolations` gone; `truncated` = size budget cut); a value needs `knowledge: read`; MCP `save_edge` answers `warnings` | Page by `nextAfter` |
| `meta.rules` and a type's rules need `schema: admin` (single-type `PUT`, and a `validate-schema` proposing rules: `403`); `meta.stampSkew` is accepted (was `400`); a library entry cannot change kind while used (`409`) | Grant admin to tokens that edit rules |
| A member on 5.6.x refuses a schema carrying `rules` or `stampSkew` whole; a write setting one warns, naming them | Upgrade every instance of a network first |
| **MCP:** a top-level argument a brain write does not take is stored with a warning, not refused; Refuse refuses it, and an unread option or a server-written key sent back (`400`) | Read `warnings`; send only what you change |
| New per-space, per-instance setting `unknownWriteFields` (`warn` or `refuse`; `PATCH /api/spaces/:id`, `update_space`, Schema tab "This instance"); never shared with a network; read back as `refuse` only | Set `refuse` only on the instances that want it |
| A refused brain write names its unknown fields in `warnings`, without values; so does a stored record whose connections failed; `bulk.write` `errorCount` counts them | Read `warnings`; do not alarm on `errorCount` alone |
| Chrono `PATCH {superseded: true}` is accepted (was `400`); an empty PATCH names the accepted fields; a link field a record cannot hold (`linkFiles` anywhere) is an unknown field: Warn stores without it (a bulk item's was refused) | Read `warnings` |
| Sync votes, members and change-notes answer `403` to a user token, an unlisted or other-network peer, or for a network not held (was `404`) | Read votes at `/api/networks/:id/votes` |
| Add-space's `202` carries `round` as the vote list shows it (no `pendingMeta`); other opening doors gain `round` | Read proposals on the space |
| `DELETE /api/spaces/:id` and the admin wipe answer `200` (was `202`) when this instance's own yes passes the round and the change ran | Branch on `status`, not `202` |
| `202` `status: "passed"`, `queued: true` while the change runs; `500` `space_act_failed` (`503` for a store outage) if it failed in the call; a networked delete and any admin wipe need `{ "confirm": true }`, else `400` | Send `confirm`; do not retry a passed `500` or `503` |
| A write into a space being deleted, wiped, renamed, restored or migrated is `409` `space_being_<that>`; after a networked wipe each member re-reads the space once | Read an unknown `space_being_*` as busy |
| A restore answers `202` and restores each space after it; `GET /api/admin/data/restore` reports it and its index results, `POST …/restore/abandon` releases it | Poll until `state` is not `running` |
| A restore empties spaces the backup lacks; refuses a backup not whole or naming an unserved space (unless in `leaveOut`); audit log, queues, file bytes stay | Name gone spaces in `leaveOut` |
| A migrate copies online, answers `202` (`GET …/migrate` reports), refuses writes once done, then exits; `…/abandon` ends a stuck one; `409` `INFRA_MANAGED`, `target_not_empty` | Drop the old database once checked |
| While either stands the instance is in maintenance (an instance admin passes on every path; the web client loads for anyone; `{ active, manual, heldBy }`) and a backup is `409` | Read `heldBy` |
| Audit `data.restore` and `data.migrate` are now `….requested`; a set's end is a row of its own | Update audit queries |
| A 5.x build never finishes a `restore` or `migrate` act | Let them end before rolling back |
| A contradiction resolve against the standing choice is `409` `resolvedOtherwise` (was `200`, overwriting); answers carry `notes`; dismissing a resolved one is `409` `alreadyResolved` | Branch on `code`; re-read it |
| An unclosed resolve shows as `resolving`; after 10 minutes another choice takes it over, undoing what it recorded | Finish with the same choice, or dismiss |
| A `filter` or `recall` predicate on a withheld field (`embedding`, `deliveredBy`, the write guard) other than `$exists` is `400` | Use `$exists` only |
| A projection of withheld fields only (`{embedding: 1}`) answers `{_id}`, was every field | Project the fields you read |
| The first 6.0 start carries each space into position space once, in the background (every document is rewritten, the vector index re-reads it); its sync doors answer `503` `positions_building` meanwhile, held, no failure counted | Expect the cost; watch `ythril_positions_building_spaces` |
| A rollback to 5.6 runs `node server/dist/tools/positions-rollback.js` first, with 6.0 stopped (`docker compose run --rm --no-deps ythril …`); a re-upgrade repairs what 5.6 changed | Run it before 5.6 starts, or `merkle: true` networks log divergence |
| Entities, edges and chrono fork as facts do; a fork's id derives from its parent, the version it forked at (`forkAt`) and its body; text-derived fact fork ids still count | Upgrade every member together |
| Each space's edge identity index is rebuilt over non-fork rows in the background; a page carrying a fork edge answers `503` `edge_identity_building` meanwhile, the edges family held | Watch `ythril_edge_identity_building_spaces` |
| `resolve_fork` and `POST …/forks/:forkId/resolve` require `kind`, `forkId`, `keep`, `ifMatchSeq` and `ifMatchParentSeq` (`0` only for a fork whose parent is gone) | Send all five from the list row |
| Deleting a record deletes its forks; an update, relabel, save by id or merge naming a fork is `409` `fork_row_read_only`; the space hash omits a derived field's name at the top level only | Resolve or delete the fork |
| A rollback to 5.6 refuses while entity, edge or chrono forks are stored, and `--discard-unresolved-forks` deletes them | Resolve them in Review first |
| Records 5.6 shadowed stay missing; `POST /api/networks/:id/reread` and `network_reread` (admin, MFA on REST) re-read a network from every member, one space per cycle; records peers deleted and forgot can return | Run it where records are missing |

### Added

- **Sync:** `file_stamp_report` (admin; REST and MCP) lists files a 4.0–5.5 version likely stamped with its own author, from each peer's file feed. It repairs nothing: [Spaces API](docs/integration-guide/06-spaces-api.md).
- **Sync:** Arrivals (push, pull, import) the local schema does not accept are stored, never refused, and counted by name (`schemaViolations`).
- **Sync:** Pages carry `through` and `head`; a pull stopped at the cycle cap is `partial` (`refused` is a new `ythril_sync_cycles_total` status); the admin network view adds `rereadOwed` and `spaceRecordCounts`; new `ythril_position_clock_unusable`.
- **Networks:** New `GET /api/networks/:id/vote-outcomes` and MCP `network_vote_outcomes` list how rounds ended (passed, vetoed, expired), the newest 50 kept locally; a vote shows when it opened and what it changes.
- **Schemas:** `rules` on a type and the space: CEL with a message, saved only if this instance runs them, refused in `strict`, returned in `warn` ([Schema API](docs/integration-guide/06a-schema-api.md#rules)); `invalidRules` names any that stopped compiling.
- **Schemas:** `schema_validate` (MCP) and `validate-schema` check a sample record or the stored data; `space_schema_layers` answers `fields` (`own`, `effective`, `winner`, `hidden`), `unknownFields`, `refusedRounds`.
- **Schemas:** A write reaching several networks answers `layers`; unknown meta keys in a layer or round are named, not refused; a round carries only its changes, applied whole.
- **Server:** New `ythril_schema_refusals_total`, `ythril_schema_rules_invalid`, `ythril_schema_rule_engine_available`, `ythril_schema_violations_recorded_total`, `ythril_webhook_retry_ticks_cut_total`: labels in the Setup API.
- **UI:** The Schema tab gains a Rules editor and **Validate**; record forms mark undeclared keys.
- **MCP:** `save_entity`, `save_chrono` and `save_edge` take `waitForEmbedding`, as REST does.
- **Writes:** `seq` is a record's version: an edit stores a higher one only if its read version is current; over the ceiling `409` `record_version_at_ceiling`, clock before 2005 `503` `positions_clock_unusable`. Every list defaults to landing order.
- **Brain:** Review lists and settles forks: `GET /api/brain/spaces/:id/forks`, `POST …/forks/:forkId/resolve`, MCP `list_forks`, `resolve_fork`, every kind. Keeping a side writes its body onto the parent above both versions, deletes this instance's copy and repoints its edges and links.
- **Brain:** A fork another instance resolved, whose removal this instance's deletion rules decline, stays in Review marked `resolvedElsewhere` for this instance to decide.
- **Brain:** Keeping a version in Review is refused `422` in the schema's own words when a `strict` space's schema refuses its body, and nothing is written; a fork row in the Facts, Entities, Edges and Chrono lists carries a "Fork in Review" marker that opens Review > Forks.
- **Brain:** An entity merge points what named an absorbed entity's fork at its new id, counted in the merge bound; `ythril_unresolved_forks` counts unresolved versions by kind, and the `MERKLE_DIVERGENCE` line says how many await a decision.

### Changed

- **Errors:** The store-failure `503` carries the store's `code`, `codeName` and one retry sentence on REST (writes included), `POST /api/<tool>` and MCP; recall, similar and traverse send `Retry-After` too.
- **Errors:** An unmeetable write concern (`w` above `1` on a standalone) carries `code` and `codeName` and may have applied its write: read before repeating; a sync receiver stops the page. Pool checkouts time out only where `MONGO_URI` has `waitQueueTimeoutMS`.
- **Database:** New `YTHRIL_WRITE_TIMEOUT_MS` (default 30 s per write) and `YTHRIL_HOLD_DEADLINE_MS` (45 s per hold); both refuse `0`. A `MONGO_URI` `timeoutMS` does not apply to them; boot warns once on a `socketTimeoutMS` below the write bound.
- **Database:** Boot logs one INFO line, `MongoDB client options: …`, a changed string takes a restart. An operation in flight when the database stops answering ends with a retryable `503` (`0`: no bound; `loadBalanced`: selection only). The compose healthcheck waits out the first boot.
- **Database:** The first connection retries more kinds of "not up yet"; bad credentials fail at once. A late `mongot` is picked up by a retry; a waiting space stays `building` (`indexWaiting`, `indexWaitingSince` on `GET /api/spaces`).
- **Database:** `indexStatus: "failed"` now means only a build that failed or timed out; an alert on it stops firing on a late service. `INDEX_READY_TIMEOUT_MS` starts when indexes are confirmed. `GET /ready` shares one probe.
- **Database:** A collection's vector index exists only while it holds a record: dropped `SEARCH_INDEX_DROP_DELAY_MS` (`60000`) after its last goes, and at boot for empty ones; search answers empty (`empty: true` in `pipeline-status`).
- **Server:** `space.reload_added` is written after initialisation with its real status. A refused manual reload moves `ythril_config_reload_failed_total` and holds `ythril_config_reload_pending`; a successful reload clears the gauge.
- **Server:** A `links:convert` failure prints `<id>: FAILED (<reason>) | not converted, not marked | file seqs NOT stamped`; the boot summary *"Link conversion FAILED for N space(s)…"* names hung, not-reached and skipped spaces.
- **Server:** A failure is said once per step, space and part in a window; the old per-step lines (*"Candidate prune"*, *"Tombstone prune"*, …) are gone.
- **Server:** New `ythril_housekeeping_space_failures_total`, `ythril_housekeeping_records_failed_total`, `ythril_interval_tick_skipped_total`, `ythril_unknown_write_fields_total` and gauge `ythril_housekeeping_quarantined_spaces` (labels: [Setup API](docs/integration-guide/11-setup-api.md)).
- **Housekeeping:** A repeating job still running skips its next tick; an error escaping a tick logs `<job> failed:`. The retention sweep removes up to 500 records per collection per 5 minutes and keeps this instance's expiry over a peer's update.
- **Records:** Automerge leaves a `merge_too_large` pair open. A conflict plan is `422` on `POST /api/graph_merge`, `409` on the REST merge route.
- **Records:** A merge relinks a hub in one transaction of few bulk writes. An entity delete with `cascadeToken` removes edges 500 per transaction with their tombstones, one `edge.deleted` webhook per edge after its chunk commits.
- **Records:** A bulk write reads a batch once and writes one block per kind; items still see earlier items. An item on an unwritten one names that refusal; a `$ref` key used twice refuses the batch.
- **Records:** A converge that loses a race is decided again against the current record; losing twice is `409` on a create door and an item error in a batch. `save_bulk` declares the `id` of fact and chrono items.
- **Sync:** (breaking) `sinceSeq` answers `400`; riders, the grouped tombstone answer and the import's `counterBehind` are gone; `ythril_seq_horizon_oldest_hold_seconds` is now `ythril_record_position_oldest_hold_seconds`. A mesh push sends only tombstones issued here.
- **Sync:** A fork's id derives from the parent's id, the version it forked at and its whole body. Documents past the 500-per-family cap and records the store refuses count in `rejected`; an older receiver accepts an eleventh fork.
- **Sync:** A link under another id for linked endpoints is `skipped`. A space's Merkle root is not re-read when nothing changed: `GET /api/sync/merkle` and `merkle: true` cycles are far cheaper; root date: `computedAt`.
- **Sync:** Each space gets a `(pos, _id)` index per record collection, built in the background on first start (paging stays tie-safe, slower). Each record stores its delivering peer (`deliveredBy`: local, never sent or shown).
- **Sync:** New `ythril_sync_tombstones_applied_total`, `ythril_sync_tombstones_declined_total` and gauge `ythril_sync_tombstone_rereads_owed`. New `ythril_sync_file_arrivals_total{door,outcome}` counts file arrivals.
- **Sync:** A subscriber that left a pub/sub space gets `423` `space_declined` once; the publisher stops sending it; sync history lists it `declined`, not held. A tombstone of a type the receiver does not know still answers `400`; the sender resends once upgraded.
- **Embedding:** The bundled model runs in a supervised child process: embedding cannot block the server, nor a native fault take it down; it exits after 10 idle minutes.
- **Embedding:** `mem_limit` or a pod memory limit counts both processes. The child holds no secrets. A lost process is replaced after a growing delay; a record killing it three times is `failed`, the crash in its `lastError`.
- **Embedding:** New `ythril_embed_wait_seconds`, `ythril_embed_process_restarts_total`, `ythril_embed_process_state`; `GET /api/admin/pipeline-status` gains `inference` and `state: "down"` on a sticky load failure.
- **Embedding:** A recall query is embedded ahead of queued documents; `embedConcurrency` keeps its defaults (2 bundled, 8 external). A model that cannot load stays failed until it, an offline flag or the process restarts.
- **Embedding:** `POST /api/brain/spaces/:id/reindex` and `space_reindex` record a run and return; it survives a restart. `GET .../reindex-status` and `space_meta` carry `reindexRun: { running, remaining, failed }`: poll until `running` is `false`; recall refuses until every record is rebuilt.
- **Search:** `filter`'s `limit` stays uncapped: a single-space read stops at twice the answer budget and answers `truncated` with `nextSkip`. `recall` and `similar` with `traverse > 0` walk up to 16 result rows together.
- **Search:** Fused results carry `vectorRank` and `lexicalRank` beside `fusedScore`. An answer the size budget cuts carries `budgetBoundBy`.
- **MCP:** `recall`, `similar`, `filter` and `read_spill` take their size parameters from one schema: MCP accepts any `maxBytes` and raises a `maxChars` under 1000 to it. `list_embed_jobs` takes `skip` and returns `transientFailures`.
- **MCP:** Tool calls cache one validator per token reach (64 kept), counted in `ythril_tool_validator_cache_total{result="hit|miss|evict"}`. Delete tools and `move_file` say which peers a deletion reaches.
- **Schemas:** A schema-library type reads as `{ "$ref": "library:<name>", ...definition }` on `GET /api/spaces/:id/meta` and `space_meta`; `resolve=false` returns the stored `{ $ref }` alone.
- **Spaces:** `GET /api/spaces/:id/meta` and `space_meta` keep `stats` and `actualSchema` per space until its records next change. The admin wipe of a space in no network answers `status: "wiped"` beside `deleted`.
- **Spaces:** Deleting or wiping a space shows its outcome and owed retry in the Danger tab, owed changes show on Networks and the Spaces list, and the confirmation says whether it acts at once or opens a vote.
- **Networks:** A closed or democratic network connects every member to a newcomer; entries others propose wait for **Accept** (REST, or MCP `network_introduction_accept`), listed as `introductions`.
- **Networks:** A club is a mesh: members pair directly via `POST /api/sync/networks/:id/pair` and `/pair/confirm`. A deletion or wipe a vote passes is applied as a completed act: retried on failure, the space write-closed and its peer exchange held until done.
- **Networks:** A deletion or wipe the proposer's own yes passes (a club or pub/sub network, or a sole member) is applied at once, answering `200`.
- **Files:** A file's extract returns its converted Markdown whole or in whole paragraphs paging to the end (was cut at 256K characters); its image list says when cut. `GET …/files/extract` takes `read_file`'s budget parameters.
- **Files:** A chunked upload's `202` carries `maxBodyBytes`; a chunk may send `x-expected-sha256` (`422` on a mismatch). A push above a peer's single-body limit goes chunked (was `413`).
- **Files:** A delete tombstones the links this instance wrote from the file and its derived ids, not others'. `read_file` and the extract hold only their window. An unknown extension is `skipped`; a twin with a job in progress is left alone.
<!-- file-act-codes -->
- **Files:** Every refused or failed file act carries one `code`: `path_blocked`, `destination_exists`, `destination_held_after_move`, `confirm_required`, `space_root_refused`, `move_still_owed`, `act_not_recorded`, `file_system_fault`, `space_retired`.
- **Import/Export:** The admin export omits this instance's own state; the import never keeps the replaced copy's stamps or sync base.
- **Import/Export:** The import drops file chunks, face records, byte-describing file keys and a restored file's old `embedding`, and names records restored over a local deletion in `restoredOverTombstone`.
- **UI:** **Settings → Preferences** has a **Date and time** card (**Automatic**, **ISO 8601** or **Day.month.year, 24-hour**; **local time** or **UTC**), kept in this browser.
- **UI:** The Files page says why a rename, delete or new folder was refused; a remedy stays until dismissed and a server fault shows its request id. Sentences name each record kind by its tab (Räume → Spaces, Akta → Pliki).
- **UI:** Settings → Spaces shows a space waiting for search as "Waiting for search service". The Graph view reads every page of `graph_traverse` and says when the walk stopped at its `limit`.
- **Docs:** The hosting guide names `YTHRIL_MONGO_MEM_LIMIT` (default `4g`). Help gains a testing guide. The integration guide's tool tables come from code; an edge's `type` is free text.
- **Backup:** A restore reports, per space, files no longer matching their records (the page, `GET /api/admin/data/restore`, the log), and repairs nothing ([guide](docs/integration-guide/12a-data-management-api.md)).
- **Webhooks:** `ythril_webhook_first_deliveries_lost_total` gains `reason` (`not_stored`, `not_known_stored`), counting every retry-row write; alert on `not_stored`. New `ythril_webhook_probes_total{outcome}`, `ythril_webhooks_failing`; answers carry `nextProbeAt`, `probeAttempts`.

### Fixed

- **Errors:** A write the store could not finish answers `503 retryable`; a timed-out transaction leaves no document locked.
- **Contradictions:** The structured scan found no fact or entity property conflict: the seed had no claims (since July 2026).
- **Sync:** A relay forwards what it pulled; a tombstone-only cycle moves the marks; a relayed tombstone reaches every hop before it is pruned.
- **Sync:** A chrono `type` outside the space's vocabulary is still stored on pull (a push answers `unknownType`). A pull that finds one version under different text forks as a push does.
- **Sync:** Strict-linkage violations are recorded for every landed edge and link, on every door, once per dangling end after a pull or push is whole. A push no longer waits for it; a part-way pull checks what landed.
- **Sync:** A file deletion reaches every peer once: its tombstone is sent once per path once the file is gone, never pruned unsent, and survives a wipe or a peer that sent the bytes first.
- **Sync:** A stalled write cannot stop replication (the write bound ends it): gauge `ythril_record_position_oldest_hold_seconds`, warning `record position held …`.
- **Sync:** A pull counts a file under a decomposed (NFD) name once, touching its bytes in place.
- **Sync:** A driver argument error drops only its own document (`rejected`; a single route `400`). a tombstone `instanceId` blank or over 256 characters is refused.
- **Sync:** A file deleted on one peer is removed on the others at the version it names; one re-created since is kept. An admin restore removes a file description, source, property, tag or mark its backup lacks (`keysRemoved`).
- **Files:** A peer's file, pushed or pulled, is processed by this instance's rules (converted, chunked, media); a new version replaces old passages; a failed record write leaves no new file unless the database was down.
- **Files:** Changed media over a `complete` file is analysed again. A re-upload with metadata takes one seq; a no-op write none. A soft-deleted file keeps no description, vector, chunk or face; its record goes one file retention window after deletion, or stays with no window.
- **Files:** A record ends wholly at one path, a case-only rename moves it, a retried move completes only one it began, a move carries queued jobs.
- **Files:** A deleted file no longer returns from a peer unless re-created; a delete (audited `kind: "directory"` for a tree) takes its derived records and embed jobs, even a running media job's, on every door. A file's id is its canonical path (NFC, no `.` or empty segments); peers reject others.
- **Files:** A media or conversion job writes nothing for a file deleted, moved or wiped mid-run; the TTL sweep removes rows a previous version leaked. A moved file is re-embedded and keeps its cached hash; a deleted one is no longer a near-duplicate, contradiction or fresh recall hit.
- **Files:** New `ythril_file_act_answers_total{code}`, `ythril_file_move_rows_replaced_total{space}`, `ythril_file_move_link_fallback_total`; without hard links a move renames, defeatable by a foreign write.
- **Records:** A small entity merges into a hub of any size; a too-large refusal says *more than* the bound. Two writers can no longer both store an edge under a `functional` label in a `strict` space.
- **Records:** A cascade-removed edge always leaves its tombstone. `graph_traverse` and its REST twin answer whole nodes in hop order with `skip`/`nextSkip`, `remainderDump`, `limitReached`.
- **Schemas:** `GET /api/schema-library` answers `usageCounts`; the dry-run reports checked-of-total per collection.
- **Schemas:** `PATCH` and `schema_update` store `meta.stampSkew` and `whenDuePasses` (one refused, one dropped); a library `PATCH` no longer drops `suppressEmbeddings`, `endpoints` and `functional`.
- **Networks:** Every door opening a vote round answers it as the vote list shows; a joiner past its deadline loses its credential next sweep. A round ends at its deadline unattended; a peer's round past it, past 72 hours or concluded here is never adopted.
- **Housekeeping:** A failing or hung space no longer stops a background job for others. New `YTHRIL_HOUSEKEEPING_OP_TIMEOUT_MS` (default 240 s) ends each database operation. An unresumed reindex retries every few seconds; a dead sweeper's run is taken over at lease expiry.
- **Housekeeping:** A pass ends early when the store does not answer or 3 spaces in a row time out; a timed-out space is skipped 60 s, doubling to 300 s. Duplicate and contradiction scans report a failed lookup, skip a record that keeps failing and page past 500.
- **Server:** Background jobs no longer log under the arming request's id. An unknown tool answers `404`. Own `config.json` writes never reload the instance; no schedule arms once shutdown begins.
- **Database:** Pushed, pulled and store-side bulks write in chunks of at most 99 999 operations and 16 MiB; a duplicate key then a timeout answers `503`, not `400`. The `MONGO_URI` user must be able to list and end its own operations.
- **Database:** A write answered `503` "timed out, retry" can no longer land after the answer (the server's deadline ends it, 500 ms backstop). `POST /api/admin/data/config/test` answers an unreachable host `200` `{ "ok": false, "error": … }`.
- **Backup:** A scheduled backup's failure line reads `Scheduled backup failed: …` (was `… error: …`).
- **Backup:** A restore holds each space until it equals the backup with every index (a failed unique one retries), never lowers its counter, resumes after a crash; peers resend what followed. A migration no longer comes back empty.
- **Media:** A job holds its file by path and is complete only after its file is; ffmpeg stops after 10 minutes, audio at 5, video at 1000 keyframes; a killed job leaves no plaintext; `reprocessSyncedImages` off skips faces on pushed images too.
- **Webhooks:** One subscription's retry backlog no longer delays another's. A failing subscription is probed until it recovers.

### Security

- **Errors:** Every door, the two `sync?wait=true` routes included, answers a store failure with one fixed `503` message; those routes echoed the driver's text (hosts, ports, the store's address).
- **Errors:** An unrecognised driver error answers `500` ("An internal database fault stopped this operation"), not `400` carrying its message; the database's own refusals stay `400`. Logged as `Store-side failure answered 503`.
- **Server:** Values quoted back in answers and stored error text (an embed job's `lastError`, a reindex run's, media job's and webhook delivery's `error`) are bounded and escaped; a refusal names its first five references, ten keys.
- **Spaces:** A write, delete or retry through a proxy space could reach members the token may not write (5.6.x too); personal views replace proxies.
- **Sync:** A planted tombstone blocks no create beyond its own id nor names this instance as issuer; a peer cannot lift a record's version to the ceiling or mark its rows as written here.
- **Sync:** One deletion rule decides every record and file tombstone: the issuer's own, or the direct upstream's on a pub/sub network or a tree, for what it delivered.
- **Sync:** A peer's file tombstone needs its issuer's or the upstream's authority (any admitted peer could); a relayed one keeps its issuer. A held one refuses a later copy only as a record tombstone would; a peer cannot block a path.
- **Sync:** A pull no longer fetches a file past the space quota, stores nothing from a body that is not as declared, and takes back bytes no row names.
- **Search:** No read answers `deliveredBy` or a write guard (`filter` did; `{embedding: 1}` returned every field), and a filter naming one by key or `"$field"` path is refused.
- **UI:** Import conflicts show a type's name as text; a blocked entity delete names what to edit first.

## Earlier releases

- [5.x](changelog/CHANGELOG-5.x.md) — 31 releases
- [4.x](changelog/CHANGELOG-4.x.md) — 6 releases
- [3.x](changelog/CHANGELOG-3.x.md) — 6 releases
- [2.x](changelog/CHANGELOG-2.x.md) — 17 releases
- [1.x](changelog/CHANGELOG-1.x.md) — 10 releases
- [0.x](changelog/CHANGELOG-0.x.md) — 18 releases
