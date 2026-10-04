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
 *   (`a-file-tombstone-is-read-through-its-one-module.test.js`) and reads only {@link PUBLISHED} ones.
 * - **Confirmed** ({@link confirmFileTombstones}) once the bytes are gone or moved, and stamped with that time, so a
 *   push position a peer acknowledged meanwhile cannot prune it unsent. A store failure there fails the act (`503`);
 *   its retry, or the settle below, finishes it.
 * - **Dropped** by an act that failed ({@link dropPendingFileTombstones}) — one attempt, behind the caller, because
 *   nothing depends on it: a pending tombstone is served to nobody whether or not it is dropped.
 * - **Settled** once it outlives its act ({@link settleStalePendingFileTombstones}, every TTL sweep cycle): its drop
 *   failed, its write was reported failed and landed later, or a restart came between. The disk decides — the path
 *   still has bytes, so the act did not happen: dropped; it has none, so it did: confirmed.
 *
 * **The invariant: a peer is told a path is gone only once it is gone here.**
 *
 * ## What crosses the wire
 *
 * `FileTombstoneDoc` is the replicated shape and the only one served ({@link WIRE}): `_id`, `spaceId`, `path`,
 * `deletedAt` — exactly what a receiver's `POST /file-tombstones` stores. `pending` and `move` are this instance's own
 * ({@link StoredFileTombstone}): a pending tombstone is never served, a confirmed one carries no `pending`, and the
 * projection keeps every local field off the wire rather than each reader remembering to. File tombstones are not
 * hashed (`brain/merkle.ts` reads none), so no hash rule applies to either field.
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
import { col, asDoc, asFilter, asUpdate } from '../db/mongo.js';
import type { FileTombstoneDoc } from '../config/types.js';
import { log, peerText } from '../util/log.js';
import { throwIfStoreSide, unlessTheStoreFailed } from '../brain/store-failure.js';
import { spaceCollection } from '../db/space-collection.js';
import { DetachedWork } from '../util/detached-work.js';
import { resolveSafePathChecked } from './sandbox.js';
import { bytesPresent } from './stored-bytes.js';

/** A file tombstone as stored HERE: the replicated shape, plus what never leaves this instance. */
interface StoredFileTombstone extends FileTombstoneDoc {
  /** Set until the act the tombstone records has happened. Never served, pushed, pruned or counted. */
  pending?: true;
  /** The move that wrote it, when one did: what tells a retried move it is owed. */
  move?: { from: string; to: string };
}

/** The fields a file tombstone has on the wire. Every serving reader projects to these and nothing else. */
const WIRE = { _id: 1, spaceId: 1, path: 1, deletedAt: 1 } as const;
/** A tombstone whose act has happened: the only kind any reader outside the act's own bookkeeping may see. */
const PUBLISHED = { pending: { $exists: false } } as const;
/** How long a pending tombstone may wait for its act before the TTL sweep settles it from the disk. */
const STALE_AFTER_MS = 10 * 60_000;
/** How many stale pending tombstones one space settles per sweep cycle; the rest wait for the next. */
const SETTLE_BATCH = 500;

const tombstonesOf = (spaceId: string) => col<StoredFileTombstone>(spaceCollection(spaceId, 'fileTombstones'));

/** Drops still running, so a test (and nothing else) can wait for them: `whenPendingFileTombstoneDropsSettle`. */
const drops = new DetachedWork('dropPendingFileTombstones');

/** The tombstones an act wrote pending, to confirm once its bytes are gone or to drop if it fails. */
export interface PendingFileTombstones {
  readonly spaceId: string;
  readonly docs: readonly StoredFileTombstone[];
}

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
  const now = new Date().toISOString();
  const marker = move ? { move: { from: toDocId(move.from), to: toDocId(move.to) } } : {};
  const pending = { spaceId, docs: unique.map(p => ({ _id: uuidv4(), spaceId, path: p, deletedAt: now, pending: true as const, ...marker })) };
  if (pending.docs.length === 0) return pending;
  try {
    await tombstonesOf(spaceId).insertMany(pending.docs.map(d => asDoc<StoredFileTombstone>(d)));
    return pending;
  } catch (err) {
    // A write reported failed is not known NOT to have landed: a paused store applies it when it comes back.
    dropPendingFileTombstones(pending);
    throwIfStoreSide(err);
    log.warn(`writePendingFileTombstones error for space ${peerText(spaceId)} (${unique.length} paths): ${peerText(err)}`);
    return { spaceId, docs: [] };
  }
}

