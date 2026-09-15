# Server-Side Conversion Pipeline

> Part of the [Ythril Integration Guide](../integration-guide.md).

## Server-Side Conversion Pipeline

### Server-Side Conversion Pipeline

When a convertible file is uploaded, Ythril automatically:

1. Converts it to clean Markdown (via unstructured sidecar for PDF/DOCX/EPUB, or in-process for HTML/MD/TXT).
2. Normalises the Markdown (strips page numbers, collapses blank lines, levels headings).
3. Splits it into heading- or paragraph-delimited chunks.
4. Embeds each chunk independently for high-quality semantic recall.

#### Timing — conversion is asynchronous

**Every** write path enqueues the conversion for a background worker and returns immediately; the
chunks do not exist yet when the call returns. This is true for the REST upload **and** for the MCP
`write_file` tool — the two behave identically.

| Surface | Returns | How to know conversion finished |
|---------|---------|--------------------------------|
| `POST /api/files/:spaceId` (document formats) | `202 Accepted` with `embeddingStatus: "pending"` — or `201` with `embeddingStatus: "skipped"` when document extraction is `off` for that space | poll the filemeta record |
| MCP `write_file` | the write confirmation (sha256) — it reports the **write**, not the conversion | poll the filemeta record |

Poll `GET /api/brain/spaces/:spaceId/files?path=<path>` and watch `embeddingStatus`: `pending` →
`processing` → `complete` (`partial` means some chunks failed and are retry-eligible; `failed` means
retries are exhausted). Once complete, the record carries `chunkCount` and (for binary formats)
`convertedFileId`, and the chunk records are recall-searchable. To see the chunks themselves, pass
`?includeChunks=true` — they are hidden by default (see below).

**The parent record also gains a description**, so the file a person actually opens is findable by more
than its name:

| field | what it is |
|---|---|
| `description` | one short paragraph answering *what is this file?* — kind of document, parties, date, subject |
| `descriptionSource` | `generated` when a model wrote it, `extracted` when it is the opening of the document's own text. **Absent** when a person wrote the description themselves |
| `excerpt` | the document's own opening prose, verbatim. Present whatever `descriptionSource` says, and an embedding input in its own right |

> **Why both.** The description answers what the file *is*; the excerpt is what makes a phrase a reader
> remembers *from the document* find the parent record. The description used to be the excerpt — the head
> of the converted text — which on an invoice is a payment reference cut mid-identifier.
>
> **`generated` is a claim, so it is recorded rather than assumed.** An instance with no document model
> configured produces the extractive text and says `extracted`; it is better than nothing, and it is not
> generated. A `PATCH` that sets `description` without declaring a source clears the field, because the
> words are then the caller's own.
>
> The text is sent to the local document model, or to the assist model **only when its egress host is
> acknowledged** — the same gate the repair pass applies, re-checked at call time. Neither slot receives
> anything it would not already receive on the repair path.

**`GET /api/brain/spaces/:spaceId/files/extract?path=<path>`** answers *what did the pipeline actually
extract from this file?* in one read — the question that has no answer once `_converted/` and `_extracted/`
are hidden from browsing. Nothing in it is new data; every part is a record conversion already wrote.

| field | what it is |
|---|---|
| `converted` | `{ path, markdown, truncated, sizeBytes }` for the `_converted/<id>.md` sidecar, or `null` when the format needed no conversion (`.md`/`.txt`). Capped at 256 KB — `truncated` says so, and the full file downloads through the file store |
| `chunks[]` | one page, always ordered by `chunkIndex`: `{ id, index, headingText, content, chunkOffsetMs, chunkDurationMs, embeddingStatus }`. Audio and video chunks carry the offset/duration; documents carry the heading they opened |
| `chunkTotal` | total across all pages — page with `limit` (default 100, max 500) and `skip` |
| `images[]` | the `_extracted/` images with `{ path, description, descriptionSource, sizeBytes, embeddingStatus }` |
| `description` · `descriptionSource` · `excerpt` | the parent's own, so one request answers the whole question |

A chunk is identified by **carrying a `chunkIndex`**, not by the shape of its id — text chunks are
`<path>#chunk<n>` and audio chunks are `<path>#media-chunk<n>`, two spellings of one thing. Read-only: it
mutates nothing and sends no content anywhere.

**Brain → Files** surfaces this as an **Extract** tab on the file detail pane, shown only for files that
have been through the pipeline.

**While a file is in flight the record also carries step progress**, so a caller can report *which
stage* is running rather than just that something is:

```json
{
  "embeddingStatus": "processing",
  "progress": { "step": "vlm", "steps": ["ocr", "render", "vlm", "validate"], "done": 12, "total": 40 },
  "progressAt": "2026-07-22T12:00:00.000Z"
}
```

`steps` is the resolved route for **that document** — it differs per file and per extraction level, so
do not treat it as a fixed list. `done`/`total` are present only for stages that can count their work;
a stage that is one indivisible call reports neither, and inventing a midpoint for it would be
fabricated progress. `progressAt` is the last report, which is what distinguishes a slow job from a
wedged one — compare it against `stalledJobTimeoutMs`. Both fields are absent once the job finishes,
and while a claimed job has not yet reported its first step.

The `embed` step reports too, throttled to one write every 2 s. Until 2.2.3 it did not, so a document with
more than `stalledJobTimeoutMs` of chunk-embedding in it looked wedged from the moment conversion finished:
recovery re-queued it mid-flight, a second worker started the same file over, and both ran at once. Recovery
now also **withdraws the claim** it re-queues, so the previous holder stops at its next heartbeat instead of
racing its replacement — the abandoned run logs `abandoning …, its claim was recovered`, and the re-queue
itself logs one `warn` naming the file, how long it was silent, its size and the step it had reached.

Media files (image/audio/video) are likewise queued and report `embeddingStatus` of `pending`,
`disabled` (media embedding turned off) or `skipped` (over `maxFileSizeBytes`). Only the `"text"`
bypass is fully synchronous: it stores a single flat embedding with no chunking and no job.

