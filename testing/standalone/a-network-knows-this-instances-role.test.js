/**
 * Each network says what THIS instance is in it, and which members that role acts on (`F-38.1`).
 *
 * Owner, 2026-09-25: *"the own role in the network should be clear and instead of '1 member' on a pubsub i want to
 * see subscribers if im pub and nothing if im sub, on club i want to see peers, on braintree i want to see the path
 * to root and my sub-path"*. Before this every network showed a flat member count, and a publisher saw its
 * subscriber listed as `both`. The role is derived from topology the instance already stores, in one function the
 * page, `GET /api/networks/:id` and `network_get` all use.
 *
 * Run: node --test testing/standalone/a-network-knows-this-instances-role.test.js  (requires a prior server build)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

let networkRole;
before(async () => { ({ networkRole } = await import('../../server/dist/networks/network-role.js')); });

const member = (instanceId, over = {}) => ({ instanceId, label: instanceId, url: `https://${instanceId}`, tokenHash: 'x', direction: 'both', ...over });
const net = (over) => ({ id: 'n', label: 'n', spaces: ['s'], votingDeadlineHours: 24, members: [], pendingRounds: [], createdAt: '', ...over });
const ids = (list) => list.map(m => m.instanceId);

describe('pub/sub', () => {
  it('the publisher sees its subscribers', () => {
    const r = networkRole(net({ type: 'pubsub', origin: 'created', members: [member('sub1', { direction: 'push' }), member('sub2', { direction: 'push' })] }));
    assert.equal(r.role, 'publisher');
    assert.deepEqual(ids(r.members), ['sub1', 'sub2']);
  });
  it('a subscriber sees the publisher and no subscriber list', () => {
    const r = networkRole(net({ type: 'pubsub', origin: 'joined', members: [member('pub', { direction: 'pull' })] }));
    assert.equal(r.role, 'subscriber');
    assert.deepEqual(ids(r.members), []);
    assert.equal(r.publisher?.instanceId, 'pub');
  });
  it('a publisher with no subscribers yet is still the publisher', () => {
    assert.equal(networkRole(net({ type: 'pubsub', origin: 'created', members: [] })).role, 'publisher');
  });
});

describe('club', () => {
  it('the instance that created it organises it, and sees the peers', () => {
    const r = networkRole(net({ type: 'club', origin: 'created', members: [member('a'), member('b')] }));
    assert.equal(r.role, 'organiser');
    assert.deepEqual(ids(r.members), ['a', 'b']);
  });
  it('an instance that joined is a member, and sees the peers too', () => {
    const r = networkRole(net({ type: 'club', origin: 'joined', members: [member('org')] }));
    assert.equal(r.role, 'member');
    assert.deepEqual(ids(r.members), ['org']);
  });
  it('a network recorded before the origin existed is a member, never guessed to be the organiser', () => {
    assert.equal(networkRole(net({ type: 'club', members: [member('x')] })).role, 'member');
  });
});

describe('closed and democratic', () => {
  it('every instance is a member and sees its peers', () => {
    for (const type of ['closed', 'democratic']) {
      const r = networkRole(net({ type, origin: 'created', members: [member('a')] }));
      assert.equal(r.role, 'member');
      assert.deepEqual(ids(r.members), ['a']);
    }
  });
});

describe('braintree', () => {
  /*
   *        root
   *         |
   *        mid        <- this instance's parent
   *         |
   *       (self)
   *       /    \
   *   child1  child2
   *     |
   *   grand
   */
  const tree = (over = {}) => net({
    type: 'braintree', origin: 'joined', myParentInstanceId: 'mid',
    members: [
      member('root'),
      member('mid', { parentInstanceId: 'root' }),
      member('child1', { parentInstanceId: 'self', children: ['grand'] }),
      member('child2', { parentInstanceId: 'self' }),
      member('grand', { parentInstanceId: 'child1' }),
    ],
    ...over,
  });

  it('a node in the middle sees the path to the root and its whole subtree', () => {
    const r = networkRole(tree(), 'self');
    assert.equal(r.role, 'node');
    assert.deepEqual(ids(r.pathToRoot), ['mid', 'root']);
    assert.deepEqual(ids(r.subtree).sort(), ['child1', 'child2', 'grand']);
  });
  it('an instance with no parent is the root, with an empty path', () => {
    const r = networkRole(net({ type: 'braintree', origin: 'created', members: [member('c', { parentInstanceId: 'self' })] }), 'self');
    assert.equal(r.role, 'root');
    assert.deepEqual(ids(r.pathToRoot), []);
    assert.deepEqual(ids(r.subtree), ['c']);
  });
  it('an instance with a parent and no children is a leaf', () => {
    const r = networkRole(net({ type: 'braintree', origin: 'joined', myParentInstanceId: 'p', members: [member('p')] }), 'self');
    assert.equal(r.role, 'leaf');
    assert.deepEqual(ids(r.pathToRoot), ['p']);
    assert.deepEqual(ids(r.subtree), []);
  });
  it('a cycle in stored topology ends the walk instead of looping', () => {
    const r = networkRole(net({ type: 'braintree', origin: 'joined', myParentInstanceId: 'a',
      members: [member('a', { parentInstanceId: 'b' }), member('b', { parentInstanceId: 'a' })] }), 'self');
    assert.deepEqual(ids(r.pathToRoot), ['a', 'b']);
  });
});
