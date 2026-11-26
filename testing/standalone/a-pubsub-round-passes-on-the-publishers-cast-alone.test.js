/**
 * On a pub/sub network only the PUBLISHER's own cast decides a round, and no member passes a round of a kind its network type never opens
 * (Q-968, a security hole in every 6.5.x).
 *
 * ## What it prevents
 *
 * The pub/sub pass rule was "any yes and no veto". A subscriber's own yes, cast when it opened a `meta_change`, passed the round on the
 * subscriber at once; the publisher adopted the round at its next sync and passed it on the same yes, so one subscriber admin changed the
 * network's schema for every member. The same rule let a subscriber serve a forged `join`, `remove` or `space_addition` round the publisher
 * passed on that one yes (a `remove` revokes a member), and on a club any member could serve a `remove` round that ejected another member
 * everywhere, although neither type ever opens a join or a removal round itself.
 *
 * ## The rule, by network type x round kind x whose cast
 *
 * Every cell's verdict is written by hand below (`EXPECTED`), never derived from the server's own table, and the axes are read from
 * `server/src/config/types-networks.ts`, so a round kind or network type added there without a row here fails the exhaustiveness case.
 *
 * - `publisher`: the round was served by a peer and carries one yes, the publisher's on pub/sub (this instance subscribes), any other
 *   member's elsewhere.
 * - `subscriber`: the round was served by a peer and carries one yes, a subscriber's on pub/sub (this instance publishes), any other
 *   member's elsewhere.
 * - `proposer`: this instance opened the round and cast its own yes; on pub/sub it SUBSCRIBES (the case the hole came through).
 *
 * Run: node --test testing/standalone/a-pubsub-round-passes-on-the-publishers-cast-alone.test.js (after the server build)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SELF = 'aaaaaaaa-0000-4000-8000-000000005e1f';
const PEER_A = 'aaaaaaaa-0000-4000-8000-0000000000a1';
const PEER_B = 'aaaaaaaa-0000-4000-8000-0000000000b2';
const PEER_C = 'aaaaaaaa-0000-4000-8000-0000000000c3';
const JOINER = 'aaaaaaaa-0000-4000-8000-0000000000d4';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-pubsub-decider-'));
process.env['CONFIG_PATH'] = path.join(tmpDir, 'config.json');

let roundVerdict, adoptionRefusal, ownYesCarries;
before(async () => {
  const loader = await import('../../server/dist/config/loader.js');
  fs.writeFileSync(process.env['CONFIG_PATH'], JSON.stringify({
    instanceId: SELF, instanceLabel: 'self', tokens: [], networks: [],
    spaces: [{ id: 'general', label: 'General', builtIn: true, folders: [] }],
  }), { mode: 0o600 });
  loader.loadConfig();
  ({ roundVerdict } = await import('../../server/dist/sync/governance.js'));
  ({ adoptionRefusal } = await import('../../server/dist/networks/round-local-state.js'));
  ({ ownYesCarries } = await import('../../server/dist/networks/round-forecast.js'));
});
after(() => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ } });

/** The members of a `export type Name = 'a' | 'b'` union, read from the server source: the axis a new member joins. */
function declaredUnion(name) {
  const source = fs.readFileSync('server/src/config/types-networks.ts', 'utf8');
  const declared = new RegExp(`export type ${name}\\s*=([^;]+);`).exec(source);
  assert.ok(declared, `${name} is gone from server/src/config/types-networks.ts: re-anchor this test`);
  const members = [...declared[1].matchAll(/'(\w+)'/g)].map(m => m[1]);
  assert.ok(members.length >= 5, `${name} lists ${members.length} member(s): the axis was misread`);
  return members;
}

