/**
 * Preflight must not silently skip a test.
 *
 * ## What went wrong
 *
 * Preflight runs the standalone tests that need no live server, and it decided which those were by
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
 * its header. Everything else runs in preflight. Zero files were wrong in that direction when measured,
 * so the only failure mode a marker introduces is the loud one that was already handled.
 *
 * Run: node --test testing/standalone/preflight-coverage.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

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
    assert.match(script, /batched\(/, 'preflight must batch through the shared helper, not its own copy');
  });

  it('keeps running after a batch fails, so a later failure is not hidden', () => {
    // An all-or-nothing invocation reported the first failing batch and never ran the rest.
    assert.match(script, /standaloneFailed = true/);
  });

  it('would actually exceed the limit unbatched — the guard is not theoretical', () => {
    const oneLine = files.map(f => ` ${f}`).join('');
    assert.ok(oneLine.length * 4 > WINDOWS_LIMIT / 8,
      'the enumerated list is far from the limit; if that is genuinely true, this guard can go');
  });
});
