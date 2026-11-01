# Settings — Storage, Data, Audit Log and Webhooks

> Part of the [Ythril User Guide](../userguide.md).

## Settings — Storage, Data, Audit Log and Webhooks

## Settings — Storage

**Settings → Metrics** shows how much disk space your Brain data and files are using against the configured quota. A usage bar with a **Healthy / Warning / Full** indicator shows how close total usage is to the limit; **Refresh** re-checks the current figures.

When usage approaches the quota limit, writes will first return warnings and eventually be rejected. Contact your administrator to raise the quota.

**Search results kept for download do not count.** A search whose answer is too large to show whole can keep the
rest for the person who ran it, for up to a day (see *When the answer itself does not fit* on the
[Brain](02-brain.md) page). Those are kept outside every space, have their own limits, and are left out of the
Brain figure here, so a busy day of large searches cannot fill the quota and block writes.

**They are a snapshot of the moment the search ran.** A record deleted or redacted afterwards can still be read in
a kept result, by the person who ran that search and nobody else, until it expires at most a day later. Deleting
or wiping a space removes every kept result holding its records straight away.

---

## Settings — Data

**Settings → Database** (admin only) gives you control over the underlying MongoDB database: maintenance mode, manual backups, point-in-time restore, and — when enabled by the infrastructure administrator — live database migration. An **overview strip** at the top summarises the database source, whether maintenance mode is on, how many backups exist, and the active backup schedule. The disruptive and irreversible operations — **maintenance mode** and **database migration** — are grouped in a red **Danger Zone** at the bottom of the page, separated from the routine backup controls.

### MongoDB connection

The **Database** card shows which MongoDB server this instance is connected to. The **source badge** indicates how the connection was configured:

| Badge | Meaning |
|---|---|
| **default** | Using the bundled `ythril-mongo` container. No custom connection has been configured. |
| **config file** | Connection string is stored in `config.json`, either saved here via migration or set manually. |
| **env var** | Connection is managed by the infrastructure via the `MONGO_URI` environment variable. The variable always takes precedence over `config.json`; set to an empty string it counts as unset. |

**Timeouts you put in the connection string win.** Three settings decide how quickly Ythril notices that the database has stopped answering: `connectTimeoutMS` (how long a new connection may take, **10 seconds** unless you say otherwise), `heartbeatFrequencyMS` (how often the server is asked whether it is alive, **5 seconds**) and `serverSelectionTimeoutMS` (how long an operation waits to find a server, **10 seconds**). If the connection string names one of them, that figure is used, whichever of the three sources above supplied the string; Ythril's own figure applies only to the ones the string does not name. Earlier versions silently ignored a `serverSelectionTimeoutMS` written in the string. The connection is opened once when Ythril starts, so **a change takes effect at the next restart**. The Server Log shows what was used, in one line at start, `MongoDB client options: …`, saying for each figure whether it came from `MONGO_URI` or is the default. Do not set `socketTimeoutMS` or `timeoutMS` lower than your slowest legitimate read: they end any operation that takes longer, a search or an export included. Do not set `retryWrites=false` either: Ythril uses retryable writes to make sure a timed-out transaction cannot keep records locked, and with them off the Server Log warns once at start (`MongoDB connection string: retryWrites=false …`).

**Starting before the database is ready is retried; a wrong password is not.** While the database is still starting, being restarted, stepping down or electing a new primary, unreachable, or has every connection in use, Ythril waits and tries again for a while. Each try says so in the Server Log with the database's own error name and code, for example `MongoDB not ready yet (MongoNetworkError, attempt 3); retrying in 1800ms.` A rejected login, a missing credential or a connection string that cannot be read stops the start at once with that error, because waiting cannot cure it. **Test Connection** under *Database migration* judges your string by the same rules: it waits **5 seconds** by default, and a string that names its own timeouts is tested under them, so a slow remote database can be given longer in the string.

**A write concern the database can never meet is a settings fault, not an outage.** If the connection string asks for
more acknowledgement than the deployment can give (`w=3` on a database with fewer members, or any `w` above 1 on a
single, unreplicated server), every write is answered with **500** and the message *The database cannot satisfy the write
concern this instance writes with, so the write was not confirmed*, together with the database's error `code` and
`codeName` and the words *not retryable*. This is the opposite of a `503`, which says that waiting
and trying again will work: here it will not. The Server Log names the cause, for each operation and code at most once
a minute; change the write concern in `MONGO_URI` (or the deployment) and restart. The write may already have been applied on the
database even though it was not confirmed, so look before repeating it. The same answer is given by the REST API and by
the MCP tools, with the `code` and `codeName` in the tool's structured result.

### Maintenance mode

Maintenance mode answers every API and MCP request with `503 Service Unavailable`, reads included, **except an instance
administrator's**: you keep working, and so do the health and metrics endpoints. Every other token, and every person signed in
without administrator rights, waits until it ends. The web interface itself still loads for anyone, so you can always open it
to end maintenance or a stuck restore; everyone else sees it but cannot read or change data through it.

Use it before a manual database operation where you want nobody else writing. A restore and a migration do not need it: each
puts the instance in maintenance by itself, from the moment you confirm until the last space is done, and takes it out again.
That half cannot be switched off with the toggle (the page says what is holding it), and a restart that resumes the restore
resumes maintenance with it.

Under **Maintenance Mode**, press **Activate** to turn it on and **Deactivate** to turn it off. A banner appears across the top of the UI on all pages while maintenance is active.

### Backups

Click **Back Up Now** to trigger an immediate point-in-time dump of the entire MongoDB database. The backup is stored inside the instance's data directory (`<data-root>/backups/<timestamp>/`). Each backup contains a `manifest.json` with metadata and one NDJSON file per collection.

The **Backups** table lists all available backups with their timestamp and the collections they contain.

**A backup never contains the search results kept for download.** They belong to the person who ran the search
and last up to a day; in a backup they would outlive that day — including records deleted or redacted since —
for as long as the backup is kept. So they are left out of every backup, manual, scheduled and offsite, and a
restore leaves the ones currently kept alone.

**Personal views are not in a backup.** A backup is a copy of the database, and personal views live in `config.json`, which it does not hold. After a restore, bring `config.json` back with the rest of the instance's files to get the views back; the same file also carries the instance's version mark for each space (`versionMarks`, written by the server, not for editing), which is what keeps new edits above the versions already handed out. The 6.0 upgrade keeps the file it started from as `config.json.pre-6.0` beside it. Deleting a space takes it out of every view that listed it, so an id created again later never silently rejoins one.

### Scheduled and offsite backups

> **This feature must be explicitly enabled by your infrastructure administrator** (`YTHRIL_DB_MIGRATION_ENABLED=true`). It is disabled by default.

Configure automatic backups and an optional offsite destination from **Settings → Database** using the **Backup Destination** and **Scheduled Backups** cards. Settings are saved to `backup.json` (alongside `config.json`, typically `/config/backup.json`). You can also create or edit this file directly — see `config/backup.example.json` in the repository for the full schema.

**Example `backup.json`:**

```json
{
  "schedule": "0 2 * * *",
  "encrypt": false,
  "retention": {
    "keepLocal": 7
  },
  "offsite": {
    "destPath": "/backups",
    "retention": {
      "keepCount": 14
    }
  }
}
```

