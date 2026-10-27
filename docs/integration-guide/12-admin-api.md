# Admin API

> Part of the [Ythril Integration Guide](../integration-guide.md).

## Admin API

## Reference integrity

Every link between brain records — an edge's `from`/`to`, and the records a fact, chrono entry or file
is linked to (`linkEntities`, `linkFacts`, `linkChronos`) — names the target by its **id**,
which is a **UUID v4**. A name is not a reference.

**A reference that cannot resolve is refused.** A `link*` id answers `400` with `{ "error" }` on a create and an
update alike; the far end of an inline `edges` entry answers the `schema_violation` body (`400` on a create, `422` on
an update, a structured `schema_violation` from an MCP tool) — each naming the field and the offending value (for an
inline `edges` entry, the entry: `edges[0].to`), and **nothing is stored**, the record included. Both halves are checked:

- the value is a UUID v4, and
- a record with that id exists in the target space (for the far end of an inline `edges` entry, one of the kind its `toKind` names).

Format alone was never sufficient — a syntactically perfect id pointing at nothing dangles exactly as
silently as a name did, and the only symptom is a later traversal that quietly returns nothing.

### Opting out

A space may set `meta.strictLinkage: false` to accept unresolved references. This exists for **staged
imports**, where records legitimately reference targets that are created later in the run. It is a
deliberate per-space choice to accept dangling links, and it is **off by default** — you do not get lax
linkage by saying nothing.

Bulk writes (`POST /bulk`, `save_bulk`) check references for **format and existence** under strict linkage,
exactly as the single-record writes do, and an item's own `edges` the same way, before the item is written. A record created earlier in the same payload is referenced by its
`$ref` key, which always resolves; a literal id cannot name a record the payload creates, because ids are
minted by the server.

Restoring a space export is unaffected: import writes records directly rather than through these
routes, so an export whose records reference each other round-trips regardless of the setting.

### Reload Config

```http
POST /api/admin/reload-config
Authorization: Bearer <admin-token>
X-TOTP-Code: <code>   # required when MFA is enabled
```

