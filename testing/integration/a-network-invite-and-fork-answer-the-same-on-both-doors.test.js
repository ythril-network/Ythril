/**
 * An invite key and a fork answer the same through MCP as through REST (`F-36`, slice 3).
 *
 * The tools call the acts the routes call (`networks/network-acts.ts`), so this checks the outcome both ways: the
 * same shape of key with the same reusability, the same refusal for a token that may not invite, and a fork whose
 * network matches the one REST forks.
 *
 * Run: node --test testing/integration/a-network-invite-and-fork-answer-the-same-on-both-doors.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'url';
import { INSTANCES, post, get, del, delWithBody } from '../sync/helpers.js';
import { openMcpSession } from '../sync/mcp-session.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIGS = path.join(__dirname, '..', 'sync', 'configs');
const RUN = Date.now();
const SPACE = `f363-${RUN}`;
const FOUR = (r) => ({ knowledge: r, files: r, schema: r, dataQuality: r });

let admin, mcp, shortToken, shortMcp;
const networks = [];

before(async () => {
  admin = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
  assert.equal((await post(INSTANCES.a, admin, '/api/spaces', { id: SPACE, label: SPACE })).status, 201);
  for (const type of ['pubsub', 'club']) {
    const n = await post(INSTANCES.a, admin, '/api/networks', { label: `f363-${type}-${RUN}`, type, spaces: [SPACE] });
    assert.equal(n.status, 201, JSON.stringify(n.body));
    networks.push(n.body.id);
  }
  // Sees the networks (networks: read) but administers nothing, so it may not invite.
  const t = await post(INSTANCES.a, admin, '/api/tokens', { name: `f363-short-${RUN}`, rights: {
    instanceAdmin: false, createSpaces: false, floor: null, perSpace: { [SPACE]: { ...FOUR('write'), networks: 'write' } } } });
  assert.equal(t.status, 201, JSON.stringify(t.body));
  shortToken = t.body.plaintext;
  mcp = await openMcpSession(admin);
  shortMcp = await openMcpSession(shortToken);
});

after(async () => {
  await mcp?.close?.(); await shortMcp?.close?.();
  for (const id of networks) await del(INSTANCES.a, admin, `/api/networks/${id}`).catch(() => {});
  await delWithBody(INSTANCES.a, admin, `/api/spaces/${SPACE}`, { confirm: true }).catch(() => {});
});

const tool = async (session, name, args) => {
  const r = await session.callTool(name, args);
  return { isError: !!r?.isError, body: r?.structuredContent ?? {}, text: r?.content?.[0]?.text ?? '' };
};

describe('an invite key through MCP and through REST', () => {
  it('network_invite mints the same kind of key POST /invite mints, reusable only on pub/sub', async () => {
    for (const [i, reusable] of [[0, true], [1, false]]) {
      const rest = await post(INSTANCES.a, admin, `/api/networks/${networks[i]}/invite`, {});
      const viaMcp = await tool(mcp, 'network_invite', { id: networks[i] });
      assert.equal(rest.status, 200, JSON.stringify(rest.body));
      assert.equal(viaMcp.isError, false, viaMcp.text);
      assert.deepEqual(Object.keys(viaMcp.body).sort(), Object.keys(rest.body).sort());
      assert.equal(viaMcp.body.reusable, reusable);
      assert.match(viaMcp.body.inviteKey, /^ythril_invite_/);
      assert.notEqual(viaMcp.body.inviteKey, rest.body.inviteKey, 'each call mints a fresh key');
    }
  });

  it('a token that may not invite is refused with the same sentence on both doors', async () => {
    const rest = await post(INSTANCES.a, shortToken, `/api/networks/${networks[1]}/invite`, {});
    assert.equal(rest.status, 403, JSON.stringify(rest.body));
    assert.equal((await tool(shortMcp, 'network_invite', { id: networks[1] })).text, `Error (403): ${rest.body.error}`);
  });
});

describe('a fork through MCP and through REST', () => {
  it('network_fork founds the network POST /fork founds', async () => {
    const rest = await post(INSTANCES.a, admin, `/api/networks/${networks[1]}/fork`, { label: `f363-fork-rest-${RUN}`, type: 'club' });
    const viaMcp = await tool(mcp, 'network_fork', { id: networks[1], label: `f363-fork-mcp-${RUN}`, type: 'club' });
    assert.equal(rest.status, 201, JSON.stringify(rest.body));
    assert.equal(viaMcp.isError, false, viaMcp.text);
    networks.push(rest.body.id, viaMcp.body.id);
    const pick = (n) => ({ type: n.type, spaces: n.spaces, members: n.members.length, origin: n.origin });
    assert.deepEqual(pick(viaMcp.body), pick(rest.body));
    assert.equal((await get(INSTANCES.a, admin, `/api/networks/${viaMcp.body.id}`)).status, 200);
  });

  it('an unknown space is refused with the same sentence on both doors', async () => {
    const args = { label: `f363-bad-${RUN}`, spaces: [`nope-${RUN}`] };
    const rest = await post(INSTANCES.a, admin, `/api/networks/${networks[1]}/fork`, args);
    assert.equal(rest.status, 400, JSON.stringify(rest.body));
    assert.equal((await tool(mcp, 'network_fork', { id: networks[1], ...args })).text, `Error (400): ${rest.body.error}`);
  });
});
