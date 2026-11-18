/**
 * A member decides what to do with the steps a passed schema round carries from the ROUND ITSELF, and never lets a refused step refuse the
 * schema (`Q-745`, bundle-284 design 2.4, 3 and 1.5).
 *
 * ## What it prevents
 *
 * A passed `meta_change` round that carries `convertRecords` can make every member rewrite its records, and the round is a peer's: it came
 * through whoever relayed it. Three things must hold on every member, from what the round carries and nothing the member was told on the side:
 *
 * - **Steps the proposer did not sign are not applied.** The steps are applied only when the proposer's cast carries a `csig` that verifies
 *   over them (`the-convert-steps-are-signed-by-the-proposer`). A missing, stripped or failing `csig` makes the member refuse the STEPS
 *   (`steps_not_signed`) and apply the SCHEMA, as the network voted it: a relayer can at worst make a member stamp and list, never rewrite.
 * - **Steps that do not fit the round's own change are not applied.** Each step is held to the round's `metaBase` (what the changed types held
 *   when proposed) and `pendingMeta`, which every member sees alike, so a layer a member already pulled cannot make the check fail on it. A
 *   type a type step leaves is not in `metaBase` (the round did not change it: a network keeps it), so what the member itself holds fills in the
 *   types the round did not carry. The member's own effective meta once the round is applied is held to the same rule a property step makes
 *   (the old name is gone), because own and layer definitions union their properties.
 * - **A refused step is never a refused round.** Whatever the answer about the steps, the schema half of the decision is the plan's: apply it,
 *   unless this member cannot read the schema, which refuses the round whole as it always did and starts nothing.
 *
 * The decision is a pure function of the net, the round, the schema plan and (optionally) what the member holds: it starts nothing. A later
 * slice connects "apply" to the run.
 *
 * Run: node --test testing/standalone/a-member-decides-the-steps-from-the-round-itself.test.js
 * (requires a prior server build)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { P1 } from './_vote-round-sites.mjs';

const signing = await import('../../server/dist/util/signing.js');
const governance = await import('../../server/dist/sync/governance.js');

const NET = 'net-decide';
const ROUND = 'round-decide-1';
const PROPOSER = P1;
const kp = signing.generateInstanceKeypair();

const string = { type: 'string' };
const STEPS = {
  steps: [
    { op: 'renameProperty', kind: 'entity', type: 'Person', from: 'fullName', to: 'name' },
    { op: 'mapEnum', kind: 'entity', type: 'Person', property: 'status', values: { a: 'x', b: 'y' } },
  ],
};
const PERSON_BEFORE = { propertySchemas: { fullName: string, status: { type: 'string', enum: ['a', 'b'] } } };
const PERSON_AFTER = { propertySchemas: { name: string, status: { type: 'string', enum: ['x', 'y'] } } };

const net = () => ({ id: NET, members: [{ instanceId: PROPOSER, signingPublicKey: kp.publicKeyPem }] });
const PLAN = Object.freeze({ ok: true, localSpace: 'people', ownEdit: false, conflicts: [], unknownFields: [] });
const UNREADABLE = Object.freeze({ ok: false, localSpace: 'people', reason: 'a type this member cannot parse' });

/** The proposer's cast of `round`, signed by `key` over `convertRecords` (default: the round's own). */
function proposerCast(round, { key = kp, convertRecords = round.convertRecords, withCsig = true } = {}) {
  const base = { networkId: NET, roundId: round.roundId, subjectInstanceId: round.subjectInstanceId, instanceId: PROPOSER, vote: 'yes' };
  return {
    instanceId: PROPOSER, vote: 'yes', castAt: '2026-11-18T10:00:00.000Z',
    sig: signing.signMessage(key.privateKeyPem, signing.voteCastMessage(base)),
    bsig: signing.signMessage(key.privateKeyPem, signing.voteCastBoundMessage({ ...base, round })),
    ...(withCsig && convertRecords !== undefined
      ? { csig: signing.signMessage(key.privateKeyPem, signing.convertRecordsCastMessage({ ...base, round, convertRecords })) } : {}),
  };
}

/** A passed rename-and-map round of the Person type, signed by the proposer unless told otherwise. */
function round({ signed = {}, ...over } = {}) {
  const r = {
    roundId: ROUND, type: 'meta_change', subjectInstanceId: PROPOSER, subjectLabel: 'proposer', subjectUrl: '',
    openedAt: '2026-11-18T10:00:00.000Z', deadline: '2026-11-19T10:00:00.000Z', votes: [],
    spaceId: 'people', changedTypes: ['entity:Person'], metaChangedFields: ['typeSchemas'], baseMetaVersion: 1,
    metaBase: { typeSchemas: { entity: { Person: PERSON_BEFORE } } },
    pendingMeta: { typeSchemas: { entity: { Person: PERSON_AFTER } } },
    convertRecords: STEPS,
    ...over,
  };
  r.votes.push(proposerCast(r, signed));
  return r;
}

