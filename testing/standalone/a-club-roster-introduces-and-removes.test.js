/**
 * The roster rule a club mesh rests on (`Q-135`), without a stack: `mergePeerRoster` turns a peer's unknown members
 * into introductions and applies its removals, and the later of an admission and a removal wins.
 *
 * The three-instance proof is `testing/sync/a-club-member-pairs-with-every-other-member.test.js`. This file pins the
 * decisions that test cannot reach one at a time: a stale roster must not bring a removed member back, a removal
 * older than an admission must not undo it, and nothing of this touches a network that is not a club.
 *
 * Run: npm run build -w server && node --test testing/standalone/a-club-roster-introduces-and-removes.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mergePeerRoster, stampAdmission, recordRemoval } from '../../server/dist/networks/member-introductions.js';

const SELF = 'aaaa-self';
const PEER = 'bbbb-peer';
const T1 = '2026-09-01T00:00:00.000Z';
const T2 = '2026-09-02T00:00:00.000Z';

const club = (over = {}) => ({ id: 'n', type: 'club', members: [{ instanceId: PEER, label: 'peer', url: 'https://peer.example', tokenHash: '', direction: 'both' }], pendingRounds: [], ...over });
const listed = (id, admittedAt) => ({ instanceId: id, label: id, url: `https://${id}.example`, ...(admittedAt ? { admittedAt } : {}) });

describe('a club roster introduces and removes', () => {
  it('an unknown member a peer lists becomes an introduction, never a member', () => {
    const net = club();
    const r = mergePeerRoster(net, SELF, PEER, [listed('cccc'), listed(SELF)], []);
    assert.equal(r.changed, true);
    assert.deepEqual(net.introductions.map(i => [i.instanceId, i.introducedBy]), [['cccc', PEER]]);
    assert.ok(!net.members.some(m => m.instanceId === 'cccc'), 'a member needs credentials, which only pairing gives');
  });

  it('a removal newer than the admission removes the member, and is kept so it travels on', () => {
    const net = club({ members: [...club().members, { ...listed('cccc', T1), tokenHash: '', direction: 'both' }] });
    const r = mergePeerRoster(net, SELF, PEER, [], [{ instanceId: 'cccc', removedAt: T2 }]);
    assert.deepEqual(r.removed, ['cccc']);
    assert.ok(!net.members.some(m => m.instanceId === 'cccc'));
    assert.deepEqual(net.removedMembers, [{ instanceId: 'cccc', removedAt: T2 }]);
  });

  it('a removal older than the admission leaves the member alone', () => {
    const net = club({ members: [...club().members, { ...listed('cccc', T2), tokenHash: '', direction: 'both' }] });
    const r = mergePeerRoster(net, SELF, PEER, [], [{ instanceId: 'cccc', removedAt: T1 }]);
    assert.deepEqual(r.removed, []);
    assert.ok(net.members.some(m => m.instanceId === 'cccc'));
  });

  it('a stale roster cannot bring a removed member back, and a newer admission can', () => {
    const net = club();
    recordRemoval(net, 'cccc', T2);
    mergePeerRoster(net, SELF, PEER, [listed('cccc', T1)], []);
    assert.equal((net.introductions ?? []).length, 0, 'admitted before it was removed: stays removed');
    mergePeerRoster(net, SELF, PEER, [listed('cccc', '2026-09-03T00:00:00.000Z')], []);
    assert.deepEqual(net.introductions.map(i => i.instanceId), ['cccc'], 're-admitted after: introduced again');
  });

  it('never removes this instance or the peer that is answering', () => {
    const net = club();
    const r = mergePeerRoster(net, SELF, PEER, [], [{ instanceId: SELF, removedAt: T2 }, { instanceId: PEER, removedAt: T2 }]);
    assert.deepEqual(r.removed, []);
    assert.ok(net.members.some(m => m.instanceId === PEER));
  });

  it('an admission made here stamps its time and forgets an older removal of the same instance', () => {
    const net = club();
    recordRemoval(net, 'cccc', T1);
    const m = { instanceId: 'cccc', label: 'c', url: 'https://c.example', tokenHash: '', direction: 'both' };
    stampAdmission(net, m);
    assert.ok(m.admittedAt && Date.parse(m.admittedAt) > Date.parse(T1));
    assert.equal(net.removedMembers.length, 0);
  });

  it('touches nothing on a network that is not a club', () => {
    for (const type of ['closed', 'democratic', 'pubsub', 'braintree']) {
      const net = club({ type });
      const r = mergePeerRoster(net, SELF, PEER, [listed('cccc')], [{ instanceId: PEER, removedAt: T2 }]);
      assert.equal(r.changed, false, type);
      assert.equal(net.introductions, undefined, type);
    }
  });
});
