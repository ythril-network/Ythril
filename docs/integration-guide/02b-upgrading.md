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
file's bytes, and is discarded sooner when a file tombstone says the file was deleted. A record with a key of the
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

## Rolling Back

**A rollback to 5.6.x rebuilds `{ seq: 1 }` before it listens, and leaves the new indexes behind.** An older build creates
`{ seq: 1 }` (tombstones: `{ type: 1, seq: 1 }`) at every boot, before it accepts a request, on each collection that no
longer has it — which, once the background build above has finished and dropped it, is every record collection. On a large
instance that is a boot that takes as long as the build did. The `{ seq: 1, _id: 1 }` indexes stay: an older build neither
reads nor drops them, and they cost a second index on every write until the upgrade is done again. A scanner cursor that
the newer build wrote is read by the older one as its `seq` alone, and scans nothing twice.

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
