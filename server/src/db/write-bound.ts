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
 *     value wins over the explicit one. So the driver's `timeoutMS` is not used for a write — and one the CLIENT carries
 *     (`MONGO_URI`) is switched off for it (`timeoutMS: 0`, see `planBound`), because the driver inherits it otherwise.
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
 * ### What "cannot land" covers: ONE wire command
 *
 * `maxTimeMS` is per wire command. The driver splits a bulk write into several commands when its batch passes the server's
 * `maxBsonObjectSize` (16 MiB) or `maxWriteBatchSize` operations; each gets the same `maxTimeMS`, armed when IT reaches
 * the server, while the backstop is armed once. A second command can arrive after the caller was answered and the hold
 * released, and land. So the guarantee is for a call that is ONE command: every single-document write, and a bulk of one
 * operation type the writer keeps under the limit (`db/one-command.ts`: `inOneCommandChunks`, and `writeInOneCommands` for the
 * common loop, used wherever a count is a peer's or the store's own). The driver sends an unordered bulk as one command per
 * operation TYPE, so a bulk that mixes inserts, updates and deletes is sliced by type (`commandKindOf: bulkCommandOf`) or it is
 * several commands per slice; the ledger below holds that of every site. Every `bulkWrite` / `insertMany` in the server is accounted for one by
 * one, as sliced, chunked by a named count cap, inside a session, on a client of its own, or capped by a request (under the
 * limit for any real record, not for an adversarial one): there is no kind for a bulk nothing bounds.
 * `a-bounded-bulk-write-is-one-command` derives the call sites from the source and holds each row against the code.
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
 * ## Two constructors of ONE scope: a hold, and a housekeeping unit (`Q-358`)
 *
 * `withinWriteBound` is a hold: a deadline across the scope AND a per-operation figure (`writeTimeoutMs()`).
 * `withinHousekeepingBound` is a unit of background work: NO deadline — a walk is as long as its work, and its caller owns that
 * — and a per-operation figure of its own (`housekeepingOpMs()`, or the scope's `opMs`; `CLAIM_OP_MS` for a claim). Both ends
 * an operation the same way (the server first, the backstop behind it, `StoreTimeout`), through the same door. A scope's
 * figure is `min(own, the enclosing active scope's)`, as its deadline is: an inner scope can only tighten.
 *
 * ## Where the bound is applied
 *
 * At the one door every collection is reached through, `getDb()` — composed into its existing proxy
 * (`db/record-write-observer.ts`) rather than as a second door, which `a-record-write-reaches-the-index-presence-
 * observer` refuses. So no write path can skip it without skipping `getDb()`. The `Db`'s own `listCollections` and
 * `dropCollection` go through the same proxy and the same `callBounded`, their level stated in the call's target.
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
import { log, peerText } from '../util/log.js';
import { StoreTimeout, isWriteTimeout } from './write-timeout.js';
import { parseSpaceCollection } from './space-collection.js';
import { uriQueryOptions } from './client-options.js';

/** The per-operation bound when `YTHRIL_WRITE_TIMEOUT_MS` is unset. */
const DEFAULT_WRITE_TIMEOUT_MS = 30_000;
/** The per-hold deadline when `YTHRIL_HOLD_DEADLINE_MS` is unset: three quarters of what a sender waits for a push. */
const DEFAULT_HOLD_DEADLINE_MS = Math.floor(BATCH_FETCH_TIMEOUT_MS * 3 / 4);
/**
 * The per-operation bound of a HOUSEKEEPING unit when `YTHRIL_HOUSEKEEPING_OP_TIMEOUT_MS` is unset. Below the five-minute
 * tick the periodic jobs run on, so one hung operation ends before the next tick finds the walk still running; far above a
 * healthy bulk delete (a slow one is not cut).
 */
const DEFAULT_HOUSEKEEPING_OP_MS = 240_000;
/**
 * The per-operation bound of a CLAIM or a stall RESET (`withinHousekeepingBound(fn, { opMs: CLAIM_OP_MS })`): one
 * `findOneAndUpdate` on a queue's head. A claim that takes longer than this is a store that is not answering, and the
 * claiming loop is the thing that must not wait on it. A constant beside the figure above and not a setting: nobody has a
 * reason to want a claim to wait longer, and a figure an operator can raise is one a stall can be hidden behind.
 */
export const CLAIM_OP_MS = 10_000;
// The least any of the settings may be set to is `config/env-num.ts`'s (1 000): never 0, which to the driver means unbounded.

interface Bounds { writeTimeoutMs: number; holdDeadlineMs: number; housekeepingOpMs: number }

const fromEnv = (): Bounds => ({
  writeTimeoutMs: envInt('YTHRIL_WRITE_TIMEOUT_MS', DEFAULT_WRITE_TIMEOUT_MS),
  holdDeadlineMs: envInt('YTHRIL_HOLD_DEADLINE_MS', DEFAULT_HOLD_DEADLINE_MS),
  housekeepingOpMs: envInt('YTHRIL_HOUSEKEEPING_OP_TIMEOUT_MS', DEFAULT_HOUSEKEEPING_OP_MS),
});
let bounds: Bounds = fromEnv();

/** The longest one operation inside a bound scope may take. */
export function writeTimeoutMs(): number { return bounds.writeTimeoutMs; }
/** The longest one seq hold (one bound scope) may last. */
export function holdDeadlineMs(): number { return bounds.holdDeadlineMs; }
/** The longest one operation inside a housekeeping bound scope (`withinHousekeepingBound`) may take. Read at start. */
export function housekeepingOpMs(): number { return bounds.housekeepingOpMs; }
/**
 * The age past which a hold is reported — half the deadline, BELOW it, so a hold the bound is about to end has
 * already been named once, and every hold that ended late says so when it is released.
 */
export function holdWarnMs(): number { return Math.floor(bounds.holdDeadlineMs / 2); }

/**
 * Say so, once, when the connection string carries a `socketTimeoutMS` below the write bound; `true` when it did.
 *
 * A `timeoutMS` in `MONGO_URI` is neutralised for a bounded write (`planBound`). A `socketTimeoutMS` cannot be: it is the
 * socket's read timeout, below every operation clock, so one SHORTER than the bound ends the wait on the client while the
 * server still holds the write alive — the caller is answered before the write is known not to land, which is the order
 * the bound exists to keep. Nothing refuses it (a deployment may have its own reasons, and `0` or a larger number is
 * fine); the operator is told, at boot, in the one line that names the option and the setting that moves the bound.
 * `uri` carries credentials and is never put in the line.
 */
export function warnIfSocketTimeoutBelowWriteBound(uri: string): boolean {
  // The raw value, read by the one reader of the connection string's query: a name with no figure, or one that is not a
  // number, says nothing (the driver refuses it at connect).
  const raw = uriQueryOptions(uri).get('sockettimeoutms');
  const n = raw === undefined || raw === '' ? Number.NaN : Number(raw);
  const socketMs = Number.isFinite(n) ? n : undefined;
  if (socketMs === undefined || socketMs <= 0 || socketMs >= bounds.writeTimeoutMs) return false;
  log.warn(`MongoDB connection string: socketTimeoutMS=${socketMs} is below the write bound (YTHRIL_WRITE_TIMEOUT_MS=${bounds.writeTimeoutMs}). `
    + 'A write the server is still holding can be ended by the socket before the server\'s own deadline, and the caller answered a timeout '
    + 'before the write is known not to land. Leave socketTimeoutMS unset, or above the bound.');
  return true;
}

/**
 * The test seam: set the figures it is given for this process, over the CURRENT ones (`null` puts back the
 * environment's), so a test of "the bound ends it" runs in seconds rather than the production 45. Never called by the server.
 *
 * It MERGES, and it refuses what it cannot use. The seam used to copy exactly the figures it knew, so a caller that passed the
 * two it had always passed set a third one that was added later to `undefined` — and `Math.min(undefined, …)` is `NaN`, a bound
 * that is no bound (`C7`). A figure that is not a finite positive number is refused too: `0` is, to the driver, "no bound",
 * and a typo in a name (`writeTimeoutM`) would otherwise set nothing and let the test pass for the wrong reason. A refusal
 * changes nothing.
 */
export function setWriteBoundForTest(given: Partial<Bounds> | null): void {
  if (given === null) { bounds = fromEnv(); return; }
  const known = Object.keys(bounds);
  const entries = Object.entries(given);
  if (entries.length === 0) throw new Error(`setWriteBoundForTest: no figure given (${known.join(', ')})`);
  for (const [name, value] of entries) {
    if (!known.includes(name)) throw new Error(`setWriteBoundForTest: "${name}" is not a figure of the bound (${known.join(', ')})`);
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      throw new Error(`setWriteBoundForTest: ${name} must be a finite positive number, got ${String(value)}`);
    }
  }
  bounds = { ...bounds, ...given };
}

