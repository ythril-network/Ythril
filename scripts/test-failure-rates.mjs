#!/usr/bin/env node
/**
 * Each test's failures over the runs that ran it, read from the recorded `Test-Run` records, and every test that failed on
 * a commit that also passed (bundle-356, Q-948; the command of `check-i-test-failure-rates-read`).
 *
 * Usage: node scripts/test-failure-rates.mjs [--since <days>]
 *
 *   --since <days>  the span, in whole days back from now (default 30)
 *
 * Reads `YTHRIL_TEST_RUNS_URL` / `YTHRIL_TEST_RUNS_TOKEN` (`record-destination.mjs`), reading only: every request is a
 * `filter` of `Test-Run` records (`test-run-reads.mjs`). The rules are `_shared/failure-rates.mjs`.
 *
 * Exit: 0 no test failed on a commit that also passed; 1 names each such test as "k of n" (failures over the runs that ran
 * its file), highest rate first; 2 when the records hold no result per test, cannot be read, or the command line is wrong.
 * Exit 2 is never a pass.
 */
import { recordDestination } from './_shared/record-destination.mjs';
import { YthrilApiError } from './_shared/ythril-api.mjs';
import { isEntryPoint, readFlags } from './_shared/script-cli.mjs';
import { testRunRowsSince } from './_shared/test-run-reads.mjs';
import { failureRates, failureRateLines } from './_shared/failure-rates.mjs';

/** The span when `--since` is not given, in days. */
export const DEFAULT_SINCE_DAYS = 30;

const HELP = `usage: node scripts/test-failure-rates.mjs [--since <days>]   (default ${DEFAULT_SINCE_DAYS})
exit 0: no test failed on a commit that also passed; 1: names each, highest rate first; 2: cannot answer (never a pass)`;

/** The one-line reason a read failed, naming the status and the instance, never the token. */
const whyOf = (err, shownUrl) => (err instanceof YthrilApiError && err.status !== undefined
  ? `${err.status} from ${shownUrl}` : String(err?.message ?? err).split('\n')[0]);

async function main(argv) {
  if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h')) { console.log(HELP); return 0; }
  const { values, stray } = readFlags(argv, ['--since']);
  const days = values['--since'] === undefined ? DEFAULT_SINCE_DAYS : /^[1-9]\d{0,3}$/.test(values['--since']) ? Number(values['--since']) : null;
  if (stray.length || days === null) { console.error(`test-failure-rates: --since takes whole days from 1 to 9999\n${HELP}`); return 2; }

  const dest = recordDestination();
  if (!dest.api) { console.error(`test-failure-rates: cannot read the records: ${dest.why}`); return 2; }
  const until = new Date().toISOString();
  const since = new Date(Date.parse(until) - days * 24 * 3600 * 1000).toISOString();
  let rows;
  try {
    rows = await testRunRowsSince(dest.api, since, { measurements: true });
  } catch (err) {
    console.error(`test-failure-rates: cannot read the records: ${whyOf(err, dest.shownUrl)}`);
    return 2;
  }
  const answer = failureRates(rows, { since, until });
  for (const line of failureRateLines(answer)) console.log(line);
  return answer.exit;
}

if (isEntryPoint(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2)).catch((err) => { console.error(`test-failure-rates: ${String(err?.message ?? err).split('\n')[0]}`); return 2; });
}
