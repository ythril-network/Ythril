/**
 * One pass at a time, and every outbound call has a deadline.
 *
 * ## The findings (lens 7, Reliability & Resilience)
 *
 * 1. **Four scheduled sweeps had no reentrancy guard.** The duplicate scanner, the contradiction scanner,
 *    candidate pruning and the TTL sweep were each started with `schedule(cron, …)` or `setInterval(…)`, and a
 *    timer does not wait for its previous callback. A pass that outlives its interval simply overlaps the next
 *    one. The contradiction scanner calls an NLI model **per pair**, so that is routine on a large space
 *    against a slow judge, and two passes then double the model calls while both write the same collection.
 *
 * 2. **The duplicate scanner's notify POST had no timeout at all.** `ssrfSafeFetch` guards *where* a request
 *    may go, not how long it may take — it passes `init` straight through. So an operator-configured sink that
 *    accepted the connection and never answered hung that `await` **forever**, inside a scheduled sweep, and
 *    every later tick started another pass that hung in the same place. Unbounded accumulation of pending
 *    requests, no error line, and duplicate scanning silently stopped for that space.
 *
 * The two compound: the missing timeout is what made the missing guard unbounded rather than merely wasteful.
 *
 * Run: node --test testing/standalone/single-flight.test.js
 */
import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { balancedFrom } from './_structural-window.mjs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER_SRC = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', 'server', 'src');

let runExclusive, isRunning, runningForMs, _resetSingleFlightForTests;

describe('runExclusive', () => {
  before(async () => {
    ({ runExclusive, isRunning, runningForMs, _resetSingleFlightForTests } =
      await import('../../server/dist/util/single-flight.js'));
  });

  beforeEach(() => { _resetSingleFlightForTests(); });

  it('runs the first pass', async () => {
    let ran = false;
    assert.equal(await runExclusive('x', async () => { ran = true; }), true);
    assert.equal(ran, true);
  });

  it('SKIPS a second pass while the first is still running', async () => {
    // The whole point. A timer firing again mid-pass must not start a second one.
    let release;
    const gate = new Promise(r => { release = r; });
    let secondRan = false;

    const first = runExclusive('sweep', () => gate);
    const skipped = await runExclusive('sweep', async () => { secondRan = true; });

    assert.equal(skipped, false, 'the overlapping tick should have been skipped');
    assert.equal(secondRan, false, 'and its work must not have run');
    release();
    await first;
  });

  it('releases the label when the pass finishes, so the NEXT tick runs', async () => {
    await runExclusive('sweep', async () => {});
    assert.equal(isRunning('sweep'), false);
    assert.equal(await runExclusive('sweep', async () => {}), true);
  });

  it('releases the label when the pass THROWS — otherwise the sweep is off for the process lifetime', async () => {
    // The failure mode that makes a guard worse than none: one thrown error and the sweep never runs again.
    assert.equal(await runExclusive('sweep', async () => { throw new Error('boom'); }), true);
    assert.equal(isRunning('sweep'), false);
    assert.equal(await runExclusive('sweep', async () => {}), true);
  });

  it('never rejects — it is called from a timer, where an unhandled rejection can end the process', async () => {
    await assert.doesNotReject(runExclusive('sweep', async () => { throw new Error('boom'); }));
    await assert.doesNotReject(runExclusive('sweep', async () => { throw 'a string'; }));
  });

  it('keeps labels independent — one slow sweep must not block a different one', async () => {
    let release;
    const gate = new Promise(r => { release = r; });
    const slow = runExclusive('slow', () => gate);
    assert.equal(await runExclusive('other', async () => {}), true);
    release();
    await slow;
  });

  it('reports how long the in-flight pass has been running, for the skip message', async () => {
    // "Skipped, a pass is still running" is not actionable. "…running for 412s" says the sweep is slower than
    // its schedule and roughly by how much.
    let release;
    const gate = new Promise(r => { release = r; });
    const p = runExclusive('sweep', () => gate);
    const started = runningForMs('sweep');
    assert.ok(started !== null && started >= 0);
    assert.equal(runningForMs('nothing-running'), null);
    release();
    await p;
    assert.equal(runningForMs('sweep'), null);
  });
});

