/**
 * A peer-bound token reaches only the doors the sync protocol uses (bundle-47, Q-244).
 *
 * ## The rule
 *
 * A peer token is a peer's SYNC credential. The doors a peer calls are the sync routes (`/api/sync/*`), the file door's list,
 * download and upload (`GET` and `POST /api/files/:spaceId`, file sync's target) and `POST /api/notify`: every `peerSafeFetch` in
 * the sync engine, the same set since v6.0.0. On every other authenticated route, REST and `/mcp` alike, a peer-bound token is
 * answered `403 { code: 'peer_door' }` and nothing runs. On the file door it also meets the sync doors' own guards: a space no network
 * shared with that peer carries is refused, and an upload from a peer the network's direction does not let push here is refused.
 *
 * ## What was true before
 *
 * A peer token passed every route its rights matrix reached (`performAuth` refused only library tokens), so a pub/sub subscriber
 * could write its publisher's records and files with the token the publisher issued it, and the file door served and stored a space
 * the peer shares no network for.
 *
 * ## How the gate is derived, not listed
 *
 * Every route the server mounts (`mountedRoutes()`) is asked once with a bearer that resolves to nothing: a route that answers `401`
 * authenticates, and is then asked with the peer token, which must answer `403 peer_door` unless the route is one of the peer doors.
 * A route added later is covered without an edit here. The peer doors themselves are named below from the doneWhen, not read from
 * the server's list, so a door the server's list wrongly admits is a failure here.
 *
 * Run: a Mongo the harness accepts, then node --test testing/standalone/a-peer-token-reaches-only-the-peer-doors-db.test.js
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { openPullDoor, PEER } from './_pull-door.mjs';
import { listenApp } from '../_shared/in-process-app.mjs';
import { mountedRoutes } from './_routes.mjs';
import { isPeerDoorRefusal } from './_peer-door.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();
const S = 'peerdoors';
const OTHER = 'peerdoorsother';

/** The doors a peer calls, as the sync engine calls them (doneWhen of Q-244). */
function isPeerDoor(method, path) {
  if (path === '/api/sync' || path.startsWith('/api/sync/')) return true;
  if (path === '/api/files/:spaceId' && (method === 'GET' || method === 'POST')) return true;
  if (path === '/api/notify' && method === 'POST') return true;
  return false;
}

let door; let server; let peerKey; let adminKey;

/** A route pattern made concrete: a space parameter names the test space, every other parameter a value nothing matches. */
function concrete(path) {
  return path.replace(/:([A-Za-z_]+)\??/g, (_m, name) => (/space/i.test(name) ? S : `zq${name.toLowerCase()}`));
}

/**
 * One request. The body is read only when the answer is a refusal (4xx): a route that admits the token may answer a stream that does not
 * end (`/events`, `/logs/stream`), and the walk needs only to know that it was admitted, so that body is cancelled unread.
 */
async function ask(method, path, key, body) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 20_000);
  const init = { method, headers: { Authorization: `Bearer ${key}` }, signal: ac.signal };
  if (method !== 'GET' && method !== 'HEAD') { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body ?? {}); }
  const r = await fetch(`${server.url}${path}`, init);
  if (r.status < 400 || r.status >= 500) { ac.abort(); clearTimeout(timer); await r.body?.cancel().catch(() => undefined); return { status: r.status, body: {} }; }
  const text = await r.text().finally(() => clearTimeout(timer));
  let json = {};
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: r.status, body: json };
}

const upload = (space, path, key) => fetch(`${server.url}/api/files/${space}?path=${path}`, {
  method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/octet-stream' }, body: Buffer.from('x'),
});

