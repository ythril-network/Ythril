/**
 * How long ONE database operation, and one seq HOLD, may take — and the scope that carries the bound to every
 * operation issued inside it (`Q-213`, bundle-30 plan §A).
 *
 * ## The defect
 *
 * `withAllocatedSeqs` and `withSeqHorizonHeld` (`util/seq.ts`) hold a floor every seq-paged reader of the space stops
 * below, and release it when the write settles. Nothing bounded the write. A document lock held by another session,
 * a stalled socket, or `withTransaction` retrying a conflict for its default 120 s held the floor for as long as it
 * waited — and every peer pulling that space was served nothing above it, while every cycle reported success over
 * an empty page.
 *
 * ## The rule
 *
 * **A write the bound ended never lands, and the answer is given only after the SERVER's deadline has passed.** A
 * hold is released, and a door answers `503`, when the server can no longer apply the write — never while the write
 * is alive and could still land (a hold released under a write that lands later is `Q-196`, the defect the hold
 * exists for; found again by main's CI run 37231507558 as a fork that landed after the next case's wipe, `Q-372`).
 *
 * ### The order the bound ends a write in
 *
 * A plain write (no session) is bounded in TWO steps, and the order is the point:
 *
 *  1. **The server first.** The operation carries an explicit `maxTimeMS` = the bound, and NO driver `timeoutMS`.
 *     With `timeoutMS` the driver arms its own timer when the operation STARTS (before it has a connection) and
 *     derives the wire `maxTimeMS` from what is left when it builds the command, so the client's deadline is
 *     always earlier than the server's — by the connection wait and the send, which is only milliseconds on a
 *     quiet machine and as much as a busy one makes it. Measured with the command held back 80 ms on the wire:
 *     `maxTimeMS` AND `timeoutMS` together still answered at the client's deadline, because the driver's derived
 *     value wins over the explicit one. So the driver's `timeoutMS` is not used for a write.
 *  2. **The client later, as the backstop.** The caller is answered `StoreTimeout` at `bound +
 *     SERVER_FIRST_MARGIN_MS`, and the driver call is aborted (`signal`): a command not yet sent is dropped, one in
 *     flight loses its connection. This is for a server that cannot answer — and there is one: an UPSERT blocked
 *     by another session's uncommitted insert of the same `_id` is not interrupted by `maxTimeMS` or `killOp`
 *     until the blocker ends (measured, bundle-56). By the backstop the server's deadline has passed, and a
 *     write whose deadline passed answers `MaxTimeMSExpired` when its blocker goes instead of applying — it
 *     cannot land. The margin must exceed how late a command reaches the server; it is below the 1 s the hold
 *     deadline's ceiling keeps under what a sender waits (`config/env-num.ts`), so the `503` still precedes the
 *     sender's give-up.
 *
 * A READ keeps the driver's `timeoutMS`: it lands nothing, so the order does not matter, and its cursor needs the
 * driver's deadline across batches. An operation that is a transaction's (a SESSION) is bounded by the session
 * (`brain/held-transaction.ts`): the driver refuses a per-operation timeout inside a timed transaction, and an
 * aborted transaction applies nothing.
 *
 *  - **Per operation**: the bound is `min(writeTimeoutMs(), deadline − now)`. A write that already carries
 *    `maxTimeMS` keeps it, lowered to that figure (its callers read a code-50 timeout); one carrying `timeoutMS`
 *    is bounded by the smaller. A read that carries either keeps the smaller, as before.
 *  - **Per scope**: a deadline, `holdDeadlineMs()` after the scope opened, or the enclosing scope's if that is
 *    sooner. When it has passed, an operation is not sent at all: `StoreTimeout` — a `timeoutMS` of 0 would mean
 *    NO bound to the driver, which is why the minimum is enforced here and not left to arithmetic.
 *
 * The deadline defaults to three quarters of `BATCH_FETCH_TIMEOUT_MS`, the time a SENDER waits for a push answer,
 * so a stalled push answers a retryable `503` before the sender gives up and re-sends a page into the same stall.
 *
 * ## Where the bound is applied
 *
 * At the one door every collection is reached through, `getDb()` — composed into its existing proxy
 * (`db/record-write-observer.ts`) rather than as a second door, which `a-record-write-reaches-the-index-presence-
 * observer` refuses. So no write path can skip it without skipping `getDb()`.
 *
 * ## A dead scope binds nothing
 *
 * A scope is ACTIVE from `withinWriteBound` until it returns. Work started inside it and left running after (a
 * webhook emit, a void sweep) inherits the scope through AsyncLocalStorage and must not be bounded by a hold that
 * has ended, so an ended scope is ignored.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { envInt } from '../config/env-num.js';
import { BATCH_FETCH_TIMEOUT_MS } from '../sync/peer-timeouts.js';
import { StoreTimeout } from './write-timeout.js';
import { isMaxTimeExpired } from './max-time.js';

/** The per-operation bound when `YTHRIL_WRITE_TIMEOUT_MS` is unset. */
const DEFAULT_WRITE_TIMEOUT_MS = 30_000;
/** The per-hold deadline when `YTHRIL_HOLD_DEADLINE_MS` is unset: three quarters of what a sender waits for a push. */
const DEFAULT_HOLD_DEADLINE_MS = Math.floor(BATCH_FETCH_TIMEOUT_MS * 3 / 4);
// The least either may be set to is `config/env-num.ts`'s (1 000): never 0, which to the driver means unbounded.

