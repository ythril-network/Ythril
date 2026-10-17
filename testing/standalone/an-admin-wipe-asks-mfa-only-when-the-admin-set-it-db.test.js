/**
 * The admin wipe route asks for a second factor only when that administrator enabled one - and a networked wipe that passes at open then runs
 * (bundle-106 R-D41, MFA half; design v5 section 2.4a, owner D-41, 2026-10-15: "instance admin needs mfa only when he set mfa in his settings").
 *
 * ## What it holds
 *
 * `POST /api/admin/spaces/:spaceId/wipe` through the REAL application over a socket, as an instance-administrator token, on a club space (one yes
 * passes the round, so the wipe acts in the request):
 *
 * - **MFA not enabled:** no code is asked; the wipe answers `200 { status: 'wiped' }` and the data is gone. (Red on the base: the networked wipe
 *   answers `202 vote_pending` and nothing is wiped - Q-453. The route's MFA rule is not what changes.)
 * - **MFA enabled, no code:** `403 MFA_REQUIRED`, and the data survives. **A wrong code:** `403 MFA_INVALID`, the data survives. (Both green on the
 *   base: they are today's behaviour, unchanged, which D-41 keeps - the rule must not move when the wipe starts acting at once.)
 * - **MFA enabled, a live code:** `200 'wiped'` and the data is gone.
 *
 * The decision "who may empty a networked space" is the tool's `spaceAdmin` flag (`a-wipe-through-the-tool-is-a-space-admin-decision-db`); this file is
 * the admin ROUTE's half, whose rights are the instance administrator's and whose only gate beyond that is MFA.
 *
 * ## Seen red
 *
 * On the base the two rows that expect `200 wiped` fail (`202 vote_pending`, data intact); the two refusals are the controls. After the fix, by hand:
 * drop the MFA middleware from the route -> the two refusal rows red; ask MFA unconditionally -> the first row red.
 *
 * Run: node --test testing/standalone/an-admin-wipe-asks-mfa-only-when-the-admin-set-it-db.test.js
 * (requires a prior server build and the test MongoDB)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { generate } from 'otplib';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';
import { removeInstanceDir } from './_vote-round-instance.mjs';
import { listenOnLoopback } from '../_shared/local-server.mjs';
import { M1, tempInstance, networkOf, boot, seedFacts, factCount, databaseTakesCollections, warmSpaceCreation } from './_round-open-fixtures.mjs';

const dir = tempInstance('ythril-d41-mfa-');
const skip = await mongoSkipReason();

describe('D-41: the admin wipe route asks MFA only when the admin enabled it', { skip }, () => {
  let mongo; let server; let totp; let tokens;
  before(async () => {
    process.env['YTHRIL_MODELS_OFFLINE'] = '1';
    mongo = await openTestMongo('d41_mfa');
    await databaseTakesCollections(mongo);
    await boot(dir, { networks: [] });
    await warmSpaceCreation();
    totp = await import('../../server/dist/auth/totp.js');
    tokens = await import('../../server/dist/auth/tokens.js');
    const { createApp } = await import('../../server/dist/app.js');
    server = await listenOnLoopback(http.createServer(createApp()));
  });
  after(async () => { await server?.close(); await closeTestMongo(); removeInstanceDir(dir); });

  let serial = 0;
  /** A club carrying `notes` with facts in it, an instance-admin token, and whether the admin enabled MFA (a boot clears the secrets, so each case starts without). */
  const setup = async ({ mfa }) => {
    await boot(dir, { spaces: ['notes'], networks: [networkOf('club', [M1], { spaces: ['general', 'notes'] })] });
    await seedFacts(mongo, 'notes', 2, `d41-mfa-${++serial}`);
    const { plaintext } = await tokens.createToken({ name: `admin-${serial}`, admin: true });
    const secret = mfa ? totp.enableMfa('Ythril', 'admin').secret : undefined;
    return { key: plaintext, secret, before: await factCount(mongo, 'notes') };
  };
  const wipe = async (key, code) => {
    const r = await fetch(`${server.url}/api/admin/spaces/notes/wipe`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...(code ? { 'x-totp-code': code } : {}) },
      body: JSON.stringify({ confirm: true }),
    });
    const text = await r.text();
    let body; try { body = JSON.parse(text); } catch { body = { raw: text }; }
    return { status: r.status, body };
  };

  it('MFA not enabled: no code is asked, the wipe answers 200 wiped and the data is gone', async () => {
    const { key } = await setup({ mfa: false });
    const res = await wipe(key);
    assert.equal(res.status, 200, `${res.status} ${JSON.stringify(res.body).slice(0, 200)}: a club wipe passes at open, so it acts in the request`);
    assert.equal(res.body.status, 'wiped', JSON.stringify(res.body).slice(0, 200));
    assert.equal(await factCount(mongo, 'notes'), 0, 'the answer says wiped and the space still holds records');
  });

  it('control: MFA enabled and no code - 403 MFA_REQUIRED, the data survives', async () => {
    const { key, before } = await setup({ mfa: true });
    const res = await wipe(key);
    assert.deepEqual([res.status, res.body.error], [403, 'MFA_REQUIRED']);
    assert.equal(await factCount(mongo, 'notes'), before, 'a refused wipe emptied the space');
  });

  it('control: MFA enabled and a wrong code - 403 MFA_INVALID, the data survives', async () => {
    const { key, before } = await setup({ mfa: true });
    const res = await wipe(key, '000000');
    assert.deepEqual([res.status, res.body.error], [403, 'MFA_INVALID']);
    assert.equal(await factCount(mongo, 'notes'), before, 'a refused wipe emptied the space');
  });

  it('MFA enabled and a live code: the wipe answers 200 wiped and the data is gone', async () => {
    const { key, secret } = await setup({ mfa: true });
    const res = await wipe(key, await generate({ secret }));
    assert.equal(res.status, 200, `${res.status} ${JSON.stringify(res.body).slice(0, 200)}`);
    assert.equal(res.body.status, 'wiped', JSON.stringify(res.body).slice(0, 200));
    assert.equal(await factCount(mongo, 'notes'), 0);
  });
});
