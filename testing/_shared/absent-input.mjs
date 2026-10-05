/**
 * A test whose input is absent SKIPS on a laptop and FAILS on CI — answered once, here.
 *
 * ## The failure this prevents
 *
 * A test that cannot find what it needs (a database, a private address, an embedder, a token file, a built
 * client) has three ways out: assert, skip, or return. Returning ends the test green having asserted nothing and
 * no reporter can tell it from a real pass. A skip is honest, but on the machine that gates merges it still
 * reads as "fine" to everything that looks at the exit code. The right answer depends on WHERE the test runs: on
 * a developer's machine a missing input is a reason to skip with an actionable message; on CI, which is supposed
 * to bring every input up, the same absence is a broken runner and must fail loudly.
 *
 * `mongoSkipReason()`, `privateAddressSkipReason()` and `requireEmbedding()` each knew that, each wrote the CI
 * half themselves, and a fourth copy is the one that forgets it. The CI half is the part a hand-written copy
 * drops, so it lives inside these two functions and a caller cannot reach the skip without passing through it.
 *
 * ## Two doors, one rule
 *
 * - `absentInputReason(why)` — for a `skip` option or a `describe(..., { skip })` evaluated up front. Returns the
 *   reason off CI, THROWS on CI.
 * - `requireInput(t, present, why)` — for a test body. True when `present`; otherwise skips (off CI) and returns
 *   false, or throws (on CI). Use as `if (!requireInput(t, present, why)) return;`.
 *
 * CI is `runningUnderCi()` (`running-under-ci.mjs`): `CI` or `GITHUB_ACTIONS` set to something other than `''`,
 * `false` or `0`. GitHub Actions sets both on every job.
 *
 * It is NOT a place for a skip that is EXPECTED on CI. A test that reads a corpus CI never fetches says so with
 * a skip reason prefixed `expected-in-ci:` in a file the gate lists — that is a different question (the absence
 * is by design), and routing it through here would turn a designed skip into a failure.
 */

import { runningUnderCi } from './running-under-ci.mjs';

/**
 * @param {string} why     what is missing, in the words an operator needs to fix it
 * @param {string} [ciHint] what to check when this is a CI runner (appended to the refusal only)
 * @returns {string} `why`, for a skip reason — off CI only
 * @throws {Error} on CI, naming `why`
 */
export function absentInputReason(why, ciHint = '') {
  if (runningUnderCi()) {
    throw new Error(
      `${why} — but CI is set, so this is a failure rather than a skip: the test it guards would otherwise report `
      + `green having asserted nothing.${ciHint ? ` ${ciHint}` : ''}`,
    );
  }
  return why;
}

/**
 * @param {import('node:test').TestContext} t
 * @param {boolean} present  whether the input the test needs is there
 * @param {string} why       what is missing, for the skip reason and the CI refusal
 * @param {string} [ciHint]  what to check when this is a CI runner
 * @returns {boolean} true when the test may proceed; false when it has been skipped (off CI only)
 */
export function requireInput(t, present, why, ciHint = '') {
  if (present) return true;
  t.skip(absentInputReason(why, ciHint));
  return false;
}
