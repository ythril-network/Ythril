/**
 * A `space_rebase` round wakes every member when it opens, as a deletion's round does (Q-748, slice A; design r4 §4.1 rule 4: "the notice
 * `space_rebase_pending`").
 *
 * The voting period is a member's time to veto or to leave before the base changes, so a member that learns of the round only at its next
 * scheduled cycle has less of it. The sender's table (`NOTICE_EVENTS`, `networks/notify-members.ts`) and the receiver's (`NotifyBody` and
 * `SYNC_TRIGGER_EVENTS`, `api/notify.ts`) must both carry the event: a notice the receiver's enum does not list is refused with a 400 that
 * the sender's fire-and-forget never reads (`Q-108`), which is how an event can be "sent" for months and reach nobody.
 *
 * Run: node --test testing/standalone/a-rebase-round-wakes-its-members.test.js (after the server build)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const sender = await import('../../server/dist/networks/notify-members.js');
const receiver = await import('../../server/dist/api/notify.js');

const body = (event) => ({ networkId: 'net-1', instanceId: 'aaaaaaaa-0000-4000-8000-0000000000a1', event, data: { spaceId: 'notes', spaceLabel: 'Notes' } });

describe('the space_rebase_pending notice', () => {
  it('the sender tells the members of a space_rebase round with it, and it wakes them', () => {
    const row = sender.NOTICE_EVENTS.find(r => r.round === 'space_rebase');
    assert.deepEqual(row, { event: 'space_rebase_pending', round: 'space_rebase', wakes: true }, 'no waking notice row for a space_rebase round');
  });
  it('the receiver accepts it and runs a sync cycle on it', () => {
    assert.equal(receiver.NotifyBody.safeParse(body('space_rebase_pending')).success, true, 'the receiver refuses space_rebase_pending');
    assert.ok(receiver.SYNC_TRIGGER_EVENTS.includes('space_rebase_pending'), 'the receiver records the notice and wakes nothing');
  });
  it('an event no build lists is refused, as it always was', () => {
    assert.equal(receiver.NotifyBody.safeParse(body('space_unknown_pending')).success, false);
  });
});
