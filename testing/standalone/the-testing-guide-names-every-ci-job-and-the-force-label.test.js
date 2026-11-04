/**
 * `docs/testing-guide.md` names every job of `ci.yml` and the label that forces the whole graph (bundle-244, Q-710).
 *
 * ## What this prevents
 *
 * The guide's "The CI job graph" section is prose about a workflow that changed shape under it: a pull request's run can now
 * skip every suite and read a Full run's results, through two jobs the section did not know (`reuse`, `changelog`), and a label
 * (`ci:full`) is the only way to say "run everything again". Prose about the job graph goes stale silently: the section kept
 * saying that `prepare` runs the changelog check, and "two full graphs by design" after the second stopped being one. A
 * maintainer who reads a section that does not name a job cannot tell a job that was skipped for a reason from one that never
 * ran, and cannot find the lever that forces the full run.
 *
 * ## The rule
 *
 * Every job id of the parsed `ci.yml`, and the force label the reuse script names, appears in the guide's "The CI job graph"
 * section as a code span (`` `id` ``). The ids are read from the YAML and the label from `scripts/full-run-reuse.mjs`, so a job
 * added tomorrow is required of the guide the day it is written. The rule is run over the real guide and over a conforming guide
 * and single breakages of it, so it is seen to fire where the real one is already right.
 *
 * Run: node --test testing/standalone/the-testing-guide-names-every-ci-job-and-the-force-label.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { REPO_ROOT } from './_sources.mjs';
import { markdownSectionWithSubsections } from './_structural-window.mjs';
import { loadCi, parseWorkflow, jobEntries } from '../_shared/ci-workflow.mjs';
import { GOOD_CI } from '../_shared/ci-workflow-fixture.mjs';

const SECTION = 'The CI job graph';
const FLOOR = 7;

/** What the guide's section fails to name, as sentences; none means it names every job id and the label. */
function guideViolations(guide, ci, label) {
  const section = markdownSectionWithSubsections(guide, SECTION);
  if (section === null) return [`the guide has no "${SECTION}" section`];
  const ids = jobEntries(ci).map((j) => j.id);
  const v = ids.length < FLOOR ? [`only ${ids.length} job id(s) read from ci.yml (floor ${FLOOR}): the derivation is broken`] : [];
  for (const id of ids) {
    if (!section.includes(`\`${id}\``)) v.push(`"${SECTION}" does not name the job \`${id}\``);
  }
  if (!label) v.push('no force label to look for: the script names none');
  else if (!section.includes(`\`${label}\``)) v.push(`"${SECTION}" does not name the label \`${label}\`, the one lever that forces the whole graph`);
  return v;
}

/** A guide whose section names the given words, each as a code span, and whose other section names nothing. */
const guideNaming = (words, other = '') => `# Guide\n\n## ${SECTION}\n\nThe graph: ${words.map((w) => `\`${w}\``).join(', ')}.\n\n### The full run of a bundle\n\nMore.\n\n## What is cached\n\n${other}\n`;

const GOOD = parseWorkflow(GOOD_CI, 'the conforming fixture');
const GOOD_IDS = jobEntries(GOOD).map((j) => j.id);
const LABEL = 'ci:full';

describe('docs/testing-guide.md — "The CI job graph" names every job of ci.yml and the force label', () => {
  it('reads the force label from the reuse script, the one place it is written', async () => {
    const mod = await import(pathToFileURL(join(REPO_ROOT, 'scripts', 'full-run-reuse.mjs')).href);
    assert.equal(typeof mod.FORCE_LABEL, 'string', 'scripts/full-run-reuse.mjs must export FORCE_LABEL');
  });

  it('the real guide names every job id of the real ci.yml and the label', async () => {
    const mod = await import(pathToFileURL(join(REPO_ROOT, 'scripts', 'full-run-reuse.mjs')).href);
    const guide = readFileSync(join(REPO_ROOT, 'docs', 'testing-guide.md'), 'utf8');
    const found = guideViolations(guide, loadCi(), mod.FORCE_LABEL);
    assert.deepEqual(found, [], `the guide's job graph has gone stale:\n  ${found.join('\n  ')}`);
  });

  it('the real guide names the two jobs this change adds, and says that adding the label forces the whole graph', () => {
    const guide = markdownSectionWithSubsections(readFileSync(join(REPO_ROOT, 'docs', 'testing-guide.md'), 'utf8'), SECTION) ?? '';
    for (const id of ['reuse', 'changelog']) assert.ok(guide.includes(`\`${id}\``), `"${SECTION}" does not name \`${id}\``);
    assert.ok(/ci:full/.test(guide), `"${SECTION}" does not name the label ci:full`);
  });
});

describe('the rule, held against a conforming guide and each way of losing it', () => {
  it('a guide that names every job and the label passes', () => {
    assert.deepEqual(guideViolations(guideNaming([...GOOD_IDS, LABEL]), GOOD, LABEL), []);
  });

  it('the job ids are read from the workflow: a job added to it is required of the guide', () => {
    const more = structuredClone(GOOD);
    more.jobs['a-new-job'] = structuredClone(more.jobs.sync);
    assert.ok(guideViolations(guideNaming([...GOOD_IDS, LABEL]), more, LABEL).some((m) => /a-new-job/.test(m)));
  });

  for (const id of GOOD_IDS) {
    it(`refuses a guide that does not name \`${id}\``, () => {
      const found = guideViolations(guideNaming([...GOOD_IDS.filter((x) => x !== id), LABEL]), GOOD, LABEL);
      assert.ok(found.some((m) => m.includes(`\`${id}\``)), JSON.stringify(found));
    });
  }

  for (const [what, guide, expected] of [
    ['the label is missing', guideNaming(GOOD_IDS), /label/],
    ['the ids are named in prose, not as code spans', `# G\n\n## ${SECTION}\n\n${GOOD_IDS.join(' ')} ${LABEL}\n\n## Next\n`, /does not name the job/],
    ['everything is named in another section only', guideNaming([], `${GOOD_IDS.map((i) => `\`${i}\``).join(' ')} \`${LABEL}\``), /does not name the job/],
    ['the section is gone', `# G\n\n## What is cached\n\n${GOOD_IDS.map((i) => `\`${i}\``).join(' ')}\n`, /no "The CI job graph" section/],
  ]) {
    it(`refuses: ${what}`, () => {
      const found = guideViolations(guide, GOOD, LABEL);
      assert.ok(found.some((m) => expected.test(m)), JSON.stringify(found));
    });
  }

  it('a script that names no label is refused, not read as a label of the empty string', () => {
    assert.ok(guideViolations(guideNaming(GOOD_IDS), GOOD, undefined).some((m) => /no force label/.test(m)));
  });
});
