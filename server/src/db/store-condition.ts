/**
 * "THE STORE CANNOT ANSWER" — one question, asked of one module (bundle-53 G1; Q-330, Q-343).
 *
 * ## Why it is a module of its own
 *
 * The question was asked in two places that disagreed. `brain/store-failure.ts` answered it for a caller ("is this a
 * 503?") from the driver's class, its labels and the server's code; `db/mongo.ts` answered it for the boot retry
 * ("may the connect be tried again?") from a list of its own. A third asker, the housekeeping walk, needs it to decide
 * whether one failing space is the space's or the store's. Three answers to one question is how a store failure got
 * answered as "an internal fault" for a pool that had run out of connections, and how a write concern that can never be
 * met was told to the caller as "retry".
 *
 * It lives in `db/` and imports nothing from `brain/`, so every layer that must ask can: `brain/store-failure.ts`
 * answers a door with it, the walk and the boot retry decide with it.
 *
 * ## What counts, and what that is read from
 *
 * A failure is the store's condition only when something POSITIVELY identifies it — the driver's CLASS, the LABELS the
 * driver attaches to "the connection or the topology failed", or the server's CODE — never the wording, with one
 * deliberate exception stated at {@link unsatisfiableWriteConcern}. The unsafe direction is calling a caller's own
 * error retryable: a caller who retries a malformed filter for ever has a worse answer than the one we started with.
 *
 * **The kind that matched is part of the answer** ({@link storeConditionKind}). A class or a code is a statement about
 * the store; a label alone is the driver's "try again", which a failing space can also carry. The walk reads a
 * label-only match as the store being down only when the store itself does not answer a ping (O4).
 *
 * ## The connection pool's two errors, and why they are matched the way they are (Q-330)
 *
 * The driver raises two errors from its connection pool that are NOT network errors: `PoolClosedError` and
 * `WaitQueueTimeoutError`, both `MongoDriverError`s. Keyed on the network class, an exhausted or closed pool — the store
 * not answering, from the caller's side — was "an unrecognised driver fault": a 500, never retried. They are matched by
 * `instanceof MongoDriverError` (the driver exports it) AND by their INSTANCE name — the `get name()` getters in
 * `cmap/errors.js`, which are `MongoPoolClosedError` and `MongoWaitQueueTimeoutError`; the classes themselves are
 * `PoolClosedError` / `WaitQueueTimeoutError`, and neither class is exported from the package, so the name is the only
 * handle there is. **Both halves are required**: a plain `Error` that happens to carry the name is not the driver's.
 * Nothing here reaches the driver through `createRequire` (O9): a classifier that loads a driver internal by path stops
 * matching, silently, on the upgrade that moves it.
 *
 * ## An unsatisfiable write concern is NOT the store's condition
 *
 * A write concern the deployment can never meet (`w: 5` on a three-member set; any `w > 1` on a standalone) is a
 * configuration fault. It clears when an operator changes the configuration, never by waiting — so an answer that says
 * "retry" is a request to repeat it for ever. It is excluded from {@link isStoreCondition}, so
 * {@link isStoreUnreachable} is false for it, and `classifyReadFailure` answers it 500, not retryable.
 */
import {
  MongoBulkWriteError, MongoClientClosedError, MongoDriverError, MongoError, MongoErrorLabel, MongoNetworkError,
  MongoNotConnectedError, MongoServerClosedError, MongoServerError, MongoStalePrimaryError, MongoSystemError,
  MongoTopologyClosedError, MongoWriteConcernError,
} from 'mongodb';
import { errorChain, wrapsAThrownError } from './error-chain.js';
import { writeErrorCode } from './write-errors.js';

/**
 * Driver classes that mean "there is no store to talk to right now" — matched with `instanceof`, so every subclass
 * the driver derives from one is matched with it: `MongoNetworkError` takes in the timeout, the pool-cleared and the
 * pool-cleared-on-network errors; `MongoSystemError` takes in server selection. The rest are a client or topology
 * that is closed or not connected, and a primary that is no longer one.
 */
export const STORE_CONDITION_CLASSES = [
  MongoNetworkError, MongoSystemError, MongoTopologyClosedError, MongoNotConnectedError, MongoServerClosedError,
  MongoClientClosedError, MongoStalePrimaryError,
] as const;

/**
 * The INSTANCE names of the pool's two checkout errors (`Q-330`), which are `MongoDriverError`s and not network errors.
 * The driver's own `get name()` spellings — see the module docblock for why these and not the class names.
 */
export const POOL_CHECKOUT_ERROR_NAMES: readonly string[] = ['MongoWaitQueueTimeoutError', 'MongoPoolClosedError'];

/**
 * The labels the driver (or the server) attaches to a failure of the connection, the pool or the topology — the
 * driver's own "this is retryable" — whatever class or code carries them.
 */
