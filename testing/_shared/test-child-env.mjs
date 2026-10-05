/**
 * The environment a test child gets: this process's, minus the recorder's credentials, plus what the runner
 * adds (bundle-56, security S2).
 *
 * ## What it prevents
 *
 * `YTHRIL_TEST_RUNS_URL` and `YTHRIL_TEST_RUNS_TOKEN` point the test-run RECORDER at a Ythril instance and
 * hold a write token for it. A runner passes its own environment on by default, so every test file — and every
 * process a test starts, and every dependency a test imports — would see a token that only the recorder needs.
 * The names are matched by prefix, not listed, so a variable added to the family later is stripped too.
 *
 * Every runner that starts a test child builds its environment here; none keeps its own copy of the rule.
 */

/** The family of variables only the recorder may hold. */
export const RECORDER_ENV_PREFIX = 'YTHRIL_TEST_RUNS_';

/**
 * @param {Record<string,string>} [extra] merged over the result (the timing reporter's own variables)
 * @param {NodeJS.ProcessEnv} [base] default `process.env`
 */
export function testChildEnv(extra = {}, base = process.env) {
  const env = {};
  for (const [k, v] of Object.entries(base)) {
    if (!k.toUpperCase().startsWith(RECORDER_ENV_PREFIX)) env[k] = v;
  }
  return { ...env, ...extra };
}
