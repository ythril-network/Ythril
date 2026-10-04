/**
 * A FAILURE OF THE STORE IS NOT A FAILURE OF THE REQUEST — and until now every read said it was.
 *
 * ## The defect, reported from both sides within thirty hours
 *
 * `/query`, `/recall` and `/find-similar` each ended their handler with one `catch` that answered
 * `res.status(400).json({ error: msg })` for EVERY throw. So a malformed filter and a failed aggregation were
 * indistinguishable to a caller, by construction rather than by accident.
 *
 * **the canary operator, 2026-08-17T1912Z**, from the operator's side: after any restart, mongot re-initialises
 * hundreds of indexes, and for HOURS a recall can fail with
 *
 *     Executor error during aggregate command on namespace: ythril.{space}_entities :: caused by ::
 *
 * — nothing after `caused by ::`. The operator gets the location and not the reason. Three occurrences in a
 * day, two retried with a byte-identical call seconds later and both succeeded.
 *
 * **the fleet integrator, 2026-08-18T2145Z**, from the caller's side, and this is the half that priced it: the same error,
 * **6 of 36 calls (17%)**, rate-sensitive. Every recall node in their fleet carries
 * `onError: continueRegularOutput`, because a persona should not die when a context read fails. **A 4xx is not
 * retried and not reported**, so the persona simply ran with no context and produced something plausible and
 * uninformed — one call in six, silently, across fourteen personas.
 *
 * That is what the wrong status costs. Not a confusing message: unmarked wrong output at scale, because 4xx
 * means *"do not try again, the fault is yours"* and every HTTP client is built to believe it.
 *
 * ## The four faults, and why they are one commit
 *
 * 1. The status said client error.  2. The cause was truncated to nothing.  3. Nothing said it was retryable,
 * and it was.  4. Our own startup probe already knows how to wait for exactly this condition, while a caller
 * got an opaque hard error. Fixing the status alone would leave an operator with the same unreadable message;
 * fixing the message alone would leave fourteen personas still not retrying.
 *
 * ## An ALLOWLIST, and everything unrecognised stays a 400
 *
 * The same discipline as `isTransientConnectError` in `db/mongo.ts`, for the same reason stated there: the
 * unsafe direction here is calling a genuine client error retryable. A caller who retries a malformed filter
 * forever has been given a worse answer than the one we started with, so a failure only becomes a 503 when
 * something POSITIVELY identifies it as the store's, and the default is unchanged.
 *
 * **What deliberately stays 400:** every validation refusal we raise ourselves (a bad filter, an unknown
 * operator, a projection conflict, an out-of-range parameter) — all of which are refused before Mongo is
 * reached, which is why this classifier sees so few of them.
 *
 * ## What this does NOT do, on purpose
 *
 * It does not retry. The canary operator's third option was to retry internally with backoff as the startup
 * probe does, and on 2026-08-19 the cause turned out to be a **dead mongot process** under a degraded array.
 * A retry loop would have turned that into slow successes and hidden a process death from the only two
 * parties who could see it. Say what happened, say it can be retried, and let the caller decide.
 */
import { isWriteTimeout, STORE_RETRY_SENTENCE } from '../db/write-timeout.js';
import { log, logSafe } from '../util/log.js';

/** What every door answers for an operation a bound ended: the store's condition, said without the store's text. */
const STORE_TIMEOUT_MESSAGE = `The database did not complete this operation in time. ${STORE_RETRY_SENTENCE}`;
/**
 * What every door answers for any other store failure: the condition, never our collection names or the driver's
 * text. The driver's message names internal hosts, addresses and ports (`connection 5 to 172.16.0.9:27017 closed`),
 * and the REST error handler that answers with this cannot tell an operator from an anonymous caller — so there is
 * one answer for every audience, and the driver's text goes to the log (`storeFailureDetail`), bundle-30 I8.
 */
const STORE_FAILURE_MESSAGE = `A store-side failure stopped this operation. ${STORE_RETRY_SENTENCE}`;

/** Query-time conditions that are the STORE's, never the request's. */
const STORE_ERROR_NAMES = new Set([
  'MongoNetworkError',          // the socket died mid-query
  'MongoNetworkTimeoutError',
  'MongoServerSelectionError',  // nothing to send the query to
  'MongoTopologyClosedError',
  'MongoNotConnectedError',
]);

