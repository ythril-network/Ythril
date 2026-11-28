/**
 * A test-image download that stalls fails its own step within minutes and is tried once more; it never holds a job to its time limit.
 *
 * ## The failure this prevents
 *
 * Main CI run 46071083951 (bundle-358's merge): `Sync (shard 1 of 2)` sat 44 minutes in `actions/download-artifact@v4` fetching the 959 MB
 * `ythril-test-image-1` and was cancelled at the job's 45-minute limit, so `Build & Test` failed with every test green and the post-merge
 * checks were blocked. A download that is healthy takes seconds to a few minutes (run 46008443295: 10 s to 69 s; run 46008159520: 138 s at
 * the slowest). A stalled one is a fault of the network, and a second attempt starts a fresh connection.
 *
 * ## The rule, read from the parsed YAML of every tracked workflow (never its text)
 *
 * Every `actions/download-artifact` step has its own `timeout-minutes`, a whole number of at most {@link MOST_MINUTES_PER_ATTEMPT}, so two
 * attempts end far inside a job's limit. A download of the test image (the one that stalled) is also:
 *  - the first of a pair: an `id`, `continue-on-error: true`, and the very next step the same action with the same `with` that runs only
 *    `if: steps.<id>.outcome == 'failure'`, with its own timeout and no `continue-on-error` (so two failures still fail the job and the step
 *    after the pair runs after either attempt);
 *  - or that second attempt, and then it follows such a first one.
 * The results downloads feed the merge gate, which `ci-workflow-is-sound` holds to fail when its own step fails, so they time out and nothing more.
 *
 * A planted copy of each defect (timeout dropped, second attempt dropped, `continue-on-error` dropped from the first, the second attempt
 * made to ignore its own failure, the condition naming another step, a timeout beyond the cap, a new workflow nobody wrote the pair in)
 * is run through the same rule and must be refused.
 *
 * Run: node --test testing/standalone/a-stalled-artifact-download-fails-its-step-and-is-tried-once-more.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './_sources.mjs';
import { loadAllWorkflows, parseWorkflow, jobEntries, stepsOf, usesOf, expressionOf, isTrue } from '../_shared/ci-workflow.mjs';

const DOWNLOAD = 'actions/download-artifact';
/**
 * The longest one attempt may last: above the slowest healthy download seen (138 s), and two of them cost a job 8 minutes at most. It was 10,
 * and Full run 46123430403 (bundle-385) spent 20 minutes on one runner whose first and second attempts both stalled, while the other shards
 * of that run downloaded the image in 8 to 33 s.
 */
const MOST_MINUTES_PER_ATTEMPT = 4;
/** Download steps the tracked workflows hold today or more: an empty scan passes every loop written over it. */
const FLOOR_OF_DOWNLOAD_STEPS = 2;

const isDownload = (s) => usesOf(s)?.action === DOWNLOAD;
/** The test-image download of a test job: the 959 MB one that stalled. The results downloads feed the merge gate, which must be able to fail, so they only time out. */
const isImage = (s) => typeof s.with?.name === 'string' && s.with.name.startsWith('ythril-test-image');
const sameDownload = (a, b) => a.uses === b.uses && JSON.stringify(a.with ?? null) === JSON.stringify(b.with ?? null);
const retryCondition = (id) => `steps.${id}.outcome == 'failure'`;
const hasTimeout = (s) => Number.isInteger(s['timeout-minutes']) && s['timeout-minutes'] > 0 && s['timeout-minutes'] <= MOST_MINUTES_PER_ATTEMPT;
const secondAttemptOf = (prev, s) => prev !== undefined && isDownload(prev) && typeof prev.id === 'string' && s.if !== undefined && expressionOf(s.if) === retryCondition(prev.id);

/** Every way a workflow lets a stalled download hold its job, as sentences. */
function downloadViolations(doc, file) {
  const v = [];
  for (const { id: jobId, job } of jobEntries(doc)) {
    const steps = stepsOf(job);
    steps.forEach((s, i) => {
      if (!isDownload(s)) return;
      const where = `${file} ${jobId} step ${JSON.stringify(s.name ?? s.uses)}`;
      if (!hasTimeout(s)) v.push(`${where}: no step timeout-minutes of 1 to ${MOST_MINUTES_PER_ATTEMPT} (found ${JSON.stringify(s['timeout-minutes'])})`);
      if (!isImage(s) && !secondAttemptOf(steps[i - 1], s)) return;
      if (secondAttemptOf(steps[i - 1], s)) {
        if (!sameDownload(steps[i - 1], s)) v.push(`${where}: the second attempt is not the same download as the first`);
        if (isTrue(s['continue-on-error'])) v.push(`${where}: the second attempt ignores its own failure, so two stalls pass the job`);
        return;
      }
      if (typeof s.id !== 'string') { v.push(`${where}: no id, so no second attempt can name it`); return; }
      if (!isTrue(s['continue-on-error'])) v.push(`${where}: the first attempt does not continue on error, so its failure ends the job before a second attempt`);
      const next = steps[i + 1];
      if (next === undefined || !isDownload(next) || !secondAttemptOf(s, next)) v.push(`${where}: no second attempt follows that runs only if: ${retryCondition(s.id)}`);
    });
  }
  return v;
}

