/**
 * A collection's search indexes exist exactly while the collection holds a record (Q-165).
 *
 * ## Why
 *
 * mongot keeps one change-stream cursor per search index over the shared oplog, so mongod's cost grows with
 * index count times write rate, and every index's freshness is one rotation of ALL of them over a fixed
 * dispatcher pool. Measured on a production instance: half of its record collections were empty, and every one
 * still carried an index — about half the cursors, and half of both costs, spent on collections that could not
 * return a result. So an index is now created when its collection's first record arrives and dropped when the
 * last one goes. Every read path already answers an absent index as an empty collection, which is what an
 * empty collection is; spaces keep their own collections, so physical isolation is unchanged.
 *
 * ## Where the writes are seen — nowhere a caller has to remember
 *
 * `db/record-write-observer.ts` reports every completed write and delete on a record collection that went
 * through `getDb()`, which is every one this process makes. This module subscribes to it. No write path calls
 * in, so no write path can forget to; the one door that bypasses `getDb()` — a backup restore, on its own
 * client — is followed by a forced rebuild of every space, which comes here.
 *
 * ## The ordering that keeps a record from landing in a collection with no index
 *
 * The race that matters: the last record is deleted, this module reads the collection empty and drops its
 * index, and a record written in between is left with no index to find it. The rule is three steps, in this
 * order, and each one is load-bearing:
 *
 *  1. **Per collection, one reconcile at a time** — a promise chain, so a drop and a create never interleave.
 *  2. **A reconcile marks the collection `settling` BEFORE it reads it.** From that moment, any write that is
 *     reported schedules another reconcile behind this one.
 *  3. **A write is reported only after it has committed** (the observer reports on settle, and a write in a
 *     transaction waits for its session to end).
 *
 * Proof: take a write W and a reconcile R that reads the collection empty and drops. Either W committed before
 * R's read — then R saw W's record and did not drop — or it committed after, so W was reported after R's read,
 * which is after R marked `settling`; W's report therefore queued a reconcile behind R, and that one reads the
 * record and builds the index. The window in between is covered by recall's fresh-write channel, which scores
 * the newest records from the collection itself and exists precisely for records the index has not ingested.
 *
 * **Why `settling` and not a lock:** a write must never wait on the index lifecycle. Reporting is synchronous,
 * costs a map lookup when the collection is already indexed, and at most queues work.
 *
 * ## What each step costs, because it runs on the write path's heels
 *
 * - A write to a collection this process knows is indexed: one map lookup, nothing else.
 * - A write to one that is not (the first record, or the first after a restart): one `findOne` and one
 *   `listSearchIndexes`, then a `createSearchIndex` when it is really absent — once per collection per process.
 * - A delete: nothing immediately. The emptiness check runs {@link DROP_CHECK_DELAY_MS} after the LAST delete of
 *   a burst, so a wipe of ten thousand records reads the collection once, and a record deleted and replaced a
 *   moment later does not cost a drop and a rebuild. The check itself is one `findOne`.
 *
 * ## The belief is per process, and that is the deployment
 *
 * `indexed`/`unindexed` is what THIS process built, verified or dropped. One server process owns a database
 * (the shipped manifests run one replica), so nothing else changes an index underneath it — except an operator
 * by hand, which the rebuild route (`force`) re-reads from scratch. A second process writing the same database
 * would be one this belief cannot see; boot re-reads every collection, so a restart heals it.
 *
 * ## Existing spaces heal at boot
 *
 * `initSpace` reconciles every collection of the space: an empty collection's leftover indexes are dropped and a
 * populated one's are validated exactly as before. Nothing is rebuilt that was serving.
 *
 * ## Decisions taken conservatively, and why
 *
 * - **Deployments where search is unavailable** are left alone: nothing is created or dropped, as before.
 * - **The face gallery follows its collection (`files`)**, not whether a face vector exists — the same
 *   condition that governed it before, narrowed only by "the collection holds a record".
 * - **An index that failed to build is retried by a later write**, at most once per {@link RETRY_AFTER_MS}, so
 *   a mongot refusing every create is not asked again on every write.
 */
