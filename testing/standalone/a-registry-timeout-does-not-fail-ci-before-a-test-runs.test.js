/**
 * A registry that does not answer once does not fail a CI run before any test has run (Q-145).
 *
 * ## The failure this prevents
 *
 * PR #1450, run 36529590490 (2026-09-29): `Build & Test` failed in `Set up Docker Buildx` with
 * `Get https://registry-1.docker.io/v2/: context deadline exceeded`. `docker/setup-buildx-action` pulls `moby/buildkit` from
 * Docker Hub on every run, and the stack's database image and the build's base images come from there too, so one registry
 * hiccup failed the whole run with no test executed; the rerun passed the same step. A fault of the network, read as a fault
 * of the change.
 *
 * ## The rule, held in two halves
 *
 * 1. `scripts/retry-on-registry-failure.mjs` runs a command again, a bounded number of times, when its output shows the REGISTRY
 *    did not answer (a timeout, a reset, a 5xx, a rate limit) and at once returns the failure of any other cause: a retry that
 *    also retried `manifest unknown` would hide a wrong pin behind three attempts. The truth table is held here row by row.
 * 2. Every workflow, derived from the tracked `.github/workflows` and read from the parsed YAML (never its text):
 *    - every `docker pull` and every `docker buildx build` of a run step goes through that script;
 *    - every `npm ci` (and `npm install`) of a run step goes through that script too: run 44266883292 failed its
 *      `Standalone (database, shard 0)` job in `npm ci --workspace=server --include-workspace-root` with `npm error code ECONNRESET`
 *      before any test ran, the same registry hiccup on the npm side;
 *    - every `docker/setup-buildx-action` names its BuildKit image in `driver-opts` and an earlier step in the job pulls THAT
 *      image through the script (buildx starts a builder from the local image when it is there, and pulls only when it is not);
 *    - a `docker compose ... up` that may pull (no `--pull never`) follows a step that pulled through the script;
 *    - a script run in a job follows that job's checkout (the file must exist on the runner);
 *    - a `docker/build-push-action` step, whose pull happens inside the action and cannot be wrapped, is in the named list
 *      below with its reason and a review date.
 *
 * A planted copy of each defect (the wrapper dropped from a real step, the pre-pull step removed, a new unlisted build-push
 * step) is run through the same rule and must be refused.
 *
 * Run: node --test testing/standalone/a-registry-timeout-does-not-fail-ci-before-a-test-runs.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REPO_ROOT, trackedSources } from './_sources.mjs';
import { loadAllWorkflows, parseWorkflow, jobEntries, stepsOf, usesOf, shellOf } from '../_shared/ci-workflow.mjs';

const SCRIPT = 'scripts/retry-on-registry-failure.mjs';
const loadScript = () => import(`../../${SCRIPT}`);

// ───────────────────────────────────────── the script ─────────────────────────────────────────

/** What a registry that did not answer prints, and what a registry that answered "no" prints. Each row is a real docker/buildx text. */
const TRANSIENT = [
  'Get https://registry-1.docker.io/v2/: context deadline exceeded',
  'Error response from daemon: Get "https://registry-1.docker.io/v2/": net/http: request canceled while waiting for connection (Client.Timeout exceeded while awaiting headers)',
  'failed to do request: Head "https://registry-1.docker.io/v2/moby/buildkit/manifests/buildx-stable-1": net/http: TLS handshake timeout',
  'dial tcp 54.236.113.205:443: i/o timeout',
  'read tcp 192.0.2.4:42312->198.51.100.5:443: read: connection reset by peer',
  'unexpected EOF',
  'received unexpected HTTP status: 503 Service Unavailable',
  'received unexpected HTTP status: 502 Bad Gateway',
  'toomanyrequests: You have reached your pull rate limit.',
  'dial tcp: lookup registry-1.docker.io: no such host',
  'dial tcp: lookup registry-1.docker.io on 127.0.0.53:53: server misbehaving',
  // npm's own wording (run 44266883292, `npm ci` of the database shard 0 job, and the codes npm prints for the same causes)
  'npm error code ECONNRESET',
  'npm error code ETIMEDOUT',
  'npm error code EAI_AGAIN',
  'npm error network This is a problem related to network connectivity.',
];
const PERMANENT = [
  'manifest for mongodb/mongodb-atlas-local:nope not found: manifest unknown: manifest unknown',
  'pull access denied for ythril-test, repository does not exist or may require \'docker login\': denied: requested access to the resource is denied',
  'unauthorized: authentication required',
  'ERROR: failed to solve: process "/bin/sh -c npm ci" did not complete successfully: exit code: 1',
  'error TS2339: Property \'x\' does not exist on type \'Y\'.',
  'npm error code E404\nnpm error 404 Not Found - GET https://registry.npmjs.org/no-such-package-here - Not found',
  'npm error code EUSAGE\nnpm error `npm ci` can only install packages when your package.json and package-lock.json are in sync.',
  'npm error code ERESOLVE\nnpm error ERESOLVE could not resolve',
  '',
];

