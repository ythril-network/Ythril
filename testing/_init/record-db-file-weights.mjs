/**
 * Write `testing/_shared/db-file-weights.json` from the timing files of a finished `-db` run (Q-623).
 *
 * Run: node testing/_init/record-db-file-weights.mjs [results-dir]   (default: the timing results folder, where `npm run test:standalone:db` leaves them)
 *
 * What it records: for every database-backed file that took `SLOW_SECONDS` or more, the seconds it took, and the date. Only
 * the slow tail, because the table has one use: the sharded run starts the slowest files FIRST (`heaviestFirst`,
 * `_shared/db-shard-plan.mjs`). A file that starts last and runs 230 s leaves its shard with one busy slot for those 230 s,
 * which is what kept the first sharded runs at 430 s with every shard idle behind one file. A fast file's place in the
 * order is worth nothing, and a table of 430 numbers is 430 lines nobody reviews.
 *
 * What it is NOT: a record of anything a verdict depends on. A stale or missing row costs minutes, never a result;
 * `a-db-shards-keep-a-harness-database-on-one-mongo` refuses a row that names a file that is gone, which is the one
 * way it could mislead. Regenerate it after a change that makes a file much slower or faster.
 *
 * It refuses a results directory that holds no `-db` timing at all, or a partial run, for the reason every runner
 * here carries a floor: a table written from nothing would be committed as an answer.
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DB_FILE_WEIGHTS_PATH, SLOW_SECONDS } from '../_shared/db-shard-plan.mjs';
import { TIMING_RESULTS_DIR } from '../_shared/timing-reporter-flags.mjs';
import { readTimingResults } from '../../scripts/_shared/timing-results.mjs';

const dir = resolve(process.argv[2] ?? TIMING_RESULTS_DIR);
const per = new Map();
// `readTimingResults` refuses a folder with no results, an incomplete file or no test event: the one reader of this folder.
for (const row of readTimingResults(dir).lines) {
  // The -db third's batches are named `db-…` (`run-standalone.mjs`); another third's results in the folder are not this table's.
  if (!String(row.batch ?? '').startsWith('db-')) continue;
  // A file's seconds are the reporter's row for the FILE (type 'file'): its whole process, which is what holds a worker.
  // Not its tests (nesting 1: a file whose cases are built in loops reports 0 ms for each and 200 s for the file).
  const file = String(row.file ?? '').replace(/\\/g, '/');
  if (row.type === 'file') per.set(file, (per.get(file) ?? 0) + row.ms / 1000);
}
if (per.size < 100) {
  console.error(`record-db-file-weights: only ${per.size} database-backed file(s) timed in ${dir} — that is not a whole -db run`);
  process.exit(1);
}
const seconds = {};
for (const [file, s] of [...per].sort((a, b) => b[1] - a[1])) {
  if (s >= SLOW_SECONDS) seconds[file.split('/').pop()] = Math.round(s);
}
writeFileSync(DB_FILE_WEIGHTS_PATH, `${JSON.stringify({
  note: 'Seconds each slow -db file took in one measured sharded run. Used only to start the slowest first; see testing/_init/record-db-file-weights.mjs.',
  measuredAt: new Date().toISOString().slice(0, 10),
  slowSeconds: SLOW_SECONDS,
  seconds,
}, null, 2)}\n`);
console.log(`record-db-file-weights: ${Object.keys(seconds).length} slow file(s) of ${per.size} written to ${DB_FILE_WEIGHTS_PATH}`);
