/**
 * File sync tombstones — and the one module that reads or writes them.
 *
 * A `FileTombstoneDoc` in the per-space `<spaceId>_file_tombstones` collection records that a file was deleted locally.
 * The sync engine pushes these to peers, which then unlink the file and drop its metadata — without them, a peer's
 * manifest still advertises the file and pushes it straight back (resurrection). Every code path that deletes a file
 * (API, folder delete, move, MCP, TTL sweep) must write one.
 *
 * ## A tombstone is PENDING until the act it records has happened (bundle-30 I13, I14, I15)
 *
 * Every path that removes a file — `deleteFileCascade`, the directory delete, `moveFileCascade` — writes its tombstone
 * BEFORE the irreversible step (the unlink, the tree removal, the rename). Written after, a store failure on it left
 * bytes gone with no tombstone, which nothing repairs: the retry finds no file, and a peer's manifest pushes it back
 * for good (I13).
 *
 * But written before must not mean published before. A peer that receives a tombstone deletes its copy, STORES the
 * tombstone and serves it back (`POST /api/sync/file-tombstones`), and this instance's pull then deletes its own copy.
 * I14 withdrew a failed act's tombstone with a retried `deleteMany` held in memory: a sync cycle in between, or a
 * restart, published it anyway, and a failed move lost its file on every instance (preship-3 P3-1). A delete whose
 * unlink failed for a reason that was not the store's never withdrew at all (P3-3). So a tombstone has two phases:
 *
 * - **Written pending** ({@link writePendingFileTombstones}), before the irreversible step. **Nothing that serves,
 *   replicates, prunes or counts tombstones sees a pending one**: every reader of the collection is in this module
 *   (`a-file-tombstone-is-read-through-its-one-module.test.js`) and reads only {@link PUBLISHED} ones — with ONE
 *   exception, which is a question and not a service: what an ARRIVING file is compared with also takes a pending tombstone
 *   whose act has already removed the path's bytes ({@link decideArrivals}, Q-348), because that delete has happened.
 * - **Confirmed** ({@link confirmFileTombstones}) once ITS OWN path's bytes are gone or moved, and stamped with that
 *   time, so a push position a peer acknowledged meanwhile cannot prune it unsent. A store failure there fails the act
 *   (`503`); its retry, or the settle below, finishes it. Per path, not per act: one act's paths can lose their bytes
 *   at different steps — a move's or a directory delete's sidecars go after the file — so each step publishes only
 *   the paths it removed ({@link actUnderPendingTombstones}), and a later step settles its own (bundle-30 I16,
 *   preship-4 P4-3).
 * - **Settled from the disk** when a step fails ({@link actUnderPendingTombstones}), at once: a recursive removal can
 *   stop part way, so the files it did remove are published and the rest dropped (preship-4 P4-2). One rule, in
 *   {@link settleFromTheDisk} — the path still has bytes, so the act did not remove it: dropped; it has none, so it
 *   did: published.
 * - **Dropped** when its own write is reported failed ({@link dropPendingFileTombstones}) — one attempt, behind the
 *   caller, because nothing irreversible happened and nothing depends on it.
 * - **Settled** once it outlives its act ({@link settleStalePendingFileTombstones}, every TTL sweep cycle): its drop
 *   failed, its write was reported failed and landed later, or a restart came between. The same rule.
 * - **One per path per act** ({@link publishOnePerPath}, every one of the ways above): publishing a path's tombstone
 *   removes every other pending tombstone for that path, and one written before a tombstone already published for its
 *   path is dropped rather than published. A retried act's first attempt left its pending tombstone behind, and it
 *   used to be published as a second one — at once for a move, by the TTL settle minutes later for a delete — which a
 *   receiver applies like the first, deleting a re-upload of the path made in between (bundle-30 I17, verify-drive-5
 *   F1).
 *
 * **The invariants: a peer is told a path is gone only once it is gone here, and once per act.**
 *
 * ## What crosses the wire
 *
 * `FileTombstoneDoc` is the replicated shape and the only one served ({@link WIRE}): `_id`, `spaceId`, `path`,
 * `deletedAt`, and `issuer` and `rowSeq` where the act knew them — exactly what a receiver's `POST /file-tombstones`
 * stores. `pending`, `move`, `contentHash`, `storedVia` and `positionAt` are this instance's own
 * ({@link StoredFileTombstone}): a pending tombstone is never served, a confirmed one carries no `pending`, and the
 * projection keeps every local field off the wire rather than each reader remembering to. File tombstones are not
 * hashed (`brain/merkle.ts` reads none), so no hash rule applies to either field.
 *
 * ## Positions, and what an arrival is compared with (bundle-51)
 *
 * A tombstone has no seq, so paging, acknowledgement and pruning key on a LOCAL position, `positionAt`: the publish time of
 * an own tombstone, the RECEIVE time of a relayed one ({@link fileTombstonePosition} is the one reading of it, falling back to
 * `deletedAt` for a row stored before positions existed). A relayed tombstone keyed by its sender's `deletedAt` was pruned
 * before it was ever served when that was old, and a far-future one sat above every acknowledgement for ever.
 *
 * **A position is never handed out while an earlier one is uncommitted** (Q-346): a stamp is taken from this instance's
 * monotonic per-space clock and held until its write ends ({@link withPositionHeld}, the position instance of
 * `util/horizon-holds.ts`), and every page and the prune read strictly below the lowest open stamp
 * ({@link settledPositionCap}). Without it a later tombstone's acknowledgement covered an earlier one whose write had not
 * landed, and the prune took it unsent.
 *
 * **One per path, by this instance's own order** (Q-352): a pending row carries `writtenAt` (the clock above, set by the
 * act) and `settleAt` (what the settle selects and bumps); a published row carries `origin` (`own`, or `relayed`). Only an
 * own publication can cover a pending delete ({@link publishOnePerPath}), the publishers of a space run one at a time, and
 * the prune keeps a published tombstone whose path still holds a pending one.
 *
 * **A wipe is not undone** (Q-406): {@link forgetFileTombstonesOf} is the one way the collection is emptied, and a publish or
 * settle that began before it drops instead of re-creating a row.
 *
 * A held tombstone is also a statement about a VERSION of a path, not about the path for ever: `rowSeq` is the version it
 * erased and `contentHash` the hash of the content (this instance's own row, never read from bytes). An arriving file is
 * compared with them in one place, {@link decideArrivals} — by version for metadata, by content for bytes — so a peer that
 * still holds a deleted file cannot bring it back through any door, and a newer version of the path is never refused. A PENDING
 * tombstone whose act has already removed the path's bytes counts exactly as a published one (Q-348): the delete happened and is
 * only waiting to be published. The stray drain alone reads the published ones ({@link heldFileTombstones}). **A sidecar of a deleted
 * file** (`_converted/<p>.md`, `_extracted/<p>/…`) has no tombstone of its own: it is shadowed by its PARENT's, under the same
 * conditions, in the same place ({@link shadowedByParent}).
 *
 * ## A move's marker
 *
 * A move's tombstones also name the move (`move: { from, to }`). With no bytes at `from` and bytes at `to`, that is the
 * only thing that tells a move a store failure stopped after its bytes from an orphan `from` beside an unrelated `to`
 * — which the retry used to "complete", overwriting `to`'s derived records (preship-3 P3-2). Cleared once the move is
 * finished.
 */

import { v4 as uuidv4 } from 'uuid';
import { toDocId } from '../util/paths.js';
import { col, asBulk, asDoc, asFilter, asUpdate } from '../db/mongo.js';
import { bulkCommandOf, writeInOneCommands } from '../db/one-command.js';
import { readStoredById, READ_CHUNK } from '../db/read-by-id.js';
import type { FileTombstoneDoc, FileMetaDoc } from '../config/types.js';
import { authorRef } from '../config/author.js';
import { log, peerText } from '../util/log.js';
import { classifyReadFailure, throwIfStoreSide, unlessTheStoreFailed } from '../brain/store-failure.js';
import { spaceCollection } from '../db/space-collection.js';
import { indexNamesOf } from '../db/index-names.js';
import { DetachedWork } from '../util/detached-work.js';
import { inChunks } from '../util/chunks.js';
import { encodeIsoCursor, isoKeysetFilters, isoKeysetSort, tieThenRange, ISO_READ_START, type IsoPosition } from '../util/seq-keyset.js';
import { HorizonHolds, heldWhile } from '../util/horizon-holds.js';
import { keyedLock } from '../util/keyed-lock.js';
import { bytesPresentAt } from './stored-bytes.js';
import { parentOfSidecar } from './moved-paths.js';
import {
  heldByPath, erasedContent, shadowDecision, cannotTellIfDeleted, pathsDecidingArrivals, parentShadows, recreatedSince, STORED_ROW_PROJECTION,
  type HeldFileTombstone, type FileArrival, type ArrivalVerdicts, type StoredFileRow,
} from './tombstone-shadow.js';

// The arrival decision lives in `tombstone-shadow.ts` (pure, over rows already read); these are its public names, here, where every caller reads them.
export { shadowDecision, type HeldFileTombstone, type MetaArrival, type FileArrival, type ArrivalVerdicts } from './tombstone-shadow.js';

/** A file tombstone as stored HERE: the replicated shape, plus what never leaves this instance. */
interface StoredFileTombstone extends FileTombstoneDoc {
  /** Set until the act the tombstone records has happened. Never served, pushed, pruned or counted. */
  pending?: true;
  /** The move that wrote it, when one did: what tells a retried move it is owed. */
  move?: { from: string; to: string };
  /** The hash of the file row's content when the act (or the apply) removed it, as THIS instance held it — what a
   *  later byte arrival is compared with (`shadowDecision`). Never on the wire: a deletion carries no fingerprint of
   *  the erased content. */
  contentHash?: string;
  /** The upstream that delivered a RELAYED tombstone, so a later version from that same upstream is not refused by it. */
  storedVia?: string;
  /** This instance's own position for the tombstone, for paging, acknowledgement and pruning: the publish time of an
   *  own one, the RECEIVE time of a relayed one — a foreign clock never enters a local position. */
  positionAt?: string;
  /** When the act that wrote it PUT it: a stamp of this instance's monotonic clock ({@link PositionClock}), so any two rows
   *  of one space order by it. What the one-per-path rule compares; `deletedAt` is the same instant while pending and the
   *  publish time after, and a foreign or settled clock never decides. Absent on a row stored before it existed. */
  writtenAt?: string;
  /** What the settle selects and orders by, while pending: `writtenAt` until the settle cannot look at the path, then the
   *  settle's own `now` — never `deletedAt` or `writtenAt`, which the one-per-path rule reads. */
  settleAt?: string;
  /** Who made the published row: `own` (this instance published it) or `relayed` (a peer's, kept to be passed on). A row
   *  with neither stamp is never taken for one this instance published, so it never suppresses an own tombstone. */
  origin?: 'own' | 'relayed';
}

