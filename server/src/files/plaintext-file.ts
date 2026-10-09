/**
 * A PATH a media job can open, holding the file's plaintext for as long as the job needs it — and nothing in memory
 * (`Q-425`).
 *
 * ## What it replaces
 *
 * A media job read its whole file into a `Buffer` and passed that around: ffmpeg was handed a copy written back to
 * disk, and the vision provider's body was built from it as base64 and again as JSON. A 64 MiB image cost about seven
 * times its own size, and the first bounded container to meet a large file killed the instance.
 *
 * Every consumer actually wants a PATH. ffmpeg needs random access — an mp4 with its `moov` atom at the end is not
 * readable from `pipe:0` — and sharp and the providers can stream from one. So the job opens one of these, hands
 * `path` on, and disposes it at the end.
 *
 * ## The two cases, and the snapshot is the half that is easy to miss
 *
 * **Not encrypted:** no copy of the bytes. A HARD LINK to the stored file is made inside the job's scratch directory,
 * and that is what the job opens. The link IS the snapshot: ffmpeg re-opens its input by path for the duration probe,
 * the silence pass, every segment extract and the keyframe pass, so a concurrent `encryptInPlace`, re-upload or move
 * would otherwise change the bytes under a job halfway through — later segments read as ciphertext under a silence map
 * made from the plaintext. A link costs an inode entry and no bytes. Where one cannot be made (a filesystem that
 * refuses links, or scratch on another device) the live path is used, said in a debug line rather than failing the
 * job: the race is rare, a refused job is not.
 *
 * **Encrypted:** one scratch file. `openStoredRead` streams through the decryptor into it — one pass, no buffer.
 *
 * ## Where the copy lives, and why that is not a detail
 *
 * Inside `scratchDir()`, whose name ends `.tmp` and which the boot sweep therefore removes. A `finally` does not run
 * when the process is KILLED, and an out-of-memory kill is this ticket's own trigger — so for an encrypted file the
 * sweep, not the disposer, is what keeps a PLAINTEXT copy of an at-rest-encrypted file from outliving the process that
 * made it. Private directory, `0o600` file.
 *
 * The plaintext keeps the stored file's EXTENSION inside that directory, because ffmpeg guesses a demuxer from it.
 *
 * ## What it does not decide
 *
 * Whether the file can be read at all: `openStoredRead` refuses a missing or foreign key with
 * `StoredFileUnreadable`, and that refusal is passed on unchanged. A second opinion here would be a second place to
 * decide what an unreadable file is.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { log } from '../util/log.js';
import { openStoredRead, statStored, scratchDir } from './stored-bytes.js';

/** A plaintext path, its size, and the undoing of whatever was made to provide it. */
export interface PlaintextFile {
  /** A path any reader can open for as long as this handle is held. */
  readonly path: string;
  /** The PLAINTEXT size, from the stat — never from reading the file. */
  readonly size: number;
  /** Whether `path` is a decrypted COPY (an encrypted source) rather than a link to the stored file. */
  readonly copied: boolean;
  /** Remove what was made. Idempotent, and never throws: a job must not fail on its own cleanup. */
  dispose(): Promise<void>;
}

/**
 * The whole content of a plaintext handle, for a consumer that genuinely needs the bytes — the document path, which
 * chunks the text.
 *
 * It lives HERE rather than at the caller because this module is the one place that knows `path` already holds the
 * plaintext: an unencrypted file is reached through a hard link to itself, and an encrypted one through a decrypted
 * copy. A raw `readFile` beside the files tree is the defect `stored-bytes-are-touched-only-through-the-door` exists to
 * catch — ciphertext read as content — and a reader of that line could not tell the two apart. Beside the handle it is
 * one line under the sentence that makes it true.
 *
 * ONE copy of the file, which is what a chunker needs; nothing else here reads whole.
 */
export async function readPlaintext(file: PlaintextFile): Promise<Buffer> {
  return await fsp.readFile(file.path);
}

/**
 * Open `abs` as a plaintext path. The caller disposes it, in a `finally`.
 *
 * `suffix` is the extension the plaintext should carry (`.wav`, `.png`): ffmpeg reads it to choose a demuxer.
 */
export async function openPlaintextFile(abs: string, suffix = ''): Promise<PlaintextFile> {
  const { size, encrypted } = await statStored(abs);
  const dir = await scratchDir('plaintext');
  const file = path.join(dir, `input${suffix}`);

  let removed = false;
  const remove = async (): Promise<void> => {
    if (removed) return;
    removed = true;
    await fsp.rm(dir, { force: true, recursive: true }).catch(() => { /* the boot sweep is the backstop */ });
  };

  if (!encrypted) {
    try {
      await fsp.link(abs, file);
      return { path: file, size, copied: false, dispose: remove };
    } catch (err) {
      log.debug(`A snapshot of ${abs} could not be linked (${err instanceof Error ? err.message : String(err)}); `
        + 'reading the stored file directly');
      await remove();
      return { path: abs, size, copied: false, dispose: async () => { /* nothing was made */ } };
    }
  }

  // Encrypted: one streamed pass into one file, created 0600 and never readable by another user.
  const out = fs.createWriteStream(file, { mode: 0o600 });
  try {
    await pipeline(await openStoredRead(abs), out);
  } catch (err) {
    await remove();
    throw err;
  }
  return { path: file, size, copied: true, dispose: remove };
}
