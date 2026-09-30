/**
 * Is the database's search answering, and who is waiting for it (Q-113).
 *
 * ## The failure this prevents
 *
 * `searchAvailable()` used to wait 6 x 2 s ONCE per process and cache its answer for the life of the process,
 * FALSE included. `mongot` (the search process next to `mongod`) starts after `mongod` accepts connections and
 * compose's `depends_on: service_healthy` waits on `mongod` alone, so a mongot that lost the race by thirteen
 * seconds was never asked again: no index was built, semantic recall returned nothing, the space was marked
 * `failed` after a ten minute poll of a service that was not there, and the only trace was one warn line. A
 * restart, or the rebuild button, was the cure.
 *
 * ## What replaces it: a state, a watcher, and a list of who is waiting
 *
 *  - **`unknown | up | down | absent`.** `unknown` until the first caller asks. The first caller runs the
 *    COLD-START WINDOW (6 attempts, 2 s apart) and every concurrent caller shares that one run — an earlier
 *    version retried inside `ensureVectorSearchIndex`, which runs once per collection per space, and a cold boot
 *    paid twelve seconds five times per space. The window runs once per process.
 *  - **Callers read, only the watcher probes.** While `down`, `searchAvailable()` answers from the state and
 *    never waits: fifty writes are not fifty probes. The one place that asks the database again is the watcher,
 *    an unref'd timer on {@link backoffDelayMs} (5 s doubling to 5 min, for as long as the process lives).
 *  - **`absent` is a mongod with no search component at all** (the plain Community server the shipped manifests
 *    do not use, but a self-hosted deployment may). It is decided only by {@link isNoSearchComponentError} and
 *    only after {@link ABSENT_AFTER_MATCHES} CONSECUTIVE matches: a transient error that happened to match, and
 *    parked recovery for an hour, would be the original defect again with a longer fuse. The watcher then
 *    slows to an hour and stays quiet after its first warn, so such a deployment is not probed every five
 *    minutes for ever. That list is deliberately NOT `PERMANENT_PROBE_ERRORS`: that one matches the message of a
 *    `$vectorSearch` QUERY refusal and answers a different question; reusing it would park a healthy mongot
 *    whose probe hit a malformed query.
 *  - **`afterSearchUp(key, callback)`** is how a thing that could not proceed while search was down says what to
 *    do when it returns. Keyed (a second registration under the same key REPLACES the first, so a collection
 *    written ten thousand times while down leaves one entry), capped, removable ({@link forgetSearchWaiter}, for
 *    a deleted space), and run AT ONCE when search is already up, so a registration that lands just after the
 *    flip is never lost to the window between "answered unavailable" and "recorded deferred".
 *
 * ## What each probe costs and cannot do
 *
 * A probe carries `maxTimeMS` AND is raced against {@link PROBE_TIMEOUT_MS}: a mongot that is up but wedged is
 * the same outage as one that is absent, and a hung `listSearchIndexes` awaited for ever would pin every caller,
 * boot included. The watcher's re-arm sits OUTSIDE the step that can throw, so nothing a probe does stops it.
 * `/ready` (`ready.ts`) runs its own probe and tells this module when it succeeds ({@link noteSearchUp}) so the
 * two answer the same question the same way; it never sets `down` — it is public and unauthenticated, and anyone
 * able to make it fail would otherwise start this module's slow-down.
 *
 * ## Logs carry the error CLASS and CODE, never the message
 *
 * The watcher writes for as long as the process lives, and a driver's message names the infrastructure (a host
 * and port; an authentication failure prints the URI it tried). The one exception is the cold-start warning,
 * whose text predates this module and names the rebuild route that operators search the logs for. The snapshot
 * is an enum and numbers for the same reason: it is served by the admin pipeline-status route.
 *
 * Everything the module touches from outside — the probe, the sleep, the clock, the timers, the log — is an
 * argument of {@link createSearchReadiness}, so hours of backoff are tested in milliseconds; the production
 * singleton is the functions exported at the bottom.
 */
import { getDb } from '../db/mongo.js';
import { log as appLog } from '../util/log.js';
import { backoffDelayMs } from '../util/backoff.js';
import { mapLimit } from '../util/map-limit.js';
import { runExclusive } from '../util/single-flight.js';

export type SearchState = 'unknown' | 'up' | 'down' | 'absent';

