/**
 * A PATCH whose quota is refused spends no second-factor code and changes nothing (Q-656, bundle-211).
 *
 * ## The defect
 *
 * `PATCH /api/tokens/:id` checked the quota after it had verified the one-time code that grants an `mfa: 'exempt'`, and after the
 * rename: a body with an exemption, a new name and a quota over the instance ceiling burned a code (a TOTP step is single use, so the
 * operator had to wait out the 30 s window), renamed the token, and answered 403. The refusal now comes right after the "nothing to
 * change" check, before the code and before any write.
 *
 * ## Why this is a test of the running route
 *
 * The case needs what a stack of the integration suite does not have: MFA switched ON (a stored `totpSecret`) and an instance ceiling set
 * (`YTHRIL_RATE_LIMIT_PER_MINUTE`). On a stack with neither, the quota refusal and the code check both pass or both refuse alike, and
 * the case cannot fail. Here the real application serves the route over loopback with a real bearer, MFA is enabled, and the ceiling
 * is 50. The caller is an exempt instance admin, so the middleware asks it for no code: the only code the route reads is the one an
 * exemption grant needs, which is the one that must not be spent.
 *
 * Two bodies, one stored token each time: an over-ceiling quota beside a name and an exemption, sent with (a) a LIVE code and (b) a
 * WRONG code. Both answer the ceiling's 403, not `MFA_REQUIRED` / `MFA_INVALID` (the quota is asked first), and the name and the
 * exemption are unchanged. After (a) the same code is still accepted by the verifier, and a PATCH with it and a quota within the
 * ceiling then succeeds: the refused call did not spend it.
 *
 * Run: `npm run test:up` first, then node --test testing/standalone/a-refused-quota-spends-no-code-and-renames-nothing-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { generate } from 'otplib';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';
import { removeInstanceDir } from './_vote-round-instance.mjs';
import { listenApp } from '../_shared/in-process-app.mjs';
import { tempInstance, boot } from './_round-open-fixtures.mjs';

const dir = tempInstance('ythril-q656-quota-');
const skip = await mongoSkipReason();
const CEILING = 50;
const CEILING_ENV = 'YTHRIL_RATE_LIMIT_PER_MINUTE';
const ceilingBefore = process.env[CEILING_ENV];

describe('PATCH /api/tokens/:id: a refused quota spends no code and renames nothing (real app, MFA on, ceiling set)', { skip }, () => {
  let server; let tokens; let totp; let loader;
  before(async () => {
    await openTestMongo('q656quota');
    await boot(dir, { networks: [] });
    loader = await import('../../server/dist/config/loader.js');
    tokens = await import('../../server/dist/auth/tokens.js');
    totp = await import('../../server/dist/auth/totp.js');
    server = await listenApp();
  });
  after(async () => {
    if (ceilingBefore === undefined) delete process.env[CEILING_ENV]; else process.env[CEILING_ENV] = ceilingBefore;
    await server?.close();
    await closeTestMongo();
    removeInstanceDir(dir);
  });

  let serial = 0;
  /** An exempt instance admin (no code at the door), a plain target token, MFA on and the ceiling set. */
  async function setup() {
    await boot(dir, { networks: [] });
    process.env[CEILING_ENV] = String(CEILING);
    const admin = await tokens.createToken({ name: `admin-${++serial}`, admin: true, mfa: 'exempt' });
    const target = await tokens.createToken({ name: `target-${serial}` });
    const { secret } = totp.enableMfa('Ythril', 'admin');
    return { key: admin.plaintext, id: target.record.id, name: target.record.name, secret };
  }
  async function patch(key, id, body, code) {
    const r = await fetch(`${server.url}/api/tokens/${id}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...(code ? { 'x-totp-code': code } : {}) },
      body: JSON.stringify(body),
    });
    const text = await r.text();
    let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
    return { status: r.status, body: json };
  }
  const stored = (id) => loader.getConfig().tokens.find(t => t.id === id);

  it('control: the ceiling is set and MFA is on, so a bad body is refused for its quota and a good one needs the code', async () => {
    const { key, id, secret } = await setup();
    const none = await patch(key, id, { mfa: 'exempt' });
    assert.deepEqual([none.status, none.body.error], [403, 'MFA_REQUIRED'], 'an exemption without a code must be refused for the code');
    const wrong = await patch(key, id, { mfa: 'exempt' }, '000000');
    assert.deepEqual([wrong.status, wrong.body.error], [403, 'MFA_REQUIRED'], 'an exemption with a wrong code must be refused for the code');
    assert.equal(stored(id).mfa, undefined);
    const right = await patch(key, id, { mfa: 'exempt', rateLimitPerMinute: CEILING }, await generate({ secret }));
    assert.equal(right.status, 200, JSON.stringify(right.body));
    assert.equal(stored(id).mfa, 'exempt');
  });

  it('an over-ceiling quota beside an exemption and a LIVE code answers 403 for the ceiling, spends the code and renames nothing', async () => {
    const { key, id, name, secret } = await setup();
    const code = await generate({ secret });
    const res = await patch(key, id, { name: 'renamed', mfa: 'exempt', rateLimitPerMinute: CEILING * 10 }, code);
    assert.equal(res.status, 403, JSON.stringify(res.body));
    assert.match(String(res.body.error), /instance ceiling of 50/, 'the refusal does not name the ceiling');
    assert.notEqual(res.body.error, 'MFA_REQUIRED');
    const row = stored(id);
    assert.equal(row.name, name, 'the refused edit renamed the token');
    assert.equal(row.mfa, undefined, 'the refused edit stored the exemption');
    assert.equal(row.rateLimitPerMinute, undefined, 'the refused edit stored the quota');
    assert.equal(totp.verifyMfaCode(code), true, 'the refused edit spent the one-time code: the verifier no longer accepts it');
  });

  it('the same code then serves a PATCH whose quota is within the ceiling', async () => {
    const { key, id, secret } = await setup();
    const code = await generate({ secret });
    const refused = await patch(key, id, { mfa: 'exempt', rateLimitPerMinute: CEILING + 1 }, code);
    assert.equal(refused.status, 403, JSON.stringify(refused.body));
    const accepted = await patch(key, id, { name: 'renamed', mfa: 'exempt', rateLimitPerMinute: CEILING }, code);
    assert.equal(accepted.status, 200, `the code a refused edit must not have spent was refused: ${JSON.stringify(accepted.body)}`);
    assert.deepEqual([stored(id).name, stored(id).mfa], ['renamed', 'exempt']);
  });

  it('an over-ceiling quota beside an exemption and a WRONG code answers the ceiling, not the code, and renames nothing', async () => {
    const { key, id, name } = await setup();
    const res = await patch(key, id, { name: 'renamed', mfa: 'exempt', rateLimitPerMinute: CEILING * 10 }, '000000');
    assert.equal(res.status, 403, JSON.stringify(res.body));
    assert.match(String(res.body.error), /instance ceiling of 50/, 'the code was checked before the quota: the refusal names the code');
    assert.equal(stored(id).name, name);
    assert.equal(stored(id).mfa, undefined);
  });
});
