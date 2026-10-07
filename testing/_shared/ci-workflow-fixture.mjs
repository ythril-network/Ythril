/**
 * A miniature of the workflow `ci.yml` is held to — the conforming shape, and the only place it is written out.
 *
 * ## What it is for
 *
 * The gates over `ci.yml` (`ci-workflow-is-sound`, and the workflow cases in `changelog-entry-is-enforced`,
 * `cuda-download-is-skipped-everywhere` and `workflows-are-valid`) state rules. A rule that has only ever been
 * run against the real file has never been seen to FAIL where the real file is already right, so each rule is also
 * run against this document and against single deliberate breakages of it. If a mutation of this shape does not
 * make its rule fire, the rule is a claim and not a gate.
 *
 * It is a FIXTURE, so it is allowed to be literal (`CLAUDE.md`: a fixture that derives its expectations from the
 * code under test asserts that the code equals itself). It is not a copy of `ci.yml`: it carries one job of each
 * kind the rules distinguish — an install-only job, the job that builds and publishes the image, three stack
 * jobs, the advisory job and the gate — and nothing else. It is written in the shape the job graph is planned in
 * (bundle-56): when that graph changes, this document changes with it in the same commit, and the rules read the
 * change as a changed fixture rather than as a changed gate.
 *
 * `@{{` stands for the GitHub expression opener, because a JavaScript template literal would eat the real one.
 */

const SHA = '0123456789abcdef0123456789abcdef01234567';

const NPM_CI = `
      - name: Install dependencies
        run: npm ci
        env:
          ONNXRUNTIME_NODE_INSTALL_CUDA: skip`;

const UPLOAD_RESULTS = (job) => `
      - name: Upload test results
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: test-results-${job}-@{{ github.run_attempt }}
          path: test-results/
          if-no-files-found: error
          retention-days: 30`;

/** A stack job: full history, build the server its tests import, restore the image, start the stack from it without building or pulling, run, upload. */
const STACK_JOB = (id, name, script = id) => `
  ${id}:
    name: ${name}
    needs: prepare
    runs-on: ubuntu-latest
    timeout-minutes: 45
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
          persist-credentials: false
      - uses: actions/setup-node@v4
        with:
          node-version: '22'
          cache: npm${NPM_CI}
      - name: Build server
        run: npm run build:server
      - uses: actions/download-artifact@v4
        with:
          name: ythril-test-image-@{{ github.run_attempt }}
      - name: Load the test image
        run: docker load -i ythril-test-image.tar
      - name: Start test containers
        run: |
          docker compose -p ythril-test -f testing/docker-compose.test.yml up -d --wait \\
            --no-build --pull never
      - name: Run ${id}
        run: npm run test:${script}${UPLOAD_RESULTS(id)}`;

export const NEEDED_JOBS = ['client-tests', 'prepare', 'standalone', 'integration', 'sync'];

/**
 * The command the client job runs, written once: the fixture's client step and the fixture's preflight both carry it, and
 * the rule that holds the two equal (`ci-workflow-is-sound`, "preflight runs the client's command") reads it from both.
 */
export const CLIENT_COMMAND = 'npm run test --workspace=client -- --reporter=default --reporter=json --outputFile.json=../test-results/client.json';

/**
 * A miniature of `scripts/preflight.mjs` in the one respect the parity rule reads: how it runs the client's unit tests. The
 * wrapper is the real one's shape (a local `run` over `execSync`) and gives its child `testChildEnv`'s environment.
 */
export const GOOD_PREFLIGHT = `
import { execSync } from 'node:child_process';
import { testChildEnv } from '../testing/_shared/test-child-env.mjs';

const run = (cmd, opts = {}) => execSync(cmd, { stdio: 'inherit', env: testChildEnv(), ...opts });

try { run('npm run typecheck:client'); } catch { /* reported below */ }
try { run('${CLIENT_COMMAND}'); } catch { /* reported below */ }
`;

const verdictLines = NEEDED_JOBS
  .map((id) => `          [ "@{{ needs.${id}.result }}" = success ] || { echo "${id}: not success"; exit 1; }`)
  .join('\n');

