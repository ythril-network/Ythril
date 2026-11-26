/**
 * On a pub/sub network this instance PUBLISHES on, the operator's cast is taken only on a round this instance opened (Q-968, F3 of the review).
 *
 * ## What it prevents
 *
 * A round a subscriber opened before the upgrade stays stored on the publisher. The publisher's own cast alone decides a pub/sub round, so a
 * publisher that voted yes on such a round passed it on its own yes: every subscriber then applied a schema (or an added space, or a deletion)
 * a SUBSCRIBER chose, and the publisher never applied it itself (`adoptionRefusal` stops a new adoption, not a round already held). The
 * operator act refuses the cast: 409 `round_not_opened_here`, nothing recorded, the round untouched.
 *
 * ## What is held
 *
 * - the publisher's cast on a round it did not open is refused, whatever the kind, and records nothing;
 * - the same cast on a round it opened is taken, and a subscriber's cast on the round its publisher opened is taken;
 * - a club's organiser still casts on a member's round (the rule is pub/sub's: a club's casts are every member's).
 *
 * Run: node --test testing/standalone/a-publisher-casts-only-on-a-round-it-opened.test.js  (requires a prior server build)
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { tempInstanceDir, removeInstanceDir, bootInstance } from './_vote-round-instance.mjs';

const SELF = 'aaaaaaaa-0000-4000-8000-000000005e1f';
const SUB = 'aaaaaaaa-0000-4000-8000-0000000000b2';
const PUBLISHER = 'aaaaaaaa-0000-4000-8000-0000000000a1';
const dir = tempInstanceDir('ythril-publisher-casts-');
after(() => removeInstanceDir(dir));

const HOUR = 3_600_000;
const T = Date.now();
const iso = (ms) => new Date(ms).toISOString();
const SPACES = [{ id: 'general', label: 'General', builtIn: true, folders: [] }, { id: 'notes', label: 'Notes', folders: [] }];
const member = (instanceId, direction) => ({ instanceId, label: `m${instanceId.slice(-2)}`, url: `https://${instanceId.slice(-2)}.example`, tokenHash: 'h', direction });
const KINDS = {
  meta_change: { spaceId: 'notes', pendingMeta: { purpose: 'a subscriber chose this' }, metaChangedFields: ['purpose'], baseMetaVersion: 0 },
  space_addition: { spaceId: 'fresh' },
  space_deletion: { spaceId: 'notes', networkSpaceId: 'notes' },
};
const round = (kind, over = {}) => ({
  roundId: `r-${kind}`, type: kind, subjectInstanceId: SUB, subjectLabel: 'Subscriber', subjectUrl: '', openedAt: iso(T - HOUR), deadline: iso(T + HOUR),
  votes: [], concluded: false, ...KINDS[kind], ...over,
});
const network = (type, members, rounds, over = {}) => ({
  id: 'n', label: 'N', type, origin: 'created', syncSchedule: '', spaces: ['general', 'notes'], members, votingDeadlineHours: 24,
  createdAt: '2026-01-01T00:00:00.000Z', pendingRounds: rounds, ...over,
});
const boot = (net) => bootInstance(dir, { instanceId: SELF, spaces: SPACES, networks: [net] });
const act = async () => (await import('../../server/dist/networks/vote-acts.js')).castVoteAct;
/** This instance publishes: its one member is a subscriber it pushes to. */
const publishing = (rounds) => network('pubsub', [member(SUB, 'push')], rounds);

describe('the publisher\'s cast on a round it did not open', () => {
  for (const kind of Object.keys(KINDS)) {
    it(`is refused 409 round_not_opened_here and records nothing: ${kind}`, async () => {
      const loader = await boot(publishing([round(kind, { votes: [{ instanceId: SUB, vote: 'yes', castAt: iso(T) }] })]));
      const res = (await act())('n', `r-${kind}`, { vote: 'yes' });
      assert.equal(res.status, 409, `the publisher's cast on a subscriber's ${kind} round was answered ${res.status}: ${JSON.stringify(res)}`);
      assert.equal(res.code, 'round_not_opened_here');
      const held = loader.getConfig().networks[0].pendingRounds[0];
      assert.deepEqual(held.votes.map(v => v.instanceId), [SUB], 'the refused cast was recorded anyway');
      assert.notEqual(held.concluded, true, 'the refused cast concluded the round');
    });
  }

  it('a veto is refused the same way: the round is not the publisher\'s to answer', async () => {
    const loader = await boot(publishing([round('meta_change')]));
    const res = (await act())('n', 'r-meta_change', { vote: 'veto' });
    assert.equal(res.status, 409, JSON.stringify(res));
    assert.deepEqual(loader.getConfig().networks[0].pendingRounds[0].votes, []);
  });
});

describe('the casts that stay open', () => {
  it('the publisher\'s cast on a round it opened is taken', async () => {
    const loader = await boot(publishing([round('meta_change', { subjectInstanceId: SELF, proposedHere: true })]));
    const res = (await act())('n', 'r-meta_change', { vote: 'yes' });
    assert.equal(res.status, 200, JSON.stringify(res));
    assert.ok(loader.getConfig().networks[0].pendingRounds[0].votes.some(v => v.instanceId === SELF));
  });

  it('a subscriber\'s cast on its publisher\'s round is taken', async () => {
    const net = network('pubsub', [member(PUBLISHER, 'pull')], [round('meta_change', { subjectInstanceId: PUBLISHER })], { origin: 'joined' });
    const loader = await boot(net);
    const res = (await act())('n', 'r-meta_change', { vote: 'yes' });
    assert.equal(res.status, 200, JSON.stringify(res));
    assert.ok(loader.getConfig().networks[0].pendingRounds[0].votes.some(v => v.instanceId === SELF));
  });

  it('a club organiser\'s cast on a member\'s round is taken: the rule is pub/sub\'s', async () => {
    const loader = await boot(network('club', [member(SUB, 'both')], [round('meta_change')]));
    const res = (await act())('n', 'r-meta_change', { vote: 'yes' });
    assert.notEqual(res.status, 409, JSON.stringify(res));
    assert.ok(loader.getConfig().networks[0].pendingRounds[0].votes.some(v => v.instanceId === SELF), 'a club\'s cast was refused');
  });
});
