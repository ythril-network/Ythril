/**
 * The start-up suppression sweep runs at EVERY configured start, starts once the server is LISTENING, and is a promise
 * that settles when every space has been swept, one space at a time (Q-230; Q-361 item 11; ported from main's
 * `the-suppression-sweep-runs-at-every-start` and `the-boot-sweep-waits-for-the-server-and-runs-one-space-at-a-time`).
 *
 * ## The placement rules
 *
 * Vectors a suppression already covers (stored before the sweep reached files, or before a network's layer said so) are
 * cleared at start, once, by this sweep. Placed in the `!isFirstRun` branch of `index.ts`, a freshly set-up instance
 * would never run it; placed under a condition inside the bootstrap, some starts would skip it. So both places that make
 * an instance configured — the boot of a configured instance and the setup route — call the one bootstrap function; that
 * function hands the sweep to `afterListening` unconditionally (a statement at the top level of its body); and the
 * callback it hands over starts the sweep unconditionally (a statement at the top level of the callback's block) and
 * AWAITS it, so a failure of the sweep is a rejection `afterListening` logs rather than one that escapes it. Both
 * levels are read by structure, not by a leading `if` on the line.
 *
 * `afterListening` (`util/after-listening.ts`) is the one place "once the server listens" is answered: it holds work
 * until `markListening`, and runs work handed to it afterwards at once, so the setup route (which runs after the server
 * listens) is not held. The listen callback marks it. The sweep itself is `sweepEverySpaceAtBoot`
 * (`brain/suppression-sweep.ts`; main's name), a promise of its own completion that awaits each space before the next.
 *
 * The behaviour (every space, one at a time, in pages) is `the-start-up-sweep-clears-the-vectors-of-every-space-db`.
 *
 * Seen red on 6eb5a333 (5.6.3): there is no after-listening module, no boot sweep, and the bootstrap starts none. The
 * first test is a pin (both doors already run the one bootstrap function) and stays green.
 *
 * Run: node --test testing/standalone/the-start-up-sweep-runs-after-the-server-listens.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { stripComments } from './_strip-comments.mjs';
import { bodyOf, blockAfter } from './_structural-window.mjs';

const src = (f) => stripComments(readFileSync(f, 'utf8'));
const BOOT_FN = 'startConfiguredInstanceServices';
const SWEEP = 'sweepEverySpaceAtBoot';
const MODULE = 'server/dist/util/after-listening.js';

/** What may stand ahead of a call that is not conditional: nothing, or `void` / `await`. */
const UNCONDITIONAL_LEAD = /^\s*(?:void\s+|await\s+)?$/;
/** What may stand ahead of a call whose outcome the enclosing function hands on: `await` or `return`. */
const AWAITED_LEAD = /^\s*(?:await|return)\s+$/;

/**
 * Whether the statement holding `at` sits at the top level of `block` (the text between its braces) with only `lead`
 * ahead of the call in that statement: no enclosing bracket, nothing conditional.
 */
function leadsWith(block, at, lead) {
  let depth = 0;
  let start = 0;
  for (let i = 0; i < at; i++) {
    const c = block[i];
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
    if (depth === 0 && (c === ';' || c === '}' || c === '\n')) start = i + 1;
  }
  return depth === 0 && lead.test(block.slice(start, at));
}
const unconditionalAt = (block, at) => leadsWith(block, at, UNCONDITIONAL_LEAD);

