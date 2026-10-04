/**
 * The suppression sweep runs at EVERY configured start — a fresh install's first configuration included (bundle-30
 * I8, a promise the pre-ship testing lens found unpinned; `pitfall-first-run-skips-the-boot-path`).
 *
 * Vectors a suppression already covers (stored before the sweep reached files, or before a network's layer said so)
 * are cleared only by this sweep, once per start. Placed in the `!isFirstRun` branch of `index.ts`, a freshly set-up
 * instance would never run it; placed under a condition inside the bootstrap, some starts would skip it.
 *
 * So: both places that make an instance configured — the boot of a configured instance and the setup route — call
 * the one bootstrap function, and that function calls the sweep unconditionally (at the top level of its body).
 *
 * Run: node --test testing/standalone/the-suppression-sweep-runs-at-every-start.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripComments } from './_strip-comments.mjs';
import { bodyOf } from './_structural-window.mjs';

const src = (f) => stripComments(readFileSync(f, 'utf8'));
const BOOT_FN = 'startConfiguredInstanceServices';

describe('the suppression sweep runs at every start', () => {
  it('both doors to a configured instance run the one bootstrap function', () => {
    for (const f of ['server/src/index.ts', 'server/src/setup/routes.ts']) {
      assert.match(src(f), new RegExp(`await ${BOOT_FN}\\(\\)`), `${f} no longer runs ${BOOT_FN} — a start that skips the sweep`);
    }
  });

  it('the bootstrap function starts the sweep unconditionally', () => {
    const body = bodyOf(src('server/src/bootstrap.ts'), BOOT_FN);
    const calls = body.split(/\r?\n/).filter(l => /sweepEverySpaceAtBoot\b/.test(l) && !/\bimport\(/.test(l));
    assert.equal(calls.length, 1, `${BOOT_FN} calls the boot sweep ${calls.length} time(s) — expected exactly one call`);
    // Top level of the function body: two spaces, so not inside an `if`, a loop or a callback that may not run.
    assert.match(calls[0], /^ {2}(?!if\b|for\b|while\b|switch\b|else\b)[^?&|]*sweepEverySpaceAtBoot\b/,
      `the boot sweep is called under a condition or inside a callback: ${calls[0].trim()}`);
  });
});
