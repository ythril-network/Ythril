/**
 * `tools/list` offers the caller's own views to read tools only, the one-space fill counts spaces only, the validator cache holds
 * for a reach with `@` ids, and a client is told when its tool list changed (Q-531, bundle-100, plan rev 3.1 "`@` ids on the
 * doors"; rev 3.2 "Doors and answers", the performance vet P1 and the integration vet 3).
 *
 * ## The rules
 *
 * 1. **Two enums.** Every tool whose `inputSchema` has a `space` property is classified from `TOOL_RIGHTS` (never from the enum it is
 *    being tested for): a read outside the schema area offers the caller's own view ids in `space`'s enum, every other tool (write,
 *    admin, schema) does not. Another token's view is in neither.
 * 2. **The one-space fill counts spaces.** A token that reaches exactly one SPACE and owns a view over it is still filled in: `space`
 *    is not required on a read tool or a write tool, and a call without it reads and writes that space (not the view).
 * 3. **The validator cache holds for `@` ids, and its key tells the two enums apart.** A token owning a view gets a cache HIT on its
 *    second call (`ythril_tool_validator_cache_total{result="hit"}`), not the uncached path an `@` id takes today; and a token that
 *    reaches the same spaces with no view gets its OWN entry (a MISS), whose read enum has no `@` id. Keyed on the spaces alone,
 *    the second token would be handed the first one's validator and its views.
 * 4. **The list is announced as changing.** `initialize` advertises `capabilities.tools.listChanged: true`, the instructions name the
 *    caller's views, and the answer to `view_create` and to `view_delete` carries `notifications/tools/list_changed`.
 *
 * ## Seen red at 18e8d598
 *
 * `POST /api/views` answers 404 and MCP `view_create` "Unknown tool", so every case fails at its create. Behind it: one enum for every
 * tool (no `@` id anywhere), `reachKey` refusing an `@` id (uncached, so no hit), and `capabilities: { tools: {} }`.
 *
 * Run: a Mongo the harness accepts (see `_mongo-harness.mjs`), npm run build:server, then
 *      node --test testing/standalone/tools-list-offers-a-view-to-read-tools-only-db.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openViewDoors, viewOf, rowsOf, viewMembersOf } from './_view-doors.mjs';

const skip = await mongoSkipReason();
const QA = 'vt-qa';
const OPS = 'vt-ops';
const SOLO = 'vt-solo';
const C1 = 'vt-cache-a';
const C2 = 'vt-cache-b';
const LIST_CHANGED = 'notifications/tools/list_changed';

let d, admin, TOOL_RIGHTS, register;
const fmt = (a) => `${a.status} ${(a.text ?? '').slice(0, 200)}`;

async function mustCreate(key, name, members) {
  const a = await d.rest(key, 'POST', '/api/views', { name, members });
  assert.equal(a.status, 201, `POST /api/views {name: '${name}'} answered ${fmt(a)}`);
  assert.equal(viewOf(a)?.id, `@${name}`);
}

/** Every enum value anywhere inside a property schema (`enum`, `oneOf`, `items`). */
function enumValues(schema, out = new Set()) {
  if (!schema || typeof schema !== 'object') return out;
  if (Array.isArray(schema.enum)) for (const v of schema.enum) out.add(v);
  for (const k of ['oneOf', 'anyOf', 'allOf']) for (const s of schema[k] ?? []) enumValues(s, out);
  if (schema.items) enumValues(schema.items, out);
  return out;
}

async function toolsOf(key) {
  const r = await d.rpc(key, 'tools/list');
  const tools = r.result?.result?.tools;
  assert.ok(Array.isArray(tools) && tools.length > 10, `tools/list answered ${JSON.stringify(r.result).slice(0, 200)}`);
  return tools;
}

/** A read tool takes a view: TOOL_RIGHTS says read, outside the schema area (`read_spill` names no space). */
const takesAView = (name) => TOOL_RIGHTS.some(r => r.tool === name && r.needs === 'read' && r.area !== 'schema' && r.tool !== 'read_spill');

async function cacheCounts() {
  const text = await register.getSingleMetricAsString('ythril_tool_validator_cache_total');
  const n = (result) => Number(new RegExp(`result="${result}"[^}]*} (\\d+)`).exec(text)?.[1] ?? 0);
  return { hit: n('hit'), miss: n('miss') };
}

