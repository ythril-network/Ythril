# Files API

> Part of the [Ythril Integration Guide](../integration-guide.md).

## Files API

Base path: `/api/files`

> **Proxy spaces:** Read operations (GET) search across all member spaces. Write operations (POST, DELETE, PATCH, mkdir) require `?targetSpace=<member>` in the query string.

### Upload a File (raw bytes)

```http
POST /api/files/:spaceId?path=reports/q1.pdf
Content-Type: application/octet-stream

<raw bytes>
```

Any file type is supported — documents, images, binaries, archives, etc. Ythril stores the raw bytes as-is.

**The `Content-Type` header is not purely informational.** Together with the `?path=` extension it decides
which processing pipeline the file enters, and it is the type handed to the media providers — the vision
model receives it inside a data URI, and the speech-to-text provider uses it to name the uploaded audio.

Precedence is: a **specific** `Content-Type` wins; otherwise the **file extension** decides; only when both
are unusable does the file fall back to `application/octet-stream`. Generic values
(`application/octet-stream`, `binary/octet-stream`, `*/*`, …) count as "not stated", so
`POST …?path=photo.png` with `Content-Type: application/octet-stream` is correctly processed as
`image/png`. Sending the true type is still preferred, and it is the only signal available for a path
with no extension.

> One exception: do **not** send `Content-Type: application/json` for a raw-bytes upload. That content
> type selects the JSON body form documented below, and the request will be parsed as JSON rather than
> stored as bytes. Upload `.json` files with `application/octet-stream` (the extension is enough) or use
> the JSON/base64 form.

**Response** `201` for opaque/non-document files (`{ path, sha256 }`). For a **document or media** format that triggers async conversion/embedding (PDF, DOCX, images, audio, …) the response is **`202 Accepted`** with an `embeddingStatus: "pending"` — the file is stored immediately and its searchable content is produced in the background (poll File Meta or retry-embedding for status):

```json
{ "path": "reports/q1.pdf", "sha256": "a1b2c3...", "embeddingStatus": "pending" }
```

