/**
 * How long ONE database operation, and one seq HOLD, may take — and the scope that carries the bound to every
 * operation issued inside it (`Q-213`, bundle-30 plan §A).
 *
 * ## The defect
 *
 * `withLandingStamp` and the transaction floor (`sync/record-position-stream.ts`, `util/position-clock.ts`) hold a floor every position-paged reader of the space stops
 * below, and release it when the write settles. Nothing bounded the write. A document lock held by another session,
 * a stalled socket, or `withTransaction` retrying a conflict for its default 120 s held the floor for as long as it
 * waited — and every peer pulling that space was served nothing above it, while every cycle reported success over
 * an empty page.
 *
 * ## The rule
 *
 * **A write the bound ended never lands, and the answer is given only once the SERVER operation is gone** — ended by
 * its own deadline, or killed by the backstop and seen gone. A hold is released, and a door answers `503`, when the
 * server can no longer apply the write — never while the write is alive and could still land (a hold released under a write
 * that lands later is `Q-196`, the defect the hold exists for; found again by main's CI run 37231507558 as a fork that landed
 * after the next case's wipe, `Q-372`; and again, with the command reaching the server later than the backstop's margin,
 * `Q-380`).
 *
 * ### The order the bound ends a write in
 *
 * A plain write (no session) is bounded in TWO steps, and the order is the point:
 *
 *  1. **The server first.** The operation carries an explicit `maxTimeMS` = the bound. The driver's own client-side
 *     timeout (`timeoutMS`) is used for NOTHING (`Q-716`): it ended a write on the client's clock, which starts before the
 *     command has a connection, so earlier than the server's; it desynchronised the connection pool after a timeout on
 *     drivers before 7.8.0, so one call could read another's answer (CVE-2026-119179); and from 7.8.0 it does nothing.
 *     `no-server-code-uses-the-drivers-client-timeout` holds that.
 *  2. **The client later, as the backstop.** The caller is answered `StoreTimeout` at `bound +
 *     SERVER_FIRST_MARGIN_MS`, and the driver call is aborted (`signal`): a command not yet sent is dropped, one in
 *     flight loses its connection. This is for a server that cannot answer — and there is one: an UPSERT blocked
 *     by another session's uncommitted insert of the same `_id` is not interrupted by `maxTimeMS` or `killOp`
 *     until the blocker ends (measured, bundle-56). When the command reached the server less than the margin
 *     late, its deadline has passed by the backstop, and a write whose deadline passed answers `MaxTimeMSExpired`
 *     when its blocker goes instead of applying — it cannot land. **That is not always so** (`Q-380`): the server's
 *     clock starts on ARRIVAL and the backstop's at the CALL, so a command that arrives later than the margin (a
 *     starved client process, a mongod taking it late, a full pool) is still alive at the backstop, and answering
 *     then would release the hold under a write that lands the moment its blocker goes (measured: with the command
 *     held 600 ms, 53 of 63 repetitions landed). So the backstop does not answer first. It aborts the driver call,
 *     then ENDS THE SERVER OPERATION: every plain write carries a unique driver `comment` (`planBound`), the operation
 *     is found by it in `$currentOp`, `killOp`'d, and `$currentOp` is asked again until TWICE in a row nothing is found
 *     (`endServerOperation`, at most `KILL_WAIT_MS`). Only then is the caller answered `StoreTimeout`. The margin plus
 *     `KILL_WAIT_MS` is below the 1 s the hold deadline's ceiling keeps under what a sender waits (`config/env-num.ts`), so
 *     the `503` still precedes the sender's give-up (`a-write-bound-answers-before-the-sender-gives-up`).
 *
 *     **If the operation cannot be confirmed gone in `KILL_WAIT_MS`** (the server refuses the question, does not answer, or
 *     the operation is one `killOp` does not end — the upsert behind an uncommitted insert) the caller is answered anyway: it
 *     must be. The one backstop line is then an ERROR that names the method, collection and space and says the write may
 *     still be alive. A killed operation is also marked killed, so it is interrupted when its blocker goes.
 *
 *     **The residual, stated and not closed.** A command still IN FLIGHT to the server when the kill's second look is made
 *     arrives after it and runs alone. The driver abort drops the connection it travels on, which drops most of those, and
 *     the second look catches one that arrives a round trip late; what remains is a command delayed past both. Closing it
 *     needs the write itself to carry a token the hold can invalidate, which a plain write cannot (a separate design
 *     question). The guarantee is therefore: the answer is never given while a server operation of that write is known
 *     to be alive without the line above saying so, and never before the operation was looked for twice.
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
 * A READ is bounded the same way, server first with the backstop behind it, but its backstop only ends the driver call: it
 * lands nothing, so there is no server operation to end before answering, and its own `maxTimeMS` ends that at the same
 * figure. A cursor-returning read hands its cursor back at once, so its backstop is the `signal` the driver honours on every
 * batch (`withCursorBackstop`), aborted with `StoreTimeout` as the reason. A STATEMENT of an open transaction is bounded like
 * a read: its transaction is sealed by its owner (`db/bounded-transaction.ts`), which refuses the statement should it arrive
 * late. Every path that ends a driver call closes the connection the call was on (the driver's `signal`), or leaves the
 * driver to read its own reply, so no reply is ever left for another call to read.
 *
 *  - **Per operation**: the bound is `min(writeTimeoutMs(), deadline − now)`. A call that already carries `maxTimeMS` keeps
 *    it, lowered to that figure (its callers read a code-50 timeout).
 *  - **Per scope**: a deadline, `holdDeadlineMs()` after the scope opened, or the enclosing scope's if that is
 *    sooner. When it has passed, an operation is not sent at all: `StoreTimeout` — a `maxTimeMS` of 0 would mean
 *    NO bound to the server, which is why the minimum is enforced here and not left to arithmetic.
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
import { randomUUID } from 'node:crypto';
import { envInt } from '../config/env-num.js';
import { BATCH_FETCH_TIMEOUT_MS } from '../sync/peer-timeouts.js';
import { log, peerText } from '../util/log.js';
import { narrowedFigures } from '../util/figure-narrowing.js';
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
 * A `timeoutMS` in `MONGO_URI` does nothing from driver 7.8.0 (`Q-716`). A `socketTimeoutMS` does act: it is the
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
 * Say so, once, when the connection string names a `timeoutMS`; `true` when it did (`Q-716`).
 *
 * The driver's client-side timeout desynchronised the connection pool after a timeout on drivers before 7.8.0, so one call could
 * read another's answer (CVE-2026-119179), and from 7.8.0 it is accepted and does NOTHING. An operator who set it to bound every
 * database call would believe they had a bound they do not; the bound Ythril keeps is `YTHRIL_WRITE_TIMEOUT_MS` (and the
 * housekeeping figure), on the server's deadline. The value is not quoted: `uri` carries credentials.
 */