const future = () => new Date(Date.now() + 3_600_000).toISOString();
const past = () => new Date(Date.now() - 3_600_000).toISOString();
const member = (instanceId, direction = 'both') => ({ instanceId, label: instanceId.slice(-2), url: `http://${instanceId.slice(-2)}.example`, tokenHash: 'h', direction });
const cast = (instanceId, vote = 'yes') => ({ instanceId, vote, castAt: new Date().toISOString() });
const network = (type, members, extra = {}) => ({
  id: 'n', label: 'n', type, origin: 'joined', syncSchedule: '', spaces: ['general'], votingDeadlineHours: 24, members, pendingRounds: [], ...extra,
});
/** This instance subscribes: its one upstream is PEER_A, the publisher (`direction: 'pull'`). */
const subscribing = () => network('pubsub', [member(PEER_A, 'pull'), member(PEER_C, 'push')]);
/** This instance publishes: every member is a subscriber it pushes to. */
const publishing = () => network('pubsub', [member(PEER_B, 'push'), member(PEER_C, 'push')], { origin: 'created' });

/** A round of `kind`, with what that kind names; a removal is of PEER_C, a join of JOINER. */
function roundOf(kind, over = {}) {
  const about = {
    join: { subjectInstanceId: JOINER, pendingMember: member(JOINER) },
    remove: { subjectInstanceId: PEER_C },
    space_deletion: { spaceId: 'general', networkSpaceId: 'general' },
    space_wipe: { spaceId: 'general', networkSpaceId: 'general' },
    meta_change: { spaceId: 'general', pendingMeta: { purpose: 'changed' }, metaChangedFields: ['purpose'], baseMetaVersion: 0 },
    space_addition: { spaceId: 'fresh' },
  }[kind];
  assert.ok(about, `no round shape for kind '${kind}': add one to roundOf`);
  return {
    roundId: `r-${kind}`, type: kind, subjectInstanceId: PEER_A, subjectLabel: 's', subjectUrl: '',
    openedAt: new Date().toISOString(), deadline: future(), votes: [], ...about, ...over,
  };
}

/** The network and round of one cell: who cast the one yes, on which side of a pub/sub network this instance stands. */
function cellOf(type, caster, kind) {
  if (caster === 'quorum') {
    // The casts the type's own rule needs, served by a peer (not proposed here): the publisher's yes on pub/sub (this instance subscribes), any
    // member's on a club, every member's on a closed and a braintree network, a majority of the four (this instance and three peers) on a democratic one.
    if (type === 'pubsub') return { net: subscribing(), round: roundOf(kind, { votes: [cast(PEER_A), cast(PEER_C), cast(SELF)] }) };
    const net = network(type, [member(PEER_A), member(PEER_B), member(PEER_C)]);
    const voters = type === 'democratic' ? [SELF, PEER_A, PEER_B] : type === 'club' ? [PEER_A] : [SELF, PEER_A, PEER_B, PEER_C];
    return { net, round: roundOf(kind, { votes: voters.map(v => cast(v)) }) };
  }
  if (type === 'pubsub') {
    if (caster === 'publisher') return { net: subscribing(), round: roundOf(kind, { votes: [cast(PEER_A)] }) };
    if (caster === 'subscriber') return { net: publishing(), round: roundOf(kind, { subjectInstanceId: PEER_B, votes: [cast(PEER_B)] }) };
    return { net: subscribing(), round: roundOf(kind, { subjectInstanceId: SELF, votes: [cast(SELF)], proposedHere: true }) };
  }
  const net = network(type, [member(PEER_A), member(PEER_B), member(PEER_C)]);
  if (caster === 'publisher') return { net, round: roundOf(kind, { votes: [cast(PEER_A)] }) };
  if (caster === 'subscriber') return { net, round: roundOf(kind, { subjectInstanceId: PEER_B, votes: [cast(PEER_B)] }) };
  return { net, round: roundOf(kind, { subjectInstanceId: SELF, votes: [cast(SELF)], proposedHere: true }) };
}

