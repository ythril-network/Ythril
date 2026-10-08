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

**An upload whose record cannot be written answers `5xx` and leaves nothing behind for a new path:** the bytes it
stored are removed, so nothing is listed or offered to a peer; send it again. For a path that already has a record, the
bytes are kept and the next upload rewrites the record.

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

A move carries what belongs to the path: the metadata, the derived records, the conversion sidecars (`_converted/<id>.md`
and `_extracted/<id>/`, a peer's copy of one included) and the queued jobs of all of them. A directory `<id>.md/` standing
beside the file is not the file's: its converted tree (`_converted/<id>.md/`) is never touched by the file's move.

#### A file is identified by its PATH, and that is the one record type where it is

Entities, facts, edges and chrono entries all carry a UUID. **A file's metadata record does not**: its
`_id` IS its path, chunks extend the same key as `path#chunkN`, and every file operation addresses by
path. `sha256` changes on every save and `seq` is a sync counter, so neither is a handle either.

**It is deliberate, and the reason is deletion.** A delete writes a sync tombstone per removed path so
peers remove their copies; the link records a file takes part in hang off that same id, and a rename
re-keys them. A second identity would be a second thing each of those has to reconcile, and the one that
disagreed would be found by an operator rather than by a test.

**So a rename changes a file's identity, and two guarantees make that survivable.** Both are asserted by
`a-file-keeps-its-metadata-across-a-move.test.js`; neither was written down before an integrator measured
them from outside and built a workaround they did not need.

| | |
|---|---|
| **A move carries the whole record** | `description`, `tags`, `properties`, `sha256`, the embedding state and the link arrays all arrive at the new path. The record is re-inserted under the new key with every field intact. |
| **What the file owns moves with it** | Its chunk records (`path#chunkN`), a converted document's Markdown (`_converted/…`) and extracted images (`_extracted/…`) are re-keyed to the new path, on disk and in the metadata, and each still names the moved file as its parent. A conversion still running when the move lands writes nothing under the old path: it is re-run where the file now is. Nothing is left under the old path to find with `filter`, and a later delete of the moved file removes all of it. The file's **links** (to entities, facts and chrono entries) follow it too, for a folder move as for a single rename. Asserted by `a-moved-file-leaves-nothing-at-its-old-path-db.test.js`. |
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

**Response** `204`.

To delete a directory, include `{ "confirm": true }` in the request body.

Deleting a file cascades: its metadata record, any queued embedding job, and all conversion
artifacts — chunk records plus the on-disk `_converted/<id>.md` and `_extracted/<id>/` sidecars —
are removed from the file store. **Everything derived from the file goes with it, however deep:** the records of an
extracted image's caption and faces hang from the image, not from the file, and are removed too; so are the metadata rows
a sidecar left on this instance (one an older peer delivered before sidecars became instance-local included),
flagged or removed as the file's own record is (`softDeleteFileMeta`), and the queued jobs of the extracted images.
A directory `<id>.md/` standing beside the file is not the file's: its converted tree (`_converted/<id>.md/`) is never
touched by the file's delete. Deleting a **directory** does the same for every file beneath it,
including the `_converted/<path>` and `_extracted/<path>` subtrees, and writes a sync **tombstone**
per removed file so peers delete their copies too (otherwise the next sync would push them back).

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
and the flag stamps no `seq` or `updatedAt`. Bytes written to the same path again (an upload, or a file a peer
delivers) clear the flag. **The deletion reaches peers as the file tombstone, and each peer applies it by its
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
it is a move to finish (below).

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
  and the same request retried completes the act. A delete completes as an orphan, as above. A move finds
  the file at `destination`, the record at the old path and the mark its first attempt left with its
  tombstones, and finishes the record, its derived records and its jobs; without that mark — an old path
  whose file went missing for another reason — it is `404`, and nothing at `destination` is touched. A
  directory delete sent with `{ "confirm": true }` finds records under a folder whose tree is gone,
  tombstones their paths and removes them.

> **Removed at 5.0.** A `DELETE` on the file-meta path purged a metadata record without
> touching disk, guarded by a `409` when the file was still there. It was a second door onto half of one
> act, and the half it could do alone left a file with no metadata — the state the File Meta tab cannot
> render and nothing else repairs.
