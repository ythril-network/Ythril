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
 * ## In OUR words, never the driver's (`Q-361`)
 *
 * The answer used to carry the driver's message and its cause, whole. A driver's own error names the host, the port and
 * the namespace it failed on (`connection 5 to 172.16.0.9:27017 closed`), and the REST error handler cannot tell an
 * operator from an anonymous caller — so the only safe rule is one answer for every audience: a sentence of ours, the
 * store's stable `code` / `codeName`, and the driver's text in the log. What decides the sentence is what an error IS
 * (`isDriverSide`, a walk of its chain of causes), never the words in its message: an own refusal that quotes
 * `notes/mongot-setup.md` is a refusal, not a retryable store failure. The STATUS is decided as it always was.
 *
 * ## What this does NOT do, on purpose
 *
 * It does not retry. The canary operator's third option was to retry internally with backoff as the startup
 * probe does, and on 2026-08-19 the cause turned out to be a **dead mongot process** under a degraded array.
 * A retry loop would have turned that into slow successes and hidden a process death from the only two
 * parties who could see it. Say what happened, say it can be retried, and let the caller decide.
 */
import { MongoError, MongoServerError } from 'mongodb';
import { errorChain, wrapsAThrownError } from '../db/error-chain.js';
import { StoreCapabilityError, messageOf } from '../util/errors.js';
import { reportDriverFailure, reportRecurringDriverFailure } from '../util/report-failure.js';

/**
 * What an answer says about a store failure of its own — three sentences, each in one spelling, and never the driver's
 * words (they name internal hosts, addresses, ports and namespaces, and the REST error handler that carries them cannot
 * tell an operator from an anonymous caller: there is one answer for every audience, and the driver's text goes to the
 * log — `reportDriverFailure`).
 *
 *  - `STORE_SIDE_MESSAGE`: the store could not be reached or could not finish — `503`, retryable;
 *  - `STORE_UNAVAILABLE_MESSAGE`: a pooled connection was cleared under a command — the `400` it always had. It says no
 *    "try again", because `retryable` is `false` there;
 *  - `STORE_INCOMPLETE_MESSAGE`: any other driver-side failure with no server answer, and the server codes whose text
 *    carries an address — each at the status it already had.
 */
const STORE_SIDE_MESSAGE =
  'A store-side failure stopped this operation; it is not a problem with your request and can be retried.';
const STORE_UNAVAILABLE_MESSAGE = 'The store is not available right now.';
const STORE_INCOMPLETE_MESSAGE = 'The store could not complete this request.';

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
 * running query is the same condition as one stepping down during boot. The last two are what a saturated or
 * restarting search process produces.
 */
const STORE_ERROR_CODES = new Set([
  11600,  // InterruptedAtShutdown
  91,     // ShutdownInProgress
  11602,  // InterruptedDueToReplStateChange
  189,    // PrimarySteppedDown
  13436,  // NotPrimaryOrSecondary
  50,     // MaxTimeMSExpired — a deadline the store could not meet
  262,    // ExceededTimeLimit
]);

/**
 * `MongoServerError` codes a router or a member reports when it could not reach ANOTHER member — with that member's
 * address in the text. They are the driver's and the topology's condition, not a refusal of the request, so the words go
 * (`isDriverSide`); the status is the one each already had (`400`: this release line does not change a status).
 */
