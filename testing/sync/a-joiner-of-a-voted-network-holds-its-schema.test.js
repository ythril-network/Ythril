/**
 * A member that joins a club, closed or democratic network holds the network's schema for every space it joins (`Q-966`).
 *
 * A voted network has no meta pull (pub/sub and tree pull from their upstream, `F-39.1`), and the join carried no schema,
 * so a joiner's copy of a space arrived with no types and no validation mode: it accepted what the network's schema
 * refuses until somebody changed the schema, and then received only the changed fields (owner, 2026-11, the
 * flows-feedback club). The join now takes each joined space's schema from the member it joins through and keeps it as
 * that network's layer, in the act that creates the space.
 *
 * Per type, A holds a space with a type schema and strict validation BEFORE anybody joins; then members join through A.
 * The club has three members and the case is the third. Closed and democratic: the joiner A alone admits.
 *
 * Run: node --test testing/sync/a-joiner-of-a-voted-network-holds-its-schema.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'url';
import { INSTANCES, post, patch, get, del, delWithBody, syncUntil, readContainerConfig } from './helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIGS = path.join(__dirname, 'configs');
const RUN = Date.now();
const tok = (x) => fs.readFileSync(path.join(CONFIGS, x, 'token.txt'), 'utf8').trim();
const SCHEMA = { validationMode: 'strict', typeSchemas: { entity: { person: { propertySchemas: { tier: { type: 'number' } } } } } };

const T = {};
const made = [];

/** A space on A with the schema, and a network of `type` carrying it; then each of `joiners` joins through A. */
async function voted(type, joiners) {
  const space = `q966-${type}-${RUN}`;
  assert.equal((await post(INSTANCES.a, T.a, '/api/spaces', { id: space, label: space })).status, 201);
  const m = await patch(INSTANCES.a, T.a, `/api/spaces/${space}`, { meta: SCHEMA });
  assert.ok(m.status < 300, JSON.stringify(m.body));
  const n = await post(INSTANCES.a, T.a, '/api/networks', { label: space, type, spaces: [space], votingDeadlineHours: 1 });
  assert.equal(n.status, 201, JSON.stringify(n.body));
  made.push({ space, networkId: n.body.id });
  for (const x of joiners) {
    const inv = await post(INSTANCES.a, T.a, '/api/invite/generate', { networkId: n.body.id });
    assert.equal(inv.status, 201, JSON.stringify(inv.body));
    const j = await post(INSTANCES[x], T[x], '/api/networks/join-remote', {
      handshakeId: inv.body.handshakeId, inviteUrl: 'http://ythril-a:3200/api/invite/apply', rsaPublicKeyPem: inv.body.rsaPublicKeyPem,
      networkId: n.body.id, myUrl: `http://ythril-${x}:3200`,
    });
    assert.equal(j.status, 200, JSON.stringify(j.body));
  }
  return { space, networkId: n.body.id };
}

const metaOn = async (x, space) => (await get(INSTANCES[x], T[x], `/api/spaces/${space}/meta`)).body ?? {};
const holdsSchema = (meta) => meta.validationMode === 'strict' && meta.typeSchemas?.entity?.person?.propertySchemas?.tier?.type === 'number';

before(() => { for (const x of ['a', 'b', 'c']) T[x] = tok(x); });

after(async () => {
  for (const { space, networkId } of made) {
    for (const x of ['c', 'b', 'a']) {
      await del(INSTANCES[x], T[x], `/api/networks/${networkId}`).catch(() => {});
      await delWithBody(INSTANCES[x], T[x], `/api/spaces/${space}`, { confirm: true }).catch(() => {});
    }
  }
});

for (const [type, joiners] of [['club', ['b', 'c']], ['closed', ['b']], ['democratic', ['c']]]) {
  const joiner = joiners.at(-1);
  describe(`a ${type} network: the ${joiners.length === 2 ? 'third' : 'joining'} member`, () => {
    let net;
    before(async () => { net = await voted(type, joiners); });

    it('holds the network\'s schema as that network\'s layer when the join answers', () => {
      const layer = readContainerConfig(`ythril-${joiner}`).networks.find(n => n.id === net.networkId)?.schemaLayers?.[net.space];
      assert.equal(layer?.validationMode, 'strict', `the join stored no layer for the network: ${JSON.stringify(layer)}`);
      assert.equal(layer?.typeSchemas?.entity?.person?.propertySchemas?.tier?.type, 'number');
    });

    it('and runs on its types and validation mode after its first cycle', async () => {
      let last;
      await syncUntil(INSTANCES[joiner], T[joiner], net.networkId, async () => holdsSchema(last = await metaOn(joiner, net.space)),
        `the ${type} joiner taking the network's schema`, { onTimeout: () => `the joiner's meta: ${JSON.stringify(last)}` });
    });
  });
}
