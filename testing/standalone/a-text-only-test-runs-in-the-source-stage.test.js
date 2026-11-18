/**
 * A text-only standalone test runs in the preflight's source stage, and in CI before anything is installed or built (Q-870, bundle-316).
 *
 * ## The defect this refuses
 *
 * A standalone file that reads only tracked text was run after the server build and the client build, with the files that need them, so a failure
 * in the changelog test or any of 340 like it was found minutes late. And the one thing a static rule cannot see, a build path that lives in data
 * (a decision record that cites `server/dist`, a JSON file), would stay hidden on a developer machine, where a stale `server/dist` usually exists
 * and lets a misclassified file pass. CI has no build before its install, so the same files run there first, with the build really absent.
 *
 * ## What is asserted
 *
 * - **The runner** (`testing/_init/run-standalone.mjs`, run in a scratch git checkout with no `server/dist`): `--only=text` runs the text kind and only
 *   it, and needs no server build (the stale-build refusal does not apply to it); `--only=pure` runs the pure kind without the text files, once a
 *   build exists; a plain run holds both, so every file still runs exactly once and its timing is recorded once.
 * - **The workflow** (`.github/workflows/ci.yml`, parsed, never read as text): the job that runs the pure third has a step that runs the text kind,
 *   after `actions/setup-node` and before `npm ci` and the server build, and runs it exactly once.
 * - **The preflight text stage** (`scripts/preflight.mjs`, read as a syntax tree): the stage `text-only standalone tests` is registered; its body takes
 *   the runs of kind `text`, leaves out the gate files (`SOURCE_GATE_FILES`), goes through `slowFirstUnits` and `runTestUnits`, takes its workers from
 *   `workersPerUnit(UNIT_WIDTH)` with `UNIT_WIDTH` declared once, at module scope, and names its timing batches `text-N`.
 * - **The timing clear** happens before any stage body runs: it is in no stage's body but the first stage's, so a source stage's results survive.
 *
 * Seen red on the unchanged code: the runner refuses `--only=text`, the workflow has no such step, and the stage is not registered.
 *
 * Run: node --test testing/standalone/a-text-only-test-runs-in-the-source-stage.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { REPO_ROOT, SERVER_CODE_ROOTS } from './_sources.mjs';
import { makeScratchRepo } from '../_shared/scratch-git-repo.mjs';
import { testChildEnv } from '../_shared/test-child-env.mjs';
import { importOrFail } from '../_shared/import-or-fail.mjs';
import { parseSource, ts } from '../_shared/syntax-tree.mjs';
import { loadCi, stepsOf, shellOf, jobRunning, usesOf, runsNpmCi } from '../_shared/ci-workflow.mjs';

const TEXT_STAGE = 'text-only standalone tests';

describe('the standalone runner runs the text kind and the pure kind apart', () => {
  const RUNNER = join(REPO_ROOT, 'testing/_init/run-standalone.mjs');
  const TEXT_FILES = 5;
  const PURE_FILES = 100;

  /** A scratch checkout the split accepts (100 test files, 30 that import the database harness, 20 helpers): five text-only files and a hundred that name the server build. */
  function checkout({ built }) {
    const repo = makeScratchRepo({ prefix: 'standalone-text-' });
    const { dir } = repo;
    mkdirSync(join(dir, 'testing/standalone'), { recursive: true });
    mkdirSync(join(dir, 'testing/_shared'), { recursive: true });
    const test = (label, body = '') => `import test from 'node:test';\n${body}test(${JSON.stringify(`ran ${label}`)}, () => {});\n`;
    for (let i = 1; i <= TEXT_FILES; i++) writeFileSync(join(dir, `testing/standalone/text-${i}.test.js`), test(`text-${i}`));
    for (let i = 1; i <= PURE_FILES; i++) writeFileSync(join(dir, `testing/standalone/pure-${i}.test.js`), test(`pure-${i}`, "const BUILD = 'server/dist/index.js';\nvoid BUILD;\n"));
    for (let i = 1; i <= 30; i++) writeFileSync(join(dir, `testing/standalone/db-${i}.test.js`), "import { openTestMongo } from './_mongo-harness.mjs';\nvoid openTestMongo;\n");
    for (let i = 1; i <= 20; i++) writeFileSync(join(dir, `testing/_shared/helper-${i}.mjs`), 'export {};\n');
    if (built) {
      // The builds the runner accepts: for each root of the server's code (the server and the schema package it imports), the source is older than the
      // built entry point of its sibling dist (`_shared/stale-build.mjs` refuses a missing or older one).
      for (const src of SERVER_CODE_ROOTS) {
        const pkg = dirname(src);
        mkdirSync(join(dir, src), { recursive: true });
        mkdirSync(join(dir, pkg, 'dist'), { recursive: true });
        writeFileSync(join(dir, src, 'a.ts'), 'export {};\n');
        writeFileSync(join(dir, pkg, 'dist/index.js'), 'export {};\n');
        utimesSync(join(dir, src, 'a.ts'), new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
      }
    }
    repo.git('add', '-A');
    return repo;
  }

  const runIn = (repo, args) => {
    const r = spawnSync(process.execPath, [RUNNER, ...args], {
      cwd: repo.dir, encoding: 'utf8', timeout: 150_000, maxBuffer: 64 * 1024 * 1024,
      env: testChildEnv({ CI: '', YTHRIL_TEST_RESULTS_DIR: join(repo.dir, 'test-results') }),
    });
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    const ran = (kind) => new Set([...out.matchAll(new RegExp(`ran (${kind}-\\d+)`, 'g'))].map(m => m[1]));
    return { status: r.status, out, text: ran('text'), pure: ran('pure') };
  };

  it('--only=text runs every text-only file and no other, with no server build present', () => {
    const repo = checkout({ built: false });
    try {
      const r = runIn(repo, ['--only=text']);
      assert.equal(r.status, 0, `--only=text did not run clean: ${r.out.slice(0, 1500)}`);
      assert.equal(r.text.size, TEXT_FILES, `the text kind ran ${r.text.size} file(s), not ${TEXT_FILES}:\n${r.out.slice(0, 1500)}`);
      assert.equal(r.pure.size, 0, 'a file that names the server build ran under --only=text');
      assert.doesNotMatch(r.out, /\b(?:server|schema)\/dist\b[^\n]*\bmissing\b|\bis missing\b/, 'the text kind was refused for a missing server or schema build it does not need');
    } finally { repo.cleanup(); }
  });

  it('--only=pure runs the pure kind without the text files', () => {
    const repo = checkout({ built: true });
    try {
      const r = runIn(repo, ['--only=pure']);
      assert.equal(r.status, 0, r.out.slice(0, 1500));
      assert.equal(r.pure.size, PURE_FILES, `the pure kind ran ${r.pure.size} file(s), not ${PURE_FILES}`);
      assert.equal(r.text.size, 0, 'a text-only file ran under --only=pure as well, so it runs twice in CI');
    } finally { repo.cleanup(); }
  });

  it('the pure kind is refused for a missing build of any root of the server code, and the text kind runs clean in the same checkout', () => {
    for (const src of SERVER_CODE_ROOTS) {
      const pkg = dirname(src);
      const repo = checkout({ built: true });
      try {
        rmSync(join(repo.dir, pkg, 'dist'), { recursive: true, force: true });
        const pure = runIn(repo, ['--only=pure']);
        assert.equal(pure.status, 1, `--only=pure ran without ${pkg}/dist: ${pure.out.slice(0, 800)}`);
        assert.match(pure.out, new RegExp(`${pkg}/dist/index\\.js is missing`), `the refusal does not name ${pkg}/dist`);
        const text = runIn(repo, ['--only=text']);
        assert.equal(text.status, 0, `--only=text needed ${pkg}/dist: ${text.out.slice(0, 800)}`);
        assert.equal(text.text.size, TEXT_FILES);
      } finally { repo.cleanup(); }
    }
  });

  it('an unknown value is still refused, and the refusal lists the text kind among the values the runner knows', () => {
    const repo = checkout({ built: true });
    try {
      const unknown = runIn(repo, ['--only=nothing']);
      assert.equal(unknown.status, 1, unknown.out.slice(0, 800));
      assert.match(unknown.out, /text/, 'the refusal does not list the text kind among the values it knows');
    } finally { repo.cleanup(); }
  });
});

