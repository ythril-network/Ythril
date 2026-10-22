/**
 * Did one CI run skip a test nobody expected? `node scripts/skip-check.mjs <run id>` answers 0 / 1 / 2 as
 * `unexpected-skips.mjs` does, by READING that run's own verdict (Q-584).
 *
 * ## Why it reads and does not re-derive
 *
 * CI already answers the question once, in the gate job's step that runs `scripts/unexpected-skips.mjs` over the run's own
 * artifacts, at the run's own head, against the run's own `expected-in-ci` list. Downloading the artifacts and running the
 * rule again here would be a second copy of it with three ways to disagree with the first: another attempt's files, this
 * checkout's list, a job whose upload was lost. So this reads the step's conclusion and, when it failed, the step's failed
 * log, and maps them to the same exit codes.
 *
 * | the run                                                        | exit |
 * |----------------------------------------------------------------|------|
 * | completed, the step succeeded                                  | 0    |
 * | completed, the step failed, its log lists unexpected skips     | 1    |
 * | completed, the step failed, its log says the derivation failed, or neither | 2 |
 * | the step skipped, cancelled or without a conclusion; no job holds it (a partial re-run) | 2 |
 * | the run not completed; any `gh` failure; a run id that is not a decimal number | 2 |
 *
 * The unknown wins over a finding, as in `unexpected-skips`: a log that also says the derivation failed is not a list.
 * The step is found by what it runs (`unexpected-skips.mjs`), read from ci.yml, never by a name written here.
 *
 * ## One reader of a run
 *
 * The run, its failed log, the run-id check, the bound on the `gh` call and the step finder are `./_shared/ci-run-reader.mjs`'s,
 * the one reader `scripts/trade.mjs` uses as well: this file holds the verdict (the table above) and nothing that spawns `gh`.
 * `scripts/test-times.mjs` keeps its own REST pager on purpose (it reads artifacts with a token where `gh` is not installed), and
 * says so in its docblock.
 */
import { isEntryPoint } from './_shared/script-cli.mjs';
import { readRun, readFailedLog, stepNameRunning } from './_shared/ci-run-reader.mjs';

/** The name of ci.yml's step that runs the skip rule. Throws when there is not exactly one: a guess would read the wrong step. */
export const skipStepName = () => stepNameRunning(/scripts\/unexpected-skips\.mjs/);

/** A gh log line without its `<job>\t<step>\t<timestamp> ` prefix. */
const textOf = (line) => line.replace(/^[^\t]*\t[^\t]*\t\S+Z ?/, '');

/**
 * The verdict for one run: `run` is `gh run view --json status,conclusion,attempt,headSha,jobs`, `failedLog` the step's
 * job's `gh run view --job <id> --log-failed` (read only when the step failed). Returns `{ code, lines }`.
 */
export function skipVerdict({ run, failedLog }, stepName = skipStepName()) {
  if (run?.status !== 'completed') return { code: 2, lines: [`the run is ${run?.status ?? 'unknown'}, not completed: its verdict is not in yet`] };
  const holding = (run.jobs ?? []).map(job => ({ job, step: (job.steps ?? []).find(s => s.name === stepName) })).filter(x => x.step);
  if (holding.length === 0) return { code: 2, lines: [`no job of this run holds the step '${stepName}' (a partial re-run, or the step was renamed)`] };
  const { step } = holding[0];
  if (step.conclusion === 'success') return { code: 0, lines: [] };
  if (step.conclusion !== 'failure') return { code: 2, lines: [`the step '${stepName}' ended ${step.conclusion || 'without a conclusion'}: it never gave a verdict`] };
  const lines = String(failedLog ?? '').split(/\r?\n/).map(textOf);
  if (lines.some(l => /unexpected-skips: the derivation failed|usage: node scripts\/unexpected-skips\.mjs/.test(l)))
    return { code: 2, lines: lines.filter(l => /unexpected-skips:|usage:/.test(l)) };
  const head = lines.findIndex(l => /^unexpected-skips: \d+ skipped test\(s\) CI did not expect:/.test(l));
  if (head < 0) return { code: 2, lines: [`the step '${stepName}' failed and its log names no unexpected skip: the cause is unknown`] };
  const listed = [];
  for (const l of lines.slice(head + 1)) { if (!/^ {2}\S/.test(l)) break; listed.push(l); }
  return listed.length ? { code: 1, lines: [lines[head], ...listed] } : { code: 2, lines: [`the step's log announces skips and lists none`] };
}

const USAGE = 'usage: node scripts/skip-check.mjs <run id>   (the run id is a decimal number: gh run list shows it)';

if (isEntryPoint(import.meta.url)) {
  const args = process.argv.slice(2);
  // The reader refuses a non-decimal id itself; this is the usage message for it, said before any call.
  if (args.length !== 1 || !/^\d+$/.test(args[0])) {
    console.error(USAGE);
    process.exit(2);
  }
  try {
    const run = await readRun(args[0]);
    const stepName = skipStepName();
    const job = (run.jobs ?? []).find(j => (j.steps ?? []).some(s => s.name === stepName && s.conclusion === 'failure'));
    const failedLog = job ? await readFailedLog(job.databaseId) : '';
    const { code, lines } = skipVerdict({ run, failedLog }, stepName);
    console.log(`skip-check: run ${args[0]} (head ${String(run.headSha ?? '').slice(0, 8)}, attempt ${run.attempt ?? '?'}): exit ${code}`);
    for (const l of lines) console.log(l);
    process.exitCode = code;
  } catch (e) {
    console.error(`skip-check: ${String(e.message ?? e).split('\n')[0]}`);
    process.exitCode = 2;
  }
}
