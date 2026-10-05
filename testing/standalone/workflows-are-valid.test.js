/**
 * A workflow that fails to START looks almost exactly like a workflow that ran and failed.
 *
 * ## The failure this exists for
 *
 * `cla.yml` shipped in #665 with `if: ${{ secrets.CLA_SIGNATURES_TOKEN == '' }}` on a step. The `secrets` context
 * is **not available in an `if:` conditional** — only in `env:` and `with:`. So the expression was invalid, and
 * GitHub responded the way it does to any invalid workflow: it created a run for every push, concluded it
 * **failure**, ran **zero jobs**, and emailed about each one.
 *
 * The consequence was not the email. It was that **the CLA was never enforced at all** — from the day the check
 * was added, it had never once executed, while the runs list showed activity and the repository looked guarded.
 * The owner noticed because of the noise; nothing in this repo would have.
 *
 * The tell, in the runs list, is `event: push` on a workflow that has no `push` trigger, plus "No jobs were run".
 *
 * ## What this checks
 *
 * The static half of what GitHub's validator would have caught, offline: every workflow parses as YAML, declares
 * a trigger and at least one job, and — the specific trap — never reads `secrets` from a place where the context
 * does not exist.
 *
 * It cannot replace GitHub's own validation. It closes the class of error that costs a silent, invisible outage.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { load } from 'js-yaml';
import { loadCi, parseWorkflow, triggersOf } from '../_shared/ci-workflow.mjs';
import { GOOD_CI } from '../_shared/ci-workflow-fixture.mjs';

const DIR = join(process.cwd(), '.github', 'workflows');
const files = readdirSync(DIR).filter(f => f.endsWith('.yml') || f.endsWith('.yaml'));

describe('every workflow would start', () => {
  it('found the workflows (guards against a vacuous pass)', () => {
    assert.ok(files.length >= 3, `expected several workflows, found ${files.length}`);
  });

  it('each one parses, and declares a trigger and a job', () => {
    for (const f of files) {
      const doc = load(readFileSync(join(DIR, f), 'utf8'));
      assert.ok(doc && typeof doc === 'object', `${f}: does not parse to a mapping`);
      // `on:` is YAML 1.1 truthy, so js-yaml gives the key back as boolean true. Accept either.
      const triggers = doc.on ?? doc[true];
      assert.ok(triggers, `${f}: no 'on:' trigger`);
      assert.ok(doc.jobs && Object.keys(doc.jobs).length > 0, `${f}: no jobs`);
      for (const [name, job] of Object.entries(doc.jobs)) {
        assert.ok(job['runs-on'] || job.uses, `${f}: job '${name}' has neither runs-on nor uses`);
      }
    }
  });

  it('no `if:` reads the secrets context — the exact trap that silently disabled cla.yml', () => {
    // GitHub rejects the whole workflow rather than the one expression, so the blast radius is every job in the
    // file. Read the secret through `env:` and test it in the shell instead.
    const bad = [];
    for (const f of files) {
      const raw = readFileSync(join(DIR, f), 'utf8');
      raw.split('\n').forEach((line, i) => {
        // `if:` at any nesting, containing `secrets.` anywhere in the expression.
        if (/^\s*if:\s/.test(line) && /\bsecrets\s*\./.test(line)) {
          bad.push(`${f}:${i + 1}  ${line.trim()}`);
        }
      });
    }
    assert.deepEqual(bad, [],
      'the `secrets` context is unavailable in `if:`; GitHub treats this as an invalid workflow, so every run '
      + 'becomes a startup failure with zero jobs — which reads as a failing check rather than a check that '
      + 'never ran:\n  ' + bad.join('\n  '));
  });

  it('a job that needs a PAT does not silently fall back to GITHUB_TOKEN', () => {
    // Adjacent trap: `pull_request_target` from a fork gets a read-only GITHUB_TOKEN, so a job that must write
    // has to be handed a PAT explicitly. If a workflow names a PAT-ish secret it should actually pass it.
    for (const f of files) {
      const raw = readFileSync(join(DIR, f), 'utf8');
      if (!/PERSONAL_ACCESS_TOKEN|_TOKEN:\s*\$\{\{\s*secrets\./.test(raw)) continue;
      assert.match(raw, /\$\{\{\s*secrets\.[A-Z_]+\s*\}\}/,
        `${f}: references a token but never interpolates a secret`);
    }
  });
});

// ───────────────────────────────────────── ci.yml: no privileged trigger, no secret ─────────────────────────────────────────

/**
 * The events that run a workflow in the BASE repository's context, with its secrets and a write token, on behalf of
 * a pull request from anywhere. `ci.yml` installs and runs the code of the pull request it is triggered by — `npm ci`
 * executes its install scripts, the suites execute its tests — so under either of these a fork's pull request would
 * run its own code with this repository's credentials. `cla.yml` uses `pull_request_target` legitimately (it runs a
 * pinned action and no repository code), which is why this is asked of `ci.yml` and not of every workflow.
 */
