/**
 * Every sync door gives the same verdict for the same cycle: the dedicated REST network door, the dedicated REST peer door,
 * the generic `POST /api/network_sync` (network, peer, all networks) and MCP `network_sync` (network, peer, all networks)
 * answer one cycle with the same outcome, `ok`, `members[]`, code and HTTP status (bundle-39, Q-331).
 *
 * ## The failure that bought it
 *
 * `POST /api/networks/:id/sync?wait=true` answered `200 { ok: true, status: 'completed' }` for a cycle in which EVERY member
 * failed; the MCP tool answered `isError` for the same cycle from an error count written by hand in each of its three
 * branches; the generic `POST /api/network_sync` answered 422. Nobody was told which member failed. Owner, 2026-11-01:
 * "how can they differ? its different doors to the same house?? the answer should be truthful".
 *
 * ## What is driven
 *
 * The real engine and the real doors against fake peers. The first member is the pull door's fake peer (`_pull-door.mjs`),
 * the second a small server of this file that answers every family empty (`ok`) or 500 (`fail`). The application is served in
 * process (REST doors, over `fetch` with an admin token) and `callTool` is called as MCP reaches it. One cycle at a time, per door.
 *
 *  | case                                        | first member | second member | network door              | peer doors (first / second) |
 *  |---------------------------------------------|--------------|---------------|---------------------------|-----------------------------|
 *  | every member synced                         | synced       | -             | success, 200              | success                     |
 *  | one synced, one failed (peer 500)           | synced       | 500           | partial, 200, ok false    | success / failed 502        |
 *  | every member failed (peer 500)              | 500          | 500           | failed, 502 sync_failed   | failed 502 / failed 502     |
 *  | this instance's store failed on the member  | local fault  | -             | failed, 503 sync_store_failed | failed 503              |
 *  | one local fault, one synced                 | local fault  | synced        | partial, 200              | failed 503 / success        |
 *  | one local fault, one failed                 | local fault  | 500           | failed, 502 sync_failed   | failed 503 / failed 502     |
 *
 * The local fault is a write the DATABASE refuses (a `MongoServerError`, code 13) on the page a member's pull lands, carrying
 * the driver's text (an internal host and port): a member-level store fault, which the cycle catches per member (a throw
 * OUTSIDE the member loop is `a-sync-trigger-answers-a-store-failure-in-our-words`).
 *
 * ## What each case asserts
 *
 *  - every door of one subject (a network: five doors; a peer: three) gives ONE view: outcome, ok, code, and members as
 *    `{ networkId, instanceId, label, outcome, reason }`; and that view is the one the table says (`sync-verdict-is-one-table`);
 *  - the HTTP status is the same on every REST door of the subject: 200, 502 `sync_failed`, or 503 `sync_store_failed`;
 *  - every door carries `refused`, the count of `peer-too-old` members (0 when none), and it is part of the compared view (a member below
 *    the version floor is pinned for the two too-old cases; the dedicated network door and the MCP network branch answered without it);
 *  - MCP `isError` is `!ok`;
 *  - no answer, `reason` included, carries the driver's text or the peer's own error text (our sentence per outcome; the log has the rest);
 *  - `wait=false` answers `ok: true, status: 'triggered'` on every door (the request was accepted; the cycle has no outcome yet).
 *
 * The `members[].outcome` words, the `outcome` words and the codes are the plan's (D2 v3 / v5): see `sync-verdict-is-one-table`.
 *
 * Red at a0efade0a: a waited answer has no `outcome` and no `members`, REST says `ok: true` for every cycle that ran, MCP says
 * `isError` by an error count, the generic door answers 422, and an all-failed cycle answers 200.
 *
 * Run: a Mongo the harness accepts (`npm run test:up`), then
 *      node --test testing/standalone/every-sync-door-gives-the-same-verdict-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason, privateHostAddress } from './_private-address.mjs';
import { build } from './_push-door.mjs';
import { openPullDoor, PEER, PEER_LABEL, PEER_AUTHOR } from './_pull-door.mjs';
import { clearPositionMarks, positioned } from './_b81b-positions.mjs';
import { listenApp } from '../_shared/in-process-app.mjs';
import { waitFor } from '../_shared/wait-for.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();

// Eight doors, six cases, one credential: the limiter answers 429 before the sync is reached (as in the every-door store gate).
for (const k of ['SKIP_GLOBAL_RATE_LIMIT', 'SKIP_AUTH_RATE_LIMIT', 'SKIP_SYNC_RATE_LIMIT']) process.env[k] = 'true';
process.env['YTHRIL_RATE_LIMIT_PER_MINUTE'] ??= '1000000';

const { MongoServerError } = createRequire(path.resolve('server/package.json'))('mongodb');

const S = 'doorverdict';
const SECOND = 'dv-second';
const SECOND_LABEL = 'Second peer';
/** Text a driver error or a peer's body carries and no answer may repeat: an internal host and port, and the peer's own words. */
const LEAK = /10\.1\.2\.3|27017|kaboom-7731|10\.9\.9\.9/;

