/**
 * The file-tombstone collection — the ONE module that names it (`<spaceId>_file_tombstones`) and opens it.
 *
 * ## What it answers
 *
 * *"How is this space's collection of file tombstones read and written, whoever asks?"* Its indexes, the stored row's shape
 * ({@link StoredFileTombstone}, with the move's marker {@link MoveMarker} inside it), the questions asked of it that an index must
 * answer ({@link FILE_TOMBSTONE_QUERIES}), the keyset read that runs them ({@link ask}), the chunked by-path read
 * ({@link tombstonesAtPaths}) and the by-id read ({@link readTombstonesById}), and the wipe generation a publish in flight is judged
 * by. Nothing else opens the collection, so a rule about it — a PENDING tombstone (an act not yet done) is served, pushed, pruned and
 * counted by nothing — has one place to be kept (`a-file-tombstone-is-read-through-its-one-module.test.js`).
 *
 * ## Why it is its own module, and who may import it (Q-462)
 *
 * `files/tombstones.ts` held the lifecycle (written pending, settled, published, pruned, applied against arrivals), the move's marker
 * and the collection both are read through, and reached 778 code lines against a ceiling of 650. The marker block is
 * `files/move-markers.ts`; what BOTH read the collection through is here, at the bottom of the three: this module imports neither, and
 * only those two import it (`the-move-marker-block-is-its-own-module.test.js` holds the edges). The marker's own query shapes
 * (`move.from`, `move.to`) are the marker module's, not this registry's, so a marker read written anywhere else is held to the pager
 * there (`move-marker-queries-are-read-through-the-pager.test.js`).
 */

import { col, asFilter } from '../db/mongo.js';
import { readStoredById, READ_CHUNK } from '../db/read-by-id.js';
import type { FileTombstoneDoc } from '../config/types.js';
import { spaceCollection } from '../db/space-collection.js';
import { dropIndexesIfPresent } from '../db/index-names.js';
import { inChunks } from '../util/chunks.js';
import { isoKeysetFilters, isoKeysetSort, tieThenRange, type IsoPosition } from '../util/seq-keyset.js';
import type { WebhookActor } from '../webhooks/dispatcher.js';

/**
 * What a move writes on its tombstones: the two paths, and what housekeeping needs to finish the move should the request that
 * began it not. Everything past `from` and `to` lives INSIDE `move`, so the one `$unset` of the marker clears it all, and none
 * of it is on the wire (the projection a peer is sent is `WIRE`, in `tombstones.ts`).
 */
export interface MoveMarker {
  from: string;
  to: string;
  /** The size and mtime of the file's bytes as the move began (a rename keeps both): what tells the bytes at `to` are the moved ones. Absent for a directory, and on a marker written before they were recorded. */
  size?: number;
  mtimeMs?: number;
  /** Who asked for the move, so the completion tells subscribers once, as the request would have. */
  actor?: WebhookActor;
  /** How many times housekeeping has tried to finish the move, and the instant before which it does not try again. */
  attempts?: number;
  nextAttemptAt?: string;
}

/** A file tombstone as stored HERE: the replicated shape, plus what never leaves this instance. */
export interface StoredFileTombstone extends FileTombstoneDoc {
  /** Set until the act the tombstone records has happened. Never served, pushed, pruned or counted. */
  pending?: true;
  /** The move that wrote it, when one did: what tells a retried move it is owed. */
  move?: MoveMarker;
  /** The hash of the file row's content when the act (or the apply) removed it, as THIS instance held it — what a
   *  later byte arrival is compared with (`shadowDecision`). Never on the wire: a deletion carries no fingerprint of
   *  the erased content. */
  contentHash?: string;
  /** The upstream that delivered a RELAYED tombstone, so a later version from that same upstream is not refused by it. */
  storedVia?: string;
  /** This instance's own position for the tombstone, for paging, acknowledgement and pruning: the publish time of an
   *  own one, the RECEIVE time of a relayed one — a foreign clock never enters a local position. */
  positionAt?: string;
  /** When the act that wrote it PUT it: a stamp of this instance's monotonic clock (the position clock of `tombstones.ts`), so any two rows
   *  of one space order by it. What the one-per-path rule compares; `deletedAt` is the same instant while pending and the
   *  publish time after, and a foreign or settled clock never decides. Absent on a row stored before it existed. */
  writtenAt?: string;
  /** What the settle selects and orders by, while pending: the WALL clock when the act wrote it (a timer, never a position), then
   *  the settle's own `now` once it cannot look at the path — never `deletedAt` or `writtenAt`, which the one-per-path rule reads. */
  settleAt?: string;
  /** Who made the published row: `own` (this instance published it) or `relayed` (a peer's, kept to be passed on). A row
   *  with neither stamp is never taken for one this instance published, so it never suppresses an own tombstone. */
  origin?: 'own' | 'relayed';
}

