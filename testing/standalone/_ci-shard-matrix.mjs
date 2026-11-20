/**
 * The rules a CI job that runs one shard per matrix cell must keep, read from the PARSED workflow: the one copy every shard gate
 * calls (bundle-356, Q-947). Its callers: `ci-runs-every-integration-and-sync-shard-exactly-once` (the two stack suites) and
 * `ci-runs-every-standalone-pure-shard-exactly-once` (the standalone files that need no service).
 *
 * ## What it prevents
 *
 * Splitting a job into shards is exactly where a test stops running and nothing goes red. Each function here answers one question
 * about one job and says every way it fails as a sentence, so a gate asserts `[]` and a miniature breakage asserts the sentence:
 *
 *  - {@link shardJobProblems}: is every tracked file of the job in exactly one cell's shard? A shard dropped from the matrix (`[1]`
 *    of 2) is files that run nowhere; a repeated value or a planner that is not a partition is files that run twice; a count the
 *    workflow says and the runner does not plan is coverage by luck; `fail-fast` left on lets one red shard cancel the other; an
 *    upload name without the matrix value makes the shards' uploads collide, and the merge gate reads half the files as all of them.
 *  - {@link artifactNames} with {@link artifactPatternOf}: which artifact names the cells upload, and does a download pattern select one.
 *  - {@link matrixJobGateProblems}: does the merge gate wait for the matrix job and read its result (the worst cell's), and does the
 *    whole matrix stand down as ONE job beside a reused Full run?
 *  - {@link secondsTableProblems}: does a committed seconds table name only files that exist, each with a positive number of seconds?
 *
 * The files a job must cover are the caller's, read from git independently of the runner's selection; the runner's selection is the
 * caller's `shardFiles(k, n)`. Nothing here lists a file or names a job.
 */
import assert from 'node:assert/strict';
import { jobEntries, stepsOf, shellOf, usesOf, mergeGateEntries, isTrue, skipsWhenRunIsReused, REUSE_EMPTY, jobRunning, stepEnv } from '../_shared/ci-workflow.mjs';

