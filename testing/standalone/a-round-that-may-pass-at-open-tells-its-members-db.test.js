/**
 * Every round that may pass at open is told to the members from ONE module, with the payloads the receiver reads (bundle-106 R5; design v5 section 1.6).
 *
 * ## The defect this holds
 *
 * "Tell the members to pull now" was written three times (`api/spaces.ts`, `spaces/wipe-vote.ts`, `spaces/meta-update.ts`), each a bare `fetch`-shaped copy
 * with its own timeout, its own log line and its own idea of who to tell: tokens read at SNAPSHOT time, recipients read AFTER the round acted (a deletion
 * that passed at open had already removed the space from the network), and a send that threw inside a `setImmediate` body was an `uncaughtException`.
 * Now that a round can pass at open, a member that is not told pulls at its next scheduled cycle — the stale window the notify exists to close.
 *
 * ## What each row drives
 *
 * Three fake peers record or refuse what the send posts: A answers `204`, B answers `500`, C resets the connection. A passed club deletion, a typed and
 * an untyped wipe, a club addition and a club meta change each go through their REAL door; the peer sees the event and the `data` the receiver's handler
 * reads (`api/notify.ts`). A failing peer still lets the door answer, and the log names the network id, the member id, the event and the round id.
 *
 * ## Absence is asserted next to its positive twin
 *
 * That B and C were tried and failed is read from the log AFTER the recording peer has seen its request: the same send path DID reach A (design X19, TS-6).
 *
 * Run: node --test testing/standalone/a-round-that-may-pass-at-open-tells-its-members-db.test.js
 * (requires a prior server build, the test MongoDB and a private LAN address, as every fake-peer test)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { privateHostAddress } from './_private-address.mjs';
import { removeInstanceDir, startFakePeer, allowEngineToDialPrivatePeers, callRoute } from './_vote-round-instance.mjs';
import { tempInstance, networkOf, boot, seedFacts, roundsOf, doors, databaseTakesCollections, warmSpaceCreation, until, ADMIN } from './_round-open-fixtures.mjs';

const dir = tempInstance('ythril-notify-');
const skip = (await mongoSkipReason()) || privateAddressSkipReason();
const A = 'aaaaaaaa-0000-4000-8000-0000000000c1';
const B = 'aaaaaaaa-0000-4000-8000-0000000000c2';
const C = 'aaaaaaaa-0000-4000-8000-0000000000c3';

/** Collect everything the process says while `fn` runs: the log goes to the console and stdout, whichever the logger picks. */
async function capturingLog(fn) {
  const lines = [];
  const orig = { log: console.log, info: console.info, warn: console.warn, error: console.error, write: process.stdout.write.bind(process.stdout) };
  for (const k of ['log', 'info', 'warn', 'error']) console[k] = (...a) => { lines.push(a.join(' ')); };
  process.stdout.write = (chunk, ...rest) => { lines.push(String(chunk)); return orig.write(chunk, ...rest); };
  try { return { result: await fn(lines), lines }; } finally { Object.assign(console, { log: orig.log, info: orig.info, warn: orig.warn, error: orig.error }); process.stdout.write = orig.write; }
}

