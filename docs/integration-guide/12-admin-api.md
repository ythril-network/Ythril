# Admin & Data Management APIs

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

> **Manual edits are picked up automatically.** The server watches `config.json` and reloads within about two seconds of the file changing, running the same work this endpoint does — including initialising any space you added by hand. You do not have to call it after an edit; it remains available for scripts that want the reload to be synchronous, and for reloading `secrets.json` at a moment of your choosing.
>
> **One caveat:** the server holds the config in memory and writes the whole file back whenever anything changes it. An edit made in the ~2-second window *before* the watcher notices can still be overwritten by a config write that lands in between (creating a space, saving settings). If you are editing by hand on a busy instance, call this endpoint straight after saving to close that window, or stop the server, edit, and start it again — which is always safe.
>
> **A WATCHED reload that fails is not retried, and this endpoint is not how you find out.** The two paths report differently on purpose: call this endpoint with an unreadable file and you get a `500` naming the problem, because there is a caller to answer. The watcher has none — it logs and carries on. It also claims the file's modification time *before* reloading, so a half-written file is not re-read every tick, which means a failed watched reload leaves the running configuration older than the file **until something writes the file again or the instance restarts**. Watch `ythril_config_reload_pending` for it: `1` while that is true, `0` once a reload succeeds. Writing the file atomically — a temporary file renamed over the target — avoids the case entirely, because a reader then sees the old file or the new one and never half of either.

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
  `syncBase` and who delivered the record (`deliveredBy`). JSON writes the stamps as ISO strings; the import turns
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
| `counterBehind` | `true` when the family's records were stored and this instance's seq counter could not be moved past them: the next local write may take a seq below a restored record. What was stored is still counted in `inserted`/`updated`. **Run the import again** — a restore replaces, so it is safe, and the re-run moves the counter |
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

Base path: `/api/admin/data` — **requires admin token** on all endpoints. Most mutating endpoints additionally require a TOTP code (`X-TOTP-Code` header) when MFA is enabled on the instance.

---

### GET /api/admin/data/config

Returns how the MongoDB URI is configured and a redacted version of the URI (credentials replaced with `[credentials]`).

```http
GET /api/admin/data/config
Authorization: Bearer <admin-token>
```

**Response `200`:**

```json
{
  "source": "config",
  "mongoUriRedacted": "mongodb://[credentials]@db:27017/ythril"
}
```

`source` indicates where the active connection string comes from, in priority order (highest first):

| Value | Meaning |
|---|---|
| `"env"` | A non-empty `MONGO_URI` environment variable, set in deployment config (e.g. `docker-compose.yml`). Always takes precedence; an empty one counts as unset. Migration is refused (`409 INFRA_MANAGED`) when this is the source. |
| `"config"` | Connection string stored in `config.json` — set via database migration or manual edit. |
| `"default"` | Built-in default (`mongodb://ythril-mongo:27017/ythril`). No custom connection configured. |

---

### POST /api/admin/data/config/test

Test whether a MongoDB URI is reachable before committing to a migration or config change.

```http
POST /api/admin/data/config/test
Authorization: Bearer <admin-token>
X-TOTP-Code: <code>   # required when MFA is enabled
Content-Type: application/json

{ "uri": "mongodb://user:pass@new-host:27017/ythril" }
```

**Response `200`:** `{ "ok": true }` when the host answers, `{ "ok": false, "error": "<the driver's message>" }` when it cannot be reached (an unreachable host is the answer asked for, not an error status; the Test Connection button reads `ok`).

Returns `400` for an invalid URI and for URIs targeting private/loopback/cloud-metadata addresses (SSRF protection); `500` only for a failure of the route itself.

---

### GET /api/admin/data/maintenance

Return current maintenance mode state.

```http
GET /api/admin/data/maintenance
Authorization: Bearer <admin-token>
```

**Response `200`:** `{ "active": false, "manual": false, "heldBy": null }`

Maintenance has two halves, and `active` is either of them:

