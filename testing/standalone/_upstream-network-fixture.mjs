/**
 * A config with one network of any type, in which instance `P` is the would-be upstream — for the tables that ask
 * who may delete what a peer relayed (`deliveryOf`, `authorises`, `backfillStamp`).
 *
 * ## What it answers
 *
 * *"What does this instance's config look like when P sits above it, beside it, or nowhere?"* One builder, because the
 * two tables over it (the authority truth table and the back-fill stamping table) must agree on what a pub/sub
 * subscriber, a braintree child and a mesh member ARE, and two hand-built copies are how they would drift.
 *
 * ## The shapes it builds
 *
 *  - `pubsub`: this instance is a SUBSCRIBER — P is stored `pull`, which is how the network names its publisher;
 *    L is a lateral member stored `both`. (`pHasDirection: 'both'` is the fail-closed variant.)
 *  - `braintree`: this instance's parent is P (`myParentInstanceId`); L is P's other child (a sibling), and a child of
 *    this instance is a member too.
 *  - anything else: P and L are plain members stored `both`. No position above this instance exists.
 *
 * The fixture is deliberately a plain object literal and never a call into the module under test: an expectation
 * derived from the code it checks asserts that the code equals itself.
 */
export const SELF = 'inst-self';
export const P = 'inst-upstream';
export const L = 'inst-lateral';
export const T = 'inst-third';
export const N = 'inst-nonmember';
export const SPACE = 'shared';
export const ELSEWHERE = 'elsewhere';

const member = (instanceId, extra = {}) => ({ instanceId, label: instanceId, url: `http://${instanceId}`, tokenHash: '', direction: 'both', ...extra });

/**
 * @param {string} type
 * @param {object} [opts]
 * @param {boolean} [opts.carries] whether the network carries SPACE (default) or another space
 * @param {Record<string,string>} [opts.spaceMap] peer-side name -> local id
 * @param {string} [opts.pHasDirection] pubsub only: the direction P is stored with (default `pull`, the publisher)
 * @param {boolean} [opts.publisher] pubsub only: this instance is the PUBLISHER (every member is a subscriber stored `push`)
 * @param {boolean} [opts.root] braintree only: this instance is the root (no parent)
 * @param {string} [opts.parent] braintree only: the parent's id (default P)
 * @param {string} [opts.id] the network id (default `net-<type>`); two networks of one type need distinct ids
 */
export function networkOf(type, { carries = true, spaceMap, pHasDirection = 'pull', publisher = false, root = false, parent = P, id } = {}) {
  const net = {
    id: id ?? `net-${type}`, label: type, type, spaces: [carries ? SPACE : ELSEWHERE], members: [],
    votingDeadlineHours: 24, pendingRounds: [], createdAt: '2026-01-01T00:00:00.000Z',
  };
  if (spaceMap) net.spaceMap = spaceMap;
  if (type === 'pubsub') {
    net.members = publisher
      ? [member(P, { direction: 'push' }), member(L, { direction: 'push' })]
      : [member(P, { direction: pHasDirection }), member(L)];
  } else if (type === 'braintree') {
    if (!root) net.myParentInstanceId = parent;
    net.members = [member(parent), member(L, { parentInstanceId: parent }), member('inst-child', { parentInstanceId: SELF })];
  } else {
    net.members = [member(P), member(L)];
  }
  return net;
}

/** A token as `peerTokensReaching` reads one: a peer instance id and a rights matrix that reaches `spaces`. */
export const peerToken = (peerInstanceId, spaces) => ({
  id: `tok-${peerInstanceId}`, peerInstanceId,
  rights: { perSpace: Object.fromEntries(spaces.map(s => [s, { knowledge: 'write', files: 'write', schema: 'read', dataQuality: 'read', networks: 'none' }])) },
});

export const cfgOf = (networks, tokens = []) => ({ instanceId: SELF, networks, tokens, spaces: [{ id: SPACE }] });