/**
 * What one scope carries. `deadline` is the instant the whole scope's work must be over (`Infinity`: none), `perOpMs` the
 * longest ONE operation inside it may take. A hold has both; a housekeeping unit has only the second — the unit's length is
 * its caller's (a cycle's own budget), and a hold's deadline across it would cut the unit off for being thorough.
 */
interface BoundScope {
  readonly deadline: number;
  readonly perOpMs: number;
  active: boolean;
}
const scopes = new AsyncLocalStorage<BoundScope>();

function activeScope(): BoundScope | undefined {
  const s = scopes.getStore();
  return s?.active ? s : undefined;
}

/**
 * Open a scope of `deadline` and `perOpMs`, both lowered to the enclosing active scope's when that is lower, and run `fn` in
 * it. The one place a scope is made: the two public constructors differ only in the figures they ask for, so an inner scope
 * can never raise what an outer one bounded (an operator who sets the housekeeping figure below a hold's sees it applied inside
 * a deleter's hold, and a hold's shorter figure still wins inside a walk).
 */
async function withinScope<T>(deadline: number, perOpMs: number, fn: () => Promise<T>): Promise<T> {
  const outer = activeScope();
  const scope: BoundScope = {
    deadline: Math.min(outer?.deadline ?? Infinity, deadline),
    perOpMs: Math.min(outer?.perOpMs ?? Infinity, perOpMs),
    active: true,
  };
  try {
    return await scopes.run(scope, fn);
  } finally {
    scope.active = false;
  }
}

