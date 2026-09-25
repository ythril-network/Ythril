/**
 * A space carried by two networks: the first network joined wins a schema clash, records from both still arrive,
 * and neither network is sent the other's definitions (`F-39.2`, owner decision 2026-09-25, option A).
 *
 * B and C each publish a pub/sub network carrying the same space id and define `person.tier` differently. A joins
 * B's network first, then C's, both onto one local space.
 *
 * Run: node --test testing/sync/a-space-in-two-networks-keeps-each-schema-apart.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'url';
import { INSTANCES, post, patch, get, del, delWithBody, triggerSync, waitFor, readCollection } from './helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIGS = path.join(__dirname, 'configs');
const RUN = Date.now();
const SPACE = `f392-${RUN}`;
const token = (x) => fs.readFileSync(path.join(CONFIGS, x, 'token.txt'), 'utf8').trim();
const person = (props) => ({ typeSchemas: { entity: { person: { propertySchemas: props } } } });

let tA, tB, tC;
const nets = {};

async function publish(base, tok, host, props) {
  const s = await post(base, tok, '/api/spaces', { id: SPACE, label: SPACE });
  assert.equal(s.status, 201, JSON.stringify(s.body));
  const m = await patch(base, tok, `/api/spaces/${SPACE}`, { meta: person(props) });
  assert.ok(m.status < 300, JSON.stringify(m.body));
  const n = await post(base, tok, '/api/networks', { label: `f392-${host}-${RUN}`, type: 'pubsub', spaces: [SPACE] });
  assert.equal(n.status, 201, JSON.stringify(n.body));
  const inv = await post(base, tok, '/api/invite/generate', { networkId: n.body.id });
  assert.equal(inv.status, 201, JSON.stringify(inv.body));
  const j = await post(INSTANCES.a, tA, '/api/networks/join-remote', {
    handshakeId: inv.body.handshakeId, inviteUrl: `http://${host}:3200/api/invite/apply`, rsaPublicKeyPem: inv.body.rsaPublicKeyPem,
    networkId: n.body.id, myUrl: 'http://ythril-a:3200',
  });
  assert.equal(j.status, 200, JSON.stringify(j.body));
  return n.body.id;
}

before(async () => {
  [tA, tB, tC] = ['a', 'b', 'c'].map(token);
  // B first: A joins B's network before C's, so B's definition wins on A.
  nets.b = await publish(INSTANCES.b, tB, 'ythril-b', { tier: { type: 'number' }, fromB: { type: 'string' } });
  nets.c = await publish(INSTANCES.c, tC, 'ythril-c', { tier: { type: 'string' }, fromC: { type: 'string' } });
});

after(async () => {
  for (const [base, tok] of [[INSTANCES.a, tA], [INSTANCES.b, tB], [INSTANCES.c, tC]]) {
    for (const id of Object.values(nets)) await del(base, tok, `/api/networks/${id}`).catch(() => {});
    await delWithBody(base, tok, `/api/spaces/${SPACE}`, { confirm: true }).catch(() => {});
  }
});

const propsOnA = async () => (await get(INSTANCES.a, tA, `/api/spaces/${SPACE}/meta`)).body?.typeSchemas?.entity?.person?.propertySchemas ?? {};

describe('a space in two networks', () => {
  it('after both sync, the space holds both networks\' properties', async () => {
    await waitFor(async () => {
      for (const id of Object.values(nets)) await triggerSync(INSTANCES.a, tA, id).catch(() => {});
      const p = await propsOnA();
      return !!p.fromB && !!p.fromC;
    }, 45_000, 2_000);
  });

  it('and the network joined first wins the clash', async () => {
    assert.equal((await propsOnA()).tier?.type, 'number', 'C\'s definition overrode the first-joined B');
  });

  it('what A sends on C\'s network carries nothing that came from B', async () => {
    const r = await get(INSTANCES.a, tA, `/api/sync/meta?spaceId=${SPACE}&networkId=${nets.c}`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const props = r.body.meta?.typeSchemas?.entity?.person?.propertySchemas ?? {};
    assert.ok(!('fromB' in props), `B's property leaked into C's network: ${JSON.stringify(props)}`);
    assert.equal(props.tier?.type, 'string', 'C must be sent its own definition, not the effective mix');
  });

  it('records from the network that lost the clash still arrive', async () => {
    const f = await post(INSTANCES.c, tC, `/api/brain/spaces/${SPACE}/entities`, { name: `f392 from c ${RUN}`, type: 'person' });
    assert.ok(f.status < 300, JSON.stringify(f.body));
    await waitFor(async () => {
      await triggerSync(INSTANCES.a, tA, nets.c).catch(() => {});
      const r = await readCollection(INSTANCES.a, tA, SPACE, 'entities', { filter: { name: `f392 from c ${RUN}` }, limit: 1 });
      return (r.results ?? []).length > 0;
    }, 45_000, 2_000);
  });
});
