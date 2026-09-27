/**
 * On a two-member network that votes, the proposer alone decides nothing on the other member (`Q-76`, `Q-77`).
 *
 * `concludeRoundIfReady` counted the members a network LISTS, and a network lists the OTHER members, never the
 * instance holding it. So a member that adopted a round by gossip decided it on the others' votes alone:
 * - closed required a yes from every listed member, and never asked for the member's own (Q-76);
 * - democratic compared the yeses against half the listed members, so on an even-sized network half passed (Q-77).
 * On two members, either way, the proposer's automatic yes passed the round on the other member, which then
 * applied it to its own data. A space deletion deleted B's space half a second after B first saw the round, and B
 * never voted. Every page describing these networks promises unanimity and a majority.
 *
 * Club and pub/sub are left out on purpose: there, one yes deciding is the documented rule.
 *
 * Run: node --test testing/sync/on-two-members-the-proposer-alone-decides-nothing.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'url';
import { INSTANCES, post, get, delWithBody, reqJson, mirroredNetwork } from './helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIGS = path.join(__dirname, 'configs');
let tokenA, tokenB;

before(() => {
  tokenA = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
  tokenB = fs.readFileSync(path.join(CONFIGS, 'b', 'token.txt'), 'utf8').trim();
});

for (const type of ['closed', 'democratic']) {
  describe(`${type}: a round on the member that did not vote`, () => {
    const SPACE = `q76-${type.slice(0, 3)}-${Date.now()}`;
    let net, roundId;
    const roundOnB = async () => ((await get(INSTANCES.b, tokenB, `/api/networks/${net.networkId}/votes`)).body?.rounds ?? [])
      .find(r => r.roundId === roundId);
    const spacesOnB = async () => ((await get(INSTANCES.b, tokenB, '/api/spaces')).body?.spaces ?? []).map(s => s.id);
    const syncBoth = async () => {
      await post(INSTANCES.b, tokenB, `/api/networks/${net.networkId}/sync?wait=true`, {}).catch(() => {});
      await post(INSTANCES.a, tokenA, `/api/networks/${net.networkId}/sync?wait=true`, {}).catch(() => {});
    };

    before(async () => {
      for (const [base, t] of [[INSTANCES.a, tokenA], [INSTANCES.b, tokenB]]) {
        assert.equal((await post(base, t, '/api/spaces', { id: SPACE, label: SPACE })).status, 201);
      }
      net = await mirroredNetwork({ label: SPACE, type, spaces: [SPACE], a: [INSTANCES.a, tokenA], b: [INSTANCES.b, tokenB] });
    });
    after(async () => {
      await net?.remove();
      await delWithBody(INSTANCES.a, tokenA, `/api/spaces/${SPACE}`, { confirm: true }).catch(() => {});
      await delWithBody(INSTANCES.b, tokenB, `/api/spaces/${SPACE}`, { confirm: true }).catch(() => {});
    });

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
}
