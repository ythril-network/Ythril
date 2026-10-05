/**
 * The rows `scripts/_shared/script-cli.mjs`, `repo-path.mjs`, `timing-results.mjs` and the harness's `wholeJsonl` answer,
 * including every place the bundle-56 dedup chose between two copies that DIFFERED (`check-i-no-second-copy-written`).
 *
 * ## Where the copies differed, and what was chosen
 *
 * - **A flag with no value.** `unrun-tests --root` alone meant "the working directory" (`resolve('')`), `executed-tests
 *   --root` alone meant "the script's own repository", `--results` alone was refused. One reading is right: a flag
 *   without its value is a usage error (exit 2), because a path the caller did not give is a path the check was not
 *   pointed at.
 * - **`./` in a path.** One copy stripped a leading `./`, one did not. `./a.test.js` and `a.test.js` are one file, and a
 *   file counted under both spellings is a file "executed" under one and "unexecuted" under the other; the leading `./`
 *   goes, everywhere.
 * - **Which line is the results file's `end`.** `test-times.mjs` read the last line if it was a sentinel; the reporter's
 *   own reader (`readTimingLog`) reads the one sentinel a whole file has. They differ only for a file that is already
 *   incomplete (two sentinels, one not last), whose scope is now `subset` and never the figures of whichever sentinel
 *   happened to come last. A baseline is drawn from `full` and `passed` only, so the stricter reading can never admit a run.
 * - **What a test file is.** One copy counted `.test.js` under `testing/` and `.spec.ts` under `client/src/`, another
 *   every `.test|spec.{js,mjs,cjs,ts}`. Today the sets are equal; the broad one is chosen, because a file that CI selects
 *   and the body gates never read is a file those gates cannot vouch for.
 *
 * Run: node --test testing/standalone/script-cli-and-repo-path-rows.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { REPO_ROOT } from './_sources.mjs';
import { readFlags } from '../../scripts/_shared/script-cli.mjs';
import { repoRelative, slashPath } from '../../scripts/_shared/repo-path.mjs';
import { timingResultFiles } from '../../scripts/_shared/timing-results.mjs';
import { seconds } from '../../scripts/_shared/run-summary.mjs';
import { readTimingLog } from '../_shared/timing-reporter.mjs';
import { timingLine, wholeJsonl } from '../_shared/test-times-harness.mjs';
import { testChildEnv } from '../_shared/test-child-env.mjs';

const CLI = pathToFileURL(join(REPO_ROOT, 'scripts', '_shared', 'script-cli.mjs')).href;

/** Run node with `args`, without the parent test runner's context (a nested run would be misread as part of this one). */
function node(args, { cwd = REPO_ROOT } = {}) {
  const r = spawnSync(process.execPath, args, { cwd, env: testChildEnv(), encoding: 'utf8', timeout: 60_000 });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

describe('readFlags', () => {
  const flags = ['--root', '--results'];
  const rows = [
    ['both flags, each with a value', ['--root', 'a', '--results', 'b'], { '--root': 'a', '--results': 'b' }, []],
    ['one flag, the other absent', ['--results', 'b'], { '--root': undefined, '--results': 'b' }, []],
    ['no arguments', [], { '--root': undefined, '--results': undefined }, []],
    ['a flag with no value at the end', ['--results'], { '--root': undefined, '--results': undefined }, ['--results']],
    ['a flag whose next token is another flag', ['--results', '--root', 'a'], { '--root': 'a', '--results': undefined }, ['--results']],
    ['an unknown flag', ['--results', 'b', '--nope'], { '--root': undefined, '--results': 'b' }, ['--nope']],
    ['a stray positional', ['x', '--results', 'b'], { '--root': undefined, '--results': 'b' }, ['x']],
    ['a flag given twice (the repeat and its value are both stray)', ['--results', 'a', '--results', 'b'], { '--root': undefined, '--results': 'a' }, ['--results', 'b']],
  ];
  for (const [name, argv, values, stray] of rows) {
    it(name, () => assert.deepEqual(readFlags(argv, flags), { values, stray }));
  }
});

describe('isEntryPoint', () => {
  let dir;
  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'ythril-entry-'));
    writeFileSync(join(dir, 'who.mjs'),
      `import { isEntryPoint } from ${JSON.stringify(CLI)};\nexport const answer = isEntryPoint(import.meta.url);\nif (answer) console.log('ran');\n`);
    writeFileSync(join(dir, 'importer.mjs'), "import { answer } from './who.mjs';\nconsole.log(`imported:${answer}`);\n");
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  it('true for the module the process was started with', () => {
    assert.match(node([join(dir, 'who.mjs')]).out, /^ran/);
  });

  it('false for the same module imported by another', () => {
    const { out } = node([join(dir, 'importer.mjs')]);
    assert.match(out, /imported:false/);
    assert.doesNotMatch(out, /\bran\b/);
  });

  it('false, and no throw, when there is no script path at all (node -e)', () => {
    const { status, out } = node(['--input-type=module', '-e',
      `import { isEntryPoint } from ${JSON.stringify(CLI)}; console.log('answer:' + isEntryPoint(${JSON.stringify(CLI)}));`]);
    assert.equal(status, 0, out);
    assert.match(out, /answer:false/);
  });
});

