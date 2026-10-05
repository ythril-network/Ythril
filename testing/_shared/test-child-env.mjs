/**
 * The environment a test child gets: this process's, minus what a child must not inherit, plus what the runner
 * adds (bundle-56, security S2).
 *
 * ## What it prevents
 *
 * Two things a runner passes on by default and a test child must not have. The names are matched here and nowhere
 * else (`a-test-child-environment-is-one-module.test.js` refuses a file that names either outside this module).
 *
 * - **The recorder's credentials.** `YTHRIL_TEST_RUNS_URL` and `YTHRIL_TEST_RUNS_TOKEN` point the test-run RECORDER
 *   at a Ythril instance and hold a write token for it. Inherited, every test file — and every process a test starts,
 *   and every dependency a test imports — would see a token only the recorder needs. The names are matched by
 *   prefix, not listed, so a variable added to the family later is stripped too.
 * - **The runner's wire.** `NODE_TEST_CONTEXT` is set by the `node --test` that runs THESE processes. A child that
 *   sees it believes it is a worker of that runner and speaks the runner's wire format instead of printing a
 *   report, or refuses to start its own run. A test that spawns `node --test` over fixtures or over a scratch tree
 *   is exactly such a child.
 *
 * Only the INHERITED environment is scrubbed. `extra` is what the caller deliberately adds and is merged over the
 * result untouched (a recorder test gives its child a recorder URL on purpose).
 *
 * Every runner and every test that starts a child builds its environment here; none keeps its own copy of the rule.
 */

/** The family of variables only the recorder may hold. */
export const RECORDER_ENV_PREFIX = 'YTHRIL_TEST_RUNS_';

/** Set by `node --test` in every process it starts; meaningful only to those. */
const RUNNER_CONTEXT_ENV = 'NODE_TEST_CONTEXT';

/**
 * @param {Record<string,string>} [extra] merged over the result (the timing reporter's own variables)
 * @param {NodeJS.ProcessEnv} [base] default `process.env`
 */
export function testChildEnv(extra = {}, base = process.env) {
  const env = {};
  for (const [k, v] of Object.entries(base)) {
    const name = k.toUpperCase();
    if (name.startsWith(RECORDER_ENV_PREFIX) || name === RUNNER_CONTEXT_ENV) continue;
    env[k] = v;
  }
  return { ...env, ...extra };
}
