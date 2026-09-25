/**
 * A space in two networks shows its layers and clashes, and the operator can reorder which network wins — on REST
 * and on MCP alike (`F-39.3`).
 *
 * B and C each publish the same space and define `person.tier` differently; A joins B first, so B wins. The view
 * must say so, and reordering must flip what the space enforces.
 *
 * Run: node --test testing/sync/a-schema-clash-is-seen-and-reordered-on-both-doors.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'url';
import { INSTANCES, post, patch, get, put, del, delWithBody, triggerSync, waitFor } from './helpers.js';
import { openMcpSession } from './mcp-session.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIGS = path.join(__dirname, 'configs');
const RUN = Date.now();
const SPACE = `f393-${RUN}`;
const token = (x) => fs.readFileSync(path.join(CONFIGS, x, 'token.txt'), 'utf8').trim();
const person = (props) => ({ typeSchemas: { entity: { person: { propertySchemas: props } } } });

let tA, tB, tC, mcp;
const nets = {};

async function publish(base, tok, host, props) {
  assert.equal((await post(base, tok, '/api/spaces', { id: SPACE, label: SPACE })).status, 201);
  assert.ok((await patch(base, tok, `/api/spaces/${SPACE}`, { meta: person(props) })).status < 300);
  const n = await post(base, tok, '/api/networks', { label: `f393-${host}-${RUN}`, type: 'pubsub', spaces: [SPACE] });
  assert.equal(n.status, 201, JSON.stringify(n.body));
  const inv = await post(base, tok, '/api/invite/generate', { networkId: n.body.id });
  const j = await post(INSTANCES.a, tA, '/api/networks/join-remote', {
    handshakeId: inv.body.handshakeId, inviteUrl: `http://${host}:3200/api/invite/apply`, rsaPublicKeyPem: inv.body.rsaPublicKeyPem,
    networkId: n.body.id, myUrl: 'http://ythril-a:3200',
  });
  assert.equal(j.status, 200, JSON.stringify(j.body));
  return n.body.id;
}

before(async () => {
  [tA, tB, tC] = ['a', 'b', 'c'].map(token);
  nets.b = await publish(INSTANCES.b, tB, 'ythril-b', { tier: { type: 'number' } });
  nets.c = await publish(INSTANCES.c, tC, 'ythril-c', { tier: { type: 'string' } });
  await waitFor(async () => {
    for (const id of Object.values(nets)) await triggerSync(INSTANCES.a, tA, id).catch(() => {});
    return (await get(INSTANCES.a, tA, `/api/spaces/${SPACE}/schema-layers`)).body?.layers?.length === 2;
  }, 45_000, 2_000);
  mcp = await openMcpSession(tA);
});

after(async () => {
  await mcp?.close?.();
  for (const [base, tok] of [[INSTANCES.a, tA], [INSTANCES.b, tB], [INSTANCES.c, tC]]) {
    for (const id of Object.values(nets)) await del(base, tok, `/api/networks/${id}`).catch(() => {});
    await delWithBody(base, tok, `/api/spaces/${SPACE}`, { confirm: true }).catch(() => {});
  }
});

const tool = async (name, args) => {
  const r = await mcp.callTool(name, args);
  return { isError: !!r?.isError, body: r?.structuredContent ?? {}, text: r?.content?.[0]?.text ?? '' };
};
const tierOnA = async () => (await get(INSTANCES.a, tA, `/api/spaces/${SPACE}/meta`)).body?.typeSchemas?.entity?.person?.propertySchemas?.tier?.type;

describe('seeing a clash', () => {
  it('the layers are listed in precedence, the first joined first, with the clash naming who wins', async () => {
    const r = await get(INSTANCES.a, tA, `/api/spaces/${SPACE}/schema-layers`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.precedence, [nets.b, nets.c]);
    const tier = r.body.clashes.find(c => c.property === 'tier');
    assert.ok(tier, `the tier clash is not listed: ${JSON.stringify(r.body.clashes)}`);
    assert.equal(tier.values[0].networkId, nets.b, 'the winning network must be listed first');
  });

  it('space_schema_layers answers what the route answers', async () => {
    const rest = await get(INSTANCES.a, tA, `/api/spaces/${SPACE}/schema-layers`);
    const viaMcp = await tool('space_schema_layers', { space: SPACE });
    assert.equal(viaMcp.isError, false, viaMcp.text);
    assert.deepEqual(viaMcp.body, rest.body);
  });
});

describe('reordering', () => {
  it('PUT network-precedence flips which definition the space enforces', async () => {
    assert.equal(await tierOnA(), 'number');
    const r = await put(INSTANCES.a, tA, `/api/spaces/${SPACE}/network-precedence`, { networks: [nets.c, nets.b] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.precedence, [nets.c, nets.b]);
    assert.equal(await tierOnA(), 'string');
  });

  it('space_set_network_precedence flips it back', async () => {
    const r = await tool('space_set_network_precedence', { space: SPACE, networks: [nets.b] });
    assert.equal(r.isError, false, r.text);
    assert.equal(await tierOnA(), 'number');
  });

  it('a network that does not carry the space is refused with the same sentence on both doors', async () => {
    const stray = '99999999-9999-4999-8999-999999999999';
    const rest = await put(INSTANCES.a, tA, `/api/spaces/${SPACE}/network-precedence`, { networks: [stray] });
    assert.equal(rest.status, 400, JSON.stringify(rest.body));
    assert.equal((await tool('space_set_network_precedence', { space: SPACE, networks: [stray] })).text, `Error (400): ${rest.body.error}`);
  });
});