let door, engine, server, base, adminKey, callTool, ADMIN, getConfig, getSecrets, second, secondMode = 'ok', secondRequests = [];

/** The second member's server: every replicated family answered empty (`ok`) or 500 (`fail`), nothing else served. */
async function startSecond(families) {
  const head = Date.now() * 1000;
  const srv = http.createServer((req, res) => {
    secondRequests.push(`${req.method} ${req.url}`);
    const send = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (secondMode === 'fail') { send(500, { error: 'kaboom-7731 at 10.9.9.9' }); return; }
    const m = new URL(req.url, 'http://x').pathname.match(/^\/api\/sync\/([a-z]+)$/);
    if (req.method === 'GET' && m && (m[1] === 'tombstones' || families.includes(m[1]))) {
      send(200, { items: [], nextCursor: null, through: head, head, positions: 1 });
      return;
    }
    send(404, { error: 'not served by the second fake peer' });
  });
  // own-listener: binds every interface so the LAN address answers, because the SSRF guards block loopback
  await new Promise(resolve => srv.listen(0, '0.0.0.0', resolve));
  return srv;
}

const networkConfig = () => getConfig().networks.find(n => n.id === door.NET);

/** Put the second member in the network (or take it out), with a token stored for it. */
function setSecond(mode) {
  const net = networkConfig();
  net.members = net.members.filter(m => m.instanceId !== SECOND);
  if (mode === null) return;
  secondMode = mode;
  net.members.push({ instanceId: SECOND, label: SECOND_LABEL, url: `http://${privateHostAddress()}:${second.address().port}`, tokenHash: 'x', direction: 'pull' });
  getSecrets().peerTokens ??= {};
  getSecrets().peerTokens[SECOND] = 'dv-second-token';
}

/**
 * The first member's behaviour: `ok` serves the pull door's empty pages; `500` answers every record family 500; `fault` serves a
 * fact the page of which this instance's database then refuses to write (the faulting write is installed by {@link failWrites}).
 */
async function setFirst(mode) {
  door.state.family = null;
  if (mode === '500') door.state.family = (_req, res) => { res.status(500).json({ error: 'kaboom-7731 at 10.9.9.9' }); };
  // Below the floor on evidence (as `a-peer-below-the-floor-is-refused` pins it): the member's turn ends as `peer-too-old` before anything is exchanged.
  if (mode === 'too-old') { door.member().version = '1.0.0'; door.member().versionCheckedAt = new Date().toISOString(); }
  if (mode === 'fault') {
    door.state.family = door.serveFamily;
    await door.seedPeerRecords(S, 'facts', [positioned(build.fact(S, 'dv-fact-1', 101, { author: PEER_AUTHOR }))]);
  }
}

/** Make the database refuse the writes to the space's facts, with the driver's own text; returns the undo. */
function failWrites() {
  const proto = Object.getPrototypeOf(door.mongo.col('probe'));
  const METHODS = ['bulkWrite', 'replaceOne', 'insertOne', 'insertMany', 'updateOne', 'updateMany', 'findOneAndReplace', 'findOneAndUpdate'];
  const originals = Object.fromEntries(METHODS.map(m => [m, proto[m]]));
  let hits = 0;
  for (const m of METHODS) {
    proto[m] = function faulty(...args) {
      if (this.collectionName === `${S}_facts`) {
        hits++;
        return Promise.reject(new MongoServerError({ message: 'not authorized on ythril to execute command at 10.1.2.3:27017', code: 13, codeName: 'Unauthorized' }));
      }
      return originals[m].apply(this, args);
    };
  }
  return { hits: () => hits, undo: () => Object.assign(proto, originals) };
}

