/**
 * The hold reaches the doors that take their space from the BODY - recall and similar on REST, the generic tool door and MCP - for a peer token (bundle-106, §3.3 v4 (5), R-W13, X17, TS-7).
 *
 * ## What was true before
 *
 * The hold covered the routes with a space in the PATH. `POST /api/brain/recall` and `/similar` read `space` from the body and resolve it through the tool dispatch, so a peer
 * token whose rights matrix reached a held space read it there: the one door that returns what a wipe is about to delete. The tool door is the same dispatch, and so is MCP.
 *
 * ## What holds now (bundle-47, Q-244)
 *
 * Q-244 confines a peer-bound token to the sync doors: token resolution answers it `403 { code: 'peer_door' }` on every route but `/api/sync/*`,
 * `GET`/`POST /api/files/:spaceId` and `POST /api/notify`, `/mcp` included (an HTTP `403` with a JSON body, not a tool error result). Recall and
 * similar, REST, the generic tool door and MCP, are not among them, so a peer token never reaches the body-scoped hold on them: it is refused before the
 * space is read from the body, whether the body names a held space, a free one or none.
 *
 * - a peer token NAMING a held space on any of the four doors is answered `403 peer_door`, never `423 space_held` (on MCP the refusal is the HTTP answer);
 * - a peer token that OMITS the space finds no seed on either door, the one that lives only in the held space and the one in a space nothing holds alike:
 *   the answer is the refusal, never the search's own failure, which would mean a seed was located. The positive twin is the operator: its `similar`
 *   locates the seed in the free space, so a seed that is not found is a refusal and not a probe that cannot see seeds;
 * - the same token naming a space nothing holds is refused the same way (the refusal is about the token kind, not the hold), and an instance-admin token
 *   naming the held space is neither held nor refused as a peer (the operator's own tooling).
 *
 * ## What this stack cannot show, stated
 *
 * A door recall embeds its query first, and the harness keeps the local model offline with no model cached, so a recall here gets no vector and
 * "the held space is absent from a `recall` result list" has no list to read (the test Mongo has no search service either): a recall
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
 * resolution -> the named-space and seed rows red; drop it from the tool guard only -> the MCP and tool-door rows red. At the bundle-47 server the rows as bundle-106 wrote them
 * (`423` on the held space, a located seed in the free one) fail with the `peer_door` refusal.
 *
 * Run: a Mongo the harness accepts, then node --test testing/standalone/a-peer-token-meets-a-held-space-on-the-search-doors-db.test.js
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { build, ADMIN_TOKEN } from './_push-door.mjs';
import { openPullDoor, PEER } from './_pull-door.mjs';
import { listenApp } from '../_shared/in-process-app.mjs';
import { isPeerDoorRefusal } from './_peer-door.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();

const HELD = 'searchheld';
const FREE = 'searchfree';
const HOUR = 3_600_000;
const NOW = Date.now();
const iso = (ms) => new Date(ms).toISOString();
/**
 * What `similar` answers once it has LOCATED its seed: the store cannot search ("unavailable"), or the seed exists and has no vector yet
 * ("exists in space"). Both come after the seed lookup (brain/recall.ts findSimilar resolves the seed first), and a pushed seed carries
 * no vector here (a receiver embeds by its own rules), so on this stack either is the sign a seed was reached; a seed that was not
 * reached is a plain "not found".
 */
const SEARCH_FAILED = /vectorSearch|Semantic recall is unavailable|unavailable|exists in space/i;

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
  return { status: r.status, code: rpc.code, isError: rpc.result?.isError === true, text: (rpc.result?.content ?? []).map(c => c.text ?? '').join('\n') || JSON.stringify(rpc).slice(0, 300) };
}
const held = (r) => r.status === 423 && (r.body?.code === 'space_held' || /space_held/.test(r.text));
/** The peer-door refusal on either door: REST answers it in the body, `/mcp` as the HTTP answer itself (`code` read from its JSON body). */
const peerDoor = isPeerDoorRefusal;