/**
 * The fields a file tombstone has on the wire. Every serving reader projects to these and nothing else. Exported so a
 * gate can derive the wire shape from it instead of keeping a list that goes stale the day a field joins (`issuer` and
 * `rowSeq` did).
 */
export const WIRE = { _id: 1, spaceId: 1, path: 1, deletedAt: 1, issuer: 1, rowSeq: 1 } as const;
/** A tombstone whose act has happened: the only kind any reader outside the act's own bookkeeping may see. */
const PUBLISHED = { pending: { $exists: false } } as const;
/** How long a pending tombstone may wait for its act before the TTL sweep settles it from the disk. */
const STALE_AFTER_MS = 10 * 60_000;
/** How many stale pending tombstones one space settles per sweep cycle, oldest first; the rest wait for the next. */
export const FILE_TOMBSTONE_SETTLE_BATCH = 500;

const tombstonesOf = (spaceId: string) => col<StoredFileTombstone>(spaceCollection(spaceId, 'fileTombstones'));

/**
 * The indexes the routine questions asked of a space's file tombstones need (bundle-30 I16, preship-4 P4-6). Each
 * entry says which question it serves; add one only with the question that needs it.
 *
 * Without them both were collection scans, on a collection a space with an offline peer never prunes.
 */
export const FILE_TOMBSTONE_INDEXES = [
  // The settle: `{ pending: true, settleAt <= t }` sorted by `settleAt` (bundle-71, Q-352: the clock the settle moves, which
  // is not the clock the one-per-path rule reads). Partial, so it holds only the pending few. It replaces `{ pending, deletedAt }`,
  // which `ensureFileTombstoneIndexes` drops ({@link REPLACED_FILE_TOMBSTONE_INDEXES}).
  { keys: { pending: 1, settleAt: 1 }, options: { partialFilterExpression: { pending: { $exists: true } } } },
  // A move's marker: `moveWasBegun`, `settleBegunMove` and `forgetFinishedMove`, once or more per move. Sparse: only a
  // move's tombstones carry it, and only until the move is finished.
  { keys: { 'move.from': 1, 'move.to': 1 }, options: { sparse: true } },
  // One tombstone per path: `publishOnePerPath` reads a path's tombstones and removes its other pending ones, on every
  // publish (bundle-30 I17); `heldFileTombstones` (what an arriving file is compared with) asks by path too.
  { keys: { path: 1 }, options: {} },
  // The served page and the push's pages: `{ positionAt > p }` (and `{ positionAt = p, _id > id }` for the rest of a run)
  // sorted by `(positionAt, _id)`, every request of every peer every cycle (bundle-51, Q-96). Partial on the stamp, which
  // only a PUBLISHED tombstone carries, so the few pending ones are not in it; a read always names `positionAt`, which is
  // what lets the planner use a partial index.
  { keys: { positionAt: 1, _id: 1 }, options: { partialFilterExpression: { positionAt: { $exists: true } } } },
] as const;

/**
 * Create {@link FILE_TOMBSTONE_INDEXES} for one space. Idempotent, so `initSpace` runs it for a new space and the boot
 * pass (`ensureQueryIndexes`) for every space initialisation does not revisit — here, because this module is the one
 * that opens the collection.
 */
export async function ensureFileTombstoneIndexes(spaceId: string): Promise<void> {
  for (const ix of FILE_TOMBSTONE_INDEXES) await tombstonesOf(spaceId).createIndex(ix.keys, ix.options);
  // Local state, so there is nothing to migrate but the index: the one a question no longer asks is maintained on every
  // pending write for nothing. Dropped only when listed (`indexNamesOf`, as `spaces/keyset-indexes.ts` drops the bare index it
  // replaces): an index already gone is the state wanted, and a drop that fails any other way is the pass's failure.
  const present = await indexNamesOf(spaceCollection(spaceId, 'fileTombstones'));
  for (const name of REPLACED_FILE_TOMBSTONE_INDEXES.filter(n => present.includes(n))) await tombstonesOf(spaceId).dropIndex(name);
}

/** The indexes a later release replaced, by name: dropped by {@link ensureFileTombstoneIndexes}. */
const REPLACED_FILE_TOMBSTONE_INDEXES = ['pending_1_deletedAt_1'] as const;

/**
 * THE position of a tombstone: its own `positionAt`, or — for one stored before positions existed — its `deletedAt`, which
 * was the position then. What an acknowledgement, a prune and a page compare, and nothing else is. Pure. Named for the
 * tombstone because `util/seq-keyset.ts` and `sync/seq-run-pager.ts` each read a position of their own kind.
 */
export const fileTombstonePosition = (t: { positionAt?: unknown; deletedAt?: unknown }): string | undefined =>
  typeof t.positionAt === 'string' ? t.positionAt : typeof t.deletedAt === 'string' ? t.deletedAt : undefined;

/**
 * Give every published tombstone stored before positions existed one (migration of LOCAL state: a file tombstone is never
 * hashed and its position is this instance's own). The position is NOW and not the row's `deletedAt`: an own tombstone's
 * `deletedAt` was its position, but a relayed one carried the SENDER's clock, which is exactly what a local position must
 * never hold — and now sorts above every acknowledgement recorded so far, so the one thing it can cost is that a row is kept
 * until its next acknowledgement, never pruned unsent. Idempotent and cheap when there is nothing to do, so the boot pass
 * runs it for every space; a row with no comparable `deletedAt` to carry is left alone.
 *
 * Until it has run, a page read does not see such a row (it reads `positionAt`); the push then sends fewer and
 * acknowledges only what it sent, so the gap is a delay and never a loss.
 */
export async function positionLegacyFileTombstones(spaceId: string): Promise<number> {
  // Its stamp is a position like any other, so it is held like any other: a page read between the stamp and the write's
  // commit would hand a peer a position above a row that has not landed.
  return withPositionHeld(spaceId, async (stamp) => {
    const res = await tombstonesOf(spaceId).updateMany(
      asFilter<StoredFileTombstone>({ ...PUBLISHED, positionAt: { $exists: false }, deletedAt: { $type: 'string' } }),
      asUpdate<StoredFileTombstone>({ $set: { positionAt: stamp } }));
    return res.modifiedCount;
  }, 'file.tombstone.legacy');
}

// ── A position is never handed out while an earlier one is uncommitted (Q-346) ─────────────────────────────────────

/*
 * A tombstone's position (`positionAt`) is stamped BEFORE its write commits, and a push acknowledges the highest position it
 * SENT, and the prune removes everything at or below the acknowledgement. So a later tombstone that committed and was pushed
 * while an earlier stamp's write was still in flight carried the acknowledgement over a row no peer had been sent, and the
 * prune took it: the deleted file came back from the one peer that held it.
 *
 * It is the seq horizon's defect for an instant, and it has the seq horizon's cure (`util/horizon-holds.ts`): the stamp and
 * its hold are taken in ONE step ({@link withPositionHeld}), the write runs inside the hold, and every reader that compares a
 * position — a page, the prune — is capped below the lowest open one ({@link settledPositionCap}).
 */

/** The position hold: open stamps, per space. Its lines and its gauge (`ythril_file_tombstone_oldest_hold_seconds`) say so. */
const positionHolds: HorizonHolds<string> = new HorizonHolds<string>({
  noun: 'file tombstone position', floorKey: 'at', floorName: 'position', readers: 'every page and prune of the space\'s file tombstones',
});

/** The lowest stamp of an open position hold of `spaceId`, or undefined when none is open: what a page is capped below. For tests. */
export function lowestUncommittedPosition(spaceId: string): string | undefined {
  return positionHolds.lowest(spaceId);
}

/** How long the oldest open position hold of `spaceId` has been held, in seconds — 0 when none. For the gauge. */
export function oldestPositionHoldAgeSeconds(spaceId: string): number {
  return positionHolds.oldestAgeSeconds(spaceId);
}

/** This instance's clock for one space: the last instant it handed out, in epoch milliseconds. */
interface PositionClock { last: number }
const clocks = new Map<string, Promise<PositionClock>>();

/**
 * The space's clock, seeded ONCE from the highest position stored (the `{ positionAt, _id }` index, read backwards) — as the seq
 * horizon seeds `maxSeen` from what is stored — so a restart with the wall clock behind what an earlier run handed out cannot stamp
 * below a position a peer has acknowledged. A seed that fails is not remembered: the next caller reads again.
 */
function clockOf(spaceId: string): Promise<PositionClock> {
  let clock = clocks.get(spaceId);
  if (!clock) {
    clock = tombstonesOf(spaceId)
      .find(asFilter<StoredFileTombstone>({ positionAt: { $exists: true } }), { projection: { positionAt: 1 } })
      .sort({ positionAt: -1, _id: -1 }).limit(1).toArray()
      .then(([top]) => ({ last: Math.max(0, Date.parse(top?.positionAt ?? '') || 0) }));
    clocks.set(spaceId, clock);
    clock.catch(() => { if (clocks.get(spaceId) === clock) clocks.delete(spaceId); });
  }
  return clock;
}

/**
 * The clock for a WRITE. A seed that could not be read is never the write's failure: it puts a READ before the write, and the
 * failure the doors answer for a store that is down is the write's (`a-store-failure-answers-alike-on-every-door-db`, as for
 * {@link readFileRows}). The write that follows meets the same fault. The stamp then comes from the wall clock alone — the
 * restart guarantee is the seed's, and a store that answers the write but not the seed a moment before is the stated limit of it
 * — and the seed is not remembered, so the next caller reads it again.
 */
async function clockForWrite(spaceId: string): Promise<PositionClock> {
  try {
    return await clockOf(spaceId);
  } catch (err) {
    if (classifyReadFailure(err).status < 500) {
      log.warn(`file tombstone clock for ${peerText(spaceId)} could not be seeded from the stored positions: ${peerText(err)}`);
    }
    return { last: 0 };
  }
}

/**
 * The next instant the space's clock WOULD hand out (epoch milliseconds), without handing it: the wall clock, or one millisecond past
 * the last handed out when the wall clock has not moved (or went back). The one formula of "what comes next" — {@link tick} takes
 * it and {@link settledPositionCap} reads it, so a cap can never be above a stamp taken after it by one spelling disagreeing.
 */
const nextInstant = (clock: PositionClock): number => Math.max(Date.now(), clock.last + 1);

