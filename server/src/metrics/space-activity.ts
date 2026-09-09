/**
 * Which spaces are actually earning their keep.
 *
 * ## The question this answers, and the one it refuses to
 *
 * "How often is this space called on" is easy and almost useless on its own: a space queried five hundred
 * times that answers nothing is not a popular space, it is a space someone keeps failing to get an answer out
 * of — and in a call counter those two are indistinguishable. So every call records **demand and payoff**: the
 * call happened, and whether it came back with anything.
 *
 * That is why `answered` and `sumTopScore` sit next to `n` here rather than being a later addition. Ranking
 * spaces by `n` alone produces the metric that says the loudest space is the best one.
 *
 * ## Why it is affordable
 *
 * Measured before it was built: this path is a `Map` lookup plus a handful of integer operations —
 * **18.6 ns** per request, 0.000046% of a 40 ms recall, holding 260 small objects for 65 spaces across four
 * classes. The part that could have been expensive is persistence, and it is not: the counters accumulate in
 * memory and are flushed on an interval as one `bulkWrite` of `$inc`s, so **the write cost is independent of
 * traffic** — one upsert per active space per flush whether that space served ten calls or a hundred thousand.
 *
 * The alternative — turning on `audit.logReads` — writes one document per read. That is exactly the
 * per-request cost this avoids, and it buys row-level detail nobody asked for.
 *
 * ## What is deliberately NOT stored
 *
 * Percentiles. A mean stored per bucket cannot be recombined into a p95, so a stored p95 would either be a
 * lie or force keeping every sample. `sumMs` (for a mean), `maxMs` and `over1s` answer "how slow" honestly and
 * survive being summed across buckets, which is what a 24-hour or 7-day view needs.
 */

/**
 * The closed set of call classes.
 *
 * Closed because it becomes a metric label and a document field: an open set derived from route names would be
 * a cardinality bomb in Prometheus and an unqueryable document shape in Mongo. Four classes are what the
 * question needs — demand on the brain, demand on files, and whether anything is still being written.
 */
export const CALL_CLASSES = ['recall', 'read', 'write', 'file'] as const;
export type CallClass = typeof CALL_CLASSES[number];

/** One class's totals for one space since the last flush. */
export interface CallTotals {
  /** Calls made. */
  n: number;
  /** Calls that came back with something — only meaningful for `recall`, absent elsewhere. */
  answered: number;
  /** Sum of the top result's score, for a mean answer quality. Only `recall` reports it. */
  sumTopScore: number;
  /** Sum of durations, for a mean. Kept as a sum because sums survive being added across buckets. */
  sumMs: number;
  maxMs: number;
  /** Calls slower than a second — the honest alternative to a stored percentile. */
  over1s: number;
}

export interface SpaceActivityRow {
  space: string;
  cls: CallClass;
  totals: CallTotals;
}

const SLOW_MS = 1_000;

/** space → class → totals. Bounded by (spaces × 4), and only spaces that were actually called appear. */
const _pending = new Map<string, Map<CallClass, CallTotals>>();

function emptyTotals(): CallTotals {
  return { n: 0, answered: 0, sumTopScore: 0, sumMs: 0, maxMs: 0, over1s: 0 };
}

/**
 * Record one call against one space.
 *
 * Everything is optional except the class and the duration, because most callers know nothing about answers:
 * only recall can say whether it found something, and only it passes `answered`/`topScore`.
 */
export function recordSpaceCall(
  space: string,
  cls: CallClass,
  opts: { ms: number; answered?: boolean; topScore?: number },
): void {
  if (!space) return;                       // a global recall has no space to attribute
  let byClass = _pending.get(space);
  if (!byClass) { byClass = new Map(); _pending.set(space, byClass); }
  let t = byClass.get(cls);
  if (!t) { t = emptyTotals(); byClass.set(cls, t); }

  t.n++;
  // A non-finite duration would poison the mean for the whole bucket, and NaN propagates through `$inc`
  // silently — the field simply stops being a number.
  const ms = Number.isFinite(opts.ms) ? Math.max(0, opts.ms) : 0;
  t.sumMs += ms;
  if (ms > t.maxMs) t.maxMs = ms;
  if (ms > SLOW_MS) t.over1s++;
  if (opts.answered) t.answered++;
  // Only an ANSWERED call contributes a score, because `sumTopScore` is divided by `answered` to get a mean.
  // Accumulating it unconditionally made the mean meaningless — 100 calls each reporting 0.3 with 5 answered
  // came out as 6.0, which is not even inside the range a similarity score can take. Found by a test whose
  // fixture passed a score on every call, which is exactly what a real caller does when it has one.
  if (opts.answered && typeof opts.topScore === 'number' && Number.isFinite(opts.topScore)) {
    t.sumTopScore += opts.topScore;
  }
}

/**
 * Take everything accumulated and clear it.
 *
 * Clearing on read rather than on a successful write is deliberate. If the flush fails, these counts are lost
 * — a minute of them — and that is the right trade: merging them back risks double-counting on a partial
 * bulkWrite, and a usefulness gauge that is occasionally a minute short is far better than one that is
 * sometimes wrong in the other direction. The flush logs when it drops a batch.
 */
export function drainSpaceActivity(): SpaceActivityRow[] {
  const rows: SpaceActivityRow[] = [];
  for (const [space, byClass] of _pending) {
    for (const [cls, totals] of byClass) rows.push({ space, cls, totals });
  }
  _pending.clear();
  return rows;
}

