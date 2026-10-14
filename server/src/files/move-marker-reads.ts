/**
 * What a begun move's marker lets a reader find out from the disk and the records: whether the bytes have moved, whether something of the
 * file is still at its source, and what became of the path of a move's pending tombstone.
 *
 * ## The question it answers
 *
 * *"A move wrote a marker `from` to `to` and may have stopped anywhere: where is it?"* The reads here are the ones `files/tombstones.ts` (the
 * one module that opens the tombstone collection) asks of everything that is not a tombstone: the disk's `lstat`s and the file records, links
 * and jobs at the source. They live apart from it because none of them opens that collection, and because a module that holds every
 * rule about a tombstone and every rule about a move's bytes is a module nobody can read in one sitting.
 *
 * ## The part a hand-written copy drops: one entry under two spellings
 *
 * On a case-insensitive file system `a.txt` and `A.txt` are one directory entry, so "do bytes answer at the old spelling" says yes whether a
 * case-only rename happened or not. {@link whatBecameOfPath} is the one answer to what a move's pending tombstone means, and for such a pair
 * it asks what the entry is CALLED ({@link pairOnDisk}): still by the old spelling, the rename did not happen and the act did not remove the
 * path; by the new one, the rename happened, and the MOVE says the rest — its records have left the old id (published), or they have not
 * (owed). So a failed rename publishes nothing and is not owed, a stopped one is owed and publishes once finished. The pair is read through
 * {@link pairOnDisk}, the one place that reads the disk for it, which a test replaces (`setPairReaderForTest`): a case-sensitive runner cannot
 * be one entry under two spellings, and the rule is held there all the same.
 */
import type { BigIntStats } from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { col, asFilter } from '../db/mongo.js';
import { spaceCollection } from '../db/space-collection.js';
import { linksStartingFrom, aFileUnderHoldsALink } from '../brain/link-adjacency.js';
import { bytesPresentAt, classifyDestination, destinationStateAt, isOneNameUnderTwoSpellings, lstatIfPresent } from './stored-bytes.js';
import { resolveSafePathChecked } from './sandbox.js';
import { hasLiveFileRecordAt } from './file-meta.js';
import { jobIdClausesOf, kindAt, movedId, movedRoot, type PathKind } from './moved-paths.js';

/** The two paths a move names. */
export interface MovePair { from: string; to: string }

/** The bytes at a move's destination, as a marker's identity is compared with them: the size and the mtime of the entry, and whether it is a directory. */
export interface MovedBytes { isDirectory: boolean; size: number; mtimeMs: number }

/** The identity of a stat: what a move's marker records (`bytesIdentityAt`) and what is compared with it ({@link isTheMovedBytes}), read the one way. */
const viewOf = (st: BigIntStats): MovedBytes => ({ isDirectory: st.isDirectory(), size: Number(st.size), mtimeMs: Number(st.mtimeNs) / 1e6 });

/** What is at `rel` on the disk, exactly (`bigint`), or `null` when the path does not exist — the one failure read as an answer; any other is thrown, as {@link bytesPresentAt} throws it. */
async function lstatAt(spaceId: string, rel: string): Promise<BigIntStats | null> {
  return lstatIfPresent(await resolveSafePathChecked(spaceId, rel), { bigint: true });
}

/**
 * What the bytes at `rel` are, as a move's marker records them: their size and mtime on the disk (`lstat`, so nothing is read and
 * nothing is decrypted: a rename keeps both). `undefined` when nothing is there or what is there is a directory — a directory's
 * size and mtime move with every child, so a directory move records none and is judged on the rest. A path that cannot be looked
 * at is thrown, never read as "nothing".
 */
export async function bytesIdentityAt(spaceId: string, rel: string): Promise<{ size: number; mtimeMs: number } | undefined> {
  const st = await lstatAt(spaceId, rel);
  if (st === null || st.isDirectory()) return undefined;
  const { size, mtimeMs } = viewOf(st);
  return { size, mtimeMs };
}

/**
 * Whether the bytes at a move's destination are the ones the marker recorded: a file of the recorded size and mtime, within the millisecond
 * a marker written by an earlier build rounded to. A marker that recorded neither (a directory move, or one written before they were) judges
 * nothing here, and the caller judges it on the other facts.
 */
export function isTheMovedBytes(atTo: MovedBytes, marker: { size?: number; mtimeMs?: number }): boolean {
  if (marker.size === undefined || marker.mtimeMs === undefined) return true;
  return !atTo.isDirectory && atTo.size === marker.size && Math.abs(atTo.mtimeMs - marker.mtimeMs) < 1;
}

/**
 * What is at a begun move's destination when its bytes HAVE moved — bytes at `to` and none at `from`, or at both only as the move's own
 * HALF-MADE LINK (the same inode, two names, and this marker: `classifyDestination`, the one decision the step that placed them asks) or as
 * one entry that has taken the new spelling (a case-only rename, {@link pairOnDisk}) — or `null` when they have not. The one spelling of "the
 * bytes have moved", asked by `moveIsOwed` (which then judges whether they are the moved ones) and by `abandonMove`. A path that cannot be
 * looked at is thrown, as {@link bytesPresentAt} throws it.
 *
 * **A marked half-link counts as moved**, so every remover of a marker keeps the marker of a move whose last step was an unlink that did
 * not happen, and housekeeping can finish it. **So does a renamed entry**: its old spelling still answers, and what says the move is
 * unfinished is a record still at the old id (`somethingOfTheFileIsAt`), not the bytes.
 */