// ── the doors ────────────────────────────────────────────────────────────────────────────────────────────────────

async function rest(method, route) {
  const r = await fetch(base + route.path, {
    method,
    headers: { Authorization: `Bearer ${adminKey}`, ...(route.body ? { 'Content-Type': 'application/json' } : {}) },
    ...(route.body ? { body: JSON.stringify(route.body) } : {}),
    signal: AbortSignal.timeout(60_000),
  });
  const text = await r.text();
  let body; try { body = JSON.parse(text); } catch { body = undefined; }
  return { kind: 'rest', status: r.status, body, text };
}

async function mcp(args) {
  const out = await callTool({ name: 'network_sync', args,
    caller: { rights: ADMIN, ip: '127.0.0.1', authMethod: 'pat', oidcSubject: null, transport: 'mcp', tokenId: 't', tokenLabel: 't' } });
  return { kind: 'mcp', result: out.result, text: JSON.stringify(out.result) };
}

/** The doors of a subject. `wait` is passed explicitly: the generic door defaults to REST's `false`, MCP to `true`. */
const NETWORK_DOORS = (wait) => [
  ['REST POST /api/networks/:id/sync', () => rest('POST', { path: `/api/networks/${door.NET}/sync?wait=${wait}` })],
  ['generic POST /api/network_sync {networkId}', () => rest('POST', { path: '/api/network_sync', body: { networkId: door.NET, wait } })],
  ['generic POST /api/network_sync {} (all networks)', () => rest('POST', { path: '/api/network_sync', body: { wait } })],
  ['MCP network_sync {networkId}', () => mcp({ networkId: door.NET, wait })],
  ['MCP network_sync {} (all networks)', () => mcp({ wait })],
];
const PEER_DOORS = (peerId, wait) => [
  ['REST POST /api/networks/peers/:peerId/sync', () => rest('POST', { path: `/api/networks/peers/${peerId}/sync?wait=${wait}` })],
  ['generic POST /api/network_sync {peerId}', () => rest('POST', { path: '/api/network_sync', body: { peerId, wait } })],
  ['MCP network_sync {peerId}', () => mcp({ peerId, wait })],
];

/**
 * What a door answered, in the one shape the doors are compared in. The generic door carries the tool's answer in `data` (and
 * says `ok` by its own rule at the top); MCP carries it as `structuredContent`; the dedicated door's body IS the answer.
 */
const payloadOf = (answer) => (answer.kind === 'mcp'
  ? (answer.result.structuredContent ?? {})
  : (answer.body?.data && typeof answer.body.data === 'object' ? answer.body.data : (answer.body ?? {})));

function viewOf(answer) {
  const payload = payloadOf(answer);
  const code = payload.code ?? (answer.kind === 'rest' ? answer.body?.code : undefined);
  const members = (Array.isArray(payload.members) ? payload.members : [])
    .map(m => ({ networkId: m.networkId, instanceId: m.instanceId, label: m.label, outcome: m.outcome, reason: m.reason }))
    .sort((a, b) => String(a.instanceId).localeCompare(String(b.instanceId)));
  return { outcome: payload.outcome, ok: payload.ok, code, refused: payload.refused, members };
}

/** Wait until no cycle the last call started is still running (a `wait=false` trigger answers before its cycle ends). */
async function cyclesEnded() {
  let quiet = 0;
  await waitFor(async () => { quiet = engine.syncCyclesInFlight() === 0 ? quiet + 1 : 0; return quiet >= 3; }, 30_000, 100);
  await door.settled();
}

// ── the cases ────────────────────────────────────────────────────────────────────────────────────────────────────

const SUCCESS = { outcome: 'success', ok: true, http: 200 };
const PARTIAL = { outcome: 'partial', ok: false, http: 200 };
const FAILED_502 = { outcome: 'failed', ok: false, http: 502, code: 'sync_failed' };
const FAILED_503 = { outcome: 'failed', ok: false, http: 503, code: 'sync_store_failed' };