| Field | Description |
|---|---|
| `schedule` | Cron expression for automatic backups (e.g. `"0 2 * * *"` = daily at 02:00). **Takes effect when you save — no restart.** It did not always: saving a schedule wrote the file and reported success, and the instance kept running on whatever schedule it had when it started, so turning backups on for the first time produced none at all until a restart. |
| `encrypt` | Encrypt every record in a backup with the instance master secret. **Default: `false`** (plaintext). Requires `YTHRIL_MASTER_KEY` or `YTHRIL_MASTER_PASSPHRASE`. Applies to manual, scheduled **and** offsite backups. See [Encrypted backups](#encrypted-backups) below. |
| `retention.keepLocal` | Maximum number of local backups to retain. Oldest are deleted after each run. **Default: unlimited** — local backups are never pruned unless you set this. |
| `offsite.destPath` | Absolute path **on the server's filesystem** to copy each backup to. See [Configuring the offsite path](#configuring-the-offsite-path) below. |
| `offsite.retention.keepCount` | Maximum number of offsite backup sets to retain. **Default: 14** — offsite sets older than the 14 most recent are deleted after each run. Set this explicitly if you are keeping long-term archives. |

### Encrypted backups

A backup is a **complete plaintext copy of the database** by default — every fact, entity, edge, chrono entry,
file-meta record and audit entry. Note that an encrypted `mongod` does not protect it: the dump is read *through*
mongod, so it comes out decrypted. Setting `encrypt: true` (or the toggle on **Settings → Database**) encrypts every
record with the instance master secret, using the same AES-256-GCM envelope as the encrypted state files.

**It is off by default, deliberately.** A backup you cannot restore is not a backup, and encrypting by default
makes disaster recovery onto a *fresh* instance depend on having the old secret to hand **before** the restore.
Some operators also back up precisely so they can inspect or migrate the data with other tools.

Three things to know before enabling it:

1. **Losing the secret makes the backup unrecoverable.** That is by design, not a bug to work around. Store the
   secret somewhere other than the instance it protects.
2. **Encrypted backups are larger** — roughly 1.4× on large records, and measured at **3×** on a database of many
   very small ones, because each record carries a fixed envelope header. Check your disk headroom.
3. **Restoring needs no setting.** An encrypted backup is detected per record, so you never have to remember how
   one was written. A backup whose `manifest.json` is lost or unreadable is refused before anything is replaced, as is
   one whose files do not match it. If the secret is missing, the restore refuses with a message naming the
   environment variables to set, rather than importing ciphertext.

Enabling it without a master secret configured fails the backup **before writing anything**, rather than leaving a
half-plaintext directory that looks like a valid backup.

### Exporting and importing one space

A whole-database backup restores everything. To move or restore **one space**, an administrator uses the space
export and import ([Admin API → Export Space](../integration-guide/12-admin-api.md#export-space)). The export carries
every kind of record the space syncs — facts, entities, edges, chrono entries, links and file metadata (not the
file bytes) — and the import puts them back. What to expect from a restore:

- **It replaces.** A record already in the space is overwritten by the exported copy, even when the space holds a
  newer one — that is what restoring a backup means.
- **Retention survives the round trip.** Each record keeps the expiry it had when it was exported. A record that
  had none is given this space's retention window, counted from when the record was created.
- **Unresolved versions travel with the space.** A fork (the other instance's version of a fact, entity, chrono entry or edge, kept for you to decide in Review) is an ordinary row of its collection, so the export carries it and the import restores it, still unresolved. A version another instance already resolved, which this instance still owes a decision on (Review lists it as "resolved elsewhere"), comes back with that mark. A restore into a space whose edge index is still being rebuilt after an upgrade may answer that it is not ready for a version of an edge: run it again once the rebuild has finished.
- **Restoring an export that holds unresolved versions into an older (5.x) instance is not supported.** Those versions would show there as ordinary duplicate records. Resolve them in Review, or delete them, before the export.
- **A one-per-subject label's lock is not exported.** Edges come back without Ythril's internal lock for such a label.
  That is harmless: the label's rule still refuses a second edge written after them.
- **Search comes back on its own.** Vectors are not exported; every restored record is queued for embedding on
  this instance, so nothing has to be reindexed by hand.
- **What you deleted here after the export stays deleted.** A record or file this instance deleted after the export was
  taken is not put back; the answer lists it as deleted on restore.
- **Nothing is refused silently.** A record the import could not store is listed by id with the reason; a record
  restored over a deletion another instance made is listed too: the next sync applies that deletion again where the
  network still holds it. A record already past its expiry is listed as due, because the next sweep removes it.
- **A record that breaks this space's schema is restored anyway, and reported.** A backup taken before a schema was
  tightened must still restore. In a space whose validation is **warn** or **strict**, the answer lists the first 50
  such records by id with the field and reason (never the value) and says how many there were in all; **off** reports
  none.
- File previews and passages are rebuilt from the file itself, so they are not part of the export.
- **The file bytes are not part of it, and an import gives no report on them.** A file's record comes back without its
  size and hash, so the import does not say which files on disk no longer match their records. A whole [restore](#restore)
  does.
- **The next sync catches up with the network, as for an instance that was offline since the export.** The import
  forgets what this space had received from its peers, so they send everything again: a newer version a peer holds
  replaces the restored copy, and a deletion a peer still holds is applied again. A record the export does not hold is
  left as it is, not removed. A whole [restore](#restore) differs: it brings back records deleted after its backup too.
- **Any size, one at a time.** The export can be as large as the instance allows (`importBodyMaxBytes`, 1 GiB by
  default, and `importMaxDocuments` records, 5 000 000 by default), compressed or not. While an import runs, the space
  takes no other writes, and a second import sent meanwhile, into any space, is refused (`409`, `space_being_imported`):
  send it again once the first has finished. A very large one may answer that it is still running; its result is then
  in the audit log.
- **Sync agreements travel only with this instance's own export of this space.** An export from another instance or
  another space leaves out which file versions this instance had agreed with each peer; a file that differs from a
  peer then shows as a conflict copy instead of being replaced, and nothing is lost.

### Uploaded files are encrypted at rest

When the instance has a master secret (`YTHRIL_MASTER_KEY` or `YTHRIL_MASTER_PASSPHRASE`, set by whoever runs the
server), every file uploaded to a space is stored **encrypted on disk**. Nothing changes in the app: files upload,
download, preview, sync and get indexed exactly as before, and their sizes and checksums are the ones you uploaded.
There is no setting in the UI — the secret is the switch.

- **Files uploaded before the secret was set** are encrypted in the background after the server starts, one at a
  time. They keep working normally while they wait.
- **A file that cannot be decrypted says so.** Its download fails with a message naming the file, and its indexing
  is marked failed rather than retried. This happens when a file was written under a different secret, was altered
  on disk, or when the secret has been removed from an instance that encrypted its files. Restoring the secret it
  was written with makes it readable again.
- **Syncing to another instance sends the file itself**, and that instance stores it by its own setting — two
  instances in one network do not need the same secret.
- **What stays readable on disk:** file and folder names, and roughly how large each file is.
- **Indexing an encrypted file needs disk, briefly.** To read a picture, a recording or a document, the indexer first
  writes itself a decrypted copy in the storage folder's own scratch area, and removes it when the job ends. So leave
  room for one copy of your largest file for each indexing job that can run at once — that number is
  `workerConcurrency` under Settings → Media Processing. Files stored WITHOUT a master secret need no copy at all. A
  leftover copy from a server that was killed mid-job is cleared the next time the server starts.

The server's security report (`GET /api/about/security`, and the boot log) shows the state as `atRest.files`. The
full operator reference, including rollback and Kubernetes notes, is
[Encryption at Rest](../integration-guide/02a-encryption-at-rest.md#uploaded-files).

> **The two retention settings default in opposite directions.** Local backups are kept forever until you set `keepLocal`; offsite sets are pruned to the 14 most recent unless you set `keepCount`. If you rely on the offsite copy as a long-term archive, set `keepCount` to the number of sets you actually want — otherwise older ones are removed on the next run.

Each backup set at the offsite destination contains:

- `<backupId>/` — MongoDB NDJSON dump (same format as local backups)
- `<backupId>-files/` — copy of `<data-root>/files/` (user-uploaded files), if present. It is a copy of what is on
  disk, so on an instance with a master secret it holds the files **encrypted**, and restoring it needs the same
  secret — see [Uploaded files are encrypted at rest](#uploaded-files-are-encrypted-at-rest).

All fields are optional. Omit `offsite` to disable offsite copying; omit `schedule` to disable automatic scheduling — which also takes effect on save, so clearing it stops the next run rather than the next boot.

#### Configuring the offsite path

`offsite.destPath` is an absolute path on the **filesystem visible to the Ythril server process** — not a path on your workstation or host machine. How you make external storage appear at that path depends on how you run Ythril.

---

##### Docker Desktop on Windows

Docker Desktop runs containers inside a lightweight Linux VM. Windows paths (`C:\…`) are not directly visible inside the container. You must add a volume mount so that a Windows folder appears at a Linux path inside the container.

Add (or create) `docker-compose.override.yml` in the project root:

```yaml
services:
  ythril:
    volumes:
      - C:/Users/YourName/Backups/Ythril:/backups
```

Then set **Backup location** to `/backups` in the UI. Docker Desktop translates the Windows path automatically — no further configuration needed.

> `docker-compose.override.yml` is already listed in `.gitignore`, so your local paths will never be accidentally committed.

---

##### Docker on Linux / macOS

Mount any local directory, USB drive, or network share as a volume:

```yaml
services:
  ythril:
    volumes:
      - /mnt/usb/ythril-backups:/backups
      # SMB/NFS pre-mounted on the host work the same way
```

Set **Backup location** to `/backups` (or whatever container-side mount path you choose).

---

##### Kubernetes

Mount a PersistentVolumeClaim, NFS export, or `hostPath` into the Ythril pod at a chosen mount path, then set `offsite.destPath` to that mount path:

```yaml
# In the Ythril Deployment spec:
volumeMounts:
  - name: offsite-backup
    mountPath: /backups
volumes:
  - name: offsite-backup
    nfs:
      server: nas.local
      path: /exports/ythril-backups
```

---

##### Workstation mode (no Docker)

Ythril runs directly on your OS. Set **Backup location** to any absolute path your OS user can write to:

- Linux / macOS: `/mnt/usb/ythril-backups` or `/home/user/backups`
- Windows: `D:\Backups\Ythril`

> Ythril does **not** create the directory automatically — ensure the path exists and is writable before saving the destination.

### Restore

To restore a backup, click **Restore** on any backup row. A restore makes **every space equal to the backup**, and it
checks the backup before anything is replaced. A backup with a missing file, or one encrypted with a secret this instance
does not have, is refused at once and nothing changes. A backup with a broken record is accepted at once, because reading every
record can take long; the first space's part reads the whole backup before any space is replaced, and when a record is
broken every space fails, nothing is replaced and the page offers to **abandon** the restore. A space the backup holds that this instance no longer serves
(renamed or deleted since) is refused by name unless you leave it out; a space created after the backup is emptied.

Once you confirm, the request is accepted at once and the work runs in the background, one space at a time:

1. The instance enters maintenance mode, and every space stops taking writes until its own part of the restore is done. You,
   as an administrator, keep working, and can write to a space that is done while others are still running; everyone else
   waits until the last space is done. The page shows how many spaces are done, and why any is waiting.
2. Each space's data is replaced with the backup's, and **every index the space has is built again**: the search
   indexes, the ones that keep the retention sweep from reading every record of a collection, and the unique ones that
   stop the same edge, the same link, or two edges under a one-per-subject label, being stored twice by writers working
   at the same moment. Its version numbers keep continuing above every number this instance already handed out, even when
   the restore starts from an empty database: the instance remembers that high-water mark in `config.json`, and the space's
   first edit after the restore starts above it. An index that
   cannot be built stops that space's part of the restore - every index except two kinds, and every unique one, the
   one-per-subject lock included: the space keeps refusing writes, the server log names the index that failed, and the
   space is tried again on its own. The two kinds a space is restored without, each named in the server log, are the
   retention sweep's indexes (the next sweep cycle builds them) and the keyword index of search (`lexical_text`).
3. Each space asks its peers again for what reached this instance after the backup was taken: the peers send it back.
4. When the last space is done, maintenance ends. A restart in the middle resumes where it stopped.

**What a restore does not bring back:** the audit log, which keeps recording what happened (the restore included); the
queues and webhook subscriptions; and the files' bytes on disk. A file's details come back as the backup has them while
its bytes stay as they are now, so after a restore a file can be listed without its bytes, or bytes can be on disk that no
file names.

**What a restore onto an empty database still cannot promise.** Edits made after the restore are stamped above the versions
this instance handed out before, so peers keep them. Four things remain:

- If the server crashed shortly before the database was lost, or `config.json` was not saved in time, a few of the newest
  version numbers can be reused, and a peer may keep its own copy of a record you edited in that stretch.
- If `config.json` is lost together with the database, or an older copy of it is put back before the first start, nothing
  remembers the numbers; the records are then sorted out by id and version when the peers next meet. Keep the two files together.
- A record you edit before a peer's newer copy of it has arrived takes the higher version and replaces that copy on every
  peer, without a conflict to review.
- Version numbers can jump by up to 100,000 after a server start or a restore. They are only compared, so nothing else changes.

**What a restore tells you about files.** Once a space's records are back, the restore compares that space's files on disk
with its file records and lists, per space, the files that no longer match. It only reports: it changes no file, no record
and no cache, and it never deletes anything, because a deletion written by a restore would also delete the file on every
peer. The page shows it on each space's row (a row with files out of step is marked as a warning, and **Show file names**
opens the names), and the same report is in the answer of `GET /api/admin/data/restore`
([Data management API](../integration-guide/12a-data-management-api.md)). A file is in one of these groups:

- **No record** - bytes on disk that no file record names, for instance a file uploaded after the backup.
- **Record names other bytes** - the file was changed after the backup.
- **No processing** - the record shows the file was never converted or analysed, though its kind is.
- **Record without a file** - the record says it holds bytes and none are on disk, for instance a file deleted after the backup.
- **Deleted file on disk again** - a file the backup records as deleted has bytes again, for instance uploaded again.

Each group gives its exact count and at most ten names, and the names listed across the whole restore are capped, so a
space with a great many files out of step lists the first of each group and still counts all of them. Names are shortened
when very long. The report is kept until the next restore and can name files that have been deleted since; the completion
line in the server log carries the total.

If the comparison could not finish for a space - it ran past its two minutes, or could not run at all - the row says that
the files of that space were not checked and why, and the space is restored all the same. The server log names the cause;
restoring the backup again repeats the check.

A space whose files could not be compared in time (the time allowed is two minutes) or at all says so on its row instead,
and the restore still completes. Files kept by this instance alone - conversion results, conflict copies, schema
snapshots - are not compared.

If a space is shared over a network, the file may come back by itself: sync fetches a file again when a peer holds exactly
the same bytes, a few files per space per cycle, and only in the direction the network allows. A file no peer has, such as
one uploaded here after the backup, stays as it is until you deal with it.

**What it does bring back, and you may not expect:** records erased after the backup, erasure requests included. The audit
log still records the erasure, so erase them again. A record deleted here after the backup that the peers have since
forgotten deleting comes back here and stays here.

Restore is irreversible — all data written after the backup timestamp will be lost. You will be asked to confirm before the operation begins.

**If a space cannot be restored** because the database is down or slow, or a backup file could not be read at that moment, it is tried again by itself. If the backup is the
problem (a file that was cut short or damaged, records one of the space's indexes refuses), retrying cannot help: the page says so,
and you can **abandon** the restore. The spaces that were not done are released as they are, and may be half restored; the
page names them. A backup is never taken while a restore runs.

If a search index cannot be rebuilt, the space is still restored and the page says its search is not ready; the index is
tried again at the next start.

### Database migration

> **This feature must be explicitly enabled by your infrastructure administrator** (`YTHRIL_DB_MIGRATION_ENABLED=true`). It is disabled by default on all instances.
>
> **Infrastructure-managed connections are locked.** When a non-empty `MONGO_URI` comes from the environment it decides the database, so a migration is refused: the URI it would save could never take effect. Change your deployment configuration (the `MONGO_URI` your orchestrator injects) and restart instead. An empty `MONGO_URI` counts as unset. `YTHRIL_MONGO_INFRA_MANAGED=true` refuses migration whatever the URI's source.

Database migration moves the entire database to a different MongoDB server — for example, from the bundled container to Atlas, or between clusters.

Enter the target MongoDB URI and click **Test Connection** to verify reachability before committing. The target must be an
**empty** database: one that already holds anything is refused, and nothing is copied. Once you click **Migrate**, the
request is accepted at once and the copy runs in the background:

1. The instance enters maintenance mode and every space stops taking writes; you, as an administrator, keep working.
2. The current database is backed up like any other backup (it appears in the **Backups** table), and that backup is copied
   into the new database with every index. A copy that is tried again takes a fresh backup and removes the one its earlier
   attempt took, so a migration leaves exactly the backup it names; an earlier attempt's offsite copy stays until the offsite
   retention removes it.
3. The new URI is saved to `config.json`, and the server process exits. From that moment until it exits, **no space takes a
   write**, not even from an administrator: any change to a space's data answers that the instance is being migrated,
   because it would land in the old database and be missing from the new one. Reading still works. When Docker or Kubernetes restarts the container,
   the server connects to the new database. Without a restart policy, start it again yourself.

If the copy fails, the instance stays on the old database, maintenance ends and the reason names the backup; the new database
may hold part of the copy and must be emptied before you try again. A database that is slow or briefly unreachable is
retried by itself - and one that never answers is retried for ever, so the migration card offers **Abandon migration** while
its copy is waiting to be tried again. Abandoning saves nothing: the instance keeps using its old database, every space takes
writes again and maintenance ends; empty the new database before you migrate again. Peers notice nothing: the data is the
same, so nothing is sent again.

**The old database still holds every record afterwards.** Nothing reads it any more; keep it until you have confirmed the
migrated instance is healthy, then remove it yourself.

---

## Settings — Audit Log

**Settings → Logs** (admin only) shows a searchable log of every API operation on this instance. A deletion or wipe a passed vote applied here is recorded as `network.round.space_act`, a passed space addition that a later deletion of the same space retired, so it was never applied, as `network.round.addition_retired`, and a deletion, wipe or rename a request queued and then finished as `space.act_completed` (so is each space's share of a restore); a concluded vote round is `network.round.expired`. A restore is recorded when you ask for it (`data.restore.requested`) and once more when it ends (`data.restore.completed`, or `data.restore.abandoned` naming the backup); a migration likewise (`data.migrate.requested`, then `data.migrate.failed` here or `data.migrate.completed` in the new database's log; abandoning one is `data.migrate.abandon`). The page has two sub-tabs, toggled at the top: **Audit Log** (the operation table below) and **Server Log** (the live server log described at the end).

**Filtering:** Filter by date range, operation type, space, HTTP status, or client IP.

**Table:** Each row shows the timestamp, which token or user made the request, the operation, the space, the HTTP status, and the response time. Click the **Detail** button on a row to open a structured panel with every field (timestamp, token/user, operation, method + path, status, IP, duration, space, entry ID, request ID) plus the full raw entry in a collapsible **Raw JSON** section.

**Request ID** is the value that ties this row to the server log. It is the same id the response returned in its `X-Request-Id` header, and every line the Server Log tab shows for that request carries it — so when somebody reports a failing call and quotes the id, the detail panel's **find this request** button narrows the table to that one row, and searching the same id in the Server Log finds everything that request did on the way. Older entries show **not recorded**: they were written before the field existed, which is not the same as there having been no request.

**What changed:** for some operations the detail panel also lists the field values the request altered —
field, from, to. Two things are worth reading carefully:

- *not set* in the **From** column means the field did not exist before, which is different from a value of
  `null` (it existed and was cleared). Both are shown as written, never as a dash.
- Some operations show **"field-level changes are not recorded for this operation"**. That is not the same
  as *nothing changed*. Only explicitly listed fields are ever recorded, so that operations handling
  credentials — creating or regenerating a token, configuring a webhook or a model endpoint — cannot write
  a secret into a log that admins can read and that is retained for months. When you need to know exactly
  what a request contained, the resource's own history or your reverse proxy's logs are the place to look;
  the audit log deliberately does not keep it.

**Keeping one side of a fork is recorded with both sides.** The entry for Review's resolve (`fork.resolve`) names the kind, which side was kept, the record and the fork, and holds the body that was kept and the body that was discarded. When you keep the other version, the discarded text survives only there, so it follows the audit log's own retention (Settings → Logs): once those entries are cleared, it is gone.

**A change to a space's schema is listed by name.** An edit of a space (operation `space.update`, whichever way it was
made — the settings dialog, the API or an assistant) shows which **types, properties and rules** were added or removed
(*typeSchemas.entity.service.rules* — *added: adult*), and a change to the space's own rules as *rules*. Names only: a
rule's expression and message are never recorded, because an expression names the properties it reads and a message is
whatever its author wrote. A type the edit did not mention is not shown as removed. Setting the stamp check to `0`
minutes (`stampSkew.warnMinutes`) is a recorded field of the same row. **A call an assistant made that was refused or failed is a
row too**, at the status it got (and with no change list, because nothing changed), so a refused attempt is as visible
here as one made through the API. Reads are included when the audit log is set to record reads, the same rule as the API. A **schema check** (`space.schema.validate`) is recorded only when the audit log is set to record reads.

**Doors that move a whole space, and the work the server does by itself, are in the log.** Taking an export of a space (`space.export`, written even when the audit log is not set to record reads, and written once, with `complete: false`, when the download is cut off before its end), restoring one (`space.import`, with the totals of what landed, what was refused, what the restore left out because this instance deleted it after the backup, and what landed already past its expiry), rotating the signing key (`signing.rotate`, with the new key's fingerprint and never a key) and a client's approval to act with a token (`mcp.oauth.consent`, naming the approving token, the client and the outcome) are each an entry. So are an entity the duplicate scanner merged into another on its own (`duplicate.automerge`, the survivor as the entry and the absorbed entity's id in its changes) and the retention sweep's deletions (`ttl.expire`, above); both have the address `internal` and no token.

**Personal views are in the log too, and the log never names them.** Making, renaming, deleting, copying or claiming a personal view is a row (`view.create`, `view.update`, `view.delete`, `view.copy`, `view.claim`) that holds the owner's key and **how many** spaces the view lists — never its name and never which spaces, because a view is its owner's and the log is read by an admin. A **read through a view** is one row with no single space: the row's **spaces** field lists the spaces that read actually reached, and the row counts one call in the Usage panel of each of those spaces and nothing under the view. Like any read, it is written only when the audit log is set to record reads. Releasing a reserved id after the 6.0 upgrade is `space.retired_id.purge` (see [Settings → Spaces](04-settings.md#after-the-60-upgrade-what-became-of-the-read-across-spaces)).

**Metrics to alert on for schemas.** `ythril_schema_rules_invalid` above `0` means a stored rule no longer compiles
and is *skipped, not enforced* (`space_meta` names it): fix or remove it. `ythril_schema_rule_engine_available` at
`0` means no rule can be evaluated, so strict spaces refuse the writes their rules govern, and the security posture says so.
`ythril_schema_refusals_total` counts refused writes by door and outcome; a rising `undeclared` is a client sending a
property the schema does not declare. `ythril_unknown_write_fields_total` counts brain writes that carried a top-level field the write does not take, by the space's setting (`warn` or `refuse`) and by whether the write was refused. `ythril_schema_violations_recorded_total` counts documents from peers or a restore that
were stored carrying what this space's schema does not accept, and `ythril_schema_recorder_failures_total` counts the times that
recording itself failed (the write still landed). The full list is in
[Prometheus metrics](../integration-guide/11-setup-api.md#prometheus-metrics).

**Old saved search results removed from spaces.** Versions before 5.6.0 kept a search's cut-off results as a
file inside the space, under a hidden `_tmp` folder, and those files travelled to every other instance in a
network. Since then nothing is written into a space by a search, and a clean-up every few minutes removes the old files —
the ones written here and the ones that arrived from other instances. For each space it cleans, the log shows
one entry, operation `file.legacy_spill.sweep`, with the space named and no token, because the instance did it
itself. It sends no webhook and tells no other instance, and it cannot be undone. Reading kept results
appears as `brain.spill.read`, and only when the instance is set to log reads.

**A network space's name repaired from its upstream.** An instance that joined a network before 5.6.0 could hold a
space the publisher had renamed without knowing the network still calls it by its old name — so the space arrived a
second time under that old name. When this instance's upstream (its publisher, or its parent in a tree) now names
the space both ways, the instance records the missing link itself and logs one entry per space, operation
`network.space_alias.heal`, with the space named and no token. Nothing is created or deleted by it.

**File descriptions recovered from an old sync collection.** Versions 4.0 to 5.6.1 stored the descriptions and tags
other instances sent for their files in a side collection, where nothing read them. A clean-up every few minutes now
copies them onto the files they belong to. On a file this instance recorded itself it only fills in what is missing,
and never overwrites a description or tags the file already has; the one exception is an automatic caption, which
gives way to the sender's own wording. A file another instance described keeps the usual rule: the newer version
wins. A file this instance does not hold yet keeps its description waiting for up to 30 days, in
case the file still arrives. A record that is damaged (a value of the wrong kind, or a piece of a file rather than
a file) is discarded instead of copied. Once nothing is left, the side collection is removed. That removal cannot be undone and
appears as one entry, operation `file.stray_filemeta.drain`, with the space named and no token. In the same way, the
converted and extracted files a peer delivered before each instance made its own are removed in the background, and each
space that had any appears once as operation `file.peer_sidecar.retire`.

**Exporting:** Download the current filtered view as JSON or CSV.

**Live server log:** the **Server Log** sub-tab streams the instance's log in real time over Server-Sent Events (SSE). It loads the recent lines and then appends new ones as they happen, colour-coded by level. If the tab falls far
behind — a sleeping laptop, a stalled connection — the server drops the stream rather than queue lines for it, and
streaming stops; turn it on again to resume. At most 200 such streams are open on an instance at once.

**Every line is one line, and none is longer than it can be read.** A value that came from outside this instance —
a peer's label, a document id, a parameter somebody sent, a database error — is shown escaped (a line break reads
`\r\n`), with any credential replaced by `[redacted]`, and cut after a few thousand characters with `…(+N chars)`
saying how much was left out; a long list of ids shows the first ones and `…(+K more)`. So what looks like a line of
this server's own is one, and a peer sending a megabyte id cannot fill the log. An error's stack trace stays on its
line, escaped, after the message.

**Every line an API request's own work produces carries that request's id**, shown in square brackets after the level. It is the same id the response returned in its `X-Request-Id` header, so when somebody reports a failing call and quotes the id, searching for it here finds every line that request produced — the refusal, and anything a background step logged on its way. Lines that belong to no request (startup, the auto-delete sweep, the background storage measurement) carry no id, which is what keeps a search for a real one from matching them. That holds for a job a request happened to start, too: the auto-delete sweep begun by the first-run setup, or a scheduled scan a configuration reload re-arms, never logs under that request's id.

**`record position held …` names a write that held up replication.** While a write is being stored it holds the position it took for
its record, and every peer pulling that space is served nothing past that position until the write
ends. Each database operation inside that hold is ended after `YTHRIL_WRITE_TIMEOUT_MS` (30 seconds by default). A write that took longer than half its limit (`YTHRIL_HOLD_DEADLINE_MS`) is named once while it is still
open — `record position held 23.0s and still open: space=… pos=… holder=…` — and again when it ends:
`record position held 45.1s space=… pos=… holder=… ended=timeout`. `holder` says which kind of write it was
(`fact.update`, `sync.push.fork`, `entity.merge`, …); `ended=` says how it ended: `ok` (slow, but it finished),
`timeout` (the database did not complete it in time, so it was stopped and the caller told to retry) or `error`.
One such line now and then is a slow moment; the same space appearing repeatedly is a lock or a stalled
database connection to look into. The gauge `ythril_record_position_oldest_hold_seconds` shows the same thing as a
number per space.

**An instance whose clock reads before 2005-09-05 refuses every edit** with `503` `positions_clock_unusable`: each record this instance stores
is given the time it was stored as its place in this instance's own order, and a clock set before that date cannot give one. Reading and
syncing carry on and the server's readiness is unchanged; correct the clock and the next edit goes through. The gauge
`ythril_position_clock_unusable` is `1` while the refusal stands. (`503` `positions_seed_unavailable` is the same refusal for the moment the
database cannot be asked where this instance's order stands; it goes by itself once the database answers.)

**`file tombstone position held …` names a deletion that held up the deletions after it.** While the record of a
file's deletion is being stored, peers are sent no deletion of that space placed after it, so none can be skipped.
The line has the same shape and the same limit as the one above — `at=` is the deletion's place instead of `seq=` —
and the gauge `ythril_file_tombstone_oldest_hold_seconds` shows it as a number per space. Seen repeatedly, file
deletions in that space are not reaching peers.

**`File tombstone clock seed failed for space …` says a deletion was stamped from the server's clock alone.** The clock normally starts above the
highest place already handed out; when the database cannot be read for it, the deletion still goes ahead, stamped from the wall clock, which is
safe only while that clock is not behind an earlier run. The line comes once per window, and `ythril_file_tombstone_seed_fallback_total` counts
every such stamp per space.

**`Write bound: the server did not answer … by its own deadline` names a write the database had to be told to drop.**
A write that is stopped (`ended=timeout`) is stopped by the database at its limit; if the database has not
answered half a second after that — it is blocked behind another session's uncommitted insert, or the request reached it
late — the server stops waiting, ends the database's operation itself (finds it by a tag it put on the write, kills it, and
checks that it is gone, for at most 0.4 s) and only then tells the caller to retry. The line says which: *killed and gone*
(a warning, nothing to do) or *could not be confirmed gone* (an error: the write may still be running in the database and
could land after the caller was told it timed out — look at the database server and at who holds the lock).

**A deletion from a peer that this instance did not apply is said once, and counted.** A peer's deletion is applied only
where the rule allows it: the peer that delivered it issued it and wrote the record, or the peer is your publisher (or your
parent in a tree) and delivered that record to you, and never when you wrote the record yourself. Otherwise the log says so in
one warning that names the peer, the space and the reason, held back to one line per peer, space and reason per window
however often it comes again, and `ythril_sync_tombstones_declined_total` counts every one by `kind` and `reason`. On a club
or closed network this is routine, because every instance sends every deletion it holds and a peer applies only the ones it
may. Below a publisher it is the line to read: it means a deletion your publisher made did not reach a record here, and the
reason says whether you wrote that record, whether it arrived by another route, or whether it was not the publisher's.

**A deletion your publisher or parent made, applied here, is said once per sync page**: one info line naming the upstream,
the space and how many records it deleted (the one-time re-read below says it once per space instead, when it finishes); `ythril_sync_tombstones_applied_total{ground="upstream"}` counts them. It is
the line to look for when a record you did not touch has gone: it was deleted above you, whoever wrote it.

**After an upgrade, each space re-reads its publisher's deletions once, and says when it has finished.** The first sync
cycles of a space after the upgrade stamp the records stored before it (which peer delivered each one) and then read the
upstream's deletions from the beginning, applying the ones an older version declined. A space whose re-read finishes logs one info
line naming the space, the upstream and how many records it deleted (even none), and `ythril_sync_tombstone_rereads_owed` falls as spaces
finish; a re-read that cannot proceed (the upstream refuses, or answers an error) is named once and stays owed, so a gauge
that does not reach `0` is a stopped re-read, not a slow one. No audit entry is written for it. **What it cannot recover:** a
deletion the upstream no longer holds, because it had pruned it once every member counted as past it. The record that
deletion would have removed is still here, and nothing marks it. To find such records, compare the space's record counts with
the publisher's, or set `merkle: true` on the network (an integrator's setting, [Sync Protocol](../sync-protocol.md)): a space whose
content differs after a sync is logged as `MERKLE_DIVERGENCE`, naming it. Delete what the publisher no longer has. (A divergence on files that outlives every upgrade has a second possible cause, below: `file_stamp_report`.)

**Two instances that hold the same file can disagree about when it was last changed, and that now settles itself.** A
file record carries the moment it was last edited, and that moment is part of what instances compare — so a difference
in it alone made them report their data as different when nothing about the file was. When the instance that WROTE the
file sends you its copy, and everything else about the two copies is identical, yours takes the writer's moment and the
disagreement is over. Only the writer's own delivery counts: a copy passed on by somebody in between carries that
instance's moment, and taking it would make the two of you swap values for ever. Nothing else about the record changes,
and nothing is re-indexed.

**A record that already disagreed is fetched again — when the network compares content.** An ordinary sync only asks for
what changed since the last one, so a file that drifted before is never sent again. With `merkle: true` on the network,
a sync that finds the content differs makes the next sync ask that peer for all of its file records once more, and
each drifted one settles as above. It is said in one info line per peer and space when it has read them all (how many
it read, how many settled), and `ythril_sync_file_meta_rereads_owed` counts the ones still to make. If a few full
re-reads leave the content still different, a warning says so once, naming how many, and it stops asking: what is left is not a
timestamp it can take from the writer — a file whose writer has left the network, or a real difference to look at.
Without `merkle: true` nothing is re-read, and such a file settles at its next edit.

**A divergence that stays on `files` after every member has upgraded may be a file an old version stamped as its own — and there is a report for it.**
Between 4.0 and 5.5 an instance that pulled a file from a peer stored it under **its own name** and its own version
number. That is closed now, but the rows it wrote are still there: this instance refuses the real author's later edits
to such a file, and a network with `merkle: true` logs `MERKLE_DIVERGENCE` every cycle for a space where nothing else is
wrong. Nothing repairs them automatically, because a stamped file cannot be told, from this instance alone, from one of
your own uploads that you later sent to a peer. **`file_stamp_report`** asks the peers that share the space and lists the
files that are *likely* stamped, with what each side holds. It is a report and **changes nothing** — no file, no setting,
no counter; the only trace is one audit entry, `file.stamps.reported`. It has no screen in the web UI: an instance admin
runs it from an AI assistant connected with an admin token (the tool is called `file_stamp_report`, for one space) or with
`POST /api/spaces/<space>/file-stamp-report`
([Spaces API](../integration-guide/06-spaces-api.md#file-stamp-report)). It is limited to five heavy calls a minute per
token, shared with deleting space data and starting an ingest, and one report per space runs at a time.

- **What "likely" means.** A peer that holds the space reports a *different* author for the same file than this
  instance, created it more than two minutes earlier, and has the same content (the same `sha256`), and nothing in the
  file's description or tags was edited on this instance. Anything short of that is *cannot tell*, and the row says which
  piece is missing — the peer says the file is yours, it holds nothing or only a placeholder for it, the contents differ,
  you edited the description here, or the peer could not be asked. The two-minute margin is fixed (it is not the
  stamp-skew warning setting): a clock on one of the instances that is off by more than that can make a file you really
  uploaded read as *likely*.
- **It is a lead, not a finding.** The peer is the only witness. The peer named may itself have been stamped by the
  same old version and be repeating it. Each row shows both versions and both creation times so you can check it.
- **What you do about a row you have checked.** Edit the file's metadata (its description, for instance) on **the
  instance that really authored the file**. The edit arrives here and replaces the stamp only once that instance's
  counter has passed the stamp's seq (each row shows both); an edit below it is not accepted here. Nothing in
  Ythril does this for you, on purpose: any automatic repair would hand a peer ownership of a file that may be yours (see
  the [decision record](../decisions/08-a-file-stamp-is-reported-never-repaired.md)). Copies further down a chain are
  replaced only on the instances that pull from the one you edited.
- **Not listed.** Files a peer authored (an edit made here cannot be told from a stamp), files with no record of
  having been exchanged with a peer, which includes every file moved here, and deleted files. The answer says so in
  its `rules`.
- **It reads the peers' file lists.** It calls each peer holding the space, through the networks that share it, one at a
  time, and reads that peer's file records. It sends no file path. A peer that refuses, is too old, or cannot be reached
  gives *cannot tell* for the rows it would have answered, and is not asked again in that run. It reads each peer's
  records from the start, at most 50 pages of 500 rows, so a file whose record lies further into a peer's list is
  *cannot tell* (not checked) on every run, however you page through the answer.

**A background job that cannot finish one space says so, once, and carries on with the others.** Ythril does its
housekeeping in the background, one space after another: the retention sweep, the chrono retention pass, the
clean-ups of old search-result files, stray file metadata, upload leftovers and expired tombstones, the duplicate and
contradiction scans, the review-candidate clean-up, the suppression sweep, the embedding and media queues' claims
and restarts of stalled jobs, the search-reindex watcher, the checks that a new space's indexes exist, and the link
conversion at start. **An error or a hang in one space does not stop the others.** What you see in this log is a
line naming the job, the space and why:

```text
<job> failed for space '<id>' (<part>): <reason> — retried <when>
```

`<part>` appears when the job works in pieces and says which piece failed (a collection, an upload, a half of the
pass: `TTL sweep: facts delete failed for space 'notes' (facts): …`). `<when>` says when that space is tried again:
`next cycle`, `next tick`, `next boot`, `next reload`, or, for the suppression sweep, `with the next meta write` (the next
change to that space's settings). **A failing space is tried again every cycle, but its line is said at most once every
ten minutes**, so one broken space does not fill the log; it is said again as soon as the space has worked once and
fails afterwards. The count of failures keeps rising either way, in `ythril_housekeeping_space_failures_total` (by job
and by `kind`: `failure`, `timeout`, `store_down`, `stalled`), so a failure that repeats shows as a rate, not as a line.

**A hung space is ended at a time bound, and then left alone for a while.** Every database operation a background job
makes ends after the housekeeping bound, **4 minutes** by default (`YTHRIL_HOUSEKEEPING_OP_TIMEOUT_MS`, set by your
infrastructure administrator and read at start). The line then says what ran out of time: `a database operation ran
past its time bound of 240000 ms (YTHRIL_HOUSEKEEPING_OP_TIMEOUT_MS)`, and ends `retried after quarantine (60s)`. A
space that timed out is **left alone by every background job for a minute, then for longer each time it times out
again, up to five minutes**, so the other spaces are not made to wait one bound after another for it. It is
tried again at the job's first turn after the quarantine ends, and sooner for a queue whenever new work is written
into it. The
gauge `ythril_housekeeping_quarantined_spaces` is how many spaces are in quarantine now. A write that the bound
ended did not happen, and cannot land afterwards (see `Write bound` above).

**Two things stop the whole job for that round, and each says so in one line:**

```text
<job> stopped: the store is not answering (<reason>) — retried next cycle
<job> stopped: <n> spaces timed out in a row; the store looks stalled — retried next cycle
```

*The store is not answering* is the database being unreachable, or a timeout while a quick check shows that it does
not answer: the job stops instead of waiting out the bound for every space in turn, and runs again at its next turn.
*The store looks stalled* is the other case, where the database answers the check but several different spaces in a
row ran past the bound: that is not one broken space. Both mean look at the database server (its load, a lock, a
re-index running on the search service), not at a space. Neither stop line is a reason to restart Ythril: the job
tries again by itself, and the line is said again only after a space has completed in between.

**A retention sweep that cannot delete a record skips it and reports how many.** The retention sweep deletes up to
**500** expired records per collection every **5 minutes**. A record it cannot delete is passed over instead of
being asked again until the cycle ends, so one stubborn record no longer holds back the expired records behind it. The
line carries the count and the first few ids — `TTL sweep: facts delete failed for space 'notes' (facts): … (count: 3)
— retried next cycle` — and when a collection keeps failing so many records that the cycle gives up on it, it says so:
`… records keep failing; the rest wait for the next cycle`. A collection that cannot even be read is named without
`delete` (`TTL sweep: facts failed for space …`), and a failed settle of file tombstones, a failed finish of an
interrupted file move, a failed repair of what a deleted file left behind, a failed repair of expiries that are not dates
and a failed index check are named
`TTL sweep: settling file tombstones`, `TTL sweep: finishing interrupted file moves`,
`TTL sweep: repairing rows a deleted file left`, `TTL sweep: healing retention stamps that are not dates` and `TTL sweep: indexes`. The count of records that did not delete is `ythril_housekeeping_records_failed_total`.
The sweep's own indexes are checked at the start of every cycle on every space and any that is missing is built, so a
space that lost them (a failed build, or a restore) has them back within one cycle; while a space has not got
them, `TTL sweep: space '<id>' is swept without index ttl_expireAt on facts, …` is said once.

**What a cycle deleted is in the log and in the audit log, space by space.** The line `TTL sweep deleted <n> expired record(s): <space>: <count>, …` names each space that lost records and how many, and a space that lost none is not named. Each such space also gets one audit entry for the cycle, operation `ttl.expire`, with no token, whose changes give the count per kind of record (`facts`, `entities`, `edges`, `chrono`, `files`). Every expiry is a normal delete whose tombstone goes to peers, so an operator asking where records went finds the cycle and the space here.

**The same sweep repairs expiries an earlier import stored in a form it could not read.** A record whose expiry was stored as text, a number or an object never matched the sweep and never expired. Each cycle reads up to **500** of them per space and collection and rewrites each as the instant it names, or, where it names none, from the record's own creation time with the space's window (an expiry it cannot place at all is removed). A record whose expiry lands in the past is deleted by the next cycle, and on a synced space that deletion goes to peers: so after an upgrade, records an old import left with an expiry already past are removed over the first cycles, on every instance of the network. The log says `TTL sweep: healed <n> retention stamp(s) that were not dates: <space>: <count>`. A collection with nothing to repair is not asked again until the next import into the space.

**The same sweep finishes a file move that was interrupted.** A rename or move carries the file first and its records
after, and a database outage or restart between the two leaves the records at the old path until something finishes
the job. The sweep does, for every space, after it has settled the file tombstones (`TTL sweep: finishing interrupted
file moves`); a repeat of the rename finishes it as well. A move it finishes is logged, audited as `file.move.finish` (an
entry with no token) and announced to webhook subscribers once. A move it cannot finish after repeated attempts is
named in the log (`… failed for space '<id>' (<from> → <to>): the move is stranded …`) and counted in
`ythril_file_moves_stranded`; its records stay where they are and nothing is deleted. `ythril_file_moves_owed` counts
the moves still waiting. **One failure does not keep a move waiting:** when something else already stands at the
destination of one of the moved file's converted or extracted copies (a sidecar), that happened after the file's own bytes
had moved, so no retry could ever find it gone. The move finishes without that copy: what stands there is left exactly
as it is, the moved file's own copy at the old place is removed, the file has no converted text until it is
reprocessed, and the log says so once (`… finished without its sidecar …`, counted in
`ythril_file_moves_finished_without_sidecar_total`). Any other failure of a sidecar keeps the move waiting as above.

**The same sweep repairs what an earlier release left behind when a file was deleted or moved.** Releases before this
one could leave rows that belong to a file which is no longer there: the chunk, converted, extracted, caption and face
rows of a deleted file, and the links that a deleted file had. They stay searchable, belong to nothing, and a file
uploaded later at the same path inherits them. `TTL sweep: repairing rows a deleted file left` finds them in the
background, a few pages of each space per cycle, and **removes them**. It removes only rows that hang off a file that is
already deleted (never a file, a description or anything somebody wrote), and **a removal cannot be undone**; it leaves
alone a row it cannot explain (a chain too deep to follow), a row written during the scan, and anything of a file that
is back. A link goes only when this instance deleted the file, wrote the link itself, and nothing (no file, no bytes, no
move in progress) is at its path: a link another instance wrote stays with that instance. A removed link is removed with
a tombstone, so peers drop their copies. The scan starts again no sooner than a day after it finished, and starts over
at once after a restore or an import (the rows they bring were never read). Its place in each space is kept on this
instance only. The log says one line per space and pass with the counts (`Leaked-rows repair of space …`), at info
when the pass removed anything or kept a row it could not explain and at debug when it met only the rows of live files;
they are also `ythril_leaked_rows_removed_total` (by `kind`: `derived` or `link`), `ythril_leaked_rows_kept_total` (by
`reason`: `depth`, `recent` or `live`) and the gauge `ythril_leaked_rows_repair_pending_spaces`. A pass that removed
anything is audited as `file.leaked_rows.repair` (one entry per space, with no token). A scan counts as finished only
when every path of its last pass could be looked at. Going back to an earlier release afterwards is harmless: it
ignores the scan's place and does nothing it did.

Lines of other jobs follow the same shape; the ones whose wording is worth knowing:

- `Stray file-metadata drain (list|read|write|settle|drop) failed for space '<id>': … — retried next cycle`: the clean-up
  that moves file descriptions out of the old side collection (above) names which of its five steps failed. The
  collection is kept until the drain succeeds, so nothing is lost.
- `Chrono retention failed for space '<id>' (backfill: <collection> | redaction: chrono): … — retried next cycle`.
- `Candidate prune failed for space '<id>' (dupe_candidates | contradiction_candidates): …` and
  `Tombstone prune failed for space '<id>' (record tombstones | file tombstones): …`.
- `Stale chunk cleanup failed for space '<id>' (<upload>): …`: one upload directory that cannot be examined or removed
  does not stop the clean-up of the others. When the folder of upload leftovers itself cannot be listed, the line is
  `Stale chunk cleanup failed: <reason>`. A folder on a hung network mount is not ended by the bound, which is about the
  database.
- `Dupe scan failed for space '<id>': …` and `Contradiction scan failed for space '<id>': …`. A failure while a scan reads the
  records it starts from in a space is said too, not skipped in silence. A scan an operator starts (**Scan now**, or the API) says
  the same line ending `— retried next scan`: a space that fails does not stop the others from being scanned, and the API
  answers which spaces failed.
- `Suppression sweep failed for space '<id>': … — retried with the next meta write`.
- `Embed claim`, `Embed revive`, `Embed stall reset`, `Media claim` and `Media stall reset` name the embedding and media
  queues. A space that fails to hand out a job does not stop the next space's jobs, and a queue is not marked empty
  while one of its spaces could not be read.
- `Reindex resume`, `Reindex watcher` and `Reindex gauge` (`… — retried next tick`): the gauge `ythril_reindex_in_progress`
  keeps its last value while any space could not be read, rather than showing a count that is too low.
- `Link conversion failed for space '<id>': … — retried next boot` and `Link array drop failed for space '<id>' (…): …
  — retried next boot`.
- `Space indexes failed for space '<id>' (index <name> on <collection>): … — retried next index pass`: an index of
  that space could not be built when it was set up, and the space works without it until the background index pass
  builds it. The same failure in the background pass is said as `query indexes failed for space '<id>' (index <name> on
  <collection>)`, one line per index, with every other index still built. Which index is missing says what it costs:
  `_functionalGuard_1 on edges` is the lock that stops two writers working at the same moment from storing two edges
  under a one-per-subject label (the rule still refuses a second edge written after the first, and this line is the
  only sign of it); `ttl_…` keeps the retention sweep from reading every record. `lexical_text`, the keyword half of
  search, is never one of these lines: when it cannot be built the server says so once as a warning (`Space '<id>':
  index lexical_text on <collection> not built - hybrid search falls back to vector-only for it`), at set-up and in the
  background pass alike, and search falls back to meaning alone. At set-up, the `Space indexes` line is only for the
  one-per-subject lock and the retention sweep's indexes: every other index of a space - the edge identity and link
  indexes, the type, tag and name indexes, the job queues' and the file tombstones' indexes, and the sync indexes of a
  collection created at that moment - stops the space being set up instead (`space init`), and stops a restore of the
  space too (see [Restore](#restore), which also requires the lock). In the background pass every index but
  `lexical_text` is said as a `query indexes` line, and the space keeps working.
- `Edge indexes failed for space '<id>' (guard index) (count: N): … — retried at once`: duplicate locks stopped the
  build of that lock index; the surplus locks were cleared and the build tried again.
- `Functional guard heal failed for space '<id>' (<edge id>): … — retried at once`: a write found a leftover lock on an
  edge that names another subject than the one it is under, cleared it and went on. Nothing was refused. When the
  store does not answer while it looks, the line ends `retried next write`.
- `space init failed for space '<id>': … — retried next reload`, `index confirmation` and `query indexes` at **start-up**
  and after a **configuration reload**. At start-up every space is set up in turn: one that cannot be set up is named by
  this line and the server starts anyway, with every other space set up and its search indexes confirmed; the next reload
  sets it up again. The server reloads `config.json` a couple of seconds after it changes. A space the reload
  added whose set-up fails is audited with its real outcome, not as applied, and is set up again by the next
  reload; the reload itself is answered as failed (`ythril_config_reload_failed_total` moves, and
  `ythril_config_reload_pending` stays `1` until a reload succeeds). A space set up by a reload, first time or on a
  retry, has its search indexes confirmed in the background exactly as at start-up: it shows as building, then ready or failed.

**A repeating job that runs longer than its schedule is skipped, not stacked.** Each background timer runs one pass at a
time. A tick that finds the previous pass still running does not start a second one; it says `<job>: skipping this tick —
the previous pass has been running for <n>s`, at most once every ten minutes, and counts it in
`ythril_interval_tick_skipped_total` under the job's name. A pass that ends with an unexpected error says `<job> failed:
<reason>` and the next tick runs normally. A job named in a skip line again and again is slower than its schedule:
look at the database and at how much that job has to do.

---

---

## Settings — Webhooks

Webhooks send signed HTTP notifications to external systems when events occur. Manage them from **Settings → Webhooks** (admin token + MFA required).

The page lists every webhook with its endpoint, event/space filters, and a status badge: **active**, **failing** (its endpoint kept refusing deliveries), or **disabled** (switched off by you). A failing webhook also shows its count of failures and when it is next probed ("next probe" and a time in your date format, or "probe due" when that time has passed). From there you can:

- **Add / Edit** — set the HTTPS endpoint URL and a signing secret (at least 8 characters), choose which events and spaces to subscribe to (leave "all" selected for everything), and enable or disable it. The secret is write-only: it is never shown again, so on edit you leave the field blank to keep the current one. Saving a failing webhook with **Enabled** ticked makes it active again with its failure count at 0.
- **Test** — send a `test.ping` event to confirm the endpoint is reachable. A failing webhook whose endpoint answers the test is active again at once.
- **Deliveries** — view recent delivery attempts with their HTTP status, latency, and any error. The probes of a failing webhook appear here as `test.ping` deliveries.
- **Delete** — stop and remove a webhook.

A webhook is marked **failing** after its endpoint refused six events in a row, each through its whole retry schedule. It is then sent nothing new, and the deliveries already waiting for it are dropped as they come due; they stay dropped after it recovers. **A failing webhook recovers by itself:** the server probes the endpoint with a `test.ping`, first right away, then at growing intervals up to about once an hour, and when the endpoint answers, the webhook is active again. Until it has delivered a real event, one more exhausted retry schedule marks it failing again. You can also recover it at once with **Test**, or by saving it with **Enabled** ticked. Deliveries still queued when it recovers arrive on their own schedule, so they can come after newer events. The `ythril_webhooks_failing` metric counts the failing webhooks. A burst of events (a directory delete announces every file it removed) is sent to each endpoint a few at a time; the rest wait in the retry queue and arrive a little later, which the `ythril_webhook_first_deliveries_overflowed_total` metric counts.

All endpoints must be HTTPS and are SSRF-checked (private/reserved addresses are rejected). Everything the page does is also available directly through the admin API at `/api/admin/webhooks`:

### Listing and creating

- **List:** `GET /api/admin/webhooks`
- **Create:** `POST /api/admin/webhooks` with a JSON body of:
  - **`url`** — the HTTPS endpoint to notify.
  - **`secret`** — at least 8 characters; used to HMAC-sign each payload so your endpoint can verify it came from Ythril.
  - **`spaces`** — optional array of space IDs to restrict to (omit/empty = all spaces).
  - **`events`** — optional array of event types to restrict to (omit/empty = all events).
- **Delete:** `DELETE /api/admin/webhooks/:id`
- **Update:** `PATCH /api/admin/webhooks/:id`

### Testing

`POST /api/admin/webhooks/:id/test` delivers a `test.ping` event to that webhook so you can confirm the endpoint is reachable. Recent delivery attempts are available at `GET /api/admin/webhooks/:id/deliveries`.

### Event types

Beyond the per-collection write events (`fact.created`, `entity.updated`, `file.deleted`, … across fact, entity, edge, chrono, and file), the following are also emitted: `entity.merged`, `link_violation.created`, `duplicate.detected`, and `test.ping`. Deleting a file emits one `file.deleted`; deleting a folder emits one for each file that was in it, so a large folder is a burst of events, which the server delivers a few at a time per webhook and queues for retry when the endpoint cannot keep up.

---

## Settings — About

The About page loads once (no auto-refresh) and shows instance information in **four** cards: an **Instance** card (instance label, instance ID, version, and public URL when set), a **System** card (MongoDB version, uptime, and disk figures), a **Components** card listing the optional services and whether each is reachable, and a **Documentation** card with an **Open Help** button. This said two — and the Components card is the one you want when a sidecar is down. The disk section shows **Ythril data** — the actual size of Ythril's data directory (cached, refreshed periodically) — separately from **Disk (whole volume)**, the total/used capacity of the filesystem that directory sits on, with a usage bar + health pill (Healthy / High / Critical) tracking how full that volume is. (Previously only the whole-volume figure was shown, which read misleadingly as Ythril's own usage.) If the info fails to load, the page shows the reason and a **Retry** button. It does **not** show the server log — the live server log lives on the [Audit Log](#settings--audit-log) page.

---

### What a file carries to another instance (4.0)

When a space syncs, a file moves in two parts: the **file itself**, and **what you wrote about it** —
its description, its tags, and the records you attached to it.

**The second part is new in 4.0.** Before, only the file travelled: a file you had linked to an entity
arrived on the other instance with the link missing from its row, even though the graph there knew about
it. The two views disagreed, and which one you believed depended on where you looked.

**What each instance keeps its own copy of** is everything it worked out from the file itself — the size,
the checksum, the extracted text and the search vector. Those are never overwritten by another instance,
because each one computed them from its own copy of the bytes. That includes the **converted text and the
images pulled out of a document**: they never travel. Each instance converts a file it is given by its own
settings (the document mode, its models, an external assist model only if you have confirmed one), so an
instance with conversion switched off holds no converted text of a file a peer sent. After an upgrade a
backlog of files your instance was sent and never converted is worked off over the next sync cycles, a few at
a time.

**Taking something away travels too.** Remove a file's description, a tag, a property or its search
suppression, and the removal reaches the synced instances running this release or later, so they no longer
keep the value you took away (before, it stayed on every other instance for good, and the instances
reported different data). An instance still on older software keeps the old value until it is upgraded and
the file is next edited; the log of the instance that sends says so, once, naming the peer.

**A file you deleted, with records kept, stays on your instance.** With the
[record of deleted files](04-settings.md#keeping-a-record-of-deleted-files) switched on, the flagged record is not
sent to other instances and not counted when instances compare their data: they get the deletion notice and each
follows its own setting. It is not a search result and not in any file count either; Brain → Query is where you read
it, by asking the Files collection for records that carry a deletion time. A restore from an export brings the flag back. A restore also removes a description,
tag or property the exported record did not have, as the export is a full copy, and the import summary
counts those removals (`keysRemoved`).

> **Connections convert themselves on the first 5.0 start, and there is nothing to run.** A connection —
> a fact about an entity, a file about a timeline entry — used to be a list of ids kept on the record
> itself. It is now a small record of its own, and 5.0 is where the old lists stop existing. Every restart
> checks each space and converts anything still holding them; a space already converted is skipped, and a
> space that could NOT be converted is named in an `ERROR` line in the server log rather than passed over
> quietly. One space failing, or hanging, does not stop the others: each is converted on its own, and the
> `ERROR` line gives every space that was not converted with the reason (an error, no answer from the
> database, or left out because the database stopped answering). A failed space is tried again at the next
> start, or at once with `npm run links:convert` (below), which converts the others, names each failed space
> on the error output with its reason and **exits with a failure status**, so a deploy step that runs it does
> not report success over a partial run.
>
> **A space that failed to convert refuses to answer about connections**, by name, until it has been
> converted cleanly. That is deliberate and it is the whole reason the failure is loud: the alternative is
> a space that answers "no connections" for records that have plenty, which every reader believes. The
> refusal names the space and tells you what to run.
>
> **The old way of writing connections is refused, and the refusal says what to send instead.** A script
> still sending `entityIds`, `memoryIds` or `chronoIds` gets an error naming `linkEntities`, `linkFacts` or
> `linkChronos` — the same ids, a different field. A refused call writes nothing, the record included, so a
> record never lands without the connections it asked for because the call was turned away. The one other way
> to end with a record and missing connections is a failure after the record was saved (the database going
> away in between): that answer says so and names the record, and the audit log records it as the write of
> that record, so it is found by the record's id like any other write.
>
> **Files uploaded before 4.0 are the one part startup does NOT do for you.** Their descriptions reach a
> peer only once each record has been given a position in the space's history, and giving it one is a
> change to a record that other instances also hold — so if every instance did it at its own restart,
> each would pick a different position and they would take turns overwriting one another. It is the
> administrator's one-off instead: `npm run links:convert`, from source, which prints how many records it
> stamped per space. Nothing is lost by leaving it — those files work normally, and only their
> descriptions stay local until somebody edits them.
