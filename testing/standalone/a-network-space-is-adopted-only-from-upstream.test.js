/**
 * A space added to a network reaches the instances below the one that added it, and only from above (`F-38.3`).
 *
 * Nothing could add a space to a network after it was created. Now the position that governs a pub/sub or braintree
 * network — the publisher, the root — adds it, and every instance learns it from its UPSTREAM during the member
 * exchange it already runs each cycle: a subscriber from its publisher, a tree node from its parent. Anybody else
 * announcing a space is ignored, or a subscriber could push a space into its publisher and from there into every
 * other subscriber.
 *
 * Additive only: an announcement adds what is missing and never takes a space out.
 *
 * Run: node --test testing/standalone/a-network-space-is-adopted-only-from-upstream.test.js  (requires a prior server build)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

let upstreamOf, announcedSpaces, spacesToAdopt;
before(async () => {
  ({ upstreamOf, announcedSpaces, spacesToAdopt } = await import('../../server/dist/networks/network-spaces.js'));
});

const member = (instanceId, over = {}) => ({ instanceId, label: instanceId, url: `https://${instanceId}`, tokenHash: 'x', direction: 'both', ...over });
const net = (over) => ({ id: 'n', label: 'n', spaces: ['a'], votingDeadlineHours: 24, members: [], pendingRounds: [], createdAt: '', ...over });

const subscriberNet = (over = {}) => net({ type: 'pubsub', origin: 'joined', members: [member('pub', { direction: 'pull' })], ...over });

describe('who is upstream', () => {
  it('a subscriber\'s upstream is its publisher', () => {
    assert.equal(upstreamOf(subscriberNet()), 'pub');
  });
  it('a publisher has no upstream', () => {
    assert.equal(upstreamOf(net({ type: 'pubsub', origin: 'created', members: [member('sub', { direction: 'push' })] })), undefined);
  });
  it('a tree node\'s upstream is its parent, and the root has none', () => {
    assert.equal(upstreamOf(net({ type: 'braintree', myParentInstanceId: 'p', members: [member('p')] })), 'p');
    assert.equal(upstreamOf(net({ type: 'braintree', members: [member('c', { parentInstanceId: 'self' })] })), undefined);
  });
  it('club, closed and democratic networks have no upstream', () => {
    for (const type of ['club', 'closed', 'democratic']) assert.equal(upstreamOf(net({ type, members: [member('x', { direction: 'pull' })] })), undefined);
  });
});

describe('what is announced', () => {
  it('every space the network carries, in the network\'s own ids rather than local aliases', () => {
    assert.deepEqual(announcedSpaces(net({ spaces: ['a', 'mine'], spaceMap: { theirs: 'mine' } })), ['a', 'theirs']);
  });
});

describe('what is adopted', () => {
  it('a space the upstream announces and this instance lacks is adopted', () => {
    assert.deepEqual(spacesToAdopt(subscriberNet(), 'pub', ['a', 'b']), [{ networkId: 'b', localId: 'b' }]);
  });
  it('an announcement from anyone but the upstream adopts nothing', () => {
    assert.deepEqual(spacesToAdopt(subscriberNet({ members: [member('pub', { direction: 'pull' }), member('other')] }), 'other', ['b']), []);
  });
  it('a publisher adopts nothing, whoever announces', () => {
    assert.deepEqual(spacesToAdopt(net({ type: 'pubsub', origin: 'created', members: [member('sub', { direction: 'push' })] }), 'sub', ['b']), []);
  });
  it('a space already carried under an alias is not adopted a second time', () => {
    assert.deepEqual(spacesToAdopt(subscriberNet({ spaces: ['mine'], spaceMap: { theirs: 'mine' } }), 'pub', ['theirs']), []);
  });
  it('a space the upstream no longer announces stays — the announcement only adds', () => {
    assert.deepEqual(spacesToAdopt(subscriberNet({ spaces: ['a', 'kept'] }), 'pub', ['a']), []);
  });
  it('an id that could not name a space is ignored rather than created', () => {
    assert.deepEqual(spacesToAdopt(subscriberNet(), 'pub', ['../etc', 'UPPER', '', 42, null, 'x'.repeat(41), 'ok-1']),
      [{ networkId: 'ok-1', localId: 'ok-1' }]);
  });
  it('an announcement that is not a list adopts nothing', () => {
    for (const bad of [undefined, null, 'b', { b: 1 }]) assert.deepEqual(spacesToAdopt(subscriberNet(), 'pub', bad), []);
  });
});