/**
 * Hand out the next instant of the space's clock. Never equal to an earlier one, so two stamps of one space always order.
 * Synchronous: a hold is registered in the same tick that takes the stamp.
 */
function tick(clock: PositionClock): string {
  clock.last = nextInstant(clock);
  return new Date(clock.last).toISOString();
}

/**
 * Take a stamp from the space's clock and run `write` holding it — registered in the same tick, so no reader can be handed a
 * position above `stamp` between the two — and release when the write ENDS, whichever way, inside the write bound
 * ({@link heldWhile}). ONE stamp per call: a slice of rows shares it, so positions never run ahead of the wall clock by more
 * than a few milliseconds however many rows are written.
 *
 * `write` should be the position-writing operation and nothing else: everything awaited inside it holds every page and prune of
 * the space below the stamp.
 */
async function withPositionHeld<T>(spaceId: string, write: (stamp: string) => Promise<T>, holder: string): Promise<T> {
  positionHolds.requireHolder(holder);
  const clock = await clockForWrite(spaceId);
  const stamp = tick(clock);
  const hold = positionHolds.enter(spaceId, stamp, holder);
  return heldWhile(positionHolds, spaceId, hold, () => write(stamp));
}

/**
 * The position strictly below which a page or a prune of the space may read: the lowest stamp whose write has not settled, or —
 * with none open — the next instant the clock would hand out, COMPUTED and never stored (a read must not move the clock, and any
 * stamp taken later is at or above this). THE one way a reader of `positionAt` is capped: a reader that bounds itself by a clock
 * read of its own reads straight through an open hold (`a-file-tombstone-position-is-read-through-one-cap` holds every reader to it).
 * Async because the clock is seeded from the store once, so a restart cannot cap below a position already handed out.
 */
export async function settledPositionCap(spaceId: string): Promise<string> {
  const clock = await clockOf(spaceId);
  // Read after the await, in one tick with the hold registry: a hold entered while the seed was out is below this answer or equal to it.
  return positionHolds.lowest(spaceId) ?? new Date(nextInstant(clock)).toISOString();
}

/** The cap as an `extra` for the iso keyset: the rows strictly below it. */
const belowCap = (cap: string) => ({ positionAt: { $lt: cap } });
/** The prune's bound: acknowledged (at or below `upTo`) and settled (below the cap). */
const prunable = (upTo: string, cap: string) => ({ ...PUBLISHED, positionAt: { $lte: upTo, $lt: cap } });

// ── The questions asked of the collection ──────────────────────────────────────────────────────────────────────────

/** What a builder of {@link FILE_TOMBSTONE_QUERIES} is asked with; each reads the parts it needs. */
export interface FileTombstoneQuerySample {
  spaceId: string; now: Date; before: string; paths: readonly string[]; after: IsoPosition; cap: string; upTo: string; limit?: number | undefined;
}
/**
 * A question as the store is asked it. A keyset page is two reads, and `tie` is the first of them (the rest of a run of equal
 * positions, after a cursor's id) where `filter` is the second (strictly later positions): {@link ask} runs them as one.
 */
export interface FileTombstoneQuery { filter: Record<string, unknown>; tie?: Record<string, unknown> | null; sort?: Record<string, 1>; limit?: number | undefined }

/** A page in `(positionAt, _id)` order over the two halves of a position keyset, `base` narrowing both. */
const positionPage = (
  base: Record<string, unknown>, { tie, range }: { tie: Record<string, unknown> | null; range: Record<string, unknown> }, limit: number | undefined,
): FileTombstoneQuery =>
  ({ filter: { ...base, ...range }, tie: tie && { ...base, ...tie }, sort: { ...isoKeysetSort('positionAt') }, limit });

/**
 * THE questions the module asks of its collection that an index must answer, each a function of one sample bag. The module runs
 * every one of its own reads through its entry (the settle, the by-path reader, the pages, the prune), and
 * `file-tombstones-are-indexed-db` explains these same objects, so the plan it checks is the plan the module runs and not a copy
 * of it. The two page questions carry both halves of a keyset read (`filter` is the range, `tie` the same shape one instant
 * narrower) and {@link ask} runs them as one: the page read and the prune are THESE questions, so an index gate that explains them
 * explains what is run.
 */
export const FILE_TOMBSTONE_QUERIES = {
  /** The settle's batch: pending rows written (or last looked at) before `before`, oldest first. */
  settle: ({ before, limit }: Pick<FileTombstoneQuerySample, 'before' | 'limit'>): FileTombstoneQuery =>
    ({ filter: { pending: true, settleAt: { $lte: before } }, sort: { settleAt: 1 }, limit }),
  /** The same for a pending row written before `settleAt` existed, which the first never meets. Served by the null end of the same index. */
  settleLegacy: ({ before, limit }: Pick<FileTombstoneQuerySample, 'before' | 'limit'>): FileTombstoneQuery =>
    ({ filter: { pending: true, settleAt: { $exists: false }, deletedAt: { $lte: before } }, sort: { deletedAt: 1 }, limit }),
  /** The pending rows among some paths: what a prune must not leave a path without, and what an act's leftovers are. */
  pendingByPath: ({ paths }: Pick<FileTombstoneQuerySample, 'paths'>): FileTombstoneQuery =>
    ({ filter: { path: { $in: [...paths] }, pending: true } }),
  /** A page of published tombstones after `after`, below the cap, in `(positionAt, _id)` order. */
  cappedPage: ({ spaceId, after, cap, limit }: Pick<FileTombstoneQuerySample, 'spaceId' | 'after' | 'cap' | 'limit'>): FileTombstoneQuery =>
    positionPage({ spaceId, ...PUBLISHED }, isoKeysetFilters('positionAt', after, belowCap(cap)), limit),
  /** A page of the tombstones the prune may take: published, acknowledged, settled. */
  prunePage: ({ after, cap, upTo, limit }: Pick<FileTombstoneQuerySample, 'after' | 'cap' | 'upTo' | 'limit'>): FileTombstoneQuery =>
    positionPage({}, isoKeysetFilters('positionAt', after, prunable(upTo, cap)), limit),
} as const;

/** Run one of {@link FILE_TOMBSTONE_QUERIES}' questions — a keyset page as its tie half, then its range half, up to the limit. */
async function ask<T>(spaceId: string, q: FileTombstoneQuery, projection: Record<string, 1>): Promise<T[]> {
  const read = async (filter: Record<string, unknown>, limit: number | undefined): Promise<T[]> => {
    let cursor = tombstonesOf(spaceId).find(asFilter<StoredFileTombstone>(filter as never), { projection });
    if (q.sort) cursor = cursor.sort(q.sort);
    if (limit !== undefined) cursor = cursor.limit(limit);
    return await cursor.toArray() as unknown as T[];
  };
  return tieThenRange(read, q.tie ?? null, q.filter, q.limit);
}

/**
 * The tombstones of some paths — one `$in` per chunk, by the `path` index — narrowed by `filterFor`, with the fields the
 * caller needs. THE chunked by-path read: the published ones an arriving file is compared with ({@link heldFileTombstones}),
 * the rows a publish decides over, the pending ones a prune must not leave a path without.
 */
async function tombstonesAtPaths<T>(
  spaceId: string, paths: readonly string[], filterFor: (chunk: string[]) => Record<string, unknown>, projection: Record<string, 1>,
): Promise<T[]> {
  const out: T[] = [];
  for (const chunk of inChunks([...new Set(paths)], READ_CHUNK)) {
    out.push(...await tombstonesOf(spaceId).find(asFilter<StoredFileTombstone>(filterFor(chunk) as never), { projection }).toArray() as unknown as T[]);
  }
  return out;
}

// ── A wipe is not undone by a publish in flight (Q-406) ────────────────────────────────────────────────────────────

/**
 * How many times each space's file tombstones have been wiped in this process. A pending handle carries the generation it was
 * written under, and a publish or a settle that read its rows under another one drops instead of upserting: its upsert exists to
 * write again a row a stale settle dropped, and after a wipe it would re-create a tombstone in a space that was just emptied —
 * published, served, and applied by every peer to a path of the NEW space.
 */
const wipeGenerations = new Map<string, number>();
const wipeGenerationOf = (spaceId: string): number => wipeGenerations.get(spaceId) ?? 0;

/**
 * Forget every file tombstone of a space (`wipeSpace` with `files`), and mark the wipe: under the space's publish lock, so a
 * publish that is running finishes first and one that starts after sees the new generation. The wipe's delete and the generation
 * are one step on purpose — the delete alone is what a publish in flight undoes.
 */
export async function forgetFileTombstonesOf(spaceId: string): Promise<void> {
  await publishLock.run(spaceId, async () => {
    wipeGenerations.set(spaceId, wipeGenerationOf(spaceId) + 1);
    await tombstonesOf(spaceId).deleteMany({});
  });
}

/** One publisher per space at a time, from its read of a path's rows to its last write ({@link publishOnePerPath}). */
const publishLock = keyedLock();

/** A pending tombstone about to be published: while pending, `deletedAt` is when it was written. */
type ToPublish = Pick<StoredFileTombstone, '_id' | 'path' | 'deletedAt' | 'move' | 'issuer' | 'rowSeq' | 'contentHash' | 'writtenAt'>;

/**
 * THE one way a tombstone is published — confirmed by its act, settled from the disk by a failed step, a retried
 * move or the TTL sweep — and the rule it carries: **per path, an act publishes exactly one tombstone, and publishing
 * it removes every other pending tombstone for that path** (bundle-30 I17, verify-drive-5 F1).
 *
 * Those others are the same intent. An act a store failure stopped leaves its pending tombstone behind — its write
 * landed and its clean-up could not reach the store — and its retry writes one of its own. Both used to be published:
 * a retried move's at once (its settle took every tombstone carrying the move's marker), a retried delete's ten
 * minutes later, when the TTL settle found the path's bytes gone — gone because the RETRY removed them. A receiver
 * deletes its copy for every tombstone it is sent, with no time comparison, so the late one deleted a re-upload a peer
 * had made of that path in between.
 *
 * So, per path:
 * - **One already published** (an act confirmed it meanwhile) is left exactly as it is: re-stamped, it would be pushed
 *   again.
 * - **One written no later than a tombstone THIS INSTANCE published for its path is not published**, and is dropped: that
 *   publication was made after this act began, so it already told every peer — this one is the leftover of an
 *   attempt the publication finished, or a failed write the store applied late. Only an own publication counts, by this
 *   instance's own clock (`writtenAt`, never `deletedAt`, which a settle's retry once moved), and when both name a version of
 *   the file the publication's must not be below the candidate's: a later delete of a newer version is a different delete
 *   (Q-352). A tombstone a peer relayed never covers one of ours.
 * - Otherwise the latest-written is published — upserted, so one the stale settle dropped while its act was still
 *   running is written again — and every other pending tombstone written no later than it is removed. One written after it
 *   is another act's, and stays.
 *
 * It runs under a per-space lock from its read to its last write, in slices of whole paths, each slice's position-writing
 * operations inside one position hold ({@link withPositionHeld}). `generation` is the wipe generation the rows were written or
 * read under: a publish whose space was wiped since drops instead of re-creating a tombstone ({@link forgetFileTombstonesOf}).
 *
 * Its failures are thrown; every caller decides what a store failure means for its act.
 */
