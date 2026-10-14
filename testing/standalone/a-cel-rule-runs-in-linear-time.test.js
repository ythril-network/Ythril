/**
 * A rule's regex runs on a LINEAR engine, and the time a rule takes grows with its input, not with its input's shape (F-46).
 *
 * ## Why this is the test that matters most
 *
 * A rule is text written by an operator, replicated to every member of a network, and evaluated on every write — including
 * writes that arrive from a peer. `@bufbuild/cel` was chosen over the native-regex CEL libraries for exactly one reason: its
 * `matches()` runs on RE2, which cannot backtrack. `(a+)+$` on thirty `a`s and a `!` takes a backtracking engine seconds, and
 * on five thousand it takes longer than the age of anything; here it must take milliseconds. Save-time refusal of "risky"
 * patterns (`hasReDoSRisk`) is the heuristic this replaces — and the reason `matches('(a+)+$')` is ACCEPTED at save
 * (see `a-cel-rule-is-checked-when-the-schema-is-saved`).
 *
 * ## How it is held, and why not by a stopwatch
 *
 * 1. **The engine is linear.** `(a+)+$` over 5 000 `a`s and a `!` is run in a CHILD PROCESS with a kill deadline. A backtracking
 *    engine does not answer slowly, it does not answer — synchronously, so an in-process test would hang the runner. In the
 *    child it is a failure with a name: the child was killed, so the engine in use is not linear.
 * 2. **The time is proportional.** The time for an input of N and for 2N, after a warm-up, as the median of several samples each:
 *    the RATIO is asserted, never a figure in milliseconds (a wall-clock ceiling is a test that fails on a busy runner and passes
 *    on a quiet one, and says nothing about the shape). Linear is 2, quadratic is 4, exponential is not a number; the bound is 3.
 *    The best of three attempts is taken, so one noisy sample is not a verdict.
 * 3. **A rule at the caps finishes.** One comprehension over the largest list the caps admit (100 strings of 10 000 characters),
 *    a regex on each: a generous ceiling, the question being "does it finish", not "how fast".
 *
 * Run: node --test testing/standalone/a-cel-rule-runs-in-linear-time.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CHILD = fileURLToPath(new URL('./_cel-timing-child.mjs', import.meta.url));

/** Run the child on a spec; a kill at the deadline is a result, not an exception. */
function inChild(spec, deadlineMs) {
  const r = spawnSync(process.execPath, [CHILD, JSON.stringify(spec)], { encoding: 'utf8', timeout: deadlineMs, killSignal: 'SIGKILL' });
  if (r.error?.code === 'ETIMEDOUT' || r.signal === 'SIGKILL') return { killed: true, deadlineMs };
  if (r.status !== 0) return { failed: true, stderr: `${r.stderr}`.slice(-1500) };
  return { result: JSON.parse(r.stdout.trim().split('\n').pop()) };
}

describe('the regex engine behind `matches` is linear', () => {
  it('(a+)+$ on 5 000 `a`s and a `!` is answered, in a child, within its deadline', { timeout: 60_000 }, () => {
    const out = inChild({ mode: 'once', pattern: '(a+)+$', length: 5000 }, 20_000);
    assert.ok(!out.killed,
      `the evaluation did not finish in ${out.deadlineMs} ms: the regex engine backtracks, so one stored rule can stop a write path for ever`);
    assert.ok(!out.failed, `the child failed for another reason: ${out.stderr}`);
    assert.ok(out.result.ms < 5_000, `answered, but in ${out.result.ms} ms for 5 000 characters: that is not a linear engine's speed`);
  });

  it('the other shapes that make a backtracking engine exponential are answered too', { timeout: 120_000 }, () => {
    for (const pattern of ['(a|aa)+$', '(a*)*b', '^(a+)+$']) {
      const out = inChild({ mode: 'once', pattern, length: 4000 }, 20_000);
      assert.ok(!out.killed, `${pattern} did not finish: the regex engine backtracks`);
      assert.ok(!out.failed, `${pattern}: ${out.stderr}`);
    }
  });
});

describe('what a rule costs grows with its input, not with its input\'s shape', () => {
  it('twice the input takes about twice the time (ratio under 3), after a warm-up', { timeout: 180_000 }, () => {
    const ratios = [];
    for (let attempt = 0; attempt < 3; attempt++) {
      const out = inChild({ mode: 'ratio', pattern: '(a|aa)+$', n: 2000 }, 50_000);
      assert.ok(!out.killed, 'the ratio measurement did not finish: the regex engine backtracks');
      assert.ok(!out.failed, out.stderr);
      ratios.push(out.result.ratio);
      if (out.result.ratio < 3) break;
    }
    assert.ok(Math.min(...ratios) < 3,
      `the time for 2N was ${ratios.map(r => r.toFixed(2)).join(', ')} times the time for N in every attempt: that is not linear (linear is 2, quadratic 4)`);
  });
});

describe('a rule at the caps finishes', () => {
  it('a comprehension over 100 strings of 10 000 characters, a regex on each, is answered within a generous ceiling', { timeout: 120_000 }, () => {
    const out = inChild({ mode: 'tags', tags: 100, length: 10_000 }, 60_000);
    assert.ok(!out.killed, 'one rule on one record at the input caps did not finish in a minute');
    assert.ok(!out.failed, out.stderr);
    assert.ok(out.result.ms < 20_000, `one rule on one max-size record took ${out.result.ms} ms`);
  });
});
