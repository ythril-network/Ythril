/**
 * The client's idea of a vote round against the one the server serves.
 *
 * `ServerVoteRound` (`core/vote-round-view.ts`) is the client's hand-written copy of the server's `VoteRound`
 * (`server/src/config/types-networks.ts`), and `voteRoundFromServer` copies only what it names. So a field the server
 * adds is silently absent on the page: it sent `metaChangedFields`, `changedTypes`, `keptTypes` and `proposesLayer`
 * for a meta_change round, and the Networks page asked voters to approve "meta_change: notes" with nothing about what
 * changes. Nothing errored — a field nobody copies is not an error.
 *
 * The rule, over BOTH sets derived from source: every key the server's round carries is either declared by the
 * client's type or named below with the reason the client does not read it. A key added on the server lands here as
 * "unclassified" and somebody decides — which is the decision that was never taken for the four above.
 *
 * It reads server source because the client job does not build the server; it lives under `testing/` for that reason.
 */
import { describe, it, expect } from 'vitest';
import { interfaceKeys, readClientSource, readRepoSource } from './server-source';

/**
 * Server round keys the client deliberately does not read, each with why. Not a list of the shape — a list of
 * decisions: a key that is neither here nor declared by `ServerVoteRound` fails the first test.
 */
const NOT_READ: Record<string, string> = {
  inviteKeyHash: 'a credential hash; the operator list projects it out and the client must never type it (Q-452)',
  pendingMember: 'the joiner\'s member record with its token hash; projected out of the operator list, never typed here',
  pendingMeta: 'the full proposed meta snapshot, large and not what a voter is asked about; `summary` and the changed-key lists are',
  subjectUrl: 'where the subject instance lives; a voter approves a name, not an address',
  networkSpaceId: 'the network\'s id for the space; `localSpaceId` is the name this operator knows',
  wipeTypes: 'which collections a space_wipe empties; not shown by the row today',
  baseMetaVersion: 'the version a proposal was computed against; machinery for the conclusion, not for the voter',
  requiredVoters: 'braintree machinery for the conclusion',
  appliedHere: 'LOCAL conclusion bookkeeping',
  proposedHere: 'LOCAL: which instance opened the round',
  outcome: 'LOCAL; an open round has none — the decisions list carries it',
  concludedAt: 'LOCAL; an open round has none — the decisions list carries it',
};

/**
 * `ServerVoteRound` keys the view type folds into other fields rather than carrying under the same name.
 * Everything else must reappear, same name, on the `VoteRound` the pages read.
 */
const FOLDED: Record<string, string> = {
  roundId: 'becomes `id`',
  subjectLabel: 'part of `subject`',
  subjectInstanceId: 'part of `subject`',
  spaceId: 'part of `subject`',
  localSpaceId: 'part of `subject`',
  concluded: 'becomes `status`',
  passed: 'becomes `status`',
};

/** Keys the operator list ADDS to the server's stored round — what the act computes, not what the config holds. */
const ADDED_BY_THE_LIST = ['localSpaceId', 'summary'];

describe('the client reads the vote round the server serves', () => {
  const serverKeys = interfaceKeys(readRepoSource('server/src/config/types-networks.ts'), 'VoteRound');
  const clientKeys = interfaceKeys(readClientSource('src/app/core/vote-round-view.ts'), 'ServerVoteRound');
  const viewKeys = interfaceKeys(readClientSource('src/app/core/api.types.ts'), 'VoteRound');

  it('derives its key sets (a floor: an empty set passes every loop written over it)', () => {
    expect(serverKeys.length, `server VoteRound keys: ${serverKeys.join(', ')}`).toBeGreaterThan(15);
    expect(clientKeys.length, `ServerVoteRound keys: ${clientKeys.join(', ')}`).toBeGreaterThan(8);
    expect(viewKeys.length, `VoteRound keys: ${viewKeys.join(', ')}`).toBeGreaterThan(6);
    expect(serverKeys).toContain('roundId');
    expect(clientKeys).toContain('roundId');
  });

  it('every key the server\'s round carries is declared by ServerVoteRound or named with the reason it is not read', () => {
    const unclassified = serverKeys.filter(k => !clientKeys.includes(k) && !(k in NOT_READ));
    expect(unclassified, `the server's round carries keys the client neither reads nor has decided to ignore:\n  ${unclassified.join('\n  ')}`)
      .toEqual([]);
  });

  it('the ignore list names only keys the server has and the client does not read — no stale reasons', () => {
    const stale = Object.keys(NOT_READ).filter(k => !serverKeys.includes(k) || clientKeys.includes(k));
    expect(stale, 'entries whose reason no longer describes a key').toEqual([]);
  });

  it('ServerVoteRound declares nothing the server does not send', () => {
    const invented = clientKeys.filter(k => !serverKeys.includes(k) && !ADDED_BY_THE_LIST.includes(k));
    expect(invented, 'client keys with no counterpart on the server round or the list\'s additions').toEqual([]);
  });

  it('the list\'s own additions are declared — a voter\'s one-sentence summary reaches the type', () => {
    for (const key of ADDED_BY_THE_LIST) expect(clientKeys, `ServerVoteRound does not declare \`${key}\``).toContain(key);
  });

  it('never types a credential: no hash key, no member record, no meta snapshot reaches the client type', () => {
    const credentialish = clientKeys.filter(k => /hash/i.test(k) || k === 'pendingMember' || k === 'pendingMeta');
    expect(credentialish).toEqual([]);
  });

  it('every ServerVoteRound key reaches the VoteRound the pages read, or is folded into one that does', () => {
    const lost = clientKeys.filter(k => !viewKeys.includes(k) && !(k in FOLDED));
    expect(lost, `the translation drops these — the page can never show them:\n  ${lost.join('\n  ')}`).toEqual([]);
  });
});
