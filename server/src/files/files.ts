import fs from 'fs/promises';
import path from 'path';
import { sha256Hex } from '../util/sha256-hex.js';
import { resolveSafePathChecked, spaceRoot } from './sandbox.js';
import { hardenPath, mkdirPrivate } from '../util/fs-modes.js';
import { StringDecoder } from 'node:string_decoder';
import { openStoredRead, writeStored, statStored, moveStoredIfFree, finishInterruptedLink, DestinationOccupied } from './stored-bytes.js';
import { markdownWindow, type MarkdownWindow } from './markdown-window.js';
import { assertSpaceTakesWrites } from '../spaces/space-write-gate.js';
import { fsRefusalOf } from './destination.js';
import { DestinationExists, type DestinationAct } from './act-answers.js';
import { fileMoveLinkFallbackTotal } from '../metrics/registry.js';
import { getDataRoot } from '../config/loader.js';
import { toDocId } from '../util/paths.js';
import { warnOnce } from '../util/warn-once.js';
import { log, peerText } from '../util/log.js';

export interface FileEntry {
  name: string;
  type: 'file' | 'dir';
  size?: number;
  modifiedAt?: string;
  // ── File-level metadata, joined from the `{space}_files` FileMeta record (files only) ──
  /** Embedding lifecycle of the file, for the status pill in the merged Files list. */
  embeddingStatus?: 'pending' | 'processing' | 'complete' | 'partial' | 'failed' | 'skipped' | 'disabled';
  /** Tags on the file's metadata record. */
  tags?: string[];
  /**
   * Live stage of the file's media job — which step of THIS file's route is running, and how far in.
   * Present only while the file is in flight (`pending`/`processing`) and only once the worker has
   * reported a step; absent means "not known yet", which the UI must keep distinct from "no steps".
   */
  progress?: { step: string; steps: string[]; done?: number; total?: number };
  /** ISO8601 of the job's last sign of life, so the UI can tell "working" from "wedged". */
  progressAt?: string | null;
}

/** Ensure the space files directory exists */
export async function ensureSpaceFilesDir(spaceId: string): Promise<void> {
  // Owner-only. A space's files directory holds every document uploaded to that space; it has no business being
  // world-readable, and it was — see `util/fs-modes.ts`.
  await mkdirPrivate(spaceRoot(spaceId));
}

/**
 * A WINDOW of a stored text file, read as a stream: the one function both doors that return a document's text call (`read_file`
 * and `GET …/files/extract`), so neither holds the document to answer for a page of it.
 *
 * ## What it prevents
 *
 * Both doors read the whole file into one string and cut a window out of it, so reading one page of a large document cost the
 * whole document in memory, once per page. Here the file streams through the stored-bytes door (decrypted as it goes) and only the
 * window is kept: the text from `skip` on, up to the budget plus the one character `markdownWindow` needs to know a paragraph's end
 * is past it. The rest is COUNTED, not kept, because `markdownChars` (how far a reader has read) is the document's length, so time per
 * page stays proportional to the file's size and memory does not.
 *
 * The answer is `markdownWindow`'s, character for character, on the text a whole read would have given: it is computed by that
 * function over the held prefix, and only the offsets (`skip`, `nextSkip`, `totalChars`) are put back in the document's terms.
 *
 * **An encrypted file's failure still refuses before any text is returned.** The window is returned only after the stream has been
 * read to its end, so a chunk that fails its tag (or a foreign key, found when the file is opened) is a thrown `StoredFileUnreadable`
 * and never a half answer. A path that is a directory or does not exist throws as a whole read did.
 */
export async function readFileWindow(
  spaceId: string, filePath: string, req: { skip: number; maxChars: number; maxBytes: number | null },
): Promise<MarkdownWindow> {
  const abs = await resolveSafePathChecked(spaceId, filePath);
  const source = await openStoredRead(abs);
  try {
    const decoder = new StringDecoder('utf8');
    const keep = req.maxChars + 1;
    let total = 0;
    let head = '';
    const take = (piece: string): void => {
      const from = total;
      total += piece.length;
      const first = Math.max(0, req.skip - from);
      if (head.length >= keep || first >= piece.length) return;
      head += piece.slice(first, first + (keep - head.length));
    };
    for await (const chunk of source) take(decoder.write(chunk as Buffer));
    take(decoder.end());
    const w = markdownWindow(head, 0, req.maxChars, req.maxBytes);
    const skip = Math.min(req.skip, total);
    return { ...w, skip, totalChars: total, ...(w.nextSkip !== undefined ? { nextSkip: skip + w.nextSkip } : {}) };
  } finally {
    source.destroy();
  }
}

