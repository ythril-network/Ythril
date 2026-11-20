/**
 * How a list of test files is cut into shards, and the check that a cut is one: the one module every shard plan calls
 * (bundle-356, Q-947).
 *
 * ## What it answers, and only that
 *
 * Two questions. `packBySeconds`: *which files does each of N shards run, so that the shards take about the same time?*
 * `assertPartition`: *is this cut every file exactly once, with no shard empty?* It starts nothing, lists no files (the
 * caller hands them in) and reads no table (the caller hands in the seconds).
 *
 * Its callers: the stack-suite runner (`_init/run-suite.mjs`), which packs Integration and Sync into the shards CI runs as
 * separate jobs, and the database plan (`db-shard-plan.mjs`), which keeps its own name-hash placement (a file must stay on one
 * Mongo whatever else is added) and checks its cut here.
 *
 * ## What it prevents
 *
 *  - **A file that runs in no shard, or in two.** Neither is visible in a green run: the first is a test that never ran, the
 *    second a file that runs twice on two stacks. Every plan goes through `assertPartition`, which THROWS; `packBySeconds`
 *    calls it on its own result, so no caller can forget it.
 *  - **A shard started to run nothing.** An empty shard is a job, a runner and a stack spent on no file, and says the count
 *    was larger than the work: refused the same way.
 *  - **Halves that differ by the slowest file.** Files are placed longest first, each into the shard with the fewest seconds
 *    so far (the longest-processing-time rule): a cut by name or by count leaves one shard with the long files.
 *  - **A new file that weighs nothing.** A file the table has no time for is taken at the table's MEDIAN, never at zero:
 *    at zero every new file lands in whichever shard is emptiest at the end, and a few new slow files tip it.
 *  - **A plan that moves between machines.** Ties are broken by name and then by the lower shard, and each shard is listed
 *    alphabetically, so the same files and table give the same shards everywhere and the order inside a shard is the
 *    alphabetical one the suites always ran in.
 */

/**
 * Throw unless `shards` is a partition of `files`: every file in exactly one shard, no file that was not given, no file
 * given twice, and no shard empty.
 *
 * @param {string[]} files
 * @param {string[][]} shards
 * @param {string} who the plan's name, said first in the message
 */
export function assertPartition(files, shards, who) {
  const placed = shards.flat();
  const given = new Set(files);
  if (given.size !== files.length || placed.length !== files.length || new Set(placed).size !== placed.length
    || placed.some((f) => !given.has(f))) {
    throw new Error(`${who}: the shards are not a partition of the files (a file is missing or listed twice)`);
  }
  const empty = shards.map((s, i) => (s.length === 0 ? i : -1)).filter((i) => i >= 0);
  if (empty.length > 0) {
    throw new Error(`${who}: shard(s) ${empty.join(', ')} hold no file out of ${files.length} — the count is larger than the work`);
  }
}

/** The median of the table's seconds, the weight of a file it does not name; 1 for an empty table, so files still count. */
export function medianSeconds(seconds) {
  const values = Object.values(seconds ?? {}).filter((s) => Number.isFinite(s) && s > 0).sort((a, b) => a - b);
  if (values.length === 0) return 1;
  const mid = Math.floor(values.length / 2);
  return values.length % 2 === 1 ? values[mid] : (values[mid - 1] + values[mid]) / 2;
}

/**
 * The files cut into `count` shards by recorded seconds: longest first, each into the shard with the fewest seconds so far, a
 * file the table does not name at the table's median. Each shard listed alphabetically.
 *
 * @param {string[]} files
 * @param {number} count
 * @param {Record<string, number>} seconds recorded seconds by file, as the caller names its files
 * @param {{ who?: string }} [opts] the plan's name for a refusal
 * @returns {string[][]} `count` shards, a partition of `files` (it throws otherwise, and on an empty shard)
 */
export function packBySeconds(files, count, seconds, { who = 'packBySeconds' } = {}) {
  if (!Number.isInteger(count) || count < 1) throw new Error(`${who}: ${count} is not a shard count of one or more`);
  const fallback = medianSeconds(seconds);
  const weight = (f) => (Number.isFinite(seconds?.[f]) && seconds[f] > 0 ? seconds[f] : fallback);
  const order = [...files].sort((a, b) => weight(b) - weight(a) || (a < b ? -1 : a > b ? 1 : 0));
  const shards = Array.from({ length: count }, () => []);
  const totals = new Array(count).fill(0);
  for (const f of order) {
    let to = 0;
    for (let i = 1; i < count; i++) if (totals[i] < totals[to]) to = i;
    shards[to].push(f);
    totals[to] += weight(f);
  }
  for (const s of shards) s.sort();
  assertPartition(files, shards, who);
  return shards;
}