describe('every scheduled sweep is guarded', () => {
  // Enumerated from source: a fifth sweep added without the guard is the regression this catches, and it would
  // otherwise be invisible until two passes overlapped in production.
  const SWEEPS = [
    ['brain/dupe-scanner.ts', 'Dupe scan'],
    ['brain/contradiction-scanner.ts', 'Contradiction scan'],
    ['brain/candidate-prune.ts', 'Candidate prune'],
    ['brain/ttl-sweep.ts', 'TTL sweep'],
  ];

  for (const [file, label] of SWEEPS) {
    it(`${file} schedules through runExclusive`, () => {
      const src = readFileSync(join(SERVER_SRC, file), 'utf8');
      assert.match(src, new RegExp(`runExclusive\\('${label}'`), `${file} must guard its scheduled pass`);
      // And nothing schedules the bare call beside it.
      assert.doesNotMatch(src, /(?:schedule\(cron|setInterval)\([^)]*\)\s*=>\s*\{?\s*(?:void\s+)?\w+\(\)\.catch/,
        `${file} still schedules an unguarded pass`);
    });
  }
});

describe('outbound calls carry a deadline', () => {
  /**
   * `ssrfSafeFetch` does NOT add a timeout — it passes `init` through, so every caller must supply one. That is
   * easy to forget precisely because the name promises safety, and forgetting it produced an unbounded wait
   * inside a scheduled sweep.
   *
   * Wrappers that take an `init` from their own caller are exempt by name: they cannot know the deadline, and
   * their callers are checked instead.
   */
  const PASS_THROUGH_WRAPPERS = [
    'brain/embedding.ts',            // hands `init` to the transformers/OpenAI client
    'brain/nli-client.ts',           // builds `init` with its own AbortSignal.timeout, then branches
    'brain/rerank-client.ts',        // same shape as nli-client
    'files/converters/vlm-client.ts',
    'files/media/providers.ts',
    'auth/oidc.ts',                  // openid-client supplies the request options
    'api/media-config.ts',           // probe helper builds `init` above the call
    'sync/peer-fetch.ts',            // composes `{ ...init, signal }`
    'api/local-agent.ts',            // wrapper that injects AbortSignal.timeout itself
    'util/model-fetch.ts',           // passes its caller's `init` through; every caller builds it with a timeout
  ];

  it('every ssrfSafeFetch and modelFetch call site passes a signal, or is a named pass-through wrapper', () => {
    const offenders = [];
    const walk = (dir) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) { walk(p); continue; }
        if (!e.name.endsWith('.ts')) continue;
        const rel = p.slice(SERVER_SRC.length + 1).replace(/\\/g, '/');
        if (rel === 'util/ssrf.ts' || PASS_THROUGH_WRAPPERS.includes(rel)) continue;
        const src = readFileSync(p, 'utf8');
        /*
         * Each call site's OWN argument list, bounded by its closing paren.
         *
         * A WINDOW, converted, and this one was the dangerous polarity. The check is an ABSENCE — no `signal:` in
         * the arguments — so a call site the pattern failed to match was not reported as unguarded, it was not
         * examined at all. Both halves of the old pattern could fail to match a perfectly ordinary call: an
         * argument list longer than 700 characters, or one that does not end on the guessed
         * `\n  })` / `\n  );` shape. A single-line call with a long URL expression matched nothing and passed.
         */
        // `modelFetch` too (F-33): it is a pass-through wrapper, so ITS callers are where the deadline has to be.
        for (const m of src.matchAll(/\b(ssrfSafeFetch|modelFetch)\(/g)) {
          const argsList = balancedFrom(src, src.indexOf('(', m.index), `${rel}: the ${m[1]} arguments`);
          if (!/signal\s*:/.test(argsList)) {
            offenders.push(`${rel}: ${m[1]} with no signal`);
          }
        }
      }
    };
    walk(SERVER_SRC);
    assert.deepEqual(offenders, [], `outbound calls with no deadline:\n  ${offenders.join('\n  ')}\n\n`
      + '`ssrfSafeFetch` guards WHERE a request goes, not how long it may take. A sink that accepts the\n'
      + 'connection and never answers hangs the await forever — and inside a scheduled sweep that is silent.');
  });
});

// Imported late so the enumeration above reads clearly; Node hoists it regardless.
import { readdirSync } from 'node:fs';