describe('CI runs the text kind in the pure job, after setup-node and before the install and the builds, once', () => {
  /** What a step runs, with an npm script followed into package.json (the script may be named whatever the change names it). */
  const commandOf = (step) => {
    const shell = shellOf(step);
    const scripts = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')).scripts ?? {};
    const named = [...shell.matchAll(/\bnpm\s+run\s+([\w:.-]+)/g)].map(m => scripts[m[1]] ?? '');
    return [shell, ...named].join('\n');
  };

  it('has exactly one step that runs the text kind, in the job that runs the pure third', () => {
    const { job } = jobRunning(loadCi(), 'test:standalone:pure');
    const steps = stepsOf(job);
    const text = steps.filter(s => /run-standalone\.mjs\s+--only=text\b/.test(commandOf(s)));
    assert.equal(text.length, 1, `${text.length} step(s) of the pure job run the text kind`);
  });

  it('puts it after actions/setup-node and before npm ci and the server build', () => {
    const { job } = jobRunning(loadCi(), 'test:standalone:pure');
    const steps = stepsOf(job);
    const at = (pred) => steps.findIndex(pred);
    const text = at(s => /run-standalone\.mjs\s+--only=text\b/.test(commandOf(s)));
    assert.ok(text >= 0, 'no step of the pure job runs the text kind: a build path in data would stay hidden');
    const setup = at(s => usesOf(s)?.action === 'actions/setup-node');
    const install = at(runsNpmCi);
    const build = at(s => /\bbuild:server\b/.test(shellOf(s)));
    assert.ok(setup >= 0 && install >= 0 && build >= 0, 'the pure job lost its setup-node, npm ci or build:server step');
    assert.ok(setup < text, 'the text step runs before setup-node, on the runner image\'s default node');
    assert.ok(text < install, 'the text step runs after npm ci: node_modules is present, so a hidden package need is not found');
    assert.ok(text < build, 'the text step runs after the server build: a stale or fresh build hides a hidden build need');
  });
});

