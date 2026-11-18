/**
 * The steps a schema round carries are SIGNED by the member that proposed it (`Q-745`, bundle-284 design 2.4).
 *
 * ## What it prevents
 *
 * A round that carries `convertRecords` makes every member that applies it rewrite its records. The round travels through peers, and a
 * peer that relays it could add steps the proposer never chose, change the ones it did, or take them off. The cast's bound signature
 * (`bsig`) covers the round's type and target and is verified exactly as the cast gave it, so the steps cannot be put into what it signs: a
 * member of a release before this one builds the message without them and would refuse every cast of a round that carries steps, and the
 * schema vote would fail on it. So the steps are bound by a THIRD signature, `csig`, on the proposer's own cast only: over the v2 bound
 * message and the hash of the steps' canonical text. `sig` and `bsig` stay as they were, so an older member verifies what it always did and
 * ignores `csig`.
 *
 * ## What holds
 *
 * - `csig` verifies over the round's steps as stored; changed, added, removed or reordered steps fail it, and a key order inside a step
 *   does not;
 * - it is the PROPOSER's signature: another key, another round and another member's cast do not stand for it;
 * - `sig` and `bsig` are byte-identical to what the code before this change signed, for a round with steps and for one without (an
 *   Ed25519 signature is deterministic, so the same message under the same key is the same bytes);
 * - a member of the release before this one accepts the cast and the round (a frozen copy of its check is in this file);
 * - the wire shape: `csig` is carried by the push and the relay's reading of a cast, and is absent where the proposer chose no steps.
 *
 * Run: node --test testing/standalone/the-convert-steps-are-signed-by-the-proposer.test.js
 * (requires a prior server build)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tempInstanceDir, bootInstance, removeInstanceDir } from './_vote-round-instance.mjs';
import { SELF, P1 } from './_vote-round-sites.mjs';

const dir = tempInstanceDir('ythril-convert-csig-');
const NET = 'net-csig';
const ROUND = 'round-csig-1';

const STEPS = {
  steps: [
    { op: 'renameProperty', kind: 'entity', type: 'Person', from: 'fullName', to: 'name' },
    { op: 'mapEnum', kind: 'entity', type: 'Person', property: 'status', values: { a: 'x', b: 'y' } },
  ],
};

let signing;
let keys;

before(async () => {
  await bootInstance(dir, { instanceId: SELF, spaces: [{ id: 'general', label: 'General', builtIn: true, folders: [] }] });
  signing = await import('../../server/dist/util/signing.js');
  keys = signing.ensureInstanceKeypair();
  assert.ok(keys, 'the booted instance has no signing keypair');
});
after(() => { removeInstanceDir(dir); });

/** A meta_change round of this instance (the proposer is SELF), carrying `extra`. */
const roundOf = (extra = {}) => ({
  roundId: ROUND, type: 'meta_change', subjectInstanceId: SELF, subjectLabel: 'self', subjectUrl: '',
  openedAt: '2026-11-18T10:00:00.000Z', deadline: '2026-11-19T10:00:00.000Z', votes: [],
  spaceId: 'people', pendingMeta: { typeSchemas: { entity: { Person: { propertySchemas: { name: { type: 'string' } } } } } },
  ...extra,
});

/** The network this instance proposes on: it pins nobody, since the proposer's key is the instance's own. */
const net = () => ({ id: NET, members: [{ instanceId: P1 }] });

/** The round with this instance's own signed yes cast on it, as the open path stores it. */
function castRound(extra = {}) {
  const round = roundOf(extra);
  round.votes.push(signing.makeSignedOwnCast(NET, round, SELF, 'yes'));
  return round;
}

/** The messages the code before this change signed, written out: `sig` over v1, `bsig` over v2 (the round's type, its two space ids, its wipe list). */
const v1Message = (round, instanceId, vote = 'yes') => ['ythril-vote:v1', NET, round.roundId, round.subjectInstanceId, instanceId, vote].join('|');
const v2Message = (round, instanceId, vote = 'yes') => ['ythril-vote:v2', NET, round.roundId, round.subjectInstanceId, instanceId, vote,
  round.type, round.spaceId ?? '', round.networkSpaceId ?? '', [...new Set(round.wipeTypes ?? [])].sort().join(',')].join('|');