/**
 * Run `fn` with every database operation it issues bounded — see the module docblock. The scope's deadline is
 * `holdDeadlineMs()` from now, or the enclosing active scope's when that is sooner; each operation takes at most
 * `writeTimeoutMs()`, or the enclosing scope's figure when that is lower; the scope ends with `fn`.
 */
export async function withinWriteBound<T>(fn: () => Promise<T>): Promise<T> {
  return withinScope(Date.now() + holdDeadlineMs(), writeTimeoutMs(), fn);
}

/**
 * Run `fn` — one housekeeping unit — with every database operation it issues ended at a figure of its own: `opMs`, or
 * `housekeepingOpMs()`. The same scope as `withinWriteBound` and the same door: a plain write is ended by the SERVER at the
 * figure with the client backstop `SERVER_FIRST_MARGIN_MS` later, so a housekeeping write the bound ended can no more land
 * afterwards than a hold's can (`Q-372`); a read carries the driver's `timeoutMS`.
 *
 * **There is no deadline across the unit.** A walk that touches every space, or sweeps a collection in batches, issues as
 * many operations as it has work for, and each is bounded; a deadline here would end a healthy unit part-way through for being
 * thorough. The unit's own length belongs to its caller. Inside a hold the hold's deadline stays (the enclosing one), and the
 * smaller per-operation figure of the two applies.
 */
export async function withinHousekeepingBound<T>(fn: () => Promise<T>, { opMs }: { opMs?: number } = {}): Promise<T> {
  const perOpMs = opMs ?? housekeepingOpMs();
  if (!Number.isFinite(perOpMs) || perOpMs <= 0) throw new Error(`withinHousekeepingBound: opMs must be a finite positive number, got ${String(perOpMs)}`);
  return withinScope(Infinity, perOpMs, fn);
}

/**
 * Run `fn` outside every bound scope — for work that must not inherit a hold's deadline: one that is detached from
 * it, or a read-back that is given a fresh bound of its own (`brain/held-transaction.ts`).
 */
export function outsideWriteBound<T>(fn: () => T): T {
  return scopes.exit(fn);
}

/**
 * Milliseconds left before the active scope's DEADLINE, or `undefined` when there is none to be left before: outside any
 * scope, and inside a housekeeping scope that has no deadline. Never below 0, never `Infinity`.
 *
 * The one caller (`brain/held-transaction.ts`) hands the answer to the driver as a session's `defaultTimeoutMS`, where an
 * `Infinity` is a transaction with no bound at all; it always runs under a hold today (`withSeqHorizonHeld`), so it never sees a
 * deadline-less scope — and `undefined` is what makes a future caller that does fall back to the finite figure it
 * already has beside it (`?? writeTimeoutMs()`), rather than begin an unbounded transaction.
 */
