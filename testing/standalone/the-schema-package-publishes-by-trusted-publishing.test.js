/**
 * The job that publishes the schema package to npm holds the only OIDC token in `publish.yml`, and is built so that nothing else
 * can use it (bundle-225, Q-683, design D).
 *
 * ## The rule this holds
 *
 * `.github/workflows/publish.yml` publishes `schema/` to npm by TRUSTED PUBLISHING: the `publish-schema` job exchanges a GitHub
 * OIDC token for a short-lived npm credential, with provenance, and no npm token is stored anywhere. The rules below read the
 * PARSED workflow (`testing/_shared/ci-workflow.mjs`, the one sanctioned reader: a text match would be satisfied by a comment
 * above a step, and would pass over a step moved into another job) and say, of that one job and of the workflow around it:
 *
 *  - exactly ONE job holds `id-token: write` (job level), it is `publish-schema`, and it runs `node scripts/publish-schema.mjs`;
 *    its permissions are `contents: read` and `id-token: write` and nothing else;
 *  - the workflow's own `permissions` carry no `id-token`, and neither the workflow nor any job says `write-all`: a workflow-level
 *    grant reaches every job, including the ones that run the third-party actions of the image build;
 *  - it needs `build-and-push`, runs for `refs/tags/v` only, in the environment `scripts/publish-schema.mjs` exports as
 *    `ENVIRONMENT_NAME` (`npm-publish`; its deployment policy allows `v*` tags, so no branch's copy of the workflow can reach the
 *    credential, and the script reads that policy at every publish), under the concurrency group `publish-schema` without
 *    cancelling, with a `timeout-minutes` of at most 15; `build-and-push` has one of at most 90;
 *  - every `uses:` of the job is a commit, not a tag (an action whose tag moves runs with the OIDC token);
 *  - checkout fetches full history (the gitHead and tag rules read it) and keeps no credentials (`persist-credentials: false`);
 *  - setup-node is Node 24 with NO `registry-url` (it writes an `.npmrc` that reads `NODE_AUTH_TOKEN`, and the script refuses one)
 *    and no cache;
 *  - the install is `npm ci --ignore-scripts --workspace=schema --include-workspace-root` with the CUDA skip, before the script;
 *  - no `${{ }}` expression in any `run:` of the job (an expression in a script is injection from whoever names a tag);
 *  - no environment variable, at workflow, job or step level, names a token or a secret.
 *
 * ## The defect it prevents (Q-683)
 *
 * The credential can publish ANY version of the package and a version can never be taken back. The job runs on a tag push, which
 * runs the workflow file AT that tag, so every way for other code to reach the token is a way to publish as the project: a
 * workflow-level `id-token` (every job gets it), a tag-pinned action (its maintainer's next release runs with it), an expression in
 * a script (a tag name becomes shell), an install that runs dependency lifecycle scripts, a token variable (used INSTEAD of the OIDC
 * exchange, which makes provenance a lie), a missing environment (a branch dispatch would run its own copy of the workflow).
 *
 * ## The failure that bought it
 *
 * `ci-workflow-is-sound` allow-lists `publish.yml` from its credential rules (it holds registry secrets on purpose), so before this
 * file nothing read the job that carries the strongest credential in the repository. The first design also tag-pinned its actions
 * and set `registry-url`: the challenge round found the second would have broken every run (the `.npmrc` token placeholder
 * trips the script's own refusal). Each such slip is a mutation row below, shown refused on the parsed real document.
 *
 * Run: node --test testing/standalone/the-schema-package-publishes-by-trusted-publishing.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadWorkflow, jobEntries, stepsOf, usesOf, isCommitPinned, shellOf, runsNpmCi, expressionOf, isTrue } from '../_shared/ci-workflow.mjs';
// The environment's name and the credential's variable names are spelled once, in the script that checks them at every publish
// (the pre-ship sweep, Q-683: a second copy here could drift from the one the script enforces).
import { ENVIRONMENT_NAME as ENVIRONMENT, TOKEN_KEY } from '../../scripts/publish-schema.mjs';

const PUBLISH = '.github/workflows/publish.yml';
const JOB = 'publish-schema';
const BUILD_JOB = 'build-and-push';
const SCRIPT_RUN = /(^|[\s;&|])node\s+scripts\/publish-schema\.mjs(\s|$)/m;
const REAL = loadWorkflow(PUBLISH);
const clone = (doc) => structuredClone(doc);

const jobOf = (doc, id = JOB) => doc.jobs?.[id];
const permissionsOf = (holder) => holder?.permissions;
/** Does this permissions value grant `id-token: write` — directly, or by `write-all`? */
const grantsIdToken = (permissions) => permissions === 'write-all' || permissions?.['id-token'] === 'write';

