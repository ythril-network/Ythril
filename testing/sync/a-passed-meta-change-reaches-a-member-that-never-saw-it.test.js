/**
 * A passed meta change reaches every member, including one that never saw the round open (`F-39.4`).
 *
 * On a club the organiser's own yes carries a `meta_change` round the moment it opens, so the round was concluded
 * before any member could pull it, and the peer votes route served only OPEN rounds: the member never applied the
 * change. The organiser now serves the passed round too, the member re-decides it from the casts, and applies it into
 * that network's LAYER — never into its own definitions, so replaying an old round cannot overwrite them.
 *
 * A organises a club carrying one space; B joins; A changes the space's purpose.
 *
 * Run: node --test testing/sync/a-passed-meta-change-reaches-a-member-that-never-saw-it.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'url';
import { INSTANCES, post, patch, get, del, delWithBody, triggerSync, waitFor, readContainerConfig } from './helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIGS = path.join(__dirname, 'configs');
const RUN = Date.now();
const SPACE = `f394-${RUN}`;
const PURPOSE = `decided by the club ${RUN}`;

let tA, tB, networkId;

before(async () => {
  tA = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
  tB = fs.readFileSync(path.join(CONFIGS, 'b', 'token.txt'), 'utf8').trim();
  assert.equal((await post(INSTANCES.a, tA, '/api/spaces', { id: SPACE, label: SPACE })).status, 201);
  const net = await post(INSTANCES.a, tA, '/api/networks', { label: `f394-${RUN}`, type: 'club', spaces: [SPACE] });
  assert.equal(net.status, 201, JSON.stringify(net.body));
  networkId = net.body.id;
  const inv = await post(INSTANCES.a, tA, '/api/invite/generate', { networkId });
  const join = await post(INSTANCES.b, tB, '/api/networks/join-remote', {
    handshakeId: inv.body.handshakeId, inviteUrl: 'http://ythril-a:3200/api/invite/apply', rsaPublicKeyPem: inv.body.rsaPublicKeyPem,
    networkId, myUrl: 'http://ythril-b:3200',
  });
  assert.equal(join.status, 200, JSON.stringify(join.body));
  // The organiser's own yes passes the round at once (Q-49), before B has seen it.
  const r = await patch(INSTANCES.a, tA, `/api/spaces/${SPACE}`, { meta: { purpose: PURPOSE } });
  assert.ok(r.status < 300, JSON.stringify(r.body));
  assert.equal((await get(INSTANCES.a, tA, `/api/spaces/${SPACE}/meta`)).body.purpose, PURPOSE, 'the organiser applied it');
});

after(async () => {
  if (networkId) {
    await del(INSTANCES.b, tB, `/api/networks/${networkId}`).catch(() => {});
    await del(INSTANCES.a, tA, `/api/networks/${networkId}`).catch(() => {});
  }
  await delWithBody(INSTANCES.a, tA, `/api/spaces/${SPACE}`, { confirm: true }).catch(() => {});
  await delWithBody(INSTANCES.b, tB, `/api/spaces/${SPACE}`, { confirm: true }).catch(() => {});
});

describe('a member that never saw the round open', () => {
  it('runs on the change after a sync', async () => {
    await waitFor(async () => {
      await triggerSync(INSTANCES.b, tB, networkId).catch(() => {});
      return (await get(INSTANCES.b, tB, `/api/spaces/${SPACE}/meta`)).body?.purpose === PURPOSE;
    }, 30_000, 1_500);
  });

  it('and holds it as the network\'s layer, not as its own definition', () => {
    const cfg = readContainerConfig('ythril-b');
    const net = cfg.networks.find(n => n.id === networkId);
    assert.equal(net?.schemaLayers?.[SPACE]?.purpose, PURPOSE, 'the change must land in the network layer');
    const own = cfg.spaces.find(s => s.id === SPACE)?.ownMeta;
    assert.notEqual(own?.purpose, PURPOSE, 'the change must not become the member\'s own definition');
  });
});
