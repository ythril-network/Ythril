import { getConfig } from '../config/loader.js';

/**
 * The spaces a peer PAT must reach: every space of every network this instance already shares with that peer, plus
 * the spaces of the network being joined now.
 *
 * ## Why the union, and not the joining network's spaces
 *
 * An instance keeps ONE outbound token per peer — `secrets.peerTokens[instanceId]` — so the token a handshake hands
 * over replaces the one before it, for every network the two instances share, not only the new one. Minted for the
 * joining network alone, a second network between the same pair cut off the first: every push and pull on it
 * answered 403 in both directions, at once, with nothing on either side saying why (`Q-47`).
 *
 * ## Why the wider token is not wider access
 *
 * `spaceAllowed` admits a peer only to the spaces of networks it is currently a member of, per request. So leaving
 * one network withdraws that network's spaces even though the token still names them, and a token scoped here can
 * never reach a space the peer does not share through some network.
 *
 * @param peerInstanceId the instance the token is for
 * @param joiningSpaces  this instance's LOCAL ids of the joining network's spaces
 */
export function peerTokenSpaces(peerInstanceId: string, joiningSpaces: readonly string[]): string[] {
  const shared = getConfig().networks
    .filter(n => n.members.some(m => m.instanceId === peerInstanceId))
    .flatMap(n => n.spaces);
  return [...new Set([...shared, ...joiningSpaces])];
}