describe('slashPath and repoRelative', () => {
  const root = resolve(REPO_ROOT);
  it('slashPath: separators and a leading ./', () => {
    assert.equal(slashPath('a\\b\\c.test.js'), 'a/b/c.test.js');
    assert.equal(slashPath('./a/b.test.js'), 'a/b.test.js');
    assert.equal(slashPath('.\\a\\b.test.js'), 'a/b.test.js');
    assert.equal(slashPath(undefined), '');
    assert.equal(slashPath(null), '');
  });

  it('repoRelative: a relative path is returned in the one spelling', () => {
    assert.equal(repoRelative('./testing/x.test.js', root), 'testing/x.test.js');
    assert.equal(repoRelative('testing\\x.test.js', root), 'testing/x.test.js');
  });

  it('repoRelative: an absolute path inside the root is relativised', () => {
    assert.equal(repoRelative(join(root, 'client', 'src', 'a.spec.ts'), root), 'client/src/a.spec.ts');
  });

  it('repoRelative: an absolute path OUTSIDE the root is null, never a ../ path and never a guess', () => {
    assert.equal(repoRelative(resolve(root, '..', 'elsewhere', 'x.test.js'), root), null);
    assert.equal(repoRelative(root, root), null);
  });

  it('repoRelative: a name that merely starts with two dots is inside, not outside', () => {
    assert.equal(repoRelative(join(root, '..hidden', 'x.test.js'), root), '..hidden/x.test.js');
  });

  it('repoRelative: a drive path from another platform is outside whatever the platform reading it', () => {
    if (process.platform !== 'win32') assert.equal(repoRelative('C:\\Users\\someone\\x.test.js', root), null);
  });
});

describe('seconds', () => {
  it('one spelling: one decimal and a unit', () => {
    assert.equal(seconds(12_345), '12.3 s');
    assert.equal(seconds(0), '0.0 s');
    assert.equal(seconds(59_950), '60.0 s');
  });
});

