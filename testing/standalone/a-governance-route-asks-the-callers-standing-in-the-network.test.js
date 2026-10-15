/**
 * The peer routes that name a network ask the CALLER'S STANDING there, once — and an open joiner has it, a denied one does not (Q-454).
 *
 * ## What was reachable
 *
 * `GET /api/sync/networks/:networkId/votes` and `GET …/members` carry `requireAuth` and nothing else. Any authenticated token reads
 * the open rounds of a network it has no part in — a space-scoped user PAT, a peer of another network, a manually provisioned peer
 * the network does not list — and the votes answer is the round as it travels: casts, signatures, the member a removal is about. The
 * two relays (`POST …/votes/:roundId`, `POST …/change-notes`) asked WHO (`peerRelayCaller`) and never WHETHER the caller belongs.
 * On an unknown network the reads answered `404 Network not found`, which tells any token which networks this instance holds.
 *
 * ## The rule, over the whole set it applies to
 *
 * The routes of the sync governance routers that read a network id from their path form one set (derived below from the routers'
 * own stacks, with a floor). For a caller, the answer is the same on every route of the set:
 *
 * | caller | answer |
 * |---|---|
 * | instance administrator, a member peer | served (a relay with an unknown round: `404`, a member's own answer) |
 * | a peer a join round of THIS network names while the round is OPEN | served on the two reads, refused on the relays |
 * | a joiner whose round was voted down, or is past its deadline unpruned | `403` |
 * | a space-scoped user PAT, a peer listed in no network, a peer of another network | `403` |
 * | anyone, on a network this instance does not hold | the same `403`, byte for byte |
 *
 * The refusal is `403 { error: 'Forbidden' }` for every caller without standing and for every reason (unknown network, not a
 * member, unknown round), so the route is no oracle of which networks and rounds exist. It is said in the log once per token and
 * route, not per request: a path's network id varies freely, so a key that included it would let one token write a line per request.
 *
 * ## What is driven
 *
 * Every route is called through its own chain from the layer after `requireAuth` (`_route-after-auth.mjs`), so a standing check
 * that sits between authentication and the handler is part of what runs, and one that is missing is a refusal that never comes.
 *
 * Run: node --test testing/standalone/a-governance-route-asks-the-callers-standing-in-the-network.test.js  (requires a prior server build)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tempInstanceDir, removeInstanceDir, bootInstance } from './_vote-round-instance.mjs';
import { callRouteAfterAuth } from './_route-after-auth.mjs';
import { logLinesDuring } from './_log-lines.mjs';

const SELF = 'aaaaaaaa-0000-4000-8000-000000005e1f';
const MEMBER = 'aaaaaaaa-0000-4000-8000-0000000000a1';
const OTHER_NET_PEER = 'aaaaaaaa-0000-4000-8000-0000000000c1';
const UNLISTED = 'aaaaaaaa-0000-4000-8000-0000000000d1';
const OPEN_JOINER = 'aaaaaaaa-0000-4000-8000-0000000000b1';
const DENIED_JOINER = 'aaaaaaaa-0000-4000-8000-0000000000b2';
const EXPIRED_JOINER = 'aaaaaaaa-0000-4000-8000-0000000000b3';
const TREE_PARENT = 'aaaaaaaa-0000-4000-8000-0000000000e1';
const NET = 'net-a';
const OTHER_NET = 'net-b';
const TREE_NET = 'net-tree';
const KNOWN_ROUND = '11111111-1111-4111-8111-111111111111';
const FORBIDDEN = { error: 'Forbidden' };

const dir = tempInstanceDir('ythril-standing-');
const HOUR = 3_600_000;
const member = (instanceId) => ({ instanceId, label: `m${instanceId.slice(-2)}`, url: `https://${instanceId.slice(-2)}.example`, tokenHash: 'h', direction: 'both' });
const joinRound = (roundId, subject, extra = {}) => ({
  roundId, type: 'join', subjectInstanceId: subject, subjectLabel: `joiner ${subject.slice(-2)}`, subjectUrl: '',
  openedAt: new Date(Date.now() - HOUR).toISOString(), deadline: new Date(Date.now() + HOUR).toISOString(), votes: [], concluded: false,
  pendingMember: member(subject), ...extra,
});
const NETWORKS = () => [
  {
    id: NET, label: 'Net A', type: 'closed', origin: 'created', syncSchedule: '', spaces: ['general'], votingDeadlineHours: 24,
    createdAt: '2026-01-01T00:00:00.000Z', members: [member(MEMBER)],
    pendingRounds: [
      joinRound('22222222-2222-4222-8222-222222222201', OPEN_JOINER),
      joinRound('22222222-2222-4222-8222-222222222202', DENIED_JOINER, { concluded: true, passed: false }),
      joinRound('22222222-2222-4222-8222-222222222203', EXPIRED_JOINER, { deadline: new Date(Date.now() - HOUR).toISOString(), openedAt: new Date(Date.now() - 2 * HOUR).toISOString() }),
      { roundId: KNOWN_ROUND, type: 'remove', subjectInstanceId: MEMBER, subjectLabel: 'm', subjectUrl: '', openedAt: new Date(Date.now() - HOUR).toISOString(), deadline: new Date(Date.now() + HOUR).toISOString(), votes: [], concluded: false },
    ],
  },
  {
    id: OTHER_NET, label: 'Net B', type: 'closed', origin: 'created', syncSchedule: '', spaces: ['general'], votingDeadlineHours: 24,
    createdAt: '2026-01-01T00:00:00.000Z', members: [member(OTHER_NET_PEER)], pendingRounds: [],
  },
  // A braintree child: its parent is declared in `myParentInstanceId` and is NOT in `members` - the shape a node registers when it
  // joins a tree by declaring its parent (testing/sync/braintree-governance.test.js registers B this way).
  {
    id: TREE_NET, label: 'Tree', type: 'braintree', origin: 'created', syncSchedule: '', spaces: ['general'], votingDeadlineHours: 24,
    createdAt: '2026-01-01T00:00:00.000Z', members: [], pendingRounds: [], myParentInstanceId: TREE_PARENT,
  },
];

// Write-capable on `general` through a space-admin grant (`canWriteAnywhere`): a relay refuses a read-only token before it asks anything else,
// so a read-only fixture would test `denyReadOnly` and not the standing question. A space-scoped user PAT of this shape is the documented caller.
const rights = (extra = {}) => ({ instanceAdmin: false, createSpaces: false, floor: null, perSpace: {}, spaceAdmin: { floor: false, spaces: ['general'] }, ...extra });
let serial = 0;
/** A token record as `requireAuth` leaves it on the request. Every token gets its own id, so a per-token once-only line is never shared between cases. */
const token = (who, extra = {}) => ({ id: `tok-${who}-${++serial}`, name: who, rights: rights(), ...extra });
const CALLERS = {
  admin:        () => token('admin', { rights: rights({ instanceAdmin: true }) }),
  member:       () => token('member', { peerInstanceId: MEMBER }),
  openJoiner:   () => token('open-joiner', { peerInstanceId: OPEN_JOINER }),
  deniedJoiner: () => token('denied-joiner', { peerInstanceId: DENIED_JOINER }),
  pastDeadline: () => token('expired-joiner', { peerInstanceId: EXPIRED_JOINER }),
  userPat:      () => token('user-pat'),
  unlistedPeer: () => token('unlisted', { peerInstanceId: UNLISTED }),
  otherNetPeer: () => token('other-net-peer', { peerInstanceId: OTHER_NET_PEER }),
  treeParent:   () => token('tree-parent', { peerInstanceId: TREE_PARENT }),
};