/** Non-destructive read, for tests and for a debug endpoint. */
export function peekSpaceActivity(): SpaceActivityRow[] {
  const rows: SpaceActivityRow[] = [];
  for (const [space, byClass] of _pending) {
    for (const [cls, totals] of byClass) rows.push({ space, cls, totals: { ...totals } });
  }
  return rows;
}

/**
 * The hour bucket a timestamp belongs to, as `2026-08-01T14` (UTC).
 *
 * Hourly, not daily: "which spaces are useful" is a comparison over a window an operator chooses, and hours
 * sum into any window. Daily buckets cannot answer "this morning".
 *
 * UTC, not local: a fleet spans zones, and a bucket that shifts with the server's offset makes two instances
 * disagree about which hour a call belongs to.
 */
export function hourBucket(at: Date | number = Date.now()): string {
  return new Date(at).toISOString().slice(0, 13);
}

/** The document id for one space's hour. Stable and derivable, so an upsert needs no lookup. */
export function activityDocId(space: string, bucket: string): string {
  return `${space}:${bucket}`;
}

/**
 * Map an audit operation name to a call class, or null when it should not be counted.
 *
 * Derived from the operation the audit middleware ALREADY computes for every request — so this adds no route
 * knowledge of its own, and cannot disagree with the audit log about which space a call touched. That
 * matters: two independent path-matchers is how a count and an audit trail end up describing different things.
 */
export function classifyOperation(operation: string): CallClass | null {
  if (!operation) return null;

  // Operator work, not a space being useful. Creating a space, casting a vote, rotating a token and running a
  // backup all carry a spaceId, and counting them would credit a brand-new empty space with activity it never
  // had. Checked FIRST, because several of these end in the same verbs a real write does.
  if (ADMIN_DOMAINS.some(d => operation.startsWith(d))) return null;

  // Plumbing: minting a ticket is a client attaching to a stream, not a question being asked of the space.
  // Counting it would put connection churn — a browser tab reopening, a reconnect after a deploy — into the
  // read demand for a space nobody queried.
  if (NON_USAGE_SUFFIXES.some(s => operation.endsWith(s))) return null;

  // Demand on the brain — the reason a space exists. `find_similar` belongs here despite its name: it is a
  // vector query with a record as the query text.
  if (/^brain\.(recall|query|find_similar)/.test(operation)) return 'recall';

  // Verb before noun: knowledge going IN is a write whether it arrived as a record or as a file. Grouping all
  // of `file.*` as file traffic instead would hide the "is anyone still adding to this space" signal inside
  // the "is anyone reading its files" one.
  if (MUTATION_VERB.test(operation)) return 'write';

  // Demand on the file store, reads only (the mutations went to `write` above).
  if (/^file\./.test(operation)) return 'file';

  // `er_model` joins this list rather than the suffix pattern gaining a `model$` alternative: it is a READ of
  // what a space contains — type names, edge labels, counts — which is the same demand signal as `stats`.
  //
  // `cascade_preview` is here for the same reason and NOT in `NON_USAGE_SUFFIXES`: it is somebody asking
  // what deleting a record would take with it, which is a real question about the space's contents. It is
  // also the step before a write, so excluding it would make the cautious path look like less demand than
  // the reckless one.
  //
  // `convert_preflight` joins them on the same reasoning one step further out: it asks who has been
  // WRITING to the space, which is a question about the space's contents and is the step before a
  // migration. Excluded, the careful operator who checks first would register less demand than the one
  // who converts blind.
  if (/\.(list|get|stats|er_model|traverse|export|search|validate|cascade_preview|convert_preflight)$/.test(operation)) return 'read';

  // Anything unrecognised counts as nothing rather than guessing. `space-activity-classes.test.js` enumerates
  // every operation the audit middleware defines and fails on one that lands here undeclared, so a new route
  // cannot become invisible by accident — it has to be added to the deny-list on purpose.
  return null;
}

/**
 * Prefixes that describe an operator acting ON the instance rather than a space being used.
 *
 * Curation stays OUT of this list on purpose: `conflict.resolve`, `duplicate.merge` and
 * `contradiction.resolve` are someone tending a space's own knowledge, which is exactly the signal the write
 * class is for.
 */
const ADMIN_DOMAINS = [
  'space.', 'network.', 'token.', 'webhook.', 'config.', 'data.', 'mfa.', 'auth.', 'schema_library.',
  // `peer.` joins `network.` and `sync.` for the same reason: triggering a cycle is an operator acting on
  // the instance's replication, not anybody using a space. It arrived as its own domain in 4.5, when
  // syncing ONE peer got a door of its own — a peer belongs to several networks, so `network.` could not
  // honestly cover it.
  'about.', 'sync.', 'local_agent.', 'peer.',
] as const;

/**
 * Operations that are transport plumbing rather than use. Currently just SSE ticket minting: one per stream
 * connection, so a browser tab reopening after a deploy would read as demand on a space nobody queried.
 */
const NON_USAGE_SUFFIXES = ['.ticket'] as const;

/**
 * Verbs that mean something changed. `retry_embedding` and `mkdir` are here because they are mutations whose
 * names do not end in an obvious verb, and `write` because the bulk endpoint is called `bulk.write`.
 */
const MUTATION_VERB =
  /\.(create|update|delete|merge|import|restore|reindex|rebuild|wipe|write|mkdir|retry_embedding(_all)?|resolve|bulk_resolve|dismiss|reopen|seed|scan|publish|apply|fork|adopt)$/;
