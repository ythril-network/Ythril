/**
 * Prometheus metrics registry for Ythril.
 *
 * Defines and exports all application metrics collected by prom-client.
 * Default process metrics (CPU, fact, event loop lag, GC) are registered
 * automatically via `collectDefaultMetrics()`.
 *
 * Async gauges (brain counts, storage usage) use the `collect` callback to
 * query MongoDB / disk at scrape time so the data is always fresh.
 */

import {
  Registry,
  collectDefaultMetrics,
  Counter,
  Histogram,
  Gauge,
} from 'prom-client';
import { COLLECTION_SUFFIX, TOMBSTONE_TYPES } from '../config/types-knowledge.js';
import { POSTURE_LEVELS } from '../config/posture-levels.js';
import { DEGRADED_REASONS } from '../brain/degraded-reasons.js';
import { col, getMongo } from '../db/mongo.js';
import { isStoreUnreachable } from '../db/store-condition.js';
import { getConfig, getStorageConfig } from '../config/loader.js';
import { concreteSpaces } from '../spaces/proxy.js';
import { peekUsage, refreshUsageInBackground, usageMeasurementCount, usageIsComplete, USAGE_AREAS } from '../quota/quota.js';
import { spaceCollection } from '../db/space-collection.js';
import { oldestHoldAgeSeconds } from '../util/seq.js';
import { declaredJobs, declaredSteps, onHousekeepingSignal, type SpaceFailureKind } from '../util/housekeeping-signals.js';
import { log, peerList, peerText } from '../util/log.js';
import { SPACE_FAILURE_WINDOW_MS } from '../util/space-failure.js';
import { warnOnce } from '../util/warn-once.js';

export const register = new Registry();

// ── Default process metrics (CPU, fact, event loop lag, GC) ──────────────
collectDefaultMetrics({ register });

/**
 * How long each async collector takes, so a slow scrape names its own cause.
 *
 * ## Why this exists
 *
 * A canary operator measured `/metrics` hitting its **10-second Prometheus timeout** during an embedding run —
 * `up=0` for two windows, both inside the ingest, both recovering the moment the queue paused. And they took the
 * measurement that eliminates the obvious explanation, from the same scrape:
 *
 *     nodejs_eventloop_lag_mean_seconds   0.01006
 *     nodejs_eventloop_lag_p99_seconds    0.01025
 *     nodejs_eventloop_lag_stddev_seconds 0.00012
 *
 * 10 ms, flat. So this is **not** the event-loop starvation fixed in 2.2.3 — that would show there and does
 * not. A handler taking >10 s while the loop sits at 10 ms is a handler that is **awaiting**, not one hogging
 * the CPU. Their words, and the reason this is instrumentation rather than a guess.
 *
 * Every gauge below with an `async collect()` walks **every space** and queries per space — thirteen spaces on
 * their instance, several of those queries against `<space>_media_jobs`, which the embedding worker writes to
 * continuously. Any of them could own the ten seconds. We cannot reproduce their load, so the instance reports
 * it instead.
 *
 * **All nine are timed, including the ones not suspected.** Instrumenting only the suspects would make the
 * measurement agree with the hypothesis by construction — and the useful outcome is as likely to be "the one I
 * expected is fast" as a confirmation.
 *
 * Cheap by design: one histogram observation per collector per scrape, so a 30-second scrape interval is nine
 * observations every thirty seconds. The buckets run out to 15 s because the value worth seeing is the one past
 * the 10 s timeout — a histogram whose top bucket is below the failure cannot describe it.
 */
const collectDuration = new Histogram({
  name: 'ythril_metrics_collect_duration_seconds',
  help: 'Time for one async metric collector to gather its values, by collector (one observation per scrape)',
  labelNames: ['collector'] as const,
  buckets: [0.01, 0.05, 0.25, 1, 2.5, 5, 10, 15],
  registers: [register],
});

/**
 * Every collector that gathers asynchronously and is therefore subject to the budget below.
 *
 * Named in one place so the timeout counter can be pre-declared at zero for each of them — an absent series
 * and a zero one look identical on a graph and mean opposite things — and so a test can assert that no
 * `withCollectBudget` call site uses a name that is not on this list. A collector that timed out under a
 * name nobody enumerated would be invisible in exactly the situation this exists to make visible.
 */
export const TIMED_COLLECTORS = [
  'facts_total', 'entities_total', 'edges_total', 'chrono_entries_total', 'storage_used_bytes',
  'media_jobs_pending', 'media_jobs_processing', 'media_jobs_failed', 'media_job_phase',
] as const;

/**
 * ## Why these two carry a `collect()` that gathers nothing
 *
 * The same concurrency that makes one shared deadline correct breaks the *reporting* of a timeout, and it does
 * so silently. prom-client serialises each metric as soon as **its own** value is ready — one synchronous pass
 * starts every collector, then each is written out independently. So a counter that some *other* collector
 * increments is serialised at 0, before the timeout it is meant to record has even happened. The first version
 * of this change shipped that bug: the budget worked, the scrape returned fast, and both of these read 0.
 *
 * The fix is a barrier. `scrapeSettled()` holds these two until every budgeted collector in this scrape has
 * finished or been abandoned — bounded, because each of them is bounded by the budget.
 *
 * **This is why the two are not simply set from `endScrape()`.** That runs after serialisation, so the flag
 * would describe the *previous* scrape: an alert permanently one scrape behind, firing after recovery and
 * silent during the incident.
 */
export const collectTimeoutsTotal = new Counter({
  name: 'ythril_metrics_collect_timeouts_total',
  help: 'Collectors abandoned mid-scrape because the scrape budget ran out, by collector',
  labelNames: ['collector'] as const,
  registers: [register],
  async collect() { await scrapeSettled(); },
});
for (const name of TIMED_COLLECTORS) collectTimeoutsTotal.labels({ collector: name }).inc(0);

/**
 * Whether the scrape being served right now had to abandon anything.
 *
 * It exists because the degradation must be alertable: an operator who cannot tell a complete scrape from a
 * partial one has traded a loud failure for a quiet wrong answer, which is worse.
 */
export const metricsScrapeDegraded = new Gauge({
  name: 'ythril_metrics_scrape_degraded',
  help: '1 if this scrape abandoned at least one collector to stay inside its budget, else 0',
  registers: [register],
  async collect() { await scrapeSettled(); },
});
metricsScrapeDegraded.set(0);

/**
 * ## The scrape budget
 *
 * The canary measured `/metrics` exceeding its **10 s Prometheus timeout** during an ingest, and the
 * consequence is out of proportion to the cause: a slow scrape does not lose the slow collector, it sets
 * `up=0` and **drops every series from the target** — HTTP latency, event-loop lag, embed throughput, all of
 * it, including the series that would explain the outage. Their framing, and it is correct.
 *
 * So the scrape gets a deadline it is guaranteed to return inside. A collector that cannot finish in time is
 * abandoned: its series are dropped for that scrape, the timeout is counted against its name, and
 * `ythril_metrics_scrape_degraded` goes to 1. Everything else is served normally, and `up` stays 1.
 *
 * **Why the collector is abandoned rather than left holding its last values.** Stale numbers presented as
 * current are indistinguishable from a healthy flat line — the operator would read "storage is steady" from a
 * collector that has not answered in an hour. A gap is honest and a gap is what the canary explicitly asked
 * for. Same reason the counters here are pre-declared at zero: absent must not be confusable with fine.
 *
 * **8 seconds by default**, under the Prometheus default of 10 with room for serialisation and transfer. Set
 * `METRICS_SCRAPE_BUDGET_MS` to change it, or to `0` to disable the budget and restore the old
 * all-or-nothing behaviour.
 *
 * **Concurrency is what makes one shared deadline correct.** prom-client 15 collects with `Promise.all`, so
 * the nine collectors run at once and the scrape costs the slowest one, not the sum. A per-collector budget
 * would have to be one-ninth as generous to give the same guarantee.
 */
