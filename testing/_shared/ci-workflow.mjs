/**
 * What a GitHub Actions workflow SAYS, read from the parsed YAML — never from its text.
 *
 * ## Why this exists, and why it is a module
 *
 * The gates over `.github/workflows/ci.yml` used to read the file as a string: `indexOf('actions/checkout@v4')`,
 * `lastIndexOf('- name:')`, `includes('ONNXRUNTIME_NODE_INSTALL_CUDA: skip')`. That was correct for ONE job and
 * is wrong the moment the file has several: the first `actions/checkout` in the text belongs to whichever job
 * is written first, a skip line in the comment above a step satisfies a `includes`, and a step moved into
 * another job keeps every string assertion green while the rule it carried is gone.
 *
 * Every question a gate asks of a workflow — which jobs are there, which steps run `npm ci`, what a step's
 * `if:` says, which jobs another one waits for — has one answer here, so a gate cannot answer it from a window
 * of characters. It is the same defect `CLAUDE.md` names as the one this repo produces most (one rule, several
 * implementations), arriving in the gates that guard the workflow.
 *
 * ## What it does NOT do
 *
 * It holds no rules. Each gate states its own rule over what this module derives, so a rule and the module
 * that derives its subjects never share a reason to change.
 *
 * Comments are gone by construction: YAML comments never reach the parser, and `shellOf` drops the `#` lines
 * of a `run:` script — a gate that matches the TEXT of a script must not be satisfied by the prose above a
 * step (the mistake `changelog-entry-is-enforced` records as its "sixth time").
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { load } from 'js-yaml';
import { REPO_ROOT, trackedSources } from '../standalone/_sources.mjs';

export const CI_WORKFLOW = '.github/workflows/ci.yml';

/** The name the ruleset requires. A rename silently drops the merge gate, so it is the one string kept literal. */
export const MERGE_GATE_NAME = 'Build & Test';

/** Parse one workflow's text. A document that is not a mapping with jobs is the gate's failure, not a pass. */
export function parseWorkflow(text, label = 'workflow') {
  const doc = load(text);
  if (!doc || typeof doc !== 'object' || !doc.jobs || typeof doc.jobs !== 'object') {
    throw new Error(`${label} does not parse to a workflow with jobs`);
  }
  return doc;
}

/** `ci.yml`, parsed. Read relative to the repository root, so the working directory does not matter. */
export function loadCi() {
  return parseWorkflow(readFileSync(join(REPO_ROOT, CI_WORKFLOW), 'utf8'), CI_WORKFLOW);
}

/** Every committed workflow, `[{ file, doc }]`. The listing is git's, with a floor inside `trackedSources`. */
export function loadAllWorkflows() {
  return trackedSources('.github/workflows', { ext: ['.yml', '.yaml'], floor: 3 })
    .map((file) => ({ file, doc: parseWorkflow(readFileSync(join(REPO_ROOT, file), 'utf8'), file) }));
}

/** `[{ id, name, job }]` — `name` is the display name, which is what a ruleset's required check matches. */
export function jobEntries(doc) {
  return Object.entries(doc.jobs).map(([id, job]) => ({ id, name: job.name ?? id, job }));
}

export const stepsOf = (job) => (Array.isArray(job.steps) ? job.steps : []);

/** The workflow's triggers as a Set of event names. `on:` is a string, a list or a map, and js-yaml may key it `true`. */
export function triggersOf(doc) {
  const on = doc.on ?? doc[true];
  if (typeof on === 'string') return new Set([on]);
  if (Array.isArray(on)) return new Set(on);
  return new Set(Object.keys(on ?? {}));
}

/**
 * A step's shell script as the shell would read it: `#` comment lines gone and `\` continuations joined, so
 * one command is one line. An empty string for a step that runs nothing (a `uses:` step).
 */
export function shellOf(step) {
  return String(step.run ?? '')
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n')
    .replace(/\\\r?\n\s*/g, ' ');
}

/** `{ action, ref }` for a `uses:` step (`actions/cache/save@v4`), else null. */
export function usesOf(step) {
  if (typeof step.uses !== 'string') return null;
  const at = step.uses.lastIndexOf('@');
  return at < 0 ? { action: step.uses, ref: '' } : { action: step.uses.slice(0, at), ref: step.uses.slice(at + 1) };
}

/** Whether a `uses:` ref is an immutable commit rather than a tag a maintainer can move. */
export const isCommitPinned = (ref) => /^[0-9a-f]{40}$/.test(ref);

/** Steps of one job that use the named action (a prefix-exact match on the action path, any ref). */
export function stepsUsing(job, action) {
  return stepsOf(job).filter((s) => usesOf(s)?.action === action);
}

/** Does this step run `npm ci`? Matched on the script with comments dropped, never on prose. */
export const runsNpmCi = (step) => /\bnpm\s+ci\b/.test(shellOf(step));

/** The expression inside `${{ … }}`, trimmed with whitespace collapsed and double quotes made single; else the string. */
export function expressionOf(value) {
  const s = String(value ?? '').trim();
  const m = s.match(/^\$\{\{([\s\S]*)\}\}$/);
  return (m ? m[1] : s).trim().replace(/\s+/g, ' ').replace(/"/g, "'");
}

/** The ids of every job `id` waits for, directly and through the jobs those wait for. */
export function transitiveNeeds(doc, id, seen = new Set()) {
  for (const n of [].concat(doc.jobs[id]?.needs ?? [])) {
    if (!seen.has(n)) { seen.add(n); transitiveNeeds(doc, n, seen); }
  }
  return seen;
}

const isTrue = (v) => v === true || v === 'true';

/**
 * A job that may fail without failing the run — `continue-on-error` on the job, or on every one of its steps (the same
 * thing said the other way round: nothing in it can fail it). The one place "advisory" is decided, so no gate re-derives it.
 */
export const isAdvisory = (job) => isTrue(job['continue-on-error'])
  || (stepsOf(job).length > 0 && stepsOf(job).every((s) => isTrue(s['continue-on-error'])));