/** Each case: how each member behaves, what the network door says, and what the door of each peer says. `member` is the member's own outcome word. */
const CASES = [
  { name: 'every member synced', first: 'ok', second: null,
    network: { ...SUCCESS, members: { [PEER]: 'success' } },
    peers: { [PEER]: { ...SUCCESS, members: { [PEER]: 'success' } } } },
  { name: 'one member synced and the other failed (peer 500)', first: 'ok', second: 'fail',
    network: { ...PARTIAL, members: { [PEER]: 'success', [SECOND]: 'failed' } },
    peers: { [PEER]: { ...SUCCESS, members: { [PEER]: 'success' } }, [SECOND]: { ...FAILED_502, members: { [SECOND]: 'failed' } } } },
  { name: 'every member failed (peer 500)', first: '500', second: 'fail',
    network: { ...FAILED_502, members: { [PEER]: 'failed', [SECOND]: 'failed' } },
    peers: { [PEER]: { ...FAILED_502, members: { [PEER]: 'failed' } }, [SECOND]: { ...FAILED_502, members: { [SECOND]: 'failed' } } } },
  { name: 'this instance\'s database failed on the only member (a member-level store fault)', first: 'fault', second: null,
    network: { ...FAILED_503, members: { [PEER]: 'local-fault' } },
    peers: { [PEER]: { ...FAILED_503, members: { [PEER]: 'local-fault' } } } },
  { name: 'a local fault on one member and the other synced', first: 'fault', second: 'ok',
    network: { ...PARTIAL, members: { [PEER]: 'local-fault', [SECOND]: 'success' } },
    peers: { [PEER]: { ...FAILED_503, members: { [PEER]: 'local-fault' } }, [SECOND]: { ...SUCCESS, members: { [SECOND]: 'success' } } } },
  { name: 'a local fault on one member and the other failed: nobody succeeded and not all are this instance\'s', first: 'fault', second: 'fail',
    network: { ...FAILED_502, members: { [PEER]: 'local-fault', [SECOND]: 'failed' } },
    peers: { [PEER]: { ...FAILED_503, members: { [PEER]: 'local-fault' } }, [SECOND]: { ...FAILED_502, members: { [SECOND]: 'failed' } } } },
  { name: 'the only member is below the version floor (too old)', first: 'too-old', second: null,
    network: { outcome: 'refused', ok: false, http: 200, refused: 1, members: { [PEER]: 'peer-too-old' } },
    peers: { [PEER]: { outcome: 'refused', ok: false, http: 200, refused: 1, members: { [PEER]: 'peer-too-old' } } } },
  { name: 'one member is too old and the other synced', first: 'too-old', second: 'ok',
    network: { ...PARTIAL, refused: 1, members: { [PEER]: 'peer-too-old', [SECOND]: 'success' } },
    peers: { [PEER]: { outcome: 'refused', ok: false, http: 200, refused: 1, members: { [PEER]: 'peer-too-old' } }, [SECOND]: { ...SUCCESS, members: { [SECOND]: 'success' } } } },
];

const LABEL_OF = { [PEER]: PEER_LABEL, [SECOND]: SECOND_LABEL };

/** One door's answer held to the verdict the table gives it, and to nothing the driver or the peer said. */
function assertAnswer(doorName, answer, want) {
  const v = viewOf(answer);
  const where = `${doorName}: ${answer.text.slice(0, 600)}`;
  assert.doesNotMatch(answer.text, LEAK, `${doorName} answered with the driver's or the peer's text: ${answer.text.slice(0, 600)}`);
  assert.equal(v.outcome, want.outcome, `outcome: ${where}`);
  assert.equal(v.ok, want.ok, `ok: ${where}`);
  assert.equal(v.code, want.code, `code: ${where}`);
  // The count of members the peer's age ended (`peer-too-old`), on every door of every subject, zero when none: one field set for one house.
  assert.equal(v.refused, want.refused ?? 0, `refused: ${where}`);
  if (answer.kind === 'rest') assert.equal(answer.status, want.http, `HTTP status: ${where}`);
  else assert.equal(answer.result.isError === true, !want.ok, `isError is not !ok: ${where}`);
  assert.deepEqual(v.members.map(m => [m.instanceId, m.outcome]), Object.entries(want.members).sort(([a], [b]) => a.localeCompare(b)),
    `members (instanceId, outcome): ${where}`);
  for (const m of v.members) {
    assert.equal(m.networkId, door.NET, `member networkId: ${where}`);
    assert.equal(m.label, LABEL_OF[m.instanceId], `member label: ${where}`);
    assert.ok(typeof m.reason === 'string' && m.reason.length > 0 && m.reason.length <= 200, `member reason is not one short sentence of ours (${String(m.reason)}): ${where}`);
  }
  return v;
}