export const DEFAULT_SCRAPE_BUDGET_MS = 8000;

const SCRAPE_BUDGET_MS = (() => {
  const raw = process.env['METRICS_SCRAPE_BUDGET_MS']?.trim();
  if (!raw) return DEFAULT_SCRAPE_BUDGET_MS;
  const n = Number(raw);
  // A malformed value must not silently disable the guard, so it falls back rather than becoming 0.
  if (!Number.isFinite(n) || n < 0) return DEFAULT_SCRAPE_BUDGET_MS;
  return n;
})();

/**
 * The budget this process resolved at load, in ms. `0` means disabled.
 *
 * Exported because the fallback is only testable as a **choice**, not as an effect: a malformed value falling
 * back to 8000 and a malformed value becoming 0 both let a fast collector finish, so every effect-based
 * assertion passes either way. A mutation that turned the fallback into `0` — silently disabling the guard on a
 * typo'd env var — survived the first version of that test for exactly this reason.
 */
export function scrapeBudgetMs(): number {
  return SCRAPE_BUDGET_MS;
}

/** Monotonic — `performance.now()` rather than `Date.now()`, so an NTP correction cannot expire a budget. */
let scrapeDeadline = 0;
let scrapesInFlight = 0;

/**
 * One entry per budgeted collector in the scrape being served, resolving when it finishes or is abandoned.
 *
 * `scrapeSettled()` waits on these so the two reporting metrics describe *this* scrape. Never rejects — each
 * entry is resolved from a `finally`.
 */
let collectorsThisScrape: Array<Promise<void>> = [];

/**
 * Open a scrape window. Called by the `/metrics` handler; safe to nest.
 *
 * Overlapping scrapes are not what Prometheus does with one target, but a second Prometheus or a curl by hand
 * can produce them. A later window therefore **extends** the deadline and never shortens it: a scrape already
 * running must not have its budget cut by one that started after it.
 *
 * The window bookkeeping runs even when the budget is disabled, so the collector list cannot accumulate.
 */
export function beginScrape(): void {
  if (scrapesInFlight === 0) {
    metricsScrapeDegraded.set(0);
    collectorsThisScrape = [];
  }
  scrapesInFlight++;
  if (SCRAPE_BUDGET_MS === 0) return;
  const deadline = performance.now() + SCRAPE_BUDGET_MS;
  if (deadline > scrapeDeadline) scrapeDeadline = deadline;
}

/** Close a scrape window. Must run on the failure path too, or the deadline leaks into the next scrape. */
export function endScrape(): void {
  scrapesInFlight = Math.max(0, scrapesInFlight - 1);
  if (scrapesInFlight === 0) {
    scrapeDeadline = 0;
    collectorsThisScrape = [];
  }
}

/**
 * Resolve once every budgeted collector in this scrape has finished or been abandoned.
 *
 * The single `await` before reading the list is load-bearing, not defensive. prom-client starts every metric's
 * `collect()` in one synchronous pass, so yielding exactly one microtask is both necessary — the list is still
 * being filled — and sufficient: the pass cannot still be running once microtasks get to run.
 *
 * `allSettled` rather than `all`: a reporting metric that rejects would turn a partial scrape into a 500, which
 * is the failure this whole change exists to prevent.
 */
async function scrapeSettled(): Promise<void> {
  await Promise.resolve();
  await Promise.allSettled(collectorsThisScrape);
}

/** Milliseconds left in the current scrape, or Infinity when no budget applies. */
function budgetRemaining(): number {
  return scrapeDeadline === 0 ? Infinity : scrapeDeadline - performance.now();
}

const EXPIRED = Symbol('collector-budget-expired');

/**
 * Time one collector and hold it to the scrape budget.
 *
 * `work` keeps its own error handling contract: a collector that throws (MongoDB not ready at startup is the
 * normal case) keeps its previous values, exactly as before this change. Only a **timeout** abandons them,
 * because only a timeout means the value is unknown rather than momentarily unavailable.
 *
 * A query that lands after its budget still completes and still writes; those values simply belong to
 * whichever scrape is serialising when they arrive. That is not worth machinery to prevent — late-but-real is
 * a better outcome than dropped-and-refetched.
 *
 * **Every async collector in this file must go through this**, and `scrape-budget.test.js` fails the build if one
 * does not. A collector that awaits outside the budget re-creates the exact `up=0` the canary reported, and it
 * would do so silently — the scrape would simply get slow again with nothing naming the cause.
 *
 * Exported for that test, which needs a collector it can make arbitrarily slow. The nine real ones finish
 * instantly without a database, so the mechanism is not otherwise reachable offline.
 */
