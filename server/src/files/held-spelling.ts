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
 * parent's listing (one `readdir` per such segment, and none for a name no other spelling can exist for: {@link canHaveAnotherSpelling}) as the entry whose name normalises to it, the lexicographically smallest when a
 * file system holds several. The spelling found goes through {@link heldFileAt}, so the boundary and symlink checks apply to it as to
 * any file the manifest found. Nothing is created, moved or renamed: the bytes stay where they are.
 *
 * It lives apart from `sandbox.ts` because it asks the disk through the stored-bytes door (`lstatIfPresent`), which imports the sandbox.
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { heldFileAt, fileKeyOf, peerFileKey, resolveSafePathChecked, spaceRoot } from './sandbox.js';
import { bytesPresent, lstatIfPresent, isMissingPath } from './stored-bytes.js';

/**
 * Whether a name could be held under another Unicode spelling that normalises to it: the one question that decides whether a missing segment is worth
 * listing its directory for. False for a name of ASCII characters that nothing else normalises to, which has no other spelling by construction.
 *
 * ## What it prevents
 *
 * Every lookup of a missing name listed the whole directory (`readdir`), however large and whatever the name, so a probe for names that are nowhere
 * cost a full listing each. It is NOT "ASCII only": three ASCII characters have another character that normalises to them (U+212A is a K, U+037E a
 * semicolon, U+1FEF a backtick), so a name holding one of those still looks. And it is NOT "equal to its own NFC and NFD forms" either: a CJK
 * compatibility ideograph (U+F900 and its kin) normalises to the unified one, so `豈` has another spelling although it is its own NFC and NFD form.
 * `a-missing-path-is-listed-only-where-another-spelling-can-exist` derives the set from the whole code space and holds this to it.
 */
export function canHaveAnotherSpelling(segment: string): boolean {
  return /[^\x00-\x7f]|[;K`]/.test(segment);
}

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
    // No other spelling can exist for this name, so the directory is not listed: a missing name costs the caller one lstat, however large the directory.
    if (!canHaveAnotherSpelling(segment)) return null;
    const names = await fsp.readdir(at).catch((err: unknown) => { if (isMissingPath(err)) return [] as string[]; throw err; });
    const spelling = names.filter(n => n.normalize('NFC') === segment).sort()[0];
    if (spelling === undefined) return null;
    at = path.join(at, spelling);
    held.push(spelling);
  }
  return heldFileAt(spaceId, held.join('/'));
}

/**
 * Where the bytes a caller's path names are on the disk, whatever spelling they are held under: the NFC resolution when something is
 * there, else the file {@link heldSpellingOf} finds, else the NFC resolution (where nothing is). The one question every ACT on a file asks
 * (delete, move) before it looks at the disk, so an act and the byte doors that read the same listing name the same file.
 *
 * ## What it prevents
 *
 * The listing reports the disk's spelling and the byte doors found the file under it, while delete and move resolved only the NFC spelling:
 * a delete of a listed name answered 204 and published a tombstone with the bytes still on the disk (the settle found nothing at the NFC
 * path), or answered "not found" for a file GET served; a move answered "not found". A caller of an act looks here and not at
 * `resolveSafePathChecked` and then `bytesPresent`, which is the half that drops the held spelling.
 *
 * A DIRECTORY held under another spelling is not found here: the acts on a directory resolve by its NFC name as they always have, and a
 * file's delete must never unlink a tree it matched by accident.
 *
 * @throws RangeError when the path leaves the space or names a symlinked escape. Any other failure to look at the disk is thrown as it came.
 */
export async function storedAbsOf(spaceId: string, userPath: string): Promise<string> {
  const abs = await resolveSafePathChecked(spaceId, userPath);
  if (await lstatIfPresent(abs) !== null) return abs;
  const held = await heldSpellingOf(spaceId, userPath);
  if (held === null) return abs;
  const there = await lstatIfPresent(held.abs);
  return there !== null && !there.isDirectory() ? held.abs : abs;
}

/** Whether bytes are held for the path a caller named, under any spelling of it ({@link storedAbsOf}): `bytesPresentAt` for a file's act. */
export async function bytesHeldAt(spaceId: string, userPath: string): Promise<boolean> {
  return bytesPresent(await storedAbsOf(spaceId, userPath));
}
