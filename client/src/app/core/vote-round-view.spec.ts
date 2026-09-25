import { describe, it, expect } from 'vitest';
import { voteRoundFromServer } from './vote-round-view';

/**
 * The server's round shape, as `api/networks/votes.ts` sends it, into the one the pages read. Written against the
 * server's field names on purpose: the client type was once written against a shape the server never sent, and the
 * Networks page listed no vote and cast to `/votes/undefined` without an error anywhere.
 */
const server = (over = {}) => ({
  roundId: 'r1', type: 'space_addition', subjectInstanceId: 'i-1', subjectLabel: 'brain-a', spaceId: 'notes',
  openedAt: '2026-09-25T00:00:00Z', deadline: '2026-09-26T00:00:00Z', votes: [{ instanceId: 'i-1', vote: 'yes' as const }],
  ...over,
});

describe('voteRoundFromServer', () => {
  it('uses the round id the vote route takes', () => {
    expect(voteRoundFromServer('n', server()).id).toBe('r1');
  });
  it('an unconcluded round is open, a concluded one passed or failed', () => {
    expect(voteRoundFromServer('n', server()).status).toBe('open');
    expect(voteRoundFromServer('n', server({ concluded: true, passed: true })).status).toBe('passed');
    expect(voteRoundFromServer('n', server({ concluded: true, passed: false })).status).toBe('failed');
  });
  it('a round about a space names the space, then who proposed it', () => {
    expect(voteRoundFromServer('n', server()).subject).toBe('notes (brain-a)');
    expect(voteRoundFromServer('n', server({ spaceId: undefined })).subject).toBe('brain-a');
  });
  it('carries the network and the casts', () => {
    const r = voteRoundFromServer('net-1', server());
    expect(r.networkId).toBe('net-1');
    expect(r.votes).toEqual([{ instanceId: 'i-1', vote: 'yes' }]);
  });
});