import { onRecordCollectionWrite } from '../db/mongo.js';
import { EVERY_COLLECTION, type MethodEffect } from '../db/record-write-observer.js';
import { log } from '../util/log.js';
import { envInt } from '../config/env-num.js';
import {
  VECTOR_INDEXED_COLLECTIONS, type VectorIndexedCollection,
  ensureCollectionSearchIndexes, dropCollectionSearchIndexes, searchAvailable,
} from './vector-index.js';
import { collectionHoldsRecord } from './record-presence.js';

/** How long after the last delete of a burst the collection is checked for emptiness. */
export const DROP_CHECK_DELAY_MS = envInt('SEARCH_INDEX_DROP_DELAY_MS', 60_000);

/** How long a failed index build waits before a write may try it again. */
export const RETRY_AFTER_MS = 30_000;

/**
 * What this process last established about a collection's search indexes.
 * `settling` = a reconcile is reading it now; absent = never established (a restart, a dropped collection).
 */
type Belief = 'indexed' | 'unindexed' | 'settling';

interface CollectionState {
  belief?: Belief;
  /** The serial chain every reconcile of this collection runs on. */
  chain: Promise<unknown>;
  /** A write- or delete-triggered reconcile that is queued and has not started — later reports join it. */
  queued: Promise<Belief | undefined> | null;
  dropCheck?: ReturnType<typeof setTimeout>;
  retryAt?: number;
}

const states = new Map<string, CollectionState>();
let armed = false;

const SPACE_ID = /^[a-z0-9-]+$/;

/** `<spaceId>_<suffix>` for a collection that carries search indexes, parsed — or null for any other name. */
export function parseIndexedCollection(name: string): { spaceId: string; suffix: VectorIndexedCollection } | null {
  const cut = name.indexOf('_');
  if (cut <= 0) return null;
  const spaceId = name.slice(0, cut);
  const suffix = name.slice(cut + 1);
  if (!SPACE_ID.test(spaceId) || !(VECTOR_INDEXED_COLLECTIONS as readonly string[]).includes(suffix)) return null;
  return { spaceId, suffix: suffix as VectorIndexedCollection };
}

function stateOf(name: string): CollectionState {
  let st = states.get(name);
  if (!st) { st = { chain: Promise.resolve(), queued: null }; states.set(name, st); }
  return st;
}

interface ReconcileOpts {
  /** Explicit (boot, rebuild, schema change): always read and act, never trust the belief. */
  explicit?: boolean;
  waitForReady?: boolean;
  force?: boolean;
}

/** Queue a reconcile on the collection's chain. Report-triggered ones coalesce into one that has not started. */
function schedule(name: string, opts: ReconcileOpts = {}): Promise<Belief | undefined> {
  const st = stateOf(name);
  if (!opts.explicit && st.queued) return st.queued;
  const task = st.chain.then(async () => {
    if (!opts.explicit) st.queued = null;
    return reconcileNow(name, st, opts);
  });
  if (!opts.explicit) st.queued = task;
  st.chain = task.catch(() => undefined);
  return task;
}

async function reconcileNow(name: string, st: CollectionState, opts: ReconcileOpts): Promise<Belief | undefined> {
  const parsed = parseIndexedCollection(name);
  if (!parsed) return undefined;
  const { spaceId, suffix } = parsed;
  const before = st.belief;
  // Step 2 of the ordering in the module docblock: BEFORE the read, so a write committed after it is reported
  // into a state that queues another reconcile.
  st.belief = 'settling';
  try {
    let holds: boolean;
    try {
      holds = await collectionHoldsRecord(name);
    } catch (err) {
      st.belief = before === 'settling' ? undefined : before;
      log.debug(`Search index presence: could not read ${name} (${err instanceof Error ? err.message : String(err)})`);
      return st.belief;
    }

    if (holds) {
      if (!opts.explicit && before === 'indexed') return (st.belief = 'indexed');
      if (!opts.explicit && st.retryAt !== undefined && Date.now() < st.retryAt) return (st.belief = undefined);
      const outcome = await ensureCollectionSearchIndexes(spaceId, suffix, opts.waitForReady ?? false, { force: opts.force });
      if (outcome === 'failed') {
        st.retryAt = Date.now() + RETRY_AFTER_MS;
        return (st.belief = undefined);
      }
      st.retryAt = undefined;
      // `unavailable` is recorded as indexed on purpose: there is nothing a write could do about it, and the
      // probe that decided it is memoised for the process. Boot and the rebuild route ask again.
      return (st.belief = 'indexed');
    }

    if (!opts.explicit && before === 'unindexed') return (st.belief = 'unindexed');
    if (!(await searchAvailable())) return (st.belief = 'unindexed');
    const dropped = await dropCollectionSearchIndexes(spaceId, suffix);
    if (!dropped) {
      // A swap in flight, or a drop mongot refused: try again after the same delay a delete waits.
      armDropCheck(name);
      return (st.belief = undefined);
    }
    return (st.belief = 'unindexed');
  } catch (err) {
    st.belief = undefined;
    log.warn(`Search index presence: reconciling ${name} failed (${err instanceof Error ? err.message : String(err)}); the next write retries`);
    return undefined;
  }
}

