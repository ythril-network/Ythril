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
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { load } from 'js-yaml';
import { REPO_ROOT, trackedSources } from '../standalone/_sources.mjs';
import { CI_WORKFLOW } from './ci-workflow-path.mjs';

export { CI_WORKFLOW };

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

/**
 * One workflow, parsed: `rel` under `root`. The root defaults to this repository and does not depend on the working
 * directory; a script that answers a question about "a repo" (`unrun-tests --root`) passes the copy it was given.
 * A missing file throws — "no workflow" must never read as "a workflow that runs nothing".
 */
export function loadWorkflow(rel = CI_WORKFLOW, root = REPO_ROOT) {
  const file = join(root, rel);
  if (!existsSync(file)) throw new Error(`${rel} does not exist under ${root} — there is no workflow to read`);
  return parseWorkflow(readFileSync(file, 'utf8'), rel);
}

/** `ci.yml`, parsed. */
export const loadCi = (root = REPO_ROOT) => loadWorkflow(CI_WORKFLOW, root);

/** Every committed workflow file, repo-relative. The listing is git's, with a floor inside `trackedSources`. */
export const workflowFiles = () => trackedSources('.github/workflows', { ext: ['.yml', '.yaml'], floor: 3 });

/** Every committed workflow, `[{ file, doc }]`. */
export const loadAllWorkflows = () => workflowFiles().map((file) => ({ file, doc: loadWorkflow(file) }));

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

/** A local action reference (`./.github/actions/x`): the only `uses:` whose commands live in this repository. */
const isLocalAction = (step) => typeof step.uses === 'string' && step.uses.startsWith('./');

/**
 * The steps a local composite action runs, read from its `action.yml`. A local action that is not composite (a
 * node or docker action) runs no shell, so it has none. A missing file throws.
 */
function compositeStepsOf(uses, root) {
  for (const name of ['action.yml', 'action.yaml']) {
    const file = join(root, uses, name);
    if (!existsSync(file)) continue;
    const action = load(readFileSync(file, 'utf8'));
    return action?.runs?.using === 'composite' && Array.isArray(action.runs.steps) ? action.runs.steps : [];
  }
  throw new Error(`\`uses: ${uses}\` names a local action with no action.yml under ${root}`);
}

function scriptOf(step, root, via) {
  if (isLocalAction(step)) {
    if (via.includes(step.uses)) throw new Error(`local action ${step.uses} uses itself: ${[...via, step.uses].join(' > ')}`);
    return compositeStepsOf(step.uses, root).map((s) => scriptOf(s, root, [...via, step.uses])).filter(Boolean).join('\n');
  }
  return String(step.run ?? '')
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n')
    .replace(/\\\r?\n\s*/g, ' ');
}

/**
 * A step's shell script as the shell would read it: `#` comment lines gone and `\` continuations joined, so
 * one command is one line. An empty string for a step that runs nothing.
 *
 * **A step that uses a LOCAL composite action is its action's script** (followed to any depth, a cycle refused).
 * This is the half that was forgettable: a command moved out of `ci.yml` into `.github/actions/<name>` — the failure
 * dump was the first — is still run by that job, and a reader of `step.run` alone sees a job that runs nothing.
 * `unrun-tests` read a test command it could no longer find as "nothing selected", and a start-set read a stack it
 * could no longer find as "no stack"; both recorded the absence instead of refusing it. Every consumer comes
 * through here so the next move is seen by all of them, and the `a-workflow-is-read-by-one-module` gate holds it.
 *
 * `root` is the repository the local action is looked up in (default: this one).
 */
export function shellOf(step, { root = REPO_ROOT } = {}) {
  return scriptOf(step, root, []);
}

/**
 * The simple commands of a shell script (as `shellOf` returns it), trimmed, in order, none empty. THE splitter: the two
 * readers of a workflow script (`scripts/unrun-tests.mjs`: which tests CI selects; `compose-start-sets.mjs`: which
 * services a job starts) each wrote one, and disagreed about `&`.
 *
 * What it prevents: a `&` that is part of a redirection (`2>&1`, `>&2`, `&>file`, `<&3`) read as a separator, which tore
 * `docker compose up -d app 2>&1` into `… app 2>` and `1` and made `2>` a service name; and the opposite, a backgrounded
 * command (`a & b`) read as one. A trailing `&` ends its command and leaves no empty one behind.
 */
export function shellCommands(script) {
  return String(script ?? '')
    .split(/&&|\|\||;|\||(?<![<>&|])&(?![>&])|\n/)
    .map((part) => part.trim())
    .filter((part) => part !== '');
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

/**
 * Is a workflow flag ON — the YAML boolean `true`, or the string `'true'` an expression or a quoted value gives.
 *
 * The one reading of "true" for a workflow's flags (`continue-on-error`, `merge-multiple`): a rule that tested only
 * `=== true` would call `continue-on-error: 'true'` a step that can fail the gate, which is the flag turned off by
 * its spelling, and the gate would then pass over exactly the step it exists to refuse.
 */
export const isTrue = (v) => v === true || v === 'true';

/**
 * A job that may fail without failing the run — `continue-on-error` on the job, or on every one of its steps (the same
 * thing said the other way round: nothing in it can fail it). The one place "advisory" is decided, so no gate re-derives it.
 */
export const isAdvisory = (job) => isTrue(job['continue-on-error'])
  || (stepsOf(job).length > 0 && stepsOf(job).every((s) => isTrue(s['continue-on-error'])));
