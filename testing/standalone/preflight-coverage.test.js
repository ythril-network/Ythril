/**
 * Preflight must not silently skip a test it says it runs. (Since Q-588 it runs no database test file at all, and says how many
 * it leaves to CI's Full run; this file is about the split between files that need a live server and the rest.)
 *
 * ## What went wrong
 *
 * Preflight ran the standalone tests that need no live server (today: the pure ones; the database files are CI's), and it decided which those were by
 * CONTENT MATCH: `fetch(|127.0.0.1|localhost:|INSTANCES|BASE_URL`. That guarded one direction — a test
 * that really does hit the network without a marker fails loudly with ECONNREFUSED — and completely
 * missed the other: a **pure** test that merely *mentions* one of those strings was excluded and never
 * ran locally at all.
 *
 * Measured by running every standalone file alone with nothing listening: **22 of 158 were pure and
 * being skipped**, among them `ssrf-hardening`, `ssrf-ip-pinning`, `peer-ssrf-policy`,
 * `oidc-issuer-ssrf`, `log-redaction`, `secrets-permissions` and `config-permissions`. "Preflight
 * PASSED" was not running the SSRF suites.
 *
 * It cost two red CI runs. #559 failed on an assertion in `private-model-endpoints.test.js`, excluded
 * for containing `127.0.0.1` as test *data* — a blocked address. #562 failed on one in
 * `vlm-endpoint-egress.test.js`, excluded for containing the word `fetch(` inside its own failure
 * messages. Both were pure. Both passed a green preflight minutes before CI rejected them.
 *
 * ## The rule now
 *
 * The split is **declared**, not inferred: a test that drives a live server says `@needs-instance` in
 * its header. Everything else is offline: the pure files run in preflight and the database-backed ones in CI. Zero files were wrong in that direction when measured,
 * so the only failure mode a marker introduces is the loud one that was already handled.
 *
 * Run: node --test testing/standalone/preflight-coverage.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { stripComments } from './_strip-comments.mjs';
import { argumentsOf } from './_structural-window.mjs';

const PREFLIGHT = readFileSync('scripts/preflight.mjs', 'utf8');
/*
 * The MARKER moved out of preflight into the module preflight and `test:standalone` now share.
 *
 * Two runners ask which files need an instance, and a second copy of the answer is two places for them
 * to disagree about which gates exist. This gate follows the DECLARATION rather than the file it used to
 * sit in — staying pinned to the old location would have left it green about a rule that had moved.
 */
const SPLIT = readFileSync('testing/_shared/standalone-split.mjs', 'utf8');

const NUL = String.fromCharCode(0);
const files = execFileSync('git', ['ls-files', '-z', 'testing/standalone'], { encoding: 'utf8' })
  .split(NUL).filter(f => f.endsWith('.test.js')).sort();

/**
 * "Declares the marker" is decided by PREFLIGHT'S OWN pattern, lifted out of the script.
 *
 * This was `.includes('@needs-instance')` — a bare substring, where preflight anchors to a header line.
 * Two spellings of one rule, so they could disagree, and they did: a pure test whose doc comment *mentioned*
 * the marker while explaining which suite carries it was "marked" here and correctly "unmarked" there. The
 * gate policing the split failed while the split itself was right, which is the worst way for a gate to be
 * wrong — it accuses the innocent file and teaches you to reword prose to appease it.
 *
 * Deriving the regex from `scripts/preflight.mjs` means the answer cannot drift again. If the declaration
 * ever stops being parseable, that is a hard failure below rather than a silent fallback to a looser rule.
 */
const NEEDS_INSTANCE = (() => {
  const m = SPLIT.match(/export const NEEDS_INSTANCE = \/(.+?)\/([gimsuy]*);/);
  return m ? new RegExp(m[1], m[2]) : null;
})();

const marked = files.filter(f => NEEDS_INSTANCE?.test(readFileSync(f, 'utf8')));

