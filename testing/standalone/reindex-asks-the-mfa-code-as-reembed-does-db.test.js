/**
 * `POST /api/brain/spaces/:spaceId/reindex` asks a PAT for its MFA code on an instance with MFA on, as `POST /api/spaces/:id/reembed` does
 * (Q-181, bundle-41).
 *
 * ## The defect
 *
 * Reindex and reembed both rebuild a space's vectors, and both are the space's knowledge admin's. Reembed's route is guarded by
 * `requireSpaceAuthMfaScoped('id')`, which adds the MFA step-up for a personal access token when MFA is on; reindex's route by plain
 * `requireSpaceAuth`, so a PAT without `X-TOTP-Code` started a reindex, which drops and rebuilds every vector of the space, where reembed
 * refused it with `403 MFA_REQUIRED`.
 *
 * ## What it holds (the real application over a socket, real MongoDB)
 *
 * With MFA enabled and an instance-admin PAT, stated over both routes at once, each row's expected answer hand-written:
 *  - no code: reembed `403 MFA_REQUIRED` (the reference), reindex `403 MFA_REQUIRED`;
 *  - a wrong code: both `403 MFA_INVALID`.
 * The control: MFA not enabled, reindex is not refused for a code (it answers below 400), so the step-up asks only when MFA is on.
 *
 * Written as an in-process -db test, not a stack test (bundle-41 departure): the same application and guards, and it runs without the shared
 * test stack, so it was seen red on the unchanged code.
 *
 * Seen red on 890cf234b: reindex answers 202 without a code.
 *
 * Run: node --test testing/standalone/reindex-asks-the-mfa-code-as-reembed-does-db.test.js
 * (requires a prior server build and the test MongoDB)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';
import { removeInstanceDir } from './_vote-round-instance.mjs';
import { listenApp } from '../_shared/in-process-app.mjs';
import { tempInstance, boot, databaseTakesCollections } from './_round-open-fixtures.mjs';

const dir = tempInstance('ythril-q181-mfa-');
const skip = await mongoSkipReason();

/** The two routes that rebuild a space's vectors; reembed is the reference whose answers reindex must give. */
const ROUTES = {
  reembed: (space) => `/api/spaces/${space}/reembed`,
  reindex: (space) => `/api/brain/spaces/${space}/reindex`,
};

describe('Q-181: reindex asks the MFA code of a PAT as reembed does', { skip }, () => {
  let mongo; let server; let totp; let tokens;
  before(async () => {
    mongo = await openTestMongo('q181_reindex_mfa');
    await databaseTakesCollections(mongo);
    await boot(dir, { networks: [] });
    totp = await import('../../server/dist/auth/totp.js');
    tokens = await import('../../server/dist/auth/tokens.js');
    server = await listenApp();
  });
  after(async () => { await server?.close(); await closeTestMongo(); removeInstanceDir(dir); });

  let serial = 0;
  /**
   * A fresh boot (it clears the MFA secret) with a space of its own, an instance-admin PAT, and MFA on or off. A space per row: a reindex one
   * row starts keeps running, and a later row's reindex on the same space answers 409 for that reason, not for the rule.
   */
  const setup = async ({ mfa }) => {
    const space = `notes${++serial}`;
    await boot(dir, { spaces: [space], networks: [] });
    const { plaintext } = await tokens.createToken({ name: `q181-admin-${serial}`, admin: true });
    if (mfa) totp.enableMfa('Ythril', 'admin');
    return { key: plaintext, space };
  };
  const call = async (route, { key, space }, code) => {
    const r = await fetch(`${server.url}${ROUTES[route](space)}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...(code ? { 'x-totp-code': code } : {}) },
      body: JSON.stringify({}),
    });
    const text = await r.text();
    let body; try { body = JSON.parse(text); } catch { body = { raw: text }; }
    return { status: r.status, error: body?.error ?? null };
  };

  it('MFA on, no code: reembed and reindex both answer 403 MFA_REQUIRED', async () => {
    const key = await setup({ mfa: true });
    const got = { reembed: await call('reembed', key), reindex: await call('reindex', key) };
    assert.deepEqual(got, { reembed: { status: 403, error: 'MFA_REQUIRED' }, reindex: { status: 403, error: 'MFA_REQUIRED' } },
      'a PAT without its MFA code started a rebuild of the space\'s vectors through one door the other refuses');
  });

  it('MFA on, a wrong code: reembed and reindex both answer 403 MFA_INVALID', async () => {
    const key = await setup({ mfa: true });
    const got = { reembed: await call('reembed', key, '000000'), reindex: await call('reindex', key, '000000') };
    assert.deepEqual(got, { reembed: { status: 403, error: 'MFA_INVALID' }, reindex: { status: 403, error: 'MFA_INVALID' } });
  });

  it('control: MFA off, reindex is not refused for a code', async () => {
    const key = await setup({ mfa: false });
    const res = await call('reindex', key);
    assert.ok(res.status < 400, `with MFA off reindex answered ${res.status} ${res.error}`);
  });
});
