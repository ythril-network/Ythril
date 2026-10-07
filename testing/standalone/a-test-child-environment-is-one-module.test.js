/**
 * What a test child inherits is decided in one module, and no other file keeps its own copy of the rule.
 *
 * `testing/_shared/test-child-env.mjs` drops two things from the environment a test child inherits: the recorder's
 * `YTHRIL_TEST_RUNS_*` family and the runner's `NODE_TEST_CONTEXT`. Before this gate the second was dropped by a
 * helper in `_timing-runs.mjs` and by four inline `delete env.NODE_TEST_CONTEXT` lines, and the first was retyped as
 * a regex in the recorder harness — three ways to build a child environment, two sources for the prefix.
 *
 * Two halves: the module's truth table, and a derived refusal over every tracked source: none but the module names
 * `NODE_TEST_CONTEXT` in code, and none retypes the recorder prefix (a bare `YTHRIL_TEST_RUNS_` that is not the start
 * of a variable name — the recorder's own `YTHRIL_TEST_RUNS_URL` / `_TOKEN` are variables, not the prefix).
 *
 * Run: node --test testing/standalone/a-test-child-environment-is-one-module.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT, trackedSources } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';
import { parseSource, lineOf, ts } from '../_shared/syntax-tree.mjs';
import { testChildEnv, RECORDER_ENV_PREFIX } from '../_shared/test-child-env.mjs';
import { childEnv } from './_timing-runs.mjs';
import { cleanEnv } from '../_shared/test-times-harness.mjs';

const MODULE = 'testing/_shared/test-child-env.mjs';
const THIS = 'testing/standalone/a-test-child-environment-is-one-module.test.js';

describe('testChildEnv: what a child inherits', () => {
  const base = {
    PATH: '/bin',
    NODE_TEST_CONTEXT: 'child-v8',
    YTHRIL_TEST_RUNS_URL: 'https://record.example',
    YTHRIL_TEST_RUNS_TOKEN: 'secret',
    YTHRIL_TEST_RUNS_FUTURE_THING: 'x',
    ythril_test_runs_lower: 'y',
    YTHRIL_URL: 'https://not-the-recorder.example',
    HOME: '/home/x',
  };

  it('drops the runner wire and every recorder variable, whatever its case', () => {
    const env = testChildEnv({}, base);
    assert.deepEqual(Object.keys(env).sort(), ['HOME', 'PATH', 'YTHRIL_URL']);
  });

  it('what the caller adds is kept untouched, even from the dropped families', () => {
    const env = testChildEnv({ YTHRIL_TEST_RUNS_URL: 'http://127.0.0.1:1', NODE_TEST_CONTEXT: 'on-purpose', X: '1' }, base);
    assert.equal(env.YTHRIL_TEST_RUNS_URL, 'http://127.0.0.1:1');
    assert.equal(env.NODE_TEST_CONTEXT, 'on-purpose');
    assert.equal(env.X, '1');
    assert.equal(env.YTHRIL_TEST_RUNS_TOKEN, undefined, 'only the caller\'s own variables survive from that family');
  });

  it('does not touch the environment it was given', () => {
    const copy = { ...base };
    testChildEnv({ X: '1' }, base);
    assert.deepEqual(base, copy);
  });

  it('defaults to this process\'s environment', () => {
    const saved = { wire: process.env.NODE_TEST_CONTEXT, token: process.env.YTHRIL_TEST_RUNS_TOKEN };
    try {
      process.env.NODE_TEST_CONTEXT = 'x';
      process.env.YTHRIL_TEST_RUNS_TOKEN = 'y';
      const env = testChildEnv();
      assert.equal(env.NODE_TEST_CONTEXT, undefined);
      assert.equal(env.YTHRIL_TEST_RUNS_TOKEN, undefined);
      assert.equal(env.PATH ?? env.Path, process.env.PATH ?? process.env.Path, 'the rest is inherited');
    } finally {
      if (saved.wire === undefined) delete process.env.NODE_TEST_CONTEXT; else process.env.NODE_TEST_CONTEXT = saved.wire;
      if (saved.token === undefined) delete process.env.YTHRIL_TEST_RUNS_TOKEN; else process.env.YTHRIL_TEST_RUNS_TOKEN = saved.token;
    }
  });

  it('the prefix is the one the recorder\'s variables carry', () => {
    assert.ok('YTHRIL_TEST_RUNS_URL'.startsWith(RECORDER_ENV_PREFIX));
    assert.ok('YTHRIL_TEST_RUNS_TOKEN'.startsWith(RECORDER_ENV_PREFIX));
  });
});

describe('the helpers that build on it keep what it drops dropped', () => {
  const saved = { wire: process.env.NODE_TEST_CONTEXT, token: process.env.YTHRIL_TEST_RUNS_TOKEN };
  const restore = () => {
    if (saved.wire === undefined) delete process.env.NODE_TEST_CONTEXT; else process.env.NODE_TEST_CONTEXT = saved.wire;
    if (saved.token === undefined) delete process.env.YTHRIL_TEST_RUNS_TOKEN; else process.env.YTHRIL_TEST_RUNS_TOKEN = saved.token;
  };

  for (const [name, build] of [['_timing-runs childEnv', childEnv], ['test-times-harness cleanEnv', cleanEnv]]) {
    it(`${name} drops the runner wire and the recorder token`, () => {
      try {
        process.env.NODE_TEST_CONTEXT = 'x';
        process.env.YTHRIL_TEST_RUNS_TOKEN = 'y';
        const env = build();
        assert.equal(env.NODE_TEST_CONTEXT, undefined);
        assert.equal(env.YTHRIL_TEST_RUNS_TOKEN, undefined);
      } finally { restore(); }
    });
  }

  it('childEnv still drops the colour and option variables a fixture run must not inherit', () => {
    const env = childEnv({ FORCE_COLOR: '1', NODE_OPTIONS: '--x' });
    assert.equal(env.FORCE_COLOR, undefined);
    assert.equal(env.NODE_OPTIONS, undefined);
    assert.equal(env.NO_COLOR, '1');
  });

  it('cleanEnv still drops what could redirect a recording, and keeps what the test gives it', () => {
    const had = process.env.GH_TOKEN;
    try {
      process.env.GH_TOKEN = 'ghp_x';
      const env = cleanEnv({ YTHRIL_TEST_RUNS_URL: 'http://127.0.0.1:2' });
      assert.equal(env.GH_TOKEN, undefined);
      assert.equal(env.YTHRIL_TEST_RUNS_URL, 'http://127.0.0.1:2');
    } finally { if (had === undefined) delete process.env.GH_TOKEN; else process.env.GH_TOKEN = had; }
  });
});

/** The `child_process` calls that start a process, the module's names, and what a command that runs tests looks like. */
const SPAWNERS = new Set(['exec', 'execSync', 'execFile', 'execFileSync', 'spawn', 'spawnSync', 'fork']);
const CHILD_PROCESS = /^(?:node:)?child_process$/;
const RUNS_TESTS = /--test\b|\bvitest\b|\bnpm run test:client\b|\bnpm run test\b[^\n]*--workspace[ =]client/;

