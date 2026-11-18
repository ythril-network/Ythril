/**
 * A member that cannot apply a vote's conversion steps still takes the schema, stamps what conforms, lists what does not, and rewrites nothing
 * (Q-745, Q-746; bundle-284 design r5 section 3, owner's answer O3, "Schema yes, steps no"; amendment A2).
 *
 * ## The rule
 *
 * A member applies the steps of a passed `meta_change` round only when, among other checks, its OWN effective schema once the round has landed no
 * longer declares a renamed property's old name: own and layer definitions union their properties, so a name this member still declares is a name its
 * records may still hold under. When it does, the member applies the schema as the network voted it and starts its run with NO step, naming why
 * (`stepsRefused`): the copies that conform are stamped in place, the ones that do not become unconverted items on this member, and it rewrites
 * nothing, so it cannot undo another member's conversion. The member that did apply the steps converts as usual, and the other receives the result
 * by the ordinary sync like any edit.
 *
 * ## The setup
 *
 * A closed network of A and B over one space. A's own definitions declare `person` with `fullName`, `name` and `status` (`a` or `b`); B's own definitions
 * declare `person` with `fullName` alone, which is what makes B's schema keep the old name after the round. A writes three entities and B receives
 * them: one the steps convert (`fullName` and `status: a`), one that holds both `fullName` and `name` (a rename onto a set name: not convertible on any
 * member) and one with no properties (fits any version). A saves the new definition (`name`, `status` of `x` or `y`) with a `renameProperty` and a
 * `mapEnum`; the closed network opens a round, B reads the steps on its vote row and votes yes (its yes depends on the schema alone), and both
 * members conclude it. The two runs start at about the same moment and the assertions are the ones no order changes.
 *
 * ## What is asserted, and what each defect would turn red
 *
 * 1. **B read the steps before it voted**: the vote row on B carries `convertRecords` as saved. Red when the row drops the steps.
 * 2. **B took the schema**: its effective schema declares `name` and the new `status`, while its own definitions still declare `fullName` (the
 *    schema-layers door says so). Red when a member that refuses the steps also refuses, or half-applies, the schema.
 * 3. **B's run**: `complete`, holding no step, with `stepsRefused` of `[{ step: null, reason: 'property_still_declared_here' }]`, `rewritten` 0.
 *    Red when B applies steps its own schema contradicts, applies them only in part, or names no reason.
 * 4. **B's conforming copy** (no properties) keeps its version and change date and carries B's own fingerprint; **B's copy that holds both names**
 *    is untouched, and B lists it as an open item (`not_conforming`). Red when B rewrites it, stamps a record that does not conform, or lists nothing.
 * 5. **A's run**: `complete`, holding the steps, none refused, `rewritten` 1 and `unconverted` 1; A lists the both-names record as `both_set` and leaves
 *    it as it is. Red when the refusal of one member changes what another does.
 * 6. **B ends with A's conversion**: its copy of the convertible record becomes `name` and the mapped `status`, though B rewrote nothing.
 *    Red when a converted copy does not replicate, or B's refused run overwrites it.
 * 7. **No fork** on either instance.
 *
 * Run: node --test testing/sync/a-member-that-refuses-the-steps-takes-the-schema-and-reviews-its-records.test.js
 * (needs the test stack: `npm run test:up`; the stack is built from the tree under test)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { INSTANCES, post, patch, get, createTestSpace, syncUntil } from './helpers.js';
import {
  mirroredPair, tokenOf, entityType, text, oneOf, setOwnSchema, writeEntities, recordOn, holdsAll, fingerprintOn, metaOn, runEnds, runEndsHere, forksIn, itemsOf,
} from './_schema-convert-pair.mjs';

const RUN = Date.now();
const A = INSTANCES.a;
const B = INSTANCES.b;

const OWN_A = entityType('person', { fullName: text(), name: text(), status: oneOf('a', 'b') });
const OWN_B = entityType('person', { fullName: text() });
const AFTER = entityType('person', { name: text(), status: oneOf('x', 'y') });
const STEPS = [
  { op: 'renameProperty', kind: 'entity', type: 'person', from: 'fullName', to: 'name' },
  { op: 'mapEnum', kind: 'entity', type: 'person', property: 'status', values: { a: 'x', b: 'y' } },
];
const ROWS = {
  convertible: { name: `Ada ${RUN}`, type: 'person', properties: { fullName: 'Ada', status: 'a' } },
  both: { name: `Bo ${RUN}`, type: 'person', properties: { fullName: 'Bo', name: 'Bo L', status: 'a' } },
  plain: { name: `Plain ${RUN}`, type: 'person', properties: {} },
};

let tA, tB, space, net, SPACE;
const ids = {};
/** name -> `{ a, b }`: what each instance held after B received the records and before the vote. */
const before_ = {};
let roundId, aRun, bRun;