/**
 * Publish an act's tombstones: its bytes are gone or moved. Upserted, so a pending one the settle dropped meanwhile is
 * written again, and stamped with this moment. A store failure is thrown (the act answers `503` and its retry
 * completes it); any other is logged, and the settle confirms what it left pending.
 */
export async function confirmFileTombstones(pending: PendingFileTombstones): Promise<void> {
  if (pending.docs.length === 0) return;
  const deletedAt = new Date().toISOString();
  await unlessTheStoreFailed(`confirmFileTombstones for space ${peerText(pending.spaceId)} (${pending.docs.length})`,
    () => tombstonesOf(pending.spaceId).bulkWrite(pending.docs.map(d => ({
      updateOne: {
        filter: asFilter<StoredFileTombstone>({ _id: d._id }),
        update: asUpdate<StoredFileTombstone>({
          $set: { spaceId: d.spaceId, path: d.path, deletedAt, ...(d.move ? { move: d.move } : {}) }, $unset: { pending: '' },
        }),
        upsert: true,
      },
    })), { ordered: false }));
}

/**
 * Run an act's irreversible step under its pending tombstones: dropped if the step throws (and the throw passed on),
 * published once it returns. Every act that removes a path orders it through here — the file delete, the directory
 * delete and the move — so none can publish a tombstone for bytes that are still here, or leave one unconfirmed for
 * bytes that are gone.
 */
