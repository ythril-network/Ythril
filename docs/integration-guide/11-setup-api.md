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

`/ready` and the instance's own search watcher agree: when the search probe here succeeds, the watcher that finds a late `mongot` is told at once and the spaces waiting for search are resumed. A failed probe here never marks search as down, because this route is public and unauthenticated; only the watcher decides that. Concurrent requests share one probe.

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
| `ythril_embedding_duration_seconds` | histogram | Time to compute a single embedding vector. For the bundled model this is the inference process's own timing of the inference, so **it does not include the time a request queued** for it (that is `ythril_embed_wait_seconds`); a busy queue does not read as a slow model. For an HTTP endpoint it is the whole request, retries included. |
| `ythril_embedding_queue_depth` | gauge | Pending embedding operations |
| `ythril_embed_wait_seconds` | histogram | How long a request for the **bundled** embedding model waited in the queue before it was sent to the embedding process. The inference process runs one embed at a time, so this is where a bulk import or a large document shows up, and a recall query goes ahead of queued documents. Not recorded for an HTTP endpoint. |
| `ythril_embed_process_restarts_total` | counter | Times the bundled embedding process was replaced, labelled by `reason`: `exit` (it ended on its own), `killed` (a signal, for instance the out-of-memory killer), `deadline` (it stopped answering and was killed), `idle` (it was ended after ten idle minutes, which is normal and returns its memory), `model-change` (the model or an offline flag changed). A rising `exit`, `killed` or `deadline` count is a crashing or wedged model; the server keeps running and replaces it with a growing delay. |
| `ythril_embed_process_state` | gauge | State of the bundled embedding process: `0` none (not started yet, or ended idle), `1` starting (loading the model), `2` ready, `3` backoff (lost, waiting before it is replaced; requests fail at once meanwhile). Its memory is not in the server's process metrics: watch the container. |
| `ythril_embedding_retry_total` | counter | Transient embedding-endpoint refusals that were retried, labelled by HTTP `status`. A rising 429 count means a shared endpoint is at capacity while recalls are still succeeding — the retry hides the symptom, so this is the warning. |
| `ythril_seq_horizon_oldest_hold_seconds` | gauge | Per `space`: how long the space's oldest open seq hold has been held, `0` when it holds none. While a write holds its sequence number, every seq-paged reader of the space — a peer's pull above all — is served nothing past it, so a value that keeps growing is replication of that space standing still. A hold is bounded (`YTHRIL_HOLD_DEADLINE_MS`), so alert on it staying above a few seconds; one older than half the bound is also named in the server log |
| `ythril_file_tombstone_oldest_hold_seconds` | gauge | Per `space`: how long the space's oldest open file-tombstone position hold has been held, `0` when it holds none. While a deletion's tombstone is being stored, no page of the space's file tombstones — served to a peer or pushed — and no prune goes past its position, so a value that keeps growing means the space's file deletions are not reaching peers. Bounded by the same `YTHRIL_HOLD_DEADLINE_MS`; one older than half the bound is named in the server log (`file tombstone position held …`) |
| `ythril_reindex_in_progress` | gauge | Number of spaces with a reindex run going (0 when none). It was 0 or 1 while one reindex ran per instance; alert on `> 0`, not `== 1`. It keeps its last value while any space could not be read (a failed read says so in the server log) rather than reporting `0` for a space it could not see |
| `ythril_housekeeping_space_failures_total` | counter | Background housekeeping steps that failed for a space, or stopped, by `step` (the name the step's server-log line carries) and `kind`: `failure` (the space's own error), `timeout` (a database operation ended by `YTHRIL_HOUSEKEEPING_OP_TIMEOUT_MS`), `store_down` (the step stopped because the database is not answering) and `stalled` (the step stopped because several spaces in a row timed out). Counted on **every** failure, whether its log line was said or held back, so a failure that repeats is a rate here and one line there. Every step's four series report `0` from process start. See [Background jobs and the spaces they walk](#background-jobs-and-the-spaces-they-walk) |
| `ythril_housekeeping_records_failed_total` | counter | Records a step could not delete or process, by `step` — a count of records, not of cycles. The retention sweep skips a record it cannot delete and reports it here with its count, instead of letting it hold up the others; a rate above `0` for a step that was working is the record to look for. Reports `0` from process start |
| `ythril_interval_tick_skipped_total` | counter | Ticks of a repeating background job that were skipped because the previous tick was still running, by `job` — the job's own name, the one its log lines carry: `TTL sweep`, `Candidate prune`, `Tombstone prune`, `Stale chunk cleanup`, `Audit change retention`, `Invite session purge`, `Space activity flush`, `Seq hold watchdog`, `Webhook retry poll`, `Reindex watcher`, `Brain embedding heartbeat`, `Brain embedding stall sweep`, `Media stall sweep` and `Media provider refresh`. A job that skips one tick now and then is slow, one that skips every tick is stuck. Every job reports `0` from process start |
| `ythril_housekeeping_quarantined_spaces` | gauge | Spaces background jobs are passing over right now because a database operation on them timed out; `0` when none. A space leaves quarantine when its wait is over and the next attempt succeeds, or at once, for one attempt, when new work is queued for it. **Alert on it staying above `0`**: that space's housekeeping is not running |
| `ythril_storage_used_bytes` | gauge | Storage used in bytes by area (brain, files, total). **From a cached measurement, not re-walked per scrape** — see `ythril_storage_usage_age_seconds` below and the note on why. |
| `ythril_storage_limit_bytes` | gauge | Configured storage limits by area and tier (soft, hard) |
| `ythril_auth_attempts_total` | counter | Auth attempts by result (success, invalid) |
| `ythril_tokens_active` | gauge | Number of active (non-expired) tokens |
| `ythril_tool_calls_total` | counter | Tool invocations by tool name, space and `door` (`mcp` or `rest`). A call naming an unknown tool is refused before it is counted, so the `tool` label only ever holds a real tool's name |
| `ythril_tool_validator_cache_total` | counter | Tool-argument validator lookups by `result`: `hit`, `miss` (one built for a reach not seen before) or `evict` (the oldest dropped to stay inside 64). A validator is built once per set of spaces a token reaches, so a steady `evict` rate means more distinct reaches are in rotation than the cache holds and calls are paying the build cost again |
| `ythril_sync_cycles_total` | counter | Sync cycles by `network` and `status` — `success`, `partial`, `error`. |
| `ythril_sync_items_pulled_total` | counter | Items received by `type` — `facts`, `entities`, `edges`, `files`, `chrono`. |
| `ythril_sync_items_pushed_total` | counter | Items sent by `type` — same set as pulled. |
| `ythril_sync_duration_seconds` | histogram | Time per sync cycle |
| `ythril_sync_tombstones_applied_total` | counter | Deletions a peer sent that this instance applied, by `kind` (the record type, `file` for a file tombstone) and `ground`: `issuer` (the issuer delivered it and wrote the record) or `upstream` (this instance's publisher or parent delivered it and delivered the record; whoever wrote it). **A rate on `ground="upstream"` is deletions that came down from above**, which is the one to watch on a subscriber. Every series reports `0` from process start |
| `ythril_sync_tombstones_declined_total` | counter | Deletions a peer sent that this instance judged it may not apply, by `kind` and `reason`: `not_author` (the issuer delivered it itself, but did not write the record), `not_upstream` (this instance's upstream delivered it, for a record the upstream did not deliver or one this instance wrote) or `not_issuer` (any other case, such as a peer delivering a tombstone another instance issued). **On a mesh a steady rate is normal**, since every instance pushes every issuer's tombstones and a peer applies only the ones it may; on a pub/sub or tree network below an upstream it means a deletion did not reach a record. Counted on every decline, whether its log line was said or held back. Every series reports `0` from process start |
| `ythril_sync_tombstone_rereads_owed` | gauge | How many one-time re-reads of an upstream's tombstones this instance still owes after an upgrade, one per upstream and space. It is the one-time repair of deletions an upstream sent that this instance had declined; `0` when none, and it falls as each finishes. **A value that stays above `0` across several sync cycles means a re-read is stopped** (the cause is named once in the server log) and deletions the upstream already sent are still not applied here. A re-read is also owed again after a counter wipe, which is harmless |
| `ythril_recall_degraded_total` | counter | Recalls answered with a **weaker pipeline than configured**, by `reason`. `rerank_unavailable` = the cross-encoder is configured but did not answer, or is cooling down after failing or crawling; `rerank_skipped_budget` = it was not attempted because the end-to-end `RECALL_BUDGET_MS` was already spent upstream. **This is the one to alert on**: these paths return HTTP 200 with a worse ranking, so they raise no error rate and barely move latency — a reranker down for a week is otherwise invisible. `search_timeout` = a collection's search hit the recall's deadline, so the answer is partial; `filter_window` = a filtered answer could not be completed and may be missing matching records; `candidate_cap` = `topK` passed the 2000-per-type bound and a type filled it. Every series reports `0` from process start, so absent-vs-zero is never ambiguous. |
| `ythril_recall_fresh_scan_capped_total` | counter | Fresh-write scans whose window held more records than `DUPE_FRESH_SCAN_CAP`, so the oldest of them were not compared — a just-written record the index has not ingested may then be missing from a search or a duplicate check. Zero means the cap has never cut a window off; a steady rate means raise `DUPE_FRESH_SCAN_CAP` for this write rate. |
| `ythril_recall_fresh_writes_found_total` | counter | Records returned by recall that the **vector index had not yet ingested** — the scan that finds them runs on every recall since 5.0, so this counts real index lag rather than how often a flag was set. Deliberately not a `reason` on the degraded counter: finding more than the index could offer is the opposite of degradation. What it is for is making the index lag measurable instead of anecdotal; zero means the index is keeping up with writes on this instance. |
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
| `ythril_config_reload_pending` | gauge | `1` while a config reload was **refused** and the running configuration is therefore older than the file on disk, `0` otherwise. **This is the one to alert on.** The server watches `config.json` and reloads a couple of seconds after it changes; a reload that fails — a half-written file, invalid JSON — is caught by the watcher and logged, and there is no caller to return a status to. The watcher also claims the file's modification time *before* reloading, so broken bytes are not retried every tick, which means a failed watched reload **is never retried on its own**: the edit sits out of effect until the file is written again or the instance restarts. Any reload that succeeds clears this. `POST /api/admin/reload-config` answers a refusal itself (`500`, or `503` with `Retry-After` when the database could not answer) and moves this gauge and the counter below the same way: **a reload is refused while a space it added is still not initialised**, and the gauge stays at `1` until a reload applies everything. |
| `ythril_config_reload_failed_total` | counter | Config reloads refused, cumulative — by the file watcher or by `POST /api/admin/reload-config`. The history beside the gauge above: the gauge says whether it is true now, this says whether it has been happening. Reports `0` from process start. |
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
logged mid-request, the 507 a quota refused with, not only an unhandled crash. Grep the id. A job or scheduled scan a
request merely started (the TTL sweep from the first-run setup, a scheduler a reload re-arms) logs without it.

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

#### Background jobs and the spaces they walk

The jobs that run on their own — the retention sweep, the embedding and media queue claims and their stall resets, the drains and prunes, the duplicate and contradiction scanners, the reindex resume, the suppression sweep, link conversion at boot — visit the spaces one at a time. **An error or a hang in one space does not stop the others**: the job reports that space and goes on with the next.

Two things do stop a pass early, and each says so. **The database is not answering**: a failure that is the database's condition ends the pass at once, and a bare timeout is first checked with a short ping, so one hung space is not mistaken for a dead database (and a dead one does not cost one timeout per space). **The database is stalled**: **3** spaces in a row timing out ends the pass for that tick.

Every database operation of such a job is ended by `YTHRIL_HOUSEKEEPING_OP_TIMEOUT_MS`, and a queue claim or a stall reset by a bound of its own, **10 s**, since one claim that waits longer than that is a database that is not answering. A space whose operation timed out is **put in quarantine** and passed over: a quarantine starts at **60 s** and doubles up to **300 s**, and ends when the space's next attempt succeeds. New work queued for the space lifts it at once, for one attempt.

**The log says each condition once, and the metrics count every one.** A job says one of three lines:

```text
<job> failed for space '<id>' (<part>): <reason> — retried <when>
<job> stopped: the store is not answering (<reason>) — retried next cycle
<job> stopped: <n> spaces timed out in a row; the store looks stalled — retried next cycle
```

`<job>` is the step's name (it is the `step` label of the failure counters), `(<part>)` is present when the job works in pieces and says which one failed (a collection, an upload, a half of the pass), `(count: N)` follows the reason when the line speaks for N records, and `<when>` is `next cycle`, `next tick`, `next boot`, `next reload`, `with the next meta write`, or `after quarantine (<n>s)` for a space that is in quarantine. A line is said once per **10 minutes** for a step, a space and a unit, again when the step has succeeded for the space in between, and again when a quarantine begins or doubles. `ythril_housekeeping_space_failures_total` and `ythril_housekeeping_records_failed_total` are counted on every failure whether the line was said or not, so a failure that repeats is a rate there.

A job whose previous tick is still running **skips** the next one rather than starting a second run, counts it in `ythril_interval_tick_skipped_total{job}` and says so in the log at most once in a while; an error that escapes a tick is logged as `<job> failed:` and the job keeps its schedule. What this does not cover, because it is not a database operation: index builds, the bulk link conversion, the metric collectors (they have their own scrape budget), walks of the file system, and calls to a model.

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
