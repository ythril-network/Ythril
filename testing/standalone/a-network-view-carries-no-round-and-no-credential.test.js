/**
 * No door that serves a network hands out a credential hash, a round, or the log of how rounds ended.
 *
 * ## What leaked
 *
 * `networkView` — the one builder behind `GET /api/networks`, `GET /api/networks/:id` and MCP `network_get` — destructured
 * out the network's own `inviteKeyHash` and each member's `tokenHash`, and then spread everything else: `...rest`. That
 * included `pendingRounds`, and a join round carries `inviteKeyHash` (the bcrypt of the invite key a joiner holds, kept so it
 * can poll its own round) and `pendingMember.tokenHash`. So a caller with only `networks: read` could read, from a body whose
 * own docblock says "no door can hand out a token hash", the hash of an invite key still in use. The rounds are read where
 * they belong — `GET /votes` and the outcome log's own door — and the network body carries neither them nor the log.
 *
 * ## What it holds, over EVERY door
 *
 * The doors are derived, not listed: every `networkView(` / `readNetworkAct(` call in `server/src` (floor), each driven here
 * through the route handler or act that makes it. Whatever such a door answers has no key ending in `hash` at any depth, no
 * `pendingRounds` and no `roundOutcomes`; and the body does still carry what a network view is for.
 *
 * Run: node --test testing/standalone/a-network-view-carries-no-round-and-no-credential.test.js  (requires a prior server build)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { trackedSources } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';
import { tempInstanceDir, removeInstanceDir, bootInstance, callRoute } from './_vote-round-instance.mjs';

const SELF = 'aaaaaaaa-0000-4000-8000-000000005e1f';
const P1 = 'aaaaaaaa-0000-4000-8000-0000000000a1';
const JOINER = 'aaaaaaaa-0000-4000-8000-0000000000b1';
const dir = tempInstanceDir('ythril-network-view-');
const SECRET = 'SECRET-HASH-VALUE';
const ADMIN = { rights: { instanceAdmin: true } };

const member = (instanceId, extra = {}) => ({ instanceId, label: `m${instanceId.slice(-2)}`, url: `https://${instanceId.slice(-2)}.example`, tokenHash: SECRET, direction: 'both', ...extra });
const NET = () => ({
  id: 'n', label: 'Net', type: 'closed', origin: 'created', syncSchedule: '', spaces: ['general'], votingDeadlineHours: 24,
  createdAt: '2026-01-01T00:00:00.000Z', inviteKeyHash: SECRET,
  members: [member(P1, { skipTlsVerify: true, tombstoneRereadAt: { general: 'x' } })],
  pendingRounds: [{
    roundId: 'r1', type: 'join', subjectInstanceId: JOINER, subjectLabel: 'Joiner', subjectUrl: '', openedAt: '2026-10-09T10:00:00.000Z',
    deadline: '2099-01-01T00:00:00.000Z', votes: [], concluded: false, inviteKeyHash: SECRET, pendingMember: member(JOINER),
  }],
  roundOutcomes: [{ roundId: 'r0', type: 'remove', outcome: 'expired', concludedAt: '2026-10-08T10:00:00.000Z', yes: 0, veto: 0, eligible: 2, subjectLabel: 'x', openedAt: 'x', deadline: 'x' }],
  introductions: [{ instanceId: 'i1', label: 'Intro', url: 'https://i1.example', introducedBy: P1, introducedAt: '2026-10-09T10:00:00.000Z' }],
});

/** Every key at every depth, with its path. */
function keysDeep(value, path = '$', out = []) {
  if (Array.isArray(value)) value.forEach((v, i) => keysDeep(v, `${path}[${i}]`, out));
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) { out.push({ key: k, path: `${path}.${k}` }); keysDeep(v, `${path}.${k}`, out); }
  return out;
}

