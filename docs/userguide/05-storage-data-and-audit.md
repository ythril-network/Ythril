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
| **env var** | Connection is managed by the infrastructure via the `MONGO_URI` environment variable. The variable always takes precedence over `config.json`. |

**Timeouts you put in the connection string win.** Three settings decide how quickly Ythril notices that the database has stopped answering: `connectTimeoutMS` (how long a new connection may take, **10 seconds** unless you say otherwise), `heartbeatFrequencyMS` (how often the server is asked whether it is alive, **5 seconds**) and `serverSelectionTimeoutMS` (how long an operation waits to find a server, **10 seconds**). If the connection string names one of them, that figure is used, whichever of the three sources above supplied the string; Ythril's own figure applies only to the ones the string does not name. Earlier versions silently ignored a `serverSelectionTimeoutMS` written in the string. The connection is opened once when Ythril starts, so **a change takes effect at the next restart**. The Server Log shows what was used, in one line at start, `MongoDB client options: …`, saying for each figure whether it came from `MONGO_URI` or is the default. Do not set `socketTimeoutMS` or `timeoutMS` lower than your slowest legitimate read: they end any operation that takes longer, a search or an export included.

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

Maintenance mode suspends all write operations across the entire instance. All write requests return `503 Service Unavailable` while active. Read operations continue normally.

Use it before a restore or any manual database operation where you want to prevent concurrent writes.

Toggle the **Maintenance mode** button to enable or disable it. A banner appears across the top of the UI on all pages while maintenance is active.

### Backups

Click **Back Up Now** to trigger an immediate point-in-time dump of the entire MongoDB database. The backup is stored inside the instance's data directory (`<data-root>/backups/<timestamp>/`). Each backup contains a `manifest.json` with metadata and one NDJSON file per collection.

The **Backups** table lists all available backups with their timestamp and the collections they contain.

**A backup never contains the search results kept for download.** They belong to the person who ran the search
and last up to a day; in a backup they would outlive that day — including records deleted or redacted since —
for as long as the backup is kept. So they are left out of every backup, manual, scheduled and offsite, and a
restore leaves the ones currently kept alone.

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
   one was written — and a backup still restores if its `manifest.json` is lost. If the secret is missing, the
   restore refuses with a message naming the environment variables to set, rather than importing ciphertext.

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
- **Search comes back on its own.** Vectors are not exported; every restored record is queued for embedding on
  this instance, so nothing has to be reindexed by hand.
- **Nothing is refused silently.** A record the import could not store is listed by id with the reason; a record
  restored over a deletion this instance remembers is listed too, because a synced peer that remembers the same
  deletion will remove it again.
- **A family marked `counterBehind` was restored, and needs the import run once more.** It means the records were
  stored but the space's sequence counter could not be moved past them, so the next edit made here could be taken
  for older than a restored record by a peer. Running the same import again is safe — it replaces — and moves the
  counter.
- File previews and passages are rebuilt from the file itself, so they are not part of the export.

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

To restore a backup, click **Restore** on any backup row. The instance will:

1. Enter maintenance mode automatically.
2. Replace all data in MongoDB with the backup snapshot.
3. Exit maintenance mode.

Restore is irreversible — all data written after the backup timestamp will be lost. You will be asked to confirm before the operation begins.

### Database migration

> **This feature must be explicitly enabled by your infrastructure administrator** (`YTHRIL_DB_MIGRATION_ENABLED=true`). It is disabled by default on all instances.
>
> **Infrastructure-managed connections are locked.** When `MONGO_URI` comes from the environment, the UI shows an informational note that the connection is externally managed. The *hard* server-side block on changing database settings, however, is the separate `YTHRIL_MONGO_INFRA_MANAGED=true` environment variable: with it set, the **Migrate Database** card is disabled entirely. To change the database in a managed deployment, update your deployment configuration (the `MONGO_URI` your orchestrator injects) and restart.

Database migration moves the entire database to a different MongoDB server — for example, from the bundled container to Atlas, or between clusters.

Enter the target MongoDB URI and click **Test Connection** to verify reachability before committing. Once you click **Migrate**:

1. Maintenance mode is activated.
2. The current database is dumped to `<data-root>/migration-backup/`.
3. A migration marker is written and the new URI is saved to `config.json`.
4. The server process exits. When Docker or Kubernetes restarts the container, the server detects the marker and restores the dump into the new MongoDB before starting normally.

Migration is a one-way operation. Keep your old database available until you have confirmed the migrated instance is healthy.

---

## Settings — Audit Log