/**
 * The test-process spawns of one file, read from its syntax tree: every call that starts a child which RUNS TESTS (the
 * command names `--test`, `vitest` or the client's test script), each with whether its environment is `testChildEnv`'s.
 *
 * What it prevents: the rule above is held for the files that build a child's environment, and says nothing about a spawn
 * that builds none — `execSync('npm run test:client')` inherits the whole environment, the recorder's token included, and
 * the vitest run that follows (and every dependency it imports) holds a write token it never needs. A spawn is a site when
 * it is a `child_process` call, or a call of a local wrapper over one (`const run = (cmd) => execSync(cmd, …)`); it is
 * scrubbed when its own `env` option is a `testChildEnv(…)` call, or when the wrapper's spawn is. A command that starts
 * ANOTHER of this repository's runners (`npm run test:integration`, which goes through `run-suite.mjs`) is not a test
 * process: its child scrubs for itself.
 *
 * @param {string} file for the language and the findings
 * @param {string} text
 * @returns {{ file: string, line: number, command: string, scrubbed: boolean }[]}
 */
function testSpawnSites(file, text) {
  const sf = parseSource(file, text);
  const names = new Set();       // local names bound to a spawner
  const namespaces = new Set();  // local names bound to the whole module
  const all = [];
  const collect = (n) => { all.push(n); ts.forEachChild(n, collect); };
  collect(sf);

  for (const n of all) {
    if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier) && CHILD_PROCESS.test(n.moduleSpecifier.text)) {
      const bound = n.importClause?.namedBindings;
      if (n.importClause?.name) namespaces.add(n.importClause.name.text);
      if (bound && ts.isNamespaceImport(bound)) namespaces.add(bound.name.text);
      if (bound && ts.isNamedImports(bound)) for (const e of bound.elements) if (SPAWNERS.has((e.propertyName ?? e.name).text)) names.add(e.name.text);
    }
    if (ts.isVariableDeclaration(n) && n.initializer && ts.isCallExpression(n.initializer)
      && ts.isIdentifier(n.initializer.expression) && n.initializer.expression.text === 'require'
      && n.initializer.arguments[0] && ts.isStringLiteral(n.initializer.arguments[0]) && CHILD_PROCESS.test(n.initializer.arguments[0].text)) {
      if (ts.isIdentifier(n.name)) namespaces.add(n.name.text);
      else for (const e of n.name.elements) if (SPAWNERS.has((e.propertyName ?? e.name).text)) names.add(e.name.text);
    }
  }

  const isSpawn = (c) => (ts.isIdentifier(c.expression) && names.has(c.expression.text))
    || (ts.isPropertyAccessExpression(c.expression) && ts.isIdentifier(c.expression.expression)
      && namespaces.has(c.expression.expression.text) && SPAWNERS.has(c.expression.name.text));

  /** The text of the `env` option an options object carries, or null. Only an inline `env: …` counts: a shorthand `{ env }` is a variable nobody can read here. */
  const envOption = (call) => {
    for (const a of [...call.arguments].reverse()) {
      if (!ts.isObjectLiteralExpression(a)) continue;
      const p = a.properties.find((x) => ts.isPropertyAssignment(x) && x.name.getText(sf) === 'env');
      if (p) return p.initializer.getText(sf);
    }
    return null;
  };
  const scrubs = (call) => /\btestChildEnv\s*\(/.test(envOption(call) ?? '');

  // A local wrapper over a spawn: a function bound to a name whose body holds a spawn call. It scrubs by default when every spawn in it does.
  const wrappers = new Map();
  for (const n of all) {
    const fn = ts.isFunctionDeclaration(n) ? n : (ts.isVariableDeclaration(n) && n.initializer && ts.isFunctionLike(n.initializer) ? n.initializer : null);
    if (!fn || !n.name || !ts.isIdentifier(n.name)) continue;
    const inner = [];
    const find = (m) => { if (ts.isCallExpression(m) && isSpawn(m)) inner.push(m); ts.forEachChild(m, find); };
    find(fn);
    if (inner.length > 0) wrappers.set(n.name.text, inner.every(scrubs));
  }

  /** Variables declared with a value that is not a function: name → their initializers' text. */
  const declared = new Map();
  for (const n of all) {
    if (!ts.isVariableDeclaration(n) || !n.initializer || !ts.isIdentifier(n.name) || ts.isFunctionLike(n.initializer)) continue;
    declared.set(n.name.text, `${declared.get(n.name.text) ?? ''} ${n.initializer.getText(sf)}`);
  }

  const sites = [];
  for (const n of all) {
    if (!ts.isCallExpression(n)) continue;
    const spawn = isSpawn(n);
    const wrapper = ts.isIdentifier(n.expression) && wrappers.has(n.expression.text);
    if (!spawn && !wrapper) continue;
    // A command held in a variable one line up (`const args = ['--test', …]; spawnSync(process.execPath, args, …)`) is read
    // through that variable, one level: a runner that builds its arguments first must not escape for the order it wrote them in.
    const command = n.arguments.map((a) => (ts.isIdentifier(a) && declared.has(a.text) ? `${a.text} = ${declared.get(a.text)}` : a.getText(sf))).join(', ');
    if (!RUNS_TESTS.test(command)) continue;
    sites.push({
      file, line: lineOf(sf, n), command: command.replace(/\s+/g, ' ').slice(0, 90),
      scrubbed: spawn ? scrubs(n) : (wrappers.get(n.expression.text) || scrubs(n)),
    });
  }
  return sites;
}