/** A tombstone whose act has happened: the only kind any reader outside the act's own bookkeeping may see. */
export const PUBLISHED = { pending: { $exists: false } } as const;

/** How many stale pending tombstones one space settles per sweep cycle, oldest first; the rest wait for the next. */
export const FILE_TOMBSTONE_SETTLE_BATCH = 500;

/**
 * The space's file-tombstone collection, typed. A declared function with a block body and not a concise arrow, on purpose: the write-site
 * derivation (`testing/standalone/_space-writers.mjs`) follows a helper that returns a collection into the module that defines it only when
 * the index holds it, and it holds a declaration — so every `tombstonesOf(spaceId).updateMany(…)` in the lifecycle and the marker module
 * is read as a write to a SPACE collection, not as a write to something it could not resolve.
 */
export function tombstonesOf(spaceId: string) {
  return col<StoredFileTombstone>(spaceCollection(spaceId, 'fileTombstones'));
}

/**
 * Drop the indexes of the space's file tombstones that a later release replaced, by name — only those listed
 * (`dropIndexesIfPresent`, the one way a replaced index goes). Here because this module is the one that names the collection;
 * which indexes it should carry, and which it replaced, is the lifecycle's (`ensureFileTombstoneIndexes`, in `tombstones.ts`).
 */
export const dropFileTombstoneIndexesIfPresent = (spaceId: string, names: readonly string[]) =>
  dropIndexesIfPresent(spaceCollection(spaceId, 'fileTombstones'), names);

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
export async function ask<T>(spaceId: string, q: FileTombstoneQuery, projection: Record<string, 1>): Promise<T[]> {
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
 * caller needs. THE chunked by-path read: the published ones an arriving file is compared with (`heldFileTombstones`),
 * the rows a publish decides over, the pending ones a prune must not leave a path without.
 */
export async function tombstonesAtPaths<T>(
  spaceId: string, paths: readonly string[], filterFor: (chunk: string[]) => Record<string, unknown>, projection: Record<string, 1>,
): Promise<T[]> {
  const out: T[] = [];
  for (const chunk of inChunks([...new Set(paths)], READ_CHUNK)) {
    out.push(...await tombstonesOf(spaceId).find(asFilter<StoredFileTombstone>(filterFor(chunk) as never), { projection }).toArray() as unknown as T[]);
  }
  return out;
}

/**
 * How many times each space's file tombstones have been wiped in this process. A pending handle carries the generation it was
 * written under, and a publish or a settle that read its rows under another one drops instead of upserting: its upsert exists to
 * write again a row a stale settle dropped, and after a wipe it would re-create a tombstone in a space that was just emptied —
 * published, served, and applied by every peer to a path of the NEW space.
 */
const wipeGenerations = new Map<string, number>();
export const wipeGenerationOf = (spaceId: string): number => wipeGenerations.get(spaceId) ?? 0;

/**
 * Mark a wipe of the space's file tombstones: the next generation. Called by the one wipe (`forgetFileTombstonesOf`, in
 * `tombstones.ts`, under the space's publish lock) in the same step as its delete — the delete alone is what a publish in flight
 * undoes, and the generation alone says nothing about the rows.
 */
export const bumpWipeGeneration = (spaceId: string): void => { wipeGenerations.set(spaceId, wipeGenerationOf(spaceId) + 1); };

/**
 * The stored tombstones of `ids`, by id, as a Map keyed by the stored `_id` — one projected `$in` read per chunk
 * (`db/read-by-id.ts`), narrowed by `filter` (ANDed beside the ids, never spread). THE by-id read of the collection: the pending
 * rows a drop is about to remove, and which of some ids are published tombstones already held.
 */
export async function readTombstonesById<T extends object>(
  spaceId: string, ids: readonly string[], projection: Record<string, 1>, filter?: Record<string, unknown>,
): Promise<Map<string, T>> {
  return readStoredById<T>(spaceCollection(spaceId, 'fileTombstones'), ids, projection, filter ? { filter } : {});
}

/** What the prune reads of a row. */
export interface PrunableRow { _id: string; path: string; positionAt?: string; move?: MoveMarker }