export async function movedBytesOf(spaceId: string, marker: MovePair): Promise<MovedBytes | null> {
  const atFrom = await lstatAt(spaceId, marker.from);
  const atTo = await lstatAt(spaceId, marker.to);
  if (atTo === null) return null;
  if (atFrom === null) return viewOf(atTo);
  if (classifyDestination(atFrom, atTo, { begun: true, names: { src: marker.from, dst: marker.to } }) === 'half-linked') return viewOf(atTo);
  return await pairOnDisk(spaceId, marker.from, marker.to) === 'one-entry-new-spelling' ? viewOf(atTo) : null;
}

/** Whether a live record, a link row or a job of the file (or, for a directory, of anything under it) is still at `at`. */
export async function somethingOfTheFileIsAt(spaceId: string, at: string, kind: PathKind): Promise<boolean> {
  const root = movedRoot(at);
  if (!root) return false;
  if (await hasLiveFileRecordAt(spaceId, root)) return true;
  const linked = kind === 'file'
    ? (await linksStartingFrom(spaceId, [root], 1)).length > 0
    : await aFileUnderHoldsALink(spaceId, root);
  if (linked) return true;
  return (await col(spaceCollection(spaceId, 'mediaJobs')).findOne(asFilter({ $or: jobIdClausesOf(root, kind) }), { projection: { _id: 1 } })) !== null;
}

/**
 * What two paths of a move are on the disk: `apart` (two entries, or one that is not there), or ONE directory entry under two spellings
 * — `one-entry-old-spelling` while the entry is still called what the source says, `one-entry-new-spelling` once the rename that gives
 * it the destination's name has happened.
 */
export type PairOnDisk = 'apart' | 'one-entry-old-spelling' | 'one-entry-new-spelling';

/** How a pair is read off the disk. */
export type PairReader = (spaceId: string, from: string, to: string) => Promise<PairOnDisk>;

/**
 * The pair as the disk says it: the one decision of "one entry" (`classifyDestination`, asked as a move that has begun), and for one entry
 * the name the entry really has (`realpath` gives the spelling on a case-insensitive file system). When the last component is the same in both
 * spellings only a directory above it differs in case, no rename of the entry exists, and it counts as renamed: there is nothing to wait for.
 */
const readPairFromDisk: PairReader = async (spaceId, from, to) => {
  const [srcAbs, dstAbs] = [await resolveSafePathChecked(spaceId, from), await resolveSafePathChecked(spaceId, to)];
  if (await destinationStateAt(srcAbs, dstAbs, { begun: true }) !== 'alias') return 'apart';
  if (path.basename(srcAbs) === path.basename(dstAbs)) return 'one-entry-new-spelling';
  return path.basename(await fsp.realpath(srcAbs)) === path.basename(dstAbs) ? 'one-entry-new-spelling' : 'one-entry-old-spelling';
};

let pairReader: PairReader = readPairFromDisk;

/** Replace how a pair is read off the disk, or `null` to restore the disk. A case-sensitive runner has no entry under two spellings to read; the rules are held through this. Never called by the server. */
export function setPairReaderForTest(reader: PairReader | null): void {
  pairReader = reader ?? readPairFromDisk;
}

/** What `from` and `to` are on the disk: see {@link PairOnDisk}. The one place the question is read (`setPairReaderForTest`). */
export function pairOnDisk(spaceId: string, from: string, to: string): Promise<PairOnDisk> {
  return pairReader(spaceId, from, to);
}

/** What the act that wrote a pending tombstone did to its path. `owed`: for now nothing says, and the tombstone stays pending. */
export type PathAfterAct = 'gone' | 'here' | 'owed';

/**
 * What a move's pending tombstone means: THE rule of the settle, one copy for the act's own and the stale sweep's.
 *
 *  - no bytes answer at the path: `gone`, the act removed it;
 *  - bytes answer, and the path is the old id of a move to the SAME ENTRY under another spelling (a case-only rename, in any path component):
 *    the old spelling answers whatever the move did, so the entry's own name says. Still the old spelling: the rename did not happen, the
 *    path is `here` and the tombstone is dropped. The new one: the MOVE says — nothing of the file is at its source any more
 *    (`somethingOfTheFileIsAt`: no live record, link row or job), so its records were carried and the old id is `gone`; something is, so the
 *    records have not followed and the path is `owed`: neither published, which tells a peer a LIVE file is gone, nor dropped, which loses the
 *    tombstone the finished move will owe. The old spelling is a different id on a case-sensitive peer, and it has to be told;
 *  - bytes answer anywhere else: `here`, the act did not remove the path.
 *
 * The pair is read only for names that are one name under case folding, which a move to another name never is.
 */
export async function whatBecameOfPath(spaceId: string, row: { path: string; move?: MovePair | undefined }): Promise<PathAfterAct> {
  if (!(await bytesPresentAt(spaceId, row.path))) return 'gone';
  const to = row.move ? movedId(row.path, row.move.from, row.move.to) : null;
  if (!row.move || to === null || to === row.path || !isOneNameUnderTwoSpellings(row.path, to)) return 'here';
  if (await pairOnDisk(spaceId, row.path, to) !== 'one-entry-new-spelling') return 'here';
  return (await somethingOfTheFileIsAt(spaceId, row.move.from, await kindAt(spaceId, row.move.to))) ? 'owed' : 'gone';
}
