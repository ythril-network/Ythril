/**
 * How long a planned shard takes by the recorded per-file times, and whether that is within the shard's budget (bundle-373, Q-977).
 *
 * ## What it answers, and only that
 *
 * One question: *given a cut of test files into shards and the recorded seconds of each file, which shards are planned over their
 * budget?* It plans nothing (`planDbShards` and `pureShardFiles` do), lists no files and reads no workflow. A caller hands it the
 * shards, the table and the budget.
 *
 * ## What it prevents
 *
 *  - **A job that the whole run waits for.** A CI run ends with its slowest job. Every test file added to a shard makes that shard
 *    longer, and the cut by name (the database plan) or by an old table (the pure plan) does not follow: between bundles 270 and 272 about
 *    1 200 s of new files left one database shard at 2 630 s and the first pure shard at 990 s while the others sat far below. The
 *    plan is held to a budget of recorded seconds, so a file that tips a shard over it fails the check that day, with the shard named,
 *    and the answer is a shard more or a better cut, never a slower run nobody measured.
 *  - **A new file that weighs nothing.** A file the table does not name is taken at the table's `median`, as `packBySeconds` takes it,
 *    never at zero.
 *  - **A shard that is not counted.** Every shard is summed, not the first or the largest by count; the answer names each one over.
 *
 * ## The budgets
 *
 * The times are those of CI's database and pure jobs as `ms` of a job's record: the sum of its files' times, taken crowded (files of
 * one job run side by side), which is the time the recorded runs of main show. The database budget is the critical path of the
 * database jobs before bundle 270 (1 876 s, the median over its recorded runs), the pure budget the median of the first pure shard
 * over the runs before it (725 s). A budget goes down when the recorded times show a shard can be held lower, and goes up only with
 * the reason written beside it in the same commit.
 */

/** The most a database shard may be planned at, in recorded (crowded) seconds: the critical path of the database jobs before bundle 270. */
export const DB_SHARD_BUDGET_S = 1876;

/** The most a pure shard may be planned at, in recorded seconds: the median of the first pure shard before bundle 270. */
export const PURE_SHARD_BUDGET_S = 725;

/** The seconds a file is planned at: its recorded row, else the table's `median`. */
function weightOf(file, seconds, unnamed) {
  const own = seconds?.[file];
  if (Number.isFinite(own) && own > 0) return own;
  return Number.isFinite(unnamed) && unnamed > 0 ? unnamed : 0;
}

/**
 * The planned seconds of each shard.
 *
 * @param {string[][]} shards the files of each shard, named as `seconds` names them
 * @param {Record<string, number>} seconds recorded seconds by file
 * @param {{ unnamed?: number, extra?: Array<string[]> }} [opts] `unnamed`: the weight of a file the table does not name; `extra[i]`: files that
 *   run in shard `i` besides its plan (the pure kind's text-only files run in its first shard only)
 * @returns {number[]}
 */
export function plannedShardSeconds(shards, seconds, { unnamed, extra = [] } = {}) {
  return shards.map((files, i) => [...files, ...(extra[i] ?? [])].reduce((sum, f) => sum + weightOf(f, seconds, unnamed), 0));
}

/**
 * Every shard planned over `budget`, as a sentence; none means the plan holds.
 *
 * @param {string[][]} shards
 * @param {Record<string, number>} seconds
 * @param {{ budget: number, who: string, unnamed?: number, extra?: Array<string[]> }} given `who` names the plan in the sentence
 * @returns {string[]}
 */
export function shardsOverBudget(shards, seconds, { budget, who, unnamed, extra } = {}) {
  if (!Number.isFinite(budget) || budget <= 0) throw new Error('shardsOverBudget: no budget given, so nothing could be over it');
  if (!Array.isArray(shards) || shards.length === 0) throw new Error(`shardsOverBudget: ${who} has no shard to hold to a budget`);
  return plannedShardSeconds(shards, seconds, { unnamed, extra })
    .map((s, i) => (s > budget ? `${who} shard ${i + 1} of ${shards.length} is planned at ${Math.round(s)} s, over its budget of ${budget} s` : null))
    .filter(Boolean);
}