/** A member of the release before this one: its check of a cast, with no `csig` anywhere in it. */
function releasedMemberAccepts(network, round, cast, publicKeyPem) {
  if (!cast.sig) return false;
  if (cast.bsig) return signing.verifyMessage(publicKeyPem, v2Message(round, cast.instanceId, cast.vote), cast.bsig);
  return signing.verifyMessage(publicKeyPem, v1Message(round, cast.instanceId, cast.vote), cast.sig);
}

describe('csig binds the steps to the proposer', () => {
  it('the proposer\'s cast of a round with steps carries csig beside sig and bsig, and it verifies over the steps', () => {
    const round = castRound({ convertRecords: STEPS });
    const cast = round.votes[0];
    assert.ok(cast.sig && cast.bsig && cast.csig, `the cast is missing a signature: ${JSON.stringify(Object.keys(cast))}`);
    assert.equal(signing.convertRecordsSignedByProposer(net(), round), true);
  });

  it('a round that stamps only (`convertRecords: {}`) is signed too: the choice to convert is the proposer\'s', () => {
    const round = castRound({ convertRecords: {} });
    assert.ok(round.votes[0].csig, 'an empty convertRecords is a choice and carries csig');
    assert.equal(signing.convertRecordsSignedByProposer(net(), round), true);
  });

  it('a key order inside a step does not matter: the text signed is canonical', () => {
    const round = castRound({ convertRecords: STEPS });
    const shuffled = {
      steps: [
        { to: 'name', from: 'fullName', type: 'Person', kind: 'entity', op: 'renameProperty' },
        { values: { b: 'y', a: 'x' }, property: 'status', type: 'Person', kind: 'entity', op: 'mapEnum' },
      ],
    };
    assert.equal(signing.convertRecordsSignedByProposer(net(), { ...round, convertRecords: shuffled }), true);
  });

  it('changed steps fail it', () => {
    const round = castRound({ convertRecords: STEPS });
    const changed = structuredClone(STEPS);
    changed.steps[0].to = 'label';
    assert.equal(signing.convertRecordsSignedByProposer(net(), { ...round, convertRecords: changed }), false);
    const valueChanged = structuredClone(STEPS);
    valueChanged.steps[1].values.b = 'z';
    assert.equal(signing.convertRecordsSignedByProposer(net(), { ...round, convertRecords: valueChanged }), false);
  });

  it('a step added to the proposer\'s steps fails it', () => {
    const round = castRound({ convertRecords: STEPS });
    const more = { steps: [...STEPS.steps, { op: 'renameType', kind: 'entity', from: 'Person', to: 'Human' }] };
    assert.equal(signing.convertRecordsSignedByProposer(net(), { ...round, convertRecords: more }), false);
  });

  it('steps added to a round whose proposer chose none fail: there is no csig to stand for them', () => {
    const round = castRound();
    assert.equal(round.votes[0].csig, undefined, 'a round with no steps was signed over steps');
    assert.equal(signing.convertRecordsSignedByProposer(net(), { ...round, convertRecords: STEPS }), false);
    assert.equal(signing.convertRecordsSignedByProposer(net(), { ...round, convertRecords: {} }), false);
  });

  it('steps taken off a round that carried them fail: nothing signed is carried', () => {
    const round = castRound({ convertRecords: STEPS });
    const { convertRecords: _gone, ...without } = round;
    assert.equal(signing.convertRecordsSignedByProposer(net(), without), false);
  });

  it('a reordered list fails: the list is what was signed', () => {
    const round = castRound({ convertRecords: STEPS });
    assert.equal(signing.convertRecordsSignedByProposer(net(), { ...round, convertRecords: { steps: [...STEPS.steps].reverse() } }), false);
  });

  it('a csig stripped from the cast fails it (an older relayer drops what it does not know)', () => {
    const round = castRound({ convertRecords: STEPS });
    const { csig: _dropped, ...rest } = round.votes[0];
    assert.equal(signing.convertRecordsSignedByProposer(net(), { ...round, votes: [rest] }), false);
  });

  it('a body that is not a convertRecords is not signed for: false, never a throw', () => {
    const round = castRound({ convertRecords: STEPS });
    for (const bad of [null, 'steps', [], { steps: 'x' }, { steps: [{ op: 'nope' }] }, { extra: 1 }]) {
      assert.equal(signing.convertRecordsSignedByProposer(net(), { ...round, convertRecords: bad }), false, JSON.stringify(bad));
    }
  });

  it('it is the PROPOSER\'s: another round id, another key and another member\'s cast do not stand for it', () => {
    const round = castRound({ convertRecords: STEPS });
    assert.equal(signing.convertRecordsSignedByProposer(net(), { ...round, roundId: 'round-csig-2' }), false, 'a csig replayed onto another round');
    assert.equal(signing.convertRecordsSignedByProposer({ ...net(), id: 'net-other' }, round), false, 'a csig replayed onto another network');

    // The same csig text read as the cast of a member that is not the proposer is not consulted.
    const other = { ...round, subjectInstanceId: P1 };
    assert.equal(signing.convertRecordsSignedByProposer(net(), other), false, 'the proposer is the round\'s subject, not whoever signed');

    // A csig made by a key the proposer did not pin.
    const stranger = signing.generateInstanceKeypair();
    const forged = { ...round.votes[0], csig: signing.signMessage(stranger.privateKeyPem,
      signing.convertRecordsCastMessage({ networkId: NET, roundId: ROUND, subjectInstanceId: SELF, instanceId: SELF, vote: 'yes', round, convertRecords: STEPS })) };
    assert.equal(signing.convertRecordsSignedByProposer(net(), { ...round, votes: [forged] }), false);
  });

  it('a remote proposer is read against the key pinned for it, and against nothing else', () => {
    const remote = signing.generateInstanceKeypair();
    const round = roundOf({ subjectInstanceId: P1, convertRecords: STEPS });
    const cast = {
      instanceId: P1, vote: 'yes', castAt: '2026-11-18T10:00:00.000Z',
      sig: signing.signMessage(remote.privateKeyPem, v1Message(round, P1)),
      bsig: signing.signMessage(remote.privateKeyPem, v2Message(round, P1)),
      csig: signing.signMessage(remote.privateKeyPem, signing.convertRecordsCastMessage({ networkId: NET, roundId: ROUND, subjectInstanceId: P1, instanceId: P1, vote: 'yes', round, convertRecords: STEPS })),
    };
    round.votes.push(cast);
    assert.equal(signing.convertRecordsSignedByProposer({ id: NET, members: [{ instanceId: P1, signingPublicKey: remote.publicKeyPem }] }, round), true);
    assert.equal(signing.convertRecordsSignedByProposer({ id: NET, members: [{ instanceId: P1 }] }, round), false, 'a proposer with no pinned key signs for nothing');
    assert.equal(signing.convertRecordsSignedByProposer({ id: NET, members: [{ instanceId: P1, signingPublicKey: keys.publicKeyPem }] }, round), false, 'another key is not the proposer\'s');
  });
});

