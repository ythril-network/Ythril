import { RequestRefusal } from '../util/errors.js';
import { FileSystemFault, SpaceRetired } from './act-answers.js';
import { isMissingPath } from './stored-bytes.js';
import { NAME_CANNOT_EXIST_CODES } from '../util/path-present.js';

/** What an errno's code looks like (`EIO`, `EACCES`, `EMFILE`): an `E` and upper-case letters or digits. Other codes on an error (`ERR_...` from Node itself are matched too, which is intended: a runtime fault on a read is the server's). */
const ERRNO_TOKEN = /^E[A-Z0-9_]+$/;

/** The errno codes that say the path the CALLER named is not a thing here (a directory where a file was asked for, a name or a link chain the file system cannot hold). */
const CALLER_MADE_PATH_CONDITIONS: ReadonlySet<string> = new Set(['EISDIR', ...NAME_CANNOT_EXIST_CODES]);

/**
 * What a failed LISTING or READ of one member's files means: `null` when this member holds nothing at the path (skip it, try the next), a
 * {@link FileSystemFault} when the server's storage failed. Anything that is neither is thrown unchanged.
 *
 * ## The question it answers, and what it prevents
 *
 * "Is this failure the absence of what the caller asked for, or a fault of the server's storage?" Three member loops (MCP `list_dir`, MCP
 * `read_file`, the REST listing) caught every error and read it as "nothing here", so a disk that answered EIO or EACCES was an empty
 * listing or a `File not found`, and a client could not tell an empty folder from a broken one. The answer lives here once, so no loop can
 * keep a bare catch.
 *
 *  - absent (`null`): `isMissingPath` (ENOENT, ENOTDIR: the one rule for a path that names nothing), EISDIR, ENAMETOOLONG and ELOOP (the
 *    caller's own path, not the server's storage), a path the sandbox refused (`RequestRefusal`: traversal, a symlink escape) and a retired
 *    member space (`SpaceRetired`), which skip the member exactly as they always did;
 *  - a fault: any other error carrying a file-system errno (`isFileSystemError`), answered `500 file_system_fault` on every door;
 *  - anything else (a bug, a decode failure a caller handles itself) is not classified here and is rethrown.
 */
export function fileReadFaultOf(err: unknown): FileSystemFault | null {
  if (err instanceof RequestRefusal || err instanceof SpaceRetired) return null;
  if (isMissingPath(err)) return null;
  const code = (err as NodeJS.ErrnoException | null | undefined)?.code;
  // An error that carries an errno token: a runtime file-system error always has a `syscall` too, but a layer that rewraps one may keep only the code.
  if (err instanceof Error && typeof code === 'string' && ERRNO_TOKEN.test(code)) {
    if (CALLER_MADE_PATH_CONDITIONS.has(code)) return null;
    return new FileSystemFault(err);
  }
  throw err;
}
