/**
 * A member of a voted network that holds no layer for a shared space takes it on its next cycle (`Q-966`).
 *
 * A member that joined a club, closed or democratic network before the join carried the schema (or whose join could not
 * fetch it) held the space with no types and no validation mode, and nothing ever sent them: a voted network has no meta
 * pull. Its cycle now asks the member it syncs with for the network's schema of every shared space it holds no layer for,
 * through the one schema door (`GET /api/sync/meta`), which serves only a caller that may read the space's schema.
 *
 * A holds a space with a schema and a closed network carrying it; B joins. B's layer and its copy of the schema are then
 * removed from its config, as a member joined on an older build holds them; one cycle later B holds them again.
 *
 * Run: node --test testing/sync/a-voted-member-that-joined-without-the-schema-heals.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'url';
import {
  INSTANCES, post, patch, get, del, delWithBody, syncUntil, readContainerConfig, patchContainerNetwork, reloadConfig,
} from './helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIGS = path.join(__dirname, 'configs');
const RUN = Date.now();
const SPACE = `q966-heal-${RUN}`;
const tok = (x) => fs.readFileSync(path.join(CONFIGS, x, 'token.txt'), 'utf8').trim();
const SCHEMA = { validationMode: 'strict', typeSchemas: { entity: { person: { propertySchemas: { tier: { type: 'number' } } } } } };

let tA, tB, networkId;

const metaOnB = async () => (await get(INSTANCES.b, tB, `/api/spaces/${SPACE}/meta`)).body ?? {};
const layerOnB = () => readContainerConfig('ythril-b').networks.find(n => n.id === networkId)?.schemaLayers?.[SPACE];

before(async () => {
  tA = tok('a'); tB = tok('b');
  assert.equal((await post(INSTANCES.a, tA, '/api/spaces', { id: SPACE, label: SPACE })).status, 201);
  const m = await patch(INSTANCES.a, tA, `/api/spaces/${SPACE}`, { meta: SCHEMA });
  assert.ok(m.status < 300, JSON.stringify(m.body));
  const n = await post(INSTANCES.a, tA, '/api/networks', { label: SPACE, type: 'closed', spaces: [SPACE], votingDeadlineHours: 1 });
  assert.equal(n.status, 201, JSON.stringify(n.body));
  networkId = n.body.id;
  const inv = await post(INSTANCES.a, tA, '/api/invite/generate', { networkId });
  assert.equal(inv.status, 201, JSON.stringify(inv.body));
  const j = await post(INSTANCES.b, tB, '/api/networks/join-remote', {
    handshakeId: inv.body.handshakeId, inviteUrl: 'http://ythril-a:3200/api/invite/apply', rsaPublicKeyPem: inv.body.rsaPublicKeyPem,
    networkId, myUrl: 'http://ythril-b:3200',
  });
  assert.equal(j.status, 200, JSON.stringify(j.body));
  // As an older build's join left it: no layer for the network, and the space's own copy of the schema empty.
  patchContainerNetwork('ythril-b', networkId, `
    if (n.schemaLayers) delete n.schemaLayers[${JSON.stringify(SPACE)}];
    if (n.schemaLayerUnread) delete n.schemaLayerUnread[${JSON.stringify(SPACE)}];
    const s = cfg.spaces.find(x => x.id === ${JSON.stringify(SPACE)});
    if (s) { delete s.meta; delete s.ownMeta; }
  `);
  await reloadConfig(INSTANCES.b, tB);
});

after(async () => {
  for (const [base, token] of [[INSTANCES.b, tB], [INSTANCES.a, tA]]) {
    if (networkId) await del(base, token, `/api/networks/${networkId}`).catch(() => {});
    await delWithBody(base, token, `/api/spaces/${SPACE}`, { confirm: true }).catch(() => {});
  }
});

describe('a voted member that joined without the schema', () => {
  it('starts without it (the premise)', async () => {
    assert.equal(layerOnB(), undefined, 'the layer was not removed');
    assert.notEqual((await metaOnB()).validationMode, 'strict', 'the schema was not removed');
  });

  it('takes the network\'s schema on its next cycle, as that network\'s layer', async () => {
    let last;
    await syncUntil(INSTANCES.b, tB, networkId, async () => {
      last = await metaOnB();
      return last.validationMode === 'strict' && last.typeSchemas?.entity?.person?.propertySchemas?.tier?.type === 'number';
    }, 'B taking the closed network\'s schema', { onTimeout: () => `B's meta: ${JSON.stringify(last)}` });
    assert.equal(layerOnB()?.validationMode, 'strict', 'the schema must land in the network\'s layer, not in B\'s own definitions');
  });

  it('a caller without schema: read on the space is not served the layer', async () => {
    const none = { knowledge: 'none', files: 'read', schema: 'none', dataQuality: 'none' };
    const t = await post(INSTANCES.a, tA, '/api/tokens', {
      name: `q966-files-only-${RUN}`, rights: { instanceAdmin: false, createSpaces: false, floor: null, perSpace: { [SPACE]: none } },
    });
    assert.equal(t.status, 201, JSON.stringify(t.body));
    try {
      const r = await get(INSTANCES.a, t.body.plaintext, `/api/sync/meta?spaceId=${SPACE}&networkId=${networkId}`);
      assert.equal(r.status, 403, `a files-only token was answered ${r.status}: ${JSON.stringify(r.body)}`);
      assert.equal(r.body?.code, 'schema_rung');
      assert.ok(!JSON.stringify(r.body).includes('tier'), 'the refusal carried the schema');
    } finally {
      await del(INSTANCES.a, tA, `/api/tokens/${t.body.id}`).catch(() => {});
    }
  });
});