interface Bounds { writeTimeoutMs: number; holdDeadlineMs: number }

const fromEnv = (): Bounds => ({
  writeTimeoutMs: envInt('YTHRIL_WRITE_TIMEOUT_MS', DEFAULT_WRITE_TIMEOUT_MS),
  holdDeadlineMs: envInt('YTHRIL_HOLD_DEADLINE_MS', DEFAULT_HOLD_DEADLINE_MS),
});
let bounds: Bounds = fromEnv();

/** The longest one operation inside a bound scope may take. */
export function writeTimeoutMs(): number { return bounds.writeTimeoutMs; }
/** The longest one seq hold (one bound scope) may last. */
export function holdDeadlineMs(): number { return bounds.holdDeadlineMs; }
/**
 * The age past which a hold is reported — half the deadline, BELOW it, so a hold the bound is about to end has
 * already been named once, and every hold that ended late says so when it is released.
 */
export function holdWarnMs(): number { return Math.floor(bounds.holdDeadlineMs / 2); }

/**
 * The test seam: set both bounds for this process (`null` puts back the environment's), so a test of "the bound
 * ends it" runs in seconds rather than the production 45. Never called by the server.
 */
export function setWriteBoundForTest(b: Bounds | null): void {
  bounds = b ? { writeTimeoutMs: b.writeTimeoutMs, holdDeadlineMs: b.holdDeadlineMs } : fromEnv();
}

interface BoundScope {
  readonly deadline: number;
  active: boolean;
}
const scopes = new AsyncLocalStorage<BoundScope>();

function activeScope(): BoundScope | undefined {
  const s = scopes.getStore();
  return s?.active ? s : undefined;
}

/**
 * Run `fn` with every database operation it issues bounded — see the module docblock. The scope's deadline is
 * `holdDeadlineMs()` from now, or the enclosing active scope's when that is sooner; the scope ends with `fn`.
 */
export async function withinWriteBound<T>(fn: () => Promise<T>): Promise<T> {
  const outer = activeScope();
  const scope: BoundScope = { deadline: Math.min(outer?.deadline ?? Infinity, Date.now() + holdDeadlineMs()), active: true };
  try {
    return await scopes.run(scope, fn);
  } finally {
    scope.active = false;
  }
}

/**
 * Run `fn` outside every bound scope — for work that must not inherit a hold's deadline: one that is detached from
 * it, or a read-back that is given a fresh bound of its own (`brain/held-transaction.ts`).
 */
export function outsideWriteBound<T>(fn: () => T): T {
  return scopes.exit(fn);
}

/** Milliseconds left in the active scope, or `undefined` outside one. Never below 0. */
export function boundTimeLeft(): number | undefined {
  const s = activeScope();
  return s ? Math.max(0, s.deadline - Date.now()) : undefined;
}

/**
 * Where each bounded `Collection` method takes its options. Every method a write or read goes through; the bulk-op
 * BUILDERS (`initialize*BulkOp`) are not here — nothing in this codebase uses them, and their timeout would have to
 * ride on `execute`, which this table cannot express.
 */
