#!/usr/bin/env node
/**
 * Whether a pull request's run may read the results of a Full run instead of running the suites again (bundle-244, Q-710).
 *
 * ## What it prevents
 *
 * `Build & Test` of a pull request skips every suite and reads the results of a green Full run of the same tree. A wrong reuse is
 * code merged that no suite ran, and every way to be wrong looks like a green check: a Full run of another commit, of a tree
 * that main has since moved under, one that is still running or was cancelled, one whose newest attempt is red while an older one
 * is green, one a fork or a pull request's own push made, results that expired or were never uploaded, a list of runs cut at its
 * first page, a label that said "run everything" ignored. Each is a named reason of {@link decideReuse}, and each refuses for
 * ITS OWN reason, so the step summary says which condition failed.
 *
 * ## The two halves, and why they fail in opposite directions
 *
 * - `decide` (the `reuse` job) FAILS OPEN: anything it cannot establish (an API error, a short page, the 120 s deadline, a
 *   module that does not load, a SHA that cannot be fetched) is "no reuse": exit 0, `full_run` empty, the whole graph runs, and the
 *   only cost is the saving. An error-class reason prints `::warning::` (a fail-open that hides a regression looks healthy), an
 *   ordinary one (no run, red, label, tree) a notice.
 * - `verify` (the merge gate, after the suites were skipped) FAILS CLOSED: by then nothing ran, so a read error, a mismatch, a
 *   half-set value or an artifact gone at download exits non-zero with the one remedy, to re-run the whole PR run, which decides
 *   again ({@link REMEDY}).
 *
 * ## What it imports
 *
 * Node built-ins, `scripts/_shared/script-cli.mjs` (the one "was I run" test), `newest-by.mjs` (the one newest-first order),
 * `workflow-command.mjs` (the one annotation escape) and `scripts/_shared/gh-call.mjs` (all built-ins only), and nothing else: the job that runs it installs nothing (held by `unexpected-skips-fail-the-ci-gate`). `gh-call.mjs`
 * is loaded by a dynamic import INSIDE the fail-open, so a module
 * that does not load is also "no reuse" and never a failed job (held by
 * `a-pull-request-reuses-only-a-green-full-run-of-its-own-tree`).
 *
 * ## The entry
 *
 * `node scripts/full-run-reuse.mjs decide` reads `GITHUB_EVENT_NAME`, `HEAD_SHA`, `PR_LABELS` (a JSON list of label names),
 * `GITHUB_REPOSITORY`, `GH_TOKEN`; it writes `full_run=<run id>.<attempt>` or `full_run=` to `$GITHUB_OUTPUT` and its reason to
 * `$GITHUB_STEP_SUMMARY`. `node scripts/full-run-reuse.mjs verify` reads `FULL_RUN` (the reuse job's output, through env only),
 * `HEAD_SHA`, `GITHUB_REPOSITORY`, `GH_TOKEN`, and writes `run_id=` and `attempt=` (this run's own when `FULL_RUN` is empty): the
 * download step reads exactly those, so "this run or that one" is decided here and never in an expression.
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { isEntryPoint } from './_shared/script-cli.mjs';
import { newestBy } from './_shared/newest-by.mjs';
import { workflowCommand } from './_shared/workflow-command.mjs';

/** The label that forces the whole graph. Named once, here; the testing guide's job-graph gate reads it from this module. */
export const FORCE_LABEL = 'ci:full';

/** The workflow whose runs may be reused, and the name its merge gate has inside a run of it ("<caller job> / <called job>"). */
const FULL_RUN_PATH = '.github/workflows/full-run.yml';
const FULL_RUN_WORKFLOW_FILE = 'full-run.yml';
const GATE_JOB_NAME = 'Full run / Build & Test';

/** The one remedy a failed verification names. */
export const REMEDY = 'Fix: re-run the whole PR run (gh run rerun <this run id>, never --failed), so the `Full run reuse` job decides again.';

