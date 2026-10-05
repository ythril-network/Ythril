/**
 * The ONE helper that attaches the timing reporter to a `node --test` run builds flags that cannot kill the run,
 * change its console, or overwrite another run's file (bundle-56, Q-370 part 1; reliability S1, observability S11).
 *
 * ## What it prevents
 *
 * A measurement that costs the tests. Probed on Node 22 and 24 (scratchpad probe P1, vet-reliability R1/R2):
 *
 *  - **A missing destination directory ends the run with exit 7 before one test starts.** Node opens the
 *    `--test-reporter-destination` file itself, outside any `try` a reporter can hold, and `test-results/` is
 *    gitignored, so it does not exist on a fresh clone, a fresh CI runner or after `git clean`. The helper makes
 *    the directory FIRST, inside itself, so no caller can forget the line that looks like boilerplate.
 *  - **Adding a reporter silences the console.** `node --test --test-reporter=./ours.mjs` prints only what ours
 *    prints: the `# fail` / `# skipped` tail every log reader and flow check greps is gone. So the default reporter
 *    is named EXPLICITLY beside ours, and by the same rule on every Node version: tap when stdout is not a TTY
 *    (what CI's log is today), spec when it is (what a person's terminal shows today). The output with the
 *    reporter equals the output without it.
 *  - **A second invocation overwrites the first.** `run-standalone` and preflight are several `node --test`
 *    processes (pure files, database files, the instance batch); one file per suite keeps the last batch. A
 *    destination per invocation, suite and batch in its name, with both refused if they could leave the folder.
 *  - **A reporter failure becomes the tests' verdict.** An unwritable destination must leave the exit code and
 *    the console exactly as they were, and say so ONCE on stderr, naming the file and the error code.
 *  - **A runner that forgets it.** Every runner is found by what it CALLS (`offlineRuns(`, `batched(`) and by the
 *    `node --test` strings in `package.json` and the workflows, not by a list, and each must go through the
 *    helper. The flags stay OUTSIDE `offlineRuns`' plan, so preflight's 8 000-character batch budget and the
 *    `a-db-file-runs-in-a-capped-batch` gate stay about the files.
 *
 * ## The contract this gate pins
 *
 * `timingReporterFlags({ suite, batch, dir?, stdoutIsTTY? })` in `testing/_shared/timing-reporter-flags.mjs`
 * returns `{ args, env, destination }`: `args` go after `--test` and are whitespace-free `--flag=value` strings
 * (a runner may join them into a shell line); `env` is merged into the child's environment and carries what the
 * reporter needs to find its destination, suite and batch; `destination` is the absolute path of the file.
 * `dir` defaults to `<repo>/test-results`.
 *
 * Run: node --test testing/standalone/timing-reporter-flags.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, statSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { timingReporterFlags } from '../_shared/timing-reporter-flags.mjs';
import { readTimingLog } from '../_shared/timing-reporter.mjs';
import { splitStandalone, offlineRuns } from '../_shared/standalone-split.mjs';
import { stripComments } from './_strip-comments.mjs';
import {
  ROOT, fixture, runTimed, runPlain, runNodeTest, normaliseConsole, readJsonl,
} from './_timing-runs.mjs';

const PASS = fixture('timing-pass');
const SKIPS = fixture('timing-skips');
const HOOK = fixture('timing-hook-fail');
const LOAD = fixture('timing-load-throw');
const MESSAGES = fixture('timing-failure-messages');
const ALL_FIVE = [PASS, SKIPS, HOOK, LOAD, MESSAGES];
const SERIAL = ['--test-concurrency=1'];

let tmp;
before(() => { tmp = mkdtempSync(join(tmpdir(), 'timing-flags-')); });
after(() => { rmSync(tmp, { recursive: true, force: true }); });

/** The `--test-reporter` / `--test-reporter-destination` flags in order, as node pairs them by position. */
function pairs(args) {
  const reporters = args.filter(a => a.startsWith('--test-reporter=')).map(a => a.slice('--test-reporter='.length));
  const destinations = args.filter(a => a.startsWith('--test-reporter-destination=')).map(a => a.slice('--test-reporter-destination='.length));
  return { reporters, destinations };
}

