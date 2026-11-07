/**
 * A TRANSACTION that the write bound ends — the one way a multi-document write is run inside a MongoDB session.
 *
 * ## The question it answers
 *
 * *"Run these writes as one transaction, and be sure it ends when the write bound says so."* Nothing else: it holds
 * NO position horizon. The bound and the horizon are two questions. A transaction that writes seq-carrying documents asks
 * the second one too, and puts the floor around this (`brain/held-transaction.ts`); a transaction that writes none (the
 * lease fence, `files/media/lease.ts`) must not stall every position-paged reader of a space for as long as it runs.
 *
 * ## What it prevents
 *
 * A write conflict inside a transaction fails at once, and the driver's `withTransaction` retries it for a fixed 120 s, so a
 * document lock held elsewhere kept a transaction retrying two minutes — under a seq hold, every seq-paged reader of the space
 * with it (`Q-213`); under the media worker's fence, the worker and every move waiting on it. A hand-written session start
 * drops the bound, or the read-back below, or the session's end, and each copy dropped a different one of them. They are
 * inside here so that no caller can leave them out.
 *
 * ## Why it runs its own loop and not `withTransaction` (`Q-716`)
 *
 * `withTransaction` can only be ended early by the driver's client-side timeout (`defaultTimeoutMS`), which desynchronised the
 * connection pool after a timeout on drivers before 7.8.0 (CVE-2026-119179) and does nothing from 7.8.0 on, where the 120 s is
 * a constant (probed, 7.8.0). So this runs the loop the MongoDB documentation describes for the core API (`startTransaction`,
 * `commitTransaction`, `abortTransaction`) against the scope's deadline:
 *
 *  1. **Opens a bound scope when none is active** (`withinWriteBound`), so a caller outside a hold gets the same bound as one
 *     inside it and an enclosing scope's deadline is never raised. A transaction whose purpose has a bound of its own
 *     (`boundMs`) opens its scope at that figure instead, and its commit is capped there.
 *  2. **Opens the transaction on the server** with one read of its own before `fn` runs (`openOnTheServer`), so statements `fn`
 *     sends together never both try to start it (the driver 7.8.0 refuses that; see the function).
 *  3. **Every statement is bounded by the scope** (`db/write-bound.ts`: the server's `maxTimeMS`, and a client backstop that
 *     ends the driver call and answers `StoreTimeout`), as every other operation is.
 *  4. **A transient failure** (`TransientTransactionError`: a write conflict, a transaction the server aborted) aborts and runs
 *     `fn` again from the top while the deadline allows, after a short backoff; past the deadline the loop ends with
 *     `StoreTimeout`. `fn` must therefore be safe to run twice, as it always had to be.
 *  5. **The commit** carries `maxCommitTimeMS` (the server's deadline for it) and a client race at that figure plus the
 *     backstop margin, since the driver's commit takes no `signal`. An unknown commit result while time is left is committed
 *     again (the server answers a repeated commit of the same transaction with its outcome).
 *  6. **Reads back a failed commit** when `landed` is given: a commit that fails may have landed. `landed` is asked once, with
 *     a fresh bound of its own; a transaction that did land is answered as landed. Otherwise the error is thrown as it came.
 *  7. **Ends the session** in a `finally`, bounded too: ending a session whose abort is still unanswered would send another.
 *
 * A race that stops waiting never leaves a reply for another call to read: the driver still owns that connection and reads
 * its own reply when it comes, and the connection a `signal` ends is closed by the driver (probed, 7.8.0).
 *
 * ## A transaction the bound ended is sealed before anything is answered (`Q-530`)
 *
 * When the store is not answering (`storeIsNotAnswering`: the bound ended it, or the store cannot be reached), a statement of
 * the transaction, or its commit, may still be on the wire. When it arrives it opens a transaction nobody owns, holds every
 * document it wrote, and outlives the server's own transaction lifetime. So, BEFORE the commit is read back:
 *
 *  1. **The seal**: one retryable write that matches nothing, outside any transaction, under the session's id and the next
 *     transaction number. It aborts a transaction still open under the old number and refuses every statement or commit of it
 *     that arrives later (`TransactionTooOld`). It is sent on a SIBLING session given the same server-session id and number
 *     (`serverSession.id`/`txnNumber`, public in the driver): the driver marks a session aborted only once the server answers
 *     its abort, so against a store that does not answer, a seal sent on the original session would go out as a statement
 *     of the very transaction it is meant to end. Bounded by `SEAL_MS`.
 *  2. **When the seal fails**: `killSessions` on the session id, which frees what is open NOW, then a second seal. The kill alone
 *     closes nothing for later: it drops the transaction number, so a statement arriving after it reopens the old transaction.
 *     Only a seal sent after the last kill counts.
 *  3. **The session is never pooled again** (both the original and the sibling are marked dirty), so its id is not handed to
 *     the next transaction.
 *
 * Only an answered seal makes the outcome `gone`, and only then is a "not landed" read-back the truth. Otherwise the outcome
 * is `unconfirmed`, said in one ERROR line, and the caller receives the store's own error, which already means "may have
 * landed". The residual, stated: with no seal answered, a late statement may hold what it wrote, with NO time bound, until a
 * later command on that session id or a kill after it lands. A client whose connection string sets `retryWrites=false`
 * cannot send a seal (the driver attaches no transaction number), so it is always in that residual; `mongo.ts` says so at boot.
 * An ordinary refusal (a callback that throws, a lost claim) sends nothing: no statement of it can still be in flight.
 */
