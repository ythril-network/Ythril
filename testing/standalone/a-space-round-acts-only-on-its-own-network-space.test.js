/**
 * A deletion or wipe round acts only when it PASSED, only on a space its network carries, mapped to the local id,
 * and only once (`S-9`).
 *
 * `applyConcludedSpaceRounds` removed or emptied `round.spaceId` for any round that was `concluded` with no veto — so a
 * round that expired without enough yes deleted too — using the id exactly as the round carried it, never mapped and
 * never checked against the network's spaces; and gossip handed it every round the network ever held on each change.
 * Any member of any network could delete or empty any space on another member by serving one round, and an old
 * deletion re-applied to a space re-created under the same name.
 *
 * `spaceRoundAction` is the decision, pure; this is its truth table.
 *
 * Run: node --test testing/standalone/a-space-round-acts-only-on-its-own-network-space.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

let spaceRoundAction;
before(async () => { ({ spaceRoundAction } = await import('../../server/dist/spaces/apply-wipe-round.js')); });

const net = { id: 'n1', spaces: ['shared', 'local-alias'], spaceMap: { 'remote-name': 'local-alias' } };
const round = (over = {}) => ({ roundId: 'r1', type: 'space_deletion', spaceId: 'shared', concluded: true, passed: true, votes: [{ instanceId: 'x', vote: 'yes' }], ...over });

describe('which space a concluded round acts on', () => {
  it('a passed deletion acts on the space its network carries', () => {
    assert.deepEqual(spaceRoundAction(net, round()), { kind: 'delete', localId: 'shared' });
    assert.deepEqual(spaceRoundAction(net, round({ type: 'space_wipe', wipeTypes: ['files'] })), { kind: 'wipe', localId: 'shared', types: ['files'] });
  });

  it('a round that concluded WITHOUT passing acts on nothing — an expired deletion is not a deletion', () => {
    assert.equal(spaceRoundAction(net, round({ passed: false })), null);
    assert.equal(spaceRoundAction(net, round({ type: 'space_wipe', passed: false })), null);
    assert.equal(spaceRoundAction(net, round({ concluded: false })), null);
  });

  it('a space the network does not carry is never touched, whatever the round names', () => {
    assert.equal(spaceRoundAction(net, round({ spaceId: 'private' })), null);
    assert.equal(spaceRoundAction(net, round({ type: 'space_wipe', spaceId: 'general' })), null);
  });

  it('the network\'s name for a space is mapped to this instance\'s', () => {
    assert.deepEqual(spaceRoundAction(net, round({ spaceId: 'remote-name' })), { kind: 'delete', localId: 'local-alias' });
  });

  it('a round already applied here is not applied again', () => {
    assert.equal(spaceRoundAction(net, round({ appliedHere: true })), null);
  });

  it('a veto still stops it, and other round types are not this decision\'s', () => {
    assert.equal(spaceRoundAction(net, round({ votes: [{ instanceId: 'x', vote: 'yes' }, { instanceId: 'y', vote: 'veto' }] })), null);
    assert.equal(spaceRoundAction(net, round({ type: 'meta_change' })), null);
  });
});
