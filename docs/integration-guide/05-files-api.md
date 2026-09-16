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

A **media** re-upload whose bytes are unchanged answers `"complete"` instead: the analysis it already has
is kept rather than re-run. See [Media Embedding](05b-media-embedding.md#upload-response) for when a
re-upload does re-analyse — which is every case except that one.

### Upload a File (JSON / base64)

```http
POST /api/files/:spaceId?path=assets/diagram.svg
Content-Type: application/json

{
  "content": "PHN2ZyB4bWxucz0...",
  "encoding": "base64"
}
```

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
{ "path": "large-file.zip", "received": 5242880 }
```

The final chunk (where `end === total - 1`) returns **201** with the full file hash:

```json
{ "path": "large-file.zip", "sha256": "a1b2c3..." }
```

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

Active-content types that can execute script when rendered in the browser (`.html`, `.htm`, `.svg`, `.xml`, `.xhtml`) are served with `Content-Disposition: attachment` and a `sandbox` Content-Security-Policy (stored-XSS guard). Passive types — images, PDF, plain text — are served `inline` and preview normally.

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

---

### Delete a File

```http
DELETE /api/files/:spaceId?path=reports/q1.pdf
```

**Response** `204`.

To delete a directory, include `{ "confirm": true }` in the request body.

Deleting a file cascades: its metadata record, any queued embedding job, and all conversion
artifacts — chunk records plus the on-disk `_converted/<id>.md` and `_extracted/<id>/` sidecars —
are removed from the file store. Deleting a **directory** does the same for every file beneath it,
including the `_converted/<path>` and `_extracted/<path>` subtrees, and writes a sync **tombstone**
per removed file so peers delete their copies too (otherwise the next sync would push them back).

**Soft-delete (`softDeleteFileMeta`).** With this top-level config flag set to `true` (default
`false`), deleting a file **retains** its metadata record and flags it `deletedAt = <timestamp>`
instead of removing it. Flagged records stay listed and searchable but are shown as "deleted" in the
UI; re-uploading the same path clears the flag. Derived records (conversion chunks / `_converted` /
`_extracted`) are always hard-removed regardless of the setting.

**Deleting the file deletes its metadata.** There is no metadata-only delete and does not need to be:
every file has a metadata record, and `DELETE /api/files/:spaceId?path=…` removes both. An **orphan** —
a record whose bytes went missing out of band — is cleaned up by that same call, which answers `204`
rather than `404` when it finds one.

> **Removed at 5.0.** A `DELETE` on the file-meta path purged a metadata record without
> touching disk, guarded by a `409` when the file was still there. It was a second door onto half of one
> act, and the half it could do alone left a file with no metadata — the state the File Meta tab cannot
> render and nothing else repairs.