async function publishOnePerPath(spaceId: string, docs: readonly ToPublish[], generation: number): Promise<{ published: number; dropped: number }> {
  if (docs.length === 0) return { published: 0, dropped: 0 };
  // One publisher per space, from its read of the rows to its last write: two that each read before the other wrote published
  // the path twice, the older delete stamped after the newer (Q-352). The wipe takes the same lock, so a publish that begins
  // after a wipe sees the new generation and one in flight finishes before the delete (Q-406).
  return publishLock.run(spaceId, async () => {
    if (wipeGenerationOf(spaceId) !== generation) return { published: 0, dropped: docs.length };
    const byPath = new Map<string, ToPublish[]>();
    for (const d of docs) byPath.set(d.path, [...(byPath.get(d.path) ?? []), d]);
    let published = 0;
    let dropped = 0;
    // A slice is whole paths (a path's candidates are never split), and holds ONE stamp: its rows share the position, so the
    // run of equal positions a page can end inside is no longer than a page.
    for (const paths of inChunks([...byPath.keys()], FILE_TOMBSTONE_PAGE)) {
      const done = await publishSlice(spaceId, paths, byPath);
      published += done.published;
      dropped += done.dropped;
    }
    return { published, dropped };
  });
}

/** What {@link publishSlice} reads of the rows already stored for its paths. */
const STORED_FOR_PUBLISH = { _id: 1, path: 1, deletedAt: 1, positionAt: 1, pending: 1, rowSeq: 1, writtenAt: 1, origin: 1, storedVia: 1, move: 1 } as const;
/** When a pending row was put: its `writtenAt`, or — for one written before it existed — its `deletedAt`. */
const writtenOf = (t: { writtenAt?: string | undefined; deletedAt: string }): string => t.writtenAt ?? t.deletedAt;

/**
 * Whether the published tombstone `p` COVERS the pending one `c`: this instance published it itself, after `c` was written (both
 * by this instance's own clock), and — when both name a version of the file — at a version `c` does not exceed. Only an own
 * publication can cover: a relayed tombstone says a PEER deleted the path, which tells nobody that this instance's own delete
 * happened, and its position is its receive time.
 */
function covers(p: StoredFileTombstone, c: ToPublish): boolean {
  if (p.pending || p.origin !== 'own' || p.storedVia !== undefined) return false;
  const at = fileTombstonePosition(p);
  if (at === undefined || at <= writtenOf(c)) return false;
  const versioned = typeof p.rowSeq === 'number' && p.rowSeq > 0 && typeof c.rowSeq === 'number' && c.rowSeq > 0;
  return !versioned || (p.rowSeq as number) >= (c.rowSeq as number);
}

/**
 * One slice of {@link publishOnePerPath}, under its lock: read the rows stored for `paths`, decide per path, publish the winners
 * at one held stamp, and only then remove what they replace. Only the position-writing operations run inside the hold; the read
 * before it and the deletes after it hold nothing.
 *
 * Per path: a pending tombstone a published OWN one covers is dropped ({@link covers}); of the rest the latest written
 * ({@link writtenOf}) is published and every pending row written no later than it (and every one written before `writtenAt`
 * existed) is removed — never one written after it, which is another act's. A move's marker on a row that goes is handed to the
 * row that covers it, when that row has none: it is the only thing that tells a retried move it is owed.
 */
async function publishSlice(
  spaceId: string, paths: readonly string[], byPath: ReadonlyMap<string, readonly ToPublish[]>,
): Promise<{ published: number; dropped: number }> {
  const stored = await tombstonesAtPaths<StoredFileTombstone>(spaceId, paths, chunk => ({ path: { $in: chunk } }), STORED_FOR_PUBLISH);
  const alreadyPublished = new Set(stored.filter(t => !t.pending).map(t => t._id));
  const newestFirst = (a: ToPublish, b: ToPublish): number =>
    Number(b.writtenAt !== undefined) - Number(a.writtenAt !== undefined) || writtenOf(b).localeCompare(writtenOf(a));
  const winners: ToPublish[] = [];
  const afterOps: object[] = [];
  const superseded: string[] = [];
  let dropped = 0;
  for (const path of paths) {
    const rows = stored.filter(t => t.path === path);
    const candidates = (byPath.get(path) ?? []).filter(d => !alreadyPublished.has(d._id)).sort(newestFirst);
    const covering = new Map(candidates.map(c => [c._id, rows.find(p => covers(p, c))] as const));
    const live = candidates.filter(c => covering.get(c._id) === undefined);
    for (const c of candidates) {
      const cover = covering.get(c._id);
      if (cover === undefined) continue;
      superseded.push(c._id);
      if (c.move && !cover.move) {
        cover.move = c.move;
        afterOps.push({ updateOne: { filter: asFilter<StoredFileTombstone>({ _id: cover._id, move: { $exists: false } }), update: asUpdate<StoredFileTombstone>({ $set: { move: c.move } }) } });
      }
    }
    const winner = live[0];
    if (!winner) { dropped += candidates.length; continue; }
    // What goes with the winner, and the marker it may carry on: the other live candidates (their rows may be gone, so the doc
    // is read) and the pending rows the delete below takes.
    const goes = winner.writtenAt !== undefined
      ? (t: StoredFileTombstone) => t.writtenAt === undefined || t.writtenAt <= (winner.writtenAt as string)
      : (t: StoredFileTombstone) => t.writtenAt === undefined && t.deletedAt <= winner.deletedAt;
    const removed = [...live.slice(1), ...rows.filter(t => t.pending && t._id !== winner._id && goes(t))];
    const move = winner.move ?? removed.find(r => r.move)?.move;
    winners.push(move && !winner.move ? { ...winner, move } : winner);
    afterOps.push({ deleteMany: { filter: asFilter<StoredFileTombstone>({
      path, pending: true, _id: { $ne: winner._id },
      ...(winner.writtenAt !== undefined
        ? { $or: [{ writtenAt: { $lte: winner.writtenAt } }, { writtenAt: { $exists: false } }] }
        : { writtenAt: { $exists: false }, deletedAt: { $lte: winner.deletedAt } }),
    }) } });
    dropped += candidates.length - 1;
  }
  if (winners.length > 0) {
    await withPositionHeld(spaceId, (stamp) => {
      const ops = winners.map(w => ({ updateOne: {
        filter: asFilter<StoredFileTombstone>({ _id: w._id }),
        // What the act knew of the version it erased travels with it, so an upsert (a tombstone the stale settle dropped
        // while its act was still running) writes it again rather than publishing a bare one.
        update: asUpdate<StoredFileTombstone>({
          $set: {
            deletedAt: stamp, positionAt: stamp, origin: 'own', spaceId, path: w.path,
            ...(w.issuer !== undefined ? { issuer: w.issuer } : {}),
            ...(w.rowSeq !== undefined ? { rowSeq: w.rowSeq } : {}),
            ...(w.contentHash !== undefined ? { contentHash: w.contentHash } : {}),
            ...(w.writtenAt !== undefined ? { writtenAt: w.writtenAt } : {}),
            ...(w.move ? { move: w.move } : {}),
          },
          $unset: { pending: '' as const, settleAt: '' as const },
        }),
        upsert: true,
      } }));
      return writeInOneCommands(ops, (slice, { ordered }) => tombstonesOf(spaceId).bulkWrite(asBulk<StoredFileTombstone>(slice), { ordered }),
        { ordered: false, commandKindOf: bulkCommandOf });
    }, 'file.tombstone.publish');
  }
  // An update and a delete per path: sliced by type, so each slice is one command (`bulkCommandOf`).
  await writeInOneCommands(afterOps, (slice, { ordered }) => tombstonesOf(spaceId).bulkWrite(asBulk<StoredFileTombstone>(slice), { ordered }),
    { ordered: false, commandKindOf: bulkCommandOf });
  // The covered ones, by id: a delete, one command per chunk of ids.
  for (const ids of inChunks(superseded, READ_CHUNK)) {
    await tombstonesOf(spaceId).deleteMany(asFilter<StoredFileTombstone>({ _id: { $in: ids }, pending: true }));
  }
  return { published: winners.length, dropped };
}

/** The file rows of `ids` (a row's id is its path), with what a tombstone records of the version it erases. */
async function readFileRows(spaceId: string, ids: readonly string[]): Promise<Map<string, Pick<FileMetaDoc, 'seq' | 'sha256'>>> {
  try {
    return await readStoredById<Pick<FileMetaDoc, 'seq' | 'sha256'>>(spaceCollection(spaceId, 'files'), ids, { seq: 1, sha256: 1 });
  } catch (err) {
    // Never the act's failure. The stamps are what a tombstone KNOWS of the version it erases, and a bare tombstone shadows
    // less (the stated limit of one held from before this release) and deletes exactly as it did. A store that is down fails
    // the write that follows, which is where the act answers it: failing here instead put a READ before the write and kept
    // the one failure the doors are held to (a failed bulk write, `a-store-failure-answers-alike-on-every-door-db`) from
    // ever being met. The store's own failure is not said here either: the driver's text is logged once, by the door that
    // answers it, and the write that follows meets the same fault.
    if (classifyReadFailure(err).status < 500) {
      log.warn(`file tombstones for ${peerText(spaceId)} (${ids.length}): the rows they erase could not be read, so they carry no version: ${peerText(err)}`);
    }
    return new Map();
  }
}

/** The marker a move writes on its tombstones, as a filter. */
const moveMarker = (from: string, to: string) => ({ 'move.from': toDocId(from), 'move.to': toDocId(to) });

/** Drops still running, so a test (and nothing else) can wait for them: `whenPendingFileTombstoneDropsSettle`. */
const drops = new DetachedWork('dropPendingFileTombstones');

/** The tombstones an act wrote pending, to confirm once its bytes are gone or to drop if it fails. */
export interface PendingFileTombstones {
  readonly spaceId: string;
  readonly docs: readonly StoredFileTombstone[];
  /** The space's wipe generation when they were written: a publish or settle that finds another one drops them
   *  ({@link forgetFileTombstonesOf}), because the wipe already removed what they stand for. */
  readonly generation?: number;
}