export const STORE_CONDITION_LABELS: readonly string[] = [
  MongoErrorLabel.ResetPool, MongoErrorLabel.PoolRequestedRetry, MongoErrorLabel.InterruptInUseConnections,
  MongoErrorLabel.RetryableWriteError, MongoErrorLabel.TransientTransactionError,
  MongoErrorLabel.UnknownTransactionCommitResult, MongoErrorLabel.SystemOverloadedError, MongoErrorLabel.RetryableError,
];

/**
 * `MongoServerError` codes that mean "not answerable right now", by code because the class cannot decide.
 *
 * A replica set stepping down under a running query is the same condition as one stepping down during boot, and the
 * rest are the network and primary conditions the driver itself retries a read on: a router or a member reporting that
 * it could not reach another reports it with the address in its message, which is exactly the text no answer may carry.
 *
 * The two deadline codes, 50 `MaxTimeMSExpired` and 262 `ExceededTimeLimit`, are NOT here, and the absence is
 * deliberate: `isWriteTimeout` (the first branch of `classifyReadFailure`, through `db/max-time.ts`) answers both, so
 * a row for them here could never be reached — and a reader who found one would believe a deadline is answered with
 * the driver's text, which it is not (bundle-30 I6, D1). `store-failure-is-not-a-400` still holds both to a 503.
 */
export const STORE_ERROR_CODES: ReadonlySet<number> = new Set([
  11600,  // InterruptedAtShutdown
  91,     // ShutdownInProgress
  11602,  // InterruptedDueToReplStateChange
  189,    // PrimarySteppedDown
  13436,  // NotPrimaryOrSecondary
  6,      // HostUnreachable
  7,      // HostNotFound
  89,     // NetworkTimeout
  9001,   // SocketException
  10107,  // NotWritablePrimary
  13435,  // NotPrimaryNoSecondaryOk
  134,    // ReadConcernMajorityNotAvailableYet
]);

/**
 * The write concern codes that say the deployment can never meet what was asked: 100 `UnsatisfiableWriteConcern` (more
 * acknowledgements than the set has members) and 79 `UnknownReplWriteConcern` (a named concern that is not configured).
 * The server's names, for the answer's `codeName`: a bulk write's concern error is a plain document that carries none.
 */
export const UNSATISFIABLE_WRITE_CONCERN_CODES: ReadonlySet<number> = new Set([100, 79]);
const CODE_NAMES: Readonly<Record<number, string>> = {
  100: 'UnsatisfiableWriteConcern',
  79: 'UnknownReplWriteConcern',
  2: 'BadValue',
};

/**
 * The text a standalone mongod answers a `w > 1` with. Verified against the harness's mongod (probe P5). It is the
 * exception to "never the wording", and the reason is stated here, once: a standalone answers with code 2 `BadValue`,
 * the same code a document the server refuses for its own content carries (`db/write-errors.ts` lists it as a
 * document's refusal), so no code or class separates them — only this text does. It is read from an error the DRIVER
 * raised and nothing else, and only beside code 2, so no text a caller or a peer wrote can take it.
 */
const STANDALONE_WRITE_CONCERN_TEXT = "cannot use 'w' > 1 when a host is not replicated";

/** Which kind of evidence matched: a class (or the pool's names), a server code, or only a label. */
export type StoreConditionKind = 'class' | 'code' | 'label';

/**
 * `hasErrorLabel`, never throwing. It reads a set the driver's constructor makes, and an error built any other way
 * (a subclass whose constructor failed part-way, a deserialised one) has none — this runs inside every door's
 * `catch`, the one place an exception of its own would replace the answer it exists to give.
 */
function hasLabel(e: MongoError, label: string): boolean {
  try { return e.hasErrorLabel(label); } catch { return false; }
}

/** The pool refused to hand out a connection: closed, or none came free in time. A driver error by class AND by name. */
function isPoolCheckoutFailure(e: MongoError): boolean {
  return e instanceof MongoDriverError && POOL_CHECKOUT_ERROR_NAMES.includes(e.name);
}

/** The refused documents of a bulk write's error (typed one-or-many; an array at runtime). */
const refusedDocuments = (e: MongoBulkWriteError): unknown[] => ([] as unknown[]).concat(e.writeErrors ?? []);

/**
 * The write concern code a write's error carries, when it is a WRITE CONCERN failure: a single write's
 * `MongoWriteConcernError.code`, or a bulk write's `result.getWriteConcernError().code` — on the result and not on the
 * wrapper — in a bulk error that refused no document (`bulk/common.js` raises a document's refusal first, so a bulk
 * error with `writeErrors` is the documents'). A bulk wrapper around an error that was THROWN is the thrown error's.
 */
