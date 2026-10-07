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
import { CI_WORKFLOW, FULL_RUN_WORKFLOW, FULL_RUN_PREFIX } from './ci-workflow-path.mjs';

export { CI_WORKFLOW, FULL_RUN_WORKFLOW, FULL_RUN_PREFIX };

/** The name the ruleset requires. A rename silently drops the merge gate, so it is the one string kept literal. */
export const MERGE_GATE_NAME = 'Build & Test';

/**
 * Parse one YAML document under `.github` — a workflow (`jobs`) or a local action (`runs`). A document that is not a mapping
 * holding its `key` as a mapping is the gate's failure, not a pass.
 *
 * The one parse for both kinds: they were two functions that differed in a key and a noun, and a rule added to one (a
 * refusal, a different YAML schema) would have been missing from the other.
 */
function parseDocument(text, label, key, noun) {
  const doc = load(text);
  if (!doc || typeof doc !== 'object' || !doc[key] || typeof doc[key] !== 'object') {
    throw new Error(`${label} does not parse to ${noun} with ${key}`);
  }
  return doc;
}

/** One YAML document under `.github`, read and parsed. A missing file throws — "no document" must never read as "one that runs nothing". */
function loadDocument(rel, root, parse, noun) {
  const file = join(root, rel);
  if (!existsSync(file)) throw new Error(`${rel} does not exist under ${root} — there is no ${noun} to read`);
  return parse(readFileSync(file, 'utf8'), rel);
}

/** Parse one workflow's text. A document that is not a mapping with jobs is the gate's failure, not a pass. */
export const parseWorkflow = (text, label = 'workflow') => parseDocument(text, label, 'jobs', 'a workflow');

/**
 * One workflow, parsed: `rel` under `root`. The root defaults to this repository and does not depend on the working
 * directory; a script that answers a question about "a repo" (`unrun-tests --root`) passes the copy it was given.
 * A missing file throws — "no workflow" must never read as "a workflow that runs nothing".
 */
export const loadWorkflow = (rel = CI_WORKFLOW, root = REPO_ROOT) => loadDocument(rel, root, parseWorkflow, 'workflow');

/** `ci.yml`, parsed. */
export const loadCi = (root = REPO_ROOT) => loadWorkflow(CI_WORKFLOW, root);

/** `full-run.yml`, parsed — the caller of `ci.yml` a push to a `FULL_RUN_PREFIX` ref runs. A missing file throws, as `loadWorkflow` does. */
export const loadFullRun = (root = REPO_ROOT) => loadWorkflow(FULL_RUN_WORKFLOW, root);

/** Every committed workflow file, repo-relative. The listing is git's, with a floor inside `trackedSources`. */
export const workflowFiles = () => trackedSources('.github/workflows', { ext: ['.yml', '.yaml'], floor: 3 });

/** Every committed workflow, `[{ file, doc }]`. */
export const loadAllWorkflows = () => workflowFiles().map((file) => ({ file, doc: loadWorkflow(file) }));

/**
 * Every committed local action, repo-relative (`.github/actions/<name>/action.yml`). A composite action runs steps of its
 * own — a checkout, a credential in an input — so a rule over "every step the repository runs" reads these too, and a rule
 * that read only `workflows/` concluded about all of them (the failure dump moved here out of `ci.yml`).
 */
export const actionFiles = () => trackedSources('.github/actions', { ext: ['.yml', '.yaml'], floor: 1 });

/** Parse one local action's text. A document without `runs` is the gate's failure, not an action that runs nothing. */
export const parseAction = (text, label = 'action') => parseDocument(text, label, 'runs', 'an action');

/** One local action, parsed. A missing file throws, as `loadWorkflow` does. */
export const loadAction = (rel, root = REPO_ROOT) => loadDocument(rel, root, parseAction, 'action');

/** `[{ id, name, job }]` — `name` is the display name, which is what a ruleset's required check matches. */
export function jobEntries(doc) {
  return Object.entries(doc.jobs).map(([id, job]) => ({ id, name: job.name ?? id, job }));
}

export const stepsOf = (job) => (Array.isArray(job.steps) ? job.steps : []);

/**
 * `[{ id, name, job }]` of the jobs whose display name is the one the ruleset requires (`MERGE_GATE_NAME`). The one reading
 * of "which job is the merge gate": every caller answers its own question about the result (none, exactly one, more than
 * one), but none re-derives the name match, so a gate that compares the wrong spelling is one fix.
 */
export const mergeGateEntries = (doc) => jobEntries(doc).filter((j) => j.name === MERGE_GATE_NAME);

/**
 * A workflow's `on:` value, whichever way the parser keyed it: a plain `on` under the YAML 1.2 reading and the boolean
 * `true` under 1.1, which is how js-yaml has read the bare word. The one place the key is resolved, so no reader of a trigger
 * can look under `on` alone and find a workflow with no triggers.
 */
export const onOf = (doc) => doc.on ?? doc[true];

/** The workflow's triggers as a Set of event names. `on:` is a string, a list or a map. */
export function triggersOf(doc) {
  const on = onOf(doc);
  if (typeof on === 'string') return new Set([on]);
  if (Array.isArray(on)) return new Set(on);
  return new Set(Object.keys(on ?? {}));
}

/**
 * The branch filter of one trigger, parsed from an `on:` value (`onOf(doc)`): the list of branch patterns as plain strings,
 * `null` when the trigger has NO `branches` filter, and `[]` when it has a filter that lists nothing.
 *
 * What it prevents: an absent filter and an empty one read as the same answer. The first runs for every branch and the second
 * for none, so a rule that asks "does the filter name X" must be able to tell a trigger it cannot narrow from a filter it
 * can. Everything without a `branches` key is `null` — the bare word (`on: push`), a list of events, a trigger with no body or
 * an empty mapping, and a filter that is `tags` or `branches-ignore` only. A single pattern written as a scalar is a list of
 * one, as GitHub reads it.
 */
export function branchesOf(on, event) {
  if (!on || typeof on !== 'object' || Array.isArray(on)) return null;
  const trigger = on[event];
  if (!trigger || typeof trigger !== 'object' || Array.isArray(trigger)) return null;
  const branches = trigger.branches;
  if (branches === undefined || branches === null) return null;
  return [].concat(branches).map(String);
}

/** A local action reference (`./.github/actions/x`): the only `uses:` whose commands live in this repository. */
const isLocalAction = (step) => typeof step.uses === 'string' && step.uses.startsWith('./');

/**
 * The steps a local composite action runs, read from its `action.yml`. A local action that is not composite (a
 * node or docker action) runs no shell, so it has none. A missing file throws.
 */
function compositeStepsOf(uses, root) {
  for (const name of ['action.yml', 'action.yaml']) {
    const rel = join(uses, name);
    if (!existsSync(join(root, rel))) continue;
    const action = loadAction(rel, root);
    return action.runs.using === 'composite' && Array.isArray(action.runs.steps) ? action.runs.steps : [];
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
 * through here so the next move is seen by all of them, and the `a-workflow-and-a-compose-file-are-parsed-by-their-own-module` gate holds it.
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