/** The generation a handle is judged by: the one it was written under, or — for a handle built without one — the space's now. */
const generationOfHandle = (pending: PendingFileTombstones): number => pending.generation ?? wipeGenerationOf(pending.spaceId);

/**
 * Write a PENDING tombstone for each of `paths` (normalised, deduped), before the act's irreversible step — and, for a
 * move, the marker its retry looks for. A STORE failure is thrown, after a drop of whatever may have landed: the door
 * answers it as every door answers one, and since nothing irreversible has happened the retry repeats the act. Any
 * other failure is logged and the act goes on with no tombstones.
 */
export async function writePendingFileTombstones(
  spaceId: string, paths: string[], move?: { from: string; to: string },
): Promise<PendingFileTombstones> {
  const unique = [...new Set(paths.map(toDocId))].filter(Boolean);
  const generation = wipeGenerationOf(spaceId);
  // One stamp of the space's clock for the act: `writtenAt` is what the one-per-path rule orders by, `settleAt` what the settle
  // does, and `deletedAt` — while pending — is the same instant. Not held: a pending row has no position.
  const now = tick(await clockForWrite(spaceId));
  const marker = move ? { move: { from: toDocId(move.from), to: toDocId(move.to) } } : {};
  // What the act knows of what it is about to erase, read ONCE for every path (one `$in` per chunk): who is acting, and the
  // version and content hash of each file ROW. The hash is the row's, never the bytes' — the bytes may be the next thing
  // to go, and a row hash costs no read of them. A path with no row (derived sidecar, an orphan) is stamped with the issuer
  // alone: a version and a hash it does not have are not guessed.
  const rows = await readFileRows(spaceId, unique);
  const issuer = authorRef().instanceId;
  const pending: PendingFileTombstones = { spaceId, generation, docs: unique.map((p): StoredFileTombstone => {
    const row = rows.get(p);
    return {
      _id: uuidv4(), spaceId, path: p, deletedAt: now, writtenAt: now, settleAt: now, pending: true as const, ...marker,
      ...(issuer ? { issuer } : {}),
      ...(typeof row?.seq === 'number' ? { rowSeq: row.seq } : {}),
      ...(typeof row?.sha256 === 'string' && row.sha256 !== '' ? { contentHash: row.sha256 } : {}),
    };
  }) };
  if (pending.docs.length === 0) return pending;
  try {
    const stored = tombstonesOf(spaceId);
    await writeInOneCommands(pending.docs.map(d => asDoc<StoredFileTombstone>(d)), (slice, { ordered }) => stored.insertMany(slice, { ordered }), { ordered: true });
    return pending;
  } catch (err) {
    // A write reported failed is not known NOT to have landed: a paused store applies it when it comes back.
    dropPendingFileTombstones(pending);
    throwIfStoreSide(err);
    log.warn(`writePendingFileTombstones error for space ${peerText(spaceId)} (${unique.length} paths): ${peerText(err)}`);
    return { spaceId, docs: [], generation };
  }
}

/**
 * Publish an act's tombstones: its bytes are gone or moved. One per path ({@link publishOnePerPath}): every other
 * pending tombstone for the path — an earlier attempt's — goes with it. A store failure is thrown (the act answers
 * `503` and its retry completes it); any other is logged, and the settle confirms what it left pending.
 */
export async function confirmFileTombstones(pending: PendingFileTombstones): Promise<void> {
  if (pending.docs.length === 0) return;
  await unlessTheStoreFailed(`confirmFileTombstones for space ${peerText(pending.spaceId)} (${pending.docs.length})`,
    () => publishOnePerPath(pending.spaceId, pending.docs, generationOfHandle(pending)));
}

/** The part of an act's pending tombstones that names one of `paths` — those one step of the act removes. */
export function pendingAmong(pending: PendingFileTombstones, paths: readonly string[]): PendingFileTombstones {
  const wanted = new Set(paths.map(toDocId));
  return { spaceId: pending.spaceId, generation: generationOfHandle(pending), docs: pending.docs.filter(d => wanted.has(d.path)) };
}

/**
 * Run an act's irreversible step under its pending tombstones: published once it returns, settled from the disk if it
 * throws (and the throw passed on). Every act that removes a path orders it through here — the file delete, the
 * directory delete and the move — so none can publish a tombstone for bytes that are still here, or drop one for
 * bytes that are gone.
 *
 * - `pending` is the act's WHOLE set, and `stepRemoves` the part of it whose bytes THIS step removes (by default all
 *   of it). Only those are published when it returns: a path whose bytes go at a later step — a move's sidecars, a
 *   directory delete's — is published by that step's own settle, once ITS bytes are gone (preship-4 P4-3).
 * - **A step that throws may have done part of its work**: a recursive tree removal stops after some of the unlinks.
 *   So the whole set is settled per path from the disk at once — no bytes, published; bytes, dropped — rather than
 *   dropped wholesale, which lost the tombstones of the files it had removed, since the retry lists only what remains
 *   (preship-4 P4-2). For one file's unlink or rename that is the same answer as dropping them. Its own failure is
 *   logged, never thrown over the step's: the TTL sweep's settle finishes what it leaves pending.
 */
export async function actUnderPendingTombstones(
  pending: PendingFileTombstones, step: () => Promise<unknown>, stepRemoves: PendingFileTombstones = pending,
): Promise<void> {
  try {
    await step();
  } catch (err) {
    await settlePendingFileTombstones(pending).catch(e =>
      log.warn(`File tombstones for space ${peerText(pending.spaceId)} (${pending.docs.length}) not settled after a failed act: `
        + `${peerText(e)} — they are served to nobody, and the TTL sweep settles them`));
    throw err;
  }
  await confirmFileTombstones(stepRemoves);
}

/**
 * Remove the pending tombstones of an act that did not happen. One attempt, behind the caller: its failure is logged
 * and nothing more, because a pending tombstone is served to nobody, and the settle drops it once stale.
 */
export function dropPendingFileTombstones(pending: PendingFileTombstones): void {
  if (pending.docs.length === 0) return;
  const ids = pending.docs.map(d => d._id);
  drops.start(async () => {
    try {
      await tombstonesOf(pending.spaceId).deleteMany(asFilter<StoredFileTombstone>({ _id: { $in: ids }, pending: true }));
    } catch (err) {
      log.warn(`dropPendingFileTombstones for space ${peerText(pending.spaceId)} (${ids.length}): ${peerText(err)} `
        + '— they are served to nobody, and the TTL sweep settles them');
    }
  });
}

/** Resolves when every drop started so far has finished. For tests: the act answers before its drop does. */
export async function whenPendingFileTombstoneDropsSettle(): Promise<void> {
  await drops.settled();
}

/** What settling some pending tombstones from the disk did. */
interface Settled {
  /** Dropped because the path still has its bytes: the act did not remove it. */
  dropped: number;
  /** Published: the path has no bytes. */
  confirmed: number;
  /** Dropped because a tombstone for the path was already published after it was written (one per path). */
  superseded: number;
  /** Ids of those whose path could not be looked at: left pending. */
  unresolved: string[];
}

/** The fields a settle reads of a pending tombstone: what {@link publishOnePerPath} needs to publish it. */
const TO_PUBLISH = { _id: 1, path: 1, deletedAt: 1, move: 1, issuer: 1, rowSeq: 1, contentHash: 1, writtenAt: 1 } as const;

/**
 * THE settle rule, one copy for every caller: the disk decides each pending tombstone. Its path still has bytes, so
 * the act did not remove it: dropped. It has none, so the act did: published ({@link publishOnePerPath} — one per
 * path, stamped now, never a caller's clock). A path that cannot be looked at is neither — it stays pending, served
 * to nobody, and is returned as `unresolved` for the caller to decide when to ask again. Only tombstones still
 * pending are dropped, and one an act published meanwhile is left as it is. A store failure is thrown.
 */
async function settleFromTheDisk(spaceId: string, rows: readonly ToPublish[], generation: number): Promise<Settled> {
  const here: string[] = [];
  const gone: ToPublish[] = [];
  const unresolved: string[] = [];
  for (const t of rows) {
    try {
      if (await bytesPresentAt(spaceId, t.path)) here.push(t._id); else gone.push(t);
    } catch (err) {
      unresolved.push(t._id);
      log.warn(`File tombstone for ${peerText(spaceId)}/${peerText(t.path)} left pending: its path cannot be looked at: ${peerText(err)}`);
    }
  }
  if (here.length > 0) await tombstonesOf(spaceId).deleteMany(asFilter<StoredFileTombstone>({ _id: { $in: here }, pending: true }));
  const { published, dropped } = await publishOnePerPath(spaceId, gone, generation);
  return { dropped: here.length, confirmed: published, superseded: dropped, unresolved };
}

/**
 * Settle an act's pending tombstones from the disk now — for the step of an act that removes its bytes and survives
 * its own failure (a directory delete's sidecars), and for any step that failed. Fails as {@link confirmFileTombstones}
 * fails: a store failure is thrown.
 */
export async function settlePendingFileTombstones(pending: PendingFileTombstones): Promise<void> {
  if (pending.docs.length === 0) return;
  await unlessTheStoreFailed(`settlePendingFileTombstones for space ${peerText(pending.spaceId)} (${pending.docs.length})`,
    () => settleFromTheDisk(pending.spaceId, pending.docs, generationOfHandle(pending)));
}

/**
 * Settle the pending tombstones that outlived their act, from the disk ({@link settleFromTheDisk}). Run by every TTL
 * sweep cycle, per space, at most {@link FILE_TOMBSTONE_SETTLE_BATCH} at a time.
 *
 * **Oldest first, and one it cannot look at goes to the back** (bundle-30 I16, preship-4 P4-1): its staleness clock
 * restarts at this cycle (`settleAt` set to `now` — never `deletedAt` or `writtenAt`, which the one-per-path rule reads, and
 * which a bump once lifted above the tombstone that covers the path), so it is asked again only once it is stale again, behind
 * every tombstone that went stale before it. Unordered and left where it was, a batch's worth of paths it could not look at
 * came back first every cycle and starved the rest of the space for ever. A row written before `settleAt` existed is read by
 * its `deletedAt` until it settles.
 *
 * **It goes on while the batches come back full and clean**: a backlog (a space whose settle was behind) is settled in one cycle
 * and not 500 rows per sweep. A batch that held a path it could not look at, or that settled nothing, ends it — the rest waits
 * one cycle, as above — so the loop ends, and every pass it makes removes what it read from the pending set.
 *
 * **A leftover whose path already has a published tombstone of this instance's own, written after it, is dropped, not
 * published** (bundle-30 I17, verify-drive-5 F1): the act's retry published that one, or the failed write landed after it did.
 * Published, it was a second tombstone for one removal, stamped minutes later — see {@link publishOnePerPath}.
 */
