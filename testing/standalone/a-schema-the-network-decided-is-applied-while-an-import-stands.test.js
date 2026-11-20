/**
 * A schema change the network decided is applied on a member while an RDF import stands on the space, and a round whose apply throws is
 * never left concluded and unapplied (bundle-270, second review F3, with F2's decision).
 *
 * ## What it prevents
 *
 * The import's schema-write gate (`spaces/schema-write-gate.ts`) refuses every schema write to a space an RDF import stands on. It stood on
 * the stores' own writers, so it refused what a caller starts at a door (the space PATCH, `schema_update`, the per-type routes, the library)
 * and, with them, what the NETWORK decided and this member only applies: a passed `meta_change` round, a layer arriving by sync, a space
 * leaving a network. A passed round set `concluded` first and applied after, so the throw left the round concluded and unapplied, and every
 * later settle skips a concluded round: the member held a schema other than its network's for good, with nothing to show it. An arriving
 * layer was stored before the recompute threw, so the next pull found the layer equal and never recomputed. F2 makes it safe to apply: the
 * import commits against the schema it was planned with, so a schema arriving meanwhile governs the writes after it.
 *
 * ## What holds
 *
 * - Every caller of the gate, by kind (the table the fix was made from):
 *
 *   | caller                                                               | reaches the gate by                | kind              |
 *   |----------------------------------------------------------------------|------------------------------------|-------------------|
 *   | space PATCH, MCP `schema_update` (`meta-update.ts`)                  | `assertSchemaWritable`             | a door            |
 *   | the per-type routes, the library's save (`api/spaces.ts`, `schema-library.ts`) | `commitOwnMetaEdit`      | a door            |
 *   | `setNetworkPrecedenceAct` (an operator's reorder)                    | `assertSchemaWritable`, before its first write | a door |
 *   | a passed `meta_change` round, the proposer's own edit (`governance.ts`) | `commitOwnMetaEdit`             | the network's     |
 *   | a passed `meta_change` round, a member's layer (`governance.ts`)     | `storeNetworkLayer` -> `updateSpace` | the network's   |
 *   | a layer arriving by sync (`space-meta-pull.ts`)                      | `storeNetworkLayer` -> `updateSpace` | the network's   |
 *   | a space leaving a network (`network-spaces.ts`)                      | `recomputeEffectiveMeta`           | the network's     |
 *
 *   The door kind stays refused with the act's own code; every row of the network's kind is applied while the import stands.
 * - A round that passes while the import stands is concluded once and applied, on a member (its layer) and on the proposer (its own edit).
 * - A round whose apply throws, for any reason, is not concluded, so the next settle applies it, and it is recorded as concluded once.
 *
 * Run: node --test testing/standalone/a-schema-the-network-decided-is-applied-while-an-import-stands.test.js (requires a prior server build)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tempInstanceDir, bootInstance, removeInstanceDir, settled } from './_vote-round-instance.mjs';
import { seedActEntry } from './_space-act-harness.mjs';
import { SELF, P1 } from './_vote-round-sites.mjs';

const dir = tempInstanceDir('ythril-schema-decided-');
const NET = '66666666-6666-4666-8666-666666666666';
const SPACE = 'notes';
const HELD = 'space_being_rdf_imported';

let loader, settle, effective, spaces, gate, pull, networkSpaces, governance, layerActs;

before(async () => {
  loader = await bootInstance(dir, { instanceId: SELF });
  settle = await import('../../server/dist/networks/round-conclusion.js');
  effective = await import('../../server/dist/spaces/effective-meta.js');
  spaces = await import('../../server/dist/spaces/spaces.js');
  gate = await import('../../server/dist/spaces/schema-write-gate.js');
  pull = await import('../../server/dist/sync/space-meta-pull.js');
  networkSpaces = await import('../../server/dist/networks/network-spaces.js');
  governance = await import('../../server/dist/sync/governance.js');
  layerActs = await import('../../server/dist/spaces/schema-layers-acts.js');
});
after(() => { governance.setMetaChangeApplyHookForTest?.(null); removeInstanceDir(dir); });

const member = (instanceId) => ({ instanceId, label: 'member', url: 'https://member.example', tokenHash: 'h', direction: 'both' });

/** A passed-on-the-first-yes `meta_change` round of the network (a club: the first yes decides), proposed here or by a member. */
function roundOf({ here }) {
  const now = Date.now();
  const who = here ? SELF : P1;
  return {
    roundId: `round-decided-${here ? 'own' : 'member'}`, type: 'meta_change', subjectInstanceId: who, subjectLabel: 'proposer', subjectUrl: '',
    openedAt: new Date(now - 3_600_000).toISOString(), deadline: new Date(now + 82_800_000).toISOString(),
    votes: [{ instanceId: who, vote: 'yes', castAt: new Date(now - 3_000_000).toISOString() }],
    spaceId: SPACE, networkSpaceId: SPACE, pendingMeta: { purpose: 'the purpose the network chose' }, metaChangedFields: ['purpose'], baseMetaVersion: 0,
    ...(here ? { proposedHere: true } : {}),
  };
}

