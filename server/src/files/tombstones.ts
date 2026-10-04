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
  // The settle: `{ pending: true, deletedAt <= t }` sorted by `deletedAt`. Partial, so it holds only the pending few.
  { keys: { pending: 1, deletedAt: 1 }, options: { partialFilterExpression: { pending: { $exists: true } } } },
  // A move's marker: `moveWasBegun`, `settleBegunMove` and `forgetFinishedMove`, once or more per move. Sparse: only a
  // move's tombstones carry it, and only until the move is finished.
  { keys: { 'move.from': 1, 'move.to': 1 }, options: { sparse: true } },
] as const;

/**
 * Create {@link FILE_TOMBSTONE_INDEXES} for one space. Idempotent, so `initSpace` runs it for a new space and the boot
 * pass (`ensureQueryIndexes`) for every space initialisation does not revisit — here, because this module is the one
 * that opens the collection.
 */
export async function ensureFileTombstoneIndexes(spaceId: string): Promise<void> {
  for (const ix of FILE_TOMBSTONE_INDEXES) await tombstonesOf(spaceId).createIndex(ix.keys, ix.options);
}

/**
 * What publishing a tombstone writes: `pending` gone, and `deletedAt` stamped NOW — the real time, never a caller's
 * clock — because `deletedAt` is the push position peers acknowledge, and a tombstone published under an older stamp
 * could fall below a position acknowledged while it was pending and be pruned unsent. One builder for the three
 * ways a tombstone is published (confirmed by its act, by a retried move, by the settle).
 */
const publishedNow = () => ({ $set: { deletedAt: new Date().toISOString() }, $unset: { pending: '' as const } });

/** The marker a move writes on its tombstones, as a filter. */
const moveMarker = (from: string, to: string) => ({ 'move.from': toDocId(from), 'move.to': toDocId(to) });

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
  const { $set, $unset } = publishedNow();
  await unlessTheStoreFailed(`confirmFileTombstones for space ${peerText(pending.spaceId)} (${pending.docs.length})`,
    () => tombstonesOf(pending.spaceId).bulkWrite(pending.docs.map(d => ({
      updateOne: {
        filter: asFilter<StoredFileTombstone>({ _id: d._id }),
        update: asUpdate<StoredFileTombstone>({
          $set: { ...$set, spaceId: d.spaceId, path: d.path, ...(d.move ? { move: d.move } : {}) }, $unset,
        }),
        upsert: true,
      },
    })), { ordered: false }));
}

/** The part of an act's pending tombstones that names one of `paths` — those one step of the act removes. */
export function pendingAmong(pending: PendingFileTombstones, paths: readonly string[]): PendingFileTombstones {
  const wanted = new Set(paths.map(toDocId));
  return { spaceId: pending.spaceId, docs: pending.docs.filter(d => wanted.has(d.path)) };
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

/** What settling some pending tombstones from the disk did, by id. */
interface Settled { dropped: string[]; confirmed: string[]; unresolved: string[] }

/**
 * THE settle rule, one copy for every caller: the disk decides each pending tombstone. Its path still has bytes, so
 * the act did not remove it: dropped. It has none, so the act did: published, stamped now (`publishedNow`, never a
 * caller's clock). A path that cannot be looked at is neither — it stays pending, served to nobody, and is returned
 * as `unresolved` for the caller to decide when to ask again. Only tombstones still pending are touched, so one an
 * act confirmed meanwhile is left as it is. A store failure is thrown.
 */
async function settleFromTheDisk(spaceId: string, rows: ReadonlyArray<{ _id: string; path: string }>): Promise<Settled> {
  const out: Settled = { dropped: [], confirmed: [], unresolved: [] };
  for (const t of rows) {
    try {
      (await bytesPresent(await resolveSafePathChecked(spaceId, t.path)) ? out.dropped : out.confirmed).push(t._id);
    } catch (err) {
      out.unresolved.push(t._id);
      log.warn(`File tombstone for ${peerText(spaceId)}/${peerText(t.path)} left pending: its path cannot be looked at: ${peerText(err)}`);
    }
  }
  const tombstones = tombstonesOf(spaceId);
  if (out.dropped.length > 0) await tombstones.deleteMany(asFilter<StoredFileTombstone>({ _id: { $in: out.dropped }, pending: true }));
  if (out.confirmed.length > 0) {
    await tombstones.updateMany(asFilter<StoredFileTombstone>({ _id: { $in: out.confirmed }, pending: true }), asUpdate<StoredFileTombstone>(publishedNow()));
  }
  return out;
}

/**
 * Settle an act's pending tombstones from the disk now — for the step of an act that removes its bytes and survives
 * its own failure (a directory delete's sidecars), and for any step that failed. Fails as {@link confirmFileTombstones}
 * fails: a store failure is thrown.
 */
export async function settlePendingFileTombstones(pending: PendingFileTombstones): Promise<void> {
  if (pending.docs.length === 0) return;
  await unlessTheStoreFailed(`settlePendingFileTombstones for space ${peerText(pending.spaceId)} (${pending.docs.length})`,
    () => settleFromTheDisk(pending.spaceId, pending.docs));
}

/**
 * Settle the pending tombstones that outlived their act, from the disk ({@link settleFromTheDisk}). Run by every TTL
 * sweep cycle, per space, at most {@link FILE_TOMBSTONE_SETTLE_BATCH} at a time.
 *
 * **Oldest first, and one it cannot look at goes to the back** (bundle-30 I16, preship-4 P4-1): its staleness clock
 * restarts at this cycle (`deletedAt` set to `now` — while pending, `deletedAt` is only that clock; publishing stamps
 * it afresh), so it is asked again only once it is stale again, behind every tombstone that went stale before it.
 * Unordered and left where it was, a batch's worth of paths it could not look at came back first every cycle and
 * starved the rest of the space for ever.
 */
export async function settleStalePendingFileTombstones(spaceId: string, now: Date = new Date()): Promise<{ dropped: number; confirmed: number }> {
  const before = new Date(now.getTime() - STALE_AFTER_MS).toISOString();
  const stale = await tombstonesOf(spaceId)
    .find(asFilter<StoredFileTombstone>({ pending: true, deletedAt: { $lte: before } }), { projection: { _id: 1, path: 1 } })
    .sort({ deletedAt: 1 }).limit(FILE_TOMBSTONE_SETTLE_BATCH).toArray();
  const { dropped, confirmed, unresolved } = await settleFromTheDisk(spaceId, stale);
  if (unresolved.length > 0) {
    await tombstonesOf(spaceId).updateMany(asFilter<StoredFileTombstone>({ _id: { $in: unresolved }, pending: true }),
      asUpdate<StoredFileTombstone>({ $set: { deletedAt: now.toISOString() } }));
  }
  if (dropped.length + confirmed.length > 0) {
    log.info(`File tombstones of ${peerText(spaceId)} settled from the disk: ${confirmed.length} published (the path is gone), `
      + `${dropped.length} dropped (the path still has its file)`);
  }
  return { dropped: dropped.length, confirmed: confirmed.length };
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
 * no handle on what its first attempt wrote. Fails as {@link confirmFileTombstones} fails.
 */
export async function settleBegunMove(spaceId: string, from: string, to: string): Promise<void> {
  await unlessTheStoreFailed(`settleBegunMove for space ${peerText(spaceId)}, ${peerText(from)} → ${peerText(to)}`, async () => {
    const left = await tombstonesOf(spaceId)
      .find(asFilter<StoredFileTombstone>({ ...moveMarker(from, to), pending: true }), { projection: { _id: 1, path: 1 } }).toArray();
    await settleFromTheDisk(spaceId, left);
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