export function warnIfClientTimeoutNamed(uri: string): boolean {
  if (!uriQueryOptions(uri).has('timeoutms')) return false;
  log.warn('MongoDB connection string: timeoutMS has no effect (the MongoDB driver ignores it from 7.8.0, after CVE-2026-119179). '
    + `Database calls are bounded by YTHRIL_WRITE_TIMEOUT_MS (now ${bounds.writeTimeoutMs} ms) on the server's own deadline. Remove timeoutMS from MONGO_URI.`);
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
  bounds = given === null ? fromEnv() : narrowedFigures('setWriteBoundForTest', 'the bound', bounds, given);
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
 * {@link withinWriteBound} for work whose purpose has a longer bound of its own: the deadline across the scope AND each operation's
 * figure are `ms`. The enclosing active scope still wins where it is lower (a hold's deadline is never raised from inside it), so this
 * can only LENGTHEN what the default would have given when nothing encloses it.
 *
 * Its one caller is a conversion's leased write (`files/media/lease.ts`), a single transaction that carries every row a conversion
 * made and which the server itself bounds at its transaction lifetime, a figure the write bound alone would undercut.
 */
export async function withinWriteBoundOf<T>(ms: number, fn: () => Promise<T>): Promise<T> {
  if (!Number.isFinite(ms) || ms <= 0) throw new Error(`withinWriteBoundOf: ms must be a finite positive number, got ${String(ms)}`);
  return withinScope(Date.now() + ms, ms, fn);
}

/**
 * Run `fn` — one housekeeping unit — with every database operation it issues ended at a figure of its own: `opMs`, or
 * `housekeepingOpMs()`. The same scope as `withinWriteBound` and the same door: a plain write is ended by the SERVER at the
 * figure with the client backstop `SERVER_FIRST_MARGIN_MS` later, so a housekeeping write the bound ended can no more land
 * afterwards than a hold's can (`Q-372`); a read carries the server's deadline and a backstop that ends the driver call.
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
 * it, or a read-back that is given a fresh bound of its own (`db/bounded-transaction.ts`).
 */
export function outsideWriteBound<T>(fn: () => T): T {
  return scopes.exit(fn);
}

/**
 * Run `fn` — a write that belongs to NO request — with each database operation ended at `writeTimeoutMs()`, and no deadline across it
 * (bundle-169, Q-580). The question it answers: "how is a write bounded that some request started but none owns?"
 *
 * ## What it prevents
 *
 * Work a request starts and leaves running (a webhook emit: its first deliveries, the overflow rows, a requeue) inherits the request's
 * scope through AsyncLocalStorage. While that scope is still active, the request's HOLD deadline ends the detached write — its rows
 * land or not as the store decides, and the writer counts them lost; once the scope has ended, the write is bounded by nothing at all
 * (a dead scope binds nothing). Both halves are inside here, so a caller cannot keep one and drop the other: the inherited scope is left
 * (`outsideWriteBound`), and a scope of its own is opened with the per-operation figure and no deadline.
 *
 * Not {@link withinWriteBoundOf} (`files/media/lease.ts`): that one asks for a deadline across a transaction's whole life, a figure the
 * server holds the transaction to. A detached write has no such life to bound; each of its operations is ended on its own.
 */
export function detachedWrite<T>(fn: () => Promise<T>): Promise<T> {
  return outsideWriteBound(() => withinScope(Infinity, writeTimeoutMs(), fn));
}

/**
 * Milliseconds left before the active scope's DEADLINE, or `undefined` when there is none to be left before: outside any
 * scope, and inside a housekeeping scope that has no deadline. Never below 0, never `Infinity`.
 *
 * The transaction module (`db/bounded-transaction.ts`) runs its retry loop against the answer, where an `Infinity` would be
 * a transaction with no bound at all — so `undefined` is what tells it there is no deadline to inherit, and it opens a write
 * bound of its own rather than begin an unbounded transaction.
 */
export function boundTimeLeft(): number | undefined {
  const s = activeScope();
  return s && Number.isFinite(s.deadline) ? Math.max(0, s.deadline - Date.now()) : undefined;
}

/**
 * The longest ONE operation may take inside the active scope, ms, or `undefined` outside any. A transaction's commit is one operation,
 * so a caller that sets its own figure for it takes the lower of the two and never raises what the scope bounded.
 */
export function boundOperationMs(): number | undefined {
  return activeScope()?.perOpMs;
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
 * The bounded methods that hand back a CURSOR, synchronously: a refused bound throws rather than rejects for them, and
 * their backstop is a `signal` rather than a promise that answers instead of them (`withCursorBackstop`). One set for both
 * questions (bundle-30 I6, C4: the observer and the bound each spelled it).
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

/**
 * Is `options` the options of a statement of an open transaction? Such a statement is bounded like any call (the server's
 * deadline and the client backstop), but its backstop ends nothing on the server: the transaction it belongs to is sealed
 * instead (`db/bounded-transaction.ts`), which also refuses the statement should it arrive late.
 */
function inOpenTransaction(options: Record<string, unknown>): boolean {
  const session = options['session'] as { inTransaction?: () => boolean } | undefined;
  return session?.inTransaction?.() === true;
}

/**
 * The plain writes: the methods whose client backstop ENDS THE SERVER OPERATION before the caller is answered (see the module
 * docblock). Every bounded call carries the server's deadline and a backstop; only a write can land after its answer, so only
 * a write's backstop kills. `record-write-observer.ts` checks this against its own table of which methods write, so a write
 * added there and left out of here fails at load.
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
 * How long, once the backstop has fired, the bound spends ending the SERVER operation and seeing it gone before the caller is
 * answered anyway (`Q-380`). The answer, and the hold's release behind it, follow the kill — so this is added to how long a
 * hold can last, and `a-write-bound-answers-before-the-sender-gives-up` holds `ceiling + SERVER_FIRST_MARGIN_MS + KILL_WAIT_MS`
 * under what a sender waits: the ceiling keeps one second below that wait, so this figure and the margin together stay under it.
 * Enough for a handful of round trips to a server that is answering; a server that is not is the case it gives up on, loudly.
 */
export const KILL_WAIT_MS = 400;
/** The pause between a `killOp` and the next look at `$currentOp`: long enough for the interrupt to be taken, short of a spin. */
const KILL_POLL_MS = 20;
/** What every plain write's driver `comment` starts with, so an operator reading `currentOp` knows whose it is. */
const WRITE_COMMENT_PREFIX = 'ythril-write-bound:';

/**
 * The means to ask the server about its own operations and end one: a driver `Admin` has it (`db.admin()`). Stated on the
 * call's target (`BoundTarget`), so the one door every collection is reached through (`db/record-write-observer.ts`) hands it to
 * every plain write and a fake in a test hands in its own.
 */
export interface ServerOperations {
  command(command: Record<string, unknown>): Promise<Record<string, unknown>>;
}

/**
 * What ending a server operation came to. `unable`: the call carried no `ServerOperations`; `unconfirmed`: it was still there or
 * could not be asked. A plain write ends by `endServerOperation` here; a transaction ends by its seal (`db/bounded-transaction.ts`).
 */
export interface EndedOperation {
  readonly outcome: 'gone' | 'unconfirmed' | 'unable';
  readonly killed: number;
  readonly why?: string;
}

/** `p`, or a rejection when `ms` have passed first: the kill is bounded however the server answers. */
function within<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`no answer within ${KILL_WAIT_MS} ms`)), Math.max(1, ms));
    p.then(v => { clearTimeout(t); resolve(v); }, e => { clearTimeout(t); reject(e); });
  });
}