export const BOUNDED_OPTIONS_ARGUMENT: Readonly<Record<string, number>> = {
  insertOne: 1, insertMany: 1, bulkWrite: 1,
  updateOne: 2, updateMany: 2, replaceOne: 2,
  findOneAndUpdate: 2, findOneAndReplace: 2, findOneAndDelete: 1,
  deleteOne: 1, deleteMany: 1,
  findOne: 1, find: 1, aggregate: 1, countDocuments: 1, estimatedDocumentCount: 0, distinct: 2,
};

/**
 * The bounded methods that hand back a CURSOR, synchronously: a refused bound throws rather than rejects for them,
 * and a cursor in a timed transaction is the one that must not `getMore`. One set for both questions (bundle-30 I6,
 * C4: the observer and `inTimedTransactionCursor` each spelled it).
 */
export const RETURNS_CURSOR: ReadonlySet<string> = new Set(['find', 'aggregate']);

/** The first batch a cursor in a timed transaction asks for: everything, up to the server's own 16 MB per batch. */
const IN_TRANSACTION_BATCH = 1_000_000;

/**
 * A cursor opened inside a TIMED transaction (`brain/held-transaction.ts`: a session with `defaultTimeoutMS`) is
 * asked for all of its rows in its FIRST batch.
 *
 * The driver (7.1) sends `maxTimeMS` on such a cursor's `getMore`, which the server refuses for a non-awaitData
 * cursor — so every read inside a held transaction that came back in more than one batch (more than 101 rows, the
 * default first batch) failed the whole transaction with "cannot set maxTimeMS on getMore command for a
 * non-awaitData cursor" (probe, bundle-30 I3). Asking for everything at once needs no `getMore` up to 16 MB, which
 * is the server's cap on one batch; a read larger than that inside a transaction still fails, loudly — it reads in
 * id chunks instead (`readStoredById`). A caller's own `batchSize` is kept.
 */
function inTimedTransactionCursor(method: string, args: unknown[], at: number, options: Record<string, unknown>): unknown[] {
  if (!RETURNS_CURSOR.has(method)) return args;
  const session = options['session'] as { inTransaction?: () => boolean; timeoutMS?: number } | undefined;
  if (!session?.inTransaction?.() || typeof session.timeoutMS !== 'number' || options['batchSize'] !== undefined) return args;
  const out = [...args];
  while (out.length < at) out.push(undefined);
  out[at] = { ...options, batchSize: IN_TRANSACTION_BATCH };
  return out;
}

/**
 * The methods whose bound is a SERVER deadline with a client backstop (see the module docblock): the plain writes. A
 * read is not here — it lands nothing, so it keeps the driver's `timeoutMS`. `record-write-observer.ts` checks this
 * against its own table of which methods write, so a write added there and left out of here fails at load.
 */
export const PLAIN_WRITE_METHODS: ReadonlySet<string> = new Set([
  'insertOne', 'insertMany', 'bulkWrite', 'updateOne', 'updateMany', 'replaceOne',
  'findOneAndUpdate', 'findOneAndReplace', 'findOneAndDelete', 'deleteOne', 'deleteMany',
]);

/**
 * How long after the server's deadline the caller is answered `StoreTimeout` anyway, when the server has not answered.
 * It has to be MORE than how late a command can reach the server (the connection wait plus the send), because the
 * server's clock starts on arrival and the client's at the call: a margin smaller than that lateness is the defect this
 * exists to close. And it stays below the 1 000 ms the hold deadline's ceiling keeps under what a sender waits for a
 * push answer (`config/env-num.ts`), so the retryable `503` still precedes the sender's give-up.
 */
export const SERVER_FIRST_MARGIN_MS = 500;

/** The bounded call: its arguments, and — for a plain write — the time its client backstop is armed for. */
interface BoundedCall {
  args: unknown[];
  options: Record<string, unknown>;
  at: number;
  backstopMs?: number;
  /** The bound is ours alone: the caller set no deadline of its own, so the server's answer to it is `StoreTimeout`. */
  ourDeadline?: boolean;
}

/**
 * Plan the bound for `method` called with `args`: the arguments to call it with, and the backstop for a plain write.
 * `undefined` when there is nothing to bound (no scope, an unbounded method). THROWS `StoreTimeout` when the scope's
 * deadline has passed: the operation is not sent.
 */