describe('the gate reads a test-process spawn and whether its environment is testChildEnv\'s', () => {
  const CP = "import { execSync, execFileSync, spawnSync } from 'node:child_process';\nimport { testChildEnv } from '../testing/_shared/test-child-env.mjs';\n";
  const sites = (code) => testSpawnSites('x.mjs', code);
  const verdicts = (code) => sites(code).map((s) => s.scrubbed);

  for (const [what, code, expected] of [
    ['execFileSync with testChildEnv', `${CP}execFileSync('node', ['--test', 'a.js'], { stdio: 'inherit', env: testChildEnv(flags.env) });`, [true]],
    ['spawnSync with testChildEnv, the options object not last', `${CP}spawnSync(process.execPath, ['--test', ...f], { env: testChildEnv({}) }, 1);`, [true]],
    ['execSync of the client script with no env', `${CP}execSync('npm run test:client', { stdio: 'inherit' });`, [false]],
    ['execSync of node --test with no options', `${CP}execSync('node --test x.test.js');`, [false]],
    ['spawnSync with the whole environment', `${CP}spawnSync('node', ['--test', 'a.js'], { env: process.env });`, [false]],
    ['spawnSync with an env spread from the process', `${CP}spawnSync('node', ['--test', 'a.js'], { env: { ...process.env, X: '1' } });`, [false]],
    ['a shorthand env nobody can read', `${CP}const env = testChildEnv();\nexecFileSync('node', ['--test'], { env });`, [false]],
    ['vitest', `${CP}execSync('npx vitest run', {});`, [false]],
    ['the workspace script, spelled as ci.yml does', `${CP}execSync('npm run test --workspace=client -- --reporter=json', {});`, [false]],
    ['a wrapper with no env: its call sites are the sites', `${CP}const run = (cmd, opts = {}) => execSync(cmd, { stdio: 'inherit', ...opts });\nrun('npm run test:client');\nrun('npm run build:server');`, [false]],
    ['a wrapper that scrubs by default', `${CP}const run = (cmd, opts = {}) => execSync(cmd, { stdio: 'inherit', env: testChildEnv(), ...opts });\nrun('npm run test:client');`, [true]],
    ['a wrapper called with its own env', `${CP}const run = (cmd, opts = {}) => execSync(cmd, { stdio: 'inherit', ...opts });\nrun('npm run test:client', { env: testChildEnv() });`, [true]],
    ['a function declaration as the wrapper, called from another function', `${CP}function go(cmd) { return spawnSync(cmd, { shell: true }); }\nfunction gate(f) { go(\`node --test \${f}\`); }`, [false]],
    ['arguments built in a variable first', `${CP}const args = ['--test', '--test-concurrency=1', ...files];\nspawnSync(process.execPath, args, { cwd: root, env: testChildEnv(flags.env) });`, [true]],
    ['arguments built in a variable first, no env', `${CP}const args = ['--test', ...files];\nspawnSync(process.execPath, args, { cwd: root });`, [false]],
    ['a namespace import', "import * as cp from 'child_process';\ncp.spawnSync('node', ['--test', 'a.js'], {});", [false]],
    ['a required module', "const { spawnSync } = require('node:child_process');\nspawnSync('node', ['--test', 'a.js'], {});", [false]],
    ['a required namespace', "const cp = require('child_process');\ncp.execFileSync('node', ['--test'], { env: testChildEnv() });", [true]],
  ]) it(`finds: ${what}`, () => assert.deepEqual(verdicts(code), expected));

  for (const [what, code] of [
    ['a syntax check', `${CP}execSync('node --check x.js', { stdio: 'pipe' });`],
    ['another runner of this repository (it scrubs for itself)', `${CP}spawnSync('npm', ['run', script], { stdio: 'inherit', shell: true, env: process.env });\nspawnSync('npm run test:all:core', { shell: true });`],
    ['a build', `${CP}execSync('npm run build:prod --workspace=client -- --verbose', { encoding: 'utf8' });`],
    ['a variable that names no test run', `${CP}const args = ['--check', 'x.js'];\nspawnSync(process.execPath, args, {});`],
    ['a call that is not a spawn', `${CP}console.log('node --test'); notSpawn('npm run test:client');`],
    ['a spawn imported from somewhere else', "import { execSync } from './my-exec.mjs';\nexecSync('npm run test:client');"],
    ['a comment', `${CP}// execSync('npm run test:client');\n/* spawnSync('node', ['--test']) */`],
  ]) it(`leaves alone: ${what}`, () => assert.deepEqual(sites(code), []));

  it('names the line and a way out in what it reports', () => {
    const [s] = sites(`${CP}\nexecSync('npm run test:client');`);
    assert.equal(s.line, 4);
    assert.match(s.command, /npm run test:client/);
  });
});

