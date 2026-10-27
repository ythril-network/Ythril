# Changelog — 5.x

Frozen. The earliest releases of the 5.x series, newest first, moved here to keep the current file under its size ceiling;
the later 5.x releases are in [CHANGELOG.md](../CHANGELOG.md) until the 6.0 cut archives them here.

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
