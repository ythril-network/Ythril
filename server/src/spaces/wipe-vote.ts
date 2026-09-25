/**
 * Emptying a space of its data is a GOVERNED act when the space belongs to a network.
 *
 * ## The ruling, and the defect it closes
 *
 * Owner, 2026-08-16: *"thats a voting thing."* Filed as X-5.
 *
 * `wipeSpace` deletes the documents and then deletes the TOMBSTONES too, writing none. Tombstones are this
 * codebase's only way of telling a peer that a record is gone, so a wipe left an empty space with no record
 * of any deletion, facing a peer that still offered everything and nothing to refuse it with — the next sync
 * round simply put it back.
 *
 * The three fixes I offered were propagate, refuse, or document. The ruling is none of them and is better
 * than all three: a wipe that every member agreed to does not need a tombstone, because the peers are wiping
 * too. The resurrection problem does not get solved, it stops existing.
 *
 * ## Why this is one module rather than a branch in each door
 *
 * REST (`POST /api/admin/spaces/:spaceId/wipe`) and MCP (`delete_space_data`) both wipe. A second copy of "is this
 * space governed, and if so open a round on every network that holds it" is the defect this repo produces
 * most — one rule, two implementations, and the weaker one wins silently. Both doors call `planSpaceWipe`
 * and act on its verdict; neither decides anything itself.
 *
 * ## What it deliberately does NOT do
 *
 * It does not wipe. A planner that also performed the write could not be exercised without a database, and
 * the interesting half here is the decision — solo or governed, and which collections the round carries.
 */
import { v4 as uuidv4 } from 'uuid';
import { getConfig, saveConfig } from '../config/loader.js';
import type { NetworkConfig, VoteRound } from '../config/types.js';
import { makeSignedOwnCast } from '../util/signing.js';
import { openRoundHere } from '../networks/round-local-state.js';

/** The verdict: wipe now, or a round was opened on each network holding the space. */
export type WipePlan =
  | { governed: false }
  | { governed: true; rounds: { networkId: string; networkLabel: string; roundId: string }[] };

/** Networks that carry this space. Exported so a caller can report "which networks" without re-deriving it. */
export function networksHolding(spaceId: string): NetworkConfig[] {
  return getConfig().networks.filter(n => n.spaces.includes(spaceId));
}

/**
 * Decide whether this wipe votes, and open the rounds if it does.
 *
 * Returns `{ governed: false }` for a space in no network — that wipe is local, immediate and final, exactly
 * as it has always been. Nothing about an unnetworked instance changes.
 *
 * For a governed space it opens one round per network holding it, votes this instance's own yes, persists,
 * and hands back the round ids. The wipe itself happens when each round concludes — see the three conclusion
 * sites that already do this for `space_deletion`.
 *
 * `types` is stored ON the round. A partial wipe is what the members are voting for, so resolving it later
 * would let a round approved for `files` conclude by emptying the knowledge graph.
 */
export function planSpaceWipe(spaceId: string, types?: readonly string[]): WipePlan {
  const nets = networksHolding(spaceId);
  if (nets.length === 0) return { governed: false };

  const cfg = getConfig();
  const now = new Date().toISOString();
  const rounds: { networkId: string; networkLabel: string; roundId: string }[] = [];

  for (const net of cfg.networks.filter(n => n.spaces.includes(spaceId))) {
    const roundId = uuidv4();
    net.pendingRounds ??= [];

    /*
     * BUILT FIRST, THEN SIGNED, because a signature is over the round it belongs to.
     *
     * This pushed a bare `{ instanceId, vote: 'yes', castAt }` while every other own-cast site — the join
     * flow, the member relay, the removal path — uses `makeSignedOwnCast`. On a network with
     * `requireSignedVotes` a peer refuses an unsigned cast from anyone, including the voter, so a proposed
     * wipe or space deletion carried LOCALLY and nowhere else: the round existed, the yes was ours, and
     * every peer dropped it. Nothing reported that, because a refused relay is the documented behaviour
     * for an unsigned cast.
     */
    const round: VoteRound = {
      roundId,
      type: 'space_wipe',
      subjectInstanceId: cfg.instanceId,
      subjectLabel: cfg.instanceLabel,
      subjectUrl: '',   // not meaningful for a wipe, as for space_deletion
      deadline: new Date(Date.now() + net.votingDeadlineHours * 3_600_000).toISOString(),
      openedAt: now,
      votes: [],
      spaceId,
      // Omitted rather than defaulted when the caller wants everything: an absent `wipeTypes` means every
      // brain collection at conclusion, which is the same meaning it has on the request. It said "all
      // five" and `WIPE_COLLECTION_TYPES` is `BRAIN_COLLECTIONS` — six, with `links` the one left out.
      ...(types && types.length > 0 ? { wipeTypes: [...types] } : {}),
    };
    round.votes = [makeSignedOwnCast(net.id, round, cfg.instanceId, 'yes')];
    openRoundHere(net, round);
    rounds.push({ networkId: net.id, networkLabel: net.label, roundId });
  }

  saveConfig(cfg);
  return { governed: true, rounds };
}

/**
 * Tell every peer a wipe round is open, so they pull it now instead of at the next scheduled sync.
 *
 * Best-effort by design, exactly as `space_deletion_pending` is: a peer that cannot be reached still sees the
 * round on its next sync, because the round is in the config that syncs. Failing the caller's request
 * because one peer is down would make a governed wipe less reliable than an ungoverned one.
 *
 * Lives here rather than at each door for the same reason `planSpaceWipe` does — it is the other half of one
 * action, and two copies of "who do we tell" is how one door ends up silently not telling anyone.
 */
export function notifyPeersOfWipe(spaceId: string, types?: readonly string[]): void {
  const cfg = getConfig();
  const space = cfg.spaces.find(s => s.id === spaceId);
  void (async () => {
    const { getSecrets } = await import('../config/loader.js');
    const { peerSafeFetch } = await import('../sync/peer-fetch.js');
    const { log } = await import('../util/log.js');
    const secrets = getSecrets();
    for (const net of networksHolding(spaceId)) {
      for (const member of net.members) {
        const peerToken = secrets.peerTokens[member.instanceId];
        if (!peerToken) continue;
        peerSafeFetch(`${member.url}/api/notify`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${peerToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            networkId: net.id,
            instanceId: cfg.instanceId,
            event: 'space_wipe_pending',
            data: { spaceId, spaceLabel: space?.label, types: types && types.length > 0 ? [...types] : undefined },
          }),
          signal: AbortSignal.timeout(5_000),
        }).catch((err: unknown) => log.warn(`notify ${member.label} of space_wipe_pending: ${err}`));
      }
    }
  })();
}
