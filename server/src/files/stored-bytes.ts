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
 * - **Large files stream** ({@link pipeToStored}, {@link openStoredRead}): uploads reach gigabytes, beyond what
 *   a Buffer holds.
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
  resolveMasterSecret, deriveKey, resetChunkedKeyCache, encryptChunked, decryptChunked, isChunkedEnvelope,
  chunkedHeaderLength, chunkedPlaintextSizeFor, createChunkedEncryptor, createChunkedDecryptor, checkChunkedKey,
  ChunkedEnvelopeError, CHUNKED_MAX_HEADER_BYTES, type DerivedKey, type MasterSecret,
} from '../config/secretbox.js';
import { getDataRoot } from '../config/loader.js';
import { FILE_MODE, harden, mkdirPrivate } from '../util/fs-modes.js';
import { keyedLock } from '../util/keyed-lock.js';
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

const pathLocks = keyedLock();

/**
 * Run `fn` while no other writer in this process holds `abs`. Writers, the sync pull and the migration job all
 * take it, so a rewrite in place can re-check the file under the lock and never clobber a newer write.
 */
export function withPathLock<T>(abs: string, fn: () => Promise<T>): Promise<T> {
  return pathLocks.run(path.resolve(abs), fn);
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

/** Stream plaintext from `source` into a stored file, a chunk at a time, whatever its size. Locks as {@link writeStored}. */
export async function pipeToStored(abs: string, source: Readable | AsyncIterable<Buffer>, opts: StoredWriteOptions = {}): Promise<void> {
  await withPathLock(abs, () => pipeUnlocked(abs, source, opts));
}

async function pipeUnlocked(abs: string, source: Readable | AsyncIterable<Buffer>, opts: StoredWriteOptions): Promise<void> {
  const secret = activeSecret();
  const tmp = await tmpPathFor(abs);
  try {
    const out = fs.createWriteStream(tmp, { mode: FILE_MODE });
    const src = source instanceof Readable ? source : Readable.from(source);
    if (secret) await pipeline(src, createChunkedEncryptor(writerKey(secret)), out);
    else await pipeline(src, out);
    const fh = await fsp.open(tmp, 'r+');
    try { await fh.sync(); } finally { await fh.close(); }
    await finishWrite(tmp, abs, opts);
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => undefined);
    throw err;
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
  try {
    await fsp.lstat(abs);
    return true;
  } catch (err) {
    if (isMissingPath(err)) return false;
    throw err;
  }
}

/**
 * {@link bytesPresent} for a SPACE-RELATIVE path: resolved inside the space's sandbox first, symlink escape included
 * (`resolveSafePathChecked`), then asked.
 *
 * ## What it prevents
 *
 * Five callers (the tombstone settle and its marker sweep, the arrival shadow's pending-act read, the conversion's lease-lost
 * clean-up, a move's existence checks) each wrote `bytesPresent(await resolveSafePathChecked(spaceId, p))` by hand, and the half a
 * copy drops is the resolve: an `abs` joined from a peer's text with `path.join` looks outside the space, or at a path the
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
 * path could be either and must not act on a tree as if it were one file — a file's delete, a peer's single-path
 * tombstone, a move's sidecar.
 */
export async function isStoredDirectory(abs: string): Promise<boolean> {
  const stat = await fsp.lstat(abs).catch((err: unknown) => { if (isMissingPath(err)) return null; throw err; });
  return stat !== null && stat.isDirectory();
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
 * Move a stored file under both paths' locks, taken in SORTED order rather than source-then-destination: two moves
 * crossing (A to B while B to A) would otherwise each hold one lock and wait for ever on the other.
 */
export async function moveStored(srcAbs: string, dstAbs: string): Promise<void> {
  const [first, second] = [path.resolve(srcAbs), path.resolve(dstAbs)].sort();
  const move = () => fsp.rename(srcAbs, dstAbs);
  await withPathLock(first, () => first === second ? move() : withPathLock(second, move));
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
    const hash = crypto.createHash('sha256');
    let plainSize = 0;
    const tap = new Transform({ transform(c: Buffer, _e, done) { hash.update(c); plainSize += c.length; done(null, c); } });
    const tmp = await tmpPathFor(abs);
    try {
      await pipeline(fs.createReadStream(abs), tap, createChunkedEncryptor(writerKey(secret)), fs.createWriteStream(tmp, { mode: FILE_MODE }));
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
      return { outcome: 'encrypted' as const, sha256: hash.digest('hex'), plainSize, onDiskSize: after.size, mtimeMs: after.mtimeMs };
    } catch (err) {
      await fsp.rm(tmp, { force: true }).catch(() => undefined);
      throw err;
    }
  });
}

/**
 * Remove temporary files a crash left behind. Only at boot, before anything writes: every temp file is renamed or
 * removed by the call that made it, so one that exists when no call is running is an orphan.
 */
export async function sweepStoredTmp(): Promise<number> {
  let names: string[];
  try { names = await fsp.readdir(storedTmpDir()); } catch { return 0; }
  let removed = 0;
  for (const n of names) {
    if (!n.endsWith('.tmp')) continue;
    await fsp.rm(path.join(storedTmpDir(), n), { force: true }).then(() => { removed++; }, () => undefined);
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
  const bytes = await fsp.readFile(abs);
  if (!isChunkedEnvelope(bytes)) return bytes;
  try { return decryptChunked(bytes, activeSecret()); } catch (err) { throw unreadable(abs, err); }
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
