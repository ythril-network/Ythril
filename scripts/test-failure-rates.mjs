#!/usr/bin/env node
/**
 * Each test's failures over the runs that ran it, read from the recorded `Test-Run` records, and every test that failed on
 * a commit that also passed (bundle-356, Q-948; the command of `check-i-test-failure-rates-read`).
 *
 * Usage: node scripts/test-failure-rates.mjs [--since <days>] [--list <lists>]
 *
 *   --since <days>  the span, in whole days back from now (default 30)
 *   --list <lists>  which lists to print, comma-separated: `rates` (the default: every test that failed, and those that
 *                   failed on a commit that also passed), `never-failed` (the slowest tenth of the test files with no
 *                   failure in the span) and `together` (tests that only ever failed together); `all` is the three
 *
 * Reads `YTHRIL_TEST_RUNS_URL` / `YTHRIL_TEST_RUNS_TOKEN` (`record-destination.mjs`), reading only: every request is a
 * `filter` of `Test-Run` records (`test-run-reads.mjs`). `never-failed` also reads the per-file times snapshot
 * `file-times-all.json` of the results folder (`node scripts/test-times.mjs --preflight-costs` writes it; the folder is
 * `timingResultsDir`). The rules are `_shared/failure-rates.mjs`.
 *
 * Exit: 0 no test failed on a commit that also passed; 1 names each such test as "k of n" (failures over the runs that ran
 * its file), highest rate first; 2 when the records hold no result per test, cannot be read, or the command line is wrong.
 * With `never-failed` or `together`: 0 when the asked lists are empty, 1 when one holds an entry, 2 when the records hold no
 * result per test, fewer than two runs do, or the per-file times cannot be read. Exit 2 is never a pass.
 */
import { recordDestination } from './_shared/record-destination.mjs';
import { YthrilApiError } from './_shared/ythril-api.mjs';
import { isEntryPoint, readFlags } from './_shared/script-cli.mjs';
import { testRunRowsSince } from './_shared/test-run-reads.mjs';
import { readSnapshot, FILE_TIMES_ALL_FILE } from './_shared/stage-costs.mjs';
import { timingResultsDir } from '../testing/_shared/timing-reporter.mjs';
import { failureRates, failureRateLines, failureLists, failureListLines, LISTS } from './_shared/failure-rates.mjs';

/** The span when `--since` is not given, in days. */
export const DEFAULT_SINCE_DAYS = 30;

const HELP = `usage: node scripts/test-failure-rates.mjs [--since <days>] [--list ${LISTS.join('|')}|all, comma-separated]   (days default ${DEFAULT_SINCE_DAYS}, list default rates)
exit 0: no test failed on a commit that also passed; 1: names each, highest rate first; 2: cannot answer (never a pass)
with never-failed or together: 0: both asked lists empty; 1: one holds an entry; 2: cannot answer (never a pass)`;

/** The lists a `--list` value names, or null when it names one that does not exist. */
function listsOf(value) {
  if (value === undefined) return ['rates'];
  const named = value.split(',');
  if (named.length === 1 && named[0] === 'all') return [...LISTS];
  return named.length && named.every(n => LISTS.includes(n)) ? LISTS.filter(l => named.includes(l)) : null;
}

/** The per-file times of `file-times-all.json` as `{ times, why }`; `times` is null with the reason when it cannot be read whole and fresh. */
function readFileTimesAll() {
  try {
    const { snapshot, why } = readSnapshot(timingResultsDir(process.cwd()), FILE_TIMES_ALL_FILE, {
      validate: snap => typeof snap.files === 'object' && snap.files !== null && Object.keys(snap.files).length > 0
        && Object.values(snap.files).every(ms => typeof ms === 'number' && Number.isFinite(ms) && ms >= 0),
    });
    return { times: snapshot, why };
  } catch (err) { return { times: null, why: String(err?.message ?? err).split('\n')[0] }; }
}

/** The one-line reason a read failed, naming the status and the instance, never the token. */
const whyOf = (err, shownUrl) => (err instanceof YthrilApiError && err.status !== undefined
  ? `${err.status} from ${shownUrl}` : String(err?.message ?? err).split('\n')[0]);

async function main(argv) {
  if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h')) { console.log(HELP); return 0; }
  const { values, stray } = readFlags(argv, ['--since', '--list']);
  const days = values['--since'] === undefined ? DEFAULT_SINCE_DAYS : /^[1-9]\d{0,3}$/.test(values['--since']) ? Number(values['--since']) : null;
  if (stray.length || days === null) { console.error(`test-failure-rates: --since takes whole days from 1 to 9999\n${HELP}`); return 2; }
  const asked = listsOf(values['--list']);
  if (asked === null) { console.error(`test-failure-rates: --list takes ${LISTS.join(', ')} (comma-separated) or all\n${HELP}`); return 2; }

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
  const exits = [];
  const askedRates = asked.includes('rates');
  if (askedRates) {
    const answer = failureRates(rows, { since, until });
    for (const line of failureRateLines(answer)) console.log(line);
    exits.push(answer.exit);
  }
  const more = asked.filter(l => l !== 'rates');
  if (more.length) {
    const { times, why } = more.includes('never-failed') ? readFileTimesAll() : { times: null, why: undefined };
    const answer = failureLists(rows, { since, until, fileTimes: times, fileTimesWhy: why, lists: more });
    for (const line of failureListLines(answer, { lists: more, withHeader: !askedRates })) console.log(line);
    exits.push(answer.exit);
  }
  return exits.includes(2) ? 2 : Math.max(...exits);
}

if (isEntryPoint(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2)).catch((err) => { console.error(`test-failure-rates: ${String(err?.message ?? err).split('\n')[0]}`); return 2; });
}
