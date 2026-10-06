/**
 * A test file's path as the repository names it — forward slashes, no leading `./`, relative to the checkout.
 *
 * ## The question it answers
 *
 * "Is this the path the tracked-file listing would print for that file?" The timing reporter writes `file` as a
 * repo-relative path, a vitest report names absolute ones, and a Windows run writes backslashes. Everything that compares
 * those with `git ls-files` (the executed-tests and unexpected-skips checks, the recorder's per-file figures) has to
 * agree on the answer, because the disagreement is a file counted as two.
 *
 * ## What it prevents
 *
 * Four copies each did part of it: one stripped `./`, one did not, one relativised an absolute path and kept it when it
 * lay outside, one masked it. A path that was relativised in one place and not the other is a file that "ran" under one
 * spelling and was "unexecuted" under the other. {@link slashPath} is the spelling; {@link repoRelative} is the
 * relativising, and it answers `null` for an absolute path OUTSIDE the root so that what to do with a path that is not
 * the repository's (keep it, mask it) stays the caller's decision and is never made by accident.
 *
 * Not for the producer: `testing/_shared/timing-reporter.mjs` turns node's own absolute path into the repo-relative
 * `file` it writes, and is a leaf module that imports nothing from `scripts/` (it is loaded inside the test process).
 */
import { isAbsolute, relative, resolve } from 'node:path';

/** `a\b` and `./a/b` as `a/b`. Does not look at the filesystem and does not relativise. */
export const slashPath = (file) => String(file ?? '').replaceAll('\\', '/').replace(/^\.\//, '');

/** A drive-letter path (`C:\x`, `C:/x`), which is absolute wherever the results were written, whatever platform reads them. */
const isDrivePath = (slashed) => /^[A-Za-z]:\//.test(slashed);

/**
 * `file` relative to `root`, in {@link slashPath} spelling; a path that is already relative is returned in that spelling.
 *
 * @param {string} file
 * @param {string} root  the checkout the path should lie in
 * @returns {string|null} `null` when `file` is absolute and lies outside `root` (or is a drive path on a platform whose
 *   `path` does not read one)
 */
export function repoRelative(file, root) {
  const slashed = slashPath(file);
  if (!isAbsolute(String(file ?? '')) && !isDrivePath(slashed)) return slashed;
  if (isDrivePath(slashed) && !isAbsolute(String(file))) return null;
  const rel = slashPath(relative(resolve(root), String(file)));
  return rel !== '' && rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel) && !isDrivePath(rel) ? rel : null;
}