describe('scripts/preflight.mjs: the text stage (read as a syntax tree)', () => {
  const sf = parseSource('scripts/preflight.mjs#text-stage', readFileSync(join(REPO_ROOT, 'scripts/preflight.mjs'), 'utf8'));
  const visit = (node, fn) => { fn(node); ts.forEachChild(node, (c) => visit(c, fn)); };
  const isStage = (n) => ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'stage'
    && n.arguments.length >= 2 && ts.isStringLiteralLike(n.arguments[0]) && ts.isFunctionLike(n.arguments[1]);
  const stages = () => { const out = []; visit(sf, (n) => { if (isStage(n)) out.push(n); }); return out; };
  const bodyOf = (name) => stages().find(c => c.arguments[0].text === name)?.arguments[1];
  const calls = (node, name) => { const out = []; visit(node, (n) => { if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === name) out.push(n); }); return out; };

  it('registers the stage, and its body takes the text runs, leaves out the gate files and goes through slowFirstUnits and runTestUnits', () => {
    const body = bodyOf(TEXT_STAGE);
    assert.ok(body, `no stage('${TEXT_STAGE}', ...) is registered in scripts/preflight.mjs`);
    const text = body.getText(sf);
    assert.match(text, /\.kind\s*===\s*['"]text['"]/, 'the stage does not take the runs of kind text');
    assert.match(text, /\bSOURCE_GATE_FILES\b/, 'the stage does not leave out the gate files, which run in their own stages');
    assert.equal(calls(body, 'slowFirstUnits').length, 1, 'the stage does not build its units with slowFirstUnits (once)');
    assert.equal(calls(body, 'runTestUnits').length, 1, 'the stage does not run its units through runTestUnits (once)');
    assert.match(text, /workersPerUnit\(\s*UNIT_WIDTH\s*\)/, 'the stage does not take its workers from workersPerUnit(UNIT_WIDTH)');
    assert.match(text, /batch\s*:\s*`text-\$\{/, 'the stage does not name its timing batches text-N');
  });

  it('declares UNIT_WIDTH once, at module scope, so both stages take the one width', () => {
    const declared = [];
    visit(sf, (n) => { if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === 'UNIT_WIDTH') declared.push(n); });
    assert.equal(declared.length, 1, `UNIT_WIDTH is declared ${declared.length} times`);
    assert.ok(sf.statements.some(s => ts.isVariableStatement(s) && s.declarationList.declarations.includes(declared[0])), 'UNIT_WIDTH is declared inside a function, not at module scope');
  });

  it('clears the earlier timing files before any stage body runs: in no stage but the first, so a source stage\'s own results are not removed', async () => {
    const { PREFLIGHT_STAGES } = await importOrFail('scripts/_shared/preflight-stages.mjs', 'the stage list');
    const first = PREFLIGHT_STAGES[0].name;
    const clears = calls(sf, 'clearTimingResults');
    assert.ok(clears.length >= 1, 'preflight no longer clears its earlier timing files');
    for (const c of clears) {
      let holder = null;
      for (let p = c.parent; p; p = p.parent) {
        if (ts.isFunctionLike(p) && p.parent && isStage(p.parent) && p.parent.arguments[1] === p) { holder = p.parent.arguments[0].text; break; }
      }
      assert.ok(holder === null || holder === first, `clearTimingResults is in the body of stage '${holder}': it removes the results of every stage that ran before it (the text stage's among them)`);
    }
    assert.ok(stages().length > 10, 'the scan found no stages');
  });
});