/**
 * `MongoServerError` codes that mean "not answerable right now", by code because the name cannot decide.
 *
 * The first five are the same set `db/mongo.ts` retries at connect time — a replica set stepping down under a
 * running query is the same condition as one stepping down during boot.
 *
 * The two deadline codes, 50 `MaxTimeMSExpired` and 262 `ExceededTimeLimit`, are NOT here, and the absence is
 * deliberate: `isWriteTimeout` (the first branch of `classifyReadFailure`, through `db/max-time.ts`) answers both, so
 * a row for them here could never be reached — and a reader who found one would believe a deadline is answered with
 * the driver's text, which it is not (bundle-30 I6, D1). `store-failure-is-not-a-400` still holds both to a 503.
 */
const STORE_ERROR_CODES = new Set([
  11600,  // InterruptedAtShutdown
  91,     // ShutdownInProgress
  11602,  // InterruptedDueToReplStateChange
  189,    // PrimarySteppedDown
  13436,  // NotPrimaryOrSecondary
]);

/**
 * The message shape of a failed aggregation stage, which is how the reported condition actually arrives.
 *
 * Matched on the MESSAGE and not on a code, deliberately and with the cost stated: both parties quoted this
 * string verbatim from two different instances, so the shape is what we can rely on; the code that accompanies
 * it we have never seen, because neither failing instance is ours to probe. A message match is the weaker
 * signal and it is the one we have — so it is narrow (this exact MongoDB phrasing, anchored to an aggregate or
 * find command) rather than a keyword search that would catch a caller's own text.
 */
const EXECUTOR_ERROR = /Executor error during (aggregate|find|getMore) command/i;

/** The vector-search stage specifically, which is the only stage a recall depends on that `/query` does not. */
const SEARCH_STAGE_ERROR = /\$vectorSearch|\$search\b|mongot|vector search index/i;

export interface ReadFailure {
  /** HTTP status for the REST doors. */
  status: number;
  /** True when trying the identical request again may succeed. Machine-readable, not prose. */
  retryable: boolean;
  /** Seconds to wait before retrying, for `Retry-After`. Only on a retryable failure. */
  retryAfterSeconds?: number;
  /** The message to return: the caller's own refusal, or the store's condition in our words (never the driver's). */
  error: string;
  /** The store's own code, when it had one — an operator's fastest route to the real condition. */
  code?: number;
  codeName?: string;
}

/** Every scrap the driver attached, in the order an operator would want it. */
function causeOf(err: unknown): string | undefined {
  const e = err as Record<string, unknown> | null;
  if (!e) return undefined;
  const parts: string[] = [];
  for (const key of ['errmsg', 'codeName']) {
    const v = e[key];
    if (typeof v === 'string' && v.trim() && !parts.includes(v.trim())) parts.push(v.trim());
  }
  // `cause` is where a driver puts the wrapped error, and it is the field the empty `caused by ::` was hiding.
  const nested = e['cause'];
  if (nested) {
    const inner = nested instanceof Error ? nested.message : String(nested);
    if (inner.trim()) parts.push(inner.trim());
  }
  const info = e['errInfo'];
  if (info && typeof info === 'object') {
    try { parts.push(JSON.stringify(info)); } catch { /* unserialisable — skip rather than throw in a catch */ }
  }
  return parts.length > 0 ? parts.join(' — ') : undefined;
}

const numeric = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);
const text = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : undefined);

/**
 * The driver's account of a store failure, for the OPERATOR's log — never for an answer.
 *
 * ## The dangling `caused by ::` is REPLACED rather than passed on
 *
 * When MongoDB reports an executor error with an empty cause and the driver attached nothing either, the
 * message ends mid-sentence — and a reader takes that as a truncated line. So the fragment is closed with the
 * fact itself: **the store reported no cause.** An operator then knows the gap is the store's and not our
 * logging, which is exactly the question the canary operator opened with and could not answer from outside.
 *
 * It names internal hosts and ports, which is why it lives in the log line `storeFailureAnswer` writes and no
 * door's body carries it (bundle-30 I8).
 */
