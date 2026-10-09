/**
 * Who may vote on a round, and how they voted — ONE count, read by the conclusion and by the log of how a round ended.
 *
 * ## What it prevents
 *
 * `concludeRoundIfReady` held three electorate rules inline (the subject of a join or removal is voted ON and so does not vote; this
 * instance is an elector unless the round is about it; a cast counts only from a member). The outcome log needs the same three
 * numbers, and a second count written beside the first is the one that drifts: a log saying `yes 2 of 3` for a round the decision
 * read as `1 of 3`. It lives below both (`sync/governance.ts` re-exports {@link roundElectorate}) because the log is called FROM
 * the conclusion and the two may not import each other.
 *
 * The subject is left out only where it is the member voted ON — a join or a removal. On every other round it is the PROPOSER, a
 * voter like any member, whose yes is cast for it when the round opens.
 */
import { getConfig } from '../config/loader.js';
import type { NetworkConfig, NetworkMember, VoteRound } from '../config/types.js';

/** The members who may vote on `round` apart from this instance, and whether this instance is itself the one voted on. */
export interface RoundVoters {
  /** Members that vote: every member, less the one a join or a removal is about. THROWS when `net.members` is not a list. */
  voters: NetworkMember[];
  subjectIsVotedOn: boolean;
  localInstanceId: string;
  /** This instance is the subject of a join or removal: it is not asked, and its own yes is not required. */
  localIsVotedOn: boolean;
}

export function votersOf(net: NetworkConfig, round: Pick<VoteRound, 'type' | 'subjectInstanceId'>): RoundVoters {
  const subjectIsVotedOn = round.type === 'join' || round.type === 'remove';
  const voters = net.members.filter(m => !subjectIsVotedOn || m.instanceId !== round.subjectInstanceId);
  const localInstanceId = getConfig().instanceId;
  return { voters, subjectIsVotedOn, localInstanceId, localIsVotedOn: subjectIsVotedOn && round.subjectInstanceId === localInstanceId };
}

/**
 * How many may vote (`eligible`: the members that vote, and this instance unless the round is about it), and how many of them said
 * yes and veto. A cast by anyone who is not an elector counts for nothing. A round with no list of casts has none.
 */
export function roundElectorate(net: NetworkConfig, round: VoteRound): { eligible: number; yes: number; veto: number } {
  const { voters, localInstanceId, localIsVotedOn } = votersOf(net, round);
  const casts = Array.isArray(round.votes) ? round.votes : [];
  const electors = casts.filter(c => (c.instanceId === localInstanceId && !localIsVotedOn) || voters.some(m => m.instanceId === c.instanceId));
  return {
    eligible: voters.length + (localIsVotedOn ? 0 : 1),
    yes: electors.filter(c => c.vote === 'yes').length,
    veto: electors.filter(c => c.vote === 'veto').length,
  };
}