function writeConcernCodeOf(e: MongoError): number | undefined {
  if (e instanceof MongoWriteConcernError) return typeof e.code === 'number' ? e.code : undefined;
  if (!(e instanceof MongoBulkWriteError) || wrapsAThrownError(e) || refusedDocuments(e).length > 0) return undefined;
  // On the result; or on the wrapper, which the driver copies the concern's code onto when it raises it from a thrown one.
  const code = bulkWriteConcernError(e)?.code ?? e.code;
  return typeof code === 'number' ? code : undefined;
}

/** A bulk write's reported write concern error, or none — never throwing, for an error built any other way. */
function bulkWriteConcernError(e: MongoBulkWriteError): { code?: unknown } | undefined {
  try { return e.result?.getWriteConcernError(); } catch { return undefined; }
}

/** Does this driver error say, in the one text a standalone mongod uses, that its `w > 1` cannot be met? */
function saysStandaloneRefusal(e: MongoError): boolean {
  if (!(e instanceof MongoServerError)) return false;
  const says = (text: unknown): boolean => typeof text === 'string' && text.includes(STANDALONE_WRITE_CONCERN_TEXT);
  if (e.code === 2 && (says(e.message) || says((e as { errmsg?: unknown }).errmsg))) return true;
  // A bulk write's per-operation failures: the code and the text are on the entry or on its `err`, by driver path.
  if (!(e instanceof MongoBulkWriteError)) return false;
  return refusedDocuments(e).some((w) => {
    const entry = w as { errmsg?: unknown; err?: { errmsg?: unknown } } | null;
    return writeErrorCode(w) === 2 && (says(entry?.errmsg) || says(entry?.err?.errmsg));
  });
}

/** This one error — not what it wraps — as an unsatisfiable write concern: its code and the server's name for it. */
function unsatisfiableOf(e: object): { code: number; codeName: string } | null {
  if (!(e instanceof MongoError)) return null;
  const code = writeConcernCodeOf(e);
  if (code !== undefined && UNSATISFIABLE_WRITE_CONCERN_CODES.has(code)) return { code, codeName: CODE_NAMES[code]! };
  return saysStandaloneRefusal(e) ? { code: 2, codeName: CODE_NAMES[2]! } : null;
}

/**
 * Is this failure — or one it wraps (`errorChain`) — a write concern the deployment can never meet? Then it is
 * `{ code, codeName }`: the code is the server's (100, 79; or 2 for a standalone's `w > 1`), the name is the server's
 * name for it. Driver errors only, and by code — the one text match is {@link STANDALONE_WRITE_CONCERN_TEXT}.
 */
export function unsatisfiableWriteConcern(err: unknown): { code: number; codeName: string } | null {
  for (const e of errorChain(err)) {
    const found = unsatisfiableOf(e);
    if (found) return found;
  }
  return null;
}

/** {@link unsatisfiableWriteConcern}, as the yes/no a guard asks. */
export function isUnsatisfiableWriteConcern(err: unknown): boolean {
  return unsatisfiableWriteConcern(err) !== null;
}

/**
 * The store applied a write and could not confirm the durability it was asked for — a single write's
 * `MongoWriteConcernError`, or a bulk write that reports a write concern failure and refused no document.
 *
 * The store's condition, not the caller's (bundle-30 I14): no caller chooses a write concern here, so nothing the
 * caller sends differently changes it — and the sentence every door answers it with, "it did not complete as far as
 * this server can confirm", is exactly what a write concern TIMEOUT is. **Not an unsatisfiable one**: see
 * {@link storeConditionKind}, which tests that first.
 */
function isWriteConcernFailure(e: MongoError): boolean {
  if (e instanceof MongoWriteConcernError) return true;
  return e instanceof MongoBulkWriteError && refusedDocuments(e).length === 0 && !!bulkWriteConcernError(e);
}

/**
 * Which kind of evidence says this one error — not what it wraps — is the store's condition, or `null` when none does.
 * An unsatisfiable write concern is `null` whatever else it carries (a label the driver attached, a code it shares).
 */
export function storeConditionKind(e: object): StoreConditionKind | null {
  if (!(e instanceof MongoError)) return null;
  if (unsatisfiableOf(e)) return null;
  if (STORE_CONDITION_CLASSES.some(C => e instanceof C) || isPoolCheckoutFailure(e)) return 'class';
  if (isWriteConcernFailure(e) || (e instanceof MongoServerError && typeof e.code === 'number' && STORE_ERROR_CODES.has(e.code))) return 'code';
  if (STORE_CONDITION_LABELS.some(label => hasLabel(e, label))) return 'label';
  return null;
}

/** Is this one error — not what it wraps — the store's condition, by class, label, server code or write concern timeout? */
export function isStoreCondition(e: object): boolean {
  return storeConditionKind(e) !== null;
}

/**
 * Can the store not be reached or not answer: this failure, or an error it wraps, is the store's condition. The one
 * question the boot retry, the housekeeping walk and `classifyReadFailure` ask — each reads it through the chain.
 */
export function isStoreUnreachable(err: unknown): boolean {
  return errorChain(err).some(isStoreCondition);
}
