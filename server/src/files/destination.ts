/**
 * Can a path be created in a space? The one answer, asked by every door that places bytes or a directory at a caller's path, and
 * by the move cascade the move doors share. Which doors those are is not listed here: `every-door-that-places-bytes-checks-its-destination`
 * derives them from the doors' own imports and holds each to this call.
 *
 * ## What it prevents
 *
 * Nothing looked at a destination's ancestors. A move, a `mkdir`, an upload or a `write_file` whose path runs THROUGH a regular
 * file (`a.txt/x` where `a.txt` is a file) reached the filesystem and failed there, and each door reported the failure in its own
 * words: REST a bare `500`, MCP a `400` carrying the raw message, which names the server's absolute data path. A directory moved
 * into itself failed the same way by another errno, after the move had published pending tombstones and held the queued jobs.
 * A refusal about the CALLER'S path is answered as one, before anything is written, with a name relative to the space
 * (`PathBlocked`, `files/act-answers.ts`).
 *
 * ## What it answers
 *
 * - {@link assertDestinationReachable}: may a file or directory be created at this path — does a regular file stand where a
 *   directory must be?
 * - {@link assertNotMovedIntoItself}: is this move onto itself, or into its own subtree? Decided on whole path segments, so `a`
 *   to `ab` is a move.
 * - {@link assertDestinationFree}: does anything already stand where a MOVE would put its file? A move never replaces anything.
 * - {@link assertNothingStandsAt}: does ANYTHING stand at this path in this space — bytes of any kind, or a live record? The
 *   destination-only question of a placing with no source in the same space (a conflict's incoming copy), in the words of a resolution.
 * - {@link fsRefusalOf}: what a failed filesystem call means for the caller, asked AFTER it failed: a refusal about the path the
 *   checks above could not see (a name held by a directory, a race), and any other failure, which becomes a fault in words that
 *   carry no path.
 *
 * What the first two do not ask is whether the NAME is taken by a file: an upload or a `write_file` onto an existing file replaces
 * it, and that is the guarantee those tools state. A move is the one act that never does.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { DestinationExists, FileSystemFault, PathBlocked, fileActAnswerOf } from './act-answers.js';
import { fileKeyOf, resolveSafePathChecked, spaceRoot } from './sandbox.js';
import { CONVERTED_ROOT, isAtOrUnder, kindAt, movedSidecars, sidecarsOwnedBy } from './moved-paths.js';
import { bytesPresentAt, destinationStateAt, isMissingPath, lstatIfPresent, type DestinationState } from './stored-bytes.js';
import { hasLiveFileRecordAt, hasLiveFileRecordExactlyAt } from './file-meta.js';
import { toDocId } from '../util/paths.js';

/**
 * Refuse a path a regular file stands in the way of: some ancestor of `relPath`, below the space root, is not a directory.
 *
 * The path is resolved through the sandbox first (`resolveSafePathChecked`), so a path that leaves the space, or a symlink that
 * does, is the sandbox's `RangeError` and not this module's refusal. Ancestors are then followed through symlinks and judged by
 * what they point at: a symlinked directory inside the space is a directory. The walk stops at the first ancestor that does not
 * exist, since nothing below it can be in the way.
 *
 * The name in the refusal is the blocker's, relative to the space and always a prefix of the requested path, so what a caller
 * learns is about the path it asked for and never about another part of the tree.
 *
 * @throws PathBlocked when an ancestor is not a directory.
 * @throws RangeError when the path leaves the space.
 */
export async function assertDestinationReachable(spaceId: string, relPath: string): Promise<void> {
  const abs = await resolveSafePathChecked(spaceId, relPath);
  const root = spaceRoot(spaceId);
  const segments = path.relative(root, abs).split(path.sep).filter(s => s !== '');
  let probe = root;
  // The last segment is the destination itself, which is not an ancestor of anything here.
  for (const segment of segments.slice(0, -1)) {
    probe = path.join(probe, segment);
    let found;
    try {
      found = await fs.stat(probe);
    } catch (err) {
      if (isMissingPath(err)) return;
      throw fsRefusalOf(err, [toDocId(path.relative(root, abs))]);
    }
    if (!found.isDirectory()) {
      const blocker = toDocId(path.relative(root, probe));
      throw new PathBlocked(blocker, `'${toDocId(path.relative(root, abs))}' cannot be created: '${blocker}' is a file, and a directory is needed there.`);
    }
  }
}

