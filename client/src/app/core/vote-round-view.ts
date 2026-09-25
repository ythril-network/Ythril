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
  openedAt: string;
  deadline: string;
  concluded?: boolean;
  passed?: boolean;
  votes?: { instanceId: string; vote: 'yes' | 'veto' }[];
}

export function voteRoundFromServer(networkId: string, r: ServerVoteRound): VoteRound {
  const who = r.subjectLabel || r.subjectInstanceId || '';
  return {
    id: r.roundId,
    networkId,
    type: r.type,
    // A round about a space names the space first: "add notes" says more than "add brain-a".
    subject: r.spaceId ? (who ? `${r.spaceId} (${who})` : r.spaceId) : who,
    openedAt: r.openedAt,
    deadline: r.deadline,
    status: !r.concluded ? 'open' : r.passed ? 'passed' : 'failed',
    votes: r.votes ?? [],
  };
}