describe('every sync door gives the same verdict for the same cycle', { skip }, () => {
  before(async () => {
    door = await openPullDoor({ suite: 'dverdict', spaces: [S], direction: 'pull' });
    engine = await import('../../server/dist/sync/engine.js');
    ({ callTool } = await import('../../server/dist/mcp/call-tool.js'));
    ({ getConfig, getSecrets } = await import('../../server/dist/config/loader.js'));
    const { SPACE_AREAS } = await import('../../server/dist/config/rights-shape.js');
    ADMIN = { instanceAdmin: true, createSpaces: true, perSpace: {}, floor: Object.fromEntries(SPACE_AREAS.map(a => [a, 'admin'])) };
    adminKey = (await (await import('../../server/dist/auth/tokens.js')).createToken({ name: 'admin', admin: true })).plaintext;
    const families = (await import('../../server/dist/sync/replicated-families.js')).REPLICATED_FAMILIES.map(f => f.payloadKey);
    second = await startSecond(families);
    server = await listenApp();
    base = server.url;
  });
  after(async () => {
    await cyclesEnded().catch(() => undefined);
    await server?.close();
    await new Promise(r => (second ? second.close(r) : r()));
    await door?.close();
  });
  beforeEach(async () => {
    await door.reset({ direction: 'pull' });
    clearPositionMarks(door);
    door.member().consecutiveFailures = 0;
    delete door.member().version;
    delete door.member().versionCheckedAt;
    secondRequests = [];
    setSecond(null);
  });

  for (const c of CASES) {
    it(c.name + ': every door of the network gives one verdict', async () => {
      setSecond(c.second);
      await setFirst(c.first);
      const fault = c.first === 'fault' ? failWrites() : null;
      const views = [];
      try {
        for (const [name, call] of NETWORK_DOORS(true)) {
          const answer = await call();
          await door.settled();
          views.push([name, assertAnswer(name, answer, c.network)]);
        }
      } finally { fault?.undo(); }
      if (fault) assert.ok(fault.hits() > 0, 'fixture check: the injected write fault was never reached, so no member met a local fault');
      if (c.second === 'fail') assert.ok(secondRequests.length > 0, 'fixture check: the failing second member was never asked');
      // One view: every door of the subject says the same thing, member by member and word by word.
      for (const [name, v] of views.slice(1)) assert.deepEqual(v, views[0][1], `${name} disagrees with ${views[0][0]}`);
    });

    it(c.name + ': every door of each peer gives one verdict', async () => {
      setSecond(c.second);
      await setFirst(c.first);
      const fault = c.first === 'fault' ? failWrites() : null;
      try {
        for (const [peerId, want] of Object.entries(c.peers)) {
          const views = [];
          for (const [name, call] of PEER_DOORS(peerId, true)) {
            const answer = await call();
            await door.settled();
            views.push([`${name} (${peerId})`, assertAnswer(`${name} (${peerId})`, answer, want)]);
          }
          for (const [name, v] of views.slice(1)) assert.deepEqual(v, views[0][1], `${name} disagrees with ${views[0][0]}`);
        }
      } finally { fault?.undo(); }
    });
  }

  it('wait=false answers ok: true and status triggered on every door', async () => {
    setSecond('ok');
    await setFirst('ok');
    const doors = [...NETWORK_DOORS(false), ...PEER_DOORS(PEER, false)];
    assert.equal(doors.length, 8, 'fixture check: a door was dropped from the wait=false list');
    for (const [name, call] of doors) {
      const answer = await call();
      const v = viewOf(answer);
      const where = `${name}: ${answer.text.slice(0, 400)}`;
      assert.equal(v.ok, true, `ok: ${where}`);
      assert.equal(payloadOf(answer).status, 'triggered', `status: ${where}`);
      if (answer.kind === 'rest') assert.equal(answer.status, 200, `HTTP status: ${where}`);
      else assert.notEqual(answer.result.isError, true, `isError: ${where}`);
      await cyclesEnded();
    }
  });
});
