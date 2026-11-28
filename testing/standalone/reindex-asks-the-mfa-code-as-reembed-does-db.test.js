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
 * The MCP half (round-1 finding F2): MCP `space_reindex` and `space_reembed` asked no second factor, so a PAT without one rebuilt a space's vectors
 * through them where REST refused it. MCP has no channel for a code, so a caller REST would ask is refused 403 with the sentence the other tools
 * of that kind use (`mfaStepUpRefusalFor`): all four doors are stated in one case, and a token exempt from the factor, or the switch off, starts.
 *
 * Seen red on 890cf234b: reindex answers 202 without a code. Seen red on f3cd49548: both MCP tools start for a PAT asked for the code.
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
   * A fresh boot (it clears the MFA secret) with two spaces of its own (REST's, and MCP's: a run one reindex starts keeps running, and a later
   * reindex of the same space answers 409 for that reason, not for the rule), an instance-admin PAT that inherits the instance's MFA switch, one
   * that is exempt from it, and MFA on or off.
   */
  const setup = async ({ mfa }) => {
    const space = `notes${++serial}`;
    const mcpSpace = `tools${serial}`;
    await boot(dir, { spaces: [space, mcpSpace], networks: [] });
    const { plaintext } = await tokens.createToken({ name: `q181-admin-${serial}`, admin: true });
    const exempt = await tokens.createToken({ name: `q181-exempt-${serial}`, admin: true, mfa: 'exempt' });
    if (mfa) totp.enableMfa('Ythril', 'admin');
    return { key: plaintext, exemptKey: exempt.plaintext, space, mcpSpace };
  };
  /** An MCP tool call: `{ isError, text }`. MCP has no channel for a code, so a caller asked for one is refused. */
  const tool = async (key, name, args) => {
    const r = await fetch(`${server.url}/mcp`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    });
    const raw = await r.text();
    const data = /^(?:event|data):/m.test(raw) ? raw.split('\n').find(l => l.startsWith('data:'))?.slice(5) ?? '{}' : raw;
    let rpc = {}; try { rpc = JSON.parse(data); } catch { /* not JSON */ }
    return { isError: rpc.result?.isError === true || !!rpc.error, text: (rpc.result?.content ?? []).map(c => c.text ?? '').join('\n') || rpc.error?.message || '' };
  };
  const STEP_UP = /needs MFA step-up, which this door cannot present/;
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

  it('MFA on, no code: all four doors, the two REST routes and the two MCP tools, refuse a PAT asked for the code, and nothing starts', async () => {
    const s = await setup({ mfa: true });
    const toolRefusal = async (name, args) => { const a = await tool(s.key, name, args); return { refused: a.isError, stepUp: STEP_UP.test(a.text) }; };
    const got = {
      restReembed: await call('reembed', s),
      restReindex: await call('reindex', s),
      mcpReembed: await toolRefusal('space_reembed', { space: s.mcpSpace }),
      mcpReindex: await toolRefusal('space_reindex', { space: s.mcpSpace }),
    };
    assert.deepEqual(got, {
      restReembed: { status: 403, error: 'MFA_REQUIRED' },
      restReindex: { status: 403, error: 'MFA_REQUIRED' },
      mcpReembed: { refused: true, stepUp: true },
      mcpReindex: { refused: true, stepUp: true },
    }, 'a PAT without the second factor rebuilt a space\'s vectors through a door that does not ask for it');
    // Nothing started: the space the MCP calls named takes a reindex of its own afterwards (it would answer 409 had one been started).
    const after = await tool(s.exemptKey, 'space_reindex', { space: s.mcpSpace });
    assert.equal(after.isError, false, `a refused call left a run behind: ${after.text.slice(0, 200)}`);
  });

  it('MFA on, a token exempt from the second factor: both MCP tools start, as the exempt token\'s REST reindex does', async () => {
    const s = await setup({ mfa: true });
    const exempt = { key: s.exemptKey, space: s.space };
    assert.ok((await call('reindex', exempt)).status < 400, 'fixture: the exempt token\'s REST reindex was refused');
    const got = {
      mcpReembed: (await tool(s.exemptKey, 'space_reembed', { space: s.mcpSpace })).isError,
      mcpReindex: (await tool(s.exemptKey, 'space_reindex', { space: s.mcpSpace })).isError,
    };
    assert.deepEqual(got, { mcpReembed: false, mcpReindex: false }, 'a token the second factor does not ask was refused on MCP');
  });

  it('control: MFA off, both MCP tools start for the same PAT', async () => {
    const s = await setup({ mfa: false });
    const got = {
      mcpReembed: (await tool(s.key, 'space_reembed', { space: s.mcpSpace })).isError,
      mcpReindex: (await tool(s.key, 'space_reindex', { space: s.mcpSpace })).isError,
    };
    assert.deepEqual(got, { mcpReembed: false, mcpReindex: false }, 'with MFA off a tool was refused for a code');
  });
});