export function storeFailureDetail(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const cause = causeOf(err);
  return /caused by ::\s*$/.test(message)
    ? `${message}${cause ?? 'the store reported no cause'}`
    : `${message}${cause && !message.includes(cause) ? ` — ${cause}` : ''}`;
}

/** Classify a throw from a read path into a status, a retryability, and a message that says what happened. */
export function classifyReadFailure(err: unknown): ReadFailure {
  /*
   * A BOUND ENDED IT — first, and in words of our own (bundle-30, `Q-213`). An operation inside a seq hold, or on a
   * push door, carries a write bound (`db/write-bound.ts`), and the driver reports the bound ending it in five
   * shapes, none of which the allowlist below recognised: a timed-out batched write answered 400 here and 500 on a
   * REST write route. The answer is the store's condition, retryable, on every door alike — and never the driver's
   * text, which names internal collections and differs by which side of the socket fired first.
   */
  if (isWriteTimeout(err)) {
    return { status: 503, retryable: true, retryAfterSeconds: 5, error: STORE_TIMEOUT_MESSAGE };
  }
  const message = err instanceof Error ? err.message : String(err);
  const name = text((err as { name?: unknown } | null)?.name) ?? '';
  const code = numeric((err as { code?: unknown } | null)?.code);
  const codeName = text((err as { codeName?: unknown } | null)?.codeName);

  const isStore = STORE_ERROR_NAMES.has(name)
    || (name === 'MongoServerError' && code !== undefined && STORE_ERROR_CODES.has(code))
    || EXECUTOR_ERROR.test(message)
    || SEARCH_STAGE_ERROR.test(message);

  if (!isStore) {
    // Unchanged: a validation refusal, and the caller is the one who can fix it.
    return { status: 400, retryable: false, error: message };
  }

  return {
    status: 503,
    retryable: true,
    // Short, because the condition clears in seconds when it is a blip and in hours when an index is
    // rebuilding — a number that pretends to know which would be worse than a small one plus `retryable`.
    retryAfterSeconds: 5,
    // In our words; the store's code below is the stable identifier, and the driver's text is the log's.
    error: STORE_FAILURE_MESSAGE,
    ...(code !== undefined ? { code } : {}),
    ...(codeName ? { codeName } : {}),
  };
}

/** The answer every door gives a failure that is positively the store's: one status, one wait, one body. */
export interface StoreFailureAnswer {
  status: 503;
  retryAfterSeconds: number;
  body: { error: string; retryable: true; code?: number; codeName?: string };
}

/**
 * The store's failure answered — or `null` when the classifier does not positively identify it as the store's, and
 * the door keeps its own answer (a `400` for a read's refusal, a `500` for a write's unknown fault).
 *
 * ## Why one function (bundle-30 I6, `C1`)
 *
 * Four doors built this answer by hand — the REST read helper, the REST error handler, the MCP dispatcher and the
 * sync push helper — and they differed: the write handler dropped the store's code that the read helper and the tool
 * carry, and the push helper decided its own sentence. The `Retry-After`, the `retryable: true` and the code are now
 * put in here, where no door can leave one out.
 *
 * **There is no audience (bundle-30 I8).** A `caller` used to be told the driver's text and a `peer` our words; but
 * the REST error handler answers routes a peer or an unauthenticated caller reaches, and cannot tell them apart. So
 * every door and every reader gets our words plus the store's stable `code`/`codeName`, and the driver's text —
 * internal hosts, addresses, ports — is logged HERE, once, where no door can answer with it or forget to log it.
 */
export function storeFailureAnswer(err: unknown): StoreFailureAnswer | null {
  const f = classifyReadFailure(err);
  if (!f.retryable) return null;
  log.warn(`Store-side failure answered 503: ${logSafe(storeFailureDetail(err))}`);
  return {
    status: 503, retryAfterSeconds: f.retryAfterSeconds ?? 5,
    body: {
      error: f.error, retryable: true,
      ...(f.code !== undefined ? { code: f.code } : {}),
      ...(f.codeName ? { codeName: f.codeName } : {}),
    },
  };
}
