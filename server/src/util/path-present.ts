/**
 * Whether a path is there, in one answer: yes, no, or a thrown failure to look.
 *
 * ## The question it answers
 *
 * "Is something at this path?" for a caller that cannot be async (a boot step, a request handler's guard, a loader that returns a
 * value). `fs.existsSync` answers that with a boolean and cannot say "I was not allowed to look": EACCES, EPERM, a directory on the way
 * with no search permission, an I/O error all read as `false`. Callers took the `false` as "not there" and acted on it: an offsite
 * backup carried none of the users' files and said nothing, a restore condemned a whole backup as "holds no file", a config file the
 * process could not read opened first-run setup to the first visitor, a plaintext secrets file stayed plaintext. The defect never
 * depended on WHICH file was asked about, so no caller may ask `existsSync` (`are-the-bytes-here-has-one-answer.test.js` hunts it).
 *
 * ## What it prevents
 *
 * A failure to look is never an answer. {@link pathPresentSync} returns `false` only for a path that cannot exist
 * ({@link cannotExist}) and throws every other failure, so a caller that did not handle the throw stops, and a caller that must go on
 * says so in its own words.
 *
 * ## The one list of "cannot exist"
 *
 * - {@link isMissingPath}: the path names nothing (ENOENT, and ENOTDIR for a path through a regular file, which Linux says where
 *   Windows says ENOENT).
 * - {@link NAME_CANNOT_EXIST_CODES}: a name too long to exist and a loop of links. For a delete these are "not found" like a missing
 *   path; a move's destination check reads the same two as refusals about CREATING the name.
 * - {@link cannotExist}: either of the two.
 *
 * `files/delete-cascade.ts` (what a delete treats as not found) and `files/read-fault.ts` (what a listing or read treats as nothing
 * here) read this list, so the four codes are written down once.
 */
import fs from 'node:fs';

/**
 * Whether a filesystem failure says the path does not exist — the one failure a look at a path reads as an answer, and the one place a
 * failure's code is read that way (`are-the-bytes-here-has-one-answer.test.js`).
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

/** The errno codes that say a NAME cannot exist here: too long, or a loop of symbolic links. Neither is "missing" (a delete's records may remain), neither is a failure to look. */
export const NAME_CANNOT_EXIST_CODES: ReadonlySet<string> = new Set(['ENAMETOOLONG', 'ELOOP']);

/** Whether a filesystem failure says nothing can be at the path: {@link isMissingPath}, a name too long, a link loop. */
export const cannotExist = (err: unknown): boolean =>
  isMissingPath(err) || NAME_CANNOT_EXIST_CODES.has(String((err as NodeJS.ErrnoException | null)?.code ?? ''));

/**
 * Whether something is at `abs` (a symbolic link is followed, as `existsSync` did). `false` when the path cannot exist
 * ({@link cannotExist}); every other failure to look (EACCES, EPERM, EIO, a stuck mount) is thrown as it came, never read as "no".
 */
export function pathPresentSync(abs: string): boolean {
  try {
    fs.statSync(abs);
    return true;
  } catch (err) {
    if (cannotExist(err)) return false;
    throw err;
  }
}
