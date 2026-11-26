/**
 * What a member's served vote list does to this instance's rounds: each served round is read by its declared shape, recorded as
 * evidence of the member's conclusion, adopted (past `adoptionRefusal`) or merged into, cast by cast (bundle-106, design v5 section
 * 3.6 v5, X11; section 3.3 for the evidence).
 *
 * Moved out of `sync/engine.ts` (frozen by `no-new-god-files`) along its own seam: the engine fetches the list and settles what changed;
 * this module answers "what does this list change here".
 *
 * ## What a hand-written copy drops
 *
 * - **The declared shape, before any reader.** A served round is a peer's word: a string `wipeTypes` or an object `spaceId` reached every
 *   later reader as what it is not. Every round is read through `IncomingVoteRound` (unknown keys pass through, so signatures and later
 *   fields hold); one that does not parse is counted `malformed` and touches nothing - not even the evidence of a local twin.
 * - **The stamp at receipt.** A cast with no `castAt` (an older or unsigned cast, never refused for it) is stamped when it arrives, as the
 *   relay route stamps one (`castFromBody`), so no reader of the stored round meets a cast without a date.
 * - **The clock line, once.** A round opened further ahead of this clock than the one tolerance the server names is ADOPTED (a proposer
 *   whose clock runs ahead is not an attacker), counted in `ythril_round_clock_ahead_total`, and said once per network and peer - never
 *   once per round, which a mixed fleet would raise every cycle.
 */
import type { NetworkConfig, NetworkMember, VoteCast, VoteRound } from '../config/types.js';
import { IncomingVoteRound } from '../networks/round-shape.js';
import { adoptPeerRound, adoptionRefusal, roundOpenedAhead, NEVER_OPENED_REFUSAL, type AdoptionRefusal } from '../networks/round-local-state.js';
import { roundIsOpen } from '../networks/round-state.js';
import { acceptVoteCast, castForWire } from '../util/signing.js';
import { recordPeerConcluded } from './peer-concluded-evidence.js';
import { roundClockAheadTotal } from '../metrics/registry.js';
import { warnOnce } from '../util/warn-once.js';
import { log, peerText } from '../util/log.js';

const clockAheadSaid = warnOnce<string>({ max: 500 });

/** `cast` with its `castAt` stamped at `now` when it arrived without one; any other cast as it came. */
function stampedAtReceipt(cast: VoteCast, now: number): VoteCast {
  return typeof cast.castAt === 'string' && cast.castAt ? cast : { ...cast, castAt: new Date(now).toISOString() };
}

/** Count, and say once per network and peer, a round whose `openedAt` lies ahead of this clock past the tolerance. */
function noteClockAhead(net: NetworkConfig, member: NetworkMember, round: VoteRound, now: number): void {
  if (!roundOpenedAhead(round, now)) return;
  roundClockAheadTotal.inc();
  clockAheadSaid(`${net.id} ${member.instanceId}`, () => log.warn(
    `Vote gossip: ${peerText(member.label)} serves rounds of network ${peerText(net.id)} opened ahead of this instance's clock `
    + `(round ${peerText(round.roundId)} openedAt ${peerText(String(round.openedAt))}). Adopted; keep instance clocks within 40 minutes (NTP).`));
}

/**
 * Say what a pass did not adopt (`refused`, per reason: the second answer of {@link takeServedRounds}). One debug line for all of it, and (Q-968) a
 * warn line for a round of a kind the network's type never opens: no honest member serves a join, removal or (pub/sub) space addition there, so
 * it is a peer's forgery and an operator should see it. The warn goes through `saidOnce` (`refusedGovernancePull`: once per network, member and
 * window, so a peer serving it every cycle is one line). A round "proposed by a subscriber" stays at debug: an older subscriber opens one honestly.
 */