export async function settleStalePendingFileTombstones(
  spaceId: string, now: Date = new Date(),
): Promise<{ dropped: number; confirmed: number; superseded: number }> {
  // Before the first read: a wipe that lands while a batch is out must find a settle it can stop (`forgetFileTombstonesOf`).
  const generation = wipeGenerationOf(spaceId);
  const before = new Date(now.getTime() - STALE_AFTER_MS).toISOString();
  const total = { dropped: 0, confirmed: 0, superseded: 0 };
  for (;;) {
    const sample = { before, limit: FILE_TOMBSTONE_SETTLE_BATCH };
    const stale = await ask<ToPublish>(spaceId, FILE_TOMBSTONE_QUERIES.settle(sample), TO_PUBLISH);
    if (stale.length < FILE_TOMBSTONE_SETTLE_BATCH) {
      stale.push(...await ask<ToPublish>(spaceId, FILE_TOMBSTONE_QUERIES.settleLegacy({ before, limit: FILE_TOMBSTONE_SETTLE_BATCH - stale.length }), TO_PUBLISH));
    }
    const { dropped, confirmed, superseded, unresolved } = await settleFromTheDisk(spaceId, stale, generation);
    if (unresolved.length > 0) {
      await tombstonesOf(spaceId).updateMany(asFilter<StoredFileTombstone>({ _id: { $in: unresolved }, pending: true }),
        asUpdate<StoredFileTombstone>({ $set: { settleAt: now.toISOString() } }));
    }
    total.dropped += dropped; total.confirmed += confirmed; total.superseded += superseded;
    if (stale.length < FILE_TOMBSTONE_SETTLE_BATCH || unresolved.length > 0 || dropped + confirmed + superseded === 0) break;
  }
  if (total.dropped + total.confirmed + total.superseded > 0) {
    log.info(`File tombstones of ${peerText(spaceId)} settled from the disk: ${total.confirmed} published (the path is gone), `
      + `${total.dropped} dropped (the path still has its file), ${total.superseded} dropped (the path already has its published tombstone)`);
  }
  await clearFinishedMoveMarkers(spaceId, before);
  return total;
}

/**
 * Forget the marker of a move that is finished — its bytes are at `to` and none at `from` — on any row old enough to be past
 * its act. The move that finished clears its own (`forgetFinishedMove`); this is for the one whose clearing failed, or that a
 * restart came between, so that no row is kept for ever on the strength of a marker nobody will look for. Best effort, and a
 * path it cannot look at is left alone: a marker kept is only ever a delay.
 */
async function clearFinishedMoveMarkers(spaceId: string, before: string): Promise<void> {
  try {
    const marked = await tombstonesOf(spaceId)
      .find(asFilter<StoredFileTombstone>({ 'move.from': { $exists: true }, deletedAt: { $lte: before } }), { projection: { move: 1 } })
      .limit(FILE_TOMBSTONE_SETTLE_BATCH).toArray();
    const seen = new Set<string>();
    for (const t of marked) {
      if (!t.move) continue;
      const key = `${t.move.from}\u0000${t.move.to}`;
      if (seen.has(key)) continue;
      seen.add(key);
      try {
        if (await bytesPresentAt(spaceId, t.move.to) && !await bytesPresentAt(spaceId, t.move.from)) {
          await forgetFinishedMove(spaceId, t.move.from, t.move.to);
        }
      } catch { /* cannot look: the marker stays, and the next sweep asks again */ }
    }
  } catch (err) {
    // The marker read is the sweep's own housekeeping: its store failure is the settle's to say, and the next sweep repeats it.
    throwIfStoreSide(err);
    log.warn(`File tombstone move markers of ${peerText(spaceId)} not cleared: ${peerText(err)}`);
  }
}

// ── The move's marker ─────────────────────────────────────────────────────────────────────────────────────────────

/** Whether a move from `from` to `to` was begun here — its tombstones written — and not yet finished. */
export async function moveWasBegun(spaceId: string, from: string, to: string): Promise<boolean> {
  return (await tombstonesOf(spaceId).findOne(asFilter<StoredFileTombstone>(moveMarker(from, to)), { projection: { _id: 1 } })) !== null;
}

/**
 * Settle every tombstone a move from `from` to `to` left pending, from the disk, by its marker — once the move has
 * done all it will to its bytes (the file's, then its sidecars'). A path whose bytes went is published, one whose
 * bytes stayed (a sidecar that could not move) is dropped. By the marker, because a retry that completes the move holds
 * no handle on what its first attempt wrote — and one per path ({@link publishOnePerPath}), because an earlier
 * attempt's tombstone carries the same marker as the retry's, and both used to be published (verify-drive-5 F1).
 * Fails as {@link confirmFileTombstones} fails.
 */
export async function settleBegunMove(spaceId: string, from: string, to: string): Promise<void> {
  await unlessTheStoreFailed(`settleBegunMove for space ${peerText(spaceId)}, ${peerText(from)} → ${peerText(to)}`, async () => {
    // The generation BEFORE the read: a wipe that lands between the read and the publish must find a settle it can stop.
    const generation = wipeGenerationOf(spaceId);
    const left = await tombstonesOf(spaceId)
      .find(asFilter<StoredFileTombstone>({ ...moveMarker(from, to), pending: true }), { projection: TO_PUBLISH }).toArray();
    await settleFromTheDisk(spaceId, left, generation);
  });
}

/**
 * Forget a finished move's marker, so a later orphan at `from` beside a file at `to` is not taken for it. Best effort:
 * a marker left behind matters only to that history, and failing a finished move over it would answer a failure for
 * an act that happened.
 */
export async function forgetFinishedMove(spaceId: string, from: string, to: string): Promise<void> {
  await tombstonesOf(spaceId).updateMany(asFilter<StoredFileTombstone>(moveMarker(from, to)), asUpdate<StoredFileTombstone>({ $unset: { move: '' } }))
    .catch(err => log.warn(`forgetFinishedMove for space ${peerText(spaceId)}, ${peerText(from)} → ${peerText(to)}: ${peerText(err)}`));
}

// ── The readers: published tombstones only ────────────────────────────────────────────────────────────────────────

/** A published tombstone as the readers hand it on: its wire shape, and the position this instance holds it at. */
export type PositionedFileTombstone = FileTombstoneDoc & { positionAt: string };

/** The wire shape of a tombstone: exactly the fields of {@link WIRE}, never the position or any other local field. */
export function fileTombstoneOnTheWire(t: FileTombstoneDoc): FileTombstoneDoc {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(WIRE)) if ((t as unknown as Record<string, unknown>)[k] !== undefined) out[k] = (t as unknown as Record<string, unknown>)[k];
  return out as unknown as FileTombstoneDoc;
}

/** The legacy read's ceiling: one answer, cut here, as the route has always answered a request with no cursor. */
export const LEGACY_FILE_TOMBSTONE_LIMIT = 5000;
/** A cursor-mode page, and a push request's size. */
export const FILE_TOMBSTONE_PAGE = 500;

/**
 * The published tombstones of a space, in position order (`positionAt`, then `_id`), each with the position it was read at —
 * what `GET /api/sync/file-tombstones` serves and what a sync cycle pushes, a page at a time.
 *
 * - `after` is where to resume: strictly after that position, and — with an id — after that tombstone within a run of equal
 *   positions, so a run of any length pages and no row is skipped at a page boundary (the twin of the record routes' keyset,
 *   `util/seq-keyset.ts`). The start of time reads everything.
 * - `since` is the older, instant-only question (`positionAt > since`), kept for a client that still sends it.
 * - `limit` bounds the answer; the rows of the answer carry their position, which a page's own cursor is built from.
 *
 * Reads `positionAt`, which {@link positionLegacyFileTombstones} gives every row stored before positions existed.
 */
export async function publishedFileTombstones(
  spaceId: string, { after, since, limit }: { after?: IsoPosition; since?: string; limit?: number } = {},
): Promise<PositionedFileTombstone[]> {
  // Below the cap, whichever way the read starts (a cursor, or the older `since`): an open position hold stops the page
  // short of its stamp, so nothing it hands out can be acknowledged above a row that has not landed.
  const cap = await settledPositionCap(spaceId);
  return ask<PositionedFileTombstone>(spaceId,
    FILE_TOMBSTONE_QUERIES.cappedPage({ spaceId, after: after ?? { at: since ?? '' }, cap, limit }), { ...WIRE, positionAt: 1 });
}

/**
 * One page of {@link publishedFileTombstones} and where it ends: `next` is the position to resume from, or `null` when the
 * page reached the end, and `peek` is the first row past the page (`undefined` at the end) — what {@link settledFileTombstones}
 * needs to know whether the page ends inside a run of rows at one position. One more row than the page is read, which decides
 * both without a second query.
 */
export async function publishedFileTombstonePage(
  spaceId: string, after: IsoPosition, limit: number = FILE_TOMBSTONE_PAGE,
): Promise<{ rows: PositionedFileTombstone[]; next: string | null; peek: PositionedFileTombstone | undefined }> {
  const read = await publishedFileTombstones(spaceId, { after, limit: limit + 1 });
  const rows = read.slice(0, limit);
  const last = rows[rows.length - 1];
  return { rows, next: read.length > limit && last ? encodeIsoCursor({ at: last.positionAt, id: last._id }) : null, peek: read[limit] };
}

/**
 * Which of a sent page's rows a `200` PROVES delivered, given the first row it did not send (`peek`, or `undefined` at the
 * end): all of them, unless the page ends inside a RUN of rows at one position — then every row at that position is left out,
 * because the rest of the run is still to send and an acknowledgement at the position would let a prune take it.
 * The position is the only thing acknowledged, so this is the file-tombstone twin of `completeThrough` (`sync/watermark.ts`):
 * a transfer is complete through a position only when nothing more can arrive at it. A page that is ONE run proves nothing.
 */
export function settledFileTombstones<T extends { positionAt: string }>(sent: readonly T[], peek: { positionAt: string } | undefined): T[] {
  const last = sent[sent.length - 1];
  if (last === undefined || peek === undefined || peek.positionAt !== last.positionAt) return [...sent];
  return sent.filter(t => t.positionAt !== last.positionAt);
}

/** What a comparison reads of a tombstone: published or pending, the same fields (`HeldFileTombstone`, grouped by `heldByPath`). */
const HELD_PROJECTION = { _id: 1, path: 1, rowSeq: 1, contentHash: 1, issuer: 1, storedVia: 1 } as const;