describe('no workflow lets one stalled artifact download hold its job to the time limit', () => {
  const all = loadAllWorkflows();

  it('finds the download steps it governs (the floor), in every tracked workflow', () => {
    const found = all.flatMap(({ doc }) => jobEntries(doc).flatMap(({ job }) => stepsOf(job).filter(isDownload)));
    assert.ok(found.length >= FLOOR_OF_DOWNLOAD_STEPS, `only ${found.length} download step(s) found: re-anchor the derivation`);
  });

  it('every download step has a step timeout and a second attempt that runs only when the first failed', () => {
    const v = all.flatMap(({ file, doc }) => downloadViolations(doc, file));
    assert.deepEqual(v, [], 'a download that stalls holds its job to the 45-minute limit (main CI run 46071083951): give the step timeout-minutes, id and continue-on-error, and a second identical step with `if: steps.<id>.outcome == \'failure\'`');
  });
});

describe('the rule refuses a planted copy of each defect', () => {
  const CI = '.github/workflows/ci.yml';
  const ci = () => readFileSync(join(REPO_ROOT, CI), 'utf8');
  const violations = (text) => downloadViolations(parseWorkflow(text, CI), CI);
  const plant = (steps) => `on: push\njobs:\n  j:\n    runs-on: ubuntu-latest\n    steps:\n${steps}`;
  const GOOD = [
    '      - name: first',
    '        id: dl',
    '        uses: actions/download-artifact@v4',
    '        timeout-minutes: 5',
    '        continue-on-error: true',
    '        with: { name: ythril-test-image-1 }',
    '      - uses: actions/download-artifact@v4',
    '        if: steps.dl.outcome == \'failure\'',
    '        timeout-minutes: 5',
    '        with: { name: ythril-test-image-1 }',
  ];
  const withLines = (edit) => plant(edit(GOOD).join('\n') + '\n');

  it('the real workflows pass the rule the plants are measured against', () => {
    assert.deepEqual(violations(ci()), []);
    assert.deepEqual(violations(withLines((l) => l)), []);
  });

  it('every real timeout removed, and every real second attempt removed', () => {
    const real = () => parseWorkflow(ci(), CI);
    const downloads = (doc) => jobEntries(doc).flatMap(({ job }) => stepsOf(job).filter(isDownload));
    const noTimeouts = real();
    for (const s of downloads(noTimeouts)) delete s['timeout-minutes'];
    assert.ok(downloadViolations(noTimeouts, CI).some((m) => /no step timeout-minutes/.test(m)), 'the real download steps lose their timeouts unnoticed');
    const noRetry = real();
    for (const { job } of jobEntries(noRetry)) job.steps = stepsOf(job).filter((s, i, all) => !secondAttemptOf(all[i - 1], s));
    assert.ok(downloadViolations(noRetry, CI).some((m) => /no second attempt follows/.test(m)), 'the real download steps lose their second attempts unnoticed');
  });

  it('no timeout on a pair', () => {
    const v = violations(withLines((l) => l.filter((x) => !x.includes('timeout-minutes'))));
    assert.equal(v.filter((m) => /no step timeout-minutes/.test(m)).length, 2, JSON.stringify(v));
  });

  it('a timeout beyond the cap', () => {
    const v = violations(withLines((l) => l.map((x) => x.replace('timeout-minutes: 5', 'timeout-minutes: 44'))));
    assert.ok(v.some((m) => /no step timeout-minutes/.test(m)), JSON.stringify(v));
  });

  it('the second attempt dropped', () => {
    const v = violations(withLines((l) => l.slice(0, 6)));
    assert.ok(v.some((m) => /no second attempt follows/.test(m)), JSON.stringify(v));
  });

  it('continue-on-error dropped from the first attempt', () => {
    const v = violations(withLines((l) => l.filter((x) => !x.includes('continue-on-error'))));
    assert.ok(v.some((m) => /first attempt does not continue on error/.test(m)), JSON.stringify(v));
  });

  it('the second attempt that ignores its own failure', () => {
    const v = violations(withLines((l) => [...l.slice(0, 8), '        continue-on-error: true', ...l.slice(8)]));
    assert.ok(v.some((m) => /second attempt ignores its own failure/.test(m)), JSON.stringify(v));
  });

  it('a second attempt that runs whatever the first did, or names another step', () => {
    const always = violations(withLines((l) => l.filter((x) => !x.includes('if: steps'))));
    assert.ok(always.some((m) => /no second attempt follows/.test(m)), JSON.stringify(always));
    const other = violations(withLines((l) => l.map((x) => x.replace('steps.dl.outcome', 'steps.other.outcome'))));
    assert.ok(other.some((m) => /no second attempt follows/.test(m)), JSON.stringify(other));
  });

  it('a second attempt that downloads something else', () => {
    const v = violations(withLines((l) => l.map((x, i) => (i === 9 ? '        with: { name: ythril-test-image-2 }' : x))));
    assert.ok(v.some((m) => /not the same download/.test(m)), JSON.stringify(v));
  });

  it('a first attempt with no id', () => {
    const v = violations(withLines((l) => l.filter((x) => !x.includes('id: dl'))));
    assert.ok(v.some((m) => /no id/.test(m)), JSON.stringify(v));
  });

  it('a bare download in a workflow nobody wrote the pair in', () => {
    const v = violations(plant('      - uses: actions/download-artifact@v4\n        with: { name: ythril-test-image-1 }\n'));
    assert.ok(v.some((m) => /no step timeout-minutes/.test(m)) && v.some((m) => /no id/.test(m)), JSON.stringify(v));
  });
});
