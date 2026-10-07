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
 * A held tombstone is also a statement about a VERSION of a path, not about the path for ever: `rowSeq` is the version it
 * erased and `contentHash` the hash of the content (this instance's own row, never read from bytes). An arriving file is
 * compared with them in one place, {@link shadowedArrivals} — by version for metadata, by content for bytes — so a peer that
 * still holds a deleted file cannot bring it back through any door, and a newer version of the path is never refused.
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
import { DetachedWork } from '../util/detached-work.js';
import { inChunks } from '../util/chunks.js';
import { encodeIsoCursor, isoKeysetFilters, isoKeysetSort, tieThenRange, type IsoPosition } from '../util/seq-keyset.js';
import { resolveSafePathChecked } from './sandbox.js';
import { bytesPresent } from './stored-bytes.js';
import { heldTombstoneRefuses } from '../sync/upsert-plan.js';

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
  // The settle: `{ pending: true, deletedAt <= t }` sorted by `deletedAt`. Partial, so it holds only the pending few.
  { keys: { pending: 1, deletedAt: 1 }, options: { partialFilterExpression: { pending: { $exists: true } } } },
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
}

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
  const res = await tombstonesOf(spaceId).updateMany(
    asFilter<StoredFileTombstone>({ ...PUBLISHED, positionAt: { $exists: false }, deletedAt: { $type: 'string' } }),
    asUpdate<StoredFileTombstone>({ $set: { positionAt: new Date().toISOString() } }));
  return res.modifiedCount;
}

/**
 * What publishing a tombstone writes: `pending` gone, and `deletedAt` and `positionAt` stamped NOW — the real time, never a
 * caller's clock — because the position is what peers acknowledge, and a tombstone published under an older stamp could
 * fall below a position acknowledged while it was pending and be pruned unsent. Written only by {@link publishOnePerPath},
 * the one way a tombstone is published.
 */
const publishedNow = () => {
  const now = new Date().toISOString();
  return { $set: { deletedAt: now, positionAt: now }, $unset: { pending: '' as const } };
};

/** A pending tombstone about to be published: while pending, `deletedAt` is when it was written. */
type ToPublish = Pick<StoredFileTombstone, '_id' | 'path' | 'deletedAt' | 'move' | 'issuer' | 'rowSeq' | 'contentHash'>;

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
 * - **One written no later than a tombstone already published for its path is not published**, and is dropped: that
 *   publication was made after this act began, so it already told every peer — this one is the leftover of an
 *   attempt the publication finished, or a failed write the store applied late.
 * - Otherwise the newest-written is published — upserted, so one the stale settle dropped while its act was still
 *   running is written again — and every other pending tombstone for that path is removed.
 *
 * Its failures are thrown; every caller decides what a store failure means for its act.
 */
