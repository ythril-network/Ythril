# Upgrading and Rolling Back

> Part of the [Ythril Integration Guide](../integration-guide.md).

## Upgrading

1. Pull the latest image:

   ```bash
   docker compose pull        # if using a registry
   docker compose build       # if building from source
   ```

2. Restart the stack:

   ```bash
   docker compose up -d
   ```

Named volumes persist across upgrades. The server applies any pending MongoDB index changes on startup automatically. No manual migration scripts are needed.

**Breaking changes**, when they occur, will be listed in `CHANGELOG.md` with migration steps.

**Upgrading past 5.6.x changes what `MONGO_URI` does and four answers an integrator can branch on.**

- **Options in `MONGO_URI` win, and three defaults now apply.** `connectTimeoutMS`, `heartbeatFrequencyMS` and `serverSelectionTimeoutMS` default to figures that notice a database that stopped answering (see the `MONGO_URI` row in [Hosting](02-hosting.md)); a string that names one keeps its own. A `serverSelectionTimeoutMS` your string already carried was silently overridden before and is **honoured now**, so a very long one makes an outage last that long. A changed string takes a restart. The boot retry also covers more "not up yet" failures (a node that is not yet primary, a pool with no free connection) and still fails at once on bad credentials or a malformed string.
- **Integrators that branch on status:** a pool checkout that timed out, or a closed pool, answers `503` retryable (it answered `500`); a write concern the deployment can never meet answers `500` with `retryable: false`, `code` and `codeName` (it answered `503`); a store failure under renaming a space, creating one or adding a link answers `503` (it answered `404`, `409` or `422` in the driver's words); and a second delete of a file record already flagged as deleted, or a delete naming a derived record, answers `404` on REST and MCP. See [Auth and limits](03-auth-and-limits.md#a-failure-of-the-store-is-a-503-and-says-so-in-a-field) and [Files](05-files-api.md).
- **Background jobs no longer stop at the first failing space.** A failing or hanging space is reported (see [Background jobs and the spaces they walk](11-setup-api.md#background-jobs-and-the-spaces-they-walk)) and the other spaces are processed; four new metrics count it. Nothing needs configuring: `YTHRIL_HOUSEKEEPING_OP_TIMEOUT_MS` is optional.

**Upgrading past 5.6.x builds a new index on every record collection, in the background; until a collection's build ends
its sync reads stay tie-safe and are only slower.** Sync pages, the push and the two scanners now read in `(seq, _id)` order, so records
that share a `seq` are never skipped at a page boundary, and that order needs `{ seq: 1, _id: 1 }` on the facts, entities,
edges, chrono, links and files collections and on the tombstones. A collection that already exists gets it from a pass that
starts AFTER the server is listening (the boot does not wait for it), one collection at a time; the log says when the first
build starts and, per space, when it ends, and the `{ seq: 1 }` (tombstones: `{ type: 1, seq: 1 }`) each one replaces is
dropped only once its replacement is confirmed. On a large collection the build takes a while and costs the database
some write and read capacity meanwhile. Until a collection's build ends its sync reads behave as they did before — by seq
alone — which is correct for distinct seqs and not yet safe for a run of equal ones; a collection created by the new version
has the index from its first write. Two things an integrator can see:

- **The cursor a page returns is a pair now, still opaque.** A client that echoes it is unchanged, and a cursor from an
  older server (the bare seq) is still read. A build that predates this change reads a pair as follows: one with the sync
  read validation (`Q-388`) answers a pair with `400`, and one before it reads the seq alone. That only matters for a cursor
  in flight across a rollback, and nothing is lost by it — a cycle that meets the `400` stops and starts again from its
  watermark.
- **The tombstone route has a cursor mode** that pages through any number of tombstones at one seq ([Sync API](09-sync-api.md#tombstones)).
  A puller that predates it keeps its older mode, and still stops at a run of more than `limit` tombstones at one seq until it
  upgrades.

The duplicate and contradiction scanners keep their cursor as `(seq, _id)`: the first run after the upgrade scans the
records at the one `seq` its cursor named once more, and nothing below it.

**Upgrading past 5.6.x changes who may delete what below a publisher or a parent, and re-reads that upstream's deletions once.**
On a pub/sub network or a tree, an instance now applies its direct upstream's deletion of a record **that upstream
delivered to it, whoever wrote it**. Until now it applied a deletion only to a record the deleting instance wrote,
so a record the publisher relayed from a third instance, and any record a publisher's retention sweep removed
after relaying it, stayed on every subscriber for good. What stays out of an upstream's reach: records this
instance wrote itself, and records that reached it through any other peer. **The cost is the same trust the
network already extends: a publisher or parent that is compromised or misconfigured can delete, on every instance
below it, everything it relayed.** Clubs, closed and democratic networks are unchanged. The rule is in
[Sync Protocol → Tombstone deletion authorisation](../sync-protocol.md#tombstone-deletion-authorisation).

- **A one-time back-fill, then a one-time re-read, in each space's first sync cycle after the upgrade.** The
  instance records, per record, which peer delivered it; rows stored before the upgrade carry no such record,
  so each space is stamped once (a record is attributed to the upstream only when every network carrying the
  space has that one upstream and the record was written by someone else; every other row is attributed to
  nobody, and is deletable by its own author alone). Then, per space, the instance asks each upstream for its
  tombstones from the beginning and applies them, which delivers the deletions it declined while it ran the
  older rule. It does not touch your record watermark and moves no record. It is bounded per cycle, so a long
  set finishes over several cycles from where it stopped; if the upstream cannot answer it stays owed and is
  said once in the log.
- **Watch it.** The gauge `ythril_sync_tombstone_rereads_owed` is the number still owed and falls to `0`; each
  space says so in one info line when its re-read finishes (even when it deleted none), naming the upstream and how many records it deleted;
  `ythril_sync_tombstones_applied_total{ground="upstream"}` carries those deletions; and a deletion that is
  declined is counted in `ythril_sync_tombstones_declined_total{kind,reason}` and said once per peer, space and
  reason (see [Prometheus Metrics](11-setup-api.md#prometheus-metrics)). An instance that joined after the upgrade has nothing to re-read.
- **What it recovers, and what it cannot.** Only deletions the upstream still holds. An upstream pruned a
  tombstone once every member counted as past it, and a declined one counted, so a deletion that is old enough may
  be gone at the source: the record it would have removed stays until you delete it. A `merkle: true` network shows
  that as a divergence on the space. A re-read deletes a record only if its seq is not above the tombstone's, which
  fails toward keeping a record re-created after the deletion.
- **Upgrade root-first.** A middle node that re-reads after its children have passed the seq a relayed tombstone
  carries leaves them holding the record, because a relayed tombstone keeps its issuer's seq and is not offered again
  by position (the same limit that records have, in the Sync Protocol's watermark section). Upgrading the root, then
  each level below it, avoids it.

**Upgrading past 5.6.x changes what a file a peer delivers does on the instance that receives it, and what a conversion's sidecar is.** The receiver applies its own rules to every file it is given, and a file's arrival is recorded completely, by one function, whether the peer pushed it or this instance pulled it.

- **A peer's byte push no longer fires `file.created`, and a peer's pushed or pulled file no longer refreshes an open Files page.** A write no user made is announced to no one, as a synced record never was. A person's upload, delete or move, an MCP tool call and an ingest's transcript still fire. An integrator that listened to `file.created` to learn that a peer delivered a file must list the files instead.
- **A document a peer delivers is converted by this instance's own pipeline**, by push or by pull: the mode, the models and, where this instance has consented to it, an external assist model are this instance's. Until now a pulled `.html` or `.pdf` was stored and never converted, and a changed pulled version kept the previous passages. A backlog is worked off over sync cycles: a file already held whose row names other bytes than the disk's, or that never went through processing, is recorded and queued by a later cycle, at most a small fixed number per space per cycle (`ythril_sync_file_arrivals_total{outcome="repaired_…"}`), with no boot-time job. Expect conversion and, with consent, external-model traffic after the upgrade.
- **Conversion sidecars (`_converted/`, `_extracted/`) no longer travel**; each instance converts by its own settings, so a receiver with conversion off holds no derived text. Sidecars a peer delivered before are retired, bytes and row, by the retention sweep within a cycle (at most 200 per space per pass), with no tombstone and no webhook; the log says `Retired N conversion sidecar(s) a peer delivered into space '…'`.
- **A file's processing status no longer changes its `updatedAt`.** Rows that drifted before the upgrade keep a differing `updatedAt` at an equal seq until the file's next authored edit, so `MERKLE_DIVERGENCE` on those files does not clear by itself.
- **A removed description, source, property, tag or suppression mark now reaches peers**, and a soft-deleted file's row stays local, with the deletion carried by the file tombstone; see the table below.
- **A pull whose body is not the manifest's, or is longer or shorter, stores nothing**, a space over its quota is not fetched, and a pull or an upload that cannot record a NEW file removes the bytes it wrote, so nothing is listed or offered to a peer (a pull redoes the file next cycle; an upload answers `5xx` and is sent again). A file whose record still exists, or whose record failed because the database did not answer, keeps its bytes and is brought up to date by the next write or sync (`File pull record failed for space '…' …`, `File pull quota failed …`, `Unrecorded bytes cleanup failed …`).

**Mixed versions: what an older peer does with each change.**

| Change | An older peer receiving it | An older peer sending it |
|---|---|---|
| The upstream ground (needs no new field) | Applies only the issuer's own ground: a relayed record's deletion is declined without a trace, and the sender may prune it. The upgrade's re-read recovers it where the upstream still holds it | Applied here on the upstream ground |
| `POST /api/sync/tombstones` answers `declined` (omitted when zero) | Never sends it; read a missing one as zero | Ignores it |
| `GET /api/sync/tombstones` | Unchanged | Unchanged: this instance pulls as before |
| File tombstones gain `issuer` and `rowSeq`, are judged by the same rule, and keep a newer re-created file | Ignores both keys. It deletes the bytes for any tombstone it is sent, keeps the file's record, and passes the tombstone on without an `issuer`; this instance reads one with no `issuer` as issued by the peer that sent it | Applied here under the rule, with no version to compare: a re-created file is not protected until both ends upgrade |
| `GET /api/sync/file-tombstones` takes `cursor` and answers `nextCursor` | Ignores `cursor`, answers one page at its fixed ceiling with no `nextCursor`; this instance warns that the answer may be cut | Without `cursor` it answers exactly as before, so an older puller reads what it always did (and still cannot read past the ceiling) |
| `POST /api/sync/file-tombstones` is paged and answers `{ applied, refused?, declined? }` | Answers `{ applied }` only, and takes a large body the way it did | Sends one body for everything, which this instance takes up to the per-request cap; a set larger than that cannot succeed until it upgrades |
| Bytes a held file tombstone covers: `200 { tombstoned: true }`; `filemeta.tombstoned` in the batch answer | Stores them, as before, and omits the counter | Treats the `200` as stored and ignores the extra counter: no re-upload loop |
| A conversion's sidecar (`_converted/`, `_extracted/`) is instance-local: never listed in the manifest, pulled, pushed or hashed, and a peer's offer of one is ignored (a delete still removes the rows a sidecar left) | Lists, hashes and offers its own sidecars, and keeps the ones it received; on a `merkle: true` network the two roots differ until every member upgrades | Its push of a sidecar is answered `200 { "ignored": "instance-local" }`, so it records a base and stops; a sidecar it delivered earlier is retired here by the retention sweep |
| A file's removed description, source, properties, tags or suppression mark crosses the wire (`authoredKeys` on a push and on `GET /api/sync/filemeta`, `tags` optional) | Is not sent the new keys: a peer not known to run 5.7.0 or later gets `tags: []` and no list (an older receiver refuses a key it does not declare or a missing `tags`, and answers `200`), so a key removed here stays there until the file's next edit after it upgrades; a peer that refuses is offered the older shape once and treated as older | Sends no list, so a removal at it never reaches this instance |
| A soft-deleted file's row is local audit state: flagged rows are not pushed, served by `GET /api/sync/filemeta` or hashed; the deletion travels as the file tombstone, which each receiver applies by its own `softDeleteFileMeta` | Still pushes a flagged row stripped of its flag, which lands live here (and can retire the tombstone this instance held for the file) until it upgrades; hashes flagged rows | Applies the tombstone by its own setting; receives no flagged row |
| A file above the receiver's single-body limit is pushed through the chunked door (the `202` answer carries `maxBodyBytes`; `x-expected-sha256` binds the assembly) | A receiver that announces no limit is sent ranges under its default and a `413` halves a range; an older sender is unaffected (it ignores `maxBodyBytes`) | Its single body above this instance's `maxUploadBodyBytes` is still answered `413` every cycle until it upgrades |
| A file-metadata `_id` that is not the canonical key of its path (NFC, `/` separators, no empty or `.` segment, `..` collapsed) is refused, and counted in `filemeta.rejected`. This release keys every file row it writes itself by that key | Stores the id it is sent, as before: a row keyed by a spelling of a path, which nothing on that instance reads again | A row an older release stored under a non-canonical spelling (a decomposed accented name from a macOS client, `a//b`, `./a`) keeps that id here, and an upgraded peer refuses it every cycle: the receiver's log names the id, the sender's batch answer counts it in `filemeta.rejected`, and the file's description, tags and properties do not reach that peer. The file's bytes still do, through the manifest. A file written by this release is keyed canonically and replicates |
| A byte door that cannot tell whether the path was deleted (the path of a pending delete cannot be looked at) answers a retryable `503` and stores nothing | Stores the bytes, as before | Its push of that file fails and is tried again on a later cycle, which is the whole of the effect |
| A row created by arriving bytes before their metadata (seq `0`, authored only by the peer that delivered them) is authorless to the deletion authority | Judges its own rows by its own, older, rule; nothing on the wire changes | Its file's origin deleting the file is applied here, not declined; metadata at a seq above `0`, from anyone, makes the row authored and protects it as before |

Every answer added in the table is additive, so an older instance reads it as the answer it always gave.
**A file tombstone this instance held before the upgrade names no version, so it shadows nothing**: the protection
against a peer returning a deleted file applies to deletions made after the upgrade.

**Upgrading to 5.6.0 or later deletes the read spills older versions wrote into spaces, and that cannot be
undone.** Before it, a `recall` or `similar` answer too large to return inline was saved as a file at the root
of the seed's space — `_tmp/graph-<id>.json` or `_tmp/results-<id>.json` — which replicated to every peer and
never expired there. They are one caller's search results, not content, and spills now live outside every
space. From the first boot, a sweep inside the retention pass (every few minutes) removes every such file and its record,
whether it was written here or pulled from a peer, with no tombstone and no webhook; each space it cleans gets one
log line and one audit entry, `file.legacy_spill.sweep`, naming the space. Only that exact root path is
touched: a `_tmp` folder of your own deeper in the tree, and any other file under the root `_tmp`, are left
alone. Copy the root `_tmp/` out of a space's file store first if you want to keep one.

**Upgrading to 5.6.3 or later recovers the file metadata a 4.0–5.6.1 pull left in `<space>_filemeta`, then drops that
collection, and the drop cannot be undone.** Those versions stored other instances' file descriptions and tags in a
collection nothing read. A pass inside the retention cycle (every few minutes, at most 10,000 records per space per
pass) fills each file row this instance made itself with the keys it lacks, gives a row another instance wrote the
usual newer-wins rule, and never creates a row. A record whose file has no row here waits up to 30 days for the
file's bytes, and is discarded sooner when a file tombstone says the file was deleted (a tombstone from before the upgrade, which names no version, by path alone). A record with a key of the
wrong type, or a chunk's `parentFileId`, is discarded and counted as refused; a key a record lacks is never required,
because only the keys it carries are filled. The log line counts what was discarded; it does not list the records. When a space's collection is empty it is dropped, with one log line and one
audit entry, `file.stray_filemeta.drain`, naming the space. To keep a copy first, `mongodump --collection
<space>_filemeta` before upgrading. 5.6.2 ran an earlier drain that counted most of these records as older than the
stored copy and dropped them; on an instance that already ran it, the collection is gone and this pass has nothing
to recover.

**Upgrading to 5.6.0 or later rebuilds every vector index once, with no gap in search.** Each index gains `_id` as a
filter field, which is what lets a filtered recall complete its answer. Where the database can change an index in
place (Atlas) it does; where it cannot (`mongodb-atlas-local`), the new definition is built under a second name,
searches move to it, the original is rebuilt, and searches move back. Until an index is done, a filtered recall that
needs completing returns what it found and says `filter_window` in `degraded`; every other search is unaffected. On
a large instance this takes as long as building every index twice, in the background.

**Upgrading past 5.6.0 drops the search indexes of every empty collection, once, at boot.** A collection's search
index now exists only while the collection holds a record: mongot keeps one change-stream cursor per index over the
oplog, so an index on an empty collection costs the database on every write anywhere and answers nothing. A populated
collection keeps the index it has, untouched. Expect the instance's index count to fall by the number of empty record
collections — about half, on a measured production instance. An index comes back by itself with its collection's
first record, and goes a minute after its last one is deleted (`SEARCH_INDEX_DROP_DELAY_MS`, default `60000`). A
rollback needs nothing: the older build recreates every index at boot.

**Upgrading past 5.6.8 strips the records of files deleted under `softDeleteFileMeta` by an earlier build.** The flag
write removes everything the bytes made in the same operation now — the vector, its model, the matched text, the
excerpt, `sha256`, `embeddingStatus`, and a machine-made `description` with its `descriptionSource` — but that is
forward-only, so rows flagged before the upgrade still hold all of it. The retention sweep repairs them a bounded batch
per space per cycle, in the background, with no boot step to run and nothing to wait for. It is query-defined and keeps
no marker: a stripped row stops matching, so once the backlog is gone the repair costs one bounded read per space per
cycle. Every field it removes is LOCAL — never hashed, never offered to a peer — so nothing it does can make two
instances disagree, and a rollback needs nothing: the older build simply stops repairing. What it cannot do is bring
back what it removed, which is the point of the setting.

**And a kept record is now reaped, on its own clock.** A row flagged `deletedAt` is removed once the space's FILE
retention window has passed SINCE THE DELETION — not since the file's own `_expireAt`, which would remove the audit
record on the sweep after the one that made it. A space with no file window reaps none, ever. The purge is its own
sweep unit (`TTL sweep: files-flagged`), so its failures are reported under their own step and a re-upload that revives
the path between the sweep's read and its delete WINS: the row stays live and the loss is not reported as a failure.
After the row is gone, the file TOMBSTONE is what stops a stale copy of the deleted file arriving from a peer.

## Rolling Back

**A rollback to 5.6.x rebuilds `{ seq: 1 }` before it listens, and leaves the new indexes behind.** An older build creates
`{ seq: 1 }` (tombstones: `{ type: 1, seq: 1 }`) at every boot, before it accepts a request, on each collection that no
longer has it — which, once the background build above has finished and dropped it, is every record collection. On a large
instance that is a boot that takes as long as the build did. The `{ seq: 1, _id: 1 }` indexes stay: an older build neither
reads nor drops them, and they cost a second index on every write until the upgrade is done again. A scanner cursor that
the newer build wrote is read by the older one as its `seq` alone, and scans nothing twice.

**A rollback to 5.6.x carries the delivery stamp into builds that do not know it, and returns to the older deletion rule.**
Every record stored since the upgrade holds `deliveredBy`, a field an older build does not know is local: it hashes it,
so a `merkle: true` network with a rolled-back member logs `MERKLE_DIVERGENCE` for the spaces where it differs, and it
serves it in sync pages. An older peer drops it from record families, but its file schema is strict, so **it refuses
a file record that carries it, and file metadata does not reach an older peer from a rolled-back instance** until
the stamp is gone. Nothing is lost: the records are intact, and an upgrade done again finds the stamps in place
(the markers for the back-fill and the re-read stay in `config.json`; a copy of `config.json` taken before
the upgrade runs both again, harmlessly). The older build applies only a deletion its issuer's own peer delivered
for a record the issuer wrote, so deletions a publisher relayed stop reaching the instance, and file tombstones are
applied with no check of who sent them, as before.

**A rollback from 5.6.0 rebuilds the vector indexes once more**, to the previous version's filter fields. Search
keeps working meanwhile, except on `mongodb-atlas-local`, where the older build drops and recreates each index and
recall on it answers empty until it is ready. Nothing is lost; the records are untouched.

**The first boot on a new version rewrites `config.json`, and some of those rewrites drop a field an older
build reads.** So a rollback is not simply "run the previous image": that path exists, but it needs the copy of
`config.json` you took *before* upgrading.

The rewrites are one-time and idempotent, they are logged when they happen, and each one exists because a setting
moved. They are listed here so the consequence of going back is not a surprise:

| the boot migrates | dropping | so an older build |
|---|---|---|
| `mediaEmbedding.enabled` → per-class `levels` | `enabled` | defaults it back to **`true`**: an instance where media embedding was deliberately **off** starts sending uploads to the vision and speech models again |
| a space's `description` → `meta.purpose` | `description` | reads no space instructions, because the field it serves to MCP clients is gone |
| a network's schema layer or membership origin kept under a renamed space's OLD name → the space's current name (`migrateNetworkSpaceKeys`) | the entry under the old name (moved, not deleted; an entry with no space to move to is left where it is) | looks the network's layer up under the old name again and finds nothing, so the space's effective schema loses that network's layer until the network next sends it (the next meta pull on a pub/sub or tree; the next round on a voted network), and a token that joined the network can no longer be told apart as its establisher for the leave rule. **New in 5.6.0.** Nothing about the records changes |
| a provider API key in `mediaEmbedding.<vision\|stt\|nli\|rerank>.apiKey` → `secrets.json` | `apiKey` | sends no `Authorization` header to that provider, so an external vision / speech-to-text / NLI / rerank endpoint returns 401 and the feature stops. The key is NOT lost — it is in `secrets.json` (`0o600`) and can be pasted back into `config.json` for the older build. **New in 3.0**, and the reason is that `config.json` is the file operators copy, paste into issues, and mount as a ConfigMap. |
| `mediaEmbedding.ollamaUrl` / `visionModel` / `whisperUrl` / `whisperModel` → `vision.*` / `stt.*` | `ollamaUrl`, `visionModel`, `whisperUrl`, `whisperModel` | stops finding those four names and falls back to its BUILT-IN defaults — `http://ollama:11434` and `http://whisper:8000` — so it captions and transcribes against whatever answers there, with no error. The values are not lost: they are on `vision.*` / `stt.*`, which the older build also reads. **New in 3.0.** The env vars are a separate matter and 4.0 REMOVED the legacy spellings: `VISION_BASE_URL`, `STT_BASE_URL` and `STT_MODEL` are the names, and `OLLAMA_URL` / `WHISPER_URL` / `WHISPER_MODEL` now refuse the boot rather than resolving — see the rename note in the media-embedding guide for why refusing beats ignoring. **This matters for a rollback in one direction only:** the current names resolve in every 3.x build, so a manifest written for 4.0 runs on 3.x unchanged. A manifest still using the legacy names runs on 3.x and will not start on 4.0. |
| `mediaEmbedding.faceRecognition.enabled` → the image ladder | `faceRecognition.enabled` | applies its own default for face recognition rather than the choice that was recorded |
| every token gains a `rights` matrix **in memory** | **nothing** | keeps working, and `config.json` is not touched at all — the matrix is derived on each start and never written, so there is nothing here for a rollback to undo |
| a legacy `syncSchedule` shorthand → the cron expression it always meant | **nothing** | keeps syncing at exactly the same rate. This is the one row here with no rollback cost, and it is listed so you can tell it from the others: `"every 5m"` becomes `"*/5 * * * *"`, and every 3.x build tried a real cron expression FIRST, so it runs the rewritten value identically. **New in 4.0**, where sending a shorthand is refused with a `400` naming its cron form. A shorthand outside cron's range — `"every 90m"` — is NOT rewritten: it never resolved on any build, so that network has been on manual sync all along, and it is named in the startup log rather than rounded to a schedule nobody chose. |

The first three are silent in the old build — the field is simply absent, which reads as "never configured"
rather than "removed".

**`tokens[].rights` is not a file change at all, and this paragraph used to say it was.** The upgrade derives a
per-space rights matrix for every token from its legacy `admin`/`readOnly`/`spaces` fields — **in memory, on
every start, and it is never written to `config.json`.** The legacy fields stay in the file, and the copy an
operator takes before upgrading is byte-identical afterwards as far as tokens are concerned.

**They are not what enforcement reads, and this paragraph used to say they were.** `spaces`, `admin` and
`readOnly` left the token record in 3.1; 4.0 removed the last fallback to them, so a token reaching the
instance with no rights matrix now reaches nothing at all. Nothing is lost by that here, because the matrix
is derived from those same three fields on every start — which is why this is still a row about a rollback
costing nothing rather than a row about a migration.

It is kept in this table because it is the row people ask about: a rollback needs no token work, and there is
no shape change to explain.

**Corrected 2026-09-05, and the correction is worth stating.** This section said the matrix was written down.
The code did attempt that write on every boot — and it could never succeed, because the mechanism it used does
not exist in this codebase, so the attempt failed and was logged as a warning every time. So the hazard this
paragraph described has never existed on any instance. Writing it deliberately is separate future work, and
this table gains a row on the day it happens.

### The procedure

```bash
# BEFORE upgrading — this file is the rollback, and it is 4 KB
docker compose cp ythril:/config/config.json ./config.json.pre-upgrade

# ... upgrade, and if it goes wrong:
docker compose down
docker compose cp ./config.json.pre-upgrade ythril:/config/config.json
# pin the previous tag in compose (or .env), then:
docker compose up -d
```

**Brain data in MongoDB needs no rollback of its own.** Documents only ever gain fields, and both the API and the
UI ignore ones they do not know, so an older build reads newer records — it simply does not show the newer fields.
The exception is anything created by a feature the old version lacks: a record whose `type` has no schema in the
old build is still stored and still returned, just unvalidated.

**Rolling back past 5.6.0 leaves the read-spill store behind, and it empties itself.** The `_read_spills` and
`_read_spill_pages` collections are unknown to an older build, which neither reads nor removes them; their
MongoDB TTL index keeps running, so every spill in them is gone within a day. Until then an older build's
backups include them, because it does not know to leave them out. The legacy spills the upgrade swept are not
restored, and an older build goes back to writing new spills into the space.

**Vector indexes are rebuilt on boot**, so a rollback that changes the embedding model or its dimensions costs a
reindex, not data. Check `GET /ready` before sending traffic — see [Runtime Model Downloads](02-hosting.md#runtime-model-downloads)
if you also pinned a different model.

**Backup before upgrading:**

```bash
# Stop the stack to get a clean snapshot
docker compose stop

# Copy volumes
docker run --rm -v ythril-data:/src -v $(pwd)/backup:/dst alpine \
  sh -c "cp -a /src/. /dst/data/"
docker run --rm -v ythril-mongo-data:/src -v $(pwd)/backup:/dst alpine \
  sh -c "cp -a /src/. /dst/mongo/"

# Also back up config/ (bind mount — just copy)
# config.json, secrets.json, and schema-library.json (if present) are all required for a full restore.
cp -r config/ backup/config/

docker compose start
```

---