const decide = (r, plan = PLAN, held) => governance.decideRoundConvertRecords(net(), r, plan, held);

describe('a member applies the steps a round carries when the proposer signed them and they fit the round', () => {
  it('a valid csig and steps that match the round\'s own before and after give "apply", with the steps as signed', () => {
    const d = decide(round());
    assert.equal(d.schema, 'apply');
    assert.equal(d.convert.state, 'apply', JSON.stringify(d));
    assert.deepEqual(d.convert.convertRecords, STEPS);
  });

  it('a round that stamps only (`convertRecords: {}`) with a valid csig gives "apply" with no steps', () => {
    const d = decide(round({ convertRecords: {} }));
    assert.equal(d.convert.state, 'apply', JSON.stringify(d));
    assert.deepEqual(d.convert.convertRecords, {});
  });

  it('a type step whose source the round did not change is read against what the member holds', () => {
    // The network keeps `Person`: the round changes only `Human`, so `metaBase` holds neither, and the member's own meta answers for the source.
    const r = round({
      changedTypes: ['entity:Human'], metaBase: {}, pendingMeta: { typeSchemas: { entity: { Human: PERSON_AFTER } } },
      convertRecords: { steps: [{ op: 'renameType', kind: 'entity', from: 'Person', to: 'Human' }] },
    });
    const held = { before: { typeSchemas: { entity: { Person: PERSON_BEFORE } } } };
    assert.equal(decide(r, PLAN, held).convert.state, 'apply');
    const without = decide(r, PLAN, undefined);
    assert.equal(without.convert.state, 'refused');
    assert.equal(without.convert.reason, 'type_not_declared_before');
    assert.equal(without.schema, 'apply');
  });
});

describe('a round with no steps gives "none"', () => {
  it('a round that carries no convertRecords starts nothing: "none"', () => {
    const r = round({ convertRecords: undefined });
    delete r.convertRecords;
    const d = decide(r);
    assert.deepEqual(d, { schema: 'apply', convert: { state: 'none' } });
  });

  it('a round that carried steps and lost them to a relayer is "none" and never "apply"', () => {
    const r = round();
    delete r.convertRecords;
    assert.deepEqual(decide(r), { schema: 'apply', convert: { state: 'none' } });
  });
});

describe('steps the proposer did not sign are refused and the schema is applied', () => {
  const refusedNotSigned = (r, label) => {
    const d = decide(r);
    assert.equal(d.convert.state, 'refused', `${label}: ${JSON.stringify(d)}`);
    assert.equal(d.convert.reason, 'steps_not_signed', label);
    assert.equal(d.convert.step, null, `${label}: a refusal of the whole steps names no step`);
    assert.equal(d.schema, 'apply', `${label}: the schema half changed`);
    assert.match(d.convert.message, /sign/i, `${label}: the reason is not worded`);
  };

  it('a cast with no csig (stripped by an older relayer)', () => {
    refusedNotSigned(round({ signed: { withCsig: false } }), 'stripped');
  });

  it('a csig made by another key', () => {
    refusedNotSigned(round({ signed: { key: signing.generateInstanceKeypair() } }), 'another key');
  });

  it('a csig over other steps than the round carries (steps changed after the proposer signed)', () => {
    const changed = { steps: [{ ...STEPS.steps[0], to: 'label' }, STEPS.steps[1]] };
    refusedNotSigned(round({ convertRecords: changed, signed: { convertRecords: STEPS } }), 'changed');
  });

  it('steps added by a relayer to a round whose proposer chose none', () => {
    const r = round({ convertRecords: undefined });
    delete r.convertRecords;
    r.votes = [proposerCast(r)];
    r.convertRecords = STEPS;
    refusedNotSigned(r, 'added');
  });

  it('a convertRecords that is not one (nothing signed can be it)', () => {
    for (const bad of [null, 'steps', [], { steps: 'x' }, { steps: [{ op: 'nope' }] }]) {
      refusedNotSigned(round({ convertRecords: bad, signed: { convertRecords: undefined, withCsig: false } }), JSON.stringify(bad));
    }
  });

  it('a round whose proposer has no pinned key', () => {
    const d = governance.decideRoundConvertRecords({ id: NET, members: [{ instanceId: PROPOSER }] }, round(), PLAN);
    assert.equal(d.convert.state, 'refused');
    assert.equal(d.convert.reason, 'steps_not_signed');
    assert.equal(d.schema, 'apply');
  });
});

