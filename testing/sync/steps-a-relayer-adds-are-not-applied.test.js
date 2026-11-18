/**
 * Conversion steps that were added to a round, or changed in it, after its proposer cast are not applied by any member (Q-745; bundle-284 design r5
 * section 2.4, finding S1: steps on a round can make every member rewrite its records, and the round came through whoever served it).
 *
 * ## The rule
 *
 * The proposer's own cast of a round that carries `convertRecords` carries a third signature, `csig`, over the steps as the round holds them. A member
 * applies the steps only when that signature verifies against the proposer's pinned key over the steps it now holds. A round whose steps were added
 * where the proposer chose none, or changed where it chose some, fails that check: the member applies the schema as voted, its run holds no step and
 * names why (`stepsRefused`: `steps_not_signed`), and it rewrites nothing. The check is the only thing that refuses these steps here: each step added
 * below is one the schema HONOURS, so the member's checks against the round's own change would pass them.
 *
 * ## The setup, and how the round is tampered with
 *
 * A closed network of A and B over two spaces; in each, A's own definitions declare `person` with `fullName` and a `status`, and A writes one entity
 * that B receives. A saves a new definition of `person` to each space, and the closed network opens a round in each and waits for B's yes:
 *
 * - space one: `name` replaces `fullName`, saved with NO `convertRecords`. Then a `renameProperty` is ADDED to the round A holds;
 * - space two: the same definition saved with a `renameProperty`, signed. Then a `mapEnum` from `a` to `x` is ADDED to its steps (the new `status` values
 *   include `x`, so the step is as valid as the first).
 *
 * The tampering is what `vote-forgery` does to a round a peer serves: A's `config.json` is edited in its container and reloaded, so A serves, and
 * itself decides, the altered round while its proposer's cast is the one made over the original. B reads the altered steps on its vote row, votes yes,
 * and both members conclude the rounds.
 *
 * ## What is asserted, on BOTH members, and what each defect would turn red
 *
 * 1. **The tampering reached B**: the vote rows on B carry the added and the changed steps. A test whose tampering did not take would pass for nothing.
 * 2. **Both runs refuse the steps**: each is `complete`, holds no step, names `steps_not_signed`, and `rewritten` is 0. Red when a member applies steps
 *    on a relayer's word, or when its refusal is named by another reason.
 * 3. **The schema landed**: each member's effective schema declares `name`. Red when refusing the steps also refuses the schema.
 * 4. **The records are as they were**: each member holds each entity with the properties, the version and the change date it had before, and lists it
 *    as an open item (it no longer conforms and nothing converted it). Red when a member rewrote a record by steps nobody signed.
 *
 * Run: node --test testing/sync/steps-a-relayer-adds-are-not-applied.test.js
 * (needs the test stack: `npm run test:up`; the stack is built from the tree under test)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { INSTANCES, post, patch, get, createTestSpace, mirroredNetwork, syncUntil, patchContainerNetwork, reloadConfig } from './helpers.js';
import {
  tokenOf, entityType, text, oneOf, setOwnSchema, writeEntities, recordOn, holdsAll, metaOn, runEnds, runEndsHere, itemsOf,
} from './_schema-convert-pair.mjs';

const RUN = Date.now();
const A = INSTANCES.a;
const B = INSTANCES.b;

const BEFORE = entityType('person', { fullName: text(), status: oneOf('a', 'b') });
const AFTER_ONE = entityType('person', { name: text(), status: oneOf('a', 'b') });
const AFTER_TWO = entityType('person', { name: text(), status: oneOf('a', 'b', 'x') });
const RENAME = { op: 'renameProperty', kind: 'entity', type: 'person', from: 'fullName', to: 'name' };
const MAP = { op: 'mapEnum', kind: 'entity', type: 'person', property: 'status', values: { a: 'x' } };
const RECORD = { type: 'person', properties: { fullName: 'Ada', status: 'a' } };

let tA, tB, one, two, net;
/** What each space holds: its id, the record's id and the round A opened in it. */
const held = { one: {}, two: {} };

before(async () => {
  tA = tokenOf('a');
  tB = tokenOf('b');
  one = await createTestSpace('cvrelay1', [[A, tA], [B, tB]]);
  two = await createTestSpace('cvrelay2', [[A, tA], [B, tB]]);
  held.one.space = one.id;
  held.two.space = two.id;
  for (const space of [one.id, two.id]) await setOwnSchema(A, tA, space, BEFORE);
  net = await mirroredNetwork({ label: `cvrelay-${RUN}`, spaces: [one.id, two.id], a: [A, tA], b: [B, tB] });
  for (const slot of [held.one, held.two]) {
    [slot.id] = await writeEntities(A, tA, slot.space, [{ name: `Ada ${slot.space}`, ...RECORD }]);
  }
  await syncUntil(B, tB, net.networkId, async () => (await holdsAll(B, tB, one.id, [held.one.id])) && (await holdsAll(B, tB, two.id, [held.two.id])),
    'B to hold the record A wrote in each space', { timeoutMs: 90_000 });
  for (const slot of [held.one, held.two]) {
    slot.before = { a: await recordOn(A, tA, slot.space, slot.id), b: await recordOn(B, tB, slot.space, slot.id) };
  }
});

after(async () => {
  await net?.remove();
  await one?.remove();
  await two?.remove();
});

/** The rounds B lists on the network, by id. */
const roundsOnB = async () => (await get(B, tB, `/api/networks/${net.networkId}/votes`)).body?.rounds ?? [];