/**
 * Refuse a move that is onto itself or into its own subtree: `src` and `dst` are the same path, or `dst` lies under `src`.
 * Compared as keys of whole path segments (the key of a path is what its records are filed under), so `a` to `ab` is not
 * "under" and is allowed. Both are resolved lexically, without the disk.
 *
 * @throws PathBlocked naming `src` (the directory that would have to hold itself) or, for an identical pair, the path.
 * @throws RangeError when either path leaves the space or names the space itself.
 */
export function assertNotMovedIntoItself(spaceId: string, src: string, dst: string): void {
  const from = fileKeyOf(spaceId, src).key;
  const to = fileKeyOf(spaceId, dst).key;
  if (from === to) throw new PathBlocked(to, `'${from}' cannot be moved onto itself.`);
  if (isAtOrUnder(to, from)) throw new PathBlocked(from, `'${from}' cannot be moved into itself: '${to}' lies under it.`);
}

/**
 * What stands at `dst` for a move of `src` — `free`, `alias` (the same entry under another spelling), `half-linked` (this move's own
 * link, when `begun`) or `occupied` — read from the disk through the one decision (`classifyDestination`, `files/stored-bytes.ts`) that
 * the step placing the bytes asks again under the locks. Both paths are resolved through the sandbox first; a failure to look is the
 * one a door answers (`fsRefusalOf`), never the file system's own words, which name the data path.
 *
 * `begun` is whether a begun-move marker names this pair, read by the caller BEFORE it writes its own: this module does not import the
 * tombstones, which import it.
 */
export async function destinationStateOf(spaceId: string, src: string, dst: string, { begun }: { begun: boolean }): Promise<DestinationState> {
  const srcAbs = await resolveSafePathChecked(spaceId, src);
  const dstAbs = await resolveSafePathChecked(spaceId, dst);
  return destinationStateAt(srcAbs, dstAbs, { begun }).catch((err: unknown) => { throw fsRefusalOf(err, [src, dst]); });
}

/**
 * Refuse a move whose destination something stands at — before a tombstone is written, a job held or a byte moved — and say which of the
 * debris at it the move will remove.
 *
 * ## What it prevents
 *
 * A move REPLACED what stood at its destination: the bytes by the rename, the record by the re-key, the links by their convergence, and
 * nothing said so. A script that moved a file onto a name it believed free destroyed another file, and a replicated one: the loss
 * travelled to every instance the file was on.
 *
 * ## What an occupant is: only what a caller can NAME and REMOVE
 *
 * Each is removable by `delete_file` on the destination path, and the refusal says so (`DestinationExists`, `destination_exists`):
 *
 *  1. **Bytes** at `dst`: a file, or a directory (empty or not), of any kind. Not when the pair is an `alias` (a case-only rename) or the
 *     move's own `half-linked` pair — those are the move itself.
 *  2. **A live record** at `dst`, asked on its own and never only through the rows the move carries: a peer's file whose bytes have not
 *     arrived, or a record a delete stopped before it finished. For a file source, a record AT `dst`; for a directory, at or under it.
 *     (Not for an `alias`: that spelling names the source itself.)
 *  3. **A sidecar destination** a live thing stands at: the converted Markdown of a file goes to `_converted/<dst>.md`, which is also
 *     where the converted TREE of a directory `<dst>.md` stands. That directory, if it has bytes or a live record, is somebody's.
 *
 * (The live rows of ANOTHER file at an id the move would take are refused by the plan, `holdsAtDestination`, which reads the rows.)
 *
 * What derives from nothing live is not an occupant but DEBRIS, and the move removes it: a sidecar of a file that has neither bytes nor a
 * live record, a derived row whose parent is absent or flagged. This returns the sidecar destinations that hold only debris, decided by
 * the same read that decides what refuses, so the two cannot disagree; the move removes them before its bytes (`removeTree`), and the
 * rows in its transaction. **The cascade asks again under the hold of the file's jobs, immediately before it removes**: this answer is a
 * reading of one instant, and the hold can wait on a running conversion while a file appears at the destination.
 *
 * @throws DestinationExists (`standing`: `bytes`, `record` or `sidecar`), a `PathBlocked`/`FileSystemFault` for a path that cannot be looked at.
 * @returns the space-relative sidecar paths to remove before the bytes move.
 */