/** Boot an instance holding the space and a club network carrying it, an RDF import standing on the space, and (optionally) a round. */
async function boot({ round, layer, imported = true } = {}) {
  await bootInstance(dir, {
    instanceId: SELF,
    spaces: [{ id: 'general', label: 'General', builtIn: true, folders: [] }, { id: SPACE, label: 'Notes', folders: [], meta: { purpose: 'the purpose before' } }],
    networks: [{
      id: NET, label: 'Net', type: 'club', origin: 'created', syncSchedule: '', spaces: [SPACE], votingDeadlineHours: 24,
      createdAt: '2026-01-01T00:00:00.000Z', members: [member(P1)], pendingRounds: round ? [round] : [], roundOutcomes: [],
      ...(layer ? { schemaLayers: { [SPACE]: layer } } : {}),
    }],
  });
  if (imported) await standImport();
}

/** An RDF import stands on the space: an owed act entry, which no runner is started to run. */
const standImport = () => seedActEntry(loader, { kind: 'rdf-import', localId: SPACE, state: 'owed', retryAt: '2999-01-01T00:00:00.000Z', spoolId: 'planted' });

const spaceNow = () => loader.getConfig().spaces.find(s => s.id === SPACE);
const netNow = () => loader.getConfig().networks.find(n => n.id === NET);
const settleNow = (round, via = 'gossip') => settle.settleRounds(netNow(), loader.getConfig(), [round], via, Date.now());
const roundNow = (id) => netNow().pendingRounds.find(r => r.roundId === id);

/** The refusal a write meets while the import stands: the space write gate's own error with the import's code. */
const refusedByImport = (err) => err?.name === 'SpaceNotWritableError' && err.code === HELD;

