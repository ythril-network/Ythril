/**
 * Where a passed `space_addition` round puts the space on each member, and when it refuses to (`F-38.4`).
 *
 * Club, closed and democratic networks sync every space both ways. So when a round adds space `notes`, a member that
 * already holds a local `notes` outside the network must not simply join it to the network: from the next cycle its
 * records would be pushed to every member. A member's own yes on the round is consent to that; nothing else is — on
 * a club no member votes, and on a democratic network a majority can pass a round this member never saw.
 *
 * Run: node --test testing/standalone/a-voted-space-addition-never-shares-a-local-space-unasked.test.js  (requires a prior server build)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

let spaceAdditionTarget;
before(async () => {
  ({ spaceAdditionTarget } = await import('../../server/dist/networks/network-spaces.js'));
});

const net = (over = {}) => ({ id: 'n', type: 'club', spaces: ['a'], members: [], pendingRounds: [], ...over });
const round = (over = {}) => ({ spaceId: 'notes', subjectInstanceId: 'proposer', votes: [{ instanceId: 'proposer', vote: 'yes' }], ...over });

describe('a member that does not have the space', () => {
  it('carries it under the network\'s id, creating it', () => {
    assert.deepEqual(spaceAdditionTarget(net(), round(), 'me', ['a']), { localId: 'notes' });
  });
});

describe('a member that already has a local space of that name', () => {
  it('does not share it when it did not vote yes', () => {
    const r = spaceAdditionTarget(net(), round(), 'me', ['a', 'notes']);
    assert.ok(r && 'skip' in r, `a local space was joined to the network unasked: ${JSON.stringify(r)}`);
  });
  it('does not share it when it vetoed', () => {
    const r = spaceAdditionTarget(net(), round({ votes: [{ instanceId: 'proposer', vote: 'yes' }, { instanceId: 'me', vote: 'veto' }] }), 'me', ['notes']);
    assert.ok(r && 'skip' in r);
  });
  it('shares it when it voted yes', () => {
    const r = spaceAdditionTarget(net(), round({ votes: [{ instanceId: 'proposer', vote: 'yes' }, { instanceId: 'me', vote: 'yes' }] }), 'me', ['notes']);
    assert.deepEqual(r, { localId: 'notes' });
  });
});

describe('the proposer', () => {
  it('carries its own space — the instance that opened the round here', () => {
    assert.deepEqual(spaceAdditionTarget(net(), round({ proposedHere: true }), 'me', ['notes']), { localId: 'notes' });
  });
  it('is not whoever the round names as subject — a peer sets that (S-7)', () => {
    const r = spaceAdditionTarget(net(), round({ subjectInstanceId: 'me' }), 'me', ['notes']);
    assert.ok(r && 'skip' in r, `a round naming this instance as subject was treated as its own: ${JSON.stringify(r)}`);
  });
});

describe('nothing to do', () => {
  it('a space the network already carries, under its alias too', () => {
    assert.equal(spaceAdditionTarget(net({ spaces: ['mine'], spaceMap: { notes: 'mine' } }), round(), 'me', ['mine']), null);
  });
  it('a round naming no usable space id', () => {
    for (const spaceId of [undefined, '', '../x', 'UP']) assert.equal(spaceAdditionTarget(net(), round({ spaceId }), 'me', []), null);
  });
});
