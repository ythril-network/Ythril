/**
 * Every write this process makes to a space's RECORD collection, observed at the one door all of them use.
 *
 * ## Why this exists (Q-165)
 *
 * A space's search indexes now exist only while their collection holds a record: mongot keeps one change-stream
 * cursor per index over the shared oplog, and half the collections on a measured instance were empty and still
 * paid for one. Creating an index on a collection's first record and dropping it when the last one goes needs to
 * know about EVERY write — and a space's records are written from the REST and MCP doors, sync ingest, bulk,
 * import, the conversion pipeline, the media embedders, merges, re-keys, the TTL sweep and the space wipe. A call
 * placed at each of those is the shape this repo has paid for most: the site nobody remembered is the one whose
 * first record lands in a collection with no index, and recall misses it for good once the fresh-write window
 * closes, with nothing reporting it.
 *
 * **So the forgettable part is not at the call sites at all.** Every one of them reaches a collection through
 * `getDb()` (directly or through `col()`), and `getDb()` hands out a database whose record collections report
 * each write they complete. A new write path cannot skip it without also skipping `getDb()`, and
 * `a-record-write-reaches-the-index-presence-observer.test.js` refuses a second door onto the database.
 *
 * ## Why a wrapper and not the driver's command monitoring
 *
 * `monitorCommands` sees every command too, and it was measured before this was written: with it on, the
 * driver materialises every reply as a plain object for the `commandSucceeded` event — including every cursor
 * batch it would otherwise parse lazily. That is a second deserialisation of every read the product makes,
 * paid to observe the writes. The wrapper touches writes only and costs a closure per write.
 *
 * ## What is reported, and WHEN
 *
 * AFTER the write settles, success or failure alike — an unordered `insertMany` that throws on one duplicate
 * has still inserted the rest. The listener's concurrency rule depends on "after": a write reported here has
 * committed, so anything that read the collection before the report either saw the record or reads again
 * (see `spaces/search-index-presence.ts`).
 *
 * **Inside a transaction, the report waits for the session to END.** A write in a transaction resolves before
 * it commits, and a reader outside the transaction does not see it — so reporting it at once would let the
 * listener check an apparently empty collection, conclude it needs no index, and be right until the commit a
 * moment later. Both transactions in this codebase end their session in a `finally`.
 *
 * ## One question
 *
 * It answers *"which record collections did this process just write to or delete from"*. It does not decide
 * what to do about it — that is the listener's question, and a db-layer module that knew about search indexes
 * would make every reader of a collection depend on the index lifecycle.
 */
import type { Collection, Db } from 'mongodb';
import { BOUNDED_OPTIONS_ARGUMENT, PLAIN_WRITE_METHODS, RETURNS_CURSOR, callBounded, type BoundTarget } from './write-bound.js';

/** What a method does to the set of records in its collection. */
export interface MethodEffect {
  /** May have added (or modified) a record: the collection may now hold one it did not. */
  write?: true;
  /** May have removed a record: the collection may now be empty. */
  delete?: true;
  /** The collection itself was dropped or renamed away: whatever was known about it is void. */
  forget?: true;
}

/**
 * Every method on the driver's `Collection`, classified — and `read` is a classification, not an omission.
 *
 * The gate reads `Collection.prototype` and fails on a method missing from this table, so a driver upgrade that
 * adds a write method is refused on the day it lands rather than becoming a door this observer does not watch.
 * An unclassified method is treated as a WRITE AND A DELETE at runtime for the same reason: an unknown effect is
 * reported as the widest one, never as none.
 *
 * `aggregate` is a read: a `$merge`/`$out` stage would write ANOTHER collection, none exists in this codebase,
 * and the gate refuses one in source.
 */
export const COLLECTION_METHOD_EFFECT: Readonly<Record<string, MethodEffect | 'read'>> = {
  insertOne: { write: true },
  insertMany: { write: true },
  updateOne: { write: true },
  updateMany: { write: true },
  replaceOne: { write: true },
  findOneAndUpdate: { write: true },
  findOneAndReplace: { write: true },
  bulkWrite: { write: true, delete: true },
  initializeOrderedBulkOp: { write: true, delete: true },
  initializeUnorderedBulkOp: { write: true, delete: true },
  deleteOne: { delete: true },
  deleteMany: { delete: true },
  findOneAndDelete: { delete: true },
  drop: { forget: true },
  rename: { forget: true },
  findOne: 'read', find: 'read', aggregate: 'read', count: 'read', countDocuments: 'read',
  estimatedDocumentCount: 'read', distinct: 'read', watch: 'read', options: 'read', isCapped: 'read',
  createIndex: 'read', createIndexes: 'read', dropIndex: 'read', dropIndexes: 'read', listIndexes: 'read',
  indexExists: 'read', indexInformation: 'read', indexes: 'read',
  listSearchIndexes: 'read', createSearchIndex: 'read', createSearchIndexes: 'read', dropSearchIndex: 'read',
  updateSearchIndex: 'read',
};

