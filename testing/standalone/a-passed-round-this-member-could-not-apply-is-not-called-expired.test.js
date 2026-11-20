/**
 * A `meta_change` round the network passed and this member could not apply ends `passed`, marked not applied here, never `expired` (bundle-270,
 * fix round 4, finding R6; tail find T6).
 *
 * ## The defect
 *
 * A passed round whose apply throws is reopened and retried at each settle (second review F3). At its deadline `roundVerdict` reads the clock
 * before the casts (a round past its deadline is `expired`), so the round this member's own settles had seen PASSED ended `expired`, on the
 * member and in its outcome log, while every other member that applied it recorded `passed`. The word said the vote ran out; what happened is
 * that the network decided and this member could not apply it (its schema then arrives as the layer the meta pull stores).
 *
 * ## The rule
 *
 * The member that saw the round pass and could not apply it keeps that fact (`VoteRound.notAppliedHere`, local: never taken from or served to a
 * peer). At the deadline the round ends with the word `passed`, and its log entry says `notApplied`. `passed` stays false on the round (it is the
 * flag decisions read, and nothing was applied here). A round that ran out with no pass is still `expired`, and a round applied is `passed` with no mark.
 *
 * ## What this spec holds
 *
 * Retried at each settle as before; at the deadline the round and its one log entry say `passed` and `notApplied`; the control round (no cast) ends
 * `expired` with no mark; a round applied at once has no mark.
 *
 * Run: node --test testing/standalone/a-passed-round-this-member-could-not-apply-is-not-called-expired.test.js (requires a prior server build)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tempInstanceDir, bootInstance, removeInstanceDir } from './_vote-round-instance.mjs';
import { SELF, P1 } from './_vote-round-sites.mjs';

const dir = tempInstanceDir('ythril-passed-unapplied-');
const NET = '66666666-6666-4666-8666-666666666666';
const SPACE = 'notes';

let loader, settle, governance;

before(async () => {
  loader = await bootInstance(dir, { instanceId: SELF });
  settle = await import('../../server/dist/networks/round-conclusion.js');
  governance = await import('../../server/dist/sync/governance.js');
});
after(() => { governance.setMetaChangeApplyHookForTest?.(null); removeInstanceDir(dir); });

const member = (instanceId) => ({ instanceId, label: 'member', url: 'https://member.example', tokenHash: 'h', direction: 'both' });

/** A `meta_change` round of a club (the first yes decides), proposed by a member; `votes` empty makes a round nobody answered. */
function roundOf(id, { voted }) {
  const now = Date.now();
  return {
    roundId: id, type: 'meta_change', subjectInstanceId: P1, subjectLabel: 'proposer', subjectUrl: '',
    openedAt: new Date(now - 3_600_000).toISOString(), deadline: new Date(now + 82_800_000).toISOString(),
    votes: voted ? [{ instanceId: P1, vote: 'yes', castAt: new Date(now - 3_000_000).toISOString() }] : [],
    spaceId: SPACE, networkSpaceId: SPACE, pendingMeta: { purpose: 'the purpose the network chose' }, metaChangedFields: ['purpose'], baseMetaVersion: 0,
  };
}

async function boot(round) {
  await bootInstance(dir, {
    instanceId: SELF,
    spaces: [{ id: 'general', label: 'General', builtIn: true, folders: [] }, { id: SPACE, label: 'Notes', folders: [], meta: { purpose: 'the purpose before' } }],
    networks: [{
      id: NET, label: 'Net', type: 'club', origin: 'created', syncSchedule: '', spaces: [SPACE], votingDeadlineHours: 24,
      createdAt: '2026-01-01T00:00:00.000Z', members: [member(P1)], pendingRounds: [round], roundOutcomes: [],
    }],
  });
}

const netNow = () => loader.getConfig().networks.find(n => n.id === NET);
const roundNow = (id) => netNow().pendingRounds.find(r => r.roundId === id);
const entriesOf = (id) => netNow().roundOutcomes.filter(e => e.roundId === id);
const settleAt = (id, now) => settle.settleRounds(netNow(), loader.getConfig(), [roundNow(id)], 'tick', now);
const deadlineOf = (round) => Date.parse(round.deadline);

describe('the word a round gets at its deadline when the network passed it and this member could not apply it', () => {
  it('a round the votes passed and the apply never took ends passed, marked not applied here, and is logged once', async () => {
    const round = roundOf('round-passed-unapplied', { voted: true });
    await boot(round);
    governance.setMetaChangeApplyHookForTest(() => { throw new Error('planted: the apply fails every time'); });
    try {
      for (let i = 0; i < 3; i += 1) {
        assert.equal(settleAt(round.roundId, Date.now()).failed.length, 1, `settle ${i}: retried, the failure told`);
        assert.equal(roundNow(round.roundId).concluded, false, `settle ${i}: the round stays open`);
      }
      settleAt(round.roundId, deadlineOf(round) + 60_000);
      const ended = roundNow(round.roundId);
      assert.equal(ended.concluded, true, 'the round ends at its deadline');
      assert.equal(ended.outcome, 'passed', 'the network passed it: the word is not expired');
      assert.equal(ended.notAppliedHere, true, 'and it says it was not applied here');
      const entries = entriesOf(round.roundId);
      assert.equal(entries.length, 1, 'the log records it once');
      assert.equal(entries[0].outcome, 'passed');
      assert.equal(entries[0].notApplied, true, 'the entry says the change was not applied here');
    } finally { governance.setMetaChangeApplyHookForTest(null); }
  });

  it('a round nobody answered still ends expired, with no mark', async () => {
    const round = roundOf('round-nobody-answered', { voted: false });
    await boot(round);
    settleAt(round.roundId, deadlineOf(round) + 60_000);
    const ended = roundNow(round.roundId);
    assert.equal(ended.outcome, 'expired');
    assert.equal(ended.notAppliedHere, undefined);
    assert.equal(entriesOf(round.roundId)[0].outcome, 'expired');
    assert.equal(entriesOf(round.roundId)[0].notApplied, undefined);
  });

  it('a round applied at once is passed, with no mark', async () => {
    const round = roundOf('round-applied', { voted: true });
    await boot(round);
    assert.deepEqual(settleAt(round.roundId, Date.now()).failed, []);
    const ended = roundNow(round.roundId);
    assert.equal(ended.outcome, 'passed');
    assert.equal(ended.notAppliedHere, undefined);
    assert.equal(entriesOf(round.roundId)[0].notApplied, undefined);
  });
});