const fakeRun = (answers) => {
  const calls = [];
  const run = async (command, args) => { calls.push([command, ...args]); return answers[Math.min(calls.length - 1, answers.length - 1)]; };
  return { run, calls };
};
const fakeSleep = () => { const waits = []; return { sleep: async (s) => { waits.push(s); }, waits }; };

describe('what counts as the registry not answering', () => {
  for (const text of TRANSIENT) {
    it(`retries: ${text.slice(0, 70)}`, async () => {
      const { isRegistryTransient } = await loadScript();
      assert.equal(isRegistryTransient(text), true);
    });
  }
  for (const text of PERMANENT) {
    it(`does not retry: ${text.slice(0, 70) || '(no output)'}`, async () => {
      const { isRegistryTransient } = await loadScript();
      assert.equal(isRegistryTransient(text), false);
    });
  }
});

describe('retryOnRegistryFailure', () => {
  it('runs the command once and returns 0 when it succeeds', async () => {
    const { retryOnRegistryFailure } = await loadScript();
    const { run, calls } = fakeRun([{ status: 0, output: '' }]);
    const { sleep, waits } = fakeSleep();
    assert.equal(await retryOnRegistryFailure({ command: 'docker', args: ['pull', 'x'], run, sleep }), 0);
    assert.equal(calls.length, 1);
    assert.deepEqual(waits, []);
  });

  it('runs it again after a registry timeout and returns 0 when the second answer is a success', async () => {
    const { retryOnRegistryFailure } = await loadScript();
    const { run, calls } = fakeRun([{ status: 1, output: TRANSIENT[0] }, { status: 0, output: '' }]);
    const { sleep, waits } = fakeSleep();
    assert.equal(await retryOnRegistryFailure({ command: 'docker', args: ['pull', 'x'], run, sleep }), 0);
    assert.deepEqual(calls, [['docker', 'pull', 'x'], ['docker', 'pull', 'x']], 'the same command is run again');
    assert.equal(waits.length, 1, 'it waits between attempts');
    assert.ok(waits[0] > 0, 'the wait is not zero');
  });

  it('returns a failure of another cause at once, with its own status, and never waits', async () => {
    const { retryOnRegistryFailure } = await loadScript();
    const { run, calls } = fakeRun([{ status: 7, output: PERMANENT[0] }, { status: 0, output: '' }]);
    const { sleep, waits } = fakeSleep();
    assert.equal(await retryOnRegistryFailure({ command: 'docker', args: ['pull', 'x'], run, sleep }), 7);
    assert.equal(calls.length, 1, 'a wrong pin was run again');
    assert.deepEqual(waits, []);
  });

  it('gives up after the bound and returns the last failure: a registry that is down stays a failure', async () => {
    const { retryOnRegistryFailure } = await loadScript();
    const { run, calls } = fakeRun([{ status: 1, output: TRANSIENT[0] }, { status: 1, output: TRANSIENT[1] }, { status: 9, output: TRANSIENT[3] }, { status: 0, output: '' }]);
    const { sleep, waits } = fakeSleep();
    assert.equal(await retryOnRegistryFailure({ command: 'docker', args: ['pull', 'x'], attempts: 3, run, sleep }), 9);
    assert.equal(calls.length, 3, 'exactly the bound');
    assert.equal(waits.length, 2);
  });

  it('waits longer each time, and a wait is bounded', async () => {
    const { retryOnRegistryFailure } = await loadScript();
    const { run } = fakeRun([{ status: 1, output: TRANSIENT[0] }]);
    const { sleep, waits } = fakeSleep();
    await retryOnRegistryFailure({ command: 'docker', args: ['pull', 'x'], attempts: 4, run, sleep });
    assert.equal(waits.length, 3);
    for (let i = 1; i < waits.length; i++) assert.ok(waits[i] > waits[i - 1], `wait ${i} is not longer than the one before: ${waits}`);
    assert.ok(waits.reduce((a, b) => a + b, 0) <= 300, `the waits add to more than five minutes: ${waits}`);
  });

  it('refuses a bound that is not a whole number of at least one, and an empty command', async () => {
    const { retryOnRegistryFailure } = await loadScript();
    const { run } = fakeRun([{ status: 0, output: '' }]);
    const { sleep } = fakeSleep();
    for (const attempts of [0, -1, 1.5, NaN, 'x']) await assert.rejects(() => retryOnRegistryFailure({ command: 'docker', args: [], attempts, run, sleep }), /attempts/);
    await assert.rejects(() => retryOnRegistryFailure({ command: '', args: [], run, sleep }), /command/);
  });
});

