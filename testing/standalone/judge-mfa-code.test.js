/**
 * `judgeMfaCode` names WHY a second-factor code was refused, so that only a guess is counted (Q-694, bundle-233).
 *
 * ## The defect it prevents
 *
 * `verifyMfaCode` answered true or false. A counter built on that false would lock an honest administrator out: the client keeps the
 * code it was given for 15 minutes and resends it on every change (`mfa.service.ts`), and each step is accepted once, so every resend
 * after the first is a REPLAY, and a cached code older than a minute is STALE. The benchmark client sends one fixed code. Neither is a
 * guess, and an attacker learns nothing from them: they are not counted. Only `wrong` is.
 *
 * ## What it holds
 *
 * `judgeMfaCode(code)` answers one of five words:
 * - `ok`     - the code of the current step or one beside it, above the last step consumed; the step is burned.
 * - `wrong`  - a code that matches no step in the last 15 minutes or the next one.
 * - `replay` - a code of the window whose step is at or below the last consumed one.
 * - `stale`  - a code of a step within the last 15 minutes but outside the +-1 window (the cached code).
 * - `unset`  - no secret is stored; nothing to judge.
 *
 * A refused judgement burns nothing (a wrong or stale code does not spend the step a right one then needs). A throw from the store
 * (`saveSecrets` failing on a full disk) is neither counted nor swallowed: it propagates. And the three refusals answer
 * IDENTICALLY through `tryMfaCode` - no oracle tells a guesser which of them it hit.
 *
 * ## Seen red
 *
 * On the base `judgeMfaCode` is not exported: every case fails with "judgeMfaCode is not a function".
 *
 * Run: node --test testing/standalone/judge-mfa-code.test.js
 * (requires a prior `npm run build -w server`)
 */
import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempInstance, boot } from './_round-open-fixtures.mjs';
import { removeInstanceDir } from './_vote-round-instance.mjs';
import { codeAtStep, wrongCode, staleCode, ancientCode } from '../_shared/totp-codes.mjs';

const dir = tempInstance('ythril-q694-judge-');
let totp; let attempts; let secret;
after(() => removeInstanceDir(dir));

describe('judgeMfaCode: ok, wrong, replay, stale, unset', () => {
  before(async () => {
    await boot(dir, { networks: [] });
    totp = await import('../../server/dist/auth/totp.js');
    assert.equal(typeof totp.judgeMfaCode, 'function', 'auth/totp.js does not export judgeMfaCode');
  });
  beforeEach(async () => {
    await boot(dir, { networks: [] });
    secret = totp.enableMfa('Ythril', 'test').secret;
  });

  it('the code of the current step is ok, once', () => {
    const code = codeAtStep(secret, 0);
    assert.equal(totp.judgeMfaCode(code), 'ok');
    assert.equal(totp.judgeMfaCode(code), 'replay');
  });

  it('the codes of the steps beside the current one are ok, in ascending order', () => {
    assert.equal(totp.judgeMfaCode(codeAtStep(secret, -1)), 'ok');
    assert.equal(totp.judgeMfaCode(codeAtStep(secret, 1)), 'ok');
  });

  it('a code of a step at or below the last consumed one is a replay, not wrong', () => {
    assert.equal(totp.judgeMfaCode(codeAtStep(secret, 1)), 'ok');
    assert.equal(totp.judgeMfaCode(codeAtStep(secret, 0)), 'replay');
    assert.equal(totp.judgeMfaCode(codeAtStep(secret, -1)), 'replay');
  });

  it('a code that fits no step is wrong, and burns nothing: the right code is still ok after it', () => {
    assert.equal(totp.judgeMfaCode(wrongCode(secret)), 'wrong');
    assert.equal(totp.judgeMfaCode(wrongCode(secret)), 'wrong');
    assert.equal(totp.judgeMfaCode(codeAtStep(secret, 0)), 'ok');
  });

  it('a code of 10 minutes ago is stale, whether or not a step has been consumed, and burns nothing', () => {
    const old = staleCode(secret, 20);
    assert.equal(totp.judgeMfaCode(old), 'stale');
    assert.equal(totp.judgeMfaCode(codeAtStep(secret, 0)), 'ok');
    assert.equal(totp.judgeMfaCode(old), 'stale', 'consuming a newer step turned a stale code into a replay: the three refusals differ');
    assert.equal(totp.judgeMfaCode(codeAtStep(secret, 0)), 'replay');
  });

  it('stale reaches back 15 minutes and no further; a code of 20 minutes ago, or of a step ahead, is wrong', () => {
    assert.equal(totp.judgeMfaCode(staleCode(secret, 2)), 'stale', 'two steps back is outside the window and inside 15 minutes');
    assert.equal(totp.judgeMfaCode(staleCode(secret, 28)), 'stale', '14 minutes back is inside 15 minutes');
    assert.equal(totp.judgeMfaCode(ancientCode(secret)), 'wrong', '20 minutes back is past the stale memory');
    assert.equal(totp.judgeMfaCode(codeAtStep(secret, 4)), 'wrong', 'a step ahead of the window is a guess');
  });

  it('with no secret stored the answer is unset, for any code', () => {
    totp.disableMfa();
    for (const code of ['000000', '123456', '']) assert.equal(totp.judgeMfaCode(code), 'unset', JSON.stringify(code));
  });

  it('a store that cannot save the burned step throws, and the throw is not an answer', () => {
    const secretsDir = path.dirname(process.env.CONFIG_PATH);
    const tmp = path.join(secretsDir, 'secrets.json.tmp');
    fs.mkdirSync(tmp, { recursive: true });
    try {
      assert.throws(() => totp.judgeMfaCode(codeAtStep(secret, 0)), 'a failing save of the consumed step was swallowed or answered as a word');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('replay, stale and wrong answer alike through tryMfaCode: no oracle', () => {
  before(async () => {
    await boot(dir, { networks: [] });
    totp ??= await import('../../server/dist/auth/totp.js');
    attempts = await import('../../server/dist/auth/code-attempts.js');
  });
  beforeEach(async () => {
    await boot(dir, { networks: [] });
    secret = totp.enableMfa('Ythril', 'test').secret;
    attempts.resetMfaAttempts();
  });

  it('the three refusals return one and the same value, and none of them is the lock', () => {
    const req = { ip: '127.0.0.1', headers: {}, socket: { remoteAddress: '127.0.0.1' }, app: { get: () => false, settings: {} } };
    const first = codeAtStep(secret, 0);
    assert.deepEqual(attempts.tryMfaCode(first, { tokenId: 'oracle', req }), { ok: true });
    const wrong = attempts.tryMfaCode(wrongCode(secret), { tokenId: 'oracle-w', req });
    const replay = attempts.tryMfaCode(first, { tokenId: 'oracle-r', req });
    const stale = attempts.tryMfaCode(staleCode(secret), { tokenId: 'oracle-s', req });
    assert.deepEqual(wrong, { ok: false, reason: 'invalid' });
    assert.deepEqual(replay, wrong, 'a replay is told apart from a wrong code');
    assert.deepEqual(stale, wrong, 'a stale code is told apart from a wrong code');
  });
});
