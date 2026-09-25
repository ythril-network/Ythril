/**
 * Joining a remote network and managing its members answer the same through MCP as through REST (`F-36`, slice 4).
 *
 * The tools call the acts the routes call (`networks/join-remote-act.ts`, `networks/member-acts.ts`), so this checks
 * the outcome both ways: a join over MCP registers the network on B with the membership recorded as that token's,
 * as the REST join does; the refusal for a token short on the space is the same sentence; a member added over MCP
 * comes back in the shape REST returns, with no credential in it; a vote-governed network answers `202` on both;
 * and a removal and an unknown member answer alike.
 *
 * Run: node --test testing/integration/a-network-join-and-its-members-answer-the-same-on-both-doors.test.js
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
const SPACE = `f364-${RUN}`;
const FOUR = (r) => ({ knowledge: r, files: r, schema: r, dataQuality: r });

let adminA, adminB, mcpA;
const cleanup = { a: [], b: [] };
const sessions = [];

before(async () => {
  adminA = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
  adminB = fs.readFileSync(path.join(CONFIGS, 'b', 'token.txt'), 'utf8').trim();
  for (const [inst, tok] of [[INSTANCES.a, adminA], [INSTANCES.b, adminB]]) {
    const r = await post(inst, tok, '/api/spaces', { id: SPACE, label: SPACE });
    assert.equal(r.status, 201, JSON.stringify(r.body));
  }
  mcpA = await openMcpSession(adminA);
  sessions.push(mcpA);
});

after(async () => {
  for (const s of sessions) await s?.close?.();
  for (const id of cleanup.a) await del(INSTANCES.a, adminA, `/api/networks/${id}`).catch(() => {});
  for (const id of cleanup.b) await del(INSTANCES.b, adminB, `/api/networks/${id}`).catch(() => {});
  await delWithBody(INSTANCES.a, adminA, `/api/spaces/${SPACE}`, { confirm: true }).catch(() => {});
  await delWithBody(INSTANCES.b, adminB, `/api/spaces/${SPACE}`, { confirm: true }).catch(() => {});
});

const tool = async (session, name, args) => {
  const r = await session.callTool(name, args);
  return { isError: !!r?.isError, body: r?.structuredContent ?? {}, text: r?.content?.[0]?.text ?? '' };
};

async function mintOnB(name, perSpaceRights) {
  const r = await post(INSTANCES.b, adminB, '/api/tokens', { name: `${name}-${RUN}`,
    rights: { instanceAdmin: false, createSpaces: false, floor: null, perSpace: { [SPACE]: perSpaceRights } } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { token: r.body.plaintext, id: r.body.token.id };
}

async function network(type) {
  const n = await post(INSTANCES.a, adminA, '/api/networks', { label: `f364-${type}-${RUN}-${cleanup.a.length}`, type, spaces: [SPACE], votingDeadlineHours: 1 });
  assert.equal(n.status, 201, JSON.stringify(n.body));
  cleanup.a.push(n.body.id);
  return n.body.id;
}

/** A closed network on A and an invite bundle for it, as B reaches A over the Docker network. */
async function invite() {
  const networkId = await network('closed');
  const gen = await post(INSTANCES.a, adminA, '/api/invite/generate', { networkId });
  assert.equal(gen.status, 201, JSON.stringify(gen.body));
  return { handshakeId: gen.body.handshakeId, inviteUrl: 'http://ythril-a:3200/api/invite/apply',
    rsaPublicKeyPem: gen.body.rsaPublicKeyPem, networkId, myUrl: 'http://ythril-b:3200' };
}