/** Each rule takes a parsed workflow and returns what it refuses, as strings that begin with the rule's mark. */
const RULES = {
  'the job exists and runs the script': (doc) => {
    const job = jobOf(doc);
    if (!job) return [`[job] publish.yml has no ${JOB} job`];
    const scripts = stepsOf(job).filter((s) => SCRIPT_RUN.test(shellOf(s)));
    const v = [];
    if (scripts.length !== 1) v.push(`[script] ${JOB} runs \`node scripts/publish-schema.mjs\` in ${scripts.length} steps, not exactly one`);
    else {
      const step = scripts[0];
      if (isTrue(step['continue-on-error']) || isTrue(job['continue-on-error'])) v.push('[script] the publish step can fail without failing the run (continue-on-error)');
      if (/\|\|\s*(true|:)\b/.test(shellOf(step))) v.push('[script] the publish step swallows its own failure (`|| true`)');
      if (stepsOf(job).at(-1) !== step) v.push('[script] the publish step is not the last step of the job');
    }
    return v;
  },

  'exactly one job holds id-token': (doc) => {
    const holders = jobEntries(doc).filter(({ job }) => grantsIdToken(permissionsOf(job))).map(({ id }) => id);
    const v = [];
    if (holders.length !== 1 || holders[0] !== JOB) v.push(`[id-token] the jobs holding id-token: write are ${JSON.stringify(holders)}, wanted exactly [${JSON.stringify(JOB)}]`);
    const permissions = permissionsOf(jobOf(doc));
    if (jobOf(doc) && JSON.stringify(Object.entries(permissions ?? {}).sort()) !== JSON.stringify([['contents', 'read'], ['id-token', 'write']])) {
      v.push(`[id-token] ${JOB}'s permissions are ${JSON.stringify(permissions)}, wanted exactly contents: read and id-token: write`);
    }
    return v;
  },

  'the workflow grants no id-token and no write-all': (doc) => {
    const v = [];
    const top = permissionsOf(doc);
    if (top === 'write-all') v.push('[workflow-permissions] the workflow says permissions: write-all, which reaches every job');
    if (top && typeof top === 'object' && 'id-token' in top) v.push('[workflow-permissions] the workflow-level permissions name id-token, so every job gets it');
    for (const { id, job } of jobEntries(doc)) {
      if (permissionsOf(job) === 'write-all') v.push(`[workflow-permissions] job ${id} says permissions: write-all`);
    }
    return v;
  },

  'needs, tag-only, environment, concurrency and timeouts': (doc) => {
    const job = jobOf(doc);
    if (!job) return [`[shape] publish.yml has no ${JOB} job`];
    const v = [];
    if (!([].concat(job.needs ?? [])).includes(BUILD_JOB)) v.push(`[shape] ${JOB} does not need ${BUILD_JOB}, so it could publish the package for an image that failed`);
    if (expressionOf(job.if) !== "startsWith(github.ref, 'refs/tags/v')") v.push(`[shape] ${JOB}'s if is ${JSON.stringify(job.if)}, wanted startsWith(github.ref, 'refs/tags/v') so a dispatch on a branch never publishes`);
    const environment = typeof job.environment === 'object' ? job.environment?.name : job.environment;
    if (environment !== ENVIRONMENT) v.push(`[shape] ${JOB}'s environment is ${JSON.stringify(job.environment)}, wanted ${ENVIRONMENT}: it is what restricts the credential to v* tags`);
    if (job.concurrency?.group !== JOB || isTrue(job.concurrency?.['cancel-in-progress']) || job.concurrency?.['cancel-in-progress'] === undefined) {
      v.push(`[shape] ${JOB}'s concurrency is ${JSON.stringify(job.concurrency)}, wanted group ${JOB} with cancel-in-progress: false`);
    }
    const t = job['timeout-minutes'];
    if (!Number.isInteger(t) || t < 1 || t > 15) v.push(`[shape] ${JOB}'s timeout-minutes is ${JSON.stringify(t)}, wanted a literal 1..15`);
    const bt = jobOf(doc, BUILD_JOB)?.['timeout-minutes'];
    if (!Number.isInteger(bt) || bt < 1 || bt > 90) v.push(`[shape] ${BUILD_JOB}'s timeout-minutes is ${JSON.stringify(bt)}, wanted a literal 1..90`);
    return v;
  },

  'every uses is a commit': (doc) => {
    const job = jobOf(doc);
    if (!job) return [`[pinned] publish.yml has no ${JOB} job`];
    const v = [];
    const used = stepsOf(job).map((s) => usesOf(s)).filter(Boolean);
    for (const { action, ref } of used) if (!isCommitPinned(ref)) v.push(`[pinned] ${action}@${ref} is not a 40-character commit: its maintainer's next tag runs with the OIDC token`);
    for (const action of ['actions/checkout', 'actions/setup-node']) {
      if (!used.some((u) => u.action === action)) v.push(`[pinned] ${JOB} has no ${action} step`);
    }
    return v;
  },

  'checkout keeps history and no credentials': (doc) => {
    const job = jobOf(doc);
    if (!job) return [`[checkout] publish.yml has no ${JOB} job`];
    const step = stepsOf(job).find((s) => usesOf(s)?.action === 'actions/checkout');
    if (!step) return [`[checkout] ${JOB} has no checkout`];
    const v = [];
    if (Number(step.with?.['fetch-depth']) !== 0 || step.with?.['fetch-depth'] === undefined) v.push('[checkout] fetch-depth is not 0: the highest-tag and gitHead rules read history and tags');
    if (step.with?.['persist-credentials'] !== false && step.with?.['persist-credentials'] !== 'false') v.push('[checkout] persist-credentials is not false: the job\'s git credential stays on disk for every later step');
    return v;
  },

  'setup-node has no registry-url and no cache': (doc) => {
    const job = jobOf(doc);
    if (!job) return [`[setup-node] publish.yml has no ${JOB} job`];
    const step = stepsOf(job).find((s) => usesOf(s)?.action === 'actions/setup-node');
    if (!step) return [`[setup-node] ${JOB} has no setup-node`];
    const v = [];
    if (String(step.with?.['node-version']) !== '24') v.push(`[setup-node] node-version is ${JSON.stringify(step.with?.['node-version'])}, wanted 24 (npm 11.5.1 or later ships with it)`);
    if (step.with && 'registry-url' in step.with) v.push('[setup-node] registry-url is set: it writes an .npmrc that reads NODE_AUTH_TOKEN and exports a placeholder the script refuses');
    if (step.with && 'cache' in step.with) v.push('[setup-node] cache is set: a restored cache is input to the job that holds the OIDC token');
    return v;
  },

  'the install skips lifecycle scripts, skips CUDA and runs before the publish': (doc) => {
    const job = jobOf(doc);
    if (!job) return [`[install] publish.yml has no ${JOB} job`];
    const steps = stepsOf(job);
    const installs = steps.filter(runsNpmCi);
    if (installs.length !== 1) return [`[install] ${JOB} runs npm ci in ${installs.length} steps, wanted exactly one`];
    const [install] = installs;
    const script = shellOf(install);
    const v = [];
    if (!/--ignore-scripts\b/.test(script)) v.push('[install] npm ci runs without --ignore-scripts: a dependency\'s install script would run with the OIDC token in reach');
    if (!/--workspace=schema\b|(-w|--workspace)\s+schema\b/.test(script)) v.push('[install] npm ci does not install the schema workspace only');
    if (!/--include-workspace-root\b/.test(script)) v.push('[install] npm ci does not include the workspace root');
    if (String(install.env?.ONNXRUNTIME_NODE_INSTALL_CUDA) !== 'skip') v.push('[install] ONNXRUNTIME_NODE_INSTALL_CUDA is not skip on the install: a postinstall download from a GitHub release');
    const publishAt = steps.findIndex((s) => SCRIPT_RUN.test(shellOf(s)));
    if (publishAt >= 0 && steps.indexOf(install) > publishAt) v.push('[install] the install runs after the publish step');
    return v;
  },

  'no expression in any run of the job': (doc) => {
    const job = jobOf(doc);
    if (!job) return [`[expression] publish.yml has no ${JOB} job`];
    return stepsOf(job).filter((s) => shellOf(s).includes('${{')).map((s) => `[expression] step ${JSON.stringify(s.name ?? s.run)} puts a \${{ }} expression in its script: a tag name becomes shell`);
  },

  'no token or secret in the environment at any level': (doc) => {
    const job = jobOf(doc);
    if (!job) return [`[env] publish.yml has no ${JOB} job`];
    const v = [];
    const levels = [['the workflow', doc.env], [`job ${JOB}`, job.env], ...stepsOf(job).map((s) => [`step ${JSON.stringify(s.name ?? s.uses ?? s.run)}`, s.env])];
    for (const [where, env] of levels) {
      for (const [key, value] of Object.entries(env ?? {})) {
        if (TOKEN_KEY.test(key)) v.push(`[env] ${where} sets ${key}: it is used instead of the OIDC exchange`);
        else if (String(value).includes('secrets.')) v.push(`[env] ${where} sets ${key} from a secret: the publish job needs none`);
      }
    }
    return v;
  },
};

