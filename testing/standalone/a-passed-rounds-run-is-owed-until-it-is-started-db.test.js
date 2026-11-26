/**
 * The conversion run a passed schema round owes this member is owed from the moment the round passes here: a crash at any point, or a start
 * that fails, ends with the run started exactly once, at the next boot or tick (`Q-746`, bundle-284 design r5 section 4.2; decision 12, an act
 * a vote passed is the instance's to finish).
 *
 * ## What it prevents
 *
 * The round was marked done here (`appliedHere`) when its conclusion was saved, and the run document was written after, in the background. A
 * process that died between the two writes, or a start the store refused, left the round marked done and no run: the steps the network voted
 * were never applied on this member, and nothing would ever try again. A start is now owed until its run document exists; the round is marked
 * done only once it does, and the boot resume and the watcher's tick start every round still owed. A start is never made twice: a run document
 * that already names the round settles it.
 *
 * ## What holds (the run module's start is wrapped to fail on cue; everything else is production's)
 *
 * - a crash before the run document (the start throws): the next boot resume starts the run, once;
 * - a start that fails twice and then succeeds, retried by the tick: one run, the round marked done;
 * - a crash after the run document and before the round is marked: the next boot resume marks the round and starts nothing more;
 * - a round already started is not started again by a boot or a tick.
 *
 * Run: node --test testing/standalone/a-passed-rounds-run-is-owed-until-it-is-started-db.test.js
 * (requires a prior server build and the test MongoDB)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';
import { tempInstanceDir } from './_vote-round-instance.mjs';
import { bootSchemaInstance } from './_schema-doors.mjs';
import { P1 } from './_vote-round-sites.mjs';
import { waitFor, waitForValue } from '../_shared/wait-for.mjs';

const dir = tempInstanceDir('ythril-owed-round-run-');
const skip = await mongoSkipReason();
const NET = '66666666-6666-4666-8666-666666666666';
const PROPOSER = P1;
const string = { type: 'string' };
const PERSON_BEFORE = { propertySchemas: { fullName: string } };
const PERSON_AFTER = { propertySchemas: { name: string } };
const STEPS = { steps: [{ op: 'renameProperty', kind: 'entity', type: 'Person', from: 'fullName', to: 'name' }] };
const SPACES = ['crash-before', 'fails-twice', 'crash-after', 'already'];

describe('a passed round\'s run is owed until it is started', { skip }, () => {
  let inst, mongo, signing, governance, roundLocal, run, spaceCollection, kp;
  /** What the wrapped start does on each call: `throw-before` (dies before the run document), `throw-after` (dies after it), `pass`. */
  let script = [];
  let calls = 0;
  let realStarts = 0;

  before(async () => {
    mongo = await openTestMongo('owed_round_run');
    inst = await bootSchemaInstance(dir, {
      spaces: [...SPACES.map(id => ({ id, label: id, folders: [], meta: {} })), { id: 'general', label: 'General', builtIn: true, folders: [] }],
    });
    signing = await import('../../server/dist/util/signing.js');
    governance = await import('../../server/dist/sync/governance.js');
    roundLocal = await import('../../server/dist/networks/round-local-state.js');
    run = await import('../../server/dist/spaces/schema-convert-run.js');
    ({ spaceCollection } = await import('../../server/dist/db/space-collection.js'));
    signing.ensureInstanceKeypair();
    kp = signing.generateInstanceKeypair();
    // A club, where the proposer's one yes passes the round (on pub/sub only the publisher's would, Q-968, and a member pushed to is a subscriber).
    inst.loader.getConfig().networks.push({
      id: NET, label: 'Net', type: 'club', origin: 'joined', syncSchedule: '', spaces: [...SPACES], votingDeadlineHours: 24,
      createdAt: '2026-01-01T00:00:00.000Z', pendingRounds: [],
      members: [{ instanceId: PROPOSER, label: 'proposer', url: 'http://127.0.0.1:1', tokenHash: 'h', direction: 'push', signingPublicKey: kp.publicKeyPem }],
    });
    // The run module's own functions, with the start wrapped to fail on cue.
    governance.useSchemaConvertRuns({
      async start(request) {
        const step = script[calls++] ?? 'pass';
        if (step === 'throw-before') throw new Error('injected: the process died before the run document was written');
        realStarts++;
        const out = await run.startSchemaConvertRun(request);
        if (step === 'throw-after') throw new Error('injected: the process died after the run document, before the round was marked');
        return out;
      },
      restart: run.restartSchemaConvertRun,
      typesToConvert: run.typesToConvert,
      status: run.schemaConvertStatus,
      wake: run.wakeSchemaConvertWatcher,
    });
  });
  after(async () => { run?.stopSchemaConvertWatcher(); inst?.close(); await closeTestMongo(); });

  beforeEach(() => { run.stopSchemaConvertWatcher(); script = []; calls = 0; realStarts = 0; });

  const net = () => inst.loader.getConfig().networks.find(n => n.id === NET);
  const runDoc = (space) => mongo.getDb().collection(spaceCollection(space, 'schemaConvertRun')).findOne({ _id: 'run' });
  const heldRound = (roundId) => net().pendingRounds.find(r => r.roundId === roundId);

  /** The proposer's signed rename round of Person in `space`, adopted here and concluded: it passes on the publisher's one yes. */
  function passRound(space) {
    const now = Date.now();
    const stored = roundLocal.adoptPeerRound(net(), {
      roundId: `round-${space}-${now}`, type: 'meta_change', subjectInstanceId: PROPOSER, subjectLabel: 'proposer', subjectUrl: '',
      openedAt: new Date(now).toISOString(), deadline: new Date(now + 86_400_000).toISOString(), votes: [],
      spaceId: space, changedTypes: ['entity:Person'], metaChangedFields: ['typeSchemas'], baseMetaVersion: 0,
      metaBase: { typeSchemas: { entity: { Person: PERSON_BEFORE } } }, pendingMeta: { typeSchemas: { entity: { Person: PERSON_AFTER } } },
      convertRecords: STEPS,
    });
    const base = { networkId: NET, roundId: stored.roundId, subjectInstanceId: PROPOSER, instanceId: PROPOSER, vote: 'yes' };
    stored.votes.push({
      instanceId: PROPOSER, vote: 'yes', castAt: new Date(now).toISOString(),
      sig: signing.signMessage(kp.privateKeyPem, signing.voteCastMessage(base)),
      bsig: signing.signMessage(kp.privateKeyPem, signing.voteCastBoundMessage({ ...base, round: stored })),
      csig: signing.signMessage(kp.privateKeyPem, signing.convertRecordsCastMessage({ ...base, round: stored, convertRecords: STEPS })),
    });
    assert.equal(governance.concludeRoundIfReady(net(), stored), true, 'precondition: the round passes');
    return stored;
  }
  /** Wait until the wrapped start has been called `n` times and the start it made has settled. */
  async function attempts(n, roundId) {
    await waitFor(() => calls >= n, 5_000, 20, () => `the start was called ${calls} times, not ${n}`);
    await waitFor(() => governance.roundConvertStartOf(roundId) === undefined, 5_000, 20, () => `the start of ${roundId} has not settled`);
  }
  /** Until the round is marked done here or `what` times out. */
  const settled = (roundId, what) => waitFor(() => heldRound(roundId)?.appliedHere === true, 5_000, 20, () => `${what}: the round is not marked done`);

  it('a crash before the run document: the next boot resume starts the run, once', async () => {
    script = ['throw-before'];
    const round = passRound('crash-before');
    await attempts(1, round.roundId);
    assert.equal(await runDoc('crash-before'), null, 'precondition: the injected crash left no run document');
    await run.resumeSchemaConvertRuns();
    const doc = await waitForValue(() => runDoc('crash-before'), 5_000, 20, undefined, { what: 'the run the boot resume owes' });
    await settled(round.roundId, 'after the boot resume');
    assert.deepEqual(doc.sources.map(s => s.roundId), [round.roundId]);
    assert.equal(doc.generation, 1);
    assert.equal(realStarts, 1, 'the run was started more than once');
  });

  it('a start that fails twice and then succeeds, retried by the tick: one run', async () => {
    script = ['throw-before', 'throw-before'];
    const round = passRound('fails-twice');
    await attempts(1, round.roundId);
    await run.schemaConvertRunTick();
    await attempts(2, round.roundId);
    assert.equal(await runDoc('fails-twice'), null);
    await run.schemaConvertRunTick();
    const doc = await waitForValue(() => runDoc('fails-twice'), 5_000, 20, undefined, { what: 'the run the third try starts' });
    await settled(round.roundId, 'after the third try');
    await run.schemaConvertRunTick();
    assert.equal((await runDoc('fails-twice')).generation, doc.generation, 'a tick after the success started the run again');
    assert.equal(realStarts, 1);
    assert.deepEqual(doc.sources.map(s => s.roundId), [round.roundId]);
  });

  it('a crash after the run document, before the round is marked: the boot resume marks it and starts nothing more', async () => {
    script = ['throw-after'];
    const round = passRound('crash-after');
    await attempts(1, round.roundId);
    const first = await waitForValue(() => runDoc('crash-after'), 5_000, 20, undefined, { what: 'the run document written before the crash' });
    // The crash: the round's mark is lost with the process (whatever this process had marked in memory).
    delete heldRound(round.roundId).appliedHere;
    await run.resumeSchemaConvertRuns();
    await settled(round.roundId, 'after the boot resume');
    assert.equal(realStarts, 1, 'the boot resume started a second run for a round whose run already existed');
    assert.equal((await runDoc('crash-after')).generation, first.generation);
  });

  it('a round already started is not started again by a boot or a tick', async () => {
    const round = passRound('already');
    await attempts(1, round.roundId);
    await settled(round.roundId, 'after the start');
    const first = await waitForValue(() => runDoc('already'), 5_000, 20, undefined, { what: 'the run' });
    await run.resumeSchemaConvertRuns();
    await run.schemaConvertRunTick();
    assert.equal(calls, 1, 'a boot or a tick asked for a second start');
    assert.equal((await runDoc('already')).generation, first.generation);
  });
});
