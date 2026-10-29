/**
 * The ONE way a results folder is created, and the rule that a test may not create the checkout's own.
 *
 * ## What it prevents
 *
 * A test that reaches a default-folder `mkdir` makes `<checkout>/test-results` on a machine that moved its results folder
 * out of the checkout (`YTHRIL_TEST_RESULTS_DIR`). A test child does NOT inherit that variable (`testChildEnv` scrubs it on
 * purpose), so the default it sees is always the checkout's, and an empty folder appeared after every local run with nothing
 * to say which test made it. The forgettable part is the check itself, so it lives in the creation: every writer calls
 * {@link makeResultsFolder} (the reporter flags' destination, the recorder's unrecorded folder) and none calls `mkdirSync`.
 *
 * Under `node --test` (`isTestChild`: the runner's own children, never the runner) a folder at or inside the checkout's
 * `test-results` is refused BEFORE anything is created, naming the rule. Runners (preflight, run-standalone, run-suite, CI)
 * are not test children and keep the checkout's folder. A scratch repository's own `test-results` is another checkout and is
 * not refused; a folder anywhere else is made as asked.
 */
import { mkdirSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { timingResultsDir } from './timing-reporter.mjs';
import { isTestChild } from './test-child-env.mjs';

const CHECKOUT_RESULTS = timingResultsDir(resolve(dirname(fileURLToPath(import.meta.url)), '..', '..'), {});

/** Thrown by {@link makeResultsFolder} when a test child asks for the checkout's own results folder. */
export class ResultsFolderRefused extends Error {
  constructor(folder) {
    super(`a test must pass its own dir; it may not create the checkout's results folder (${folder}). `
      + `Give the call a dir under scratchRoot() (scripts/_shared/scratch-root.mjs), never the checkout's results folder.`);
    this.name = 'ResultsFolderRefused';
  }
}

/**
 * @param {string} folder the folder to make (absolute, or relative to the working directory)
 * @param {NodeJS.ProcessEnv} [env] what decides whether the caller is a test child; default `process.env`
 */
export function makeResultsFolder(folder, env = process.env) {
  const target = resolve(folder);
  const inside = relative(CHECKOUT_RESULTS, target);
  const inCheckoutResults = inside === '' || (!inside.startsWith('..') && !isAbsolute(inside));
  if (isTestChild(env) && inCheckoutResults) throw new ResultsFolderRefused(target);
  mkdirSync(target, { recursive: true });
}
