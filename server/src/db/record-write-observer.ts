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
 * Wrap `db` so the collections `isObserved` names report each write to `listener`.
 *
 * Every other collection is returned untouched, so the cost is paid only on the collections that asked.
 */
export function observeRecordWrites(db: Db, isObserved: (name: string) => boolean, listener: RecordWriteListener): Db {
  return new Proxy(db, {
    get(target, prop, receiver) {
      if (prop !== 'collection') return Reflect.get(target, prop, receiver);
      return (name: string, options?: object) => {
        const coll = target.collection(name, options as never);
        return isObserved(name) ? observeCollection(coll, name, listener) : coll;
      };
    },
  });
}

function observeCollection<T extends object>(coll: Collection<T>, name: string, listener: RecordWriteListener): Collection<T> {
  return new Proxy(coll, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver) as unknown;
      if (typeof prop !== 'string' || typeof value !== 'function') return value;
      const classified = COLLECTION_METHOD_EFFECT[prop];
      if (classified === 'read') return value;
      const effect = classified ?? UNKNOWN_EFFECT;
      return (...args: unknown[]) => {
        const report = (): void => {
          const session = transactionSessionOf(args);
          if (session) session.once('ended', () => safely(listener, name, effect));
          else safely(listener, name, effect);
        };
        const out = (value as (...a: unknown[]) => unknown).apply(target, args);
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