export async function actUnderPendingTombstones(pending: PendingFileTombstones, step: () => Promise<unknown>): Promise<void> {
  try {
    await step();
  } catch (err) {
    dropPendingFileTombstones(pending);
    throw err;
  }
  await confirmFileTombstones(pending);
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

/**
 * Settle the pending tombstones that outlived their act, from the disk: a path that still has bytes was not removed,
 * so its tombstone is dropped; a path with none was, so it is published. A path that cannot be looked at stays
 * pending — served to nobody — until a later cycle can. Run by every TTL sweep cycle, per space.
 */
export async function settleStalePendingFileTombstones(spaceId: string, now: Date = new Date()): Promise<{ dropped: number; confirmed: number }> {
  const before = new Date(now.getTime() - STALE_AFTER_MS).toISOString();
  const stale = await tombstonesOf(spaceId)
    .find(asFilter<StoredFileTombstone>({ pending: true, deletedAt: { $lte: before } }), { projection: { _id: 1, path: 1 } })
    .limit(SETTLE_BATCH).toArray();
  const drop: string[] = [], confirm: string[] = [];
  for (const t of stale) {
    try {
      (await bytesPresent(await resolveSafePathChecked(spaceId, t.path)) ? drop : confirm).push(t._id);
    } catch (err) {
      log.warn(`File tombstone for ${peerText(spaceId)}/${peerText(t.path)} left pending: its path cannot be looked at: ${peerText(err)}`);
    }
  }
  const tombstones = tombstonesOf(spaceId);
  if (drop.length > 0) await tombstones.deleteMany(asFilter<StoredFileTombstone>({ _id: { $in: drop }, pending: true }));
  if (confirm.length > 0) {
    // Stamped with the real time, never the sweep's `now`: `deletedAt` is the push position peers acknowledge.
    await tombstones.updateMany(asFilter<StoredFileTombstone>({ _id: { $in: confirm }, pending: true }),
      asUpdate<StoredFileTombstone>({ $set: { deletedAt: new Date().toISOString() }, $unset: { pending: '' } }));
  }
  if (drop.length + confirm.length > 0) {
    log.info(`File tombstones of ${peerText(spaceId)} settled from the disk: ${confirm.length} published (the path is gone), `
      + `${drop.length} dropped (the path still has its file)`);
  }
  return { dropped: drop.length, confirmed: confirm.length };
}

// ── The move's marker ─────────────────────────────────────────────────────────────────────────────────────────────

/** Whether a move from `from` to `to` was begun here — its tombstones written — and not yet finished. */
export async function moveWasBegun(spaceId: string, from: string, to: string): Promise<boolean> {
  const marker = { 'move.from': toDocId(from), 'move.to': toDocId(to) };
  return (await tombstonesOf(spaceId).findOne(asFilter<StoredFileTombstone>(marker), { projection: { _id: 1 } })) !== null;
}

/**
 * Publish the tombstones of a begun move whose bytes have moved, from its marker — for the retry that completes it,
 * which holds no handle on what the first attempt wrote. Fails as {@link confirmFileTombstones} fails.
 */
export async function confirmBegunMove(spaceId: string, from: string, to: string): Promise<void> {
  const marker = { 'move.from': toDocId(from), 'move.to': toDocId(to), pending: true };
  await unlessTheStoreFailed(`confirmBegunMove for space ${peerText(spaceId)}, ${peerText(from)} → ${peerText(to)}`,
    () => tombstonesOf(spaceId).updateMany(asFilter<StoredFileTombstone>(marker),
      asUpdate<StoredFileTombstone>({ $set: { deletedAt: new Date().toISOString() }, $unset: { pending: '' } })));
}

/**
 * Forget a finished move's marker, so a later orphan at `from` beside a file at `to` is not taken for it. Best effort:
 * a marker left behind matters only to that history, and failing a finished move over it would answer a failure for
 * an act that happened.
 */
export async function forgetFinishedMove(spaceId: string, from: string, to: string): Promise<void> {
  const marker = { 'move.from': toDocId(from), 'move.to': toDocId(to) };
  await tombstonesOf(spaceId).updateMany(asFilter<StoredFileTombstone>(marker), asUpdate<StoredFileTombstone>({ $unset: { move: '' } }))
    .catch(err => log.warn(`forgetFinishedMove for space ${peerText(spaceId)}, ${peerText(from)} → ${peerText(to)}: ${peerText(err)}`));
}

// ── The readers: published tombstones only ────────────────────────────────────────────────────────────────────────

/**
 * The published tombstones of a space in their wire shape, oldest first — what `GET /api/sync/file-tombstones` serves
 * and what a sync cycle pushes. `since` keeps those published after it.
 */
export async function publishedFileTombstones(
  spaceId: string, { since, limit }: { since?: string; limit?: number } = {},
): Promise<FileTombstoneDoc[]> {
  const filter = asFilter<StoredFileTombstone>({ spaceId, ...PUBLISHED, ...(since ? { deletedAt: { $gt: since } } : {}) });
  const cursor = tombstonesOf(spaceId).find(filter, { projection: WIRE }).sort({ deletedAt: 1 });
  return (limit !== undefined ? cursor.limit(limit) : cursor).toArray() as Promise<FileTombstoneDoc[]>;
}

/** Which of `paths` a published tombstone names: files known to be deleted, here or by a peer. */
export async function tombstonedFilePaths(spaceId: string, paths: readonly string[]): Promise<Set<string>> {
  if (paths.length === 0) return new Set();
  const rows = await tombstonesOf(spaceId)
    .find(asFilter<StoredFileTombstone>({ path: { $in: [...paths] }, ...PUBLISHED }), { projection: { path: 1 } }).toArray();
  return new Set(rows.map(t => t.path));
}

/**
 * Remove the published tombstones at or below an acknowledged push position (`brain/tombstone-prune.ts` decides it).
 * A pending one is never removed here: no peer was sent it, so no acknowledgement covers it.
 */
export async function pruneFileTombstonesUpTo(spaceId: string, upTo: string): Promise<number> {
  const res = await tombstonesOf(spaceId).deleteMany(asFilter<StoredFileTombstone>({ deletedAt: { $lte: upTo }, ...PUBLISHED }));
  return res.deletedCount ?? 0;
}

/** Keep a tombstone a peer pushed, to pass it on: its four wire fields, inserted once by id. */
export async function storePeerFileTombstone(spaceId: string, doc: FileTombstoneDoc): Promise<void> {
  await tombstonesOf(spaceId).updateOne(asFilter<StoredFileTombstone>({ _id: doc._id }),
    asUpdate<StoredFileTombstone>({ $setOnInsert: doc }), { upsert: true });
}