const P = 'passed';
const O = null;   // open: undecided, and so never applied
/** Every cell's verdict, by hand. Kind order: join, remove, space_deletion, space_wipe, meta_change, space_addition. */
const EXPECTED = {
  // On pub/sub the publisher's cast alone decides; join, remove and space_addition are kinds pub/sub never opens (it admits, removes and adds
  // spaces directly); a subscriber's own deletion or wipe is its local act (D-40), decided by its own yes.
  pubsub: {
    publisher: { join: O, remove: O, space_deletion: P, space_wipe: P, meta_change: P, space_addition: O },
    subscriber: { join: O, remove: O, space_deletion: O, space_wipe: O, meta_change: O, space_addition: O },
    proposer: { join: O, remove: O, space_deletion: P, space_wipe: P, meta_change: O, space_addition: O },
    quorum: { join: O, remove: O, space_deletion: P, space_wipe: P, meta_change: P, space_addition: O },
  },
  // The proposer decides a club round, as documented; join and remove are kinds a club never opens.
  club: {
    publisher: { join: O, remove: O, space_deletion: P, space_wipe: P, meta_change: P, space_addition: P },
    subscriber: { join: O, remove: O, space_deletion: P, space_wipe: P, meta_change: P, space_addition: P },
    proposer: { join: O, remove: O, space_deletion: P, space_wipe: P, meta_change: P, space_addition: P },
    quorum: { join: O, remove: O, space_deletion: P, space_wipe: P, meta_change: P, space_addition: P },
  },
  // Unchanged: one yes of four is no quorum on a voted network, and the casts the rule needs (`quorum`: every member's yes) pass every kind.
  // These cells must PASS, so a change that loses a voted network's pass fails here and not only the cells that must stay open.
  closed: {
    publisher: { join: O, remove: O, space_deletion: O, space_wipe: O, meta_change: O, space_addition: O },
    subscriber: { join: O, remove: O, space_deletion: O, space_wipe: O, meta_change: O, space_addition: O },
    proposer: { join: O, remove: O, space_deletion: O, space_wipe: O, meta_change: O, space_addition: O },
    quorum: { join: P, remove: P, space_deletion: P, space_wipe: P, meta_change: P, space_addition: P },
  },
  // A majority of the four electors (this instance and three peers), no veto.
  democratic: {
    publisher: { join: O, remove: O, space_deletion: O, space_wipe: O, meta_change: O, space_addition: O },
    subscriber: { join: O, remove: O, space_deletion: O, space_wipe: O, meta_change: O, space_addition: O },
    proposer: { join: O, remove: O, space_deletion: O, space_wipe: O, meta_change: O, space_addition: O },
    quorum: { join: P, remove: P, space_deletion: P, space_wipe: P, meta_change: P, space_addition: P },
  },
  // A flat tree (no ancestor set): every member's yes, as on a closed network.
  braintree: {
    publisher: { join: O, remove: O, space_deletion: O, space_wipe: O, meta_change: O, space_addition: O },
    subscriber: { join: O, remove: O, space_deletion: O, space_wipe: O, meta_change: O, space_addition: O },
    proposer: { join: O, remove: O, space_deletion: O, space_wipe: O, meta_change: O, space_addition: O },
    quorum: { join: P, remove: P, space_deletion: P, space_wipe: P, meta_change: P, space_addition: P },
  },
};
const CASTERS = ['publisher', 'subscriber', 'proposer', 'quorum'];

