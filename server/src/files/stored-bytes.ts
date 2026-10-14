/**
 * The one door to the bytes of a stored file: every read and write of `<DATA_ROOT>/files` and the upload staging
 * area goes through here (F-43).
 *
 * ## What it does
 *
 * With a master secret configured, a file is written as the chunked envelope from `config/secretbox.ts` and read
 * back as plaintext; without one, bytes go to disk exactly as given.
 *
 * Every reader DETECTS the format per file, strictly (a whole well-formed header), because a tree is mixed while
 * the background migration encrypts what was stored before the secret was set: a legacy plaintext file must keep
 * reading. A file in the format that does not decode is a {@link StoredFileUnreadable}, never garbage — and that
 * includes an instance with NO secret meeting one (a secret removed, a keyed tree restored onto a keyless host, a
 * rollback): serving it raw would hand users ciphertext, and the manifest would publish it to every peer as the
 * file's new version. The cost, documented: a user's own file that happens to be in this format is refused on a
 * keyless instance.
 *
 * ## The parts a hand-written copy would drop, which is why callers do not touch these files with `fs`
 *
 * - **Temporary files live outside the files tree** ({@link storedTmpDir}). The manifest, listings, quota and the
 *   offsite copy all walk the tree, so a temp file left there by a crash would be listed, counted, copied and
 *   pushed to peers as a real file.
 * - **One writer per path at a time** ({@link withPathLock}). The migration job rewrites files in place; without
 *   the lock it could rename an old ciphertext over a newer write, and sync would then publish the old version.
 * - **Large files stream** ({@link pipeToStored}, {@link stageStored}, {@link openStoredRead}): uploads reach gigabytes,
 *   beyond what a Buffer holds. A write is STAGED outside the path lock (a network body can take as long as its sender
 *   likes) and COMMITTED under it ({@link commitStaged}), after a re-check of what the caller decided on.
 * - **The size a caller sees is the plaintext size** ({@link statStored}), computed from the ciphertext length,
 *   so sizes stay what users uploaded and what peers compare.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';
import {
  resolveMasterSecret, deriveKey, resetChunkedKeyCache, encryptChunked, isChunkedEnvelope,
  chunkedHeaderLength, chunkedPlaintextSizeFor, createChunkedEncryptor, createChunkedDecryptor, checkChunkedKey,
  ChunkedEnvelopeError, CHUNKED_MAX_HEADER_BYTES, type DerivedKey, type MasterSecret,
} from '../config/secretbox.js';
import { getDataRoot } from '../config/loader.js';
import { FILE_MODE, harden, mkdirPrivate } from '../util/fs-modes.js';
import { keyedLock } from '../util/keyed-lock.js';
import { log, peerText } from '../util/log.js';
import { sha256Tap, type TapExpectation } from '../util/sha256-tap.js';
import { resolveSafePathChecked } from './sandbox.js';

/** A stored file that exists but cannot be read back: a foreign or missing key, or altered bytes. */
export class StoredFileUnreadable extends Error {
  readonly code: ChunkedEnvelopeError['code'];
  constructor(readonly filePath: string, cause: ChunkedEnvelopeError) {
    super(`${path.basename(filePath)} cannot be read: ${cause.message}`);
    this.name = 'StoredFileUnreadable';
    this.code = cause.code;
  }
}

// ── Keys ──────────────────────────────────────────────────────────────────────────────────────────────────────

let writer: { id: string; dk: DerivedKey } | null = null;
const idOf = (s: MasterSecret): string =>
  crypto.createHash('sha256').update(s.kind === 'key' ? s.key : Buffer.from(s.passphrase)).update(s.kind).digest('hex');

/** The secret in force now, or null. Read from the environment each time, as the state files do. */
export function activeSecret(): MasterSecret | null { return resolveMasterSecret(); }

/** The writer's key, derived ONCE per process and secret (a passphrase costs a scrypt). */
function writerKey(secret: MasterSecret): DerivedKey {
  const id = idOf(secret);
  if (!writer || writer.id !== id) writer = { id, dk: deriveKey(secret) };
  return writer.dk;
}

/** Forget every derived key. Tests switch secrets inside one process; production never needs this. */
export function resetStoredKeyCacheForTests(): void { writer = null; resetChunkedKeyCache(); }

// ── Paths and locks ───────────────────────────────────────────────────────────────────────────────────────────

/** Where temporary files are written before the rename: same filesystem as the tree, never inside it. */
export function storedTmpDir(): string { return path.join(getDataRoot(), '.stored-tmp'); }

/**
 * A private scratch DIRECTORY under {@link storedTmpDir}, named so {@link sweepStoredTmp} removes it after a crash.
 *
 * ## What it prevents, measured
 *
 * The media embedders used to make their own scratch with `mkdtemp(os.tmpdir()/ythril-audio-…)`, removed in a
 * `finally`. A `finally` does not run when the process is KILLED — and an out-of-memory kill is precisely this
 * ticket's trigger (`Q-425`). Driven on 2026-10-08: an encrypted audio job was wedged, the process SIGKILLed, and the
 * real boot sweep then ran. The decrypted copy survived, at `…/ythril-audio-SZvkBF/input.wav`, because it sat in
 * `os.tmpdir()` where nothing sweeps. **So an out-of-memory kill left a plaintext copy of an at-rest-encrypted
 * file on disk, indefinitely.**
 *
 * Here the disposer is still the normal path, and the boot sweep is what makes a kill survivable. The `.tmp` suffix
 * is not decoration: it is the one rule the sweep applies, so a directory named this way is covered by the same
 * sentence as a temp file and nobody has to remember a second one.
 */
