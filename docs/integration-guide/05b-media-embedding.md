# Media Embedding Pipeline

> Part of the [Ythril Integration Guide](../integration-guide.md).

## Media Embedding Pipeline

### Media Embedding Pipeline (Images, Audio, Video)

Binary media files (images, audio, video) are automatically captioned or transcribed and embedded into the vector space for semantic recall. The pipeline is **enabled by default** — the bundled workstation `docker-compose.yml` and the Kubernetes manifests both ship with the required `ollama` (vision) and `whisper` (STT) services. To disable it (or point Ythril at external providers), use **Settings → Media Processing** in the web UI or `PATCH /api/admin/media-config`.

#### Overview

| Media type | Processing |
|---|---|
| Images (PNG, JPEG, GIF, WebP, …) | Caption via Ollama-compatible vision model → embed caption |
| Audio (MP3, WAV, OGG, FLAC, …) | Silence-detect → STT chunks via Whisper-compatible API → embed each chunk |
| Video (MP4, MKV, MOV, WebM, …) | Extract audio → STT → embed; at the `full` level also caption sampled keyframes and fold them into the transcript segments (at `audio` the vision model is not used) |

All media ultimately produces text that passes through the same `nomic-embed-text-v1.5` embedding model used for documents — no separate CLIP or multimodal vector space is required.

#### Disabling or Switching Providers

Media embedding is **always on** — there is no master on/off switch. To turn a class off, set its **level** to `off` per class (images / audio / video) on **Settings → Media Processing**, or via `PATCH /api/admin/media-config` with a `levels` block (e.g. `{ "levels": { "images": "off", "audio": "off", "video": "off" } }` turns all media off instance-wide). *(Breaking change: the old `MEDIA_EMBEDDING_ENABLED` env var and `mediaEmbedding.enabled` config flag were removed; an existing `enabled:false` is auto-migrated to those three levels = `off` on upgrade.)*

Required services (bundled by default; override only when you point at external providers):

- **Ollama** (image captioning): `VISION_BASE_URL=http://ollama:11434` — deploy any vision-capable model, set via `VISION_MODEL` (default: `moondream`).
- **faster-whisper-server** (audio/video STT): `STT_BASE_URL=http://whisper:8000` — set model via `STT_MODEL` (default: `base`).

> The legacy names still work and warn once at startup: `OLLAMA_URL` → `VISION_BASE_URL`, `WHISPER_URL` → `STT_BASE_URL`, `WHISPER_MODEL` → `STT_MODEL`. The reasoning is in the rename note below.

Kubernetes manifests are provided in `kubernetes/manifests/ollama-deploy.yaml` and `kubernetes/manifests/whisper-deploy.yaml`. Dual `NetworkPolicy` + `CiliumNetworkPolicy` resources are in `media-netpol.yaml` and `media-cilium-netpol.yaml`.

When you point vision/STT at an **external** provider, its endpoint URL is validated against SSRF on save (must be a public http(s) URL) **and** reached only through the SSRF-guarded fetch at runtime (DNS-resolve + IP-pin + redirect re-validation) — so a DNS-rebind or redirect can't turn it into a request to an internal address. The bundled local Ollama/Whisper providers use a direct fetch (their addresses are private by design).

#### Upload Response

When a media file is uploaded, the response includes an `embeddingStatus` field:

| Value | Meaning |
|---|---|
| `"pending"` | Job enqueued; background worker will process soon |
| `"skipped"` | Not analysed — the file exceeds `MAX_FILE_SIZE_BYTES`, **or** this media class is `off` for the space (its `levels` entry). File stored, not embedded |
| `"disabled"` | **Legacy** — set at upload while the removed media-embedding master switch was off. No longer produced (a class turned off now returns `"skipped"`); still appears on pre-migration records |
| `"complete"` | The **identical bytes** were already analysed — nothing was re-run, and the existing description, transcript and vector still stand |

##### Re-uploading the same file costs nothing

Uploading a media file whose SHA-256 matches the one already stored, on a record that reached `"complete"`, skips
the pipeline entirely and answers `"complete"` immediately. Vision and speech-to-text are the most expensive work
this instance does, and the same bytes through the same pipeline cannot produce a different answer.

Every uncertain case still processes, so this cannot leave a file unanalysed: a re-upload is re-run when the bytes
differ, when the writer sends no hash, when the stored record has none (everything written before this release),
and when the previous attempt was anything other than `"complete"` — `"failed"`, `"partial"`, `"pending"`,
`"skipped"` and `"processing"` all re-run. **Re-uploading remains the way to retry a failed analysis.** To force a
re-analysis of a file that succeeded, change the bytes, or delete it and upload it again.