**Requires admin token** (and TOTP code when MFA is enabled). Re-reads `config.json` from disk. Useful after manual edits. Any spaces added to the config since the last load are automatically initialized (MongoDB collections, indexes, vector search index, and file directories created; the vector index is then confirmed in the background as at start-up, so the space's `indexStatus` on `GET /api/spaces` is `building` and then `ready` or `failed`, for a retried space too). The built-in `general` space is ensured to exist. **A space whose initialisation fails does not stop the others from being initialised, and is not reported as applied**: the reload initialises every space it can, then answers `500` naming the spaces that are still not initialised (`503` with `Retry-After` when the failure was the database not answering), and the next reload tries those spaces again, whatever the file changed. Start-up does the same: a space that cannot be initialised is named once (`space init failed for space '<id>': … — retried next reload`), the others are initialised and confirmed, the server starts, and the next reload retries it. A reload refused this way moves `ythril_config_reload_failed_total` and holds `ythril_config_reload_pending` at `1` ([Setup API](11-setup-api.md)), exactly as a refused watched reload does; any reload that applies everything clears the gauge.

**A reload never drops a space silently.** A space the running instance has and the file no longer lists is
KEPT, and the log says so. To remove a space by editing the file, list its id in a top-level `"removeSpaces": ["id"]`;
the reload removes it from the configuration (its data stays until you delete the space) and clears the list. A
rename or delete interrupted by a crash completes as before. Every space a reload adds, removes or keeps is
written to the audit log as `space.reload_added`, `space.reload_removed` or `space.reload_kept`, by the watcher
as well as by this endpoint.

> **Manual edits are picked up automatically.** The server watches `config.json` and reloads within about two seconds of the file changing, running the same work this endpoint does — including initialising any space you added by hand. You do not have to call it after an edit; it remains available for scripts that want the reload to be synchronous, and for reloading `secrets.json` at a moment of your choosing. The server's own writes to the file are not reloads: the watcher compares the file as it is at that moment with what the server last wrote. This endpoint and the watcher take turns: a call made while a watched reload is running waits for it, then reloads. During a shutdown the server stops watching the file and no schedule is armed again, so a reload then applies the configuration and answers `{ "ok": true }` without restarting the sync, backup or scanner schedules.
>
> **If the file cannot be read at the moment it changes** (a bind mount that blinked mid-rename), the edit is not applied and the server log says so once (`config.json changed but could not be read just now`); the next change to the file, a call to this endpoint, or a restart applies it.
>
> **One caveat:** the server holds the config in memory and writes the whole file back whenever anything changes it. An edit made in the ~2-second window *before* the watcher notices can still be overwritten by a config write that lands in between (creating a space, saving settings). If you are editing by hand on a busy instance, call this endpoint straight after saving to close that window, or stop the server, edit, and start it again — which is always safe.
>
> **A WATCHED reload that fails is not retried, and this endpoint is not how you find out.** The two paths report differently on purpose: call this endpoint with an unreadable file and you get a `500` naming the problem, because there is a caller to answer. The watcher has none — it logs and carries on. It also claims the file's version (its modification time, size and inode) *before* reloading, so a half-written file is not re-read every tick, which means a failed watched reload leaves the running configuration older than the file **until something writes the file again or the instance restarts**. Watch `ythril_config_reload_pending` for it: `1` while that is true, `0` once a reload succeeds. Writing the file atomically — a temporary file renamed over the target — avoids the case entirely, because a reader then sees the old file or the new one and never half of either.

Reloading also flushes the token and OIDC caches, so a token revoked by a manual edit — or an updated OIDC block — takes effect immediately rather than after the cache expires. Legacy tokens that lack a `prefix` field are **not** removed: `findMatchingToken()` verifies them via a fallback scan and backfills the prefix on first use, so a reload never invalidates existing tokens.

**And it re-arms the schedulers whose cron expression is fixed when they start** — the sync engine, the duplicate
scanner and the contradiction scanner. It did not always: changing `dupeScanner.schedule` reloaded the
config and left the scanner running on the schedule it had at boot, and **enabling a scanner that was off did
nothing at all** until the instance was restarted — while this endpoint answered `{ "ok": true }`.

The jobs that repeat on a fixed interval — every job named under `ythril_interval_tick_skipped_total` in the
[Setup API](11-setup-api.md) — are deliberately **not** restarted: they re-read the config on every run, so a
change reaches them on the next tick. Restarting them would only reset the phase of a six-hour timer, pushing
the next run up to six hours away each time a setting is saved.

**Response** `200`:

```json
{ "ok": true }
```

---

### Export Space

```http
GET /api/admin/spaces/:spaceId/export
Authorization: Bearer <admin-token>
```

Dumps the entire knowledge base of a space as a single JSON document. Requires admin token + TOTP when MFA is enabled.

**Response** `200`:

```json
{
  "exportedAt": "2026-04-11T10:00:00.000Z",
  "spaceId": "eng-kb",
  "spaceName": "Engineering Knowledge Base",
  "version": "1.0.0",
  "facts": [ { "_id": "...", "fact": "...", "tags": [], "...": "..." } ],
  "entities": [ { "_id": "...", "name": "...", "type": "...", "...": "..." } ],
  "edges":    [ { "_id": "...", "from": "...", "to": "...", "label": "...", "...": "..." } ],
  "chrono":   [ { "_id": "...", "title": "...", "type": "...", "...": "..." } ],
  "links":    [ { "_id": "...", "from": "...", "fromKind": "fact", "to": "...", "toKind": "entity", "...": "..." } ],
  "files":    [ { "_id": "...", "path": "...", "...": "..." } ]
}
```

- **Every replicated family is exported, keyed by its collection name** — facts, entities, edges, chrono, links and
  file metadata. Links were missing until this release, so an export-then-import lost every link.
- What this instance DERIVES with its own model is left out — `embedding`, `embeddingModel` and `matchedText` — so
  exported data is model-independent; the import re-embeds. So is an edge's write guard (`_functionalGuard`): this
  instance's own lock on a functional label's subject, never a backup's to carry.
- The record's own local state is kept: the retention stamps (`_expireAt`, `_contentExpireAt`), a file's
  `syncBase`, who delivered the record (`deliveredBy`), whether this instance wrote its current version
  (`writtenHere`), and on a fork row the decision still owed here (`_resolvedElsewhere`: another instance resolved its own
  copy and this one has not decided yet). The record's landing position (`pos`, `posAtSeq`) is not kept: a restore takes a fresh one, so it
  is not exported, and a tombstone's own local fields (`storedVia`, `issuedHere`, `pos`, `posAtSeq`) are this instance's alone. JSON writes the stamps as ISO strings; the import turns
  them back into dates.
- Binary file content is **not** included — only file metadata. Use the Files API to download actual files.

---

### Import Space

```http
POST /api/admin/spaces/:spaceId/import
Content-Type: application/json
Authorization: Bearer <admin-token>
```

Upserts exported data into a space. Requires admin token + TOTP when MFA is enabled.

**Request body** — same shape as the export response. Each array is optional:

```json
{
  "facts": [ { "_id": "...", "fact": "...", "tags": [] } ],
  "entities": [ { "_id": "...", "name": "...", "type": "..." } ]
}
```

Each document must have a string `_id` and a `seq` that is a non-negative integer below the protocol's ingest
ceiling (`2^50 − 2^40`); file metadata older than seqs may carry none. Documents with an existing `_id` in the space
are **replaced, whatever their seq** — an import is a restore, so a backup restored over newer data wins; new
`_id`s are inserted. A file holding the same `_id` twice stores the copy with the highest seq.

What the import stores of each document:

- **Kept**: everything the export carried as the record's content, plus its retention stamps (as dates — they ARE
  the record's own retention, since a per-record `ttlDays` is never stored), a file's `syncBase` and `deliveredBy`. A record that
  carries no stamp is stamped by THIS space's retention policy (type schema over space), counted from its own
  `createdAt`. **Never the replaced copy's**: a stamp or `syncBase` the export does not carry is not taken from the
  record the import overwrites — a record restored to "never expires" no longer keeps the replaced copy's expiry.
- **Dropped**: `embedding`, `embeddingModel` and `matchedText` (re-embedded here); an edge's write guard
  `_functionalGuard` (a restored edge arrives unguarded, and a second edge under a functional label is still refused
  when one is written); every file chunk and face record
  (`parentFileId` set — re-derived from the blob); and every file-metadata key that is not on the sync wire
  (`sizeBytes`, `sha256`, `excerpt` and the like describe bytes this instance may not hold). File metadata is merged
  onto what is stored, as sync merges it — except that an export is a full record, so every authored key
  (the description, tags and properties, for example) the exported row lacks is **removed** from the row it
  replaces. A row the export carries flagged `deletedAt` (a file this instance had soft-deleted) is restored
  flagged, never as a live file (`flagsKept` below). The summary counts what a restore removed this way (`keysRemoved`).
- The space's seq counter is moved past every imported seq, chunk by chunk, so the next local write sorts above
  every restored record.

**`503` with `code: "edge_identity_building"`**: the `edges` array carries a fork edge (a row with a `forkOf`) and the space still has the full unique edge identity index, which counts a fork as a duplicate of its subject. The families before `edges` have been stored, and nothing of `edges` is. Nothing is lost: a restore is idempotent, so run the same import again once `ythril_edge_identity_building_spaces` no longer counts the space (the owed job swaps the index within a minute). A space created by this release, or one with no edge yet, never answers it ([Upgrading](02b-upgrading.md)).

**Response** `200`:

```json
{
  "spaceId": "eng-kb",
  "results": {
    "facts": { "inserted": 5, "updated": 2, "errors": 0 },
    "entities": { "inserted": 3, "updated": 1, "errors": 0 },
    "edges":    { "inserted": 0, "updated": 0, "errors": 0 },
    "chrono":   { "inserted": 0, "updated": 0, "errors": 0 },
    "links":    { "inserted": 0, "updated": 0, "errors": 0 },
    "files":    { "inserted": 0, "updated": 0, "errors": 1, "derived": 2,
                  "refused": [ { "_id": "notes/a.md", "reason": "seq \"7\" is not a non-negative integer" } ] }
  }
}
```

Per family, alongside the counts, and each present only when it has something to say:

| field | what it holds |
|---|---|
| `refused` | the documents NOT stored, `{ _id, reason }` — a malformed id or seq, a value the store refuses, a uniquely-indexed duplicate of a record held under another id, or (when the store failed part-way through a family) every document after the fault. **The first 10 are named**; `errors` is the total. Documents written before a part-way fault are counted in `inserted`/`updated`, not here |
| `derived` | how many file chunks and face records were left out because this instance derives them from the blob |
| `flagsKept` | files only: how many restored rows kept the `deletedAt` flag their export carried (files this instance had soft-deleted, brought back as the audit records they were rather than as live rows with no bytes). Present only when any did |
| `keysRemoved` | files only: how many authored keys (a description, its source, the properties, the tags, a suppression mark) the restored rows lost because their export row lacks them. It counts the keys the replaced rows held, so a key a row never had is not counted. Present only when any were removed |
| `restoredOverTombstone` | ids of records restored over a deletion this instance holds **and that deletion would still apply to** (judged by the same [deletion rule](../sync-protocol.md#tombstone-deletion-authorisation) sync uses: the issuer wrote the record, or this instance's upstream delivered it) — a peer holding the same tombstone will delete them again on the next sync. **The first 10**; `restoredOverTombstoneTotal` is how many there were |
| `schemaViolations` | documents stored carrying something the space's schema does not accept that the copy they replaced lacked (below); `schemaViolationsTotal` and, past 50, `schemaViolationsTruncated: true` |

**A document that breaks the space's schema is STORED, and reported.** It is not refused: a backup taken before
a schema change would be rejected by the instance's own current rules, which would make backups unrestorable —
the very thing an import exists for. This is the same answer sync gives on the same kind of payload, and for the
same reason, and the two ask the same module ([What arrivals record](06a-schema-api.md#what-arrivals-record)): a
document is reported only when it was stored, only for what the copy it replaced did not already carry, and not at all
in a space whose `validationMode` is `off`. An undeclared property key is one of the things reported.

Each affected collection carries a `schemaViolations` array naming the documents and what was wrong with each —
**by `field` and `reason`, never a value**, a restore's answer being no place for a backup's data:

```json
"entities": {
  "inserted": 3, "updated": 1, "errors": 0,
  "schemaViolations": [
    { "_id": "e1b2c3d4-...", "violations": [ { "field": "properties.owner", "reason": "required property 'owner' is missing or empty" } ] }
  ],
  "schemaViolationsTotal": 120,
  "schemaViolationsTruncated": true
}
```

Per record rather than a count, deliberately: a number tells you something in a 50 000-record restore is wrong
and nothing about which one — and bounded, because a list of names is not: **the first 50 documents are named**, each
with at most 20 rows; `schemaViolationsTotal` is how many documents there were, and `schemaViolationsTruncated` is
present only when it is more than were named. The array is absent when there is nothing to report. The restore also
says it once in the log and counts the documents in `ythril_schema_violations_recorded_total{source="import"}`.

**Imported records are queued for embedding.** Until 3.7 they were not — a restored backup was stored and
invisible to meaning-ranked search until somebody ran a reindex they were never told they needed. The import
now writes through the same arrival writer every sync door does, which writes and enqueues in one call — a
restored file included, whether or not its blob is here yet. A reindex is
still the tool for rebuilding vectors after an embedding-model change; it is no longer required to make an
import searchable at all.

**What an import deliberately does NOT do**, though sync does:

- **It does not reallocate `seq`.** An exported document keeps the one it had, so a restored instance and its
  peers still agree about which copy of a record is newer.
- **It does not refuse over tombstones.** Sync refuses a document whose id has been deleted, so a lagging peer
  cannot resurrect it. A restore is the one case where resurrection is the point — but a record deleted *after*
  the backup will come back, and the tombstone will remove it again on the next sync with a peer that still holds
  one, where that deletion applies to the record under the same rule. Such records are counted in
  `restoredOverTombstoneTotal` and the first of them named in `restoredOverTombstone`, so it is known rather than
  discovered. A restored record keeps the delivery stamp its export carried (empty when the backup has none).
- **It does not guard by seq.** Sync keeps a stored copy that is newer than the incoming one; a restore replaces.

**Files are stored without schema validation**, because a file has no `type` and therefore no type schema.

---

### Wipe Space

`POST /api/admin/spaces/:spaceId/wipe` empties a space, or some of its collections, and keeps the space. Its request,
answers, behaviour and the matching MCP tool are documented with the deletion it shares its rules with:
[Space Deletion and Wipe → The admin wipe route](06c-space-deletion-and-wipe-api.md#the-admin-wipe-route).

---

### Personal views: orphans, claims, retired ids and the migration report

Four doors exist for the 6.0 upgrade, which turned every pre-6.0 grouping of spaces into personal views ([Upgrading](02b-upgrading.md)).
Each needs an **instance admin** token, has an MCP twin with the same parameters, and answers refusals as
`{ "error", "code" }`. The views a token owns and its own doors (`/api/views`) are in
[Personal views](06d-personal-views.md); a view id given to a wipe, a delete or any other space door above answers as a
missing space (`404`).

| Door | MCP tool | Answer |
|---|---|---|
| `GET /api/admin/views/orphans` | `view_orphans` | `{ "orphans": [{ "ownerKind": "token", "count": 3 }], "unclaimed": [{ "name": "team", "members": ["qa", "research"] }] }` |
| `POST /api/admin/views/claim` `{ "name": "team" }` | `view_claim` | `201 { "view": {…} }` — a view owned by the calling admin with the definition's members; `404` `view_claim_unknown` for a name that is not unclaimed |
| `POST /api/admin/views/retired/:id/purge` `{ "confirmOidcClaims"?: true }` | `view_purge_retired` | `{ "released": "<id>" }` |
| `GET /api/admin/views/migration` | `view_migration` | `{ "migrated": ["team"], "networksLostIds": [{ "networkId", "label", "spaceIds" }], "unclaimed": […], "retiredSpaceIds": ["team"] }` |

- **Orphans** counts the views whose owner holds no token, per owner kind (`token`, `oauth`), naming neither a view nor an
  owner. `unclaimed` lists the migrated definitions that no live admin token could own when they were converted.
- **Claim** consumes the definition: it takes it for the calling admin only, and another admin who wants the same view
  asks the first to copy it (`POST /api/views/:id/copy`), so a second claim of the name is `404`. A name the admin already
  holds becomes `<name>-2`, and an admin at the cap of 50 views is refused `409` `view_limit_reached`.
- **Purge** drops everything a retired space id still holds (its collections, vector indexes, files directory and
  activity rows) and releases the id so a space can be created under it again. It is `404` `retired_id_unknown` for an id
  that is not retired, `409` `retired_purge_unconfirmed` while OIDC maps spaces from a claim and `confirmOidcClaims` is not
  `true`, and it is safe to repeat: when a step fails the id stays reserved and the next call resumes.
- **Migration** reports what the upgrade did, so it can be read after the boot log is gone: the proxy ids converted, the
  networks that lost one (the peers see this member as having left that network space), the definitions still unclaimed
  and the ids still reserved.
- **Audit:** a claim is `view.claim` and a purge is `space.retired_id.purge`, each with the owner key and a member count
  and no name ([Audit Log](13-audit-log-api.md)).

---

## Data Management API

Backups, restore, maintenance mode and database migration (`/api/admin/data`) are in [Data Management API](12a-data-management-api.md).

---

## Local connector (workstation mode)

These three exist for **workstation mode**, where Ythril runs on a machine an operator also uses directly and a small local
agent performs the steps a container cannot: opening a firewall port, installing a service, starting a tunnel. All three
require **admin + MFA**, and all three are a thin control plane over the agent's own `/v1` API — the agent is reached at
`YTHRIL_LOCAL_AGENT_URL`.

See [the workstation-mode guide](../workstation-mode-guide.md) for what the agent is and how it is installed.

### GET /api/admin/local-agent/status

Reports whether the connector is usable, and says why when it is not:

```json
{ "configured": true, "reachable": true, "canExecute": true }
```

| Field | Meaning |
|---|---|
| `configured` | The server has a local-agent URL |
| `reachable` | The agent answered its `/v1/status` |
| `canExecute` | The agent will run privileged actions |
| `message` | Present when any of the above is false, in plain language |

**This route answers `200` even when the connector is broken.** That is deliberate: "is the connector working" is the
question being asked, so an unreachable agent is an *answer* rather than an error, and the UI renders the manual-commands
fallback instead of a failure. A `5xx` here would be indistinguishable from the server itself being unwell.

### POST /api/admin/local-agent/bootstrap

```json
{ "os": "windows" }
```

Installs and starts the connector. `os` is optional and inferred when omitted. Idempotent —
`{ "ok": true, "message": "Local connector already running." }` when it is already up.

### POST /api/admin/local-agent/enable-networks/execute

```json
{ "hostname": "ythril.example.com", "os": "windows" }
```

Performs the host-side steps that let this instance accept peer connections. `hostname` is validated against RFC 952 /
1123 label rules, both fields are required, and the OS is not inferred here because the steps differ per platform and a
wrong guess would run the wrong ones.

---
