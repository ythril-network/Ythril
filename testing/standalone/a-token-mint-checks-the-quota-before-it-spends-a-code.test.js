/**
 * `POST /api/tokens` asks the quota ceiling before it asks for, verifies and counts a second-factor code (Q-694, bundle-233; PATCH side: Q-656).
 *
 * ## The defect it prevents
 *
 * `exemptionNeedsLiveCode` verifies the one-time code that grants an `mfa: 'exempt'`. Run before the quota check, a body whose
 * `rateLimitPerMinute` the instance ceiling refuses anyway first BURNS a live code (a TOTP step is single use: the operator waits out
 * 30 s) and, since the lockout, counts every wrong code of such a body against the token: five refused bodies lock an administrator
 * out of code entry for 15 minutes without one real guess. The PATCH route learned this in Q-656
 * (`per-token-rate-limit.test.js`, "a PATCH refuses a bad quota before ... the MFA code is verified and spent"); the mint route is held
 * the same way here, by its source, since the order is the guarantee and a behaviour test of one body cannot see a future guard
 * that lands between them. The behaviour is driven in `a-wrong-mfa-code-is-counted-and-locks-db`.
 *
 * ## What it holds
 *
 * In the `tokensRouter.post('/'` handler (comments stripped, from its registration to the next router statement),
 * `rateLimitRefusalResponse(` comes before `exemptionNeedsLiveCode(`, before `tryMfaCode(` if the handler names it, and before
 * `createToken(`; and `exemptionNeedsLiveCode` itself is where the code is asked (it calls `tryMfaCode(`).
 *
 * ## Seen red
 *
 * On the base `exemptionNeedsLiveCode(` comes first in the handler, and the helper calls `verifyMfaCode(`. The order check is run over a
 * planted copy with the two swapped: it is flagged.
 *
 * Run: node --test testing/standalone/a-token-mint-checks-the-quota-before-it-spends-a-code.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripComments } from './_strip-comments.mjs';

const routes = stripComments(readFileSync('server/src/api/tokens.ts', 'utf8'));

/** The mint handler, from its registration to the next router registration. */
function mintHandler(code) {
  const start = code.indexOf("tokensRouter.post('/'");
  assert.ok(start >= 0, "the POST '/' route was not found");
  const next = code.indexOf('tokensRouter.', start + 1);
  return code.slice(start, next < 0 ? undefined : next);
}

/** The effects of the mint handler that run at or before the quota check, which must all run after it. */
function effectsBeforeQuota(handler) {
  const quota = handler.indexOf('rateLimitRefusalResponse(');
  if (quota < 0) return ['the handler no longer checks the quota'];
  return ['exemptionNeedsLiveCode(', 'tryMfaCode(', 'createToken(']
    .filter(effect => { const at = handler.indexOf(effect); return at >= 0 && at < quota; });
}

describe('POST /api/tokens: the quota is asked before a code is spent or counted', () => {
  it('finds the handler, the quota check and the code check', () => {
    const handler = mintHandler(routes);
    assert.ok(handler.length > 500, 'the mint handler is too short to be the route');
    assert.ok(handler.includes('rateLimitRefusalResponse('), 'the mint handler has no quota check');
    assert.ok(handler.includes('exemptionNeedsLiveCode('), 'the mint handler has no exemption code check');
  });

  it('nothing that asks a code or writes a token runs before the quota check', () => {
    assert.deepEqual(effectsBeforeQuota(mintHandler(routes)), [],
      'a code is verified (and spent, and counted) before an over-ceiling body is refused: move rateLimitRefusalResponse above it');
  });

  it('the exemption helper asks the code through the one door sequence, which asks tryMfaCode', () => {
    const start = routes.indexOf('function exemptionNeedsLiveCode(');
    assert.ok(start >= 0, 'exemptionNeedsLiveCode is gone');
    const body = routes.slice(start, routes.indexOf('\n}\n', start));
    assert.match(body, /(?<![\w$])mfaCodeHolds\s*\(/, 'exemptionNeedsLiveCode does not ask mfaCodeHolds');
    assert.doesNotMatch(body, /\b(?:verifyMfaCode|judgeMfaCode)\b/, 'exemptionNeedsLiveCode reaches the verifier without the counter');
    const door = stripComments(readFileSync('server/src/api/mfa-code-door.ts', 'utf8'));
    assert.match(door, /(?<![\w$])tryMfaCode\s*\(/, 'the door sequence does not ask tryMfaCode');
    assert.doesNotMatch(door, /\b(?:verifyMfaCode|judgeMfaCode)\b/, 'the door sequence reaches the verifier without the counter');
  });

  it('the order check flags a handler with the code first (planted copy)', () => {
    const planted = "tokensRouter.post('/', h, async (req, res) => {\n"
      + '  if (!exemptionNeedsLiveCode(req, res, mfa)) return;\n'
      + '  const refusal = rateLimitRefusalResponse(q);\n'
      + '  await createToken(x);\n});\n';
    assert.deepEqual(effectsBeforeQuota(mintHandler(planted)), ['exemptionNeedsLiveCode(']);
    assert.deepEqual(effectsBeforeQuota(mintHandler(planted.replace(
      '  if (!exemptionNeedsLiveCode(req, res, mfa)) return;\n  const refusal = rateLimitRefusalResponse(q);\n',
      '  const refusal = rateLimitRefusalResponse(q);\n  if (!exemptionNeedsLiveCode(req, res, mfa)) return;\n'))), []);
  });
});
