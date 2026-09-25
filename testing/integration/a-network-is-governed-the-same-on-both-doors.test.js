/**
 * Reading, creating, updating and leaving a network through MCP answers exactly as REST does (`F-36`, slice 1).
 *
 * Governing a network was REST-only, and the project rule is that a capability exists on both doors with the same
 * parameters, refusals and answers. The tools call the acts the routes call (`networks/network-acts.ts`), so this
 * checks the OUTCOME both ways: the same body, the same refusal sentence for a token short on one space, the same
 * "not found" for a network a token may not see, and a leave that actually removes the network.
 *
 * Run: node --test testing/integration/a-network-is-governed-the-same-on-both-doors.test.js
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
const MINE = `f36-mine-${RUN}`;
const OTHER = `f36-other-${RUN}`;
const FOUR = (r) => ({ knowledge: r, files: r, schema: r, dataQuality: r });

let admin, adminMcp, shortToken, shortMcp;
const created = [];

before(async () => {
  admin = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
  for (const id of [MINE, OTHER]) {
    const r = await post(INSTANCES.a, admin, '/api/spaces', { id, label: id });
    assert.equal(r.status, 201, JSON.stringify(r.body));
  }
  // Networks rungs on MINE only: may create with MINE, is short on OTHER, may not see a network carrying OTHER.
  const t = await post(INSTANCES.a, admin, '/api/tokens', { name: `f36-short-${RUN}`, rights: {
    instanceAdmin: false, createSpaces: false, floor: null,
    perSpace: { [MINE]: { ...FOUR('write'), networks: 'admin' } } } });
  assert.equal(t.status, 201, JSON.stringify(t.body));
  shortToken = t.body.plaintext;
  adminMcp = await openMcpSession(admin);
  shortMcp = await openMcpSession(shortToken);
});

after(async () => {
  await adminMcp?.close?.(); await shortMcp?.close?.();
  for (const id of created) await del(INSTANCES.a, admin, `/api/networks/${id}`).catch(() => {});
  for (const id of [MINE, OTHER]) await delWithBody(INSTANCES.a, admin, `/api/spaces/${id}`, { confirm: true }).catch(() => {});
});

const tool = async (mcp, name, args) => {
  const r = await mcp.callTool(name, args);
  return { isError: !!r?.isError, body: r?.structuredContent ?? {}, text: r?.content?.[0]?.text ?? '' };
};
/** Two bodies that describe the same network, compared on what can differ between doors: everything but timing. */
const same = (a, b) => assert.deepEqual({ ...a, members: a.members?.length }, { ...b, members: b.members?.length });

describe('a network through MCP and through REST', () => {
  let viaMcpId;

  it('network_create creates what POST /api/networks creates', async () => {
    const r = await tool(shortMcp, 'network_create', { label: `f36-${RUN}`, type: 'club', spaces: [MINE] });
    assert.equal(r.isError, false, r.text);
    viaMcpId = r.body.id;
    created.push(viaMcpId);
    const rest = await get(INSTANCES.a, shortToken, `/api/networks/${viaMcpId}`);
    assert.equal(rest.status, 200, JSON.stringify(rest.body));
    same(r.body, rest.body);
  });

  it('network_get answers what GET /api/networks/:id answers, credentials stripped on both', async () => {
    const r = await tool(shortMcp, 'network_get', { id: viaMcpId });
    const rest = await get(INSTANCES.a, shortToken, `/api/networks/${viaMcpId}`);
    same(r.body, rest.body);
    assert.ok(!('inviteKeyHash' in r.body), 'the invite-key hash must never leave the instance');
  });

  it('a create short on one space is refused with the same sentence on both doors', async () => {
    const args = { label: `f36-short-${RUN}`, type: 'club', spaces: [MINE, OTHER] };
    const r = await tool(shortMcp, 'network_create', args);
    const rest = await post(INSTANCES.a, shortToken, '/api/networks', args);
    assert.equal(rest.status, 403, JSON.stringify(rest.body));
    assert.equal(r.isError, true);
    assert.equal(r.text, `Error (403): ${rest.body.error}`, 'the refusal differs between the doors');
    assert.match(r.text, new RegExp(OTHER));
  });

  it('a network the token may not see is "not found" on both doors', async () => {
    const n = await post(INSTANCES.a, admin, '/api/networks', { label: `f36-hidden-${RUN}`, type: 'club', spaces: [OTHER] });
    assert.equal(n.status, 201, JSON.stringify(n.body));
    created.push(n.body.id);
    const r = await tool(shortMcp, 'network_get', { id: n.body.id });
    assert.match(r.text, /Error \(404\)/);
    assert.equal((await get(INSTANCES.a, shortToken, `/api/networks/${n.body.id}`)).status, 404);
  });

  it('network_update changes the settings, and an unrunnable schedule is refused as on REST', async () => {
    const ok = await tool(shortMcp, 'network_update', { id: viaMcpId, label: `f36-renamed-${RUN}` });
    assert.equal(ok.isError, false, ok.text);
    assert.equal((await get(INSTANCES.a, admin, `/api/networks/${viaMcpId}`)).body.label, `f36-renamed-${RUN}`);
    const bad = await tool(shortMcp, 'network_update', { id: viaMcpId, syncSchedule: 'every tuesday' });
    const rest = await (await fetch(`${INSTANCES.a}/api/networks/${viaMcpId}`, {
      method: 'PATCH', headers: { Authorization: `Bearer ${shortToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ syncSchedule: 'every tuesday' }),
    })).json();
    assert.equal(bad.text, `Error (400): ${rest.error}`);
  });

  it('network_leave removes the network, as DELETE does', async () => {
    const r = await tool(shortMcp, 'network_leave', { id: viaMcpId });
    assert.equal(r.isError, false, r.text);
    assert.equal((await get(INSTANCES.a, admin, `/api/networks/${viaMcpId}`)).status, 404);
  });
});
