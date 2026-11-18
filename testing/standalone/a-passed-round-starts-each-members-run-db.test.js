/**
 * A passed `meta_change` round that carries `convertRecords` starts the conversion run on the member that concludes it, once (`Q-745`, `Q-746`,
 * bundle-284 design r5 sections 3, 4.1 and 4.2).
 *
 * ## What it prevents
 *
 * The choice made with a networked schema change travels with its round so that every member decides for itself what to do with the records
 * it holds (O5). Slice 5a decided it (`decideRoundConvertRecords`) and started nothing, so a passed round changed the schema on every member and
 * converted no record anywhere. Each decision has its own consequence, and each one a wrong line breaks for the whole network:
 *
 * - `apply`: the run starts with the round's steps, source kind `round` with the round's id, and is OWED (a passed vote's run is never given
 *   up, as a passed deletion's act is not);
 * - `refused` (owner: "Schema yes, steps no"): the schema lands and the run starts with NO steps and `stepsRefused` saying why, so the copies
 *   that conform are stamped and the rest reach Review; this member rewrites nothing, so it cannot undo another member's conversion;
 * - `none`: the round carried no steps, and nothing starts;
 * - a round concluded a second time (a re-delivery, a second settle) starts no second run: one run per round per member.
 *
 * The round machinery is driven in-process: the round is the proposer's (another member), adopted here with the proposer's signed yes, and
 * concluded by the one conclusion function on a pub/sub network, where one yes passes it.
 *
 * Run: node --test testing/standalone/a-passed-round-starts-each-members-run-db.test.js
 * (requires a prior server build and the test MongoDB)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';
import { tempInstanceDir } from './_vote-round-instance.mjs';
import { bootSchemaInstance } from './_schema-doors.mjs';
import { P1 } from './_vote-round-sites.mjs';
import { waitForValue } from '../_shared/wait-for.mjs';

const dir = tempInstanceDir('ythril-round-starts-run-');
const skip = await mongoSkipReason();
const NET = '33333333-3333-4333-8333-333333333333';
const PROPOSER = P1;
const string = { type: 'string' };

const PERSON_BEFORE = { propertySchemas: { fullName: string, status: { type: 'string', enum: ['a', 'b'] } } };
const PERSON_AFTER = { propertySchemas: { name: string, status: { type: 'string', enum: ['x', 'y'] } } };
const STEPS = {
  steps: [
    { op: 'renameProperty', kind: 'entity', type: 'Person', from: 'fullName', to: 'name' },
    { op: 'mapEnum', kind: 'entity', type: 'Person', property: 'status', values: { a: 'x', b: 'y' } },
  ],
};
/** One space per case, so each case reads a run document of its own. */
const SPACES = ['apply', 'refused', 'none', 'twice'];