import type { ClientSession, ServerSessionId, UpdateOptions } from 'mongodb';
import { getDb, getMongo } from './mongo.js';
import {
  KILL_WAIT_MS, SERVER_FIRST_MARGIN_MS, boundOperationMs, boundTimeLeft, writeTimeoutMs, withinWriteBound, withinWriteBoundOf,
  outsideWriteBound,
} from './write-bound.js';
import type { EndedOperation } from './write-bound.js';
import { StoreTimeout } from './write-timeout.js';
import { carriesErrorLabel, storeIsNotAnswering } from './store-condition.js';
import { log, peerText } from '../util/log.js';
import { backoffDelayMs } from '../util/backoff.js';

/**
 * The seal's own bound, ms: one write of nothing, which must outlast a store that is slow but still answering, since a seal
 * that fails costs a kill and a second seal. Paid only when the store was not answering, inside the caller's seq hold when
 * there is one: at worst `2 x SEAL_MS + KILL_WAIT_MS` added to that exit.
 */
export const SEAL_MS = 2_000;

/** Where the seal writes. It matches nothing and creates nothing; it is a collection no reader or observer watches. */
const SEAL_COLLECTION = 'transaction_seal';

/** The first pause between two attempts after a transient failure, ms; each doubles (with jitter) up to the next figure, none past the deadline. */
const FIRST_BACKOFF_MS = 2;
/** The longest pause between two attempts after a transient failure, ms. */
const MAX_BACKOFF_MS = 100;

/**
 * Which server session a transaction ran under, and the highest transaction number sent under it so far: what a seal and a kill
 * name. Each seal moves `txnNumber` on to the number it carried.
 */
interface SessionMark { readonly id: ServerSessionId; txnNumber: number }

/** Wait for `work` at most `ms`: its value, or `undefined` once the time is up. The work keeps running and its failure is swallowed. */
async function within<T>(work: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const elapsed = new Promise<undefined>(resolve => {
    const t = setTimeout(() => resolve(undefined), Math.max(0, ms));
    t.unref?.();
    timer = t;
  });
  const settled = work.catch(() => undefined);
  try { return await Promise.race([settled, elapsed]); } finally { clearTimeout(timer); }
}

/** The signal that ends a driver call this module sends itself, just after the server's own deadline `ms` would have. */
const ownSignal = (ms: number): AbortSignal => AbortSignal.timeout(ms + SERVER_FIRST_MARGIN_MS);

/**
 * One seal under `mark`, on a sibling session (see the module docblock): true when the server answered it.
 *
 * The driver adds one to the session's transaction number for the retryable write, so the seal carries `mark.txnNumber + 1`, and
 * `mark` is moved on to it whatever the answer: the NEXT seal must carry a higher number still, or a first seal delivered late
 * would be the server's retry of the second (the same number) and be answered as one, instead of refused as too old.
 */
async function sealOnce(mark: SessionMark): Promise<boolean> {
  let sibling: ClientSession | undefined;
  try {
    sibling = getMongo().startSession();
    sibling.serverSession.id = mark.id;
    sibling.serverSession.txnNumber = mark.txnNumber;
    mark.txnNumber += 1;
    await getMongo().db(getDb().databaseName).collection(SEAL_COLLECTION)
      // `signal` is honoured by every write at runtime (probed, driver 7.8.0) though the typings of a write's options omit it.
      .updateOne({ _id: '__seal_matches_nothing__' as unknown as never }, { $set: { sealed: true } },
        { session: sibling, maxTimeMS: SEAL_MS, signal: ownSignal(SEAL_MS) } as UpdateOptions);
    return true;
  } catch {
    return false;
  } finally {
    if (sibling) {
      sibling.serverSession.isDirty = true;
      await within(sibling.endSession(), SEAL_MS);
    }
  }
}