While processing, the filemeta record on the file reflects the current status. Read it with
`POST /api/filter` — `{"collection": "files", "path": "<path>", "limit": 1}`:

| Status | Meaning |
|---|---|
| `"pending"` | Waiting in queue |
| `"processing"` | Currently being processed by the worker |
| `"complete"` | Embedding finished successfully |
| `"failed"` | All retry attempts exhausted; see `mediaJobError` field for details |

#### Recall Results

Recall queries (`recall`, `similar`) include embedded media chunks. Each media chunk result has additional fields:

```json
{
  "type": "file",
  "mediaType": "audio",
  "embeddingStatus": "complete",
  "chunkOffsetMs": 12000,
  "chunkDurationMs": 8000,
  "parentFile": {
    "path": "recordings/meeting-2025-01.mp3",
    "description": "Q1 strategy meeting"
  }
}
```

`chunkOffsetMs` and `chunkDurationMs` identify the segment within the original audio or video file. Image results have `chunkIndex: 0` with no time offset.

#### Retry Failed Embedding

To re-queue a failed job:

```http
POST /api/files/:spaceId/retry_embedding?path=uploads/photo.jpg
Authorization: Bearer ythril_…
```

**Response** `202` — job re-queued.

**Response** `404` — file does not exist or has no embedding job.

**Response** `409` — job is currently processing; retry is blocked until it completes.

#### Configuration

All settings can be managed at `GET/PATCH /api/admin/media-config` or via **Settings → Media Processing** in the web UI. Fields set via environment variables are locked (the UI shows an `env` badge; PATCH returns `403` for those fields).

**Changes take effect without a restart.** Provider settings — `visionProvider`/`sttProvider`, the `vision.*`/`stt.*` endpoint, model, and API key, and `fallbackToExternal` — are applied by a dedicated refresh timer that re-reads the config every ~2 s, independent of the job loop. A provider or model switch is therefore picked up within a couple of seconds **even when the queue is empty or a job is stuck on a slow/unreachable provider** — which matters because you often change providers precisely because one is hanging. A job already in flight keeps the provider it started with, so a swap can never happen mid-job.

The worker-tuning fields — `workerConcurrency`, `workerPollIntervalMs`, `workerMaxPollIntervalMs`, `stalledJobTimeoutMs` — are re-read on the worker's poll tick instead. When the queue is idle the worker backs off its poll interval (up to `workerMaxPollIntervalMs`, default 30 s), so a change to one of these can take up to that long to be picked up while idle.

`GET /api/admin/media-config` returns a `providerReloadPending` boolean: `true` briefly after a provider change is saved and before the refresh timer has applied it, then `false`. Use it to show an "applying…" state in a UI.

| Field | Env var | Default | Description |
|---|---|---|---|
| `levels.{images,audio,video,text}` | — | `auto` | Per-class instance ceiling; set a class to `off` to take it offline. **This is the media on/off control** (the `enabled` / `MEDIA_EMBEDDING_ENABLED` master switch was removed). |
| `visionProvider` | `VISION_PROVIDER` | `local` | Wire protocol, not trust level: `local` (Ollama `/api/chat`) or `external` (OpenAI `/chat/completions`). A self-hosted OpenAI-compatible server needs `external` — see `allowPrivateModelEndpoints` for one on a private address. |
| `sttProvider` | `STT_PROVIDER` | `local` | Wire protocol, not trust level: `local` (bundled Whisper) or `external` (OpenAI-compatible). Both speak `/v1/audio/transcriptions`. |
| `vision.baseUrl` | `VISION_BASE_URL` | `http://ollama:11434` | Vision service endpoint, **whatever the provider** (short name resolves in both Docker Compose and the K8s `ythril` namespace). On an OpenAI-compatible provider, `…:8080` and `…:8080/v1` both work. Legacy alias: `OLLAMA_URL`. |
| `vision.model` | `VISION_MODEL` | `moondream` | Vision model name |
| `vision.apiKey` | `VISION_API_KEY` | — | API key for external vision provider (stored in `secrets.json`, never in `config.json`) |
| `stt.baseUrl` | `STT_BASE_URL` | `http://whisper:8000` | STT service endpoint, **whatever the backend**. `…:8000` and `…:8000/v1` both work — the transcription URL is normalised the same way the vision and assist endpoints are, so one base URL serves all three. Legacy alias: `WHISPER_URL`. |
| `stt.model` | `STT_MODEL` | `base` | STT model name — passed through to the backend, so it is not restricted to Whisper size names. Legacy alias: `WHISPER_MODEL`. |
| `stt.apiKey` | `STT_API_KEY` | — | API key for external STT provider (stored in `secrets.json`) |