describe('tools/list and the views of the caller (Q-531)', { skip }, () => {
  before(async () => {
    d = await openViewDoors({ suite: 'q531-view-tools-list', spaces: [QA, OPS, SOLO, C1, C2] });
    ({ TOOL_RIGHTS } = await import('../../server/dist/auth/space-rights.js'));
    ({ register } = await import('../../server/dist/metrics/registry.js'));
    admin = await d.mint('vt-admin', {}, { admin: true });
  });
  after(async () => { await d?.close(); });

  it('read tools offer the caller\'s own views in `space`; write, admin and schema tools never do; another\'s view is in neither', async () => {
    const both = { [QA]: d.row({ knowledge: 'write', files: 'write' }), [OPS]: d.row({ knowledge: 'write', files: 'write' }) };
    const owner = await d.mint('vt-owner', both);
    const other = await d.mint('vt-other', both);
    await mustCreate(owner.key, 'lens', [QA, OPS]);
    await mustCreate(other.key, 'theirs', [QA]);
    const tools = (await toolsOf(owner.key)).filter(t => t.inputSchema?.properties?.space);
    const reads = tools.filter(t => takesAView(t.name));
    const others = tools.filter(t => !takesAView(t.name));
    assert.ok(reads.length >= 8 && others.length >= 15, `derived ${reads.length} read and ${others.length} other tool(s) taking space: the derivation is broken`);
    const readsWithout = reads.filter(t => !enumValues(t.inputSchema.properties.space).has('@lens')).map(t => t.name);
    const othersWith = others.filter(t => enumValues(t.inputSchema.properties.space).has('@lens')).map(t => t.name);
    const anyTheirs = tools.filter(t => enumValues(t.inputSchema.properties.space).has('@theirs')).map(t => t.name);
    assert.deepEqual(readsWithout, [], 'read tools that do not offer the caller\'s own view');
    assert.deepEqual(othersWith, [], 'write/admin/schema tools that advertise a view');
    assert.deepEqual(anyTheirs, [], 'tools that advertise another token\'s view');
  });

  it('the one-space fill counts spaces only: a view over the one space does not make `space` required, and an omitted space is the space', async () => {
    const solo = await d.mint('vt-solo-tok', { [SOLO]: d.row({ knowledge: 'write' }) });
    await mustCreate(solo.key, 'over-solo', [SOLO]);
    const tools = await toolsOf(solo.key);
    const required = (name) => (tools.find(t => t.name === name)?.inputSchema?.required ?? []).includes('space');
    assert.deepEqual(['space_stats', 'save_entity', 'filter'].filter(required), [], 'tools that require `space` for a token reaching one space');
    const saved = await d.mcp(solo.key, 'save_entity', { name: 'vt-filled', type: 'thing' });
    assert.ok(!saved.isError, `save_entity without space: ${saved.text}`);
    const read = await d.mcp(solo.key, 'filter', { collection: 'entities', filter: { name: 'vt-filled' } });
    assert.equal(rowsOf(read).length, 1, `filter without space did not read the one space: ${read.text.slice(0, 200)}`);
    assert.equal(viewMembersOf(read), undefined, 'a call without space was answered as a read through the view');
  });

  it('the validator cache hits for a reach with `@` ids, and a reach of the same spaces without the view gets its own entry', async () => {
    const rights = { [C1]: d.row({ knowledge: 'read' }), [C2]: d.row({ knowledge: 'read' }) };
    const withView = await d.mint('vt-cache-view', rights);
    const plain = await d.mint('vt-cache-plain', rights);
    await mustCreate(withView.key, 'cached', [C1, C2]);
    const call = (key, space) => d.mcp(key, 'filter', { space, collection: 'entities', filter: {} });
    const first = await call(withView.key, '@cached');
    assert.ok(!first.isError, `control: the owner's read through the view: ${first.text.slice(0, 200)}`);
    const c0 = await cacheCounts();
    await call(withView.key, '@cached');
    const c1 = await cacheCounts();
    assert.ok(c1.hit > c0.hit && c1.miss === c0.miss, `the second call of a reach with an @ id was not served from the cache: ${JSON.stringify({ c0, c1 })}`);
    await call(plain.key, C1);
    const c2 = await cacheCounts();
    assert.ok(c2.miss > c1.miss, `a reach of the same spaces without the view was served the owner's entry: ${JSON.stringify({ c1, c2 })}`);
    const plainFilter = (await toolsOf(plain.key)).find(t => t.name === 'filter');
    assert.ok(!enumValues(plainFilter.inputSchema.properties.space).has('@cached'), 'the plain token\'s read enum carries the owner\'s view');
    const refused = await call(plain.key, '@cached');
    assert.ok(refused.isError, 'a token without the view read through it');
  });

  it('initialize advertises listChanged and names the views; view_create and view_delete notify the list changed', async () => {
    const t = await d.mint('vt-notify', { [QA]: d.row({ knowledge: 'read' }) });
    const created = await d.rpc(t.key, 'tools/call', { name: 'view_create', arguments: { name: 'noted', members: [QA] } });
    assert.ok(created.result && !created.result.result?.isError, `view_create: ${JSON.stringify(created.result).slice(0, 200)}`);
    assert.ok(created.messages.some(m => m.method === LIST_CHANGED), `view_create's answer carried no ${LIST_CHANGED}: ${JSON.stringify(created.messages.map(m => m.method ?? `id ${m.id}`))}`);
    const init = await d.rpc(t.key, 'initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'vt', version: '1' } });
    assert.equal(init.result?.result?.capabilities?.tools?.listChanged, true, `capabilities: ${JSON.stringify(init.result?.result?.capabilities)}`);
    assert.match(init.result?.result?.instructions ?? '', /@noted/, 'the instructions do not name the caller\'s view');
    const deleted = await d.rpc(t.key, 'tools/call', { name: 'view_delete', arguments: { view: '@noted' } });
    assert.ok(deleted.result && !deleted.result.result?.isError, `view_delete: ${JSON.stringify(deleted.result).slice(0, 200)}`);
    assert.ok(deleted.messages.some(m => m.method === LIST_CHANGED), `view_delete's answer carried no ${LIST_CHANGED}`);
  });
});