describe('the exclusion is declared, not guessed', () => {
  it('this gate reads preflight\'s own marker pattern, not a second copy of it', () => {
    // Everything below counts "marked" files with it. If the declaration stops being parseable, that has
    // to fail here rather than quietly leave `marked` empty and pass every assertion vacuously.
    assert.ok(NEEDS_INSTANCE, 'could not lift NEEDS_INSTANCE out of testing/_shared/standalone-split.mjs — re-anchor this gate');
    assert.ok(NEEDS_INSTANCE.test(' * @needs-instance drives a live server\n'), 'the lifted pattern must match a real header');
    assert.ok(!NEEDS_INSTANCE.test(' * see the integration suite (`@needs-instance`) for those\n'),
      'a doc comment MENTIONING the marker is not a file declaring it');
  });

  it('preflight selects on the marker', () => {
    // Asserts the SELECTOR, not its exact spelling — the pattern is anchored to a header line
    // (` * @needs-instance …`) and that detail is free to change.
    assert.match(SPLIT, /export const NEEDS_INSTANCE = \/[^\n]*@needs-instance/);
  });

  it('the marker match is anchored, so a file that merely mentions it is not excluded', () => {
    // An unanchored match excluded THIS file, which necessarily names the marker in its assertions —
    // the same "matched test data, not behaviour" mistake the old heuristic made, one level up.
    assert.match(SPLIT, /export const NEEDS_INSTANCE = \/\^/, 'the pattern must be line-anchored');
  });

  it('and NOT on a content heuristic', () => {
    // The exact shape that skipped 22 pure files. Matching test data is not evidence about behaviour.
    assert.doesNotMatch(
      SPLIT,
      /NEEDS_INSTANCE = \/[^/]*(fetch\\\(|127\\\.0\\\.0\\\.1|localhost:|BASE_URL)/,
      'inferring from file contents excludes pure tests that merely mention a URL or the word fetch',
    );
  });

  it('the skipped count is printed, so an exclusion is visible in the run', () => {
    assert.match(PREFLIGHT, /declare @needs-instance and run in CI/);
  });
});

describe('the marker is used honestly', () => {
  it('every marked file really does look like it drives a server', () => {
    // A marker added by reflex is an exclusion nobody notices. If a file claims to need an instance, it
    // should show some sign of reaching one.
    const suspicious = marked.filter(f => {
      const src = readFileSync(f, 'utf8');
      return !/BASE_URL|INSTANCES|127\.0\.0\.1|localhost:\d|:3200/.test(src);
    });
    assert.deepEqual(suspicious, [], `these declare @needs-instance but show no sign of using one:\n  ${suspicious.join('\n  ')}`);
  });

  it('the marked set stays a small minority', () => {
    // Measured at 16 of 158. A jump means either a burst of integration tests, or markers being used to
    // silence a failure — the second is the one worth catching, and it will show up here first.
    assert.ok(marked.length <= 30, `${marked.length} files declare @needs-instance; that was 16 when measured`);
    assert.ok(marked.length / files.length < 0.25, 'more than a quarter of standalone tests need a server?');
  });

  it('the marker carries an explanation, not just a token', () => {
    for (const f of marked) {
      const line = readFileSync(f, 'utf8').split('\n').find(l => l.includes('@needs-instance'));
      assert.ok(line.length > 30, `${f}: bare marker with no reason — say what it drives`);
    }
  });

  it('the scan actually reads the tree', () => {
    assert.ok(files.length > 100, `expected the standalone suite, got ${files.length}`);
    assert.ok(marked.length > 0, 'no file declares the marker — the split would be meaningless');
  });
});

/**
 * The offline subset is invoked in batches, because the whole list does not fit on a Windows command line.
 *
 * `The command line is too long.` is printed by cmd, not by node — so when the enumerated list crossed
 * 32 767 characters the gate went RED with no test output and nothing named. One added test file was all it
 * took, and the next person to add one would have hit the same wall with the same unhelpful message.
 *
 * This is a source check because the thing being asserted is how a child process is spawned, and the failure
 * it prevents is a gate that reports nothing at all.
 */
describe('preflight invokes the offline subset within the platform limit', () => {
  const script = readFileSync('scripts/preflight.mjs', 'utf8');
  const WINDOWS_LIMIT = 32_767;

  it('batches, and by measured length rather than a file count', () => {
    /*
     * The batching moved into the shared split with the marker, for the same reason: `test:standalone`
     * builds the same command lines and a second copy is a second place to drift back over the Windows
     * cap. This gate asserts the RULE where it now lives, and that preflight still uses it.
     */
    assert.match(SPLIT, /budget = 8_000/, 'the batch budget is gone — the full list will not fit on Windows');
    assert.match(SPLIT, /len \+ p\.length \+ 1 > budget/,
      'batching by a fixed file count drifts back over the limit as names grow');
    // Re-anchored (bundle-30 I9): preflight no longer calls `batched` itself. It runs `offlineRuns`, the shared plan
    // that batches inside it and caps the database-backed files — the same plan `test:standalone` runs.
    assert.match(SPLIT, /export function offlineRuns\([^]*?batched\(split\.offlinePure[^]*?batched\(split\.offlineDb/,
      'the shared plan must batch both halves through `batched`');
    assert.match(script, /offlineRuns\(/, 'preflight must run the shared plan, not its own copy');
    assert.doesNotMatch(script, /batched\(/, 'preflight builds its own command lines again — a second copy of the plan');
  });

  it('keeps running after a batch fails, so a later failure is not hidden: the units run through runTestUnits and the stage fails once, after every unit ended', () => {
    // An all-or-nothing invocation reported the first failing batch and never ran the rest. The unit runner never rejects (a failing
    // unit, a spawn error and a kill at the bound each resolve to a failed unit; its own gate holds that), so the rule here is how
    // preflight READS it: the result of the call, awaited, decides one failure of the stage.
    const code = stripComments(script);
    assert.match(code, /\bawait\s+runTestUnits\(/, 'preflight does not run its pure units through `await runTestUnits(...)`');
    assert.match(code, /import\s*\{[^}]*\brunTestUnits\b[^}]*\}\s*from\s*['"][^'"]*_shared\/run-test-units\.mjs['"]/,
      'preflight does not import runTestUnits from testing/_shared/run-test-units.mjs');
    const decided = code.match(/if\s*\(([^)]*)\)\s*\{\s*failures\.push\(\{\s*name:\s*['"`]test:standalone \(offline subset\)['"`]/);
    assert.ok(decided, 'the stage does not push its one failure from an `if` over the unit runner\'s result');
    assert.match(decided[1], /\bfailed\b/, 'the stage failure is not decided by the unit runner\'s `failed` count');
    assert.doesNotMatch(code, /standaloneFailed = true/, 'a per-batch failure flag set in a catch is the synchronous shape this replaced');
  });

  it('every batch\'s WHOLE command line, the timing reporter\'s flags included, fits the launcher it goes through', async () => {
    /*
     * The batch budget measures the FILES; the reporter's flags (a file URL, two destinations) ride after them.
     * Through a shell, cmd.exe refuses a line over 8 191 characters with "The command line is too long" and no test
     * output — which is what bundle-56's first preflight printed for six batches. Launched without a shell, the
     * limit is CreateProcess's 32 767. So: measure the real line, against the limit of the real launcher.
     */
    const { offlineRuns, splitStandalone } = await import('../_shared/standalone-split.mjs');
    const { timingReporterFlags } = await import('../_shared/timing-reporter-flags.mjs');
    const runs = offlineRuns(splitStandalone());
    assert.ok(runs.length >= 2, `the offline plan has ${runs.length} batch(es); expected the pure and db halves`);
    // As preflight calls it, but into a folder of its own: the default is the checkout's results folder, which a test must not create.
    const { scratchRoot } = await import('../../scripts/_shared/scratch-root.mjs');
    const { mkdtempSync, mkdirSync } = await import('node:fs');
    const { join } = await import('node:path');
    mkdirSync(scratchRoot(), { recursive: true });
    const flags = timingReporterFlags({ suite: 'preflight', batch: 'pure-99', scope: 'subset', dir: mkdtempSync(join(scratchRoot(), 'flags-')) });
    const { boundedTestArgs } = await import('../_shared/test-file-bound.mjs');
    // What a unit really carries: the bound, the concurrency flag, the plan's own args, the reporter's flags, then the files.
    const longest = Math.max(...runs.map(r => ['node', ...boundedTestArgs('--test-concurrency=3', ...r.args, ...flags.args, ...r.files)].join(' ').length));
    assert.ok(longest < WINDOWS_LIMIT, `the longest unit is ${longest} characters, over the ${WINDOWS_LIMIT} CreateProcess allows`);

    const code = stripComments(script);
    // The pure units go through the unit runner, which starts them as an argument array (its own case below). Preflight itself starts no
    // batch: not through a shell line (cmd.exe's 8 191-character cap), and not by hand with `--test` (no pool, no time bound, no held output).
    assert.match(code, /\bawait\s+runTestUnits\(/, 'preflight does not start its pure units through runTestUnits');
    assert.doesNotMatch(code, /run\(`node --test \$\{\[\.\.\.r\.args/, 'preflight launches a batch through a shell line: cmd.exe caps it at 8 191 characters');
    assert.doesNotMatch(code, /(?:execFileSync|execSync|spawnSync|spawn)\([^)]*['"`]--test['"`]/,
      'preflight starts a node --test batch by hand again: no pool, no time bound, no held output');
    // What the units carry: the timing reporter's flags and environment per unit (a destination per unit, labelled by its place in the list).
    assert.match(code, /\btimingReporterFlags\(/, 'preflight does not attach the timing reporter to its units');
    assert.match(code, /\bflags\.args\b/, 'the reporter\'s flags (flags.args) do not reach the units\' command line');
    assert.match(code, /\bflags\.env\b/, 'the reporter\'s environment (flags.env) does not reach the units');
  });

  it('the units preflight really runs, slow files alone first, are each a command line under the limit, and are the pure files exactly once', async () => {
    /*
     * The plan the preflight hands the pool is no longer `offlineRuns`' batches: `slowFirstUnits` takes the files the recorded times put at
     * 15 s or more out into units of their own. The gates above read the real plan WITHOUT times, so a broken packed plan would pass them
     * all; this one builds the units over a fixture that covers every pure file, names two as slow and carries a key for a `@ci-only`
     * file (which the preflight leaves out, so the key must add nothing), and asserts the same rules over them: every pure file in
     * exactly one unit, none empty, the `@ci-only` file nowhere, and every unit's whole command line, the single-worker flag a
     * slow unit carries included, under CreateProcess's limit.
     */
    const { offlineRuns, splitStandalone } = await import('../_shared/standalone-split.mjs');
    const { slowFirstUnits } = await import('../../scripts/_shared/slow-first-units.mjs');
    const { timingReporterFlags } = await import('../_shared/timing-reporter-flags.mjs');
    const { boundedTestArgs } = await import('../_shared/test-file-bound.mjs');
    const { scratchRoot } = await import('../../scripts/_shared/scratch-root.mjs');
    const { mkdtempSync, mkdirSync } = await import('node:fs');
    const { join } = await import('node:path');
    const split = splitStandalone();
    const pure = offlineRuns(split, { ciOnly: false }).filter(r => r.kind === 'pure');
    const planned = pure.flatMap(r => r.files);
    assert.ok(planned.length > 500, `only ${planned.length} pure file(s) in the preflight plan: the fixture would cover nothing`);
    const ciOnlyKey = `testing/standalone/${split.ciOnly[0]}`;
    assert.ok(split.ciOnly.length > 0 && !planned.includes(ciOnlyKey), 'the preflight plan holds a @ci-only file, or the split names none to put in the fixture');
    const slowTwo = [planned[7], planned[planned.length - 3]];
    const fixture = { files: Object.fromEntries([...planned.map((f, i) => [f, 40 + (i % 90)]), [slowTwo[0], 70_000], [slowTwo[1], 31_000], [ciOnlyKey, 250_000]]) };
    const units = slowFirstUnits(pure, fixture, { maxSlow: 8 });
    assert.deepEqual(units.slice(0, 2).map(u => u.files), [[slowTwo[0]], [slowTwo[1]]], 'the two slow files are not the first two units, slowest first');
    assert.equal(units.filter(u => u.slow).length, 2);
    assert.deepEqual(units.flatMap(u => u.files).sort(), [...planned].sort(), 'the units are not the pure files exactly once each');
    assert.ok(units.every(u => u.files.length > 0), 'a unit holds no file');
    assert.ok(!units.some(u => u.files.includes(ciOnlyKey)), 'a @ci-only file entered the plan through a key in the times');
    mkdirSync(scratchRoot(), { recursive: true });
    const flags = timingReporterFlags({ suite: 'preflight', batch: 'pure-99', scope: 'subset', dir: mkdtempSync(join(scratchRoot(), 'flags-')) });
    const longest = Math.max(...units.map(u => ['node', ...boundedTestArgs('--test-concurrency=1', ...u.args, ...flags.args, ...u.files)].join(' ').length));
    assert.ok(longest < WINDOWS_LIMIT, `the longest unit is ${longest} characters, over the ${WINDOWS_LIMIT} CreateProcess allows`);
  });

  it('preflight reads the file times through readFileTimes, hands the pure runs and the times to slowFirstUnits with at most 2 x its unit width alone, and runs a slow unit with one worker', () => {
    const code = stripComments(script);
    assert.match(code, /import\s*\{[^}]*\bslowFirstUnits\b[^}]*\}\s*from\s*['"][^'"]*_shared\/slow-first-units\.mjs['"]/, 'preflight does not import slowFirstUnits from scripts/_shared/slow-first-units.mjs');
    assert.match(code, /\breadFileTimes\(\s*RESULTS_DIR\s*\)/, 'preflight does not read the file times through readFileTimes from the results folder (RESULTS_DIR, built from timingResultsDir(process.cwd()))');
    assert.match(code, /\bslowFirstUnits\([^;]*\bmaxSlow\s*:\s*2\s*\*\s*UNIT_WIDTH\b/, 'preflight does not pass maxSlow: 2 * UNIT_WIDTH to slowFirstUnits');
    assert.match(code, /\.slow\b/, 'preflight never looks at which unit is a slow one: it cannot run it with one worker');
    assert.match(code, /--test-concurrency=\$\{[^}]*\b1\b[^}]*\}/, 'a slow unit is not given --test-concurrency=1');
    assert.doesNotMatch(code, /\bbatched\(/, 'preflight cuts units by path length itself again');
  });

  it('the unit runner starts each unit as `node` with an argument array, the time bound, and the environment testChildEnv builds', () => {
    // The rule the preflight's old `execFileSync('node', ['--test', ...], { env: testChildEnv(flags.env) })` kept, over the module that now holds it:
    // a caller cannot drop it because it is not the caller's.
    const unitsSource = stripComments(readFileSync('testing/_shared/run-test-units.mjs', 'utf8'));
    assert.match(unitsSource, /\bspawn\(\s*'node',\s*boundedTestArgs\(/, 'the unit runner does not start `node` with boundedTestArgs and an argument array');
    assert.match(unitsSource, /\benv\s*:\s*testChildEnv\(/, 'the unit runner does not give each child testChildEnv(...): the recorder\'s token and the runner\'s context would reach it');
    assert.doesNotMatch(unitsSource, /\bshell\s*:\s*true|\bexec(?:Sync)?\(/, 'the unit runner starts a unit through a shell');
    assert.doesNotMatch(unitsSource, /process\.env\b/, 'the unit runner builds a child environment from process.env itself: that is testChildEnv\'s question');
  });

  it('would actually exceed the limit unbatched — the guard is not theoretical', () => {
    const oneLine = files.map(f => ` ${f}`).join('');
    assert.ok(oneLine.length * 4 > WINDOWS_LIMIT / 8,
      'the enumerated list is far from the limit; if that is genuinely true, this guard can go');
  });
});

/**
 * Preflight asks the question CI's aggregator asks about reach: is every tracked test file selected by a CI job?
 *
 * `scripts/unrun-tests.mjs` is the static half of Q-283 (`executed-tests.mjs`, the run half, needs a run's results and
 * is the aggregator's). The static half needs nothing a developer's machine lacks, and a test file added under a
 * directory no job selects is found in a second here, or by a reader of a CI log after the push. So preflight runs it
 * and a non-zero exit is a failure of its own, named - not folded into another gate's.
 *
 * Read from the script's CODE (comments stripped): the comment that explains this gate also names the script.
 */
describe('preflight runs the CI-reach check', () => {
  const code = stripComments(readFileSync('scripts/preflight.mjs', 'utf8'));

  it('runs scripts/unrun-tests.mjs, and a non-zero exit becomes a named failure rather than a swallowed one', () => {
    // One statement, matched by structure (not a character window, which a CRLF checkout shifts): the run, then a catch
    // whose body records the failure under the script's own name.
    assert.match(code, /try\s*\{\s*run\(\s*['"`]node scripts\/unrun-tests\.mjs['"`]\s*\);?\s*\}\s*catch\s*\{\s*failures\.push\(\{\s*name:\s*['"`]unrun-tests['"`]/,
      'preflight does not run scripts/unrun-tests.mjs into its failures list');
  });
});

/**
 * A preflight writes, clears and reads its timing results in the checkout it runs in, through ONE results folder (Q-872).
 *
 * CI run 44155982511 could not be recorded: a preflight run planted by a test (cwd a scratch checkout) wrote its
 * `preflight-pure-1.jsonl` into the REAL repository's `test-results/`, because `clearTimingResults` and `timingReporterFlags` fell back to
 * the folder of the repository that holds the script while the reads took `timingResultsDir(process.cwd())`. The planted run also cleared the
 * real repository's `preflight-*` files. The one folder is built once from `timingResultsDir(process.cwd())`; every clearing and every
 * reporter flag names it as `dir`, so a call that leaves `dir` out (and takes the script's own repository) is found here.
 *
 * Read from the script's CODE (comments stripped); each call's arguments are bounded by its own brackets.
 */
describe('preflight passes one results folder, the current checkout\'s, to every timing writer', () => {
  const code = stripComments(readFileSync('scripts/preflight.mjs', 'utf8'));
  const declared = [...code.matchAll(/\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*timingResultsDir\(\s*process\.cwd\(\)\s*\)\s*;/g)].map(m => m[1]);
  const callsOf = (name) => [...code.matchAll(new RegExp(`\\b${name}\\(`, 'g'))].map(m => argumentsOf(code, m.index + name.length));

  it('builds the folder once, from timingResultsDir(process.cwd())', () => {
    assert.equal(declared.length, 1, `preflight declares ${declared.length} constants from timingResultsDir(process.cwd()); the one results folder is built once`);
  });

  it('names that folder as dir in every clearTimingResults and every timingReporterFlags call, and has such calls', () => {
    const [folder] = declared;
    assert.ok(folder, 'no results-folder constant to compare the calls with');
    const named = new RegExp(`\\bdir\\s*:\\s*${folder}\\b`);
    const clears = callsOf('clearTimingResults');
    const flags = callsOf('timingReporterFlags');
    assert.ok(clears.length >= 1 && flags.length >= 1, `preflight has ${clears.length} clearTimingResults and ${flags.length} timingReporterFlags calls`);
    for (const args of clears) assert.match(args[1] ?? '', named, `clearTimingResults(${args.join(', ')}) does not pass dir: ${folder}, so it clears the script repository's folder`);
    for (const args of flags) assert.match(args[0] ?? '', named, `timingReporterFlags(${args.join(', ')}) does not pass dir: ${folder}, so its results go to the script repository's folder`);
  });
});