/**
 * End the server operation a plain write started, found by the `comment` it carried, and answer whether it is gone.
 *
 * It is asked what is running under that comment (`$currentOp`, this connection's user's own operations), each one found is
 * `killOp`'d, and the question is asked again until TWICE in a row nothing is found: the second quiet look is the one that
 * catches a command that was still on its way when the first was made. Done inside `KILL_WAIT_MS`, whatever the server does with
 * the questions. NEVER throws: a server that cannot be asked (no right to ask, a dead socket, a slow answer) is `unconfirmed`,
 * which the caller turns into an answer and one loud line — never into a hold released in silence.
 *
 * The residual, stated and not closed: a command that has not reached the server when the second look is made arrives after it
 * and runs alone. The driver abort drops the connection it was on, which drops most of them. A hard fence needs the write itself
 * to carry a token the hold can invalidate, which a plain write cannot. A transaction's statements do carry one, their session's
 * transaction number, so a transaction is not ended here but sealed (`db/bounded-transaction.ts`), which closes what this leaves.
 */
async function endServerOperation(ops: ServerOperations | undefined, comment: string): Promise<EndedOperation> {
  if (!ops) return { outcome: 'unable', killed: 0 };
  const until = Date.now() + KILL_WAIT_MS;
  const left = (): number => until - Date.now();
  let killed = 0;
  let quiet = 0;
  try {
    while (left() > 0) {
      const reply = await within(ops.command({
        aggregate: 1,
        pipeline: [{ $currentOp: { allUsers: false } }, { $match: { 'command.comment': comment } }, { $project: { opid: 1 } }],
        cursor: {},
      }), left());
      const found = ((reply['cursor'] as { firstBatch?: Array<{ opid?: unknown }> } | undefined)?.firstBatch ?? [])
        .map(o => o.opid).filter((id): id is number | string => id !== undefined);
      if (found.length === 0) {
        if (++quiet >= 2) return { outcome: 'gone', killed };
        continue;
      }
      quiet = 0;
      for (const op of found) {
        await within(ops.command({ killOp: 1, op }), left());
        killed += 1;
      }
      await new Promise<void>(r => setTimeout(r, Math.min(KILL_POLL_MS, Math.max(1, left()))));
    }
    return { outcome: 'unconfirmed', killed, why: `still running after ${KILL_WAIT_MS} ms` };
  } catch (err) {
    return { outcome: 'unconfirmed', killed, why: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Where a bounded call is going — stated at EVERY call of `callBounded`. `collection` (or `database`) is for the backstop's
 * warning, which says where the server stalled (and in which space, read from the collection's name).
 *
 * There is no `timeoutMS` the client carries to state any more (`Q-716`): from driver 7.8.0 a `timeoutMS` in `MONGO_URI` does
 * nothing, so nothing has to switch it off, and `mongo.ts` says so at boot when the string names one.
 */
export type BoundTarget = CollectionTarget | DatabaseTarget;

/** What both levels state. */
interface TargetMeans {
  /**
   * The means to end the SERVER's operation when the backstop fires (`endServerOperation`). Every production call states it
   * (`record-write-observer.ts` is the one door); it is optional only so a fake driver call in a test can leave it out, and
   * a backstop that fires without it says so in its line.
   */
  readonly serverOperations?: ServerOperations;
}

/** A call on a `Collection`: it goes through `BOUNDED_OPTIONS_ARGUMENT` and `PLAIN_WRITE_METHODS`. */
export interface CollectionTarget extends TargetMeans {
  /** The collection the call goes to, as the driver names it. */
  readonly collection: string;
}

/**
 * A call on the `Db` itself (`listCollections`, `dropCollection`): it goes through `BOUNDED_DB_OPTIONS_ARGUMENT` and
 * `PLAIN_DB_WRITE_METHODS`. The LEVEL is stated here, by which of the two shapes the target has, and never as a defaulted extra
 * parameter — an optional argument is how a call came to leave out what it inherits.
 */
export interface DatabaseTarget extends TargetMeans {
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

/** The bounded call: its arguments, and the time its client backstop is armed for. */
interface BoundedCall {
  args: unknown[];
  options: Record<string, unknown>;
  at: number;
  backstopMs: number;
  /** A plain write outside a transaction: its backstop ends the server operation before the caller is answered. */
  endsServerOperation: boolean;
  /** The bound is ours alone: the caller set no deadline of its own, so the server's answer to it is `StoreTimeout`. */
  ourDeadline?: boolean;
  /** The `comment` the plain write carries, which is how the backstop finds its operation in `$currentOp`. */
  comment?: string;
}

/**
 * Plan the bound for `method` called with `args`: the arguments to call it with, and the backstop for a plain write.
 * `undefined` when there is nothing to bound (no scope, an unbounded method). THROWS `StoreTimeout` when the scope's
 * deadline has passed: the operation is not sent.
 */
function planBound(method: string, args: unknown[], target: BoundTarget): BoundedCall | undefined {
  const at = optionsArgumentOf(method, target);
  if (at === undefined) return undefined;
  const scope = activeScope();
  if (!scope) return undefined;
  const given = args[at];
  const options = given && typeof given === 'object' ? given as Record<string, unknown> : {};
  const left = scope.deadline - Date.now();
  if (left <= 0) throw new StoreTimeout();
  // The one place the per-operation figure enters: the scope's own (`writeTimeoutMs()` for a hold, the housekeeping figure
  // for a walk, the lower of it and the enclosing scope's), never a global read here — a global read is how a walk's figure
  // would be ignored inside a hold's.
  const bound = Math.min(scope.perOpMs, left);
  // Every bounded call carries the SERVER's deadline, a caller's own lower `maxTimeMS` kept, and the client backstop behind it
  // (`callBounded`). Never the driver's `timeoutMS` (`Q-716`): it desynchronised the pool on drivers before 7.8.0
  // (CVE-2026-119179) and does nothing from 7.8.0 on.
  const carried = typeof options['maxTimeMS'] === 'number' && options['maxTimeMS'] > 0 ? [options['maxTimeMS']] : [];
  const serverMs = Math.min(bound, ...carried);
  const amended: Record<string, unknown> = { ...options, maxTimeMS: serverMs };
  const out = [...args];
  while (out.length < at) out.push(undefined);
  const backstopMs = serverMs + SERVER_FIRST_MARGIN_MS;
  // A plain write outside a transaction is ended by the server first, and its backstop ENDS THE SERVER OPERATION before the
  // caller is answered: the write's own name in the server's operation list is how the backstop finds it (`endServerOperation`),
  // unique per call so one kill can never end another write. A read lands nothing, and a transaction's statement is sealed with
  // its transaction (`db/bounded-transaction.ts`), so their backstop only ends the driver call.
  if (isPlainWrite(method, target) && !inOpenTransaction(options)) {
    amended['comment'] = `${WRITE_COMMENT_PREFIX}${randomUUID()}`;
    out[at] = amended;
    return { args: out, options: amended, at, backstopMs, endsServerOperation: true, ourDeadline: carried.length === 0, comment: amended['comment'] as string };
  }
  out[at] = amended;
  // A statement of an open transaction answers with the driver's own error, never re-dressed as `StoreTimeout`: its labels
  // (`TransientTransactionError` on a write conflict) are how the transaction's loop knows to run it again
  // (`db/bounded-transaction.ts`), and a write conflict is one `isWriteTimeout` counts as a bound's end.
  return { args: out, options: amended, at, backstopMs, endsServerOperation: false, ourDeadline: carried.length === 0 && !inOpenTransaction(options) };
}

/**
 * A cursor-returning call (`find`, `aggregate`, `listCollections`) hands its cursor back synchronously, so its backstop cannot be
 * a promise that answers instead of it: it is a `signal` the driver honours on every batch of the cursor, aborted at the backstop
 * with `StoreTimeout` as its reason, which is what the cursor's read then throws. The driver closes the connection the aborted
 * read was on (probed, 7.8.0), so no reply is left for another call to read.
 */
function withCursorBackstop(plan: BoundedCall): unknown[] {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(new StoreTimeout()), plan.backstopMs);
  timer.unref();
  const given = plan.options['signal'] as AbortSignal | undefined;
  const bounded = [...plan.args];
  bounded[plan.at] = { ...plan.options, signal: given ? AbortSignal.any([given, abort.signal]) : abort.signal };
  return bounded;
}

/**
 * Call `method` with its bound applied — see the module docblock for what the bound is and the order it ends a write
 * in. `call` is the driver call, handed the bounded arguments. Outside a scope it is called with `args` untouched.
 *
 * For a plain write the result is a promise that settles with the driver's, or rejects `StoreTimeout` once the server's
 * deadline plus `SERVER_FIRST_MARGIN_MS` has passed — it first aborts the driver call, so a command not yet sent is
 * dropped, then ends the server operation (`endServerOperation`, at most `KILL_WAIT_MS`), and only then rejects. A result
 * the driver delivers after the backstop fired is ignored: the caller is answered by the backstop alone.
 * THROWS `StoreTimeout` when the scope's deadline has passed: the operation is not sent.
 */
export function callBounded(
  method: string, args: unknown[], call: (args: unknown[]) => unknown, target: BoundTarget,
): unknown {
  const plan = planBound(method, args, target);
  if (!plan) return call(args);
  if (RETURNS_CURSOR.has(method)) return call(withCursorBackstop(plan));
  const { backstopMs, options, at, comment } = plan;
  const abort = new AbortController();
  const given = options['signal'] as AbortSignal | undefined;
  const bounded = [...plan.args];
  bounded[at] = { ...options, signal: given ? AbortSignal.any([given, abort.signal]) : abort.signal };
  return new Promise((resolve, reject) => {
    /** The backstop has fired: the driver's own settling (the abort's rejection, or a late reply) is no longer the answer. */
    let backstopped = false;
    const timer = setTimeout(() => {
      backstopped = true;
      // A plain `Error` as the reason: the driver wraps a bulk write's failure in a `MongoBulkWriteError`, whose
      // constructor copies every ENUMERABLE property of the reason with `for…in` — and `name` is a getter-only there.
      // The default reason (a `DOMException`, whose `name` is an enumerable accessor) and our `StoreTimeout` (which sets
      // its own `name`) both make the abandoned call fail with a `TypeError` about that instead of the abort.
      abort.abort(new Error('the write bound\'s backstop fired'));
      // A read, or a statement of a transaction: nothing of it can land after the answer (the statement's transaction is sealed by
      // its owner, `db/bounded-transaction.ts`), so the caller is answered now.
      if (!plan.endsServerOperation) { reject(new StoreTimeout()); return; }
      // The caller is answered only once the SERVER operation is gone: the server's deadline starts when the command ARRIVES,
      // so a late one is still alive here, and answering now would release the hold under a write that can land (`Q-380`).
      void endServerOperation(target.serverOperations, comment ?? '').then((ended) => {
        // Said once, here, and only here: the server's own answer (code 50) is an ordinary timeout and says nothing. The
        // backstop is the other state — the server could not answer by its own deadline (an upsert behind another
        // session's uncommitted insert is the one measured, a command that reached it late the other) — and the caller's 503
        // does not tell an operator which. An operation left alive is the one failure here that is an ERROR.
        const space = isDatabaseTarget(target) ? undefined : parseSpaceCollection(target.collection)?.spaceId;
        const where = `${peerText(placeOf(target))}${space === undefined ? '' : ` (space ${peerText(space)})`}`;
        const head = `Write bound: the server did not answer ${peerText(method)} on ${where} by its own deadline (${backstopMs - SERVER_FIRST_MARGIN_MS} ms); the client backstop `
          + `ended it ${SERVER_FIRST_MARGIN_MS} ms later and aborted the driver call`;
        if (ended.outcome === 'gone') {
          log.warn(`${head}; ${ended.killed === 0 ? 'the server operation was already gone' : `the server operation was killed (${ended.killed}) and is gone`}, and the caller was answered a retryable timeout. `
            + 'A write blocked behind another session\'s uncommitted insert, or a command that reached the server late, does this.');
        } else if (ended.outcome === 'unable') {
          log.warn(`${head} and answered the caller a retryable timeout; this call carried no means to end a server operation, so nothing could be killed.`);
        } else {
          log.error(`${head}; the server operation could not be confirmed gone (${peerText(ended.why ?? 'unknown')}${ended.killed > 0 ? `, killed ${ended.killed}` : ''}) within ${KILL_WAIT_MS} ms. `
            + 'The caller was answered a retryable timeout anyway, so the write may still be alive in the server and may land after the answer and after the seq hold was released.');
        }
        reject(new StoreTimeout());
      });
    }, backstopMs);
    timer.unref();
    let driverCall: Promise<unknown>;
    try { driverCall = Promise.resolve(call(bounded)); } catch (err) { clearTimeout(timer); reject(err); return; }
    driverCall.then(
      (value) => { clearTimeout(timer); if (!backstopped) resolve(value); },
      // The server answering first is the bound ending the write, as the backstop is: one error for both, so a caller
      // never has to know which clock won. The driver's own error stays reachable as the cause.
      (err: unknown) => { clearTimeout(timer); if (!backstopped) reject(plan.ourDeadline && isWriteTimeout(err) ? new StoreTimeout(undefined, { cause: err }) : err); },
    );
  });
}