/** The total time the decision may take, in ms. Each `gh` call is bounded on its own (60 s); the deadline is checked between calls. */
export const DEADLINE_MS = 120_000;

/** Reasons that are an error and not an answer: they print `::warning::`, the others a notice. */
const ERROR_REASONS = new Set([
  'api-error', 'page-short', 'deadline', 'bad-run-id', 'bad-head-sha', 'bad-labels', 'tree-unknown', 'no-expected-results',
  'load-error', 'unexpected-error',
]);

/** Reasons that are known before a single read is made: the entry stops at them. */
const BEFORE_ANY_READ = new Set(['not-a-pull-request', 'label-ci-full', 'deadline', 'bad-head-sha', 'bad-labels']);

const HEX40 = /^[0-9a-f]{40}$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const levelOf = (reason) => (ERROR_REASONS.has(reason) ? 'warning' : 'notice');

// ───────────────────────────────────────── what ci.yml uploads, read without a YAML parser ─────────────────────────────────────────

/**
 * The results stems ci.yml's test jobs upload: the middle of `test-results-<stem>-<attempt>`, a matrix job once per axis value.
 * Read from the workflow's TEXT (a job that installs nothing has no YAML package), derived and never listed, so a job or a shard
 * added tomorrow is required of a Full run the day it is written. Throws when a matrix axis of an upload name has no values: a
 * derivation that yields a shorter set would let a short list of results read as whole.
 *
 * @param {string} ciText  the text of `.github/workflows/ci.yml`
 * @returns {string[]}
 */
