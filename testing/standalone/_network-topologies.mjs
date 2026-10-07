/**
 * The network topologies a deletion-authority test runs, DERIVED — one answer to "where does the delivering peer sit",
 * for every test that asks it (bundle-51).
 *
 * ## The question it answers
 *
 * Whether a peer's tombstone may delete what that peer delivered depends on one fact about the NETWORK: is the peer
 * this instance's upstream (a pub/sub publisher, a braintree parent)? A test that lists "pubsub" and "braintree" by
 * name is the list that goes stale when a type is added, and one that ASSUMES which of them has an upstream asserts
 * the rule against the writer's own idea of it. So the types are read out of the type's own declaration, each is run
 * twice (the peer as the parent/publisher, and as anything else), and whether the peer IS the upstream is asked of the
 * server's own `upstreamOf` on the live config — never inferred from the name.
 *
 * It needs a door opened with `openPullDoor` (`configure` rewrites the live network config).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';

/** The network types the config knows, read from `NetworkType`'s declaration. Floor 5: an empty set passes every loop. */
export function networkTypes() {
  const src = fs.readFileSync('server/src/config/types-networks.ts', 'utf8');
  const m = /export type NetworkType\s*=([^;]+);/.exec(src);
  assert.ok(m, 'NetworkType is no longer a string union in types-networks.ts — re-anchor');
  const types = [...m[1].matchAll(/'([a-z]+)'/g)].map(x => x[1]);
  assert.ok(types.length >= 5, `only ${types.length} network types read (${types}) — the derivation is broken`);
  return types;
}

/**
 * Every network type, twice, as `configure` arguments: the peer as the parent/publisher (`direction: 'pull'`, a braintree
 * `myParentInstanceId` of the peer), and the peer as anything else (another braintree parent, a pub/sub SUBSCRIBER, a club
 * member, a member of a voted network).
 */
export function topologies(peer, strangerParent = 'some-other-parent') {
  const out = [];
  for (const t of networkTypes()) {
    out.push({ name: `${t}: the peer is the parent / publisher`, set: { type: t, myParentInstanceId: peer, direction: 'pull' } });
    out.push({ name: `${t}: the peer is NOT the parent / publisher`, set: { type: t, myParentInstanceId: strangerParent, direction: 'both' } });
  }
  return out;
}

/** Is `peer` this instance's upstream for `space` under the door's LIVE config? Asked of `upstreamOf`, not assumed. */
export function peerIsUpstream(door, upstreamOf, peer, space) {
  return door.config().networks.filter(n => n.spaces.includes(space)).some(n => upstreamOf(n) === peer);
}