const ADDRESS_ERROR_CODES = new Set([
  6,      // HostUnreachable
  7,      // HostNotFound
  89,     // NetworkTimeout
  9001,   // SocketException
  10107,  // NotWritablePrimary
  13435,  // NotPrimaryNoSecondaryOk
  134,    // ReadConcernMajorityNotAvailableYet
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
  /** The message to return: the caller's own refusal or the server's words, or the store's condition in OUR words. */
  error: string;
  /** The store's own code, when it had one — an operator's fastest route to the real condition. */
  code?: number;
  codeName?: string;
}

/**
 * Is the driver talking about ITS OWN condition anywhere in this error's chain — a socket, a server selection, a pool, a
 * topology, a timeout, an argument it refused — rather than the server answering the caller? Then the text is the
 * driver's and names a host, a port or a namespace, and no answer may carry it.
 *
 * ## Asked of what an error IS, never of what it is called or what it says
 *
 * `instanceof MongoError` and not `MongoServerError` (the server's answer: a malformed query, a failed validation, in
 * the server's own words — a caller fixes their request from them), plus the server codes that report an address or a
 * store condition (`ADDRESS_ERROR_CODES`, `STORE_ERROR_CODES`). A plain `Error` NAMED `MongoNetworkError` is not the
 * driver's, and an own error whose `cause` is one is — the chain is walked (`db/error-chain.ts`). One predicate for the
 * classifier below, `caughtFailureText` and `storedFailureText`: three spellings of "is this the driver's" is how a door
 * comes to answer a text another door withholds. Never throws: it runs inside a `catch`.
 */
export function isDriverSide(err: unknown): boolean {
  try {
    return errorChain(err).some(e => {
      if (!(e instanceof MongoError)) return false;
      if (!(e instanceof MongoServerError)) return true;
      // A bulk write's wrapper around a THROWN error is a `MongoServerError` by class only; what it wraps is next in the chain.
      if (wrapsAThrownError(e)) return false;
      const code = (e as { code?: unknown }).code;
      return typeof code === 'number' && (STORE_ERROR_CODES.has(code) || ADDRESS_ERROR_CODES.has(code));
    });
  } catch {
    return false;
  }
}

/**
 * Every scrap the driver attached that `message` does not already say, in the order an operator would want it.
 *
 * Each part is checked on its OWN against the message and the parts before it. The check used to compare the message
 * with all the parts joined, which never matched once there were two — so a driver that put the same text in its
 * message, its `errmsg` and its `cause` was logged as `X — X — X` (bundle-30 I12, verify-drive-2 finding 4).
 */
function causeOf(err: unknown, message: string): string | undefined {
  const e = err as Record<string, unknown> | null;
  if (!e) return undefined;
  const parts: string[] = [];
  const add = (part: string): void => {
    const p = part.trim();
    if (p && !message.includes(p) && !parts.some(q => q.includes(p))) parts.push(p);
  };
  for (const key of ['errmsg', 'codeName']) {
    const v = e[key];
    if (typeof v === 'string') add(v);
  }
  // `cause` is where a driver puts the wrapped error, and it is the field the empty `caused by ::` was hiding.
  const nested = e['cause'];
  if (nested) add(messageOf(nested));
  const info = e['errInfo'];
  if (info && typeof info === 'object') {
    try { add(JSON.stringify(info)); } catch { /* unserialisable — skip rather than throw in a catch */ }
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
 * It names internal hosts and ports, which is why it is written to the log by `reportDriverFailure` and no door's
 * body carries it (bundle-30 I8).
 */
export function storeFailureDetail(err: unknown): string {
  try {
    const message = messageOf(err);
    const cause = causeOf(err, message);
    return /caused by ::\s*$/.test(message)
      ? `${message}${cause ?? 'the store reported no cause'}`
      : `${message}${cause ? ` — ${cause}` : ''}`;
  } catch {
    return STORE_INCOMPLETE_MESSAGE;
  }
}

/** Is this a driver error for a pooled connection cleared under a command? A class the driver does not export, so by name. */
const isPoolCleared = (e: object): boolean => e instanceof MongoError && e.name === 'MongoPoolClearedError';

/**
 * Classify a throw from a read path into a status, a retryability, and a message that says what happened.
 *
 * ## Whose words the answer is in
 *
 * The status is decided as it always was — the outermost error's class name or server code — and the TEXT is decided by
 * what the error is (`isDriverSide`), not by what it says:
 *
 *  - **a failure of the store** (a name or a code above, or the message shape of a failed stage read from an error the
 *    DRIVER raised): `503`, retryable, `STORE_SIDE_MESSAGE`, and the store's own `code` / `codeName` — stable, and an
 *    operator's fastest route to the condition;
 *  - **our own capability sentence** (`StoreCapabilityError`): `503` in its own words — it is ours, it tells an operator
 *    what to do, and it names nothing the caller may not read;
 *  - **any other driver-side failure with no server answer**: `400`, as before, in `STORE_UNAVAILABLE_MESSAGE` or
 *    `STORE_INCOMPLETE_MESSAGE`, with the driver's text for the log;
 *  - **everything else**: `400` with the text unchanged — what OUR code refused and what the SERVER refused (a
 *    malformed query, a failed validation) are how the caller fixes the request.
 *
 * The message patterns are read only from an error the DRIVER raised. Read from any error they matched our own
 * refusals: a strict-linkage reference refusal quotes the caller's reference, so `to: "notes/mongot-setup.md"` was
 * answered `503 retryable` — a client told to retry its own refusal for ever (bundle-30 I13).
 *
 * Pure: it logs nothing. The door that answers withholds the driver's text and logs it once (`sendReadFailure`,
 * `caughtFailureText`, the MCP dispatcher's own line).
 */
export function classifyReadFailure(err: unknown): ReadFailure {
  const message = messageOf(err);
  if (err instanceof StoreCapabilityError) {
    return { status: 503, retryable: true, retryAfterSeconds: 5, error: message };
  }
  const name = text((err as { name?: unknown } | null)?.name) ?? '';
  const code = numeric((err as { code?: unknown } | null)?.code);
  const codeName = text((err as { codeName?: unknown } | null)?.codeName);
  const chain = errorChain(err);
  const fromDriver = chain.some(e => e instanceof MongoError);

  const isStore = STORE_ERROR_NAMES.has(name)
    || (name === 'MongoServerError' && code !== undefined && STORE_ERROR_CODES.has(code))
    || (fromDriver && (EXECUTOR_ERROR.test(message) || SEARCH_STAGE_ERROR.test(message)));

  if (!isStore) {
    if (isDriverSide(err)) {
      return {
        status: 400, retryable: false,
        error: chain.some(isPoolCleared) ? STORE_UNAVAILABLE_MESSAGE : STORE_INCOMPLETE_MESSAGE,
      };
    }
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
    error: STORE_SIDE_MESSAGE,
    ...(code !== undefined ? { code } : {}),
    ...(codeName ? { codeName } : {}),
  };
}

/**
 * What kind of store failure this is, for a window that treats two of one kind as one condition: the driver error's
 * `codeName`, else its `code`, else its class name — never its text, which names a host and changes with every
 * occurrence. Never throws.
 */
function failureKind(err: unknown): string {
  try {
    const driverError = (errorChain(err).find(e => e instanceof MongoError) ?? err) as
      { codeName?: unknown; code?: unknown; name?: unknown } | null;
    const code = numeric(driverError?.code);
    return text(driverError?.codeName) ?? (code !== undefined ? `code ${code}` : undefined) ?? text(driverError?.name) ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * `classifyReadFailure`, and the driver's text logged ONCE when the answer replaced it — for the doors that answer a
 * failure from its classification (`sendReadFailure`) and the text-only twin below. The forgettable half is the log:
 * an answer in our words that left the driver's text nowhere would hide the one thing an operator came to read.
 * `operation` is what was being done, as the operator will search for it. Never throws.
 *
 * `recurring` is for a door whose failures arrive at the rate of its callers (a read route): the text is then logged
 * once per window for each (operation, kind of failure), not once per call (`reportRecurringDriverFailure`).
 */
export function classifyAndReportFailure(err: unknown, operation: string, { recurring = false }: { recurring?: boolean } = {}): ReadFailure {
  const failure = classifyReadFailure(err);
  if (failure.error !== messageOf(err)) {
    if (recurring) reportRecurringDriverFailure(operation, failureKind(err), storeFailureDetail(err));
    else reportDriverFailure(operation, storeFailureDetail(err));
  }
  return failure;
}

/**
 * The text a catch that ANSWERS an error says — `res.status(n).json({ error: caughtFailureText(err, '…') })`, an act's
 * `{ status, error }`, a failure pushed onto a list a caller reads.
 *
 * One function for every catch that answers an error's text: a driver's message names the host, the port
 * and the namespace it failed on, and the doors they answer reach callers who may be anonymous. What this says is what
 * `classifyReadFailure` says, so every door answers a failure in the same words: our own error and the server's refusal
 * are their own text, unchanged (the caller reads what to fix), and anything the driver raised on its own side — anywhere
 * in the chain of causes, so an own wrapper that quotes it is not "ours" — is one of the three sentences. The status stays
 * the catch's own.
 *
 * **The driver's text goes to the log, once, at warn, naming `operation`** — the forgettable half, put inside so no
 * caller can drop it. `operation` is what was being done, as the operator will search for it (`'revoke token'`), not the
 * file. Never throws; it runs inside a `catch`, where a throw replaces the answer it exists to give.
 */
export function caughtFailureText(err: unknown, operation: string): string {
  try {
    return classifyAndReportFailure(err, operation).error;
  } catch {
    return STORE_INCOMPLETE_MESSAGE;
  }
}

/**
 * The text a failure is STORED with, for a record a later reader is served (`lastError` of an embed job, `safeError` of
 * a media job, a sync cycle's failure list): an own error keeps its message — an embedder that is down says so in its own
 * words and an operator reads which — and a driver-side failure is `STORE_INCOMPLETE_MESSAGE` plus the error's class, which
 * is stable, so records that group by their text (`failedByReason`) still group two outages of one kind against different
 * hosts. The driver's text goes to the log, as `caughtFailureText` does — but once per window for each (operation, kind
 * of failure), because a stored failure is one per job and an outage fails every job: a thousand warnings say nothing
 * the first one did not (`reportRecurringDriverFailure`).
 */
export function storedFailureText(err: unknown, operation: string): string {
  try {
    if (!isDriverSide(err)) return messageOf(err);
    reportRecurringDriverFailure(operation, failureKind(err), storeFailureDetail(err));
    const driverError = errorChain(err).find(e => e instanceof MongoError);
    const label = text((driverError as { codeName?: unknown } | undefined)?.codeName)
      ?? text((driverError as { name?: unknown } | undefined)?.name);
    return label ? `${STORE_INCOMPLETE_MESSAGE} (${label})` : STORE_INCOMPLETE_MESSAGE;
  } catch {
    return STORE_INCOMPLETE_MESSAGE;
  }
}