describe('timingReporterFlags: the flags', () => {
  it('returns args, env and a destination, with args safe to join into a shell line', () => {
    const f = timingReporterFlags({ suite: 'shape', batch: 1, dir: join(tmp, 'shape'), stdoutIsTTY: false });
    assert.ok(Array.isArray(f.args) && f.args.length >= 4);
    for (const a of f.args) assert.match(a, /^--\S+$/, `an argument that a shell line would split or a node flag parser would not take: ${a}`);
    assert.ok(f.env && Object.values(f.env).every(v => typeof v === 'string'), 'env values must be strings');
    assert.equal(typeof f.destination, 'string');
  });

  it('names the default reporter explicitly beside ours: tap off a TTY, spec on one, in node\'s pairing order', () => {
    for (const [tty, expected] of [[false, 'tap'], [true, 'spec']]) {
      const { args } = timingReporterFlags({ suite: 'flavour', batch: 1, dir: join(tmp, 'flavour'), stdoutIsTTY: tty });
      const { reporters, destinations } = pairs(args);
      assert.equal(reporters.length, destinations.length,
        'node refuses a run whose reporters and destinations differ in number (ERR_INVALID_ARG_VALUE)');
      assert.equal(reporters.length, 2);
      assert.equal(reporters[0], expected, `tty=${tty}`);
      assert.equal(destinations[0], 'stdout', 'the console reporter must keep the console');
      assert.match(reporters[1], /timing-reporter\.mjs$/, 'the second reporter is the timing reporter');
      assert.equal(destinations[1], 'stdout', 'ours writes its own file and gives the stream nothing');
    }
  });

  it('with no stdoutIsTTY it follows this process\'s stdout, which is what node itself keys on', () => {
    const asked = timingReporterFlags({ suite: 'flavour', batch: 2, dir: join(tmp, 'flavour') });
    const explicit = timingReporterFlags({ suite: 'flavour', batch: 2, dir: join(tmp, 'flavour'), stdoutIsTTY: Boolean(process.stdout.isTTY) });
    assert.deepEqual(asked.args, explicit.args);
  });

  it('puts the file in `dir` (default <repo>/test-results), named for the suite and batch', () => {
    const dir = join(tmp, 'named');
    const f = timingReporterFlags({ suite: 'standalone', batch: 'pure-3', dir, stdoutIsTTY: false });
    assert.equal(dirname(f.destination), resolve(dir));
    assert.equal(basename(f.destination), 'standalone-pure-3.jsonl');
    const d = timingReporterFlags({ suite: 'standalone', batch: 1, stdoutIsTTY: false });
    assert.equal(dirname(d.destination), resolve(ROOT, 'test-results'));
  });

  it('refuses a suite or batch that could leave the folder, or is not a name', () => {
    const dir = join(tmp, 'refuse');
    for (const bad of ['', '..', '../escape', 'a/b', 'a\\b', 'with space', undefined, null]) {
      assert.throws(() => timingReporterFlags({ suite: bad, batch: 1, dir, stdoutIsTTY: false }), `suite ${JSON.stringify(bad)}`);
      assert.throws(() => timingReporterFlags({ suite: 'ok', batch: bad, dir, stdoutIsTTY: false }), `batch ${JSON.stringify(bad)}`);
    }
    for (const good of ['standalone', 'integration-1', 'db', 'pure-1', 3]) {
      assert.doesNotThrow(() => timingReporterFlags({ suite: good, batch: good, dir, stdoutIsTTY: false }), String(good));
    }
  });

  it('gives each invocation its own destination', () => {
    const dir = join(tmp, 'distinct');
    const seen = new Map();
    for (const suite of ['standalone', 'integration']) for (const batch of [1, 2, 'db']) {
      const d = timingReporterFlags({ suite, batch, dir, stdoutIsTTY: false }).destination;
      assert.ok(!seen.has(d), `${suite}/${batch} and ${seen.get(d)} share ${d}`);
      seen.set(d, `${suite}/${batch}`);
    }
    assert.equal(seen.size, 6);
  });
});