describe('joining a remote network through MCP and through REST', () => {
  it('network_join_remote joins as POST /join-remote does, and records the membership as the token\'s', async () => {
    const writer = await mintOnB('f364-writer', { ...FOUR('none'), networks: 'write' });
    const mcpB = await openMcpSession(writer.token);
    sessions.push(mcpB);

    const restBundle = await invite();
    const rest = await post(INSTANCES.b, writer.token, '/api/networks/join-remote', restBundle);
    assert.equal(rest.status, 200, JSON.stringify(rest.body));
    cleanup.b.push(restBundle.networkId);

    const mcpBundle = await invite();
    const viaMcp = await tool(mcpB, 'network_join_remote', mcpBundle);
    assert.equal(viaMcp.isError, false, viaMcp.text);
    cleanup.b.push(mcpBundle.networkId);

    assert.deepEqual(Object.keys(viaMcp.body).sort(), Object.keys(rest.body).sort());
    assert.deepEqual(viaMcp.body.existingSpaces, [SPACE]);
    const onB = await get(INSTANCES.b, adminB, `/api/networks/${mcpBundle.networkId}`);
    assert.equal(onB.status, 200, JSON.stringify(onB.body));
    assert.equal(onB.body.spaceOrigins?.[SPACE], writer.id, 'the leave rule needs to know whose membership this is');
  });

  it('a token short on the space is refused with the same sentence on both doors, and nothing is registered', async () => {
    const reader = await mintOnB('f364-reader', { ...FOUR('write'), networks: 'read' });
    const mcpB = await openMcpSession(reader.token);
    sessions.push(mcpB);

    const restBundle = await invite();
    const rest = await post(INSTANCES.b, reader.token, '/api/networks/join-remote', restBundle);
    assert.equal(rest.status, 403, JSON.stringify(rest.body));

    const mcpBundle = await invite();
    assert.equal((await tool(mcpB, 'network_join_remote', mcpBundle)).text, `Error (403): ${rest.body.error}`);
    assert.equal((await get(INSTANCES.b, adminB, `/api/networks/${mcpBundle.networkId}`)).status, 404,
      'a refused join left the network registered on B');
  });
});

describe('a network\'s members through MCP and through REST', () => {
  const member = (tag) => ({ instanceId: `f364-${tag}-${RUN}`, label: `f364 ${tag}`, url: 'https://peer.example.com',
    token: `ythril_f364_${tag}_${RUN}` });

  it('network_member_add adds the member POST /members adds, with no credential in the answer', async () => {
    const club = await network('club');
    const rest = await post(INSTANCES.a, adminA, `/api/networks/${club}/members`, member('rest'));
    const viaMcp = await tool(mcpA, 'network_member_add', { id: club, ...member('mcp') });
    assert.equal(rest.status, 201, JSON.stringify(rest.body));
    assert.equal(viaMcp.isError, false, viaMcp.text);
    assert.deepEqual(Object.keys(viaMcp.body).sort(), Object.keys(rest.body).sort());
    for (const k of ['tokenHash', 'token', 'skipTlsVerify']) assert.ok(!(k in viaMcp.body), `${k} leaked`);

    const dup = await post(INSTANCES.a, adminA, `/api/networks/${club}/members`, member('rest'));
    assert.equal(dup.status, 409, JSON.stringify(dup.body));
    assert.equal((await tool(mcpA, 'network_member_add', { id: club, ...member('mcp') })).text, `Error (409): ${dup.body.error}`);
  });

  it('on a closed network both doors open a vote rather than adding', async () => {
    const closed = await network('closed');
    const rest = await post(INSTANCES.a, adminA, `/api/networks/${closed}/members`, member('vrest'));
    const viaMcp = await tool(mcpA, 'network_member_add', { id: closed, ...member('vmcp') });
    assert.equal(rest.status, 202, JSON.stringify(rest.body));
    assert.equal(viaMcp.isError, false, viaMcp.text);
    assert.equal(viaMcp.body.status, 'vote_pending');
    assert.equal(viaMcp.body.status, rest.body.status);
  });

  it('network_member_remove removes as DELETE /members/:instanceId does, and an unknown member answers alike', async () => {
    const club = await network('club');
    for (const tag of ['rrest', 'rmcp']) assert.equal((await post(INSTANCES.a, adminA, `/api/networks/${club}/members`, member(tag))).status, 201);
    assert.equal((await del(INSTANCES.a, adminA, `/api/networks/${club}/members/${member('rrest').instanceId}`)).status, 204);
    const viaMcp = await tool(mcpA, 'network_member_remove', { id: club, instanceId: member('rmcp').instanceId });
    assert.equal(viaMcp.isError, false, viaMcp.text);
    const net = await get(INSTANCES.a, adminA, `/api/networks/${club}`);
    assert.deepEqual(net.body.members.map(m => m.instanceId), [], 'both removals took effect');

    const rest = await del(INSTANCES.a, adminA, `/api/networks/${club}/members/nobody-${RUN}`);
    assert.equal(rest.status, 404, JSON.stringify(rest.body));
    assert.equal((await tool(mcpA, 'network_member_remove', { id: club, instanceId: `nobody-${RUN}` })).text, `Error (404): ${rest.body.error}`);
  });
});