const UNKNOWN_EFFECT: MethodEffect = { write: true, delete: true };

export type RecordWriteListener = (collectionName: string, effect: MethodEffect) => void;

/**
 * The collection name a listener receives when EVERY collection changed at once — `reportDatabaseReplaced()` in
 * `db/mongo.ts`, after a writer the observer cannot see. Not a valid collection name, so it cannot collide.
 */
export const EVERY_COLLECTION = '*';

interface SessionLike { inTransaction(): boolean; once(event: 'ended', fn: () => void): unknown }

/**
 * The reports a session owes once it ENDS, keyed by the session — and the one `'ended'` listener that pays them.
 *
 * ONE listener per session, not one per write (`Q-311`). It used to be `session.once('ended', …)` per write, so a
 * merge of a hub — thousands of writes in one transaction — hung thousands of listeners on one session: Node's
 * `MaxListenersExceededWarning` past ten, and a closure per write held until the end. The reports themselves are
 * unchanged: every write is still reported once, after the session ends, in the order it was made.
 */
const owedAtEnd = new WeakMap<SessionLike, Array<() => void>>();

function reportWhenEnded(session: SessionLike, report: () => void): void {
  const owed = owedAtEnd.get(session);
  if (owed) { owed.push(report); return; }
  const list = [report];
  owedAtEnd.set(session, list);
  session.once('ended', () => {
    owedAtEnd.delete(session);
    for (const r of list) r();
  });
}

function transactionSessionOf(args: unknown[]): SessionLike | null {
  for (const a of args) {
    const s = (a as { session?: unknown } | null)?.session as Partial<SessionLike> | undefined;
    if (s && typeof s.inTransaction === 'function' && typeof s.once === 'function' && s.inTransaction()) {
      return s as SessionLike;
    }
  }
  return null;
}

/**
 * The bound's argument table is checked against this one at load (bundle-30 I6, C4), because the two tables answer
 * different questions about one method list and could drift apart silently: a method bounded but never classified is
 * a driver method this file does not know, and a method that writes but is not bounded is a write a seq hold cannot
 * end. The bulk-op BUILDERS are the stated exception — their write happens at `execute`, which an argument index
 * cannot express (`write-bound.ts`). `drop` and `rename` forget a collection and are not issued inside a hold.
 */
{
  const UNBOUNDABLE = new Set(['initializeOrderedBulkOp', 'initializeUnorderedBulkOp', 'drop', 'rename']);
  const unclassified = Object.keys(BOUNDED_OPTIONS_ARGUMENT).filter(m => !(m in COLLECTION_METHOD_EFFECT));
  const unbounded = Object.entries(COLLECTION_METHOD_EFFECT)
    .filter(([m, e]) => e !== 'read' && !UNBOUNDABLE.has(m) && BOUNDED_OPTIONS_ARGUMENT[m] === undefined).map(([m]) => m);
  const cursorUnbounded = [...RETURNS_CURSOR].filter(m => BOUNDED_OPTIONS_ARGUMENT[m] === undefined);
  // A write has TWO bound steps (the server's deadline, then the client's backstop — `write-bound.ts`), and a read has
  // one. A write missing from `PLAIN_WRITE_METHODS` would be bounded by the driver's `timeoutMS`, whose client clock
  // fires first: the write could land after the answer (`Q-372`). A read inside it would lose its cursor's deadline.
  const writesWithoutServerFirstBound = Object.entries(COLLECTION_METHOD_EFFECT)
    .filter(([m, e]) => e !== 'read' && BOUNDED_OPTIONS_ARGUMENT[m] !== undefined && !PLAIN_WRITE_METHODS.has(m)).map(([m]) => m);
  const readsBoundedAsWrites = [...PLAIN_WRITE_METHODS].filter(m => COLLECTION_METHOD_EFFECT[m] === 'read' || COLLECTION_METHOD_EFFECT[m] === undefined);
  if (unclassified.length > 0 || unbounded.length > 0 || cursorUnbounded.length > 0
    || writesWithoutServerFirstBound.length > 0 || readsBoundedAsWrites.length > 0) {
    throw new Error(`the write bound's method table disagrees with COLLECTION_METHOD_EFFECT: bounded but unclassified `
      + `[${unclassified}], writing but unbounded [${unbounded}], cursor methods unbounded [${cursorUnbounded}], `
      + `writing but without the server-first bound [${writesWithoutServerFirstBound}], `
      + `server-first bound on a method that does not write [${readsBoundedAsWrites}]`);
  }
}