export async function scratchDir(prefix: string): Promise<string> {
  const dir = path.join(storedTmpDir(), `${prefix}-${crypto.randomBytes(6).toString('hex')}.tmp`);
  await mkdirPrivate(dir);
  return dir;
}

const pathLocks = keyedLock();

/**
 * Run `fn` while no other writer in this process holds `abs`. Writers, the sync pull and the migration job all
 * take it, so a rewrite in place can re-check the file under the lock and never clobber a newer write.
 */
export function withPathLock<T>(abs: string, fn: () => Promise<T>): Promise<T> {
  return pathLocks.run(path.resolve(abs), fn);
}

/**
 * Run `fn` while no other writer in this process holds EITHER of two paths, taking the two locks in SORTED order — the one way a step that
 * works on a source and a destination takes them (`moveStored`, `moveStoredIfFree`, `finishInterruptedLink`).
 *
 * ## What it prevents
 *
 * Two moves that cross (A to B while B to A) each held the lock of the path they were given first and waited for ever on the other's. The
 * sort is what ends that, and it was written out in each step that took two locks: a fourth step written the same way would leave it out and
 * deadlock only when two moves happened to cross. The sort is here, so it is not the caller's to remember. Paths that resolve to one path take
 * its lock once (the lock is not re-entrant).
 */
function withPathLocks<T>(aAbs: string, bAbs: string, fn: () => Promise<T>): Promise<T> {
  const [first, second] = [path.resolve(aAbs), path.resolve(bAbs)].sort();
  return withPathLock(first, () => first === second ? fn() : withPathLock(second, fn));
}

async function tmpPathFor(abs: string): Promise<string> {
  const dir = storedTmpDir();
  await mkdirPrivate(dir);
  return path.join(dir, `${path.basename(abs)}.${crypto.randomBytes(6).toString('hex')}.tmp`);
}

/** Options every write takes. */
export interface StoredWriteOptions {
  /** Keep this modification time on the result (the migration keeps each file's own). */
  mtime?: Date;
  /** Do not create missing parent directories: a vanished directory means the file was deleted meanwhile. */
  noMkdir?: boolean;
}

async function finishWrite(tmp: string, abs: string, opts: StoredWriteOptions): Promise<void> {
  if (!opts.noMkdir) await mkdirPrivate(path.dirname(abs));
  if (opts.mtime) await fsp.utimes(tmp, opts.mtime, opts.mtime);
  await fsp.rename(tmp, abs);
  await harden(abs, FILE_MODE);
}

// ── Writes ────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Write a whole Buffer or string. Encrypted with a secret; as given without one.
 *
 * Takes the path lock ITSELF, and so does every write here: a lock that only some writers take protects nothing
 * against the ones that do not, and an upload landing between the migration's re-check and its rename would be
 * overwritten by the old bytes it had just encrypted. Do not wrap these calls in {@link withPathLock} — the lock is
 * not re-entrant, and a caller holding it would wait on itself.
 */
export async function writeStored(abs: string, data: Buffer | string, opts: StoredWriteOptions = {}): Promise<void> {
  await withPathLock(abs, () => writeUnlocked(abs, data, opts));
}