export function expectedResultsStems(ciText) {
  const lines = String(ciText).split(/\r?\n/);
  const start = lines.findIndex((l) => /^jobs:\s*(#.*)?$/.test(l));
  if (start < 0) throw new Error('ci.yml has no `jobs:` section');
  const blocks = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line) && !/^#/.test(line)) break;
    if (/^ {2}[\w-]+:\s*(#.*)?$/.test(line)) blocks.push([]);
    blocks.at(-1)?.push(line);
  }
  const stems = [];
  for (const block of blocks) {
    for (const line of block) {
      const m = /^\s*name:\s*test-results-(.+)-\$\{\{\s*github\.run_attempt\s*\}\}\s*$/.exec(line);
      if (!m) continue;
      let names = [m[1]];
      for (const [, axis] of [...m[1].matchAll(/\$\{\{\s*matrix\.([\w-]+)\s*\}\}/g)]) {
        const values = matrixValues(block, axis);
        if (values.length === 0) throw new Error(`the results upload \`${m[0].trim()}\` names the matrix axis ${axis}, which its job does not list`);
        names = names.flatMap((n) => values.map((v) => n.replace(new RegExp(`\\$\\{\\{\\s*matrix\\.${axis}\\s*\\}\\}`), v)));
      }
      stems.push(...names);
    }
  }
  return stems;
}

/** The values of one matrix axis of a job, written as a flow list (`shard: [0, 1]`) or a block list. */
function matrixValues(blockLines, axis) {
  const unquote = (s) => s.trim().replace(/^["']|["']$/g, '');
  const at = blockLines.findIndex((l) => new RegExp(`^\\s+${axis}:`).test(l));
  if (at < 0) return [];
  const flow = /:\s*\[([^\]]*)\]\s*(#.*)?$/.exec(blockLines[at]);
  if (flow) return flow[1].split(',').map(unquote).filter((v) => v !== '');
  const indent = blockLines[at].match(/^\s*/)[0].length;
  const values = [];
  for (const l of blockLines.slice(at + 1)) {
    const item = /^(\s*)-\s+(.+?)\s*(#.*)?$/.exec(l);
    if (!item || item[1].length < indent) break;
    values.push(unquote(item[2]));
  }
  return values;
}

// ───────────────────────────────────────── the decision ─────────────────────────────────────────

/** A run's id and attempt as the two decimals that go into an endpoint path, or null for anything else. */
function runCoordinates(run) {
  const id = typeof run?.id === 'number' && Number.isSafeInteger(run.id) && run.id > 0 ? String(run.id) : (typeof run?.id === 'string' && /^[1-9]\d*$/.test(run.id) ? run.id : null);
  const attempt = Number.isSafeInteger(run?.run_attempt) && run.run_attempt >= 1 ? run.run_attempt : null;
  return id && attempt ? { runId: id, attempt } : null;
}

/** The newest run of a list by `created_at` (the one newest-first order, `newestBy`), wherever it stands in the list; null when there is none. */
export function newestRun(runs) {
  const list = Array.isArray(runs?.workflow_runs) ? runs.workflow_runs : [];
  return [...list].sort(newestBy('created_at'))[0] ?? null;
}

const sameRepository = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();

/**
 * The reason one run may NOT be relied on, or null: the run itself (its commit, its trigger, its branch, its repository, its end),
 * judged the same way when `reuse` picks it and when the merge gate reads it again.
 */
function runRefusal(run, { headSha, repository }) {
  if (!runCoordinates(run)) return ['bad-run-id', `the run's id or attempt is not a decimal number (${JSON.stringify(run?.id)}, ${JSON.stringify(run?.run_attempt)})`];
  if (run.head_sha !== headSha) return ['other-sha', `the run is of ${String(run.head_sha).slice(0, 12)}, not of the pull request's head ${headSha.slice(0, 12)}`];
  if (run.path !== FULL_RUN_PATH) return ['other-workflow', `the run is of ${JSON.stringify(run.path)}, not of ${FULL_RUN_PATH}`];
  if (run.event !== 'push') return ['not-a-push', `the run was triggered by ${JSON.stringify(run.event)}; only a push to a full-run/ ref is a Full run`];
  if (!/^full-run\/.+/.test(String(run.head_branch))) return ['not-a-full-run-branch', `the run is of the branch ${JSON.stringify(run.head_branch)}, not full-run/<bundle>`];
  if (!sameRepository(run.repository?.full_name, repository) || !sameRepository(run.head_repository?.full_name, repository)) {
    return ['other-repository', `the run belongs to ${run.repository?.full_name} (head ${run.head_repository?.full_name}), not to ${repository}`];
  }
  if (run.status !== 'completed') return ['run-in-progress', `the run is ${run.status}, not completed`];
  if (run.conclusion === 'cancelled') return ['run-cancelled', 'the run was cancelled'];
  if (run.conclusion !== 'success') return ['run-failed', `the run's latest attempt ended ${run.conclusion}`];
  return null;
}

/** A page of a list that is shorter than the endpoint's own total: what is missing would read as absent. */
const pageShort = (read, key) => typeof read?.total_count === 'number' && read.total_count > (read?.[key]?.length ?? 0);

/** The reason the run's jobs and artifacts do NOT carry what a merge is judged by, or null. */
function resultsRefusal({ jobs, artifacts, expected, attempt }) {
  if (jobs?.error !== undefined) return ['api-error', `the run's jobs could not be read: ${jobs.error}`];
  if (!Array.isArray(jobs?.jobs)) return ['api-error', 'the run\'s jobs read has no list of jobs'];
  if (pageShort(jobs, 'jobs')) return ['page-short', `the jobs page holds ${jobs.jobs.length} of ${jobs.total_count} jobs`];
  const gate = jobs.jobs.find((j) => j.name === GATE_JOB_NAME);
  if (!gate || gate.conclusion !== 'success' || (gate.run_attempt !== undefined && gate.run_attempt !== attempt)) {
    return ['build-and-test-not-success', `${JSON.stringify(GATE_JOB_NAME)} of attempt ${attempt} is ${gate ? gate.conclusion : 'not among the jobs'}`];
  }
  if (artifacts?.error !== undefined) return ['api-error', `the run's artifacts could not be read: ${artifacts.error}`];
  if (!Array.isArray(artifacts?.artifacts)) return ['api-error', 'the run\'s artifacts read has no list of artifacts'];
  if (pageShort(artifacts, 'artifacts')) return ['page-short', `the artifacts page holds ${artifacts.artifacts.length} of ${artifacts.total_count} artifacts`];
  if (!Array.isArray(expected) || expected.length === 0) return ['no-expected-results', 'no results stems were derived from ci.yml: a short list of results could not be told from a whole one'];
  const held = new Map(artifacts.artifacts.map((a) => [a.name, a]));
  for (const stem of expected) {
    const name = `test-results-${stem}-${attempt}`;
    if (!held.has(name)) return ['artifact-missing', `${name} was never uploaded`];
    if (held.get(name).expired !== false) return ['artifact-expired', `${name} has expired`];
  }
  return null;
}

/** The names of an event payload's labels: `[{ name }]` or `['name']`; an absent or null field is no label. */
const labelNames = (labels) => (Array.isArray(labels) ? labels.map((l) => (typeof l === 'string' ? l : l?.name)) : []);

/**
 * Whether this pull request reuses a Full run, and which. Pure: it reads nothing and changes nothing it is given.
 *
 * @param {object} input
 * @param {string} input.event          the workflow's event (`GITHUB_EVENT_NAME`)
 * @param {Array<{name: string}|string>} [input.labels]  the event payload's labels
 * @param {string} input.headSha        the pull request's head commit
 * @param {boolean|null} input.treeMatches  does the checked-out merge tree equal the head's tree; null when it could not be compared
 * @param {string} input.repository     `owner/name`
 * @param {object} input.runs           the API's body for the workflow runs of full-run.yml at `head_sha`, or `{ error }`
 * @param {object} input.jobs           the jobs of the newest run's latest attempt, or `{ error }`
 * @param {object} input.artifacts      that run's artifacts, or `{ error }`
 * @param {string[]} input.expected     the results stems derived from ci.yml
 * @param {number} input.now            ms
 * @param {number} input.deadline       ms
 * @returns {{ fullRun: string, reason: string, level: 'notice'|'warning', detail: string }}
 *   `fullRun` is `"<run id>.<attempt>"` (two decimals) or `''`
 */
export function decideReuse(input) {
  const refuse = (reason, detail) => ({ fullRun: '', reason, level: levelOf(reason), detail });
  if (input.event !== 'pull_request') return refuse('not-a-pull-request', `the event is ${JSON.stringify(input.event)}: only a pull request reuses a Full run`);
  if (labelNames(input.labels).includes(FORCE_LABEL)) return refuse('label-ci-full', `the pull request carries ${FORCE_LABEL}: the whole graph runs`);
  if (Number.isFinite(input.deadline) && !(input.now <= input.deadline)) return refuse('deadline', 'the deadline passed before the decision was made');
  if (typeof input.headSha !== 'string' || !HEX40.test(input.headSha)) return refuse('bad-head-sha', `the head SHA ${JSON.stringify(input.headSha)} is not a 40-digit hex commit id`);
  if (input.treeMatches === false) return refuse('tree-differs', 'the checked-out merge tree is not the head\'s tree (main has moved under the pull request)');
  if (input.treeMatches !== true) return refuse('tree-unknown', 'the merge tree could not be compared with the head\'s tree');

  const { runs } = input;
  if (runs?.error !== undefined) return refuse('api-error', `the Full runs of the head could not be read: ${runs.error}`);
  if (!Array.isArray(runs?.workflow_runs)) return refuse('api-error', 'the runs read has no list of runs');
  if (pageShort(runs, 'workflow_runs')) return refuse('page-short', `the runs page holds ${runs.workflow_runs.length} of ${runs.total_count} runs`);
  const run = newestRun(runs);
  if (!run) return refuse('no-full-run', 'no Full run of the head commit exists');

  const refusal = runRefusal(run, input) ?? resultsRefusal({ jobs: input.jobs, artifacts: input.artifacts, expected: input.expected, attempt: run.run_attempt });
  if (refusal) return refuse(refusal[0], `${refusal[1]} (Full run ${run.id})`);
  return { fullRun: `${run.id}.${run.run_attempt}`, reason: 'reuse', level: 'notice', detail: `Full run ${run.id} attempt ${run.run_attempt} passed on this tree` };
}

// ───────────────────────────────────────── the verification: fails closed ─────────────────────────────────────────

/**
 * Re-reads the run the `reuse` job named, and fails (a rejection whose message names {@link REMEDY}) on anything it cannot
 * confirm: by now the suites are skipped, so there is nothing to fall back on.
 *
 * @param {object} args
 * @param {string} args.fullRun      `"<run id>.<attempt>"`, or `''` (a fresh run, a push: nothing to verify)
 * @param {string} args.headSha      the pull request's head commit
 * @param {string} args.repository   `owner/name`
 * @param {string[]} args.expected   the results stems derived from ci.yml
 * @param {(args: string[]) => Promise<object>} args.gh  the injected caller of `gh-call.mjs`: an argument array in, parsed JSON out
 * @param {boolean|null} [args.treeMatches]  whether the checked-out tree equals the head's; `false` or `null` rejects, and the entry
 *   always passes one. Left out, the tree is not compared (a caller that has no checkout).
 * @returns {Promise<{ runId: string, attempt: string } | null>}  what the download reads, or `null` for an empty `fullRun`
 */
export async function verifyReuse({ fullRun, headSha, repository, expected, gh, treeMatches }) {
  if (fullRun === '') return null;
  const fail = (what) => { throw new Error(`the Full run this pull request reuses cannot be confirmed: ${what}. The suites were skipped on the strength of it, so nothing here is evidence. ${REMEDY}`); };
  const named = typeof fullRun === 'string' ? /^([1-9]\d*)\.([1-9]\d*)$/.exec(fullRun) : null;
  if (!named) fail(`the value ${JSON.stringify(fullRun)} is not "<run id>.<attempt>" (two decimals)`);
  const [, runId, attempt] = named;
  if (typeof headSha !== 'string' || !HEX40.test(headSha)) fail(`the head SHA ${JSON.stringify(headSha)} is not a 40-digit hex commit id`);
  if (typeof repository !== 'string' || !REPOSITORY.test(repository)) fail(`the repository ${JSON.stringify(repository)} is not owner/name`);
  if (treeMatches !== undefined && treeMatches !== true) fail(treeMatches === false ? 'the checked-out merge tree is not the head\'s tree' : 'the merge tree could not be compared with the head\'s tree');

  let run, jobs, artifacts;
  try {
    run = await gh(['api', `repos/${repository}/actions/runs/${runId}`]);
    jobs = await gh(['api', `repos/${repository}/actions/runs/${runId}/attempts/${attempt}/jobs?per_page=100`]);
    artifacts = await gh(['api', `repos/${repository}/actions/runs/${runId}/artifacts?per_page=100`]);
  } catch (e) {
    return fail(`a read failed (${String(e?.message ?? e).split('\n')[0]})`);
  }
  if (String(run?.id) !== runId) fail(`the run read is ${JSON.stringify(run?.id)}, not ${runId}`);
  if (run.run_attempt !== Number(attempt)) fail(`the run's latest attempt is ${JSON.stringify(run.run_attempt)}, not the ${attempt} that was named`);
  const refusal = runRefusal(run, { headSha, repository }) ?? resultsRefusal({ jobs, artifacts, expected, attempt: Number(attempt) });
  if (refusal) fail(`${refusal[0]}: ${refusal[1]}`);
  return { runId, attempt };
}

// ───────────────────────────────────────── the entry ─────────────────────────────────────────

/** An annotation of this script, escaped so a message from an API cannot start another command. */
const annotate = (level, text) => workflowCommand(level, 'Full run reuse', text);

/** Appends to a file the runner names (`GITHUB_OUTPUT`, `GITHUB_STEP_SUMMARY`); no file named, nothing written. */
const appendTo = (file, text) => { if (file) appendFileSync(file, text); };

/**
 * The head's tree against the checked-out one: `true`, `false`, or `null` when `git` could not say.
 *
 * A head already in the repository is not fetched. One that is not is fetched by SHA, and NARROWLY (one commit, no blobs) only in
 * a checkout that is already shallow, as CI's is: in a full clone (a run on a developer's machine) `--depth=1` writes a shallow
 * boundary that cuts the clone's history at that commit, and `--filter` turns the clone into a partial one, both for every later
 * command (bundle-244's drive did exactly that to the main checkout).
 */
export function treeMatchesHead(headSha, { deadline, env, cwd }) {
  const git = (args) => spawnSync('git', args, { cwd, encoding: 'utf8', timeout: Math.max(1_000, Math.min(60_000, deadline - Date.now())), env: { ...env, GIT_TERMINAL_PROMPT: '0' } });
  if (git(['cat-file', '-e', `${headSha}^{commit}`]).status !== 0) {
    const shallow = git(['rev-parse', '--is-shallow-repository']);
    if (shallow.status !== 0) return null;
    const narrow = shallow.stdout.trim() === 'true' ? ['--filter=blob:none', '--depth=1'] : [];
    if (git(['fetch', '--no-tags', ...narrow, 'origin', headSha]).status !== 0) return null;
  }
  const mine = git(['rev-parse', 'HEAD^{tree}']);
  const theirs = git(['rev-parse', `${headSha}^{tree}`]);
  if (mine.status !== 0 || theirs.status !== 0) return null;
  const [a, b] = [mine.stdout.trim(), theirs.stdout.trim()];
  return /^[0-9a-f]{40,64}$/.test(a) && a === b;
}

const NOT_READ = Object.freeze({ error: 'not read' });
const ciText = () => readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');

/** The label names of `PR_LABELS` (the JSON list the workflow built from the event payload), or `null` when it cannot be read. */
function labelsOf(text) {
  try {
    const parsed = JSON.parse(text ?? '');
    return Array.isArray(parsed) && parsed.every((n) => typeof n === 'string') ? parsed : null;
  } catch { return null; }
}

/** The whole decision for one run: the reads, then {@link decideReuse}. Throws only for what `decide` turns into "no reuse". */
async function decideFromEnvironment(env, deadline) {
  const labels = labelsOf(env.PR_LABELS);
  const input = {
    event: env.GITHUB_EVENT_NAME, labels: labels ?? [], headSha: env.HEAD_SHA ?? '', treeMatches: null, repository: env.GITHUB_REPOSITORY ?? '',
    runs: NOT_READ, jobs: NOT_READ, artifacts: NOT_READ, expected: [], now: Date.now(), deadline,
  };
  if (input.event === 'pull_request' && labels === null) return { fullRun: '', reason: 'bad-labels', level: 'warning', detail: 'PR_LABELS is not a JSON list of label names: a ci:full label could not be seen' };
  const early = decideReuse(input);
  if (BEFORE_ANY_READ.has(early.reason)) return early;

  let ghCall;
  try {
    // A dynamic import, inside the fail-open: a module that does not load is "no reuse", never a failed job.
    ghCall = await import('./_shared/gh-call.mjs');
  } catch (e) {
    return { fullRun: '', reason: 'load-error', level: 'warning', detail: `scripts/_shared/gh-call.mjs did not load: ${String(e?.message ?? e).split('\n')[0]}` };
  }
  input.repository = ghCall.repoSlug(env);
  input.treeMatches = treeMatchesHead(input.headSha, { deadline, env });
  if (input.treeMatches !== true) return decideReuse({ ...input, now: Date.now() });

  input.expected = expectedResultsStems(ciText());
  const read = (path) => {
    if (Date.now() > deadline) return { error: 'the deadline passed' };
    try { return ghCall.ghJson(['api', path]); } catch (e) { return { error: String(e?.message ?? e).split('\n')[0] }; }
  };
  const repo = input.repository;
  input.runs = read(`repos/${repo}/actions/workflows/${FULL_RUN_WORKFLOW_FILE}/runs?head_sha=${input.headSha}&per_page=100`);
  const run = newestRun(input.runs);
  const at = run && runCoordinates(run);
  if (at && runRefusal(run, input) === null) {
    input.jobs = read(`repos/${repo}/actions/runs/${at.runId}/attempts/${at.attempt}/jobs?per_page=100`);
    input.artifacts = read(`repos/${repo}/actions/runs/${at.runId}/artifacts?per_page=100`);
  }
  return decideReuse({ ...input, now: Date.now() });
}

/** `decide`: never throws and never exits non-zero. */
async function decide(env) {
  let result;
  try {
    result = await decideFromEnvironment(env, Date.now() + DEADLINE_MS);
  } catch (e) {
    result = { fullRun: '', reason: 'unexpected-error', level: 'warning', detail: String(e?.message ?? e).split('\n')[0] };
  }
  const fullRun = /^\d+\.\d+$/.test(result.fullRun) ? result.fullRun : '';
  const line = `${fullRun === '' ? 'no reuse' : 'reuse'}: ${result.reason} (${result.detail})`;
  console.log(annotate(fullRun === '' ? result.level : 'notice', line));
  try {
    appendTo(env.GITHUB_OUTPUT, `full_run=${fullRun}\n`);
    appendTo(env.GITHUB_STEP_SUMMARY, `### Full run reuse\n\n- decision: ${fullRun === '' ? 'the whole graph runs' : `the suites are skipped and the results of Full run ${fullRun.replace('.', ' attempt ')} are read`}\n- reason: \`${result.reason}\`, ${result.detail}\n`);
  } catch (e) {
    console.log(annotate('warning', `the decision could not be written: ${e?.message ?? e}`));
  }
  return 0;
}

/** `verify`: exits non-zero where {@link verifyReuse} rejects; writes what the download reads. */
async function verify(env) {
  const deadline = Date.now() + DEADLINE_MS;
  try {
    let named = null;
    const fullRun = env.FULL_RUN ?? '';
    if (fullRun !== '') {
      const { ghJson, repoSlug } = await import('./_shared/gh-call.mjs');
      const gh = async (args) => {
        if (Date.now() > deadline) throw new Error('the deadline passed');
        return ghJson(args);
      };
      const headSha = env.HEAD_SHA ?? '';
      named = await verifyReuse({
        fullRun, headSha, repository: repoSlug(env), expected: expectedResultsStems(ciText()), gh,
        treeMatches: HEX40.test(headSha) ? treeMatchesHead(headSha, { deadline, env }) : null,
      });
    }
    const own = (name) => { if (!/^[1-9]\d*$/.test(env[name] ?? '')) throw new Error(`${name} is not a decimal number: ${REMEDY}`); return env[name]; };
    const runId = named?.runId ?? own('GITHUB_RUN_ID');
    const attempt = named?.attempt ?? own('GITHUB_RUN_ATTEMPT');
    appendTo(env.GITHUB_OUTPUT, `run_id=${runId}\nattempt=${attempt}\n`);
    appendTo(env.GITHUB_STEP_SUMMARY, named ? `### Reused Full run\n\nRun ${named.runId} attempt ${named.attempt} was read again and confirmed: its results are what this check is judged by.\n` : '');
    return 0;
  } catch (e) {
    const message = String(e?.message ?? e);
    // stdout: the runner reads workflow commands there.
    console.log(annotate('error', message.includes(REMEDY) ? message : `${message}. ${REMEDY}`));
    return 1;
  }
}

if (isEntryPoint(import.meta.url)) {
  const mode = process.argv[2];
  if (mode !== 'decide' && mode !== 'verify') {
    console.error('usage: node scripts/full-run-reuse.mjs decide|verify');
    process.exitCode = 2;
  } else {
    process.exitCode = await (mode === 'decide' ? decide(process.env) : verify(process.env));
  }
}
