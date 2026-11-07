/**
 * The code of the step before (`codeAtStep(secret, -1)`, the trailing edge of the server's +-1 window) is never handed out in the last
 * moments of a step.
 *
 * ## What it prevents
 *
 * Made in the last milliseconds of a step, that code is two steps back by the time the server reads it: stale, answered `MFA_INVALID`,
 * so a case that sends a correct code reads as a defect. It failed the MFA lockout file's "failures spread over two addresses" case in
 * the 6.5.1 release's CI. The guard sits in the helper, so no caller can drop it.
 *
 * Run: node --test testing/standalone/a-test-totp-code-is-never-made-at-the-windows-trailing-edge.test.js
 */
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { codeAtStep, totpAt, STEP_SECONDS } from '../_shared/totp-codes.mjs';

const SECRET = 'JBSWY3DPEHPK3PXP';
const STEP_MS = STEP_SECONDS * 1000;
const realNow = Date.now;

/** Freezes Date.now at `msIntoStep` milliseconds into a step, and answers that instant. */
function at(msIntoStep) {
  const t = Math.floor(realNow() / STEP_MS) * STEP_MS + msIntoStep;
  Date.now = () => t;
  return t;
}

describe('codeAtStep waits out the trailing edge of the window for the step before', () => {
  afterEach(() => { Date.now = realNow; });

  it('in the last half second of a step it waits until the step would have turned', () => {
    at(STEP_MS - 500);
    const t0 = performance.now();
    codeAtStep(SECRET, -1);
    assert.ok(performance.now() - t0 >= 450, 'the code of the step before was made in the last 500 ms of a step');
  });

  it('in the middle of a step it does not wait, and the code is the step before\'s', () => {
    const t = at(STEP_MS / 2);
    const t0 = performance.now();
    const code = codeAtStep(SECRET, -1);
    assert.ok(performance.now() - t0 < 100, 'it waited in the middle of a step');
    assert.equal(code, totpAt(SECRET, Math.floor(t / 1000) - STEP_SECONDS));
  });

  it('the current and the next step never wait: neither is at the window\'s trailing edge', () => {
    at(STEP_MS - 500);
    const t0 = performance.now();
    codeAtStep(SECRET, 0);
    codeAtStep(SECRET, 1);
    assert.ok(performance.now() - t0 < 100, 'the current or the next step\'s code waited');
  });
});
