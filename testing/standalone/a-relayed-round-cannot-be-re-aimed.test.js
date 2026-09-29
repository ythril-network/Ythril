/**
 * A vote cast is bound to what the round would DO, so a relaying member cannot re-aim it (`Q-138`).
 *
 * A cast signed `network|round|subject|voter|vote` and nothing of the round's content. A receiver that learns a round
 * from a relayer adopts the relayer's copy, then verifies each cast against it — so a member relaying a
 * `space_deletion` could rewrite `spaceId` to another space the network carries, and every honest cast still verified.
 *
 * A cast now also carries `bsig`, over the round's type and target. The table this pins:
 *
 * | cast                          | voter runs           | round as signed | accepted |
 * |-------------------------------|----------------------|-----------------|----------|
 * | `sig` + `bsig`                | any                  | yes             | yes      |
 * | `sig` + `bsig`                | any                  | re-aimed        | NO       |
 * | `sig` only                    | 5.6.0 or later       | either          | NO — a stripped `bsig` is not a downgrade |
 * | `sig` only                    | older, or not known  | yes             | yes — the transition, until every member upgrades |
 *
 * Run: node --test testing/standalone/a-relayed-round-cannot-be-re-aimed.test.js (after the server build)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const signing = await import('../../server/dist/util/signing.js');
const fn = (name) => {
  assert.equal(typeof signing[name], 'function', `${name} does not exist — the rule it carries has no home`);
  return signing[name];
};

const NET = '33333333-3333-4333-8333-333333333333';
const keys = signing.generateInstanceKeypair();
const VOTER = 'voter-instance';
const round = () => ({
  roundId: 'r1', type: 'space_deletion', subjectInstanceId: 'subject', subjectLabel: 's', subjectUrl: 'https://s',
  deadline: '2099-01-01T00:00:00Z', openedAt: '2026-09-29T00:00:00Z', votes: [], spaceId: 'research', networkSpaceId: 'research',
});
const net = (voterVersion) => ({
  id: NET, label: 'n', type: 'club', spaces: ['research', 'payroll'], members: [
    { instanceId: VOTER, label: 'v', url: 'https://v', signingPublicKey: keys.publicKeyPem, ...(voterVersion ? { version: voterVersion } : {}) },
  ], pendingRounds: [],
});

/** A cast as a voter builds it: the v1 signature every version checks, and the bound one. */
function castFor(r, { bound = true } = {}) {
  const base = { networkId: NET, roundId: r.roundId, subjectInstanceId: r.subjectInstanceId, instanceId: VOTER, vote: 'yes' };
  const cast = { instanceId: VOTER, vote: 'yes', castAt: '2026-09-29T00:00:01Z', sig: signing.signMessage(keys.privateKeyPem, signing.voteCastMessage(base)) };
  if (bound) cast.bsig = signing.signMessage(keys.privateKeyPem, fn('voteCastBoundMessage')({ ...base, round: r }));
  return cast;
}
const valid = (n, r, c) => signing.isVoteCastSignatureValid(n, r, c);
/** The first version that signs bound casts, read from the module so the table follows the release it shipped in. */
const SINCE = signing.BOUND_CASTS_SINCE;

describe('a bound cast verifies only against the round it was cast on', () => {
  it('the honest round', () => {
    const r = round();
    assert.equal(valid(net(SINCE), r, castFor(r)), true);
  });

  for (const [field, value] of [['spaceId', 'payroll'], ['networkSpaceId', 'payroll'], ['type', 'space_wipe'], ['wipeTypes', ['entities']]]) {
    it(`a round re-aimed in ${field} is refused, though its v1 signature still verifies`, () => {
      const honest = round();
      const cast = castFor(honest);
      const reaimed = { ...honest, [field]: value };
      assert.equal(signing.verifyMessage(keys.publicKeyPem, signing.voteCastMessage({ networkId: NET, roundId: 'r1',
        subjectInstanceId: 'subject', instanceId: VOTER, vote: 'yes' }), cast.sig), true, 'the v1 signature should still verify — that is the hole');
      assert.equal(valid(net(SINCE), reaimed, cast), false, `a cast verified on a round whose ${field} was rewritten`);
      assert.equal(valid(net(undefined), reaimed, cast), false, 'a bound cast must bind whatever version its voter is known to run');
    });
  }

  it('the order of wipeTypes is not content', () => {
    const r = { ...round(), type: 'space_wipe', wipeTypes: ['facts', 'entities'] };
    const cast = castFor(r);
    assert.equal(valid(net(SINCE), { ...r, wipeTypes: ['entities', 'facts'] }, cast), true);
  });
});

describe('a cast without the bound signature', () => {
  it('from a voter known to run the first bound version or later is refused — stripping bsig is not a downgrade', () => {
    assert.equal(SINCE, '5.6.0', 'bound casts shipped in 5.6.0; a later patch of an older line must not be read as signing them');
    const r = round();
    assert.equal(valid(net(SINCE), r, castFor(r, { bound: false })), false);
    assert.equal(valid(net('6.0.0'), r, castFor(r, { bound: false })), false);
  });

  it('from an older voter, or one whose version is not known, falls back to the v1 check (the transition)', () => {
    const r = round();
    assert.equal(valid(net('5.5.2'), r, castFor(r, { bound: false })), true);
    // A patch on the 5.5 line carries no bsig, so it is older whatever its patch number.
    assert.equal(valid(net('5.5.9'), r, castFor(r, { bound: false })), true);
    assert.equal(valid(net(undefined), r, castFor(r, { bound: false })), true);
  });
});

describe('the cast crosses the wire whole', () => {
  it('castForWire keeps both signatures, and castFromBody reads them back', () => {
    const r = round();
    const cast = castFor(r);
    const wire = fn('castForWire')(cast);
    assert.equal(wire.bsig, cast.bsig, 'the bound signature is dropped on the way out');
    assert.equal(wire.sig, cast.sig);
    const back = fn('castFromBody')(JSON.parse(JSON.stringify(wire)));
    assert.deepEqual(back, cast, 'the relay route rebuilds a different cast from what was sent');
  });

  it('castFromBody refuses what is not a cast', () => {
    const from = fn('castFromBody');
    assert.equal(from({ vote: 'maybe', instanceId: 'x' }), null);
    assert.equal(from({ vote: 'yes' }), null);
    assert.equal(from(null), null);
  });
});