async function publishOnePerPath(spaceId: string, docs: readonly ToPublish[]): Promise<{ published: number; dropped: number }> {
  if (docs.length === 0) return { published: 0, dropped: 0 };
  const tombstones = tombstonesOf(spaceId);
  const paths = [...new Set(docs.map(d => d.path))];
  const stored = await tombstones.find(asFilter<StoredFileTombstone>({ path: { $in: paths } }),
    { projection: { _id: 1, path: 1, deletedAt: 1, positionAt: 1, pending: 1 } }).toArray();
  const alreadyPublished = new Set(stored.filter(t => !t.pending).map(t => t._id));
  const { $set, $unset } = publishedNow();
  const ops: object[] = [];
  /** Pending tombstones a newer publication for their path already covers: dropped, not published. */
  const superseded: string[] = [];
  let published = 0;
  let dropped = 0;
  for (const path of paths) {
    // The newest PUBLISHED position for the path (a relayed tombstone's is its receive time): the one clock every stored
    // tombstone shares, where `deletedAt` of a relayed one is the sender's.
    const newestPublished = stored.filter(t => t.path === path && !t.pending).reduce((m, t) => {
      const at = fileTombstonePosition(t) ?? '';
      return at > m ? at : m;
    }, '');
    const candidates = docs.filter(d => d.path === path && !alreadyPublished.has(d._id));
    const winner = candidates.filter(d => d.deletedAt > newestPublished).sort((a, b) => b.deletedAt.localeCompare(a.deletedAt))[0];
    if (winner) {
      // What the act knew of the version it erased travels with it, so an upsert (a tombstone the stale settle dropped
      // while its act was still running) writes it again rather than publishing a bare one.
      const knew = {
        ...(winner.issuer !== undefined ? { issuer: winner.issuer } : {}),
        ...(winner.rowSeq !== undefined ? { rowSeq: winner.rowSeq } : {}),
        ...(winner.contentHash !== undefined ? { contentHash: winner.contentHash } : {}),
      };
      ops.push({ updateOne: {
        filter: asFilter<StoredFileTombstone>({ _id: winner._id }),
        update: asUpdate<StoredFileTombstone>({ $set: { ...$set, spaceId, path, ...knew, ...(winner.move ? { move: winner.move } : {}) }, $unset }),
        upsert: true,
      } });
      ops.push({ deleteMany: { filter: asFilter<StoredFileTombstone>({ path, pending: true, _id: { $ne: winner._id } }) } });
      published += 1;
      dropped += candidates.length - 1;
    } else {
      superseded.push(...candidates.map(d => d._id));
    }
  }
  // An update and a delete per path: sliced by type, so each slice is one command (`bulkCommandOf`).
  await writeInOneCommands(ops, (slice, { ordered }) => tombstones.bulkWrite(asBulk<StoredFileTombstone>(slice), { ordered }),
    { ordered: false, commandKindOf: bulkCommandOf });
  if (superseded.length > 0) await tombstones.deleteMany(asFilter<StoredFileTombstone>({ _id: { $in: superseded }, pending: true }));
  return { published, dropped: dropped + superseded.length };
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
  // What the act knows of what it is about to erase, read ONCE for every path (one `$in` per chunk): who is acting, and the
  // version and content hash of each file ROW. The hash is the row's, never the bytes' — the bytes may be the next thing
  // to go, and a row hash costs no read of them. A path with no row (derived sidecar, an orphan) is stamped with the issuer
  // alone: a version and a hash it does not have are not guessed.
  const rows = await readFileRows(spaceId, unique);
  const issuer = authorRef().instanceId;
  const pending = { spaceId, docs: unique.map((p): StoredFileTombstone => {
    const row = rows.get(p);
    return {
      _id: uuidv4(), spaceId, path: p, deletedAt: now, pending: true as const, ...marker,
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
    return { spaceId, docs: [] };
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
    () => publishOnePerPath(pending.spaceId, pending.docs));
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
const TO_PUBLISH = { _id: 1, path: 1, deletedAt: 1, move: 1 } as const;

/**
 * THE settle rule, one copy for every caller: the disk decides each pending tombstone. Its path still has bytes, so
 * the act did not remove it: dropped. It has none, so the act did: published ({@link publishOnePerPath} — one per
 * path, stamped now, never a caller's clock). A path that cannot be looked at is neither — it stays pending, served
 * to nobody, and is returned as `unresolved` for the caller to decide when to ask again. Only tombstones still
 * pending are dropped, and one an act published meanwhile is left as it is. A store failure is thrown.
 */
async function settleFromTheDisk(spaceId: string, rows: readonly ToPublish[]): Promise<Settled> {
  const here: string[] = [];
  const gone: ToPublish[] = [];
  const unresolved: string[] = [];
  for (const t of rows) {
    try {
      if (await bytesPresent(await resolveSafePathChecked(spaceId, t.path))) here.push(t._id); else gone.push(t);
    } catch (err) {
      unresolved.push(t._id);
      log.warn(`File tombstone for ${peerText(spaceId)}/${peerText(t.path)} left pending: its path cannot be looked at: ${peerText(err)}`);
    }
  }
  if (here.length > 0) await tombstonesOf(spaceId).deleteMany(asFilter<StoredFileTombstone>({ _id: { $in: here }, pending: true }));
  const { published, dropped } = await publishOnePerPath(spaceId, gone);
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
 *
 * **A leftover whose path already has a newer published tombstone is dropped, not published** (bundle-30 I17,
 * verify-drive-5 F1): the act's retry published that one, or the failed write landed after it did. Published, it was
 * a second tombstone for one removal, stamped minutes later — see {@link publishOnePerPath}.
 */
export async function settleStalePendingFileTombstones(
  spaceId: string, now: Date = new Date(),
): Promise<{ dropped: number; confirmed: number; superseded: number }> {
  const before = new Date(now.getTime() - STALE_AFTER_MS).toISOString();
  const stale = await tombstonesOf(spaceId)
    .find(asFilter<StoredFileTombstone>({ pending: true, deletedAt: { $lte: before } }), { projection: TO_PUBLISH })
    .sort({ deletedAt: 1 }).limit(FILE_TOMBSTONE_SETTLE_BATCH).toArray();
  const { dropped, confirmed, superseded, unresolved } = await settleFromTheDisk(spaceId, stale);
  if (unresolved.length > 0) {
    await tombstonesOf(spaceId).updateMany(asFilter<StoredFileTombstone>({ _id: { $in: unresolved }, pending: true }),
      asUpdate<StoredFileTombstone>({ $set: { deletedAt: now.toISOString() } }));
  }
  if (dropped + confirmed + superseded > 0) {
    log.info(`File tombstones of ${peerText(spaceId)} settled from the disk: ${confirmed} published (the path is gone), `
      + `${dropped} dropped (the path still has its file), ${superseded} dropped (the path already has its published tombstone)`);
  }
  return { dropped, confirmed, superseded };
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
    const left = await tombstonesOf(spaceId)
      .find(asFilter<StoredFileTombstone>({ ...moveMarker(from, to), pending: true }), { projection: TO_PUBLISH }).toArray();
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
  const projection = { ...WIRE, positionAt: 1 } as const;
  const sort = isoKeysetSort('positionAt');
  const find = async (filter: Record<string, unknown>, n: number | undefined): Promise<PositionedFileTombstone[]> => {
    const cursor = tombstonesOf(spaceId).find(asFilter<StoredFileTombstone>({ spaceId, ...PUBLISHED, ...filter } as never), { projection }).sort({ ...sort });
    return (n !== undefined ? cursor.limit(n) : cursor).toArray() as Promise<PositionedFileTombstone[]>;
  };
  const { tie, range } = isoKeysetFilters('positionAt', after ?? { at: since ?? '' });
  return tieThenRange(find, tie, range, limit);
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

/** The tombstones this instance holds for each of `paths`: what an arriving file is compared with. */
export interface HeldFileTombstone { _id: string; rowSeq?: number; contentHash?: string; issuer?: string; storedVia?: string }

/**
 * THE one reader of the published tombstones held for a set of paths — one `$in` per chunk, by the `path` index — with what
 * a comparison needs of each (its id, the version it erased, the hash of the content it erased). Every arrival site asks
 * it (`shadowedArrivals`, the stray drain's settle); a second reader would be a second answer to "is this path deleted".
 */
export async function heldFileTombstones(spaceId: string, paths: readonly string[]): Promise<Map<string, HeldFileTombstone[]>> {
  const out = new Map<string, HeldFileTombstone[]>();
  for (const chunk of inChunks([...new Set(paths)], READ_CHUNK)) {
    const rows = await tombstonesOf(spaceId)
      .find(asFilter<StoredFileTombstone>({ path: { $in: chunk }, ...PUBLISHED }), { projection: { _id: 1, path: 1, rowSeq: 1, contentHash: 1, issuer: 1, storedVia: 1 } }).toArray();
    for (const t of rows) {
      if (!out.has(t.path)) out.set(t.path, []);
      out.get(t.path)!.push({ _id: t._id, ...(t.rowSeq !== undefined ? { rowSeq: t.rowSeq } : {}), ...(t.contentHash !== undefined ? { contentHash: t.contentHash } : {}),
        ...(t.issuer !== undefined ? { issuer: t.issuer } : {}), ...(t.storedVia !== undefined ? { storedVia: t.storedVia } : {}) });
    }
  }
  return out;
}

/** Which of `ids` are published tombstones already held here: an id held is never applied a second time. */
export async function heldFileTombstoneIds(spaceId: string, ids: readonly string[]): Promise<Set<string>> {
  const rows = await readStoredById<object>(spaceCollection(spaceId, 'fileTombstones'), ids, { _id: 1 }, { filter: PUBLISHED });
  return new Set(rows.keys());
}

/**
 * Remove the published tombstones at or below an acknowledged push position (`brain/tombstone-prune.ts` decides it).
 * A pending one is never removed here: no peer was sent it, so no acknowledgement covers it. A tombstone stored before
 * positions existed is judged by its `deletedAt`, which was its position; one with neither is never removed — it cannot be
 * proven delivered.
 */
export async function pruneFileTombstonesUpTo(spaceId: string, upTo: string): Promise<number> {
  const res = await tombstonesOf(spaceId).deleteMany(asFilter<StoredFileTombstone>({
    ...PUBLISHED,
    $or: [{ positionAt: { $lte: upTo } }, { positionAt: { $exists: false }, deletedAt: { $lte: upTo } }],
  }));
  return res.deletedCount ?? 0;
}

/**
 * Does a held file tombstone SHADOW an arriving file — by VERSION for its metadata, by CONTENT for its bytes? Pure, over
 * the tombstones held for the arrival's path (Q-229).
 *
 * A tombstone is a statement about a version of a path, not about the path for ever:
 *  - **metadata** is shadowed when some held tombstone has `rowSeq >= seq`: the arrival is the version the deletion
 *    erased, or older. A higher seq is a newer version and passes. A tombstone with no `rowSeq` (written before versions
 *    travelled) shadows no metadata, which is how it behaved and the stated limit of the release. And only a tombstone
 *    that speaks against this version's author and deliverer shadows it — the record rule, `heldTombstoneRefuses`: one
 *    another instance issued does not refuse the version its proven author delivers, and one stored for an upstream
 *    does not refuse that upstream's later version. Without it a peer could store a deletion of a path nobody held, at
 *    a high version, and refuse every later file at that path.
 *  - **bytes** are shadowed when some held tombstone's own `contentHash` equals the arriving hash and no live row at the
 *    path is newer than it (`liveRowNewer`: identical bytes re-created as a newer version arrive with their metadata
 *    first and pass). A tombstone with no hash shadows no bytes.
 *
 * What it prevents: without the version half a deleted file's path is poisoned for ever, every later upload of it
 * refused; without the content half a peer's still-live copy of the deleted bytes comes back on every cycle.
 */
export function shadowDecision(
  held: ReadonlyArray<{ rowSeq?: number; contentHash?: string; issuer?: string; storedVia?: string }>,
  arrival: MetaArrival | { kind: 'bytes'; sha256: string; liveRowNewer: boolean },
): boolean {
  if (arrival.kind === 'meta') {
    return held.some(t => typeof t.rowSeq === 'number' && t.rowSeq >= arrival.seq
      && heldTombstoneRefuses(t, arrival.author, arrival.deliveredBy));
  }
  if (arrival.liveRowNewer) return false;
  return held.some(t => typeof t.contentHash === 'string' && t.contentHash !== '' && t.contentHash === arrival.sha256);
}

/**
 * An arriving version of a file's metadata: its seq, who wrote it and the peer the door PROVES delivered it. Without a
 * deliverer (a local or admin write, the stray drain) every held tombstone at or above the version shadows it.
 */
export interface MetaArrival { kind: 'meta'; seq: number; author?: string; deliveredBy?: string }

/** One arrival to ask {@link shadowedArrivals} about: its id, its path, and what it is — metadata at a version, or bytes with a hash. */
export type FileArrival = { id: string; path: string } & (MetaArrival | { kind: 'bytes'; sha256: string });

/**
 * Which of `arrivals` a held tombstone shadows — THE predicate every arrival site asks (the metadata writer, the stray
 * drain's fill, the manifest pull, the byte door), one chunked read of the held tombstones by path for all of them, then
 * {@link shadowDecision} per arrival. Returns the ids.
 *
 * For BYTES it also reads whether a LIVE row at the path is newer than the tombstone (`liveRowNewer`): identical bytes
 * re-created as a newer version arrive with their metadata first, and pass. That read happens only for an arrival some
 * held tombstone could shadow by content, so a path nobody deleted costs no more than the tombstone read.
 */
export async function shadowedArrivals(spaceId: string, arrivals: readonly FileArrival[]): Promise<Set<string>> {
  if (arrivals.length === 0) return new Set();
  return shadowedAgainst(spaceId, await heldFileTombstones(spaceId, arrivals.map(a => a.path)), arrivals);
}

/**
 * Whether a PEER's bytes for `path` are shadowed — the byte door's question, which asks by path FIRST: the hash of the bytes
 * (`sha256Of`, called only when needed) is computed only when some held tombstone for the path carries a content hash to
 * compare it with, so a path nobody deleted — nearly every upload — costs one indexed read and no hashing of the body.
 */
export async function bytesShadowed(spaceId: string, path: string, sha256Of: () => string): Promise<boolean> {
  const held = await heldFileTombstones(spaceId, [path]);
  if (!(held.get(path) ?? []).some(t => typeof t.contentHash === 'string' && t.contentHash !== '')) return false;
  return (await shadowedAgainst(spaceId, held, [{ id: path, path, kind: 'bytes', sha256: sha256Of() }])).has(path);
}

/** {@link shadowedArrivals} over tombstones already read: the decision per arrival, and the live-row read bytes need. */
async function shadowedAgainst(
  spaceId: string, held: ReadonlyMap<string, HeldFileTombstone[]>, arrivals: readonly FileArrival[],
): Promise<Set<string>> {
  const shadowed = new Set<string>();
  const needRows = arrivals.filter(a => a.kind === 'bytes' && (held.get(a.path) ?? []).some(t => t.contentHash === a.sha256));
  const live = needRows.length === 0 ? new Map<string, { seq?: number; deletedAt?: string }>()
    : await readStoredById<{ seq?: number; deletedAt?: string }>(spaceCollection(spaceId, 'files'), needRows.map(a => a.path), { seq: 1, deletedAt: 1 });
  for (const a of arrivals) {
    const here = held.get(a.path) ?? [];
    if (here.length === 0) continue;
    if (a.kind === 'meta') {
      if (shadowDecision(here, a)) shadowed.add(a.id);
      continue;
    }
    const row = live.get(a.path);
    const erased = Math.max(-1, ...here.map(t => t.rowSeq ?? -1));
    const liveRowNewer = row !== undefined && row.deletedAt === undefined && typeof row.seq === 'number' && row.seq > erased;
    if (shadowDecision(here, { kind: 'bytes', sha256: a.sha256, liveRowNewer })) shadowed.add(a.id);
  }
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
 * ADMITTED, one bulk write for the page.
 */
export async function storeRelayedFileTombstones(spaceId: string, docs: readonly RelayedFileTombstone[]): Promise<void> {
  if (docs.length === 0) return;
  const receivedAt = new Date().toISOString();
  const ops = docs.map(d => ({ updateOne: {
    filter: asFilter<StoredFileTombstone>({ _id: d._id }),
    update: asUpdate<StoredFileTombstone>({ $setOnInsert: {
      _id: d._id, spaceId, path: d.path, deletedAt: d.deletedAt, positionAt: receivedAt,
      ...(d.issuer !== undefined ? { issuer: d.issuer } : {}),
      ...(d.rowSeq !== undefined ? { rowSeq: d.rowSeq } : {}),
      ...(d.contentHash !== undefined ? { contentHash: d.contentHash } : {}),
      ...(d.storedVia !== undefined ? { storedVia: d.storedVia } : {}),
    } }),
    upsert: true,
  } }));
  await writeInOneCommands(ops, (slice, { ordered }) => tombstonesOf(spaceId).bulkWrite(asBulk<StoredFileTombstone>(slice), { ordered }),
    { ordered: false, commandKindOf: bulkCommandOf });
}
