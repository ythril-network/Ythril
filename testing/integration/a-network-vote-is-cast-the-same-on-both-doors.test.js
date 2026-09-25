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
import { INSTANCES, post, get, del, delWithBody } from '../sync/helpers.js';
import { openMcpSession } from '../sync/mcp-session.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIGS = path.join(__dirname, '..', 'sync', 'configs');
const RUN = Date.now();
const FIRST = `f362-first-${RUN}`;
const ADDED = `f362-added-${RUN}`;

let admin, mcp, netId, roundId;

before(async () => {
  admin = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
  for (const id of [FIRST, ADDED]) {
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
  for (const id of [FIRST, ADDED]) await delWithBody(INSTANCES.a, admin, `/api/spaces/${id}`, { confirm: true }).catch(() => {});
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

  it('network_sync_history answers what GET /sync-history answers', async () => {
    const rest = await get(INSTANCES.a, admin, `/api/networks/${netId}/sync-history?limit=5`);
    const viaMcp = await tool('network_sync_history', { id: netId, limit: 5 });
    assert.equal(viaMcp.isError, false, viaMcp.text);
    assert.deepEqual(viaMcp.body, rest.body);
  });
});
