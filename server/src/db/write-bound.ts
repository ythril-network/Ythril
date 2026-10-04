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
 * **Every operation issued while a bound scope is active ends within the bound, on the client AND the server**, so
 * the hold is released when its write ENDS — never abandoned while the write is alive (a hold released under a
 * write that lands later is `Q-196`, the defect the hold exists for). A driver bound ends the write itself: the
 * probe saw `timeoutMS` put `maxTimeMS` on the wire, and a timed-out write never landed after its blocker went.
 *
 *  - **Per operation**: `timeoutMS = min(writeTimeoutMs(), deadline − now)`. An operation that already carries
 *    `maxTimeMS` keeps it, lowered to that figure (its callers read a code-50 timeout); one carrying `timeoutMS`
 *    keeps the smaller. An operation with a SESSION gets nothing per operation: its session carries the bound
 *    (`brain/held-transaction.ts`), and the driver refuses a per-operation `timeoutMS` inside a timed transaction.
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

/** The per-operation bound when `YTHRIL_WRITE_TIMEOUT_MS` is unset. */
export const DEFAULT_WRITE_TIMEOUT_MS = 30_000;
/** The per-hold deadline when `YTHRIL_HOLD_DEADLINE_MS` is unset: three quarters of what a sender waits for a push. */
export const DEFAULT_HOLD_DEADLINE_MS = Math.floor(BATCH_FETCH_TIMEOUT_MS * 3 / 4);
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
 * The arguments `method` is to be called with, bounded when a scope is active — the same array when there is
 * nothing to do. THROWS `StoreTimeout` when the scope's deadline has passed: the operation is not sent.
 */
export function boundArguments(method: string, args: unknown[]): unknown[] {
  const at = BOUNDED_OPTIONS_ARGUMENT[method];
  if (at === undefined) return args;
  const scope = activeScope();
  if (!scope) return args;
  const given = args[at];
  const options = given && typeof given === 'object' ? given as Record<string, unknown> : {};
  // A session's operations are bounded by the session (or are a transaction's, where a per-op timeout is refused).
  if (options['session'] !== undefined) return inTimedTransactionCursor(method, args, at, options);
  const left = scope.deadline - Date.now();
  if (left <= 0) throw new StoreTimeout();
  const bound = Math.min(writeTimeoutMs(), left);
  const amended: Record<string, unknown> = { ...options };
  if (typeof options['maxTimeMS'] === 'number') {
    amended['maxTimeMS'] = Math.min(options['maxTimeMS'], bound);
  } else {
    amended['timeoutMS'] = typeof options['timeoutMS'] === 'number' && options['timeoutMS'] > 0
      ? Math.min(options['timeoutMS'], bound) : bound;
  }
  const out = [...args];
  while (out.length < at) out.push(undefined);
  out[at] = amended;
  return out;
}