> **Renamed in 2.1: `OLLAMA_URL` → `VISION_BASE_URL`, `WHISPER_URL` → `STT_BASE_URL`, `WHISPER_MODEL` → `STT_MODEL`.**
>
> The old names described the implementation that happened to be first, not the field they configure.
> `OLLAMA_URL` (now `VISION_BASE_URL`) is the sharpest case: it sets `vision.baseUrl`, which is used **even when
> `visionProvider` is `external`** — so an operator running vLLM or llama.cpp had to set a variable named
> after a product they were not running, assuming they found it at all. This is the same distinction the
> provider switch already gets right: **the setting names a wire protocol, not a product.**
>
> **The old names were REMOVED in 4.0, and setting one now stops the boot.** They resolved as aliases for
> the whole of 3.x, warning once at startup; this page used to say they would never be removed on a timer,
> which was reconsidered and announced one release ahead.
>
> **The refusal is the point, not an inconvenience.** Deleting the alias and nothing else would mean a
> manifest that still says `OLLAMA_URL=http://vllm:8000` (rather than `VISION_BASE_URL`) boots cleanly, configures nothing, and captions
> every document against the built-in `http://ollama:11434` default — with no error anywhere. So the name
> stops configuring anything and starts stopping the boot, naming the replacement in the message. A variable
> that is present and has no effect is the worst of the three possible behaviours.
>
> Rename them and the instance starts. Both spellings resolved in every 3.x build, so the rename is safe to
> make before the upgrade as well as after.
>
> `lockedByInfra` tracks whichever spelling you used, so the Settings UI renders the field read-only
> either way.