describe('the start-up suppression sweep runs at every start', () => {
  it('PIN both doors to a configured instance run the one bootstrap function', () => {
    for (const f of ['server/src/index.ts', 'server/src/setup/routes.ts']) {
      assert.match(src(f), new RegExp(`await ${BOOT_FN}\\(\\)`), `${f} no longer runs ${BOOT_FN} — a start that skips the sweep`);
    }
  });

  it('the bootstrap hands the sweep to afterListening unconditionally, and the callback starts it unconditionally and awaits it', () => {
    const body = bodyOf(src('server/src/bootstrap.ts'), BOOT_FN);
    const inner = body.slice(body.indexOf('{') + 1, body.lastIndexOf('}'));
    const mentions = [...inner.matchAll(new RegExp(`\\b${SWEEP}\\b`, 'g'))].map(m => m.index)
      .filter(i => !/import\(/.test(inner.slice(inner.lastIndexOf('\n', i), i)) && !/const \{[^}]*$/.test(inner.slice(inner.lastIndexOf('\n', i), i)));
    assert.equal(mentions.length, 1, `${BOOT_FN} starts the boot sweep ${mentions.length} time(s) — expected exactly one call`);

    // Level 1: the afterListening call holding it is a top-level statement of the bootstrap body.
    const handOff = inner.lastIndexOf('afterListening(', mentions[0]);
    assert.ok(handOff > -1, 'the boot sweep is not handed to afterListening — it would compete with the boot');
    assert.ok(unconditionalAt(inner, handOff),
      `the afterListening hand-off is under a condition or inside another block: ${inner.slice(handOff).split('\n')[0]}`);

    // Level 2: the callback has a block body, and the sweep is a top-level statement of it.
    const call = inner.slice(handOff);
    assert.match(call, /^afterListening\(\s*(?:async\s*)?\(\)\s*=>\s*\{/,
      'the afterListening callback has no block body — an expression body can make the sweep conditional (`cond && …`)');
    const block = blockAfter(call, 0, 'the afterListening callback');
    const blockInner = block.slice(1, -1);
    const sweepAt = blockInner.search(new RegExp(`\\b${SWEEP}\\(`));
    assert.ok(sweepAt > -1, 'the afterListening callback does not start the sweep');
    assert.ok(unconditionalAt(blockInner, sweepAt),
      `the boot sweep is started under a condition inside the afterListening callback: ${blockInner.trim().split('\n')[0]}`);
    // The callback hands its outcome to afterListening, which logs a rejection: a sweep started with `void` (or not
    // awaited at all) leaves a failure to surface as an unhandled rejection, which ends the process.
    assert.ok(leadsWith(blockInner, sweepAt, AWAITED_LEAD),
      `the afterListening callback does not await the sweep — its failure would escape afterListening's handler: ${blockInner.slice(sweepAt).split('\n')[0]}`);
  });
});

describe('the boot sweep waits for the server and runs one space at a time', () => {
  it('afterListening holds work until the server listens, and runs it at once afterwards', async () => {
    assert.ok(existsSync(MODULE), 'there is no one place that answers "once the server listens"');
    const { afterListening, markListening } = await import(`../../${MODULE}`);
    const ran = [];
    afterListening(() => ran.push('early'));
    await new Promise(r => setImmediate(r));
    assert.deepEqual(ran, [], 'work ran before the server was listening');
    markListening();
    assert.deepEqual(ran, ['early'], 'work held for the listen did not run when it came');
    afterListening(() => ran.push('late'));
    assert.deepEqual(ran, ['early', 'late'], 'work handed over after the listen was held');
  });

  it('the listen callback marks the server listening', () => {
    const index = src('server/src/index.ts');
    const at = index.indexOf('server.listen(');
    assert.ok(at > 0, 'index.ts no longer calls server.listen — re-anchor this gate');
    assert.match(index.slice(at, index.indexOf('});', at)), /markListening\(\)/, 'the listen callback does not mark the server listening');
  });

  it('the sweep settles once every space is swept, one space at a time', () => {
    const body = bodyOf(src('server/src/brain/suppression-sweep.ts'), SWEEP);
    assert.match(body, /async function sweepEverySpaceAtBoot\([^)]*\):\s*Promise<void>/, 'the boot sweep is not a promise of its own completion');
    // A search that finds nothing is -1, and `slice(-1)` would hand back the last character: say so instead.
    const walk = body.search(/for \(const \w+ of concreteSpaces\(\)\)/);
    assert.ok(walk > -1, 'the boot sweep no longer walks concreteSpaces() — re-anchor this gate');
    const inner = blockAfter(body, walk, 'the per-space walk').slice(1, -1);
    const sweepsOne = inner.search(/\b[A-Za-z_]\w*\(/);
    assert.ok(sweepsOne > -1, 'the per-space walk no longer calls anything to sweep a space — re-anchor this gate');
    assert.ok(leadsWith(inner, sweepsOne, /^\s*await\s+$/),
      'the boot sweep starts a space\'s sweep without waiting for it, so the spaces run together');
  });
});