describe('sig and bsig are what they were before csig', () => {
  for (const [label, extra] of [['no steps', {}], ['steps', { convertRecords: STEPS }], ['steps that stamp only', { convertRecords: {} }]]) {
    it(`both are byte-identical to the messages the earlier code signed, for a round with ${label}`, () => {
      const round = roundOf(extra);
      const cast = signing.makeSignedOwnCast(NET, round, SELF, 'yes');
      assert.equal(cast.sig, signing.signMessage(keys.privateKeyPem, v1Message(round, SELF)), 'sig changed');
      assert.equal(cast.bsig, signing.signMessage(keys.privateKeyPem, v2Message(round, SELF)), 'bsig changed');
      assert.equal(signing.voteCastMessage({ networkId: NET, roundId: ROUND, subjectInstanceId: SELF, instanceId: SELF, vote: 'yes' }), v1Message(round, SELF));
      assert.equal(signing.voteCastBoundMessage({ networkId: NET, roundId: ROUND, subjectInstanceId: SELF, instanceId: SELF, vote: 'yes', round }), v2Message(round, SELF));
    });
  }

  it('the round with steps and the round without give one sig and one bsig', () => {
    const a = signing.makeSignedOwnCast(NET, roundOf(), SELF, 'yes');
    const b = signing.makeSignedOwnCast(NET, roundOf({ convertRecords: STEPS }), SELF, 'yes');
    assert.equal(a.sig, b.sig);
    assert.equal(a.bsig, b.bsig);
    assert.equal(a.csig, undefined);
    assert.ok(b.csig);
  });

  it('a cast of a round with no steps has no csig key at all, so its wire form is the earlier one', () => {
    const cast = signing.makeSignedOwnCast(NET, roundOf(), SELF, 'yes');
    assert.deepEqual(Object.keys(cast).sort(), ['bsig', 'castAt', 'instanceId', 'sig', 'vote']);
    assert.deepEqual(Object.keys(signing.castForWire(cast)).sort(), ['bsig', 'castAt', 'instanceId', 'sig', 'vote']);
  });

  it('a member that is not the proposer signs no csig, whatever steps the round carries', () => {
    const cast = signing.makeSignedOwnCast(NET, roundOf({ subjectInstanceId: P1, convertRecords: STEPS }), SELF, 'yes');
    assert.equal(cast.csig, undefined, 'a member signed steps it did not propose');
  });

  it('the message csig signs names its own version, the v2 message and the hash of the canonical steps', () => {
    const round = roundOf({ convertRecords: STEPS });
    const text = signing.convertRecordsCastMessage({ networkId: NET, roundId: ROUND, subjectInstanceId: SELF, instanceId: SELF, vote: 'yes', round, convertRecords: STEPS });
    const parts = text.split('|');
    assert.equal(parts[0], 'ythril-vote:v3-convert');
    assert.equal(parts.slice(1, -1).join('|'), v2Message(round, SELF), 'the middle of the message is the v2 bound message, unchanged');
    assert.match(parts.at(-1), /^[0-9a-f]{64}$/, 'the last part is a sha256 in hex');
  });
});