| Field | Env var | Default | Description |
|---|---|---|---|
| `embedding.provider` | `EMBEDDING_PROVIDER` | `local` | Text-embedding endpoint trust: `local` (bundled ONNX or an internal HTTP endpoint, plain fetch) or `external` (public endpoint, reached through the SSRF-guarded fetch). Config lives at top-level `config.embedding` but is edited on **Settings → Media Processing**. |
| `embedding.baseUrl` | `EMBEDDING_URL` | — | Embedding HTTP endpoint (OpenAI-compatible `/v1/embeddings`). `…:8080` and `…:8080/v1` both work. Blank = the bundled in-process ONNX model. |
| `embedding.embedConcurrency` | `EMBEDDING_CONCURRENCY` | 2 in-process / 8 external | How many chunk embeds run at once while converting one document. Defaults differ by embedder **on purpose**: the bundled model is CPU-bound and shares the event loop that answers `/health`, while an HTTP endpoint does the work elsewhere. Clamped to 1…32. See the note below before raising it. |
| `embedding.model` | `EMBEDDING_MODEL` | `nomic-ai/nomic-embed-text-v1.5` | Embedding model. **Changing the model / `dimensions` / `similarity` / `prefixScheme` re-indexes every vector** (the UI requires an explicit confirmation; `POST /api/brain/spaces/:id/reindex` runs it). |
| `embedding.prefixScheme` | `EMBEDDING_PREFIX_SCHEME` | `auto` | Task-prefix convention the model expects: `nomic` (`search_document:` / `search_query:` prefixes, trailing space included), `qwen` (instruction on the query only, passages bare), `none` (symmetric models — OpenAI `text-embedding-3-*`, bge-m3), or `auto`. **`auto` reproduces the behaviour this instance had before the field existed: `nomic` for the bundled model, `none` over HTTP — so upgrading changes no vector.** If you run nomic or Qwen behind an endpoint, set this explicitly and reindex — asymmetric models retrieve measurably worse without the prefix, and nothing errors when it is missing. |
| `embedding.dimensions` | `EMBEDDING_DIMENSIONS` | `768` | Vector width the model emits. Must match the model — a mismatch is not detected at write time, it surfaces as recall that returns nothing. Listed with `model` above as a re-index trigger. |
| `embedding.apiKey` | `EMBEDDING_API_KEY` | — | API key for an external embedding endpoint (stored in `secrets.json`, masked in the API). |
| `mediaEmbedding.nli.baseUrl` | `NLI_URL` | — | Contradiction-judge endpoint. **Blank = contradiction detection has no judge** and the Contradictions view is empty by design, not by failure. Same locality rule as the reranker: a loopback or dot-less host is a sidecar and gets a plain fetch; anything else goes through the SSRF-guarded fetch. It sees **pairs of stored record texts**, so it is an egress path of the same weight as vision or STT. |
| `mediaEmbedding.nli.model` | `NLI_MODEL` | — | NLI model name, e.g. an mDeBERTa or DeBERTa cross-encoder. **Must be a 3-class MNLI head** — it has to emit `entailment` / `neutral` / `contradiction`. A 2-class head (`entailment` / `not_entailment`, as most *zeroshot* variants are) does **not** degrade gracefully: its label maps to nothing, every pair is recorded unjudged, and the scanner is indistinguishable from one with a dead endpoint. If your server emits `LABEL_<n>` indices rather than names, check the ordering — standard MNLI is `0=contradiction, 1=neutral, 2=entailment`, but `cross-encoder/nli-deberta-v3-base` is `0=contradiction, 1=entailment, 2=neutral`, so index-emitting servers can be misread. Prefer a server that emits label strings. Required alongside `baseUrl`. |
| `mediaEmbedding.nli.apiKey` | `NLI_API_KEY` | — | API key for the contradiction judge (stored in `secrets.json`, masked in the API). |
| `mediaEmbedding.rerank.baseUrl` | `RERANK_URL` | — | Reranker endpoint. **Blank = reranking is off** (there is no separate toggle). A URL ending in `/rerank` is read as the text-embeddings-inference request shape; anything else gets `/v1/rerank` appended and the Cohere/Jina shape. A loopback or dot-less host is treated as a sidecar and reached with a plain fetch; anything else goes through the SSRF-guarded fetch. |
| `mediaEmbedding.rerank.model` | `RERANK_MODEL` | — | Cross-encoder model, e.g. `BAAI/bge-reranker-v2-m3`. Required alongside `baseUrl` — reranking is on only when both are set. |
| `mediaEmbedding.rerank.candidateMultiplier` | `RERANK_CANDIDATE_MULTIPLIER` | `4` | Candidates fetched per requested result before reranking (2–10, and capped at 100 candidates absolutely). A reranker can only re-order what the vector search already found, so this over-fetch is the whole mechanism; at 1 it would reorder exactly the results you would have got anyway. **It is also the cost multiplier**: the reranker scores every candidate passage, so the budget must cover the total text of `topK x candidateMultiplier` candidates. On records of several kilobytes that is seconds per result -- raise `modelSlots.rerank.timeoutMs` with it, or lower this. |
| `mediaEmbedding.rerank.maxPassagesPerRequest` | *(none — admin PATCH only)* | `32` | **How many passages travel in ONE request to the reranker**, which is a different question from how many are scored. A stock text-embeddings-inference server accepts 32 per request and answers `413 Payload Too Large` above it, whatever the candidate count is — and that 413 surfaces as `degraded: ["rerank_unavailable"]`, so the search is served in fused order and looks entirely healthy. Candidates are split into batches of this size and sent together, with ONE deadline for the whole pass rather than one each. Total work is unchanged: a cross-encoder is a forward pass per passage. Range 1 … 100. **If any batch fails the whole pass is abandoned** and the vector order stands — a list ordered partly by cross-encoder and partly by vector score, with nothing saying which is which, is a plausible wrong answer rather than a missing one. Raise it to get a single request back on a reranker that accepts more. |
| `mediaEmbedding.rerank.apiKey` | `RERANK_API_KEY` | — | API key for the reranker (stored in `secrets.json`, masked in the API). |
| *(no config key)* | `YTHRIL_PINNED_FIELDS` | — | Comma-separated field paths to FIX at whatever they currently resolve to, **including nothing**: `YTHRIL_PINNED_FIELDS=rerank.apiKey,nli.apiKey`. Each listed path joins `lockedByInfra`, so `PATCH /api/admin/media-config` answers **403** for it and the Settings control renders read-only — without anyone having to put a value in the environment to achieve that. Env-only, and it must be: an EMPTY env var deliberately does not pin, because `docker compose` passes `${VAR:-}` and leaves variables defined-but-empty when the operator set nothing, so reading "defined" as "pinned" would lock every field on every Compose deployment. A path must be a field the admin API can write — an unrecognised entry pins nothing and is reported in `pinnedUnknown` on the config response as well as warned at boot, because a pin that looks applied and is not is the one failure this exists to prevent. |
| *(no config key)* | `YTHRIL_HYBRID_SEARCH` | on | Set to `off` to disable **hybrid retrieval** — the lexical (BM25-family `$text`) channel that is fused into semantic recall by Reciprocal Rank Fusion. Env-only on purpose: it is a rollback lever for isolating a retrieval regression, not an operator preference. On by default; a space whose collections have no `lexical_text` index simply contributes an empty lexical channel and recall stays vector-only. **This does not replace the list filters** — `?search=` and the column filters decide which records are *eligible*; hybrid decides how eligible records *rank*. |
| `modelSlots.<slot>.timeoutMs` | *(none — see below)* | per slot | **How long ONE call to a model slot may take.** The ten slots are `vision`, `stt`, `embedding`, `rerank`, `nli`, `assist`, `docVlm`, `docRepair`, `docVerify` and `faceExternal` — the same names the per-slot egress permissions use. Defaults are the values these calls always had: vision 120 s, stt 300 s, embedding 30 s, rerank 20 s, nli 20 s, faceExternal 30 s, and 60 s for the four document slots. Absent means the default; `null` through the admin PATCH clears it back to the default. Range 1 000 … 1 800 000 ms. **Deliberately no environment variable** — every setting that had both an env var and an admin field was found to have two different legal ranges, so these have one door. Infra pins a slot with `YTHRIL_PINNED_FIELDS=modelSlots.vision`, which fixes it at whatever the config resolves to. **Raising one raises the stall floor with it**: the media stall detector is fed the configured value, so a long call is not re-queued while it is still running. **On the four document slots** — `docVlm`, `docRepair`, `docVerify` and `assist` — a value set here wins over `documentProcessing.pageTimeoutMs`, which is what those calls fall back to when no slot budget is set. |
| `modelSlots.<slot>.reasoningEffort` | *(none — the field is not sent)* | per slot | **How hard a thinking model should think on this slot**, sent as `reasoning_effort` on the OpenAI-shaped request. One of `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` — `llama-server`'s own vocabulary. Absent means the field is NOT SENT: a model never trained for it ignores the parameter at best and rejects the request at worst, so this never turns itself on. `null` through the admin PATCH clears it. **Only `none` is handled by the inference server** (it disables thinking outright); every other value is passed to the model's chat template, which decides — and a template that does not know a value FAILS THE REQUEST. Qwen3.8 accepts `low`, `medium`, `xhigh` and errors on `minimal`, `high`, `max`. Not sent on the Ollama wire, which has no such field. |
| `workerConcurrency` | `WORKER_CONCURRENCY` | `2` | Max parallel jobs |
| `workerPollIntervalMs` | `WORKER_POLL_INTERVAL_MS` | `1000` | Base poll interval (ms) |
| `workerMaxPollIntervalMs` | `WORKER_MAX_POLL_INTERVAL_MS` | `30000` | Max poll interval when idle (ms) |
| `fallbackToExternal` | `MEDIA_EMBEDDING_FALLBACK_TO_EXTERNAL` | `false` | Use external provider if local fails |
| `maxFileSizeBytes` | `MAX_FILE_SIZE_BYTES` | `524288000` | Skip embedding for files above this size (500 MiB) |
| `stalledJobTimeoutMs` | `STALLED_JOB_TIMEOUT_MS` | `300000` | Re-queue a job that has reported no progress for > N ms. **Raised automatically when a single step allows longer than this** — see the note under the document-processing table: a step longer than the stall timeout would be re-queued while it is still running. Measured from the last heartbeat, not from the claim, and re-queuing now withdraws the running claim so the previous holder stops rather than racing its replacement. Each re-queue logs one `warn` with the file, the silence, the size and the step. |

