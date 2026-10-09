import type { VoteRound } from './api.types';

/**
 * A vote round as the server sends it (`GET /api/networks/:id/votes`), turned into the `VoteRound` the pages read.
 *
 * ## Why this exists
 *
 * The client's `VoteRound` was written against a shape the server never sent: it read `id`, `subject` and
 * `status`, and the server sends `roundId`, `subjectLabel` and `concluded`/`passed`. Both consumers — the Networks
 * page and the Brain overview's Governance panel — filtered on `status === 'open'`, so no open vote was ever
 * listed, and a Yes or Veto cast from the page would have posted to `/votes/undefined`. Nothing errored: an empty
 * list is what a network with no open rounds looks like.
 *
 * So the translation lives in ONE place, inside `NetworksApi.listVotes`, where neither page can skip it.
 */
export interface ServerVoteRound {
  roundId: string;
  type: string;
  subjectLabel?: string;
  subjectInstanceId?: string;
  spaceId?: string;
  /**
   * What THIS instance calls the round's space (Q-133). `spaceId` is the network's id or the proposer's, and after a
   * rename neither is the name the operator here knows. Absent from an older server, and for a space not yet carried.
   */
  localSpaceId?: string;
  openedAt: string;
  deadline: string;
  concluded?: boolean;
  passed?: boolean;
  votes?: { instanceId: string; vote: 'yes' | 'veto' }[];
  /** What a meta_change round proposes — the page shows a voter what they are asked to approve. */
  metaChangedFields?: string[];
  changedTypes?: string[];
  keptTypes?: string[];
  proposesLayer?: boolean;
  /** One sentence naming what the round does, written by the server for a voter. Plain text: peer-authored. */
  summary?: string;
}

/** What a round is about, as a voter reads it: the space first ("add notes" says more than "add brain-a"), then who. */
export function roundSubject(space: string | undefined, who: string): string {
  return space ? (who ? `${space} (${who})` : space) : who;
}

/** Yes and veto counts for the tally every surface shows beside a round — one counting, not one per page. */
export function voteTally(round: Pick<VoteRound, 'votes'>): { yes: number; veto: number } {
  return {
    yes: round.votes.filter(v => v.vote === 'yes').length,
    veto: round.votes.filter(v => v.vote === 'veto').length,
  };
}

/**
 * The translation key of a round type's label. ONE spelling for every surface that names a round — the vote row, the
 * Overview panel, the decisions list and the toasts — so the wire value (`space_addition`) is never what a person reads.
 */
export const roundTypeKey = (type: string): string => `networks.roundType.${type}`;

/** How a round ended, as the client words it: a value the server records, or `ended` for anything it does not know. */
export type OutcomeWord = 'passed' | 'vetoed' | 'expired' | 'ended';
const OUTCOME_WORDS: readonly string[] = ['passed', 'vetoed', 'expired'];
export const outcomeWord = (outcome: string | undefined): OutcomeWord =>
  outcome !== undefined && OUTCOME_WORDS.includes(outcome) ? (outcome as OutcomeWord) : 'ended';
export const outcomeKey = (outcome: string | undefined): string => `networks.decisions.outcome.${outcomeWord(outcome)}`;

export function voteRoundFromServer(networkId: string, r: ServerVoteRound): VoteRound {
  const who = r.subjectLabel || r.subjectInstanceId || '';
  return {
    id: r.roundId,
    networkId,
    type: r.type,
    subject: roundSubject(r.localSpaceId ?? r.spaceId, who),
    openedAt: r.openedAt,
    deadline: r.deadline,
    status: !r.concluded ? 'open' : r.passed ? 'passed' : 'failed',
    votes: r.votes ?? [],
    // Copied only when sent: a round that proposes nothing carries none of them, not empty stand-ins.
    ...(r.metaChangedFields !== undefined ? { metaChangedFields: r.metaChangedFields } : {}),
    ...(r.changedTypes !== undefined ? { changedTypes: r.changedTypes } : {}),
    ...(r.keptTypes !== undefined ? { keptTypes: r.keptTypes } : {}),
    ...(r.proposesLayer !== undefined ? { proposesLayer: r.proposesLayer } : {}),
    ...(r.summary !== undefined ? { summary: r.summary } : {}),
  };
}