export const GOOD_CI = `
name: CI
on:
  pull_request:
    branches: [main, 'release/**']
  push:
    branches: [main]
  workflow_call:
permissions:
  contents: read
concurrency:
  group: ci-@{{ github.event_name }}-@{{ github.ref }}
  cancel-in-progress: @{{ github.event_name == 'pull_request' }}
env:
  FORCE_JAVASCRIPT_ACTIONS_TO_NODE24: true
jobs:
  client-tests:
    name: Client tests
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
          persist-credentials: false
      - uses: actions/setup-node@v4
        with:
          node-version: '22'
          cache: npm${NPM_CI}
      - name: Client unit tests
        run: ${CLIENT_COMMAND}${UPLOAD_RESULTS('client-tests')}
  prepare:
    name: Prepare
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
          persist-credentials: false
      - uses: actions/setup-node@v4
        with:
          node-version: '22'
          cache: npm${NPM_CI}
      - name: CHANGELOG entry for shipped changes
        if: github.event_name == 'pull_request'
        run: |
          # comment lines are not the script
          node scripts/check-changelog.mjs "origin/$GITHUB_BASE_REF"
      - name: Set up Docker Buildx
        uses: docker/setup-buildx-action@v3
      - name: Expose GitHub Actions cache to Buildx
        uses: crazy-max/ghaction-github-runtime@${SHA}
      - name: Build test image
        run: |
          docker buildx build \\
            --cache-from type=gha,scope=ythril-test \\
            @{{ github.event_name == 'push' && github.ref == 'refs/heads/main' && '--cache-to type=gha,mode=max,scope=ythril-test' || '' }} \\
            --output type=docker,dest=ythril-test-image.tar -t ythril-test:latest -f Dockerfile .
      - name: Upload the test image
        uses: actions/upload-artifact@v4
        with:
          name: ythril-test-image-@{{ github.run_attempt }}
          path: |
            ythril-test-image.tar
            server/dist
          if-no-files-found: error
          retention-days: 1
          compression-level: 0${STACK_JOB('standalone', 'Standalone', 'standalone:instance')}${STACK_JOB('integration', 'Integration')}${STACK_JOB('sync', 'Sync')}
  ci-advisory:
    name: CI advisory
    needs: [standalone, integration, sync]
    if: always()
    continue-on-error: true
    runs-on: ubuntu-latest
    timeout-minutes: 10
    permissions:
      contents: read
      actions: read
    steps:
      - uses: actions/checkout@v4
        with:
          persist-credentials: false
      - uses: actions/setup-node@v4
        with:
          node-version: '22'
      - uses: actions/download-artifact@v4
        with:
          pattern: test-results-*-@{{ github.run_attempt }}
          path: test-results
          merge-multiple: true
      - name: Timings summary
        env:
          GH_TOKEN: @{{ github.token }}
        run: node scripts/test-times.mjs --summary --results test-results
  test:
    name: Build & Test
    if: always()
    needs: [${NEEDED_JOBS.join(', ')}]
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - name: Every needed job succeeded
        run: |
${verdictLines}
      - uses: actions/checkout@v4
        with:
          persist-credentials: false
      - uses: actions/setup-node@v4
        with:
          node-version: '22'
      - name: Download every job's test results
        uses: actions/download-artifact@v4
        with:
          pattern: test-results-*-@{{ github.run_attempt }}
          path: test-results
          merge-multiple: true
      - name: Every tracked test file produced a test event
        run: node scripts/executed-tests.mjs --results test-results
      - name: No skip nobody expected
        run: node scripts/unexpected-skips.mjs --results test-results
`.replaceAll('@{{', '${{');

/**
 * A miniature of `full-run.yml`, the caller that runs the whole of `GOOD_CI` on a push to `full-run/<bundle>`: one job that
 * only calls it, grants the caller's token what the called jobs ask (`ci-advisory`'s `actions: read`, and nothing else),
 * and cancels an older run of the same ref. The rules that hold it read `GOOD_CI` beside it, so the two change together.
 */
export const GOOD_FULL_RUN = `
name: Full run
on:
  push:
    branches: ['full-run/**']
permissions:
  contents: read
concurrency:
  group: full-run-@{{ github.ref }}
  cancel-in-progress: true
jobs:
  full:
    name: Full run
    permissions:
      contents: read
      actions: read
    uses: ./.github/workflows/ci.yml
`.replaceAll('@{{', '${{');