| Field | Meaning |
|---|---|
| `manual` | The operator's toggle ([POST below](#post-apiadmindatamaintenance)). Kept in memory: a restart clears it |
| `heldBy` | `"restore"` or `"migrate"` while an act standing on every space holds the instance ([restore](#post-apiadmindatarestore), [migrate](#post-apiadmindatamigrate)); `null` otherwise. It is read from the standing acts, so a restart that resumes them resumes it, and it ends when the last act ends |
| `active` | `manual` or `heldBy` |

While `active`, every request to `/api` and `/mcp`, and every write, answers `503` with `{ "error": "System is in maintenance mode. Please try again later.", "maintenance": true }`,
reads included, except `/health`, `/ready`, `/metrics`, the `/api/admin/*` routes and **any request made with an instance-admin
token**, which passes on every path: the danger tab, the Networks owed list and MCP keep working for the one caller who can act on
a restore. **The web client itself still loads for anyone**: a `GET` or `HEAD` outside `/api` and `/mcp` (the page, its bundle,
a client route) passes, because it holds no data and an administrator's browser asks for the page without a token. What the page
then shows it reads through `/api`, which stays held for everyone but an instance admin.

---

### POST /api/admin/data/maintenance

Turn the **manual** half of maintenance mode on or off. It cannot end the half a standing restore or migrate holds: the
answer is the state above, so `{ "active": false }` sent during a restore answers `active: true`, `manual: false` and `heldBy`.

```http
POST /api/admin/data/maintenance
Authorization: Bearer <admin-token>
X-TOTP-Code: <code>   # required when MFA is enabled
Content-Type: application/json

{ "active": true }
```

**Response `200`:** `{ "active": true, "manual": true, "heldBy": null }`

---

### POST /api/admin/data/backup

Trigger an immediate point-in-time dump of the entire MongoDB database. The backup is written to `<data-root>/backups/<ISO-timestamp>/` and contains a `manifest.json` plus one NDJSON file per collection.

> **Unless `encrypt` is on, a backup is an unencrypted copy of everything, and `requireEncryptedAtRest` does not cover it.**
>
> The dump is written by reading *through* `mongod`, so it comes out **decrypted**: every fact, entity, edge,
> chrono entry, file-meta record and audit entry, as plaintext NDJSON on the data volume. If you followed
> [Encryption at Rest](02a-encryption-at-rest.md#encryption-at-rest) and gave the instance a master key, that covers the app's
> four state files — `config.json`, `secrets.json`, `schema-library.json`, `schema-catalogs.json` — and uploaded
> files. It does not cover the dump, and neither does running against an encrypted `mongod`: the backup
> configuration's `encrypt` option (below) does, and it is opt-in.
>
> Ythril writes the dump directory `0700` and each NDJSON file `0600`, so it is not readable by other users on the
> host. Beyond that the protection is yours to arrange:
>
> - treat `<data-root>/backups/` as sensitive as the database itself — it *is* the database;
> - the **offsite** copy is usually a mounted share, and `<destRoot>/<backupId>-files/` additionally contains every
>   uploaded file as it is on disk — ciphertext when the instance has a master secret (restoring it needs the same
>   secret), otherwise the files as uploaded. Ythril creates those directories `0700` too, but a network filesystem
>   may not honour POSIX modes at all — encrypt the volume or the transport;
> - a dump you download is plaintext from the moment it leaves the instance, unless it was taken with `encrypt`.
>
> Encrypting dumps is opt-in rather than the default because it makes a backup unrestorable without the master
> secret, which is either the point or a foot-gun depending on why you are taking it.

When `YTHRIL_DB_MIGRATION_ENABLED=true` and a `backup.json` config file is present, this endpoint also:

- Copies the backup (plus `<data-root>/files/`) to the configured `offsite.destPath`
- Applies local retention (`retention.keepLocal`) — deletes oldest local backups over the limit
- Applies offsite retention (`offsite.retention.keepCount`) — deletes oldest offsite sets over the limit

```http
POST /api/admin/data/backup
Authorization: Bearer <admin-token>
X-TOTP-Code: <code>   # required when MFA is enabled
```

**Response `200` (local backup only):**

```json
{
  "backup": {
    "id": "2026-04-23T10-00-00-000Z",
    "dir": "/data/backups/2026-04-23T10-00-00-000Z",
    "manifest": { "createdAt": "2026-04-23T10:00:00.000Z", "collections": ["facts", "entities"] }
  }
}
```

**Response `200` (with offsite copy and retention):**

```json
{
  "backup": {
    "id": "2026-04-23T10-00-00-000Z",
    "dir": "/data/backups/2026-04-23T10-00-00-000Z",
    "manifest": { "createdAt": "2026-04-23T10:00:00.000Z", "collections": ["facts", "entities"] }
  },
  "localPruned": 2,
  "offsite": {
    "dir": "/mnt/offsite-backup/ythril/2026-04-23T10-00-00-000Z",
    "filesDir": "/mnt/offsite-backup/ythril/2026-04-23T10-00-00-000Z-files",
    "pruned": 1
  }
}
```

`localPruned` and `offsite.pruned` are only present when backups were actually deleted. `offsite.filesDir` is only present when a `files/` directory exists.

While a [restore](#post-apiadmindatarestore) or a [migrate](#post-apiadmindatamigrate) stands, a backup, manual or scheduled,
is refused rather than dump a database that is part old and part restored: this endpoint answers `409` with
`code: "backup_refused_during_restore"`, and a scheduled run is refused the same way and logged as `Scheduled backup failed: …`. Retry once `GET /api/admin/data/restore` (or `/migrate`) says the set has ended.
Local retention never deletes a backup a standing restore names.

---

### GET /api/admin/data/backups

List all available backups, sorted newest first.

```http
GET /api/admin/data/backups
Authorization: Bearer <admin-token>
```

**Response `200`:**

```json
{
  "backups": [
    {
      "id": "2026-04-23T10-00-00-000Z",
      "dir": "/data/backups/2026-04-23T10-00-00-000Z",
      "createdAt": "2026-04-23T10:00:00.000Z",
      "collections": ["facts", "entities", "edges"]
    }
  ]
}
```

---

### POST /api/admin/data/restore

Make every space this instance serves equal to a backup. A restore is a **set of space acts**, one `restore` act per served
space, like a [deletion or wipe](06c-space-deletion-and-wipe-api.md): the request checks the backup and answers `202` before
anything is replaced, and each space is then replaced in the background under a hold. [`GET /api/admin/data/restore`](#get-apiadmindatarestore)
reports the progress and the outcome.

```http
POST /api/admin/data/restore
Authorization: Bearer <admin-token>
X-TOTP-Code: <code>   # required when MFA is enabled
Content-Type: application/json

{ "backupId": "2026-04-23T10-00-00-000Z", "leaveOut": ["old-team"] }
```

| Field | Meaning |
|---|---|
| `backupId` | A directory name under `<data-root>/backups/`. Slashes and `..` are rejected |
| `leaveOut` | Optional, at most 1 000 ids: spaces the backup holds that this instance no longer serves (renamed or deleted after the backup), restored without them |

**Nothing is registered until the backup and the space set pass.** The backup must be whole: its `manifest.json` parses,
every file it names is present, every line can be read (and decrypted, for an encrypted backup) and the counts match. Then:

- a space the backup holds that this instance does not serve is refused, named in `spaces`, unless `leaveOut` lists it: its data
  has no space to go to;
- a space this instance serves that the backup does not hold (created after the backup) is **emptied**: that is what "equal to
  the backup" means.

**Response `202`:**

```json
{
  "restoreId": "8f0c…",
  "backupId": "2026-04-23T10-00-00-000Z",
  "spaces": ["general", "notes", "scratch"],
  "emptied": ["scratch"],
  "leftOut": ["old-team"]
}
```

**From the `202`:**

- each space takes no write **until its own act completes**: a local write answers `409` with `code: "space_being_restored"`
  on REST and MCP, and the space's peer exchanges are held. A space whose act has completed has its hold lifted while the others are
  still being restored;
- until the **last** space's act ends, the instance is in [maintenance](#get-apiadmindatamaintenance) (`heldBy: "restore"`):
  every caller but an instance-admin token is answered `503` on `/api` and `/mcp`, so meanwhile only an instance admin can
  write to a space whose act has completed. The web client itself still loads, so the admin can open the page that reports
  and abandons the restore;
- until the last space's act ends, a backup is refused (`409 backup_refused_during_restore`), and so is a second restore or a
  migrate;
- a restart resumes the acts where they stand, and the holds with them.

**What each space's act does.** It checks the backup again for its space (the files can change on disk), drops the space's
collections and creates them again, empty, with every index (the unique ones included, so a duplicate the backup holds is
refused when it is loaded), loads the backup's records, raises the space's sequence counter to at least every seq this
instance handed out before (a peer never meets a new write under a seq it has already seen), checks the edge identity and
guard indexes, and starts the vector index builds. When the act completes, the space forgets its **receive marks** in every
network that carries it: how far it had read each peer, and where its re-reads of a peer's tombstones and file metadata stood.
The peers therefore send again what reached this instance after the backup. The marks of what this instance **sent** are kept
([which marks, and why](../sync-protocol.md#the-per-space-marks-and-what-a-restore-does-to-them)).

**A failure.** A store that is down or does not answer is retried: the space is `owed` with a `retryAt`. A backup that is no
longer whole, or that holds records one of the space's unique indexes refuses, is not retried: the space shows
`needsAbandon: true` and stays held until an operator [abandons the restore](#post-apiadmindatarestoreabandon).

**What a restore does not restore:**

- the audit log, which records what happened, the restore included; `space_activity`; the webhook subscriptions and delivery
  queues; the other instance collections; and `config.json`;
- the files' bytes on disk. A file's record comes back as the backup has it while its bytes stay as they are now, so after a
  restore a file can be listed without its bytes, or bytes can be on disk that no record names.

**What comes back that you may not expect.** Records erased after the backup come back, erasure requests included, while the
kept audit log still records the erasure: erase them again. A record deleted here after the backup whose deletion the peers have
since pruned comes back live here and is not sent to them again. A restore onto an empty database cannot raise the counter past
seqs peers have already read from this instance, and a peer this instance never pulls from (its own subscribers, when it
publishes) does not send again what it sent: these belong to the same limit, a peer's numbering starting over, and are not
solved by a restore.

| Status | `code` | Meaning |
|---|---|---|
| `400` | | Missing or invalid `backupId` or `leaveOut` |
| `400` | `backup_names_unserved_spaces` | The backup holds spaces this instance does not serve (`spaces`); name them in `leaveOut` |
| `400` | `backup_not_whole` | The backup is incomplete or unreadable; the sentence says what |
| `404` | | Backup not found |
| `409` | `space_being_restored`, `space_being_migrated` | A restore or a migrate already stands |
| `503` | | The server is shutting down |

> All data written after the backup was taken is lost on restore. This operation is not reversible.

### GET /api/admin/data/restore

The restore standing, or the last one this instance ran; `{ "restore": null }` when none ever ran. Admin and MFA, like the
restore itself.

```json
{
  "restoreId": "8f0c…",
  "backupId": "2026-04-23T10-00-00-000Z",
  "state": "running",
  "startedAt": "2026-04-23T10:05:00.000Z",
  "done": 1,
  "total": 3,
  "spaces": [
    { "id": "general", "state": "done", "attempts": 0, "completedAt": "2026-04-23T10:05:09.000Z",
      "edgeIndexes": { "failed": [] }, "vectorIndexes": "rebuilding" },
    { "id": "notes", "state": "owed", "attempts": 2, "lastError": "…", "retryAt": "2026-04-23T10:06:00.000Z" },
    { "id": "scratch", "state": "running", "attempts": 1 }
  ],
  "emptied": ["scratch"],
  "leftOut": []
}
```

| Field | Meaning |
|---|---|
| `state` | `running`, `completed` or `abandoned` |
| `endedAt` | When the set ended; absent while it runs |
| `lastError` | At the top: the sentence a failure of the whole set ended it with |
| `done`, `total` | Spaces whose act completed, of all the set's spaces |
| `spaces[].state` | `owed` (registered, waiting or retrying), `running`, `done`, or `restore_abandoned` |
| `spaces[].attempts` | Attempts so far of an act that has not completed |
| `spaces[].lastError` | Our sentence for the last failure, never the database driver's text |
| `spaces[].retryAt` | When an owed act is tried again |
| `spaces[].needsAbandon` | `true`: the failure is the backup's, so retrying cannot help; [abandon](#post-apiadmindatarestoreabandon) |
| `spaces[].vectorIndexes` | `rebuilding` (the builds started and are warming up) or `failed` (they could not start; the space was still restored) |
| `spaces[].edgeIndexes` | `{ "failed": [] }`: the edge identity and guard indexes stand. One that cannot be built fails the act instead |

Poll it until `state` is not `running`. The Data page does, while it is open.

### POST /api/admin/data/restore/abandon

Lift the holds of the standing restore's acts that have not completed. The spaces whose acts had not completed **keep whatever
their acts reached and may be half restored**: the answer names them, and the report marks them `restore_abandoned`. Meant for a
restore whose backup cannot be read (`needsAbandon`). Admin and MFA; audited as `data.restore.abandon`, and the set's end as
`data.restore.abandoned`.

**Response `200`:** `{ "abandoned": true, "restoreId": "8f0c…", "backupId": "2026-04-23T10-00-00-000Z", "released": ["notes"], "halfRestored": ["notes"], "completed": ["general"] }`
(`released` is the field every abandon answers with, [a migrate's](#post-apiadmindatamigrateabandon) too; `halfRestored` names the
same spaces in the restore's words.)

| Status | `code` | Meaning |
|---|---|---|
| `404` | `no_restore_standing` | No restore stands |
| `409` | `restore_act_running` | A space's act is running now; abandon once it has ended (an abandon never cuts an act short) |

---

### GET /api/admin/data/backup-config

> **Feature flag required.** Returns `403` unless the instance was started with `YTHRIL_DB_MIGRATION_ENABLED=true`.

Returns the current contents of `backup.json` — the file that configures scheduled and offsite backups. Can also be written via [PUT /api/admin/data/backup-config](#put-apiadmindatabackup-config) (also flag-gated).

```http
GET /api/admin/data/backup-config
Authorization: Bearer <admin-token>
```

**Response `200`:**

```json
{
  "config": {
    "schedule": "0 2 * * *",
    "encrypt": false,
    "retention": { "keepLocal": 7 },
    "offsite": {
      "destPath": "/backups",
      "retention": { "keepCount": 14 }
    }
  },
  "configPath": "/config/backup.json",
  "backupsPath": "/data/backups"
}
```

`config` is `null` when the file does not exist (feature is enabled but backup.json has not been created yet).

| Status | Meaning |
|--------|--------|
| `200` | Success |
| `403` | `YTHRIL_DB_MIGRATION_ENABLED` is not `true` (feature disabled) |

#### Configuring backup.json

Place `backup.json` alongside `config.json` on the container filesystem (typically `/config/backup.json`). All fields are optional — omit any field to disable that aspect.

| Field | Type | Description |
|---|---|---|
| `schedule` | string | Cron expression for automatic backups (`"0 2 * * *"` = daily at 02:00). Must be a valid 5-part cron expression. |
| `retention.keepLocal` | integer ≥ 1 | Max local backups to keep under `<data-root>/backups/`. Oldest are pruned automatically. |
| `offsite.destPath` | string | **Absolute path** on the container filesystem. Mount external drives, NFS shares, or any storage as a volume pointing here. |
| `offsite.retention.keepCount` | integer ≥ 1 | Max offsite backup sets to retain (default: 14). |

Each offsite backup set consists of a `<backupId>/` directory (MongoDB dump) and a `<backupId>-files/` directory (copy of `<data-root>/files/`), kept in sync when pruning.

**Example `backup.json`** — also at `config/backup.example.json` in the repository:

```json
{
  "schedule": "0 2 * * *",
  "retention": { "keepLocal": 7 },
  "offsite": {
    "destPath": "/mnt/offsite-backup/ythril",
    "retention": { "keepCount": 14 }
  }
}
```

**Docker Compose example** — mounting an external volume for offsite backups:

```yaml
services:
  ythril:
    environment:
      YTHRIL_DB_MIGRATION_ENABLED: "true"
    volumes:
      - ./config:/config
      - ythril-data:/data
      - /mnt/external-drive/ythril-backups:/backups

# config/backup.json  →  { "schedule": "0 2 * * *", "offsite": { "destPath": "/backups" } }
```

---

### PUT /api/admin/data/backup-config

> **Feature flag required.** Returns `403` unless the instance was started with `YTHRIL_DB_MIGRATION_ENABLED=true`.
>
> **Requires admin MFA** (same as other write operations).

Writes (replaces) `backup.json`. Use this to configure the backup schedule and offsite destination from the UI or programmatically. The backup settings UI in **Settings → Database** calls this endpoint.

**The new schedule is armed before the response returns**, so a `200` here means backups will run on it. It did not always:
this route wrote the file and nothing re-read it, so a changed schedule was ignored, a cleared one kept
firing, and an operator turning scheduled backups **on for the first time** got `{ "ok": true }` and no backups
at all until the instance was restarted.

```http
PUT /api/admin/data/backup-config
Authorization: Bearer <admin-token>
Content-Type: application/json
```

**Request body** — the full `BackupConfig` object (all fields optional):

```json
{
  "schedule": "0 2 * * *",
  "retention": { "keepLocal": 7 },
  "offsite": {
    "destPath": "/backups",
    "retention": { "keepCount": 14 }
  }
}
```

`offsite.destPath` must be an absolute path — the request is rejected with `400` otherwise.

**Response `200`:**

```json
{ "ok": true, "config": { ... } }
```

| Status | Meaning |
|--------|--------|
| `200` | Config saved |
| `400` | Validation error (invalid cron, relative path, etc.) |
| `403` | Feature disabled or MFA not satisfied |

---

### GET /api/admin/data/browse-dirs

Admin only. Lists the **immediate child directories** of an absolute path on the server's filesystem. Powers the backup
destination picker in the Settings UI.

| Query param | Required | Description |
|-------------|----------|-------------|
| `path` | — | Absolute path to list. Defaults to `/` |

`400` if the path is not absolute, or if any segment is still `..` after normalisation. A path the file system cannot list
is answered by what went wrong, in our words and never with the runtime's message: `404` when the directory does not exist,
`403` when it exists but the server may not read it (`EACCES`, `EPERM`), and `500` for any other file-system failure. It
returns directories only — never file contents — and it is admin-gated because it discloses the server's directory layout.

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

### POST /api/admin/data/migrate

> **Feature flag required.** This endpoint returns `403` unless the instance was started with `YTHRIL_DB_MIGRATION_ENABLED=true`. The flag is off by default so that a compromised admin token cannot be used to exfiltrate the entire database to an attacker-controlled server.
>
> **Not available when the URI comes from the environment.** When `MONGO_URI` is set to a non-empty value it overrides the
> configured URI, so a migrated URI saved to `config.json` would never be used: this endpoint answers `409 INFRA_MANAGED`.
> Change the environment variable in your deployment configuration instead. An **empty** `MONGO_URI` (the compose default) counts
> as unset, here and when the server connects ([`GET /api/admin/data/config`](#get-apiadmindataconfig) says `config` or `default`).
> `YTHRIL_MONGO_INFRA_MANAGED=true` refuses with the same code whatever the URI's source.

Copies the entire database into a new MongoDB database **online**, then moves the instance onto it. Like a
[restore](#post-apiadmindatarestore), a migrate is a set of space acts, one `migrate` act per served space, answered `202`:

1. **Refused before anything is registered:** a URI the environment supplies (`INFRA_MANAGED`), a restore or migrate standing,
   manual maintenance, an invalid or SSRF-unsafe URI, a target that cannot be reached, and a target that **already holds any
   collection** (`409 target_not_empty`; the answer never names what it holds). A migrate copies into an empty database only.
2. **Registered:** from the `202` every space is held (local writes answer `409` with `code: "space_being_migrated"`, peer
   exchanges wait) and the instance is in maintenance (`heldBy: "migrate"`).
3. **Copied, once for the whole set:** this database is dumped as a normal backup under `<data-root>/backups/` (listed, pruned
   by retention and encrypted by the one backup setting), that backup is loaded into the target, collection by collection,
   replacing whatever a crashed earlier attempt left there, and every index of this database is built on the target. Every
   operation of the copy is bounded (`YTHRIL_HOUSEKEEPING_OP_TIMEOUT_MS`), on this database and on the target.
4. **Completed:** the new URI is saved to `config.json` in the same write that removes the migrate acts. **From that write
   until the process exits, every write is refused** - `409` with `code: "space_being_migrated"` on REST and MCP, an
   instance-admin token's included, and an exchange, an embedding job or a housekeeping pass already under way is refused the
   same way - because this process is still connected to the old database, and a write there would be missing from the new
   one. Reads still answer. The process then stays in maintenance and **exits**, and the next start connects to the new
   database; under Docker or Kubernetes that is the restart policy. Nothing is read from the old database afterwards, and
   **it still holds every record** until you remove it.

The receive marks are kept: the data is the same data, so peers do not send anything again. A store outage or a timeout, on
either side, is retried, and so is a crash before the completion: the next start resumes the act on the old URI and copies
again. A target that never answers is therefore retried for ever: [abandon](#post-apiadmindatamigrateabandon) the migrate to
end it. A failure of the copy itself (the target refuses a record) ends the set: the old URI stays, every hold lifts, and the
report's `lastError` names the backup. The target may then hold part of the copy and must be emptied before another migrate.

```http
POST /api/admin/data/migrate
Authorization: Bearer <admin-token>
X-TOTP-Code: <code>   # required when MFA is enabled
Content-Type: application/json

{ "uri": "mongodb+srv://user:pass@cluster.mongodb.net/ythril" }
```

**Response `202`:** `{ "migrateId": "3b7e…", "spaces": ["general", "notes"] }`

The target URI is never answered, reported or audited; it is kept on the migrate's own record, sealed with the master secret
when the instance has one, and only until the set ends.

| Status | Code | Meaning |
|--------|------|---------|
| `400` | | Invalid or SSRF-unsafe URI, or the target cannot be reached |
| `403` | `FEATURE_DISABLED` | `YTHRIL_DB_MIGRATION_ENABLED` is not `true` |
| `409` | `INFRA_MANAGED` | The URI comes from a non-empty `MONGO_URI`, or `YTHRIL_MONGO_INFRA_MANAGED=true` |
| `409` | `target_not_empty` | The target database already holds data; empty it or name another |
| `409` | `space_being_restored`, `space_being_migrated` | A restore or a migrate already stands |
| `409` | | Manual maintenance mode is active; deactivate it first |
| `503` | | The server is shutting down |

### GET /api/admin/data/migrate

The migrate standing, or the last one; `{ "migrate": null }` when none ever ran. The same report as
[`GET /api/admin/data/restore`](#get-apiadmindatarestore), under `migrateId`, with `spaces[].state` `migrate_abandoned` for a
set a failure ended (`state: "abandoned"`, the reason in `lastError`), and `backupId` the backup the copy went through (also on
each completed space). Admin and MFA; audited as `data.migrate.report`.

### POST /api/admin/data/migrate/abandon

End a standing migrate that cannot finish - a target that keeps timing out is retried, never given up on by itself. The
migrate's acts are removed in one write, so every hold and the maintenance lift; **nothing is saved**: the instance keeps
using its old database, and the new one may hold part of the copy and must be emptied before another migrate. The report
marks the spaces `migrate_abandoned`. Admin and MFA; audited as `data.migrate.abandon`, and the set's end as
`data.migrate.failed`. The same abandon as [the restore's](#post-apiadmindatarestoreabandon), with the same answers.

**Response `200`:** `{ "abandoned": true, "migrateId": "3b7e…", "backupId": "2026-04-23T10-00-00-000Z", "released": ["general", "notes"], "completed": [] }`

| Status | `code` | Meaning |
|---|---|---|
| `404` | `no_migrate_standing` | No migrate stands |
| `409` | `migrate_act_running` | The copy is running now; abandon once this attempt has ended (an abandon never cuts an act short) |

#### Enabling migration on a deployment

Set the environment variable on the Ythril container:

```yaml
environment:
  YTHRIL_DB_MIGRATION_ENABLED: "true"
```

Omit this variable (or set it to any value other than `true`) on any instance where database migration should not be possible. This prevents a stolen admin token from being used as an exfiltration vector.

---