/** Write a text file, creating parent directories as needed */
export async function writeFile(spaceId: string, filePath: string, content: string): Promise<{ sha256: string }> {
  // Nothing new lands under a space that is being deleted or renamed away — see `spaces/space-write-gate.ts`.
  assertSpaceTakesWrites(spaceId);
  const abs = await resolveSafePathChecked(spaceId, filePath);
  // Through the one door for stored bytes (F-43): encrypted at rest when a master secret is set, written to a
  // temp file outside the tree and renamed, and hardened to owner-only whatever the file's history.
  await writeStored(abs, content);
  const sha256 = sha256Hex(content);
  return { sha256 };
}

/** Write a Buffer to a file */
export async function writeFileBytes(
  spaceId: string,
  filePath: string,
  data: Buffer,
): Promise<{ sha256: string }> {
  assertSpaceTakesWrites(spaceId);   // see `writeFile` above
  const abs = await resolveSafePathChecked(spaceId, filePath);
  await writeStored(abs, data);   // see the note in `writeFile` above
  const sha256 = sha256Hex(data);
  return { sha256 };
}

/** List entries in a directory (non-recursive) */
export async function listDir(spaceId: string, dirPath: string): Promise<FileEntry[]> {
  const abs = await resolveSafePathChecked(spaceId, dirPath);
  const entries = await fs.readdir(abs, { withFileTypes: true });
  const result: FileEntry[] = [];
  for (const e of entries) {
    if (e.isDirectory()) {
      result.push({ name: e.name, type: 'dir' });
    } else if (e.isFile()) {
      let size: number | undefined;
      let modifiedAt: string | undefined;
      try {
        // The PLAINTEXT size: with a master secret a stored file is ciphertext on disk (F-43).
        const stat = await statStored(path.join(abs, e.name));
        size = stat.size;
        modifiedAt = stat.mtime.toISOString();
      } catch { /* stat failed — omit metadata */ }
      result.push({ name: e.name, type: 'file', size, modifiedAt });
    }
  }
  return result;
}

/** Create a directory (including parents) */
export async function createDir(spaceId: string, dirPath: string): Promise<void> {
  const abs = await resolveSafePathChecked(spaceId, dirPath);
  // The filesystem's refusal is the caller's path or the server's fault, said once (`fsRefusalOf`), never the raw errno text.
  await mkdirPrivate(abs).catch((err: unknown) => { throw fsRefusalOf(err, [dirPath]); });
}

/**
 * A move onto a file system that refuses a hard link is said ONCE per data root: the no-overwrite guarantee of a move needs hard-link
 * support, and what a move does without it (a rename, with a foreign writer's window) is the operator's to know, not every move's to repeat.
 * Operator log only; no door answer carries it.
 */
const saidLinkFallback = warnOnce<string>({ max: 16, every: 60 * 60_000 });

/** A move fell back to a rename: counted every time, said once. */
function linkFellBack(err: unknown): void {
  fileMoveLinkFallbackTotal.inc();
  const root = getDataRoot();
  saidLinkFallback(root, () => log.warn(`The file system under ${peerText(root)} refused a hard link (${peerText((err as NodeJS.ErrnoException | null)?.code ?? err)}), so file moves there fall back to a rename: `
    + 'a move still refuses a destination that exists when it looks, but a foreign process writing at the destination in that instant can be overwritten. '
    + 'Counted by ythril_file_move_link_fallback_total; a data volume that supports hard links closes the window.'));
}

/**
 * Place a stored file or directory at a path NOTHING stands at, and NEVER replace what does: the one step that puts bytes under a name for
 * an act that must not clobber — the move (`moveFile`) and the placing of a conflict's incoming copy (`api/conflicts.ts`, keep-both with
 * a rename and save-to-space).
 *
 * ## What it prevents
 *
 * A rename replaces. The two acts above each wrote their own way of putting bytes down, and the one that wrote `moveStored` replaced a
 * file, a replicated one, whose loss travelled to every instance. Here the destination is classified UNDER the locks and the bytes are
 * placed by a step the kernel refuses on an existing name (`moveStoredIfFree`), so something that appears between a caller's check and
 * this placing is refused too, and what is refused is {@link DestinationExists} (`409 destination_exists`, answered by every door through
 * `fileActAnswer`), the occupant untouched. The parent directories are made here, so a caller cannot create them before it has asked
 * whether the placing may happen; every failure of the file system is said once (`fsRefusalOf`), never in its own words.
 *
 * `dstDocId` is the destination as the caller named it, space-relative: it is what the refusal names. `begun` is the caller's reading of
 * whether it holds evidence that a half-made link at the destination is its OWN (a move's begun-move marker; an open conflict record for
 * the copy being placed), taken before it started: without it the same inode under two names is somebody's hard link and is refused. An
 * explicit argument at every call. `act` says whose sentence a refusal carries (`DestinationExists`).
 *
 * The mode of what was placed is hardened here (a rename carries the source's mode, so placing a file that predates the hardening would
 * reintroduce an 0644 file into a tightened tree), by `hardenPath` and not `harden(dstAbs, FILE_MODE)`: a DIRECTORY is placed too, and
 * `0600` on a directory removes the execute bit that makes it openable at all (see the note on `hardenPath`).
 */