**Settings → Logs** (admin only) shows a searchable log of every API operation on this instance. The page has two sub-tabs, toggled at the top: **Audit Log** (the operation table below) and **Server Log** (the live server log described at the end).

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
appears as one entry, operation `file.stray_filemeta.drain`, with the space named and no token.

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

**Every line an API request's own work produces carries that request's id**, shown in square brackets after the level. It is the same id the response returned in its `X-Request-Id` header, so when somebody reports a failing call and quotes the id, searching for it here finds every line that request produced — the refusal, and anything a background step logged on its way. Lines that belong to no request (startup, the auto-delete sweep, the background storage measurement) carry no id, which is what keeps a search for a real one from matching them.

**`seq horizon held …` names a write that held up replication.** While a write is being stored it holds a place
in its space's sequence, and every peer pulling that space is served nothing past that place until the write
ends. A write that took longer than half its limit (`YTHRIL_HOLD_DEADLINE_MS`) is named once while it is still
open — `seq horizon held 23.0s and still open: space=… seq=… holder=…` — and again when it ends:
`seq horizon held 45.1s space=… seq=… holder=… ended=timeout`. `holder` says which kind of write it was
(`fact.update`, `sync.push.fork`, `entity.merge`, …); `ended=` says how it ended: `ok` (slow, but it finished),
`timeout` (the database did not complete it in time, so it was stopped and the caller told to retry) or `error`.
One such line now and then is a slow moment; the same space appearing repeatedly is a lock or a stalled
database connection to look into. The gauge `ythril_seq_horizon_oldest_hold_seconds` shows the same thing as a
number per space.

**`Write bound: the server did not answer … by its own deadline` names a write the database had to be told to drop.**
A write that is stopped (`ended=timeout`) is stopped by the database at its limit; if the database has not
answered half a second after that — it is blocked behind another session's uncommitted insert, or the request reached it
late — the server stops waiting, ends the database's operation itself (finds it by a tag it put on the write, kills it, and
checks that it is gone, for at most 0.4 s) and only then tells the caller to retry. The line says which: *killed and gone*
(a warning, nothing to do) or *could not be confirmed gone* (an error: the write may still be running in the database and
could land after the caller was told it timed out — look at the database server and at who holds the lock).

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
`delete` (`TTL sweep: facts failed for space …`), and a failed settle of file tombstones and a failed index check are
named `TTL sweep: settling file tombstones` and `TTL sweep: indexes`. The count of records that did not delete is `ythril_housekeeping_records_failed_total`.

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
- `space init failed for space '<id>': … — retried next reload`, `index confirmation` and `query indexes` after a
  **configuration reload**. The server reloads `config.json` a couple of seconds after it changes. A space the reload
  added whose set-up fails is audited with its real outcome, not as applied, and is set up again by the next
  reload; the reload itself is answered as failed (`ythril_config_reload_failed_total` moves, and
  `ythril_config_reload_pending` stays `1` until a reload succeeds).

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

The page lists every webhook with its endpoint, event/space filters, and a status badge (**active**, **failing**, or auto-**disabled** after repeated failures). From there you can:

- **Add / Edit** — set the HTTPS endpoint URL and a signing secret (at least 8 characters), choose which events and spaces to subscribe to (leave "all" selected for everything), and enable or disable it. The secret is write-only: it is never shown again, so on edit you leave the field blank to keep the current one.
- **Test** — send a `test.ping` event to confirm the endpoint is reachable.
- **Deliveries** — view recent delivery attempts with their HTTP status, latency, and any error.
- **Delete** — stop and remove a webhook.

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

Beyond the per-collection write events (`fact.created`, `entity.updated`, `file.deleted`, … across fact, entity, edge, chrono, and file), the following are also emitted: `entity.merged`, `link_violation.created`, `duplicate.detected`, and `test.ping`.

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
because each one computed them from its own copy of the bytes.

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
> `linkChronos` — the same ids, a different field. Nothing is written half-way: the whole call is refused,
> so a record never lands without the connections it asked for.
>
> **Files uploaded before 4.0 are the one part startup does NOT do for you.** Their descriptions reach a
> peer only once each record has been given a position in the space's history, and giving it one is a
> change to a record that other instances also hold — so if every instance did it at its own restart,
> each would pick a different position and they would take turns overwriting one another. It is the
> administrator's one-off instead: `npm run links:convert`, from source, which prints how many records it
> stamped per space. Nothing is lost by leaving it — those files work normally, and only their
> descriptions stay local until somebody edits them.
