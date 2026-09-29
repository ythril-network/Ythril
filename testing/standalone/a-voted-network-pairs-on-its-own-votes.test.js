/**
 * A closed or democratic network pairs its members on the authority of its own votes, never on one member's word
 * (`Q-154`).
 *
 * `Q-135` made a club a mesh: a peer's roster introduces the members it lists. On a voted network that would let one
 * member admit an instance nobody voted for — and an admitted instance votes. So here the authority is the vote:
 *
 * - a PASSED join round introduces its subject on every member that concludes it, and pairing follows;
 * - a newcomer trusts the roster of the member that admitted it, which is how it learns the members voted in before it;
 * - any other roster entry — a network whose admissions predate this, whose rounds are long pruned — waits for this
 *   instance's operator to accept it, and nothing pairs with it until then;
 * - a roster's removals are not applied on a voted network: a passed remove round already removes on every member.
 *
 * Run: npm run build -w server && node --test testing/standalone/a-voted-network-pairs-on-its-own-votes.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mergePeerRoster, introduceFromPassedJoin, acceptIntroduction, applyPassedJoin, pairRetryDue, PAIR_RETRY_MS } from '../../server/dist/networks/member-introductions.js';
import { trackedSources, REPO_ROOT } from './_sources.mjs';

const SELF = 'aaaa-self';
const ADMITTER = 'bbbb-admitter';
const OTHER = 'dddd-other';
const T2 = '2026-09-02T00:00:00.000Z';

const member = id => ({ instanceId: id, label: id, url: `https://${id}.example`, tokenHash: '', direction: 'both' });
const voted = (type, over = {}) => ({ id: 'n', type, members: [member(ADMITTER), member(OTHER)], pendingRounds: [], ...over });
const listed = id => ({ instanceId: id, label: id, url: `https://${id}.example` });
const passedJoin = id => ({ roundId: 'r1', type: 'join', subjectInstanceId: id, subjectLabel: id, subjectUrl: `https://${id}.example`,
  deadline: T2, openedAt: T2, votes: [], concluded: true, passed: true });

describe('a voted network pairs on its own votes', () => {
  for (const type of ['closed', 'democratic']) {
    it(`${type}: a passed join round introduces its subject, ready to pair`, () => {
      const net = voted(type);
      assert.equal(introduceFromPassedJoin(net, SELF, passedJoin('cccc')), true);
      const intro = net.introductions.find(i => i.instanceId === 'cccc');
      assert.ok(intro, 'the newcomer is introduced');
      assert.equal(intro.needsApproval, undefined, 'a passed vote needs nobody\'s further OK');
      assert.equal(intro.url, 'https://cccc.example');
    });

    it(`${type}: a round that did not pass, or names this instance or a member, introduces nothing`, () => {
      const net = voted(type);
      assert.equal(introduceFromPassedJoin(net, SELF, { ...passedJoin('cccc'), passed: false }), false);
      assert.equal(introduceFromPassedJoin(net, SELF, passedJoin(SELF)), false);
      assert.equal(introduceFromPassedJoin(net, SELF, passedJoin(OTHER)), false);
      assert.equal((net.introductions ?? []).length, 0);
    });

    it(`${type}: the member that admitted this instance introduces without an OK`, () => {
      const net = voted(type, { admittedVia: ADMITTER });
      mergePeerRoster(net, SELF, ADMITTER, [listed('eeee')], []);
      assert.equal(net.introductions.find(i => i.instanceId === 'eeee')?.needsApproval, undefined);
    });

    it(`${type}: any other member's roster only proposes, and waits for the operator`, () => {
      const net = voted(type, { admittedVia: ADMITTER });
      mergePeerRoster(net, SELF, OTHER, [listed('ffff')], []);
      const intro = net.introductions.find(i => i.instanceId === 'ffff');
      assert.equal(intro?.needsApproval, true, 'one member\'s word must not admit a voter');
      assert.equal(acceptIntroduction(net, 'ffff'), true);
      assert.equal(intro.needsApproval, undefined, 'accepted, it pairs like any other');
    });

    it(`${type}: a roster's removals are left to the network's own remove vote`, () => {
      const net = voted(type, { admittedVia: ADMITTER, members: [member(ADMITTER), { ...member(OTHER), admittedAt: '2026-09-01T00:00:00.000Z' }] });
      const r = mergePeerRoster(net, SELF, ADMITTER, [], [{ instanceId: OTHER, removedAt: T2 }]);
      assert.deepEqual(r.removed, []);
      assert.ok(net.members.some(m => m.instanceId === OTHER));
    });
  }

  it('pub/sub and trees stay out of it', () => {
    for (const type of ['pubsub', 'braintree']) {
      const net = voted(type);
      assert.equal(introduceFromPassedJoin(net, SELF, passedJoin('cccc')), false, type);
      mergePeerRoster(net, SELF, ADMITTER, [listed('eeee')], []);
      assert.equal(net.introductions, undefined, type);
    }
  });
});

describe('a passed join lands through one rule, wherever it concludes', () => {
  for (const type of ['closed', 'democratic']) {
    it(`${type}: a member without the joiner's credentials introduces it rather than admitting it`, () => {
      // The copy a member learns by gossip has its token hash stripped. Admitted from that, the joiner is a member here
      // with no credential either way — listed, never paired, and every pairing it asks for refused (#1455's red run).
      const net = voted(type);
      const round = { ...passedJoin('cccc'), pendingMember: { ...member('cccc'), tokenHash: '' } };
      assert.equal(applyPassedJoin(net, SELF, round), 'introduced');
      assert.ok(!net.members.some(m => m.instanceId === 'cccc'));
      assert.ok(net.introductions.some(i => i.instanceId === 'cccc'));
    });

    it(`${type}: the member holding them admits`, () => {
      const net = voted(type);
      const round = { ...passedJoin('cccc'), pendingMember: { ...member('cccc'), tokenHash: '$2b$hash' } };
      assert.equal(applyPassedJoin(net, SELF, round), 'admitted');
      assert.ok(net.members.some(m => m.instanceId === 'cccc'));
    });
  }

  it('nothing outside the rule adds a round\'s pending member to a roster', () => {
    /*
     * The rule had three copies — the gossip pull, the vote relay and the local vote — and converting two left the
     * third admitting on a stripped copy. Derived over the tree, so a fourth site is visible on the commit adding it.
     * The one other site is the joiner's poll, answered only by the instance that holds the invite key's hash: the
     * credential holder, re-adding a member whose admission a crash lost.
     */
    const owners = ['server/src/networks/member-introductions.ts', 'server/src/networks/member-acts.ts'];
    const offenders = trackedSources(['server/src'], { untracked: true, exclude: owners })
      .filter(f => /members\.push\(\s*\w*\.?pendingMember/.test(readFileSync(`${REPO_ROOT}/${f}`, 'utf8')));
    assert.deepEqual(offenders, [], `these admit a passed join themselves instead of through applyPassedJoin: ${offenders.join(', ')}`);
  });
});

