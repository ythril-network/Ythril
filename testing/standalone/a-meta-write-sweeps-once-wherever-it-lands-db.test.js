/**
 * Every write of a space's meta sweeps what it suppresses, and writes that land together sweep ONCE, against the
 * meta the last of them wrote (Q-361 item 11; main's bundle-30 stage I5).
 *
 * ## The two defects this holds closed
 *
 *  - **A meta change applied by a vote swept twice or more.** `spaces/meta-update.ts` swept after a round passed on
 *    the proposer's own vote, and the conclusion had already swept: it writes through `commitOwnMetaEdit` and
 *    `storeNetworkLayer`, both of which end in `recomputeEffectiveMeta`, which swept. A proposer holding a layer ran
 *    the recompute twice, so three sweeps of one change — each a pass over every collection of the space.
 *  - **A schema edit on a space no network carries swept nothing.** `PUT /schema`, the per-type upsert and delete,
 *    and the schema library's apply write through `commitOwnMetaEdit`, whose plain branch (no layer yet, so no
 *    `ownMeta`) was an `updateSpace` and nothing else. A type schema turning `suppressEmbeddings` on left every
 *    stored vector of that type in place, while the same edit on a layered space swept: one write, two outcomes,
 *    decided by whether a network had ever sent the space a layer.
 *
 * ## The rule, and where it lives
 *
 * `updateSpace` is the one writer of `space.meta` (`a-meta-write-goes-through-the-own-definitions` holds every
 * other meta write to it), so the sweep is asked for THERE, and nowhere else — after EVERY effective-meta write, not
 * on a transition (a vector stranded before the flag was set is repaired by the next write of any kind) — and it
 * coalesces per space: the sweep starts once the writes of this turn have landed, against the latest meta, and a write during
 * a running sweep queues one more.
 *
 * ## How "once" is seen
 *
 * A RUN of the sweep reads every collection of the space, whether or not it finds anything to remove. This test
 * seeds nothing into the chrono collection, so each run issues exactly one `find` on it and no write: counting those
 * finds counts runs, and a redundant second run that found nothing is as visible as one that removed something. A run
 * that removes vectors also issues one `update` on each collection it found them in; both are counted from the driver's
 * command stream, which the polling below (reads of the facts collection only) does not add to.
 *
 * **The window is closed by the sweep, not by a pause.** A negative assertion ("no second run") needs the runs to have
 * stopped, and a fixed sleep proves only that a slow one had not started yet. So after the change under test the case
 * writes a SETTLING meta and waits for its own effect: a stranded vector on a flagged FILE, the last kind a run sweeps.
 * Runs of one space are serial, so by the time that vector is gone every run the change asked for has read every
 * collection. The settling write is itself one run, which the count states.
 *
 * ## Where a meta write lands
 *
 * The operator's edit, a schema edit on a space no network carries, the two writes a passed vote makes on a proposer
 * that holds a layer (its own definitions, then the layer), and a precedence change between two layers (a recompute
 * that flips what is suppressed). All of them end in `updateSpace`; the cases below are the ones that reach it by a
 * different road.
 *
 * ## Seen red
 *
 * On 6eb5a333 (5.6.3): `updateSpace` sweeps nothing, so every case times out with the vectors in place. On this tree,
 * by hand: a rerun that sweeps the meta it already swept (the delete of `nextSweep`'s entry dropped), a run that starts
 * before the turn's writes have landed, and a recompute that sets `space.meta` without `updateSpace`.
 *
 * Run: node --test testing/standalone/a-meta-write-sweeps-once-wherever-it-lands-db.test.js
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openPushDoor } from './_push-door.mjs';
import { eventually } from './_write-faults.mjs';

const skip = await mongoSkipReason();
/** A space no network carries. */
const S = 'metasweep';
/** A space two networks carry, for the writes that arrive as layers. */
const L = 'metalayer';
const N1 = 'metasweep-net-1';
const N2 = 'metasweep-net-2';
const network = (id) => ({ id, label: id, type: 'closed', spaces: [L], members: [], votes: [], votingDeadlineHours: 24 });

let door, spaces, effective, layerActs, config, RECORD_SUPPRESS_FIELD;