/** A `test-results-*-<attempt>` artifact pattern as a RegExp, the attempt taken as the literal 1. */
export function artifactPatternOf(pattern) {
  const literal = String(pattern).replace(/\$\{\{\s*(?:github\.run_attempt|steps\.[\w-]+\.outputs\.attempt)\s*\}\}/g, '1');
  assert.ok(!/\$\{\{/.test(literal), `the artifact pattern ${pattern} holds an expression this rule cannot read`);
  return new RegExp(`^${literal.split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
}

/**
 * What a job's test step (the step that runs `script`) says about its shard: the env var its `--shard=` reads, that var's
 * `${{ matrix.<axis> }}/<n>`, and the matrix's values for that axis. A sentence when the job does not say it that way.
 */
export function shardOfJob(id, job, script) {
  const step = stepsOf(job).find((s) => shellOf(s).includes(script));
  const arg = /--shard="?\$\{?(\w+)\}?"?/.exec(shellOf(step) ?? '');
  if (!arg) return `${id}: its test step does not pass --shard="$<VAR>" (${JSON.stringify(shellOf(step))})`;
  const value = String(stepEnv(job, step, arg[1]) ?? '');
  const m = /^\$\{\{\s*matrix\.([\w-]+)\s*\}\}\/(\d+)$/.exec(value.trim());
  if (!m) return `${id}: ${arg[1]} is ${JSON.stringify(value)}, not \${{ matrix.<axis> }}/<count>`;
  const values = job.strategy?.matrix?.[m[1]];
  if (!Array.isArray(values)) return `${id}: no matrix over ${m[1]}: strategy.matrix is ${JSON.stringify(job.strategy?.matrix)}`;
  return { axis: m[1], count: Number(m[2]), values: values.map(Number) };
}

/**
 * Every way `doc` fails to run the job whose steps run `script` as shards that cover `tracked` once each, as sentences.
 * `shardFiles(k, n)` is the runner's selection, `declared` the count the runner plans, `what` the files' name in a sentence.
 *
 * @param {object} doc the parsed workflow
 * @param {string} script the npm script the job's test step runs (`test:integration`, `test:standalone:pure`)
 * @param {{ shardFiles: (k: number, n: number) => string[], declared: number, tracked: string[], what: string }} o
 */
export function shardJobProblems(doc, script, { shardFiles, declared, tracked, what }) {
  const { id, job } = jobRunning(doc, script);
  const shard = shardOfJob(id, job, script);
  if (typeof shard === 'string') return [shard];
  const problems = [];
  if (isTrue(job.strategy['fail-fast']) || job.strategy['fail-fast'] === undefined) problems.push(`${id}: fail-fast is not false, so the first red shard cancels the other`);
  const { count, values, axis } = shard;
  if (count !== declared) problems.push(`${id}: the workflow cuts ${what} in ${count} and the runner plans ${declared}, so the jobs run shards the runner never made`);
  const expected = Array.from({ length: count }, (_, i) => i + 1);
  const missing = expected.filter((k) => !values.includes(k));
  const repeated = values.filter((v, i) => values.indexOf(v) !== i);
  const outside = values.filter((v) => !expected.includes(v));
  if (missing.length) problems.push(`${id}: no job runs shard(s) ${missing.join(', ')} of ${count}, so their files run nowhere`);
  if (repeated.length) problems.push(`${id}: shard(s) ${[...new Set(repeated)].join(', ')} appear twice in the matrix, so their files run twice`);
  if (outside.length) problems.push(`${id}: matrix value(s) ${outside.join(', ')} are not a shard from 1 to ${count}`);
  if (count === declared) {
    const ran = values.filter((k) => expected.includes(k)).flatMap((k) => shardFiles(k, count));
    const notRun = tracked.filter((f) => !ran.includes(f));
    const twice = ran.filter((f, i) => ran.indexOf(f) !== i);
    if (notRun.length) problems.push(`${id}: ${notRun.length} of ${tracked.length} ${what} file(s) are in no job's shard, first ${notRun[0]}`);
    if (twice.length) problems.push(`${id}: ${new Set(twice).size} ${what} file(s) run in more than one job, first ${twice[0]}`);
  }
  const uploads = stepsOf(job).filter((s) => usesOf(s)?.action === 'actions/upload-artifact');
  if (uploads.length === 0) problems.push(`${id}: uploads no artifact`);
  for (const u of uploads) {
    if (!String(u.with?.name ?? '').includes(`matrix.${axis}`)) problems.push(`${id}: upload "${u.name}" is named ${JSON.stringify(u.with?.name)}, which does not carry matrix.${axis}, so the shards upload under one name`);
  }
  return problems;
}

/** The artifact names the matrix job that runs `script` uploads, one per cell, attempt 1. THROWS when the job states no shard. */
export function artifactNames(doc, script) {
  const { id, job } = jobRunning(doc, script);
  const shard = shardOfJob(id, job, script);
  if (typeof shard === 'string') throw new Error(shard);
  return stepsOf(job).filter((s) => usesOf(s)?.action === 'actions/upload-artifact').flatMap((u) => shard.values.map((v) => String(u.with.name)
    .replace(/\$\{\{\s*matrix\.[\w-]+\s*\}\}/g, String(v)).replace(/\$\{\{\s*github\.run_attempt\s*\}\}/g, '1')));
}

/** Every download pattern of the workflow (the merge gate's and the advisory job's), as written. */
export const downloadPatterns = (doc) => jobEntries(doc).flatMap(({ job }) => stepsOf(job))
  .filter((s) => usesOf(s)?.action === 'actions/download-artifact' && s.with?.pattern).map((s) => s.with.pattern);

/**
 * Every way the merge gate and the advisory job fail to treat the matrix job that runs `script` as one job whose result is its
 * worst cell's, as sentences: the gate must need it and read `needs.<id>.result`, the job must be a matrix that stands down as one
 * beside a reused run, and the advisory job must wait for it.
 */
export function matrixJobGateProblems(doc, script) {
  const { id, job } = jobRunning(doc, script);
  const problems = [];
  const gates = mergeGateEntries(doc);
  if (gates.length !== 1) return [`${gates.length} merge gate job(s), not one`];
  if (![].concat(gates[0].job.needs).includes(id)) problems.push(`Build & Test does not need ${id}`);
  if (!stepsOf(gates[0].job).map((s) => shellOf(s)).join('\n').includes(`needs.${id}.result`)) problems.push(`Build & Test does not read needs.${id}.result`);
  if (!skipsWhenRunIsReused(job)) problems.push(`${id} does not stand down on a reused run: it must wait for \`reuse\` and carry \`if: !cancelled() && ${REUSE_EMPTY}\``);
  if (!job.strategy?.matrix) problems.push(`${id} is not a matrix job`);
  const advisory = jobEntries(doc).find((j) => isTrue(j.job['continue-on-error']));
  if (!advisory || ![].concat(advisory.job.needs).includes(id)) problems.push(`the advisory job does not wait for ${id}`);
  return problems;
}

/**
 * Every way a committed seconds table is wrong, as sentences: no `seconds` map, an entry naming a file not in `tracked`, a value
 * that is not a positive number. `what` names the files the table is for.
 */
export function secondsTableProblems(table, tracked, what) {
  const seconds = table?.seconds;
  if (!seconds || typeof seconds !== 'object') return ['the table has no `seconds` map'];
  const v = [];
  for (const [file, s] of Object.entries(seconds)) {
    if (!tracked.has(file)) v.push(`${file} is in the table and is not a tracked test file of ${what}`);
    if (!(typeof s === 'number' && Number.isFinite(s) && s > 0)) v.push(`${file}: ${JSON.stringify(s)} is not a positive number of seconds`);
  }
  return v;
}