/** The watcher's first delay, and the unit other retries of "search said no" are counted in. One constant. */
export const SEARCH_RETRY_BASE_MS = 5_000;
const WATCH_CAP_MS = 5 * 60_000;
/** While `absent`: one probe an hour (equal-jittered, so 30 to 60 minutes). */
const ABSENT_INTERVAL_MS = 60 * 60_000;
const COLD_ATTEMPTS = 6;
const COLD_BACKOFF_MS = 2_000;
/** A probe that has not answered by now counts as failed. */
export const PROBE_TIMEOUT_MS = 5_000;
/** Sent to the server, a little under the race above, so a slow answer is abandoned at both ends. */
const PROBE_MAX_TIME_MS = 4_000;
const HOURLY_WARN_MS = 60 * 60_000;
/** Consecutive refusals of the no-search-component kind before a service is called `absent`. */
export const ABSENT_AFTER_MATCHES = 3;
/** Waiters run this many at a time: no herd against a mongot that has only just started. */
const EMIT_CONCURRENCY = 3;
/** Distinct waiting keys kept. A collection per space times a few hundred spaces is far below it. */
export const MAX_WAITERS = 4_096;

/**
 * What `listSearchIndexes` says on a mongod that has NO search component configured (code 31082, SearchNotEnabled:
 * "Using Atlas Search Database Commands and the $listSearchIndexes aggregation stage requires additional
 * configuration. Please connect to Atlas or an AtlasCLI local deployment to enable."), and on a server too old to
 * know the stage. Matched by code first; the message is the fallback for a driver that drops the code.
 *
 * A mongod that HAS search configured and cannot reach it says something else entirely (a connection error), so
 * it is correctly NOT in this list: that is a service that will come up, which is the case the watcher is for.
 */
const NO_SEARCH_COMPONENT_CODE_NAMES: readonly string[] = ['SearchNotEnabled'];
const NO_SEARCH_COMPONENT_CODES: readonly number[] = [31082];
const NO_SEARCH_COMPONENT_MESSAGES: readonly RegExp[] = [
  /\$listSearchIndexes[\s\S]*requires additional configuration/i,
  /unrecognized pipeline stage name:\s*'\$listSearchIndexes'/i,
];

/** Is this the refusal of a database that has no search component at all (as opposed to one that is not answering)? */
export function isNoSearchComponentError(err: unknown): boolean {
  const e = err as { code?: unknown; codeName?: unknown } | null | undefined;
  if (typeof e?.code === 'number' && NO_SEARCH_COMPONENT_CODES.includes(e.code)) return true;
  if (typeof e?.codeName === 'string' && NO_SEARCH_COMPONENT_CODE_NAMES.includes(e.codeName)) return true;
  const message = err instanceof Error ? err.message : '';
  return NO_SEARCH_COMPONENT_MESSAGES.some(re => re.test(message));
}

/**
 * The class and the code of an error, and nothing else: safe to log thousands of times.
 * A class name is restricted to a plain identifier so a hostile or sloppy `name` cannot carry text.
 */
export function describeError(err: unknown): string {
  const e = err as { name?: unknown; code?: unknown; codeName?: unknown } | null | undefined;
  const name = typeof e?.name === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(e.name) ? e.name : 'Error';
  const raw = e?.code ?? e?.codeName;
  const code = (typeof raw === 'number' || (typeof raw === 'string' && /^[A-Za-z0-9_]{1,40}$/.test(raw))) ? String(raw) : null;
  return code === null ? name : `${name}, code ${code}`;
}

/**
 * Is database search not answering (`down`) or not there at all (`absent`)? The one place that says what counts as
 * "waiting for the search service", so the space list and the pipeline status cannot disagree about it.
 */
export function isSearchDown(snapshot: Pick<SearchReadinessSnapshot, 'state'>): boolean {
  return snapshot.state === 'down' || snapshot.state === 'absent';
}

export interface SearchReadinessSnapshot {
  state: SearchState;
  /** When the current state began (ms since the epoch), or null while `unknown`. */
  since: number | null;
  /** Watcher probes made since the service was last `up` (the cold-start window's are not counted). */
  attempts: number;
  /** When the watcher will next probe (ms since the epoch), or null when it is not armed. */
  nextProbeAt: number | null;
  /** How many things are waiting for search to come up. */
  waiting: number;
}

type LogLike = Pick<typeof appLog, 'debug' | 'info' | 'warn' | 'error'>;

export interface SearchReadinessDeps {
  /** One ask of the database's search component; rejects or throws when it is not answering. */
  probe: () => Promise<unknown>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  scheduler: { setTimer: (fn: () => void, ms: number) => unknown; clearTimer: (handle: unknown) => void };
  log: LogLike;
}

let instances = 0;

