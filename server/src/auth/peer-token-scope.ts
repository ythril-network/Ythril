import { getConfig } from '../config/loader.js';
import type { Config } from '../config/types.js';
import { migrateToken } from './rights-migration.js';
import { reachesSpace } from './space-reach.js';

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

/**
 * Let every token this instance keeps for `peerIds` reach `localIds`, at the rung a peer token is minted with. A
 * token that already reaches a space is left as it is — widening must never narrow a row somebody set by hand.
 *
 * Why a handshake needs it (`Q-53`): the union above is taken at APPLY, so two handshakes between the same pair whose
 * applies both land before either finalize each mint a token without the other network, and whichever is kept leaves
 * that network at 403. Widening every token of the peer once its join is registered makes the one kept reach both, in
 * either order. Still not wider access, for the reason above.
 */
export function widenPeerTokensOf(cfg: Config, peerIds: readonly string[], localIds: readonly string[]): void {
  const peers = new Set(peerIds);
  for (const tok of cfg.tokens) {
    if (!tok.peerInstanceId || !peers.has(tok.peerInstanceId) || !tok.rights) continue;
    for (const id of localIds) {
      if (reachesSpace(tok.rights, id)) continue;
      const row = migrateToken({ admin: false, readOnly: false, spaces: [id] }).perSpace[id];
      if (row) tok.rights.perSpace[id] = row as (typeof tok.rights.perSpace)[string];
    }
  }
}