describe('a member of the release before csig', () => {
  it('accepts the proposer\'s cast of a round with steps, and ignores the csig and the key it does not know', () => {
    const round = castRound({ convertRecords: STEPS });
    assert.equal(releasedMemberAccepts(net(), round, round.votes[0], keys.publicKeyPem), true);
    // The check of this release, which is the one that holds the cast against the round it is applied to, agrees.
    assert.equal(signing.isVoteCastSignatureValid({ id: NET, members: [{ instanceId: SELF, signingPublicKey: keys.publicKeyPem }] }, round, round.votes[0]), true);
  });

  it('accepts a cast whose csig was stripped or corrupted: it never read it', () => {
    const round = castRound({ convertRecords: STEPS });
    const { csig: _gone, ...stripped } = round.votes[0];
    assert.equal(releasedMemberAccepts(net(), round, stripped, keys.publicKeyPem), true);
    assert.equal(releasedMemberAccepts(net(), round, { ...round.votes[0], csig: 'AAAA' }, keys.publicKeyPem), true);
  });

  it('a corrupted csig does not make this release refuse the cast either: csig decides the steps, never the vote', () => {
    const round = castRound({ convertRecords: STEPS });
    const tampered = { ...round.votes[0], csig: 'AAAA' };
    assert.equal(signing.isVoteCastSignatureValid({ id: NET, members: [{ instanceId: SELF, signingPublicKey: keys.publicKeyPem }] }, round, tampered), true);
  });
});

describe('the wire', () => {
  it('castForWire and castFromBody carry csig, and only a text one', () => {
    const cast = { instanceId: SELF, vote: 'yes', castAt: '2026-11-18T10:00:00.000Z', sig: 's', bsig: 'b', csig: 'c' };
    assert.equal(signing.castForWire(cast).csig, 'c');
    assert.equal(signing.castFromBody(cast).csig, 'c');
    assert.equal('csig' in signing.castFromBody({ ...cast, csig: 7 }), false);
    assert.equal('csig' in signing.castFromBody({ ...cast, csig: '' }), false);
    assert.equal('csig' in signing.castForWire({ ...cast, csig: undefined }), false);
  });
});