const VECTOR = { embedding: [0.1, 0.2, 0.3], embeddingModel: 'test-model' };
const fact = (_id, type, space = S) => ({ _id, spaceId: space, type, fact: `fact ${_id}`, tags: [], seq: 1, ...VECTOR });
const suppressing = (...types) => ({
  typeSchemas: { fact: Object.fromEntries(types.map(t => [t, { suppressEmbeddings: true }])) },
});
/** A layer stating each fact type's own `suppressEmbeddings`: `{ Z: false, B: true }`. */
const stating = (states) => ({
  typeSchemas: { fact: Object.fromEntries(Object.entries(states).map(([t, v]) => [t, { suppressEmbeddings: v }])) },
});
const hasVector = async (id, space = S) => (await door.coll(space, 'facts').findOne({ _id: id }))?.embedding !== undefined;

/** How long a sweep may take to land — it is not awaited by the write, by design. */
const SWEEP_DEADLINE_MS = 10_000;
/** Until `check` holds, or fail naming `what` (`_write-faults.mjs` polls). */
const until = async (check, what) => assert.ok(await eventually(check, SWEEP_DEADLINE_MS, 50), `${what} within ${SWEEP_DEADLINE_MS} ms`);

/**
 * Every run the sweep has made for `space` has finished reading, and the sweep is idle.
 *
 * A write of the space's meta (unchanged) asks for one more run; the run clears the vector of a FILE that carries its
 * own flag, the last kind a run sweeps, and the helper waits for that. Runs of one space are serial, so what ran before
 * this one has already read every collection. It is ONE run of its own, which a caller counting runs subtracts.
 */
let settlingRows = 0;
async function sweepsSettled(space) {
  const id = `settling-${++settlingRows}`;
  await door.coll(space, 'files').insertOne({ _id: id, spaceId: space, path: id, tags: [], seq: 1, [RECORD_SUPPRESS_FIELD]: true, ...VECTOR });
  spaces.updateSpace(space, { meta: { ...config.getConfig().spaces.find(s => s.id === space).meta } });
  await until(async () => (await door.coll(space, 'files').findOne({ _id: id }))?.embedding === undefined,
    'the settling sweep did not remove the flagged file\'s vector');
}

/**
 * How many times the sweep ran for `space` while `change` and what it set off played out. Counted from the reads of
 * the chrono collection, which this test never seeds: a run reads it once and writes nothing there, so a run that found
 * nothing is counted as surely as one that removed vectors. The settling run's own read is taken off.
 */
async function sweepRunsDuring(space, change) {
  const commands = await door.commandsDuring(async () => {
    await change();
    await sweepsSettled(space);
  });
  const reads = commands.filter(c => c === `find ${space}_chrono`).length;
  return { commands, runs: reads - 1 };
}

/** The layered space back to no layer, no own definitions, no ranking and no meta — config only, as the recompute reads it. */
function resetLayered() {
  const cfg = config.getConfig();
  for (const n of cfg.networks) delete n.schemaLayers;
  const space = cfg.spaces.find(s => s.id === L);
  space.ownMeta = undefined;
  space.networkPrecedence = undefined;
  spaces.updateSpace(L, { meta: {} });
}