/**
 * THE one reader of the PUBLISHED tombstones held for a set of paths — one `$in` per chunk, by the `path` index — with what
 * a comparison needs of each (its id, the version it erased, the hash of the content it erased).
 *
 * **Published ones only, on purpose, and the stray drain reads only this** (`settleUnstored`): its answer decides whether a
 * record is DISCARDED, and a pending tombstone names an act that may not happen, which the drain deliberately waits on
 * (bundle-30 I15). What an ARRIVING file is compared with is wider — it adds the pending tombstones whose act has already
 * removed the path's bytes ({@link decideArrivals}, Q-348) — so the arrival sites ask THAT, never this directly.
 */
export async function heldFileTombstones(spaceId: string, paths: readonly string[]): Promise<Map<string, HeldFileTombstone[]>> {
  return heldByPath(await tombstonesAtPaths<StoredFileTombstone>(spaceId, paths, chunk => ({ path: { $in: chunk }, ...PUBLISHED }), HELD_PROJECTION));
}

/** The tombstones an arrival is compared with, and the pending ones that could not be judged ({@link readHeldFor}). */
interface HeldForArrivals {
  /** Published tombstones, and pending ones whose act has removed the path's bytes: a deletion that happened. */
  held: Map<string, HeldFileTombstone[]>;
  /** Pending tombstones whose path could not be looked at: neither an act that happened nor one that did not. */
  unlooked: Map<string, HeldFileTombstone[]>;
  /** The first failure to look, for the answer's `cause`. */
  cause?: unknown;
}

/**
 * The PENDING tombstones of some paths whose act has already removed the path's bytes here — a deletion that HAPPENED and is
 * only waiting to be published (Q-348) — and those whose path cannot be looked at. A pending row whose path still has bytes is in
 * neither: its act has not happened, or failed, and it shadows nothing. A row that names no version and no content shadows
 * nothing whatever the disk says, so it is not looked at.
 *
 * Read by path through {@link FILE_TOMBSTONE_QUERIES}' by-path question, then one look at the disk per path that has such a row
 * (`bytesPresentAt`: only a missing path is an answer). Never `heldFileTombstones`: that one is the published ones, which the stray
 * drain reads and which must not widen.
 */
async function actedPendingTombstones(
  spaceId: string, paths: readonly string[],
): Promise<{ gone: Map<string, HeldFileTombstone[]>; unlooked: Map<string, HeldFileTombstone[]>; cause?: unknown }> {
  const rows = await tombstonesAtPaths<StoredFileTombstone>(spaceId, paths,
    chunk => FILE_TOMBSTONE_QUERIES.pendingByPath({ paths: chunk }).filter, HELD_PROJECTION);
  const speaking = heldByPath(rows.filter(t => typeof t.rowSeq === 'number' || erasedContent(t)));
  const gone = new Map<string, HeldFileTombstone[]>();
  const unlooked = new Map<string, HeldFileTombstone[]>();
  let cause: unknown;
  for (const [p, here] of speaking) {
    try {
      if (!await bytesPresentAt(spaceId, p)) gone.set(p, here);
    } catch (err) {
      unlooked.set(p, here);
      cause ??= err;
    }
  }
  return { gone, unlooked, ...(cause !== undefined ? { cause } : {}) };
}

/** The tombstones an arrival at each of `paths` is compared with: the published ones, and the pending ones whose act has happened. */
async function readHeldFor(spaceId: string, paths: readonly string[]): Promise<HeldForArrivals> {
  const held = await heldFileTombstones(spaceId, paths);
  const { gone, unlooked, cause } = await actedPendingTombstones(spaceId, paths);
  for (const [p, rows] of gone) held.set(p, [...(held.get(p) ?? []), ...rows]);
  return { held, unlooked, ...(cause !== undefined ? { cause } : {}) };
}

/** Which of `ids` are published tombstones already held here: an id held is never applied a second time. */
export async function heldFileTombstoneIds(spaceId: string, ids: readonly string[]): Promise<Set<string>> {
  const rows = await readStoredById<object>(spaceCollection(spaceId, 'fileTombstones'), ids, { _id: 1 }, { filter: PUBLISHED });
  return new Set(rows.keys());
}

/** How long a published tombstone that carries a move's marker is kept whatever was acknowledged: the marker is the only record that the move is owed. */
const MOVE_MARKER_KEEP_MS = 24 * 3_600_000;

/**
 * Remove the published tombstones at or below an acknowledged push position (`brain/tombstone-prune.ts` decides it), and
 * below the position cap ({@link settledPositionCap}): a position an open hold stamped has not landed, so no acknowledgement
 * covers it however it was read. A pending one is never removed here: no peer was sent it, so no acknowledgement covers it.
 * A tombstone stored before positions existed is judged by its `deletedAt`, which was its position; one with neither is never
 * removed — it cannot be proven delivered.
 *
 * Read in pages and removed by id, because two kinds of row are KEPT whatever was acknowledged ({@link keepsAfterPrune}): a
 * published tombstone whose path holds a pending one (the pending one is published next, and with nothing at the path to
 * cover it, it would be a second tombstone below a position every peer acknowledged), and one that carries a move's marker
 * until it is a day old. A page that fails is thrown to the walk, which says it once and tries again next cycle.
 */
export async function pruneFileTombstonesUpTo(spaceId: string, upTo: string): Promise<number> {
  const cap = await settledPositionCap(spaceId);
  let removed = 0;
  let after: IsoPosition = ISO_READ_START;
  for (;;) {
    const page = await ask<PrunableRow>(spaceId, FILE_TOMBSTONE_QUERIES.prunePage({ after, cap, upTo, limit: FILE_TOMBSTONE_PAGE }), PRUNABLE);
    removed += await removeUnlessKept(spaceId, page);
    const last = page[page.length - 1];
    if (page.length < FILE_TOMBSTONE_PAGE || !last?.positionAt) break;
    after = { at: last.positionAt, id: last._id };
  }
  // Stored before positions existed (the boot pass, which runs before any prune, gives each its own): judged by `deletedAt`, as it
  // always was. One delete and not a page loop: a row here is a leftover of the upgrade, and neither of the two reasons to keep a
  // row applies to it (a pending tombstone beside it was written by an act that began after the upgrade, which published it with
  // an `origin`; a move marker on it is older than a day by the time anything is acknowledged).
  removed += (await tombstonesOf(spaceId).deleteMany(asFilter<StoredFileTombstone>({
    ...PUBLISHED, positionAt: { $exists: false }, deletedAt: { $lte: upTo },
  }))).deletedCount ?? 0;
  return removed;
}

/** What the prune reads of a row. */
interface PrunableRow { _id: string; path: string; positionAt?: string; move?: { from: string; to: string } }
const PRUNABLE = { _id: 1, path: 1, positionAt: 1, move: 1 } as const;

/** Remove the rows of one prune page that may go, by id, and count them. */
async function removeUnlessKept(spaceId: string, page: readonly PrunableRow[]): Promise<number> {
  if (page.length === 0) return 0;
  const pendingPaths = new Set((await tombstonesAtPaths<{ path: string }>(spaceId, page.map(r => r.path),
    chunk => FILE_TOMBSTONE_QUERIES.pendingByPath({ paths: chunk }).filter, { path: 1 })).map(p => p.path));
  const keepMarkersAfter = new Date(Date.now() - MOVE_MARKER_KEEP_MS).toISOString();
  const ids = page.filter(r => !keepsAfterPrune(r, pendingPaths, keepMarkersAfter)).map(r => r._id);
  let removed = 0;
  for (const chunk of inChunks(ids, READ_CHUNK)) {
    removed += (await tombstonesOf(spaceId).deleteMany(asFilter<StoredFileTombstone>({ _id: { $in: chunk }, ...PUBLISHED }))).deletedCount ?? 0;
  }
  return removed;
}

/**
 * Whether the prune keeps this row though it was acknowledged: its path holds a pending tombstone, or it carries a move's
 * marker and is younger than {@link MOVE_MARKER_KEEP_MS} (`keepMarkersAfter` is the instant that long ago). A marker row older
 * than that goes: no row is unprunable for ever, and the TTL settle clears the marker of a move that is finished.
 */
function keepsAfterPrune(row: PrunableRow, pendingPaths: ReadonlySet<string>, keepMarkersAfter: string): boolean {
  if (pendingPaths.has(row.path)) return true;
  return row.move !== undefined && (row.positionAt ?? '') >= keepMarkersAfter;
}

/**
 * Which of `arrivals` a held tombstone shadows, and which it could not be decided for — THE predicate every arrival site asks
 * (the metadata writer, the manifest pull, the byte doors): one chunked read of the published tombstones by path for all of
 * them, one of the pending ones, then {@link shadowDecision} per arrival.
 *
 * **A pending tombstone counts when its act has already removed the path's bytes here** (Q-348): the delete happened and is only
 * waiting to be published, and in that window every peer that still holds the file would otherwise bring it back. It shadows
 * exactly as a published one does — by version for metadata, by content hash for bytes. One whose path still has bytes
 * shadows nothing. When the path cannot be looked at (anything but "it does not exist"), an arrival that tombstone would shadow is
 * `undecided`: the door fails closed ({@link shadowedArrivals}), the manifest pull leaves it for the next cycle.
 *
 * **A sidecar is judged by its PARENT's tombstone too** (Q-349): the tombstones read for an arrival at `_converted/<p>.md` or under
 * `_extracted/<p>/` include the ones held for `<p>`, and {@link shadowedByParent} decides whether they shadow it — the same two
 * pending states (acted, not looked at) apply to the parent's.
 *
 * For BYTES it also reads the LIVE row at the path and asks whether the path was re-created since the tombstone
 * (`recreatedSince`, the question the sidecar rule asks too — Q-407): a live row with other bytes, or a newer version by the
 * tombstone's issuer, so identical bytes re-created by their issuer as a newer version arrive with their metadata first, and pass.
 * Another author's higher seq is not a re-creation. That read happens only for an arrival some
 * held tombstone could shadow by content, so a path nobody deleted costs no more than the tombstone reads.
 */
export async function decideArrivals(spaceId: string, arrivals: readonly FileArrival[]): Promise<ArrivalVerdicts> {
  if (arrivals.length === 0) return { shadowed: new Set(), undecided: new Set() };
  return judgeArrivals(spaceId, await readHeldFor(spaceId, pathsDecidingArrivals(arrivals.map(a => a.path))), arrivals);
}