export async function withCollectBudget(
  collector: string,
  work: () => Promise<void>,
  abandon: () => void,
): Promise<void> {
  const done = collectDuration.startTimer({ collector });

  // Register with this scrape SYNCHRONOUSLY, before the first await. The Promise executor runs immediately, so
  // `release` is assigned during prom-client's synchronous collect() pass — which is what makes the one-microtask
  // barrier in scrapeSettled() sound.
  let release!: () => void;
  collectorsThisScrape.push(new Promise<void>(resolve => { release = resolve; }));

  try {
    const remaining = budgetRemaining();
    if (remaining === Infinity) {
      await work().catch(() => { /* collector failure keeps last values, as before */ });
      return;
    }
    if (remaining <= 0) {
      // The budget was gone before this collector even started — still a timeout, still its own fault to own.
      overBudget(collector, abandon);
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expiry = new Promise<typeof EXPIRED>(resolve => {
      timer = setTimeout(() => resolve(EXPIRED), remaining);
      // Never let a metrics budget hold the process open on shutdown.
      timer.unref?.();
    });
    try {
      const outcome = await Promise.race([
        work().then(() => null, () => null),
        expiry,
      ]);
      if (outcome === EXPIRED) overBudget(collector, abandon);
    } finally {
      if (timer) clearTimeout(timer);
    }
  } finally {
    done();
    release();
  }
}

function overBudget(collector: string, abandon: () => void): void {
  collectTimeoutsTotal.labels({ collector }).inc();
  metricsScrapeDegraded.set(1);
  abandon();
}

/** Said once per collector per window, and said again once the collector has read every space (`collectEachSpace`). */
const collectorFailureSaid = warnOnce<string>({ max: 64, every: SPACE_FAILURE_WINDOW_MS });

/** Whether the store was ever connected: `getMongo()` throws before `connectMongo()` has run, which is the normal start. */
function storeIsConnected(): boolean {
  try { getMongo(); return true; } catch { return false; }
}

/**
 * Read one value per space for a gauge, each space on its own: **one space that cannot be read does not stop the others.**
 *
 * ## What it prevents
 *
 * Every per-space collector walked the spaces inside one `try`. The first space whose collection could not be read threw, the
 * budget wrapper swallowed it ("a collector that throws keeps its previous values"), and every space AFTER it kept a value
 * from the last scrape that worked — stale, unmarked, and indistinguishable from a current one. A space that fails is that
 * space's problem; it must not become every later space's blank.
 *
 * ## What it does
 *
 *  - a space that fails KEEPS its last value (the contract a whole collector always had: a failure is "unknown for now", and
 *    only a TIMEOUT, in `withCollectBudget`, drops values), and the others are read;
 *  - the failure is said ONCE per collector per window, in ONE line naming every space it could not read, at warn — the store
 *    answered everything else, so it is news. A different set of failed spaces is news again; and a pass that read every
 *    space forgets the condition, so a space that fails again is said again;
 *  - **a store that cannot be reached stops the collector at once, at debug.** That is the normal start (the first scrape can
 *    come before the store is connected) and the store being down is already everyone's alert; one line per space per scrape
 *    for a store that is not there is noise that hides the line that matters. It is asked of the store (the driver's class,
 *    labels or the server's code, `db/store-condition.ts`, or no connection yet) and never of the error's wording;
 *  - it never throws: the whole point is that `read` failing is not the collector's failure.
 *
 * ## What it does not do
 *
 * It does not bound the reads. A collector is held to the SCRAPE budget (`withCollectBudget`), which abandons the WAIT: an
 * operation still in flight runs on to the driver's own limits, and a value it writes later belongs to whichever scrape is
 * serialising then. That is not the housekeeping bound (`db/write-bound.ts`), which a background walk carries and a scrape does
 * not — a collector's own deadline is the budget's, so it stays outside the bound on purpose (`Q-358`).
 *
 * `spaces` is a parameter so a test can hand it a list; every caller leaves it at the concrete spaces.
 */
export async function collectEachSpace(
  collector: string,
  read: (spaceId: string) => Promise<void>,
  spaces: ReadonlyArray<{ id: string }> = concreteSpaces(),
): Promise<void> {
  const failed: string[] = [];
  let firstFailure: unknown;
  for (const { id } of spaces) {
    try {
      await read(id);
    } catch (err) {
      if (isStoreUnreachable(err) || !storeIsConnected()) {
        log.debug(`Metrics collector '${peerText(collector)}' stopped: the store is not answering`);
        return;
      }
      if (failed.length === 0) firstFailure = err;
      failed.push(id);
    }
  }
  if (failed.length === 0) {
    collectorFailureSaid.forget(collector);
    return;
  }
  collectorFailureSaid(collector, () => {
    log.warn(
      `Metrics collector '${peerText(collector)}' could not read space ${peerList(failed.map(id => `'${peerText(id)}'`))}: `
      + `${peerText(firstFailure)} — ${failed.length === 1 ? 'its' : 'their'} previous value is kept, the other spaces were read`,
    );
  }, failed.join('\0'));
}

// ── Housekeeping (what a background walk says is countable, `util/housekeeping-signals.ts`) ──────────────────────────

/**
 * The kinds a failure is counted under, as a record so a kind added to `SpaceFailureKind` that is not named here is a type
 * error: a kind that is not pre-declared would be a series that appears only at its first event.
 */
const FAILURE_KIND_SERIES: Record<SpaceFailureKind, true> = { failure: true, timeout: true, store_down: true, stalled: true };
export const HOUSEKEEPING_FAILURE_KINDS = Object.keys(FAILURE_KIND_SERIES) as SpaceFailureKind[];

/**
 * How often a housekeeping step failed for a space, or stopped. `failure` is a space's own, `timeout` a bound that ended an
 * operation, `store_down` a step that stopped because the store is not answering, `stalled` a step that stopped because
 * several spaces in a row timed out. Counted on every failure, whether its log line was said or throttled, so a failure that
 * repeats is a RATE here and one line there.
 */
export const housekeepingSpaceFailuresTotal = new Counter({
  name: 'ythril_housekeeping_space_failures_total',
  help: 'Housekeeping steps that failed for a space or stopped, by step and kind (failure, timeout, store_down, stalled)',
  labelNames: ['step', 'kind'] as const,
  registers: [register],
});

/** Records a retention cycle could not delete (`Q-359`), by step: a count of records, not of cycles. */
export const housekeepingRecordsFailedTotal = new Counter({
  name: 'ythril_housekeeping_records_failed_total',
  help: 'Records a housekeeping step could not delete or process, by step',
  labelNames: ['step'] as const,
  registers: [register],
});

/** A repeating job that found its previous tick still running and skipped this one, by job. */
export const intervalTickSkippedTotal = new Counter({
  name: 'ythril_interval_tick_skipped_total',
  help: 'Ticks of a repeating job skipped because the previous tick was still running, by job',
  labelNames: ['job'] as const,
  registers: [register],
});

/**
 * Spaces housekeeping is passing over right now because they timed out. Written by the walk's signal (an absolute count, not
 * an increment) and never by a collector, so it needs no scrape to be current. 0 when nothing is in quarantine.
 */
export const housekeepingQuarantinedSpaces = new Gauge({
  name: 'ythril_housekeeping_quarantined_spaces',
  help: 'Spaces housekeeping is currently passing over after they timed out',
  registers: [register],
});

/**
 * Start every series a step can move at 0: a counter that appears at its first event shows nothing for the whole healthy
 * period, and "absent" and "0" mean opposite things on a graph.
 */
function predeclareStep(step: string): void {
  for (const kind of HOUSEKEEPING_FAILURE_KINDS) housekeepingSpaceFailuresTotal.labels({ step, kind }).inc(0);
  housekeepingRecordsFailedTotal.labels({ step }).inc(0);
}

/** The same for a repeating job, which names itself at construction (`intervalJob` calls `declareJob`). A step is not a job. */
function predeclareJob(job: string): void {
  intervalTickSkippedTotal.labels({ job }).inc(0);
}

housekeepingQuarantinedSpaces.set(0);
// What was declared before this module was built is read; what is declared after arrives as a `*-declared` signal.
for (const step of declaredSteps()) predeclareStep(step);
for (const job of declaredJobs()) predeclareJob(job);

/** A count that may be added to a counter: a positive finite number. prom-client throws on anything else. */
const isCount = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0;

onHousekeepingSignal((event) => {
  switch (event.type) {
    case 'step-declared':
      predeclareStep(event.step);
      break;
    case 'job-declared':
      predeclareJob(event.job);
      break;
    case 'space-failure':
      housekeepingSpaceFailuresTotal.labels({ step: event.step, kind: event.kind }).inc();
      break;
    case 'records-failed':
      if (isCount(event.count)) housekeepingRecordsFailedTotal.labels({ step: event.step }).inc(event.count);
      break;
    case 'tick-skipped':
      intervalTickSkippedTotal.labels({ job: event.job }).inc();
      break;
    case 'quarantined-spaces':
      if (typeof event.count === 'number' && Number.isFinite(event.count) && event.count >= 0) housekeepingQuarantinedSpaces.set(event.count);
      break;
  }
});

// ── HTTP ────────────────────────────────────────────────────────────────────

export const httpRequestsTotal = new Counter({
  name: 'ythril_http_requests_total',
  help: 'Total HTTP requests by method, route pattern, and status code',
  labelNames: ['method', 'route', 'status_code'] as const,
  registers: [register],
});

export const httpRequestDurationSeconds = new Histogram({
  name: 'ythril_http_request_duration_seconds',
  help: 'HTTP request latency in seconds by method and route pattern',
  labelNames: ['method', 'route'] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [register],
});

export const httpRequestSizeBytes = new Histogram({
  name: 'ythril_http_request_size_bytes',
  help: 'HTTP request body size in bytes',
  labelNames: ['method', 'route'] as const,
  buckets: [0, 100, 1000, 10_000, 100_000, 1_000_000, 10_000_000],
  registers: [register],
});

export const httpResponseSizeBytes = new Histogram({
  name: 'ythril_http_response_size_bytes',
  help: 'HTTP response body size in bytes',
  labelNames: ['method', 'route'] as const,
  buckets: [0, 100, 1000, 10_000, 100_000, 1_000_000, 10_000_000],
  registers: [register],
});

// ── Brain data (gauges collected at scrape time) ────────────────────────────

/**
 * The four brain totals, counted the way a gauge can afford.
 *
 * These used `countDocuments({})`, which is an aggregation: an index scan of every entry per space, on
 * every scrape, forever. `estimatedDocumentCount()` reads the collection's own metadata in O(1).
 *
 * The exactness that buys does not survive contact with what a gauge IS. The value is sampled at scrape
 * time and stored as a point in a series — it is already stale when Prometheus writes it, and stale again
 * before it is graphed. So the scan was paying for a precision the metric cannot express. (The estimate can
 * drift from the true count after an unclean shutdown, until the next validate; the help text says so, which
 * is cheaper than an O(n) scan every fifteen seconds to avoid saying it.)
 */
export const factsTotal = new Gauge({
  name: 'ythril_facts_total',
  help: 'Approximate number of facts by space (collection metadata, not a scan)',
  labelNames: ['space'] as const,
  registers: [register],
  async collect() {
    await withCollectBudget('facts_total', () => collectEachSpace('facts_total', async (id) => {
      this.set({ space: id }, await col(spaceCollection(id, 'facts')).estimatedDocumentCount());
    }), () => this.reset());
  },
});

export const entitiesTotal = new Gauge({
  name: 'ythril_entities_total',
  help: 'Approximate number of entities by space (collection metadata, not a scan)',
  labelNames: ['space'] as const,
  registers: [register],
  async collect() {
    await withCollectBudget('entities_total', () => collectEachSpace('entities_total', async (id) => {
      this.set({ space: id }, await col(spaceCollection(id, 'entities')).estimatedDocumentCount());
    }), () => this.reset());
  },
});

export const edgesTotal = new Gauge({
  name: 'ythril_edges_total',
  help: 'Approximate number of edges by space (collection metadata, not a scan)',
  labelNames: ['space'] as const,
  registers: [register],
  async collect() {
    await withCollectBudget('edges_total', () => collectEachSpace('edges_total', async (id) => {
      this.set({ space: id }, await col(spaceCollection(id, 'edges')).estimatedDocumentCount());
    }), () => this.reset());
  },
});

export const chronoEntriesTotal = new Gauge({
  name: 'ythril_chrono_entries_total',
  help: 'Approximate number of chrono entries by space (collection metadata, not a scan)',
  labelNames: ['space'] as const,
  registers: [register],
  async collect() {
    await withCollectBudget('chrono_entries_total', () => collectEachSpace('chrono_entries_total', async (id) => {
      this.set({ space: id }, await col(spaceCollection(id, 'chrono')).estimatedDocumentCount());
    }), () => this.reset());
  },
});

export const spacesTotal = new Gauge({
  name: 'ythril_spaces_total',
  help: 'Number of configured spaces',
  registers: [register],
  collect() {
    try {
      const cfg = getConfig();
      this.set(cfg.spaces.length);
    } catch { /* ignore */ }
  },
});

// ── Embeddings ───────────────────────────────────────────────────────────────

export const embeddingDurationSeconds = new Histogram({
  name: 'ythril_embedding_duration_seconds',
  help: 'Time to compute a single embedding vector; for the local model the inference process times it, so queue wait is not included',
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [register],
});

export const embeddingQueueDepth = new Gauge({
  name: 'ythril_embedding_queue_depth',
  help: 'Number of pending embedding operations',
  registers: [register],
});

/**
 * Transient refusals from the embedding endpoint that we retried.
 *
 * A counter rather than nothing, because the retry makes the problem INVISIBLE by design: the recall now
 * succeeds, so the only trace that a shared endpoint is saturating is this. An operator whose embedder is at
 * capacity should be able to see it before it stops being transient.
 *
 * Labelled by status so 429 (busy) is distinguishable from 503 (down) — different problems with different
 * fixes, and averaging them into one number hides both.
 */
export const embeddingRetryTotal = new Counter({
  name: 'ythril_embedding_retry_total',
  help: 'Transient embedding-endpoint refusals that were retried, by HTTP status',
  labelNames: ['status'],
  registers: [register],
});

/**
 * The local embedding model runs in a supervised child process (Q-99 part 1). These three are what an operator reads to
 * see it: how often it was replaced and why, what it is doing now, and how long requests queued for it.
 *
 * The queue wait is its own histogram because `ythril_embedding_duration_seconds` is fed the inference process's own
 * timing: measured around the round trip it would absorb the wait behind other requests, and a busy queue would read
 * as a slow model.
 */
export const embedProcessRestartsTotal = new Counter({
  name: 'ythril_embed_process_restarts_total',
  help: 'Times the local embedding process was replaced, by reason: exit, killed, deadline, idle, model-change',
  labelNames: ['reason'],
  registers: [register],
});

const EMBED_PROCESS_STATE_CODE = { none: 0, starting: 1, ready: 2, backoff: 3 } as const;
let embedProcessPhase: () => keyof typeof EMBED_PROCESS_STATE_CODE = () => 'none';

/**
 * Where the state gauge reads from. `brain/local-inference.ts` sets it when it loads: the registry cannot import the
 * host, which imports the registry for its own counters. Until the host is loaded nothing has ever been started, which
 * is what the default answers. Read at scrape time and synchronously, so the collector has nothing to await.
 */
export function setEmbedProcessPhaseSource(read: () => keyof typeof EMBED_PROCESS_STATE_CODE): void {
  embedProcessPhase = read;
}

export const embedProcessState = new Gauge({
  name: 'ythril_embed_process_state',
  help: 'State of the local embedding process: 0 none, 1 starting, 2 ready, 3 backoff',
  registers: [register],
  collect() {
    this.set(EMBED_PROCESS_STATE_CODE[embedProcessPhase()]);
  },
});

/**
 * How long each space's oldest seq hold has been held (`Q-200`). A hold that does not end stops every seq-paged
 * reader of its space — a peer's pull is served nothing above it while each cycle reports success — and until this
 * nothing measured it. 0 for a space holding nothing; a deleted space's series goes with the space (rebuilt from
 * `concreteSpaces()` on every scrape). Read synchronously from `util/seq.ts`'s registry: nothing to await.
 */
export const seqHorizonOldestHoldSeconds = new Gauge({
  name: 'ythril_seq_horizon_oldest_hold_seconds',
  help: 'Age in seconds of the oldest open seq hold per space (0 when none); a growing value means replication of the space is held',
  labelNames: ['space'] as const,
  registers: [register],
  collect() {
    this.reset();
    for (const space of concreteSpaces()) this.set({ space: space.id }, oldestHoldAgeSeconds(space.id));
  },
});

export const embedWaitSeconds = new Histogram({
  name: 'ythril_embed_wait_seconds',
  help: 'Time a local embedding request waited in the queue before it was sent to the embedding process',
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60],
  registers: [register],
});