export async function assertDestinationFree(spaceId: string, src: string, dst: string, { begun }: { begun: boolean }): Promise<{ debris: string[] }> {
  const requested = toDocId(dst);
  const kind = await kindAt(spaceId, src);
  const state = await destinationStateOf(spaceId, src, dst, { begun });
  // An alias IS the source under another spelling, so a record at that spelling is the file's own (the repeat of a case-only rename that
  // already finished), or a second record of one file, which the plan refuses by its rows (`holdsAtDestination`).
  await assertNeitherBytesNorRecord(state, requested, 'move',
    () => kind === 'file' ? hasLiveFileRecordExactlyAt(spaceId, requested) : hasLiveFileRecordAt(spaceId, requested));

  const ownedAtDestination = new Set((await sidecarsOwnedBy(spaceId, dst, kind)).map(s => s.path));
  const debris: string[] = [];
  for (const { from, to } of await movedSidecars(spaceId, src, dst, kind)) {
    // Nothing to move, or a target that overlaps the sidecar being moved (removing it would remove the bytes about to move).
    if (!(await bytesPresentAt(spaceId, from)) || isAtOrUnder(to, from) || isAtOrUnder(from, to)) continue;
    const sidecarState = await destinationStateOf(spaceId, from, to, { begun });
    if (sidecarState === 'free' || sidecarState === 'alias') continue;
    if (!ownedAtDestination.has(to)) {
      // Not the destination's own sidecar: the one `sidecarsOwnedBy` leaves out is `_converted/<dst>.md` when a DIRECTORY stands there, the
      // converted tree of the directory `<dst>.md`, which is only debris when that directory is nothing.
      const directory = to.slice(CONVERTED_ROOT.length);
      if (await bytesPresentAt(spaceId, directory) || await hasLiveFileRecordAt(spaceId, directory)) throw new DestinationExists(requested, 'sidecar', to);
    }
    // The destination's own sidecar, whose owner has neither bytes nor a live record (checks 1 and 2), or the tree of a directory that is nothing.
    debris.push(to);
  }
  return { debris };
}

/**
 * Refuse a placing whose destination ANYTHING stands at — a file, a directory (empty or not), a link, or a live file record with no bytes —
 * in the space the bytes are going to. The destination-only question: it reads no source's space, so a placing across spaces asks it
 * of the space it will land in ({@link assertDestinationFree} resolves both paths in ONE space and reads a save to the same name in
 * another as an alias of the source, which passes).
 *
 * ## What it prevents
 *
 * A conflict resolution that put the incoming copy where the CALLER chose (`rename`, `targetSpaceId`) placed it by a rename, which replaced
 * whatever stood there: a file, a replicated one, whose loss travelled to every instance; in another space, for a token that held only the
 * data-quality area there. The bytes are looked at by `lstat` (a link standing there is a name taken, never followed) and the record
 * exactly at the destination is asked on its own (`hasLiveFileRecordExactlyAt`), never only through bytes: a peer's file whose content has
 * not arrived is an occupant too. It decides nothing about the PLACING: the step that puts the bytes down asks again under the locks
 * (`placeIfFree`, `files/files.ts`), because this is a reading of one instant.
 *
 * `placing` is the absolute path of the stored file about to be placed, when the caller holds evidence that a half-made link of its own
 * placing may be at the destination (a conflict resolution retried after a crash between the link and the removal of the source's name:
 * the open conflict record is the evidence). The same file under both names is the placing's own work to finish and not an occupant, and
 * `placeIfFree` finishes it. Without `placing`, nothing is exempt.
 *
 * @throws DestinationExists (`standing`: `bytes` or `record`), in a resolution's words, naming the destination as requested.
 * @throws RangeError when the path leaves the space; PathBlocked/FileSystemFault for a path that cannot be looked at.
 */
