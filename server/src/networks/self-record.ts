/**
 * The self-record one instance hands a peer in the member exchange — built in ONE place (`Q-133`).
 *
 * The exchange has two directions: the engine POSTs its record to a peer (`sync/engine.ts`), and the peer answers
 * with its own piggybacked (`api/sync/members.ts`). They were two hand-built literals, and `engine.ts` already
 * carried the warning of what that costs: *"a field on only one of them means a peer learns our version when it calls
 * us and never when we call it."* A field added for Q-133 on one side only would heal a member in one direction and
 * not the other, so both call this.
 *
 * ## What `spaceNames` is for
 *
 * `spaces` is what the network calls each space this instance carries (`announcedSpaces`). `spaceNames` maps each of
 * those network ids to what THIS instance calls the space, for the spaces where the two differ — the hint a member
 * that joined before Q-133 needs to heal: it carries the space under this instance's local name, with no alias for
 * the network's id. It goes only to a member this instance is UPSTREAM of (its subscriber, its tree child), because
 * only an upstream is heeded for it (`healSpaceAliases`), and a sibling has no use for another member's local names.
 */
import type { Config, NetworkConfig, NetworkMember } from '../config/types.js';
import { SERVER_VERSION } from '../util/server-version.js';
import { getSigningPublicKey, getSigningKeyRotation } from '../util/signing.js';
import { announcedSpaces, MAX_SPACE_NAMES } from './network-spaces.js';
import { reverseSpaceMap } from '../sync/space-map.js';

/** Whether this instance is `member`'s upstream in `net`: its publisher, or its tree parent. */
function isUpstreamOf(selfId: string, net: Pick<NetworkConfig, 'type'>, member: Pick<NetworkMember, 'direction' | 'parentInstanceId'>): boolean {
  if (net.type === 'pubsub') return member.direction === 'push';
  if (net.type === 'braintree') return member.parentInstanceId === selfId;
  return false;
}

/** Network id -> this instance's name, for each carried space whose two ids differ, capped at `MAX_SPACE_NAMES`. */
export function spaceNamesFor(net: Pick<NetworkConfig, 'spaces' | 'spaceMap'>): Record<string, string> {
  const reverse = reverseSpaceMap(net);
  const out: Record<string, string> = {};
  for (const local of net.spaces) {
    const networkId = reverse.get(local);
    if (networkId !== undefined && networkId !== local) out[networkId] = local;
    if (Object.keys(out).length >= MAX_SPACE_NAMES) break;
  }
  return out;
}

/** The record for `to`, as both directions of the member exchange send it. */
export function selfRecordFor(
  cfg: Pick<Config, 'instanceId' | 'instanceLabel'>,
  net: NetworkConfig,
  to: Pick<NetworkMember, 'direction' | 'parentInstanceId'>,
): Record<string, unknown> {
  const record: Record<string, unknown> = {
    instanceId: cfg.instanceId,
    label: cfg.instanceLabel,
    /*
     * `version` is on both directions because the exchange is symmetric: a floor enforced from one side only is one
     * instance refusing a peer that has no idea why.
     */
    version: SERVER_VERSION,
    // F-38.3: what a member below us adopts; `adoptAnnouncedSpaces` ignores it from anyone else.
    spaces: announcedSpaces(net),
    children: net.members.filter(m => m.parentInstanceId === cfg.instanceId).map(m => m.instanceId),
  };
  if (isUpstreamOf(cfg.instanceId, net, to)) {
    const names = spaceNamesFor(net);
    if (Object.keys(names).length > 0) record['spaceNames'] = names;
  }
  const selfUrl = process.env['INSTANCE_URL'] ?? '';
  if (selfUrl) record['url'] = selfUrl;
  const key = getSigningPublicKey();
  if (key) record['signingPublicKey'] = key;
  const rotation = getSigningKeyRotation();
  if (rotation) record['signingKeyRotation'] = rotation;
  return record;
}