> **Large documents, CPU limits and liveness probes.** With the **bundled in-process** embedder, one ~2 KB
> chunk costs roughly 200 ms of CPU and blocks the event loop for most of it. A 350 KB document is hundreds
> of chunks — minutes of work — and if enough of them run at once, HTTP stops being answered for seconds at a
> time. A Kubernetes `livenessProbe` on `/health` then kills a container that is working correctly, the
> persisted job resumes after the restart, and the result is a crash loop with **no error and no `failed`
> status** to point at the document.
>
> Measured inside the shipped image, 16 chunks: at concurrency 8 with no yielding, the loop was blocked for
> **2.5 s at a stretch** (a 50 ms timer fired once in 4.7 s). At concurrency 2 with a yield between chunks it
> was 0.5 s — and finished **22% faster**, because concurrent CPU-bound inferences thrash rather than
> parallelise.
>
> The defaults above are chosen for that reason, and the pipeline yields between chunks. If you raise
> `embedConcurrency`, raise the CPU allocation with it, and give the probes room:
> `timeoutSeconds: 10` with `failureThreshold: 6` tolerates a slow answer far better than the defaults do.
> An **external** embedding endpoint sidesteps the whole question — the CPU work happens on another host.

#### Step budgets and the stall detector

> **A single step may not outlast the stall detector, and it no longer can.** `stalledJobTimeoutMs` re-queues
> a job that has reported no progress for that long, and progress is reported *between* steps — never inside
> one. So a budget that allows one call to run longer than the stall timeout would have the job re-queued
> **while that call was still working**: the original run then discovers its claim is gone and abandons, the
> replacement starts the same document, reaches the same step, and is re-queued at the same point. A loop that
> never finishes.
>
> **This binds at the defaults, and it is not only reachable by configuration.** The claim that the longest
> step was `ocrTimeoutMs` at 0.4× the stall timeout counted only the *settable* fields. Two kinds of budget were
> not settable and therefore not counted:
>
> | step | budget | vs the 5-minute stall default |
> |---|---|---|
> | render of one page window | `pageTimeoutMs × min(maxPages, 20)` = **20 min** | **4×** |
> | audio transcription (Whisper) | 5 min, fixed | **1×** — equal, so indistinguishable without head-room |
> | image caption (local / external) | 2 min / 1 min | 0.4× / 0.2× |
> | external face recognition | 30 s | 0.1× |
>
> **`fallbackToExternal` makes two of those rows into one step, and the table above counts them as two.** When
> the primary provider fails, the fallback is called inside the *same* hop with nothing reporting progress
> between them, so the budget is the **sum**, not the larger:
>
> | step, with `fallbackToExternal: true` | budget | vs the 5-minute stall default |
> |---|---|---|
> | audio transcription, local then external | 5 min + 5 min = **10 min** | **2×** |
> | image caption, local then external | 2 min + 1 min = **3 min** | 0.6× |
>
> Both legs share one constant for audio, because the external Whisper client is the local one with its egress
> re-routed. Turning the option on therefore doubles the longest audio step, and the stall floor now accounts
> for it — before, transcription with fallback enabled could be re-queued 2.5 minutes before it was entitled to
> give up. Pointing a slot directly at `external` builds no chain and is unaffected.
>
> So on a stock install the effective stall timeout is now **30 minutes** (1.5 × the render window), not 5. That
> is the cost of the fix, and it is the right trade: the alternative was a document large enough to need a
> >5-minute render being re-queued mid-render, forever. **Lower `maxPages` or `pageTimeoutMs` and the floor
> comes down with them** — 3-page windows need no raise at all.
>
> Rather than refuse a setting, **stall detection raises its own threshold** to 1.5× the longest step and logs
> one line saying so. Nothing you set is contradicted; the detector simply stops firing inside a step it
> allows. Raise `stalledJobTimeoutMs` past that figure yourself and the line goes away.
>
> Also reachable by configuration, as before: `ocrTimeoutMs` accepts up to **30 minutes** and the two model
> budgets up to **10** each.
>
> **Two media steps are not one model call but N of them, and no budget can describe N.** Audio transcribes
> one silence-delimited chunk at a time, and a keyframed video captions one frame per 30 s of footage with no
> cap — so an hour of either is dozens of calls inside a single job step. Raising a per-call budget cannot
> help: the budget bounds one call and the step is a loop of them. Both loops now **report progress once per
> item**, so the stall detector sees a working job for what it is, and both **stop when their claim is
> withdrawn** rather than continuing alongside the run that recovered the job. Those two are what make a long
> media file safe, not the numbers above.

#### ISO 27001 / Data Egress Note

When `visionProvider: external` or `sttProvider: external`, file bytes (image frames, audio segments) are transmitted to the configured external endpoint. Ensure the endpoint URL complies with your data residency and privacy requirements. Using `visionProvider: local` and `sttProvider: local` with on-premises Ollama and Whisper keeps all data within your infrastructure.