/**
 * Wrap `db` so the collections `isObserved` names report each write to `listener` — and so EVERY collection's
 * operations carry the write bound while a bound scope is active (`db/write-bound.ts`, `Q-213`).
 *
 * ## Why the bound is composed here
 *
 * This proxy is the one door every collection is reached through, and a seq hold must bound EVERY operation issued
 * inside it — the counter `$inc`, the tombstones, the embed jobs, not only the record collections this observer
 * reports on. A second wrapper would be a second door, which the gate refuses; so the door gained a second
 * duty, and each duty stays in its own module: what a bound IS, and which argument carries it, is
 * `write-bound.ts`'s; this file only applies it. Outside a scope `callBounded` calls with the arguments
 * unchanged, so an unobserved collection pays a closure per method call and nothing else.
 */
export function observeRecordWrites(db: Db, isObserved: (name: string) => boolean, listener: RecordWriteListener): Db {
  return new Proxy(db, {
    get(target, prop, receiver) {
      if (prop !== 'collection') return Reflect.get(target, prop, receiver);
      return (name: string, options?: object) =>
        // `target.timeoutMS` is the `timeoutMS` every operation of this database inherits (the client's, from `MONGO_URI`), which
        // a bounded plain write has to neutralise (`db/write-bound.ts`).
        observeCollection(target.collection(name, options as never), name, isObserved(name) ? listener : null,
          { collection: name, inheritedTimeoutMs: target.timeoutMS });
    },
  });
}

function observeCollection<T extends object>(
  coll: Collection<T>, name: string, listener: RecordWriteListener | null, boundTarget: BoundTarget,
): Collection<T> {
  return new Proxy(coll, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver) as unknown;
      if (typeof prop !== 'string' || typeof value !== 'function') return value;
      const bounded = BOUNDED_OPTIONS_ARGUMENT[prop] !== undefined;
      const classified = COLLECTION_METHOD_EFFECT[prop];
      const reports = listener !== null && classified !== 'read';
      if (!bounded && !reports) return value;
      const effect = classified === 'read' ? UNKNOWN_EFFECT : classified ?? UNKNOWN_EFFECT;
      return (...given: unknown[]) => {
        const call = (a: unknown[]): unknown => (value as (...x: unknown[]) => unknown).apply(target, a);
        let out: unknown;
        if (bounded) {
          // A hold whose time is spent refuses the operation unsent; nothing was written, so nothing is reported.
          try { out = callBounded(prop, given, call, boundTarget); } catch (err) {
            if (RETURNS_CURSOR.has(prop)) throw err;
            return Promise.reject(err);
          }
        } else {
          out = call(given);
        }
        if (!reports || listener === null) return out;
        const heard = listener;
        const report = (): void => {
          const session = transactionSessionOf(given);
          if (session) reportWhenEnded(session, () => safely(heard, name, effect));
          else safely(heard, name, effect);
        };
        if (out && typeof (out as Promise<unknown>).then === 'function') {
          return (out as Promise<unknown>).then(r => { report(); return r; }, err => { report(); throw err; });
        }
        // A bulk-op builder: the write happens at `execute`, so that is what reports.
        const exec = (out as { execute?: (...a: unknown[]) => Promise<unknown> } | null)?.execute;
        if (typeof exec === 'function') {
          (out as { execute: unknown }).execute = (...a: unknown[]) =>
            exec.apply(out, a).then(r => { report(); return r; }, err => { report(); throw err; });
          return out;
        }
        report();
        return out;
      };
    },
  });
}

/** A listener that throws must never turn a write that succeeded into one that failed. */
function safely(listener: RecordWriteListener, name: string, effect: MethodEffect): void {
  try { listener(name, effect); } catch { /* the listener logs its own failures */ }
}