export function createSearchReadiness(deps: SearchReadinessDeps) {
  const { probe, sleep, now, scheduler, log } = deps;
  // `runExclusive` keys on a label for the whole process, so a second instance (a test's) must not share the
  // production watcher's lock.
  const label = instances++ === 0 ? 'Search readiness' : `Search readiness #${instances}`;

  let state: SearchState = 'unknown';
  let stateSince: number | null = null;
  /** Bumped by `reset` and by every transition to `up`: work begun under an older one must not act. */
  let epoch = 0;
  let cold: Promise<boolean> | null = null;
  let timer: unknown = null;
  let nextProbeAt: number | null = null;
  let watchAttempts = 0;
  let noSearchStreak = 0;
  let lastWarnAt = 0;
  let overflowWarned = false;
  const waiters = new Map<string, () => unknown>();

  /**
   * `down` and `absent` are one outage to everyone who reads `since` (`indexWaitingSince`): the moment search
   * stopped answering, not the moment the watcher finished counting refusals. So the moment is kept across a move
   * between them and starts over only when the state leaves that pair.
   */
  function setState(next: SearchState): void {
    const notAnswering = (s: SearchState) => s === 'down' || s === 'absent';
    if (!(notAnswering(state) && notAnswering(next))) stateSince = now();
    state = next;
  }

  /** One ask, bounded at both ends: `maxTimeMS` on the server (in `probe`) and this race on ours. */
  function probeOnce(): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const handle = scheduler.setTimer(() => reject(Object.assign(new Error('probe timed out'), { name: 'ProbeTimeout' })), PROBE_TIMEOUT_MS);
      const settle = <T>(fn: (v: T) => void) => (v: T) => { scheduler.clearTimer(handle); fn(v); };
      try { Promise.resolve(probe()).then(settle(resolve), settle(reject)); }
      catch (err) { settle(reject)(err); }
    });
  }

  function clearWatcher(): void {
    if (timer !== null) scheduler.clearTimer(timer);
    timer = null;
    nextProbeAt = null;
  }

  /** Run one waiter: started now, never allowed to throw into the caller, reported by class and code only. */
  async function runWaiter(key: string, fn: () => unknown): Promise<void> {
    try { await fn(); }
    catch (err) { log.warn(`Search readiness: the action waiting under '${key}' failed (${describeError(err)}); the others still run.`); }
  }

  /** Call every waiter, three at a time, each in its own try. Always AFTER the state is set. */
  async function emit(): Promise<void> {
    const entries = [...waiters.entries()];
    waiters.clear();
    overflowWarned = false;
    await mapLimit(entries, EMIT_CONCURRENCY, ([key, fn]) => runWaiter(key, fn));
  }

  function markUp(): void {
    if (state === 'up') return;
    const was = state;
    const since = stateSince;
    epoch++;
    clearWatcher();
    watchAttempts = 0;
    noSearchStreak = 0;
    setState('up');
    if (was === 'down' || was === 'absent') {
      log.info(`Database search is back after ${Math.round((now() - (since ?? now())) / 1000)}s; resuming ${waiters.size} waiting item(s).`);
    }
    void emit().catch(err => log.warn(`Search readiness: resuming waiters failed (${describeError(err)})`));
  }

  function nextDelayMs(): number {
    return state === 'absent'
      ? backoffDelayMs(0, ABSENT_INTERVAL_MS, ABSENT_INTERVAL_MS)
      : backoffDelayMs(watchAttempts, SEARCH_RETRY_BASE_MS, WATCH_CAP_MS);
  }

  function armWatcher(): void {
    clearWatcher();
    const mine = epoch;
    const delay = nextDelayMs();
    nextProbeAt = now() + delay;
    timer = scheduler.setTimer(() => { timer = null; nextProbeAt = null; void watchOnce(mine); }, delay);
  }

  /** What one failed watcher probe does to the state, and what it says. */
  function onWatcherFailure(err: unknown): void {
    log.debug(`Search readiness: probe failed (${describeError(err)}); ${watchAttempts} watcher probe(s) so far`);
    noSearchStreak = isNoSearchComponentError(err) ? noSearchStreak + 1 : 0;
    if (noSearchStreak >= ABSENT_AFTER_MATCHES) {
      if (state !== 'absent') {
        setState('absent');
        log.warn(
          `Database search is not present on this deployment (${describeError(err)}): the database has no search `
          + `component, so semantic recall stays empty. Checking once an hour in case one is added; `
          + `use mongodb/mongodb-atlas-local for $vectorSearch support.`,
        );
      }
      return;
    }
    if (state === 'absent') { setState('down'); lastWarnAt = now(); return; }
    if (now() - lastWarnAt >= HOURLY_WARN_MS) {
      lastWarnAt = now();
      log.warn(
        `Database search has been down for ${Math.round((now() - (stateSince ?? now())) / 60_000)} min `
        + `(${describeError(err)}); still retrying, ${waiters.size} item(s) waiting.`,
      );
    }
  }

  async function watchStep(mine: number): Promise<void> {
    if (mine !== epoch) return;
    watchAttempts++;
    try { await probeOnce(); }
    catch (err) { if (mine === epoch) onWatcherFailure(err); return; }
    if (mine === epoch) markUp();
  }

  /** The timer's body. The re-arm is in the `finally`, outside everything above that can throw. */
  async function watchOnce(mine: number): Promise<void> {
    try { await runExclusive(label, () => watchStep(mine)); }
    catch { /* runExclusive does not throw; this keeps the re-arm below unconditional */ }
    finally {
      if (mine === epoch && (state === 'down' || state === 'absent')) armWatcher();
    }
  }

  /** The cold-start window. Run once per process (per reset), by whoever asks first. */
  async function coldWindow(mine: number): Promise<boolean> {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= COLD_ATTEMPTS; attempt++) {
      try {
        // Any collection will do — this asks "is search answering at all?", not "does this index exist".
        await probeOnce();
        if (mine === epoch) markUp();
        return true;
      } catch (err) {
        lastErr = err;
        if (mine !== epoch) return state === 'up';
        if (state === 'up') return true;
        if (attempt < COLD_ATTEMPTS) await sleep(COLD_BACKOFF_MS);
      }
    }
    if (mine !== epoch || state !== 'unknown') return state === 'up';
    setState('down');
    lastWarnAt = now();
    log.warn(
      `Database search (\`mongot\`) did not answer after ${COLD_ATTEMPTS} attempts ` +
        `(${Math.round((COLD_ATTEMPTS * COLD_BACKOFF_MS) / 1000)}s): ${lastErr instanceof Error ? lastErr.message : String(lastErr)}. ` +
        `SEMANTIC RECALL WILL RETURN EMPTY until vector indexes are built — rebuild them from ` +
        `Settings → Space → Danger Zone, or POST /api/spaces/<space>/rebuild-indexes. ` +
        `Use mongodb/mongodb-atlas-local for $vectorSearch support.`,
    );
    armWatcher();
    return false;
  }

  /**
   * Is search answering? Same contract as before: callers never probe while it is down — they read the state.
   * The first caller of a process waits out the cold-start window; everyone concurrent shares it.
   */
  async function searchAvailable(): Promise<boolean> {
    if (state === 'up') return true;
    if (state === 'down' || state === 'absent') return false;
    cold ??= coldWindow(epoch);
    return cold;
  }

  /**
   * Run `callback` once search is up — at once if it already is. Keyed: a second registration under the same key
   * replaces the first. Bounded: past {@link MAX_WAITERS} distinct keys a NEW key is refused and said so once.
   */
  function afterSearchUp(key: string, callback: () => unknown): void {
    if (state === 'up') { void runWaiter(key, callback); return; }
    if (!waiters.has(key) && waiters.size >= MAX_WAITERS) {
      if (!overflowWarned) {
        overflowWarned = true;
        log.warn(`Search readiness: ${MAX_WAITERS} items are already waiting for database search; further ones are not kept. A rebuild after it returns covers them.`);
      }
      return;
    }
    waiters.set(key, callback);
  }

  /** Remove a waiter (a deleted space's). Unknown keys are ignored. */
  function forgetSearchWaiter(key: string): void { waiters.delete(key); }

  /** Something else saw search answer (`/ready`'s own probe). Idempotent; emits only on a transition. */
  function noteSearchUp(): void { markUp(); }

  function snapshot(): SearchReadinessSnapshot {
    return { state, since: stateSince, attempts: watchAttempts, nextProbeAt, waiting: waiters.size };
  }

  /** Forget everything and stop the watcher: the next caller starts a fresh cold window. For tests and restores. */
  function reset(): void {
    epoch++;
    clearWatcher();
    cold = null;
    state = 'unknown';
    stateSince = null;
    watchAttempts = 0;
    noSearchStreak = 0;
    lastWarnAt = 0;
    overflowWarned = false;
    waiters.clear();
  }

  return { searchAvailable, afterSearchUp, forgetSearchWaiter, noteSearchUp, snapshot, reset };
}

// ── The production instance ───────────────────────────────────────────────────────────────────────────────

const production = createSearchReadiness({
  // Any collection will do; the underscore keeps it out of every space's namespace.
  // The options are an AGGREGATE option (`maxTimeMS`), not an index name: the gate that forbids the name-filtered
  // overload reads a call with anything after its bracket on the same line, so the argument starts on the next.
  probe: () => getDb().collection('_vectorsearch_probe').listSearchIndexes(
    { maxTimeMS: PROBE_MAX_TIME_MS }).toArray(),
  sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
  now: () => Date.now(),
  scheduler: {
    // Never the reason a process stays alive: a pending probe is not work.
    setTimer: (fn, ms) => { const handle = setTimeout(fn, ms); handle.unref?.(); return handle; },
    clearTimer: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
  },
  log: appLog,
});

export const searchAvailable = production.searchAvailable;
export const afterSearchUp = production.afterSearchUp;
export const forgetSearchWaiter = production.forgetSearchWaiter;
export const noteSearchUp = production.noteSearchUp;
export const searchReadinessSnapshot = production.snapshot;
export const resetSearchReadyProbe = production.reset;