> Agents take note: writing a document and immediately recalling its contents will find nothing —
> the worker has not run yet. Poll `embeddingStatus`, or accept eventual consistency. (Before Ythril
> 1.4, MCP `write_file` converted documents inline and blocked until they were chunked; it now
> enqueues a job like REST, so it returns faster and inherits the worker's retry/backoff.)

#### `inputFormat` parameter

Pass `inputFormat` in the JSON body (or as a query parameter in raw uploads) to control conversion:

| Value | Behaviour |
|-------|-----------|
| `"auto"` | (default) Detect from MIME type or file extension |
| `"pdf"` / `"docx"` / `"epub"` | Use the unstructured sidecar (same-Pod, localhost:8000) |
| `"html"` | Extract article body with jsdom + @mozilla/readability + turndown, fully in-process |
| `"md"` | Normalise + split on H2/H3 headings, in-process — no sidecar, no `_converted/` copy |
| `"txt"` | Normalise + split on paragraph boundaries, in-process — `headingText` is null on all chunks |
| `"text"` | Legacy bypass: single flat embedding, no chunking, unchanged behaviour |

Example — upload and convert a PDF:

```http
POST /api/files/:spaceId?path=reports/q1.pdf
Content-Type: application/json

{
  "content": "<base64-encoded PDF bytes>",
  "encoding": "base64"
}
```

Or force the bypass (no conversion):

```json
{
  "content": "<base64-encoded PDF bytes>",
  "encoding": "base64",
  "inputFormat": "text"
}
```

#### Stored artefacts

Three things are stored for each converted file (conversion artefacts are **hidden** from the file manager UI and the `GET /api/brain/spaces/:spaceId/files` listing by default):

1. **Original file** — bytes on disk, accessible via the usual download URL. Unchanged.
2. **`_converted/<path>.md`** — full converted Markdown, stored in the space file store (binary formats only). The original file's filemeta record has a `convertedFileId` property pointing to it.
3. **Chunk records** — one filemeta record per heading/paragraph section. Each has:
   - `parentFileId` — `_id` of the original file's filemeta record
   - `chunkIndex` — 0-based position within the document
   - `headingText` — the H2/H3 heading that opened this chunk (`null` for `.txt` paragraph chunks)
   - `content` — the Markdown body of the chunk
   - An embedding derived from `headingText + " " + content`

Chunk records and `_converted/` records share the same vector space as memories, entities, and edges. A standard `recall` query therefore covers document chunks alongside all other content — **no separate query path is required**.

#### File manager and listing endpoints

Chunk records and `_converted/` file records carry a `parentFileId` field. The following surfaces **exclude** them by default, so users only see top-level files:

- **File manager UI** — shows only original, user-uploaded files.
- **`GET /api/brain/spaces/:spaceId/files`** — omits records where `parentFileId` is set. Pass `?includeChunks=true` to include all records.
- **`GET /api/brain/spaces/:spaceId/stats`** — the `files` count reflects only top-level files.

Recall results (`recall`, `similar`) **do** include chunk records by design. When a result has `parentFileId` set, the caller can follow it to retrieve the original file record.

#### Resilience

If the unstructured sidecar is unavailable, `write_file` still succeeds. The original file is stored as-is and `conversionError` is set on the filemeta record. No HTTP 5xx is returned to the caller.

Conversion input is size-bounded: documents over `maxDocumentConversionBytes` in `config.json` (default 100 MiB; HTML additionally capped at 25 MiB because jsdom parses it in-process) are stored as-is with `embeddingStatus: "skipped"` — the conversion job fails permanently rather than retrying. Images extracted during hi-res conversion are capped at 50 per document / 100 MiB aggregate.

Setting `CONVERSION_SIDECAR_URL=""` only disables the **sidecar-backed** formats: in-process formats (HTML/Markdown/plain text) still convert, but PDF/DOCX/EPUB uploads then fail with `conversionError: sidecar_down` (`embeddingStatus: failed`). There is no global "text bypass" — to skip conversion for a specific upload, send it with `inputFormat=text`.

#### Page-render sidecar (`doc-render`)

The bundled `doc-render` sidecar is a tiny PDFium (pypdfium2) service that renders PDF pages to images. It is
the rasterization step the **VLM document-extraction** path (`mediaEmbedding.documentProcessing.mode` of
`vlm` / `auto` / `repair`) needs and is **not used by the `ocr` level** — you can leave it running (it is
lightweight and carries no model weights) or stop it with no effect on today's OCR conversion. Like the
`unstructured` sidecar it parses untrusted documents, so it runs isolated on the internal-only
`ythril-convert` network (no database, no internet egress), non-root and resource-limited. Ythril reaches
it via `RENDER_SIDECAR_URL`. The **application** default is `http://localhost:8100` (a sidecar in the same network namespace); `docker-compose.yml` overrides it to `http://doc-render:8100`, the service name on the internal network. Both are correct for their layer — check which one applies to your deployment rather than assuming the compose value is the default.

Two limits are set **on the sidecar**, not in Ythril's config — they bound what an untrusted document can
make it do, so they belong to the process that parses it:

| Env (on the sidecar) | Default | Meaning |
|---|---|---|
| `RENDER_MAX_BYTES` | `104857600` (100 MiB) | Largest document the renderer will accept. |
| `RENDER_MAX_PAGES` | `500` | Hard ceiling on pages rendered per request, whatever `maxPages` asks for. |

#### Office-render sidecar (`doc-office`) — optional

`doc-render` only opens PDFs, so **office** documents (DOCX, EPUB, PPTX, XLSX, ODT, RTF…) in a `vlm`/`auto`/
`repair` fall back to OCR unless the optional **`doc-office`** sidecar is running. It uses **LibreOffice**
(headless) to convert the document to PDF, then rasterizes it exactly like `doc-render`. Because LibreOffice
is heavy (≈ +1 GB), it is **opt-in**: start it with

```bash
docker compose --profile office up -d
```

Everything stays **on-box** on the isolated `ythril-convert` network — no page images or text leave the
instance. Ythril reaches it via `RENDER_OFFICE_SIDECAR_URL` (default `http://doc-office:8100` in compose).
When it is absent, office docs simply use OCR, unchanged. LibreOffice is MPL-2.0 / LGPL-3.0 (not AGPL) and
runs as a separate process, so it does not affect Ythril's licensing.

It honours `RENDER_MAX_BYTES` and `RENDER_MAX_PAGES` exactly as `doc-render` does, plus one of its own:

| Env (on the sidecar) | Default | Meaning |
|---|---|---|
| `OFFICE_CONVERT_TIMEOUT` | `120` | Seconds `soffice` gets to convert the document to PDF before the attempt is abandoned and the upload falls back to OCR. Raise it for very large spreadsheets; a LibreOffice conversion that hangs holds a worker slot until this fires. |

#### Document Processing Configuration

The unstructured sidecar strategy and image extraction behaviour can be tuned under `mediaEmbedding.documentProcessing` in `config.json`. All settings are optional — the defaults are designed for maximum data extraction out of the box. The extraction `mode` and the render DPI / max-pages / timeout / concurrency knobs are also editable in the admin UI under **Settings → Media Processing → Pipelines**, attached to the Documents pipeline they govern (the `vlmModel` / `repairModel` / `verifyModel` endpoints stay environment-only and are shown read-only there).

**The admin page has three tabs**, one route:

- **Models** — every model you or infra can set: text embedding, vision, speech-to-text, the assist model, and read-only cards for the page renderer, document converter and face recognition. One shape per card (provider → endpoint → model → credential → test); infra-owned cards are dashed and name the env var that owns them.
- **Pipelines** — Documents, Images, Audio, Video and Text drawn as their real step chains, with the model doing the work named under each step and a health indicator fed by `GET /api/admin/pipeline-status`. **Clicking a model name jumps to the Models tab and highlights the card that configures it.** Conditional steps (VLM fallback, repair, face vectors, video keyframe captioning) are dashed. Each pipeline's knobs hang off that pipeline, and each carries its own **instance ceiling** picker (see below). **Audio and Video are separate pipelines:** Audio is transcribe → embed; Video extracts the audio track and runs that same pipeline, adding keyframe captioning only at the `full` level (so at `audio` a video uses no vision model).
- **Tools** — the components that run but have nothing to set: media splitter (ffmpeg), text chunker, and the vector index. Per space the index table shows the **live** database state alongside the **recorded** (config.json) state, so drift between them is visible; each row carries a **Rebuild** button (the same `POST /api/spaces/:id/rebuild-indexes` the space Danger Zone offers, behind the same confirmation) so the repair sits right where the drift shows.

Switching tabs with unsaved changes prompts rather than discarding them.

**Infra-managed lock (F11).** On managed infrastructure you can set every media/model value in `config.json` (or the environment) and forbid changes through the admin UI/API — the same posture as `YTHRIL_MONGO_INFRA_MANAGED` for the database. Set `mediaEmbedding.infraManaged: true` in `config.json`, **or** `YTHRIL_MEDIA_INFRA_MANAGED=true` in the environment. When active, `PATCH /api/admin/media-config` returns **409** with `code: "INFRA_MANAGED"` and **Settings → Media Processing** renders read-only (a "managed by infrastructure" banner is shown; *Test connection* still works). Individual fields can instead be pinned one at a time by setting their env var (e.g. `VISION_MODEL`, `DOC_ASSIST_URL`) — those appear in `lockedByInfra` and are locked individually. Use `infraManaged` when the whole block is owned by infrastructure.

**To fix a field at NOTHING, list it in `YTHRIL_PINNED_FIELDS`.** Setting a field's own variable to empty does not pin it, and cannot be made to: `docker compose` passes `${VAR:-}` and leaves variables defined-but-empty when the operator set nothing, so treating "defined" as "pinned" would lock every field on every Compose deployment. An explicit list has no such ambiguity — `YTHRIL_PINNED_FIELDS=rerank.apiKey,nli.apiKey` locks both keys at whatever they resolve to, which for an in-cluster unauthenticated endpoint is correctly nothing. Requested by an integrator whose key fields were controls with nothing behind them. Full row in [Media embedding](05b-media-embedding.md#configuration), including what happens to a path that names no field.

> **A pin refuses the write, and since 3.2.0 that is true of every pinnable field rather than one block.** `PATCH` returns **403** naming each pinned field the request touched, including nested ones — `rerank.apiKey`, `nli.baseUrl`, `vision.model`, `embedding.dimensions`, `documentProcessing.assistModel` and every other `block.field` path in `lockedByInfra`. Before 3.2.0 only the `faceRecognition.*` pins were enforced; a patch overwriting any other nested pinned field answered **200** and was written to `config.json`. The effective value did not change — the environment still wins at read time — but the API reported success for a write it could never honour, and the stored config was left disagreeing with the running one. One `403` names **all** the offending fields, so a caller does not have to discover them one round trip at a time.

**A body read from the GET may be sent straight back.** `GET /api/admin/media-config` returns the RESOLVED config, so it includes fields the PATCH does not accept (`faceRecognition.enabled`, `modelPath`, `reprocessSyncedImages`, and the read-only `lockedByInfra` / `infraManaged` / `providerReloadPending` markers). Echoing them back unchanged is supported — the server strips the ones it owns before validating. Sending a CHANGED value for one is refused with **403** naming the field. Until this fix a round trip failed with a `400 unrecognized_keys` and nothing on the page saved, which is the shape to test for if you build your own client.

**Test connection (F11).** `POST /api/admin/media-config/test-connection` (admin + MFA) probes a configured endpoint — `{ "target": "vision" | "stt" | "assist" | "embedding" | "nli" }` — by listing its models. It performs **no inference and sends no document content**, so it is safe to run before acknowledging egress. External endpoints go through the SSRF-guarded fetch; local (trusted) endpoints use a direct fetch. The response reports `{ reachable, verdict, modelEnumerated?, models, status?, latencyMs, detail? }`. Settings → Media Processing exposes a **Test connection** button per provider card.

`verdict` is what the probe **established**, and it is the field to branch on — `reachable` cannot separate
an endpoint that answered a 404 on the list path from one that did not answer at all:

| `verdict` | meaning | fault? |
|---|---|---|
| `listed` | the endpoint served a model list | no |
| `not-enumerable` | it answered with a 4xx on the list path: present, speaking HTTP, no listing surface | **no** — see below |
| `auth-rejected` | 401/403 — the credential was rejected, and inference presents the same one | yes |
| `erroring` | 5xx — the server is there and erroring, which is about the endpoint, not the path | yes |
| `unreachable` | nothing answered: connection refused, DNS, TLS, timeout | yes |

The list URL is derived from the **same rule the inference call uses** — `/models` for an OpenAI-compatible
base (which already carries `/v1`; `…:8080` and `…:8080/v1` both work), `/api/tags` for a local Ollama. A
probe that normalised differently from the thing it probes would report a red dot over a working pipeline,
or worse, a green one over a broken pipeline. If the endpoint answers on the *other* protocol, the probe
says so explicitly rather than simply failing — that means the provider type is set wrong and inference
will fail even though the endpoint is up.

> **`modelEnumerated: false` is not a fault.** It means the endpoint did not *list* the configured name,
> which is normal and deliberate for aliasing routers (llama-swap roles), gateways and Azure deployments —
> they serve names they keep out of user-facing pickers. Absence from a list is not evidence a model is
> unavailable, so it is reported as informational and never as degraded. To find out whether a model
> actually answers, make a real request — which is what Verify does.
>
> **`verdict: "not-enumerable"` is not a fault either**, for the same reason one step further out. A model
> list is a *surface*, and plenty of inference servers do not have one: a Whisper transcription service
> serves only `POST /v1/audio/transcriptions`, so a list probe against it can only ever 404. That 404 is
> about a path the slot never calls — it is no evidence about the slot. It is reported as reachable with
> the status and the URL in `detail`, and the Models card shows *"Reachable · no model list"*.
>
> A genuine fault still reads as one: a refused connection, a DNS or TLS failure, a 5xx, or a rejected
> credential. And if the base URL is simply wrong, `detail` names the exact URL that was tried, which is
> the thing to check when extraction produces nothing while the dot is green — or run Verify, which sends
> a real request down the real path and is the only thing that can settle it.

**Verify.** `POST /api/admin/media-config/verify` (admin + MFA) — `{ "target": "vision" | "stt" |
"embedding" | "assist" }` — sends **one real request** to the configured model and reports what came back.
It is the counterpart to Test connection, and it answers the question listing models cannot: *does this
model actually work?*

The payload is always **generated, never yours**: a 1×1 transparent PNG for vision, a few milliseconds of
synthesised silence for speech-to-text, the word `ping` for text models. That matters because for several
targets the real path is an egress path, and a diagnostic must not become one. It exercises the same
client the worker uses — same wire format, same SSRF guard, same model name — so a transport bug shows up
here rather than on a user's first upload.

| `outcome` | meaning |
|---|---|
| `ok` | the model answered; `sample` carries a truncated excerpt as evidence |
| `failed` | it was reached and did not produce a usable answer; `detail` says why |
| `still-loading` | no answer within the budget — **not a failure** |
| `unconfigured` | nothing is set for that target |

> **`still-loading` exists because a cold start is not a fault.** On a backend that swaps models in and
> out of one GPU, a first call has been measured at ~35 seconds. The budget is 180 s
> (`MODEL_VERIFY_TIMEOUT_MS`), and exceeding it means "try again", not "your endpoint is broken".

Unlike Test connection, Verify **is audited** (`config.media.verify`): it leaves the instance and, on a
metered endpoint, costs money. Silence transcribing to no text counts as a pass — the payload is silent,
so reaching a structured response is the result.

**Pipeline status.** `GET /api/admin/pipeline-status` (admin) returns the health of the whole pipeline in one read-only payload — it mutates nothing and sends no document content. It reports three things:

- `sidecars[]` — reachability of the document converter, page renderer and office renderer, each with the env var that owns its URL (`CONVERSION_SIDECAR_URL`, `RENDER_SIDECAR_URL`, `RENDER_OFFICE_SIDECAR_URL`).
- `models[]` — per stage (`embedding`, `vision`, `stt`, `doc-vlm`, `doc-repair`, `doc-verify`, `assist`): the configured model, the endpoint **host** (never the full URL), and a `state` of `ok` / `degraded` / `down` / `blocked` / `off` / `unconfigured`. `degraded` means the endpoint answered **and something the probe saw says the configured call will fail anyway** — today, an endpoint answering on the other protocol, which means the provider type is set wrong; `detail` carries the reason. `down` covers both "nothing answered" and an answer that is itself a fault (a 5xx, or a rejected credential). An endpoint with no model-list route is `ok` with the reason in `detail` — that 404 is about a path the stage never calls. `unconfigured` means nothing is set: an optional stage left empty is not reported as a fault. API keys authenticate the probes and never appear in the response.
- `index.spaces[]` — per space, the **live** `$vectorSearch` index state read from MongoDB (`live`) alongside what `config.json` claims (`stored`), plus a `drifted` flag when `stored` says `ready` and the database disagrees. Proxy spaces own no collections and are omitted. A deployment whose MongoDB has no Atlas Search support reports `unknown` rather than `missing`.
  - **`collections[]` carries every expected index with its own status, and an `optional: true` on the ones the space's search does not depend on** — today just the face gallery, `{spaceId}_files_faceEmbedding`. **Optional indexes are excluded from `live` and therefore from `drifted`.** They used to count, and the consequence was that enabling face recognition without giving it a model made every space report `live: "missing"` and `drifted: true` for ever, on an instance whose search was fine. Read `collections[]` if you want to know about an optional index; read `live` for whether the space can answer a query.

Results are cached for 20 seconds and single-flighted, so several admins on **Settings → Media Processing** produce one set of probes rather than one per viewer per step. Stages sharing an endpoint (typically `doc-vlm` / `doc-repair` / `doc-verify` on one Ollama) are probed once.

**Per-space override (F11-c).** The `mode` above is a **ceiling, not a default**: a space may choose anything up to it and nothing beyond it. Set the override from the space's **Settings → Spaces → Document extraction** picker, or via `PATCH /api/spaces/:id` with `{ "documentExtraction": "off" | "ocr" | "vlm" | "repair" | "auto" }` (send `null` to clear it and follow the instance setting again). A request **above** the ceiling is **capped to the ceiling** before it is stored — the API never persists a level the runtime would only clamp later, and the Settings picker offers only the modes at or below the ceiling. Like dupe rules and record-TTL, this is a **local, per-instance** operational setting: it is never governed or synced across a network.

The effective level is `min(instance mode, space override)`, which has three consequences worth stating outright:

- **Lowering the instance mode caps every space above it.** A space set to `"repair"` under an instance on `"ocr"` runs `"ocr"`. The space keeps its stored choice and returns to it if the ceiling rises again.
- **Raising the instance mode does not raise any space** that chose a specific lower level — only spaces on `"auto"` follow it upward. Capability is granted centrally; using less of it stays with the space.
- **Instance `"off"` is a floor as well as a ceiling.** Nothing is analysed anywhere, whatever a space asks for.

A space on `"auto"` follows the instance level wherever it moves.

**The other media classes work the same way.** `PATCH /api/spaces/:id` also accepts `imageAnalysis`,
`audioAnalysis` and `videoAnalysis` (send `null` to clear an override), each capped by the matching
ceiling under `mediaEmbedding.levels`:

| Class | Levels, low to high | `off` means |
|---|---|---|
| `imageAnalysis` | `off` · `caption` · `recognition` · `auto` | no caption, no image embedding, no face detection |
| `audioAnalysis` | `off` · `on` · `auto` | no transcription |
| `videoAnalysis` | `off` · `audio` · `full` · `auto` | no audio extraction, no transcription |
| `textAnalysis` | `off` · `embed` · `chunk` · `auto` | text is never indexed — nothing in the file is findable by search |

**Setting the ceilings.** `PATCH /api/admin/media-config` accepts a `levels` block — `{ "levels": { "images": "caption" } }` — or use the pickers on **Settings → Media Processing → Pipelines**. Three things about it are deliberate:

- **Each class is merged independently.** A patch naming only `images` leaves the other three exactly as they were. This matters more than it looks: an absent class reads back as `auto`, so a whole-object replace would silently *raise* the ceiling on every class the request did not mention.
- **Video's `audio` vs `full` is a real choice.** At `audio` a video "takes the audio pipeline instead of a model": its audio track is transcribed and embedded, and the vision model is never called. At `full` (and `auto`, which resolves to full) it additionally captions sampled keyframes with the vision model and folds those into the transcript segments. Both are accepted and stored.
- **Env-pinned levels are refused** with `403` and reported in `lockedByInfra`, like every other media field.

Remember what a ceiling does before lowering one: it caps every space already above it (those spaces keep their stored choice and return to it if you raise the ceiling again), and `off` is a floor as well as a ceiling — the class is not processed anywhere, whatever a space asked for.

`recognition` is the rung that permits **face detection and embedding**, and it is the gate: the space
must be at `recognition` (or `auto`) under an instance ceiling that permits it. A space on `caption` gets
described images and no face data — the reason images have their own ladder rather than riding on the
master media switch. **Images default to `caption`, not `auto`**: `auto` resolves to `recognition`, and a
biometric store should be opted into rather than inherited from a default. `mediaEmbedding.faceRecognition.enabled`
is no longer a user setting — it survives only as an infra pin (`FACE_RECOGNITION_ENABLED=false`) that
hard-disables faces regardless of any ladder, and it is not accepted by `PATCH /api/admin/media-config`.

`textAnalysis` decides what happens to text AFTER a document is read, which is a separate question
from how it was read (`documentExtraction`). `chunk` stores a vector per section, so a recall can
quote the passage; `embed` stores one vector for the whole document, which still finds the FILE but
no longer answers "where does it say that?" — a real trade on long documents, and close to free on
short notes. `off` stores the file and indexes nothing.

`videoAnalysis` chooses how much of a video is analysed. `audio` runs the **audio pipeline only** —
extract the audio track, transcribe, embed — so a video is searchable by what is said without ever
invoking the vision model. `full` adds **keyframe captioning**: frames are sampled at an interval,
captioned by the vision model, and prepended to the transcript segment they overlap before re-embedding.
`auto` resolves to `full`. (Video is its own pipeline on **Settings → Media Processing → Pipelines**, separate
from Audio.)

Uploads to a class whose effective level is `off` are stored and marked `embeddingStatus: "skipped"`.
They are never queued, so they do not sit at `pending` waiting for work that will not happen. Uploads to a space whose effective level is `"off"` are stored and marked `embeddingStatus: "skipped"` — they are never queued, so they do not sit at `pending` waiting for work that will not happen.

| Field | Default | Description |
|---|---|---|
| `strategy` | `"hi_res"` | Unstructured partition strategy. `"hi_res"`: full Tesseract OCR + layout detection — accurate on scanned PDFs, extracts embedded images and structured tables. `"auto"`: sidecar picks the fastest viable strategy. `"fast"`: pdfminer text-layer only — fastest but no OCR, no image extraction. `"ocr_only"`: force OCR on every page regardless of whether a text layer exists. |
| `extractImages` | `true` | When `true` and `strategy` is `"hi_res"`, embedded images found in document partitions are decoded and saved as `_extracted/{originalId}/image-{N}.{ext}` subfiles. Each is automatically enqueued for the full media pipeline (caption + face recognition). Has no effect when strategy is not `"hi_res"`. |
| `mode` | `"vlm"` | How thoroughly documents are read, low to high: `"off"` · `"ocr"` · `"vlm"` · `"repair"`, plus `"auto"`. **`"off"` means documents are stored but never analysed** — no text is extracted, so nothing in them can be recalled; those uploads are recorded as `skipped` rather than queued. `"ocr"` is OCR-only (the unstructured sidecar). `"vlm"` renders each page and transcribes it with a vision model, using OCR as grounding evidence and falling back to OCR if the result doesn't validate (so it is **never worse than OCR**). `"repair"` adds a validation-driven **repair** pass (below) on top of `"vlm"`, plus a second-model consensus pass when a `verifyModel` is set. `"auto"` means **as much as this instance can actually do** — it resolves to `"repair"` when a repair model is configured, otherwise `"vlm"`, otherwise `"ocr"`, so with no `vlmModel` set it is byte-for-byte the OCR-only path. `"max"` is the previous name for `"repair"` and is still accepted on read. |
| `vlmModel` | `""` | Ollama vision model used for `vlm` / `auto` / `repair` (e.g. a bundled `moondream`, or a larger model you wire in). Empty ⇒ the VLM path is unavailable and extraction stays on OCR. Env override: `DOC_VLM_MODEL`. |
| `vlmBaseUrl` | `""` | Endpoint for the VLM. Empty ⇒ falls back to the media vision provider's `baseUrl`, then `http://ollama:11434`. Env override: `DOC_VLM_URL`. **Setting this marks the slot as a separate service**, so the call goes through the SSRF-guarded fetch — a private address then needs `allowPrivateModelEndpointsBySlot.docVlm` (or the instance-wide flag). |
| *(no config key)* | — | `DOC_VLM_WIRE` — which protocol the document VLM speaks: `ollama` (`/api/chat`) or, by default, `openai` (`/chat/completions`). Env-only, because the URL cannot tell us: `http://host:11434` is either. The default matches what self-hosted inference servers overwhelmingly serve; set `DOC_VLM_WIRE=ollama` only when you point `DOC_VLM_URL` at a **separate Ollama**. It applies to all three document slots, which share one endpoint resolver. |
| `repairModel` | `""` | Used by the **`repair`** level — and by **`auto`**, which resolves to `repair` whenever this is set. Model used for the repair pass when a page's VLM output fails OCR-evidence validation — it reconciles the draft against the OCR text in one extra text-only call. Empty ⇒ reuses `vlmModel`. Set this to wire in a stronger model you host. Env override: `DOC_REPAIR_MODEL`. |
| `repairBaseUrl` | `""` | Endpoint for the repair model. Empty ⇒ reuses `vlmBaseUrl`. Env override: `DOC_REPAIR_URL`. |
| `verifyModel` | `""` | Engages on the **`repair`** level, and on **`auto`** when a repair model is set (F11-d consensus). A *second* document VLM. When set, the repair level runs it as an independent second transcription of each page, reconciles it with the primary draft against the OCR text, and keeps the highest-coverage result — **never worse** than the primary. Empty ⇒ no consensus pass. Best set to a *different* model than `vlmModel`. Env override: `DOC_VERIFY_MODEL`. |
| `verifyBaseUrl` | `""` | Endpoint for the verify model. Empty ⇒ reuses `vlmBaseUrl`. Env override: `DOC_VERIFY_URL`. |
| `renderDpi` | `150` | Page rasterization DPI for the render sidecar (VLM modes only). |
| `maxPages` | `50` | Pages rendered per **render call** — one sidecar round trip's memory/latency bound. Not how much of a document is read: longer documents are walked in windows of this size. |
| `maxTotalPages` | `200` | Pages read from **one document** in total, across windows. Beyond this the extraction stops and says so, in the log and in the stored markdown. |
| `pageTimeoutMs` | `60000` | Per-page VLM transcription timeout (VLM modes only). It is the DEFAULT for the four document model slots, not an override of them: a a `modelSlots.<document slot>.timeoutMs` you set wins for that model, and this value applies to every document call that has none. Until 4.2 it was passed as an override, so those four slot budgets were documented, patchable, pinnable and inert — both defaults being 60 s is why nothing disagreed. |
| `concurrency` | `2` | How many pages are transcribed in parallel (VLM modes only). |
| `ocrTimeoutMs` | `120000` | Timeout (ms) for a single OCR-sidecar call. Applies to **all** modes — OCR is the engine in `ocr` mode and the grounding evidence + fallback floor in the VLM modes — so raise it when large/complex scanned documents need longer than the 2-min default (especially under `repair`). Env override: `DOC_OCR_TIMEOUT_MS`. |
| `describeTimeoutMs` | `30000` | Timeout (ms) for the single call that writes a converted document's **description**. Failing it costs only the generated prose — the document's own opening text is kept and `descriptionSource` reports `extracted` — so the default is deliberately tight. **Raise it on a single-GPU host that swaps models per request** (see the note below). Env override: `DOC_DESCRIBE_TIMEOUT_MS`. |

> **Why two numbers.** They bound different things. `maxPages` is one round trip; `maxTotalPages` is the
> job's cost ceiling — every page is a VLM call, so an unbounded walk over a 600-page scan means 600 model
> calls and, with an external endpoint, 600 pages of content leaving the instance, on an upload nobody is
> watching. Raise `maxTotalPages` deliberately. In `repair` mode the consensus pass is skipped for a document
> that had to be walked, since it re-transcribes every page with a second model.

The VLM modes require both a running `doc-render` sidecar and a configured `vlmModel`. If either is missing,
Ythril transparently uses OCR — no upload fails because a model isn't wired in yet.

> **One host shape the 30 s default cannot serve.** The describe call arrives immediately after the
> transcription pass. On a backend that keeps both models resident it answers in a second or two; on a
> **single GPU that swaps models per request** it first has to unload the vision model this job was using
> and load a chat model, and that load alone can exceed the whole budget.
>
> Nothing errors when it does. Every document keeps its extractive opening text, `descriptionSource` says
> `extracted`, and the log carries one timeout warning per file — which reads as a broken model rather than
> a deadline that does not fit this host, so the feature looks unimplemented while working correctly on the
> next host along. The warning now names the budget and this setting for that reason.
>
> If every document reports it, raise `describeTimeoutMs` to cover a model load (60–180 s is typical) —
> or give the chat model its own endpoint via `repairBaseUrl`, so nothing has to be swapped at all.

**Repair pass (`repair` level).** When a document's VLM transcription fails the OCR-evidence coverage check,
the `repair` level runs one bounded repair pass before falling back to OCR: it sends the draft transcription and the
OCR text to `repairModel` (or `vlmModel` if unset) in a single text-only call, asks it to restore any dropped
content, and re-validates. If the repaired output passes it is accepted; if it errors or still doesn't pass,
the extractor falls back to OCR — so the result is still never worse than plain OCR. Exactly one repair pass
runs per document (bounded cost).

**Consensus pass (`repair` level, F11-d).** When a `verifyModel` is configured, the `repair` level adds one bounded
**consensus** step on top of an already-accepted draft: the verify model independently transcribes the pages
(a second, ideally different, VLM), that draft is reconciled with the primary against the OCR text, and the
highest-OCR-coverage of the three candidates (primary, second draft, reconciled) is kept. Because the primary
is always a candidate and ties keep it, consensus **can only match or beat** the primary's coverage — never
regress it. It is failure-tolerant (any error keeps the primary) and bounded (one extra transcription set +
one reconcile call, subject to the same max-pages cap). Empty `verifyModel` ⇒ no consensus pass, unchanged
behaviour. Consensus arbitrates by OCR-evidence coverage; N-pass entropy voting is a possible future refinement.

**External face-recognition model — biometric egress, opt-in and acknowledged.** Face detection and
embedding run **in-process** by default (BlazeFace + FaceRes from `faceRecognition.modelPath`); no face
data leaves the instance. You can optionally point at an external recogniser under
`faceRecognition.externalModel`:

| Field | Description |
|---|---|
| `baseUrl` | Endpoint receiving `POST { model?, image }` (`image` is base64) and returning `{ faces: [{ embedding, boxRaw? }] }`, where `embedding` is **exactly 128 floats**. SSRF-validated on save and reached only through the SSRF-guarded fetch. |
| `model` | Optional model name, passed through in the request body. |
| `apiKey` | Sent as `Authorization: Bearer`. Stored in `secrets.json`, masked on read, never echoed back. |
| `acknowledgedHost` | The host you consented to. **Must equal `baseUrl`'s host or the endpoint is not used at all.** |
| `allowInProcessFallback` | Whether a failing provider may hand off to the bundled model. **Default `false`.** Read as a strict boolean — a `"false"` string stays off. |

Three properties worth knowing before enabling it:

- **Consent is mandatory and host-scoped, and it is demanded at ACTIVATION.** Face crops are biometric
  data. The API rejects a save that *switches the endpoint on* without a matching `acknowledgedHost` —
  either by setting or repointing `baseUrl`, or by raising `levels.images` to `recognition` or `auto`,
  since `auto` resolves to the recognition rung. Host comparison **includes the port**.
  
  An unacknowledged endpoint is otherwise **stored and unused**: it does not block unrelated writes to
  this route, and `GET /api/admin/media-config` reports `faceEndpointAwaitingAcknowledgment: true`. It
  used to refuse every subsequent patch, which meant one stored endpoint could brick the whole page.
  
  **The runtime re-checks consent regardless**, so a config edited on disk cannot egress faces either —
  which is why the write-time gate could be narrowed without changing what may leave the instance.
  Re-pointing `baseUrl` at a different host revokes consent by construction.
  
  `documentProcessing.assistModel` follows the identical rule, with `repair`/`auto` as its activating rung.
- **A failing provider does NOT fall back to the bundled model unless you ask it to.** This changed: the
  fallback used to be unconditional. Both embedders emit the same descriptor width, so falling back wrote a
  *different embedder's* vectors into the same gallery and nothing could detect it — the vectors were the
  right shape and the wrong vector space, and every similarity score computed against them was wrong.
  Ythril now skips the image, logs once, and lets the media job retry; set `allowInProcessFallback: true`
  to restore the old behaviour.
  - **If you have no external provider configured, none of this applies to you.** In-process is your only
    path rather than a fallback, and it runs exactly as before. The switch is gated on a provider being
    configured *and* consented, precisely so a single-model install cannot lose face recognition to it.
- **A provider's answer is not trusted.** Descriptors that are not exactly 128 finite floats are
  discarded (a wrong width would corrupt gallery similarity rather than fail loudly), and the number of
  faces accepted from one response is capped.

**External assist model (F11-b) — hosted egress, opt-in and acknowledged.** With the bundled models, every
extraction path is local (the bundled Ollama VLM / OCR sidecar) and no document content leaves your
instance. Note the precondition: the document VLM falls back to the **vision** endpoint when `DOC_VLM_URL`
is unset, so an external vision provider makes the VLM external too and rendered page images go with it —
see the egress table above. You can optionally point a **bigger, external model** at specific tasks under
`documentProcessing.assistModel`:

| Field | Description |
|---|---|
| `baseUrl` | External **OpenAI-compatible** endpoint (`POST {baseUrl}/chat/completions`, with `/v1` inserted if the base does not already carry it — `…:8080` and `…:8080/v1` both work). Validated against SSRF on save (must be a public http(s) URL — no private/loopback/metadata addresses) and reached only through the SSRF-guarded fetch. Env: `DOC_ASSIST_URL`. |
| `model` | Model tag to request. Env: `DOC_ASSIST_MODEL`. |
| `apiKey` | Optional bearer token. Stored in `secrets.json` (never `config.json`), masked in the admin API. Env: `DOC_ASSIST_API_KEY`. |
| `uses` | Which tasks the external model powers — `["repair"]` today (the repair pass); more are planned. Empty ⇒ configured but inert (no egress). |
| `acknowledgedHost` | The endpoint host the operator acknowledged egress to. **Required to match `baseUrl`'s host whenever `uses` is non-empty** — the admin API rejects the save otherwise, and the extractor re-checks it at runtime, so document content never leaves the box without recorded consent. |

> **Self-hosting inference on a private address?** The `local` / `external` choice selects a **wire
> protocol**, not a trust level: `local` speaks Ollama's (`/api/chat`), `external` speaks OpenAI's
> (`/chat/completions`, `/v1/embeddings`, `/v1/audio/transcriptions`). A self-hosted OpenAI-compatible
> server — llama.cpp `llama-server`, vLLM, LocalAI — therefore needs `external`, even when it lives on a
> cluster address like `http://vllm.models.svc.cluster.local:8080`.
>
> Set **`allowPrivateModelEndpoints: true`** in `config.json`, or `YTHRIL_ALLOW_PRIVATE_MODEL_ENDPOINTS=true`,
> to permit that. It is config/env only and deliberately **not** settable through
> `PATCH /api/admin/media-config` — a field that becomes an egress target must never be widenable from
> the admin API.
>
> Enabling it does **not** disable the SSRF guard. Those calls still go through `ssrfSafeFetch`, which
> resolves DNS, pins the resolved IP for the connection and re-validates every redirect; only the
> private-address rejection lifts. Loopback, link-local / cloud metadata (IMDS) and the `localhost` /
> `metadata.google.internal` hostnames stay blocked either way — including when a hostname *resolves* to
> one, which is the DNS-rebinding case. A declared-private `external` endpoint is therefore more tightly
> guarded than a `local` provider, which uses a plain `fetch`.
>
> **Per endpoint, when one model is genuinely external.** The instance-wide flag is all-or-nothing, which
> is the wrong shape for the common deployment: every model on your own infra except one that really does
> live on the public internet. Turning the flag on to reach the internal ones also relaxes the guard on
> that one external endpoint — the single place where a private-address resolution means something is
> wrong rather than "this is my cluster". So each endpoint carries its own setting:
>
> ```json
> {
>   "allowPrivateModelEndpoints": true,
>   "allowPrivateModelEndpointsBySlot": { "assist": false }
> }
> ```
>
> **Precedence is per-slot → instance-wide → closed**, and a per-slot value wins **in both directions**.
> The `false` above is the point of the example: nine endpoints reach the cluster, and the assist model —
> the one path that sends document content off the instance — stays strict. Slots you leave out inherit
> the instance-wide flag; with neither set, private addresses are refused.
>
> | Slot | What it governs | Env var |
> | --- | --- | --- |
> | `vision` | Image captioning provider | `YTHRIL_ALLOW_PRIVATE_VISION` |
> | `stt` | Speech-to-text provider | `YTHRIL_ALLOW_PRIVATE_STT` |
> | `embedding` | Text embedding endpoint | `YTHRIL_ALLOW_PRIVATE_EMBEDDING` |
> | `rerank` | Cross-encoder reranker | `YTHRIL_ALLOW_PRIVATE_RERANK` |
> | `nli` | Contradiction judge | `YTHRIL_ALLOW_PRIVATE_NLI` |
> | `docVlm` | Document page transcription | `YTHRIL_ALLOW_PRIVATE_DOC_VLM` |
> | `docRepair` | Document repair pass (local model) | `YTHRIL_ALLOW_PRIVATE_DOC_REPAIR` |
> | `docVerify` | Document verify pass | `YTHRIL_ALLOW_PRIVATE_DOC_VERIFY` |
> | `assist` | External assist model (F11-b) | `YTHRIL_ALLOW_PRIVATE_ASSIST` |
> | `faceExternal` | External face recogniser | `YTHRIL_ALLOW_PRIVATE_FACE_EXTERNAL` |
>
> The env vars accept `true` **or** `false` — unlike the instance-wide one, a `false` here is meaningful,
> because it is how you pin one endpoint strict from the Deployment. Anything other than those two exact
> strings is not a setting and defers to the instance-wide flag. Like the instance-wide flag, none of these
> is settable through the admin API.
>
> No per-slot setting reaches the crown jewels: loopback, link-local / cloud metadata and the unspecified
> address stay blocked for every slot, at both save time and resolution time.
>
> The instance reports this in its startup security posture and at `GET /api/about/security`:
> `egress.privateModelEndpoints` (endpoints the permission is actually being used for),
> `egress.unreachableModelEndpoints` (endpoints configured privately with **no** permission for their slot
> — these cannot work, and fail silently at inference rather than at save), and
> `egress.perSlotOverrides` (slots whose setting departs from the instance-wide flag, so the one endpoint
> you deliberately kept strict is visible rather than implied). All three can appear at once, which is
> exactly what a mixed estate looks like.
>
> **Reading that posture line when your endpoints are DNS names.** The check is synchronous and does
> **not** resolve DNS — resolving at boot would make the posture block hang on a slow resolver. An
> endpoint written as a hostname is therefore reported as `(hostname, not resolved here)`, which means
> *unknown*, not *public*. On a cluster where every endpoint is a `*.svc.cluster.local` name, none of
> them will be counted as private, and that is not evidence that the permission is unused. Only
> endpoints written as IP literals can be classified from configuration alone.
>
> **When a call is refused, the server says so.** Every SSRF refusal writes one `warn` line naming the
> target, the address it resolved to, and the setting that would permit it — so a blocked endpoint is
> diagnosable from the container log, not only from whatever a dialog happened to show. The line is
> redacted like any other, so a key in a query string is not echoed into the log.
>
> **`YTHRIL_MAX_UPSTREAM_RESPONSE_BYTES` — how large a response any of these providers may return.**
>
> Default **268435456** (256 MiB). Every response body from a sidecar, model endpoint or sync peer is read
> with this ceiling; a body that exceeds it is refused rather than buffered, and the error names which
> upstream and this variable.
>
> **Raise it if you have raised render quality.** The one path that can legitimately approach the default is
> document rendering: `renderDpi` accepts up to 600 and `maxPages` up to 2000, and the sidecar
> returns each page as a base64 image in one JSON body. 50 pages at 600 DPI sits comfortably under 256 MiB;
> 2000 does not.
>
> **A malformed value falls back to the default rather than removing the ceiling**, so a typo cannot silently
> unbound these reads.
>
> Note what this is *not*: the per-provider timeouts bound how **long** a call may take and say nothing about
> how **much** it may return. A fast endpoint streaming gigabytes finishes well inside any timeout.
⚠️ **This is the only setting that sends document content off the instance.** When a task is assigned, the
external model receives OCR-extracted text and draft transcriptions (and, for future image-based tasks,
rendered page images). Settings → Media Processing surfaces an **acknowledgment dialog** on save that states exactly
what egresses to which host; that acknowledgment sets `acknowledgedHost`. Pinning `DOC_ASSIST_URL` (etc.) via
env locks the whole block read-only in the UI. When no assist model is configured, or its `uses` is empty, the
repair pass stays entirely local exactly as before.

**Example `config.json` excerpt:**

```json
{
  "mediaEmbedding": {
    "documentProcessing": {
      "strategy": "hi_res",
      "extractImages": true
    }
  }
}
```

To revert to the old `auto` behaviour (text extraction only, no images):

```json
{
  "mediaEmbedding": {
    "documentProcessing": {
      "strategy": "auto",
      "extractImages": false
    }
  }
}
```

#### Extracted Image Subfiles

When `strategy: "hi_res"` and `extractImages: true`, Ythril creates one extra stored artefact per embedded image found in a document:

- **`_extracted/{originalId}/image-{N}.{ext}`** — decoded image bytes written to the space file store. `N` is a 0-based index within the document. The extension (`png`, `jpg`, etc.) is derived from the MIME type reported by the sidecar.
  - `parentFileId` is set to the original document's filemeta `_id`.
  - The record is hidden from the file manager UI and listing endpoints by default (same as chunks and `_converted/` files). Two independent filters implement this, and both have an opt-out: derived *records* are excluded from the file-meta listing unless `?includeChunks=true`, and the `_converted/` and `_extracted/` *directories* are excluded from the file-store listing unless `?includeDerived=true`. Only at the space root, where the pipeline writes them — a directory of your own with the same name deeper in the tree is left alone.
  - Immediately enqueued for the media embedding pipeline — the image will be captioned and face-searched automatically.

This means a PDF containing five embedded photographs will produce:

- The original PDF file record
- A `_converted/{id}.md` Markdown record
- One chunk record per heading/paragraph section
- Five `_extracted/{id}/image-{N}.jpg` records, each independently captioned and face-searched