export const reindexInProgress = new Gauge({
  name: 'ythril_reindex_in_progress',
  help: 'Number of spaces with a reindex run going (0 when none)',
  registers: [register],
});

// ── Storage (collected at scrape time) ──────────────────────────────────────

/**
 * How stale the storage numbers are, in seconds.
 *
 * Shipped **with** the change that made the storage gauge read a cache instead of walking the disk, because a
 * cached value with no visible age is the failure mode the abandoned-collector decision in #676 was about:
 * numbers that look current and are not. An operator can alert on this if they care; nobody has to guess.
 */
export const storageUsageAgeSeconds = new Gauge({
  name: 'ythril_storage_usage_age_seconds',
  help: 'Age of the storage-usage measurement backing ythril_storage_used_bytes (it is cached, not re-walked)',
  registers: [register],
  // Reads the cache ITSELF rather than being written by the storage collector, and that is not a style choice.
  // prom-client serialises each metric as soon as its own value is ready, so a gauge written by a *different*
  // collector is emitted before that collector runs — the first version of this was set from
  // `storageUsedBytes.collect()` and a poison-sentinel test caught it reporting the sentinel, not the age. Same
  // trap as the timeout counter above, walked into a second time in the same file. Self-sufficient collectors are
  // the only order-independent kind.
  collect() {
    const peek = peekUsage();
    if (peek) this.set(peek.ageMs / 1000);
  },
});

/**
 * How many times the files tree has actually been walked.
 *
 * The operator-facing question this answers is "how often are we doing the expensive thing", and on a large
 * store the answer used to be *every scrape*. It also makes the refresh coalescing testable: the number of walks
 * is the only observable that distinguishes one guarded refresh from nine unguarded ones.
 */
export const storageUsageMeasurementsTotal = new Gauge({
  name: 'ythril_storage_usage_measurements_total',
  help: 'Completed walks of the files tree to measure storage usage since process start',
  registers: [register],
  collect() { this.set(usageMeasurementCount()); },
});