describe('a passed meta_change round is applied while an RDF import stands on its space', () => {
  it('on a member: the round is concluded once and its layer becomes the space\'s schema', async () => {
    const round = roundOf({ here: false });
    await boot({ round });
    const out = settleNow(netNow().pendingRounds[0]);
    assert.deepEqual(out.failed.map(f => String(f.cause)), [], 'the settle threw while applying the passed round');
    assert.equal(spaceNow().meta.purpose, 'the purpose the network chose', 'the member holds another schema than its network decided');
    assert.equal(netNow().schemaLayers?.[SPACE]?.purpose, 'the purpose the network chose');
    assert.equal(roundNow(round.roundId).concluded, true);
    assert.equal(netNow().roundOutcomes.filter(e => e.roundId === round.roundId).length, 1, 'the round is recorded once');
    // A later settle finds the round concluded and changes nothing.
    const again = settleNow(roundNow(round.roundId), 'peer vote');
    assert.deepEqual(again.concluded, []);
    assert.equal(netNow().roundOutcomes.filter(e => e.roundId === round.roundId).length, 1);
  });

  it('on the proposer: its own edit lands in its own definitions', async () => {
    const round = roundOf({ here: true });
    await boot({ round });
    const out = settleNow(netNow().pendingRounds[0], 'proposer');
    assert.deepEqual(out.failed.map(f => String(f.cause)), [], 'the settle threw while applying the passed round');
    assert.equal(spaceNow().meta.purpose, 'the purpose the network chose');
    assert.equal(spaceNow().ownMeta?.purpose ?? spaceNow().meta.purpose, 'the purpose the network chose');
    assert.equal(roundNow(round.roundId).concluded, true);
  });

  it('a round whose apply throws is not left concluded: the next settle applies it, and it is recorded once', async () => {
    assert.equal(typeof governance.setMetaChangeApplyHookForTest, 'function', 'governance exports the one hook that makes the apply throw once');
    const round = roundOf({ here: false });
    await boot({ round });
    let thrown = 0;
    governance.setMetaChangeApplyHookForTest(() => { if (thrown++ === 0) throw new Error('planted: the apply fails once'); });
    const first = settleNow(netNow().pendingRounds[0]);
    assert.equal(first.failed.length, 1, 'the planted failure reaches the settle as a failure');
    assert.equal(roundNow(round.roundId).concluded, false, 'a round whose apply threw stays concluded and unapplied: every later settle skips it');
    assert.equal(roundNow(round.roundId).passed, undefined);
    assert.equal(netNow().roundOutcomes.some(e => e.roundId === round.roundId), false, 'the log says how a round ended that has not ended');
    assert.equal(spaceNow().meta.purpose, 'the purpose before');
    const second = settleNow(roundNow(round.roundId));
    assert.deepEqual(second.failed.map(f => String(f.cause)), []);
    assert.equal(roundNow(round.roundId).concluded, true);
    assert.equal(roundNow(round.roundId).passed, true);
    assert.equal(spaceNow().meta.purpose, 'the purpose the network chose', 'the next settle did not apply the change');
    assert.equal(netNow().roundOutcomes.filter(e => e.roundId === round.roundId).length, 1);
    governance.setMetaChangeApplyHookForTest(null);
  });
});

describe('tail T6: a passed round whose apply keeps failing', () => {
  it('is retried at each settle, ends on this member as the round of a vote it already cast, and the change still arrives as a layer by sync', async () => {
    const round = roundOf({ here: false });
    await boot({ round });
    governance.setMetaChangeApplyHookForTest(() => { throw new Error('planted: the apply fails every time'); });
    try {
      for (let i = 0; i < 3; i += 1) {
        const out = settleNow(roundNow(round.roundId));
        assert.equal(out.failed.length, 1, `settle ${i}: the failure is told to the settle each time (retried, not given up)`);
        assert.equal(roundNow(round.roundId).concluded, false, `settle ${i}: the round stays open for the next settle`);
      }
      assert.equal(spaceNow().meta.purpose, 'the purpose before', 'nothing was applied');
      // Past the deadline the member ends it (nothing is retried for ever): what the round and its log then say of it.
      const late = settle.settleRounds(netNow(), loader.getConfig(), [roundNow(round.roundId)], 'tick', Date.parse(round.deadline) + 60_000);
      const ended = roundNow(round.roundId);
      assert.equal(ended.concluded, true, `the round ends at its deadline (${late.failed.length} failure(s) told)`);
      assert.equal(spaceNow().meta.purpose, 'the purpose before', 'still not applied by the round');
      assert.equal(netNow().roundOutcomes.filter(e => e.roundId === round.roundId).length, 1, 'the log records it once');
      // What the other members hold is their own state: a round the vote carried, applied by each of them. This member still gets the schema
      // the network decided as the layer the meta pull stores, which is a write the failing apply does not run.
      governance.setMetaChangeApplyHookForTest(null);
      assert.equal(pull.acceptNetworkLayer(NET, SPACE, { purpose: 'the purpose the network chose' }, P1), true, 'the layer is accepted');
      assert.equal(spaceNow().meta.purpose, 'the purpose the network chose', 'the member holds the network\'s schema through the layer');
    } finally { governance.setMetaChangeApplyHookForTest(null); }
  });
});