before(async () => {
  tA = tokenOf('a');
  tB = tokenOf('b');
  space = await createTestSpace('cvrefuse', [[A, tA], [B, tB]]);
  SPACE = space.id;
  // The own definitions are set BEFORE the network exists, so each space is a plain one and no round carries a layer.
  await setOwnSchema(A, tA, SPACE, OWN_A);
  await setOwnSchema(B, tB, SPACE, OWN_B);
  // Built by the instances' own doors: the runner the sync tests run in has no `docker` command, which `mirroredNetwork` needs.
  net = await mirroredPair({ label: `cvrefuse-${RUN}`, spaces: [SPACE] });
  const written = await writeEntities(A, tA, SPACE, Object.values(ROWS));
  Object.keys(ROWS).forEach((name, i) => { ids[name] = written[i]; });
  await syncUntil(B, tB, net.networkId, () => holdsAll(B, tB, SPACE, Object.values(ids)), 'B to hold the three records A wrote', { timeoutMs: 90_000 });
  for (const name of Object.keys(ROWS)) {
    before_[name] = { a: await recordOn(A, tA, SPACE, ids[name]), b: await recordOn(B, tB, SPACE, ids[name]) };
  }
});

after(async () => {
  await net?.remove();
  await space?.remove();
});

describe('a member that refuses the steps takes the schema and reviews its records', () => {
  it('A saves the change with the steps; the closed network opens a round and B reads the steps on its vote row', async () => {
    const r = await patch(A, tA, `/api/spaces/${SPACE}`, { meta: AFTER, convertRecords: { steps: STEPS } });
    assert.equal(r.status, 202, `the save on a two-member closed network opens a round: ${r.status} ${JSON.stringify(r.body)}`);
    assert.equal(r.body.status, 'vote_pending', JSON.stringify(r.body));
    assert.equal(r.body.convert?.state, 'after_vote', `the answer does not say the run waits for the vote: ${JSON.stringify(r.body.convert)}`);
    roundId = r.body.rounds[0].roundId;
    let row;
    await syncUntil(B, tB, net.networkId, async () => {
      row = ((await get(B, tB, `/api/networks/${net.networkId}/votes`)).body?.rounds ?? []).find(x => x.roundId === roundId);
      return row !== undefined;
    }, `B to list the round ${roundId} it is to vote on`);
    assert.deepEqual(row.convertRecords, { steps: STEPS }, `B's vote row does not show the steps a yes would make it apply: ${JSON.stringify(row)}`);
  });

  it('B votes yes, and takes the schema although its own definitions still declare the old name', async () => {
    assert.ok(roundId, 'the round was opened by the previous case');
    const v = await post(B, tB, `/api/networks/${net.networkId}/votes/${roundId}`, { vote: 'yes' });
    assert.ok(v.status < 300, `B's yes: ${v.status} ${JSON.stringify(v.body)}`);
    bRun = await runEndsHere({ base: B, token: tB, space: SPACE, who: 'B' });
    const person = (await metaOn(B, tB, SPACE)).typeSchemas?.entity?.person?.propertySchemas ?? {};
    assert.ok(person.name, `the round did not reach B's schema: ${JSON.stringify(person)}`);
    assert.deepEqual(person.status?.enum, ['x', 'y'], 'B did not take the new values of status');
    const layers = (await get(B, tB, `/api/spaces/${SPACE}/schema-layers`)).body;
    assert.ok(layers.own?.typeSchemas?.entity?.person?.propertySchemas?.fullName, `B's own definitions no longer declare fullName: ${JSON.stringify(layers.own)}`);
  });

  it('B\'s run applies no step, says why, and rewrites nothing', () => {
    assert.deepEqual(bRun.steps, [], 'B holds steps its own schema contradicts');
    assert.deepEqual(bRun.stepsRefused, [{ step: null, reason: 'property_still_declared_here' }], `B names another reason: ${JSON.stringify(bRun.stepsRefused)}`);
    assert.equal(bRun.counts.rewritten, 0, `B rewrote records without the steps: ${JSON.stringify(bRun.counts)}`);
    assert.ok(bRun.counts.stamped >= 1, `B did not stamp the copy that conforms: ${JSON.stringify(bRun.counts)}`);
    assert.ok(bRun.sources.some(s => s.kind === 'round' && s.roundId === roundId), `B's run is not the round's: ${JSON.stringify(bRun.sources)}`);
  });

  it('B stamps the copy that conforms in place, and lists the copy that holds both names without touching it', async () => {
    const fpB = await fingerprintOn(B, tB, SPACE);
    const plain = await recordOn(B, tB, SPACE, ids.plain);
    assert.equal(plain.seq, before_.plain.b.seq, 'B moved the version of a record it only stamps');
    assert.equal(plain.updatedAt, before_.plain.b.updatedAt, 'B moved the change date of a record it only stamps');
    assert.equal(plain.stamp, fpB, 'B did not stamp the copy that conforms with the fingerprint it runs on');
    const both = await recordOn(B, tB, SPACE, ids.both);
    assert.deepEqual(both.properties, ROWS.both.properties, 'B changed the record that holds both names');
    assert.equal(both.seq, before_.both.b.seq);
    const item = (await itemsOf(B, tB, SPACE)).find(i => i.recordId === ids.both);
    assert.ok(item, 'B lists nothing for the record it could not make conform');
    assert.equal(item.reason, 'not_conforming', JSON.stringify(item));
    assert.equal(item.kind, 'entity');
    assert.equal(item.status, 'open');
  });

  it('A concludes the round from B\'s yes and its run converts with the steps', async () => {
    aRun = await runEnds({ base: A, token: tA, networkId: net.networkId, space: SPACE, who: 'A' });
    assert.deepEqual(aRun.steps, STEPS, 'A holds the steps it proposed');
    assert.deepEqual(aRun.stepsRefused, [], `A refused its own steps: ${JSON.stringify(aRun.stepsRefused)}`);
    assert.equal(aRun.counts.rewritten, 1, `A rewrote the convertible record only: ${JSON.stringify(aRun.counts)}`);
    assert.equal(aRun.counts.unconverted, 1, `A could not convert the record that holds both names: ${JSON.stringify(aRun.counts)}`);
    const item = (await itemsOf(A, tA, SPACE)).find(i => i.recordId === ids.both);
    assert.ok(item, 'A lists nothing for the record that holds both names');
    assert.equal(item.reason, 'both_set', JSON.stringify(item));
    const both = await recordOn(A, tA, SPACE, ids.both);
    assert.deepEqual(both.properties, ROWS.both.properties, 'A changed the record it listed');
    assert.equal(both.seq, before_.both.a.seq);
  });

  it('B ends with A\'s conversion although it rewrote nothing', async () => {
    let held;
    await syncUntil(B, tB, net.networkId, async () => {
      held = await recordOn(B, tB, SPACE, ids.convertible);
      return held.properties.name === 'Ada';
    }, 'B to receive A\'s converted copy of the convertible record', { timeoutMs: 90_000, onTimeout: () => `B holds ${JSON.stringify(held)}` });
    assert.deepEqual(held.properties, { name: 'Ada', status: 'x' });
    const onA = await recordOn(A, tA, SPACE, ids.convertible);
    assert.deepEqual(onA.properties, { name: 'Ada', status: 'x' });
    assert.equal(held.seq, onA.seq, 'the two instances hold two versions of the converted record');
    assert.ok(onA.seq > before_.convertible.a.seq, 'A\'s conversion took no newer version');
  });

  it('no fork on either instance', async () => {
    for (const [who, base, token] of [['A', A, tA], ['B', B, tB]]) {
      assert.equal(await forksIn(base, token, SPACE), 0, `${who} holds a fork`);
    }
  });
});