function armDropCheck(name: string): void {
  const st = stateOf(name);
  if (st.dropCheck) clearTimeout(st.dropCheck);
  st.dropCheck = setTimeout(() => { st.dropCheck = undefined; void schedule(name); }, DROP_CHECK_DELAY_MS);
  // Never the reason a process stays alive: a pending emptiness check is an optimisation, not work.
  st.dropCheck.unref?.();
}

/** The observer's listener. Synchronous and cheap — it runs after every write to a record collection. */
function onRecordWrite(name: string, effect: MethodEffect): void {
  if (!armed) return;
  if (effect.forget && name === EVERY_COLLECTION) {
    // The database was replaced under the observer (a restore): nothing believed about any collection holds.
    for (const [n] of states) onRecordWrite(n, { forget: true });
    return;
  }
  if (effect.forget) {
    const st = states.get(name);
    if (st?.dropCheck) clearTimeout(st.dropCheck);
    // Keep the chain (a reconcile may be running on it); forget only what was believed.
    if (st) { st.belief = undefined; st.retryAt = undefined; }
    return;
  }
  const st = stateOf(name);
  if (effect.write && st.belief !== 'indexed') void schedule(name);
  if (effect.delete) armDropCheck(name);
}

onRecordCollectionWrite(name => parseIndexedCollection(name) !== null, onRecordWrite);

/**
 * Start following writes. Called by `initSpace`, the first thing a process does with any space — at boot, at
 * first-run setup and at creation — so a serving process is always armed before it reconciles, and a script
 * or test that merely opens the database never starts index work it did not ask for.
 *
 * Writes made BEFORE arming (boot migrations) are not lost: the reconcile each `initSpace` runs next reads every
 * collection as it is.
 */
export function armSearchIndexPresence(): void { armed = true; }

/**
 * Make the database agree with the rule for every indexed collection of a space: build (or validate) the
 * indexes of each collection that holds a record, drop those of each that holds none.
 *
 * The one entry point for boot, space creation, the rebuild route, a restore and a schema change. `force` is the
 * rebuild route's: do not trust the "definition already matches" shortcut.
 */
export async function reconcileSpaceSearchIndexes(
  spaceId: string,
  opts: { waitForReady?: boolean; force?: boolean } = {},
): Promise<void> {
  for (const suffix of VECTOR_INDEXED_COLLECTIONS) {
    await schedule(`${spaceId}_${suffix}`, { explicit: true, ...opts });
  }
}

/** Wait until every reconcile queued so far on a space's collections has finished. For tests and shutdown. */
export async function searchIndexPresenceSettled(spaceId: string): Promise<void> {
  for (const suffix of VECTOR_INDEXED_COLLECTIONS) {
    const st = states.get(`${spaceId}_${suffix}`);
    if (st) await st.chain;
  }
}

/** Run the delayed emptiness check of a collection now instead of after the delay. For tests. */
export function checkEmptinessNow(name: string): Promise<Belief | undefined> {
  const st = stateOf(name);
  if (st.dropCheck) { clearTimeout(st.dropCheck); st.dropCheck = undefined; }
  return schedule(name);
}
