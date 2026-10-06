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
 * ## Positively identified, by what the driver says the error IS — never by its name
 *
 * The unsafe direction is calling a genuine client error retryable: a caller who retries a malformed filter for
 * ever has been given a worse answer than the one we started with. So a failure only becomes a 503 when something
 * POSITIVELY identifies it as the store's condition — and that something is the driver's CLASS (a network or system
 * failure, a closed topology), the LABELS the driver attaches to "the connection or the topology failed, try again",
 * or the server's code. It used to be a list of `err.name`s, and a list of names cannot see a subclass: the error the
 * driver throws when it clears its pool is a `MongoNetworkError` by class and `MongoPoolClearedError` by name — a
 * class the driver does not even export — so the request in flight when a store went away was answered `400` with
 * the driver's text, naming the internal host, address and port (bundle-30 I12, verify-drive-2 finding 1).
 *
 * **What deliberately stays 400:** every validation refusal we raise ourselves (a bad filter, an unknown
 * operator, a projection conflict, an out-of-range parameter) — all of which are refused before Mongo is
 * reached, which is why this classifier sees so few of them — and what the SERVER refused in its own words: a
 * `MongoServerError` whose code is not a store condition is a malformed query or a validation failure. A bulk
 * write's `MongoBulkWriteError` is one only when the server answered it (a document refused, a duplicate key): the
 * same class also wraps whatever was THROWN under a bulk write, and that is classified by what it wraps
 * (`db/error-chain.ts`) — read by its class, a paused store was a `400` naming its address (bundle-30 I14).
 *
 * **What is never a 400, recognised or not: a driver-side error.** Anything else the driver raises on its own side
 * (`MongoError`, not `MongoServerError`) is not the caller's to fix and its message is the driver's — so an
 * unrecognised one is a `500` in words of ours, logged with its stack, rather than a door's default `400` carrying it.
 *
 * **The question "is it the store's?" is `db/store-condition.ts`'s**, which the boot retry and the housekeeping walk ask
 * too; this module answers a DOOR with it. One answer it must not give is "retry" for a write concern the deployment can
 * never meet: that is a `500`, not retryable, carrying the server's code (bundle-53 G1, Q-343).
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
import { isStoreCondition, unsatisfiableWriteConcern } from '../db/store-condition.js';
import { isWriteTimeout, STORE_RETRY_SENTENCE } from '../db/write-timeout.js';
import { log, logSafe } from '../util/log.js';
import { warnOnce } from '../util/warn-once.js';

/** What every door answers for an operation a bound ended: the store's condition, said without the store's text. */
const STORE_TIMEOUT_MESSAGE = `The database did not complete this operation in time. ${STORE_RETRY_SENTENCE}`;
/**
 * What every door answers for any other store failure: the condition, never our collection names or the driver's
 * text. The driver's message names internal hosts, addresses and ports (`connection 5 to 172.16.0.9:27017 closed`),
 * and the REST error handler that answers with this cannot tell an operator from an anonymous caller — so there is
 * one answer for every audience, and the driver's text goes to the log (`storeFailureDetail`), bundle-30 I8.
 */
const STORE_FAILURE_MESSAGE = `A store-side failure stopped this operation. ${STORE_RETRY_SENTENCE}`;
/**
 * What every door answers for a driver-side error nothing here recognises: not the caller's fault, not known to be
 * transient, and never in the driver's words. The cause is in the log, under the request's id.
 */
const DRIVER_FAULT_MESSAGE = 'An internal database fault stopped this operation; its cause is in the server log.';
/**
 * What every door answers for a write concern the deployment can never meet (bundle-53 G1, Q-343): not the caller's
 * fault and not a condition that clears, so it says the opposite of every retryable answer here — and never the
 * driver's words, which name the deployment's members. What the operator needs (the code, the driver's text) is in the
 * log, once per operation and code per window. Named and exported so the one place the docs word this answer can be
 * held to it: the answer's `code` / `codeName` and this sentence are an integrator's reference.
 */
export const UNSATISFIABLE_WRITE_CONCERN_MESSAGE = 'The database cannot satisfy the write concern this instance writes with, so the write was not confirmed. '
  + 'Retrying will not help: the operator must change the write concern or the deployment; the cause is in the server log (not retryable).';
/**
 * What an act's refusal says in place of a driver's own words (`refusalText`): the database refused the operation for a
 * reason that is not ours to word. Never a part of the driver's text; that is in the log.
 */
export const DRIVER_REFUSAL_MESSAGE = 'The database refused this operation; the reason is in the server log.';

