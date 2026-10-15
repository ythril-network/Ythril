/**
 * The hold reaches the doors that take their space from the BODY - recall and similar on REST, the generic tool door and MCP - for a peer token (bundle-106, §3.3 v4 (5), R-W13, X17, TS-7).
 *
 * ## What was true before
 *
 * The hold covered the routes with a space in the PATH. `POST /api/brain/recall` and `/similar` read `space` from the body and resolve it through the tool dispatch, so a peer
 * token whose rights matrix reached a held space read it there: the one door that returns what a wipe is about to delete. The tool door is the same dispatch, and so is MCP.
 *
 * ## What holds now
 *
 * - a peer token NAMING a held space on any of the four doors is answered `423` (`space_held`; on MCP, an error result that says the space is held);
 * - a peer token that OMITS the space does not find a held space's records: a seed entry that lives only in the held space is not located (the answer is "not found", never the
 *   search's own failure, which would mean it was found and searched), while the same seed in a space nothing holds IS located - the positive twin;
 * - the same token naming a space nothing holds is not refused for a hold, and an instance-admin token naming the held space is not either (the operator's own tooling).
 *
 * ## What this stack cannot show, stated
 *
 * The test Mongo here answers every semantic search with "`$vectorSearch` is not supported", so "the held space is absent from a `recall` result list" has no list to read: a recall
 * that omits `space` is covered through the seed lookup of `similar`, which is resolved before any vector is asked for. The result-list half needs the stack with the search service.
 *
 * ## How it is driven
 *
 * The REAL application over a loopback socket (`createApp`), a real peer token (`createToken({ peerInstanceId })`) with a rights matrix over both spaces, the real auth, rung and
 * body-scope layers (a handler called alone would skip exactly the layers where the hold lives). The held state is an applied wipe round with no evidence that the peer concluded it.
 *
 * ## Seen red
 *
 * At a638e702 no body-scoped door asks a hold: the named-space rows answer 400 (the search service) or 200, the seed is located. After the fix, by hand: drop the hold from the body-scoped
 * resolution -> the named-space and seed rows red; drop it from the tool guard only -> the MCP and tool-door rows red.
 *
 * Run: a Mongo the harness accepts, then node --test testing/standalone/a-peer-token-meets-a-held-space-on-the-search-doors-db.test.js
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { build, ADMIN_TOKEN } from './_push-door.mjs';
import { openPullDoor, PEER } from './_pull-door.mjs';
import { listenOnLoopback } from '../_shared/local-server.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();

const HELD = 'searchheld';
const FREE = 'searchfree';
const HOUR = 3_600_000;
const NOW = Date.now();
const iso = (ms) => new Date(ms).toISOString();
/** What this stack's search answers when a vector IS asked for: a seed that reached it was found. */
const SEARCH_FAILED = /vectorSearch|Semantic recall is unavailable|unavailable/i;

let door, loader, server, peerKey, adminKey;

const wipeRound = () => ({
  roundId: 'sr-w', type: 'space_wipe', spaceId: HELD, subjectInstanceId: door.instanceId, subjectLabel: 'x', subjectUrl: '',
  openedAt: iso(NOW - HOUR), deadline: iso(NOW + 23 * HOUR), votes: [{ instanceId: door.instanceId, vote: 'yes', castAt: iso(NOW - HOUR) }],
  concluded: true, passed: true, appliedHere: true, proposedHere: true,
});