/**
 * Maximum age before a scrape kicks a background re-walk. Default 5 minutes.
 *
 * Generous on purpose. Stored volume is a slow-moving quantity, and during actual activity `checkQuota()`
 * refreshes the cache for free on every write — so this only governs how fresh the number is while the instance
 * is *idle*, which is exactly when it is least likely to have changed.
 */
const STORAGE_USAGE_MAX_AGE_MS = (() => {
  const raw = process.env['METRICS_STORAGE_USAGE_MAX_AGE_MS']?.trim();
  if (!raw) return 300_000;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return 300_000;
  return n;
})();

export const storageUsedBytes = new Gauge({
  name: 'ythril_storage_used_bytes',
  help: 'Storage used in bytes by area (brain, files, total) — from a cached measurement, see the age gauge',
  labelNames: ['area'] as const,
  registers: [register],
  async collect() {
    await withCollectBudget('storage_used_bytes', async () => {
      // Deliberately NOT `measureUsage()`. That walks the whole files tree, and the canary measured it at 22.150 s
      // mean against ~8.6 s for every MongoDB collector, taking down 10 of 20 scrapes on its own. See `peekUsage`
      // in quota.ts for the full numbers and why exactness is the wrong goal for a sampled gauge.
      const peek = peekUsage();
      if (peek) {
        const GiB = 1024 ** 3;
        this.set({ area: 'files' }, peek.usage.files * GiB);
        this.set({ area: 'brain' }, peek.usage.brain * GiB);
        this.set({ area: 'total' }, peek.usage.total * GiB);
        // the age gauge reads the cache itself — see its collect()
      }
      // Kick the walk, never await it: a scrape must not be able to block on filesystem I/O. On a cold instance
      // the first scrape carries no storage series and the second one does, which is honest — an absent series
      // says "not measured yet" where a zero would have claimed "empty".
      if (!peek || peek.ageMs > STORAGE_USAGE_MAX_AGE_MS) refreshUsageInBackground();
    }, () => this.reset());
  },
});

/**
 * Whether the last storage measurement could read everything it was asked to.
 *
 * ## Why a quota needs its own health signal
 *
 * `ythril_storage_used_bytes` is a floor whenever a directory could not be listed or `dbStats` was refused, and
 * a floor compared against a hard limit can only under-report — so a quota an operator configured silently
 * stops firing. Nothing in the storage series can express that: 0.4 GiB reads identically whether it is the
 * whole store or the part of it that was readable.
 *
 * **1 means the figures are whole; 0 means every storage series is a lower bound.** Alert on `== 0`. The reason
 * is not in the metric because a path is not a label value — it is in the WARN line the measurement logs, which
 * names what it could not read.
 *
 * Absent, like the storage series, until something has been measured. `reset()` is deliberately NOT used for
 * "unknown" here: a gauge reset reads as 0, and 0 is the alerting state.
 */
export const storageUsageComplete = new Gauge({
  name: 'ythril_storage_usage_complete',
  help: '1 when the last storage measurement read everything for this area; 0 when its figures are a floor',
  labelNames: ['area'] as const,
  registers: [register],
  collect() {
    const peek = peekUsage();
    if (!peek) return;
    for (const area of USAGE_AREAS) this.set({ area }, usageIsComplete(peek.usage, area) ? 1 : 0);
  },
});

export const storageLimitBytes = new Gauge({
  name: 'ythril_storage_limit_bytes',
  help: 'Configured storage limit in bytes by area and tier (soft, hard)',
  labelNames: ['area', 'tier'] as const,
  registers: [register],
  collect() {
    try {
      const GiB = 1024 ** 3;
      const storage = getStorageConfig();
      if (!storage) return;
      if (storage.total?.softLimitGiB != null) this.set({ area: 'total', tier: 'soft' }, storage.total.softLimitGiB * GiB);
      if (storage.total?.hardLimitGiB != null) this.set({ area: 'total', tier: 'hard' }, storage.total.hardLimitGiB * GiB);
      if (storage.files?.softLimitGiB != null) this.set({ area: 'files', tier: 'soft' }, storage.files.softLimitGiB * GiB);
      if (storage.files?.hardLimitGiB != null) this.set({ area: 'files', tier: 'hard' }, storage.files.hardLimitGiB * GiB);
      if (storage.brain?.softLimitGiB != null) this.set({ area: 'brain', tier: 'soft' }, storage.brain.softLimitGiB * GiB);
      if (storage.brain?.hardLimitGiB != null) this.set({ area: 'brain', tier: 'hard' }, storage.brain.hardLimitGiB * GiB);
    } catch { /* ignore */ }
  },
});

// ── Authentication ───────────────────────────────────────────────────────────

export const authAttemptsTotal = new Counter({
  name: 'ythril_auth_attempts_total',
  help: 'Authentication attempts by result (success, invalid, expired)',
  labelNames: ['result'] as const,
  registers: [register],
});

export const tokensActive = new Gauge({
  name: 'ythril_tokens_active',
  help: 'Number of active (non-expired) tokens',
  registers: [register],
  collect() {
    try {
      const cfg = getConfig();
      const now = new Date();
      const active = cfg.tokens.filter(
        t => !t.expiresAt || new Date(t.expiresAt) > now,
      ).length;
      this.set(active);
    } catch { /* ignore */ }
  },
});

// ── MCP ──────────────────────────────────────────────────────────────────────

/*
 * `ythril_mcp_connections_active` was here, and it is REMOVED in 4.0 rather than kept at zero.
 *
 * It counted open MCP SSE streams, incremented on connect and decremented on close. SSE is gone, and
 * streamable HTTP is stateless — one POST per call, nothing to hold open — so there is no such thing as an
 * active MCP connection to count.
 *
 * A gauge left in place would have read 0 forever. That is the failure mode worth naming: 0 is a PLAUSIBLE
 * value, so a dashboard panel and an alert threshold both keep working and both keep saying no MCP client is
 * connected while every client on the instance is busy. An absent metric is a question an operator asks
 * once; a gauge that is confidently wrong is one nobody asks at all.
 *
 * `ythril_tool_calls_total` is the signal that survives, and it was always the better one — it counts
 * work rather than sockets.
 */

/**
 * Tool invocations, whichever door they arrived at.
 *
 * **Renamed from `ythril_mcp_tool_calls_total` at 5.0, and the rename is the point rather than tidying.**
 * Every tool is also `POST /api/<tool-name>` now, and both doors dispatch through one function — so a
 * counter with `mcp` in its name was about to start counting HTTP calls under a label that says otherwise.
 * An operator reading "MCP tool invocations" off a dashboard would have drawn a conclusion about agent
 * traffic from a number that includes a browser, with nothing anywhere to contradict it.
 *
 * `door` is what makes the old question still answerable: `sum by (door)` separates them, and filtering
 * `door="mcp"` gives exactly what the old counter meant.
 */
export const toolCallsTotal = new Counter({
  name: 'ythril_tool_calls_total',
  help: 'Tool invocations by tool name, space and door (mcp or rest)',
  labelNames: ['tool', 'space', 'door'] as const,
  registers: [register],
});

/**
 * Tool-argument validators found (`hit`), built (`miss`) or dropped to stay inside the bound (`evict`) — `Q-114`.
 * A validator is built once per reach a token can see; a rising `evict` rate means more distinct reaches are in
 * rotation than the cache holds, so calls are paying the build cost again.
 */
export const toolValidatorCacheTotal = new Counter({
  name: 'ythril_tool_validator_cache_total',
  help: 'Tool-argument validator cache lookups by result (hit, miss, evict)',
  labelNames: ['result'] as const,
  registers: [register],
});

// ── Sync ─────────────────────────────────────────────────────────────────────

