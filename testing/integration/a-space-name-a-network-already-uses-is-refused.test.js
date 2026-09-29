/**
 * A space may not take a name a network already syncs another space under — on either door (`Q-133`).
 *
 * A rename keeps the space's old id as its network id. Creating a new local space with that old id and adding it to
 * the same network used to be accepted: the network would then announce the id twice, and every peer request for
 * it is translated to the RENAMED space (`api/sync/space-alias.ts`), so the new space never reaches anybody. Refused
 * instead, with one sentence and one code on both doors, and the same for renaming a space onto that id.
 *
 * Run: node --test testing/integration/a-space-name-a-network-already-uses-is-refused.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'url';
import { INSTANCES, post, patch, del, delWithBody } from '../sync/helpers.js';
import { openMcpSession } from '../sync/mcp-session.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIGS = path.join(__dirname, '..', 'sync', 'configs');
const RUN = Date.now();
const OLD = `q133n-old-${RUN}`;
const NEW = `q133n-new-${RUN}`;
const OTHER = `q133n-other-${RUN}`;

let admin, mcp, netId;

before(async () => {
  admin = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
  for (const id of [OLD, OTHER]) {
    const r = await post(INSTANCES.a, admin, '/api/spaces', { id, label: id });
    assert.equal(r.status, 201, JSON.stringify(r.body));
  }
  const n = await post(INSTANCES.a, admin, '/api/networks', { label: `q133n-${RUN}`, type: 'pubsub', spaces: [OLD] });
  assert.equal(n.status, 201, JSON.stringify(n.body));
  netId = n.body.id;
  const ren = await patch(INSTANCES.a, admin, `/api/spaces/${OLD}/rename`, { newId: NEW });
  assert.equal(ren.status, 200, JSON.stringify(ren.body));
  // A new local space under the id the network still uses for the renamed one.
  const again = await post(INSTANCES.a, admin, '/api/spaces', { id: OLD, label: OLD });
  assert.equal(again.status, 201, JSON.stringify(again.body));
  mcp = await openMcpSession(admin);
});

after(async () => {
  await mcp?.close?.();
  if (netId) await del(INSTANCES.a, admin, `/api/networks/${netId}`).catch(() => {});
  for (const id of [OLD, NEW, OTHER]) await delWithBody(INSTANCES.a, admin, `/api/spaces/${id}`, { confirm: true }).catch(() => {});
});

describe('the network id of a renamed space stays that space\'s', () => {
  it('adding a new space under it is refused, with one sentence and one code on both doors', async () => {
    const rest = await post(INSTANCES.a, admin, `/api/networks/${netId}/spaces`, { spaceId: OLD });
    assert.equal(rest.status, 409, `the network would announce ${OLD} twice: ${rest.status} ${JSON.stringify(rest.body)}`);
    assert.equal(rest.body.code, 'space_name_in_use');
    const r = await mcp.callTool('network_add_space', { id: netId, spaceId: OLD });
    assert.equal(r?.content?.[0]?.text, `Error (409): ${rest.body.error}`);
  });

  it('renaming another carried space onto it is refused the same way', async () => {
    const add = await post(INSTANCES.a, admin, `/api/networks/${netId}/spaces`, { spaceId: OTHER });
    assert.equal(add.status, 200, JSON.stringify(add.body));
    await delWithBody(INSTANCES.a, admin, `/api/spaces/${OLD}`, { confirm: true });
    const rest = await patch(INSTANCES.a, admin, `/api/spaces/${OTHER}/rename`, { newId: OLD });
    assert.equal(rest.status, 409, `a rename onto another space's network id was accepted: ${rest.status} ${JSON.stringify(rest.body)}`);
    assert.equal(rest.body.code, 'space_name_in_use');
  });
});
