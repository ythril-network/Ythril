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
