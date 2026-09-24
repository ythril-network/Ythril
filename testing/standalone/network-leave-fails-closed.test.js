/**
 * Leaving a network is guarded, and an unknown establisher fails CLOSED.
 *
 * ## What is being protected
 *
 * A token at `networks: write` may join a network and may leave one it joined itself. Removing a
 * membership another token established needs `networks: admin`. (The rungs were `in`/`out`/`leave` before the
 * column existed; F-34 gave Networks the same four rungs as every other area.) Leaving does not stop data leaving
 * retroactively — peers keep what they hold — so the thing worth guarding is not the egress but the
 * dismantling: a publisher leaving strands its subscribers, a braintree parent orphans its subtree.
 *
 * ## The case that decides whether this guard is real
 *
 * Every membership that predates the `spaceOrigins` map has no recorded establisher. If unknown resolved to
 * "allowed", the guard would be absent on exactly the memberships that have existed longest and carry the
 * most peers — the ones it exists for. Unknown must therefore be a refusal, and it has its own verdict so
 * the refusal can say which of the two reasons it was.
 *
 * Run: node --test testing/standalone/network-leave-fails-closed.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

let mayLeaveNetwork, recordOrigin, forgetOrigin;
before(async () => {
  ({ mayLeaveNetwork, recordOrigin, forgetOrigin } =
    await import('../../server/dist/auth/network-membership.js'));
});

const req = (over) => ({ origins: {}, spaceId: 'qa', tokenId: 't1', rung: 'write', ...over });

describe('who may leave a network', () => {
  it('the admin rung may leave anything, with no origin recorded at all', () => {
    // Order matters: `admin` must short-circuit BEFORE the ownership check, or the admin rung would depend
    // on data that is absent for every pre-existing membership — the exact case it exists to unblock.
    const v = mayLeaveNetwork(req({ rung: 'admin', origins: undefined }));
    assert.deepEqual(v, { allowed: true, because: 'admin-rung' });
  });

  it('a token may leave the membership it established', () => {
    const v = mayLeaveNetwork(req({ origins: { qa: 't1' } }));
    assert.deepEqual(v, { allowed: true, because: 'own-membership' });
  });

  it('a token may NOT leave a membership another token established', () => {
    const v = mayLeaveNetwork(req({ origins: { qa: 't2' } }));
    assert.deepEqual(v, { allowed: false, because: 'not-your-membership' });
  });

  it('an UNKNOWN establisher is refused, not waved through', () => {
    // The decisive case. Every membership older than the origins map lands here.
    assert.deepEqual(mayLeaveNetwork(req({ origins: {} })),
      { allowed: false, because: 'origin-unknown' });
    assert.deepEqual(mayLeaveNetwork(req({ origins: undefined })),
      { allowed: false, because: 'origin-unknown' });
    assert.deepEqual(mayLeaveNetwork(req({ origins: { other: 't1' } })),
      { allowed: false, because: 'origin-unknown' });
  });

  it('the lower rungs cannot leave at all, whoever established it', () => {
    // set-claim: the two rungs BELOW the threshold, a deliberate subset of the ladder rather than a copy
    // of it -- the cases either side assert what the higher rungs may do, which is the other half.
    for (const rung of ['none', 'read']) {
      assert.deepEqual(mayLeaveNetwork(req({ rung, origins: { qa: 't1' } })),
        { allowed: false, because: 'insufficient-rung' },
        `rung ${rung} was allowed to leave a network`);
    }
  });

  it('refusals are distinguishable from each other', () => {
    // Three refusals with one reason between them would make "you may not" unactionable: ask an admin, ask
    // the token that joined, or record the origin are three different next steps.
    const reasons = new Set([
      mayLeaveNetwork(req({ rung: 'read' })).because,
      mayLeaveNetwork(req({ origins: {} })).because,
      mayLeaveNetwork(req({ origins: { qa: 't2' } })).because,
    ]);
    assert.equal(reasons.size, 3, `expected three distinct refusal reasons, got ${[...reasons]}`);
  });
});

describe('the origin map', () => {
  it('recordOrigin returns a new map rather than mutating', () => {
    // A caller that writes the origin and then fails to persist the network would otherwise leave the map
    // claiming an establisher for a membership that does not exist.
    const before = { a: 't9' };
    const after = recordOrigin(before, 'qa', 't1');
    assert.deepEqual(before, { a: 't9' }, 'the input was mutated');
    assert.deepEqual(after, { a: 't9', qa: 't1' });
    assert.deepEqual(recordOrigin(undefined, 'qa', 't1'), { qa: 't1' });
  });

  it('forgetOrigin drops the entry, because a stale one is a PERMISSION', () => {
    // A space removed and re-added by a different token would otherwise inherit the first token's claim,
    // and that token could then leave a membership it never made.
    assert.deepEqual(forgetOrigin({ qa: 't1', b: 't2' }, 'qa'), { b: 't2' });
    assert.equal(forgetOrigin({ qa: 't1' }, 'qa'), undefined, 'an emptied map should not linger as {}');
    assert.deepEqual(forgetOrigin({ b: 't2' }, 'qa'), { b: 't2' }, 'an absent key must be a no-op');
    assert.equal(forgetOrigin(undefined, 'qa'), undefined);
  });

  it('re-adding after forgetting does not restore the old claim', () => {
    // The whole point of forgetOrigin, asserted end to end rather than left to inference.
    let o = recordOrigin(undefined, 'qa', 't1');
    o = forgetOrigin(o, 'qa');
    o = recordOrigin(o, 'qa', 't2');
    assert.deepEqual(mayLeaveNetwork({ origins: o, spaceId: 'qa', tokenId: 't1', rung: 'write' }),
      { allowed: false, because: 'not-your-membership' });
    assert.deepEqual(mayLeaveNetwork({ origins: o, spaceId: 'qa', tokenId: 't2', rung: 'write' }),
      { allowed: true, because: 'own-membership' });
  });
});