describe('the command line', () => {
  const node = process.execPath;
  const cli = (args) => spawnSync(node, [join(REPO_ROOT, SCRIPT), ...args], { encoding: 'utf8', timeout: 60_000 });

  it('runs a command after `--`, retries a registry timeout and exits 0 when the retry succeeds', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ythril-retry-'));
    try {
      const counter = join(dir, 'n');
      writeFileSync(counter, '0');
      const flaky = `const fs=require('fs');const n=+fs.readFileSync(process.argv[1])+1;fs.writeFileSync(process.argv[1],String(n));if(n<2){console.error('Get https://registry-1.docker.io/v2/: context deadline exceeded');process.exit(1)}console.log('pulled')`;
      const r = cli(['--delay-seconds', '0', '--', node, '-e', flaky, counter]);
      assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
      assert.match(r.stdout, /pulled/);
      assert.equal(readFileSync(counter, 'utf8'), '2');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('returns a failure of another cause at once with its own exit status, having run the command once', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ythril-retry-'));
    try {
      const counter = join(dir, 'n');
      writeFileSync(counter, '0');
      const wrong = `const fs=require('fs');fs.writeFileSync(process.argv[1],String(+fs.readFileSync(process.argv[1])+1));console.error('manifest unknown');process.exit(5)`;
      const r = cli(['--delay-seconds', '0', '--', node, '-e', wrong, counter]);
      assert.equal(r.status, 5, `${r.stdout}\n${r.stderr}`);
      assert.equal(readFileSync(counter, 'utf8'), '1');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('refuses a command line with no `--` or nothing after it, exiting 2 and running nothing', () => {
    for (const args of [[], ['docker', 'pull', 'x'], ['--attempts', '3'], ['--']]) {
      const r = cli(args);
      assert.equal(r.status, 2, `${JSON.stringify(args)}: ${r.stdout}\n${r.stderr}`);
    }
  });
});

// ───────────────────────────────────────── the workflows ─────────────────────────────────────────

/**
 * The `docker/build-push-action` steps that pull their base images inside the action, where no wrapper can reach. Each is a
 * decision with a reason and a date to look again, never a condition in the rule. A step not listed here is refused.
 */
const UNWRAPPED_BUILD_PUSH = [
  { file: '.github/workflows/ci.yml', jobPattern: /^integration$/, stepName: /doc-(render|office) sidecar/, reviewBy: '2027-03-01',
    reason: 'a first-party image whose layers come from the GHA cache (scope per sidecar) and whose base is digest-pinned; the action has no retry, and the wrapped `docker buildx build` of the prepare job warms the same base' },
  { file: '.github/workflows/publish.yml', jobPattern: /./, stepName: /^Build and push$/, reviewBy: '2027-03-01',
    reason: 'the release build pushes two registries and two platforms from inside the action; a rerun of the release is the retry, and a wrapped build would hide a half-pushed tag' },
];

const RETRY = /retry-on-registry-failure\.mjs(?:\s+--[a-z-]+\s+\S+)*\s+--\s+$/;
const PULLS = /\bdocker\s+(?:pull|buildx\s+build)\b/g;
const PULL_OF = /\bdocker\s+pull\s+(?:--\S+\s+)*([^\s&|;\\]+)/;
/** An install from the npm registry: `npm ci`, `npm install` and the short and alias spellings of the latter. */
const NPM_INSTALLS = /\bnpm\s+(?:ci|clean-install|install|i|add)(?![\w-])/g;
const COMPOSE_UP =/\bdocker\s+compose\b[^\n]*?\bup\b[^\n]*/g;

const retriedPullOf = (step) => {
  const text = shellOf(step);
  for (const m of text.matchAll(/retry-on-registry-failure\.mjs(?:\s+--[a-z-]+\s+\S+)*\s+--\s+docker\s+pull\s+(?:--\S+\s+)*([^\s&|;\\]+)/g)) return m[1];
  return null;
};
const runsRetriedPull = (step) => /retry-on-registry-failure\.mjs(?:\s+--[a-z-]+\s+\S+)*\s+--\s+docker\s+pull\b/.test(shellOf(step));
const isCheckout = (s) => usesOf(s)?.action === 'actions/checkout';

/** Every way a workflow lets one registry hiccup fail it with no retry, as sentences. */
function registryViolations(doc, file) {
  const v = [];
  for (const { id, job } of jobEntries(doc)) {
    const steps = stepsOf(job);
    steps.forEach((s, i) => {
      const where = `${file} ${id} step ${JSON.stringify(s.name ?? s.uses ?? s.run?.split('\n')[0])}`;
      const text = shellOf(s);
      for (const m of text.matchAll(PULLS)) {
        if (!RETRY.test(text.slice(0, m.index))) v.push(`${where}: \`${m[0]}\` runs without ${SCRIPT}`);
      }
      for (const m of text.matchAll(NPM_INSTALLS)) {
        if (!RETRY.test(text.slice(0, m.index))) v.push(`${where}: \`${m[0]}\` runs without ${SCRIPT}`);
      }
      if (text.includes('retry-on-registry-failure.mjs') && !steps.slice(0, i).some(isCheckout)) v.push(`${where}: runs ${SCRIPT} before any checkout puts it on the runner`);
      for (const [cmd] of text.matchAll(COMPOSE_UP)) {
        if (!/--pull[ =]never\b/.test(cmd) && !steps.slice(0, i).some(runsRetriedPull)) v.push(`${where}: \`${cmd.trim()}\` may pull and no earlier step pulled through ${SCRIPT}`);
      }
      const uses = usesOf(s);
      if (uses?.action === 'docker/setup-buildx-action') {
        const image = /^image=(\S+)$/m.exec(String(s.with?.['driver-opts'] ?? ''))?.[1];
        if (!image) v.push(`${where}: names no BuildKit image in driver-opts: the builder pulls whatever the action's default is, unretried`);
        else if (!steps.slice(0, i).some((p) => retriedPullOf(p) === image)) v.push(`${where}: no earlier step pulls ${image} through ${SCRIPT}`);
      }
      if (uses?.action === 'docker/build-push-action') {
        const listed = UNWRAPPED_BUILD_PUSH.some((e) => e.file === file && e.jobPattern.test(id) && e.stepName.test(String(s.name ?? '')));
        if (!listed) v.push(`${where}: a build-push-action step that is not in UNWRAPPED_BUILD_PUSH`);
      }
    });
  }
  return v;
}

const WORKFLOWS = () => loadAllWorkflows();

describe('no workflow fails on one registry timeout before a test runs', () => {
  it('the retry script exists and is tracked', () => {
    assert.ok(existsSync(join(REPO_ROOT, SCRIPT)), `${SCRIPT} is missing`);
    assert.ok(trackedSources('scripts', { ext: ['.mjs'], floor: 10 }).includes(SCRIPT), `${SCRIPT} is not tracked by git: a clone has no such file`);
  });

  it('every workflow is derived from the tracked set, with a floor, and has no unretried registry pull', () => {
    const all = WORKFLOWS();
    assert.ok(all.length >= 4, `only ${all.length} workflows read`);
    const v = all.flatMap(({ file, doc }) => registryViolations(doc, file));
    assert.deepEqual(v, []);
  });

  it('the rule has subjects: the buildx setups, the pulls and the stack starts it governs are found, not assumed', () => {
    const all = WORKFLOWS();
    const steps = all.flatMap(({ doc }) => jobEntries(doc).flatMap(({ job }) => stepsOf(job)));
    assert.ok(steps.filter((s) => usesOf(s)?.action === 'docker/setup-buildx-action').length >= 4, 'fewer than four buildx setups found');
    assert.ok(steps.filter(runsRetriedPull).length >= 6, 'fewer than six retried pulls found');
    const builds = steps.reduce((n, s) => n + [...shellOf(s).matchAll(/\bdocker\s+buildx\s+build\b/g)].length, 0);
    assert.ok(builds >= 3, `${builds} buildx builds found, fewer than three`);
    const installs = steps.reduce((n, s) => n + [...shellOf(s).matchAll(NPM_INSTALLS)].length, 0);
    assert.ok(installs >= 9, `${installs} npm installs found, fewer than nine`);
  });

  it('each listed build-push exception has a reason, a review date still ahead, and matches a real step', () => {
    const all = WORKFLOWS();
    for (const e of UNWRAPPED_BUILD_PUSH) {
      assert.ok(e.reason.length > 20, `${e.file}: no reason`);
      assert.match(e.reviewBy, /^\d{4}-\d{2}-\d{2}$/);
      assert.ok(Date.parse(e.reviewBy) > Date.now(), `${e.file}: the review date ${e.reviewBy} has passed: look again`);
      const hit = all.filter((w) => w.file === e.file).some(({ doc }) => jobEntries(doc).some(({ id, job }) => e.jobPattern.test(id)
        && stepsOf(job).some((s) => usesOf(s)?.action === 'docker/build-push-action' && e.stepName.test(String(s.name ?? '')))));
      assert.ok(hit, `${e.file}: no build-push step matches ${e.stepName}: the entry is stale`);
    }
  });
});

describe('the rule refuses a planted copy of each defect', () => {
  const ci = () => readFileSync(join(REPO_ROOT, '.github/workflows/ci.yml'), 'utf8');
  const CI = '.github/workflows/ci.yml';

  it('the wrapper dropped from the real database pull', () => {
    const text = ci().replaceAll(/node scripts\/retry-on-registry-failure\.mjs\s+(?:--[a-z-]+\s+\S+\s+)*--\s+docker pull/g, 'docker pull');
    assert.notEqual(text, ci(), 'the plant changed nothing: the real step does not use the wrapper in the shape the plant expects');
    const v = registryViolations(parseWorkflow(text, CI), CI);
    assert.ok(v.some((m) => /`docker pull` runs without/.test(m)), JSON.stringify(v));
  });

  it('the wrapper dropped from the real image build', () => {
    const text = ci().replaceAll(/node scripts\/retry-on-registry-failure\.mjs\s+(?:--[a-z-]+\s+\S+\s+)*--\s+docker buildx build/g, 'docker buildx build');
    assert.notEqual(text, ci(), 'the plant changed nothing');
    const v = registryViolations(parseWorkflow(text, CI), CI);
    assert.ok(v.some((m) => /`docker buildx build` runs without/.test(m)), JSON.stringify(v));
  });

  it('the wrapper dropped from every real npm install, in every workflow', () => {
    for (const file of ['.github/workflows/ci.yml', '.github/workflows/publish.yml']) {
      const real = readFileSync(join(REPO_ROOT, file), 'utf8');
      const text = real.replaceAll(/node scripts\/retry-on-registry-failure\.mjs\s+(?:--[a-z-]+\s+\S+\s+)*--\s+npm\s+ci/g, 'npm ci');
      assert.notEqual(text, real, `${file}: the plant changed nothing: the real npm ci does not use the wrapper in the shape the plant expects`);
      const v = registryViolations(parseWorkflow(text, file), file);
      assert.ok(v.some((m) => /`npm ci` runs without/.test(m)), `${file}: ${JSON.stringify(v)}`);
    }
  });

  it('one real npm install step unwrapped on its own: the rule names that step and no other', () => {
    const doc = parseWorkflow(ci(), CI);
    const [first] = jobEntries(doc).flatMap(({ job }) => stepsOf(job)).filter((s) => /\bnpm\s+ci\b/.test(shellOf(s)));
    first.run = shellOf(first).replace(/^.*?(npm\s+ci\b)/s, '$1');
    const v = registryViolations(doc, CI);
    assert.equal(v.filter((m) => /npm ci/.test(m)).length, 1, JSON.stringify(v));
  });

  it('a planted npm install in a workflow nobody wrapped, and the wrapped spelling of it passing', () => {
    const plant = (run) => parseWorkflow(`on: push\njobs:\n  j:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - run: ${run}\n`, 'planted.yml');
    for (const bare of ['npm install --no-save left-pad', 'npm i left-pad', 'npm ci --workspace=server']) {
      const v = registryViolations(plant(bare), 'planted.yml');
      assert.ok(v.some((m) => /runs without/.test(m)), `${bare}: ${JSON.stringify(v)}`);
      assert.deepEqual(registryViolations(plant(`node scripts/retry-on-registry-failure.mjs -- ${bare}`), 'planted.yml'), [], bare);
    }
    assert.deepEqual(registryViolations(plant('npm run build && npm install-test-nothing'), 'planted.yml'), [], 'a longer command name is not an install');
  });

  it('the BuildKit pre-pull step removed from the real job that sets up buildx', () => {
    const doc = parseWorkflow(ci(), CI);
    for (const { job } of jobEntries(doc)) job.steps = stepsOf(job).filter((s) => !(runsRetriedPull(s) && /buildkit/.test(shellOf(s))));
    const v = registryViolations(doc, CI);
    assert.ok(v.some((m) => /no earlier step pulls moby\/buildkit/.test(m)), JSON.stringify(v));
  });

  it('driver-opts removed from the real buildx setup', () => {
    const doc = parseWorkflow(ci(), CI);
    for (const { job } of jobEntries(doc)) for (const s of stepsOf(job)) if (usesOf(s)?.action === 'docker/setup-buildx-action') delete s.with;
    const v = registryViolations(doc, CI);
    assert.ok(v.some((m) => /names no BuildKit image/.test(m)), JSON.stringify(v));
  });

  it('a build-push step nobody listed', () => {
    const doc = parseWorkflow(`${ci()}\n  planted:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - name: Build something else\n        uses: docker/build-push-action@v6\n`, CI);
    const v = registryViolations(doc, CI);
    assert.ok(v.some((m) => /not in UNWRAPPED_BUILD_PUSH/.test(m)), JSON.stringify(v));
  });

  it('a compose up that may pull with no retried pull before it', () => {
    const doc = parseWorkflow('on: push\njobs:\n  j:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - run: docker compose -p x -f c.yml up -d --wait svc\n', 'planted.yml');
    const v = registryViolations(doc, 'planted.yml');
    assert.ok(v.some((m) => /may pull/.test(m)), JSON.stringify(v));
  });

  it('the script run before the checkout', () => {
    const doc = parseWorkflow('on: push\njobs:\n  j:\n    runs-on: ubuntu-latest\n    steps:\n      - run: node scripts/retry-on-registry-failure.mjs -- docker pull x\n      - uses: actions/checkout@v4\n', 'planted.yml');
    const v = registryViolations(doc, 'planted.yml');
    assert.ok(v.some((m) => /before any checkout/.test(m)), JSON.stringify(v));
  });
});