describe('every test process the runners and preflight start gets testChildEnv\'s environment', () => {
  const RUNNERS = 'scripts/preflight.mjs';

  /** The files that start test processes by design: preflight, and every runner under `testing/_init`. */
  const files = () => [RUNNERS, ...trackedSources('testing/_init', { ext: ['.mjs', '.js'], floor: 3 })];
  const allSites = () => files().flatMap((f) => testSpawnSites(f, readFileSync(join(REPO_ROOT, f), 'utf8')));

  it('derives the files and finds the spawns that are known to exist', () => {
    const fs = files();
    assert.ok(fs.includes('testing/_init/run-suite.mjs') && fs.includes('testing/_init/run-standalone.mjs'), 'a runner is not among the files read');
    const found = allSites();
    assert.ok(found.length >= 3, `only ${found.length} test spawn(s) found: the reader is broken (floor 3)`);
    assert.ok(found.some((s) => s.file === 'testing/_init/run-suite.mjs'), 'run-suite.mjs starts a test process and the reader did not see it');
    assert.ok(found.some((s) => s.file === RUNNERS), 'preflight starts test processes and the reader did not see them');
  });

  it('each one passes `env: testChildEnv(...)`', () => {
    const bare = allSites().filter((s) => !s.scrubbed).map((s) => `${s.file}:${s.line}  ${s.command}`);
    assert.deepEqual(bare, [], 'a test process that inherits the whole environment holds the recorder\'s token and the runner\'s wire; '
      + `give it \`env: testChildEnv(...)\` (testing/_shared/test-child-env.mjs), or make the wrapper do it for every call:\n  ${bare.join('\n  ')}`);
  });
});