export async function assertNothingStandsAt(spaceId: string, dst: string, { placing }: { placing?: string } = {}): Promise<void> {
  const requested = toDocId(dst);
  const dstAbs = await resolveSafePathChecked(spaceId, dst);
  const state: DestinationState = placing === undefined
    ? ((await lstatIfPresent(dstAbs).catch((err: unknown) => { throw fsRefusalOf(err, [requested]); })) === null ? 'free' : 'occupied')
    : await destinationStateAt(placing, dstAbs, { begun: true }).catch((err: unknown) => { throw fsRefusalOf(err, [requested]); });
  // An alias is the placed file itself under another spelling of its name: its record, if any, is its own. A half-made link is not, so its
  // destination's record is asked like any other.
  await assertNeitherBytesNorRecord(state, requested, 'resolution', () => hasLiveFileRecordExactlyAt(spaceId, requested));
}

/**
 * The two steps every question about a destination ends in, written once: occupied bytes are `DestinationExists('bytes')`, and — unless the
 * state says the bytes are the source's own under another spelling (`alias`) — a live record exactly where the caller says is
 * `DestinationExists('record')`. `state` is what the disk said ({@link destinationStateOf} for a move, a placing's own read for a
 * resolution); `hasRecord` is the caller's reading of the record, because a move of a directory asks at or under the path and a file or a
 * placing asks exactly at it; `act` is whose sentence the refusal speaks (`DestinationExists`).
 *
 * ## What it prevents
 *
 * `assertDestinationFree` and `assertNothingStandsAt` each wrote the pair, and a copy that drops the `alias` exemption refuses the repeat of a
 * finished case-only rename, while one that drops the record step lets a peer's file whose bytes have not arrived be replaced. Each caller
 * keeps its own question (what to read, which sidecars to weigh); the verdict on what it read is here.
 */
async function assertNeitherBytesNorRecord(
  state: DestinationState, requested: string, act: 'move' | 'resolution', hasRecord: () => Promise<boolean>,
): Promise<void> {
  if (state === 'occupied') throw new DestinationExists(requested, 'bytes', undefined, act);
  if (state !== 'alias' && await hasRecord()) throw new DestinationExists(requested, 'record', undefined, act);
}

/**
 * Whether `err` is a destination refusal: the answer every door gives it says `path_blocked`. Asked through the answer rather than the
 * class, so a caller that must act on a refusal (an upload discarding what it staged) and the door that reports it cannot disagree
 * about which errors those are.
 */
export function isPathBlocked(err: unknown): err is PathBlocked {
  return fileActAnswerOf(err)?.body.code === 'path_blocked';
}

/** The filesystem's refusals that are about the CALLER'S path rather than about the server, each with what it means for the caller. */
const REFUSED_BY_THE_TREE: Readonly<Record<string, string>> = Object.freeze({
  EEXIST: 'a file stands where a directory is needed',
  ENOTDIR: 'a file stands where a directory is needed',
  EISDIR: 'a directory stands where a file is needed',
  ENOTEMPTY: 'a directory that is not empty stands there',
  EINVAL: 'a directory cannot be moved into itself',
  ENAMETOOLONG: 'the name is too long',
  ELOOP: 'the path loops through symbolic links',
});

/**
 * What a failed filesystem call (`mkdir`, `rename`, a write) means for the caller. `relPaths` are the space-relative paths the
 * act was given, the DESTINATION last.
 *
 * A code in the table is a {@link PathBlocked} naming the destination, built from `relPaths`. Every other failure,
 * whatever it is, becomes a {@link FileSystemFault} holding the original as its `cause` for the log: `err.message` of the
 * filesystem carries the server's absolute data path, and is never what a caller is told.
 */
export function fsRefusalOf(err: unknown, relPaths: readonly string[]): PathBlocked | FileSystemFault {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  const meaning = typeof code === 'string' && Object.hasOwn(REFUSED_BY_THE_TREE, code) ? REFUSED_BY_THE_TREE[code] : undefined;
  if (meaning === undefined) return new FileSystemFault(err);
  const destination = toDocId(relPaths.at(-1) ?? '');
  return new PathBlocked(destination, `'${destination}' cannot be created: ${meaning}.`);
}
