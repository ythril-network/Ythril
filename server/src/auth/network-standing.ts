/**
 * Is this caller part of the network a path names — and the middleware that refuses one that is not (Q-454).
 *
 * ## What it prevents
 *
 * `GET /api/sync/networks/:networkId/votes` and `GET …/members` carried `requireAuth` and nothing else, so any authenticated token — a
 * space-scoped user PAT, a peer of another network, a manually provisioned peer the network does not list — read the open rounds of a
 * network it has no part in (casts, signatures, the member a removal is about). The two relays asked WHO (`peerRelayCaller`) and never
 * WHETHER the caller belongs. On an unknown network the reads answered `404`, which told any token which networks this instance holds.
 *
 * ## One question, one table, one refusal
 *
 * {@link networkStanding} answers what the caller IS in the network the path names. {@link requireNetworkStanding} takes a row of the table
 * below (a route states its row, not a flag per caller), runs after `requireAuth`, and refuses with the same `403 { error: 'Forbidden' }`
 * whatever the reason — a network this instance does not hold, one the caller is not in — so the route is no oracle of which networks
 * exist. A member's relay to a round this instance does not hold still reaches the handler's own `404`: that is its answer, not the
 * refusal's. It is said in the log once per TOKEN and route: a path's network id varies freely, so a key that included it would let any
 * token write a line per request.
 *
 * The data routes ask the space-reach question (`spaceAllowed`), which asks membership as part of reach; this is the governance half.
 * `every-governance-route-asks-membership-once.test.js` derives the routes and holds each to one of the two.
 */
import type { RequestHandler } from 'express';
import { getConfig } from '../config/loader.js';
import { peerRelayCaller } from './peer-relay.js';
import { joinRoundOf } from '../networks/round-state.js';
import { isUpstreamPeer } from '../networks/network-spaces.js';
import { warnOnce } from '../util/warn-once.js';
import { SKIP_WARNING_WINDOW_MS } from '../util/single-flight.js';
import { log, peerText } from '../util/log.js';

/** What a caller is, in the network a governance route names (see {@link networkStanding}). */
export type NetworkStanding = 'member' | 'open-joiner' | 'admin' | 'local' | 'unlisted-peer' | 'stranger' | 'unknown-network';

/**
 * What this caller is in the network `networkId` names — ONE answer for every route that names a network.
 *
 * - `admin`: an instance administrator that is not acting as a peer (`peerRelayCaller`, which lets a peer identity win over admin).
 * - `member`: a peer token whose instance the network's `members` lists, or the instance above this one (`isUpstreamPeer`: a
 *   tree node's declared parent, a subscriber's publisher), which a braintree child does not list among its members.
 * - `open-joiner`: a peer a join round of THIS network names while that round can still be voted on (`joinRoundOf`). A voted-down joiner
 *   and one past its deadline are not: read as an allow, the data guard's "held by a join round" would have admitted them.
 * - `unlisted-peer`: a peer token listed in no network and named by no join round (a manual token, or the other half of a network only
 *   one side configured) — it falls through to token scope for DATA reads and has no say in governance.
 * - `stranger`: any other peer: a member of other networks, or a joiner whose round is not open.
 * - `local`: a token that is neither a peer nor an administrator (a user PAT, an OIDC session).
 * - `unknown-network`: this instance does not hold the network, and the caller is not an administrator.
 *
 * `now` is passed in so a request reads the clock once.
 */
export function networkStanding(authToken: Parameters<typeof peerRelayCaller>[0], networkId: string, now: number): NetworkStanding {
  const caller = peerRelayCaller(authToken);
  if (caller.kind === 'admin') return 'admin';
  const networks = getConfig().networks;
  const net = networks.find(n => n.id === networkId);
  if (!net) return 'unknown-network';
  if (caller.kind === 'refused') return 'local';
  const peer = caller.peerInstanceId;
  // The instance above this one - a tree node's declared parent, a subscriber's publisher - is part of the network though a
  // braintree child holds it in `myParentInstanceId`, not in `members`: it gossips this node's rounds and relays its casts.
  if (net.members.some(m => m.instanceId === peer) || isUpstreamPeer(net, peer)) return 'member';
  if (joinRoundOf(net, peer, now) === 'open') return 'open-joiner';
  const knownElsewhere = networks.some(n => n.members.some(m => m.instanceId === peer) || joinRoundOf(n, peer, now) !== null);
  return knownElsewhere ? 'stranger' : 'unlisted-peer';
}

/**
 * Who may call each governance route that names a network, by the standing above — the policy in one table, one row per route. A read is
 * open to a joiner whose round is open (it gossips the members and the votes of the network that has not yet admitted it); a relay is not.
 */
const STANDING_ROWS = {
  'votes-read': ['admin', 'member', 'open-joiner'],
  'members-read': ['admin', 'member', 'open-joiner'],
  'votes-relay': ['admin', 'member'],
  'change-notes-relay': ['admin', 'member'],
} as const satisfies Record<string, readonly NetworkStanding[]>;

export type StandingRow = keyof typeof STANDING_ROWS;

/** Said once per token and route — never per network id, which a caller varies freely. */
const refusalSaid = warnOnce<string>({ max: 500, every: SKIP_WARNING_WINDOW_MS });

/**
 * Refuse a caller with no standing in the network `:networkId` names. Place it AFTER `requireAuth`, which is what puts a token on the
 * request; a standing asked of an unauthenticated caller reads no token.
 */
export function requireNetworkStanding(row: StandingRow): RequestHandler {
  const allowed: readonly NetworkStanding[] = STANDING_ROWS[row];
  return (req, res, next) => {
    const token = req.authToken;
    const networkId = String(req.params['networkId'] ?? '');
    const standing = networkStanding(token, networkId, Date.now());
    if (allowed.includes(standing)) { next(); return; }
    const tokenId = String(token?.id ?? 'unidentified');
    refusalSaid(`${tokenId} ${row}`, () => log.warn(
      `Governance route '${row}' refused token ${peerText(tokenId)} (${peerText(token?.name ?? '')}): standing '${standing}' in network ${peerText(networkId)}; further refusals to this token on this route are not repeated`));
    res.status(403).json({ error: 'Forbidden' });
  };
}
