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
  it('names the space by THIS instance\'s name for it, not the network\'s (Q-133)', () => {
    // After a rename the network may call the space `y-twin` while this instance calls it `y-project-template`; an
    // operator asked to vote on deleting it must see the name they know. The server's `localSpaceId` is that name.
    const r = voteRoundFromServer('n', server({ spaceId: 'y-twin', localSpaceId: 'y-project-template' } as never));
    expect(r.subject).toBe('y-project-template (brain-a)');
    expect(voteRoundFromServer('n', server({ spaceId: 'y-twin' })).subject, 'an older server sends no localSpaceId')
      .toBe('y-twin (brain-a)');
  });
  it('carries what a meta_change round proposes and the sentence the server wrote about it', () => {
    /*
     * The server has always sent `metaChangedFields`, `changedTypes`, `keptTypes` and `proposesLayer` on a
     * meta_change round, and the page could not show them: the type declared none of them and this mapping copies
     * only what it names, so a voter was asked to approve "meta_change: notes" with nothing about what changes.
     * `summary` is the one-sentence form the list now adds. All five must survive the translation.
     */
    const r = voteRoundFromServer('n', server({
      type: 'meta_change', metaChangedFields: ['schemas', 'description'], changedTypes: ['entity:Task'],
      keptTypes: ['fact:Note'], proposesLayer: true, summary: 'Proposed: Task gains a due date.',
    }));
    expect(r.metaChangedFields).toEqual(['schemas', 'description']);
    expect(r.changedTypes).toEqual(['entity:Task']);
    expect(r.keptTypes).toEqual(['fact:Note']);
    expect(r.proposesLayer).toBe(true);
    expect(r.summary).toBe('Proposed: Task gains a due date.');
  });
  it('a round that proposes nothing carries none of them, rather than empty stand-ins', () => {
    const r = voteRoundFromServer('n', server());
    for (const key of ['metaChangedFields', 'changedTypes', 'keptTypes', 'proposesLayer', 'summary'] as const) {
      expect(r[key], `${key} appeared on a round that did not send it`).toBeUndefined();
    }
  });
  it('carries the network and the casts', () => {
    const r = voteRoundFromServer('net-1', server());
    expect(r.networkId).toBe('net-1');
    expect(r.votes).toEqual([{ instanceId: 'i-1', vote: 'yes' }]);
  });
});
