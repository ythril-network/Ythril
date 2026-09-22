# Settings — Storage, Data, Audit Log and Webhooks

> Part of the [Ythril User Guide](../userguide.md).

## Settings — Storage, Data, Audit Log and Webhooks

## Settings — Storage

**Settings → Metrics** shows how much disk space your Brain data and files are using against the configured quota. A usage bar with a **Healthy / Warning / Full** indicator shows how close total usage is to the limit; **Refresh** re-checks the current figures.

When usage approaches the quota limit, writes will first return warnings and eventually be rejected. Contact your administrator to raise the quota.

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

### Maintenance mode

Maintenance mode suspends all write operations across the entire instance. All write requests return `503 Service Unavailable` while active. Read operations continue normally.

Use it before a restore or any manual database operation where you want to prevent concurrent writes.

Toggle the **Maintenance mode** button to enable or disable it. A banner appears across the top of the UI on all pages while maintenance is active.

### Backups

Click **Back Up Now** to trigger an immediate point-in-time dump of the entire MongoDB database. The backup is stored inside the instance's data directory (`<data-root>/backups/<timestamp>/`). Each backup contains a `manifest.json` with metadata and one NDJSON file per collection.

The **Backups** table lists all available backups with their timestamp and the collections they contain.

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

> **The two retention settings default in opposite directions.** Local backups are kept forever until you set `keepLocal`; offsite sets are pruned to the 14 most recent unless you set `keepCount`. If you rely on the offsite copy as a long-term archive, set `keepCount` to the number of sets you actually want — otherwise older ones are removed on the next run.

Each backup set at the offsite destination contains:

- `<backupId>/` — MongoDB NDJSON dump (same format as local backups)
- `<backupId>-files/` — copy of `<data-root>/files/` (user-uploaded files), if present

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

**Exporting:** Download the current filtered view as JSON or CSV.

**Live server log:** the **Server Log** sub-tab streams the instance's log in real time over Server-Sent Events (SSE). It loads the recent lines and then appends new ones as they happen, colour-coded by level.

**Every line an API request's own work produces carries that request's id**, shown in square brackets after the level. It is the same id the response returned in its `X-Request-Id` header, so when somebody reports a failing call and quotes the id, searching for it here finds every line that request produced — the refusal, and anything a background step logged on its way. Lines that belong to no request (startup, the auto-delete sweep, the background storage measurement) carry no id, which is what keeps a search for a real one from matching them.

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
> quietly.
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