describe('a peer-bound token reaches only the peer doors', { skip }, () => {
  before(async () => {
    door = await openPullDoor({ suite: 'peerdoors', spaces: [S], extraSpaces: [OTHER] });
    const tokens = await import('../../server/dist/auth/tokens.js');
    const { SPACE_AREAS } = await import('../../server/dist/config/rights-shape.js');
    const area = Object.fromEntries(SPACE_AREAS.map(a => [a, 'write']));
    peerKey = (await tokens.createToken({
      name: 'peer', peerInstanceId: PEER,
      rights: { instanceAdmin: false, createSpaces: false, floor: null, perSpace: { [S]: area, [OTHER]: area } },
    })).plaintext;
    adminKey = (await tokens.createToken({ name: 'admin', admin: true })).plaintext;
    server = await listenApp();
  });
  after(async () => { await server?.close(); await door?.close(); });
  beforeEach(async () => { await door.reset(); });

  it('every authenticated route but the peer doors answers a peer token 403 peer_door (derived from the mounted routes)', async () => {
    const asked = [];
    const open = [];
    for (const r of mountedRoutes()) {
      const method = r.method.toUpperCase();
      if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method) || r.path.includes('*') || r.path.includes('(')) continue;
      if (isPeerDoor(method, r.path)) continue;
      const path = concrete(r.path);
      const probe = await ask(method, path, 'ythril_zqnotatoken0000000000000000000000');
      if (probe.status !== 401) continue;   // a public route: it never resolves a token, so no token kind is refused there
      const a = await ask(method, path, peerKey);
      asked.push(`${method} ${r.path}`);
      if (!isPeerDoorRefusal(a)) open.push(`${method} ${r.path} -> ${a.status} ${JSON.stringify(a.body).slice(0, 120)}`);
    }
    assert.ok(asked.length >= 150, `only ${asked.length} authenticated route(s) were asked: the walk is wrong, not the code`);
    assert.deepEqual(open, [], `a peer-bound token passed ${open.length} route(s) that are not peer doors`);
  });

  it('/mcp answers a peer token 403 peer_door, so no tool is reachable', async () => {
    const r = await fetch(`${server.url}/mcp`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${peerKey}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    assert.equal(r.status, 403);
    assert.equal((await r.json()).code, 'peer_door');
  });

  it('the peer doors still admit the peer token: a sync page, the file list, a notice', async () => {
    const page = await ask('GET', `/api/sync/facts?spaceId=${S}&networkId=${door.NET}`, peerKey);
    assert.equal(page.status, 200, `the sync page refused the peer: ${JSON.stringify(page.body)}`);
    const list = await ask('GET', `/api/files/${S}`, peerKey);
    assert.equal(list.status, 200, `the file list refused the peer: ${JSON.stringify(list.body)}`);
    const notice = await ask('POST', '/api/notify', peerKey, { networkId: door.NET, instanceId: PEER, event: 'sync_available' });
    assert.notEqual(notice.body.code, 'peer_door', 'POST /api/notify is a peer door');
  });

  it('the file door refuses a peer a space no network shared with it carries, on list, download and upload; the operator is not refused', async () => {
    const list = await ask('GET', `/api/files/${OTHER}`, peerKey);
    assert.equal(list.status, 403, `the peer listed a space it shares no network for: ${list.status}`);
    const dl = await ask('GET', `/api/files/${OTHER}?path=a.txt`, peerKey);
    assert.equal(dl.status, 403, `the peer read a file of a space it shares no network for: ${dl.status}`);
    const up = await upload(OTHER, 'a.txt', peerKey);
    assert.equal(up.status, 403, `the peer wrote a file into a space it shares no network for: ${up.status}`);
    const own = await ask('GET', `/api/files/${OTHER}`, adminKey);
    assert.equal(own.status, 200, 'the operator was refused its own space');
  });

  it('the file door refuses an upload from a peer this instance only pushes to; a list is still served', async () => {
    door.configure({ direction: 'push' });
    const up = await upload(S, 'up.txt', peerKey);
    assert.equal(up.status, 403, `a push-only peer uploaded: ${up.status}`);
    const list = await ask('GET', `/api/files/${S}`, peerKey);
    assert.equal(list.status, 200, 'the direction guard refused a read');
  });
});