/** The governance routes that name a network in their path, with what each is called with. Derived from the routers' stacks below. */
const GOVERNANCE = [
  { router: 'votes', method: 'get', path: '/networks/:networkId/votes', params: (n) => ({ networkId: n }) },
  { router: 'members', method: 'get', path: '/networks/:networkId/members', params: (n) => ({ networkId: n }) },
  { router: 'votes', method: 'post', path: '/networks/:networkId/votes/:roundId', params: (n, r = 'no-such-round') => ({ networkId: n, roundId: r }), body: { vote: 'yes', instanceId: MEMBER } },
  { router: 'changeNotes', method: 'post', path: '/networks/:networkId/change-notes', params: (n) => ({ networkId: n }), body: { notes: [] } },
];

describe('the governance routes ask the caller\'s standing in the network', () => {
  let routers;
  before(async () => {
    await bootInstance(dir, { instanceId: SELF, networks: NETWORKS(), peerTokens: {} });
    routers = {
      votes: (await import('../../server/dist/api/sync/votes.js')).syncVotesRouter,
      members: (await import('../../server/dist/api/sync/members.js')).syncMembersRouter,
      changeNotes: (await import('../../server/dist/api/sync/change-notes.js')).syncChangeNotesRouter,
    };
  });
  after(() => removeInstanceDir(dir));

  const call = (route, authToken, networkId, roundId) => callRouteAfterAuth(routers[route.router], route.method, route.path, {
    params: route.params(networkId, roundId), body: route.body ?? {}, authToken,
  });
  const reads = () => GOVERNANCE.filter(r => r.method === 'get');

  it('the set of routes under test is derived from the routers, with a floor, so a route added to one is in it', () => {
    // Every route of the three sync routers whose path starts `/networks/:networkId` AND is a governance read or relay. A route
    // the table above does not name is a governance route nobody drove — it fails here instead of passing by absence.
    const found = [];
    for (const [name, router] of Object.entries(routers)) {
      for (const layer of router.stack) {
        if (!layer.route || !layer.route.path.startsWith('/networks/:networkId')) continue;
        for (const method of Object.keys(layer.route.methods)) found.push({ router: name, method, path: layer.route.path });
      }
    }
    assert.ok(found.length >= GOVERNANCE.length, `only ${found.length} network-scoped routes found on the sync governance routers`);
    const undriven = found.filter(f => !GOVERNANCE.some(g => g.router === f.router && g.method === f.method && g.path === f.path)
      && !(f.method === 'post' && f.path === '/networks/:networkId/members'));
    assert.deepEqual(undriven, [], 'a network-scoped governance route has no row in this test (the announce relay is the one stated exemption: it carries its own caller-is-the-member rule)');
  });

  it('R-X13a: an open joiner reads the votes and the members of the network it is joining — and no other (R-W12)', async () => {
    const asked = [];
    for (const route of reads()) {
      const own = await call(route, CALLERS.openJoiner(), NET);
      const other = await call(route, CALLERS.openJoiner(), OTHER_NET);
      asked.push({ route: route.path, own: own.code, other: other.code });
    }
    assert.deepEqual(asked.map(a => a.own), [200, 200], `an OPEN join round names the peer, so it reads its own network: ${JSON.stringify(asked)}`);
    assert.deepEqual(asked.map(a => a.other), [403, 403], `a joiner of one network has no standing in another: ${JSON.stringify(asked)}`);
  });

  it('R-X13b: a joiner voted down, and one whose round is past its deadline, are refused on every route', async () => {
    const got = {};
    for (const route of GOVERNANCE) {
      got[`${route.method} ${route.path}`] = {
        denied: (await call(route, CALLERS.deniedJoiner(), NET)).code,
        pastDeadline: (await call(route, CALLERS.pastDeadline(), NET)).code,
      };
    }
    const served = Object.entries(got).filter(([, v]) => v.denied !== 403 || v.pastDeadline !== 403);
    assert.deepEqual(served, [], `callers whose join round is not open were served: ${JSON.stringify(Object.fromEntries(served))}`);
  });

  it('R-W12 / R-X13d: an administrator is served; a user PAT, a peer listed in no network and a peer of another network are refused on every route', async () => {
    const refused = [];
    const served = [];
    for (const route of GOVERNANCE) {
      for (const who of ['userPat', 'unlistedPeer', 'otherNetPeer']) {
        const r = await call(route, CALLERS[who](), NET);
        if (r.code !== 403 || JSON.stringify(r.body) !== JSON.stringify(FORBIDDEN)) refused.push(`${who} ${route.method} ${route.path} -> ${r.code} ${JSON.stringify(r.body)}`);
      }
      const a = await call(route, CALLERS.admin(), NET);
      if (a.code === 403 && route.method === 'get') served.push(`admin ${route.path} -> ${a.code}`);
    }
    assert.deepEqual(refused, [], 'callers without standing must be answered 403 { error: "Forbidden" }');
    assert.deepEqual(served, [], 'an instance administrator has standing on the reads');
  });

  it('a braintree node\'s declared parent has standing though the node does not list it among its members: it reads and relays', async () => {
    // The root of a tree pulls a node's rounds and relays its casts to it; refusing it stops every vote that needs an ancestor (the
    // A0 Full run 38819800862: braintree-governance and join-governance timed out waiting for the root to see the round).
    const got = {};
    for (const route of GOVERNANCE) got[`${route.method} ${route.path}`] = (await call(route, CALLERS.treeParent(), TREE_NET, 'no-such-round')).code;
    const refused = Object.entries(got).filter(([, code]) => code === 403);
    assert.deepEqual(refused, [], `the tree parent was refused: ${JSON.stringify(got)}`);
    // And the same peer has no standing in a network it is not above.
    assert.equal((await call(GOVERNANCE[0], CALLERS.treeParent(), NET)).code, 403, 'a tree parent of one network is a stranger in another');
  });

  it('R-W12: a member with an unknown round reaches the 404 — the uniform 403 is for callers without standing', async () => {
    const relay = GOVERNANCE.find(r => r.method === 'post' && r.path.endsWith('/votes/:roundId'));
    const member = await call(relay, CALLERS.member(), NET, 'no-such-round');
    const admin = await call(relay, CALLERS.admin(), NET, 'no-such-round');
    assert.equal(member.code, 404, `a member's relay to a round this instance does not hold is a 404, its own answer: ${JSON.stringify(member)}`);
    assert.equal(admin.code, 404);
    // And what a caller without standing is NOT told: the same round id, from a peer of another network, is the uniform refusal.
    const stranger = await call(relay, CALLERS.otherNetPeer(), NET, 'no-such-round');
    assert.deepEqual({ code: stranger.code, body: stranger.body }, { code: 403, body: FORBIDDEN }, 'a stranger must not learn whether a round exists');
  });

  it('R-W12 / R-X13e: a network this instance does not hold, a network the caller is not in and a round that is not there answer the SAME bytes to a caller without standing', async () => {
    const bytes = new Set();
    const listing = [];
    for (const route of GOVERNANCE) {
      for (const who of ['userPat', 'otherNetPeer', 'unlistedPeer']) {
        const unknownNetwork = await call(route, CALLERS[who](), 'no-such-network');
        const notAMember = await call(route, CALLERS[who](), NET);
        for (const r of [unknownNetwork, notAMember]) { bytes.add(JSON.stringify(r)); listing.push(`${who} ${route.method} ${route.path} -> ${r.code}`); }
      }
    }
    assert.deepEqual([...bytes], [JSON.stringify({ code: 403, body: FORBIDDEN })],
      `every refusal must be the one 403, whatever the reason; got ${bytes.size} distinct answer(s): ${[...bytes].join(' | ')}`);
  });

  const credentialOf = (p) => ({ id: `cred-${p.slice(-2)}`, name: p, hash: 'x', prefix: 'x', createdAt: '2026-01-01T00:00:00.000Z', lastUsed: null, expiresAt: null, peerInstanceId: p, rights: rights() });

  it('R-X13c (sweep): the boot sweep keeps the credential of a joiner only while its join round is OPEN — a voted-down one and one past its deadline are orphaned', async () => {
    const { orphanedPeerInstanceIds } = await import('../../server/dist/auth/tokens.js');
    const tokens = [OPEN_JOINER, DENIED_JOINER, EXPIRED_JOINER].map(credentialOf);
    const swept = orphanedPeerInstanceIds({ tokens, networks: NETWORKS() }).sort();
    assert.deepEqual(swept, [DENIED_JOINER, EXPIRED_JOINER].sort(),
      'a past-deadline round that nothing has concluded is not live: its joiner holds a credential for a round nobody can vote on');
  });

  it('R-X13c (revoke): the act that revokes peer credentials reads the round the same way — it revokes a past-deadline joiner, never an open one', async () => {
    const loader = await import('../../server/dist/config/loader.js');
    const { revokePeerCredentialsIfOrphaned } = await import('../../server/dist/auth/tokens.js');
    const cfg = loader.getConfig();
    cfg.tokens = [OPEN_JOINER, DENIED_JOINER, EXPIRED_JOINER].map(credentialOf);
    assert.equal(await revokePeerCredentialsIfOrphaned(OPEN_JOINER), false, 'an open join round keeps the credential of its joiner');
    assert.equal(await revokePeerCredentialsIfOrphaned(DENIED_JOINER), true, 'the credential of a voted-down joiner is revoked');
    assert.equal(await revokePeerCredentialsIfOrphaned(EXPIRED_JOINER), true, 'a round past its deadline no longer holds the credential');
    assert.deepEqual(loader.getConfig().tokens.map(t => t.peerInstanceId), [OPEN_JOINER], 'only the credential of the open joiner is left');
  });

  it('R-X13f: the refusal is said once per token and route, across any number of network ids', async () => {
    const read = GOVERNANCE[0];
    const members = GOVERNANCE[1];
    const stranger = CALLERS.otherNetPeer();
    const other = CALLERS.userPat();
    const { lines } = await logLinesDuring(async () => {
      for (let i = 0; i < 6; i++) await call(read, stranger, `varied-network-${i}`);
      for (let i = 0; i < 6; i++) await call(read, other, `varied-network-${i}`);
      for (let i = 0; i < 6; i++) await call(members, stranger, `varied-network-${i}`);
    });
    const warned = lines.filter(l => /\[WARN\s*\]/.test(l));
    assert.equal(warned.length, 3,
      `six refusals each, by two tokens on one route and one token on a second: one line per (token, route), not per request or per network id. Got ${warned.length}:\n${warned.join('\n')}`);
  });
});
