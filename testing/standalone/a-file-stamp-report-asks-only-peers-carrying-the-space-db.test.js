/**
 * `file_stamp_report` spends this instance's credentials on a peer only through a network that CURRENTLY carries the
 * space, and a peer in two networks is asked through one, chosen in a fixed order (`Q-433`, items 14, 22; privacy S-4).
 *
 * ## What it prevents
 *
 * A row's `syncBase.<peer>` outlives everything around it: the network the bytes crossed on may have been left, the space
 * removed from it, the peer removed. A report that resolved "the peer" from that key alone would call the peer's URL with
 * the member token of a network that no longer shares the space — an outbound call nobody authorised for THIS space, and
 * an answer about a space the peer may no longer be entitled to. So the resolution goes through the networks that carry
 * the space, in ONE function (`peersCarryingSpace`, in `sync/peer-for-space.ts`), which a second resolver cannot disagree
 * with because there is no second resolver.
 *
 * ## The resolver's answer
 *
 * `peersCarryingSpace(spaceId, peerId)` — `[{ member, networkId, remoteSpaceId }]`, one entry per network that carries
 * `spaceId` AND has `peerId` as a member, ascending by `networkId` (the order the report tries them in, whatever order
 * the configuration lists the networks in), `remoteSpaceId` being the network's own id for the space (`spaceMap`).
 *
 * ## The request side
 *
 * Every peer here is a real listener on this host's LAN address (the SSRF guards refuse loopback), counting what it is
 * sent. The cases: one request for each network that carries the space; none for a network that does not, even when its
 * peer is named in the row's `syncBase`; a peer in two networks asked through ONE of them — the first by network id that
 * answers — and the next one only when the first could not.
 *
 * Run: a Mongo the harness accepts (see `_mongo-harness.mjs`), then
 *      node --test testing/standalone/a-file-stamp-report-asks-only-peers-carrying-the-space-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason, privateHostAddress } from './_private-address.mjs';
import { openStampDoor, PEER, sha256Of, bytesOf } from './_file-stamp-door.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();
process.env['YTHRIL_MODELS_OFFLINE'] = '1';

const S = 'stampcarry';
const OTHER_SPACE = 'stampcarry-elsewhere';
const P2 = 'carry-peer-two';
const P3 = 'carry-peer-three';

let stamp, door, loader, peersCarryingSpace;
let listeners;
/** Networks a case added to the live config, removed again after it. */
let added;
/** Every feed GET the pull-door's own fake peer (the `NET` network's member) received. */
let served;

before(async () => {
  stamp = await openStampDoor({ suite: 'stampcarry', space: S, pull: { extraSpaces: [OTHER_SPACE] } });
  door = stamp.door;
  loader = await import('../../server/dist/config/loader.js');
});
after(async () => { await stamp?.close(); });
beforeEach(async () => {
  listeners = [];
  added = [];
  served = [];
  await stamp.reset();
  door.state.family = async (req, res, family) => { served.push({ query: { ...req.query }, authorization: req.headers['authorization'] }); await door.serveFamily(req, res, family); };
});
afterEach(async () => {
  const cfg = door.config();
  cfg.networks = cfg.networks.filter(n => !added.includes(n.id));
  for (const id of [P2, P3]) delete loader.getSecrets().peerTokens[id];
  await Promise.all(listeners.map(l => l.close()));
});

/** A peer on this host's LAN address that counts every request and answers its file feed with an empty page. */
async function listener(label, { status = 200 } = {}) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    requests.push({ path: url.pathname, spaceId: url.searchParams.get('spaceId'), networkId: url.searchParams.get('networkId'), authorization: req.headers['authorization'] });
    if (status !== 200) { res.writeHead(status, { 'content-type': 'application/json' }); res.end('{"error":"scripted"}'); return; }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ items: [], nextCursor: null }));
  });
  // own-listener: binds every interface so the LAN address answers, because the SSRF guards block loopback
  await new Promise(resolve => server.listen(0, '0.0.0.0', resolve));
  const l = {
    label, requests, url: `http://${privateHostAddress()}:${server.address().port}`,
    close: () => new Promise(resolve => { server.closeAllConnections?.(); server.close(() => resolve()); }),
  };
  listeners.push(l);
  return l;
}

/** Add a network to the LIVE config: `members` are `[instanceId, url]`, `spaces` the local ids it carries. */
function addNetwork(id, spaces, members, extra = {}) {
  door.config().networks.push({
    id, label: id, type: 'pubsub', spaces, votes: [], votingDeadlineHours: 24,
    members: members.map(([instanceId, url]) => ({ instanceId, label: instanceId, url, tokenHash: 'x', direction: 'pull' })), ...extra,
  });
  added.push(id);
}