describe('a peer token meets a held space on the body-scoped search doors', { skip }, () => {
  before(async () => {
    door = await openPullDoor({ suite: 'searchdoors', spaces: [HELD, FREE], type: 'club', direction: 'both', files: true });
    loader = await import('../../server/dist/config/loader.js');
    const tokens = await import('../../server/dist/auth/tokens.js');
    const { SPACE_AREAS } = await import('../../server/dist/config/rights-shape.js');
    const area = Object.fromEntries(SPACE_AREAS.map(a => [a, 'write']));
    peerKey = (await tokens.createToken({ name: 'peer', peerInstanceId: PEER, rights: { instanceAdmin: false, createSpaces: false, floor: null, perSpace: { [HELD]: area, [FREE]: area } } })).plaintext;
    adminKey = (await tokens.createToken({ name: 'admin', admin: true })).plaintext;
    server = await listenApp();
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

  it('a peer token naming the held space is answered 403 peer_door on recall, similar and the generic tool door, never 423', async () => {
    const answers = {
      'POST /api/brain/recall': await post('/api/brain/recall', peerKey, { query: 'hello', space: HELD }),
      'POST /api/brain/similar': await post('/api/brain/similar', peerKey, { entryId: '11111111-1111-4111-8111-111111111111', entryType: 'fact', space: HELD }),
      'POST /api/recall': await post('/api/recall', peerKey, { query: 'hello', space: HELD }),
    };
    const notRefused = Object.entries(answers).filter(([, r]) => !peerDoor(r) || held(r)).map(([door_, r]) => `${door_} -> ${r.status} ${r.text.slice(0, 100)}`);
    assert.deepEqual(notRefused, [], 'a peer token was not refused as a peer on a door that takes the space from the body:\n  ' + notRefused.join('\n  '));
  });

  it('the same on MCP: a peer token\'s recall of the held space is the HTTP answer 403 peer_door, not a tool result', async () => {
    const r = await mcp(peerKey, 'recall', { query: 'hello', space: HELD });
    assert.ok(peerDoor(r) && !r.isError, `MCP answered a peer token's recall of a held space with: ${r.status} ${r.isError ? 'error' : 'result'} ${r.text.slice(0, 160)}`);
  });

  it('a peer token that omits the space is refused peer_door for the seed that lives only in the held space and for the one in a free space; the operator locates the free one (twin)', async () => {
    const free = await post('/api/brain/similar', adminKey, { entryId: '22222222-2222-4222-8222-222222222222', entryType: 'fact' });
    assert.ok(SEARCH_FAILED.test(free.text), `the twin failed: the operator did not locate the seed in the free space (${free.status} ${free.text.slice(0, 160)}), so a refused seed would prove nothing`);
    for (const [seed, id] of [['held', '11111111-1111-4111-8111-111111111111'], ['free', '22222222-2222-4222-8222-222222222222']]) {
      const viaRest = await post('/api/brain/similar', peerKey, { entryId: id, entryType: 'fact' });
      assert.ok(peerDoor(viaRest) && !SEARCH_FAILED.test(viaRest.text), `a peer token that did not name the space was not refused for the ${seed} seed (${viaRest.status} ${viaRest.text.slice(0, 160)})`);
      const viaMcp = await mcp(peerKey, 'similar', { entryId: id, entryType: 'fact' });
      assert.ok(peerDoor(viaMcp) && !SEARCH_FAILED.test(viaMcp.text), `MCP did not refuse a peer token the ${seed} seed: ${viaMcp.status} ${viaMcp.text.slice(0, 160)}`);
    }
  });

  it('controls: the same peer token naming a free space is refused the same way (not a hold), and an admin token naming the held one is neither held nor refused as a peer', async () => {
    const free = await post('/api/brain/recall', peerKey, { query: 'hello', space: FREE });
    assert.ok(peerDoor(free) && !held(free), `a space nothing holds was not refused as a peer: ${free.status} ${free.text.slice(0, 160)}`);
    const admin = await post('/api/brain/recall', adminKey, { query: 'hello', space: HELD });
    assert.ok(!held(admin), 'an instance-admin token was held as if it were the exchange');
    assert.ok(!peerDoor(admin), 'an instance-admin token was refused as a peer');
  });
});