describe('a passed round starts each member\'s run', { skip }, () => {
  let inst, mongo, signing, governance, roundLocal, run, spaceCollection, kp;
  before(async () => {
    mongo = await openTestMongo('round_starts_run');
    // This member holds no definition of Person of its own: the network's layer brings it, so its effective schema once the round lands no
    // longer declares the renamed property (a member whose own definitions still did would refuse the steps, which the refused case covers by
    // an unsigned round instead).
    inst = await bootSchemaInstance(dir, {
      spaces: [
        ...SPACES.map(id => ({ id, label: id, folders: [], meta: {} })),
        { id: 'general', label: 'General', builtIn: true, folders: [] },
      ],
    });
    signing = await import('../../server/dist/util/signing.js');
    governance = await import('../../server/dist/sync/governance.js');
    roundLocal = await import('../../server/dist/networks/round-local-state.js');
    run = await import('../../server/dist/spaces/schema-convert-run.js');
    ({ spaceCollection } = await import('../../server/dist/db/space-collection.js'));
    signing.ensureInstanceKeypair();
    kp = signing.generateInstanceKeypair();
    // Pub/sub, where the publisher's one yes passes a schema round; the proposer is a member this instance pushes to and never pulls from, so
    // a run's first sync asks no peer (nothing here dials out).
    inst.loader.getConfig().networks.push({
      id: NET, label: 'Net', type: 'pubsub', origin: 'joined', syncSchedule: '', spaces: [...SPACES], votingDeadlineHours: 24,
      createdAt: '2026-01-01T00:00:00.000Z', pendingRounds: [],
      members: [{ instanceId: PROPOSER, label: 'proposer', url: 'http://127.0.0.1:1', tokenHash: 'h', direction: 'push', signingPublicKey: kp.publicKeyPem }],
    });
  });
  after(async () => { run?.stopSchemaConvertWatcher(); inst?.close(); await closeTestMongo(); });

  const net = () => inst.loader.getConfig().networks.find(n => n.id === NET);
  const runDoc = (space) => mongo.getDb().collection(spaceCollection(space, 'schemaConvertRun')).findOne({ _id: 'run' });
  const settled = () => new Promise(r => setTimeout(r, 500));

  /** The proposer's signed yes on `round`: `sig`, `bsig`, and `csig` over the steps unless `withCsig` is false. */
  function proposerCast(round, withCsig) {
    const base = { networkId: NET, roundId: round.roundId, subjectInstanceId: PROPOSER, instanceId: PROPOSER, vote: 'yes' };
    return {
      instanceId: PROPOSER, vote: 'yes', castAt: new Date().toISOString(),
      sig: signing.signMessage(kp.privateKeyPem, signing.voteCastMessage(base)),
      bsig: signing.signMessage(kp.privateKeyPem, signing.voteCastBoundMessage({ ...base, round })),
      ...(withCsig && round.convertRecords !== undefined
        ? { csig: signing.signMessage(kp.privateKeyPem, signing.convertRecordsCastMessage({ ...base, round, convertRecords: round.convertRecords })) } : {}),
    };
  }

  /** The proposer's rename-and-map round of Person in `space`, adopted here with its signed yes, open until tomorrow. */
  function adoptRound(space, { convertRecords = STEPS, withCsig = true } = {}) {
    const now = Date.now();
    const served = {
      roundId: `round-${space}-${now}`, type: 'meta_change', subjectInstanceId: PROPOSER, subjectLabel: 'proposer', subjectUrl: '',
      openedAt: new Date(now).toISOString(), deadline: new Date(now + 86_400_000).toISOString(), votes: [],
      spaceId: space, changedTypes: ['entity:Person'], metaChangedFields: ['typeSchemas'], baseMetaVersion: 0,
      metaBase: { typeSchemas: { entity: { Person: PERSON_BEFORE } } },
      pendingMeta: { typeSchemas: { entity: { Person: PERSON_AFTER } } },
      ...(convertRecords !== undefined ? { convertRecords } : {}),
    };
    const stored = roundLocal.adoptPeerRound(net(), served);
    stored.votes.push(proposerCast(stored, withCsig));
    return stored;
  }

  it('decision apply: the run starts with the round\'s steps, source kind round with the round\'s id, and is owed', async () => {
    const round = adoptRound('apply');
    assert.equal(governance.concludeRoundIfReady(net(), round), true, 'precondition: the proposer\'s yes passes the round');
    assert.ok(inst.heldTypes('apply').entity?.Person?.propertySchemas?.name, 'precondition: the schema half landed');
    const doc = await waitForValue(() => runDoc('apply'), 5_000, 50, undefined, { what: 'the run the passed round starts' });
    assert.deepEqual(doc.steps, STEPS.steps);
    assert.deepEqual(doc.stepsRefused, []);
    assert.deepEqual(doc.sources.map(s => ({ kind: s.kind, roundId: s.roundId })), [{ kind: 'round', roundId: round.roundId }]);
    assert.equal(doc.owed, true, 'a round-started run is not owed');
    assert.deepEqual(doc.types.map(t => `${t.kind}:${t.type}`), ['entity:Person']);
  });

  it('decision refused (unsigned steps): the schema lands and the run starts with no steps and stepsRefused naming why', async () => {
    const round = adoptRound('refused', { withCsig: false });
    assert.equal(governance.concludeRoundIfReady(net(), round), true);
    assert.ok(inst.heldTypes('refused').entity?.Person?.propertySchemas?.name, 'a refused step refused the schema');
    const doc = await waitForValue(() => runDoc('refused'), 5_000, 50, undefined, { what: 'the run of the refused steps' });
    assert.deepEqual(doc.steps, [], 'a member that refused the steps applies them anyway');
    assert.ok(doc.stepsRefused.length >= 1, `the run does not say the steps were refused: ${JSON.stringify(doc)}`);
    assert.ok(doc.stepsRefused.some(r => r.reason === 'steps_not_signed'), JSON.stringify(doc.stepsRefused));
    assert.deepEqual(doc.sources.map(s => s.kind), ['round']);
    assert.equal(doc.owed, true);
    assert.deepEqual(doc.types.map(t => `${t.kind}:${t.type}`), ['entity:Person'], 'the changed type is not stamped and listed');
  });

  it('decision none: a round that carried no steps starts nothing', async () => {
    const round = adoptRound('none', { convertRecords: undefined });
    assert.equal(governance.concludeRoundIfReady(net(), round), true);
    assert.ok(inst.heldTypes('none').entity?.Person, 'precondition: the schema half landed');
    await settled();
    assert.equal(await runDoc('none'), null, 'a round with no convertRecords started a run');
  });

  it('a round concluded twice starts one run', async () => {
    const round = adoptRound('twice');
    assert.equal(governance.concludeRoundIfReady(net(), round), true);
    const first = await waitForValue(() => runDoc('twice'), 5_000, 50, undefined, { what: 'the first run' });
    governance.concludeRoundIfReady(net(), round);
    await settled();
    const doc = await runDoc('twice');
    assert.equal(doc.generation, first.generation, `the second conclusion started or restarted the run: ${JSON.stringify(doc.sources)}`);
    assert.deepEqual(doc.sources.map(s => s.roundId), [round.roundId]);
  });
});