describe('the resolver: only networks that carry the space, in a fixed order', { skip }, () => {
  before(async () => { ({ peersCarryingSpace } = await import('../../server/dist/sync/peer-for-space.js')); });

  it('a peer in the network that carries the space resolves to that network, the network\'s id for the space and the member', () => {
    const found = peersCarryingSpace(S, PEER);
    assert.equal(found.length, 1, JSON.stringify(found.map(f => f.networkId)));
    assert.deepEqual(Object.keys(found[0]).sort(), ['member', 'networkId', 'remoteSpaceId']);
    assert.equal(found[0].networkId, door.NET);
    assert.equal(found[0].remoteSpaceId, S);
    assert.equal(found[0].member.instanceId, PEER);
    assert.equal(found[0].member.url, door.member().url);
  });

  it('a peer whose network does NOT carry the space resolves to nothing, though the network exists and the peer is in it', async () => {
    const l = await listener('elsewhere');
    addNetwork('carry-elsewhere', [OTHER_SPACE], [[P3, l.url]]);
    assert.deepEqual(peersCarryingSpace(S, P3), []);
    assert.equal(peersCarryingSpace(OTHER_SPACE, P3).length, 1, 'the control: the same peer, asked about the space its network does carry');
  });

  it('a peer that is no member of any network resolves to nothing', () => {
    assert.deepEqual(peersCarryingSpace(S, 'nobody-we-know'), []);
  });

  it('a network that carries the space under another id says so: remoteSpaceId is the network\'s id for it', async () => {
    const l = await listener('mapped');
    addNetwork('carry-mapped', [S], [[P2, l.url]], { spaceMap: { 'their-name-for-it': S } });
    const [found] = peersCarryingSpace(S, P2);
    assert.equal(found?.remoteSpaceId, 'their-name-for-it');
  });

  it('a peer in several networks resolves to all that carry the space, ascending by network id, whatever order the config lists them in', async () => {
    const l = await listener('x');
    addNetwork('zzz-last', [S], [[PEER, l.url]]);
    addNetwork('aaa-first', [S], [[PEER, l.url]]);
    const ids = peersCarryingSpace(S, PEER).map(f => f.networkId);
    assert.deepEqual(ids, ['aaa-first', door.NET, 'zzz-last'].sort(), 'not ascending by network id');
  });
});

describe('the report: one request for each network that carries the space, none for one that does not', { skip }, () => {
  it('two peers in networks that carry the space are each asked, by their network\'s space id and with their token; a third, whose network does not, is not asked', async () => {
    const [two, three] = [await listener('two'), await listener('three')];
    addNetwork('carry-two', [S], [[P2, two.url]], { spaceMap: { 'two-calls-it-this': S } });
    addNetwork('carry-three', [OTHER_SPACE], [[P3, three.url]]);
    loader.getSecrets().peerTokens[P2] = 'token-of-two';
    loader.getSecrets().peerTokens[P3] = 'token-of-three';
    const hash = sha256Of(bytesOf('docs/a.txt'));
    await stamp.ours('docs/a.txt', { syncBase: { [PEER]: hash, [P2]: hash, [P3]: hash } });

    const answer = await stamp.report();

    assert.ok(served.length >= 1, 'the peer of the network that carries the space was not asked');
    assert.ok(two.requests.length >= 1, 'the second peer, in a network that carries the space, was not asked');
    for (const q of two.requests) {
      assert.equal(q.spaceId, 'two-calls-it-this', 'the second peer was asked for the LOCAL id, not its own for the space');
      assert.equal(q.authorization, 'Bearer token-of-two', 'the second peer was asked with a token that is not its own');
    }
    assert.deepEqual(three.requests, [], 'a peer whose network does not carry the space was sent a request: its credentials were spent on a space it does not share');
    assert.equal(answer.rows.length, 1);
    assert.ok(!JSON.stringify(answer).includes('token-of'), 'a token is in the report');
  });

  it('a row whose only recorded peer is in a network that no longer carries the space is not sent anywhere', async () => {
    const gone = await listener('gone');
    addNetwork('carry-gone', [OTHER_SPACE], [[P3, gone.url]]);
    loader.getSecrets().peerTokens[P3] = 'token-of-three';
    await stamp.ours('docs/orphan.txt', { syncBase: { [P3]: sha256Of(bytesOf('docs/orphan.txt')) } });
    await stamp.report();
    assert.deepEqual(gone.requests, []);
    assert.equal(served.length, 0, 'a request went to a peer no recorded base names');
  });
});

describe('a peer in two networks is asked through ONE, the first by network id that answers', { skip }, () => {
  it('both carry the space: only the first by network id is asked while it answers', async () => {
    const [first, last] = [await listener('first'), await listener('last')];
    addNetwork('zzz-last', [S], [[PEER, last.url]]);
    addNetwork('aaa-first', [S], [[PEER, first.url]]);
    await stamp.s1('docs/a.txt');
    await stamp.report();
    assert.ok(first.requests.length >= 1, 'the first network by id was not asked');
    assert.deepEqual(last.requests, [], 'the same peer was asked through a second network as well');
    assert.deepEqual(served, [], 'and through a third');
  });

  it('the first cannot answer: the next by network id is tried, and the one after it is not', async () => {
    const [broken, next, last] = [await listener('broken', { status: 500 }), await listener('next'), await listener('last')];
    addNetwork('aaa-first', [S], [[PEER, broken.url]]);
    addNetwork('bbb-second', [S], [[PEER, next.url]]);
    addNetwork('zzz-last', [S], [[PEER, last.url]]);
    await stamp.ours('docs/a.txt');
    await stamp.report();
    assert.equal(broken.requests.length, 1, 'the failing network was asked more than once');
    assert.ok(next.requests.length >= 1, 'the second network was not tried after the first failed');
    assert.deepEqual(last.requests, [], 'a third network was asked though the second answered');
    assert.deepEqual(served, [], 'the network that sorts between them (the door\'s own) was asked though the second answered');
  });

  it('one of the two networks does not carry the space: it is not asked even though it sorts first', async () => {
    const [notCarrying, carrying] = [await listener('not-carrying'), await listener('carrying')];
    addNetwork('aaa-not-carrying', [OTHER_SPACE], [[PEER, notCarrying.url]]);
    addNetwork('bbb-carrying', [S], [[PEER, carrying.url]]);
    await stamp.s1('docs/a.txt');
    await stamp.report();
    assert.deepEqual(notCarrying.requests, [], 'a network that does not carry the space was asked');
    assert.ok(carrying.requests.length >= 1);
  });
});