describe('network type x round kind x whose cast', () => {
  it('every VoteRoundType has a row for every NetworkType and caster (the axes are the source\'s)', () => {
    const types = declaredUnion('NetworkType');
    const kinds = declaredUnion('VoteRoundType');
    const missing = [];
    for (const type of types) for (const caster of CASTERS) for (const kind of kinds) {
      if (!(kind in (EXPECTED[type]?.[caster] ?? {}))) missing.push(`${type} x ${caster} x ${kind}`);
    }
    assert.deepEqual(missing, [], `cells with no expected verdict: ${missing.join('; ')}`);
    assert.deepEqual(Object.keys(EXPECTED).sort(), [...types].sort(), 'a network type here that the source does not declare');
  });

  const cells = [];
  for (const [type, byCaster] of Object.entries(EXPECTED)) {
    for (const [caster, byKind] of Object.entries(byCaster)) {
      for (const [kind, want] of Object.entries(byKind)) cells.push([type, caster, kind, want]);
    }
  }
  it('each cell gives its verdict', () => {
    const wrong = [];
    for (const [type, caster, kind, want] of cells) {
      const { net, round } = cellOf(type, caster, kind);
      const got = roundVerdict(net, round);
      if (got !== want) wrong.push(`${type} x ${caster} x ${kind}: ${got} (want ${want})`);
    }
    assert.deepEqual(wrong, [], `cells whose verdict is not the rule's:\n${wrong.join('\n')}`);
  });
});

describe('pub/sub: the publisher\'s cast alone', () => {
  it('the publisher\'s own round passes on its own yes, but a join, removal or space addition never does', () => {
    for (const kind of ['meta_change', 'space_deletion', 'space_wipe']) {
      assert.equal(roundVerdict(publishing(), roundOf(kind, { subjectInstanceId: SELF, votes: [cast(SELF)], proposedHere: true })), 'passed', kind);
    }
    for (const kind of ['join', 'remove', 'space_addition']) {
      assert.equal(roundVerdict(publishing(), roundOf(kind, { votes: [cast(SELF)], proposedHere: true })), null, kind);
    }
  });

  it('a subscriber\'s veto counts nothing: the publisher\'s round passes on a subscriber', () => {
    assert.equal(roundVerdict(subscribing(), roundOf('meta_change', { votes: [cast(PEER_A), cast(PEER_C, 'veto')] })), 'passed');
  });

  it('the publisher\'s veto vetoes it', () => {
    assert.equal(roundVerdict(subscribing(), roundOf('meta_change', { votes: [cast(PEER_A, 'veto')] })), 'vetoed');
  });

  it('a subscriber\'s round the publisher holds (stored before the upgrade) never passes, and expires at its deadline', () => {
    const held = { subjectInstanceId: PEER_B, votes: [cast(PEER_B), cast(SELF)] };
    assert.equal(roundVerdict(publishing(), roundOf('meta_change', held)), null);
    assert.equal(roundVerdict(publishing(), roundOf('meta_change', { ...held, deadline: past() })), 'expired');
  });

  it('with no single publisher derivable (two upstreams), nothing passes', () => {
    const two = network('pubsub', [member(PEER_A, 'pull'), member(PEER_B, 'pull')]);
    assert.equal(roundVerdict(two, roundOf('meta_change', { votes: [cast(PEER_A), cast(PEER_B)] })), null);
  });

  it('a subscriber\'s own deletion or wipe still acts now: ownYesCarries stays true for it', () => {
    assert.equal(ownYesCarries(subscribing(), { instanceId: SELF, instanceLabel: 'self' }), true);
    assert.equal(ownYesCarries(publishing(), { instanceId: SELF, instanceLabel: 'self' }), true);
  });
});

describe('pubsubDecider', () => {
  // A missing module or export fails the file at its import, for that reason: a swallowed import turned every case below into one failure that named no cause.
  let pubsubDecider;
  before(async () => {
    ({ pubsubDecider } = await import('../../server/dist/networks/round-decider.js'));
    assert.equal(typeof pubsubDecider, 'function', 'server/src/networks/round-decider.ts exports no pubsubDecider (Q-968, Q2)');
  });
  const decider = () => pubsubDecider;

  it('one pull member: that member decides', () => {
    assert.equal(decider()(subscribing()), PEER_A);
  });
  it('no pull member: this instance publishes and decides', () => {
    assert.equal(decider()(publishing()), SELF);
  });
  it('two pull members: no one decides', () => {
    assert.equal(decider()(network('pubsub', [member(PEER_A, 'pull'), member(PEER_B, 'pull')])), null);
  });
  it('a network of another type has no publisher', () => {
    assert.equal(decider()(network('club', [member(PEER_A, 'pull')])), null);
  });
});