/** {@link decideArrivals} over tombstones already read. */
async function judgeArrivals(spaceId: string, read: HeldForArrivals, arrivals: readonly FileArrival[]): Promise<ArrivalVerdicts> {
  const shadowed = await shadowedAgainst(spaceId, read.held, arrivals);
  const waiting = arrivals.filter(a => !shadowed.has(a.id) && pathsDecidingArrivals([a.path]).some(p => read.unlooked.has(p)));
  if (waiting.length === 0) return { shadowed, undecided: new Set() };
  // The same predicate, with the rows that could not be looked at counted as happened: what they would shadow is undecided.
  const withUnlooked = new Map(read.held);
  for (const a of waiting) {
    for (const p of pathsDecidingArrivals([a.path])) withUnlooked.set(p, [...(read.held.get(p) ?? []), ...(read.unlooked.get(p) ?? [])]);
  }
  const undecided = await shadowedAgainst(spaceId, withUnlooked, waiting);
  return { shadowed, undecided, ...(undecided.size > 0 ? { cause: read.cause } : {}) };
}

/**
 * Which of `arrivals` a held tombstone shadows ({@link decideArrivals}), for a door that cannot go on without the answer: an
 * arrival it could not decide throws a retryable `503` ({@link cannotTellIfDeleted}) and nothing is stored. Returns the ids.
 */
export async function shadowedArrivals(spaceId: string, arrivals: readonly FileArrival[]): Promise<Set<string>> {
  const { shadowed, undecided, cause } = await decideArrivals(spaceId, arrivals);
  if (undecided.size > 0) throw cannotTellIfDeleted(cause);
  return shadowed;
}

/**
 * Whether a PEER's bytes for `path` are shadowed — the byte door's question, which asks by path FIRST: the hash of the bytes
 * (`sha256Of`, called only when needed, and awaited) is computed only when some tombstone for the path — published, or pending and
 * not looked at — carries a content hash to compare it with, so a path nobody deleted — nearly every upload — costs the indexed
 * reads and no hashing of the body. A path that cannot be looked at throws a retryable `503` ({@link shadowedArrivals}).
 */
export async function bytesShadowed(spaceId: string, path: string, sha256Of: () => string | Promise<string>): Promise<boolean> {
  const asked = pathsDecidingArrivals([path]);
  const read = await readHeldFor(spaceId, asked);
  const hashed = (rows: readonly HeldFileTombstone[] | undefined): boolean => (rows ?? []).some(erasedContent);
  // A sidecar's parent's tombstone speaks for it whatever the sidecar's own bytes are: the hash is still taken, for the one verdict.
  if (!asked.some(p => hashed(read.held.get(p)) || hashed(read.unlooked.get(p)))) return false;
  const { shadowed, undecided, cause } = await judgeArrivals(spaceId, read, [{ id: path, path, kind: 'bytes', sha256: await sha256Of() }]);
  if (undecided.size > 0) throw cannotTellIfDeleted(cause);
  return shadowed.has(path);
}

/** {@link shadowedArrivals} over tombstones already read: the decision per arrival, and the live-row read bytes need. */
async function shadowedAgainst(
  spaceId: string, held: ReadonlyMap<string, HeldFileTombstone[]>, arrivals: readonly FileArrival[],
): Promise<Set<string>> {
  const shadowed = new Set<string>();
  const needRows = arrivals.filter(a => a.kind === 'bytes' && (held.get(a.path) ?? []).some(t => t.contentHash === a.sha256));
  const live = needRows.length === 0 ? new Map<string, StoredFileRow>()
    : await readStoredById<StoredFileRow>(spaceCollection(spaceId, 'files'), needRows.map(a => a.path), STORED_ROW_PROJECTION);
  for (const a of arrivals) {
    const here = held.get(a.path) ?? [];
    if (here.length === 0) continue;
    if (a.kind === 'meta') {
      if (shadowDecision(here, a)) shadowed.add(a.id);
      continue;
    }
    // Re-created against every tombstone whose erased content these bytes are — by the one question the sidecar rule asks too (Q-407).
    const row = live.get(a.path);
    const erasedByThese = here.filter(t => erasedContent(t) && t.contentHash === a.sha256);
    const liveRowNewer = erasedByThese.length > 0 && erasedByThese.every(t => recreatedSince(t, row));
    if (shadowDecision(here, { kind: 'bytes', sha256: a.sha256, liveRowNewer })) shadowed.add(a.id);
  }
  for (const id of await shadowedByParent(spaceId, held, arrivals.filter(a => !shadowed.has(a.id)))) shadowed.add(id);
  return shadowed;
}

/**
 * Which of `arrivals` are SIDECARS of a file a held tombstone erased — a sidecar follows its parent (bundle-71, Q-349).
 *
 * ## What it prevents
 *
 * A converted file's sidecars are derived rows where it was converted, and derived rows never replicate. A peer that never
 * converted holds them as ordinary files, and a peer that still holds them re-advertises them after the parent's deletion
 * reached it: the tombstone names the parent only, and the sidecar has no tombstone, no version and no author of its own here,
 * so nothing refused it and the deleted file's text came back without the file. Giving each sidecar its own tombstone was the
 * other answer, and the wrong one: it is declined at a peer (the sidecar's author is not the deleter), it carries no version or
 * hash to compare an arrival with, and it is re-applied every cycle at a leaf. The sidecar's deletion IS its parent's.
 *
 * ## The rule
 *
 * A sidecar of `p` (`parentOfSidecar`: `_converted/<p>.md`, anything under `_extracted/<p>/`) is shadowed — bytes and metadata
 * alike, the sidecar's own version and author notwithstanding — when a held tombstone for `p`
 *  - **erased real content here** (it carries a `contentHash`): a tombstone stored for a path nobody held has none, so a peer
 *    cannot block a path's sidecars by sending a deletion for a path it guessed;
 *  - **speaks against the parent** (`heldTombstoneRefuses`, the who-half the parent's own arrival gets) judged by the PARENT row's
 *    author and deliverer where a live one exists — never the sidecar row's, whose author is whoever delivered it, which would let
 *    every sidecar through, including for a tombstone this instance issued itself;
 *  - and `p` has not been **re-created** (`parentShadows`, `tombstone-shadow.ts`, which holds the pure verdict).
 *
 * Stated limit: a parent re-created AFTER its sidecar was refused does not bring the sidecar back until the sender restarts or
 * its hash changes (a receiver that never converts is fed by the pull).
 */
async function shadowedByParent(
  spaceId: string, held: ReadonlyMap<string, HeldFileTombstone[]>, arrivals: readonly FileArrival[],
): Promise<Set<string>> {
  const asked = arrivals.flatMap(a => {
    const parent = parentOfSidecar(a.path)?.parent;
    const here = parent === undefined ? [] : (held.get(parent) ?? []).filter(erasedContent);
    return parent !== undefined && here.length > 0 ? [{ id: a.id, parent, here }] : [];
  });
  const shadowed = new Set<string>();
  if (asked.length === 0) return shadowed;
  const rows = await readStoredById<StoredFileRow>(spaceCollection(spaceId, 'files'), [...new Set(asked.map(x => x.parent))],
    STORED_ROW_PROJECTION);
  for (const { id, parent, here } of asked) if (parentShadows(here, rows.get(parent))) shadowed.add(id);
  return shadowed;
}

/**
 * Remove the held tombstones that an arriving NEWER version of their path supersedes: for each `{ path, seq }` those with
 * a `rowSeq` below `seq`. Called once the version has LANDED (a write that failed keeps the deletion). A tombstone with no
 * `rowSeq` names no version, so no arrival is known to be newer than it and it stays — the stated limit of one held from
 * before this release.
 */
export async function supersedeFileTombstones(spaceId: string, landed: ReadonlyArray<{ path: string; seq: number }>): Promise<number> {
  if (landed.length === 0) return 0;
  const ops = landed.map(l => ({ deleteMany: { filter: asFilter<StoredFileTombstone>({ path: l.path, rowSeq: { $lt: l.seq }, ...PUBLISHED }) } }));
  let removed = 0;
  await writeInOneCommands(ops, async (slice, { ordered }) => {
    const r = await tombstonesOf(spaceId).bulkWrite(asBulk<StoredFileTombstone>(slice), { ordered });
    removed += r.deletedCount ?? 0;
  }, { ordered: false, commandKindOf: bulkCommandOf });
  return removed;
}

/** A tombstone a peer delivered that this instance KEEPS, to pass it on. */
export interface RelayedFileTombstone {
  _id: string; path: string; deletedAt: string;
  /** Who deleted the file: the tombstone's own issuer, or its deliverer for an older peer's. Absent only for a trusted relay's issuer-less one. */
  issuer?: string; rowSeq?: number;
  /** The hash of the file row it erased here, when it erased one. */
  contentHash?: string;
  /** The upstream whose say-so it stood on, when it stood on the upstream ground. */
  storedVia?: string;
}

/**
 * Keep tombstones a peer delivered, to pass them on: the wire fields — with the ISSUER that signed the deletion, so the next
 * hop judges it as that issuer's — and this instance's own: the position (the RECEIVE time, never the sender's clock), the
 * hash of what was erased here, and the upstream it stood on. Inserted once by id (`$setOnInsert`), in the space the door
 * ADMITTED, in slices of one page each: a slice shares ONE receive time, taken and held with its write
 * ({@link withPositionHeld}), so a page of any length is never acknowledged above a row that has not landed. A relayed row is
 * marked `origin: 'relayed'`: it says a PEER deleted the path, and never covers a delete this instance made itself.
 */
export async function storeRelayedFileTombstones(spaceId: string, docs: readonly RelayedFileTombstone[]): Promise<void> {
  for (const slice of inChunks(docs, FILE_TOMBSTONE_PAGE)) {
    await withPositionHeld(spaceId, (receivedAt) => {
      const ops = slice.map(d => ({ updateOne: {
        filter: asFilter<StoredFileTombstone>({ _id: d._id }),
        update: asUpdate<StoredFileTombstone>({ $setOnInsert: {
          _id: d._id, spaceId, path: d.path, deletedAt: d.deletedAt, positionAt: receivedAt, origin: 'relayed' as const,
          ...(d.issuer !== undefined ? { issuer: d.issuer } : {}),
          ...(d.rowSeq !== undefined ? { rowSeq: d.rowSeq } : {}),
          ...(d.contentHash !== undefined ? { contentHash: d.contentHash } : {}),
          ...(d.storedVia !== undefined ? { storedVia: d.storedVia } : {}),
        } }),
        upsert: true,
      } }));
      return writeInOneCommands(ops, (part, { ordered }) => tombstonesOf(spaceId).bulkWrite(asBulk<StoredFileTombstone>(part), { ordered }),
        { ordered: false, commandKindOf: bulkCommandOf });
    }, 'file.tombstone.relayed');
  }
}