export const syncCyclesTotal = new Counter({
  name: 'ythril_sync_cycles_total',
  help: 'Sync cycles by network and status (success, partial, error)',
  labelNames: ['network', 'status'] as const,
  registers: [register],
});
// Pre-initialise so HELP/TYPE lines appear in /metrics from startup
// (labelled counters are invisible until first .inc() in prom-client)
syncCyclesTotal.labels({ network: '', status: 'success' }).inc(0);

export const syncItemsPulledTotal = new Counter({
  name: 'ythril_sync_items_pulled_total',
  help: 'Items received during sync by type (facts, entities, edges, files, chrono)',
  labelNames: ['type'] as const,
  registers: [register],
});

export const syncItemsPushedTotal = new Counter({
  name: 'ythril_sync_items_pushed_total',
  help: 'Items sent during sync by type (facts, entities, edges, files, chrono)',
  labelNames: ['type'] as const,
  registers: [register],
});

export const syncDurationSeconds = new Histogram({
  name: 'ythril_sync_duration_seconds',
  help: 'Time per sync cycle in seconds',
  labelNames: ['network'] as const,
  buckets: [0.1, 0.5, 1, 2.5, 5, 10, 30, 60],
  registers: [register],
});

/**
 * Peer tombstones that deleted something here, by what they deleted and on which ground (bundle-51, D-14).
 *
 * `kind` is a record type or `file`; `ground` is `issuer` (the delivering peer proved the issuer and the issuer wrote
 * the object, as always) or `upstream` (the deliverer is this space's upstream and relayed the object — the D-14
 * ground). The second is the number an operator watches after upgrading: every deletion a publisher caused here that
 * the old rule would have declined.
 */
export const syncTombstonesAppliedTotal = new Counter({
  name: 'ythril_sync_tombstones_applied_total',
  help: 'Peer tombstones that deleted a held object, by kind (record type or file) and ground (issuer, upstream)',
  labelNames: ['kind', 'ground'] as const,
  registers: [register],
});

/**
 * Peer tombstones this instance declined to apply, by kind and reason (`not_issuer`, `not_author`, `not_upstream`).
 *
 * A decline is a deletion that did not happen here, and a standing one is how a replica ends up holding what its source
 * deleted — so it is a series, not only a deduplicated log line. The reasons are the deletion authority's verdicts, one
 * set for records and files.
 */
export const syncTombstonesDeclinedTotal = new Counter({
  name: 'ythril_sync_tombstones_declined_total',
  help: 'Peer tombstones declined by the deletion authority, by kind (record type or file) and reason (not_issuer, not_author, not_upstream)',
  labelNames: ['kind', 'reason'] as const,
  registers: [register],
});

// Pre-declared, so a scrape before the first deletion reports 0 rather than nothing: absent and zero look identical on
// a graph and mean opposite things (`recallDegradedTotal`). The kinds are the tombstone types plus `file`, derived.
for (const kind of [...TOMBSTONE_TYPES, 'file']) {
  for (const ground of ['issuer', 'upstream']) syncTombstonesAppliedTotal.labels({ kind, ground }).inc(0);
  for (const reason of ['not_issuer', 'not_author', 'not_upstream']) syncTombstonesDeclinedTotal.labels({ kind, reason }).inc(0);
}

/**
 * One-time tombstone re-reads still owed: (upstream, space) pairs whose repair is not yet `'done'`.
 *
 * Counted from the config at scrape time through a provider, because the count needs the network model and this module
 * is imported by nearly every file (`setPostureProvider` below says why a provider and not an import). Unregistered it
 * reports 0, the honest answer for "nothing has been computed". A value that stays above zero is a repair that keeps
 * stopping; the log line says where.
 */
let rereadsOwedProvider: (() => number) | null = null;
export function setRereadsOwedProvider(fn: () => number): void {
  rereadsOwedProvider = fn;
}
export const syncTombstoneRereadsOwed = new Gauge({
  name: 'ythril_sync_tombstone_rereads_owed',
  help: 'Upstream tombstone re-reads (per upstream and space) not yet completed — the one-time repair of deletions declined before D-14',
  registers: [register],
  collect() {
    try {
      this.set(rereadsOwedProvider?.() ?? 0);
    } catch {
      this.set(0);   // A metrics scrape must never be the thing that fails.
    }
  },
});
syncTombstoneRereadsOwed.set(0);

// ── Media embedding ──────────────────────────────────────────────────────────
// Pipeline that converts image / audio / video into text → embedding vector.
// Counters are pre-initialised with `.inc(0)` so HELP/TYPE lines appear from
// startup even before the first job (matches the sync-metric convention).

export const mediaJobsCompletedTotal = new Counter({
  name: 'ythril_media_jobs_completed_total',
  help: 'Media embedding jobs that completed successfully, by space and media type',
  labelNames: ['space', 'media_type'] as const,
  registers: [register],
});
mediaJobsCompletedTotal.labels({ space: '', media_type: 'image' }).inc(0);

export const mediaJobsFailedTotal = new Counter({
  name: 'ythril_media_jobs_failed_total',
  help: 'Media embedding jobs that exhausted retries, by space and media type',
  labelNames: ['space', 'media_type'] as const,
  registers: [register],
});
mediaJobsFailedTotal.labels({ space: '', media_type: 'image' }).inc(0);

export const mediaJobsRetriedTotal = new Counter({
  name: 'ythril_media_jobs_retried_total',
  help: 'Media embedding jobs that failed an attempt and were re-queued, by space and media type',
  labelNames: ['space', 'media_type'] as const,
  registers: [register],
});
mediaJobsRetriedTotal.labels({ space: '', media_type: 'image' }).inc(0);

export const mediaJobDurationSeconds = new Histogram({
  name: 'ythril_media_job_duration_seconds',
  help: 'End-to-end processing time per media embedding job',
  labelNames: ['media_type'] as const,
  buckets: [0.5, 1, 2.5, 5, 10, 30, 60, 120, 300, 600, 1800],
  registers: [register],
});

export const mediaJobsPending = new Gauge({
  name: 'ythril_media_jobs_pending',
  help: 'Pending media embedding jobs by space (collected at scrape time)',
  labelNames: ['space'] as const,
  registers: [register],
  async collect() {
    await withCollectBudget('media_jobs_pending', () => collectEachSpace('media_jobs_pending', async (id) => {
      this.set({ space: id }, await col(spaceCollection(id, 'mediaJobs')).countDocuments({ status: 'pending' }));
    }), () => this.reset());
  },
});

export const mediaJobsProcessing = new Gauge({
  name: 'ythril_media_jobs_processing',
  help: 'In-flight media embedding jobs by space (collected at scrape time)',
  labelNames: ['space'] as const,
  registers: [register],
  async collect() {
    await withCollectBudget('media_jobs_processing', () => collectEachSpace('media_jobs_processing', async (id) => {
      this.set({ space: id }, await col(spaceCollection(id, 'mediaJobs')).countDocuments({ status: 'processing' }));
    }), () => this.reset());
  },
});

export const mediaJobsFailed = new Gauge({
  name: 'ythril_media_jobs_failed',
  help: 'Media embedding jobs in terminal failed state by space (collected at scrape time)',
  labelNames: ['space'] as const,
  registers: [register],
  async collect() {
    await withCollectBudget('media_jobs_failed', () => collectEachSpace('media_jobs_failed', async (id) => {
      this.set({ space: id }, await col(spaceCollection(id, 'mediaJobs')).countDocuments({ status: 'failed' }));
    }), () => this.reset());
  },
});

/**
 * Which phase the in-flight jobs are in, counted by step.
 *
 * `ythril_media_jobs_processing` already says a job is running, and that is where the diagnosis stopped: a
 * fleet with one 358 KB document saw `processing 1` for twenty minutes and could not tell reading from
 * embedding from wedged. The jobs themselves have carried a step report for a while — the worker writes it
 * with every heartbeat — so this is that field, aggregated. Nothing new is measured; something already
 * measured is finally reachable from a dashboard.
 *
 * `step` comes from the route the document is actually taking (`render`, `vlm`, `embed`, `describe`, …), so it
 * is not a closed list — but the known names are **seeded at zero** (`KNOWN_JOB_STEPS`) and any other step is
 * remembered the moment it is seen. Both halves matter: a series that disappears cannot be alerted on, and a
 * series that has never existed cannot be alerted on either, which is the case that bit a customer during
 * their first incident.
 */