export async function placeIfFree(
  srcAbs: string,
  dstAbs: string,
  dstDocId: string,
  { begun, act = 'move' }: { begun: boolean; act?: DestinationAct },
): Promise<void> {
  await mkdirPrivate(path.dirname(dstAbs)).catch((err: unknown) => { throw fsRefusalOf(err, [dstDocId]); });
  // Under both paths' locks (F-43). The occupied destination is the placing's own refusal and is answered BEFORE `fsRefusalOf` sees it:
  // the kernel's ENOTEMPTY or EISDIR of a rename is a name that is taken, not a path that cannot be created.
  await moveStoredIfFree(srcAbs, dstAbs, { begun, onLinkFallback: linkFellBack }).catch((err: unknown) => {
    if (err instanceof DestinationOccupied) throw new DestinationExists(dstDocId, 'bytes', undefined, act);
    throw fsRefusalOf(err, [dstDocId]);
  });
  await hardenPath(dstAbs);
}

/**
 * Move/rename a file or directory — and NEVER replace what stands at the destination: something there is {@link DestinationExists}
 * (`409 destination_exists`, answered by every door through `fileActAnswer`), whether it was there when the move was asked
 * (`assertDestinationFree`) or appeared in the instant between that check and the bytes being placed ({@link placeIfFree}).
 *
 * `begun` is the cascade's reading, taken before its own marker was written, of whether a begun-move marker names this very pair: it is
 * what tells a half-made link of this move from an operator's hard link. An explicit argument at every call.
 */
export async function moveFile(
  spaceId: string,
  srcPath: string,
  dstPath: string,
  { begun }: { begun: boolean },
): Promise<void> {
  const srcAbs = await resolveSafePathChecked(spaceId, srcPath);
  const dstAbs = await resolveSafePathChecked(spaceId, dstPath);
  await placeIfFree(srcAbs, dstAbs, toDocId(dstPath), { begun });
}

/**
 * Finish the bytes of a begun move whose two names a crash left: remove the source's name when the pair is the half-made link of that
 * move (`finishInterruptedLink`). Housekeeping and the finishing branch of the cascade ask it before they carry the records, so a move
 * that stopped between its link and the removal is finished and not refused as an occupied destination. A pair that is anything else
 * is left as it is. Asked only of a move whose begun-move marker exists: that is the evidence.
 *
 * @returns whether a name was removed.
 */
export async function finishHalfLinkedMove(spaceId: string, srcPath: string, dstPath: string): Promise<boolean> {
  return finishInterruptedLink(await resolveSafePathChecked(spaceId, srcPath), await resolveSafePathChecked(spaceId, dstPath));
}

/** Recursively sum file sizes under a directory. Returns 0 if dir doesn't exist. */
export async function getDirSizeBytes(dir: string): Promise<number> {
  let total = 0;
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      total += await getDirSizeBytes(full);
    } else if (entry.isFile()) {
      try {
        const st = await fs.stat(full);
        total += st.size;
      } catch { /* skip inaccessible files */ }
    }
  }
  return total;
}

/**
 * Recursively list every file under a space-relative directory, returning
 * space-relative forward-slash paths (e.g. `notes/2024/jan.md`). Returns [] if the
 * directory does not exist. Used to enumerate a subtree before deleting it so a sync
 * tombstone can be written for each removed file.
 */
export async function listFilesRecursive(spaceId: string, dirPath: string): Promise<string[]> {
  const root = spaceRoot(spaceId);
  let absDir: string;
  try {
    absDir = await resolveSafePathChecked(spaceId, dirPath);
  } catch {
    return [];
  }
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return; // missing or unreadable — nothing to list
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        out.push(path.relative(root, full).replace(/\\/g, '/'));
      }
    }
  }
  await walk(absDir);
  return out;
}

export interface QuotaCheckResult {
  /** true = proceed with write; false = reject with 507 */
  allowed: boolean;
  /** true = within hard limit but past soft limit — caller should include storageWarning */
  softWarning: boolean;
}

