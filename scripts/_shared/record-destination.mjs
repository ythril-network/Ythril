/**
 * Where a recorder writes, and whether this process may write at all (Q-590).
 *
 * ## What it prevents
 *
 * Both recorders (`scripts/test-times.mjs`, `scripts/trade.mjs`) read the same two variables and refuse in the same place, and a
 * second spelling of either is how one of them comes to send a token from CI or to an address nobody checked:
 *
 * - **A recording from CI.** CI never holds the token that writes records; a token found there is a leak to refuse, with an exit
 *   code (2) that says "refused for where it ran", not the 1 of an ordinary failure. {@link refuseRecordingUnderCi} says it, and
 *   what counts as CI is `running-under-ci.mjs`'s one reading.
 * - **An unchecked destination.** `YTHRIL_TEST_RUNS_URL` and `YTHRIL_TEST_RUNS_TOKEN` go through `createYthrilApi`, which refuses a
 *   URL a token must not be sent to. {@link recordDestination} answers a client, or the reason there is none, never both and
 *   never a half-built client.
 *
 * The caller's name (`test-times`, `trade`) is a parameter of the refusal, so each keeps its own prefix on its own lines; what is
 * said after it is one sentence. What a caller DOES with "no destination" is its own: test-times keeps the payload on disk and
 * exits 0, trade refuses with exit 2.
 */
import { createYthrilApi } from './ythril-api.mjs';
import { ciSignal } from '../../testing/_shared/running-under-ci.mjs';

/**
 * The refusal under CI: prints one line to stderr and returns 2, or returns null when this is not CI.
 *
 * @param {string} prefix  the script's name, `test-times` or `trade`
 * @param {string} flag    the flag being refused, `--record`
 * @param {string} [reason]  what is true here: the default says a WRITE is refused; a flag that only READS says so (a sentence
 *   about writing a record under a command that reads one is a false line a person acts on)
 * @returns {2|null}
 */
export function refuseRecordingUnderCi(prefix, flag, reason = 'CI never holds the token that writes records, so nothing is sent') {
  const named = ciSignal();
  if (!named) return null;
  console.error(`${prefix}: ${flag} is refused when ${named} is set: ${reason}`);
  return 2;
}

/**
 * The destination from `YTHRIL_TEST_RUNS_URL` / `YTHRIL_TEST_RUNS_TOKEN`: `{ api, shownUrl }` (the URL without a trailing slash,
 * for a line a person reads), or `{ why }` naming what is unset or refused.
 *
 * @param {NodeJS.ProcessEnv} [env]
 */
export function recordDestination(env = process.env) {
  const url = env.YTHRIL_TEST_RUNS_URL;
  const token = env.YTHRIL_TEST_RUNS_TOKEN;
  if (!url) return { why: 'YTHRIL_TEST_RUNS_URL unset' };
  if (!token) return { why: 'YTHRIL_TEST_RUNS_TOKEN unset' };
  try { return { api: createYthrilApi({ url, token }), shownUrl: url.replace(/\/+$/, '') }; } catch (err) { return { why: err.message }; }
}
