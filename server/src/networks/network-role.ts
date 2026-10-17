/**
 * What THIS instance is in a network, and which members that role acts on (`F-38.1`).
 *
 * Owner, 2026-09-25: *"the own role in the network should be clear and instead of '1 member' on a pubsub i want to
 * see subscribers if im pub and nothing if im sub, on club i want to see peers, on braintree i want to see the path
 * to root and my sub-path"*. It is derived from topology already stored, never recorded twice, and the page,
 * `GET /api/networks/:id` and `network_get` all read it from here, so no door can describe the role differently.
 *
 * ## Where each role comes from
 *
 * - **pubsub** — the link direction. A member we PULL from is our publisher, so we are a subscriber; otherwise we
 *   are the publisher, including before anyone has subscribed.
 * - **club** — `origin`: the instance that created the network organises it. A network stored before `origin`
 *   existed reads as `member`; guessing `organiser` would claim a power the instance may not have.
 * - **braintree** — `myParentInstanceId`: none means root; a parent and no children means leaf; otherwise node.
 * - **closed / democratic** — every instance is a member, and sees its peers.
 */
import type { NetworkConfig, NetworkMember } from '../config/types.js';
import { getConfig } from '../config/loader.js';

export type NetworkRoleName = 'publisher' | 'subscriber' | 'organiser' | 'member' | 'root' | 'node' | 'leaf';

export interface NetworkRole {
  role: NetworkRoleName;
  /** The members this role acts on: a publisher's subscribers, a club's or a voted network's peers. */
  members: NetworkMember[];
  /** pubsub, subscriber only: the instance it receives from. */
  publisher?: NetworkMember;
  /** braintree only: this instance's parent, its parent, and so on up to the root. */
  pathToRoot?: NetworkMember[];
  /** braintree only: every instance below this one. */
  subtree?: NetworkMember[];
}

export function networkRole(net: NetworkConfig, selfId?: string): NetworkRole {
  switch (net.type) {
    case 'pubsub': {
      const publisher = net.members.find(m => m.direction === 'pull');
      return publisher
        ? { role: 'subscriber', members: [], publisher }
        : { role: 'publisher', members: net.members.filter(m => m.direction !== 'pull') };
    }
    case 'club':
      return { role: net.origin === 'created' ? 'organiser' : 'member', members: net.members };
    case 'braintree': {
      // Only the tree needs this instance's own id, so only the tree reads config for it.
      const self = selfId ?? getConfig().instanceId;
      const byId = new Map(net.members.map(m => [m.instanceId, m]));
      const pathToRoot: NetworkMember[] = [];
      // Bounded by the member count and by a seen-set: stored topology is written by peers, so it can be wrong.
      const seen = new Set<string>([self]);
      for (let id = net.myParentInstanceId; id && !seen.has(id);) {
        seen.add(id);
        const m = byId.get(id);
        if (!m) break;
        pathToRoot.push(m);
        id = m.parentInstanceId;
      }
      const subtree: NetworkMember[] = [];
      const below = new Set<string>([self]);
      for (let grew = true; grew;) {
        grew = false;
        for (const m of net.members) {
          if (m.parentInstanceId && below.has(m.parentInstanceId) && !below.has(m.instanceId)) {
            below.add(m.instanceId); subtree.push(m); grew = true;
          }
        }
      }
      const role: NetworkRoleName = !net.myParentInstanceId ? 'root' : subtree.length ? 'node' : 'leaf';
      return { role, members: subtree, pathToRoot, subtree };
    }
    default:
      return { role: 'member', members: net.members };
  }
}

/**
 * Does this instance PUBLISH on `net` — the one pub/sub role whose space deletion or wipe is a network act: a deletion or wipe there is the
 * publisher's, and every other instance's is its own local act (D-40). Asked from the local topology, never from a field a peer could set.
 *
 * What it prevents: the question was spelled at the round's opening (the publisher's notice), at adoption (a publisher holds no round it
 * did not open) and at the pub/sub verdict, each as `type === 'pubsub'` and a role read, and a spelling that read the role without the
 * type would call a club organiser a publisher. It lives here, beside the role it reads, because the round modules that ask it cannot import
 * each other.
 */
export function publishesOn(net: NetworkConfig): boolean {
  return net.type === 'pubsub' && networkRole(net).role === 'publisher';
}

/**
 * Does this instance act on its own on `net` — a pub/sub subscriber, whose deletion or wipe of a space is a LOCAL act (D-40): it opens
 * no round, tells the publisher nothing, and is answered as an unnetworked one. The one reading of "subscriber" the doors ask.
 */
export function actsLocallyOn(net: NetworkConfig): boolean {
  return net.type === 'pubsub' && networkRole(net).role === 'subscriber';
}
