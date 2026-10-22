# Data Management API

> Part of the [Ythril Integration Guide](../integration-guide.md). Instance administration outside the database is in
> [Admin API](12-admin-api.md).

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
  restore a file can be listed without its bytes, or bytes can be on disk that no record names. The restore does not repair
  that, and it says where it happened: each restored space's row of [`GET /api/admin/data/restore`](#get-apiadmindatarestore)
  carries a `files` report (below), changing no byte, record, tombstone or hash-cache entry (a tombstone written by a restore
  would delete the file on every peer).

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
      "edgeIndexes": { "failed": [] }, "vectorIndexes": "rebuilding",
      "files": { "checked": true, "classes": {
        "stale_row": { "count": 1, "paths": ["reports/q3.json"] },
        "row_without_bytes": { "count": 12, "paths": ["old/a.pdf", "old/b.pdf"] } } } },
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
| `spaces[].files` | What the restore found of the space's files against its restored records: `{ "checked": true, "classes": { <class>: { "count", "paths" } } }`, a class with no file absent, or `{ "checked": false, "reason" }` when the check could not run. Present on a `done` space of a restore only (a migrate's rows carry none) |

**`files` in detail.** The classes: `missing_row` (bytes on disk no live record names), `stale_row` (a live record whose `sha256`
is not the bytes'), `unprocessed` (a live record of a kind that is converted or analysed, with no processing state),
`row_without_bytes` (a live record that holds a `sha256` and finds no bytes on disk) and `soft_deleted_with_bytes` (a
soft-deleted record whose path has bytes again). `count` is every file of the class. `paths` holds at most 10 of them, fewer
when the whole restore's cap on named paths (200, shared equally between its spaces) is reached; each is quoted bounded (256
characters, escapes written out), and a path is in the record's normalised (NFC) spelling, so a name stored decomposed counts
once. A client that meets a class it does not know shows the raw name. Never compared: a conversion's sidecars, conflict copies,
schema snapshots, legacy read spills, chunk rows, and a record that holds no `sha256` (an import's). `checked: false` carries a
`reason` of ours, never the driver's text: the check ran past the file-system bound (120 s per space) or failed; the space is
restored either way, and the set stays `completed`. The check runs inside the space's hold, last, reads the cache without
writing it, and the report is kept on the set (in `config.json`) until the next restore, so it can name a file deleted since.
On the log, `restore of backup … completed` carries the total files out of step with their per-class counts, and one warning
names the spaces that were not checked; `ythril_restore_files_out_of_step_total{class}` counts the files per class, in total
([metrics](11-setup-api.md)).

Whether the file comes back is per file, not per class: on a space shared over a network a pull fetches a file again only
where a peer offers the same hash (a few files per space per cycle, in the direction the network allows), so a file no peer
holds, such as one uploaded here after the backup, stays out of step.

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
   until the process exits, every write to a space is refused** - `409` with `code: "space_being_migrated"` on REST and
   MCP, an instance-admin token's included, and an exchange, an embedding job or a housekeeping pass already under way is refused the
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
