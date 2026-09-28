/**
 * A token holding `createSpaces` creates a space on every door, and administers what it created (`Q-134`).
 *
 * Owner, 2026-09-28: *"Create space has a extra toggle to avoid needing instance admin to create space"* and
 * *"Creator of a space gets space admin"*. The right worked on one door of three: a join honoured it, while
 * `POST /api/spaces` and `save_space` demanded an instance administrator — and nothing gave the creator any rung on
 * the space, so a token with per-space rows and no floor would have made a space it could not read.
 *
 * Run: node --test testing/integration/a-token-that-may-create-spaces-creates-one-on-every-door.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'url';
import { INSTANCES, get, post, delWithBody } from '../sync/helpers.js';
import { openMcpSession } from '../sync/mcp-session.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIGS = path.join(__dirname, '..', 'sync', 'configs');
const RUN = Date.now();
const VIA_REST = `q134-rest-${RUN}`;
const VIA_MCP = `q134-mcp-${RUN}`;
const REFUSED = `q134-refused-${RUN}`;

let admin, creator, creatorId, nonCreator;
const sessions = [];

async function mint(name, rights) {
  const r = await post(INSTANCES.a, admin, '/api/tokens', { name: `${name}-${RUN}`, rights });
  assert.equal(r.status, 201, `mint ${name}: ${JSON.stringify(r.body)}`);
  return r.body;
}
async function mcpAs(token) {
  const s = await openMcpSession(token);
  sessions.push(s);
  return s;
}
const storedRights = async (id) => (await get(INSTANCES.a, admin, '/api/tokens')).body.tokens.find(t => t.id === id)?.rights;

before(async () => {
  admin = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
  // The right and nothing else: no floor, no row, no administration — the platform's case.
  const c = await mint('q134-creator', { instanceAdmin: false, createSpaces: true, floor: null, perSpace: {} });
  creator = c.plaintext;
  creatorId = c.token.id;
  nonCreator = (await mint('q134-non-creator', { instanceAdmin: false, createSpaces: false, floor: null, perSpace: {} })).plaintext;
});

after(async () => {
  for (const s of sessions) await s?.close?.();
  for (const id of [VIA_REST, VIA_MCP, REFUSED]) await delWithBody(INSTANCES.a, admin, `/api/spaces/${id}`, { confirm: true }).catch(() => {});
});

describe('createSpaces is enough to create a space', () => {
  it('over REST', async () => {
    const r = await post(INSTANCES.a, creator, '/api/spaces', { id: VIA_REST, label: VIA_REST });
    assert.equal(r.status, 201, `a createSpaces token could not create a space over REST: ${r.status} ${JSON.stringify(r.body)}`);
  });

  it('over MCP, where save_space is offered to it', async () => {
    const mcp = await mcpAs(creator);
    const tools = await mcp.listTools();
    assert.ok(tools.some(t => t.name === 'save_space'), 'save_space is hidden from a token that may create spaces');
    const r = await mcp.callTool('save_space', { id: VIA_MCP, label: VIA_MCP });
    assert.ok(!r?.isError, `save_space refused a createSpaces token: ${r?.content?.[0]?.text}`);
  });
});

describe('the creator administers what it created', () => {
  it('its stored rights name both spaces as administered', async () => {
    const rights = await storedRights(creatorId);
    assert.ok(rights?.spaceAdmin?.spaces?.includes(VIA_REST), `REST create did not grant its creator admin: ${JSON.stringify(rights)}`);
    assert.ok(rights?.spaceAdmin?.spaces?.includes(VIA_MCP), `MCP create did not grant its creator admin: ${JSON.stringify(rights)}`);
    assert.equal(rights.spaceAdmin.floor, false, 'the grant widened the floor, which reaches every space');
    assert.equal(rights.instanceAdmin, false, 'the grant made the creator an instance admin');
  });

  it('and can read and write each one', async () => {
    for (const id of [VIA_REST, VIA_MCP]) {
      const w = await post(INSTANCES.a, creator, `/api/brain/spaces/${id}/facts`, { fact: `written by the creator of ${id}` });
      assert.ok(w.status === 200 || w.status === 201, `the creator cannot write the space it created (${id}): ${w.status} ${JSON.stringify(w.body)}`);
      const r = await get(INSTANCES.a, creator, `/api/brain/spaces/${id}/stats`);
      assert.equal(r.status, 200, `the creator cannot read the space it created (${id}): ${r.status}`);
    }
  });

  it('the grant is in the audit log', async () => {
    const log = await get(INSTANCES.a, admin, `/api/admin/audit-log?operation=token.creator_grant&tokenId=${creatorId}`);
    assert.equal(log.status, 200, JSON.stringify(log.body));
    const spaces = (log.body.entries ?? []).map(e => e.spaceId);
    assert.ok(spaces.includes(VIA_REST) && spaces.includes(VIA_MCP), `the grants were not audited: ${JSON.stringify(spaces)}`);
  });
});

describe('a join that creates a space grants the joining token admin on it', () => {
  const JOINED = `q134-join-${RUN}`;
  let adminB, netId;
  after(async () => {
    if (netId) {
      await delWithBody(INSTANCES.b, adminB, `/api/networks/${netId}`, {}).catch(() => {});
      await delWithBody(INSTANCES.a, admin, `/api/networks/${netId}`, {}).catch(() => {});
    }
    await delWithBody(INSTANCES.a, admin, `/api/spaces/${JOINED}`, { confirm: true }).catch(() => {});
    await delWithBody(INSTANCES.b, adminB, `/api/spaces/${JOINED}`, { confirm: true }).catch(() => {});
  });

  it('as the direct doors do', async () => {
    adminB = fs.readFileSync(path.join(CONFIGS, 'b', 'token.txt'), 'utf8').trim();
    const s = await post(INSTANCES.a, admin, '/api/spaces', { id: JOINED, label: JOINED });
    assert.equal(s.status, 201, JSON.stringify(s.body));
    const n = await post(INSTANCES.a, admin, '/api/networks', { label: `q134-${RUN}`, type: 'closed', spaces: [JOINED], votingDeadlineHours: 1 });
    assert.equal(n.status, 201, JSON.stringify(n.body));
    netId = n.body.id;
    const gen = await post(INSTANCES.a, admin, '/api/invite/generate', { networkId: netId });
    assert.equal(gen.status, 201, JSON.stringify(gen.body));

    // F-34.1's floor stays: a join that creates a space needs createSpaces and a floor of networks write.
    const FLOOR = { knowledge: 'none', files: 'none', schema: 'none', dataQuality: 'none', networks: 'write' };
    const j = await post(INSTANCES.b, adminB, '/api/tokens', { name: `q134-joiner-${RUN}`,
      rights: { instanceAdmin: false, createSpaces: true, floor: FLOOR, perSpace: {} } });
    assert.equal(j.status, 201, JSON.stringify(j.body));
    const joined = await post(INSTANCES.b, j.body.plaintext, '/api/networks/join-remote', {
      handshakeId: gen.body.handshakeId, inviteUrl: 'http://ythril-a:3200/api/invite/apply',
      rsaPublicKeyPem: gen.body.rsaPublicKeyPem, networkId: netId, myUrl: 'http://ythril-b:3200' });
    assert.equal(joined.status, 200, JSON.stringify(joined.body));
    assert.deepEqual(joined.body.createdSpaces, [JOINED]);

    const rights = (await get(INSTANCES.b, adminB, '/api/tokens')).body.tokens.find(t => t.id === j.body.token.id)?.rights;
    assert.ok(rights?.spaceAdmin?.spaces?.includes(JOINED), `the join did not grant its creator admin: ${JSON.stringify(rights)}`);
  });
});

describe('without createSpaces, both doors refuse in the same sentence', () => {
  it('and nothing is created', async () => {
    const rest = await post(INSTANCES.a, nonCreator, '/api/spaces', { id: REFUSED, label: REFUSED });
    assert.equal(rest.status, 403, `${rest.status} ${JSON.stringify(rest.body)}`);
    assert.match(rest.body.error, /createSpaces/, 'the refusal does not name the right that is missing');
    const mcp = await mcpAs(nonCreator);
    const r = await mcp.callTool('save_space', { id: REFUSED, label: REFUSED });
    assert.ok(r?.isError);
    assert.equal(r?.content?.[0]?.text, `Error (403): ${rest.body.error}`);
    const list = await get(INSTANCES.a, admin, '/api/spaces');
    assert.ok(!(list.body.spaces ?? list.body).some(s => s.id === REFUSED), 'a refused create created the space');
  });
});