export function sayRefusedRounds(
  net: NetworkConfig, member: NetworkMember, refused: ReadonlyMap<AdoptionRefusal, number>,
  saidOnce: (key: string, report: () => void) => boolean,
): void {
  const forged = refused.get(NEVER_OPENED_REFUSAL);
  if (forged) {
    saidOnce(`never-opened ${net.id} ${member.instanceId}`, () => log.warn(
      `Vote gossip: ${peerText(member.label)} served ${forged} round(s) of a kind network ${peerText(net.id)} (${net.type}) never opens, not adopted`));
  }
  if (refused.size > 0) {
    log.debug(`Vote gossip: did not adopt ${peerText([...refused].map(([why, n]) => `${n} round(s) ${why}`).join(', '))} from ${peerText(member.label)}`);
  }
}

/**
 * Take what `served` (a member's GET .../votes answer, unread) changes in `net` (the live network the caller saves): evidence, adoptions
 * and merged casts. Returns whether anything changed and, per reason, how many rounds were not adopted.
 */
export function takeServedRounds(
  net: NetworkConfig, served: readonly unknown[], member: NetworkMember, now: number,
): { changed: boolean; refused: Map<AdoptionRefusal, number> } {
  const refused = new Map<AdoptionRefusal, number>();
  const count = (why: AdoptionRefusal): void => { refused.set(why, (refused.get(why) ?? 0) + 1); };
  let changed = false;
  for (const raw of served) {
    const read = IncomingVoteRound.safeParse(raw);
    if (!read.success) { count('malformed'); continue; }
    const peerRound = read.data as unknown as VoteRound;
    // A member's served conclusion of a wipe or deletion is the hold's evidence, kept on this instance's twin (section 3.3).
    if (recordPeerConcluded(net, peerRound, member.instanceId)) changed = true;

    let local = net.pendingRounds.find(r => r.roundId === peerRound.roundId);
    if (!local) {
      // New to us: adopted if it can still be voted on here. One that ended elsewhere is not brought back to life, one already recorded is
      // not recorded twice, and a pub/sub publisher holds no subscriber's deletion or wipe (`adoptionRefusal`). Counted, never a line per round.
      const why = adoptionRefusal(net, peerRound, now);
      if (why) { count(why); continue; }
      // Nothing local is taken from it (S-7, S-9); votes are merged below, one cast at a time.
      local = adoptPeerRound(net, peerRound);
      changed = true;
      noteClockAhead(net, member, peerRound, now);
      log.info(`Vote gossip: adopted round ${peerText(peerRound.roundId)} (${peerRound.type}) from ${peerText(member.label)}`);
    }
    if (!roundIsOpen(local, now)) continue;

    // SECURITY: a signed cast is accepted from any reporter (its signature proves the voter cast it, so multi-hop relay is safe); an
    // unsigned cast only when the reporting peer IS the voter. This blocks a peer serving a round pre-stuffed with `yes` votes forged
    // for other members, while signed votes still relay through intermediate nodes (deep braintree trees).
    for (const peerCast of peerRound.votes as VoteCast[]) {
      const decision = acceptVoteCast(net, local, peerCast, member.instanceId);
      if (!decision.accept) {
        log.warn(`Vote gossip: rejecting cast for '${peerText(peerCast.instanceId)}' relayed by '${peerText(member.instanceId)}' `
          + `(round ${peerText(peerRound.roundId)}) — ${peerText(decision.reason)}`);
        continue;
      }
      const idx = local.votes.findIndex(v => v.instanceId === peerCast.instanceId);
      if (idx >= 0) {
        // Replaced only when the cast changes the vote or its signatures; the signature that came with it is kept.
        const had = local.votes[idx]!;
        if (had.vote !== peerCast.vote || had.sig !== peerCast.sig || had.bsig !== peerCast.bsig) {
          local.votes[idx] = castForWire(stampedAtReceipt(peerCast, now));
          changed = true;
        }
      } else {
        local.votes.push(castForWire(stampedAtReceipt(peerCast, now)));
        changed = true;
      }
    }
  }
  return { changed, refused };
}
