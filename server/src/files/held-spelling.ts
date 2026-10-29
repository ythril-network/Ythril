/**
 * Where on disk is the file whose key this is, whatever spelling it is held under (Q-581).
 *
 * ## What it prevents
 *
 * A file system that keeps a decomposed (NFD) name holds `Cafe` + U+0301 as it was written, while every path a caller supplies is
 * normalised to NFC before it touches the disk (`resolveSafePath`). The manifest used to advertise the on-disk spelling, and the byte
 * door looked for it at its NFC resolution, where nothing is: the file was advertised and could never be fetched, so a peer logged
 * "404" for it every cycle and held nothing. The manifest now advertises the KEY (`files/manifest.ts`), and the byte doors (REST
 * `GET /api/files/:space` and MCP `read_file`) find the file here, under whichever spelling the holder keeps it. One question, one
 * module, so the two doors cannot answer it differently.
 *
 * ## The rule
 *
 * The NFC resolution is tried first, with the boundary and symlink checks of {@link peerFileKey}. When nothing is at it, the key's
 * segments are walked from the space root: a segment whose NFC spelling exists is taken, and one that does not is looked up in its
 * parent's listing (one `readdir` per such segment) as the entry whose name normalises to it, the lexicographically smallest when a
 * file system holds several. The spelling found goes through {@link heldFileAt}, so the boundary and symlink checks apply to it as to
 * any file the manifest found. Nothing is created, moved or renamed: the bytes stay where they are.
 *
 * It lives apart from `sandbox.ts` because it asks the disk through the stored-bytes door (`lstatIfPresent`), which imports the sandbox.
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { heldFileAt, fileKeyOf, peerFileKey, spaceRoot } from './sandbox.js';
import { lstatIfPresent, isMissingPath } from './stored-bytes.js';

/**
 * The absolute path of the file `userPath` names in `spaceId` and its key, or `null` when nothing is held under any spelling of it.
 *
 * @throws RangeError when the path leaves the space or names a symlinked escape; {@link PathNamesTheSpaceError} when it names the
 *   space itself. Any other failure to look at the disk is thrown as it came.
 */
export async function heldSpellingOf(spaceId: string, userPath: string): Promise<{ abs: string; key: string } | null> {
  const { abs, key } = fileKeyOf(spaceId, userPath);
  if (await lstatIfPresent(abs) !== null) return peerFileKey(spaceId, userPath);
  let at = spaceRoot(spaceId);
  const held: string[] = [];
  for (const segment of key.split('/')) {
    const exact = path.join(at, segment);
    if (await lstatIfPresent(exact) !== null) {
      at = exact;
      held.push(segment);
      continue;
    }
    const names = await fsp.readdir(at).catch((err: unknown) => { if (isMissingPath(err)) return [] as string[]; throw err; });
    const spelling = names.filter(n => n.normalize('NFC') === segment).sort()[0];
    if (spelling === undefined) return null;
    at = path.join(at, spelling);
    held.push(spelling);
  }
  return heldFileAt(spaceId, held.join('/'));
}