describe('steps a relayer adds are not applied', () => {
  it('A opens a round in each space; the first carries no steps and the second carries a signed rename', async () => {
    const r1 = await patch(A, tA, `/api/spaces/${held.one.space}`, { meta: AFTER_ONE });
    assert.equal(r1.status, 202, `${r1.status} ${JSON.stringify(r1.body)}`);
    assert.equal('convert' in r1.body, false, 'a save with no convertRecords answered a convert');
    held.one.round = r1.body.rounds[0].roundId;
    const r2 = await patch(A, tA, `/api/spaces/${held.two.space}`, { meta: AFTER_TWO, convertRecords: { steps: [RENAME] } });
    assert.equal(r2.status, 202, `${r2.status} ${JSON.stringify(r2.body)}`);
    assert.equal(r2.body.convert?.state, 'after_vote');
    held.two.round = r2.body.rounds[0].roundId;
  });

  it('the rounds A holds are altered after A cast on them: steps added to the first, a step added to the second\'s', async () => {
    assert.ok(held.one.round && held.two.round, 'the rounds were opened by the previous case');
    patchContainerNetwork('ythril-a', net.networkId, `
      const alter = (roundId, change) => {
        const round = n.pendingRounds.find(x => x.roundId === roundId);
        if (!round) throw new Error('round ' + roundId + ' is not held by this instance');
        change(round);
      };
      alter(${JSON.stringify(held.one.round)}, round => { round.convertRecords = ${JSON.stringify({ steps: [RENAME] })}; });
      alter(${JSON.stringify(held.two.round)}, round => { round.convertRecords.steps.push(${JSON.stringify(MAP)}); });
    `);
    await reloadConfig(A, tA);
  });

  it('B reads the altered steps on its vote rows and votes yes on both rounds', async () => {
    let rows;
    await syncUntil(B, tB, net.networkId, async () => {
      rows = await roundsOnB();
      return [held.one.round, held.two.round].every(id => rows.some(x => x.roundId === id));
    }, 'B to list both rounds');
    const row = (id) => rows.find(x => x.roundId === id);
    assert.deepEqual(row(held.one.round).convertRecords, { steps: [RENAME] }, `the steps added to the first round did not reach B's vote row: ${JSON.stringify(row(held.one.round))}`);
    assert.deepEqual(row(held.two.round).convertRecords, { steps: [RENAME, MAP] }, `the step added to the second round did not reach B's vote row: ${JSON.stringify(row(held.two.round))}`);
    for (const id of [held.one.round, held.two.round]) {
      const v = await post(B, tB, `/api/networks/${net.networkId}/votes/${id}`, { vote: 'yes' });
      assert.ok(v.status < 300, `B's yes on ${id}: ${v.status} ${JSON.stringify(v.body)}`);
    }
  });

  for (const [which, label] of [['one', 'steps added to a round whose proposer chose none'], ['two', 'a step added to the steps its proposer signed']]) {
    describe(label, () => {
      const slot = held[which];

      it('B takes the schema and its run applies no step, naming the unsigned steps', async () => {
        const run = await runEndsHere({ base: B, token: tB, space: slot.space, who: 'B' });
        assert.deepEqual(run.steps, [], `B holds steps nobody signed: ${JSON.stringify(run.steps)}`);
        assert.deepEqual(run.stepsRefused, [{ step: null, reason: 'steps_not_signed' }], `B names another reason: ${JSON.stringify(run.stepsRefused)}`);
        assert.equal(run.counts.rewritten, 0, `B rewrote records by steps nobody signed: ${JSON.stringify(run.counts)}`);
        assert.ok((await metaOn(B, tB, slot.space)).typeSchemas?.entity?.person?.propertySchemas?.name, 'refusing the steps also refused the schema');
      });

      it('A, which decides the altered round it holds as any member does, refuses the steps too', async () => {
        const run = await runEnds({ base: A, token: tA, networkId: net.networkId, space: slot.space, who: 'A' });
        assert.deepEqual(run.steps, [], `A holds steps nobody signed: ${JSON.stringify(run.steps)}`);
        assert.deepEqual(run.stepsRefused, [{ step: null, reason: 'steps_not_signed' }], `A names another reason: ${JSON.stringify(run.stepsRefused)}`);
        assert.equal(run.counts.rewritten, 0, `A rewrote records by steps nobody signed: ${JSON.stringify(run.counts)}`);
        assert.ok((await metaOn(A, tA, slot.space)).typeSchemas?.entity?.person?.propertySchemas?.name);
      });

      it('both members still hold the record as it was, and list it', async () => {
        for (const [who, base, token, was] of [['A', A, tA, slot.before.a], ['B', B, tB, slot.before.b]]) {
          const now = await recordOn(base, token, slot.space, slot.id);
          assert.deepEqual(now.properties, RECORD.properties, `${who} holds the record as ${JSON.stringify(now.properties)}: steps nobody signed were applied`);
          assert.equal(now.seq, was.seq, `${who} wrote the record again`);
          assert.equal(now.updatedAt, was.updatedAt);
          const item = (await itemsOf(base, token, slot.space)).find(i => i.recordId === slot.id);
          assert.ok(item, `${who} lists nothing for a record that no longer conforms and was not converted`);
          assert.equal(item.reason, 'not_conforming', JSON.stringify(item));
        }
      });
    });
  }
});
