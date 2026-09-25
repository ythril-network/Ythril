/**
 * Adding a space to an existing network, through REST and MCP, and what the peers see of it (`F-38.3`).
 *
 * Nothing could add a space to a network after it was created. The governing position — a pub/sub publisher, a
 * braintree root — now adds one, and three things have to follow for it to be real rather than a line in config:
 *
 *  1. the peers' tokens reach the new space, or every sync request for it answers 403;
 *  2. the member exchange announces it, which is how a subscriber learns it exists;
 *  3. a subscriber adopts what its PUBLISHER announces — creating the space when it has none — and ignores the
 *     same announcement from anybody else.
 *
 * Club, closed and democratic networks share every space both ways, so there it is a `space_addition` round
 * (`F-38.4`): a club organiser's own yes carries it at once, a closed network waits for every member.
 *
 * Run: node --test testing/integration/a-space-is-added-to-a-network-on-both-doors.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'url';
import { generateKeyPairSync, privateDecrypt, publicEncrypt, randomBytes, constants } from 'node:crypto';
import { INSTANCES, post, get, del, delWithBody } from '../sync/helpers.js';
import { openMcpSession } from '../sync/mcp-session.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIGS = path.join(__dirname, '..', 'sync', 'configs');
const RUN = Date.now();
const FIRST = `f383-first-${RUN}`;
const ADDED = `f383-added-${RUN}`;
const VIA_MCP = `f383-mcp-${RUN}`;
const ANNOUNCED = `f383-announced-${RUN}`;
const SUBSCRIBER = '66666666-6666-4666-8666-666666666666';
const PUBLISHER = '77777777-7777-4777-8777-777777777777';

let admin, adminMcp, subscriberToken, publisherPeerToken;
let pubNet, subNet;
const networks = [];
const spaces = [FIRST, ADDED, VIA_MCP];

before(async () => {
  admin = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
  for (const id of spaces) {
    const r = await post(INSTANCES.a, admin, '/api/spaces', { id, label: id });
    assert.equal(r.status, 201, JSON.stringify(r.body));
  }
  adminMcp = await openMcpSession(admin);
});

after(async () => {
  await adminMcp?.close?.();
  for (const id of networks) await del(INSTANCES.a, admin, `/api/networks/${id}`).catch(() => {});
  for (const id of [...spaces, ANNOUNCED]) await delWithBody(INSTANCES.a, admin, `/api/spaces/${id}`, { confirm: true }).catch(() => {});
});

const tool = async (name, args) => {
  const r = await adminMcp.callTool(name, args);
  return { isError: !!r?.isError, body: r?.structuredContent ?? {}, text: r?.content?.[0]?.text ?? '' };
};

/** Run the invite handshake as a joiner would, and return the token the inviter handed it. */
async function join(networkId, instanceId) {
  const gen = await post(INSTANCES.a, admin, '/api/invite/generate', { networkId });
  assert.equal(gen.status, 201, JSON.stringify(gen.body));
  const b = generateKeyPairSync('rsa', { modulusLength: 4096,
    publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
  const apply = await post(INSTANCES.a, '', '/api/invite/apply', {
    handshakeId: gen.body.handshakeId, networkId, instanceId, instanceLabel: 'f383 subscriber',
    instanceUrl: 'http://ythril-b:3200', rsaPublicKeyPem: b.publicKey,
  });
  assert.equal(apply.status, 200, JSON.stringify(apply.body));
  const token = privateDecrypt({ key: b.privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
    Buffer.from(apply.body.encryptedTokenForB, 'base64')).toString('utf8');
  const encryptedTokenForA = publicEncrypt({ key: apply.body.rsaPublicKeyPem, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
    Buffer.from(`ythril_${randomBytes(32).toString('base64url')}`, 'utf8')).toString('base64');
  const fin = await post(INSTANCES.a, '', '/api/invite/finalize', { handshakeId: gen.body.handshakeId, encryptedTokenForA });
  assert.equal(fin.status, 200, JSON.stringify(fin.body));
  return token;
}

const announce = (token, networkId, instanceId, spaceIds) =>
  post(INSTANCES.a, token, `/api/sync/networks/${networkId}/members`, { instanceId, label: instanceId, spaces: spaceIds });

describe('the publisher adds a space', () => {
  before(async () => {
    const r = await post(INSTANCES.a, admin, '/api/networks', { label: `f383-pub-${RUN}`, type: 'pubsub', spaces: [FIRST] });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    pubNet = r.body.id;
    networks.push(pubNet);
    subscriberToken = await join(pubNet, SUBSCRIBER);
  });

  it('POST /api/networks/:id/spaces adds it, and the network carries it', async () => {
    const r = await post(INSTANCES.a, admin, `/api/networks/${pubNet}/spaces`, { spaceId: ADDED });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(r.body.spaces.includes(ADDED), `the answer must carry the added space: ${JSON.stringify(r.body.spaces)}`);
    assert.ok((await get(INSTANCES.a, admin, `/api/networks/${pubNet}`)).body.spaces.includes(ADDED));
  });

  it('the subscriber\'s token reaches the added space at once', async () => {
    const r = await get(INSTANCES.a, subscriberToken, `/api/sync/entities?spaceId=${ADDED}&networkId=${pubNet}&limit=1`);
    assert.equal(r.status, 200, `the subscriber cannot sync the space just added: ${r.status} ${JSON.stringify(r.body)}`);
  });

  it('the member exchange announces it to the subscriber', async () => {
    const r = await announce(subscriberToken, pubNet, SUBSCRIBER, []);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual([...(r.body.self?.spaces ?? [])].sort(), [ADDED, FIRST].sort());
  });

  it('network_add_space adds a space as the route does', async () => {
    const r = await tool('network_add_space', { id: pubNet, spaceId: VIA_MCP });
    assert.equal(r.isError, false, r.text);
    assert.ok(r.body.spaces.includes(VIA_MCP));
  });

  it('a space the network already carries is refused with the same sentence on both doors', async () => {
    const rest = await post(INSTANCES.a, admin, `/api/networks/${pubNet}/spaces`, { spaceId: ADDED });
    assert.equal(rest.status, 409, JSON.stringify(rest.body));
    assert.equal((await tool('network_add_space', { id: pubNet, spaceId: ADDED })).text, `Error (409): ${rest.body.error}`);
  });

  it('a space that does not exist is refused with the same sentence on both doors', async () => {
    const rest = await post(INSTANCES.a, admin, `/api/networks/${pubNet}/spaces`, { spaceId: `nope-${RUN}` });
    assert.equal(rest.status, 400, JSON.stringify(rest.body));
    assert.equal((await tool('network_add_space', { id: pubNet, spaceId: `nope-${RUN}` })).text, `Error (400): ${rest.body.error}`);
  });

  it('a subscriber announcing a space to its publisher changes nothing', async () => {
    await announce(subscriberToken, pubNet, SUBSCRIBER, [FIRST, `f383-pushed-up-${RUN}`]);
    const spacesNow = (await get(INSTANCES.a, admin, `/api/networks/${pubNet}`)).body.spaces;
    assert.ok(!spacesNow.includes(`f383-pushed-up-${RUN}`), `a subscriber put a space into its publisher: ${JSON.stringify(spacesNow)}`);
  });
});

describe('a network whose members share every space', () => {
  it('a club organiser adds a space at once — its own yes carries the round', async () => {
    const r = await post(INSTANCES.a, admin, '/api/networks', { label: `f383-club-${RUN}`, type: 'club', spaces: [FIRST] });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    networks.push(r.body.id);
    const rest = await post(INSTANCES.a, admin, `/api/networks/${r.body.id}/spaces`, { spaceId: ADDED });
    assert.equal(rest.status, 200, JSON.stringify(rest.body));
    assert.ok(rest.body.spaces.includes(ADDED));
    const round = rest.body.pendingRounds.find(x => x.type === 'space_addition');
    assert.ok(round?.passed, `the passed round must stay listed, so the members learn it: ${JSON.stringify(rest.body.pendingRounds)}`);
  });

  it('a closed network with another member opens a vote, on both doors, and refuses a second one', async () => {
    const n = await post(INSTANCES.a, admin, '/api/networks', { label: `f384-closed-${RUN}`, type: 'closed', spaces: [FIRST] });
    assert.equal(n.status, 201, JSON.stringify(n.body));
    networks.push(n.body.id);
    // A real member, by the handshake: adding one by hand to a closed network is itself a vote.
    await join(n.body.id, '88888888-8888-4888-8888-888888888888');
    assert.equal((await get(INSTANCES.a, admin, `/api/networks/${n.body.id}`)).body.members.length, 1, 'the peer must be a member');
    const rest = await post(INSTANCES.a, admin, `/api/networks/${n.body.id}/spaces`, { spaceId: ADDED });
    assert.equal(rest.status, 202, JSON.stringify(rest.body));
    assert.equal(rest.body.round.type, 'space_addition');
    assert.ok(!(await get(INSTANCES.a, admin, `/api/networks/${n.body.id}`)).body.spaces.includes(ADDED), 'added before the vote passed');
    const again = await tool('network_add_space', { id: n.body.id, spaceId: ADDED });
    assert.match(again.text, /^Error \(409\): A vote to add/);
    const viaMcp = await tool('network_add_space', { id: n.body.id, spaceId: VIA_MCP });
    assert.equal(viaMcp.isError, false, viaMcp.text);
    assert.equal(viaMcp.body.status, 'vote_pending');
  });
});

describe('the subscriber adopts what its publisher announces', () => {
  before(async () => {
    // This instance as the SUBSCRIBER: a pub/sub network whose publisher is a member we pull from.
    const r = await post(INSTANCES.a, admin, '/api/networks', { label: `f383-sub-${RUN}`, type: 'pubsub', spaces: [FIRST] });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    subNet = r.body.id;
    networks.push(subNet);
    const t = await post(INSTANCES.a, admin, '/api/tokens', { name: `f383-publisher-${RUN}`, peerInstanceId: PUBLISHER, rights: {
      instanceAdmin: false, createSpaces: false, floor: null,
      perSpace: { [FIRST]: { knowledge: 'write', files: 'write', schema: 'write', dataQuality: 'write', networks: 'write' } } } });
    assert.equal(t.status, 201, JSON.stringify(t.body));
    publisherPeerToken = t.body.plaintext;
    const m = await post(INSTANCES.a, admin, `/api/networks/${subNet}/members`, {
      instanceId: PUBLISHER, label: 'f383 publisher', url: 'http://ythril-b:3200', token: `ythril_${randomBytes(32).toString('base64url')}`, direction: 'pull',
    });
    assert.equal(m.status, 201, JSON.stringify(m.body));
  });

  it('a space the publisher announces is created here and carried by the network', async () => {
    const r = await announce(publisherPeerToken, subNet, PUBLISHER, [FIRST, ANNOUNCED]);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const net = (await get(INSTANCES.a, admin, `/api/networks/${subNet}`)).body;
    assert.ok(net.spaces.includes(ANNOUNCED), `the announced space was not adopted: ${JSON.stringify(net.spaces)}`);
    assert.equal((await get(INSTANCES.a, admin, `/api/spaces/${ANNOUNCED}/meta`)).status, 200, 'the adopted space must exist here');
  });

  it('and the publisher\'s token reaches it, so the publisher can push into it', async () => {
    const r = await get(INSTANCES.a, publisherPeerToken, `/api/sync/entities?spaceId=${ANNOUNCED}&networkId=${subNet}&limit=1`);
    assert.equal(r.status, 200, `the publisher cannot sync the space it announced: ${r.status} ${JSON.stringify(r.body)}`);
  });
});