describe('adoption: network type x round kind x who served it', () => {
  const now = () => Date.now();
  const ADOPT = null;
  const NEVER = 'a kind this network type never opens';
  const SUBSCRIBERS = 'proposed by a subscriber';
  /**
   * Every cell's answer, by hand: `null` adopts the served round, a string is why it is refused. On pub/sub the SERVER is the publisher (this
   * instance subscribes) or a subscriber (this instance publishes); elsewhere any member serves it. Kind order as `EXPECTED`.
   */
  const ADOPTION = {
    'pubsub, served by the publisher': { join: NEVER, remove: NEVER, space_deletion: ADOPT, space_wipe: ADOPT, meta_change: ADOPT, space_addition: NEVER },
    'pubsub, served by a subscriber': { join: NEVER, remove: NEVER, space_deletion: SUBSCRIBERS, space_wipe: SUBSCRIBERS, meta_change: SUBSCRIBERS, space_addition: NEVER },
    club: { join: NEVER, remove: NEVER, space_deletion: ADOPT, space_wipe: ADOPT, meta_change: ADOPT, space_addition: ADOPT },
    closed: { join: ADOPT, remove: ADOPT, space_deletion: ADOPT, space_wipe: ADOPT, meta_change: ADOPT, space_addition: ADOPT },
    democratic: { join: ADOPT, remove: ADOPT, space_deletion: ADOPT, space_wipe: ADOPT, meta_change: ADOPT, space_addition: ADOPT },
    braintree: { join: ADOPT, remove: ADOPT, space_deletion: ADOPT, space_wipe: ADOPT, meta_change: ADOPT, space_addition: ADOPT },
  };
  const netOf = (row) => row === 'pubsub, served by the publisher' ? subscribing()
    : row === 'pubsub, served by a subscriber' ? publishing()
      : network(row, [member(PEER_A), member(PEER_B), member(PEER_C)]);
  const servedBy = (row, kind) => roundOf(kind, row === 'pubsub, served by a subscriber'
    ? { subjectInstanceId: PEER_B, votes: [cast(PEER_B)] } : { votes: [cast(PEER_A)] });

  it('the table has a row for every network type and every kind (the axes are the source\'s)', () => {
    const types = declaredUnion('NetworkType');
    const kinds = declaredUnion('VoteRoundType');
    const rowTypes = Object.keys(ADOPTION).map(r => r.split(',')[0]);
    assert.deepEqual([...new Set(rowTypes)].sort(), [...types].sort());
    for (const [row, cells] of Object.entries(ADOPTION)) assert.deepEqual(Object.keys(cells).sort(), [...kinds].sort(), row);
  });

  it('each cell adopts, or refuses for its reason', () => {
    const wrong = [];
    for (const [row, cells] of Object.entries(ADOPTION)) {
      for (const [kind, want] of Object.entries(cells)) {
        const got = adoptionRefusal(netOf(row), servedBy(row, kind), now());
        if (got !== want) wrong.push(`${row} x ${kind}: ${got} (want ${want})`);
      }
    }
    assert.deepEqual(wrong, [], `cells whose adoption is not the rule's:\n${wrong.join('\n')}`);
  });

  it('on a club, a served remove or join round is refused and, held, never passes', () => {
    const club = network('club', [member(PEER_A), member(PEER_B), member(PEER_C)]);
    for (const kind of ['join', 'remove']) {
      const served = roundOf(kind, { subjectInstanceId: kind === 'remove' ? PEER_C : JOINER, votes: [cast(PEER_A), cast(PEER_B)] });
      assert.notEqual(adoptionRefusal(club, served, now()), null, `a club adopted a served ${kind} round`);
      assert.equal(roundVerdict(club, served), null, `a served ${kind} round passed on a club`);
    }
  });
});