describe('the other things a network decides are applied while an RDF import stands', () => {
  it('a layer arriving by sync is stored and becomes the space\'s schema', async () => {
    await boot({});
    const changed = pull.acceptNetworkLayer(NET, SPACE, { purpose: 'the purpose that arrived' }, P1);
    assert.equal(changed, true, 'the arriving layer was refused');
    assert.equal(spaceNow().meta.purpose, 'the purpose that arrived');
    // Not stored without being applied: the same layer again is nothing to do, so a layer stored and never recomputed would stay unapplied.
    assert.equal(pull.acceptNetworkLayer(NET, SPACE, { purpose: 'the purpose that arrived' }, P1), false);
    assert.equal(spaceNow().meta.purpose, 'the purpose that arrived');
  });

  it('a space leaving its network sheds that network\'s layer from its schema', async () => {
    // The layer is in force before the import stands, so the leave has something to shed.
    await boot({ layer: { purpose: 'the purpose of the network' }, imported: false });
    effective.recomputeEffectiveMeta(SPACE, true);
    await standImport();
    assert.equal(spaceNow().meta.purpose, 'the purpose of the network');
    assert.equal(networkSpaces.removeSpaceFromNetwork(NET, SPACE, 'a test'), true);
    const meta = await settled(() => spaceNow().meta.purpose);
    assert.equal(meta, 'the purpose before', 'the schema still holds the layer of a network the space left');
  });
});

describe('what an operator starts at a door stays refused while an RDF import stands', () => {
  it('the own-definitions edit, the meta write and the reorder answer the import\'s code, and write nothing', async () => {
    await boot({ layer: { purpose: 'the purpose of the network' }, imported: false });
    effective.recomputeEffectiveMeta(SPACE, true);
    await standImport();
    const before = JSON.stringify(spaceNow().meta);
    assert.throws(() => effective.commitOwnMetaEdit(SPACE, base => ({ ...base, purpose: 'an operator\'s edit' })), refusedByImport, 'commitOwnMetaEdit (the per-type routes, the library)');
    assert.throws(() => spaces.updateSpace(SPACE, { meta: { purpose: 'an operator\'s edit' } }), refusedByImport, 'updateSpace with a meta (the space PATCH)');
    assert.throws(() => gate.assertSchemaWritable(SPACE), refusedByImport, 'the gate itself');
    assert.equal(JSON.stringify(spaceNow().meta), before, 'a refused door write changed the schema');
  });

  it('tail T1: setting the network precedence is refused before it writes: the stored order and the config stay as they were', async () => {
    // The act wrote `networkPrecedence` and saved the config, and only its recompute met the gate: with the import standing it saved the new
    // order and then threw. A reorder that moves no schema never met the gate at all.
    await boot({ layer: { purpose: 'the purpose of the network' }, imported: false });
    effective.recomputeEffectiveMeta(SPACE, true);
    await standImport();
    const before = JSON.stringify(loader.getConfig());
    assert.equal(spaceNow().networkPrecedence, undefined, 'the order starts unset');
    assert.throws(() => layerActs.setNetworkPrecedenceAct(SPACE, { networks: [NET] }), refusedByImport, 'the reorder answers the import\'s code');
    assert.equal(spaceNow().networkPrecedence, undefined, 'the refused reorder stored its order');
    assert.equal(JSON.stringify(loader.getConfig()), before, 'the refused reorder changed the config');
  });

  it('a round\'s apply does not leave the gate open for a door call that follows it', async () => {
    await boot({ round: roundOf({ here: false }) });
    settleNow(netNow().pendingRounds[0]);
    assert.throws(() => gate.assertSchemaWritable(SPACE), refusedByImport, 'the exemption outlived the network\'s own write');
    assert.throws(() => effective.commitOwnMetaEdit(SPACE, base => ({ ...base, purpose: 'late' })), refusedByImport);
  });
});