describe('timingResultFiles and wholeJsonl', () => {
  let dir;
  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'ythril-results-rows-'));
    mkdirSync(join(dir, 'unrelated'));
    writeFileSync(join(dir, 'b-2.jsonl'), 'second\n');
    writeFileSync(join(dir, 'a-1.jsonl'), 'first\n');
    writeFileSync(join(dir, 'client.json'), '{}');
    writeFileSync(join(dir, 'notes.txt'), 'not a result');
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  it('lists only the *.jsonl, sorted by name, each read', () => {
    assert.deepEqual(timingResultFiles(dir).map(f => [f.name, f.text, f.path]),
      [['a-1.jsonl', 'first\n', join(dir, 'a-1.jsonl')], ['b-2.jsonl', 'second\n', join(dir, 'b-2.jsonl')]]);
  });

  it('a folder that is not there is an empty list, not a throw (the refusing reader says why)', () => {
    assert.deepEqual(timingResultFiles(join(dir, 'never-made')), []);
  });

  it('wholeJsonl closes a file the way the reporter does: complete, one sentinel, the count right', () => {
    const lines = [timingLine({ file: 'a.test.js', test: 'a' }), timingLine({ file: 'a.test.js', test: 'b' })];
    const log = readTimingLog(wholeJsonl(lines));
    assert.equal(log.complete, true);
    assert.equal(log.lines.length, 2);
    assert.equal(log.end.events, 2);
    assert.equal(log.end.scope, 'full');
  });

  for (const [sentinel, why] of [['missing', 'no sentinel'], ['miscount', 'a count that disagrees']]) {
    it(`wholeJsonl with ${why} is INCOMPLETE`, () => {
      assert.equal(readTimingLog(wholeJsonl([timingLine({ file: 'a.test.js' })], { sentinel })).complete, false);
    });
  }

  it('wholeJsonl truncated is a torn last line, INCOMPLETE', () => {
    assert.equal(readTimingLog(wholeJsonl([timingLine({ file: 'a.test.js' })], { truncated: true })).complete, false);
  });

  it('an empty run is just the sentinel (no blank line a reader would call a torn one)', () => {
    const log = readTimingLog(wholeJsonl([]));
    assert.equal(log.complete, true);
    assert.equal(log.lines.length, 0);
  });
});

describe('where two copies differed: the recorder', () => {
  let times;
  before(async () => { times = await import(pathToFileURL(join(REPO_ROOT, 'scripts', 'test-times.mjs')).href); });
  const root = resolve(REPO_ROOT);
  const filesOf = (texts) => JSON.parse(times.summariseSuite({ texts, root }).measurements).files.map(f => f.file);
  const fileLine = (file) => timingLine({ type: 'file', file, test: file, ms: 5 });

  it('a leading ./ is not part of a file\'s name', () => {
    assert.deepEqual(filesOf([wholeJsonl([fileLine('./testing/standalone/a.test.js')])]), ['testing/standalone/a.test.js']);
  });

  it('an absolute path inside the repository is stored relative to it', () => {
    assert.deepEqual(filesOf([wholeJsonl([fileLine(join(root, 'testing', 'standalone', 'a.test.js'))])]), ['testing/standalone/a.test.js']);
  });

  it('a path outside the repository is never stored as a ../ path', () => {
    const [stored] = filesOf([wholeJsonl([fileLine(resolve(root, '..', 'outside', 'a.test.js'))])]);
    assert.ok(!stored.startsWith('..'), stored);
  });

  it('a file with TWO sentinels is incomplete and its scope is `subset`, whichever sentinel came last', () => {
    const lines = [fileLine('testing/a.test.js')];
    const doubled = wholeJsonl(lines, { scope: 'full' }) + wholeJsonl([], { scope: 'full' });
    const summary = times.summariseSuite({ texts: [doubled], root });
    assert.equal(summary.outcome, 'incomplete');
    assert.equal(summary.scope, 'subset');
  });

  it('a whole file keeps its sentinel\'s scope and times', () => {
    const summary = times.summariseSuite({ texts: [wholeJsonl([fileLine('testing/a.test.js')], { scope: 'full' })], root });
    assert.equal(summary.outcome, 'passed');
    assert.equal(summary.scope, 'full');
    assert.equal(summary.startedAt, '2026-10-05T10:00:00.000Z');
  });
});

describe('where two copies differed: a flag with no value is a usage error on every script', () => {
  const cases = [
    ['unrun-tests --root', ['scripts/unrun-tests.mjs', '--root']],
    ['executed-tests --results', ['scripts/executed-tests.mjs', '--results']],
    ['executed-tests --root beside --results', ['scripts/executed-tests.mjs', '--results', 'somewhere', '--root']],
    ['unexpected-skips --results', ['scripts/unexpected-skips.mjs', '--results']],
    ['an unknown flag', ['scripts/unrun-tests.mjs', '--nope']],
  ];
  for (const [name, args] of cases) {
    it(`${name}: exit 2 with the usage line`, () => {
      const { status, out } = node(args);
      assert.equal(status, 2, out);
      assert.match(out, /usage: node scripts\//);
    });
  }
});
