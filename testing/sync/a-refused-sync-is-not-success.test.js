/**
 * A sync cycle whose transfers were all refused is not recorded as a success (`Q-48`).
 *
 * A refused batch holds the watermark, which is right, and it used to be the only thing that happened: the cycle
 * still counted the member as synced, logged `1 ok, 0 errors`, and wrote `status: success` with nothing transferred.
 * Found with Q-47, where a network answered 403 on every family for as long as it existed and its history, its page
 * and its metrics all read healthy.
 *
 * The refusal here is a real one: B holds a genuine peer token for A that reaches a different space, so every
 * request authenticates and every transfer of the network's space answers 403.
 *
 * Run: node --test testing/sync/a-refused-sync-is-not-success.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { INSTANCES, post, get, del, getInstanceId, waitFor } from './helpers.js';
import { legacyRights } from '../_shared/legacy-token-rights.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIGS = path.join(__dirname, 'configs');

let tokenA, tokenB, networkId, instanceIdA, instanceIdB;
const SPACE = `q48-refused-${Date.now()}`;

before(async () => {
  tokenA = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
  tokenB = fs.readFileSync(path.join(CONFIGS, 'b', 'token.txt'), 'utf8').trim();
  instanceIdA = getInstanceId('ythril-a');
  instanceIdB = getInstanceId('ythril-b');
  for (const [inst, tok] of [[INSTANCES.a, tokenA], [INSTANCES.b, tokenB]]) {
    const s = await post(inst, tok, '/api/spaces', { id: SPACE, label: 'Q-48 refused', folders: [] });
    assert.equal(s.status, 201, JSON.stringify(s.body));
  }
  const w = await post(INSTANCES.a, tokenA, `/api/brain/spaces/${SPACE}/facts`, { fact: 'something to push' });
  assert.equal(w.status, 201, JSON.stringify(w.body));

  // A real peer token for A on B, scoped to a space the network does not carry — so B refuses the network's space.
  const t = await post(INSTANCES.b, tokenB, '/api/tokens', { name: 'q48-wrong-scope', peerInstanceId: instanceIdA, rights: legacyRights({ spaces: ['general'] }) });
  assert.equal(t.status, 201, JSON.stringify(t.body));

  const n = await post(INSTANCES.a, tokenA, '/api/networks', { label: 'q48', type: 'club', spaces: [SPACE] });
  assert.equal(n.status, 201, JSON.stringify(n.body));
  networkId = n.body.id;
  const m = await post(INSTANCES.a, tokenA, `/api/networks/${networkId}/members`, {
    instanceId: instanceIdB, label: 'Instance B', url: 'http://ythril-b:3200', token: t.body.plaintext, direction: 'both',
  });
  assert.ok(m.status === 201 || m.status === 200, JSON.stringify(m.body));
});

after(async () => {
  if (networkId) await del(INSTANCES.a, tokenA, `/api/networks/${networkId}`).catch(() => {});
  await del(INSTANCES.a, tokenA, `/api/spaces/${SPACE}`).catch(() => {});
  await del(INSTANCES.b, tokenB, `/api/spaces/${SPACE}`).catch(() => {});
});

describe('a sync cycle every transfer of which was refused', () => {
  it('is recorded as failed, with the reason, and not as a success', async () => {
    const before = (await get(INSTANCES.a, tokenA, `/api/networks/${networkId}/sync-history`)).body?.history?.length ?? 0;
    const trig = await post(INSTANCES.a, tokenA, `/api/networks/${networkId}/sync`, {});
    assert.equal(trig.status, 200, JSON.stringify(trig.body));
    let entry;
    await waitFor(async () => {
      const h = await get(INSTANCES.a, tokenA, `/api/networks/${networkId}/sync-history`);
      if ((h.body?.history?.length ?? 0) > before) { entry = h.body.history[0]; return true; }
      return false;
    }, 30_000);
    assert.notEqual(entry.status, 'success', `a cycle that transferred nothing because every batch was refused read as success: ${JSON.stringify(entry)}`);
    assert.equal(entry.status, 'failed', `the only member was refused, so the cycle failed: ${JSON.stringify(entry)}`);
    assert.match(JSON.stringify(entry.errors ?? entry.error ?? ''), /stopped early|refused|403/i,
      `the history must say why: ${JSON.stringify(entry)}`);
  });
});