const PRIVILEGED_TRIGGERS = ['pull_request_target', 'workflow_run'];

const privilegedTriggers = (doc) => [...triggersOf(doc)].filter((t) => PRIVILEGED_TRIGGERS.includes(t));

/**
 * Where a workflow reaches for a secret, or for the Test-Run recorder's variables, by key or by value.
 *
 * `ci.yml` holds no credential: the recorder's write token lives on a maintainer's machine and nowhere in GitHub, so a
 * `secrets.` reference here is either a credential that should not be there or a step that would run recording from
 * CI — which `YTHRIL_TEST_RUNS_*` (the recorder's URL and token) must never reach. Read from the parsed document, so a
 * comment explaining the rule does not trip it and an `env:` key that does is found whatever the string around it.
 */
function secretReaches(doc) {
  const found = [];
  const walk = (node, path) => {
    if (typeof node === 'string') {
      if (/\bsecrets\s*\./.test(node)) found.push(`${path}: ${node.trim().slice(0, 80)}`);
      if (/YTHRIL_TEST_RUNS/.test(node)) found.push(`${path}: ${node.trim().slice(0, 80)}`);
    } else if (Array.isArray(node)) {
      node.forEach((n, i) => walk(n, `${path}[${i}]`));
    } else if (node && typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) {
        if (k === 'secrets' || /YTHRIL_TEST_RUNS/.test(k)) found.push(`${path}.${k}`);
        walk(v, `${path}.${k}`);
      }
    }
  };
  walk(doc, '$');
  return found;
}

describe('ci.yml runs unprivileged and holds no credential', () => {
  const CI = loadCi();

  it('it is triggered by pull_request and push, and by neither pull_request_target nor workflow_run', () => {
    assert.ok(triggersOf(CI).size >= 2, `ci.yml's triggers are ${[...triggersOf(CI)]}: the derivation is broken`);
    assert.deepEqual(privilegedTriggers(CI), [],
      'ci.yml would run a fork\'s code with the base repository\'s secrets and write token');
  });

  it('it reads no secret and never reaches the recorder\'s variables', () => {
    const found = secretReaches(CI);
    assert.deepEqual(found, [], `ci.yml reaches for a credential:\n  ${found.join('\n  ')}`);
  });

  it('the scanners fire on each shape they exist for, and not on the conforming workflow', () => {
    const wf = (on, body = '') => parseWorkflow(`on: ${on}\njobs:\n  a:\n    runs-on: x\n${body}`, 'fixture');
    for (const on of ['pull_request_target', '[push, workflow_run]', '{ workflow_run: { workflows: [CI] } }']) {
      assert.ok(privilegedTriggers(wf(on)).length, `${on} was not flagged`);
    }
    for (const on of ['push', '[push, pull_request]', '{ pull_request: { branches: [main] } }']) {
      assert.deepEqual(privilegedTriggers(wf(on)), [], `${on} was flagged`);
    }
    assert.ok(secretReaches(wf('push', "    env:\n      T: ${{ secrets.GITHUB_TOKEN }}\n")).length, 'a secrets. reference was not flagged');
    assert.ok(secretReaches(wf('push', '    env:\n      YTHRIL_TEST_RUNS_URL: x\n')).length, 'the recorder\'s variable as a key was not flagged');
    assert.ok(secretReaches(wf('push', "    steps:\n      - run: 'echo $YTHRIL_TEST_RUNS_TOKEN'\n")).length, 'the recorder\'s variable in a script was not flagged');
    assert.ok(secretReaches(wf('push', '    secrets: inherit\n')).length, '`secrets:` was not flagged');
    assert.deepEqual(secretReaches(wf('push', '    # secrets.X and YTHRIL_TEST_RUNS_URL are named in a comment\n    steps:\n      - run: echo hi\n')), [],
      'a comment was read as code');
    assert.deepEqual(secretReaches(parseWorkflow(GOOD_CI, 'fixture')), [], 'the conforming workflow was flagged');
    assert.deepEqual(privilegedTriggers(parseWorkflow(GOOD_CI, 'fixture')), []);
  });
});