/**
 * What a file says about the rule in its CODE: names the runner's wire variable, or retypes the recorder prefix.
 *
 * @param {string} source comment-stripped
 * @returns {string[]}
 */
function ruleCopies(source) {
  const found = [];
  if (/NODE_TEST_CONTEXT/.test(source)) found.push('names NODE_TEST_CONTEXT');
  if (/YTHRIL_TEST_RUNS_(?![A-Z])/.test(source)) found.push('retypes the recorder prefix YTHRIL_TEST_RUNS_');
  return found;
}

describe('the gate sees a copy of the rule and only a copy', () => {
  for (const text of [
    'delete env.NODE_TEST_CONTEXT;',
    "for (const k of ['NODE_TEST_CONTEXT', 'FORCE_COLOR']) delete env[k];",
    'const SCRUBBED = /^(CI|YTHRIL_TEST_RUNS_.*)$/;',
    "k.startsWith('YTHRIL_TEST_RUNS_')",
  ]) it(`flags: ${text}`, () => assert.equal(ruleCopies(text).length, 1));

  for (const text of [
    "const url = process.env.YTHRIL_TEST_RUNS_URL;",
    "if (!process.env.YTHRIL_TEST_RUNS_TOKEN) return;",
    '// NODE_TEST_CONTEXT is dropped by testChildEnv',
  ]) it(`leaves alone: ${text}`, () => assert.deepEqual(ruleCopies(stripComments(text)), []));
});

describe('no file keeps its own copy of the child-environment rule', () => {
  const files = trackedSources(['scripts', 'testing', 'server/src', 'benchmarks'], { ext: ['.mjs', '.js', '.cjs', '.ts'], floor: 500 })
    .filter((f) => f !== MODULE && f !== THIS);

  it('scans scripts and the test stacks', () => {
    assert.ok(files.some((f) => f.startsWith('scripts/')), 'no file under scripts/ was scanned');
    assert.ok(files.some((f) => f.startsWith('testing/standalone/')), 'no standalone file was scanned');
    assert.ok(files.some((f) => f.startsWith('testing/_shared/')), 'no shared module was scanned');
  });

  it('only test-child-env.mjs drops the runner wire or the recorder family', () => {
    const offenders = [];
    for (const file of files) {
      for (const what of ruleCopies(stripComments(readFileSync(join(REPO_ROOT, file), 'utf8')))) offenders.push(`${file}  ${what}`);
    }
    assert.deepEqual(offenders, [], `build the child's environment with testChildEnv() from ${MODULE}:\n${offenders.join('\n')}`);
  });
});