A **media or document** re-upload whose bytes are unchanged answers `"complete"` instead (or `"pending"` while
its job is still under way): the analysis it already has, or is doing, is kept rather than re-run or reset. See
[Media Embedding](05b-media-embedding.md#upload-response) for when a re-upload does re-analyse — every case
except those. A file with an extension the pipeline does not recognise is stored as it is; the answer carries no
`embeddingStatus` for it, and its record says `skipped`.

**An upload to a path that runs through a regular file (`a.txt/x`) answers `409` with `code: "path_blocked"`**, a
chunked upload at its first range, and nothing is stored or left staged ([the reasons](#move--rename)).

**An upload whose record cannot be written answers `5xx` and leaves nothing behind for a new path:** the bytes it
stored are removed, so nothing is listed or offered to a peer; send it again. For a path that already has a record, the
bytes are kept and the next upload rewrites the record. When the database itself did not answer (`503`, retryable), the
bytes are kept as well, because nothing can say whether a record exists; the retry rewrites them, and a pull that is offered the
path takes back bytes no record names once the database answers.

**A peer's upload of a file this instance deleted is not stored.** Sync pushes a file's bytes to this route with a peer token. When this instance holds a deletion for that path, the path has not been re-created since (a live file there with other bytes, or a newer version written by the instance that issued the deletion — another author's higher version number does not count), and the arriving bytes are the content the deletion erased, the answer is `200 { "tombstoned": true }` and nothing is written, so the file does not come back from a peer that has not heard of the deletion yet. **A deletion counts from the moment its bytes are gone**, not from the moment its tombstone is published: a delete writes its tombstone first and publishes it once the file is removed, and an upload that arrives in between is answered the same `200 { "tombstoned": true }`. A deletion whose file is still there shadows nothing. If this instance cannot look at the path to tell which of the two it is (a file-system fault other than "it does not exist"), the answer is a retryable `503` with `Retry-After`, nothing is stored, and the sender does not remember it; it uploads again on its next cycle. It is a `200` on purpose: a sender that took it for a failure would upload the same bytes every cycle. Identical bytes re-created by the issuer as a newer version arrive with their metadata first and are stored. A user's own upload, with any other token, is **never** refused this way, and a chunked upload is decided before its target is written (see [Chunked Upload](#chunked-upload-content-range)). The `path` is resolved before anything is looked up by it, so `x/../file` is the deletion of `file` however it is spelled. A deletion held from before the upgrade names no version and shadows nothing. See [Sync API → File Sync Artifacts](09-sync-api.md#file-sync-artifacts).

**What else a peer's upload does differently.** Bytes a peer token delivers are recorded as an **arrival**, by the one function the manifest pull also records through: size and hash, the peer as author of a row new here, no seq of its own, then processing by THIS instance's rules (conversion, chunking, the media pipeline; an image's face analysis follows `reprocessSyncedImages`). The body's `description`, `tags` and `properties` are ignored (they come by metadata sync), and **nothing is announced**: a peer's push fires no `file.created` webhook and no live-view event, as a synced record fires none (a person's upload, with a user or API token, still fires one). **A path inside a conversion tree** (`_converted/…` or `_extracted/…` at the root of the space) is not stored when a peer offers it, and is answered `200 { "ignored": "instance-local" }`, single or chunked (each instance converts by its own settings; an older sender reads the `200` as delivered and stops). A person's upload to such a path is never asked.

### Upload a File (JSON / base64)

```http
POST /api/files/:spaceId?path=assets/diagram.svg
Content-Type: application/json

{
  "content": "PHN2ZyB4bWxucz0...",
  "encoding": "base64"
}
```

`encoding` is `utf8` or `base64`, and **`write_file` over MCP takes the same two and means the same thing
by them** — the decode, the vocabulary and the refusal are one module behind both doors. Base64 that is not
base64 is a `400` rather than a short file: `Buffer.from` skips characters outside the alphabet, so the
usual mistake — sending a whole `data:image/png;base64,…` URL instead of only the part after the comma —
would otherwise store something corrupt under a `201`.

The two doors differ in what they can CARRY, not in what they accept. A tool call arrives as one JSON body
capped at 10 MB, so roughly 7 MB of file fits once base64 inflation is counted; this route takes a raw body
up to `maxUploadBodyBytes` and supports the chunked upload below.

---

### Chunked Upload (Content-Range)

For files larger than 10 MB, split into chunks and send with `Content-Range`:

```http
POST /api/files/:spaceId?path=large-file.zip
Content-Type: application/octet-stream
Content-Range: bytes 0-5242879/15728640
Authorization: Bearer ythril_…

<5 MB of raw bytes>
```

Intermediate chunks return **202**:

```json
{ "path": "large-file.zip", "received": 5242880, "maxBodyBytes": 52428800 }
```

`maxBodyBytes` is the single-body limit this door enforces (`maxUploadBodyBytes`), so a client that does not know it can size its next chunk under it. The sync engine learns a peer's limit from it.

**`x-expected-sha256`** — optional, on any chunk: the SHA-256 (64 hex digits) of the **whole** file. When it is sent, the assembled file is verified against it before it is renamed into place; a different assembly stores nothing, drops the staged chunks and answers **`422`**. A value that is not 64 hex digits is `400`, never read as absent. The sync engine sends it on every chunk of a push above the receiver's single-body limit (before this, such a file was answered `413` on every cycle).

The final chunk (where `end === total - 1`) returns **201** with the full file hash:

```json
{ "path": "large-file.zip", "sha256": "a1b2c3..." }
```

**A peer's chunked upload is decided before the target is written.** When the final chunk arrives from a peer token and some deletion held for the path carries a content hash (published, or pending with its file already gone — see [above](#upload-a-file-raw-bytes)), the staged chunks are hashed in one streaming pass first. If the hash is the erased content's, the staged chunks are discarded, the answer is `200 { "tombstoned": true }`, and the file at the path — whether there is one or not — is never touched. A path nobody deleted costs no extra pass. **When the peer promised the file's hash (`x-expected-sha256`), the same question is asked at the FIRST chunk, by path and promised hash**, so a shadowed file is turned away before any chunk is staged or counted against the quota; the final chunk's check of the staged bytes stays the authoritative one. A user's own chunked upload is never asked.

Duplicate ranges are silently accepted (idempotent). The `maxUploadBodyBytes` config limit applies per-chunk; the declared `Content-Range` total is bounded by `maxChunkedUploadBytes` (default 10 GiB → **413** when exceeded). Every chunk is also checked against the storage quota — the first chunk projects the full declared total — and returns **507** when the files hard limit would be exceeded. Bytes staged under `.chunks` count toward measured file usage.

### Check Upload Progress

```http
GET /api/files/:spaceId/upload-status?path=large-file.zip&total=15728640
```

**Response** `200`:

```json
{ "received": 5242880 }
```

Resume by sending the next chunk from the `received` offset. Stale chunk directories (older than 24 hours) are automatically cleaned up.

---

### Download a File

```http
GET /api/files/:spaceId?path=reports/q1.pdf
```

Returns raw file bytes. Works with any file type — PDFs, images, archives, source code, etc. If `path` is a directory, returns a JSON listing.

The bytes are the file **as uploaded**, whether or not the instance encrypts files at rest
([Encryption at Rest](02a-encryption-at-rest.md#uploaded-files)); `Content-Length`, the listing's `size` and every hash are the
plaintext's. A stored file this instance cannot decrypt — written under another master secret, altered on disk, or
encrypted on an instance that no longer has a secret — answers **`500`** with `{ "error": "<file> cannot be read:
<reason>" }` rather than serving ciphertext. A file altered partway through is detected chunk by chunk, so that case
can surface as an aborted transfer after the headers were sent; the client sees a failed download, never a short
file that looks complete.

Active-content types that can execute script when rendered in the browser (`.html`, `.htm`, `.svg`, `.xml`, `.xhtml`) are served with `Content-Disposition: attachment` and a `sandbox` Content-Security-Policy (stored-XSS guard). Passive types — images, PDF, plain text — are served `inline` and preview normally. The header names the file twice (RFC 6266): `filename*=UTF-8''…` carries the real name, percent-encoded, and `filename="…"` an ASCII stand-in for a client that reads only the old form, so a file of any name downloads — before this, a name with a character above U+00FF (`日本.txt`, an emoji, an accent sent decomposed) answered `500`.

**A read spill's `path` is not a file here — deprecated, and removed at the next major.** `recall` and
`similar` still send `path` on `remainder`, shaped `_tmp/results-<spillId>.json` (an older answer's
`graphComplete.path` was `_tmp/graph-<spillId>.json`), because before 5.6.0 a spill was a file at the space root. Since then no search
writes into a space, and exactly that path at the root is answered from the spill store instead of the file
store: JSON, `Cache-Control: no-store`, for the **token that ran the search alone**, under the same rule and the
same `404` / `410` as `GET /api/brain/spills/:id` — `files: read` on the space is not enough. It returns the
spill's first window under the default budget, with `nextSkip` when there is more. Read spills by `spillId`; see
[Reading a spill](04a-recall-api.md#reading-a-spill-get-apibrainspillsid-and-mcp-read_spill). A file of your own
under a `_tmp` folder deeper in the tree, or with any other name, is an ordinary file.

---

### List Directory

```http
GET /api/files/:spaceId?path=reports/
```

**Response** `200`:

```json
{
  "path": "reports/",
  "type": "dir",
  "entries": [
    { "name": "q1.pdf", "type": "file", "size": 204800, "embeddingStatus": "complete", "tags": ["finance"] },
    {
      "name": "q1-data.xlsx", "type": "file", "size": 51200, "embeddingStatus": "processing",
      "progress": { "step": "vlm", "steps": ["render", "vlm", "repair"], "done": 12, "total": 40 },
      "progressAt": "2026-07-27T15:04:11.204Z"
    },
    { "name": "charts", "type": "dir", "size": 819200 }
  ]
}
```

A directory's `size` is the recursive sum of everything beneath it. Files carry their `embeddingStatus` and
`tags` from the file's metadata record.

**The root `_converted/`, `_extracted/` and `_tmp/` directories are left out of a listing** unless you send
`?includeDerived=true`. The first two are the conversion pipeline's output
([Conversion Pipeline](05a-conversion-pipeline.md)). `_tmp/` is where versions before 5.6.0 wrote read spills;
nothing writes spills there now, and the ones that remain are swept away by the retention pass every few minutes — anything else under it is
yours and is kept. Only at the root: a directory of your own with one of these names deeper in the tree is
listed like any other.

**`progress` / `progressAt` are present only while a file is in flight** (`pending`/`processing`) *and* its
worker has reported at least one step:

- `steps` is the route **this** file is taking, not a fixed list — it differs per file type and per the
  space's effective extraction level, so a client can render exactly the stages that will really run.
- `step` is the one running now; `done`/`total` are units within it (pages, usually) and are **absent for
  stages that are not divisible** — render those as indeterminate rather than inventing a fraction.
- `progressAt` is the last sign of life. Treat a file whose `progressAt` is older than the stall timeout as
  **stalled**, not working — that distinction is the whole point of the field.

Absence means "not known yet", **not** "no work to do": a job claimed a moment ago has no `progress` until
its first report. Fall back to `embeddingStatus` rather than rendering an empty progress indicator. The
lookup is best-effort server-side, so these fields may also be absent if the job store was briefly
unreachable — the listing itself never fails over them.

---

### Create Directory

```http
POST /api/files/:spaceId/mkdir?path=reports/charts
```

**Response** `201`:

```json
{ "created": "reports/charts" }
```

Creating a directory that already exists succeeds. A name that is a file, or a path that runs through one, answers `409`
with `code: "path_blocked"` and creates nothing ([the reasons](#move--rename)).

---

### Move / Rename

```http
PATCH /api/files/:spaceId?path=reports/draft.docx
Content-Type: application/json

{ "destination": "reports/final.docx" }
```

**Response** `200`:

```json
{ "from": "reports/draft.docx", "to": "reports/final.docx" }
```

**A destination that cannot exist is refused before anything changes: `409`.** A directory cannot be created, and a
file cannot be moved, uploaded or written, at a path whose ancestor is a regular file (`a.txt/x` where `a.txt` is a file).
A directory moved into itself, or a path moved onto itself, is refused the same way. The body is
`{ "error", "code": "path_blocked", "path" }`, with `path` relative to the space (on `POST /api/<tool>` that object is the
answer's `data`), and it is the same on `PATCH`, `POST /api/move_file` and MCP `move_file`, on `POST …/mkdir` and MCP
`create_dir`, and on an upload, a chunked upload (refused
at its first range, with nothing left staged) and MCP `write_file`. Nothing is moved, created or written, and no
tombstone is published. **It is `409`, not `400`, because the refusal is about the receiver's tree, which can change:** a
sync sender reads `400` and `422` as a refusal about the bytes and stops re-sending them, and it must keep trying. It is
not `404` either: a `404` on a move says the **source** names nothing, and that includes a source path that runs
through a file.

**A move never replaces anything: `409` with `code: "destination_exists"`.** If a file, a folder (empty or not) or a file's
record already stands at `destination`, the move is refused before anything changes: no byte moves, no tombstone is
published and no job is held. The body is `{ "error", "code": "destination_exists", "path" }` with `path` the
destination as requested, and it is the same on `PATCH`, `POST /api/move_file` and MCP `move_file`. **To replace, delete
the destination first** (`DELETE` or `delete_file`; a folder needs `confirm: true`): that deletes it on every instance it
is replicated to. A file record whose bytes are not here yet (its content may still be arriving from a peer, or an
earlier delete was interrupted) blocks a move the same way and is removed by the same delete; a file whose content is
still arriving from a peer appears once it has. What does not block a move: a name that only a deleted file's audit record holds (see below), and
what a file that no longer exists left behind (a conversion sidecar or a derived record whose file has neither bytes nor
a live record), which the move removes. A **case-only rename** (`a.txt` to `A.txt`, or `Docs/a.txt` to `docs/a.txt`) on
a case-insensitive file system is one file under a new spelling and succeeds, record included. **Only a move is
refused:** an upload or a restore onto a name still replaces it, and so does the conflict resolution `keep-incoming`,
which replaces your local file with the incoming copy by design. The other conflict resolutions that place the copy
(`keep-both` with a `rename`, `save-to-space`) refuse an occupied destination as a move does (see
[Conflicts](10-mfa-and-conflicts.md)).

A move carries what belongs to the path: the metadata, the derived records, the conversion sidecars (`_converted/<id>.md`
and `_extracted/<id>/`, a peer's copy of one included) and the queued jobs of all of them. A directory `<id>.md/` standing
beside the file is not the file's: its converted tree (`_converted/<id>.md/`) is never touched by the file's move.
**One sidecar failure does not keep a move owed:** when something else stands at a sidecar's destination (`DestinationExists`)
only after the file's own bytes moved, no retry can find it gone, so the move finishes **without that sidecar**. What stands
there is untouched, the moved file's own sidecar (its bytes, its row and its jobs) at the old place is removed, the moved
record carries **no `convertedFileId`** (a pointer would name the occupant's text as the file's own), the move answers
success, and a conversion of the file afterwards is refused while bytes that no record derived from the file hold its
converted path (delete that path, then reprocess the file with `retry_embed_file`). It is counted in
`ythril_file_moves_finished_without_sidecar_total` and logged once. Any other failure of a sidecar (a file-system fault)
keeps the move owed as above.

**A directory move or delete has no size limit: it carries (or removes) every record under the directory, however many files
it holds, and takes time in proportion to what it holds,** and one that is interrupted is finished later
([stated under Delete a File](#delete-a-file)).

#### A file is identified by its PATH, and that is the one record type where it is

Entities, facts, edges and chrono entries all carry a UUID. **A file's metadata record does not**: its
`_id` IS its path, chunks extend the same key as `path#chunkN`, and every file operation addresses by
path. `sha256` changes on every save and `seq` is a sync counter, so neither is a handle either.

**It is deliberate, and the reason is deletion.** A delete writes a sync tombstone per removed path so
peers remove their copies; the link records a file takes part in hang off that same id, a rename
re-keys them, and a delete removes the ones this instance wrote. A second identity would be a second thing each of those has to reconcile, and the one that
disagreed would be found by an operator rather than by a test.

**So a rename changes a file's identity, and two guarantees make that survivable.** Both are asserted by
`a-file-keeps-its-metadata-across-a-move.test.js`; neither was written down before an integrator measured
them from outside and built a workaround they did not need.

| | |
|---|---|
| **A move carries the whole record** | `description`, `tags`, `properties`, `sha256`, the embedding state and the link arrays all arrive at the new path. The record is re-inserted under the new key with every field intact. |
| **What the file owns moves with it** | Its chunk records (`path#chunkN`), a converted document's Markdown (`_converted/…`) and extracted images (`_extracted/…`, with their captions and faces) are re-keyed to the new path, on disk and in the metadata, and each still names the moved file as its parent. A conversion still running when the move lands writes nothing under the old path: it is re-run where the file now is. Nothing is left under the old path to find with `filter`, and a later delete of the moved file removes all of it. The file's **links** (to entities, facts and chrono entries) follow it too, for a folder move as for a single rename. Asserted by `a-moved-file-leaves-nothing-at-its-old-path-db.test.js`. |
| **A content rewrite touches only what you send** | `POST` with a body carrying no `description`, `tags` or `properties` changes the bytes, the size and the hash, and leaves those three exactly as they were. Sending one replaces that one. |

**To hold a stable handle onto a file, mint your own id into `properties` and resolve it with a query**
on that key:

```http
PATCH /api/brain/spaces/:spaceId/files?path=reports/final.docx
Content-Type: application/json

{ "properties": { "externalId": "6f1c…" } }
```

```http
POST /api/filter
Content-Type: application/json

{ "space": "…", "collection": "files", "filter": { "properties.externalId": "6f1c…" } }
```

`update_file_meta` merges `properties`, so re-asserting the key is safe and idempotent — but with the
guarantee above you do not have to re-assert it after every write.

---

### Delete a File

```http
DELETE /api/files/:spaceId?path=reports/q1.pdf
```

**Response** `204`. A failure that none of the answers below describes is `500 { "error": "Failed to delete" }`, for a file and a directory alike.

**A directory.** Deleting a directory needs `{ "confirm": true }` in the request body (a boolean: any other value is
`400`). Without it the answer is `422` with `{ "error", "code": "confirm_required", "path" }` and nothing is deleted. The
space's root directory is never deleted: `400` with `code: "space_root_refused"`, whatever `confirm` says. A path the
server's storage refuses to look at answers `500` with `code: "file_system_fault"` and names no path (it used to read as
a missing path, `404`); a path with nothing at it is `404`. A directory delete that was interrupted is completed by
repeating it with `confirm: true`, which finds what the first one left.

**The MCP `delete_file` tool takes the same `confirm` parameter, and an MCP token with `files: write` can now delete a
directory tree, with `confirm: true`, exactly as on REST.** It answers `Deleted '<path>'.`; without `confirm` a directory
is refused `422` and nothing is deleted. `POST /api/delete_file` is the same tool. A directory delete fires one
`file.deleted` webhook for each file it removed, as a single file's does (the live Files page hears each one too): never one for a
conversion sidecar, a derived record or a file an earlier delete had already flagged, and none when the delete was made by no
user (a retention sweep reports under its own actor). Each file is announced at most once, a delete repeated after a failure
announces what the failed attempt had not, and an announcement lost to a crash between the removal and the event is not made
again. A directory of many files is a burst of events: see [Webhooks → delivery guarantees](14-duplicates-and-webhooks.md#delivery-guarantees).
It is audited with `kind: "directory"`
([the audit log](13-audit-log-api.md#what-changed-changes)); a single file's delete records no change.

Deleting a file cascades: its metadata record, any queued embedding job, the links this instance wrote from the file and from
its derived records (each with a link tombstone, so a peer does not restore it), and all conversion
artifacts — chunk records plus the on-disk `_converted/<id>.md` and `_extracted/<id>/` sidecars —
are removed from the file store. **A link another instance wrote stays with it**: the delete does not carry it, and a file
uploaded at the path later is linked to what that instance linked, until that instance removes the link
([Links API](04g-links-api.md)). A link a fact or a chrono entry holds *to* the file is the record's own and is not touched. **Everything derived from the file goes with it, however deep:** the records of an
extracted image's caption and faces hang from the image, not from the file, and are removed too; so are the metadata rows
a sidecar left on this instance (one an older peer delivered before sidecars became instance-local included),
flagged or removed as the file's own record is (`softDeleteFileMeta`), and the queued jobs of the extracted images.
A directory `<id>.md/` standing beside the file is not the file's: its converted tree (`_converted/<id>.md/`) is never
touched by the file's delete. Deleting a **directory** does the same for every file beneath it (their links included),
including the `_converted/<path>` and `_extracted/<path>` subtrees, and writes a sync **tombstone**
per removed file so peers delete their copies too (otherwise the next sync would push them back). The links go once the tree
has: those of a file a failure left standing stay with it, and a repeat of the delete removes the rest.

**A delete takes what derives from the file even work running at that moment.** A media job that is processing the file
when it is deleted, moved or wiped with its space cannot write a derived record afterwards: every write it makes about
its file is made under its claim on the job, and a delete, a move, a directory delete and a space wipe revoke the claims
first. A run that lost its claim ends without completing or failing, and writes nothing about a file re-uploaded at the
same path. **The one exception is a face run's auto-label:** linking the recognised person to the file is an authored write
that cannot join the claim, so it is made just after a check that the run still holds it, and a file deleted and uploaded
again at the same path in that instant can receive the link. **Records a previous version already leaked** (a derived record written after the delete by a job that was
running, a row a move did not re-root, a link a delete left) are **removed by a repair that runs in the background**,
a few pages per sweep cycle (`TTL sweep: repairing rows a deleted file left`; see [Setup → Background jobs](11-setup-api.md#background-jobs-and-the-spaces-they-walk)):
the derived rows whose file is gone (no record, a deleted file's audit record, or another file), and the links of a
file **this instance** deleted that this instance wrote, with a tombstone so peers drop them. It never removes a row it
cannot explain (a chain of derived rows deeper than the walk reads), a row newer than the scan, or anything of a file
that is back, and a removal is irreversible. Until it reaches them they are invisible to the file listing, but a leaked
face record is still matched by gallery search, and one can attach to a file re-uploaded at the same path.

**Who the deletion reaches.** A peer applies the tombstone to the copy it holds only when the deletion rule allows it
(see [Sync API → file tombstones](09-sync-api.md#file-sync-artifacts)): a peer deletes **a copy this instance wrote**
wherever it is a peer, and on a pub/sub or tree network **everything downstream of this instance**, including a
file this instance only relayed from above. A delete of a file **another instance wrote** stays local on a mesh peer
(a club, closed or democratic network): it is not applied there, so the other peers keep the file, and it stays
gone from this instance only until the instance that wrote it changes the file again (the held deletion covers the
version it saw). A peer applies it to the version this instance deleted
and no later one — a file re-uploaded to the path since is kept — and removes the file's derived records and
sidecars with it. The same holds for a move, whose old paths are tombstoned.

**Soft-delete (`softDeleteFileMeta`).** With this top-level config flag set to `true` (default
`false`), deleting a file **retains** its metadata record and flags it `deletedAt = <timestamp>`
instead of removing it. A flagged record is this instance's own audit record: it is left out of the file
listing, **never offered to a peer** (not pushed, not served by the sync routes, not hashed by the Merkle check)
and the flag stamps no `seq` or `updatedAt`.

**What a flagged record is not, and the one door that still reaches it.** It is not a file the space has, so it is
absent from the listing and from every file count (`GET /spaces/:spaceId/stats`, the MCP `space_stats` tool and a
space's own shape all answer the same number); it is not a result of `recall` or `similar`, on either door, nor of the
lexical half of a search; a graph walk does not reach it and attaches none of its fields; it is not a valid edge or
link target, so a strict-linkage space refuses a reference to it exactly as it refuses a path that never existed; the
by-path metadata read, the extract route and `PATCH` answer `404` for it, and `update_file_meta` refuses it exactly as
it refuses a path that never existed (`isError` on MCP, `400` on `POST /api/update_file_meta`, like every tool failure). **The exception is the
structured query door**: `POST /api/filter` and `POST /api/query` over `collection: "files"` DO return it, because
after all of the above nothing else would, and the record exists to be read. Filter on `deletedAt` to tell the two
apart — `{"deletedAt": {"$exists": false}}` for the files the space has, `{"deletedAt": {"$exists": true}}` for what
was deleted and when. Bytes written to the same path again (an upload, or a file a peer
delivers) clear the flag, and so does a file **moved onto** the path: the flagged record is removed and the moved file's own
record stands there. **The deletion reaches peers as the file tombstone, and each peer applies it by its
own `softDeleteFileMeta`**, whatever this instance's setting: one keeps its flagged row, another removes it.
A restore from an admin export keeps the flag its backup row carried (the import summary counts them in
`flagsKept`). Derived records (conversion chunks / `_converted` / `_extracted`) are always hard-removed
regardless of the setting.

**A second delete of a flagged record is `404`, never a second success.** A delete that names a record already flagged `deletedAt`, or a derived record (a chunk of a document, a face found in a picture) rather than the file, answers `404` on `DELETE /api/files/:spaceId`, `POST /api/delete_file` and the MCP `delete_file` tool alike (an error result in MCP): no second tombstone is written, no second `file.deleted` webhook fires, and `seq` does not move. A first delete that was interrupted (a store failure, a restart in between) still completes on retry, because its record is not flagged yet. So after a delete that timed out, a `404` on the retry can mean the first one did complete: list the files before deleting again. With `softDeleteFileMeta` off the record is gone after the first delete, and the retry answers `404` for that reason.

**Deleting the file deletes its metadata.** There is no metadata-only delete and does not need to be:
every file has a metadata record, and `DELETE /api/files/:spaceId?path=…` removes both. An **orphan** —
a record whose bytes went missing out of band — is completed by that same call, which answers `204`
rather than `404` when it finds one and writes the sync tombstone the file never got, so a peer does not
push it back. MCP `delete_file` and the record TTL sweep complete an orphan the same way. A path with
neither bytes nor a record is `404` on both doors (an error result in MCP, which used to carry the
filesystem's `ENOENT` and the absolute data path); a move whose source is not there is `404` too, unless
it is a move to finish (below). A **source** path that runs through a regular file (`a.txt/x`) names nothing, so it
is `404` as well; it is the **destination** a file blocks that is `409` (see Move / Rename).

**A delete or a move that fails is safe to retry, and a store failure never answers success.** A store
failure anywhere in the act answers `503` (retryable) on REST, and an error result with `retryable: true`
in MCP — it used to answer `204` or `200` when it came after the bytes, with the metadata left behind.

- **Before the bytes.** The tombstone is written BEFORE the bytes are removed or moved, so a failure there
  leaves the file exactly where it was, and the retry repeats the whole act. **A peer is never told to delete
  a file that is still here**, because the tombstone is written *pending* and published — served on
  `GET /api/sync/file-tombstones` and pushed by a sync cycle — only once ITS path's bytes are gone or moved.
  That is per path, not per act: a move's or a directory delete's conversion sidecars (`_converted/…`,
  `_extracted/…`) go after the file, and each sidecar's tombstone waits for its own move or removal. A peer
  that applies a tombstone deletes its copy and, where it serves the space onward, passes the tombstone on, back
  to this instance too, so a tombstone for bytes still here would delete the only copy; a pending one is sent
  to nobody. An act that
  fails (a store failure, or an unlink, rename or tree removal that fails for any other reason) settles its
  pending tombstones from the disk at once — published for a path whose file is gone, dropped for one whose
  file is still there — so a directory delete that stops part way still tells peers about the files it did
  remove. One that outlives its act — a write the store reported failed that landed later, a settle that
  failed, a restart in between — is settled the same way by the record TTL sweep within minutes, oldest
  first; one whose path cannot be looked at is tried again on a later sweep, behind the rest.
- **One tombstone per path per act, retries included.** Publishing a path's tombstone removes every other
  pending tombstone for that path — the one a failed attempt left behind is the same intent, not an act of
  its own — and the TTL sweep drops a leftover whose path already has a tombstone published after it was
  written, rather than publish a second. A retried act used to end with two, and the later one deleted a
  re-upload of that path made in between. A tombstone now also names the version it deleted, so a peer keeps a
  later one, but a second tombstone is still noise nobody needs.
- **A file's sidecars follow the file; they get no tombstone of their own, and no peer holds or sends one.** Deleting one
  file writes ONE tombstone, for that file. A peer that applies it removes the file's derived records and sidecars (the
  list above) by its own cascade: a conversion's sidecar (`_converted/…`, `_extracted/…`) is that instance's own and never
  travels, so there is none of this instance's to refuse. An older peer that still offers a sidecar — its bytes by
  `POST /api/files` (single or chunked) or in a manifest, its metadata in a batch or a pull — is ignored without a
  refusal: `200 { "ignored": "instance-local" }` at the byte door, no download from a manifest, a metadata row or a file
  tombstone for the path dropped. A person's upload to a sidecar path is never asked. A deleted file that is written
  again at the same path is a new file, whose conversion writes its sidecars afresh.
- **After the bytes.** The metadata record is removed (or, for a move, re-keyed) LAST, so it is still there,
  and the same request retried completes the act. A delete completes as an orphan, as above. A directory delete
  sent with `{ "confirm": true }` finds records under a folder whose tree is gone, tombstones their paths and
  removes them.
- **A move the instance began is the instance's to finish.** A move whose bytes moved and whose records could not
  all follow answers **`503` with `Retry-After`**, `retryable: true` and `code: "move_still_owed"` (`path` is the
  destination). It is not the store's "nothing was written": the file is at `destination` already. The move is not
  lost and needs no retry to survive: the record TTL sweep finishes it (the step `TTL sweep: finishing interrupted file
  moves`, see [Background jobs](11-setup-api.md#background-jobs-and-the-spaces-they-walk)), and a retry of the same
  `PATCH` or `move_file` completes it too. **A retry finishes the move it began and is never refused for what that
  move already put at `destination`.** It finds the file at `destination`, the records at the old path and the mark the
  first attempt left with its tombstones, and finishes them; without that mark — an old path whose file went missing
  for another reason, or a file at `destination` that is not the one the move carried — it is `404`, and nothing at
  `destination` is touched. That identity check is for a **file** (the mark records its size and modification time); a
  **directory** carries none, so a retried directory move is judged on the mark, the bytes at `destination` and
  something of it still at the old path. **So a `404` on a retried move can mean it was finished**, by the sweep or by
  an earlier attempt whose answer you never saw: look at `destination` before moving again, because a new move onto
  the finished destination is `409 destination_exists`. A move the sweep gave up on is *stranded*: its records stay at
  the old path and its mark is kept, so a retry can still finish it (`ythril_file_moves_stranded`). A move finished by
  the sweep fires `file.updated` once, with `previousPath` ([webhooks](14-duplicates-and-webhooks.md#webhooks-api)).
- **A half-made link is finished by the next retry or by the sweep.** A move gives a file its new name by a hard link
  and then removes the old name, so a failure between the two leaves one file under two names. A retry or the sweep
  removes the old name; a failure to remove it undoes the new link and is the move's answer, so the file is never left
  under both. Two names of one file with no mark of a move between them are an operator's own hard link: a move onto
  one is refused `destination_exists` and both names stay.
- **A finish that meets another file's records answers `409` with `code: "destination_held_after_move"`.** If, after
  the bytes moved, the record of ANOTHER file (a peer's file arriving at that id, say) holds an id the moved records
  need, the finish is refused with `path` the held id and `heldBy` the other file's space-relative path, and the
  sentence says the bytes already moved. Nothing of the other file is touched; the mark is kept and the move stays owed
  (`ythril_file_moves_owed`, then `ythril_file_moves_stranded` once the sweep gives up). The sweep keeps retrying the
  move; deleting the file that holds the name and repeating the move finishes it. The file's own late writes at its old or new ids and the leftovers of a file that no longer exists are not
  another file's: the finish replaces them (`ythril_file_move_rows_replaced_total`).
- **What a move leaves is whole.** Each record of a moved file is wholly at its old path or wholly at its new one,
  whatever fails, and the file's links are at one path or the other and never at neither. A move replaces no live file,
  so a moved file keeps its own links and never inherits the people, facts or chrono entries linked to another.
- **The no-overwrite guarantee needs hard-link support on the data volume** (see
  [Hosting](02-hosting.md#data-persistence)). On a file system that refuses a hard link a move falls back to a rename,
  counted in `ythril_file_move_link_fallback_total` and logged once an hour while it recurs, and a process outside Ythril that writes at the
  destination in that instant can be overwritten.
- **A delete or a move whose deletion cannot be recorded answers `500` with `code: "act_not_recorded"`.** The tombstone
  is written before any byte goes, and an act that cannot record it does not begin: nothing was moved or deleted, and
  the cause is the server's, so a retry that fails the same way is a fault to report, not a request to change. It
  holds back the record TTL sweep's file deletes the same way. A store failure there is still `503`.
- **A file act the server's own storage refuses answers `500` with `code: "file_system_fault"`, on every door.** The
  words name no path and carry the errno code only; the cause is in the server log. Nothing about it is the caller's
  path (a path a file blocks is `409`), so it carries no `path` and no `Retry-After`: a retry that fails the same way
  is a fault to report.

> **Removed at 5.0.** A `DELETE` on the file-meta path purged a metadata record without
> touching disk, guarded by a `409` when the file was still there. It was a second door onto half of one
> act, and the half it could do alone left a file with no metadata — the state the File Meta tab cannot
> render and nothing else repairs.

### Every code a file act answers

A refused or failed file act (an upload, a directory create, a move, a delete) carries one `code` in `{ "error", "code", "path" }`, the same body on `PATCH /api/files/:spaceId`, `POST /api/<tool>` and the MCP tools. Branch on it, and on the status when you meet a `code` you do not know.

<!-- file-act-codes -->

| Code | Status | What it says | What to do |
|---|---|---|---|
| `path_blocked` | `409` | A regular file stands where a directory must be, or the destination is the source itself or inside it | Change the path; nothing was created |
| `destination_exists` | `409` | A file, a folder or a file's record already stands at the destination, and a move never replaces anything | Delete what stands there, or choose another name |
| `destination_held_after_move` | `409` | The bytes moved, but the records of another file (`heldBy`) hold an id the moved records need | Delete the file in `heldBy` and repeat the move |
| `confirm_required` | `422` | A directory delete did not send `confirm: true`; nothing was deleted | Repeat with `confirm: true` |
| `space_root_refused` | `400` | The space's root directory is never deleted | Delete a directory below it |
| `move_still_owed` | `503` | The bytes moved and some records did not follow yet; `Retry-After` and `retryable: true` | Wait or retry: the server finishes it |
| `act_not_recorded` | `500` | The deletion could not be recorded, so nothing was moved or deleted | Report it if a retry fails the same way |
| `file_system_fault` | `500` | The server's storage refused the act; the body names no path | Report it if a retry fails the same way |
