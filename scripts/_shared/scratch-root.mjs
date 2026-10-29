/**
 * Where a script's SCRATCH goes: never in a checkout.
 *
 * ## What it prevents
 *
 * Q-626 found logs, a stack dump, test output and stray worktree copies in the owner's checkout, and the first answer
 * was a gitignored `tmp/` inside it. That registers the clutter instead of keeping it out: every worktree grows its own
 * `tmp/`, and nothing says when it may be emptied. Scratch is a thing the work makes that is not part of the project, so it
 * lives outside every checkout. {@link scratchRoot} is the one answer to "where does a script put scratch", so a script
 * does not spell a `tmp` folder of its own, and `a-results-folder-has-one-reader-and-one-name` refuses a path built from a
 * checkout's root and `tmp`.
 *
 * The folder is the variable's value when it is set (an absolute path, or this throws, naming it), else a `ythril` folder
 * under the operating system's own temporary folder. Nothing is created here: the caller creates what it writes.
 *
 * Test results are a different question with a different variable (`timingResultsDir`, `testing/_shared/timing-reporter.mjs`).
 */
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

/** The variable that names the scratch root: an absolute path. */
export const SCRATCH_ROOT_ENV = 'YTHRIL_TEMP_ROOT';

/** The folder under the OS temporary folder that is used when the variable is not set. */
export const DEFAULT_SCRATCH_FOLDER = 'ythril';

/**
 * @param {NodeJS.ProcessEnv} [env] default `process.env`
 * @returns {string} an absolute path outside any checkout
 */
export function scratchRoot(env = process.env) {
  const named = env[SCRATCH_ROOT_ENV];
  if (named === undefined || named === '') return join(tmpdir(), DEFAULT_SCRATCH_FOLDER);
  if (!isAbsolute(named)) throw new Error(`${SCRATCH_ROOT_ENV} must be an absolute path, not ${JSON.stringify(named)}`);
  return resolve(named);
}
