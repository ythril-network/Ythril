/**
 * Is the directory entry at a path also named, under another spelling, by a LIVE file record of this space? The one answer a remover of a
 * peer's file asks before it takes bytes away.
 *
 * ## What it prevents
 *
 * A record id is case-SENSITIVE and a peer may run on a case-sensitive host, but on a case-insensitive file system `a.txt` and `A.txt` are
 * one directory entry. After a case-only rename the sender tells every peer the old id is gone and sends the new file. If the new file's
 * arrival lands first, the entry holds its bytes under the old spelling's name too, and the tombstone for the old id then unlinks the path
 * it names: the bytes the new record stands on. A remover that took the bytes for the record it was told to remove lost the file of another
 * record, and nothing reported it until a later cycle fetched the bytes again, if one ever did.
 *
 * ## What it answers
 *
 * The id of the live record whose spelling the entry really has, when that is not `rel`: asked of the file system (`realpath` gives the
 * entry's own spelling on a case-insensitive host and the same path on a case-sensitive one, where two spellings are two files and the answer
 * is always no). `null` when nothing is at the path, when `rel` IS the entry's own spelling, when the entry's real path is not a spelling of
 * `rel` at all (a symbolic link), and when no live record holds the entry's own spelling. A failure to look other than "not there" is thrown.
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { toDocId } from '../util/paths.js';
import { hasLiveFileRecordExactlyAt, retireFileMeta } from './file-meta.js';
import { cancelMediaJob } from './media/job-queue.js';
import { spaceRoot } from './sandbox.js';
import { isMissingPath, isOneNameUnderTwoSpellings } from './stored-bytes.js';

/**
 * Remove the record a peer's tombstone names, and its job, and nothing of the entry: the other spelling's record stands on those bytes and
 * on the sidecars beside them, which a sidecar's own spelling shares. The job first, as every remover of a file's rows revokes the claims
 * of its jobs before it removes the rows.
 */
export async function removeOnlyTheRecordNamed(spaceId: string, rel: string): Promise<void> {
  await cancelMediaJob(spaceId, rel);
  await retireFileMeta(spaceId, rel);
}

export async function liveRecordAtAnotherSpellingOfEntry(spaceId: string, rel: string, abs: string): Promise<string | null> {
  let real: string;
  let root: string;
  try {
    real = await fsp.realpath(abs);
    root = await fsp.realpath(spaceRoot(spaceId));
  } catch (err) {
    if (isMissingPath(err)) return null;
    throw err;
  }
  const own = toDocId(path.relative(root, real));
  if (own === toDocId(rel) || !isOneNameUnderTwoSpellings(own, rel)) return null;
  return (await hasLiveFileRecordExactlyAt(spaceId, own)) ? own : null;
}
