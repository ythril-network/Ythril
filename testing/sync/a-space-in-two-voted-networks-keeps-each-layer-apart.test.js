/**
 * A space carried by two voted networks holds each network's schema in that network's layer, and neither network is
 * sent the other's definitions (`Q-966`, `F-39.2`: "nothing mixed is sent on").
 *
 * B and C each organise a club carrying a space of the same id and define `person` differently. A joins B's club, then
 * C's, both onto its one local space. Each join brings only its own network's schema, kept as that network's layer.
 *
 * Run: node --test testing/sync/a-space-in-two-voted-networks-keeps-each-layer-apart.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'url';
import { INSTANCES, post, patch, get, del, delWithBody, readContainerConfig } from './helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIGS = path.join(__dirname, 'configs');
const RUN = Date.now();
const SPACE = `q966-two-${RUN}`;
const tok = (x) => fs.readFileSync(path.join(CONFIGS, x, 'token.txt'), 'utf8').trim();
const person = (props) => ({ typeSchemas: { entity: { person: { propertySchemas: props } } } });

const T = {};
const nets = {};

async function organise(x, props) {
  const s = await post(INSTANCES[x], T[x], '/api/spaces', { id: SPACE, label: SPACE });
  assert.equal(s.status, 201, JSON.stringify(s.body));
  const m = await patch(INSTANCES[x], T[x], `/api/spaces/${SPACE}`, { meta: person(props) });
  assert.ok(m.status < 300, JSON.stringify(m.body));
  const n = await post(INSTANCES[x], T[x], '/api/networks', { label: `q966-${x}-${RUN}`, type: 'club', spaces: [SPACE] });
  assert.equal(n.status, 201, JSON.stringify(n.body));
  const inv = await post(INSTANCES[x], T[x], '/api/invite/generate', { networkId: n.body.id });
  assert.equal(inv.status, 201, JSON.stringify(inv.body));
  const j = await post(INSTANCES.a, T.a, '/api/networks/join-remote', {
    handshakeId: inv.body.handshakeId, inviteUrl: `http://ythril-${x}:3200/api/invite/apply`, rsaPublicKeyPem: inv.body.rsaPublicKeyPem,
    networkId: n.body.id, myUrl: 'http://ythril-a:3200',
  });
  assert.equal(j.status, 200, JSON.stringify(j.body));
  return n.body.id;
}

const propsOf = (meta) => meta?.typeSchemas?.entity?.person?.propertySchemas ?? {};

before(async () => {
  for (const x of ['a', 'b', 'c']) T[x] = tok(x);
  nets.b = await organise('b', { tier: { type: 'number' }, fromB: { type: 'string' } });
  nets.c = await organise('c', { tier: { type: 'string' }, fromC: { type: 'string' } });
});

after(async () => {
  for (const x of ['a', 'b', 'c']) {
    for (const id of Object.values(nets)) await del(INSTANCES[x], T[x], `/api/networks/${id}`).catch(() => {});
    await delWithBody(INSTANCES[x], T[x], `/api/spaces/${SPACE}`, { confirm: true }).catch(() => {});
  }
});

describe('a space in two voted networks', () => {
  it('holds each network\'s schema in that network\'s layer, and only that network\'s', () => {
    const cfg = readContainerConfig('ythril-a');
    const layer = (id) => propsOf(cfg.networks.find(n => n.id === id)?.schemaLayers?.[SPACE]);
    assert.ok('fromB' in layer(nets.b) && !('fromC' in layer(nets.b)), `B's network layer: ${JSON.stringify(layer(nets.b))}`);
    assert.ok('fromC' in layer(nets.c) && !('fromB' in layer(nets.c)), `C's network layer: ${JSON.stringify(layer(nets.c))}`);
  });

  it('what A serves C\'s network carries nothing that came from B', async () => {
    const r = await get(INSTANCES.a, T.a, `/api/sync/meta?spaceId=${SPACE}&networkId=${nets.c}`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const props = propsOf(r.body.meta);
    assert.ok(!('fromB' in props), `B's property leaked into C's network: ${JSON.stringify(props)}`);
    assert.equal(props.tier?.type, 'string', 'C must be served its own definition, not the effective mix');
  });
});