describe('timingReporterFlags: the directory', () => {
  it('creates the destination directory, nested, before anything runs', () => {
    const dir = join(tmp, 'a', 'b', 'c');
    assert.ok(!existsSync(dir));
    timingReporterFlags({ suite: 'mk', batch: 1, dir, stdoutIsTTY: false });
    assert.ok(statSync(dir).isDirectory(), 'the helper must create it: node opens the destination itself and exits 7 on a missing directory');
    assert.doesNotThrow(() => timingReporterFlags({ suite: 'mk', batch: 2, dir, stdoutIsTTY: false }), 'an existing directory is fine');
  });

  it('premise: without it node exits 7 before any test runs', () => {
    const r = runNodeTest(['--test-reporter=tap', `--test-reporter-destination=${join(tmp, 'never-made', 'out.txt')}`, PASS]);
    assert.equal(r.status, 7, 'node no longer dies on a missing destination directory — the helper\'s reason is gone, say so');
  });

  it('a run into a directory that did not exist runs the tests and writes the file', () => {
    const dir = join(tmp, 'fresh', 'clone', 'test-results');
    const r = runTimed([PASS, SKIPS], { dir, suite: 'fresh', batch: 1 });
    assert.equal(r.status, 0, `exit ${r.status}: ${r.stderr.slice(0, 300)}`);
    assert.match(r.stdout, /# pass \d+/, 'the console must still report');
    const log = readTimingLog(readFileSync(r.destination, 'utf8'));
    assert.equal(log.complete, true);
    assert.ok(log.lines.length >= 10);
  });

  it('is ignored by git, so a run never dirties the tree', () => {
    execFileSync('git', ['check-ignore', '-q', 'test-results/standalone-1.jsonl'], { cwd: ROOT });
  });
});

describe('the console with the reporter equals the console without it', () => {
  for (const tty of [false, true]) {
    it(`${tty ? 'spec (a TTY)' : 'tap (not a TTY)'}: stdout, stderr and exit status over passes, skips, a hook failure, a load failure, failures`, () => {
      const plain = runPlain(ALL_FIVE, { tty, extraArgs: SERIAL });
      const timed = runTimed(ALL_FIVE, { dir: join(tmp, `console-${tty}`), suite: 'console', batch: 1, tty, extraArgs: SERIAL });
      assert.equal(plain.status, 1, 'the premise: this set fails');
      assert.ok(plain.stdout.length > 500, 'the premise: node printed a report to compare');
      assert.equal(timed.status, plain.status);
      assert.equal(normaliseConsole(timed.stdout), normaliseConsole(plain.stdout));
      assert.equal(normaliseConsole(timed.stderr), normaliseConsole(plain.stderr));
    });
  }

  it('the two flavours really differ, and are the ones named', () => {
    const tap = runTimed([PASS], { dir: join(tmp, 'flavours'), suite: 'flavours', batch: 'tap', tty: false });
    const spec = runTimed([PASS], { dir: join(tmp, 'flavours'), suite: 'flavours', batch: 'spec', tty: true });
    assert.match(tap.stdout, /^TAP version 13$/m);
    assert.doesNotMatch(spec.stdout, /^TAP version 13$/m);
    assert.match(spec.stdout, /✔ passes at once/);
  });

  it('works from another working directory: the reporter reference is not relative to cwd', () => {
    const r = runTimed([resolve(ROOT, PASS)], { dir: join(tmp, 'elsewhere'), suite: 'elsewhere', batch: 1, cwd: tmpdir() });
    assert.equal(r.status, 0, r.stderr.slice(0, 300));
    const lines = readJsonl(r.destination).filter(l => l.type !== 'end');
    assert.ok(lines.length >= 4);
    for (const l of lines) assert.equal(l.file, PASS, 'file is relative to the repo, not to wherever the run started');
  });
});

describe('a reporter that cannot write leaves the tests\' exit code and output intact, and says so once', () => {
  /** A destination node's own stream would have died on: the directory is a regular file, or the file is a directory. */
  const broken = {
    'the directory is a regular file': () => {
      const file = join(tmp, 'a-file');
      writeFileSync(file, 'not a directory');
      return join(file, 'sub');
    },
    'the destination is itself a directory': () => {
      const dir = join(tmp, 'is-a-dir');
      mkdirSync(join(dir, 'broken-1.jsonl'), { recursive: true });
      return dir;
    },
  };

  for (const [what, make] of Object.entries(broken)) {
    for (const [label, files, status] of [['passing files', [PASS, SKIPS], 0], ['failing files', [HOOK, PASS], 1]]) {
      it(`${what}, over ${label}`, () => {
        const dir = make();
        const plain = runPlain(files, { extraArgs: SERIAL });
        assert.equal(plain.status, status, 'the premise');
        const r = runTimed(files, { dir, suite: 'broken', batch: 1, extraArgs: SERIAL });
        assert.equal(r.status, status, `the tests' exit status must not become the reporter's (${r.stderr.slice(0, 300)})`);
        assert.equal(normaliseConsole(r.stdout), normaliseConsole(plain.stdout));
        const extra = r.stderr.split('\n').filter(l => l.trim() && !plain.stderr.split('\n').includes(l));
        assert.equal(extra.length, 1, `exactly one warning line expected, got ${extra.length}: ${extra.join(' | ')}`);
        assert.ok(extra[0].includes(basename(r.destination)), `the warning must name the file: ${extra[0]}`);
        assert.match(extra[0], /\bE[A-Z]{3,}\b/, `the warning must carry the error code: ${extra[0]}`);
      });
    }
  }
});

describe('two invocations do not overwrite each other', () => {
  it('each keeps its own lines and its own sentinel', () => {
    const dir = join(tmp, 'two');
    const one = runTimed([PASS], { dir, suite: 'two', batch: 1 });
    const two = runTimed([SKIPS], { dir, suite: 'two', batch: 2 });
    assert.notEqual(one.destination, two.destination);
    for (const [r, file, other] of [[one, PASS, SKIPS], [two, SKIPS, PASS]]) {
      const log = readTimingLog(readFileSync(r.destination, 'utf8'));
      assert.equal(log.complete, true);
      assert.ok(log.lines.length >= 4);
      assert.ok(log.lines.every(l => l.file === file), `a line of ${other} in the file of ${file}`);
    }
  });
});

describe('every runner attaches the reporter through the helper', () => {
  const tracked = (...paths) => execFileSync('git', ['ls-files', ...paths], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean);

  it('a file that runs suite batches (`offlineRuns(` or `batched(`) builds its flags with timingReporterFlags', () => {
    const runners = tracked('scripts', 'testing/_init').filter(f => f.endsWith('.mjs'))
      .filter(f => /\b(offlineRuns|batched)\(/.test(stripComments(readFileSync(resolve(ROOT, f), 'utf8'))));
    assert.ok(runners.length >= 2, `only ${runners.length} runner(s) found — preflight and run-standalone both run batches`);
    for (const f of runners) {
      const src = stripComments(readFileSync(resolve(ROOT, f), 'utf8'));
      assert.ok(/from\s+['"][^'"]*timing-reporter-flags\.mjs['"]/.test(src), `${f} runs batches and does not import the helper`);
      assert.ok(/\btimingReporterFlags\(/.test(src), `${f} imports the helper and never calls it`);
    }
  });

  it('no package.json script and no workflow step runs `node --test` itself — a bare one has no way to call the helper', () => {
    const scripts = Object.entries(JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')).scripts);
    assert.ok(scripts.length >= 10, 'the scripts are not being read');
    const bare = scripts.filter(([, cmd]) => /\bnode\s+(--\S+\s+)*--test\b/.test(cmd)).map(([name]) => name);
    assert.deepEqual(bare, [], 'these scripts run node --test directly: delegate them to a runner that builds its flags with the helper');
    const workflows = tracked('.github/workflows').filter(f => /\.ya?ml$/.test(f));
    assert.ok(workflows.length >= 1);
    for (const f of workflows) {
      assert.ok(!/\bnode\s+(--\S+\s+)*--test\b/.test(readFileSync(resolve(ROOT, f), 'utf8')), `${f} runs node --test itself`);
    }
  });

  it('the flags stay outside the batch plan: `offlineRuns` carries no reporter flags, so its budget and cap are about the files', () => {
    const runs = offlineRuns(splitStandalone());
    assert.ok(runs.length >= 2);
    for (const r of runs) assert.ok(!r.args.some(a => a.startsWith('--test-reporter')), `a ${r.kind} run's args carry ${r.args}`);
  });
});
