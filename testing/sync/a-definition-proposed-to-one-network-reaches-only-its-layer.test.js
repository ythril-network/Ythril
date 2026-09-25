/**
 * A schema definition can be proposed to ONE network, and it lands in that network's layer and nowhere else
 * (`F-39.5`). The owner's rule for a space in two networks: *"a combined result or change can be proposed manually
 * tho (vote)"*.
 *
 * A organises two club networks carrying the same space; B is a member of the first. Proposing to the first opens
 * a round there only — the second network sees nothing — and, passed on the organiser's yes, becomes the first
 * network's layer on A AND on B, while A's own definitions stay as they were: the network decided it, so it belongs
 * to the network. Same parameter and refusals on `PATCH /api/spaces/:id` and MCP `schema_update`.
 *
 * Run: node --test testing/sync/a-definition-proposed-to-one-network-reaches-only-its-layer.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'url';
import { INSTANCES, post, patch, get, del, delWithBody, triggerSync, waitFor } from './helpers.js';
import { openMcpSession } from './mcp-session.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIGS = path.join(__dirname, 'configs');
const RUN = Date.now();
const SPACE = `f395-${RUN}`;
const token = (x) => fs.readFileSync(path.join(CONFIGS, x, 'token.txt'), 'utf8').trim();
const thing = (name, type) => ({ typeSchemas: { entity: { [name]: { propertySchemas: { x: { type } } } } } });

let tA, tB, mcp;
const nets = {};

before(async () => {
  [tA, tB] = ['a', 'b'].map(token);
  assert.equal((await post(INSTANCES.a, tA, '/api/spaces', { id: SPACE, label: SPACE })).status, 201);
  for (const k of ['one', 'two']) {
    const n = await post(INSTANCES.a, tA, '/api/networks', { label: `f395-${k}-${RUN}`, type: 'club', spaces: [SPACE] });
    assert.equal(n.status, 201, JSON.stringify(n.body));
    nets[k] = n.body.id;
  }
  const inv = await post(INSTANCES.a, tA, '/api/invite/generate', { networkId: nets.one });
  assert.equal(inv.status, 201, JSON.stringify(inv.body));
  const j = await post(INSTANCES.b, tB, '/api/networks/join-remote', {
    handshakeId: inv.body.handshakeId, inviteUrl: 'http://ythril-a:3200/api/invite/apply', rsaPublicKeyPem: inv.body.rsaPublicKeyPem,
    networkId: nets.one, myUrl: 'http://ythril-b:3200',
  });
  assert.equal(j.status, 200, JSON.stringify(j.body));
  mcp = await openMcpSession(tA);
});

after(async () => {
  await mcp?.close?.();
  for (const [base, tok] of [[INSTANCES.a, tA], [INSTANCES.b, tB]]) {
    for (const id of Object.values(nets)) await del(base, tok, `/api/networks/${id}`).catch(() => {});
    await delWithBody(base, tok, `/api/spaces/${SPACE}`, { confirm: true }).catch(() => {});
  }
});

const tool = async (name, args) => {
  const r = await mcp.callTool(name, args);
  return { isError: !!r?.isError, body: r?.structuredContent ?? {}, text: r?.content?.[0]?.text ?? '' };
};
const layers = async (base, tok) => (await get(base, tok, `/api/spaces/${SPACE}/schema-layers`)).body;
const layerOf = (view, networkId) => view?.layers?.find(l => l.networkId === networkId)?.meta?.typeSchemas?.entity ?? {};

describe('proposing a definition to one network', () => {
  it('PATCH with targetNetwork lands in that network\'s layer on the proposer, not in its own definitions', async () => {
    const r = await patch(INSTANCES.a, tA, `/api/spaces/${SPACE}`, { targetNetwork: nets.one, meta: thing('gadget', 'string') });
    assert.ok(r.status === 200 || r.status === 202, `${r.status} ${JSON.stringify(r.body)}`);
    const view = await layers(INSTANCES.a, tA);
    assert.deepEqual(layerOf(view, nets.one).gadget?.propertySchemas?.x, { type: 'string' });
    assert.equal(view.own?.typeSchemas?.entity?.gadget, undefined, 'the proposal must not become the proposer\'s own definition');
    const meta = (await get(INSTANCES.a, tA, `/api/spaces/${SPACE}/meta`)).body;
    assert.ok(meta.typeSchemas?.entity?.gadget, 'the space enforces the layer it now holds');
  });

  it('the other network carrying the space sees no round and gets no layer', async () => {
    const view = await layers(INSTANCES.a, tA);
    assert.equal(layerOf(view, nets.two).gadget, undefined);
    // The network as a whole, concluded rounds included: an organiser's own yes concludes a club round at once.
    const two = (await get(INSTANCES.a, tA, `/api/networks/${nets.two}`)).body;
    assert.ok(Array.isArray(two.pendingRounds), `no round list on the network: ${JSON.stringify(two)}`);
    assert.ok(!JSON.stringify(two.pendingRounds).includes('gadget'), `a round reached the other network: ${JSON.stringify(two.pendingRounds)}`);
  });

  it('a member of that network receives it as the network\'s layer', async () => {
    await waitFor(async () => {
      await triggerSync(INSTANCES.b, tB, nets.one).catch(() => {});
      return !!layerOf(await layers(INSTANCES.b, tB), nets.one).gadget;
    }, 45_000, 2_000);
    const meta = (await get(INSTANCES.b, tB, `/api/spaces/${SPACE}/meta`)).body;
    assert.deepEqual(meta.typeSchemas?.entity?.gadget?.propertySchemas?.x, { type: 'string' });
  });

  it('schema_update with targetNetwork does the same', async () => {
    const r = await tool('schema_update', { space: SPACE, targetNetwork: nets.one, ...thing('widget', 'number') });
    assert.equal(r.isError, false, r.text);
    const view = await layers(INSTANCES.a, tA);
    assert.deepEqual(layerOf(view, nets.one).widget?.propertySchemas?.x, { type: 'number' });
    assert.ok(layerOf(view, nets.one).gadget, 'a merge proposal keeps the layer\'s other types');
    assert.equal(view.own?.typeSchemas?.entity?.widget, undefined);
  });
});

describe('what a proposal to one network refuses, alike on both doors', () => {
  it('a network that does not carry the space', async () => {
    const stray = '99999999-9999-4999-8999-999999999999';
    const rest = await patch(INSTANCES.a, tA, `/api/spaces/${SPACE}`, { targetNetwork: stray, meta: thing('stray', 'string') });
    assert.equal(rest.status, 400, JSON.stringify(rest.body));
    assert.equal((await tool('schema_update', { space: SPACE, targetNetwork: stray, ...thing('stray', 'string') })).text,
      `Error (400): ${rest.body.error}`);
  });

  it('anything but the meta to propose, because a label or a quota is not the network\'s to vote on', async () => {
    const rest = await patch(INSTANCES.a, tA, `/api/spaces/${SPACE}`, { targetNetwork: nets.one, label: 'renamed', meta: thing('odd', 'string') });
    assert.equal(rest.status, 400, JSON.stringify(rest.body));
    assert.match(rest.body.error, /label/);
    assert.notEqual((await get(INSTANCES.a, tA, `/api/spaces/${SPACE}`)).body?.label, 'renamed', 'the refused body was partly applied');
  });
});
