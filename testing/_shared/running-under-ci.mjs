/**
 * Is this process running under CI — answered once, here.
 *
 * ## The failure this prevents
 *
 * "Is this CI" was read four ways by four files: `process.env.CI` non-empty (`absent-input.mjs`, `check-changelog.mjs`),
 * `CI` or `GITHUB_ACTIONS` non-empty (`run-suite.mjs`), and `GITHUB_ACTIONS` then `CI` with `''`, `'false'` and `'0'`
 * counted as unset (`test-times.mjs`). So `CI=false` was CI for three of them and not CI for the fourth: the same
 * environment got a refusal from one door and a pass from the next. Worse, the copies that REFUSE on CI and the copy
 * that RECORDS "not CI" disagree silently, because nothing ever puts the two readings side by side.
 *
 * ## The reading
 *
 * A signal is `CI` or `GITHUB_ACTIONS`; it counts when it is set to something other than the empty string, `false`
 * or `0` (case and surrounding space ignored). `CI=false` is how a developer says "I am not CI" to a tool that asks;
 * `CI=''` is a variable that was exported empty. Neither is a runner. `GITHUB_ACTIONS` is a signal of its own because
 * a runner that clears `CI` is still a runner: the recorder must not hold a token there.
 *
 * `testing/standalone/running-under-ci-is-one-reading.test.js` pins the truth table and refuses any file that reads
 * either variable outside this module.
 *
 * It answers one question. It is not the place for what a caller does about the answer (skip, fail, refuse): that
 * stays with the caller, and a per-caller option here would be two modules.
 */

/** The variables that say a process is a CI runner, in the order the first one set names itself. */
export const CI_ENV_NAMES = Object.freeze(['GITHUB_ACTIONS', 'CI']);

/** A value that says "this is not CI" although the variable is set. */
const NOT_A_RUNNER = new Set(['', 'false', '0']);

/**
 * @param {NodeJS.ProcessEnv} [env] default `process.env`
 * @returns {string|null} the first CI variable that is set to a real value, or null when none is
 */
export function ciSignal(env = process.env) {
  for (const name of CI_ENV_NAMES) {
    const value = env[name];
    if (value !== undefined && !NOT_A_RUNNER.has(String(value).trim().toLowerCase())) return name;
  }
  return null;
}

/**
 * @param {NodeJS.ProcessEnv} [env] default `process.env`
 * @returns {boolean}
 */
export function runningUnderCi(env = process.env) {
  return ciSignal(env) !== null;
}
