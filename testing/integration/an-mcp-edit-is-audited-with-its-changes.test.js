/**
 * An edit made through MCP leaves an audit entry with the same change list as the same edit through REST (`Q-50`).
 *
 * The REST route hands the audit middleware a before/after pair; the MCP entry used to carry the operation alone,
 * so a compliance reader could see THAT a fact was edited on one door and WHAT changed only on the other. This
 * edits one fact through each door and compares the two entries' `changes`, found by the record id both now carry.
 *
 * Run: node --test testing/integration/an-mcp-edit-is-audited-with-its-changes.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'url';
import { INSTANCES, post, patch, get, del } from '../sync/helpers.js';
import { openMcpSession } from '../sync/mcp-session.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIGS = path.join(__dirname, '..', 'sync', 'configs');
const RUN = Date.now();

let admin, mcp, factId;

before(async () => {
  admin = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
  const f = await post(INSTANCES.a, admin, '/api/brain/spaces/general/facts', { fact: `q50 original ${RUN}` });
  assert.ok(f.status < 300, JSON.stringify(f.body));
  factId = f.body._id ?? f.body.id ?? f.body.fact?._id;
  assert.ok(factId, `no id in ${JSON.stringify(f.body)}`);
  mcp = await openMcpSession(admin);
});

after(async () => {
  await mcp?.close?.();
  if (factId) await del(INSTANCES.a, admin, `/api/brain/spaces/general/facts/${factId}`).catch(() => {});
});

/** The newest fact.update entry for this fact written by `method` after `since`. */
async function entry(method, since) {
  for (let i = 0; i < 20; i++) {
    const r = await get(INSTANCES.a, admin, `/api/admin/audit-log?operation=fact.update&spaceId=general&after=${encodeURIComponent(since)}&limit=50`);
    const hit = (r.body.entries ?? []).find(e => e.method === method && e.entryId === factId);
    if (hit) return hit;
    await new Promise(res => setTimeout(res, 250));
  }
  return null;
}

describe('an MCP edit carries its change list', () => {
  it('update_fact leaves the changes PATCH leaves', async () => {
    const t0 = new Date().toISOString();
    const rest = await patch(INSTANCES.a, admin, `/api/brain/spaces/general/facts/${factId}`, { fact: `q50 via rest ${RUN}` });
    assert.ok(rest.status < 300, JSON.stringify(rest.body));
    const r = await mcp.callTool('update_fact', { space: 'general', id: factId, fact: `q50 via mcp ${RUN}` });
    assert.ok(!r?.isError, r?.content?.[0]?.text);

    const viaRest = await entry('PATCH', t0);
    const viaMcp = await entry('MCP', t0);
    assert.ok(viaRest?.changes?.length, `the REST entry carries no changes: ${JSON.stringify(viaRest)}`);
    assert.ok(viaMcp, 'no MCP entry for the edit');
    assert.deepEqual(viaMcp.changes?.find(c => c.field === 'fact'), { field: 'fact', from: `q50 via rest ${RUN}`, to: `q50 via mcp ${RUN}` },
      `the MCP entry must carry what changed: ${JSON.stringify(viaMcp)}`);
    assert.deepEqual(viaMcp.changes.map(c => c.field).sort(), viaRest.changes.map(c => c.field).sort(),
      'the two doors must record the same fields for the same edit');
  });
});