async function writeUnlocked(abs: string, data: Buffer | string, opts: StoredWriteOptions): Promise<void> {
  const plain = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  const secret = activeSecret();
  const bytes = secret ? encryptChunked(plain, writerKey(secret)) : plain;
  const tmp = await tmpPathFor(abs);
  try {
    const fh = await fsp.open(tmp, 'w', FILE_MODE);
    try { await fh.writeFile(bytes); await fh.sync(); } finally { await fh.close(); }
    await finishWrite(tmp, abs, opts);
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
}

/**
 * A stream written whole to a temporary file and NOT yet in the tree: what {@link stageStored} returns and
 * {@link commitStaged} renames. `sha256` and `size` are the PLAINTEXT's, taken by the tap the bytes passed through.
 *
 * Whoever holds one removes it, on every exit ({@link StagedStoredFile.discard}, idempotent, a no-op once committed): a staged
 * file that is neither committed nor discarded is a temp file nobody owns until the next boot sweeps it.
 */
export class StagedStoredFile {
  constructor(readonly sha256: string, readonly size: number, private readonly tmp: string) {}
  /** The temp file's path, for {@link commitStaged} only. */
  tmpPath(): string { return this.tmp; }
  /** Remove the temp file if it is still there (it is not once committed). */
  async discard(): Promise<void> { await fsp.rm(this.tmp, { force: true }).catch(() => undefined); }
}

/** What a stage is expected to carry, checked in the tap's `flush`: see {@link TapExpectation}. */
export interface StageOptions extends StoredWriteOptions {
  expect?: TapExpectation;
}

/**
 * Stream plaintext from `source` into a TEMPORARY file, hashing and counting it on the way, WITHOUT taking the path lock.
 *
 * ## Why it holds no lock
 *
 * A pull streams a peer's body for as long as the peer takes, and a lock held across a network read is a path nobody else can
 * write, delete or migrate for as long as a stranger chooses. Nothing here touches the tree: the temp file is private to this call
 * (`storedTmpDir`), so the lock is taken by {@link commitStaged}, for the rename alone.
 *
 * ## What it decides before it returns
 *
 * With `expect`, the tap fails the pipeline in its `flush` when the stream is not the size or the hash expected, and a stream past
 * its declared size is stopped as it passes it (`util/sha256-tap.ts`): the temp file is then removed and the error thrown, so a body
 * that does not verify has written nothing anywhere a reader looks. A source that fails midway is the same.
 */
export async function stageStored(abs: string, source: Readable | AsyncIterable<Buffer>, opts: StageOptions = {}): Promise<StagedStoredFile> {
  const secret = activeSecret();
  const tmp = await tmpPathFor(abs);
  try {
    const tap = sha256Tap(opts.expect);
    const out = fs.createWriteStream(tmp, { mode: FILE_MODE });
    const src = source instanceof Readable ? source : Readable.from(source);
    if (secret) await pipeline(src, tap, createChunkedEncryptor(writerKey(secret)), out);
    else await pipeline(src, tap, out);
    const fh = await fsp.open(tmp, 'r+');
    try { await fh.sync(); } finally { await fh.close(); }
    return new StagedStoredFile(tap.hex(), tap.size, tmp);
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
}

/**
 * Rename a staged file into the tree at `abs`, UNDER the path lock — and `false`, with the staged file still its holder's, when
 * `stillValid` (asked under that lock, immediately before the rename) says the write is no longer the one that was decided on.
 *
 * ## What the question is for
 *
 * The stage ran outside the lock, so the disk may have moved on since the caller decided what to do: a local edit landed over the file
 * a pull meant to replace, the path became a symlink out of the space, a file appeared where there was none. The caller states what
 * "still the write I decided on" means (as {@link encryptInPlace} re-checks inode, size and mtime before ITS rename) and this asks it
 * where no other writer can change the answer; a `false` is the caller's to act on (a pull writes the bytes as a conflict copy).
 * A `stillValid` that throws is a failure and nothing is renamed.
 */
export async function commitStaged(
  abs: string, staged: StagedStoredFile, opts: StoredWriteOptions & { stillValid?: () => Promise<boolean> } = {},
): Promise<boolean> {
  return withPathLock(abs, async () => {
    if (opts.stillValid && !await opts.stillValid()) return false;
    await finishWrite(staged.tmpPath(), abs, opts);
    return true;
  });
}

/**
 * Stream plaintext from `source` into a stored file, a chunk at a time, whatever its size: {@link stageStored}, then
 * {@link commitStaged}, the temp file removed on every exit. Returns the PLAINTEXT's sha256 and size, counted on the way.
 * With `expect`, a stream that is not what was expected stores nothing and throws a `StreamVerificationError`.
 */
export async function pipeToStored(
  abs: string, source: Readable | AsyncIterable<Buffer>, opts: StageOptions = {},
): Promise<{ sha256: string; size: number }> {
  const staged = await stageStored(abs, source, opts);
  try {
    await commitStaged(abs, staged, opts);
    return { sha256: staged.sha256, size: staged.size };
  } finally {
    await staged.discard();
  }
}

// ── Deletes and moves ─────────────────────────────────────────────────────────────────────────────────────────
//
// They take the path lock too. A lock only protects against the operations that take it, and a file deleted or
// moved while the migration rewrote it would otherwise come back at its old path when the rename landed — and the
// next sync would push the resurrected file to every peer.

/**
 * Whether anything is on disk at `abs` — the one answer to "are the bytes here" (bundle-30 I15, preship-3 P3-6).
 *
 * **Only "the path does not exist" is `false`; any other failure to look is thrown.** A cascade acts on this answer:
 * a move whose source reads as absent takes its completion path, which re-roots the destination's derived records,
 * and a delete whose file reads as absent completes an orphan. So a permission refused, or a path the filesystem
 * will not look at, must reach the caller as the failure it is. Two copies of this question answered it two ways,
 * one of them swallowing every error into `false`; `are-the-bytes-here-has-one-answer.test.js` holds the rest of
 * the tree to this one.
 */
export async function bytesPresent(abs: string): Promise<boolean> {
  return (await lstatIfPresent(abs)) !== null;
}

/**
 * {@link bytesPresent} for a SPACE-RELATIVE path: resolved inside the space's sandbox first, symlink escape included
 * (`resolveSafePathChecked`), then asked.
 *
 * ## What it prevents
 *
 * Every caller that asks "are the bytes here" for a path it was handed wrote `bytesPresent(await resolveSafePathChecked(spaceId, p))`
 * by hand, and the half a copy drops is the resolve: an `abs` joined from a peer's text with `path.join` looks outside the space, or at a path the
 * sandbox would have refused. A path outside the sandbox is the caller's `RangeError`; a failure to look is thrown, on the terms
 * of {@link bytesPresent}.
 */
export async function bytesPresentAt(spaceId: string, relPath: string): Promise<boolean> {
  return bytesPresent(await resolveSafePathChecked(spaceId, relPath));
}

/**
 * Whether a filesystem failure says the path does not exist — the one failure {@link bytesPresent} reads as an answer,
 * and the one place a failure's code is read that way (`are-the-bytes-here-has-one-answer.test.js`).
 *
 * `ENOTDIR` too: a path THROUGH a regular file (`a.txt/x`) names nothing. Linux, the deployment, says `ENOTDIR` for
 * it where Windows says `ENOENT`, so an ENOENT-only test passed every Windows run and on Linux threw the condition as
 * "cannot look" — a move answering `400` with the absolute data path, and the settle leaving such a tombstone pending
 * for ever (bundle-30 I16, preship-4 P4-1).
 */
export const isMissingPath = (err: unknown): boolean => {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
};

/**
 * Whether what is at `abs` is a DIRECTORY: `false` for a regular file and for a path that does not exist, and any other
 * failure to look is thrown (the same terms as {@link bytesPresent}). The one answer to "is this a tree", for a caller whose
 * path could be either and must not act on a tree as if it were one file.
 */
export async function isStoredDirectory(abs: string): Promise<boolean> {
  const stat = await lstatIfPresent(abs);
  return stat !== null && stat.isDirectory();
}

/**
 * What is at `abs` on the disk (`lstat`: nothing is followed, read or decrypted), or `null` when the path does not exist — the one failure
 * read as an answer ({@link isMissingPath}); any other is thrown, on the terms of {@link bytesPresent}. For a caller that needs more than
 * whether something is there: its kind (`isStoredDirectory`) or its size and mtime (a move's marker).
 */
export async function lstatIfPresent(abs: string): Promise<fs.Stats | null>;
/** The same read with exact inode and device numbers (`bigint`): what a move needs to tell one directory entry under two spellings from two entries. */
export async function lstatIfPresent(abs: string, opts: { bigint: true }): Promise<fs.BigIntStats | null>;
export async function lstatIfPresent(abs: string, opts?: { bigint: true }): Promise<fs.Stats | fs.BigIntStats | null> {
  return (opts ? fsp.lstat(abs, opts) : fsp.lstat(abs)).catch((err: unknown) => { if (isMissingPath(err)) return null; throw err; });
}

/** Delete a stored file under its path lock. */
export async function deleteStored(abs: string): Promise<void> {
  await withPathLock(abs, () => fsp.unlink(abs));
}

/**
 * Delete a stored file if it is there: a path that is already gone is an answer (`isMissingPath`, which also reads a path
 * through a regular file as gone), and anything else — a permission refused, a store that will not answer — is the caller's
 * failure.
 *
 * ## What it prevents
 *
 * Four deleters wrote `deleteStored(abs).catch(err => { if (!isMissingPath(err)) throw err; })` by hand, and the half a copy
 * drops is the `if`: a bare `catch {}` answers a permission failure as "already gone", and the row then goes while the bytes
 * stay. The tolerance is here so it cannot be written wider.
 *
 * `skipDirectory` is for a caller whose path came from a peer and means ONE file: a directory there is left alone and is not
 * an error, because an unlink of one fails anyway and a tree must never go with a single path's deletion.
 */
export async function deleteStoredIfPresent(abs: string, { skipDirectory = false }: { skipDirectory?: boolean } = {}): Promise<void> {
  if (skipDirectory && await isStoredDirectory(abs)) return;
  await deleteStored(abs).catch((err: unknown) => { if (!isMissingPath(err)) throw err; });
}

/**
 * Move a stored file under both paths' locks ({@link withPathLocks}).
 *
 * **It REPLACES whatever is at `dstAbs`** (a rename does), and that is the point of its one family of callers: a conflict resolution
 * that keeps the incoming copy means to overwrite the local one (`api/conflicts.ts`). A MOVE never replaces anything, so no path of
 * `moveFile` or the move cascade reaches this: they go through {@link moveStoredIfFree}.
 * `every-door-that-places-bytes-checks-its-destination` names every caller.
 */
export async function moveStored(srcAbs: string, dstAbs: string): Promise<void> {
  await withPathLocks(srcAbs, dstAbs, () => fsp.rename(srcAbs, dstAbs));
}

// ── A move that never replaces ───────────────────────────────────────────────────────────────────────────────────

/** What stands at a move's destination, relative to its source: see {@link classifyDestination}. */
export type DestinationState = 'free' | 'alias' | 'half-linked' | 'occupied';

/**
 * What {@link classifyDestination} reads of a path: the numbers `lstat(..., { bigint: true })` gives. `nlink` is optional because a file
 * system may not say, and a count that is not there is read as "cannot tell".
 */
export interface StatRecord {
  dev: bigint | number;
  ino: bigint | number;
  nlink?: bigint | number | undefined;
  isDirectory(): boolean;
}

/** The two names of a pair, in any one spelling of a path (absolute, or relative to the space): only their components are compared. */
export interface PairNames { src: string; dst: string }

/**
 * Whether two paths are ONE name under case folding: every component alike but for its case. THE test of "one directory entry under two
 * spellings" that does not need the disk, asked by {@link classifyDestination} and by the settle's choice of question for a move
 * (`files/move-marker-reads.ts`).
 */
export function isOneNameUnderTwoSpellings(a: string, b: string): boolean {
  const [x, y] = [path.resolve(a), path.resolve(b)];
  return x.toLowerCase() === y.toLowerCase() || x.toUpperCase() === y.toUpperCase();
}

/**
 * THE decision of what stands at a move's destination, relative to its source — pure, over what the file system says. Asked by the
 * pre-check of a move ({@link destinationStateAt}, through `files/destination.ts`), by the step that places the bytes under the locks
 * ({@link moveStoredIfFree}) and by the marker's reading of "the bytes have moved" (`files/move-marker-reads.ts`), so the three cannot
 * answer it three ways.
 *
 * ## What it prevents
 *
 * A move told "the destination exists" by its own half-made link refuses its own retry, and one told "the same inode, so it is mine"
 * unlinks a file that was never the move's. The two are told apart by evidence, and the answer fails CLOSED on every ambiguity,
 * because the wrong guess either overwrites somebody's file or deletes one.
 *
 *  - nothing at the destination: `free`;
 *  - another inode or device, or an inode the file system does not number (`0`): `occupied`;
 *  - the same inode, the two NAMES one name under case folding ({@link isOneNameUnderTwoSpellings}: a case-only rename in any path
 *    component, `Docs/a.txt` to `docs/a.txt`) AND the file system resolving both to ONE real spelling (`sameRealPath`, {@link realPathsAgree}),
 *    a file or a directory: ONE directory entry under two spellings, an `alias` — a rename, never an unlink. **The link count plays no part**:
 *    a converter holds a scratch hard link to a file while it works on it, so the entry has two links and is still the one file. A
 *    case-SENSITIVE host keeps each spelling, so two entries there that share an inode (an operator's `a.txt` and `A.txt`) are two entries,
 *    never an alias: a rename between them would do nothing and say it had worked;
 *  - the same inode under two entries is never an alias, whatever the names and whatever the file system numbers: a colliding or synthesised
 *    inode (a FUSE or network file system) must not read another file as the source. A FILE with two or more links and `begun` (a begun-move
 *    marker names this very pair) is the move's OWN link whose removal of the source name did not happen: `half-linked`. Anything else —
 *    no marker (somebody's hard link), one link, a link count that is not a number, a directory — is `occupied`.
 *
 * `begun` is the caller's reading of the marker, taken BEFORE the attempt writes its own: the attempt's own marker would otherwise
 * make every operator's link look like the move's. `names` and `sameRealPath` are not optional and not defaulted: a decision made without
 * them cannot tell an alias from a second entry, and the caller that drops them gets a refusal, not a guess.
 */
export function classifyDestination(
  src: StatRecord, dst: StatRecord | null, { begun, names, sameRealPath }: { begun: boolean; names: PairNames; sameRealPath: boolean },
): DestinationState {
  if (names === undefined || typeof sameRealPath !== 'boolean') throw new TypeError('classifyDestination is asked about a pair of paths: the two names and whether they resolve to one real path are required');
  if (dst === null) return 'free';
  if (dst.dev !== src.dev || dst.ino !== src.ino || src.ino === 0n || src.ino === 0) return 'occupied';
  const oneEntry = sameRealPath && isOneNameUnderTwoSpellings(names.src, names.dst);
  if (src.isDirectory()) return dst.isDirectory() && oneEntry ? 'alias' : 'occupied';
  if (dst.isDirectory()) return 'occupied';
  if (oneEntry) return 'alias';
  const links = src.nlink === undefined ? Number.NaN : Number(src.nlink);
  if (!Number.isFinite(links) || links < 2) return 'occupied';
  return begun ? 'half-linked' : 'occupied';
}

/**
 * Whether the file system resolves two paths to the same real path (`realpath`): on a case-insensitive host `a.txt` and `A.txt` are one
 * entry and both resolve to its real spelling; a case-sensitive one keeps each. A path that cannot be resolved (gone meanwhile) is not the
 * same, which fails closed.
 */
export async function realPathsAgree(aAbs: string, bAbs: string): Promise<boolean> {
  try {
    return await fsp.realpath(aAbs) === await fsp.realpath(bAbs);
  } catch (err) {
    if (isMissingPath(err)) return false;
    throw err;
  }
}

/** {@link classifyDestination} for two paths on the disk, and whether the source is a directory. A source that is gone is `occupied`: nothing can be said of it. */
async function readDestination(srcAbs: string, dstAbs: string, begun: boolean): Promise<{ state: DestinationState; srcIsDirectory: boolean }> {
  const dst = await lstatIfPresent(dstAbs, { bigint: true });
  const src = await lstatIfPresent(srcAbs, { bigint: true });
  if (src === null) return { state: dst === null ? 'free' : 'occupied', srcIsDirectory: false };
  const sameRealPath = dst !== null && await realPathsAgree(srcAbs, dstAbs);
  return { state: classifyDestination(src, dst, { begun, names: { src: srcAbs, dst: dstAbs }, sameRealPath }), srcIsDirectory: src.isDirectory() };
}

/** What stands at `dstAbs` for a move of `srcAbs` ({@link classifyDestination}), read from the disk. Any failure to look other than "not there" is thrown. */
export async function destinationStateAt(srcAbs: string, dstAbs: string, { begun }: { begun: boolean }): Promise<DestinationState> {
  return (await readDestination(srcAbs, dstAbs, begun)).state;
}

/** The step that places a move's bytes found something at the destination: the move is refused, the foreign entry untouched. Never leaves the files layer: `moveFile` answers it as `DestinationExists`. */
export class DestinationOccupied extends Error {
  override readonly name = 'DestinationOccupied';
}

/**
 * The file-system steps of a move, replaceable by a test and by nothing else: a foreign write cannot be timed to land between the check
 * and the placing of the bytes from outside, and a file system that refuses a hard link or fails one unlink is not available on request.
 * `beforeLink` runs under the locks after the destination was classified free and before the bytes are placed (for a directory, before
 * its rename). `null` restores the real steps. Never called by the server.
 */
export interface MoveSteps {
  link: (srcAbs: string, dstAbs: string) => Promise<void>;
  unlink: (abs: string) => Promise<void>;
  rename: (srcAbs: string, dstAbs: string) => Promise<void>;
  beforeLink: ((srcAbs: string, dstAbs: string) => void | Promise<void>) | undefined;
}

// Through the module object at call time, so a test that replaces `fsp.rename` (the way a failing step is made) reaches a move as it reaches a write.
const REAL_MOVE_STEPS: MoveSteps = {
  link: (s, d) => fsp.link(s, d),
  unlink: (p) => fsp.unlink(p),
  rename: (s, d) => fsp.rename(s, d),
  beforeLink: undefined,
};
let moveSteps: MoveSteps = REAL_MOVE_STEPS;
export function setMoveStepsForTest(steps: Partial<MoveSteps> | null): void {
  moveSteps = steps === null ? REAL_MOVE_STEPS : { ...REAL_MOVE_STEPS, ...steps };
}

/** What a failed link or rename says about the NAME rather than about the file system: the kernel's refusal of an entry that is there. */
const NAME_TAKEN = new Set(['EEXIST', 'ENOTEMPTY', 'EISDIR']);
/** A file system that cannot make a hard link says one of these; the move then falls back to a rename (counted, and said once by its caller). */
const LINK_UNSUPPORTED = new Set(['EPERM', 'EACCES', 'ENOSYS', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV', 'EMLINK']);
const codeOf = (err: unknown): string | undefined => (err as NodeJS.ErrnoException | null)?.code;

/** Remove the source's name; that it is already gone is the move's success, not a failure. */
async function unlinkSourceName(srcAbs: string): Promise<void> {
  await moveSteps.unlink(srcAbs).catch((err: unknown) => { if (!isMissingPath(err)) throw err; });
}

/**
 * Move a stored file or directory to a path NOTHING stands at, under both paths' locks ({@link withPathLocks}), and refuse
 * with {@link DestinationOccupied} when anything does. THE step every move places its bytes by.
 *
 * ## What it prevents
 *
 * A rename replaces. Checked first by `lstat`, a destination that appears between the check and the rename was overwritten, and an
 * operator's file lost to a move that was never told it was there. So the classification ({@link classifyDestination}) is made
 * UNDER the locks, and the placing is a step the kernel refuses on an existing name:
 *
 *  - a FILE is placed by a hard link (`EEXIST` whoever wrote the name), and the source's name is removed after;
 *  - a DIRECTORY by a rename, which the kernel refuses for a non-empty directory and for a file.
 *
 * ## What each state does
 *
 *  - `occupied`: refused. `alias` (one entry, two spellings): renamed, never unlinked. `half-linked` (a link this move made, whose
 *    unlink did not happen): the source's name is removed, which finishes the move's bytes.
 *  - `free`: placed. A failure to remove the source's name after the link rolls the link BACK (the destination's name is removed) and
 *    throws that failure, so the move is wholly not done; the source having gone meanwhile (`ENOENT`) is a success.
 *
 * ## Where the guarantee ends
 *
 *  - On a file system that refuses a hard link the step falls back to a rename (`onLinkFallback`, so the caller counts it and says it
 *    once). The in-process guarantee holds (the classification under the locks); a foreign PROCESS writing at the destination between
 *    that read and the rename is overwritten.
 *  - A rollback that itself fails leaves two names for the file. Its pending records are dropped with the error, so the next attempt
 *    meets two names and no marker, reads an operator's link and refuses: loud in the log, resolved by removing one name.
 *  - A half-link whose names no longer share an inode on a retry is `occupied` (fail closed); housekeeping finishing a marked half-link
 *    at its next pass (`finishInterruptedLink`) is what keeps that window short.
 *  - On Windows a rename of a directory onto a directory that appeared in that instant is refused by the system with a permission code;
 *    the destination being there afterwards is what says it was the name.
 *  - A DIRECTORY is placed by a rename, which a POSIX kernel lets replace an EMPTY directory: one that appears at the destination in the
 *    instant of the rename, and is empty, is replaced. Nothing it held is lost, and a move that finds it non-empty is refused.
 */
export async function moveStoredIfFree(
  srcAbs: string, dstAbs: string, { begun, onLinkFallback }: { begun: boolean; onLinkFallback: (err: unknown) => void },
): Promise<void> {
  const run = async (): Promise<void> => {
    const { state, srcIsDirectory } = await readDestination(srcAbs, dstAbs, begun);
    if (state === 'occupied') throw new DestinationOccupied(`something stands at the destination of a move of ${path.basename(srcAbs)}`);
    if (state === 'half-linked') return unlinkSourceName(srcAbs);
    if (state === 'alias') return moveSteps.rename(srcAbs, dstAbs);
    await moveSteps.beforeLink?.(srcAbs, dstAbs);
    if (srcIsDirectory) return renameOntoNothing(srcAbs, dstAbs);
    try {
      await moveSteps.link(srcAbs, dstAbs);
    } catch (err) {
      const code = codeOf(err);
      if (code === undefined || !LINK_UNSUPPORTED.has(code)) {
        if (code !== undefined && NAME_TAKEN.has(code)) throw new DestinationOccupied(`something appeared at the destination of a move of ${path.basename(srcAbs)}`);
        throw err;
      }
      // A refused link is the file system's, unless the name is there now: then it is the name's.
      if (await lstatIfPresent(dstAbs) !== null) throw new DestinationOccupied(`something appeared at the destination of a move of ${path.basename(srcAbs)}`);
      onLinkFallback(err);
      return moveSteps.rename(srcAbs, dstAbs);
    }
    try {
      await unlinkSourceName(srcAbs);
    } catch (err) {
      await moveSteps.unlink(dstAbs).catch((rollback: unknown) => {
        log.warn(`A move of ${peerText(path.basename(srcAbs))} made a link and could not remove the source name, and the link could not be rolled back (${peerText(codeOf(rollback) ?? rollback)}): `
          + `the file has two names until one is removed. Source ${peerText(srcAbs)}, destination ${peerText(dstAbs)}`);
      });
      throw err;
    }
  };
  await withPathLocks(srcAbs, dstAbs, run);
}

/** Rename a directory to a name that was free when it was read: the kernel refusing it says something is there now. */
async function renameOntoNothing(srcAbs: string, dstAbs: string): Promise<void> {
  try {
    await moveSteps.rename(srcAbs, dstAbs);
  } catch (err) {
    const code = codeOf(err);
    if ((code !== undefined && NAME_TAKEN.has(code)) || ((code === 'EPERM' || code === 'EACCES') && await lstatIfPresent(dstAbs) !== null)) {
      throw new DestinationOccupied(`something appeared at the destination of a move of ${path.basename(srcAbs)}`);
    }
    throw err;
  }
}

/**
 * Finish the bytes of a move that a crash stopped between its link and the removal of the source's name: under both locks, when the
 * pair is a `half-linked` one (the same inode under two different names, two entries, and the begun-move marker the caller has read for
 * this very pair), remove the source's name. Anything else — no second name, a different file at the destination — is left alone.
 *
 * @returns whether it removed a name.
 */
export async function finishInterruptedLink(srcAbs: string, dstAbs: string): Promise<boolean> {
  return withPathLocks(srcAbs, dstAbs, async () => {
    if ((await destinationStateAt(srcAbs, dstAbs, { begun: true })) !== 'half-linked') return false;
    await unlinkSourceName(srcAbs);
    return true;
  });
}

// ── Encrypting a file that is already stored ──────────────────────────────────────────────────────────────────

/** What {@link encryptInPlace} found and did. `sha256`/`plainSize` describe the plaintext it encrypted. */
export type EncryptInPlaceResult =
  | { outcome: 'encrypted'; sha256: string; plainSize: number; onDiskSize: number; mtimeMs: number }
  | { outcome: 'already-encrypted' | 'no-secret' | 'vanished' | 'changed' };

/**
 * Rewrite a legacy plaintext file as ciphertext, in place, for the background migration.
 *
 * Here and not in the migration module because it is the one write that must happen UNDER a lock it already
 * holds: the file is re-checked (inode, size, mtime) after the new bytes are written and before the rename, and a
 * file that changed meanwhile is left for the writer that changed it — that write went through this door and is
 * encrypted already. The file's own mtime is kept, so sync does not read the migration as an edit; parents are
 * never created, so a file deleted meanwhile stays deleted.
 */
export async function encryptInPlace(abs: string): Promise<EncryptInPlaceResult> {
  const secret = activeSecret();
  if (!secret) return { outcome: 'no-secret' };
  return withPathLock(abs, async () => {
    let before: fs.Stats;
    let head: Buffer;
    try { ({ head, stat: before } = await peek(abs)); } catch (err) {
      if (isMissingPath(err)) return { outcome: 'vanished' as const };
      throw err;
    }
    if (isChunkedEnvelope(head, before.size)) return { outcome: 'already-encrypted' as const };
    const tap = sha256Tap();
    const tmp = await tmpPathFor(abs);
    try {
      await pipeline(fs.createReadStream(abs), tap, createChunkedEncryptor(writerKey(secret)), fs.createWriteStream(tmp, { mode: FILE_MODE }));
      const plainSize = tap.size;
      const fh = await fsp.open(tmp, 'r+');
      try { await fh.sync(); } finally { await fh.close(); }
      // Gone meanwhile is an answer; a failure to look is the caller's, as the peek above has it.
      const now = await fsp.stat(abs).catch((err: unknown) => { if (isMissingPath(err)) return null; throw err; });
      if (!now) { await fsp.rm(tmp, { force: true }); return { outcome: 'vanished' as const }; }
      if (now.ino !== before.ino || now.size !== before.size || now.mtimeMs !== before.mtimeMs || plainSize !== before.size) {
        await fsp.rm(tmp, { force: true });
        return { outcome: 'changed' as const };
      }
      await finishWrite(tmp, abs, { mtime: before.mtime, noMkdir: true });
      const after = await fsp.stat(abs);
      return { outcome: 'encrypted' as const, sha256: tap.hex(), plainSize, onDiskSize: after.size, mtimeMs: after.mtimeMs };
    } catch (err) {
      await fsp.rm(tmp, { force: true }).catch(() => undefined);
      throw err;
    }
  });
}

/**
 * Remove temporary files AND scratch directories a crash left behind. Only at boot, before anything writes: every
 * temp entry is renamed or removed by the call that made it, so one that exists when no call is running is an orphan.
 *
 * **One rule, both shapes.** An entry whose name ends `.tmp` is an orphan, whether it is a file awaiting its rename
 * or a {@link scratchDir} a killed media job left behind. It used to remove files only, which is why a decrypted copy
 * of an encrypted file could outlive the process that made it — see {@link scratchDir} for the drive that showed it.
 * `recursive` is what makes the directory case work; `force` keeps a racing cleanup from turning into a failure.
 */
export async function sweepStoredTmp(): Promise<number> {
  let names: string[];
  try { names = await fsp.readdir(storedTmpDir()); } catch { return 0; }
  let removed = 0;
  for (const n of names) {
    if (!n.endsWith('.tmp')) continue;
    await fsp.rm(path.join(storedTmpDir(), n), { force: true, recursive: true }).then(() => { removed++; }, () => undefined);
  }
  return removed;
}

/**
 * True when the temp directory and the files tree share a filesystem. A rename across filesystems fails (EXDEV),
 * so every write would fail — the operator mounted `files/` separately from the data root. Checked at boot so the
 * failure is one clear line instead of every upload erroring.
 */
export async function storedTmpSharesFilesystem(): Promise<boolean> {
  const filesRoot = path.join(getDataRoot(), 'files');
  await mkdirPrivate(storedTmpDir());
  try {
    const [a, b] = await Promise.all([fsp.stat(storedTmpDir()), fsp.stat(filesRoot)]);
    return a.dev === b.dev;
  } catch { return true; /* no files tree yet: it will be created under the data root */ }
}

// ── Reads ─────────────────────────────────────────────────────────────────────────────────────────────────────

async function peek(abs: string): Promise<{ head: Buffer; size: number; stat: fs.Stats }> {
  const fh = await fsp.open(abs, 'r');
  try {
    const stat = await fh.stat();
    const head = Buffer.alloc(Math.min(CHUNKED_MAX_HEADER_BYTES, stat.size));
    await fh.read(head, 0, head.length, 0);
    return { head, size: stat.size, stat };
  } finally { await fh.close(); }
}

/** True when `abs` is in the encrypted format, with or without a secret to read it. */
export async function isStoredEncrypted(abs: string): Promise<boolean> {
  const { head, size } = await peek(abs);
  return isChunkedEnvelope(head, size);
}

const unreadable = (abs: string, err: unknown): unknown =>
  err instanceof ChunkedEnvelopeError ? new StoredFileUnreadable(abs, err) : err;

/** Read a whole stored file as plaintext. Throws {@link StoredFileUnreadable} when it cannot be decoded. */
export async function readStored(abs: string): Promise<Buffer<ArrayBuffer>> {
  const { size, encrypted } = await statStored(abs);
  // Plaintext: the platform's own read is already one buffer of the file's size.
  if (!encrypted) return await fsp.readFile(abs);
  /*
   * ONE buffer, sized before the bytes arrive (`Q-425`). This used to read the whole ciphertext, decrypt it into an
   * array of chunks and concatenate them — three copies of the file for a function whose answer is one of them, which
   * is 2.40x measured on a 96 MiB file. Now the decryptor streams into a buffer the size the envelope promises.
   *
   * `alloc`, not `allocUnsafe`: a buffer sized from a stat can only be got wrong one way, by returning it when LESS
   * than its length was decrypted, and `allocUnsafe` would then hand the caller whatever the heap held. Zeros would
   * be a quieter version of the same lie, so the count is checked as well and a short or over-long decrypt is
   * `StoredFileUnreadable` — the same answer a flipped bit gets.
   */
  const out = Buffer.alloc(size);
  const stream = await openStoredRead(abs);
  let at = 0;
  try {
    for await (const chunk of stream) {
      const c = chunk as Buffer;
      if (at + c.length > size) throw new Error(`decrypted more than the ${size} byte(s) the envelope promised`);
      c.copy(out, at);
      at += c.length;
    }
  } catch (err) {
    stream.destroy();
    throw err instanceof StoredFileUnreadable ? err : unreadable(abs, err);
  }
  if (at !== size) throw unreadable(abs, new Error(`decrypted ${at} of the ${size} byte(s) the envelope promised`));
  return out;
}

/** A plaintext stream of a stored file, whatever its size. Errors with {@link StoredFileUnreadable}. */
export async function openStoredRead(abs: string): Promise<Readable> {
  const { head, size } = await peek(abs);
  const raw = fs.createReadStream(abs);
  if (!isChunkedEnvelope(head, size)) return raw;
  // A missing or foreign key refuses HERE, before the caller commits to a response; see `checkChunkedKey`.
  try { checkChunkedKey(head, activeSecret()); } catch (err) { raw.destroy(); throw unreadable(abs, err); }
  const dec = createChunkedDecryptor(activeSecret());
  const out = new Transform({ transform(c, _e, done) { done(null, c); } });
  raw.on('error', err => out.destroy(err));
  dec.on('error', err => out.destroy(unreadable(abs, err) as Error));
  return raw.pipe(dec).pipe(out);
}

/** What a caller needs from a stat: the PLAINTEXT size, the file's own mtime, and whether it is encrypted. */
export interface StoredStat { size: number; mtime: Date; mtimeMs: number; ino: number; encrypted: boolean; onDiskSize: number }

/** Stat a stored file, reporting its plaintext size. */
export async function statStored(abs: string): Promise<StoredStat> {
  const { head, size, stat } = await peek(abs);
  const encrypted = isChunkedEnvelope(head, size);
  return {
    size: encrypted ? chunkedPlaintextSizeFor(size, chunkedHeaderLength(head)) : size,
    mtime: stat.mtime, mtimeMs: stat.mtimeMs, ino: stat.ino, encrypted, onDiskSize: size,
  };
}