describe('a round that may pass at open is told to every member from one module', { skip }, () => {
  let mongo; let a; let b; let cServer; let cUrl;
  before(async () => {
    allowEngineToDialPrivatePeers();
    a = await startFakePeer((method, url) => (url === '/api/notify' ? { status: 204, body: undefined } : undefined));
    b = await startFakePeer((method, url) => (url === '/api/notify' ? { status: 500, body: { error: 'down' } } : undefined));
    const host = privateHostAddress();
    cServer = http.createServer((req, res) => { req.on('data', () => {}); req.on('end', () => req.socket.destroy()); });
    // own-listener: binds the private LAN address, not loopback - the instance's peer fetch refuses a loopback peer (SSRF guard), as for startFakePeer
    await new Promise((resolve) => cServer.listen(0, host, resolve));
    cUrl = `http://${host}:${cServer.address().port}`;
    mongo = await openTestMongo('notify_members');
    await databaseTakesCollections(mongo);
    await boot(dir, { networks: [] });
    await warmSpaceCreation();
  });
  after(async () => { await a?.close(); await b?.close(); await new Promise(r => cServer?.close(r)); await closeTestMongo(); removeInstanceDir(dir); });

  const club = (extra = {}, spaces = ['general', 'notes']) => {
    const net = networkOf('club', [A, B, C], { spaces, extra });
    net.members[0].url = a.url; net.members[1].url = b.url; net.members[2].url = cUrl;
    return net;
  };
  const eventsAt = (peer) => peer.seen.filter(s => s.method === 'POST' && s.url === '/api/notify').map(s => JSON.parse(s.body));
  const bootClub = (extra, spaces) => boot(dir, { spaces: ['notes', 'extra'], networks: [club(extra, spaces)], peerTokens: { [A]: 'ta', [B]: 'tb', [C]: 'tc' } });

  it('the module names its timeout and the tell function the openers call (design: NOTIFY_SEND_TIMEOUT_MS = 5 000, notifyMembersToPull)', async () => {
    const mod = await import('../../server/dist/networks/notify-members.js').catch(() => null);
    assert.ok(mod, 'server/src/networks/notify-members.ts does not exist: the three copies of "tell the members to pull" are still three');
    assert.equal(mod.NOTIFY_SEND_TIMEOUT_MS, 5000);
    assert.equal(typeof mod.notifyMembersToPull, 'function');
  });

  it('a club deletion that passed at open: every member is told space_deletion_pending with the NETWORK\'s space id, though the space already left the network', async () => {
    const loader = await bootClub();
    await seedFacts(mongo, 'notes', 1, 'del');
    a.seen.length = 0;
    const { result: res, lines } = await capturingLog(async (captured) => {
      const r = await doors.deleteSpace('notes');
      await until(() => eventsAt(a).length > 0, 'the recording peer was told');
      await until(() => lines_has(captured, 'space_deletion_pending', B) && lines_has(captured, 'space_deletion_pending', C), 'the failing peers were logged', 8000);
      return r;
    });
    assert.equal(res.code, 200, `the door answered ${res.code}: a failing notify must never fail the request, and a deleted club space passes at open`);
    const told = eventsAt(a).find(e => e.event === 'space_deletion_pending');
    assert.ok(told, `A saw ${JSON.stringify(eventsAt(a))}`);
    assert.deepEqual({ networkId: told.networkId, spaceId: told.data.spaceId }, { networkId: 'net-1', spaceId: 'notes' });
    const roundId = roundsOf(loader, 'net-1', 'space_deletion')[0].roundId;
    assert.ok(lines.some(l => l.includes('net-1') && l.includes(B) && l.includes('space_deletion_pending') && l.includes(roundId)), 'the 500 from B is logged with network id, member id, event and round id');
    assert.ok(lines.some(l => l.includes(C) && l.includes('space_deletion_pending')), 'the reset from C is logged, naming the member and the event');
  });

  it('a typed wipe carries types; an untyped one carries none', async () => {
    await bootClub();
    a.seen.length = 0;
    await doors.wipeSpace('notes', { confirm: true, types: ['files'] });
    await until(() => eventsAt(a).length >= 1, 'typed wipe told');
    await doors.wipeSpace('notes', { confirm: true });
    await until(() => eventsAt(a).length >= 2, 'untyped wipe told');
    const [typed, untyped] = eventsAt(a);
    assert.deepEqual([typed.event, typed.data.types], ['space_wipe_pending', ['files']]);
    assert.deepEqual([untyped.event, 'types' in untyped.data && untyped.data.types !== undefined], ['space_wipe_pending', false]);
  });

  it('a club addition tells sync_available and a club meta change tells meta_change_pending, each with the network\'s space id', async () => {
    await bootClub({}, ['general']);
    a.seen.length = 0;
    const add = await doors.addSpace('net-1', 'extra');
    assert.equal(add.code, 200, JSON.stringify(add.body)?.slice(0, 200));
    await until(() => eventsAt(a).some(e => e.event === 'sync_available'), 'the addition was told');
    await bootClub();
    a.seen.length = 0;
    const { spacesRouter } = await import('../../server/dist/api/spaces.js');
    const meta = await callRoute(spacesRouter, 'patch', '/:id', { params: { id: 'notes' }, body: { meta: { purpose: 'a purpose the club chose' } }, authToken: ADMIN });
    assert.ok([200, 202].includes(meta.code), JSON.stringify(meta.body)?.slice(0, 200));
    await until(() => eventsAt(a).some(e => e.event === 'meta_change_pending'), 'the meta change was told');
    assert.equal(eventsAt(a).find(e => e.event === 'meta_change_pending').data.spaceId, 'notes');
  });
});

/** Does some captured line name the event and the member? */
function lines_has(lines, event, member) { return lines.some(l => l.includes(event) && l.includes(member)); }
