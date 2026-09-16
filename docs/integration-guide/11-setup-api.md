# Setup API

> Part of the [Ythril Integration Guide](../integration-guide.md).

## Setup API

### Health Check (unauthenticated)

```http
GET /health
```

**Response** `200`:

```json
{ "status": "ok", "ts": "2026-03-25T14:00:00.000Z" }
```

---

### Readiness Check (unauthenticated)

```http
GET /ready
```

Returns process readiness based on dependency checks (MongoDB + vector search availability).

**Response** `200` when ready, `503` when not ready.

Example:

```json
{
  "ready": true,
  "checks": {
    "mongodb": { "status": "ok" },
    "vectorSearch": { "status": "ok" }
  }
}
```

---

### Prometheus Metrics

```http
GET /metrics
```

Exposes a [Prometheus-compatible](https://prometheus.io/docs/instrumenting/exposition_formats/) metrics endpoint for production monitoring.

**Authentication**: Set the `METRICS_TOKEN` environment variable (recommended) — Prometheus scrapers must send `Authorization: Bearer <METRICS_TOKEN>` in their scrape config. If `METRICS_TOKEN` is unset the endpoint falls back to requiring a valid admin PAT. Returns `401` without valid credentials.

**Response** `200` — `text/plain; version=0.0.4; charset=utf-8`:

```text
# HELP ythril_http_requests_total Total HTTP requests by method, route pattern, and status code
# TYPE ythril_http_requests_total counter
ythril_http_requests_total{method="GET",route="/health",status_code="200"} 42
...
```

**Metrics exposed:**

| Metric | Type | Description |
|---|---|---|
| `ythril_http_requests_total` | counter | Total requests by method, route, status code |
| `ythril_http_request_duration_seconds` | histogram | Request latency by method and route |
| `ythril_http_request_size_bytes` | histogram | Request body size |
| `ythril_http_response_size_bytes` | histogram | Response body size |
| `ythril_facts_total` | gauge | Approximate facts by space — read from collection metadata, not counted per scrape |
| `ythril_entities_total` | gauge | Approximate entities by space (same estimate as above) |
| `ythril_edges_total` | gauge | Approximate edges by space (same estimate as above) |
| `ythril_chrono_entries_total` | gauge | Approximate chrono entries by space (same estimate as above) |
| `ythril_spaces_total` | gauge | Number of configured spaces |
| `ythril_embedding_duration_seconds` | histogram | Time to compute a single embedding |
| `ythril_embedding_queue_depth` | gauge | Pending embedding operations |
| `ythril_embedding_retry_total` | counter | Transient embedding-endpoint refusals that were retried, labelled by HTTP `status`. A rising 429 count means a shared endpoint is at capacity while recalls are still succeeding — the retry hides the symptom, so this is the warning. |
| `ythril_reindex_in_progress` | gauge | 1 if a reindex is running, 0 otherwise |
| `ythril_storage_used_bytes` | gauge | Storage used in bytes by area (brain, files, total). **From a cached measurement, not re-walked per scrape** — see `ythril_storage_usage_age_seconds` below and the note on why. |
| `ythril_storage_limit_bytes` | gauge | Configured storage limits by area and tier (soft, hard) |
| `ythril_auth_attempts_total` | counter | Auth attempts by result (success, invalid) |
| `ythril_tokens_active` | gauge | Number of active (non-expired) tokens |
| `ythril_tool_calls_total` | counter | Tool invocations by tool name, space and `door` (`mcp` or `rest`) |
| `ythril_sync_cycles_total` | counter | Sync cycles by `network` and `status` — `success`, `partial`, `error`. |
| `ythril_sync_items_pulled_total` | counter | Items received by `type` — `facts`, `entities`, `edges`, `files`, `chrono`. |
| `ythril_sync_items_pushed_total` | counter | Items sent by `type` — same set as pulled. |
| `ythril_sync_duration_seconds` | histogram | Time per sync cycle |
| `ythril_recall_degraded_total` | counter | Recalls answered with a **weaker pipeline than configured**, by `reason`. `rerank_unavailable` = the cross-encoder is configured but did not answer; `rerank_skipped_budget` = it was not attempted because the end-to-end `RECALL_BUDGET_MS` was already spent upstream. **This is the one to alert on**: these paths return HTTP 200 with a worse ranking, so they raise no error rate and barely move latency — a reranker down for a week is otherwise invisible. Both series report `0` from process start, so absent-vs-zero is never ambiguous. |
| `ythril_recall_fresh_writes_found_total` | counter | Records returned by recall that the **vector index had not yet ingested** — only ever incremented when a caller passes `includeFreshWrites`. Deliberately not a `reason` on the degraded counter: finding more than the index could offer is the opposite of degradation. What it is for is making the index lag measurable instead of anecdotal; zero means the index is keeping up with writes on this instance. |
| `ythril_media_jobs_pending` | gauge | Queued media/document embedding jobs by space, counted **at scrape time** (so it is a sample, not a running total). |
| `ythril_media_jobs_processing` | gauge | Jobs a worker is currently running, by space. Counted **at scrape time**, so it is a sample. **One long document shows as `1` here for its whole duration** — pair it with `ythril_embed_chunks_total` to tell slow from stuck |
| `ythril_media_job_phase` | gauge | In-flight jobs by the pipeline step they are in (`render`, `vlm`, `embed`, `describe`, …, or `unknown` for a job that has not reported one). The known step names are **seeded at `0` from the first scrape**, so the series exists before any job has been in them; an unlisted step appears the moment it is seen |
| `ythril_embed_chunks_total` | counter | Chunks put through the embedder, by space. Motion, not success: `rate(...[5m]) == 0` while `ythril_media_jobs_processing > 0` is a stuck job, a non-zero rate is a slow one — **but see the restart caveat below before alerting on it** |
| `ythril_brain_write_seq_total` | counter | Brain record writes by whether the record **changed between read and write**, labelled `collection` and `outcome` (`clean` / `collision` / `refused`). A `collision` is a **lost update that happened**: two clients edited the same record and the second write silently overwrote the first with a `200` and no trace. A `refused` is one that **did not** — an `If-Match` precondition stopped the write and the client got a `412`. The two are separate series on purpose: folding them would conflate a loss with a prevented loss, and would change the meaning of the `collision` series halfway through its own history. Note the exposure is narrower than it sounds — a write `$set`s only the fields the caller supplied, so two clients editing *different* fields both succeed and lose nothing; a collision means the same field. All three series report `0` from process start, so absent-vs-zero is never ambiguous, and `clean` is counted so the collision number has a denominator. |
| `ythril_media_jobs_completed_total` | counter | Jobs that finished, by space and media type |
| `ythril_media_jobs_failed_total` | counter | Jobs that exhausted their retries, by space and media type |
| `ythril_media_jobs_retried_total` | counter | Attempts that failed and were re-queued, by space and media type — including a job whose claim was recovered while it was still running |
| `ythril_media_jobs_failed` | gauge | Jobs sitting in the terminal `failed` state by space, counted **at scrape time** (a backlog, not a rate) |
| `ythril_media_job_duration_seconds` | histogram | End-to-end time per job by media type |
| `ythril_metrics_collect_duration_seconds` | histogram | Time for one async collector to gather its values, by `collector` — one observation per collector per scrape. **This is how a slow `/metrics` names its own cause.** Several gauges here are collected at scrape time and walk every space, so on a many-space instance under write load a scrape can approach the Prometheus timeout; `topk(3, ythril_metrics_collect_duration_seconds_sum / ythril_metrics_collect_duration_seconds_count)` says which collector is responsible. **It is a histogram, so the bare metric name is not a series** — only `_bucket`, `_sum` and `_count` exist, and an instant query for `ythril_metrics_collect_duration_seconds` returns empty. That reads as "the metric is missing" rather than "wrong series name", which cost a canary operator a minute and would cost the next person longer. Buckets run to 15 s deliberately — a histogram whose top bucket sits below the failure cannot describe it. |
| `ythril_metrics_scrape_degraded` | gauge | `1` if the scrape being served had to abandon at least one collector to stay inside its budget, else `0`. **This is the one to alert on**, because the degradation is otherwise invisible: the scrape succeeds, `up` stays 1, and only the abandoned series are missing. It describes the scrape you are reading, not the previous one. |
| `ythril_metrics_collect_timeouts_total` | counter | Collectors abandoned mid-scrape because the scrape budget ran out, by `collector`. **This names a slow collector without anyone having to catch a scrape while it is happening** — which is otherwise the hard part, since the problem only appears under load. Every collector is pre-declared at `0`, so an absent series never has to be told apart from a healthy one. |
| `ythril_storage_usage_age_seconds` | gauge | How old the measurement behind `ythril_storage_used_bytes` is. **Those numbers are cached, not re-measured per scrape** — see the note below for why. Absent until the first measurement completes, which is deliberate: a `0` would claim "just measured". |
| `ythril_storage_usage_complete` | gauge | `1` when the last storage measurement read everything for that `area` (`files`, `brain`); `0` when it could not, which makes that area's `ythril_storage_used_bytes` series a **lower bound**. **Alert on `== 0`.** A directory the process cannot list, or a `dbStats` the database user is not allowed to run, used to contribute zero bytes — and a floor compared against a hard limit can only under-report, so a quota an operator configured stops firing with nothing to see. Nothing in the storage series can express that: 0.4 GiB reads identically whether it is the whole store or the readable part of it. The REASON is not a label here, because a filesystem path is not a label value — it is in the WARN line the measurement logs, which names what it could not read. Absent until the first measurement completes; a reset is deliberately not used for "unknown", since a reset reads as `0` and `0` is the alerting state — and the `area` label is what makes absence expressible at all, because an unlabelled gauge is initialised to `0` on construction and could never be absent. |
| `ythril_storage_usage_measurements_total` | gauge | Completed walks of the files tree since process start. Answers "how often are we doing the expensive thing"; on a large store the answer used to be *every scrape*. |
| `ythril_security_posture_checks` | gauge | This instance's own PASS/WARN/FAIL posture, by `level` — the same findings the boot log prints and `GET /api/about/security` serves, computed per scrape from the same function. **Alert on `level="fail"` > 0**: the checks that matter most produce no runtime symptom at all (`requireEncryptedTransport` on *without* `trustProxy` rejects every request with a 403 that looks like a client problem), and the only other way to notice was somebody reading the boot log of each instance. All three levels report `0` from process start. |

> **Storage usage is measured out of band, and the age is published with it.**
>
> `ythril_storage_used_bytes` used to walk the entire files tree on every scrape. On an instance with a
> real corpus that took **22 s** against ~8.6 s for every MongoDB-backed collector, and it was the sole cause
> of half the scrapes on that target failing outright. It is now read from a cache that a **background** walk
> refreshes; a scrape never blocks on filesystem I/O.
>
> `METRICS_SCRAPE_BUDGET_MS`'s sibling `METRICS_STORAGE_USAGE_MAX_AGE_MS` sets how stale the
> cached value may get before a scrape kicks a refresh. Default **300000** (5 minutes), generous on purpose:
> stored volume moves slowly, and during real activity every write already refreshes the cache as part of its
> quota check — so this only governs freshness while the instance is idle, which is when it is least likely to
> have changed.
>
> **Watch `ythril_storage_usage_age_seconds` if you care about freshness.** A cached number with no
> visible age is worse than a missing one, so the age is a first-class series rather than something you have
> to infer.
>
> **The first scrape after a cold start carries no storage series.** The walk is kicked, not awaited, so the
> value arrives on the next scrape. An absent series says "not measured yet"; a zero would have said "empty".
>
> **A collector Prometheus gave up on still finishes, and still records its duration.**
>
> Worth stating because it is useful and not obvious: if a scrape exceeds your `scrape_timeout`,
> Prometheus discards the *response*, but the server does not abandon the work — the collection completes and
> its observation lands in the histogram, which a later successful scrape then delivers. That is why timing
> data exists at all for the scrapes that failed.
>
> The corollary matters too: an instance whose scrapes **all** time out looks silent while doing the work. If
> you see `up=0` with no timing data, the histogram is not empty — nothing has managed to carry it to
> you yet.
> **A slow scrape degrades one graph, not the whole target.**
>
> Several gauges above are collected at scrape time and walk every space, so a many-space instance under
> write load can push `/metrics` toward the Prometheus timeout. Without a guard the consequence is out of all
> proportion to the cause: the scrape fails, Prometheus records `up=0`, and **every series from that target
> disappears** — HTTP latency, event-loop lag, embed throughput, including the ones that would explain the
> outage.
>
> So the scrape has a deadline. A collector that cannot finish inside it is abandoned: **its** series are
> dropped for that scrape, `ythril_metrics_collect_timeouts_total` counts it by name, and
> `ythril_metrics_scrape_degraded` reads `1`. Everything else is served normally and `up` stays 1.
>
> The abandoned collector is **dropped rather than left holding its last values**, deliberately. Stale numbers
> presented as current are indistinguishable from a healthy flat line — you would read "storage steady" off a
> collector that has not answered in an hour. A gap is honest.
>
> `METRICS_SCRAPE_BUDGET_MS` sets the deadline. Default **8000**, chosen to sit under the Prometheus
> default of 10 s with room for serialisation and transfer — if you have raised `scrape_timeout`, raise
> this with it. Set it to `0` to disable the budget and restore all-or-nothing collection. A malformed
> value falls back to the default rather than to `0`, so a typo cannot silently switch the guard off.
>
> **The stuck-job recipe needs a restart guard.** A counter **resets to zero on restart**, so
> `rate(ythril_embed_chunks_total[5m])` is 0 for the first five minutes of a new process while jobs are
> completing normally. A reporting operator built the alert exactly as recommended and it fired two minutes
> after an OOM restart, with the log showing jobs finishing — which is the worst moment to page someone.
>
> Either give it a long `for:` (15 m covers the window), or exclude a young process outright:
>
> ```promql
> rate(ythril_embed_chunks_total[5m]) == 0
>   and ythril_media_jobs_processing > 0
>   and (time() - process_start_time_seconds) > 600
> ```
>
> `ythril_media_job_phase` is the better first look during an incident anyway: it says which step, not just
> whether anything moved.

Default Node.js process metrics (`nodejs_*`, `process_*`) are also included via [prom-client](https://github.com/siimon/prom-client)'s `collectDefaultMetrics()`.

**Correlating a failure with its log line.** Every response carries an `X-Request-Id` header, and **every log
line the request's own work produces carries the same id** — the 4xx it answered with, the WARN a background step
logged mid-request, the 507 a quota refused with, not only an unhandled crash. Grep the id.

The id is ambient for the request's call tree, so it does not reach a line logged from an event callback that
fires after the handler returned — a connection close, a child-process error. Both of those are debug-level
today. It is stated because an EventEmitter listener does not inherit the context it was registered in, which is
measured behaviour and not an implementation detail that will quietly change.

This used to be true of one line only, the unhandled-error handler, which meant an id could be correlated
exactly when the failure was a crash and not when it was handled — and the handled ones are what get reported.
Lines written outside a request (boot, the TTL sweep, the background storage walk) carry no id, deliberately: a
placeholder there would make a search for a real id match them.

The admin UI **shows the id in the message** for a server-side failure (5xx, or a request that got no answer at
all), so a bug report can quote it. It is deliberately not appended to a 4xx *in the response*: a validation
message explains itself, and an id on every one of them trains people to ignore the id when it matters. The log
line for that 4xx carries the id regardless.

**Kubernetes example** (Prometheus Operator `ServiceMonitor`):

```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: ythril
spec:
  selector:
    matchLabels:
      app: ythril
  endpoints:
    - port: http
      path: /metrics
      interval: 30s
      authorization:
        credentials:
          name: ythril-metrics-token   # Secret containing METRICS_TOKEN value
          key: token
```

---

### Check Setup Status (unauthenticated)

```http
GET /api/setup/status
```

**Response** `200`:

```json
{ "configured": false }
```

---

### The HTML setup form was REMOVED in 4.0

This section documented four endpoints — `GET /setup`, `POST /setup`, and the same pair under `/api/setup` —
serving a server-rendered first-run form. **All four are gone**, and two of them had already stopped
answering before this page said so.

**Use `POST /api/setup/json`** (below) for programmatic first-run setup. It was already this page's
recommendation, and it is what the web UI posts, so it is the only first-run path with a caller.

**What happened, because the order matters if you are reading an older build's docs.** The `/setup` MOUNT was
removed first: Express matches a mount before the SPA's index fallback, so mounting the setup router at
`/setup` as well as `/api/setup` made the web UI's own first-run page unreachable. The form was the live entry
point and the SPA page had never served one. 4.0 then removed the form itself, its `POST` handler and the
error page that linked back to `/setup`.

If you automated against `POST /setup` with form-encoded `label`, switch to `POST /api/setup/json` with a JSON
body. It takes the same label — and now bounds it at 100 characters, matching the web UI's own input, which
the form handler enforced and the JSON one did not.

### Complete Setup (JSON)

```http
POST /api/setup/json
```

```json
{
  "label": "My Ythril"
}
```

The `label` names this brain instance.

**Response** `201`:

```json
{
  "token": { "id": "...", "name": "Admin", "admin": true, ... },
  "plaintext": "ythril_initialAdminToken..."
}
```

---