/** The step of the job that satisfies `pred`; a missing one is the row's failure, in words. */
function stepWhere(job, pred, what) {
  const step = stepsOf(job).find(pred);
  if (!step) throw new Error(`${JOB} has no ${what} step to mutate`);
  return step;
}
function jobFor(doc) {
  const job = jobOf(doc);
  if (!job) throw new Error(`publish.yml has no ${JOB} job: there is nothing to mutate`);
  return job;
}
const checkout = (doc) => stepWhere(jobFor(doc), (s) => usesOf(s)?.action === 'actions/checkout', 'checkout');
const setupNode = (doc) => stepWhere(jobFor(doc), (s) => usesOf(s)?.action === 'actions/setup-node', 'setup-node');
const installStep = (doc) => stepWhere(jobFor(doc), runsNpmCi, 'npm ci');
const publishStep = (doc) => stepWhere(jobFor(doc), (s) => SCRIPT_RUN.test(shellOf(s)), 'publish-schema.mjs');

/** `[what, mutate(doc), rule, expected message]`: each is a slip a maintainer could make, and each must be refused by that rule. */
const BREAKAGES = [
  // — the environment and the shape of the job
  ['the environment is dropped', (d) => { delete jobFor(d).environment; }, 'needs, tag-only, environment, concurrency and timeouts', /\[shape\].*environment/],
  ['the environment is another one', (d) => { jobFor(d).environment = 'production'; }, 'needs, tag-only, environment, concurrency and timeouts', /\[shape\].*environment/],
  ['the tag-only condition is dropped', (d) => { delete jobFor(d).if; }, 'needs, tag-only, environment, concurrency and timeouts', /\[shape\].*refs\/tags\/v/],
  ['the condition lets a branch through', (d) => { jobFor(d).if = "startsWith(github.ref, 'refs/heads/')"; }, 'needs, tag-only, environment, concurrency and timeouts', /\[shape\].*refs\/tags\/v/],
  ['the job no longer waits for the image', (d) => { delete jobFor(d).needs; }, 'needs, tag-only, environment, concurrency and timeouts', /\[shape\].*does not need/],
  ['the concurrency group is dropped', (d) => { delete jobFor(d).concurrency; }, 'needs, tag-only, environment, concurrency and timeouts', /\[shape\].*concurrency/],
  ['a newer tag cancels an older publish', (d) => { jobFor(d).concurrency['cancel-in-progress'] = true; }, 'needs, tag-only, environment, concurrency and timeouts', /\[shape\].*concurrency/],
  ['timeout-minutes is dropped', (d) => { delete jobFor(d)['timeout-minutes']; }, 'needs, tag-only, environment, concurrency and timeouts', /\[shape\].*publish-schema's timeout-minutes/],
  ['timeout-minutes is the platform ceiling', (d) => { jobFor(d)['timeout-minutes'] = 360; }, 'needs, tag-only, environment, concurrency and timeouts', /\[shape\].*publish-schema's timeout-minutes/],
  ['timeout-minutes is an expression', (d) => { jobFor(d)['timeout-minutes'] = '${{ vars.T }}'; }, 'needs, tag-only, environment, concurrency and timeouts', /\[shape\].*publish-schema's timeout-minutes/],
  ['the image job loses its timeout-minutes', (d) => { delete d.jobs[BUILD_JOB]['timeout-minutes']; }, 'needs, tag-only, environment, concurrency and timeouts', /\[shape\].*build-and-push's timeout-minutes/],

  // — who holds the OIDC token
  ['a tag is pinned instead of a commit (checkout)', (d) => { checkout(d).uses = 'actions/checkout@v4'; }, 'every uses is a commit', /\[pinned\].*actions\/checkout@v4/],
  ['a tag is pinned instead of a commit (setup-node)', (d) => { setupNode(d).uses = 'actions/setup-node@v4'; }, 'every uses is a commit', /\[pinned\].*actions\/setup-node@v4/],
  ['a branch is used as the ref', (d) => { setupNode(d).uses = 'actions/setup-node@main'; }, 'every uses is a commit', /\[pinned\].*actions\/setup-node@main/],
  ['a third-party action joins the job, by tag', (d) => { jobFor(d).steps.splice(1, 0, { name: 'Extra', uses: 'docker/login-action@v3' }); }, 'every uses is a commit', /\[pinned\].*docker\/login-action@v3/],
  ['a short commit is not a commit', (d) => { checkout(d).uses = 'actions/checkout@11bd719'; }, 'every uses is a commit', /\[pinned\].*actions\/checkout@11bd719/],
  ['a second job holds id-token: write', (d) => { d.jobs[BUILD_JOB].permissions = { contents: 'read', 'id-token': 'write' }; }, 'exactly one job holds id-token', /\[id-token\].*build-and-push/],
  ['the job loses id-token: write', (d) => { delete jobFor(d).permissions['id-token']; }, 'exactly one job holds id-token', /\[id-token\]/],
  ['the job gains another permission', (d) => { jobFor(d).permissions.packages = 'write'; }, 'exactly one job holds id-token', /\[id-token\].*permissions/],
  ['the job is write-all', (d) => { jobFor(d).permissions = 'write-all'; }, 'the workflow grants no id-token and no write-all', /\[workflow-permissions\].*write-all/],
  ['id-token: write at workflow level', (d) => { d.permissions['id-token'] = 'write'; }, 'the workflow grants no id-token and no write-all', /\[workflow-permissions\].*id-token/],
  ['permissions: write-all at workflow level', (d) => { d.permissions = 'write-all'; }, 'the workflow grants no id-token and no write-all', /\[workflow-permissions\].*write-all/],
  ['the image job is write-all', (d) => { d.jobs[BUILD_JOB].permissions = 'write-all'; }, 'the workflow grants no id-token and no write-all', /\[workflow-permissions\].*build-and-push/],

  // — what runs in it
  ['an expression joins a run line', (d) => { installStep(d).run += ' # ${{ github.ref_name }}\necho "${{ github.ref_name }}"'; }, 'no expression in any run of the job', /\[expression\]/],
  ['an expression in the publish step', (d) => { publishStep(d).run = `${publishStep(d).run}\necho \${{ github.ref_name }}`; }, 'no expression in any run of the job', /\[expression\]/],
  ['npm ci runs dependency lifecycle scripts', (d) => { installStep(d).run = installStep(d).run.replace(/\s*--ignore-scripts/, ''); }, 'the install skips lifecycle scripts, skips CUDA and runs before the publish', /\[install\].*--ignore-scripts/],
  ['npm ci installs the whole tree', (d) => { installStep(d).run = installStep(d).run.replace(/\s*--workspace=schema/, ''); }, 'the install skips lifecycle scripts, skips CUDA and runs before the publish', /\[install\].*schema workspace/],
  ['the CUDA skip is dropped', (d) => { delete installStep(d).env; }, 'the install skips lifecycle scripts, skips CUDA and runs before the publish', /\[install\].*CUDA/],
  ['the install runs after the publish', (d) => { const steps = jobFor(d).steps; const i = steps.indexOf(installStep(d)); steps.push(...steps.splice(i, 1)); }, 'the install skips lifecycle scripts, skips CUDA and runs before the publish', /\[install\].*after the publish|\[script\]/],
  ['the publish step is gone', (d) => { const steps = jobFor(d).steps; steps.splice(steps.indexOf(publishStep(d)), 1); }, 'the job exists and runs the script', /\[script\]/],
  ['the publish step cannot fail the run', (d) => { publishStep(d)['continue-on-error'] = true; }, 'the job exists and runs the script', /\[script\].*continue-on-error/],
  ['the publish step swallows its failure', (d) => { publishStep(d).run = `${publishStep(d).run.trimEnd()} || true`; }, 'the job exists and runs the script', /\[script\].*\|\| true/],
  ['the job is gone', (d) => { delete d.jobs[JOB]; }, 'the job exists and runs the script', /\[job\]/],

  // — what it checks out and sets up
  ['persist-credentials is dropped', (d) => { delete checkout(d).with['persist-credentials']; }, 'checkout keeps history and no credentials', /\[checkout\].*persist-credentials/],
  ['persist-credentials is true', (d) => { checkout(d).with['persist-credentials'] = true; }, 'checkout keeps history and no credentials', /\[checkout\].*persist-credentials/],
  ['checkout is shallow', (d) => { delete checkout(d).with['fetch-depth']; }, 'checkout keeps history and no credentials', /\[checkout\].*fetch-depth/],
  ['setup-node gets a registry-url', (d) => { setupNode(d).with['registry-url'] = 'https://registry.npmjs.org'; }, 'setup-node has no registry-url and no cache', /\[setup-node\].*registry-url/],
  ['setup-node gets a cache', (d) => { setupNode(d).with.cache = 'npm'; }, 'setup-node has no registry-url and no cache', /\[setup-node\].*cache/],
  ['setup-node moves to another node', (d) => { setupNode(d).with['node-version'] = 20; }, 'setup-node has no registry-url and no cache', /\[setup-node\].*node-version/],

  // — a credential in the environment, at every level it can be set
  ['NPM_TOKEN at workflow level', (d) => { d.env = { ...d.env, NPM_TOKEN: '${{ secrets.NPM_TOKEN }}' }; }, 'no token or secret in the environment at any level', /\[env\].*the workflow sets NPM_TOKEN/],
  ['NPM_TOKEN at job level', (d) => { jobFor(d).env = { ...jobFor(d).env, NPM_TOKEN: '${{ secrets.NPM_TOKEN }}' }; }, 'no token or secret in the environment at any level', /\[env\].*job publish-schema sets NPM_TOKEN/],
  ['NODE_AUTH_TOKEN at step level', (d) => { publishStep(d).env = { ...publishStep(d).env, NODE_AUTH_TOKEN: '${{ secrets.NPM_TOKEN }}' }; }, 'no token or secret in the environment at any level', /\[env\].*step.*sets NODE_AUTH_TOKEN/],
  ['an npm_config auth key at step level', (d) => { installStep(d).env = { ...installStep(d).env, 'npm_config__authToken': 'x' }; }, 'no token or secret in the environment at any level', /\[env\].*npm_config__authToken/],
  ['a secret under another name at workflow level', (d) => { d.env = { ...d.env, REGISTRY_KEY: '${{ secrets.DOCKERHUB_TOKEN }}' }; }, 'no token or secret in the environment at any level', /\[env\].*REGISTRY_KEY/],
];

describe('publish.yml — the schema package publishes by trusted publishing, in one job built for it', () => {
  it('the real document passes every rule', () => {
    for (const [name, rule] of Object.entries(RULES)) {
      assert.deepEqual(rule(REAL), [], `${PUBLISH} breaks the rule "${name}"`);
    }
  });

  it('the job is among the jobs the parsed document lists, beside the image job', () => {
    const ids = jobEntries(REAL).map((j) => j.id);
    assert.ok(ids.includes(BUILD_JOB), `${PUBLISH} lost ${BUILD_JOB}: this gate measures a different file now`);
    assert.ok(ids.includes(JOB), `${PUBLISH} has no ${JOB} job: the schema package is not published by the workflow`);
  });
});

describe('publish.yml — every rule is shown refusing the slip it exists for (mutations of the parsed real document)', () => {
  it('every rule has at least one breakage that fires it (no rule is held only by the real file)', () => {
    for (const name of Object.keys(RULES)) {
      assert.ok(BREAKAGES.some((b) => b[2] === name), `no breakage row for the rule "${name}"`);
    }
    assert.ok(BREAKAGES.length >= 35, `the breakage table shrank to ${BREAKAGES.length} rows`);
  });

  it('every breakage names a rule that exists', () => {
    for (const [what, , rule] of BREAKAGES) assert.ok(rule in RULES, `"${what}" names the unknown rule "${rule}"`);
  });

  for (const [what, mutate, rule, expected] of BREAKAGES) {
    it(`${rule}: ${what}`, () => {
      const doc = clone(REAL);
      mutate(doc);
      const found = RULES[rule](doc);
      assert.ok(found.some((m) => expected.test(m)),
        `the rule "${rule}" did not refuse "${what}" (wanted ${expected}); it returned ${JSON.stringify(found)}`);
    });
  }

  it('a mutation changes the document: the clone is not the real parse (a row that mutated nothing would pass the rule it targets)', () => {
    const doc = clone(REAL);
    assert.deepEqual(doc, REAL, 'the clone differs before any mutation');
    checkout(doc).uses = 'actions/checkout@v4';
    assert.notDeepEqual(doc, REAL);
    assert.ok(isCommitPinned(usesOf(checkout(REAL)).ref), 'mutating the clone changed the real document');
  });
});