async function post(path, key, body) {
  const r = await fetch(`${server.url}${path}`, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const text = await r.text();
  let parsed; try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
  return { status: r.status, body: parsed, text };
}
async function mcp(key, name, args) {
  const r = await fetch(`${server.url}/mcp`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  const raw = await r.text();
  const data = raw.startsWith('event:') || raw.startsWith('data:') ? raw.split('\n').find(l => l.startsWith('data:'))?.slice(5) ?? '{}' : raw;
  const rpc = JSON.parse(data);
  return { status: r.status, isError: rpc.result?.isError === true, text: (rpc.result?.content ?? []).map(c => c.text ?? '').join('\n') };
}
const held = (r) => r.status === 423 && (r.body?.code === 'space_held' || /space_held/.test(r.text));

describe('a peer token meets a held space on the body-scoped search doors', { skip }, () => {
  before(async () => {
    door = await openPullDoor({ suite: 'searchdoors', spaces: [HELD, FREE], type: 'club', direction: 'both', files: true });
    loader = await import('../../server/dist/config/loader.js');
    const tokens = await import('../../server/dist/auth/tokens.js');
    const { SPACE_AREAS } = await import('../../server/dist/config/rights-shape.js');
    const area = Object.fromEntries(SPACE_AREAS.map(a => [a, 'write']));
    peerKey = (await tokens.createToken({ name: 'peer', peerInstanceId: PEER, rights: { instanceAdmin: false, createSpaces: false, floor: null, perSpace: { [HELD]: area, [FREE]: area } } })).plaintext;
    adminKey = (await tokens.createToken({ name: 'admin', admin: true })).plaintext;
    const { createApp } = await import('../../server/dist/app.js');
    server = await listenOnLoopback(http.createServer(createApp()));
  });
  after(async () => { await server?.close(); await door?.close(); });

  beforeEach(async () => {
    await door.reset();
    loader.mutateConfig((cfg) => { const net = cfg.networks.find(n => n.id === door.NET); net.pendingRounds = [wipeRound()]; net.spaces = [HELD, FREE]; });
    for (const [space, id] of [[HELD, '11111111-1111-4111-8111-111111111111'], [FREE, '22222222-2222-4222-8222-222222222222']]) {
      const r = await door.push('/batch-upsert', { facts: [build.fact(space, id, 3)] }, { spaceId: space, networkId: door.NET, token: ADMIN_TOKEN });
      assert.equal(r.code, 200, `seeding ${space} failed: ${JSON.stringify(r.body)}`);
    }
  });

  it('a peer token naming the held space is answered 423 on recall, similar and the generic tool door', async () => {
    const answers = {
      'POST /api/brain/recall': await post('/api/brain/recall', peerKey, { query: 'hello', space: HELD }),
      'POST /api/brain/similar': await post('/api/brain/similar', peerKey, { entryId: '11111111-1111-4111-8111-111111111111', entryType: 'fact', space: HELD }),
      'POST /api/recall': await post('/api/recall', peerKey, { query: 'hello', space: HELD }),
    };
    const notHeld = Object.entries(answers).filter(([, r]) => !held(r)).map(([door_, r]) => `${door_} -> ${r.status} ${r.text.slice(0, 100)}`);
    assert.deepEqual(notHeld, [], 'a peer token read a space whose wipe only this side has applied through a door that takes the space from the body:\n  ' + notHeld.join('\n  '));
  });

  it('the same on MCP: a peer token\'s recall of the held space is an error result that says it is held', async () => {
    const r = await mcp(peerKey, 'recall', { query: 'hello', space: HELD });
    assert.ok(r.isError && /held/i.test(r.text), `MCP answered a peer token's recall of a held space with: ${r.isError ? 'error' : 'result'} ${r.text.slice(0, 160)}`);
  });

  it('a peer token that omits the space does not find a seed that lives only in the held space; the same seed in a free space is found (twin)', async () => {
    const free = await post('/api/brain/similar', peerKey, { entryId: '22222222-2222-4222-8222-222222222222', entryType: 'fact' });
    assert.ok(SEARCH_FAILED.test(free.text), `the twin failed: the seed in the free space was not located (${free.status} ${free.text.slice(0, 160)}), so the held seed's "not found" would prove nothing`);
    const heldSeed = await post('/api/brain/similar', peerKey, { entryId: '11111111-1111-4111-8111-111111111111', entryType: 'fact' });
    assert.ok(!SEARCH_FAILED.test(heldSeed.text), `the seed entry of a held space was located by a peer token that did not name the space (${heldSeed.status} ${heldSeed.text.slice(0, 160)})`);
    const viaMcp = await mcp(peerKey, 'similar', { entryId: '11111111-1111-4111-8111-111111111111', entryType: 'fact' });
    assert.ok(!SEARCH_FAILED.test(viaMcp.text), `MCP located the held space's seed for a peer token: ${viaMcp.text.slice(0, 160)}`);
  });

  it('controls: the same peer token naming a free space, and an admin token naming the held one, are not refused for a hold', async () => {
    const free = await post('/api/brain/recall', peerKey, { query: 'hello', space: FREE });
    assert.ok(!held(free), 'a space nothing holds was answered 423');
    const admin = await post('/api/brain/recall', adminKey, { query: 'hello', space: HELD });
    assert.ok(!held(admin), 'an instance-admin token was held as if it were the exchange');
  });
});