/**
 * Step names seeded at zero from the first scrape, so the series exists before any job has been in them.
 *
 * "Remembered once seen" was not enough, and a customer proved it precisely: with
 * `ythril_media_jobs_processing = 3` during their first incident, `ythril_media_job_phase > 0` returned **an
 * empty result set** — no series at all. Twenty minutes later, queue drained, it returned the full grid at 0.
 *
 * *"The window where the metric is missing is the window where it is needed."* The first time anyone reaches
 * for this metric is the first incident, when by definition nothing has been seen yet. So the known step names
 * are pre-registered; a step outside this list still appears the moment it is observed.
 *
 * `unknown` is included on purpose: it is a real fallback (a processing job whose heartbeat predates the step
 * report, or one that has not reached its first step), and an operator seeing it needs to know it is expected
 * rather than a gap. A step name appearing that is NOT in this list means the pipeline gained a phase nobody
 * named here.
 */
export const KNOWN_JOB_STEPS = [
  'render', 'ocr', 'vlm', 'validate', 'repair', 'chunk', 'embed', 'describe', 'caption', 'transcribe', 'unknown',
] as const;

const _seenJobSteps = new Set<string>(KNOWN_JOB_STEPS);
export const mediaJobPhase = new Gauge({
  name: 'ythril_media_job_phase',
  help: 'In-flight media jobs by the pipeline step they are currently in (collected at scrape time)',
  labelNames: ['space', 'step'] as const,
  registers: [register],
  async collect() {
    await withCollectBudget('media_job_phase', () => collectEachSpace('media_job_phase', async (id) => {
      const rows = await col(spaceCollection(id, 'mediaJobs'))
        .find({ status: 'processing' }, { projection: { progress: 1 } })
        .toArray() as Array<{ progress?: { step?: string } }>;
      const counts = new Map<string, number>();
      for (const r of rows) {
        // A processing job with no step report is not "no jobs": it is a job whose phase predates the
        // heartbeat, or one that has not reached its first step yet. Both are visible as `unknown`.
        const step = r.progress?.step ?? 'unknown';
        counts.set(step, (counts.get(step) ?? 0) + 1);
      }
      for (const step of counts.keys()) _seenJobSteps.add(step);
      for (const step of _seenJobSteps) this.set({ space: id, step }, counts.get(step) ?? 0);
    }), () => this.reset());
  },
});

/**
 * Chunks embedded, as they are embedded.
 *
 * The signal a fleet actually needs is not "how many jobs are running" but "is this one moving". A gauge
 * cannot answer that; a counter can — `rate(ythril_embed_chunks_total[5m]) == 0` while
 * `ythril_media_jobs_processing > 0` is the difference between a slow document and a stuck one, and it was
 * exactly the question nobody could answer during a liveness crash loop.
 *
 * Counted per chunk regardless of whether the vector came out: a chunk that failed to embed still moved
 * the job forward, and `ythril_media_jobs_*` already carry the failure story.
 */
export const embedChunksTotal = new Counter({
  name: 'ythril_embed_chunks_total',
  help: 'Document chunks put through the embedder, by space (motion, not success)',
  labelNames: ['space'] as const,
  registers: [register],
});
embedChunksTotal.labels({ space: '' }).inc(0);

// ── Silent degradation ───────────────────────────────────────────────────────
/**
 * Recall answered, but with a weaker pipeline than the instance is configured for.
 *
 * Every other counter here measures work done or work failed. This one measures the gap between them:
 * the paths where nothing errors, the caller gets a 200, and the answer is quietly worse than it should
 * be. A reranker that has been unreachable for a week produces no failed requests, no error rate, no
 * change in latency worth noticing — every recall simply comes back in vector order and nobody is told.
 * The same is true of a space whose lexical index is missing, and of a rerank skipped because the
 * end-to-end budget had already been spent upstream.
 *
 * These already log a warning each. A log line is the right place to explain ONE occurrence and the
 * wrong place to notice a pattern — nobody greps a week of logs to discover that recall quality has been
 * degraded the whole time. A counter turns "is my reranker actually being used?" into a question the
 * operator can answer, and alert on.
 *
 * `reason` is a closed set, deliberately: an unbounded label is a cardinality bomb. The set is
 * `DEGRADED_REASONS` in `brain/degraded-reasons.ts`, and the series below are pre-declared from it:
 *  - `filter_window`         — a filtered answer could not be completed and may be missing matching records
 *  - `rerank_unavailable`    — configured, but it did not answer (unreachable, non-2xx, unreadable body)
 *  - `rerank_skipped_budget` — not attempted; the end-to-end budget was already spent (see RECALL_BUDGET_MS)
 *  - `search_timeout`        — one collection's vector search hit its `maxTimeMS` deadline, so the answer is
 *    partial. This one clears the bar the paragraph below sets: it is keyed on MongoDB error **code 50**
 *    (`MaxTimeMSExpired`), so it cannot fire for "this collection held nothing" the way a missing lexical
 *    channel would. A deadline the caller set is still degradation — they got less than the pipeline could
 *    have found — and it is counted so an operator can see a client's 5 s bound biting in aggregate rather
 *    than one warning line at a time.
 *
 * **A missing lexical channel is deliberately NOT counted here.** `applyLexicalFusion` cannot currently
 * tell "this space has no text index" from "the query matched nothing lexically" — both surface as an
 * empty result. Counting that would fire on ordinary queries and report degradation where there is none,
 * which is worse than not measuring it: a metric an operator learns to ignore is a metric that will not
 * be read on the day it matters. Wire it only once `lexicalSearch` distinguishes the two.
 */
/**
 * Records a recall returned that the vector index had NOT yet ingested.
 *
 * The scan that finds them runs on EVERY recall since 5.0, so this counts real index lag rather than how
 * often somebody set a flag — which is what makes zero meaningful. It is deliberately not a label on
 * `ythril_recall_degraded_total`: finding more than the index could offer is the opposite of degradation,
 * and that counter's reason set is closed on purpose.
 *
 * What it is for is making the index lag measurable instead of anecdotal. An integrator reported a record
 * invisible to recall for 150 seconds after writing it; every increment here is one record a plain recall
 * would have missed, so an operator can see whether that is happening on their instance and how often —
 * rather than hearing about it once from someone who happened to look.
 *
 * Zero is meaningful: it means the index is keeping up with writes on this instance.
 */
export const recallFreshWritesFoundTotal = new Counter({
  name: 'ythril_recall_fresh_writes_found_total',
  help: 'Records returned by recall that the vector index had not yet ingested',
  registers: [register],
});
recallFreshWritesFoundTotal.inc(0);

/**
 * Fresh-write scans whose window held more records than the scan's cap, so the oldest of them were not compared.
 *
 * The scan is what makes a record written a moment ago findable before the index ingests it (see
 * `brain/fresh-writes.ts`), and it reads only the newest `DUPE_FRESH_SCAN_CAP`. Past that, a just-written record
 * can be missing from a search or a duplicate check. That was a log line only — rate-limited now, because a busy
 * space hit it on every recall — so this is where an operator sees how often.
 *
 * Zero is meaningful: the cap has never cut a window off on this instance.
 */
export const recallFreshScanCappedTotal = new Counter({
  name: 'ythril_recall_fresh_scan_capped_total',
  help: 'Fresh-write scans whose window held more records than DUPE_FRESH_SCAN_CAP',
  registers: [register],
});
recallFreshScanCappedTotal.inc(0);

