/**
 * On a closed network a round passes on a member only once that member has voted yes itself (`Q-76`).
 *
 * `concludeRoundIfReady` required a yes from every member it LISTS — and a network lists the OTHER members, never
 * the instance holding it. So a member that adopted a round by gossip passed it as soon as every other member had
 * voted, its own yes never asked for: on two members, the proposer alone decided for the other one. The round then
 * acts on the member's own data — a space deletion deleted B's space half a second after B first saw the round,
 * and B never voted. Every page that describes a closed network promises unanimity.
 *
 * Run: node --test testing/sync/a-closed-network-round-needs-this-members-own-yes.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'url';
import { INSTANCES, post, get, delWithBody, reqJson, mirroredClosedNetwork } from './helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIGS = path.join(__dirname, 'configs');
const RUN = Date.now();
const SPACE = `q76-${RUN}`;
let tokenA, tokenB, net, roundId;

const roundOnB = async () => ((await get(INSTANCES.b, tokenB, `/api/networks/${net.networkId}/votes`)).body?.rounds ?? [])
  .find(r => r.roundId === roundId);
const spacesOnB = async () => ((await get(INSTANCES.b, tokenB, '/api/spaces')).body?.spaces ?? []).map(s => s.id);
const syncBoth = async () => {
  await post(INSTANCES.b, tokenB, `/api/networks/${net.networkId}/sync?wait=true`, {}).catch(() => {});
  await post(INSTANCES.a, tokenA, `/api/networks/${net.networkId}/sync?wait=true`, {}).catch(() => {});
};

before(async () => {
  tokenA = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
  tokenB = fs.readFileSync(path.join(CONFIGS, 'b', 'token.txt'), 'utf8').trim();
  for (const [base, t] of [[INSTANCES.a, tokenA], [INSTANCES.b, tokenB]]) {
    assert.equal((await post(base, t, '/api/spaces', { id: SPACE, label: SPACE })).status, 201);
  }
  net = await mirroredClosedNetwork({ label: `q76-${RUN}`, spaces: [SPACE], a: [INSTANCES.a, tokenA], b: [INSTANCES.b, tokenB] });
});

after(async () => {
  await net?.remove();
  await delWithBody(INSTANCES.a, tokenA, `/api/spaces/${SPACE}`, { confirm: true }).catch(() => {});
  await delWithBody(INSTANCES.b, tokenB, `/api/spaces/${SPACE}`, { confirm: true }).catch(() => {});
});

describe('a closed network round on the member that did not vote', () => {
  it('A proposes a space deletion; after several cycles it is still open on B, and B keeps its space', async () => {
    const d = await reqJson(INSTANCES.a, tokenA, `/api/spaces/${SPACE}`, { method: 'DELETE' });
    assert.equal(d.status, 202, JSON.stringify(d.body));
    roundId = d.body.rounds?.[0]?.roundId;
    assert.ok(roundId);
    // Each cycle carries A's open round to B. Before the fix B adopted it and passed it within that same cycle, so
    // it was never visible as open there; B's space is what shows the difference.
    for (let i = 0; i < 4; i++) await syncBoth();
    assert.ok((await spacesOnB()).includes(SPACE), 'B applied a round it never voted on');
    assert.ok(await roundOnB(), 'B holds no open round: it never learned it, or concluded it without its own vote');
  });

  it('B\'s veto then concludes it as failed, and nothing is deleted', async () => {
    const v = await post(INSTANCES.b, tokenB, `/api/networks/${net.networkId}/votes/${roundId}`, { vote: 'veto' });
    assert.equal(v.status, 200, JSON.stringify(v.body));
    await syncBoth();
    assert.ok((await spacesOnB()).includes(SPACE));
  });
});