export function boundTimeLeft(): number | undefined {
  const s = activeScope();
  return s && Number.isFinite(s.deadline) ? Math.max(0, s.deadline - Date.now()) : undefined;
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
export const RETURNS_CURSOR: ReadonlySet<string> = new Set(['find', 'aggregate', 'listCollections']);

/**
 * Where each bounded `Db` method takes its options — the Db-level twin of `BOUNDED_OPTIONS_ARGUMENT`, applied by the same
 * proxy (`db/record-write-observer.ts`), so a housekeeping unit's `listCollections` and `dropCollection` end at the figure like
 * every collection call does. A name is in ONE of the two tables; `record-write-observer.ts` checks it at load.
 *
 * What is NOT here is named, with its reason, in `UNBOUNDED_DB_METHODS` (record-write-observer.ts). The index calls stay
 * unbounded on purpose, at both levels (`createIndex*`, `listIndexes`, `listSearchIndexes`, `db.createIndex`): an index build
 * scales with the data in the collection, so no one figure is right for every collection — a bound that cut a build of a large
 * one would leave it half made, and one high enough for it is no bound on a hung call.
 */
export const BOUNDED_DB_OPTIONS_ARGUMENT: Readonly<Record<string, number>> = {
  listCollections: 1, dropCollection: 1,
};

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
 * The Db-level methods that WRITE and are bounded: server-first like `PLAIN_WRITE_METHODS`, and for the same reason — a drop
 * that the client's clock ended could still be applied afterwards. Probed (P8, driver 7.1.1): `{ maxTimeMS }` on a drop held
 * behind another session's open transaction ends it at the figure with code 50, and the collection is still there once the
 * blocker goes. A separate set from the Collection's because the names live at different levels and the Collection's is
 * derived from by gates that index `BOUNDED_OPTIONS_ARGUMENT` with each of them.
 */
export const PLAIN_DB_WRITE_METHODS: ReadonlySet<string> = new Set(['dropCollection']);

/**
 * How long after the server's deadline the caller is answered `StoreTimeout` anyway, when the server has not answered.
 * It has to be MORE than how late a command can reach the server (the connection wait plus the send), because the
 * server's clock starts on arrival and the client's at the call: a margin smaller than that lateness is the defect this
 * exists to close. And it stays below the 1 000 ms the hold deadline's ceiling keeps under what a sender waits for a
 * push answer (`config/env-num.ts`), so the retryable `503` still precedes the sender's give-up.
 */
export const SERVER_FIRST_MARGIN_MS = 500;

/**
 * Where a bounded call is going and what the database it goes through carries — stated at EVERY call of `callBounded`,
 * never defaulted.
 *
 * `inheritedTimeoutMs` is the `timeoutMS` the CLIENT carries (`MONGO_URI`), which every operation that sets none of its
 * own inherits: a plain write has to switch it off (`timeoutMS: 0`, see `planBound`) or the driver's clock ends the write
 * before the server's deadline. It was an optional argument, so a call that left it out compiled and put that defect
 * back; it is required here, and `undefined` is stated, not implied. `collection` is only for the backstop's warning,
 * which says where the server stalled (and in which space, read from the collection's name).
 */
export type BoundTarget = CollectionTarget | DatabaseTarget;

/** What both levels state: the client's own `timeoutMS`, `undefined` when it carries none. */
interface InheritedTimeout {
  readonly inheritedTimeoutMs: number | undefined;
}

/** A call on a `Collection`: it goes through `BOUNDED_OPTIONS_ARGUMENT` and `PLAIN_WRITE_METHODS`. */
export interface CollectionTarget extends InheritedTimeout {
  /** The collection the call goes to, as the driver names it. */
  readonly collection: string;
}

/**
 * A call on the `Db` itself (`listCollections`, `dropCollection`): it goes through `BOUNDED_DB_OPTIONS_ARGUMENT` and
 * `PLAIN_DB_WRITE_METHODS`. The LEVEL is stated here, by which of the two shapes the target has, and never as a defaulted extra
 * parameter — an optional argument is how a call came to leave out what it inherits.
 */
export interface DatabaseTarget extends InheritedTimeout {
  /** The database the call goes to, for the backstop's warning. */
  readonly database: string;
}

const isDatabaseTarget = (t: BoundTarget): t is DatabaseTarget => 'database' in t;
/** Where `method` takes its options at the target's level; `undefined` when that level does not bound it. */
const optionsArgumentOf = (method: string, target: BoundTarget): number | undefined =>
  isDatabaseTarget(target) ? BOUNDED_DB_OPTIONS_ARGUMENT[method] : BOUNDED_OPTIONS_ARGUMENT[method];
const isPlainWrite = (method: string, target: BoundTarget): boolean =>
  (isDatabaseTarget(target) ? PLAIN_DB_WRITE_METHODS : PLAIN_WRITE_METHODS).has(method);
/** The collection or database the target names, for the backstop's warning. */
const placeOf = (target: BoundTarget): string => (isDatabaseTarget(target) ? target.database : target.collection);

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
function planBound(method: string, args: unknown[], target: BoundTarget): BoundedCall | undefined {
  const { inheritedTimeoutMs } = target;
  const at = optionsArgumentOf(method, target);
  if (at === undefined) return undefined;
  const scope = activeScope();
  if (!scope) return undefined;
  const given = args[at];
  const options = given && typeof given === 'object' ? given as Record<string, unknown> : {};
  // A session's operations are bounded by the session (or are a transaction's, where a per-op timeout is refused).
  if (options['session'] !== undefined) return { args: inTimedTransactionCursor(method, args, at, options), options, at };
  const left = scope.deadline - Date.now();
  if (left <= 0) throw new StoreTimeout();
  // The one place the per-operation figure enters: the scope's own (`writeTimeoutMs()` for a hold, the housekeeping figure
  // for a walk, the lower of it and the enclosing scope's), never a global read here — a global read is how a walk's figure
  // would be ignored inside a hold's.
  const bound = Math.min(scope.perOpMs, left);
  const amended: Record<string, unknown> = { ...options };
  const out = [...args];
  while (out.length < at) out.push(undefined);
  // A plain write is ended by the server first, with the client backstop behind it. A Db-level call carries the SERVER's
  // deadline too, whether it writes or reads (`listCollections` takes `maxTimeMS`; probe P8: the driver keeps `timeoutMS` and
  // drops `maxTimeMS` when both are sent, so only one is ever sent) — but only a write needs the backstop.
  if (isPlainWrite(method, target) || isDatabaseTarget(target)) {
    // The server's deadline, and no `timeoutMS`: the driver would derive the wire value from its own earlier clock.
    const carried = [options['maxTimeMS'], options['timeoutMS']].filter((v): v is number => typeof v === 'number' && v > 0);
    delete amended['timeoutMS'];
    // A `timeoutMS` the CLIENT carries (`MONGO_URI`, a client option) is inherited by every operation that sets none of its
    // own (`options?.timeoutMS ?? parent?.timeoutMS`, driver `utils.js`), and would arm the driver's clock — which ends the
    // write before the server's deadline, so the 503 and the hold's release can precede a live write: the defect above,
    // for any operator who sets one. `0` is the driver's "no client deadline" for THIS operation: its context then has an
    // infinite remaining time, derives no `maxTimeMS` of its own, and the explicit one stays on the wire (probed on every
    // method of `PLAIN_WRITE_METHODS`, with the client's `timeoutMS` below the bound: answered by the server at the bound).
    // Only when one is inherited: with none, the operation carries no `timeoutMS` at all, as it always did.
    if (inheritedTimeoutMs !== undefined && inheritedTimeoutMs > 0) amended['timeoutMS'] = 0;
    const serverMs = Math.min(bound, ...carried);
    amended['maxTimeMS'] = serverMs;
    out[at] = amended;
    if (!isPlainWrite(method, target)) return { args: out, options: amended, at };
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
export function callBounded(
  method: string, args: unknown[], call: (args: unknown[]) => unknown, target: BoundTarget,
): unknown {
  const plan = planBound(method, args, target);
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
      // Said once, here, and only here: the server's own answer (code 50) is an ordinary timeout and says nothing. The
      // backstop is the other state — the server could not answer by its own deadline (an upsert behind another
      // session's uncommitted insert is the one measured) — and the caller's 503 does not tell an operator which.
      const space = isDatabaseTarget(target) ? undefined : parseSpaceCollection(target.collection)?.spaceId;
      const where = `${peerText(placeOf(target))}${space === undefined ? '' : ` (space ${peerText(space)})`}`;
      log.warn(`Write bound: the server did not answer ${peerText(method)} on ${where} by its own deadline (${backstopMs - SERVER_FIRST_MARGIN_MS} ms); the client backstop `
        + `ended it ${SERVER_FIRST_MARGIN_MS} ms later, answered the caller a retryable timeout and aborted the driver call. A write blocked behind another session's uncommitted insert does this.`);
      reject(new StoreTimeout());
    }, backstopMs);
    timer.unref();
    let driverCall: Promise<unknown>;
    try { driverCall = Promise.resolve(call(bounded)); } catch (err) { clearTimeout(timer); reject(err); return; }
    driverCall.then(
      (value) => { clearTimeout(timer); resolve(value); },
      // The server answering first is the bound ending the write, as the backstop is: one error for both, so a caller
      // never has to know which clock won. The driver's own error stays reachable as the cause.
      (err: unknown) => { clearTimeout(timer); reject(plan.ourDeadline && isWriteTimeout(err) ? new StoreTimeout(undefined, { cause: err }) : err); },
    );
  });
}