/**
 * Seal a session whose transaction the bound ended (see the module docblock): seal, else kill and seal again. NEVER throws;
 * says one line when the outcome is not a first seal answered.
 */
async function sealTransaction(mark: SessionMark): Promise<EndedOperation> {
  return outsideWriteBound(async () => {
    let canSeal: boolean;
    try {
      canSeal = getMongo().options.retryWrites !== false;
    } catch (err) {
      // No client (shutdown closed it): nothing can be sent. Said, and the caller still gets its own error.
      const why = `no client: ${err instanceof Error ? err.message : String(err)}`;
      log.error(`Bounded transaction: the store stopped answering with a statement possibly in flight, and its end could not be confirmed (${peerText(why)}).`);
      return { outcome: 'unconfirmed', killed: 0, why };
    }
    if (canSeal && await sealOnce(mark)) return { outcome: 'gone', killed: 0 };
    let killed = 0;
    let why: string;
    try {
      // A raw command takes the server's deadline in the command itself; the driver's options for it carry only the signal.
      await getMongo().db('admin').command({ killSessions: [mark.id], maxTimeMS: KILL_WAIT_MS }, { signal: ownSignal(KILL_WAIT_MS) });
      killed = 1;
      why = canSeal ? 'the first seal was not answered' : 'retryWrites=false, so no seal can be sent';
    } catch (err) {
      why = `${canSeal ? 'the first seal was not answered' : 'retryWrites=false, so no seal can be sent'}, and the kill failed: ${err instanceof Error ? err.message : String(err)}`;
    }
    if (canSeal && await sealOnce(mark)) {
      log.warn(`Bounded transaction: the store stopped answering with a statement possibly in flight; ${peerText(why)}; ${killed ? 'the session was killed and ' : ''}a second seal was answered. `
        + 'Nothing it sent can land or hold a document now.');
      return { outcome: 'gone', killed };
    }
    log.error(`Bounded transaction: the store stopped answering with a statement possibly in flight, and its end could not be confirmed (${peerText(why)}${canSeal ? '; the second seal was not answered either' : ''}). `
      + 'The caller was answered the store\'s own error; a late statement may still hold the documents it wrote until a kill after it lands.');
    return { outcome: 'unconfirmed', killed, why };
  });
}

export interface BoundedTransactionOptions<T> {
  /**
   * Did the transaction land after all? Asked only when its COMMIT failed, with what the callback returned. True: the
   * transaction's value is returned as if the commit had answered. Without it, a failed commit is thrown as it came.
   */
  landed?: (result: T) => Promise<boolean>;
  /**
   * The bound of this transaction's PURPOSE, ms, when it is not the write bound's: the deadline across the transaction and the cap on
   * its commit. For a transaction whose size is the data's (a conversion's whole set of derived rows) and which the server itself
   * ends at its own transaction lifetime — a figure tighter than that would refuse what the data's size makes legitimate. An
   * enclosing scope's lower deadline still wins. Absent: the write bound.
   */
  boundMs?: number;
}

/** The failure of one attempt, and whether it may be run again from the top. */
class Retry extends Error {
  constructor(readonly failure: unknown) { super('retry'); }
}

/** Abort the open transaction, waiting at most `SEAL_MS`. NEVER throws: the driver itself ignores an abort's failure. */
async function abortWithin(session: ClientSession): Promise<void> {
  if (!session.inTransaction()) return;
  await within(session.abortTransaction(), SEAL_MS);
}

/**
 * Commit, bounded by the server (`maxCommitTimeMS`, set when the transaction started) and by a race at `ms` plus the margin.
 * The race answers `StoreTimeout`: the commit is then of unknown outcome, as one the server ended is.
 */
async function commitWithin(session: ClientSession, ms: number): Promise<void> {
  const commit = session.commitTransaction();
  let timer: NodeJS.Timeout | undefined;
  const raced = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new StoreTimeout('the transaction\'s commit')), ms + SERVER_FIRST_MARGIN_MS);
    timer.unref?.();
  });
  commit.catch(() => { /* answered by the race, or below */ });
  try { await Promise.race([commit, raced]); } finally { clearTimeout(timer); }
}

/**
 * Open the transaction on the server with one read of its own, before `fn` sends anything.
 *
 * ## What it prevents (`Q-716`)
 *
 * The driver marks a transaction started only when its first command's ANSWER comes back (7.8.0; 7.1.1 marked it when the command
 * was sent). Until then every statement it sends carries the "start the transaction" flag, so two statements `fn` sends together
 * (a `Promise.all` of reads, as `util/version-stamp.ts` does) both try to start it, and the server refuses the second:
 * `ConflictingOperationInProgress`, "Only servers in a sharded cluster can start a new transaction at the active transaction
 * number". A merge, a relink and a fork re-mint failed that way on every call. This read starts it alone; everything `fn` sends
 * then joins a transaction already open, which is how those statements ran for years. It reads one `_id` of the seal's
 * collection, which holds nothing, bounded like any statement: the server's deadline and a signal.
 */