describe('the doors are derived from the tree', () => {
  it('every networkView / readNetworkAct caller is one this test drives', () => {
    const files = trackedSources('server/src', { untracked: true, floor: 100 });
    const callers = files.filter(f => /(?<![.\w$])(?:networkView|readNetworkAct)\s*\(/.test(stripComments(fs.readFileSync(f, 'utf8')).replace(/export\s+function\s+(?:networkView|readNetworkAct)/g, '')));
    assert.ok(callers.length >= 3, `only ${callers.length} caller file(s) found: ${callers.join(', ')}`);
    const DRIVEN = ['server/src/networks/network-acts.ts', 'server/src/api/networks/crud.ts', 'server/src/mcp/tools/networks.ts', 'server/src/api/invite.ts'];
    const unknown = callers.filter(f => !DRIVEN.includes(f));
    assert.deepEqual(unknown, [], `these serve a network body through a door this test does not drive: ${unknown.join(', ')}`);
  });
});

describe('what a caller who may read a network is handed', () => {
  let loader;
  before(async () => {
    loader = await bootInstance(dir, { instanceId: SELF, networks: [NET()] });
  });
  after(() => removeInstanceDir(dir));

  const verify = (what, body) => {
    const keys = keysDeep(body);
    assert.ok(keys.length > 10, `${what}: the body is empty (${keys.length} keys) — the door answered nothing to check`);
    const hashes = keys.filter(k => /hash$/i.test(k.key)).map(k => k.path);
    assert.deepEqual(hashes, [], `${what} carries credential hash(es): ${hashes.join(', ')}`);
    assert.ok(!JSON.stringify(body).includes(SECRET), `${what}: a secret value is in the body`);
    for (const forbidden of ['pendingRounds', 'roundOutcomes']) {
      assert.ok(!keys.some(k => k.key === forbidden), `${what} carries ${forbidden}: the rounds are read where they belong (/votes, /vote-outcomes)`);
    }
    // And it is still a network view.
    const net = body.networks ? body.networks[0] : body;
    assert.equal(net.id, 'n');
    assert.equal(net.label, 'Net');
    assert.equal(net.members[0].instanceId, P1);
    assert.ok(net.myRole, 'the body lost the role this instance has in the network');
  };

  it('networkView itself', async () => {
    const { networkView } = await import('../../server/dist/networks/network-acts.js');
    verify('networkView', networkView(loader.getConfig().networks[0]));
  });

  it('readNetworkAct (REST GET /:id and MCP network_get)', async () => {
    const { readNetworkAct } = await import('../../server/dist/networks/network-acts.js');
    const res = readNetworkAct(ADMIN, 'n');
    assert.equal(res.status, 200);
    verify('readNetworkAct', res.body);
  });

  it('updateNetworkAct (REST PATCH /:id and MCP network_update)', async () => {
    const { updateNetworkAct } = await import('../../server/dist/networks/network-acts.js');
    const res = updateNetworkAct(ADMIN, 'n', { label: 'Net' });
    assert.equal(res.status, 200, JSON.stringify(res));
    verify('updateNetworkAct', res.body);
  });

  it('GET /api/networks (the list route)', async () => {
    const { crudRouter } = await import('../../server/dist/api/networks/crud.js');
    const res = await callRoute(crudRouter, 'get', '/', { authToken: ADMIN });
    assert.equal(res.code, 200);
    verify('GET /api/networks', res.body);
  });

  it('GET /api/networks/:id (the read route)', async () => {
    const { crudRouter } = await import('../../server/dist/api/networks/crud.js');
    const res = await callRoute(crudRouter, 'get', '/:id', { params: { id: 'n' }, authToken: ADMIN });
    assert.equal(res.code, 200);
    verify('GET /api/networks/:id', res.body);
  });

  it('the fixture would have been caught: the unredacted record does carry the hashes', () => {
    const raw = loader.getConfig().networks[0];
    assert.ok(keysDeep(raw).some(k => /hash$/i.test(k.key) && k.path.includes('pendingRounds')), 'the fixture holds no hash inside a round, so this test checks nothing');
  });
});