function planBound(method: string, args: unknown[]): BoundedCall | undefined {
  const at = BOUNDED_OPTIONS_ARGUMENT[method];
  if (at === undefined) return undefined;
  const scope = activeScope();
  if (!scope) return undefined;
  const given = args[at];
  const options = given && typeof given === 'object' ? given as Record<string, unknown> : {};
  // A session's operations are bounded by the session (or are a transaction's, where a per-op timeout is refused).
  if (options['session'] !== undefined) return { args: inTimedTransactionCursor(method, args, at, options), options, at };
  const left = scope.deadline - Date.now();
  if (left <= 0) throw new StoreTimeout();
  const bound = Math.min(writeTimeoutMs(), left);
  const amended: Record<string, unknown> = { ...options };
  const out = [...args];
  while (out.length < at) out.push(undefined);
  if (PLAIN_WRITE_METHODS.has(method)) {
    // The server's deadline, and no `timeoutMS`: the driver would derive the wire value from its own earlier clock.
    const carried = [options['maxTimeMS'], options['timeoutMS']].filter((v): v is number => typeof v === 'number' && v > 0);
    delete amended['timeoutMS'];
    const serverMs = Math.min(bound, ...carried);
    amended['maxTimeMS'] = serverMs;
    out[at] = amended;
    return { args: out, options: amended, at, backstopMs: serverMs + SERVER_FIRST_MARGIN_MS, ourDeadline: carried.length === 0 };
  }
  if (typeof options['maxTimeMS'] === 'number') {
    amended['maxTimeMS'] = Math.min(options['maxTimeMS'], bound);
  } else {
    amended['timeoutMS'] = typeof options['timeoutMS'] === 'number' && options['timeoutMS'] > 0
      ? Math.min(options['timeoutMS'], bound) : bound;
  }
  out[at] = amended;
  return { args: out, options: amended, at };
}

/**
 * Call `method` with its bound applied — see the module docblock for what the bound is and the order it ends a write
 * in. `call` is the driver call, handed the bounded arguments. Outside a scope it is called with `args` untouched.
 *
 * For a plain write the result is a promise that settles with the driver's, or rejects `StoreTimeout` once the server's
 * deadline plus `SERVER_FIRST_MARGIN_MS` has passed — and then aborts the driver call, so a command not yet sent is
 * dropped. A result that arrives after that is ignored; it cannot be a landing, because the server's deadline is past.
 * THROWS `StoreTimeout` when the scope's deadline has passed: the operation is not sent.
 */
export function callBounded(method: string, args: unknown[], call: (args: unknown[]) => unknown): unknown {
  const plan = planBound(method, args);
  if (!plan) return call(args);
  if (plan.backstopMs === undefined) return call(plan.args);
  const { backstopMs, options, at } = plan;
  const abort = new AbortController();
  const given = options['signal'] as AbortSignal | undefined;
  const bounded = [...plan.args];
  bounded[at] = { ...options, signal: given ? AbortSignal.any([given, abort.signal]) : abort.signal };
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      // A plain `Error` as the reason: the driver wraps a bulk write's failure in a `MongoBulkWriteError`, whose
      // constructor copies every ENUMERABLE property of the reason with `for…in` — and `name` is a getter-only there.
      // The default reason (a `DOMException`, whose `name` is an enumerable accessor) and our `StoreTimeout` (which sets
      // its own `name`) both make the abandoned call fail with a `TypeError` about that instead of the abort.
      abort.abort(new Error('the write bound\'s backstop fired'));
      reject(new StoreTimeout());
    }, backstopMs);
    timer.unref();
    let driverCall: Promise<unknown>;
    try { driverCall = Promise.resolve(call(bounded)); } catch (err) { clearTimeout(timer); reject(err); return; }
    driverCall.then(
      (value) => { clearTimeout(timer); resolve(value); },
      // The server answering first is the bound ending the write, as the backstop is: one error for both, so a caller
      // never has to know which clock won. The driver's own error stays reachable as the cause.
      (err: unknown) => { clearTimeout(timer); reject(plan.ourDeadline && isMaxTimeExpired(err) ? new StoreTimeout(undefined, { cause: err }) : err); },
    );
  });
}