describe('a refused pairing is retried soon, then less often', () => {
  /*
   * Every member of a voted network learns of a passed join at about the same moment, so the opener's first call
   * can reach a member that has not concluded the round yet and be refused as "not introduced". On a flat five-minute
   * retry that race cost five minutes per pair (#1455's second red run); a failure that is not a race is still
   * retried at most every five minutes.
   */
  const at = ms => new Date(ms).toISOString();
  it('a pairing never tried is due at once', () => {
    assert.equal(pairRetryDue({}, 0), true);
  });
  it('the first retry comes within half a minute, and the wait doubles to the ceiling', () => {
    const t0 = 1_000_000;
    assert.equal(pairRetryDue({ attempts: 1, lastAttemptAt: at(t0) }, t0 + 29_000), false);
    assert.equal(pairRetryDue({ attempts: 1, lastAttemptAt: at(t0) }, t0 + 30_000), true);
    assert.equal(pairRetryDue({ attempts: 2, lastAttemptAt: at(t0) }, t0 + 30_000), false);
    assert.equal(pairRetryDue({ attempts: 2, lastAttemptAt: at(t0) }, t0 + 60_000), true);
    assert.equal(pairRetryDue({ attempts: 20, lastAttemptAt: at(t0) }, t0 + PAIR_RETRY_MS - 1), false);
    assert.equal(pairRetryDue({ attempts: 20, lastAttemptAt: at(t0) }, t0 + PAIR_RETRY_MS), true);
  });
});