describe('a meta write sweeps once, wherever it lands', { skip }, () => {
  before(async () => {
    door = await openPushDoor({
      suite: 'metasweep', monitorCommands: true,
      spaces: [{ id: S, label: 'Meta sweep', folders: [], meta: {} }, { id: L, label: 'Meta layers', folders: [], meta: {} }],
      networks: [network(N1), network(N2)],
    });
    spaces = await import('../../server/dist/spaces/spaces.js');
    effective = await import('../../server/dist/spaces/effective-meta.js');
    layerActs = await import('../../server/dist/spaces/schema-layers-acts.js');
    config = await import('../../server/dist/config/loader.js');
    ({ RECORD_SUPPRESS_FIELD } = await import('../../server/dist/brain/record-flag.js'));
  });
  after(async () => { await door?.close(); });
  beforeEach(async () => {
    await door.wipe(S);
    await door.wipe(L);
    spaces.updateSpace(S, { meta: {} });
    resetLayered();
    await sweepsSettled(S);
    await sweepsSettled(L);
  });

  it('two meta writes in one turn sweep once, against the later meta', async () => {
    await door.coll(S, 'facts').insertMany([fact('fa', 'A'), fact('fb', 'B')]);
    const { commands, runs } = await sweepRunsDuring(S, async () => {
      spaces.updateSpace(S, { meta: suppressing('A') });
      spaces.updateSpace(S, { meta: suppressing('A', 'B') });
      await until(async () => !(await hasVector('fa')) && !(await hasVector('fb')),
        'the sweep did not remove both vectors');
    });
    assert.equal(runs, 1, `one change ran the sweep ${runs} times — every run is a pass over every collection of the space`);
    const updates = commands.filter(c => c === `update ${S}_facts`);
    assert.equal(updates.length, 1, `the later meta was swept in ${updates.length} writes of the facts, not one`);
  });

  it('a write that changes nothing about suppression still sweeps what is stranded (every write, not a transition)', async () => {
    spaces.updateSpace(S, { meta: suppressing('E') });
    await sweepsSettled(S);
    // A vector stored after the flag was set (or before this version swept): nothing but the next meta write finds it.
    await door.coll(S, 'facts').insertOne(fact('fe', 'E'));
    spaces.updateSpace(S, { meta: suppressing('E') });
    await until(async () => !(await hasVector('fe')), 'a meta write that left suppression as it was did not sweep a stranded vector');
  });

  it('a schema edit on a space no network carries sweeps what it suppresses, once', async () => {
    await door.coll(S, 'facts').insertMany([fact('fc', 'C'), fact('fd', 'D')]);
    const { runs } = await sweepRunsDuring(S, async () => {
      assert.equal(effective.commitOwnMetaEdit(S, base => effective.withType(base, 'fact', 'C', { suppressEmbeddings: true }))?.id, S);
      await until(async () => !(await hasVector('fc')), 'a type schema turned suppression on and its stored vector stayed');
    });
    assert.equal(await hasVector('fd'), true, 'a type the edit did not suppress lost its vector');
    assert.equal(runs, 1, `one schema edit ran the sweep ${runs} times`);
  });

  it('the two writes of a passed vote on a proposer that holds a layer sweep once', async () => {
    // The proposer holds a layer, so its own definitions are set apart; applying a round is its own edit and then the
    // network's layer, each of which recomputes the effective meta (`sync/governance.ts`).
    effective.storeNetworkLayer(N1, L, stating({ Z: false }));
    assert.ok(config.getConfig().spaces.find(s => s.id === L).ownMeta, 'fixture check: the first layer did not set the space\'s own definitions apart');
    await sweepsSettled(L);
    await door.coll(L, 'facts').insertMany([fact('la', 'A', L), fact('lb', 'B', L), fact('lz', 'Z', L)]);
    const { runs } = await sweepRunsDuring(L, async () => {
      effective.commitOwnMetaEdit(L, base => effective.withType(base, 'fact', 'A', { suppressEmbeddings: true }));
      effective.storeNetworkLayer(N1, L, stating({ Z: false, B: true }));
      await until(async () => !(await hasVector('la', L)) && !(await hasVector('lb', L)),
        'the vote\'s own edit and its layer were not both swept');
    });
    assert.equal(await hasVector('lz', L), true, 'a type the layer states false lost its vector');
    assert.equal(runs, 1, `one vote's two writes ran the sweep ${runs} times`);
  });

  it('a precedence change between two layers that flips what is suppressed sweeps it', async () => {
    // Both layers state the type; the network first in line wins, so N1's `false` holds until the ranking changes.
    effective.storeNetworkLayer(N1, L, stating({ T: false }));
    effective.storeNetworkLayer(N2, L, stating({ T: true }));
    assert.equal(config.getConfig().spaces.find(s => s.id === L).meta.typeSchemas.fact.T.suppressEmbeddings, false,
      'fixture check: the network joined first did not win the clash');
    await sweepsSettled(L);
    await door.coll(L, 'facts').insertOne(fact('lt', 'T', L));
    const { runs } = await sweepRunsDuring(L, async () => {
      assert.equal(layerActs.setNetworkPrecedenceAct(L, { networks: [N2, N1] }).status, 200);
      await until(async () => !(await hasVector('lt', L)), 'a ranking that makes the type suppressed left its stored vector');
    });
    assert.equal(runs, 1, `one precedence change ran the sweep ${runs} times`);
  });
});
