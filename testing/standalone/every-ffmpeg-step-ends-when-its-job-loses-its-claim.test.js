/**
 * Every ffmpeg step a media job runs is handed the job's claim signal, so a run that lost its claim ends the step it is
 * in rather than waiting out the step's bound (bundle-89 pre-ship pass, reliability lens).
 *
 * ## What it prevents
 *
 * `runFfmpeg` (`files/media/transcode.ts`) takes a `signal` and kills the process when it aborts, and its docblock says a
 * caller that can lose its claim passes one. None did: every call ran on the ten-minute step bound alone. So a job that
 * stall recovery had already handed to another run kept a second ffmpeg going over the same file for up to ten minutes —
 * the duplicate run the claim exists to stop, with a worker slot held for it. `shouldStop` is polled BETWEEN steps; only
 * the signal reaches INTO one.
 *
 * ## The rule, derived rather than listed
 *
 * Every `runFfmpeg(` call in `server/src` outside its own module passes `signal`. The calls are found in the tracked
 * sources with comments stripped, each call bounded by its own parentheses (never a character window), with a floor so
 * an empty find cannot pass.
 *
 * Run: node --test testing/standalone/every-ffmpeg-step-ends-when-its-job-loses-its-claim.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { trackedSources } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';

const OWN_MODULE = 'server/src/files/media/transcode.ts';

/** The text of each `runFfmpeg(...)` call in `src`, from the name to its matching close paren. */
function callsIn(src) {
  const out = [];
  const re = /\brunFfmpeg\s*\(/g;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    let depth = 0;
    let i = m.index + m[0].length - 1;
    for (; i < src.length; i++) {
      if (src[i] === '(') depth++;
      else if (src[i] === ')' && --depth === 0) break;
    }
    out.push(src.slice(m.index, i + 1));
  }
  return out;
}

describe('every ffmpeg step ends when its job loses its claim', () => {
  const calls = trackedSources('server/src')
    .filter(f => f !== OWN_MODULE)
    .flatMap(f => callsIn(stripComments(readFileSync(f, 'utf8'))).map(text => ({ f, text })));

  it('finds the calls it is about (floor)', () => {
    assert.ok(calls.length >= 5, `only ${calls.length} runFfmpeg calls found outside ${OWN_MODULE} — re-anchor the search`);
  });

  it('the worker hands its claim to every media route: each options object naming a route\'s `steps` carries `signal`', () => {
    // A signal parameter nobody fills is the defect this file is about, one level up: the calls above would pass
    // `opts?.signal` faithfully and it would always be undefined.
    const worker = stripComments(readFileSync('server/src/files/media/worker.ts', 'utf8'));
    const routes = [...worker.matchAll(/\{[^{}]*\bsteps:\s*\w+_STEPS[^{}]*\}/g)].map(m => m[0]);
    assert.ok(routes.length >= 2, `only ${routes.length} media route option objects found in worker.ts — re-anchor`);
    const unsignalled = routes.filter(r => !/\bsignal:/.test(r));
    assert.deepEqual(unsignalled, [], 'a media route runs without the claim signal, so its ffmpeg steps outlive a lost claim');
  });

  it('each call passes a signal', () => {
    const bare = calls.filter(c => !/\bsignal\b/.test(c.text)).map(c => `${c.f}: ${c.text.replace(/\s+/g, ' ').slice(0, 90)}`);
    assert.deepEqual(bare, [], `${bare.length} ffmpeg step(s) run on the time bound alone — a lost claim cannot end them`);
  });
});