describe('signed steps that do not fit the round\'s own change are refused with the check\'s code and the schema is applied', () => {
  const refusedWith = (r, code, step, held) => {
    const d = decide(r, PLAN, held);
    assert.equal(d.convert.state, 'refused', JSON.stringify(d));
    assert.equal(d.convert.reason, code, JSON.stringify(d));
    assert.equal(d.convert.step, step, `the step named: ${JSON.stringify(d)}`);
    assert.equal(d.schema, 'apply', 'a refused step changed the schema half');
    assert.ok(typeof d.convert.message === 'string' && d.convert.message.length > 0);
    return d;
  };
  const signedSteps = (steps, over = {}) => round({ convertRecords: { steps }, ...over });

  it('a property the round\'s before did not declare', () => {
    refusedWith(signedSteps([STEPS.steps[1], { ...STEPS.steps[0], from: 'ghost' }]), 'property_not_declared_before', 1);
  });

  it('a property the round\'s after does not declare', () => {
    refusedWith(signedSteps([{ ...STEPS.steps[0], to: 'nickname' }]), 'property_not_declared_after', 0);
  });

  it('an enum value the round\'s after does not hold', () => {
    refusedWith(signedSteps([STEPS.steps[0], { ...STEPS.steps[1], values: { a: 'x', b: 'z' } }]), 'enum_value_not_in_after', 1);
  });

  it('an old name the round\'s after still declares (a rename must move a name out of the schema)', () => {
    const stillThere = { propertySchemas: { ...PERSON_AFTER.propertySchemas, fullName: string } };
    refusedWith(round({ pendingMeta: { typeSchemas: { entity: { Person: stillThere } } } }), 'property_still_declared', 0);
  });

  it('a type step whose target the round does not change', () => {
    const r = round({
      changedTypes: ['entity:Person'], metaBase: {}, pendingMeta: { typeSchemas: { entity: { Human: PERSON_AFTER } } },
      convertRecords: { steps: [{ op: 'renameType', kind: 'entity', from: 'Person', to: 'Human' }] },
    });
    refusedWith(r, 'step_target_not_in_round', 0, { before: { typeSchemas: { entity: { Person: PERSON_BEFORE } } } });
  });

  it('an old name this member\'s own definitions still declare once the round is applied (own and layer definitions union)', () => {
    const held = { after: { typeSchemas: { entity: { Person: { propertySchemas: { ...PERSON_AFTER.propertySchemas, fullName: string } } } } } };
    refusedWith(round(), 'property_still_declared_here', 0, held);
  });

  it('the member\'s own after that no longer declares the old name does not refuse', () => {
    const held = { after: { typeSchemas: { entity: { Person: PERSON_AFTER } } } };
    assert.equal(decide(round(), PLAN, held).convert.state, 'apply');
  });

  it('the first failing step is the one named, and the steps are not applied in part', () => {
    const d = refusedWith(signedSteps([
      { ...STEPS.steps[0], from: 'ghost' }, { ...STEPS.steps[1], values: { a: 'x', b: 'z' } },
    ]), 'property_not_declared_before', 0);
    assert.equal(d.convert.convertRecords, undefined, 'a refusal hands back no steps to apply');
  });
});

describe('the schema half is the plan\'s, whatever is said about the steps', () => {
  it('in every refused case the schema half is exactly what a round with no steps gives', () => {
    const plain = round({ convertRecords: undefined });
    delete plain.convertRecords;
    const baseline = decide(plain);
    const refused = [
      round({ signed: { withCsig: false } }),
      round({ convertRecords: { steps: [{ ...STEPS.steps[0], from: 'ghost' }] } }),
    ];
    for (const r of refused) {
      const d = decide(r);
      assert.equal(d.convert.state, 'refused');
      assert.equal(d.schema, baseline.schema);
    }
  });

  it('a schema this member cannot read refuses the round whole and starts nothing, valid steps or not', () => {
    const d = decide(round(), UNREADABLE);
    assert.deepEqual(d, { schema: 'refused', convert: { state: 'none' } });
  });

  it('the decision reads the round it was given and changes nothing in it', () => {
    const r = round();
    const before = structuredClone(r);
    decide(r, PLAN, { before: { typeSchemas: { entity: { Person: PERSON_BEFORE } } } });
    assert.deepEqual(r, before);
  });
});