async function openOnTheServer(session: ClientSession, left: number): Promise<void> {
  const ms = Math.max(1, Math.min(left, boundOperationMs() ?? left));
  await getMongo().db(getDb().databaseName).collection(SEAL_COLLECTION)
    .findOne({ _id: '__transaction_opens__' as unknown as never }, { session, maxTimeMS: ms, signal: ownSignal(ms) });
}

/** One attempt: start, run `fn`, commit (again while the outcome is unknown and time is left). THROWS `Retry` for a transient failure. */
async function attempt<T>(session: ClientSession, fn: (session: ClientSession) => Promise<T>, deadline: number, commitCap: number,
  done: { ran: boolean; result?: T }): Promise<T> {
  const left = deadline - Date.now();
  if (left <= 0) throw new StoreTimeout('the transaction');
  const commitMs = Math.max(1, Math.min(left, commitCap));
  session.startTransaction({ maxCommitTimeMS: commitMs });
  done.ran = false;
  try {
    await openOnTheServer(session, left);
    done.result = await fn(session);
  } catch (err) {
    await abortWithin(session);
    if (carriesErrorLabel(err, 'TransientTransactionError')) throw new Retry(err);
    throw err;
  }
  done.ran = true;
  for (;;) {
    try {
      await commitWithin(session, Math.max(1, Math.min(deadline - Date.now(), commitMs)));
      return done.result as T;
    } catch (err) {
      const timeLeft = deadline - Date.now() > 0;
      if (timeLeft && carriesErrorLabel(err, 'UnknownTransactionCommitResult') && !(err instanceof StoreTimeout)) continue;
      if (timeLeft && carriesErrorLabel(err, 'TransientTransactionError')) throw new Retry(err);
      throw err;
    }
  }
}

/** Run `fn` as one transaction under the write bound — see the module docblock. The callback's value is the value. */
export async function inBoundedTransaction<T>(
  fn: (session: ClientSession) => Promise<T>, opts: BoundedTransactionOptions<T> = {},
): Promise<T> {
  // No active scope with a deadline: open one. An enclosing one is kept as it is (a scope never raises what an outer bounded).
  const left = boundTimeLeft();
  if (left === undefined) {
    return opts.boundMs === undefined
      ? withinWriteBound(() => inBoundedTransaction(fn, opts))
      : withinWriteBoundOf(opts.boundMs, () => inBoundedTransaction(fn, opts));
  }
  if (left <= 0) throw new StoreTimeout('the transaction');
  const deadline = Date.now() + left;
  const commitCap = Math.min(opts.boundMs ?? writeTimeoutMs(), boundOperationMs() ?? Infinity);
  const session = getMongo().startSession();
  const done: { ran: boolean; result?: T } = { ran: false };
  try {
    for (let tries = 1; ; tries++) {
      try {
        return await attempt(session, fn, deadline, commitCap, done);
      } catch (err) {
        if (!(err instanceof Retry)) throw err;
        const pause = backoffDelayMs(tries - 1, FIRST_BACKOFF_MS, MAX_BACKOFF_MS);
        // A transient failure past the deadline is the bound ending the retrying: answered as the bound's, the failure as its cause.
        if (deadline - Date.now() <= pause) throw new StoreTimeout('the transaction', { cause: err.failure });
        await new Promise(resolve => setTimeout(resolve, pause));
      }
    }
  } catch (err) {
    // The store stopped answering: a statement or the commit may still be on the wire. Seal BEFORE the read-back, so a late
    // commit cannot land after the read-back said no. The session is never pooled again.
    if (storeIsNotAnswering(err)) {
      await sealTransaction({ id: session.serverSession.id, txnNumber: session.serverSession.txnNumber });
      session.serverSession.isDirty = true;
    }
    // `ran`: the callback finished, so what failed is the commit — the one failure that may have landed.
    if (!done.ran || !opts.landed) throw err;
    const landed = opts.landed;
    const value = done.result as T;
    // A fresh bound for the one read, outside the spent one.
    const confirmed = await outsideWriteBound(() => withinWriteBound(() => landed(value))).catch(() => false);
    if (confirmed) return value;
    throw err;
  } finally {
    // A session whose abort or commit is still unanswered would send another abort on ending: bounded, and never pooled again.
    if (session.inTransaction()) session.serverSession.isDirty = true;
    await within(session.endSession(), SEAL_MS);
  }
}
