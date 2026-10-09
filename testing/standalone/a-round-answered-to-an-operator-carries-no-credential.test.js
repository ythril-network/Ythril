/**
 * Every door that answers a vote ROUND to an operator answers it through one projection, and none of them carries a credential.
 *
 * ## What leaked
 *
 * `listOpenVotesAct` projected a round (no `pendingMeta`, no `pendingMember`, no `inviteKeyHash`) and `castVoteAct` answered
 * `{ concluded, round }` with the raw stored round — so the same join round that the list showed without its credentials came back
 * from a cast with `inviteKeyHash` (the bcrypt of an invite key still in use) and `pendingMember.tokenHash`, on REST and on MCP
 * `network_vote` alike. A rule written for one door of a capability is the defect this repo produces most.
 *
 * ## What it holds
 *
 * - the projection is ONE function, `roundForOperator`, and every `round` / `rounds` a vote act puts in a response body goes through
 *   it — derived from the source of `networks/vote-acts.ts`, with a floor, so a third door cannot ship its own strip;
 * - each door, driven for real — the list act and route, the cast act, route and MCP tool, the outcomes act and route — answers a
 *   body with no key ending in `hash` at any depth and none of the secret values, and still answers what the door is for.
 *
 * Run: node --test testing/standalone/a-round-answered-to-an-operator-carries-no-credential.test.js  (requires a prior server build)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { stripComments } from './_strip-comments.mjs';
import { tempInstanceDir, removeInstanceDir, bootInstance, callRoute } from './_vote-round-instance.mjs';

const SELF = 'aaaaaaaa-0000-4000-8000-000000005e1f';
const P1 = 'aaaaaaaa-0000-4000-8000-0000000000a1';
const P2 = 'aaaaaaaa-0000-4000-8000-0000000000a2';
const JOINER = 'aaaaaaaa-0000-4000-8000-0000000000b1';
const SECRET = 'SECRET-HASH-VALUE';
const dir = tempInstanceDir('ythril-round-door-');
const ADMIN = { rights: { instanceAdmin: true } };

const member = (instanceId) => ({ instanceId, label: `m${instanceId.slice(-2)}`, url: `https://${instanceId.slice(-2)}.example`, tokenHash: SECRET, direction: 'both' });
const joinRound = () => ({
  roundId: '11111111-1111-4111-8111-111111111111', type: 'join', subjectInstanceId: JOINER, subjectLabel: 'Joiner', subjectUrl: '',
  openedAt: new Date().toISOString(), deadline: new Date(Date.now() + 3_600_000).toISOString(), votes: [], concluded: false,
  inviteKeyHash: SECRET, pendingMember: member(JOINER),
});
const NET = () => ({
  id: 'n', label: 'Net', type: 'closed', origin: 'created', syncSchedule: '', spaces: ['general'], votingDeadlineHours: 24,
  createdAt: '2026-01-01T00:00:00.000Z', members: [member(P1), member(P2)], pendingRounds: [joinRound()],
  roundOutcomes: [{ roundId: 'old', type: 'join', subjectLabel: 'x', openedAt: 'x', deadline: 'x', concludedAt: '2026-10-08T10:00:00.000Z', outcome: 'vetoed', yes: 0, veto: 1, eligible: 2, inviteKeyHash: SECRET, subjectInstanceId: JOINER }],
});

function keysDeep(value, path = '$', out = []) {
  if (Array.isArray(value)) value.forEach((v, i) => keysDeep(v, `${path}[${i}]`, out));
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) { out.push({ key: k, path: `${path}.${k}` }); keysDeep(v, `${path}.${k}`, out); }
  return out;
}
const verify = (what, body) => {
  const keys = keysDeep(body);
  assert.ok(keys.length > 3, `${what}: the body is empty (${keys.length} keys) — the door answered nothing to check`);
  const hashes = keys.filter(k => /hash$/i.test(k.key)).map(k => k.path);
  assert.deepEqual(hashes, [], `${what} carries credential hash(es): ${hashes.join(', ')}`);
  assert.ok(!JSON.stringify(body).includes(SECRET), `${what}: a secret value is in the body`);
  assert.ok(!keys.some(k => k.key === 'pendingMember'), `${what} carries a candidate's credential record (pendingMember)`);
};

describe('the vote acts put a round in a body through one projection', () => {
  const src = stripComments(fs.readFileSync('server/src/networks/vote-acts.ts', 'utf8'));

  it('roundForOperator exists and the list and the cast both call it', () => {
    assert.match(src, /export function roundForOperator\s*\(/);
    for (const act of ['listOpenVotesAct', 'castVoteAct']) {
      const body = new RegExp(`function ${act}[\\s\\S]*?\\n\\}`).exec(src)?.[0] ?? '';
      assert.ok(body, `${act} is gone — re-anchor this gate`);
      assert.match(body, /\broundForOperator\s*\(/, `${act} answers a round without the projection`);
    }
  });

  it('no response body in the file carries a round that did not go through it', () => {
    const bodies = [...src.matchAll(/body:\s*\{([^}]*)\}/g)].map(m => m[1]);
    assert.ok(bodies.length >= 4, `only ${bodies.length} response bodies found — the scan broke`);
    const carrying = bodies.filter(b => /\bround(?:s)?\b/.test(b));
    assert.ok(carrying.length >= 2, 'no body carrying a round was found — the scan broke');
    // `{ rounds }` is the list's already-projected array; `{ concluded, round: <projection> }` is the cast's. A bare `round` is the stored one.
    const bare = carrying.filter(b => /(?:^|[\s,{])round\s*(?:,|$)/.test(b.trim()));
    assert.deepEqual(bare, [], `these bodies answer the stored round itself: ${bare.join(' | ')}`);
  });
});

describe('every door that answers a round, driven', () => {
  let loader;
  before(async () => { loader = await bootInstance(dir, { instanceId: SELF, networks: [NET()] }); });
  after(() => removeInstanceDir(dir));
  const reset = () => { loader.getConfig().networks[0].pendingRounds = [joinRound()]; };

  it('the open-votes list (act and REST route)', async () => {
    reset();
    const acts = await import('../../server/dist/networks/vote-acts.js');
    const viaAct = acts.listOpenVotesAct('n');
    assert.equal(viaAct.status, 200);
    assert.equal(viaAct.body.rounds.length, 1);
    verify('listOpenVotesAct', viaAct.body);
    const { votesRouter } = await import('../../server/dist/api/networks/votes.js');
    const res = await callRoute(votesRouter, 'get', '/:id/votes', { params: { id: 'n' }, authToken: ADMIN });
    assert.equal(res.code, 200);
    verify('GET /api/networks/:id/votes', res.body);
  });

  it('the cast (act, REST route and MCP tool) — which concludes nothing here, so the round is the one the voter still has to see', async () => {
    const { castVoteAct } = await import('../../server/dist/networks/vote-acts.js');
    reset();
    const viaAct = castVoteAct('n', joinRound().roundId, { vote: 'yes' });
    assert.equal(viaAct.status, 200, JSON.stringify(viaAct));
    assert.equal(viaAct.body.concluded, false, 'the fixture concluded the round, so the answer is not the case this holds');
    assert.equal(viaAct.body.round.roundId, joinRound().roundId);
    verify('castVoteAct', viaAct.body);

    reset();
    const { votesRouter } = await import('../../server/dist/api/networks/votes.js');
    const rest = await callRoute(votesRouter, 'post', '/:id/votes/:roundId', { params: { id: 'n', roundId: joinRound().roundId }, body: { vote: 'yes' }, authToken: ADMIN });
    assert.equal(rest.code, 200, JSON.stringify(rest.body));
    verify('POST /api/networks/:id/votes/:roundId', rest.body);

    reset();
    const { network_voteTool } = await import('../../server/dist/mcp/tools/networks.js');
    const mcp = await network_voteTool.handle({ args: { id: 'n', roundId: joinRound().roundId, vote: 'yes' }, rights: ADMIN.rights });
    assert.ok(!mcp.isError, JSON.stringify(mcp));
    verify('network_vote (structured)', mcp.structuredContent);
    verify('network_vote (text)', JSON.parse(mcp.content[0].text));
  });

  it('the outcome log (act and REST route)', async () => {
    const { voteOutcomesAct } = await import('../../server/dist/networks/vote-acts.js');
    const viaAct = voteOutcomesAct('n', 20);
    assert.equal(viaAct.body.outcomes.length, 1);
    verify('voteOutcomesAct', viaAct.body);
    const { votesRouter } = await import('../../server/dist/api/networks/votes.js');
    const res = await callRoute(votesRouter, 'get', '/:id/vote-outcomes', { params: { id: 'n' }, query: {}, authToken: ADMIN });
    assert.equal(res.code, 200);
    verify('GET /api/networks/:id/vote-outcomes', res.body);
  });
});
