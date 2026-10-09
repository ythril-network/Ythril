/**
 * Open votes, casting a vote and the sync history answer the same through MCP as through REST (`F-36`, slice 2).
 *
 * A vote is how a networked space approves a destructive act, and it was the governance act MCP could not reach.
 * The tools call the acts the routes call (`networks/vote-acts.ts`), so this checks the OUTCOME on both doors: the
 * same open rounds, a cast through MCP that concludes the round REST then no longer lists, and the same history.
 *
 * Run: node --test testing/integration/a-network-vote-is-cast-the-same-on-both-doors.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'url';
import { generateKeyPairSync, publicEncrypt, randomBytes, constants } from 'node:crypto';
import { INSTANCES, post, get, del, delWithBody, patchContainerNetwork } from '../sync/helpers.js';
import { openMcpSession } from '../sync/mcp-session.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIGS = path.join(__dirname, '..', 'sync', 'configs');
const RUN = Date.now();
const FIRST = `f362-first-${RUN}`;
const ADDED = `f362-added-${RUN}`;
const LATE = `f362-late-${RUN}`;

let admin, mcp, netId, roundId;

before(async () => {
  admin = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
  for (const id of [FIRST, ADDED, LATE]) {
    const r = await post(INSTANCES.a, admin, '/api/spaces', { id, label: id });
    assert.equal(r.status, 201, JSON.stringify(r.body));
  }
  const n = await post(INSTANCES.a, admin, '/api/networks', { label: `f362-${RUN}`, type: 'closed', spaces: [FIRST] });
  assert.equal(n.status, 201, JSON.stringify(n.body));
  netId = n.body.id;
  // A real member by the handshake, so the round below cannot pass on this instance's yes alone.
  const gen = await post(INSTANCES.a, admin, '/api/invite/generate', { networkId: netId });
  const b = generateKeyPairSync('rsa', { modulusLength: 4096,
    publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
  const apply = await post(INSTANCES.a, '', '/api/invite/apply', { handshakeId: gen.body.handshakeId, networkId: netId,
    instanceId: '44444444-4444-4444-8444-444444444444', instanceLabel: 'f362 peer', instanceUrl: 'http://ythril-b:3200', rsaPublicKeyPem: b.publicKey });
  assert.equal(apply.status, 200, JSON.stringify(apply.body));
  const enc = publicEncrypt({ key: apply.body.rsaPublicKeyPem, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
    Buffer.from(`ythril_${randomBytes(32).toString('base64url')}`)).toString('base64');
  assert.equal((await post(INSTANCES.a, '', '/api/invite/finalize', { handshakeId: gen.body.handshakeId, encryptedTokenForA: enc })).status, 200);
  const add = await post(INSTANCES.a, admin, `/api/networks/${netId}/spaces`, { spaceId: ADDED });
  assert.equal(add.status, 202, JSON.stringify(add.body));
  roundId = add.body.round.roundId;
  mcp = await openMcpSession(admin);
});

after(async () => {
  await mcp?.close?.();
  if (netId) await del(INSTANCES.a, admin, `/api/networks/${netId}`).catch(() => {});
  for (const id of [FIRST, ADDED, LATE]) await delWithBody(INSTANCES.a, admin, `/api/spaces/${id}`, { confirm: true }).catch(() => {});
});

const tool = async (name, args) => {
  const r = await mcp.callTool(name, args);
  return { isError: !!r?.isError, body: r?.structuredContent ?? {}, text: r?.content?.[0]?.text ?? '' };
};

describe('network votes through MCP and through REST', () => {
  it('network_votes lists the open rounds GET /votes lists', async () => {
    const rest = await get(INSTANCES.a, admin, `/api/networks/${netId}/votes`);
    const viaMcp = await tool('network_votes', { id: netId });
    assert.equal(viaMcp.isError, false, viaMcp.text);
    assert.deepEqual(viaMcp.body.rounds.map(r => r.roundId), rest.body.rounds.map(r => r.roundId));
    assert.ok(rest.body.rounds.some(r => r.roundId === roundId), 'the space-addition round must be open');
  });

  it('network_vote casts, and a veto concludes the round on both doors', async () => {
    const r = await tool('network_vote', { id: netId, roundId, vote: 'veto' });
    assert.equal(r.isError, false, r.text);
    assert.equal(r.body.concluded, true);
    const rest = await get(INSTANCES.a, admin, `/api/networks/${netId}/votes`);
    assert.ok(!rest.body.rounds.some(x => x.roundId === roundId), 'REST still lists the round MCP concluded');
    assert.ok(!(await get(INSTANCES.a, admin, `/api/networks/${netId}`)).body.spaces.includes(ADDED), 'a vetoed addition added the space');
  });

  it('a concluded round is refused with the same sentence on both doors', async () => {
    const rest = await post(INSTANCES.a, admin, `/api/networks/${netId}/votes/${roundId}`, { vote: 'yes' });
    assert.equal(rest.status, 404, JSON.stringify(rest.body));
    assert.equal((await tool('network_vote', { id: netId, roundId, vote: 'yes' })).text, `Error (404): ${rest.body.error}`);
  });

  it('a round past its deadline is refused with the same status, code and sentence on both doors', async () => {
    // A round whose deadline has passed and that nothing has concluded yet. The expiry job concludes such a round within a minute,
    // after which the answer is the 404 above, so each attempt makes a fresh round, ages it on disk and casts at once; an attempt
    // the job beat answers 404 and is made again. Every attempt that reached the round must answer alike.
    let reached = null;
    for (let attempt = 0; attempt < 3 && !reached; attempt++) {
      const added = await post(INSTANCES.a, admin, `/api/networks/${netId}/spaces`, { spaceId: LATE });
      assert.equal(added.status, 202, JSON.stringify(added.body));
      const late = added.body.round.roundId;
      patchContainerNetwork('ythril-a', netId, `const r=n.pendingRounds.find(x=>x.roundId==='${late}');r.deadline=new Date(Date.now()-60000).toISOString();`);
      assert.equal((await post(INSTANCES.a, admin, '/api/admin/reload-config', {})).status, 200);
      const rest = await post(INSTANCES.a, admin, `/api/networks/${netId}/votes/${late}`, { vote: 'yes' });
      const viaMcp = await tool('network_vote', { id: netId, roundId: late, vote: 'yes' });
      if (rest.status === 404) continue; // the job concluded it between the two steps: try again with a fresh round
      reached = { rest, viaMcp };
    }
    assert.ok(reached, 'the expiry job concluded every aged round before it could be cast on');
    assert.equal(reached.rest.status, 409, `REST answered ${reached.rest.status}: ${JSON.stringify(reached.rest.body)}`);
    assert.equal(reached.rest.body.code, 'round_expired');
    assert.ok(Date.parse(reached.rest.body.deadline) < Date.now(), 'the refusal names the deadline that passed');
    assert.equal(reached.viaMcp.isError, true);
    assert.equal(reached.viaMcp.text, `Error (409): ${reached.rest.body.error}`, 'MCP refused in other words, or with another status');
  });

  it('network_sync_history answers what GET /sync-history answers', async () => {
    const rest = await get(INSTANCES.a, admin, `/api/networks/${netId}/sync-history?limit=5`);
    const viaMcp = await tool('network_sync_history', { id: netId, limit: 5 });
    assert.equal(viaMcp.isError, false, viaMcp.text);
    assert.deepEqual(viaMcp.body, rest.body);
  });
});
