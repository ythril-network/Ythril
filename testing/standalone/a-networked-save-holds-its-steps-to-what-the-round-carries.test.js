/**
 * A networked schema save holds its conversion steps to the same pair of schemas the round carries and every member checks them against, and the
 * round carries every type a type step moves records out of (`Q-745`, bundle-284 fix round after the lens sweep: B1, S2, S3).
 *
 * ## What it prevents
 *
 * - **B1: a type step refused on every member but the proposer.** The round's before-schema (`metaBase`) held only the types the edit changed, so
 *   the source of a `renameType` or `splitType` (a type the edit leaves alone) was in it only where the member happened to hold that type itself.
 *   A member that joined later holds none of the proposer's own definitions, so it refused the step (`type_not_declared_before`) and converted
 *   nothing. The round now carries each type step's source definition.
 * - **S2: a rename of a shared type refused at the save.** The save held the steps to the layers as they are, though the round replaces the type
 *   in each network's layer on the proposer too when it passes; a property the vote removes from the layer read as still declared.
 * - **S3: steps accepted at the save and refused by every member.** The members check what the round carries (after = the proposal) and that each
 *   type step moves records into a type the round changes; the save did not, so a split into a type the save did not send was answered "started"
 *   and then refused everywhere, the proposer included.
 *
 * One check (`roundStepIssue`), one pair of schemas (the round's own carried before and after, and what the instance holds), used by the save, the
 * round and the member.
 *
 * Run: node --test testing/standalone/a-networked-save-holds-its-steps-to-what-the-round-carries.test.js  (requires a prior server build)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tempInstanceDir } from './_vote-round-instance.mjs';
import { bootSchemaInstance } from './_schema-doors.mjs';
import { P1 } from './_vote-round-sites.mjs';

const dir = tempInstanceDir('ythril-networked-steps-');
const SPACE = 'people';
const NET = '77777777-7777-4777-8777-777777777777';
const string = { type: 'string' };
const number = { type: 'number' };
const PERSON = { propertySchemas: { fullName: string, age: number } };
const ADULT = { propertySchemas: { fullName: string, age: number } };
const OWN = { typeSchemas: { entity: { Person: PERSON, Adult: ADULT } } };

describe('a networked save holds its steps to what the round carries', () => {
  let inst, meta, governance, signing, kp;
  before(async () => {
    inst = await bootSchemaInstance(dir, {
      spaces: [{ id: SPACE, label: 'People', folders: [], meta: structuredClone(OWN) }, { id: 'general', label: 'General', builtIn: true, folders: [] }],
    });
    meta = await import('../../server/dist/spaces/meta-update.js');
    governance = await import('../../server/dist/sync/governance.js');
    signing = await import('../../server/dist/util/signing.js');
    kp = signing.generateInstanceKeypair();
  });
  after(() => { inst?.close(); });

  /** Put this space in one closed network; `layer` is the network's layer of the space this instance holds (the effective meta laid over it). */
  function networked(layer) {
    inst.reset();
    const cfg = inst.loader.getConfig();
    cfg.networks.splice(0, cfg.networks.length, {
      id: NET, label: 'Net', type: 'closed', origin: 'joined', syncSchedule: '', spaces: [SPACE], votingDeadlineHours: 24,
      createdAt: '2026-01-01T00:00:00.000Z', pendingRounds: [],
      members: [{ instanceId: P1, label: 'peer', url: 'https://peer.example', tokenHash: 'h', direction: 'both', signingPublicKey: kp.publicKeyPem }],
      ...(layer ? { schemaLayers: { [SPACE]: layer } } : {}),
    });
    if (layer) {
      const space = cfg.spaces.find(s => s.id === SPACE);
      space.ownMeta = structuredClone(OWN);
      space.meta = { ...structuredClone(OWN), typeSchemas: { entity: { ...OWN.typeSchemas.entity, Person: {
        propertySchemas: { ...PERSON.propertySchemas, ...layer.typeSchemas.entity.Person.propertySchemas },
      } } } };
    }
  }
  const plan = (body) => meta.planSpaceMetaUpdate({ spaceId: SPACE, space: inst.loader.getConfig().spaces.find(s => s.id === SPACE), body, ifMatch: undefined });

  /** The round a member would receive from this plan: what the open path puts on it, with the proposer's cast signing the steps. */
  function roundOf(p) {
    const round = {
      roundId: 'round-b1', type: 'meta_change', subjectInstanceId: P1, subjectLabel: 'peer', subjectUrl: '',
      openedAt: '2026-11-18T10:00:00.000Z', deadline: '2099-01-01T00:00:00.000Z', votes: [], spaceId: SPACE,
      pendingMeta: p.proposal, metaBase: p.metaBase, changedTypes: p.changedTypes, metaChangedFields: ['typeSchemas'], baseMetaVersion: 0,
      convertRecords: p.convertRecords,
    };
    const base = { networkId: NET, roundId: round.roundId, subjectInstanceId: P1, instanceId: P1, vote: 'yes' };
    round.votes.push({
      instanceId: P1, vote: 'yes', castAt: round.openedAt,
      sig: signing.signMessage(kp.privateKeyPem, signing.voteCastMessage(base)),
      bsig: signing.signMessage(kp.privateKeyPem, signing.voteCastBoundMessage({ ...base, round })),
      csig: signing.signMessage(kp.privateKeyPem, signing.convertRecordsCastMessage({ ...base, round, convertRecords: round.convertRecords })),
    });
    return round;
  }
  const NET_VIEW = () => ({ id: NET, members: [{ instanceId: P1, signingPublicKey: kp.publicKeyPem }] });
  const READABLE = Object.freeze({ ok: true, localSpace: SPACE, ownEdit: false, conflicts: [], unknownFields: [] });

  describe('B1: the round carries the source of every type step', () => {
    for (const [name, steps, sent] of [
      ['renameType', [{ op: 'renameType', kind: 'entity', from: 'Person', to: 'Human' }], { Human: PERSON }],
      ['splitType', [{ op: 'splitType', kind: 'entity', from: 'Person', cases: [{ when: 'self.properties.age > 17', to: 'Grown' }], otherwise: 'Young' }],
        { Grown: PERSON, Young: PERSON }],
    ]) {
      it(`${name}: the save is accepted, its round carries the source type, and a member that holds no definition of it applies the step`, () => {
        networked();
        const d = plan({ meta: { typeSchemas: { entity: sent } }, convertRecords: { steps } });
        assert.equal(d.ok, true, JSON.stringify(d.refusal));
        assert.ok(d.plan.metaBase?.typeSchemas?.entity?.Person, `the round's before-schema does not carry the source type: ${JSON.stringify(d.plan.metaBase)}`);
        const decision = governance.decideRoundConvertRecords(NET_VIEW(), roundOf(d.plan), READABLE, {});
        assert.deepEqual(decision.convert.state, 'apply', `a member that holds no definition of the source refused the step: ${JSON.stringify(decision)}`);
      });
    }

    it('a save with no type step carries only the types it changed, as before', () => {
      networked();
      const d = plan({ meta: { typeSchemas: { entity: { Human: PERSON } } } });
      assert.equal(d.ok, true);
      assert.deepEqual(Object.keys(d.plan.metaBase.typeSchemas.entity), ['Human']);
    });
  });

  describe('S2: a rename of a property the network\'s layer declares is held to the layer as the round leaves it', () => {
    it('a plain save that drops fullName from a type the layer declares, with the rename, is accepted', () => {
      networked({ typeSchemas: { entity: { Person: { propertySchemas: { fullName: string } } } } });
      const d = plan({
        meta: { typeSchemas: { entity: { Person: { propertySchemas: { name: string, age: number } } } } },
        convertRecords: { steps: [{ op: 'renameProperty', kind: 'entity', type: 'Person', from: 'fullName', to: 'name' }] },
      });
      assert.equal(d.ok, true, `the rename was refused at the save: ${JSON.stringify(d.refusal)}`);
    });
  });

  describe('S3: steps every member would refuse are refused at the save', () => {
    it('a networked split into an existing type the save does not send answers 400 bad_conversion_step', () => {
      networked();
      const d = plan({
        meta: { typeSchemas: { entity: { Young: PERSON } } },
        convertRecords: { steps: [{ op: 'splitType', kind: 'entity', from: 'Person', cases: [{ when: 'self.properties.age > 17', to: 'Adult' }], otherwise: 'Young' }] },
      });
      assert.equal(d.ok, false, 'a split into a type the round does not change was accepted at the save');
      assert.equal(d.refusal.status, 400);
      assert.equal(d.refusal.body.code, 'bad_conversion_step', JSON.stringify(d.refusal.body));
      assert.equal(d.refusal.body.step, 0);
    });

    it('a solo save of the same split is still accepted: a space in no network has no round to hold it to', () => {
      inst.reset();
      inst.loader.getConfig().networks.splice(0);
      const d = plan({
        meta: { typeSchemas: { entity: { Young: PERSON } } },
        convertRecords: { steps: [{ op: 'splitType', kind: 'entity', from: 'Person', cases: [{ when: 'self.properties.age > 17', to: 'Adult' }], otherwise: 'Young' }] },
      });
      assert.equal(d.ok, true, JSON.stringify(d.refusal));
    });
  });
});
