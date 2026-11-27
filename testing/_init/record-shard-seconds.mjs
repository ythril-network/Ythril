/**
 * Write the two tables CI's standalone shards are planned by, from the per-file times of CI's recorded runs (bundle-373, Q-977).
 *
 * Run: node testing/_init/record-shard-seconds.mjs <file-times-all.json>
 *
 * The input is the snapshot `GH_TOKEN=$(gh auth token) node scripts/test-times.mjs --preflight-costs` writes, `test-results/file-times-all.json`:
 * per test file, the median of its time over the newest CI runs of main, every job read together. The tables:
 *
 *  - `testing/_shared/pure-file-seconds.json`, which `pureShardFiles` packs the pure shards by: the pure kind's files at or above its floor, the
 *    `median` of every pure file the snapshot holds (the weight of a file the table does not name), and `textSeconds`, what the text-only
 *    files add to the first shard (they run there only).
 *  - `testing/_shared/db-file-seconds.json`, which `a-planned-shard-stays-inside-its-time-budget` holds the `-db` plan to: the database files at or
 *    above its floor, by file name, and their `median`. It orders nothing (`db-file-weights.json` starts the slowest first) and places nothing
 *    (the plan places a file by its name).
 *
 * What it prevents: a table written from a snapshot that does not hold the repository's files. It refuses a snapshot that names fewer than
 * half of the pure files or of the database files, so a table is never made from the wrong job's times and committed as an answer.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { shardTableFiles, PURE_FILE_SECONDS_PATH } from '../_shared/shard-table-files.mjs';
import { DB_FILE_SECONDS_PATH } from '../_shared/db-shard-plan.mjs';

const input = process.argv[2];
if (!input) { console.error('usage: node testing/_init/record-shard-seconds.mjs <file-times-all.json>'); process.exit(2); }
const snapshot = JSON.parse(readFileSync(resolve(input), 'utf8'));
const ms = snapshot.files ?? {};
const root = process.cwd();
const secondsOf = (f) => ms[f] / 1000;
const named = (files) => files.filter((f) => Number.isFinite(ms[f]) && ms[f] >= 0);

const { textKind, pureKind, dbKind } = shardTableFiles({ root });
for (const [what, files] of [['pure', pureKind], ['database', dbKind]]) {
  if (named(files).length < files.length / 2) {
    console.error(`record-shard-seconds: the snapshot times ${named(files).length} of ${files.length} ${what} files, which is not the run of this checkout`);
    process.exit(1);
  }
}
const median = (files) => {
  const v = named(files).map(secondsOf).filter((s) => s > 0).sort((a, b) => a - b);
  return v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2;
};
const round = (s, digits = 1) => Math.round(s * 10 ** digits) / 10 ** digits;
const source = `the median over ${snapshot.runs} CI run(s) of main, newest source ${snapshot.newestSourceAt}`;

const PURE_FLOOR = 0.5;
const pureSeconds = Object.fromEntries(named(pureKind).filter((f) => secondsOf(f) >= PURE_FLOOR).sort().map((f) => [f, round(secondsOf(f))]));
writeFileSync(PURE_FILE_SECONDS_PATH, `${JSON.stringify({
  note: `Seconds each pure standalone file (the pure kind, not the text-only files) took, as ${source} (its own file entry, rounded to 0.1 s), for every file that took ${PURE_FLOOR} s or more. Used only to plan the shards CI runs the pure kind in (testing/_init/run-standalone.mjs --shard, pureShardFiles in testing/_shared/standalone-split.mjs, testing/_shared/pack-by-seconds.mjs), and to hold the plan to its budget (testing/_shared/shard-budget.mjs). A file not named here is planned at \`median\`, the median of every pure file the snapshot recorded (${named(pureKind).length} files), never at the median of this list. \`textSeconds\` is what the ${textKind.length} text-only files add to the first shard, where they run. Every key must be a tracked pure standalone file (held by ci-runs-every-standalone-pure-shard-exactly-once). Regenerate with testing/_init/record-shard-seconds.mjs.`,
  source,
  floor: PURE_FLOOR,
  median: round(median(pureKind)),
  textSeconds: round(named(textKind).reduce((sum, f) => sum + secondsOf(f), 0)),
  seconds: pureSeconds,
}, null, 2)}\n`);

const DB_FLOOR = 0.1;
const dbSeconds = Object.fromEntries(named(dbKind).filter((f) => secondsOf(f) >= DB_FLOOR).sort().map((f) => [f.split('/').pop(), round(secondsOf(f))]));
writeFileSync(DB_FILE_SECONDS_PATH, `${JSON.stringify({
  note: `Seconds each database-backed standalone file took in CI, crowded by the other files of its shard, as ${source} (rounded to 0.1 s), for every file that took ${DB_FLOOR} s or more, by file name. Used only to hold the -db plan to its time budget (testing/_shared/shard-budget.mjs, a-planned-shard-stays-inside-its-time-budget); it orders and places nothing. A file not named here is planned at \`median\`, the median of every database file the snapshot recorded (${named(dbKind).length} files). Regenerate with testing/_init/record-shard-seconds.mjs.`,
  source,
  floor: DB_FLOOR,
  median: round(median(dbKind)),
  seconds: dbSeconds,
}, null, 2)}\n`);
console.log(`record-shard-seconds: ${Object.keys(pureSeconds).length} pure and ${Object.keys(dbSeconds).length} database file(s) written`);