export const recallDegradedTotal = new Counter({
  name: 'ythril_recall_degraded_total',
  help: 'Recalls answered with a weaker pipeline than configured, by reason',
  labelNames: ['reason'] as const,
  registers: [register],
});
// Pre-declare every series so a scrape before the first degradation reports 0 rather than nothing at
// all — "absent" and "zero" look identical in a graph and mean opposite things.
for (const reason of DEGRADED_REASONS) {
  recallDegradedTotal.labels({ reason }).inc(0);
}

/**
 * Writes that overwrote a record another writer had changed since it was read — a LOST UPDATE.
 *
 * Brain records have no `If-Match` yet. `updateFact` reads, takes a seq at the write, and `$set`s only the fields
 * the caller supplied — so two clients editing DIFFERENT fields both succeed and lose nothing. What is exposed
 * is two clients editing the SAME field: the loser’s value disappears with a 200 and no trace anywhere.
 *
 * This exists because nobody knows how often that happens. The owner’s call was to measure before building the
 * mechanism, and it is the right order: several MCP agents against one space is the case that would produce
 * collisions, and it is also the case nobody has instrumented. A week of this says whether a 412 path is
 * urgent or theoretical.
 *
 * `collision` counts a detected overwrite; `clean` counts a write whose record had not moved. Both, so the
 * numerator has a denominator — "12 collisions" means nothing without "of how many writes".
 *
 * `refused` is the third outcome and means the opposite of the first: a write an `If-Match` precondition
 * STOPPED, so the overwrite did not happen. It is a separate series on purpose. Folding it into `collision`
 * would conflate a lost update with a prevented one, and would corrupt this very measurement — the
 * collision rate has been accumulating since the counter shipped, and a series whose meaning changes
 * halfway through cannot be compared with itself.
 */
export const brainWriteSeqTotal = new Counter({
  name: 'ythril_brain_write_seq_total',
  help: 'Brain record writes by whether the record changed between read and write (lost-update detection)',
  labelNames: ['collection', 'outcome'] as const,
  registers: [register],
});
// Pre-declared for the same reason as above: absent and zero look identical in a graph and mean opposites.
//
// All FOUR record types, because all four are now instrumented. #674 shipped `facts` alone while the
// metric was named for brain records generally, and the canary spotted the gap from the outside — they saw
// only `collection="facts"` and reasonably guessed the labels were lazy. Pre-declaring the other three
// without instrumenting them would have been the worse fix: a permanent 0 on entities reads as "no
// collisions here", which is the exact confusion pre-declaring exists to prevent.
// NOT ALL BRAIN COLLECTIONS: these are the collections whose writes go through the seq allocator, which is
// what a collision is measured against. `files` is absent because a file write is a blob plus a meta record
// and its collisions are a different question; `links` is absent because a colliding link is a DUPLICATE
// rather than a collision — two peers noticing the same connection have written the same fact, and the
// unique index in `lifecycle.ts` absorbs it. Pre-declaring a permanent 0 for either would read as "no
// collisions here", which is the exact confusion pre-declaring exists to prevent.
//
// DERIVED from `COLLECTION_SUFFIX`, which is exactly the knowledge types' collections — so the paragraph
// above is a description of what that map already contains rather than a second copy of it. Written out,
// a fifth record type would be instrumented by its writer and silently absent from this pre-declaration,
// and a graph would show nothing where it should show a zero.
for (const collection of Object.values(COLLECTION_SUFFIX)) {
  for (const outcome of ['clean', 'collision', 'refused']) {
    brainWriteSeqTotal.labels({ collection, outcome }).inc(0);
  }
}

// ── Security posture (observability audit, lens 9) ────────────────────────────

/**
 * The instance's own PASS/WARN/FAIL posture, countable.
 *
 * `computeSecurityPosture()` already produces this: it is printed once at boot and served on
 * `GET /api/about/security` (admin-only). Both are pull-only and human-shaped, which means a fleet learns
 * that an instance came up misconfigured by someone reading its boot log. On a five-instance fleet nobody
 * reads five boot logs, and the checks that matter most are exactly the ones that produce no runtime
 * symptom — `requireEncryptedTransport` off, or on WITHOUT `trustProxy`, which rejects every request.
 *
 * So the same finding set is a gauge, and an operator can alert on it:
 *
 *     ythril_security_posture_checks{level="fail"} > 0
 *
 * Computed at scrape time from the same function, never a second copy of the rules — a posture metric that
 * could disagree with the endpoint would be worse than no metric.
 *
 * Pre-declared for all three levels so a healthy instance reports `fail 0` rather than nothing: absent and
 * zero look identical in a graph and mean opposite things, which is the trap `recallDegradedTotal` above
 * documents one metric up.
 */
export const securityPostureChecks = new Gauge({
  name: 'ythril_security_posture_checks',
  help: 'Security-posture checks by level (pass/warn/fail) — alert on level="fail"',
  labelNames: ['level'] as const,
  registers: [register],
  collect() {
    try {
      const counts: Record<string, number> = { pass: 0, warn: 0, fail: 0 };
      for (const c of postureProvider?.() ?? []) {
        if (c.level in counts) counts[c.level] = (counts[c.level] ?? 0) + 1;
      }
      for (const [level, n] of Object.entries(counts)) this.set({ level }, n);
    } catch {
      /* A metrics scrape must never be the thing that fails. */
    }
  },
});

/**
 * How the posture reaches the gauge without this module importing config.
 *
 * `registry.ts` is imported by nearly every file, so pulling `security-posture` (and therefore the config
 * loader) in here would invert the dependency direction and risk a cycle. `index.ts` registers the provider
 * once at boot instead. Unregistered — in a test, or before boot finishes — the gauge reports zeros, which
 * is the honest answer for "no posture has been computed".
 */
let postureProvider: (() => Array<{ level: string }>) | null = null;
export function setPostureProvider(fn: () => Array<{ level: string }>): void {
  postureProvider = fn;
}
for (const level of POSTURE_LEVELS) securityPostureChecks.set({ level }, 0);

/**
 * A config reload that FAILED, counted and — separately — held as a condition (`Q-43`).
 *
 * ## Why this is not only a log line
 *
 * The canary operator edited `config.json`, the watcher refused the half-written file, and the edit sat
 * out of effect until the next restart. The only evidence anywhere was one line in a pod log nobody was
 * tailing. `startConfigWatcher` ends its chain in `.catch(err => log.error(...))`, which is the right
 * shape for a watcher — there is no caller to return a status to — and the wrong amount of evidence.
 *
 * ## Why BOTH, and it is not belt-and-braces
 *
 * The watcher claims the file's mtime BEFORE reloading, so broken bytes are not retried every tick. That
 * makes a failed watched reload permanent on its own: the running config stays older than the file until
 * something writes it again or the instance restarts.
 *
 * So the two answer different questions. The counter is the history — *"has this been happening?"* — and
 * the gauge is the condition — *"is the config I am running the config on disk, right now?"*. An alert
 * wants the second; a postmortem wants the first. The canary named that distinction themselves, for the
 * reranker: transient versus permanent, and only a series over time can tell them apart.
 */
export const configReloadFailedTotal = new Counter({
  name: 'ythril_config_reload_failed_total',
  help: 'Config reloads that were refused and left the running configuration unchanged',
  registers: [register],
});
// Pre-declared, for the reason every counter here is: absent and zero look identical on a graph, and an
// operator reading a missing series as "never happened" is the failure this metric exists to prevent.
configReloadFailedTotal.inc(0);

/**
 * 1 while the last watched reload failed, so what is running is older than what is on disk.
 *
 * Cleared by the next reload that succeeds, deliberately: an alert that cannot resolve is one somebody
 * silences, and then the next real occurrence is invisible for the same reason as the first.
 */
export const configReloadPending = new Gauge({
  name: 'ythril_config_reload_pending',
  help: '1 if a config reload was refused and the running configuration is older than the file on disk',
  registers: [register],
});
configReloadPending.set(0);