/** One warning per operation and code per minute for the unsatisfiable write concern, which every write meets until it is fixed. */
const WRITE_CONCERN_WARNING_WINDOW_MS = 60_000;
const unsatisfiableWarnings = warnOnce<string>({ every: WRITE_CONCERN_WARNING_WINDOW_MS });

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
  if (nested) add(nested instanceof Error ? nested.message : String(nested));
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
 * It names internal hosts and ports, which is why it lives in the log line `storeFailureAnswer` writes and no
 * door's body carries it (bundle-30 I8).
 */
export function storeFailureDetail(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const cause = causeOf(err, message);
  return /caused by ::\s*$/.test(message)
    ? `${message}${cause ?? 'the store reported no cause'}`
    : `${message}${cause ? ` — ${cause}` : ''}`;
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
  /*
   * A WRITE CONCERN THE DEPLOYMENT CAN NEVER MEET (bundle-53 G1, Q-343) — before the store's condition is asked, because
   * it would otherwise be answered by it: the same driver classes (a write concern error, a bulk error carrying one) are
   * the store's when they are a timeout, and a 503 here is a request to repeat a configuration fault for ever. Read
   * through the chain, so a sliced bulk write (`db/one-command.ts`) whose cause is the stopping error is seen as it is.
   * A 500 in words of ours, carrying the code and the server's name for it, never retryable.
   */
  const unsatisfiable = unsatisfiableWriteConcern(err);
  if (unsatisfiable) {
    return { status: 500, retryable: false, error: UNSATISFIABLE_WRITE_CONCERN_MESSAGE, code: unsatisfiable.code, codeName: unsatisfiable.codeName };
  }
  const message = err instanceof Error ? err.message : String(err);
  // Looked through our wrappers and the driver's own nesting: a store failure wrapped by a writer is still the store's.
  const chain = errorChain(err);
  /*
   * What the SERVER answered with, wherever it sits in the chain. A bulk write's wrapper around a thrown error is a
   * `MongoServerError` by class and the server's answer by nothing else (`wrapsAThrownError`): counted as one, a
   * driver refusal under a bulk write was answered `400` in the driver's words (bundle-30 I14).
   */
  const serverAnswered = chain.filter(e => e instanceof MongoServerError && !wrapsAThrownError(e));
  // The store's code, from the server's error wherever it sits in the chain — else from the outermost error.
  const coded = serverAnswered[0] ?? err;
  const code = numeric((coded as { code?: unknown } | null)?.code);
  const codeName = text((coded as { codeName?: unknown } | null)?.codeName);

  /*
   * The message patterns are read only from an error the DRIVER raised (bundle-30 I13, pre-ship reliability R3). Read
   * from any error, they matched our own refusals: a strict-linkage reference refusal quotes the caller's reference
   * and the space id, so `to: "notes/mongot-setup.md"`, or any reference in a space named `mongotest`, was answered
   * `503 retryable` — a client told to retry its own refusal for ever.
   */
  const isStore = chain.some(isStoreCondition)
    || (chain.some(e => e instanceof MongoError) && (EXECUTOR_ERROR.test(message) || SEARCH_STAGE_ERROR.test(message)));

  if (!isStore) {
    /*
     * A driver-side error nothing above recognises is still the driver's, never the caller's: its message is the
     * driver's (hosts, addresses, collection names) and nothing the caller sends differently will change it. What the
     * SERVER refused (`MongoServerError`) is a malformed query or a validation failure, in the server's own words.
     */
    const driverSide = chain.find(e => e instanceof MongoError);
    if (driverSide && serverAnswered.length === 0) {
      return { status: 500, retryable: false, error: DRIVER_FAULT_MESSAGE };
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
    error: STORE_FAILURE_MESSAGE,
    ...(code !== undefined ? { code } : {}),
    ...(codeName ? { codeName } : {}),
  };
}

/**
 * Rethrow a failure on the store's side; return for anything else.
 *
 * For the shared "act" functions that turn what an operation throws into a status and a sentence for both doors
 * (`renameSpaceAct`, `applySpaceCreate`, a network join). Their last-resort branch answered `500` with the exception's
 * message, so a store failure reached a caller as the driver's text with a status that said nothing about retrying
 * (bundle-30 I12, `space_rename` in the every-door gate). An act decides REFUSALS; the store's failure is not one, and
 * rethrown it reaches the door's one failure path — the REST error handler or `callTool` — and is answered as every
 * door answers it. Pure: it logs nothing, since the door that answers logs it once.
 */
export function throwIfStoreSide(err: unknown): void {
  if (classifyReadFailure(err).status >= 500) throw err;
}

/**
 * Run a step whose OWN failure an act survives — logged, and the act goes on — unless the store failed it: that is
 * rethrown, so the door answers `503` and the caller retries.
 *
 * For the steps after an act's irreversible one (a file's bytes unlinked or moved). Each used to be a
 * `.catch(log.warn)`, so with the store paused a delete removed the bytes, failed every store step after them, and
 * answered `204` — leaving metadata for a file that no longer existed and telling nobody to retry (bundle-30 I14,
 * verify-drive-4 D1). The step that marks an act as still owed (a file's metadata record) runs last, so the retry
 * finds it and completes the act.
 */
export async function unlessTheStoreFailed(what: string, step: () => Promise<unknown>): Promise<void> {
  try {
    await step();
  } catch (err) {
    throwIfStoreSide(err);
    log.warn(`${logSafe(what)}: ${logSafe(err instanceof Error ? err.message : String(err))}`);
  }
}

/**
 * The answer every door gives a failure on the store's side: one status, one wait, one body.
 *
 * `503` with `retryAfterSeconds` for the store's condition; `500` with neither for a driver error nothing recognises —
 * a door that sends a `Retry-After` on that would invite a retry nobody knows will help. The same `500`, with the
 * server's `code` and `codeName` in the body and `retryable: false`, for a write concern the deployment can never meet
 * (Q-343): it is the operator's to change, so the body names it and says not to retry.
 */
export interface StoreFailureAnswer {
  status: 503 | 500;
  retryAfterSeconds?: number;
  body: { error: string; retryable: boolean; code?: number; codeName?: string };
}

/**
 * The sentence an act puts in a REFUSAL — and the driver's words are never in it (bundle-53 G1, Q-335 module half; SEC-1).
 *
 * For the acts that decide a refusal from what a lookup threw (`renameSpaceAct`, `applySpaceCreate`, a network join): three
 * of them read `err.message` for "not found" / "already exists" and answered it. A `MongoServerError` the server raised for
 * something else — whose text holds one of those words, and names the internal collection, the index and the values — was
 * read as a refusal and put in a caller's hands, and the store failing in the middle of the act was read as the caller's
 * mistake. So the decision is the store's FIRST, and the words are ours:
 *
 * - a failure on the store's side is rethrown (`throwIfStoreSide`: the door answers it as every door does);
 * - our own error's message is returned as it is — it is the act's refusal in the act's words;
 * - anything the DRIVER raised that is not on the store's side (a server refusal) returns ONE generic sentence, and its
 *   text goes to the log, where an operator reads it and no caller does.
 */
export function refusalText(err: unknown): string {
  throwIfStoreSide(err);
  if (errorChain(err).some(e => e instanceof MongoError)) {
    log.warn(`A database refusal was answered in our words: ${logSafe(storeFailureDetail(err))}`);
    return DRIVER_REFUSAL_MESSAGE;
  }
  return err instanceof Error ? err.message : String(err);
}

/**
 * The store's failure answered — or `null` when the failure is not on the store's side at all, and the door keeps its
 * own answer (a `400` for a read's refusal, a `500` for a write's unknown fault). A driver error that is not
 * recognised as the store's condition is answered here too, as a `500` in our words: left to a door, it was a `400`
 * carrying the driver's text (bundle-30 I12).
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
export function storeFailureAnswer(err: unknown, where: string): StoreFailureAnswer | null {
  const f = classifyReadFailure(err);
  if (f.status < 500) return null;
  // The operation it failed — REQUIRED, because this is the one place the line is built and every door writes it
  // through here. Optional, only a route's own catch passed it (bundle-30 I13, O2): the read helper, the app's error
  // handler and the MCP dispatcher logged a store failure naming no route and no tool (I15, preship-3 P3-4).
  // `a-store-failure-log-line-names-its-operation.test.js` holds every call to it.
  const at = where ? ` (${logSafe(where)})` : '';
  if (!f.retryable) {
    if (f.code !== undefined) {
      // A write concern the deployment cannot meet: every write meets it until an operator changes it, so ONE line per
      // operation and code per window — with the driver's text, which names the members and is not in the answer — and
      // not one per request. The code and its name travel in the body, where a caller tells it from a fault of ours.
      unsatisfiableWarnings(`${where}|${f.code}`, () => {
        log.warn(`Write concern the deployment cannot meet answered 500${at}: ${logSafe(storeFailureDetail(err))} — `
          + 'every write fails until the write concern or the deployment is changed');
      });
      return { status: 500, body: { error: f.error, retryable: false, code: f.code, ...(f.codeName ? { codeName: f.codeName } : {}) } };
    }
    // Not recognised, so the stack is what an operator needs: the meta argument keeps it (`fmt`).
    log.error(`Database driver failure answered 500${at}:`, err);
    return { status: 500, body: { error: f.error, retryable: false } };
  }
  log.warn(`Store-side failure answered 503${at}: ${logSafe(storeFailureDetail(err))}`);
  return {
    status: 503, retryAfterSeconds: f.retryAfterSeconds ?? 5,
    body: {
      error: f.error, retryable: true,
      ...(f.code !== undefined ? { code: f.code } : {}),
      ...(f.codeName ? { codeName: f.codeName } : {}),
    },
  };
}
