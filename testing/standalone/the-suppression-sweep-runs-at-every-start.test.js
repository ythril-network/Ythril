/**
 * The suppression sweep runs at EVERY configured start — a fresh install's first configuration included (bundle-30
 * I8, a promise the pre-ship testing lens found unpinned; `pitfall-first-run-skips-the-boot-path`).
 *
 * Vectors a suppression already covers (stored before the sweep reached files, or before a network's layer said so)
 * are cleared only by this sweep, once per start. Placed in the `!isFirstRun` branch of `index.ts`, a freshly set-up
 * instance would never run it; placed under a condition inside the bootstrap, some starts would skip it.
 *
 * So: both places that make an instance configured — the boot of a configured instance and the setup route — call
 * the one bootstrap function; that function hands the sweep to `afterListening` unconditionally (a statement at the
 * top level of its body); and the callback it hands over starts the sweep unconditionally (a statement at the top
 * level of the callback's block).
 *
 * Re-anchored by bundle-30 I13 (pre-ship testing F2): I8.7 moved the call into the `afterListening` callback, and this
 * gate kept passing because its pattern rejected only a LEADING `if` on the line — `afterListening(() => { if (cond)
 * void sweepEverySpaceAtBoot(); })` matched it. Both levels are now read by structure.
 *
 * Run: node --test testing/standalone/the-suppression-sweep-runs-at-every-start.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripComments } from './_strip-comments.mjs';
import { bodyOf, blockAfter } from './_structural-window.mjs';

const src = (f) => stripComments(readFileSync(f, 'utf8'));
const BOOT_FN = 'startConfiguredInstanceServices';
const SWEEP = 'sweepEverySpaceAtBoot';

/**
 * Whether the statement holding `at` sits at the top level of `block` (the text between its braces) with nothing
 * conditional before it in that statement: no enclosing bracket, and only `void` / `await` ahead of the call.
 */
function unconditionalAt(block, at) {
  let depth = 0;
  let start = 0;
  for (let i = 0; i < at; i++) {
    const c = block[i];
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
    if (depth === 0 && (c === ';' || c === '}' || c === '\n')) start = i + 1;
  }
  return depth === 0 && /^\s*(?:void\s+|await\s+)?$/.test(block.slice(start, at));
}

describe('the suppression sweep runs at every start', () => {
  it('both doors to a configured instance run the one bootstrap function', () => {
    for (const f of ['server/src/index.ts', 'server/src/setup/routes.ts']) {
      assert.match(src(f), new RegExp(`await ${BOOT_FN}\\(\\)`), `${f} no longer runs ${BOOT_FN} — a start that skips the sweep`);
    }
  });

  it('the bootstrap hands the sweep to afterListening unconditionally, and the callback starts it unconditionally', () => {
    const body = bodyOf(src('server/src/bootstrap.ts'), BOOT_FN);
    const inner = body.slice(body.indexOf('{') + 1, body.lastIndexOf('}'));
    const mentions = [...inner.matchAll(new RegExp(`\\b${SWEEP}\\b`, 'g'))].map(m => m.index)
      .filter(i => !/import\(/.test(inner.slice(inner.lastIndexOf('\n', i), i)) && !/const \{[^}]*$/.test(inner.slice(inner.lastIndexOf('\n', i), i)));
    assert.equal(mentions.length, 1, `${BOOT_FN} starts the boot sweep ${mentions.length} time(s) — expected exactly one call`);

    // Level 1: the afterListening call holding it is a top-level statement of the bootstrap body.
    const handOff = inner.lastIndexOf('afterListening(', mentions[0]);
    assert.ok(handOff > -1, `the boot sweep is not handed to afterListening — it would compete with the boot (bundle-30 I8)`);
    assert.ok(unconditionalAt(inner, handOff),
      `the afterListening hand-off is under a condition or inside another block: ${inner.slice(handOff, handOff + 80)}`);

    // Level 2: the callback has a block body, and the sweep is a top-level statement of it.
    const call = inner.slice(handOff);
    assert.match(call, /^afterListening\(\s*(?:async\s*)?\(\)\s*=>\s*\{/,
      'the afterListening callback has no block body — an expression body can make the sweep conditional (`cond && …`)');
    const block = blockAfter(call, 0, 'the afterListening callback');
    const blockInner = block.slice(1, -1);
    const sweepAt = blockInner.search(new RegExp(`\\b${SWEEP}\\(`));
    assert.ok(sweepAt > -1, 'the afterListening callback does not start the sweep');
    assert.ok(unconditionalAt(blockInner, sweepAt),
      `the boot sweep is started under a condition inside the afterListening callback: ${blockInner.trim().slice(0, 120)}`);
  });
});
