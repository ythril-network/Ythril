/**
 * Renaming a space is one capability with two doors: the same caller, the same answer, the same refusals (`Q-139`).
 *
 * `PATCH /api/spaces/:id/rename` had no MCP twin — the route was classified as "deliberately kept off the agent
 * surface", a judgement no owner ruling stands behind, while the rule is that every capability exists on both doors
 * and the rights matrix, not the surface, decides who may use it. So an agent administering a space renames it with
 * `space_rename`, and is refused exactly where the route refuses.
 *
 * Run: node --test testing/integration/a-space-renames-on-both-doors.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'url';
import { INSTANCES, get, post, patch, del, delWithBody } from '../sync/helpers.js';
import { openMcpSession } from '../sync/mcp-session.js';
import { spaceAdminRights } from '../_shared/space-admin-rights.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIGS = path.join(__dirname, '..', 'sync', 'configs');
const RUN = Date.now();
const A = `q139-a-${RUN}`;
const A2 = `q139-a2-${RUN}`;
const B = `q139-b-${RUN}`;
const B2 = `q139-b2-${RUN}`;
const TAKEN_OLD = `q139-t-${RUN}`;
const TAKEN_NEW = `q139-t2-${RUN}`;

let admin, spaceAdmin, outsider, netId;
const sessions = [];

async function mint(name, rights) {
  const r = await post(INSTANCES.a, admin, '/api/tokens', { name: `${name}-${RUN}`, rights });
  assert.equal(r.status, 201, `mint ${name}: ${JSON.stringify(r.body)}`);
  return r.body.plaintext;
}
async function mcpAs(token) {
  const s = await openMcpSession(token);
  sessions.push(s);
  return s;
}
const structured = (r) => r?.structuredContent ?? JSON.parse(r?.content?.[0]?.text ?? 'null');

before(async () => {
  admin = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
  for (const id of [A, B, TAKEN_OLD]) {
    const r = await post(INSTANCES.a, admin, '/api/spaces', { id, label: id });
    assert.equal(r.status, 201, JSON.stringify(r.body));
  }
  // A network that still calls a renamed space TAKEN_OLD, so renaming onto that name is Q-133's 409.
  const n = await post(INSTANCES.a, admin, '/api/networks', { label: `q139-${RUN}`, type: 'pubsub', spaces: [TAKEN_OLD] });
  assert.equal(n.status, 201, JSON.stringify(n.body));
  netId = n.body.id;
  const ren = await patch(INSTANCES.a, admin, `/api/spaces/${TAKEN_OLD}/rename`, { newId: TAKEN_NEW });
  assert.equal(ren.status, 200, JSON.stringify(ren.body));

  spaceAdmin = await mint('q139-admin-of-a-and-b', spaceAdminRights([A, B]));
  // Reaches A (and so A2, once the rename moves its row) with write on every area, and administers nothing: the
  // rename must be refused by the administrator rule, not by reach, which would refuse it on any tool at all.
  const WRITE = { knowledge: 'write', files: 'write', schema: 'write', dataQuality: 'write' };
  outsider = await mint('q139-outsider', { instanceAdmin: false, createSpaces: false, floor: null, perSpace: { [A]: WRITE } });
});

after(async () => {
  for (const s of sessions) await s?.close?.();
  if (netId) await del(INSTANCES.a, admin, `/api/networks/${netId}`).catch(() => {});
  for (const id of [A, A2, B, B2, TAKEN_OLD, TAKEN_NEW]) await delWithBody(INSTANCES.a, admin, `/api/spaces/${id}`, { confirm: true }).catch(() => {});
});

describe('a space administrator renames the space on either door', () => {
  it('the tool exists and is offered to a token administering a space', async () => {
    const mcp = await mcpAs(spaceAdmin);
    const tools = await mcp.listTools();
    assert.ok(tools.some(t => t.name === 'space_rename'),
      'space_rename is not offered, so an agent cannot rename a space it administers');
  });

  it('the answer is the same on both doors, and the renamed space stays the caller\'s', async () => {
    const rest = await patch(INSTANCES.a, spaceAdmin, `/api/spaces/${A}/rename`, { newId: A2 });
    assert.equal(rest.status, 200, JSON.stringify(rest.body));

    const mcp = await mcpAs(spaceAdmin);
    const r = await mcp.callTool('space_rename', { space: B, newId: B2 });
    assert.ok(!r?.isError, `the tool refused a space administrator: ${JSON.stringify(r)}`);
    const tool = structured(r);
    assert.equal(tool?.space?.id, B2, `the tool did not answer the renamed space: ${JSON.stringify(r)}`);
    assert.deepEqual(Object.keys(tool).sort(), Object.keys(rest.body).sort(), 'the two doors answer different shapes');

    // Q-133's rename moves the caller's own grant, so the space it renamed is still one it can read.
    const read = await get(INSTANCES.a, spaceAdmin, `/api/brain/spaces/${B2}/stats`);
    assert.equal(read.status, 200, `the renamed space is no longer reachable by the token that renamed it: ${read.status}`);
  });
});

describe('the refusals are the route\'s', () => {
  it('a name another space syncs under is refused 409 space_name_in_use, in the same sentence', async () => {
    // Only a space the network carries can collide with its ids; an uncarried one never crosses the wire.
    const carried = await post(INSTANCES.a, admin, `/api/networks/${netId}/spaces`, { spaceId: A2 });
    assert.equal(carried.status, 200, JSON.stringify(carried.body));
    const mcpAdmin = await mcpAs(admin);
    const restFirst = await patch(INSTANCES.a, admin, `/api/spaces/${A2}/rename`, { newId: TAKEN_OLD });
    assert.equal(restFirst.status, 409, JSON.stringify(restFirst.body));
    assert.equal(restFirst.body.code, 'space_name_in_use');
    const r = await mcpAdmin.callTool('space_rename', { space: A2, newId: TAKEN_OLD });
    assert.ok(r?.isError, `the tool renamed onto a name the network uses: ${JSON.stringify(r)}`);
    assert.equal(r?.content?.[0]?.text, `Error (409): ${restFirst.body.error}`);
    assert.equal(r?.structuredContent?.code, 'space_name_in_use');
    // Sandwiched: the refusal did not move between the two calls.
    const restAgain = await patch(INSTANCES.a, admin, `/api/spaces/${A2}/rename`, { newId: TAKEN_OLD });
    assert.equal(restAgain.body.error, restFirst.body.error);
  });

  it('a token that does not administer the space is refused on both doors, and nothing moves', async () => {
    const rest = await patch(INSTANCES.a, outsider, `/api/spaces/${A2}/rename`, { newId: `${A2}-x` });
    assert.equal(rest.status, 403, `REST let a non-administrator rename: ${rest.status}`);
    const mcp = await mcpAs(outsider);
    const r = await mcp.callTool('space_rename', { space: A2, newId: `${A2}-x` });
    assert.ok(r?.isError, `MCP let a non-administrator rename: ${JSON.stringify(r)}`);
    // Refused by the rights check, not by the tool being absent — an absent tool refuses everybody.
    assert.doesNotMatch(r?.content?.[0]?.text ?? '', /Unknown tool/, 'the refusal is the missing tool, not the rights');
    const list = await get(INSTANCES.a, admin, '/api/spaces');
    const ids = (list.body.spaces ?? list.body).map(s => s.id);
    assert.ok(ids.includes(A2) && !ids.includes(`${A2}-x`), 'a refused rename moved the space');
  });
});
