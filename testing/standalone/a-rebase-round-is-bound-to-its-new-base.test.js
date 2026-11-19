/**
 * A cast on a `space_rebase` round is bound to the new base, so a relaying member cannot change what the network voted for (Q-748,
 * slice A, design r4 §4.1 rule 4).
 *
 * The bound message of a cast (`bsig`, `voteCastBoundMessage` in `server/src/util/signing.ts`) covers a round's type and target. For a
 * `space_rebase` round the target includes `rebase { base, vocab, epoch }`: changing any one of the three after the cast fails the
 * signature. For every other round type the message is byte-identical to what it was before the rebase round existed, so a member of an
 * earlier release still verifies every cast it verified before (the fixtures below are those messages, written out).
 *
 * Run: node --test testing/standalone/a-rebase-round-is-bound-to-its-new-base.test.js (after the server build)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { sign, verify } from 'node:crypto';

const signing = await import('../../server/dist/util/signing.js');

const NET = '33333333-3333-4333-8333-333333333333';
const keys = signing.generateInstanceKeypair();
const params = (round) => ({ networkId: NET, roundId: 'r1', subjectInstanceId: 'proposer', instanceId: 'voter', vote: 'yes', round });

const REBASE = { base: 'https://b.example.org/ld/s1/', vocab: 'https://b.example.org/ld/s1/vocab/', epoch: 2 };
const rebaseRound = { type: 'space_rebase', spaceId: 'net-space-1', rebase: REBASE };

describe('a space_rebase cast binds base, vocab and epoch', () => {
  it('the bound message names the three', () => {
    const message = signing.voteCastBoundMessage(params(rebaseRound));
    for (const part of [REBASE.base, REBASE.vocab, String(REBASE.epoch)]) assert.ok(message.includes(part), `${part} is bound: ${message}`);
  });
  for (const field of ['base', 'vocab', 'epoch']) {
    it(`a relayer that changes the round's ${field} fails the signature`, () => {
      const message = signing.voteCastBoundMessage(params(rebaseRound));
      const bsig = sign(null, Buffer.from(message, 'utf8'), keys.privateKeyPem).toString('base64');
      const holds = (round) => verify(null, Buffer.from(signing.voteCastBoundMessage(params(round)), 'utf8'), keys.publicKeyPem, Buffer.from(bsig, 'base64'));
      assert.equal(holds(rebaseRound), true, 'the cast verifies against the round it was signed over');
      const altered = { ...rebaseRound, rebase: { ...REBASE, [field]: field === 'epoch' ? 3 : `${REBASE[field]}x/` } };
      assert.equal(holds(altered), false, `changing ${field} fails the cast`);
    });
  }
  it('a round with no rebase field binds an empty target, never another round\'s', () => {
    const bare = signing.voteCastBoundMessage(params({ type: 'space_rebase', spaceId: 'net-space-1' }));
    assert.notEqual(bare, signing.voteCastBoundMessage(params(rebaseRound)));
  });
});

describe('every other round type signs what it always did, byte for byte', () => {
  const fixtures = [
    [{ type: 'space_deletion', spaceId: 'local-1', networkSpaceId: 'net-1' },
      `ythril-vote:v2|${NET}|r1|proposer|voter|yes|space_deletion|local-1|net-1|`],
    [{ type: 'space_wipe', spaceId: 'local-1', networkSpaceId: 'net-1', wipeTypes: ['memories', 'files', 'memories'] },
      `ythril-vote:v2|${NET}|r1|proposer|voter|yes|space_wipe|local-1|net-1|files,memories`],
    [{ type: 'meta_change', spaceId: 'net-1' }, `ythril-vote:v2|${NET}|r1|proposer|voter|yes|meta_change|net-1||`],
    [{ type: 'join' }, `ythril-vote:v2|${NET}|r1|proposer|voter|yes|join|||`],
    // A stray rebase field on a round of another type is not bound: only the type that carries it binds it.
    [{ type: 'space_deletion', spaceId: 'local-1', networkSpaceId: 'net-1', rebase: REBASE },
      `ythril-vote:v2|${NET}|r1|proposer|voter|yes|space_deletion|local-1|net-1|`],
  ];
  for (const [round, want] of fixtures) {
    it(`${round.type}${round.rebase ? ' with a stray rebase field' : ''}`, () => assert.equal(signing.voteCastBoundMessage(params(round)), want));
  }
});
